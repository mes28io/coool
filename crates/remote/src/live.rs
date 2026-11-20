//! Minor 1 of the protocol (docs/REMOTE.md "Minor 1"): the parts that move more than a line of text, with their
//! limits. Images from the phone arrive in chunks ([`Uploads`]); images and device frames to the phone go out in
//! chunks ([`chunks`]); a chat's items are packed into messages that stay well under the relay's size limit
//! ([`pack`]). Pure logic, no I/O: the engine (mac.rs) calls these and the tests drive them directly.
//!
//! Sizes: the relay takes a ciphertext of at most 131 072 base64url characters (remote/relay/convex/lib.ts
//! `MAX_CIPHERTEXT`), about 98 KB of plaintext. A chunk carries [`CHUNK`] bytes as base64url inside the JSON
//! envelope (65 536 characters), so a sealed chunk is about 87 600 characters: a third of headroom.

use crate::proto;
use serde_json::{Value, json};
use std::collections::HashMap;

/// Raw bytes per chunk, both ways.
pub const CHUNK: usize = 48 * 1024;
/// Largest image the phone may send (it scales down first: 1600 px on the long side, JPEG). The Mac's own limit for
/// an image sent to an agent is higher (coool_core::attach::MAX_IMAGE_BYTES, 3.75 MB); this keeps the relay cheap.
pub const MAX_UPLOAD: usize = 2_000_000;
/// Parts of the largest upload.
pub const MAX_PARTS: usize = MAX_UPLOAD.div_ceil(CHUNK);
/// Uploads a device may have open at once.
pub const MAX_OPEN: usize = 4;
/// An upload not finished within this long is dropped.
pub const OPEN_MS: u64 = 120_000;
/// A finished upload waits this long for the `send` or `start` that names it.
pub const DONE_MS: u64 = 10 * 60_000;
/// Plaintext JSON per message the Mac aims for when packing a chat's items.
pub const PACK_BYTES: usize = 60_000;
/// Largest device frame sent (one message).
pub const MAX_FRAME: usize = 60_000;
/// Device frames: at most one per this long, while the phone looks.
pub const FRAME_MS: u64 = 2_500;
/// A `watch` or `watch_device` lasts this long unless renewed (the phone renews every 10 s while the view is open).
pub const LEASE_MS: u64 = 30_000;
/// A chat's live view is checked for changes at most this often.
pub const CHAT_TICK_MS: u64 = 700;

/// Minor 2: the largest recording the phone may send for transcription (AAC at about 24 kbit/s: two minutes is
/// about 360 KB), and the longest (checked once decoded).
pub const MAX_AUDIO: usize = 1_000_000;
pub const MAX_AUDIO_SECS: f32 = 120.0;

/// What an upload carries (minor 2 `kind`; absent: an image, as in minor 1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Image,
    /// A PDF or UTF-8 text (code, notes, data), by its bytes.
    File,
    /// A recording to transcribe (AAC in MPEG-4, or WAV), by its bytes. Never stored as an attachment.
    Audio,
}

/// File name endings kept for a text file from the phone (the Mac names the file; anything else becomes `.txt`).
pub const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "json", "yaml", "yml", "toml", "csv", "tsv", "xml", "html", "css", "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "swift", "kt", "java", "c", "h", "cc", "cpp", "hpp", "m", "mm", "cs", "php", "sh", "zsh", "bash", "sql", "lua", "pl", "r", "scala", "dart", "ex", "exs", "erl", "hs", "ml", "vue", "svelte", "ini", "cfg", "conf", "log", "diff", "patch", "gradle", "proto", "graphql", "tex",
];

/// A file the phone may send, by its bytes: a PDF, or UTF-8 text without NUL bytes. `partial`: only a first part
/// (a character may be cut at its end).
pub fn file_type(b: &[u8], partial: bool) -> Option<&'static str> {
    if b.starts_with(b"%PDF-") {
        return Some("application/pdf");
    }
    // Control bytes other than tabs, line ends and escapes: a binary, even when its bytes happen to be valid UTF-8.
    if b.is_empty() || b.iter().any(|&c| c < 0x09 || (0x0E..=0x1A).contains(&c) || (0x1C..=0x1F).contains(&c) || c == 0x7F) {
        return None;
    }
    match std::str::from_utf8(b) {
        Ok(_) => Some("text/plain"),
        // A first part may end inside a character: fine if the only problem is at the very end.
        Err(e) if partial && e.error_len().is_none() => Some("text/plain"),
        Err(_) => None,
    }
}

