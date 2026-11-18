//! Tauri shell around `coool_core::hub::Hub`.
//!
//! One `Hub` behind a mutex, refreshed by a background thread as soon as a
//! transcript or registry file changes (file-system events, see
//! `coool_core::watch`), when kicked, and at least once a second. It sends the
//! UI one full `sessions` payload, then `sessions-delta`s carrying only the
//! sessions that changed. A ~16ms pump (asleep while nothing streams) sends raw PTY bytes to xterm.js
//! (`pty-output`, `pty-exit`) and chat events (`chat-event`); it reads through
//! handles cloned out of the Hub, so a slow refresh never delays streamed text.
//! See docs/APP_SPEC.md ("Backend contract") and docs/CHAT_SPEC.md.

mod artifact;
mod browser;
mod device;
mod env;
mod motion;
mod selftest;
mod trace;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use coool_core::chat::{ChatEvent, ChatEventKind, ChatHandle, ChatOptions, ChatState};
use coool_core::hub::Hub;
use coool_core::insights::{self, Insight, Insights};
use coool_core::model::{Provider, Session};
use coool_core::wire::Sent;
use coool_core::pty::RawLog;
use coool_core::usage::{PlanUsage, ResetOutcome, UsageMonitor};
use coool_core::watch::{Watch, Waker};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

/// Byte-stream handles for one managed PTY, cloned out of the Hub at spawn so
/// the output pump never has to take the Hub lock (a disk refresh can hold it).
struct Stream {
    raw: Arc<Mutex<RawLog>>,
    exited: Arc<Mutex<bool>>,
    offset: u64,
    exit_sent: bool,
}

/// A chat's event handle and how far the pump has sent it.
struct ChatStream {
    handle: ChatHandle,
    seq: u64,
    exit_sent: bool,
}

struct Core {
    hub: Mutex<Hub>,
    /// What the UI was last sent (see [`Published`]).
    published: Mutex<Published>,
    /// Wakes the output pump when a PTY or chat is registered (it naps while there is none).
    pump_waker: Arc<Waker>,
    /// Taken by `publish` from building a payload through emitting it.
    emit_order: Mutex<()>,
    streams: Mutex<HashMap<usize, Stream>>,
    chats: Mutex<HashMap<usize, ChatStream>>,
    insights: Mutex<Insights>,
    /// CHAT_SPEC "Plan usage".
    usage: UsageMonitor,
    /// Set once the user confirmed quitting (or nothing was running).
    allow_exit: AtomicBool,
    /// Wakes the refresher early: a chat or PTY started or ended (`kick`), or a
    /// watched file changed.
    waker: Arc<Waker>,
    selftest: Option<selftest::SelfTest>,
    /// Settings sheet: "Show runs started by other tools" (persisted).
    show_automation: AtomicBool,
    /// `COOOL_TRACE_SESSIONS`: latency trace (off unless set).
    trace: Option<trace::Trace>,
    /// Artifact previews (see [`artifact`]).
    previews: artifact::Previews,
    /// The in-app browser's child webviews (see [`browser`]).
    browsers: browser::Browsers,
}

/// The last payload the UI got, per session, so the next refresh sends only
/// what changed. `seq` numbers the payloads; a delta names the `seq` it
/// applies to (`base`), so a UI that missed one asks `list_sessions` again.
struct Published {
    seq: u64,
    /// Session keys (`provider:id`) in display order.
    order: Vec<String>,
    /// Session key -> the session as last sent.
    sessions: HashMap<String, Sent>,
    /// [`Rest`] as a JSON object.
    rest: String,
}

/// Everything in the sessions payload besides the sessions (the spec'd
/// `{ sessions, pending }` plus additive fields).
#[derive(Serialize, Default)]
struct Rest {
    pending: Vec<usize>,
    /// Additive to the spec'd `{ sessions, pending }`: what each PTY coool
    /// launched is, so a pending tab knows its provider and folder.
    ptys: Vec<PtyInfo>,
    /// Additive: true while the sessions found at startup are still being
    /// parsed in the background (`Session.loaded` says which ones are done).
    loading: bool,
    /// CHAT_SPEC "Tauri contract additions".
    chats: Vec<ChatRow>,
    /// CHAT_SPEC "Plan usage".
    usage: UsageOut,
    /// Additive: the "Show runs started by other tools" setting. Sessions keep
    /// coming with their `origin`; the UI hides `automation` ones while this is off.
    show_automation: bool,
}

/// `{"k":v,...}` from already-serialized values, followed by the fields of `rest` (a JSON object).
fn object(head: &[(&str, &str)], rest: &str) -> String {
    let mut out = String::with_capacity(rest.len() + head.iter().map(|(k, v)| k.len() + v.len() + 4).sum::<usize>() + 2);
    out.push('{');
    for (i, (k, v)) in head.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('"');
        out.push_str(k);
        out.push_str("\":");
        out.push_str(v);
    }
    let inner = rest.trim().strip_prefix('{').and_then(|r| r.strip_suffix('}')).unwrap_or("").trim();
    if !inner.is_empty() {
        if !head.is_empty() {
            out.push(',');
        }
        out.push_str(inner);
    }
    out.push('}');
    out
}

/// A payload for the UI.
struct Update {
    event: &'static str,
    payload: String,
    /// Keys of the sessions it carries.
    changed: Vec<String>,
}

impl Published {
    fn new() -> Self {
        // Until the first refresh lands, a `list_sessions` caller sees "loading".
        let rest = serde_json::to_string(&Rest { loading: true, ..Rest::default() }).unwrap_or_default();
        Self { seq: 0, order: Vec::new(), sessions: HashMap::new(), rest }
    }

