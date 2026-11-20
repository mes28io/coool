//! What the menu bar item reads of the Mac, and the maths that turns raw counters into the figures it shows.
//!
//! Every read here is one an ordinary user process may make without any permission prompt: Mach host statistics
//! (CPU ticks, VM pages), `sysctl`, `statfs`, `getifaddrs`, libproc on processes the person can read (their own:
//! other users' processes, root's daemons, answer EPERM and are left out), `getloadavg`, IOKit registry properties.
//! The definitions follow Activity Monitor's where it has one:
//! - CPU: (user + system + nice) ticks over all ticks between two samples, all cores together (0..=100%). Per core
//!   the same per processor. A process's "% CPU" is CPU time over wall time, where 100% is one core.
//! - Memory used: App memory (anonymous pages minus purgeable) + Wired + Compressed (pages the compressor occupies),
//!   Activity Monitor's "Memory Used". Pressure is the kernel's own level (normal / warning / critical), the one
//!   Activity Monitor colours its graph by. Swap: `vm.swapusage`.
//! - Disk: what `df` calls available on the startup volume (`statfs("/")`), which on APFS is the container's free
//!   space. Finder may show more: it counts purgeable space as available.
//! - Network: bytes in and out on the Mac's own links (Wi-Fi, Ethernet, cellular), not loopback, not VPN tunnels
//!   (their traffic is counted once already on the link it rides on).

use serde::Serialize;
use std::collections::HashMap;

/// One processor's cumulative ticks (`PROCESSOR_CPU_LOAD_INFO`: user, system, idle, nice).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Ticks {
    pub user: u32,
    pub system: u32,
    pub idle: u32,
    pub nice: u32,
}

/// Busy share (0..=1) of the ticks between `a` and `b`, wrap-safe (the counters are 32-bit). None when no tick passed.
pub fn busy(a: &Ticks, b: &Ticks) -> Option<f64> {
    let d = |x: u32, y: u32| y.wrapping_sub(x) as u64;
    let used = d(a.user, b.user) + d(a.system, b.system) + d(a.nice, b.nice);
    let total = used + d(a.idle, b.idle);
    (total > 0).then(|| used as f64 / total as f64)
}

/// Whole-machine and per-core busy shares between two per-processor readings. A changed core count (should never
/// happen) gives no reading rather than a wrong one.
pub fn cpu_between(a: &[Ticks], b: &[Ticks]) -> Option<(f64, Vec<f64>)> {
    if a.is_empty() || a.len() != b.len() {
        return None;
    }
    let sum = |v: &[Ticks]| v.iter().fold(Ticks::default(), |s, t| Ticks { user: s.user.wrapping_add(t.user), system: s.system.wrapping_add(t.system), idle: s.idle.wrapping_add(t.idle), nice: s.nice.wrapping_add(t.nice) });
    let all = busy(&sum(a), &sum(b))?;
    let cores = a.iter().zip(b).map(|(x, y)| busy(x, y).unwrap_or(0.0)).collect();
    Some((all, cores))
}

/// The VM page counts the memory figures come from (`HOST_VM_INFO64`), and the page size.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VmPages {
    pub page_size: u64,
    pub internal: u64,
    pub purgeable: u64,
    pub wired: u64,
    pub compressor: u64,
    pub external: u64,
    pub free: u64,
    pub speculative: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Pressure {
    Normal,
    Warning,
    Critical,
}

