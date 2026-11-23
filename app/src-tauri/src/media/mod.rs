//! Media (CHAT_SPEC "Media"): pictures, movies, sounds and PDFs in a chat, served to the page over the
//! `coool-media` scheme, the screenshots coool's device tools keep, and the key frames of a video the person attaches.
//!
//! What may be served. The page asks `media_grant` for paths, naming the chat (a live chat id, or a session key
//! `provider:id`). The backend works out what that chat legitimately references, from its own records, never from
//! the page: the chat's folder; the files its messages attached, its `show` calls showed and its steps wrote (from
//! the chat's events, or the session's timeline); coool's attachment store and capture folder. A path inside none of
//! those, or whose bytes aren't an image, movie, sound or PDF, is refused. A granted file gets an unguessable token and
//! is served only as `coool-media://localhost/<token>` (and `/<token>/thumb`), only to the main webview, read in
//! ranges (a long video streams; nothing is base64'd), re-checked on every request (a regular file, same size class,
//! no symlink swapped in: its resolved path must still be the one granted).
//!
//! An explainer (a self-contained .html or .svg the agent made: an animation, an interactive diagram) is served only
//! as `/<token>/frame`, a page for `<iframe sandbox="allow-scripts">` (an opaque origin: no cookies, no storage, no
//! Tauri IPC, which refuses a non-local origin) under a CSP that loads nothing from anywhere: inline script and style,
//! `data:` / `blob:` pictures and fonts only. coool adds one line of script that tells the chat its height.

pub mod native;

use crate::{Core, Res};
use coool_core::attach::{self, Attachment, Frame};
use coool_core::chat::ChatEventKind;
use coool_core::media::{self, MediaKind};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;
use tauri::http::{Request, Response, StatusCode};

pub const SCHEME: &str = "coool-media";
/// Largest range sent per response (WebKit asks for the rest).
const CHUNK: u64 = 4 * 1024 * 1024;
/// A whole file in one response up to this size (images, short clips).
const WHOLE: u64 = 24 * 1024 * 1024;
/// Thumbnails' longest edge.
const THUMB: u32 = 480;
/// Tokens kept (the oldest go first).
const MAX_TOKENS: usize = 4000;
/// Thumbnails kept in memory.
const MAX_THUMBS: usize = 300;

struct Grant {
    path: PathBuf,
    mime: &'static str,
    kind: MediaKind,
    n: u64,
}

#[derive(Default)]
pub struct Media {
    tokens: Mutex<HashMap<String, Grant>>,
    by_path: Mutex<HashMap<PathBuf, String>>,
    thumbs: Mutex<HashMap<String, (u64, Arc<Vec<u8>>)>>,
    next: std::sync::atomic::AtomicU64,
}

fn base_url() -> &'static str {
    if cfg!(windows) || cfg!(target_os = "android") { "http://coool-media.localhost" } else { "coool-media://localhost" }
}

fn head(p: &Path) -> Vec<u8> {
    let mut b = vec![0u8; media::HEAD];
    let n = std::fs::File::open(p).and_then(|mut f| f.read(&mut b)).unwrap_or(0);
    b.truncate(n);
    b
}

fn expand(p: &str, cwd: Option<&Path>) -> PathBuf {
    let p = p.trim().trim_start_matches("file://");
    if let Some(rest) = p.strip_prefix("~/") {
        return dirs::home_dir().unwrap_or_default().join(rest);
    }
    let pb = PathBuf::from(p);
    match cwd {
        Some(c) if pb.is_relative() => c.join(pb),
        _ => pb,
    }
}

/// What a chat legitimately references: its folder and the files it named.
struct Scope {
    cwd: Option<PathBuf>,
    named: Vec<PathBuf>,
}

const WRITE_TOOLS: &[&str] = &["Write", "Edit", "MultiEdit", "NotebookEdit"];

