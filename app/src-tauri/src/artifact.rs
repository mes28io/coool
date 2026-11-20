//! Artifact previews: a page a session published to claude.ai (see
//! `coool_core::artifact`), shown from its local copy in a sandboxed iframe, in
//! a preview window of its own ([`artifact_window`]).
//!
//! The page is served over the `coool-artifact` scheme at
//! `coool-artifact://localhost/<token>/<published path>`. A token is made only
//! for an artifact the backend itself parsed from a timeline (the UI names the
//! artifact by URL, never by path), and serves exactly that artifact's page
//! (under its file name) and the files of its `files` map (under their
//! published names, so relative references in the page resolve). Every file is
//! opened without following symlinks; anything else is a 404.

use coool_core::artifact::ArtifactInfo;
use coool_core::chat::ChatEventKind;
use coool_core::model::Activity;

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, State, WebviewWindowBuilder};

use crate::Core;

pub const SCHEME: &str = "coool-artifact";
/// Largest file served.
const MAX_FILE: u64 = 32 * 1024 * 1024;

#[derive(Default)]
pub struct Previews {
    /// The timelines the UI was last sent (cheap: shared with the sessions).
    timelines: Mutex<Vec<Arc<Vec<Activity>>>>,
    /// token -> what it may serve.
    tokens: Mutex<HashMap<String, Allowed>>,
    /// Self-test only (see [`selftest_artifact`]).
    extra: Mutex<Vec<ArtifactInfo>>,
    /// Open preview windows: artifact URL -> (window label, the version it shows).
    pub(crate) windows: Mutex<HashMap<String, (String, u32)>>,
    next_window: std::sync::atomic::AtomicU32,
}

struct Allowed {
    url: String,
    /// Published path -> local file. The page itself is under its file name.
    files: HashMap<String, PathBuf>,
}

impl Previews {
    pub fn set_timelines(&self, t: Vec<Arc<Vec<Activity>>>) {
        *self.timelines.lock().unwrap() = t;
    }
}

/// The newest version of the artifact at `url` in any timeline or chat.
fn find(core: &Core, url: &str) -> Option<ArtifactInfo> {
    let mut best: Option<ArtifactInfo> = None;
    let mut take = |a: &ArtifactInfo| {
        if a.url == url && best.as_ref().is_none_or(|b| a.version.unwrap_or(0) >= b.version.unwrap_or(0)) {
            best = Some(a.clone());
        }
    };
    for t in core.previews.timelines.lock().unwrap().iter() {
        t.iter().filter_map(|a| a.artifact.as_deref()).for_each(&mut take);
    }
    core.previews.extra.lock().unwrap().iter().for_each(&mut take);
    let handles: Vec<_> = core.chats.lock().unwrap().values().map(|c| c.handle.clone()).collect();
    for h in handles {
        for e in h.events_since(0).0 {
            if let ChatEventKind::ToolEnd { artifact: Some(a), .. } = &e.kind {
                take(a);
            }
        }
    }
    best
}

/// A local file that may be served: absolute, a regular file (not a symlink),
/// and reached through no symlinked folder (its canonical path is itself).
fn safe_file(p: &Path) -> bool {
    p.is_absolute()
        && std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_file())
        && p.canonicalize().is_ok_and(|c| c == p)
}

/// A published path as the page references it: relative, no `..`, no empty parts.
fn clean_rel(p: &str) -> Option<String> {
    let p = p.trim_start_matches("./");
    let ok = !p.is_empty() && !p.starts_with('/') && !p.contains('\\') && p.split('/').all(|s| !s.is_empty() && s != "." && s != "..");
    ok.then(|| p.to_string())
}

fn page_name(a: &ArtifactInfo) -> Option<String> {
    Path::new(&a.file_path).file_name().map(|n| n.to_string_lossy().into_owned()).and_then(|n| clean_rel(&n))
}

fn new_token() -> String {
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let a = h.finish();
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(a);
    format!("{a:016x}{:016x}", h.finish())
}

fn base_url() -> &'static str {
    if cfg!(windows) || cfg!(target_os = "android") { "http://coool-artifact.localhost" } else { "coool-artifact://localhost" }
}

