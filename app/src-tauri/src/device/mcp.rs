//! `coool-device`: the MCP server that lets a chat's agent drive the device in that chat's panel, fast.
//!
//! Transport: each chat coool starts gets a stdio MCP server whose command is coool's own executable with
//! `--coool-device-mcp` ([`proxy`]). That small proxy connects to a Unix socket the app listens on
//! (`<app local data>/device-<pid>.sock`, mode 0600, so only this user; nothing on the network), sends the chat's
//! token (random per chat, per launch) as its first line, then pipes MCP's newline-delimited JSON-RPC both ways. An
//! unknown token is refused. The app answers the protocol itself, so tools act on the same helper the panel shows.
//!
//! The `browser_*` tools ([`super::web`]) drive the chat's Browser panel through the same server and socket.
//!
//! Tools are shaped for few round trips: every action returns the screen after it settles (or "unchanged"), `batch`
//! runs many actions in one call, `wait_for` replaces sleep loops, and element ids from `observe` are stable.

use super::gate::{Act, Dev, Risk};
use super::observe::{self, Tree};
use super::{Activity, Devices, simctl};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const SERVER_NAME: &str = "coool-device";
pub const PROXY_FLAG: &str = "--coool-device-mcp";
const SOCKET_ENV: &str = "COOOL_DEVICE_SOCKET";
const TOKEN_ENV: &str = "COOOL_DEVICE_TOKEN";

#[derive(Default)]
pub struct Mcp {
    socket: OnceLock<PathBuf>,
    /// token -> chat id
    tokens: Mutex<HashMap<String, usize>>,
    /// Per chat: the last screen it was shown, for id lookup and "unchanged".
    last: Mutex<HashMap<usize, (Tree, String)>>,
    /// Per chat: its project folder (the pilot's muscle memory is per project).
    cwds: Mutex<HashMap<usize, String>>,
    /// Per chat: its provider (`claude`, `codex`), for the panels' cursor labels.
    providers: Mutex<HashMap<usize, &'static str>>,
}

