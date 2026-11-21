//! The chat host (APP_SPEC "Chats that outlive the app"): a small per-user process, `coool --coool-chat-host <dir>`,
//! that owns the CLI processes of chats so they keep running when the app quits, restarts for an update or crashes.
//!
//! The host runs the very same [`Chat`] the app used to (backends included: permission requests, notes and model
//! switches keep working while no app is attached, and a request the CLI asks then is still waiting when one comes
//! back). The app keeps a mirror of each hosted chat's events, numbered as the host numbers them, and sends its calls
//! to the host.
//!
//! Files, in a private folder (0700): `host-<name>.sock` (0600), `host-<name>.token` (0600, written before the
//! socket is bound), `host-<name>.json` (pid, version, protocol, socket). `<name>` is the host's pid.
//!
//! Wire: newline-delimited JSON. The first line is `{"op":"hello","token","protocol","client"}`; a wrong token, a
//! peer of another user or anything else gets one error line and the connection closes. Requests carry `id` and get
//! `{"id","ok","result"|"error"}`; pushes carry `push` (`events`, `answer`).

use super::*;
use std::collections::HashMap;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

/// The protocol this build speaks. A host or app of another protocol is left alone.
pub const PROTOCOL: u32 = 1;
/// `coool --coool-chat-host <dir>` runs a host.
pub const FLAG: &str = "--coool-chat-host";
/// Events per push line (a replay of a long chat goes out in pieces).
const CHUNK: usize = 1000;
/// How long a request waits for the host's reply.
const REPLY_WAIT: Duration = Duration::from_secs(30);

/// A call on a hosted chat: the [`Chat`] / [`ChatHandle`] method of the same name, with its arguments.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "call", rename_all = "snake_case")]
pub enum Call {
    Send {
        text: String,
        #[serde(default)]
        attachments: Vec<crate::attach::Attachment>,
    },
    Steer {
        text: String,
        now: bool,
        #[serde(default)]
        attachments: Vec<crate::attach::Attachment>,
    },
    CancelSteer {
        note_id: String,
    },
    Interrupt,
    SetModel {
        model: String,
    },
    SetPermissionMode {
        mode: String,
    },
    RespondPermission {
        request_id: String,
        allow: bool,
        always: bool,
    },
    RespondPermissionRemember {
        request_id: String,
        remember: String,
    },
    RespondQuestion {
        request_id: String,
        answers: Vec<Vec<String>>,
    },
    Stop,
    Note {
        text: String,
    },
    Ask {
        tool: String,
        summary: String,
        input: Value,
        remember: Vec<RememberOption>,
    },
    Withdraw {
        request_id: String,
        note: String,
    },
    /// Stop the chat's CLI and start it again on the same conversation, in the same chat (its events carry on, the
    /// app's mirror with them). Answers the chat's [`Entry`] as it is now. A host from before this call answers "bad
    /// call": the app then restarts the chat itself.
    Restart,
}

/// Everything the app passed `Chat::start`: the host starts the chat exactly so.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StartReq {
    pub opts: ChatOptions,
    pub client_name: String,
    #[serde(default)]
    pub mcp: Vec<McpServer>,
    #[serde(default)]
    pub ladder_root: Option<PathBuf>,
    #[serde(default)]
    pub meta: Value,
}

/// A chat the host runs, as `start` and `list` describe it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    /// The host's key for it (stable across app launches).
    pub key: String,
    pub pid: Option<u32>,
    pub args: Vec<String>,
    pub launch: crate::chatctx::Launch,
    pub opts: ChatOptions,
    /// Its MCP servers (their env holds the chat's tokens: the app registers them again after a relaunch).
    pub mcp: Vec<McpServer>,
    pub meta: Value,
    pub info: ChatInfo,
    pub started_ms: u64,
    /// The seq of its latest event when listed: what an app taking it in already missed (it isn't notified again).
    #[serde(default)]
    pub last_seq: u64,
}

/// The host's answer to `hello`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Hello {
    pub protocol: u32,
    /// The coool version the host runs.
    pub version: String,
    pub pid: u32,
    pub draining: bool,
}

/// `host-<name>.json`: how an app finds a host.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostFile {
    pub name: String,
    pub pid: u32,
    pub version: String,
    pub protocol: u32,
    pub socket: PathBuf,
}

pub fn sock_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("host-{name}.sock"))
}
pub fn token_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("host-{name}.token"))
}
pub fn json_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("host-{name}.json"))
}

/// Makes `dir` a private folder of this user (0700), or refuses one that isn't.
pub fn ensure_dir(dir: &Path) -> Result<()> {
    match std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e).with_context(|| format!("make {}", dir.display())),
    }
    let m = std::fs::symlink_metadata(dir)?;
    // SAFETY: getuid has no preconditions.
    if !m.file_type().is_dir() || m.uid() != unsafe { libc::getuid() } {
        bail!("{} isn't a folder of this user", dir.display());
    }
    if m.permissions().mode() & 0o077 != 0 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// A test's host folder: only under `/tmp/coool-host-…`, so a test host and the person's never find each other.
pub fn test_dir_ok(p: &Path) -> bool {
    let s = p.to_string_lossy();
    (s.starts_with("/tmp/coool-host-") || s.starts_with("/private/tmp/coool-host-")) && !s.contains("/../")
}

fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks whether the process exists.
    pid > 0 && unsafe { libc::kill(pid as i32, 0) } == 0
}

/// The live hosts in `dir`, newest first. Files of hosts that are gone are removed.
pub fn hosts(dir: &Path) -> Vec<HostFile> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        let Some(name) = n.strip_prefix("host-").and_then(|r| r.strip_suffix(".json")) else { continue };
        let Ok(hf) = std::fs::read(e.path()).map_err(|_| ()).and_then(|b| serde_json::from_slice::<HostFile>(&b).map_err(|_| ())) else { continue };
        if hf.name != name {
            continue;
        }
        if !pid_alive(hf.pid) {
            remove_files(dir, name, &hf.socket);
            continue;
        }
        out.push(hf);
    }
    out.sort_by_key(|h| std::cmp::Reverse(h.pid));
    out
}

fn remove_files(dir: &Path, name: &str, socket: &Path) {
    let _ = std::fs::remove_file(json_path(dir, name));
    let _ = std::fs::remove_file(token_path(dir, name));
    let _ = std::fs::remove_file(socket);
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_err() {
        // Practically unreachable; the token file is private anyway.
        let t = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0) ^ (std::process::id() as u128);
        for (i, x) in b.iter_mut().enumerate() {
            *x = (t >> ((i % 16) * 8)) as u8;
        }
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The peer of a connection is this user (macOS: `getpeereid`; elsewhere the 0600 socket alone decides).
fn peer_is_me(s: &UnixStream) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        let (mut uid, mut gid) = (0 as libc::uid_t, 0 as libc::gid_t);
        // SAFETY: a valid socket fd and two out-pointers.
        let r = unsafe { libc::getpeereid(s.as_raw_fd(), &mut uid, &mut gid) };
        // SAFETY: getuid has no preconditions.
        r == 0 && uid == unsafe { libc::getuid() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = s;
        true
    }
}