/// Whether each artifact's local page is still there.
#[tauri::command(async)]
pub fn artifact_status(core: State<'_, Arc<Core>>, urls: Vec<String>) -> HashMap<String, bool> {
    urls.into_iter()
        .map(|u| {
            let ok = find(&core, &u).is_some_and(|a| safe_file(Path::new(&a.file_path)));
            (u, ok)
        })
        .collect()
}

/// The artifact at `url` and the `coool-artifact://` URL its page is served from (`None` when the local copy is
/// gone). One token per artifact: a new version replaces what it serves.
pub(crate) fn mint(core: &Core, url: &str) -> Result<(ArtifactInfo, Option<String>), String> {
    let a = find(core, url).ok_or("no such artifact")?;
    let page = page_name(&a).ok_or("bad page name")?;
    if !safe_file(Path::new(&a.file_path)) {
        return Ok((a, None));
    }
    let mut files: HashMap<String, PathBuf> = a.files.iter().filter_map(|(k, v)| Some((clean_rel(k)?, PathBuf::from(v)))).collect();
    files.insert(page.clone(), PathBuf::from(&a.file_path));
    let mut tokens = core.previews.tokens.lock().unwrap();
    let token = tokens.iter().find(|(_, v)| v.url == url).map(|(k, _)| k.clone()).unwrap_or_else(new_token);
    tokens.insert(token.clone(), Allowed { url: url.to_string(), files });
    Ok((a, Some(format!("{}/{token}/{}", base_url(), encode(&page)))))
}

// ---------- the preview window ----------

/// Preview windows (window and webview share the label).
pub const PREVIEW_PREFIX: &str = "preview-";
/// A preview window's size when the screen has room.
const PREVIEW_SIZE: (f64, f64) = (900.0, 700.0);

/// The page a preview window loads, as a `data:` URL: nothing but the artifact's page in
/// `<iframe sandbox="allow-scripts">`. Its own CSP allows no script, no fetch, and frames only from the artifact
/// scheme. A `data:` document is an opaque, non-local origin to Tauri, so its IPC is refused everything (see
/// [`artifact_window`]).
fn host_url(src: &str) -> String {
    let attr = src.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;");
    let html = format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src {SCHEME}: http://{SCHEME}.localhost"><style>html,body{{margin:0;height:100%;background:#fff}}iframe{{display:block;border:0;width:100%;height:100%}}</style></head><body><iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer" src="{attr}"></iframe></body></html>"#
    );
    format!("data:text/html;charset=utf-8,{}", encode(&html).replace('/', "%2F"))
}

/// What a preview window may load: its host page (`data:`), blank frames, and this artifact's token on the artifact
/// scheme. The web, `file:`, the app's own pages and other tokens are cancelled.
fn preview_navigable(u: &tauri::webview::Url, token: &str) -> bool {
    let mine = || u.path().starts_with(&format!("/{token}/"));
    match u.scheme() {
        "data" | "about" => true,
        s if s == SCHEME => u.host_str() == Some("localhost") && mine(),
        // Windows / Android serve custom schemes as http://<scheme>.localhost.
        "http" | "https" => u.host_str() == Some(&format!("{SCHEME}.localhost")) && mine(),
        _ => false,
    }
}

fn preview_title(a: &ArtifactInfo) -> String {
    match a.version {
        Some(v) => format!("{} · v{v}", a.title),
        None => a.title.clone(),
    }
}

