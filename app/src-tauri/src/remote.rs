//! coool Remote in the app (docs/REMOTE.md): Settings > Remote's commands, and the app's side of the engine
//! (crates/remote's `Host`): what the phone may see, and the app's own paths for answering a request, sending to a
//! chat, stopping it and starting one. The rules themselves are crates/remote's (`rules`); this file only maps
//! their narrow results onto the app: an answer is allow once / deny / a question's picks (never a remember
//! option or a mode change), a start is a known folder in the mode `rules::start_mode` chose.
//!
//! Every remote action is shown where it happened: a line in the chat ("Allowed from Ada's iPhone"), and the
//! recent ones in Settings > Remote.
//!
//! Off by default. Its state lives in `~/Library/Application Support/coool/remote/` (a self-test's own folder
//! during a run), its private keys in the Keychain item `coool-remote-identity` (a file in the self-test's folder
//! during a run, so no test touches the Keychain).

use crate::{Core, Res, err};
use coool_core::chat::{ChatEventKind, ChatState};
use coool_remote::rules::{Answer, Cli, Need, Project, QuestionInfo, SessionInfo, Start, project_id};
use coool_remote::{Remote, Status};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use tauri::{AppHandle, Emitter, Manager, State};

/// The relay the app talks to unless its saved state names another: the `coool-remote` project's deployment.
/// A Convex deployment URL is a public client address (like any web app's backend URL), not a secret.
pub const DEFAULT_RELAY: &str = "https://giddy-ox-164.eu-west-1.convex.cloud";

/// What the refresher and the chat pump last saw, for the engine's thread to read without taking the Hub.
#[derive(Default)]
struct View {
    /// (session, its folder, its project root).
    sessions: Vec<(SessionInfo, String, String)>,
    /// Pending requests per chat, in arrival order.
    needs: HashMap<usize, Vec<Pending>>,
    /// Per CLI: (model, mode) a new chat starts with (Settings > General, from the page).
    defaults: HashMap<Cli, (Option<String>, Option<String>)>,
}

#[derive(Clone)]
struct Pending {
    request_id: String,
    kind: &'static str,
    tool: String,
    summary: String,
    command: Option<String>,
    explanation: Option<String>,
    questions: Vec<QuestionInfo>,
}

static VIEW: Mutex<Option<View>> = Mutex::new(None);

fn view<T>(f: impl FnOnce(&mut View) -> T) -> T {
    let mut g = VIEW.lock().unwrap();
    f(g.get_or_insert_with(View::default))
}

fn base(p: &str) -> String {
    std::path::Path::new(p).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string())
}

/// From each refresh (`Core::collect`): the sessions as the phone sees them. A self-test passes only its own
/// sessions (the refresh already keeps to them; checked again here) plus invented ones.
pub(crate) fn on_sessions(core: &Core, rows: &[(String, coool_core::model::Session, Option<coool_core::insights::Insight>)], waiting: &[usize]) {
    use coool_core::model::{Provider, Status as S};
    let mut out: Vec<(SessionInfo, String, String)> = rows
        .iter()
        .filter(|(_, s, _)| core.selftest.as_ref().is_none_or(|t| t.owns(&s.cwd)))
        .filter(|(_, s, _)| s.parent.is_none())
        .map(|(key, s, _)| {
            let state = if s.chat.is_some_and(|c| waiting.contains(&c)) || s.waiting_for.is_some() {
                "waiting"
            } else {
                match s.status {
                    S::Busy => "working",
                    S::Idle => "idle",
                    S::Ended => "ended",
                }
            };
            let updated = s.updated.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            let info = SessionInfo {
                id: key.clone(),
                title: s.name.as_ref().map(|n| n.title.clone()).unwrap_or_else(|| s.title.clone()).chars().take(120).collect(),
                project: base(&s.project),
                cli: if s.provider == Provider::Codex { Cli::Codex } else { Cli::Claude },
                state: state.into(),
                model: s.model.clone(),
                last_activity: updated,
                chat: s.chat.is_some(),
            };
            (info, s.cwd.clone(), s.project.clone())
        })
        .collect();
    if core.selftest.is_some() {
        // Invented sessions, so a test's snapshot has more than its one real chat (and nothing of the person's).
        for (i, (title, cli, state)) in [("Invented: tidy the parser tests", Cli::Codex, "idle"), ("Invented: sketch the settings page", Cli::Claude, "ended")].into_iter().enumerate() {
            out.push((SessionInfo { id: format!("selftest:invented-{i}"), title: title.into(), project: "invented-project".into(), cli, state: state.into(), model: String::new(), last_activity: 1_700_000_000_000 + i as u64, chat: false }, String::new(), String::new()));
        }
    }
    view(|v| v.sessions = out);
}

