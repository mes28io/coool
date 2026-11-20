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
use coool_core::chat::{ChatEvent, ChatEventKind, ChatState};
use coool_core::model::{Activity, ActivityKind};
use coool_remote::overview::{self, Step, StepKind};
use coool_remote::rules::{Answer, Cli, Delivery, Diff, Need, Project, QuestionInfo, Read, SessionInfo, Start, project_id};
use coool_remote::{ChatView, Remote, Status};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use tauri::{AppHandle, Emitter, Manager, State};

/// The app ships with no relay: Remote appears only on a Mac whose `relay.json` (in Remote's state folder,
/// `~/Library/Application Support/coool/remote/`) names one. See docs/REMOTE.md, "Your own relay".
pub const DEFAULT_RELAY: &str = "";

/// What the refresher and the chat pump last saw, for the engine's thread to read without taking the Hub.
#[derive(Default)]
struct View {
    /// (session, its folder, its project root).
    sessions: Vec<(SessionInfo, String, String)>,
    /// Pending requests per chat, in arrival order.
    needs: HashMap<usize, Vec<Pending>>,
    /// Per CLI: (model, mode) a new chat starts with (Settings > General, from the page).
    defaults: HashMap<Cli, (Option<String>, Option<String>)>,
    /// Per CLI: the models a new chat can start on (Settings > General's list, from the page): (id, label).
    models: HashMap<Cli, Vec<(String, String)>>,
    /// Per session id: its timeline and Mission-control facts, for the overview (minor 1).
    timelines: HashMap<String, Timeline>,
    /// What the Needs-you page shows for each pending request (from the page): by need id.
    notes: HashMap<String, Note>,
    /// Commit trails per project root, read at most once a minute: (when, the trail's rows, branch).
    trails: HashMap<String, (u64, Vec<Value>, Option<String>)>,
}

#[derive(Clone)]
struct Timeline {
    activity: Arc<Vec<Activity>>,
    root: String,
    /// Sub-agents: (label, step in progress, finished).
    agents: Vec<(String, Option<String>, bool)>,
}

/// The page's words for a request (components/needs, lib/risk.ts, the AI read), as `remote_set_need_notes` gives them.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Note {
    #[serde(default)]
    what: Option<String>,
    #[serde(default)]
    risk: Option<String>,
    #[serde(default)]
    read: Option<Read>,
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
    diff: Option<Diff>,
    plan: Option<String>,
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
    let mut timelines = HashMap::new();
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
            let title: String = s.name.as_ref().map(|n| n.title.clone()).unwrap_or_else(|| s.title.clone()).chars().take(120).collect();
            let mut info = SessionInfo::new(key, &title, &base(&s.project), if s.provider == Provider::Codex { Cli::Codex } else { Cli::Claude }, state, &s.model, updated, s.chat.is_some());
            // Minor 1: what it does right now, and the turn so far.
            if s.status == S::Busy {
                let now = crate::remote::now_ms();
                let turn = s.activity.iter().rposition(|a| a.kind == ActivityKind::Prompt);
                info.step = s.current.as_ref().map(|c| c.chars().take(160).collect());
                info.agents = s.agents.iter().filter(|a| !a.finished).count() as u32;
                info.steps = s.activity.iter().skip(turn.map(|i| i + 1).unwrap_or(0)).filter(|a| a.kind == ActivityKind::Tool).count() as u32;
                info.turn_started = turn.and_then(|i| hms_ms(&s.activity[i].ts, now));
            }
            timelines.insert(key.clone(), Timeline { activity: s.activity.clone(), root: s.project.clone(), agents: s.agents.iter().map(|a| (if a.description.is_empty() { a.kind.clone() } else { a.description.clone() }, a.current.clone(), a.finished)).collect() });
            (info, s.cwd.clone(), s.project.clone())
        })
        .collect();
    if core.selftest.is_some() {
        // Invented sessions, so a test's snapshot has more than its one real chat (and nothing of the person's).
        for (i, (title, cli, state)) in [("Invented: tidy the parser tests", Cli::Codex, "idle"), ("Invented: sketch the settings page", Cli::Claude, "ended")].into_iter().enumerate() {
            out.push((SessionInfo::new(&format!("selftest:invented-{i}"), title, "invented-project", cli, state, "", 1_700_000_000_000 + i as u64, false), String::new(), String::new()));
        }
    }
    view(|v| {
        v.sessions = out;
        v.timelines = timelines;
    });
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A timeline's `HH:MM:SS` (local time) as epoch ms: today, or yesterday when that would be in the future.
fn hms_ms(ts: &str, now: u64) -> Option<u64> {
    let mut it = ts.split(':').map(|x| x.parse::<u64>().ok());
    let (Some(Some(h)), Some(Some(m)), Some(Some(sec))) = (it.next(), it.next(), it.next()) else { return None };
    let secs = (now / 1000) as libc::time_t;
    // SAFETY: localtime_r writes into the struct we own.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    let since_midnight = tm.tm_hour as u64 * 3600 + tm.tm_min as u64 * 60 + tm.tm_sec as u64;
    let midnight = now / 1000 - since_midnight;
    let mut t = (midnight + h * 3600 + m * 60 + sec) * 1000;
    if t > now + 60_000 {
        t = t.saturating_sub(86_400_000);
    }
    Some(t)
}

