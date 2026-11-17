//! Background transcript loading, so [`crate::hub::Hub::refresh`] never blocks on
//! heavy I/O.
//!
//! Every transcript has a [`Slot`]: its parse state behind a mutex, plus a
//! published [`View`] (what the UI shows) behind another. `refresh` only does
//! cheap work itself (stat, small incremental reads, using `try_lock` so it
//! never waits for a worker). Everything heavy is a job for a small worker
//! pool, in priority order:
//!
//! 1. first pass: restore from the persistent [`cache`](crate::cache); else, for a
//!    big file, a preview from its head and tail (recent activity on screen);
//!    else (small file) the full parse;
//! 2. backfill: the full sequential parse from the cache offset (or byte 0),
//!    in bounded slices. Its result is exactly what a one-shot parse gives;
//!    the preview is only shown until it completes.

use crate::cache::Cache;
use crate::model::{Activity, ModelUse, Tokens};
use crate::tail::Tail;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

/// Bytes parsed per lock hold by a worker; bounds how stale a view can get and
/// how long shutdown waits.
const SLICE: u64 = 4 << 20;
/// Files with more unread bytes than this get a head+tail preview first.
const PREVIEW_MIN: u64 = 4 << 20;
const PREVIEW_HEAD: u64 = 256 << 10;
const PREVIEW_TAIL: u64 = 512 << 10;
/// `refresh` parses a never-loaded file itself when it is at most this big
/// (cheaper than a round trip through the pool, and links a fresh chat at once).
pub(crate) const INLINE_NEW_MAX: u64 = 256 << 10;
/// `refresh` catches up a loaded file itself when at most this far behind.
pub(crate) const INLINE_GROW_MAX: u64 = 1 << 20;
/// Total bytes `refresh` reads itself per call; the rest goes to the pool.
pub(crate) const INLINE_BUDGET: u64 = 4 << 20;
/// A loaded file still being appended to is re-saved to the cache at most this often.
const SAVE_EVERY: Duration = Duration::from_secs(30);

/// What the UI shows for one transcript.
#[derive(Clone, Debug, Default)]
pub(crate) struct View {
    /// Details known (from a preview, the cache or a parse); false = nothing parsed yet.
    pub loaded: bool,
    /// Parsed through to the end at least once: totals are exact.
    pub complete: bool,
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub model: String,
    pub last_prompt: Option<String>,
    pub current: Option<String>,
    pub tokens: Tokens,
    pub activity: std::sync::Arc<Vec<Activity>>,
    /// Own model rows, most used first.
    pub models: Vec<ModelUse>,
    pub in_turn: bool,
    /// Epoch ms of the newest real conversation event (see [`crate::model::Session::last_event`]).
    pub last_event: Option<u64>,
    pub started: Option<SystemTime>,
    /// How the transcript says it was started; None until that is known.
    pub origin: Option<crate::model::Origin>,
    /// Codex subagent rollouts: the thread that spawned it, and its name.
    pub parent: Option<String>,
    pub agent_name: String,
    /// Claude: recent Bash tool calls (see [`crate::shells`]).
    pub bash: Vec<crate::shells::BashCall>,
}

/// Bytes read from the end of a file for [`tail_event`].
const EVENT_TAIL: u64 = 64 << 10;

/// The newest real conversation event time in the last [`EVENT_TAIL`] bytes of
/// a transcript: the cheap answer for sessions not parsed yet. None when the
/// tail holds no such event.
pub(crate) fn tail_event(path: &Path, kind: Kind) -> Option<u64> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(EVENT_TAIL);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.take(EVENT_TAIL).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.lines();
    if start > 0 {
        lines.next(); // starts mid-line
    }
    lines
        .filter(|l| !l.contains("\"type\":\"api-request"))
        .filter_map(|l| {
            let v: serde_json::Value = serde_json::from_str(l).ok()?;
            match kind {
                Kind::Claude => crate::claude::event_ms(&v),
                Kind::Codex => crate::codex::event_ms(&v),
            }
        })
        .max()
}

