//! Codex over `codex app-server` (JSON-RPC 2.0, one JSON object per line).
//!
//! Observed protocol (codex-cli 0.145; `codex app-server generate-ts` prints it):
//! - client -> server: `initialize` (then the `initialized` notification),
//!   `model/list`, `thread/start` | `thread/resume`, `turn/start` (per-turn
//!   overrides for model / approval policy / sandbox stick for later turns),
//!   `turn/steer` (add input to the running turn: taken in at its next model
//!   request, reported as a `userMessage` item carrying the `clientUserMessageId`
//!   it was sent with; it cannot be withdrawn), `turn/interrupt`,
//!   `thread/compact/start`, `review/start`.
//! - server -> client notifications: `turn/started|completed`,
//!   `item/started|completed` (agentMessage, reasoning, commandExecution,
//!   fileChange, mcpToolCall, collabAgentToolCall, ...), `item/agentMessage/delta`,
//!   `item/reasoning/*Delta`, `thread/tokenUsage/updated` (with the model's
//!   context window), `error`, `warning`, ...
//! - server -> client requests (need a response): `item/commandExecution/requestApproval`
//!   and `item/fileChange/requestApproval` -> `{"decision": "accept" |
//!   "acceptForSession" | "decline" | "cancel"}`; legacy `execCommandApproval` /
//!   `applyPatchApproval` -> `{"decision": "approved" | "approved_for_session" | ...}`.
//! - The app-server runs no TUI slash commands; `/compact` and `/review` map to
//!   RPCs, `/model` and `/status` are answered here, the rest need the terminal.

use super::*;
use std::collections::{HashMap, HashSet};

/// TUI commands with no app-server equivalent.
const TERMINAL_COMMANDS: &[&str] = &[
    "approvals",
    "permissions",
    "setup-default-sandbox",
    "experimental",
    "skills",
    "rename",
    "new",
    "clear",
    "resume",
    "fork",
    "init",
    "plan",
    "collab",
    "agent",
    "diff",
    "mention",
    "debug-config",
    "statusline",
    "theme",
    "mcp",
    "apps",
    "logout",
    "login",
    "quit",
    "exit",
    "feedback",
    "rollout",
    "ps",
    "clean",
    "personality",
    "realtime",
    "settings",
    "undo",
];

const APPROVAL_POLICIES: &[&str] = &["untrusted", "on-request", "never"];

/// Codex 0.145 dropped `on-failure` (the app-server refuses the thread: "unknown variant `on-failure`"); a choice saved
/// before (Settings > General, an older coool) asks on request instead, the nearest policy that still asks.
fn approval_policy(mode: &str) -> &str {
    if mode == "on-failure" { "on-request" } else { mode }
}
const SANDBOX_MODES: &[&str] = &["read-only", "workspace-write", "danger-full-access"];

pub(crate) fn args() -> Vec<String> {
    vec!["app-server".into()]
}

/// `-c mcp_servers.<name>.command=…` / `.args=[…]` / `.env={…}` overrides (values are TOML; a JSON string is a valid
/// TOML basic string). Codex reads them on top of the person's config without writing it.
pub(crate) fn mcp_args(servers: &[super::McpServer]) -> Vec<String> {
    let q = |s: &str| serde_json::to_string(s).unwrap_or_default();
    let mut a = Vec::new();
    for s in servers {
        let key = format!("mcp_servers.{}", s.name);
        a.extend(["-c".into(), format!("{key}.command={}", q(&s.command))]);
        let args: Vec<String> = s.args.iter().map(|x| q(x)).collect();
        a.extend(["-c".into(), format!("{key}.args=[{}]", args.join(","))]);
        if !s.env.is_empty() {
            let env: Vec<String> = s.env.iter().map(|(k, v)| format!("{}={}", q(k), q(v))).collect();
            a.extend(["-c".into(), format!("{key}.env={{{}}}", env.join(","))]);
        }
        // Without it Codex asks before every call of the server's tools, as an MCP elicitation coool can't answer
        // (declined at once, so every call failed with "user rejected MCP tool call").
        if s.allow_all {
            a.extend(["-c".into(), format!("{key}.default_tools_approval_mode=\"approve\"")]);
        }
        if let Some(t) = s.tool_timeout_sec {
            a.extend(["-c".into(), format!("{key}.tool_timeout_sec={t}")]);
        }
    }
    a
}

enum Req {
    Init,
    ModelList,
    /// `config/read` before the thread, for the person's own `developer_instructions` (Ladder appends to them).
    ConfigRead,
    Thread,
    /// `turn/start`; with the note it carries, if any.
    Turn(Option<String>),
    /// `turn/steer` for a note.
    Steer(String),
    Other(&'static str),
}

#[derive(Clone)]
enum PermKind {
    /// v2 approvals: accept / acceptForSession / decline.
    V2,
    /// Legacy approvals: approved / approved_for_session / denied.
    Legacy,
    /// `item/tool/requestUserInput`: the question ids, in order.
    Question(Vec<String>),
}

pub(crate) struct Codex {
    cwd: String,
    resume: Option<String>,
    thread_id: Option<String>,
    model: String,
    approval: String,
    sandbox: String,
    /// Overrides for the next `turn/start` (they stick for later turns).
    next_model: Option<String>,
    next_approval: Option<String>,
    next_sandbox: Option<String>,
    models: Vec<ModelOption>,
    context_window: Option<u64>,
    last_ready: Option<ChatEventKind>,
    next_id: u64,
    pending: HashMap<u64, Req>,
    /// Prompts sent before the thread exists.
    queue: Vec<String>,
    turn_id: Option<String>,
    in_turn: bool,
    perms: HashMap<String, (Value, PermKind)>,
    /// Remember options per pending approval, with the decision each sends.
    remember: HashMap<String, Vec<(RememberOption, Value)>>,
    /// Subagent thread -> the collab tool call that spawned it.
    child_threads: HashMap<String, String>,
    last_spawn: Option<String>,
    /// Subagent thread -> the end of the `spawnAgent` call, held until that agent's turn ends.
    spawn_ends: HashMap<String, ChatEventKind>,
    started_tools: HashSet<String>,
    /// fileChange item -> its changes (`patch_changes`), for the approval that may follow it.
    file_changes: HashMap<String, Vec<Value>>,
    user_n: u64,
    notes: Notes,
    /// The newest main-thread step of the running turn.
    last_tool: Option<String>,
    /// A `turn/interrupt` went out for `now` notes; they start the next turn.
    cutting: bool,
    /// `interrupt()` (Stop) was called: notes still held end unused.
    stopping: bool,
    /// `turn/plan/updated` seen, numbering the `update_plan` steps.
    plans: u64,
    /// `clientInfo.name` in `initialize`; Codex records it as the rollout's
    /// `originator`, which is how a later launch recognises coool's own threads.
    pub(crate) client_name: String,
    /// Ladder's policy (APP_SPEC "Ladder"), sent as `developerInstructions` after the person's own; None: off.
    ladder: Option<String>,
}

impl Codex {
    pub fn new(opts: &ChatOptions) -> Self {
        let mut c = Self {
            cwd: opts.cwd.clone(),
            resume: opts.resume.clone(),
            thread_id: None,
            model: opts.model.clone().unwrap_or_default(),
            approval: String::new(),
            sandbox: String::new(),
            next_model: None,
            next_approval: None,
            next_sandbox: None,
            models: Vec::new(),
            context_window: None,
            last_ready: None,
            next_id: 0,
            pending: HashMap::new(),
            queue: Vec::new(),
            turn_id: None,
            in_turn: false,
            perms: HashMap::new(),
            remember: HashMap::new(),
            child_threads: HashMap::new(),
            last_spawn: None,
            spawn_ends: HashMap::new(),
            started_tools: HashSet::new(),
            file_changes: HashMap::new(),
            user_n: 0,
            notes: Notes::default(),
            last_tool: None,
            cutting: false,
            stopping: false,
            plans: 0,
            client_name: crate::origin::CLIENT_NAME.to_string(),
            ladder: opts.ladder.as_ref().map(|l| crate::ladder::policy(crate::ladder::Cli::Codex, l, std::path::Path::new(&opts.cwd), true)),
        };
        if let Some(m) = &opts.permission_mode {
            let m = approval_policy(m);
            if SANDBOX_MODES.contains(&m) {
                c.sandbox = m.to_string();
            } else {
                c.approval = m.to_string();
            }
        }
        c
    }

    fn request(&mut self, method: &str, params: Value, kind: Req, o: &mut Out) {
        self.next_id += 1;
        o.write(&json!({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params}));
        self.pending.insert(self.next_id, kind);
    }

    fn ready(&mut self, o: &mut Out) {
        let Some(sid) = self.thread_id.clone() else { return };
        let first = self.last_ready.is_none();
        let r = ChatEventKind::Ready {
            session_id: sid,
            model: self.model.clone(),
            cwd: self.cwd.clone(),
            permission_mode: self.approval.clone(),
            slash_commands: slash_commands(),
            models: self.models.clone(),
            agents: Vec::new(),
            context_window: self.context_window,
        };
        if self.last_ready.as_ref() != Some(&r) {
            self.last_ready = Some(r.clone());
            o.ev(r);
        }
        if first {
            o.ev(ChatEventKind::Commands { commands: command_infos() });
        }
    }

    fn state(&self) -> ChatState {
        if !self.perms.is_empty() {
            ChatState::WaitingPermission
        } else if self.in_turn || !self.queue.is_empty() {
            ChatState::Working
        } else {
            ChatState::Idle
        }
    }

    fn start_thread(&mut self, o: &mut Out) {
        self.start_thread_with(None, o);
    }

    /// `theirs`: the `developer_instructions` the person's config has (Ladder's policy goes after them, since
    /// `developerInstructions` replaces the configured value for this thread).
    fn start_thread_with(&mut self, theirs: Option<&str>, o: &mut Out) {
        let mut p = json!({"cwd": self.cwd});
        if let Some(l) = &self.ladder {
            p["developerInstructions"] = json!(crate::ladder::merge_instructions(theirs, l));
        }
        if !self.model.is_empty() {
            p["model"] = json!(self.model);
        }
        if !self.approval.is_empty() {
            p["approvalPolicy"] = json!(self.approval);
        }
        if !self.sandbox.is_empty() {
            p["sandbox"] = json!(self.sandbox);
        }
        match self.resume.clone() {
            Some(id) => {
                p["threadId"] = json!(id);
                self.request("thread/resume", p, Req::Thread, o);
            }
            None => self.request("thread/start", p, Req::Thread, o),
        }
    }

