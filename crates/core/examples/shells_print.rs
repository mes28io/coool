//! Prints the background shells of every live session, and how each child
//! process of a session's CLI was classified (shell / helper / walked into).
//! Reads only; records nothing (own-sessions file and parse cache go to a temp dir).
//!
//! `cargo run -p coool-core --example shells_print [seconds] [--stop <pid>]` (default: one
//! pass; with a number, prints again every 2 s for that long). `--stop` stops that shell
//! through `Hub::stop_shell` after the first pass (it refuses anything not listed as a shell).
use coool_core::hub::Hub;
use coool_core::model::Status;
use coool_core::shells::{self, Class};
use std::collections::HashSet;
use std::time::{Duration, Instant, SystemTime};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let secs: u64 = args.get(1).and_then(|a| a.parse().ok()).unwrap_or(0);
    let mut stop: Option<u32> = args.iter().position(|a| a == "--stop").and_then(|i| args.get(i + 1)).and_then(|p| p.parse().ok());
    let tmp = std::env::temp_dir().join(format!("coool-shells-print-{}", std::process::id()));
    let mut hub = Hub::with_cache(Duration::from_secs(6 * 3600), Some(tmp.join("cache")));
    let copy = tmp.join("own-sessions.json");
    let _ = std::fs::create_dir_all(&tmp);
    if let Some(real) = coool_core::origin::OwnSessions::default_path() {
        let _ = std::fs::copy(real, &copy);
    }
    hub.set_own_sessions_file(Some(copy));
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut all = hub.refresh(false);
    while hub.loading() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
        all = hub.refresh(false);
    }
    // Every live session counts as on screen, so tails are read.
    hub.set_shell_focus(all.iter().filter(|s| s.status != Status::Ended).map(|s| s.id.clone()));
    let end = Instant::now() + Duration::from_secs(secs);
    loop {
        std::thread::sleep(Duration::from_millis(1100));
        all = hub.refresh(false);
        print(&all);
        if let Some(pid) = stop.take() {
            println!("stop_shell({pid}): {:?}", hub.stop_shell(pid).map_err(|e| format!("{e:#}")));
        }
        if Instant::now() >= end {
            break;
        }
        std::thread::sleep(Duration::from_millis(900));
    }
    let _ = std::fs::remove_dir_all(&tmp);
}

fn print(all: &[coool_core::model::Session]) {
    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis() as u64;
    println!("---");
    for s in all.iter().filter(|s| s.status != Status::Ended && s.pid.is_some()) {
        let pid = s.pid.unwrap();
        println!(
            "{} {} pid {} {:?} {:?} registry-shell={} live_children={} shells={}",
            s.provider.label(),
            &s.id[..s.id.len().min(8)],
            pid,
            s.status,
            s.origin,
            s.background_tasks,
            s.live_children,
            s.shells.len()
        );
        for c in shells::sys::children(pid) {
            let Some(p) = shells::sys::info(c) else { continue };
            let class = match shells::classify(&p.args, &HashSet::new()) {
                Class::Shell(_) => "shell",
                Class::Helper => "helper (excluded)",
                Class::Other => "other (walked into)",
            };
            let line: String = p.args.join(" ").chars().take(110).collect();
            println!("    child {c:>6} {class:<20} {line}");
        }
        for sh in &s.shells {
            let el = now.saturating_sub(sh.started) / 1000;
            println!(
                "    SHELL pid {} {}m {:02}s cpu {}%{}{} | {}",
                sh.pid,
                el / 60,
                el % 60,
                sh.cpu,
                if sh.background { " bg" } else { " fg" },
                if sh.idle_loop { " idle-loop" } else { "" },
                sh.command.chars().take(100).collect::<String>()
            );
            if let Some(d) = &sh.description {
                println!("          description: {d}");
            }
            if let Some(o) = &sh.output {
                println!("          output: {o}");
            }
            for l in &sh.tail {
                println!("          | {l}");
            }
        }
    }
}
