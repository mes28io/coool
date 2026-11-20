//! coool Remote, the Mac side (docs/REMOTE.md): watch and steer coool from a paired iPhone, through an end-to-end
//! encrypted relay.
//!
//! - [`proto`]: the protocol's cryptography and encodings (byte-identical to remote/phone/src/protocol.mjs).
//! - [`rules`]: what a remote command may do ("Rules on the Mac").
//! - [`mac`]: the engine: identity, devices, pairing, messages in and out.
//! - [`relay`]: the connection to the relay (Convex).
//! - [`keystore`]: where the private keys live (the macOS Keychain).
//!
//! [`Remote`] ties them together on a thread of its own: off until enabled, it then keeps a read session and a
//! live query on the relay, handles what arrives, and sends what changed about once a second.

pub mod keystore;
pub mod mac;
pub mod proto;
pub mod relay;
pub mod rules;

pub use mac::{Action, Device, DeviceView, Engine, Host, PairingView, Status};

use anyhow::{Result, anyhow};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct Remote {
    engine: Mutex<Option<Engine>>,
    keystore: Box<dyn keystore::KeyStore>,
    host: Arc<dyn Host>,
    dir: PathBuf,
    default_relay: String,
    access: Option<String>,
    transport: Mutex<Option<relay::Transport>>,
    stop: Mutex<Option<Arc<AtomicBool>>>,
    /// Wakes the worker for an early tick (the app saw a change).
    nudge: Mutex<Option<mpsc::Sender<()>>>,
}