/// An Edit, MultiEdit or Write call's change, from its input (relative to `cwd` when inside it).
fn diff_of(tool: &str, input: &Value, cwd: &str) -> Option<Diff> {
    let path = input.get("file_path").or_else(|| input.get("path")).and_then(Value::as_str)?;
    let rel = path.strip_prefix(cwd).and_then(|r| r.strip_prefix('/')).unwrap_or(path);
    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
    match tool {
        "Edit" | "str_replace_based_edit_tool" => Some(Diff::new(rel, s("old_string"), s("new_string"))),
        "Write" => Some(Diff::new(rel, "", s("content"))),
        "MultiEdit" => {
            let edits = input.get("edits")?.as_array()?;
            let side = |k: &str| edits.iter().map(|e| e.get(k).and_then(Value::as_str).unwrap_or("")).collect::<Vec<_>>().join("\n⋯\n");
            Some(Diff::new(rel, &side("old_string"), &side("new_string")))
        }
        _ => None,
    }
}

/// From the chat pump, for every event: keeps each chat's pending requests.
pub(crate) fn on_chat_event(chat: usize, ev: &ChatEventKind) -> bool {
    view(|v| match ev {
        ChatEventKind::PermissionRequest { request_id, tool, summary, input, .. } => {
            let command = ["command", "file_path", "url"].iter().find_map(|k| input.get(*k).and_then(Value::as_str)).map(|s| s.chars().take(2000).collect());
            let explanation = input.get("description").and_then(Value::as_str).map(str::to_string);
            let kind = if tool == "ExitPlanMode" { "plan" } else { "permission" };
            let plan = input.get("plan").and_then(Value::as_str).filter(|_| kind == "plan").map(|p| p.chars().take(coool_remote::rules::MAX_PLAN).collect());
            let diff = diff_of(tool, input, "");
            v.needs.entry(chat).or_default().push(Pending { request_id: request_id.clone(), kind, tool: tool.clone(), summary: summary.chars().take(500).collect(), command, explanation, questions: vec![], diff, plan });
            true
        }
        ChatEventKind::Question { request_id, questions } => {
            let qs = questions.iter().map(|q| QuestionInfo { question: q.question.clone(), options: q.options.iter().map(|o| o.label.clone()).collect(), multi: q.multi_select, allow_other: q.allow_other && !q.secret }).collect();
            let summary = questions.first().map(|q| q.question.clone()).unwrap_or_default();
            v.needs.entry(chat).or_default().push(Pending { request_id: request_id.clone(), kind: "question", tool: "Question".into(), summary, command: None, explanation: None, questions: qs, diff: None, plan: None });
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
    /// The models a new chat can start on, per CLI (Settings > General's list): what a phone may choose from.
    #[serde(default)]
    models: Option<HashMap<String, Vec<ModelChoice>>>,
}

#[derive(Deserialize)]
struct ModelChoice {
    id: String,
    #[serde(default)]
    label: String,
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
                    let id = format!("{chat}:{}", p.request_id);
                    let note = v.notes.get(&id).cloned().unwrap_or_default();
                    out.push(Need {
                        command: p.command.clone(),
                        questions: p.questions.clone(),
                        explanation: p.explanation.clone(),
                        risk: note.risk,
                        what: note.what,
                        read: note.read,
                        diff: p.diff.clone(),
                        plan: p.plan.clone(),
                        ..Need::new(&id, &session, p.kind, &p.tool, &p.summary)
                    });
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
                // Attachments go to the phone by name only (the protocol has no field for them).
                ChatEventKind::UserMessage { text, attachments, .. } => {
                    let names: Vec<&str> = attachments.iter().map(|a| a.name.as_str()).collect();
                    let text = if names.is_empty() { text.clone() } else { format!("{}{}[Attached: {}]", text, if text.is_empty() { "" } else { "\n" }, names.join(", ")) };
                    Some(json!({"role": "user", "text": text}))
                }
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
            // The Mac's "Keep planning": the plan isn't approved; the note goes in as the next step's note.
            Answer::KeepPlanning(note) => {
                core.with_chat(chat, |c| c.respond_permission(request, false, false))?;
                if let Some(n) = note {
                    core.with_chat(chat, |c| c.steer_with(n, false, &[]).map(|_| ()))?;
                }
            }
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
            Answer::KeepPlanning(_) => format!("Asked to keep planning from {by}"),
        };
        self.note(&core, chat, &words);
        Ok(())
    }

    fn send(&self, session: &str, text: &str, how: Delivery, atts: &[Value], by: &str) -> Result<(), String> {
        let core = self.core()?;
        let chat = self.chat_of(&core, session).ok_or("only chats coool runs can be reached from the phone")?;
        let atts = attachments(atts)?;
        // As the Mac's composer: a message, or a steering note (next step, or interrupting the one in progress).
        match how {
            Delivery::Send => core.with_chat(chat, |c| c.send_with(text, &atts))?,
            Delivery::Next => core.with_chat(chat, |c| c.steer_with(text, false, &atts).map(|_| ()))?,
            Delivery::Interrupt => core.with_chat(chat, |c| c.steer_with(text, true, &atts).map(|_| ()))?,
        }
        let what = match how {
            Delivery::Send => "Sent",
            Delivery::Next => "Note for the next step sent",
            Delivery::Interrupt => "Interrupted and sent",
        };
        self.note(&core, chat, &format!("{what} from {by}"));
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

    fn start(&self, s: &Start, atts: &[Value], by: &str) -> Result<String, String> {
        let core = self.core()?;
        let provider = match s.cli {
            Cli::Claude => coool_core::model::Provider::Claude,
            Cli::Codex => coool_core::model::Provider::Codex,
        };
        let atts = attachments(atts)?;
        // The model the phone chose (one of `models`, checked by the rules), else the app's default for new chats.
        let model = s.model.clone().or_else(|| view(|v| v.defaults.get(&s.cli).and_then(|d| d.0.clone())));
        // The mode is the one the rules chose (never Bypass or full access); Ladder stays off.
        let opts = coool_core::chat::ChatOptions { provider, cwd: s.project.path.clone(), resume: None, model, permission_mode: Some(s.mode.to_string()), ladder: None };
        let id = crate::start_chat_with(&self.app, &core, opts)?;
        self.note(&core, id, &format!("Started from {by}"));
        core.with_chat(id, |c| c.send_with(&s.text, &atts))?;
        Ok(format!("chat:{id}"))
    }

    fn models(&self, cli: Cli) -> Vec<String> {
        view(|v| v.models.get(&cli).map(|m| m.iter().map(|(id, _)| id.clone()).collect()).unwrap_or_default())
    }

    fn options(&self) -> Value {
        let mode_words = |id: &'static str| -> &'static str { match id {
            "default" => "Ask me before each change",
            "acceptEdits" => "Edit files freely, ask before commands",
            "plan" => "Plan first, change nothing until I say",
            "untrusted" => "Ask me before anything that isn’t plainly safe",
            "on-request" => "Work on its own, ask when it needs to",
            _ => id,
        } };
        view(|v| {
            let one = |cli: Cli| {
                let (model, mode) = v.defaults.get(&cli).cloned().unwrap_or_default();
                json!({
                    "models": v.models.get(&cli).map(|m| m.iter().map(|(id, label)| json!({"id": id, "label": label})).collect::<Vec<_>>()).unwrap_or_default(),
                    "modes": coool_remote::rules::start_modes(cli).iter().map(|m| json!({"id": m, "label": mode_words(m)})).collect::<Vec<_>>(),
                    "model": model,
                    "mode": coool_remote::rules::start_mode(cli, mode.as_deref()),
                })
            };
            json!({"claude": one(Cli::Claude), "codex": one(Cli::Codex)})
        })
    }

    fn overview(&self) -> Value {
        let Ok(core) = self.core() else { return Value::Null };
        overview_of(&core)
    }

    fn chat_view(&self, session: &str, since: Option<u64>) -> Result<ChatView, String> {
        let core = self.core()?;
        let chat = self.chat_of(&core, session).ok_or("only chats coool runs can be shown on the phone")?;
        // One lock at a time (never `chats` and `hub` together: the app takes them in its own order).
        let handle = core.chats.lock().unwrap().get(&chat).map(|c| c.handle.clone()).ok_or("no such chat")?;
        let cwd = core.hub.lock().unwrap().chats().into_iter().find(|x| x.id == chat).map(|x| x.cwd).unwrap_or_default();
        let (events, _) = handle.events_since(0);
        let mut v = build_view(&events, &cwd, since);
        let devices = self.app.state::<Arc<crate::device::Devices>>();
        let mut panels = Vec::new();
        if crate::device::web::remote_has_page(&devices, chat) {
            panels.push("browser");
        }
        if devices.bound(chat).is_some() {
            panels.push("simulator");
        }
        v.live["devices"] = json!(panels);
        Ok(v)
    }

    fn chat_image(&self, session: &str, key: &str) -> Result<Vec<u8>, String> {
        let core = self.core()?;
        let chat = self.chat_of(&core, session).ok_or("only chats coool runs can be shown on the phone")?;
        // Only a key this chat holds (an attachment it was sent), found in coool's own store: never a path.
        if !coool_core::attach::valid_key(key) {
            return Err("no such image".into());
        }
        let handle = core.chats.lock().unwrap().get(&chat).map(|c| c.handle.clone()).ok_or("no such chat")?;
        let (events, _) = handle.events_since(0);
        let has = events.iter().any(|e| match &e.kind {
            ChatEventKind::UserMessage { attachments, .. } | ChatEventKind::Steer { attachments, .. } => attachments.iter().any(|a| a.key.as_deref() == Some(key)),
            _ => false,
        });
        if !has {
            return Err("no such image".into());
        }
        let dir = coool_core::attach::store_dir().ok_or("no attachment store")?;
        let (path, _) = coool_core::attach::stored(&dir, key).ok_or("that image is no longer stored")?;
        phone_jpeg(&path, 1024, 600_000)
    }

    fn device_frame(&self, session: &str, device: &str) -> Result<Option<Vec<u8>>, String> {
        let core = self.core()?;
        let chat = self.chat_of(&core, session).ok_or("only chats coool runs can be shown on the phone")?;
        frame_for(&self.app, chat, device)
    }

    fn store_image(&self, img: &coool_remote::live::Image) -> Result<Value, String> {
        // Checked again by its bytes; stored as a pasted image is (named by its hash in coool's own store).
        if !coool_core::attach::is_image(&img.bytes[..img.bytes.len().min(4096)]) || img.bytes.len() as u64 > coool_core::attach::MAX_IMAGE_BYTES {
            return Err("not an image coool can send".into());
        }
        let dir = coool_core::attach::store_dir().ok_or("no attachment store")?;
        let ext = match img.mime {
            "image/png" => "png",
            "image/gif" => "gif",
            "image/webp" => "webp",
            _ => "jpg",
        };
        let a = coool_core::attach::store_bytes(&dir, &format!("iPhone image.{ext}"), &img.bytes).map_err(|e| format!("{e:#}"))?;
        if a.kind != coool_core::attach::AttachKind::Image {
            return Err("not an image coool can send".into());
        }
        serde_json::to_value(a).map_err(|e| e.to_string())
    }

    fn changed(&self) {
        let _ = self.app.emit("remote-changed", ());
    }
}

/// Attachments the engine hands back: only ones `store_image` made (an image in coool's store).
fn attachments(atts: &[Value]) -> Result<Vec<coool_core::attach::Attachment>, String> {
    atts.iter()
        .map(|v| {
            let a: coool_core::attach::Attachment = serde_json::from_value(v.clone()).map_err(|_| "a bad attachment".to_string())?;
            let dir = coool_core::attach::store_dir().ok_or("no attachment store")?;
            let ok = a.kind == coool_core::attach::AttachKind::Image && a.key.as_deref().is_some_and(|k| coool_core::attach::stored(&dir, k).is_some_and(|(p, _)| a.path.as_deref() == Some(&*p.to_string_lossy())));
            if ok { Ok(a) } else { Err("an image that isn't in coool's store".to_string()) }
        })
        .collect()
}

/// An image scaled for the phone (`sips`, built into macOS): JPEG, at most `edge` px, at most `max` bytes.
fn phone_jpeg(src: &std::path::Path, edge: u32, max: usize) -> Result<Vec<u8>, String> {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dst = std::env::temp_dir().join(format!("coool-remote-{}-{}.jpg", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let mut out = Err("couldn't scale the image".to_string());
    for (e, q) in [(edge, 70), (edge * 3 / 4, 60), (edge / 2, 55)] {
        let ok = std::process::Command::new("/usr/bin/sips")
            .args(["-Z", &e.to_string(), "-s", "format", "jpeg", "-s", "formatOptions", &q.to_string()])
            .arg(src)
            .arg("--out")
            .arg(&dst)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !ok {
            break;
        }
        match std::fs::read(&dst) {
            Ok(b) if b.len() <= max => {
                out = Ok(b);
                break;
            }
            Ok(_) => out = Err("the image is too large for the phone".into()),
            Err(e) => {
                out = Err(e.to_string());
                break;
            }
        }
    }
    let _ = std::fs::remove_file(&dst);
    out
}

/// Device frames: taken off the engine's thread (a capture can take a moment), the newest kept per (chat, panel).
#[derive(Default)]
struct Frame {
    jpeg: Option<Vec<u8>>,
    busy: bool,
    error: Option<String>,
}

static FRAMES: Mutex<Option<HashMap<(usize, String), Frame>>> = Mutex::new(None);

/// The latest picture of a chat's panel (view only), and a new capture started for next time.
fn frame_for(app: &AppHandle, chat: usize, device: &str) -> Result<Option<Vec<u8>>, String> {
    let key = (chat, device.to_string());
    let (out, start) = {
        let mut g = FRAMES.lock().unwrap();
        let f = g.get_or_insert_with(HashMap::new).entry(key.clone()).or_default();
        if let Some(e) = f.error.take() {
            return Err(e);
        }
        let start = !f.busy;
        f.busy = true;
        (f.jpeg.take(), start)
    };
    if start {
        let app = app.clone();
        let device = device.to_string();
        let _ = std::thread::Builder::new().name("coool-remote-frame".into()).spawn(move || {
            let devices = app.state::<Arc<crate::device::Devices>>();
            let r: Result<Option<Vec<u8>>, String> = match device.as_str() {
                "browser" => crate::device::web::remote_frame(&devices, chat, 420.0),
                "simulator" => match devices.bound(chat) {
                    Some(udid) => devices.helper(&udid).and_then(|h| h.call(json!({ "cmd": "snapshot", "maxDim": 420.0, "quality": 0.45 }), std::time::Duration::from_secs(5))).and_then(|r| {
                        use base64::Engine;
                        let b = r["jpeg"].as_str().ok_or("no picture")?;
                        base64::engine::general_purpose::STANDARD.decode(b).map(Some).map_err(|e| e.to_string())
                    }),
                    None => Err("this chat has no simulator".into()),
                },
                _ => Err("the sandbox Mac's picture isn't available on the phone yet".into()),
            };
            let mut g = FRAMES.lock().unwrap();
            let f = g.get_or_insert_with(HashMap::new).entry((chat, device)).or_default();
            f.busy = false;
            match r {
                Ok(j) => f.jpeg = j.or(f.jpeg.take()),
                Err(e) => f.error = Some(e),
            }
        });
    }
    Ok(out)
}

/// A chat's live view from its events (only what the chat itself holds): the items changed after `since`, and
/// what happens now.
fn build_view(events: &[ChatEvent], cwd: &str, since: Option<u64>) -> ChatView {
    let mut items: Vec<(u64, Value)> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    let mut stream = String::new();
    let mut thinking = false;
    let mut state = "idle";
    let mut turn_start: Option<u64> = None;
    let (mut steps, mut edits) = (0u32, 0u32);
    let mut running: Vec<(String, String)> = Vec::new();
    // Sub-agents: tool id -> (label, steps, current step, done).
    let mut agents: Vec<(String, String, u32, Option<String>, bool)> = Vec::new();
    let clip = |t: &str, n: usize| -> String { if t.chars().count() > n { t.chars().take(n).collect() } else { t.to_string() } };
    fn put(items: &mut Vec<(u64, Value)>, at: &mut HashMap<String, usize>, k: String, seq: u64, v: Value) {
        if let Some(i) = at.get(&k) {
            items[*i] = (seq, v);
        } else {
            at.insert(k, items.len());
            items.push((seq, v));
        }
    }
    for e in events {
        match &e.kind {
            ChatEventKind::UserMessage { id, text, steer, attachments, .. } => {
                let images: Vec<Value> = attachments.iter().filter(|a| a.kind == coool_core::attach::AttachKind::Image).filter_map(|a| a.key.as_ref().map(|k| json!({"key": k, "name": a.name}))).collect();
                let mut v = json!({"k": format!("u:{id}"), "role": "user", "text": clip(text, 4000), "ts": e.ts});
                if *steer {
                    v["steer"] = json!(true);
                }
                if !images.is_empty() {
                    v["images"] = json!(images);
                }
                put(&mut items, &mut at, format!("u:{id}"), e.seq, v);
                if !*steer {
                    turn_start = Some(e.ts);
                    steps = 0;
                    edits = 0;
                    agents.clear();
                }
            }
            ChatEventKind::TextDelta { text, parent_tool_id: None, .. } => {
                stream.push_str(text);
                thinking = false;
            }
            ChatEventKind::ThinkingDelta { parent_tool_id: None, .. } => thinking = true,
            ChatEventKind::AssistantMessage { id, text, parent_tool_id: None, .. } => {
                stream.clear();
                thinking = false;
                if !text.is_empty() {
                    put(&mut items, &mut at, format!("a:{id}"), e.seq, json!({"k": format!("a:{id}"), "role": "assistant", "text": clip(text, 6000), "ts": e.ts}));
                }
            }
            ChatEventKind::ToolStart { id, name, summary, input, parent_tool_id } => {
                if let Some(p) = parent_tool_id {
                    if let Some(a) = agents.iter_mut().find(|a| &a.0 == p) {
                        a.2 += 1;
                        a.3 = Some(clip(&format!("{name} · {summary}"), 120));
                    }
                    continue;
                }
                steps += 1;
                stream.clear();
                let is_agent = matches!(name.as_str(), "Task" | "Agent");
                let mut v = json!({"k": format!("t:{id}"), "role": if is_agent { "agent" } else { "tool" }, "tool": name, "text": clip(summary, 300), "ts": e.ts});
                if let Some(d) = diff_of(name, input, cwd) {
                    edits += 1;
                    v["diff"] = json!(d);
                }
                if is_agent {
                    let label = input.get("description").and_then(Value::as_str).unwrap_or(summary);
                    agents.push((id.clone(), clip(label, 80), 0, None, false));
                }
                running.push((id.clone(), clip(&format!("{name} · {summary}"), 160)));
                put(&mut items, &mut at, format!("t:{id}"), e.seq, v);
            }
            ChatEventKind::ToolEnd { id, ok, .. } => {
                running.retain(|(r, _)| r != id);
                if let Some(a) = agents.iter_mut().find(|a| &a.0 == id) {
                    a.4 = true;
                    a.3 = None;
                }
                if let Some(i) = at.get(&format!("t:{id}")).copied() {
                    let mut v = items[i].1.clone();
                    v["ok"] = json!(ok);
                    if let Some(a) = agents.iter().find(|a| &a.0 == id) {
                        v["steps"] = json!(a.2);
                    }
                    items[i] = (e.seq, v);
                }
            }
            ChatEventKind::Notice { text, .. } => put(&mut items, &mut at, format!("n:{}", e.seq), e.seq, json!({"k": format!("n:{}", e.seq), "role": "notice", "text": clip(text, 600), "ts": e.ts})),
            ChatEventKind::State { state: st } => {
                state = match st {
                    ChatState::Idle => "idle",
                    ChatState::Working => "working",
                    ChatState::WaitingPermission => "waiting",
                };
            }
            ChatEventKind::TurnEnd { .. } => {
                stream.clear();
                thinking = false;
                running.clear();
                turn_start = None;
            }
            ChatEventKind::Exited { .. } => state = "ended",
            _ => {}
        }
    }
    let cursor = events.last().map(|e| e.seq).unwrap_or(0);
    let tail: String = {
        let n = stream.chars().count();
        stream.chars().skip(n.saturating_sub(3000)).collect()
    };
    let live = json!({
        "state": state,
        "text": if tail.is_empty() { Value::Null } else { json!(tail) },
        "thinking": thinking && state == "working",
        "step": running.last().map(|(_, s)| s.clone()),
        "agents": agents.iter().map(|a| json!({"id": a.0, "label": a.1, "steps": a.2, "step": a.3, "done": a.4})).collect::<Vec<_>>(),
        "tally": {"steps": steps, "edits": edits, "since": turn_start},
    });
    let mut out: Vec<Value> = items.into_iter().filter(|(q, _)| since.is_none_or(|c| *q > c)).map(|(_, v)| v).collect();
    if since.is_none() {
        // The whole view: the newest 80 items.
        let skip = out.len().saturating_sub(80);
        out.drain(..skip);
    }
    ChatView { items: out, cursor, live }
}

/// Mission control for the phone: per project, the live sessions with their sub-agents, the changes ledger, the
/// files two sessions edit, the commit trail; and plan usage (the usage ring's numbers).
fn overview_of(core: &Core) -> Value {
    let now = now_ms();
    let home = dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default();
    let (sessions, timelines) = view(|v| (v.sessions.clone(), v.timelines.clone()));
    let mut by: Vec<(String, Vec<(SessionInfo, String)>)> = Vec::new();
    for (s, _, root) in &sessions {
        if root.is_empty() {
            continue;
        }
        match by.iter_mut().find(|(r, _)| r == root) {
            Some((_, v)) => v.push((s.clone(), root.clone())),
            None => by.push((root.clone(), vec![(s.clone(), root.clone())])),
        }
    }
    let mut projects = Vec::new();
    for (root, ss) in by.iter().take(12) {
        let live: Vec<&SessionInfo> = ss.iter().map(|(s, _)| s).filter(|s| s.state != "ended").collect();
        let recent = ss.iter().any(|(s, _)| now.saturating_sub(s.last_activity) < 6 * 3_600_000);
        if live.is_empty() && !recent {
            continue;
        }
        let mut changes: Vec<overview::Change> = Vec::new();
        let mut agents = Vec::new();
        for (s, _) in ss {
            let Some(t) = timelines.get(&s.id) else { continue };
            let steps: Vec<Step> = t
                .activity
                .iter()
                .map(|a| Step {
                    ts: hms_ms(&a.ts, now).unwrap_or(now),
                    kind: match a.kind {
                        ActivityKind::Prompt => StepKind::Prompt,
                        ActivityKind::Tool => StepKind::Tool,
                        ActivityKind::Error => StepKind::Error(a.step),
                        _ => StepKind::Other,
                    },
                    text: &a.text,
                })
                .collect();
            changes.extend(overview::changes(&s.id, &steps, &t.root, &home).into_iter().filter(|c| now.saturating_sub(c.ts) < 6 * 3_600_000));
            if s.state == "working" {
                let running: Vec<Value> = t.agents.iter().filter(|a| !a.2).map(|a| json!({"label": a.0.chars().take(80).collect::<String>(), "step": a.1})).collect();
                if !running.is_empty() {
                    agents.push(json!({"session": s.id, "agents": running}));
                }
            }
        }
        let overlaps: Vec<Value> = overview::overlaps(&changes, 3_600_000)
            .into_iter()
            .take(5)
            .map(|o| {
                let names: Vec<String> = o.sessions.iter().map(|id| ss.iter().find(|(s, _)| &s.id == id).map(|(s, _)| s.title.clone()).unwrap_or_default()).collect();
                json!({"file": o.file, "sessions": o.sessions, "titles": names, "ts": o.ts})
            })
            .collect();
        changes.sort_by(|a, b| b.ts.cmp(&a.ts));
        changes.truncate(14);
        let (commits, branch) = trail_of(root, now);
        projects.push(json!({
            "name": base(root),
            "working": live.iter().filter(|s| s.state == "working").count(),
            "needs": live.iter().filter(|s| s.state == "waiting").count(),
            "idle": live.iter().filter(|s| s.state == "idle").count(),
            "sessions": live.iter().map(|s| &s.id).collect::<Vec<_>>(),
            "agents": agents,
            "changes": changes,
            "overlaps": overlaps,
            "commits": commits,
            "branch": branch,
        }));
    }
    let usage = |p: coool_core::model::Provider| {
        core.usage.get(p).map(|u| {
            json!({
                "plan": u.plan,
                "stale": u.stale,
                "windows": u.windows.iter().filter(|w| w.used_percent.is_some()).take(4).map(|w| json!({"label": w.label, "kind": w.kind, "percent": w.used_percent, "resets": w.resets_ms})).collect::<Vec<_>>(),
            })
        })
    };
    // A self-test shows no plan usage of the person's.
    let usage = if core.selftest.is_some() {
        json!({"claude": {"plan": "Invented", "windows": [{"label": "Current session", "kind": "session", "percent": 42.0, "resets": now + 7_200_000}, {"label": "Weekly", "kind": "weekly", "percent": 18.0, "resets": now + 3 * 86_400_000}]}})
    } else {
        json!({"claude": usage(coool_core::model::Provider::Claude), "codex": usage(coool_core::model::Provider::Codex)})
    };
    json!({"projects": projects, "usage": usage})
}

/// A project's latest commits (subject, when, how many files), read at most once a minute.
fn trail_of(root: &str, now: u64) -> (Vec<Value>, Option<String>) {
    if let Some((at, rows, branch)) = view(|v| v.trails.get(root).cloned())
        && now.saturating_sub(at) < 60_000
    {
        return (rows, branch);
    }
    let (rows, branch) = match coool_core::gitlog::trail(std::path::Path::new(root)) {
        Ok(t) => (
            t.commits.iter().take(6).map(|c| json!({"short": c.short, "subject": c.subject.chars().take(100).collect::<String>(), "ts": c.time_ms, "files": c.files.len() as u32 + c.files_more, "merge": c.merge.is_some()})).collect(),
            t.branch,
        ),
        Err(_) => (vec![], None),
    };
    view(|v| v.trails.insert(root.to_string(), (now, rows.clone(), branch.clone())));
    (rows, branch)
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
        if let Some(m) = defaults.models {
            for (k, cli) in [("claude", Cli::Claude), ("codex", Cli::Codex)] {
                let list = m.get(k).map(|l| l.iter().filter(|x| !x.id.is_empty() && x.id.len() < 120).take(40).map(|x| (x.id.clone(), if x.label.is_empty() { x.id.clone() } else { x.label.chars().take(60).collect() })).collect()).unwrap_or_default();
                v.models.insert(cli, list);
            }
        }
    });
}

/// What the Needs-you page shows for each pending request (its words, the risk tag, the AI read), from the page, so
/// the phone shows the same. Keyed by need id (`<chat>:<request id>`).
#[tauri::command(async)]
pub fn remote_set_need_notes(notes: HashMap<String, Note>) {
    view(|v| v.notes = notes.into_iter().take(200).collect());
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
