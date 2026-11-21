//! What an agent's click, drag and key press on the sandbox Mac turn into: the exact list of pointer reports, key
//! transitions and pauses the host helper plays on the VM's USB pointer and keyboard (`play` in
//! `native/coool-vm.m`). Built here so the sequences are plain data, checked by unit tests.
//!
//! The pointer is a screen-coordinate (absolute) device: each report is a position plus the buttons held, and the
//! guest derives mouse-moved / dragged deltas from successive reports. So a click is made the way a hand makes one:
//! - the pointer glides from where it is to the target in small steps (mouse-moved events, buttons up), ending
//!   exactly on the target;
//! - it rests there long enough that the motion and the press land in different guest frames and HID reports (an
//!   app that reads "button held + mouse delta this frame", like a 3D viewport's orbit camera, sees no motion while
//!   the button is down);
//! - down and up are sent at the very same point, nothing in between, held for a human's ~60 ms; a double click
//!   repeats down/up at that point within the double-click interval.
//!
//! A drag is the only thing that moves with a button held, and only when asked for.
//!
//! A key press: each modifier goes down on its own report with a gap (longer than a USB poll), then the key is held,
//! released, and the modifiers come up in reverse order, again with gaps, so no transition is coalesced away and the
//! shortcut reaches the guest whole. Waiting for the target window to be key first is [`wait_steady`].

use serde_json::{Value, json};
use std::collections::HashMap;
use std::time::Duration;

/// One thing the helper does, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// A pointer report: position in screen points (origin top left) and the buttons held (1 left, 2 right).
    Pointer { x: f64, y: f64, buttons: u8 },
    /// A key goes down or up (a key name the helper knows: "command", "s", "escape", ...).
    Key { name: String, down: bool },
    Wait(u32),
}

pub const LEFT: u8 = 1;
pub const RIGHT: u8 = 2;

/// Rest on the target before pressing: motion and press never share a guest frame (30 fps is 33 ms) or HID report.
pub const SETTLE_MS: u32 = 90;
/// How long a button or key is held.
pub const HOLD_MS: u32 = 60;
/// Between the clicks of a double / triple click (well inside macOS's double-click interval).
pub const MULTI_GAP_MS: u32 = 90;
/// Between a modifier's transition and the next key transition.
pub const MOD_GAP_MS: u32 = 30;
/// Pause after the last transition, so back-to-back actions don't run together.
pub const TAIL_MS: u32 = 30;

/// The modifiers a shortcut may name, as the helper's key names. Unknown ones are an error (never a stray key).
pub fn modifier(name: &str) -> Option<&'static str> {
    Some(match name.trim().to_ascii_lowercase().as_str() {
        "command" | "cmd" | "meta" | "super" => "command",
        "shift" => "shift",
        "option" | "opt" | "alt" => "option",
        "control" | "ctrl" => "control",
        "fn" | "function" => "fn",
        _ => return None,
    })
}

/// The pointer moving from `from` to `to` with the buttons up: mouse-moved events in steps of ~25 points, eased,
/// ~8-12 ms apart, the last one exactly on `to`. Already there: one report on the spot (the guest sees the pointer
/// arrive even if something else moved it).
pub fn glide(from: (f64, f64), to: (f64, f64), buttons: u8) -> Vec<Step> {
    let (dx, dy) = (to.0 - from.0, to.1 - from.1);
    let dist = (dx * dx + dy * dy).sqrt();
    if !dist.is_finite() || dist < 1.0 {
        return vec![Step::Pointer { x: to.0, y: to.1, buttons }];
    }
    let n = ((dist / 25.0).ceil() as usize).clamp(4, 24);
    // ~0.3 ms a point, 60-220 ms in all: quick, but never a teleport.
    let total = (dist * 0.3).clamp(60.0, 220.0);
    let gap = ((total / n as f64).round() as u32).max(6);
    let mut out = Vec::with_capacity(n * 2);
    for i in 1..=n {
        let t = i as f64 / n as f64;
        let e = t * t * (3.0 - 2.0 * t); // smoothstep: starts and ends slowly
        let p = if i == n { to } else { (from.0 + dx * e, from.1 + dy * e) };
        out.push(Step::Pointer { x: p.0, y: p.1, buttons });
        if i < n {
            out.push(Step::Wait(gap));
        }
    }
    out
}

/// A click (`count` 1-3) with `button` at `to`, the pointer starting at `from`.
pub fn click(from: (f64, f64), to: (f64, f64), button: u8, count: u32) -> Vec<Step> {
    let mut out = glide(from, to, 0);
    out.push(Step::Wait(SETTLE_MS));
    let count = count.clamp(1, 3);
    for i in 0..count {
        out.push(Step::Pointer { x: to.0, y: to.1, buttons: button });
        out.push(Step::Wait(HOLD_MS));
        out.push(Step::Pointer { x: to.0, y: to.1, buttons: 0 });
        out.push(Step::Wait(if i + 1 < count { MULTI_GAP_MS } else { TAIL_MS }));
    }
    out
}

