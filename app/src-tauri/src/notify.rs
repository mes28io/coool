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
//!
//! A click on a notification opens where it points (APP_SPEC "Notifications"): every notification carries a
//! [`Target`] in its `userInfo` (what it is, the chat id, the session key, the request id, the posting process), and
//! coool's `UNUserNotificationCenter` delegate turns a click into a [`Route`], keeps it until the page takes it
//! ([`take`], the `notify_take` command) and pings the page (`notify-open`), bringing the window forward (unhidden,
//! unminimised, focused: macOS switches to its Space). The page decides where (lib/notifyRoute.ts). The delegate is
//! set before the app finishes launching, so a click that launches coool is kept until the page asks for it. The
//! delegate also lets banners show while coool is the active app (otherwise macOS keeps them silent then; the settings
//! decide whether one goes out at all).

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
        Notifier { prefs: Mutex::new(prefs), focused: std::sync::atomic::AtomicBool::new(false), stopped: Mutex::default() }
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

    /// Posts what [`Self::decide`] allows, on a background thread. `session`: the chat's session key
    /// (`claude:<id>`) once the app knows it.
    pub fn on_event(&self, id: usize, title: &str, session: Option<&str>, ev: &ChatEventKind) {
        if let Some((kind, t, b)) = self.decide(id, title, ev) {
            let sound = self.prefs.lock().unwrap().sound;
            let target = Target::of(kind, id, session, ev);
            std::thread::spawn(move || {
                if let Err(e) = post(&t, &b, sound, &target) {
                    log(&format!("post failed: {e}"));
                }
            });
        }
    }
}

/// What a notification points at, kept in its `userInfo` (JSON under [`INFO_KEY`]) for a click.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    /// "needs" | "finished" | "failed" | "test"
    pub kind: String,
    /// coool's chat id: meaningful only to the process that posted it (`pid`).
    pub chat: Option<usize>,
    /// The session key (`claude:<session id>`): still names the session after coool restarted.
    pub session: Option<String>,
    /// The permission request or question it was about.
    pub request: Option<String>,
    pub pid: u32,
}

pub const INFO_KEY: &str = "coool";

impl Target {
    pub fn of(kind: Kind, chat: usize, session: Option<&str>, ev: &ChatEventKind) -> Self {
        let request = match ev {
            ChatEventKind::PermissionRequest { request_id, .. } | ChatEventKind::Question { request_id, .. } => Some(request_id.clone()),
            _ => None,
        };
        let kind = match kind {
            Kind::NeedsYou => "needs",
            Kind::Finished => "finished",
            Kind::Failed => "failed",
        };
        Target { kind: kind.into(), chat: Some(chat), session: session.map(str::to_string), request, pid: std::process::id() }
    }

    /// The Settings "Send a test" notification: a click only brings coool forward.
    pub fn test() -> Self {
        Target { kind: "test".into(), chat: None, session: None, request: None, pid: std::process::id() }
    }
}

/// Where a click asks the page to go (lib/notifyRoute.ts decides what is still there).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Route {
    /// The [`Target`] kind, or "app" for a notification without one (bring coool forward only).
    pub kind: String,
    /// Only when posted by this run of coool (chat ids start over at each launch).
    pub chat: Option<usize>,
    pub session: Option<String>,
    pub request: Option<String>,
    /// The notification action: "default" (a click on it), "dismiss", or an action id.
    pub action: String,
}

/// The route for a click on a notification whose `userInfo` JSON is `info`, in the process `pid`.
pub fn route_of(info: Option<&str>, action: &str, pid: u32) -> Route {
    match info.and_then(|i| serde_json::from_str::<Target>(i).ok()) {
        Some(t) => Route { kind: t.kind, chat: t.chat.filter(|_| t.pid == pid), session: t.session, request: t.request, action: action.into() },
        None => Route { kind: "app".into(), chat: None, session: None, request: None, action: action.into() },
    }
}

/// A click waiting for the page (set before the page or even the app is ready), the app once it is, and the log.
static PENDING: Mutex<Option<Route>> = Mutex::new(None);
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
/// A self-test window that must not take focus: a click routes but doesn't bring the window forward.
static QUIET: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The delegate's log (what it was asked and did), kept for the self-test and printed to stderr.
pub fn log(line: &str) {
    eprintln!("coool notify: {line}");
    let mut l = LOG.lock().unwrap();
    if l.len() >= 200 {
        l.remove(0);
    }
    l.push(line.to_string());
}

