//! The Mac's half of the threat model and the rules, against a fake relay and a fake app; and the shared vectors.

use crate::mac::{Engine, Host, RelayApi, Saved};
use crate::proto::{self, Claim, Dir, Envelope, Identity};
use crate::rules::{Answer, Cli, Need, Project, SessionInfo, Start, project_id};
use serde_json::{Value, json};
use std::sync::Mutex;

// ---------------------------------------------------------------- fakes

#[derive(Default)]
struct FakeRelay {
    calls: Mutex<Vec<(String, Value)>>,
    /// Functions that answer `{ok: false}`.
    refuse: Mutex<Vec<&'static str>>,
}

impl RelayApi for FakeRelay {
    fn mutation(&self, name: &str, args: Value) -> anyhow::Result<Value> {
        self.calls.lock().unwrap().push((name.to_string(), args));
        if self.refuse.lock().unwrap().contains(&name) {
            return Ok(json!({"ok": false, "code": "unreachable"}));
        }
        Ok(json!({"ok": true}))
    }
}

impl FakeRelay {
    fn sent(&self) -> Vec<Value> {
        self.calls.lock().unwrap().iter().filter(|(n, _)| n == "send").map(|(_, a)| a.clone()).collect()
    }
}

#[derive(Default)]
struct FakeHost {
    calls: Mutex<Vec<String>>,
    answers: Mutex<Vec<Answer>>,
    starts: Mutex<Vec<(String, Cli, String)>>,
    needs: Mutex<Vec<Need>>,
}

const PROJECT: &str = "/private/tmp/coool-remote-test/app";

impl Host for FakeHost {
    fn sessions(&self) -> Vec<SessionInfo> {
        vec![
            SessionInfo { id: "claude:chat1".into(), title: "Invented chat".into(), project: "app".into(), cli: Cli::Claude, state: "idle".into(), model: "haiku".into(), last_activity: 5, chat: true },
            SessionInfo { id: "claude:term".into(), title: "A terminal session".into(), project: "app".into(), cli: Cli::Claude, state: "idle".into(), model: "".into(), last_activity: 4, chat: false },
        ]
    }
    fn needs(&self) -> Vec<Need> {
        self.needs.lock().unwrap().clone()
    }
    fn projects(&self) -> Vec<Project> {
        vec![Project { id: project_id(PROJECT), name: "app".into(), path: PROJECT.into() }]
    }
    fn default_mode(&self, _: Cli) -> Option<String> {
        // The person's default is Bypass: a remote start must not use it.
        Some("bypassPermissions".into())
    }
    fn chat_tail(&self, _: &str, _: usize) -> Result<Value, String> {
        Ok(json!([]))
    }
    fn answer(&self, need: &Need, a: &Answer, by: &str) -> Result<(), String> {
        self.calls.lock().unwrap().push(format!("answer {} by {by}", need.id));
        self.answers.lock().unwrap().push(a.clone());
        Ok(())
    }
    fn send(&self, s: &str, text: &str, by: &str) -> Result<(), String> {
        self.calls.lock().unwrap().push(format!("send {s} {text} by {by}"));
        Ok(())
    }
    fn stop(&self, s: &str, by: &str) -> Result<(), String> {
        self.calls.lock().unwrap().push(format!("stop {s} by {by}"));
        Ok(())
    }
    fn start(&self, s: &Start, by: &str) -> Result<String, String> {
        self.calls.lock().unwrap().push(format!("start by {by}"));
        self.starts.lock().unwrap().push((s.project.path.clone(), s.cli, s.mode.to_string()));
        Ok("claude:new".into())
    }
    fn changed(&self) {}
}