/// From the chat pump, for every event: keeps each chat's pending requests.
pub(crate) fn on_chat_event(chat: usize, ev: &ChatEventKind) -> bool {
    view(|v| match ev {
        ChatEventKind::PermissionRequest { request_id, tool, summary, input, .. } => {
            let command = ["command", "file_path", "url"].iter().find_map(|k| input.get(*k).and_then(Value::as_str)).map(|s| s.chars().take(2000).collect());
            let explanation = input.get("description").and_then(Value::as_str).map(str::to_string);
            let kind = if tool == "ExitPlanMode" { "plan" } else { "permission" };
            v.needs.entry(chat).or_default().push(Pending { request_id: request_id.clone(), kind, tool: tool.clone(), summary: summary.chars().take(500).collect(), command, explanation, questions: vec![] });
            true
        }
        ChatEventKind::Question { request_id, questions } => {
            let qs = questions.iter().map(|q| QuestionInfo { question: q.question.clone(), options: q.options.iter().map(|o| o.label.clone()).collect(), multi: q.multi_select, allow_other: q.allow_other && !q.secret }).collect();
            let summary = questions.first().map(|q| q.question.clone()).unwrap_or_default();
            v.needs.entry(chat).or_default().push(Pending { request_id: request_id.clone(), kind: "question", tool: "Question".into(), summary, command: None, explanation: None, questions: qs });
            true
        }
        ChatEventKind::State { state } if *state != ChatState::WaitingPermission => v.needs.remove(&chat).is_some(),
        ChatEventKind::Exited { .. } | ChatEventKind::TurnEnd { .. } => v.needs.remove(&chat).is_some(),
        _ => false,
    })
}

#[derive(Deserialize)]
pub struct Defaults {
    claude: ModelMode,
    codex: ModelMode,
}

#[derive(Deserialize)]
struct ModelMode {
    model: Option<String>,
    mode: Option<String>,
}

/// The app's side of the engine.
struct AppHost {
    app: AppHandle,
    core: Weak<Core>,
}

impl AppHost {
    fn core(&self) -> Result<Arc<Core>, String> {
        self.core.upgrade().ok_or_else(|| "coool is quitting".to_string())
    }

    /// The chat a session id names: a published key (`claude:<id>`) of a chat coool runs, or `chat:<n>`.
    fn chat_of(&self, core: &Core, session: &str) -> Option<usize> {
        if let Some(n) = session.strip_prefix("chat:").and_then(|n| n.parse().ok()) {
            return core.chats.lock().unwrap().contains_key(&n).then_some(n);
        }
        if let Some(id) = core.chats.lock().unwrap().iter().find(|(_, c)| c.key.as_deref() == Some(session)).map(|(id, _)| *id) {
            return Some(id);
        }
        let sid = session.split_once(':').map(|(_, s)| s)?;
        core.hub.lock().unwrap().chats().into_iter().find(|c| c.session_id.as_deref() == Some(sid)).map(|c| c.id)
    }

    fn note(&self, core: &Core, chat: usize, text: &str) {
        if let Some(c) = core.chats.lock().unwrap().get(&chat) {
            c.handle.note(text);
        }
        core.pump_waker.kick();
    }
}

impl coool_remote::Host for AppHost {
    fn sessions(&self) -> Vec<SessionInfo> {
        view(|v| v.sessions.iter().map(|(s, _, _)| s.clone()).collect())
    }

    fn needs(&self) -> Vec<Need> {
        let Ok(core) = self.core() else { return vec![] };
        let keys: HashMap<usize, Option<String>> = core.chats.lock().unwrap().iter().map(|(id, c)| (*id, c.key.clone())).collect();
        view(|v| {
            let mut out = Vec::new();
            for (chat, ps) in &v.needs {
                let session = keys.get(chat).cloned().flatten().unwrap_or_else(|| format!("chat:{chat}"));
                for p in ps {
                    out.push(Need { id: format!("{chat}:{}", p.request_id), session: session.clone(), kind: p.kind.into(), tool: p.tool.clone(), summary: p.summary.clone(), command: p.command.clone(), questions: p.questions.clone(), explanation: p.explanation.clone(), risk: None });
                }
            }
            out
        })
    }

    fn projects(&self) -> Vec<Project> {
        let Ok(core) = self.core() else { return vec![] };
        let mut roots: Vec<String> = view(|v| v.sessions.iter().map(|(_, _, root)| root.clone()).filter(|r| !r.is_empty()).collect());
        roots.extend(core.hub.lock().unwrap().chats().into_iter().map(|c| coool_core::project::project_root(&c.cwd)));
        roots.retain(|r| std::path::Path::new(r).is_dir() && core.selftest.as_ref().is_none_or(|t| t.owns(r)));
        roots.sort();
        roots.dedup();
        roots.into_iter().map(|p| Project { id: project_id(&p), name: base(&p), path: p }).collect()
    }

