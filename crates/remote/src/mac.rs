//! The Mac's Remote engine: its identity, the paired devices, pairing, and every message in and out.
//!
//! [`Engine`] is the logic, driven synchronously and talking to the relay only through [`RelayApi`] (so the tests
//! run it against a fake relay); [`crate::Remote`] runs it against the real one. What reaches the app goes through
//! [`Host`] in the narrow forms of [`crate::rules`].

use crate::proto::{self, Claim, CodeInput, Dir, Envelope, Identity, SessionKeys};
use crate::rules::{self, Answer, Cli, Limiter, Need, Project, SessionInfo, Start};
use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use zeroize::Zeroizing;

/// Pairing codes live two minutes (the relay caps it there too).
pub const PAIRING_TTL_MS: u64 = 120_000;
/// Live changes (`session`, `need`, `need_gone`) go to devices the relay saw within this long; others get a fresh
/// `snapshot` when they next say `hello`.
pub const ACTIVE_MS: u64 = 10 * 60_000;
const MAX_SESSIONS: usize = 100;
const MAX_ACTIONS: usize = 100;

/// The app's side: what the phone may see, and the app's own paths for what it may do.
pub trait Host: Send + Sync + 'static {
    fn sessions(&self) -> Vec<SessionInfo>;
    fn needs(&self) -> Vec<Need>;
    fn projects(&self) -> Vec<Project>;
    /// The CLI's default permission mode for a new chat, as the person set it (filtered by [`rules::start_mode`]).
    fn default_mode(&self, cli: Cli) -> Option<String>;
    fn chat_tail(&self, session: &str, n: usize) -> Result<Value, String>;
    /// Each action below names the device (`by`) so the app can show "Allowed from <name>" where it happened.
    fn answer(&self, need: &Need, answer: &Answer, by: &str) -> Result<(), String>;
    fn send(&self, session: &str, text: &str, by: &str) -> Result<(), String>;
    fn stop(&self, session: &str, by: &str) -> Result<(), String>;
    /// Starts a chat as checked by [`rules::check_start`] (that mode, nothing else); returns its session id or key.
    fn start(&self, start: &Start, by: &str) -> Result<String, String>;
    /// Remote's status changed (devices, pairing, connection, a new action): the UI should look again.
    fn changed(&self);
}

/// The relay, as the engine uses it.
pub trait RelayApi {
    fn mutation(&self, name: &str, args: Value) -> Result<Value>;
}

impl RelayApi for crate::relay::Transport {
    fn mutation(&self, name: &str, args: Value) -> Result<Value> {
        crate::relay::Transport::mutation(self, name, args)
    }
}

fn ok_or_refused(r: Value) -> Result<Value> {
    if r.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(r)
    } else {
        Err(anyhow!("the relay refused: {}", r.get("code").and_then(Value::as_str).unwrap_or("unknown")))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Device {
    pub device_id: String,
    pub name: String,
    pub sign_pub: String,
    pub box_pub: String,
    pub added: u64,
    #[serde(default)]
    pub last_seen: u64,
    #[serde(default)]
    pub send_counter: u64,
    #[serde(default)]
    pub recv_high_water: u64,
}

/// What `remote.json` holds. No private key: those are in the key store.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Saved {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub relay: String,
    #[serde(default)]
    pub mac_id: Option<String>,
    #[serde(default)]
    pub devices: Vec<Device>,
    /// Devices removed here whose revocation the relay hasn't confirmed yet (retried on connect).
    #[serde(default)]
    pub pending_revokes: Vec<String>,
}

/// One remote action, as recorded (`remote-actions.jsonl`) and shown.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Action {
    pub at: u64,
    pub device_id: String,
    pub device: String,
    /// "answer", "send", "stop", "start", or "refused" (a message the Mac would not act on).
    pub kind: String,
    pub session: Option<String>,
    pub detail: String,
    pub ok: bool,
}

