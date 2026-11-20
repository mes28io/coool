//! Audio plumbing between a microphone (any rate, any channel count, any sample format) and whisper (16 kHz mono f32):
//! the per-callback [`Converter`] (format, downmix, resampling, the level meter), finding the speech in a recording
//! (an adaptive noise floor, so steady noise is never taken for speech), bringing quiet speech up to level, and
//! reading/writing WAV files (fixtures, the self-test, the optional "keep the last recording").
//! Pure functions over buffers, so all of it is unit-tested with synthetic signals.

use crate::SAMPLE_RATE;
use std::path::Path;

/// Averages interleaved frames of `channels` samples into one channel.
pub fn downmix(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved.chunks_exact(channels).map(|f| f.iter().sum::<f32>() / channels as f32).collect()
}

/// A streaming resampler to 16 kHz: a windowed-sinc (Blackman) interpolator with its cut-off just under the lower of
/// the two Nyquist rates, so a 44.1 or 48 kHz microphone doesn't fold its 8–24 kHz content back into the speech band.
/// Any input rate works (44.1 kHz is not an integer ratio). Keeps its history between calls, so chunks of any size join
/// exactly; [`Resampler::flush`] gives the last few samples the filter was still waiting on at the end of a recording.
pub struct Resampler {
    from: u32,
    step: f64,
    /// Half the kernel's width, in input samples.
    half: usize,
    /// The kernel sampled at `PHASES` points per input sample, over [-half, half].
    table: Vec<f32>,
    /// Input not yet fully used; `buf[0]` is input sample number `base`.
    buf: Vec<f32>,
    base: usize,
    /// Input samples seen so far.
    seen: usize,
    /// Position of the next output sample, in input samples.
    t: f64,
}

const PHASES: usize = 64;

impl Resampler {
    pub fn new(from: u32) -> Resampler {
        let from = from.max(1);
        let step = from as f64 / SAMPLE_RATE as f64;
        // Cut-off as a fraction of the input rate: 0.45 of the lower rate (7.2 kHz going to 16 kHz).
        let fc = 0.45 * from.min(SAMPLE_RATE) as f64 / from as f64;
        // Twelve zero crossings each side.
        let half = (12.0 / (2.0 * fc)).ceil() as usize;
        let n = 2 * half * PHASES + 1;
        let pi = std::f64::consts::PI;
        let table = (0..n)
            .map(|i| {
                let x = i as f64 / PHASES as f64 - half as f64;
                let a = pi * 2.0 * fc * x;
                let sinc = if x == 0.0 { 1.0 } else { a.sin() / a };
                let w = i as f64 / (n - 1) as f64;
                let blackman = 0.42 - 0.5 * (2.0 * pi * w).cos() + 0.08 * (4.0 * pi * w).cos();
                (2.0 * fc * sinc * blackman) as f32
            })
            .collect();
        Resampler { from, step, half, table, buf: Vec::new(), base: 0, seen: 0, t: 0.0 }
    }

    fn kernel(&self, x: f64) -> f32 {
        let p = (x + self.half as f64) * PHASES as f64;
        if p < 0.0 || p >= (self.table.len() - 1) as f64 {
            return 0.0;
        }
        let i = p.floor() as usize;
        let f = (p - i as f64) as f32;
        self.table[i] + (self.table[i + 1] - self.table[i]) * f
    }

    /// Emits the output samples whose kernel window ends before input sample `limit` (and lie before `stop`).
    fn drain(&mut self, limit: usize, stop: f64, out: &mut Vec<f32>) {
        let h = self.half as f64;
        while self.t < stop && self.t + h < limit as f64 {
            let lo = (self.t - h).ceil().max(0.0) as usize;
            let hi = ((self.t + h).floor() as usize).min(limit.saturating_sub(1));
            let (mut acc, mut wsum) = (0f32, 0f32);
            for i in lo..=hi {
                let w = self.kernel(i as f64 - self.t);
                let x = if i >= self.base && i - self.base < self.buf.len() { self.buf[i - self.base] } else { 0.0 };
                acc += x * w;
                wsum += w;
            }
            out.push(if wsum.abs() > 1e-6 { acc / wsum } else { 0.0 });
            self.t += self.step;
        }
        // Keep only what the next output can still need.
        let keep_from = ((self.t - h).floor().max(0.0) as usize).min(self.base + self.buf.len());
        if keep_from > self.base {
            self.buf.drain(..keep_from - self.base);
            self.base = keep_from;
        }
    }

