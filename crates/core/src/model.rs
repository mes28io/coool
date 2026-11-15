//! Provider-agnostic data model shared by every adapter and the UI.

use serde::{Serialize, Serializer};
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

#[derive(Clone, Debug, Serialize, serde::Deserialize)]
pub struct Activity {
    pub ts: String, // HH:MM:SS (local-ish; transcript timestamps are UTC, see util::short_time)
    pub kind: ActivityKind,
    pub text: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct Tokens {
    pub input: u64,
    pub cached: u64,
    pub output: u64,
    /// Size of the most recent request's context window usage.
    pub context: u64,
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

#[derive(Clone, Debug, Serialize)]
pub struct Agent {
    pub id: String,
    pub kind: String,
    pub description: String,
    pub finished: bool,
    pub current: Option<String>,
    pub tokens: Tokens,
    pub activity: Vec<Activity>,
    /// Model it ran on (most used, or as launched); empty when unknown.
    pub model: String,
    /// Every model it used, most used first.
    pub models: Vec<ModelUse>,
}

#[derive(Clone, Debug, Serialize)]
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
    pub activity: Vec<Activity>,
    pub agents: Vec<Agent>,
    /// Serialized as epoch milliseconds.
    #[serde(serialize_with = "epoch_ms")]
    pub updated: SystemTime,
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
}

pub const MAX_ACTIVITY: usize = 300;

pub fn push_activity(list: &mut Vec<Activity>, a: Activity) {
    list.push(a);
    if list.len() > MAX_ACTIVITY {
        let drop = list.len() - MAX_ACTIVITY;
        list.drain(..drop);
    }
}

impl Session {
    /// Best human label: AI title, else the last prompt, else the folder name.
    pub fn display_title(&self) -> String {
        if !self.title.is_empty() {
            return self.title.clone();
        }
        if let Some(p) = &self.last_prompt {
            return crate::util::one_line(p, 60);
        }
        std::path::Path::new(&self.cwd).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_else(|| "untitled".into())
    }
}
