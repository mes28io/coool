//! Codex CLI adapter.
//!
//! Sources:
//! - `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`  transcripts
//! - `~/.codex/session_index.jsonl`                   thread titles
//!
//! Codex has no live-process registry, so liveness is inferred from
//! task_started / task_complete events plus file freshness.

use crate::loader::{self, Kind, Pool, Slot, View};
use crate::model::*;
use crate::tail::Tail;
use crate::util::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

#[derive(Default, Clone, Serialize, Deserialize)]
struct ParseState {
    in_turn: bool,
    /// Only the first session_meta describes this file. Forked / subagent
    /// rollouts embed the parent's session_meta further down.
    meta_seen: bool,
    started: Option<SystemTime>,
    /// Last cumulative (input incl. cached, cached, output) seen in token_count;
    /// each increase is attributed to the model in effect at that point.
    last_total: (u64, u64, u64),
    /// Newest real conversation event, epoch ms (see [`event_ms`]).
    #[serde(default)]
    last_event: Option<u64>,
    /// Naming facts (see [`crate::titles`]); the thread name comes from the index.
    #[serde(default)]
    titles: crate::titles::Facts,
    /// Helpers started from the shell (`claude -p`, `codex exec`; see [`crate::lanes`]).
    #[serde(default)]
    lanes: Vec<crate::lanes::Lane>,
    /// The last turn's end (task_complete / turn_aborted), epoch ms and how; an `error` event in the turn.
    #[serde(default)]
    end: Option<(u64, AgentState)>,
    #[serde(default)]
    errored: bool,
}

/// When a rollout line is a real conversation event: a response item (message,
/// tool call or output) or a turn / message event. Bookkeeping (session_meta,
/// turn_context, token_count, thread settings) is not activity.
pub(crate) fn event_ms(v: &Value) -> Option<u64> {
    let real = match v["type"].as_str()? {
        "response_item" => true,
        "event_msg" => matches!(
            v["payload"]["type"].as_str(),
            Some("user_message" | "agent_message" | "task_started" | "task_complete" | "turn_aborted")
        ),
        _ => false,
    };
    if real { parse_rfc3339_ms(v["timestamp"].as_str()?) } else { None }
}

/// The session fields a rollout determines.
#[derive(Default, Clone, Serialize, Deserialize)]
struct Fields {
    id: String,
    cwd: String,
    model: String,
    current: Option<String>,
    last_prompt: Option<String>,
    tokens: Tokens,
    activity: Vec<Activity>,
    models: Vec<ModelUse>,
    /// From the first session_meta (see [`crate::origin`]).
    #[serde(default)]
    originator: String,
    #[serde(default)]
    source: String,
    /// Subagent rollouts: the thread that spawned it, and its nickname / role.
    #[serde(default)]
    parent: Option<String>,
    #[serde(default)]
    agent_name: String,
}

/// Everything parsed from one rollout.
#[derive(Default, Clone, Serialize, Deserialize)]
pub(crate) struct Parsed {
    st: ParseState,
    s: Fields,
}

impl Parsed {
    pub(crate) fn line(&mut self, l: &str) {
        parse_line(l, &mut self.st, &mut self.s);
    }

    pub(crate) fn view(&self) -> View {
        let s = &self.s;
        View {
            id: s.id.clone(),
            cwd: s.cwd.clone(),
            model: s.model.clone(),
            last_prompt: s.last_prompt.clone(),
            current: s.current.clone(),
            tokens: s.tokens.clone(),
            activity: Arc::new(s.activity.clone()),
            models: s.models.clone(),
            in_turn: self.st.in_turn,
            last_event: self.st.last_event,
            started: self.st.started,
            origin: self.st.meta_seen.then(|| crate::origin::codex(&s.originator, &s.source)),
            parent: s.parent.clone(),
            agent_name: s.agent_name.clone(),
            title_facts: self.st.titles.clone(),
            lanes: self.st.lanes.clone(),
            end: self.st.end,
            ..View::default()
        }
    }
}

/// Day folders always scanned on every refresh (today and a few before).
const RECENT_DAYS: u64 = 4;
/// How often every day folder is walked, to catch resumed sessions whose
/// rollout lives in an old folder (rollouts are filed by start date).
const FULL_SCAN_EVERY: Duration = Duration::from_secs(30);

struct Entry {
    slot: Arc<Slot>,
    mtime: SystemTime,
    /// From the rollout's first line, for before the parse knows.
    early_origin: Option<Origin>,
    /// Newest real event from the file's tail, while the rollout isn't parsed yet.
    tail_event: Option<(u64, SystemTime, Option<u64>)>,
}

/// The walk of every day folder runs on the pool; its result lands here.
#[derive(Default)]
struct Walk {
    result: Option<HashSet<PathBuf>>,
    in_flight: bool,
    last: Option<Instant>,
}

pub struct CodexSource {
    root: PathBuf,
    entries: HashMap<PathBuf, Entry>,
    titles: Tail,
    title_map: HashMap<String, String>,
    /// Each thread's first name in the index: a later, different one is a rename.
    title_first: HashMap<String, String>,
    recent_window: Duration,
    /// Recently modified rollouts outside the RECENT_DAYS folders, from the last full scan.
    old_recent: HashSet<PathBuf>,
    walk: Arc<Mutex<Walk>>,
    walked: bool,
    /// For [`CodexSource::refresh`]: parses everything inline.
    own_pool: Option<Pool>,
    /// Recent day folders' listings, re-read only when the folder changed.
    dirs: StatMemo<Vec<PathBuf>>,
}

impl CodexSource {
    pub fn new(recent_window: Duration) -> Self {
        Self::with_root(dirs::home_dir().unwrap_or_default().join(".codex"), recent_window)
    }