/// `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical.
pub fn pressure_of(level: u64) -> Option<Pressure> {
    match level {
        1 => Some(Pressure::Normal),
        2 => Some(Pressure::Warning),
        4 => Some(Pressure::Critical),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Memory {
    pub total: u64,
    /// Activity Monitor's "Memory Used": app + wired + compressed.
    pub used: u64,
    pub app: u64,
    pub wired: u64,
    pub compressed: u64,
    /// Cached files (file-backed + purgeable): memory macOS hands back as soon as something needs it.
    pub cached: u64,
    pub pressure: Option<Pressure>,
    pub swap_used: Option<u64>,
}

pub fn memory_of(v: &VmPages, total: u64, pressure: Option<Pressure>, swap_used: Option<u64>) -> Memory {
    let p = v.page_size;
    let app = v.internal.saturating_sub(v.purgeable) * p;
    let wired = v.wired * p;
    let compressed = v.compressor * p;
    Memory { total, used: (app + wired + compressed).min(total.max(1)), app, wired, compressed, cached: (v.external + v.purgeable) * p, pressure, swap_used }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Disk {
    /// Bytes available to the person (`f_bavail`), as `df` reports them.
    pub free: u64,
    pub total: u64,
}

pub fn disk_of(bavail: u64, blocks: u64, bsize: u64) -> Disk {
    Disk { free: bavail.saturating_mul(bsize), total: blocks.saturating_mul(bsize) }
}

/// Cumulative bytes on the Mac's links (32-bit counters per interface, summed by the reader as u64 deltas).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NetCounters {
    /// Interface name -> (in, out).
    pub by_if: HashMap<String, (u32, u32)>,
}

/// Whether an interface counts: the Mac's own links, not loopback, tunnels, AirDrop or bridges.
pub fn counts_link(name: &str) -> bool {
    name.starts_with("en") || name.starts_with("pdp_ip")
}

/// Bytes per second in and out between two readings `secs` apart; wrap-safe per interface, interfaces that came or
/// went in between left out.
pub fn net_rate(a: &NetCounters, b: &NetCounters, secs: f64) -> Option<(f64, f64)> {
    if secs <= 0.0 {
        return None;
    }
    let (mut i, mut o) = (0u64, 0u64);
    for (name, (bi, bo)) in &b.by_if {
        if let Some((ai, ao)) = a.by_if.get(name) {
            i += bi.wrapping_sub(*ai) as u64;
            o += bo.wrapping_sub(*ao) as u64;
        }
    }
    Some((i as f64 / secs, o as f64 / secs))
}

/// One process as a scan sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct Proc {
    pub pid: i32,
    pub ppid: i32,
    pub name: String,
    /// CPU time so far, user + system, ns.
    pub cpu_ns: u64,
}

/// A process's share of one core (100 = one core busy) between two scans `wall_ns` apart; a pid not in the earlier
/// scan (new, or reused) is measured from the scan's start only if it is new: None.
pub fn proc_cpu(before: Option<&Proc>, now: &Proc, wall_ns: u64) -> Option<f64> {
    let b = before?;
    if wall_ns == 0 || b.name != now.name || now.cpu_ns < b.cpu_ns {
        return None;
    }
    Some((now.cpu_ns - b.cpu_ns) as f64 / wall_ns as f64 * 100.0)
}

/// What the scan saw for one process, between two scans.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProcUse {
    pub pid: i32,
    pub ppid: i32,
    pub name: String,
    /// Percent of one core.
    pub cpu: f64,
}

/// Every process in `now` that was in `before` too, with its CPU share, busiest first.
pub fn proc_uses(before: &[Proc], now: &[Proc], wall_ns: u64) -> Vec<ProcUse> {
    let prev: HashMap<i32, &Proc> = before.iter().map(|p| (p.pid, p)).collect();
    let mut out: Vec<ProcUse> = now.iter().filter_map(|p| proc_cpu(prev.get(&p.pid).copied(), p, wall_ns).map(|cpu| ProcUse { pid: p.pid, ppid: p.ppid, name: p.name.clone(), cpu })).collect();
    out.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal).then(a.pid.cmp(&b.pid)));
    out
}

/// The idle and display state, for the sampler's back-off.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Presence {
    /// Seconds since the last keyboard or mouse input (None: unknown).
    pub idle_secs: Option<f64>,
    /// The main display sleeps.
    pub display_asleep: bool,
    /// The login session's screen is locked.
    pub locked: bool,
}

#[cfg(target_os = "macos")]
pub use sys::*;

#[cfg(target_os = "macos")]
mod sys {
    use super::*;
    use std::ffi::{CStr, CString, c_char, c_void};

    fn sysctl_raw(name: &str, buf: &mut [u8]) -> Option<usize> {
        let name = CString::new(name).ok()?;
        let mut len = buf.len();
        // SAFETY: name is NUL-terminated; buf/len describe a valid writable buffer.
        let rc = unsafe { libc::sysctlbyname(name.as_ptr() as *const c_char, buf.as_mut_ptr() as *mut c_void, &mut len, std::ptr::null_mut(), 0) };
        (rc == 0).then_some(len)
    }