    /// A turn for `text` (or, mid-turn, a steer). `note`: the steering note it
    /// carries, sent as `clientUserMessageId` so its delivery can be seen.
    fn start_turn(&mut self, text: &str, note: Option<&str>, o: &mut Out) {
        let Some(tid) = self.thread_id.clone() else { return };
        let input = json!([{"type": "text", "text": text, "text_elements": []}]);
        if self.in_turn
            && let Some(turn) = self.turn_id.clone()
        {
            let mut p = json!({"threadId": tid, "input": input, "expectedTurnId": turn});
            let kind = match note {
                Some(n) => {
                    p["clientUserMessageId"] = json!(n);
                    Req::Steer(n.to_string())
                }
                None => Req::Other("add to the turn"),
            };
            self.request("turn/steer", p, kind, o);
            return;
        }
        let mut p = json!({"threadId": tid, "input": input});
        if let Some(n) = note {
            p["clientUserMessageId"] = json!(n);
        }
        if let Some(m) = self.next_model.take() {
            p["model"] = json!(m);
        }
        if let Some(a) = self.next_approval.take() {
            p["approvalPolicy"] = json!(a);
        }
        if let Some(s) = self.next_sandbox.take() {
            p["sandboxPolicy"] = sandbox_policy(&s);
        }
        self.in_turn = true;
        self.request("turn/start", p, Req::Turn(note.map(str::to_string)), o);
    }

    /// Sends what held notes can be sent now: none while the person is asked
    /// or the turn id is unknown; held `now` notes interrupt the turn (they
    /// start the next one); `next` notes become `turn/steer`s; on an idle
    /// thread the first note starts a turn.
    fn flush_notes(&mut self, o: &mut Out) {
        if !self.perms.is_empty() || self.thread_id.is_none() || self.stopping {
            return;
        }
        if !self.in_turn {
            if self.cutting {
                return;
            }
            let Some((id, text)) = self.notes.list.iter().find(|n| !n.sent).map(|n| (n.id.clone(), n.text.clone())) else { return };
            if let Some(n) = self.notes.get(&id) {
                n.sent = true;
                n.own_turn = true;
            }
            self.start_turn(&text, Some(&id), o);
            return;
        }
        let Some(turn) = self.turn_id.clone() else { return };
        if self.cutting {
            return;
        }
        if self.notes.list.iter().any(|n| n.now && !n.sent) {
            let step = self.last_tool.clone();
            for n in self.notes.list.iter_mut().filter(|n| n.now && !n.sent) {
                n.cut = step.clone();
            }
            self.cutting = true;
            let tid = self.thread_id.clone().unwrap_or_default();
            self.request("turn/interrupt", json!({"threadId": tid, "turnId": turn}), Req::Other("interrupt the step for the note"), o);
            return;
        }
        let held: Vec<(String, String)> = self.notes.list.iter().filter(|n| !n.sent).map(|n| (n.id.clone(), n.text.clone())).collect();
        for (id, text) in held {
            if let Some(n) = self.notes.get(&id) {
                n.sent = true;
            }
            self.start_turn(&text, Some(&id), o);
        }
    }

    /// The main turn ended: notes that did not reach the agent end unused,
    /// except those an interrupt was sent for (and the ones queued with
    /// them), which start the next turn.
    fn notes_at_turn_end(&mut self, interrupted: bool, o: &mut Out) {
        self.last_tool = None;
        // A steer Codex accepted but never took in (it normally extends the turn).
        self.notes.unused(|n| n.sent, o);
        if self.stopping {
            self.stopping = false;
            self.cutting = false;
            self.notes.unused(|_| true, o);
            return;
        }
        if !std::mem::take(&mut self.cutting) {
            self.notes.unused(|_| true, o);
            return;
        }
        // `now` first: it starts the turn; the rest are steered into it.
        self.notes.list.sort_by_key(|n| !n.now);
        for n in self.notes.list.iter_mut() {
            n.now = n.now && interrupted;
        }
        self.flush_notes(o);
    }

    fn parent_for(&self, thread: &Value) -> Option<String> {
        let t = thread.as_str()?;
        if Some(t) == self.thread_id.as_deref() {
            return None;
        }
        self.child_threads.get(t).cloned().or_else(|| self.last_spawn.clone())
    }

    fn is_main(&self, thread: &Value) -> bool {
        thread.as_str().is_none() || thread.as_str() == self.thread_id.as_deref()
    }

    fn on_response(&mut self, v: &Value, o: &mut Out) {
        let Some(kind) = v["id"].as_u64().and_then(|id| self.pending.remove(&id)) else { return };
        if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
            let msg = err["message"].as_str().unwrap_or("unknown error");
            let what = match kind {
                Req::Init => "start Codex",
                Req::ModelList => return,
                Req::ConfigRead => {
                    // Could not read it: start the thread with the policy alone rather than not at all.
                    self.start_thread(o);
                    return;
                }
                Req::Thread => "open the thread",
                Req::Turn(note) => {
                    self.in_turn = false;
                    if let Some(n) = note {
                        self.notes.settle(&n, SteerState::Unused, None, &mut self.user_n, o);
                    }
                    "start the turn"
                }
                Req::Steer(n) => {
                    // Typically the turn ended just before (expectedTurnId no longer matches).
                    self.notes.settle(&n, SteerState::Unused, None, &mut self.user_n, o);
                    "add the note to the turn"
                }
                Req::Other(w) => w,
            };
            o.ev(ChatEventKind::notice(NoticeLevel::Error, format!("Could not {what}: {msg}")));
            o.ev(ChatEventKind::State { state: self.state() });
            return;
        }
        let r = &v["result"];
        match kind {
            Req::Init => {
                o.write(&json!({"jsonrpc": "2.0", "method": "initialized"}));
                self.request("model/list", json!({}), Req::ModelList, o);
                if self.ladder.is_some() {
                    self.request("config/read", json!({}), Req::ConfigRead, o);
                } else {
                    self.start_thread(o);
                }
            }
            Req::ConfigRead => {
                let theirs = r["config"]["developer_instructions"].as_str().map(str::to_string);
                self.start_thread_with(theirs.as_deref(), o);
            }
            Req::ModelList => {
                self.models = r["data"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter(|m| m["hidden"].as_bool() != Some(true))
                            .filter_map(|m| {
                                let id = m["id"].as_str().or(m["model"].as_str())?;
                                Some(ModelOption { id: id.to_string(), label: m["displayName"].as_str().unwrap_or(id).to_string() })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                self.ready(o);
            }
            Req::Thread => {
                self.thread_id = r["thread"]["id"].as_str().map(str::to_string);
                if let Some(m) = r["model"].as_str() {
                    self.model = m.to_string();
                }
                self.approval = approval_name(&r["approvalPolicy"]).unwrap_or(std::mem::take(&mut self.approval));
                if let Some(s) = sandbox_name(&r["sandbox"]) {
                    self.sandbox = s;
                }
                self.ready(o);
                for text in std::mem::take(&mut self.queue) {
                    self.start_turn(&text, None, o);
                }
                self.flush_notes(o);
                o.ev(ChatEventKind::State { state: self.state() });
            }
            Req::Turn(_) => {
                if let Some(t) = r["turn"]["id"].as_str() {
                    self.turn_id = Some(t.to_string());
                }
                self.flush_notes(o);
            }
            Req::Steer(_) | Req::Other(_) => {}
        }
    }

    fn on_server_request(&mut self, v: &Value, o: &mut Out) {
        let id = v["id"].clone();
        let p = &v["params"];
        let rid = match &id {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        let method = v["method"].as_str().unwrap_or("");
        let remember = approval_options(method, p);
        let options: Vec<RememberOption> = remember.iter().map(|(o, _)| o.clone()).collect();
        let perm = |tool: &str, summary: String, input: Value| ChatEventKind::PermissionRequest { request_id: rid.clone(), tool: tool.to_string(), summary, input, remember: options.clone() };
        let ev = match method {
            "item/commandExecution/requestApproval" => {
                let cmd = p["command"].as_str().map(unwrap_shell).unwrap_or_default();
                self.perms.insert(rid.clone(), (id, PermKind::V2));
                self.remember.insert(rid.clone(), remember);
                let mut input = json!({"command": cmd, "cwd": p["cwd"], "reason": p["reason"]});
                // A managed-network prompt: the host the command wants to reach.
                if let Some(h) = p["networkApprovalContext"]["host"].as_str() {
                    input["network_host"] = json!(h);
                }
                perm("shell", tool_line("shell", &cmd), input)
            }
            "item/fileChange/requestApproval" => {
                let changes = self.file_changes.get(p["itemId"].as_str().unwrap_or("")).cloned().unwrap_or_default();
                self.perms.insert(rid.clone(), (id, PermKind::V2));
                self.remember.insert(rid.clone(), remember);
                perm("apply_patch", patch_line(&changes), patch_input(changes, p))
            }
            "execCommandApproval" => {
                let cmd = p["command"].as_array().map(|a| a.iter().filter_map(|s| s.as_str()).collect::<Vec<_>>().join(" ")).unwrap_or_default();
                self.perms.insert(rid.clone(), (id, PermKind::Legacy));
                self.remember.insert(rid.clone(), remember);
                perm("shell", tool_line("shell", &cmd), json!({"command": cmd, "cwd": p["cwd"], "reason": p["reason"]}))
            }
            "applyPatchApproval" => {
                let changes = legacy_patch_changes(&p["fileChanges"]);
                self.perms.insert(rid.clone(), (id, PermKind::Legacy));
                self.remember.insert(rid.clone(), remember);
                perm("apply_patch", patch_line(&changes), patch_input(changes, p))
            }
            "item/tool/requestUserInput" if p["questions"].as_array().is_some_and(|q| !q.is_empty()) => {
                let questions = parse_questions(&p["questions"]);
                self.perms.insert(rid.clone(), (id, PermKind::Question(questions.iter().map(|q| q.id.clone()).collect())));
                ChatEventKind::Question { request_id: rid.clone(), questions }
            }
            m => {
                // Elicitations, extra-permission grants, client tools:
                // nothing here can answer them faithfully, so decline at once
                // rather than leave the turn hanging.
                o.write(&json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "not supported by coool"}}));
                if matches!(m, "item/tool/requestUserInput" | "mcpServer/elicitation/request" | "item/permissions/requestApproval") {
                    o.ev(ChatEventKind::needs_terminal(format!("Codex asked for input this chat can't give ({m}); continue in the terminal")));
                }
                return;
            }
        };
        o.ev(ev);
        o.ev(ChatEventKind::State { state: ChatState::WaitingPermission });
    }

