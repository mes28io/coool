//! The whisper model files: a fixed catalogue on the official whisper.cpp model host (Hugging Face,
//! `ggerganov/whisper.cpp`), downloaded over HTTPS only when the person presses Download, resumable (pause keeps the
//! partial file), checked against the published SHA-256 before use, stored in coool's app data folder. Files the
//! person already has (`~/models/ggml-*.bin`, as 2relay expects) are found and can be used in place.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

const HOST: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

#[derive(Serialize, Clone, Copy, Debug)]
pub struct Spec {
    pub id: &'static str,
    pub file: &'static str,
    pub label: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
    /// Whisper's translate task works with it (the turbo models were trained without it).
    pub translates: bool,
    pub note: &'static str,
}

/// Sizes and hashes from the host's own LFS pointers (`…/raw/main/<file>`), checked when this list was written.
pub const CATALOG: &[Spec] = &[
    Spec {
        id: "base",
        file: "ggml-base.bin",
        label: "Base",
        bytes: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        translates: true,
        note: "Fastest. Fine for English; rough for other languages and translation.",
    },
    Spec {
        id: "small",
        file: "ggml-small.bin",
        label: "Small",
        bytes: 487_601_967,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        translates: true,
        note: "Fast. Good English, usable translation.",
    },
    Spec {
        id: "medium-q5_0",
        file: "ggml-medium-q5_0.bin",
        label: "Medium (compact)",
        bytes: 539_212_467,
        sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
        translates: true,
        note: "Recommended. Medium's translation quality at a third of its size.",
    },
    Spec {
        id: "medium",
        file: "ggml-medium.bin",
        label: "Medium",
        bytes: 1_533_763_059,
        sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
        translates: true,
        note: "What 2relay uses. Best translation here; slower and large.",
    },
    Spec {
        id: "large-v3-turbo-q5_0",
        file: "ggml-large-v3-turbo-q5_0.bin",
        label: "Large v3 Turbo (compact)",
        bytes: 574_041_195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        translates: false,
        note: "Best for “Transcribe as spoken”. Can't translate to English.",
    },
];

pub const RECOMMENDED: &str = "medium-q5_0";

pub fn spec(id: &str) -> Option<&'static Spec> {
    CATALOG.iter().find(|s| s.id == id)
}

/// A ggml whisper model file starts with the magic 0x67676d6c ("ggml", little-endian "lmgg").
pub fn looks_like_model(path: &Path) -> bool {
    let mut b = [0u8; 4];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut b)).is_ok() && u32::from_le_bytes(b) == 0x6767_6d6c
}

#[derive(Serialize, Clone, Debug)]
pub struct Found {
    pub path: String,
    pub bytes: u64,
    /// The catalogue id when the file name matches one.
    pub id: Option<String>,
    /// Where it was found: "coool" (downloaded here), "models" (~/models, 2relay's place), "other".
    pub place: &'static str,
}

/// Model files already on this Mac: coool's own folder, then `~/models` (2relay's default) and
/// `~/Library/Application Support/2relay` if present.
pub fn find_existing(dir: &Path) -> Vec<Found> {
    let mut out = Vec::new();
    let mut scan = |d: &Path, place: &'static str| {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        let mut v: Vec<_> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        v.sort();
        for p in v {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !(name.starts_with("ggml-") && name.ends_with(".bin")) || !p.is_file() || !looks_like_model(&p) {
                continue;
            }
            let bytes = p.metadata().map(|m| m.len()).unwrap_or(0);
            let id = CATALOG.iter().find(|s| s.file == name).map(|s| s.id.to_string());
            out.push(Found { path: p.to_string_lossy().into_owned(), bytes, id, place });
        }
    };
    scan(dir, "coool");
    if let Some(h) = dirs::home_dir() {
        scan(&h.join("models"), "models");
        scan(&h.join("Library/Application Support/2relay"), "other");
    }
    out
}

// ---------------------------------------------------------------- downloads

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum Progress {
    Downloading { bytes: u64, total: u64 },
    Paused { bytes: u64, total: u64 },
    Verifying { total: u64 },
    Done { path: String },
    Failed { error: String },
    Cancelled,
}

#[derive(Serialize, Clone, Debug)]
pub struct DownloadState {
    pub id: String,
    #[serde(flatten)]
    pub progress: Progress,
}

const RUN: u8 = 0;
const PAUSE: u8 = 1;
const CANCEL: u8 = 2;

pub struct Download {
    pub control: Arc<AtomicU8>,
    pub last: Arc<Mutex<Progress>>,
}

pub fn part_path(dir: &Path, s: &Spec) -> PathBuf {
    dir.join(format!("{}.part", s.file))
}

pub fn final_path(dir: &Path, s: &Spec) -> PathBuf {
    dir.join(s.file)
}

