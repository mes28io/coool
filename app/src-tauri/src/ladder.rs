//! `coool-ladder`: the MCP server coool attaches to each chat it starts with Ladder on (APP_SPEC "Ladder"), so the
//! lead plans with real numbers and coool runs helpers the person can see:
//!
//! - `budget`: its own model, each account's plan, every limit window with its use and reset time, the models on
//!   each provider with a relative cost, whether image generation is available, the machine's load, the helpers
//!   running and the parallel cap now ([`coool_core::ladder::budget::report`]).
//! - `can`: the preflight before an image or cross-provider request: yes or no, the reason, what to do instead.
//! - `spawn` / `wait` / `helpers` / `stop`: a helper as a full coool chat (its own model and provider, its own git
//!   worktree when asked, its own Ladder one level deeper), shown in the sidebar and Jobs panel as the caller's child,
//!   its last message returned to the caller by `wait`. Refused past the depth or concurrency limit, above the caller's
//!   model, when a provider can't take it (not installed, not logged in, usage under the reserve), and never with
//!   wider permissions than the caller's ([`coool_core::ladder::budget::spawn_check`]).
//!
//! Transport and access: the same as `coool-device` (device/mcp.rs): coool's own executable with
//! `--coool-ladder-mcp` relays stdio to a Unix socket of this process (mode 0600) and sends the chat's random
//! per-launch token first; an unknown token is refused, and a chat only sees and stops its own helpers.
//!
//! The CLIs' status (installed, version, logged in), Codex's model list and whether it can generate images are read
//! from the CLIs' own commands (`--version`, `codex login status`, `claude auth status`, `codex debug models`,
//! `codex features list`), none of which spends usage or reads a credential file. The image check is cached per
//! Codex version in coool's data folder, so a Codex update is re-checked once.

use crate::Core;
use coool_core::chat::{ChatEventKind, ChatOptions, ChatState, McpServer, ModelOption};
use coool_core::ladder::budget::{self, Caller, ImageCap, Inputs, Lane, Load, SpawnReq};
use coool_core::ladder::{HelperOf, Ladder};
use coool_core::model::Provider;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub const SERVER_NAME: &str = coool_core::ladder::SERVER;
pub const PROXY_FLAG: &str = "--coool-ladder-mcp";
const SOCKET_ENV: &str = "COOOL_LADDER_SOCKET";
const TOKEN_ENV: &str = "COOOL_LADDER_TOKEN";
/// The CLIs' status is re-read after this long.
const STATUS_TTL_MS: u64 = 10 * 60_000;
/// `wait` returns after this long at most (a call must end within the CLI's tool timeout).
const WAIT_MAX_S: u64 = 840;
/// A helper's result is clipped to this many characters.
const RESULT_MAX: usize = 12_000;

/// What a chat was launched with (for `budget`, `spawn` and the child's own Ladder).
#[derive(Clone)]
struct Launched {
    provider: Provider,
    cwd: String,
    model: Option<String>,
    ladder: Ladder,
}

/// A helper `spawn` started.
struct Helper {
    parent: usize,
    depth: u32,
    provider: Provider,
    model: String,
    title: String,
    worktree: Option<(String, String)>,
    started: Instant,
    /// Events read so far.
    seq: u64,
    sent: bool,
    last_text: String,
    /// Its turn ended: (ok, its last message).
    done: Option<(bool, String)>,
    collected: bool,
}

/// What the UI shows of a helper (ChatRow.helper).
#[derive(Clone, Debug, Serialize)]
pub struct HelperRow {
    pub parent: usize,
    pub depth: u32,
    pub model: String,
    pub title: String,
    pub worktree: Option<String>,
    pub done: bool,
}

/// The CLIs as coool last read them.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Status {
    pub claude: budget::Cli,
    pub codex: budget::Cli,
    pub image: ImageCap,
    /// Codex's listed models (`codex debug models`, visibility "list"), for the cross-provider tiers.
    pub codex_models: Vec<ModelOption>,
    pub checked_ms: u64,
}