/// A recording the phone may send, by its bytes: AAC in an MPEG-4 container (`ftyp` at byte 4), or WAV.
pub fn audio_type(b: &[u8]) -> Option<&'static str> {
    if b.len() >= 12 && &b[4..8] == b"ftyp" {
        Some("audio/mp4")
    } else if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WAVE" {
        Some("audio/wav")
    } else {
        None
    }
}

fn type_of(kind: Kind, b: &[u8], partial: bool) -> Option<&'static str> {
    match kind {
        Kind::Image => image_type(b),
        Kind::File => file_type(b, partial),
        Kind::Audio => audio_type(b),
    }
}

fn refused(kind: Kind) -> String {
    match kind {
        Kind::Image => "only images (PNG, JPEG, GIF, WebP) can be sent from the phone".into(),
        Kind::File => "only PDFs and text files can be sent from the phone".into(),
        Kind::Audio => "only a recording (AAC or WAV) can be sent for transcription".into(),
    }
}

/// The image formats both CLIs take, by their first bytes (never by a name or a type the phone gives).
pub fn image_type(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if b.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

struct Open {
    parts: Vec<Option<Vec<u8>>>,
    size: usize,
    started: u64,
    kind: Kind,
}

/// A finished upload, checked by its bytes: an image, a file or a recording.
#[derive(Debug, PartialEq)]
pub struct Image {
    pub id: String,
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    /// Minor 2.
    pub kind: Kind,
    /// A file's ending as the Mac will name it: `pdf` for a PDF, one of [`TEXT_EXTS`] (as the phone suggested) or `txt`.
    pub ext: Option<String>,
}

/// Minor 2's name for it: an upload of any kind.
pub type Upload = Image;

/// What one `upload` part did.
#[derive(Debug, PartialEq)]
pub enum Step {
    /// Kept; more parts to come.
    More,
    /// The last part: the whole image.
    Done(Image),
}

/// The phone's uploads in progress, per device.
#[derive(Default)]
pub struct Uploads {
    open: HashMap<(String, String), Open>,
}

impl Uploads {
    /// One `upload` body: `{upload, part, parts, size, data}` (data: base64url of the part's bytes). Every part is
    /// checked against the sizes the first one declared; the finished bytes must be an image.
    pub fn take(&mut self, device: &str, b: &Value, now: u64) -> Result<Step, String> {
        self.open.retain(|_, o| now.saturating_sub(o.started) < OPEN_MS);
        let id = b.get("upload").and_then(Value::as_str).filter(|s| proto::is_id(s)).ok_or("not an upload id")?;
        let kind = match b.get("kind").and_then(Value::as_str) {
            None | Some("image") => Kind::Image,
            Some("file") => Kind::File,
            Some("audio") => Kind::Audio,
            Some(_) => return Err("unknown kind of upload".into()),
        };
        let n = |k: &str| b.get(k).and_then(Value::as_u64).map(|x| x as usize);
        let (Some(part), Some(parts), Some(size)) = (n("part"), n("parts"), n("size")) else { return Err("an upload part needs part, parts and size".into()) };
        let max = if kind == Kind::Audio { MAX_AUDIO } else { MAX_UPLOAD };
        if size == 0 || size > max {
            return Err(match kind {
                Kind::Audio => "a recording from the phone can be up to 1 MB (about two minutes)".into(),
                Kind::File => format!("files from the phone can be up to {} MB", MAX_UPLOAD / 1_000_000),
                Kind::Image => format!("images from the phone can be up to {} MB", MAX_UPLOAD / 1_000_000),
            });
        }
        if parts != size.div_ceil(CHUNK) || part >= parts {
            return Err("the parts don't match the size".into());
        }
        let data = b.get("data").and_then(Value::as_str).ok_or("missing data")?;
        let bytes = proto::unb64u(data, None).map_err(|_| "data is not base64url".to_string())?;
        let want = if part + 1 == parts { size - CHUNK * (parts - 1) } else { CHUNK };
        if bytes.len() != want {
            return Err("a part of the wrong length".into());
        }
        let key = (device.to_string(), id.to_string());
        if !self.open.contains_key(&key) {
            if self.open.keys().filter(|(d, _)| d == device).count() >= MAX_OPEN {
                return Err("too many images on their way at once".into());
            }
            self.open.insert(key.clone(), Open { parts: vec![None; parts], size, started: now, kind });
        }
        let o = self.open.get_mut(&key).expect("just made");
        if o.size != size || o.parts.len() != parts || o.kind != kind {
            self.open.remove(&key);
            return Err("the parts don't match the size".into());
        }
        if part == 0 && type_of(kind, &bytes, parts > 1).is_none() {
            self.open.remove(&key);
            return Err(refused(kind));
        }
        if kind == Kind::File && bytes.contains(&0) && !bytes.starts_with(b"%PDF-") && o.parts[0].as_ref().is_some_and(|p| !p.starts_with(b"%PDF-")) {
            self.open.remove(&key);
            return Err(refused(kind));
        }
        o.parts[part] = Some(bytes);
        if o.parts.iter().any(Option::is_none) {
            return Ok(Step::More);
        }
        let o = self.open.remove(&key).expect("there");
        let bytes: Vec<u8> = o.parts.into_iter().flatten().flatten().collect();
        let mime = type_of(kind, &bytes, false).ok_or_else(|| refused(kind))?;
        let ext = (kind == Kind::File).then(|| {
            if mime == "application/pdf" {
                "pdf".to_string()
            } else {
                let want = b.get("ext").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
                if TEXT_EXTS.contains(&want.as_str()) { want } else { "txt".into() }
            }
        });
        Ok(Step::Done(Image { id: id.to_string(), bytes, mime, kind, ext }))
    }

    pub fn forget_device(&mut self, device: &str) {
        self.open.retain(|(d, _), _| d != device);
    }
}

/// `bytes` as the bodies of `image` (or `frame`) messages: `{part, parts, data}` plus `extra`'s fields.
pub fn chunks(bytes: &[u8], extra: &Value) -> Vec<Value> {
    let parts = bytes.len().div_ceil(CHUNK).max(1);
    (0..parts)
        .map(|i| {
            let c = &bytes[(i * CHUNK).min(bytes.len())..((i + 1) * CHUNK).min(bytes.len())];
            let mut b = json!({"part": i, "parts": parts, "size": bytes.len(), "data": proto::b64u(c)});
            if let (Some(m), Value::Object(e)) = (b.as_object_mut(), extra) {
                m.extend(e.clone());
            }
            b
        })
        .collect()
}

/// Splits a chat's items into groups whose JSON stays under [`PACK_BYTES`] (an item alone over it is cut to fit).
pub fn pack(items: Vec<Value>) -> Vec<Vec<Value>> {
    let mut out: Vec<Vec<Value>> = vec![];
    let mut cur: Vec<Value> = vec![];
    let mut size = 0;
    for mut it in items {
        let mut n = it.to_string().len();
        if n > PACK_BYTES {
            for k in ["diff", "images"] {
                if let Some(m) = it.as_object_mut() {
                    m.remove(k);
                }
            }
            if let Some(t) = it.get("text").and_then(Value::as_str) {
                it["text"] = json!(t.chars().take(4_000).collect::<String>());
            }
            n = it.to_string().len();
        }
        if size + n > PACK_BYTES && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
            size = 0;
        }
        size += n;
        cur.push(it);
    }
    if !cur.is_empty() || out.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(len: usize) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
        b.resize(len, 7);
        b
    }

    fn part(id: &str, bytes: &[u8], i: usize) -> Value {
        let parts = bytes.len().div_ceil(CHUNK);
        let c = &bytes[i * CHUNK..((i + 1) * CHUNK).min(bytes.len())];
        json!({"upload": id, "part": i, "parts": parts, "size": bytes.len(), "data": proto::b64u(c)})
    }

    const ID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn an_image_arrives_in_parts_in_any_order() {
        let img = png(CHUNK * 2 + 10);
        let mut u = Uploads::default();
        assert_eq!(u.take("d", &part(ID, &img, 1), 0), Ok(Step::More));
        assert_eq!(u.take("d", &part(ID, &img, 1), 0), Ok(Step::More), "a repeated part is harmless");
        assert_eq!(u.take("d", &part(ID, &img, 0), 0), Ok(Step::More));
        let Ok(Step::Done(done)) = u.take("d", &part(ID, &img, 2), 0) else { panic!() };
        assert_eq!((done.bytes, done.mime, done.kind), (img, "image/png", Kind::Image));
        // Another device's upload of the same id is its own.
        assert_eq!(u.take("e", &part(ID, &png(CHUNK + 1), 0), 0), Ok(Step::More));
    }

    #[test]
    fn an_upload_that_is_not_an_image_is_refused() {
        let mut u = Uploads::default();
        let text = b"#!/bin/sh\nrm -rf ~\n".to_vec();
        assert!(u.take("d", &part(ID, &text, 0), 0).is_err());
        // Even disguised: a PNG header on part 0 but the whole is checked again (part 0 is what holds the magic).
        let mut fake = png(CHUNK + 5);
        fake[..8].copy_from_slice(b"#!/bin/s");
        assert!(u.take("d", &part(ID, &fake, 0), 0).is_err());
    }

    #[test]
    fn sizes_and_parts_must_add_up() {
        let mut u = Uploads::default();
        let img = png(CHUNK + 5);
        let mut bad = part(ID, &img, 0);
        bad["size"] = json!(MAX_UPLOAD + 1);
        assert!(u.take("d", &bad, 0).is_err());
        let mut bad = part(ID, &img, 0);
        bad["parts"] = json!(5);
        assert!(u.take("d", &bad, 0).is_err());
        let mut bad = part(ID, &img, 1);
        bad["data"] = json!(proto::b64u(&[1, 2, 3]));
        assert!(u.take("d", &bad, 0).is_err());
        let mut bad = part(ID, &img, 0);
        bad["upload"] = json!("../../etc/passwd");
        assert!(u.take("d", &bad, 0).is_err());
        // A path or name never matters: there is no field for one.
        let mut named = part(ID, &img, 0);
        named["path"] = json!("/etc/hosts");
        assert_eq!(u.take("d", &named, 0), Ok(Step::More));
    }

    #[test]
    fn open_uploads_are_capped_and_expire() {
        let mut u = Uploads::default();
        let img = png(CHUNK + 5);
        for i in 0..MAX_OPEN {
            assert_eq!(u.take("d", &part(&format!("{i:032x}"), &img, 0), 0), Ok(Step::More));
        }
        assert!(u.take("d", &part(&format!("{:032x}", 99), &img, 0), 0).is_err());
        assert_eq!(u.take("e", &part(&format!("{:032x}", 99), &img, 0), 0), Ok(Step::More));
        // Two minutes later the old ones are gone: a new one fits, and an old one's last part starts it over.
        assert_eq!(u.take("d", &part(&format!("{:032x}", 98), &img, 0), OPEN_MS + 1), Ok(Step::More));
        assert_eq!(u.take("d", &part(&format!("{:032x}", 0), &img, 1), OPEN_MS + 1), Ok(Step::More));
    }

    fn kinded(id: &str, bytes: &[u8], i: usize, kind: &str, ext: Option<&str>) -> Value {
        let mut p = part(id, bytes, i);
        p["kind"] = json!(kind);
        if let Some(e) = ext {
            p["ext"] = json!(e);
        }
        p
    }

    #[test]
    fn files_are_pdf_or_text_by_their_bytes_and_the_mac_names_them() {
        let mut u = Uploads::default();
        let code = "fn main() {\n    println!(\"héllo\");\n}\n".repeat(4000).into_bytes();
        assert!(code.len() > CHUNK);
        let parts = code.len().div_ceil(CHUNK);
        for i in 0..parts - 1 {
            assert_eq!(u.take("d", &kinded(ID, &code, i, "file", Some("rs")), 0), Ok(Step::More));
        }
        let Ok(Step::Done(f)) = u.take("d", &kinded(ID, &code, parts - 1, "file", Some("rs")), 0) else { panic!() };
        assert_eq!((f.kind, f.mime, f.ext.as_deref()), (Kind::File, "text/plain", Some("rs")));
        // A name or path the phone gives never matters: an ending off the list becomes .txt; no field names a path.
        let Ok(Step::Done(f)) = u.take("d", &kinded("1123456789abcdef0123456789abcdef", b"hello", 0, "file", Some("../../etc/passwd")), 0) else { panic!() };
        assert_eq!(f.ext.as_deref(), Some("txt"));
        let Ok(Step::Done(f)) = u.take("d", &kinded("2123456789abcdef0123456789abcdef", b"hello", 0, "file", Some("sh\nrm")), 0) else { panic!() };
        assert_eq!(f.ext.as_deref(), Some("txt"));
        let Ok(Step::Done(f)) = u.take("d", &kinded("3123456789abcdef0123456789abcdef", b"%PDF-1.7\n\x00\x01binary", 0, "file", Some("txt")), 0) else { panic!() };
        assert_eq!((f.mime, f.ext.as_deref()), ("application/pdf", Some("pdf")));
    }

    #[test]
    fn wrong_type_or_oversized_files_and_recordings_are_refused() {
        let mut u = Uploads::default();
        // Binary that isn't a PDF, an executable, invalid UTF-8.
        for (i, bad) in [b"\x7fELF\x02\x01\x01\x00".to_vec(), b"\x7fELF\x02\x01".to_vec(), b"MZ\x90\x00\x03\x00".to_vec(), vec![0xff, 0xfe, 0x41], b"text with a \x00 NUL".to_vec(), b"bell\x07".to_vec()].iter().enumerate() {
            assert!(u.take("d", &kinded(&format!("{i:032x}"), bad, 0, "file", Some("txt")), 0).is_err(), "{bad:?}");
        }
        // An image sent as a file isn't text.
        assert!(u.take("d", &kinded("a123456789abcdef0123456789abcdef", &png(100), 0, "file", None), 0).is_err());
        // Too large.
        let mut big = kinded("b123456789abcdef0123456789abcdef", b"x", 0, "file", None);
        big["size"] = json!(MAX_UPLOAD + 1);
        assert!(u.take("d", &big, 0).is_err());
        // Recordings: AAC / WAV by their bytes, at most MAX_AUDIO.
        let m4a = [b"\x00\x00\x00\x1cftypM4A ".as_slice(), &[7u8; 300]].concat();
        let Ok(Step::Done(a)) = u.take("d", &kinded("c123456789abcdef0123456789abcdef", &m4a, 0, "audio", None), 0) else { panic!() };
        assert_eq!((a.kind, a.mime, a.ext), (Kind::Audio, "audio/mp4", None));
        assert!(u.take("d", &kinded("d123456789abcdef0123456789abcdef", b"#!/bin/sh\nrm -rf ~ more bytes", 0, "audio", None), 0).is_err());
        let mut long = kinded("e123456789abcdef0123456789abcdef", &m4a, 0, "audio", None);
        long["size"] = json!(MAX_AUDIO + 1);
        assert!(u.take("d", &long, 0).is_err(), "a recording over 1 MB");
        assert!(u.take("d", &kinded("f123456789abcdef0123456789abcdef", &m4a, 0, "video", None), 0).is_err(), "an unknown kind");
    }

    #[test]
    fn chunks_reassemble_and_fit_the_relay() {
        let img = png(CHUNK * 3 + 1);
        let cs = chunks(&img, &json!({"key": "k"}));
        assert_eq!(cs.len(), 4);
        let back: Vec<u8> = cs.iter().flat_map(|c| proto::unb64u(c["data"].as_str().unwrap(), None).unwrap()).collect();
        assert_eq!(back, img);
        // A sealed chunk (the envelope's JSON, encrypted, base64url) stays under the relay's 131 072 characters.
        let env = serde_json::to_vec(&proto::Envelope::new("image", cs[0].clone(), 1)).unwrap();
        assert!((env.len() + 16) * 4 / 3 + 4 < 131_072, "{}", env.len());
    }

    #[test]
    fn pack_keeps_messages_small() {
        let items: Vec<Value> = (0..40).map(|i| json!({"k": i, "text": "x".repeat(5_000)})).collect();
        let groups = pack(items);
        assert!(groups.len() > 1);
        assert!(groups.iter().all(|g| serde_json::to_string(g).unwrap().len() <= PACK_BYTES + 200));
        assert_eq!(groups.iter().map(Vec::len).sum::<usize>(), 40);
        let huge = pack(vec![json!({"k": 0, "text": "y".repeat(200_000), "diff": {"before": "z".repeat(100_000)}})]);
        assert!(serde_json::to_string(&huge).unwrap().len() < PACK_BYTES);
        assert_eq!(pack(vec![]).len(), 1);
    }
}
