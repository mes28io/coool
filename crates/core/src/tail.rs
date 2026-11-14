//! Incremental JSONL reader: remembers its offset and only parses new lines.

use std::fs::{File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Read size per syscall; bounds peak memory on the first pass over a huge transcript.
const CHUNK: usize = 1 << 20;

pub struct Tail {
    pub path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
    /// (dev, inode) of the file the offset refers to.
    ident: Option<(u64, u64)>,
}

#[cfg(unix)]
fn ident(m: &Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((m.dev(), m.ino()))
}

#[cfg(not(unix))]
fn ident(_: &Metadata) -> Option<(u64, u64)> {
    None
}

impl Tail {
    pub fn new(path: impl AsRef<Path>) -> Self {
        Self { path: path.as_ref().to_path_buf(), offset: 0, partial: Vec::new(), ident: None }
    }

    /// Resumes at `offset` (the end of a complete line) of the file whose
    /// identity is `ident`, e.g. from a persisted parse. The first read rewinds
    /// to the start if the file at `path` is no longer that file or is shorter.
    pub fn resume(path: impl AsRef<Path>, offset: u64, ident: Option<(u64, u64)>) -> Self {
        Self { path: path.as_ref().to_path_buf(), offset, partial: Vec::new(), ident }
    }

    /// Bytes fully consumed as complete lines (excludes a held-back partial line).
    pub fn consumed(&self) -> u64 {
        self.offset - self.partial.len() as u64
    }

    /// (dev, inode) of the file read so far, once known.
    pub fn ident(&self) -> Option<(u64, u64)> {
        self.ident
    }

    /// Detects truncation or replacement (a different file now at `path`) and,
    /// if so, rewinds to the start. Returns true when it rewound, so callers can
    /// drop state derived from the old content before re-reading.
    pub fn rewound(&mut self) -> bool {
        let Ok(m) = std::fs::metadata(&self.path) else { return false };
        self.check(&m)
    }

    /// [`Tail::rewound`] with metadata the caller already has for `path`.
    pub fn rewound_with(&mut self, m: &Metadata) -> bool {
        self.check(m)
    }

    fn check(&mut self, m: &Metadata) -> bool {
        let id = ident(m);
        let replaced = self.ident.is_some() && id != self.ident;
        self.ident = id;
        if (replaced || m.len() < self.offset) && (self.offset > 0 || !self.partial.is_empty()) {
            self.offset = 0;
            self.partial.clear();
            return true;
        }
        false
    }

    /// Returns complete new lines since the last call.
    pub fn read_lines(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        self.for_each_line(|l| out.push(l.to_string()));
        out
    }

    /// Calls `f` for every complete new line since the last call, reading in
    /// bounded chunks. A trailing line without '\n' is held back until it is
    /// completed. Empty lines are skipped and a trailing '\r' is stripped.
    pub fn for_each_line(&mut self, f: impl FnMut(&str)) {
        self.for_each_line_limit(u64::MAX, f);
    }

    /// Like [`Tail::for_each_line`], but stops after reading about `max` bytes
    /// (whole chunks). Returns true when it reached the end of the file as it
    /// was when the call started (or the file can't be read).
    pub fn for_each_line_limit(&mut self, max: u64, mut f: impl FnMut(&str)) -> bool {
        let Ok(mut file) = File::open(&self.path) else { return true };
        let Ok(m) = file.metadata() else { return true };
        self.check(&m);
        if m.len() == self.offset {
            return true;
        }
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return true;
        }
        let (start_offset, end) = (self.offset, m.len());
        // Sized to what's there (small appends are the common case), at least 64 KiB.
        let mut buf = vec![0u8; CHUNK.min(usize::try_from(end.saturating_sub(self.offset)).unwrap_or(CHUNK).max(64 << 10))];
        loop {
            if self.offset - start_offset >= max {
                return self.offset >= end;
            }
            let n = match file.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            self.offset += n as u64;
            let mut start = 0;
            for i in memchr_all(&buf[..n]) {
                if self.partial.is_empty() {
                    emit(&buf[start..i], &mut f);
                } else {
                    self.partial.extend_from_slice(&buf[start..i]);
                    let line = std::mem::take(&mut self.partial);
                    emit(&line, &mut f);
                }
                start = i + 1;
            }
            self.partial.extend_from_slice(&buf[start..n]);
        }
        true
    }
}

fn memchr_all(b: &[u8]) -> impl Iterator<Item = usize> + '_ {
    b.iter().enumerate().filter(|(_, c)| **c == b'\n').map(|(i, _)| i)
}

fn emit(line: &[u8], f: &mut impl FnMut(&str)) {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if !line.is_empty() {
        f(&String::from_utf8_lossy(line));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("coool-tail-{}-{name}", std::process::id()));
        let _ = std::fs::remove_file(&d);
        d
    }

    fn append(p: &Path, s: &str) {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(p).unwrap();
        f.write_all(s.as_bytes()).unwrap();
    }

    #[test]
    fn holds_back_partial_line_until_complete() {
        let p = tmp("partial");
        append(&p, "{\"a\":1}\n{\"b\":");
        let mut t = Tail::new(&p);
        assert_eq!(t.read_lines(), vec!["{\"a\":1}"]);
        assert!(t.read_lines().is_empty());
        append(&p, "2}\r\n\n{\"c\":3}\n");
        assert_eq!(t.read_lines(), vec!["{\"b\":2}", "{\"c\":3}"]);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn multibyte_split_across_reads_is_intact() {
        let p = tmp("utf8");
        let s = "héllo ✓ 漢字";
        let bytes = s.as_bytes();
        let cut = 2; // inside 'é'
        std::fs::write(&p, &bytes[..cut]).unwrap();
        let mut t = Tail::new(&p);
        assert!(t.read_lines().is_empty());
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(&bytes[cut..]).unwrap();
        f.write_all(b"\n").unwrap();
        assert_eq!(t.read_lines(), vec![s]);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn truncation_rewinds() {
        let p = tmp("trunc");
        append(&p, "one\ntwo\n");
        let mut t = Tail::new(&p);
        assert_eq!(t.read_lines().len(), 2);
        std::fs::write(&p, "x\n").unwrap();
        assert!(t.rewound());
        assert_eq!(t.read_lines(), vec!["x"]);
        assert!(!t.rewound());
        let _ = std::fs::remove_file(&p);
    }

    #[cfg(unix)]
    #[test]
    fn replacement_by_rename_rewinds() {
        let p = tmp("rename");
        append(&p, "one\n");
        let mut t = Tail::new(&p);
        assert_eq!(t.read_lines(), vec!["one"]);
        // Same-or-longer replacement: length check alone would read from the middle.
        let q = tmp("rename-new");
        std::fs::write(&q, "fresh-1\nfresh-2\n").unwrap();
        std::fs::rename(&q, &p).unwrap();
        assert_eq!(t.read_lines(), vec!["fresh-1", "fresh-2"]);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn large_input_spanning_chunks() {
        let p = tmp("large");
        let line = "x".repeat(CHUNK / 3 + 7);
        let body: String = (0..10).map(|i| format!("{i}{line}\n")).collect();
        std::fs::write(&p, &body).unwrap();
        let mut t = Tail::new(&p);
        let got = t.read_lines();
        assert_eq!(got.len(), 10);
        assert!(got.iter().enumerate().all(|(i, l)| l.starts_with(&i.to_string()) && l.len() == line.len() + 1));
        let _ = std::fs::remove_file(&p);
    }
}
