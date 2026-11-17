//! The in-app browser: web pages (claude.ai artifact links, links in chat) shown in the right panel, in a native
//! child webview of the main window laid exactly over the panel's content area (APP_SPEC "Browser panel").
//!
//! A child webview rather than an iframe: claude.ai (like most sites) refuses to be framed, and its pages need the
//! person's own claude.ai login, which they type into this webview once. Its cookies live in a data store of its
//! own (macOS 14+: a WebKit data store with a fixed identifier; elsewhere a `browser` folder in coool's data dir),
//! never the app's, and coool never reads them.
//!
//! Isolation (it shows remote content):
//! - Its label (`browser-<n>`) is in no capability (capabilities/default.json names the `main` webview, not the
//!   window, so child webviews of `main` inherit nothing), and its pages are remote origins, which Tauri refuses
//!   every command and plugin call unless a capability lists that origin under `remote`. None does.
//! - It only ever shows http(s) pages: the commands take nothing else, and navigations the page starts to any other
//!   scheme (`file:`, `javascript:`, `tauri:`, `ipc:`, `coool-artifact:`, app links …) or to the app's own origin
//!   (the dev server in `tauri dev`) are cancelled. `about:`, `blob:` and `data:` frames are allowed (they inherit
//!   or get an opaque origin, nothing local). Downloads are refused.
//! - Pop-ups (`window.open`, `target=_blank`) open as small windows of their own ([`open_popup`], labels
//!   `popup-<n>`), as in Safari: built from the configuration WebKit hands the UI delegate, so the pop-up shares the
//!   panel's data store and its page keeps `window.opener` (sign-in pop-ups such as Google's post their result back
//!   to the opener and close themselves). Same rules as the panel: no capability names them, http(s) only, downloads
//!   refused, desktop Safari user agent. They close with their opener webview (and with the main window).
//! - "Open in default browser" opens what the webview shows, re-validated, from Rust ([`browser_open_external`]);
//!   the opener plugin's JS scope stays `https://claude.ai/*`.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::webview::{NewWindowFeatures, NewWindowResponse, PageLoadEvent, Url, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Webview, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// Child webview labels start with this.
pub const PREFIX: &str = "browser-";
/// Pop-up windows opened by a browser page (window and webview share the label).
pub const POPUP_PREFIX: &str = "popup-";
/// A pop-up's size when the page asks for none (window.open's `width` / `height` features win).
const POPUP_SIZE: (f64, f64) = (500.0, 650.0);
/// The WebKit data store of the in-app browser (macOS 14+): 16 bytes read as a UUID, fixed so logins persist.
const DATA_STORE: [u8; 16] = *b"coool-browser-v1";
/// At most this many pages stay alive (hidden) across panels; the least recently shown one is closed beyond it.
const MAX_ALIVE: usize = 4;
/// A desktop Safari user agent: WebKit's default one lacks the `Version/… Safari/…` part, and some sign-in pages
/// refuse what looks like an embedded view.
#[cfg(target_os = "macos")]
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

#[derive(Default)]
pub struct Browsers {
    next: AtomicU32,
    /// label -> last time it was shown (an increasing counter), for [`MAX_ALIVE`].
    alive: Mutex<HashMap<String, u64>>,
    clock: AtomicU32,
    /// The app's own http origin in `tauri dev` (the dev server); never loaded in a browser webview.
    app_origin: Mutex<Option<String>>,
    /// Self-test only: what each webview was last told (visible, bounds), for checking it tracks the panel.
    pub(crate) placed: Mutex<HashMap<String, (bool, [f64; 4])>>,
    /// Open pop-up windows: label -> the label of the webview that opened it (a browser webview or a pop-up).
    pub(crate) popups: Mutex<HashMap<String, String>>,
    next_popup: AtomicU32,
}

impl Browsers {
    pub fn set_app_origin(&self, url: Option<&Url>) {
        *self.app_origin.lock().unwrap() = url.filter(|u| matches!(u.scheme(), "http" | "https")).map(|u| u.origin().ascii_serialization());
    }

    fn app_origin(&self) -> Option<String> {
        self.app_origin.lock().unwrap().clone()
    }
}