#[derive(Default)]
pub struct State {
    socket: OnceLock<PathBuf>,
    /// Where helper worktrees and the image check's cache go.
    dir: OnceLock<PathBuf>,
    app: OnceLock<AppHandle>,
    tokens: Mutex<HashMap<String, usize>>,
    chats: Mutex<HashMap<usize, Launched>>,
    helpers: Mutex<HashMap<usize, Helper>>,
    status: Mutex<Status>,
    refreshing: Mutex<bool>,
    /// Serialises spawns, so two concurrent calls can't both take the last slot.
    spawning: Mutex<()>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl State {
    /// The server entry for a chat being started with Ladder (and its tools) on; None otherwise or before the socket.
    pub fn server_for(&self, chat: usize, opts: &ChatOptions) -> Option<McpServer> {
        let l = opts.ladder.as_ref().filter(|l| l.tools)?;
        let socket = self.socket.get()?;
        let exe = std::env::current_exe().ok()?;
        let token = crate::device::mcp::random_token();
        self.tokens.lock().unwrap().insert(token.clone(), chat);
        self.chats.lock().unwrap().insert(chat, Launched { provider: opts.provider, cwd: opts.cwd.clone(), model: opts.model.clone(), ladder: l.clone() });
        Some(McpServer {
            name: SERVER_NAME.into(),
            command: exe.to_string_lossy().into_owned(),
            args: vec![PROXY_FLAG.into()],
            env: vec![(SOCKET_ENV.into(), socket.to_string_lossy().into_owned()), (TOKEN_ENV.into(), token)],
            // coool's own checks decide; the CLI's prompt would be an elicitation Codex can't show.
            allow_all: true,
            // `wait` can block for a helper's whole turn.
            tool_timeout_sec: Some(WAIT_MAX_S + 60),
        })
    }

    /// The chat a connection's first line (`{"token": …}`) belongs to; None: refused.
    fn authorize(&self, hello: &str) -> Option<usize> {
        let token = serde_json::from_str::<Value>(hello).ok().and_then(|v| v["token"].as_str().map(String::from))?;
        self.tokens.lock().unwrap().get(&token).copied()
    }

    /// `ids` are all helpers of `chat` (a chat only waits for, lists and stops its own).
    fn owns(&self, chat: usize, ids: &[usize]) -> Result<(), String> {
        let h = self.helpers.lock().unwrap();
        match ids.iter().find(|i| h.get(i).is_none_or(|x| x.parent != chat)) {
            Some(bad) => Err(format!("helper {bad} is not one of yours")),
            None => Ok(()),
        }
    }

    /// The helper info of a chat (for its ChatRow).
    pub fn helper_row(&self, chat: usize) -> Option<HelperRow> {
        let h = self.helpers.lock().unwrap();
        let x = h.get(&chat)?;
        Some(HelperRow { parent: x.parent, depth: x.depth, model: x.model.clone(), title: x.title.clone(), worktree: x.worktree.as_ref().map(|w| w.0.clone()), done: x.done.is_some() })
    }

    /// Stops helpers whose caller is gone (the person stopped it, or it exited): no orphan keeps spending.
    pub fn reap(&self, hub: &mut coool_core::hub::Hub) {
        let orphans: Vec<usize> = {
            let h = self.helpers.lock().unwrap();
            h.iter().filter(|(id, x)| hub.chat(**id).is_some_and(|c| c.is_running()) && !hub.chat(x.parent).is_some_and(|p| p.is_running())).map(|(id, _)| *id).collect()
        };
        for id in orphans {
            if let Some(c) = hub.chat_mut(id) {
                c.stop();
            }
        }
    }

    /// The CLIs' status now (cached; refreshed in the background when old, or right away when never read).
    pub fn status(&self, wait: bool) -> Status {
        let s = self.status.lock().unwrap().clone();
        let stale = now_ms().saturating_sub(s.checked_ms) > STATUS_TTL_MS;
        if s.checked_ms == 0 && wait {
            self.refresh_status();
            return self.status.lock().unwrap().clone();
        }
        if stale {
            let mut r = self.refreshing.lock().unwrap();
            if !*r {
                *r = true;
                if let Some(app) = self.app.get().cloned() {
                    std::thread::spawn(move || {
                        let st = app.state::<Arc<Core>>().ladder.clone();
                        st.refresh_status();
                    });
                } else {
                    *r = false;
                }
            }
        }
        s
    }

    fn refresh_status(&self) {
        let claude = cli_status(Provider::Claude);
        let codex = cli_status(Provider::Codex);
        let image = self.image_cap(&codex);
        let codex_models = if codex.installed { codex_models() } else { Vec::new() };
        *self.status.lock().unwrap() = Status { claude, codex, image, codex_models, checked_ms: now_ms() };
        *self.refreshing.lock().unwrap() = false;
    }

    /// Whether this Codex can generate images: the cache for its version, else its own feature list (no usage).
    fn image_cap(&self, codex: &budget::Cli) -> ImageCap {
        let Some(v) = codex.version.clone().filter(|_| codex.installed) else { return ImageCap::default() };
        let file = self.dir.get().map(|d| d.join("ladder-image-check.json"));
        if let Some(f) = &file
            && let Ok(c) = std::fs::read(f).map(|b| serde_json::from_slice::<ImageCap>(&b))
            && let Ok(c) = c
            && c.version.as_deref() == Some(v.as_str())
        {
            return c;
        }
        let out = run(Command::new("codex").args(["features", "list"]), Duration::from_secs(20)).unwrap_or_default();
        let cap = ImageCap { version: Some(v), available: budget::parse_image_feature(&out) };
        if let (Some(f), Some(_)) = (&file, cap.available) {
            let _ = std::fs::create_dir_all(f.parent().unwrap_or(Path::new("/")));
            let _ = std::fs::write(f, serde_json::to_vec(&cap).unwrap_or_default());
        }
        cap
    }

    fn inputs(&self, core: &Core, chat: usize) -> Result<(Inputs, Launched, String), String> {
        let l = self.chats.lock().unwrap().get(&chat).cloned().ok_or("coool-ladder: this chat has no Ladder")?;
        let (model, mode) = {
            let hub = core.hub.lock().unwrap();
            let i = hub.chat(chat).map(|c| c.info());
            (i.as_ref().map(|i| i.model.clone()).filter(|m| !m.is_empty()).or(l.model.clone()).unwrap_or_default(), i.map(|i| i.permission_mode).unwrap_or_default())
        };
        let st = self.status(true);
        let running = {
            let hub = core.hub.lock().unwrap();
            self.helpers.lock().unwrap().iter().filter(|(id, h)| h.done.is_none() && hub.chat(**id).is_some_and(|c| c.is_running())).count() as u32
        };
        let i = Inputs {
            now_ms: now_ms(),
            provider: l.provider,
            model,
            ladder: l.ladder.clone(),
            claude: st.claude,
            codex: st.codex,
            usage_claude: core.usage.get(Provider::Claude),
            usage_codex: core.usage.get(Provider::Codex),
            image: st.image,
            load: load(),
            running,
            reserve: l.ladder.reserve,
        };
        Ok((i, l, mode))
    }
}

/// `claude --version` / `codex --version`, and whether it is logged in, from its own status command.
fn cli_status(p: Provider) -> budget::Cli {
    let bin = p.binary();
    let Some(v) = run(Command::new(bin).arg("--version"), Duration::from_secs(10)) else { return budget::Cli::default() };
    let version = v.split_whitespace().find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit())).map(str::to_string);
    let logged_in = match p {
        // Prints "Logged in using ..." (exit 0) or "Not logged in" (exit 1).
        Provider::Codex => Some(run(Command::new(bin).args(["login", "status"]), Duration::from_secs(10)).is_some_and(|o| o.contains("Logged in"))),
        // JSON with `loggedIn`; only that field is read.
        Provider::Claude => run(Command::new(bin).args(["auth", "status"]), Duration::from_secs(10)).and_then(|o| serde_json::from_str::<Value>(&o).ok()).and_then(|v| v["loggedIn"].as_bool()),
    };
    budget::Cli { installed: true, version, logged_in }
}

