//! End-to-end runs against the real CLIs. They spend a few cents of the
//! logged-in account (smallest models, tiny prompts), so they are ignored:
//!
//! ```sh
//! COOOL_LIVE_DIR=/some/empty/dir cargo test -p coool-core --test chat_live -- --ignored --nocapture --test-threads=1
//! ```
//!
//! `COOOL_LIVE_TRACE_DIR=<dir>` writes one protocol trace per chat there
//! (that is how `src/chat/fixtures/` were captured, then scrubbed).

use coool_core::chat::{ChatEventKind, ChatOptions};
use coool_core::hub::Hub;
use coool_core::model::Provider;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

fn dir() -> PathBuf {
    let d = PathBuf::from(std::env::var("COOOL_LIVE_DIR").expect("set COOOL_LIVE_DIR to an empty scratch folder"));
    std::fs::create_dir_all(&d).unwrap();
    d.canonicalize().unwrap()
}

fn start(hub: &mut Hub, trace: &str, opts: ChatOptions) -> usize {
    if let Ok(t) = std::env::var("COOOL_LIVE_TRACE_DIR") {
        let p = PathBuf::from(t).join(format!("{trace}.jsonl"));
        let _ = std::fs::remove_file(&p);
        // SAFETY: these tests run single-threaded (--test-threads=1) and nothing
        // else reads the environment concurrently.
        unsafe { std::env::set_var("COOOL_CHAT_TRACE", &p) };
    }
    let id = hub.start_chat(opts).unwrap();
    // SAFETY: as above.
    unsafe { std::env::remove_var("COOOL_CHAT_TRACE") };
    id
}

struct Watch {
    /// Last seq handed to a caller of `until`.
    seq: u64,
    all: Vec<ChatEventKind>,
}

impl Watch {
    fn new() -> Self {
        Self { seq: 0, all: Vec::new() }
    }

    /// Polls until `pred` matches an event after the last one returned; panics after `secs`.
    fn until(&mut self, hub: &Hub, id: usize, secs: u64, what: &str, pred: impl Fn(&ChatEventKind) -> bool) -> ChatEventKind {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            let (evs, _) = hub.chat(id).unwrap().events_since(self.seq);
            for e in evs {
                self.seq = e.seq;
                println!("{}", serde_json::to_string(&e).unwrap());
                self.all.push(e.kind.clone());
                if pred(&e.kind) {
                    return e.kind;
                }
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(30));
        }
    }

    fn perm(&mut self, hub: &Hub, id: usize) -> String {
        match self.until(hub, id, 120, "permission_request", |e| matches!(e, ChatEventKind::PermissionRequest { .. })) {
            ChatEventKind::PermissionRequest { request_id, .. } => request_id,
            _ => unreachable!(),
        }
    }

    fn turn_end(&mut self, hub: &Hub, id: usize) -> bool {
        match self.until(hub, id, 240, "turn_end", |e| matches!(e, ChatEventKind::TurnEnd { .. })) {
            ChatEventKind::TurnEnd { ok, .. } => ok,
            _ => unreachable!(),
        }
    }
}

fn is_ready(e: &ChatEventKind) -> bool {
    matches!(e, ChatEventKind::Ready { .. })
}

