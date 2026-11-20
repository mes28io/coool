//! Voice to prompt (APP_SPEC "Voice"): hold a key, speak, and a local whisper model writes the prompt into the
//! composer, transcribed as spoken or translated to English. Everything here runs on this Mac:
//!
//! - `capture`: the microphone, open only while listening; audio stays in memory and is dropped after transcription.
//! - `engine`: the whisper worker (model kept loaded between utterances, dropped after 10 idle minutes).
//! - `models`: the model catalogue, downloads from the official whisper.cpp host on request only, checksum, files
//!   already on disk.
//! - `native` + `keys`: the microphone permission, macOS's spell/grammar checker, voice's keys (an AppKit monitor).
//! - `project`: words a project uses, on request, for the words library.
//! - memory: the words library and learned corrections live in one JSON file (`memory.json`) that the frontend reads
//!   and writes whole (app/src/lib/voice/memory.ts owns its shape).
//!
//! The one optional network call is the AI polish (coool_core::polish), only with AI insights on.

pub mod capture;
pub mod engine;
pub mod keys;
pub mod models;
pub mod native;
pub mod project;

use crate::Core;
use coool_core::insights;
use coool_core::polish;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager, State};

type Res<T> = Result<T, String>;

pub struct Voice {
    dir: OnceLock<PathBuf>,
    engine: engine::Engine,
    capture: Mutex<Option<capture::Capture>>,
    /// Bumped on every start/stop: the level emitter of an older capture stops.
    generation: Arc<AtomicU64>,
    downloads: Mutex<HashMap<String, models::Download>>,
    /// Self-test only: the next capture plays this fixture instead of opening the microphone.
    inject: Mutex<Option<coool_whisper::audio::RawWav>>,
    /// The page's key settings and state, read by the key monitor (`keys`).
    pub keys: Arc<Mutex<keys::Config>>,
    selftest: OnceLock<bool>,
    /// For the self-test: how often the checker and the AI polish were asked (memory hits must ask neither).
    pub spell_calls: AtomicU64,
    pub polish_calls: AtomicU64,
    pub runs: AtomicU64,
    /// Self-test: model downloads asked for (a self-test never downloads one; see `voice_model_download`).
    pub download_calls: AtomicU64,
}

impl Voice {
    pub fn new() -> Voice {
        Voice {
            dir: OnceLock::new(),
            engine: engine::Engine::new(),
            capture: Mutex::new(None),
            generation: Arc::new(AtomicU64::new(0)),
            downloads: Mutex::new(HashMap::new()),
            inject: Mutex::new(None),
            keys: Arc::new(Mutex::new(keys::Config::default())),
            selftest: OnceLock::new(),
            spell_calls: AtomicU64::new(0),
            polish_calls: AtomicU64::new(0),
            runs: AtomicU64::new(0),
            download_calls: AtomicU64::new(0),
        }
    }

    fn dir(&self) -> Res<&Path> {
        self.dir.get().map(|p| p.as_path()).ok_or_else(|| "voice isn't ready yet".into())
    }
    fn models_dir(&self) -> Res<PathBuf> {
        Ok(self.dir()?.join("models"))
    }
    fn memory_path(&self) -> Res<PathBuf> {
        Ok(self.dir()?.join("memory.json"))
    }
    /// "Keep the last recording" (off unless the person turns it on): one WAV, replaced each time.
    fn recording_path(&self) -> Res<PathBuf> {
        Ok(self.dir()?.join("last-recording.wav"))
    }
    fn is_selftest(&self) -> bool {
        self.selftest.get().copied().unwrap_or(false)
    }
}

