//! The per-simulator helper process (`native/coool-sim.m`): frames, HID input and the accessibility tree through the
//! simulator's private frameworks. One process per booted device, started on first use and kept while the device is
//! up. Requests are JSON lines on its stdin; replies, events and JPEG frames come back framed on its stdout
//! ([u32 BE length][u8 kind][payload]; kind 'J' = JSON, 'F' = frame).

use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// The helper binary, built by build.rs (empty when it couldn't be built).
static HELPER: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/coool-sim"));

/// Writes the embedded helper to `<dir>/coool-sim-<hash>` once (the hash names the build, so an update never runs a
/// stale copy) and returns its path.
pub fn install(dir: &Path) -> Result<PathBuf, String> {
    if HELPER.is_empty() {
        return Err("This build of coool has no iOS Simulator helper (it needs Xcode's command line tools to build).".into());
    }
    install_bytes(dir, "coool-sim", HELPER)
}

/// Writes `bytes` to `<dir>/<name>-<hash>` (executable) once, removing older builds' copies, and returns its path.
pub fn install_bytes(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    // FNV-1a: enough to tell builds apart.
    let hash = bytes.iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3));
    let path = dir.join(format!("{name}-{:012x}", hash & 0xffff_ffff_ffff));
    if !path.exists() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let tmp = dir.join(format!(".{name}-{}", std::process::id()));
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        // Older builds' copies.
        let prefix = format!("{name}-");
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if n.strip_prefix(&prefix).is_some_and(|rest| rest.len() == 12 && rest.chars().all(|c| c.is_ascii_hexdigit())) && e.path() != path {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
    Ok(path)
}

/// Screen size in points and scale, from the helper's `ready` event.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct Screen {
    pub w: f64,
    pub h: f64,
    pub scale: f64,
}

pub type FrameSink = Box<dyn Fn(Vec<u8>) + Send>;
/// Called with the helper's events other than `ready` / `fatal` (the VM helper's `state` and `progress`).
pub type EventSink = Box<dyn Fn(&Value) + Send>;

pub struct Helper {
    stdin: Mutex<Option<BufWriter<ChildStdin>>>,
    child: Mutex<Child>,
    next: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    sinks: Mutex<Vec<(u64, FrameSink)>>,
    screen: (Mutex<Option<Result<Screen, String>>>, Condvar),
    alive: AtomicBool,
    events: Mutex<Option<EventSink>>,
}

impl Helper {
    pub fn spawn(bin: &Path, udid: &str, developer_dir: Option<&str>) -> Result<Arc<Self>, String> {
        let mut cmd = Command::new(bin);
        cmd.arg(udid);
        if let Some(d) = developer_dir {
            cmd.env("COOOL_DEVELOPER_DIR", d);
        }
        Self::spawn_cmd(cmd, &format!("coool-sim {udid}"), None)
    }

