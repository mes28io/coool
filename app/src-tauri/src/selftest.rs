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
//! - `COOOL_SELFTEST_SHOTS_ONSCREEN=1`: shoot the window's rectangle on screen instead of the window alone, so the
//!   frosted glass shows what is behind it (the `glass` scenario).
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

    /// coool's session titles, kept here instead of the real file.
    pub fn titles_path(&self) -> PathBuf {
        self.dir.join(".coool-selftest-titles.json")
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
pub fn selftest_shot(app: AppHandle, core: State<'_, Arc<Core>>, name: String, window: Option<String>) -> Result<String, String> {
    let t = active(&core)?;
    let name: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c.to_ascii_lowercase() } else { '-' }).collect();
    // The main window, one of the in-app browser's pop-ups, or an artifact preview window.
    let label = window.filter(|l| l.starts_with(crate::browser::POPUP_PREFIX) || l.starts_with(crate::artifact::PREVIEW_PREFIX)).unwrap_or_else(|| "main".into());
    let w = app.get_window(&label).ok_or("no window")?;
    let wid = window_number(&w).ok_or("no window id")?;
    let path = t.shots.join(format!("real-{name}.png"));
    let _ = std::fs::remove_file(&path);
    // `COOOL_SELFTEST_SHOTS_ONSCREEN=1`: the window's rectangle as it is on screen instead, which includes what
    // shows through a translucent window (a `-l` capture renders the window alone, without its vibrancy backdrop).
    // The test window is always on top, so only its own pixels (and, at its rounded corners, what is behind) show.
    let onscreen = std::env::var("COOOL_SELFTEST_SHOTS_ONSCREEN").is_ok_and(|v| v == "1");
    let arg = if onscreen {
        let scale = w.scale_factor().map_err(|e| e.to_string())?;
        let p = w.outer_position().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
        let z = w.outer_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
        format!("-R{},{},{},{}", p.x, p.y, z.width, z.height)
    } else {
        format!("-l{wid}")
    };
    let ok = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-o", &arg])
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
            // A connection each: WebKit opens speculative connections that send nothing, which would stall the rest.
            std::thread::spawn(move || {
                let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(10)));
                let Ok(c) = s.try_clone() else { return };
                let mut r = BufReader::new(c);
                let mut first = String::new();
                if r.read_line(&mut first).is_err() {
                    return;
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
                } else if let Some(page) = [("GET /probe", BROWSER_PROBE), ("GET /opener", POPUP_OPENER), ("GET /popup", POPUP_PAGE), ("GET /tabpage", TAB_PAGE), ("GET /blanklink", BLANK_LINK), ("GET /form", FORM_PAGE)].iter().find(|(p, _)| first.starts_with(p)).map(|(_, b)| b.replace("/*IPC_PROBE*/", IPC_PROBE)) {
                    let _ = write!(out, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len());
                } else {
                    let _ = out.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                }
            });
        }
    });
    Ok(format!("http://127.0.0.1:{port}/probe"))
}

#[tauri::command]
pub fn selftest_probe_result(core: State<'_, Arc<Core>>) -> Result<Vec<String>, String> {
    active(&core)?;
    Ok(PROBE.lock().unwrap().clone())
}