impl FakeHost {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

/// A phone: its keys and counter, sealing messages for the Mac and opening the Mac's.
struct TestPhone {
    id: Identity,
    device_id: String,
    counter: u64,
}

impl TestPhone {
    fn new() -> Self {
        TestPhone { id: Identity::generate(), device_id: proto::random_id(), counter: 0 }
    }
    fn keys(&self, mac: &Engine, mac_box_pub: &str) -> proto::SessionKeys {
        let shared = self.id.shared(mac_box_pub).unwrap();
        proto::session_keys(shared.as_ref(), mac.mac_id(), &self.device_id, mac_box_pub, &self.id.box_pub())
    }
    /// (counter, ciphertext) of a message sent `age_ms` ago.
    fn seal(&mut self, mac: &Engine, mac_box_pub: &str, t: &str, b: Value, now: u64, age_ms: u64) -> (u64, String) {
        self.counter = proto::next_counter(self.counter, now);
        let env = serde_json::to_vec(&Envelope::new(t, b, now - age_ms)).unwrap();
        let ct = proto::seal(self.keys(mac, mac_box_pub).d2m.as_ref(), Dir::D2m, mac.mac_id(), &self.device_id, self.counter, &env).unwrap();
        (self.counter, ct)
    }
    /// The Mac's messages to this phone among the relay calls, decrypted.
    fn received(&self, mac: &Engine, mac_box_pub: &str, relay: &FakeRelay) -> Vec<Envelope> {
        let k = self.keys(mac, mac_box_pub);
        relay
            .sent()
            .into_iter()
            .filter(|a| a["deviceId"] == self.device_id.as_str())
            .map(|a| {
                let pt = proto::open(k.m2d.as_ref(), Dir::M2d, mac.mac_id(), &self.device_id, a["counter"].as_u64().unwrap(), a["ciphertext"].as_str().unwrap()).unwrap();
                serde_json::from_slice(&pt).unwrap()
            })
            .collect()
    }
}

const NOW: u64 = 1_763_640_000_000;

/// A Mac with one phone paired through the real pairing steps (claim checked, then the click).
fn paired() -> (Engine, String, FakeRelay, FakeHost, TestPhone) {
    let mac_id = Identity::generate();
    let mac_box_pub = mac_id.box_pub();
    let mut mac = Engine::new(Saved { enabled: true, relay: "https://example.convex.cloud".into(), ..Default::default() }, mac_id, None);
    let relay = FakeRelay::default();
    let host = FakeHost::default();
    let view = mac.pair_start(&relay, NOW).unwrap();
    let mut phone = TestPhone::new();
    let claim = claim_for(&view.url, &phone, "Ada's iPhone", None);
    mac.handle_inbox(&relay, &host, &json!({"ok": true, "claims": [claim], "messages": [], "devices": []}), NOW);
    let code = mac.status(NOW).pairing.unwrap().claim.unwrap().code;
    assert_eq!(code.len(), 6);
    assert!(mac.saved.devices.is_empty(), "not paired before the click");
    mac.pair_confirm(&relay, NOW).unwrap();
    assert_eq!(mac.saved.devices.len(), 1);
    phone.counter = 0;
    (mac, mac_box_pub, relay, host, phone)
}

fn query(url: &str, k: &str) -> String {
    url.split(['?', '&']).find_map(|p| p.strip_prefix(&format!("{k}="))).unwrap().to_string()
}

/// The phone's claim of the pairing in `url` (as remote/phone/src/phone.mjs makes it). `secret`: a wrong one.
fn claim_for(url: &str, phone: &TestPhone, name: &str, secret: Option<[u8; 32]>) -> Value {
    let s = secret.map(|s| s.to_vec()).unwrap_or_else(|| proto::unb64u(&query(url, "s"), Some(32)).unwrap());
    let k = proto::pairing_keys(&s);
    let pairing_id = query(url, "p");
    let name_box = proto::seal_name(k.name.as_ref(), &pairing_id, &phone.device_id, name, [1; 12]);
    let mut c = Claim { pairing_id, device_id: phone.device_id.clone(), sign_pub: phone.id.sign_pub(), box_pub: phone.id.box_pub(), name_box, proof_mac: String::new() };
    c.proof_mac = proto::proof(k.mac.as_ref(), &c);
    serde_json::to_value(&c).unwrap()
}

fn deliver(mac: &mut Engine, relay: &FakeRelay, host: &FakeHost, phone: &TestPhone, counter: u64, ct: &str, now: u64) {
    let inbox = json!({"ok": true, "claims": [], "devices": [], "messages": [{"deviceId": phone.device_id, "counter": counter, "ciphertext": ct, "createdAt": now}]});
    mac.handle_inbox(relay, host, &inbox, now);
}

fn results(phone: &TestPhone, mac: &Engine, mbp: &str, relay: &FakeRelay) -> Vec<Value> {
    phone.received(mac, mbp, relay).into_iter().filter(|e| e.t == "result").map(|e| e.b).collect()
}

// ---------------------------------------------------------------- pairing

#[test]
fn pairing_does_not_complete_without_the_click() {
    let id = Identity::generate();
    let mut mac = Engine::new(Saved { relay: "https://example.convex.cloud".into(), ..Default::default() }, id, None);
    let (relay, host) = (FakeRelay::default(), FakeHost::default());
    assert!(mac.pair_confirm(&relay, NOW).is_err(), "nothing to confirm");
    let view = mac.pair_start(&relay, NOW).unwrap();
    assert!(mac.pair_confirm(&relay, NOW).is_err(), "no claim yet");
    let phone = TestPhone::new();
    mac.handle_inbox(&relay, &host, &json!({"ok": true, "claims": [claim_for(&view.url, &phone, "Phone", None)], "messages": []}), NOW);
    assert!(mac.status(NOW).pairing.unwrap().claim.is_some());
    assert!(mac.saved.devices.is_empty());
    assert!(!relay.calls.lock().unwrap().iter().any(|(n, _)| n == "confirmPairing"));
    // Cancel instead of Pair: no device, and the relay is told.
    mac.pair_cancel(&relay, NOW);
    assert!(mac.saved.devices.is_empty());
    assert!(relay.calls.lock().unwrap().iter().any(|(n, _)| n == "cancelPairing"));
    assert!(mac.pair_confirm(&relay, NOW).is_err());
}

#[test]
fn a_claim_without_the_secret_is_ignored() {
    let id = Identity::generate();
    let mut mac = Engine::new(Saved { relay: "https://example.convex.cloud".into(), ..Default::default() }, id, None);
    let (relay, host) = (FakeRelay::default(), FakeHost::default());
    let view = mac.pair_start(&relay, NOW).unwrap();
    let phone = TestPhone::new();
    mac.handle_inbox(&relay, &host, &json!({"ok": true, "claims": [claim_for(&view.url, &phone, "Guess", Some([7; 32]))], "messages": []}), NOW);
    assert!(mac.status(NOW).pairing.unwrap().claim.is_none());
    assert!(mac.pair_confirm(&relay, NOW).is_err());
}

#[test]
fn the_pairing_code_expires_after_two_minutes() {
    let id = Identity::generate();
    let mut mac = Engine::new(Saved { relay: "https://example.convex.cloud".into(), ..Default::default() }, id, None);
    let relay = FakeRelay::default();
    let v = mac.pair_start(&relay, NOW).unwrap();
    assert_eq!(v.expires_at, NOW + 120_000);
    assert!(mac.status(NOW + 121_000).pairing.is_none());
}

// ---------------------------------------------------------------- messages

#[test]
fn a_message_is_acted_on_once_and_a_replay_is_refused() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    let (c, ct) = phone.seal(&mac, &mbp, "send", json!({"session": "claude:chat1", "text": "hello"}), NOW, 0);
    deliver(&mut mac, &relay, &host, &phone, c, &ct, NOW);
    deliver(&mut mac, &relay, &host, &phone, c, &ct, NOW + 10);
    assert_eq!(host.calls(), vec!["send claude:chat1 hello by Ada's iPhone"]);
    // An older message (lower counter) after a newer one: refused too.
    let (c2, ct2) = phone.seal(&mac, &mbp, "stop", json!({"session": "claude:chat1"}), NOW, 0);
    let (c3, ct3) = phone.seal(&mac, &mbp, "send", json!({"session": "claude:chat1", "text": "later"}), NOW, 0);
    deliver(&mut mac, &relay, &host, &phone, c3, &ct3, NOW);
    deliver(&mut mac, &relay, &host, &phone, c2, &ct2, NOW);
    assert_eq!(host.calls().len(), 2);
    // And acknowledged, so the relay deletes them.
    assert!(relay.calls.lock().unwrap().iter().any(|(n, a)| n == "ack" && a["dir"] == "d2m" && a["upTo"].as_u64() == Some(c)));
}