/// Opens the artifact's local copy in a preview window of its own (APP_SPEC "Artifacts"), or focuses the one already
/// showing it (reloaded when a newer version was published). `false` when the local copy is gone.
///
/// Isolation: the window's label (`preview-<n>`) is in no capability (the only one names the webview `main`), and
/// the page it loads is a `data:` document, which Tauri treats as a remote origin: every command and plugin call
/// from it is checked against the ACL and refused. The artifact runs one level down, in a sandboxed frame (opaque
/// origin, no Tauri script, so no invoke key), exactly as it used to in the panel. Non-persistent data store; no
/// new windows, no downloads.
#[tauri::command(async)]
pub fn artifact_window(app: AppHandle, core: State<'_, Arc<Core>>, url: String) -> Result<bool, String> {
    let (a, src) = mint(&core, &url)?;
    let Some(src) = src else { return Ok(false) };
    let title = preview_title(&a);
    let version = a.version.unwrap_or(0);
    let open = core.previews.windows.lock().unwrap().get(&url).cloned();
    if let Some((label, shown)) = open
        && let Some(w) = app.get_webview_window(&label)
    {
        if shown != version {
            let to = tauri::webview::Url::parse(&host_url(&src)).map_err(|e| e.to_string())?;
            let _ = w.navigate(to);
            let _ = w.set_title(&title);
            core.previews.windows.lock().unwrap().insert(url, (label, version));
        }
        let _ = w.unminimize();
        let _ = w.show();
        if crate::selftest::windows_may_focus() {
            let _ = w.set_focus();
        }
        return Ok(true);
    }
    let token = src.trim_start_matches(base_url()).trim_start_matches('/').split('/').next().unwrap_or_default().to_string();
    let label = format!("{PREVIEW_PREFIX}{}", core.previews.next_window.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1);
    let host = tauri::webview::Url::parse(&host_url(&src)).map_err(|e| e.to_string())?;
    let main = app.get_window("main").ok_or("no window")?;
    let (pos, size) = place_preview(&main);
    let mut builder = WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(host))
        .title(&title)
        .inner_size(size.0, size.1)
        .min_inner_size(320.0, 240.0)
        .resizable(true)
        .focused(crate::selftest::windows_may_focus())
        .incognito(true)
        .on_navigation(move |u| preview_navigable(u, &token))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_download(|_, _| false);
    builder = match pos {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };
    // A child window of the main one (macOS: addChildWindow): it stays above it and moves with it, as Safari's
    // pop-ups do, without blocking it.
    #[cfg(target_os = "macos")]
    if let Ok(ns) = main.ns_window() {
        builder = builder.parent_raw(ns);
    }
    let win = builder.build().map_err(|e| e.to_string())?;
    core.previews.windows.lock().unwrap().insert(url.clone(), (label.clone(), version));
    let gone = app.clone();
    win.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::Destroyed) {
            let st = gone.state::<Arc<Core>>();
            st.previews.windows.lock().unwrap().retain(|_, (l, _)| l != &label);
        }
    });
    Ok(true)
}

/// 900×700 (smaller if the screen's work area is), centred on the main window, kept on its screen.
fn place_preview(main: &tauri::Window) -> (Option<(f64, f64)>, (f64, f64)) {
    let (mut w, mut h) = PREVIEW_SIZE;
    let Ok(scale) = main.scale_factor() else { return (None, (w, h)) };
    let area = main.current_monitor().ok().flatten().map(|m| {
        let wa = m.work_area();
        let p = wa.position.to_logical::<f64>(scale);
        let s = wa.size.to_logical::<f64>(scale);
        (p.x, p.y, s.width, s.height)
    });
    if let Some((_, _, aw, ah)) = area {
        w = w.min(aw - 40.0).max(320.0);
        // Room for the title bar.
        h = h.min(ah - 68.0).max(240.0);
    }
    let pos = (|| {
        let p = main.outer_position().ok()?.to_logical::<f64>(scale);
        let s = main.outer_size().ok()?.to_logical::<f64>(scale);
        let (mut x, mut y) = (p.x + (s.width - w) / 2.0, p.y + (s.height - h - 28.0) / 2.0);
        if let Some((ax, ay, aw, ah)) = area {
            x = x.clamp(ax, (ax + aw - w).max(ax));
            y = y.clamp(ay, (ay + ah - h - 28.0).max(ay));
        }
        Some((x, y))
    })();
    (pos, (w, h))
}

/// Closes every preview window (the main window is going away).
pub fn close_previews(app: &AppHandle) {
    let labels: Vec<String> = app.state::<Arc<Core>>().previews.windows.lock().unwrap().values().map(|(l, _)| l.clone()).collect();
    for l in labels {
        if let Some(w) = app.get_webview_window(&l) {
            let _ = w.destroy();
        }
    }
}

fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn mime(p: &str) -> &'static str {
    let ext = p.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn read_nofollow(p: &Path) -> std::io::Result<Vec<u8>> {
    let mut o = std::fs::OpenOptions::new();
    o.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.custom_flags(libc::O_NOFOLLOW);
    }
    let f = o.open(p)?;
    if !f.metadata()?.is_file() {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    let mut buf = Vec::new();
    f.take(MAX_FILE).read_to_end(&mut buf)?;
    Ok(buf)
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(code).header("Content-Type", "text/plain").body(Vec::new()).unwrap()
}

