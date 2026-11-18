//! The pilot's drivers: the chat's iPhone (the simulator helper) and its Browser panel (the `browser_*` machinery).

use super::{Action, Driver, Elem, Goal, Kind, Screen, Verb};
use crate::device::observe::{self, Tree};
use crate::device::web::{Browser, Snap};
use crate::device::{Activity, Devices, simctl};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

// ---------- iPhone ----------

/// The keyboard's top edge as a share of the screen height while a text field has focus (iPhone, portrait, with the
/// suggestion bar). Elements below it are covered.
const KEYBOARD_TOP: f64 = 0.55;

/// The pilot's view of an accessibility tree (see [`observe::parse`]).
pub fn iphone_screen(t: &Tree) -> Screen {
    let (w, h) = (if t.w > 0.0 { t.w } else { 402.0 }, if t.h > 0.0 { t.h } else { 874.0 });
    let mut elems = Vec::new();
    for n in &t.nodes {
        let [x, y, fw, fh] = n.frame;
        // Wholly or partly beside the screen (a pushed screen's predecessor stays in the tree, shifted left).
        let offscreen = x < -2.0 || x + fw > w + 2.0 || y + fh <= 0.0 || y >= h || n.flags.contains(&"offscreen");
        let label = n.label.clone().or_else(|| n.placeholder.clone()).unwrap_or_default();
        let kind = match n.role.as_str() {
            "textfield" | "textarea" => Kind::Input,
            "button" | "link" | "checkbox" | "radio" | "popup" | "tabs" | "image" | "element" | "cell" => Kind::Tap,
            // A full-width text row (a list's cell) can be tapped; other text is read.
            "text" if fw >= w * 0.6 && fh <= 120.0 => Kind::Tap,
            "text" | "heading" => Kind::Text,
            _ => continue,
        };
        if label.is_empty() && kind != Kind::Input {
            continue;
        }
        let value = n.value.clone().filter(|v| Some(v) != n.placeholder.as_ref());
        elems.push(Elem {
            handle: n.id.clone(),
            role: n.role.clone(),
            label,
            value,
            frame: n.frame,
            kind,
            disabled: n.flags.contains(&"disabled"),
            selected: n.flags.contains(&"selected"),
            focused: n.flags.contains(&"focused"),
            offscreen,
        });
    }
    // SpringBoard is in front with no name: its alert (texts and buttons, no identifiers) or the home screen.
    let springboard = t.app.trim().is_empty();
    let alert = springboard && t.nodes.iter().all(|n| n.identifier.is_none()) && t.nodes.iter().any(|n| n.role == "button") && t.nodes.iter().any(|n| n.role == "text");
    if alert {
        // An alert's text is its message, not a row.
        for e in elems.iter_mut().filter(|e| e.role == "text") {
            e.kind = Kind::Text;
        }
    }
    Screen {
        app: t.app.trim().to_string(),
        url: None,
        keyboard: elems.iter().any(|e| e.kind == Kind::Input && e.focused),
        elems,
        texts: Vec::new(),
        alert,
        home: springboard && !alert,
        w,
        h,
    }
}

pub struct Iphone<'a> {
    pub devices: &'a Devices,
    pub chat: usize,
    pub udid: String,
}