    /// Takes the latest sessions (key, session, insight; in display order) and
    /// the rest of the payload. Returns what to emit, or None when nothing
    /// changed (the very first call always emits: the UI waits for it).
    /// A changed session the UI holds goes out as a `patch` (see `coool_core::wire`),
    /// a new one (or one whose patch would be about as big) whole in `upsert`.
    fn update(&mut self, sessions: Vec<(String, Session, Option<Insight>)>, rest: String, trace: bool) -> Option<Update> {
        let first = self.seq == 0;
        let mut next = HashMap::with_capacity(sessions.len());
        let mut order = Vec::with_capacity(sessions.len());
        let (mut upsert, mut patch) = (String::from("{"), String::from("{"));
        let mut changed = Vec::new();
        let add = |map: &mut String, key: &str, json: &str| {
            if map.len() > 1 {
                map.push(',');
            }
            map.push_str(&serde_json::to_string(key).unwrap_or_default());
            map.push(':');
            map.push_str(json);
        };
        for (key, s, insight) in sessions {
            order.push(key.clone());
            // Comparing the sessions themselves is exact, and much cheaper than serializing them.
            let prev = match self.sessions.remove(&key) {
                Some(p) if p.same(&s, &insight) => {
                    next.insert(key, p);
                    continue;
                }
                p => p,
            };
            let sent = Sent::new(s, insight, prev.as_ref());
            if !first {
                match prev.as_ref().and_then(|p| sent.patch(p)) {
                    Some(p) => add(&mut patch, &key, &p),
                    None => add(&mut upsert, &key, &sent.to_json()),
                }
            }
            changed.push(key.clone());
            next.insert(key, sent);
        }
        upsert.push('}');
        patch.push('}');
        // (Sessions no longer listed are dropped here; unchanged ones were moved into `next`.)
        self.sessions = next;
        if !first && changed.is_empty() && order == self.order && rest == self.rest {
            return None;
        }
        let base = self.seq;
        self.seq += 1;
        self.order = order;
        self.rest = rest;
        let trace = trace.then(|| format!("{{\"seq\":{},\"at\":{}}}", self.seq, trace::now_ms()));
        if first {
            return Some(Update { event: "sessions", payload: self.full(trace.as_deref()), changed });
        }
        let order = serde_json::to_string(&self.order).unwrap_or_default();
        let (seq, base) = (self.seq.to_string(), base.to_string());
        let mut head = vec![("seq", seq.as_str()), ("base", base.as_str()), ("order", order.as_str()), ("upsert", upsert.as_str()), ("patch", patch.as_str())];
        if let Some(t) = &trace {
            head.push(("trace", t));
        }
        Some(Update { event: "sessions-delta", payload: object(&head, &self.rest), changed })
    }

    /// The whole state: `{ seq, order, sessions, ...rest }` (the `sessions` event and `list_sessions`).
    fn full(&self, trace: Option<&str>) -> String {
        let mut list = String::from("[");
        for (i, k) in self.order.iter().enumerate() {
            if i > 0 {
                list.push(',');
            }
            list.push_str(&self.sessions.get(k).map_or_else(|| "null".to_string(), Sent::to_json));
        }
        list.push(']');
        let order = serde_json::to_string(&self.order).unwrap_or_default();
        let seq = self.seq.to_string();
        let mut head = vec![("seq", seq.as_str()), ("order", order.as_str()), ("sessions", list.as_str())];
        if let Some(t) = trace {
            head.push(("trace", t));
        }
        object(&head, &self.rest)
    }
}

/// Plan usage per provider; `null` until something is known.
#[derive(Clone, Serialize, Default)]
struct UsageOut {
    claude: Option<PlanUsage>,
    codex: Option<PlanUsage>,
}

#[derive(Clone, Serialize, PartialEq)]
struct PtyInfo {
    id: usize,
    provider: Provider,
    cwd: String,
    /// The folder this is grouped under (see `coool_core::project`).
    project: String,
    running: bool,
    /// Epoch ms.
    started: u64,
}

#[derive(Clone, Serialize)]
struct ChatRow {
    id: usize,
    provider: Provider,
    cwd: String,
    /// The folder this is grouped under (see `coool_core::project`).
    project: String,
    session_id: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    state: ChatState,
    running: bool,
    pid: Option<u32>,
}

#[derive(Clone, Serialize)]
struct PtyOutput {
    id: usize,
    data: String,
    /// Absolute end offset of this chunk in the PTY's byte stream.
    offset: u64,
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: usize,
}

#[derive(Clone, Serialize)]
struct ChatBatch {
    id: usize,
    events: Vec<ChatEvent>,
}

#[derive(Serialize)]
struct Replay {
    data: String,
    offset: u64,
}

#[derive(Serialize)]
struct ChatReplay {
    events: Vec<ChatEvent>,
    seq: u64,
}

type Res<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn none_if_empty(s: String) -> Option<String> {
    (!s.is_empty()).then_some(s)
}

