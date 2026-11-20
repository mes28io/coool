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
    /// "Different sound per kind" (off by default: the system's notification sound, as before).
    #[serde(default)]
    pub custom_sounds: bool,
    /// The sound for each kind when `custom_sounds` is on: "none", "coool:<name>" (see [`COOOL_SOUNDS`]) or
    /// "system:<name>" (an alert sound in /System/Library/Sounds).
    #[serde(default = "sound_needs")]
    pub sound_needs: String,
    #[serde(default = "sound_finished")]
    pub sound_finished: String,
    #[serde(default = "sound_failed")]
    pub sound_failed: String,
}

fn yes() -> bool {
    true
}
fn sound_needs() -> String {
    "coool:rise".into()
}
fn sound_finished() -> String {
    "coool:tap".into()
}
fn sound_failed() -> String {
    "coool:knock".into()
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { needs_you: true, finished: false, failed: true, sound: true, only_unfocused: true, custom_sounds: false, sound_needs: sound_needs(), sound_finished: sound_finished(), sound_failed: sound_failed() }
    }
}

/// coool's own sounds (app/scripts/sounds/make-sounds.py, shipped as `coool-<name>.wav` in the app's Resources).
pub const COOOL_SOUNDS: [&str; 7] = ["rise", "tap", "glass", "knock", "marimba", "chirp", "ticks"];

/// What a notification sounds like.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Sound {
    Off,
    /// The system's notification sound (the setting's "different sounds" switch is off).
    Default,
    Coool(&'static str),
    System(String),
}

/// A sound id from the settings; anything unknown is the system default.
pub fn parse_sound(id: &str) -> Sound {
    if id == "none" {
        return Sound::Off;
    }
    if let Some(n) = id.strip_prefix("coool:") {
        return COOOL_SOUNDS.iter().find(|s| **s == n).map(|s| Sound::Coool(s)).unwrap_or(Sound::Default);
    }
    if let Some(n) = id.strip_prefix("system:")
        && !n.is_empty()
        && n.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_')
    {
        return Sound::System(n.to_string());
    }
    Sound::Default
}

/// The sound a notification of `kind` gets with these settings.
pub fn sound_for(kind: Kind, p: &Prefs) -> Sound {
    if !p.sound {
        return Sound::Off;
    }
    if !p.custom_sounds {
        return Sound::Default;
    }
    parse_sound(match kind {
        Kind::NeedsYou => &p.sound_needs,
        Kind::Finished => &p.sound_finished,
        Kind::Failed => &p.sound_failed,
    })
}

/// Sounds closer together than this are one: several agents finishing at once make one sound.
pub const BURST: Duration = Duration::from_millis(1500);

/// The burst limit: at most one sound per [`BURST`].
#[derive(Default)]
pub struct Burst(Mutex<Option<Instant>>);

impl Burst {
    pub fn allow(&self, now: Instant) -> bool {
        let mut last = self.0.lock().unwrap();
        if last.is_some_and(|t| now.saturating_duration_since(t) < BURST) {
            return false;
        }
        *last = Some(now);
        true
    }
}

