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
            tokens: self.tokens.clone(),
            activity: self.activity.clone(),
            models,
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
    /// In first-seen order.
    agents: Vec<AgentEntry>,
}

pub struct ClaudeSource {
    root: PathBuf,
    entries: HashMap<String, Entry>,
    recent_window: Duration,
    /// For [`ClaudeSource::refresh`]: parses everything inline.
    own_pool: Option<Pool>,
}

impl ClaudeSource {
    pub fn new(recent_window: Duration) -> Self {
        let root = dirs::home_dir().unwrap_or_default().join(".claude");
        Self { root, entries: HashMap::new(), recent_window, own_pool: None }
    }

    #[cfg(test)]
    pub(crate) fn with_root(root: PathBuf, recent_window: Duration) -> Self {
        Self { root, entries: HashMap::new(), recent_window, own_pool: None }
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
        let mut live = self.read_registry();
        let now = SystemTime::now();

        // Discover transcripts: every live session + anything touched recently.
        let mut wanted: HashMap<String, (PathBuf, fs::Metadata)> = HashMap::new();
        if let Ok(dirs) = fs::read_dir(self.root.join("projects")) {
            for d in dirs.flatten() {
                let Ok(files) = fs::read_dir(d.path()) else { continue };
                for f in files.flatten() {
                    let p = f.path();
                    if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                        continue;
                    }
                    let id = p.file_stem().unwrap().to_string_lossy().to_string();
                    let mtime = f.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
                    let recent = now.duration_since(mtime).map(|d| d < self.recent_window).unwrap_or(true);
                    if (recent || live.contains_key(&id))
                        && let Ok(m) = fs::metadata(&p)
                    {
                        wanted.insert(id, (p, m));
                    }
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
                agents: Vec::new(),
            });
            e.mtime = mtime;
            e.live = live.remove(id);
            if let Some(r) = &e.live {
                if !r.name.is_empty() {
                    e.reg_title = r.name.clone();
                }
                if !r.cwd.is_empty() {
                    e.reg_cwd = r.cwd.clone();
                }
            }
            let is_live = e.live.is_some();
            pool.sync(&e.slot, meta, loader::prio(is_live, true, mtime), budget);
            scan_agents(e, &path.with_extension("").join("subagents"), pool, budget);
        }

        self.entries.retain(|id, _| wanted.contains_key(id));
    }

    /// Every wanted transcript (and subagent transcript) fully parsed at least once.
    pub(crate) fn complete(&self) -> bool {
        self.entries.values().all(|e| e.slot.view().complete && e.agents.iter().all(|a| !a.has_file || a.slot.view().complete))
    }

    /// Sessions as currently known (cheap facts for what isn't parsed yet).
    pub(crate) fn sessions(&self) -> Vec<Session> {
        self.entries.iter().map(|(id, e)| session(id, e)).collect()
    }

    fn read_registry(&self) -> HashMap<String, Live> {
        let mut out = HashMap::new();
        let Ok(entries) = fs::read_dir(self.root.join("sessions")) else { return out };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Some(v) = fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) else { continue };
            let (Some(pid), Some(sid)) = (v["pid"].as_u64().and_then(|p| u32::try_from(p).ok()), v["sessionId"].as_str()) else { continue };
            if !pid_alive(pid) || pid_reused(pid, v["startedAt"].as_u64()) {
                continue;
            }
            out.insert(
                sid.to_string(),
                Live {
                    pid,
                    cwd: v["cwd"].as_str().unwrap_or("").to_string(),
                    name: v["name"].as_str().unwrap_or("").to_string(),
                    busy: v["status"].as_str() == Some("busy"),
                },
            );
        }
        out
    }
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
        pid,
        status,
        current,
        last_prompt: v.last_prompt.clone(),
        tokens: v.tokens.clone(),
        activity: v.activity.clone(),
        agents,
        updated: e.mtime,
        managed: None,
        chat: None,
        models,
        loaded: v.loaded,
    }
}

