//! Structured chats: drive the official `claude` / `codex` CLIs through their
//! non-TUI protocols and expose one provider-neutral event stream.
//!
//! - Claude Code: `claude -p --input-format stream-json --output-format stream-json`
//!   (one long-lived process; user turns and control requests on stdin).
//! - Codex: `codex app-server` (JSON-RPC 2.0 over stdio).
//!
//! Frontends only ever see [`ChatEvent`]s; the wire formats stay in
//! [`claude`] / [`codex`]. No async runtime: one reader, one stderr, one writer
//! and one waiter thread per chat, like [`crate::pty`].

mod claude;
mod codex;
pub mod host;

use crate::model::{Provider, Tokens};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

/// How a chat is started. `permission_mode` uses the provider's own names
/// (Claude: `default`, `acceptEdits`, `plan`, ...; Codex: an approval policy such
/// as `on-request` or a sandbox mode such as `workspace-write`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatOptions {
    pub provider: Provider,
    pub cwd: String,
    #[serde(default)]
    pub resume: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// Ladder (APP_SPEC "Ladder"): the delegation policy and tier table handed to the CLI at launch; None: off.
    #[serde(default)]
    pub ladder: Option<crate::ladder::Ladder>,
    /// The coool context (APP_SPEC "coool context"): what the agent is told about coool, with what this chat has
    /// (filled in by the app at launch); None: off.
    #[serde(default)]
    pub context: Option<crate::agent_context::AgentContext>,
    /// Claude Platform (APP_SPEC "Claude Platform"): the id of the API key this chat is billed to; None: the
    /// subscription (the CLI's own login). Only the id: the key is read from the Keychain by whoever spawns the CLI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

/// An MCP server (stdio) handed to a chat's CLI at launch: Claude Code gets it through `--mcp-config=<private file>`, Codex through
/// `-c mcp_servers.<name>.…` overrides. Nothing is written to the person's CLI config.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Pre-approve every tool of this server (Claude: `--allowedTools=mcp__<name>`).
    pub allow_all: bool,
    /// How long one tool call may take (Codex's `tool_timeout_sec`, 60 s by default; Claude Code waits as long as
    /// the call runs). A call can wait for the person (coool's device gate), or run a whole pilot goal.
    pub tool_timeout_sec: Option<u64>,
}

/// Builds the MCP servers for a chat from its id and how it starts.
pub type McpFor = Box<dyn Fn(usize, &ChatOptions) -> Vec<McpServer> + Send>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatState {
    #[default]
    Idle,
    Working,
    WaitingPermission,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeLevel {
    Info,
    Warn,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelOption {
    pub id: String,
    pub label: String,
}

/// Where a slash command runs (see [`ChatEventKind::Commands`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandKind {
    /// A CLI command that runs inside the chat (sent as text).
    Command,
    /// A skill or custom prompt command (sent as text; the model runs it).
    Skill,
    /// Only works in the CLI's own terminal UI.
    Terminal,
}

/// A slash command with everything a command menu needs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandInfo {
    pub name: String,
    pub description: String,
    /// e.g. `[on|off]`; empty when the command takes no arguments.
    #[serde(default)]
    pub argument_hint: String,
    /// Other names the CLI accepts for it (e.g. `reset` for `clear`).
    #[serde(default)]
    pub aliases: Vec<String>,
    pub kind: CommandKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOption {
    pub label: String,
    #[serde(default)]
    pub description: String,
}

/// One question the agent asked the person (Claude's `AskUserQuestion`,
/// Codex's `request_user_input`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Question {
    /// Stable within its request (the provider's id, else the index).
    pub id: String,
    /// Short label, e.g. "Color".
    pub header: String,
    pub question: String,
    /// Choices; empty means free text only.
    pub options: Vec<QuestionOption>,
    /// More than one option may be picked.
    pub multi_select: bool,
    /// A typed answer is accepted besides the options.
    pub allow_other: bool,
    /// The answer should be masked while typed.
    pub secret: bool,
}

/// How long a [`RememberOption`] keeps allowing things.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RememberScope {
    /// This chat only; nothing is written anywhere.
    Chat,
    /// Saved to a settings file of this folder: future sessions here too,
    /// including ones outside coool.
    Project,
    /// Saved to a settings file of the person: every project.
    User,
}

/// One "don't ask again" choice the CLI offers on a permission request, in
/// plain words. Chosen with [`Chat::respond_permission_remember`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RememberOption {
    /// Stable within its request.
    pub id: String,
    /// Button text, e.g. "Allow all edits in this chat",
    /// "Always allow `npm test` commands in this project".
    pub label: String,
    /// One line saying exactly what changes and where it is kept.
    pub detail: String,
    pub scope: RememberScope,
    /// The settings file it is saved to (folder-relative for `project`,
    /// `~`-relative for `user`); `None` for `chat`.
    #[serde(default)]
    pub file: Option<String>,
    /// Set when choosing it switches the chat's permission mode (the new mode).
    #[serde(default)]
    pub mode: Option<String>,
    /// The rules it adds, in the CLI's own syntax (e.g. `Bash(npm test *)`).
    #[serde(default)]
    pub rules: Vec<String>,
}

impl RememberOption {
    pub fn persistent(&self) -> bool {
        self.scope != RememberScope::Chat
    }
}

/// One event of a chat, exactly as the app receives it: `{"seq", "ts", "type", ...}`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatEvent {
    pub seq: u64,
    /// Epoch milliseconds.
    pub ts: u64,
    #[serde(flatten)]
    pub kind: ChatEventKind,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatEventKind {
    Ready {
        session_id: String,
        model: String,
        cwd: String,
        permission_mode: String,
        slash_commands: Vec<SlashCommand>,
        models: Vec<ModelOption>,
        agents: Vec<String>,
        context_window: Option<u64>,
    },
    UserMessage {
        id: String,
        text: String,
        /// A steering note the agent took in (see [`ChatEventKind::Steer`]):
        /// shown with its step, not as a prompt of its own.
        steer: bool,
        /// The note's id when `steer`.
        note_id: Option<String>,
        /// Images and files sent with it (see [`crate::attach`]); `text` is without their marker lines.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<crate::attach::Attachment>,
    },
    TextDelta {
        message_id: String,
        text: String,
        parent_tool_id: Option<String>,
    },
    ThinkingDelta {
        message_id: String,
        text: String,
        parent_tool_id: Option<String>,
    },
    AssistantMessage {
        id: String,
        text: String,
        model: String,
        parent_tool_id: Option<String>,
    },
    ToolStart {
        id: String,
        name: String,
        summary: String,
        input: Value,
        parent_tool_id: Option<String>,
    },
    ToolEnd {
        id: String,
        ok: bool,
        output: String,
        /// The page an `Artifact` publish call made (see [`crate::artifact`]).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        artifact: Option<Box<crate::artifact::ArtifactInfo>>,
    },
    PermissionRequest {
        request_id: String,
        tool: String,
        summary: String,
        input: Value,
        /// The "don't ask again" choices the CLI offers for this request,
        /// this-chat-only ones first. Empty: nothing can be remembered.
        remember: Vec<RememberOption>,
    },
    Usage {
        model: String,
        tokens: Tokens,
        context_window: Option<u64>,
    },
    /// Running estimate of the output tokens of the model response now streaming
    /// (~4 characters per token), not yet part of any `usage` total. The exact
    /// count arrives with the response's `usage`, which supersedes it.
    LiveOutput {
        tokens: u64,
    },
    /// A subagent's running count as Claude Code shows it: its latest response's
    /// context plus its output.
    AgentTotal {
        tool_id: String,
        tokens: u64,
    },
    State {
        state: ChatState,
    },
    TurnEnd {
        duration_ms: u64,
        ok: bool,
    },
    /// Claude Platform: what an API-key chat's turn cost, by the CLI's own count (`result.total_cost_usd`, as the
    /// change since the CLI's previous result). Only for chats on an API key; follows that turn's `turn_end`.
    Cost {
        usd: f64,
    },
    /// The CLI started (`active`) or finished summarizing the conversation to
    /// free context (Claude `status: compacting`, Codex `contextCompaction`).
    Compacting {
        active: bool,
    },
    Notice {
        level: NoticeLevel,
        text: String,
        needs_terminal: bool,
    },
    Exited {
        code: Option<i32>,
    },
    /// The person restarted the chat ([`Chat::restart_options`], `chat_restart`): the CLI that `exited` before this
    /// was started again on the same conversation (its transcript, folder, model and mode), in the same chat. The chat
    /// is running again; `ready` follows as for a new start.
    Restarted,
    /// The CLI could not open (resume) or start the chat's conversation: the chat is over. The CLI is asked to
    /// exit, so `exited` follows; nothing sent to this chat reaches an agent any more (sends are refused).
    OpenFailed {
        /// The CLI's own error, as it gave it (empty when it gave none: see the notice that follows).
        error: String,
        reason: OpenFailure,
        /// The CLI's version, when it said (Codex's `initialize`).
        cli_version: Option<String>,
        /// A resume (else a new chat that could not start).
        resumed: bool,
        /// Prompts the person sent that never reached the agent (shown as sent until now).
        unsent: Vec<UnsentPrompt>,
    },
    /// The agent asks the person something (options and/or free text). The UI
    /// answers with [`Chat::respond_question`], or declines with
    /// [`Chat::respond_permission`] (`allow: false`). The chat's state is
    /// `waiting_permission` until then.
    Question {
        request_id: String,
        questions: Vec<Question>,
    },
    /// The slash commands with their kind, aliases and argument hints (the
    /// richer form of `ready.slash_commands`, which stays as it was). Sent with
    /// `ready` whenever the list or a command's kind changes.
    Commands {
        commands: Vec<CommandInfo>,
    },
    /// A steering note ([`Chat::steer`]) changed state. Sent `queued` when it
    /// is made, then once with where it ended. `tool_id`: the step it attached
    /// to (`picked_up`: the step after whose result the agent took it in;
    /// `interrupted`: the step that was cut), when known.
    Steer {
        note_id: String,
        text: String,
        state: SteerState,
        tool_id: Option<String>,
        /// The note's attachments (sent with it, images included).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<crate::attach::Attachment>,
    },
}

/// Why a chat's conversation could not be opened, as far as the CLI's error says.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenFailure {
    /// The saved conversation holds something the installed CLI can't read: a newer version of it wrote it.
    NewerCli,
    /// The CLI has no saved conversation with that id.
    NotFound,
    /// The CLI stopped before the conversation opened.
    Exited,
    Other,
}

/// A prompt shown as sent that never reached the agent; `id` is its `user_message` id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnsentPrompt {
    pub id: String,
    pub text: String,
}

/// Why a send is refused once a chat could not be opened.
pub(crate) const OPEN_FAILED_SEND: &str = "this chat couldn't be opened, so it can't take messages: start a new chat in this folder";

/// Where a steering note is. `queued` is the only state that changes again.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SteerState {
    /// Waiting for the agent's next step (held by coool or by the CLI).
    Queued,
    /// The agent took it in at a step boundary of the running turn (or, if
    /// the chat was idle, it started a turn).
    PickedUp,
    /// Delivered by interrupting the current step; it starts the next turn.
    Interrupted,
    /// The turn ended (or was stopped) before the agent took it in. It was not
    /// sent; the UI offers to send or discard it.
    Unused,
    /// Withdrawn with [`Chat::cancel_steer`].
    Cancelled,
}

