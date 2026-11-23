//! Media in a chat (CHAT_SPEC "Media"): what an agent shows with the `show` tool, which files are pictures, movies,
//! sounds, PDFs or explainers (a self-contained .html / .svg animation, drawn in a sandboxed frame), where coool keeps the screenshots its device tools take, which files the app may serve to the page,
//! and how a video the person attaches is cut down to a few key frames the agent can see.
//!
//! The pure parts live here (unit-tested); the app does the serving (`coool-media://`) and AVFoundation.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The `show` tool's name on coool's device server.
pub const SHOW_TOOL: &str = "show";
/// Paths one `show` call may name.
pub const MAX_SHOWN: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Image,
    Video,
    Audio,
    Pdf,
    /// A self-contained .html or .svg (an animation or interactive diagram), drawn in a sandboxed frame.
    Explainer,
}

/// Largest explainer served (it is one self-contained file).
pub const MAX_EXPLAINER: u64 = 2 * 1024 * 1024;
/// Bytes of a file's start [`sniff`] wants.
pub const HEAD: usize = 1024;

/// What a `show` call put in the chat: the files (as the agent named them) and its caption.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Shown {
    pub paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
}

/// Whether a tool call is coool's `show`: Claude `mcp__coool-device__show`, Codex `coool-device.show` (its rollouts
/// may name it `mcp__coool-device__show` or `coool-device__show` too).
pub fn is_show_tool(name: &str) -> bool {
    let Some(rest) = name.strip_suffix(SHOW_TOOL) else { return false };
    let server = rest.trim_end_matches(['.', '_', '/']);
    rest.len() > server.len() && (server.ends_with("coool-device") || server.ends_with("coool_device"))
}

/// The files and caption of a `show` call's input (`paths`, or a single `path`), at most [`MAX_SHOWN`].
pub fn shown(input: &Value) -> Option<Shown> {
    let mut paths: Vec<String> = match &input["paths"] {
        Value::Array(a) => a.iter().filter_map(|p| p.as_str()).map(|s| s.trim().to_string()).collect(),
        Value::String(s) => vec![s.trim().to_string()],
        _ => Vec::new(),
    };
    if let Some(p) = input["path"].as_str() {
        paths.push(p.trim().to_string());
    }
    paths.retain(|p| !p.is_empty());
    paths.truncate(MAX_SHOWN);
    if paths.is_empty() {
        return None;
    }
    let caption = input["caption"].as_str().map(|c| c.trim().chars().take(600).collect::<String>()).filter(|c| !c.is_empty());
    Some(Shown { paths, caption })
}

/// A file's kind by its name (the extension), for what the page shows before anything is read.
pub fn kind_by_name(name: &str) -> Option<MediaKind> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "heif" | "tif" | "tiff" | "bmp" => MediaKind::Image,
        "mp4" | "mov" | "m4v" | "webm" => MediaKind::Video,
        "m4a" | "mp3" | "wav" | "aac" | "aif" | "aiff" | "caf" => MediaKind::Audio,
        "pdf" => MediaKind::Pdf,
        "html" | "htm" | "svg" => MediaKind::Explainer,
        _ => return None,
    })
}