    pub(crate) fn with_root(root: PathBuf, recent_window: Duration) -> Self {
        let titles = Tail::new(root.join("session_index.jsonl"));
        Self {
            root,
            entries: HashMap::new(),
            titles,
            title_map: HashMap::new(),
            title_first: HashMap::new(),
            recent_window,
            old_recent: HashSet::new(),
            walk: Arc::default(),
            walked: false,
            own_pool: None,
            dirs: StatMemo::default(),
        }
    }

    /// Walk every day folder again soon (throttled), e.g. while a resumed
    /// session launched by coool hasn't been found yet.
    pub fn scan_all_soon(&mut self) {
        let mut w = self.walk.lock().unwrap();
        if w.last.is_some_and(|t| t.elapsed() >= Duration::from_secs(3)) {
            w.last = None;
        }
    }

    /// When the Codex session `id` started (from its session_meta), if known.
    pub fn session_started(&self, id: &str) -> Option<SystemTime> {
        self.entries.values().map(|e| e.slot.view()).find(|v| v.id == id)?.started
    }

    /// Every parsed rollout's view, by session id (for [`crate::lanes`]: one pass, not one per session).
    pub(crate) fn views(&self) -> HashMap<String, Arc<View>> {
        self.entries.values().map(|e| e.slot.view()).filter(|v| !v.id.is_empty()).map(|v| (v.id.clone(), v)).collect()
    }

    /// What [`crate::lanes::assign`] needs of a session that may be a helper (`codex exec`).
    pub(crate) fn child(s: &Session, v: &View) -> crate::lanes::Child {
        let ms = |t: SystemTime| t.duration_since(SystemTime::UNIX_EPOCH).ok().map(|d| d.as_millis() as u64);
        crate::lanes::Child {
            provider: Some(Provider::Codex),
            cwd: s.cwd.clone(),
            model: s.model.clone(),
            started: v.started.and_then(ms),
            last: v.last_event.or(s.last_event),
            busy: v.in_turn,
            end: v.end,
            gone: s.status == Status::Ended,
        }
    }

    /// The rollout of session (or subagent thread) `id`.
    pub(crate) fn transcript(&self, id: &str) -> Option<PathBuf> {
        self.entries.iter().find(|(p, e)| {
            let v = e.slot.view();
            v.id == id || (v.id.is_empty() && id_from_name(p).as_deref() == Some(id))
        }).map(|(p, _)| p.clone())
    }

    fn is_recent(&self, now: SystemTime, mtime: SystemTime) -> bool {
        now.duration_since(mtime).map(|d| d < self.recent_window).unwrap_or(true)
    }