impl ChatEventKind {
    pub(crate) fn notice(level: NoticeLevel, text: impl Into<String>) -> Self {
        ChatEventKind::Notice { level, text: text.into(), needs_terminal: false }
    }
    pub(crate) fn needs_terminal(text: impl Into<String>) -> Self {
        ChatEventKind::Notice { level: NoticeLevel::Info, text: text.into(), needs_terminal: true }
    }
}

/// Snapshot of a chat for lists (`sessions` payload) and headers.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatInfo {
    pub id: usize,
    pub provider: Provider,
    pub cwd: String,
    /// Provider session id (Claude session / Codex thread), once known.
    pub session_id: Option<String>,
    pub model: String,
    pub permission_mode: String,
    pub state: ChatState,
    pub running: bool,
    /// The Claude Platform key it runs on (see [`ChatOptions::account`]); None: the subscription.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

/// What a backend wants done after handling input: lines for the CLI's stdin
/// and events for the UI. Keeps backends pure, so they are tested on fixtures.
#[derive(Default, Debug)]
pub(crate) struct Out {
    pub writes: Vec<String>,
    pub events: Vec<ChatEventKind>,
    /// Close the CLI's input after the writes (so it exits): the chat is over.
    pub close: bool,
}

impl Out {
    pub fn write(&mut self, v: &Value) {
        self.writes.push(v.to_string());
    }
    pub fn ev(&mut self, e: ChatEventKind) {
        self.events.push(e);
    }
}

/// One provider's wire protocol.
pub(crate) trait Backend: Send {
    /// Lines to write right after the process starts.
    fn start(&mut self, o: &mut Out);
    /// One line of the CLI's stdout.
    fn on_line(&mut self, line: &str, o: &mut Out);
    /// A prompt; `atts` are its attachments, already checked and stored ([`crate::attach`]).
    fn send(&mut self, text: &str, atts: &[crate::attach::Attachment], o: &mut Out) -> Result<()>;
    fn interrupt(&mut self, o: &mut Out) -> Result<()>;
    fn set_model(&mut self, model: &str, o: &mut Out) -> Result<()>;
    fn set_permission_mode(&mut self, mode: &str, o: &mut Out) -> Result<()>;
    fn respond_permission(&mut self, request_id: &str, allow: bool, always: bool, o: &mut Out) -> Result<()>;
    /// Allow, and apply one of the request's [`RememberOption`]s.
    fn respond_permission_remember(&mut self, request_id: &str, _remember: &str, _o: &mut Out) -> Result<()> {
        bail!("no pending permission request {request_id}")
    }
    /// A steering note for the running turn (see [`Chat::steer`]).
    fn steer(&mut self, _note_id: &str, _text: &str, _now: bool, _atts: &[crate::attach::Attachment], _o: &mut Out) -> Result<()> {
        bail!("steering is not supported")
    }
    fn cancel_steer(&mut self, note_id: &str, _o: &mut Out) -> Result<()> {
        bail!("no queued note {note_id}")
    }
    /// Answers to a `question` request, one list per question, in order.
    fn respond_question(&mut self, request_id: &str, _answers: &[Vec<String>], _o: &mut Out) -> Result<()> {
        bail!("no pending question {request_id}")
    }
    /// The process is gone: settle whatever was in flight.
    fn on_exit(&mut self, o: &mut Out);
}

/// Events kept for replay. Deltas dominate; this is many long turns' worth.
const MAX_EVENTS: usize = 50_000;
/// After `stop()` asks politely (SIGTERM), escalate to SIGKILL after this long.
const KILL_GRACE: Duration = Duration::from_secs(3);
/// Tool output kept per `tool_end`.
pub(crate) const MAX_OUTPUT: usize = 4096;

pub(crate) struct Shared {
    backend: Box<dyn Backend>,
    /// Which start of the CLI owns this chat now: bumped by a restart, so the threads and the [`Chat`] of an earlier
    /// process (and its Drop) leave the new one alone.
    epoch: u64,
    events: VecDeque<ChatEvent>,
    next_seq: u64,
    /// What the UI was told (the backend's state, or `waiting_permission` while an outside request is pending).
    state: ChatState,
    /// The state the CLI's backend last reported.
    backend_state: ChatState,
    /// Permission requests of coool's own (see [`ChatHandle::ask`]), waiting for the person.
    external: Vec<External>,
    session_id: Option<String>,
    model: String,
    permission_mode: String,
    running: bool,
    stderr_tail: VecDeque<String>,
    /// `COOOL_CHAT_TRACE=<file>`: protocol trace in the fixture format.
    trace: Option<std::fs::File>,
    /// The backend reported `open_failed` with the CLI's error: the exit's stderr tail would only repeat it.
    open_failed: bool,
}

impl Shared {
    fn effective_state(&self) -> ChatState {
        if self.external.is_empty() { self.backend_state } else { ChatState::WaitingPermission }
    }

    /// Re-announces the state after an outside request came or went.
    fn refresh_state(&mut self) {
        let eff = self.effective_state();
        if eff != self.state {
            self.state = eff;
            self.next_seq += 1;
            self.events.push_back(ChatEvent { seq: self.next_seq, ts: now_ms(), kind: ChatEventKind::State { state: eff } });
        }
    }

    fn take_external(&mut self, request_id: &str) -> Option<External> {
        let i = self.external.iter().position(|x| x.id == request_id)?;
        Some(self.external.remove(i))
    }

    fn trace(&mut self, dir: &str, v: Value) {
        if let Some(f) = self.trace.as_mut() {
            let rec = json!({"t": now_ms(), "dir": dir, "line": v});
            let _ = writeln!(f, "{rec}");
        }
    }

    /// A hosted chat's mirror (see [`host`]): an event exactly as the host numbered it. Older or repeated ones are
    /// dropped, so a replay that overlaps what arrived live adds nothing twice.
    fn push_mirror(&mut self, e: ChatEvent) {
        if e.seq <= self.next_seq {
            return;
        }
        match &e.kind {
            ChatEventKind::State { state } => {
                self.backend_state = *state;
                self.state = *state;
            }
            ChatEventKind::OpenFailed { error, .. } => self.open_failed = !error.is_empty(),
            ChatEventKind::Ready { session_id, model, permission_mode, .. } => {
                if !session_id.is_empty() {
                    self.session_id = Some(session_id.clone());
                }
                self.model = model.clone();
                self.permission_mode = permission_mode.clone();
            }
            ChatEventKind::Exited { .. } => self.running = false,
            ChatEventKind::Restarted => self.running = true,
            _ => {}
        }
        self.next_seq = e.seq;
        self.events.push_back(e);
        if self.events.len() > MAX_EVENTS {
            self.events.pop_front();
        }
    }

    fn push(&mut self, mut kind: ChatEventKind) {
        match &mut kind {
            ChatEventKind::State { state } => {
                self.backend_state = *state;
                // The turn ended (or the CLI exited) while coool's own request waited: nobody can use the answer.
                if *state == ChatState::Idle && !self.external.is_empty() {
                    for x in self.external.drain(..) {
                        let _ = x.tx.send(ExternalAnswer::Cancelled("the turn ended before the person answered".into()));
                    }
                }
                let eff = self.effective_state();
                if eff == self.state {
                    return;
                }
                self.state = eff;
                *state = eff;
            }
            ChatEventKind::OpenFailed { error, .. } => self.open_failed = !error.is_empty(),
            ChatEventKind::Ready { session_id, model, permission_mode, .. } => {
                if !session_id.is_empty() {
                    self.session_id = Some(session_id.clone());
                }
                self.model = model.clone();
                self.permission_mode = permission_mode.clone();
            }
            _ => {}
        }
        self.next_seq += 1;
        self.events.push_back(ChatEvent { seq: self.next_seq, ts: now_ms(), kind });
        if self.events.len() > MAX_EVENTS {
            self.events.pop_front();
        }
    }
}

enum WriterMsg {
    Line(String),
    Close,
}

/// The backend of a hosted chat's mirror: never driven (the host runs the real one; calls go there).
struct MirrorBackend;

impl Backend for MirrorBackend {
    fn start(&mut self, _o: &mut Out) {}
    fn on_line(&mut self, _line: &str, _o: &mut Out) {}
    fn send(&mut self, _text: &str, _atts: &[crate::attach::Attachment], _o: &mut Out) -> Result<()> {
        bail!("a hosted chat's calls go to its host")
    }
    fn interrupt(&mut self, _o: &mut Out) -> Result<()> {
        bail!("a hosted chat's calls go to its host")
    }
    fn set_model(&mut self, _model: &str, _o: &mut Out) -> Result<()> {
        bail!("a hosted chat's calls go to its host")
    }
    fn set_permission_mode(&mut self, _mode: &str, _o: &mut Out) -> Result<()> {
        bail!("a hosted chat's calls go to its host")
    }
    fn respond_permission(&mut self, _request_id: &str, _allow: bool, _always: bool, _o: &mut Out) -> Result<()> {
        bail!("a hosted chat's calls go to its host")
    }
    fn on_exit(&mut self, _o: &mut Out) {}
}

impl Shared {
    /// The app's copy of a hosted chat, starting from what the host last said of it.
    fn mirror(info: &ChatInfo) -> Self {
        Shared {
            backend: Box::new(MirrorBackend),
            epoch: 0,
            events: VecDeque::new(),
            next_seq: 0,
            state: info.state,
            backend_state: info.state,
            external: Vec::new(),
            session_id: info.session_id.clone(),
            model: info.model.clone(),
            permission_mode: info.permission_mode.clone(),
            running: info.running,
            stderr_tail: VecDeque::new(),
            trace: None,
            open_failed: false,
        }
    }
}

fn lock(m: &Mutex<Shared>) -> MutexGuard<'_, Shared> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Applies a backend's output: queue its writes, record its events.
fn apply(sh: &mut Shared, writer: &Sender<WriterMsg>, o: Out) {
    for w in o.writes {
        if sh.trace.is_some() {
            sh.trace("in", Value::String(w.clone()));
        }
        let _ = writer.send(WriterMsg::Line(w));
    }
    if o.close {
        let _ = writer.send(WriterMsg::Close);
    }
    for e in o.events {
        sh.push(e);
    }
}

/// A cheap, cloneable read handle on a chat's events, usable without holding
/// the [`crate::hub::Hub`] (e.g. from a UI's event pump while a refresh runs).
#[derive(Clone)]
pub struct ChatHandle {
    pub id: usize,
    shared: Arc<Mutex<Shared>>,
    /// A hosted chat: its host and key there (coool's own requests and notes go through the host).
    hosted: Option<(Arc<host::Client>, String)>,
}

impl ChatHandle {
    /// Same as [`Chat::events_since`].
    pub fn events_since(&self, seq: u64) -> (Vec<ChatEvent>, u64) {
        events_since(&self.shared, seq)
    }

    pub fn is_running(&self) -> bool {
        lock(&self.shared).running
    }

    /// The seq of the latest event.
    pub fn last_seq(&self) -> u64 {
        lock(&self.shared).next_seq
    }

    /// The chat's permission mode as the CLI last reported it (`ready.permission_mode`): Claude's mode, Codex's
    /// approval policy. Empty until the CLI said.
    pub fn permission_mode(&self) -> String {
        lock(&self.shared).permission_mode.clone()
    }