fn write_line(out: &Mutex<UnixStream>, v: &Value) -> bool {
    let mut l = v.to_string();
    l.push('\n');
    let mut s = out.lock().unwrap_or_else(|e| e.into_inner());
    s.write_all(l.as_bytes()).and_then(|_| s.flush()).is_ok()
}

// ---------------------------------------------------------------- the host

/// How long the host waits before acting on its own (tests shorten them).
#[derive(Clone, Debug)]
pub struct Timing {
    /// No chats and no app for this long: the host exits.
    pub idle_exit: Duration,
    /// With no app attached, a chat idle this long is stopped (resumable from its transcript).
    pub idle_stop: Duration,
    /// With no app attached, a chat waiting on the person this long is stopped.
    pub waiting_stop: Duration,
    /// An ended chat is kept (for an app that comes back to see how it ended) this long.
    pub exited_keep: Duration,
    pub tick: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing { idle_exit: Duration::from_secs(60), idle_stop: Duration::from_secs(30 * 60), waiting_stop: Duration::from_secs(24 * 3600), exited_keep: Duration::from_secs(10 * 60), tick: Duration::from_secs(2) }
    }
}

/// How the host starts a chat (tests start stand-ins).
/// The last argument: a restart, the chat to start the CLI again in (see [`Chat::start_into`]).
pub(crate) type Spawner = Arc<dyn Fn(usize, &StartReq, Option<&ChatHandle>) -> Result<Chat> + Send + Sync>;

struct HostChat {
    chat: Chat,
    opts: ChatOptions,
    mcp: Vec<McpServer>,
    /// The rest of its start request, for a restart.
    client_name: String,
    ladder_root: Option<PathBuf>,
    meta: Value,
    started_ms: u64,
    idle_since: Option<Instant>,
    exited_at: Option<Instant>,
}

impl HostChat {
    fn entry(&self, key: &str) -> Entry {
        Entry {
            key: key.to_string(),
            pid: self.chat.pid,
            args: self.chat.launch_args().to_vec(),
            launch: self.chat.launch_info().clone(),
            opts: self.opts.clone(),
            mcp: self.mcp.clone(),
            meta: self.meta.clone(),
            info: self.chat.info(),
            started_ms: self.started_ms,
            last_seq: self.chat.handle().last_seq(),
        }
    }
}

pub struct Server {
    dir: PathBuf,
    name: String,
    socket: PathBuf,
    version: String,
    token: String,
    timing: Timing,
    spawn: Spawner,
    draining: AtomicBool,
    chats: Mutex<HashMap<String, HostChat>>,
    next_id: AtomicUsize,
    clients: AtomicUsize,
    last_client: Mutex<Instant>,
    /// Set when the host should exit (idle, or drained).
    done: AtomicBool,
}

/// One app's connection.
struct Conn {
    out: Mutex<UnixStream>,
    /// Chat key -> the last seq sent.
    attached: Mutex<HashMap<String, u64>>,
    /// coool's own requests this connection asked: (chat key, request id).
    asks: Mutex<Vec<(String, String)>>,
    alive: AtomicBool,
}

