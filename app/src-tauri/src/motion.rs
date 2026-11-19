//! Device hints for the UI's "Reduce motion: Auto" setting: Low Power Mode,
//! the thermal state and (on a laptop) the battery. Read from macOS every
//! [`POLL`] and pushed as `motion-hints` when they change; `motion_hints`
//! returns the current reading. The UI adds the system "Reduce motion"
//! accessibility setting itself (`prefers-reduced-motion`).
//!
//! Two more Auto reasons: the hardware (an Intel Mac, 8 GB of memory or less,
//! 4 performance cores or fewer; read once) and a Mac that was busy right after
//! launch (whole-system CPU at 70% or more averaged over the first 20 s; decided
//! once and kept for the session).
//!
//! Polling, not notification observers: the values change rarely, the reads
//! are a few cheap calls, and it needs no run-loop or block plumbing.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// How often the hints are re-read.
pub const POLL: Duration = Duration::from_secs(15);
/// On battery below this (percent), Auto reduces motion.
pub const LOW_BATTERY: u8 = 20;

/// Hardware at or below this many GB of memory counts as weak.
pub const WEAK_MEMORY_GB: u32 = 8;
/// Hardware with this many performance cores or fewer counts as weak.
pub const WEAK_PERF_CORES: u32 = 4;
/// How long after launch the CPU is sampled for "busy at launch".
pub const LAUNCH_WINDOW: Duration = Duration::from_secs(20);
/// Gap between CPU samples in the launch window.
pub const SAMPLE_EVERY: Duration = Duration::from_secs(2);
/// Average whole-system busy share (0..=1) over the window that counts as busy.
pub const BUSY_SHARE: f64 = 0.70;
/// Samples (intervals) needed before a busy verdict, so one spike can't decide.
const MIN_INTERVALS: u32 = 3;

/// Set once, for the session, when the Mac was busy at launch.
static BUSY_AT_LAUNCH: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Thermal {
    Nominal,
    Fair,
    Serious,
    Critical,
}

/// What the device says, plus the Auto decision made from it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Hints {
    pub low_power: bool,
    pub thermal: Thermal,
    /// None: no battery (a desktop Mac) or unknown.
    pub on_battery: Option<bool>,
    pub battery_pct: Option<u8>,
    /// Auto would reduce motion now (ignoring the accessibility setting, which the UI knows).
    pub reduce: bool,
    /// Why, in a few words for the Settings row ("Low Power Mode").
    pub reason: Option<String>,
    /// Intel Mac (no Apple silicon).
    pub intel: bool,
    /// Installed memory in GB, rounded; None if unknown.
    pub memory_gb: Option<u32>,
    /// Performance cores (all physical cores on a Mac without core tiers); None if unknown.
    pub perf_cores: Option<u32>,
    /// The Mac was busy in the first seconds after launch (sticky for the session).
    pub busy_at_launch: bool,
}

/// Everything the Auto decision looks at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Inputs {
    pub low_power: bool,
    pub thermal: Thermal,
    pub on_battery: Option<bool>,
    pub battery_pct: Option<u8>,
    pub intel: bool,
    pub memory_gb: Option<u32>,
    pub perf_cores: Option<u32>,
    pub busy_at_launch: bool,
}

/// The Auto decision from the device state: reduce, and the first reason that holds.
/// Order: Low Power Mode, heat, low battery, weak hardware, busy at launch.
pub fn decide(i: &Inputs) -> (bool, Option<String>) {
    let reason = if i.low_power {
        "Low Power Mode".to_string()
    } else if matches!(i.thermal, Thermal::Serious | Thermal::Critical) {
        "Mac running hot".to_string()
    } else if i.on_battery == Some(true) && i.battery_pct.is_some_and(|p| p < LOW_BATTERY) {
        "battery low".to_string()
    } else if i.intel {
        "Intel Mac".to_string()
    } else if let Some(gb) = i.memory_gb.filter(|&g| g <= WEAK_MEMORY_GB) {
        format!("{gb} GB memory")
    } else if i.perf_cores.is_some_and(|c| c <= WEAK_PERF_CORES) {
        "few CPU cores".to_string()
    } else if i.busy_at_launch {
        "Mac busy at launch".to_string()
    } else {
        return (false, None);
    };
    (true, Some(reason))
}

/// Whether the launch-window samples so far say busy: `busy_ticks` and `total_ticks`
/// summed over `intervals` sample gaps.
pub fn busy_verdict(busy_ticks: u64, total_ticks: u64, intervals: u32) -> bool {
    intervals >= MIN_INTERVALS && total_ticks > 0 && busy_ticks as f64 / total_ticks as f64 >= BUSY_SHARE
}