/// The `coool-artifact` scheme: `/<token>/<published path>`.
pub fn serve(previews: &Previews, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if req.method() != "GET" && req.method() != "HEAD" {
        return status(StatusCode::METHOD_NOT_ALLOWED);
    }
    let path = req.uri().path().trim_start_matches('/');
    let Some((token, rest)) = path.split_once('/') else { return status(StatusCode::NOT_FOUND) };
    let Some(rel) = decode(rest).and_then(|r| clean_rel(&r)) else { return status(StatusCode::NOT_FOUND) };
    let file = {
        let tokens = previews.tokens.lock().unwrap();
        let Some(a) = tokens.get(token) else { return status(StatusCode::NOT_FOUND) };
        let Some(f) = a.files.get(&rel) else { return status(StatusCode::NOT_FOUND) };
        f.clone()
    };
    if !safe_file(&file) {
        return status(StatusCode::NOT_FOUND);
    }
    match read_nofollow(&file) {
        Ok(body) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", mime(&rel))
            .header("Cache-Control", "no-store")
            // The frame is sandboxed (an opaque origin): fonts and module scripts load with CORS.
            .header("Access-Control-Allow-Origin", "*")
            .header("X-Content-Type-Options", "nosniff")
            .body(body)
            .unwrap(),
        Err(_) => status(StatusCode::NOT_FOUND),
    }
}

/// Self-test only: writes a probe page (and a supporting image, and a file that is not in its map) into the
/// self-test folder and makes it previewable without a session (the self-test lists no real sessions). The page
/// reports to its parent (the preview window's host page) what it can reach (see the `artifact` scenario in
/// app/src/selftest.ts).
#[tauri::command]
pub fn selftest_artifact(core: State<'_, Arc<Core>>) -> Result<ArtifactInfo, String> {
    let t = core.selftest.as_ref().ok_or("not in self-test")?;
    let dir = t.dir().canonicalize().map_err(|e| e.to_string())?.join("artifact-probe");
    std::fs::create_dir_all(dir.join("img")).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("probe.html"), PROBE_PAGE).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("img/dot.svg"), r##"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="#2f7d5b"/></svg>"##).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("secret.txt"), "not in the artifact's files").map_err(|e| e.to_string())?;
    let s = |p: &str| dir.join(p).to_string_lossy().into_owned();
    let a = ArtifactInfo {
        url: "https://claude.ai/artifact/selftestProbe".into(),
        version: Some(1),
        file_path: s("probe.html"),
        files: [("img/dot.svg".to_string(), s("img/dot.svg"))].into_iter().collect(),
        icon: Some("wrench".into()),
        title: "Self-test probe".into(),
    };
    core.previews.extra.lock().unwrap().push(a.clone());
    Ok(a)
}