impl Server {
    /// Binds the socket in `dir` (named `name`) and serves on threads of its own.
    pub(crate) fn start(dir: &Path, name: &str, version: &str, timing: Timing, spawn: Spawner) -> Result<Arc<Server>> {
        ensure_dir(dir)?;
        let token = random_hex(32);
        let tp = token_path(dir, name);
        let _ = std::fs::remove_file(&tp);
        std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tp).and_then(|mut f| f.write_all(token.as_bytes())).with_context(|| format!("write {}", tp.display()))?;
        let mut socket = sock_path(dir, name);
        // A socket path must fit sockaddr_un (104 bytes on macOS).
        if socket.as_os_str().len() > 100 {
            socket = std::env::temp_dir().join(format!("coool-host-{name}.sock"));
        }
        let _ = std::fs::remove_file(&socket);
        // The folder is 0700, so the moment before the chmod exposes nothing (a umask would be process-wide).
        let listener = UnixListener::bind(&socket).with_context(|| format!("bind {}", socket.display()))?;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
        let hf = HostFile { name: name.into(), pid: std::process::id(), version: version.into(), protocol: PROTOCOL, socket: socket.clone() };
        let jp = json_path(dir, name);
        std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&jp).and_then(|mut f| f.write_all(serde_json::to_string(&hf)?.as_bytes()))?;
        let srv = Arc::new(Server {
            dir: dir.to_path_buf(),
            name: name.into(),
            socket,
            version: version.into(),
            token,
            timing,
            spawn,
            draining: AtomicBool::new(false),
            chats: Mutex::new(HashMap::new()),
            next_id: AtomicUsize::new(0),
            clients: AtomicUsize::new(0),
            last_client: Mutex::new(Instant::now()),
            done: AtomicBool::new(false),
        });
        {
            let srv = srv.clone();
            thread::Builder::new().name("chat-host accept".into()).spawn(move || {
                for c in listener.incoming() {
                    if srv.done.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(c) = c else { continue };
                    let s = srv.clone();
                    let _ = thread::Builder::new().name("chat-host conn".into()).spawn(move || s.serve(c));
                }
            })?;
        }
        {
            let srv = srv.clone();
            thread::Builder::new().name("chat-host tick".into()).spawn(move || {
                while !srv.done.load(Ordering::SeqCst) {
                    thread::sleep(srv.timing.tick);
                    srv.tick();
                }
            })?;
        }
        Ok(srv)
    }

    pub fn socket(&self) -> &Path {
        &self.socket
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// The host decided to exit (idle, or drained).
    pub fn is_done(&self) -> bool {
        self.done.load(Ordering::SeqCst)
    }

    /// Removes the host's files and stops accepting (the process exits after).
    pub fn shutdown(&self) {
        self.done.store(true, Ordering::SeqCst);
        remove_files(&self.dir, &self.name, &self.socket);
        // Unblock the accept loop.
        let _ = UnixStream::connect(&self.socket);
    }

    /// Stops every chat (tests; a host never does this on its own).
    pub fn stop_all(&self) {
        for hc in self.chats.lock().unwrap_or_else(|e| e.into_inner()).values_mut() {
            hc.chat.stop();
        }
    }

    fn handle(&self, key: &str) -> Option<ChatHandle> {
        self.chats.lock().unwrap_or_else(|e| e.into_inner()).get(key).map(|h| h.chat.handle())
    }

    fn tick(&self) {
        let now = Instant::now();
        let clients = self.clients.load(Ordering::SeqCst);
        let mut chats = self.chats.lock().unwrap_or_else(|e| e.into_inner());
        for hc in chats.values_mut() {
            hc.chat.escalate_kill(None);
            if !hc.chat.is_running() {
                hc.exited_at.get_or_insert(now);
                continue;
            }
            let st = hc.chat.state();
            if clients > 0 || st == ChatState::Working {
                hc.idle_since = None;
                continue;
            }
            let since = *hc.idle_since.get_or_insert(now);
            let limit = if st == ChatState::WaitingPermission { self.timing.waiting_stop } else { self.timing.idle_stop };
            if now.duration_since(since) >= limit {
                hc.chat.handle().note("coool was closed and this chat sat idle, so it was stopped. Resume it from its transcript.");
                hc.chat.stop();
                hc.idle_since = None;
            }
        }
        let keep = self.timing.exited_keep;
        chats.retain(|_, hc| hc.exited_at.is_none_or(|t| now.duration_since(t) < keep));
        let none_running = !chats.values().any(|hc| hc.chat.is_running());
        drop(chats);
        let idle_for = now.duration_since(*self.last_client.lock().unwrap_or_else(|e| e.into_inner()));
        if none_running && ((clients == 0 && idle_for >= self.timing.idle_exit) || self.draining.load(Ordering::SeqCst)) {
            self.shutdown();
        }
    }

    fn serve(self: Arc<Self>, stream: UnixStream) {
        if !peer_is_me(&stream) {
            return;
        }
        let Ok(out) = stream.try_clone() else { return };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut rd = BufReader::new(stream);
        let mut hello = String::new();
        let ok = rd.read_line(&mut hello).is_ok() && {
            let v: Value = serde_json::from_str(hello.trim()).unwrap_or_default();
            v["op"] == "hello" && v["token"].as_str().is_some_and(|t| same(t, &self.token)) && v["protocol"].as_u64() == Some(PROTOCOL as u64)
        };
        let conn = Arc::new(Conn { out: Mutex::new(out), attached: Mutex::new(HashMap::new()), asks: Mutex::new(Vec::new()), alive: AtomicBool::new(true) });
        if !ok {
            write_line(&conn.out, &json!({"id": 0, "ok": false, "error": "refused: not a coool app of this user (bad token or protocol)"}));
            return;
        }
        let _ = rd.get_ref().set_read_timeout(None);
        let hello = Hello { protocol: PROTOCOL, version: self.version.clone(), pid: std::process::id(), draining: self.draining.load(Ordering::SeqCst) };
        if !write_line(&conn.out, &json!({"id": 0, "ok": true, "result": hello})) {
            return;
        }
        self.clients.fetch_add(1, Ordering::SeqCst);
        {
            let (srv, conn) = (self.clone(), conn.clone());
            let _ = thread::Builder::new().name("chat-host pump".into()).spawn(move || srv.pump(&conn));
        }
        let mut line = String::new();
        loop {
            line.clear();
            match rd.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let Ok(req) = serde_json::from_str::<Value>(line.trim()) else { continue };
            let id = req["id"].clone();
            // A start (its CLI being spawned) runs beside the rest: the app's calls to its other chats never wait
            // behind it. Every other call stays in order (a chat's send before its interrupt).
            if req["op"] == "start" {
                let (srv, conn) = (self.clone(), conn.clone());
                let _ = thread::Builder::new().name("chat-host start".into()).spawn(move || {
                    let reply = match srv.request(&conn, &req) {
                        Ok(r) => json!({"id": id, "ok": true, "result": r}),
                        Err(e) => json!({"id": id, "ok": false, "error": format!("{e:#}")}),
                    };
                    write_line(&conn.out, &reply);
                });
                continue;
            }
            let reply = match self.request(&conn, &req) {
                Ok(r) => json!({"id": id, "ok": true, "result": r}),
                Err(e) => json!({"id": id, "ok": false, "error": format!("{e:#}")}),
            };
            if !write_line(&conn.out, &reply) {
                break;
            }
        }
        conn.alive.store(false, Ordering::SeqCst);
        // coool's own requests this app asked can't be answered to it any more.
        for (key, rid) in conn.asks.lock().unwrap_or_else(|e| e.into_inner()).drain(..) {
            if let Some(h) = self.handle(&key) {
                h.withdraw(&rid, "coool was closed before you answered; the agent was told to try again.");
            }
        }
        *self.last_client.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        self.clients.fetch_sub(1, Ordering::SeqCst);
    }

    /// Sends each attached chat's new events, in order, to one connection. A slow reader slows only this.
    fn pump(&self, conn: &Conn) {
        while conn.alive.load(Ordering::SeqCst) && !self.done.load(Ordering::SeqCst) {
            let attached: Vec<(String, u64)> = conn.attached.lock().unwrap_or_else(|e| e.into_inner()).iter().map(|(k, v)| (k.clone(), *v)).collect();
            let mut sent = false;
            for (key, since) in attached {
                let Some(h) = self.handle(&key) else {
                    // The chat is gone (ended long ago): nothing more will come.
                    conn.attached.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
                    continue;
                };
                let (evs, _) = h.events_since(since);
                let Some(last) = evs.last().map(|e| e.seq) else { continue };
                for chunk in evs.chunks(CHUNK) {
                    if !write_line(&conn.out, &json!({"push": "events", "chat": key, "events": chunk})) {
                        conn.alive.store(false, Ordering::SeqCst);
                        return;
                    }
                }
                sent = true;
                if let Some(c) = conn.attached.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&key) {
                    *c = (*c).max(last);
                }
            }
            if !sent {
                thread::sleep(Duration::from_millis(15));
            }
        }
    }

    fn request(&self, conn: &Arc<Conn>, req: &Value) -> Result<Value> {
        let key = || req["chat"].as_str().map(str::to_string).context("no chat given");
        match req["op"].as_str().unwrap_or("") {
            "ping" => Ok(json!("pong")),
            "start" => {
                if self.draining.load(Ordering::SeqCst) {
                    bail!("this host is draining: start new chats in a newer one");
                }
                let r: StartReq = serde_json::from_value(req["req"].clone()).context("bad start request")?;
                let id = self.next_id.fetch_add(1, Ordering::SeqCst);
                let chat = (self.spawn)(id, &r, None)?;
                let key = uuid_v4();
                let hc = HostChat { chat, opts: r.opts, mcp: r.mcp, client_name: r.client_name, ladder_root: r.ladder_root, meta: r.meta, started_ms: now_ms(), idle_since: None, exited_at: None };
                let e = hc.entry(&key);
                self.chats.lock().unwrap_or_else(|e| e.into_inner()).insert(key, hc);
                Ok(serde_json::to_value(e)?)
            }
            "list" => {
                let chats = self.chats.lock().unwrap_or_else(|e| e.into_inner());
                let mut l: Vec<Entry> = chats.iter().map(|(k, h)| h.entry(k)).collect();
                l.sort_by_key(|e| e.started_ms);
                Ok(serde_json::to_value(l)?)
            }
            "attach" => {
                let k = key()?;
                if self.handle(&k).is_none() {
                    bail!("no such chat {k}");
                }
                conn.attached.lock().unwrap_or_else(|e| e.into_inner()).insert(k, req["since"].as_u64().unwrap_or(0));
                Ok(Value::Null)
            }
            "detach" => {
                conn.attached.lock().unwrap_or_else(|e| e.into_inner()).remove(&key()?);
                Ok(Value::Null)
            }
            "set_meta" => {
                let k = key()?;
                let mut chats = self.chats.lock().unwrap_or_else(|e| e.into_inner());
                chats.get_mut(&k).with_context(|| format!("no such chat {k}"))?.meta = req["meta"].clone();
                Ok(Value::Null)
            }
            "drain" => {
                self.draining.store(true, Ordering::SeqCst);
                Ok(Value::Null)
            }
            "call" => {
                let k = key()?;
                let call: Call = serde_json::from_value(req["call"].clone()).context("bad call")?;
                self.call(conn, &k, call)
            }
            op => bail!("unknown op {op:?}"),
        }
    }

    fn call(&self, conn: &Arc<Conn>, key: &str, call: Call) -> Result<Value> {
        // The handle's calls don't need the chat itself (and must not hold the map: an answer may come meanwhile).
        match call {
            Call::Note { text } => {
                self.handle(key).with_context(|| format!("no such chat {key}"))?.note(&text);
                return Ok(Value::Null);
            }
            Call::Withdraw { request_id, note } => {
                self.handle(key).with_context(|| format!("no such chat {key}"))?.withdraw(&request_id, &note);
                conn.asks.lock().unwrap_or_else(|e| e.into_inner()).retain(|(_, r)| *r != request_id);
                return Ok(Value::Null);
            }
            Call::Ask { tool, summary, input, remember } => {
                let h = self.handle(key).with_context(|| format!("no such chat {key}"))?;
                let (rid, rx) = h.ask(&tool, &summary, input, remember).context("the chat has ended")?;
                conn.asks.lock().unwrap_or_else(|e| e.into_inner()).push((key.to_string(), rid.clone()));
                let (conn, key, r) = (conn.clone(), key.to_string(), rid.clone());
                thread::spawn(move || {
                    let Ok(a) = rx.recv() else { return };
                    conn.asks.lock().unwrap_or_else(|e| e.into_inner()).retain(|(_, x)| *x != r);
                    if conn.alive.load(Ordering::SeqCst) {
                        write_line(&conn.out, &json!({"push": "answer", "chat": key, "request_id": r, "answer": a}));
                    }
                });
                return Ok(json!(rid));
            }
            // Waits for the CLI to exit: never with the map held (every other chat's events and calls need it).
            Call::Restart => return self.restart(key),
            _ => {}
        }
        let mut chats = self.chats.lock().unwrap_or_else(|e| e.into_inner());
        let c = &mut chats.get_mut(key).with_context(|| format!("no such chat {key}"))?.chat;
        match call {
            Call::Send { text, attachments } => c.send_with(&text, &attachments).map(|_| Value::Null),
            Call::Steer { text, now, attachments } => c.steer_with(&text, now, &attachments).map(Value::String),
            Call::CancelSteer { note_id } => c.cancel_steer(&note_id).map(|_| Value::Null),
            Call::Interrupt => c.interrupt().map(|_| Value::Null),
            Call::SetModel { model } => c.set_model(&model).map(|_| Value::Null),
            Call::SetPermissionMode { mode } => c.set_permission_mode(&mode).map(|_| Value::Null),
            Call::RespondPermission { request_id, allow, always } => c.respond_permission(&request_id, allow, always).map(|_| Value::Null),
            Call::RespondPermissionRemember { request_id, remember } => c.respond_permission_remember(&request_id, &remember).map(|_| Value::Null),
            Call::RespondQuestion { request_id, answers } => c.respond_question(&request_id, &answers).map(|_| Value::Null),
            Call::Stop => {
                c.stop();
                Ok(Value::Null)
            }
            Call::Note { .. } | Call::Withdraw { .. } | Call::Ask { .. } | Call::Restart => unreachable!("handled above"),
        }
    }

    /// [`Call::Restart`]: stop the CLI, wait for it to exit, start it again resuming its conversation, in the same
    /// chat (same key, events numbered on).
    fn restart(&self, key: &str) -> Result<Value> {
        let lock_chats = || self.chats.lock().unwrap_or_else(|e| e.into_inner());
        let (handle, req, id) = {
            let mut chats = lock_chats();
            let hc = chats.get_mut(key).with_context(|| format!("no such chat {key}"))?;
            let opts = hc.chat.restart_options(Some(&hc.opts))?;
            hc.chat.stop();
            let req = StartReq { opts, client_name: hc.client_name.clone(), mcp: hc.mcp.clone(), ladder_root: hc.ladder_root.clone(), meta: hc.meta.clone() };
            (hc.chat.handle(), req, hc.chat.id)
        };
        wait_exit(&handle, || {
            if let Some(hc) = lock_chats().get_mut(key) {
                hc.chat.escalate_kill(Some(Duration::ZERO));
            }
        })?;
        let chat = (self.spawn)(id, &req, Some(&handle))?;
        let mut chats = lock_chats();
        let hc = chats.get_mut(key).with_context(|| format!("no such chat {key}"))?;
        let mut chat = chat;
        chat.carry_over(&hc.chat);
        hc.chat = chat;
        hc.opts = req.opts;
        hc.exited_at = None;
        hc.idle_since = None;
        Ok(serde_json::to_value(hc.entry(key))?)
    }
}