impl Remote {
    /// Loads the saved state from `dir` (nothing touches the key store or the network unless Remote was left on).
    pub fn new(dir: PathBuf, keystore: Box<dyn keystore::KeyStore>, host: Arc<dyn Host>, default_relay: &str) -> Arc<Remote> {
        // `relay.json` beside the saved state names this Mac's relay and, for a private relay, its access key:
        // {"relay": "https://….convex.cloud", "access": "…"}. The app ships with no relay of its own.
        let own = std::fs::read_to_string(dir.join("relay.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
        let from = |k: &str| own.as_ref().and_then(|v| v.get(k)).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        let default_relay = from("relay").unwrap_or_else(|| default_relay.to_string());
        let access = from("access");
        let r = Arc::new(Remote { engine: Mutex::new(None), keystore, host, dir, default_relay, access, transport: Mutex::new(None), stop: Mutex::new(None), nudge: Mutex::new(None) });
        if Engine::load_saved(&r.dir).enabled {
            let _ = r.ensure_engine();
            r.start_worker();
        }
        r
    }

    /// The engine, made on first use: loads (or creates and stores) the identity.
    fn ensure_engine(&self) -> Result<()> {
        let mut e = self.engine.lock().unwrap();
        if e.is_some() {
            return Ok(());
        }
        let mut saved = Engine::load_saved(&self.dir);
        if saved.relay.is_empty() {
            saved.relay = self.default_relay.clone();
        }
        let identity = match self.keystore.load()? {
            Some(s) => proto::Identity::import(&s)?,
            None => {
                let id = proto::Identity::generate();
                self.keystore.save(&id.export())?;
                // A new identity is a new Mac to the relay: earlier devices can't talk to it.
                saved.mac_id = None;
                saved.devices.clear();
                id
            }
        };
        let mut eng = Engine::new(saved, identity, Some(self.dir.clone()));
        eng.access = self.access.clone();
        eng.save();
        *e = Some(eng);
        Ok(())
    }

    fn with<T>(&self, f: impl FnOnce(&mut Engine) -> T) -> Result<T> {
        self.ensure_engine()?;
        let mut g = self.engine.lock().unwrap();
        Ok(f(g.as_mut().expect("ensured")))
    }

    pub fn status(&self) -> Status {
        let now = Engine::now();
        if let Some(e) = self.engine.lock().unwrap().as_ref() {
            return e.status(now);
        }
        let saved = Engine::load_saved(&self.dir);
        Status { enabled: saved.enabled, connected: false, error: None, relay: if saved.relay.is_empty() { self.default_relay.clone() } else { saved.relay }, devices: saved.devices.iter().map(|d| DeviceView { id: d.device_id.clone(), name: d.name.clone(), added: d.added, last_seen: d.last_seen }).collect(), pairing: None, actions: vec![] }
    }

    pub fn set_enabled(self: &Arc<Self>, on: bool) -> Result<Status> {
        if on && self.status().relay.is_empty() {
            anyhow::bail!("Remote needs a relay of your own. See docs/REMOTE.md.");
        }
        if on {
            self.with(|e| {
                e.saved.enabled = true;
                e.error = None;
                e.save();
            })?;
            self.start_worker();
        } else {
            self.stop_worker();
            if self.engine.lock().unwrap().is_some() {
                self.with(|e| {
                    let t = self.transport.lock().unwrap().clone();
                    if let Some(t) = &t {
                        e.pair_cancel(t, Engine::now());
                    }
                    e.saved.enabled = false;
                    e.connected = false;
                    e.save();
                })?;
            }
            *self.transport.lock().unwrap() = None;
        }
        self.host.changed();
        Ok(self.status())
    }

    fn transport(&self) -> Result<relay::Transport> {
        self.transport.lock().unwrap().clone().ok_or_else(|| anyhow!("not connected to the relay yet"))
    }

    pub fn pair_start(&self) -> Result<PairingView> {
        let t = self.transport()?;
        let r = self.with(|e| e.pair_start(&t, Engine::now()))?;
        self.host.changed();
        r
    }

    pub fn pair_confirm(&self) -> Result<DeviceView> {
        let t = self.transport()?;
        let r = self.with(|e| e.pair_confirm(&t, Engine::now()))?;
        self.host.changed();
        self.nudge();
        r
    }

    pub fn pair_cancel(&self) -> Result<()> {
        let t = self.transport.lock().unwrap().clone();
        self.with(|e| match &t {
            Some(t) => e.pair_cancel(t, Engine::now()),
            None => {}
        })?;
        self.host.changed();
        Ok(())
    }

    pub fn remove_device(&self, id: &str) -> Result<()> {
        let t = self.transport.lock().unwrap().clone();
        let r = self.with(|e| e.remove_device(t.as_ref().map(|t| t as &dyn mac::RelayApi), id, Engine::now()))?;
        self.host.changed();
        r
    }

    /// Asks for an early tick (sessions or needs changed).
    pub fn nudge(&self) {
        if let Some(tx) = self.nudge.lock().unwrap().as_ref() {
            let _ = tx.send(());
        }
    }

    fn stop_worker(&self) {
        if let Some(s) = self.stop.lock().unwrap().take() {
            s.store(true, Ordering::Relaxed);
        }
        self.nudge();
        *self.nudge.lock().unwrap() = None;
    }

    fn start_worker(self: &Arc<Self>) {
        self.stop_worker();
        let stop = Arc::new(AtomicBool::new(false));
        *self.stop.lock().unwrap() = Some(stop.clone());
        let (ntx, nrx) = mpsc::channel::<()>();
        *self.nudge.lock().unwrap() = Some(ntx);
        let me = Arc::downgrade(self);
        let _ = std::thread::Builder::new().name("coool-remote".into()).spawn(move || worker(me, stop, nrx));
    }

    fn set_conn(&self, connected: bool, error: Option<String>) {
        let changed = {
            let mut g = self.engine.lock().unwrap();
            let Some(e) = g.as_mut() else { return };
            let changed = e.connected != connected || e.error != error;
            e.connected = connected;
            e.error = error;
            changed
        };
        if changed {
            self.host.changed();
        }
    }
}

/// The worker: connect, open a read session, follow `macInbox`, tick. Reconnects with a backoff.
fn worker(me: std::sync::Weak<Remote>, stop: Arc<AtomicBool>, nudges: mpsc::Receiver<()>) {
    let mut backoff = Duration::from_secs(2);
    'outer: while !stop.load(Ordering::Relaxed) {
        let Some(r) = me.upgrade() else { return };
        let url = r.with(|e| e.saved.relay.clone()).unwrap_or_default();
        let t = match relay::Transport::start(&url) {
            Ok(t) => t,
            Err(e) => {
                r.set_conn(false, Some(format!("Can't reach the relay: {e}")));
                drop(r);
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_secs(60));
                continue;
            }
        };
        let now = Engine::now();
        let setup = r.with(|e| -> Result<String> {
            e.register(&t, now)?;
            e.flush_revokes(&t, now);
            e.open_session(&t, now)
        });
        let token = match setup.and_then(|x| x) {
            Ok(tok) => tok,
            Err(e) => {
                r.set_conn(false, Some(format!("The relay refused this Mac: {e}")));
                drop(r);
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_secs(60));
                continue;
            }
        };
        let (utx, urx) = mpsc::channel();
        if t.subscribe("macInbox", serde_json::json!({ "token": token }), utx).is_err() {
            continue;
        }
        *r.transport.lock().unwrap() = Some(t.clone());
        r.set_conn(true, None);
        backoff = Duration::from_secs(2);
        let opened = Instant::now();
        let mut beat = Instant::now();
        let mut last_tick = Instant::now();
        let host = r.host.clone();
        let devices = |r: &Remote| {
            if let Ok(v) = t.query("macDevices", serde_json::json!({ "token": token })) {
                let _ = r.with(|e| e.note_devices(&v));
            }
        };
        devices(&r);
        drop(r);
        loop {
            if stop.load(Ordering::Relaxed) {
                t.unsubscribe();
                break 'outer;
            }
            let Some(r) = me.upgrade() else { return };
            match urx.recv_timeout(Duration::from_millis(250)) {
                Ok(Ok(v)) => {
                    if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
                        // The session ended (expired, or the relay restarted it): open a new one.
                        break;
                    }
                    let _ = r.with(|e| e.handle_inbox(&t, host.as_ref(), &v, Engine::now()));
                }
                Ok(Err(e)) => {
                    r.set_conn(false, Some(format!("Lost the relay: {e}")));
                    break;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            // Ticks: about once a second, or at once when nudged.
            let nudged = nudges.try_recv().is_ok();
            let due = nudged || last_tick.elapsed() >= Duration::from_secs(1);
            if due {
                last_tick = Instant::now();
            }
            if due {
                let _ = r.with(|e| e.tick(&t, host.as_ref(), Engine::now()));
            }
            if beat.elapsed() >= Duration::from_secs(60) {
                beat = Instant::now();
                let _ = r.with(|e| e.heartbeat(&t, Engine::now()));
                devices(&r);
            }
            if opened.elapsed() >= Duration::from_secs(6 * 3600) {
                break;
            }
        }
        if let Some(r) = me.upgrade() {
            *r.transport.lock().unwrap() = None;
            r.set_conn(false, None);
        }
    }
}

#[cfg(test)]
mod tests;