/// A left-button drag from `start` to `end` over about `ms`, the pointer starting at `from`.
pub fn drag(from: (f64, f64), start: (f64, f64), end: (f64, f64), ms: f64) -> Vec<Step> {
    let mut out = glide(from, start, 0);
    out.push(Step::Wait(SETTLE_MS));
    out.push(Step::Pointer { x: start.0, y: start.1, buttons: LEFT });
    out.push(Step::Wait(HOLD_MS));
    let ms = if ms.is_finite() { ms.clamp(50.0, 5000.0) } else { 300.0 };
    let n = ((ms / 16.0) as usize).max(4);
    let gap = ((ms / n as f64).round() as u32).max(1);
    for i in 1..=n {
        let t = i as f64 / n as f64;
        let p = if i == n { end } else { (start.0 + (end.0 - start.0) * t, start.1 + (end.1 - start.1) * t) };
        out.push(Step::Pointer { x: p.0, y: p.1, buttons: LEFT });
        out.push(Step::Wait(gap));
    }
    out.push(Step::Wait(HOLD_MS));
    out.push(Step::Pointer { x: end.0, y: end.1, buttons: 0 });
    out.push(Step::Wait(TAIL_MS));
    out
}

/// A key with modifiers: modifiers down (in order, a gap after each), the key held, released, modifiers up in
/// reverse (a gap before each). Errors on a modifier it doesn't know.
pub fn press(key: &str, modifiers: &[&str]) -> Result<Vec<Step>, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("no key given".into());
    }
    let mut mods: Vec<&'static str> = Vec::new();
    for m in modifiers {
        let m = modifier(m).ok_or_else(|| format!("unknown modifier {m:?} (use command, shift, option, control)"))?;
        if !mods.contains(&m) {
            mods.push(m);
        }
    }
    let k = |name: &str, down| Step::Key { name: name.to_string(), down };
    let mut out = Vec::new();
    for m in &mods {
        out.push(k(m, true));
        out.push(Step::Wait(MOD_GAP_MS));
    }
    out.push(k(key, true));
    out.push(Step::Wait(HOLD_MS));
    out.push(k(key, false));
    for m in mods.iter().rev() {
        out.push(Step::Wait(MOD_GAP_MS));
        out.push(k(m, false));
    }
    out.push(Step::Wait(TAIL_MS));
    Ok(out)
}

/// The modifiers of a tool call's `modifiers` (a list of names, or one name).
pub fn modifier_list(v: &Value) -> Vec<&str> {
    match v {
        Value::Array(a) => a.iter().filter_map(|m| m.as_str()).collect(),
        Value::String(s) => s.split(['+', ',', ' ']).filter(|m| !m.is_empty()).collect(),
        _ => Vec::new(),
    }
}

/// The plan as the helper's `play` request.
pub fn request(steps: &[Step]) -> Value {
    let list: Vec<Value> = steps
        .iter()
        .map(|s| match s {
            Step::Pointer { x, y, buttons } => json!({ "p": [x, y, buttons] }),
            Step::Key { name, down } => json!({ "k": name, "d": down }),
            Step::Wait(ms) => json!({ "w": ms }),
        })
        .collect();
    json!({ "cmd": "play", "steps": list })
}

/// How long a plan takes to play (for the call's timeout).
pub fn duration(steps: &[Step]) -> Duration {
    Duration::from_millis(steps.iter().map(|s| if let Step::Wait(ms) = s { *ms as u64 } else { 1 }).sum())
}

/// Waits until what `sample` reads is the same twice in a row (`interval` apart), for at most `cap`: used before a
/// key press, with the frontmost app and its focused window as the sample, so a shortcut sent right after a focus
/// change (a dialog closing, a window coming back from the Dock, an app activating) goes to the window that will
/// be key, not to one on its way out. A sample that fails (None) counts as not settled. Returns (settled, samples).
pub fn wait_steady<S: PartialEq>(mut sample: impl FnMut() -> Option<S>, mut sleep: impl FnMut(Duration), interval: Duration, cap: Duration) -> (bool, u32) {
    let max = (cap.as_millis() / interval.as_millis().max(1)) as u32 + 1;
    let mut last = sample();
    let mut n = 1;
    while n < max.max(2) {
        sleep(interval);
        let now = sample();
        n += 1;
        if now.is_some() && now == last {
            return (true, n);
        }
        last = now;
    }
    (false, n)
}

/// The focus fingerprint from a guest-agent `tree` with `maxNodes: 2` (the app, then its focused window first):
/// the app's name and the window's role, title and frame. None when the app isn't known.
pub fn focus_print(tree: &Value) -> Option<String> {
    let nodes = tree["nodes"].as_array()?;
    let app = nodes.first()?;
    let win = nodes.get(1).cloned().unwrap_or(Value::Null);
    Some(format!("{}|{}|{}|{}", app["label"].as_str().unwrap_or(""), win["role"].as_str().unwrap_or(""), win["label"].as_str().unwrap_or(""), win["frame"]))
}

