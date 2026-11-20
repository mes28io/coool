//! Attachments of a chat prompt: images and other files the person adds in the composer.
//!
//! What each CLI is sent (CHAT_SPEC "Attachments"):
//! - Claude Code (stream-json): every image as a real `image` content block (base64, PNG / JPEG / GIF / WebP, at most
//!   [`MAX_IMAGE_BYTES`]), before the text block; the text ends with one [`marker`] line per attachment, so the agent
//!   also has each file's path (and reads non-image files itself, with its own tools).
//! - Codex (app-server): every image as a `localImage` input (Codex reads and encodes the file), the text with the
//!   same marker lines.
//!
//! Every image coool sends is first copied into coool's own attachment store ([`store_dir`]), named by its key
//! (a hash of its base64): that copy is what is sent (Codex reads it), and what the app shows again when a chat is
//! reopened. An image in a transcript that is not in the store (a terminal chat's paste, or Codex's re-encoded copy)
//! is found by its key in that transcript ([`find_in_transcript`]); nothing else is ever read for display.

use anyhow::{Context, Result, bail};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

/// Attachments per message.
pub const MAX_COUNT: usize = 10;
/// Largest image sent as an image (Claude's API takes at most 5 MB of base64 per image). Larger ones are scaled down
/// first (`sips`, built into macOS), and refused if they still don't fit.
pub const MAX_IMAGE_BYTES: u64 = 3_750_000;
/// Largest image coool tries to scale down.
pub const MAX_IMAGE_SOURCE_BYTES: u64 = 40 * 1024 * 1024;
/// Largest pasted file (no path of its own: coool keeps a copy the agent reads).
pub const MAX_STORED_BYTES: u64 = 50 * 1024 * 1024;
/// Largest file previewed as text.
pub const MAX_PREVIEW_TEXT: u64 = 512 * 1024;
/// Largest image or PDF previewed.
pub const MAX_PREVIEW_BYTES: u64 = 30 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachKind {
    /// Sent as image input.
    Image,
    /// Sent as a path the agent reads.
    File,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    pub name: String,
    /// Media type, e.g. `image/png`, `text/plain`, `application/pdf` (`application/octet-stream` when unknown).
    pub mime: String,
    pub size: u64,
    pub kind: AttachKind,
    /// The file the agent is given (the original, or coool's copy of a pasted one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Images: the key of the image as sent ([`key_of`]); the app loads it with that key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// Why an image goes as a file instead (e.g. a format the CLIs can't take as an image).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Image formats both CLIs take as image input.
pub const IMAGE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

/// The media type from a name and the file's first bytes (the bytes win for images and PDFs).
pub fn detect(name: &str, head: &[u8]) -> String {
    let magic = if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if head.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some("image/webp")
    } else if head.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else if head.len() >= 12 && &head[4..8] == b"ftyp" && matches!(&head[8..12], b"heic" | b"heix" | b"mif1" | b"msf1" | b"hevc") {
        Some("image/heic")
    } else if head.starts_with(b"II*\0") || head.starts_with(b"MM\0*") {
        Some("image/tiff")
    } else if head.starts_with(b"BM") && name.to_ascii_lowercase().ends_with(".bmp") {
        Some("image/bmp")
    } else {
        None
    };
    if let Some(m) = magic {
        return m.into();
    }
    let ext = Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let m = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "heic" | "heif" => "image/heic",
        "tif" | "tiff" => "image/tiff",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "zip" => "application/zip",
        "mp4" | "mov" => "video/mp4",
        "mp3" | "wav" | "m4a" => "audio/mpeg",
        _ if is_text_ext(&ext) => "text/plain",
        _ if looks_text(head) => "text/plain",
        _ => "application/octet-stream",
    };
    m.into()
}

const TEXT_EXTS: &[&str] = &[
    "txt", "log", "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "m",
    "mm", "cs", "php", "sh", "zsh", "bash", "fish", "toml", "yaml", "yml", "ini", "cfg", "conf", "env", "xml", "css", "scss", "less", "sql",
    "graphql", "proto", "lua", "dart", "scala", "ex", "exs", "erl", "hs", "ml", "vue", "svelte", "astro", "tf", "gradle", "lock", "diff",
    "patch", "rst", "tex", "r", "jl", "zig", "nim", "dockerfile", "makefile", "gitignore", "editorconfig",
];

