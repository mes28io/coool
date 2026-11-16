//! Device hints for the UI's "Reduce motion: Auto" setting: Low Power Mode,
//! the thermal state and (on a laptop) the battery. Read from macOS every
//! [`POLL`] and pushed as `motion-hints` when they change; `motion_hints`
//! returns the current reading. The UI adds the system "Reduce motion"
//! accessibility setting itself (`prefers-reduced-motion`).
//!
//! Polling, not notification observers: the values change rarely, the reads
//! are a few cheap calls, and it needs no run-loop or block plumbing.

use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// How often the hints are re-read.
pub const POLL: Duration = Duration::from_secs(15);
/// On battery below this (percent), Auto reduces motion.
pub const LOW_BATTERY: u8 = 20;

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
    pub reason: Option<&'static str>,
}

/// The Auto decision from the device state: reduce, and the first reason that holds.
pub fn decide(low_power: bool, thermal: Thermal, on_battery: Option<bool>, battery_pct: Option<u8>) -> (bool, Option<&'static str>) {
    if low_power {
        return (true, Some("Low Power Mode"));
    }
    if matches!(thermal, Thermal::Serious | Thermal::Critical) {
        return (true, Some("Mac running hot"));
    }
    if on_battery == Some(true) && battery_pct.is_some_and(|p| p < LOW_BATTERY) {
        return (true, Some("battery low"));
    }
    (false, None)
}

pub fn read() -> Hints {
    let (low_power, thermal) = sys::process_info();
    let (on_battery, battery_pct) = sys::battery();
    let (reduce, reason) = decide(low_power, thermal, on_battery, battery_pct);
    Hints { low_power, thermal, on_battery, battery_pct, reduce, reason }
}

#[tauri::command(async)]
pub fn motion_hints() -> Hints {
    read()
}

/// Re-reads the hints every [`POLL`] and emits `motion-hints` when they change.
pub fn spawn_watch(app: AppHandle) {
    std::thread::spawn(move || {
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

#[cfg(target_os = "macos")]
mod sys {
    use super::Thermal;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSProcessInfo, NSProcessInfoThermalState, NSString};
    use std::ffi::c_void;

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
    use super::Thermal;
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

    #[test]
    fn auto_reduces_for_low_power_heat_and_low_battery() {
        assert_eq!(decide(false, Thermal::Nominal, None, None), (false, None));
        assert_eq!(decide(false, Thermal::Fair, Some(false), Some(5)), (false, None), "fair is normal; plugged in ignores the level");
        assert_eq!(decide(true, Thermal::Nominal, None, None), (true, Some("Low Power Mode")));
        assert_eq!(decide(false, Thermal::Serious, None, None), (true, Some("Mac running hot")));
        assert_eq!(decide(false, Thermal::Critical, Some(true), Some(90)), (true, Some("Mac running hot")));
        assert_eq!(decide(false, Thermal::Nominal, Some(true), Some(19)), (true, Some("battery low")));
        assert_eq!(decide(false, Thermal::Nominal, Some(true), Some(20)), (false, None), "20% and up is fine");
        assert_eq!(decide(false, Thermal::Nominal, Some(true), None), (false, None), "unknown level");
        assert_eq!(decide(true, Thermal::Critical, Some(true), Some(1)), (true, Some("Low Power Mode")), "first reason wins");
    }

    #[test]
    fn reading_the_device_does_not_panic() {
        let h = read();
        assert_eq!((h.reduce, h.reason), decide(h.low_power, h.thermal, h.on_battery, h.battery_pct));
    }
}