struct Pairing {
    pairing_id: String,
    secret: Zeroizing<String>,
    keys: proto::PairingKeys,
    url: String,
    expires_at: u64,
    claim: Option<(Claim, String, String)>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct PairingView {
    pub url: String,
    pub expires_at: u64,
    /// Set once a phone claimed it: the name it gave and the code to compare.
    pub claim: Option<ClaimView>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ClaimView {
    pub name: String,
    pub code: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub added: u64,
    pub last_seen: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Status {
    pub enabled: bool,
    pub connected: bool,
    pub error: Option<String>,
    pub relay: String,
    pub devices: Vec<DeviceView>,
    pub pairing: Option<PairingView>,
    pub actions: Vec<Action>,
}

pub struct Engine {
    pub saved: Saved,
    dir: Option<PathBuf>,
    identity: Identity,
    pairing: Option<Pairing>,
    keys: HashMap<String, SessionKeys>,
    limiter: Limiter,
    last_sessions: HashMap<String, SessionInfo>,
    last_needs: HashMap<String, Need>,
    /// When the relay last saw each device (its `devices` list).
    seen: HashMap<String, u64>,
    pub actions: Vec<Action>,
    pub connected: bool,
    pub error: Option<String>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Engine {
    /// `dir`: where `remote.json` and the action record live (None: nowhere, for tests).
    pub fn new(saved: Saved, identity: Identity, dir: Option<PathBuf>) -> Self {
        let mut saved = saved;
        if saved.mac_id.is_none() {
            saved.mac_id = Some(proto::random_id());
        }
        Engine { saved, dir, identity, pairing: None, keys: HashMap::new(), limiter: Limiter::default(), last_sessions: HashMap::new(), last_needs: HashMap::new(), seen: HashMap::new(), actions: Vec::new(), connected: false, error: None }
    }

    pub fn load_saved(dir: &std::path::Path) -> Saved {
        std::fs::read(dir.join("remote.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self) {
        let Some(dir) = &self.dir else { return };
        let _ = std::fs::create_dir_all(dir);
        let tmp = dir.join("remote.json.tmp");
        if let Ok(b) = serde_json::to_vec_pretty(&self.saved) {
            #[cfg(unix)]
            {
                use std::io::Write;
                use std::os::unix::fs::OpenOptionsExt;
                if let Ok(mut f) = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp) {
                    let _ = f.write_all(&b);
                }
            }
            #[cfg(not(unix))]
            let _ = std::fs::write(&tmp, &b);
            let _ = std::fs::rename(&tmp, dir.join("remote.json"));
        }
    }

    pub fn mac_id(&self) -> &str {
        self.saved.mac_id.as_deref().unwrap_or_default()
    }

    /// `args` plus `ts` and the signature over `fields` (remote/relay/convex/lib.ts `signedBytes`).
    fn signed(&self, fun: &str, fields: &[&str], mut args: Value, now: u64) -> Value {
        let sig = self.identity.sign(&proto::request_bytes(fun, fields, now));
        args["ts"] = json!(now);
        args["sig"] = json!(sig);
        args
    }

    fn call(&self, relay: &dyn RelayApi, fun: &str, fields: &[&str], args: Value, now: u64) -> Result<Value> {
        ok_or_refused(relay.mutation(fun, self.signed(fun, fields, args, now))?)
    }

    pub fn status(&self, now: u64) -> Status {
        Status {
            enabled: self.saved.enabled,
            connected: self.connected,
            error: self.error.clone(),
            relay: self.saved.relay.clone(),
            devices: self.saved.devices.iter().map(|d| DeviceView { id: d.device_id.clone(), name: d.name.clone(), added: d.added, last_seen: self.seen.get(&d.device_id).copied().unwrap_or(d.last_seen).max(d.last_seen) }).collect(),
            pairing: self.pairing.as_ref().filter(|p| p.expires_at > now || p.claim.is_some()).map(|p| PairingView { url: p.url.clone(), expires_at: p.expires_at, claim: p.claim.as_ref().map(|(_, name, code)| ClaimView { name: name.clone(), code: code.clone() }) }),
            actions: self.actions.iter().rev().take(20).cloned().collect(),
        }
    }

    // ------------------------------------------------------------ setup and session

    pub fn register(&self, relay: &dyn RelayApi, now: u64) -> Result<()> {
        let (m, s, b) = (self.mac_id().to_string(), self.identity.sign_pub(), self.identity.box_pub());
        self.call(relay, "registerMac", &[&m, &s, &b], json!({"macId": m, "signPub": s, "boxPub": b}), now).map(|_| ())
    }

    /// Opens a read session; returns the token for `macInbox`.
    pub fn open_session(&self, relay: &dyn RelayApi, now: u64) -> Result<String> {
        let token = proto::b64u(&proto::random_bytes::<32>());
        let hash = proto::sha256_hex(&token);
        let m = self.mac_id().to_string();
        self.call(relay, "openSession", &["mac", &m, "", &hash], json!({"role": "mac", "macId": m, "deviceId": "", "tokenHash": hash}), now)?;
        Ok(token)
    }

    pub fn heartbeat(&self, relay: &dyn RelayApi, now: u64) -> Result<()> {
        let m = self.mac_id().to_string();
        self.call(relay, "heartbeat", &[&m], json!({"macId": m}), now).map(|_| ())
    }

    /// Retries revocations the relay hasn't confirmed.
    pub fn flush_revokes(&mut self, relay: &dyn RelayApi, now: u64) {
        let pending = std::mem::take(&mut self.saved.pending_revokes);
        for id in pending {
            if self.revoke_at_relay(relay, &id, now).is_err() {
                self.saved.pending_revokes.push(id);
            }
        }
        self.save();
    }

    fn revoke_at_relay(&self, relay: &dyn RelayApi, device_id: &str, now: u64) -> Result<()> {
        let m = self.mac_id().to_string();
        match self.call(relay, "revokeDevice", &[&m, device_id], json!({"macId": m, "deviceId": device_id}), now) {
            Ok(_) => Ok(()),
            // Never got as far as the relay (a pairing that wasn't confirmed there): nothing to revoke.
            Err(e) if e.to_string().contains("unknown_device") => Ok(()),
            Err(e) => Err(e),
        }
    }

    // ------------------------------------------------------------ pairing

    pub fn pair_start(&mut self, relay: &dyn RelayApi, now: u64) -> Result<PairingView> {
        let secret = Zeroizing::new(proto::b64u(&proto::random_bytes::<32>()));
        let keys = proto::pairing_keys(&proto::unb64u(&secret, Some(32))?);
        let pairing_id = proto::random_id();
        let expires_at = now + PAIRING_TTL_MS;
        let m = self.mac_id().to_string();
        let relay_key = proto::b64u(keys.relay.as_ref());
        let exp = expires_at.to_string();
        let r = self.call(relay, "createPairing", &[&m, &pairing_id, &relay_key, &exp], json!({"macId": m, "pairingId": pairing_id, "relayKey": relay_key, "expiresAt": expires_at}), now)?;
        let expires_at = r.get("expiresAt").and_then(Value::as_f64).map(|x| x as u64).unwrap_or(expires_at);
        let url = proto::pair_url(&self.saved.relay, &m, &pairing_id, &secret, &self.identity.sign_pub(), &self.identity.box_pub());
        self.pairing = Some(Pairing { pairing_id, secret, keys, url, expires_at, claim: None });
        Ok(self.status(now).pairing.expect("just made"))
    }

    /// A claim the relay holds for the open pairing: kept only if its proof checks, with the name and code to show.
    fn on_claim(&mut self, c: Claim, now: u64) {
        let mac_id = self.mac_id().to_string();
        let (sign_pub, box_pub) = (self.identity.sign_pub(), self.identity.box_pub());
        let Some(p) = self.pairing.as_mut() else { return };
        if c.pairing_id != p.pairing_id || p.claim.is_some() {
            return;
        }
        if !proto::proof_ok(p.keys.mac.as_ref(), &c) || !proto::is_id(&c.device_id) {
            self.error = Some("A pairing attempt failed its check and was ignored.".into());
            return;
        }
        let Ok(name) = proto::open_name(p.keys.name.as_ref(), &c.pairing_id, &c.device_id, &c.name_box) else {
            self.error = Some("A pairing attempt failed its check and was ignored.".into());
            return;
        };
        let name: String = name.chars().filter(|ch| !ch.is_control()).take(60).collect();
        let name = if name.trim().is_empty() { "iPhone".to_string() } else { name.trim().to_string() };
        let code = proto::pairing_code(p.keys.code.as_ref(), &CodeInput { pairing_id: &c.pairing_id, mac_id: &mac_id, mac_sign_pub: &sign_pub, mac_box_pub: &box_pub, device_id: &c.device_id, dev_sign_pub: &c.sign_pub, dev_box_pub: &c.box_pub });
        let _ = now;
        p.claim = Some((c, name, code));
    }

    /// The click on Pair: only now does the relay create the device, and only now is it on the Mac's list.
    pub fn pair_confirm(&mut self, relay: &dyn RelayApi, now: u64) -> Result<DeviceView> {
        let p = self.pairing.as_ref().ok_or_else(|| anyhow!("no pairing in progress"))?;
        let Some((c, name, _)) = p.claim.clone() else { bail!("no phone has scanned the code yet") };
        let m = self.mac_id().to_string();
        self.call(relay, "confirmPairing", &[&m, &p.pairing_id, &c.device_id], json!({"macId": m, "pairingId": p.pairing_id, "deviceId": c.device_id}), now)?;
        let d = Device { device_id: c.device_id.clone(), name: name.clone(), sign_pub: c.sign_pub, box_pub: c.box_pub, added: now, last_seen: now, send_counter: 0, recv_high_water: 0 };
        self.saved.devices.retain(|x| x.device_id != d.device_id);
        self.saved.devices.push(d);
        self.pairing = None;
        self.save();
        Ok(DeviceView { id: c.device_id, name, added: now, last_seen: now })
    }

    pub fn pair_cancel(&mut self, relay: &dyn RelayApi, now: u64) {
        if let Some(p) = self.pairing.take() {
            let m = self.mac_id().to_string();
            let _ = self.call(relay, "cancelPairing", &[&m, &p.pairing_id], json!({"macId": m, "pairingId": p.pairing_id}), now);
            drop(p.secret);
        }
    }

    /// Remove: the device's keys go from the Mac at once (anything it sends is refused here from now on), then the
    /// relay revokes it; if the relay can't be reached the revocation is retried on the next connect.
    pub fn remove_device(&mut self, relay: Option<&dyn RelayApi>, device_id: &str, now: u64) -> Result<()> {
        let before = self.saved.devices.len();
        self.saved.devices.retain(|d| d.device_id != device_id);
        if self.saved.devices.len() == before {
            bail!("no such device");
        }
        self.keys.remove(device_id);
        self.seen.remove(device_id);
        let revoked = relay.map(|r| self.revoke_at_relay(r, device_id, now).is_ok()).unwrap_or(false);
        if !revoked && !self.saved.pending_revokes.iter().any(|x| x == device_id) {
            self.saved.pending_revokes.push(device_id.to_string());
        }
        self.save();
        Ok(())
    }

    // ------------------------------------------------------------ messages

    fn keys_for(&mut self, device_id: &str) -> Result<&SessionKeys> {
        if !self.keys.contains_key(device_id) {
            let d = self.saved.devices.iter().find(|d| d.device_id == device_id).ok_or_else(|| anyhow!("unknown device"))?;
            let shared = self.identity.shared(&d.box_pub)?;
            let k = proto::session_keys(shared.as_ref(), self.saved.mac_id.as_deref().unwrap_or_default(), device_id, &self.identity.box_pub(), &d.box_pub);
            self.keys.insert(device_id.to_string(), k);
        }
        Ok(&self.keys[device_id])
    }

    /// Seals and sends one message to a device.
    pub fn send_to(&mut self, relay: &dyn RelayApi, device_id: &str, t: &str, b: Value, now: u64) -> Result<()> {
        let env = serde_json::to_vec(&Envelope::new(t, b, now))?;
        let mac_id = self.mac_id().to_string();
        let last = self.saved.devices.iter().find(|d| d.device_id == device_id).ok_or_else(|| anyhow!("unknown device"))?.send_counter;
        let counter = proto::next_counter(last, now);
        let key = self.keys_for(device_id)?.m2d.clone();
        let ct = proto::seal(key.as_ref(), Dir::M2d, &mac_id, device_id, counter, &env)?;
        if let Some(d) = self.saved.devices.iter_mut().find(|d| d.device_id == device_id) {
            d.send_counter = counter;
        }
        let (c, h) = (counter.to_string(), proto::sha256_hex(&ct));
        self.call(relay, "send", &[&mac_id, device_id, "m2d", &c, &h], json!({"macId": mac_id, "deviceId": device_id, "dir": "m2d", "counter": counter, "ciphertext": ct}), now)?;
        Ok(())
    }

    fn record(&mut self, host: &dyn Host, a: Action) {
        if let Some(dir) = &self.dir {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("remote-actions.jsonl"))
                && let Ok(line) = serde_json::to_string(&a)
            {
                let _ = writeln!(f, "{line}");
            }
        }
        self.actions.push(a);
        if self.actions.len() > MAX_ACTIONS {
            self.actions.remove(0);
        }
        host.changed();
    }

    /// One answer of the live `macInbox` query: claims for the open pairing, the devices' last-seen times, and the
    /// devices' messages (each handled at most once, then acknowledged so the relay deletes it).
    pub fn handle_inbox(&mut self, relay: &dyn RelayApi, host: &dyn Host, inbox: &Value, now: u64) {
        if let Some(cs) = inbox.get("claims").and_then(Value::as_array) {
            let had = self.pairing.as_ref().is_some_and(|p| p.claim.is_some());
            for c in cs {
                if let Ok(c) = serde_json::from_value::<Claim>(c.clone()) {
                    self.on_claim(c, now);
                }
            }
            if !had && self.pairing.as_ref().is_some_and(|p| p.claim.is_some()) {
                host.changed();
            }
        }
        if let Some(ds) = inbox.get("devices").and_then(Value::as_array) {
            for d in ds {
                if let (Some(id), Some(t)) = (d.get("deviceId").and_then(Value::as_str), d.get("lastSeen").and_then(Value::as_f64)) {
                    self.seen.insert(id.to_string(), t as u64);
                }
            }
        }
        let mut msgs: Vec<&Value> = inbox.get("messages").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
        msgs.sort_by_key(|m| m.get("counter").and_then(Value::as_f64).unwrap_or(0.0) as u64);
        let mut acks: HashMap<String, u64> = HashMap::new();
        for m in msgs {
            let (Some(device_id), Some(counter), Some(ct)) = (m.get("deviceId").and_then(Value::as_str), m.get("counter").and_then(Value::as_f64), m.get("ciphertext").and_then(Value::as_str)) else { continue };
            let counter = counter as u64;
            let queued = m.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0) as u64;
            let a = acks.entry(device_id.to_string()).or_default();
            *a = (*a).max(counter);
            self.take_message(relay, host, device_id, counter, ct, queued, now);
        }
        for (device_id, up_to) in acks {
            let m = self.mac_id().to_string();
            let u = up_to.to_string();
            let _ = self.call(relay, "ack", &[&m, &device_id, "d2m", &u], json!({"macId": m, "deviceId": device_id, "dir": "d2m", "upTo": up_to}), now);
        }
        self.save();
    }

    fn refuse(&mut self, host: &dyn Host, device_id: &str, detail: &str, now: u64) {
        let device = self.saved.devices.iter().find(|d| d.device_id == device_id).map(|d| d.name.clone()).unwrap_or_else(|| "a removed device".into());
        self.record(host, Action { at: now, device_id: device_id.into(), device, kind: "refused".into(), session: None, detail: detail.into(), ok: false });
    }

    /// One message from a device: refused unless the device is on the Mac's list, its counter is new, it decrypts,
    /// and it is fresh. Returns whether it was acted on.
    pub fn take_message(&mut self, relay: &dyn RelayApi, host: &dyn Host, device_id: &str, counter: u64, ct: &str, queued: u64, now: u64) -> bool {
        let Some(hw) = self.saved.devices.iter().find(|d| d.device_id == device_id).map(|d| d.recv_high_water) else {
            self.refuse(host, device_id, "a message from a device that is not paired", now);
            return false;
        };
        if counter <= hw {
            // Already handled (the live query shows a message until it is acknowledged), or replayed.
            return false;
        }
        let mac_id = self.mac_id().to_string();
        let Ok(key) = self.keys_for(device_id).map(|k| k.d2m.clone()) else { return false };
        let Ok(pt) = proto::open(key.as_ref(), Dir::D2m, &mac_id, device_id, counter, ct) else {
            self.refuse(host, device_id, "a message that does not decrypt", now);
            return false;
        };
        if let Some(d) = self.saved.devices.iter_mut().find(|d| d.device_id == device_id) {
            d.recv_high_water = counter;
            d.last_seen = d.last_seen.max(now);
        }
        let Ok(env) = serde_json::from_slice::<Envelope>(&pt) else { return false };
        if env.v != proto::VERSION {
            return false;
        }
        self.dispatch(relay, host, device_id, env, queued, now)
    }

    fn reply(&mut self, relay: &dyn RelayApi, device_id: &str, of: &str, t: &str, r: Result<Value, String>, now: u64) {
        let b = match r {
            Ok(extra) => {
                let mut b = json!({"of": of, "t": t, "ok": true});
                if let Value::Object(m) = extra {
                    b.as_object_mut().unwrap().extend(m);
                }
                b
            }
            Err(e) => json!({"of": of, "t": t, "ok": false, "error": e}),
        };
        let _ = self.send_to(relay, device_id, "result", b, now);
    }

    fn snapshot_to(&mut self, relay: &dyn RelayApi, host: &dyn Host, device_id: &str, now: u64) {
        let mut sessions = host.sessions();
        sessions.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
        sessions.truncate(MAX_SESSIONS);
        let needs = host.needs();
        let projects: Vec<Value> = host.projects().into_iter().map(|p| json!({"id": p.id, "name": p.name})).collect();
        let _ = self.send_to(relay, device_id, "snapshot", json!({"sessions": sessions, "needs": needs}), now);
        let _ = self.send_to(relay, device_id, "projects", json!({"projects": projects}), now);
    }

    fn dispatch(&mut self, relay: &dyn RelayApi, host: &dyn Host, device_id: &str, env: Envelope, queued: u64, now: u64) -> bool {
        let t = env.t.as_str();
        let acting = matches!(t, "answer" | "send" | "stop" | "start");
        if acting && rules::expired(env.at, queued, now) {
            self.refuse(host, device_id, &format!("an expired {t} (older than 60 seconds)"), now);
            self.reply(relay, device_id, &env.id, t, Err("expired".into()), now);
            return false;
        }
        let name = self.saved.devices.iter().find(|d| d.device_id == device_id).map(|d| d.name.clone()).unwrap_or_default();
        match t {
            "hello" | "get_snapshot" => {
                self.snapshot_to(relay, host, device_id, now);
                true
            }
            "ack" => true,
            "get_chat" => {
                let s = env.b.get("session").and_then(Value::as_str).unwrap_or("").to_string();
                let n = env.b.get("n").and_then(Value::as_u64).unwrap_or(30).min(50) as usize;
                match host.chat_tail(&s, n) {
                    Ok(items) => {
                        let _ = self.send_to(relay, device_id, "chat_tail", json!({"session": s, "items": items}), now);
                    }
                    Err(e) => self.reply(relay, device_id, &env.id, t, Err(e), now),
                }
                true
            }
            "answer" | "send" | "stop" | "start" => {
                let kind: &'static str = match t {
                    "answer" => "answer",
                    "send" => "send",
                    "stop" => "stop",
                    _ => "start",
                };
                if !self.limiter.allow(device_id, kind, now) {
                    self.refuse(host, device_id, &format!("too many {t} commands in a minute"), now);
                    self.reply(relay, device_id, &env.id, t, Err("rate_limited".into()), now);
                    return false;
                }
                let (session, detail, r) = self.act(host, kind, &env.b, &name);
                let ok = r.is_ok();
                self.record(host, Action { at: now, device_id: device_id.into(), device: name, kind: kind.into(), session, detail, ok });
                self.reply(relay, device_id, &env.id, t, r, now);
                ok
            }
            // Unknown types are ignored, so either side can be newer.
            _ => false,
        }
    }

    /// The four commands that act, after the checks: (session, what, outcome).
    fn act(&mut self, host: &dyn Host, kind: &str, b: &Value, by: &str) -> (Option<String>, String, Result<Value, String>) {
        let session = b.get("session").and_then(Value::as_str).map(str::to_string);
        match kind {
            "answer" => {
                let id = b.get("need").and_then(Value::as_str).unwrap_or("");
                let Some(need) = host.needs().into_iter().find(|n| n.id == id) else {
                    return (None, "answer to a request that is no longer pending".into(), Err("no such request".into()));
                };
                let r = rules::check_answer(&need, b).and_then(|a| {
                    host.answer(&need, &a, by)?;
                    Ok(a)
                });
                let what = match &r {
                    Ok(Answer::AllowOnce) => format!("allowed {}", need.tool),
                    Ok(Answer::Deny) => format!("denied {}", need.tool),
                    Ok(Answer::Picks(_)) => "answered a question".into(),
                    Err(e) => format!("answer refused: {e}"),
                };
                (Some(need.session.clone()), what, r.map(|_| json!({})))
            }
            "send" => {
                let r = rules::check_text(b).and_then(|text| self.known_chat(host, session.as_deref()).and_then(|s| host.send(&s, &text, by)));
                (session, "sent a message".into(), r.map(|_| json!({})))
            }
            "stop" => {
                let r = self.known_chat(host, session.as_deref()).and_then(|s| host.stop(&s, by));
                (session, "stopped the chat".into(), r.map(|_| json!({})))
            }
            _ => {
                let projects = host.projects();
                match rules::check_start(b, &projects, |cli| host.default_mode(cli)) {
                    Ok(s) => {
                        let what = format!("started a chat in {} ({})", s.project.name, s.mode);
                        let r = host.start(&s, by).map(|id| json!({"session": id, "mode": s.mode}));
                        (r.as_ref().ok().and_then(|v| v["session"].as_str().map(str::to_string)), what, r)
                    }
                    Err(e) => (None, format!("start refused: {e}"), Err(e)),
                }
            }
        }
    }

    fn known_chat(&self, host: &dyn Host, session: Option<&str>) -> Result<String, String> {
        let s = session.ok_or("missing session")?;
        match host.sessions().into_iter().find(|x| x.id == s) {
            Some(x) if x.chat => Ok(x.id),
            Some(_) => Err("only chats coool runs can be reached from the phone".into()),
            None => Err("no such session".into()),
        }
    }

    /// Sends what changed since the last tick (`session`, `need`, `need_gone`) to the devices in use.
    pub fn tick(&mut self, relay: &dyn RelayApi, host: &dyn Host, now: u64) {
        let sessions: HashMap<String, SessionInfo> = host.sessions().into_iter().map(|s| (s.id.clone(), s)).collect();
        let needs: HashMap<String, Need> = host.needs().into_iter().map(|n| (n.id.clone(), n)).collect();
        let mut out: Vec<(&str, Value)> = Vec::new();
        for (id, s) in &sessions {
            if self.last_sessions.get(id) != Some(s) {
                out.push(("session", json!(s)));
            }
        }
        for id in self.last_sessions.keys() {
            if !sessions.contains_key(id) {
                out.push(("session", json!({"id": id, "gone": true})));
            }
        }
        for (id, n) in &needs {
            if !self.last_needs.contains_key(id) {
                out.push(("need", json!(n)));
            }
        }
        for id in self.last_needs.keys() {
            if !needs.contains_key(id) {
                out.push(("need_gone", json!({"id": id})));
            }
        }
        self.last_sessions = sessions;
        self.last_needs = needs;
        if out.is_empty() {
            return;
        }
        let active: Vec<String> = self.saved.devices.iter().filter(|d| now.saturating_sub(self.seen.get(&d.device_id).copied().unwrap_or(0).max(d.last_seen)) < ACTIVE_MS).map(|d| d.device_id.clone()).collect();
        for d in active {
            for (t, b) in &out {
                let _ = self.send_to(relay, &d, t, b.clone(), now);
            }
        }
        self.save();
    }

    pub fn now() -> u64 {
        now_ms()
    }
}