pub fn log_lines() -> Vec<String> {
    LOG.lock().unwrap().clone()
}

/// A notification was clicked (the delegate, or a self-test standing in for it).
pub fn clicked(info: Option<&str>, action: &str) {
    let r = route_of(info, action, std::process::id());
    log(&format!("click {} action={} chat={:?} session={:?} request={:?}", r.kind, r.action, r.chat, r.session, r.request));
    // Dismissing it from Notification Center (reported only for a category that asks) goes nowhere.
    if r.action == "dismiss" {
        return;
    }
    *PENDING.lock().unwrap() = Some(r);
    if let Some(app) = APP.get() {
        bring_forward(app);
        use tauri::Emitter;
        let _ = app.emit("notify-open", ());
    }
}

/// The app is up (`setup`): clicks from now on reach it; one that launched coool brings the window forward.
pub fn attach(app: &tauri::AppHandle, quiet: bool) {
    QUIET.store(quiet, std::sync::atomic::Ordering::Relaxed);
    let _ = APP.set(app.clone());
    if PENDING.lock().unwrap().is_some() {
        log("a click launched coool: kept for the page");
        bring_forward(app);
    }
}

/// The click waiting for the page, once.
pub fn take() -> Option<Route> {
    PENDING.lock().unwrap().take()
}

/// Shows the main window wherever it is: hidden (⌘H), minimised, behind other windows, on another Space.
fn bring_forward(app: &tauri::AppHandle) {
    use tauri::Manager;
    if QUIET.load(std::sync::atomic::Ordering::Relaxed) {
        log("forward: skipped (a self-test window that never takes focus)");
        return;
    }
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        let _ = app2.show();
        if let Some(w) = app2.get_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        log("forward: shown");
    });
}


/// Where the system's notification permission stands for coool.
#[derive(Clone, Debug, Serialize)]
pub struct Permission {
    /// "authorized" | "denied" | "not_determined" | "provisional" | "unavailable"
    pub status: String,
    /// Why when unavailable or the request failed.
    pub reason: Option<String>,
}

pub use sys::{Delivered, delivered, install_delegate, permission, post, remove_all, request, simulate_click};

#[cfg(target_os = "macos")]
mod sys {
    use super::{INFO_KEY, Permission, Target, clicked, log};
    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{AnyThread, define_class, msg_send};
    use objc2_foundation::{NSArray, NSBundle, NSDictionary, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse, UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
    };
    use serde::Serialize;
    use std::ptr::NonNull;
    use std::sync::mpsc;
    use std::time::Duration;

    /// `UNUserNotificationCenter` throws without a bundle identifier (a bare binary): check first.
    fn center() -> Result<Retained<UNUserNotificationCenter>, String> {
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

    /// The [`Target`] JSON a notification carries, if any.
    fn info_of(n: &UNNotification) -> Option<String> {
        let info = n.request().content().userInfo();
        let key = NSString::from_str(INFO_KEY);
        let v = info.objectForKey(key.as_ref())?;
        v.downcast_ref::<NSString>().map(|s| s.to_string())
    }

    define_class!(
        /// coool's `UNUserNotificationCenterDelegate`: banners while coool is in front, and clicks.
        #[unsafe(super(NSObject))]
        #[name = "CooolNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(&self, _c: &UNUserNotificationCenter, n: &UNNotification, done: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
                // The settings already decided it goes out (including "only when coool isn't in front"): show it.
                let mut o = UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List;
                if n.request().content().sound().is_some() {
                    o |= UNNotificationPresentationOptions::Sound;
                }
                log(&format!("present in front: {}", n.request().identifier()));
                done.call((o,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(&self, _c: &UNUserNotificationCenter, r: &UNNotificationResponse, done: &DynBlock<dyn Fn()>) {
                let n = r.notification();
                let action = r.actionIdentifier().to_string();
                let action = match action.as_str() {
                    "com.apple.UNNotificationDefaultActionIdentifier" => "default".to_string(),
                    "com.apple.UNNotificationDismissActionIdentifier" => "dismiss".to_string(),
                    _ => action,
                };
                log(&format!("response to {}", n.request().identifier()));
                clicked(info_of(&n).as_deref(), &action);
                done.call(());
            }
        }
    );

    impl Delegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            unsafe { msg_send![super(this), init] }
        }
    }

