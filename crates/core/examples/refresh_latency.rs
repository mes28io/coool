//! What one refresh costs with this machine's real transcripts, and how long a
//! line written to a transcript takes to show up in `Hub::refresh`. Reads only;
//! the parse cache is a copy in a throwaway folder, never coool's real one.
//!
//! ```sh
//! # per-refresh cost (hub.refresh, the app's per-session JSON + diff, the JSON's size):
//! cargo run --release -p coool-core --example refresh_latency bench
//! # print (wall ms, activity count) each time session <id> changes, polling
//! # every <ms> (`watch`: woken by file-system events, like the app):
//! cargo run --release -p coool-core --example refresh_latency live <id> <ms|watch>
//! # how often file events wake a refresher over <secs>, and the time spent
//! # in refresh and in the app's publish path (refresh + JSON + diff):
//! cargo run --release -p coool-core --example refresh_latency wakes <secs>
//! # the biggest sessions' JSON, split into activity, subagents and the rest:
//! cargo run --release -p coool-core --example refresh_latency sizes
//! ```
use coool_core::hub::Hub;
use coool_core::model::Session;
use coool_core::wire::Sent;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

/// The app's session keys (`provider:id`, a repeated id gets `#n`), as `Core::collect` makes them.
fn keyed(all: Vec<Session>) -> Vec<(String, Session)> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    all.into_iter()
        .map(|s| {
            let mut key = format!("{}:{}", s.provider.label(), s.id);
            let n = seen.entry(key.clone()).or_default();
            *n += 1;
            if *n > 1 {
                key = format!("{key}#{n}");
            }
            (key, s)
        })
        .collect()
}

/// What `Published::update` does with the JSON: compare to what was last sent, keep the new set.
/// Returns how many sessions changed.
fn diff(last: &mut HashMap<String, Arc<str>>, rows: Vec<(String, Arc<str>)>) -> usize {
    let mut next = HashMap::with_capacity(rows.len());
    let mut changed = 0;
    for (k, j) in rows {
        if !last.get(&k).is_some_and(|o| Arc::ptr_eq(o, &j) || *o == j) {
            changed += 1;
        }
        next.insert(k, j);
    }
    *last = next;
    changed
}

/// The app's publish path before the memo: every session serialized on every refresh.
fn app_old(all: Vec<Session>, last: &mut HashMap<String, Arc<str>>) -> usize {
    let rows = keyed(all).into_iter().map(|(k, s)| (k, Arc::from(s.to_json()))).collect();
    diff(last, rows)
}

/// The app's publish path now (`Published::update` over [`Sent`]): an unchanged session is neither
/// serialized nor sent; a changed one serializes only its new entries and goes out as a patch or whole.
/// Returns how many sessions changed.
fn app_new(all: Vec<Session>, memo: &mut HashMap<String, Sent>) -> usize {
    let mut next = HashMap::with_capacity(memo.len());
    let mut changed = 0;
    for (k, s) in keyed(all) {
        let prev = match memo.remove(&k) {
            Some(p) if p.same(&s, &None) => {
                next.insert(k, p);
                continue;
            }
            p => p,
        };
        let sent = Sent::new(s, None, prev.as_ref());
        let _payload = prev.as_ref().and_then(|p| sent.patch(p)).unwrap_or_else(|| sent.to_json());
        changed += 1;
        next.insert(k, sent);
    }
    *memo = next;
    changed
}

fn copy_dir(from: &Path, to: &Path) {
    let _ = std::fs::create_dir_all(to);
    for e in std::fs::read_dir(from).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            copy_dir(&p, &to.join(e.file_name()));
        } else {
            let _ = std::fs::copy(&p, to.join(e.file_name()));
        }
    }
}

fn hub() -> (Hub, std::path::PathBuf) {
    let scratch = std::env::temp_dir().join(format!("coool-refresh-latency-{}", std::process::id()));
    let cache = scratch.join("cache");
    if let Some(real) = dirs::cache_dir().map(|d| d.join("coool")) {
        copy_dir(&real, &cache);
    }
    let mut hub = Hub::with_cache(Duration::from_secs(24 * 3600), Some(cache));
    let own = scratch.join("own.json");
    if let Some(real) = coool_core::origin::OwnSessions::default_path() {
        let _ = std::fs::copy(real, &own);
    }
    hub.set_own_sessions_file(Some(own));
    let deadline = Instant::now() + Duration::from_secs(600);
    hub.refresh(false);
    while hub.loading() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
        hub.refresh(false);
    }
    (hub, scratch)
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn stats(name: &str, mut v: Vec<f64>) {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p = |q: f64| v[((v.len() - 1) as f64 * q).round() as usize];
    println!("{name:<28} median {:>8.2} ms   p90 {:>8.2} ms   max {:>8.2} ms", p(0.5), p(0.9), p(1.0));
}