    fn default_mode(&self, cli: Cli) -> Option<String> {
        view(|v| v.defaults.get(&cli).and_then(|d| d.1.clone()))
    }

    fn chat_tail(&self, session: &str, n: usize) -> Result<Value, String> {
        let core = self.core()?;
        let chat = self.chat_of(&core, session).ok_or("only chats coool runs can be read from the phone")?;
        let handle = core.chats.lock().unwrap().get(&chat).map(|c| c.handle.clone()).ok_or("no such chat")?;
        let (events, _) = handle.events_since(0);
        let mut items: Vec<Value> = events
            .iter()
            .filter_map(|e| match &e.kind {
                ChatEventKind::UserMessage { text, .. } => Some(json!({"role": "user", "text": text})),
                ChatEventKind::AssistantMessage { text, parent_tool_id: None, .. } if !text.is_empty() => Some(json!({"role": "assistant", "text": text})),
                ChatEventKind::ToolStart { name, summary, parent_tool_id: None, .. } => Some(json!({"role": "tool", "tool": name, "text": summary})),
                ChatEventKind::Notice { text, .. } => Some(json!({"role": "notice", "text": text})),
                _ => None,
            })
            .collect();
        let skip = items.len().saturating_sub(n);
        items.drain(..skip);
        for it in items.iter_mut() {
            if let Some(t) = it["text"].as_str().filter(|t| t.len() > 4000) {
                it["text"] = json!(t.chars().take(4000).collect::<String>());
            }
        }
        Ok(json!(items))
    }

    fn answer(&self, need: &Need, answer: &Answer, by: &str) -> Result<(), String> {
        let core = self.core()?;
        let (chat, request) = need.id.split_once(':').ok_or("bad request id")?;
        let chat: usize = chat.parse().map_err(|_| "bad request id")?;
        // Allow once, deny, or the picks: `always` is false and no remember option is ever passed.
        match answer {
            Answer::AllowOnce => core.with_chat(chat, |c| c.respond_permission(request, true, false))?,
            Answer::Deny => core.with_chat(chat, |c| c.respond_permission(request, false, false))?,
            Answer::Picks(p) => core.with_chat(chat, |c| c.respond_question(request, p))?,
        }
        view(|v| {
            if let Some(ps) = v.needs.get_mut(&chat) {
                ps.retain(|p| p.request_id != request);
            }
        });
        let words = match answer {
            Answer::AllowOnce => format!("Allowed {} from {by}", need.tool),
            Answer::Deny => format!("Denied {} from {by}", need.tool),
            Answer::Picks(_) => format!("Answered from {by}"),
        };
        self.note(&core, chat, &words);
        Ok(())
    }

    fn send(&self, session: &str, text: &str, by: &str) -> Result<(), String> {
        let core = self.core()?;
        let chat = self.chat_of(&core, session).ok_or("only chats coool runs can be reached from the phone")?;
        core.with_chat(chat, |c| c.send(text))?;
        self.note(&core, chat, &format!("Sent from {by}"));
        Ok(())
    }

    fn stop(&self, session: &str, by: &str) -> Result<(), String> {
        let core = self.core()?;
        let chat = self.chat_of(&core, session).ok_or("only chats coool runs can be reached from the phone")?;
        // The app's Stop: the turn ends, the chat stays open.
        core.notifier.user_stopped(chat);
        core.with_chat(chat, |c| c.interrupt())?;
        self.note(&core, chat, &format!("Stopped from {by}"));
        Ok(())
    }

    fn start(&self, s: &Start, by: &str) -> Result<String, String> {
        let core = self.core()?;
        let provider = match s.cli {
            Cli::Claude => coool_core::model::Provider::Claude,
            Cli::Codex => coool_core::model::Provider::Codex,
        };
        let model = view(|v| v.defaults.get(&s.cli).and_then(|d| d.0.clone()));
        // The mode is the one the rules chose (never Bypass or full access); Ladder stays off.
        let opts = coool_core::chat::ChatOptions { provider, cwd: s.project.path.clone(), resume: None, model, permission_mode: Some(s.mode.to_string()), ladder: None };
        let id = crate::start_chat_with(&self.app, &core, opts)?;
        self.note(&core, id, &format!("Started from {by}"));
        core.with_chat(id, |c| c.send(&s.text))?;
        Ok(format!("chat:{id}"))
    }

    fn changed(&self) {
        let _ = self.app.emit("remote-changed", ());
    }
}