    /// Sets coool's delegate (before the app finishes launching, so a click that launched it still arrives). A build
    /// without a bundle has no notification center: nothing to do.
    pub fn install_delegate() {
        let Ok(c) = center() else { return };
        let d = Delegate::new();
        c.setDelegate(Some(ProtocolObject::from_ref(&*d)));
        // The center holds its delegate weakly: this one lives as long as the app.
        std::mem::forget(d);
        log("delegate set");
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

    /// Asks once (the system prompt); afterwards macOS answers from the person's earlier choice. Waits for the answer
    /// up to 2 minutes; after that it reports where things stand (the page reads it again when the window regains focus).
    pub fn request() -> Permission {
        let c = match center() {
            Ok(c) => c,
            Err(r) => return Permission { status: "unavailable".into(), reason: Some(r) },
        };
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |ok: Bool, e: *mut NSError| {
            let _ = tx.send((ok.as_bool(), err_text(e)));
        });
        log("asking for permission");
        c.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &block);
        let r = rx.recv_timeout(Duration::from_secs(120));
        log(&format!("permission answer: {r:?}"));
        match r {
            Ok((_, Some(e))) => Permission { status: "unavailable".into(), reason: Some(e) },
            _ => permission(),
        }
    }

    pub fn post(title: &str, body: &str, sound: bool, target: &Target) -> Result<(), String> {
        let c = center()?;
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        content.setThreadIdentifier(&NSString::from_str("coool.agents"));
        if sound {
            content.setSound(Some(&UNNotificationSound::defaultSound()));
        }
        let json = serde_json::to_string(target).map_err(|e| e.to_string())?;
        let info = NSDictionary::<NSString, NSString>::from_slices(&[&*NSString::from_str(INFO_KEY)], &[&*NSString::from_str(&json)]);
        // SAFETY: a dictionary of strings is a property list; `cast_unchecked` only forgets the key and value types.
        unsafe { content.setUserInfo(&Retained::cast_unchecked::<NSDictionary>(info)) };
        let id = format!("coool-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        let req = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&id), &content, None);
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |e: *mut NSError| {
            let _ = tx.send(err_text(e));
        });
        c.addNotificationRequest_withCompletionHandler(&req, Some(&block));
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Some(e)) => Err(e),
            _ => {
                log(&format!("posted {id} {json}"));
                Ok(())
            }
        }
    }

    /// One notification in Notification Center (self-test evidence of delivery).
    #[derive(Serialize)]
    pub struct Delivered {
        pub id: String,
        pub title: String,
        pub info: Option<String>,
    }

    fn delivered_raw(c: &UNUserNotificationCenter) -> Result<Vec<Retained<UNNotification>>, String> {
        let (tx, rx) = mpsc::channel::<Vec<usize>>();
        let block = RcBlock::new(move |a: NonNull<NSArray<UNNotification>>| {
            // SAFETY: a valid array for the handler's duration; each element is retained before it is sent on.
            let a = unsafe { a.as_ref() };
            let v = a.iter().map(|n| Retained::into_raw(n) as usize).collect();
            let _ = tx.send(v);
        });
        c.getDeliveredNotificationsWithCompletionHandler(&block);
        let v = rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "macOS didn't answer".to_string())?;
        // SAFETY: each pointer was retained above and is taken back exactly once.
        Ok(v.into_iter().filter_map(|p| unsafe { Retained::from_raw(p as *mut UNNotification) }).collect())
    }

    /// coool's notifications still in Notification Center.
    pub fn delivered() -> Result<Vec<Delivered>, String> {
        let c = center()?;
        Ok(delivered_raw(&c)?.iter().map(|n| Delivered { id: n.request().identifier().to_string(), title: n.request().content().title().to_string(), info: info_of(n) }).collect())
    }

    /// Removes all of this app's delivered and pending notifications (self-test cleanup).
    pub fn remove_all() -> Result<(), String> {
        let c = center()?;
        c.removeAllDeliveredNotifications();
        c.removeAllPendingNotificationRequests();
        Ok(())
    }

    /// A click on the delivered notification `id`, sent to the center's delegate the way macOS sends a real one: the
    /// delegate method itself, with a response built from that notification. Self-test only. Without a bundle (dev
    /// builds) or a delivered notification, `info` goes straight to the click handler.
    pub fn simulate_click(id: Option<&str>, info: Option<&str>) -> Result<String, String> {
        if let (Some(id), Ok(c)) = (id, center()) {
            let n = delivered_raw(&c)?.into_iter().find(|n| n.request().identifier().to_string() == id).ok_or("not delivered")?;
            let cls = AnyClass::get(c"UNNotificationResponse").ok_or("no UNNotificationResponse")?;
            let sel = objc2::sel!(responseWithNotification:actionIdentifier:);
            if !cls.responds_to(sel) {
                clicked(info_of(&n).as_deref(), "default");
                return Ok("handler (this macOS can't build a response)".into());
            }
            let action = NSString::from_str("com.apple.UNNotificationDefaultActionIdentifier");
            let resp: Option<Retained<AnyObject>> = unsafe { msg_send![cls, responseWithNotification: &*n, actionIdentifier: &*action] };
            let resp = resp.ok_or("no response")?;
            let d = c.delegate().ok_or("no delegate")?;
            let done = RcBlock::new(|| log("click handled (completion called)"));
            let _: () = unsafe { msg_send![&*d, userNotificationCenter: &*c, didReceiveNotificationResponse: &*resp, withCompletionHandler: &*done] };
            return Ok("delegate".into());
        }
        clicked(info, "default");
        Ok("handler".into())
    }
}

