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
//! - `COOOL_SELFTEST_SITE`: the base URL of a local test site for the `browser-settle` scenario (e.g.
//!   `http://127.0.0.1:8741/`, serving the pages that scenario names).
//! - `COOOL_SELFTEST_SHOTS_ONSCREEN=1`: shoot the window's rectangle on screen instead of the window alone, so the
//!   frosted glass shows what is behind it (the `glass` scenario).
//! - `COOOL_SELFTEST_SIZE`: the window's size in points, `<width>x<height>` (default `1440x900`), e.g. `1080x1920` for
//!   a portrait screen (the `portrait` scenario). A scenario can also resize later (`selftest_resize`).
//! - `COOOL_SELFTEST_WINDOW`: `quiet` (on top, never focused, no Dock icon) or `back` (never focused, behind the
//!   person's windows and off screen: checks that need no picture of the window, like `mac-cycles` and `mac-idle`)
//!   or `behind` (never focused, on screen but behind the person's windows: window-only shots of the glass with a
//!   window of the test's own just behind it).
//!
//! A run kept apart from the person's own data sets `HOME` to a throwaway folder too (the CLIs' `~/.claude` and
//! `~/.codex`, coool's app data), with `COOOL_VM_DIR` pointing at the one sandbox Mac when a scenario uses it.
//! - `COOOL_SELFTEST_BACKGROUND=1`: the window goes off screen, never on top or focused, and the app takes no Dock
//!   icon (window-alone screenshots still work), so a run leaves the person's screen and keyboard alone. coool doesn't
//!   activate at launch (as with the other switches), and artifact previews and browser pop-ups open unfocused. macOS
//!   keeps a sliver of the window on a display, so windows placed relative to it (previews) land on screen.
//!
//! The switches combine: OFFSCREEN wins over BACKGROUND, which wins over `COOOL_SELFTEST_WINDOW` (`WindowMode`).
//! - `COOOL_SELFTEST_OFFSCREEN=1`: keep the test out of sight: the window is fully transparent and lets every click
//!   through (macOS moves a window placed off screen back onto a display, so it is also placed as far out as macOS
//!   allows), never takes focus, coool doesn't activate at launch and has no Dock icon; WebKit is told not to treat
//!   the window as hidden, so the page renders as it would in front (the `perf-*` scenarios run this way).
//!   Screenshots of it come out blank.
//!
//! Every self-test asks WebKit for a web data store of its own (localStorage and the rest). An unbundled binary
//! gets WebKit's per-executable store whatever it asks (`~/Library/WebKit/<binary name>`), so run a copy with a
//! name of its own, and with `HOME` pointing at a throwaway folder so the session data it lists is not the
//! person's either (app/scripts/perf/run.sh does both).
//!
//! Settings (the insights and "runs by other tools" toggles) and the list of
//! sessions coool started are kept in the folder too, never in the real ones;
//! Codex chats introduce themselves as `coool-selftest`, so a later normal launch
//! never counts them as the person's.

pub mod film;

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
    site: Option<String>,
}

#[derive(Serialize)]
pub struct Config {
    scenario: String,
    dir: String,
    shots: String,
    site: Option<String>,
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
        let site = std::env::var("COOOL_SELFTEST_SITE").ok().filter(|s| !s.trim().is_empty());
        Some(Self { scenario: scenario.trim().to_string(), dir, canonical, shots, log, site })
    }

    /// The onboarding scenarios run: only then does the first-run onboarding show (`onboarding_seen`).
    pub fn wants_onboarding(&self) -> bool {
        self.scenario.split(',').any(|s| s.trim().starts_with("onboarding"))
    }

    /// An `update-launch*` scenario runs: only then may an update at launch restart (exit) the app.
    pub fn wants_update_launch(&self) -> bool {
        self.scenario.split(',').any(|s| s.trim().starts_with("update-launch"))
    }

    /// A `menubar*` scenario runs: only then does a self-test create the menu bar item (hidden even then).
    pub fn wants_menubar(&self) -> bool {
        self.scenario.split(',').any(|s| s.trim().starts_with("menubar"))
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

    /// A fixed size, so screenshots are comparable. `COOOL_SELFTEST_WINDOW`: unset, on top and focused (as before);
    /// `quiet`, on top but never focused (no Dock icon, never the active app: the person's typing stays theirs);
    /// `back`, never focused, behind the person's windows and off screen (checks that need no picture of the window);
    /// `behind`, the same but on screen (window-only shots of the glass, with a window of the test's own behind it).
    /// `COOOL_SELFTEST_OFFSCREEN=1`: invisible, click-through and unfocused (the `perf-*` scenarios).
    pub fn prepare_window(&self, app: &AppHandle) {
        let mode = std::env::var("COOOL_SELFTEST_WINDOW").unwrap_or_default();
        let quiet = self.quiet_window();
        // `get_window`, not `get_webview_window`: once the in-app browser adds a child webview, `main` is a window
        // with several webviews and no longer counts as a webview window.
        if let Some(w) = app.get_window("main") {
            let (width, height) = window_size(std::env::var("COOOL_SELFTEST_SIZE").ok().as_deref());
            // A size of its own may be taller than this Mac's screens (a portrait 1080 x 1920 on a 1080-tall display):
            // macOS would clamp it, so the test's window may be larger than the screen.
            #[cfg(target_os = "macos")]
            if std::env::var_os("COOOL_SELFTEST_SIZE").is_some() {
                if let Ok(ns) = w.ns_window() {
                    larger_than_screen(ns);
                }
            }
            let _ = w.set_size(tauri::LogicalSize::new(width, height));
            if offscreen() {
                #[cfg(target_os = "macos")]
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                if let Ok(ns) = w.ns_window() {
                    invisible(ns);
                }
                // A window nobody can see makes the app a candidate for App Nap (timers coalesced, a page's
                // setTimeout at ~1 Hz): hold it off for the run, so the numbers are those of a window in front.
                #[cfg(target_os = "macos")]
                {
                    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
                    let token = NSProcessInfo::processInfo().beginActivityWithOptions_reason(NSActivityOptions::UserInitiated | NSActivityOptions::LatencyCritical, &NSString::from_str("coool self-test"));
                    std::mem::forget(token);
                }
                let _ = w.set_position(OFFSCREEN);
                if let Some(v) = app.get_webview("main") {
                    let _ = v.with_webview(|pw| keep_visible(pw.inner()));
                }
                // Created hidden (see `adjust_config`): shown only now that nobody can see it.
                let _ = w.show();
                return;
            }
            // `COOOL_SELFTEST_BACKGROUND=1`: off screen and never focused, so a run doesn't take the person's screen
            // or keyboard (window-alone screenshots still work).
            if background() {
                place_background(&w);
                #[cfg(target_os = "macos")]
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                return;
            }
            let _ = w.center();
            let _ = w.set_always_on_top(mode == "quiet");
            if !quiet {
                let _ = w.set_focus();
            }
            if mode == "back" {
                // Off every screen as well as behind: nothing of it shows (the checks read the DOM and the Mac).
                let _ = w.set_position(tauri::LogicalPosition::new(-20000.0, -20000.0));
            }
            #[cfg(target_os = "macos")]
            if mode == "back" || mode == "behind" {
                order_back(&w);
            }
        }
    }

    /// The window must never take focus: `COOOL_SELFTEST_WINDOW` quiet, back or behind, `COOOL_SELFTEST_BACKGROUND=1`
    /// or `COOOL_SELFTEST_OFFSCREEN=1` (coool doesn't activate at launch, the window is created unfocused).
    pub fn quiet_window(&self) -> bool {
        current_mode() != WindowMode::Front
    }

    /// Tauri config changes for a self-test run: its own web data store, and the window off screen when asked.
    pub fn adjust_config(&self, c: &mut tauri::Config) {
        for w in c.app.windows.iter_mut() {
            w.data_store_identifier = Some(*b"coool-selftest!!");
            if background() && !offscreen() {
                // Created off screen, so it never shows at the centre of the screen first.
                w.center = false;
                w.focus = false;
                w.always_on_top = false;
                w.x = Some(BACKGROUND_POS.x);
                w.y = Some(BACKGROUND_POS.y);
            }
            if offscreen() {
                w.visible = false;
                w.focus = false;
                w.center = false;
                w.always_on_top = false;
                w.x = Some(OFFSCREEN.x);
                w.y = Some(OFFSCREEN.y);
            }
        }
    }

    pub(crate) fn log_line(&self, line: &str) {
        self.log(line);
    }

    fn log(&self, line: &str) {
        let stamp = chrono_like_now();
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&self.log) {
            let _ = writeln!(f, "{stamp} {line}");
        }
        eprintln!("[selftest] {line}");
    }
}

