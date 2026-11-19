//! The whisper worker: one thread that owns the loaded model, so inference never runs on the UI thread or a Tauri
//! command thread that matters. The model loads on first use (or ahead of it: `preload` when the person starts holding
//! the key), stays loaded between utterances, and is dropped after `IDLE` without use, which gives its memory back.

use coool_whisper::{Model, Options, Task, audio, audio_ctx_for};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const IDLE: Duration = Duration::from_secs(10 * 60);

#[derive(Serialize, Clone, Debug, Default)]
pub struct Transcript {
    /// Raw whisper text (the frontend cleans it).
    pub text: String,
    /// The language whisper heard, e.g. "tr".
    pub language: String,
    /// Inference time, and the speech length after trimming silence.
    pub ms: u64,
    pub secs: f32,
    /// Model load time when this utterance had to load it (0 when it was already loaded).
    pub load_ms: u64,
    /// Nothing but silence was captured (whisper was not run).
    pub silent: bool,
}

pub struct RunReq {
    pub model: PathBuf,
    pub samples: Vec<f32>,
    pub task: Task,
    pub language: Option<String>,
    pub prompt: Option<String>,
}

enum Job {
    Load(PathBuf),
    Run(RunReq, Box<dyn FnMut(&str) + Send>, Sender<Result<Transcript, String>>),
}

pub struct Engine {
    tx: Mutex<Sender<Job>>,
    abort: Arc<AtomicI32>,
    /// The loaded model's path, for status.
    pub loaded: Arc<Mutex<Option<PathBuf>>>,
}

impl Engine {
    pub fn new() -> Engine {
        let (tx, rx) = mpsc::channel();
        let abort = Arc::new(AtomicI32::new(0));
        let loaded = Arc::new(Mutex::new(None));
        let (a2, l2) = (abort.clone(), loaded.clone());
        std::thread::Builder::new().name("coool-voice-whisper".into()).spawn(move || worker(rx, a2, l2)).expect("voice worker");
        Engine { tx: Mutex::new(tx), abort, loaded }
    }

    /// Loads the model in the background if it isn't already (no-op when it is).
    pub fn preload(&self, model: PathBuf) {
        let _ = self.tx.lock().unwrap().send(Job::Load(model));
    }

    /// Transcribes on the worker; blocks the caller (a Tauri async command thread) until done.
    pub fn run(&self, r: RunReq, partial: impl FnMut(&str) + Send + 'static) -> Result<Transcript, String> {
        self.abort.store(0, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.tx.lock().unwrap().send(Job::Run(r, Box::new(partial), tx)).map_err(|_| "voice engine stopped".to_string())?;
        rx.recv().map_err(|_| "voice engine stopped".to_string())?
    }

    /// Stops a running transcription early.
    pub fn abort(&self) {
        self.abort.store(1, Ordering::Relaxed);
    }
}

fn worker(rx: Receiver<Job>, abort: Arc<AtomicI32>, loaded: Arc<Mutex<Option<PathBuf>>>) {
    let mut model: Option<(PathBuf, Model)> = None;
    let mut last = Instant::now();
    let ensure = |model: &mut Option<(PathBuf, Model)>, path: &PathBuf| -> Result<u64, String> {
        if model.as_ref().is_some_and(|(p, _)| p == path) {
            return Ok(0);
        }
        *model = None;
        *loaded.lock().unwrap() = None;
        let t = Instant::now();
        let m = Model::load(path, true).map_err(|e| e.0)?;
        *model = Some((path.clone(), m));
        *loaded.lock().unwrap() = Some(path.clone());
        Ok(t.elapsed().as_millis() as u64)
    };
    loop {
        let job = match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(j) => j,
            Err(RecvTimeoutError::Timeout) => {
                if model.is_some() && last.elapsed() >= IDLE {
                    model = None;
                    *loaded.lock().unwrap() = None;
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        };
        last = Instant::now();
        match job {
            Job::Load(p) => {
                let _ = ensure(&mut model, &p);
            }
            Job::Run(r, mut partial, reply) => {
                let out = (|| {
                    let Some(speech) = audio::trim_silence(&r.samples) else {
                        return Ok(Transcript { silent: true, secs: r.samples.len() as f32 / 16_000.0, ..Default::default() });
                    };
                    let samples = audio::pad_min(speech.to_vec());
                    let load_ms = ensure(&mut model, &r.model)?;
                    let (_, m) = model.as_mut().unwrap();
                    if r.task == Task::Translate && !m.multilingual() {
                        return Err("This model only knows English, so it can't translate. Choose a multilingual model in Settings > Voice.".into());
                    }
                    let o = Options {
                        task: r.task,
                        language: r.language.as_deref(),
                        prompt: r.prompt.as_deref(),
                        audio_ctx: audio_ctx_for(samples.len()),
                        ..Default::default()
                    };
                    let t = Instant::now();
                    let res = m.run(&samples, &o, |s| partial(s), Some(&abort)).map_err(|e| e.0)?;
                    Ok(Transcript { text: res.text, language: res.language, ms: t.elapsed().as_millis() as u64, secs: samples.len() as f32 / 16_000.0, load_ms, silent: false })
                })();
                last = Instant::now();
                let _ = reply.send(out);
            }
        }
    }
}
