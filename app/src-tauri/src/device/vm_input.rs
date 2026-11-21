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
}