/// A file's kind and media type by its first bytes (and its name where bytes don't say: MP4 vs M4A, MP3).
pub fn sniff(name: &str, head: &[u8]) -> Option<(MediaKind, &'static str)> {
    let by_name = kind_by_name(name);
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some((MediaKind::Image, "image/png"));
    }
    if head.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some((MediaKind::Image, "image/jpeg"));
    }
    if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        return Some((MediaKind::Image, "image/gif"));
    }
    if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        return Some((MediaKind::Image, "image/webp"));
    }
    if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WAVE" {
        return Some((MediaKind::Audio, "audio/wav"));
    }
    if head.starts_with(b"%PDF-") {
        return Some((MediaKind::Pdf, "application/pdf"));
    }
    if head.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Some((MediaKind::Video, "video/webm"));
    }
    if head.starts_with(b"FORM") && head.len() >= 12 && (&head[8..12] == b"AIFF" || &head[8..12] == b"AIFC") {
        return Some((MediaKind::Audio, "audio/aiff"));
    }
    if head.starts_with(b"caff") {
        return Some((MediaKind::Audio, "audio/x-caf"));
    }
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        let brand = &head[8..12];
        return Some(match brand {
            b"heic" | b"heix" | b"mif1" | b"msf1" | b"hevc" | b"avif" => (MediaKind::Image, "image/heic"),
            b"qt  " => (MediaKind::Video, "video/quicktime"),
            b"M4A " | b"M4B " => (MediaKind::Audio, "audio/mp4"),
            _ if by_name == Some(MediaKind::Audio) => (MediaKind::Audio, "audio/mp4"),
            _ => (MediaKind::Video, "video/mp4"),
        });
    }
    // MPEG audio: an ID3 tag, or a frame sync.
    if head.starts_with(b"ID3") || (head.len() >= 2 && head[0] == 0xff && head[1] & 0xe0 == 0xe0 && by_name == Some(MediaKind::Audio)) {
        return Some((MediaKind::Audio, "audio/mpeg"));
    }
    if by_name == Some(MediaKind::Explainer) {
        // Text that is markup: an SVG must say so in its first bytes; HTML just needs a tag.
        let t = std::str::from_utf8(head).map(str::to_string).unwrap_or_else(|e| String::from_utf8_lossy(&head[..e.valid_up_to()]).into_owned());
        let t = t.trim_start_matches('\u{feff}').trim_start();
        if head.contains(&0) || !t.starts_with('<') {
            return None;
        }
        let svg = name.to_ascii_lowercase().ends_with(".svg");
        return if !svg { Some((MediaKind::Explainer, "text/html")) } else if t.contains("<svg") { Some((MediaKind::Explainer, "image/svg+xml")) } else { None };
    }
    match (by_name, head.is_empty()) {
        // A QuickTime file without `ftyp` (old .mov: `moov` / `mdat` / `wide` first).
        (Some(MediaKind::Video), false) if head.len() >= 8 && matches!(&head[4..8], b"moov" | b"mdat" | b"wide" | b"free" | b"skip") => Some((MediaKind::Video, "video/quicktime")),
        (Some(MediaKind::Image), false) if head.starts_with(b"II*\0") || head.starts_with(b"MM\0*") => Some((MediaKind::Image, "image/tiff")),
        (Some(MediaKind::Image), false) if head.starts_with(b"BM") => Some((MediaKind::Image, "image/bmp")),
        _ => None,
    }
}

/// Where coool keeps the screenshots its device tools take (`COOOL_CAPTURE_DIR` overrides, for self-tests).
pub fn capture_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("COOOL_CAPTURE_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d));
    }
    dirs::data_dir().map(|d| d.join("coool").join("captures"))
}

/// Screenshots kept: the newest this many (older ones are removed when a new one is saved).
pub const MAX_CAPTURES: usize = 400;

/// `path` with symlinks resolved, if it exists.
fn real(p: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(p).ok()
}

/// Whether `path` (resolved) lies inside `root` (resolved). A root of `/` or the home folder itself is no root.
pub fn inside(path: &Path, root: &Path) -> bool {
    let (Some(p), Some(r)) = (real(path), real(root)) else { return false };
    if r.parent().is_none() || dirs::home_dir().and_then(|h| real(&h)).is_some_and(|h| h == r) {
        return false;
    }
    p.starts_with(&r) && p != r
}

/// Why the page may be served `path`, given what the chat legitimately references: its folder, its attachments
/// and shown files (`named`: paths its messages and `show` calls named), coool's attachment store and capture
/// folder. None: not served.
pub fn allowed(path: &Path, cwd: Option<&Path>, named: &[PathBuf], stores: &[PathBuf]) -> Option<&'static str> {
    let p = real(path)?;
    if !std::fs::metadata(&p).is_ok_and(|m| m.is_file()) {
        return None;
    }
    if cwd.is_some_and(|c| inside(&p, c)) {
        return Some("folder");
    }
    if stores.iter().any(|s| inside(&p, s)) {
        return Some("store");
    }
    if named.iter().filter_map(|n| real(n)).any(|n| n == p) {
        return Some("named");
    }
    None
}

// ---------- key frames of a video the person attaches ----------

/// Key frames sent for a video: at most this many.
pub const MAX_FRAMES: usize = 6;
/// Longest edge of a key frame, in pixels (≈ 800 image tokens at 16:9).
pub const FRAME_EDGE: u32 = 1024;
/// JPEG quality of a key frame.
pub const FRAME_QUALITY: f64 = 0.72;

/// How many key frames for a video of `duration` seconds: one per ~8 s plus two, 1 to [`MAX_FRAMES`].
pub fn frame_count(duration: f64) -> usize {
    if !(duration > 0.0) {
        return 1;
    }
    if duration < 2.0 {
        return 1;
    }
    ((duration / 8.0).round() as usize + 2).clamp(2, MAX_FRAMES)
}

/// The times to sample small signatures at for scene detection: `4 n` evenly spaced (8 to 32), centred in their slots.
pub fn candidate_times(duration: f64, n: usize) -> Vec<f64> {
    if !(duration > 0.0) {
        return vec![0.0];
    }
    let m = (n * 4).clamp(8, 32);
    (0..m).map(|i| (i as f64 + 0.5) * duration / m as f64).collect()
}