/// Parse state of one transcript (what the cache persists).
#[derive(Clone, Serialize, Deserialize)]
pub(crate) enum Parsed {
    Claude(crate::claude::Parsed),
    Codex(crate::codex::Parsed),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum Kind {
    Claude,
    Codex,
}

impl Parsed {
    fn new(kind: Kind) -> Self {
        match kind {
            Kind::Claude => Parsed::Claude(Default::default()),
            Kind::Codex => Parsed::Codex(Default::default()),
        }
    }
    pub(crate) fn kind(&self) -> Kind {
        match self {
            Parsed::Claude(_) => Kind::Claude,
            Parsed::Codex(_) => Kind::Codex,
        }
    }
    pub(crate) fn line(&mut self, l: &str) {
        match self {
            Parsed::Claude(p) => p.line(l),
            Parsed::Codex(p) => p.line(l),
        }
    }
    fn view(&self) -> View {
        match self {
            Parsed::Claude(p) => p.view(),
            Parsed::Codex(p) => p.view(),
        }
    }
    /// A preview only saw part of the file: drop what needs all of it.
    fn view_partial(&self) -> View {
        let mut v = self.view();
        if let Parsed::Claude(_) = self {
            // Claude totals are sums over every message: unknown until backfilled.
            v.tokens = Tokens { context: v.tokens.context, total: v.tokens.total, ..Tokens::default() };
        }
        // Codex totals are cumulative counters, so the last one seen is exact;
        // per-model rows are sums of their growth.
        v.models.clear();
        // Only the tail was read: the turn's start may be missing.
        v.tokens.turn_output = 0;
        v
    }
}

pub(crate) struct FileState {
    pub(crate) path: PathBuf,
    pub(crate) tail: Tail,
    pub(crate) parsed: Parsed,
    /// Parsed through to the end at least once (since the last rewind).
    complete: bool,
    previewed: bool,
    cache_checked: bool,
    /// Parsed further than the last cache save.
    dirty: bool,
    last_save: Option<Instant>,
}

impl FileState {
    fn reset(&mut self) {
        self.tail = Tail::new(&self.path);
        self.parsed = Parsed::new(self.parsed.kind());
        self.complete = false;
        self.previewed = false;
        self.dirty = false;
        // A cache entry for the old content is checked against the file anyway.
        self.cache_checked = true;
    }
}

pub(crate) struct Slot {
    state: Mutex<FileState>,
    view: Mutex<Arc<View>>,
    /// In the pool's queue or being worked on; `refresh` leaves it alone meanwhile.
    queued: AtomicBool,
    save_queued: AtomicBool,
}

impl Slot {
    pub(crate) fn new(kind: Kind, path: &Path) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(FileState {
                path: path.to_path_buf(),
                tail: Tail::new(path),
                parsed: Parsed::new(kind),
                complete: false,
                previewed: false,
                cache_checked: false,
                dirty: false,
                last_save: None,
            }),
            view: Mutex::new(Arc::new(View::default())),
            queued: AtomicBool::new(false),
            save_queued: AtomicBool::new(false),
        })
    }

    pub(crate) fn view(&self) -> Arc<View> {
        self.view.lock().unwrap().clone()
    }

    fn publish(&self, v: View) {
        *self.view.lock().unwrap() = Arc::new(v);
    }

    fn publish_full(&self, st: &FileState) {
        let mut v = st.parsed.view();
        v.loaded = true;
        v.complete = st.complete;
        self.publish(v);
    }
}

/// Job priority, higher first: (phase, live, main transcript, mtime ms).
pub(crate) type Prio = (u8, bool, bool, u64);
const PHASE_TASK: u8 = 4;
const PHASE_FIRST: u8 = 3;
const PHASE_BACKFILL: u8 = 2;
const PHASE_SAVE: u8 = 1;
const PHASE_IDLE: u8 = 0;