    fn rollouts_in(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(files) = fs::read_dir(dir) else { return };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                out.push(p);
            }
        }
    }

    /// Every rollout under sessions/YYYY/MM/DD.
    fn all_rollouts(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let sub = |p: &Path| -> Vec<PathBuf> {
            fs::read_dir(p).map(|r| r.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default()
        };
        for y in sub(&root.join("sessions")) {
            for m in sub(&y) {
                for d in sub(&m) {
                    Self::rollouts_in(&d, &mut out);
                }
            }
        }
        out
    }

    /// Re-scan and parse everything new, synchronously; returns all sessions.
    pub fn refresh(&mut self) -> Vec<Session> {
        let pool = self.own_pool.take().unwrap_or_else(|| Pool::new(0, None));
        let mut budget = u64::MAX;
        self.scan(&pool, &mut budget);
        self.own_pool = Some(pool);
        self.sessions()
    }

    /// Whether the walk of every day folder has completed at least once.
    pub(crate) fn walked(&self) -> bool {
        self.walked
    }

    /// Every wanted rollout fully parsed at least once.
    pub(crate) fn complete(&self) -> bool {
        self.entries.values().all(|e| e.slot.view().complete)
    }

    /// Cheap pass: titles, folder listings, stat. Parsing is left to `pool`.
    pub(crate) fn scan(&mut self, pool: &Pool, budget: &mut u64) {
        for l in self.titles.read_lines() {
            if let Ok(v) = serde_json::from_str::<Value>(&l)
                && let (Some(id), Some(n)) = (v["id"].as_str(), v["thread_name"].as_str()) {
                    self.title_first.entry(id.to_string()).or_insert_with(|| n.to_string());
                    self.title_map.insert(id.to_string(), n.to_string());
                }
        }

        let now = SystemTime::now();

        // Recent day folders every time; all of them every FULL_SCAN_EVERY (in
        // the background), since a resumed session keeps appending to a
        // rollout filed under its start date.
        let mut recent_dirs = Vec::new();
        for days_back in 0..RECENT_DAYS {
            let t = now - Duration::from_secs(days_back * 86400);
            recent_dirs.push(self.root.join("sessions").join(date_path(t)));
        }
        self.start_walk(pool, &recent_dirs, now);
        let mut candidates: Vec<PathBuf> = Vec::new();
        for d in &recent_dirs {
            let files = list_dir(&mut self.dirs, d).unwrap_or_default();
            candidates.extend(files.into_iter().filter(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl")));
        }
        self.dirs.retain(|p| recent_dirs.iter().any(|d| d == p));
        candidates.extend(self.old_recent.iter().cloned());
        candidates.extend(self.entries.keys().cloned());
        candidates.sort();
        candidates.dedup();

        let mut wanted: Vec<(PathBuf, fs::Metadata, SystemTime)> = candidates
            .into_iter()
            .filter_map(|p| {
                let m = fs::metadata(&p).ok()?;
                let t = m.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                Some((p, m, t))
            })
            .filter(|(_, _, t)| self.is_recent(now, *t))
            .collect();
        wanted.sort_by_key(|(_, _, t)| std::cmp::Reverse(*t));

        for (path, meta, mtime) in &wanted {
            let e = self.entries.entry(path.clone()).or_insert_with(|| Entry { slot: Slot::new(Kind::Codex, path), mtime: *mtime, early_origin: None, tail_event: None });
            e.mtime = *mtime;
            if !e.slot.view().loaded && e.tail_event.is_none_or(|(l, t, _)| (l, t) != (meta.len(), *mtime)) {
                e.tail_event = Some((meta.len(), *mtime, loader::tail_event(path, Kind::Codex)));
            }
            if e.early_origin.is_none() && !e.slot.view().loaded {
                e.early_origin = Some(crate::origin::sniff(path, Provider::Codex).unwrap_or_default());
            }
            let live = now.duration_since(*mtime).unwrap_or(Duration::ZERO) < Duration::from_secs(120);
            pool.sync(&e.slot, meta, loader::prio(live, true, *mtime), budget);
        }
        let keep: HashSet<&PathBuf> = wanted.iter().map(|(p, _, _)| p).collect();
        self.entries.retain(|p, _| keep.contains(p));
    }

    /// Picks up a finished walk, and starts one when due.
    fn start_walk(&mut self, pool: &Pool, recent_dirs: &[PathBuf], now: SystemTime) {
        let pick = |me: &mut Self| {
            if let Some(r) = me.walk.lock().unwrap().result.take() {
                me.old_recent = r;
                me.walked = true;
            }
        };
        pick(self);
        {
            let mut w = self.walk.lock().unwrap();
            if w.in_flight || w.last.is_some_and(|t| t.elapsed() < FULL_SCAN_EVERY) {
                return;
            }
            w.in_flight = true;
            w.last = Some(Instant::now());
        }
        let (root, dirs, window, walk) = (self.root.clone(), recent_dirs.to_vec(), self.recent_window, self.walk.clone());
        pool.task(move || {
            let found: HashSet<PathBuf> = Self::all_rollouts(&root)
                .into_iter()
                .filter(|p| !p.parent().is_some_and(|d| dirs.iter().any(|r| r == d)))
                .filter(|p| {
                    let m = fs::metadata(p).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
                    now.duration_since(m).map(|d| d < window).unwrap_or(true)
                })
                .collect();
            let mut w = walk.lock().unwrap();
            w.result = Some(found);
            w.in_flight = false;
        });
        // A thread-less pool ran it already.
        pick(self);
    }

    /// Sessions as currently known (cheap facts for what isn't parsed yet).
    /// A subagent rollout whose parent thread is listed becomes one of the
    /// parent's [`Agent`]s; one whose parent isn't listed stays a session of its
    /// own, classed as automation.
    pub(crate) fn sessions(&self) -> Vec<Session> {
        let now = SystemTime::now();
        let mut all: Vec<(Session, Option<String>, String, SystemTime)> = self
            .entries
            .iter()
            .map(|(path, e)| {
                let v = e.slot.view();
                let s = self.session(path, e, now);
                let started = v.started.unwrap_or(s.updated);
                (s, v.parent.clone(), v.agent_name.clone(), started)
            })
            .collect();
        // Oldest first, so agents keep a stable, spawn-like order.
        all.sort_by_key(|x| x.3);
        let (children, mut out): (Vec<_>, Vec<_>) = all.into_iter().map(|(s, p, n, _)| (s, p, n)).partition(|(_, parent, _)| parent.is_some());
        for (child, parent, name) in children {
            let parent = parent.unwrap_or_default();
            match out.iter_mut().find(|(s, _, _)| s.id == parent) {
                Some((p, _, _)) => {
                    // A Codex subagent idles between messages (its thread stays open): only a turn in progress is running.
                    let finished = child.status != Status::Busy;
                    p.agents.push(Agent {
                        id: child.id.clone(),
                        kind: if name.is_empty() { "subagent".into() } else { name },
                        description: child.last_prompt.clone().map(|t| one_line(&t, 120)).unwrap_or_default(),
                        finished,
                        state: if finished { AgentState::Done } else { AgentState::Running },
                        last_event: child.last_event,
                        current: if finished { None } else { child.current.clone() },
                        tokens: child.tokens.clone(),
                        activity: child.activity.clone(),
                        model: child.model.clone(),
                        models: child.models.clone(),
                    });
                    for m in &child.models {
                        add_model_use(&mut p.models, &ModelUse { via_agent: true, ..m.clone() });
                    }
                    sort_model_use(&mut p.models);
                    if child.updated > p.updated {
                        p.updated = child.updated;
                    }
                }
                None => out.push((child, None, String::new())),
            }
        }
        out.into_iter().map(|(s, _, _)| s).collect()
    }

    fn session(&self, path: &Path, e: &Entry, now: SystemTime) -> Session {
        let v = e.slot.view();
        // Until session_meta is parsed, the id in the file name stands in.
        let id = if v.id.is_empty() && !v.complete { id_from_name(path).unwrap_or_default() } else { v.id.clone() };
        let age = now.duration_since(e.mtime).unwrap_or(Duration::ZERO);
        let status = if v.in_turn && age < Duration::from_secs(600) {
            Status::Busy
        } else if age < Duration::from_secs(120) {
            Status::Idle
        } else {
            Status::Ended
        };
        let title_facts = crate::titles::Facts { cli_first: self.title_first.get(&id).cloned().unwrap_or_default(), ..v.title_facts.clone() };
        Session {
            provider: Provider::Codex,
            title: self.title_map.get(&id).cloned().unwrap_or_default(),
            id,
            cwd: v.cwd.clone(),
            project: String::new(),
            model: v.model.clone(),
            pid: None,
            status,
            current: if status == Status::Busy { v.current.clone() } else { None },
            last_prompt: v.last_prompt.clone(),
            tokens: v.tokens.clone(),
            activity: v.activity.clone(),
            agents: Vec::new(),
            updated: e.mtime,
            last_event: if v.loaded { v.last_event } else { e.tail_event.and_then(|t| t.2) },
            managed: None,
            chat: None,
            models: v.models.clone(),
            loaded: v.loaded,
            origin: v.origin.or(e.early_origin).unwrap_or_default(),
            parent: None,
            live_children: 0,
            background_tasks: false,
            waiting_for: None,
            shells: Vec::new(),
            lane: None,
            lanes: Vec::new(),
            title_facts,
            name: None,
        }
    }
}

/// `rollout-2026-11-14T15-32-21-<uuid>.jsonl` -> `<uuid>`.
fn id_from_name(p: &Path) -> Option<String> {
    let stem = p.file_stem()?.to_str()?;
    let id = stem.get(stem.len().checked_sub(36)?..)?;
    let b = id.as_bytes();
    let ok = b.iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() });
    ok.then(|| id.to_string())
}