#[test]
fn a_tampered_or_misrouted_message_is_refused() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    let (c, ct) = phone.seal(&mac, &mbp, "send", json!({"session": "claude:chat1", "text": "x"}), NOW, 0);
    let mut b = proto::unb64u(&ct, None).unwrap();
    b[0] ^= 1;
    deliver(&mut mac, &relay, &host, &phone, c, &proto::b64u(&b), NOW);
    // Sealed for another counter than the one it arrives under.
    deliver(&mut mac, &relay, &host, &phone, c + 1, &ct, NOW);
    assert!(host.calls().is_empty());
    assert!(mac.actions.iter().all(|a| a.kind == "refused"));
    // The untouched one still works (the bad ones didn't move the high-water mark).
    deliver(&mut mac, &relay, &host, &phone, c, &ct, NOW);
    assert_eq!(host.calls().len(), 1);
}

#[test]
fn a_removed_device_is_refused_on_the_mac_even_if_the_relay_still_delivers() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    // The relay can't be reached: the Mac removes the device anyway and keeps the revocation to retry.
    relay.refuse.lock().unwrap().push("revokeDevice");
    let (c, ct) = phone.seal(&mac, &mbp, "send", json!({"session": "claude:chat1", "text": "x"}), NOW, 0);
    mac.remove_device(Some(&relay), &phone.device_id.clone(), NOW).unwrap();
    assert_eq!(mac.saved.pending_revokes, vec![phone.device_id.clone()]);
    deliver(&mut mac, &relay, &host, &phone, c, &ct, NOW);
    assert!(host.calls().is_empty());
    assert_eq!(mac.actions.last().unwrap().kind, "refused");
    // Nothing goes to it either.
    host.needs.lock().unwrap().push(perm_need());
    let before = relay.sent().len();
    mac.tick(&relay, &host, NOW);
    assert_eq!(relay.sent().len(), before);
    // Retried once the relay answers.
    relay.refuse.lock().unwrap().clear();
    mac.flush_revokes(&relay, NOW);
    assert!(mac.saved.pending_revokes.is_empty());
}

