//! The sandboxed Mac (APP_SPEC "Mac panel (sandbox VM)"): a macOS guest on Apple's Virtualization.framework, shown
//! in the right panel and driven by agents through the `mac_*` tools of the `coool-device` MCP server.
//!
//! - `native/coool-vm.m` (the host helper, one process for coool's one VM folder): install, boot, frames, the
//!   VM's own USB keyboard and pointer, OCR, and a vsock bridge to the guest agent.
//! - `native/coool-vm-agent.m` (the guest agent, installed into the guest on its first boot): the accessibility
//!   tree, launching apps, the pasteboard, running a command.
//! - here: the VM's lifecycle, its first-run setup (guest account, the agent, the Accessibility grant), the panel's
//!   Tauri commands and the agent tools.
//!
//! There is one VM, coool's base Mac, in `<app data>/vm` (`COOOL_VM_DIR` overrides it); every chat that uses the Mac
//! panel or the `mac_*` tools shares it, as the person's screen is shared.

use super::helper::{self, Helper};
use super::observe::{self, Tree};
use super::{Activity, Devices};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Emitter, State};

type Res<T> = Result<T, String>;

static VM_HELPER: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/coool-vm"));
static DEBUG_SHOT: AtomicU64 = AtomicU64::new(0);
static VM_AGENT: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/coool-vm-agent"));

/// The Mac's id in `sim-activity` events (the panel tells it from simulators by this).
pub const UDID: &str = "mac";
/// The guest agent's build: setup reinstalls it (and re-grants Accessibility) when this changes.
const AGENT_VERSION: &str = "5";
/// Bytes that must stay free after the restore image is downloaded: the install (~19 GB) plus a margin.
const INSTALL_RESERVE: u64 = 25_000_000_000;
/// What marks an alert about coool's agent (its executable's name, or its bundle's): the background-activity alerts
/// [`Vm::dismiss_agent_alerts`] closes.
const AGENT_ALERT_MATCH: [&str; 2] = ["coool-vm-agent", "coool agent"];
/// The guest's account (created by Apple's guest provisioning on first boot). Its password is random per VM.
const GUEST_USER: &str = "coool";
pub const SHARED_IN_GUEST: &str = "/Volumes/My Shared Files";

pub fn vm_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("COOOL_VM_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join("sh.coool.app").join("vm")
}

pub fn shared_dir() -> PathBuf {
    vm_dir().join("Shared")
}

/// Why this Mac can't run the sandbox Mac, if it can't.
pub fn unavailable() -> Option<String> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Some("The sandbox Mac needs a Mac with Apple silicon.".into());
    }
    if VM_HELPER.is_empty() || VM_AGENT.is_empty() {
        return Some("This build of coool has no sandbox Mac helper (it needs Xcode's command line tools to build).".into());
    }
    None
}

#[derive(Default)]
pub struct Vm {
    helper: Mutex<Option<Arc<Helper>>>,
    /// What the panel shows besides the helper's own status: the setup step, progress, the last error.
    status: Arc<Mutex<Value>>,
    /// Serializes install / boot / shutdown.
    op: Mutex<()>,
    /// The agent answered since the last boot.
    ready: Mutex<bool>,
    /// Chats whose panel shows the Mac or whose agent used it.
    chats: Mutex<HashSet<usize>>,
    /// Per chat: the last Mac screen it was shown (ids for `mac_click` and friends).
    last: Mutex<HashMap<usize, (Tree, String)>>,
    next_stream: AtomicU64,
}

fn emit_state(app: &Option<tauri::AppHandle>, status: &Arc<Mutex<Value>>, patch: Value) {
    {
        let mut s = status.lock().unwrap();
        if !s.is_object() {
            *s = json!({});
        }
        if let (Some(o), Some(p)) = (s.as_object_mut(), patch.as_object()) {
            for (k, v) in p {
                o.insert(k.clone(), v.clone());
            }
        }
    }
    if let Some(a) = app {
        let _ = a.emit_to("main", "mac-state", patch);
    }
}

impl Vm {
    fn app(&self, d: &Devices) -> Option<tauri::AppHandle> {
        d.app.get().cloned()
    }

    fn set(&self, d: &Devices, patch: Value) {
        emit_state(&self.app(d), &self.status, patch);
    }

    fn step(&self, d: &Devices, step: &str) {
        self.set(d, json!({ "state": "setting-up", "step": step }));
    }

    /// The helper process (started on first use; it doesn't boot the VM by itself).
    pub fn helper(&self, d: &Devices) -> Res<Arc<Helper>> {
        if let Some(r) = unavailable() {
            return Err(r);
        }
        let mut g = self.helper.lock().unwrap();
        if let Some(h) = g.as_ref().filter(|h| h.alive()) {
            return Ok(h.clone());
        }
        let bin_dir = d.bin_dir.get().cloned().unwrap_or_else(|| vm_dir().join("bin"));
        let bin = helper::install_bytes(&bin_dir, "coool-vm", VM_HELPER)?;
        let dir = vm_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(bin);
        cmd.arg(&dir);
        let app = self.app(d);
        let status = self.status.clone();
        let sink: helper::EventSink = Box::new(move |v: &Value| match v["event"].as_str() {
            Some("state") => {
                let st = v["state"].as_str().unwrap_or("stopped");
                // The guest stopped by itself (shut down from its menu): the agent is gone too.
                emit_state(&app, &status, json!({ "state": st, "vmState": st }));
            }
            Some("progress") => emit_state(&app, &status, json!({ "progress": v })),
            Some("network") => emit_state(&app, &status, json!({ "networkNow": v["networkNow"] })),
            Some("error") => emit_state(&app, &status, json!({ "error": v["error"] })),
            _ => {}
        });
        let h = Helper::spawn_cmd(cmd, "coool-vm", Some(sink))?;
        h.screen(Duration::from_secs(10))?;
        *g = Some(h.clone());
        Ok(h)
    }

    pub fn call(&self, d: &Devices, req: Value, timeout: Duration) -> Res<Value> {
        self.helper(d)?.call(req, timeout)
    }

    /// The helper's status plus coool's own (setup step, progress, error), for the panel.
    pub fn status(&self, d: &Devices) -> Value {
        if let Some(r) = unavailable() {
            return json!({ "available": false, "reason": r, "state": "absent", "installed": false, "provisioned": false, "w": 1280, "h": 800 });
        }
        let mut s = match self.call(d, json!({ "cmd": "status" }), Duration::from_secs(5)) {
            Ok(v) => v,
            Err(e) => return json!({ "available": false, "reason": e, "state": "absent", "installed": false, "provisioned": false, "w": 1280, "h": 800 }),
        };
        let mine = self.status.lock().unwrap().clone();
        let helper_state = s["state"].as_str().unwrap_or("stopped").to_string();
        if let Some(o) = s.as_object_mut() {
            o.insert("available".into(), json!(true));
            o.insert("sharedDir".into(), json!(shared_dir().to_string_lossy()));
            for k in ["progress", "step", "error"] {
                if let Some(v) = mine.get(k).filter(|v| !v.is_null()) {
                    o.insert(k.into(), v.clone());
                }
            }
            // While coool sets the guest up (or waits for its agent) the VM runs but isn't ready yet.
            if helper_state == "running" && mine["state"] == "setting-up" {
                o.insert("state".into(), json!("setting-up"));
            }
            if helper_state == "stopped" && o.get("installed") == Some(&json!(false)) {
                o.insert("state".into(), json!("absent"));
            }
        }
        s
    }

    fn installed(&self, d: &Devices) -> Res<(bool, bool, String)> {
        let s = self.call(d, json!({ "cmd": "status" }), Duration::from_secs(5))?;
        Ok((s["installed"] == true, s["provisioned"] == true, s["state"].as_str().unwrap_or("stopped").to_string()))
    }

    /// Downloads and installs macOS into the base Mac (once).
    pub fn install(&self, d: &Devices) -> Res<Value> {
        let _g = self.op.lock().unwrap();
        self.set(d, json!({ "error": null, "progress": null }));
        let r = self.call(
            d,
            json!({ "cmd": "install", "reserveBytes": INSTALL_RESERVE, "cpus": 4, "memoryMB": 6144, "diskGB": 40 }),
            Duration::from_secs(6 * 3600),
        );
        match &r {
            Ok(_) => self.set(d, json!({ "state": "stopped", "progress": null })),
            Err(e) => self.set(d, json!({ "state": "absent", "error": e, "progress": null })),
        }
        r
    }

