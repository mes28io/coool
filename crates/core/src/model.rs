//! Provider-agnostic data model shared by every adapter and the UI.

use serde::{Serialize, Serializer};
use std::sync::Arc;
use std::time::SystemTime;

fn epoch_ms<S: Serializer>(t: &SystemTime, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_u64(t.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
}

impl Provider {
    pub fn label(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
        }
    }
    pub fn binary(self) -> &'static str {
        self.label()
    }
    pub fn toggle(self) -> Self {
        match self {
            Provider::Claude => Provider::Codex,
            Provider::Codex => Provider::Claude,
        }
    }
}

/// How a session was started (see `docs/APP_SPEC.md`, "Who started it").
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    /// Started by the person: an interactive CLI in a terminal or IDE, a
    /// desktop / phone / remote client. Also anything that can't be told apart.
    #[default]
    User,
    /// Started or driven from coool (a chat or a coool terminal), this run or an earlier one.
    Coool,
    /// Started programmatically by another tool or agent (`claude -p`, the
    /// Agent SDK, `codex exec`, Codex subagents whose parent isn't listed, ...).
    Automation,
}

impl Origin {
    pub fn label(self) -> &'static str {
        match self {
            Origin::User => "user",
            Origin::Coool => "coool",
            Origin::Automation => "automation",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// Model is working (thinking / calling tools).
    Busy,
    /// Process alive, waiting for the user.
    Idle,
    /// No live process; transcript only.
    Ended,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityKind {
    Prompt,
    Text,
    Tool,
    Error,
    Agent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct Activity {
    pub ts: String, // HH:MM:SS (local-ish; transcript timestamps are UTC, see util::short_time)
    pub kind: ActivityKind,
    /// One line: whitespace collapsed, cut to ~400 columns (errors ~200; tool
    /// summaries are one line by design). For lists, the TUI and insight prompts.
    pub text: String,
    /// Prompts, replies and errors: the whole text with its line breaks, when
    /// `text` loses anything; at most [`MAX_FULL`] characters. Only the newest
    /// [`FULL_RECENT`] such entries of a timeline keep it (see [`push_activity`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full: Option<String>,
    /// What is kept (`full`, else `text`) is not the whole message: it was cut
    /// at [`MAX_FULL`], or the entry is older than the newest [`FULL_RECENT`]
    /// full texts and kept only its one-line form.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub shortened: bool,
    /// An `Error` that is one failed step (a tool call that returned an
    /// error), not a failure of the turn or the session. Agents usually
    /// recover from these, so frontends show them quietly.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub step: bool,
    /// A step that published a page to claude.ai (see [`crate::artifact`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<Box<crate::artifact::ArtifactInfo>>,
    /// A prompt's attachments (images and files the person added; see [`crate::attach`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<crate::attach::Attachment>,
}

/// Characters of `Activity::full` kept per entry.
pub const MAX_FULL: usize = 24_000;
/// Entries with a full text (see [`Activity::full`]) a timeline keeps, newest
/// first: at most `FULL_RECENT * MAX_FULL` characters per timeline.
pub const FULL_RECENT: usize = 50;

impl Activity {
    /// A step (tool call, subagent) or a fixed note: one line says it all.
    pub fn line(ts: String, kind: ActivityKind, text: impl Into<String>) -> Self {
        Self { ts, kind, text: text.into(), full: None, shortened: false, step: false, artifact: None, attachments: Vec::new() }
    }

    /// A prompt, reply or error: its one-line form (`max` columns) and, when
    /// that loses anything (line breaks, length), the full text beside it.
    pub fn message(ts: String, kind: ActivityKind, s: &str, max: usize) -> Self {
        let text = crate::util::one_line(s, max);
        let s = s.trim();
        if text == s {
            return Self::line(ts, kind, text);
        }
        let (full, cut) = match s.char_indices().nth(MAX_FULL) {
            Some((end, _)) => (format!("{}…", &s[..end]), true),
            None => (s.to_string(), false),
        };
        Self { ts, kind, text, full: Some(full), shortened: cut, step: false, artifact: None, attachments: Vec::new() }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct Tokens {
    pub input: u64,
    pub cached: u64,
    pub output: u64,
    /// Size of the most recent request's context window usage.
    pub context: u64,
    /// Output tokens of the current (or latest) turn: since its last prompt. 0 when unknown.
    #[serde(default)]
    pub turn_output: u64,
    /// Epoch ms the current (or latest) turn began: the first conversation event after the previous turn ended
    /// (Claude: `system` / `turn_duration`; Codex: `task_started`). A turn need not start with a prompt (a
    /// background task's notification starts one), so this is what a live timer counts from. None when unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_start: Option<u64>,
    /// The most recent response's context plus its output: what Claude Code
    /// shows as a subagent's `↓ N tokens`. 0 when unknown.
    #[serde(default)]
    pub total: u64,
}

/// Tokens one model consumed within a session or subagent.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct ModelUse {
    pub model: String,
    /// Uncached input (Claude: including cache writes), like [`Tokens::input`].
    pub input: u64,
    pub cached: u64,
    pub output: u64,
    /// Model responses counted.
    pub messages: u64,
    /// True for rows aggregated up from the session's subagents.
    pub via_agent: bool,
}

impl ModelUse {
    pub fn total(&self) -> u64 {
        self.input + self.cached + self.output
    }
}

/// Adds `n` to the `(model, via_agent)` row of `list`, creating it if needed.
pub fn add_model_use(list: &mut Vec<ModelUse>, n: &ModelUse) {
    match list.iter_mut().find(|m| m.model == n.model && m.via_agent == n.via_agent) {
        Some(m) => {
            m.input += n.input;
            m.cached += n.cached;
            m.output += n.output;
            m.messages += n.messages;
        }
        None => list.push(n.clone()),
    }
}

/// Most used first (by total tokens, then messages); ties keep a stable order.
pub fn sort_model_use(list: &mut [ModelUse]) {
    list.sort_by(|a, b| b.total().cmp(&a.total()).then(b.messages.cmp(&a.messages)).then(a.model.cmp(&b.model)));
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Agent {
    pub id: String,
    pub kind: String,
    pub description: String,
    pub finished: bool,
    pub current: Option<String>,
    pub tokens: Tokens,
    /// Shared with the transcript's parsed view: cloning a session is cheap.
    pub activity: Arc<Vec<Activity>>,
    /// Model it ran on (most used, or as launched); empty when unknown.
    pub model: String,
    /// Every model it used, most used first.
    pub models: Vec<ModelUse>,
}

/// `PartialEq` is exact over everything serialized (and compares shared
/// timelines by pointer first), so an equal session has the same JSON.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Session {
    pub provider: Provider,
    pub id: String,
    pub title: String,
    pub cwd: String,
    /// Folder the session is grouped under (see [`crate::project`]); filled in by
    /// [`crate::hub::Hub::refresh`], empty before that.
    pub project: String,
    pub model: String,
    pub pid: Option<u32>,
    pub status: Status,
    pub current: Option<String>,
    pub last_prompt: Option<String>,
    pub tokens: Tokens,
    /// Shared with the transcript's parsed view: cloning a session is cheap.
    pub activity: Arc<Vec<Activity>>,
    pub agents: Vec<Agent>,
    /// Serialized as epoch milliseconds.
    #[serde(serialize_with = "epoch_ms")]
    pub updated: SystemTime,
    /// Epoch ms of the newest real conversation event (a prompt, a reply or a
    /// turn end) in the transcript; None until one is seen. Unlike `updated`
    /// (the file's mtime, which other tools also bump) this only moves on new
    /// activity: it is what "unread" compares against.
    pub last_event: Option<u64>,
    /// Set when this session runs inside one of coool's own PTYs.
    pub managed: Option<usize>,
    /// Set when this session is driven by one of coool's structured chats ([`crate::chat`]).
    pub chat: Option<usize>,
    /// Models used, most used first: the session's own rows, then rows with
    /// `via_agent` set for what its subagents used.
    pub models: Vec<ModelUse>,
    /// False while only the cheap facts are known (id, folder/title from the
    /// registry or index, status, `updated`): the transcript hasn't been read
    /// yet, so activity, tokens and models are still empty. True once details
    /// are known. While [`crate::hub::Hub::loading`], a big transcript can show
    /// its recent activity before its totals: `tokens` (except `context`) and
    /// `models` may still be zero/empty for it until the backfill finishes.
    pub loaded: bool,
    /// Who started it. Filled by the adapters from the transcript (Claude
    /// `entrypoint`, Codex `originator` / `source`), then raised to
    /// [`Origin::Coool`] by [`crate::hub::Hub::refresh`] for sessions coool
    /// started (its chats and terminals, remembered across restarts).
    pub origin: Origin,
    /// For a programmatic run started from inside another session (see
    /// [`crate::lineage`]): that session's id. Filled by [`crate::hub::Hub::refresh`].
    pub parent: Option<String>,
    /// Child runs of this session that are still alive (filled by the Hub).
    pub live_children: u32,
    /// The CLI says background tasks of this session are still running while it
    /// waits for the person (Claude registry status `shell`; a flag, no count).
    pub background_tasks: bool,
    /// The CLI says it is blocked on the person (Claude registry status
    /// `waiting`): what for (e.g. a permission prompt), as the CLI names it.
    pub waiting_for: Option<String>,
    /// Background shells this live session runs (see [`crate::shells`]);
    /// filled by [`crate::hub::Hub::refresh`]. Left out of the JSON when empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub shells: Vec<crate::shells::Shell>,
    /// What the transcript says about naming (see [`crate::titles`]); not sent.
    #[serde(skip)]
    pub title_facts: crate::titles::Facts,
    /// The title to show, resolved by [`crate::titles::Titles::resolve`] (the app
    /// fills it in before sending; None before that). Left out of the JSON when None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<crate::titles::Name>,
}

pub const MAX_ACTIVITY: usize = 300;

/// Appends to a timeline: keeps its newest [`MAX_ACTIVITY`] entries, and full
/// texts on the newest [`FULL_RECENT`] that have one (an older entry keeps its
/// one line and is marked `shortened`).
pub fn push_activity(list: &mut Vec<Activity>, a: Activity) {
    let has_full = a.full.is_some();
    list.push(a);
    if has_full
        && let Some(old) = list.iter_mut().rev().filter(|e| e.full.is_some()).nth(FULL_RECENT)
    {
        old.full = None;
        old.shortened = true;
    }
    if list.len() > MAX_ACTIVITY {
        let drop = list.len() - MAX_ACTIVITY;
        list.drain(..drop);
    }
}

impl Session {
    /// This session as JSON (what the desktop app sends). Serialized here, in
    /// this crate, so callers built without optimizations still get the
    /// optimized serializer: a debug build of the app spends ~25x longer otherwise.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "null".into())
    }

    /// Best human label: AI title, else the last prompt, else the folder name.
    pub fn display_title(&self) -> String {
        if let Some(n) = &self.name {
            return n.title.clone();
        }
        if !self.title.is_empty() {
            return self.title.clone();
        }
        if let Some(p) = &self.last_prompt {
            return crate::util::one_line(p, 60);
        }
        std::path::Path::new(&self.cwd).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_else(|| "untitled".into())
    }
}