    /// Feeds mono samples at the input rate; returns the 16 kHz samples they complete.
    pub fn push(&mut self, input: &[f32]) -> Vec<f32> {
        if self.from == SAMPLE_RATE {
            return input.to_vec();
        }
        self.buf.extend_from_slice(input);
        self.seen += input.len();
        let mut out = Vec::with_capacity((input.len() as f64 / self.step) as usize + 2);
        self.drain(self.seen, f64::INFINITY, &mut out);
        out
    }

    /// The end of the input: the samples that were still waiting for input past the end (taken as silence).
    pub fn flush(&mut self) -> Vec<f32> {
        if self.from == SAMPLE_RATE {
            return vec![];
        }
        let mut out = Vec::new();
        let end = self.seen;
        self.drain(end + self.half + 1, end as f64, &mut out);
        out
    }
}

/// One-shot resample of a whole buffer.
pub fn resample(input: &[f32], from: u32) -> Vec<f32> {
    let mut r = Resampler::new(from);
    let mut out = r.push(input);
    out.extend(r.flush());
    out
}

/// Everything between a microphone callback and whisper: interleaved frames of any channel count, rate and sample
/// format in, 16 kHz mono f32 out, plus the level of the latest callback for the meter. One per recording.
pub struct Converter {
    channels: usize,
    rs: Resampler,
    /// The meter value (0..1) of the last chunk pushed.
    pub level: f32,
    /// The loudest sample seen so far (absolute).
    pub peak: f32,
}

impl Converter {
    pub fn new(rate: u32, channels: usize) -> Converter {
        Converter { channels: channels.max(1), rs: Resampler::new(rate), level: 0.0, peak: 0.0 }
    }

    pub fn push_f32(&mut self, interleaved: &[f32]) -> Vec<f32> {
        let mono = downmix(interleaved, self.channels);
        self.level = level(&mono);
        self.peak = mono.iter().fold(self.peak, |m, v| m.max(v.abs()));
        self.rs.push(&mono)
    }
    pub fn push_i16(&mut self, d: &[i16]) -> Vec<f32> {
        self.push_f32(&d.iter().map(|&s| s as f32 / 32768.0).collect::<Vec<_>>())
    }
    pub fn push_i32(&mut self, d: &[i32]) -> Vec<f32> {
        self.push_f32(&d.iter().map(|&s| s as f32 / 2_147_483_648.0).collect::<Vec<_>>())
    }
    pub fn push_u16(&mut self, d: &[u16]) -> Vec<f32> {
        self.push_f32(&d.iter().map(|&s| (s as f32 - 32768.0) / 32768.0).collect::<Vec<_>>())
    }
    pub fn push_f64(&mut self, d: &[f64]) -> Vec<f32> {
        self.push_f32(&d.iter().map(|&s| s as f32).collect::<Vec<_>>())
    }
    /// The end of the recording: what the resampler still held.
    pub fn finish(&mut self) -> Vec<f32> {
        self.rs.flush()
    }
}

/// Root mean square of a buffer.
pub fn rms(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
}

/// A 0..1 meter value for a buffer: -60 dBFS (and below) is 0, -10 dBFS (and above) is 1, linear in dB between.
pub fn level(x: &[f32]) -> f32 {
    let r = rms(x);
    if r <= 1e-6 {
        return 0.0;
    }
    let db = 20.0 * r.log10();
    ((db + 60.0) / 50.0).clamp(0.0, 1.0)
}

/// Below this RMS (about -52 dBFS) a 30 ms frame is silence, whatever else is going on.
pub const SILENCE_RMS: f32 = 0.0025;
/// A frame counts as speech only this far (about 10 dB) above the recording's own noise floor, so steady noise (a fan,
/// hum, hiss) is never taken for speech however loud it is.
pub const OVER_FLOOR: f32 = 3.2;
/// At least this much speech (in 30 ms frames: 300 ms) before whisper is run at all.
pub const MIN_SPEECH_FRAMES: usize = 10;

const FRAME: usize = (SAMPLE_RATE as usize * 30) / 1000;