    pub fn sysctl_u64(name: &str) -> Option<u64> {
        let mut buf = [0u8; 8];
        match sysctl_raw(name, &mut buf)? {
            4 => Some(u32::from_ne_bytes(buf[..4].try_into().ok()?) as u64),
            8 => Some(u64::from_ne_bytes(buf)),
            _ => None,
        }
    }

    /// Per-processor ticks (`host_processor_info`).
    pub fn cpu_ticks() -> Option<Vec<Ticks>> {
        let mut n: libc::natural_t = 0;
        let mut info: libc::processor_info_array_t = std::ptr::null_mut();
        let mut count: libc::mach_msg_type_number_t = 0;
        // SAFETY: the kernel allocates `info` (count ints) in our address space; it is read, then deallocated.
        unsafe {
            #[allow(deprecated)]
            let host = libc::mach_host_self();
            if libc::host_processor_info(host, libc::PROCESSOR_CPU_LOAD_INFO, &mut n, &mut info, &mut count) != 0 || info.is_null() {
                return None;
            }
            let per = libc::CPU_STATE_MAX as usize;
            let s = std::slice::from_raw_parts(info as *const u32, count as usize);
            let out = (0..n as usize)
                .filter(|i| (i + 1) * per <= s.len())
                .map(|i| {
                    let t = &s[i * per..(i + 1) * per];
                    Ticks { user: t[libc::CPU_STATE_USER as usize], system: t[libc::CPU_STATE_SYSTEM as usize], idle: t[libc::CPU_STATE_IDLE as usize], nice: t[libc::CPU_STATE_NICE as usize] }
                })
                .collect();
            #[allow(deprecated)]
            libc::vm_deallocate(libc::mach_task_self(), info as libc::vm_address_t, count as usize * std::mem::size_of::<libc::integer_t>());
            Some(out)
        }
    }

    pub fn vm_pages() -> Option<VmPages> {
        // SAFETY: a zeroed out-struct and its size in words, as the flavor asks.
        unsafe {
            let mut v: libc::vm_statistics64 = std::mem::zeroed();
            let mut count = libc::HOST_VM_INFO64_COUNT;
            #[allow(deprecated)]
            let host = libc::mach_host_self();
            if libc::host_statistics64(host, libc::HOST_VM_INFO64, &mut v as *mut _ as libc::host_info64_t, &mut count) != 0 {
                return None;
            }
            
            let page_size = sysctl_u64("hw.pagesize").filter(|&p| p > 0).unwrap_or(16384);
            Some(VmPages {
                page_size,
                internal: v.internal_page_count as u64,
                purgeable: v.purgeable_count as u64,
                wired: v.wire_count as u64,
                compressor: v.compressor_page_count as u64,
                external: v.external_page_count as u64,
                free: v.free_count as u64,
                speculative: v.speculative_count as u64,
            })
        }
    }

    pub fn memory() -> Option<Memory> {
        let v = vm_pages()?;
        let total = sysctl_u64("hw.memsize")?;
        let pressure = sysctl_u64("kern.memorystatus_vm_pressure_level").and_then(pressure_of);
        let mut sw = [0u8; std::mem::size_of::<libc::xsw_usage>()];
        let swap = sysctl_raw("vm.swapusage", &mut sw).filter(|&n| n == sw.len()).map(|_| {
            // SAFETY: the kernel filled exactly one xsw_usage.
            let x: libc::xsw_usage = unsafe { std::ptr::read_unaligned(sw.as_ptr() as *const libc::xsw_usage) };
            x.xsu_used
        });
        Some(memory_of(&v, total, pressure, swap))
    }

    pub fn disk() -> Option<Disk> {
        // SAFETY: a zeroed out-struct for statfs on a NUL-terminated path.
        unsafe {
            let mut s: libc::statfs = std::mem::zeroed();
            if libc::statfs(c"/".as_ptr(), &mut s) != 0 {
                return None;
            }
            Some(disk_of(s.f_bavail, s.f_blocks, s.f_bsize as u64))
        }
    }

    /// The prefix of `struct if_data` (net/if_var.h) up to the byte counters.
    #[repr(C)]
    struct IfData {
        _chars: [u8; 8],
        _mtu: u32,
        _metric: u32,
        _baudrate: u32,
        _ipackets: u32,
        _ierrors: u32,
        _opackets: u32,
        _oerrors: u32,
        _collisions: u32,
        ibytes: u32,
        obytes: u32,
    }