    /// A permission request of coool's own (not the CLI's): shown exactly like one from the CLI
    /// (`permission_request`, the chat `waiting_permission`, "Needs you"), and answered through
    /// [`Chat::respond_permission`] / [`Chat::respond_permission_remember`] with the id this returns. The answer
    /// arrives on the receiver; the request is cancelled when the turn ends first. None when the chat has ended.
    pub fn ask(&self, tool: &str, summary: &str, input: Value, remember: Vec<RememberOption>) -> Option<(String, mpsc::Receiver<ExternalAnswer>)> {
        if let Some((c, key)) = &self.hosted {
            return c.ask(key, tool, summary, input, remember);
        }
        let mut sh = lock(&self.shared);
        if !sh.running {
            return None;
        }
        let id = format!("coool-{}", uuid_v4());
        let (tx, rx) = mpsc::channel();
        sh.external.push(External { id: id.clone(), tx, remember: remember.clone() });
        sh.push(ChatEventKind::PermissionRequest { request_id: id.clone(), tool: tool.into(), summary: summary.into(), input, remember });
        sh.refresh_state();
        Some((id, rx))
    }

    /// An info line from coool itself in the chat's timeline, e.g. "Allowed from Ada's iPhone" (coool Remote).
    pub fn note(&self, text: &str) {
        if let Some((c, key)) = &self.hosted {
            let _ = c.call(key, &host::Call::Note { text: text.into() });
            return;
        }
        lock(&self.shared).push(ChatEventKind::notice(NoticeLevel::Info, text));
    }

    /// Takes back a request from [`Self::ask`] nobody answered (it timed out), with a note in the chat.
    pub fn withdraw(&self, request_id: &str, note: &str) {
        if let Some((c, key)) = &self.hosted {
            let _ = c.call(key, &host::Call::Withdraw { request_id: request_id.into(), note: note.into() });
            return;
        }
        let mut sh = lock(&self.shared);
        if sh.take_external(request_id).is_some() {
            if !note.is_empty() {
                sh.push(ChatEventKind::notice(NoticeLevel::Info, note));
            }
            sh.refresh_state();
        }
    }
}

/// The person's answer to a request from [`ChatHandle::ask`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExternalAnswer {
    Allow,
    /// Allow, and apply the request's remember option with this id.
    Remember(String),
    Deny,
    /// Nobody can answer any more (the turn ended, the chat exited): why.
    Cancelled(String),
}

struct External {
    id: String,
    tx: mpsc::Sender<ExternalAnswer>,
    remember: Vec<RememberOption>,
}

/// Answers coool's own request `request_id` if it is one: Some(result), else None (the CLI's).
fn answer_external(shared: &Mutex<Shared>, request_id: &str, answer: impl FnOnce(&[RememberOption]) -> Result<ExternalAnswer>) -> Option<Result<()>> {
    let mut sh = lock(shared);
    let i = sh.external.iter().position(|x| x.id == request_id)?;
    let a = match answer(&sh.external[i].remember) {
        Ok(a) => a,
        Err(e) => return Some(Err(e)),
    };
    let x = sh.external.remove(i);
    let _ = x.tx.send(a);
    sh.refresh_state();
    Some(Ok(()))
}

/// After a restart's `stop()`: waits for the chat's CLI to exit, up to the kill grace, then `kill` (SIGKILL) and a
/// little longer. Err if it is still running.
pub(crate) fn wait_exit(h: &ChatHandle, kill: impl FnOnce()) -> Result<()> {
    let gone_within = |d: Duration| {
        let t = Instant::now();
        while h.is_running() && t.elapsed() < d {
            thread::sleep(Duration::from_millis(20));
        }
        !h.is_running()
    };
    if gone_within(KILL_GRACE + Duration::from_millis(500)) {
        return Ok(());
    }
    kill();
    if gone_within(Duration::from_secs(3)) {
        return Ok(());
    }
    bail!("the CLI didn't stop")
}

fn events_since(shared: &Mutex<Shared>, seq: u64) -> (Vec<ChatEvent>, u64) {
    let sh = lock(shared);
    // Events are in seq order: skip the old ones without cloning them.
    let start = sh.events.partition_point(|e| e.seq <= seq);
    let evs: Vec<ChatEvent> = sh.events.range(start..).cloned().collect();
    (evs, sh.next_seq.max(seq))
}

/// The coool context for a chat about to launch (None: off). `devices`: the chat gets the `coool-device` server.
fn context_text(opts: &ChatOptions, cli: crate::ladder::Cli, devices: bool) -> Option<String> {
    let c = opts.context.clone()?;
    let c = if devices { c } else { c.without_devices() };
    let helpers = opts.ladder.as_ref().is_some_and(|l| !l.solo());
    Some(crate::agent_context::text(cli, &c, helpers))
}

/// Where a chat's CLI runs: a child of this process, or of the chat host (see [`host`]).
enum Link {
    Proc(Sender<WriterMsg>),
    Host(Arc<host::Client>, String),
}

pub struct Chat {
    pub id: usize,
    pub provider: Provider,
    pub cwd: String,
    pub pid: Option<u32>,
    pub started: SystemTime,
    shared: Arc<Mutex<Shared>>,
    link: Link,
    kill_requested: Option<Instant>,
    /// The arguments the CLI was launched with (the self-test checks Ladder's flags against them).
    args: Vec<String>,
    launch: crate::chatctx::Launch,
    /// The start of the CLI this is (see [`Shared::epoch`]).
    epoch: u64,
    /// What a restart starts the CLI with again: the options it was started with (model and mode as switched since)
    /// and its MCP servers. None for a chat spawned directly (tests).
    opts: Option<ChatOptions>,
    mcp: Vec<McpServer>,
    /// Codex: a sandbox mode switched to since the start (the options hold one mode, the approval policy).
    sandbox: Option<String>,
}

impl Chat {
    /// `client_name`: how coool introduces itself to `codex app-server` (see [`crate::origin`]).
    /// `ladder_root`: where coool keeps its Claude Code plugin for Ladder (see [`crate::ladder`]).
    pub(crate) fn start(id: usize, opts: ChatOptions, client_name: &str, mcp: &[McpServer], ladder_root: Option<&std::path::Path>) -> Result<Self> {
        Self::start_into(id, opts, client_name, mcp, ladder_root, None)
    }

    /// [`Self::start`]; with `reuse`, the CLI starts again in that chat (a restart, see [`Self::restart_options`]):
    /// its events, numbering and readers carry on. The earlier process must have exited.
    pub(crate) fn start_into(id: usize, opts: ChatOptions, client_name: &str, mcp: &[McpServer], ladder_root: Option<&std::path::Path>, reuse: Option<&ChatHandle>) -> Result<Self> {
        // MCP servers never ride on the command line (their env holds the chat's device token, and `ps` shows any
        // process's arguments to this user): Claude Code reads them from a private file, removed as soon as the CLI
        // has started (its first output) or exited; Codex gets the env values in its own environment.
        let mcp_file = match opts.provider {
            Provider::Claude if !mcp.is_empty() => {
                let p = claude::mcp_config_path(id)?;
                claude::write_mcp_config(&p, mcp)?;
                Some(p)
            }
            _ => None,
        };
        let mut env = if opts.provider == Provider::Codex { codex::mcp_env(mcp) } else { Vec::new() };
        if opts.provider == Provider::Claude
            && let Some(l) = &opts.ladder
        {
            env.extend(crate::ladder::claude_env(l));
        }
        // Claude Platform: the key, read from the Keychain now, rides in the CLI's environment only (never argv, a
        // file, or the host's socket); spawn_into removes the other logins.
        if opts.provider == Provider::Claude
            && let Some(a) = &opts.account
        {
            match crate::platform::env_for(a) {
                Ok(e) => env.extend(e),
                Err(e) => {
                    if let Some(p) = &mcp_file {
                        let _ = std::fs::remove_file(p);
                    }
                    return Err(e);
                }
            }
        }
        let (backend, program, args) = Self::launch(&opts, client_name, mcp, ladder_root, mcp_file.as_deref());
        let r = Self::spawn_into(id, opts.provider, &opts.cwd, program, &args, &env, mcp_file.clone(), backend, reuse);
        if r.is_err()
            && let Some(p) = &mcp_file
        {
            let _ = std::fs::remove_file(p);
        }
        r.map(|mut c| {
            c.launch = Self::launch_record(&opts, &args, mcp, ladder_root);
            c.opts = Some(opts);
            c.mcp = mcp.to_vec();
            c
        })
    }

    /// What the Context panel shows coool added (crate::chatctx): the arguments as passed, what coool adds to Codex's
    /// developer instructions, and the MCP servers (names only: their env carries the chat's token).
    pub(crate) fn launch_record(opts: &ChatOptions, args: &[String], mcp: &[McpServer], ladder_root: Option<&std::path::Path>) -> crate::chatctx::Launch {
        crate::chatctx::Launch {
            args: args.to_vec(),
            // What `Codex::instructions` sends: Ladder's policy, then the coool context.
            developer_instructions: if opts.provider == Provider::Codex {
                crate::agent_context::join_prompts(codex::coool_instructions(opts, ladder_root).as_deref(), context_text(opts, crate::ladder::Cli::Codex, !mcp.is_empty()).as_deref())
            } else {
                None
            },
            mcp: mcp.iter().map(|m| crate::chatctx::McpInfo { name: m.name.clone(), ..Default::default() }).collect(),
            model: opts.model.clone(),
        }
    }

    /// What coool launched this chat with (see [`Self::launch_record`]).
    pub fn launch_info(&self) -> &crate::chatctx::Launch {
        &self.launch
    }