pub(crate) fn prio(live: bool, main: bool, mtime: SystemTime) -> Prio {
    let ms = mtime.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    (PHASE_FIRST, live, main, ms)
}

enum Job {
    Load(Arc<Slot>),
    Save(Arc<Slot>),
    Task(Box<dyn FnOnce() + Send>),
}

struct Queue {
    jobs: Vec<(Prio, Job)>,
    running: usize,
}

struct Shared {
    q: Mutex<Queue>,
    /// Workers wait here for jobs.
    work: Condvar,
    /// Notified whenever a job finishes (see [`Pool::wait_idle`]).
    done: Condvar,
    stop: AtomicBool,
    cache: Option<Cache>,
    /// Thread-less pool: skip previews, nobody would see them.
    inline: bool,
}

/// Worker threads plus the queue. Dropping it stops and joins the workers:
/// each finishes at most its current slice, then nothing runs any more.
pub(crate) struct Pool {
    shared: Arc<Shared>,
    workers: Vec<JoinHandle<()>>,
    /// No threads: every job runs inline, to completion (tests, sync callers).
    inline: bool,
    /// Whether `sync` may parse small never-loaded files itself. Off during the
    /// initial load, where the workers do them in parallel.
    fresh_inline: AtomicBool,
}

impl Pool {
    pub(crate) fn new(threads: usize, cache: Option<Cache>) -> Self {
        let shared = Arc::new(Shared {
            q: Mutex::new(Queue { jobs: Vec::new(), running: 0 }),
            work: Condvar::new(),
            done: Condvar::new(),
            stop: AtomicBool::new(false),
            cache,
            inline: threads == 0,
        });
        let workers = (0..threads)
            .map(|i| {
                let s = shared.clone();
                std::thread::Builder::new().name(format!("coool-load-{i}")).spawn(move || worker(s)).expect("spawn loader thread")
            })
            .collect();
        Self { shared, workers, inline: threads == 0, fresh_inline: AtomicBool::new(true) }
    }

    /// Size for this machine: a few threads, never all cores.
    pub(crate) fn default_threads() -> usize {
        std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(2).clamp(1, 4)
    }

    pub(crate) fn set_fresh_inline(&self, on: bool) {
        self.fresh_inline.store(on, Ordering::Relaxed);
    }

    pub(crate) fn cache(&self) -> Option<&Cache> {
        self.shared.cache.as_ref()
    }

    fn push(&self, p: Prio, job: Job) {
        if self.inline {
            let mut next = Some((p, job));
            while let Some((p, job)) = next {
                next = run(&self.shared, job, p);
            }
            return;
        }
        self.shared.q.lock().unwrap().jobs.push((p, job));
        self.shared.work.notify_one();
    }

    /// Runs `f` on a worker (inline in a thread-less pool).
    pub(crate) fn task(&self, f: impl FnOnce() + Send + 'static) {
        self.push((PHASE_TASK, true, true, 0), Job::Task(Box::new(f)));
    }

    /// Runs `f` on a worker after all loading work.
    pub(crate) fn idle_task(&self, f: impl FnOnce() + Send + 'static) {
        self.push((PHASE_IDLE, false, false, 0), Job::Task(Box::new(f)));
    }

    /// Waits until no loading work is queued or running, or `deadline`.
    pub(crate) fn wait_idle(&self, deadline: Instant) {
        let mut q = self.shared.q.lock().unwrap();
        while q.running > 0 || q.jobs.iter().any(|(p, _)| p.0 > PHASE_SAVE) {
            let now = Instant::now();
            if now >= deadline {
                return;
            }
            q = self.shared.done.wait_timeout(q, deadline - now).unwrap().0;
        }
    }