/// Window states the page may not set itself (its capability has no such permission): `focus`, `fullscreen`,
/// `windowed` (leaves full screen and goes back on top).
#[tauri::command]
pub fn selftest_window(app: AppHandle, core: State<'_, Arc<Core>>, action: String) -> Result<(), String> {
    active(&core)?;
    let w = app.get_window("main").ok_or("no window")?;
    let r = match action.as_str() {
        "focus" => w.set_focus(),
        "fullscreen" => w.set_always_on_top(false).and_then(|_| w.set_fullscreen(true)),
        "windowed" => w.set_fullscreen(false).and_then(|_| w.set_always_on_top(true)),
        _ => return Err(format!("unknown action {action}")),
    };
    r.map_err(|e| e.to_string())
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
/*IPC_PROBE*/
(async () => {
  const post = (o) => fetch("/result", { method: "POST", body: JSON.stringify(o) }).catch(() => {});
  const r = await ipcProbe("ipc");
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

/// Tries coool's IPC every way a page could (Tauri's internals, a plugin, the event system, a raw `ipc://` fetch);
/// `ipcProbe(step)` resolves to what happened to each. Spliced into the probe pages at `/*IPC_PROBE*/`.
const IPC_PROBE: &str = r#"async function ipcProbe(step) {
  const I = window.__TAURI_INTERNALS__;
  const tryInvoke = async (cmd, args) => {
    if (!I || typeof I.invoke !== "function") return "no invoke";
    try {
      await Promise.race([I.invoke(cmd, args || {}), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 4000))]);
      return "ALLOWED";
    } catch (e) { return "refused: " + String((e && e.message) || e).slice(0, 160); }
  };
  const r = { step, origin: location.origin, internals: typeof I, tauri: typeof window.__TAURI__ };
  r.selftestLog = await tryInvoke("selftest_log", { line: "BROWSER-IPC-REACHED from " + step });
  r.listSessions = await tryInvoke("list_sessions");
  r.windowPlugin = await tryInvoke("plugin:window|is_maximized", { label: "main" });
  r.eventListen = await tryInvoke("plugin:event|listen", { event: "sessions", target: { kind: "Any" }, handler: 1 });
  try {
    const res = await fetch("ipc://localhost/selftest_log", { method: "POST", body: JSON.stringify({ line: "BROWSER-IPC-FETCH-REACHED from " + step }), headers: { "Content-Type": "application/json", "Tauri-Callback": "1", "Tauri-Error": "2" } });
    r.ipcFetch = res.status;
  } catch (e) { r.ipcFetch = "error"; }
  return r;
}"#;