fn wall_ms() -> u128 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let t = Instant::now();
    let (mut hub, scratch) = hub();
    eprintln!("loaded in {:.1}s", t.elapsed().as_secs_f64());
    match args.first().map(String::as_str) {
        Some("live") => {
            let id = args.get(1).expect("session id").clone();
            let mode = args.get(2).map(String::as_str).unwrap_or("1000");
            let watch = mode == "watch";
            let every = Duration::from_millis(mode.parse().unwrap_or(1000));
            let waker = watch.then(|| {
                let w = coool_core::watch::Waker::new();
                let watcher = coool_core::watch::Watch::sources(w.clone());
                (w, watcher)
            });
            let mut last = None;
            loop {
                let all = hub.refresh(false);
                let now = wall_ms();
                if let Some(s) = all.iter().find(|s| s.id == id) {
                    let key = (s.activity.len(), s.status, s.updated);
                    if last != Some(key) {
                        println!("{now} activity={} status={:?}", s.activity.len(), s.status);
                        last = Some(key);
                    }
                }
                match &waker {
                    Some((w, _)) => {
                        w.wait(every.max(Duration::from_millis(1000)));
                    }
                    None => std::thread::sleep(every),
                }
            }
        }
        Some("wakes") => {
            // How often file events would wake the app's refresher, and what those refreshes cost.
            let secs: u64 = args.get(1).and_then(|a| a.parse().ok()).unwrap_or(60);
            let w = coool_core::watch::Waker::new();
            let _watch = coool_core::watch::Watch::sources(w.clone());
            let end = Instant::now() + Duration::from_secs(secs);
            let (mut files, mut timer, mut busy, mut app) = (0, 0, Duration::ZERO, Duration::ZERO);
            let mut memo = HashMap::new();
            while Instant::now() < end {
                let t = Instant::now();
                let all = hub.refresh(false);
                busy += t.elapsed();
                app_new(all, &mut memo);
                app += t.elapsed();
                match w.wait(Duration::from_millis(1000)) {
                    coool_core::watch::Wake::Files => files += 1,
                    _ => timer += 1,
                }
            }
            let pct = |d: Duration| ms(d) / (secs as f64 * 10.0);
            println!("{secs}s: {files} file wake-ups, {timer} timer ticks, refresh busy {:.0} ms ({:.2}% of a core)", ms(busy), pct(busy));
            println!("{secs}s: app publish path (refresh + JSON + diff) busy {:.0} ms ({:.2}% of a core)", ms(app), pct(app));
        }
        Some("sizes") => {
            // The biggest sessions' JSON, split into activity, subagents and the rest.
            let all = hub.refresh(false);
            let mut rows: Vec<_> = all
                .iter()
                .map(|s| {
                    let total = s.to_json().len();
                    let act = serde_json::to_string(&s.activity).map_or(0, |j| j.len());
                    let agents = serde_json::to_string(&s.agents).map_or(0, |j| j.len());
                    (total, act, agents, s.activity.len(), s.agents.len(), format!("{:?} {}", s.status, s.id))
                })
                .collect();
            rows.sort_by_key(|r| std::cmp::Reverse(r.0));
            println!("{} sessions, {:.2} MB of JSON", rows.len(), rows.iter().map(|r| r.0).sum::<usize>() as f64 / 1e6);
            for (total, act, agents, n, na, id) in rows.iter().take(12) {
                println!("{:>9} B  activity {act:>9} B ({n} entries)  agents {agents:>9} B ({na})  {id}", total);
            }
        }
        _ => {
            let mut refresh = Vec::new();
            let mut ser = Vec::new();
            let (mut old, mut new) = (Vec::new(), Vec::new());
            let (mut old_last, mut memo) = (HashMap::new(), HashMap::new());
            let mut changed = Vec::new();
            let mut bytes = 0;
            let mut n = 0;
            for _ in 0..30 {
                let t = Instant::now();
                let all = hub.refresh(false);
                refresh.push(ms(t.elapsed()));
                let t = Instant::now();
                // The app serializes the old and the new snapshot to compare them, then Tauri serializes it again to emit.
                let a = serde_json::to_string(&all).unwrap();
                let _b = serde_json::to_string(&all).unwrap();
                let _c = serde_json::to_string(&all).unwrap();
                ser.push(ms(t.elapsed()));
                bytes = a.len();
                n = all.len();
                // The app's path after the refresh, old and new (each with its own "last sent" state).
                let t = Instant::now();
                app_old(all.clone(), &mut old_last);
                old.push(ms(t.elapsed()));
                let t = Instant::now();
                changed.push(app_new(all, &mut memo) as f64);
                new.push(ms(t.elapsed()));
                std::thread::sleep(Duration::from_millis(100));
            }
            println!("{n} sessions, sessions JSON {:.2} MB", bytes as f64 / 1e6);
            stats("hub.refresh", refresh.clone());
            stats("serialize x3 (old bench)", ser);
            // The first round serializes everything in both paths; the rest is the steady state.
            stats("app json+diff, all (old)", old[1..].to_vec());
            stats("app memo+patch (new)", new[1..].to_vec());
            let total: Vec<f64> = refresh.iter().zip(&new).skip(1).map(|(r, a)| r + a).collect();
            stats("publish path (refresh+memo)", total);
            changed.remove(0);
            println!("sessions changed per refresh: {:?}", changed.iter().map(|c| *c as usize).collect::<Vec<_>>());
        }
    }
    let _ = std::fs::remove_dir_all(&scratch);
}
