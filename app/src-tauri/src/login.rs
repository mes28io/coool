//! Settings > General > "Open coool at login", through `SMAppService.mainAppService` (macOS 13+): the system's own
//! login item for the app bundle, listed in System Settings > General > Login Items, where the person can also turn
//! it off. Only an app bundle can register; a bare dev binary gets the system's error, shown as is.

use serde::Serialize;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct LoginStatus {
    /// "enabled" | "not_registered" | "requires_approval" | "not_found" | "unavailable"
    pub status: String,
    pub reason: Option<String>,
}

/// `SMAppServiceStatus` to the UI's words.
pub fn status_name(s: isize) -> &'static str {
    match s {
        1 => "enabled",
        2 => "requires_approval",
        3 => "not_found",
        _ => "not_registered",
    }
}

pub use sys::{set, status};

#[cfg(target_os = "macos")]
mod sys {
    use super::{LoginStatus, status_name};
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::NSError;

    #[link(name = "ServiceManagement", kind = "framework")]
    unsafe extern "C" {}

    fn service() -> Result<Retained<AnyObject>, String> {
        let cls = AnyClass::get(c"SMAppService").ok_or("Login items need macOS 13 or later.")?;
        let s: Option<Retained<AnyObject>> = unsafe { msg_send![cls, mainAppService] };
        s.ok_or_else(|| "macOS has no login item for this build.".to_string())
    }

    pub fn status() -> LoginStatus {
        match service() {
            Ok(s) => {
                let n: isize = unsafe { msg_send![&*s, status] };
                LoginStatus { status: status_name(n).into(), reason: None }
            }
            Err(r) => LoginStatus { status: "unavailable".into(), reason: Some(r) },
        }
    }

    pub fn set(on: bool) -> Result<LoginStatus, String> {
        let s = service()?;
        let r: Result<(), Retained<NSError>> = if on { unsafe { msg_send![&*s, registerAndReturnError: _] } } else { unsafe { msg_send![&*s, unregisterAndReturnError: _] } };
        r.map_err(|e| e.localizedDescription().to_string())?;
        Ok(status())
    }
}

#[cfg(not(target_os = "macos"))]
mod sys {
    use super::LoginStatus;
    pub fn status() -> LoginStatus {
        LoginStatus { status: "unavailable".into(), reason: Some("Login items are macOS only for now.".into()) }
    }
    pub fn set(_on: bool) -> Result<LoginStatus, String> {
        Err("Login items are macOS only for now.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_names() {
        assert_eq!(status_name(0), "not_registered");
        assert_eq!(status_name(1), "enabled");
        assert_eq!(status_name(2), "requires_approval");
        assert_eq!(status_name(3), "not_found");
    }

    /// Reading the status never registers anything (safe on the person's Mac).
    #[cfg(target_os = "macos")]
    #[test]
    fn status_reads_without_registering() {
        let s = status();
        assert!(["enabled", "not_registered", "requires_approval", "not_found", "unavailable"].contains(&s.status.as_str()), "{s:?}");
    }
}
