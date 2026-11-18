//! Settings > Notifications: macOS notifications when an agent in a coool chat needs the person (a permission
//! request or a question), finishes a turn, or fails (a turn that ended in an error, or the CLI exiting with an
//! error code). Each kind can be turned off, the sound too, and "Only when coool isn't focused" (on by default) keeps
//! them quiet while the person is looking at the window.
//!
//! The output pump hands every chat event to [`Notifier::on_event`]; [`kind_of`] picks the ones that notify and
//! [`should`] applies the settings. Delivery goes through `UNUserNotificationCenter` (the system's permission flow:
//! the first notification, or "Allow notifications" in Settings, asks once; after that only System Settings can
//! change it). An interrupt or stop the person asked for is not a failure: [`Notifier::user_stopped`] marks the chat
//! for a few seconds.

use coool_core::chat::{ChatEventKind, ChatState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    NeedsYou,
    Finished,
    Failed,
}

/// The notification settings (persisted with the backend settings).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Prefs {
    #[serde(default = "yes")]
    pub needs_you: bool,
    #[serde(default)]
    pub finished: bool,
    #[serde(default = "yes")]
    pub failed: bool,
    #[serde(default = "yes")]
    pub sound: bool,
    #[serde(default = "yes")]
    pub only_unfocused: bool,
}

fn yes() -> bool {
    true
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { needs_you: true, finished: false, failed: true, sound: true, only_unfocused: true }
    }
}

/// Which notification an event is, with a one-line detail ("Bash: rm -rf build"), or None.
pub fn kind_of(ev: &ChatEventKind) -> Option<(Kind, String)> {
    match ev {
        ChatEventKind::PermissionRequest { tool, summary, .. } => Some((Kind::NeedsYou, if summary.is_empty() { format!("Wants to use {tool}") } else { format!("{tool}: {summary}") })),
        ChatEventKind::Question { questions, .. } => {
            let q = serde_json::to_value(questions).ok().and_then(|v| v.get(0).and_then(|q| q.get("question")).and_then(|q| q.as_str()).map(str::to_string));
            Some((Kind::NeedsYou, q.unwrap_or_else(|| "Has a question for you".into())))
        }
        ChatEventKind::State { state: ChatState::WaitingPermission } => None,
        ChatEventKind::TurnEnd { ok: true, duration_ms } => Some((Kind::Finished, format!("Finished after {}", human(*duration_ms)))),
        ChatEventKind::TurnEnd { ok: false, .. } => Some((Kind::Failed, "The turn ended with an error".into())),
        ChatEventKind::Exited { code: Some(c) } if *c != 0 => Some((Kind::Failed, format!("The CLI exited with code {c}"))),
        _ => None,
    }
}

fn human(ms: u64) -> String {
    let s = ms / 1000;
    if s < 60 { format!("{s}s") } else if s < 3600 { format!("{}m {}s", s / 60, s % 60) } else { format!("{}h {}m", s / 3600, (s % 3600) / 60) }
}

/// Whether a notification of `kind` goes out with these settings while the window is (or isn't) focused.
pub fn should(kind: Kind, p: &Prefs, focused: bool) -> bool {
    let on = match kind {
        Kind::NeedsYou => p.needs_you,
        Kind::Finished => p.finished,
        Kind::Failed => p.failed,
    };
    on && !(p.only_unfocused && focused)
}

/// How long after the person stopped or interrupted a chat its error ending doesn't count as a failure.
const STOP_GRACE: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct Notifier {
    pub prefs: Mutex<Prefs>,
    focused: std::sync::atomic::AtomicBool,
    stopped: Mutex<HashMap<usize, Instant>>,
}

impl Notifier {
    pub fn new(prefs: Prefs) -> Self {
        Notifier { prefs: Mutex::new(prefs), focused: std::sync::atomic::AtomicBool::new(true), stopped: Mutex::default() }
    }

    pub fn set_focused(&self, f: bool) {
        self.focused.store(f, std::sync::atomic::Ordering::Relaxed);
    }

