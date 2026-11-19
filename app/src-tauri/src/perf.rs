//! Counters for the self-test's `perf-*` scenarios (app/src/selftestPerf.ts): what the backend sent and
//! started, when the first sessions payload went out and the initial load finished, and the CPU time,
//! wakeups and memory of coool's own processes (the app and its WebKit content and GPU processes).
//! Plain relaxed atomics, bumped on paths that already do far more work; read only by `selftest_perf_stats`.

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};

/// Sessions payloads emitted (`sessions` + `sessions-delta`) and their bytes.
pub static PUBLISHES: AtomicU64 = AtomicU64::new(0);
pub static PUBLISH_BYTES: AtomicU64 = AtomicU64::new(0);
/// Refreshes run by the refresher (emitted or not).
pub static REFRESHES: AtomicU64 = AtomicU64::new(0);
/// `chat-event` batches and `pty-output` chunks emitted.
pub static CHAT_BATCHES: AtomicU64 = AtomicU64::new(0);
pub static PTY_CHUNKS: AtomicU64 = AtomicU64::new(0);
/// `git_trail` and `context_map` calls served.
pub static GIT_TRAILS: AtomicU64 = AtomicU64::new(0);
pub static CONTEXT_MAPS: AtomicU64 = AtomicU64::new(0);
/// Epoch ms of the first sessions payload, and of the first payload with the initial load done (0: not yet).
pub static FIRST_PUBLISH_MS: AtomicU64 = AtomicU64::new(0);
pub static LOADED_MS: AtomicU64 = AtomicU64::new(0);

pub fn bump(c: &AtomicU64, n: u64) {
    c.fetch_add(n, Ordering::Relaxed);
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Named points of the start-up (epoch ms), in order.
pub static BOOT: std::sync::Mutex<Vec<(&'static str, u64)>> = std::sync::Mutex::new(Vec::new());

pub fn boot_mark(name: &'static str) {
    if let Ok(mut b) = BOOT.lock() {
        b.push((name, now_ms()));
    }
}

/// Sets `c` to now once.
pub fn mark_once(c: &AtomicU64) {
    let _ = c.compare_exchange(0, now_ms(), Ordering::Relaxed, Ordering::Relaxed);
}

/// One process's resource use so far (`proc_pid_rusage`).
#[derive(Clone, Copy, Serialize, Default)]
pub struct ProcStats {
    pub pid: i32,
    /// CPU time, user + system, ms.
    pub cpu_ms: f64,
    /// Wakeups from idle (package idle exits + interrupt wakeups).
    pub wakeups: u64,
    /// Physical footprint (what Activity Monitor calls Memory), bytes.
    pub footprint: u64,
}

#[cfg(target_os = "macos")]
#[allow(deprecated)] // mach_timebase_info: libc points at the mach2 crate, which is not in the tree.
pub fn proc_stats(pid: i32) -> Option<ProcStats> {
    // SAFETY: plain libc calls with a zeroed out-struct of the size the flavor names.
    unsafe {
        let mut info: libc::rusage_info_v4 = std::mem::zeroed();
        if libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V4, &mut info as *mut _ as *mut libc::rusage_info_t) != 0 {
            return None;
        }
        // The times are in Mach absolute time units (not ns on Apple silicon).
        let mut tb = libc::mach_timebase_info { numer: 0, denom: 0 };
        libc::mach_timebase_info(&mut tb);
        let ticks = (info.ri_user_time + info.ri_system_time) as f64;
        let ns = if tb.denom == 0 { ticks } else { ticks * tb.numer as f64 / tb.denom as f64 };
        Some(ProcStats { pid, cpu_ms: ns / 1e6, wakeups: info.ri_pkg_idle_wkups + info.ri_interrupt_wkups, footprint: info.ri_phys_footprint })
    }
}

#[cfg(not(target_os = "macos"))]
pub fn proc_stats(_pid: i32) -> Option<ProcStats> {
    None
}
