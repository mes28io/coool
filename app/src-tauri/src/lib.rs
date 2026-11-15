//! Tauri shell around `coool_core::hub::Hub`.
//!
//! One `Hub` behind a mutex, refreshed by a background thread about once a
//! second (emits `sessions` when anything changed, sooner when kicked), plus a
//! ~16ms pump that streams raw PTY bytes to xterm.js (`pty-output`, `pty-exit`)
//! and chat events (`chat-event`). The pump reads through handles cloned out of
//! the Hub, so a slow refresh never delays streamed text.
//! See docs/APP_SPEC.md ("Backend contract") and docs/CHAT_SPEC.md.

mod env;
mod selftest;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use coool_core::chat::{ChatEvent, ChatEventKind, ChatHandle, ChatOptions, ChatState};
use coool_core::hub::Hub;
use coool_core::insights::{self, Insight, Insights};
use coool_core::model::{Provider, Session};
use coool_core::pty::RawLog;
use coool_core::usage::{PlanUsage, UsageMonitor};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;
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
    snapshot: Mutex<Snapshot>,
    streams: Mutex<HashMap<usize, Stream>>,
    chats: Mutex<HashMap<usize, ChatStream>>,
    insights: Mutex<Insights>,
    /// CHAT_SPEC "Plan usage".
    usage: UsageMonitor,
    /// Set once the user confirmed quitting (or nothing was running).
    allow_exit: AtomicBool,
    /// Wakes the refresher early (a chat or PTY started or ended).
    kick: (Mutex<bool>, Condvar),
    selftest: Option<selftest::SelfTest>,
    /// Settings sheet: "Show runs started by other tools" (persisted).
    show_automation: AtomicBool,
}

#[derive(Clone, Serialize, Default)]
struct Snapshot {
    sessions: Vec<SessionOut>,
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

/// Plan usage per provider; `null` until something is known.
#[derive(Clone, Serialize, Default)]
struct UsageOut {
    claude: Option<PlanUsage>,
    codex: Option<PlanUsage>,
}

/// `Session` plus what the app knows about it beyond discovery.
#[derive(Clone, Serialize)]
struct SessionOut {
    #[serde(flatten)]
    session: Session,
    /// CHAT_SPEC "AI insights"; only while insights are on.
    #[serde(skip_serializing_if = "Option::is_none")]
    insight: Option<Insight>,
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
    fn refresh(&self) -> (Snapshot, bool) {
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
        let sessions = {
            let mut ins = self.insights.lock().unwrap();
            ins.tick(&sessions);
            sessions
                .into_iter()
                .map(|s| {
                    let insight = if ins.enabled() { ins.get(s.provider, &s.id).cloned() } else { None };
                    SessionOut { session: s, insight }
                })
                .collect()
        };
        self.usage.tick();
        let usage = UsageOut { claude: self.usage.get(Provider::Claude), codex: self.usage.get(Provider::Codex) };
        let show_automation = self.show_automation.load(Ordering::Relaxed);
        let next = Snapshot { sessions, pending, ptys, loading, chats, usage, show_automation };
        let mut cur = self.snapshot.lock().unwrap();
        // `updated` changes on every write, so a JSON compare is a cheap and exact "changed?".
        let changed = serde_json::to_string(&*cur).ok() != serde_json::to_string(&next).ok();
        *cur = next.clone();
        (next, changed)
    }

    /// Ask the refresher for a refresh now rather than at its next tick.
    fn kick(&self) {
        let (m, cv) = &self.kick;
        *m.lock().unwrap() = true;
        cv.notify_one();
    }

    fn register_pty(&self, hub: &Hub, id: usize) {
        if let Some(m) = hub.get(id) {
            self.streams.lock().unwrap().insert(id, Stream { raw: m.raw.clone(), exited: m.exited.clone(), offset: 0, exit_sent: false });
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
        let (snap, _) = self.refresh();
        let _ = app.emit("sessions", snap);
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

#[tauri::command]
fn list_sessions(core: State<'_, Arc<Core>>) -> Snapshot {
    core.snapshot.lock().unwrap().clone()
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
        id
    };
    // The chat row (and a pending tab) shows up right away.
    let (snap, _) = core.refresh();
    let _ = app.emit("sessions", snap);
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
    let (snap, _) = core.refresh();
    let _ = app.emit("sessions", snap);
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
        let mut first = true;
        loop {
            let (snap, changed) = core.refresh();
            // The first payload goes out right away, even if empty, with `loading`.
            let loading = snap.loading;
            if changed || first {
                let _ = app.emit("sessions", snap);
            }
            first = false;
            // Poll faster while the initial load streams in; wake early when kicked.
            let wait = Duration::from_millis(if loading { 200 } else { 1000 });
            let (m, cv) = &core.kick;
            let g = m.lock().unwrap();
            let (mut g, _) = cv.wait_timeout_while(g, wait, |k| !*k).unwrap();
            *g = false;
        }
    });
}

fn spawn_pump(app: AppHandle, core: Arc<Core>) {
    thread::spawn(move || {
        loop {
            let mut out = Vec::new();
            let mut exits = Vec::new();
            {
                let mut streams = core.streams.lock().unwrap();
                for (&id, s) in streams.iter_mut() {
                    if s.exit_sent {
                        continue;
                    }
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
            thread::sleep(Duration::from_millis(16));
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
        // Until the first refresh lands, a `list_sessions` caller sees "loading".
        snapshot: Mutex::new(Snapshot { loading: true, ..Snapshot::default() }),
        streams: Mutex::new(HashMap::new()),
        chats: Mutex::new(HashMap::new()),
        insights: Mutex::new(ins),
        usage,
        allow_exit: AtomicBool::new(false),
        kick: (Mutex::new(false), Condvar::new()),
        selftest,
        show_automation: AtomicBool::new(prefs.show_automation),
    });

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(core.clone())
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            spawn_session,
            resume_session,
            pty_write,
            pty_resize,
            pty_replay,
            send_prompt,
            stop_session,
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
            pick_folder,
            environment,
            running_count,
            quit_app,
            selftest::selftest_config,
            selftest::selftest_log,
            selftest::selftest_shot,
            selftest::selftest_request_quit,
        ])
        .setup(move |app| {
            app.set_menu(build_menu(app.handle())?)?;
            let handle = app.handle().clone();
            let c = app.state::<Arc<Core>>().inner().clone();
            if let Some(t) = &c.selftest {
                t.prepare_window(&handle);
            }
            spawn_refresher(handle.clone(), c.clone());
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
        }
        _ => {}
    });
}
