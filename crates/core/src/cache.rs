//! Persistent parse cache, so a later launch resumes each transcript from
//! where the last one stopped instead of byte 0.
//!
//! Layout: `<cache_dir>/coool/transcripts-v<VERSION>/<fnv64(path)>.json`, one file
//! per transcript, user-only permissions. Each file is two lines: a small
//! header (path, file identity, offset, fingerprints) and the parse state.
//!
//! An entry is used only if everything still matches: format version, path,
//! (dev, inode), the file is at least `offset` long, and fingerprints of its
//! first and last 4 KiB before `offset` are unchanged. Anything else (or any
//! read/parse error) discards the entry and the file is parsed from scratch.
//!
//! What is stored is derived from the transcripts themselves (titles, prompt
//! and tool summaries, token counts, message ids); nothing else.

use crate::loader::{Kind, Parsed};
use crate::tail::Tail;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Bump whenever the parsers or [`Parsed`] change meaning: old entries are then
/// ignored (and pruned), never misread.
/// v2: Claude state records `entrypoint` / human turns, Codex state `originator`,
/// `source` and the subagent parent (session origin).
/// v3: activity entries keep their full text (`Activity::full`, `shortened`).
pub const VERSION: u32 = 6;
/// Bytes fingerprinted at the start and just before the saved offset.
const PRINT: u64 = 4096;
/// Total size the cache is kept under.
const MAX_BYTES: u64 = 64 << 20;
/// Entries not written for this long are dropped.
const MAX_AGE: Duration = Duration::from_secs(14 * 86400);

#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct Header {
    v: u32,
    kind: Kind,
    path: PathBuf,
    dev: u64,
    ino: u64,
    offset: u64,
    head: u64,
    tail: u64,
}

#[derive(Clone)]
pub struct Cache {
    dir: PathBuf,
    max_bytes: u64,
}

impl Cache {
    /// Transcripts smaller than this are cheap to parse and not cached.
    pub const MIN_LEN: u64 = 256 << 10;