    /// Brings `slot` up to date with the file, as cheaply as possible.
    ///
    /// `meta`: current metadata of the file (from discovery). `budget`: bytes
    /// this caller may still read inline; decreased by what was read.
    pub(crate) fn sync(&self, slot: &Arc<Slot>, meta: &fs::Metadata, p: Prio, budget: &mut u64) {
        if slot.queued.load(Ordering::Acquire) {
            return;
        }
        // Never wait for a worker: a locked slot is simply synced next time.
        let Ok(mut st) = slot.state.try_lock() else { return };
        if st.tail.rewound_with(meta) {
            // Truncated or replaced: start over.
            st.reset();
            slot.publish(View::default());
        }
        let behind = meta.len().saturating_sub(st.tail.consumed());
        let fresh = !st.complete && !st.previewed && st.tail.consumed() == 0;
        let inline_ok = if st.complete {
            behind <= INLINE_GROW_MAX
        } else {
            // Small new files: nothing worth caching, parse right here.
            fresh && self.fresh_inline.load(Ordering::Relaxed) && meta.len() <= INLINE_NEW_MAX.min(Cache::MIN_LEN.saturating_sub(1))
        };
        if self.inline || (inline_ok && behind <= *budget) {
            if behind == 0 && st.complete {
                return;
            }
            *budget = budget.saturating_sub(behind);
            if self.inline {
                drop(st);
                slot.queued.store(true, Ordering::Release);
                self.push(p, Job::Load(slot.clone()));
                return;
            }
            let FileState { tail, parsed, .. } = &mut *st;
            tail.for_each_line(|l| parsed.line(l));
            st.complete = true;
            st.dirty = true;
            slot.publish_full(&st);
            let due = st.last_save.is_none_or(|t| t.elapsed() >= SAVE_EVERY);
            drop(st);
            if due {
                self.save_soon(slot);
            }
            return;
        }
        if behind == 0 && st.complete {
            return;
        }
        drop(st);
        slot.queued.store(true, Ordering::Release);
        self.push(p, Job::Load(slot.clone()));
    }

    fn save_soon(&self, slot: &Arc<Slot>) {
        if self.inline {
            if let Some(c) = &self.shared.cache {
                save(c, slot);
            }
            return;
        }
        queue_save(&self.shared, slot);
    }
}

impl Drop for Pool {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        // Nothing queued runs any more, except that pending cache saves are
        // written once the workers are gone (cheap: no parsing involved).
        let pending = std::mem::take(&mut self.shared.q.lock().unwrap().jobs);
        self.shared.work.notify_all();
        for w in self.workers.drain(..) {
            let _ = w.join();
        }
        if let Some(c) = &self.shared.cache {
            for (_, job) in pending {
                if let Job::Save(slot) = job {
                    save(c, &slot);
                }
            }
        }
    }
}

fn worker(s: Arc<Shared>) {
    loop {
        let (p, job) = {
            let mut q = s.q.lock().unwrap();
            loop {
                if s.stop.load(Ordering::SeqCst) {
                    return;
                }
                if let Some(i) = q.jobs.iter().enumerate().max_by_key(|(_, (p, _))| *p).map(|(i, _)| i) {
                    q.running += 1;
                    break q.jobs.swap_remove(i);
                }
                q = s.work.wait(q).unwrap();
            }
        };
        let requeue = run(&s, job, p);
        let mut q = s.q.lock().unwrap();
        q.running -= 1;
        if let Some(j) = requeue {
            q.jobs.push(j);
            s.work.notify_one();
        }
        drop(q);
        s.done.notify_all();
    }
}

/// Runs one job. A load job may hand back a follow-up (its backfill) to queue.
fn run(s: &Shared, job: Job, p: Prio) -> Option<(Prio, Job)> {
    match job {
        Job::Task(f) => {
            f();
            None
        }
        Job::Save(slot) => {
            slot.save_queued.store(false, Ordering::Release);
            if let Some(c) = &s.cache {
                save(c, &slot);
            }
            None
        }
        Job::Load(slot) => {
            let follow = load(s, &slot, p);
            if follow.is_none() {
                slot.queued.store(false, Ordering::Release);
            }
            follow.map(|p| (p, Job::Load(slot)))
        }
    }
}