/// The front app's key-window fingerprint for a key press: [`focus_print`], but None (not ready) while an app that
/// is known to report its key window (`known[app] == true`, see [`learn`]) has windows and none of them is key yet,
/// e.g. a window still coming back from being hidden. Apps that never said either way go by stability alone.
pub fn key_print(tree: &Value, known: &HashMap<String, bool>) -> Option<String> {
    let print = focus_print(tree)?;
    if let Some(f) = front(tree)
        && !f.windows.is_empty()
        && !f.windows.iter().any(|w| w.key)
        && known.get(&f.app) == Some(&true)
    {
        return None;
    }
    Some(print)
}

// ---------------------------------------------------------------------------------------------------
// Before a click: the window under the point must be key in the active app.
//
// AppKit spends the first mouse-down on a window that isn't key (in an app that isn't active, or a window still
// coming up) on making it key; a view that doesn't accept first mouse (most custom views: a Metal/3D viewport, a
// canvas) never sees that click. A person sees the window come forward and clicks again; an agent sees nothing
// happen. So before a click coool checks, with what the guest agent already answers (`tree` for the front app and
// its windows, `run` for one `osascript` that reads the window list), and brings the window forward first when it
// has to. A click on the key window of the front app stays exactly one click with no waiting.

/// A top-level window of the front app, as the agent's `tree` lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct Win {
    pub frame: [f64; 4],
    /// The window is key (its accessibility `AXFocused`).
    pub key: bool,
}

/// The frontmost app (the accessibility system's focused app) and its windows, focused one first.
#[derive(Debug, Clone, PartialEq)]
pub struct Front {
    /// Bundle id, or the name when it has none.
    pub app: String,
    pub name: String,
    pub windows: Vec<Win>,
}

/// The app whose window is on top at a point (the guest's window list).
#[derive(Debug, Clone, PartialEq)]
pub struct Owner {
    pub pid: i64,
    /// Bundle id, or the name when it has none.
    pub app: String,
    pub name: String,
    /// Its bundle on disk ("" for a bare executable).
    pub path: String,
}

/// The menu bar's height: clicks there go to the menu bar, never to a window.
pub const MENU_BAR: f64 = 24.0;
/// How often, and for how long, coool looks for the window to become key before clicking anyway.
pub const KEY_POLL: Duration = Duration::from_millis(60);
pub const KEY_WAIT: Duration = Duration::from_millis(1500);

fn frame4(v: &Value) -> Option<[f64; 4]> {
    let a = v.as_array().filter(|a| a.len() == 4)?;
    let f = [a[0].as_f64()?, a[1].as_f64()?, a[2].as_f64()?, a[3].as_f64()?];
    (f[2] > 0.0 && f[3] > 0.0).then_some(f)
}

fn inside(f: &[f64; 4], (x, y): (f64, f64)) -> bool {
    x >= f[0] && y >= f[1] && x < f[0] + f[2] && y < f[1] + f[3]
}

/// The front app from a guest-agent `tree` (`menus: false`): node 0 is the app, its windows are the depth-1 nodes.
/// None when the agent told nothing usable (no app node).
pub fn front(tree: &Value) -> Option<Front> {
    let nodes = tree["nodes"].as_array()?;
    let app = nodes.first().filter(|n| n["role"] == "application")?;
    let name = app["label"].as_str().unwrap_or("").to_string();
    let id = app["identifier"].as_str().filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| name.clone());
    if id.is_empty() {
        return None;
    }
    let windows = nodes[1..]
        .iter()
        .filter(|n| n["depth"].as_u64() == Some(1) && matches!(n["role"].as_str(), Some("window" | "sheet" | "dialog")))
        .filter_map(|n| Some(Win { frame: frame4(&n["frame"])?, key: n["focused"] == true }))
        .collect();
    Some(Front { app: id, name, windows })
}

impl Front {
    fn has_key(&self) -> bool {
        self.windows.iter().any(|w| w.key)
    }
    fn is(&self, o: &Owner) -> bool {
        self.app == o.app || (!self.name.is_empty() && self.name == o.name)
    }
}

/// What the window-list script printed: the owner of the top normal window at the point. None for no window there
/// (the desktop, the Dock, a menu) or output it can't read (an old guest without `osascript`).
pub fn owner(v: &Value) -> Option<Owner> {
    let pid = v["pid"].as_i64().filter(|p| *p > 0)?;
    let name = v["name"].as_str().unwrap_or("").to_string();
    let bundle = v["bundle"].as_str().unwrap_or("");
    let app = if bundle.is_empty() { name.clone() } else { bundle.to_string() };
    Some(Owner { pid, app, name, path: v["path"].as_str().unwrap_or("").to_string() })
}