#[cfg(not(target_os = "macos"))]
mod sys {
    use super::{Permission, Target, clicked};
    #[derive(serde::Serialize)]
    pub struct Delivered {
        pub id: String,
        pub title: String,
        pub info: Option<String>,
    }
    pub fn install_delegate() {}
    pub fn permission() -> Permission {
        Permission { status: "unavailable".into(), reason: Some("Notifications are macOS only for now.".into()) }
    }
    pub fn request() -> Permission {
        permission()
    }
    pub fn post(_t: &str, _b: &str, _s: bool, _target: &Target) -> Result<(), String> {
        Err("Notifications are macOS only for now.".into())
    }
    pub fn delivered() -> Result<Vec<Delivered>, String> {
        Ok(Vec::new())
    }
    pub fn remove_all() -> Result<(), String> {
        Ok(())
    }
    pub fn simulate_click(_id: Option<&str>, info: Option<&str>) -> Result<String, String> {
        clicked(info, "default");
        Ok("handler".into())
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

    #[test]
    fn a_notification_carries_where_it_points() {
        let t = Target::of(Kind::NeedsYou, 3, Some("claude:abc"), &perm());
        assert_eq!((t.kind.as_str(), t.chat, t.session.as_deref(), t.request.as_deref()), ("needs", Some(3), Some("claude:abc"), Some("r")));
        let done = Target::of(Kind::Finished, 3, None, &ChatEventKind::TurnEnd { duration_ms: 1, ok: true });
        assert_eq!((done.kind.as_str(), done.request), ("finished", None));
    }

    #[test]
    fn a_click_routes_to_its_target() {
        let me = std::process::id();
        let json = serde_json::to_string(&Target::of(Kind::NeedsYou, 3, Some("claude:abc"), &perm())).unwrap();
        let r = route_of(Some(&json), "default", me);
        assert_eq!(r, Route { kind: "needs".into(), chat: Some(3), session: Some("claude:abc".into()), request: Some("r".into()), action: "default".into() });
        // Posted by an earlier run of coool (the click launched this one): its chat id means nothing here.
        let old = route_of(Some(&json), "default", me.wrapping_add(1));
        assert_eq!((old.chat, old.session.as_deref()), (None, Some("claude:abc")));
        // No target (another build's notification, garbage): just bring coool forward.
        assert_eq!(route_of(None, "default", me).kind, "app");
        assert_eq!(route_of(Some("{not json"), "default", me).kind, "app");
        assert_eq!(route_of(Some(&serde_json::to_string(&Target::test()).unwrap()), "default", me).kind, "test");
    }

    #[test]
    fn a_click_waits_for_the_page_and_is_taken_once() {
        // No app attached (as before `setup`, a click that launched coool): kept.
        let json = serde_json::to_string(&Target::of(Kind::Finished, 9, Some("codex:x"), &ChatEventKind::TurnEnd { duration_ms: 1, ok: true })).unwrap();
        clicked(Some(&json), "default");
        let r = take().expect("kept for the page");
        assert_eq!((r.kind.as_str(), r.chat), ("finished", Some(9)));
        assert!(take().is_none(), "taken once");
        clicked(Some(&json), "dismiss");
        assert!(take().is_none(), "a dismissal goes nowhere");
    }
}
