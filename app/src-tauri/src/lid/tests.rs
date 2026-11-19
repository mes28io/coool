//! The lid hold's state machine with a fake helper and fake sensors (the real helper's own tests are in
//! helper/tests.rs, against the real binary in its dry-run mode).

use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct FakeState {
    state: Option<HelperState>,
    held: bool,
    refuse: Option<String>,
    beat_fails: bool,
    log: Vec<String>,
}

#[derive(Clone, Default)]
struct FakeHelper(Arc<Mutex<FakeState>>);

impl FakeHelper {
    fn ready() -> Self {
        let f = FakeHelper::default();
        f.0.lock().unwrap().state = Some(HelperState::Ready);
        f
    }
    fn missing() -> Self {
        let f = FakeHelper::default();
        f.0.lock().unwrap().state = Some(HelperState::Missing);
        f
    }
    fn set(&self, s: HelperState) {
        self.0.lock().unwrap().state = Some(s);
    }
    fn log(&self) -> Vec<String> {
        std::mem::take(&mut self.0.lock().unwrap().log)
    }
    fn held(&self) -> bool {
        self.0.lock().unwrap().held
    }
}

impl Helper for FakeHelper {
    fn probe(&mut self) -> HelperState {
        self.0.lock().unwrap().state.clone().unwrap_or(HelperState::Missing)
    }
    fn hold(&mut self, lease: u32) -> Result<(), String> {
        let mut s = self.0.lock().unwrap();
        if let Some(e) = s.refuse.clone() {
            s.log.push(format!("refused {e}"));
            return Err(e);
        }
        s.log.push(format!("hold {lease}"));
        s.held = true;
        Ok(())
    }
    fn beat(&mut self) -> Result<(), String> {
        let mut s = self.0.lock().unwrap();
        if s.beat_fails {
            s.held = false;
            s.log.push("beat failed".into());
            return Err("not-holding".into());
        }
        s.log.push("beat".into());
        Ok(())
    }
    fn release(&mut self) {
        let mut s = self.0.lock().unwrap();
        s.log.push("release".into());
        s.held = false;
    }
    fn uninstall(&mut self) -> Result<(), String> {
        let mut s = self.0.lock().unwrap();
        s.log.push("uninstall".into());
        s.held = false;
        s.state = Some(HelperState::Missing);
        Ok(())
    }
    fn install_job(&self) -> Job {
        let s = self.0.clone();
        Box::new(move || {
            s.lock().unwrap().state = Some(HelperState::Ready);
            Ok(())
        })
    }
    fn remove_job(&self) -> Job {
        Box::new(|| Ok(()))
    }
    fn restore_job(&self) -> Job {
        Box::new(|| Ok(()))
    }
    fn drop_connection(&mut self) {
        // The real helper sees EOF and lets go.
        let mut s = self.0.lock().unwrap();
        s.log.push("connection dropped".into());
        s.held = false;
    }
}

fn plugged() -> Reading {
    Reading { on_battery: Some(false), battery_pct: Some(80), thermal: Some(Thermal::Nominal), lid_closed: Some(false), lid_sleeps: Some(true), sleep_disabled: Some(false) }
}

