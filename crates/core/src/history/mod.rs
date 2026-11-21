//! History: every Claude Code and Codex session on this Mac, from the first one on, with full-text search
//! (APP_SPEC "History").
//!
//! The CLIs' transcripts stay where they are and are only ever read (`~/.claude/projects/*/*.jsonl`,
//! `~/.codex/sessions/YYYY/MM/DD/*.jsonl`, `~/.codex/archived_sessions/*.jsonl` and Codex's
//! `session_index.jsonl` for thread names; nothing else under those folders, no credential or auth file).
//! What the index learns lives in coool's own folder (`dir`):
//!
//! - `catalog.json`: one entry per transcript: the row's facts ([`parse::Meta`]) and how far the file was read
//!   (offset, length, mtime, a hash of its head), so a later pass reads only what was appended, and a file that was
//!   rewritten (shorter, or a different head) is read again from the start.
//! - `text.log`: the searchable words (prompts, then replies, within per-session budgets), appended as records
//!   `(transcript, generation, from, to, text)`. The catalog names the log length it agrees with; a log longer than
//!   that (a pass whose catalog was never saved) is cut back on open, so a crash never doubles words. Records of an
//!   older generation (a reread file, a session whose words were dropped to stay under the cap) are garbage; the log
//!   is rewritten without them once they are more than half of it.
//!
//! Size: at most [`Caps::prompt`] + [`Caps::reply`] bytes of words per session and [`Caps::total`] in all; past
//! the total, the words of the sessions that have been quiet longest are dropped (their rows stay, found by title,
//! first prompt, folder and files). The words are loaded into memory only while searching ([`History::release_texts`]
//! frees them), lowercased (ASCII, which keeps byte offsets, so a snippet is cut from the original text in the log).
//!
//! Work comes in small steps ([`History::step`]) so a caller can hold its lock briefly and run this on a background
//! thread at its own pace: newest transcripts first, a big file in slices.

pub mod parse;
mod query;

pub use query::{Facet, Page, Query, Row, Seg, Where};

use crate::model::Provider;
use parse::{Meta, Sink};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

/// Bytes of words kept per session and in all.
#[derive(Clone, Copy, Debug)]
pub struct Caps {
    pub prompt: usize,
    pub reply: usize,
    pub total: usize,
}

impl Default for Caps {
    fn default() -> Self {
        Self { prompt: 12 << 10, reply: 8 << 10, total: 48 << 20 }
    }
}

pub struct Options {
    /// The CLIs' folders: `~/.claude` and `~/.codex`.
    pub claude_root: PathBuf,
    pub codex_root: PathBuf,
    /// Where the index is kept (None: memory only).
    pub dir: Option<PathBuf>,
    pub caps: Caps,
    /// coool's list of its own sessions (`origin::OwnSessions`), re-read when it changes: those rows say "coool".
    pub own_sessions: Option<PathBuf>,
}

impl Options {
    /// The person's own CLI folders, the index in `dir`.
    pub fn for_home(home: &Path, dir: Option<PathBuf>) -> Self {
        Self { claude_root: home.join(".claude"), codex_root: home.join(".codex"), dir, caps: Caps::default(), own_sessions: crate::origin::OwnSessions::default_path() }
    }
}

const CATALOG: &str = "catalog.json";
const LOG: &str = "text.log";
const MAGIC: &[u8; 8] = b"cooolhx1";
const HEAD: u64 = 512;
/// A step checks its time budget this often (lines).
const CHECK_EVERY: usize = 64;

#[derive(Clone, Serialize, Deserialize)]
struct Doc {
    path: PathBuf,
    provider: Provider,
    /// The file as of the last pass: length and mtime (ms).
    len: u64,
    mtime: u64,
    /// Bytes read (always at a line end).
    offset: u64,
    /// Hash and length of the head read at the first pass (a different head: the file was replaced).
    head: (u64, u64),
    generation: u32,
    meta: Meta,
    used_prompt: usize,
    used_reply: usize,
    /// Bytes of words in the log for this generation.
    text: usize,
    /// Words dropped to stay under the cap: none are kept any more.
    #[serde(default)]
    dropped: bool,
    #[serde(default)]
    archived: bool,
    /// The last pass read to the end of the file as it was then (only an unfinished last line may be left).
    #[serde(default)]
    caught: bool,
    #[serde(skip)]
    gone: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct Catalog {
    v: u32,
    log_id: u64,
    log_len: u64,
    docs: Vec<Doc>,
}

#[derive(Serialize, Deserialize)]
struct RecHead {
    p: PathBuf,
    g: u32,
    f: u64,
    t: u64,
}

/// The words file: on disk, or in memory for a memory-only index.
enum Log {
    Mem(Vec<u8>),
    Disk { path: PathBuf, file: File, len: u64 },
}

impl Log {
    fn len(&self) -> u64 {
        match self {
            Log::Mem(v) => v.len() as u64,
            Log::Disk { len, .. } => *len,
        }
    }