/// The noise floor of a recording: the 10th percentile of its 30 ms frame levels.
pub fn noise_floor(samples: &[f32]) -> f32 {
    let mut r: Vec<f32> = samples.chunks(FRAME).map(rms).collect();
    if r.is_empty() {
        return 0.0;
    }
    r.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    r[r.len() / 10]
}

/// Which 30 ms frames hold speech energy (see `SILENCE_RMS`, `OVER_FLOOR`).
pub fn speech_frames(samples: &[f32]) -> Vec<bool> {
    let thr = SILENCE_RMS.max(noise_floor(samples) * OVER_FLOOR);
    samples.chunks(FRAME).map(|f| rms(f) > thr).collect()
}

/// The range of `samples` (16 kHz) between the first and last frame with speech energy, padded by `pad_ms` on each
/// side; `None` when there isn't `MIN_SPEECH_FRAMES` of it (then whisper is not run at all: given silence or steady
/// noise it invents text, often the words it was primed with).
pub fn speech_bounds(samples: &[f32], pad_ms: usize) -> Option<(usize, usize)> {
    let loud = speech_frames(samples);
    let first = loud.iter().position(|&l| l)?;
    let last = loud.iter().rposition(|&l| l)?;
    if loud.iter().filter(|&&l| l).count() < MIN_SPEECH_FRAMES {
        return None;
    }
    let pad = SAMPLE_RATE as usize * pad_ms / 1000;
    let start = (first * FRAME).saturating_sub(pad);
    let end = ((last + 1) * FRAME + pad).min(samples.len());
    Some((start, end))
}

/// Seconds of speech energy in a recording.
pub fn speech_secs(samples: &[f32]) -> f32 {
    speech_frames(samples).iter().filter(|&&l| l).count() as f32 * 0.03
}

/// Trims leading and trailing silence (keeping 200 ms around the speech); `None` for a silent clip.
pub fn trim_silence(samples: &[f32]) -> Option<&[f32]> {
    speech_bounds(samples, 200).map(|(a, b)| &samples[a..b])
}

/// The speech level whisper is given: about -20 dBFS RMS over the speech frames.
pub const TARGET_RMS: f32 = 0.1;
/// The most a quiet microphone is boosted: +26 dB.
pub const MAX_GAIN: f32 = 20.0;

/// Brings quiet speech up to `TARGET_RMS` (never turns speech down, never clips: peaks stay under 0.97). Whisper's
/// log-mel input depends on the absolute level, so a laptop microphone at arm's length reads as far less certain speech
/// than the same words at a normal level. Returns the gain applied, in dB.
pub fn normalize(samples: &mut [f32]) -> f32 {
    let loud = speech_frames(samples);
    let (mut sum, mut n) = (0f64, 0usize);
    for (f, &l) in samples.chunks(FRAME).zip(&loud) {
        if l {
            sum += f.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>();
            n += f.len();
        }
    }
    if n == 0 {
        return 0.0;
    }
    let speech_rms = (sum / n as f64).sqrt() as f32;
    let peak = samples.iter().fold(0f32, |m, v| m.max(v.abs()));
    let gain = (TARGET_RMS / speech_rms.max(1e-6)).min(MAX_GAIN).min(0.97 / peak.max(1e-6)).max(1.0);
    if gain > 1.001 {
        samples.iter_mut().for_each(|v| *v *= gain);
    }
    20.0 * gain.log10()
}

/// Whisper wants at least ~1 s; shorter clips are padded with silence at the end.
pub fn pad_min(mut samples: Vec<f32>) -> Vec<f32> {
    let min = SAMPLE_RATE as usize + SAMPLE_RATE as usize / 10;
    if samples.len() < min {
        samples.resize(min, 0.0);
    }
    samples
}

/// A WAV file as it is stored: interleaved f32 samples, its rate and channel count, and whether it was 16-bit.
pub struct RawWav {
    pub samples: Vec<f32>,
    pub rate: u32,
    pub channels: usize,
    pub int16: bool,
}

/// Reads a PCM WAV file (16-bit int or 32-bit float, any rate and channel count) as 16 kHz mono f32.
pub fn read_wav(path: &Path) -> Result<Vec<f32>, String> {
    let b = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    parse_wav(&b)
}

pub fn parse_wav(b: &[u8]) -> Result<Vec<f32>, String> {
    let r = parse_wav_raw(b)?;
    Ok(resample(&downmix(&r.samples, r.channels), r.rate))
}