/// A folder of its own per test for the marker and the stop log.
fn dir() -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let d = std::env::temp_dir().join(format!("coool-lid-sm-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    let _ = std::fs::remove_dir_all(&d);
    d
}

struct T {
    lid: Lid,
    h: FakeHelper,
    s: super::sensors::Fake,
    dir: PathBuf,
}

impl T {
    fn new(h: FakeHelper, prefs: Prefs) -> Self {
        let s = super::sensors::Fake::default();
        *s.0.lock().unwrap() = plugged();
        let dir = dir();
        let lid = Lid::new(Box::new(h.clone()), Box::new(s.clone()), Some(dir.clone()), prefs, 0);
        T { lid, h, s, dir }
    }
    fn on() -> Self {
        T::new(FakeHelper::ready(), Prefs { enabled: true, ..Prefs::default() })
    }
    fn sense(&self, f: impl FnOnce(&mut Reading)) {
        f(&mut self.s.0.lock().unwrap());
    }
    fn marker(&self) -> bool {
        self.dir.join("lid-hold.json").exists()
    }
}

impl Drop for T {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

const S: u64 = 1000;
const MIN: u64 = 60 * S;

#[test]
fn holds_only_while_agents_work_and_lets_go_at_once() {
    let mut t = T::on();
    t.lid.tick(0, 0);
    assert!(t.h.log().is_empty(), "idle: nothing held");
    t.lid.tick(S, 1);
    assert_eq!(t.h.log(), ["hold 60"]);
    assert!(t.h.held() && t.marker());
    assert!(t.lid.covers_idle_sleep() && !t.lid.wants_assertion());
    let st = t.lid.status(S);
    assert_eq!((st.via, st.since, st.blocked), (Some(Via::Helper), Some(S), None));
    // More agents, same hold.
    t.lid.tick(2 * S, 3);
    t.lid.tick(3 * S, 2);
    assert!(t.h.log().is_empty());
    // The last one finished (or is now waiting on the person: the caller doesn't count it).
    t.lid.tick(4 * S, 0);
    assert_eq!(t.h.log(), ["release"]);
    assert!(!t.h.held() && !t.marker());
    assert!(t.lid.status(4 * S).stops.is_empty(), "a normal release isn't an automatic stop");
    assert!(t.lid.take_notices().is_empty());
}

#[test]
fn heartbeat_every_15_s_and_a_helper_that_let_go_is_recorded() {
    let mut t = T::on();
    t.lid.tick(0, 1);
    t.h.log();
    t.lid.tick(10 * S, 1);
    assert!(t.h.log().is_empty());
    t.lid.tick(15 * S, 1);
    assert_eq!(t.h.log(), ["beat"]);
    t.lid.tick(29 * S, 1);
    assert!(t.h.log().is_empty());
    // The helper let go on its own (its battery floor, heat, or it restarted): recorded, retried after RETRY_MS.
    t.h.0.lock().unwrap().beat_fails = true;
    t.lid.tick(30 * S, 1);
    assert_eq!(t.h.log(), ["beat failed"]);
    assert!(!t.marker());
    assert_eq!(t.lid.status(30 * S).stops[0].code, Code::HelperLetGo);
    assert_eq!(t.lid.take_notices().len(), 1);
    t.h.0.lock().unwrap().beat_fails = false;
    t.lid.tick(31 * S, 1);
    assert!(t.h.log().is_empty(), "not again before the retry");
    t.lid.tick(30 * S + RETRY_MS, 1);
    assert_eq!(t.h.log(), ["hold 60"]);
}

#[test]
fn only_on_power_lets_go_on_battery_and_holds_again_on_power() {
    let mut t = T::on();
    t.lid.tick(0, 1);
    t.h.log();
    t.sense(|r| r.on_battery = Some(true));
    t.lid.tick(READ_EVERY_MS, 1);
    assert_eq!(t.h.log(), ["release"]);
    let st = t.lid.status(READ_EVERY_MS);
    assert_eq!((st.via, st.blocked), (None, Some(Code::OnBattery)));
    assert_eq!(st.stops[0].code, Code::OnBattery);
    let n = t.lid.take_notices();
    assert_eq!(n.len(), 1, "the lid is open: notified at once");
    let n: Vec<String> = n.iter().map(notice_text).collect();
    assert!(n[0].starts_with("Stopped holding the Mac awake at ") && n[0].ends_with(": on battery."), "{n:?}");
    t.sense(|r| r.on_battery = Some(false));
    t.lid.tick(2 * READ_EVERY_MS, 1);
    assert_eq!(t.h.log(), ["hold 60"]);
}

#[test]
fn battery_threshold_with_hysteresis_when_battery_is_allowed() {
    let mut t = T::new(FakeHelper::ready(), Prefs { enabled: true, only_on_power: false, min_battery: 20, max_hours: 8, grace_mins: 2 });
    t.sense(|r| {
        r.on_battery = Some(true);
        r.battery_pct = Some(50);
    });
    t.lid.tick(0, 1);
    assert_eq!(t.h.log(), ["hold 60"]);
    t.sense(|r| r.battery_pct = Some(20));
    t.lid.tick(READ_EVERY_MS, 1);
    assert_eq!(t.h.log(), ["release"]);
    assert_eq!(t.lid.status(READ_EVERY_MS).stops[0].detail, "battery 20%");
    t.sense(|r| r.battery_pct = Some(22));
    t.lid.tick(2 * READ_EVERY_MS, 1);
    assert!(t.h.log().is_empty(), "22% is within the hysteresis");
    t.sense(|r| r.battery_pct = Some(23));
    t.lid.tick(3 * READ_EVERY_MS, 1);
    assert_eq!(t.h.log(), ["hold 60"]);
    // Plugged in: the percentage doesn't matter.
    t.sense(|r| {
        r.on_battery = Some(false);
        r.battery_pct = Some(5);
    });
    t.lid.tick(4 * READ_EVERY_MS, 1);
    assert!(t.h.log().is_empty());
}

#[test]
fn heat_lets_go_and_stays_off_until_the_agents_stop() {
    let mut t = T::on();
    t.lid.tick(0, 1);
    t.h.log();
    t.sense(|r| r.thermal = Some(Thermal::Serious));
    t.lid.tick(READ_EVERY_MS, 1);
    assert_eq!(t.h.log(), ["release"]);
    assert_eq!(t.lid.status(READ_EVERY_MS).stops[0].detail, "the Mac is running hot");
    t.sense(|r| r.thermal = Some(Thermal::Nominal));
    t.lid.tick(2 * READ_EVERY_MS, 1);
    t.lid.tick(3 * READ_EVERY_MS + RETRY_MS, 1);
    assert!(t.h.log().is_empty(), "cooler, but still latched for this working stretch");
    assert_eq!(t.lid.status(3 * READ_EVERY_MS).blocked, Some(Code::Hot));
    t.lid.tick(4 * READ_EVERY_MS, 0);
    t.lid.tick(5 * READ_EVERY_MS, 1);
    assert_eq!(t.h.log(), ["hold 60"]);
    // Critical counts too.
    t.sense(|r| r.thermal = Some(Thermal::Critical));
    t.lid.tick(6 * READ_EVERY_MS, 1);
    assert_eq!(t.h.log(), ["release"]);
}

#[test]
fn the_maximum_duration_ends_a_hold_and_zero_means_no_limit() {
    let mut t = T::new(FakeHelper::ready(), Prefs { enabled: true, max_hours: 1, ..Prefs::default() });
    t.lid.tick(0, 1);
    t.h.log();
    t.lid.tick(59 * MIN, 1);
    assert_eq!(t.h.log(), ["beat"]);
    t.lid.tick(60 * MIN, 1);
    assert_eq!(t.h.log(), ["release"]);
    assert_eq!(t.lid.status(60 * MIN).stops[0].detail, "the 1 h limit was reached");
    t.lid.tick(61 * MIN, 1);
    assert!(t.h.log().is_empty());

    let mut t = T::new(FakeHelper::ready(), Prefs { enabled: true, max_hours: 0, ..Prefs::default() });
    t.lid.tick(0, 1);
    t.lid.tick(100 * 60 * MIN, 1);
    assert!(t.h.held(), "no limit");
}

#[test]
fn a_release_with_the_lid_closed_is_notified_when_it_opens() {
    let mut t = T::on();
    t.sense(|r| r.lid_closed = Some(true));
    t.lid.tick(0, 1);
    t.sense(|r| r.on_battery = Some(true));
    t.lid.tick(READ_EVERY_MS, 1);
    assert!(t.lid.take_notices().is_empty(), "nobody is looking: wait");
    // The Mac slept; the person opens the lid. The agent may well have finished meanwhile.
    t.sense(|r| r.lid_closed = Some(false));
    t.lid.tick(2 * READ_EVERY_MS, 0);
    let n = t.lid.take_notices();
    assert_eq!(n.len(), 1);
    assert!(notice_text(&n[0]).contains(": on battery."));
}

#[test]
fn closed_display_mode_needs_no_helper_and_switches_to_it_once_installed() {
    let mut t = T::new(FakeHelper::missing(), Prefs { enabled: true, ..Prefs::default() });
    t.lid.tick(0, 1);
    assert_eq!(t.lid.status(0).blocked, Some(Code::NeedsHelper), "no display, no helper");
    assert!(!t.lid.wants_assertion());
    // An external display on power: the lid doesn't sleep the Mac; the assertion keeps it from idling to sleep.
    t.sense(|r| r.lid_sleeps = Some(false));
    t.lid.tick(READ_EVERY_MS, 1);
    assert!(t.lid.wants_assertion() && !t.lid.covers_idle_sleep());
    assert_eq!(t.lid.status(READ_EVERY_MS).via, Some(Via::Display));
    // The display is unplugged: that way no longer works.
    t.sense(|r| r.lid_sleeps = Some(true));
    t.lid.tick(2 * READ_EVERY_MS, 1);
    assert!(!t.lid.wants_assertion());
    assert_eq!(t.lid.status(2 * READ_EVERY_MS).blocked, Some(Code::NeedsHelper));
    // Installed: the helper holds.
    (t.lid.install_job())().unwrap();
    t.lid.refresh_helper(3 * READ_EVERY_MS);
    assert_eq!(t.h.log(), ["hold 60"]);
    assert_eq!(t.lid.status(3 * READ_EVERY_MS).via, Some(Via::Helper));
}

#[test]
fn display_mode_hands_over_to_the_helper_without_a_gap() {
    let mut t = T::new(FakeHelper::missing(), Prefs { enabled: true, ..Prefs::default() });
    t.sense(|r| r.lid_sleeps = Some(false));
    t.lid.tick(0, 1);
    assert!(t.lid.wants_assertion());
    t.h.set(HelperState::Ready);
    t.lid.tick(PROBE_EVERY_MS, 1);
    assert!(t.lid.covers_idle_sleep() && !t.lid.wants_assertion());
    assert_eq!(t.lid.status(PROBE_EVERY_MS).since, Some(0), "the same working stretch");
}

#[test]
fn refusals_from_the_helper() {
    // Sleep already disabled by someone else: say so, hold nothing, never touch it.
    let mut t = T::on();
    t.h.0.lock().unwrap().refuse = Some("already-disabled".into());
    t.lid.tick(0, 1);
    assert_eq!(t.lid.status(0).blocked, Some(Code::AlreadyDisabled));
    assert!(!t.marker());
    // The helper's own battery floor.
    let mut t = T::on();
    t.h.0.lock().unwrap().refuse = Some("battery".into());
    t.lid.tick(0, 1);
    assert_eq!(t.lid.status(0).blocked, Some(Code::LowBattery));
    // Unreachable helper, display mode: falls back to the display way.
    let mut t = T::on();
    t.h.0.lock().unwrap().refuse = Some("Connection refused".into());
    t.sense(|r| r.lid_sleeps = Some(false));
    t.lid.tick(0, 1);
    let st = t.lid.status(0);
    assert_eq!(st.via, Some(Via::Display));
    assert!(st.error.unwrap().contains("Connection refused"));
}

#[test]
fn no_lid_no_hold() {
    let mut t = T::on();
    t.sense(|r| {
        r.lid_closed = None;
        r.lid_sleeps = None;
    });
    t.lid.tick(0, 1);
    assert_eq!(t.lid.status(0).blocked, Some(Code::NoLid));
    assert!(t.h.log().is_empty());
}

#[test]
fn turning_it_off_lets_go_and_removes_the_helper() {
    let mut t = T::on();
    t.lid.tick(0, 1);
    t.h.log();
    t.lid.set_prefs(Prefs { enabled: false, ..Prefs::default() }, S);
    assert_eq!(t.h.log(), ["release", "uninstall"]);
    assert!(!t.marker());
    assert_eq!(t.lid.status(S).helper, HelperState::Missing);
    t.lid.tick(2 * S, 1);
    assert!(t.h.log().is_empty(), "off: never held");
}

#[test]
fn remove_helper_while_holding() {
    let mut t = T::on();
    t.lid.tick(0, 1);
    t.h.log();
    t.lid.uninstall(S).unwrap();
    assert_eq!(t.h.log(), ["release", "uninstall"]);
    t.lid.tick(2 * S + PROBE_EVERY_MS, 1);
    assert_eq!(t.lid.status(2 * S + PROBE_EVERY_MS).blocked, Some(Code::NeedsHelper));
}

#[test]
fn a_crash_while_holding_is_found_at_the_next_launch() {
    let t = T::on();
    let dir = t.dir.clone();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("lid-hold.json"), r#"{"since":1700000000000,"pid":4242}"#).unwrap();
    // The helper let go when the connection closed: the switch is off. Recorded, marker gone.
    let s = super::sensors::Fake::default();
    *s.0.lock().unwrap() = plugged();
    let mut lid = Lid::new(Box::new(FakeHelper::ready()), Box::new(s.clone()), Some(dir.clone()), Prefs { enabled: true, ..Prefs::default() }, 5 * S);
    assert!(!dir.join("lid-hold.json").exists());
    let st = lid.status(5 * S);
    assert!(!st.stale);
    assert_eq!(st.stops[0].code, Code::Recovered);
    assert!(st.stops[0].detail.starts_with("coool quit while holding the Mac awake (holding since "));
    assert_eq!(lid.take_notices().len(), 1);
    // And it is in the log file for the launch after that.
    drop(lid);
    let lid = Lid::new(Box::new(FakeHelper::ready()), Box::new(s), Some(dir.clone()), Prefs::default(), 6 * S);
    assert_eq!(lid.stops.len(), 1);
}

#[test]
fn a_stale_switch_with_no_helper_is_shown_until_it_is_off() {
    let t = T::on();
    let dir = t.dir.clone();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("lid-hold.json"), r#"{"since":0,"pid":1}"#).unwrap();
    let s = super::sensors::Fake::default();
    *s.0.lock().unwrap() = Reading { sleep_disabled: Some(true), ..plugged() };
    let h = FakeHelper::default();
    h.set(HelperState::Unreachable("Connection refused".into()));
    let mut lid = Lid::new(Box::new(h), Box::new(s.clone()), Some(dir.clone()), Prefs { enabled: true, ..Prefs::default() }, 0);
    assert!(lid.status(0).stale);
    assert!(dir.join("lid-hold.json").exists(), "kept until it's resolved");
    // The person ran the restore (or `pmset -a disablesleep 0`): the switch reads off.
    s.0.lock().unwrap().sleep_disabled = Some(false);
    assert!(!lid.status(S).stale);
    assert!(!dir.join("lid-hold.json").exists());
}

#[test]
fn dropping_it_while_holding_lets_go() {
    let h = FakeHelper::ready();
    let s = super::sensors::Fake::default();
    *s.0.lock().unwrap() = plugged();
    let d = dir();
    let mut lid = Lid::new(Box::new(h.clone()), Box::new(s), Some(d.clone()), Prefs { enabled: true, ..Prefs::default() }, 0);
    lid.tick(0, 1);
    assert!(d.join("lid-hold.json").exists());
    h.log();
    drop(lid);
    assert_eq!(h.log(), ["release"]);
    assert!(!d.join("lid-hold.json").exists());
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn a_simulated_kill_drops_the_connection_without_a_release() {
    let mut t = T::on();
    t.lid.tick(0, 1);
    t.h.log();
    t.lid.simulate_crash();
    assert_eq!(t.h.log(), ["connection dropped"]);
    assert!(!t.h.held());
}

#[test]
fn limits_are_clamped() {
    let p = Prefs { enabled: true, only_on_power: false, min_battery: 3, max_hours: 1000, grace_mins: 60 }.clamped();
    assert_eq!((p.min_battery, p.max_hours, p.grace_mins), (10, 72, 10));
    assert_eq!(Prefs { min_battery: 90, ..Prefs::default() }.clamped().min_battery, 50);
    let d: Prefs = serde_json::from_str("{}").unwrap();
    assert_eq!(d, Prefs { enabled: false, only_on_power: true, min_battery: 20, max_hours: 8, grace_mins: 2 });
    // A settings.json from before the grace existed gets the default.
    let old: Prefs = serde_json::from_str(r#"{"enabled":true,"only_on_power":true,"min_battery":20,"max_hours":8}"#).unwrap();
    assert_eq!(old.grace_mins, 2);
}

// ---------- every agent waiting on the person: the grace, and the stop it records ----------

fn asker() -> Waiting {
    Waiting { title: "Fix the build".into(), ask: "Bash: npm test".into(), chat: Some(7), session: Some("claude:abc".into()), request: Some("req-1".into()) }
}

#[test]
fn the_grace_starts_when_the_last_agent_waits_and_lets_go_when_it_runs_out() {
    let mut t = T::on();
    t.sense(|r| r.lid_closed = Some(true));
    t.lid.tick_with(0, 1, 0, None);
    assert_eq!(t.h.log(), ["hold 60"]);
    // The only agent stops to ask: still held, for 2 minutes.
    t.lid.tick_with(10 * S, 0, 1, Some(asker()));
    assert!(t.h.held() && t.h.log().is_empty(), "the grace keeps holding");
    let st = t.lid.status(10 * S);
    assert_eq!((st.via, st.grace_until, st.grace_title.as_deref(), st.waiting), (Some(Via::Helper), Some(10 * S + 2 * MIN), Some("Fix the build"), 1));
    // Heartbeats go on through it.
    t.lid.tick_with(10 * S + BEAT_EVERY_MS, 0, 1, None);
    assert_eq!(t.h.log(), ["beat"]);
    t.lid.tick_with(10 * S + 2 * MIN - 1, 0, 1, None);
    assert!(t.h.held());
    // Out of time: let go, recorded with the chat and what it asked; noticed when the lid opens.
    t.lid.tick_with(10 * S + 2 * MIN, 0, 1, None);
    assert_eq!(t.h.log().last().map(String::as_str), Some("release"));
    assert!(!t.marker());
    let st = t.lid.status(10 * S + 2 * MIN);
    assert_eq!((st.via, st.grace_until), (None, None));
    let stop = &st.stops[0];
    assert_eq!(stop.code, Code::Waiting);
    assert_eq!(stop.detail, "“Fix the build” was waiting for your answer (Bash: npm test)");
    assert_eq!((stop.chat, stop.session.as_deref(), stop.request.as_deref()), (Some(7), Some("claude:abc"), Some("req-1")));
    assert!(t.lid.take_notices().is_empty(), "the lid is closed: the notice waits");
    t.sense(|r| r.lid_closed = Some(false));
    t.lid.tick_with(10 * S + 2 * MIN + READ_EVERY_MS, 0, 1, None);
    let n = t.lid.take_notices();
    assert_eq!(n.len(), 1);
    assert!(notice_text(&n[0]).starts_with("Let the Mac sleep at "), "{}", notice_text(&n[0]));
    assert!(notice_text(&n[0]).ends_with(": “Fix the build” was waiting for your answer (Bash: npm test)."));
    // The stop log keeps the chat on disk too.
    let back: Vec<Stop> = serde_json::from_slice(&std::fs::read(t.dir.join("lid-stops.json")).unwrap()).unwrap();
    assert_eq!(back[0].session.as_deref(), Some("claude:abc"));
}

#[test]
fn an_agent_working_again_cancels_the_grace() {
    let mut t = T::on();
    t.lid.tick_with(0, 1, 0, None);
    t.h.log();
    t.lid.tick_with(S, 0, 1, Some(asker()));
    assert!(t.lid.status(S).grace_until.is_some());
    // Answered (or another agent resumed) within the grace: a plain hold again, the clock gone.
    t.lid.tick_with(MIN, 1, 0, None);
    assert_eq!(t.lid.status(MIN).grace_until, None);
    // Waiting again later starts a fresh grace from then.
    t.lid.tick_with(5 * MIN, 0, 1, None);
    assert_eq!(t.lid.status(5 * MIN).grace_until, Some(7 * MIN));
    t.lid.tick_with(6 * MIN, 0, 1, None);
    assert!(t.h.held(), "the old grace would have ended at 3 min");
    assert!(t.h.log().iter().all(|l| l != "release"));
}

#[test]
fn finished_is_not_waiting_and_a_waiting_release_with_the_lid_open_records_nothing() {
    let mut t = T::on();
    t.lid.tick_with(0, 1, 0, None);
    t.h.log();
    // Done (nobody waits): let go at once, nothing recorded.
    t.lid.tick_with(S, 0, 0, None);
    assert_eq!(t.h.log(), ["release"]);
    // Waiting with the lid open (the person is at the Mac): the grace runs out quietly.
    t.lid.tick_with(2 * S, 1, 0, None);
    t.lid.tick_with(3 * S, 0, 1, Some(asker()));
    t.lid.tick_with(3 * S + 2 * MIN, 0, 1, None);
    assert!(!t.h.held());
    assert!(t.lid.status(3 * S + 2 * MIN).stops.is_empty());
    assert!(t.lid.take_notices().is_empty());
}

#[test]
fn no_grace_when_nothing_was_held_and_zero_grace_lets_go_at_once() {
    let mut t = T::new(FakeHelper::ready(), Prefs { enabled: true, grace_mins: 0, ..Prefs::default() });
    t.sense(|r| r.lid_closed = Some(true));
    t.lid.tick_with(0, 1, 0, None);
    t.h.log();
    t.lid.tick_with(S, 0, 1, Some(asker()));
    assert_eq!(t.h.log(), ["release"]);
    assert_eq!(t.lid.status(S).stops[0].code, Code::Waiting);
    // Waiting while not holding at all: no grace, no second stop.
    t.lid.tick_with(2 * S, 0, 1, None);
    assert_eq!(t.lid.status(2 * S).stops.len(), 1);
    assert_eq!(t.lid.status(2 * S).grace_until, None);
}

#[test]
fn the_limits_win_during_the_grace() {
    // Battery.
    let mut t = T::on();
    t.sense(|r| r.lid_closed = Some(true));
    t.lid.tick_with(0, 1, 0, None);
    t.lid.tick_with(S, 0, 1, Some(asker()));
    t.sense(|r| r.on_battery = Some(true));
    t.lid.tick_with(S + READ_EVERY_MS, 0, 1, None);
    assert!(!t.h.held(), "on battery lets go mid-grace");
    let st = t.lid.status(S + READ_EVERY_MS);
    assert_eq!(st.stops[0].code, Code::OnBattery);
    assert_eq!(st.grace_until, None, "nothing held, no grace shown");
    // And the grace running out later records nothing more.
    t.lid.tick_with(S + 3 * MIN, 0, 1, None);
    assert_eq!(t.lid.status(S + 3 * MIN).stops.len(), 1);

    // Heat.
    let mut t = T::on();
    t.lid.tick_with(0, 1, 0, None);
    t.lid.tick_with(S, 0, 1, Some(asker()));
    t.sense(|r| r.thermal = Some(Thermal::Serious));
    t.lid.tick_with(S + READ_EVERY_MS, 0, 1, None);
    assert!(!t.h.held());
    assert_eq!(t.lid.status(S + READ_EVERY_MS).stops[0].code, Code::Hot);

    // The maximum duration.
    let mut t = T::new(FakeHelper::ready(), Prefs { enabled: true, max_hours: 1, ..Prefs::default() });
    t.lid.tick_with(0, 1, 0, None);
    t.lid.tick_with(60 * MIN - S, 0, 1, Some(asker()));
    t.lid.tick_with(60 * MIN, 0, 1, None);
    assert!(!t.h.held());
    assert_eq!(t.lid.status(60 * MIN).stops[0].code, Code::MaxDuration);

    // Switching the setting off ends the grace too.
    let mut t = T::on();
    t.lid.tick_with(0, 1, 0, None);
    t.lid.tick_with(S, 0, 1, Some(asker()));
    t.lid.set_prefs(Prefs { enabled: false, ..Prefs::default() }, 2 * S);
    assert!(!t.h.held());
    assert_eq!(t.lid.status(2 * S).grace_until, None);
}

#[test]
fn a_self_test_can_shorten_the_grace_and_a_waiting_stop_without_a_title_still_reads() {
    let mut t = T::on();
    t.lid.set_grace_override(Some(3 * S));
    t.sense(|r| r.lid_closed = Some(true));
    t.lid.tick_with(0, 1, 0, None);
    t.lid.tick_with(S, 0, 1, Some(Waiting::default()));
    t.lid.tick_with(4 * S, 0, 1, None);
    assert!(!t.h.held());
    assert_eq!(t.lid.status(4 * S).stops[0].detail, "An agent was waiting for your answer");
    assert_eq!(waiting_detail(&Waiting { title: "A".into(), ask: "Which one?".into(), ..Waiting::default() }), "“A” was waiting for your answer (Which one?)");
}