    /// Appends one record; returns where its text starts.
    fn append(&mut self, h: &RecHead, body: &[u8]) -> std::io::Result<u64> {
        let head = serde_json::to_vec(h).unwrap_or_default();
        let mut rec = Vec::with_capacity(9 + head.len() + body.len());
        rec.push(0xC0);
        rec.extend_from_slice(&(head.len() as u32).to_le_bytes());
        rec.extend_from_slice(&head);
        rec.extend_from_slice(&(body.len() as u32).to_le_bytes());
        let at = self.len() + rec.len() as u64;
        rec.extend_from_slice(body);
        match self {
            Log::Mem(v) => v.extend_from_slice(&rec),
            Log::Disk { file, len, .. } => {
                file.seek(SeekFrom::Start(*len))?;
                file.write_all(&rec)?;
                *len += rec.len() as u64;
            }
        }
        Ok(at)
    }

    fn read_at(&mut self, at: u64, n: usize) -> Vec<u8> {
        match self {
            Log::Mem(v) => v.get(at as usize..(at as usize + n).min(v.len())).map(<[u8]>::to_vec).unwrap_or_default(),
            Log::Disk { file, .. } => {
                let mut buf = vec![0u8; n];
                if file.seek(SeekFrom::Start(at)).is_err() {
                    return Vec::new();
                }
                let got = file.read(&mut buf).unwrap_or(0);
                let mut have = got;
                while have < n {
                    match file.read(&mut buf[have..]) {
                        Ok(0) | Err(_) => break,
                        Ok(k) => have += k,
                    }
                }
                buf.truncate(have);
                buf
            }
        }
    }

    /// Every record after the file header: (head, text position, text).
    fn records(&mut self) -> Vec<(RecHead, u64, Vec<u8>)> {
        let all = match self {
            Log::Mem(v) => v.clone(),
            Log::Disk { path, len, .. } => {
                let mut b = fs::read(path).unwrap_or_default();
                b.truncate(*len as usize);
                b
            }
        };
        let mut out = Vec::new();
        let mut i = if matches!(self, Log::Disk { .. }) { 16 } else { 0 };
        let u32_at = |i: usize| -> Option<usize> { Some(u32::from_le_bytes(all.get(i..i + 4)?.try_into().ok()?) as usize) };
        while i < all.len() {
            if all[i] != 0xC0 {
                break;
            }
            let Some(hl) = u32_at(i + 1) else { break };
            let Some(h) = all.get(i + 5..i + 5 + hl).and_then(|b| serde_json::from_slice::<RecHead>(b).ok()) else { break };
            let Some(bl) = u32_at(i + 5 + hl) else { break };
            let at = i + 9 + hl;
            let Some(body) = all.get(at..at + bl) else { break };
            out.push((h, at as u64, body.to_vec()));
            i = at + bl;
        }
        out
    }
}

/// The words of every session, for searching (see the module docs).
struct Texts {
    /// Per doc: the words, ASCII-lowercased.
    lower: Vec<Vec<u8>>,
    /// Per doc: where its pieces are in the log (text position, length), in order.
    chunks: Vec<Vec<(u64, u32)>>,
    used: Instant,
}

/// How far the index is.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Status {
    /// Sessions listed (rows), and transcripts known in all.
    pub sessions: usize,
    pub transcripts: usize,
    /// Transcripts with something left to read.
    pub pending: usize,
    /// Bytes of words kept, and of the words file (with garbage).
    pub text_bytes: u64,
    pub log_bytes: u64,
    /// Whether the first full pass has finished.
    pub ready: bool,
}

