//! Microphone capture: one input stream (cpal → Core Audio) on a thread of its own. Every callback goes through one
//! [`Converter`] (sample format, channels, rate → 16 kHz mono f32) into the recording, with the level for the meter.
//! The stream exists only between `start` and `finish`/drop: the moment listening ends, the device is closed and
//! macOS's recording indicator goes off.
//!
//! Ending: `finish` keeps the stream open for a short tail (`TAIL`) before closing it, so the last syllable said as the
//! key is released isn't cut off, then flushes what the resampler still held.
//!
//! Audio stays in memory; nothing is written to disk unless the person turned on "Keep the last recording" (the caller
//! writes it). A self-test can inject a WAV fixture instead of the microphone (`Capture::start_injected`): it is played
//! at real speed in Core Audio-sized callbacks, in the fixture's own rate, channels and format, through the same
//! converter, then followed by silence until the recording ends, exactly as a microphone would deliver it.

use coool_whisper::audio::{Converter, RawWav};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// The longest utterance kept (whisper.cpp handles more, but a dictation this long is a mistake): 5 minutes.
pub const MAX_SECONDS: usize = 300;
/// How long the microphone stays open after the person finishes.
pub const TAIL: Duration = Duration::from_millis(250);

/// What the callbacks write into, shared with the command that ends the recording.
pub struct Sink {
    conv: Mutex<Converter>,
    pub samples: Mutex<Vec<f32>>,
    /// The latest meter value, 0..1, as f32 bits; and the loudest sample so far.
    pub level: AtomicU32,
    pub peak: AtomicU32,
}

impl Sink {
    pub fn new(rate: u32, channels: usize) -> Arc<Sink> {
        Arc::new(Sink { conv: Mutex::new(Converter::new(rate, channels)), samples: Mutex::new(Vec::with_capacity(16_000 * 30)), level: AtomicU32::new(0), peak: AtomicU32::new(0) })
    }
    /// One callback's worth of interleaved frames, in whichever format the device gives.
    pub fn push(&self, f: impl FnOnce(&mut Converter) -> Vec<f32>) {
        let (out, lvl, peak) = {
            let mut c = self.conv.lock().unwrap();
            let out = f(&mut c);
            (out, c.level, c.peak)
        };
        self.level.store(lvl.to_bits(), Ordering::Relaxed);
        self.peak.store(peak.to_bits(), Ordering::Relaxed);
        let mut buf = self.samples.lock().unwrap();
        if buf.len() < 16_000 * MAX_SECONDS {
            buf.extend_from_slice(&out);
        }
    }
    /// The end of the recording: what the resampler still held, then everything.
    pub fn take(&self) -> Vec<f32> {
        let rest = self.conv.lock().unwrap().finish();
        let mut buf = self.samples.lock().unwrap();
        buf.extend_from_slice(&rest);
        std::mem::take(&mut *buf)
    }
    pub fn secs(&self) -> f32 {
        self.samples.lock().unwrap().len() as f32 / 16_000.0
    }
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }
    pub fn peak(&self) -> f32 {
        f32::from_bits(self.peak.load(Ordering::Relaxed))
    }
}

pub struct Capture {
    stop: Option<mpsc::Sender<()>>,
    thread: Option<thread::JoinHandle<()>>,
    pub sink: Arc<Sink>,
    /// Set when the stream failed after starting (the device went away).
    pub failed: Arc<Mutex<Option<String>>>,
    pub device: String,
    /// What the device delivers, e.g. "48000 Hz, 1 ch, F32" (for Settings > Voice and the self-test log).
    pub format: String,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct Device {
    pub name: String,
    pub default: bool,
}

#[cfg(target_os = "macos")]
pub fn devices() -> Vec<Device> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let def = host.default_input_device().and_then(|d| d.description().ok().map(|x| x.name().to_string()));
    let Ok(list) = host.input_devices() else { return vec![] };
    let mut out: Vec<Device> = list
        .filter_map(|d| d.description().ok().map(|x| x.name().to_string()))
        .map(|name| Device { default: def.as_deref() == Some(name.as_str()), name })
        .collect();
    out.dedup_by(|a, b| a.name == b.name);
    out
}

