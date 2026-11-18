//! Claude Code adapter.
//!
//! Sources:
//! - `~/.claude/sessions/<pid>.json`  live process registry (pid, cwd, busy/idle)
//! - `~/.claude/projects/<dir>/<session>.jsonl`  transcript
//! - `~/.claude/projects/<dir>/<session>/subagents/agent-<id>.{jsonl,meta.json}`

use crate::loader::{self, Kind, Pool, Slot, View};
use crate::model::*;
use crate::util::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

#[derive(Default, Clone, Serialize, Deserialize)]
struct ParseState {
    seen_msgs: HashSet<String>,
    /// (tool_use_id, summary) in the order the calls were made.
    open_tools: Vec<(String, String)>,
    /// Tokens per model, counted once per message like `tokens`.
    models: Vec<ModelUse>,
    /// First `entrypoint` in the transcript (how it was started, see [`crate::origin`]).
    #[serde(default)]
    entrypoint: Option<String>,
    /// A user turn was typed by a person (`turnOrigin` / `origin.kind` "human").
    #[serde(default)]
    human: bool,
    /// Recent Bash tool calls, for matching background shells (see [`crate::shells`]).
    #[serde(default)]
    bash: Vec<crate::shells::BashCall>,
    /// `Artifact` publish calls waiting for their result: (tool_use_id, step summary, input).
    #[serde(default)]
    artifacts: Vec<(String, String, Value)>,
    /// Output tokens of assistant messages since the last prompt.
    #[serde(default)]
    turn_out: u64,
    /// Newest real conversation event, epoch ms (see [`event_ms`]).
    #[serde(default)]
    last_event: Option<u64>,
    /// Naming facts (see [`crate::titles`]).
    #[serde(default)]
    titles: crate::titles::Facts,
}

/// When a transcript line is a real conversation event: a user entry, an
/// assistant message or a turn end (`system` / `turn_duration`). Metadata
/// (queue-operation, api-request, file-history-snapshot, summary, ai-title...)
/// is not activity, even though it also lands in the file.
pub(crate) fn event_ms(v: &Value) -> Option<u64> {
    let real = match v["type"].as_str()? {
        "user" | "assistant" => true,
        "system" => v["subtype"] == "turn_duration",
        _ => false,
    };
    if real { parse_rfc3339_ms(v["timestamp"].as_str()?) } else { None }
}

/// Everything parsed from one transcript (main session or subagent).
#[derive(Default, Clone, Serialize, Deserialize)]
pub(crate) struct Parsed {
    p: ParseState,
    title: String,
    cwd: String,
    model: String,
    last_prompt: Option<String>,
    current: Option<String>,
    tokens: Tokens,
    activity: Vec<Activity>,
}

impl Parsed {
    pub(crate) fn line(&mut self, l: &str) {
        let s = self;
        parse_line(l, &mut s.p, &mut s.title, &mut s.cwd, &mut s.model, &mut s.last_prompt, &mut s.current, &mut s.tokens, &mut s.activity);
    }

    pub(crate) fn view(&self) -> View {
        let mut models = self.p.models.clone();
        sort_model_use(&mut models);
        View {
            title: self.title.clone(),
            cwd: self.cwd.clone(),
            model: self.model.clone(),
            last_prompt: self.last_prompt.clone(),
            current: self.current.clone(),
            tokens: Tokens { turn_output: self.p.turn_out, ..self.tokens.clone() },
            activity: Arc::new(self.activity.clone()),
            models,
            origin: self.p.entrypoint.as_ref().map(|e| crate::origin::claude(Some(e), self.p.human)),
            bash: self.p.bash.clone(),
            last_event: self.p.last_event,
            title_facts: self.p.titles.clone(),
            ..View::default()
        }
    }
}

struct AgentEntry {
    id: String,
    slot: Arc<Slot>,
    has_file: bool,
    kind: String,
    description: String,
    finished: bool,
    meta_model: Option<String>,
}

struct Entry {
    slot: Arc<Slot>,
    mtime: SystemTime,
    live: Option<Live>,
    /// Name / folder from the registry while it was live; used when the
    /// transcript doesn't say (yet).
    reg_title: String,
    reg_cwd: String,
    /// Origin from the registry's `entrypoint` or the transcript's first records,
    /// for before the parse knows (see [`crate::origin::sniff`]).
    early_origin: Option<Origin>,
    /// Newest real event from the file's tail, for while the transcript isn't
    /// parsed yet: (file length, mtime it was read at, result).
    tail_event: Option<(u64, SystemTime, Option<u64>)>,
    /// In first-seen order.
    agents: Vec<AgentEntry>,
}

/// What a refresh re-reads only when the file or folder changed (see [`StatMemo`]).
#[derive(Default)]
struct Memos {
    /// Folder listings: projects/, each project folder, each subagents folder, sessions/.
    dirs: StatMemo<Vec<PathBuf>>,
    /// Registry files, parsed (None: not a usable entry).
    registry: StatMemo<Option<RegEntry>>,
    /// Subagent `meta.json`s, parsed.
    metas: StatMemo<AgentMeta>,
}

/// A registry file: (pid, session id, `startedAt`, what it says).
type RegEntry = (u32, String, Option<u64>, Live);

#[derive(Clone, Default)]
struct AgentMeta {
    kind: String,
    description: String,
    finished: bool,
    model: Option<String>,
}

pub struct ClaudeSource {
    root: PathBuf,
    entries: HashMap<String, Entry>,
    recent_window: Duration,
    /// For [`ClaudeSource::refresh`]: parses everything inline.
    own_pool: Option<Pool>,
    memo: Memos,
}

impl ClaudeSource {
    pub fn new(recent_window: Duration) -> Self {
        Self::with_root(dirs::home_dir().unwrap_or_default().join(".claude"), recent_window)
    }

    pub(crate) fn with_root(root: PathBuf, recent_window: Duration) -> Self {
        Self { root, entries: HashMap::new(), recent_window, own_pool: None, memo: Memos::default() }
    }

    /// Re-scan and parse everything new, synchronously; returns all sessions.
    pub fn refresh(&mut self) -> Vec<Session> {
        let pool = self.own_pool.take().unwrap_or_else(|| Pool::new(0, None));
        let mut budget = u64::MAX;
        self.scan(&pool, &mut budget);
        self.own_pool = Some(pool);
        self.sessions()
    }

