//! Settings > General > "Keep working with the lid closed" (docs/LID.md has the research, the design and the threat
//! note; APP_SPEC "Settings" the behaviour).
//!
//! macOS sleeps a MacBook when its lid closes whatever power assertions are held (`IOPMrootDomain` only looks at its
//! SleepDisabled switch, set with Apple's entitled `pmset disablesleep`), except in closed-display mode: on power
//! with an external display (`AppleClamshellCausesSleep` reads No). So there are two ways to hold:
//! - [`Via::Display`]: the Mac is in closed-display mode; the lid doesn't sleep it, and the no-idle-sleep assertion
//!   ([`crate::power::Keeper`], asked through [`Lid::wants_assertion`]) keeps it awake. Needs no privileges.
//! - [`Via::Helper`]: a small root LaunchDaemon (native/coool-lid-helper.m, installed once with an administrator's
//!   approval, see [`helper`]) turns SleepDisabled on while coool holds a connection to it and keeps a heartbeat, and
//!   turns it off the moment either stops (crash, force quit, kill), at its own limits, and at every start.
//!
//! [`Lid::tick`] runs on every refresh (about once a second) with the number of agents working right now: chats
//! mid-turn and coool's busy terminal sessions. A chat waiting on the person (a permission prompt, a question) doesn't
//! count: a prompt left waiting with the lid closed shouldn't hold the Mac awake for hours.
//!
//! Safety limits, enforced here (and the battery floor and heat again in the helper): on battery when "only on
//! power" is on (default); on battery at or below the threshold (default 20%, 10..=50); thermal state serious or
//! critical; the maximum duration of one working stretch (default 8 h, 0 = no limit). Heat and the time limit hold
//! until the agents stop working (or the setting is switched off and on); the battery ones lift when power returns.
//! Each automatic release is recorded (shown in Settings) and notified, at once or, if the lid was closed, when it
//! opens again.

pub mod helper;
pub mod sensors;

use crate::motion::Thermal;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;

/// Seconds the helper keeps holding without a heartbeat.
pub const LEASE_SECS: u32 = 60;
/// Heartbeat every this many ms while holding through the helper.
pub const BEAT_EVERY_MS: u64 = 15_000;
/// Battery, heat and lid are re-read this often while agents work (or a notice waits for the lid to open).
pub const READ_EVERY_MS: u64 = 5_000;
/// The helper's state is re-checked this often while not holding through it.
pub const PROBE_EVERY_MS: u64 = 30_000;
/// After a refused hold, try again after this long.
pub const RETRY_MS: u64 = 30_000;
/// A low-battery stop lifts only this many points above the threshold (or on power).
const BATTERY_HYSTERESIS: u8 = 3;
/// Automatic releases kept for Settings.
const KEEP_STOPS: usize = 10;

/// The setting and its limits (settings.json `lid`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Prefs {
    pub enabled: bool,
    /// Hold with the lid closed only while on power.
    pub only_on_power: bool,
    /// On battery at or below this percent, let go (10..=50).
    pub min_battery: u8,
    /// Longest hold of one working stretch, in hours; 0 = no limit.
    pub max_hours: u32,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { enabled: false, only_on_power: true, min_battery: 20, max_hours: 8 }
    }
}

impl Prefs {
    pub fn clamped(mut self) -> Self {
        self.min_battery = self.min_battery.clamp(10, 50);
        self.max_hours = self.max_hours.min(72);
        self
    }
}

/// What the sensors say (see [`sensors`]).
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct Reading {
    /// None: no battery (a desktop Mac) or unknown.
    pub on_battery: Option<bool>,
    pub battery_pct: Option<u8>,
    pub thermal: Option<Thermal>,
    /// None: no lid (a desktop Mac).
    pub lid_closed: Option<bool>,
    /// Closing the lid sleeps the Mac (false in closed-display mode: on power with an external display).
    pub lid_sleeps: Option<bool>,
    /// The system's SleepDisabled switch.
    pub sleep_disabled: Option<bool>,
}