/// Codex's listed models (no turn, no usage).
fn codex_models() -> Vec<ModelOption> {
    let Some(out) = run(Command::new("codex").args(["debug", "models"]), Duration::from_secs(20)) else { return Vec::new() };
    let v: Value = serde_json::from_str(&out).unwrap_or_default();
    v["models"]
        .as_array()
        .map(|a| a.iter().filter(|m| m["visibility"] == "list").filter_map(|m| Some(ModelOption { id: m["slug"].as_str()?.to_string(), label: m["display_name"].as_str().unwrap_or("").to_string() })).collect())
        .unwrap_or_default()
}

/// Runs a command with a time limit; its stdout when it exits 0.
fn run(cmd: &mut Command, limit: Duration) -> Option<String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut out, &mut s);
        s
    });
    let t0 = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                let s = reader.join().unwrap_or_default();
                return st.success().then_some(s);
            }
            Ok(None) if t0.elapsed() < limit => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// The machine's load now.
fn load() -> Load {
    let mut avg = [0f64; 3];
    // SAFETY: getloadavg writes at most 3 doubles into the array.
    let n = unsafe { libc::getloadavg(avg.as_mut_ptr(), 3) };
    let h = crate::motion::read();
    Load {
        load1: if n > 0 { avg[0] } else { 0.0 },
        cores: std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(0),
        thermal: serde_json::to_value(h.thermal).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(),
        low_power: h.low_power,
        on_battery: h.on_battery,
        battery_pct: h.battery_pct,
    }
}