/// JXA: the top on-screen layer-0 window at (argv[0], argv[1]) and its app, as JSON ("{}" for none). The window list
/// gives owners and bounds without any permission (only titles need Screen Recording) and sends no Apple events.
const OWNER_JS: &str = r#"ObjC.import("CoreGraphics"); ObjC.import("AppKit"); function run(a) { var x = +a[0], y = +a[1], l = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(17, 0))) || []; for (var i = 0; i < l.length; i++) { var w = l[i], b = w.kCGWindowBounds || {}; if (w.kCGWindowLayer !== 0 || w.kCGWindowAlpha === 0 || x < b.X || y < b.Y || x >= b.X + b.Width || y >= b.Y + b.Height) continue; var r = $.NSRunningApplication.runningApplicationWithProcessIdentifier(w.kCGWindowOwnerPID), s = function (v) { return !v || v.isNil() ? "" : v.js; }; return JSON.stringify({ pid: w.kCGWindowOwnerPID, name: w.kCGWindowOwnerName || "", bundle: r.isNil() ? "" : s(r.bundleIdentifier), path: r.isNil() || r.bundleURL.isNil() ? "" : s(r.bundleURL.path), frame: [b.X, b.Y, b.Width, b.Height] }); } return "{}"; }"#;

/// JXA: activates the app with pid argv[0] (for a bare executable, which Launch Services can't open by path).
const ACTIVATE_JS: &str = r#"ObjC.import("AppKit"); function run(a) { var r = $.NSRunningApplication.runningApplicationWithProcessIdentifier(+a[0]); return r.isNil() ? "0" : (r.activateWithOptions(3) ? "1" : "0"); }"#;

/// The guest shell command (the agent's `run`) that prints the [`owner`] JSON for a point.
pub fn owner_command((x, y): (f64, f64)) -> String {
    format!("/usr/bin/osascript -l JavaScript -e '{OWNER_JS}' {:.0} {:.0}", x.round(), y.round())
}

/// The guest shell command that activates a process by pid.
pub fn activate_command(pid: i64) -> String {
    format!("/usr/bin/osascript -l JavaScript -e '{ACTIVATE_JS}' {pid}")
}

/// Remembers whether an app reports its key window: seen key once → true (kept). `false` is set only by
/// [`before_click`] after a full wait in which the app was in front with windows and none ever read key.
pub fn learn(known: &mut HashMap<String, bool>, f: &Front) {
    if f.has_key() {
        known.insert(f.app.clone(), true);
    }
}

/// Whether a click at `p` needs a look at who owns the window there: not when the front app's top window under the
/// point is key (the common case, one click as it is), nor on the menu bar.
pub fn needs_look(f: &Front, p: (f64, f64)) -> bool {
    if p.1 < MENU_BAR {
        return false;
    }
    !f.windows.iter().find(|w| inside(&w.frame, p)).is_some_and(|w| w.key)
}

/// What the guest must do for [`before_click`]; [`vm`](super::vm) does it with the agent, tests with a script.
pub trait Guest {
    /// The front app now (agent `tree`, `menus: false`); None when the agent can't say (no permission, an old agent).
    fn front(&mut self) -> Option<Front>;
    /// The owner of the top window at `p`; None for none, or when the lookup isn't possible.
    fn owner(&mut self, p: (f64, f64)) -> Option<Owner>;
    /// Activates the app (raises its windows). Whether that was accepted.
    fn activate(&mut self, o: &Owner) -> bool;
    fn sleep(&mut self, d: Duration);
}

/// What was done before a click.
#[derive(Debug, Clone, PartialEq)]
pub enum BeforeClick {
    /// Nothing needed (the key window is under the point, the menu bar, the desktop or Dock), or nothing could be
    /// told (an old guest agent, no Accessibility): today's plain click.
    Plain,
    /// The front app's window was still coming up; it waited until the window was key.
    Waited,
    /// Another app's window was under the point: brought that app (name) forward, and its window is key.
    Activated(String),
    /// The window (its app's name) never read key within [`KEY_WAIT`]: clicked anyway.
    NotKey(String),
}

impl BeforeClick {
    /// For the tool result.
    pub fn note(&self) -> String {
        match self {
            BeforeClick::Plain | BeforeClick::Waited => String::new(),
            BeforeClick::Activated(n) => format!(" (brought {n} forward first)"),
            BeforeClick::NotKey(n) => format!(" ({n}'s window wasn't key yet, so this click may only have brought it forward: observe, and click again if nothing changed)"),
        }
    }
}