impl Iphone<'_> {
    fn helper(&self) -> Result<std::sync::Arc<crate::device::helper::Helper>, String> {
        self.devices.helper(&self.udid)
    }

    fn activity(&self, kind: &'static str, at: Option<(f64, f64)>, to: Option<(f64, f64)>, label: Option<String>) {
        self.devices.activity(Activity {
            udid: self.udid.clone(),
            chat: Some(self.chat),
            source: "agent",
            kind,
            x: at.map(|p| p.0),
            y: at.map(|p| p.1),
            x2: to.map(|p| p.0),
            y2: to.map(|p| p.1),
            label,
        });
    }

    fn tree(&self) -> Result<Tree, String> {
        let until = Instant::now() + Duration::from_secs(12);
        loop {
            // Only what can be on screen: off-screen subtrees (long lists) aren't walked.
            match self.helper()?.call(json!({ "cmd": "describe", "max": 400, "visibleOnly": true }), Duration::from_secs(10)) {
                Ok(d) => return Ok(observe::parse(&d)),
                Err(e) if e.contains("no frontmost application") && Instant::now() < until => std::thread::sleep(Duration::from_millis(400)),
                Err(e) => return Err(e),
            }
        }
    }

    fn idle(&self, quiet: u64, first: u64, timeout: u64) -> u64 {
        let t = Instant::now();
        let _ = self.helper().and_then(|h| h.call(json!({ "cmd": "idle", "quietMs": quiet, "quietFrames": 2, "firstMs": first, "timeoutMs": timeout }), Duration::from_millis(timeout + 3000)));
        t.elapsed().as_millis() as u64
    }

    fn tap_at(&self, (x, y): (f64, f64), label: &str) -> Result<(), String> {
        self.activity("tap", Some((x, y)), None, Some(label.to_string()));
        self.helper()?.call(json!({ "cmd": "tap", "x": x, "y": y }), Duration::from_secs(15)).map(|_| ())
    }

    fn swipe(&self, from: (f64, f64), to: (f64, f64), ms: f64) -> Result<(), String> {
        self.activity("swipe", Some(from), Some(to), None);
        self.helper()?.call(json!({ "cmd": "swipe", "x1": from.0, "y1": from.1, "x2": to.0, "y2": to.1, "ms": ms }), Duration::from_secs(15)).map(|_| ())
    }

    fn key(&self, name: &str, modifiers: Value) -> Result<(), String> {
        self.helper()?.call(json!({ "cmd": "key", "name": name, "modifiers": modifiers }), Duration::from_secs(5)).map(|_| ())
    }

    /// The visible part's centre.
    fn center(e: &Elem, s: &Screen) -> (f64, f64) {
        let [x, y, w, h] = e.frame;
        let (x0, y0, x1, y1) = (x.max(0.0), y.max(0.0), (x + w).min(s.w), (y + h).min(s.h));
        if x1 > x0 && y1 > y0 { ((x0 + x1) / 2.0, (y0 + y1) / 2.0) } else { (x + w / 2.0, y + h / 2.0) }
    }

    /// Where to tap `e`: when the keyboard covers it, scroll it up into view first (then find it again).
    fn reach(&self, e: &Elem, s: &Screen) -> Result<(f64, f64), String> {
        let c = Self::center(e, s);
        let top = s.h * KEYBOARD_TOP;
        if !s.keyboard || e.focused || c.1 < top - 10.0 {
            return Ok(c);
        }
        let dy = (c.1 - top + 120.0).clamp(80.0, top - 160.0);
        let from = (s.w / 2.0, top - 40.0);
        self.swipe(from, (from.0, from.1 - dy), 300.0)?;
        self.idle(150, 200, 1500);
        let now = iphone_screen(&self.tree()?);
        let again = now.elems.iter().find(|n| n.role == e.role && n.label == e.label && !n.offscreen);
        Ok(again.map(|n| Self::center(n, &now)).unwrap_or(c))
    }
}