pub(crate) fn date_path(t: SystemTime) -> PathBuf {
    let secs = t.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs() as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    Path::new(&format!("{:04}", tm.tm_year + 1900)).join(format!("{:02}", tm.tm_mon + 1)).join(format!("{:02}", tm.tm_mday))
}

/// The text Codex wraps around an image input (`<image name=[Image #1]>`, `</image>`), not the person's words.
fn is_image_wrapper(t: &str) -> bool {
    let t = t.trim();
    t.is_empty() || ((t.starts_with("<image") || t.starts_with("</image")) && t.ends_with('>') && !t.contains('\n'))
}

fn parse_line(line: &str, st: &mut ParseState, s: &mut Fields) {
    let Ok(v) = serde_json::from_str::<Value>(line) else { return };
    let ts = v["timestamp"].as_str().map(short_time).unwrap_or_default();
    if let Some(t) = event_ms(&v) {
        st.last_event = st.last_event.max(Some(t));
    }
    let p = &v["payload"];
    match (v["type"].as_str(), p["type"].as_str()) {
        (Some("session_meta"), _) if !st.meta_seen => {
            st.meta_seen = true;
            s.id = p["id"].as_str().unwrap_or("").to_string();
            s.cwd = p["cwd"].as_str().unwrap_or("").to_string();
            s.originator = p["originator"].as_str().unwrap_or("").to_string();
            s.source = crate::origin::codex_source_kind(&p["source"]);
            let spawn = &p["source"]["subagent"]["thread_spawn"];
            s.parent = spawn["parent_thread_id"].as_str().or(p["parent_thread_id"].as_str()).filter(|_| s.source == "subagent").map(str::to_string);
            s.agent_name = p["agent_nickname"].as_str().or(spawn["agent_nickname"].as_str()).or(spawn["agent_role"].as_str()).unwrap_or("").to_string();
            st.started = p["timestamp"].as_str().or(v["timestamp"].as_str()).and_then(parse_rfc3339).and_then(|t| {
                SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs(u64::try_from(t).ok()?))
            });
        }
        (Some("turn_context"), _) => {
            if let Some(c) = p["cwd"].as_str() {
                s.cwd = c.to_string();
            }
            if let Some(m) = p["model"].as_str() {
                s.model = m.to_string();
            }
        }
        (Some("event_msg"), Some("thread_settings_applied")) => {
            if let Some(m) = p["thread_settings"]["model"].as_str() {
                s.model = m.to_string();
            }
        }
        (Some("event_msg"), Some("task_started")) => {
            st.in_turn = true;
            st.end = None;
            st.errored = false;
            s.tokens.turn_output = 0;
            s.tokens.turn_start = v["timestamp"].as_str().and_then(parse_rfc3339_ms).or(s.tokens.turn_start);
            s.current = Some("thinking…".into());
        }
        (Some("event_msg"), Some(k @ ("task_complete" | "turn_aborted"))) => {
            st.in_turn = false;
            s.current = None;
            let at = v["timestamp"].as_str().and_then(parse_rfc3339_ms).unwrap_or(0);
            let how = if k == "turn_aborted" {
                AgentState::Stopped
            } else if st.errored && p["last_agent_message"].is_null() {
                AgentState::Failed
            } else {
                AgentState::Done
            };
            st.end = Some((at, how));
        }
        (Some("event_msg"), Some("error")) => {
            st.errored = true;
            if !st.in_turn {
                let at = v["timestamp"].as_str().and_then(parse_rfc3339_ms).unwrap_or(0);
                st.end = Some((at, AgentState::Failed));
            }
        }
        // `info` is null on rate-limit-only updates; don't zero the totals.
        (Some("event_msg"), Some("token_count")) if p["info"]["total_token_usage"].is_object() => {
            let tot = &p["info"]["total_token_usage"];
            let g = |o: &Value, k: &str| o[k].as_u64().unwrap_or(0);
            let cached = g(tot, "cached_input_tokens");
            s.tokens.input = g(tot, "input_tokens").saturating_sub(cached);
            s.tokens.cached = cached;
            s.tokens.output = g(tot, "output_tokens");
            // Totals are re-sent unchanged (e.g. on interrupt); only growth is a new response.
            let now = (g(tot, "input_tokens"), cached, g(tot, "output_tokens"));
            let (pi, pc, po) = st.last_total;
            if now.0 < pi || now.1 < pc || now.2 < po {
                // Counter went backwards (should not happen): restart from here.
                st.last_total = now;
            } else if now != st.last_total {
                let (di, dc, dout) = (now.0 - pi, now.1 - pc, now.2 - po);
                s.tokens.turn_output += dout;
                st.last_total = now;
                let model = if s.model.is_empty() { "unknown".to_string() } else { s.model.clone() };
                let used = ModelUse { model, input: di.saturating_sub(dc), cached: dc, output: dout, messages: 1, via_agent: false };
                add_model_use(&mut s.models, &used);
                sort_model_use(&mut s.models);
            }
            let last = g(&p["info"]["last_token_usage"], "input_tokens");
            if last > 0 {
                s.tokens.context = last;
            }
        }
        (Some("response_item"), Some("message")) => {
            let role = p["role"].as_str().unwrap_or("");
            let items = p["content"].as_array().map(|a| a.as_slice()).unwrap_or_default();
            // A user message's images (`input_image` data URLs) and the wrappers Codex puts around them.
            let images: Vec<(String, String, u64)> = if role == "user" { items.iter().filter_map(crate::attach::block_image).collect() } else { Vec::new() };
            let text: String = items
                .iter()
                .filter_map(|c| c["text"].as_str())
                .filter(|t| images.is_empty() || !is_image_wrapper(t))
                .collect::<Vec<_>>()
                .join("\n");
            let (clean, atts) = if role == "user" { crate::attach::split_markers(&text) } else { (text.clone(), Vec::new()) };
            if atts.is_empty() && images.is_empty() && (text.trim().is_empty() || text.trim_start().starts_with('<')) {
                return;
            }
            match role {
                "user" if !atts.is_empty() || !images.is_empty() => {
                    st.titles.prompts += 1;
                    let clean = if clean.trim_start().starts_with('<') { String::new() } else { clean };
                    s.last_prompt = Some(one_line(&clean, 400));
                    let mut a = Activity::message(ts, ActivityKind::Prompt, &clean, 400);
                    a.attachments = crate::attach::merge_images(atts, images);
                    push_activity(&mut s.activity, a);
                }
                "user" => {
                    st.titles.prompts += 1;
                    s.last_prompt = Some(one_line(&text, 400));
                    push_activity(&mut s.activity, Activity::message(ts, ActivityKind::Prompt, &text, 400));
                }
                "assistant" => {
                    push_activity(&mut s.activity, Activity::message(ts, ActivityKind::Text, &text, 400));
                }
                _ => {}
            }
        }
        (Some("compacted"), _) => {
            st.titles.compaction(p["message"].as_str().unwrap_or(""));
        }
        (Some("response_item"), Some("function_call")) | (Some("response_item"), Some("custom_tool_call")) => {
            let name = p["name"].as_str().unwrap_or("tool");
            let input: Value = p["arguments"]
                .as_str()
                .and_then(|a| serde_json::from_str(a).ok())
                .unwrap_or_else(|| p["input"].clone());
            let at = v["timestamp"].as_str().and_then(parse_rfc3339_ms).unwrap_or(0);
            let call_id = p["call_id"].as_str().unwrap_or("");
            let calls = if name == "exec" { code_mode_calls(&input) } else { vec![(name.to_string(), input.clone())] };
            let mut lanes = Vec::new();
            for (n, i) in &calls {
                if let Some((cmd, dir)) = shell_command(n, i) {
                    let cwd = dir.or_else(|| (!s.cwd.is_empty()).then(|| s.cwd.clone()));
                    lanes.extend(crate::lanes::lanes_of(call_id, &cmd, cwd.as_deref(), false, at));
                }
            }
            for (k, l) in lanes.iter_mut().enumerate() {
                l.index = k as u32;
            }
            crate::lanes::push(&mut st.lanes, lanes);
            let (name, input) = code_mode_call(name, &input).unwrap_or((name.to_string(), input));
            let sum = codex_tool_summary(&name, &input);
            push_activity(&mut s.activity, Activity::line(ts, ActivityKind::Tool, sum.clone()));
            s.current = Some(sum);
        }
        // A step that failed or was denied: an error row right after it, as Claude's `is_error` results give (the
        // ledger then leaves the step out). Code mode says "Script failed"; a plain call's output carries the reason.
        (Some("response_item"), Some("function_call_output")) | (Some("response_item"), Some("custom_tool_call_output")) => {
            let text = match &p["output"] {
                Value::String(t) => t.clone(),
                o => o.as_array().map(|a| a.iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default(),
            };
            let failed = text.starts_with("Script failed") || ["rejected by user", "declined by user", "patch rejected"].iter().any(|k| text.contains(k));
            if let Some(id) = p["call_id"].as_str()
                && st.lanes.iter().any(|l| l.tool == id)
            {
                let at = v["timestamp"].as_str().and_then(parse_rfc3339_ms).unwrap_or(0);
                // `exec_command` returns while a long command still runs ("Process running with session ID …").
                let running = text.contains("Process running with session ID");
                let exit_fail = exit_code(&text).is_some_and(|c| c != 0);
                crate::lanes::call_result(&mut st.lanes, id, at, !(failed || exit_fail), false, running.then_some(id));
            }
            if failed {
                let why = text.split("Script error:").nth(1).unwrap_or(&text).trim().to_string();
                let mut a = Activity::message(ts, ActivityKind::Error, &why, 200);
                a.step = true;
                push_activity(&mut s.activity, a);
            }
        }
        _ => {}
    }
}

