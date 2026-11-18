//! The device pilot (APP_SPEC "Device pilot"): a fast System-1 loop behind the `pilot_run` tool of `coool-device`.
//! The calling agent hands over a routine multi-step goal ("Settings → General → About, read the version") with
//! checkable success conditions; the pilot drives the chat's iPhone or Browser panel to it and returns once the
//! checks hold (`done`), or `stuck` / `surprised` / `out_of_budget` with what it saw.
//!
//! Each step: perceive (the screen as typed elements), check the success conditions, build typed candidate actions
//! with numeric ids ([`candidates`]), decide, act, then wait for the screen to settle. Decisions go through one
//! cascade ([`run`]):
//! 1. muscle memory ([`memory`]): (goal, exact screen signature, previous action) → action, learned per project from
//!    runs that ended verified `done`, replayed only on an exact match and never twice on an unchanged screen;
//! 2. Claude Haiku ([`haiku`]): one forced-choice tool call that names a candidate id (skipped without an API key);
//! 3. otherwise the run returns `stuck` (or `surprised`) with the candidates, so the calling agent decides.
//!
//! The pilot never invents text: `set_text` types a value from the goal's `inputs`, by key, and replaces what the
//! field held. Drivers ([`drivers`]) do the device work: the iPhone through the simulator helper (frame-stream
//! settle, accessibility tree), the Browser panel through the `browser_*` machinery (DOM-quiet settle).

pub mod drivers;
pub mod haiku;
pub mod memory;

use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::time::{Duration, Instant};

// ---------- the goal ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    Iphone,
    Browser,
}

/// A condition the pilot checks on the screen after every step; all of them holding is `done`.
#[derive(Clone, Debug, PartialEq)]
pub enum Check {
    /// Some element or visible text contains this (case-insensitive).
    TextVisible(String),
    /// No element or visible text contains this.
    TextGone(String),
    /// An element whose label contains `label` (and, if given, whose value or label contains `value`).
    Element { label: String, value: Option<String> },
    /// The page's URL contains this (browser).
    UrlMatches(String),
}

impl Check {
    pub fn parse(v: &Value) -> Result<Check, String> {
        let s = |k: &str| v[k].as_str().map(str::to_string).filter(|s| !s.trim().is_empty());
        if let Some(t) = s("text_visible") {
            return Ok(Check::TextVisible(t));
        }
        if let Some(t) = s("text_gone") {
            return Ok(Check::TextGone(t));
        }
        if let Some(u) = s("url_matches") {
            return Ok(Check::UrlMatches(u));
        }
        if let Some(e) = v.get("element").filter(|e| e.is_object()) {
            let label = e["label"].as_str().filter(|l| !l.trim().is_empty()).ok_or("an `element` check needs `label`")?;
            return Ok(Check::Element { label: label.to_string(), value: e["value"].as_str().map(str::to_string) });
        }
        Err(format!("unknown success check {v}: use {{\"text_visible\":…}}, {{\"text_gone\":…}}, {{\"element\":{{\"label\":…,\"value\"?:…}}}} or {{\"url_matches\":…}}"))
    }

    pub fn holds(&self, s: &Screen) -> bool {
        match self {
            Check::TextVisible(t) => s.mentions(t),
            Check::TextGone(t) => !s.mentions(t),
            Check::UrlMatches(u) => s.url.as_deref().is_some_and(|x| x.contains(u.as_str())),
            Check::Element { label, value } => s.elems.iter().any(|e| {
                contains(&e.label, label)
                    && value.as_deref().is_none_or(|v| e.value.as_deref().is_some_and(|ev| contains(ev, v)) || contains(&e.label, v))
            }),
        }
    }

    pub fn describe(&self) -> String {
        match self {
            Check::TextVisible(t) => format!("text {t:?} visible"),
            Check::TextGone(t) => format!("text {t:?} gone"),
            Check::UrlMatches(u) => format!("URL contains {u:?}"),
            Check::Element { label, value: Some(v) } => format!("element {label:?} with value {v:?}"),
            Check::Element { label, value: None } => format!("element {label:?}"),
        }
    }
}

fn contains(hay: &str, needle: &str) -> bool {
    hay.to_lowercase().contains(&needle.to_lowercase())
}