    /// A cache rooted at `root` (the versioned subfolder is created on first save).
    pub fn at(root: impl Into<PathBuf>) -> Self {
        Self { dir: root.into().join(format!("transcripts-v{VERSION}")), max_bytes: MAX_BYTES }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn entry(&self, path: &Path) -> PathBuf {
        self.dir.join(format!("{:016x}.json", fnv(path.as_os_str().as_encoded_bytes())))
    }

    /// The saved state for `path`, if it is valid for the file as it is now.
    pub(crate) fn load(&self, path: &Path, kind: Kind) -> Option<(Tail, Parsed)> {
        let e = self.entry(path);
        let f = File::open(&e).ok()?;
        let r = self.read_valid(f, path, kind);
        if r.is_none() {
            // Stale or unreadable: it would only be rejected again.
            let _ = fs::remove_file(&e);
        }
        r
    }

    fn read_valid(&self, f: File, path: &Path, kind: Kind) -> Option<(Tail, Parsed)> {
        let mut r = BufReader::new(f);
        let mut line = String::new();
        r.by_ref().take(64 << 10).read_line(&mut line).ok()?;
        let h: Header = serde_json::from_str(line.trim_end()).ok()?;
        if h.v != VERSION || h.kind != kind || h.path != path || h.offset == 0 {
            return None;
        }
        let ident = file_ident(path)?;
        if ident != (h.dev, h.ino) {
            return None;
        }
        let (head, tail) = prints(path, h.offset)?;
        if (head, tail) != (h.head, h.tail) {
            return None;
        }
        let parsed: Parsed = serde_json::from_reader(r).ok()?;
        (parsed.kind() == kind).then(|| (Tail::resume(path, h.offset, Some(ident)), parsed))
    }

    /// Saves the state of a fully parsed file. Returns false if nothing was written.
    pub(crate) fn save(&self, path: &Path, t: &Tail, parsed: &Parsed) -> bool {
        let offset = t.consumed();
        if offset < Self::MIN_LEN {
            return false;
        }
        // The state must describe the file that is there now, read up to `offset`.
        let (Some(ident), Some(now)) = (t.ident(), file_ident(path)) else { return false };
        if ident != now {
            return false;
        }
        let Some((head, tail)) = prints(path, offset) else { return false };
        let h = Header { v: VERSION, kind: parsed.kind(), path: path.to_path_buf(), dev: ident.0, ino: ident.1, offset, head, tail };
        let (Ok(mut hl), Ok(body)) = (serde_json::to_vec(&h), serde_json::to_vec(parsed)) else { return false };
        hl.push(b'\n');
        if make_private_dir(&self.dir).is_err() {
            return false;
        }
        let e = self.entry(path);
        let tmp = e.with_extension(format!("tmp{}", std::process::id()));
        let ok = (|| -> std::io::Result<()> {
            let mut f = private_file(&tmp)?;
            f.write_all(&hl)?;
            f.write_all(&body)?;
            // No fsync: a torn entry after a crash fails validation and is dropped.
            fs::rename(&tmp, &e)
        })()
        .is_ok();
        if !ok {
            let _ = fs::remove_file(&tmp);
        }
        ok
    }

    /// Removes entries for files that are gone, old or orphaned entries, other
    /// format versions, and the oldest entries beyond the size cap.
    pub fn prune(&self) {
        if let Some(root) = self.dir.parent()
            && let Ok(rd) = fs::read_dir(root)
        {
            let mine = self.dir.file_name();
            for d in rd.flatten() {
                let n = d.file_name();
                if n.to_string_lossy().starts_with("transcripts-v") && Some(n.as_os_str()) != mine {
                    let _ = fs::remove_dir_all(d.path());
                }
            }
        }
        let Ok(rd) = fs::read_dir(&self.dir) else { return };
        let now = SystemTime::now();
        let mut kept: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
        for d in rd.flatten() {
            let p = d.path();
            let Ok(m) = d.metadata() else { continue };
            let mtime = m.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let old = now.duration_since(mtime).is_ok_and(|a| a > MAX_AGE);
            let is_entry = p.extension().is_some_and(|e| e == "json");
            // Leftover temp files from an interrupted save (any age > a minute).
            let stale_tmp = !is_entry && now.duration_since(mtime).is_ok_and(|a| a > Duration::from_secs(60));
            if stale_tmp || (is_entry && (old || !source_exists(&p))) {
                let _ = fs::remove_file(&p);
            } else if is_entry {
                kept.push((mtime, m.len(), p));
            }
        }
        let mut total: u64 = kept.iter().map(|k| k.1).sum();
        kept.sort();
        for (_, len, p) in kept {
            if total <= self.max_bytes {
                break;
            }
            let _ = fs::remove_file(&p);
            total -= len;
        }
    }
}

/// Whether the transcript an entry describes still exists (unreadable entry: no).
fn source_exists(entry: &Path) -> bool {
    let Ok(f) = File::open(entry) else { return false };
    let mut line = String::new();
    if BufReader::new(f).take(64 << 10).read_line(&mut line).is_err() {
        return false;
    }
    serde_json::from_str::<Header>(line.trim_end()).is_ok_and(|h| h.path.exists())
}

/// FNV-1a, 64-bit: stable across builds (unlike std's hasher).
fn fnv(b: &[u8]) -> u64 {
    b.iter().fold(0xcbf2_9ce4_8422_2325, |h, &c| (h ^ c as u64).wrapping_mul(0x0100_0000_01b3))
}

/// Fingerprints of `path`'s first bytes and the bytes just before `offset`.
fn prints(path: &Path, offset: u64) -> Option<(u64, u64)> {
    let mut f = File::open(path).ok()?;
    if f.metadata().ok()?.len() < offset {
        return None;
    }
    let n = PRINT.min(offset);
    let mut buf = vec![0u8; n as usize];
    f.read_exact(&mut buf).ok()?;
    let head = fnv(&buf);
    f.seek(SeekFrom::Start(offset - n)).ok()?;
    f.read_exact(&mut buf).ok()?;
    Some((head, fnv(&buf)))
}

#[cfg(unix)]
fn file_ident(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let m = fs::metadata(path).ok()?;
    Some((m.dev(), m.ino()))
}

/// Without a file identity a replaced file can't be told apart: never cache.
#[cfg(not(unix))]
fn file_ident(_: &Path) -> Option<(u64, u64)> {
    None
}

fn make_private_dir(d: &Path) -> std::io::Result<()> {
    if d.is_dir() {
        return Ok(());
    }
    let mut b = fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(d)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(d, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn private_file(p: &Path) -> std::io::Result<File> {
    let mut o = fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    o.open(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loader::tests::{claude_transcript, codex_transcript, full_parse, same, tmpdir};
    use std::io::Write;

    fn parse(path: &Path, kind: Kind) -> (Tail, Parsed) {
        let mut t = Tail::new(path);
        let mut p = match kind {
            Kind::Claude => Parsed::Claude(Default::default()),
            Kind::Codex => Parsed::Codex(Default::default()),
        };
        t.for_each_line(|l| p.line(l));
        (t, p)
    }

    fn view(p: &Parsed) -> crate::loader::View {
        match p {
            Parsed::Claude(c) => c.view(),
            Parsed::Codex(c) => c.view(),
        }
    }

    fn setup(name: &str, body: &str) -> (PathBuf, PathBuf, Cache) {
        let d = tmpdir(name);
        let p = d.join("t.jsonl");
        fs::write(&p, body).unwrap();
        let c = Cache::at(d.join("cache"));
        (d, p, c)
    }

    #[test]
    fn hit_resumes_and_matches_full_parse() {
        for (kind, body) in [(Kind::Claude, claude_transcript(300, 1000)), (Kind::Codex, codex_transcript(300, 1000))] {
            let (d, p, c) = setup(&format!("hit-{kind:?}"), &body);
            let (t, parsed) = parse(&p, kind);
            assert!(c.save(&p, &t, &parsed));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode(c.dir()), 0o700);
                assert_eq!(mode(&c.entry(&p)), 0o600);
            }
            // Grow the file after saving: the entry resumes, then reads the rest.
            let more = match kind {
                Kind::Claude => claude_transcript(5, 10),
                Kind::Codex => codex_transcript(5, 10).lines().skip(1).map(|l| format!("{l}\n")).collect(),
            };
            fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(more.as_bytes()).unwrap();
            let (mut t2, mut p2) = c.load(&p, kind).expect("cache hit");
            assert_eq!(t2.consumed(), body.len() as u64);
            t2.for_each_line(|l| p2.line(l));
            same(&view(&p2), &full_parse(&p, kind));
            let _ = fs::remove_dir_all(&d);
        }
    }

    #[test]
    fn invalidated_by_truncation_replacement_and_rewrite() {
        let body = claude_transcript(300, 1000);
        let (d, p, c) = setup("invalid", &body);
        let save = || {
            let (t, parsed) = parse(&p, Kind::Claude);
            assert!(c.save(&p, &t, &parsed));
        };

        save();
        fs::write(&p, &body[..body.len() / 2]).unwrap(); // truncated (same inode)
        assert!(c.load(&p, Kind::Claude).is_none());
        assert!(!c.entry(&p).exists(), "rejected entry is removed");

        fs::write(&p, &body).unwrap();
        save();
        let q = d.join("new.jsonl");
        fs::write(&q, &body).unwrap(); // same bytes, different file
        fs::rename(&q, &p).unwrap();
        assert!(c.load(&p, Kind::Claude).is_none(), "replaced file");

        save();
        // Same inode and length, different bytes before the offset.
        let mut changed = body.clone().into_bytes();
        let i = changed.len() - 10;
        changed[i] = b'Z';
        fs::OpenOptions::new().write(true).open(&p).unwrap().write_all(&changed).unwrap();
        assert!(c.load(&p, Kind::Claude).is_none(), "rewritten in place");

        save();
        assert!(c.load(&p, Kind::Codex).is_none(), "other kind");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn other_version_is_ignored_and_pruned() {
        let body = claude_transcript(300, 1000);
        let (d, p, c) = setup("version", &body);
        let (t, parsed) = parse(&p, Kind::Claude);
        assert!(c.save(&p, &t, &parsed));
        // Rewrite the header with another version number.
        let e = c.entry(&p);
        let s = fs::read_to_string(&e).unwrap();
        let (h, rest) = s.split_once('\n').unwrap();
        let mut hv: serde_json::Value = serde_json::from_str(h).unwrap();
        hv["v"] = (VERSION + 1).into();
        fs::write(&e, format!("{hv}\n{rest}")).unwrap();
        assert!(c.load(&p, Kind::Claude).is_none());

        // A folder for another version is removed by prune; ours stays.
        let old = d.join("cache").join("transcripts-v0");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("x.json"), "junk").unwrap();
        assert!(c.save(&p, &t, &parsed));
        c.prune();
        assert!(!old.exists());
        assert!(c.entry(&p).exists());

        // Entries whose transcript is gone are pruned.
        fs::remove_file(&p).unwrap();
        c.prune();
        assert!(!c.entry(&p).exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn corruption_is_tolerated() {
        let body = claude_transcript(300, 1000);
        let (d, p, c) = setup("corrupt", &body);
        let (t, parsed) = parse(&p, Kind::Claude);
        let e = c.entry(&p);
        for junk in [&b""[..], b"not json", b"{\"v\":1}\n{}", b"\xff\xfe\n\x00"] {
            assert!(c.save(&p, &t, &parsed));
            fs::write(&e, junk).unwrap();
            assert!(c.load(&p, Kind::Claude).is_none());
        }
        // Valid header, body cut short.
        assert!(c.save(&p, &t, &parsed));
        let s = fs::read(&e).unwrap();
        fs::write(&e, &s[..s.len() - 20]).unwrap();
        assert!(c.load(&p, Kind::Claude).is_none());
        // Small files are never cached.
        let small = d.join("small.jsonl");
        fs::write(&small, claude_transcript(2, 1)).unwrap();
        let (t, parsed) = parse(&small, Kind::Claude);
        assert!(!c.save(&small, &t, &parsed));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn size_cap_drops_oldest() {
        let d = tmpdir("cap");
        let c = Cache { max_bytes: 4 << 20, ..Cache::at(d.join("cache")) };
        make_private_dir(c.dir()).unwrap();
        // Entries that name an existing file, totalling over the cap.
        let src = d.join("src.jsonl");
        fs::write(&src, "x\n").unwrap();
        let h = serde_json::to_string(&Header { v: VERSION, kind: Kind::Claude, path: src.clone(), dev: 0, ino: 0, offset: 1, head: 0, tail: 0 }).unwrap();
        let blob = "y".repeat((c.max_bytes / 4) as usize);
        for i in 0..5 {
            fs::write(c.dir().join(format!("{i:016x}.json")), format!("{h}\n{blob}")).unwrap();
            let t = SystemTime::now() - Duration::from_secs(1000 - i * 10);
            fs::File::options().write(true).open(c.dir().join(format!("{i:016x}.json"))).unwrap().set_modified(t).unwrap();
        }
        c.prune();
        let left: Vec<String> = fs::read_dir(c.dir()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left.len(), 3, "{left:?}");
        assert!(!left.iter().any(|n| n.starts_with("0000000000000000") || n.starts_with("0000000000000001")), "oldest went first");
        let _ = fs::remove_dir_all(&d);
    }
}