/// Reads a WAV file without converting it (the self-test plays it through a [`Converter`] as a microphone would).
pub fn read_wav_raw(path: &Path) -> Result<RawWav, String> {
    let b = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    parse_wav_raw(&b)
}

pub fn parse_wav_raw(b: &[u8]) -> Result<RawWav, String> {
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err("not a WAV file".into());
    }
    let (mut fmt, mut ch, mut rate, mut bits) = (0u16, 0u16, 0u32, 0u16);
    let mut i = 12;
    while i + 8 <= b.len() {
        let id = &b[i..i + 4];
        let len = u32::from_le_bytes(b[i + 4..i + 8].try_into().unwrap()) as usize;
        let body = &b[i + 8..(i + 8 + len).min(b.len())];
        if id == b"fmt " && body.len() >= 16 {
            fmt = u16::from_le_bytes([body[0], body[1]]);
            ch = u16::from_le_bytes([body[2], body[3]]);
            rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
            bits = u16::from_le_bytes([body[14], body[15]]);
            if fmt == 0xFFFE && body.len() >= 26 {
                fmt = u16::from_le_bytes([body[24], body[25]]);
            }
        } else if id == b"data" {
            if ch == 0 || rate == 0 {
                return Err("WAV data before its format".into());
            }
            let samples: Vec<f32> = match (fmt, bits) {
                (1, 16) => body.chunks_exact(2).map(|s| i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0).collect(),
                (3, 32) => body.chunks_exact(4).map(|s| f32::from_le_bytes(s.try_into().unwrap())).collect(),
                _ => return Err(format!("unsupported WAV encoding (format {fmt}, {bits} bits)")),
            };
            return Ok(RawWav { samples, rate, channels: ch as usize, int16: bits == 16 });
        }
        i += 8 + len + (len & 1);
    }
    Err("WAV file has no data".into())
}