    fn on_item(&mut self, started: bool, p: &Value, o: &mut Out) {
        let item = &p["item"];
        let parent = self.parent_for(&p["threadId"]);
        let id = item["id"].as_str().unwrap_or("").to_string();
        let ty = item["type"].as_str().unwrap_or("");
        if ty == "contextCompaction" && parent.is_none() {
            o.ev(ChatEventKind::Compacting { active: started });
        }
        if ty == "collabAgentToolCall" {
            // A subagent's steps nest under the call that spawned it; `wait` / `sendInput` name it too but don't own it.
            let spawn = item["tool"] == "spawnAgent";
            for t in item["receiverThreadIds"].as_array().into_iter().flatten().filter_map(|t| t.as_str()) {
                if spawn || !self.child_threads.contains_key(t) {
                    self.child_threads.insert(t.to_string(), id.clone());
                }
            }
            if item["tool"] == "spawnAgent" {
                self.last_spawn = Some(id.clone());
            }
        }
        if ty == "fileChange" {
            self.file_changes.insert(id.clone(), patch_changes(&item["changes"]));
        }
        match ty {
            // A steering note reaching the agent (its clientUserMessageId comes back as clientId).
            "userMessage" if started && parent.is_none() => {
                let Some(cid) = item["clientId"].as_str() else { return };
                let Some(n) = self.notes.get(cid) else { return };
                let (state, tool) = if !n.own_turn {
                    (SteerState::PickedUp, self.last_tool.clone())
                } else if n.now {
                    (SteerState::Interrupted, n.cut.clone())
                } else {
                    (SteerState::PickedUp, None)
                };
                self.notes.settle(cid, state, tool, &mut self.user_n, o);
            }
            "agentMessage" if !started => {
                let text = item["text"].as_str().unwrap_or("").to_string();
                if !text.is_empty() {
                    o.ev(ChatEventKind::AssistantMessage { id, text, model: self.model.clone(), parent_tool_id: parent });
                }
            }
            // `subAgentActivity` only says a subagent started / was messaged / was interrupted: its spawn is already the
            // `collabAgentToolCall` step, and its own steps nest under that.
            "agentMessage" | "userMessage" | "reasoning" | "plan" | "hookPrompt" | "contextCompaction" | "enteredReviewMode" | "exitedReviewMode" | "subAgentActivity" => {}
            _ => {
                let Some((name, summary, input)) = tool_view(item) else { return };
                if started && parent.is_none() {
                    self.last_tool = Some(id.clone());
                }
                if started || !self.started_tools.contains(&id) {
                    self.started_tools.insert(id.clone());
                    o.ev(ChatEventKind::ToolStart { id: id.clone(), name, summary, input, parent_tool_id: parent });
                }
                if !started {
                    let (ok, output) = tool_result(item);
                    let end = ChatEventKind::ToolEnd { id: id.clone(), ok, output: clip(&output, MAX_OUTPUT), artifact: None };
                    // `spawnAgent` returns as soon as the agent starts: its card stays running until the agent's turn ends.
                    let kids: Vec<String> = item["receiverThreadIds"].as_array().into_iter().flatten().filter_map(|t| t.as_str().map(str::to_string)).collect();
                    if ty == "collabAgentToolCall" && item["tool"] == "spawnAgent" && ok && !kids.is_empty() {
                        for k in kids {
                            self.spawn_ends.insert(k, end.clone());
                        }
                    } else {
                        o.ev(end);
                    }
                }
            }
        }
    }