#[cfg(not(target_os = "macos"))]
pub fn devices() -> Vec<Device> {
    vec![]
}

impl Capture {
    /// Opens `device` (by name; `None` or an unknown name: the system default input) and starts collecting.
    /// Returns once the stream runs (or failed to open).
    #[cfg(target_os = "macos")]
    pub fn start(device: Option<&str>) -> Result<Capture, String> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        let failed = Arc::new(Mutex::new(None));
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(String, String, Arc<Sink>), String>>();
        let want = device.map(str::to_string);
        let f2 = failed.clone();
        let t = thread::Builder::new()
            .name("coool-voice-capture".into())
            .spawn(move || {
                let host = cpal::default_host();
                let dev = want
                    .as_deref()
                    .and_then(|w| host.input_devices().ok()?.find(|d| d.description().ok().is_some_and(|x| x.name() == w)))
                    .or_else(|| host.default_input_device());
                let Some(dev) = dev else {
                    let _ = ready_tx.send(Err("no-device: No microphone found.".into()));
                    return;
                };
                let name = dev.description().map(|x| x.name().to_string()).unwrap_or_else(|_| "Microphone".into());
                let cfg = match dev.default_input_config() {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("Can't use {name}: {e}")));
                        return;
                    }
                };
                let channels = cfg.channels() as usize;
                let rate = cfg.sample_rate();
                let format = format!("{rate} Hz, {channels} ch, {:?}", cfg.sample_format());
                let sink = Sink::new(rate, channels);
                let f3 = f2.clone();
                let on_err = move |e: cpal::Error| {
                    *f3.lock().unwrap() = Some(e.to_string());
                };
                let stream_cfg: cpal::StreamConfig = cfg.clone().into();
                let s = sink.clone();
                let stream = match cfg.sample_format() {
                    cpal::SampleFormat::F32 => dev.build_input_stream(stream_cfg, move |d: &[f32], _: &_| s.push(|c| c.push_f32(d)), on_err, None),
                    cpal::SampleFormat::F64 => dev.build_input_stream(stream_cfg, move |d: &[f64], _: &_| s.push(|c| c.push_f64(d)), on_err, None),
                    cpal::SampleFormat::I16 => dev.build_input_stream(stream_cfg, move |d: &[i16], _: &_| s.push(|c| c.push_i16(d)), on_err, None),
                    cpal::SampleFormat::I32 => dev.build_input_stream(stream_cfg, move |d: &[i32], _: &_| s.push(|c| c.push_i32(d)), on_err, None),
                    cpal::SampleFormat::U16 => dev.build_input_stream(stream_cfg, move |d: &[u16], _: &_| s.push(|c| c.push_u16(d)), on_err, None),
                    other => {
                        let _ = ready_tx.send(Err(format!("{name} gives {other:?} samples, which coool can't read yet.")));
                        return;
                    }
                };
                let stream = match stream {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("Can't open {name}: {e}")));
                        return;
                    }
                };
                if let Err(e) = stream.play() {
                    let _ = ready_tx.send(Err(format!("Can't start {name}: {e}")));
                    return;
                }
                let _ = ready_tx.send(Ok((name, format, sink)));
                // Held until stop or cancel; dropping the stream closes the device.
                let _ = stop_rx.recv();
                drop(stream);
            })
            .map_err(|e| e.to_string())?;
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok((name, format, sink))) => Ok(Capture { stop: Some(stop_tx), thread: Some(t), sink, failed, device: name, format }),
            Ok(Err(e)) => {
                let _ = t.join();
                Err(e)
            }
            Err(_) => {
                drop(stop_tx);
                Err("The microphone didn't start in time.".into())
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn start(_: Option<&str>) -> Result<Capture, String> {
        Err("Voice needs macOS.".into())
    }

    /// The self-test's stand-in for a microphone: `wav` as stored (its own rate, channels, int16 or f32), in 512-frame
    /// callbacks at real speed through the same converter, then silence until the recording ends.
    pub fn start_injected(wav: RawWav) -> Capture {
        let sink = Sink::new(wav.rate, wav.channels);
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let s2 = sink.clone();
        let format = format!("{} Hz, {} ch, {} (self-test fixture)", wav.rate, wav.channels, if wav.int16 { "I16" } else { "F32" });
        let t = thread::spawn(move || {
            let frames = 512;
            let chunk = frames * wav.channels;
            let period = Duration::from_secs_f64(frames as f64 / wav.rate as f64);
            let silence = vec![0f32; chunk];
            let mut it = wav.samples.chunks(chunk);
            let t0 = std::time::Instant::now();
            let mut sent = 0usize;
            loop {
                if stop_rx.recv_timeout(period).is_ok() {
                    return;
                }
                // Paced by the clock, as a device is: every callback that is due by now, however late the thread woke.
                let due = (t0.elapsed().as_secs_f64() * wav.rate as f64) as usize;
                while sent + frames <= due {
                    let d = it.next().unwrap_or(&silence);
                    if wav.int16 {
                        let v: Vec<i16> = d.iter().map(|&x| (x * 32768.0).clamp(-32768.0, 32767.0) as i16).collect();
                        s2.push(|c| c.push_i16(&v));
                    } else {
                        s2.push(|c| c.push_f32(d));
                    }
                    sent += frames;
                }
            }
        });
        Capture { stop: Some(stop_tx), thread: Some(t), sink, failed: Arc::new(Mutex::new(None)), device: "Self-test fixture".into(), format }
    }

    /// Keeps listening for `tail`, closes the device and returns the whole recording (16 kHz mono).
    pub fn finish(mut self, tail: Duration) -> Vec<f32> {
        if !tail.is_zero() {
            thread::sleep(tail);
        }
        self.close();
        self.sink.take()
    }

    fn close(&mut self) {
        if let Some(s) = self.stop.take() {
            let _ = s.send(());
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, secs: f32, amp: f32) -> Vec<f32> {
        (0..(rate as f32 * secs) as usize).map(|i| amp * (2.0 * std::f32::consts::PI * 400.0 * i as f32 / rate as f32).sin()).collect()
    }

    /// The recording keeps what is said up to the moment it ends, plus the tail: a fixture of 0.6 s at 44.1 kHz stereo
    /// int16, ended 0.2 s after it finished, arrives whole (0.6 s of tone, then silence), at 16 kHz.
    #[test]
    fn injected_recording_arrives_whole_with_its_tail() {
        let mono = tone(44_100, 0.6, 0.3);
        let samples: Vec<f32> = mono.iter().flat_map(|&v| [v, v]).collect();
        let cap = Capture::start_injected(RawWav { samples, rate: 44_100, channels: 2, int16: true });
        thread::sleep(Duration::from_millis(800));
        let level = cap.sink.level();
        let peak = cap.sink.peak();
        let out = cap.finish(TAIL);
        let secs = out.len() as f32 / 16_000.0;
        assert!((1.0..1.4).contains(&secs), "{secs} s");
        let loud = out.iter().rposition(|v| v.abs() > 0.05).unwrap() as f32 / 16_000.0;
        assert!((0.57..0.62).contains(&loud), "tone ends at {loud} s");
        let first = out.iter().position(|v| v.abs() > 0.05).unwrap();
        assert!(first < 160, "tone starts at sample {first}");
        assert!(peak > 0.29, "peak {peak}");
        assert_eq!(level, 0.0, "after the fixture, the meter shows silence");
    }

    #[test]
    fn cancel_keeps_nothing_running() {
        let cap = Capture::start_injected(RawWav { samples: tone(48_000, 5.0, 0.3), rate: 48_000, channels: 1, int16: false });
        thread::sleep(Duration::from_millis(100));
        drop(cap); // returns at once (the thread is joined)
    }
}
