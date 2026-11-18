//! Prints `provider prompts compactions | before -> after` titles for the sessions
//! on this machine: before is the old rule (the CLI's title, else the latest
//! prompt), after is [`coool_core::titles`] without insights (the deterministic
//! path). Reads only: no parse cache, an in-memory title store, a copy of coool's
//! own-sessions file. Prints titles only, no other transcript content.
//!
//! `cargo run -p coool-core --example titles_print [hours] [min_prompts]` (defaults: 720, 0).
use coool_core::hub::Hub;
use coool_core::titles::Titles;
use std::time::{Duration, Instant};

fn main() {
    let hours: u64 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(720);
    let min: u32 = std::env::args().nth(2).and_then(|a| a.parse().ok()).unwrap_or(0);
    let mut hub = Hub::with_cache(Duration::from_secs(3600 * hours), None);
    let copy = std::env::temp_dir().join(format!("coool-titles-print-{}.json", std::process::id()));
    if let Some(real) = coool_core::origin::OwnSessions::default_path() {
        let _ = std::fs::copy(real, &copy);
    }
    hub.set_own_sessions_file(Some(copy.clone()));
    let deadline = Instant::now() + Duration::from_secs(300);
    let mut all = hub.refresh(false);
    while hub.loading() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
        all = hub.refresh(false);
    }
    let _ = std::fs::remove_file(&copy);
    let mut titles = Titles::at(None);
    all.sort_by_key(|s| std::cmp::Reverse(s.title_facts.prompts));
    for s in &all {
        if s.title_facts.prompts < min || s.parent.is_some() {
            continue;
        }
        let before = if !s.title.is_empty() && !s.title.contains('\n') && s.title.chars().count() <= 56 {
            s.title.clone()
        } else {
            s.last_prompt.as_deref().map(|p| coool_core::titles::short_title(p, 56)).unwrap_or_else(|| s.title.clone())
        };
        let n = titles.resolve(s, false, None);
        if std::env::var_os("TITLES_DEBUG").is_some() { println!("    intent: {:?}", s.title_facts.intent.as_deref().map(|i| coool_core::titles::short_title(i, 56))); }
        println!("{:<6} {:>5}p {:>2}c {:?} | {before} -> {}", s.provider.label(), s.title_facts.prompts, s.title_facts.compactions, n.source, n.title);
    }
}
