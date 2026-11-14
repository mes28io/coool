//! Claude Code over `claude -p --input-format stream-json --output-format stream-json`.
//!
//! Observed protocol (Claude Code 2.1.x):
//! - stdin: `{"type":"user","message":{"role":"user","content":"..."}}` per turn, and
//!   `{"type":"control_request","request_id","request":{"subtype": "initialize" |
//!   "interrupt" | "set_model" | "set_permission_mode" | "get_context_usage"}}`.
//!   Messages sent mid-turn are queued by the CLI and each gets its own `result`.
//! - stdout: `control_response` to those, `system` (`init` per turn, `status`, ...),
//!   `stream_event` (raw API stream, only for the main thread), complete
//!   `assistant` messages (one per content block, subagents' carry
//!   `parent_tool_use_id`), `user` (tool results) and one `result` per turn.
//! - Permissions: only with `--permission-prompt-tool stdio` does the CLI ask the
//!   host; it sends `control_request` `can_use_tool` and waits for a
//!   `control_response` with `{"behavior":"allow"|"deny", ...}`. Without the flag
//!   it silently denies anything that would prompt.
//! - Slash commands typed as text run locally and answer with a `<synthetic>`
//!   assistant message; TUI-only ones answer "/x isn't available in this
//!   environment", and `system/init.terminal_slash_commands` lists the rest that
//!   need the TUI.

use super::*;
use crate::util::tool_summary;
use std::collections::HashMap;

/// Commands that need the TUI even though the CLI lists them, until the first
/// `system/init` reports the real list.
const TERMINAL_COMMANDS_FALLBACK: &[&str] = &["doctor", "color", "focus", "reload-plugins"];

enum Pending {
    Init,
    Context,
    SetModel(String),
    SetMode(String),
    Interrupt,
}

struct Perm {
    tool: String,
    input: Value,
    suggestions: Value,
    /// An `AskUserQuestion` call, answered with `respond_question`.
    question: bool,
}

/// What the CLI said about a command in the `initialize` answer.
#[derive(Clone)]
struct RawCommand {
    name: String,
    description: String,
    argument_hint: String,
    aliases: Vec<String>,
}

/// Skills and TUI-only commands from the last `system/init` of any chat in
/// this process, so a new chat tags its commands right before its first turn.
static KNOWN_KINDS: std::sync::Mutex<Option<(Vec<String>, Vec<String>)>> = std::sync::Mutex::new(None);

pub(crate) struct Claude {
    session_id: String,
    resume: Option<String>,
    cwd: String,
    model: String,
    permission_mode: String,
    commands: Vec<SlashCommand>,
    raw_commands: Vec<RawCommand>,
    terminal_commands: Vec<String>,
    skills: Vec<String>,
    last_commands: Option<Vec<CommandInfo>>,
    models: Vec<ModelOption>,
    agents: Vec<String>,
    /// Context window per model, from `result.modelUsage`; else from get_context_usage.
    windows: HashMap<String, u64>,
    context_max: Option<u64>,
    last_ready: Option<ChatEventKind>,
    /// The first `ready` waits for both startup answers, so it comes out complete.
    init_done: bool,
    context_done: bool,
    next_req: u64,
    pending: HashMap<String, Pending>,
    perms: HashMap<String, Perm>,
    /// Streamed message id and model, main thread only (subagents don't stream).
    stream_msg: Option<(String, String)>,
    /// Text blocks seen per message, in deltas and in final messages; the n-th
    /// block of a message gets the same id in both.
    stream_blocks: HashMap<String, u32>,
    final_blocks: HashMap<String, u32>,
    totals: Tokens,
    user_n: u64,
    /// Turns sent and not yet answered by a `result`.
    queued: u32,
    interrupted: bool,
    /// Last error shown this turn, so the turn's `result` doesn't repeat it.
    last_error: Option<String>,
}

impl Claude {
    pub fn new(opts: &ChatOptions) -> Self {
        let (skills, terminal) = KNOWN_KINDS
            .lock()
            .ok()
            .and_then(|k| k.clone())
            .unwrap_or_else(|| (Vec::new(), TERMINAL_COMMANDS_FALLBACK.iter().map(|s| s.to_string()).collect()));
        Self {
            session_id: opts.resume.clone().unwrap_or_else(uuid_v4),
            resume: opts.resume.clone(),
            cwd: opts.cwd.clone(),
            model: opts.model.clone().unwrap_or_default(),
            permission_mode: opts.permission_mode.clone().unwrap_or_else(|| "default".into()),
            commands: Vec::new(),
            raw_commands: Vec::new(),
            terminal_commands: terminal,
            skills,
            last_commands: None,
            models: Vec::new(),
            agents: Vec::new(),
            windows: HashMap::new(),
            context_max: None,
            last_ready: None,
            init_done: false,
            context_done: false,
            next_req: 0,
            pending: HashMap::new(),
            perms: HashMap::new(),
            stream_msg: None,
            stream_blocks: HashMap::new(),
            final_blocks: HashMap::new(),
            totals: Tokens::default(),
            user_n: 0,
            queued: 0,
            interrupted: false,
            last_error: None,
        }
    }