/// 16 kHz mono f32 as a 16-bit PCM WAV (fixtures, and "keep the last recording" when the person turns it on).
pub fn wav_bytes(samples: &[f32]) -> Vec<u8> {
    let data = samples.len() * 2;
    let mut v = Vec::with_capacity(44 + data);
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&((36 + data) as u32).to_le_bytes());
    v.extend_from_slice(b"WAVEfmt ");
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    v.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    v.extend_from_slice(&2u16.to_le_bytes());
    v.extend_from_slice(&16u16.to_le_bytes());
    v.extend_from_slice(b"data");
    v.extend_from_slice(&(data as u32).to_le_bytes());
    for s in samples {
        v.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, hz: f32, secs: f32, amp: f32) -> Vec<f32> {
        (0..(rate as f32 * secs) as usize).map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / rate as f32).sin()).collect()
    }

    /// The dominant frequency, by counting zero crossings.
    fn freq(x: &[f32], rate: u32) -> f32 {
        let z = x.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        z as f32 * rate as f32 / x.len() as f32
    }

    /// Deterministic noise (an LCG), uniform in [-amp, amp].
    fn noise(n: usize, amp: f32, seed: u32) -> Vec<f32> {
        let mut s = seed;
        (0..n)
            .map(|_| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((s >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0) * amp
            })
            .collect()
    }

    /// Speech-like: a 220 Hz tone in 180 ms syllables with 70 ms gaps.
    fn syllables(rate: u32, secs: f32, amp: f32) -> Vec<f32> {
        let s = sine(rate, 220.0, secs, amp);
        let period = (rate as f32 * 0.25) as usize;
        let on = (rate as f32 * 0.18) as usize;
        s.into_iter().enumerate().map(|(i, v)| if i % period < on { v } else { 0.0 }).collect()
    }

    #[test]
    fn downmix_averages_channels() {
        assert_eq!(downmix(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(downmix(&[0.25, 0.5], 1), vec![0.25, 0.5]);
    }

    #[test]
    fn resample_48k_keeps_length_and_pitch() {
        let x = sine(48_000, 440.0, 1.0, 0.5);
        let y = resample(&x, 48_000);
        assert!((y.len() as i64 - 16_000).abs() <= 2, "{}", y.len());
        assert!((freq(&y, 16_000) - 440.0).abs() < 5.0, "{}", freq(&y, 16_000));
        // Amplitude survives (the cut-off is far above 440 Hz); the first and last few ms are the filter's edges.
        assert!((rms(&y[400..15_600]) - rms(&x)).abs() < 0.01, "{} vs {}", rms(&y), rms(&x));
    }

    #[test]
    fn resample_44k1_in_chunks_matches_one_shot() {
        let x = sine(44_100, 300.0, 0.5, 0.3);
        let whole = resample(&x, 44_100);
        let mut r = Resampler::new(44_100);
        let mut parts = Vec::new();
        for c in x.chunks(512) {
            parts.extend(r.push(c));
        }
        parts.extend(r.flush());
        assert_eq!(whole.len(), parts.len());
        let diff = whole.iter().zip(&parts).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
        assert!(diff < 1e-5, "{diff}");
        assert!((whole.len() as i64 - 8_000).abs() <= 2, "{}", whole.len());
    }

    #[test]
    fn resample_removes_what_16k_cannot_hold() {
        // 12 kHz can't exist at 16 kHz: it must be filtered out (-40 dB or better), not folded back to 4 kHz.
        for rate in [48_000, 44_100] {
            let x = sine(rate, 12_000.0, 0.5, 0.5);
            let y = resample(&x, rate);
            let ratio = rms(&y[200..y.len() - 200]) / rms(&x);
            assert!(ratio < 0.01, "{rate}: {ratio}");
        }
        // 3 kHz (inside the speech band whisper uses) passes untouched.
        let x = sine(48_000, 3_000.0, 0.5, 0.5);
        let y = resample(&x, 48_000);
        assert!((rms(&y[200..y.len() - 200]) / rms(&x) - 1.0).abs() < 0.02);
    }

    #[test]
    fn upsample_from_8k() {
        let x = sine(8_000, 200.0, 1.0, 0.5);
        let y = resample(&x, 8_000);
        assert!((y.len() as i64 - 16_000).abs() <= 2);
        assert!((freq(&y, 16_000) - 200.0).abs() < 5.0);
    }

    /// What a Mac microphone delivers, callback by callback, reaching whisper as 16 kHz mono at the right pitch, level
    /// and length: 44.1 and 48 kHz, mono and stereo, int16 and float32.
    #[test]
    fn converter_handles_real_microphone_layouts() {
        for rate in [44_100u32, 48_000] {
            for channels in [1usize, 2] {
                for int16 in [false, true] {
                    let mono = sine(rate, 500.0, 2.0, 0.4);
                    let inter: Vec<f32> = mono.iter().flat_map(|&v| std::iter::repeat_n(v, channels)).collect();
                    let mut c = Converter::new(rate, channels);
                    let mut out = Vec::new();
                    // Core Audio callbacks: 512 frames (10.7–11.6 ms).
                    for chunk in inter.chunks(512 * channels) {
                        out.extend(if int16 { c.push_i16(&chunk.iter().map(|&v| (v * 32767.0) as i16).collect::<Vec<_>>()) } else { c.push_f32(chunk) });
                    }
                    out.extend(c.finish());
                    let what = format!("{rate} Hz, {channels} ch, {}", if int16 { "int16" } else { "f32" });
                    assert!((out.len() as i64 - 32_000).abs() <= 2, "{what}: {} samples", out.len());
                    assert!((freq(&out, 16_000) - 500.0).abs() < 3.0, "{what}: {} Hz", freq(&out, 16_000));
                    let r = rms(&out[400..31_600]);
                    assert!((r - 0.4 / 2f32.sqrt()).abs() < 0.01, "{what}: rms {r}");
                    assert!(c.level > 0.8 && c.peak > 0.39, "{what}: level {} peak {}", c.level, c.peak);
                }
            }
        }
    }

    #[test]
    fn converter_stereo_with_one_silent_channel_still_hears_it() {
        // A USB interface with the microphone on input 1 only.
        let mono = sine(48_000, 300.0, 1.0, 0.4);
        let inter: Vec<f32> = mono.iter().flat_map(|&v| [v, 0.0]).collect();
        let mut c = Converter::new(48_000, 2);
        let mut out = c.push_f32(&inter);
        out.extend(c.finish());
        assert!((rms(&out[400..15_600]) - 0.2 / 2f32.sqrt()).abs() < 0.01);
    }

    #[test]
    fn converter_other_formats() {
        let mut c = Converter::new(16_000, 1);
        assert_eq!(c.push_u16(&[32768, 49152]), vec![0.0, 0.5]);
        assert_eq!(c.push_i32(&[1 << 30]), vec![0.5]);
        assert_eq!(c.push_f64(&[0.25]), vec![0.25]);
        assert!(c.finish().is_empty());
    }

    #[test]
    fn level_maps_db() {
        assert_eq!(level(&[0.0; 100]), 0.0);
        assert_eq!(level(&sine(16_000, 440.0, 0.1, 0.9)), 1.0);
        let quiet = level(&sine(16_000, 440.0, 0.1, 0.01)); // about -43 dBFS
        assert!(quiet > 0.2 && quiet < 0.5, "{quiet}");
    }

    #[test]
    fn silence_is_detected_and_trimmed() {
        assert!(speech_bounds(&vec![0.0; 32_000], 200).is_none());
        // A click is not speech.
        let mut click = vec![0.0; 32_000];
        click[16_000] = 0.9;
        assert!(trim_silence(&click).is_none());
        // 1 s silence, 1 s of syllables, 1 s silence: trimmed to the speech plus 200 ms each side.
        let mut x = vec![0.0; 16_000];
        x.extend(syllables(16_000, 1.0, 0.2));
        x.extend(vec![0.0; 16_000]);
        let t = trim_silence(&x).unwrap();
        let secs = t.len() as f32 / 16_000.0;
        assert!((1.2..=1.5).contains(&secs), "{secs}");
        // Low noise under the threshold stays silence.
        assert!(trim_silence(&noise(32_000, 0.002, 1)).is_none());
    }

    #[test]
    fn steady_noise_is_not_speech_however_loud() {
        // A fan or hiss at -30 dBFS, and mains hum: far above the old fixed threshold, still not speech.
        assert!(speech_bounds(&noise(64_000, 0.05, 2), 200).is_none());
        let hum: Vec<f32> = sine(16_000, 50.0, 4.0, 0.05).iter().zip(noise(64_000, 0.003, 3)).map(|(a, b)| a + b).collect();
        assert!(speech_bounds(&hum, 200).is_none());
        // Speech over that same hiss is found.
        let mut x = noise(64_000, 0.01, 4);
        for (i, v) in syllables(16_000, 2.0, 0.2).into_iter().enumerate() {
            x[16_000 + i] += v;
        }
        let (a, b) = speech_bounds(&x, 0).unwrap();
        assert!(a.abs_diff(16_000) < 800 && b.abs_diff(48_000) < 3_000, "{a}..{b}");
    }

    #[test]
    fn too_little_speech_is_nothing() {
        // 200 ms of sound (a cough, a tap on the desk) isn't worth running whisper for.
        let mut x = vec![0.0; 32_000];
        x[8_000..11_200].copy_from_slice(&sine(16_000, 300.0, 0.2, 0.3));
        assert!(speech_bounds(&x, 200).is_none());
    }

    #[test]
    fn quiet_speech_is_brought_up_without_clipping() {
        let mut x = vec![0.0; 8_000];
        x.extend(syllables(16_000, 2.0, 0.01)); // about -43 dBFS while speaking
        let g = normalize(&mut x);
        assert!(g > 20.0 && g <= 26.1, "{g} dB");
        assert!(x.iter().all(|v| v.abs() <= 0.97));
        // Loud speech is left alone.
        let mut y = syllables(16_000, 1.0, 0.8);
        assert_eq!(normalize(&mut y), 0.0);
        // Silence gets no gain.
        assert_eq!(normalize(&mut vec![0.0; 16_000]), 0.0);
    }

    #[test]
    fn pad_min_pads_short_clips() {
        assert_eq!(pad_min(vec![0.1; 100]).len(), 17_600);
        assert_eq!(pad_min(vec![0.1; 40_000]).len(), 40_000);
    }

    #[test]
    fn wav_round_trip() {
        let x = sine(16_000, 440.0, 0.25, 0.5);
        let y = parse_wav(&wav_bytes(&x)).unwrap();
        assert_eq!(x.len(), y.len());
        assert!(x.iter().zip(&y).all(|(a, b)| (a - b).abs() < 1e-3));
        assert!(parse_wav(b"nope").is_err());
        let r = parse_wav_raw(&wav_bytes(&x)).unwrap();
        assert_eq!((r.rate, r.channels, r.int16), (16_000, 1, true));
    }
}