#[derive(Clone, Debug)]
pub struct Goal {
    pub goal: String,
    pub target: Target,
    /// iPhone: a bundle id launched (fresh) before the first step.
    pub app: Option<String>,
    /// Browser: a URL opened before the first step.
    pub url: Option<String>,
    pub inputs: BTreeMap<String, String>,
    pub success: Vec<Check>,
    pub max_steps: usize,
    pub budget: Duration,
    /// May answer system alerts (otherwise an alert the pilot hasn't learned is `surprised`).
    pub alerts: bool,
}

impl Goal {
    pub fn parse(a: &Value) -> Result<Goal, String> {
        let goal = a["goal"].as_str().map(str::trim).filter(|g| !g.is_empty()).ok_or("pilot_run needs `goal`")?.to_string();
        let target = match a["target"].as_str().unwrap_or("iphone") {
            "iphone" => Target::Iphone,
            "browser" => Target::Browser,
            t => return Err(format!("target is \"iphone\" or \"browser\", not {t:?}")),
        };
        let mut inputs = BTreeMap::new();
        if let Some(m) = a["inputs"].as_object() {
            for (k, v) in m {
                let v = match v {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    Value::Bool(b) => b.to_string(),
                    _ => return Err(format!("input {k:?} must be a string")),
                };
                inputs.insert(k.clone(), v);
            }
        }
        let success = a["success"].as_array().map(|v| v.iter().map(Check::parse).collect::<Result<Vec<_>, _>>()).transpose()?.unwrap_or_default();
        Ok(Goal {
            goal,
            target,
            app: a["app"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
            url: a["url"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
            inputs,
            success,
            max_steps: a["max_steps"].as_u64().unwrap_or(15).clamp(1, 60) as usize,
            budget: Duration::from_millis(a["budget_ms"].as_u64().unwrap_or(90_000).clamp(2_000, 600_000)),
            alerts: a["answer_alerts"].as_bool() == Some(true),
        })
    }

    /// What muscle memory keys on: the goal's words, the target and app, the input names (not their values).
    pub fn memory_key(&self) -> String {
        let words = self.goal.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
        let keys = self.inputs.keys().cloned().collect::<Vec<_>>().join(",");
        format!("{:?}|{}|{}|{words}|{keys}", self.target, self.app.as_deref().unwrap_or(""), self.url.as_deref().unwrap_or(""))
    }
}

// ---------- the screen ----------

/// One element of the screen, as the pilot sees it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Elem {
    /// The driver's own reference (iPhone: the observe id; browser: the element id).
    pub handle: String,
    pub role: String,
    pub label: String,
    pub value: Option<String>,
    /// x, y, w, h (points / CSS px).
    pub frame: [f64; 4],
    pub kind: Kind,
    pub disabled: bool,
    pub selected: bool,
    pub focused: bool,
    /// Listed, but outside the visible area (scroll first).
    pub offscreen: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Kind {
    /// Tappable (button, link, row, …).
    #[default]
    Tap,
    /// A text field.
    Input,
    /// Text only.
    Text,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Screen {
    /// The app's name (iPhone) or the page's title (browser).
    pub app: String,
    pub url: Option<String>,
    pub elems: Vec<Elem>,
    /// Text that is not an element (browser: the text in view).
    pub texts: Vec<String>,
    /// A text field has focus (the keyboard is up).
    pub keyboard: bool,
    /// A system alert covers the app (iPhone: SpringBoard's own alert).
    pub alert: bool,
    /// The home screen (iPhone), no app in front.
    pub home: bool,
    pub w: f64,
    pub h: f64,
}

impl Screen {
    pub fn mentions(&self, t: &str) -> bool {
        self.elems.iter().any(|e| contains(&e.label, t) || e.value.as_deref().is_some_and(|v| contains(v, t))) || self.texts.iter().any(|x| contains(x, t))
    }

    /// Short text for the calling agent: where it is and what's on screen.
    pub fn summary(&self, max: usize) -> String {
        let mut s = String::new();
        let place = if self.alert {
            "a system alert".to_string()
        } else if self.home {
            "the home screen".to_string()
        } else {
            format!("{:?}", self.app)
        };
        let _ = write!(s, "{place}");
        if let Some(u) = &self.url {
            let _ = write!(s, " — {u}");
        }
        s.push('\n');
        for e in self.elems.iter().filter(|e| !e.offscreen).take(max) {
            let _ = write!(s, "  {} {:?}", e.role, e.label);
            if let Some(v) = e.value.as_deref().filter(|v| *v != e.label) {
                let _ = write!(s, " = {v:?}");
            }
            if e.selected {
                s.push_str(" (selected)");
            }
            if e.focused {
                s.push_str(" (focused)");
            }
            s.push('\n');
        }
        let text: String = self.texts.iter().take(12).map(|t| t.chars().take(160).collect::<String>()).collect::<Vec<_>>().join(" | ");
        if !text.is_empty() {
            let _ = writeln!(s, "  text: {text}");
        }
        s
    }
}

/// A stable fingerprint of what the screen offers: app, then each element's kind, role, label and state (values of
/// toggles and other non-text elements, but for text fields only filled / empty, since typed values vary between
/// runs), then the visible text that isn't an element. Positions are left out, so a scroll by a few points doesn't change it.
pub fn signature(s: &Screen) -> String {
    let mut parts: Vec<String> = s
        .elems
        .iter()
        .filter(|e| !e.offscreen)
        .map(|e| {
            let state = match e.kind {
                Kind::Input => if e.value.as_deref().is_some_and(|v| !v.is_empty()) { "filled" } else { "empty" }.to_string(),
                _ => e.value.clone().unwrap_or_default(),
            };
            format!("{:?}|{}|{}|{}|{}", e.kind, e.role, e.label, state, if e.selected { "sel" } else { "" })
        })
        .collect();
    parts.sort();
    // The page's own text too (a counter, a confirmation): what a step changed even when no element did.
    let text = s.texts.iter().take(40).cloned().collect::<Vec<_>>().join("\n");
    let all = format!("{}|{}|{}|{}|{text}", s.app, s.alert, s.keyboard, parts.join("\n"));
    format!("{:016x}", fnv(&all))
}

pub fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
}

// ---------- actions ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verb {
    Tap,
    SetText,
    Submit,
    Scroll,
    Back,
    Done,
    Stuck,
}

impl Verb {
    pub fn name(self) -> &'static str {
        match self {
            Verb::Tap => "tap",
            Verb::SetText => "set_text",
            Verb::Submit => "submit",
            Verb::Scroll => "scroll",
            Verb::Back => "back",
            Verb::Done => "done",
            Verb::Stuck => "stuck",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ActTarget {
    pub role: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub frame: [f64; 4],
    /// The element's id for the device tools (`tap` / `browser_click`), so the caller can act on it itself.
    pub id: String,
}

/// One candidate action: `{id, verb, target, input_key?}` (+ `dir` for scroll).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Action {
    pub id: usize,
    pub verb: Verb,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<ActTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<&'static str>,
}

impl Action {
    fn new(verb: Verb) -> Self {
        Action { id: 0, verb, target: None, input_key: None, dir: None }
    }