/// Where the window goes with `COOOL_SELFTEST_OFFSCREEN=1`: far left of every display.
const OFFSCREEN: tauri::LogicalPosition<f64> = tauri::LogicalPosition { x: -30000.0, y: 200.0 };

/// `COOOL_SELFTEST_OFFSCREEN=1` (and a build where the self-test can run at all).
/// The window size a run starts at: `COOOL_SELFTEST_SIZE` as `<width>x<height>` in points, else 1440 x 900. Anything
/// unreadable or out of range (under 400 or over 8000 a side) falls back to the default.
fn window_size(v: Option<&str>) -> (f64, f64) {
    const DEFAULT: (f64, f64) = (1440.0, 900.0);
    let Some((w, h)) = v.map(str::trim).and_then(|v| v.split_once(['x', 'X'])) else {
        return DEFAULT;
    };
    match (w.trim().parse::<f64>(), h.trim().parse::<f64>()) {
        (Ok(w), Ok(h)) if (400.0..=8000.0).contains(&w) && (400.0..=8000.0).contains(&h) => (w, h),
        _ => DEFAULT,
    }
}

pub fn offscreen() -> bool {
    cfg!(debug_assertions) && std::env::var("COOOL_SELFTEST_OFFSCREEN").is_ok_and(|v| v == "1")
}

/// Where the window goes with `COOOL_SELFTEST_BACKGROUND=1`.
const BACKGROUND_POS: tauri::LogicalPosition<f64> = tauri::LogicalPosition { x: -4000.0, y: -3000.0 };

/// Where `COOOL_SELFTEST_BACKGROUND=1` puts the window. Normally far off screen, where macOS keeps a sliver of it on a
/// display (window-alone screenshots need that). A window allowed to be larger than its screen (`COOOL_SELFTEST_SIZE`,
/// `larger_than_screen`) is not pulled back, so it is placed with an 8-point sliver at the right edge of the rightmost
/// display (nothing lies beyond it), level with that display's top.
fn place_background(w: &tauri::Window) {
    if std::env::var_os("COOOL_SELFTEST_SIZE").is_none() {
        let _ = w.set_position(BACKGROUND_POS);
        return;
    }
    let right = w.available_monitors().unwrap_or_default().into_iter().map(|m| {
        let s = m.scale_factor();
        let p = m.position().to_logical::<f64>(s);
        let z = m.size().to_logical::<f64>(s);
        (p.x + z.width, p.y)
    });
    match right.fold(None, |best: Option<(f64, f64)>, r| if best.is_none_or(|b| r.0 > b.0) { Some(r) } else { best }) {
        Some((x, y)) => {
            let _ = w.set_position(tauri::LogicalPosition::new(x - 8.0, y + 40.0));
        }
        None => {
            let _ = w.set_position(BACKGROUND_POS);
        }
    }
}

/// `COOOL_SELFTEST_BACKGROUND=1` (and a build where the self-test can run at all).
fn background() -> bool {
    cfg!(debug_assertions) && std::env::var("COOOL_SELFTEST_BACKGROUND").is_ok_and(|v| v == "1")
}

/// How a self-test window behaves (the three switches combined; the most hidden one wins when several are set).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowMode {
    /// None set: centred, on top and focused (as before).
    Front,
    /// `COOOL_SELFTEST_WINDOW=quiet`: on top, never focused.
    Quiet,
    /// `COOOL_SELFTEST_WINDOW=behind`: on screen behind the person's windows, never focused.
    Behind,
    /// `COOOL_SELFTEST_WINDOW=back`: off screen and behind, never focused.
    Back,
    /// `COOOL_SELFTEST_BACKGROUND=1`: off screen, never on top or focused.
    Background,
    /// `COOOL_SELFTEST_OFFSCREEN=1`: invisible, click-through, never focused.
    Offscreen,
}

