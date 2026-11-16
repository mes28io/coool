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
}

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
#[derive(Clone, Debug, Serialize)]
pub struct ChatEvent {
    pub seq: u64,
    /// Epoch milliseconds.
    pub ts: u64,
    #[serde(flatten)]
    pub kind: ChatEventKind,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
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
        #[serde(skip_serializing_if = "Option::is_none")]
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
    State {
        state: ChatState,
    },
    TurnEnd {
        duration_ms: u64,
        ok: bool,
    },
    Notice {
        level: NoticeLevel,
        text: String,
        needs_terminal: bool,
    },
    Exited {
        code: Option<i32>,
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
    },
}

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
#[derive(Clone, Debug, Serialize)]
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
}

/// What a backend wants done after handling input: lines for the CLI's stdin
/// and events for the UI. Keeps backends pure, so they are tested on fixtures.
#[derive(Default, Debug)]
pub(crate) struct Out {
    pub writes: Vec<String>,
    pub events: Vec<ChatEventKind>,
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
    fn send(&mut self, text: &str, o: &mut Out) -> Result<()>;
    fn interrupt(&mut self, o: &mut Out) -> Result<()>;
    fn set_model(&mut self, model: &str, o: &mut Out) -> Result<()>;
    fn set_permission_mode(&mut self, mode: &str, o: &mut Out) -> Result<()>;
    fn respond_permission(&mut self, request_id: &str, allow: bool, always: bool, o: &mut Out) -> Result<()>;
    /// Allow, and apply one of the request's [`RememberOption`]s.
    fn respond_permission_remember(&mut self, request_id: &str, _remember: &str, _o: &mut Out) -> Result<()> {
        bail!("no pending permission request {request_id}")
    }
    /// A steering note for the running turn (see [`Chat::steer`]).
    fn steer(&mut self, _note_id: &str, _text: &str, _now: bool, _o: &mut Out) -> Result<()> {
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

struct Shared {
    backend: Box<dyn Backend>,
    events: VecDeque<ChatEvent>,
    next_seq: u64,
    state: ChatState,
    session_id: Option<String>,
    model: String,
    permission_mode: String,
    running: bool,
    stderr_tail: VecDeque<String>,
    /// `COOOL_CHAT_TRACE=<file>`: protocol trace in the fixture format.
    trace: Option<std::fs::File>,
}

impl Shared {
    fn trace(&mut self, dir: &str, v: Value) {
        if let Some(f) = self.trace.as_mut() {
            let rec = json!({"t": now_ms(), "dir": dir, "line": v});
            let _ = writeln!(f, "{rec}");
        }
    }

    fn push(&mut self, kind: ChatEventKind) {
        match &kind {
            ChatEventKind::State { state } => {
                if *state == self.state {
                    return;
                }
                self.state = *state;
            }
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
}

impl ChatHandle {
    /// Same as [`Chat::events_since`].
    pub fn events_since(&self, seq: u64) -> (Vec<ChatEvent>, u64) {
        events_since(&self.shared, seq)
    }

    pub fn is_running(&self) -> bool {
        lock(&self.shared).running
    }
}

fn events_since(shared: &Mutex<Shared>, seq: u64) -> (Vec<ChatEvent>, u64) {
    let sh = lock(shared);
    // Events are in seq order: skip the old ones without cloning them.
    let start = sh.events.partition_point(|e| e.seq <= seq);
    let evs: Vec<ChatEvent> = sh.events.range(start..).cloned().collect();
    (evs, sh.next_seq.max(seq))
}

pub struct Chat {
    pub id: usize,
    pub provider: Provider,
    pub cwd: String,
    pub pid: Option<u32>,
    pub started: SystemTime,
    shared: Arc<Mutex<Shared>>,
    writer: Sender<WriterMsg>,
    kill_requested: Option<Instant>,
}

impl Chat {
    /// `client_name`: how coool introduces itself to `codex app-server` (see [`crate::origin`]).
    pub(crate) fn start(id: usize, opts: ChatOptions, client_name: &str) -> Result<Self> {
        let (backend, program, args): (Box<dyn Backend>, &str, Vec<String>) = match opts.provider {
            Provider::Claude => {
                let b = claude::Claude::new(&opts);
                let args = b.args();
                (Box::new(b), "claude", args)
            }
            Provider::Codex => {
                let mut b = codex::Codex::new(&opts);
                b.client_name = client_name.to_string();
                (Box::new(b), "codex", codex::args())
            }
        };
        Self::spawn(id, opts.provider, &opts.cwd, program, &args, backend)
    }

    fn spawn(id: usize, provider: Provider, cwd: &str, program: &str, args: &[String], backend: Box<dyn Backend>) -> Result<Self> {
        if !std::path::Path::new(cwd).is_dir() {
            bail!("folder does not exist: {cwd}");
        }
        let mut cmd = Command::new(program);
        cmd.args(args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // Own process group, so stop() reaches the tools it spawned too.
        cmd.process_group(0);
        let mut child = cmd.spawn().with_context(|| format!("spawn `{program}` (is it installed and on PATH?)"))?;
        let pid = Some(child.id());
        let stdin = child.stdin.take().context("stdin")?;
        let stdout = child.stdout.take().context("stdout")?;
        let stderr = child.stderr.take().context("stderr")?;

        let shared = Arc::new(Mutex::new(Shared {
            backend,
            events: VecDeque::new(),
            next_seq: 0,
            state: ChatState::Idle,
            session_id: None,
            model: String::new(),
            permission_mode: String::new(),
            running: true,
            stderr_tail: VecDeque::new(),
            trace: std::env::var_os("COOOL_CHAT_TRACE").and_then(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).ok()),
        }));
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
            thread::spawn(move || {
                let mut r = BufReader::new(stdout);
                let mut buf = Vec::new();
                loop {
                    buf.clear();
                    match r.read_until(b'\n', &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let line = String::from_utf8_lossy(&buf);
                            let line = line.trim();
                            if line.is_empty() {
                                continue;
                            }
                            let mut sh = lock(&shared);
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
                // Something the CLI spawned may still hold stdout open; don't wait forever.
                let _ = eof_rx.recv_timeout(Duration::from_secs(2));
                let mut sh = lock(&shared);
                sh.running = false;
                let mut o = Out::default();
                sh.backend.on_exit(&mut o);
                o.writes.clear();
                apply(&mut sh, &writer, o);
                if code != Some(0) && code.is_some() {
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
        Ok(Self { id, provider, cwd: cwd.to_string(), pid, started: SystemTime::now(), shared, writer, kill_requested: None })
    }

    fn with_backend(&mut self, call: Value, f: impl FnOnce(&mut dyn Backend, &mut Out) -> Result<()>) -> Result<()> {
        let mut sh = lock(&self.shared);
        if !sh.running {
            bail!("the chat has ended");
        }
        sh.trace("api", call);
        let mut o = Out::default();
        let r = f(sh.backend.as_mut(), &mut o);
        apply(&mut sh, &self.writer, o);
        r
    }

    /// A prompt, or a slash command typed as text.
    pub fn send(&mut self, text: &str) -> Result<()> {
        if text.trim().is_empty() {
            bail!("empty message");
        }
        self.with_backend(json!({"call": "send", "text": text}), |b, o| b.send(text, o))
    }

    /// A note for the running turn; returns its id. `now: false`: delivered at
    /// the agent's next step boundary; `now: true`: the current step is
    /// interrupted and the note starts the next turn. A pending permission
    /// request or question holds every note until it is answered (`now` then
    /// acts like `false`). On an idle chat the note is sent as a prompt. Its
    /// fate arrives as [`ChatEventKind::Steer`] events.
    pub fn steer(&mut self, text: &str, now: bool) -> Result<String> {
        if text.trim().is_empty() {
            bail!("empty note");
        }
        let id = uuid_v4();
        self.with_backend(json!({"call": "steer", "note_id": id, "text": text, "now": now}), |b, o| b.steer(&id, text, now, o))?;
        Ok(id)
    }

    /// Withdraw a note that is still `queued`. Fails once the agent has it
    /// (and, for Codex, once it was handed to the CLI: see CHAT_SPEC).
    pub fn cancel_steer(&mut self, note_id: &str) -> Result<()> {
        self.with_backend(json!({"call": "cancel_steer", "note_id": note_id}), |b, o| b.cancel_steer(note_id, o))
    }

    /// Stop the current turn; the chat stays usable.
    pub fn interrupt(&mut self) -> Result<()> {
        self.with_backend(json!({"call": "interrupt"}), |b, o| b.interrupt(o))
    }

    pub fn set_model(&mut self, model: &str) -> Result<()> {
        self.with_backend(json!({"call": "set_model", "model": model}), |b, o| b.set_model(model, o))
    }

    pub fn set_permission_mode(&mut self, mode: &str) -> Result<()> {
        self.with_backend(json!({"call": "set_permission_mode", "mode": mode}), |b, o| b.set_permission_mode(mode, o))
    }

    /// Allow once, deny, or (`always`) allow and apply the request's first
    /// remember option *only if it is for this chat alone*; a rule that would
    /// be saved to a settings file is never applied this way (use
    /// [`Chat::respond_permission_remember`]). With no such option, `always`
    /// allows once.
    pub fn respond_permission(&mut self, request_id: &str, allow: bool, always: bool) -> Result<()> {
        let call = json!({"call": "respond_permission", "request_id": request_id, "allow": allow, "always": always});
        self.with_backend(call, |b, o| b.respond_permission(request_id, allow, always, o))
    }

    /// Allow, and apply the [`RememberOption`] with id `remember` from the
    /// request's `permission_request.remember`.
    pub fn respond_permission_remember(&mut self, request_id: &str, remember: &str) -> Result<()> {
        let call = json!({"call": "respond_permission", "request_id": request_id, "allow": true, "remember": remember});
        self.with_backend(call, |b, o| b.respond_permission_remember(request_id, remember, o))
    }

    /// Answer a [`ChatEventKind::Question`]: for each question, in order, the
    /// picked option labels and/or typed text. Decline with `respond_permission(id, false, false)`.
    pub fn respond_question(&mut self, request_id: &str, answers: &[Vec<String>]) -> Result<()> {
        let call = json!({"call": "respond_question", "request_id": request_id, "answers": answers});
        self.with_backend(call, |b, o| b.respond_question(request_id, answers, o))
    }

    /// End the process: close its input and ask it to terminate; the hub
    /// escalates to SIGKILL if it is still around after a grace period.
    pub fn stop(&mut self) {
        let _ = self.writer.send(WriterMsg::Close);
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
        ChatHandle { id: self.id, shared: self.shared.clone() }
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
        }
    }

    pub fn is_running(&self) -> bool {
        lock(&self.shared).running
    }

    pub fn state(&self) -> ChatState {
        lock(&self.shared).state
    }

    pub fn session_id(&self) -> Option<String> {
        lock(&self.shared).session_id.clone()
    }

    fn signal(&self, sig: libc::c_int) {
        // Only while the child is unreaped: afterwards its pid may be reused.
        if !self.is_running() {
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
        if !self.is_running() {
            return;
        }
        let _ = self.writer.send(WriterMsg::Close);
        self.signal(libc::SIGTERM);
        let shared = self.shared.clone();
        let pid = self.pid.and_then(crate::util::valid_pid);
        thread::spawn(move || {
            thread::sleep(KILL_GRACE);
            if lock(&shared).running
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
}

/// The notes of one chat, in the order they were made.
#[derive(Default)]
pub(crate) struct Notes {
    pub list: Vec<Note>,
}

impl Notes {
    pub fn add(&mut self, id: &str, text: &str, now: bool, o: &mut Out) {
        self.list.push(Note { id: id.into(), text: text.into(), now, sent: false, own_turn: false, cut: None, cancelling: false });
        o.ev(ChatEventKind::Steer { note_id: id.into(), text: text.into(), state: SteerState::Queued, tool_id: None });
    }

    pub fn get(&mut self, id: &str) -> Option<&mut Note> {
        self.list.iter_mut().find(|n| n.id == id)
    }

    /// Ends a note: its final `steer` event, and for a delivered one the
    /// `user_message` echo (`steer: true`). False if there is no such note.
    pub fn settle(&mut self, id: &str, state: SteerState, tool_id: Option<String>, user_n: &mut u64, o: &mut Out) -> bool {
        let Some(i) = self.list.iter().position(|n| n.id == id) else { return false };
        let n = self.list.remove(i);
        o.ev(ChatEventKind::Steer { note_id: n.id.clone(), text: n.text.clone(), state, tool_id });
        if matches!(state, SteerState::PickedUp | SteerState::Interrupted) {
            *user_n += 1;
            o.ev(ChatEventKind::UserMessage { id: format!("u{user_n}"), text: n.text, steer: true, note_id: Some(n.id) });
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
                        "send" => b.send(&s("text"), &mut o),
                        "interrupt" => b.interrupt(&mut o),
                        "set_model" => b.set_model(&s("model"), &mut o),
                        "set_permission_mode" => b.set_permission_mode(&s("mode"), &mut o),
                        "respond_permission" if line["remember"].is_string() => b.respond_permission_remember(&s("request_id"), &s("remember"), &mut o),
                        "respond_permission" => b.respond_permission(&s("request_id"), line["allow"] == true, line["always"] == true, &mut o),
                        "steer" => b.steer(&s("note_id"), &s("text"), line["now"] == true, &mut o),
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
        let e = ChatEvent { seq: 2, ts: 2, kind: ChatEventKind::Steer { note_id: "n".into(), text: "t".into(), state: SteerState::PickedUp, tool_id: Some("tool".into()) } };
        assert_eq!(serde_json::to_value(&e).unwrap(), serde_json::json!({"seq": 2, "ts": 2, "type": "steer", "note_id": "n", "text": "t", "state": "picked_up", "tool_id": "tool"}));
        let e = ChatEvent { seq: 3, ts: 3, kind: ChatEventKind::UserMessage { id: "u1".into(), text: "t".into(), steer: false, note_id: None } };
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

    #[test]
    fn missing_folder_is_an_error_not_a_spawn() {
        let opts = ChatOptions { provider: Provider::Claude, cwd: "/definitely/not/here".into(), resume: None, model: None, permission_mode: None };
        assert!(Chat::start(0, opts, "coool").is_err());
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
            fn send(&mut self, text: &str, o: &mut Out) -> Result<()> {
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
        let mut c = Chat::spawn(7, Provider::Claude, "/", "/bin/sh", &["-c".into(), "head -n 2".into()], Box::new(Echo)).unwrap();
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

    #[test]
    fn stop_terminates_the_process_group() {
        struct Nop;
        impl Backend for Nop {
            fn start(&mut self, _: &mut Out) {}
            fn on_line(&mut self, _: &str, _: &mut Out) {}
            fn send(&mut self, _: &str, _: &mut Out) -> Result<()> {
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
        let mut c = Chat::spawn(0, Provider::Codex, "/", "/bin/sh", &["-c".into(), "sleep 30 & wait".into()], Box::new(Nop)).unwrap();
        thread::sleep(Duration::from_millis(100));
        c.stop();
        let deadline = Instant::now() + Duration::from_secs(5);
        while c.is_running() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!c.is_running(), "SIGTERM to the group should end sh and its sleep");
    }
}