    fn on_notification(&mut self, v: &Value, o: &mut Out) {
        let p = &v["params"];
        match v["method"].as_str().unwrap_or("") {
            "turn/started" if self.is_main(&p["threadId"]) => {
                self.turn_id = p["turn"]["id"].as_str().map(str::to_string);
                self.in_turn = true;
                self.last_tool = None;
                self.flush_notes(o);
                o.ev(ChatEventKind::State { state: self.state() });
            }
            // The plan tool's whole list after each change: shown as an `update_plan` step.
            "turn/plan/updated" if self.is_main(&p["threadId"]) => {
                self.plans += 1;
                let id = format!("plan-{}-{}", p["turnId"].as_str().unwrap_or(""), self.plans);
                let input = plan_input(p);
                let n = input["plan"].as_array().map_or(0, Vec::len);
                o.ev(ChatEventKind::ToolStart { id: id.clone(), name: "update_plan".into(), summary: format!("update_plan · {n} steps"), input, parent_tool_id: None });
                o.ev(ChatEventKind::ToolEnd { id, ok: true, output: String::new(), artifact: None });
            }
            "turn/completed" if self.is_main(&p["threadId"]) => {
                let t = &p["turn"];
                let status = t["status"].as_str().unwrap_or("");
                if status == "failed" {
                    let msg = t["error"]["message"].as_str().unwrap_or("The turn failed");
                    o.ev(ChatEventKind::notice(NoticeLevel::Error, msg));
                }
                self.in_turn = false;
                self.turn_id = None;
                self.perms.clear();
                self.remember.clear();
                self.end_spawns(None, o);
                o.ev(ChatEventKind::TurnEnd { duration_ms: t["durationMs"].as_u64().unwrap_or(0), ok: status == "completed" });
                self.notes_at_turn_end(status == "interrupted", o);
                o.ev(ChatEventKind::State { state: self.state() });
            }
            // A subagent's turn ended: the call that spawned it is done.
            "turn/completed" => {
                if let Some(t) = p["threadId"].as_str() {
                    self.end_spawns(Some(t), o);
                }
            }
            "item/started" => self.on_item(true, p, o),
            "item/completed" => self.on_item(false, p, o),
            "item/agentMessage/delta" => {
                let text = p["delta"].as_str().unwrap_or("").to_string();
                if !text.is_empty() {
                    o.ev(ChatEventKind::TextDelta { message_id: p["itemId"].as_str().unwrap_or("").to_string(), text, parent_tool_id: self.parent_for(&p["threadId"]) });
                }
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                let text = p["delta"].as_str().unwrap_or("").to_string();
                if !text.is_empty() {
                    o.ev(ChatEventKind::ThinkingDelta { message_id: p["itemId"].as_str().unwrap_or("").to_string(), text, parent_tool_id: self.parent_for(&p["threadId"]) });
                }
            }
            "thread/tokenUsage/updated" if self.is_main(&p["threadId"]) => {
                let u = &p["tokenUsage"];
                let g = |o: &Value, k: &str| o[k].as_u64().unwrap_or(0);
                let (tot, last) = (&u["total"], &u["last"]);
                let cached = g(tot, "cachedInputTokens");
                let tokens = Tokens {
                    input: g(tot, "inputTokens").saturating_sub(cached),
                    cached,
                    output: g(tot, "outputTokens"),
                    context: g(last, "inputTokens"),
                    turn_output: 0,
                    total: 0,
                    turn_start: None,
                };
                if let Some(w) = u["modelContextWindow"].as_u64() {
                    self.context_window = Some(w);
                }
                o.ev(ChatEventKind::Usage { model: self.model.clone(), tokens, context_window: self.context_window });
                self.ready(o);
            }
            "thread/settings/updated" if self.is_main(&p["threadId"]) => {
                let s = &p["threadSettings"];
                if let Some(m) = s["model"].as_str() {
                    self.model = m.to_string();
                }
                if let Some(a) = approval_name(&s["approvalPolicy"]) {
                    self.approval = a;
                }
                if let Some(sb) = sandbox_name(&s["sandboxPolicy"]) {
                    self.sandbox = sb;
                }
                self.ready(o);
            }
            "model/rerouted" if self.is_main(&p["threadId"]) => {
                if let Some(m) = p["toModel"].as_str() {
                    self.model = m.to_string();
                    o.ev(ChatEventKind::notice(NoticeLevel::Info, format!("Switched to {m}")));
                    self.ready(o);
                }
            }
            "thread/compacted" => o.ev(ChatEventKind::notice(NoticeLevel::Info, "Conversation compacted")),
            "error" => {
                let msg = p["error"]["message"].as_str().unwrap_or("error").to_string();
                if p["willRetry"].as_bool() == Some(true) {
                    o.ev(ChatEventKind::notice(NoticeLevel::Warn, format!("{msg} (retrying)")));
                } else {
                    o.ev(ChatEventKind::notice(NoticeLevel::Error, msg));
                }
            }
            "warning" | "configWarning" | "deprecationNotice" | "guardianWarning" => {
                let msg = p["message"].as_str().or(p["summary"].as_str()).unwrap_or("");
                if !msg.is_empty() {
                    o.ev(ChatEventKind::notice(NoticeLevel::Warn, msg));
                }
            }
            "serverRequest/resolved" => {
                let rid = match &p["requestId"] {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                if self.perms.remove(&rid).is_some() {
                    self.flush_notes(o);
                    o.ev(ChatEventKind::State { state: self.state() });
                }
            }
            _ => {}
        }
    }

    /// Ends the spawn calls held open for subagent `thread` (all of them: the chat's turn ended or the CLI exited).
    fn end_spawns(&mut self, thread: Option<&str>, o: &mut Out) {
        let ends: Vec<ChatEventKind> = match thread {
            Some(t) => self.spawn_ends.remove(t).into_iter().collect(),
            None => self.spawn_ends.drain().map(|(_, e)| e).collect(),
        };
        let mut done: HashSet<String> = HashSet::new();
        for e in ends {
            if let ChatEventKind::ToolEnd { id, .. } = &e {
                if !done.insert(id.clone()) {
                    continue;
                }
                // One call may have spawned several agents: the first to finish ends it.
                let id = id.clone();
                self.spawn_ends.retain(|_, x| !matches!(x, ChatEventKind::ToolEnd { id: i, .. } if *i == id));
            }
            o.ev(e);
        }
    }

    fn local_status(&self) -> String {
        let mut s = format!("Model: {}\nApprovals: {}", self.model, if self.approval.is_empty() { "default" } else { &self.approval });
        if !self.sandbox.is_empty() {
            s.push_str(&format!("\nSandbox: {}", self.sandbox));
        }
        if let Some(w) = self.context_window {
            s.push_str(&format!("\nContext window: {w}"));
        }
        if let Some(t) = &self.thread_id {
            s.push_str(&format!("\nThread: {t}"));
        }
        s
    }
}

fn slash_commands() -> Vec<SlashCommand> {
    [
        ("compact", "Summarize the conversation to free up context"),
        ("review", "Review uncommitted changes (or pass instructions)"),
        ("model", "Choose the model"),
        ("status", "Show model, approvals and context"),
    ]
    .iter()
    .map(|(n, d)| SlashCommand { name: n.to_string(), description: d.to_string() })
    .collect()
}

/// The slash commands with their kind: the few the app-server runs, then the TUI's.
fn command_infos() -> Vec<CommandInfo> {
    let mut out: Vec<CommandInfo> = slash_commands()
        .into_iter()
        .map(|c| CommandInfo { name: c.name, description: c.description, argument_hint: String::new(), aliases: Vec::new(), kind: CommandKind::Command })
        .collect();
    out.extend(TERMINAL_COMMANDS.iter().filter(|n| !matches!(**n, "quit" | "exit")).map(|n| CommandInfo {
        name: n.to_string(),
        description: String::new(),
        argument_hint: String::new(),
        aliases: Vec::new(),
        kind: CommandKind::Terminal,
    }));
    out
}

/// `ToolRequestUserInputQuestion[]` -> questions.
fn parse_questions(v: &Value) -> Vec<Question> {
    v.as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(i, q)| {
            let options: Vec<QuestionOption> = q["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|o| Some(QuestionOption { label: o["label"].as_str()?.to_string(), description: o["description"].as_str().unwrap_or("").to_string() }))
                .collect();
            Some(Question {
                id: q["id"].as_str().map(str::to_string).unwrap_or_else(|| i.to_string()),
                header: q["header"].as_str().unwrap_or("").to_string(),
                question: q["question"].as_str()?.to_string(),
                allow_other: q["isOther"].as_bool().unwrap_or(false) || options.is_empty(),
                options,
                multi_select: false,
                secret: q["isSecret"].as_bool().unwrap_or(false),
            })
        })
        .collect()
}

/// `turn/plan/updated` -> `{plan: [{step, status}], explanation?}`, statuses
/// as `pending | in_progress | completed` (Codex says `inProgress`).
fn plan_input(p: &Value) -> Value {
    let plan: Vec<Value> = p["plan"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| {
            let status = match s["status"].as_str().unwrap_or("pending") {
                "inProgress" | "in_progress" => "in_progress",
                "completed" => "completed",
                _ => "pending",
            };
            json!({"step": s["step"].as_str().unwrap_or(""), "status": status})
        })
        .collect();
    let mut v = json!({"plan": plan});
    if let Some(e) = p["explanation"].as_str().filter(|e| !e.is_empty()) {
        v["explanation"] = json!(e);
    }
    v
}

fn approval_name(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Object(m) => m.keys().next().cloned(),
        _ => None,
    }
}

fn sandbox_name(v: &Value) -> Option<String> {
    let s = v.as_str().or(v["type"].as_str())?;
    Some(
        match s {
            "readOnly" => "read-only",
            "workspaceWrite" => "workspace-write",
            "dangerFullAccess" => "danger-full-access",
            other => other,
        }
        .to_string(),
    )
}

fn sandbox_policy(mode: &str) -> Value {
    match mode {
        "read-only" => json!({"type": "readOnly", "networkAccess": false}),
        "workspace-write" => json!({"type": "workspaceWrite", "writableRoots": [], "networkAccess": false, "excludeTmpdirEnvVar": false, "excludeSlashTmp": false}),
        _ => json!({"type": "dangerFullAccess"}),
    }
}

/// `/bin/zsh -lc 'touch b.txt'` -> `touch b.txt`.
/// Where Codex keeps the exec-policy rules an approval can add.
fn codex_rules_file() -> String {
    let home = std::env::var("CODEX_HOME").ok().filter(|h| !h.is_empty()).map(std::path::PathBuf::from).or_else(|| dirs::home_dir().map(|h| h.join(".codex")));
    home.map(|h| crate::util::home_short(&h.join("rules").join("default.rules").to_string_lossy())).unwrap_or_else(|| "~/.codex/rules/default.rules".into())
}

/// The "don't ask again" decisions an approval request offers, in plain words
/// (chat-only first). v2 command approvals list them in `availableDecisions`;
/// file changes and the legacy requests have a fixed set.
fn approval_options(method: &str, p: &Value) -> Vec<(RememberOption, Value)> {
    let command = method.contains("ommand") || method == "execCommandApproval";
    let legacy = matches!(method, "execCommandApproval" | "applyPatchApproval");
    let cmd = match p["command"].as_str() {
        Some(c) => unwrap_shell(c),
        None => p["command"].as_array().map(|a| a.iter().filter_map(|s| s.as_str()).collect::<Vec<_>>().join(" ")).unwrap_or_default(),
    };
    let proposed = p.get("proposedExecpolicyAmendment").or(p.get("proposed_execpolicy_amendment")).filter(|a| a.as_array().is_some_and(|a| !a.is_empty())).cloned();
    let decisions: Vec<Value> = match p["availableDecisions"].as_array() {
        Some(d) => d.clone(),
        None if legacy => {
            let mut d = vec![json!("approved_for_session")];
            if let Some(a) = &proposed {
                d.push(json!({"approved_execpolicy_amendment": {"proposed_execpolicy_amendment": a}}));
            }
            d
        }
        None => {
            let mut d = vec![json!("acceptForSession")];
            if let (true, Some(a)) = (command, &proposed) {
                d.push(json!({"acceptWithExecpolicyAmendment": {"execpolicy_amendment": a}}));
            }
            d
        }
    };
    let words = |a: &Value| a.as_array().map(|a| a.iter().filter_map(|s| s.as_str()).collect::<Vec<_>>().join(" ")).unwrap_or_default();
    let mut chat = Vec::new();
    let mut saved = Vec::new();
    for d in decisions {
        let opt = |label: String, detail: String, scope: RememberScope, file: Option<String>, rules: Vec<String>| RememberOption { id: String::new(), label, detail, scope, file, mode: None, rules };
        match &d {
            Value::String(s) if s == "acceptForSession" || s == "approved_for_session" => {
                let o = if command {
                    let what = if cmd.is_empty() { "this command".to_string() } else { format!("`{}`", crate::util::truncate(&cmd, 60)) };
                    opt(format!("Allow {what} for the rest of this chat"), "Codex won't ask again for this command until the chat ends. Nothing is saved.".into(), RememberScope::Chat, None, Vec::new())
                } else {
                    opt("Allow more edits to these files in this chat".into(), "Codex won't ask again for changes to the same files until the chat ends. Nothing is saved.".into(), RememberScope::Chat, None, Vec::new())
                };
                chat.push((o, d.clone()));
            }
            Value::Object(m) => {
                let amend = m.get("acceptWithExecpolicyAmendment").map(|x| &x["execpolicy_amendment"]).or(m.get("approved_execpolicy_amendment").map(|x| &x["proposed_execpolicy_amendment"]));
                if let Some(a) = amend {
                    let prefix = words(a);
                    if prefix.is_empty() {
                        continue;
                    }
                    let file = codex_rules_file();
                    let parts: Vec<String> = a.as_array().into_iter().flatten().filter_map(|s| s.as_str()).map(|s| format!("{s:?}")).collect();
                    saved.push((
                        opt(
                            format!("Always allow commands starting with `{}`", crate::util::truncate(&prefix, 60)),
                            format!("Saved as a rule in {file}: applies in every project and future Codex session, including ones outside coool."),
                            RememberScope::User,
                            Some(file),
                            vec![format!("prefix_rule(pattern=[{}], decision=\"allow\")", parts.join(", "))],
                        ),
                        d.clone(),
                    ));
                } else if let Some(n) = m.get("applyNetworkPolicyAmendment").map(|x| &x["network_policy_amendment"]).or(m.get("network_policy_amendment").map(|x| &x["network_policy_amendment"])) {
                    let host = n["host"].as_str().unwrap_or("");
                    if n["action"] != "allow" || host.is_empty() {
                        continue;
                    }
                    saved.push((
                        opt(format!("Always allow network access to {host}"), "Saved to Codex's network policy: applies to future Codex sessions, including ones outside coool.".into(), RememberScope::User, None, vec![format!("allow {host}")]),
                        d.clone(),
                    ));
                }
            }
            _ => {}
        }
    }
    let mut out: Vec<(RememberOption, Value)> = chat.into_iter().chain(saved).collect();
    for (i, (o, _)) in out.iter_mut().enumerate() {
        o.id = i.to_string();
    }
    out
}

fn unwrap_shell(cmd: &str) -> String {
    for pre in ["/bin/zsh -lc ", "/bin/bash -lc ", "bash -lc ", "zsh -lc ", "/bin/sh -c ", "sh -c "] {
        if let Some(rest) = cmd.strip_prefix(pre) {
            let r = rest.trim();
            if r.len() >= 2 && ((r.starts_with('\'') && r.ends_with('\'')) || (r.starts_with('"') && r.ends_with('"'))) {
                return r[1..r.len() - 1].to_string();
            }
            return r.to_string();
        }
    }
    cmd.to_string()
}

/// A fileChange's `changes` (`[{path, kind: {type, move_path}, diff}]`) in one shape for every surface:
/// `[{path, kind: "add" | "delete" | "update", move_path?, diff}]`, paths as Codex gives them (absolute).
fn patch_changes(v: &Value) -> Vec<Value> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let path = c["path"].as_str()?;
            let kind = c["kind"]["type"].as_str().or(c["kind"].as_str()).unwrap_or("update");
            let mut o = json!({"path": path, "kind": kind, "diff": c["diff"].as_str().unwrap_or("")});
            if let Some(m) = c["kind"]["move_path"].as_str() {
                o["move_path"] = json!(m);
            }
            Some(o)
        })
        .collect()
}

/// Legacy `applyPatchApproval.fileChanges` (`{path: {type: add | delete, content} | {type: update, unified_diff,
/// move_path}}`) in the same shape.
fn legacy_patch_changes(v: &Value) -> Vec<Value> {
    v.as_object()
        .into_iter()
        .flatten()
        .map(|(path, c)| {
            let kind = c["type"].as_str().unwrap_or("update");
            let diff = c["unified_diff"].as_str().or(c["content"].as_str()).unwrap_or("");
            let mut o = json!({"path": path, "kind": kind, "diff": diff});
            if let Some(m) = c["move_path"].as_str() {
                o["move_path"] = json!(m);
            }
            o
        })
        .collect()
}