    /// The person interrupted or stopped chat `id` (its error ending is theirs, not a failure).
    pub fn user_stopped(&self, id: usize) {
        let mut m = self.stopped.lock().unwrap();
        m.retain(|_, t| t.elapsed() < STOP_GRACE);
        m.insert(id, Instant::now());
    }

    /// The notification for one chat event, if it should go out: (kind, title, body).
    pub fn decide(&self, id: usize, title: &str, ev: &ChatEventKind) -> Option<(Kind, String, String)> {
        let (kind, detail) = kind_of(ev)?;
        if kind == Kind::Failed && self.stopped.lock().unwrap().get(&id).is_some_and(|t| t.elapsed() < STOP_GRACE) {
            return None;
        }
        let p = self.prefs.lock().unwrap().clone();
        if !should(kind, &p, self.focused.load(std::sync::atomic::Ordering::Relaxed)) {
            return None;
        }
        let head = match kind {
            Kind::NeedsYou => "needs you",
            Kind::Finished => "finished",
            Kind::Failed => "failed",
        };
        Some((kind, format!("{title} {head}"), detail))
    }

    /// Posts what [`Self::decide`] allows, on a background thread.
    pub fn on_event(&self, id: usize, title: &str, ev: &ChatEventKind) {
        if let Some((_, t, b)) = self.decide(id, title, ev) {
            let sound = self.prefs.lock().unwrap().sound;
            std::thread::spawn(move || {
                let _ = post(&t, &b, sound);
            });
        }
    }
}

/// Where the system's notification permission stands for coool.
#[derive(Clone, Debug, Serialize)]
pub struct Permission {
    /// "authorized" | "denied" | "not_determined" | "provisional" | "unavailable"
    pub status: String,
    /// Why when unavailable or the request failed.
    pub reason: Option<String>,
}

pub use sys::{permission, post, request};