#[test]
fn a_command_older_than_sixty_seconds_is_dropped_and_reported_expired() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    let (c, ct) = phone.seal(&mac, &mbp, "send", json!({"session": "claude:chat1", "text": "old"}), NOW, 61_000);
    deliver(&mut mac, &relay, &host, &phone, c, &ct, NOW);
    assert!(host.calls().is_empty());
    let r = results(&phone, &mac, &mbp, &relay);
    assert_eq!(r.last().unwrap()["error"], "expired");
    // Fresh by the phone's clock but queued at the relay over a minute ago (the Mac was asleep): dropped too.
    let (c, ct) = phone.seal(&mac, &mbp, "stop", json!({"session": "claude:chat1"}), NOW, 0);
    let inbox = json!({"ok": true, "messages": [{"deviceId": phone.device_id, "counter": c, "ciphertext": ct, "createdAt": NOW - 61_000}]});
    mac.handle_inbox(&relay, &host, &inbox, NOW);
    assert!(host.calls().is_empty());
}

fn perm_need() -> Need {
    Need { id: "1:req-1".into(), session: "claude:chat1".into(), kind: "permission".into(), tool: "Bash".into(), summary: "Run echo".into(), command: Some("echo hi".into()), questions: vec![], explanation: None, risk: None }
}

#[test]
fn an_answer_can_only_allow_once_or_deny() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    host.needs.lock().unwrap().push(perm_need());
    for b in [json!({"need": "1:req-1", "choice": "always"}), json!({"need": "1:req-1", "choice": "remember", "remember": "chat-edits"}), json!({"need": "1:req-1", "choice": "option", "option": "Always allow"})] {
        let (c, ct) = phone.seal(&mac, &mbp, "answer", b, NOW, 0);
        deliver(&mut mac, &relay, &host, &phone, c, &ct, NOW);
    }
    assert!(host.answers.lock().unwrap().is_empty());
    assert!(results(&phone, &mac, &mbp, &relay).iter().all(|r| r["ok"] == false));
    let (c, ct) = phone.seal(&mac, &mbp, "answer", json!({"need": "1:req-1", "choice": "allow_once", "remember": "project-rule", "always": true}), NOW, 0);
    deliver(&mut mac, &relay, &host, &phone, c, &ct, NOW);
    assert_eq!(*host.answers.lock().unwrap(), vec![Answer::AllowOnce]);
    assert_eq!(mac.actions.last().unwrap().detail, "allowed Bash");
    assert_eq!(mac.actions.last().unwrap().device, "Ada's iPhone");
}

