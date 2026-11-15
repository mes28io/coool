//! Dev-only self-test mode: the frontend runs a scripted scenario through the
//! real client against this real backend, logs pass/fail, and asks for
//! screenshots of the window. Used to verify the app end to end when synthetic
//! clicks/keystrokes from outside are blocked.
//!
//! Inert unless both hold: a debug build (`cfg!(debug_assertions)`) and
//! `COOOL_SELFTEST=<scenario>` is set. Release builds never enable it.
//!
//! ```sh
//! COOOL_SELFTEST=all COOOL_SELFTEST_DIR=/tmp/coool-selftest/demo-project \
//!   COOOL_SELFTEST_SHOTS=app/docs/screenshots target/debug/coool-app
//! ```
//!
//! - `COOOL_SELFTEST`: a scenario name or `all` (see `app/src/selftest.ts`).
//! - `COOOL_SELFTEST_DIR`: an existing throwaway folder. Chats start there, and
//!   the sidebar only lists sessions under it (so no private titles show).
//! - `COOOL_SELFTEST_SHOTS`: where `real-<name>.png` screenshots go (default: the folder).
//! - `COOOL_SELFTEST_LOG`: the pass/fail log (default: `<folder>/selftest.log`).
//!
//! Settings (the insights and "runs by other tools" toggles) and the list of
//! sessions coool started are kept in the folder too, never in the real ones;
//! Codex chats introduce themselves as `coool-selftest`, so a later normal launch
//! never counts them as the person's.

use crate::Core;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

pub struct SelfTest {
    scenario: String,
    dir: PathBuf,
    /// `dir` with symlinks resolved (/tmp -> /private/tmp).
    canonical: PathBuf,
    shots: PathBuf,
    log: PathBuf,
}

#[derive(Serialize)]
pub struct Config {
    scenario: String,
    dir: String,
    shots: String,
}

impl SelfTest {
    pub fn from_env() -> Option<Self> {
        if !cfg!(debug_assertions) {
            return None;
        }
        let scenario = std::env::var("COOOL_SELFTEST").ok().filter(|s| !s.trim().is_empty())?;
        let Some(dir) = std::env::var_os("COOOL_SELFTEST_DIR").map(PathBuf::from).filter(|d| d.is_dir()) else {
            eprintln!("coool self-test: COOOL_SELFTEST_DIR must name an existing folder; self-test is off");
            return None;
        };
        let canonical = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        let shots = std::env::var_os("COOOL_SELFTEST_SHOTS").map(PathBuf::from).unwrap_or_else(|| dir.clone());
        let log = std::env::var_os("COOOL_SELFTEST_LOG").map(PathBuf::from).unwrap_or_else(|| dir.join("selftest.log"));
        let _ = std::fs::create_dir_all(&shots);
        let _ = std::fs::write(&log, "");
        Some(Self { scenario: scenario.trim().to_string(), dir, canonical, shots, log })
    }

    /// True for a session whose folder is inside the self-test folder.
    pub fn owns(&self, cwd: &str) -> bool {
        let p = Path::new(cwd);
        p.starts_with(&self.dir) || p.starts_with(&self.canonical) || p.canonicalize().is_ok_and(|c| c.starts_with(&self.canonical))
    }

    pub fn settings_path(&self) -> PathBuf {
        self.dir.join(".coool-selftest-settings.json")
    }

    /// coool's list of its own sessions, kept here instead of the real one.
    pub fn own_sessions_path(&self) -> PathBuf {
        self.dir.join(".coool-selftest-own-sessions.json")
    }

    /// A fixed size, on top, so screenshots are comparable and unobstructed.
    pub fn prepare_window(&self, app: &AppHandle) {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_size(tauri::LogicalSize::new(1440.0, 900.0));
            let _ = w.center();
            let _ = w.set_always_on_top(true);
            let _ = w.set_focus();
        }
    }

    fn log(&self, line: &str) {
        let stamp = chrono_like_now();
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&self.log) {
            let _ = writeln!(f, "{stamp} {line}");
        }
        eprintln!("[selftest] {line}");
    }
}

fn chrono_like_now() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("{}.{:03}", ms / 1000, ms % 1000)
}

fn active(core: &Core) -> Result<&SelfTest, String> {
    core.selftest.as_ref().ok_or_else(|| "self-test mode is off".to_string())
}

/// `null` unless self-test mode is on (so the frontend stays inert otherwise).
#[tauri::command]
pub fn selftest_config(core: State<'_, Arc<Core>>) -> Option<Config> {
    let t = core.selftest.as_ref()?;
    Some(Config { scenario: t.scenario.clone(), dir: t.dir.to_string_lossy().into_owned(), shots: t.shots.to_string_lossy().into_owned() })
}

#[tauri::command(async)]
pub fn selftest_log(core: State<'_, Arc<Core>>, line: String) -> Result<(), String> {
    active(&core)?.log(&line);
    Ok(())
}

/// Screenshot of the app window alone into `<shots>/real-<name>.png`.
///
/// Captures by window id (`screencapture -l`), so only coool's own window is
/// recorded, even when other windows overlap it: nothing else on the screen
/// can end up in a screenshot.
#[tauri::command(async)]
pub fn selftest_shot(app: AppHandle, core: State<'_, Arc<Core>>, name: String) -> Result<String, String> {
    let t = active(&core)?;
    let name: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c.to_ascii_lowercase() } else { '-' }).collect();
    let w = app.get_webview_window("main").ok_or("no window")?;
    let wid = window_number(&w).ok_or("no window id")?;
    let path = t.shots.join(format!("real-{name}.png"));
    let _ = std::fs::remove_file(&path);
    let ok = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-o", &format!("-l{wid}")])
        .arg(&path)
        .status()
        .map_err(|e| e.to_string())?
        .success();
    if !ok || !path.exists() {
        return Err("screencapture failed (does the launching app have Screen Recording permission?)".into());
    }
    t.log(&format!("SHOT {}", path.display()));
    Ok(path.to_string_lossy().into_owned())
}

/// The window's CGWindowID (`-[NSWindow windowNumber]`).
#[cfg(target_os = "macos")]
fn window_number(w: &tauri::WebviewWindow) -> Option<i64> {
    use std::ffi::{c_char, c_void};
    unsafe extern "C" {
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    let ns = w.ns_window().ok()?;
    if ns.is_null() {
        return None;
    }
    // SAFETY: `ns` is a live NSWindow owned by Tauri; `windowNumber` takes no
    // arguments and returns an NSInteger. objc_msgSend must be called through
    // a function pointer of the exact signature.
    let n = unsafe {
        let sel = sel_registerName(c"windowNumber".as_ptr());
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void) -> isize = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        f(ns, sel)
    };
    (n > 0).then_some(n as i64)
}

#[cfg(not(target_os = "macos"))]
fn window_number(_w: &tauri::WebviewWindow) -> Option<i64> {
    None
}

/// The same path as Cmd+Q (asks first when anything runs).
#[tauri::command]
pub fn selftest_request_quit(app: AppHandle, core: State<'_, Arc<Core>>) -> Result<(), String> {
    active(&core)?;
    crate::request_quit(&app);
    Ok(())
}