    /// The backend, program and arguments a chat starts with (unit-tested: nothing runs). `mcp_file`: where Claude
    /// Code's MCP config is written (see [`Self::start`]).
    pub(crate) fn launch(opts: &ChatOptions, client_name: &str, mcp: &[McpServer], ladder_root: Option<&std::path::Path>, mcp_file: Option<&std::path::Path>) -> (Box<dyn Backend>, &'static str, Vec<String>) {
        match opts.provider {
            Provider::Claude => {
                let b = claude::Claude::new(opts);
                let mut args = b.args();
                if let Some(f) = mcp_file {
                    args.extend(claude::mcp_args(mcp, f));
                }
                let mut ladder = opts.ladder.as_ref().map(|l| crate::ladder::claude_args(l, std::path::Path::new(&opts.cwd), ladder_root)).unwrap_or_default();
                // Ladder's policy and the coool context share the one `--append-system-prompt` the CLI keeps.
                const APPEND: &str = "--append-system-prompt=";
                let policy = ladder.iter().position(|a| a.starts_with(APPEND)).map(|i| ladder.remove(i)[APPEND.len()..].to_string());
                let context = context_text(opts, crate::ladder::Cli::Claude, !mcp.is_empty());
                if let Some(p) = crate::agent_context::join_prompts(policy.as_deref(), context.as_deref()) {
                    args.push(format!("{APPEND}{p}"));
                }
                args.extend(ladder);
                (Box::new(b), "claude", args)
            }
            Provider::Codex => {
                let mut b = codex::Codex::new(opts);
                b.client_name = client_name.to_string();
                // The policy points at the playbook file under coool's plugin root.
                b.ladder = codex::coool_instructions(opts, ladder_root);
                b.context = context_text(opts, crate::ladder::Cli::Codex, !mcp.is_empty());
                let mut args = codex::args();
                args.extend(codex::mcp_args(mcp));
                if let Some(l) = &opts.ladder {
                    args.extend(crate::ladder::codex_args(l));
                }
                (Box::new(b), "codex", args)
            }
        }
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    fn spawn(id: usize, provider: Provider, cwd: &str, program: &str, args: &[String], env: &[(String, String)], mcp_file: Option<std::path::PathBuf>, backend: Box<dyn Backend>) -> Result<Self> {
        Self::spawn_into(id, provider, cwd, program, args, env, mcp_file, backend, None)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn spawn_into(id: usize, provider: Provider, cwd: &str, program: &str, args: &[String], env: &[(String, String)], mcp_file: Option<std::path::PathBuf>, backend: Box<dyn Backend>, reuse: Option<&ChatHandle>) -> Result<Self> {
        if !std::path::Path::new(cwd).is_dir() {
            bail!("folder does not exist: {cwd}");
        }
        let mut cmd = Command::new(program);
        cmd.args(args).envs(env.iter().map(|(k, v)| (k, v))).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // An API-key chat (Claude Platform): nothing else may decide where its bill goes.
        if env.iter().any(|(k, _)| k == crate::platform::KEY_ENV) {
            for v in crate::platform::OTHER_AUTH {
                cmd.env_remove(v);
            }
        }
        // Own process group, so stop() reaches the tools it spawned too.
        cmd.process_group(0);
        let mut child = cmd.spawn().with_context(|| format!("spawn `{program}` (is it installed and on PATH?)"))?;
        let pid = Some(child.id());
        let stdin = child.stdin.take().context("stdin")?;
        let stdout = child.stdout.take().context("stdout")?;
        let stderr = child.stderr.take().context("stderr")?;

        let shared = match reuse {
            Some(h) => {
                let mut sh = lock(&h.shared);
                if sh.running {
                    // Never two CLIs on one chat: the caller waits for the exit first (this one is ended again).
                    drop(sh);
                    let _ = child.kill();
                    let _ = child.wait();
                    bail!("the chat's CLI is still running");
                }
                sh.epoch += 1;
                sh.backend = backend;
                sh.running = true;
                sh.open_failed = false;
                sh.stderr_tail.clear();
                for x in sh.external.drain(..) {
                    let _ = x.tx.send(ExternalAnswer::Cancelled("the chat was restarted".into()));
                }
                sh.push(ChatEventKind::Restarted);
                let name = if provider == Provider::Claude { "Claude Code" } else { "Codex" };
                sh.push(ChatEventKind::notice(NoticeLevel::Info, format!("Restarted {name} on this conversation: it read its settings, MCP servers and instructions again.")));
                drop(sh);
                h.shared.clone()
            }
            None => Arc::new(Mutex::new(Shared {
            backend,
            epoch: 0,
            events: VecDeque::new(),
            next_seq: 0,
            state: ChatState::Idle,
            backend_state: ChatState::Idle,
            external: Vec::new(),
            session_id: None,
            model: String::new(),
            permission_mode: String::new(),
            running: true,
            stderr_tail: VecDeque::new(),
            trace: std::env::var_os("COOOL_CHAT_TRACE").and_then(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).ok()),
            open_failed: false,
        })),
        };
        let epoch = lock(&shared).epoch;
        let (writer, rx) = mpsc::channel::<WriterMsg>();

        // Writer: the caller never blocks on a child that is not reading.
        thread::spawn(move || {
            let mut stdin = stdin;
            for m in rx {
                match m {
                    WriterMsg::Line(mut l) => {
                        l.push('\n');
                        if stdin.write_all(l.as_bytes()).and_then(|_| stdin.flush()).is_err() {
                            break;
                        }
                    }
                    WriterMsg::Close => break,
                }
            }
        });

        let (eof_tx, eof_rx) = mpsc::channel::<()>();
        {
            let shared = shared.clone();
            let writer = writer.clone();
            // The CLI has read its MCP config by the time it says anything: the file goes then (and at exit, below,
            // if it never does), so it doesn't outlive the chat when coool itself quits.
            let mut config = mcp_file.clone();
            thread::spawn(move || {
                let mut r = BufReader::new(stdout);
                let mut buf = Vec::new();
                loop {
                    buf.clear();
                    match r.read_until(b'\n', &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            if let Some(p) = config.take() {
                                let _ = std::fs::remove_file(p);
                            }
                            let line = String::from_utf8_lossy(&buf);
                            let line = line.trim();
                            if line.is_empty() {
                                continue;
                            }
                            let mut sh = lock(&shared);
                            if sh.epoch != epoch {
                                // A restart took over (this process outlived its exit wait): its output is nobody's.
                                break;
                            }
                            if sh.trace.is_some() {
                                sh.trace("out", Value::String(line.to_string()));
                            }
                            let mut o = Out::default();
                            sh.backend.on_line(line, &mut o);
                            apply(&mut sh, &writer, o);
                        }
                    }
                }
                let _ = eof_tx.send(());
            });
        }
        {
            let shared = shared.clone();
            thread::spawn(move || {
                let mut r = BufReader::new(stderr);
                let mut buf = Vec::new();
                loop {
                    buf.clear();
                    match r.read_until(b'\n', &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let l = strip_ansi(String::from_utf8_lossy(&buf).trim());
                            if l.is_empty() {
                                continue;
                            }
                            let mut sh = lock(&shared);
                            if sh.epoch != epoch {
                                break;
                            }
                            sh.stderr_tail.push_back(crate::util::truncate(&l, 400));
                            if sh.stderr_tail.len() > 12 {
                                sh.stderr_tail.pop_front();
                            }
                        }
                    }
                }
            });
        }
        {
            // Waiter: reaps the child, then reports the exit after the last stdout line.
            let shared = shared.clone();
            let writer = writer.clone();
            thread::spawn(move || {
                let code = child.wait().ok().and_then(|s| s.code());
                if let Some(p) = mcp_file {
                    let _ = std::fs::remove_file(p);
                }
                // Something the CLI spawned may still hold stdout open; don't wait forever.
                let _ = eof_rx.recv_timeout(Duration::from_secs(2));
                let mut sh = lock(&shared);
                if sh.epoch != epoch {
                    return;
                }
                sh.running = false;
                let mut o = Out::default();
                sh.backend.on_exit(&mut o);
                o.writes.clear();
                apply(&mut sh, &writer, o);
                if code != Some(0) && code.is_some() && !sh.open_failed {
                    let tail: Vec<String> = sh.stderr_tail.iter().cloned().collect();
                    let text = if tail.is_empty() { format!("{} exited with code {}", provider.label(), code.unwrap_or(-1)) } else { tail.join("\n") };
                    sh.push(ChatEventKind::notice(NoticeLevel::Error, text));
                }
                sh.push(ChatEventKind::State { state: ChatState::Idle });
                sh.push(ChatEventKind::Exited { code });
            });
        }