pub struct History {
    opts: Options,
    docs: Vec<Doc>,
    by_path: HashMap<PathBuf, usize>,
    log: Log,
    log_id: u64,
    texts: Option<Texts>,
    /// Docs with something to read, oldest first (work is taken from the end).
    queue: Vec<usize>,
    scan_due: bool,
    scanned_once: bool,
    dirty: bool,
    last_save: Option<Instant>,
    codex_titles: crate::tail::Tail,
    codex_names: HashMap<String, String>,
    own: crate::origin::OwnSessions,
    own_stamp: Option<SystemTime>,
    folders: HashMap<String, (bool, Instant)>,
}

fn mtime_ms(m: &fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn hash(b: &[u8]) -> u64 {
    // FNV-1a: enough to tell a replaced file from the one read before.
    b.iter().fold(0xcbf29ce484222325u64, |h, &c| (h ^ c as u64).wrapping_mul(0x100000001b3))
}

fn new_log_id() -> u64 {
    let t = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1);
    t ^ ((std::process::id() as u64) << 32)
}

fn open_log(dir: &Path, id: u64, keep: Option<u64>) -> std::io::Result<Log> {
    fs::create_dir_all(dir)?;
    let path = dir.join(LOG);
    let mut o = fs::OpenOptions::new();
    o.read(true).write(true).create(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let mut file = o.open(&path)?;
    let len = match keep {
        Some(n) => {
            file.set_len(n)?;
            n
        }
        None => {
            file.set_len(0)?;
            file.seek(SeekFrom::Start(0))?;
            file.write_all(MAGIC)?;
            file.write_all(&id.to_le_bytes())?;
            16
        }
    };
    Ok(Log::Disk { path, file, len })
}

/// The id in a log file's header, when the file is one.
fn log_header(path: &Path) -> Option<(u64, u64)> {
    let mut f = File::open(path).ok()?;
    let mut h = [0u8; 16];
    f.read_exact(&mut h).ok()?;
    (&h[..8] == MAGIC).then(|| (u64::from_le_bytes(h[8..].try_into().unwrap()), f.metadata().map(|m| m.len()).unwrap_or(0)))
}

impl History {
    /// Opens the index in `opts.dir` (or starts one), checked against its words file.
    pub fn open(opts: Options) -> Self {
        let codex_titles = crate::tail::Tail::new(opts.codex_root.join("session_index.jsonl"));
        let own = crate::origin::OwnSessions::at(None);
        let mut h = History {
            docs: Vec::new(),
            by_path: HashMap::new(),
            log: Log::Mem(Vec::new()),
            log_id: new_log_id(),
            texts: None,
            queue: Vec::new(),
            scan_due: true,
            scanned_once: false,
            dirty: false,
            last_save: None,
            codex_titles,
            codex_names: HashMap::new(),
            own,
            own_stamp: None,
            folders: HashMap::new(),
            opts,
        };
        if let Some(dir) = h.opts.dir.clone() {
            let cat: Option<Catalog> = fs::read(dir.join(CATALOG)).ok().and_then(|b| serde_json::from_slice(&b).ok()).filter(|c: &Catalog| c.v == 1);
            let header = log_header(&dir.join(LOG));
            let log = match (&cat, header) {
                // The log agrees with the catalog: keep what the catalog knows of (cut back anything newer).
                (Some(c), Some((id, len))) if id == c.log_id && len >= c.log_len => open_log(&dir, c.log_id, Some(c.log_len)).ok().map(|l| (l, c.log_id)),
                _ => None,
            };
            match (log, cat) {
                (Some((l, id)), Some(c)) => {
                    h.log = l;
                    h.log_id = id;
                    h.docs = c.docs;
                }
                _ => {
                    // Nothing usable: start over (the transcripts are all still there to read).
                    if let Ok(l) = open_log(&dir, h.log_id, None) {
                        h.log = l;
                    }
                    h.dirty = true;
                }
            }
            h.by_path = h.docs.iter().enumerate().map(|(i, d)| (d.path.clone(), i)).collect();
        }
        h
    }

    /// Where the index lives (None: memory only).
    pub fn dir(&self) -> Option<&Path> {
        self.opts.dir.as_deref()
    }

    /// Asks the next [`History::step`] to look for new and changed transcripts.
    pub fn request_scan(&mut self) {
        self.scan_due = true;
    }

    /// Forgets everything (Settings > Storage): the files go, the index starts over from the transcripts.
    pub fn clear(&mut self) {
        self.docs.clear();
        self.by_path.clear();
        self.queue.clear();
        self.texts = None;
        self.log_id = new_log_id();
        self.log = match self.opts.dir.clone() {
            Some(dir) => {
                let _ = fs::remove_file(dir.join(CATALOG));
                open_log(&dir, self.log_id, None).unwrap_or(Log::Mem(Vec::new()))
            }
            None => Log::Mem(Vec::new()),
        };
        self.scan_due = true;
        self.scanned_once = false;
        self.dirty = true;
        self.save();
    }

    pub fn status(&self) -> Status {
        let live = self.docs.iter().filter(|d| !d.gone);
        Status {
            sessions: live.clone().filter(|d| listed(d)).count(),
            transcripts: live.clone().count(),
            pending: self.queue.len(),
            text_bytes: live.map(|d| d.text as u64).sum(),
            log_bytes: self.log.len(),
            ready: self.scanned_once && self.queue.is_empty(),
        }
    }

    /// The transcript of a listed session.
    pub fn path_of(&self, provider: Provider, id: &str) -> Option<PathBuf> {
        self.docs.iter().filter(|d| !d.gone && d.provider == provider).find(|d| d.meta.id == id).map(|d| d.path.clone())
    }

    /// The folder a listed session ran in.
    pub fn cwd_of(&self, provider: Provider, id: &str) -> Option<String> {
        self.docs.iter().filter(|d| !d.gone && d.provider == provider).find(|d| d.meta.id == id).map(|d| d.meta.cwd.clone())
    }

    /// Whether some session ran in exactly this folder.
    pub fn knows_folder(&self, cwd: &str) -> bool {
        !cwd.is_empty() && self.docs.iter().any(|d| !d.gone && d.meta.cwd == cwd)
    }

    /// Folders sessions ran in that end in `name` and still exist (where a moved project may be now).
    pub fn folders_named(&mut self, name: &str, except: &str) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut out: Vec<(u64, String)> = Vec::new();
        let cwds: Vec<(String, u64)> = self.docs.iter().filter(|d| !d.gone).map(|d| (d.meta.cwd.clone(), d.meta.last_ms.unwrap_or(0))).collect();
        for (cwd, last) in cwds {
            if cwd == except || Path::new(&cwd).file_name().and_then(|n| n.to_str()) != Some(name) || !seen.insert(cwd.clone()) {
                continue;
            }
            if self.folder_exists(&cwd) {
                out.push((last, cwd));
            }
        }
        out.sort_by(|a, b| b.cmp(a));
        out.into_iter().map(|(_, c)| c).take(5).collect()
    }

    /// Whether a folder exists (cached for a little while).
    pub fn folder_exists(&mut self, cwd: &str) -> bool {
        if cwd.is_empty() {
            return false;
        }
        if let Some((ok, at)) = self.folders.get(cwd)
            && at.elapsed() < Duration::from_secs(20)
        {
            return *ok;
        }
        let ok = Path::new(cwd).is_dir();
        self.folders.insert(cwd.to_string(), (ok, Instant::now()));
        ok
    }

    /// Frees the words held for searching (they load again with the next search).
    pub fn release_texts(&mut self) {
        self.texts = None;
    }

    /// Whether the words have been in memory unused for `idle`.
    pub fn texts_idle(&self, idle: Duration) -> bool {
        self.texts.as_ref().is_some_and(|t| t.used.elapsed() >= idle)
    }

    // ------------------------------------------------------------------ discovery

    /// Every transcript: (path, provider, archived).
    fn walk(&self) -> Vec<(PathBuf, Provider, bool)> {
        let mut out = Vec::new();
        let jsonl = |p: &Path| p.extension().and_then(|e| e.to_str()) == Some("jsonl");
        let dirs = |p: &Path| -> Vec<PathBuf> { fs::read_dir(p).map(|r| r.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default() };
        let files = |p: &Path| -> Vec<PathBuf> { fs::read_dir(p).map(|r| r.flatten().map(|e| e.path()).filter(|p| jsonl(p)).collect()).unwrap_or_default() };
        // Claude: one file per session directly in each project folder (subagents sit deeper, as part of theirs).
        for d in dirs(&self.opts.claude_root.join("projects")) {
            out.extend(files(&d).into_iter().map(|p| (p, Provider::Claude, false)));
        }
        let sessions = self.opts.codex_root.join("sessions");
        for y in dirs(&sessions) {
            for m in dirs(&y) {
                for d in dirs(&m) {
                    out.extend(files(&d).into_iter().map(|p| (p, Provider::Codex, false)));
                }
            }
        }
        out.extend(files(&self.opts.codex_root.join("archived_sessions")).into_iter().map(|p| (p, Provider::Codex, true)));
        out
    }

    fn scan(&mut self) {
        self.scan_due = false;
        // Codex thread names.
        for l in self.codex_titles.read_lines() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&l)
                && let (Some(id), Some(n)) = (v["id"].as_str(), v["thread_name"].as_str())
            {
                self.codex_names.insert(id.to_string(), n.to_string());
            }
        }
        // coool's own sessions.
        if let Some(p) = &self.opts.own_sessions {
            let stamp = fs::metadata(p).and_then(|m| m.modified()).ok();
            if stamp != self.own_stamp {
                self.own_stamp = stamp;
                // Only read here (`contains`); nothing is ever recorded through this copy.
                self.own = crate::origin::OwnSessions::at(Some(p.clone()));
            }
        }
        let found = self.walk();
        let mut seen: HashSet<usize> = HashSet::new();
        for (path, provider, archived) in found {
            let Ok(m) = fs::metadata(&path) else { continue };
            let (len, mt) = (m.len(), mtime_ms(&m));
            let i = match self.by_path.get(&path) {
                Some(&i) => i,
                None => {
                    let meta = Meta { id: if provider == Provider::Claude { path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default() } else { codex_id_from_name(&path).unwrap_or_default() }, ..Meta::default() };
                    self.docs.push(Doc { path: path.clone(), provider, len: 0, mtime: 0, offset: 0, head: (0, 0), generation: 0, meta, used_prompt: 0, used_reply: 0, text: 0, dropped: false, archived, caught: false, gone: false });
                    if let Some(t) = &mut self.texts {
                        t.lower.push(Vec::new());
                        t.chunks.push(Vec::new());
                    }
                    self.by_path.insert(path.clone(), self.docs.len() - 1);
                    self.dirty = true;
                    self.docs.len() - 1
                }
            };
            seen.insert(i);
            let d = &mut self.docs[i];
            d.gone = false;
            d.archived = archived;
            if (d.len, d.mtime) != (len, mt) || !d.caught {
                if (d.len, d.mtime) != (len, mt) {
                    d.caught = false;
                }
                d.len = len;
                d.mtime = mt;
                if !self.queue.contains(&i) {
                    self.queue.push(i);
                }
            }
        }
        for (i, d) in self.docs.iter_mut().enumerate() {
            if !seen.contains(&i) && !d.gone {
                d.gone = true;
                self.dirty = true;
            }
        }
        // Newest last (taken first).
        let docs = &self.docs;
        self.queue.retain(|&i| !docs[i].gone);
        self.queue.sort_by_key(|&i| docs[i].mtime);
        self.scanned_once = true;
    }

    /// Does up to `budget` of work: a scan when due, then reading the newest transcripts with something new.
    /// Returns whether work is left.
    pub fn step(&mut self, budget: Duration) -> bool {
        let deadline = Instant::now() + budget;
        if self.scan_due {
            self.scan();
        }
        let mut wrote = false;
        while let Some(&i) = self.queue.last() {
            if Instant::now() >= deadline {
                break;
            }
            wrote |= self.read_some(i, deadline);
            if self.docs[i].caught {
                self.queue.pop();
            }
        }
        if wrote {
            self.enforce_cap();
        }
        !self.queue.is_empty()
    }

    /// Reads doc `i` from where it was left until its end or `deadline`. True when words were added.
    fn read_some(&mut self, i: usize, deadline: Instant) -> bool {
        let path = self.docs[i].path.clone();
        let Ok(mut f) = File::open(&path) else {
            self.docs[i].caught = true;
            return false;
        };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        // Replaced or truncated: read it again from the start.
        {
            let d = &self.docs[i];
            let mut head = vec![0u8; d.head.1 as usize];
            let replaced = len < d.offset || (d.head.1 > 0 && (f.read_exact(&mut head).is_err() || hash(&head) != d.head.0));
            if replaced {
                self.reset(i);
            }
        }
        let d = &mut self.docs[i];
        d.len = len;
        if d.offset == 0 && d.head.1 == 0 {
            let n = HEAD.min(len);
            let mut head = vec![0u8; n as usize];
            if f.seek(SeekFrom::Start(0)).is_ok() && f.read_exact(&mut head).is_ok() {
                d.head = (hash(&head), n);
            }
        }
        if f.seek(SeekFrom::Start(d.offset)).is_err() {
            d.caught = true;
            return false;
        }
        let from = d.offset;
        let (pl, rl) = if d.dropped { (0, 0) } else { (self.opts.caps.prompt.saturating_sub(d.used_prompt), self.opts.caps.reply.saturating_sub(d.used_reply)) };
        let mut sink = Sink::new(pl, rl);
        let mut r = BufReader::with_capacity(256 << 10, f);
        let mut line = Vec::new();
        let mut n = 0usize;
        let mut end = false;
        loop {
            line.clear();
            match r.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => {
                    end = true;
                    break;
                }
                Ok(_) => {}
            }
            if line.last() != Some(&b'\n') {
                // An unfinished last line: read it once it is complete.
                end = true;
                break;
            }
            d.offset += line.len() as u64;
            let text = String::from_utf8_lossy(&line[..line.len() - 1]);
            let l = text.trim_end_matches('\r');
            if !l.is_empty() {
                match d.provider {
                    Provider::Claude => parse::claude_line(l, &mut d.meta, &mut sink),
                    Provider::Codex => parse::codex_line(l, &mut d.meta, &mut sink),
                }
            }
            n += 1;
            if n % CHECK_EVERY == 0 && Instant::now() >= deadline {
                break;
            }
        }
        // Caught up: nothing more until the file changes again.
        d.caught = end;
        d.used_prompt += pl - sink.prompt_left;
        d.used_reply += rl - sink.reply_left;
        self.dirty = true;
        if sink.out.is_empty() {
            return false;
        }
        let body = sink.out.into_bytes();
        let h = RecHead { p: path, g: d.generation, f: from, t: d.offset };
        d.text += body.len();
        let Ok(at) = self.log.append(&h, &body) else { return false };
        if let Some(t) = &mut self.texts {
            t.lower[i].extend(body.iter().map(u8::to_ascii_lowercase));
            t.chunks[i].push((at, body.len() as u32));
        }
        true
    }

    fn reset(&mut self, i: usize) {
        let d = &mut self.docs[i];
        let id = d.meta.id.clone();
        d.offset = 0;
        d.head = (0, 0);
        d.generation += 1;
        d.meta = Meta { id, ..Meta::default() };
        d.used_prompt = 0;
        d.used_reply = 0;
        d.text = 0;
        d.dropped = false;
        d.caught = false;
        if let Some(t) = &mut self.texts {
            t.lower[i].clear();
            t.chunks[i].clear();
        }
        self.dirty = true;
    }

    /// Keeps the words under [`Caps::total`]: the sessions quiet longest lose theirs first.
    fn enforce_cap(&mut self) {
        let total: usize = self.docs.iter().filter(|d| !d.gone).map(|d| d.text).sum();
        if total <= self.opts.caps.total {
            return;
        }
        let mut order: Vec<usize> = (0..self.docs.len()).filter(|&i| !self.docs[i].gone && self.docs[i].text > 0).collect();
        order.sort_by_key(|&i| self.docs[i].meta.last_ms.unwrap_or(self.docs[i].mtime));
        let target = self.opts.caps.total / 10 * 9;
        let mut now = total;
        for i in order {
            if now <= target {
                break;
            }
            let d = &mut self.docs[i];
            now -= d.text;
            d.text = 0;
            d.generation += 1;
            d.dropped = true;
            if let Some(t) = &mut self.texts {
                t.lower[i] = Vec::new();
                t.chunks[i] = Vec::new();
            }
        }
        self.dirty = true;
    }

    /// Writes the catalog (and flushes the words) when something changed; at most every `every` unless `force`.
    pub fn save_if(&mut self, every: Duration, force: bool) {
        if !self.dirty || (!force && self.last_save.is_some_and(|t| t.elapsed() < every)) {
            return;
        }
        self.save();
    }

    pub fn save(&mut self) {
        self.maybe_compact();
        let Some(dir) = self.opts.dir.clone() else {
            self.dirty = false;
            return;
        };
        if let Log::Disk { file, .. } = &mut self.log {
            let _ = file.sync_data();
        }
        let cat = Catalog { v: 1, log_id: self.log_id, log_len: self.log.len(), docs: self.docs.iter().filter(|d| !d.gone).cloned().collect() };
        if let Ok(b) = serde_json::to_vec(&cat)
            && crate::origin::write_private(&dir.join(CATALOG), &b).is_ok()
        {
            self.dirty = false;
            self.last_save = Some(Instant::now());
            // Gone transcripts are out of the catalog now: drop them here too, so indices match the file.
            if self.docs.iter().any(|d| d.gone) {
                self.drop_gone();
            }
        }
    }

    fn drop_gone(&mut self) {
        let keep: Vec<bool> = self.docs.iter().map(|d| !d.gone).collect();
        let mut k = keep.iter();
        self.docs.retain(|_| *k.next().unwrap());
        if let Some(t) = &mut self.texts {
            let mut k = keep.iter();
            t.lower.retain(|_| *k.next().unwrap());
            let mut k = keep.iter();
            t.chunks.retain(|_| *k.next().unwrap());
        }
        self.by_path = self.docs.iter().enumerate().map(|(i, d)| (d.path.clone(), i)).collect();
        let map: Vec<Option<usize>> = {
            let mut n = 0;
            keep.iter().map(|&k| if k { n += 1; Some(n - 1) } else { None }).collect()
        };
        self.queue = self.queue.iter().filter_map(|&i| map.get(i).copied().flatten()).collect();
    }

    /// Rewrites the words file without garbage once garbage is more than half of it.
    fn maybe_compact(&mut self) {
        let live: u64 = self.docs.iter().filter(|d| !d.gone).map(|d| d.text as u64).sum();
        let len = self.log.len();
        if len < (4 << 20) || len <= live * 2 + (1 << 20) {
            return;
        }
        let recs = self.accepted();
        let id = new_log_id();
        let mut new = match &self.opts.dir {
            Some(dir) => {
                let tmp = dir.join("text.log.new");
                let mut o = fs::OpenOptions::new();
                o.read(true).write(true).create(true).truncate(true);
                #[cfg(unix)]
                std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
                let Ok(mut file) = o.open(&tmp) else { return };
                if file.write_all(MAGIC).and_then(|_| file.write_all(&id.to_le_bytes())).is_err() {
                    return;
                }
                Log::Disk { path: tmp, file, len: 16 }
            }
            None => Log::Mem(Vec::new()),
        };
        let mut chunks: Vec<Vec<(u64, u32)>> = vec![Vec::new(); self.docs.len()];
        for (i, h, _, body) in recs {
            match new.append(&h, &body) {
                Ok(at) => chunks[i].push((at, body.len() as u32)),
                Err(_) => return,
            }
        }
        let new = match (&self.opts.dir, new) {
            (Some(dir), Log::Disk { path, file, len }) => {
                let _ = file.sync_data();
                let real = dir.join(LOG);
                if fs::rename(&path, &real).is_err() {
                    return;
                }
                Log::Disk { path: real, file, len }
            }
            (_, l) => l,
        };
        self.log = new;
        self.log_id = id;
        self.dirty = true;
        if let Some(t) = &mut self.texts {
            t.chunks = chunks;
        }
    }

    /// The live records, in log order: (doc, head, text position, text).
    fn accepted(&mut self) -> Vec<(usize, RecHead, u64, Vec<u8>)> {
        let mut out = Vec::new();
        let mut last: HashMap<usize, u64> = HashMap::new();
        for (h, at, body) in self.log.records() {
            let Some(&i) = self.by_path.get(&h.p) else { continue };
            let d = &self.docs[i];
            if d.gone || d.generation != h.g || h.t > d.offset || h.f < last.get(&i).copied().unwrap_or(0) {
                continue;
            }
            last.insert(i, h.t);
            out.push((i, h, at, body));
        }
        out
    }

    /// The words in memory (loaded from the log on first use).
    fn texts(&mut self) -> &mut Texts {
        if self.texts.is_none() {
            let n = self.docs.len();
            let mut t = Texts { lower: vec![Vec::new(); n], chunks: vec![Vec::new(); n], used: Instant::now() };
            for (i, _, at, body) in self.accepted() {
                t.lower[i].extend(body.iter().map(u8::to_ascii_lowercase));
                t.chunks[i].push((at, body.len() as u32));
            }
            self.texts = Some(t);
        }
        let t = self.texts.as_mut().unwrap();
        t.used = Instant::now();
        t
    }


    /// Original text of doc `i` between byte offsets `a..b` of its words.
    fn original(&mut self, i: usize, a: usize, b: usize) -> String {
        let chunks = self.texts().chunks[i].clone();
        let mut out = Vec::new();
        let mut at = 0usize;
        for (pos, n) in chunks {
            let n = n as usize;
            let (s, e) = (a.max(at), b.min(at + n));
            if s < e {
                out.extend(self.log.read_at(pos + (s - at) as u64, e - s));
            }
            at += n;
            if at >= b {
                break;
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    /// Where a session ran (see [`Where`]).
    fn where_of(&self, d: &Doc) -> (Where, String) {
        let m = &d.meta;
        if self.own.contains(d.provider, &m.id) {
            return (Where::Coool, "coool".into());
        }
        match d.provider {
            Provider::Claude => {
                if crate::origin::claude(Some(&m.entry).filter(|e| !e.is_empty()).map(String::as_str), m.human) == crate::model::Origin::Automation {
                    return (Where::Automation, "Other tools".into());
                }
                match m.entry.as_str() {
                    "" | "cli" => (Where::Terminal, "Terminal".into()),
                    "claude-vscode" => (Where::Ide, "VS Code".into()),
                    e if e.contains("jetbrains") => (Where::Ide, "JetBrains".into()),
                    "claude-desktop" | "local-agent" => (Where::App, "Claude app".into()),
                    e if e.starts_with("remote") => (Where::App, "Claude remote".into()),
                    e if e.starts_with("sdk") => (Where::App, "Agent SDK".into()),
                    e => (Where::App, e.to_string()),
                }
            }
            Provider::Codex => match crate::origin::codex(&m.entry, &m.source) {
                crate::model::Origin::Coool => (Where::Coool, "coool".into()),
                crate::model::Origin::Automation => (Where::Automation, "Other tools".into()),
                crate::model::Origin::User => {
                    if m.source == "vscode" && (m.entry.contains("vscode") || m.entry.is_empty()) {
                        (Where::Ide, "VS Code".into())
                    } else if m.entry == "codex_cli_rs" || m.entry.is_empty() || (m.source == "cli" && !m.entry.to_lowercase().contains("desktop")) {
                        (Where::Terminal, "Terminal".into())
                    } else if m.entry.to_lowercase().contains("desktop") || m.entry.to_lowercase().contains("app") {
                        (Where::App, "Codex app".into())
                    } else {
                        (Where::App, m.entry.clone())
                    }
                }
            },
        }
    }

    /// The title a row shows: the person's name in coool, else the CLI's rename, else its title, else the first prompt.
    fn title_of(&self, d: &Doc, names: &dyn Fn(Provider, &str) -> Option<String>) -> String {
        if let Some(n) = names(d.provider, &d.meta.id).filter(|n| !n.is_empty()) {
            return n;
        }
        if let Some(c) = &d.meta.custom {
            return c.clone();
        }
        if d.provider == Provider::Codex
            && let Some(n) = self.codex_names.get(&d.meta.id)
        {
            return n.clone();
        }
        if !d.meta.title.is_empty() {
            return d.meta.title.clone();
        }
        if !d.meta.first_prompt.is_empty() {
            return crate::util::one_line(&d.meta.first_prompt, 60);
        }
        Path::new(&d.meta.cwd).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_else(|| "Untitled".into())
    }
}

/// A transcript that is a session row: not a Codex subagent (part of its parent), and with something in it.
fn listed(d: &Doc) -> bool {
    !d.gone && d.meta.parent.is_none() && (d.meta.prompts > 0 || !d.meta.title.is_empty() || d.meta.custom.is_some())
}

/// `rollout-2026-11-14T15-32-21-<uuid>.jsonl` -> `<uuid>`.
fn codex_id_from_name(p: &Path) -> Option<String> {
    let stem = p.file_stem()?.to_str()?;
    let id = stem.get(stem.len().checked_sub(36)?..)?;
    let b = id.as_bytes();
    let ok = b.iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() });
    ok.then(|| id.to_string())
}

#[cfg(test)]
mod tests;