/// Gets the window under `p` ready for a click: if it belongs to an app that isn't frontmost, activates that app;
/// if the front app has no key window yet (it is still coming up), waits; then waits (at most [`KEY_WAIT`]) until
/// the app is in front with a key window. Never clicks itself; the click follows whatever this returns.
pub fn before_click(g: &mut impl Guest, p: (f64, f64), known: &mut HashMap<String, bool>) -> BeforeClick {
    let Some(f) = g.front() else { return BeforeClick::Plain };
    learn(known, &f);
    if !needs_look(&f, p) {
        return BeforeClick::Plain;
    }
    let Some(o) = g.owner(p) else { return BeforeClick::Plain };
    let same = f.is(&o);
    if same {
        // The app is active with some key window (a click on its other window or a panel): AppKit's own business.
        // An app that never reports key windows: nothing to wait for.
        if f.has_key() || known.get(&f.app) == Some(&false) {
            return BeforeClick::Plain;
        }
    }
    let name = if o.name.is_empty() { o.app.clone() } else { o.name.clone() };
    // Refused or timed out (the agent may still be busy with it): don't wait on top, click as before.
    if !same && !g.activate(&o) {
        return BeforeClick::NotKey(name);
    }
    let polls = (KEY_WAIT.as_millis() / KEY_POLL.as_millis()) as u32;
    let mut last = None;
    for i in 0..=polls {
        // The agent stopped answering: no point polling it.
        let Some(now) = g.front() else { break };
        learn(known, &now);
        if now.is(&o) && now.has_key() {
            return if same { BeforeClick::Waited } else { BeforeClick::Activated(name) };
        }
        last = Some(now);
        if i < polls {
            g.sleep(KEY_POLL);
        }
    }
    // In front with windows the whole time, and none ever read key: this app doesn't say; don't wait for it again.
    if let Some(l) = last.filter(|l| l.is(&o) && !l.windows.is_empty() && known.get(&l.app) != Some(&true)) {
        known.insert(l.app, false);
    }
    BeforeClick::NotKey(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pointers(s: &[Step]) -> Vec<(f64, f64, u8)> {
        s.iter().filter_map(|s| if let Step::Pointer { x, y, buttons } = s { Some((*x, *y, *buttons)) } else { None }).collect()
    }

    #[test]
    fn a_click_glides_to_the_point_then_presses_and_releases_on_the_same_spot() {
        let s = click((10.0, 700.0), (900.0, 120.0), LEFT, 1);
        let p = pointers(&s);
        // Several mouse-moved reports with no button, each step small, the last exactly on the target.
        let moves: Vec<_> = p.iter().take_while(|e| e.2 == 0).collect();
        assert!(moves.len() >= 4, "glides in steps, not one jump: {moves:?}");
        let mut prev = (10.0, 700.0);
        for m in &moves {
            assert!(((m.0 - prev.0).powi(2) + (m.1 - prev.1).powi(2)).sqrt() < 120.0, "no big jump: {prev:?} -> {m:?}");
            prev = (m.0, m.1);
        }
        assert_eq!((moves.last().unwrap().0, moves.last().unwrap().1), (900.0, 120.0));
        // Then exactly: down at the target, up at the target, nothing else.
        assert_eq!(&p[moves.len()..], &[(900.0, 120.0, LEFT), (900.0, 120.0, 0)]);
        // A rest between arriving and pressing, a hold between down and up, no pointer motion in either.
        let down = s.iter().position(|e| matches!(e, Step::Pointer { buttons: 1, .. })).unwrap();
        assert_eq!(s[down - 1], Step::Wait(SETTLE_MS));
        assert_eq!(s[down + 1], Step::Wait(HOLD_MS));
        assert!(matches!(s[down + 2], Step::Pointer { x: 900.0, y: 120.0, buttons: 0 }));
        // Never a button held while the pointer moves.
        assert!(p.windows(2).all(|w| w[0].2 == 0 || (w[0].0, w[0].1) == (w[1].0, w[1].1)));
    }

    #[test]
    fn a_click_where_the_pointer_already_is_still_reports_it_there_first() {
        let p = pointers(&click((300.0, 300.0), (300.0, 300.0), LEFT, 1));
        assert_eq!(p, vec![(300.0, 300.0, 0), (300.0, 300.0, LEFT), (300.0, 300.0, 0)]);
    }

    #[test]
    fn double_and_right_clicks_repeat_on_the_spot() {
        let s = click((0.0, 0.0), (50.0, 60.0), LEFT, 2);
        let p = pointers(&s);
        let n = p.len();
        assert_eq!(&p[n - 4..], &[(50.0, 60.0, 1), (50.0, 60.0, 0), (50.0, 60.0, 1), (50.0, 60.0, 0)]);
        assert!(s.contains(&Step::Wait(MULTI_GAP_MS)));
        let r = pointers(&click((0.0, 0.0), (50.0, 60.0), RIGHT, 1));
        assert_eq!(&r[r.len() - 2..], &[(50.0, 60.0, RIGHT), (50.0, 60.0, 0)]);
        // count is clamped to 1..=3
        assert_eq!(pointers(&click((50.0, 60.0), (50.0, 60.0), LEFT, 9)).iter().filter(|e| e.2 == 1).count(), 3);
        assert_eq!(pointers(&click((50.0, 60.0), (50.0, 60.0), LEFT, 0)).iter().filter(|e| e.2 == 1).count(), 1);
    }

    #[test]
    fn only_a_drag_moves_with_the_button_held() {
        let s = drag((0.0, 0.0), (100.0, 100.0), (400.0, 100.0), 250.0);
        let p = pointers(&s);
        let first_down = p.iter().position(|e| e.2 == LEFT).unwrap();
        assert_eq!((p[first_down].0, p[first_down].1), (100.0, 100.0), "presses at the start, after gliding there");
        assert!(p[..first_down].iter().all(|e| e.2 == 0));
        let held: Vec<_> = p[first_down..].iter().take_while(|e| e.2 == LEFT).collect();
        assert!(held.len() > 4, "moves in steps while held");
        assert_eq!(*p.last().unwrap(), (400.0, 100.0, 0), "releases at the end");
        assert_eq!(*held.last().unwrap(), &(400.0, 100.0, LEFT));
    }

    #[test]
    fn a_shortcut_is_modifiers_down_key_down_up_modifiers_up_with_gaps() {
        let s = press("s", &["command", "shift"]).unwrap();
        let k = |n: &str, d| Step::Key { name: n.into(), down: d };
        assert_eq!(
            s,
            vec![
                k("command", true),
                Step::Wait(MOD_GAP_MS),
                k("shift", true),
                Step::Wait(MOD_GAP_MS),
                k("s", true),
                Step::Wait(HOLD_MS),
                k("s", false),
                Step::Wait(MOD_GAP_MS),
                k("shift", false),
                Step::Wait(MOD_GAP_MS),
                k("command", false),
                Step::Wait(TAIL_MS),
            ]
        );
        // Every gap is longer than a USB HID poll (8-10 ms), so no two transitions share a report.
        assert!(s.iter().all(|e| !matches!(e, Step::Wait(ms) if *ms < 20)));
        assert_eq!(press("escape", &[]).unwrap(), vec![k("escape", true), Step::Wait(HOLD_MS), k("escape", false), Step::Wait(TAIL_MS)]);
    }

    #[test]
    fn modifiers_are_normalized_and_unknown_ones_refused() {
        let s = press("z", &["cmd", "Command", "alt"]).unwrap();
        let downs: Vec<_> = s.iter().filter_map(|e| if let Step::Key { name, down: true } = e { Some(name.as_str()) } else { None }).collect();
        assert_eq!(downs, vec!["command", "option", "z"]);
        assert!(press("z", &["hyper"]).is_err(), "never sends a stray key for an unknown modifier");
        assert!(press(" ", &[]).is_err());
        assert_eq!(modifier_list(&json!(["command", 3, "shift"])), vec!["command", "shift"]);
        assert_eq!(modifier_list(&json!("command+shift")), vec!["command", "shift"]);
    }

    #[test]
    fn the_play_request_carries_every_step_in_order() {
        let r = request(&[Step::Pointer { x: 1.5, y: 2.0, buttons: 1 }, Step::Wait(30), Step::Key { name: "a".into(), down: true }]);
        assert_eq!(r, json!({ "cmd": "play", "steps": [{ "p": [1.5, 2.0, 1] }, { "w": 30 }, { "k": "a", "d": true }] }));
        assert!(duration(&click((0.0, 0.0), (800.0, 600.0), LEFT, 2)) < Duration::from_secs(1));
    }

    #[test]
    fn waits_for_the_focus_to_hold_still_before_a_key() {
        // A window coming back from the Dock: no window, then the window moving into place, then settled.
        let mut seq = vec![Some("Finder|||"), Some("App|window|Doc|[0,700,10,10]"), Some("App|window|Doc|[100,100,800,600]"), Some("App|window|Doc|[100,100,800,600]")].into_iter();
        let mut slept = Vec::new();
        let (ok, n) = wait_steady(|| seq.next().flatten(), |d| slept.push(d), Duration::from_millis(70), Duration::from_millis(1500));
        assert!(ok);
        assert_eq!(n, 4);
        assert_eq!(slept, vec![Duration::from_millis(70); 3]);
        // Already steady: two samples, one wait.
        let (ok, n) = wait_steady(|| Some(1), |_| {}, Duration::from_millis(70), Duration::from_millis(1500));
        assert!(ok && n == 2);
        // Never steady (or the agent can't answer): gives up at the cap, the key still goes.
        let mut i = 0;
        let (ok, n) = wait_steady(
            || {
                i += 1;
                Some(i)
            },
            |_| {},
            Duration::from_millis(100),
            Duration::from_millis(500),
        );
        assert!(!ok && n == 6);
        let (ok, _) = wait_steady(|| None::<u8>, |_| {}, Duration::from_millis(100), Duration::from_millis(300));
        assert!(!ok);
    }

    #[test]
    fn the_focus_print_is_the_app_and_its_focused_window() {
        let t = json!({ "nodes": [{ "role": "application", "label": "Viewer" }, { "role": "window", "label": "Scene", "frame": [0, 25, 800, 600] }] });
        assert_eq!(focus_print(&t).unwrap(), "Viewer|window|Scene|[0,25,800,600]");
        assert_eq!(focus_print(&json!({ "nodes": [{ "label": "Finder" }] })).unwrap(), "Finder|||null");
        assert!(focus_print(&json!({})).is_none());
    }

    /// A scripted guest: the fronts it reads in turn (the last repeats), who owns the point, what it did.
    struct Script {
        fronts: Vec<Option<Front>>,
        owner: Option<Owner>,
        activates: bool,
        log: Vec<String>,
    }

    impl Guest for Script {
        fn front(&mut self) -> Option<Front> {
            self.log.push("front".into());
            if self.fronts.len() > 1 { self.fronts.remove(0) } else { self.fronts[0].clone() }
        }
        fn owner(&mut self, _: (f64, f64)) -> Option<Owner> {
            self.log.push("owner".into());
            self.owner.clone()
        }
        fn activate(&mut self, o: &Owner) -> bool {
            self.log.push(format!("activate {}", o.app));
            self.activates
        }
        fn sleep(&mut self, d: Duration) {
            self.log.push(format!("sleep {}", d.as_millis()));
        }
    }

    fn app(id: &str, wins: &[([f64; 4], bool)]) -> Option<Front> {
        Some(Front { app: id.into(), name: id.rsplit('.').next().unwrap().into(), windows: wins.iter().map(|(f, k)| Win { frame: *f, key: *k }).collect() })
    }
    fn own(id: &str) -> Option<Owner> {
        Some(Owner { pid: 42, app: id.into(), name: id.rsplit('.').next().unwrap().into(), path: format!("/Apps/{id}.app") })
    }
    const W: [f64; 4] = [100.0, 100.0, 800.0, 600.0];
    const P: (f64, f64) = (400.0, 300.0);

    fn script(fronts: Vec<Option<Front>>, owner: Option<Owner>) -> Script {
        Script { fronts, owner, activates: true, log: Vec::new() }
    }

    #[test]
    fn a_click_on_the_key_window_of_the_front_app_is_just_a_click() {
        let mut g = script(vec![app("com.x.Davids", &[(W, true)])], own("com.x.Davids"));
        let mut known = HashMap::new();
        assert_eq!(before_click(&mut g, P, &mut known), BeforeClick::Plain);
        assert_eq!(g.log, vec!["front"], "one cheap look, no window lookup, no activation, no wait");
        assert_eq!(known.get("com.x.Davids"), Some(&true));
        assert_eq!(BeforeClick::Plain.note(), "");
        // The menu bar: never a window's click.
        let mut g = script(vec![app("com.x.Davids", &[])], own("com.x.Davids"));
        assert_eq!(before_click(&mut g, (300.0, 10.0), &mut known), BeforeClick::Plain);
        assert_eq!(g.log, vec!["front"]);
    }

    #[test]
    fn another_apps_window_under_the_point_is_brought_forward_and_waited_for_then_clicked() {
        // Just launched from a shell: Terminal is still the active app, Davids' window is on screen but not key.
        let mut g = script(
            vec![app("com.apple.Terminal", &[([0.0, 30.0, 300.0, 200.0], true)]), app("com.apple.Terminal", &[]), app("com.x.Davids", &[(W, false)]), app("com.x.Davids", &[(W, true)])],
            own("com.x.Davids"),
        );
        let mut known = HashMap::new();
        let r = before_click(&mut g, P, &mut known);
        assert_eq!(r, BeforeClick::Activated("Davids".into()));
        assert_eq!(g.log, vec!["front", "owner", "activate com.x.Davids", "front", "sleep 60", "front", "sleep 60", "front"]);
        assert!(r.note().contains("brought Davids forward"));
    }

    #[test]
    fn the_front_apps_window_still_coming_up_is_waited_for() {
        // Frontmost, but its window isn't key yet (it is still appearing): no activation, just the wait.
        let mut g = script(vec![app("com.x.Davids", &[]), app("com.x.Davids", &[(W, false)]), app("com.x.Davids", &[(W, true)])], own("com.x.Davids"));
        let mut known = HashMap::new();
        assert_eq!(before_click(&mut g, P, &mut known), BeforeClick::Waited);
        assert!(!g.log.iter().any(|l| l.starts_with("activate")));
        assert_eq!(BeforeClick::Waited.note(), "");
        // Some other window of the active app is key (a click on a panel or a second window): AppKit's own
        // business, no wait.
        let mut g = script(vec![app("com.x.Davids", &[([0.0, 30.0, 50.0, 50.0], true), (W, false)])], own("com.x.Davids"));
        assert_eq!(before_click(&mut g, P, &mut known), BeforeClick::Plain);
        assert_eq!(g.log, vec!["front", "owner"]);
    }

    #[test]
    fn a_window_that_never_becomes_key_is_clicked_anyway_and_said_so() {
        let mut g = script(vec![app("com.apple.Terminal", &[]), app("com.x.Davids", &[(W, false)])], own("com.x.Davids"));
        let mut known = HashMap::new();
        let r = before_click(&mut g, P, &mut known);
        assert_eq!(r, BeforeClick::NotKey("Davids".into()));
        assert!(r.note().contains("wasn't key yet") && r.note().contains("click again"), "{}", r.note());
        let sleeps = g.log.iter().filter(|l| l.starts_with("sleep")).count() as u128;
        assert_eq!(sleeps * KEY_POLL.as_millis(), KEY_WAIT.as_millis(), "waits at most the cap");
        // It never said a window was key: next time, a plain click with no wait.
        assert_eq!(known.get("com.x.Davids"), Some(&false));
        let mut g = script(vec![app("com.x.Davids", &[(W, false)])], own("com.x.Davids"));
        assert_eq!(before_click(&mut g, P, &mut known), BeforeClick::Plain);
        assert!(!g.log.iter().any(|l| l.starts_with("sleep")));
        // An activation refused (or timed out): no wait on top, the click goes, and says so.
        let mut g = script(vec![app("com.apple.Terminal", &[])], own("com.x.Other"));
        g.activates = false;
        assert_eq!(before_click(&mut g, P, &mut HashMap::new()), BeforeClick::NotKey("Other".into()));
        assert_eq!(g.log, vec!["front", "owner", "activate com.x.Other"]);
        // The agent stops answering mid-wait: stop polling.
        let mut g = script(vec![app("com.apple.Terminal", &[]), None], own("com.x.Davids"));
        assert_eq!(before_click(&mut g, P, &mut HashMap::new()), BeforeClick::NotKey("Davids".into()));
        assert_eq!(g.log, vec!["front", "owner", "activate com.x.Davids", "front"]);
    }

    #[test]
    fn an_old_or_unpermitted_agent_or_no_window_there_gives_todays_plain_click() {
        // No tree (an old agent, no Accessibility): today's click.
        let mut g = script(vec![None], own("com.x.Davids"));
        assert_eq!(before_click(&mut g, P, &mut HashMap::new()), BeforeClick::Plain);
        assert_eq!(g.log, vec!["front"]);
        // The window lookup isn't possible, or nothing is there (the desktop, the Dock): today's click.
        let mut g = script(vec![app("com.apple.finder", &[])], None);
        assert_eq!(before_click(&mut g, P, &mut HashMap::new()), BeforeClick::Plain);
        assert_eq!(g.log, vec!["front", "owner"]);
        // What the agent and the script print.
        assert!(front(&json!({})).is_none());
        assert!(front(&json!({ "nodes": [{ "role": "window" }] })).is_none());
        assert!(owner(&json!({})).is_none());
        let f = front(&json!({ "nodes": [
            { "role": "application", "label": "Davids", "identifier": "com.x.Davids", "depth": 0 },
            { "role": "window", "label": "Scene", "frame": [100, 100, 800, 600], "depth": 1, "focused": true },
            { "role": "button", "frame": [110, 110, 20, 20], "depth": 2, "focused": true },
            { "role": "window", "frame": [0, 0, 0, 0], "depth": 1 }
        ] }))
        .unwrap();
        assert_eq!(f, Front { app: "com.x.Davids".into(), name: "Davids".into(), windows: vec![Win { frame: W, key: true }] });
        let o = owner(&json!({ "pid": 7, "name": "davids", "bundle": "", "path": "", "frame": [0, 0, 1, 1] })).unwrap();
        assert_eq!((o.app.as_str(), o.path.as_str()), ("davids", ""), "a bare executable goes by its name");
    }

    #[test]
    fn a_key_waits_for_a_window_that_is_on_screen_but_not_key_yet_when_the_app_says_so() {
        let t = |key: bool| json!({ "nodes": [{ "role": "application", "label": "Davids", "identifier": "com.x.Davids" }, { "role": "window", "label": "Scene", "frame": [100, 100, 800, 600], "depth": 1, "focused": key }] });
        let mut known = HashMap::new();
        // Never heard from: stability alone, as before.
        assert!(key_print(&t(false), &known).is_some());
        learn(&mut known, &front(&t(true)).unwrap());
        assert!(key_print(&t(false), &known).is_none(), "un-hidden, not key yet: not ready");
        assert_eq!(key_print(&t(true), &known), focus_print(&t(true)));
        // No window at all (Finder on an empty desktop): nothing to wait for.
        let none = json!({ "nodes": [{ "role": "application", "label": "Finder", "identifier": "com.apple.finder" }] });
        known.insert("com.apple.finder".into(), true);
        assert!(key_print(&none, &known).is_some());
    }

    #[test]
    fn the_guest_commands_quote_safely() {
        let c = owner_command((400.4, 299.6));
        assert!(c.starts_with("/usr/bin/osascript -l JavaScript -e '") && c.ends_with("' 400 300"), "{c}");
        assert_eq!(c.matches('\'').count(), 2, "the script itself has no single quote");
        assert!(activate_command(42).ends_with("' 42"));
        assert_eq!(activate_command(42).matches('\'').count(), 2);
    }
}