impl Driver for Iphone<'_> {
    fn start(&mut self, goal: &Goal) -> Result<String, String> {
        self.activity("app", None, None, Some("pilot".into()));
        let Some(app) = &goal.app else { return Ok(String::new()) };
        // A fresh launch, so the run starts where the app starts.
        let t = Instant::now();
        simctl::launch(&self.udid, app)?;
        let launch_ms = t.elapsed().as_millis();
        // Until the app is in front with its first screen built (two reads alike). Its accessibility answers only
        // a second or two after launch (the status bar until then), and the first full read is the slowest.
        let until = Instant::now() + Duration::from_secs(8);
        let mut prev = String::new();
        while Instant::now() < until {
            let s = iphone_screen(&self.tree()?);
            let sig = super::signature(&s);
            if !s.home && !s.elems.is_empty() && sig == prev {
                break;
            }
            prev = sig;
            std::thread::sleep(Duration::from_millis(150));
        }
        Ok(format!("launched {app} (simctl {launch_ms} ms, its first screen ready after {} ms)", t.elapsed().as_millis()))
    }

    fn perceive(&mut self) -> Result<(Screen, u64), String> {
        let t = Instant::now();
        let tree = self.tree()?;
        let ms = t.elapsed().as_millis() as u64;
        let s = iphone_screen(&tree);
        // The caller's own tools (tap by id, …) see what the pilot saw last.
        self.devices.mcp.remember(self.chat, tree, &self.devices.name(&self.udid));
        Ok((s, ms))
    }

    fn act(&mut self, a: &Action, s: &Screen, inputs: &BTreeMap<String, String>) -> Result<String, String> {
        let elem = |a: &Action| a.target.as_ref().and_then(|t| s.elems.iter().find(|e| e.handle == t.id)).ok_or("the element is gone");
        match a.verb {
            Verb::Tap => {
                let e = elem(a)?;
                let p = self.reach(e, s)?;
                self.tap_at(p, &e.label)?;
                Ok(format!("tapped {:?} at ({:.0},{:.0})", e.label, p.0, p.1))
            }
            Verb::SetText => {
                let e = elem(a)?;
                let key = a.input_key.as_deref().unwrap_or("");
                let text = inputs.get(key).ok_or_else(|| format!("no input {key:?}"))?;
                let p = self.reach(e, s)?;
                if !e.focused {
                    self.tap_at(p, &e.label)?;
                    self.idle(80, 0, 800);
                }
                // Replace, never append: select all and delete what the field holds first.
                if e.value.as_deref().is_some_and(|v| !v.is_empty()) {
                    self.key("a", json!(["command"]))?;
                    self.key("backspace", Value::Null)?;
                }
                self.activity("type", None, None, Some(text.chars().take(40).collect()));
                crate::device::type_text(self.devices, &self.udid, text)?;
                Ok(format!("set {:?} to <{key}>", e.label))
            }
            Verb::Submit => {
                self.activity("press", None, None, Some("return".into()));
                self.key("return", Value::Null)?;
                Ok("pressed return".into())
            }
            Verb::Scroll => {
                let down = a.dir != Some("up");
                let (top, bottom) = if s.keyboard { (s.h * 0.15, s.h * KEYBOARD_TOP - 30.0) } else { (s.h * 0.25, s.h * 0.75) };
                let x = s.w / 2.0;
                let (from, to) = if down { ((x, bottom), (x, top)) } else { ((x, top), (x, bottom)) };
                self.swipe(from, to, 300.0)?;
                Ok(format!("scrolled {}", if down { "down" } else { "up" }))
            }
            Verb::Back => {
                // The navigation bar's back button when there is one, else the edge swipe.
                if let Some(b) = s.elems.iter().find(|e| e.role == "button" && !e.offscreen && e.frame[1] < s.h * 0.15 && e.frame[0] < 40.0) {
                    let p = Self::center(b, s);
                    self.tap_at(p, &b.label)?;
                    return Ok(format!("tapped back ({:?})", b.label));
                }
                self.swipe((2.0, s.h / 2.0), (s.w * 0.8, s.h / 2.0), 200.0)?;
                Ok("swiped back from the left edge".into())
            }
            Verb::Done | Verb::Stuck => Ok(String::new()),
        }
    }

    fn settle(&mut self, after: Verb) -> u64 {
        // The frame stream: wait for the screen to start changing (an app can take a moment to react), then for
        // 150 ms without a new frame.
        let first = match after {
            Verb::Tap | Verb::Back | Verb::Submit => 500,
            Verb::Scroll => 200,
            _ => 100,
        };
        self.idle(150, first, 2500)
    }

    fn settle_again(&mut self) -> u64 {
        self.idle(150, 400, 1500)
    }

    fn finish(&mut self) {
        self.activity("end", None, None, None);
    }
}