fn scan_agents(e: &mut Entry, dir: &Path, pool: &Pool, budget: &mut u64) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut metas: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|d| {
            let p = d.path();
            let name = p.file_name()?.to_string_lossy().to_string();
            let id = name.strip_prefix("agent-")?.strip_suffix(".meta.json")?.to_string();
            Some((id, p))
        })
        .collect();
    metas.sort();
    let live = e.live.is_some();
    for (aid, meta_path) in metas {
        let meta: Value = fs::read_to_string(&meta_path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
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
        a.kind = meta["agentType"].as_str().unwrap_or("agent").to_string();
        a.description = meta["description"].as_str().unwrap_or("").to_string();
        a.finished = meta["finished"].as_bool().unwrap_or(false);
        a.meta_model = meta["model"].as_str().map(str::to_string);
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

struct Live {
    pid: u32,
    cwd: String,
    name: String,
    busy: bool,
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
    if let Some(c) = v["cwd"].as_str()
        && cwd.is_empty() {
            *cwd = c.to_string();
        }
    match v["type"].as_str() {
        Some("ai-title") => {
            if let Some(t) = v["aiTitle"].as_str() {
                *title = t.to_string();
            }
        }
        Some("last-prompt") => {
            if let Some(t) = v["lastPrompt"].as_str() {
                *last_prompt = Some(t.to_string());
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
                            }
                            if item["is_error"].as_bool() == Some(true) {
                                let txt = result_text(&item["content"]).map(|s| one_line(&s, 200)).unwrap_or_else(|| "tool error".into());
                                push_activity(activity, Activity { ts: ts.clone(), kind: ActivityKind::Error, text: txt });
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
                push_activity(activity, Activity { ts: ts.clone(), kind: ActivityKind::Error, text: one_line(txt, 200) });
                *current = None;
            }
            // Usage is repeated on every content block of a message; count it once.
            let mid = msg["id"].as_str().or(v["requestId"].as_str()).unwrap_or("").to_string();
            if !mid.is_empty() && st.seen_msgs.insert(mid) {
                let u = &msg["usage"];
                let g = |k: &str| u[k].as_u64().unwrap_or(0);
                tokens.input += g("input_tokens") + g("cache_creation_input_tokens");
                tokens.cached += g("cache_read_input_tokens");
                tokens.output += g("output_tokens");
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
                            let kind = if name == "Agent" || name == "Task" { ActivityKind::Agent } else { ActivityKind::Tool };
                            push_activity(activity, Activity { ts: ts.clone(), kind, text: sum.clone() });
                            *current = Some(sum);
                        }
                        Some("text") if v["isApiErrorMessage"].as_bool() != Some(true) => {
                            let s = item["text"].as_str().unwrap_or("");
                            if !s.trim().is_empty() {
                                push_activity(activity, Activity { ts: ts.clone(), kind: ActivityKind::Text, text: one_line(s, 400) });
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

/// A user text block: either a real prompt or Claude Code's interrupt marker.
fn user_text(s: &str, ts: String, st: &mut ParseState, current: &mut Option<String>, activity: &mut Vec<Activity>) {
    if s.starts_with("[Request interrupted by user") {
        // The turn is over; calls that never got a result are abandoned.
        st.open_tools.clear();
        *current = None;
        push_activity(activity, Activity { ts, kind: ActivityKind::Error, text: "interrupted by user".into() });
        return;
    }
    push_activity(activity, Activity { ts, kind: ActivityKind::Prompt, text: one_line(s, 400) });
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
    use super::*;

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
        assert_eq!(o.model, "claude-x");
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
            activity: Vec::new(),
            model: "claude-haiku-5-5".into(),
            models: vec![ModelUse { model: "claude-haiku-5-5".into(), input: 1000, cached: 0, output: 0, messages: 3, via_agent: false }],
        };
        let all = session_models(own, &[agent]);
        let rows: Vec<_> = all.iter().map(|m| (m.model.as_str(), m.via_agent, m.messages)).collect();
        assert_eq!(rows, vec![("claude-haiku-5-5", true, 3), ("claude-haiku-5-5", false, 1), ("claude-opus-5-5", false, 1)]);
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

    #[test]
    fn reused_pid_is_detected_from_start_time() {
        let me = std::process::id();
        let Some(start) = process_start_ms(me) else { return };
        assert!(!pid_reused(me, Some(start + 500)), "registry written just after start");
        assert!(!pid_reused(me, None));
        assert!(pid_reused(me, Some(start.saturating_sub(3_600_000))), "process is newer than the registry entry");
    }
}
