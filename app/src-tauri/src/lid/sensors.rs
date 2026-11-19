//! The lid hold's readings: battery and heat (the same reads as Reduce motion's, `motion::power_now`) and three of
//! `IOPMrootDomain`'s registry properties, readable by any process:
//! - `AppleClamshellState`: the lid is closed (absent without a lid);
//! - `AppleClamshellCausesSleep`: closing it sleeps the Mac (No in closed-display mode: on power with a display);
//! - `SleepDisabled`: the switch `pmset disablesleep` sets.

use super::{Reading, Sensors};
use std::sync::{Arc, Mutex};

pub struct System;

impl Sensors for System {
    fn read(&mut self) -> Reading {
        let (thermal, on_battery, battery_pct) = crate::motion::power_now();
        Reading {
            on_battery,
            battery_pct,
            thermal: Some(thermal),
            lid_closed: sys::root_bool("AppleClamshellState"),
            lid_sleeps: sys::root_bool("AppleClamshellCausesSleep"),
            sleep_disabled: sys::root_bool("SleepDisabled"),
        }
    }
}

/// Readings a self-test sets (`lid_simulate`); shared with the command that changes them.
#[derive(Clone, Default)]
pub struct Fake(pub Arc<Mutex<Reading>>);

impl Sensors for Fake {
    fn read(&mut self) -> Reading {
        self.0.lock().unwrap().clone()
    }
}

#[cfg(target_os = "macos")]
mod sys {
    use std::ffi::{CString, c_char, c_void};

    type CFTypeRef = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(alloc: *const c_void, s: *const c_char, encoding: u32) -> CFTypeRef;
        fn CFRelease(cf: CFTypeRef);
        fn CFGetTypeID(cf: CFTypeRef) -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFBooleanGetValue(b: CFTypeRef) -> u8;
    }
    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOServiceMatching(name: *const c_char) -> *mut c_void;
        fn IOServiceGetMatchingService(main_port: u32, matching: *mut c_void) -> u32;
        fn IORegistryEntryCreateCFProperty(entry: u32, key: CFTypeRef, alloc: *const c_void, options: u32) -> CFTypeRef;
        fn IOObjectRelease(obj: u32) -> i32;
    }
    const UTF8: u32 = 0x0800_0100;

    /// A boolean property of IOPMrootDomain; None when it's absent (e.g. no lid).
    pub fn root_bool(key: &str) -> Option<bool> {
        let name = CString::new("IOPMrootDomain").ok()?;
        let key = CString::new(key).ok()?;
        // SAFETY: IOServiceGetMatchingService consumes the matching dictionary; the entry and the CF objects we
        // create or copy are released below; the property is only read after its type is checked.
        unsafe {
            let root = IOServiceGetMatchingService(0, IOServiceMatching(name.as_ptr()));
            if root == 0 {
                return None;
            }
            let k = CFStringCreateWithCString(std::ptr::null(), key.as_ptr(), UTF8);
            if k.is_null() {
                IOObjectRelease(root);
                return None;
            }
            let v = IORegistryEntryCreateCFProperty(root, k, std::ptr::null(), 0);
            CFRelease(k);
            IOObjectRelease(root);
            if v.is_null() {
                return None;
            }
            let out = (CFGetTypeID(v) == CFBooleanGetTypeID()).then(|| CFBooleanGetValue(v) != 0);
            CFRelease(v);
            out
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod sys {
    pub fn root_bool(_key: &str) -> Option<bool> {
        None
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn reads_the_root_domain_like_ioreg_does() {
        // Read-only: compares with `ioreg`'s view of the same properties.
        let out = std::process::Command::new("ioreg").args(["-r", "-k", "AppleClamshellState", "-d", "1"]).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
        let want = |k: &str| out.lines().find(|l| l.contains(&format!("\"{k}\" ="))).map(|l| l.trim_end().ends_with("Yes"));
        assert_eq!(super::sys::root_bool("AppleClamshellState"), want("AppleClamshellState"));
        assert_eq!(super::sys::root_bool("AppleClamshellCausesSleep"), want("AppleClamshellCausesSleep"));
        assert_eq!(super::sys::root_bool("NoSuchKeyForCoool"), None);
    }
}