    /// Coordinate-free identity, for muscle memory: the same action on another run of the same screen.
    pub fn key(&self) -> String {
        let t = self.target.as_ref().map(|t| format!("{}|{}", t.role, t.label)).unwrap_or_default();
        format!("{}|{t}|{}|{}", self.verb.name(), self.input_key.as_deref().unwrap_or(""), self.dir.unwrap_or(""))
    }

    /// One line for the model and the log: `tap button "General"`.
    pub fn describe(&self) -> String {
        let t = |t: &ActTarget| {
            let mut s = format!("{} {:?}", t.role, t.label);
            if let Some(v) = t.value.as_deref().filter(|v| !v.is_empty() && *v != t.label) {
                let _ = write!(s, " (value {v:?})");
            }
            s
        };
        match (self.verb, &self.target) {
            (Verb::Tap, Some(x)) => format!("tap {}", t(x)),
            (Verb::SetText, Some(x)) => format!("set_text <{}> into {}", self.input_key.as_deref().unwrap_or("?"), t(x)),
            (Verb::Submit, _) => "submit: press the keyboard's Return / Go key".into(),
            (Verb::Scroll, _) => format!("scroll {}", self.dir.unwrap_or("down")),
            (Verb::Back, _) => "back: go back one screen / page".into(),
            (Verb::Done, _) => "done: the goal is achieved on this screen".into(),
            (Verb::Stuck, _) => "stuck: no action here makes progress".into(),
            (v, None) => v.name().into(),
        }
    }
}

/// At most this many element actions per screen (the model reads them all each step).
const MAX_ELEMENT_ACTIONS: usize = 40;

/// The typed candidate set for a screen: taps on what can be tapped, `set_text <key>` per text field and input key,
/// `submit` while typing, scrolls, `back`, then `done` and `stuck`. Ids are positions in the list. On a system alert
/// only its buttons (and done / stuck) are offered.
pub fn candidates(s: &Screen, inputs: &BTreeMap<String, String>, target: Target) -> Vec<Action> {
    let mut out = Vec::new();
    let visible: Vec<&Elem> = s.elems.iter().filter(|e| !e.offscreen && !e.disabled).collect();
    let mut n = 0;
    for e in &visible {
        if n >= MAX_ELEMENT_ACTIONS {
            break;
        }
        let t = ActTarget { role: e.role.clone(), label: e.label.clone(), value: e.value.clone(), frame: e.frame, id: e.handle.clone() };
        match e.kind {
            Kind::Tap if !e.label.is_empty() => {
                let mut a = Action::new(Verb::Tap);
                a.target = Some(t);
                out.push(a);
                n += 1;
            }
            Kind::Input if !s.alert => {
                if inputs.is_empty() {
                    // Nothing to type: the field can still be tapped (to focus it, say).
                    let mut a = Action::new(Verb::Tap);
                    a.target = Some(t.clone());
                    out.push(a);
                    n += 1;
                }
                for k in inputs.keys() {
                    let mut a = Action::new(Verb::SetText);
                    a.target = Some(t.clone());
                    a.input_key = Some(k.clone());
                    out.push(a);
                    n += 1;
                }
            }
            _ => {}
        }
    }
    if !s.alert {
        if s.keyboard {
            out.push(Action::new(Verb::Submit));
        }
        for d in ["down", "up"] {
            let mut a = Action::new(Verb::Scroll);
            a.dir = Some(d);
            out.push(a);
        }
        if target == Target::Browser || !s.home {
            out.push(Action::new(Verb::Back));
        }
    }
    out.push(Action::new(Verb::Done));
    out.push(Action::new(Verb::Stuck));
    for (i, a) in out.iter_mut().enumerate() {
        a.id = i;
    }
    out
}

/// The screen and its candidates as the model reads them.
pub fn render_for_model(s: &Screen, cands: &[Action]) -> String {
    let mut o = String::new();
    let place = if s.alert {
        "A system alert is showing".to_string()
    } else if s.home {
        "Home screen".to_string()
    } else {
        format!("App/page: {:?}", s.app)
    };
    let _ = writeln!(o, "{place}{}{}", s.url.as_deref().map(|u| format!(" — {u}")).unwrap_or_default(), if s.keyboard { " (keyboard is up)" } else { "" });
    let texts: Vec<String> = s
        .elems
        .iter()
        .filter(|e| e.kind == Kind::Text && !e.offscreen)
        .map(|e| e.label.clone())
        .chain(s.texts.iter().cloned())
        .map(|t| t.chars().take(160).collect())
        .take(25)
        .collect();
    if !texts.is_empty() {
        let _ = writeln!(o, "Visible text: {}", texts.join(" | "));
    }
    o.push_str("Actions:\n");
    for a in cands {
        let _ = writeln!(o, "[{}] {}", a.id, a.describe());
    }
    o
}

// ---------- the loop ----------

/// What a driver does on its device.
pub trait Driver {
    /// Launches the app / opens the URL of the goal, if any (then settles).
    fn start(&mut self, goal: &Goal) -> Result<String, String>;
    /// The screen now, and how long reading it took (ms).
    fn perceive(&mut self) -> Result<(Screen, u64), String>;
    /// Performs the action (`set_text` types `inputs[key]`, replacing the field's contents): a short note.
    fn act(&mut self, a: &Action, screen: &Screen, inputs: &BTreeMap<String, String>) -> Result<String, String>;
    /// Waits for the screen to settle after an action (ms).
    fn settle(&mut self, after: Verb) -> u64;
    /// Once more, when the screen looked unchanged right after settling (a slow app): ms.
    fn settle_again(&mut self) -> u64 {
        0
    }
    /// The run ended (indicators off).
    fn finish(&mut self) {}
}

/// Picks a candidate id for a screen (Haiku, or a scripted one in tests).
pub trait Decider {
    fn decide(&mut self, req: &DecideRequest) -> Result<Decision, String>;
    fn name(&self) -> &'static str;
}

pub struct DecideRequest<'a> {
    pub goal: &'a Goal,
    pub history: &'a [String],
    pub screen: &'a Screen,
    pub candidates: &'a [Action],
}

#[derive(Clone, Debug, Default)]
pub struct Decision {
    pub id: usize,
    pub ms: u64,
    pub usd: f64,
    pub input_tokens: u64,
    pub cached_tokens: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Done,
    Stuck,
    Surprised,
    OutOfBudget,
}

#[derive(Clone, Debug, Serialize)]
pub struct Step {
    pub n: usize,
    /// `memory`, `haiku`, `checks` (the success checks held) or `none`.
    pub decider: &'static str,
    pub action: String,
    pub verb: Verb,
    pub perceive_ms: u64,
    pub decide_ms: u64,
    pub act_ms: u64,
    pub settle_ms: u64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub note: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Outcome {
    pub status: Status,
    /// `done` with every success check holding on the final screen.
    pub verified: bool,
    pub reason: String,
    pub goal: String,
    pub target: Target,
    pub steps: Vec<Step>,
    pub wall_ms: u64,
    /// Launching the app / opening the page first.
    pub start_ms: u64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub start: String,
    /// Steps per decider.
    pub deciders: BTreeMap<String, usize>,
    pub decide_ms: u64,
    pub haiku: String,
    pub haiku_usd: f64,
    /// Input tokens sent to the model, and how many of them were read from the prompt cache.
    pub haiku_tokens: u64,
    pub haiku_cached_tokens: u64,
    /// Muscle memory entries learned from this run.
    pub learned: usize,
    pub checks: Vec<(String, bool)>,
    pub final_screen: String,
    /// When the caller must decide (stuck / surprised): what the screen offers, with element ids for the device tools.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<Action>,
}

/// Progress after each step, for the chat's live view.
pub type Progress<'a> = &'a mut dyn FnMut(&Outcome, bool);

/// Runs the goal: perceive → check → candidates → decide (memory, then the decider) → act → settle.
pub fn run(goal: &Goal, driver: &mut dyn Driver, mem: &mut memory::Memory, mut decider: Option<&mut dyn Decider>, haiku_note: &str, progress: Progress) -> Outcome {
    let t0 = Instant::now();
    let mut out = Outcome {
        status: Status::Stuck,
        verified: false,
        reason: String::new(),
        goal: goal.goal.clone(),
        target: goal.target,
        steps: Vec::new(),
        wall_ms: 0,
        start_ms: 0,
        start: String::new(),
        deciders: BTreeMap::new(),
        decide_ms: 0,
        haiku: haiku_note.to_string(),
        haiku_usd: 0.0,
        haiku_tokens: 0,
        haiku_cached_tokens: 0,
        learned: 0,
        checks: Vec::new(),
        final_screen: String::new(),
        candidates: Vec::new(),
    };
    let gkey = goal.memory_key();
    // Steps of this run to learn if it ends verified: (memory key, action key, screen signature).
    let mut pending: Vec<(String, String, String)> = Vec::new();
    // What was done on each signature this run, to never replay or repeat a no-op.
    let mut tried: HashMap<String, Vec<String>> = HashMap::new();
    let mut visits: HashMap<String, usize> = HashMap::new();
    let mut history: Vec<String> = Vec::new();
    let mut prev_key = "start".to_string();
    let mut false_done = 0;
    let mut start_app: Option<String> = None;

    let finish = |out: &mut Outcome, status: Status, reason: String, screen: Option<&Screen>, cands: Vec<Action>, driver: &mut dyn Driver| {
        out.status = status;
        out.reason = reason;
        if let Some(s) = screen {
            out.final_screen = s.summary(30);
            out.checks = goal.success.iter().map(|c| (c.describe(), c.holds(s))).collect();
        }
        if matches!(status, Status::Stuck | Status::Surprised) {
            out.candidates = cands;
        }
        out.wall_ms = t0.elapsed().as_millis() as u64;
        driver.finish();
    };

    match driver.start(goal) {
        Ok(note) => out.start = note,
        Err(e) => {
            finish(&mut out, Status::Stuck, format!("couldn't start: {e}"), None, Vec::new(), driver);
            progress(&out, true);
            return out;
        }
    }
    out.start_ms = t0.elapsed().as_millis() as u64;
    progress(&out, false);
    let mut last_screen: Option<Screen> = None;
    let mut last_sig = String::new();
    let mut last_verb: Option<Verb> = None;
    loop {
        let n = out.steps.len() + 1;
        let (mut screen, mut perceive_ms) = match driver.perceive() {
            Ok(s) => s,
            Err(e) => {
                let s = last_screen.clone();
                finish(&mut out, Status::Stuck, format!("couldn't read the screen: {e}"), s.as_ref(), Vec::new(), driver);
                break;
            }
        };
        let mut sig = signature(&screen);
        // A tap that seems to have changed nothing may only be slow to show: settle once more and look again.
        if sig == last_sig
            && matches!(last_verb, Some(Verb::Tap | Verb::Back | Verb::Submit))
            && driver.settle_again() > 0
            && let Ok((s, ms)) = driver.perceive()
        {
            if let Some(st) = out.steps.last_mut() {
                st.note.push_str(" (slow to change)");
            }
            sig = signature(&s);
            screen = s;
            perceive_ms += ms;
        }
        last_verb = None;
        // A step that changed nothing is not worth remembering.
        if sig == last_sig
            && let Some(p) = pending.last()
            && p.2 == sig
        {
            pending.pop();
        }
        last_sig = sig.clone();
        if !goal.success.is_empty() && goal.success.iter().all(|c| c.holds(&screen)) {
            out.verified = true;
            out.learned = mem.learn(&pending.iter().map(|(k, a, _)| (k.clone(), a.clone())).collect::<Vec<_>>());
            finish(&mut out, Status::Done, "every success check holds".into(), Some(&screen), Vec::new(), driver);
            break;
        }
        if t0.elapsed() >= goal.budget || out.steps.len() >= goal.max_steps {
            let why = if out.steps.len() >= goal.max_steps { format!("used all {} steps", goal.max_steps) } else { format!("used the {} ms budget", goal.budget.as_millis()) };
            let c = candidates(&screen, &goal.inputs, goal.target);
            finish(&mut out, Status::OutOfBudget, why, Some(&screen), c, driver);
            break;
        }
        // The app the run works in: the first one seen in front.
        if start_app.is_none() && !screen.alert && !screen.home {
            start_app = Some(screen.app.clone());
        }
        let cands = candidates(&screen, &goal.inputs, goal.target);
        let mkey = memory::key(&gkey, &sig, &prev_key);
        let v = visits.entry(sig.clone()).or_insert(0);
        *v += 1;
        if *v > 4 {
            finish(&mut out, Status::Stuck, "going in circles: the same screen keeps coming back".into(), Some(&screen), cands, driver);
            break;
        }
        // Muscle memory first: an exact match, not something already done on this very screen.
        let done_here = tried.get(&sig).cloned().unwrap_or_default();
        let t = Instant::now();
        let remembered = mem.lookup(&mkey).and_then(|k| cands.iter().find(|a| a.key() == k && !done_here.contains(&k))).cloned();
        let mut decided: Option<(Action, &'static str, u64)> = remembered.map(|a| (a, "memory", t.elapsed().as_millis() as u64));
        if decided.is_none() {
            let unexpected = if screen.alert && !goal.alerts {
                Some("a system alert appeared (pass answer_alerts: true, or answer it with the device tools)".to_string())
            } else if goal.target == Target::Iphone && screen.home && start_app.is_some() {
                Some("the app left the screen: the home screen is showing".to_string())
            } else if goal.target == Target::Iphone && !screen.alert && !screen.home && start_app.as_deref().is_some_and(|a| a != screen.app) {
                Some(format!("another app came to the front: {:?}", screen.app))
            } else {
                None
            };
            if let Some(why) = unexpected {
                finish(&mut out, Status::Surprised, why, Some(&screen), cands, driver);
                break;
            }
            match decider.as_deref_mut() {
                None => {
                    let why = format!("no remembered step for this screen and {haiku_note}: choose from the candidates (act with the device tools by their target ids), or give the pilot a key");
                    finish(&mut out, Status::Stuck, why, Some(&screen), cands, driver);
                    break;
                }
                Some(d) => match d.decide(&DecideRequest { goal, history: &history, screen: &screen, candidates: &cands }) {
                    Ok(dec) => {
                        out.haiku_usd += dec.usd;
                        out.haiku_tokens += dec.input_tokens;
                        out.haiku_cached_tokens += dec.cached_tokens;
                        match cands.get(dec.id) {
                            Some(a) => decided = Some((a.clone(), d.name(), dec.ms)),
                            None => {
                                finish(&mut out, Status::Stuck, format!("{} answered an action id that isn't on screen ({})", d.name(), dec.id), Some(&screen), cands, driver);
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        finish(&mut out, Status::Stuck, format!("{} couldn't decide: {e}", d.name()), Some(&screen), cands, driver);
                        break;
                    }
                },
            }
        }
        let Some((action, by, decide_ms)) = decided else { break };
        out.decide_ms += decide_ms;
        *out.deciders.entry(by.to_string()).or_insert(0) += 1;
        let mut step = Step { n, decider: by, action: action.describe(), verb: action.verb, perceive_ms, decide_ms, act_ms: 0, settle_ms: 0, note: String::new() };
        match action.verb {
            Verb::Stuck => {
                out.steps.push(step);
                finish(&mut out, Status::Stuck, format!("{by} found no action that makes progress here"), Some(&screen), cands, driver);
                break;
            }
            Verb::Done if goal.success.is_empty() => {
                out.steps.push(step);
                pending.push((mkey, action.key(), sig.clone()));
                out.learned = mem.learn(&pending.iter().map(|(k, a, _)| (k.clone(), a.clone())).collect::<Vec<_>>());
                finish(&mut out, Status::Done, format!("{by} judged the goal done (no success checks were given, so this is unverified)"), Some(&screen), Vec::new(), driver);
                break;
            }
            Verb::Done => {
                // The checks are the judge: "done" while they fail is a wrong guess.
                false_done += 1;
                step.note = "said done, but the success checks don't hold yet".into();
                out.steps.push(step);
                tried.entry(sig.clone()).or_default().push(action.key());
                history.push(format!("{} (rejected: the success checks don't hold)", action.describe()));
                progress(&out, false);
                if false_done >= 2 {
                    finish(&mut out, Status::Stuck, "the screen looks done to the pilot, but the success checks don't hold".into(), Some(&screen), cands, driver);
                    break;
                }
                last_screen = Some(screen);
                continue;
            }
            _ => {}
        }
        let t = Instant::now();
        match driver.act(&action, &screen, &goal.inputs) {
            Ok(note) => step.note = note,
            Err(e) => {
                step.note = format!("failed: {e}");
                step.act_ms = t.elapsed().as_millis() as u64;
                out.steps.push(step);
                finish(&mut out, Status::Stuck, format!("the action failed: {e}"), Some(&screen), cands, driver);
                break;
            }
        }
        step.act_ms = t.elapsed().as_millis() as u64;
        step.settle_ms = driver.settle(action.verb);
        last_verb = Some(action.verb);
        history.push(action.describe());
        tried.entry(sig.clone()).or_default().push(action.key());
        pending.push((mkey, action.key(), sig.clone()));
        prev_key = action.key();
        out.steps.push(step);
        out.wall_ms = t0.elapsed().as_millis() as u64;
        progress(&out, false);
        last_screen = Some(screen);
    }
    out.wall_ms = t0.elapsed().as_millis() as u64;
    progress(&out, true);
    out
}

/// The tool's answer: one line for people, then the outcome as JSON (the chat's pilot view reads it).
pub fn result_text(o: &Outcome) -> String {
    let by = o.deciders.iter().map(|(k, v)| format!("{v} by {k}")).collect::<Vec<_>>().join(", ");
    let head = format!(
        "pilot {}{} in {} steps, {:.1} s ({}): {}",
        serde_json::to_value(o.status).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default(),
        if o.verified { " (verified)" } else { "" },
        o.steps.len(),
        o.wall_ms as f64 / 1000.0,
        if by.is_empty() { "no decisions".into() } else { by },
        o.reason
    );
    format!("{head}\n{}", serde_json::to_string_pretty(&json!(o)).unwrap_or_default())
}

// ---------- the tool ----------

static RUNS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// `pilot_run` for chat `chat`: runs the goal on its iPhone or Browser panel, with live progress for the chat's view
/// (`pilot-progress` events), and answers with [`result_text`].
pub fn call(devices: &super::Devices, chat: usize, a: &Value) -> Result<String, String> {
    let goal = Goal::parse(a)?;
    let project = devices.mcp.cwd(chat).unwrap_or_default();
    let mut mem = match devices.data_dir() {
        Some(d) => memory::Memory::open(&d.join("pilot"), &project),
        None => memory::Memory::in_memory(),
    };
    // `COOOL_PILOT_HAIKU=off`: memory only (tests of the no-key path).
    let off = std::env::var("COOOL_PILOT_HAIKU").is_ok_and(|v| v == "off");
    let mut model = if off { None } else { haiku::Haiku::from_keychain() };
    let note = match &model {
        Some(_) => format!("Claude Haiku ({})", haiku::MODEL),
        None => "no Anthropic API key is set up in coool (the insights key), so Claude Haiku is off".to_string(),
    };
    let run_id = RUNS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let mut emit = |o: &Outcome, end: bool| {
        devices.emit("pilot-progress", json!({ "chat": chat, "run": run_id, "started": started, "end": end, "outcome": o }));
    };
    let decider: Option<&mut dyn Decider> = model.as_mut().map(|h| h as &mut dyn Decider);
    let out = match goal.target {
        Target::Iphone => {
            let udid = devices.device_for_chat(chat)?;
            let mut d = drivers::Iphone { devices, chat, udid };
            run(&goal, &mut d, &mut mem, decider, &note, &mut emit)
        }
        Target::Browser => {
            let mut d = drivers::Web { b: super::web::Browser::new(devices, chat) };
            run(&goal, &mut d, &mut mem, decider, &note, &mut emit)
        }
    };
    Ok(result_text(&out))
}

pub const TOOL_DESCRIPTION: &str = "Hand a routine multi-step goal on the iPhone or the Browser panel to coool's fast device pilot \
instead of driving it yourself step by step. It loops perceive → decide → act → settle on its own (a remembered path \
for screens it has done before, else a small fast model), far faster and cheaper than one observe/tap call per step, and \
returns when your success checks hold. Use it for navigation and form filling: \"Settings > General > About\", \"fill \
the signup form and submit\". Always give `success`: checkable conditions on the final screen, e.g. \
[{\"text_visible\":\"iOS Version\"}], [{\"element\":{\"label\":\"Cups\",\"value\":\"3\"}}], [{\"url_matches\":\"/thanks\"}]; \
the run ends `done` only when they all hold (verified), so the result is reliable. Text to type goes in `inputs` \
({\"email\":\"a@b.c\"}); the goal names them and the pilot types them by name (replacing a field's contents), never \
inventing text. It answers `done`, `stuck` (with the candidate actions and their element ids, so you can take over \
with the other tools), `surprised` (a system alert or another app appeared) or `out_of_budget`, with the steps, \
timings and the final screen. Keep judgement calls (what to buy, what to delete) for yourself.";

pub fn tool() -> Value {
    json!({
        "name": "pilot_run",
        "description": TOOL_DESCRIPTION,
        "inputSchema": { "type": "object", "required": ["goal", "target"], "properties": {
            "goal": { "type": "string", "description": "What to do, plainly, naming the path when you know it: \"Open General, then About\"." },
            "target": { "type": "string", "enum": ["iphone", "browser"] },
            "app": { "type": "string", "description": "iPhone: bundle id to launch fresh first (e.g. com.apple.Preferences)." },
            "url": { "type": "string", "description": "Browser: the page to open first." },
            "inputs": { "type": "object", "additionalProperties": { "type": "string" }, "description": "Values the pilot may type, by name." },
            "success": { "type": "array", "items": { "type": "object" }, "description": "Checks that all hold when the goal is done: {\"text_visible\":s}, {\"text_gone\":s}, {\"element\":{\"label\":s,\"value\"?:s}}, {\"url_matches\":s}." },
            "max_steps": { "type": "number", "description": "Default 15." },
            "budget_ms": { "type": "number", "description": "Wall-clock budget, default 90000." },
            "answer_alerts": { "type": "boolean", "description": "Let the pilot answer system alerts (default: return `surprised`)." }
        } }
    })
}

#[cfg(test)]
mod tests;