    /// Cheap pass: registry, listing, stat. Parsing is left to `pool`
    /// (small reads inline, within `budget` bytes).
    pub(crate) fn scan(&mut self, pool: &Pool, budget: &mut u64) {
        let mut listed: HashSet<PathBuf> = HashSet::new();
        let mut metas_seen: HashSet<PathBuf> = HashSet::new();
        let mut live = self.read_registry(&mut listed);
        let now = SystemTime::now();

        // Discover transcripts: every live session + anything touched recently.
        // Folder listings are reused while the folder is unchanged; every
        // transcript is still stat-ed (one stat each), since appends don't move
        // the folder's mtime.
        let mut wanted: HashMap<String, (PathBuf, fs::Metadata)> = HashMap::new();
        let projects = self.root.join("projects");
        listed.insert(projects.clone());
        for d in list_dir(&mut self.memo.dirs, &projects).unwrap_or_default() {
            let Some(files) = list_dir(&mut self.memo.dirs, &d) else { continue };
            listed.insert(d);
            for p in files {
                if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let Ok(m) = fs::metadata(&p) else { continue };
                let id = p.file_stem().unwrap().to_string_lossy().to_string();
                let mtime = m.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                let recent = now.duration_since(mtime).map(|d| d < self.recent_window).unwrap_or(true);
                if recent || live.contains_key(&id) {
                    wanted.insert(id, (p, m));
                }
            }
        }

        // Live first, then most recently written.
        let mut order: Vec<(&String, &(PathBuf, fs::Metadata))> = wanted.iter().collect();
        order.sort_by_key(|(id, (_, m))| std::cmp::Reverse((live.contains_key(*id), m.modified().ok())));
        for (id, (path, meta)) in order {
            let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let e = self.entries.entry(id.clone()).or_insert_with(|| Entry {
                slot: Slot::new(Kind::Claude, path),
                mtime,
                live: None,
                reg_title: String::new(),
                reg_cwd: String::new(),
                early_origin: None,
                tail_event: None,
                agents: Vec::new(),
            });
            e.mtime = mtime;
            if !e.slot.view().loaded && e.tail_event.is_none_or(|(l, t, _)| (l, t) != (meta.len(), mtime)) {
                e.tail_event = Some((meta.len(), mtime, loader::tail_event(path, Kind::Claude)));
            }
            e.live = live.remove(id);
            if let Some(r) = &e.live {
                if !r.name.is_empty() {
                    e.reg_title = r.name.clone();
                }
                if !r.cwd.is_empty() {
                    e.reg_cwd = r.cwd.clone();
                }
            }
            if e.early_origin.is_none() && !e.slot.view().loaded {
                // Once per transcript; the registry's `entrypoint` (no turn markers) as a fallback.
                let reg = e.live.as_ref().and_then(|r| r.entrypoint.as_deref()).map(|ep| crate::origin::claude(Some(ep), false));
                e.early_origin = Some(crate::origin::sniff(path, Provider::Claude).or(reg).unwrap_or_default());
            }
            let is_live = e.live.is_some();
            pool.sync(&e.slot, meta, loader::prio(is_live, true, mtime), budget);
            let dir = path.with_extension("").join("subagents");
            scan_agents(e, &dir, &mut self.memo, &mut metas_seen, pool, budget);
            listed.insert(dir);
        }

        self.entries.retain(|id, _| wanted.contains_key(id));
        self.memo.dirs.retain(|p| listed.contains(p));
        self.memo.metas.retain(|p| metas_seen.contains(p));
    }

    /// Every wanted transcript (and subagent transcript) fully parsed at least once.
    pub(crate) fn complete(&self) -> bool {
        self.entries.values().all(|e| e.slot.view().complete && e.agents.iter().all(|a| !a.has_file || a.slot.view().complete))
    }

    /// Sessions as currently known (cheap facts for what isn't parsed yet).
    pub(crate) fn sessions(&self) -> Vec<Session> {
        self.entries.iter().map(|(id, e)| session(id, e)).collect()
    }

    /// The transcript of a session, or of one of its subagents.
    pub(crate) fn transcript(&self, id: &str, agent: Option<&str>) -> Option<PathBuf> {
        let e = self.entries.get(id)?;
        match agent {
            None => Some(e.slot.path()),
            Some(a) => e.agents.iter().find(|x| x.id == a && x.has_file).map(|x| x.slot.path()),
        }
    }

    /// Recent Bash calls of a session and its subagents (they run in the same
    /// process, so their shells are its children too) that may still run
    /// (foreground calls that returned are left out), oldest first.
    pub(crate) fn bash_calls(&self, id: &str) -> Vec<crate::shells::BashCall> {
        let Some(e) = self.entries.get(id) else { return Vec::new() };
        let open = |v: &[crate::shells::BashCall]| v.iter().filter(|c| !c.done).cloned().collect::<Vec<_>>();
        let mut out = open(&e.slot.view().bash);
        for a in &e.agents {
            out.extend(open(&a.slot.view().bash));
        }
        out.sort_by_key(|c| c.at);
        out
    }

    /// Live sessions from the registry. Each file is parsed again only when it
    /// changed; whether its process is (still) alive is checked every time.
    fn read_registry(&mut self, listed: &mut HashSet<PathBuf>) -> HashMap<String, Live> {
        let mut out = HashMap::new();
        let dir = self.root.join("sessions");
        let Some(files) = list_dir(&mut self.memo.dirs, &dir) else {
            self.memo.registry.retain(|_| false);
            return out;
        };
        listed.insert(dir);
        let mut seen = HashSet::new();
        for p in files {
            if p.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(meta) = fs::metadata(&p) else { continue };
            if let Some((pid, sid, started_at, live)) = self.memo.registry.get(&p, &meta, || parse_registry(&p))
                && pid_alive(*pid)
                && !pid_reused(*pid, *started_at)
            {
                out.insert(sid.clone(), live.clone());
            }
            seen.insert(p);
        }
        self.memo.registry.retain(|p| seen.contains(p));
        out
    }
}

/// One registry file: (pid, session id, startedAt, what it says), if usable.
fn parse_registry(p: &Path) -> Option<RegEntry> {
    let v = fs::read_to_string(p).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok())?;
    let (Some(pid), Some(sid)) = (v["pid"].as_u64().and_then(|p| u32::try_from(p).ok()), v["sessionId"].as_str()) else { return None };
    let live = Live {
        pid,
        cwd: v["cwd"].as_str().unwrap_or("").to_string(),
        // `nameSource: "derived"` is Claude Code's placeholder ("proj-a3": the folder and a few hex digits) until the
        // session has a real name; taken as a title it showed until the first prompt and then stayed in the
        // session's earlier titles ("was: proj-a3").
        name: if v["nameSource"].as_str() == Some("derived") { String::new() } else { v["name"].as_str().unwrap_or("").to_string() },
        busy: v["status"].as_str() == Some("busy"),
        // `shell`: the turn is over but background tasks still run (the
        // CLI's own UI shows that as working). `waiting`: blocked on the person.
        shell: v["status"].as_str() == Some("shell"),
        waiting_for: (v["status"].as_str() == Some("waiting")).then(|| v["waitingFor"].as_str().unwrap_or("input").to_string()),
        entrypoint: v["entrypoint"].as_str().map(str::to_string),
    };
    Some((pid, sid.to_string(), v["startedAt"].as_u64(), live))
}