    /// Boots the Mac and waits until its agent answers (setting the guest up on its first boot).
    pub fn boot(&self, d: &Devices) -> Res<String> {
        let _g = self.op.lock().unwrap();
        let t0 = Instant::now();
        let (installed, provisioned, state) = self.installed(d)?;
        if !installed {
            return Err("The sandbox Mac isn't installed yet: open the Mac panel (the Mac button in the chat header) and press Install (it downloads about 16 GB).".into());
        }
        if state == "running" && *self.ready.lock().unwrap() {
            return Ok("already running".into());
        }
        self.set(d, json!({ "error": null, "progress": null }));
        let secrets = Secrets::load_or_create(&vm_dir())?;
        let needs_setup = !provisioned || self.agent_version_stale();
        let network = network_setting();
        // coool's one-time setup reaches the guest over SSH from this computer: with the network off, that boot gets
        // the host-only network (this computer only, never the internet), unplugged again once setup is done.
        let setup_local = needs_setup && network == Network::Off && state != "running";
        if state != "running" {
            let mut req = json!({ "cmd": "start" });
            if setup_local {
                req["network"] = json!("local");
                self.step(d, "starting with the network on this computer only, for setup");
            }
            if !provisioned {
                // Apple's guest provisioning (macOS 27): the account, auto-login and SSH, with no Setup Assistant.
                req["provision"] = json!({ "fullName": "coool", "username": GUEST_USER, "password": secrets.password, "autoLogin": true, "ssh": true });
            }
            self.call(d, req, Duration::from_secs(120))?;
        }
        let mut r = if needs_setup { self.setup(d, &secrets) } else { self.wait_agent(d, Duration::from_secs(120)).map(|_| ()) };
        if setup_local && r.is_ok() {
            r = self.call(d, json!({ "cmd": "network", "mode": "off", "save": false }), Duration::from_secs(10)).map(|_| ());
        }
        match r {
            Ok(()) => {
                *self.ready.lock().unwrap() = true;
                self.dismiss_agent_alerts(d);
                self.set(d, json!({ "state": "running", "step": null }));
                Ok(format!("booted in {:.1} s", t0.elapsed().as_secs_f64()))
            }
            Err(e) => {
                self.set(d, json!({ "state": "running", "step": null, "error": e }));
                Err(e)
            }
        }
    }