    pub fn args(&self) -> Vec<String> {
        let mut a: Vec<String> = [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            // Subagents' text (not just their tool calls), tagged with parent_tool_use_id.
            "--forward-subagent-text",
            "--permission-prompt-tool",
            "stdio",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        match &self.resume {
            Some(id) => a.extend(["--resume".into(), id.clone()]),
            // Chosen up front so the hub can link the transcript before the first turn.
            None => a.extend(["--session-id".into(), self.session_id.clone()]),
        }
        if !self.model.is_empty() {
            a.extend(["--model".into(), self.model.clone()]);
        }
        if let Some(m) = Some(&self.permission_mode).filter(|m| m.as_str() != "default") {
            a.extend(["--permission-mode".into(), m.clone()]);
        }
        a
    }

    fn request(&mut self, req: Value, kind: Pending, o: &mut Out) {
        self.next_req += 1;
        let id = format!("coool-{}", self.next_req);
        o.write(&json!({"type": "control_request", "request_id": id, "request": req}));
        self.pending.insert(id, kind);
    }

    fn context_window(&self) -> Option<u64> {
        self.windows.get(&self.model).copied().or(self.context_max)
    }

    /// (Re-)announce `ready` when anything in it changed.
    fn ready(&mut self, o: &mut Out) {
        if !(self.init_done && self.context_done) {
            return;
        }
        let r = ChatEventKind::Ready {
            session_id: self.session_id.clone(),
            model: self.model.clone(),
            cwd: self.cwd.clone(),
            permission_mode: self.permission_mode.clone(),
            slash_commands: self.commands.clone(),
            models: self.models.clone(),
            agents: self.agents.clone(),
            context_window: self.context_window(),
        };
        if self.last_ready.as_ref() != Some(&r) {
            self.last_ready = Some(r.clone());
            o.ev(r);
        }
        // Right after `ready` (which stays the first event of a chat).
        let cmds = self.command_infos();
        if self.last_commands.as_ref() != Some(&cmds) {
            self.last_commands = Some(cmds.clone());
            o.ev(ChatEventKind::Commands { commands: cmds });
        }
    }

    /// Every command the CLI listed, tagged by where it runs.
    fn command_infos(&self) -> Vec<CommandInfo> {
        let known = |list: &[String], c: &RawCommand| list.iter().any(|n| *n == c.name || c.aliases.contains(n));
        self.raw_commands
            .iter()
            .map(|c| {
                let kind = if known(&self.terminal_commands, c) {
                    CommandKind::Terminal
                } else if known(&self.skills, c) || c.name.contains(':') || c.aliases.iter().any(|a| a.contains(':')) {
                    // `plugin:skill` names are always skills, even before `system/init` lists them.
                    CommandKind::Skill
                } else {
                    CommandKind::Command
                };
                CommandInfo { name: c.name.clone(), description: c.description.clone(), argument_hint: c.argument_hint.clone(), aliases: c.aliases.clone(), kind }
            })
            .collect()
    }

    fn working_or_idle(&self) -> ChatState {
        if !self.perms.is_empty() {
            ChatState::WaitingPermission
        } else if self.queued > 0 {
            ChatState::Working
        } else {
            ChatState::Idle
        }
    }

    fn on_control_response(&mut self, r: &Value, o: &mut Out) {
        let id = r["request_id"].as_str().unwrap_or("");
        let Some(kind) = self.pending.remove(id) else { return };
        if r["subtype"] == "error" {
            let what = match &kind {
                Pending::Init => {
                    self.init_done = true;
                    self.ready(o);
                    "start".to_string()
                }
                Pending::Context => {
                    // Best effort: the window is also learned from turn results.
                    self.context_done = true;
                    self.ready(o);
                    return;
                }
                Pending::SetModel(m) => format!("switch to model {m}"),
                Pending::SetMode(m) => format!("switch to permission mode {m}"),
                Pending::Interrupt => "interrupt".to_string(),
            };
            let err = r["error"].as_str().unwrap_or("unknown error");
            o.ev(ChatEventKind::notice(NoticeLevel::Error, format!("Could not {what}: {err}")));
            return;
        }
        let res = &r["response"];
        match kind {
            Pending::Init => {
                self.raw_commands = res["commands"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|c| {
                                let name = c["name"].as_str()?;
                                // `__name` entries are internal plumbing.
                                (!name.starts_with("__")).then(|| RawCommand {
                                    name: name.to_string(),
                                    description: c["description"].as_str().unwrap_or("").to_string(),
                                    argument_hint: c["argumentHint"].as_str().unwrap_or("").to_string(),
                                    aliases: names(&c["aliases"]),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                self.commands = self.raw_commands.iter().map(|c| SlashCommand { name: c.name.clone(), description: c.description.clone() }).collect();
                self.models = res["models"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|m| {
                                let id = m["value"].as_str()?;
                                Some(ModelOption { id: id.to_string(), label: m["displayName"].as_str().unwrap_or(id).to_string() })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                self.agents = names(&res["agents"]);
                if let Some(m) = res["current_permission_mode"].as_str() {
                    self.permission_mode = m.to_string();
                }
                self.init_done = true;
                self.ready(o);
            }
            Pending::Context => {
                if let Some(m) = res["model"].as_str() {
                    self.model = m.to_string();
                }
                self.context_max = res["rawMaxTokens"].as_u64().or(res["maxTokens"].as_u64());
                self.context_done = true;
                self.ready(o);
            }
            Pending::SetModel(m) => {
                self.model = res["model"].as_str().unwrap_or(&m).to_string();
                self.ready(o);
                // Resolves aliases ("haiku") and refreshes the window for the new model.
                self.request(json!({"subtype": "get_context_usage"}), Pending::Context, o);
            }
            Pending::SetMode(m) => {
                self.permission_mode = res["mode"].as_str().unwrap_or(&m).to_string();
                self.ready(o);
            }
            Pending::Interrupt => {}
        }
    }

    fn on_assistant(&mut self, v: &Value, o: &mut Out) {
        let parent = v["parent_tool_use_id"].as_str().map(str::to_string);
        let msg = &v["message"];
        let id = msg["id"].as_str().unwrap_or("").to_string();
        let model = msg["model"].as_str().unwrap_or("").to_string();
        let blocks = msg["content"].as_array().cloned().unwrap_or_default();
        if model == "<synthetic>" || v["isApiErrorMessage"].as_bool() == Some(true) || v["error"].is_string() {
            // Local command output, or an API error reported as a message.
            let text: Vec<&str> = blocks.iter().filter_map(|b| b["text"].as_str()).collect();
            let text = text.join("\n");
            if text.trim().is_empty() {
                return;
            }
            let e = if text.contains("isn't available in this environment") {
                ChatEventKind::needs_terminal(text)
            } else if v["error"].is_string() || v["isApiErrorMessage"].as_bool() == Some(true) {
                self.last_error = Some(text.clone());
                error_notice(text)
            } else {
                ChatEventKind::notice(NoticeLevel::Info, text)
            };
            o.ev(e);
            return;
        }
        for b in &blocks {
            match b["type"].as_str() {
                Some("text") => {
                    let n = self.final_blocks.entry(id.clone()).or_insert(0);
                    *n += 1;
                    let text = b["text"].as_str().unwrap_or("").to_string();
                    if !text.is_empty() {
                        o.ev(ChatEventKind::AssistantMessage { id: block_id(&id, *n), text, model: model.clone(), parent_tool_id: parent.clone() });
                    }
                }
                Some("tool_use") => {
                    let name = b["name"].as_str().unwrap_or("tool").to_string();
                    let input = b["input"].clone();
                    o.ev(ChatEventKind::ToolStart {
                        id: b["id"].as_str().unwrap_or("").to_string(),
                        summary: tool_summary(&name, &input),
                        name,
                        input,
                        parent_tool_id: parent.clone(),
                    });
                }
                _ => {}
            }
        }
    }

    fn on_stream_event(&mut self, v: &Value, o: &mut Out) {
        let parent = v["parent_tool_use_id"].as_str().map(str::to_string);
        let e = &v["event"];
        match e["type"].as_str() {
            Some("message_start") if parent.is_none() => {
                let m = &e["message"];
                self.stream_msg = Some((m["id"].as_str().unwrap_or("").to_string(), m["model"].as_str().unwrap_or("").to_string()));
            }
            Some("content_block_start") if e["content_block"]["type"] == "text" => {
                let id = self.msg_id(v);
                *self.stream_blocks.entry(id).or_insert(0) += 1;
            }
            Some("content_block_delta") => {
                let d = &e["delta"];
                let id = self.msg_id(v);
                match d["type"].as_str() {
                    Some("text_delta") => {
                        let n = self.stream_blocks.get(&id).copied().unwrap_or(1);
                        let text = d["text"].as_str().unwrap_or("").to_string();
                        if !text.is_empty() {
                            o.ev(ChatEventKind::TextDelta { message_id: block_id(&id, n), text, parent_tool_id: parent });
                        }
                    }
                    // Often redacted (empty) with only a token estimate.
                    Some("thinking_delta") => {
                        let text = d["thinking"].as_str().unwrap_or("").to_string();
                        if !text.is_empty() {
                            o.ev(ChatEventKind::ThinkingDelta { message_id: id, text, parent_tool_id: parent });
                        }
                    }
                    _ => {}
                }
            }
            // Final usage of one model response.
            Some("message_delta") if parent.is_none() => {
                let u = &e["usage"];
                if !u.is_object() {
                    return;
                }
                let g = |k: &str| u[k].as_u64().unwrap_or(0);
                let fresh = g("input_tokens") + g("cache_creation_input_tokens");
                self.totals.input += fresh;
                self.totals.cached += g("cache_read_input_tokens");
                self.totals.output += g("output_tokens");
                let ctx = fresh + g("cache_read_input_tokens");
                if ctx > 0 {
                    self.totals.context = ctx;
                }
                let model = self.stream_msg.as_ref().map(|(_, m)| m.clone()).filter(|m| !m.is_empty()).unwrap_or_else(|| self.model.clone());
                let context_window = self.windows.get(&model).copied().or(self.context_max);
                o.ev(ChatEventKind::Usage { model, tokens: self.totals.clone(), context_window });
            }
            _ => {}
        }
    }

    /// The API message a stream event belongs to.
    fn msg_id(&self, v: &Value) -> String {
        v["api_message_id"].as_str().map(str::to_string).or_else(|| self.stream_msg.as_ref().map(|(id, _)| id.clone())).unwrap_or_default()
    }

    fn on_result(&mut self, v: &Value, o: &mut Out) {
        self.queued = self.queued.saturating_sub(1);
        let ok = v["is_error"].as_bool() != Some(true);
        if !ok && !self.interrupted {
            let text = v["result"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .or_else(|| v["errors"].as_array().map(|a| a.iter().filter_map(|e| e.as_str()).collect::<Vec<_>>().join("\n")).filter(|s| !s.is_empty()))
                .unwrap_or_else(|| v["subtype"].as_str().unwrap_or("error").replace('_', " "));
            // Often already reported by the error message that preceded the result.
            if self.last_error.as_deref() != Some(text.as_str()) {
                o.ev(error_notice(text));
            }
        }
        self.last_error = None;
        if self.queued == 0 {
            self.interrupted = false;
        }
        if let Some(mu) = v["modelUsage"].as_object() {
            for (m, u) in mu {
                if let Some(w) = u["contextWindow"].as_u64() {
                    self.windows.insert(m.clone(), w);
                }
            }
            self.ready(o);
        }
        o.ev(ChatEventKind::TurnEnd { duration_ms: v["duration_ms"].as_u64().unwrap_or(0), ok });
        self.perms.clear();
        o.ev(ChatEventKind::State { state: self.working_or_idle() });
        self.stream_blocks.clear();
        self.final_blocks.clear();
    }
}

/// Errors that only the TUI can fix (logging in) say so.
fn error_notice(text: String) -> ChatEventKind {
    let needs_terminal = text.contains("/login");
    ChatEventKind::Notice { level: NoticeLevel::Error, text, needs_terminal }
}

/// `AskUserQuestion` input -> questions.
fn parse_questions(input: &Value) -> Vec<Question> {
    input["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(i, q)| {
            let question = q["question"].as_str()?.to_string();
            let options = q["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|o| Some(QuestionOption { label: o["label"].as_str()?.to_string(), description: o["description"].as_str().unwrap_or("").to_string() }))
                .collect();
            Some(Question {
                id: i.to_string(),
                header: q["header"].as_str().unwrap_or("").to_string(),
                question,
                options,
                multi_select: q["multiSelect"].as_bool().unwrap_or(false),
                // Claude Code always offers "Other" with a typed answer.
                allow_other: true,
                secret: false,
            })
        })
        .collect()
}

fn block_id(msg: &str, n: u32) -> String {
    if n <= 1 { msg.to_string() } else { format!("{msg}:{n}") }
}

/// `["a", ...]` or `[{"name": "a"}, ...]` -> names.
fn names(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().or_else(|| x["name"].as_str()).map(str::to_string)).collect())
        .unwrap_or_default()
}

/// tool_result content is a string or a list of content blocks.
fn result_text(c: &Value) -> String {
    if let Some(s) = c.as_str() {
        return s.to_string();
    }
    c.as_array().map(|a| a.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default()
}

use serde_json::json;

impl Backend for Claude {
    fn start(&mut self, o: &mut Out) {
        self.request(json!({"subtype": "initialize", "hooks": null}), Pending::Init, o);
        self.request(json!({"subtype": "get_context_usage"}), Pending::Context, o);
    }

    fn on_line(&mut self, line: &str, o: &mut Out) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            o.ev(ChatEventKind::notice(NoticeLevel::Info, line));
            return;
        };
        match v["type"].as_str() {
            Some("control_response") => self.on_control_response(&v["response"], o),
            Some("control_request") => {
                let rid = v["request_id"].as_str().unwrap_or("").to_string();
                let req = &v["request"];
                if req["subtype"] == "can_use_tool" {
                    let tool = req["tool_name"].as_str().unwrap_or("tool").to_string();
                    let input = req["input"].clone();
                    let questions = if tool == "AskUserQuestion" { parse_questions(&input) } else { Vec::new() };
                    let question = !questions.is_empty();
                    self.perms.insert(rid.clone(), Perm { tool: tool.clone(), input: input.clone(), suggestions: req["permission_suggestions"].clone(), question });
                    if question {
                        o.ev(ChatEventKind::Question { request_id: rid, questions });
                    } else {
                        let summary = tool_summary(&tool, &input);
                        o.ev(ChatEventKind::PermissionRequest { request_id: rid, tool, summary, input });
                    }
                    o.ev(ChatEventKind::State { state: ChatState::WaitingPermission });
                } else {
                    // Nothing else is registered by us (no hooks, no SDK MCP servers):
                    // decline so the CLI never waits on us.
                    o.write(&json!({"type": "control_response", "response": {"subtype": "error", "request_id": rid, "error": "not supported by coool"}}));
                }
            }
            Some("control_cancel_request") => {
                if let Some(id) = v["request_id"].as_str() {
                    self.perms.remove(id);
                }
                o.ev(ChatEventKind::State { state: self.working_or_idle() });
            }
            Some("system") => match v["subtype"].as_str() {
                Some("init") => {
                    if let Some(s) = v["session_id"].as_str() {
                        self.session_id = s.to_string();
                    }
                    if let Some(m) = v["model"].as_str() {
                        self.model = m.to_string();
                    }
                    if let Some(m) = v["permissionMode"].as_str() {
                        self.permission_mode = m.to_string();
                    }
                    if v["terminal_slash_commands"].is_array() {
                        self.terminal_commands = names(&v["terminal_slash_commands"]);
                    }
                    if v["skills"].is_array() {
                        self.skills = names(&v["skills"]);
                    }
                    if let Ok(mut k) = KNOWN_KINDS.lock() {
                        *k = Some((self.skills.clone(), self.terminal_commands.clone()));
                    }
                    if self.agents.is_empty() {
                        self.agents = names(&v["agents"]);
                    }
                    // (The context-usage answer still completes the first `ready`.)
                    self.init_done = true;
                    self.ready(o);
                }
                Some("status") => {
                    if let Some(m) = v["permissionMode"].as_str() {
                        self.permission_mode = m.to_string();
                        self.ready(o);
                    }
                }
                Some("compact_boundary") => o.ev(ChatEventKind::notice(NoticeLevel::Info, "Conversation compacted")),
                Some("api_retry") => {
                    let n = v["attempt"].as_u64().map(|n| format!(" (attempt {n})")).unwrap_or_default();
                    o.ev(ChatEventKind::notice(NoticeLevel::Warn, format!("API error, retrying{n}")));
                }
                _ => {}
            },
            Some("stream_event") => self.on_stream_event(&v, o),
            Some("assistant") => self.on_assistant(&v, o),
            Some("user") => {
                if v["isReplay"].as_bool() == Some(true) {
                    return;
                }
                for b in v["message"]["content"].as_array().into_iter().flatten() {
                    if b["type"] == "tool_result" {
                        o.ev(ChatEventKind::ToolEnd {
                            id: b["tool_use_id"].as_str().unwrap_or("").to_string(),
                            ok: b["is_error"].as_bool() != Some(true),
                            output: clip(&result_text(&b["content"]), MAX_OUTPUT),
                        });
                    }
                }
            }
            Some("result") => self.on_result(&v, o),
            Some("rate_limit_event") => {
                let info = &v["rate_limit_info"];
                if info["status"] == "rejected" {
                    o.ev(ChatEventKind::notice(NoticeLevel::Error, "Usage limit reached"));
                }
            }
            _ => {}
        }
    }

    fn send(&mut self, text: &str, o: &mut Out) -> Result<()> {
        if let Some((name, _)) = slash_command(text)
            && self.terminal_commands.iter().any(|c| c == name)
        {
            o.ev(ChatEventKind::needs_terminal(format!("/{name} only works in the terminal")));
            return Ok(());
        }
        self.user_n += 1;
        o.write(&json!({"type": "user", "message": {"role": "user", "content": text}, "parent_tool_use_id": null, "session_id": ""}));
        o.ev(ChatEventKind::UserMessage { id: format!("u{}", self.user_n), text: text.to_string() });
        self.queued += 1;
        o.ev(ChatEventKind::State { state: self.working_or_idle() });
        Ok(())
    }

    fn interrupt(&mut self, o: &mut Out) -> Result<()> {
        if self.queued == 0 {
            return Ok(());
        }
        self.interrupted = true;
        self.request(json!({"subtype": "interrupt"}), Pending::Interrupt, o);
        // The CLI abandons its open permission prompts with the turn.
        self.perms.clear();
        o.ev(ChatEventKind::State { state: self.working_or_idle() });
        Ok(())
    }

    fn set_model(&mut self, model: &str, o: &mut Out) -> Result<()> {
        self.request(json!({"subtype": "set_model", "model": model}), Pending::SetModel(model.to_string()), o);
        Ok(())
    }

    fn set_permission_mode(&mut self, mode: &str, o: &mut Out) -> Result<()> {
        self.request(json!({"subtype": "set_permission_mode", "mode": mode}), Pending::SetMode(mode.to_string()), o);
        Ok(())
    }

    fn respond_permission(&mut self, request_id: &str, allow: bool, always: bool, o: &mut Out) -> Result<()> {
        let Some(p) = self.perms.remove(request_id) else { bail!("no pending permission request {request_id}") };
        let answer = if allow {
            let mut a = json!({"behavior": "allow", "updatedInput": p.input});
            if always {
                // The CLI's own "don't ask again" options (e.g. a rule for this
                // command, or acceptEdits for the session); else a session rule for the tool.
                let rules = match p.suggestions.as_array() {
                    Some(s) if !s.is_empty() => p.suggestions.clone(),
                    _ => json!([{"type": "addRules", "rules": [{"toolName": p.tool}], "behavior": "allow", "destination": "session"}]),
                };
                a["updatedPermissions"] = rules;
            }
            a
        } else if p.question {
            json!({"behavior": "deny", "message": "The user declined to answer."})
        } else {
            json!({"behavior": "deny", "message": "The user denied this tool call."})
        };
        o.write(&json!({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": answer}}));
        o.ev(ChatEventKind::State { state: self.working_or_idle() });
        Ok(())
    }

    fn respond_question(&mut self, request_id: &str, answers: &[Vec<String>], o: &mut Out) -> Result<()> {
        if !self.perms.get(request_id).is_some_and(|p| p.question) {
            bail!("no pending question {request_id}");
        }
        let p = self.perms.get(request_id).expect("checked");
        // Observed (Claude Code 2.1.x): `updatedInput.answers` maps each
        // question's text to its answer; several picks are joined with ", ",
        // a typed answer is passed as is. The tool result then reads
        // `"<question>"="<answer>"` for the model.
        let mut map = serde_json::Map::new();
        for (q, a) in p.input["questions"].as_array().into_iter().flatten().zip(answers) {
            let text: Vec<&str> = a.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
            if let (Some(qt), false) = (q["question"].as_str(), text.is_empty()) {
                map.insert(qt.to_string(), Value::String(text.join(", ")));
            }
        }
        if map.is_empty() {
            bail!("answer at least one question, or decline");
        }
        let mut input = p.input.clone();
        input["answers"] = Value::Object(map);
        self.perms.remove(request_id);
        let answer = json!({"behavior": "allow", "updatedInput": input});
        o.write(&json!({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": answer}}));
        o.ev(ChatEventKind::State { state: self.working_or_idle() });
        Ok(())
    }

    fn on_exit(&mut self, o: &mut Out) {
        self.perms.clear();
        if self.queued > 0 {
            self.queued = 0;
            o.ev(ChatEventKind::TurnEnd { duration_ms: 0, ok: false });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::testutil::replay;

    fn opts() -> ChatOptions {
        ChatOptions { provider: Provider::Claude, cwd: "/work".into(), resume: None, model: Some("haiku".into()), permission_mode: None }
    }

    fn kinds(evs: &[ChatEventKind]) -> Vec<String> {
        evs.iter().map(|e| serde_json::to_value(e).unwrap()["type"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn args_pin_session_id_and_route_permissions_to_us() {
        let c = Claude::new(&opts());
        let a = c.args();
        let has = |x: &str, y: &str| a.windows(2).any(|w| w[0] == x && w[1] == y);
        assert!(has("--permission-prompt-tool", "stdio"));
        assert!(has("--session-id", &c.session_id));
        assert!(has("--model", "haiku"));
        assert!(!a.contains(&"--permission-mode".to_string()));
        let mut r = opts();
        r.resume = Some("abc".into());
        r.permission_mode = Some("plan".into());
        let a = Claude::new(&r).args();
        assert!(a.windows(2).any(|w| w[0] == "--resume" && w[1] == "abc"));
        assert!(a.windows(2).any(|w| w[0] == "--permission-mode" && w[1] == "plan"));
        assert!(!a.contains(&"--session-id".to_string()));
    }

    /// Real run: initialize, a Write that needs permission (allowed), then a
    /// subagent (Agent tool) whose Bash call nests under it.
    #[test]
    fn fixture_permission_and_subagent() {
        let mut c = Claude::new(&opts());
        let evs = replay(&mut c, include_str!("fixtures/claude_permission_subagent.jsonl"));
        let k = kinds(&evs);
        assert_eq!(k[0], "ready");
        let ChatEventKind::Ready { slash_commands, models, agents, .. } = &evs[0] else { panic!() };
        assert!(slash_commands.iter().any(|c| c.name == "compact"));
        assert!(!slash_commands.iter().any(|c| c.name.starts_with("__")));
        assert!(models.iter().any(|m| m.id == "haiku"));
        assert!(agents.iter().any(|a| a == "general-purpose"));

        // Permission request for Write, with a usable summary and input.
        let perm = evs.iter().find_map(|e| match e {
            ChatEventKind::PermissionRequest { request_id, tool, summary, input } => Some((request_id.clone(), tool.clone(), summary.clone(), input.clone())),
            _ => None,
        });
        let (rid, tool, summary, input) = perm.expect("permission_request");
        assert_eq!(tool, "Write");
        assert!(summary.starts_with("Write · "), "{summary}");
        assert_eq!(input["content"], "ok");
        assert!(c.perms.is_empty() || c.perms.contains_key(&rid));

        // Subagent: Agent tool_start at top level, its Bash nests under it.
        let tools: Vec<(String, String, Option<String>)> = evs
            .iter()
            .filter_map(|e| match e {
                ChatEventKind::ToolStart { id, name, parent_tool_id, .. } => Some((id.clone(), name.clone(), parent_tool_id.clone())),
                _ => None,
            })
            .collect();
        let agent = tools.iter().find(|t| t.1 == "Agent").expect("Agent tool");
        assert_eq!(agent.2, None);
        let bash = tools.iter().find(|t| t.1 == "Bash").expect("subagent Bash");
        assert_eq!(bash.2.as_deref(), Some(agent.0.as_str()));
        assert!(evs.iter().any(|e| matches!(e, ChatEventKind::ToolEnd { id, ok: true, .. } if *id == bash.0)));

        // Streamed text matches the final block it is replaced by.
        for (mid, full) in evs.iter().filter_map(|e| match e {
            ChatEventKind::AssistantMessage { id, text, parent_tool_id: None, .. } => Some((id.clone(), text.clone())),
            _ => None,
        }) {
            let streamed: String = evs
                .iter()
                .filter_map(|e| match e {
                    ChatEventKind::TextDelta { message_id, text, .. } if *message_id == mid => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            assert_eq!(streamed, full);
        }
        // Subagent text arrives as final messages with the parent set.
        assert!(evs.iter().any(|e| matches!(e, ChatEventKind::AssistantMessage { parent_tool_id: Some(p), .. } if *p == agent.0)));

        // Allow once, deny, always (the CLI's suggestion: acceptEdits for the
        // session, announced in a new `ready`), then the subagent turn.
        assert_eq!(k.iter().filter(|t| *t == "permission_request").count(), 3);
        assert_eq!(k.iter().filter(|t| *t == "turn_end").count(), 4);
        assert!(evs.iter().all(|e| !matches!(e, ChatEventKind::TurnEnd { ok: false, .. })));
        assert!(evs.iter().any(|e| matches!(e, ChatEventKind::ToolEnd { ok: false, .. })), "the denied Write");
        assert!(evs.iter().any(|e| matches!(e, ChatEventKind::Ready { permission_mode, .. } if permission_mode == "acceptEdits")));
        let u = evs.iter().rev().find_map(|e| match e {
            ChatEventKind::Usage { model, tokens, context_window } => Some((model.clone(), tokens.clone(), *context_window)),
            _ => None,
        });
        let (model, tokens, window) = u.expect("usage");
        assert_eq!(model, "claude-haiku-5-5");
        assert!(tokens.output > 0 && tokens.context > 0);
        assert_eq!(window, Some(1_000_000));
        assert_eq!(c.queued, 0);
        assert_eq!(c.working_or_idle(), ChatState::Idle);
    }

    /// Real run: a turn interrupted mid-stream, then set_model and
    /// set_permission_mode, then a turn on the new model.
    #[test]
    fn fixture_interrupt_and_model_switch() {
        let mut c = Claude::new(&opts());
        let evs = replay(&mut c, include_str!("fixtures/claude_interrupt_set_model.jsonl"));
        let ends: Vec<bool> = evs.iter().filter_map(|e| if let ChatEventKind::TurnEnd { ok, .. } = e { Some(*ok) } else { None }).collect();
        assert!(ends.contains(&false), "the interrupted turn ends not ok");
        // Interrupt is not reported as an error.
        assert!(!evs.iter().any(|e| matches!(e, ChatEventKind::Notice { level: NoticeLevel::Error, .. })));
        let readies: Vec<(String, String)> = evs
            .iter()
            .filter_map(|e| if let ChatEventKind::Ready { model, permission_mode, .. } = e { Some((model.clone(), permission_mode.clone())) } else { None })
            .collect();
        assert!(readies.iter().any(|(m, _)| m == "claude-haiku-4-5-20251001"), "{readies:?}");
        assert_eq!(readies.last().unwrap().1, "acceptEdits");
        let last_text = evs.iter().rev().find_map(|e| if let ChatEventKind::AssistantMessage { text, model, .. } = e { Some((text.clone(), model.clone())) } else { None });
        assert_eq!(last_text, Some(("ok".into(), "claude-haiku-4-5-20251001".into())));
    }

    /// Real run: local slash commands in stream-json mode.
    #[test]
    fn fixture_slash_commands() {
        let mut c = Claude::new(&opts());
        let evs = replay(&mut c, include_str!("fixtures/claude_slash_commands.jsonl"));
        let notices: Vec<(String, bool)> = evs
            .iter()
            .filter_map(|e| if let ChatEventKind::Notice { text, needs_terminal, .. } = e { Some((text.clone(), *needs_terminal)) } else { None })
            .collect();
        let term: Vec<&str> = notices.iter().filter(|n| n.1).map(|n| n.0.as_str()).collect();
        assert!(term.iter().any(|t| t.starts_with("/login")), "{term:?}");
        assert!(term.iter().any(|t| t.starts_with("/help")));
        // /context and /cost run and print, they are not terminal-only.
        assert!(notices.iter().any(|n| !n.1 && n.0.contains("Context Usage")));
        assert!(notices.iter().any(|n| !n.1 && n.0.starts_with("Set model to")));
        // The CLI's own list, from system/init.
        assert!(c.terminal_commands.iter().any(|t| t == "send-to-project"), "{:?}", c.terminal_commands);
        // Commands the CLI says need the TUI are answered locally, never sent.
        let mut o = Out::default();
        c.send("/doctor", &mut o).unwrap();
        assert!(o.writes.is_empty());
        assert!(matches!(o.events[0], ChatEventKind::Notice { needs_terminal: true, .. }));
    }

    #[test]
    fn permission_answers() {
        let mut c = Claude::new(&opts());
        let mut o = Out::default();
        let req = |id: &str, sugg: &str| format!(r#"{{"type":"control_request","request_id":"{id}","request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{{"command":"rm x"}},"permission_suggestions":{sugg}}}}}"#);
        c.on_line(&req("p1", r#"[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"rm x"}],"behavior":"allow","destination":"localSettings"}]"#), &mut o);
        c.on_line(&req("p2", "[]"), &mut o);
        c.on_line(&req("p3", "null"), &mut o);
        assert!(matches!(o.events.last(), Some(ChatEventKind::State { state: ChatState::WaitingPermission })));
        let mut o = Out::default();
        c.respond_permission("p1", true, true, &mut o).unwrap();
        c.respond_permission("p2", true, true, &mut o).unwrap();
        c.respond_permission("p3", false, false, &mut o).unwrap();
        assert!(c.respond_permission("p3", true, false, &mut o).is_err());
        let w: Vec<Value> = o.writes.iter().map(|w| serde_json::from_str(w).unwrap()).collect();
        assert_eq!(w[0]["response"]["request_id"], "p1");
        assert_eq!(w[0]["response"]["response"]["updatedPermissions"][0]["rules"][0]["ruleContent"], "rm x");
        assert_eq!(w[0]["response"]["response"]["updatedInput"]["command"], "rm x");
        assert_eq!(w[1]["response"]["response"]["updatedPermissions"][0]["destination"], "session");
        assert_eq!(w[2]["response"]["response"]["behavior"], "deny");
        assert!(w[2]["response"]["response"]["updatedPermissions"].is_null());
    }

    #[test]
    fn login_error_is_reported_once_and_points_to_the_terminal() {
        let mut c = Claude::new(&opts());
        let mut o = Out::default();
        c.send("hi", &mut o).unwrap();
        c.on_line(r#"{"type":"assistant","message":{"id":"x","model":"<synthetic>","content":[{"type":"text","text":"Not logged in · Please run /login"}]},"error":"authentication_failed"}"#, &mut o);
        c.on_line(r#"{"type":"result","subtype":"success","is_error":true,"duration_ms":5,"result":"Not logged in · Please run /login"}"#, &mut o);
        let notices: Vec<_> = o.events.iter().filter(|e| matches!(e, ChatEventKind::Notice { level: NoticeLevel::Error, needs_terminal: true, .. })).collect();
        assert_eq!(notices.len(), 1);
        assert!(matches!(o.events.last(), Some(ChatEventKind::State { state: ChatState::Idle })));
    }

    /// Shapes observed from Claude Code 2.1.325: `can_use_tool` for
    /// `AskUserQuestion`, answered through `updatedInput.answers`.
    #[test]
    fn ask_user_question_becomes_a_question_and_is_answered() {
        let mut c = Claude::new(&opts());
        let mut o = Out::default();
        c.send("ask me", &mut o).unwrap();
        let req = r#"{"type":"control_request","request_id":"q1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion","input":{"questions":[{"question":"Which fruits?","header":"Fruits","options":[{"label":"Apple","description":"Apple"},{"label":"Pear","description":"Pear"},{"label":"Plum","description":"Plum"}],"multiSelect":true},{"question":"Which size?","header":"Size","options":[{"label":"Small","description":""},{"label":"Large","description":""}],"multiSelect":false}]},"tool_use_id":"toolu_1","requires_user_interaction":true}}"#;
        let mut o = Out::default();
        c.on_line(req, &mut o);
        let ChatEventKind::Question { request_id, questions } = &o.events[0] else { panic!("{:?}", o.events) };
        assert_eq!(request_id, "q1");
        assert_eq!(questions.len(), 2);
        assert!(questions[0].multi_select && !questions[1].multi_select);
        assert_eq!((questions[0].header.as_str(), questions[0].options[1].label.as_str()), ("Fruits", "Pear"));
        assert!(matches!(o.events[1], ChatEventKind::State { state: ChatState::WaitingPermission }));
        assert!(!o.events.iter().any(|e| matches!(e, ChatEventKind::PermissionRequest { .. })));

        let mut o = Out::default();
        assert!(c.respond_question("q1", &[vec![], vec!["  ".into()]], &mut o).is_err(), "an empty answer is refused");
        c.respond_question("q1", &[vec!["Apple".into(), "Pear".into()], vec!["Large".into()]], &mut o).unwrap();
        let w: Value = serde_json::from_str(&o.writes[0]).unwrap();
        let r = &w["response"]["response"];
        assert_eq!(r["behavior"], "allow");
        assert_eq!(r["updatedInput"]["answers"], json!({"Which fruits?": "Apple, Pear", "Which size?": "Large"}));
        assert_eq!(r["updatedInput"]["questions"][0]["header"], "Fruits");
        assert!(matches!(o.events.last(), Some(ChatEventKind::State { state: ChatState::Working })));
        assert!(c.respond_question("q1", &[vec!["x".into()]], &mut o).is_err());

        // Declining goes through respond_permission.
        let mut o = Out::default();
        c.on_line(&req.replace("\"q1\"", "\"q2\""), &mut o);
        c.respond_permission("q2", false, false, &mut o).unwrap();
        let w: Value = serde_json::from_str(o.writes.last().unwrap()).unwrap();
        assert_eq!(w["response"]["response"], json!({"behavior": "deny", "message": "The user declined to answer."}));
        // A plain permission can't be answered as a question.
        c.on_line(r#"{"type":"control_request","request_id":"p1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}"#, &mut o);
        assert!(c.respond_question("p1", &[vec!["yes".into()]], &mut o).is_err());
    }

    #[test]
    fn commands_are_tagged_by_where_they_run() {
        let mut c = Claude::new(&opts());
        let evs = replay(&mut c, include_str!("fixtures/claude_slash_commands.jsonl"));
        let cmds = evs
            .iter()
            .rev()
            .find_map(|e| if let ChatEventKind::Commands { commands } = e { Some(commands.clone()) } else { None })
            .expect("commands event");
        let kind = |n: &str| cmds.iter().find(|c| c.name == n).map(|c| c.kind);
        assert!(cmds.len() > 60, "{}", cmds.len());
        assert_eq!(kind("compact"), Some(CommandKind::Command));
        assert_eq!(kind("doctor"), Some(CommandKind::Terminal));
        assert_eq!(kind("send-to-project"), Some(CommandKind::Terminal));
        assert_eq!(kind("dataviz"), Some(CommandKind::Skill));
        assert_eq!(kind("pdf"), Some(CommandKind::Skill));
        let clear = cmds.iter().find(|c| c.name == "clear").unwrap();
        assert!(clear.aliases.contains(&"reset".to_string()));
        assert!(!cmds.iter().any(|c| c.name.starts_with("__")));
        assert!(cmds.iter().find(|c| c.name == "effort").unwrap().argument_hint.contains("low"));
        // `ready` stays first; the commands follow it.
        assert!(matches!(evs[0], ChatEventKind::Ready { .. }));
        assert!(matches!(evs[1], ChatEventKind::Commands { .. }));
    }

    #[test]
    fn unknown_control_requests_are_declined() {
        let mut c = Claude::new(&opts());
        let mut o = Out::default();
        c.on_line(r#"{"type":"control_request","request_id":"h1","request":{"subtype":"hook_callback"}}"#, &mut o);
        let w: Value = serde_json::from_str(&o.writes[0]).unwrap();
        assert_eq!((w["response"]["subtype"].as_str(), w["response"]["request_id"].as_str()), (Some("error"), Some("h1")));
    }
}