/// A rollout tool call's "name · detail" line: an apply_patch names the files it writes (home-shortened, ", "
/// between them), not the patch's first line.
fn codex_tool_summary(name: &str, input: &Value) -> String {
    if name == "apply_patch" {
        let text = input.as_str().or(input["input"].as_str()).or(input["patch"].as_str()).unwrap_or("");
        let files = patch_paths(text);
        if !files.is_empty() {
            return format!("apply_patch · {}", one_line(&files.iter().map(|f| home_short(f)).collect::<Vec<_>>().join(", "), 140));
        }
    }
    tool_summary(name, input)
}

/// The files an apply_patch text writes: `*** Add File: x`, `*** Update File: x`, `*** Delete File: x`, `*** Move to: x`.
pub(crate) fn patch_paths(patch: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for l in patch.lines() {
        let p = ["*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "].iter().find_map(|k| l.strip_prefix(k)).map(str::trim);
        if let Some(p) = p.filter(|p| !p.is_empty() && !out.iter().any(|x| x == p)) {
            out.push(p.to_string());
        }
    }
    out
}

/// Codex's code mode (0.145, on by default) logs every tool call as one `exec` custom tool whose input is a short
/// script: `const r = await tools.exec_command({cmd:"ls",workdir:"/w"}); text(r.output);`. The first `tools.<name>(…)`
/// call in it is what the step does: its name (`multi_agent_v1__spawn_agent` -> `spawn_agent`) and its argument read
/// as JSON (an object literal with bare keys, or a string such as the patch). None for anything else (a plain `exec`
/// with a command, a script that calls no tool).
pub(crate) fn code_mode_call(name: &str, input: &Value) -> Option<(String, Value)> {
    if name != "exec" {
        return None;
    }
    let code = input.as_str()?;
    let at = code.find("tools.")?;
    let rest = &code[at + 6..];
    let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$'))?;
    let tool = &rest[..end];
    let after = rest[end..].trim_start();
    if tool.is_empty() || !after.starts_with('(') {
        return None;
    }
    let args = balanced(&after[1..])?;
    let tool = match tool.rfind("__") {
        Some(i) if tool.starts_with("multi_agent") => &tool[i + 2..],
        _ => tool,
    };
    let args = args.trim();
    let value = if args.is_empty() { Value::Null } else { serde_json::from_str(&js_to_json(args)).unwrap_or_else(|_| Value::String(args.to_string())) };
    Some((tool.to_string(), value))
}

