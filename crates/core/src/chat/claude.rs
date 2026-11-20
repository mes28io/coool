//! Claude Code over `claude -p --input-format stream-json --output-format stream-json`.
//!
//! Observed protocol (Claude Code 2.1.x):
//! - stdin: `{"type":"user","message":{"role":"user","content":"..."}}` per turn, and
//!   `{"type":"control_request","request_id","request":{"subtype": "initialize" |
//!   "interrupt" | "set_model" | "set_permission_mode" | "get_context_usage"}}`.
//!   Every user line carries a `uuid`; the CLI reports its fate with
//!   `command_lifecycle` (`queued` -> `started` -> `completed` | `cancelled` |
//!   `discarded` | `refused`). A line sent while a turn runs is queued by the
//!   CLI and taken into that same turn after the next tool result (no `result`
//!   of its own; the turn's `result.user_message_uuids` lists it); one still
//!   queued when the turn ends starts a turn of its own right after. A queued
//!   line can be withdrawn with `control_request` `cancel_async_message`.
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
    /// The interrupt for a `now` steering note.
    SteerCut,
    /// `cancel_async_message` for a note; `true` when the person asked.
    CancelNote(String, bool),
}

/// An interrupt sent for `now` notes: they go out once the CLI answered it
/// and the cut turn's `result` arrived.
#[derive(Default)]
struct Cut {
    acked: bool,
    ended: bool,
    /// The turn ended by the interrupt (not on its own just before).
    cut: bool,
}

/// One entry of the CLI's task list (`TaskCreate` / `TaskUpdate`).
#[derive(Clone)]
struct Task {
    id: String,
    subject: String,
    active_form: Option<String>,
    status: String,
}

struct Perm {
    tool: String,
    input: Value,
    /// Remember options with the `updatedPermissions` each one sends.
    remember: Vec<(RememberOption, Value)>,
    /// An `AskUserQuestion` call, answered with `respond_question`.
    question: bool,
}

/// Human names of Claude Code's permission modes.
pub(crate) fn mode_label(mode: &str) -> String {
    match mode {
        "default" => "Ask".into(),
        "acceptEdits" => "Accept edits".into(),
        "plan" => "Plan".into(),
        "bypassPermissions" => "Bypass".into(),
        "dontAsk" => "Don't ask".into(),
        "auto" => "Auto".into(),
        m => m.to_string(),
    }
}

/// `Tool(content)` rule -> plain words ("`npm test` commands", "reading /etc").
fn rule_phrase(tool: &str, content: Option<&str>) -> String {
    let Some(c) = content.filter(|c| !c.is_empty()) else { return format!("every {tool} call") };
    // `//abs`, `~/home` and `/relative-to-settings` path patterns.
    let path = |p: &str| {
        let p = p.strip_suffix("/**").or_else(|| p.strip_suffix("**")).unwrap_or(p);
        let p = if let Some(abs) = p.strip_prefix("//") { format!("/{abs}") } else { p.to_string() };
        if p.is_empty() { "/".to_string() } else { p }
    };
    match tool {
        "Bash" => {
            let prefix = c.strip_suffix(" *").or_else(|| c.strip_suffix(":*")).or_else(|| c.strip_suffix('*').map(str::trim_end));
            match prefix {
                Some(p) => format!("`{p}` commands"),
                None => format!("`{c}`"),
            }
        }
        "Read" | "Glob" | "Grep" => format!("reading {}", path(c)),
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => format!("editing {}", path(c)),
        "WebFetch" => format!("fetching from {}", c.strip_prefix("domain:").unwrap_or(c)),
        _ => format!("{tool}({c})"),
    }
}

/// Settings file a destination writes to, with how far it reaches.
fn destination(dest: &str) -> (RememberScope, Option<&'static str>) {
    match dest {
        "localSettings" => (RememberScope::Project, Some(".claude/settings.local.json")),
        "projectSettings" => (RememberScope::Project, Some(".claude/settings.json")),
        "userSettings" => (RememberScope::User, Some("~/.claude/settings.json")),
        // `session`, `cliArg`: this process only.
        _ => (RememberScope::Chat, None),
    }
}

