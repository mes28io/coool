//! Audio plumbing between a microphone (any rate, any channel count) and whisper (16 kHz mono f32): downmixing,
//! resampling, the level meter, trimming silence, and reading/writing WAV files (fixtures and the self-test).
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

/// A streaming resampler to 16 kHz: linear interpolation after a one-pole low-pass when going down (enough for
/// speech, where whisper only looks below 8 kHz). Keeps its phase between calls, so chunks join without clicks.
pub struct Resampler {
    from: u32,
    /// Position of the next output sample, in input samples, relative to the start of `prev`.
    pos: f64,
    prev: f32,
    lp: f32,
    alpha: f32,
}

impl Resampler {
    pub fn new(from: u32) -> Resampler {
        // A cut-off just under the new Nyquist (8 kHz) for downsampling; no filter when the rate already matches.
        let alpha = if from > SAMPLE_RATE {
            let fc = 0.45 * SAMPLE_RATE as f32;
            let dt = 1.0 / from as f32;
            let rc = 1.0 / (2.0 * std::f32::consts::PI * fc);
            dt / (rc + dt)
        } else {
            1.0
        };
        Resampler { from, pos: 0.0, prev: 0.0, lp: 0.0, alpha }
    }

    /// Feeds mono samples at the input rate; returns the 16 kHz samples they complete.
    pub fn push(&mut self, input: &[f32]) -> Vec<f32> {
        if self.from == SAMPLE_RATE {
            return input.to_vec();
        }
        let step = self.from as f64 / SAMPLE_RATE as f64;
        let mut out = Vec::with_capacity((input.len() as f64 / step) as usize + 2);
        // Index -1 is `prev` (the last sample of the previous chunk), 0.. are this chunk's.
        let mut filtered = Vec::with_capacity(input.len());
        for &x in input {
            self.lp += self.alpha * (x - self.lp);
            filtered.push(self.lp);
        }
        let at = |i: isize, prev: f32, f: &[f32]| if i < 0 { prev } else { f[i as usize] };
        while self.pos < filtered.len() as f64 {
            let i = self.pos.floor() as isize - 1;
            let frac = (self.pos - self.pos.floor()) as f32;
            let a = at(i, self.prev, &filtered);
            let b = at(i + 1, self.prev, &filtered);
            out.push(a + (b - a) * frac);
            self.pos += step;
        }
        self.pos -= filtered.len() as f64;
        if let Some(&l) = filtered.last() {
            self.prev = l;
        }
        out
    }
}

/// One-shot resample of a whole buffer.
pub fn resample(input: &[f32], from: u32) -> Vec<f32> {
    Resampler::new(from).push(input)
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

/// Below this RMS (about -50 dBFS) a 30 ms frame counts as silence.
pub const SILENCE_RMS: f32 = 0.003;

/// The range of `samples` (16 kHz) between the first and last frame with speech energy, padded by `pad_ms` on each
/// side; `None` when the whole clip is silent (then whisper is not run at all: it would invent "Thank you.").
pub fn speech_bounds(samples: &[f32], pad_ms: usize) -> Option<(usize, usize)> {
    let frame = (SAMPLE_RATE as usize * 30) / 1000;
    let loud: Vec<bool> = samples.chunks(frame).map(|f| rms(f) > SILENCE_RMS).collect();
    let first = loud.iter().position(|&l| l)?;
    let last = loud.iter().rposition(|&l| l)?;
    // A single loud frame is a click, not speech.
    if loud.iter().filter(|&&l| l).count() < 3 {
        return None;
    }
    let pad = SAMPLE_RATE as usize * pad_ms / 1000;
    let start = (first * frame).saturating_sub(pad);
    let end = ((last + 1) * frame + pad).min(samples.len());
    Some((start, end))
}

/// Trims leading and trailing silence (keeping 200 ms around the speech); `None` for a silent clip.
pub fn trim_silence(samples: &[f32]) -> Option<&[f32]> {
    speech_bounds(samples, 200).map(|(a, b)| &samples[a..b])
}

/// Whisper wants at least ~1 s; shorter clips are padded with silence at the end.
pub fn pad_min(mut samples: Vec<f32>) -> Vec<f32> {
    let min = SAMPLE_RATE as usize + SAMPLE_RATE as usize / 10;
    if samples.len() < min {
        samples.resize(min, 0.0);
    }
    samples
}

/// Reads a PCM WAV file (16-bit int or 32-bit float, any rate and channel count) as 16 kHz mono f32.
pub fn read_wav(path: &Path) -> Result<Vec<f32>, String> {
    let b = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    parse_wav(&b)
}

pub fn parse_wav(b: &[u8]) -> Result<Vec<f32>, String> {
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
            return Ok(resample(&downmix(&samples, ch as usize), rate));
        }
        i += 8 + len + (len & 1);
    }
    Err("WAV file has no data".into())
}

/// 16 kHz mono f32 as a 16-bit PCM WAV (for tests and fixtures; coool never writes the person's audio to disk).
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
        // Amplitude survives (the low-pass is well above 440 Hz).
        assert!((rms(&y) - rms(&x)).abs() < 0.02);
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
        // Rounding of the running position may move the very last sample across the end.
        assert!(whole.len().abs_diff(parts.len()) <= 1, "{} vs {}", whole.len(), parts.len());
        let diff = whole.iter().zip(&parts).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
        assert!(diff < 1e-4, "{diff}");
    }

    #[test]
    fn resample_attenuates_above_nyquist() {
        // 12 kHz can't exist at 16 kHz; it must be damped, not folded back at full strength.
        let x = sine(48_000, 12_000.0, 0.5, 0.5);
        let y = resample(&x, 48_000);
        assert!(rms(&y) < rms(&x) * 0.6, "{} vs {}", rms(&y), rms(&x));
    }

    #[test]
    fn upsample_from_8k() {
        let x = sine(8_000, 200.0, 1.0, 0.5);
        let y = resample(&x, 8_000);
        assert!((y.len() as i64 - 16_000).abs() <= 2);
        assert!((freq(&y, 16_000) - 200.0).abs() < 5.0);
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
        // 1 s silence, 1 s tone, 1 s silence: trimmed to the tone plus 200 ms each side.
        let mut x = vec![0.0; 16_000];
        x.extend(sine(16_000, 300.0, 1.0, 0.2));
        x.extend(vec![0.0; 16_000]);
        let t = trim_silence(&x).unwrap();
        let secs = t.len() as f32 / 16_000.0;
        assert!((1.3..=1.5).contains(&secs), "{secs}");
        // Low noise under the threshold stays silence.
        let noise: Vec<f32> = (0..32_000).map(|i| if i % 2 == 0 { 0.001 } else { -0.001 }).collect();
        assert!(trim_silence(&noise).is_none());
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
    }
}
