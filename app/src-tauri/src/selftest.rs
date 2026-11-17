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
//!   COOOL_SELFTEST_SHOTS=app/docs/screenshots target/debug/coool
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

    /// The throwaway folder.
    pub fn dir(&self) -> &Path {
        &self.dir
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
        // `get_window`, not `get_webview_window`: once the in-app browser adds a child webview, `main` is a window
        // with several webviews and no longer counts as a webview window.
        if let Some(w) = app.get_window("main") {
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
    let w = app.get_window("main").ok_or("no window")?;
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
fn window_number(w: &tauri::Window) -> Option<i64> {
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
fn window_number(_w: &tauri::Window) -> Option<i64> {
    None
}

// ---------- the `browser` scenario ----------

/// What the probe page posted (one JSON object per post).
static PROBE: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Starts a one-page http server on 127.0.0.1 (a remote origin to the app) serving [`BROWSER_PROBE`], which tries
/// to reach coool's IPC from inside the in-app browser and posts what happened back to this server (it has no
/// other way out). Returns the page's URL.
#[tauri::command]
pub fn selftest_probe_server(core: State<'_, Arc<Core>>) -> Result<String, String> {
    active(&core)?;
    use std::io::{BufRead, BufReader, Read};
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = l.local_addr().map_err(|e| e.to_string())?.port();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            let Ok(c) = s.try_clone() else { continue };
            let mut r = BufReader::new(c);
            let mut first = String::new();
            if r.read_line(&mut first).is_err() {
                continue;
            }
            let mut len = 0usize;
            loop {
                let mut h = String::new();
                if r.read_line(&mut h).is_err() || h.trim().is_empty() {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            let mut out = s;
            if first.starts_with("POST /result") {
                let mut body = vec![0; len.min(64 * 1024)];
                let _ = r.read_exact(&mut body);
                PROBE.lock().unwrap().push(String::from_utf8_lossy(&body).into_owned());
                let _ = out.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            } else if first.starts_with("GET /probe") {
                let _ = write!(out, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{BROWSER_PROBE}", BROWSER_PROBE.len());
            } else {
                let _ = out.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            }
        }
    });
    Ok(format!("http://127.0.0.1:{port}/probe"))
}

#[tauri::command]
pub fn selftest_probe_result(core: State<'_, Arc<Core>>) -> Result<Vec<String>, String> {
    active(&core)?;
    Ok(PROBE.lock().unwrap().clone())
}

#[tauri::command]
pub fn selftest_resize(app: AppHandle, core: State<'_, Arc<Core>>, width: f64, height: f64) -> Result<(), String> {
    active(&core)?;
    app.get_window("main").ok_or("no window")?.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct WebviewProbe {
    /// What the frontend last asked for: visible, [x, y, w, h].
    asked: Option<(bool, [f64; 4])>,
    /// The native view: hidden, and its frame in the window (logical points).
    hidden: Option<bool>,
    frame: Option<[f64; 4]>,
}

/// A browser webview as it really is (macOS: the WKWebView's `isHidden`; its bounds from the runtime).
#[tauri::command(async)]
pub fn selftest_webview(app: AppHandle, core: State<'_, Arc<Core>>, id: String) -> Result<WebviewProbe, String> {
    active(&core)?;
    let asked = core.browsers.placed.lock().unwrap().get(&id).copied();
    let Some(w) = app.get_webview(&id) else { return Ok(WebviewProbe { asked, hidden: None, frame: None }) };
    let scale = w.window().scale_factor().unwrap_or(1.0);
    let frame = w.bounds().ok().map(|b| {
        let p = b.position.to_logical::<f64>(scale);
        let s = b.size.to_logical::<f64>(scale);
        [p.x, p.y, s.width, s.height]
    });
    let (tx, rx) = std::sync::mpsc::channel();
    w.with_webview(move |pw| {
        let _ = tx.send(native_hidden(pw.inner()));
    })
    .map_err(|e| e.to_string())?;
    let hidden = rx.recv_timeout(std::time::Duration::from_secs(3)).ok().flatten();
    Ok(WebviewProbe { asked, hidden, frame })
}

#[cfg(target_os = "macos")]
fn native_hidden(wk: *mut std::ffi::c_void) -> Option<bool> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    let wk = wk as *mut AnyObject;
    if wk.is_null() {
        return None;
    }
    // SAFETY: `isHidden` on the live WKWebView, on the main thread (with_webview runs there).
    Some(unsafe { msg_send![&*wk, isHidden] })
}

#[cfg(not(target_os = "macos"))]
fn native_hidden(_wk: *mut std::ffi::c_void) -> Option<bool> {
    None
}

/// Served by [`selftest_probe_server`] and loaded in the in-app browser. `?app=<origin>` names the app's own origin.
const BROWSER_PROBE: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Browser probe</title>
<style>body{font:16px -apple-system,sans-serif;padding:24px;background:#fff;color:#111}pre{white-space:pre-wrap;font-size:12px}</style></head>
<body><h1>In-app browser probe</h1><pre id="out">running…</pre>
<script>
(async () => {
  const post = (o) => fetch("/result", { method: "POST", body: JSON.stringify(o) }).catch(() => {});
  const I = window.__TAURI_INTERNALS__;
  const tryInvoke = async (cmd, args) => {
    if (!I || typeof I.invoke !== "function") return "no invoke";
    try {
      await Promise.race([I.invoke(cmd, args || {}), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 4000))]);
      return "ALLOWED";
    } catch (e) { return "refused: " + String((e && e.message) || e).slice(0, 160); }
  };
  const r = { step: "ipc", origin: location.origin, internals: typeof I, tauri: typeof window.__TAURI__ };
  r.selftestLog = await tryInvoke("selftest_log", { line: "BROWSER-IPC-REACHED" });
  r.listSessions = await tryInvoke("list_sessions");
  r.windowPlugin = await tryInvoke("plugin:window|is_maximized", { label: "main" });
  r.eventListen = await tryInvoke("plugin:event|listen", { event: "sessions", target: { kind: "Any" }, handler: 1 });
  try {
    const res = await fetch("ipc://localhost/selftest_log", { method: "POST", body: JSON.stringify({ line: "BROWSER-IPC-FETCH-REACHED" }), headers: { "Content-Type": "application/json", "Tauri-Callback": "1", "Tauri-Error": "2" } });
    r.ipcFetch = res.status;
  } catch (e) { r.ipcFetch = "error"; }
  document.getElementById("out").textContent = JSON.stringify(r, null, 1);
  await post(r);
  const app = new URLSearchParams(location.search).get("app") || "";
  for (const [step, to] of [["file", "file:///etc/hosts"], ["custom", "coool-artifact://localhost/x/y.html"], ["app", app]]) {
    if (!to) continue;
    try { location.href = to; } catch (e) {}
    await new Promise((res) => setTimeout(res, 1200));
    await post({ step, tried: to, href: location.href });
  }
  await post({ step: "done" });
})();
</script></body></html>"#;

/// The same path as Cmd+Q (asks first when anything runs).
#[tauri::command]
pub fn selftest_request_quit(app: AppHandle, core: State<'_, Arc<Core>>) -> Result<(), String> {
    active(&core)?;
    crate::request_quit(&app);
    Ok(())
}
