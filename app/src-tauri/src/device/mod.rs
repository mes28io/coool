//! Devices in the right panel: the iOS Simulator (APP_SPEC "iPhone panel"). Phase 2 adds a sandboxed Mac VM.
//!
//! - [`simctl`]: lifecycle (`xcrun simctl`), headless — Simulator.app is never opened.
//! - [`helper`]: one `coool-sim` helper process per booted device: live frames, touch / buttons / keyboard, the
//!   accessibility tree, all through the simulator's own frameworks (no idb, nothing downloaded).
//! - [`observe`]: the tree as compact text with short stable element ids, for agents.
//! - [`mcp`]: the `coool-device` MCP server every chat coool starts gets, bound to that chat's panel device.
//! - [`web`]: that server's `browser_*` tools, which drive the chat's Browser panel.
//! - [`pilot`]: that server's `pilot_run`, a fast loop that drives the iPhone, the Browser panel or the Mac to a goal.
//! - [`vm`]: the sandboxed Mac (a Virtualization.framework guest) behind the Mac panel and the `mac_*` tools.
//!
//! The panel and the chat's agent share one device: what the agent does is what the person sees (`sim-activity`
//! events draw it on the panel).

pub mod gate;
pub mod helper;
pub mod mcp;
pub mod observe;
pub mod pilot;
pub mod presence;
pub mod simctl;
pub mod vm;
pub mod web;

use helper::{Helper, Screen};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

type Res<T> = Result<T, String>;

#[derive(Default)]
struct Inner {
    helpers: HashMap<String, Arc<Helper>>,
    /// chat id -> the device its panel shows (and its agent drives).
    bindings: HashMap<usize, String>,
    /// Devices coool booted this run: shut down again when coool quits.
    booted: HashSet<String>,
    /// Device names, for observation headers.
    names: HashMap<String, String>,
}

#[derive(Default)]
pub struct Devices {
    inner: Mutex<Inner>,
    app: OnceLock<AppHandle>,
    bin_dir: OnceLock<PathBuf>,
    next_stream: AtomicU64,
    /// Serializes boots / device creation (two chats asking at once get one device, booted once).
    boot_lock: Mutex<()>,
    pub mcp: mcp::Mcp,
    /// Each chat's browser panel tabs, for the `browser_*` tools.
    pub web: web::Web,
    /// The sandboxed Mac (one VM, shared by the chats that use it), for the Mac panel and the `mac_*` tools.
    pub vm: vm::Vm,
    /// The permission gate every action of an agent passes (device/gate.rs).
    pub gate: gate::Gate,
    /// coool's "Reduce motion" (the frontend reports it): the page cursors in the Browser panel don't glide.
    reduce_motion: std::sync::atomic::AtomicBool,
}

/// What the panel draws for an action: the actor's cursor gliding to `x`,`y` (a swipe on to `x2`,`y2`), its label, and
/// the beam around the frame (APP_SPEC "Agent presence"). Sent just before the action starts, so the cursor travels
/// while it lands. `actor`, `by`, `decider` and `provider` are filled in by [`Devices::activity`].
#[derive(Clone, Debug, Serialize, Default)]
pub struct Activity {
    pub udid: String,
    pub chat: Option<usize>,
    pub source: &'static str,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x2: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y2: Option<f64>,
    /// What it acts on (an element's name), or for `press` the key, for `app` the action.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// For `type`: the text (dots for a secret field).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// One cursor per actor (see [`presence::Actor::key`]).
    pub actor: String,
    /// `agent` or `pilot`.
    pub by: &'static str,
    /// For a pilot step: `memory` or `haiku`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decider: Option<&'static str>,
    /// The chat's provider (`claude`, `codex`), when coool started it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<&'static str>,
}

impl Devices {
    /// Called once from the app's setup: where the helper lives, and the MCP socket.
    pub fn init(self: &Arc<Self>, app: &AppHandle) {
        self.init_in(app, app.path().app_local_data_dir().ok());
    }