    pub fn net() -> Option<NetCounters> {
        let mut out = NetCounters::default();
        // SAFETY: getifaddrs' list is walked read-only and freed once; AF_LINK entries carry a `struct if_data`.
        unsafe {
            let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
            if libc::getifaddrs(&mut head) != 0 {
                return None;
            }
            let mut p = head;
            while !p.is_null() {
                let a = &*p;
                if !a.ifa_addr.is_null() && (*a.ifa_addr).sa_family as i32 == libc::AF_LINK && !a.ifa_data.is_null() && a.ifa_flags & libc::IFF_UP as u32 != 0 {
                    let name = CStr::from_ptr(a.ifa_name).to_string_lossy().into_owned();
                    if counts_link(&name) {
                        let d = &*(a.ifa_data as *const IfData);
                        out.by_if.insert(name, (d.ibytes, d.obytes));
                    }
                }
                p = a.ifa_next;
            }
            libc::freeifaddrs(head);
        }
        Some(out)
    }

    pub fn load_avg() -> Option<[f64; 3]> {
        let mut l = [0f64; 3];
        // SAFETY: room for the three averages asked for.
        (unsafe { libc::getloadavg(l.as_mut_ptr(), 3) } == 3).then_some(l)
    }

    /// Every process this user may read: pid, parent, name, CPU time. Others (root's, other users') are skipped.
    #[allow(deprecated)]
    pub fn procs() -> Vec<Proc> {
        let mut pids = vec![0i32; 4096];
        // SAFETY: the buffer and its size in bytes; the call returns how many pids it wrote.
        let n = unsafe { libc::proc_listallpids(pids.as_mut_ptr() as *mut c_void, (pids.len() * 4) as i32) };
        if n <= 0 {
            return Vec::new();
        }
        let mut tb = libc::mach_timebase_info { numer: 0, denom: 0 };
        // SAFETY: writes the two fields.
        unsafe { libc::mach_timebase_info(&mut tb) };
        let scale = if tb.denom == 0 { 1.0 } else { tb.numer as f64 / tb.denom as f64 };
        let mut out = Vec::with_capacity(n as usize);
        for &pid in &pids[..(n as usize).min(pids.len())] {
            if pid <= 0 {
                continue;
            }
            // SAFETY: zeroed out-structs of the sizes the flavors name.
            unsafe {
                let mut ru: libc::rusage_info_v4 = std::mem::zeroed();
                if libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V4, &mut ru as *mut _ as *mut libc::rusage_info_t) != 0 {
                    continue;
                }
                let mut bi: libc::proc_bsdshortinfo = std::mem::zeroed();
                let sz = std::mem::size_of::<libc::proc_bsdshortinfo>() as i32;
                if libc::proc_pidinfo(pid, libc::PROC_PIDT_SHORTBSDINFO, 0, &mut bi as *mut _ as *mut c_void, sz) != sz {
                    continue;
                }
                let mut name = [0u8; 256];
                let len = libc::proc_name(pid, name.as_mut_ptr() as *mut c_void, name.len() as u32);
                let name = if len > 0 {
                    String::from_utf8_lossy(&name[..len as usize]).into_owned()
                } else {
                    CStr::from_ptr(bi.pbsi_comm.as_ptr()).to_string_lossy().into_owned()
                };
                let ticks = (ru.ri_user_time + ru.ri_system_time) as f64;
                out.push(Proc { pid, ppid: bi.pbsi_ppid as i32, name, cpu_ns: (ticks * scale) as u64 });
            }
        }
        out
    }

    type CFTypeRef = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(cf: CFTypeRef);
        fn CFStringCreateWithCString(alloc: CFTypeRef, s: *const c_char, encoding: u32) -> CFTypeRef;
        fn CFNumberGetValue(n: CFTypeRef, kind: i64, out: *mut c_void) -> bool;
        fn CFDictionaryGetValue(d: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
        fn CFBooleanGetValue(b: CFTypeRef) -> u8;
        fn CFGetTypeID(cf: CFTypeRef) -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFNumberGetTypeID() -> usize;
    }
    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOServiceGetMatchingService(main_port: u32, matching: *mut c_void) -> u32;
        fn IOServiceMatching(name: *const c_char) -> *mut c_void;
        fn IORegistryEntryCreateCFProperty(entry: u32, key: CFTypeRef, alloc: CFTypeRef, options: u32) -> CFTypeRef;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayIsAsleep(d: u32) -> u32;
        fn CGSessionCopyCurrentDictionary() -> CFTypeRef;
    }

    fn cfstr(s: &CStr) -> CFTypeRef {
        // SAFETY: a NUL-terminated UTF-8 string; the result is owned (+1) by the caller.
        unsafe { CFStringCreateWithCString(std::ptr::null(), s.as_ptr(), 0x0800_0100) }
    }

    /// The HID system's registry entry, found once (a plain registry read: no Input Monitoring permission involved).
    fn hid_system() -> u32 {
        static HID: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
        // SAFETY: IOServiceMatching's dictionary is consumed by IOServiceGetMatchingService.
        *HID.get_or_init(|| unsafe { IOServiceGetMatchingService(0, IOServiceMatching(c"IOHIDSystem".as_ptr())) })
    }

    pub fn presence() -> Presence {
        let mut p = Presence::default();
        // SAFETY: Create/Copy results are released; Get results are borrowed and type-checked before use.
        unsafe {
            let hid = hid_system();
            if hid != 0 {
                let key = cfstr(c"HIDIdleTime");
                let v = IORegistryEntryCreateCFProperty(hid, key, std::ptr::null(), 0);
                CFRelease(key);
                if !v.is_null() {
                    let mut ns: i64 = 0;
                    if CFGetTypeID(v) == CFNumberGetTypeID() && CFNumberGetValue(v, 4 /* kCFNumberSInt64Type */, &mut ns as *mut i64 as *mut c_void) {
                        p.idle_secs = Some(ns as f64 / 1e9);
                    }
                    CFRelease(v);
                }
            }
            p.display_asleep = CGDisplayIsAsleep(CGMainDisplayID()) != 0;
            let d = CGSessionCopyCurrentDictionary();
            if !d.is_null() {
                let key = cfstr(c"CGSSessionScreenIsLocked");
                let v = CFDictionaryGetValue(d, key);
                CFRelease(key);
                p.locked = !v.is_null() && CFGetTypeID(v) == CFBooleanGetTypeID() && CFBooleanGetValue(v) != 0;
                CFRelease(d);
            }
        }
        p
    }
}