/// The CLI's `permission_suggestions` -> remember options: one per
/// destination (entries for one destination are applied together, as the
/// CLI's own prompt does), and a this-chat-only twin before any persistent
/// rule, so remembering never has to mean writing a settings file.
fn remember_options(suggestions: &Value, cwd: &str) -> Vec<(RememberOption, Value)> {
    let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
    for s in suggestions.as_array().into_iter().flatten() {
        let ok = match s["type"].as_str() {
            Some("addRules") | Some("replaceRules") => s["behavior"] == "allow" && s["rules"].as_array().is_some_and(|r| !r.is_empty()),
            Some("setMode") => s["mode"].is_string(),
            Some("addDirectories") => s["directories"].as_array().is_some_and(|d| !d.is_empty()),
            _ => false,
        };
        if !ok {
            continue;
        }
        let dest = s["destination"].as_str().unwrap_or("session").to_string();
        match groups.iter_mut().find(|g| g.0 == dest) {
            Some(g) => g.1.push(s.clone()),
            None => groups.push((dest, vec![s.clone()])),
        }
    }
    let mut out: Vec<(RememberOption, Value)> = Vec::new();
    let add = |dest: &str, entries: &[Value], out: &mut Vec<(RememberOption, Value)>| {
        let (scope, file) = destination(dest);
        let mut phrases: Vec<String> = Vec::new();
        let mut rules: Vec<String> = Vec::new();
        let mut mode = None;
        for e in entries {
            match e["type"].as_str() {
                Some("setMode") => mode = e["mode"].as_str().map(str::to_string),
                Some("addDirectories") => {
                    // The chat's own folder (often its realpath, /private/tmp for /tmp) reads as "this folder".
                    let norm = |p: &str| p.trim_end_matches('/').trim_start_matches("/private").to_string();
                    let d: Vec<String> = names(&e["directories"]).iter().map(|d| if norm(d) == norm(cwd) { "this folder".to_string() } else { crate::util::home_short(d) }).collect();
                    phrases.push(format!("working in {}", d.join(", ")));
                }
                _ => {
                    for r in e["rules"].as_array().into_iter().flatten() {
                        let tool = r["toolName"].as_str().unwrap_or("tool");
                        let content = r["ruleContent"].as_str();
                        phrases.push(rule_phrase(tool, content));
                        rules.push(match content {
                            Some(c) if !c.is_empty() => format!("{tool}({c})"),
                            _ => tool.to_string(),
                        });
                    }
                }
            }
        }
        let where_ = match (scope, dest) {
            (RememberScope::Chat, _) => "in this chat",
            (RememberScope::User, _) => "in every project",
            _ => "in this project",
        };
        let saved = file.map(|f| match scope {
            RememberScope::User => format!("Saved to {f}: applies to every future session in any folder, including ones outside coool."),
            _ => format!("Saved to {f} in this folder: applies to future sessions here too, including ones outside coool."),
        });
        let (label, detail) = match (&mode, phrases.is_empty()) {
            // A mode switch (alone, or bundled with rules/folders) is named by the mode: it's the bigger change.
            (Some(m), _) if scope == RememberScope::Chat => {
                let label = match m.as_str() {
                    "acceptEdits" => "Allow all edits in this chat".to_string(),
                    "bypassPermissions" => "Allow everything in this chat".to_string(),
                    m => format!("Switch this chat to {}", mode_label(m)),
                };
                let what = if m == "acceptEdits" { ": later file edits, and file commands such as mkdir, mv or rm, run without asking" } else { "" };
                let also = if phrases.is_empty() { String::new() } else { format!(" Also allows {}.", phrases.join(" and ")) };
                (label, format!("Switches this chat to {} mode{what}.{also} Nothing is saved.", mode_label(m)))
            }
            (Some(m), true) => (format!("Always start in {} mode {where_}", mode_label(m)), saved.clone().unwrap_or_default()),
            _ => {
                let verb = if scope == RememberScope::Chat { "Allow" } else { "Always allow" };
                let also = mode.as_deref().map(|m| format!("Also switches to {} mode. ", mode_label(m))).unwrap_or_default();
                let detail = saved.clone().unwrap_or_else(|| "For this chat only; nothing is saved.".to_string());
                (format!("{verb} {} {where_}", phrases.join(" and ")), format!("{also}{detail}"))
            }
        };
        let updated: Vec<Value> = entries
            .iter()
            .map(|e| {
                let mut e = e.clone();
                e["destination"] = json!(dest);
                e
            })
            .collect();
        let option = RememberOption { id: out.len().to_string(), label, detail, scope, file: file.map(str::to_string), mode, rules };
        if !out.iter().any(|(o, _)| o.label == option.label) {
            out.push((option, Value::Array(updated)));
        }
    };
    let persistent = |d: &str| destination(d).0 != RememberScope::Chat;
    for (dest, entries) in groups.iter().filter(|g| !persistent(&g.0)) {
        add(dest, entries, &mut out);
    }
    for (_, entries) in groups.iter().filter(|g| persistent(&g.0)) {
        // Rules and directories can live in the session instead; a saved mode can't.
        let twin: Vec<Value> = entries.iter().filter(|e| e["type"] != "setMode").cloned().collect();
        if !twin.is_empty() {
            add("session", &twin, &mut out);
        }
    }
    for (dest, entries) in groups.iter().filter(|g| persistent(&g.0)) {
        add(dest, entries, &mut out);
    }
    // Narrowest first: this-chat rules before a this-chat mode switch, then saved rules.
    out.sort_by_key(|(o, _)| (o.persistent(), o.mode.is_some()));
    for (i, (o, _)) in out.iter_mut().enumerate() {
        o.id = i.to_string();
    }
    out
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
    /// Output estimate for the response now streaming.
    live: LiveOutput,
    /// Last reported subagent totals, by launching tool id.
    agent_totals: HashMap<String, u64>,
    user_n: u64,
    /// uuids of user lines written and not yet answered (by a `result` or a
    /// terminal `command_lifecycle`): the chat is working while any is left.
    cmds: Vec<String>,
    interrupted: bool,
    /// A turn is running (`command_lifecycle` `started` seen, no `result` yet).
    turn_live: bool,
    /// Main-thread tool calls without their result, oldest first.
    open_tools: Vec<String>,
    /// The main-thread tool whose result came last this turn.
    last_tool_end: Option<String>,
    notes: Notes,
    cut: Option<Cut>,
    /// `interrupt()` (Stop) was called: notes held for this turn end unused.
    stopping: bool,
    /// The task list as `TaskCreate` / `TaskUpdate` left it.
    tasks: Vec<Task>,
    /// Task tool calls waiting for their result: tool_use id -> (name, input).
    task_calls: HashMap<String, (String, Value)>,
    /// `Artifact` publish calls waiting for their result, by tool id (their input).
    artifact_calls: HashMap<String, Value>,
    /// Last error shown this turn, so the turn's `result` doesn't repeat it.
    last_error: Option<String>,
    /// The CLI said `status: compacting` and hasn't moved on yet.
    compacting: bool,
}