/// "apply_patch · ~/w/a.rs, ~/w/b.rs".
fn patch_line(changes: &[Value]) -> String {
    let paths: Vec<String> = changes.iter().filter_map(|c| c["path"].as_str().map(crate::util::home_short)).collect();
    tool_line("apply_patch", &paths.join(", "))
}

/// A patch approval's input: every file it writes (`files`, absolute, a move's target too: what the Risky rule
/// checks) and the changes with their diffs (the Needs you page shows them, the AI read sends them).
fn patch_input(changes: Vec<Value>, p: &Value) -> Value {
    let mut files: Vec<String> = Vec::new();
    for c in &changes {
        for k in ["path", "move_path"] {
            if let Some(f) = c[k].as_str().filter(|f| !files.iter().any(|x| x == f)) {
                files.push(f.to_string());
            }
        }
    }
    json!({"files": files, "changes": changes, "reason": p["reason"], "grantRoot": p["grantRoot"]})
}

fn tool_line(name: &str, detail: &str) -> String {
    if detail.is_empty() { name.to_string() } else { format!("{name} · {}", crate::util::one_line(detail, 140)) }
}

/// (name, summary, input) for a tool-like thread item.
fn tool_view(item: &Value) -> Option<(String, String, Value)> {
    let s = |k: &str| item[k].as_str().unwrap_or("").to_string();
    Some(match item["type"].as_str()? {
        "commandExecution" => {
            let cmd = unwrap_shell(&s("command"));
            ("shell".into(), tool_line("shell", &cmd), json!({"command": cmd, "cwd": item["cwd"]}))
        }
        "fileChange" => {
            let paths: Vec<String> = item["changes"].as_array().map(|a| a.iter().filter_map(|c| c["path"].as_str().map(crate::util::home_short)).collect()).unwrap_or_default();
            ("apply_patch".into(), tool_line("apply_patch", &paths.join(", ")), json!({"changes": patch_changes(&item["changes"])}))
        }
        "mcpToolCall" => {
            let name = format!("{}.{}", s("server"), s("tool"));
            (name.clone(), crate::util::tool_summary(&name, &item["arguments"]), item["arguments"].clone())
        }
        "dynamicToolCall" => {
            let name = s("tool");
            (name.clone(), crate::util::tool_summary(&name, &item["arguments"]), item["arguments"].clone())
        }
        "collabAgentToolCall" => {
            // The rollout's names (`spawn_agent`, `wait_agent`, …), which every surface reads as sub-agent calls.
            let name = match s("tool").as_str() {
                "spawnAgent" => "spawn_agent".to_string(),
                "sendInput" => "send_input".into(),
                "resumeAgent" => "resume_agent".into(),
                "wait" => "wait_agent".into(),
                "closeAgent" => "close_agent".into(),
                other => other.to_string(),
            };
            (name.clone(), tool_line(&name, &s("prompt")), json!({"prompt": item["prompt"], "model": item["model"], "receiverThreadIds": item["receiverThreadIds"]}))
        }
        "webSearch" => ("web_search".into(), tool_line("web_search", &s("query")), item.clone()),
        "imageView" => ("view_image".into(), tool_line("view_image", &s("path")), item.clone()),
        "imageGeneration" => ("image_generation".into(), "image_generation".into(), item.clone()),
        "sleep" => ("sleep".into(), "sleep".into(), item.clone()),
        other => (other.to_string(), other.to_string(), item.clone()),
    })
}

fn tool_result(item: &Value) -> (bool, String) {
    let status = item["status"].as_str().unwrap_or("completed");
    match item["type"].as_str().unwrap_or("") {
        "commandExecution" => {
            let ok = status == "completed" && item["exitCode"].as_i64().unwrap_or(0) == 0;
            let mut out = item["aggregatedOutput"].as_str().unwrap_or("").to_string();
            if status == "declined" && out.is_empty() {
                out = "declined".into();
            } else if !ok && out.is_empty() {
                out = format!("exit code {}", item["exitCode"].as_i64().map(|c| c.to_string()).unwrap_or_else(|| status.into()));
            }
            (ok, out)
        }
        "mcpToolCall" => match item["error"]["message"].as_str() {
            Some(e) => (false, e.to_string()),
            None => {
                let text: Vec<&str> = item["result"]["content"].as_array().into_iter().flatten().filter_map(|c| c["text"].as_str()).collect();
                (status != "failed", text.join("\n"))
            }
        },
        "fileChange" => {
            let paths: Vec<&str> = item["changes"].as_array().into_iter().flatten().filter_map(|c| c["path"].as_str()).collect();
            (status == "completed", paths.join("\n"))
        }
        "dynamicToolCall" => {
            let text: Vec<&str> = item["contentItems"].as_array().into_iter().flatten().filter_map(|c| c["text"].as_str()).collect();
            (item["success"].as_bool().unwrap_or(status == "completed"), text.join("\n"))
        }
        _ => (!matches!(status, "failed" | "declined" | "errored"), String::new()),
    }
}

impl Backend for Codex {
    fn start(&mut self, o: &mut Out) {
        let info = json!({"name": self.client_name, "title": "coool", "version": env!("CARGO_PKG_VERSION")});
        self.request("initialize", json!({"clientInfo": info, "capabilities": null}), Req::Init, o);
    }