#[test]
#[ignore]
fn live_claude() {
    let d = dir().join("claude");
    std::fs::create_dir_all(&d).unwrap();
    let cwd = d.to_string_lossy().into_owned();
    let mut hub = Hub::new(Duration::from_secs(600));
    hub.set_own_sessions_file(None);
    hub.set_client_name(coool_core::origin::TEST_CLIENT_NAME);
    let opts = |m: &str| ChatOptions { provider: Provider::Claude, cwd: cwd.clone(), resume: None, model: Some(m.into()), permission_mode: None };

    // 1. Permissions (allow once, deny, always) and a subagent.
    let id = start(&mut hub, "claude_permission_subagent", opts("haiku"));
    let mut w = Watch::new();
    w.until(&hub, id, 60, "ready", is_ready);
    hub.chat_mut(id).unwrap().send("Use the Write tool to create a file named a.txt containing ok. Then reply with the word done.").unwrap();
    let r = w.perm(&hub, id);
    hub.chat_mut(id).unwrap().respond_permission(&r, true, false).unwrap();
    assert!(w.turn_end(&hub, id));
    assert!(d.join("a.txt").exists());

    hub.chat_mut(id).unwrap().send("Use the Write tool to create a file named c.txt containing ok. If that is refused, reply with the word refused and do nothing else.").unwrap();
    let r = w.perm(&hub, id);
    hub.chat_mut(id).unwrap().respond_permission(&r, false, false).unwrap();
    w.turn_end(&hub, id);
    assert!(!d.join("c.txt").exists());
    assert!(w.all.iter().any(|e| matches!(e, ChatEventKind::ToolEnd { ok: false, .. })));

    hub.chat_mut(id).unwrap().send("Use the Write tool to create a file named b.txt containing ok. Then reply with the word done.").unwrap();
    let r = w.perm(&hub, id);
    hub.chat_mut(id).unwrap().respond_permission(&r, true, true).unwrap();
    assert!(w.turn_end(&hub, id));
    assert!(d.join("b.txt").exists());

    hub.chat_mut(id)
        .unwrap()
        .send("Call the Agent tool with subagent_type general-purpose and the prompt: 'Run the bash command ls -1 in the current directory and report the file names.' Then reply with what it found.")
        .unwrap();
    // Read-only commands are normally auto-allowed; answer if asked.
    while let ChatEventKind::PermissionRequest { request_id, .. } =
        w.until(&hub, id, 240, "turn_end", |e| matches!(e, ChatEventKind::TurnEnd { .. } | ChatEventKind::PermissionRequest { .. }))
    {
        hub.chat_mut(id).unwrap().respond_permission(&request_id, true, false).unwrap();
    }
    assert!(w.all.iter().any(|e| matches!(e, ChatEventKind::ToolStart { parent_tool_id: Some(_), .. })), "subagent tool calls carry parent_tool_id");

    // The hub links the chat to its transcript, with model usage.
    let info = hub.chat(id).unwrap().info();
    // Transcripts are parsed in the background: wait for this one's details.
    let deadline = Instant::now() + Duration::from_secs(30);
    let s = loop {
        let sessions = hub.refresh(false);
        if let Some(s) = sessions.into_iter().find(|s| s.chat == Some(id) && s.loaded && !s.models.is_empty()) {
            break s;
        }
        assert!(Instant::now() < deadline, "chat linked to its session");
        thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(Some(&s.id), info.session_id.as_ref());
    assert!(s.models.iter().any(|m| m.model.contains("haiku") && !m.via_agent), "{:?}", s.models);
    println!("models: {:?}", s.models);
    hub.chat_mut(id).unwrap().stop();

    // 2. Interrupt, model switch, permission mode switch.
    let id = start(&mut hub, "claude_interrupt_set_model", opts("haiku"));
    let mut w = Watch::new();
    w.until(&hub, id, 60, "ready", is_ready);
    hub.chat_mut(id).unwrap().send("Count from 1 to 300, one number per line, no other text.").unwrap();
    w.until(&hub, id, 60, "text_delta", |e| matches!(e, ChatEventKind::TextDelta { .. }));
    hub.chat_mut(id).unwrap().interrupt().unwrap();
    assert!(!w.turn_end(&hub, id), "interrupted turn ends not ok");
    assert!(hub.chat(id).unwrap().is_running(), "interrupt keeps the process");
    hub.chat_mut(id).unwrap().set_model("claude-haiku-4-5-20251001").unwrap();
    w.until(&hub, id, 30, "ready with new model", |e| matches!(e, ChatEventKind::Ready { model, .. } if model == "claude-haiku-4-5-20251001"));
    hub.chat_mut(id).unwrap().set_permission_mode("acceptEdits").unwrap();
    w.until(&hub, id, 30, "ready with new mode", |e| matches!(e, ChatEventKind::Ready { permission_mode, .. } if permission_mode == "acceptEdits"));
    hub.chat_mut(id).unwrap().send("reply with the word ok").unwrap();
    w.until(&hub, id, 120, "answer on new model", |e| matches!(e, ChatEventKind::AssistantMessage { model, .. } if model == "claude-haiku-4-5-20251001"));
    assert!(w.turn_end(&hub, id));
    hub.chat_mut(id).unwrap().stop();

    // 3. Slash commands (all local, no model calls).
    let id = start(&mut hub, "claude_slash_commands", opts("haiku"));
    let mut w = Watch::new();
    w.until(&hub, id, 60, "ready", is_ready);
    for cmd in ["/context", "/cost", "/help", "/login", "/config", "/model haiku", "/doctor"] {
        hub.chat_mut(id).unwrap().send(cmd).unwrap();
        if cmd != "/doctor" {
            w.turn_end(&hub, id);
        }
    }
    w.until(&hub, id, 10, "doctor notice", |e| matches!(e, ChatEventKind::Notice { needs_terminal: true, text, .. } if text.starts_with("/doctor")));
    hub.kill_all();
}

#[test]
#[ignore]
fn live_codex() {
    let d = dir().join("codex");
    std::fs::create_dir_all(&d).unwrap();
    let cwd = d.to_string_lossy().into_owned();
    let mut hub = Hub::new(Duration::from_secs(600));
    hub.set_own_sessions_file(None);
    hub.set_client_name(coool_core::origin::TEST_CLIENT_NAME);
    let opts = ChatOptions { provider: Provider::Codex, cwd: cwd.clone(), resume: None, model: Some("gpt-5.6-luna".into()), permission_mode: Some("untrusted".into()) };
    let id = start(&mut hub, "codex_approval_interrupt_model", opts);
    let mut w = Watch::new();
    w.until(&hub, id, 60, "ready", is_ready);

    hub.chat_mut(id).unwrap().send("Run the shell command: touch b.txt  Then reply with the word done.").unwrap();
    let r = w.perm(&hub, id);
    hub.chat_mut(id).unwrap().respond_permission(&r, true, false).unwrap();
    assert!(w.turn_end(&hub, id));
    assert!(d.join("b.txt").exists());

    hub.chat_mut(id).unwrap().send("Run the shell command: touch c.txt  If it is declined, reply with the word declined and do nothing else.").unwrap();
    let r = w.perm(&hub, id);
    hub.chat_mut(id).unwrap().respond_permission(&r, false, false).unwrap();
    w.turn_end(&hub, id);
    assert!(!d.join("c.txt").exists());

    hub.chat_mut(id).unwrap().send("Count from 1 to 300, one number per line, no other text.").unwrap();
    w.until(&hub, id, 120, "text_delta", |e| matches!(e, ChatEventKind::TextDelta { .. }));
    hub.chat_mut(id).unwrap().interrupt().unwrap();
    assert!(!w.turn_end(&hub, id));

    hub.chat_mut(id).unwrap().set_model("gpt-5.6-terra").unwrap();
    hub.chat_mut(id).unwrap().send("reply with the word ok").unwrap();
    w.until(&hub, id, 120, "answer on new model", |e| matches!(e, ChatEventKind::AssistantMessage { model, .. } if model == "gpt-5.6-terra"));
    assert!(w.turn_end(&hub, id));
    for cmd in ["/status", "/diff"] {
        hub.chat_mut(id).unwrap().send(cmd).unwrap();
    }
    w.until(&hub, id, 10, "diff notice", |e| matches!(e, ChatEventKind::Notice { needs_terminal: true, .. }));

    let info = hub.chat(id).unwrap().info();
    // The rollout may land a moment after the turn.
    let deadline = Instant::now() + Duration::from_secs(10);
    let s = loop {
        let sessions = hub.refresh(false);
        if let Some(s) = sessions.into_iter().find(|s| s.chat == Some(id)) {
            break s;
        }
        assert!(Instant::now() < deadline, "chat linked to its rollout");
        thread::sleep(Duration::from_millis(200));
    };
    assert_eq!(Some(&s.id), info.session_id.as_ref());
    println!("models: {:?}", s.models);
    let names: Vec<&str> = s.models.iter().map(|m| m.model.as_str()).collect();
    assert!(names.contains(&"gpt-5.6-luna") && names.contains(&"gpt-5.6-terra"), "{names:?}");
    hub.kill_all();
    assert!(!hub.chat(id).unwrap().is_running());
}
