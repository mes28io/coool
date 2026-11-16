//! Artifact previews: a page a session published to claude.ai (see
//! `coool_core::artifact`), shown from its local copy in a sandboxed iframe.
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
use serde::Serialize;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::http::{Request, Response, StatusCode};
use tauri::State;

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

#[derive(Serialize)]
pub struct Preview {
    /// The iframe's `src`, or `None` when the local copy is gone.
    src: Option<String>,
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

/// A URL the preview frame loads the artifact's page from.
#[tauri::command(async)]
pub fn artifact_preview(core: State<'_, Arc<Core>>, url: String) -> Result<Preview, String> {
    let a = find(&core, &url).ok_or("no such artifact")?;
    let page = page_name(&a).ok_or("bad page name")?;
    if !safe_file(Path::new(&a.file_path)) {
        return Ok(Preview { src: None });
    }
    let mut files: HashMap<String, PathBuf> = a.files.iter().filter_map(|(k, v)| Some((clean_rel(k)?, PathBuf::from(v)))).collect();
    files.insert(page.clone(), PathBuf::from(&a.file_path));
    let mut tokens = core.previews.tokens.lock().unwrap();
    // One token per artifact: a new version replaces what it serves.
    let token = tokens.iter().find(|(_, v)| v.url == url).map(|(k, _)| k.clone()).unwrap_or_else(new_token);
    tokens.insert(token.clone(), Allowed { url, files });
    Ok(Preview { src: Some(format!("{}/{token}/{}", base_url(), encode(&page))) })
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
/// reports to its parent what it can reach (see the `artifact` scenario in app/src/selftest.ts).
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
  window.parent.postMessage({ cooolArtifactProbe: r }, "*");
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
    fn published_paths_are_clean() {
        assert_eq!(clean_rel("./a/b.png").as_deref(), Some("a/b.png"));
        for bad in ["", "/etc/passwd", "../x", "a/../../x", "a//b", "a\\b", "."] {
            assert!(clean_rel(bad).is_none(), "{bad}");
        }
    }
}