/// A URL the browser may be asked to load: http(s) with a host, no credentials, not the app's own origin, not a
/// Tauri custom-protocol host (`*.localhost` subdomains, how custom schemes are served on Windows/Android).
pub fn loadable(url: &str, app_origin: Option<&str>) -> Option<Url> {
    let u = Url::parse(url.trim()).ok()?;
    if !matches!(u.scheme(), "http" | "https") || !u.username().is_empty() || u.password().is_some() {
        return None;
    }
    let host = u.host_str()?.to_ascii_lowercase();
    if host.ends_with(".localhost") {
        return None;
    }
    if app_origin.is_some_and(|o| u.origin().ascii_serialization() == o) {
        return None;
    }
    Some(u)
}

/// A navigation a page may start: anything [`loadable`], plus frames that carry no local privilege.
fn navigable(url: &Url, app_origin: Option<&str>) -> bool {
    match url.scheme() {
        "about" | "blob" | "data" => true,
        "http" | "https" => loadable(url.as_str(), app_origin).is_some(),
        _ => false,
    }
}

#[derive(Serialize, Clone, Default)]
pub struct BrowserState {
    id: String,
    url: String,
    title: String,
    loading: bool,
    can_back: bool,
    can_forward: bool,
}

/// Sends the page's state to the app's own webview only.
fn report(w: &Webview, fallback_url: Option<&Url>, loading: Option<bool>) {
    let id = w.label().to_string();
    let app = w.app_handle().clone();
    #[cfg(target_os = "macos")]
    {
        let _ = w.with_webview(move |pw| {
            let s = native::state(pw.inner(), id);
            let _ = app.emit_to("main", "browser-state", BrowserState { loading: loading.unwrap_or(s.loading), ..s });
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let s = BrowserState { id, url: fallback_url.map(|u| u.to_string()).unwrap_or_default(), loading: loading.unwrap_or(false), can_back: true, can_forward: true, ..Default::default() };
        let _ = app.emit_to("main", "browser-state", s);
    }
    #[cfg(target_os = "macos")]
    let _ = fallback_url;
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect { position: LogicalPosition::new(x, y).into(), size: LogicalSize::new(w.max(1.0), h.max(1.0)).into() }
}

fn browser(app: &AppHandle, id: &str) -> Result<Webview, String> {
    if !id.starts_with(PREFIX) {
        return Err("not a browser webview".into());
    }
    app.get_webview(id).ok_or_else(|| "no such browser".into())
}

/// Gives the keyboard back to the app (a hidden webview can keep first responder).
fn focus_app(app: &AppHandle) {
    if let Some(m) = app.get_webview("main") {
        let _ = m.set_focus();
    }
}

#[derive(serde::Deserialize, Clone, Copy)]
pub struct Bounds {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
}

/// Opens `url` in a new browser webview at `bounds` (CSS pixels of the main window); returns its id.
#[tauri::command(async)]
pub fn browser_open(app: AppHandle, url: String, bounds: Bounds) -> Result<String, String> {
    let st = app.state::<std::sync::Arc<crate::Core>>();
    let b = &st.browsers;
    let origin = b.app_origin();
    let url = loadable(&url, origin.as_deref()).ok_or("only http and https pages open here")?;
    let window = app.get_window("main").ok_or("no window")?;
    let id = format!("{PREFIX}{}", b.next.fetch_add(1, Ordering::SeqCst) + 1);
    let nav_origin = origin.clone();
    let mut builder = WebviewBuilder::new(&id, tauri::WebviewUrl::External(url))
        .accept_first_mouse(true)
        .focused(false)
        .on_navigation(move |u| navigable(u, nav_origin.as_deref()))
        .on_new_window(popup_handler(&app, &id, origin))
        .on_download(|_, _| false)
        .on_page_load(|w, p| report(&w, Some(p.url()), Some(matches!(p.event(), PageLoadEvent::Started))))
        .on_document_title_changed(|w, _| report(&w, None, None));
    if st.selftest.is_some() {
        // Self-test pages never touch the person's browser profile.
        builder = builder.incognito(true);
    } else {
        builder = builder.data_store_identifier(DATA_STORE);
        #[cfg(not(target_os = "macos"))]
        if let Ok(d) = app.path().app_local_data_dir() {
            builder = builder.data_directory(d.join("browser"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder.user_agent(USER_AGENT);
    }
    let w = window.add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.w.max(1.0), bounds.h.max(1.0))).map_err(|e| e.to_string())?;
    // Before any pop-up exists (see native::install_close_hook).
    #[cfg(target_os = "macos")]
    {
        let a = app.clone();
        let _ = w.with_webview(move |pw| native::install_close_hook(&a, pw.inner()));
    }
    if !bounds.visible {
        let _ = w.hide();
    }
    note(&app, &id, bounds);
    Ok(id)
}

/// Records that `id` was placed (and shown), closing the least recently shown page beyond [`MAX_ALIVE`].
fn note(app: &AppHandle, id: &str, bounds: Bounds) {
    let st = app.state::<std::sync::Arc<crate::Core>>();
    let b = &st.browsers;
    b.placed.lock().unwrap().insert(id.to_string(), (bounds.visible, [bounds.x, bounds.y, bounds.w, bounds.h]));
    let mut alive = b.alive.lock().unwrap();
    let t = b.clock.fetch_add(1, Ordering::SeqCst) as u64;
    if bounds.visible || !alive.contains_key(id) {
        alive.insert(id.to_string(), t);
    }
    while alive.len() > MAX_ALIVE {
        let Some(old) = alive.iter().min_by_key(|(_, t)| **t).map(|(k, _)| k.clone()) else { break };
        alive.remove(&old);
        close_popups(app, &old);
        if let Some(w) = app.get_webview(&old) {
            let _ = w.close();
        }
        let _ = app.emit_to("main", "browser-closed", &old);
    }
}

/// Moves / resizes / shows / hides a browser webview to follow its panel.
#[tauri::command(async)]
pub fn browser_bounds(app: AppHandle, id: String, bounds: Bounds) -> Result<(), String> {
    let w = browser(&app, &id)?;
    if bounds.visible {
        w.set_bounds(rect(bounds.x, bounds.y, bounds.w, bounds.h)).map_err(|e| e.to_string())?;
        w.show().map_err(|e| e.to_string())?;
    } else {
        w.hide().map_err(|e| e.to_string())?;
        focus_app(&app);
    }
    note(&app, &id, bounds);
    Ok(())
}

#[tauri::command(async)]
pub fn browser_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    let w = browser(&app, &id)?;
    let origin = app.state::<std::sync::Arc<crate::Core>>().browsers.app_origin();
    let url = loadable(&url, origin.as_deref()).ok_or("only http and https pages open here")?;
    w.navigate(url).map_err(|e| e.to_string())
}

/// `back`, `forward`, `reload` or `stop`.
#[tauri::command(async)]
pub fn browser_go(app: AppHandle, id: String, action: String) -> Result<(), String> {
    let w = browser(&app, &id)?;
    if action == "reload" {
        return w.reload().map_err(|e| e.to_string());
    }
    #[cfg(target_os = "macos")]
    {
        let wv = w.clone();
        w.with_webview(move |pw| {
            native::go(pw.inner(), &action);
            report(&wv, None, None);
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let js = match action.as_str() {
            "back" => "history.back()",
            "forward" => "history.forward()",
            "stop" => "window.stop()",
            _ => return Err("unknown action".into()),
        };
        w.eval(js).map_err(|e| e.to_string())
    }
}

/// The page's current state (also pushed as `browser-state` on loads and title changes; polled for in-page
/// navigations, which announce nothing).
#[tauri::command(async)]
pub fn browser_poll(app: AppHandle, id: String) -> Result<(), String> {
    let w = browser(&app, &id)?;
    report(&w, w.url().ok().as_ref(), None);
    Ok(())
}

#[tauri::command(async)]
pub fn browser_close(app: AppHandle, id: String) -> Result<(), String> {
    let w = browser(&app, &id)?;
    let st = app.state::<std::sync::Arc<crate::Core>>();
    st.browsers.alive.lock().unwrap().remove(&id);
    st.browsers.placed.lock().unwrap().remove(&id);
    close_popups(&app, &id);
    w.close().map_err(|e| e.to_string())?;
    focus_app(&app);
    Ok(())
}

// ---------- pop-ups ----------

/// The new-window handler of a browser webview or pop-up labelled `opener`: a pop-up window of its own for a page
/// it may show, nothing otherwise.
fn popup_handler(app: &AppHandle, opener: &str, origin: Option<String>) -> impl Fn(Url, NewWindowFeatures) -> NewWindowResponse<tauri::Wry> + Send + 'static {
    let app = app.clone();
    let opener = opener.to_string();
    move |u, features| {
        if !navigable(&u, origin.as_deref()) {
            return NewWindowResponse::Deny;
        }
        match open_popup(&app, &opener, origin.clone(), &u, features) {
            Ok(window) => NewWindowResponse::Create { window },
            Err(e) => {
                eprintln!("coool: pop-up refused: {e}");
                NewWindowResponse::Deny
            }
        }
    }
}

/// Builds the pop-up window for a `window.open` from `opener` (runs on the main thread, inside WebKit's
/// `createWebViewWithConfiguration`). Its WKWebView is created from the configuration WebKit passed in
/// (`window_features` sets it): that is what gives the page its `window.opener` and the opener's data store.
fn open_popup(app: &AppHandle, opener: &str, origin: Option<String>, url: &Url, features: NewWindowFeatures) -> Result<WebviewWindow, String> {
    let b = &app.state::<std::sync::Arc<crate::Core>>().browsers;
    let label = format!("{POPUP_PREFIX}{}", b.next_popup.fetch_add(1, Ordering::SeqCst) + 1);
    let (w, h) = features.size().map(|s| (s.width.clamp(200.0, 1600.0), s.height.clamp(200.0, 1200.0))).unwrap_or(POPUP_SIZE);
    // Centred on the main window (Safari places pop-ups over their opener's window too).
    let pos = app.get_window("main").and_then(|m| {
        let scale = m.scale_factor().ok()?;
        let p = m.outer_position().ok()?.to_logical::<f64>(scale);
        let s = m.outer_size().ok()?.to_logical::<f64>(scale);
        Some((p.x + (s.width - w) / 2.0, p.y + ((s.height - h) / 2.0).max(0.0)))
    });
    let nav_origin = origin.clone();
    let blank: Url = "about:blank".parse().map_err(|_| "about:blank")?;
    let mut builder = WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(blank))
        .window_features(features)
        .inner_size(w, h)
        .resizable(true)
        .focused(true)
        .title(url.host_str().unwrap_or("Sign in"))
        .on_navigation(move |u| navigable(u, nav_origin.as_deref()))
        .on_new_window(popup_handler(app, &label, origin))
        .on_download(|_, _| false)
        .on_document_title_changed(|w, t| {
            if !t.trim().is_empty() {
                let _ = w.set_title(&t);
            }
        });
    builder = match pos {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };
    #[cfg(target_os = "macos")]
    {
        builder = builder.user_agent(USER_AGENT);
    }
    let win = builder.build().map_err(|e| e.to_string())?;
    b.popups.lock().unwrap().insert(label.clone(), opener.to_string());
    let gone_app = app.clone();
    let gone = label.clone();
    win.on_window_event(move |e| {
        if matches!(e, WindowEvent::Destroyed) {
            gone_app.state::<std::sync::Arc<crate::Core>>().browsers.popups.lock().unwrap().remove(&gone);
            close_popups(&gone_app, &gone);
            #[cfg(target_os = "macos")]
            native::forget_popup(&gone);
        }
    });
    #[cfg(target_os = "macos")]
    {
        let l = label.clone();
        // On the main thread this runs right away.
        let _ = win.with_webview(move |pw| native::track_popup(pw.inner(), l));
    }
    Ok(win)
}

/// Closes every pop-up `opener` opened (theirs close in turn, from their `Destroyed`).
pub fn close_popups(app: &AppHandle, opener: &str) {
    let mine: Vec<String> = app.state::<std::sync::Arc<crate::Core>>().browsers.popups.lock().unwrap().iter().filter(|(_, o)| *o == opener).map(|(l, _)| l.clone()).collect();
    for l in mine {
        if let Some(w) = app.get_webview_window(&l) {
            let _ = w.destroy();
        }
    }
}

/// Closes every pop-up (the main window is going away).
pub fn close_all_popups(app: &AppHandle) {
    let all: Vec<String> = app.state::<std::sync::Arc<crate::Core>>().browsers.popups.lock().unwrap().keys().cloned().collect();
    for l in all {
        if let Some(w) = app.get_webview_window(&l) {
            let _ = w.destroy();
        }
    }
}

/// The panel's "Open in default browser": the page the webview shows, if it is still an http(s) page.
#[tauri::command(async)]
pub fn browser_open_external(app: AppHandle, id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let w = browser(&app, &id)?;
    let url = w.url().map_err(|e| e.to_string())?;
    let url = loadable(url.as_str(), None).ok_or("not an http(s) page")?;
    app.opener().open_url(url.as_str(), None::<&str>).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
mod native {
    //! WKWebView's own history and state (the cross-platform API has no back / forward).
    use super::BrowserState;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use std::collections::HashMap;
    use std::ffi::{CStr, c_char, c_void};
    use std::sync::{Mutex, Once, OnceLock};
    use tauri::{AppHandle, Manager};

    /// Pop-up WKWebViews (by address) -> their window label, for `webViewDidClose:`.
    static POPUP_VIEWS: Mutex<Option<HashMap<usize, String>>> = Mutex::new(None);
    static APP: OnceLock<AppHandle> = OnceLock::new();
    static CLOSE_HOOK: Once = Once::new();

    /// Remembers a pop-up's WKWebView so a `window.close()` from its page closes its window.
    pub fn track_popup(wk: *mut c_void, label: String) {
        POPUP_VIEWS.lock().unwrap().get_or_insert_with(HashMap::new).insert(wk as usize, label);
    }

    pub fn forget_popup(label: &str) {
        if let Some(m) = POPUP_VIEWS.lock().unwrap().as_mut() {
            m.retain(|_, l| l != label);
        }
    }

    /// WebKit calls `webViewDidClose:` on the UI delegate when a script-opened page runs `window.close()`. wry's
    /// delegate class has no such method, so it is added to that class here. It only ever closes a tracked pop-up's
    /// window; for any other webview (the app's own, a panel page) it does nothing.
    ///
    /// `wk` is any live wry WKWebView (its delegate's class is wry's). It must run before the first pop-up is built:
    /// WebKit checks which methods a UI delegate has when the delegate is set, so a method added later is never called
    /// for a webview that already has its delegate.
    pub fn install_close_hook(app: &AppHandle, wk: *mut c_void) {
        let _ = APP.set(app.clone());
        let wk = wk as *mut AnyObject;
        if wk.is_null() {
            return;
        }
        CLOSE_HOOK.call_once(|| {
            use objc2::runtime::{AnyClass, Imp, Sel};
            extern "C-unwind" fn did_close(_this: *mut AnyObject, _cmd: Sel, webview: *mut AnyObject) {
                let label = POPUP_VIEWS.lock().unwrap().as_ref().and_then(|m| m.get(&(webview as usize)).cloned());
                if let (Some(label), Some(app)) = (label, APP.get()) {
                    // Not inside WebKit's callback for the very webview being destroyed: from another thread the
                    // close is queued on the event loop.
                    let app = app.clone();
                    std::thread::spawn(move || {
                        if let Some(w) = app.get_webview_window(&label) {
                            let _ = w.destroy();
                        }
                    });
                }
            }
            // SAFETY: `wk` is a live WKWebView on the main thread; `UIDelegate` is a plain getter.
            let delegate: *mut AnyObject = unsafe { msg_send![&*wk, UIDelegate] };
            if delegate.is_null() {
                eprintln!("coool: the browser webview has no UI delegate; pop-ups can't close themselves");
                return;
            }
            // SAFETY: `delegate` is non-null and alive (the webview holds it).
            let cls: &AnyClass = unsafe { (*delegate).class() };
            // SAFETY: adds a method of type `v@:@` (void; self, _cmd, WKWebView*), matching `did_close`'s signature,
            // to an existing class. If wry ever defines it itself, class_addMethod keeps wry's and returns NO.
            unsafe {
                let imp = std::mem::transmute::<extern "C-unwind" fn(*mut AnyObject, objc2::runtime::Sel, *mut AnyObject), Imp>(did_close);
                let _ = objc2::ffi::class_addMethod(cls as *const AnyClass as *mut AnyClass, objc2::sel!(webViewDidClose:), imp, c"v@:@".as_ptr());
            }
        });
    }

    fn string(o: *mut AnyObject) -> String {
        if o.is_null() {
            return String::new();
        }
        // SAFETY: `o` is an NSString (or nil, handled above); UTF8String returns a NUL-terminated buffer owned by it.
        unsafe {
            let p: *const c_char = msg_send![&*o, UTF8String];
            if p.is_null() { String::new() } else { CStr::from_ptr(p).to_string_lossy().into_owned() }
        }
    }

    /// Runs on the main thread, with `wk` the live WKWebView wry gave us.
    pub fn state(wk: *mut c_void, id: String) -> BrowserState {
        let wk = wk as *mut AnyObject;
        if wk.is_null() {
            return BrowserState { id, ..Default::default() };
        }
        // SAFETY: plain WKWebView property getters on the main thread.
        unsafe {
            let w = &*wk;
            let u: *mut AnyObject = msg_send![w, URL];
            let url = if u.is_null() { String::new() } else { string(msg_send![&*u, absoluteString]) };
            BrowserState {
                id,
                url,
                title: string(msg_send![w, title]),
                loading: msg_send![w, isLoading],
                can_back: msg_send![w, canGoBack],
                can_forward: msg_send![w, canGoForward],
            }
        }
    }

    pub fn go(wk: *mut c_void, action: &str) {
        let wk = wk as *mut AnyObject;
        if wk.is_null() {
            return;
        }
        // SAFETY: WKWebView navigation methods on the main thread; the returned WKNavigation is autoreleased.
        unsafe {
            let w = &*wk;
            match action {
                "back" => {
                    let _: *mut AnyObject = msg_send![w, goBack];
                }
                "forward" => {
                    let _: *mut AnyObject = msg_send![w, goForward];
                }
                "stop" => {
                    let _: () = msg_send![w, stopLoading];
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_pages_load() {
        for ok in ["https://example.com", "http://localhost:3000/x", "https://claude.ai/artifact/abc?x=1#y", " https://a.b/ "] {
            assert!(loadable(ok, None).is_some(), "{ok}");
        }
        for bad in [
            "file:///etc/hosts",
            "javascript:alert(1)",
            "tauri://localhost/",
            "ipc://localhost/list_sessions",
            "coool-artifact://localhost/tok/page.html",
            "http://coool-artifact.localhost/tok/page.html",
            "http://ipc.localhost/x",
            "data:text/html,hi",
            "about:blank",
            "https://user:pw@example.com/",
            "mailto:a@b.c",
            "notaurl",
            "",
        ] {
            assert!(loadable(bad, None).is_none(), "{bad}");
        }
        // The dev server the app itself is served from.
        assert!(loadable("http://localhost:1420/", Some("http://localhost:1420")).is_none());
        assert!(loadable("http://localhost:1420/src/main.tsx", Some("http://localhost:1420")).is_none());
        assert!(loadable("http://localhost:3000/", Some("http://localhost:1420")).is_some());
    }

    #[test]
    fn pages_navigate_only_to_safe_schemes() {
        let n = |s: &str| navigable(&Url::parse(s).unwrap(), Some("http://localhost:1420"));
        assert!(n("https://example.com/next"));
        assert!(n("about:blank"));
        assert!(n("blob:https://example.com/0b1c"));
        for bad in ["file:///etc/hosts", "javascript:alert(1)", "tauri://localhost/", "coool-artifact://localhost/x", "http://localhost:1420/", "zoommtg://x", "ipc://localhost/x"] {
            assert!(!n(bad), "{bad}");
        }
    }
}