/// `coool --coool-chat-host <dir>`: runs a host until it is idle or drained. `version`: coool's version.
pub fn run(dir: &Path, version: &str) -> i32 {
    let name = std::process::id().to_string();
    // A self-test's host can be told to take its time with each start (a slow or stuck host, debug builds only).
    let stall = std::env::var("COOOL_TEST_HOST_STALL_MS").ok().and_then(|v| v.parse::<u64>().ok()).filter(|_| cfg!(debug_assertions) && test_dir_ok(dir)).map(Duration::from_millis);
    let spawn: Spawner = Arc::new(move |id, r: &StartReq, reuse: Option<&ChatHandle>| {
        if let Some(d) = stall {
            thread::sleep(d);
        }
        Chat::start_into(id, r.opts.clone(), &r.client_name, &r.mcp, r.ladder_root.as_deref(), reuse)
    });
    let srv = match Server::start(dir, &name, version, Timing::default(), spawn) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("coool chat host: {e:#}");
            return 1;
        }
    };
    eprintln!("coool chat host {version} (protocol {PROTOCOL}) serving {}", srv.socket.display());
    while !srv.is_done() {
        thread::sleep(Duration::from_millis(250));
    }
    eprintln!("coool chat host: no chats and no app; exiting");
    0
}

/// Starts a host for `dir` from coool's executable `exe`, detached (its own session, so it outlives the app and a
/// crash of it), and returns its file once it is serving.
/// `version`: the coool version the host reports (the app's own, so the app knows it as its own).
pub fn spawn_host(exe: &Path, dir: &Path, version: &str) -> Result<HostFile> {
    ensure_dir(dir)?;
    let log = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(dir.join("host.log"))?;
    let mut cmd = Command::new(exe);
    cmd.arg(FLAG).arg(dir).arg(version).stdin(Stdio::null()).stdout(log.try_clone()?).stderr(log);
    // SAFETY: setsid is async-signal-safe and only detaches the child from our session and process group.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = cmd.spawn().with_context(|| format!("start {}", exe.display()))?;
    let pid = child.id();
    // Reaped here if it exits while this process lives; launchd adopts it after we exit.
    thread::spawn(move || {
        let _ = child.wait();
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Some(h) = hosts(dir).into_iter().find(|h| h.pid == pid) {
            return Ok(h);
        }
        if !pid_alive(pid) {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    bail!("the chat host didn't start (see {})", dir.join("host.log").display())
}

// ---------------------------------------------------------------- the app's side

/// An app's connection to one host.
pub struct Client {
    pub hello: Hello,
    pub file: Option<HostFile>,
    out: Mutex<UnixStream>,
    pending: Mutex<HashMap<u64, mpsc::Sender<std::result::Result<Value, String>>>>,
    next: AtomicU64,
    mirrors: Mutex<HashMap<String, Arc<Mutex<Shared>>>>,
    answers: Mutex<HashMap<String, mpsc::Sender<ExternalAnswer>>>,
    alive: AtomicBool,
}

impl Client {
    /// Connects to the host of `hf` in `dir` (its token from its 0600 file).
    pub fn open(dir: &Path, hf: &HostFile, client: &str) -> Result<Arc<Client>> {
        let token = std::fs::read_to_string(token_path(dir, &hf.name)).context("read the host's token")?;
        Self::connect_as(&hf.socket, token.trim(), client, Some(hf.clone()))
    }

    /// Connects to a host's socket with its token.
    pub fn connect(socket: &Path, token: &str, client: &str) -> Result<Arc<Client>> {
        Self::connect_as(socket, token, client, None)
    }

    fn connect_as(socket: &Path, token: &str, client: &str, file: Option<HostFile>) -> Result<Arc<Client>> {
        let s = UnixStream::connect(socket).with_context(|| format!("connect {}", socket.display()))?;
        let out = s.try_clone()?;
        writeln!(&s, "{}", json!({"op": "hello", "token": token, "protocol": PROTOCOL, "client": client}))?;
        let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
        let mut rd = BufReader::new(s);
        let mut l = String::new();
        rd.read_line(&mut l).context("the host didn't answer")?;
        let v: Value = serde_json::from_str(l.trim()).context("the host's answer")?;
        if v["ok"] != true {
            bail!("{}", v["error"].as_str().unwrap_or("refused"));
        }
        let hello: Hello = serde_json::from_value(v["result"].clone())?;
        let _ = rd.get_ref().set_read_timeout(None);
        let c = Arc::new(Client {
            hello,
            file,
            out: Mutex::new(out),
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            mirrors: Mutex::new(HashMap::new()),
            answers: Mutex::new(HashMap::new()),
            alive: AtomicBool::new(true),
        });
        let weak = Arc::downgrade(&c);
        thread::Builder::new().name("chat-host client".into()).spawn(move || Self::read(weak, rd))?;
        Ok(c)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    fn read(c: std::sync::Weak<Client>, mut rd: BufReader<UnixStream>) {
        let mut l = String::new();
        loop {
            l.clear();
            match rd.read_line(&mut l) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let Some(c) = c.upgrade() else { return };
            let Ok(v) = serde_json::from_str::<Value>(l.trim()) else { continue };
            match v["push"].as_str() {
                Some("events") => {
                    let key = v["chat"].as_str().unwrap_or("");
                    let m = c.mirrors.lock().unwrap_or_else(|e| e.into_inner()).get(key).cloned();
                    if let (Some(m), Some(evs)) = (m, v["events"].as_array()) {
                        let mut sh = lock(&m);
                        for e in evs {
                            if let Ok(e) = serde_json::from_value::<ChatEvent>(e.clone()) {
                                sh.push_mirror(e);
                            }
                        }
                    }
                }
                Some("answer") => {
                    let rid = v["request_id"].as_str().unwrap_or("");
                    if let (Some(tx), Ok(a)) = (c.answers.lock().unwrap_or_else(|e| e.into_inner()).remove(rid), serde_json::from_value::<ExternalAnswer>(v["answer"].clone())) {
                        let _ = tx.send(a);
                    }
                }
                _ => {
                    if let Some(id) = v["id"].as_u64()
                        && let Some(tx) = c.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id)
                    {
                        let r = if v["ok"] == true { Ok(v["result"].clone()) } else { Err(v["error"].as_str().unwrap_or("the host refused").to_string()) };
                        let _ = tx.send(r);
                    }
                }
            }
        }
        let Some(c) = c.upgrade() else { return };
        c.gone();
    }

    /// The host is gone (it crashed or was killed): its CLIs went with it. Each chat ends as resumable.
    fn gone(&self) {
        self.alive.store(false, Ordering::SeqCst);
        for (_, tx) in self.pending.lock().unwrap_or_else(|e| e.into_inner()).drain() {
            let _ = tx.send(Err("coool's chat host stopped".into()));
        }
        self.answers.lock().unwrap_or_else(|e| e.into_inner()).clear();
        for m in self.mirrors.lock().unwrap_or_else(|e| e.into_inner()).values() {
            let mut sh = lock(m);
            if !sh.running {
                continue;
            }
            for kind in [
                ChatEventKind::notice(NoticeLevel::Error, "coool's chat host stopped unexpectedly, and this chat's CLI with it. Resume the chat from its transcript."),
                ChatEventKind::State { state: ChatState::Idle },
                ChatEventKind::Exited { code: None },
            ] {
                let seq = sh.next_seq + 1;
                sh.push_mirror(ChatEvent { seq, ts: now_ms(), kind });
            }
        }
    }

    fn request(&self, op: Value) -> Result<Value> {
        if !self.is_alive() {
            bail!("coool's chat host is gone");
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
        let mut op = op;
        op["id"] = json!(id);
        if !write_line(&self.out, &op) {
            self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            bail!("coool's chat host is gone");
        }
        match rx.recv_timeout(REPLY_WAIT) {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(anyhow::anyhow!(e)),
            Err(_) => {
                self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                bail!("coool's chat host didn't answer")
            }
        }
    }

    pub fn ping(&self) -> Result<()> {
        self.request(json!({"op": "ping"})).map(|_| ())
    }

    pub fn start(&self, req: &StartReq) -> Result<Entry> {
        Ok(serde_json::from_value(self.request(json!({"op": "start", "req": req}))?)?)
    }

    pub fn list(&self) -> Result<Vec<Entry>> {
        Ok(serde_json::from_value(self.request(json!({"op": "list"}))?)?)
    }

    pub fn drain(&self) -> Result<()> {
        self.request(json!({"op": "drain"})).map(|_| ())
    }

    pub fn set_meta(&self, key: &str, meta: Value) -> Result<()> {
        self.request(json!({"op": "set_meta", "chat": key, "meta": meta})).map(|_| ())
    }

    pub fn call(&self, key: &str, call: &Call) -> Result<Value> {
        self.request(json!({"op": "call", "chat": key, "call": call}))
    }

    /// Asks the host for coool's own permission request in a chat; the answer comes on the receiver.
    pub(crate) fn ask(&self, key: &str, tool: &str, summary: &str, input: Value, remember: Vec<RememberOption>) -> Option<(String, mpsc::Receiver<ExternalAnswer>)> {
        let rid = self.call(key, &Call::Ask { tool: tool.into(), summary: summary.into(), input, remember }).ok()?.as_str()?.to_string();
        let (tx, rx) = mpsc::channel();
        self.answers.lock().unwrap_or_else(|e| e.into_inner()).insert(rid.clone(), tx);
        Some((rid, rx))
    }

    /// Drops chat `key`'s mirror and detaches from it (see [`Chat::host_forget`]). Never waits for the host.
    pub(super) fn forget(&self, key: &str) {
        self.mirrors.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
        // The answer has no one waiting for it (the reader drops it).
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        write_line(&self.out, &json!({"op": "detach", "chat": key, "id": id}));
    }

    /// The app's copy of chat `key`'s events: made (and attached from the start) on first use.
    pub(super) fn mirror(&self, key: &str, info: &ChatInfo) -> Arc<Mutex<Shared>> {
        let mut ms = self.mirrors.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(m) = ms.get(key) {
            return m.clone();
        }
        let m = Arc::new(Mutex::new(Shared::mirror(info)));
        ms.insert(key.to_string(), m.clone());
        drop(ms);
        if self.request(json!({"op": "attach", "chat": key, "since": 0})).is_err() {
            // Gone already: say so in the chat rather than leave it looking alive.
            let mut sh = lock(&m);
            if sh.running {
                let seq = sh.next_seq + 1;
                sh.push_mirror(ChatEvent { seq, ts: now_ms(), kind: ChatEventKind::Exited { code: None } });
            }
        }
        m
    }
}

impl Drop for Client {
    /// Closes the connection (the reader thread holds the other end of it).
    fn drop(&mut self) {
        let _ = self.out.lock().unwrap_or_else(|e| e.into_inner()).shutdown(std::net::Shutdown::Both);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static N: AtomicUsize = AtomicUsize::new(0);

    fn dir(tag: &str) -> PathBuf {
        let d = PathBuf::from(format!("/tmp/coool-host-test-{}-{tag}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn timing() -> Timing {
        Timing { idle_exit: Duration::from_secs(3600), idle_stop: Duration::from_secs(3600), waiting_stop: Duration::from_secs(3600), exited_keep: Duration::from_secs(3600), tick: Duration::from_millis(50) }
    }

    /// A stand-in CLI: `script` (sh) as a "Claude" chat. Its plain-text lines become `notice` events, so they are easy
    /// to count; the backend's own first writes (initialize) go to its stdin.
    fn host(tag: &str, script: &'static str, t: Timing) -> (PathBuf, Arc<Server>) {
        let d = dir(tag);
        let spawn: Spawner = Arc::new(move |id, r: &StartReq, reuse: Option<&ChatHandle>| {
            let b = Box::new(claude::Claude::new(&r.opts));
            Chat::spawn_into(id, Provider::Claude, &r.opts.cwd, "/bin/sh", &["-c".to_string(), script.to_string()], &[], None, b, reuse)
        });
        let s = Server::start(&d, "t", "9.9.9", t, spawn).unwrap();
        (d, s)
    }

    fn req() -> StartReq {
        StartReq { opts: ChatOptions { provider: Provider::Claude, cwd: "/tmp".into(), resume: None, model: None, permission_mode: None, ladder: None, context: None, account: None }, client_name: "test".into(), mcp: vec![], ladder_root: None, meta: json!({"helper": {"parent": "x"}}) }
    }

    fn client(s: &Server) -> Arc<Client> {
        Client::connect(s.socket(), s.token(), "test").unwrap()
    }

    /// A start the host takes its time over (its CLI slow to spawn, a stuck host) holds neither the app's hub (the
    /// refresher, the window's quit counts) nor the app's calls to its other hosted chats.
    #[test]
    fn a_slow_start_holds_up_nothing_else() {
        let d = dir("slow");
        let spawn: Spawner = Arc::new(move |id, r: &StartReq, _: Option<&ChatHandle>| {
            if r.opts.cwd == "/private/tmp" {
                thread::sleep(Duration::from_millis(2000));
            }
            let b = Box::new(claude::Claude::new(&r.opts));
            Chat::spawn(id, Provider::Claude, &r.opts.cwd, "/bin/sh", &["-c".to_string(), "sleep 30".to_string()], &[], None, b)
        });
        let s = Server::start(&d, "t", "9.9.9", timing(), spawn).unwrap();
        let hub = Arc::new(Mutex::new(crate::hub::Hub::for_test(&d.join("home"))));
        hub.lock().unwrap().set_host(Some(client(&s)));
        let first = crate::hub::Hub::start_chat_in(&hub, req().opts).unwrap();
        assert!(hub.lock().unwrap().chat(first).unwrap().is_hosted());
        let h2 = hub.clone();
        let slow = thread::spawn(move || {
            let mut o = req().opts;
            o.cwd = "/private/tmp".into();
            crate::hub::Hub::start_chat_in(&h2, o)
        });
        thread::sleep(Duration::from_millis(300));
        let t = Instant::now();
        let proxy = hub.lock().unwrap().chat(first).unwrap().host_proxy().unwrap();
        assert!(t.elapsed() < Duration::from_millis(300), "the hub waited for the slow start: {:?}", t.elapsed());
        let t = Instant::now();
        proxy.set_meta(json!({"probe": 1}));
        assert!(t.elapsed() < Duration::from_millis(500), "a call to another chat waited for the slow start: {:?}", t.elapsed());
        let second = slow.join().unwrap().unwrap();
        assert_ne!(first, second);
        assert!(hub.lock().unwrap().chat(second).unwrap().is_hosted());
        hub.lock().unwrap().kill_all();
    }

    /// The notice texts of a mirror, in order.
    fn lines(m: &Arc<Mutex<Shared>>) -> Vec<String> {
        lock(m).events.iter().filter_map(|e| if let ChatEventKind::Notice { text, .. } = &e.kind { Some(text.clone()) } else { None }).filter(|t| t.starts_with("line")).collect()
    }

    fn seqs(m: &Arc<Mutex<Shared>>) -> Vec<u64> {
        lock(m).events.iter().map(|e| e.seq).collect()
    }

    fn wait_until(what: &str, f: impl Fn() -> bool) {
        let t = Instant::now();
        while !f() {
            assert!(t.elapsed() < Duration::from_secs(15), "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn contiguous(s: &[u64]) -> bool {
        s.windows(2).all(|w| w[1] == w[0] + 1)
    }

    fn cleanup(d: &Path, s: &Server) {
        s.stop_all();
        s.shutdown();
        thread::sleep(Duration::from_millis(100));
        let _ = std::fs::remove_dir_all(d);
    }

    const COUNT: &str = "i=1; while [ $i -le 200 ]; do echo line$i; i=$((i+1)); done; sleep 30";

    #[test]
    fn files_are_private_and_found() {
        let (d, s) = host("files", COUNT, timing());
        let mode = |p: PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(d.clone()), 0o700);
        assert_eq!(mode(token_path(&d, "t")), 0o600);
        assert_eq!(mode(sock_path(&d, "t")), 0o600);
        let found = hosts(&d);
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].version.as_str(), found[0].protocol, found[0].pid), ("9.9.9", PROTOCOL, std::process::id()));
        let c = Client::open(&d, &found[0], "test").unwrap();
        assert_eq!(c.hello.version, "9.9.9");
        assert!(test_dir_ok(&d) && !test_dir_ok(Path::new("/Users/x/Library/coool")) && !test_dir_ok(Path::new("/tmp/coool-host-x/../../etc")));
        cleanup(&d, &s);
    }

    #[test]
    fn refuses_a_client_without_the_token() {
        let (d, s) = host("auth", COUNT, timing());
        let e = Client::connect(s.socket(), "0000", "intruder").err().expect("refused");
        assert!(format!("{e:#}").contains("refused"), "{e:#}");
        // Not even a hello: any request first is refused, and the connection closes.
        let mut raw = UnixStream::connect(s.socket()).unwrap();
        writeln!(raw, "{}", json!({"op": "list", "id": 1})).unwrap();
        let mut l = String::new();
        BufReader::new(raw.try_clone().unwrap()).read_line(&mut l).unwrap();
        assert!(l.contains("refused"), "{l}");
        let mut rest = String::new();
        assert_eq!(BufReader::new(raw).read_line(&mut rest).unwrap(), 0, "closed after the refusal");
        // The wrong protocol is refused too.
        let mut raw = UnixStream::connect(s.socket()).unwrap();
        writeln!(raw, "{}", json!({"op": "hello", "token": s.token(), "protocol": 999})).unwrap();
        let mut l = String::new();
        BufReader::new(raw).read_line(&mut l).unwrap();
        assert!(l.contains("refused"), "{l}");
        // The real token works.
        client(&s).ping().unwrap();
        cleanup(&d, &s);
    }

    #[test]
    fn replays_from_the_start_and_from_a_cursor_then_streams() {
        let (d, s) = host("replay", "i=1; while [ $i -le 50 ]; do echo line$i; i=$((i+1)); done; read x; echo line-after-send; sleep 30", timing());
        let c = client(&s);
        let e = c.start(&req()).unwrap();
        assert!(e.pid.is_some());
        let m = c.mirror(&e.key, &e.info);
        wait_until("50 lines", || lines(&m).len() >= 50);
        // A second client attaches later, from a cursor in the middle.
        let c2 = client(&s);
        let mid = seqs(&m)[20];
        let m2 = Arc::new(Mutex::new(Shared::mirror(&e.info)));
        lock(&m2).next_seq = mid;
        c2.mirrors.lock().unwrap().insert(e.key.clone(), m2.clone());
        c2.request(json!({"op": "attach", "chat": e.key, "since": mid})).unwrap();
        wait_until("replay from the cursor", || lock(&m2).next_seq >= lock(&m).next_seq);
        assert_eq!(lock(&m2).events.front().unwrap().seq, mid + 1, "starts right after the cursor");
        assert!(contiguous(&seqs(&m2)) && contiguous(&seqs(&m)));
        // Live: a send reaches the CLI and its answer reaches both.
        c.call(&e.key, &Call::Send { text: "go".into(), attachments: vec![] }).unwrap();
        wait_until("live line on both", || lines(&m).contains(&"line-after-send".into()) && lines(&m2).contains(&"line-after-send".into()));
        assert!(contiguous(&seqs(&m)) && contiguous(&seqs(&m2)), "no gap, no duplicate");
        cleanup(&d, &s);
    }

    #[test]
    fn a_lost_connection_misses_nothing() {
        let (d, s) = host("lost", "i=1; while [ $i -le 400 ]; do echo line$i; i=$((i+1)); sleep 0.005; done; sleep 30", timing());
        let c = client(&s);
        let e = c.start(&req()).unwrap();
        let m = c.mirror(&e.key, &e.info);
        wait_until("some lines", || lines(&m).len() >= 20);
        // The app goes away mid-stream (as at a quit or a crash): the CLI keeps running and its output is kept.
        let pid = e.pid.unwrap();
        drop(m);
        drop(c);
        thread::sleep(Duration::from_millis(300));
        assert!(pid_alive(pid), "the CLI is still running with no app attached");
        // A new app attaches from 0 and gets everything, then the rest live.
        let c = client(&s);
        let l = c.list().unwrap();
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].meta, json!({"helper": {"parent": "x"}}), "the app's record comes back");
        let m = c.mirror(&l[0].key, &l[0].info);
        wait_until("all 400 lines", || lines(&m).len() >= 400);
        let got = lines(&m);
        assert_eq!(got, (1..=400).map(|i| format!("line{i}")).collect::<Vec<_>>());
        assert!(contiguous(&seqs(&m)));
        assert_eq!(lock(&m).events.front().unwrap().seq, 1);
        cleanup(&d, &s);
    }

    #[test]
    fn a_slow_reader_catches_up_and_slows_no_one_else() {
        let (d, s) = host("slow", "i=1; while [ $i -le 3000 ]; do echo line$i-padding-padding-padding-padding-padding-padding-padding; i=$((i+1)); done; sleep 30", timing());
        let c = client(&s);
        let e = c.start(&req()).unwrap();
        // A raw client that attaches and doesn't read for a while.
        let mut raw = UnixStream::connect(s.socket()).unwrap();
        writeln!(raw, "{}", json!({"op": "hello", "token": s.token(), "protocol": PROTOCOL})).unwrap();
        writeln!(raw, "{}", json!({"op": "attach", "id": 1, "chat": e.key, "since": 0})).unwrap();
        // Meanwhile the normal client gets everything promptly.
        let m = c.mirror(&e.key, &e.info);
        wait_until("the fast reader has all", || lines(&m).len() >= 3000);
        thread::sleep(Duration::from_millis(300));
        // Now the slow one reads: every event, in order, once.
        let mut rd = BufReader::new(raw);
        let mut seen: Vec<u64> = Vec::new();
        let want = lock(&m).next_seq;
        let mut l = String::new();
        while seen.last().copied().unwrap_or(0) < want {
            l.clear();
            assert!(rd.read_line(&mut l).unwrap() > 0);
            let v: Value = serde_json::from_str(l.trim()).unwrap();
            if v["push"] == "events" {
                seen.extend(v["events"].as_array().unwrap().iter().map(|e| e["seq"].as_u64().unwrap()));
            }
        }
        assert_eq!(seen.first(), Some(&1));
        assert!(contiguous(&seen), "no gap or duplicate for the slow reader");
        cleanup(&d, &s);
    }

    #[test]
    fn two_apps_get_every_event_and_calls_from_either_work() {
        let (d, s) = host("two", "while read x; do echo \"line $(printf %s \"$x\" | cut -c1-12)\"; done", timing());
        let (a, b) = (client(&s), client(&s));
        let e = a.start(&req()).unwrap();
        let (ma, mb) = (a.mirror(&e.key, &e.info), b.mirror(&e.key, &e.info));
        a.call(&e.key, &Call::Send { text: "from a".into(), attachments: vec![] }).unwrap();
        b.call(&e.key, &Call::Send { text: "from b".into(), attachments: vec![] }).unwrap();
        wait_until("both see both", || lines(&ma).len() >= 2 && lines(&mb).len() >= 2);
        thread::sleep(Duration::from_millis(100));
        assert_eq!(seqs(&ma), seqs(&mb), "the same events, the same numbers");
        // coool's own request (the device gate's): asked by a, answered by b, the answer goes to a.
        let (rid, rx) = a.ask(&e.key, "iphone_tap", "Tap", json!({}), vec![]).unwrap();
        wait_until("b sees the request", || lock(&mb).events.iter().any(|x| matches!(&x.kind, ChatEventKind::PermissionRequest { request_id, .. } if *request_id == rid)));
        assert_eq!(lock(&mb).state, ChatState::WaitingPermission);
        b.call(&e.key, &Call::RespondPermission { request_id: rid.clone(), allow: true, always: false }).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), ExternalAnswer::Allow);
        // A request whose asker goes away is withdrawn.
        let (rid2, _rx2) = a.ask(&e.key, "iphone_tap", "Tap", json!({}), vec![]).unwrap();
        drop(ma);
        drop(a);
        wait_until("withdrawn", || lock(&mb).state != ChatState::WaitingPermission);
        assert!(b.call(&e.key, &Call::RespondPermission { request_id: rid2, allow: true, always: false }).is_err(), "nothing left to answer");
        cleanup(&d, &s);
    }

    #[test]
    fn a_host_that_dies_ends_its_chats_as_resumable() {
        let (d, s) = host("dies", COUNT, timing());
        let c = client(&s);
        let e = c.start(&req()).unwrap();
        let m = c.mirror(&e.key, &e.info);
        wait_until("lines", || lines(&m).len() >= 10);
        // Simulate the host process going: every connection closes.
        s.done.store(true, Ordering::SeqCst);
        c.gone();
        let sh = lock(&m);
        assert!(!sh.running);
        assert!(sh.events.iter().any(|e| matches!(&e.kind, ChatEventKind::Notice { text, .. } if text.contains("Resume the chat"))));
        assert!(matches!(sh.events.back().unwrap().kind, ChatEventKind::Exited { .. }));
        drop(sh);
        s.done.store(false, Ordering::SeqCst);
        cleanup(&d, &s);
    }

    #[test]
    fn draining_refuses_new_chats_and_ends_with_the_last() {
        let (d, s) = host("drain", "read x; echo line-bye", timing());
        let c = client(&s);
        let e = c.start(&req()).unwrap();
        c.drain().unwrap();
        assert!(c.start(&req()).is_err(), "no new chats while draining");
        assert!(!s.is_done(), "its chat still runs");
        c.call(&e.key, &Call::Send { text: "end".into(), attachments: vec![] }).unwrap();
        wait_until("the host exits after its last chat", || s.is_done());
        assert!(hosts(&d).is_empty(), "its files are gone");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_idle_host_with_no_app_exits_and_stops_idle_chats() {
        let t = Timing { idle_exit: Duration::from_millis(300), idle_stop: Duration::from_millis(300), waiting_stop: Duration::from_secs(3600), exited_keep: Duration::from_secs(3600), tick: Duration::from_millis(50) };
        let (d, s) = host("idle", "sleep 60", t);
        let c = client(&s);
        let e = c.start(&req()).unwrap();
        let pid = e.pid.unwrap();
        thread::sleep(Duration::from_millis(500));
        assert!(pid_alive(pid) && !s.is_done(), "an app is attached: nothing is stopped");
        drop(c);
        wait_until("the idle chat is stopped and the host exits", || s.is_done());
        wait_until("the CLI is gone", || !pid_alive(pid));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Restart (a chat's Restart button, `/restart`): the host stops the CLI and starts it again in the same chat. The
    /// old process is gone, the new one runs, and the app's mirror goes on with the same numbering; through the hub,
    /// the chat keeps its id.
    #[test]
    fn a_restart_starts_the_cli_again_in_the_same_chat() {
        let (d, s) = host("restart", "echo line-up-$$; sleep 30", timing());
        let c = client(&s);
        let e = c.start(&req()).unwrap();
        let m = c.mirror(&e.key, &e.info);
        let old = e.pid.unwrap();
        wait_until("the first start", || lines(&m) == [format!("line-up-{old}")]);
        let after: Entry = serde_json::from_value(c.call(&e.key, &Call::Restart).unwrap()).unwrap();
        let new = after.pid.unwrap();
        assert_eq!(after.key, e.key, "the same chat");
        assert_ne!(old, new, "a new process");
        assert!(!pid_alive(old), "the old CLI is gone");
        wait_until("the new start in the same mirror", || lines(&m) == [format!("line-up-{old}"), format!("line-up-{new}")]);
        {
            let sh = lock(&m);
            assert!(sh.running, "running again");
            let kinds: Vec<&ChatEventKind> = sh.events.iter().map(|e| &e.kind).collect();
            let exited = kinds.iter().position(|k| matches!(k, ChatEventKind::Exited { .. })).expect("the old CLI's exit");
            let restarted = kinds.iter().position(|k| matches!(k, ChatEventKind::Restarted)).expect("restarted");
            assert!(exited < restarted);
        }
        assert!(contiguous(&seqs(&m)), "no gap, no duplicate");
        // Through the hub: the same chat id, its new process.
        let hub = Arc::new(Mutex::new(crate::hub::Hub::for_test(&d.join("home"))));
        hub.lock().unwrap().set_host(Some(c.clone()));
        let id = crate::hub::Hub::start_chat_in(&hub, req().opts).unwrap();
        let p1 = hub.lock().unwrap().chat(id).unwrap().pid.unwrap();
        crate::hub::Hub::restart_chat_in(&hub, id).unwrap();
        let h = hub.lock().unwrap();
        let ch = h.chat(id).unwrap();
        let p2 = ch.pid.unwrap();
        assert!(ch.is_hosted() && ch.is_running() && p1 != p2 && !pid_alive(p1), "restarted in the host: {p1} -> {p2}");
        assert!(!h.is_restarting(id));
        drop(h);
        cleanup(&d, &s);
    }

    #[test]
    fn events_round_trip() {
        let e = ChatEvent { seq: 3, ts: 9, kind: ChatEventKind::UserMessage { id: "u1".into(), text: "hi".into(), steer: false, note_id: None, attachments: vec![] } };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v, json!({"seq": 3, "ts": 9, "type": "user_message", "id": "u1", "text": "hi", "steer": false, "note_id": null}));
        let back: ChatEvent = serde_json::from_value(v).unwrap();
        assert_eq!(back.kind, e.kind);
        let call = Call::RespondPermission { request_id: "r".into(), allow: true, always: false };
        assert_eq!(serde_json::from_value::<Call>(serde_json::to_value(&call).unwrap()).unwrap(), call);
    }
}