    /// Starts any helper speaking this protocol (the VM helper too), with an optional sink for its events.
    pub fn spawn_cmd(mut cmd: Command, label: &str, events: Option<EventSink>) -> Result<Arc<Self>, String> {
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| format!("couldn't start {label}: {e}"))?;
        let stdin = child.stdin.take().ok_or("helper stdin")?;
        let mut stdout = child.stdout.take().ok_or("helper stdout")?;
        let h = Arc::new(Self {

            stdin: Mutex::new(Some(BufWriter::new(stdin))),
            child: Mutex::new(child),
            next: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            sinks: Mutex::new(Vec::new()),
            screen: (Mutex::new(None), Condvar::new()),
            alive: AtomicBool::new(true),
            events: Mutex::new(events),
        });
        let weak = Arc::downgrade(&h);
        // What a call waiting on it is told when it stops: the sandbox Mac's helper isn't the simulator's.
        let gone = if label.starts_with("coool-vm") { "the sandbox Mac's helper stopped" } else { "the simulator helper stopped" };
        std::thread::Builder::new()
            .name(label.to_string())
            .spawn(move || {
                let mut head = [0u8; 4];
                let mut buf = Vec::new();
                loop {
                    if stdout.read_exact(&mut head).is_err() {
                        break;
                    }
                    let n = u32::from_be_bytes(head) as usize;
                    if n == 0 || n > 64 << 20 {
                        break;
                    }
                    buf.resize(n, 0);
                    if stdout.read_exact(&mut buf).is_err() {
                        break;
                    }
                    let Some(h) = weak.upgrade() else { break };
                    match buf[0] {
                        b'F' => {
                            for (_, sink) in h.sinks.lock().unwrap().iter() {
                                sink(buf[1..].to_vec());
                            }
                        }
                        b'J' => h.on_json(serde_json::from_slice(&buf[1..]).unwrap_or(Value::Null)),
                        _ => {}
                    }
                }
                if let Some(h) = weak.upgrade() {
                    h.died(gone);
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(h)
    }

    fn on_json(&self, v: Value) {
        if let Some(id) = v["id"].as_u64() {
            if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
                let r = if v["ok"].as_bool() == Some(true) {
                    Ok(v.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    Err(v["error"].as_str().unwrap_or("simulator helper error").to_string())
                };
                let _ = tx.send(r);
            }
            return;
        }
        match v["event"].as_str() {
            Some("ready") => {
                let s = if v["display"].as_bool() == Some(true) {
                    Ok(Screen { w: v["w"].as_f64().unwrap_or(0.0), h: v["h"].as_f64().unwrap_or(0.0), scale: v["scale"].as_f64().unwrap_or(1.0) })
                } else {
                    Err(format!("no screen: {}", v["displayError"].as_str().unwrap_or("?")))
                };
                *self.screen.0.lock().unwrap() = Some(s);
                self.screen.1.notify_all();
            }
            Some("fatal") => self.died(v["error"].as_str().unwrap_or("simulator helper failed")),
            Some(_) => {
                if let Some(sink) = self.events.lock().unwrap().as_ref() {
                    sink(&v);
                }
            }
            None => {}
        }
    }

    fn died(&self, why: &str) {
        self.alive.store(false, Ordering::SeqCst);
        {
            let mut s = self.screen.0.lock().unwrap();
            if s.is_none() {
                *s = Some(Err(why.to_string()));
            }
        }
        self.screen.1.notify_all();
        for (_, tx) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err(why.to_string()));
        }
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Waits for the helper to attach to the device's screen.
    pub fn screen(&self, timeout: Duration) -> Result<Screen, String> {
        let g = self.screen.0.lock().unwrap();
        let (g, _) = self.screen.1.wait_timeout_while(g, timeout, |s| s.is_none()).unwrap();
        g.clone().unwrap_or_else(|| Err("the simulator helper didn't attach in time".into()))
    }

    /// Sends a command and waits for its reply.
    pub fn call(&self, mut req: Value, timeout: Duration) -> Result<Value, String> {
        if !self.alive() {
            return Err("the simulator helper isn't running".into());
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        req["id"] = json!(id);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        {
            let mut g = self.stdin.lock().unwrap();
            let line = serde_json::to_string(&req).unwrap_or_default();
            let Some(w) = g.as_mut() else {
                self.pending.lock().unwrap().remove(&id);
                return Err("the helper is stopping".into());
            };
            if writeln!(w, "{line}").and_then(|_| w.flush()).is_err() {
                self.pending.lock().unwrap().remove(&id);
                return Err("the simulator helper isn't running".into());
            }
        }
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("the device didn't answer `{}` in time", req["cmd"].as_str().unwrap_or("?")))
            }
        }
    }

    /// Adds a frame subscriber (streaming starts with the first).
    pub fn add_sink(&self, id: u64, sink: FrameSink) -> Result<(), String> {
        let first = {
            let mut s = self.sinks.lock().unwrap();
            s.push((id, sink));
            s.len() == 1
        };
        if first {
            self.call(json!({ "cmd": "stream", "on": true, "fps": 30, "maxDim": 1100, "quality": 0.72 }), Duration::from_secs(5))?;
        } else {
            // A late subscriber still needs a first frame: ask for one by restarting the stream.
            self.call(json!({ "cmd": "stream", "on": true }), Duration::from_secs(5))?;
        }
        Ok(())
    }

    /// As [`Self::add_sink`], with the helper's own `stream` request (the VM helper's rate and size).
    pub fn add_sink_with(&self, id: u64, sink: FrameSink, start: Value) -> Result<(), String> {
        self.sinks.lock().unwrap().push((id, sink));
        self.call(start, Duration::from_secs(5)).map(|_| ())
    }

    pub fn remove_sink(&self, id: u64) {
        let empty = {
            let mut s = self.sinks.lock().unwrap();
            s.retain(|(i, _)| *i != id);
            s.is_empty()
        };
        if empty && self.alive() {
            let _ = self.call(json!({ "cmd": "stream", "on": false }), Duration::from_secs(2));
        }
    }

    /// Closes the helper's stdin (it winds down by itself: the VM helper shuts its guest down first) and waits up
    /// to `timeout` for it to exit, then kills it.
    pub fn close(&self, timeout: Duration) {
        self.stdin.lock().unwrap().take();
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let done = self.child.lock().unwrap().try_wait().map(|s| s.is_some()).unwrap_or(true);
            if done || std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        self.kill();
    }

    pub fn kill(&self) {
        self.alive.store(false, Ordering::SeqCst);
        let mut c = self.child.lock().unwrap();
        let _ = c.kill();
        let _ = c.wait();
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}