fn is_text_ext(ext: &str) -> bool {
    TEXT_EXTS.contains(&ext)
}

/// No NUL byte and valid UTF-8 (allowing a cut final character) in the first bytes.
pub fn looks_text(head: &[u8]) -> bool {
    if head.is_empty() || head.contains(&0) {
        return head.is_empty();
    }
    match std::str::from_utf8(head) {
        Ok(_) => true,
        Err(e) => e.valid_up_to() + 4 >= head.len(),
    }
}

/// The key of an image: FNV-1a 64 of its base64 text, as hex.
pub fn key_of(b64: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in b64.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn ext_for(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "bin",
    }
}

/// coool's own attachment store.
/// `COOOL_ATTACH_DIR` overrides it (self-tests keep their files apart).
pub fn store_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("COOOL_ATTACH_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d));
    }
    dirs::data_dir().map(|d| d.join("coool").join("attachments"))
}

/// A key as the store names files: 16 hex digits, nothing else.
pub fn valid_key(key: &str) -> bool {
    key.len() == 16 && key.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// The stored image of `key`, if the store has it.
pub fn stored(dir: &Path, key: &str) -> Option<(PathBuf, String)> {
    if !valid_key(key) {
        return None;
    }
    IMAGE_TYPES.iter().map(|m| (dir.join(format!("{key}.{}", ext_for(m))), m.to_string())).find(|(p, _)| p.is_file())
}

fn store_image(dir: &Path, bytes: &[u8], mime: &str) -> Result<(String, PathBuf)> {
    let key = key_of(&base64::engine::general_purpose::STANDARD.encode(bytes));
    let p = dir.join(format!("{key}.{}", ext_for(mime)));
    if !p.is_file() {
        std::fs::create_dir_all(dir)?;
        let tmp = dir.join(format!(".{key}.tmp{}", std::process::id()));
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, &p)?;
    }
    Ok((key, p))
}