    fn agent_version_stale(&self) -> bool {
        let cfg = std::fs::read(vm_dir().join("config.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).unwrap_or_default();
        cfg["agentVersion"].as_str() != Some(AGENT_VERSION)
    }

    /// Settings > Devices and the Mac panel: the network switch. Saved for the next boot, and applied now when the
    /// running Mac has a network device (`applies`: "now" or "next boot").
    pub fn set_network(&self, d: &Devices, mode: Network) -> Res<Value> {
        let r = self.call(d, json!({ "cmd": "network", "mode": mode.as_str() }), Duration::from_secs(10))?;
        self.set(d, json!({ "network": mode.as_str(), "networkNow": r["networkNow"] }));
        Ok(r)
    }

    pub fn shutdown(&self, d: &Devices) -> Res<()> {
        let _g = self.op.lock().unwrap();
        *self.ready.lock().unwrap() = false;
        self.call(d, json!({ "cmd": "stop", "timeout": 40 }), Duration::from_secs(60))?;
        self.set(d, json!({ "state": "stopped", "step": null }));
        Ok(())
    }

    /// On quit: the helper shuts the guest down when its stdin closes.
    pub fn quit(&self) {
        if let Some(h) = self.helper.lock().unwrap().take() {
            h.close(Duration::from_secs(35));
        }
    }

    /// A request to the guest agent.
    pub fn agent(&self, d: &Devices, req: Value, timeout: Duration) -> Res<Value> {
        self.call(d, json!({ "cmd": "agent", "request": req, "timeout": timeout.as_secs_f64() }), timeout + Duration::from_secs(8))
    }

    fn wait_agent(&self, d: &Devices, timeout: Duration) -> Res<Value> {
        let until = Instant::now() + timeout;
        loop {
            match self.agent(d, json!({ "cmd": "ping" }), Duration::from_secs(3)) {
                Ok(v) => return Ok(v),
                Err(e) if Instant::now() >= until => return Err(format!("the Mac's agent didn't answer: {e}")),
                Err(_) => std::thread::sleep(Duration::from_millis(700)),
            }
        }
    }

    /// The Mac, booted and ready, for an agent tool.
    pub fn ensure(&self, d: &Devices, chat: usize) -> Res<()> {
        self.chats.lock().unwrap().insert(chat);
        if *self.ready.lock().unwrap() && self.helper.lock().unwrap().as_ref().is_some_and(|h| h.alive()) {
            return Ok(());
        }
        self.boot(d).map(|_| ())
    }

    // ---- first-run setup ----

    /// After the first boot: wait for the provisioned guest, install the agent over SSH, grant it Accessibility.
    fn setup(&self, d: &Devices, secrets: &Secrets) -> Res<()> {
        self.step(d, "waiting for the guest to finish its first boot");
        let ip = self.wait_ssh(d, Duration::from_secs(20 * 60))?;
        let ssh = Ssh::new(&vm_dir(), &ip, secrets)?;
        self.step(d, "installing coool's agent in the guest");
        ssh.run("mkdir -p \"$HOME/Library/Application Support/coool\" && cat > \"$HOME/Library/Application Support/coool/agent.bin\"", Some(VM_AGENT), Duration::from_secs(60))?;
        let out = ssh.run("/bin/sh -s", Some(setup_script(&secrets.password, &ssh.public_key).as_bytes()), Duration::from_secs(120))?;
        if !out.contains("coool-setup-ok") {
            return Err(format!("guest setup failed: {}", out.chars().rev().take(600).collect::<String>().chars().rev().collect::<String>()));
        }
        self.step(d, "waiting for the agent");
        let ping = self.wait_agent(d, Duration::from_secs(60))?;
        if !truthy(&ping["trusted"]) {
            self.step(d, "granting the agent Accessibility in the guest");
            self.grant_accessibility(d, secrets)?;
        }
        self.call(d, json!({ "cmd": "markProvisioned", "agentVersion": AGENT_VERSION, "username": GUEST_USER }), Duration::from_secs(5))?;
        Ok(())
    }

    /// The guest's "App Background Activity: … can run in the background" alerts about coool's own agent stay on its
    /// screen across restarts until someone closes them, and macOS posts a new one at login whenever the agent's
    /// launch item looks new to it (before agent version 5 the launch item ran the agent's binary itself, so every
    /// agent build was a new item). Close them as the Mac comes up: the agent closes each through its own Close
    /// action, a few times over the first seconds after login (macOS restores them a moment after the session
    /// starts). The first pass before the boot returns (no alerts: a few ms), so the first look shows none; the later
    /// ones in the background.
    fn dismiss_agent_alerts(&self, d: &Devices) {
        let Ok(h) = self.helper(d) else { return };
        let req = json!({ "cmd": "agent", "request": { "cmd": "dismissNotifications", "match": AGENT_ALERT_MATCH }, "timeout": 10.0 });
        let note = |pass: usize, r: &Res<Value>| match r {
            Ok(v) if v["closed"].as_u64().unwrap_or(0) > 0 => eprintln!("coool-vm: closed {} agent alert(s) (pass {pass})", v["closed"]),
            Err(e) => eprintln!("coool-vm: closing agent alerts (pass {pass}): {e}"),
            _ => {}
        };
        note(0, &h.call(req.clone(), Duration::from_secs(14)));
        std::thread::spawn(move || {
            for (i, wait) in [1500u64, 2500, 4000, 7000].into_iter().enumerate() {
                std::thread::sleep(Duration::from_millis(wait));
                let r = h.call(req.clone(), Duration::from_secs(14));
                note(i + 1, &r);
                if r.is_err() && !h.alive() {
                    return;
                }
            }
        });
    }

    fn wait_ssh(&self, d: &Devices, timeout: Duration) -> Res<String> {
        let until = Instant::now() + timeout;
        loop {
            if let Ok(v) = self.call(d, json!({ "cmd": "ip" }), Duration::from_secs(5))
                && let Some(ip) = v["ip"].as_str()
                && let Ok(addr) = format!("{ip}:22").parse::<std::net::SocketAddr>()
                && std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok()
            {
                return Ok(ip.to_string());
            }
            if Instant::now() >= until {
                return Err("the guest didn't come up on the network (no SSH) in time".into());
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    }

    fn ocr(&self, d: &Devices) -> Res<Vec<(String, [f64; 4])>> {
        // The first recognition in a fresh helper loads Vision's models (tens of seconds).
        let r = self.call(d, json!({ "cmd": "ocr" }), Duration::from_secs(90))?;
        Ok(r["items"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|i| {
                        let f = |k: usize| i["frame"][k].as_f64().unwrap_or(0.0);
                        (i["text"].as_str().unwrap_or("").to_string(), [f(0), f(1), f(2), f(3)])
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    fn click(&self, d: &Devices, x: f64, y: f64) -> Res<()> {
        self.call(d, json!({ "cmd": "click", "x": x, "y": y }), Duration::from_secs(5)).map(|_| ())
    }

    /// The one privacy permission the agent needs. macOS lets only a person (real input) switch it on, so coool
    /// does what a person would, with the VM's own keyboard and pointer: open Privacy & Security > Accessibility in
    /// the guest, find the agent's row by reading the screen (OCR), switch it on, and type the guest's password.
    fn grant_accessibility(&self, d: &Devices, secrets: &Secrets) -> Res<()> {
        // The agent asking once puts it in the list (and shows the system's prompt, which we dismiss by opening
        // the pane ourselves).
        let _ = self.agent(d, json!({ "cmd": "prompt" }), Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(1200));
        let pane = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
        let mut opened = Instant::now() - Duration::from_secs(60);
        let until = Instant::now() + Duration::from_secs(150);
        let mut toggled_at: Option<Instant> = None;
        while Instant::now() < until {
            if self.agent(d, json!({ "cmd": "ping" }), Duration::from_secs(3)).is_ok_and(|p| truthy(&p["trusted"])) {
                let _ = self.agent(d, json!({ "cmd": "quitApp", "app": "com.apple.systempreferences" }), Duration::from_secs(3));
                return Ok(());
            }
            let words = self.ocr(d)?;
            if std::env::var_os("COOOL_VM_DEBUG").is_some() {
                let n = DEBUG_SHOT.fetch_add(1, Ordering::SeqCst);
                let _ = self.call(d, json!({ "cmd": "screenshot", "path": vm_dir().join(format!("setup-{n:03}.jpg")) }), Duration::from_secs(5));
                eprintln!("coool-vm setup {n}: {:?}", words.iter().map(|(w, f)| format!("{w}@{:.0},{:.0}", f[0], f[1])).collect::<Vec<_>>());
            }
            let find = |t: &str| words.iter().find(|(w, _)| w.to_lowercase().contains(&t.to_lowercase())).map(|(_, f)| *f);
            // The password sheet (after the switch): type the guest's password.
            if find("password").is_some() && (find("Modify Settings").is_some() || find("Cancel").is_some() || find("trying to").is_some()) {
                let _ = self.call(d, json!({ "cmd": "text", "text": secrets.password }), Duration::from_secs(10));
                let _ = self.call(d, json!({ "cmd": "key", "name": "return" }), Duration::from_secs(5));
                std::thread::sleep(Duration::from_millis(1500));
                continue;
            }
            // Notification banners (installing the agent posts "App Background Activity") stay on screen and can
            // cover the switch: swipe them away to the right.
            if let Some(f) = words.iter().find(|(w, f)| f[0] > 640.0 && f[1] < 300.0 && (w.contains("Background Activity") || w.contains("can run in the"))).map(|(_, f)| *f) {
                let (x, y) = (f[0] + 120.0, f[1] + 20.0);
                let _ = self.call(d, json!({ "cmd": "drag", "x": x, "y": y, "x2": x + 500.0, "y2": y, "ms": 250 }), Duration::from_secs(5));
                std::thread::sleep(Duration::from_millis(900));
                continue;
            }
            // The system's "would like to control this computer" prompt.
            if let Some(f) = find("Open System Settings") {
                self.click(d, f[0] + f[2] / 2.0, f[1] + f[3] / 2.0)?;
                opened = Instant::now();
                std::thread::sleep(Duration::from_millis(2000));
                continue;
            }
            let row = words.iter().find(|(w, _)| w.trim().eq_ignore_ascii_case("coool agent")).map(|(_, f)| *f);
            match row {
                Some(f) if toggled_at.is_none_or(|t| t.elapsed() > Duration::from_secs(5)) => {
                    // The switch at the row's right end (found in the picture), else a guess from the label.
                    let y = f[1] + f[3] / 2.0;
                    let sw = self.call(d, json!({ "cmd": "switchIn", "x": f[0] + f[2] + 8.0, "y": y }), Duration::from_secs(10)).ok();
                    if sw.as_ref().is_some_and(|v| v["on"] == true) {
                        // Switched on: a running process may keep its old answer, so restart the agent and ask again.
                        let _ = self.agent(d, json!({ "cmd": "run", "sh": "(sleep 0.3; launchctl kickstart -k gui/$(id -u)/sh.coool.vm-agent) >/dev/null 2>&1 &" }), Duration::from_secs(5));
                        std::thread::sleep(Duration::from_millis(1500));
                        let _ = self.wait_agent(d, Duration::from_secs(20));
                        toggled_at = Some(Instant::now());
                        continue;
                    }
                    // No switch found (the pane still drawing): look again rather than click blindly.
                    let Some(x) = sw.and_then(|v| v["x"].as_f64()) else {
                        std::thread::sleep(Duration::from_millis(700));
                        continue;
                    };
                    self.click(d, x, y)?;
                    toggled_at = Some(Instant::now());
                    std::thread::sleep(Duration::from_millis(1500));
                }
                Some(_) => std::thread::sleep(Duration::from_millis(500)),
                None if opened.elapsed() > Duration::from_secs(8) => {
                    self.agent(d, json!({ "cmd": "open", "url": pane }), Duration::from_secs(5))?;
                    opened = Instant::now();
                    std::thread::sleep(Duration::from_millis(2500));
                }
                None => std::thread::sleep(Duration::from_millis(700)),
            }
        }
        Err("couldn't switch on Accessibility for coool's agent in the guest (System Settings > Privacy & Security > Accessibility: switch on \"coool agent\")".into())
    }

    // ---- the panel ----

    pub fn attach(&self, d: &Devices, frames: Channel<InvokeResponseBody>) -> Res<Value> {
        let h = self.helper(d)?;
        let s = h.screen(Duration::from_secs(1))?;
        let stream = self.next_stream.fetch_add(1, Ordering::SeqCst) + 1;
        let first = {
            h.add_sink_with(
                stream,
                Box::new(move |jpeg| {
                    let _ = frames.send(InvokeResponseBody::Raw(jpeg));
                }),
                json!({ "cmd": "stream", "on": true, "fps": 15, "maxDim": 1280, "quality": 0.7 }),
            )
        };
        first?;
        Ok(json!({ "w": s.w, "h": s.h, "stream": stream }))
    }

    pub fn detach(&self, stream: u64) {
        if let Some(h) = self.helper.lock().unwrap().clone() {
            h.remove_sink(stream);
        }
    }

    fn remember(&self, chat: usize, tree: Tree, text: String) {
        self.last.lock().unwrap().insert(chat, (tree, text));
    }
}

// ---- guest secrets and SSH ----

/// The guest account's password (random per VM, only ever used inside the guest) and coool's SSH key for the
/// guest. Nothing of the host's goes in: no host keys, no agent forwarding, no keychain.
struct Secrets {
    password: String,
}

impl Secrets {
    fn load_or_create(dir: &Path) -> Res<Secrets> {
        let p = dir.join("guest.json");
        if let Some(pw) = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v["password"].as_str().map(String::from)) {
            return Ok(Secrets { password: pw });
        }
        let mut b = [0u8; 24];
        std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).map_err(|e| e.to_string())?;
        const A: &[u8] = b"abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXY2346789";
        let password: String = b.iter().map(|x| A[*x as usize % A.len()] as char).collect();
        write_private(&p, &serde_json::to_vec_pretty(&json!({ "username": GUEST_USER, "password": password })).unwrap())?;
        Ok(Secrets { password })
    }
}

fn write_private(p: &Path, bytes: &[u8]) -> Res<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(p).map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())
}

struct Ssh {
    ip: String,
    key: PathBuf,
    known: PathBuf,
    askpass: PathBuf,
    password: String,
    public_key: String,
}

impl Ssh {
    fn new(dir: &Path, ip: &str, secrets: &Secrets) -> Res<Ssh> {
        let sdir = dir.join("ssh");
        std::fs::create_dir_all(&sdir).map_err(|e| e.to_string())?;
        let key = sdir.join("id_ed25519");
        if !key.exists() {
            let ok = Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-C", "coool-vm", "-f"]).arg(&key).stdin(Stdio::null()).status();
            if !matches!(ok, Ok(s) if s.success()) {
                return Err("ssh-keygen failed".into());
            }
        }
        let public_key = std::fs::read_to_string(sdir.join("id_ed25519.pub")).map_err(|e| e.to_string())?.trim().to_string();
        let askpass = sdir.join("askpass");
        if !askpass.exists() {
            // Prints the password from the environment coool gives this ssh process (never written to disk here).
            std::fs::write(&askpass, "#!/bin/sh\nprintf '%s\\n' \"$COOOL_VM_PW\"\n").map_err(|e| e.to_string())?;
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&askpass, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        }
        Ok(Ssh { ip: ip.into(), key, known: sdir.join("known_hosts"), askpass, password: secrets.password.clone(), public_key })
    }

    fn run(&self, remote: &str, stdin: Option<&[u8]>, timeout: Duration) -> Res<String> {
        let mut cmd = Command::new("/usr/bin/ssh");
        cmd.args(["-F", "/dev/null", "-T", "-i"]).arg(&self.key);
        cmd.arg("-o").arg(format!("UserKnownHostsFile={}", self.known.display()));
        for o in [
            "StrictHostKeyChecking=accept-new",
            "IdentitiesOnly=yes",
            "IdentityAgent=none",
            "ForwardAgent=no",
            "ForwardX11=no",
            "ClearAllForwardings=yes",
            "PreferredAuthentications=publickey,password,keyboard-interactive",
            "NumberOfPasswordPrompts=1",
            "ConnectTimeout=8",
            "ServerAliveInterval=10",
            "LogLevel=ERROR",
        ] {
            cmd.args(["-o", o]);
        }
        cmd.arg(format!("{GUEST_USER}@{}", self.ip)).arg(remote);
        cmd.env("SSH_ASKPASS", &self.askpass).env("SSH_ASKPASS_REQUIRE", "force").env("DISPLAY", ":0").env("COOOL_VM_PW", &self.password);
        cmd.env_remove("SSH_AUTH_SOCK");
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("ssh: {e}"))?;
        let mut sin = child.stdin.take();
        let data = stdin.map(|b| b.to_vec());
        let writer = std::thread::spawn(move || {
            if let (Some(s), Some(d)) = (sin.as_mut(), data) {
                let _ = s.write_all(&d);
            }
            drop(sin);
        });
        let mut out = child.stdout.take().unwrap();
        let mut err = child.stderr.take().unwrap();
        let reader = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = out.read_to_string(&mut s);
            let mut e = String::new();
            let _ = err.read_to_string(&mut e);
            s + &e
        });
        let deadline = Instant::now() + timeout;
        let status = loop {
            if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
                break s;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err("ssh into the guest timed out".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let _ = writer.join();
        let text = reader.join().unwrap_or_default();
        if !status.success() {
            return Err(format!("ssh into the guest failed ({status}): {}", text.trim()));
        }
        Ok(text)
    }
}

/// Runs in the guest as its user, over SSH, on the first boot: installs the agent as an app bundle with a
/// LaunchAgent, authorizes coool's guest-only SSH key, and settles the guest for automation (no sleep, no screen
/// lock, typing exactly what is typed).
fn setup_script(password: &str, public_key: &str) -> String {
    format!(
        r#"set -e
# SSH answers before the auto-login session is up: wait for it (the Dock runs in it).
i=0; while ! pgrep -qxu "$(id -u)" Dock && [ $i -lt 240 ]; do sleep 0.5; i=$((i+1)); done
D="$HOME/Library/Application Support/coool"
APP="$D/coool agent.app"
mkdir -p "$APP/Contents/MacOS" "$HOME/Library/LaunchAgents" "$HOME/.ssh"
RESET=
codesign -d -r- "$APP" 2>&1 | grep -q 'designated => identifier "sh.coool.vm-agent"' || RESET=1
mv -f "$D/agent.bin" "$APP/Contents/MacOS/coool-vm-agent"
chmod 755 "$APP/Contents/MacOS/coool-vm-agent"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>sh.coool.vm-agent</string>
<key>CFBundleName</key><string>coool agent</string>
<key>CFBundleDisplayName</key><string>coool agent</string>
<key>CFBundleExecutable</key><string>coool-vm-agent</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>{AGENT_VERSION}</string>
<key>CFBundleVersion</key><string>{AGENT_VERSION}</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
# Ad-hoc signed with a designated requirement on the bundle id alone, so the Accessibility grant (which TCC keys on
# that requirement) survives agent updates. An install signed otherwise (by the build's hash) loses its grant.
codesign -s - -f -i sh.coool.vm-agent -r='designated => identifier "sh.coool.vm-agent"' "$APP" >/dev/null 2>&1
if [ -n "$RESET" ]; then tccutil reset Accessibility sh.coool.vm-agent >/dev/null 2>&1 || true; fi
# The job's program is /bin/sh, which execs the agent: macOS's Background Task Management keys a launch item on its
# program's code signature and posts a new "can run in the background" alert (kept on screen until dismissed) at the
# next login for every new signature, so an agent that ran itself made one per agent build. sh's never changes with
# ours. The agent process is still the agent (exec), with its own Accessibility grant.
PL="$HOME/Library/LaunchAgents/sh.coool.vm-agent.plist"
cat > "$PL" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>sh.coool.vm-agent</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>exec "\$0"</string><string>$APP/Contents/MacOS/coool-vm-agent</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>ProcessType</key><string>Interactive</string>
</dict></plist>
PLIST
# Loaded already (the session loads LaunchAgents at login): unload it, so the new build and job definition load.
launchctl bootout gui/$(id -u)/sh.coool.vm-agent >/dev/null 2>&1 || true
i=0; until launchctl bootstrap gui/$(id -u) "$PL" 2>/dev/null || [ $i -ge 20 ]; do sleep 0.5; i=$((i+1)); done
touch "$HOME/.ssh/authorized_keys"
grep -qF '{public_key}' "$HOME/.ssh/authorized_keys" || echo '{public_key}' >> "$HOME/.ssh/authorized_keys"
chmod 700 "$HOME/.ssh"; chmod 600 "$HOME/.ssh/authorized_keys"
for k in NSAutomaticSpellingCorrectionEnabled NSAutomaticCapitalizationEnabled NSAutomaticPeriodSubstitutionEnabled NSAutomaticQuoteSubstitutionEnabled NSAutomaticDashSubstitutionEnabled NSAutomaticTextCompletionEnabled NSAutomaticInlinePredictionEnabled WebAutomaticSpellingCorrectionEnabled; do defaults write -g $k -bool false; done
defaults -currentHost write com.apple.screensaver idleTime -int 0
set +e
# coool shuts the guest down cleanly through its agent (the power button only shows "Are you sure?").
printf '%s\n' '{password}' | sudo -S -p '' sh -c 'echo "{GUEST_USER} ALL=(root) NOPASSWD: /sbin/shutdown" > /etc/sudoers.d/coool && chmod 440 /etc/sudoers.d/coool' >/dev/null 2>&1
printf '%s\n' '{password}' | sudo -S -p '' pmset -a sleep 0 displaysleep 0 disksleep 0 powernap 0 >/dev/null 2>&1
sysadminctl -screenLock off -password '{password}' >/dev/null 2>&1
printf '%s\n' '{password}' | sudo -S -p '' defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticDownload -bool false >/dev/null 2>&1
printf '%s\n' '{password}' | sudo -S -p '' defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false >/dev/null 2>&1
echo coool-setup-ok
"#
    )
}

// ---- the network setting ----

/// The Mac's network: `On` (NAT: the internet and this computer), `Local` (host-only: this computer only), `Off` (no
/// network device). Kept in the VM folder's config.json (`network`), default On.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Network {
    On,
    Local,
    Off,
}

impl Network {
    pub fn parse(s: &str) -> Option<Network> {
        match s {
            "on" => Some(Network::On),
            "local" => Some(Network::Local),
            "off" => Some(Network::Off),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Network::On => "on",
            Network::Local => "local",
            Network::Off => "off",
        }
    }
    /// The one line of plain truth the panel and Settings show.
    pub fn truth(self) -> &'static str {
        match self {
            Network::On => "The Mac reaches the internet and this computer's network services. Anything in its shared folder can leave this computer.",
            Network::Local => "The Mac reaches only this computer (a dev server here, for example), not the internet. coool's own tools work.",
            Network::Off => "The Mac has no network at all: nothing in it, or in its shared folder, can leave through it. coool's own tools still work.",
        }
    }
}

/// The saved setting (config.json `network`; On when unset).
pub fn network_setting() -> Network {
    network_in(&vm_dir())
}

fn network_in(dir: &Path) -> Network {
    std::fs::read(dir.join("config.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v["network"].as_str().and_then(Network::parse)).unwrap_or(Network::On)
}

// ---- Tauri commands (the panel) ----

/// The network switch: `mode` sets it (on, local, off); answers `{ network, networkNow?, applies, truth }`.
#[tauri::command(async)]
pub fn mac_network(devices: State<'_, Arc<Devices>>, mode: Option<String>) -> Res<Value> {
    let mut r = match mode {
        Some(m) => {
            let n = Network::parse(&m).ok_or("network is on, local or off")?;
            devices.vm.set_network(&devices, n)?
        }
        None => {
            let s = devices.vm.status(&devices);
            json!({ "network": s["network"].as_str().unwrap_or(network_setting().as_str()), "networkNow": s["networkNow"] })
        }
    };
    let n = r["network"].as_str().and_then(Network::parse).unwrap_or(Network::On);
    r["truth"] = json!(n.truth());
    Ok(r)
}

#[tauri::command(async)]
pub fn mac_status(devices: State<'_, Arc<Devices>>) -> Value {
    devices.vm.status(&devices)
}

#[tauri::command(async)]
pub fn mac_install(devices: State<'_, Arc<Devices>>) -> Res<Value> {
    devices.vm.install(&devices)
}

#[tauri::command(async)]
pub fn mac_boot(devices: State<'_, Arc<Devices>>) -> Res<String> {
    devices.vm.boot(&devices)
}

#[tauri::command(async)]
pub fn mac_shutdown(devices: State<'_, Arc<Devices>>) -> Res<()> {
    devices.vm.shutdown(&devices)
}

#[tauri::command(async)]
pub fn mac_attach(devices: State<'_, Arc<Devices>>, frames: Channel<InvokeResponseBody>) -> Res<Value> {
    devices.vm.attach(&devices, frames)
}

#[tauri::command(async)]
pub fn mac_detach(devices: State<'_, Arc<Devices>>, stream: u64) {
    devices.vm.detach(stream);
}

#[tauri::command(async)]
pub fn mac_bind(devices: State<'_, Arc<Devices>>, chat: usize, on: bool) {
    let mut c = devices.vm.chats.lock().unwrap();
    if on {
        c.insert(chat);
    } else {
        c.remove(&chat);
    }
}

/// The person's own input from the panel (pointer, scroll, raw key codes, pasted text): one input, or a list applied
/// in order. The panel sends one call at a time (a list of what came in meanwhile): calls run on threads of their
/// own, so two in flight could reach the Mac in either order.
#[tauri::command(async)]
pub fn mac_input(devices: State<'_, Arc<Devices>>, input: Value) -> Res<()> {
    match input {
        Value::Array(list) => list.iter().try_for_each(|i| one_input(&devices, i)),
        i => one_input(&devices, &i),
    }
}

fn one_input(devices: &Devices, input: &Value) -> Res<()> {
    let vm = &devices.vm;
    let t = Duration::from_secs(5);
    let req = match input["kind"].as_str().unwrap_or("") {
        "pointer" => json!({ "cmd": "pointer", "x": input["x"], "y": input["y"], "buttons": input["buttons"] }),
        "scroll" => json!({ "cmd": "scroll", "x": input["x"], "y": input["y"], "dx": input["dx"], "dy": input["dy"] }),
        "keyDown" => json!({ "cmd": "keyDown", "code": input["code"] }),
        "keyUp" => json!({ "cmd": "keyUp", "code": input["code"] }),
        "key" => json!({ "cmd": "key", "name": input["name"], "modifiers": input["modifiers"] }),
        "text" => return type_text(devices, input["text"].as_str().unwrap_or("")),
        k => return Err(format!("unknown input {k:?}")),
    };
    vm.call(devices, req, t).map(|_| ())
}

/// Types text: key by key when a US keyboard has every character, else through the guest's pasteboard.
pub fn type_text(d: &Devices, text: &str) -> Res<()> {
    if text.is_empty() {
        return Ok(());
    }
    let typable = text.chars().all(|c| c.is_ascii() && (!c.is_ascii_control() || c == '\n' || c == '\t'));
    if typable {
        d.vm.call(d, json!({ "cmd": "text", "text": text }), Duration::from_secs(10 + text.len() as u64 / 20))?;
    } else {
        d.vm.agent(d, json!({ "cmd": "setPasteboard", "text": text }), Duration::from_secs(5))?;
        d.vm.call(d, json!({ "cmd": "key", "name": "v", "modifiers": ["command"] }), Duration::from_secs(5))?;
    }
    Ok(())
}

// ---- the agent tools (`mac_*` in coool-device) ----

pub const INSTRUCTIONS: &str = "The `mac_*` tools drive coool's sandboxed Mac: a macOS virtual machine shown in the chat's \
Mac panel (the person watches it live), separate from the person's own Mac, for using and testing Mac apps. Start with \
`mac_observe`: the frontmost app's windows and menu bar as `[id] role \"label\" value=… (x,y wxh)` in screen points. Act \
by id (`mac_click`, `mac_type` replaces a field's text, `mac_press` for keys and shortcuts like command+s, `mac_scroll`); \
each returns the screen after it settles. `mac_app` launches apps by name (\"TextEdit\") or bundle id, `mac_batch` runs \
several steps in one call, `mac_wait_for` replaces sleeps. Hand files or an app build to the Mac with `mac_share` (it \
lands in /Volumes/My Shared Files in the Mac); `mac_shell` runs a command inside the Mac. The first call boots the Mac \
(about half a minute).";

pub fn tools() -> Vec<Value> {
    let target = json!({ "type": "string", "description": "Element id from mac_observe, e.g. \"k3f\"" });
    let observe = json!({ "type": "boolean", "description": "Return the screen after the action settles (default true)." });
    vec![
        json!({
            "name": "mac_observe",
            "description": "Read the sandbox Mac's screen: the frontmost app's windows, sheets and menu bar, one line per accessibility element, `[id] role \"label\" value=… (x,y wxh)` in points (origin top-left). Ids are short and stable. screenshot=true adds a JPEG (only when visuals matter).",
            "inputSchema": { "type": "object", "properties": {
                "screenshot": { "type": "boolean" },
                "max_size": { "type": "number", "description": "Screenshot's longest side in pixels (default 1000)." },
                "menus": { "type": "boolean", "description": "Include the menu bar (default true)." }
            } }
        }),
        json!({
            "name": "mac_click",
            "description": "Click an element (by id) or a point. count=2 double-clicks, button=right opens a context menu. Opening a menu: click its menu bar title, then the item. Returns the screen after it settles.",
            "inputSchema": { "type": "object", "properties": {
                "target": target, "x": { "type": "number" }, "y": { "type": "number" },
                "count": { "type": "number" }, "button": { "type": "string", "enum": ["left", "right"] }, "observe": observe
            } }
        }),
        json!({
            "name": "mac_type",
            "description": "Type text with the keyboard (non-ASCII is pasted). into: click this element first and replace its contents (select all, then type); without into it types at the focus. replace=false appends instead. submit: press return after.",
            "inputSchema": { "type": "object", "required": ["text"], "properties": {
                "text": { "type": "string" }, "into": target, "replace": { "type": "boolean" }, "submit": { "type": "boolean" }, "observe": observe
            } }
        }),
        json!({
            "name": "mac_press",
            "description": "Press a key (return, tab, escape, space, delete, forwarddelete, up/down/left/right, home, end, pageup, pagedown, f1-f12, or one character) with modifiers (command, shift, option, control): e.g. {\"key\":\"s\",\"modifiers\":[\"command\"]}.",
            "inputSchema": { "type": "object", "required": ["key"], "properties": {
                "key": { "type": "string" }, "modifiers": { "type": "array", "items": { "type": "string" } }, "observe": observe
            } }
        }),
        json!({
            "name": "mac_scroll",
            "description": "Scroll (direction up/down/left/right shows content further that way), over an element (`in`, by id) or the screen's centre; amount in points (default 300).",
            "inputSchema": { "type": "object", "required": ["direction"], "properties": {
                "direction": { "type": "string", "enum": ["up", "down", "left", "right"] }, "in": target, "amount": { "type": "number" }, "observe": observe
            } }
        }),
        json!({
            "name": "mac_app",
            "description": "Apps in the sandbox Mac: launch (app: a name like \"TextEdit\" or \"System Settings\", a bundle id, or a path such as one under /Volumes/My Shared Files), quit (app), list (running apps), open (url: a URL or a file path in the Mac).",
            "inputSchema": { "type": "object", "required": ["action"], "properties": {
                "action": { "type": "string", "enum": ["launch", "quit", "list", "open"] }, "app": { "type": "string" }, "url": { "type": "string" }, "observe": observe
            } }
        }),
        json!({
            "name": "mac_wait_for",
            "description": "Wait until text (in any label/value) or an element id appears — or disappears with gone=true — or until the screen stops changing (idle=true). Returns the screen. Default timeout 5000 ms.",
            "inputSchema": { "type": "object", "properties": {
                "text": { "type": "string" }, "id": { "type": "string" }, "gone": { "type": "boolean" }, "idle": { "type": "boolean" }, "timeout_ms": { "type": "number" }
            } }
        }),
        json!({
            "name": "mac_screenshot",
            "description": "A JPEG of the sandbox Mac's screen.",
            "inputSchema": { "type": "object", "properties": { "max_size": { "type": "number", "description": "Longest side in pixels (default 1000)." } } }
        }),
        json!({
            "name": "mac_batch",
            "description": "Run several steps in one call, then return the settled screen. Steps: {\"click\":\"id\"|[x,y],\"count\"?}, {\"type\":\"text\",\"into\"?:\"id\",\"replace\"?,\"submit\"?}, {\"press\":\"return\",\"modifiers\"?}, {\"scroll\":\"down\",\"in\"?:\"id\"}, {\"wait_for\":\"text\"|{\"text\"|\"id\",\"gone\"?,\"timeout_ms\"?}}, {\"wait_ms\":300}, {\"launch\":\"TextEdit\"}. Stops at the first failing step.",
            "inputSchema": { "type": "object", "required": ["actions"], "properties": {
                "actions": { "type": "array", "items": { "type": "object" } }, "observe": observe
            } }
        }),
        json!({
            "name": "mac_shell",
            "description": "Run a shell command inside the sandbox Mac (as its user, in /bin/sh) and get its output: install an app build from /Volumes/My Shared Files, read a file, check a setting. It can't reach the person's own Mac.",
            "inputSchema": { "type": "object", "required": ["command"], "properties": {
                "command": { "type": "string" }, "timeout_s": { "type": "number", "description": "Default 60." }
            } }
        }),
        json!({
            "name": "mac_share",
            "description": "Hand a file or folder (an app build, a document) from this computer to the sandbox Mac: it is copied into the shared folder and appears in the Mac at /Volumes/My Shared Files/<name>. Returns that path.",
            "inputSchema": { "type": "object", "required": ["path"], "properties": { "path": { "type": "string", "description": "An absolute path on this computer." } } }
        }),
        json!({
            "name": "mac_device",
            "description": "The sandbox Mac itself: status, boot, shutdown.",
            "inputSchema": { "type": "object", "properties": { "action": { "type": "string", "enum": ["status", "boot", "shutdown"] } } }
        }),
    ]
}

pub struct MacTools<'a> {
    pub d: &'a Devices,
    pub chat: usize,
}

impl MacTools<'_> {
    /// What a Mac tool call changes, for the gate (None: it only reads). `project`: the chat's folder.
    pub fn gate_act(name: &str, a: &Value, project: Option<&str>) -> Option<super::gate::Act> {
        use super::gate::{Act, Dev, Risk};
        let shared = |p: &str| p.contains(SHARED_IN_GUEST) || p.contains("My Shared Files");
        let what = match name {
            "mac_observe" | "mac_screenshot" | "mac_wait_for" | "mac_scroll" => return None,
            "mac_shell" => {
                let c = a["command"].as_str().unwrap_or("").to_string();
                return Some(Act::new(Dev::Mac, "Run a command").risk(Some(Risk::Shell { command: c })));
            }
            "mac_share" => {
                let p = a["path"].as_str().unwrap_or("").to_string();
                let inside = project.filter(|d| !d.is_empty()).is_some_and(|d| Path::new(&p).starts_with(d));
                let act = Act::new(Dev::Mac, format!("Copy {p} into the Mac's shared folder"));
                return Some(if inside { act } else { act.risk(Some(Risk::Share { path: p })) });
            }
            "mac_device" => match a["action"].as_str().unwrap_or("status") {
                "status" => return None,
                x => format!("{} the Mac", if x == "boot" { "Boot" } else { "Shut down" }),
            },
            "mac_app" => {
                let action = a["action"].as_str().unwrap_or("");
                let target = a["app"].as_str().or(a["url"].as_str()).unwrap_or("").to_string();
                match action {
                    "list" => return None,
                    "launch" | "open" if shared(&target) => return Some(Act::new(Dev::Mac, format!("Open {target}")).risk(Some(Risk::Launch { what: target }))),
                    "launch" => format!("Launch {target}"),
                    "open" => format!("Open {target}"),
                    _ => format!("Quit {target}"),
                }
            }
            "mac_batch" => {
                let steps = a["actions"].as_array().cloned().unwrap_or_default();
                if let Some(t) = steps.iter().filter_map(|s| s["launch"].as_str()).find(|t| shared(t)) {
                    return Some(Act::new(Dev::Mac, format!("Open {t}")).risk(Some(Risk::Launch { what: t.to_string() })));
                }
                format!("Run {} steps", steps.len())
            }
            "mac_click" => "Click in the Mac".to_string(),
            "mac_type" => format!("Type “{}”", a["text"].as_str().unwrap_or("").chars().take(60).collect::<String>()),
            "mac_press" => format!("Press {}", a["key"].as_str().unwrap_or("a key")),
            _ => return None,
        };
        Some(Act::new(Dev::Mac, what))
    }

    pub fn call(&self, name: &str, a: &Value) -> Res<Vec<Value>> {
        let t0 = Instant::now();
        // The permission gate, for what changes something (reading never asks).
        if self.d.gate_asks(self.chat)
            && let Some(act) = Self::gate_act(name, a, self.d.mcp.cwd(self.chat).as_deref())
        {
            self.d.gate_check(self.chat, act)?;
        }
        if name == "mac_share" {
            return Ok(vec![text(self.share(a)?)]);
        }
        if name == "mac_device" {
            return Ok(vec![text(self.device(a)?)]);
        }
        self.d.vm.ensure(self.d, self.chat)?;
        let observe_after = a["observe"].as_bool().unwrap_or(true);
        let mut out = Vec::new();
        let body = match name {
            "mac_observe" => {
                self.activity("observe", None, None);
                let s = self.observe(true, a["menus"].as_bool().unwrap_or(true))?;
                if a["screenshot"].as_bool() == Some(true) {
                    out.push(self.screenshot(a["max_size"].as_f64())?);
                }
                s
            }
            "mac_screenshot" => {
                out.push(self.screenshot(a["max_size"].as_f64())?);
                format!("screenshot in {} ms", t0.elapsed().as_millis())
            }
            "mac_click" | "mac_type" | "mac_press" | "mac_scroll" | "mac_app" => {
                let note = self.act(name, a)?;
                let act_ms = t0.elapsed().as_millis();
                let listing = name == "mac_app" && a["action"] == "list";
                if observe_after && !listing { self.after(&note, act_ms)? } else { format!("{note} · {act_ms} ms") }
            }
            "mac_batch" => {
                let steps = a["actions"].as_array().cloned().unwrap_or_default();
                if steps.is_empty() {
                    return Err("mac_batch needs `actions`: a list like [{\"click\":\"k3f\"},{\"type\":\"hello\",\"submit\":true}]".into());
                }
                let mut notes = Vec::new();
                for (i, s) in steps.iter().enumerate() {
                    match self.step(s) {
                        Ok(n) => notes.push(format!("{}. {n}", i + 1)),
                        Err(e) => {
                            notes.push(format!("{}. FAILED: {e} (stopped; later steps not run)", i + 1));
                            let screen = self.observe(false, true).unwrap_or_default();
                            return Err(format!("{}\n\n{screen}", notes.join("\n")));
                        }
                    }
                }
                let act_ms = t0.elapsed().as_millis();
                if observe_after { self.after(&notes.join("\n"), act_ms)? } else { format!("{}\n{act_ms} ms", notes.join("\n")) }
            }
            "mac_wait_for" => self.wait_for(a)?,
            "mac_shell" => self.shell(a)?,
            _ => return Err(format!("unknown tool {name}")),
        };
        out.insert(0, text(body));
        Ok(out)
    }

    fn activity(&self, kind: &'static str, at: Option<(f64, f64)>, label: Option<String>) {
        self.d.activity(Activity {
            udid: UDID.into(),
            chat: Some(self.chat),
            source: "agent",
            kind,
            x: at.map(|p| p.0),
            y: at.map(|p| p.1),
            label,
            ..Default::default()
        });
    }

    /// Typing: where (the field's centre, when known), into what, and the text (dots for a secret field).
    fn typing(&self, at: Option<(f64, f64)>, field: Option<String>, text: &str) {
        let text = super::presence::shown_text(text, field.as_deref());
        self.d.activity(Activity { udid: UDID.into(), chat: Some(self.chat), source: "agent", kind: "type", x: at.map(|p| p.0), y: at.map(|p| p.1), label: field, text: Some(text), ..Default::default() });
    }

    /// The focused text field of the last screen this chat saw: (its centre, its name).
    fn focused_field(&self) -> Option<((f64, f64), Option<String>)> {
        let last = self.d.vm.last.lock().unwrap();
        let (t, _) = last.get(&self.chat)?;
        let n = t.nodes.iter().find(|n| n.flags.contains(&"focused") && matches!(n.role.as_str(), "textfield" | "textarea" | "searchfield" | "securefield" | "combobox"))?;
        Some((n.center(), n.label.clone().or_else(|| n.placeholder.clone())))
    }

    /// The run on the Mac is over (the pilot's): the panel's cursor rests, then fades.
    pub fn end(&self) {
        self.activity("end", None, None);
    }

    /// The pilot is choosing its next step (`by`: who decides).
    pub fn thinking(&self) {
        self.activity("think", None, None);
    }

    fn helper(&self, req: Value, timeout: Duration) -> Res<Value> {
        self.d.vm.call(self.d, req, timeout)
    }

    pub fn tree(&self, menus: bool) -> Res<Tree> {
        let d = self.d.vm.agent(self.d, json!({ "cmd": "tree", "maxNodes": 600, "menus": menus }), Duration::from_secs(10))?;
        Ok(observe::parse(&d))
    }

    fn name(&self) -> String {
        let os = std::fs::read(vm_dir().join("config.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v["os"].as_str().map(String::from));
        format!("coool Mac (macOS {})", os.unwrap_or_else(|| "?".into()))
    }

    fn observe(&self, full: bool, menus: bool) -> Res<String> {
        let tree = self.tree(menus)?;
        self.observe_tree(full, tree)
    }

    fn observe_tree(&self, full: bool, tree: Tree) -> Res<String> {
        let text = observe::render(&tree, &self.name());
        let same = self.d.vm.last.lock().unwrap().get(&self.chat).is_some_and(|(_, t)| *t == text);
        let n = tree.nodes.len();
        self.d.vm.remember(self.chat, tree, text.clone());
        Ok(if same && !full { format!("Screen unchanged ({n} elements).") } else { text })
    }

    /// Waits for the screen to settle (no new pixels for a moment), then observes.
    fn after(&self, note: &str, act_ms: u128) -> Res<String> {
        let t = Instant::now();
        let _ = self.helper(json!({ "cmd": "idle", "quietMs": 200, "firstMs": 400, "timeoutMs": 2500 }), Duration::from_secs(6));
        let settle = t.elapsed().as_millis();
        let t = Instant::now();
        let screen = self.observe(false, true)?;
        Ok(format!("{note}\n(act {act_ms} ms · settle {settle} ms · observe {} ms)\n\n{screen}", t.elapsed().as_millis()))
    }

    fn screenshot(&self, max: Option<f64>) -> Res<Value> {
        let r = self.helper(json!({ "cmd": "screenshot", "maxDim": max.unwrap_or(1000.0).clamp(200.0, 1600.0), "quality": 0.6 }), Duration::from_secs(8))?;
        Ok(json!({ "type": "image", "data": r["jpeg"], "mimeType": "image/jpeg" }))
    }

    fn element(&self, id: &str) -> Res<observe::Node> {
        let id = id.trim().trim_start_matches('[').trim_end_matches(']');
        let find = |t: &Tree| t.nodes.iter().find(|n| n.id == id).cloned();
        if let Some(n) = self.d.vm.last.lock().unwrap().get(&self.chat).and_then(|(t, _)| find(t)) {
            return Ok(n);
        }
        let t = self.tree(true)?;
        let n = find(&t);
        let _ = self.observe_tree(true, t);
        n.ok_or_else(|| format!("no element [{id}] on screen now; mac_observe again for current ids"))
    }

    fn point(&self, a: &Value, key: &str) -> Res<((f64, f64), Option<String>)> {
        let given = if key == "target" && a[key].is_null() { &a["id"] } else { &a[key] };
        if let Some(id) = given.as_str() {
            let n = self.element(id)?;
            return Ok((n.center(), n.label.or(n.identifier).or(n.value)));
        }
        if let Some(p) = given.as_array().filter(|p| p.len() == 2) {
            return Ok(((p[0].as_f64().unwrap_or(0.0), p[1].as_f64().unwrap_or(0.0)), None));
        }
        match (a["x"].as_f64(), a["y"].as_f64()) {
            (Some(x), Some(y)) => Ok(((x, y), None)),
            _ => Err(format!("give `{key}` (an element id from mac_observe) or x and y in points")),
        }
    }

    /// For the pilot: a left click at a point.
    pub fn click_at(&self, p: (f64, f64), label: Option<String>) -> Res<String> {
        self.click(p, 1, false, label)
    }

    /// For the pilot: replaces the focused field's text.
    pub fn replace_text(&self, t: &str) -> Res<String> {
        self.type_into(t, None, Some(true), false)
    }

    /// For the pilot: the screen it read, so the caller's own `mac_*` ids work.
    pub fn remember_tree(&self, tree: Tree) {
        let text = observe::render(&tree, &self.name());
        self.d.vm.remember(self.chat, tree, text);
    }

    fn click(&self, (x, y): (f64, f64), count: u64, right: bool, label: Option<String>) -> Res<String> {
        self.activity("tap", Some((x, y)), label.clone());
        self.helper(json!({ "cmd": "click", "x": x, "y": y, "count": count.clamp(1, 3), "button": if right { "right" } else { "left" } }), Duration::from_secs(5))?;
        let what = label.map(|l| format!(" \"{l}\"")).unwrap_or_default();
        Ok(format!("{}clicked{what} at ({x:.0},{y:.0})", match (count, right) {
            (_, true) => "right-",
            (2, _) => "double-",
            _ => "",
        }))
    }

    fn type_into(&self, text_: &str, into: Option<&str>, replace: Option<bool>, submit: bool) -> Res<String> {
        let mut note = String::new();
        let mut field = None;
        if let Some(id) = into {
            let (p, label) = self.point(&json!({ "target": id }), "target")?;
            field = Some((p, label.clone()));
            note = self.click(p, 1, false, label)? + ", ";
            std::thread::sleep(Duration::from_millis(120));
        }
        let field = field.or_else(|| self.focused_field());
        let replace = replace.unwrap_or(into.is_some());
        if replace {
            self.helper(json!({ "cmd": "key", "name": "a", "modifiers": ["command"] }), Duration::from_secs(5))?;
            if text_.is_empty() {
                self.helper(json!({ "cmd": "key", "name": "delete" }), Duration::from_secs(5))?;
            }
        }
        self.typing(field.as_ref().map(|f| f.0), field.and_then(|f| f.1), text_);
        type_text(self.d, text_)?;
        if submit {
            self.helper(json!({ "cmd": "key", "name": "return" }), Duration::from_secs(5))?;
        }
        Ok(format!("{note}{}typed {:?}{}", if replace { "replaced its text, " } else { "" }, text_, if submit { " + return" } else { "" }))
    }

    fn press(&self, key: &str, modifiers: &Value) -> Res<String> {
        self.activity("press", None, Some(key.to_string()));
        self.helper(json!({ "cmd": "key", "name": key, "modifiers": modifiers }), Duration::from_secs(5))?;
        let mods: Vec<&str> = modifiers.as_array().map(|m| m.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
        Ok(if mods.is_empty() { format!("pressed {key}") } else { format!("pressed {}+{key}", mods.join("+")) })
    }

    fn scroll(&self, dir: &str, within: Option<&str>, amount: f64) -> Res<String> {
        let (cx, cy) = match within {
            Some(id) => self.element(id)?.center(),
            None => (640.0, 420.0),
        };
        let amount = amount.clamp(20.0, 3000.0);
        // Wheel deltas: positive dy moves the content down (shows what's above).
        let (dx, dy) = match dir {
            "down" => (0.0, -amount),
            "up" => (0.0, amount),
            "right" => (-amount, 0.0),
            "left" => (amount, 0.0),
            _ => return Err("scroll direction is up, down, left or right".into()),
        };
        self.activity("scroll", Some((cx, cy)), Some(dir.to_string()));
        self.helper(json!({ "cmd": "scroll", "x": cx, "y": cy, "dx": dx, "dy": dy }), Duration::from_secs(10))?;
        Ok(format!("scrolled {dir}"))
    }

    fn app(&self, a: &Value) -> Res<String> {
        let action = a["action"].as_str().unwrap_or("");
        let app = || a["app"].as_str().filter(|s| !s.trim().is_empty()).ok_or_else(|| format!("{action} needs `app`"));
        self.activity("app", None, Some(action.to_string()));
        match action {
            "launch" => {
                let r = self.d.vm.agent(self.d, json!({ "cmd": "launch", "app": app()? }), Duration::from_secs(40))?;
                Ok(format!("launched {} ({})", r["app"].as_str().unwrap_or(""), r["bundleId"].as_str().unwrap_or("")))
            }
            "quit" => {
                self.d.vm.agent(self.d, json!({ "cmd": "quitApp", "app": app()? }), Duration::from_secs(10))?;
                Ok(format!("asked {} to quit", app()?))
            }
            "list" => {
                let r = self.d.vm.agent(self.d, json!({ "cmd": "apps" }), Duration::from_secs(10))?;
                let lines: Vec<String> = r["apps"]
                    .as_array()
                    .map(|a| a.iter().map(|x| format!("{}{}  {}", if x["active"] == true { "* " } else { "  " }, x["name"].as_str().unwrap_or(""), x["bundleId"].as_str().unwrap_or(""))).collect())
                    .unwrap_or_default();
                Ok(lines.join("\n"))
            }
            "open" => {
                let url = a["url"].as_str().ok_or("open needs `url`")?;
                self.d.vm.agent(self.d, json!({ "cmd": "open", "url": url }), Duration::from_secs(15))?;
                Ok(format!("opened {url}"))
            }
            _ => Err("mac_app action is launch, quit, list or open".into()),
        }
    }

    fn act(&self, name: &str, a: &Value) -> Res<String> {
        match name {
            "mac_click" => {
                let (p, label) = self.point(a, "target")?;
                self.click(p, a["count"].as_u64().unwrap_or(1), a["button"] == "right", label)
            }
            "mac_type" => {
                let t = a["text"].as_str().ok_or("mac_type needs `text`")?;
                self.type_into(t, a["into"].as_str(), a["replace"].as_bool(), a["submit"] == true)
            }
            "mac_press" => self.press(a["key"].as_str().ok_or("mac_press needs `key`")?, &a["modifiers"]),
            "mac_scroll" => self.scroll(a["direction"].as_str().unwrap_or("down"), a["in"].as_str(), a["amount"].as_f64().unwrap_or(300.0)),
            "mac_app" => self.app(a),
            _ => Err(format!("unknown action {name}")),
        }
    }

    fn step(&self, s: &Value) -> Res<String> {
        if let Some(t) = s.get("click").or_else(|| s.get("tap")) {
            let (p, label) = self.point(&json!({ "target": t }), "target")?;
            return self.click(p, s["count"].as_u64().unwrap_or(1), s["button"] == "right", label);
        }
        if let Some(t) = s["type"].as_str() {
            return self.type_into(t, s["into"].as_str(), s["replace"].as_bool(), s["submit"] == true);
        }
        if let Some(k) = s["press"].as_str() {
            return self.press(k, &s["modifiers"]);
        }
        if let Some(d) = s["scroll"].as_str() {
            return self.scroll(d, s["in"].as_str(), s["amount"].as_f64().unwrap_or(300.0));
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
            let (ok, ms) = self.wait(&a)?;
            return if ok { Ok(format!("waited {ms} ms for {}", describe_wait(&a))) } else { Err(format!("timed out after {ms} ms waiting for {}", describe_wait(&a))) };
        }
        if let Some(app) = s["launch"].as_str() {
            return self.app(&json!({ "action": "launch", "app": app }));
        }
        Err(format!("unknown mac_batch step {s}"))
    }

    fn wait(&self, a: &Value) -> Res<(bool, u128)> {
        let t0 = Instant::now();
        let timeout = Duration::from_millis(a["timeout_ms"].as_f64().unwrap_or(5000.0).clamp(0.0, 60_000.0) as u64);
        let gone = a["gone"] == true;
        if a["idle"] == true && a["text"].is_null() && a["id"].is_null() {
            let r = self.helper(json!({ "cmd": "idle", "quietMs": a["quiet_ms"].as_f64().unwrap_or(300.0), "firstMs": 0, "timeoutMs": timeout.as_millis() as u64 }), timeout + Duration::from_secs(4))?;
            return Ok((r["idle"] == true, t0.elapsed().as_millis()));
        }
        let (text_, id) = (a["text"].as_str(), a["id"].as_str());
        if text_.is_none() && id.is_none() {
            return Err("mac_wait_for needs `text`, `id` or `idle: true`".into());
        }
        loop {
            let tree = self.tree(true)?;
            let present = tree.nodes.iter().any(|n| text_.is_some_and(|t| n.mentions(t)) || id.is_some_and(|i| n.id == i)) || text_.is_some_and(|t| contains(&tree.app, t));
            if present != gone || t0.elapsed() >= timeout {
                let _ = self.observe_tree(true, tree);
                return Ok((present != gone, t0.elapsed().as_millis()));
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    fn wait_for(&self, a: &Value) -> Res<String> {
        let (ok, ms) = self.wait(a)?;
        let screen = self.d.vm.last.lock().unwrap().get(&self.chat).map(|(_, t)| t.clone()).unwrap_or_default();
        let head = if ok { format!("{} after {ms} ms", describe_wait(a)) } else { format!("timed out after {ms} ms waiting for {}", describe_wait(a)) };
        if ok { Ok(format!("{head}\n\n{screen}")) } else { Err(format!("{head}\n\n{screen}")) }
    }

    fn shell(&self, a: &Value) -> Res<String> {
        let cmd = a["command"].as_str().ok_or("mac_shell needs `command`")?;
        let timeout = a["timeout_s"].as_f64().unwrap_or(60.0).clamp(1.0, 600.0);
        self.activity("app", None, Some("shell".into()));
        let r = self.d.vm.agent(self.d, json!({ "cmd": "run", "sh": cmd, "timeout": timeout }), Duration::from_secs_f64(timeout + 5.0))?;
        let mut out = r["output"].as_str().unwrap_or("").to_string();
        if out.len() > 20_000 {
            out = format!("{}\n… ({} bytes, truncated)", &out[..out.floor_char_boundary(20_000)], out.len());
        }
        Ok(format!("exit {}{} · {} ms\n{out}", r["status"], if r["timedOut"] == true { " (timed out)" } else { "" }, r["ms"]))
    }

    fn share(&self, a: &Value) -> Res<String> {
        let src = PathBuf::from(a["path"].as_str().ok_or("mac_share needs `path`")?);
        share_into(&src, &shared_dir())
    }

    fn device(&self, a: &Value) -> Res<String> {
        match a["action"].as_str().unwrap_or("status") {
            "status" => {
                let s = self.d.vm.status(self.d);
                Ok(format!(
                    "{} · {} · {} CPUs · {} MB · disk {:.1} GB used · shared folder {} (in the Mac: {SHARED_IN_GUEST})",
                    self.name(),
                    s["state"].as_str().unwrap_or("?"),
                    s["cpus"],
                    s["memoryMB"],
                    s["diskBytes"].as_f64().unwrap_or(0.0) / 1e9,
                    shared_dir().display()
                ))
            }
            "boot" => {
                self.d.vm.chats.lock().unwrap().insert(self.chat);
                self.d.vm.boot(self.d)
            }
            "shutdown" => self.d.vm.shutdown(self.d).map(|_| "shut down".into()),
            _ => Err("mac_device action is status, boot or shutdown".into()),
        }
    }
}

/// A JSON flag from the guest agent (`true`, or `1` from an Objective-C Boolean).
fn truthy(v: &Value) -> bool {
    v == &Value::Bool(true) || v.as_i64() == Some(1)
}

fn text(s: String) -> Value {
    json!({ "type": "text", "text": s })
}

fn contains(hay: &str, needle: &str) -> bool {
    hay.to_lowercase().contains(&needle.to_lowercase())
}

fn describe_wait(a: &Value) -> String {
    let gone = a["gone"] == true;
    match (a["text"].as_str(), a["id"].as_str()) {
        (Some(t), _) => format!("{:?} to {}", t, if gone { "disappear" } else { "appear" }),
        (_, Some(i)) => format!("[{i}] to {}", if gone { "disappear" } else { "appear" }),
        _ => "the screen to settle".into(),
    }
}

/// Copies `src` (a file or folder) into the shared folder, keeping its name (a clone on APFS: instant, no extra
/// space), and returns where the guest sees it.
pub fn share_into(src: &Path, shared: &Path) -> Res<String> {
    if !src.is_absolute() {
        return Err("mac_share needs an absolute path".into());
    }
    let meta = std::fs::symlink_metadata(src).map_err(|e| format!("{}: {e}", src.display()))?;
    let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).filter(|n| !n.is_empty() && n != "..").ok_or("that path has no file name")?;
    std::fs::create_dir_all(shared).map_err(|e| e.to_string())?;
    let dst = shared.join(&name);
    if dst.exists() {
        if dst.is_dir() { std::fs::remove_dir_all(&dst) } else { std::fs::remove_file(&dst) }.map_err(|e| e.to_string())?;
    }
    // -c: clone where the file system can; -R for folders (app bundles); -P keeps symlinks as links.
    let ok = Command::new("/bin/cp").args(if meta.is_dir() { vec!["-cRP"] } else { vec!["-cP"] }).arg(src).arg(&dst).status();
    if !matches!(ok, Ok(s) if s.success()) {
        let ok = Command::new("/bin/cp").args(if meta.is_dir() { vec!["-RP"] } else { vec!["-P"] }).arg(src).arg(&dst).status();
        if !matches!(ok, Ok(s) if s.success()) {
            return Err(format!("couldn't copy {} into the shared folder", src.display()));
        }
    }
    Ok(format!("{SHARED_IN_GUEST}/{name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_copies_files_and_folders_and_names_the_guest_path() {
        let base = std::env::temp_dir().join(format!("coool-vm-share-{}", std::process::id()));
        let shared = base.join("Shared");
        let app = base.join("Demo.app/Contents");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("Info.plist"), "x").unwrap();
        std::fs::write(base.join("notes.txt"), "hello").unwrap();
        assert_eq!(share_into(&base.join("Demo.app"), &shared).unwrap(), "/Volumes/My Shared Files/Demo.app");
        assert_eq!(share_into(&base.join("notes.txt"), &shared).unwrap(), "/Volumes/My Shared Files/notes.txt");
        // Sharing again replaces the copy.
        std::fs::write(base.join("notes.txt"), "again").unwrap();
        share_into(&base.join("notes.txt"), &shared).unwrap();
        assert_eq!(std::fs::read_to_string(shared.join("notes.txt")).unwrap(), "again");
        assert!(shared.join("Demo.app/Contents/Info.plist").exists());
        assert!(share_into(Path::new("relative.txt"), &shared).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn setup_script_installs_the_agent_and_keeps_secrets_quoted() {
        let s = setup_script("Pw7abc", "ssh-ed25519 AAAA coool-vm");
        assert!(s.contains("launchctl bootstrap gui/$(id -u)") && s.contains("launchctl bootout gui/$(id -u)/sh.coool.vm-agent"));
        // A stable program (see the script): an agent update is not a new background item.
        assert!(s.contains("<array><string>/bin/sh</string><string>-c</string><string>exec \"\\$0\"</string><string>$APP/Contents/MacOS/coool-vm-agent</string></array>"));
        assert!(s.contains("<string>sh.coool.vm-agent</string>"));
        assert!(s.contains("printf '%s\\n' 'Pw7abc' | sudo -S"));
        assert!(s.contains("grep -qF 'ssh-ed25519 AAAA coool-vm'"));
        assert!(s.trim_end().ends_with("echo coool-setup-ok"));
    }

    #[test]
    fn tools_are_named_mac_and_have_schemas() {
        let t = tools();
        let names: Vec<_> = t.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["mac_observe", "mac_click", "mac_type", "mac_press", "mac_scroll", "mac_app", "mac_wait_for", "mac_screenshot", "mac_batch", "mac_shell", "mac_share", "mac_device"]);
        assert!(t.iter().all(|t| t["inputSchema"]["type"] == "object"));
    }

    #[test]
    fn agent_flags_accept_objc_booleans() {
        assert!(truthy(&json!(true)) && truthy(&json!(1)));
        assert!(!truthy(&json!(false)) && !truthy(&json!(0)) && !truthy(&Value::Null));
    }

    #[test]
    fn the_network_setting_reads_from_the_vm_config() {
        let d = std::env::temp_dir().join(format!("coool-vm-net-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(network_in(&d), Network::On, "no config: on");
        std::fs::write(d.join("config.json"), br#"{"installed":true,"network":"off"}"#).unwrap();
        assert_eq!(network_in(&d), Network::Off);
        std::fs::write(d.join("config.json"), br#"{"network":"local"}"#).unwrap();
        assert_eq!(network_in(&d), Network::Local);
        std::fs::write(d.join("config.json"), br#"{"network":"bogus"}"#).unwrap();
        assert_eq!(network_in(&d), Network::On, "unknown: on");
        for n in [Network::On, Network::Local, Network::Off] {
            assert_eq!(Network::parse(n.as_str()), Some(n));
        }
        assert!(Network::On.truth().contains("shared folder can leave"));
        assert!(Network::Off.truth().contains("no network"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn mac_tools_ask_for_what_changes_and_always_for_commands_and_the_shared_folder() {
        use crate::device::gate::Risk;
        for read in [("mac_observe", json!({})), ("mac_screenshot", json!({})), ("mac_wait_for", json!({"text":"x"})), ("mac_scroll", json!({"direction":"down"})), ("mac_app", json!({"action":"list"})), ("mac_device", json!({"action":"status"}))] {
            assert!(MacTools::gate_act(read.0, &read.1, None).is_none(), "{read:?}");
        }
        let a = MacTools::gate_act("mac_click", &json!({"target":"k3f"}), None).unwrap();
        assert!(a.risk.is_none());
        let a = MacTools::gate_act("mac_shell", &json!({"command":"ls /"}), None).unwrap();
        assert_eq!(a.risk, Some(Risk::Shell { command: "ls /".into() }));
        let a = MacTools::gate_act("mac_app", &json!({"action":"launch","app":"/Volumes/My Shared Files/My.app"}), None).unwrap();
        assert!(matches!(a.risk, Some(Risk::Launch { .. })));
        assert!(MacTools::gate_act("mac_app", &json!({"action":"launch","app":"TextEdit"}), None).unwrap().risk.is_none());
        let a = MacTools::gate_act("mac_batch", &json!({"actions":[{"click":"a"},{"launch":"/Volumes/My Shared Files/x.pkg"}]}), None).unwrap();
        assert!(matches!(a.risk, Some(Risk::Launch { .. })));
        assert!(MacTools::gate_act("mac_share", &json!({"path":"/work/app/build/My.app"}), Some("/work/app")).unwrap().risk.is_none());
        assert!(matches!(MacTools::gate_act("mac_share", &json!({"path":"/Users/x/.ssh"}), Some("/work/app")).unwrap().risk, Some(Risk::Share { .. })));
    }

    #[test]
    fn vm_dir_honours_the_override() {
        // SAFETY: tests in this module don't read the variable concurrently.
        unsafe { std::env::set_var("COOOL_VM_DIR", "/tmp/coool-vm-test") };
        assert_eq!(vm_dir(), PathBuf::from("/tmp/coool-vm-test"));
        assert_eq!(shared_dir(), PathBuf::from("/tmp/coool-vm-test/Shared"));
        unsafe { std::env::remove_var("COOOL_VM_DIR") };
    }
}
