//! Measures what loading this machine's transcripts costs: first load (empty
//! parse cache), load from the cache, peak memory, cache size and the JSON size
//! of the sessions (what the app serializes every refresh). Reads only; the
//! parse cache lives in a throwaway folder, never coool's real one.
//!
//! `cargo run --release -p coool-core --example activity_size [hours]` (default: 24, like the app).
use coool_core::hub::Hub;
use std::path::Path;
use std::time::{Duration, Instant};

fn load(hours: u64, cache: &Path) -> (Vec<coool_core::model::Session>, Duration) {
    let t = Instant::now();
    let mut hub = Hub::with_cache(Duration::from_secs(3600 * hours), Some(cache.to_path_buf()));
    let copy = std::env::temp_dir().join(format!("coool-activity-size-{}.json", std::process::id()));
    if let Some(real) = coool_core::origin::OwnSessions::default_path() {
        let _ = std::fs::copy(real, &copy);
    }
    hub.set_own_sessions_file(Some(copy.clone()));
    let deadline = Instant::now() + Duration::from_secs(600);
    let mut all = hub.refresh(false);
    while hub.loading() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
        all = hub.refresh(false);
    }
    let _ = std::fs::remove_file(&copy);
    (all, t.elapsed())
}

fn dir_size(p: &Path) -> u64 {
    std::fs::read_dir(p).into_iter().flatten().flatten().map(|e| if e.path().is_dir() { dir_size(&e.path()) } else { e.metadata().map(|m| m.len()).unwrap_or(0) }).sum()
}

fn max_rss_mb() -> f64 {
    // SAFETY: plain getrusage on our own process.
    let mut u: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut u) };
    // macOS reports bytes, Linux kilobytes.
    let b = if cfg!(target_os = "macos") { u.ru_maxrss as f64 } else { u.ru_maxrss as f64 * 1024.0 };
    b / (1 << 20) as f64
}

fn main() {
    let hours: u64 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(24);
    let cache = std::env::temp_dir().join(format!("coool-activity-size-cache-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&cache);
    let (all, cold) = load(hours, &cache);
    let rss_cold = max_rss_mb();
    let (warm_all, warm) = load(hours, &cache);
    let json = serde_json::to_vec(&all).map(|v| v.len()).unwrap_or(0);
    let acts: usize = all.iter().map(|s| s.activity.len() + s.agents.iter().map(|a| a.activity.len()).sum::<usize>()).sum();
    let full: usize = all.iter().flat_map(|s| s.activity.iter().chain(s.agents.iter().flat_map(|a| a.activity.iter()))).map(|a| a.full.as_deref().map_or(0, str::len)).sum();
    let with_full = all.iter().flat_map(|s| s.activity.iter().chain(s.agents.iter().flat_map(|a| a.activity.iter()))).filter(|a| a.full.is_some()).count();
    let shortened = all.iter().flat_map(|s| s.activity.iter().chain(s.agents.iter().flat_map(|a| a.activity.iter()))).filter(|a| a.shortened).count();
    let biggest = all.iter().map(|s| (serde_json::to_vec(s).map(|v| v.len()).unwrap_or(0), s.id.clone())).max().unwrap_or_default();
    println!("window {hours}h: {} sessions ({} after reload), {acts} activity entries", all.len(), warm_all.len());
    println!("first load {:.2}s, from cache {:.2}s, peak RSS after first load {rss_cold:.0} MB, peak RSS overall {:.0} MB", cold.as_secs_f64(), warm.as_secs_f64(), max_rss_mb());
    println!("cache {:.1} MB, sessions JSON {:.2} MB (largest session {:.0} KB)", dir_size(&cache) as f64 / 1e6, json as f64 / 1e6, biggest.0 as f64 / 1e3);
    println!("full text: {with_full} entries, {:.2} MB; {shortened} entries marked shortened", full as f64 / 1e6);
    let _ = std::fs::remove_dir_all(&cache);
}