/// Settings > Remote's handle on the engine.
pub struct RemoteState(pub Arc<Remote>);

pub fn init(app: &AppHandle, core: &Arc<Core>) {
    let (dir, keys): (std::path::PathBuf, Box<dyn coool_remote::keystore::KeyStore>) = match &core.selftest {
        // A self-test never touches the Keychain: a test-only file store in its own folder.
        Some(t) => (t.dir().join(".coool-remote"), Box::new(coool_remote::keystore::FileStore(t.dir().join(".coool-remote-identity")))),
        None => (dirs::config_dir().map(|d| d.join("coool").join("remote")).unwrap_or_else(std::env::temp_dir), Box::new(coool_remote::keystore::Keychain)),
    };
    let relay = std::env::var("COOOL_REMOTE_RELAY").ok().filter(|_| core.selftest.is_some()).unwrap_or_else(|| DEFAULT_RELAY.to_string());
    let host = Arc::new(AppHost { app: app.clone(), core: Arc::downgrade(core) });
    let remote = Remote::new(dir.clone(), keys, host, &relay);
    app.manage(RemoteState(remote));
    if core.selftest.is_some() {
        let _ = std::fs::create_dir_all(&dir);
    }
}

/// The engine wants an early look (a request arrived, a chat changed).
pub(crate) fn nudge(app: &AppHandle) {
    if let Some(r) = app.try_state::<RemoteState>() {
        r.0.nudge();
    }
}

fn status_of(r: &Remote) -> Status {
    r.status()
}

/// During a self-test the QR payload also goes to a file in its folder, for the stand-in phone to read.
fn selftest_drop(core: &Core, name: &str, text: &str) {
    if let Some(t) = &core.selftest {
        let _ = std::fs::write(t.dir().join(name), text);
    }
}

// ---------------------------------------------------------------- commands

#[tauri::command(async)]
pub fn remote_status(remote: State<'_, RemoteState>) -> Status {
    status_of(&remote.0)
}

#[tauri::command(async)]
pub fn remote_set_enabled(remote: State<'_, RemoteState>, enabled: bool) -> Res<Status> {
    remote.0.set_enabled(enabled).map_err(err)
}

#[tauri::command(async)]
pub fn remote_pair_start(core: State<'_, Arc<Core>>, remote: State<'_, RemoteState>) -> Res<coool_remote::PairingView> {
    let v = remote.0.pair_start().map_err(err)?;
    selftest_drop(&core, "remote-pair-url.txt", &v.url);
    Ok(v)
}

#[tauri::command(async)]
pub fn remote_pair_confirm(remote: State<'_, RemoteState>) -> Res<coool_remote::DeviceView> {
    remote.0.pair_confirm().map_err(err)
}

#[tauri::command(async)]
pub fn remote_pair_cancel(remote: State<'_, RemoteState>) -> Res<()> {
    remote.0.pair_cancel().map_err(err)
}

#[tauri::command(async)]
pub fn remote_remove_device(remote: State<'_, RemoteState>, id: String) -> Res<Status> {
    remote.0.remove_device(&id).map_err(err)?;
    Ok(status_of(&remote.0))
}

/// What a new chat starts with (Settings > General), so a remote start uses the same model and, if it asks, mode.
#[tauri::command(async)]
pub fn remote_set_defaults(defaults: Defaults) {
    view(|v| {
        v.defaults.insert(Cli::Claude, (defaults.claude.model, defaults.claude.mode));
        v.defaults.insert(Cli::Codex, (defaults.codex.model, defaults.codex.mode));
    });
}

/// Self-test only: a file the stand-in phone wrote into the test's folder (`remote-phone-*.txt`).
#[tauri::command(async)]
pub fn remote_selftest_read(core: State<'_, Arc<Core>>, name: String) -> Res<Option<String>> {
    let t = core.selftest.as_ref().ok_or("not a self-test")?;
    if !(name.starts_with("remote-phone-") && name.ends_with(".txt") && !name.contains('/') && !name.contains("..")) {
        return Err("not a self-test file".into());
    }
    Ok(std::fs::read_to_string(t.dir().join(name)).ok())
}

/// Self-test only: writes a file for the stand-in phone (`remote-app-*.txt`) in the test's folder.
#[tauri::command(async)]
pub fn remote_selftest_write(core: State<'_, Arc<Core>>, name: String, text: String) -> Res<()> {
    let t = core.selftest.as_ref().ok_or("not a self-test")?;
    if !(name.starts_with("remote-app-") && name.ends_with(".txt") && !name.contains('/') && !name.contains("..")) {
        return Err("not a self-test file".into());
    }
    std::fs::write(t.dir().join(name), text).map_err(err)
}