impl Core {
    /// One refresh: every session (keyed, in display order) and the rest of the payload.
    fn collect(&self) -> (Vec<(String, Session, Option<Insight>)>, Rest) {
        let (mut sessions, pending, ptys, loading, chats) = {
            let mut hub = self.hub.lock().unwrap();
            let s = hub.refresh(false);
            let p = hub.pending(&s);
            let ptys = hub
                .managed
                .iter()
                .enumerate()
                .filter_map(|(id, m)| {
                    let m = m.as_ref()?;
                    let started = m.started.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                    Some(PtyInfo { id, provider: m.provider, project: coool_core::project::project_root(&m.cwd), cwd: m.cwd.clone(), running: m.is_running(), started })
                })
                .collect();
            let chats: Vec<ChatRow> = hub
                .chats()
                .into_iter()
                .map(|c| ChatRow {
                    pid: hub.chat(c.id).and_then(|x| x.pid),
                    id: c.id,
                    provider: c.provider,
                    project: coool_core::project::project_root(&c.cwd),
                    cwd: c.cwd,
                    session_id: c.session_id,
                    model: none_if_empty(c.model),
                    permission_mode: none_if_empty(c.permission_mode),
                    state: c.state,
                    running: c.running,
                })
                .collect();
            // Chats the Hub no longer holds: stop pumping them once their exit went out.
            self.chats.lock().unwrap().retain(|id, c| !c.exit_sent || hub.chat(*id).is_some());
            (s, p, ptys, hub.loading(), chats)
        };
        if let Some(t) = &self.selftest {
            sessions.retain(|s| t.owns(&s.cwd));
        }
        // Artifact previews only serve what a timeline the UI holds published.
        self.previews.set_timelines(sessions.iter().map(|s| s.activity.clone()).collect());
        let sessions = {
            let mut ins = self.insights.lock().unwrap();
            ins.tick(&sessions);
            let mut seen: HashMap<String, usize> = HashMap::new();
            sessions
                .into_iter()
                .map(|s| {
                    let insight = if ins.enabled() { ins.get(s.provider, &s.id).cloned() } else { None };
                    // Keys only identify rows in deltas; a repeated id still gets its own row.
                    let mut key = format!("{}:{}", s.provider.label(), s.id);
                    let n = seen.entry(key.clone()).or_default();
                    *n += 1;
                    if *n > 1 {
                        key = format!("{key}#{n}");
                    }
                    (key, s, insight)
                })
                .collect()
        };
        self.usage.tick();
        let usage = UsageOut { claude: self.usage.get(Provider::Claude), codex: self.usage.get(Provider::Codex) };
        let show_automation = self.show_automation.load(Ordering::Relaxed);
        (sessions, Rest { pending, ptys, loading, chats, usage, show_automation })
    }

    /// Refresh, and send the UI what changed: the full state the first time
    /// (`sessions`), afterwards only changed sessions (`sessions-delta`).
    /// Returns whether the initial load is still running.
    fn publish(&self, app: &AppHandle) -> bool {
        let t0 = Instant::now();
        let (sessions, rest) = self.collect();
        let collected = t0.elapsed();
        let loading = rest.loading;
        let t1 = Instant::now();
        let rest = serde_json::to_string(&rest).unwrap_or_else(|_| "{}".into());
        // Held through the emit, so payloads go out in `seq` order (`published`
        // itself is not: `list_sessions` must never wait for an emit).
        let _order = self.emit_order.lock().unwrap();
        let (u, seq) = {
            let mut p = self.published.lock().unwrap();
            let Some(u) = p.update(sessions, rest, self.trace.is_some()) else { return loading };
            (u, p.seq)
        };
        let built = t1.elapsed();
        let (t2, bytes) = (Instant::now(), u.payload.len());
        let _ = app.emit_str(u.event, u.payload);
        if let Some(t) = &self.trace {
            t.emit(seq, u.event, collected, built, t2.elapsed(), bytes, &u.changed, &self.published.lock().unwrap());
        }
        loading
    }

    /// Ask the refresher for a refresh now rather than at its next tick.
    fn kick(&self) {
        self.waker.kick();
    }

    fn register_pty(&self, hub: &Hub, id: usize) {
        if let Some(m) = hub.get(id) {
            self.streams.lock().unwrap().insert(id, Stream { raw: m.raw.clone(), exited: m.exited.clone(), offset: 0, exit_sent: false });
            self.pump_waker.kick();
        }
    }

    fn launch(&self, app: &AppHandle, provider: Provider, args: Vec<String>, cwd: &str, rows: u16, cols: u16) -> Res<usize> {
        let dir = expand_tilde(cwd);
        check_launch(provider, &dir)?;
        let id = {
            let mut hub = self.hub.lock().unwrap();
            let id = hub
                .spawn(provider, &args, &dir, rows.max(2), cols.max(10))
                .map_err(|e| format!("couldn't start {}: {e:#}", provider.label()))?;
            self.register_pty(&hub, id);
            id
        };
        // Surface the pending tab right away instead of waiting for the next tick.
        self.publish(app);
        Ok(id)
    }

    fn running(&self) -> usize {
        let hub = self.hub.lock().unwrap();
        hub.running_count() + hub.running_chats()
    }

    fn with_chat<T>(&self, id: usize, f: impl FnOnce(&mut coool_core::chat::Chat) -> anyhow::Result<T>) -> Res<T> {
        let mut hub = self.hub.lock().unwrap();
        let c = hub.chat_mut(id).ok_or("no such chat")?;
        f(c).map_err(|e| format!("{e:#}"))
    }
}

fn check_launch(provider: Provider, dir: &str) -> Res<()> {
    if !std::path::Path::new(dir).is_dir() {
        return Err(format!("not a folder: {dir}"));
    }
    if env::which(provider.binary()).is_none() {
        return Err(format!("`{}` was not found on your PATH. Install it, then restart coool.", provider.binary()));
    }
    Ok(())
}

// ---------- commands ----------