/// Starts (or resumes, from the partial file) a download on a thread of its own; `report` gets progress about
/// four times a second and every state change.
pub fn start(dir: &Path, s: &'static Spec, report: impl Fn(Progress) + Send + 'static) -> Download {
    let control = Arc::new(AtomicU8::new(RUN));
    let last = Arc::new(Mutex::new(Progress::Downloading { bytes: 0, total: s.bytes }));
    let (c2, l2, dir) = (control.clone(), last.clone(), dir.to_path_buf());
    std::thread::Builder::new()
        .name(format!("coool-voice-download-{}", s.id))
        .spawn(move || {
            let send = |p: Progress| {
                *l2.lock().unwrap() = p.clone();
                report(p);
            };
            let r = run(&dir, s, &c2, &send);
            match r {
                Ok(p) => send(p),
                Err(e) => send(Progress::Failed { error: e }),
            }
        })
        .ok();
    Download { control, last }
}

impl Download {
    pub fn pause(&self) {
        self.control.store(PAUSE, Ordering::Relaxed);
    }
    pub fn cancel(&self) {
        self.control.store(CANCEL, Ordering::Relaxed);
    }
}

fn run(dir: &Path, s: &Spec, control: &AtomicU8, send: &dyn Fn(Progress)) -> Result<Progress, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Can't create {}: {e}", dir.display()))?;
    let part = part_path(dir, s);
    let have = part.metadata().map(|m| m.len()).unwrap_or(0).min(s.bytes);
    let url = format!("{HOST}{}", s.file);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(std::time::Duration::from_secs(20)))
        .timeout_recv_body(None)
        .https_only(true)
        .http_status_as_error(false)
        .build()
        .into();
    let mut req = agent.get(&url).header("User-Agent", "coool");
    if have > 0 {
        req = req.header("Range", &format!("bytes={have}-"));
    }
    let mut resp = req.call().map_err(|e| format!("Network error: {e}"))?;
    let status = resp.status().as_u16();
    let resumed = status == 206;
    if !(status == 200 || resumed) {
        return Err(format!("The model host answered {status}."));
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&part)
        .map_err(|e| format!("Can't write {}: {e}", part.display()))?;
    let mut got = if resumed { have } else { 0 };
    let mut body = resp.body_mut().as_reader();
    let mut buf = vec![0u8; 256 * 1024];
    let mut last = std::time::Instant::now();
    send(Progress::Downloading { bytes: got, total: s.bytes });
    loop {
        match control.load(Ordering::Relaxed) {
            PAUSE => {
                file.flush().ok();
                return Ok(Progress::Paused { bytes: got, total: s.bytes });
            }
            CANCEL => {
                drop(file);
                let _ = std::fs::remove_file(&part);
                return Ok(Progress::Cancelled);
            }
            _ => {}
        }
        let n = body.read(&mut buf).map_err(|e| format!("Download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| format!("Can't write {}: {e}", part.display()))?;
        got += n as u64;
        if got > s.bytes {
            return Err("The file is larger than expected.".into());
        }
        if last.elapsed().as_millis() >= 250 {
            last = std::time::Instant::now();
            send(Progress::Downloading { bytes: got, total: s.bytes });
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    if got != s.bytes {
        return Err(format!("Download stopped at {got} of {} bytes. Press Resume to continue.", s.bytes));
    }
    send(Progress::Verifying { total: s.bytes });
    let sum = sha256_file(&part)?;
    if sum != s.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err("The downloaded file doesn't match the published checksum, so it was deleted.".into());
    }
    let dest = final_path(dir, s);
    std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    Ok(Progress::Done { path: dest.to_string_lossy().into_owned() })
}

pub fn sha256_file(p: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_sane() {
        assert!(spec(RECOMMENDED).is_some_and(|s| s.translates));
        for s in CATALOG {
            assert_eq!(s.sha256.len(), 64, "{}", s.id);
            assert!(s.file.starts_with("ggml-") && s.file.ends_with(".bin"));
            assert!(s.bytes > 50_000_000);
        }
    }

    #[test]
    fn model_magic() {
        let d = std::env::temp_dir().join(format!("coool-voice-magic-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let good = d.join("ggml-x.bin");
        std::fs::write(&good, [0x6c, 0x6d, 0x67, 0x67, 1, 2]).unwrap();
        let bad = d.join("ggml-y.bin");
        std::fs::write(&bad, b"nope").unwrap();
        assert!(looks_like_model(&good));
        assert!(!looks_like_model(&bad));
        let found = find_existing(&d);
        assert_eq!(found.iter().filter(|f| f.place == "coool").count(), 1);
        assert_eq!(sha256_file(&bad).unwrap(), "ca3704aa0b06f5954c79ee837faa152d84d6b2d42838f0637a15eda8337dbdce");
        std::fs::remove_dir_all(&d).unwrap();
    }
}