/// Saves happen after all loading work, off the path of anything shown.
fn queue_save(s: &Shared, slot: &Arc<Slot>) {
    if s.cache.is_none() || slot.save_queued.swap(true, Ordering::AcqRel) {
        return;
    }
    s.q.lock().unwrap().jobs.push(((PHASE_SAVE, false, false, 0), Job::Save(slot.clone())));
    s.work.notify_one();
}

fn save(c: &Cache, slot: &Slot) {
    let mut st = slot.state.lock().unwrap();
    if !st.complete || !st.dirty {
        return;
    }
    if c.save(&st.path, &st.tail, &st.parsed) {
        st.dirty = false;
        st.last_save = Some(Instant::now());
    }
}

/// One step of loading `slot`. Returns `Some(prio)` to be queued again (backfill).
fn load(s: &Shared, slot: &Arc<Slot>, p: Prio) -> Option<Prio> {
    // 1. The persistent cache (read and validated without holding the lock).
    let (path, kind, check_cache) = {
        let mut st = slot.state.lock().unwrap();
        let check = !st.cache_checked && st.tail.consumed() == 0 && !st.complete;
        st.cache_checked = true;
        (st.path.clone(), st.parsed.kind(), check)
    };
    if check_cache
        && let Some(c) = &s.cache
        && let Some((tail, parsed)) = c.load(&path, kind)
    {
        let mut st = slot.state.lock().unwrap();
        if st.tail.consumed() == 0 && !st.complete {
            st.tail = tail;
            st.parsed = parsed;
            st.complete = true;
            st.last_save = Some(Instant::now());
            slot.publish_full(&st);
        }
    }

    // 2. A preview of a big, never-parsed file.
    let len = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let wants_preview = {
        let st = slot.state.lock().unwrap();
        !st.complete && !st.previewed && len.saturating_sub(st.tail.consumed()) > PREVIEW_MIN
    };
    if wants_preview && p.0 == PHASE_FIRST && !s.inline {
        let pv = preview(&path, kind, len);
        let mut st = slot.state.lock().unwrap();
        st.previewed = true;
        if !st.complete
            && let Some(pv) = pv
        {
            let mut v = pv.view_partial();
            v.loaded = true;
            slot.publish(v);
        }
        drop(st);
        // Backfill after every file's first pass.
        return Some((PHASE_BACKFILL, p.1, p.2, p.3));
    }

    // 3. Sequential parse to the end, a slice per lock hold.
    loop {
        if s.stop.load(Ordering::SeqCst) {
            return None;
        }
        let mut st = slot.state.lock().unwrap();
        if st.tail.rewound() {
            st.reset();
            slot.publish(View::default());
        }
        let FileState { tail, parsed, .. } = &mut *st;
        let at_end = tail.for_each_line_limit(SLICE, |l| parsed.line(l));
        if at_end {
            let first = !st.complete;
            st.complete = true;
            st.dirty = true;
            slot.publish_full(&st);
            let due = first || st.last_save.is_none_or(|t| t.elapsed() >= SAVE_EVERY);
            drop(st);
            if due {
                if s.inline {
                    if let Some(c) = &s.cache {
                        save(c, slot);
                    }
                } else {
                    queue_save(s, slot);
                }
            }
            return None;
        }
        if st.complete {
            // Catching up a loaded file: show progress as it goes.
            slot.publish_full(&st);
        }
    }
}