/// The full state as last sent (same shape as the `sessions` event).
#[tauri::command]
fn list_sessions(core: State<'_, Arc<Core>>) -> Box<RawValue> {
    let full = core.published.lock().unwrap().full(None);
    RawValue::from_string(full).unwrap_or_else(|_| RawValue::from_string("null".into()).expect("valid JSON"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnArgs {
    provider: Provider,
    cwd: String,
    args: Option<Vec<String>>,
    rows: u16,
    cols: u16,
}

#[tauri::command(async)]
fn spawn_session(app: AppHandle, core: State<'_, Arc<Core>>, req: SpawnArgs) -> Res<usize> {
    core.launch(&app, req.provider, req.args.unwrap_or_default(), &req.cwd, req.rows, req.cols)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeArgs {
    provider: Provider,
    session_id: String,
    cwd: String,
    rows: u16,
    cols: u16,
}

#[tauri::command(async)]
fn resume_session(app: AppHandle, core: State<'_, Arc<Core>>, req: ResumeArgs) -> Res<usize> {
    if req.session_id.is_empty() {
        return Err("can't resume: missing session id".into());
    }
    let args = match req.provider {
        Provider::Claude => vec!["--resume".into(), req.session_id],
        Provider::Codex => vec!["resume".into(), req.session_id],
    };
    core.launch(&app, req.provider, args, &req.cwd, req.rows, req.cols)
}

#[tauri::command(async)]
fn pty_write(core: State<'_, Arc<Core>>, id: usize, data: String) -> Res<()> {
    let mut hub = core.hub.lock().unwrap();
    let m = hub.get_mut(id).ok_or("no such terminal")?;
    m.write(data.as_bytes());
    Ok(())
}

#[tauri::command(async)]
fn pty_resize(core: State<'_, Arc<Core>>, id: usize, rows: u16, cols: u16) -> Res<()> {
    let mut hub = core.hub.lock().unwrap();
    if let Some(m) = hub.get_mut(id) {
        m.resize(rows, cols);
    }
    Ok(())
}

#[tauri::command]
fn pty_replay(core: State<'_, Arc<Core>>, id: usize) -> Res<Replay> {
    let streams = core.streams.lock().unwrap();
    let s = streams.get(&id).ok_or("no such terminal")?;
    let (bytes, offset) = s.raw.lock().unwrap().read_since(0);
    Ok(Replay { data: B64.encode(bytes), offset })
}

#[tauri::command(async)]
fn send_prompt(core: State<'_, Arc<Core>>, id: usize, text: String) -> Res<()> {
    let mut hub = core.hub.lock().unwrap();
    let m = hub.get_mut(id).ok_or("no such terminal")?;
    if !m.is_running() {
        return Err("this session has exited".into());
    }
    m.send_prompt(&text);
    Ok(())
}

#[tauri::command(async)]
fn stop_session(core: State<'_, Arc<Core>>, managed: Option<usize>, pid: Option<u32>) -> Res<()> {
    if let Some(i) = managed {
        let mut hub = core.hub.lock().unwrap();
        let m = hub.get_mut(i).ok_or("no such terminal")?;
        m.kill();
        return Ok(());
    }
    if let Some(pid) = pid {
        if pid <= 1 {
            return Err("refusing to signal that pid".into());
        }
        return terminate(pid);
    }
    Err("nothing to stop".into())
}

/// Stop a background shell of a live session (APP_SPEC "Background shells"):
/// only a pid a fresh scan still lists as a shell; SIGTERM to its process
/// group (or the pid), SIGKILL after 3 s.
#[tauri::command(async)]
fn stop_shell(core: State<'_, Arc<Core>>, pid: u32) -> Res<()> {
    core.hub.lock().unwrap().stop_shell(pid).map_err(|e| format!("{e:#}"))?;
    core.kick();
    Ok(())
}

/// The session ids on screen: only their shells get output tails.
#[tauri::command(async)]
fn shells_focus(core: State<'_, Arc<Core>>, ids: Vec<String>) {
    core.hub.lock().unwrap().set_shell_focus(ids);
    core.kick();
}

// ---- chats (CHAT_SPEC "Tauri contract additions") ----

#[tauri::command(async)]
fn start_chat(app: AppHandle, core: State<'_, Arc<Core>>, opts: ChatOptions) -> Res<usize> {
    let mut opts = opts;
    opts.cwd = expand_tilde(&opts.cwd);
    check_launch(opts.provider, &opts.cwd)?;
    let provider = opts.provider;
    let id = {
        let mut hub = core.hub.lock().unwrap();
        let id = hub.start_chat(opts).map_err(|e| format!("couldn't start {}: {e:#}", provider.label()))?;
        let handle = hub.chat(id).expect("just started").handle();
        core.chats.lock().unwrap().insert(id, ChatStream { handle, seq: 0, exit_sent: false });
        core.pump_waker.kick();
        id
    };
    // The chat row (and a pending tab) shows up right away.
    core.publish(&app);
    Ok(id)
}

#[tauri::command(async)]
fn chat_send(core: State<'_, Arc<Core>>, id: usize, text: String) -> Res<()> {
    core.with_chat(id, |c| c.send(&text))
}

#[tauri::command(async)]
fn chat_interrupt(core: State<'_, Arc<Core>>, id: usize) -> Res<()> {
    core.with_chat(id, |c| c.interrupt())
}

/// A steering note for the running turn; returns its id (see CHAT_SPEC "Steering").
#[tauri::command(async)]
fn chat_steer(core: State<'_, Arc<Core>>, id: usize, text: String, now: bool) -> Res<String> {
    core.with_chat(id, |c| c.steer(&text, now))
}

#[tauri::command(async)]
fn chat_steer_cancel(core: State<'_, Arc<Core>>, id: usize, note_id: String) -> Res<()> {
    core.with_chat(id, |c| c.cancel_steer(&note_id))
}

#[tauri::command(async)]
fn chat_set_model(core: State<'_, Arc<Core>>, id: usize, model: String) -> Res<()> {
    core.with_chat(id, |c| c.set_model(&model))
}

#[tauri::command(async)]
fn chat_set_permission_mode(core: State<'_, Arc<Core>>, id: usize, mode: String) -> Res<()> {
    core.with_chat(id, |c| c.set_permission_mode(&mode))
}

#[tauri::command(async)]
fn chat_respond_permission(core: State<'_, Arc<Core>>, id: usize, request_id: String, allow: bool, always: bool, remember: Option<String>) -> Res<()> {
    // `remember`: one of the request's `remember` option ids (allow and apply it).
    match remember.filter(|_| allow) {
        Some(r) => core.with_chat(id, |c| c.respond_permission_remember(&request_id, &r)),
        None => core.with_chat(id, |c| c.respond_permission(&request_id, allow, always)),
    }
}

#[tauri::command(async)]
fn chat_respond_question(core: State<'_, Arc<Core>>, id: usize, request_id: String, answers: Vec<Vec<String>>) -> Res<()> {
    core.with_chat(id, |c| c.respond_question(&request_id, &answers))
}

#[tauri::command(async)]
fn chat_stop(core: State<'_, Arc<Core>>, id: usize) -> Res<()> {
    core.with_chat(id, |c| {
        c.stop();
        Ok(())
    })
}

/// Everything the chat still holds, for a view that mounts late or a reloaded UI.
#[tauri::command]
fn chat_replay(core: State<'_, Arc<Core>>, id: usize) -> Res<ChatReplay> {
    let chats = core.chats.lock().unwrap();
    let c = chats.get(&id).ok_or("no such chat")?;
    let (events, seq) = c.handle.events_since(0);
    Ok(ChatReplay { events, seq })
}

#[tauri::command(async)]
fn open_in_terminal(app: AppHandle, core: State<'_, Arc<Core>>, id: usize) -> Res<usize> {
    let pty = {
        let mut hub = core.hub.lock().unwrap();
        // The terminal view fits itself (and resizes the PTY) as soon as it mounts.
        let pty = hub.open_chat_in_terminal(id, 40, 120).map_err(|e| format!("{e:#}"))?;
        core.register_pty(&hub, pty);
        pty
    };
    core.publish(&app);
    Ok(pty)
}

// ---- AI insights (CHAT_SPEC "AI insights") ----

#[derive(Serialize)]
struct InsightsStatus {
    enabled: bool,
    has_key: bool,
    /// Last API error, if the most recent request failed (never contains the key).
    error: Option<String>,
}

#[tauri::command(async)]
fn insights_status(core: State<'_, Arc<Core>>) -> InsightsStatus {
    let has_key = insights::api_key().is_some();
    let ins = core.insights.lock().unwrap();
    InsightsStatus { enabled: ins.enabled(), has_key, error: ins.last_error().map(str::to_string) }
}

#[tauri::command(async)]
fn insights_set_key(core: State<'_, Arc<Core>>, key: String) -> Res<()> {
    insights::save_api_key(&key).map_err(|e| format!("{e:#}"))?;
    let mut ins = core.insights.lock().unwrap();
    let on = ins.enabled();
    // Re-reads the key on the next tick.
    ins.set_enabled(on);
    Ok(())
}

#[tauri::command(async)]
fn insights_clear_key(core: State<'_, Arc<Core>>) -> Res<()> {
    insights::delete_api_key().map_err(|e| format!("{e:#}"))?;
    let mut ins = core.insights.lock().unwrap();
    let on = ins.enabled();
    ins.set_enabled(on);
    Ok(())
}

#[tauri::command(async)]
fn insights_set_enabled(core: State<'_, Arc<Core>>, enabled: bool) -> Res<()> {
    core.insights.lock().unwrap().set_enabled(enabled);
    let mut s = settings::load(core.selftest.as_ref());
    s.insights = enabled;
    settings::save(core.selftest.as_ref(), &s).map_err(err)?;
    core.kick();
    Ok(())
}

/// Settings sheet: show sessions started by other tools and agents (APP_SPEC "Who started it").
#[tauri::command(async)]
fn set_show_automation(core: State<'_, Arc<Core>>, enabled: bool) -> Res<()> {
    core.show_automation.store(enabled, Ordering::Relaxed);
    let mut s = settings::load(core.selftest.as_ref());
    s.show_automation = enabled;
    settings::save(core.selftest.as_ref(), &s).map_err(err)?;
    core.kick();
    Ok(())
}

// ---- Plan usage (CHAT_SPEC "Plan usage") ----

/// Refresh one provider's plan usage now (a hidden CLI probe that runs no
/// model turn); the result arrives with a later `sessions` payload.
#[tauri::command]
fn usage_refresh(core: State<'_, Arc<Core>>, provider: Provider) {
    core.usage.refresh_now(provider);
    core.kick();
}

/// Spend one Codex rate-limit reset credit (`account/rateLimitResetCredit/consume`
/// through a short-lived `codex app-server`), then re-probe Codex usage. The
/// UI calls this only after the person confirms; `idempotency_key` is one per
/// attempt, reused on a retry so a retry never spends a second credit.
#[tauri::command(async)]
fn usage_reset_codex(core: State<'_, Arc<Core>>, idempotency_key: String) -> Result<ResetOutcome, String> {
    let r = core.usage.redeem_codex_reset(&idempotency_key).map_err(|e| format!("{e:#}"));
    core.kick();
    r
}

#[tauri::command(async)]
fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog().file().blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
}

#[derive(Serialize)]
struct Environment {
    home: String,
    claude: Option<String>,
    codex: Option<String>,
}

/// Which CLIs are installed, so the new-session sheet can say so up front.
#[tauri::command(async)]
fn environment() -> Environment {
    Environment {
        home: dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default(),
        claude: env::which("claude").map(|p| p.to_string_lossy().into_owned()),
        codex: env::which("codex").map(|p| p.to_string_lossy().into_owned()),
    }
}

/// PTYs and chats coool is running (what quitting would stop).
#[tauri::command]
fn running_count(core: State<'_, Arc<Core>>) -> usize {
    core.running()
}

/// Called by the frontend's quit confirmation: stop what coool runs, then exit.
#[tauri::command]
fn quit_app(app: AppHandle, core: State<'_, Arc<Core>>) {
    core.allow_exit.store(true, Ordering::SeqCst);
    core.hub.lock().unwrap().kill_all();
    app.exit(0);
}

// ---------- settings ----------

mod settings {
    use serde::{Deserialize, Serialize};
    use std::path::PathBuf;

    /// Preferences that live in the backend. Off by default.
    #[derive(Default, Serialize, Deserialize)]
    pub struct Settings {
        #[serde(default)]
        pub insights: bool,
        /// Show sessions started by other tools / agents (off: hidden).
        #[serde(default)]
        pub show_automation: bool,
    }

    fn path(t: Option<&super::selftest::SelfTest>) -> Option<PathBuf> {
        match t {
            // A self-test never touches the real preferences.
            Some(t) => Some(t.settings_path()),
            None => dirs::config_dir().map(|d| d.join("coool").join("settings.json")),
        }
    }

    pub fn load(t: Option<&super::selftest::SelfTest>) -> Settings {
        path(t).and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(t: Option<&super::selftest::SelfTest>, s: &Settings) -> std::io::Result<()> {
        let Some(p) = path(t) else { return Ok(()) };
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d)?;
        }
        std::fs::write(p, serde_json::to_vec_pretty(s)?)
    }
}

// ---------- background threads ----------

fn spawn_refresher(app: AppHandle, core: Arc<Core>) {
    thread::spawn(move || {
        // Transcript and registry writes wake the loop within a few ms; the
        // timer still catches what no file write announces (a process that
        // died, a session ageing out, plan usage, insights).
        let mut watch = Watch::sources(core.waker.clone());
        loop {
            // The first payload goes out right away, even if empty, with `loading`.
            let loading = core.publish(&app);
            // Poll faster while the initial load streams in.
            let wait = Duration::from_millis(if loading { 200 } else { 1000 });
            watch.ensure();
            core.waker.wait(wait);
        }
    });
}

fn spawn_pump(app: AppHandle, core: Arc<Core>) {
    thread::spawn(move || {
        loop {
            let mut out = Vec::new();
            let mut exits = Vec::new();
            // Anything still streaming? If not, nap until one is registered.
            let mut active = false;
            {
                let mut streams = core.streams.lock().unwrap();
                for (&id, s) in streams.iter_mut() {
                    if s.exit_sent {
                        continue;
                    }
                    active = true;
                    // Read `exited` before draining so the final bytes are never lost.
                    let exited = *s.exited.lock().unwrap();
                    let (bytes, next) = s.raw.lock().unwrap().read_since(s.offset);
                    s.offset = next;
                    if !bytes.is_empty() {
                        out.push(PtyOutput { id, data: B64.encode(bytes), offset: next });
                    }
                    if exited {
                        s.exit_sent = true;
                        exits.push(id);
                    }
                }
            }
            // Chats: one batch per chat per tick, everything new since the last one.
            let mut batches = Vec::new();
            let mut chat_changed = false;
            {
                let mut chats = core.chats.lock().unwrap();
                for (&id, c) in chats.iter_mut() {
                    if c.exit_sent {
                        continue;
                    }
                    active = true;
                    let (events, next) = c.handle.events_since(c.seq);
                    c.seq = next;
                    if events.is_empty() {
                        continue;
                    }
                    for e in &events {
                        match e.kind {
                            ChatEventKind::Exited { .. } => {
                                c.exit_sent = true;
                                chat_changed = true;
                            }
                            // Session id / model known, or a turn ended: the sidebar row may change.
                            ChatEventKind::Ready { .. } | ChatEventKind::TurnEnd { .. } => chat_changed = true,
                            _ => {}
                        }
                    }
                    batches.push(ChatBatch { id, events });
                }
            }
            for b in batches {
                let _ = app.emit("chat-event", b);
            }
            for o in out {
                let _ = app.emit("pty-output", o);
            }
            for id in exits.iter().copied() {
                let _ = app.emit("pty-exit", PtyExit { id });
            }
            if !exits.is_empty() || chat_changed {
                core.kick();
            }
            if active {
                thread::sleep(Duration::from_millis(16));
            } else {
                // `register_pty` / `start_chat` kick it; the timeout is only a backstop.
                core.pump_waker.wait(Duration::from_secs(5));
            }
        }
    });
}

#[cfg(unix)]
fn terminate(pid: u32) -> Res<()> {
    let r = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    if r == 0 { Ok(()) } else { Err(err(std::io::Error::last_os_error())) }
}

#[cfg(not(unix))]
fn terminate(_pid: u32) -> Res<()> {
    Err("stopping external sessions isn't supported on this platform yet".into())
}

/// A menu without "Close Window" (Cmd+W closes a tab here) and with a Quit
/// that asks first when coool is running sessions. Edit items keep copy/paste working.
fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let quit = MenuItemBuilder::with_id("quit", "Quit coool").accelerator("CmdOrCtrl+Q").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "coool")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().separator().fullscreen().build()?;
    MenuBuilder::new(app).items(&[&app_menu, &edit, &window]).build()
}