/// Binds the socket and serves connections on their own threads.
pub fn start(core: &Arc<Core>, app: &AppHandle, dir: &Path) -> Result<(), String> {
    let st = &core.ladder;
    let _ = st.app.set(app.clone());
    let _ = st.dir.set(dir.to_path_buf());
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut path = dir.join(format!("ladder-{}.sock", std::process::id()));
    if path.as_os_str().len() > 100 {
        path = std::env::temp_dir().join(format!("coool-ladder-{}.sock", std::process::id()));
    }
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).map_err(|e| format!("bind {}: {e}", path.display()))?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    let _ = st.socket.set(path);
    let core = core.clone();
    std::thread::Builder::new()
        .name("coool-ladder mcp".into())
        .spawn(move || {
            for conn in listener.incoming().flatten() {
                let c = core.clone();
                let _ = std::thread::Builder::new().name("coool-ladder conn".into()).spawn(move || serve(c, conn));
            }
        })
        .map_err(|e| e.to_string())?;
    // Read the CLIs' status once, off the launch path.
    let c2 = app.clone();
    std::thread::spawn(move || c2.state::<Arc<Core>>().ladder.refresh_status());
    Ok(())
}

/// Removes this process's socket (on quit).
pub fn cleanup(core: &Core) {
    if let Some(p) = core.ladder.socket.get() {
        let _ = std::fs::remove_file(p);
    }
}

/// Runs in the chat's CLI as its `coool-ladder` MCP server process.
pub fn proxy() -> i32 {
    crate::device::mcp::proxy_with(SOCKET_ENV, TOKEN_ENV, SERVER_NAME)
}