fn session(id: &str, e: &Entry) -> Session {
    let v = e.slot.view();
    let (pid, status) = match &e.live {
        Some(r) => (Some(r.pid), if r.busy { Status::Busy } else { Status::Idle }),
        None => (None, Status::Ended),
    };
    // Waiting for the user (or gone): whatever the transcript last showed
    // (e.g. "thinking…" before an Esc interrupt) is stale.
    let current = if status == Status::Busy { v.current.clone() } else { None };
    let agents: Vec<Agent> = e
        .agents
        .iter()
        .map(|a| {
            let av = a.slot.view();
            let finished = a.finished || status == Status::Ended;
            Agent {
                id: a.id.clone(),
                kind: a.kind.clone(),
                description: a.description.clone(),
                finished,
                current: if finished { None } else { av.current.clone() },
                tokens: av.tokens.clone(),
                activity: av.activity.clone(),
                // What it ran on most (a full id); else as launched (meta.json, often an alias).
                model: av.models.first().map(|m| m.model.clone()).or_else(|| a.meta_model.clone()).unwrap_or_default(),
                models: av.models.clone(),
            }
        })
        .collect();
    let models = session_models(v.models.clone(), &agents);
    Session {
        provider: Provider::Claude,
        id: id.to_string(),
        title: if v.title.is_empty() { e.reg_title.clone() } else { v.title.clone() },
        cwd: if v.cwd.is_empty() { e.reg_cwd.clone() } else { v.cwd.clone() },
        model: v.model.clone(),
        project: String::new(),
        pid,
        status,
        current,
        last_prompt: v.last_prompt.clone(),
        tokens: v.tokens.clone(),
        activity: v.activity.clone(),
        agents,
        updated: e.mtime,
        last_event: if v.loaded { v.last_event } else { e.tail_event.and_then(|t| t.2) },
        managed: None,
        chat: None,
        models,
        loaded: v.loaded,
        origin: v.origin.or(e.early_origin).unwrap_or_default(),
        parent: None,
        live_children: 0,
        background_tasks: e.live.as_ref().is_some_and(|r| r.shell),
        waiting_for: e.live.as_ref().and_then(|r| r.waiting_for.clone()),
        shells: Vec::new(),
        title_facts: v.title_facts.clone(),
        name: None,
    }
}

fn scan_agents(e: &mut Entry, dir: &Path, memo: &mut Memos, seen: &mut HashSet<PathBuf>, pool: &Pool, budget: &mut u64) {
    let Some(entries) = list_dir(&mut memo.dirs, dir) else { return };
    let mut metas: Vec<(String, PathBuf)> = entries
        .into_iter()
        .filter_map(|p| {
            let name = p.file_name()?.to_string_lossy().to_string();
            let id = name.strip_prefix("agent-")?.strip_suffix(".meta.json")?.to_string();
            Some((id, p))
        })
        .collect();
    metas.sort();
    let live = e.live.is_some();
    for (aid, meta_path) in metas {
        // Re-read only when it changed (`finished` flips once, at the end).
        let meta = match fs::metadata(&meta_path) {
            Ok(m) => {
                seen.insert(meta_path.clone());
                memo.metas.get(&meta_path, &m, || parse_agent_meta(&meta_path)).clone()
            }
            Err(_) => parse_agent_meta(&meta_path),
        };
        let jl = dir.join(format!("agent-{aid}.jsonl"));
        let idx = match e.agents.iter().position(|a| a.id == aid) {
            Some(i) => i,
            None => {
                e.agents.push(AgentEntry {
                    id: aid.clone(),
                    slot: Slot::new(Kind::Claude, &jl),
                    has_file: false,
                    kind: String::new(),
                    description: String::new(),
                    finished: false,
                    meta_model: None,
                });
                e.agents.len() - 1
            }
        };
        let a = &mut e.agents[idx];
        a.kind = meta.kind;
        a.description = meta.description;
        a.finished = meta.finished;
        a.meta_model = meta.model;
        match fs::metadata(&jl) {
            Ok(m) => {
                a.has_file = true;
                let mtime = m.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                pool.sync(&a.slot, &m, loader::prio(live, false, mtime), budget);
            }
            Err(_) => a.has_file = false,
        }
    }
}

fn parse_agent_meta(p: &Path) -> AgentMeta {
    let meta: Value = fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    AgentMeta {
        kind: meta["agentType"].as_str().unwrap_or("agent").to_string(),
        description: meta["description"].as_str().unwrap_or("").to_string(),
        finished: meta["finished"].as_bool().unwrap_or(false),
        model: meta["model"].as_str().map(str::to_string),
    }
}

/// A registry file left behind by a crashed session can name a pid that the OS
/// has since handed to an unrelated process. The registry records when the
/// session started (`startedAt`, epoch ms, written just after process start);
/// a process that started clearly later cannot be the one that wrote it.
fn pid_reused(pid: u32, started_at_ms: Option<u64>) -> bool {
    match (started_at_ms, process_start_ms(pid)) {
        (Some(reg), Some(proc_start)) => proc_start > reg + 10_000,
        _ => false,
    }
}

/// Re-validates, right before signalling, that `pid` still is the live Claude
/// process for `session_id` (registry entry present, pid alive and not reused).
pub fn live_pid_for(session_id: &str, pid: u32) -> bool {
    let root = dirs::home_dir().unwrap_or_default().join(".claude").join("sessions");
    let Some(v) = fs::read_to_string(root.join(format!("{pid}.json"))).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) else {
        return false;
    };
    v["sessionId"].as_str() == Some(session_id) && v["pid"].as_u64() == Some(pid as u64) && pid_alive(pid) && !pid_reused(pid, v["startedAt"].as_u64())
}

#[derive(Clone)]
struct Live {
    pid: u32,
    cwd: String,
    name: String,
    busy: bool,
    shell: bool,
    waiting_for: Option<String>,
    entrypoint: Option<String>,
}