/// Called from setup (on the main thread): where voice keeps its files (the app data folder, or the self-test's own
/// folder), and the key monitor (its events go to the page as `voice-key`).
pub fn init(app: &AppHandle, selftest_dir: Option<&Path>) {
    let v = app.state::<Arc<Voice>>();
    let dir = match selftest_dir {
        Some(d) => d.join(".coool-voice"),
        None => app.path().app_local_data_dir().map(|d| d.join("voice")).unwrap_or_else(|_| std::env::temp_dir().join("coool-voice")),
    };
    let _ = v.dir.set(dir);
    let _ = v.selftest.set(selftest_dir.is_some());
    if std::env::var_os("COOOL_WHISPER_LOG").is_some() {
        coool_whisper::set_verbose(true);
    }
    let h = app.clone();
    native::watch_keys(
        v.keys.clone(),
        Box::new(move |k| {
            let _ = h.emit("voice-key", k);
        }),
    );
}

// ---------------------------------------------------------------- status

#[derive(Serialize)]
pub struct Status {
    /// The engine is in this build (Apple silicon).
    available: bool,
    permission: native::MicPermission,
    /// The model currently in memory.
    loaded: Option<String>,
    listening: bool,
    models_dir: String,
    memory_path: String,
    /// Where "Keep the last recording" writes, and whether there is one now.
    recording_path: String,
    recording: bool,
}

#[tauri::command(async)]
pub fn voice_status(v: State<'_, Arc<Voice>>) -> Res<Status> {
    Ok(Status {
        available: coool_whisper::available(),
        permission: native::permission(),
        loaded: v.engine.loaded.lock().unwrap().as_ref().map(|p| p.to_string_lossy().into_owned()),
        listening: v.capture.lock().unwrap().is_some(),
        models_dir: v.models_dir()?.to_string_lossy().into_owned(),
        memory_path: v.memory_path()?.to_string_lossy().into_owned(),
        recording_path: v.recording_path()?.to_string_lossy().into_owned(),
        recording: v.recording_path()?.is_file(),
    })
}

#[tauri::command(async)]
pub fn voice_permission() -> native::MicPermission {
    native::permission()
}

/// The system's one-time microphone prompt. Only ever called when the person starts voice for the first time.
#[tauri::command(async)]
pub fn voice_permission_request() -> native::MicPermission {
    native::request_permission()
}