/// Which notification an event is, with a one-line detail ("Bash: rm -rf build"), or None.
pub fn kind_of(ev: &ChatEventKind) -> Option<(Kind, String)> {
    match ev {
        ChatEventKind::PermissionRequest { tool, summary, .. } => {
            // The chat's summary already leads with the tool ("Bash · npm test", `tool_summary`): said once.
            let s = summary.strip_prefix(&format!("{tool} · ")).unwrap_or(summary).trim();
            Some((Kind::NeedsYou, if s.is_empty() || s == tool { format!("Wants to use {tool}") } else { format!("{tool}: {s}") }))
        }
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

/// A permission request or question: (request id, its needs-you words as [`kind_of`] has them).
pub fn ask_of(ev: &ChatEventKind) -> Option<(String, String)> {
    let id = match ev {
        ChatEventKind::PermissionRequest { request_id, .. } | ChatEventKind::Question { request_id, .. } => request_id.clone(),
        _ => return None,
    };
    kind_of(ev).map(|(_, d)| (id, d))
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
    burst: Burst,
    /// A self-test run makes no sound (unless `COOOL_SELFTEST_SOUNDS=1`): plays are logged instead.
    muted: std::sync::atomic::AtomicBool,
}

impl Notifier {
    pub fn new(prefs: Prefs) -> Self {
        Notifier { prefs: Mutex::new(prefs), ..Default::default() }
    }

    pub fn set_muted(&self, m: bool) {
        self.muted.store(m, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn muted(&self) -> bool {
        self.muted.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// The sound for a cue of `kind` now: none when its sound is off, during a muted self-test, or within a burst.
    fn sound_now(&self, kind: Kind) -> Sound {
        let s = sound_for(kind, &self.prefs.lock().unwrap());
        if s == Sound::Off {
            return s;
        }
        if !self.burst.allow(Instant::now()) {
            log(&format!("sound {s:?}: skipped (burst)"));
            return Sound::Off;
        }
        if self.muted() {
            log(&format!("sound {s:?}: muted (self-test)"));
            return Sound::Off;
        }
        s
    }

    /// While coool is in front and "only when coool isn't in front" keeps the banner back: the kind whose sound
    /// plays in the app instead (only with the per-kind sounds on, so the switch decides as it does for banners).
    fn in_front_cue(&self, id: usize, ev: &ChatEventKind) -> Option<Kind> {
        let (kind, _) = kind_of(ev)?;
        if kind == Kind::Failed && self.stopped.lock().unwrap().get(&id).is_some_and(|t| t.elapsed() < STOP_GRACE) {
            return None;
        }
        let p = self.prefs.lock().unwrap();
        let focused = self.focused.load(std::sync::atomic::Ordering::Relaxed);
        (should(kind, &p, false) && p.only_unfocused && focused && p.custom_sounds).then_some(kind)
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
            let sound = self.sound_now(kind);
            let target = Target::of(kind, id, session, ev);
            std::thread::spawn(move || {
                if let Err(e) = post(&t, &b, &sound, &target) {
                    log(&format!("post failed: {e}"));
                }
            });
        } else if let Some(kind) = self.in_front_cue(id, ev) {
            // No banner while the person looks at coool: the same sound, in the app.
            let s = self.sound_now(kind);
            if s != Sound::Off && s != Sound::Default {
                log(&format!("play in front {s:?}"));
                play(&s);
            }
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

    /// A lid stop's notice: one that names a waiting chat opens it on the Needs you page; any other only brings coool
    /// forward.
    pub fn of_lid_stop(s: &crate::lid::Stop) -> Self {
        if s.code == crate::lid::Code::Waiting && (s.session.is_some() || s.chat.is_some()) {
            return Target { kind: "needs".into(), chat: s.chat, session: s.session.clone(), request: s.request.clone(), pid: std::process::id() };
        }
        Self::test()
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


/// A permission request is waiting for the person (its completion handler hasn't run yet).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
static ASKING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The status to show. While macOS's prompt is up (an alert at the top right, then in Notification Center until the
/// person picks), macOS already reports the app as denied (seen on macOS 27): that is "asking", not a refusal.
pub fn shown_status(system: &'static str, asking: bool) -> &'static str {
    if asking && (system == "denied" || system == "not_determined") { "asking" } else { system }
}

/// Where the system's notification permission stands for coool.
#[derive(Clone, Debug, Serialize)]
pub struct Permission {
    /// "authorized" | "denied" | "not_determined" | "provisional" | "asking" (macOS shows its prompt) | "unavailable"
    pub status: String,
    /// Why when unavailable or the request failed.
    pub reason: Option<String>,
}

pub use sys::{Delivered, bundled, delivered, install_delegate, permission, play, post, remove_all, request, simulate_click, system_sounds};

#[cfg(target_os = "macos")]
mod sys {
    use super::{INFO_KEY, Permission, Sound, Target, clicked, log};
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
                status: super::shown_status(
                    match s {
                        UNAuthorizationStatus::Authorized | UNAuthorizationStatus::Ephemeral => "authorized",
                        UNAuthorizationStatus::Denied => "denied",
                        UNAuthorizationStatus::Provisional => "provisional",
                        _ => "not_determined",
                    },
                    super::ASKING.load(std::sync::atomic::Ordering::Relaxed),
                )
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
            super::ASKING.store(false, std::sync::atomic::Ordering::Relaxed);
            let _ = tx.send((ok.as_bool(), err_text(e)));
        });
        super::ASKING.store(true, std::sync::atomic::Ordering::Relaxed);
        log("asking for permission");
        c.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &block);
        let r = rx.recv_timeout(Duration::from_secs(120));
        log(&format!("permission answer: {r:?}"));
        match r {
            // macOS refused to ask (e.g. "Notifications are not allowed for this application" for an app it can't
            // validate, like one run from a temporary folder): the status is still the real one, with the reason.
            Ok((_, Some(e))) => Permission { reason: Some(e), ..permission() },
            _ => permission(),
        }
    }

    /// Running from an app bundle (only then does macOS deliver its notifications).
    pub fn bundled() -> bool {
        NSBundle::mainBundle().bundleIdentifier().is_some()
    }

    /// Where coool's own sound `name` is: the app's Resources, or (a build without a bundle) the source tree.
    pub fn sound_file(name: &str) -> Option<std::path::PathBuf> {
        let file = format!("coool-{name}.wav");
        let in_bundle = NSBundle::mainBundle().resourcePath().map(|r| std::path::PathBuf::from(r.to_string()).join(&file));
        let in_tree = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("sounds").join(&file);
        in_bundle.filter(|p| p.is_file()).or_else(|| in_tree.is_file().then_some(in_tree))
    }

    thread_local! {
        /// The last few sounds playing (an NSSound stops when released).
        static PLAYING: std::cell::RefCell<Vec<Retained<AnyObject>>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    fn play_now(s: &Sound) {
        let Some(cls) = AnyClass::get(c"NSSound") else { return };
        let snd: Option<Retained<AnyObject>> = match s {
            Sound::Coool(n) => sound_file(n).and_then(|p| {
                let path = NSString::from_str(&p.to_string_lossy());
                let a: objc2::rc::Allocated<AnyObject> = unsafe { msg_send![cls, alloc] };
                let r: Option<Retained<AnyObject>> = unsafe { msg_send![a, initWithContentsOfFile: &*path, byReference: Bool::YES] };
                r
            }),
            Sound::System(n) => unsafe { msg_send![cls, soundNamed: &*NSString::from_str(n)] },
            _ => None,
        };
        let Some(snd) = snd else {
            log(&format!("play {s:?}: no such sound"));
            return;
        };
        let ok: Bool = unsafe { msg_send![&*snd, play] };
        log(&format!("played {s:?}: {}", ok.as_bool()));
        PLAYING.with(|p| {
            let mut p = p.borrow_mut();
            p.push(snd);
            if p.len() > 4 {
                p.remove(0);
            }
        });
    }

    /// Plays a sound in the app (AppKit's NSSound, on the main thread).
    pub fn play(s: &Sound) {
        let s = s.clone();
        match super::APP.get() {
            Some(app) => {
                let _ = app.run_on_main_thread(move || play_now(&s));
            }
            None => play_now(&s),
        }
    }

    /// The alert sounds macOS ships (/System/Library/Sounds), by name.
    pub fn system_sounds() -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir("/System/Library/Sounds")
            .map(|d| d.filter_map(|e| e.ok()).filter_map(|e| e.path().file_stem().map(|s| s.to_string_lossy().into_owned())).collect())
            .unwrap_or_default();
        v.sort();
        v.dedup();
        v
    }

    pub fn post(title: &str, body: &str, sound: &Sound, target: &Target) -> Result<(), String> {
        let c = center()?;
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        content.setThreadIdentifier(&NSString::from_str("coool.agents"));
        match sound {
            Sound::Off => {}
            Sound::Default => content.setSound(Some(&UNNotificationSound::defaultSound())),
            // A named sound: a file in the app's Resources (coool's own), or the system's alert sound by name.
            Sound::Coool(n) => content.setSound(Some(&UNNotificationSound::soundNamed(&NSString::from_str(&format!("coool-{n}.wav"))))),
            Sound::System(n) => content.setSound(Some(&UNNotificationSound::soundNamed(&NSString::from_str(&format!("{n}.aiff"))))),
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
    use super::{Permission, Sound, Target, clicked};
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
    pub fn bundled() -> bool {
        false
    }
    pub fn sound_file(_name: &str) -> Option<std::path::PathBuf> {
        None
    }
    pub fn play(_s: &Sound) {}
    pub fn system_sounds() -> Vec<String> {
        Vec::new()
    }
    pub fn post(_t: &str, _b: &str, _s: &Sound, _target: &Target) -> Result<(), String> {
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
        // As the chats send it (`tool_summary`: the tool first): the tool named once.
        let real = ChatEventKind::PermissionRequest { request_id: "r".into(), tool: "Bash".into(), summary: "Bash · touch a.txt".into(), input: serde_json::Value::Null, remember: vec![] };
        assert_eq!(kind_of(&real), Some((Kind::NeedsYou, "Bash: touch a.txt".into())));
        let bare = ChatEventKind::PermissionRequest { request_id: "r".into(), tool: "WebSearch".into(), summary: "WebSearch".into(), input: serde_json::Value::Null, remember: vec![] };
        assert_eq!(kind_of(&bare), Some((Kind::NeedsYou, "Wants to use WebSearch".into())));
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
    fn sounds_per_kind() {
        // Settings files from before: the system sound, as before (the per-kind switch is off).
        let old: Prefs = serde_json::from_str(r#"{"needs_you":true,"finished":false,"failed":true,"sound":true,"only_unfocused":true}"#).unwrap();
        assert!(!old.custom_sounds);
        assert_eq!(sound_for(Kind::NeedsYou, &old), Sound::Default);
        assert_eq!(sound_for(Kind::NeedsYou, &Prefs { sound: false, ..old.clone() }), Sound::Off);
        let on = Prefs { custom_sounds: true, ..old.clone() };
        assert_eq!(sound_for(Kind::NeedsYou, &on), Sound::Coool("rise"));
        assert_eq!(sound_for(Kind::Finished, &on), Sound::Coool("tap"));
        assert_eq!(sound_for(Kind::Failed, &on), Sound::Coool("knock"));
        assert_eq!(sound_for(Kind::Finished, &Prefs { sound_finished: "system:Glass".into(), ..on.clone() }), Sound::System("Glass".into()));
        assert_eq!(sound_for(Kind::Finished, &Prefs { sound_finished: "none".into(), ..on.clone() }), Sound::Off);
        // The master switch still wins.
        assert_eq!(sound_for(Kind::NeedsYou, &Prefs { sound: false, ..on }), Sound::Off);
        // Unknown or unsafe ids: the system default.
        assert_eq!(parse_sound("coool:nope"), Sound::Default);
        assert_eq!(parse_sound("system:../../etc/x"), Sound::Default);
        assert_eq!(parse_sound("garbage"), Sound::Default);
    }

    #[test]
    fn a_burst_makes_one_sound() {
        let b = Burst::default();
        let t = Instant::now();
        assert!(b.allow(t));
        assert!(!b.allow(t + Duration::from_millis(200)), "a second agent finishing together");
        assert!(!b.allow(t + Duration::from_millis(1400)));
        assert!(b.allow(t + Duration::from_millis(1600)), "a later one sounds again");
    }

    #[test]
    fn in_front_the_sound_plays_in_the_app_only_with_per_kind_sounds() {
        let ev = ChatEventKind::TurnEnd { duration_ms: 1, ok: true };
        let n = Notifier::new(Prefs { finished: true, ..Prefs::default() });
        n.set_focused(true);
        assert_eq!(n.decide(1, "a", &ev), None, "no banner while in front");
        assert_eq!(n.in_front_cue(1, &ev), None, "the system sound is the switch's off state: nothing in the app");
        *n.prefs.lock().unwrap() = Prefs { finished: true, custom_sounds: true, ..Prefs::default() };
        assert_eq!(n.in_front_cue(1, &ev), Some(Kind::Finished));
        *n.prefs.lock().unwrap() = Prefs { finished: false, custom_sounds: true, ..Prefs::default() };
        assert_eq!(n.in_front_cue(1, &ev), None, "never for a kind that is off");
        n.set_focused(false);
        *n.prefs.lock().unwrap() = Prefs { finished: true, custom_sounds: true, ..Prefs::default() };
        assert_eq!(n.in_front_cue(1, &ev), None, "not in front: the notification carries it");
        assert!(n.decide(1, "a", &ev).is_some());
        // A muted self-test: no sound at all.
        n.set_muted(true);
        assert_eq!(n.sound_now(Kind::Finished), Sound::Off);
    }

    #[test]
    fn a_prompt_on_screen_is_asking_not_denied() {
        assert_eq!(shown_status("denied", true), "asking");
        assert_eq!(shown_status("not_determined", true), "asking");
        assert_eq!(shown_status("authorized", true), "authorized");
        assert_eq!(shown_status("denied", false), "denied");
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

    #[test]
    fn a_lid_stop_for_a_waiting_chat_opens_needs_you_and_others_only_bring_coool_forward() {
        use crate::lid::{Code, Stop};
        let w = Stop { at: 1, code: Code::Waiting, detail: "“A” was waiting for your answer".into(), chat: Some(4), session: Some("claude:s1".into()), request: Some("r9".into()) };
        let t = Target::of_lid_stop(&w);
        assert_eq!((t.kind.as_str(), t.chat, t.session.as_deref(), t.request.as_deref()), ("needs", Some(4), Some("claude:s1"), Some("r9")));
        let r = route_of(Some(&serde_json::to_string(&t).unwrap()), "default", std::process::id());
        assert_eq!((r.kind.as_str(), r.session.as_deref()), ("needs", Some("claude:s1")));
        let b = Stop { at: 1, code: Code::OnBattery, detail: "on battery".into(), chat: None, session: None, request: None };
        assert_eq!(Target::of_lid_stop(&b).kind, "test");
        assert_eq!(Target::of_lid_stop(&Stop { session: None, chat: None, ..w }).kind, "test", "a waiting stop that names no chat");
    }

    #[test]
    fn ask_of_takes_the_request_and_the_needs_you_words() {
        let ev = ChatEventKind::PermissionRequest { request_id: "r1".into(), tool: "Bash".into(), summary: "npm test".into(), input: serde_json::json!({}), remember: vec![] };
        assert_eq!(ask_of(&ev), Some(("r1".into(), "Bash: npm test".into())));
        assert_eq!(ask_of(&ChatEventKind::TurnEnd { duration_ms: 1, ok: true }), None);
    }
}