#[allow(clippy::too_many_arguments)]
fn parse_line(
    line: &str,
    st: &mut ParseState,
    title: &mut String,
    cwd: &mut String,
    model: &mut String,
    last_prompt: &mut Option<String>,
    current: &mut Option<String>,
    tokens: &mut Tokens,
    activity: &mut Vec<Activity>,
) {
    // Cheap pre-filter: api-request records can be huge and are irrelevant.
    if line.contains("\"type\":\"api-request") || line.contains("\"type\":\"file-history-snapshot\"") {
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else { return };
    let ts = v["timestamp"].as_str().map(short_time).unwrap_or_default();
    if let Some(t) = event_ms(&v) {
        st.last_event = st.last_event.max(Some(t));
    }
    if st.entrypoint.is_none()
        && let Some(e) = v["entrypoint"].as_str()
    {
        st.entrypoint = Some(e.to_string());
    }
    if v["type"] == "user" && crate::origin::claude_human(&v) {
        st.human = true;
    }
    if let Some(c) = v["cwd"].as_str()
        && cwd.is_empty() {
            *cwd = c.to_string();
        }
    match v["type"].as_str() {
        Some("ai-title") => {
            if let Some(t) = v["aiTitle"].as_str() {
                *title = t.to_string();
                st.titles.cli_title(t);
            }
        }
        // `/rename`: the person's own name for it, in the CLI.
        Some("custom-title") => {
            if let Some(t) = v["customTitle"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
                st.titles.custom = Some(t.to_string());
            }
        }
        // A compaction summary: shown like before (as a prompt), counted as a checkpoint, not a prompt.
        Some("user") if v["isCompactSummary"].as_bool() == Some(true) => {
            let c = &v["message"]["content"];
            let s = c.as_str().map(str::to_string).or_else(|| result_text(c)).unwrap_or_default();
            st.titles.compaction(&s);
            if !s.trim().is_empty() && !s.starts_with('<') {
                push_activity(activity, Activity::message(ts, ActivityKind::Prompt, &s, 400));
            }
        }
        Some("last-prompt") => {
            if let Some(t) = v["lastPrompt"].as_str() {
                *last_prompt = Some(t.to_string());
            }
        }
        // A message typed while the turn ran, taken in between two steps
        // (Claude Code 2.1.x): it never appears as a `user` line of its own.
        Some("attachment") if v["attachment"]["type"] == "queued_command" && v["attachment"]["commandMode"].as_str().is_none_or(|m| m == "prompt") => {
            let p = &v["attachment"]["prompt"];
            let s = p.as_str().map(str::to_string).or_else(|| result_text(p)).unwrap_or_default();
            if !s.trim().is_empty() && !s.starts_with('<') {
                st.titles.prompts += 1;
                push_activity(activity, Activity::message(ts, ActivityKind::Prompt, &s, 400));
            }
        }
        Some("system") if v["subtype"] == "turn_duration" => {
            *current = None;
            st.open_tools.clear();
        }
        Some("user") => {
            let content = &v["message"]["content"];
            if let Some(s) = content.as_str() {
                if v["isMeta"].as_bool() != Some(true) && !s.starts_with('<') {
                    user_text(s, ts, st, current, activity);
                }
            } else if let Some(arr) = content.as_array() {
                for item in arr {
                    match item["type"].as_str() {
                        Some("tool_result") => {
                            if let Some(id) = item["tool_use_id"].as_str() {
                                st.open_tools.retain(|(t, _)| t != id);
                                bash_result(st, id, &item["content"]);
                                if item["is_error"].as_bool() != Some(true) {
                                    artifact_result(st, id, &item["content"], &v["toolUseResult"], activity);
                                }
                            }
                            if item["is_error"].as_bool() == Some(true) {
                                let txt = result_text(&item["content"]).unwrap_or_else(|| "tool error".into());
                                let mut a = Activity::message(ts.clone(), ActivityKind::Error, &txt, 200);
                                a.step = true;
                                push_activity(activity, a);
                            }
                            // Still-running parallel calls take precedence; the most recent one wins.
                            *current = st.open_tools.last().map(|(_, s)| s.clone()).or(Some("thinking…".into()));
                        }
                        Some("text") => {
                            let s = item["text"].as_str().unwrap_or("");
                            if !s.starts_with('<') && v["isMeta"].as_bool() != Some(true) {
                                user_text(s, ts.clone(), st, current, activity);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        Some("assistant") => {
            let msg = &v["message"];
            if let Some(m) = msg["model"].as_str()
                && m != "<synthetic>" {
                    *model = m.to_string();
                }
            if v["isApiErrorMessage"].as_bool() == Some(true) {
                let txt = msg["content"][0]["text"].as_str().unwrap_or("API error");
                push_activity(activity, Activity::message(ts.clone(), ActivityKind::Error, txt, 200));
                *current = None;
            }
            // Usage is repeated on every content block of a message; count it once.
            let mid = msg["id"].as_str().or(v["requestId"].as_str()).unwrap_or("").to_string();
            {
                // Claude Code's subagent count: the latest response's context plus its output.
                // Every record counts (a message's later records can carry a larger output).
                let u = &msg["usage"];
                let g = |k: &str| u[k].as_u64().unwrap_or(0);
                let ctx = g("input_tokens") + g("cache_creation_input_tokens") + g("cache_read_input_tokens");
                if ctx > 0 {
                    tokens.total = ctx + g("output_tokens");
                }
            }
            if !mid.is_empty() && st.seen_msgs.insert(mid) {
                let u = &msg["usage"];
                let g = |k: &str| u[k].as_u64().unwrap_or(0);
                tokens.input += g("input_tokens") + g("cache_creation_input_tokens");
                tokens.cached += g("cache_read_input_tokens");
                tokens.output += g("output_tokens");
                st.turn_out += g("output_tokens");
                // `<synthetic>` marks locally generated messages (errors, command output).
                if let Some(m) = msg["model"].as_str().filter(|m| !m.is_empty() && *m != "<synthetic>") {
                    let used = ModelUse {
                        model: m.to_string(),
                        input: g("input_tokens") + g("cache_creation_input_tokens"),
                        cached: g("cache_read_input_tokens"),
                        output: g("output_tokens"),
                        messages: 1,
                        via_agent: false,
                    };
                    add_model_use(&mut st.models, &used);
                }
                let ctx = g("input_tokens") + g("cache_creation_input_tokens") + g("cache_read_input_tokens");
                if ctx > 0 {
                    tokens.context = ctx;
                }
            }
            if let Some(arr) = msg["content"].as_array() {
                for item in arr {
                    match item["type"].as_str() {
                        Some("tool_use") => {
                            let name = item["name"].as_str().unwrap_or("tool");
                            let sum = tool_summary(name, &item["input"]);
                            if let Some(id) = item["id"].as_str() {
                                st.open_tools.retain(|(t, _)| t != id);
                                st.open_tools.push((id.to_string(), sum.clone()));
                            }
                            if name == "Bash"
                                && let (Some(id), Some(cmd)) = (item["id"].as_str(), item["input"]["command"].as_str())
                            {
                                let input = &item["input"];
                                let call = crate::shells::BashCall {
                                    id: id.to_string(),
                                    command: cmd.to_string(),
                                    description: input["description"].as_str().map(str::to_string),
                                    background: input["run_in_background"].as_bool() == Some(true),
                                    at: v["timestamp"].as_str().and_then(parse_rfc3339).map(|s| (s.max(0) as u64) * 1000).unwrap_or(0),
                                    output: None,
                                    done: false,
                                };
                                st.bash.retain(|c| c.id != id);
                                crate::shells::push_call(&mut st.bash, call);
                            }
                            if crate::artifact::is_publish(name, &item["input"])
                                && let Some(id) = item["id"].as_str()
                            {
                                st.artifacts.retain(|(t, _, _)| t != id);
                                st.artifacts.push((id.to_string(), sum.clone(), item["input"].clone()));
                                // Bounded: calls whose result never came.
                                if st.artifacts.len() > 16 {
                                    st.artifacts.remove(0);
                                }
                            }
                            let kind = if name == "Agent" || name == "Task" { ActivityKind::Agent } else { ActivityKind::Tool };
                            push_activity(activity, Activity::line(ts.clone(), kind, sum.clone()));
                            *current = Some(sum);
                        }
                        Some("text") if v["isApiErrorMessage"].as_bool() != Some(true) => {
                            let s = item["text"].as_str().unwrap_or("");
                            if !s.trim().is_empty() {
                                push_activity(activity, Activity::message(ts.clone(), ActivityKind::Text, s, 400));
                            }
                        }
                        Some("thinking") => {
                            *current = Some("thinking…".into());
                        }
                        _ => {}
                    }
                }
            }
        }
        _ => {}
    }
}

/// One transcript file's timeline, parsed the way a session's is (for tools; the app goes through [`ClaudeSource`]).
pub fn timeline(path: &Path) -> std::io::Result<Vec<Activity>> {
    let mut p = Parsed::default();
    for l in fs::read_to_string(path)?.lines() {
        p.line(l);
    }
    Ok(p.activity)
}

/// A session's own model rows plus its subagents' rows (flagged `via_agent`), most used first.
fn session_models(own: Vec<ModelUse>, agents: &[Agent]) -> Vec<ModelUse> {
    let mut out = own;
    for a in agents {
        for m in &a.models {
            add_model_use(&mut out, &ModelUse { via_agent: true, ..m.clone() });
        }
    }
    sort_model_use(&mut out);
    out
}

/// A Bash call's tool_result: a foreground call is over; a background one (or
/// one the person moved to the background) names its output file.
fn bash_result(st: &mut ParseState, id: &str, content: &Value) {
    let Some(c) = st.bash.iter_mut().find(|c| c.id == id) else { return };
    let text = result_text(content).unwrap_or_default();
    match crate::shells::output_from_result(&text) {
        Some(p) => {
            c.output = Some(p);
            c.background = true;
        }
        None if !c.background => c.done = true,
        None => {}
    }
}

/// An `Artifact` publish call's result: the step that made the call carries what it published.
fn artifact_result(st: &mut ParseState, id: &str, content: &Value, structured: &Value, activity: &mut [Activity]) {
    let Some(i) = st.artifacts.iter().position(|(t, _, _)| t == id) else { return };
    let (_, sum, input) = st.artifacts.remove(i);
    let Some(info) = crate::artifact::from_publish(&input, &result_text(content).unwrap_or_default(), structured) else { return };
    if let Some(step) = activity.iter_mut().rev().find(|a| a.kind == ActivityKind::Tool && a.artifact.is_none() && a.text == sum) {
        step.artifact = Some(Box::new(info));
    }
}

/// A user text block: either a real prompt or Claude Code's interrupt marker.
fn user_text(s: &str, ts: String, st: &mut ParseState, current: &mut Option<String>, activity: &mut Vec<Activity>) {
    if s.starts_with("[Request interrupted by user") {
        // The turn is over; calls that never got a result are abandoned.
        st.open_tools.clear();
        *current = None;
        push_activity(activity, Activity::line(ts, ActivityKind::Error, "interrupted by user"));
        return;
    }
    push_activity(activity, Activity::message(ts, ActivityKind::Prompt, s, 400));
    st.titles.prompts += 1;
    st.turn_out = 0;
    *current = Some("thinking…".into());
}

/// tool_result content is either a string or a list of content blocks.
fn result_text(c: &Value) -> Option<String> {
    if let Some(s) = c.as_str() {
        return Some(s.to_string());
    }
    let t: Vec<&str> = c.as_array()?.iter().filter_map(|b| b["text"].as_str()).collect();
    (!t.is_empty()).then(|| t.join(" "))
}

#[cfg(test)]
mod tests {
    #[test]
    fn registry_placeholder_names_are_not_titles() {
        let d = std::env::temp_dir().join(format!("coool-registry-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("1.json");
        std::fs::write(&f, r#"{"pid":1,"sessionId":"s","cwd":"/w/proj","name":"proj-a3","nameSource":"derived","status":"idle"}"#).unwrap();
        assert_eq!(super::parse_registry(&f).unwrap().3.name, "");
        std::fs::write(&f, r#"{"pid":1,"sessionId":"s","cwd":"/w/proj","name":"Fix the flaky test","nameSource":"user","status":"idle"}"#).unwrap();
        assert_eq!(super::parse_registry(&f).unwrap().3.name, "Fix the flaky test");
        std::fs::write(&f, r#"{"pid":1,"sessionId":"s","cwd":"/w/proj","name":"Older CLI","status":"idle"}"#).unwrap();
        assert_eq!(super::parse_registry(&f).unwrap().3.name, "Older CLI");
        let _ = std::fs::remove_dir_all(&d);
    }

    use super::*;
    use serde_json::json;

    #[derive(Default)]
    struct Out {
        st: ParseState,
        title: String,
        cwd: String,
        model: String,
        last_prompt: Option<String>,
        current: Option<String>,
        tokens: Tokens,
        activity: Vec<Activity>,
    }

    fn feed(o: &mut Out, jsonl: &str) {
        for l in jsonl.lines().filter(|l| !l.trim().is_empty()) {
            parse_line(l, &mut o.st, &mut o.title, &mut o.cwd, &mut o.model, &mut o.last_prompt, &mut o.current, &mut o.tokens, &mut o.activity);
        }
    }

    const TS: &str = r#""timestamp":"2026-11-14T08:09:06.024Z""#;

    fn tool_use(id: &str, cmd: &str) -> String {
        format!(r#"{{"type":"assistant",{TS},"message":{{"id":"m-{id}","model":"claude-x","content":[{{"type":"tool_use","id":"{id}","name":"Bash","input":{{"command":"{cmd}"}}}}],"usage":{{"input_tokens":1,"output_tokens":1}}}}}}"#)
    }

    fn tool_result(id: &str) -> String {
        format!(r#"{{"type":"user",{TS},"message":{{"content":[{{"type":"tool_result","tool_use_id":"{id}","content":"ok"}}]}}}}"#)
    }

    /// Prompts, replies and errors keep their whole text (line breaks
    /// included) beside the one-line form; tool steps stay one line.
    #[test]
    fn artifact_publishes_are_parsed_and_other_actions_stay_steps() {
        let mut o = Out::default();
        for l in include_str!("artifact_fixtures/printer.jsonl").lines() {
            feed(&mut o, l);
        }
        let steps: Vec<&Activity> = o.activity.iter().filter(|a| a.kind == ActivityKind::Tool).collect();
        assert_eq!(steps.len(), 4, "quickstart + three publishes");
        assert!(steps[0].artifact.is_none(), "quickstart is not a page");
        let dir = "/private/tmp/claude-501/-Users-mdapro--claude-spares-spare-7JKFOZ/3ab36589-be76-44e1-8fb0-015ae4826f14/scratchpad/rehber/";
        for (i, s) in steps[1..].iter().enumerate() {
            let a = s.artifact.as_ref().expect("a publish carries its artifact");
            assert_eq!(a.url, "https://claude.ai/artifact/2z4giSyysLF1DLHG4j2bLD");
            assert_eq!(a.version, Some(i as u32 + 1));
            assert_eq!(a.file_path, format!("{dir}p2s-sensor-rehberi.html"));
            assert_eq!(a.files.get("th-kart.jpg").map(String::as_str), Some(format!("{dir}th-kart.jpg").as_str()));
            assert_eq!(a.title, "P2S Sensör Onarım Rehberi");
            assert_eq!(a.icon.as_deref(), if i == 0 { Some("wrench") } else { None });
        }
        // Survives the parse cache's round trip.
        let back: Vec<Activity> = serde_json::from_str(&serde_json::to_string(&o.activity).unwrap()).unwrap();
        assert_eq!(back, o.activity);
    }

    #[test]
    fn failed_artifact_publish_is_a_plain_step() {
        let mut o = Out::default();
        feed(&mut o, &format!(r#"{{"type":"assistant",{TS},"message":{{"id":"m1","model":"claude-x","content":[{{"type":"tool_use","id":"a1","name":"Artifact","input":{{"file_path":"/x/a.html"}}}}]}}}}"#));
        feed(&mut o, &format!(r#"{{"type":"user",{TS},"message":{{"content":[{{"type":"tool_result","tool_use_id":"a1","is_error":true,"content":"Published nothing"}}]}}}}"#));
        assert!(o.activity.iter().all(|a| a.artifact.is_none()));
    }

    #[test]
    fn messages_keep_their_full_text() {
        let mut o = Out::default();
        let reply = "| a | b |\n|---|---|\n| **1** | 2 |\n\nDone.";
        let prompt = format!("fix it\n\n{}", "word ".repeat(200));
        let rec = |ty: &str, content: &str| format!(r#"{{"type":"{ty}",{TS},"message":{{"id":"m1","model":"claude-x","content":{content}}}}}"#);
        feed(&mut o, &rec("user", &serde_json::to_string(&prompt).unwrap()));
        feed(&mut o, &tool_use("t1", "ls"));
        feed(&mut o, &format!(r#"{{"type":"user",{TS},"message":{{"content":[{{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"line one\nline two"}}]}}}}"#));
        feed(&mut o, &rec("assistant", &serde_json::to_string(&json!([{"type": "text", "text": reply}])).unwrap()));
        feed(&mut o, &rec("assistant", r#"[{"type":"text","text":"short"}]"#));
        let a = &o.activity;
        assert_eq!(a.len(), 5);
        assert_eq!((a[0].kind, a[0].full.as_deref()), (ActivityKind::Prompt, Some(prompt.trim())));
        assert!(!a[0].text.contains('\n') && a[0].text.ends_with('…'));
        assert_eq!((a[1].kind, a[1].full.as_deref(), a[1].text.as_str()), (ActivityKind::Tool, None, "Bash · ls"));
        assert_eq!((a[2].kind, a[2].full.as_deref()), (ActivityKind::Error, Some("line one\nline two")));
        assert_eq!(a[3].full.as_deref(), Some(reply));
        assert_eq!(a[3].text, "| a | b | |---|---| | **1** | 2 | Done.");
        // Nothing lost in the one-line form: no separate copy.
        assert_eq!((a[4].text.as_str(), a[4].full.as_deref(), a[4].shortened), ("short", None, false));
        assert!(a.iter().all(|x| !x.shortened));
    }

    #[test]
    fn full_text_is_bounded_and_kept_only_for_recent_entries() {
        let mut o = Out::default();
        let big = "x\n".repeat(MAX_FULL);
        let msg = |t: &str| format!(r#"{{"type":"assistant",{TS},"message":{{"id":"m","model":"claude-x","content":{}}}}}"#, serde_json::to_string(&json!([{"type": "text", "text": t}])).unwrap());
        feed(&mut o, &msg(&big));
        let a = &o.activity[0];
        assert!(a.shortened, "cut at the limit");
        assert_eq!(a.full.as_deref().unwrap().chars().count(), MAX_FULL + 1, "the limit plus the ellipsis");
        for i in 0..FULL_RECENT {
            feed(&mut o, &msg(&format!("reply {i}\nsecond line")));
            // Steps don't use up the window.
            feed(&mut o, &tool_use(&format!("t{i}"), "ls"));
        }
        let a: Vec<&Activity> = o.activity.iter().filter(|a| a.kind == ActivityKind::Text).collect();
        assert_eq!(a.len(), FULL_RECENT + 1);
        // The oldest fell out of the recent window: one line only, marked.
        assert!(a[0].full.is_none() && a[0].shortened && !a[0].text.is_empty());
        assert!(a[1..].iter().all(|x| x.full.is_some() && !x.shortened));
        // Serialized: the extra fields only when they say something.
        let v = serde_json::to_value(a[0]).unwrap();
        assert_eq!((v.get("full"), v["shortened"].as_bool()), (None, Some(true)));
        let v = serde_json::to_value(Activity::line("t".into(), ActivityKind::Tool, "Bash · ls")).unwrap();
        assert_eq!(v, json!({"ts": "t", "kind": "tool", "text": "Bash · ls"}));
        let back: Activity = serde_json::from_value(v).unwrap();
        assert!(back.full.is_none() && !back.shortened);
    }

    /// Claude Code 2.1.325 records a message typed mid-turn as a
    /// `queued_command` attachment (no `user` line), as seen in a real run.
    #[test]
    fn mid_turn_message_is_a_prompt() {
        let mut o = Out::default();
        feed(&mut o, &tool_use("t1", "sleep 3"));
        feed(&mut o, &format!(r#"{{"parentUuid":"p","isSidechain":false,"attachment":{{"type":"queued_command","prompt":"Also: say banana.","source_uuid":"d2ce","delivery_id":"805c","commandMode":"prompt","timestamp":"2026-11-15T07:52:59.943Z"}},"type":"attachment","uuid":"9f75",{TS}}}"#));
        feed(&mut o, &format!(r#"{{"type":"attachment",{TS},"attachment":{{"type":"queued_command","prompt":"/compact","commandMode":"slash"}}}}"#));
        let p: Vec<_> = o.activity.iter().filter(|a| a.kind == ActivityKind::Prompt).map(|a| a.text.as_str()).collect();
        assert_eq!(p, ["Also: say banana."]);
    }

    #[test]
    fn current_tool_follows_call_order_with_parallel_calls() {
        let mut o = Out::default();
        // Many parallel calls make HashMap iteration order visibly arbitrary.
        let n = 12;
        for i in 0..n {
            feed(&mut o, &tool_use(&format!("t{i}"), &format!("cmd{i}")));
        }
        assert_eq!(o.current.as_deref(), Some(&*format!("Bash · cmd{}", n - 1)));
        // The newest finishing leaves the next-newest still running as current.
        feed(&mut o, &tool_result(&format!("t{}", n - 1)));
        assert_eq!(o.current.as_deref(), Some(&*format!("Bash · cmd{}", n - 2)));
        // An older one finishing doesn't change which call is newest.
        feed(&mut o, &tool_result("t0"));
        assert_eq!(o.current.as_deref(), Some(&*format!("Bash · cmd{}", n - 2)));
        for i in 1..n - 1 {
            feed(&mut o, &tool_result(&format!("t{i}")));
        }
        assert_eq!(o.current.as_deref(), Some("thinking…"));
        assert!(o.st.open_tools.is_empty());
    }

    #[test]
    fn usage_counted_once_per_message_across_content_blocks() {
        let mut o = Out::default();
        let rec = |block: &str| {
            format!(
                r#"{{"type":"assistant",{TS},"requestId":"r1","message":{{"id":"msg_1","model":"claude-x","content":[{block}],"usage":{{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":7}}}}}}"#
            )
        };
        feed(&mut o, &rec(r#"{"type":"thinking","thinking":""}"#));
        feed(&mut o, &rec(r#"{"type":"text","text":"hi"}"#));
        feed(&mut o, &rec(r#"{"type":"tool_use","id":"t","name":"Read","input":{"file_path":"/x"}}"#));
        assert_eq!((o.tokens.input, o.tokens.cached, o.tokens.output, o.tokens.context), (15, 100, 7, 115));
        assert_eq!(o.tokens.total, 122, "context + output of the latest response");
        assert_eq!(o.model, "claude-x");
    }

    #[test]
    fn turn_output_restarts_at_each_prompt() {
        let mut o = Out::default();
        let user = |t: &str| format!(r#"{{"type":"user",{TS},"message":{{"role":"user","content":"{t}"}}}}"#);
        let asst = |id: &str, out: u64| format!(r#"{{"type":"assistant",{TS},"message":{{"id":"{id}","model":"claude-x","content":[{{"type":"text","text":"x"}}],"usage":{{"input_tokens":1,"output_tokens":{out}}}}}}}"#);
        feed(&mut o, &user("one"));
        feed(&mut o, &asst("a", 30));
        feed(&mut o, &asst("a", 30)); // same message again
        feed(&mut o, &asst("b", 12));
        assert_eq!(o.st.turn_out, 42);
        feed(&mut o, &user("two"));
        assert_eq!(o.st.turn_out, 0);
        feed(&mut o, &asst("c", 5));
        assert_eq!((o.st.turn_out, o.tokens.output), (5, 47));
    }

    #[test]
    fn models_counted_per_message_and_subagents_flagged() {
        let mut o = Out::default();
        let rec = |id: &str, model: &str, inp: u64| {
            format!(r#"{{"type":"assistant",{TS},"message":{{"id":"{id}","model":"{model}","content":[{{"type":"text","text":"x"}}],"usage":{{"input_tokens":{inp},"cache_creation_input_tokens":1,"cache_read_input_tokens":10,"output_tokens":2}}}}}}"#)
        };
        feed(&mut o, &rec("a", "claude-opus-5-5", 5));
        feed(&mut o, &rec("a", "claude-opus-5-5", 5)); // same message, another block
        feed(&mut o, &rec("b", "claude-haiku-5-5", 100));
        feed(&mut o, &rec("c", "<synthetic>", 0));
        let own = o.st.models.clone();
        assert_eq!(own.len(), 2);
        assert_eq!((own[0].model.as_str(), own[0].input, own[0].cached, own[0].output, own[0].messages), ("claude-opus-5-5", 6, 10, 2, 1));
        let agent = Agent {
            id: "x".into(),
            kind: "Explore".into(),
            description: String::new(),
            finished: true,
            current: None,
            tokens: Tokens::default(),
            activity: Default::default(),
            model: "claude-haiku-5-5".into(),
            models: vec![ModelUse { model: "claude-haiku-5-5".into(), input: 1000, cached: 0, output: 0, messages: 3, via_agent: false }],
        };
        let all = session_models(own, &[agent]);
        let rows: Vec<_> = all.iter().map(|m| (m.model.as_str(), m.via_agent, m.messages)).collect();
        assert_eq!(rows, vec![("claude-haiku-5-5", true, 3), ("claude-haiku-5-5", false, 1), ("claude-opus-5-5", false, 1)]);
    }

    const REPLY: &str = r#"{"type":"assistant","timestamp":"2026-11-15T13:02:00.250Z","message":{"id":"m1","content":[{"type":"text","text":"done"}]}}"#;
    const TURN_END: &str = r#"{"type":"system","subtype":"turn_duration","timestamp":"2026-11-15T13:02:05Z"}"#;
    const NOISE: &str = concat!(
        r#"{"type":"queue-operation","timestamp":"2026-11-17T18:19:00Z"}"#,
        "\n",
        r#"{"type":"api-request","timestamp":"2026-11-17T18:19:01Z"}"#,
        "\n",
        r#"{"type":"file-history-snapshot","timestamp":"2026-11-17T18:19:02Z"}"#,
        "\n",
        r#"{"type":"system","subtype":"other","timestamp":"2026-11-17T18:19:03Z"}"#,
        "\n",
        r#"{"type":"ai-title","aiTitle":"T"}"#,
        "\n",
    );

    fn last_event(jsonl: &str) -> Option<u64> {
        let mut p = Parsed::default();
        for l in jsonl.lines() {
            p.line(l);
        }
        p.view().last_event
    }

    #[test]
    fn last_event_ignores_metadata_after_the_last_real_event() {
        let want = parse_rfc3339_ms("2026-11-15T13:02:00.250Z");
        assert_eq!(want.map(|m| m % 1000), Some(250));
        assert_eq!(last_event(&format!("{REPLY}\n{NOISE}")), want);
        let end = parse_rfc3339_ms("2026-11-15T13:02:05Z");
        assert_eq!(last_event(&format!("{REPLY}\n{TURN_END}\n{NOISE}")), end);
        assert_eq!(last_event(NOISE), None);
    }

    #[test]
    fn last_event_from_the_file_tail_only() {
        let dir = crate::loader::tests::tmpdir("claude-tail-event");
        let p = dir.join("s.jsonl");
        let pad = format!("{{\"type\":\"user\",\"timestamp\":\"2026-11-01T00:00:00Z\",\"pad\":\"{}\"}}\n", "x".repeat(200_000));
        std::fs::write(&p, format!("{pad}{REPLY}\n{NOISE}")).unwrap();
        assert_eq!(crate::loader::tail_event(&p, Kind::Claude), parse_rfc3339_ms("2026-11-15T13:02:00.250Z"));
        std::fs::write(&p, format!("{REPLY}\n{NOISE}{pad}")).unwrap();
        // The only real event is outside the tail window.
        assert_eq!(crate::loader::tail_event(&p, Kind::Claude), None);
    }

    #[test]
    fn interrupt_ends_turn_and_is_not_a_prompt() {
        let mut o = Out::default();
        feed(&mut o, &format!(r#"{{"type":"user",{TS},"message":{{"content":"fix it"}}}}"#));
        feed(&mut o, &tool_use("t1", "sleep 100"));
        feed(&mut o, &format!(r#"{{"type":"user",{TS},"message":{{"content":[{{"type":"text","text":"[Request interrupted by user for tool use]"}}]}}}}"#));
        assert_eq!(o.current, None);
        assert!(o.st.open_tools.is_empty());
        let kinds: Vec<_> = o.activity.iter().map(|a| a.kind).collect();
        assert_eq!(kinds, vec![ActivityKind::Prompt, ActivityKind::Tool, ActivityKind::Error]);
        // A later result for some other call must not resurrect the abandoned one.
        feed(&mut o, &tool_result("other"));
        assert_eq!(o.current.as_deref(), Some("thinking…"));
    }

    #[test]
    fn meta_and_tagged_user_messages_are_not_prompts() {
        let mut o = Out::default();
        feed(
            &mut o,
            &format!(
                r#"{{"type":"user",{TS},"isMeta":true,"message":{{"content":"Caveat: ..."}}}}
{{"type":"user",{TS},"message":{{"content":"<command-name>/clear</command-name>"}}}}
{{"type":"user",{TS},"cwd":"/p","message":{{"content":"real prompt"}}}}
{{"type":"ai-title","aiTitle":"T"}}
{{"type":"last-prompt","lastPrompt":"real prompt"}}
{{"type":"system","subtype":"turn_duration"}}"#
            ),
        );
        assert_eq!(o.activity.len(), 1);
        assert_eq!(o.activity[0].text, "real prompt");
        assert_eq!((o.title.as_str(), o.cwd.as_str(), o.last_prompt.as_deref()), ("T", "/p", Some("real prompt")));
        assert_eq!(o.current, None);
    }

    #[test]
    fn error_result_with_block_content_shows_its_text() {
        let mut o = Out::default();
        feed(&mut o, &tool_use("t1", "x"));
        feed(&mut o, &format!(r#"{{"type":"user",{TS},"message":{{"content":[{{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":[{{"type":"text","text":"boom"}}]}}]}}}}"#));
        assert_eq!(o.activity.last().map(|a| (a.kind, a.text.as_str())), Some((ActivityKind::Error, "boom")));
    }

    /// Bash calls are kept for matching shells: description, background flag,
    /// the output file named by a background call's result, done for a foreground one.
    #[test]
    fn bash_calls_are_recorded() {
        let mut o = Out::default();
        let bash = |id: &str, input: &str| format!(r#"{{"type":"assistant","timestamp":"2026-11-15T08:57:32.274Z","message":{{"id":"m-{id}","model":"claude-x","content":[{{"type":"tool_use","id":"{id}","name":"Bash","input":{input}}}]}}}}"#);
        let result = |id: &str, text: &str| format!(r#"{{"type":"user",{TS},"message":{{"content":[{{"type":"tool_result","tool_use_id":"{id}","content":{}}}]}}}}"#, serde_json::to_string(text).unwrap());
        feed(&mut o, &bash("b1", r#"{"command":"until [ -s x ]; do sleep 5; done","description":"Wait for x","run_in_background":true}"#));
        feed(&mut o, &result("b1", "Command running in background with ID: b9bainvwm. Output is being written to: /private/tmp/claude-501/-p/s1/tasks/b9bainvwm.output. You will be notified when it completes."));
        feed(&mut o, &bash("f1", r#"{"command":"ls","description":"List"}"#));
        feed(&mut o, &result("f1", "a\nb"));
        feed(&mut o, &bash("f2", r#"{"command":"cargo build"}"#));
        feed(&mut o, &tool_use("r1", "make"));
        let b = &o.st.bash;
        assert_eq!(b.len(), 4);
        assert_eq!((b[0].command.as_str(), b[0].description.as_deref(), b[0].background, b[0].done), ("until [ -s x ]; do sleep 5; done", Some("Wait for x"), true, false));
        assert_eq!(b[0].output.as_deref(), Some("/private/tmp/claude-501/-p/s1/tasks/b9bainvwm.output"));
        assert_eq!(b[0].at, 1_794_733_052_000);
        assert!(b[1].done && !b[1].background && b[1].output.is_none());
        assert!(!b[2].done, "still running");
    }

    #[test]
    fn reused_pid_is_detected_from_start_time() {
        let me = std::process::id();
        let Some(start) = process_start_ms(me) else { return };
        assert!(!pid_reused(me, Some(start + 500)), "registry written just after start");
        assert!(!pid_reused(me, None));
        assert!(pid_reused(me, Some(start.saturating_sub(3_600_000))), "process is newer than the registry entry");
    }
}
