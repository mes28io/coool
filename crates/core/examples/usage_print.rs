//! Print both providers' plan usage as JSON, to compare with the CLIs' own
//! `/usage` (Claude) and `/status` (Codex) screens.
//!
//! ```sh
//! cargo run -q -p coool-core --example usage_print            # files + one probe each
//! cargo run -q -p coool-core --example usage_print -- --files # free file sources only
//! ```
//!
//! The probes run a hidden `claude -p` (`get_usage` control request, no
//! prompt) and a short-lived `codex app-server` (`account/rateLimits/read`).
//! Neither runs a model turn.

use coool_core::model::Provider;
use coool_core::usage::UsageMonitor;
use std::time::{Duration, Instant};

fn main() {
    let files_only = std::env::args().any(|a| a == "--files");
    let mut m = UsageMonitor::new();
    m.set_probes(!files_only);
    m.tick();
    // Let the file reads land.
    std::thread::sleep(Duration::from_millis(1500));
    m.tick();
    let before: Vec<u64> = [Provider::Claude, Provider::Codex].iter().map(|p| m.get(*p).map(|u| u.fetched_ms).unwrap_or(0)).collect();
    if !files_only {
        m.refresh_now(Provider::Claude);
        m.refresh_now(Provider::Codex);
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(250));
            let done = [Provider::Claude, Provider::Codex].iter().zip(&before).all(|(p, b)| m.get(*p).is_some_and(|u| u.fetched_ms > *b || u.error.is_some()));
            if done {
                break;
            }
        }
    }
    let out = serde_json::json!({ "claude": m.get(Provider::Claude), "codex": m.get(Provider::Codex) });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