    /// As [`Self::init`], with the helper and socket under `dir` (the self-test's throwaway folder, so a test build
    /// never replaces the helper the person's coool runs).
    pub fn init_in(self: &Arc<Self>, app: &AppHandle, dir: Option<PathBuf>) {
        let _ = self.app.set(app.clone());
        if let Some(d) = dir {
            let _ = self.bin_dir.set(d.join("bin"));
            self.gate.set_store(d.join("device-grants.json"));
            if let Err(e) = mcp::start(self.clone(), &d) {
                eprintln!("coool: device MCP server not started: {e}");
            }
        }
    }

    /// Without the UI (`coool --coool-device-serve <dir>`, for scripted tests of the MCP server): helper and socket
    /// under `dir`; prints the socket path and a token bound to chat 0, then serves until stdin closes.
    pub fn serve_headless(dir: &std::path::Path) -> i32 {
        let devices = Arc::new(Devices::default());
        let _ = devices.bin_dir.set(dir.join("bin"));
        if let Err(e) = mcp::start(devices.clone(), dir) {
            eprintln!("{e}");
            return 1;
        }
        let token = devices.mcp.token_for(0);
        println!("{}", json!({ "socket": devices.mcp.socket(), "token": token }));
        let mut sink = String::new();
        while std::io::stdin().read_line(&mut sink).map(|n| n > 0).unwrap_or(false) {
            sink.clear();
        }
        mcp::cleanup(&devices);
        devices.shutdown_all();
        0
    }

    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        if let Some(app) = self.app.get() {
            let _ = app.emit_to("main", event, payload);
        }
    }

    /// Whether the gate may ask in this chat now (its mode asks): callers do extra work only then.
    pub fn gate_asks(&self, chat: usize) -> bool {
        self.gate.mode(chat) != gate::Mode::Free
    }

    /// The gate's say on an action of `chat`'s agent that changes something (see [`gate::Gate::check`]).
    pub fn gate_check(&self, chat: usize, act: gate::Act) -> Res<()> {
        if !self.gate_asks(chat) {
            return Ok(());
        }
        self.gate.check(chat, self.mcp.cwd(chat).as_deref(), act)
    }

    pub fn activity(&self, mut a: Activity) {
        let who = presence::current();
        a.actor = who.key(a.chat);
        a.by = who.by();
        a.decider = who.decider;
        a.provider = a.chat.and_then(|c| self.mcp.provider(c));
        self.emit("sim-activity", a);
    }

    fn state(&self, udid: &str, state: &str) {
        self.emit("sim-state", json!({ "udid": udid, "state": state }));
    }

    pub fn reduce_motion(&self) -> bool {
        self.reduce_motion.load(Ordering::Relaxed)
    }

    pub fn name(&self, udid: &str) -> String {
        if let Some(n) = self.inner.lock().unwrap().names.get(udid) {
            return n.clone();
        }
        let n = simctl::device(udid).map(|d| format!("{} ({}, {})", d.name, d.device_type, d.runtime)).unwrap_or_else(|_| "iPhone".into());
        self.inner.lock().unwrap().names.insert(udid.to_string(), n.clone());
        n
    }

    /// The running helper for a booted device, started on first use.
    pub fn helper(&self, udid: &str) -> Res<Arc<Helper>> {
        if let Some(h) = self.inner.lock().unwrap().helpers.get(udid).filter(|h| h.alive()) {
            return Ok(h.clone());
        }
        let dir = self.bin_dir.get().ok_or("not ready")?;
        let bin = helper::install(dir)?;
        let dev = developer_dir();
        let h = Helper::spawn(&bin, udid, dev.as_deref())?;
        if let Err(e) = h.screen(Duration::from_secs(15)) {
            h.kill();
            return Err(e);
        }
        let mut inner = self.inner.lock().unwrap();
        // Another caller may have started one meanwhile: keep the first.
        if let Some(other) = inner.helpers.get(udid).filter(|o| o.alive()) {
            h.kill();
            return Ok(other.clone());
        }
        inner.helpers.insert(udid.to_string(), h.clone());
        Ok(h)
    }

    /// coool's own folder for device things (the helper, the pilot's memory): the app's data folder, or the
    /// self-test's throwaway one.
    pub fn data_dir(&self) -> Option<PathBuf> {
        self.bin_dir.get().and_then(|b| b.parent()).map(|p| p.to_path_buf())
    }

    pub fn screen(&self, udid: &str) -> Res<Screen> {
        self.helper(udid)?.screen(Duration::from_secs(1))
    }

    pub fn boot(&self, udid: &str) -> Res<()> {
        let _g = self.boot_lock.lock().unwrap();
        let d = simctl::device(udid)?;
        if d.state == "Booted" {
            return Ok(());
        }
        self.state(udid, "Booting");
        let r = simctl::boot(udid);
        if r.is_ok() {
            self.inner.lock().unwrap().booted.insert(udid.to_string());
        }
        self.state(udid, if r.is_ok() { "Booted" } else { &d.state });
        r
    }

    pub fn shutdown(&self, udid: &str) -> Res<()> {
        if let Some(h) = self.inner.lock().unwrap().helpers.remove(udid) {
            h.kill();
        }
        self.state(udid, "Shutting Down");
        let r = simctl::shutdown(udid);
        self.inner.lock().unwrap().booted.remove(udid);
        self.state(udid, if r.is_ok() { "Shutdown" } else { "Booted" });
        r
    }

    pub fn bind(&self, chat: usize, udid: Option<String>) {
        let mut inner = self.inner.lock().unwrap();
        match udid {
            Some(u) => inner.bindings.insert(chat, u),
            None => inner.bindings.remove(&chat),
        };
    }

    pub fn bound(&self, chat: usize) -> Option<String> {
        self.inner.lock().unwrap().bindings.get(&chat).cloned()
    }

    /// The device a chat's agent acts on: its panel's, else coool's own (created and booted as needed), which then
    /// becomes the chat's (the panel follows through `sim-activity`).
    pub fn device_for_chat(&self, chat: usize) -> Res<String> {
        // Hot path: a live helper means the device is booted (no simctl round trip, ~100 ms).
        if let Some(u) = self.bound(chat)
            && self.inner.lock().unwrap().helpers.get(&u).is_some_and(|h| h.alive())
        {
            return Ok(u);
        }
        let udid = match self.bound(chat) {
            Some(u) => u,
            None => {
                let u = {
                    let _g = self.boot_lock.lock().unwrap();
                    simctl::ensure_coool_device()?
                };
                self.bind(chat, Some(u.clone()));
                u
            }
        };
        self.boot(&udid)?;
        Ok(udid)
    }

    /// Shuts down what coool booted (on quit), and stops every helper.
    pub fn shutdown_all(&self) {
        let (helpers, booted): (Vec<_>, Vec<_>) = {
            let mut inner = self.inner.lock().unwrap();
            (inner.helpers.drain().map(|(_, h)| h).collect(), inner.booted.drain().collect())
        };
        for h in helpers {
            h.kill();
        }
        std::thread::scope(|s| {
            // The Mac shuts down gracefully meanwhile (its helper asks the guest, then forces it off after 20 s).
            s.spawn(|| self.vm.quit());
            let threads: Vec<_> = booted.into_iter().map(|u| std::thread::spawn(move || simctl::shutdown(&u))).collect();
            let deadline = Instant::now() + Duration::from_secs(8);
            for t in threads {
                while !t.is_finished() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        });
    }
}