#[cfg(not(target_os = "macos"))]
mod sys_none {
    use super::*;
    pub fn cpu_ticks() -> Option<Vec<Ticks>> {
        None
    }
    pub fn memory() -> Option<Memory> {
        None
    }
    pub fn disk() -> Option<Disk> {
        None
    }
    pub fn net() -> Option<NetCounters> {
        None
    }
    pub fn load_avg() -> Option<[f64; 3]> {
        None
    }
    pub fn procs() -> Vec<Proc> {
        Vec::new()
    }
    pub fn presence() -> Presence {
        Presence::default()
    }
}
#[cfg(not(target_os = "macos"))]
pub use sys_none::*;

#[cfg(test)]
mod tests {
    use super::*;

    fn t(user: u32, system: u32, idle: u32, nice: u32) -> Ticks {
        Ticks { user, system, idle, nice }
    }

    #[test]
    fn cpu_share_from_tick_deltas() {
        assert_eq!(busy(&t(0, 0, 0, 0), &t(30, 10, 60, 0)), Some(0.4));
        assert_eq!(busy(&t(5, 5, 5, 5), &t(5, 5, 5, 5)), None, "no tick passed: no reading");
        assert_eq!(busy(&t(0, 0, 0, 0), &t(0, 0, 100, 0)), Some(0.0));
        // nice counts as busy (Activity Monitor and top fold it into user).
        assert_eq!(busy(&t(0, 0, 0, 0), &t(0, 0, 50, 50)), Some(0.5));
        // 32-bit counters wrap: the delta is still right.
        assert_eq!(busy(&t(u32::MAX - 9, 0, u32::MAX - 9, 0), &t(10, 0, 10, 0)), Some(0.5));
    }

    #[test]
    fn whole_machine_is_ticks_summed_not_cores_averaged() {
        // Core 0 saw 100 ticks (all busy), core 1 only 300 (all idle): the machine is 25% busy, not 50%.
        let a = [t(0, 0, 0, 0), t(0, 0, 0, 0)];
        let b = [t(100, 0, 0, 0), t(0, 0, 300, 0)];
        let (all, cores) = cpu_between(&a, &b).unwrap();
        assert_eq!(all, 0.25);
        assert_eq!(cores, vec![1.0, 0.0]);
        assert!(cpu_between(&a, &b[..1]).is_none(), "core count changed");
        assert!(cpu_between(&[], &[]).is_none());
    }