fn scope(core: &Core, chat: Option<usize>, session: Option<&str>) -> Scope {
    let mut cwd: Option<PathBuf> = None;
    let mut named: Vec<String> = Vec::new();
    let mut key = session.map(str::to_string);
    if let Some(id) = chat {
        let (handle, k) = match core.chats.lock().unwrap().get(&id) {
            Some(c) => (Some(c.handle.clone()), c.key.clone()),
            None => (None, None),
        };
        if key.is_none() {
            key = k;
        }
        if let Some(h) = handle {
            cwd = core.hub.lock().unwrap().chat(id).map(|c| PathBuf::from(&c.cwd));
            for e in h.events_since(0).0 {
                match &e.kind {
                    ChatEventKind::Ready { cwd: c, .. } if cwd.is_none() && !c.is_empty() => cwd = Some(PathBuf::from(c)),
                    ChatEventKind::UserMessage { attachments, .. } => named.extend(attachments.iter().filter_map(|a| a.path.clone())),
                    ChatEventKind::ToolStart { name, input, .. } => {
                        if media::is_show_tool(name) {
                            named.extend(media::shown(input).map(|s| s.paths).unwrap_or_default());
                        } else if WRITE_TOOLS.contains(&name.as_str())
                            && let Some(p) = input["file_path"].as_str()
                        {
                            named.push(p.to_string());
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    if let Some(k) = key {
        let published = core.published.lock().unwrap();
        if let Some(s) = published.sessions.get(&k) {
            let s = &s.session;
            if cwd.is_none() && !s.cwd.is_empty() {
                cwd = Some(PathBuf::from(&s.cwd));
            }
            for a in s.activity.iter() {
                named.extend(a.attachments.iter().filter_map(|x| x.path.clone()));
                if let Some(m) = &a.media {
                    named.extend(m.paths.iter().cloned());
                }
            }
        }
    }
    let named = named.iter().map(|p| expand(p, cwd.as_deref())).collect();
    Scope { cwd, named }
}

fn stores() -> Vec<PathBuf> {
    [attach::store_dir(), media::capture_dir()].into_iter().flatten().collect()
}

#[derive(Serialize)]
pub struct Granted {
    /// The path as asked.
    pub path: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<MediaKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<&'static str>,
    pub size: u64,
    /// The file on disk (resolved): what Reveal shows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub real: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Media {
    fn token_for(&self, real: PathBuf, mime: &'static str, kind: MediaKind) -> String {
        let mut by = self.by_path.lock().unwrap();
        let mut tokens = self.tokens.lock().unwrap();
        if let Some(t) = by.get(&real)
            && tokens.contains_key(t)
        {
            return t.clone();
        }
        if tokens.len() >= MAX_TOKENS {
            // Forget the oldest quarter.
            let mut all: Vec<(u64, String)> = tokens.iter().map(|(k, g)| (g.n, k.clone())).collect();
            all.sort();
            for (_, k) in all.into_iter().take(MAX_TOKENS / 4) {
                if let Some(g) = tokens.remove(&k) {
                    by.remove(&g.path);
                }
            }
        }
        let t = crate::device::mcp::random_token();
        let n = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        tokens.insert(t.clone(), Grant { path: real.clone(), mime, kind, n });
        by.insert(real, t.clone());
        t
    }
}

/// Grants the page URLs for these files of a chat (see the module comment). Each path gets its answer: a URL, or why
/// not.
#[tauri::command(async)]
pub fn media_grant(core: State<'_, Arc<Core>>, chat: Option<usize>, session: Option<String>, paths: Vec<String>) -> Res<Vec<Granted>> {
    if chat.is_none() && session.is_none() {
        return Err("no chat to check the files against".into());
    }
    let sc = scope(&core, chat, session.as_deref());
    let stores = stores();
    Ok(paths
        .into_iter()
        .take(200)
        .map(|asked| {
            let p = expand(&asked, sc.cwd.as_deref());
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| asked.clone());
            let refuse = |e: &str| Granted { path: asked.clone(), name: name.clone(), url: None, thumb: None, kind: media::kind_by_name(&name), mime: None, size: 0, real: None, error: Some(e.into()) };
            if !p.is_absolute() {
                return refuse("not a full path");
            }
            let Ok(meta) = std::fs::metadata(&p) else { return refuse("the file is gone (moved or deleted?)") };
            if !meta.is_file() {
                return refuse("not a file");
            }
            if media::allowed(&p, sc.cwd.as_deref(), &sc.named, &stores).is_none() {
                return refuse("outside this chat's folder and files");
            }
            let Some((kind, mime)) = media::sniff(&name, &head(&p)) else { return refuse("not a picture, movie, sound, PDF or explainer") };
            if kind == MediaKind::Explainer && meta.len() > media::MAX_EXPLAINER {
                return refuse("too large for an explainer (2 MB at most)");
            }
            let real = std::fs::canonicalize(&p).unwrap_or(p);
            let t = core.media.token_for(real.clone(), mime, kind);
            Granted {
                path: asked,
                name,
                url: Some(if kind == MediaKind::Explainer { format!("{}/{t}/frame", base_url()) } else { format!("{}/{t}", base_url()) }),
                thumb: matches!(kind, MediaKind::Image | MediaKind::Video | MediaKind::Pdf).then(|| format!("{}/{t}/thumb", base_url())),
                kind: Some(kind),
                mime: Some(mime),
                size: meta.len(),
                real: Some(real.to_string_lossy().into_owned()),
                error: None,
            }
        })
        .collect())
}

fn granted(core: &Core, token: &str) -> Option<PathBuf> {
    core.media.tokens.lock().unwrap().get(token).map(|g| g.path.clone())
}

/// Shows a granted file in Finder.
#[tauri::command(async)]
pub fn media_reveal(core: State<'_, Arc<Core>>, token: String) -> Res<()> {
    let p = granted(&core, &token).ok_or("not a file of this chat")?;
    if !p.is_file() {
        return Err("the file is gone (moved or deleted?)".into());
    }
    std::process::Command::new("/usr/bin/open").arg("-R").arg(&p).status().map_err(crate::err)?;
    Ok(())
}

/// Puts granted files on the pasteboard (Paste in Finder or another app pastes the files).
#[tauri::command(async)]
pub fn media_copy(core: State<'_, Arc<Core>>, tokens: Vec<String>) -> Res<()> {
    let paths: Vec<PathBuf> = tokens.iter().filter_map(|t| granted(&core, t)).filter(|p| p.is_file()).collect();
    if paths.is_empty() {
        return Err("nothing to copy".into());
    }
    if native::copy_files(&paths) { Ok(()) } else { Err("couldn't copy".into()) }
}

// ---------- the scheme ----------

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(code).header("Cache-Control", "no-store").body(Vec::new()).unwrap()
}

/// `bytes=a-b`, `bytes=a-`, `bytes=-n` → (start, end inclusive) within `size`.
fn parse_range(h: &str, size: u64) -> Option<(u64, u64)> {
    let r = h.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = r.split_once('-')?;
    if size == 0 {
        return None;
    }
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (size.saturating_sub(n), size - 1)
    } else {
        let s: u64 = a.parse().ok()?;
        let e = if b.is_empty() { size - 1 } else { b.parse::<u64>().ok()?.min(size - 1) };
        (s, e)
    };
    (start <= end && start < size).then_some((start, end))
}

/// Serves `coool-media://localhost/<token>[/thumb]` (called on a worker thread).
pub fn serve(core: &Core, webview: &str, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if webview != "main" {
        return status(StatusCode::FORBIDDEN);
    }
    if req.method() != "GET" && req.method() != "HEAD" {
        return status(StatusCode::METHOD_NOT_ALLOWED);
    }
    let path = req.uri().path().trim_start_matches('/');
    let (token, rest) = path.split_once('/').unwrap_or((path, ""));
    let Some((file, mime, kind)) = core.media.tokens.lock().unwrap().get(token).map(|g| (g.path.clone(), g.mime, g.kind)) else {
        return status(StatusCode::NOT_FOUND);
    };
    // Still the file granted: a regular file whose resolved path is itself (no symlink swapped in since).
    let ok = std::fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_file()) && std::fs::canonicalize(&file).is_ok_and(|c| c == file);
    if !ok {
        return status(StatusCode::NOT_FOUND);
    }
    if rest == "thumb" {
        return match thumb(core, token, &file, kind) {
            Some(b) => Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", if b.starts_with(b"\x89PNG") { "image/png" } else { "image/jpeg" })
                .header("Cache-Control", "private, max-age=600")
                .header("X-Content-Type-Options", "nosniff")
                .body(b.to_vec())
                .unwrap(),
            None => status(StatusCode::NOT_FOUND),
        };
    }
    // An explainer is only ever a sandboxed frame's page.
    if kind == MediaKind::Explainer {
        return if rest == "frame" { frame(&file, mime) } else { status(StatusCode::NOT_FOUND) };
    }
    if !rest.is_empty() {
        return status(StatusCode::NOT_FOUND);
    }
    let Ok(mut f) = std::fs::File::open(&file) else { return status(StatusCode::NOT_FOUND) };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let range = req.headers().get("range").and_then(|v| v.to_str().ok()).map(|h| parse_range(h, size));
    let (start, end, partial) = match range {
        Some(None) => {
            return Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE).header("Content-Range", format!("bytes */{size}")).body(Vec::new()).unwrap();
        }
        Some(Some((s, e))) => (s, e.min(s + CHUNK - 1), true),
        None if size > WHOLE => (0, CHUNK.min(size) - 1, true),
        None => (0, size.saturating_sub(1), false),
    };
    let len = if size == 0 { 0 } else { end - start + 1 };
    let mut body = vec![0u8; if req.method() == "HEAD" { 0 } else { len as usize }];
    if !body.is_empty() && (f.seek(SeekFrom::Start(start)).is_err() || f.read_exact(&mut body).is_err()) {
        return status(StatusCode::NOT_FOUND);
    }
    let mut r = Response::builder()
        .status(if partial { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", len.to_string())
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        // A PDF or SVG must never run as a page of the app's origin.
        .header("Content-Security-Policy", "default-src 'none'; sandbox");
    if partial {
        r = r.header("Content-Range", format!("bytes {start}-{end}/{size}"));
    }
    r.body(body).unwrap()
}

/// What an explainer's frame may do: run its own inline script and style, show `data:` / `blob:` pictures, fonts and
/// media. Nothing is fetched (no `connect-src`, no remote anything) and forms go nowhere; only the main webview gets it.
pub const FRAME_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'";

/// Tells the chat how tall the explainer is (its frame grows to fit, up to a maximum).
const SIZE_SCRIPT: &str = "<script>(function(){function s(){var d=document.documentElement,b=document.body;parent.postMessage({cooolFrame:1,h:Math.ceil(Math.max(d.scrollHeight,b?b.scrollHeight:0))},'*')}try{new ResizeObserver(s).observe(document.documentElement)}catch(e){}addEventListener('load',s);s()})()</script>";

/// The page of an explainer's frame: the HTML as it is, or the SVG inline in a bare page, plus the height script.
pub fn frame_page(src: &str, svg: bool) -> String {
    let src = src.trim_start_matches('\u{feff}');
    if svg {
        // The SVG as an element of the page: its prolog and doctype go.
        let body = src.find("<svg").map_or(src, |i| &src[i..]);
        return format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><style>html,body{{margin:0;background:transparent}}body>svg{{display:block;max-width:100%;height:auto;margin:0 auto}}</style></head><body>{body}{SIZE_SCRIPT}</body></html>"
        );
    }
    match src.rfind("</body>") {
        Some(i) => format!("{}{SIZE_SCRIPT}{}", &src[..i], &src[i..]),
        None => format!("{src}{SIZE_SCRIPT}"),
    }
}

fn frame(file: &Path, mime: &str) -> Response<Vec<u8>> {
    let Ok(meta) = std::fs::metadata(file) else { return status(StatusCode::NOT_FOUND) };
    if meta.len() > media::MAX_EXPLAINER {
        return status(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let Ok(bytes) = std::fs::read(file) else { return status(StatusCode::NOT_FOUND) };
    let page = frame_page(&String::from_utf8_lossy(&bytes), mime == "image/svg+xml");
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", FRAME_CSP)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .body(page.into_bytes())
        .unwrap()
}

fn thumb(core: &Core, token: &str, file: &Path, kind: MediaKind) -> Option<Arc<Vec<u8>>> {
    let stamp = std::fs::metadata(file).ok().map(|m| m.len() ^ m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs()))?;
    if let Some((s, b)) = core.media.thumbs.lock().unwrap().get(token)
        && *s == stamp
    {
        return Some(b.clone());
    }
    let bytes = match kind {
        MediaKind::Image => native::image_thumb(file, THUMB),
        MediaKind::Video => {
            let d = native::video_info(file).map(|i| i.duration).unwrap_or(0.0);
            // A frame a little way in: the first is often black.
            native::frames_at(file, &[(d * 0.1).min(1.0)], THUMB, 0.75, false).into_iter().next().map(|(_, b)| b)
        }
        MediaKind::Pdf => crate::attach::pdf_thumb(file, THUMB as f64),
        MediaKind::Audio | MediaKind::Explainer => None,
    }?;
    let b = Arc::new(bytes);
    let mut t = core.media.thumbs.lock().unwrap();
    if t.len() >= MAX_THUMBS {
        t.clear();
    }
    t.insert(token.to_string(), (stamp, b.clone()));
    Some(b)
}

// ---------- screenshots the device tools take ----------

/// Keeps a screenshot a device tool returned (base64) in the capture folder; its path, for the tool's result.
pub fn save_capture(b64: &str, mime: &str) -> Option<PathBuf> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
    let dir = media::capture_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    let ext = if mime == "image/png" { "png" } else { "jpg" };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let name = format!("shot-{}-{:03}-{}.{ext}", now.as_secs(), now.subsec_millis(), &attach::key_of(b64)[..6]);
    let p = dir.join(name);
    std::fs::write(&p, bytes).ok()?;
    prune(&dir);
    Some(p)
}

fn prune(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut shots: Vec<(std::time::SystemTime, PathBuf)> = rd
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("shot-"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if shots.len() <= media::MAX_CAPTURES {
        return;
    }
    shots.sort();
    let n = shots.len() - media::MAX_CAPTURES;
    for (_, p) in shots.into_iter().take(n) {
        let _ = std::fs::remove_file(p);
    }
}

// ---------- key frames of an attached video ----------

/// A video the person attached: its length and a few key frames (stored as images, sent after the message's own
/// images, see `coool_core::attach`); a sound: its length. Anything else is left as it is.
pub fn add_frames(a: &mut Attachment) {
    let Some(path) = a.path.clone() else { return };
    let p = Path::new(&path);
    let Some((kind, mime)) = media::sniff(&a.name, &head(p)) else { return };
    if !matches!(kind, MediaKind::Video | MediaKind::Audio) {
        return;
    }
    a.mime = mime.to_string();
    let Some(info) = native::video_info(p) else { return };
    a.duration = Some((info.duration * 10.0).round() / 10.0);
    if kind != MediaKind::Video || !info.has_video {
        return;
    }
    let Some(dir) = attach::store_dir() else { return };
    let n = media::frame_count(info.duration);
    let cands = native::signatures(p, &media::candidate_times(info.duration, n));
    let mut times = media::pick_frames(&cands, info.duration, n);
    if times.is_empty() {
        times = vec![0.0];
    }
    let frames: Vec<Frame> = native::frames_at(p, &times, media::FRAME_EDGE, media::FRAME_QUALITY, true)
        .into_iter()
        .filter_map(|(t, jpeg)| attach::store_image(&dir, &jpeg, "image/jpeg").ok().map(|(key, _)| Frame { key, t: (t * 10.0).round() / 10.0 }))
        .collect();
    if !frames.is_empty() {
        a.note = Some(format!("{} key frame{} go with it", frames.len(), if frames.len() == 1 { "" } else { "s" }));
    }
    a.frames = frames;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-1", 10), Some((0, 1)));
        assert_eq!(parse_range("bytes=4-", 10), Some((4, 9)));
        assert_eq!(parse_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(parse_range("bytes=8-100", 10), Some((8, 9)));
        assert_eq!(parse_range("bytes=10-", 10), None);
        assert_eq!(parse_range("bytes=5-2", 10), None);
        assert_eq!(parse_range("items=0-1", 10), None);
    }

    #[test]
    fn explainer_frames() {
        let h = frame_page("<html><body><p>hi</p></body></html>", false);
        assert!(h.starts_with("<html><body><p>hi</p><script>") && h.ends_with("</script></body></html>"), "{h}");
        let s = frame_page("\u{feff}<?xml version=\"1.0\"?><!DOCTYPE svg><svg viewBox=\"0 0 10 10\"><circle r=\"4\"/></svg>", true);
        assert!(s.contains("<body><svg viewBox") && !s.contains("<?xml") && !s.contains("DOCTYPE svg"), "{s}");
        // The frame's policy loads nothing from anywhere.
        for no in ["connect-src", "http:", "https:", "'self'", "*"] {
            assert!(!FRAME_CSP.contains(no), "{no}");
        }
        assert!(FRAME_CSP.starts_with("default-src 'none'"));
    }

    #[test]
    fn relative_paths_resolve_in_the_folder() {
        assert_eq!(expand("shots/a.png", Some(Path::new("/p"))), PathBuf::from("/p/shots/a.png"));
        assert_eq!(expand("/x/a.png", Some(Path::new("/p"))), PathBuf::from("/x/a.png"));
        assert_eq!(expand("file:///x/a.png", None), PathBuf::from("/x/a.png"));
    }
}