        {
            let mut sh = lock(&shared);
            let mut o = Out::default();
            sh.backend.start(&mut o);
            apply(&mut sh, &writer, o);
        }
        Ok(Self {
            id,
            provider,
            cwd: cwd.to_string(),
            pid,
            started: SystemTime::now(),
            shared,
            link: Link::Proc(writer),
            kill_requested: None,
            args: args.to_vec(),
            launch: crate::chatctx::Launch::default(),
            epoch,
            opts: None,
            mcp: Vec::new(),
            sandbox: None,
        })
    }

    /// A chat whose CLI the chat host runs (see [`host`]): its events arrive in a mirror; calls go to the host.
    pub(crate) fn hosted(id: usize, client: Arc<host::Client>, entry: &host::Entry) -> Self {
        let shared = client.mirror(&entry.key, &entry.info);
        let started = SystemTime::UNIX_EPOCH + Duration::from_millis(entry.started_ms);
        Self {
            id,
            provider: entry.opts.provider,
            cwd: entry.opts.cwd.clone(),
            pid: entry.pid,
            started,
            shared,
            link: Link::Host(client, entry.key.clone()),
            kill_requested: None,
            args: entry.args.clone(),
            launch: entry.launch.clone(),
            epoch: 0,
            opts: Some(entry.opts.clone()),
            mcp: entry.mcp.clone(),
            sandbox: None,
        }
    }

    /// Whether the chat host runs this chat's CLI (it then outlives this process).
    pub fn is_hosted(&self) -> bool {
        matches!(self.link, Link::Host(..))
    }

    /// A hosted chat's calls without the hub: a copy that reaches the same host and chat (and shares its events), so
    /// the caller can let go of the hub's lock while the host answers. None for a chat of this process.
    pub fn host_proxy(&self) -> Option<Chat> {
        let Link::Host(c, k) = &self.link else { return None };
        Some(Chat {
            id: self.id,
            provider: self.provider,
            cwd: self.cwd.clone(),
            pid: self.pid,
            started: self.started,
            shared: self.shared.clone(),
            link: Link::Host(c.clone(), k.clone()),
            kill_requested: None,
            args: Vec::new(),
            launch: self.launch.clone(),
            epoch: self.epoch,
            opts: self.opts.clone(),
            mcp: self.mcp.clone(),
            sandbox: self.sandbox.clone(),
        })
    }

    /// The host key of a hosted chat.
    pub fn host_key(&self) -> Option<&str> {
        match &self.link {
            Link::Host(_, k) => Some(k),
            Link::Proc(_) => None,
        }
    }

    /// Keeps a small value with a hosted chat in its host (read back by `list` after a relaunch). No-op otherwise.
    pub fn set_meta(&self, meta: Value) {
        if let Link::Host(c, k) = &self.link {
            let _ = c.set_meta(k, meta);
        }
    }

    /// A hosted chat's call, run by the host: Some(its result); None for a chat of this process.
    fn host_call(&self, call: host::Call) -> Option<Result<Value>> {
        match &self.link {
            Link::Host(c, k) => Some(c.call(k, &call)),
            Link::Proc(_) => None,
        }
    }

    fn with_backend(&mut self, call: Value, f: impl FnOnce(&mut dyn Backend, &mut Out) -> Result<()>) -> Result<()> {
        let Link::Proc(writer) = &self.link else { bail!("a hosted chat's calls go to its host") };
        let mut sh = lock(&self.shared);
        if !sh.running {
            bail!("the chat has ended");
        }
        sh.trace("api", call);
        let mut o = Out::default();
        let r = f(sh.backend.as_mut(), &mut o);
        apply(&mut sh, writer, o);
        r
    }

    /// A prompt, or a slash command typed as text.
    pub fn send(&mut self, text: &str) -> Result<()> {
        self.send_with(text, &[])
    }

    /// A prompt with attachments (images and files; see [`crate::attach`]). Text may be empty when there are some.
    pub fn send_with(&mut self, text: &str, atts: &[crate::attach::Attachment]) -> Result<()> {
        if text.trim().is_empty() && atts.is_empty() {
            bail!("empty message");
        }
        if atts.len() > crate::attach::MAX_COUNT {
            bail!("at most {} attachments per message", crate::attach::MAX_COUNT);
        }
        if let Some(r) = self.host_call(host::Call::Send { text: text.into(), attachments: atts.to_vec() }) {
            return r.map(|_| ());
        }
        let names: Vec<&str> = atts.iter().map(|a| a.name.as_str()).collect();
        self.with_backend(json!({"call": "send", "text": text, "attachments": names}), |b, o| b.send(text, atts, o))
    }

    /// A note for the running turn; returns its id. `now: false`: delivered at
    /// the agent's next step boundary; `now: true`: the current step is
    /// interrupted and the note starts the next turn. A pending permission
    /// request or question holds every note until it is answered (`now` then
    /// acts like `false`). On an idle chat the note is sent as a prompt. Its
    /// fate arrives as [`ChatEventKind::Steer`] events.
    pub fn steer(&mut self, text: &str, now: bool) -> Result<String> {
        self.steer_with(text, now, &[])
    }

    /// A note with attachments: both CLIs take a whole message mid-turn, so the images go in with the note (Claude:
    /// a user line of content blocks; Codex: `turn/steer` with `localImage` inputs) and files as their marker lines.
    pub fn steer_with(&mut self, text: &str, now: bool, atts: &[crate::attach::Attachment]) -> Result<String> {
        if text.trim().is_empty() && atts.is_empty() {
            bail!("empty note");
        }
        if atts.len() > crate::attach::MAX_COUNT {
            bail!("at most {} attachments per message", crate::attach::MAX_COUNT);
        }
        if let Some(r) = self.host_call(host::Call::Steer { text: text.into(), now, attachments: atts.to_vec() }) {
            return r.and_then(|v| v.as_str().map(str::to_string).context("the host gave no note id"));
        }
        let id = uuid_v4();
        let names: Vec<&str> = atts.iter().map(|a| a.name.as_str()).collect();
        self.with_backend(json!({"call": "steer", "note_id": id, "text": text, "now": now, "attachments": names}), |b, o| b.steer(&id, text, now, atts, o))?;
        Ok(id)
    }

    /// Withdraw a note that is still `queued`. Fails once the agent has it
    /// (and, for Codex, once it was handed to the CLI: see CHAT_SPEC).
    pub fn cancel_steer(&mut self, note_id: &str) -> Result<()> {
        if let Some(r) = self.host_call(host::Call::CancelSteer { note_id: note_id.into() }) {
            return r.map(|_| ());
        }
        self.with_backend(json!({"call": "cancel_steer", "note_id": note_id}), |b, o| b.cancel_steer(note_id, o))
    }

    /// Stop the current turn; the chat stays usable.
    pub fn interrupt(&mut self) -> Result<()> {
        if let Some(r) = self.host_call(host::Call::Interrupt) {
            return r.map(|_| ());
        }
        self.with_backend(json!({"call": "interrupt"}), |b, o| b.interrupt(o))
    }

    pub fn set_model(&mut self, model: &str) -> Result<()> {
        let r = match self.host_call(host::Call::SetModel { model: model.into() }) {
            Some(r) => r.map(|_| ()),
            None => self.with_backend(json!({"call": "set_model", "model": model}), |b, o| b.set_model(model, o)),
        };
        if r.is_ok()
            && let Some(o) = self.opts.as_mut()
        {
            o.model = Some(model.to_string());
        }
        r
    }

    pub fn set_permission_mode(&mut self, mode: &str) -> Result<()> {
        let r = match self.host_call(host::Call::SetPermissionMode { mode: mode.into() }) {
            Some(r) => r.map(|_| ()),
            None => self.with_backend(json!({"call": "set_permission_mode", "mode": mode}), |b, o| b.set_permission_mode(mode, o)),
        };
        if r.is_ok() {
            // A restart starts with it (Codex: an approval policy in the options, a sandbox mode beside them).
            if self.provider == Provider::Codex && codex::is_sandbox_mode(mode) {
                self.sandbox = Some(mode.to_string());
            } else if let Some(o) = self.opts.as_mut() {
                o.permission_mode = Some(mode.to_string());
            }
        }
        r
    }

    /// Allow once, deny, or (`always`) allow and apply the request's first
    /// remember option *only if it is for this chat alone*; a rule that would
    /// be saved to a settings file is never applied this way (use
    /// [`Chat::respond_permission_remember`]). With no such option, `always`
    /// allows once.
    pub fn respond_permission(&mut self, request_id: &str, allow: bool, always: bool) -> Result<()> {
        if let Some(r) = self.host_call(host::Call::RespondPermission { request_id: request_id.into(), allow, always }) {
            return r.map(|_| ());
        }
        let ext = answer_external(&self.shared, request_id, |opts| {
            Ok(match (allow, always, opts.first().filter(|o| !o.persistent())) {
                (false, _, _) => ExternalAnswer::Deny,
                (true, true, Some(o)) => ExternalAnswer::Remember(o.id.clone()),
                (true, _, _) => ExternalAnswer::Allow,
            })
        });
        if let Some(r) = ext {
            return r;
        }
        let call = json!({"call": "respond_permission", "request_id": request_id, "allow": allow, "always": always});
        self.with_backend(call, |b, o| b.respond_permission(request_id, allow, always, o))
    }

    /// Allow, and apply the [`RememberOption`] with id `remember` from the
    /// request's `permission_request.remember`.
    pub fn respond_permission_remember(&mut self, request_id: &str, remember: &str) -> Result<()> {
        if let Some(r) = self.host_call(host::Call::RespondPermissionRemember { request_id: request_id.into(), remember: remember.into() }) {
            return r.map(|_| ());
        }
        let ext = answer_external(&self.shared, request_id, |opts| {
            if !opts.iter().any(|o| o.id == remember) {
                bail!("no remember option {remember} for request {request_id}");
            }
            Ok(ExternalAnswer::Remember(remember.to_string()))
        });
        if let Some(r) = ext {
            return r;
        }
        let call = json!({"call": "respond_permission", "request_id": request_id, "allow": true, "remember": remember});
        self.with_backend(call, |b, o| b.respond_permission_remember(request_id, remember, o))
    }

    /// Answer a [`ChatEventKind::Question`]: for each question, in order, the
    /// picked option labels and/or typed text. Decline with `respond_permission(id, false, false)`.
    pub fn respond_question(&mut self, request_id: &str, answers: &[Vec<String>]) -> Result<()> {
        if let Some(r) = self.host_call(host::Call::RespondQuestion { request_id: request_id.into(), answers: answers.to_vec() }) {
            return r.map(|_| ());
        }
        let call = json!({"call": "respond_question", "request_id": request_id, "answers": answers});
        self.with_backend(call, |b, o| b.respond_question(request_id, answers, o))
    }

    /// End the process: close its input and ask it to terminate; the hub
    /// escalates to SIGKILL if it is still around after a grace period.
    pub fn stop(&mut self) {
        if let Some(r) = self.host_call(host::Call::Stop) {
            let _ = r;
            return;
        }
        if let Link::Proc(w) = &self.link {
            let _ = w.send(WriterMsg::Close);
        }
        if !self.is_running() {
            return;
        }
        self.kill_requested.get_or_insert_with(Instant::now);
        self.signal(libc::SIGTERM);
    }

    /// Events with `seq` greater than `seq` (pass 0 for everything still kept),
    /// and the seq to pass next time.
    pub fn events_since(&self, seq: u64) -> (Vec<ChatEvent>, u64) {
        events_since(&self.shared, seq)
    }

    /// A read handle on this chat's events that doesn't borrow the chat.
    pub fn handle(&self) -> ChatHandle {
        let hosted = match &self.link {
            Link::Host(c, k) => Some((c.clone(), k.clone())),
            Link::Proc(_) => None,
        };
        ChatHandle { id: self.id, shared: self.shared.clone(), hosted }
    }

    pub fn info(&self) -> ChatInfo {
        let sh = lock(&self.shared);
        ChatInfo {
            id: self.id,
            provider: self.provider,
            cwd: self.cwd.clone(),
            session_id: sh.session_id.clone(),
            model: sh.model.clone(),
            permission_mode: sh.permission_mode.clone(),
            state: sh.state,
            running: sh.running,
            account: self.opts.as_ref().and_then(|o| o.account.clone()),
        }
    }

    /// This start of the CLI is running (after a restart, an earlier start's [`Chat`] reads false).
    pub fn is_running(&self) -> bool {
        let sh = lock(&self.shared);
        sh.running && sh.epoch == self.epoch
    }

    pub fn state(&self) -> ChatState {
        lock(&self.shared).state
    }

    /// The arguments this chat's CLI was started with.
    pub fn launch_args(&self) -> &[String] {
        &self.args
    }

    pub fn session_id(&self) -> Option<String> {
        lock(&self.shared).session_id.clone()
    }

    /// What a restart starts the CLI with: the options it started with (`base` for a chat spawned without them),
    /// resuming its conversation, with the model and mode as they are now (Claude Code's mode as it last said, which
    /// also covers a switch the agent made itself).
    pub fn restart_options(&self, base: Option<&ChatOptions>) -> Result<ChatOptions> {
        let mut o = self.opts.clone().or_else(|| base.cloned()).context("this chat can't be restarted")?;
        let sh = lock(&self.shared);
        if let Some(sid) = sh.session_id.clone().filter(|s| !s.is_empty()) {
            o.resume = Some(sid);
        }
        if self.provider == Provider::Claude && !sh.permission_mode.is_empty() {
            o.permission_mode = Some(sh.permission_mode.clone());
        }
        Ok(o)
    }

    /// The MCP servers this chat started with (a restart gives them again).
    pub fn mcp_servers(&self) -> &[McpServer] {
        &self.mcp
    }

    /// After a restart into this chat: the mode switches the options can't hold (Codex's sandbox mode) apply again.
    pub(crate) fn carry_over(&mut self, from: &Chat) {
        if let Some(m) = from.sandbox.clone() {
            if self.with_backend(json!({"call": "set_permission_mode", "mode": m}), |b, o| b.set_permission_mode(&m, o)).is_ok() {
                self.sandbox = Some(m);
            }
        }
    }

    /// A hosted chat the host restarted (see [`host::Call::Restart`]): what it now runs.
    pub(crate) fn hosted_restarted(&mut self, e: &host::Entry) {
        self.pid = e.pid;
        self.args = e.args.clone();
        self.launch = e.launch.clone();
        self.opts = Some(e.opts.clone());
        self.started = SystemTime::now();
        self.kill_requested = None;
    }

    /// A hosted chat's restart, run by its host (Some), or None for a chat of this process.
    pub(crate) fn host_restart(&self) -> Option<Result<host::Entry>> {
        self.host_call(host::Call::Restart).map(|r| r.and_then(|v| serde_json::from_value(v).context("the host's answer to restart")))
    }

    fn signal(&self, sig: libc::c_int) {
        // Only while the child is unreaped: afterwards its pid may be reused. A hosted chat's CLI is the host's child.
        if !self.is_running() || self.is_hosted() {
            return;
        }
        if let Some(p) = self.pid.and_then(crate::util::valid_pid) {
            // SAFETY: plain signal delivery to our own child and its process group.
            unsafe {
                libc::killpg(p, sig);
                libc::kill(p, sig);
            }
        }
    }

    /// SIGKILL if a `stop()` has gone unanswered past the grace period.
    pub(crate) fn escalate_kill(&mut self, grace: Option<Duration>) {
        if self.kill_requested.is_some_and(|t| t.elapsed() >= grace.unwrap_or(KILL_GRACE)) {
            self.signal(libc::SIGKILL);
        }
    }
}