/// Every `tools.<name>(…)` call in a code-mode script, in order (see [`code_mode_call`]).
pub(crate) fn code_mode_calls(input: &Value) -> Vec<(String, Value)> {
    let Some(code) = input.as_str() else { return Vec::new() };
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = code[from..].find("tools.") {
        let at = from + i;
        if let Some(c) = code_mode_call("exec", &Value::String(code[at..].to_string())) {
            out.push(c);
        }
        from = at + 6;
        if out.len() >= 32 {
            break;
        }
    }
    out
}

/// A shell tool call's command and folder: `exec_command {cmd, workdir}`, `shell` / `local_shell {command: [..]}`.
fn shell_command(name: &str, input: &Value) -> Option<(String, Option<String>)> {
    let dir = input["workdir"].as_str().or(input["cwd"].as_str()).map(str::to_string);
    match name {
        "exec_command" | "unified_exec" => Some((input["cmd"].as_str().or(input["command"].as_str())?.to_string(), dir)),
        "shell" | "local_shell" | "shell_command" => {
            let c = &input["command"];
            let cmd = c.as_str().map(str::to_string).or_else(|| c.as_array()?.last()?.as_str().map(str::to_string))?;
            Some((cmd, dir))
        }
        _ => None,
    }
}

/// "Process exited with code 1" / `"exit_code": 1` in a shell call's output.
fn exit_code(text: &str) -> Option<i64> {
    for key in ["Process exited with code ", "Exit code: ", "\"exit_code\":", "exit_code: "] {
        if let Some(i) = text.find(key) {
            let n: String = text[i + key.len()..].trim_start().chars().take_while(|c| c.is_ascii_digit() || *c == '-').collect();
            if let Ok(n) = n.parse() {
                return Some(n);
            }
        }
    }
    None
}