/// `--mcp-config=<json>` (the `=` form: the flag takes several values and would swallow what follows) and, for servers
/// whose tools are pre-approved, `--allowedTools=mcp__<name>`.
pub(crate) fn mcp_args(servers: &[super::McpServer]) -> Vec<String> {
    if servers.is_empty() {
        return Vec::new();
    }
    let mut map = serde_json::Map::new();
    for s in servers {
        let env: serde_json::Map<String, Value> = s.env.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
        map.insert(s.name.clone(), json!({ "type": "stdio", "command": s.command, "args": s.args, "env": env }));
    }
    let mut a = vec![format!("--mcp-config={}", json!({ "mcpServers": map }))];
    let allowed: Vec<String> = servers.iter().filter(|s| s.allow_all).map(|s| format!("mcp__{}", s.name)).collect();
    if !allowed.is_empty() {
        a.push(format!("--allowedTools={}", allowed.join(",")));
    }
    a
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
            live: LiveOutput::default(),
            agent_totals: HashMap::new(),
            user_n: 0,
            cmds: Vec::new(),
            interrupted: false,
            turn_live: false,
            open_tools: Vec::new(),
            last_tool_end: None,
            notes: Notes::default(),
            cut: None,
            stopping: false,
            tasks: Vec::new(),
            task_calls: HashMap::new(),
            artifact_calls: HashMap::new(),
            last_error: None,
            compacting: false,
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
            // Bypass stays something the person can switch to later (the mode menu, "Allow everything in this chat");
            // without this the CLI refuses `set_permission_mode` to bypassPermissions in a chat started in any other
            // mode ("the session was not launched with --dangerously-skip-permissions"). It turns nothing on by itself.
            "--allow-dangerously-skip-permissions",
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
        } else if !self.cmds.is_empty() {
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
                Pending::SteerCut => {
                    // The turn goes on; the notes go out when it ends.
                    if let Some(c) = self.cut.as_mut() {
                        c.acked = true;
                    }
                    self.flush_cut(o);
                    "interrupt the step for the note".to_string()
                }
                Pending::CancelNote(..) => "withdraw the note".to_string(),
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
                // The skills, known here before any turn (system/init only comes with the first one).
                if let Some(fm) = res["skills"]["skillFrontmatter"].as_array() {
                    let skills: Vec<String> = fm.iter().filter_map(|f| f["name"].as_str().map(str::to_string)).collect();
                    if !skills.is_empty() {
                        self.skills = skills;
                        if let Ok(mut k) = KNOWN_KINDS.lock() {
                            let terminal = k.as_ref().map(|k| k.1.clone()).unwrap_or_else(|| self.terminal_commands.clone());
                            *k = Some((self.skills.clone(), terminal));
                        }
                    }
                }
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
            Pending::SteerCut => {
                if let Some(c) = self.cut.as_mut() {
                    c.acked = true;
                }
                self.flush_cut(o);
            }
            Pending::CancelNote(id, asked) => {
                if res["cancelled"] == true {
                    // (The `cancelled` lifecycle frame says the same; whichever comes first.)
                    let state = if asked { SteerState::Cancelled } else { SteerState::Unused };
                    self.notes.settle(&id, state, None, &mut self.user_n, o);
                } else if let Some(n) = self.notes.get(&id) {
                    n.cancelling = false;
                    if asked {
                        o.ev(ChatEventKind::notice(NoticeLevel::Warn, "Too late to withdraw the note: the agent already has it"));
                    }
                }
            }
        }
    }

    /// A `TaskCreate` / `TaskUpdate` call succeeded: update the list and show
    /// all of it as a `TodoWrite` step (`input._synthetic: true`), the shape
    /// the CLI's older `TodoWrite` tool has, so a UI needs no task ids.
    fn on_task_result(&mut self, call: &str, name: &str, input: &Value, result: &Value, text: &str, o: &mut Out) {
        let s = |v: &Value| v.as_str().map(str::to_string);
        if name == "TaskCreate" {
            // Observed (2.1.325): `tool_use_result.task.id`, and "Task #1 created successfully: ..." as text.
            let id = s(&result["task"]["id"])
                .or_else(|| text.strip_prefix("Task #").and_then(|r| r.split(|c: char| !c.is_ascii_digit()).next()).filter(|d| !d.is_empty()).map(str::to_string));
            let Some(id) = id else { return };
            let subject = s(&input["subject"]).or_else(|| s(&result["task"]["subject"])).unwrap_or_default();
            self.tasks.retain(|t| t.id != id);
            self.tasks.push(Task { id, subject, active_form: s(&input["activeForm"]), status: "pending".into() });
        } else {
            let id = s(&input["taskId"]).or_else(|| input["taskId"].as_u64().map(|n| n.to_string())).unwrap_or_default();
            let Some(i) = self.tasks.iter().position(|t| t.id == id) else { return };
            if let Some(st) = s(&input["status"]).or_else(|| s(&result["statusChange"]["to"])) {
                if st == "deleted" {
                    self.tasks.remove(i);
                } else {
                    self.tasks[i].status = st;
                }
            }
            if let Some(t) = self.tasks.get_mut(i).filter(|t| t.id == id) {
                if let Some(x) = s(&input["subject"]) {
                    t.subject = x;
                }
                if let Some(x) = s(&input["activeForm"]) {
                    t.active_form = Some(x);
                }
            }
        }
        let todos: Vec<Value> = self
            .tasks
            .iter()
            .map(|t| json!({"content": t.subject, "status": t.status, "activeForm": t.active_form.clone().unwrap_or_else(|| t.subject.clone())}))
            .collect();
        let done = self.tasks.iter().filter(|t| t.status == "completed").count();
        let id = format!("{call}:todos");
        o.ev(ChatEventKind::ToolStart {
            id: id.clone(),
            name: "TodoWrite".into(),
            summary: format!("TodoWrite · {done}/{} done", todos.len()),
            input: json!({"todos": todos, "_synthetic": true}),
            parent_tool_id: None,
        });
        o.ev(ChatEventKind::ToolEnd { id, ok: true, output: String::new(), artifact: None });
    }

    /// Notes held while the person was asked go out once nobody is asked.
    fn after_answer(&mut self, o: &mut Out) {
        self.start_cut(o);
        self.flush_notes(o);
    }

    /// One user line with a uuid the CLI reports on.
    fn write_user(&mut self, uuid: &str, text: &str, o: &mut Out) {
        o.write(&json!({"type": "user", "message": {"role": "user", "content": text}, "parent_tool_use_id": null, "session_id": "", "uuid": uuid}));
        self.cmds.push(uuid.to_string());
    }

    /// Hands held `next` notes to the CLI once a main-thread step is in
    /// flight: the CLI takes them in after that step's result. Held while a
    /// permission request or question is open, while `now` notes wait, and
    /// while no step runs (a turn that ends without another step leaves them unused).
    fn flush_notes(&mut self, o: &mut Out) {
        if !self.perms.is_empty() || self.cut.is_some() || self.open_tools.is_empty() || self.stopping {
            return;
        }
        let ids: Vec<(String, String)> = self.notes.list.iter().filter(|n| !n.sent && !n.now).map(|n| (n.id.clone(), n.text.clone())).collect();
        for (id, text) in ids {
            self.write_user(&id, &text, o);
            if let Some(n) = self.notes.get(&id) {
                n.sent = true;
            }
        }
    }

    /// Interrupt for held `now` notes (not while the person is being asked).
    fn start_cut(&mut self, o: &mut Out) {
        if self.cut.is_some() || !self.perms.is_empty() || self.cmds.is_empty() || !self.notes.list.iter().any(|n| n.now && !n.sent) {
            return;
        }
        let step = self.open_tools.last().cloned();
        for n in self.notes.list.iter_mut().filter(|n| n.now && !n.sent) {
            n.cut = step.clone();
        }
        self.interrupted = true;
        self.cut = Some(Cut::default());
        self.request(json!({"subtype": "interrupt"}), Pending::SteerCut, o);
    }

    /// The cut turn is over and the interrupt answered: every held note goes
    /// out now, `now` ones first; the first starts the next turn.
    fn flush_cut(&mut self, o: &mut Out) {
        let Some(c) = self.cut.as_ref() else { return };
        if !(c.acked && c.ended) {
            return;
        }
        let cut = c.cut;
        self.cut = None;
        let mut held: Vec<(String, String, bool)> = self.notes.list.iter().filter(|n| !n.sent).map(|n| (n.id.clone(), n.text.clone(), n.now)).collect();
        held.sort_by_key(|h| !h.2);
        for (id, text, _) in held {
            self.write_user(&id, &text, o);
            if let Some(n) = self.notes.get(&id) {
                n.sent = true;
                n.own_turn = true;
                // Ended on its own before the interrupt landed: nothing was cut.
                n.now = n.now && cut;
            }
        }
        o.ev(ChatEventKind::State { state: self.working_or_idle() });
    }

    fn on_lifecycle(&mut self, v: &Value, o: &mut Out) {
        let Some(uuid) = v["command_uuid"].as_str() else { return };
        match v["state"].as_str().unwrap_or("") {
            "started" => {
                let fold = self.turn_live;
                self.turn_live = true;
                let Some(n) = self.notes.get(uuid) else { return };
                let (state, tool) = if fold {
                    (SteerState::PickedUp, self.last_tool_end.clone())
                } else if n.now {
                    (SteerState::Interrupted, n.cut.clone())
                } else {
                    (SteerState::PickedUp, None)
                };
                self.notes.settle(uuid, state, tool, &mut self.user_n, o);
            }
            "queued" => {}
            terminal => {
                self.cmds.retain(|c| c != uuid);
                if let Some(n) = self.notes.get(uuid) {
                    // Withdrawn, swept by an interrupt, or dropped with the session.
                    let state = if n.cancelling && terminal == "cancelled" { SteerState::Cancelled } else { SteerState::Unused };
                    let _ = n;
                    self.notes.settle(uuid, state, None, &mut self.user_n, o);
                }
                o.ev(ChatEventKind::State { state: self.working_or_idle() });
            }
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
        if let Some(tool_id) = &parent {
            let u = &msg["usage"];
            let g = |k: &str| u[k].as_u64().unwrap_or(0);
            let ctx = g("input_tokens") + g("cache_creation_input_tokens") + g("cache_read_input_tokens");
            let total = ctx + g("output_tokens");
            if ctx > 0 && self.agent_totals.get(tool_id) != Some(&total) {
                self.agent_totals.insert(tool_id.clone(), total);
                o.ev(ChatEventKind::AgentTotal { tool_id: tool_id.clone(), tokens: total });
            }
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
                    let tid = b["id"].as_str().unwrap_or("").to_string();
                    if parent.is_none() && !tid.is_empty() {
                        self.open_tools.push(tid.clone());
                        if name == "TaskCreate" || name == "TaskUpdate" {
                            self.task_calls.insert(tid.clone(), (name.clone(), input.clone()));
                        }
                        if crate::artifact::is_publish(&name, &input) {
                            self.artifact_calls.insert(tid.clone(), input.clone());
                        }
                    }
                    o.ev(ChatEventKind::ToolStart {
                        id: tid,
                        summary: tool_summary(&name, &input),
                        name,
                        input,
                        parent_tool_id: parent.clone(),
                    });
                }
                _ => {}
            }
        }
        if parent.is_none() {
            self.flush_notes(o);
        }
    }

    fn on_stream_event(&mut self, v: &Value, o: &mut Out) {
        let parent = v["parent_tool_use_id"].as_str().map(str::to_string);
        let e = &v["event"];
        match e["type"].as_str() {
            Some("message_start") if parent.is_none() => {
                let m = &e["message"];
                self.stream_msg = Some((m["id"].as_str().unwrap_or("").to_string(), m["model"].as_str().unwrap_or("").to_string()));
                self.live.reset();
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
                            o.ev(ChatEventKind::TextDelta { message_id: block_id(&id, n), text, parent_tool_id: parent.clone() });
                        }
                    }
                    // Often redacted (empty) with only a token estimate.
                    Some("thinking_delta") => {
                        let text = d["thinking"].as_str().unwrap_or("").to_string();
                        if !text.is_empty() {
                            o.ev(ChatEventKind::ThinkingDelta { message_id: id, text, parent_tool_id: parent.clone() });
                        }
                    }
                    _ => {}
                }
                // Like Claude Code: count streamed characters (text, thinking, tool inputs) live.
                if parent.is_none() {
                    let chars = ["text", "thinking", "partial_json"].iter().filter_map(|k| d[*k].as_str()).map(|t| t.chars().count()).sum::<usize>();
                    if let Some(tokens) = self.live.push(chars, std::time::Instant::now()) {
                        o.ev(ChatEventKind::LiveOutput { tokens });
                    }
                }
            }
            // Final usage of one model response.
            Some("message_delta") if parent.is_none() => {
                let u = &e["usage"];
                if !u.is_object() {
                    return;
                }
                let g = |k: &str| u[k].as_u64().unwrap_or(0);
                self.live.reset();
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
        // The lines this turn answered; older CLIs (and our fixtures) list none
        // of ours: then the oldest.
        let mut answered: Vec<String> = v["user_message_uuids"].as_array().map(|a| a.iter().filter_map(|u| u.as_str().map(str::to_string)).collect()).unwrap_or_default();
        if let Some(u) = v["user_message_uuid"].as_str() {
            answered.push(u.to_string());
        }
        let before = self.cmds.len();
        self.cmds.retain(|c| !answered.contains(c));
        if self.cmds.len() == before && !self.cmds.is_empty() {
            self.cmds.remove(0);
        }
        // Without lifecycle frames, a note listed here was answered by this turn.
        let listed: Vec<String> = answered.into_iter().filter(|u| self.notes.list.iter().any(|n| n.sent && n.id == *u)).collect();
        for id in listed {
            self.notes.settle(&id, SteerState::PickedUp, None, &mut self.user_n, o);
        }
        self.turn_live = false;
        self.open_tools.clear();
        self.last_tool_end = None;
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
        if self.cmds.is_empty() {
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
        if self.stopping {
            self.stopping = false;
            self.cut = None;
            self.notes.unused(|n| !n.sent, o);
        } else if let Some(c) = self.cut.as_mut() {
            c.ended = true;
            c.cut = !ok;
            self.flush_cut(o);
        } else {
            // Still held: the turn ended before another step took them.
            self.notes.unused(|n| !n.sent, o);
        }
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

/// Live estimate of one streaming response's output tokens: ~4 characters per
/// token, reported at most every [`LiveOutput::EVERY`]. The exact usage at
/// `message_delta` replaces it (the `usage` event; see `reset`).
#[derive(Default)]
struct LiveOutput {
    chars: usize,
    last: Option<std::time::Instant>,
}

impl LiveOutput {
    const EVERY: std::time::Duration = std::time::Duration::from_millis(120);

    fn reset(&mut self) {
        self.chars = 0;
        self.last = None;
    }

    /// Adds streamed characters; the estimate to report now, if one is due.
    fn push(&mut self, chars: usize, now: std::time::Instant) -> Option<u64> {
        if chars == 0 {
            return None;
        }
        self.chars += chars;
        if self.last.is_some_and(|t| now.duration_since(t) < Self::EVERY) {
            return None;
        }
        self.last = Some(now);
        Some(self.chars.div_ceil(4) as u64)
    }
}

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
                    let remember = if question { Vec::new() } else { remember_options(&req["permission_suggestions"], &self.cwd) };
                    let options: Vec<RememberOption> = remember.iter().map(|(o, _)| o.clone()).collect();
                    self.perms.insert(rid.clone(), Perm { tool: tool.clone(), input: input.clone(), remember, question });
                    if question {
                        o.ev(ChatEventKind::Question { request_id: rid, questions });
                    } else {
                        let summary = tool_summary(&tool, &input);
                        o.ev(ChatEventKind::PermissionRequest { request_id: rid, tool, summary, input, remember: options });
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
                self.after_answer(o);
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
                    let compacting = v["status"] == "compacting";
                    if compacting != self.compacting {
                        self.compacting = compacting;
                        o.ev(ChatEventKind::Compacting { active: compacting });
                    }
                    if let Some(m) = v["permissionMode"].as_str() {
                        self.permission_mode = m.to_string();
                        self.ready(o);
                    }
                }
                Some("compact_boundary") => {
                    if std::mem::take(&mut self.compacting) {
                        o.ev(ChatEventKind::Compacting { active: false });
                    }
                    o.ev(ChatEventKind::notice(NoticeLevel::Info, "Conversation compacted"))
                }
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
                        let tid = b["tool_use_id"].as_str().unwrap_or("").to_string();
                        if let Some(i) = self.open_tools.iter().position(|t| *t == tid) {
                            self.open_tools.remove(i);
                            self.last_tool_end = Some(tid.clone());
                        }
                        let ok = b["is_error"].as_bool() != Some(true);
                        let artifact = self
                            .artifact_calls
                            .remove(&tid)
                            .filter(|_| ok)
                            .and_then(|input| crate::artifact::from_publish(&input, &result_text(&b["content"]), &v["tool_use_result"]))
                            .map(Box::new);
                        o.ev(ChatEventKind::ToolEnd { id: tid.clone(), ok, output: clip(&result_text(&b["content"]), MAX_OUTPUT), artifact });
                        if let Some((name, input)) = self.task_calls.remove(&tid)
                            && ok
                        {
                            self.on_task_result(&tid, &name, &input, &v["tool_use_result"], &result_text(&b["content"]), o);
                        }
                    }
                }
            }
            Some("result") => self.on_result(&v, o),
            Some("command_lifecycle") => self.on_lifecycle(&v, o),
            Some("rate_limit_event") => {
                crate::usage::observe_claude_rate_limit_event(&v);
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
        self.write_user(&uuid_v4(), text, o);
        o.ev(ChatEventKind::UserMessage { id: format!("u{}", self.user_n), text: text.to_string(), steer: false, note_id: None });
        o.ev(ChatEventKind::State { state: self.working_or_idle() });
        Ok(())
    }

    fn steer(&mut self, note_id: &str, text: &str, now: bool, o: &mut Out) -> Result<()> {
        // While the person is asked, nothing is cut: the note waits for the answer.
        let now = now && self.perms.is_empty();
        self.notes.add(note_id, text, now, o);
        if self.cmds.is_empty() {
            // Idle: the note is the next prompt.
            self.write_user(note_id, text, o);
            if let Some(n) = self.notes.get(note_id) {
                n.sent = true;
                n.own_turn = true;
                n.now = false;
            }
            o.ev(ChatEventKind::State { state: self.working_or_idle() });
        } else if now {
            self.start_cut(o);
        } else {
            self.flush_notes(o);
        }
        Ok(())
    }

    fn cancel_steer(&mut self, note_id: &str, o: &mut Out) -> Result<()> {
        let Some(n) = self.notes.get(note_id) else { bail!("no queued note {note_id} (already delivered or gone)") };
        if !n.sent {
            self.notes.settle(note_id, SteerState::Cancelled, None, &mut self.user_n, o);
            return Ok(());
        }
        n.cancelling = true;
        self.request(json!({"subtype": "cancel_async_message", "message_uuid": note_id}), Pending::CancelNote(note_id.to_string(), true), o);
        Ok(())
    }

    fn interrupt(&mut self, o: &mut Out) -> Result<()> {
        if self.cmds.is_empty() {
            return Ok(());
        }
        // Stop means stop: notes the CLI holds are withdrawn (they end unused),
        // the ones coool holds end unused with the turn.
        let queued: Vec<String> = self.notes.list.iter().filter(|n| n.sent && !n.cancelling).map(|n| n.id.clone()).collect();
        for id in queued {
            self.request(json!({"subtype": "cancel_async_message", "message_uuid": id}), Pending::CancelNote(id.clone(), false), o);
        }
        self.stopping = true;
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

    fn respond_permission_remember(&mut self, request_id: &str, remember: &str, o: &mut Out) -> Result<()> {
        let Some(p) = self.perms.get(request_id).filter(|p| !p.question) else { bail!("no pending permission request {request_id}") };
        let Some((_, updated)) = p.remember.iter().find(|(r, _)| r.id == remember) else { bail!("request {request_id} has no remember option {remember}") };
        let answer = json!({"behavior": "allow", "updatedInput": p.input, "updatedPermissions": updated});
        self.perms.remove(request_id);
        o.write(&json!({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": answer}}));
        self.after_answer(o);
        o.ev(ChatEventKind::State { state: self.working_or_idle() });
        Ok(())
    }

    fn respond_permission(&mut self, request_id: &str, allow: bool, always: bool, o: &mut Out) -> Result<()> {
        // `always`: only an option that stays inside this chat (never a saved rule).
        let chat_only = self.perms.get(request_id).and_then(|p| p.remember.first()).filter(|(r, _)| !r.persistent()).map(|(r, _)| r.id.clone());
        if let (true, true, Some(id)) = (allow, always, chat_only) {
            return self.respond_permission_remember(request_id, &id, o);
        }
        let Some(p) = self.perms.remove(request_id) else { bail!("no pending permission request {request_id}") };
        let answer = if allow {
            json!({"behavior": "allow", "updatedInput": p.input})
        } else if p.question {
            json!({"behavior": "deny", "message": "The user declined to answer."})
        } else if p.tool == "ExitPlanMode" {
            // The plain denial ends the turn ("you declined the plan"); the UI's deny means "keep planning".
            json!({"behavior": "deny", "message": "The user did not approve this plan yet and wants to keep planning. Stay in plan mode: ask what to change if it is unclear, then present a revised plan with ExitPlanMode."})
        } else {
            json!({"behavior": "deny", "message": "The user denied this tool call."})
        };
        o.write(&json!({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": answer}}));
        self.after_answer(o);
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
        self.after_answer(o);
        o.ev(ChatEventKind::State { state: self.working_or_idle() });
        Ok(())
    }

    fn on_exit(&mut self, o: &mut Out) {
        self.perms.clear();
        self.notes.unused(|_| true, o);
        if !self.cmds.is_empty() {
            self.cmds.clear();
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
        assert!(a.contains(&"--allow-dangerously-skip-permissions".to_string()), "Bypass must stay switchable");
        assert!(!a.contains(&"--dangerously-skip-permissions".to_string()));
        let mut r = opts();
        r.resume = Some("abc".into());
        r.permission_mode = Some("plan".into());
        let a = Claude::new(&r).args();
        assert!(a.windows(2).any(|w| w[0] == "--resume" && w[1] == "abc"));
        assert!(a.windows(2).any(|w| w[0] == "--permission-mode" && w[1] == "plan"));
        assert!(!a.contains(&"--session-id".to_string()));
    }

    #[test]
    fn mcp_servers_ride_on_flags_with_equals() {
        assert!(mcp_args(&[]).is_empty());
        let a = mcp_args(&[super::super::McpServer {
            name: "coool-device".into(),
            command: "/Applications/coool.app/Contents/MacOS/coool".into(),
            args: vec!["--coool-device-mcp".into()],
            env: vec![("COOOL_DEVICE_TOKEN".into(), "t\"1".into())],
            allow_all: true,
            tool_timeout_sec: Some(900),
        }.clone()]);
        assert_eq!(a.len(), 2);
        let cfg: Value = serde_json::from_str(a[0].strip_prefix("--mcp-config=").unwrap()).unwrap();
        let s = &cfg["mcpServers"]["coool-device"];
        assert_eq!(s["command"], "/Applications/coool.app/Contents/MacOS/coool");
        assert_eq!(s["args"][0], "--coool-device-mcp");
        assert_eq!(s["env"]["COOOL_DEVICE_TOKEN"], "t\"1");
        assert_eq!(a[1], "--allowedTools=mcp__coool-device");
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
            ChatEventKind::PermissionRequest { request_id, tool, summary, input, .. } => Some((request_id.clone(), tool.clone(), summary.clone(), input.clone())),
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
        assert!(c.cmds.is_empty());
        assert_eq!(c.working_or_idle(), ChatState::Idle);
    }

    /// Real run: a turn interrupted mid-stream, then set_model and
    /// set_permission_mode, then a turn on the new model.
    #[test]
    fn artifact_publish_ends_with_its_artifact() {
        let mut c = Claude::new(&opts());
        let use_ = |id: &str, input: &str| format!(r#"{{"type":"assistant","message":{{"id":"m-{id}","model":"claude-x","content":[{{"type":"tool_use","id":"{id}","name":"Artifact","input":{input}}}]}}}}"#);
        let result = |id: &str, text: &str| format!(r#"{{"type":"user","message":{{"content":[{{"type":"tool_result","tool_use_id":"{id}","content":{}}}]}}}}"#, serde_json::to_string(text).unwrap());
        let lines = [
            use_("q", r#"{"action":"quickstart","intent":"other"}"#),
            result("q", "Quickstart. …"),
            use_("p", r#"{"file_path":"/x/rehber/p2s-sensor-rehberi.html","files":{"th-kart.jpg":"/x/rehber/th-kart.jpg"},"icon":"wrench"}"#),
            result("p", "Published /x/rehber/p2s-sensor-rehberi.html at https://claude.ai/artifact/2z4giSyysLF1DLHG4j2bLD (Version 3, version id 1-a) Icon: \"wrench\".\n\nMore."),
        ];
        let mut o = Out::default();
        for l in &lines {
            c.on_line(l, &mut o);
        }
        let evs = o.events;
        let ends: Vec<(String, Option<Box<crate::artifact::ArtifactInfo>>)> = evs.iter().filter_map(|e| if let ChatEventKind::ToolEnd { id, artifact, .. } = e { Some((id.clone(), artifact.clone())) } else { None }).collect();
        assert_eq!(ends.len(), 2);
        assert!(ends[0].1.is_none(), "quickstart is a plain step");
        let a = ends[1].1.as_ref().expect("the publish carries its artifact");
        assert_eq!((a.url.as_str(), a.version, a.icon.as_deref()), ("https://claude.ai/artifact/2z4giSyysLF1DLHG4j2bLD", Some(3), Some("wrench")));
        assert_eq!(a.files["th-kart.jpg"], "/x/rehber/th-kart.jpg");
        assert_eq!(a.title, "p2s-sensor-rehberi.html");
    }

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
        c.on_line(&req("p4", r#"[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"rm x"}],"behavior":"allow","destination":"localSettings"}]"#), &mut o);
        assert!(matches!(o.events.last(), Some(ChatEventKind::State { state: ChatState::WaitingPermission })));
        let mut o = Out::default();
        // Legacy `always` takes the this-chat twin, never the saved rule.
        c.respond_permission("p1", true, true, &mut o).unwrap();
        // Nothing to remember: `always` allows once.
        c.respond_permission("p2", true, true, &mut o).unwrap();
        c.respond_permission("p3", false, false, &mut o).unwrap();
        assert!(c.respond_permission("p3", true, false, &mut o).is_err());
        assert!(c.respond_permission_remember("p4", "9", &mut o).is_err(), "unknown option");
        c.respond_permission_remember("p4", "1", &mut o).unwrap();
        let w: Vec<Value> = o.writes.iter().map(|w| serde_json::from_str(w).unwrap()).collect();
        assert_eq!(w[0]["response"]["request_id"], "p1");
        let up = &w[0]["response"]["response"]["updatedPermissions"];
        assert_eq!(up[0]["rules"][0]["ruleContent"], "rm x");
        assert_eq!(up[0]["destination"], "session");
        assert_eq!(w[0]["response"]["response"]["updatedInput"]["command"], "rm x");
        assert!(w[1]["response"]["response"]["updatedPermissions"].is_null());
        assert_eq!(w[1]["response"]["response"]["behavior"], "allow");
        assert_eq!(w[2]["response"]["response"]["behavior"], "deny");
        assert!(w[2]["response"]["response"]["updatedPermissions"].is_null());
        assert_eq!(w[3]["response"]["response"]["updatedPermissions"][0]["destination"], "localSettings");
    }

    /// `permission_suggestions` exactly as Claude Code 2.1.325 sent them (haiku, a
    /// throwaway folder), and the options they become.
    #[test]
    fn remember_options_from_observed_suggestions() {
        let opts = |s: &str| remember_options(&serde_json::from_str(s).unwrap(), "/tmp/demo");
        // Write -> acceptEdits for the session: one chat-only mode switch.
        let w = opts(r#"[{"type":"setMode","mode":"acceptEdits","destination":"session"}]"#);
        assert_eq!(w.len(), 1);
        assert_eq!((w[0].0.label.as_str(), w[0].0.scope, w[0].0.mode.as_deref(), w[0].0.file.as_deref()), ("Allow all edits in this chat", RememberScope::Chat, Some("acceptEdits"), None));
        assert!(w[0].0.detail.contains("Accept edits"), "{}", w[0].0.detail);
        // Bash `npm test` -> a rule saved to localSettings: chat twin first.
        let b = opts(r#"[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"npm test *"}],"behavior":"allow","destination":"localSettings"}]"#);
        let labels: Vec<&str> = b.iter().map(|o| o.0.label.as_str()).collect();
        assert_eq!(labels, ["Allow `npm test` commands in this chat", "Always allow `npm test` commands in this project"]);
        assert_eq!((b[0].0.scope, b[1].0.scope), (RememberScope::Chat, RememberScope::Project));
        assert_eq!(b[1].0.file.as_deref(), Some(".claude/settings.local.json"));
        assert!(b[1].0.detail.contains(".claude/settings.local.json") && b[1].0.detail.contains("outside coool"));
        assert_eq!(b[0].0.rules, ["Bash(npm test *)"]);
        assert_eq!(b[0].1[0]["destination"], "session");
        assert_eq!(b[1].1[0]["destination"], "localSettings");
        assert_eq!((b[0].0.id.as_str(), b[1].0.id.as_str()), ("0", "1"));
        // Read outside the folder: two session rules (path and its realpath) -> one option.
        let r = opts(r#"[{"type":"addRules","rules":[{"toolName":"Read","ruleContent":"//etc/**"}],"behavior":"allow","destination":"session"},{"type":"addRules","rules":[{"toolName":"Read","ruleContent":"//private/etc/**"}],"behavior":"allow","destination":"session"}]"#);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].0.label, "Allow reading /etc and reading /private/etc in this chat");
        assert_eq!(r[0].1.as_array().unwrap().len(), 2);
        // WebFetch -> a domain rule saved to localSettings.
        let f = opts(r#"[{"type":"addRules","destination":"localSettings","rules":[{"toolName":"WebFetch","ruleContent":"domain:example.com"}],"behavior":"allow"}]"#);
        assert_eq!(f[1].0.label, "Always allow fetching from example.com in this project");
        // A compound command: one rule per part, applied together.
        let m = opts(r#"[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"mkdir sub *"},{"toolName":"Bash","ruleContent":"touch sub/a"}],"behavior":"allow","destination":"localSettings"}]"#);
        assert_eq!(m[0].0.label, "Allow `mkdir sub` commands and `touch sub/a` in this chat");
        // Nothing offered, or nothing that allows: no options.
        assert!(opts("[]").is_empty() && opts("null").is_empty());
        assert!(opts(r#"[{"type":"addRules","rules":[{"toolName":"Bash"}],"behavior":"deny","destination":"session"}]"#).is_empty());
        // Bash `touch e.txt` in a /tmp folder (observed): a session bundle of the
        // folder's realpath + acceptEdits, and the saved rule. The exact-command
        // twin comes first, then the mode switch, then the saved rule.
        let t = opts(r#"[{"type":"addDirectories","directories":["/private/tmp/demo"],"destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"},{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch e.txt"}],"behavior":"allow","destination":"localSettings"}]"#);
        let labels: Vec<&str> = t.iter().map(|o| o.0.label.as_str()).collect();
        assert_eq!(labels, ["Allow `touch e.txt` in this chat", "Allow all edits in this chat", "Always allow `touch e.txt` in this project"]);
        assert!(t[1].0.detail.contains("Also allows working in this folder"), "{}", t[1].0.detail);
        assert_eq!(t[1].1.as_array().unwrap().len(), 2);
        assert_eq!(t.iter().map(|o| o.0.id.as_str()).collect::<Vec<_>>(), ["0", "1", "2"]);
        // User settings say so.
        let u = opts(r#"[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"ls"}],"behavior":"allow","destination":"userSettings"}]"#);
        assert_eq!((u[1].0.scope, u[1].0.label.as_str()), (RememberScope::User, "Always allow `ls` in every project"));
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

    /// Skills are tagged in the very first `commands`, before any turn (from
    /// the startup `get_context_usage` answer, not `system/init`).
    #[test]
    fn skills_are_known_before_the_first_turn() {
        let mut c = Claude::new(&opts());
        c.skills.clear();
        let mut o = Out::default();
        c.start(&mut o);
        for l in include_str!("fixtures/claude_slash_commands.jsonl").lines() {
            let v: Value = serde_json::from_str(l).unwrap();
            if v["dir"] == "api" {
                break;
            }
            if v["dir"] == "out" {
                c.on_line(v["line"].as_str().unwrap(), &mut o);
            }
        }
        let cmds = o.events.iter().find_map(|e| if let ChatEventKind::Commands { commands } = e { Some(commands.clone()) } else { None }).expect("commands before the first turn");
        let kind = |n: &str| cmds.iter().find(|c| c.name == n).map(|c| c.kind);
        assert_eq!(kind("dataviz"), Some(CommandKind::Skill));
        assert_eq!(kind("compact"), Some(CommandKind::Command));
    }

    fn steers(evs: &[ChatEventKind]) -> Vec<(String, SteerState, Option<String>)> {
        evs.iter()
            .filter_map(|e| match e {
                ChatEventKind::Steer { text, state, tool_id, .. } => Some((text.clone(), *state, tool_id.clone())),
                _ => None,
            })
            .collect()
    }

    fn tool_ids(evs: &[ChatEventKind], name: &str) -> Vec<String> {
        evs.iter().filter_map(|e| if let ChatEventKind::ToolStart { id, name: n, parent_tool_id: None, .. } = e { (n == name).then(|| id.clone()) } else { None }).collect()
    }

    /// Real run (Claude Code 2.1.325, haiku): a note sent while the first
    /// `sleep` ran is taken in after it (`command_lifecycle` `started` right
    /// after that tool's result); a second one is withdrawn while the CLI holds
    /// it; then a `now` note cuts the next turn's first step and starts a turn.
    #[test]
    fn fixture_steer() {
        let mut c = Claude::new(&opts());
        let (evs, writes) = crate::chat::testutil::replay_full(&mut c, include_str!("fixtures/claude_steer.jsonl"));
        let bash = tool_ids(&evs, "Bash");
        let s = steers(&evs);
        let settled: Vec<_> = s.iter().filter(|x| x.1 != SteerState::Queued).collect();
        assert_eq!(settled.len(), 3, "{s:?}");
        assert_eq!((settled[0].0.as_str(), settled[0].1, settled[0].2.as_deref()), ("Also say apple.", SteerState::Cancelled, None));
        assert_eq!((settled[1].1, settled[1].2.as_deref()), (SteerState::PickedUp, Some(bash[0].as_str())));
        assert_eq!((settled[2].1, settled[2].2.as_deref()), (SteerState::Interrupted, Some(bash[3].as_str())));
        // Delivered notes are echoed as user messages marked as notes.
        let echoed: Vec<&str> = evs.iter().filter_map(|e| if let ChatEventKind::UserMessage { steer: true, text, .. } = e { Some(text.as_str()) } else { None }).collect();
        assert_eq!(echoed.len(), 2);
        // Wire: uuid'd user lines, one cancel_async_message, one interrupt.
        let w: Vec<Value> = writes.iter().map(|w| serde_json::from_str(w).unwrap()).collect();
        assert!(w.iter().filter(|w| w["type"] == "user").all(|w| w["uuid"].is_string()));
        assert_eq!(w.iter().filter(|w| w["request"]["subtype"] == "cancel_async_message").count(), 1);
        assert_eq!(w.iter().filter(|w| w["request"]["subtype"] == "interrupt").count(), 1);
        // A folded note gets no result of its own: the chat still ends idle.
        assert!(c.cmds.is_empty() && c.notes.list.is_empty());
        assert_eq!(c.working_or_idle(), ChatState::Idle);
        let ends: Vec<bool> = evs.iter().filter_map(|e| if let ChatEventKind::TurnEnd { ok, .. } = e { Some(*ok) } else { None }).collect();
        assert_eq!(ends, [true, false, true]);
        assert!(!evs.iter().any(|e| matches!(e, ChatEventKind::Notice { level: NoticeLevel::Error, .. })), "the cut is not an error");
    }

    fn line(v: Value) -> String {
        v.to_string()
    }

    fn started(uuid: &str) -> String {
        line(json!({"type": "command_lifecycle", "command_uuid": uuid, "state": "started"}))
    }

    #[test]
    fn compacting_status_starts_and_the_boundary_ends_it() {
        let mut c = Claude::new(&opts());
        let mut o = Out::default();
        let compacting = |o: &Out| o.events.iter().filter_map(|e| if let ChatEventKind::Compacting { active } = e { Some(*active) } else { None }).collect::<Vec<_>>();
        c.on_line(&line(json!({"type": "system", "subtype": "status", "status": "requesting"})), &mut o);
        c.on_line(&line(json!({"type": "system", "subtype": "status", "status": "compacting"})), &mut o);
        c.on_line(&line(json!({"type": "system", "subtype": "status", "status": "compacting"})), &mut o);
        assert_eq!(compacting(&o), [true]);
        c.on_line(&line(json!({"type": "system", "subtype": "compact_boundary", "compact_metadata": {"trigger": "manual", "pre_tokens": 1}})), &mut o);
        c.on_line(&line(json!({"type": "system", "subtype": "status", "status": null})), &mut o);
        assert_eq!(compacting(&o), [true, false]);
    }

    /// Turn ends with no further step: the held note is not sent and ends
    /// unused; while a permission is pending notes wait, then go out.
    #[test]
    fn notes_wait_for_a_step_and_for_answers() {
        let mut c = Claude::new(&opts());
        let mut o = Out::default();
        c.send("go", &mut o).unwrap();
        let first = c.cmds[0].clone();
        c.on_line(&started(&first), &mut o);
        // Streaming text, no step in flight: held by coool.
        c.steer("n1", "late note", false, &mut o).unwrap();
        assert_eq!(o.writes.iter().filter(|w| w.contains("late note")).count(), 0);
        let mut o = Out::default();
        c.on_line(&line(json!({"type": "result", "subtype": "success", "is_error": false, "duration_ms": 1, "user_message_uuids": [first]})), &mut o);
        assert_eq!(steers(&o.events), [("late note".to_string(), SteerState::Unused, None)]);
        assert!(!o.writes.iter().any(|w| w.contains("late note")), "never sent");
        assert_eq!(c.working_or_idle(), ChatState::Idle);

        // A step asks for permission: the note (even `now`) waits for the answer.
        let mut o = Out::default();
        c.send("again", &mut o).unwrap();
        c.on_line(&started(&c.cmds[0].clone()), &mut o);
        c.on_line(&line(json!({"type": "assistant", "message": {"id": "m", "model": "x", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "touch a"}}]}})), &mut o);
        c.on_line(&line(json!({"type": "control_request", "request_id": "p1", "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "touch a"}}})), &mut o);
        let mut o = Out::default();
        c.steer("n2", "wait for it", true, &mut o).unwrap();
        assert!(o.writes.is_empty(), "nothing sent, nothing interrupted");
        c.respond_permission("p1", true, false, &mut o).unwrap();
        let w: Vec<Value> = o.writes.iter().map(|w| serde_json::from_str(w).unwrap()).collect();
        assert_eq!(w.len(), 2);
        assert_eq!((w[1]["type"].as_str(), w[1]["uuid"].as_str()), (Some("user"), Some("n2")));
        // Taken in after that step.
        let mut o = Out::default();
        c.on_line(&line(json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}})), &mut o);
        c.on_line(&started("n2"), &mut o);
        assert_eq!(steers(&o.events), [("wait for it".to_string(), SteerState::PickedUp, Some("t1".to_string()))]);
        assert!(c.cancel_steer("n2", &mut o).is_err(), "delivered");
    }

    /// Stop withdraws the notes the CLI holds (they end unused) and the ones
    /// coool holds end unused with the turn. An idle note is a prompt.
    #[test]
    fn stop_leaves_notes_unused_and_idle_note_is_a_prompt() {
        let mut c = Claude::new(&opts());
        let mut o = Out::default();
        c.send("go", &mut o).unwrap();
        let first = c.cmds[0].clone();
        c.on_line(&started(&first), &mut o);
        c.on_line(&line(json!({"type": "assistant", "message": {"id": "m", "model": "x", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "sleep 9"}}]}})), &mut o);
        c.steer("sent", "at the cli", false, &mut o).unwrap();
        let mut o = Out::default();
        c.interrupt(&mut o).unwrap();
        let w: Vec<Value> = o.writes.iter().map(|w| serde_json::from_str(w).unwrap()).collect();
        assert_eq!(w.iter().map(|w| w["request"]["subtype"].as_str().unwrap_or("")).collect::<Vec<_>>(), ["cancel_async_message", "interrupt"]);
        let rid = w[0]["request_id"].as_str().unwrap();
        let mut o = Out::default();
        c.on_line(&line(json!({"type": "control_response", "response": {"subtype": "success", "request_id": rid, "response": {"cancelled": true}}})), &mut o);
        c.on_line(&line(json!({"type": "command_lifecycle", "command_uuid": "sent", "state": "cancelled"})), &mut o);
        assert_eq!(steers(&o.events), [("at the cli".to_string(), SteerState::Unused, None)], "once");
        c.on_line(&line(json!({"type": "result", "subtype": "error_during_execution", "is_error": true, "duration_ms": 1, "user_message_uuids": [first]})), &mut o);
        assert_eq!(c.working_or_idle(), ChatState::Idle);

        let mut o = Out::default();
        c.steer("idle", "hello", false, &mut o).unwrap();
        let w: Value = serde_json::from_str(&o.writes[0]).unwrap();
        assert_eq!((w["uuid"].as_str(), w["message"]["content"].as_str()), (Some("idle"), Some("hello")));
        c.on_line(&started("idle"), &mut o);
        assert_eq!(steers(&o.events).last().unwrap().1, SteerState::PickedUp);
    }

    /// Real run (claude-haiku-4-5, the CLI's task tools are off on newer
    /// models): `TaskCreate` x3 and `TaskUpdate`s, each followed by a
    /// synthetic `TodoWrite` step holding the whole list.
    #[test]
    fn fixture_tasks_become_a_todo_list() {
        let mut c = Claude::new(&opts());
        let evs = replay(&mut c, include_str!("fixtures/claude_tasks.jsonl"));
        let views: Vec<&Value> = evs.iter().filter_map(|e| if let ChatEventKind::ToolStart { name, input, .. } = e { (name == "TodoWrite").then_some(input) } else { None }).collect();
        assert_eq!(views.len(), tool_ids(&evs, "TaskCreate").len() + tool_ids(&evs, "TaskUpdate").len());
        assert_eq!(views.len(), 9);
        assert!(views.iter().all(|v| v["_synthetic"] == true));
        let first = &views[0]["todos"];
        assert_eq!(first, &json!([{"content": "Choose haiku theme", "status": "pending", "activeForm": "Choosing theme"}]));
        let statuses = |v: &Value| v["todos"].as_array().unwrap().iter().map(|t| t["status"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(statuses(views[3]), ["in_progress", "pending", "pending"]);
        assert_eq!(statuses(views[8]), ["completed", "completed", "completed"]);
        assert_eq!(views[8]["todos"][1]["content"], "Write the haiku");
        // Every synthetic step is complete, and the raw Task* steps still flow.
        let ends = evs.iter().filter(|e| matches!(e, ChatEventKind::ToolEnd { id, ok: true, .. } if id.ends_with(":todos"))).count();
        assert_eq!(ends, 9);
        assert_eq!(tool_ids(&evs, "TaskCreate").len(), 3);
    }

    /// Real run in plan mode: `ExitPlanMode` asks with `input.plan` (and
    /// `planFilePath`); approving switches the mode to `default` (a new
    /// `ready`) and the turn goes on; denying ends that turn.
    #[test]
    fn fixture_plan_mode_approval() {
        let mut c = Claude::new(&ChatOptions { permission_mode: Some("plan".into()), ..opts() });
        let (evs, writes) = crate::chat::testutil::replay_full(&mut c, include_str!("fixtures/claude_plan_mode.jsonl"));
        let asks: Vec<&Value> = evs.iter().filter_map(|e| if let ChatEventKind::PermissionRequest { tool, input, .. } = e { (tool == "ExitPlanMode").then_some(input) } else { None }).collect();
        assert_eq!(asks.len(), 2);
        assert!(asks.iter().all(|i| i["plan"].as_str().is_some_and(|p| p.starts_with("# Plan")) && i["planFilePath"].is_string()));
        let modes: Vec<&str> = evs.iter().filter_map(|e| if let ChatEventKind::Ready { permission_mode, .. } = e { Some(permission_mode.as_str()) } else { None }).collect();
        assert_eq!((modes.first().copied(), modes.last().copied()), (Some("plan"), Some("default")));
        // The denial asks to keep planning rather than a plain "denied".
        let deny = writes.iter().map(|w| serde_json::from_str::<Value>(w).unwrap()).find(|w| w["response"]["response"]["behavior"] == "deny").unwrap();
        assert!(deny["response"]["response"]["message"].as_str().unwrap().contains("keep planning"));
    }

    #[test]
    fn unknown_control_requests_are_declined() {
        let mut c = Claude::new(&opts());
        let mut o = Out::default();
        c.on_line(r#"{"type":"control_request","request_id":"h1","request":{"subtype":"hook_callback"}}"#, &mut o);
        let w: Value = serde_json::from_str(&o.writes[0]).unwrap();
        assert_eq!((w["response"]["subtype"].as_str(), w["response"]["request_id"].as_str()), (Some("error"), Some("h1")));
    }

    #[test]
    fn live_output_estimates_while_streaming_then_exact_usage_replaces_it() {
        use std::time::{Duration, Instant};
        let mut l = LiveOutput::default();
        let t0 = Instant::now();
        assert_eq!(l.push(0, t0), None);
        assert_eq!(l.push(40, t0), Some(10), "first delta reports at once, 4 chars per token");
        assert_eq!(l.push(8, t0 + Duration::from_millis(50)), None, "throttled");
        assert_eq!(l.push(8, t0 + Duration::from_millis(130)), Some(14), "the estimate includes throttled deltas (56 chars)");
        l.reset();
        assert_eq!(l.push(3, t0 + Duration::from_millis(140)), Some(1), "a new response starts over");

        // Through the backend: deltas of all kinds produce LiveOutput, message_delta the exact usage.
        let mut c = Claude::new(&opts());
        let mut o = Out::default();
        let ev = |e: &str| format!(r#"{{"type":"stream_event","event":{e}}}"#);
        c.on_line(&ev(r#"{"type":"message_start","message":{"id":"m1","model":"claude-x"}}"#), &mut o);
        c.on_line(&ev(r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\": \"ls\"}"}}"#), &mut o);
        let live: Vec<u64> = o.events.iter().filter_map(|e| if let ChatEventKind::LiveOutput { tokens } = e { Some(*tokens) } else { None }).collect();
        assert_eq!(live, vec![5], "tool input counts: 18 chars");
        c.on_line(&ev(r#"{"type":"message_delta","delta":{},"usage":{"input_tokens":3,"output_tokens":4}}"#), &mut o);
        let u = o.events.iter().find_map(|e| if let ChatEventKind::Usage { tokens, .. } = e { Some(tokens.output) } else { None });
        assert_eq!(u, Some(4), "exact usage lands below the estimate; the UI holds its maximum");
        c.on_line(&ev(r#"{"type":"message_start","message":{"id":"m2","model":"claude-x"}}"#), &mut o);
        c.on_line(&ev(r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"abcdefgh"}}"#), &mut o);
        assert!(matches!(o.events.last(), Some(ChatEventKind::LiveOutput { tokens: 2 })), "estimate restarts per response");
    }
}