impl Drop for Chat {
    /// A dropped chat must not leave its CLI running unattended.
    fn drop(&mut self) {
        // A hosted chat's CLI belongs to the host: dropping the app's view of it leaves it running.
        let Link::Proc(writer) = &self.link else { return };
        if !self.is_running() {
            return;
        }
        let _ = writer.send(WriterMsg::Close);
        self.signal(libc::SIGTERM);
        let shared = self.shared.clone();
        let pid = self.pid.and_then(crate::util::valid_pid);
        let epoch = self.epoch;
        thread::spawn(move || {
            thread::sleep(KILL_GRACE);
            let ours = {
                let sh = lock(&shared);
                sh.running && sh.epoch == epoch
            };
            if ours
                && let Some(p) = pid
            {
                // SAFETY: as in `signal`; still unreaped, so the pid is still ours.
                unsafe {
                    libc::killpg(p, libc::SIGKILL);
                    libc::kill(p, libc::SIGKILL);
                }
            }
        });
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A random UUID v4 (for `claude --session-id`), from the OS RNG.
pub(crate) fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    let ok = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_ok();
    if !ok {
        // Practically unreachable; still unique enough per process.
        let n = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0) ^ (std::process::id() as u128) << 64;
        b = n.to_le_bytes();
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// Drops ANSI escape sequences (Codex logs to stderr with colors).
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' {
            if it.peek() == Some(&'[') {
                it.next();
                for d in it.by_ref() {
                    if d.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Cuts `s` to about `max` bytes on a char boundary, marking the cut.
pub(crate) fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// A steering note until it is settled (both backends).
pub(crate) struct Note {
    pub id: String,
    pub text: String,
    /// Interrupt the current step for it.
    pub now: bool,
    /// Handed to the CLI (it can no longer be held back by coool).
    pub sent: bool,
    /// Sent as the first message of a turn of its own.
    pub own_turn: bool,
    /// The step running when the interrupt for it went out.
    pub cut: Option<String>,
    /// `cancel_steer` asked the CLI to withdraw it.
    pub cancelling: bool,
    /// Its attachments ([`crate::attach`]).
    pub atts: Vec<crate::attach::Attachment>,
    /// With attachments: the whole message as the CLI takes it (Claude's content blocks, Codex's input list), so it
    /// goes in as one message, images included, wherever the note is delivered.
    pub payload: Option<Value>,
}

/// The notes of one chat, in the order they were made.
#[derive(Default)]
pub(crate) struct Notes {
    pub list: Vec<Note>,
}

impl Notes {
    /// A note with attachments and the message the CLI is given for it.
    pub fn add_with(&mut self, id: &str, text: &str, now: bool, atts: Vec<crate::attach::Attachment>, payload: Option<Value>, o: &mut Out) {
        o.ev(ChatEventKind::Steer { note_id: id.into(), text: text.into(), state: SteerState::Queued, tool_id: None, attachments: atts.clone() });
        self.list.push(Note { id: id.into(), text: text.into(), now, sent: false, own_turn: false, cut: None, cancelling: false, atts, payload });
    }

    /// What the CLI is given for note `id`: its payload, or its text.
    pub fn message(&self, id: &str) -> Option<Value> {
        self.list.iter().find(|n| n.id == id).map(|n| n.payload.clone().unwrap_or_else(|| Value::String(n.text.clone())))
    }

    pub fn get(&mut self, id: &str) -> Option<&mut Note> {
        self.list.iter_mut().find(|n| n.id == id)
    }

    /// Ends a note: its final `steer` event, and for a delivered one the
    /// `user_message` echo (`steer: true`). False if there is no such note.
    pub fn settle(&mut self, id: &str, state: SteerState, tool_id: Option<String>, user_n: &mut u64, o: &mut Out) -> bool {
        let Some(i) = self.list.iter().position(|n| n.id == id) else { return false };
        let n = self.list.remove(i);
        o.ev(ChatEventKind::Steer { note_id: n.id.clone(), text: n.text.clone(), state, tool_id, attachments: n.atts.clone() });
        if matches!(state, SteerState::PickedUp | SteerState::Interrupted) {
            *user_n += 1;
            o.ev(ChatEventKind::UserMessage { id: format!("u{user_n}"), text: n.text, steer: true, note_id: Some(n.id), attachments: n.atts });
        }
        true
    }

    /// Every note `which` selects ends `unused`.
    pub fn unused(&mut self, which: impl Fn(&Note) -> bool, o: &mut Out) {
        let ids: Vec<String> = self.list.iter().filter(|n| which(n)).map(|n| n.id.clone()).collect();
        let mut n = 0;
        for id in ids {
            self.settle(&id, SteerState::Unused, None, &mut n, o);
        }
    }
}

/// `/name args` -> ("name", "args").
pub(crate) fn slash_command(text: &str) -> Option<(&str, &str)> {
    let t = text.trim_start();
    let rest = t.strip_prefix('/')?;
    let (name, args) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    (!name.is_empty() && !name.contains('/')).then_some((name, args.trim()))
}

#[cfg(test)]
pub(crate) mod testutil {
    use super::*;

    /// A store with a 1x1 PNG and a text file for the backends' attachment tests; the store is `COOOL_ATTACH_DIR`,
    /// shared by every test of this process. Returns (folder to remove, image, file).
    pub fn attach_fixture(tag: &str) -> (std::path::PathBuf, crate::attach::Attachment, crate::attach::Attachment) {
        static ONCE: std::sync::Once = std::sync::Once::new();
        let store = std::env::temp_dir().join(format!("coool-attach-store-{}", std::process::id()));
        // SAFETY: set once, before any test of this process reads it.
        ONCE.call_once(|| unsafe { std::env::set_var("COOOL_ATTACH_DIR", &store) });
        let d = std::env::temp_dir().join(format!("coool-attach-fix-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let png = d.join("dot.png");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89").unwrap();
        let txt = d.join("notes.txt");
        std::fs::write(&txt, "a line\n").unwrap();
        let img = crate::attach::inspect_path(&store, &png).unwrap();
        let f = crate::attach::inspect_path(&store, &txt).unwrap();
        (d, img, f)
    }

    /// Replays a trace captured from a real run (`COOOL_CHAT_TRACE`): the CLI's
    /// stdout lines (`out`) and the API calls made on the chat (`api`), in order.
    /// Returns every event, and every line the backend wrote.
    pub fn replay_full(b: &mut dyn Backend, fixture: &str) -> (Vec<ChatEventKind>, Vec<String>) {
        let mut o = Out::default();
        b.start(&mut o);
        for l in fixture.lines().filter(|l| !l.trim().is_empty()) {
            let v: Value = serde_json::from_str(l).unwrap();
            let line = &v["line"];
            match v["dir"].as_str() {
                Some("out") => b.on_line(line.as_str().unwrap(), &mut o),
                Some("api") => {
                    let s = |k: &str| line[k].as_str().unwrap_or("").to_string();
                    let r = match line["call"].as_str().unwrap() {
                        "send" => b.send(&s("text"), &[], &mut o),
                        "interrupt" => b.interrupt(&mut o),
                        "set_model" => b.set_model(&s("model"), &mut o),
                        "set_permission_mode" => b.set_permission_mode(&s("mode"), &mut o),
                        "respond_permission" if line["remember"].is_string() => b.respond_permission_remember(&s("request_id"), &s("remember"), &mut o),
                        "respond_permission" => b.respond_permission(&s("request_id"), line["allow"] == true, line["always"] == true, &mut o),
                        "steer" => b.steer(&s("note_id"), &s("text"), line["now"] == true, &[], &mut o),
                        "cancel_steer" => b.cancel_steer(&s("note_id"), &mut o),
                        "respond_question" => {
                            let answers: Vec<Vec<String>> = serde_json::from_value(line["answers"].clone()).unwrap();
                            b.respond_question(&s("request_id"), &answers, &mut o)
                        }
                        c => panic!("unknown call {c}"),
                    };
                    // Withdrawing a note can fail in a real run (too late); every other call must work.
                    if line["call"] != "cancel_steer" {
                        r.unwrap();
                    }
                }
                _ => {}
            }
        }
        (o.events, o.writes)
    }

    pub fn replay(b: &mut dyn Backend, fixture: &str) -> Vec<ChatEventKind> {
        replay_full(b, fixture).0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_json_shape() {
        let e = ChatEvent {
            seq: 3,
            ts: 10,
            kind: ChatEventKind::TextDelta { message_id: "m".into(), text: "hi".into(), parent_tool_id: None },
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v, serde_json::json!({"seq": 3, "ts": 10, "type": "text_delta", "message_id": "m", "text": "hi", "parent_tool_id": null}));
        let e = ChatEvent { seq: 1, ts: 1, kind: ChatEventKind::State { state: ChatState::WaitingPermission } };
        assert_eq!(serde_json::to_value(&e).unwrap()["state"], "waiting_permission");
        let e = ChatEvent { seq: 2, ts: 2, kind: ChatEventKind::Steer { note_id: "n".into(), text: "t".into(), state: SteerState::PickedUp, tool_id: Some("tool".into()), attachments: Vec::new() } };
        assert_eq!(serde_json::to_value(&e).unwrap(), serde_json::json!({"seq": 2, "ts": 2, "type": "steer", "note_id": "n", "text": "t", "state": "picked_up", "tool_id": "tool"}));
        let e = ChatEvent { seq: 3, ts: 3, kind: ChatEventKind::UserMessage { id: "u1".into(), text: "t".into(), steer: false, note_id: None, attachments: Vec::new() } };
        assert_eq!(serde_json::to_value(&e).unwrap(), serde_json::json!({"seq": 3, "ts": 3, "type": "user_message", "id": "u1", "text": "t", "steer": false, "note_id": null}));
        let e = ChatEvent { seq: 1, ts: 1, kind: ChatEventKind::needs_terminal("x") };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!((v["type"].as_str(), v["level"].as_str(), v["needs_terminal"].as_bool()), (Some("notice"), Some("info"), Some(true)));
    }

    #[test]
    fn slash_command_parsing() {
        assert_eq!(slash_command("/model sonnet"), Some(("model", "sonnet")));
        assert_eq!(slash_command("  /compact"), Some(("compact", "")));
        assert_eq!(slash_command("/usr/bin/ls is a path"), None);
        assert_eq!(slash_command("hello"), None);
        assert_eq!(slash_command("/"), None);
    }

    #[test]
    fn uuid_is_v4_shaped() {
        let u = uuid_v4();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
        assert_ne!(u, uuid_v4());
    }

    #[test]
    fn clip_and_ansi() {
        assert_eq!(clip("héllo", 2), "h…");
        assert_eq!(strip_ansi("\x1b[2mtime\x1b[0m \x1b[31mERROR\x1b[0m x"), "time ERROR x");
    }

    fn ladder_opts(provider: Provider, cwd: &str, on: bool) -> ChatOptions {
        use crate::ladder::{Ladder, Role, Tier};
        let tiers = match provider {
            Provider::Claude => vec![Tier { role: Role::Mid, model: "sonnet".into(), label: "Sonnet 4.6".into() }, Tier { role: Role::Small, model: "haiku".into(), label: "Haiku 4.5".into() }],
            Provider::Codex => vec![Tier { role: Role::Small, model: "gpt-5.6-luna".into(), label: "GPT-5.6-Luna".into() }],
        };
        ChatOptions { provider, cwd: cwd.into(), resume: None, model: None, permission_mode: None, ladder: on.then(|| Ladder { tiers, max_parallel: 3, verify_tests: true, ..Default::default() }), context: None, account: None }
    }

    /// Ladder at launch (APP_SPEC "Ladder"): on adds the CLI's own per-launch flags, off adds nothing, and nothing is
    /// written anywhere but coool's plugin root (never the person's CLI folders or the project).
    #[test]
    fn ladder_reaches_the_launch_only_when_on() {
        let tmp = std::env::temp_dir().join(format!("coool-ladder-launch-{}", std::process::id()));
        let root = tmp.join("data");
        let proj = tmp.join("proj");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&proj).unwrap();
        let p = proj.to_str().unwrap();
        let has = |a: &[String], pre: &str| a.iter().any(|x| x.starts_with(pre));

        let (_, prog, off) = Chat::launch(&ladder_opts(Provider::Claude, p, false), "coool", &[], Some(&root), None);
        assert_eq!(prog, "claude");
        assert!(!has(&off, "--append-system-prompt") && !has(&off, "--plugin-dir"));
        assert!(!root.exists(), "off writes nothing");

        let (_, _, on) = Chat::launch(&ladder_opts(Provider::Claude, p, true), "coool", &[], Some(&root), None);
        let policy = on.iter().find(|x| x.starts_with("--append-system-prompt=")).unwrap();
        assert!(policy.contains("  mid Sonnet 4.6 (`sonnet`)") && policy.contains("at most 3 at once"));
        let dir = on.iter().find_map(|x| x.strip_prefix("--plugin-dir=")).unwrap();
        assert!(std::path::Path::new(dir).starts_with(&root));
        // The permission flags are the same with it on: nothing loosened, no bypass turned on.
        let perm = |a: &[String]| a.iter().filter(|x| !x.starts_with("--append-system-prompt=")).filter(|x| x.contains("permission") || x.contains("dangerously") || x.contains("allowedTools")).cloned().collect::<Vec<_>>();
        assert_eq!(perm(&on), perm(&off));
        assert!(!on.iter().any(|x| x == "--dangerously-skip-permissions"));

        let (_, prog, coff) = Chat::launch(&ladder_opts(Provider::Codex, p, false), "coool", &[], Some(&root), None);
        assert_eq!(prog, "codex");
        assert_eq!(coff, vec!["app-server"]);
        let (_, _, con) = Chat::launch(&ladder_opts(Provider::Codex, p, true), "coool", &[], Some(&root), None);
        assert_eq!(con, vec!["app-server", "-c", "agents.max_threads=3", "-c", "agents.max_depth=2", "-c", "agents.default_subagent_model=\"gpt-5.6-luna\""]);
        assert!(!con.iter().any(|x| x.contains("approval") || x.contains("sandbox")));

        // Only the plugin under the given root was written; the project is empty.
        assert_eq!(std::fs::read_dir(&proj).unwrap().count(), 0);
        let files: Vec<_> = walk(&tmp).into_iter().filter(|f| !f.starts_with(&proj)).collect();
        assert!(files.iter().all(|f| f.starts_with(root.join("coool-ladder"))), "{files:?}");
        if let Some(home) = dirs::home_dir() {
            for d in [".claude", ".codex"] {
                for f in walk(&home.join(d).join("plugins")) {
                    assert!(!f.to_string_lossy().contains("coool-ladder"), "{f:?}");
                }
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// The coool context (APP_SPEC "coool context") in every combination: context on/off × Ladder on/off × the device
    /// server present/absent, for both CLIs. Claude: one `--append-system-prompt` (Ladder's policy first). Codex: the
    /// thread's `developerInstructions` after the person's own and Ladder's.
    #[test]
    fn coool_context_reaches_each_cli_only_when_on() {
        use crate::agent_context::AgentContext;
        let tmp = std::env::temp_dir().join(format!("coool-context-launch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let p = tmp.to_str().unwrap();
        let mcp = [McpServer { name: "coool-device".into(), command: "/x/coool".into(), args: vec!["--coool-device-mcp".into()], env: vec![], allow_all: true, tool_timeout_sec: Some(900) }];
        let has = AgentContext { browser: true, iphone: true, mac: false, remote: false };
        for ctx_on in [false, true] {
            for ladder_on in [false, true] {
                for devices in [false, true] {
                    let what = format!("context {ctx_on}, ladder {ladder_on}, devices {devices}");
                    let mut o = ladder_opts(Provider::Claude, p, ladder_on);
                    o.context = ctx_on.then(|| has.clone());
                    let servers: &[McpServer] = if devices { &mcp } else { &[] };
                    let file = std::path::Path::new("/private/coool-mcp/x.json");
                    let (_, _, a) = Chat::launch(&o, "coool", servers, Some(&tmp.join("data")), devices.then_some(file));
                    let prompts: Vec<&String> = a.iter().filter(|x| x.starts_with("--append-system-prompt=")).collect();
                    assert!(prompts.len() <= 1, "{what}: one flag at most: {prompts:?}");
                    let text = prompts.first().map(|s| s.as_str()).unwrap_or("");
                    assert_eq!(text.contains("# coool\n"), ctx_on, "{what}");
                    assert_eq!(text.contains("# Ladder"), ladder_on, "{what}");
                    assert_eq!(text.contains("Browser panel"), ctx_on && devices, "{what}");
                    assert_eq!(text.contains("iPhone simulator"), ctx_on && devices, "{what}");
                    assert!(!text.contains("Sandboxed Mac"), "{what}: no Mac on this one");
                    assert_eq!(text.contains("Jobs panel"), ctx_on && ladder_on, "{what}");
                    if ctx_on && ladder_on {
                        assert!(text.find("# Ladder").unwrap() < text.find("# coool\n").unwrap(), "{what}: policy first");
                    }
                    // Permissions are untouched by either.
                    assert!(!a.iter().any(|x| x == "--dangerously-skip-permissions"), "{what}");

                    let mut o = ladder_opts(Provider::Codex, p, ladder_on);
                    o.context = ctx_on.then(|| has.clone());
                    let (mut b, _, args) = Chat::launch(&o, "coool", servers, None, None);
                    assert!(!args.iter().any(|x| x.contains("# coool\n")), "{what}: never on the command line");
                    let mut out = Out::default();
                    b.start(&mut out);
                    b.on_line(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#, &mut out);
                    let sent = |out: &Out, m: &str| out.writes.iter().filter_map(|w| serde_json::from_str::<Value>(w).ok()).find(|v| v["method"] == m);
                    if let Some(read) = sent(&out, "config/read") {
                        assert!(ctx_on || ladder_on, "{what}: config/read only when coool adds instructions");
                        let id = read["id"].as_u64().unwrap();
                        b.on_line(&format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{{"config":{{"developer_instructions":"Mine."}}}}}}"#), &mut out);
                    } else {
                        assert!(!ctx_on && !ladder_on, "{what}: config/read expected");
                    }
                    let start = sent(&out, "thread/start").unwrap();
                    let di = start["params"]["developerInstructions"].as_str().unwrap_or("");
                    assert_eq!(di.is_empty(), !ctx_on && !ladder_on, "{what}");
                    if !di.is_empty() {
                        assert!(di.starts_with("Mine.\n\n"), "{what}: the person's own first: {di}");
                    }
                    assert_eq!(di.contains("# coool\n"), ctx_on, "{what}");
                    assert_eq!(di.contains("Browser panel"), ctx_on && devices, "{what}");
                    assert_eq!(di.contains("justification"), ctx_on, "{what}");
                    if ctx_on && ladder_on {
                        assert!(di.find("# Ladder").unwrap() < di.find("# coool\n").unwrap(), "{what}");
                    }
                }
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A restart in this process: the options resume the conversation with the mode as the CLI last said, the new CLI
    /// takes over the same chat (events numbered on, `restarted` between the exit and the new start), and the earlier
    /// start's `Chat` (dropped, or stopped again) leaves the new process alone.
    #[test]
    fn a_restart_takes_over_the_same_chat() {
        let o = ChatOptions { model: Some("haiku".into()), permission_mode: Some("default".into()), ..ladder_opts(Provider::Claude, "/tmp", false) };
        let script = "echo line-up-$$; sleep 30";
        let start = |reuse: Option<&ChatHandle>| Chat::spawn_into(4, Provider::Claude, "/tmp", "/bin/sh", &["-c".to_string(), script.to_string()], &[], None, Box::new(claude::Claude::new(&o)), reuse).unwrap();
        let mut a = start(None);
        assert!(a.restart_options(None).is_err(), "no options: can't restart");
        a.opts = Some(o.clone());
        {
            let mut sh = lock(&a.shared);
            sh.session_id = Some("3f0c2d1e-0000-4000-8000-0000000000aa".into());
            sh.permission_mode = "acceptEdits".into();
        }
        a.set_model("sonnet").unwrap(); // a switch since the start: a restart starts with it
        let ro = a.restart_options(None).unwrap();
        assert_eq!((ro.resume.as_deref(), ro.model.as_deref(), ro.permission_mode.as_deref()), (Some("3f0c2d1e-0000-4000-8000-0000000000aa"), Some("sonnet"), Some("acceptEdits")));
        let h = a.handle();
        let wait = |f: &dyn Fn() -> bool| {
            let t = Instant::now();
            while !f() {
                assert!(t.elapsed() < Duration::from_secs(10));
                thread::sleep(Duration::from_millis(10));
            }
        };
        let ups = |h: &ChatHandle| h.events_since(0).0.into_iter().filter_map(|e| if let ChatEventKind::Notice { text, .. } = e.kind { text.starts_with("line-up-").then_some(text) } else { None }).collect::<Vec<_>>();
        wait(&|| ups(&h).len() == 1);
        let p1 = a.pid.unwrap();
        a.stop();
        wait_exit(&h, || a.escalate_kill(Some(Duration::ZERO))).unwrap();
        let b = start(Some(&h));
        let p2 = b.pid.unwrap();
        assert!(b.is_running() && !a.is_running(), "the new start is the running one");
        a.stop(); // the old start's stop reaches nothing
        drop(a);
        wait(&|| ups(&h).len() == 2);
        assert_eq!(ups(&h), [format!("line-up-{p1}"), format!("line-up-{p2}")]);
        thread::sleep(KILL_GRACE + Duration::from_millis(300));
        assert!(b.is_running(), "dropping the earlier start didn't stop the new one");
        let (evs, _) = h.events_since(0);
        assert!(evs.windows(2).all(|w| w[1].seq == w[0].seq + 1), "numbered on");
        let at = |f: fn(&ChatEventKind) -> bool| evs.iter().position(|e| f(&e.kind)).unwrap();
        assert!(at(|k| matches!(k, ChatEventKind::Exited { .. })) < at(|k| matches!(k, ChatEventKind::Restarted)));
        drop(b);
    }

    /// The device server's token never reaches either CLI's command line (`ps` shows it to any process of this user).
    #[test]
    fn device_token_stays_off_the_command_line() {
        let mcp = [McpServer {
            name: "coool-device".into(),
            command: "/Applications/coool.app/Contents/MacOS/coool".into(),
            args: vec!["--coool-device-mcp".into()],
            env: vec![("COOOL_DEVICE_SOCKET".into(), "/tmp/s.sock".into()), ("COOOL_DEVICE_TOKEN".into(), "0123456789abcdef-token".into())],
            allow_all: true,
            tool_timeout_sec: Some(900),
        }];
        let file = std::path::Path::new("/private/coool-mcp/1-2.json");
        let (_, _, a) = Chat::launch(&ladder_opts(Provider::Claude, "/", false), "coool", &mcp, None, Some(file));
        assert!(a.iter().any(|x| x == "--mcp-config=/private/coool-mcp/1-2.json"), "{a:?}");
        let (_, _, b) = Chat::launch(&ladder_opts(Provider::Codex, "/", false), "coool", &mcp, None, None);
        assert!(b.iter().any(|x| x.contains("mcp_servers.coool-device.env_vars=")), "{b:?}");
        for x in a.iter().chain(&b) {
            assert!(!x.contains("0123456789abcdef-token"), "token in argv: {x}");
        }
    }

    /// The env given to a chat reaches its process, and Claude Code's MCP config file goes when the process ends.
    #[test]
    fn chat_env_is_set_and_the_mcp_file_goes_with_the_process() {
        struct Nop;
        impl Backend for Nop {
            fn start(&mut self, _: &mut Out) {}
            fn on_line(&mut self, _: &str, _: &mut Out) {}
            fn send(&mut self, _: &str, _: &[crate::attach::Attachment], _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn interrupt(&mut self, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn set_model(&mut self, _: &str, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn set_permission_mode(&mut self, _: &str, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn respond_permission(&mut self, _: &str, _: bool, _: bool, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn on_exit(&mut self, _: &mut Out) {}
        }
        let dir = std::env::temp_dir().join(format!("coool-mcp-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("cfg.json");
        std::fs::write(&file, "{}").unwrap();
        let out = dir.join("env.txt");
        let script = format!("printf %s \"$COOOL_DEVICE_TOKEN\" > '{}'", out.display());
        let env = [("COOOL_DEVICE_TOKEN".to_string(), "tok-1".to_string())];
        let c = Chat::spawn(9, Provider::Codex, "/", "/bin/sh", &["-c".into(), script], &env, Some(file.clone()), Box::new(Nop)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while (c.is_running() || file.exists()) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!file.exists(), "the MCP config outlived the process");
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "tok-1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn walk(d: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut out = Vec::new();
        let Ok(rd) = std::fs::read_dir(d) else { return out };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() && !p.is_symlink() {
                if out.len() < 20_000 {
                    out.extend(walk(&p));
                }
            } else {
                out.push(p);
            }
        }
        out
    }

    #[test]
    fn missing_folder_is_an_error_not_a_spawn() {
        let opts = ChatOptions { provider: Provider::Claude, cwd: "/definitely/not/here".into(), resume: None, model: None, permission_mode: None, ladder: None, context: None, account: None };
        assert!(Chat::start(0, opts, "coool", &[], None).is_err());
    }

    /// A stand-in CLI (`/bin/sh` echoing stdin back) exercises the process
    /// plumbing without the real CLIs: writes reach stdin, lines come back
    /// through the backend, and exit is reported last.
    #[test]
    fn process_plumbing_with_a_fake_cli() {
        struct Echo;
        impl Backend for Echo {
            fn start(&mut self, o: &mut Out) {
                o.write(&serde_json::json!({"hello": 1}));
            }
            fn on_line(&mut self, line: &str, o: &mut Out) {
                o.ev(ChatEventKind::notice(NoticeLevel::Info, line));
            }
            fn send(&mut self, text: &str, _: &[crate::attach::Attachment], o: &mut Out) -> Result<()> {
                o.write(&Value::String(text.into()));
                Ok(())
            }
            fn interrupt(&mut self, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn set_model(&mut self, _: &str, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn set_permission_mode(&mut self, _: &str, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn respond_permission(&mut self, _: &str, _: bool, _: bool, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn on_exit(&mut self, _: &mut Out) {}
        }
        // `head -n 2` exits after two lines, like a CLI ending on its own.
        let mut c = Chat::spawn(7, Provider::Claude, "/", "/bin/sh", &["-c".into(), "head -n 2".into()], &[], None, Box::new(Echo)).unwrap();
        c.send("second").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while c.is_running() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!c.is_running());
        let (evs, seq) = c.events_since(0);
        let texts: Vec<String> = evs.iter().map(|e| serde_json::to_value(e).unwrap()["text"].as_str().unwrap_or("").to_string()).collect();
        assert_eq!(texts[..2], [r#"{"hello":1}"#.to_string(), r#""second""#.to_string()]);
        assert!(matches!(evs.last().unwrap().kind, ChatEventKind::Exited { code: Some(0) }));
        assert_eq!(seq, evs.last().unwrap().seq);
        assert!(c.events_since(seq).0.is_empty());
        let h = c.handle();
        assert_eq!(h.events_since(1).0.len(), evs.len() - 1);
        assert_eq!(h.events_since(1).0[0].seq, 2);
        assert!(!h.is_running());
        assert!(c.send("late").is_err());
        assert_eq!(c.info().id, 7);
    }

    /// Claude Platform: a CLI spawned with the key in its environment gets no other login (an OAuth token in coool's
    /// own environment, a Bedrock switch, ...), and the key isn't on its command line. The fake CLI reports only
    /// booleans and the last four characters.
    #[test]
    fn an_api_key_chat_gets_the_key_and_no_other_login() {
        struct Lines;
        impl Backend for Lines {
            fn start(&mut self, _: &mut Out) {}
            fn on_line(&mut self, line: &str, o: &mut Out) {
                o.ev(ChatEventKind::notice(NoticeLevel::Info, line));
            }
            fn send(&mut self, _: &str, _: &[crate::attach::Attachment], _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn interrupt(&mut self, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn set_model(&mut self, _: &str, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn set_permission_mode(&mut self, _: &str, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn respond_permission(&mut self, _: &str, _: bool, _: bool, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn on_exit(&mut self, _: &mut Out) {}
        }
        let script = r#"k="${ANTHROPIC_API_KEY:-}"; echo "key=${k#"${k%????}"} oauth=${CLAUDE_CODE_OAUTH_TOKEN:+set} token=${ANTHROPIC_AUTH_TOKEN:+set} bedrock=${CLAUDE_CODE_USE_BEDROCK:+set} other=${OTHER_VAR:-}""#;
        let run = |env: Vec<(String, String)>| {
            let c = Chat::spawn(11, Provider::Claude, "/", "/bin/sh", &["-c".into(), script.into()], &env, None, Box::new(Lines)).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while c.is_running() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(20));
            }
            let (evs, _) = c.events_since(0);
            assert!(!c.launch_args().iter().any(|a| a.contains("sk-ant")));
            evs.iter().find_map(|e| if let ChatEventKind::Notice { text, .. } = &e.kind { text.starts_with("key=").then(|| text.clone()) } else { None }).unwrap()
        };
        let others = || vec![("CLAUDE_CODE_OAUTH_TOKEN".to_string(), "oauth-x".to_string()), ("ANTHROPIC_AUTH_TOKEN".into(), "t".into()), ("CLAUDE_CODE_USE_BEDROCK".into(), "1".into()), ("OTHER_VAR".into(), "kept".into())];
        let mut with_key = others();
        with_key.push((crate::platform::KEY_ENV.into(), "sk-ant-api03-TESTTESTTEST".into()));
        assert_eq!(run(with_key), "key=TEST oauth= token= bedrock= other=kept");
        assert_eq!(run(others()), "key= oauth=set token=set bedrock=set other=kept", "a subscription chat's environment is left alone");
    }

    /// An API-key chat whose key is gone doesn't start (and says so without any key in the error).
    #[test]
    fn a_chat_on_a_missing_key_does_not_start() {
        if std::env::var_os("COOOL_PLATFORM_TEST_KEY").is_some() {
            return;
        }
        let opts = ChatOptions { provider: Provider::Claude, cwd: "/tmp".into(), resume: None, model: None, permission_mode: None, ladder: None, context: None, account: Some("doesnotexist000".into()) };
        let e = Chat::start(0, opts, "coool", &[], None).err().expect("no key, no start");
        assert!(format!("{e:#}").contains("Keychain"), "{e:#}");
    }

    /// coool's own permission requests (the device gate's): shown like the CLI's, answered through the same calls,
    /// the chat `waiting_permission` meanwhile even while the backend reports `working`, cancelled when the turn ends.
    #[test]
    fn outside_requests_wait_for_the_person_and_end_with_the_turn() {
        struct Nop;
        impl Backend for Nop {
            fn start(&mut self, _: &mut Out) {}
            fn on_line(&mut self, line: &str, o: &mut Out) {
                let state = if line.trim_matches('"') == "idle" { ChatState::Idle } else { ChatState::Working };
                o.ev(ChatEventKind::State { state });
            }
            fn send(&mut self, t: &str, _: &[crate::attach::Attachment], o: &mut Out) -> Result<()> {
                o.write(&Value::String(t.into()));
                Ok(())
            }
            fn interrupt(&mut self, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn set_model(&mut self, _: &str, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn set_permission_mode(&mut self, _: &str, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn respond_permission(&mut self, _: &str, _: bool, _: bool, _: &mut Out) -> Result<()> {
                bail!("not the backend's")
            }
            fn on_exit(&mut self, _: &mut Out) {}
        }
        // `cat` echoes each written line back: "working" / "idle" drive the backend's state.
        let mut c = Chat::spawn(3, Provider::Claude, "/", "/bin/cat", &[], &[], None, Box::new(Nop)).unwrap();
        let wait_state = |c: &Chat, s: ChatState| {
            let deadline = Instant::now() + Duration::from_secs(5);
            while c.state() != s && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(c.state(), s);
        };
        c.send("working").unwrap();
        wait_state(&c, ChatState::Working);
        let h = c.handle();
        let chat_opt = RememberOption { id: "chat".into(), label: "Allow in this chat".into(), detail: String::new(), scope: RememberScope::Chat, file: None, mode: None, rules: vec![] };
        let (id, rx) = h.ask("Browser", "open example.com", json!({"x": 1}), vec![chat_opt]).unwrap();
        assert_eq!(c.state(), ChatState::WaitingPermission);
        let (evs, _) = c.events_since(0);
        assert!(evs.iter().any(|e| matches!(&e.kind, ChatEventKind::PermissionRequest { request_id, tool, .. } if *request_id == id && tool == "Browser")));
        // The backend saying "working" meanwhile doesn't end the wait.
        c.send("working").unwrap();
        thread::sleep(Duration::from_millis(100));
        assert_eq!(c.state(), ChatState::WaitingPermission);
        assert!(c.respond_permission_remember(&id, "project").is_err(), "an option the request didn't offer");
        c.respond_permission(&id, true, true).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), ExternalAnswer::Remember("chat".into()));
        assert_eq!(c.state(), ChatState::Working);
        assert!(c.respond_permission(&id, true, false).is_err(), "answered once; then it is the backend's (which refuses)");
        // Deny, then a request the turn's end cancels, then one withdrawn after a timeout.
        let (id2, rx2) = h.ask("Mac", "run ls", json!({}), vec![]).unwrap();
        c.respond_permission(&id2, false, false).unwrap();
        assert_eq!(rx2.recv_timeout(Duration::from_secs(1)).unwrap(), ExternalAnswer::Deny);
        let (_, rx3) = h.ask("Mac", "run ls", json!({}), vec![]).unwrap();
        c.send("idle").unwrap();
        assert!(matches!(rx3.recv_timeout(Duration::from_secs(5)).unwrap(), ExternalAnswer::Cancelled(_)));
        wait_state(&c, ChatState::Idle);
        let (id4, rx4) = h.ask("Mac", "run ls", json!({}), vec![]).unwrap();
        assert_eq!(c.state(), ChatState::WaitingPermission);
        h.withdraw(&id4, "No answer: denied");
        assert_eq!(c.state(), ChatState::Idle);
        assert!(rx4.try_recv().is_err());
        c.stop();
        let deadline = Instant::now() + Duration::from_secs(5);
        while c.is_running() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(h.ask("Mac", "x", json!({}), vec![]).is_none(), "an ended chat can't ask");
    }

    #[test]
    fn stop_terminates_the_process_group() {
        struct Nop;
        impl Backend for Nop {
            fn start(&mut self, _: &mut Out) {}
            fn on_line(&mut self, _: &str, _: &mut Out) {}
            fn send(&mut self, _: &str, _: &[crate::attach::Attachment], _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn interrupt(&mut self, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn set_model(&mut self, _: &str, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn set_permission_mode(&mut self, _: &str, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn respond_permission(&mut self, _: &str, _: bool, _: bool, _: &mut Out) -> Result<()> {
                Ok(())
            }
            fn on_exit(&mut self, _: &mut Out) {}
        }
        // Ignores stdin EOF; only a signal ends it.
        let mut c = Chat::spawn(0, Provider::Codex, "/", "/bin/sh", &["-c".into(), "sleep 30 & wait".into()], &[], None, Box::new(Nop)).unwrap();
        thread::sleep(Duration::from_millis(100));
        c.stop();
        let deadline = Instant::now() + Duration::from_secs(5);
        while c.is_running() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!c.is_running(), "SIGTERM to the group should end sh and its sleep");
    }
}