    fn on_line(&mut self, line: &str, o: &mut Out) {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return };
        let has_id = v.get("id").is_some_and(|i| !i.is_null());
        if has_id && v.get("method").is_some() {
            self.on_server_request(&v, o);
        } else if has_id {
            self.on_response(&v, o);
        } else if v.get("method").is_some() {
            self.on_notification(&v, o);
        }
    }

    fn send(&mut self, text: &str, o: &mut Out) -> Result<()> {
        if let Some((name, args)) = slash_command(text) {
            match name {
                "compact" | "review" => {
                    let Some(tid) = self.thread_id.clone() else { bail!("the chat is still starting") };
                    if name == "compact" {
                        self.request("thread/compact/start", json!({"threadId": tid}), Req::Other("compact"), o);
                    } else {
                        let target = if args.is_empty() { json!({"type": "uncommittedChanges"}) } else { json!({"type": "custom", "instructions": args}) };
                        self.request("review/start", json!({"threadId": tid, "target": target}), Req::Other("start the review"), o);
                    }
                    self.user_n += 1;
                    o.ev(ChatEventKind::UserMessage { id: format!("u{}", self.user_n), text: text.to_string(), steer: false, note_id: None });
                    return Ok(());
                }
                "model" if !args.is_empty() => {
                    self.set_model(args, o)?;
                    o.ev(ChatEventKind::notice(NoticeLevel::Info, format!("Model set to {args}")));
                    return Ok(());
                }
                "model" | "status" => {
                    o.ev(ChatEventKind::notice(NoticeLevel::Info, self.local_status()));
                    return Ok(());
                }
                n if TERMINAL_COMMANDS.contains(&n) => {
                    o.ev(ChatEventKind::needs_terminal(format!("/{n} only works in the terminal")));
                    return Ok(());
                }
                // Anything else (e.g. a custom prompt name) goes to the model as typed.
                _ => {}
            }
        }
        self.user_n += 1;
        o.ev(ChatEventKind::UserMessage { id: format!("u{}", self.user_n), text: text.to_string(), steer: false, note_id: None });
        if self.thread_id.is_none() {
            self.queue.push(text.to_string());
        } else {
            self.start_turn(text, None, o);
        }
        o.ev(ChatEventKind::State { state: self.state() });
        Ok(())
    }

    fn steer(&mut self, note_id: &str, text: &str, now: bool, o: &mut Out) -> Result<()> {
        // While the person is asked, nothing is cut: the note waits for the answer.
        let now = now && self.perms.is_empty() && self.in_turn;
        self.notes.add(note_id, text, now, o);
        self.flush_notes(o);
        o.ev(ChatEventKind::State { state: self.state() });
        Ok(())
    }

    fn cancel_steer(&mut self, note_id: &str, o: &mut Out) -> Result<()> {
        match self.notes.get(note_id) {
            None => bail!("no queued note {note_id} (already delivered or gone)"),
            Some(n) if n.sent => bail!("Codex already has the note and offers no way to take it back; it reaches the agent at its next step"),
            Some(_) => {
                self.notes.settle(note_id, SteerState::Cancelled, None, &mut self.user_n, o);
                Ok(())
            }
        }
    }

    fn interrupt(&mut self, o: &mut Out) -> Result<()> {
        self.queue.clear();
        if self.in_turn {
            self.stopping = true;
        } else {
            self.notes.unused(|_| true, o);
        }
        if let (Some(tid), Some(turn)) = (self.thread_id.clone(), self.turn_id.clone())
            && self.in_turn
        {
            self.request("turn/interrupt", json!({"threadId": tid, "turnId": turn}), Req::Other("interrupt"), o);
        }
        o.ev(ChatEventKind::State { state: self.state() });
        Ok(())
    }

    fn set_model(&mut self, model: &str, o: &mut Out) -> Result<()> {
        if model.trim().is_empty() {
            bail!("empty model");
        }
        if self.model != model {
            // Known again after the next model response.
            self.context_window = None;
        }
        self.model = model.to_string();
        self.next_model = Some(model.to_string());
        self.ready(o);
        Ok(())
    }

    fn set_permission_mode(&mut self, mode: &str, o: &mut Out) -> Result<()> {
        let mode = approval_policy(mode);
        if SANDBOX_MODES.contains(&mode) {
            self.sandbox = mode.to_string();
            self.next_sandbox = Some(mode.to_string());
        } else if APPROVAL_POLICIES.contains(&mode) {
            self.approval = mode.to_string();
            self.next_approval = Some(mode.to_string());
        } else {
            bail!("unknown Codex permission mode `{mode}` (approval: {}; sandbox: {})", APPROVAL_POLICIES.join(", "), SANDBOX_MODES.join(", "));
        }
        self.ready(o);
        Ok(())
    }

    fn respond_permission_remember(&mut self, request_id: &str, remember: &str, o: &mut Out) -> Result<()> {
        let Some(decision) = self.remember.get(request_id).and_then(|r| r.iter().find(|(o, _)| o.id == remember)).map(|(_, d)| d.clone()) else {
            bail!("no remember option {remember} for request {request_id}")
        };
        let Some((id, _)) = self.perms.remove(request_id) else { bail!("no pending permission request {request_id}") };
        self.remember.remove(request_id);
        o.write(&json!({"jsonrpc": "2.0", "id": id, "result": {"decision": decision}}));
        self.flush_notes(o);
        o.ev(ChatEventKind::State { state: self.state() });
        Ok(())
    }

    fn respond_permission(&mut self, request_id: &str, allow: bool, always: bool, o: &mut Out) -> Result<()> {
        // `always`: only an option that stays inside this chat (never a saved rule).
        let chat_only = self.remember.get(request_id).and_then(|r| r.first()).filter(|(r, _)| !r.persistent()).map(|(r, _)| r.id.clone());
        if let (true, true, Some(rid)) = (allow, always, chat_only) {
            return self.respond_permission_remember(request_id, &rid, o);
        }
        let Some((id, kind)) = self.perms.remove(request_id) else { bail!("no pending permission request {request_id}") };
        self.remember.remove(request_id);
        if let PermKind::Question(_) = kind {
            // Declined: an empty answer set (the request has no "decline").
            o.write(&json!({"jsonrpc": "2.0", "id": id, "result": {"answers": {}}}));
            o.ev(ChatEventKind::State { state: self.state() });
            return Ok(());
        }
        let decision = match (kind, allow) {
            (PermKind::V2, true) => json!("accept"),
            (PermKind::V2, false) => json!("decline"),
            (PermKind::Legacy, true) => json!("approved"),
            (PermKind::Legacy, false) => json!({"denied": {"rejection": "The user denied this."}}),
            (PermKind::Question(_), _) => unreachable!("handled above"),
        };
        o.write(&json!({"jsonrpc": "2.0", "id": id, "result": {"decision": decision}}));
        self.flush_notes(o);
        o.ev(ChatEventKind::State { state: self.state() });
        Ok(())
    }

    fn respond_question(&mut self, request_id: &str, answers: &[Vec<String>], o: &mut Out) -> Result<()> {
        let Some((_, PermKind::Question(ids))) = self.perms.get(request_id) else { bail!("no pending question {request_id}") };
        // ToolRequestUserInputResponse: `{"answers": {<question id>: {"answers": [..]}}}`.
        let mut map = serde_json::Map::new();
        for (qid, a) in ids.iter().zip(answers) {
            let picked: Vec<&str> = a.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
            if !picked.is_empty() {
                map.insert(qid.clone(), json!({"answers": picked}));
            }
        }
        if map.is_empty() {
            bail!("answer at least one question, or decline");
        }
        let (id, _) = self.perms.remove(request_id).expect("checked");
        o.write(&json!({"jsonrpc": "2.0", "id": id, "result": {"answers": map}}));
        self.flush_notes(o);
        o.ev(ChatEventKind::State { state: self.state() });
        Ok(())
    }

    fn on_exit(&mut self, o: &mut Out) {
        self.perms.clear();
        self.spawn_ends.clear();
        self.remember.clear();
        self.queue.clear();
        self.notes.unused(|_| true, o);
        if self.in_turn {
            self.in_turn = false;
            o.ev(ChatEventKind::TurnEnd { duration_ms: 0, ok: false });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::testutil::{replay, replay_full};

    fn opts() -> ChatOptions {
        ChatOptions { provider: Provider::Codex, cwd: "/work".into(), resume: None, model: Some("gpt-5.6-luna".into()), permission_mode: Some("untrusted".into()), ladder: None }
    }

    #[test]
    fn mcp_servers_become_config_overrides() {
        let a = mcp_args(&[super::super::McpServer {
            name: "coool-device".into(),
            command: "/Applications/coool.app/Contents/MacOS/coool".into(),
            args: vec!["--coool-device-mcp".into()],
            env: vec![("COOOL_DEVICE_TOKEN".into(), "t\"1".into())],
            allow_all: true,
            tool_timeout_sec: Some(900),
        }]);
        assert_eq!(
            a,
            vec![
                "-c",
                r#"mcp_servers.coool-device.command="/Applications/coool.app/Contents/MacOS/coool""#,
                "-c",
                r#"mcp_servers.coool-device.args=["--coool-device-mcp"]"#,
                "-c",
                r#"mcp_servers.coool-device.env={"COOOL_DEVICE_TOKEN"="t\"1"}"#,
                "-c",
                r#"mcp_servers.coool-device.default_tools_approval_mode="approve""#,
                "-c",
                "mcp_servers.coool-device.tool_timeout_sec=900",
            ]
        );
    }

    /// `availableDecisions` exactly as Codex 0.145 sent them (untrusted mode):
    /// no session option, only a prefix rule saved for every project.
    #[test]
    fn approval_options_say_what_they_save() {
        let p: Value = serde_json::from_str(r#"{"command":"/bin/zsh -lc 'touch b.txt'","proposedExecpolicyAmendment":["touch","b.txt"],"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["touch","b.txt"]}},"cancel"]}"#).unwrap();
        let o = approval_options("item/commandExecution/requestApproval", &p);
        assert_eq!(o.len(), 1);
        assert_eq!((o[0].0.label.as_str(), o[0].0.scope), ("Always allow commands starting with `touch b.txt`", RememberScope::User));
        assert!(o[0].0.file.as_deref().unwrap().ends_with("rules/default.rules"));
        assert!(o[0].0.detail.contains("every project"));
        assert_eq!(o[0].1, json!({"acceptWithExecpolicyAmendment": {"execpolicy_amendment": ["touch", "b.txt"]}}));
        // With a session option offered, it comes first.
        let p: Value = serde_json::from_str(r#"{"command":"npm test","availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["npm","test"]}},"acceptForSession","decline"]}"#).unwrap();
        let o = approval_options("item/commandExecution/requestApproval", &p);
        assert_eq!(o.iter().map(|x| x.0.scope).collect::<Vec<_>>(), [RememberScope::Chat, RememberScope::User]);
        assert_eq!(o[0].0.label, "Allow `npm test` for the rest of this chat");
        assert_eq!((o[0].0.id.as_str(), o[1].0.id.as_str()), ("0", "1"));
        // Only accept/decline: nothing to remember.
        let p: Value = serde_json::from_str(r#"{"command":"ls","availableDecisions":["accept","decline"]}"#).unwrap();
        assert!(approval_options("item/commandExecution/requestApproval", &p).is_empty());
        // File changes: the fixed set includes a session option.
        let o = approval_options("item/fileChange/requestApproval", &json!({}));
        assert_eq!((o.len(), o[0].0.scope, o[0].1.clone()), (1, RememberScope::Chat, json!("acceptForSession")));
    }

    /// Ladder on: the person's own `developer_instructions` are read first and the policy goes after them, on
    /// `thread/start` and on `thread/resume` alike. Off: no `config/read`, no instructions.
    #[test]
    fn ladder_policy_rides_on_the_thread_after_the_persons_own() {
        use crate::ladder::{Ladder, Role, Tier};
        let lad = Ladder { tiers: vec![Tier { role: Role::Small, model: "gpt-5.6-luna".into(), label: "GPT-5.6-Luna".into() }], max_parallel: 2, verify_tests: false };
        let sent = |o: &Out, method: &str| o.writes.iter().map(|w| serde_json::from_str::<Value>(w).unwrap()).find(|v| v["method"] == method);
        for resume in [None, Some("t-1".to_string())] {
            let mut c = Codex::new(&ChatOptions { ladder: Some(lad.clone()), resume: resume.clone(), ..opts() });
            let mut o = Out::default();
            c.start(&mut o);
            c.on_line(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#, &mut o);
            assert!(sent(&o, "thread/start").is_none() && sent(&o, "thread/resume").is_none(), "waits for config/read");
            let read = sent(&o, "config/read").unwrap();
            let id = read["id"].as_u64().unwrap();
            c.on_line(&format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{{"config":{{"developer_instructions":"Mine first."}}}}}}"#), &mut o);
            let t = sent(&o, if resume.is_some() { "thread/resume" } else { "thread/start" }).unwrap();
            let di = t["params"]["developerInstructions"].as_str().unwrap();
            assert!(di.starts_with("Mine first.\n\n# Ladder"), "{di}");
            assert!(di.contains("`spawn_agent`'s `model`") && di.contains("GPT-5.6-Luna"));
            assert_eq!(t["params"]["approvalPolicy"], "untrusted", "permissions unchanged");
        }
        // A failed config/read still starts the thread, with the policy alone.
        let mut c = Codex::new(&ChatOptions { ladder: Some(lad), ..opts() });
        let mut o = Out::default();
        c.start(&mut o);
        c.on_line(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#, &mut o);
        let id = sent(&o, "config/read").unwrap()["id"].as_u64().unwrap();
        c.on_line(&format!(r#"{{"jsonrpc":"2.0","id":{id},"error":{{"message":"no"}}}}"#), &mut o);
        assert!(sent(&o, "thread/start").unwrap()["params"]["developerInstructions"].as_str().unwrap().starts_with("# Ladder"));
        // Off.
        let mut c = Codex::new(&opts());
        let mut o = Out::default();
        c.start(&mut o);
        c.on_line(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#, &mut o);
        assert!(sent(&o, "config/read").is_none());
        assert!(sent(&o, "thread/start").unwrap()["params"].get("developerInstructions").is_none());
    }

    #[test]
    fn always_never_applies_a_saved_rule() {
        let mut c = Codex::new(&opts());
        let mut o = Out::default();
        let req = |id: u64, dec: &str| format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"item/commandExecution/requestApproval","params":{{"command":"touch b.txt","availableDecisions":{dec}}}}}"#);
        c.on_line(&req(1, r#"["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["touch","b.txt"]}},"cancel"]"#), &mut o);
        c.on_line(&req(2, r#"["accept","acceptForSession","decline"]"#), &mut o);
        c.on_line(&req(3, r#"["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["touch","b.txt"]}},"cancel"]"#), &mut o);
        let ChatEventKind::PermissionRequest { remember, .. } = o.events.iter().find(|e| matches!(e, ChatEventKind::PermissionRequest { .. })).unwrap() else { panic!() };
        assert_eq!(remember.len(), 1);
        let mut o = Out::default();
        c.respond_permission("1", true, true, &mut o).unwrap();
        c.respond_permission("2", true, true, &mut o).unwrap();
        c.respond_permission_remember("3", "0", &mut o).unwrap();
        let d: Vec<Value> = o.writes.iter().map(|w| serde_json::from_str::<Value>(w).unwrap()["result"]["decision"].clone()).collect();
        assert_eq!(d, [json!("accept"), json!("acceptForSession"), json!({"acceptWithExecpolicyAmendment": {"execpolicy_amendment": ["touch", "b.txt"]}})]);
        assert_eq!(c.state(), ChatState::Idle);
    }

    /// Real run: approval of a shell command, an interrupted turn, then a turn
    /// on another model.
    #[test]
    fn fixture_approval_interrupt_model_switch() {
        let mut c = Codex::new(&opts());
        let (evs, writes) = replay_full(&mut c, include_str!("fixtures/codex_approval_interrupt_model.jsonl"));
        let ChatEventKind::Ready { session_id, model, permission_mode, models, .. } = evs.iter().find(|e| matches!(e, ChatEventKind::Ready { .. })).unwrap() else { panic!() };
        assert!(!session_id.is_empty());
        assert_eq!((model.as_str(), permission_mode.as_str()), ("gpt-5.6-luna", "untrusted"));
        let _ = models;
        let perm = evs.iter().find_map(|e| if let ChatEventKind::PermissionRequest { tool, summary, .. } = e { Some((tool.clone(), summary.clone())) } else { None });
        assert_eq!(perm, Some(("shell".into(), "shell · touch b.txt".into())));
        // Both answers (accept, then decline) went back as JSON-RPC responses.
        let answered: Vec<String> = writes
            .iter()
            .map(|w| serde_json::from_str::<Value>(w).unwrap())
            .filter_map(|w| w["result"]["decision"].as_str().map(str::to_string))
            .collect();
        assert_eq!(answered, vec!["accept", "decline"]);
        let ends: Vec<(bool, String)> = evs.iter().filter_map(|e| if let ChatEventKind::ToolEnd { ok, output, .. } = e { Some((*ok, output.clone())) } else { None }).collect();
        assert!(ends.iter().any(|e| e.0));
        assert!(ends.iter().any(|e| !e.0 && e.1 == "declined"), "{ends:?}");
        // turn/start carried the new model; the last answer is attributed to it.
        assert!(writes.iter().any(|w| w.contains("\"turn/start\"") && w.contains("gpt-5.6-terra")));
        assert!(writes.iter().any(|w| w.contains("\"turn/interrupt\"")));
        let ends: Vec<bool> = evs.iter().filter_map(|e| if let ChatEventKind::TurnEnd { ok, .. } = e { Some(*ok) } else { None }).collect();
        assert_eq!(ends, vec![true, true, false, true]);
        let last = evs.iter().rev().find_map(|e| if let ChatEventKind::AssistantMessage { text, model, .. } = e { Some((text.clone(), model.clone())) } else { None });
        assert_eq!(last, Some(("ok".into(), "gpt-5.6-terra".into())));
        let u = evs.iter().rev().find_map(|e| if let ChatEventKind::Usage { tokens, context_window, .. } = e { Some((tokens.clone(), *context_window)) } else { None }).unwrap();
        assert!(u.0.output > 0 && u.0.context > 0);
        assert!(u.1.is_some());
        assert_eq!(c.state(), ChatState::Idle);
    }

    #[test]
    fn prompts_before_thread_are_queued_then_sent() {
        let mut c = Codex::new(&opts());
        let mut o = Out::default();
        c.start(&mut o);
        c.send("hi", &mut o).unwrap();
        assert_eq!(o.writes.len(), 1, "only initialize so far");
        c.on_line(r#"{"id":1,"result":{}}"#, &mut o);
        c.on_line(r#"{"id":3,"result":{"thread":{"id":"t1"},"model":"m","approvalPolicy":"on-request","sandbox":{"type":"workspaceWrite"}}}"#, &mut o);
        let last: Value = serde_json::from_str(o.writes.last().unwrap()).unwrap();
        assert_eq!(last["method"], "turn/start");
        assert_eq!(last["params"]["input"][0]["text"], "hi");
        assert_eq!(c.sandbox, "workspace-write");
        // A second prompt mid-turn steers the running turn.
        c.on_line(r#"{"method":"turn/started","params":{"threadId":"t1","turn":{"id":"turn1"}}}"#, &mut o);
        c.send("also this", &mut o).unwrap();
        let last: Value = serde_json::from_str(o.writes.last().unwrap()).unwrap();
        assert_eq!((last["method"].as_str(), last["params"]["expectedTurnId"].as_str()), (Some("turn/steer"), Some("turn1")));
    }

    #[test]
    fn slash_commands_map_to_rpcs_or_the_terminal() {
        let mut c = Codex::new(&opts());
        c.thread_id = Some("t1".into());
        let mut o = Out::default();
        c.send("/compact", &mut o).unwrap();
        c.send("/review focus on errors", &mut o).unwrap();
        c.send("/diff", &mut o).unwrap();
        c.send("/model gpt-x", &mut o).unwrap();
        let w: Vec<Value> = o.writes.iter().map(|w| serde_json::from_str(w).unwrap()).collect();
        assert_eq!(w[0]["method"], "thread/compact/start");
        assert_eq!(w[1]["params"]["target"]["instructions"], "focus on errors");
        assert_eq!(w.len(), 2);
        assert!(o.events.iter().any(|e| matches!(e, ChatEventKind::Notice { needs_terminal: true, text, .. } if text.starts_with("/diff"))));
        assert_eq!(c.next_model.as_deref(), Some("gpt-x"));
        assert!(c.set_permission_mode("bogus", &mut o).is_err());
        c.set_permission_mode("never", &mut o).unwrap();
        c.set_permission_mode("danger-full-access", &mut o).unwrap();
        c.start_turn("go", None, &mut o);
        let t: Value = serde_json::from_str(o.writes.last().unwrap()).unwrap();
        assert_eq!((t["params"]["approvalPolicy"].as_str(), t["params"]["sandboxPolicy"]["type"].as_str(), t["params"]["model"].as_str()), (Some("never"), Some("dangerFullAccess"), Some("gpt-x")));
    }

    #[test]
    fn subagent_items_nest_under_the_spawning_call() {
        let mut c = Codex::new(&opts());
        c.thread_id = Some("main".into());
        let evs = replay(
            &mut c,
            &[
                r#"{"method":"item/completed","params":{"threadId":"main","turnId":"x","item":{"type":"collabAgentToolCall","id":"call1","tool":"spawnAgent","status":"completed","senderThreadId":"main","receiverThreadIds":["kid"],"prompt":"look around","model":null,"agentsStates":{}}}}"#,
                // Waiting on the agent names it too; its steps still belong to the spawn.
                r#"{"method":"item/started","params":{"threadId":"main","turnId":"x","item":{"type":"collabAgentToolCall","id":"call2","tool":"wait","status":"inProgress","senderThreadId":"main","receiverThreadIds":["kid"],"prompt":null,"model":null,"agentsStates":{}}}}"#,
                r#"{"method":"item/started","params":{"threadId":"kid","turnId":"y","item":{"type":"commandExecution","id":"e1","command":"/bin/zsh -lc ls","cwd":"/w","status":"inProgress"}}}"#,
                r#"{"method":"item/agentMessage/delta","params":{"threadId":"kid","itemId":"m1","delta":"hi"}}"#,
                r#"{"method":"turn/completed","params":{"threadId":"kid","turn":{"id":"y","status":"completed"}}}"#,
            ]
            .iter()
            .map(|l| json!({"dir": "out", "line": l}).to_string())
            .collect::<Vec<_>>()
            .join("\n"),
        );
        let parents: Vec<Option<String>> = evs
            .iter()
            .filter_map(|e| match e {
                ChatEventKind::ToolStart { parent_tool_id, .. } | ChatEventKind::TextDelta { parent_tool_id, .. } => Some(parent_tool_id.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(parents, vec![None, None, Some("call1".into()), Some("call1".into())]);
        // A subagent's turn ending is not the chat's turn ending.
        assert!(!evs.iter().any(|e| matches!(e, ChatEventKind::TurnEnd { .. })));
        // The spawn call ends when its agent's turn does (it returned at once), named as the rollout names it.
        assert!(matches!(&evs[0], ChatEventKind::ToolStart { name, .. } if name == "spawn_agent"));
        let end = evs.iter().position(|e| matches!(e, ChatEventKind::ToolEnd { id, .. } if id == "call1")).expect("the spawn ends");
        let kid_text = evs.iter().position(|e| matches!(e, ChatEventKind::TextDelta { .. })).unwrap();
        assert!(end > kid_text, "{evs:?}");
    }

    /// Shapes from `codex app-server generate-ts` (ToolRequestUserInputParams /
    /// ToolRequestUserInputResponse, marked experimental in 0.145).
    #[test]
    fn request_user_input_is_a_question() {
        let mut c = Codex::new(&opts());
        c.thread_id = Some("t1".into());
        let mut o = Out::default();
        c.on_line(
            r#"{"id":12,"method":"item/tool/requestUserInput","params":{"threadId":"t1","turnId":"x","itemId":"i","autoResolutionMs":null,"questions":[{"id":"color","header":"Color","question":"Which color?","isOther":true,"isSecret":false,"options":[{"label":"Red","description":"warm"},{"label":"Blue","description":"cool"}]},{"id":"name","header":"Name","question":"Your name?","isOther":false,"isSecret":false,"options":null}]}}"#,
            &mut o,
        );
        let ChatEventKind::Question { request_id, questions } = &o.events[0] else { panic!("{:?}", o.events) };
        assert_eq!(request_id, "12");
        assert_eq!((questions[0].id.as_str(), questions[0].options.len(), questions[0].allow_other), ("color", 2, true));
        assert!(questions[1].options.is_empty() && questions[1].allow_other);
        assert_eq!(c.state(), ChatState::WaitingPermission);
        let mut o = Out::default();
        c.respond_question("12", &[vec!["Blue".into()], vec!["Ada".into()]], &mut o).unwrap();
        let w: Value = serde_json::from_str(&o.writes[0]).unwrap();
        assert_eq!(w, json!({"jsonrpc": "2.0", "id": 12, "result": {"answers": {"color": {"answers": ["Blue"]}, "name": {"answers": ["Ada"]}}}}));
        assert_eq!(c.state(), ChatState::Idle);
        // Declined: an empty answer set.
        c.on_line(r#"{"id":13,"method":"item/tool/requestUserInput","params":{"questions":[{"id":"a","header":"","question":"?","isOther":true,"isSecret":false,"options":null}]}}"#, &mut o);
        c.respond_permission("13", false, false, &mut o).unwrap();
        let w: Value = serde_json::from_str(o.writes.last().unwrap()).unwrap();
        assert_eq!(w["result"], json!({"answers": {}}));
    }

    /// A patch approval carries its diffs and every file it writes (absolute), from the fileChange item before it.
    #[test]
    fn patch_approvals_carry_their_changes() {
        let mut c = Codex::new(&opts());
        c.thread_id = Some("t1".into());
        let mut o = Out::default();
        c.on_line(r#"{"method":"item/started","params":{"threadId":"t1","turnId":"x","item":{"type":"fileChange","id":"fc1","status":"inProgress","changes":[{"path":"/work/a.txt","kind":{"type":"update","move_path":"/elsewhere/b.txt"},"diff":"@@ -1 +1 @@\n-owls\n+larks\n"},{"path":"/work/new.txt","kind":{"type":"add"},"diff":"hi\n"}]}}}"#, &mut o);
        let ChatEventKind::ToolStart { input, .. } = &o.events[0] else { panic!("{:?}", o.events) };
        assert_eq!(input["changes"][0], json!({"path": "/work/a.txt", "kind": "update", "move_path": "/elsewhere/b.txt", "diff": "@@ -1 +1 @@\n-owls\n+larks\n"}));
        let mut o = Out::default();
        c.on_line(r#"{"id":5,"method":"item/fileChange/requestApproval","params":{"threadId":"t1","turnId":"x","itemId":"fc1","startedAtMs":1,"reason":"needs write access","grantRoot":null}}"#, &mut o);
        let ChatEventKind::PermissionRequest { tool, summary, input, remember, .. } = &o.events[0] else { panic!("{:?}", o.events) };
        assert_eq!(tool, "apply_patch");
        assert_eq!(summary, "apply_patch · /work/a.txt, /work/new.txt");
        assert_eq!(input["files"], json!(["/work/a.txt", "/elsewhere/b.txt", "/work/new.txt"]));
        assert_eq!(input["changes"][1]["kind"], "add");
        assert_eq!(input["reason"], "needs write access");
        assert_eq!(remember.len(), 1);
        // The legacy request names its files itself.
        let mut o = Out::default();
        c.on_line(r#"{"id":6,"method":"applyPatchApproval","params":{"conversationId":"t1","callId":"c","fileChanges":{"/work/c.txt":{"type":"delete","content":"bye\n"}},"reason":null,"grantRoot":null}}"#, &mut o);
        let ChatEventKind::PermissionRequest { input, .. } = &o.events[0] else { panic!("{:?}", o.events) };
        assert_eq!(input["changes"], json!([{"path": "/work/c.txt", "kind": "delete", "diff": "bye\n"}]));
        // A managed-network prompt names the host.
        let mut o = Out::default();
        c.on_line(r#"{"id":7,"method":"item/commandExecution/requestApproval","params":{"threadId":"t1","turnId":"x","itemId":"e","startedAtMs":1,"environmentId":null,"command":"/bin/zsh -lc 'curl https://example.com'","networkApprovalContext":{"host":"example.com","protocol":"https"}}}"#, &mut o);
        let ChatEventKind::PermissionRequest { input, .. } = &o.events[0] else { panic!("{:?}", o.events) };
        assert_eq!((input["command"].as_str(), input["network_host"].as_str()), (Some("curl https://example.com"), Some("example.com")));
    }

    #[test]
    fn on_failure_asks_on_request() {
        let mut c = Codex::new(&ChatOptions { permission_mode: Some("on-failure".into()), ..opts() });
        let mut o = Out::default();
        c.start_thread(&mut o);
        let w: Value = serde_json::from_str(&o.writes[0]).unwrap();
        assert_eq!(w["params"]["approvalPolicy"], "on-request");
        c.set_permission_mode("on-failure", &mut o).unwrap();
        assert_eq!(c.next_approval.as_deref(), Some("on-request"));
    }

    #[test]
    fn subagent_activity_is_not_a_step() {
        let mut c = Codex::new(&opts());
        c.thread_id = Some("t1".into());
        let mut o = Out::default();
        c.on_line(r#"{"method":"item/completed","params":{"threadId":"t1","turnId":"x","item":{"type":"subAgentActivity","id":"s1","kind":"started","agentThreadId":"kid","agentPath":"/root/kid"}}}"#, &mut o);
        assert!(o.events.is_empty(), "{:?}", o.events);
    }

    #[test]
    fn unsupported_server_requests_are_declined() {
        let mut c = Codex::new(&opts());
        let mut o = Out::default();
        c.on_line(r#"{"id":9,"method":"mcpServer/elicitation/request","params":{}}"#, &mut o);
        let w: Value = serde_json::from_str(&o.writes[0]).unwrap();
        assert_eq!((w["id"].as_u64(), w["error"]["code"].as_i64()), (Some(9), Some(-32601)));
        assert!(matches!(o.events[0], ChatEventKind::Notice { needs_terminal: true, .. }));
    }

    fn steers(evs: &[ChatEventKind]) -> Vec<(SteerState, Option<String>)> {
        evs.iter().filter_map(|e| if let ChatEventKind::Steer { state, tool_id, .. } = e { (*state != SteerState::Queued).then(|| (*state, tool_id.clone())) } else { None }).collect()
    }

    /// Real run (codex-cli 0.145, gpt-5.6-luna): two `turn/steer`s while the
    /// first command ran, taken in at the next model request (their
    /// `userMessage` items carry our ids); then a `now` note: `turn/interrupt`,
    /// and the note starts the next turn.
    #[test]
    fn fixture_steer() {
        let mut c = Codex::new(&ChatOptions { permission_mode: Some("never".into()), ..opts() });
        let (evs, writes) = replay_full(&mut c, include_str!("fixtures/codex_steer.jsonl"));
        let shells: Vec<String> = evs.iter().filter_map(|e| if let ChatEventKind::ToolStart { id, parent_tool_id: None, .. } = e { Some(id.clone()) } else { None }).collect();
        let s = steers(&evs);
        assert_eq!(s, [(SteerState::PickedUp, Some(shells[0].clone())), (SteerState::PickedUp, Some(shells[0].clone())), (SteerState::Interrupted, Some(shells[3].clone()))]);
        let w: Vec<Value> = writes.iter().map(|w| serde_json::from_str(w).unwrap()).collect();
        let steer: Vec<&Value> = w.iter().filter(|w| w["method"] == "turn/steer").collect();
        assert_eq!(steer.len(), 2);
        assert!(steer.iter().all(|w| w["params"]["clientUserMessageId"].is_string() && w["params"]["expectedTurnId"].is_string()));
        let starts: Vec<&Value> = w.iter().filter(|w| w["method"] == "turn/start").collect();
        assert!(starts.last().unwrap()["params"]["clientUserMessageId"].is_string(), "the note's own turn");
        assert_eq!(w.iter().filter(|w| w["method"] == "turn/interrupt").count(), 1);
        assert!(c.notes.list.is_empty());
        assert_eq!(c.state(), ChatState::Idle);
    }

    #[test]
    fn notes_wait_for_answers_and_end_unused() {
        let mut c = Codex::new(&opts());
        c.thread_id = Some("t1".into());
        let mut o = Out::default();
        c.on_line(r#"{"method":"turn/started","params":{"threadId":"t1","turn":{"id":"turn1"}}}"#, &mut o);
        c.on_line(r#"{"jsonrpc":"2.0","id":0,"method":"item/commandExecution/requestApproval","params":{"threadId":"t1","itemId":"e1","command":"touch a","availableDecisions":["accept","decline"]}}"#, &mut o);
        let mut o = Out::default();
        c.steer("n1", "after the answer", true, &mut o).unwrap();
        assert!(o.writes.is_empty());
        // Held by coool: still withdrawable.
        c.steer("n2", "never mind", false, &mut o).unwrap();
        c.cancel_steer("n2", &mut o).unwrap();
        assert_eq!(steers(&o.events), [(SteerState::Cancelled, None)]);
        let mut o = Out::default();
        c.respond_permission("0", true, false, &mut o).unwrap();
        let w: Value = serde_json::from_str(o.writes.last().unwrap()).unwrap();
        assert_eq!((w["method"].as_str(), w["params"]["clientUserMessageId"].as_str()), (Some("turn/steer"), Some("n1")), "a steer, not an interrupt");
        assert!(c.cancel_steer("n1", &mut o).is_err(), "Codex has it");
        // Rejected (the turn just ended): unused, with a notice.
        let id = w["id"].as_u64().unwrap();
        let mut o = Out::default();
        c.on_line(&json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32600, "message": "no active turn"}}).to_string(), &mut o);
        assert_eq!(steers(&o.events), [(SteerState::Unused, None)]);
        assert!(o.events.iter().any(|e| matches!(e, ChatEventKind::Notice { .. })));
    }

    /// Real run: `turn/plan/updated` (no plan item in the turn) becomes one
    /// `update_plan` step per update, statuses in snake case.
    #[test]
    fn fixture_plan_updates_are_steps() {
        let mut c = Codex::new(&ChatOptions { permission_mode: Some("never".into()), ..opts() });
        let evs = replay(&mut c, include_str!("fixtures/codex_plan.jsonl"));
        let plans: Vec<(String, Value)> = evs.iter().filter_map(|e| if let ChatEventKind::ToolStart { id, name, input, .. } = e { (name == "update_plan").then(|| (id.clone(), input.clone())) } else { None }).collect();
        assert_eq!(plans.len(), 4);
        let st = |v: &Value| v["plan"].as_array().unwrap().iter().map(|s| s["status"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(st(&plans[0].1), ["in_progress", "pending", "pending"]);
        assert_eq!(st(&plans[3].1), ["completed", "completed", "completed"]);
        assert!(plans[0].1["plan"][0]["step"].as_str().is_some_and(|s| !s.is_empty()));
        assert!(plans[0].1.get("explanation").is_none(), "null explanation left out");
        for (id, _) in &plans {
            assert!(evs.iter().any(|e| matches!(e, ChatEventKind::ToolEnd { id: i, ok: true, .. } if i == id)));
        }
        let ids: HashSet<&String> = plans.iter().map(|p| &p.0).collect();
        assert_eq!(ids.len(), 4, "one pair per update");
    }

    #[test]
    fn shell_wrapper_is_unwrapped() {
        assert_eq!(unwrap_shell("/bin/zsh -lc 'touch b.txt'"), "touch b.txt");
        assert_eq!(unwrap_shell("ls -la"), "ls -la");
    }
}