/// The selected Xcode (`xcode-select -p`), for the helper's SimulatorKit lookup.
fn developer_dir() -> Option<String> {
    static DIR: OnceLock<Option<String>> = OnceLock::new();
    DIR.get_or_init(|| {
        let out = std::process::Command::new("xcode-select").arg("-p").output().ok()?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!s.is_empty()).then_some(s)
    })
    .clone()
}

// ---- Tauri commands (the panel) ----

#[derive(Serialize)]
pub struct SimList {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    devices: Vec<simctl::SimDevice>,
}

#[tauri::command(async)]
pub fn sim_devices() -> Res<SimList> {
    if let Some(reason) = simctl::unavailable() {
        return Ok(SimList { available: false, reason: Some(reason), devices: Vec::new() });
    }
    Ok(SimList { available: true, reason: None, devices: simctl::devices()? })
}

#[tauri::command(async)]
pub fn sim_ensure_device(devices: State<'_, Arc<Devices>>) -> Res<String> {
    let _g = devices.boot_lock.lock().unwrap();
    simctl::ensure_coool_device()
}

#[tauri::command(async)]
pub fn sim_boot(devices: State<'_, Arc<Devices>>, udid: String) -> Res<()> {
    devices.boot(&udid)
}

#[tauri::command(async)]
pub fn sim_shutdown(devices: State<'_, Arc<Devices>>, udid: String) -> Res<()> {
    devices.shutdown(&udid)
}

