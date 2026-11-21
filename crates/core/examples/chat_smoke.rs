//! Start a structured chat, send one prompt, print every event as a JSON line.
//!
//! ```sh
//! cargo run -q -p coool-core --example chat_smoke -- "reply with the word ok"
//! cargo run -q -p coool-core --example chat_smoke -- --codex --model gpt-5.6-luna "reply with the word ok"
//! ```
//!
//! Options: `--codex` (default: Claude), `--model <m>`, `--mode <permission mode>`,
//! `--cwd <dir>` (default: current dir), `--resume <session id>`,
//! `--yes` (allow every permission request; otherwise you are asked on the terminal).
//! Exits after the first turn ends. `COOOL_CHAT_TRACE=<file>` also records the raw protocol.

use coool_core::chat::{ChatEventKind, ChatOptions};
use coool_core::hub::Hub;
use coool_core::model::Provider;
use std::io::{BufRead, Write};
use std::time::{Duration, Instant};

fn main() -> anyhow::Result<()> {
    let mut provider = Provider::Claude;
    let (mut model, mut mode, mut resume, mut cwd, mut yes) = (None, None, None, None, false);
    let mut prompt = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--codex" => provider = Provider::Codex,
            "--claude" => provider = Provider::Claude,
            "--model" => model = args.next(),
            "--mode" => mode = args.next(),
            "--resume" => resume = args.next(),
            "--cwd" => cwd = args.next(),
            "--yes" => yes = true,
            _ => prompt.push(a),
        }
    }
    let prompt = prompt.join(" ");
    if prompt.trim().is_empty() {
        anyhow::bail!("usage: chat_smoke [--codex] [--model M] [--mode M] [--cwd DIR] [--resume ID] [--yes] <prompt>");
    }
    let cwd = match cwd {
        Some(c) => c,
        None => std::env::current_dir()?.to_string_lossy().into_owned(),
    };

    let mut hub = Hub::new(Duration::from_secs(3600));
    // A smoke run is not the person's chat: don't remember it.
    hub.set_own_sessions_file(None);
    hub.set_client_name(coool_core::origin::TEST_CLIENT_NAME);
    let id = hub.start_chat(ChatOptions { provider, cwd, resume, model, permission_mode: mode, ladder: None, context: None })?;
    hub.chat_mut(id).unwrap().send(&prompt)?;

    let mut seq = 0;
    let started = Instant::now();
    let stdin = std::io::stdin();
    'outer: loop {
        let (events, next) = hub.chat(id).unwrap().events_since(seq);
        seq = next;
        for e in events {
            println!("{}", serde_json::to_string(&e)?);
            match &e.kind {
                ChatEventKind::PermissionRequest { request_id, summary, .. } => {
                    let (allow, always) = if yes {
                        (true, false)
                    } else {
                        eprint!("allow {summary}? [y]es / [a]lways / [n]o: ");
                        std::io::stderr().flush()?;
                        let mut line = String::new();
                        stdin.lock().read_line(&mut line)?;
                        match line.trim() {
                            "y" | "yes" => (true, false),
                            "a" | "always" => (true, true),
                            _ => (false, false),
                        }
                    };
                    hub.chat_mut(id).unwrap().respond_permission(request_id, allow, always)?;
                }
                ChatEventKind::TurnEnd { .. } | ChatEventKind::Exited { .. } => break 'outer,
                _ => {}
            }
        }
        if started.elapsed() > Duration::from_secs(600) {
            eprintln!("timed out");
            break;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    let info = hub.chat(id).unwrap().info();
    eprintln!("{}", serde_json::to_string(&info)?);
    hub.kill_all();
    Ok(())
}
