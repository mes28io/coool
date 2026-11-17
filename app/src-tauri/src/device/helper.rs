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
    // FNV-1a: enough to tell builds apart.
    let hash = HELPER.iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3));
    let path = dir.join(format!("coool-sim-{:012x}", hash & 0xffff_ffff_ffff));
    if !path.exists() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let tmp = dir.join(format!(".coool-sim-{}", std::process::id()));
        std::fs::write(&tmp, HELPER).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        // Older builds' copies.
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if n.starts_with("coool-sim-") && e.path() != path {
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

pub struct Helper {
    stdin: Mutex<BufWriter<ChildStdin>>,
    child: Mutex<Child>,
    next: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    sinks: Mutex<Vec<(u64, FrameSink)>>,
    screen: (Mutex<Option<Result<Screen, String>>>, Condvar),
    alive: AtomicBool,
}

impl Helper {
    pub fn spawn(bin: &Path, udid: &str, developer_dir: Option<&str>) -> Result<Arc<Self>, String> {
        let mut cmd = Command::new(bin);
        cmd.arg(udid).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        if let Some(d) = developer_dir {
            cmd.env("COOOL_DEVELOPER_DIR", d);
        }
        let mut child = cmd.spawn().map_err(|e| format!("couldn't start the simulator helper: {e}"))?;
        let stdin = child.stdin.take().ok_or("helper stdin")?;
        let mut stdout = child.stdout.take().ok_or("helper stdout")?;
        let h = Arc::new(Self {

            stdin: Mutex::new(BufWriter::new(stdin)),
            child: Mutex::new(child),
            next: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            sinks: Mutex::new(Vec::new()),
            screen: (Mutex::new(None), Condvar::new()),
            alive: AtomicBool::new(true),
        });
        let weak = Arc::downgrade(&h);
        std::thread::Builder::new()
            .name(format!("coool-sim {udid}"))
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
                    h.died("the simulator helper stopped");
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
            _ => {}
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
            let mut w = self.stdin.lock().unwrap();
            let line = serde_json::to_string(&req).unwrap_or_default();
            if writeln!(w, "{line}").and_then(|_| w.flush()).is_err() {
                self.pending.lock().unwrap().remove(&id);
                return Err("the simulator helper isn't running".into());
            }
        }
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("the simulator didn't answer `{}` in time", req["cmd"].as_str().unwrap_or("?")))
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