/// Parses the first and last part of a file: recent activity without the middle.
fn preview(path: &Path, kind: Kind, len: u64) -> Option<Parsed> {
    let mut f = File::open(path).ok()?;
    let mut p = Parsed::new(kind);
    let head_len = PREVIEW_HEAD.min(len);
    let mut head = vec![0u8; head_len as usize];
    f.read_exact(&mut head).ok()?;
    // Only complete lines: the last one may be cut.
    let head_end = head.iter().rposition(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
    feed(&head[..head_end], &mut p);

    let start = len.saturating_sub(PREVIEW_TAIL).max(head_end as u64);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut tail = Vec::with_capacity((len - start) as usize);
    f.take(len - start).read_to_end(&mut tail).ok()?;
    // Skip the line cut by `start` unless it starts exactly on a line.
    let from = if start == head_end as u64 { 0 } else { tail.iter().position(|&b| b == b'\n').map(|i| i + 1).unwrap_or(tail.len()) };
    let to = tail.iter().rposition(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0).max(from);
    feed(&tail[from..to], &mut p);
    Some(p)
}

fn feed(bytes: &[u8], p: &mut Parsed) {
    for line in bytes.split(|&b| b == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if !line.is_empty() {
            p.line(&String::from_utf8_lossy(line));
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    pub(crate) fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("coool-loader-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// A Claude transcript with repeated message ids (one usage per message),
    /// tool calls, models and a padding blob so it spans many slices.
    pub(crate) fn claude_transcript(n: usize, pad: usize) -> String {
        let blob = "x".repeat(pad);
        let mut s = String::new();
        for i in 0..n {
            let model = if i % 3 == 0 { "claude-haiku" } else { "claude-opus" };
            s += &format!("{{\"type\":\"user\",\"timestamp\":\"2026-11-14T08:00:00Z\",\"cwd\":\"/w\",\"message\":{{\"content\":\"prompt {i} {blob}\"}}}}\n");
            for b in 0..2 {
                s += &format!(
                    "{{\"type\":\"assistant\",\"timestamp\":\"2026-11-14T08:00:01Z\",\"message\":{{\"id\":\"m{i}\",\"model\":\"{model}\",\"content\":[{{\"type\":\"tool_use\",\"id\":\"t{i}-{b}\",\"name\":\"Bash\",\"input\":{{\"command\":\"c{i}\"}}}}],\"usage\":{{\"input_tokens\":{i},\"cache_creation_input_tokens\":2,\"cache_read_input_tokens\":100,\"output_tokens\":7}}}}}}\n"
                );
            }
            s += &format!("{{\"type\":\"user\",\"timestamp\":\"2026-11-14T08:00:02Z\",\"message\":{{\"content\":[{{\"type\":\"tool_result\",\"tool_use_id\":\"t{i}-0\",\"content\":\"ok\"}}]}}}}\n");
        }
        s += "{\"type\":\"ai-title\",\"aiTitle\":\"T\"}\n";
        s
    }

    pub(crate) fn codex_transcript(n: usize, pad: usize) -> String {
        let blob = "y".repeat(pad);
        let mut s = String::from("{\"timestamp\":\"2026-11-14T08:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"cid\",\"cwd\":\"/c\"}}\n");
        let (mut inp, mut out) = (0u64, 0u64);
        for i in 0..n {
            let model = if i % 2 == 0 { "gpt-a" } else { "gpt-b" };
            inp += 100 + i as u64;
            out += 3;
            s += &format!("{{\"type\":\"turn_context\",\"payload\":{{\"model\":\"{model}\",\"cwd\":\"/c\"}}}}\n");
            s += &format!("{{\"timestamp\":\"2026-11-14T08:00:01Z\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"text\":\"p{i} {blob}\"}}]}}}}\n");
            s += &format!("{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"token_count\",\"info\":{{\"total_token_usage\":{{\"input_tokens\":{inp},\"cached_input_tokens\":{},\"output_tokens\":{out}}},\"last_token_usage\":{{\"input_tokens\":{i}}}}}}}}}\n", inp / 2);
        }
        s
    }

    /// The reference: one sequential parse of the whole file.
    pub(crate) fn full_parse(path: &Path, kind: Kind) -> View {
        let mut t = Tail::new(path);
        let mut p = Parsed::new(kind);
        t.for_each_line(|l| p.line(l));
        p.view()
    }

    pub(crate) fn same(a: &View, b: &View) {
        assert_eq!(a.tokens, b.tokens);
        assert_eq!(a.models, b.models);
        assert_eq!((&a.id, &a.title, &a.cwd, &a.model, &a.last_prompt, &a.current), (&b.id, &b.title, &b.cwd, &b.model, &b.last_prompt, &b.current));
        assert_eq!(a.activity.len(), b.activity.len());
        assert!(a.activity.iter().zip(b.activity.iter()).all(|(x, y)| x.text == y.text && x.kind == y.kind && x.ts == y.ts));
        assert_eq!((a.in_turn, a.started), (b.in_turn, b.started));
        assert_eq!((a.origin, &a.parent, &a.agent_name), (b.origin, &b.parent, &b.agent_name));
    }

    fn load_with_pool(path: &Path, kind: Kind, threads: usize, cache: Option<Cache>) -> (Pool, Arc<Slot>) {
        let pool = Pool::new(threads, cache);
        let slot = Slot::new(kind, path);
        let m = fs::metadata(path).unwrap();
        let mut budget = INLINE_BUDGET;
        pool.sync(&slot, &m, prio(true, true, SystemTime::now()), &mut budget);
        pool.wait_idle(Instant::now() + Duration::from_secs(60));
        (pool, slot)
    }

    #[test]
    fn preview_then_backfill_equals_full_parse() {
        let d = tmpdir("backfill");
        for kind in [Kind::Claude, Kind::Codex] {
            let p = d.join(format!("{kind:?}.jsonl"));
            // Big enough for a preview and several slices.
            let body = match kind {
                Kind::Claude => claude_transcript(4000, 3000),
                Kind::Codex => codex_transcript(4000, 3000),
            };
            assert!(body.len() as u64 > PREVIEW_MIN + 2 * SLICE);
            fs::write(&p, &body).unwrap();
            let want = full_parse(&p, kind);

            // The preview alone is partial: recent activity, no Claude totals.
            let pv = preview(&p, kind, body.len() as u64).unwrap().view_partial();
            assert_eq!(pv.activity.last().map(|a| &a.text), want.activity.last().map(|a| &a.text));
            assert!(pv.models.is_empty());
            if kind == Kind::Claude {
                assert_eq!(pv.tokens.input, 0);
            } else {
                assert_eq!(Tokens { turn_output: 0, ..pv.tokens.clone() }, Tokens { turn_output: 0, ..want.tokens.clone() }, "codex counters are cumulative");
                assert_eq!(pv.id, "cid");
            }

            let (_pool, slot) = load_with_pool(&p, kind, 2, None);
            let got = slot.view();
            assert!(got.loaded && got.complete);
            same(&got, &want);
            assert!(want.tokens.input > 0 && !want.models.is_empty());

            // Appends after loading are picked up incrementally, still exact.
            let more = match kind {
                Kind::Claude => claude_transcript(3, 10),
                Kind::Codex => codex_transcript(3, 10).lines().skip(1).map(|l| format!("{l}\n")).collect(),
            };
            fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(more.as_bytes()).unwrap();
            let mut budget = INLINE_BUDGET;
            _pool.sync(&slot, &fs::metadata(&p).unwrap(), prio(true, true, SystemTime::now()), &mut budget);
            same(&slot.view(), &full_parse(&p, kind));
        }
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn inline_pool_parses_everything_at_once() {
        let d = tmpdir("inline");
        let p = d.join("c.jsonl");
        fs::write(&p, claude_transcript(50, 10)).unwrap();
        let (_pool, slot) = load_with_pool(&p, Kind::Claude, 0, None);
        same(&slot.view(), &full_parse(&p, Kind::Claude));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn dropping_the_pool_stops_work() {
        let d = tmpdir("drop");
        let p = d.join("c.jsonl");
        fs::write(&p, claude_transcript(4000, 3000)).unwrap();
        let pool = Pool::new(1, None);
        let slot = Slot::new(Kind::Claude, &p);
        let mut budget = 0;
        pool.sync(&slot, &fs::metadata(&p).unwrap(), prio(true, true, SystemTime::now()), &mut budget);
        let t = Instant::now();
        drop(pool);
        assert!(t.elapsed() < Duration::from_secs(5));
        let _ = fs::remove_dir_all(&d);
    }
}