/// Scales an image down with `sips` (built into macOS) until it fits [`MAX_IMAGE_BYTES`]: JPEG unless it is a PNG
/// that fits as one. Returns the bytes and their type.
fn shrink(src: &Path, mime: &str) -> Result<(Vec<u8>, String)> {
    let tmp = std::env::temp_dir().join(format!("coool-shrink-{}-{}", std::process::id(), key_of(&src.to_string_lossy())));
    std::fs::create_dir_all(&tmp)?;
    let out = (|| {
        for (edge, fmt) in [(2400, if mime == "image/png" { "png" } else { "jpeg" }), (2000, "jpeg"), (1600, "jpeg"), (1200, "jpeg")] {
            let dst = tmp.join(format!("o.{fmt}"));
            let ok = std::process::Command::new("/usr/bin/sips")
                .args(["-Z", &edge.to_string(), "-s", "format", fmt])
                .args(if fmt == "jpeg" { vec!["-s", "formatOptions", "82"] } else { vec![] })
                .arg(src)
                .arg("--out")
                .arg(&dst)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !ok {
                bail!("couldn't scale the image down");
            }
            let b = std::fs::read(&dst)?;
            if b.len() as u64 <= MAX_IMAGE_BYTES {
                return Ok((b, if fmt == "png" { "image/png".to_string() } else { "image/jpeg".to_string() }));
            }
        }
        bail!("too large, even scaled down")
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    out
}

fn head_of(path: &Path) -> Vec<u8> {
    let mut head = vec![0u8; 4096];
    let n = std::fs::File::open(path).and_then(|mut f| f.read(&mut head)).unwrap_or(0);
    head.truncate(n);
    head
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// A file the person dropped or picked: what it is, and for an image, its stored copy.
pub fn inspect_path(dir: &Path, path: &Path) -> Result<Attachment> {
    let meta = std::fs::metadata(path).with_context(|| "it can't be read (moved or deleted?)".to_string())?;
    if meta.is_dir() {
        bail!("folders can't be attached; add the files inside");
    }
    if !meta.is_file() {
        bail!("not a regular file");
    }
    let name = file_name(path);
    let size = meta.len();
    let head = head_of(path);
    let mime = detect(&name, &head);
    let mut a = Attachment { name, mime: mime.clone(), size, kind: AttachKind::File, path: Some(path.to_string_lossy().into_owned()), key: None, note: None };
    if IMAGE_TYPES.contains(&mime.as_str()) {
        if size > MAX_IMAGE_SOURCE_BYTES {
            bail!("too large: images can be up to {} MB", MAX_IMAGE_SOURCE_BYTES / 1024 / 1024);
        }
        let (bytes, m) = if size > MAX_IMAGE_BYTES { shrink(path, &mime)? } else { (std::fs::read(path)?, mime.clone()) };
        let (key, _) = store_image(dir, &bytes, &m)?;
        a.kind = AttachKind::Image;
        a.key = Some(key);
        if m != mime || bytes.len() as u64 != size {
            a.note = Some("scaled down to fit".into());
        }
    } else if matches!(mime.as_str(), "image/heic" | "image/tiff" | "image/bmp" | "image/svg+xml") {
        a.note = Some("sent as a file: this image type can't be sent as an image".into());
    }
    Ok(a)
}

/// Pasted content without a path of its own (a clipboard image, a file the webview only gave as bytes): images go
/// to the store like dropped ones; other files are kept there too (named by their key) so the agent can read them.
pub fn store_bytes(dir: &Path, name: &str, bytes: &[u8]) -> Result<Attachment> {
    let size = bytes.len() as u64;
    let mime = detect(name, &bytes[..bytes.len().min(4096)]);
    let clean: String = name.chars().filter(|c| !c.is_control() && *c != '/').collect::<String>();
    let name = if clean.trim().is_empty() || clean == "." || clean == ".." { "pasted".to_string() } else { clean };
    if IMAGE_TYPES.contains(&mime.as_str()) {
        if size > MAX_IMAGE_BYTES {
            // Scaled through a file of its own.
            let tmp = std::env::temp_dir().join(format!("coool-paste-{}-{}.{}", std::process::id(), key_of(name.as_str()), ext_for(&mime)));
            std::fs::write(&tmp, bytes)?;
            let r = shrink(&tmp, &mime);
            let _ = std::fs::remove_file(&tmp);
            let (b, m) = r?;
            let (key, p) = store_image(dir, &b, &m)?;
            return Ok(Attachment { name, mime: m, size: b.len() as u64, kind: AttachKind::Image, path: Some(p.to_string_lossy().into_owned()), key: Some(key), note: Some("scaled down to fit".into()) });
        }
        let (key, p) = store_image(dir, bytes, &mime)?;
        return Ok(Attachment { name, mime, size, kind: AttachKind::Image, path: Some(p.to_string_lossy().into_owned()), key: Some(key), note: None });
    }
    if size > MAX_STORED_BYTES {
        bail!("too large: pasted files can be up to {} MB (drop it instead, so the agent reads it in place)", MAX_STORED_BYTES / 1024 / 1024);
    }
    let key = key_of(&base64::engine::general_purpose::STANDARD.encode(bytes));
    let sub = dir.join("files").join(&key);
    std::fs::create_dir_all(&sub)?;
    let p = sub.join(&name);
    if !p.is_file() {
        std::fs::write(&p, bytes)?;
    }
    Ok(Attachment { name, mime, size, kind: AttachKind::File, path: Some(p.to_string_lossy().into_owned()), key: None, note: None })
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;").replace('\n', " ")
}

fn unesc(s: &str) -> String {
    s.replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

/// The line that tells the agent about one attachment, e.g.
/// `<attachment kind="file" name="notes.txt" type="text/plain" size="120" path="/Users/me/notes.txt"/>`.
pub fn marker(a: &Attachment) -> String {
    let kind = if a.kind == AttachKind::Image { "image" } else { "file" };
    let mut s = format!(r#"<attachment kind="{kind}" name="{}" type="{}" size="{}""#, esc(&a.name), esc(&a.mime), a.size);
    if let Some(p) = &a.path {
        s.push_str(&format!(r#" path="{}""#, esc(p)));
    }
    s.push_str("/>");
    s
}

/// The prompt text as sent: the person's text, then one marker line per attachment.
pub fn with_markers(text: &str, atts: &[Attachment]) -> String {
    if atts.is_empty() {
        return text.to_string();
    }
    let lines: Vec<String> = atts.iter().map(marker).collect();
    let t = text.trim_end();
    if t.is_empty() { lines.join("\n") } else { format!("{t}\n\n{}", lines.join("\n")) }
}

fn attr(line: &str, name: &str) -> Option<String> {
    let pat = format!(r#" {name}=""#);
    let i = line.find(&pat)? + pat.len();
    let j = line[i..].find('"')?;
    Some(unesc(&line[i..i + j]))
}

fn parse_marker(line: &str) -> Option<Attachment> {
    let l = line.trim();
    if !l.starts_with("<attachment ") || !l.ends_with("/>") {
        return None;
    }
    let kind = match attr(l, "kind")?.as_str() {
        "image" => AttachKind::Image,
        _ => AttachKind::File,
    };
    Some(Attachment { name: attr(l, "name")?, mime: attr(l, "type").unwrap_or_else(|| "application/octet-stream".into()), size: attr(l, "size").and_then(|s| s.parse().ok()).unwrap_or(0), kind, path: attr(l, "path"), key: None, note: None })
}

/// Splits a prompt as sent into the person's text and the attachments its marker lines name (trailing lines only).
pub fn split_markers(text: &str) -> (String, Vec<Attachment>) {
    let lines: Vec<&str> = text.trim_end().lines().collect();
    let mut cut = lines.len();
    let mut atts = Vec::new();
    while cut > 0 {
        match parse_marker(lines[cut - 1]) {
            Some(a) => {
                atts.push(a);
                cut -= 1;
            }
            None => break,
        }
    }
    if atts.is_empty() {
        return (text.to_string(), atts);
    }
    atts.reverse();
    (lines[..cut].join("\n").trim_end().to_string(), atts)
}

/// Pairs a prompt's image markers with the images its message carried (keys, in order) and adds unnamed images
/// (a terminal paste) at the end.
pub fn merge_images(mut atts: Vec<Attachment>, images: Vec<(String, String, u64)>) -> Vec<Attachment> {
    let mut it = images.into_iter();
    for a in atts.iter_mut().filter(|a| a.kind == AttachKind::Image) {
        match it.next() {
            Some((key, mime, _)) => {
                a.key = Some(key);
                if a.mime.is_empty() {
                    a.mime = mime;
                }
            }
            None => break,
        }
    }
    let n0 = atts.iter().filter(|a| a.kind == AttachKind::Image).count();
    for (i, (key, mime, size)) in it.enumerate() {
        atts.push(Attachment { name: format!("Image {}", n0 + i + 1), mime, size, kind: AttachKind::Image, path: None, key: Some(key), note: None });
    }
    atts
}

/// One Claude content block's image: (key, type, approximate size). `data:` URLs (Codex's `input_image`) too.
pub fn block_image(b: &Value) -> Option<(String, String, u64)> {
    let (mime, data) = if b["type"] == "image" && b["source"]["type"] == "base64" {
        (b["source"]["media_type"].as_str()?.to_string(), b["source"]["data"].as_str()?)
    } else if b["type"] == "input_image" {
        let u = b["image_url"].as_str()?;
        let rest = u.strip_prefix("data:")?;
        let (m, d) = rest.split_once(";base64,")?;
        (m.to_string(), d)
    } else {
        return None;
    };
    Some((key_of(data), mime, (data.len() as u64) * 3 / 4))
}

/// Claude's content blocks for a prompt with attachments: images first, then the text with its markers.
pub fn claude_content(dir: &Path, text: &str, atts: &[Attachment]) -> Result<Value> {
    let mut blocks = Vec::new();
    for a in atts.iter().filter(|a| a.kind == AttachKind::Image) {
        let (p, mime) = a.key.as_deref().and_then(|k| stored(dir, k)).with_context(|| format!("{}: the image is gone from coool's store; attach it again", a.name))?;
        let data = base64::engine::general_purpose::STANDARD.encode(std::fs::read(&p)?);
        blocks.push(json!({"type": "image", "source": {"type": "base64", "media_type": mime, "data": data}}));
    }
    blocks.push(json!({"type": "text", "text": with_markers(text, atts)}));
    Ok(Value::Array(blocks))
}

/// Codex's `turn/start` input for a prompt with attachments: the text with its markers, then every image as a
/// `localImage` (coool's stored copy).
pub fn codex_input(dir: &Path, text: &str, atts: &[Attachment]) -> Result<Value> {
    let mut input = vec![json!({"type": "text", "text": with_markers(text, atts), "text_elements": []})];
    for a in atts.iter().filter(|a| a.kind == AttachKind::Image) {
        let (p, _) = a.key.as_deref().and_then(|k| stored(dir, k)).with_context(|| format!("{}: the image is gone from coool's store; attach it again", a.name))?;
        input.push(json!({"type": "localImage", "path": p.to_string_lossy()}));
    }
    Ok(Value::Array(input))
}

/// Looks for the image of `key` in a transcript (Claude `image` blocks, Codex `input_image` data URLs) and returns
/// its bytes and type. Only lines that carry base64 are parsed.
pub fn find_in_transcript(path: &Path, key: &str) -> Option<(Vec<u8>, String)> {
    if !valid_key(key) {
        return None;
    }
    let f = std::fs::File::open(path).ok()?;
    let mut r = BufReader::new(f);
    let mut line = String::new();
    loop {
        line.clear();
        if r.read_line(&mut line).ok()? == 0 {
            return None;
        }
        if !line.contains("base64") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let mut found = None;
        visit(&v, &mut |b| {
            if found.is_none()
                && let Some((k, mime, _)) = block_image(b)
                && k == key
            {
                found = Some((b.clone(), mime));
            }
        });
        if let Some((b, mime)) = found {
            let data = b["source"]["data"].as_str().map(str::to_string).or_else(|| b["image_url"].as_str().and_then(|u| u.split_once(";base64,")).map(|(_, d)| d.to_string()))?;
            let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).ok()?;
            return Some((bytes, mime));
        }
    }
}

fn visit(v: &Value, f: &mut dyn FnMut(&Value)) {
    match v {
        Value::Object(m) => {
            f(v);
            for x in m.values() {
                visit(x, f);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| visit(x, f)),
        _ => {}
    }
}

/// An image of a transcript, kept in the store from now on. Returns the stored file and its type.
pub fn image_from_transcript(dir: &Path, transcript: &Path, key: &str) -> Option<(PathBuf, String)> {
    if let Some(s) = stored(dir, key) {
        return Some(s);
    }
    let (bytes, mime) = find_in_transcript(transcript, key)?;
    if !IMAGE_TYPES.contains(&mime.as_str()) {
        return None;
    }
    let p = dir.join(format!("{key}.{}", ext_for(&mime)));
    std::fs::create_dir_all(dir).ok()?;
    std::fs::write(&p, &bytes).ok()?;
    Some((p, mime))
}

/// What a file preview shows (the person clicked a file chip or an image path).
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Preview {
    Text { text: String, truncated: bool, size: u64, mime: String },
    Image { data_url: String, size: u64, mime: String },
    Pdf { data_url: String, size: u64 },
    /// Nothing sensible to show inline (binary, too large, gone): the app offers Reveal in Finder.
    Other { size: u64, mime: String, reason: String },
}

/// A preview of a local file: text as text, an image or a PDF as a `data:` URL. Nothing is run or loaded from
/// elsewhere; the caller decides whether `path` may be read at all.
pub fn preview(path: &Path, images_only: bool) -> Result<Preview> {
    let meta = std::fs::metadata(path).context("the file is gone (moved or deleted?)")?;
    if !meta.is_file() {
        bail!("not a file");
    }
    let size = meta.len();
    let name = file_name(path);
    let head = head_of(path);
    let mime = detect(&name, &head);
    let enc = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    let is_img = IMAGE_TYPES.contains(&mime.as_str());
    if images_only && !is_img {
        bail!("not an image coool can show");
    }
    if is_img {
        if size > MAX_PREVIEW_BYTES {
            return Ok(Preview::Other { size, mime, reason: "too large to preview".into() });
        }
        let b = std::fs::read(path)?;
        return Ok(Preview::Image { data_url: format!("data:{mime};base64,{}", enc(&b)), size, mime });
    }
    if mime == "application/pdf" {
        if size > MAX_PREVIEW_BYTES {
            return Ok(Preview::Other { size, mime, reason: "too large to preview".into() });
        }
        let b = std::fs::read(path)?;
        return Ok(Preview::Pdf { data_url: format!("data:application/pdf;base64,{}", enc(&b)), size });
    }
    let texty = mime.starts_with("text/") || matches!(mime.as_str(), "application/json" | "image/svg+xml");
    if texty || looks_text(&head) {
        let mut b = Vec::new();
        std::fs::File::open(path)?.take(MAX_PREVIEW_TEXT).read_to_end(&mut b)?;
        if !looks_text(&b[..b.len().min(8192)]) {
            return Ok(Preview::Other { size, mime, reason: "not text".into() });
        }
        let text = String::from_utf8_lossy(&b).into_owned();
        return Ok(Preview::Text { text, truncated: size > MAX_PREVIEW_TEXT, size, mime });
    }
    Ok(Preview::Other { size, mime, reason: "no preview for this type".into() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("coool-attach-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89\0\0\0\rIDATx\x9cc\xf8\xcf\xc0\xf0\x1f\0\x05\0\x01\xff\x89\x99=\x1d\0\0\0\0IEND\xaeB`\x82";

    #[test]
    fn detects_types_by_bytes_then_name() {
        assert_eq!(detect("x.txt", PNG), "image/png");
        assert_eq!(detect("photo", &[0xff, 0xd8, 0xff, 0xe0]), "image/jpeg");
        assert_eq!(detect("a.pdf", b"%PDF-1.7"), "application/pdf");
        assert_eq!(detect("main.rs", b"fn main() {}"), "text/plain");
        assert_eq!(detect("README", b"hello\nworld"), "text/plain");
        assert_eq!(detect("blob", &[0, 1, 2, 3]), "application/octet-stream");
        assert_eq!(detect("shot.heic", &[0, 0, 0, 24, b'f', b't', b'y', b'p', b'h', b'e', b'i', b'c']), "image/heic");
        assert_eq!(detect("data.json", b"{}"), "application/json");
        assert!(looks_text("héllo".as_bytes()));
        assert!(!looks_text(b"a\0b"));
    }

    #[test]
    fn markers_round_trip_with_odd_names() {
        let atts = vec![
            Attachment { name: "a \"b\" <c>.png".into(), mime: "image/png".into(), size: 12, kind: AttachKind::Image, path: Some("/tmp/x & y/a.png".into()), key: Some("0123456789abcdef".into()), note: None },
            Attachment { name: "notes.txt".into(), mime: "text/plain".into(), size: 3, kind: AttachKind::File, path: Some("/tmp/notes.txt".into()), key: None, note: None },
        ];
        let sent = with_markers("look at these\n", &atts);
        assert!(sent.starts_with("look at these\n\n<attachment kind=\"image\""));
        let (text, back) = split_markers(&sent);
        assert_eq!(text, "look at these");
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].name, "a \"b\" <c>.png");
        assert_eq!(back[0].path.as_deref(), Some("/tmp/x & y/a.png"));
        assert_eq!(back[0].key, None, "keys come from the image blocks, not the text");
        assert_eq!((back[1].kind, back[1].size), (AttachKind::File, 3));
        // Text without markers, or with one in the middle, is left alone.
        assert_eq!(split_markers("plain").0, "plain");
        let mid = "<attachment kind=\"file\" name=\"a\" type=\"t\" size=\"1\"/>\nthen text";
        assert!(split_markers(mid).1.is_empty());
        // Only markers: empty text.
        assert_eq!(split_markers(&with_markers("", &atts[1..])).0, "");
    }

    #[test]
    fn images_pair_with_markers_and_extra_ones_get_names() {
        let (_, atts) = split_markers(&with_markers("x", &[Attachment { name: "s.png".into(), mime: "image/png".into(), size: 1, kind: AttachKind::Image, path: None, key: None, note: None }]));
        let m = merge_images(atts, vec![("aaaaaaaaaaaaaaaa".into(), "image/png".into(), 10), ("bbbbbbbbbbbbbbbb".into(), "image/jpeg".into(), 20)]);
        assert_eq!(m.len(), 2);
        assert_eq!((m[0].name.as_str(), m[0].key.as_deref()), ("s.png", Some("aaaaaaaaaaaaaaaa")));
        assert_eq!((m[1].name.as_str(), m[1].mime.as_str()), ("Image 2", "image/jpeg"));
    }

    #[test]
    fn what_each_cli_is_sent() {
        let d = tmp("send");
        let img = d.join("dot.png");
        std::fs::write(&img, PNG).unwrap();
        let txt = d.join("notes.txt");
        std::fs::write(&txt, "line one\nline two\n").unwrap();
        let store = d.join("store");
        let a = inspect_path(&store, &img).unwrap();
        let b = inspect_path(&store, &txt).unwrap();
        assert_eq!((a.kind, a.mime.as_str()), (AttachKind::Image, "image/png"));
        assert_eq!((b.kind, b.mime.as_str(), b.size), (AttachKind::File, "text/plain", 18));
        let key = a.key.clone().unwrap();
        assert!(stored(&store, &key).is_some());
        let atts = vec![a, b];

        let c = claude_content(&store, "what is this?", &atts).unwrap();
        assert_eq!(c[0]["type"], "image");
        assert_eq!(c[0]["source"]["media_type"], "image/png");
        assert_eq!(key_of(c[0]["source"]["data"].as_str().unwrap()), key, "the key is the hash of what Claude gets");
        assert_eq!(c[1]["type"], "text");
        let t = c[1]["text"].as_str().unwrap();
        assert!(t.starts_with("what is this?\n\n"));
        assert!(t.contains(&format!(r#"path="{}""#, txt.display())));

        let x = codex_input(&store, "what is this?", &atts).unwrap();
        assert_eq!(x[0]["type"], "text");
        assert_eq!(x[1]["type"], "localImage");
        assert!(x[1]["path"].as_str().unwrap().ends_with(&format!("{key}.png")));

        // A transcript that carries the image gives it back by key.
        let tr = d.join("t.jsonl");
        let line = json!({"type": "user", "message": {"content": c}}).to_string();
        std::fs::write(&tr, format!("{{\"type\":\"other\"}}\n{line}\n")).unwrap();
        let (bytes, mime) = find_in_transcript(&tr, &key).unwrap();
        assert_eq!((bytes.as_slice(), mime.as_str()), (PNG, "image/png"));
        assert!(find_in_transcript(&tr, "ffffffffffffffff").is_none());
        // ... and a Codex data URL as well.
        let data = base64::engine::general_purpose::STANDARD.encode(PNG);
        let cx = json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_image", "image_url": format!("data:image/png;base64,{data}")}]}}).to_string();
        std::fs::write(&tr, cx).unwrap();
        let fresh = d.join("store2");
        let (p, _) = image_from_transcript(&fresh, &tr, &key).unwrap();
        assert_eq!(std::fs::read(p).unwrap(), PNG);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn limits_and_refusals() {
        let d = tmp("limits");
        assert!(inspect_path(&d, &d).unwrap_err().to_string().contains("folders"));
        assert!(inspect_path(&d, &d.join("nope")).is_err());
        let heic = d.join("p.heic");
        std::fs::write(&heic, [0, 0, 0, 24, b'f', b't', b'y', b'p', b'h', b'e', b'i', b'c']).unwrap();
        let h = inspect_path(&d, &heic).unwrap();
        assert_eq!(h.kind, AttachKind::File);
        assert!(h.note.unwrap().contains("as a file"));
        // Pasted: an image is stored by key, other bytes in a folder of their own with their name.
        let p = store_bytes(&d, "clip.png", PNG).unwrap();
        assert_eq!(p.kind, AttachKind::Image);
        let f = store_bytes(&d, "../evil/name.txt", b"hi").unwrap();
        assert!(f.path.as_deref().unwrap().ends_with("..evilname.txt"));
        assert!(Path::new(f.path.as_deref().unwrap()).starts_with(&d));
        assert!(!valid_key("../../etc/passwd"));
        assert!(stored(&d, "../x").is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn previews() {
        let d = tmp("preview");
        std::fs::write(d.join("a.ts"), "const a = 1;\n").unwrap();
        std::fs::write(d.join("b.bin"), [0u8, 1, 2, 3, 0, 9]).unwrap();
        std::fs::write(d.join("c.png"), PNG).unwrap();
        assert!(matches!(preview(&d.join("a.ts"), false).unwrap(), Preview::Text { truncated: false, .. }));
        assert!(matches!(preview(&d.join("b.bin"), false).unwrap(), Preview::Other { .. }));
        assert!(matches!(preview(&d.join("c.png"), true).unwrap(), Preview::Image { .. }));
        assert!(preview(&d.join("a.ts"), true).is_err(), "an image-only preview refuses other files");
        let _ = std::fs::remove_dir_all(&d);
    }
}