/// The text up to the `)` that closes an already opened `(`, skipping quoted strings; None when it never closes.
fn balanced(s: &str) -> Option<&str> {
    let mut depth = 0usize;
    let mut quote: Option<char> = None;
    let mut esc = false;
    for (i, c) in s.char_indices() {
        if let Some(q) = quote {
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' | '`' => quote = Some(c),
            '(' | '[' | '{' => depth += 1,
            ')' if depth == 0 => return Some(&s[..i]),
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    None
}

/// A JavaScript literal (bare keys, '…' / `…` strings, trailing commas) as JSON text; anything else is left alone
/// (the caller falls back to the raw text when it doesn't parse).
fn js_to_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    let cs: Vec<char> = s.chars().collect();
    let mut i = 0;
    let last_sig = |out: &String| out.chars().rev().find(|c| !c.is_whitespace());
    while i < cs.len() {
        let c = cs[i];
        if c == '"' || c == '\'' || c == '`' {
            let mut text = String::new();
            i += 1;
            while i < cs.len() && cs[i] != c {
                if cs[i] == '\\' && i + 1 < cs.len() {
                    i += 1;
                    text.push(match cs[i] {
                        'n' => '\n',
                        't' => '\t',
                        'r' => '\r',
                        o => o,
                    });
                } else {
                    text.push(cs[i]);
                }
                i += 1;
            }
            i += 1;
            out.push_str(&serde_json::to_string(&text).unwrap_or_default());
            continue;
        }
        if (c.is_ascii_alphabetic() || c == '_' || c == '$') && matches!(last_sig(&out), Some('{') | Some(',')) {
            let start = i;
            while i < cs.len() && (cs[i].is_ascii_alphanumeric() || cs[i] == '_' || cs[i] == '$') {
                i += 1;
            }
            let word: String = cs[start..i].iter().collect();
            let mut j = i;
            while j < cs.len() && cs[j].is_whitespace() {
                j += 1;
            }
            if j < cs.len() && cs[j] == ':' {
                out.push_str(&serde_json::to_string(&word).unwrap_or_default());
            } else {
                out.push_str(&word);
            }
            continue;
        }
        if (c == '}' || c == ']') && last_sig(&out) == Some(',') {
            let cut = out.trim_end().len() - 1;
            out.truncate(cut);
        }
        out.push(c);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shapes from a real codex-cli 0.145 rollout (code mode on, its default).
    #[test]
    fn code_mode_exec_reads_as_the_tool_it_calls() {
        let call = |s: &str| code_mode_call("exec", &Value::String(s.into()));
        let (n, a) = call("const r = await tools.exec_command({cmd:\"ls -la\",workdir:\"/w\",yield_time_ms:10000,max_output_tokens:2000}); text(r.output);\n").unwrap();
        assert_eq!((n.as_str(), a["cmd"].as_str(), a["yield_time_ms"].as_u64()), ("exec_command", Some("ls -la"), Some(10000)));
        let (n, a) = call("const r = await tools.apply_patch(\"*** Begin Patch\\n*** Update File: /w/notes.md\\n@@\\n-owls\\n+larks\\n*** End Patch\"); text(r);\n").unwrap();
        assert_eq!(n, "apply_patch");
        assert_eq!(patch_paths(a.as_str().unwrap()), vec!["/w/notes.md"]);
        let (n, a) = call("const r = await tools.multi_agent_v1__spawn_agent({message:'Run `echo kid`, then report.',fork_context:false,}); text(r);").unwrap();
        assert_eq!((n.as_str(), a["message"].as_str(), a["fork_context"].as_bool()), ("spawn_agent", Some("Run `echo kid`, then report."), Some(false)));
        let (n, a) = call("const r = await tools.multi_agent_v1__wait_agent({targets:[\"019\"],timeout_ms:3600000}); text(r);").unwrap();
        assert_eq!((n.as_str(), a["targets"][0].as_str()), ("wait_agent", Some("019")));
        // A script that calls no tool, an unparsable argument, another tool name.
        assert!(call("const xs = ALL_TOOLS.filter(x => /agent/.test(x.name)); text(xs);").is_none());
        assert_eq!(call("await tools.view_image({path: p})").unwrap().1, Value::String("{path: p}".into()));
        assert!(code_mode_call("exec_command", &Value::String("tools.x()".into())).is_none());
    }

    #[test]
    fn code_mode_steps_read_like_tool_calls() {
        let (_, s) = run(concat!(
            r#"{"timestamp":"2026-11-19T13:18:40Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"c1","input":"const r = await tools.exec_command({cmd:\"cargo test\",workdir:\"/w\"}); text(r.output);\n"}}"#,
            "\n",
            r#"{"timestamp":"2026-11-19T13:18:41Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"c2","input":"const r = await tools.apply_patch(\"*** Begin Patch\\n*** Add File: /w/a.txt\\n+hi\\n*** Update File: /w/b.txt\\n@@\\n-x\\n+y\\n*** End Patch\"); text(r);\n"}}"#,
            "\n",
            r#"{"timestamp":"2026-11-19T13:18:41Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c2","output":[{"type":"input_text","text":"Script failed\nWall time 1.9 seconds\nOutput:\n"},{"type":"input_text","text":"Script error:\npatch rejected by user"}]}}"#,
            "\n",
            r#"{"timestamp":"2026-11-19T13:18:42Z","type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"c3","input":"*** Begin Patch\n*** Delete File: /w/c.txt\n*** End Patch"}}"#,
            "\n",
        ));
        let lines: Vec<(&str, bool)> = s.activity.iter().map(|a| (a.text.as_str(), a.step)).collect();
        assert_eq!(lines, vec![("exec_command · cargo test", false), ("apply_patch · /w/a.txt, /w/b.txt", false), ("patch rejected by user", true), ("apply_patch · /w/c.txt", false)]);
    }

    fn run(jsonl: &str) -> (ParseState, Fields) {
        let mut st = ParseState::default();
        let mut s = Fields::default();
        for l in jsonl.lines().filter(|l| !l.trim().is_empty()) {
            parse_line(l, &mut st, &mut s);
        }
        (st, s)
    }

    /// A prompt coool sent with attachments: Codex records the text (with coool's marker lines) and each
    /// `localImage` as an `input_image` data URL, between wrapper texts.
    #[test]
    fn prompt_attachments_round_trip() {
        let f = crate::attach::Attachment { name: "notes.txt".into(), mime: "text/plain".into(), size: 9, kind: crate::attach::AttachKind::File, path: Some("/w/notes.txt".into()), key: None, note: None };
        let i = crate::attach::Attachment { name: "dot.png".into(), mime: "image/png".into(), size: 3, kind: crate::attach::AttachKind::Image, path: Some("/s/k.png".into()), key: None, note: None };
        let text = crate::attach::with_markers("describe", &[i, f]);
        let line = serde_json::json!({"timestamp": "2026-11-20T10:00:00Z", "type": "response_item", "payload": {"type": "message", "role": "user", "content": [
            {"type": "input_text", "text": text},
            {"type": "input_text", "text": "<image name=[Image #1]>"},
            {"type": "input_image", "image_url": "data:image/png;base64,AAAA"},
            {"type": "input_text", "text": "</image>"}]}});
        let (_, s) = run(&line.to_string());
        let p: Vec<_> = s.activity.iter().filter(|a| a.kind == ActivityKind::Prompt).collect();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].text, "describe");
        assert_eq!(p[0].attachments.len(), 2);
        assert_eq!(p[0].attachments[0].key.as_deref(), Some(crate::attach::key_of("AAAA").as_str()));
        assert_eq!(p[0].attachments[1].name, "notes.txt");
        assert_eq!(s.last_prompt.as_deref(), Some("describe"));
    }

    #[test]
    fn first_session_meta_wins_in_forked_rollouts() {
        let (st, s) = run(r#"
{"timestamp":"2026-11-08T11:17:56.100Z","type":"session_meta","payload":{"id":"child","timestamp":"2026-11-08T11:17:56.000Z","cwd":"/work","source":{"subagent":{}}}}
{"timestamp":"2026-11-08T11:17:56.200Z","type":"session_meta","payload":{"id":"parent","timestamp":"2026-10-02T18:16:08.000Z","cwd":"/elsewhere"}}
"#);
        assert_eq!((s.id.as_str(), s.cwd.as_str()), ("child", "/work"));
        let want = SystemTime::UNIX_EPOCH + Duration::from_secs(parse_rfc3339("2026-11-08T11:17:56Z").unwrap() as u64);
        assert_eq!(st.started, Some(want));
    }

    #[test]
    fn last_event_ignores_bookkeeping_after_the_last_real_event() {
        let (st, _) = run(r#"
{"timestamp":"2026-11-14T08:00:01Z","type":"session_meta","payload":{"id":"a","cwd":"/w"}}
{"timestamp":"2026-11-14T08:00:03.500Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}
{"timestamp":"2026-11-14T08:00:04Z","type":"event_msg","payload":{"type":"task_complete"}}
{"timestamp":"2026-11-17T18:19:00Z","type":"event_msg","payload":{"type":"token_count","info":null}}
{"timestamp":"2026-11-17T18:19:01Z","type":"turn_context","payload":{"model":"m"}}
"#);
        assert_eq!(st.last_event, parse_rfc3339_ms("2026-11-14T08:00:04Z"));
        let dir = crate::loader::tests::tmpdir("codex-tail-event");
        let p = dir.join("r.jsonl");
        std::fs::write(&p, r#"{"timestamp":"2026-11-14T08:00:03.500Z","type":"response_item","payload":{"type":"message"}}
{"timestamp":"2026-11-17T18:19:00Z","type":"event_msg","payload":{"type":"token_count"}}
"#).unwrap();
        assert_eq!(crate::loader::tail_event(&p, Kind::Codex), parse_rfc3339_ms("2026-11-14T08:00:03.500Z"));
    }

    #[test]
    fn messages_keep_their_full_text() {
        let (_, s) = run(r#"
{"timestamp":"2026-11-14T08:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"first part"},{"type":"input_text","text":"second\npart"}]}}
{"timestamp":"2026-11-14T08:00:03Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"**Done**\n\n- a\n- b"}]}}
{"timestamp":"2026-11-14T08:00:04Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}
"#);
        let a: Vec<_> = s.activity.iter().map(|a| (a.kind, a.text.as_str(), a.full.as_deref())).collect();
        assert_eq!(
            a,
            [
                (ActivityKind::Prompt, "first part second part", Some("first part\nsecond\npart")),
                (ActivityKind::Text, "**Done** - a - b", Some("**Done**\n\n- a\n- b")),
                (ActivityKind::Text, "ok", None),
            ]
        );
        assert_eq!(s.last_prompt.as_deref(), Some("first part second part"));
    }

    #[test]
    fn token_count_without_info_keeps_totals() {
        let (_, s) = run(r#"
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":50},"last_token_usage":{"input_tokens":900}}}}
{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{}}}
"#);
        assert_eq!((s.tokens.input, s.tokens.cached, s.tokens.output, s.tokens.context), (200, 800, 50, 900));
    }

    #[test]
    fn token_growth_is_attributed_to_the_model_in_effect() {
        let (_, s) = run(r#"
{"type":"turn_context","payload":{"model":"gpt-a"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10}}}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10}}}}
{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"gpt-b"}}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":400,"cached_input_tokens":40,"output_tokens":15}}}}
{"type":"event_msg","payload":{"type":"token_count","info":null}}
"#);
        let rows: Vec<_> = s.models.iter().map(|m| (m.model.as_str(), m.input, m.cached, m.output, m.messages)).collect();
        assert_eq!(rows, vec![("gpt-b", 300, 0, 5, 1), ("gpt-a", 60, 40, 10, 1)]);
    }

    #[test]
    fn turn_output_counts_growth_since_task_started() {
        let (_, s) = run(r#"
{"type":"event_msg","payload":{"type":"task_started"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}}}
{"type":"event_msg","payload":{"type":"task_complete"}}
{"type":"event_msg","payload":{"type":"task_started"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":200,"cached_input_tokens":0,"output_tokens":25}}}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":200,"cached_input_tokens":0,"output_tokens":25}}}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":0,"output_tokens":32}}}}
"#);
        assert_eq!((s.tokens.output, s.tokens.turn_output), (32, 22));
    }

    #[test]
    fn turn_lifecycle_and_tool_calls() {
        let (st, s) = run(r#"
{"timestamp":"2026-11-14T08:00:00Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-11-14T08:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"do  the\nthing"}]}}
{"timestamp":"2026-11-14T08:00:02Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"ls -la\"}"}}
"#);
        assert!(st.in_turn);
        assert_eq!(s.tokens.turn_start, parse_rfc3339_ms("2026-11-14T08:00:00Z"));
        assert_eq!(s.current.as_deref(), Some("exec_command · ls -la"));
        assert_eq!(s.last_prompt.as_deref(), Some("do the thing"));
        let (st, s) = run(r#"
{"type":"event_msg","payload":{"type":"task_started"}}
{"type":"event_msg","payload":{"type":"turn_aborted"}}
"#);
        assert!(!st.in_turn);
        assert_eq!(s.current, None);
    }
}