/// System Settings > Privacy & Security > Microphone.
#[tauri::command(async)]
pub fn voice_open_privacy() -> Res<()> {
    std::process::Command::new("open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone").status().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn voice_devices() -> Vec<capture::Device> {
    capture::devices()
}

// ---------------------------------------------------------------- listening

#[derive(Serialize, Clone)]
struct Level {
    level: f32,
    secs: f32,
    /// The loudest sample so far (0..1): stays near 0 when the microphone sends nothing usable.
    peak: f32,
}

/// The page's key settings and whether voice is busy, for the key monitor (called whenever either changes).
#[tauri::command(async)]
pub fn voice_keys(v: State<'_, Arc<Voice>>, cfg: keys::Config) {
    *v.keys.lock().unwrap() = cfg;
}

#[derive(Serialize)]
pub struct Started {
    device: String,
    /// What the device delivers, e.g. "48000 Hz, 1 ch, F32".
    format: String,
}

/// Opens the microphone (or the self-test's fixture) and starts sending `voice-level` events (~25 a second) until
/// stop or cancel. Refuses unless macOS already allows the microphone (the page asks first, on first use only).
#[tauri::command(async)]
pub fn voice_start(app: AppHandle, v: State<'_, Arc<Voice>>, device: Option<String>, model: Option<String>) -> Res<Started> {
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        v.engine.preload(PathBuf::from(crate::expand_tilde(&m)));
    }
    let injected = v.inject.lock().unwrap().take();
    let cap = match injected {
        Some(wav) => capture::Capture::start_injected(wav),
        None => {
            let p = native::permission();
            if p != native::MicPermission::Authorized {
                return Err(format!("permission:{}", serde_json::to_value(p).ok().and_then(|x| x.as_str().map(String::from)).unwrap_or_default()));
            }
            capture::Capture::start(device.as_deref().filter(|d| !d.is_empty()))?
        }
    };
    let started = Started { device: cap.device.clone(), format: cap.format.clone() };
    let sink = cap.sink.clone();
    let failed = cap.failed.clone();
    *v.capture.lock().unwrap() = Some(cap);
    let g = v.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let generation = v.generation.clone();
    std::thread::spawn(move || {
        while generation.load(Ordering::SeqCst) == g {
            let _ = app.emit("voice-level", Level { level: sink.level(), secs: sink.secs(), peak: sink.peak() });
            if let Some(e) = failed.lock().unwrap().take() {
                let _ = app.emit("voice-error", e);
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
    });
    Ok(started)
}

#[derive(Deserialize)]
pub struct StopReq {
    model: String,
    /// "translate" or "transcribe".
    task: String,
    /// A whisper language code, or "auto" / empty.
    #[serde(default)]
    language: Option<String>,
    /// The person's words: only to recognise whisper reading them back (never given to whisper; see
    /// coool_whisper::dictate for why).
    #[serde(default)]
    vocabulary: Vec<String>,
    /// "Keep the last recording": write what was captured to `last-recording.wav` (replacing the previous one).
    #[serde(default)]
    keep: bool,
}

fn task(s: &str) -> coool_whisper::Task {
    if s == "translate" { coool_whisper::Task::Translate } else { coool_whisper::Task::Transcribe }
}

/// Closes the microphone at once, then transcribes what was captured (on the whisper worker) and returns the raw
/// text; pieces arrive as `voice-partial` events while it decodes. The audio is dropped when this returns.
#[tauri::command(async)]
pub fn voice_stop(app: AppHandle, v: State<'_, Arc<Voice>>, req: StopReq) -> Res<engine::Transcript> {
    v.generation.fetch_add(1, Ordering::SeqCst);
    let cap = v.capture.lock().unwrap().take().ok_or("not listening")?;
    let samples = cap.finish(capture::TAIL);
    let _ = app.emit("voice-level", Level { level: 0.0, secs: 0.0, peak: 0.0 });
    if req.keep
        && let Ok(p) = v.recording_path()
    {
        let _ = std::fs::write(p, coool_whisper::audio::wav_bytes(&samples));
    }
    transcribe(&app, &v, samples, &req)
}

fn transcribe(app: &AppHandle, v: &Voice, samples: Vec<f32>, req: &StopReq) -> Res<engine::Transcript> {
    if req.model.trim().is_empty() {
        return Err("No voice model yet. Download one in Settings > Voice.".into());
    }
    v.runs.fetch_add(1, Ordering::Relaxed);
    let h = app.clone();
    v.engine.run(
        engine::RunReq {
            model: PathBuf::from(crate::expand_tilde(&req.model)),
            samples,
            task: task(&req.task),
            language: req.language.clone().filter(|l| !l.is_empty() && l != "auto"),
            vocabulary: req.vocabulary.clone(),
        },
        move |s| {
            let _ = h.emit("voice-partial", s.to_string());
        },
    )
}

/// Esc while listening (nothing is transcribed), or while transcribing (the run stops early).
#[tauri::command(async)]
pub fn voice_cancel(app: AppHandle, v: State<'_, Arc<Voice>>) {
    v.generation.fetch_add(1, Ordering::SeqCst);
    let cap = v.capture.lock().unwrap().take();
    drop(cap);
    v.engine.abort();
    let _ = app.emit("voice-level", Level { level: 0.0, secs: 0.0, peak: 0.0 });
}

/// Loads the model ahead of the first utterance (the person started holding the key, or opened Settings > Voice).
#[tauri::command(async)]
pub fn voice_preload(v: State<'_, Arc<Voice>>, model: String) {
    if !model.trim().is_empty() {
        v.engine.preload(PathBuf::from(crate::expand_tilde(&model)));
    }
}

// ---------------------------------------------------------------- models

#[derive(Serialize)]
pub struct ModelRow {
    #[serde(flatten)]
    spec: models::Spec,
    /// The downloaded file, when present.
    path: Option<String>,
    /// A partial download's size (paused or interrupted).
    partial: Option<u64>,
    /// A download running now (or its last state this run).
    download: Option<models::Progress>,
}

#[derive(Serialize)]
pub struct Models {
    catalog: Vec<ModelRow>,
    found: Vec<models::Found>,
    dir: String,
    recommended: &'static str,
    /// Free space where models are stored, bytes.
    free: Option<u64>,
}

fn free_space(p: &Path) -> Option<u64> {
    let mut q = p.to_path_buf();
    while !q.exists() {
        q = q.parent()?.to_path_buf();
    }
    let c = std::ffi::CString::new(q.to_string_lossy().as_bytes()).ok()?;
    let mut s: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    Some(s.f_bavail * s.f_bsize as u64)
}

#[tauri::command(async)]
pub fn voice_models(v: State<'_, Arc<Voice>>) -> Res<Models> {
    let dir = v.models_dir()?;
    let dl = v.downloads.lock().unwrap();
    let catalog = models::CATALOG
        .iter()
        .map(|s| {
            let f = models::final_path(&dir, s);
            let part = models::part_path(&dir, s);
            ModelRow {
                spec: *s,
                path: f.is_file().then(|| f.to_string_lossy().into_owned()),
                partial: part.metadata().ok().map(|m| m.len()),
                download: dl.get(s.id).map(|d| d.last.lock().unwrap().clone()),
            }
        })
        .collect();
    Ok(Models { catalog, found: models::find_existing(&dir), dir: dir.to_string_lossy().into_owned(), recommended: models::RECOMMENDED, free: free_space(&dir) })
}

/// Starts or resumes a download (only ever from the person's button press). Progress: `voice-model` events.
#[tauri::command(async)]
pub fn voice_model_download(app: AppHandle, v: State<'_, Arc<Voice>>, id: String) -> Res<()> {
    let s = models::spec(&id).ok_or("unknown model")?;
    // A self-test never downloads a model (hundreds of MB from the network): the press is counted and refused.
    if v.is_selftest() {
        v.download_calls.fetch_add(1, Ordering::Relaxed);
        return Err("Downloads are off during a self-test.".into());
    }
    let dir = v.models_dir()?;
    let mut dl = v.downloads.lock().unwrap();
    if dl.get(&id).is_some_and(|d| matches!(*d.last.lock().unwrap(), models::Progress::Downloading { .. } | models::Progress::Verifying { .. })) {
        return Ok(());
    }
    let need = s.bytes.saturating_sub(models::part_path(&dir, s).metadata().map(|m| m.len()).unwrap_or(0));
    if let Some(free) = free_space(&dir)
        && free < need + 200_000_000
    {
        return Err(format!("Not enough free disk space: {} MB needed, {} MB free.", need / 1_000_000, free / 1_000_000));
    }
    let id2 = id.clone();
    let d = models::start(&dir, s, move |p| {
        let _ = app.emit("voice-model", models::DownloadState { id: id2.clone(), progress: p });
    });
    dl.insert(id, d);
    Ok(())
}

#[tauri::command(async)]
pub fn voice_model_pause(v: State<'_, Arc<Voice>>, id: String) {
    if let Some(d) = v.downloads.lock().unwrap().get(&id) {
        d.pause();
    }
}

/// Stops a download and deletes its partial file (or just the partial file, when none runs).
#[tauri::command(async)]
pub fn voice_model_cancel(v: State<'_, Arc<Voice>>, id: String) -> Res<()> {
    let s = models::spec(&id).ok_or("unknown model")?;
    match v.downloads.lock().unwrap().get(&id) {
        Some(d) if matches!(*d.last.lock().unwrap(), models::Progress::Downloading { .. }) => d.cancel(),
        _ => {
            let _ = std::fs::remove_file(models::part_path(&v.models_dir()?, s));
        }
    }
    Ok(())
}

/// Deletes a downloaded model file (only one in coool's own models folder).
#[tauri::command(async)]
pub fn voice_model_delete(v: State<'_, Arc<Voice>>, id: String) -> Res<()> {
    let s = models::spec(&id).ok_or("unknown model")?;
    let p = models::final_path(&v.models_dir()?, s);
    if v.engine.loaded.lock().unwrap().as_deref() == Some(p.as_path()) {
        v.engine.abort();
    }
    std::fs::remove_file(&p).map_err(|e| e.to_string())
}

/// "Use an existing file…": checks that a file is a whisper ggml model.
#[tauri::command(async)]
pub fn voice_model_check(path: String) -> Res<models::Found> {
    let p = PathBuf::from(crate::expand_tilde(&path));
    if !p.is_file() {
        return Err("That file doesn't exist.".into());
    }
    if !models::looks_like_model(&p) {
        return Err("That isn't a whisper.cpp model file (ggml-*.bin).".into());
    }
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    Ok(models::Found { bytes: p.metadata().map(|m| m.len()).unwrap_or(0), id: models::CATALOG.iter().find(|s| s.file == name).map(|s| s.id.to_string()), place: "other", path: p.to_string_lossy().into_owned() })
}

// ---------------------------------------------------------------- memory (words library + learned corrections)

#[tauri::command(async)]
pub fn voice_memory_read(v: State<'_, Arc<Voice>>) -> Res<Option<String>> {
    match std::fs::read_to_string(v.memory_path()?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Writes the whole file atomically (temp file + rename), readable JSON.
#[tauri::command(async)]
pub fn voice_memory_write(v: State<'_, Arc<Voice>>, json: String) -> Res<()> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|_| "not JSON")?;
    let p = v.memory_path()?;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn voice_memory_clear(v: State<'_, Arc<Voice>>) -> Res<()> {
    match std::fs::remove_file(v.memory_path()?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Shows the memory file (or the models folder) in Finder.
#[tauri::command(async)]
pub fn voice_reveal(v: State<'_, Arc<Voice>>, what: String) -> Res<()> {
    let p = match what.as_str() {
        "models" => v.models_dir()?,
        "recording" => v.recording_path()?,
        _ => v.memory_path()?,
    };
    let target = if p.exists() { p } else { p.parent().map(Path::to_path_buf).ok_or("no folder")? };
    if target.is_dir() {
        std::fs::create_dir_all(&target).ok();
        std::process::Command::new("open").arg(&target).status().map_err(|e| e.to_string())?;
    } else {
        std::process::Command::new("open").arg("-R").arg(&target).status().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn voice_project_words(cwd: String) -> Vec<project::Word> {
    project::words(Path::new(&crate::expand_tilde(&cwd)))
}

// ---------------------------------------------------------------- the checker

/// macOS's spelling (and grammar) check of a text, with the person's words ignored for this session.
#[tauri::command(async)]
pub fn voice_spell(v: State<'_, Arc<Voice>>, text: String, language: Option<String>, ignore: Vec<String>, grammar: bool) -> Vec<native::SpellHit> {
    v.spell_calls.fetch_add(1, Ordering::Relaxed);
    native::spell_check(&text, language.as_deref(), &ignore, grammar)
}

/// The optional AI polish of one dictated utterance (only with AI insights on; the page caches results).
#[tauri::command(async)]
pub fn voice_polish(core: State<'_, Arc<Core>>, v: State<'_, Arc<Voice>>, req: polish::Request) -> polish::Reply {
    let slot = core.insights.lock().unwrap().take_slot();
    let r = match slot {
        insights::Slot::Off => polish::Reply::Off { has_key: insights::api_key().is_some() },
        insights::Slot::NoKey => polish::Reply::Off { has_key: false },
        insights::Slot::Limited => polish::Reply::Limited,
        insights::Slot::Go(key) => {
            v.polish_calls.fetch_add(1, Ordering::Relaxed);
            polish::run(&key, &req)
        }
    };
    if let (Some(t), polish::Reply::Done { usd, ms, .. }) = (&core.selftest, &r) {
        t.log_line(&format!("voice: AI polish in {ms} ms, ${usd:.5}"));
    }
    r
}

// ---------------------------------------------------------------- self-test

/// The next `voice_start` plays this WAV fixture instead of opening the microphone (self-test runs only), in the
/// file's own rate, channels and sample format, through the same converter a microphone's callbacks go through.
#[tauri::command(async)]
pub fn voice_selftest_inject(v: State<'_, Arc<Voice>>, path: String) -> Res<f32> {
    if !v.is_selftest() {
        return Err("self-test mode is off".into());
    }
    let w = coool_whisper::audio::read_wav_raw(Path::new(&path))?;
    let secs = w.samples.len() as f32 / w.channels as f32 / w.rate as f32;
    *v.inject.lock().unwrap() = Some(w);
    Ok(secs)
}

#[derive(Serialize)]
pub struct Counters {
    spell: u64,
    polish: u64,
    runs: u64,
    downloads: u64,
}

#[tauri::command(async)]
pub fn voice_selftest_counters(v: State<'_, Arc<Voice>>) -> Res<Counters> {
    if !v.is_selftest() {
        return Err("self-test mode is off".into());
    }
    Ok(Counters { spell: v.spell_calls.load(Ordering::Relaxed), polish: v.polish_calls.load(Ordering::Relaxed), runs: v.runs.load(Ordering::Relaxed), downloads: v.download_calls.load(Ordering::Relaxed) })
}

#[derive(Serialize)]
pub struct SelftestEnv {
    model: Option<String>,
    fixtures: Option<String>,
}

/// COOOL_VOICE_MODEL and COOOL_VOICE_FIXTURES for the `voice` scenario (self-test runs only).
#[tauri::command(async)]
pub fn voice_selftest_env(v: State<'_, Arc<Voice>>) -> Res<SelftestEnv> {
    if !v.is_selftest() {
        return Err("self-test mode is off".into());
    }
    Ok(SelftestEnv { model: std::env::var("COOOL_VOICE_MODEL").ok(), fixtures: std::env::var("COOOL_VOICE_FIXTURES").ok() })
}

/// Runs a WAV file through the real engine, bypassing the microphone (self-test runs only).
#[tauri::command(async)]
pub fn voice_selftest_transcribe(app: AppHandle, v: State<'_, Arc<Voice>>, path: String, req: StopReq) -> Res<engine::Transcript> {
    if !v.is_selftest() {
        return Err("self-test mode is off".into());
    }
    let s = coool_whisper::audio::read_wav(Path::new(&path))?;
    transcribe(&app, &v, s, &req)
}

#[derive(Deserialize)]
pub struct KeyStep {
    /// "down", "up" or "flags" (a modifier key changed).
    kind: String,
    /// The macOS virtual key code.
    code: u16,
    /// NSEventModifierFlags after the event (with the right/left device bits for modifiers).
    #[serde(default)]
    flags: usize,
    #[serde(default)]
    chars: String,
    /// Pause after this step.
    #[serde(default)]
    wait_ms: u64,
}

/// Real key events into coool's main window, through AppKit as the keyboard delivers them (self-test runs only; see
/// `native::post_key`: no permission, nothing posted system-wide).
#[tauri::command(async)]
pub fn voice_selftest_keys(app: AppHandle, v: State<'_, Arc<Voice>>, steps: Vec<KeyStep>) -> Res<()> {
    if !v.is_selftest() {
        return Err("self-test mode is off".into());
    }
    let win = app.get_window("main").ok_or("no window")?;
    let ns = win.ns_window().map_err(|e| e.to_string())? as usize;
    for s in steps {
        let kind = match s.kind.as_str() {
            "down" => 10usize,
            "up" => 11,
            "flags" => 12,
            k => return Err(format!("unknown key step {k}")),
        };
        let (tx, rx) = std::sync::mpsc::channel();
        let (code, flags, chars) = (s.code, s.flags, s.chars.clone());
        app.run_on_main_thread(move || {
            let _ = tx.send(native::post_key(ns as *mut std::ffi::c_void, kind, code, flags, &chars));
        })
        .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|e| e.to_string())??;
        if s.wait_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(s.wait_ms));
        }
    }
    Ok(())
}