#[test]
fn start_refuses_unknown_projects_and_paths_and_never_bypasses() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    for b in [
        json!({"project": project_id("/somewhere/else"), "cli": "claude", "text": "hi"}),
        json!({"project": PROJECT, "cli": "claude", "text": "hi"}),
        json!({"project": project_id(PROJECT), "path": "/", "cli": "claude", "text": "hi"}),
        json!({"project": "../../etc", "cli": "claude", "text": "hi"}),
    ] {
        let (c, ct) = phone.seal(&mac, &mbp, "start", b, NOW, 0);
        deliver(&mut mac, &relay, &host, &phone, c, &ct, NOW);
    }
    assert!(host.starts.lock().unwrap().is_empty());
    // A minute on (the refused starts count against the limit of five a minute).
    let later = NOW + 61_000;
    let (c, ct) = phone.seal(&mac, &mbp, "start", json!({"project": project_id(PROJECT), "cli": "claude", "text": "hi"}), later, 0);
    deliver(&mut mac, &relay, &host, &phone, c, &ct, later);
    let (c, ct) = phone.seal(&mac, &mbp, "start", json!({"project": project_id(PROJECT), "cli": "codex", "text": "hi", "mode": "danger-full-access"}), later, 0);
    deliver(&mut mac, &relay, &host, &phone, c, &ct, later);
    assert_eq!(*host.starts.lock().unwrap(), vec![(PROJECT.to_string(), Cli::Claude, "default".to_string()), (PROJECT.to_string(), Cli::Codex, "untrusted".to_string())]);
}

#[test]
fn send_and_stop_reach_only_chats_coool_runs() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    for (t, b) in [("send", json!({"session": "claude:term", "text": "x"})), ("stop", json!({"session": "claude:term"})), ("send", json!({"session": "nope", "text": "x"}))] {
        let (c, ct) = phone.seal(&mac, &mbp, t, b, NOW, 0);
        deliver(&mut mac, &relay, &host, &phone, c, &ct, NOW);
    }
    assert!(host.calls().is_empty());
}

#[test]
fn commands_are_rate_limited_per_device() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    for i in 0..25 {
        let (c, ct) = phone.seal(&mac, &mbp, "send", json!({"session": "claude:chat1", "text": format!("m{i}")}), NOW, 0);
        deliver(&mut mac, &relay, &host, &phone, c, &ct, NOW + i);
    }
    assert_eq!(host.calls().len(), 20);
}

#[test]
fn hello_gets_a_snapshot_and_changes_follow() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    let (c, ct) = phone.seal(&mac, &mbp, "hello", json!({}), NOW, 0);
    deliver(&mut mac, &relay, &host, &phone, c, &ct, NOW);
    let got = phone.received(&mac, &mbp, &relay);
    let snap = got.iter().find(|e| e.t == "snapshot").unwrap();
    assert_eq!(snap.b["sessions"].as_array().unwrap().len(), 2);
    let projects = got.iter().find(|e| e.t == "projects").unwrap();
    assert_eq!(projects.b["projects"][0]["id"], project_id(PROJECT).as_str());
    assert!(!serde_json::to_string(&projects.b).unwrap().contains("/private/tmp"), "no path goes to the phone");
    mac.tick(&relay, &host, NOW);
    host.needs.lock().unwrap().push(perm_need());
    mac.tick(&relay, &host, NOW + 1000);
    host.needs.lock().unwrap().clear();
    mac.tick(&relay, &host, NOW + 2000);
    let ts: Vec<String> = phone.received(&mac, &mbp, &relay).into_iter().map(|e| e.t).collect();
    assert!(ts.contains(&"need".to_string()) && ts.contains(&"need_gone".to_string()));
}

#[test]
fn every_relay_request_is_signed_by_the_mac() {
    let (mac, _mbp, relay, _host, _phone) = paired();
    let _ = mac;
    for (name, a) in relay.calls.lock().unwrap().iter() {
        assert!(a["sig"].as_str().is_some_and(|s| s.len() == 86), "{name} unsigned");
    }
}