    #[test]
    fn memory_used_is_app_plus_wired_plus_compressed() {
        let v = VmPages { page_size: 16384, internal: 1000, purgeable: 100, wired: 500, compressor: 200, external: 300, free: 50, speculative: 10 };
        let m = memory_of(&v, 64 * 16384 * 1000, Some(Pressure::Normal), Some(7));
        assert_eq!(m.app, 900 * 16384);
        assert_eq!(m.wired, 500 * 16384);
        assert_eq!(m.compressed, 200 * 16384);
        assert_eq!(m.used, 1600 * 16384);
        assert_eq!(m.cached, 400 * 16384);
        assert_eq!((m.pressure, m.swap_used), (Some(Pressure::Normal), Some(7)));
        // Never more than installed (counters read at slightly different moments).
        let big = VmPages { internal: 10_000, ..v };
        assert_eq!(memory_of(&big, 1000 * 16384, None, None).used, 1000 * 16384);
        assert_eq!(pressure_of(1), Some(Pressure::Normal));
        assert_eq!(pressure_of(2), Some(Pressure::Warning));
        assert_eq!(pressure_of(4), Some(Pressure::Critical));
        assert_eq!(pressure_of(0), None);
    }

    #[test]
    fn disk_free_is_available_blocks() {
        let d = disk_of(51_179_804 / 4, 482_797_652 / 4, 4096);
        assert_eq!(d.free, 51_179_804 / 4 * 4096);
        assert_eq!(d.total, 482_797_652 / 4 * 4096);
    }

    #[test]
    fn network_rate_counts_links_and_survives_wraps() {
        assert!(counts_link("en0") && counts_link("en7") && counts_link("pdp_ip0"));
        assert!(!counts_link("lo0") && !counts_link("utun3") && !counts_link("awdl0") && !counts_link("bridge0") && !counts_link("llw0"));
        let a = NetCounters { by_if: [("en0".to_string(), (u32::MAX - 999, 100)), ("en1".to_string(), (0, 0))].into() };
        let b = NetCounters { by_if: [("en0".to_string(), (1000, 2100)), ("en5".to_string(), (9_999_999, 0))].into() };
        assert_eq!(net_rate(&a, &b, 2.0), Some((1000.0, 1000.0)), "wrapped en0 counted, new en5 and gone en1 left out");
        assert_eq!(net_rate(&a, &b, 0.0), None);
    }

    #[test]
    fn process_cpu_is_time_over_wall_time() {
        let p = |pid, name: &str, ns| Proc { pid, ppid: 1, name: name.into(), cpu_ns: ns };
        let before = [p(10, "cargo", 1_000_000_000), p(11, "claude", 0), p(12, "gone", 5)];
        let now = [p(10, "cargo", 4_000_000_000), p(11, "claude", 500_000_000), p(13, "new", 9_000_000_000), p(12, "reused", 6)];
        let u = proc_uses(&before, &now, 2_000_000_000);
        // 3 s of CPU in 2 s: 150% (one and a half cores); a new pid and a reused one have no reading yet.
        assert_eq!(u.iter().map(|x| (x.pid, x.cpu)).collect::<Vec<_>>(), vec![(10, 150.0), (11, 25.0)]);
        assert_eq!(proc_cpu(Some(&p(1, "a", 10)), &p(1, "a", 5), 1), None, "time went backwards: a different process");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn this_mac_reads() {
        let a = cpu_ticks().expect("cpu ticks");
        assert!(!a.is_empty());
        std::thread::sleep(std::time::Duration::from_millis(200));
        let b = cpu_ticks().unwrap();
        let (all, cores) = cpu_between(&a, &b).expect("a reading");
        assert!((0.0..=1.0).contains(&all) && cores.len() == a.len());
        let m = memory().expect("memory");
        assert!(m.used > 0 && m.used <= m.total && m.pressure.is_some());
        let d = disk().expect("disk");
        assert!(d.free > 0 && d.free < d.total);
        assert!(load_avg().is_some());
        assert!(net().is_some());
        let me = std::process::id() as i32;
        let ps = procs();
        assert!(ps.iter().any(|p| p.pid == me), "our own process is readable");
        let _ = presence();
    }
}