fn diff(a: &[u8], b: &[u8]) -> f64 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    a.iter().zip(b).map(|(x, y)| (*x as f64 - *y as f64).abs()).sum::<f64>() / a.len() as f64
}

/// The key frames' times among sampled candidates (time, luma signature), in order: the first and the last (the
/// start and the end state of a screen recording), then the biggest scene changes (a frame unlike the one before
/// it, mean luma difference above `SCENE`), then times spread evenly to fill `n`. Picks keep a minimum gap.
pub fn pick_frames(cands: &[(f64, Vec<u8>)], duration: f64, n: usize) -> Vec<f64> {
    const SCENE: f64 = 6.0;
    if cands.is_empty() || n == 0 {
        return Vec::new();
    }
    let gap = if duration > 0.0 { duration / (n as f64 * 2.5) } else { 0.0 };
    let mut picks: Vec<f64> = vec![cands[0].0];
    let far = |picks: &[f64], t: f64| picks.iter().all(|p| (p - t).abs() >= gap);
    let last = cands[cands.len() - 1].0;
    if n > 1 && far(&picks, last) {
        picks.push(last);
    }
    // Scene changes, biggest first: the frame after the change shows the new scene.
    let mut changes: Vec<(f64, f64)> = cands.windows(2).map(|w| (diff(&w[0].1, &w[1].1), w[1].0)).filter(|(d, _)| *d > SCENE).collect();
    changes.sort_by(|a, b| b.0.total_cmp(&a.0));
    for (_, t) in changes {
        if picks.len() >= n {
            break;
        }
        if far(&picks, t) {
            picks.push(t);
        }
    }
    // Fill: the candidate farthest from every pick, until n.
    while picks.len() < n.min(cands.len()) {
        let best = cands.iter().map(|c| c.0).filter(|t| !picks.contains(t)).max_by(|a, b| {
            let da = picks.iter().map(|p| (p - a).abs()).fold(f64::MAX, f64::min);
            let db = picks.iter().map(|p| (p - b).abs()).fold(f64::MAX, f64::min);
            da.total_cmp(&db)
        });
        match best {
            Some(t) => picks.push(t),
            None => break,
        }
    }
    picks.sort_by(f64::total_cmp);
    picks
}