/// Loaded in the in-app browser: its button opens [`POPUP_PAGE`] with `window.open` (as Google's sign-in does) and
/// the page reports through its own title, which the panel shows (no IPC needed): `Opener got: <message>` when the
/// pop-up posts to it, then `…, pop-up closed` once the pop-up has closed itself.
const POPUP_OPENER: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Opener ready</title>
<style>body{font:16px -apple-system,sans-serif;padding:24px;background:#fff;color:#111}button{font:inherit;padding:8px 14px}</style></head>
<body><h1>Pop-up opener</h1><button id="open">Continue with the probe</button>
<p><a id="blank" href="/tabpage?via=blank" target="_blank">A target=_blank link</a> · <button id="plain">window.open without features</button></p><p id="out"></p>
<script>
let popup = null, got = null;
const say = (t) => { document.title = t; document.getElementById("out").textContent = t; };
document.getElementById("open").addEventListener("click", () => {
  popup = window.open("/popup" + location.search, "coool-signin", "width=480,height=600");
  say(popup ? "Opener opened a pop-up" : "Opener: pop-up blocked");
});
document.getElementById("plain").addEventListener("click", () => { window.open("/tabpage?via=open"); });
window.addEventListener("message", (e) => {
  got = e.source === popup && e.origin === location.origin ? String(e.data) : "foreign " + e.origin;
  say("Opener got: " + got);
  const t = setInterval(() => { if (popup && popup.closed) { clearInterval(t); say("Opener got: " + got + ", pop-up closed"); } }, 200);
});
</script></body></html>"#;

/// The pop-up: reports what it sees (its opener, user agent, IPC) to the probe server, holds a moment for a
/// screenshot, posts "hi" to its opener and closes itself, as a sign-in pop-up does (`?stay`: stays open).
const POPUP_PAGE: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Sign-in pop-up probe</title>
<style>body{font:16px -apple-system,sans-serif;padding:24px;background:#fff;color:#111}pre{white-space:pre-wrap;font-size:12px}</style></head>
<body><h1>Sign-in pop-up probe</h1><pre id="out">running…</pre>
<script>
/*IPC_PROBE*/
(async () => {
  const post = (o) => fetch("/result", { method: "POST", body: JSON.stringify(o) }).catch(() => {});
  const r = await ipcProbe("popup-ipc");
  r.hasOpener = !!window.opener;
  r.userAgent = navigator.userAgent;
  r.size = [window.innerWidth, window.innerHeight];
  document.getElementById("out").textContent = JSON.stringify(r, null, 1);
  await post(r);
  await new Promise((res) => setTimeout(res, 3000));
  if (window.opener) window.opener.postMessage("hi", "*");
  await post({ step: "popup-posted", hasOpener: !!window.opener });
  if (new URLSearchParams(location.search).has("stay")) return;
  await new Promise((res) => setTimeout(res, 300));
  window.close();
})();
</script></body></html>"#;

/// A page for tabs: titled with its query (`Tab via=blank`), so the panel shows which one it is.
const TAB_PAGE: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Tab</title>
<style>body{font:16px -apple-system,sans-serif;padding:24px;background:#fff;color:#111}</style></head>
<body><h1 id="h">Tab</h1><p>A page the self-test opens in browser tabs.</p>
<script>document.title = "Tab " + location.search.slice(1); document.getElementById("h").textContent = document.title;</script></body></html>"#;

/// One `target=_blank` link covering the whole page, for a real click at the webview's centre ([`selftest_click`]).
const BLANK_LINK: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Link page</title>
<style>html,body{margin:0;height:100%}a{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font:20px -apple-system,sans-serif;background:#eef4ff;color:#124}</style></head>
<body><a href="/tabpage?via=blank" target="_blank">A target=_blank link (click anywhere)</a></body></html>"#;

/// For a chat's agent to fill in through the `browser_*` tools (the `agent-browser` scenario): a name, an email, a
/// counter button and Submit. Every change posts the page's state to the probe server (`{"step":"form",…}`), so the
/// test sees what really happened on the page, not only what the agent says. The confirmation's reference is
/// `CUP-<100 + 7·cups + name length>`, so a reply can only quote it after really doing the steps.
const FORM_PAGE: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Coffee order</title>
<style>body{font:16px -apple-system,sans-serif;padding:24px;background:#fff;color:#111;max-width:420px}label{display:block;margin:12px 0 4px}
input{font:inherit;padding:6px 8px;width:100%;box-sizing:border-box}button{font:inherit;padding:8px 14px;margin-top:14px}
#done{margin-top:18px;padding:12px;background:#e8f6ec;border-radius:8px}</style></head>
<body><h1>Coffee order</h1>
<form id="f"><label for="name">Name</label><input id="name" name="name" autocomplete="off">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="off">
<p>Cups: <output id="count">0</output></p><button type="button" id="add">Add cup</button>
<div><button type="submit" id="submit">Submit order</button></div></form>
<p id="done" hidden></p>
<script>
const $ = (i) => document.getElementById(i);
let cups = 0, submitted = false;
const post = () => fetch("/result", { method: "POST", body: JSON.stringify({ step: "form", name: $("name").value, email: $("email").value, cups, submitted, confirmation: $("done").hidden ? "" : $("done").textContent }) }).catch(() => {});
$("add").addEventListener("click", () => { cups++; $("count").textContent = String(cups); post(); });
$("name").addEventListener("change", post);
$("email").addEventListener("change", post);
$("f").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("name").value.trim();
  if (!name || !cups) { $("done").hidden = false; $("done").textContent = "Please enter a name and add at least one cup."; post(); return; }
  submitted = true;
  $("done").hidden = false;
  $("done").textContent = "Order confirmed for " + name + ": " + cups + " cups, reference CUP-" + (100 + 7 * cups + name.length) + ".";
  $("f").hidden = true;
  document.title = "Order confirmed";
  post();
});
</script></body></html>"#;

/// The simulator the self-test creates, drives and deletes (never the person's "coool iPhone").
pub const SIM_NAME: &str = "coool selftest iPhone";

/// Shuts the self-test's simulator down and deletes it (the end of the `agent-iphone` scenario).
#[tauri::command(async)]
pub fn selftest_sim_delete(core: State<'_, Arc<Core>>, devices: State<'_, Arc<crate::device::Devices>>) -> Result<Vec<String>, String> {
    active(&core)?;
    let mine: Vec<_> = crate::device::simctl::devices()?.into_iter().filter(|d| d.name == SIM_NAME).collect();
    for d in &mine {
        let _ = devices.shutdown(&d.udid);
        crate::device::simctl::delete(&d.udid)?;
    }
    Ok(mine.into_iter().map(|d| d.udid).collect())
}

/// The test simulator's screen as the backend reads it (the accessibility tree, rendered as `observe` does), so a
/// scenario can confirm what is really on screen, apart from what an agent reports.
#[tauri::command(async)]
pub fn selftest_sim_screen(core: State<'_, Arc<Core>>, devices: State<'_, Arc<crate::device::Devices>>, udid: String) -> Result<String, String> {
    active(&core)?;
    let d = crate::device::simctl::device(&udid)?;
    if d.name != SIM_NAME {
        return Err("not the self-test's simulator".into());
    }
    let r = devices.helper(&udid)?.call(serde_json::json!({ "cmd": "describe", "max": 400 }), std::time::Duration::from_secs(10))?;
    Ok(crate::device::observe::render(&crate::device::observe::parse(&r), &d.name))
}

/// The device pilot's decision log as written (every line of every log file in the test's own pilot folder), so a
/// scenario can check its records and that no input value is in them.
#[tauri::command(async)]
pub fn selftest_pilot_log(core: State<'_, Arc<Core>>, devices: State<'_, Arc<crate::device::Devices>>) -> Result<Vec<String>, String> {
    let t = active(&core)?;
    let dir = crate::device::pilot::dir(&devices).ok_or("no pilot folder")?;
    if !dir.starts_with(t.dir()) {
        return Err("not the self-test's pilot folder".into());
    }
    let mut lines = Vec::new();
    for f in crate::device::pilot::dataset::files(&dir) {
        lines.extend(std::fs::read_to_string(&f).map_err(|e| e.to_string())?.lines().map(String::from));
    }
    Ok(lines)
}

#[derive(Serialize)]
pub struct PopupProbe {
    label: String,
    opener: String,
    title: String,
    /// Outer frame, logical points: [x, y, w, h].
    frame: Option<[f64; 4]>,
    visible: bool,
}

/// The in-app browser's open pop-up windows.
#[tauri::command]
pub fn selftest_popups(app: AppHandle, core: State<'_, Arc<Core>>) -> Result<Vec<PopupProbe>, String> {
    active(&core)?;
    let popups = core.browsers.popups.lock().unwrap().clone();
    Ok(popups
        .into_iter()
        .filter_map(|(label, opener)| {
            let w = app.get_webview_window(&label)?;
            let scale = w.scale_factor().unwrap_or(1.0);
            let frame = (|| {
                let p = w.outer_position().ok()?.to_logical::<f64>(scale);
                let s = w.outer_size().ok()?.to_logical::<f64>(scale);
                Some([p.x, p.y, s.width, s.height])
            })();
            Some(PopupProbe { title: w.title().unwrap_or_default(), visible: w.is_visible().unwrap_or(false), frame, label, opener })
        })
        .collect())
}

/// Runs `js` in a browser webview as the app does when it evaluates script: WebKit treats it as a user gesture, so a
/// probe page's `click()` may open a pop-up (pages may not open one on their own).
#[tauri::command]
pub fn selftest_browser_eval(app: AppHandle, core: State<'_, Arc<Core>>, id: String, js: String) -> Result<(), String> {
    active(&core)?;
    if !id.starts_with(crate::browser::PREFIX) {
        return Err("not a browser webview".into());
    }
    app.get_webview(&id).ok_or("no such webview")?.eval(&js).map_err(|e| e.to_string())
}

/// The agent cursors the page script draws on `chat`'s active Browser page now: `[{actor, who, say}]`.
#[tauri::command(async)]
pub fn selftest_page_cursors(core: State<'_, Arc<Core>>, devices: State<'_, Arc<crate::device::Devices>>, chat: usize) -> Result<serde_json::Value, String> {
    active(&core)?;
    crate::device::web::Browser::new(&devices, chat).presence_shown()
}

/// The same path as Cmd+Q (asks first when anything runs).
#[tauri::command]
pub fn selftest_request_quit(app: AppHandle, core: State<'_, Arc<Core>>) -> Result<(), String> {
    active(&core)?;
    crate::request_quit(&app);
    Ok(())
}

#[derive(Serialize)]
pub struct PreviewProbe {
    label: String,
    /// The artifact URL it shows.
    url: String,
    /// The window's title.
    title: String,
    /// The host page's document title (the self-test's scripts report through it).
    page_title: String,
    /// Where the host page is (a `data:` URL; only its first characters).
    page_url: String,
    /// Outer frame, logical points: [x, y, w, h].
    frame: Option<[f64; 4]>,
    visible: bool,
    /// macOS: a child window of the main window.
    child_of_main: Option<bool>,
    /// The main window's outer frame, for checking the preview is centred on it.
    main_frame: Option<[f64; 4]>,
}

/// The open artifact preview windows.
#[tauri::command(async)]
pub fn selftest_previews(app: AppHandle, core: State<'_, Arc<Core>>) -> Result<Vec<PreviewProbe>, String> {
    active(&core)?;
    let open = core.previews.windows.lock().unwrap().clone();
    let main = app.get_window("main");
    let main_ns = main.as_ref().and_then(|m| m.ns_window().ok()).map(|p| p as usize);
    let main_frame = main.as_ref().and_then(|m| {
        let scale = m.scale_factor().ok()?;
        let p = m.outer_position().ok()?.to_logical::<f64>(scale);
        let s = m.outer_size().ok()?.to_logical::<f64>(scale);
        Some([p.x, p.y, s.width, s.height])
    });
    let mut out = Vec::new();
    for (url, (label, _)) in open {
        let Some(w) = app.get_webview_window(&label) else { continue };
        let scale = w.scale_factor().unwrap_or(1.0);
        let frame = (|| {
            let p = w.outer_position().ok()?.to_logical::<f64>(scale);
            let s = w.outer_size().ok()?.to_logical::<f64>(scale);
            Some([p.x, p.y, s.width, s.height])
        })();
        let (tx, rx) = std::sync::mpsc::channel();
        let l = label.clone();
        let _ = w.with_webview(move |pw| {
            #[cfg(target_os = "macos")]
            let _ = tx.send(Some(crate::browser::native::state(pw.inner(), l)));
            #[cfg(not(target_os = "macos"))]
            let _ = (tx.send(None), pw, l);
        });
        let st = rx.recv_timeout(std::time::Duration::from_secs(3)).ok().flatten();
        let child_of_main = w.ns_window().ok().map(|ns| parent_window(ns) == main_ns);
        out.push(PreviewProbe {
            title: w.title().unwrap_or_default(),
            page_title: st.as_ref().map(|s| s.title.clone()).unwrap_or_default(),
            page_url: st.map(|s| s.url.chars().take(40).collect()).unwrap_or_default(),
            visible: w.is_visible().unwrap_or(false),
            frame,
            child_of_main,
            main_frame,
            label,
            url,
        });
    }
    Ok(out)
}

/// `-[NSWindow parentWindow]`, by address.
#[cfg(target_os = "macos")]
fn parent_window(ns: *mut std::ffi::c_void) -> Option<usize> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    if ns.is_null() {
        return None;
    }
    // SAFETY: `ns` is a live NSWindow owned by Tauri; `parentWindow` is a plain getter.
    let p: *mut AnyObject = unsafe { msg_send![&*(ns as *mut AnyObject), parentWindow] };
    (!p.is_null()).then_some(p as usize)
}

#[cfg(not(target_os = "macos"))]
fn parent_window(_ns: *mut std::ffi::c_void) -> Option<usize> {
    None
}

/// Runs `js` in a preview window's host page (the top frame, where Tauri's own script and its invoke key live; the
/// artifact's sandboxed frame is one level down). `ipc_probe`: the IPC probe of the browser scenario is defined first.
#[tauri::command]
pub fn selftest_preview_eval(app: AppHandle, core: State<'_, Arc<Core>>, label: String, js: String, ipc_probe: bool) -> Result<(), String> {
    active(&core)?;
    if !label.starts_with(crate::artifact::PREVIEW_PREFIX) {
        return Err("not a preview window".into());
    }
    let js = if ipc_probe { format!("{IPC_PROBE}\n{js}") } else { js };
    app.get_webview_window(&label).ok_or("no such window")?.eval(&js).map_err(|e| e.to_string())
}

/// Closes a preview window, as its close button does.
#[tauri::command]
pub fn selftest_close_preview(app: AppHandle, core: State<'_, Arc<Core>>, label: String) -> Result<(), String> {
    active(&core)?;
    if !label.starts_with(crate::artifact::PREVIEW_PREFIX) {
        return Err("not a preview window".into());
    }
    app.get_webview_window(&label).ok_or("no such window")?.close().map_err(|e| e.to_string())
}

/// A real (trusted) mouse click at the centre of browser webview `id`: a left mouse down and up sent to the main
/// window as AppKit events (`-[NSWindow sendEvent:]`: nothing is posted to the system and the pointer doesn't move).
/// A page script's own `click()` isn't trusted, and WebKit won't follow a `target=_blank` link for it.
#[tauri::command(async)]
pub fn selftest_click(app: AppHandle, core: State<'_, Arc<Core>>, id: String) -> Result<(), String> {
    active(&core)?;
    if !id.starts_with(crate::browser::PREFIX) {
        return Err("not a browser webview".into());
    }
    let w = app.get_webview(&id).ok_or("no such webview")?;
    let win = w.window();
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    let b = w.bounds().map_err(|e| e.to_string())?;
    let p = b.position.to_logical::<f64>(scale);
    let sz = b.size.to_logical::<f64>(scale);
    let (cx, cy) = (p.x + sz.width / 2.0, p.y + sz.height / 2.0);
    let ns = win.ns_window().map_err(|e| e.to_string())? as usize;
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(native_click(ns as *mut std::ffi::c_void, cx, cy));
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
fn native_click(ns: *mut std::ffi::c_void, x: f64, y: f64) -> Result<(), String> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::{NSPoint, NSRect};
    if ns.is_null() {
        return Err("no window".into());
    }
    // SAFETY: AppKit calls on the main thread (run_on_main_thread); `ns` is the live NSWindow; the event constructor
    // is called with its documented argument types.
    unsafe {
        let win = &*(ns as *mut AnyObject);
        let content: *mut AnyObject = msg_send![win, contentView];
        if content.is_null() {
            return Err("no content view".into());
        }
        let frame: NSRect = msg_send![&*content, frame];
        // Window coordinates have their origin at the bottom left.
        let at = NSPoint::new(x, frame.size.height - y);
        let number: isize = msg_send![win, windowNumber];
        let cls = AnyClass::get(c"NSEvent").ok_or("no NSEvent")?;
        // Now, on the event clock (system uptime): WebKit counts a click as a user activation only while it is fresh.
        let info: *mut AnyObject = msg_send![AnyClass::get(c"NSProcessInfo").ok_or("no NSProcessInfo")?, processInfo];
        let now: f64 = msg_send![&*info, systemUptime];
        // NSEventTypeLeftMouseDown, NSEventTypeLeftMouseUp.
        for kind in [1usize, 2] {
            let e: *mut AnyObject = msg_send![cls, mouseEventWithType: kind, location: at, modifierFlags: 0usize, timestamp: now, windowNumber: number, context: std::ptr::null_mut::<AnyObject>(), eventNumber: 0isize, clickCount: 1isize, pressure: 1.0f32];
            if e.is_null() {
                return Err("no event".into());
            }
            let _: () = msg_send![win, sendEvent: &*e];
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn native_click(_ns: *mut std::ffi::c_void, _x: f64, _y: f64) -> Result<(), String> {
    Err("macOS only".into())
}

/// A request to the sandbox Mac's guest agent, for a scenario's own setup and checks (apart from what the chat's
/// agent does through the `mac_*` tools).
#[tauri::command(async)]
pub fn selftest_mac(core: State<'_, Arc<Core>>, devices: State<'_, Arc<crate::device::Devices>>, request: serde_json::Value) -> Result<serde_json::Value, String> {
    active(&core)?;
    devices.vm.agent(&devices, request, std::time::Duration::from_secs(30))
}

/// The sandbox Mac's screen as the backend reads it (the accessibility tree, rendered as `mac_observe` does).
#[tauri::command(async)]
pub fn selftest_mac_screen(core: State<'_, Arc<Core>>, devices: State<'_, Arc<crate::device::Devices>>) -> Result<String, String> {
    active(&core)?;
    let tree = crate::device::vm::MacTools { d: &devices, chat: usize::MAX }.tree(true)?;
    Ok(crate::device::observe::render(&tree, "coool Mac"))
}