fn serve(core: Arc<Core>, conn: UnixStream) {
    let mut out = match conn.try_clone() {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut lines = BufReader::new(conn).lines();
    let Some(Ok(hello)) = lines.next() else { return };
    let Some(chat) = core.ladder.authorize(&hello) else {
        let _ = writeln!(out, "{}", json!({"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"coool-ladder: unknown token"}}));
        return;
    };
    for line in lines {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(Value::Array(batch)) => {
                let r: Vec<Value> = batch.iter().filter_map(|m| handle(&core, chat, m)).collect();
                (!r.is_empty()).then_some(Value::Array(r))
            }
            Ok(m) => handle(&core, chat, &m),
            Err(e) => Some(json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":format!("parse error: {e}")}})),
        };
        if let Some(r) = reply
            && writeln!(out, "{r}").and_then(|_| out.flush()).is_err()
        {
            break;
        }
    }
}

const INSTRUCTIONS: &str = "Ladder's planning tools (coool). Call `budget` before planning a job of several parts: your model, each account's plan and usage with reset times, the models on each provider with a relative cost, image generation, machine load and the parallel cap. Call `can` before any image or cross-provider request and don't send it when it says no. `spawn` starts a helper as a full coool chat the person can see (its own worktree on request); `wait` returns its last message.";

fn tools() -> Value {
    json!([
        { "name": "budget", "description": "Plans, usage per limit window with reset times, models per provider with relative cost, image generation availability, machine load, helpers running and the parallel cap now. Read it before planning a multi-part job.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "can", "description": "Preflight before a request: `image` (image generation through Codex), `codex` or `claude` (a cross-provider lane or helper). Returns ok, the reason, and what to do instead. Never send the request when ok is false.", "inputSchema": { "type": "object", "properties": { "what": { "type": "string", "enum": ["image", "codex", "claude"] } }, "required": ["what"] } },
        { "name": "spawn", "description": "Start a helper as a full coool chat (shown to the person as your child, stoppable). Give an explicit model at or below yours, and the whole brief. `worktree: true` gives it its own git worktree and branch (for edits that must not collide). Refused past the depth or concurrency limit, when the provider can't take it, or when usage is under the reserve. Returns the helper id; collect its result with `wait`.", "inputSchema": { "type": "object", "properties": { "model": { "type": "string" }, "brief": { "type": "string" }, "provider": { "type": "string", "enum": ["claude", "codex"] }, "worktree": { "type": "boolean" }, "title": { "type": "string" } }, "required": ["model", "brief"] } },
        { "name": "wait", "description": "Wait for your helpers (all running ones, or the ids given) to finish their turn, up to `timeout_s` (default 600). Returns each one's last message, whether it ended ok, and its worktree and branch.", "inputSchema": { "type": "object", "properties": { "helpers": { "type": "array", "items": { "type": "integer" } }, "timeout_s": { "type": "integer" } } } },
        { "name": "helpers", "description": "Your helpers: id, model, state, worktree.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "stop", "description": "Stop one of your helpers.", "inputSchema": { "type": "object", "properties": { "helper": { "type": "integer" } }, "required": ["helper"] } }
    ])
}

fn handle(core: &Arc<Core>, chat: usize, m: &Value) -> Option<Value> {
    let method = m["method"].as_str().unwrap_or("");
    let id = m.get("id").cloned()?;
    let ok = |result: Value| Some(json!({"jsonrpc":"2.0","id":id,"result":result}));
    match method {
        "initialize" => ok(json!({
            "protocolVersion": m["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
            "instructions": INSTRUCTIONS,
        })),
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({ "tools": tools() })),
        "tools/call" => {
            let name = m["params"]["name"].as_str().unwrap_or("");
            let r = match call(core, chat, name, &m["params"]["arguments"]) {
                Ok(v) => json!({ "content": [{ "type": "text", "text": if v.is_string() { v.as_str().unwrap_or("").to_string() } else { serde_json::to_string_pretty(&v).unwrap_or_default() } }] }),
                Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
            };
            ok(r)
        }
        _ => Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":format!("method not found: {method}")}})),
    }
}

/// One tool call for `chat` (also what the self-test calls directly).
pub fn call(core: &Arc<Core>, chat: usize, name: &str, a: &Value) -> Result<Value, String> {
    let st = &core.ladder;
    match name {
        "budget" => {
            let (i, _, _) = st.inputs(core, chat)?;
            Ok(budget::report(&i))
        }
        "can" => {
            let what = a["what"].as_str().unwrap_or("");
            let lane = Lane::parse(what).ok_or_else(|| format!("can: unknown `what` {what:?} (image, codex or claude)"))?;
            let (i, _, _) = st.inputs(core, chat)?;
            Ok(serde_json::to_value(budget::preflight(&i, lane)).unwrap_or_default())
        }
        "spawn" => spawn(core, chat, a),
        "wait" => wait(core, chat, a),
        "helpers" => {
            poll(core);
            // Lock order everywhere: the hub, then the helpers.
            let hub = core.hub.lock().unwrap();
            let h = st.helpers.lock().unwrap();
            let list: Vec<Value> = h
                .iter()
                .filter(|(_, x)| x.parent == chat)
                .map(|(id, x)| json!({ "helper": id, "provider": x.provider.label(), "model": x.model, "title": x.title, "state": if x.done.is_some() { "done" } else if hub.chat(*id).is_some_and(|c| c.is_running()) { "running" } else { "ended" }, "worktree": x.worktree.as_ref().map(|w| &w.0), "branch": x.worktree.as_ref().map(|w| &w.1) }))
                .collect();
            Ok(Value::Array(list))
        }
        "stop" => {
            let hid = a["helper"].as_u64().ok_or("stop: `helper` is required")? as usize;
            st.owns(chat, &[hid]).map_err(|e| format!("stop: {e}"))?;
            core.with_chat(hid, |c| {
                c.stop();
                Ok(())
            })?;
            Ok(json!(format!("helper {hid} stopped")))
        }
        _ => Err(format!("unknown tool {name}")),
    }
}

fn spawn(core: &Arc<Core>, chat: usize, a: &Value) -> Result<Value, String> {
    let st = &core.ladder;
    let brief = a["brief"].as_str().unwrap_or("").trim().to_string();
    if brief.is_empty() {
        return Err("spawn: `brief` is required (the whole of what the helper knows)".into());
    }
    let provider = match a["provider"].as_str() {
        None => None,
        Some("claude") => Some(Provider::Claude),
        Some("codex") => Some(Provider::Codex),
        Some(p) => return Err(format!("spawn: unknown provider {p:?}")),
    };
    let req = SpawnReq { provider, model: a["model"].as_str().unwrap_or("").to_string() };
    let _one = st.spawning.lock().unwrap();
    let (i, launched, mode) = st.inputs(core, chat)?;
    let plan = budget::spawn_check(&i, &req, &Caller { mode, allow_bypass: launched.ladder.bypass_helpers })?;
    let title = a["title"].as_str().map(str::to_string).unwrap_or_else(|| brief.lines().next().unwrap_or("").chars().take(60).collect());
    let n = st.helpers.lock().unwrap().len() + 1;
    let worktree = if a["worktree"].as_bool() == Some(true) { Some(make_worktree(st, &launched.cwd, chat, n)?) } else { None };
    let cwd = worktree.as_ref().map(|w| w.0.clone()).unwrap_or_else(|| launched.cwd.clone());
    let ladder = child_ladder(&launched, &plan, chat);
    let opts = ChatOptions { provider: plan.provider, cwd, resume: None, model: Some(plan.model.clone()), permission_mode: Some(plan.permission_mode.clone()), ladder: Some(ladder) };
    let app = st.app.get().ok_or("coool-ladder: not ready")?;
    let id = crate::start_chat_with(app, core, opts)?;
    st.helpers.lock().unwrap().insert(id, Helper { parent: chat, depth: plan.depth, provider: plan.provider, model: plan.model.clone(), title: title.clone(), worktree: worktree.clone(), started: Instant::now(), seq: 0, sent: false, last_text: String::new(), done: None, collected: false });
    core.with_chat(id, |c| c.send_with(&brief, &[]))?;
    if let Some(h) = st.helpers.lock().unwrap().get_mut(&id) {
        h.sent = true;
    }
    core.kick();
    Ok(json!({
        "helper": id,
        "provider": plan.provider.label(),
        "model": plan.model,
        "permission_mode": plan.permission_mode,
        "depth": plan.depth,
        "worktree": worktree.as_ref().map(|w| &w.0),
        "branch": worktree.as_ref().map(|w| &w.1),
        "next": "collect its result with `wait`",
    }))
}

/// The helper's own Ladder: the caller's, one level deeper, with only the tiers at or below the helper's model.
fn child_ladder(l: &Launched, plan: &budget::SpawnPlan, parent: usize) -> Ladder {
    let mut c = l.ladder.clone();
    let (own, other) = if plan.provider == l.provider { (c.tiers.clone(), c.cross.clone()) } else { (c.cross.clone(), c.tiers.clone()) };
    let other_p = match plan.provider {
        Provider::Claude => Provider::Codex,
        Provider::Codex => Provider::Claude,
    };
    c.tiers = own.into_iter().filter(|t| coool_core::ladder::rank(plan.provider, &t.model) <= coool_core::ladder::rank(plan.provider, &plan.model)).collect();
    c.cross = other.into_iter().filter(|t| budget::within(plan.provider, &plan.model, other_p, &t.model)).collect();
    c.lead = plan.model.clone();
    c.helper = Some(HelperOf { parent, depth: plan.depth });
    c.swarm = false;
    c.tools = true;
    c
}

/// `git worktree add` of the caller's repository into coool's helper folder, on a new branch.
fn make_worktree(st: &State, cwd: &str, chat: usize, n: usize) -> Result<(String, String), String> {
    let top = run(Command::new("git").args(["-C", cwd, "rev-parse", "--show-toplevel"]), Duration::from_secs(10)).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).ok_or("spawn: `worktree` needs the project to be a git repository")?;
    let base = st.dir.get().cloned().ok_or("coool-ladder: no data folder")?.join("helpers");
    let name = Path::new(&top).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "project".into());
    let stamp = now_ms() % 1_000_000;
    let path = base.join(format!("{name}-{chat}-{n}-{stamp}"));
    let branch = format!("coool-helper/{chat}-{n}-{stamp}");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let out = Command::new("git").args(["-C", &top, "worktree", "add", "-q", "-b", &branch]).arg(&path).arg("HEAD").output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("spawn: git worktree add failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok((path.to_string_lossy().into_owned(), branch))
}

/// Reads the helpers' new events: their last top-level message and whether their turn ended.
fn poll(core: &Core) {
    let st = &core.ladder;
    let ids: Vec<(usize, u64)> = st.helpers.lock().unwrap().iter().filter(|(_, h)| h.done.is_none() && h.sent).map(|(id, h)| (*id, h.seq)).collect();
    for (id, seq) in ids {
        let (evs, next, running) = {
            let hub = core.hub.lock().unwrap();
            match hub.chat(id) {
                Some(c) => {
                    let h = c.handle();
                    let (e, n) = h.events_since(seq);
                    (e, n, h.is_running())
                }
                None => (Vec::new(), seq, false),
            }
        };
        let mut hs = st.helpers.lock().unwrap();
        let Some(h) = hs.get_mut(&id) else { continue };
        h.seq = next;
        for e in evs {
            match e.kind {
                ChatEventKind::AssistantMessage { text, parent_tool_id: None, .. } if !text.trim().is_empty() => h.last_text = text,
                ChatEventKind::TurnEnd { ok, .. } => h.done = Some((ok, h.last_text.clone())),
                ChatEventKind::Exited { .. } if h.done.is_none() => h.done = Some((false, format!("(the helper exited) {}", h.last_text))),
                _ => {}
            }
        }
        if h.done.is_none() && !running {
            h.done = Some((false, format!("(the helper is no longer running) {}", h.last_text)));
        }
    }
}

fn wait(core: &Arc<Core>, chat: usize, a: &Value) -> Result<Value, String> {
    let st = &core.ladder;
    let mine: Vec<usize> = match a["helpers"].as_array() {
        Some(ids) => {
            let ids: Vec<usize> = ids.iter().filter_map(|v| v.as_u64().map(|x| x as usize)).collect();
            st.owns(chat, &ids).map_err(|e| format!("wait: {e}"))?;
            ids
        }
        None => st.helpers.lock().unwrap().iter().filter(|(_, h)| h.parent == chat && !h.collected).map(|(id, _)| *id).collect(),
    };
    if mine.is_empty() {
        return Ok(json!("no helpers to wait for"));
    }
    let limit = Duration::from_secs(a["timeout_s"].as_u64().unwrap_or(600).clamp(1, WAIT_MAX_S));
    let t0 = Instant::now();
    loop {
        poll(core);
        let all = {
            let h = st.helpers.lock().unwrap();
            mine.iter().all(|i| h.get(i).is_some_and(|x| x.done.is_some()))
        };
        if all || t0.elapsed() >= limit {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let mut out = Vec::new();
    let mut finished = Vec::new();
    {
        let mut h = st.helpers.lock().unwrap();
        for i in &mine {
            let Some(x) = h.get_mut(i) else { continue };
            let (state, ok, text) = match &x.done {
                Some((ok, t)) => ("done", Some(*ok), t.clone()),
                None => ("running", None, String::new()),
            };
            if x.done.is_some() {
                x.collected = true;
                finished.push(*i);
            }
            let text: String = if text.chars().count() > RESULT_MAX { format!("{}… (clipped)", text.chars().take(RESULT_MAX).collect::<String>()) } else { text };
            out.push(json!({ "helper": i, "state": state, "ok": ok, "model": x.model, "seconds": x.started.elapsed().as_secs(), "result": text, "worktree": x.worktree.as_ref().map(|w| &w.0), "branch": x.worktree.as_ref().map(|w| &w.1) }));
        }
    }
    // A finished helper's process ends once its result is collected; its session stays in the sidebar.
    for i in finished {
        let _ = core.with_chat(i, |c| {
            if c.info().state == ChatState::Idle {
                c.stop();
            }
            Ok(())
        });
    }
    Ok(Value::Array(out))
}

/// The Ladder status for Settings and the composer chip: the CLIs, image generation and Codex's models.
#[tauri::command(async)]
pub fn ladder_status(core: tauri::State<'_, Arc<Core>>) -> Status {
    core.ladder.status(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use coool_core::ladder::{Role, Tier};

    fn helper(parent: usize) -> Helper {
        Helper { parent, depth: 1, provider: Provider::Claude, model: "haiku".into(), title: "t".into(), worktree: None, started: Instant::now(), seq: 0, sent: true, last_text: String::new(), done: None, collected: false }
    }

    fn opts(tools: bool) -> ChatOptions {
        ChatOptions { provider: Provider::Claude, cwd: "/p".into(), resume: None, model: Some("sonnet".into()), permission_mode: None, ladder: Some(Ladder { tools, ..Default::default() }) }
    }

    #[test]
    fn server_only_with_tools_and_token_only_in_env() {
        let st = State::default();
        assert!(st.server_for(1, &opts(true)).is_none(), "no socket yet");
        let _ = st.socket.set(PathBuf::from("/tmp/x.sock"));
        assert!(st.server_for(1, &opts(false)).is_none(), "tools off");
        assert!(st.server_for(1, &ChatOptions { ladder: None, ..opts(true) }).is_none(), "Ladder off");
        let s = st.server_for(1, &opts(true)).unwrap();
        assert_eq!(s.name, "coool-ladder");
        assert_eq!(s.args, vec![PROXY_FLAG.to_string()]);
        let token = s.env.iter().find(|(k, _)| k == TOKEN_ENV).unwrap().1.clone();
        assert_eq!(token.len(), 32);
        assert!(!s.args.iter().any(|a| a.contains(&token)));
        // Only that token opens that chat.
        assert_eq!(st.authorize(&json!({ "token": token }).to_string()), Some(1));
        assert_eq!(st.authorize(&json!({ "token": "guess" }).to_string()), None);
        assert_eq!(st.authorize("not json"), None);
        assert_eq!(st.authorize("{}"), None);
        // Each launch gets its own.
        let t2 = st.server_for(2, &opts(true)).unwrap().env.iter().find(|(k, _)| k == TOKEN_ENV).unwrap().1.clone();
        assert_ne!(t2, token);
        assert_eq!(st.authorize(&json!({ "token": t2 }).to_string()), Some(2));
    }

    #[test]
    fn a_chat_only_touches_its_own_helpers() {
        let st = State::default();
        st.helpers.lock().unwrap().insert(10, helper(1));
        st.helpers.lock().unwrap().insert(11, helper(2));
        assert!(st.owns(1, &[10]).is_ok());
        assert!(st.owns(1, &[10, 11]).unwrap_err().contains("11 is not one of yours"));
        assert!(st.owns(2, &[99]).is_err());
        let row = st.helper_row(10).unwrap();
        assert_eq!((row.parent, row.depth, row.done), (1, 1, false));
        assert!(st.helper_row(1).is_none());
    }

    #[test]
    fn child_ladder_is_one_deeper_and_never_above_the_helper() {
        let l = Launched {
            provider: Provider::Claude,
            cwd: "/p".into(),
            model: Some("opus".into()),
            ladder: Ladder {
                tiers: vec![Tier { role: Role::Same, model: "opus".into(), label: String::new() }, Tier { role: Role::Mid, model: "sonnet".into(), label: String::new() }, Tier { role: Role::Small, model: "haiku".into(), label: String::new() }],
                cross: vec![Tier { role: Role::Exec, model: "gpt-6.2-sol".into(), label: String::new() }, Tier { role: Role::Bulk, model: "gpt-6-luna".into(), label: String::new() }],
                tools: true,
                ..Default::default()
            },
        };
        let plan = budget::SpawnPlan { provider: Provider::Claude, model: "sonnet".into(), permission_mode: "default".into(), depth: 1 };
        let c = child_ladder(&l, &plan, 7);
        assert_eq!(c.tiers.iter().map(|t| t.model.as_str()).collect::<Vec<_>>(), ["sonnet", "haiku"]);
        assert_eq!(c.cross.iter().map(|t| t.model.as_str()).collect::<Vec<_>>(), ["gpt-6-luna"], "Sonnet doesn't get Codex's top");
        assert_eq!(c.helper, Some(HelperOf { parent: 7, depth: 1 }));
        assert!(!c.swarm);
        // A Codex helper of a Claude lead: Codex tiers become its own, Claude's its cross lanes.
        let plan = budget::SpawnPlan { provider: Provider::Codex, model: "gpt-6-luna".into(), permission_mode: "untrusted".into(), depth: 1 };
        let c = child_ladder(&l, &plan, 7);
        assert_eq!(c.tiers.iter().map(|t| t.model.as_str()).collect::<Vec<_>>(), ["gpt-6-luna"]);
        assert!(c.cross.is_empty(), "Luna is below every Claude model");
    }
}