fn window_mode(window: Option<&str>, background: bool, offscreen: bool) -> WindowMode {
    if offscreen {
        return WindowMode::Offscreen;
    }
    if background {
        return WindowMode::Background;
    }
    match window {
        Some("quiet") => WindowMode::Quiet,
        Some("back") => WindowMode::Back,
        Some("behind") => WindowMode::Behind,
        _ => WindowMode::Front,
    }
}

/// Whether a window coool opens itself (an artifact preview, a browser pop-up) may take focus: always, except in a
/// self-test run whose window must not (they would otherwise come up in front of the person's apps, focused).
pub fn windows_may_focus() -> bool {
    !cfg!(debug_assertions) || std::env::var_os("COOOL_SELFTEST").is_none() || current_mode() == WindowMode::Front
}

fn current_mode() -> WindowMode {
    window_mode(std::env::var("COOOL_SELFTEST_WINDOW").ok().as_deref(), background(), offscreen())
}

/// WebKit takes an occluded or off-screen window as hidden (page visibility, throttled timers and animations);
/// a self-test out of sight must render as if in front.
#[cfg(target_os = "macos")]
fn keep_visible(wk: *mut std::ffi::c_void) {
    use std::ffi::{c_char, c_void};
    unsafe extern "C" {
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    if wk.is_null() {
        return;
    }
    // SAFETY: the live WKWebView on the main thread; the private setter is checked with respondsToSelector: and takes
    // one BOOL. objc_msgSend is called through function pointers of the exact signatures.
    unsafe {
        let sel = sel_registerName(c"_setWindowOcclusionDetectionEnabled:".as_ptr());
        let responds: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> bool = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        if responds(wk, sel_registerName(c"respondsToSelector:".as_ptr()), sel) {
            let set: unsafe extern "C" fn(*mut c_void, *mut c_void, bool) = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            set(wk, sel, false);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn keep_visible(_wk: *mut std::ffi::c_void) {}

/// `COOOL_SELFTEST_SIZE`: lets the window be larger than its screen (as Electron's `enableLargerThanScreen`), by making
/// `-[NSWindow constrainFrameRect:toScreen:]` hand the frame back unchanged for the window's class. Only a self-test
/// process does this, and only when it asked for a size of its own.
#[cfg(target_os = "macos")]
fn larger_than_screen(ns: *mut std::ffi::c_void) {
    use std::ffi::{c_char, c_void};
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }
    unsafe extern "C" {
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn object_getClass(obj: *mut c_void) -> *mut c_void;
        fn class_replaceMethod(cls: *mut c_void, name: *mut c_void, imp: *const c_void, types: *const c_char) -> *const c_void;
    }
    extern "C" fn unconstrained(_this: *mut c_void, _sel: *mut c_void, frame: Rect, _screen: *mut c_void) -> Rect {
        frame
    }
    if ns.is_null() {
        return;
    }
    // SAFETY: the live NSWindow on the main thread (setup runs there). The replacement has the method's exact
    // signature (self, _cmd, NSRect, NSScreen*) -> NSRect, with the matching type encoding.
    unsafe {
        let cls = object_getClass(ns);
        let sel = sel_registerName(c"constrainFrameRect:toScreen:".as_ptr());
        class_replaceMethod(cls, sel, unconstrained as *const c_void, c"{CGRect={CGPoint=dd}{CGSize=dd}}@:{CGRect={CGPoint=dd}{CGSize=dd}}@".as_ptr());
    }
}

/// Fully transparent, no shadow, clicks pass through: the window renders but shows nothing.
#[cfg(target_os = "macos")]
fn invisible(ns: *mut std::ffi::c_void) {
    use std::ffi::{c_char, c_void};
    unsafe extern "C" {
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    if ns.is_null() {
        return;
    }
    // SAFETY: the live NSWindow on the main thread (setup runs there); public setters taking a CGFloat / BOOL,
    // called through function pointers of the exact signatures.
    unsafe {
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void, f64) = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        f(ns, sel_registerName(c"setAlphaValue:".as_ptr()), 0.0);
        let b: unsafe extern "C" fn(*mut c_void, *mut c_void, bool) = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        b(ns, sel_registerName(c"setIgnoresMouseEvents:".as_ptr()), true);
        b(ns, sel_registerName(c"setHasShadow:".as_ptr()), false);
    }
}

#[cfg(not(target_os = "macos"))]
fn invisible(_ns: *mut std::ffi::c_void) {}

fn chrono_like_now() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("{}.{:03}", ms / 1000, ms % 1000)
}

/// No screen captures: `COOOL_SELFTEST_NOSHOTS=1`, or any run inside an app bundle.
fn no_shots() -> bool {
    std::env::var("COOOL_SELFTEST_NOSHOTS").is_ok_and(|v| v == "1") || crate::notify::bundled()
}

fn active(core: &Core) -> Result<&SelfTest, String> {
    core.selftest.as_ref().ok_or_else(|| "self-test mode is off".to_string())
}

/// `null` unless self-test mode is on (so the frontend stays inert otherwise).
#[tauri::command]
pub fn selftest_config(core: State<'_, Arc<Core>>) -> Option<Config> {
    let t = core.selftest.as_ref()?;
    Some(Config { scenario: t.scenario.clone(), dir: t.dir.to_string_lossy().into_owned(), shots: t.shots.to_string_lossy().into_owned(), site: t.site.clone() })
}

#[tauri::command(async)]
pub fn selftest_log(core: State<'_, Arc<Core>>, line: String) -> Result<(), String> {
    active(&core)?.log(&line);
    Ok(())
}

/// A chat's launch, for the `ladder` scenario: the arguments coool started its CLI with, and the running process's
/// own command line (`ps`), so the check is against what really runs.
#[derive(Serialize)]
pub struct ChatLaunch {
    args: Vec<String>,
    ps: String,
    pid: Option<u32>,
}

#[tauri::command(async)]
pub fn selftest_chat_launch(core: State<'_, Arc<Core>>, chat: usize) -> Result<ChatLaunch, String> {
    active(&core)?;
    let (args, pid) = {
        let hub = core.hub.lock().unwrap();
        let c = hub.chat(chat).ok_or("no such chat")?;
        (c.launch_args().to_vec(), c.pid)
    };
    let ps = pid
        .and_then(|p| std::process::Command::new("ps").args(["-ww", "-o", "args=", "-p", &p.to_string()]).output().ok())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    Ok(ChatLaunch { args, ps, pid })
}

/// The `ladder2` scenario's probes (APP_SPEC "Ladder"): `files` lists the files under the run's folder (relative path,
/// bytes, and a PNG's pixel size); `tool` calls a `coool-ladder` tool as chat `chat` would over MCP (its refusals and
/// the budget's answer are checked without a model turn); `env` is a chat CLI process's environment entries that
/// Ladder sets (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`), read with `ps eww`.
#[tauri::command(async)]
pub fn selftest_ladder(core: State<'_, Arc<Core>>, action: String, chat: Option<usize>, name: Option<String>, args: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let t = active(&core)?;
    match action.as_str() {
        "files" => {
            let mut out = Vec::new();
            let mut stack = vec![t.dir.clone()];
            while let Some(d) = stack.pop() {
                for e in std::fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
                    let p = e.path();
                    let n = e.file_name().to_string_lossy().into_owned();
                    if n.starts_with('.') || n == "selftest.log" {
                        continue;
                    }
                    if p.is_dir() {
                        stack.push(p);
                        continue;
                    }
                    let bytes = std::fs::read(&p).unwrap_or_default();
                    let png = (bytes.len() > 24 && bytes.starts_with(b"\x89PNG")).then(|| (u32::from_be_bytes(bytes[16..20].try_into().unwrap()), u32::from_be_bytes(bytes[20..24].try_into().unwrap())));
                    out.push(serde_json::json!({ "path": p.strip_prefix(&t.dir).unwrap_or(&p).to_string_lossy(), "bytes": bytes.len(), "png": png }));
                }
            }
            Ok(serde_json::Value::Array(out))
        }
        "tool" => {
            let chat = chat.ok_or("chat is required")?;
            Ok(match crate::ladder::call(core.inner(), chat, name.as_deref().unwrap_or(""), &args.unwrap_or_default()) {
                Ok(v) => serde_json::json!({ "ok": true, "value": v }),
                Err(e) => serde_json::json!({ "ok": false, "error": e }),
            })
        }
        "env" => {
            let pid = core.hub.lock().unwrap().chat(chat.ok_or("chat is required")?).and_then(|c| c.pid).ok_or("no pid")?;
            let o = std::process::Command::new("ps").args(["eww", "-o", "command=", "-p", &pid.to_string()]).output().map_err(|e| e.to_string())?;
            let s = String::from_utf8_lossy(&o.stdout).into_owned();
            let v: Vec<&str> = s.split_whitespace().filter(|w| w.starts_with("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=")).collect();
            Ok(serde_json::json!(v))
        }
        _ => Err(format!("unknown action {action}")),
    }
}

/// The keep-alive scenarios (app/src/selftestKeepalive.ts; APP_SPEC "Chats that outlive the app"):
/// - `pids`: this app's pid, the chat hosts it is connected to, and every chat (id, CLI pid, hosted, running, cwd).
/// - `alive`: whether process `pid` exists (the CLI after a quit, from the next launch).
/// - `note_set` / `note_get`: a small JSON value kept in the test folder across launches (`keepalive-notes.json`).
#[tauri::command(async)]
pub fn selftest_keepalive(core: State<'_, Arc<Core>>, action: String, pid: Option<u32>, key: Option<String>, value: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let t = active(&core)?;
    let notes = t.dir.join("keepalive-notes.json");
    let read = || std::fs::read(&notes).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()).unwrap_or_else(|| serde_json::json!({}));
    match action.as_str() {
        "pids" => {
            let hub = core.hub.lock().unwrap();
            let chats: Vec<serde_json::Value> = hub
                .chats()
                .iter()
                .map(|i| {
                    let c = hub.chat(i.id);
                    serde_json::json!({ "id": i.id, "pid": c.and_then(|c| c.pid), "hosted": c.is_some_and(|c| c.is_hosted()), "running": i.running, "cwd": i.cwd, "session_id": i.session_id })
                })
                .collect();
            drop(hub);
            Ok(serde_json::json!({ "app": std::process::id(), "hosts": crate::chathost::host_pids(&core), "chats": chats, "keep": core.keep_chats.load(std::sync::atomic::Ordering::Relaxed) }))
        }
        "alive" => {
            let p = pid.ok_or("pid is required")?;
            // SAFETY: signal 0 only checks whether the process exists.
            Ok(serde_json::json!(p > 0 && unsafe { libc::kill(p as i32, 0) } == 0))
        }
        "note_set" => {
            let mut v = read();
            v[key.ok_or("key is required")?] = value.unwrap_or_default();
            std::fs::write(&notes, serde_json::to_vec_pretty(&v).unwrap_or_default()).map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "note_get" => Ok(read()[key.ok_or("key is required")?].clone()),
        _ => Err(format!("unknown action {action}")),
    }
}

/// Counters and resource use for the `perf-*` scenarios (see `crate::perf`).
#[derive(Serialize)]
pub struct PerfStats {
    now_ms: u64,
    /// When this process started, epoch ms.
    process_start_ms: u64,
    first_publish_ms: u64,
    loaded_ms: u64,
    app: Option<crate::perf::ProcStats>,
    /// The main webview's WebKit content process, and the GPU process (when WebKit says which).
    web: Option<crate::perf::ProcStats>,
    gpu: Option<crate::perf::ProcStats>,
    refreshes: u64,
    publishes: u64,
    publish_bytes: u64,
    chat_batches: u64,
    pty_chunks: u64,
    git_trails: u64,
    git_spawns: u64,
    context_maps: u64,
    /// Start-up points (see `crate::perf::boot_mark`): name, epoch ms.
    boot: Vec<(&'static str, u64)>,
}

#[tauri::command(async)]
pub fn selftest_perf_stats(app: AppHandle, core: State<'_, Arc<Core>>) -> Result<PerfStats, String> {
    use crate::perf::*;
    use std::sync::atomic::Ordering::Relaxed;
    active(&core)?;
    let me = std::process::id();
    let (mut web, mut gpu) = (None, None);
    if let Some(w) = app.get_webview("main") {
        let (tx, rx) = std::sync::mpsc::channel();
        let _ = w.with_webview(move |pw| {
            let _ = tx.send(web_pids(pw.inner()));
        });
        if let Ok((a, b)) = rx.recv_timeout(std::time::Duration::from_secs(3)) {
            web = a.and_then(proc_stats);
            gpu = b.and_then(proc_stats);
        }
    }
    Ok(PerfStats {
        now_ms: now_ms(),
        process_start_ms: coool_core::util::process_start_ms(me).unwrap_or(0),
        first_publish_ms: FIRST_PUBLISH_MS.load(Relaxed),
        loaded_ms: LOADED_MS.load(Relaxed),
        app: proc_stats(me as i32),
        web,
        gpu,
        refreshes: REFRESHES.load(Relaxed),
        publishes: PUBLISHES.load(Relaxed),
        publish_bytes: PUBLISH_BYTES.load(Relaxed),
        chat_batches: CHAT_BATCHES.load(Relaxed),
        pty_chunks: PTY_CHUNKS.load(Relaxed),
        git_trails: GIT_TRAILS.load(Relaxed),
        git_spawns: coool_core::gitlog::SPAWNS.load(Relaxed),
        context_maps: CONTEXT_MAPS.load(Relaxed),
        boot: BOOT.lock().map(|b| b.clone()).unwrap_or_default(),
    })
}

/// The WKWebView's content and GPU process ids (private WebKit properties, checked before use).
#[cfg(target_os = "macos")]
fn web_pids(wk: *mut std::ffi::c_void) -> (Option<i32>, Option<i32>) {
    use std::ffi::{c_char, c_void};
    unsafe extern "C" {
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    if wk.is_null() {
        return (None, None);
    }
    let get = |name: &std::ffi::CStr| -> Option<i32> {
        // SAFETY: the live WKWebView, on the main thread (with_webview runs there). The selector is checked with
        // `respondsToSelector:` first; both getters take no arguments and return a pid_t. objc_msgSend is called
        // through a function pointer of the exact signature.
        unsafe {
            let sel = sel_registerName(name.as_ptr());
            let responds: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> bool = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            if !responds(wk, sel_registerName(c"respondsToSelector:".as_ptr()), sel) {
                return None;
            }
            let f: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32 = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            Some(f(wk, sel)).filter(|p| *p > 0)
        }
    };
    (get(c"_webProcessIdentifier"), get(c"_gpuProcessIdentifier"))
}

#[cfg(not(target_os = "macos"))]
fn web_pids(_wk: *mut std::ffi::c_void) -> (Option<i32>, Option<i32>) {
    (None, None)
}

/// Screenshot of the app window alone into `<shots>/real-<name>.png`.
///
/// Captures by window id (`screencapture -l`), so only coool's own window is
/// recorded, even when other windows overlap it: nothing else on the screen
/// can end up in a screenshot.
#[tauri::command(async)]
pub fn selftest_shot(app: AppHandle, core: State<'_, Arc<Core>>, name: String, window: Option<String>) -> Result<String, String> {
    let t = active(&core)?;
    // A bundled build (the `coool selftest` app) never captures the screen: each new ad-hoc signature would make
    // macOS ask the person for Screen Recording again. `COOOL_SELFTEST_NOSHOTS=1` turns shots off for any run.
    if no_shots() {
        return Err("screenshots are off in this run".into());
    }
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

/// The menu bar item, as the `menubar` scenario checks it (menubar/mod.rs `selftest`): its state, the menu as built,
/// a click on one of its rows, its readings next to `top`, `vm_stat` and `df`.
#[tauri::command(async)]
pub fn selftest_menubar(core: State<'_, Arc<Core>>, action: String, arg: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    active(&core)?;
    crate::menubar::selftest(&action, arg.unwrap_or(serde_json::Value::Null))
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

/// `-[NSWindow orderBack:nil]`: behind every other window of its level.
#[cfg(target_os = "macos")]
fn order_back(w: &tauri::Window) {
    use std::ffi::{c_char, c_void};
    unsafe extern "C" {
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    let Ok(ns) = w.ns_window() else { return };
    if ns.is_null() {
        return;
    }
    // SAFETY: `ns` is a live NSWindow owned by Tauri, on the main thread (setup); `orderBack:` takes one object
    // argument (nil) and returns nothing.
    unsafe {
        let sel = sel_registerName(c"orderBack:".as_ptr());
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        f(ns, sel, std::ptr::null_mut());
    }
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
/// `windowed` (leaves full screen and goes back on top), `hide` (ordered out: the page goes hidden and loses focus, as
/// when the person is in another app) and `show` (back, in front and focused). With any of the window switches
/// (`COOOL_SELFTEST_WINDOW`, `_BACKGROUND`, `_OFFSCREEN`) `focus` does nothing and `show` only orders the window back
/// where its switch keeps it: a test window never takes the person's focus.
#[tauri::command]
pub fn selftest_window(app: AppHandle, core: State<'_, Arc<Core>>, action: String) -> Result<(), String> {
    active(&core)?;
    let w = app.get_window("main").ok_or("no window")?;
    let mode = current_mode();
    let r = match (action.as_str(), mode) {
        // A window that must not take focus never does (any of the three switches), and `show` puts it back where its
        // switch keeps it: only a plain run is brought in front and focused.
        ("focus", WindowMode::Front) => w.set_focus(),
        ("focus", _) => Ok(()),
        ("fullscreen", _) => w.set_always_on_top(false).and_then(|_| w.set_fullscreen(true)),
        ("windowed", m) => w.set_fullscreen(false).and_then(|_| w.set_always_on_top(matches!(m, WindowMode::Front | WindowMode::Quiet))),
        ("hide", _) => w.hide(),
        // As the person would leave it: minimised to the Dock, or the whole app hidden (⌘H).
        ("minimize", _) => w.minimize(),
        #[cfg(target_os = "macos")]
        ("app-hide", _) => app.hide(),
        ("show", WindowMode::Front) => w.show().and_then(|_| w.set_always_on_top(true)).and_then(|_| w.set_focus()),
        ("show", m) => {
            let r = w.show();
            #[cfg(target_os = "macos")]
            if matches!(m, WindowMode::Back | WindowMode::Behind) {
                order_back(&w);
            }
            let _ = m;
            r
        }
        _ => return Err(format!("unknown action {action}")),
    };
    r.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn selftest_resize(app: AppHandle, core: State<'_, Arc<Core>>, width: f64, height: f64) -> Result<(), String> {
    active(&core)?;
    let w = app.get_window("main").ok_or("no window")?;
    w.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    // `COOOL_SELFTEST_BACKGROUND=1`: placed again, so macOS keeps its sliver of the resized window on a display. A
    // window pushed wholly off screen counts as hidden to WebKit, and its animations stop finishing (the onboarding's
    // step transitions then never complete).
    if background() && !offscreen() {
        place_background(&w);
    }
    Ok(())
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

/// How many sandbox Mac installs were requested this run. A self-test never installs for real
/// (`device::vm::stub_install`): this is what the onboarding scenario checks instead.
#[tauri::command]
pub fn selftest_mac_install_requests(core: State<'_, Arc<Core>>) -> Result<u64, String> {
    active(&core)?;
    Ok(crate::device::vm::install_requests())
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

/// How many click outlines and press rings the page script draws on `chat`'s active Browser page now.
#[tauri::command(async)]
pub fn selftest_page_marks(core: State<'_, Arc<Core>>, devices: State<'_, Arc<crate::device::Devices>>, chat: usize) -> Result<u64, String> {
    active(&core)?;
    crate::device::web::Browser::new(&devices, chat).presence_marks()
}

/// One `browser_*` tool called directly on `chat`'s Browser panel, as the chat's agent would through the MCP server
/// (the gate included), without a model: the `browser-settle` scenario. `save`: each image of the result is written to
/// `<shots>/<save>.jpg` (n > 0: `<save>-<n>.jpg`) and replaced by its path.
#[tauri::command(async)]
pub fn selftest_browser_tool(core: State<'_, Arc<Core>>, devices: State<'_, Arc<crate::device::Devices>>, chat: usize, name: String, args: serde_json::Value, save: Option<String>) -> Result<Vec<serde_json::Value>, String> {
    use base64::Engine;
    let t = active(&core)?;
    let mut out = crate::device::web::Browser::new(&devices, chat).call(&name, &args)?;
    let mut n = 0;
    for v in out.iter_mut() {
        if v["type"] != "image" {
            continue;
        }
        let Some(stem) = save.as_deref() else { continue };
        let stem: String = stem.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
        let path = t.shots.join(if n == 0 { format!("{stem}.jpg") } else { format!("{stem}-{n}.jpg") });
        n += 1;
        let bytes = base64::engine::general_purpose::STANDARD.decode(v["data"].as_str().unwrap_or("")).map_err(|e| e.to_string())?;
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        *v = serde_json::json!({ "type": "image", "path": path.to_string_lossy() });
    }
    Ok(out)
}

/// `pilot_run` called directly for `chat`, as its agent would through the MCP server (the gate included), without
/// the chat's own model: repeated pilot runs (`pilot-mac-direct`) cost only the pilot's Haiku decisions.
#[tauri::command(async)]
pub fn selftest_pilot(core: State<'_, Arc<Core>>, devices: State<'_, Arc<crate::device::Devices>>, chat: usize, args: serde_json::Value) -> Result<String, String> {
    active(&core)?;
    crate::device::pilot::call(&devices, chat, &args)
}

/// A request to the sandbox Mac's host helper (`ocr`, `screenshot`, …): what the screen shows, read outside the guest.
#[tauri::command(async)]
pub fn selftest_vm(core: State<'_, Arc<Core>>, devices: State<'_, Arc<crate::device::Devices>>, request: serde_json::Value) -> Result<serde_json::Value, String> {
    active(&core)?;
    devices.vm.call(&devices, request, std::time::Duration::from_secs(30))
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

/// The worst case for the IPC: the self-test artifact's page loaded as the *top* frame of a webview other than
/// `main`, so its origin is local (`coool-artifact://`, as every custom scheme is) and Tauri's script and invoke key
/// are in it. `kind`: `window` (a window labelled like a preview, `preview-selftest-local`) or `child` (a child webview
/// of the main window labelled like a browser tab, `browser-selftest-local`). Runs [`IPC_PROBE`] there and returns
/// its result (JSON); the webview is destroyed afterwards. Every command must be refused: only `main` is granted any.
#[tauri::command(async)]
pub fn selftest_local_ipc(app: AppHandle, core: State<'_, Arc<Core>>, url: String, kind: String) -> Result<String, String> {
    active(&core)?;
    let (_, src) = crate::artifact::mint(&core, &url)?;
    let src = tauri::webview::Url::parse(&src.ok_or("the artifact's local copy is gone")?).map_err(|e| e.to_string())?;
    let label = match kind.as_str() {
        "window" => format!("{}selftest-local", crate::artifact::PREVIEW_PREFIX),
        "child" => format!("{}selftest-local", crate::browser::PREFIX),
        _ => return Err("kind: window or child".into()),
    };
    let webview: tauri::Webview = if kind == "window" {
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(src))
            .inner_size(400.0, 300.0)
            .focused(false)
            .incognito(true)
            .build()
            .map_err(|e| e.to_string())?
            .as_ref()
            .clone()
    } else {
        let main = app.get_window("main").ok_or("no main window")?;
        main.add_child(tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(src)).incognito(true), tauri::LogicalPosition::new(0.0, 0.0), tauri::LogicalSize::new(2.0, 2.0))
            .map_err(|e| e.to_string())?
    };
    let title = |w: &tauri::Webview| {
        let (tx, rx) = std::sync::mpsc::channel();
        let l = label.clone();
        let _ = w.with_webview(move |pw| {
            #[cfg(target_os = "macos")]
            let _ = tx.send(crate::browser::native::state(pw.inner(), l).title);
            #[cfg(not(target_os = "macos"))]
            let _ = (tx.send(String::new()), pw, l);
        });
        rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap_or_default()
    };
    // Wait for the page (its own title), then probe from its top frame.
    let end = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while title(&webview) != "Self-test probe" && std::time::Instant::now() < end {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let r = (|| {
        webview.eval(format!("{IPC_PROBE}\nipcProbe(\"local-{kind}\").then((r) => {{ document.title = \"ipc:\" + JSON.stringify(r); }});")).map_err(|e| e.to_string())?;
        let end = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let t = title(&webview);
            if let Some(r) = t.strip_prefix("ipc:") {
                return Ok(r.to_string());
            }
            if std::time::Instant::now() > end {
                return Err(format!("no probe result (title {t:?})"));
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    })();
    if kind == "window" {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.destroy();
        }
    } else {
        let _ = webview.close();
    }
    r
}

/// A file drag over the main webview as Tauri delivers the system's (`tauri://drag-enter` / `-over` / `-drop` /
/// `-leave` to the `main` webview, with the same payload: the paths and the physical position). `kind`: enter, over,
/// drop or leave. Nothing touches the system's drag pasteboard or the pointer.
#[tauri::command(async)]
pub fn selftest_drag(app: AppHandle, core: State<'_, Arc<Core>>, kind: String, paths: Vec<String>, x: f64, y: f64) -> Result<(), String> {
    use tauri::Emitter;
    active(&core)?;
    let target = tauri::EventTarget::Webview { label: "main".into() };
    let position = serde_json::json!({ "x": x, "y": y });
    let r = match kind.as_str() {
        "enter" => app.emit_to(target, "tauri://drag-enter", serde_json::json!({ "paths": paths, "position": position })),
        "over" => app.emit_to(target, "tauri://drag-over", serde_json::json!({ "position": position })),
        "drop" => app.emit_to(target, "tauri://drag-drop", serde_json::json!({ "paths": paths, "position": position })),
        "leave" => app.emit_to(target, "tauri://drag-leave", ()),
        _ => return Err("kind: enter, over, drop or leave".into()),
    };
    r.map_err(|e| e.to_string())
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

/// Real (trusted) input at a point of the main window, as the person's own mouse and keyboard give it: a left click
/// at `(x, y)` (window points from the top left, the page's client coordinates) when `click`, then each character of
/// `text` as a key down and up (lowercase letters, digits, space and Return), all sent to the window as AppKit events
/// (`-[NSWindow sendEvent:]`: nothing is posted to the system, the pointer doesn't move, and other apps get nothing).
#[tauri::command(async)]
pub fn selftest_native(app: AppHandle, core: State<'_, Arc<Core>>, x: f64, y: f64, click: bool, text: Option<String>) -> Result<(), String> {
    active(&core)?;
    let win = app.get_window("main").ok_or("no window")?;
    let ns = win.ns_window().map_err(|e| e.to_string())? as usize;
    let text = text.unwrap_or_default();
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let r = (if click { native_click(ns as *mut std::ffi::c_void, x, y) } else { Ok(()) }).and_then(|_| native_keys(ns as *mut std::ffi::c_void, x, y, &text));
        let _ = tx.send(r);
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?
}

/// The macOS virtual key code of a character the self-test types (US layout).
fn mac_key_code(c: char) -> Option<u16> {
    const LETTERS: [u16; 26] = [0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6];
    const DIGITS: [u16; 10] = [29, 18, 19, 20, 21, 23, 22, 26, 28, 25];
    match c {
        'a'..='z' => Some(LETTERS[c as usize - 'a' as usize]),
        '0'..='9' => Some(DIGITS[c as usize - '0' as usize]),
        ' ' => Some(49),
        '\n' => Some(36),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn native_keys(ns: *mut std::ffi::c_void, x: f64, y: f64, text: &str) -> Result<(), String> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::{NSPoint, NSRect, NSString};
    if text.is_empty() {
        return Ok(());
    }
    if ns.is_null() {
        return Err("no window".into());
    }
    // SAFETY: as in `native_click`: the main thread, the live NSWindow, the documented constructor's argument types.
    unsafe {
        let win = &*(ns as *mut AnyObject);
        let content: *mut AnyObject = msg_send![win, contentView];
        if content.is_null() {
            return Err("no content view".into());
        }
        let frame: NSRect = msg_send![&*content, frame];
        let at = NSPoint::new(x, frame.size.height - y);
        let number: isize = msg_send![win, windowNumber];
        let cls = AnyClass::get(c"NSEvent").ok_or("no NSEvent")?;
        let info: *mut AnyObject = msg_send![AnyClass::get(c"NSProcessInfo").ok_or("no NSProcessInfo")?, processInfo];
        for c in text.chars() {
            let code = mac_key_code(c).ok_or_else(|| format!("can't type {c:?}"))?;
            let s = if c == '\n' { "\r".to_string() } else { c.to_string() };
            let chars = NSString::from_str(&s);
            // NSEventTypeKeyDown, NSEventTypeKeyUp.
            for kind in [10usize, 11] {
                let now: f64 = msg_send![&*info, systemUptime];
                let e: *mut AnyObject = msg_send![cls, keyEventWithType: kind, location: at, modifierFlags: 0usize, timestamp: now, windowNumber: number, context: std::ptr::null_mut::<AnyObject>(), characters: &*chars, charactersIgnoringModifiers: &*chars, isARepeat: false, keyCode: code];
                if e.is_null() {
                    return Err("no event".into());
                }
                let _: () = msg_send![win, sendEvent: &*e];
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn native_keys(_ns: *mut std::ffi::c_void, _x: f64, _y: f64, _text: &str) -> Result<(), String> {
    Err("macOS only".into())
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

/// A `mac_*` tool called for `chat` as its agent calls it through the MCP server (the boot on first use and the gate
/// included): the text of its result. The `mac-cycles` and `mac-idle` scenarios.
#[tauri::command(async)]
pub fn selftest_mac_tool(core: State<'_, Arc<Core>>, devices: State<'_, Arc<crate::device::Devices>>, chat: usize, name: String, args: serde_json::Value) -> Result<String, String> {
    active(&core)?;
    let out = crate::device::vm::MacTools { d: &devices, chat }.call(&name, &args)?;
    Ok(out.iter().filter_map(|v| v["text"].as_str()).collect::<Vec<_>>().join("\n"))
}

/// The sandbox Mac's host helper: `pid` (its process id, or null) or `restart` (closes it as a quit does: it shuts the
/// guest down cleanly and exits; the next call starts a new one). The `mac-cycles` scenario.
#[tauri::command(async)]
pub fn selftest_vm_helper(core: State<'_, Arc<Core>>, devices: State<'_, Arc<crate::device::Devices>>, action: String) -> Result<serde_json::Value, String> {
    active(&core)?;
    match action.as_str() {
        "pid" => Ok(serde_json::json!(devices.vm.helper_pid())),
        "restart" => {
            devices.vm.quit();
            Ok(serde_json::Value::Null)
        }
        a => Err(format!("unknown action {a}")),
    }
}

/// Any `coool-device` tool (the iPhone's `tap`, `observe`, …) called for `chat` as its agent calls it over MCP: the
/// text of its result. The `beam-video` scenario drives the iPhone this way, without a model.
#[tauri::command(async)]
pub fn selftest_device_tool(core: State<'_, Arc<Core>>, devices: State<'_, Arc<crate::device::Devices>>, chat: usize, name: String, args: serde_json::Value) -> Result<String, String> {
    active(&core)?;
    let out = crate::device::mcp::call_tool(devices.inner(), chat, &name, &args)?;
    Ok(out.iter().filter_map(|v| v["text"].as_str()).collect::<Vec<_>>().join("\n"))
}

/// Notifications as macOS has them for this build (notify.rs): the permission, what is in Notification Center (each
/// with the target it carries), the delegate's log, and this process's id (a target's `pid`).
#[derive(Serialize)]
pub struct NotifyState {
    pid: u32,
    permission: crate::notify::Permission,
    delivered: Result<Vec<crate::notify::Delivered>, String>,
    log: Vec<String>,
}

#[tauri::command(async)]
pub fn selftest_notify(core: State<'_, Arc<Core>>) -> Result<NotifyState, String> {
    active(&core)?;
    Ok(NotifyState { pid: std::process::id(), permission: crate::notify::permission(), delivered: crate::notify::delivered(), log: crate::notify::log_lines() })
}

/// What a notification click does, without a hand on the mouse. `id`: a delivered notification of this build, whose
/// response goes to the center's delegate the way macOS sends a real click. `info`: a target's JSON, straight to the
/// click handler (a build without a bundle has no notification center). Returns how the click was delivered.
#[tauri::command(async)]
pub fn selftest_notify_click(core: State<'_, Arc<Core>>, id: Option<String>, info: Option<String>) -> Result<String, String> {
    active(&core)?;
    crate::notify::simulate_click(id.as_deref(), info.as_deref())
}

/// Posts a notification through the notifier's own path for chat `chat` (its title and session key as the pump has
/// them): `kind` "needs" (a permission request, `request` its id) or "finished" (a turn end). The window counts as not
/// in front for it. Clears every delivered and pending notification of this build when `kind` is "clear".
#[tauri::command(async)]
pub fn selftest_notify_post(core: State<'_, Arc<Core>>, chat: Option<usize>, kind: String, request: Option<String>) -> Result<(), String> {
    active(&core)?;
    use coool_core::chat::ChatEventKind;
    let ev = match kind.as_str() {
        "clear" => return crate::notify::remove_all(),
        "needs" => ChatEventKind::PermissionRequest { request_id: request.unwrap_or_else(|| "selftest".into()), tool: "Bash".into(), summary: "echo selftest".into(), input: serde_json::Value::Null, remember: vec![] },
        "finished" => ChatEventKind::TurnEnd { duration_ms: 1500, ok: true },
        _ => return Err("kind: needs | finished | clear".into()),
    };
    let chat = chat.ok_or("no chat")?;
    let (title, key) = core.chats.lock().unwrap().get(&chat).map(|c| (c.title.clone(), c.key.clone())).ok_or("no such chat")?;
    core.notifier.set_focused(false);
    core.notifier.on_event(chat, &title, key.as_deref(), &ev);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{window_mode, window_size, WindowMode};

    #[test]
    fn window_switches_combine() {
        // A plain run focuses as before.
        assert_eq!(window_mode(None, false, false), WindowMode::Front);
        assert_eq!(window_mode(Some(""), false, false), WindowMode::Front);
        assert_eq!(window_mode(Some("quiet"), false, false), WindowMode::Quiet);
        assert_eq!(window_mode(Some("back"), false, false), WindowMode::Back);
        assert_eq!(window_mode(Some("behind"), false, false), WindowMode::Behind);
        // BACKGROUND never takes focus either (it used to let coool activate at launch, and `show` focused it).
        assert_eq!(window_mode(None, true, false), WindowMode::Background);
        assert_eq!(window_mode(Some("quiet"), true, false), WindowMode::Background);
        // The most hidden switch wins.
        assert_eq!(window_mode(Some("behind"), true, true), WindowMode::Offscreen);
    }

    #[test]
    fn window_size_from_the_switch() {
        assert_eq!(window_size(None), (1440.0, 900.0));
        assert_eq!(window_size(Some("1080x1920")), (1080.0, 1920.0));
        assert_eq!(window_size(Some(" 1200X1920 ")), (1200.0, 1920.0));
        assert_eq!(window_size(Some("1440 x 2560")), (1440.0, 2560.0));
        // Unreadable or out of range: the default.
        assert_eq!(window_size(Some("portrait")), (1440.0, 900.0));
        assert_eq!(window_size(Some("1080")), (1440.0, 900.0));
        assert_eq!(window_size(Some("100x1920")), (1440.0, 900.0));
        assert_eq!(window_size(Some("1080x99999")), (1440.0, 900.0));
    }
}