pub trait Sensors: Send {
    fn read(&mut self) -> Reading;
}

/// Where the root helper stands.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "state", content = "detail", rename_all = "snake_case")]
pub enum HelperState {
    /// This build has no helper (not macOS, or it couldn't be compiled).
    Unavailable,
    /// Not installed.
    Missing,
    Ready,
    /// Installed (its LaunchDaemon file is there) but not answering.
    Unreachable(String),
    /// Answers with another protocol version: install again.
    Outdated(u32),
}

pub type Job = Box<dyn FnOnce() -> Result<(), String> + Send>;

/// The privileged side (the socket client of the real helper; a fake in tests).
pub trait Helper: Send {
    fn probe(&mut self) -> HelperState;
    /// Asks the helper to turn SleepDisabled on, for `lease` seconds without a heartbeat. The error is the helper's
    /// code ("battery", "thermal", "busy", "already-disabled", "pmset") or why it couldn't be reached.
    fn hold(&mut self, lease: u32) -> Result<(), String>;
    fn beat(&mut self) -> Result<(), String>;
    fn release(&mut self);
    /// Asks the helper to remove itself (no password: it is root already).
    fn uninstall(&mut self) -> Result<(), String>;
    /// Installs it: asks for an administrator's approval once (may wait minutes on the person), so it runs without
    /// the Lid's lock held.
    fn install_job(&self) -> Job;
    /// Removes it with an administrator's approval (when it doesn't answer).
    fn remove_job(&self) -> Job;
    /// Turns SleepDisabled off with an administrator's approval (a stale switch with no helper to do it).
    fn restore_job(&self) -> Job;
    /// The helper is the dry-run one (a self-test): nothing real is changed.
    fn dry_run(&self) -> bool {
        false
    }
    /// Closes the holding connection without a RELEASE (a self-test's stand-in for coool being killed).
    fn drop_connection(&mut self) {}
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Via {
    /// SleepDisabled through the root helper.
    Helper,
    /// Closed-display mode plus the no-idle-sleep assertion.
    Display,
}

/// Why the Mac isn't held (or was let go).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    OnBattery,
    LowBattery,
    Hot,
    MaxDuration,
    /// Not in closed-display mode and the helper isn't installed.
    NeedsHelper,
    /// The helper is installed but refused or didn't answer.
    HelperError,
    /// SleepDisabled is already on, set by someone else (`pmset disablesleep 1`): the lid already doesn't sleep.
    AlreadyDisabled,
    /// A desktop Mac: nothing to do.
    NoLid,
    /// The helper let go on its own (its battery floor or heat check) or lost coool's connection.
    HelperLetGo,
    /// coool quit (or crashed) while holding; found at the next launch.
    Recovered,
}

/// An automatic release.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Stop {
    /// Epoch ms.
    pub at: u64,
    pub code: Code,
    /// "battery 20%", "the Mac is running hot".
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Status {
    pub enabled: bool,
    pub helper: HelperState,
    pub dry_run: bool,
    /// Holding right now, and how.
    pub via: Option<Via>,
    /// Not holding although agents work, and why.
    pub blocked: Option<Code>,
    pub working: usize,
    /// Epoch ms the current working stretch began holding.
    pub since: Option<u64>,
    pub reading: Reading,
    /// Newest first.
    pub stops: Vec<Stop>,
    /// coool's marker says it left SleepDisabled on, the switch is still on and no helper answers.
    pub stale: bool,
    pub error: Option<String>,
    /// The longest hold, for the "1h 12m of 8h" line.
    pub prefs: Prefs,
}

/// coool's own marker of a hold through the helper (in its app data), so a launch after a crash knows.
#[derive(Serialize, Deserialize)]
struct Marker {
    since: u64,
    pid: u32,
}