#[derive(Serialize)]
pub struct Attached {
    w: f64,
    h: f64,
    scale: f64,
    stream: u64,
}

/// Streams the device's screen to the panel as JPEG frames (raw bytes on `frames`) until `sim_detach`.
#[tauri::command(async)]
pub fn sim_attach(devices: State<'_, Arc<Devices>>, udid: String, frames: Channel<InvokeResponseBody>) -> Res<Attached> {
    let h = devices.helper(&udid)?;
    let s = h.screen(Duration::from_secs(1))?;
    let stream = devices.next_stream.fetch_add(1, Ordering::SeqCst) + 1;
    h.add_sink(
        stream,
        Box::new(move |jpeg| {
            let _ = frames.send(InvokeResponseBody::Raw(jpeg));
        }),
    )?;
    Ok(Attached { w: s.w, h: s.h, scale: s.scale, stream })
}

#[tauri::command(async)]
pub fn sim_detach(devices: State<'_, Arc<Devices>>, udid: String, stream: u64) {
    let h = devices.inner.lock().unwrap().helpers.get(&udid).cloned();
    if let Some(h) = h {
        h.remove_sink(stream);
    }
}

/// The person's own input from the panel.
#[tauri::command(async)]
pub fn sim_input(devices: State<'_, Arc<Devices>>, udid: String, input: Value) -> Res<()> {
    let h = devices.helper(&udid)?;
    let t = Duration::from_secs(5);
    match input["kind"].as_str().unwrap_or("") {
        "touch" => h.call(json!({ "cmd": "touch", "phase": input["phase"], "x": input["x"], "y": input["y"] }), t)?,
        "button" => h.call(json!({ "cmd": "button", "name": input["name"] }), t)?,
        "key" => h.call(json!({ "cmd": "key", "name": input["name"], "modifiers": input["modifiers"] }), t)?,
        "text" => return type_text(&devices, &udid, input["text"].as_str().unwrap_or("")),
        k => return Err(format!("unknown input {k:?}")),
    };
    Ok(())
}

/// Types text: through the hardware keyboard when every character has a key (US layout), else pasted.
pub fn type_text(devices: &Devices, udid: &str, text: &str) -> Res<()> {
    if text.is_empty() {
        return Ok(());
    }
    let h = devices.helper(udid)?;
    let typable = text.chars().all(|c| c.is_ascii() && (!c.is_ascii_control() || c == '\n' || c == '\t'));
    if typable {
        h.call(json!({ "cmd": "text", "text": text }), Duration::from_secs(30))?;
    } else {
        simctl::pbcopy(udid, text)?;
        h.call(json!({ "cmd": "key", "name": "v", "modifiers": ["command"] }), Duration::from_secs(5))?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn sim_bind(devices: State<'_, Arc<Devices>>, chat: usize, udid: Option<String>) {
    devices.bind(chat, udid);
}

/// The frontend's "Reduce motion" (Settings, the system, the device), for what the backend draws itself.
#[tauri::command]
pub fn presence_motion(devices: State<'_, Arc<Devices>>, reduce: bool) {
    devices.reduce_motion.store(reduce, Ordering::Relaxed);
}