/// A time as the agent reads it: `0:07.5`, `1:02.0`.
pub fn clock(t: f64) -> String {
    let t = t.max(0.0);
    let m = (t / 60.0).floor() as u64;
    format!("{m}:{:04.1}", t - m as f64 * 60.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_show_tool_by_name() {
        for n in ["mcp__coool-device__show", "coool-device.show", "coool-device__show", "mcp__coool_device__show"] {
            assert!(is_show_tool(n), "{n}");
        }
        for n in ["show", "mcp__other__show", "mcp__coool-device__browser_screenshot", "coool-deviceshow", "mcp__coool-device__shows"] {
            assert!(!is_show_tool(n), "{n}");
        }
    }

    #[test]
    fn show_input() {
        let s = shown(&json!({"paths": ["a.png", " ", "/x/b.mp4"], "caption": " Before and after "})).unwrap();
        assert_eq!(s.paths, ["a.png", "/x/b.mp4"]);
        assert_eq!(s.caption.as_deref(), Some("Before and after"));
        assert_eq!(shown(&json!({"path": "c.m4a"})).unwrap().paths, ["c.m4a"]);
        assert_eq!(shown(&json!({"paths": "d.gif"})).unwrap().paths, ["d.gif"]);
        assert!(shown(&json!({"paths": []})).is_none());
        let many: Vec<String> = (0..20).map(|i| format!("{i}.png")).collect();
        assert_eq!(shown(&json!({ "paths": many })).unwrap().paths.len(), MAX_SHOWN);
    }

    #[test]
    fn kinds() {
        assert_eq!(kind_by_name("a/B.MOV"), Some(MediaKind::Video));
        assert_eq!(kind_by_name("x.m4a"), Some(MediaKind::Audio));
        assert_eq!(kind_by_name("x.txt"), None);
        assert_eq!(sniff("x.png", b"\x89PNG\r\n\x1a\n...."), Some((MediaKind::Image, "image/png")));
        assert_eq!(sniff("x.mov", b"\0\0\0\x14ftypqt  \0\0\0\0"), Some((MediaKind::Video, "video/quicktime")));
        assert_eq!(sniff("x.mp4", b"\0\0\0\x20ftypisom\0\0\x02\0"), Some((MediaKind::Video, "video/mp4")));
        assert_eq!(sniff("x.m4a", b"\0\0\0\x20ftypM4A \0\0\x02\0"), Some((MediaKind::Audio, "audio/mp4")));
        assert_eq!(sniff("x.wav", b"RIFF\0\0\0\0WAVEfmt "), Some((MediaKind::Audio, "audio/wav")));
        assert_eq!(sniff("x.mp3", b"ID3\x04\0\0\0\0"), Some((MediaKind::Audio, "audio/mpeg")));
        assert_eq!(sniff("x.pdf", b"%PDF-1.7"), Some((MediaKind::Pdf, "application/pdf")));
        // A name alone is not enough to serve: a text file called .png isn't a picture.
        assert_eq!(sniff("x.png", b"hello"), None);
        // Explainers: markup by name and bytes.
        assert_eq!(sniff("flow.html", b"\xef\xbb\xbf <!doctype html><title>x"), Some((MediaKind::Explainer, "text/html")));
        assert_eq!(sniff("a.svg", b"<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\">"), Some((MediaKind::Explainer, "image/svg+xml")));
        assert_eq!(sniff("a.svg", b"<html>not svg"), None);
        assert_eq!(sniff("a.html", b"plain text"), None);
        assert_eq!(kind_by_name("index.htm"), Some(MediaKind::Explainer));
    }

    #[test]
    fn what_may_be_served() {
        let tmp = std::env::temp_dir().join(format!("coool-media-allowed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let (cwd, store, other) = (tmp.join("proj"), tmp.join("store"), tmp.join("elsewhere"));
        for d in [&cwd, &store, &other] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(cwd.join("a.png"), b"x").unwrap();
        std::fs::write(store.join("s.jpg"), b"x").unwrap();
        std::fs::write(other.join("o.mp4"), b"x").unwrap();
        std::fs::write(other.join("secret.png"), b"x").unwrap();
        let stores = [store.clone()];
        assert_eq!(allowed(&cwd.join("a.png"), Some(&cwd), &[], &stores), Some("folder"));
        assert_eq!(allowed(&store.join("s.jpg"), Some(&cwd), &[], &stores), Some("store"));
        assert_eq!(allowed(&other.join("o.mp4"), Some(&cwd), &[other.join("o.mp4")], &stores), Some("named"));
        assert_eq!(allowed(&other.join("secret.png"), Some(&cwd), &[other.join("o.mp4")], &stores), None);
        // `..` out of the folder, and a symlink in the folder pointing out of it.
        assert_eq!(allowed(&cwd.join("../elsewhere/secret.png"), Some(&cwd), &[], &stores), None);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(other.join("secret.png"), cwd.join("link.png")).unwrap();
            assert_eq!(allowed(&cwd.join("link.png"), Some(&cwd), &[], &stores), None);
        }
        // A folder is no file; `/` and home are no roots.
        assert_eq!(allowed(&cwd, Some(&tmp), &[], &stores), None);
        assert_eq!(allowed(&other.join("secret.png"), Some(Path::new("/")), &[], &[]), None);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn frame_counts_and_candidates() {
        assert_eq!(frame_count(0.0), 1);
        assert_eq!(frame_count(1.5), 1);
        assert_eq!(frame_count(4.0), 3);
        assert_eq!(frame_count(20.0), 5);
        assert_eq!(frame_count(600.0), MAX_FRAMES);
        let c = candidate_times(10.0, 2);
        assert_eq!(c.len(), 8);
        assert!((c[0] - 0.625).abs() < 1e-9 && c[7] < 10.0);
        assert_eq!(candidate_times(1000.0, 6).len(), 24);
    }

    #[test]
    fn picks_first_last_and_scene_changes() {
        // 16 candidates over 16 s: dark until 5 s, bright from 5 s, a different scene from 11 s.
        let cands: Vec<(f64, Vec<u8>)> = (0..16)
            .map(|i| {
                let t = i as f64 + 0.5;
                let v = if t < 5.0 { 10 } else if t < 11.0 { 200 } else { 90 };
                (t, vec![v; 144])
            })
            .collect();
        let p = pick_frames(&cands, 16.0, 4);
        assert_eq!(p, vec![0.5, 5.5, 11.5, 15.5]);
        // No changes at all: spread evenly.
        let flat: Vec<(f64, Vec<u8>)> = (0..8).map(|i| (i as f64 * 2.0 + 1.0, vec![50; 144])).collect();
        let p = pick_frames(&flat, 16.0, 3);
        assert_eq!(p.len(), 3);
        assert_eq!((p[0], p[2]), (1.0, 15.0));
        assert!((p[1] - 7.0).abs() <= 2.0, "{p:?}");
        assert_eq!(pick_frames(&flat, 16.0, 1), vec![1.0]);
        assert!(pick_frames(&[], 16.0, 3).is_empty());
    }

    #[test]
    fn clock_times() {
        assert_eq!(clock(7.5), "0:07.5");
        assert_eq!(clock(62.04), "1:02.0");
        assert_eq!(clock(-1.0), "0:00.0");
    }
}