// ---------- Browser ----------

/// The pilot's view of a page snapshot.
pub fn browser_screen(s: &Snap) -> Screen {
    let mut elems = Vec::new();
    for e in &s.els {
        let kind = match e.role.as_str() {
            "textbox" | "searchbox" | "spinbutton" => Kind::Input,
            "heading" => Kind::Text,
            "slider" | "file" | "color" | "frame" | "listbox" | "combobox" => continue,
            _ => Kind::Tap,
        };
        let label = if e.name.is_empty() { e.ph.clone().unwrap_or_default() } else { e.name.clone() };
        let value = if e.pw {
            e.filled.then(|| "•".to_string())
        } else if let Some(Value::Bool(c)) = &e.checked {
            Some(if *c { "checked" } else { "unchecked" }.to_string())
        } else {
            e.value.clone()
        };
        elems.push(Elem {
            handle: e.id.to_string(),
            role: e.role.clone(),
            label,
            value,
            frame: [e.x, e.y, e.w, e.h],
            kind,
            disabled: e.disabled,
            selected: matches!(e.selected, Some(Value::Bool(true))) || matches!(e.pressed, Some(Value::Bool(true))),
            focused: e.focused,
            offscreen: e.off,
        });
    }
    let texts = s.text.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).take(60).collect();
    Screen {
        app: s.title.clone(),
        url: Some(s.url.clone()),
        keyboard: elems.iter().any(|e| e.kind == Kind::Input && e.focused),
        elems,
        texts,
        alert: false,
        home: false,
        w: s.vw,
        h: s.vh,
    }
}

pub struct Web<'a> {
    pub b: Browser<'a>,
}

impl Driver for Web<'_> {
    fn start(&mut self, goal: &Goal) -> Result<String, String> {
        match &goal.url {
            Some(u) => {
                self.b.pilot_navigate(u)?;
                Ok(format!("opened {u}"))
            }
            None => {
                self.b.pilot_activity("pilot");
                Ok(String::new())
            }
        }
    }

    fn perceive(&mut self) -> Result<(Screen, u64), String> {
        let t = Instant::now();
        let (snap, _) = self.b.pilot_snapshot()?;
        Ok((browser_screen(&snap), t.elapsed().as_millis() as u64))
    }

    fn act(&mut self, a: &Action, _s: &Screen, inputs: &BTreeMap<String, String>) -> Result<String, String> {
        let id = || a.target.as_ref().map(|t| t.id.clone()).ok_or("no element");
        match a.verb {
            Verb::Tap => self.b.pilot_act("browser_click", &json!({ "id": id()? })),
            Verb::SetText => {
                let key = a.input_key.as_deref().unwrap_or("");
                let text = inputs.get(key).ok_or_else(|| format!("no input {key:?}"))?;
                // browser_type replaces the field's contents.
                self.b.pilot_act("browser_type", &json!({ "id": id()?, "text": text })).map(|_| format!("set {:?} to <{key}>", a.target.as_ref().map(|t| t.label.as_str()).unwrap_or("")))
            }
            Verb::Submit => self.b.pilot_act("browser_press", &json!({ "key": "Enter" })),
            Verb::Scroll => self.b.pilot_act("browser_scroll", &json!({ "direction": a.dir.unwrap_or("down") })),
            Verb::Back => self.b.pilot_back().map(|ms| format!("went back ({ms} ms)")),
            Verb::Done | Verb::Stuck => Ok(String::new()),
        }
    }

    fn settle(&mut self, after: Verb) -> u64 {
        // The DOM-quiet settle of the browser tools.
        self.b.pilot_settle(if after == Verb::Back { 3000 } else { 1500 })
    }

    fn finish(&mut self) {
        self.b.pilot_activity("end");
    }
}