// ---------------------------------------------------------------- vectors

#[test]
fn matches_the_shared_vectors() {
    let v: Value = serde_json::from_str(include_str!("../tests/vectors.json")).unwrap();
    let s = |k: &str| v[k].as_str().unwrap().to_string();
    let key = |p: &str| proto::key32(v.pointer(p).unwrap().as_str().unwrap()).unwrap();
    let mac = Identity::from_raw(&key("/mac/boxPriv"), &key("/mac/signPriv"));
    let dev = Identity::from_raw(&key("/dev/boxPriv"), &key("/dev/signPriv"));
    assert_eq!(mac.box_pub(), v["mac"]["boxPub"]);
    assert_eq!(mac.sign_pub(), v["mac"]["signPub"]);
    assert_eq!(dev.box_pub(), v["dev"]["boxPub"]);
    let k = proto::pairing_keys(&proto::unb64u(&s("secret"), Some(32)).unwrap());
    assert_eq!(proto::b64u(k.relay.as_ref()), s("relayKey"));
    let c = Claim { pairing_id: s("pairingId"), device_id: s("deviceId"), sign_pub: dev.sign_pub(), box_pub: dev.box_pub(), name_box: s("nameBox"), proof_mac: s("proofMac") };
    assert!(proto::proof_ok(k.mac.as_ref(), &c));
    assert_eq!(proto::proof(k.relay.as_ref(), &c), s("proofRelay"));
    assert_eq!(proto::open_name(k.name.as_ref(), &c.pairing_id, &c.device_id, &c.name_box).unwrap(), "Ada's iPhone");
    assert_eq!(proto::seal_name(k.name.as_ref(), &c.pairing_id, &c.device_id, "Ada's iPhone", [5; 12]), s("nameBox"));
    let code = proto::pairing_code(k.code.as_ref(), &proto::CodeInput { pairing_id: &c.pairing_id, mac_id: &s("macId"), mac_sign_pub: &mac.sign_pub(), mac_box_pub: &mac.box_pub(), device_id: &c.device_id, dev_sign_pub: &dev.sign_pub(), dev_box_pub: &dev.box_pub() });
    assert_eq!(code, s("code"));
    let shared = mac.shared(&dev.box_pub()).unwrap();
    assert_eq!(proto::b64u(shared.as_ref()), s("shared"));
    let sk = proto::session_keys(shared.as_ref(), &s("macId"), &s("deviceId"), &mac.box_pub(), &dev.box_pub());
    assert_eq!(proto::b64u(sk.m2d.as_ref()), s("m2d"));
    assert_eq!(proto::b64u(sk.d2m.as_ref()), s("d2m"));
    let counter = v["counter"].as_u64().unwrap();
    assert_eq!(proto::seal(sk.d2m.as_ref(), Dir::D2m, &s("macId"), &s("deviceId"), counter, s("envelope").as_bytes()).unwrap(), s("sealedD2m"));
    let pt = proto::open(sk.d2m.as_ref(), Dir::D2m, &s("macId"), &s("deviceId"), counter, &s("sealedD2m")).unwrap();
    assert_eq!(String::from_utf8(pt).unwrap(), s("envelope"));
    let fields = [s("macId"), s("deviceId"), "m2d".into(), counter.to_string(), proto::sha256_hex("abc")];
    let fields: Vec<&str> = fields.iter().map(String::as_str).collect();
    assert_eq!(mac.sign(&proto::request_bytes("send", &fields, 1763640000000)), s("requestSig"));
    assert_eq!(proto::pair_url("https://example.convex.cloud", &s("macId"), &s("pairingId"), &s("secret"), &mac.sign_pub(), &mac.box_pub()), s("pairUrl"));
}

#[test]
fn identity_round_trips_through_the_key_store_form() {
    let id = Identity::generate();
    let back = Identity::import(&id.export()).unwrap();
    assert_eq!(back.sign_pub(), id.sign_pub());
    assert_eq!(back.box_pub(), id.box_pub());
    assert!(Identity::import("v2.a.b").is_err());
}

#[test]
fn a_low_order_peer_key_is_refused() {
    let id = Identity::generate();
    assert!(id.shared(&proto::b64u(&[0u8; 32])).is_err());
}
