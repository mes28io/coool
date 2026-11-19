//! Microphone capture: one input stream (cpal → Core Audio) on a thread of its own, downmixed and resampled to 16 kHz
//! mono as it arrives, with a level for the meter. The stream exists only between `start` and `stop`/`cancel`: the
//! moment listening ends, the device is closed and macOS's recording indicator goes off.
//!
//! Audio stays in memory; nothing is written to disk. A self-test can inject a WAV fixture instead of the microphone
//! (`Capture::start_injected`), played through at real speed so the meter and timing behave as with a voice.

use coool_whisper::audio::{Resampler, downmix, level};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// The longest utterance kept (whisper.cpp handles more, but a dictation this long is a mistake): 5 minutes.
pub const MAX_SECONDS: usize = 300;

pub struct Capture {
    stop: Option<mpsc::Sender<()>>,
    thread: Option<thread::JoinHandle<()>>,
    pub samples: Arc<Mutex<Vec<f32>>>,
    /// The latest meter value, 0..1, as f32 bits.
    pub level: Arc<AtomicU32>,
    /// Set when the stream failed after starting (the device went away).
    pub failed: Arc<Mutex<Option<String>>>,
    pub device: String,
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
        let samples = Arc::new(Mutex::new(Vec::<f32>::with_capacity(16_000 * 30)));
        let lvl = Arc::new(AtomicU32::new(0));
        let failed = Arc::new(Mutex::new(None));
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<String, String>>();
        let want = device.map(str::to_string);
        let (s2, l2, f2) = (samples.clone(), lvl.clone(), failed.clone());
        let t = thread::Builder::new()
            .name("coool-voice-capture".into())
            .spawn(move || {
                let host = cpal::default_host();
                let dev = want
                    .as_deref()
                    .and_then(|w| host.input_devices().ok()?.find(|d| d.description().ok().is_some_and(|x| x.name() == w)))
                    .or_else(|| host.default_input_device());
                let Some(dev) = dev else {
                    let _ = ready_tx.send(Err("No microphone found.".into()));
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
                let rs = Mutex::new(Resampler::new(rate));
                let max = 16_000 * MAX_SECONDS;
                let push = move |mono: Vec<f32>| {
                    l2.store(level(&mono).to_bits(), Ordering::Relaxed);
                    let out = rs.lock().unwrap().push(&mono);
                    let mut buf = s2.lock().unwrap();
                    if buf.len() < max {
                        buf.extend_from_slice(&out);
                    }
                };
                let f3 = f2.clone();
                let on_err = move |e: cpal::Error| {
                    *f3.lock().unwrap() = Some(e.to_string());
                };
                let stream_cfg: cpal::StreamConfig = cfg.clone().into();
                let stream = match cfg.sample_format() {
                    cpal::SampleFormat::F32 => dev.build_input_stream(stream_cfg, move |d: &[f32], _: &_| push(downmix(d, channels)), on_err, None),
                    cpal::SampleFormat::I16 => dev.build_input_stream(
                        stream_cfg,
                        move |d: &[i16], _: &_| push(downmix(&d.iter().map(|&s| s as f32 / 32768.0).collect::<Vec<_>>(), channels)),
                        on_err,
                        None,
                    ),
                    cpal::SampleFormat::I32 => dev.build_input_stream(
                        stream_cfg,
                        move |d: &[i32], _: &_| push(downmix(&d.iter().map(|&s| s as f32 / 2147483648.0).collect::<Vec<_>>(), channels)),
                        on_err,
                        None,
                    ),
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
                let _ = ready_tx.send(Ok(name));
                // Held until stop or cancel; dropping the stream closes the device.
                let _ = stop_rx.recv();
                drop(stream);
            })
            .map_err(|e| e.to_string())?;
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(name)) => Ok(Capture { stop: Some(stop_tx), thread: Some(t), samples, level: lvl, failed, device: name }),
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

    /// The self-test's stand-in for a microphone: `fixture` (16 kHz mono) arrives in 20 ms chunks at real speed.
    pub fn start_injected(fixture: Vec<f32>) -> Capture {
        let samples = Arc::new(Mutex::new(Vec::with_capacity(fixture.len())));
        let lvl = Arc::new(AtomicU32::new(0));
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (s2, l2) = (samples.clone(), lvl.clone());
        let done = Arc::new(AtomicBool::new(false));
        let t = thread::spawn(move || {
            for chunk in fixture.chunks(320) {
                if stop_rx.recv_timeout(Duration::from_millis(20)).is_ok() || done.load(Ordering::Relaxed) {
                    return;
                }
                l2.store(level(chunk).to_bits(), Ordering::Relaxed);
                s2.lock().unwrap().extend_from_slice(chunk);
            }
            l2.store(0, Ordering::Relaxed);
            let _ = stop_rx.recv();
        });
        Capture { stop: Some(stop_tx), thread: Some(t), samples, level: lvl, failed: Arc::new(Mutex::new(None)), device: "Self-test fixture".into() }
    }

    /// Closes the device and returns what was captured.
    pub fn finish(mut self) -> Vec<f32> {
        self.close();
        std::mem::take(&mut *self.samples.lock().unwrap())
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