/// Cmd+Q / the Quit menu item: ask first when PTYs or chats are running.
fn request_quit(app: &AppHandle) {
    let core = app.state::<Arc<Core>>();
    let running = core.running();
    if running > 0 && !core.allow_exit.load(Ordering::SeqCst) {
        let _ = app.emit("confirm-quit", running);
    } else {
        core.allow_exit.store(true, Ordering::SeqCst);
        app.exit(0);
    }
}

fn expand_tilde(p: &str) -> String {
    let p = p.trim();
    if let Some(rest) = p.strip_prefix('~')
        && let Some(h) = dirs::home_dir()
    {
        return format!("{}{rest}", h.to_string_lossy());
    }
    p.to_string()
}

/// `coool --coool-device-mcp`: the stdio MCP server a chat's CLI runs; it relays to the running app (device/mcp.rs).
pub fn device_mcp_proxy() -> i32 {
    device::mcp::proxy()
}

/// `coool --coool-device-serve <dir>`: the device MCP server without the UI, for scripted tests (device/mod.rs).
pub fn device_serve_headless(dir: &std::path::Path) -> i32 {
    device::Devices::serve_headless(dir)
}

pub const DEVICE_MCP_FLAG: &str = device::mcp::PROXY_FLAG;

pub fn run() {
    // A Finder-launched app gets a minimal PATH; adopt the login shell's so
    // `claude` / `codex` resolve. Must happen before any thread starts.
    env::adopt_login_path();

    let selftest = selftest::SelfTest::from_env();
    let prefs = settings::load(selftest.as_ref());
    let mut ins = Insights::new();
    ins.set_enabled(prefs.insights);
    let mut hub = Hub::new(Duration::from_secs(24 * 3600));
    if let Some(t) = &selftest {
        // Test chats are not the person's: remembered only inside the throwaway
        // folder (so the test still sees them), and Codex threads carry a test name.
        hub.set_own_sessions_file(Some(t.own_sessions_path()));
        hub.set_client_name(coool_core::origin::TEST_CLIENT_NAME);
    }
    let mut usage = UsageMonitor::new();
    // Self-test runs stay off the person's accounts: free file reads only.
    // Probes send no prompt and spend no model usage; the self-test turns them on only when asked.
    usage.set_probes(selftest.is_none() || std::env::var_os("COOOL_SELFTEST_PROBES").is_some());
    let core = Arc::new(Core {
        hub: Mutex::new(hub),
        published: Mutex::new(Published::new()),
        pump_waker: Waker::new(),
        emit_order: Mutex::new(()),
        streams: Mutex::new(HashMap::new()),
        chats: Mutex::new(HashMap::new()),
        insights: Mutex::new(ins),
        usage,
        allow_exit: AtomicBool::new(false),
        waker: Waker::new(),
        selftest,
        show_automation: AtomicBool::new(prefs.show_automation),
        trace: trace::Trace::from_env(),
        previews: artifact::Previews::default(),
        browsers: browser::Browsers::default(),
    });

    let devices = Arc::new(device::Devices::default());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // No click-to-open script: it would run in the in-app browser's pages too, swallowing every `target=_blank`
        // link click (its IPC call is refused there). The app's own links open through its handlers.
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .register_uri_scheme_protocol(artifact::SCHEME, |ctx, req| artifact::serve(&ctx.app_handle().state::<Arc<Core>>().previews, &req))
        .manage(core.clone())
        .manage(devices.clone())
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            spawn_session,
            resume_session,
            pty_write,
            pty_resize,
            pty_replay,
            send_prompt,
            stop_session,
            stop_shell,
            shells_focus,
            start_chat,
            chat_send,
            chat_interrupt,
            chat_steer,
            chat_steer_cancel,
            chat_set_model,
            chat_set_permission_mode,
            chat_respond_permission,
            chat_respond_question,
            chat_stop,
            chat_replay,
            open_in_terminal,
            insights_status,
            insights_set_key,
            insights_clear_key,
            insights_set_enabled,
            set_show_automation,
            usage_refresh,
            usage_reset_codex,
            pick_folder,
            environment,
            running_count,
            quit_app,
            selftest::selftest_config,
            selftest::selftest_log,
            selftest::selftest_shot,
            selftest::selftest_request_quit,
            trace::trace_sessions,
            motion::motion_hints,
            artifact::artifact_status,
            artifact::artifact_window,
            artifact::selftest_artifact,
            browser::browser_open,
            browser::browser_bounds,
            browser::browser_navigate,
            browser::browser_go,
            browser::browser_poll,
            browser::browser_close,
            browser::browser_open_external,
            device::sim_devices,
            device::sim_ensure_device,
            device::sim_boot,
            device::sim_shutdown,
            device::sim_attach,
            device::sim_detach,
            device::sim_input,
            device::sim_bind,
            device::web::browser_agent_sync,
            selftest::selftest_probe_server,
            selftest::selftest_probe_result,
            selftest::selftest_resize,
            selftest::selftest_webview,
            selftest::selftest_popups,
            selftest::selftest_browser_eval,
            selftest::selftest_previews,
            selftest::selftest_preview_eval,
            selftest::selftest_close_preview,
            selftest::selftest_click,
            selftest::selftest_sim_delete,
            selftest::selftest_sim_screen,
        ])
        .setup(move |app| {
            app.set_menu(build_menu(app.handle())?)?;
            let handle = app.handle().clone();
            let c = app.state::<Arc<Core>>().inner().clone();
            // The dev server serves the app itself in `tauri dev`: never a page for the in-app browser.
            c.browsers.set_app_origin(if tauri::is_dev() { app.config().build.dev_url.as_ref() } else { None });
            if let Some(t) = &c.selftest {
                t.prepare_window(&handle);
            }
            // The iPhone panel's devices and the `coool-device` MCP server each chat coool starts gets.
            let devices = app.state::<Arc<device::Devices>>().inner().clone();
            match &c.selftest {
                // A device and helper of the test's own: never the person's "coool iPhone" or their helper binary.
                Some(t) => {
                    device::simctl::set_only_device(selftest::SIM_NAME);
                    devices.init_in(&handle, Some(t.dir().join(".coool-device")));
                }
                None => devices.init(&handle),
            }
            let d = devices.clone();
            c.hub.lock().unwrap().set_chat_mcp(Some(Box::new(move |id, cwd| d.mcp.server_for(id, cwd).into_iter().collect())));
            spawn_refresher(handle.clone(), c.clone());
            motion::spawn_watch(handle.clone());
            spawn_pump(handle, c);
            Ok(())
        })
        .on_menu_event(|app, ev| {
            if ev.id() == "quit" {
                request_quit(app);
            }
        })
        .on_window_event(|win, ev| {
            if let WindowEvent::Focused(f) = ev {
                win.state::<Arc<Core>>().usage.set_active(*f);
            }
            // The rest is the main window's: pop-ups of the in-app browser (browser.rs) and artifact previews close freely.
            if win.label() != "main" {
                return;
            }
            if let WindowEvent::Destroyed = ev {
                browser::close_all_popups(win.app_handle());
                artifact::close_previews(win.app_handle());
            }
            if let WindowEvent::CloseRequested { api, .. } = ev {
                let core = win.state::<Arc<Core>>();
                let running = core.running();
                if !core.allow_exit.load(Ordering::SeqCst) && running > 0 {
                    api.prevent_close();
                    let _ = win.emit("confirm-quit", running);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building coool");

    app.run(move |handle, ev| match ev {
        RunEvent::ExitRequested { code, api, .. } => {
            let core = handle.state::<Arc<Core>>();
            let running = core.running();
            if code.is_none() && !core.allow_exit.load(Ordering::SeqCst) && running > 0 {
                api.prevent_exit();
                let _ = handle.emit("confirm-quit", running);
            }
        }
        RunEvent::Exit => {
            core.hub.lock().unwrap().kill_all();
            let devices = handle.state::<Arc<device::Devices>>();
            device::mcp::cleanup(&devices);
            devices.shutdown_all();
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn rest(pending: &[usize]) -> String {
        serde_json::to_string(&Rest { pending: pending.to_vec(), ..Rest::default() }).unwrap()
    }

    fn entry(text: &str) -> coool_core::model::Activity {
        coool_core::model::Activity::message("10:00:00".into(), coool_core::model::ActivityKind::Text, &format!("{text}\nwith a second line"), 80)
    }

    fn session(id: &str, updated_ms: u64, n: usize) -> Session {
        Session {
            provider: Provider::Claude,
            id: id.into(),
            title: String::new(),
            cwd: String::new(),
            project: String::new(),
            model: String::new(),
            pid: None,
            status: coool_core::model::Status::Idle,
            current: None,
            last_prompt: None,
            tokens: Default::default(),
            activity: Arc::new((0..n).map(|i| entry(&format!("{id} entry {i}"))).collect()),
            agents: Vec::new(),
            updated: std::time::UNIX_EPOCH + Duration::from_millis(updated_ms),
            last_event: None,
            managed: None,
            chat: None,
            models: Vec::new(),
            loaded: true,
            origin: Default::default(),
            parent: None,
            live_children: 0,
            background_tasks: false,
            waiting_for: None,
            shells: Vec::new(),
        }
    }

    fn rows(r: &[(&str, &Session)]) -> Vec<(String, Session, Option<Insight>)> {
        r.iter().map(|(k, s)| (k.to_string(), (*s).clone(), None)).collect()
    }

    fn val(s: &Session) -> Value {
        serde_json::from_str(&s.to_json()).unwrap()
    }

    #[test]
    fn full_first_then_only_what_changed() {
        let mut p = Published::new();
        let before: Value = serde_json::from_str(&p.full(None)).unwrap();
        assert_eq!((before["seq"].as_u64(), before["loading"].as_bool(), before["sessions"].as_array().map(Vec::len)), (Some(0), Some(true), Some(0)));

        let (a, b) = (session("a", 1, 0), session("b", 1, 0));
        let u = p.update(rows(&[("claude:a", &a), ("codex:b", &b)]), rest(&[]), false).expect("the first payload always goes out");
        assert_eq!(u.event, "sessions");
        let v: Value = serde_json::from_str(&u.payload).unwrap();
        assert_eq!(v, json!({"seq": 1, "order": ["claude:a", "codex:b"], "sessions": [val(&a), val(&b)], "pending": [], "ptys": [], "loading": false, "chats": [], "usage": {"claude": null, "codex": null}, "show_automation": false}));
        assert_eq!(serde_json::from_str::<Value>(&p.full(None)).unwrap(), v, "list_sessions returns the same");

        assert!(p.update(rows(&[("claude:a", &a), ("codex:b", &b)]), rest(&[]), false).is_none(), "nothing changed");

        // A small session that changed: whole, in `upsert`.
        let a2 = session("a", 2, 0);
        let u = p.update(rows(&[("claude:a", &a2), ("codex:b", &b)]), rest(&[]), true).unwrap();
        let v: Value = serde_json::from_str(&u.payload).unwrap();
        assert_eq!((u.event, &v["seq"], &v["base"], &v["upsert"], &v["patch"], &v["order"]), ("sessions-delta", &json!(2), &json!(1), &json!({"claude:a": val(&a2)}), &json!({}), &json!(["claude:a", "codex:b"])));
        assert_eq!(v["trace"]["seq"], json!(2));
        assert_eq!(u.changed, vec!["claude:a".to_string()]);

        // Reordered, one gone, other fields changed: no session data, just the new order.
        let u = p.update(rows(&[("codex:b", &b)]), rest(&[3]), false).unwrap();
        let v: Value = serde_json::from_str(&u.payload).unwrap();
        assert_eq!((&v["base"], &v["upsert"], &v["patch"], &v["order"], &v["pending"]), (&json!(2), &json!({}), &json!({}), &json!(["codex:b"]), &json!([3])));
    }

    #[test]
    fn a_long_session_that_grew_goes_out_as_a_patch() {
        let mut p = Published::new();
        let mut a = session("a", 1, 200);
        p.update(rows(&[("claude:a", &a)]), rest(&[]), false).unwrap();
        a.updated += Duration::from_millis(1);
        Arc::make_mut(&mut a.activity).push(entry("new"));
        let u = p.update(rows(&[("claude:a", &a)]), rest(&[]), false).unwrap();
        let v: Value = serde_json::from_str(&u.payload).unwrap();
        assert_eq!(v["upsert"], json!({}));
        let pa = &v["patch"]["claude:a"];
        assert_eq!((&pa["activity"]["from"], &pa["activity"]["keep"], &pa["activity"]["tail"]), (&json!(0), &json!(200), &json!([val(&a)["activity"][200]])));
        assert!(u.payload.len() * 20 < a.to_json().len());
        // list_sessions still has the whole session.
        let full: Value = serde_json::from_str(&p.full(None)).unwrap();
        assert_eq!(full["sessions"][0], val(&a));
    }

    #[test]
    fn object_joins_fields() {
        assert_eq!(object(&[("a", "1")], r#"{"b":2}"#), r#"{"a":1,"b":2}"#);
        assert_eq!(object(&[("a", "1")], "{}"), r#"{"a":1}"#);
        assert_eq!(object(&[], r#"{"b":2}"#), r#"{"b":2}"#);
    }
}