pub struct Lid {
    helper: Box<dyn Helper>,
    sensors: Box<dyn Sensors>,
    /// The folder of the marker and the stop log; None keeps them in memory only.
    dir: Option<PathBuf>,
    prefs: Prefs,
    working: usize,
    hold: Option<Via>,
    since: Option<u64>,
    last_beat: u64,
    latch: Option<Code>,
    low_battery: bool,
    blocked: Option<Code>,
    reading: Reading,
    read_at: Option<u64>,
    helper_state: HelperState,
    probed_at: Option<u64>,
    retry_at: u64,
    stops: VecDeque<Stop>,
    /// Stops not notified yet (waiting for the lid to open).
    notices: Vec<Stop>,
    /// Stops to notify now ([`Lid::take_notices`]).
    pending_out: Vec<Stop>,
    error: Option<String>,
    stale: bool,
}

impl Lid {
    pub fn new(helper: Box<dyn Helper>, sensors: Box<dyn Sensors>, dir: Option<PathBuf>, prefs: Prefs, now: u64) -> Self {
        let mut l = Lid {
            helper,
            sensors,
            dir,
            prefs: prefs.clamped(),
            working: 0,
            hold: None,
            since: None,
            last_beat: 0,
            latch: None,
            low_battery: false,
            blocked: None,
            reading: Reading::default(),
            read_at: None,
            helper_state: HelperState::Missing,
            probed_at: None,
            retry_at: 0,
            stops: VecDeque::new(),
            notices: Vec::new(),
            pending_out: Vec::new(),
            error: None,
            stale: false,
        };
        l.stops = l.load_stops();
        l.recover(now);
        l
    }

    // ---------- files ----------