#[cfg(target_os = "macos")]
mod sys {
    use super::Permission;
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSBundle, NSError, NSString};
    use objc2_user_notifications::{UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotificationRequest, UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter};
    use std::ptr::NonNull;
    use std::sync::mpsc;
    use std::time::Duration;

    /// `UNUserNotificationCenter` throws without a bundle identifier (a bare binary): check first.
    fn center() -> Result<objc2::rc::Retained<UNUserNotificationCenter>, String> {
        let id = NSBundle::mainBundle().bundleIdentifier();
        if id.is_none() {
            return Err("This build of coool has no app bundle, so macOS won't show its notifications.".into());
        }
        Ok(UNUserNotificationCenter::currentNotificationCenter())
    }

    fn err_text(e: *mut NSError) -> Option<String> {
        // SAFETY: the completion handler's error is null or a valid NSError for the call's duration.
        unsafe { e.as_ref() }.map(|e| e.localizedDescription().to_string())
    }

    pub fn permission() -> Permission {
        let c = match center() {
            Ok(c) => c,
            Err(r) => return Permission { status: "unavailable".into(), reason: Some(r) },
        };
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |s: NonNull<UNNotificationSettings>| {
            // SAFETY: a valid settings object for the handler's duration.
            let st = unsafe { s.as_ref() }.authorizationStatus();
            let _ = tx.send(st);
        });
        c.getNotificationSettingsWithCompletionHandler(&block);
        match rx.recv_timeout(Duration::from_secs(3)) {
            Ok(s) => Permission {
                status: match s {
                    UNAuthorizationStatus::Authorized | UNAuthorizationStatus::Ephemeral => "authorized",
                    UNAuthorizationStatus::Denied => "denied",
                    UNAuthorizationStatus::Provisional => "provisional",
                    _ => "not_determined",
                }
                .into(),
                reason: None,
            },
            Err(_) => Permission { status: "unavailable".into(), reason: Some("macOS didn't answer.".into()) },
        }
    }

    /// Asks once (the system prompt); afterwards macOS answers from the person's earlier choice.
    pub fn request() -> Permission {
        let c = match center() {
            Ok(c) => c,
            Err(r) => return Permission { status: "unavailable".into(), reason: Some(r) },
        };
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |ok: Bool, e: *mut NSError| {
            let _ = tx.send((ok.as_bool(), err_text(e)));
        });
        c.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &block);
        match rx.recv_timeout(Duration::from_secs(120)) {
            Ok((_, Some(e))) => Permission { status: "unavailable".into(), reason: Some(e) },
            Ok(_) => permission(),
            Err(_) => permission(),
        }
    }

    pub fn post(title: &str, body: &str, sound: bool) -> Result<(), String> {
        let c = center()?;
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        content.setThreadIdentifier(&NSString::from_str("coool.agents"));
        if sound {
            content.setSound(Some(&UNNotificationSound::defaultSound()));
        }
        let id = NSString::from_str(&format!("coool-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
        let req = UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |e: *mut NSError| {
            let _ = tx.send(err_text(e));
        });
        c.addNotificationRequest_withCompletionHandler(&req, Some(&block));
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Some(e)) => Err(e),
            _ => Ok(()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod sys {
    use super::Permission;
    pub fn permission() -> Permission {
        Permission { status: "unavailable".into(), reason: Some("Notifications are macOS only for now.".into()) }
    }
    pub fn request() -> Permission {
        permission()
    }
    pub fn post(_t: &str, _b: &str, _s: bool) -> Result<(), String> {
        Err("Notifications are macOS only for now.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn perm() -> ChatEventKind {
        ChatEventKind::PermissionRequest { request_id: "r".into(), tool: "Bash".into(), summary: "rm -rf build".into(), input: serde_json::Value::Null, remember: vec![] }
    }

    #[test]
    fn which_events_notify() {
        assert_eq!(kind_of(&perm()), Some((Kind::NeedsYou, "Bash: rm -rf build".into())));
        assert_eq!(kind_of(&ChatEventKind::TurnEnd { duration_ms: 75_000, ok: true }), Some((Kind::Finished, "Finished after 1m 15s".into())));
        assert_eq!(kind_of(&ChatEventKind::TurnEnd { duration_ms: 1, ok: false }).map(|k| k.0), Some(Kind::Failed));
        assert_eq!(kind_of(&ChatEventKind::Exited { code: Some(1) }).map(|k| k.0), Some(Kind::Failed));
        assert_eq!(kind_of(&ChatEventKind::Exited { code: Some(0) }), None);
        assert_eq!(kind_of(&ChatEventKind::Exited { code: None }), None);
        assert_eq!(kind_of(&ChatEventKind::State { state: ChatState::Working }), None);
    }

    #[test]
    fn settings_and_focus() {
        let p = Prefs::default();
        assert!(should(Kind::NeedsYou, &p, false));
        assert!(!should(Kind::NeedsYou, &p, true), "focused: quiet by default");
        assert!(!should(Kind::Finished, &p, false), "finished is off by default");
        let all = Prefs { finished: true, only_unfocused: false, ..p.clone() };
        assert!(should(Kind::Finished, &all, true));
        let none = Prefs { needs_you: false, failed: false, ..p };
        assert!(!should(Kind::NeedsYou, &none, false));
        assert!(!should(Kind::Failed, &none, false));
    }

    #[test]
    fn a_stop_the_person_asked_for_is_not_a_failure() {
        let n = Notifier::new(Prefs::default());
        n.set_focused(false);
        let fail = ChatEventKind::TurnEnd { duration_ms: 1, ok: false };
        assert_eq!(n.decide(1, "atlas", &fail).map(|d| d.1), Some("atlas failed".into()));
        n.user_stopped(1);
        assert_eq!(n.decide(1, "atlas", &fail), None);
        assert!(n.decide(2, "notes", &fail).is_some(), "other chats still notify");
        assert_eq!(n.decide(1, "atlas", &perm()).map(|d| d.2), Some("Bash: rm -rf build".into()));
    }

    #[test]
    fn old_settings_files_get_the_defaults() {
        let p: Prefs = serde_json::from_str("{}").unwrap();
        assert_eq!(p, Prefs::default());
    }
}