const PROBE_PAGE: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Self-test probe</title>
<style>body{font:16px -apple-system,sans-serif;padding:24px;background:#fff;color:#111}</style></head>
<body><h1>Artifact probe</h1><img id="dot" src="img/dot.svg" alt=""><pre id="out">running…</pre>
<script>
(async () => {
  const r = { origin: String(self.origin), url: String(location.origin), tauri: typeof window.__TAURI__, internals: typeof window.__TAURI_INTERNALS__, ipcGlobal: typeof window.ipc };
  try { r.parent = typeof window.parent.document; } catch (e) { r.parent = "blocked"; }
  try { r.top = String(window.top.location.href).slice(0, 12); } catch (e) { r.top = "blocked"; }
  r.img = await new Promise((res) => { const i = document.getElementById("dot"); if (i.complete && i.naturalWidth) res("loaded"); i.onload = () => res("loaded"); i.onerror = () => res("error"); setTimeout(() => res("timeout"), 4000); });
  try { r.secret = (await fetch("secret.txt")).status; } catch (e) { r.secret = "error"; }
  try { r.escape = (await fetch("../../etc/hosts")).status; } catch (e) { r.escape = "error"; }
  try {
    const res = await fetch("ipc://localhost/selftest_log", { method: "POST", body: JSON.stringify({ line: "FRAME-IPC-REACHED" }), headers: { "Content-Type": "application/json", "Tauri-Callback": "1", "Tauri-Error": "2", "Tauri-Invoke-Key": "x" } });
    r.ipcFetch = res.status;
  } catch (e) { r.ipcFetch = "error"; }
  try { const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ipc; r.webkitIpc = h ? "present" : "absent"; } catch (e) { r.webkitIpc = "error"; }
  document.getElementById("out").textContent = JSON.stringify(r, null, 1);
  // Repeated for a while: whoever listens (the self-test, in the preview window's host page) may start late.
  for (let i = 0; i < 60; i++) { window.parent.postMessage({ cooolArtifactProbe: r }, "*"); await new Promise((res) => setTimeout(res, 250)); }
})();
</script></body></html>"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn get(p: &Previews, path: &str) -> StatusCode {
        let req = Request::builder().uri(format!("coool-artifact://localhost{path}")).body(Vec::new()).unwrap();
        serve(p, &req).status()
    }

    #[test]
    fn serves_only_the_named_files() {
        let dir = std::env::temp_dir().canonicalize().unwrap().join(format!("coool-artifact-serve-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("img")).unwrap();
        std::fs::write(dir.join("page.html"), "<title>x</title><img src=img/a.png>").unwrap();
        std::fs::write(dir.join("img/a.png"), "png").unwrap();
        std::fs::write(dir.join("secret.txt"), "no").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("secret.txt"), dir.join("link.png")).unwrap();
        let p = Previews::default();
        let files = HashMap::from([
            ("page.html".to_string(), dir.join("page.html")),
            ("img/a.png".to_string(), dir.join("img/a.png")),
            ("link.png".to_string(), dir.join("link.png")),
        ]);
        p.tokens.lock().unwrap().insert("tok".into(), Allowed { url: "u".into(), files });
        assert_eq!(get(&p, "/tok/page.html"), StatusCode::OK);
        assert_eq!(get(&p, "/tok/img/a.png"), StatusCode::OK);
        assert_eq!(get(&p, "/tok/img%2Fa.png"), StatusCode::OK);
        assert_eq!(get(&p, "/tok/secret.txt"), StatusCode::NOT_FOUND, "not in the map");
        assert_eq!(get(&p, "/tok/img/../secret.txt"), StatusCode::NOT_FOUND);
        assert_eq!(get(&p, "/tok/..%2Fsecret.txt"), StatusCode::NOT_FOUND);
        assert_eq!(get(&p, "/other/page.html"), StatusCode::NOT_FOUND, "unknown token");
        #[cfg(unix)]
        assert_eq!(get(&p, "/tok/link.png"), StatusCode::NOT_FOUND, "a symlink is never followed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn preview_windows_load_only_their_artifact() {
        let n = |s: &str| preview_navigable(&tauri::webview::Url::parse(s).unwrap(), "tok");
        assert!(n(&host_url("coool-artifact://localhost/tok/page.html")));
        assert!(n("about:blank"));
        assert!(n("coool-artifact://localhost/tok/page.html"));
        assert!(n("coool-artifact://localhost/tok/sub/next.html?x=1"));
        for bad in ["coool-artifact://localhost/other/page.html", "coool-artifact://evil/tok/page.html", "https://example.com/", "http://localhost:1420/", "tauri://localhost/", "file:///etc/hosts", "javascript:alert(1)", "ipc://localhost/x"] {
            assert!(!n(bad), "{bad}");
        }
        // The host page frames the artifact, sandboxed, and runs nothing itself.
        let html = decode(host_url("coool-artifact://localhost/tok/a%20b.html").trim_start_matches("data:text/html;charset=utf-8,")).unwrap();
        assert!(html.contains(r#"<iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer" src="coool-artifact://localhost/tok/a%20b.html">"#), "{html}");
        assert!(html.contains("default-src 'none'") && !html.contains("<script"), "{html}");
    }

    #[test]
    fn published_paths_are_clean() {
        assert_eq!(clean_rel("./a/b.png").as_deref(), Some("a/b.png"));
        for bad in ["", "/etc/passwd", "../x", "a/../../x", "a//b", "a\\b", "."] {
            assert!(clean_rel(bad).is_none(), "{bad}");
        }
    }
}