struct Hardware {
    intel: bool,
    memory_gb: Option<u32>,
    perf_cores: Option<u32>,
}

fn hardware() -> &'static Hardware {
    static HW: OnceLock<Hardware> = OnceLock::new();
    HW.get_or_init(|| {
        let (intel, mem, cores) = sys::hardware();
        Hardware { intel, memory_gb: mem.map(|b| ((b as f64) / (1u64 << 30) as f64).round() as u32), perf_cores: cores }
    })
}

pub fn read() -> Hints {
    let (low_power, thermal) = sys::process_info();
    let (on_battery, battery_pct) = sys::battery();
    let hw = hardware();
    let busy_at_launch = BUSY_AT_LAUNCH.load(Ordering::Relaxed);
    let (reduce, reason) = decide(&Inputs {
        low_power,
        thermal,
        on_battery,
        battery_pct,
        intel: hw.intel,
        memory_gb: hw.memory_gb,
        perf_cores: hw.perf_cores,
        busy_at_launch,
    });
    Hints { low_power, thermal, on_battery, battery_pct, reduce, reason, intel: hw.intel, memory_gb: hw.memory_gb, perf_cores: hw.perf_cores, busy_at_launch }
}

/// The thermal state and the internal battery (on battery, percent) right now; also read by the lid hold (lid/).
pub fn power_now() -> (Thermal, Option<bool>, Option<u8>) {
    let (_, thermal) = sys::process_info();
    let (on_battery, pct) = sys::battery();
    (thermal, on_battery, pct)
}

#[tauri::command(async)]
pub fn motion_hints() -> Hints {
    read()
}

/// For the first [`LAUNCH_WINDOW`], samples whole-system CPU every [`SAMPLE_EVERY`] and
/// sets the sticky busy flag when the average share reaches [`BUSY_SHARE`]; emits as soon
/// as it flips. Returns early (no sampling) where the CPU can't be read.
fn sample_launch_load(app: &AppHandle) {
    let Some(mut prev) = sys::cpu_ticks() else { return };
    let start = Instant::now();
    let (mut busy, mut total, mut n) = (0u64, 0u64, 0u32);
    while start.elapsed() < LAUNCH_WINDOW {
        std::thread::sleep(SAMPLE_EVERY);
        let Some(now) = sys::cpu_ticks() else { return };
        let idle = now.idle.wrapping_sub(prev.idle) as u64;
        let used = (now.user.wrapping_sub(prev.user) as u64) + (now.system.wrapping_sub(prev.system) as u64) + (now.nice.wrapping_sub(prev.nice) as u64);
        busy += used;
        total += used + idle;
        n += 1;
        prev = now;
        if busy_verdict(busy, total, n) {
            BUSY_AT_LAUNCH.store(true, Ordering::Relaxed);
            let _ = app.emit("motion-hints", &read());
            return;
        }
    }
}

/// Re-reads the hints every [`POLL`] and emits `motion-hints` when they change.
/// The launch-load sampling runs first on this thread, then stops for good.
pub fn spawn_watch(app: AppHandle) {
    std::thread::spawn(move || {
        sample_launch_load(&app);
        let mut last = read();
        loop {
            std::thread::sleep(POLL);
            let now = read();
            if now != last {
                let _ = app.emit("motion-hints", &now);
                last = now;
            }
        }
    });
}

/// Cumulative CPU ticks (all cores).
#[derive(Clone, Copy, Debug)]
pub struct CpuTicks {
    pub user: u32,
    pub system: u32,
    pub idle: u32,
    pub nice: u32,
}