pub(crate) fn random_token() -> String {
    let mut b = [0u8; 16];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_err() {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        b[..16].copy_from_slice(&t.to_le_bytes());
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

impl Mcp {
    /// The MCP server entry for a chat coool is starting (None until the socket is up).
    pub fn server_for(&self, chat: usize, cwd: &str, provider: coool_core::model::Provider) -> Option<coool_core::chat::McpServer> {
        let socket = self.socket.get()?;
        self.cwds.lock().unwrap().insert(chat, cwd.to_string());
        self.providers.lock().unwrap().insert(chat, provider.label());
        let exe = std::env::current_exe().ok()?;
        let token = random_token();
        self.tokens.lock().unwrap().insert(token.clone(), chat);
        Some(coool_core::chat::McpServer {
            name: SERVER_NAME.into(),
            command: exe.to_string_lossy().into_owned(),
            args: vec![PROXY_FLAG.into()],
            env: vec![(SOCKET_ENV.into(), socket.to_string_lossy().into_owned()), (TOKEN_ENV.into(), token)],
            // Callable without the CLI's own prompt (Codex's would be an elicitation coool can't answer); coool's
            // own gate (device/gate.rs) asks the person where the chat's permission mode says to.
            allow_all: true,
            // A call can wait for the person (the gate, 5 min at most) or run a whole pilot goal.
            tool_timeout_sec: Some(900),
        })
    }

    /// Registers a token for a chat without a CLI (the self-test's scripted client).
    pub fn token_for(&self, chat: usize) -> String {
        let t = random_token();
        self.tokens.lock().unwrap().insert(t.clone(), chat);
        t
    }

    pub fn socket(&self) -> Option<PathBuf> {
        self.socket.get().cloned()
    }

    /// The chat's project folder, if coool started it.
    pub fn cwd(&self, chat: usize) -> Option<String> {
        self.cwds.lock().unwrap().get(&chat).cloned()
    }

    /// The chat's provider (`claude`, `codex`), if coool started it.
    pub fn provider(&self, chat: usize) -> Option<&'static str> {
        self.providers.lock().unwrap().get(&chat).copied()
    }

    /// Records a screen the chat's agent (or its pilot) saw, so ids from it work for `tap` and friends.
    pub fn remember(&self, chat: usize, tree: Tree, device: &str) {
        let text = observe::render(&tree, device);
        self.last.lock().unwrap().insert(chat, (tree, text));
    }
}

/// Binds the socket and serves connections on their own threads.
pub fn start(devices: Arc<Devices>, dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // Sockets of coool processes that are gone.
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            let pid = n.strip_prefix("device-").and_then(|r| r.strip_suffix(".sock")).and_then(|p| p.parse::<i32>().ok());
            // SAFETY: signal 0 only checks whether the process exists.
            if let Some(pid) = pid
                && unsafe { libc::kill(pid, 0) } != 0
            {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let mut path = dir.join(format!("device-{}.sock", std::process::id()));
    // A socket path must fit sockaddr_un (104 bytes on macOS): fall back to the per-user temp folder.
    if path.as_os_str().len() > 100 {
        path = std::env::temp_dir().join(format!("coool-device-{}.sock", std::process::id()));
    }
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).map_err(|e| format!("bind {}: {e}", path.display()))?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    let _ = devices.mcp.socket.set(path);
    std::thread::Builder::new()
        .name("coool-device mcp".into())
        .spawn(move || {
            for conn in listener.incoming().flatten() {
                let d = devices.clone();
                let _ = std::thread::Builder::new().name("coool-device conn".into()).spawn(move || serve(d, conn));
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Removes this process's socket (on quit).
pub fn cleanup(devices: &Devices) {
    if let Some(p) = devices.mcp.socket.get() {
        let _ = std::fs::remove_file(p);
    }
}

fn serve(devices: Arc<Devices>, conn: UnixStream) {
    let mut out = match conn.try_clone() {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut lines = BufReader::new(conn).lines();
    let Some(Ok(hello)) = lines.next() else { return };
    let token = serde_json::from_str::<Value>(&hello).ok().and_then(|v| v["token"].as_str().map(String::from)).unwrap_or_default();
    let Some(chat) = devices.mcp.tokens.lock().unwrap().get(&token).copied() else {
        let _ = writeln!(out, "{}", json!({"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"coool-device: unknown token"}}));
        return;
    };
    super::presence::begin_connection();
    let mut session = Session { devices, chat };
    for line in lines {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(Value::Array(batch)) => {
                let r: Vec<Value> = batch.iter().filter_map(|m| session.handle(m)).collect();
                (!r.is_empty()).then_some(Value::Array(r))
            }
            Ok(m) => session.handle(&m),
            Err(e) => Some(json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":format!("parse error: {e}")}})),
        };
        if let Some(r) = reply
            && writeln!(out, "{r}").and_then(|_| out.flush()).is_err()
        {
            break;
        }
    }
}

// ---- the stdio proxy (`coool --coool-device-mcp`) ----

/// Runs in the chat's CLI as its MCP server process: connects to the app and pipes stdio both ways.
pub fn proxy() -> i32 {
    proxy_with(SOCKET_ENV, TOKEN_ENV, SERVER_NAME)
}

/// The same relay for another of coool's per-chat servers (`coool-ladder`): its socket and token come from
/// `socket_env` / `token_env`.
pub fn proxy_with(socket_env: &str, token_env: &str, name: &str) -> i32 {
    let (Some(sock), Some(token)) = (std::env::var_os(socket_env), std::env::var(token_env).ok()) else {
        eprintln!("{name}: started without {socket_env} / {token_env} (coool sets these for chats it starts)");
        return 2;
    };
    let mut conn = match UnixStream::connect(&sock) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{name}: coool isn't reachable ({e}); is the app still running?");
            return 1;
        }
    };
    if writeln!(conn, "{}", json!({ "token": token })).is_err() {
        return 1;
    }
    let mut back = match conn.try_clone() {
        Ok(c) => c,
        Err(_) => return 1,
    };
    let up = std::thread::spawn(move || {
        let _ = std::io::copy(&mut std::io::stdin().lock(), &mut conn);
        let _ = conn.shutdown(std::net::Shutdown::Write);
    });
    let mut stdout = std::io::stdout().lock();
    let mut buf = [0u8; 64 * 1024];
    loop {
        match back.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if stdout.write_all(&buf[..n]).and_then(|_| stdout.flush()).is_err() {
                    break;
                }
            }
        }
    }
    drop(up);
    0
}

// ---- protocol ----

struct Session {
    devices: Arc<Devices>,
    chat: usize,
}

/// One `coool-device` tool called for `chat` as its agent calls it over MCP (the self-test drives panels this way).
pub fn call_tool(devices: &Arc<Devices>, chat: usize, name: &str, args: &Value) -> Result<Vec<Value>, String> {
    Session { devices: devices.clone(), chat }.call(name, args)
}

const INSTRUCTIONS: &str = "Drives the iPhone simulator shown in this chat's coool panel; the person watches it live. \
For routine multi-step navigation or form filling (on the iPhone or the Browser panel), call `pilot_run` with the goal \
and checkable `success` conditions: coool's fast pilot does the steps and verifies them, much faster than step-by-step \
calls. Use the single-step tools below for judgement calls, or to take over when the pilot is stuck. Start with `observe`: it lists the screen's elements as `[id] role \"label\" value=… (x,y wxh)` in points. Act by id \
(tap / type / swipe) — every action returns the screen after it settles, so you rarely need a separate observe. Use \
`batch` for several steps in one call, and `wait_for` instead of sleeping. Ask for a screenshot only when visuals matter.";

impl Session {
    fn handle(&mut self, m: &Value) -> Option<Value> {
        let method = m["method"].as_str().unwrap_or("");
        let id = m.get("id").cloned()?; // notifications get no reply
        let ok = |result: Value| Some(json!({"jsonrpc":"2.0","id":id,"result":result}));
        match method {
            "initialize" => ok(json!({
                "protocolVersion": m["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
                "instructions": format!("{INSTRUCTIONS}\n\n{}\n\n{}", super::web::INSTRUCTIONS, super::vm::INSTRUCTIONS),
            })),
            "ping" => ok(json!({})),
            "tools/list" => ok(json!({ "tools": tools() })),
            "tools/call" => {
                let name = m["params"]["name"].as_str().unwrap_or("");
                let args = m["params"]["arguments"].clone();
                let r = match self.call(name, &args) {
                    Ok(content) => json!({ "content": content }),
                    Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
                };
                ok(r)
            }
            _ => Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":format!("method not found: {method}")}})),
        }
    }

    fn call(&mut self, name: &str, a: &Value) -> Result<Vec<Value>, String> {
        // After a pilot run ended stuck / surprised, the agent's own next action is a decision for the training log.
        super::pilot::dataset::caller_acted(self.chat, name, a);
        // The device pilot: a whole goal on the iPhone or the Browser panel.
        if name == "pilot_run" {
            let text = super::pilot::call(&self.devices, self.chat, a)?;
            return Ok(vec![json!({ "type": "text", "text": text })]);
        }
        // The sandboxed Mac: its own VM, no simulator involved.
        if name.starts_with("mac_") {
            return super::vm::MacTools { d: &self.devices, chat: self.chat }.call(name, a);
        }
        // The chat's Browser panel: no simulator involved.
        if name.starts_with("browser_") {
            return super::web::Browser::new(&self.devices, self.chat).call(name, a);
        }
        let t0 = Instant::now();
        // The permission gate, for what changes something (reading never asks).
        if self.devices.gate_asks(self.chat)
            && let Some(act) = self.iphone_act(name, a)
        {
            self.devices.gate_check(self.chat, act)?;
        }
        // Listing or choosing a device doesn't need one booted first.
        let choosing = name == "device" && matches!(a["action"].as_str(), Some("list" | "select"));
        let udid = match self.devices.bound(self.chat) {
            Some(u) if choosing => u,
            _ if choosing => String::new(),
            _ => self.devices.device_for_chat(self.chat)?,
        };
        let mut out = Vec::new();
        let observe_after = a["observe"].as_bool().unwrap_or(true);
        let text = match name {
            "observe" => {
                self.activity(&udid, "observe", None, None, None);
                let s = self.observe(&udid, true, None)?;
                if a["screenshot"].as_bool() == Some(true) {
                    out.push(self.screenshot(&udid, a["max_size"].as_f64())?);
                }
                s
            }
            "tap" | "type" | "swipe" | "press" => {
                let note = self.act(&udid, name, a)?;
                let act_ms = t0.elapsed().as_millis();
                if observe_after { self.after(&udid, &note, act_ms)? } else { format!("{note} · {act_ms} ms") }
            }
            "batch" => {
                let steps = a["actions"].as_array().cloned().unwrap_or_default();
                if steps.is_empty() {
                    return Err("batch needs `actions`: a list like [{\"tap\":\"k3f\"},{\"type\":\"hello\",\"submit\":true}]".into());
                }
                let mut notes = Vec::new();
                for (i, s) in steps.iter().enumerate() {
                    match self.step(&udid, s) {
                        Ok(n) => notes.push(format!("{}. {n}", i + 1)),
                        Err(e) => {
                            notes.push(format!("{}. FAILED: {e} (stopped; later steps not run)", i + 1));
                            let screen = self.observe(&udid, false, None).unwrap_or_default();
                            return Err(format!("{}\n\n{screen}", notes.join("\n")));
                        }
                    }
                }
                let act_ms = t0.elapsed().as_millis();
                if observe_after { self.after(&udid, &notes.join("\n"), act_ms)? } else { format!("{}\n{act_ms} ms", notes.join("\n")) }
            }
            "wait_for" => self.wait_for(&udid, a)?,
            "app" => self.app(&udid, a)?,
            "device" => self.device(&udid, a)?,
            _ => return Err(format!("unknown tool {name}")),
        };
        out.insert(0, json!({ "type": "text", "text": text }));
        Ok(out)
    }

    /// What an iPhone tool call changes, for the gate (None: it only reads).
    fn iphone_act(&self, name: &str, a: &Value) -> Option<Act> {
        let label = |v: &Value| -> String {
            let id = v.as_str().unwrap_or("").trim_matches(['[', ']']).to_string();
            let last = self.devices.mcp.last.lock().unwrap();
            let n = last.get(&self.chat).and_then(|(t, _)| t.nodes.iter().find(|n| n.id == id).and_then(|n| n.label.clone().or(n.identifier.clone())));
            n.map(|l| format!("“{}”", l.chars().take(60).collect::<String>())).unwrap_or_else(|| if id.is_empty() { "a point".into() } else { format!("[{id}]") })
        };
        let what = match name {
            "observe" | "wait_for" => return None,
            "tap" => format!("Tap {}", label(if a["target"].is_null() { &a["id"] } else { &a["target"] })),
            "type" => format!("Type “{}”", a["text"].as_str().unwrap_or("").chars().take(60).collect::<String>()),
            "swipe" => match a["scroll"].as_str() {
                Some(d) => format!("Scroll {d}"),
                None => "Swipe".into(),
            },
            "press" => format!("Press {}", a["button"].as_str().or(a["key"].as_str()).unwrap_or("a key")),
            "batch" => format!("Run {} steps", a["actions"].as_array().map(|v| v.len()).unwrap_or(0)),
            "app" => match a["action"].as_str().unwrap_or("") {
                "list" => return None,
                "install" => {
                    let path = a["path"].as_str().unwrap_or("").to_string();
                    return Some(Act::new(Dev::Iphone, format!("Install {path}")).risk(Some(Risk::Install { what: path })));
                }
                "open_url" => format!("Open {}", a["url"].as_str().unwrap_or("a URL")),
                act => format!("{} {}", if act == "launch" { "Launch" } else { "Quit" }, a["bundle_id"].as_str().unwrap_or("an app")),
            },
            "device" => match a["action"].as_str().unwrap_or("status") {
                "status" | "list" => return None,
                act => format!("Device: {act}{}", a["udid"].as_str().or(a["value"].as_str()).map(|v| format!(" {v}")).unwrap_or_default()),
            },
            _ => return None,
        };
        Some(Act::new(Dev::Iphone, what))
    }

    fn activity(&self, udid: &str, kind: &'static str, at: Option<(f64, f64)>, to: Option<(f64, f64)>, label: Option<String>) {
        self.devices.activity(Activity {
            udid: udid.to_string(),
            chat: Some(self.chat),
            source: "agent",
            kind,
            x: at.map(|p| p.0),
            y: at.map(|p| p.1),
            x2: to.map(|p| p.0),
            y2: to.map(|p| p.1),
            label,
            ..Default::default()
        });
    }

    /// Typing: where (the field's centre, when known), into what, and the text (dots for a secret field).
    fn typing(&self, udid: &str, at: Option<(f64, f64)>, field: Option<String>, text: &str) {
        let text = super::presence::shown_text(text, field.as_deref());
        self.devices.activity(Activity {
            udid: udid.to_string(),
            chat: Some(self.chat),
            source: "agent",
            kind: "type",
            x: at.map(|p| p.0),
            y: at.map(|p| p.1),
            label: field,
            text: Some(text),
            ..Default::default()
        });
    }

    /// The focused text field of the last screen the chat saw: (its centre, its name).
    fn focused_field(&self) -> Option<((f64, f64), Option<String>)> {
        let last = self.devices.mcp.last.lock().unwrap();
        let (t, _) = last.get(&self.chat)?;
        let n = t.nodes.iter().find(|n| n.flags.contains(&"focused") && matches!(n.role.as_str(), "textfield" | "textarea" | "searchfield" | "securefield"))?;
        Some((n.center(), n.label.clone().or_else(|| n.placeholder.clone())))
    }

    fn helper(&self, udid: &str) -> Result<Arc<super::helper::Helper>, String> {
        self.devices.helper(udid)
    }

    fn tree(&self, udid: &str) -> Result<Tree, String> {
        // Just after a boot the accessibility bridge answers nothing for a few seconds (the self-test's first observe
        // on a fresh device failed with "no frontmost application"): wait it out instead of failing the agent's call.
        let until = Instant::now() + Duration::from_secs(12);
        loop {
            match self.helper(udid)?.call(json!({ "cmd": "describe", "max": 500 }), Duration::from_secs(10)) {
                Ok(d) => return Ok(observe::parse(&d)),
                Err(e) if e.contains("no frontmost application") && Instant::now() < until => std::thread::sleep(Duration::from_millis(500)),
                Err(e) => return Err(e),
            }
        }
    }

    /// The screen as text; remembered for id lookup. `full: false` says "unchanged" when nothing changed.
    fn observe(&self, udid: &str, full: bool, tree: Option<Tree>) -> Result<String, String> {
        let tree = match tree {
            Some(t) => t,
            None => self.tree(udid)?,
        };
        let text = observe::render(&tree, &self.devices.name(udid));
        let mut last = self.devices.mcp.last.lock().unwrap();
        let same = last.get(&self.chat).is_some_and(|(_, t)| *t == text);
        last.insert(self.chat, (tree.clone(), text.clone()));
        Ok(if same && !full { format!("Screen unchanged ({} elements).", tree.nodes.len()) } else { text })
    }

    /// After an action: wait for the screen to settle, then observe.
    fn after(&self, udid: &str, note: &str, act_ms: u128) -> Result<String, String> {
        let t = Instant::now();
        // Wait for the change to start (an app can take a few hundred ms), then for the animation to end (a blinking
        // caret or a cell updating now and then doesn't count).
        let _ = self.helper(udid)?.call(json!({ "cmd": "idle", "quietMs": 150, "quietFrames": 2, "firstMs": 400, "timeoutMs": 2500 }), Duration::from_secs(5));
        let settle = t.elapsed().as_millis();
        let t = Instant::now();
        let screen = self.observe(udid, false, None)?;
        Ok(format!("{note}\n(act {act_ms} ms · settle {settle} ms · observe {} ms)\n\n{screen}", t.elapsed().as_millis()))
    }

    fn screenshot(&self, udid: &str, max: Option<f64>) -> Result<Value, String> {
        let r = self.helper(udid)?.call(json!({ "cmd": "snapshot", "maxDim": max.unwrap_or(800.0).clamp(200.0, 1600.0), "quality": 0.6 }), Duration::from_secs(5))?;
        Ok(json!({ "type": "image", "data": r["jpeg"], "mimeType": "image/jpeg" }))
    }

    /// An element of the last observation by id (re-observing once if it isn't there).
    fn element(&self, udid: &str, id: &str) -> Result<observe::Node, String> {
        let id = id.trim().trim_start_matches('[').trim_end_matches(']');
        let find = |t: &Tree| t.nodes.iter().find(|n| n.id == id).cloned();
        if let Some(n) = self.devices.mcp.last.lock().unwrap().get(&self.chat).and_then(|(t, _)| find(t)) {
            return Ok(n);
        }
        let t = self.tree(udid)?;
        let n = find(&t);
        let _ = self.observe(udid, true, Some(t));
        n.ok_or_else(|| format!("no element [{id}] on screen now; observe again for current ids"))
    }

    /// A point from `target` (an element id) or `x`/`y`.
    fn point(&self, udid: &str, a: &Value, key: &str) -> Result<((f64, f64), Option<String>), String> {
        // `id` for `target`: agents write it so (the self-test's Haiku chat did, as the browser tools call it `id`).
        let given = if key == "target" && a[key].is_null() { &a["id"] } else { &a[key] };
        if let Some(id) = given.as_str() {
            let n = self.element(udid, id)?;
            let (w, h) = self.screen_size(udid);
            // The visible part's centre (an element can hang off screen).
            let x0 = n.frame[0].max(0.0);
            let y0 = n.frame[1].max(0.0);
            let x1 = (n.frame[0] + n.frame[2]).min(w);
            let y1 = (n.frame[1] + n.frame[3]).min(h);
            let c = if x1 > x0 && y1 > y0 { ((x0 + x1) / 2.0, (y0 + y1) / 2.0) } else { n.center() };
            return Ok((c, n.label.or(n.identifier).or(n.value)));
        }
        if let Some(p) = a[key].as_array().filter(|p| p.len() == 2) {
            return Ok(((p[0].as_f64().unwrap_or(0.0), p[1].as_f64().unwrap_or(0.0)), None));
        }
        match (a["x"].as_f64(), a["y"].as_f64()) {
            (Some(x), Some(y)) if key == "target" => Ok(((x, y), None)),
            _ => Err(format!("give `{key}` (an element id from observe) or x and y in points")),
        }
    }

    fn screen_size(&self, udid: &str) -> (f64, f64) {
        self.devices.screen(udid).map(|s| (s.w, s.h)).unwrap_or((402.0, 874.0))
    }

    fn tap(&self, udid: &str, (x, y): (f64, f64), hold: Option<f64>, label: Option<String>) -> Result<String, String> {
        self.activity(udid, "tap", Some((x, y)), None, label.clone());
        let mut req = json!({ "cmd": "tap", "x": x, "y": y });
        if let Some(h) = hold {
            req["holdMs"] = json!(h.clamp(10.0, 10_000.0));
        }
        self.helper(udid)?.call(req, Duration::from_secs(15))?;
        let what = label.map(|l| format!(" \"{l}\"")).unwrap_or_default();
        Ok(format!("{}{what} at ({x:.0},{y:.0})", if hold.is_some_and(|h| h >= 400.0) { "long-pressed" } else { "tapped" }))
    }

    fn swipe(&self, udid: &str, from: (f64, f64), to: (f64, f64), ms: f64) -> Result<String, String> {
        self.swipe_as(udid, "swipe", from, to, ms, None)
    }

    fn swipe_as(&self, udid: &str, kind: &'static str, from: (f64, f64), to: (f64, f64), ms: f64, label: Option<String>) -> Result<String, String> {
        self.activity(udid, kind, Some(from), Some(to), label);
        self.helper(udid)?.call(
            json!({ "cmd": "swipe", "x1": from.0, "y1": from.1, "x2": to.0, "y2": to.1, "ms": ms.clamp(50.0, 5000.0) }),
            Duration::from_secs(15),
        )?;
        Ok(format!("swiped ({:.0},{:.0}) → ({:.0},{:.0})", from.0, from.1, to.0, to.1))
    }

    /// Scrolling `dir` shows content further that way (scroll down = finger moves up).
    fn scroll(&self, udid: &str, dir: &str, within: Option<&str>, amount: f64) -> Result<String, String> {
        let (w, h) = self.screen_size(udid);
        let area = match within {
            Some(id) => self.element(udid, id)?.frame,
            None => [0.0, h * 0.12, w, h * 0.76],
        };
        let (cx, cy) = (area[0] + area[2] / 2.0, area[1] + area[3] / 2.0);
        let dx = area[2] * amount.clamp(0.1, 0.95) / 2.0;
        let dy = area[3] * amount.clamp(0.1, 0.95) / 2.0;
        let (from, to) = match dir {
            "down" => ((cx, cy + dy), (cx, cy - dy)),
            "up" => ((cx, cy - dy), (cx, cy + dy)),
            "right" => ((cx + dx, cy), (cx - dx, cy)),
            "left" => ((cx - dx, cy), (cx + dx, cy)),
            _ => return Err("scroll is up, down, left or right".into()),
        };
        self.swipe_as(udid, "scroll", from, to, 300.0, Some(dir.to_string()))?;
        Ok(format!("scrolled {dir}"))
    }

    fn type_into(&self, udid: &str, text: &str, into: Option<&str>, clear: bool, submit: bool) -> Result<String, String> {
        let mut note = String::new();
        let mut field = None;
        if let Some(id) = into {
            let (p, label) = self.point(udid, &json!({ "target": id }), "target")?;
            field = Some((p, label.clone()));
            note = self.tap(udid, p, None, label)? + ", ";
            // Let the keyboard focus land.
            let _ = self.helper(udid)?.call(json!({ "cmd": "idle", "quietMs": 80, "timeoutMs": 800 }), Duration::from_secs(3));
        }
        let field = field.or_else(|| self.focused_field());
        let h = self.helper(udid)?;
        if clear {
            h.call(json!({ "cmd": "key", "name": "a", "modifiers": ["command"] }), Duration::from_secs(5))?;
            h.call(json!({ "cmd": "key", "name": "backspace" }), Duration::from_secs(5))?;
        }
        self.typing(udid, field.as_ref().map(|f| f.0), field.and_then(|f| f.1), text);
        super::type_text(&self.devices, udid, text)?;
        if submit {
            h.call(json!({ "cmd": "key", "name": "return" }), Duration::from_secs(5))?;
        }
        Ok(format!("{note}{}typed {:?}{}", if clear { "cleared, " } else { "" }, text, if submit { " + return" } else { "" }))
    }

    fn press(&self, udid: &str, a: &Value) -> Result<String, String> {
        let h = self.helper(udid)?;
        if let Some(b) = a["button"].as_str() {
            self.activity(udid, "press", None, None, Some(b.to_string()));
            h.call(json!({ "cmd": "button", "name": b, "holdMs": a["hold_ms"].as_f64().unwrap_or(80.0) }), Duration::from_secs(15))?;
            return Ok(format!("pressed the {b} button"));
        }
        let key = a["key"].as_str().ok_or("press needs `key` (e.g. \"return\") or `button` (e.g. \"home\")")?;
        self.activity(udid, "press", None, None, Some(key.to_string()));
        h.call(json!({ "cmd": "key", "name": key, "modifiers": a["modifiers"] }), Duration::from_secs(5))?;
        Ok(format!("pressed {key}"))
    }

    fn act(&self, udid: &str, name: &str, a: &Value) -> Result<String, String> {
        match name {
            "tap" => {
                let (p, label) = self.point(udid, a, "target")?;
                self.tap(udid, p, a["hold_ms"].as_f64(), label)
            }
            "type" => {
                let text = a["text"].as_str().ok_or("type needs `text`")?;
                self.type_into(udid, text, a["into"].as_str(), a["clear"].as_bool() == Some(true), a["submit"].as_bool() == Some(true))
            }
            "swipe" => {
                if let Some(dir) = a["scroll"].as_str() {
                    return self.scroll(udid, dir, a["in"].as_str(), a["amount"].as_f64().unwrap_or(0.6));
                }
                let (from, _) = self.point(udid, a, "from")?;
                let (to, _) = self.point(udid, a, "to")?;
                self.swipe(udid, from, to, a["duration_ms"].as_f64().unwrap_or(300.0))
            }
            "press" => self.press(udid, a),
            _ => Err(format!("unknown action {name}")),
        }
    }

    /// One `batch` step: `{"tap":"k3f"}`, `{"tap":[x,y]}`, `{"type":"hi","into":"x9a","submit":true}`, `{"press":"return"}`,
    /// `{"button":"home"}`, `{"swipe":[x1,y1,x2,y2]}`, `{"scroll":"down","in":"t2c"}`, `{"wait_ms":300}`,
    /// `{"wait_for":"Done"}`, `{"launch":"com.example.app"}`, `{"open_url":"https://…"}`.
    fn step(&mut self, udid: &str, s: &Value) -> Result<String, String> {
        if let Some(t) = s.get("tap") {
            let (p, label) = self.point(udid, &json!({ "target": t }), "target")?;
            return self.tap(udid, p, s["hold_ms"].as_f64(), label);
        }
        if let Some(t) = s["type"].as_str() {
            return self.type_into(udid, t, s["into"].as_str(), s["clear"].as_bool() == Some(true), s["submit"].as_bool() == Some(true));
        }
        if let Some(k) = s["press"].as_str() {
            return self.press(udid, &json!({ "key": k, "modifiers": s["modifiers"] }));
        }
        if let Some(b) = s["button"].as_str() {
            return self.press(udid, &json!({ "button": b }));
        }
        if let Some(p) = s["swipe"].as_array().filter(|p| p.len() == 4) {
            let f = |i: usize| p[i].as_f64().unwrap_or(0.0);
            return self.swipe(udid, (f(0), f(1)), (f(2), f(3)), s["duration_ms"].as_f64().unwrap_or(300.0));
        }
        if let Some(d) = s["scroll"].as_str() {
            return self.scroll(udid, d, s["in"].as_str(), s["amount"].as_f64().unwrap_or(0.6));
        }
        if let Some(ms) = s["wait_ms"].as_f64() {
            std::thread::sleep(Duration::from_millis(ms.clamp(0.0, 10_000.0) as u64));
            return Ok(format!("waited {ms:.0} ms"));
        }
        if let Some(t) = s.get("wait_for") {
            let mut a = s.clone();
            if let Some(text) = t.as_str() {
                a["text"] = json!(text);
            } else if t.is_object() {
                a = t.clone();
            }
            let (ok, ms) = self.wait(udid, &a)?;
            return if ok { Ok(format!("waited {ms} ms for {}", describe_wait(&a))) } else { Err(format!("timed out after {ms} ms waiting for {}", describe_wait(&a))) };
        }
        if let Some(b) = s["launch"].as_str() {
            return self.app(udid, &json!({ "action": "launch", "bundle_id": b }));
        }
        if let Some(u) = s["open_url"].as_str() {
            return self.app(udid, &json!({ "action": "open_url", "url": u }));
        }
        Err(format!("unknown batch step {s}"))
    }

    /// Polls the tree until the condition holds: (met, elapsed ms).
    fn wait(&self, udid: &str, a: &Value) -> Result<(bool, u128), String> {
        let t0 = Instant::now();
        let timeout = Duration::from_millis(a["timeout_ms"].as_f64().unwrap_or(5000.0).clamp(0.0, 60_000.0) as u64);
        let gone = a["gone"].as_bool() == Some(true);
        if a["idle"].as_bool() == Some(true) && a["text"].is_null() && a["id"].is_null() {
            let r = self.helper(udid)?.call(
                json!({ "cmd": "idle", "quietMs": a["quiet_ms"].as_f64().unwrap_or(300.0), "timeoutMs": timeout.as_millis() as u64 }),
                timeout + Duration::from_secs(3),
            )?;
            return Ok((r["idle"].as_bool() == Some(true), t0.elapsed().as_millis()));
        }
        let text = a["text"].as_str();
        let id = a["id"].as_str();
        if text.is_none() && id.is_none() {
            return Err("wait_for needs `text`, `id` or `idle: true`".into());
        }
        loop {
            let tree = self.tree(udid)?;
            let present = tree.nodes.iter().any(|n| text.is_some_and(|t| n.mentions(t)) || id.is_some_and(|i| n.id == i));
            if present != gone {
                let _ = self.observe(udid, true, Some(tree));
                return Ok((true, t0.elapsed().as_millis()));
            }
            if t0.elapsed() >= timeout {
                let _ = self.observe(udid, true, Some(tree));
                return Ok((false, t0.elapsed().as_millis()));
            }
            std::thread::sleep(Duration::from_millis(80));
        }
    }

    fn wait_for(&self, udid: &str, a: &Value) -> Result<String, String> {
        let (ok, ms) = self.wait(udid, a)?;
        let screen = self.devices.mcp.last.lock().unwrap().get(&self.chat).map(|(_, t)| t.clone()).unwrap_or_default();
        let head = if ok { format!("{} after {ms} ms", describe_wait(a)) } else { format!("timed out after {ms} ms waiting for {}", describe_wait(a)) };
        if ok { Ok(format!("{head}\n\n{screen}")) } else { Err(format!("{head}\n\n{screen}")) }
    }

    fn app(&self, udid: &str, a: &Value) -> Result<String, String> {
        let action = a["action"].as_str().unwrap_or("");
        let bundle = || a["bundle_id"].as_str().ok_or_else(|| format!("{action} needs `bundle_id`"));
        self.activity(udid, "app", None, None, Some(action.to_string()));
        let r = match action {
            "launch" => simctl::launch(udid, bundle()?).map(|pid| format!("launched {pid}"))?,
            "terminate" => simctl::terminate(udid, bundle()?).map(|_| format!("terminated {}", bundle().unwrap_or_default()))?,
            "install" => {
                let path = a["path"].as_str().ok_or("install needs `path` (a built .app for the simulator)")?;
                simctl::install(udid, path).map(|_| format!("installed {path}"))?
            }
            "open_url" => {
                let url = a["url"].as_str().ok_or("open_url needs `url`")?;
                simctl::open_url(udid, url).map(|_| format!("opened {url}"))?
            }
            "list" => {
                let apps = simctl::user_apps(udid)?;
                return Ok(if apps.is_empty() { "No user apps installed.".into() } else { apps.iter().map(|(id, n)| format!("{id}  {n}")).collect::<Vec<_>>().join("\n") });
            }
            _ => return Err("app action is launch, terminate, install, open_url or list".into()),
        };
        if action == "install" || a["observe"].as_bool() == Some(false) {
            return Ok(r);
        }
        self.after(udid, &r, 0)
    }

    fn device(&mut self, udid: &str, a: &Value) -> Result<String, String> {
        let action = a["action"].as_str().unwrap_or("status");
        self.activity(udid, "device", None, None, Some(action.to_string()));
        match action {
            "status" => {
                let d = simctl::device(udid)?;
                let s = self.devices.screen(udid).ok();
                Ok(format!(
                    "{} · {} · {} · {} · udid {}{}",
                    d.name,
                    d.device_type,
                    d.runtime,
                    d.state,
                    d.udid,
                    s.map(|s| format!(" · {}x{} pt @{}x", s.w, s.h, s.scale)).unwrap_or_default()
                ))
            }
            "list" => Ok(simctl::devices()?
                .iter()
                .map(|d| format!("{}{}  {} · {} · {} · {}", if d.udid == udid { "* " } else { "  " }, d.udid, d.name, d.device_type, d.runtime, d.state))
                .collect::<Vec<_>>()
                .join("\n")),
            "select" => {
                let to = a["udid"].as_str().ok_or("select needs `udid` (see device list)")?;
                simctl::device(to)?;
                self.devices.bind(self.chat, Some(to.to_string()));
                self.devices.boot(to)?;
                self.devices.activity(Activity { udid: to.into(), chat: Some(self.chat), source: "agent", kind: "device", ..Default::default() });
                Ok(format!("now driving {}", self.devices.name(to)))
            }
            "boot" => self.devices.boot(udid).map(|_| "booted".into()),
            "shutdown" => self.devices.shutdown(udid).map(|_| "shut down".into()),
            "appearance" => {
                let v = a["value"].as_str().unwrap_or("dark");
                simctl::appearance(udid, v).map(|_| format!("appearance {v}"))
            }
            "location" => {
                let (Some(lat), Some(lon)) = (a["lat"].as_f64(), a["lon"].as_f64()) else { return Err("location needs `lat` and `lon`".into()) };
                simctl::location(udid, lat, lon).map(|_| format!("location set to {lat},{lon}"))
            }
            "privacy" => {
                let service = a["service"].as_str().ok_or("privacy needs `service` (photos, camera, location, contacts, microphone, …)")?;
                let bundle = a["bundle_id"].as_str().ok_or("privacy needs `bundle_id`")?;
                let act = if a["grant"].as_bool() == Some(false) { "revoke" } else { "grant" };
                simctl::privacy(udid, act, service, bundle).map(|_| format!("{act}ed {service} for {bundle}"))
            }
            _ => Err("device action is status, list, select, boot, shutdown, appearance, location or privacy".into()),
        }
    }
}

fn describe_wait(a: &Value) -> String {
    let gone = a["gone"].as_bool() == Some(true);
    match (a["text"].as_str(), a["id"].as_str()) {
        (Some(t), _) => format!("{:?} to {}", t, if gone { "disappear" } else { "appear" }),
        (_, Some(i)) => format!("[{i}] to {}", if gone { "disappear" } else { "appear" }),
        _ => "the screen to settle".into(),
    }
}

fn tools() -> Value {
    let mut all = vec![super::pilot::tool()];
    if let Value::Array(v) = device_tools() {
        all.extend(v);
    }
    all.extend(super::web::tools());
    all.extend(super::vm::tools());
    Value::Array(all)
}

fn device_tools() -> Value {
    let target = json!({ "type": "string", "description": "Element id from observe, e.g. \"k3f\"" });
    let observe = json!({ "type": "boolean", "description": "Return the screen after the action settles (default true)." });
    json!([
        {
            "name": "observe",
            "description": "Read the iPhone screen: one line per accessibility element, `[id] role \"label\" value=… (x,y wxh)` in points (origin top-left). Ids are short and stable across observes. screenshot=true adds a small JPEG (only when visuals matter).",
            "inputSchema": { "type": "object", "properties": {
                "screenshot": { "type": "boolean" },
                "max_size": { "type": "number", "description": "Screenshot's longest side in pixels (default 800)." }
            } }
        },
        {
            "name": "tap",
            "description": "Tap an element (by id) or a point. hold_ms ≥ 500 long-presses. Returns the screen after it settles.",
            "inputSchema": { "type": "object", "properties": {
                "target": target, "x": { "type": "number" }, "y": { "type": "number" },
                "hold_ms": { "type": "number" }, "observe": observe
            } }
        },
        {
            "name": "type",
            "description": "Type text with the keyboard (non-ASCII is pasted). into: tap this element first; clear: replace its text; submit: press return after.",
            "inputSchema": { "type": "object", "required": ["text"], "properties": {
                "text": { "type": "string" }, "into": target, "clear": { "type": "boolean" }, "submit": { "type": "boolean" }, "observe": observe
            } }
        },
        {
            "name": "swipe",
            "description": "Scroll (`scroll`: up/down/left/right shows content further that way, optionally `in` a scroll view by id, `amount` 0.1-0.95 of its size) or swipe between two points/elements (`from`, `to`: id or [x,y]).",
            "inputSchema": { "type": "object", "properties": {
                "scroll": { "type": "string", "enum": ["up", "down", "left", "right"] }, "in": target, "amount": { "type": "number" },
                "from": { "description": "id or [x,y]" }, "to": { "description": "id or [x,y]" }, "duration_ms": { "type": "number" }, "observe": observe
            } }
        },
        {
            "name": "press",
            "description": "Press a key (return, backspace, tab, escape, space, up, down, left, right, or one character; modifiers: shift/control/option/command) or a hardware button (home, lock, siri, volumeUp, volumeDown).",
            "inputSchema": { "type": "object", "properties": {
                "key": { "type": "string" }, "modifiers": { "type": "array", "items": { "type": "string" } },
                "button": { "type": "string", "enum": ["home", "lock", "siri", "volumeUp", "volumeDown"] }, "observe": observe
            } }
        },
        {
            "name": "batch",
            "description": "Run several steps in one call, then return the settled screen. Steps: {\"tap\":\"id\"|[x,y],\"hold_ms\"?}, {\"type\":\"text\",\"into\"?:\"id\",\"clear\"?,\"submit\"?}, {\"press\":\"return\",\"modifiers\"?}, {\"button\":\"home\"}, {\"swipe\":[x1,y1,x2,y2]}, {\"scroll\":\"down\",\"in\"?:\"id\"}, {\"wait_for\":\"text\"|{\"text\"|\"id\",\"gone\"?,\"timeout_ms\"?}}, {\"wait_ms\":300}, {\"launch\":\"bundle.id\"}, {\"open_url\":\"url\"}. Stops at the first failing step.",
            "inputSchema": { "type": "object", "required": ["actions"], "properties": {
                "actions": { "type": "array", "items": { "type": "object" } }, "observe": observe
            } }
        },
        {
            "name": "wait_for",
            "description": "Wait until text (in any label/value) or an element id appears — or disappears with gone=true — or until the screen stops changing (idle=true). Returns the screen. Default timeout 5000 ms.",
            "inputSchema": { "type": "object", "properties": {
                "text": { "type": "string" }, "id": { "type": "string" }, "gone": { "type": "boolean" }, "idle": { "type": "boolean" },
                "timeout_ms": { "type": "number" }
            } }
        },
        {
            "name": "app",
            "description": "Apps on the device: launch / terminate (bundle_id), install (path to a simulator .app build), open_url (url, incl. deep links), list (installed user apps).",
            "inputSchema": { "type": "object", "required": ["action"], "properties": {
                "action": { "type": "string", "enum": ["launch", "terminate", "install", "open_url", "list"] },
                "bundle_id": { "type": "string" }, "path": { "type": "string" }, "url": { "type": "string" }, "observe": observe
            } }
        },
        {
            "name": "device",
            "description": "The device itself: status, list (simulators), select (udid: drive another one; the panel follows), boot, shutdown, appearance (value: light|dark), location (lat, lon), privacy (service, bundle_id, grant).",
            "inputSchema": { "type": "object", "properties": {
                "action": { "type": "string", "enum": ["status", "list", "select", "boot", "shutdown", "appearance", "location", "privacy"] },
                "udid": { "type": "string" }, "value": { "type": "string" }, "lat": { "type": "number" }, "lon": { "type": "number" },
                "service": { "type": "string" }, "bundle_id": { "type": "string" }, "grant": { "type": "boolean" }
            } }
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_basics_without_a_device() {
        let mut s = Session { devices: Arc::new(Devices::default()), chat: 0 };
        let init = s.handle(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}})).unwrap();
        assert_eq!(init["result"]["serverInfo"]["name"], SERVER_NAME);
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        assert!(s.handle(&json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
        let list = s.handle(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})).unwrap();
        let names: Vec<_> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(&names[..10], ["pilot_run", "observe", "tap", "type", "swipe", "press", "batch", "wait_for", "app", "device"]);
        assert!(init["result"]["instructions"].as_str().unwrap().contains("pilot_run"));
        assert!(names[24..].iter().all(|n| n.starts_with("mac_")) && names.len() == 36, "{names:?}");
        assert!(init["result"]["instructions"].as_str().unwrap().contains("mac_observe"));
        assert_eq!(
            &names[10..24],
            [
                "browser_observe", "browser_click", "browser_type", "browser_select", "browser_scroll", "browser_press", "browser_navigate",
                "browser_back", "browser_forward", "browser_reload", "browser_tabs", "browser_wait_for", "browser_screenshot", "browser_batch"
            ]
        );
        assert!(init["result"]["instructions"].as_str().unwrap().contains("browser_navigate"));
        // Without the app, a browser tool answers with an error result (and never boots a simulator).
        let r = s.handle(&json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"browser_observe","arguments":{}}})).unwrap();
        assert_eq!(r["result"]["isError"], true);
        let unknown = s.handle(&json!({"jsonrpc":"2.0","id":3,"method":"nope"})).unwrap();
        assert_eq!(unknown["error"]["code"], -32601);
    }
}
