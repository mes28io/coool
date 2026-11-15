//! Prints `origin status provider cwd -> project` for every current session, then
//! counts per origin and per (origin, project). Reads only; records nothing.
//!
//! `cargo run -p coool-core --example projects_print [hours]` (default: 48).
use coool_core::hub::Hub;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

fn main() {
    let hours: u64 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(48);
    let mut hub = Hub::new(Duration::from_secs(3600 * hours));
    // Read-only: work on a copy of coool's own-sessions file, never the real one.
    let copy = std::env::temp_dir().join(format!("coool-projects-print-{}.json", std::process::id()));
    if let Some(real) = coool_core::origin::OwnSessions::default_path() {
        let _ = std::fs::copy(real, &copy);
    }
    hub.set_own_sessions_file(Some(copy.clone()));
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut all = hub.refresh(false);
    while hub.loading() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
        all = hub.refresh(false);
    }
    let home = dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default();
    let short = |p: &str| if !home.is_empty() && p.starts_with(&home) { format!("~{}", &p[home.len()..]) } else { p.to_string() };
    let mut by_origin: BTreeMap<&str, usize> = BTreeMap::new();
    let mut by_project: BTreeMap<(&str, String), usize> = BTreeMap::new();
    for s in &all {
        let o = s.origin.label();
        let mut extra = String::new();
        if let Some(p) = &s.parent {
            extra += &format!("  parent={}", &p[..p.len().min(8)]);
        }
        if s.live_children > 0 {
            extra += &format!("  live_children={}", s.live_children);
        }
        if s.background_tasks {
            extra += "  background_tasks";
        }
        if let Some(w) = &s.waiting_for {
            extra += &format!("  waiting_for={w}");
        }
        println!("{o:<10} {:<6} {:<6} {} {} -> {}{extra}", format!("{:?}", s.status).to_lowercase(), s.provider.label(), &s.id[..s.id.len().min(8)], short(&s.cwd), short(&s.project));
        *by_origin.entry(o).or_default() += 1;
        *by_project.entry((o, short(&s.project))).or_default() += 1;
    }
    let _ = std::fs::remove_file(&copy);
    let children = all.iter().filter(|s| s.parent.is_some()).count();
    let orphans = all.iter().filter(|s| s.parent.is_none() && s.origin == coool_core::model::Origin::Automation).count();
    println!("\n{} sessions in the last {hours}h; {children} child runs with a parent, {orphans} automation runs without one", all.len());
    for (o, n) in &by_origin {
        println!("  {o:<10} {n}");
    }
    println!();
    for ((o, p), n) in &by_project {
        println!("  {n:>3}  {o:<10} {p}");
    }
}