#[cfg(target_os = "macos")]
mod sys {
    use super::Thermal;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSProcessInfo, NSProcessInfoThermalState, NSString};
    use super::CpuTicks;
    use std::ffi::{c_char, c_void, CString};

    /// `sysctlbyname` into a u64 or u32 (sized by what the kernel returns).
    fn sysctl_u64(name: &str) -> Option<u64> {
        let name = CString::new(name).ok()?;
        let mut buf = [0u8; 8];
        let mut len = buf.len();
        // SAFETY: name is NUL-terminated; buf/len describe a valid writable buffer.
        let rc = unsafe { libc::sysctlbyname(name.as_ptr() as *const c_char, buf.as_mut_ptr() as *mut c_void, &mut len, std::ptr::null_mut(), 0) };
        match (rc, len) {
            (0, 4) => Some(u32::from_ne_bytes(buf[..4].try_into().ok()?) as u64),
            (0, 8) => Some(u64::from_ne_bytes(buf)),
            _ => None,
        }
    }

    /// (Intel, memory bytes, performance cores).
    pub fn hardware() -> (bool, Option<u64>, Option<u32>) {
        let arm = sysctl_u64("hw.optional.arm64").unwrap_or(0) == 1;
        let intel = !arm || cfg!(target_arch = "x86_64");
        let mem = sysctl_u64("hw.memsize");
        let cores = sysctl_u64("hw.perflevel0.physicalcpu").or_else(|| sysctl_u64("hw.physicalcpu")).map(|c| c as u32);
        (intel, mem, cores)
    }

    unsafe extern "C" {
        fn mach_host_self() -> u32;
        fn host_statistics(host: u32, flavor: i32, info: *mut i32, count: *mut u32) -> i32;
    }

    /// Whole-system CPU ticks since boot (`HOST_CPU_LOAD_INFO`: user, system, idle, nice).
    pub fn cpu_ticks() -> Option<CpuTicks> {
        const HOST_CPU_LOAD_INFO: i32 = 3;
        let mut info = [0i32; 4];
        let mut count = 4u32;
        // SAFETY: info holds the 4 natural_t ticks the flavor returns; count is its size in words.
        let rc = unsafe { host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, info.as_mut_ptr(), &mut count) };
        (rc == 0 && count == 4).then(|| CpuTicks { user: info[0] as u32, system: info[1] as u32, idle: info[2] as u32, nice: info[3] as u32 })
    }

    pub fn process_info() -> (bool, Thermal) {
        let p = NSProcessInfo::processInfo();
        let t = p.thermalState();
        let thermal = if t == NSProcessInfoThermalState::Critical {
            Thermal::Critical
        } else if t == NSProcessInfoThermalState::Serious {
            Thermal::Serious
        } else if t == NSProcessInfoThermalState::Fair {
            Thermal::Fair
        } else {
            Thermal::Nominal
        };
        (p.isLowPowerModeEnabled(), thermal)
    }

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPSCopyPowerSourcesInfo() -> *const c_void;
        fn IOPSCopyPowerSourcesList(blob: *const c_void) -> *const c_void;
        fn IOPSGetPowerSourceDescription(blob: *const c_void, ps: *const c_void) -> *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    /// (on battery, percent) of the internal battery; (None, None) without one.
    pub fn battery() -> (Option<bool>, Option<u8>) {
        // SAFETY: IOKit's documented Copy/Get rules: the blob and the list are
        // owned (+1, released below), descriptions are borrowed from the blob.
        // CFArray/CFDictionary/CFString/CFNumber are toll-free bridged to their
        // NS counterparts, so they are read through objc2-foundation.
        unsafe {
            let blob = IOPSCopyPowerSourcesInfo();
            if blob.is_null() {
                return (None, None);
            }
            let list = IOPSCopyPowerSourcesList(blob);
            let mut out = (None, None);
            if !list.is_null() {
                let arr = &*(list as *const NSArray<AnyObject>);
                for ps in arr.iter() {
                    let d = IOPSGetPowerSourceDescription(blob, Retained::as_ptr(&ps) as *const c_void);
                    if d.is_null() {
                        continue;
                    }
                    let d = &*(d as *const NSDictionary<NSString, AnyObject>);
                    let get = |k: &str| d.objectForKey(&NSString::from_str(k));
                    let is_internal = get("Type").and_then(|v| v.downcast::<NSString>().ok()).is_some_and(|s| s.to_string() == "InternalBattery");
                    if !is_internal {
                        continue;
                    }
                    let state = get("Power Source State").and_then(|v| v.downcast::<NSString>().ok()).map(|s| s.to_string());
                    let num = |k: &str| get(k).and_then(|v| v.downcast::<NSNumber>().ok()).map(|n| n.as_i64());
                    let pct = match (num("Current Capacity"), num("Max Capacity")) {
                        (Some(c), Some(m)) if m > 0 => Some((c * 100 / m).clamp(0, 100) as u8),
                        _ => None,
                    };
                    out = (state.map(|s| s == "Battery Power"), pct);
                    break;
                }
                CFRelease(list);
            }
            CFRelease(blob);
            out
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod sys {
    use super::{CpuTicks, Thermal};
    pub fn hardware() -> (bool, Option<u64>, Option<u32>) {
        (false, None, None)
    }
    pub fn cpu_ticks() -> Option<CpuTicks> {
        None
    }
    pub fn process_info() -> (bool, Thermal) {
        (false, Thermal::Nominal)
    }
    pub fn battery() -> (Option<bool>, Option<u8>) {
        (None, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Inputs {
        Inputs { low_power: false, thermal: Thermal::Nominal, on_battery: None, battery_pct: None, intel: false, memory_gb: Some(24), perf_cores: Some(8), busy_at_launch: false }
    }
    fn d(i: Inputs) -> (bool, Option<String>) {
        decide(&i)
    }
    fn yes(r: &str) -> (bool, Option<String>) {
        (true, Some(r.to_string()))
    }

    #[test]
    fn auto_reduces_for_low_power_heat_and_low_battery() {
        assert_eq!(d(base()), (false, None));
        assert_eq!(d(Inputs { thermal: Thermal::Fair, on_battery: Some(false), battery_pct: Some(5), ..base() }), (false, None), "fair is normal; plugged in ignores the level");
        assert_eq!(d(Inputs { low_power: true, ..base() }), yes("Low Power Mode"));
        assert_eq!(d(Inputs { thermal: Thermal::Serious, ..base() }), yes("Mac running hot"));
        assert_eq!(d(Inputs { thermal: Thermal::Critical, on_battery: Some(true), battery_pct: Some(90), ..base() }), yes("Mac running hot"));
        assert_eq!(d(Inputs { on_battery: Some(true), battery_pct: Some(19), ..base() }), yes("battery low"));
        assert_eq!(d(Inputs { on_battery: Some(true), battery_pct: Some(20), ..base() }), (false, None), "20% and up is fine");
        assert_eq!(d(Inputs { on_battery: Some(true), ..base() }), (false, None), "unknown level");
        assert_eq!(d(Inputs { low_power: true, thermal: Thermal::Critical, on_battery: Some(true), battery_pct: Some(1), ..base() }), yes("Low Power Mode"), "first reason wins");
    }

    #[test]
    fn auto_reduces_for_weak_hardware() {
        assert_eq!(d(Inputs { intel: true, ..base() }), yes("Intel Mac"));
        assert_eq!(d(Inputs { memory_gb: Some(8), ..base() }), yes("8 GB memory"));
        assert_eq!(d(Inputs { memory_gb: Some(4), ..base() }), yes("4 GB memory"));
        assert_eq!(d(Inputs { memory_gb: Some(16), ..base() }), (false, None));
        assert_eq!(d(Inputs { perf_cores: Some(4), ..base() }), yes("few CPU cores"));
        assert_eq!(d(Inputs { perf_cores: Some(5), ..base() }), (false, None));
        assert_eq!(d(Inputs { memory_gb: None, perf_cores: None, ..base() }), (false, None), "unknown hardware does not reduce");
    }

    #[test]
    fn busy_at_launch_reduces_last() {
        assert_eq!(d(Inputs { busy_at_launch: true, ..base() }), yes("Mac busy at launch"));
        assert_eq!(d(Inputs { busy_at_launch: true, perf_cores: Some(4), ..base() }), yes("few CPU cores"));
        assert_eq!(d(Inputs { busy_at_launch: true, memory_gb: Some(8), perf_cores: Some(2), ..base() }), yes("8 GB memory"));
        assert_eq!(d(Inputs { busy_at_launch: true, intel: true, memory_gb: Some(8), ..base() }), yes("Intel Mac"));
        assert_eq!(d(Inputs { busy_at_launch: true, on_battery: Some(true), battery_pct: Some(3), intel: true, ..base() }), yes("battery low"));
        assert_eq!(d(Inputs { busy_at_launch: true, thermal: Thermal::Serious, ..base() }), yes("Mac running hot"));
        assert_eq!(d(Inputs { busy_at_launch: true, low_power: true, ..base() }), yes("Low Power Mode"));
    }

    #[test]
    fn busy_verdict_needs_share_and_samples() {
        assert!(busy_verdict(70, 100, 5));
        assert!(!busy_verdict(69, 100, 5));
        assert!(!busy_verdict(100, 100, 2), "too few samples");
        assert!(!busy_verdict(0, 0, 10));
    }

    #[test]
    fn reading_the_device_does_not_panic() {
        let h = read();
        let i = Inputs {
            low_power: h.low_power,
            thermal: h.thermal,
            on_battery: h.on_battery,
            battery_pct: h.battery_pct,
            intel: h.intel,
            memory_gb: h.memory_gb,
            perf_cores: h.perf_cores,
            busy_at_launch: h.busy_at_launch,
        };
        assert_eq!((h.reduce, h.reason), decide(&i));
    }

    #[test]
    #[ignore = "prints this Mac's hints: cargo test -p coool-app print_hints -- --ignored --nocapture"]
    fn print_hints() {
        println!("{:#?}", read());
        println!("ticks: {:?}", sys::cpu_ticks());
    }
}