    fn marker_path(&self) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join("lid-hold.json"))
    }

    fn stops_path(&self) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join("lid-stops.json"))
    }

    fn write_marker(&self, since: u64) {
        if let Some(p) = self.marker_path() {
            if let Some(d) = p.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let _ = std::fs::write(p, serde_json::to_vec(&Marker { since, pid: std::process::id() }).unwrap_or_default());
        }
    }

    fn remove_marker(&self) {
        if let Some(p) = self.marker_path() {
            let _ = std::fs::remove_file(p);
        }
    }

    fn read_marker(&self) -> Option<Marker> {
        let p = self.marker_path()?;
        let b = std::fs::read(p).ok()?;
        Some(serde_json::from_slice(&b).unwrap_or(Marker { since: 0, pid: 0 }))
    }

    fn load_stops(&self) -> VecDeque<Stop> {
        self.stops_path().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn save_stops(&self) {
        if let Some(p) = self.stops_path() {
            if let Some(d) = p.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let _ = std::fs::write(p, serde_json::to_vec(&self.stops).unwrap_or_default());
        }
    }

    // ---------- launch ----------

    /// A marker left by a coool that quit while holding: the helper let go when the connection closed (or will at its
    /// next start); record it. If the switch is still on and no helper answers, say so (Settings offers a fix).
    fn recover(&mut self, now: u64) {
        let Some(m) = self.read_marker() else { return };
        self.helper_state = self.helper.probe();
        self.probed_at = Some(now);
        self.reading = self.sensors.read();
        self.read_at = Some(now);
        if self.reading.sleep_disabled == Some(true) && self.helper_state != HelperState::Ready {
            self.stale = true;
            return;
        }
        self.remove_marker();
        let since = if m.since > 0 { format!(" (holding since {})", clock(m.since)) } else { String::new() };
        self.record(now, Code::Recovered, format!("coool quit while holding the Mac awake{since}; normal sleep was restored"), false);
    }

    // ---------- the setting ----------

    /// Applies the setting at once. Switching it off lets go and removes the helper if it is installed.
    pub fn set_prefs(&mut self, p: Prefs, now: u64) {
        let p = p.clamped();
        let was = self.prefs.enabled;
        self.prefs = p;
        if was && !self.prefs.enabled {
            self.let_go(None, now);
            self.since = None;
            self.latch = None;
            self.blocked = None;
            if matches!(self.helper.probe(), HelperState::Ready | HelperState::Outdated(_)) {
                if let Err(e) = self.helper.uninstall() {
                    self.error = Some(format!("Couldn't remove the helper: {e}"));
                }
            }
            self.probed_at = None;
        }
        if !was && self.prefs.enabled {
            self.latch = None;
            self.retry_at = 0;
            self.probed_at = None;
        }
        self.tick(now, self.working);
    }

    // ---------- every refresh ----------

    pub fn tick(&mut self, now: u64, working: usize) {
        self.working = working;
        let reading_due = self.read_at.is_none_or(|t| now.saturating_sub(t) >= READ_EVERY_MS);
        if !self.prefs.enabled {
            if self.hold.is_some() {
                self.let_go(None, now);
            }
            self.since = None;
            self.latch = None;
            self.blocked = None;
            if !self.notices.is_empty() && reading_due {
                self.read(now);
            }
            return;
        }
        if working == 0 {
            if self.hold.is_some() {
                self.let_go(None, now);
            }
            self.since = None;
            self.latch = None;
            self.blocked = None;
            self.low_battery = false;
            if !self.notices.is_empty() && reading_due {
                self.read(now);
            }
            return;
        }
        if reading_due {
            self.read(now);
        }
        if self.hold != Some(Via::Helper) && self.probed_at.is_none_or(|t| now.saturating_sub(t) >= PROBE_EVERY_MS) {
            self.helper_state = self.helper.probe();
            self.probed_at = Some(now);
        }

        if let Some(b) = self.blocker(now) {
            self.blocked = Some(b);
            if self.hold.is_some() {
                let detail = self.detail(b);
                self.let_go(Some((b, detail)), now);
            }
            return;
        }

        // Holding through the helper: keep the heartbeat.
        if self.hold == Some(Via::Helper) {
            if now.saturating_sub(self.last_beat) >= BEAT_EVERY_MS {
                match self.helper.beat() {
                    Ok(()) => self.last_beat = now,
                    Err(e) => {
                        // The helper already let go (its own limit, or it restarted).
                        self.hold = None;
                        self.remove_marker();
                        self.helper_state = self.helper.probe();
                        self.probed_at = Some(now);
                        self.retry_at = now + RETRY_MS;
                        self.record(now, Code::HelperLetGo, format!("the helper stopped holding ({e})"), true);
                    }
                }
            }
            if self.hold.is_some() {
                self.blocked = None;
                return;
            }
        }

        let has_lid = self.reading.lid_closed.is_some();
        let display_mode = self.reading.lid_sleeps == Some(false);
        if !has_lid {
            self.blocked = Some(Code::NoLid);
            if self.hold.is_some() {
                self.let_go(None, now);
            }
            return;
        }
        if self.helper_state == HelperState::Ready && now >= self.retry_at {
            match self.helper.hold(LEASE_SECS) {
                Ok(()) => {
                    // From the display path (if any) to the helper: no gap, the assertion goes once this holds.
                    self.hold = Some(Via::Helper);
                    let since = *self.since.get_or_insert(now);
                    self.last_beat = now;
                    self.write_marker(since);
                    self.blocked = None;
                    self.error = None;
                    return;
                }
                Err(e) => {
                    self.retry_at = now + RETRY_MS;
                    if e == "already-disabled" {
                        self.blocked = Some(Code::AlreadyDisabled);
                        if self.hold.is_some() {
                            self.let_go(None, now);
                        }
                        return;
                    }
                    self.error = Some(helper_error_text(&e));
                    if e == "battery" || e == "thermal" {
                        // The helper's own floor said no: same as our limit.
                        let code = if e == "battery" { Code::LowBattery } else { Code::Hot };
                        if code == Code::Hot {
                            self.latch = Some(Code::Hot);
                        }
                        self.blocked = Some(code);
                        if self.hold.is_some() {
                            let detail = self.detail(code);
                            self.let_go(Some((code, detail)), now);
                        }
                        return;
                    }
                }
            }
        }
        if display_mode {
            if self.hold.is_none() {
                self.hold = Some(Via::Display);
                self.since.get_or_insert(now);
            }
            self.blocked = None;
            return;
        }
        // Neither way works now.
        if self.hold.is_some() {
            self.let_go(None, now);
        }
        self.blocked = Some(match self.helper_state {
            HelperState::Missing | HelperState::Unavailable => Code::NeedsHelper,
            _ => Code::HelperError,
        });
    }

    fn read(&mut self, now: u64) {
        self.reading = self.sensors.read();
        self.read_at = Some(now);
        if self.reading.lid_closed != Some(true) {
            // The lid is open (or there is none): what waited for the person can go out now.
            for s in std::mem::take(&mut self.notices) {
                self.pending_out.push(s);
            }
        }
    }

    /// The limit that stops a hold now, if any.
    fn blocker(&mut self, now: u64) -> Option<Code> {
        if let Some(l) = self.latch {
            return Some(l);
        }
        let r = &self.reading;
        if matches!(r.thermal, Some(Thermal::Serious | Thermal::Critical)) {
            self.latch = Some(Code::Hot);
            return self.latch;
        }
        if self.prefs.max_hours > 0 && self.since.is_some_and(|s| now.saturating_sub(s) >= self.prefs.max_hours as u64 * 3_600_000) {
            self.latch = Some(Code::MaxDuration);
            return self.latch;
        }
        if r.on_battery == Some(true) {
            let min = self.prefs.min_battery;
            let low = r.battery_pct.is_some_and(|p| p <= min || (self.low_battery && p < min.saturating_add(BATTERY_HYSTERESIS)));
            self.low_battery = low;
            if low {
                return Some(Code::LowBattery);
            }
            if self.prefs.only_on_power {
                return Some(Code::OnBattery);
            }
        } else {
            self.low_battery = false;
        }
        None
    }

    fn detail(&self, c: Code) -> String {
        match c {
            Code::OnBattery => "on battery".into(),
            Code::LowBattery => match self.reading.battery_pct {
                Some(p) => format!("battery {p}%"),
                None => "battery low".into(),
            },
            Code::Hot => "the Mac is running hot".into(),
            Code::MaxDuration => format!("the {} h limit was reached", self.prefs.max_hours),
            _ => String::new(),
        }
    }

    /// Lets go of whatever is held; `stop` records it as an automatic release.
    fn let_go(&mut self, stop: Option<(Code, String)>, now: u64) {
        match self.hold.take() {
            Some(Via::Helper) => {
                self.helper.release();
                self.remove_marker();
            }
            Some(Via::Display) | None => {}
        }
        if let Some((c, d)) = stop {
            self.record(now, c, d, true);
        }
    }

    fn record(&mut self, now: u64, code: Code, detail: String, notify: bool) {
        let s = Stop { at: now, code, detail };
        self.stops.push_front(s.clone());
        self.stops.truncate(KEEP_STOPS);
        self.save_stops();
        if notify && self.reading.lid_closed == Some(true) {
            self.notices.push(s);
        } else {
            self.pending_out.push(s);
        }
    }

    // ---------- out ----------

    /// The no-idle-sleep assertion is wanted for the closed-display path ([`crate::power::Keeper::set_lid`]).
    pub fn wants_assertion(&self) -> bool {
        self.hold == Some(Via::Display)
    }

    /// SleepDisabled is held, which covers idle sleep too: the keep-awake assertion would be a second hold.
    pub fn covers_idle_sleep(&self) -> bool {
        self.hold == Some(Via::Helper)
    }

    /// Automatic releases to notify now ("Stopped holding the Mac awake at 02:14: battery 20%").
    pub fn take_notices(&mut self) -> Vec<String> {
        std::mem::take(&mut self.pending_out).into_iter().map(|s| notice_text(&s)).collect()
    }

    /// The status for Settings; re-reads the sensors and the helper (it's called every 2 s at most, while Settings shows).
    pub fn status(&mut self, now: u64) -> Status {
        if self.hold != Some(Via::Helper) {
            self.helper_state = self.helper.probe();
            self.probed_at = Some(now);
        }
        self.read(now);
        if self.stale && self.reading.sleep_disabled != Some(true) {
            self.stale = false;
            self.remove_marker();
        }
        Status {
            enabled: self.prefs.enabled,
            helper: self.helper_state.clone(),
            dry_run: self.helper.dry_run(),
            via: self.hold,
            blocked: if self.working > 0 && self.prefs.enabled { self.blocked } else { None },
            working: self.working,
            since: self.since.filter(|_| self.hold.is_some()),
            reading: self.reading.clone(),
            stops: self.stops.iter().cloned().collect(),
            stale: self.stale,
            error: self.error.clone(),
            prefs: self.prefs.clone(),
        }
    }

    pub fn install_job(&self) -> Job {
        self.helper.install_job()
    }

    pub fn remove_job(&self) -> Job {
        self.helper.remove_job()
    }

    pub fn restore_job(&self) -> Job {
        self.helper.restore_job()
    }

    /// After an install or removal: look again right away.
    pub fn refresh_helper(&mut self, now: u64) {
        self.helper_state = self.helper.probe();
        self.probed_at = Some(now);
        self.retry_at = 0;
        self.error = None;
        self.tick(now, self.working);
    }

    /// "Remove helper": lets go, then the helper removes itself. Err when it doesn't answer (then [`Self::remove_job`]).
    pub fn uninstall(&mut self, now: u64) -> Result<(), String> {
        if self.hold == Some(Via::Helper) {
            self.let_go(None, now);
        }
        let r = self.helper.uninstall();
        self.helper_state = self.helper.probe();
        self.probed_at = Some(now);
        r
    }

    /// The person restored sleep by hand (or the stale switch went off): forget the marker.
    pub fn clear_stale(&mut self, now: u64) {
        self.remove_marker();
        self.stale = false;
        self.read(now);
    }

    /// A self-test's simulated crash: the connection to the helper drops without a RELEASE, as when coool is killed.
    pub fn simulate_crash(&mut self) {
        if self.hold == Some(Via::Helper) {
            self.helper.drop_connection();
        }
    }
}

impl Drop for Lid {
    fn drop(&mut self) {
        if self.hold == Some(Via::Helper) {
            self.helper.release();
            self.remove_marker();
        }
    }
}

fn helper_error_text(e: &str) -> String {
    match e {
        "busy" => "Another app is holding the helper.".into(),
        "pmset" => "macOS refused to turn sleep off (pmset failed).".into(),
        "state" => "The helper couldn't write its state.".into(),
        other => format!("The helper didn't hold: {other}."),
    }
}

/// Local "HH:MM" of an epoch-ms time.
pub fn clock(ms: u64) -> String {
    let t = (ms / 1000) as libc::time_t;
    // SAFETY: localtime_r writes into the tm we own.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let ok = unsafe { !libc::localtime_r(&t, &mut tm).is_null() };
    if ok { format!("{:02}:{:02}", tm.tm_hour, tm.tm_min) } else { "?".into() }
}

pub fn notice_text(s: &Stop) -> String {
    match s.code {
        Code::Recovered | Code::HelperLetGo => format!("At {}: {}.", clock(s.at), s.detail),
        _ => format!("Stopped holding the Mac awake at {}: {}.", clock(s.at), s.detail),
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests;
