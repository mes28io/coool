//! The `browser_*` tools of the `coool-device` MCP server: the chat's agent drives the **Browser panel** of its own
//! chat (the native child webviews of [`crate::browser`]) instead of opening a browser of its own or taking over the
//! person's screen (APP_SPEC "Agent browser tools").
//!
//! - Which webview: the frontend reports each chat's browser tabs ([`browser_agent_sync`]: tab ids, which one is
//!   active, the webview label of each). A tool acts on the chat's active tab, so the person and the agent look at
//!   the same page. Opening, switching and closing tabs go back to the frontend (`browser-agent` events), which owns
//!   the tab strip; a tool waits for the sync that follows. Only `browser-*` webviews are ever touched, never the
//!   app's own.
//! - How: one script ([`LIB`], `web_agent.js`) evaluated with WKWebView's `evaluateJavaScript:…inContentWorld:` in a
//!   content world of coool's own, so page scripts can't see or patch it. It reads the DOM (never cookies or web
//!   storage) and masks password / card / one-time-code fields. There is no tool that runs the agent's own script.
//! - Settling: after an action, the tool waits until the webview isn't loading and the DOM has been quiet for
//!   [`QUIET_MS`] (a MutationObserver in that world), then returns the page (or "unchanged").

use super::Devices;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};

/// The page script: a function expression, called as `LIB(<command JSON>)`.
pub const LIB: &str = include_str!("web_agent.js");
/// No DOM change for this long (and not loading) = settled.
const QUIET_MS: f64 = 90.0;

const NO_PAGE: &str = "This chat's browser panel has no page open. Call browser_navigate with a URL: it opens in the panel beside the chat.";
const EMPTY_TAB: &str = "The browser panel's tab is empty (a new tab). Call browser_navigate with a URL.";

/// One tab of a chat's browser panel, as the frontend reports it.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Tab {
    pub tab: u32,
    /// `web` (a page) or `start` (a new tab's address field).
    pub kind: String,
    /// The webview showing it (`browser-<n>`), once there is one.
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub title: String,
}

#[derive(Clone, Debug, Default)]
struct Panel {
    tabs: Vec<Tab>,
    active: Option<u32>,
}

/// What the chat's agent was shown last: for "unchanged" and for refusing ids of an older document.
struct Last {
    label: String,
    doc: String,
    text: String,
}

#[derive(Default)]
pub struct Web {
    panels: Mutex<HashMap<usize, Panel>>,
    synced: Condvar,
    last: Mutex<HashMap<usize, Last>>,
    /// Per chat: the actors on its panel lately (their order picks their tint), and when each last acted.
    actors: Mutex<HashMap<usize, Vec<(String, Instant)>>>,
    /// Per actor: where its cursor was last (viewport px), so it starts there on the next page.
    cursors: Mutex<HashMap<String, [f64; 2]>>,
}

/// The cursor tints in a page, in order of arrival (coool's `--presence-*` tokens; a page can't read them).
const TINTS: [&str; 3] = ["#0a84ff", "#5e5ce6", "#2a9fbc"];
/// How long a click waits for the cursor that's on its way (APP_SPEC "Agent presence": a few tens of ms at most).
const CLICK_DEFER_MS: u64 = 50;

/// The frontend's turn ended for `chat`: its cursors in the Browser panel rest, then fade.
#[tauri::command(async)]
pub fn browser_presence_end(devices: State<'_, Arc<Devices>>, chat: usize) {
    Browser::new(&devices, chat).presence_end(None);
}

/// The frontend's report of a chat's browser tabs (on every change).
#[tauri::command]
pub fn browser_agent_sync(devices: State<'_, Arc<Devices>>, chat: usize, tabs: Vec<Tab>, active: Option<u32>) {
    devices.web.sync(chat, tabs, active);
}

impl Web {
    fn sync(&self, chat: usize, tabs: Vec<Tab>, active: Option<u32>) {
        let tabs = tabs
            .into_iter()
            .map(|mut t| {
                // Only the panel's own webviews, never the app's.
                t.id = t.id.filter(|i| i.starts_with(crate::browser::PREFIX));
                t
            })
            .collect();
        self.panels.lock().unwrap().insert(chat, Panel { tabs, active });
        self.synced.notify_all();
    }
}

// ---------- the snapshot (web_agent.js `observe`) ----------

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Snap {
    pub doc: String,
    pub url: String,
    pub title: String,
    pub ready: String,
    pub vw: f64,
    pub vh: f64,
    pub sx: f64,
    pub sy: f64,
    pub sw: f64,
    pub sh: f64,
    pub els: Vec<El>,
    pub more: usize,
    pub off: usize,
    pub focus: Option<u64>,
    pub text: String,
    pub cut: Option<bool>,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct El {
    pub id: u64,
    pub role: String,
    pub name: String,
    #[serde(rename = "type")]
    pub typ: Option<String>,
    pub value: Option<String>,
    /// A password (or card number / one-time code) field: its value never leaves the page.
    pub pw: bool,
    pub filled: bool,
    pub ph: Option<String>,
    pub href: Option<String>,
    pub level: Option<u8>,
    pub checked: Option<Value>,
    pub pressed: Option<Value>,
    pub expanded: Option<Value>,
    pub selected: Option<Value>,
    pub disabled: bool,
    pub req: bool,
    pub ro: bool,
    pub focused: bool,
    pub opts: Option<Vec<String>>,
    pub nopts: Option<usize>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub off: bool,
}

fn flag(v: &Option<Value>, yes: &str, no: &str) -> String {
    match v {
        Some(Value::Bool(true)) => format!(" {yes}"),
        Some(Value::Bool(false)) if !no.is_empty() => format!(" {no}"),
        Some(Value::String(s)) if !s.is_empty() => format!(" {yes}={s}"),
        _ => String::new(),
    }
}

/// One element line: `[12] textbox "Email" value="a@b.c" (24,220 300x30)`.
pub fn element_line(e: &El) -> String {
    let mut l = format!("[{}] {}", e.id, e.role);
    if let Some(n) = e.level {
        let _ = write!(l, " h{n}");
    }
    if !e.name.is_empty() {
        let _ = write!(l, " {:?}", e.name);
    }
    if let Some(t) = &e.typ {
        let _ = write!(l, " type={t}");
    }
    if e.pw {
        // Never the value, even if one were sent.
        l.push_str(if e.filled { " (filled, hidden)" } else { " (empty)" });
    } else if let Some(v) = &e.value {
        let _ = write!(l, " value={v:?}");
    }
    if let Some(p) = &e.ph {
        let _ = write!(l, " placeholder={p:?}");
    }
    if let Some(h) = &e.href {
        let _ = write!(l, " → {h}");
    }
    let toggle = matches!(e.role.as_str(), "checkbox" | "radio" | "switch" | "menuitemcheckbox" | "menuitemradio");
    l += &flag(&e.checked, "checked", if toggle { "unchecked" } else { "" });
    l += &flag(&e.pressed, "pressed", "");
    l += &flag(&e.expanded, "expanded", "collapsed");
    l += &flag(&e.selected, "selected", "");
    for (on, word) in [(e.disabled, "disabled"), (e.req, "required"), (e.ro, "readonly"), (e.focused, "focused")] {
        if on {
            let _ = write!(l, " {word}");
        }
    }
    if let Some(o) = &e.opts {
        let extra = e.nopts.map(|n| n.saturating_sub(o.len())).unwrap_or(0);
        let _ = write!(l, " options: {}{}", o.join(" | "), if extra > 0 { format!(" (+{extra})") } else { String::new() });
    }
    let _ = write!(l, " ({:.0},{:.0} {:.0}x{:.0})", e.x, e.y, e.w, e.h);
    if e.off {
        l.push_str(" offscreen");
    }
    l
}

/// The page as text for the agent.
pub fn render(s: &Snap, loading: bool) -> String {
    let mut o = String::new();
    let title = if s.title.is_empty() { "(no title)" } else { &s.title };
    let _ = writeln!(o, "{title} — {}", s.url);
    let state = if loading || s.ready == "loading" { "loading" } else { "ready" };
    let scroll = if s.sh > s.vh + 1.0 { format!(" · scrolled {:.0} of {:.0} px", s.sy, (s.sh - s.vh).max(0.0)) } else { String::new() };
    let _ = writeln!(o, "{state} · viewport {:.0}x{:.0}{scroll} · {} elements", s.vw, s.vh, s.els.len() + s.more);
    for e in &s.els {
        o.push_str(&element_line(e));
        o.push('\n');
    }
    if s.more > 0 {
        let _ = writeln!(o, "… {} more not listed (scroll, or observe with a higher max)", s.more);
    }
    if s.els.is_empty() {
        o.push_str("(no interactive elements in view)\n");
    }
    if !s.text.is_empty() {
        let _ = write!(o, "\nText in view:\n{}{}\n", s.text, if s.cut == Some(true) { " …" } else { "" });
    }
    o
}

// ---------- URLs ----------

/// What `browser_navigate` accepts: an http(s) URL the panel may load ([`crate::browser::loadable`]: no other scheme,
/// no credentials, not the app's own dev server), or a bare host (`example.com`, `localhost:3000/x`; https:// is
/// added, http:// for localhost and IPs).
pub fn agent_url(text: &str, app_origin: Option<&str>) -> Result<tauri::Url, String> {
    let t = text.trim();
    let bad = || format!("only http and https pages open in the panel (not {t:?})");
    if t.is_empty() || t.chars().any(char::is_whitespace) {
        return Err(bad());
    }
    let has_scheme = t.find(':').is_some_and(|i| {
        let (s, rest) = t.split_at(i);
        let host_port = rest[1..].chars().take_while(|c| c.is_ascii_digit()).count() > 0 && !s.contains('/');
        s.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)) && !host_port
    });
    let full = if has_scheme {
        t.to_string()
    } else {
        let host = t.split(['/', '?', '#']).next().unwrap_or("");
        let h = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host).to_ascii_lowercase();
        let local = h == "localhost" || h.parse::<std::net::Ipv4Addr>().is_ok() || h.starts_with('[');
        if !local && !h.contains('.') {
            return Err(bad());
        }
        format!("{}://{t}", if local { "http" } else { "https" })
    };
    crate::browser::loadable(&full, app_origin).ok_or_else(bad)
}

/// An element id as the agent wrote it: `12`, `"12"` or `"[12]"`.
pub fn element_id(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.trim().trim_start_matches('[').trim_end_matches(']').trim().parse().ok(),
        _ => None,
    }
}

// ---------- the tools ----------

struct Page {
    label: String,
    tab: u32,
}

pub struct Browser<'a> {
    devices: &'a Devices,
    chat: usize,
}

impl<'a> Browser<'a> {
    pub fn new(devices: &'a Devices, chat: usize) -> Self {
        Browser { devices, chat }
    }

    fn app(&self) -> Result<&tauri::AppHandle, String> {
        self.devices.app.get().ok_or_else(|| "the browser tools need the coool app (not the headless server)".into())
    }

    fn web(&self) -> &Web {
        &self.devices.web
    }

    fn emit(&self, event: &str, payload: Value) {
        if let Ok(app) = self.app() {
            let _ = app.emit_to("main", event, payload);
        }
    }

    fn activity(&self, tab: Option<u32>, kind: &str, label: Option<String>) {
        self.activity_text(tab, kind, label, None);
    }

    fn activity_text(&self, tab: Option<u32>, kind: &str, label: Option<String>, text: Option<String>) {
        let who = super::presence::current();
        let actor = who.key(Some(self.chat));
        let slot = self.slot(&actor);
        self.emit(
            "browser-activity",
            json!({ "chat": self.chat, "tab": tab, "kind": kind, "label": label, "text": text, "actor": actor, "by": who.by(), "decider": who.decider, "provider": self.devices.mcp.provider(self.chat), "slot": slot }),
        );
    }

    /// The actor's place among the chat's recent actors (its tint): a slot is freed after a minute without a word.
    fn slot(&self, actor: &str) -> usize {
        let mut all = self.web().actors.lock().unwrap();
        let list = all.entry(self.chat).or_default();
        let now = Instant::now();
        list.retain(|(k, at)| k == actor || now.duration_since(*at) < Duration::from_secs(60));
        let i = match list.iter().position(|(k, _)| k == actor) {
            Some(i) => i,
            None => {
                list.push((actor.to_string(), now));
                list.len() - 1
            }
        };
        list[i].1 = now;
        i
    }

    /// What the page needs to draw the acting agent: who (name, mark), its tint, who decided (a pilot step), where
    /// its cursor was, and whether motion is reduced.
    fn presence(&self) -> Value {
        let who = super::presence::current();
        let actor = who.key(Some(self.chat));
        let slot = self.slot(&actor);
        let provider = self.devices.mcp.provider(self.chat);
        let (name, mark) = match (who.by(), provider) {
            ("pilot", _) => ("Pilot", "pilot"),
            (_, Some("codex")) => ("Codex", "codex"),
            (_, Some(_)) => ("Claude", "claude"),
            _ => ("Agent", ""),
        };
        let from = self.web().cursors.lock().unwrap().get(&actor).copied();
        json!({
            "actor": actor,
            "name": name,
            "mark": if mark.is_empty() { Value::Null } else { super::presence::mark(mark) },
            "tint": TINTS[slot % TINTS.len()],
            "decider": who.decider,
            "from": from,
            "reduce": self.devices.reduce_motion(),
            "defer": CLICK_DEFER_MS,
        })
    }

    /// Remembers where the actor's cursor is after an action (`at` in the page's answer).
    fn cursor_at(&self, r: &Value) {
        let at = r["at"].as_array().and_then(|a| Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?]));
        if let Some(at) = at {
            self.web().cursors.lock().unwrap().insert(super::presence::current().key(Some(self.chat)), at);
        }
    }

    /// The cursors drawn on the active page now (`[{actor, who, say}]`), for the self-test.
    pub fn presence_shown(&self) -> Result<Value, String> {
        let p = self.current().ok_or(NO_PAGE)?;
        Ok(self.eval(&p.label, &json!({ "op": "presence" }))?["shown"].clone())
    }

    /// The actor's run is over (`None`: every actor of the chat): its cursor on the active page rests, then fades.
    pub fn presence_end(&self, actor: Option<String>) {
        let Some(p) = self.current() else { return };
        let _ = self.eval(&p.label, &json!({ "op": "presence", "end": true, "presence": { "actor": actor, "reduce": self.devices.reduce_motion() } }));
    }

    fn live(&self, label: &str) -> bool {
        self.app().is_ok_and(|a| a.get_webview(label).is_some())
    }

    /// The active tab's page, if it has a live webview.
    fn current(&self) -> Option<Page> {
        let panels = self.web().panels.lock().unwrap();
        let p = panels.get(&self.chat)?;
        let t = p.tabs.iter().find(|t| Some(t.tab) == p.active)?;
        let id = t.id.clone().filter(|_| t.kind == "web")?;
        let tab = t.tab;
        drop(panels);
        self.live(&id).then_some(Page { label: id, tab })
    }

    fn panel(&self) -> Option<Panel> {
        self.web().panels.lock().unwrap().get(&self.chat).cloned()
    }

    /// Waits (up to `timeout`) until the chat's panel satisfies `ok`, re-checking on every sync.
    fn wait_sync(&self, timeout: Duration, ok: impl Fn(&Panel) -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        let mut panels = self.web().panels.lock().unwrap();
        loop {
            if panels.get(&self.chat).is_some_and(&ok) {
                return true;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            panels = self.web().synced.wait_timeout(panels, left.min(Duration::from_millis(100))).unwrap().0;
        }
    }

    fn active_live(&self, p: &Panel) -> bool {
        p.tabs.iter().find(|t| Some(t.tab) == p.active).is_some_and(|t| t.kind == "web" && t.id.as_deref().is_some_and(|i| self.live(i)))
    }

    /// The page to act on: the active tab's, its webview brought back if the app closed it (too many alive).
    fn page(&self) -> Result<Page, String> {
        self.app()?;
        if let Some(p) = self.current() {
            return Ok(p);
        }
        let panel = self.panel().filter(|p| !p.tabs.is_empty()).ok_or(NO_PAGE)?;
        let tab = panel.tabs.iter().find(|t| Some(t.tab) == panel.active).ok_or(NO_PAGE)?;
        if tab.kind != "web" {
            return Err(EMPTY_TAB.into());
        }
        self.emit("browser-agent", json!({ "chat": self.chat, "op": "ensure", "tab": tab.tab }));
        if !self.wait_sync(Duration::from_secs(10), |p| self.active_live(p)) {
            return Err("the browser panel's page didn't open in time; try again".into());
        }
        self.current().ok_or_else(|| NO_PAGE.into())
    }

    // ---- page plumbing ----

    #[cfg(target_os = "macos")]
    fn eval(&self, label: &str, cmd: &Value) -> Result<Value, String> {
        if !label.starts_with(crate::browser::PREFIX) {
            return Err("not a browser panel page".into());
        }
        let w = self.app()?.get_webview(label).ok_or("the page closed")?;
        let js = format!("{LIB}({cmd})");
        let (tx, rx) = std::sync::mpsc::channel();
        w.with_webview(move |pw| {
            crate::browser::native::eval_isolated(pw.inner(), &js, move |r| {
                let _ = tx.send(r);
            })
        })
        .map_err(|e| e.to_string())?;
        let s = rx.recv_timeout(Duration::from_secs(8)).map_err(|_| "the page didn't answer within 8 s (busy, or a dialog is open)".to_string())??;
        let v: Value = serde_json::from_str(&s).map_err(|_| format!("unexpected answer from the page: {}", s.chars().take(200).collect::<String>()))?;
        if let Some(e) = v["error"].as_str() {
            return Err(e.to_string());
        }
        Ok(v["ok"].clone())
    }

    #[cfg(not(target_os = "macos"))]
    fn eval(&self, _label: &str, _cmd: &Value) -> Result<Value, String> {
        Err("the browser tools need macOS for now".into())
    }

    #[cfg(target_os = "macos")]
    fn state(&self, label: &str) -> Option<crate::browser::BrowserState> {
        let w = self.app().ok()?.get_webview(label)?;
        let (tx, rx) = std::sync::mpsc::channel();
        let id = label.to_string();
        w.with_webview(move |pw| {
            let _ = tx.send(crate::browser::native::state(pw.inner(), id));
        })
        .ok()?;
        rx.recv_timeout(Duration::from_secs(3)).ok()
    }

    #[cfg(not(target_os = "macos"))]
    fn state(&self, _label: &str) -> Option<crate::browser::BrowserState> {
        None
    }

    fn loading(&self, label: &str) -> bool {
        self.state(label).is_some_and(|s| s.loading)
    }

    /// Waits until the page isn't loading and its DOM has been quiet for [`QUIET_MS`] (at most `max_ms`): elapsed ms.
    fn settle(&self, label: &str, max_ms: u64) -> u128 {
        let t0 = Instant::now();
        let max = Duration::from_millis(max_ms);
        std::thread::sleep(Duration::from_millis(15));
        loop {
            if !self.live(label) {
                break;
            }
            if !self.loading(label)
                && let Ok(i) = self.eval(label, &json!({ "op": "idle" }))
                && i["ready"].as_str() != Some("loading")
                && i["pending"].is_null()
                && i["quiet"].as_f64().unwrap_or(0.0) >= QUIET_MS
            {
                break;
            }
            if t0.elapsed() >= max {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        t0.elapsed().as_millis()
    }

    /// After a navigation was asked for: until it has started (loading, or another URL / document), then settled.
    fn settle_navigation(&self, label: &str, before_url: &str, before_doc: Option<String>, max_ms: u64) -> u128 {
        let t0 = Instant::now();
        let started = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < started {
            let s = self.state(label);
            if s.as_ref().is_some_and(|s| s.loading || s.url != before_url) {
                break;
            }
            if let (Some(d), Ok(i)) = (&before_doc, self.eval(label, &json!({ "op": "idle" })))
                && i["doc"].as_str() != Some(d)
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        self.settle(label, max_ms);
        t0.elapsed().as_millis()
    }

    fn doc(&self, label: &str) -> Option<String> {
        self.eval(label, &json!({ "op": "idle" })).ok().and_then(|i| i["doc"].as_str().map(String::from))
    }

    /// The page as text, remembered; `full: false` says "unchanged" when it is what the agent saw last.
    fn observe(&self, page: &Page, full: bool, a: &Value) -> Result<String, String> {
        let t = Instant::now();
        let cmd = json!({
            "op": "observe",
            "max": a["max"].as_u64().unwrap_or(250).clamp(10, 2000),
            "text_max": a["text_max"].as_u64().unwrap_or(2500).min(50_000),
            "all": a["all"].as_bool() == Some(true),
            "presence": a.get("presence"),
            "say": a.get("say"),
        });
        let v = self.eval(&page.label, &cmd)?;
        let snap: Snap = serde_json::from_value(v).map_err(|e| format!("bad snapshot: {e}"))?;
        let text = render(&snap, self.loading(&page.label));
        let ms = t.elapsed().as_millis();
        let mut last = self.web().last.lock().unwrap();
        let same = last.get(&self.chat).is_some_and(|l| l.label == page.label && l.text == text);
        let n = snap.els.len() + snap.more;
        last.insert(self.chat, Last { label: page.label.clone(), doc: snap.doc, text: text.clone() });
        Ok(if same && !full { format!("Page unchanged ({n} elements; observe {ms} ms).") } else { format!("{text}(observe {ms} ms)") })
    }

    // ---- for the device pilot (super::pilot::drivers) ----

    /// The active page's snapshot (remembered like an observe, so its ids work for the act calls and the caller's
    /// own `browser_*` tools afterwards) and whether it is still loading.
    pub(super) fn pilot_snapshot(&self) -> Result<(Snap, bool), String> {
        let page = self.page()?;
        let v = self.eval(&page.label, &json!({ "op": "observe", "max": 150, "text_max": 1500 }))?;
        let snap: Snap = serde_json::from_value(v).map_err(|e| format!("bad snapshot: {e}"))?;
        let loading = self.loading(&page.label);
        let text = render(&snap, loading);
        self.web().last.lock().unwrap().insert(self.chat, Last { label: page.label.clone(), doc: snap.doc.clone(), text });
        Ok((snap, loading))
    }

    /// One action on the active page by tool name (`browser_click`, `browser_type`, …), without the observe after.
    pub(super) fn pilot_act(&self, name: &str, a: &Value) -> Result<String, String> {
        let p = self.page()?;
        self.act(&p, name, a)
    }

    /// Waits for the active page to settle (ms); follows a tab the action opened.
    pub(super) fn pilot_settle(&self, max_ms: u64) -> u64 {
        match self.current() {
            Some(p) => self.settle(&p.label, max_ms) as u64,
            None => 0,
        }
    }

    pub(super) fn pilot_back(&self) -> Result<u64, String> {
        let p = self.page()?;
        self.activity(Some(p.tab), "back", None);
        let before = self.state(&p.label).map(|s| s.url).unwrap_or_default();
        let doc = self.doc(&p.label);
        self.history(&p, "back")?;
        Ok(self.settle_navigation(&p.label, &before, doc, 10_000) as u64)
    }

    pub(super) fn pilot_navigate(&self, raw: &str) -> Result<(), String> {
        let origin = self.app()?.state::<Arc<crate::Core>>().browsers.app_origin();
        self.navigate(agent_url(raw, origin.as_deref())?).map(|_| ())
    }

    /// "Agent" marks on: the run is acting (`kind`: `pilot`, `think`), or off for good (`end`: its cursor rests,
    /// then fades).
    pub(super) fn pilot_activity(&self, kind: &str) {
        let tab = self.current().map(|p| p.tab);
        self.activity(tab, kind, None);
        if kind == "end" {
            self.presence_end(Some(super::presence::current().key(Some(self.chat))));
        } else if kind == "think"
            && let Some(p) = self.current()
        {
            let say = if super::presence::current().decider == Some("haiku") { "Haiku is choosing" } else { "Choosing the next step" };
            let _ = self.eval(&p.label, &json!({ "op": "presence", "say": say, "presence": self.presence() }));
        }
    }

    /// The document token of the agent's last observe of this page (ids from another document are refused).
    fn last_doc(&self, page: &Page) -> Option<String> {
        self.web().last.lock().unwrap().get(&self.chat).filter(|l| l.label == page.label).map(|l| l.doc.clone())
    }

    fn with_id(&self, page: &Page, op: &str, a: &Value, id_key: &str) -> Result<Value, String> {
        let id = element_id(&a[id_key]).ok_or_else(|| format!("{op} needs `{id_key}`: an element id from browser_observe, like 12"))?;
        let mut cmd = a.clone();
        if !cmd.is_object() {
            cmd = json!({});
        }
        cmd["op"] = json!(op);
        cmd["id"] = json!(id);
        cmd["presence"] = self.presence();
        if let Some(d) = self.last_doc(page) {
            cmd["doc"] = json!(d);
        }
        let r = self.eval(&page.label, &cmd)?;
        self.cursor_at(&r);
        Ok(r)
    }

    fn screenshot(&self, page: &Page, max: Option<f64>) -> Result<Value, String> {
        #[cfg(target_os = "macos")]
        {
            use base64::Engine;
            let w = self.app()?.get_webview(&page.label).ok_or("the page closed")?;
            let max = max.unwrap_or(800.0).clamp(200.0, 2000.0);
            let (tx, rx) = std::sync::mpsc::channel();
            w.with_webview(move |pw| {
                crate::browser::native::snapshot_jpeg(pw.inner(), max, 0.5, move |r| {
                    let _ = tx.send(r);
                })
            })
            .map_err(|e| e.to_string())?;
            let jpeg = rx.recv_timeout(Duration::from_secs(8)).map_err(|_| "no snapshot within 8 s (is the page hidden?)".to_string())??;
            Ok(json!({ "type": "image", "data": base64::engine::general_purpose::STANDARD.encode(jpeg), "mimeType": "image/jpeg" }))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (page, max);
            Err("screenshots need macOS for now".into())
        }
    }

    /// After an action: settle, then the page (or "unchanged").
    fn after(&self, page: &Page, note: &str, act_ms: u128, a: &Value) -> Result<String, String> {
        if a["observe"].as_bool() == Some(false) {
            return Ok(format!("{note} · {act_ms} ms"));
        }
        let settle = self.settle(&page.label, 1500);
        // A click can open another tab, or the page can close itself: follow the panel's active tab.
        let page = self.current().unwrap_or(Page { label: page.label.clone(), tab: page.tab });
        let screen = self.observe(&page, false, a)?;
        Ok(format!("{note}\n(act {act_ms} ms · settle {settle} ms)\n\n{screen}"))
    }

    pub fn call(&self, name: &str, a: &Value) -> Result<Vec<Value>, String> {
        let t0 = Instant::now();
        let mut out = Vec::new();
        let text = match name {
            "browser_observe" => {
                let p = self.page()?;
                self.activity(Some(p.tab), "observe", None);
                let mut a = a.clone();
                if a.is_object() {
                    a["presence"] = self.presence();
                    a["say"] = json!("Reading the page");
                }
                let a = &a;
                let s = self.observe(&p, true, a)?;
                if a["screenshot"].as_bool() == Some(true) {
                    out.push(self.screenshot(&p, a["max_size"].as_f64())?);
                }
                s
            }
            "browser_screenshot" => {
                let p = self.page()?;
                self.activity(Some(p.tab), "screenshot", None);
                out.push(self.screenshot(&p, a["max_size"].as_f64())?);
                format!("screenshot ({} ms)", t0.elapsed().as_millis())
            }
            "browser_navigate" => {
                let raw = a["url"].as_str().ok_or("browser_navigate needs `url`")?;
                let origin = self.app()?.state::<Arc<crate::Core>>().browsers.app_origin();
                let url = agent_url(raw, origin.as_deref())?;
                let p = self.navigate(url)?;
                let note = format!("opened {raw}");
                let ms = t0.elapsed().as_millis();
                let screen = self.observe(&p, true, a)?;
                format!("{note}\n(load {ms} ms)\n\n{screen}")
            }
            "browser_back" | "browser_forward" | "browser_reload" => {
                let p = self.page()?;
                let action = &name["browser_".len()..];
                self.activity(Some(p.tab), action, None);
                let before = self.state(&p.label).map(|s| s.url).unwrap_or_default();
                let doc = self.doc(&p.label);
                self.history(&p, action)?;
                let ms = self.settle_navigation(&p.label, &before, doc, 10_000);
                let p = self.current().unwrap_or(p);
                let screen = self.observe(&p, true, a)?;
                format!("{}\n(load {ms} ms)\n\n{screen}", match action { "back" => "went back", "forward" => "went forward", _ => "reloaded" })
            }
            "browser_tabs" => self.tabs(a)?,
            "browser_wait_for" => {
                let p = self.page()?;
                self.activity(Some(p.tab), "wait", None);
                let (ok, ms, p) = self.wait(&p, a)?;
                let screen = self.observe(&p, true, a)?;
                let head = if ok { format!("{} after {ms} ms", describe_wait(a)) } else { format!("timed out after {ms} ms waiting for {}", describe_wait(a)) };
                if !ok {
                    return Err(format!("{head}\n\n{screen}"));
                }
                format!("{head}\n\n{screen}")
            }
            "browser_click" | "browser_type" | "browser_select" | "browser_scroll" | "browser_press" => {
                let p = self.page()?;
                let note = self.act(&p, name, a)?;
                self.after(&p, &note, t0.elapsed().as_millis(), a)?
            }
            "browser_batch" => {
                let steps = a["actions"].as_array().cloned().unwrap_or_default();
                if steps.is_empty() {
                    return Err("browser_batch needs `actions`, like [{\"type\":\"hello\",\"id\":4},{\"click\":7},{\"wait_for\":\"Saved\"}]".into());
                }
                let mut notes = Vec::new();
                for (i, s) in steps.iter().enumerate() {
                    match self.step(s) {
                        Ok(n) => notes.push(format!("{}. {n}", i + 1)),
                        Err(e) => {
                            notes.push(format!("{}. FAILED: {e} (stopped; later steps not run)", i + 1));
                            let screen = self.current().and_then(|p| self.observe(&p, true, &json!({})).ok()).unwrap_or_default();
                            return Err(format!("{}\n\n{screen}", notes.join("\n")));
                        }
                    }
                }
                let p = self.page()?;
                self.after(&p, &notes.join("\n"), t0.elapsed().as_millis(), a)?
            }
            _ => return Err(format!("unknown tool {name}")),
        };
        out.insert(0, json!({ "type": "text", "text": text }));
        Ok(out)
    }

    fn history(&self, p: &Page, action: &str) -> Result<(), String> {
        let w = self.app()?.get_webview(&p.label).ok_or("the page closed")?;
        if action == "reload" {
            return w.reload().map_err(|e| e.to_string());
        }
        #[cfg(target_os = "macos")]
        {
            let act = action.to_string();
            w.with_webview(move |pw| crate::browser::native::go(pw.inner(), &act)).map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "macos"))]
        {
            w.eval(if action == "back" { "history.back()" } else { "history.forward()" }).map_err(|e| e.to_string())
        }
    }

    /// Loads `url` in the active tab (the panel opens one, and shows itself, when there is none).
    fn navigate(&self, url: tauri::Url) -> Result<Page, String> {
        self.app()?;
        // The active tab's page (its webview brought back if needed); none, or a new tab: the panel opens one.
        if let Ok(p) = self.page() {
            self.activity(Some(p.tab), "navigate", Some(url.to_string()));
            let before = self.state(&p.label).map(|s| s.url).unwrap_or_default();
            let doc = self.doc(&p.label);
            self.app()?.get_webview(&p.label).ok_or("the page closed")?.navigate(url).map_err(|e| e.to_string())?;
            self.settle_navigation(&p.label, &before, doc, 10_000);
            return Ok(p);
        }
        self.activity(None, "navigate", Some(url.to_string()));
        self.emit("browser-agent", json!({ "chat": self.chat, "op": "open", "url": url.as_str() }));
        if !self.wait_sync(Duration::from_secs(10), |p| self.active_live(p)) {
            return Err("the browser panel didn't open the page in time; try again".into());
        }
        let p = self.current().ok_or(NO_PAGE)?;
        self.settle_navigation(&p.label, "", None, 10_000);
        Ok(p)
    }

    fn tabs(&self, a: &Value) -> Result<String, String> {
        self.app()?;
        let action = a["action"].as_str().unwrap_or("list");
        let list = |panel: Option<Panel>| -> String {
            match panel.filter(|p| !p.tabs.is_empty()) {
                None => "No tabs: the browser panel is closed. browser_navigate opens it.".into(),
                Some(p) => p
                    .tabs
                    .iter()
                    .map(|t| {
                        let mark = if Some(t.tab) == p.active { "* " } else { "  " };
                        if t.kind == "web" {
                            format!("{mark}[tab {}] {} — {}", t.tab, if t.title.is_empty() { "(no title)" } else { &t.title }, t.url)
                        } else {
                            format!("{mark}[tab {}] (new tab)", t.tab)
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            }
        };
        let tab_arg = || a["tab"].as_u64().map(|t| t as u32).ok_or_else(|| format!("tabs {action} needs `tab` (a number from tabs list)"));
        match action {
            "list" => Ok(list(self.panel())),
            "new" => {
                let raw = a["url"].as_str().ok_or("tabs new needs `url`")?;
                let origin = self.app()?.state::<Arc<crate::Core>>().browsers.app_origin();
                let url = agent_url(raw, origin.as_deref())?;
                let old: Vec<u32> = self.panel().map(|p| p.tabs.iter().map(|t| t.tab).collect()).unwrap_or_default();
                self.activity(None, "tab", Some(url.to_string()));
                self.emit("browser-agent", json!({ "chat": self.chat, "op": "new", "url": url.as_str() }));
                if !self.wait_sync(Duration::from_secs(10), |p| p.active.is_some_and(|t| !old.contains(&t)) && self.active_live(p)) {
                    return Err("the new tab didn't open in time".into());
                }
                let p = self.current().ok_or(NO_PAGE)?;
                self.settle_navigation(&p.label, "", None, 10_000);
                let screen = self.observe(&p, true, a)?;
                Ok(format!("opened tab {}\n{}\n\n{screen}", p.tab, list(self.panel())))
            }
            "switch" => {
                let tab = tab_arg()?;
                if !self.panel().is_some_and(|p| p.tabs.iter().any(|t| t.tab == tab)) {
                    return Err(format!("no tab {tab}\n{}", list(self.panel())));
                }
                self.activity(Some(tab), "tab", None);
                self.emit("browser-agent", json!({ "chat": self.chat, "op": "switch", "tab": tab }));
                let start = self.panel().and_then(|p| p.tabs.iter().find(|t| t.tab == tab).map(|t| t.kind != "web")).unwrap_or(false);
                if !self.wait_sync(Duration::from_secs(10), |p| p.active == Some(tab) && (start || self.active_live(p))) {
                    return Err("the tab didn't show in time".into());
                }
                if start {
                    return Ok(format!("switched to tab {tab} (a new tab: browser_navigate loads a page in it)"));
                }
                let p = self.current().ok_or(NO_PAGE)?;
                let screen = self.observe(&p, true, a)?;
                Ok(format!("switched to tab {tab}\n\n{screen}"))
            }
            "close" => {
                let tab = tab_arg()?;
                if !self.panel().is_some_and(|p| p.tabs.iter().any(|t| t.tab == tab)) {
                    return Err(format!("no tab {tab}\n{}", list(self.panel())));
                }
                self.activity(Some(tab), "tab", None);
                self.emit("browser-agent", json!({ "chat": self.chat, "op": "close", "tab": tab }));
                if !self.wait_sync(Duration::from_secs(5), |p| !p.tabs.iter().any(|t| t.tab == tab)) {
                    return Err("the tab didn't close in time".into());
                }
                Ok(format!("closed tab {tab}\n{}", list(self.panel())))
            }
            _ => Err("tabs action is list, new, switch or close".into()),
        }
    }

    fn act(&self, p: &Page, name: &str, a: &Value) -> Result<String, String> {
        match name {
            "browser_click" => {
                let r = self.with_id(p, "click", a, "id")?;
                self.activity(Some(p.tab), "click", r["what"].as_str().map(String::from));
                let mut s = format!("clicked {} at ({},{})", r["what"].as_str().unwrap_or("element"), r["x"], r["y"]);
                if let Some(n) = r["note"].as_str() {
                    let _ = write!(s, " (note: {n})");
                }
                Ok(s)
            }
            "browser_type" => {
                if !a["text"].is_string() {
                    return Err("browser_type needs `text`".into());
                }
                let r = self.with_id(p, "type", a, "id")?;
                let masked = r["masked"].as_bool() == Some(true);
                let field = r["what"].as_str().map(String::from);
                self.activity_text(Some(p.tab), "type", field, Some(if masked { "••••".into() } else { a["text"].as_str().unwrap_or("").chars().take(40).collect() }));
                let what = r["what"].as_str().unwrap_or("field");
                let mut s = if masked { format!("typed {} characters into {what} (hidden field)", r["len"]) } else { format!("typed {:?} into {what} (replacing what it held)", a["text"].as_str().unwrap_or("")) };
                if let Some(n) = r["now"].as_str() {
                    let _ = write!(s, "; the field now holds {n:?}");
                }
                if let Some(d) = r["submit"].as_str() {
                    let _ = write!(s, ", then Enter{}", if d.is_empty() { String::new() } else { format!(": {d}") });
                }
                Ok(s)
            }
            "browser_select" => {
                if a["value"].is_null() && a["label"].is_null() && a["index"].is_null() && a["values"].is_null() {
                    return Err("browser_select needs `value` (an option's value or text), `values` (multi-select) or `index`".into());
                }
                let r = self.with_id(p, "select", a, "id")?;
                self.activity(Some(p.tab), "select", r["what"].as_str().map(String::from));
                let picked: Vec<String> = r["picked"].as_array().map(|v| v.iter().filter_map(|x| x.as_str().map(|s| format!("{s:?}"))).collect()).unwrap_or_default();
                Ok(format!("selected {} in {}", picked.join(", "), r["what"].as_str().unwrap_or("the list")))
            }
            "browser_scroll" => {
                let mut cmd = json!({ "direction": a["direction"], "amount": a["amount"] });
                let r = if a["id"].is_null() {
                    cmd["op"] = json!("scroll");
                    cmd["presence"] = self.presence();
                    self.eval(&p.label, &cmd)?
                } else {
                    self.with_id(p, "scroll", a, "id")?
                };
                self.activity(Some(p.tab), "scroll", None);
                Ok(r["did"].as_str().unwrap_or("scrolled").to_string())
            }
            "browser_press" => {
                let key = a["key"].as_str().ok_or("browser_press needs `key`, like \"Enter\"")?;
                let mut cmd = json!({ "op": "press", "key": key, "modifiers": a["modifiers"], "presence": self.presence() });
                let r = if a["id"].is_null() {
                    self.eval(&p.label, &cmd)?
                } else {
                    cmd["id"] = a["id"].clone();
                    self.with_id(p, "press", &cmd, "id")?
                };
                self.activity(Some(p.tab), "press", Some(key.to_string()));
                let did = r["did"].as_str().unwrap_or("");
                Ok(format!("pressed {} on {}{}", r["key"].as_str().unwrap_or(key), r["on"].as_str().unwrap_or("the page"), if did.is_empty() { String::new() } else { format!(": {did}") }))
            }
            _ => Err(format!("unknown action {name}")),
        }
    }

    /// One `browser_batch` step: `{"click":12}`, `{"type":"hi","id":4,"submit":true}`, `{"select":"Blue","id":9}`,
    /// `{"press":"Enter","id"?:4}`, `{"scroll":"down","id"?:3}`, `{"navigate":"https://…"}`, `{"back":true}`,
    /// `{"forward":true}`, `{"reload":true}`, `{"wait_for":"Saved"|{…}}`, `{"wait_ms":300}`.
    fn step(&self, s: &Value) -> Result<String, String> {
        if let Some(u) = s["navigate"].as_str() {
            let origin = self.app()?.state::<Arc<crate::Core>>().browsers.app_origin();
            self.navigate(agent_url(u, origin.as_deref())?)?;
            return Ok(format!("opened {u}"));
        }
        if let Some(ms) = s["wait_ms"].as_f64() {
            std::thread::sleep(Duration::from_millis(ms.clamp(0.0, 10_000.0) as u64));
            return Ok(format!("waited {ms:.0} ms"));
        }
        let p = self.page()?;
        for h in ["back", "forward", "reload"] {
            if s[h].as_bool() == Some(true) {
                let before = self.state(&p.label).map(|s| s.url).unwrap_or_default();
                let doc = self.doc(&p.label);
                self.activity(Some(p.tab), h, None);
                self.history(&p, h)?;
                self.settle_navigation(&p.label, &before, doc, 10_000);
                return Ok(h.to_string());
            }
        }
        if let Some(t) = s.get("wait_for") {
            let a = if let Some(text) = t.as_str() { json!({ "text": text, "timeout_ms": s["timeout_ms"] }) } else { t.clone() };
            let (ok, ms, _) = self.wait(&p, &a)?;
            return if ok { Ok(format!("waited {ms} ms for {}", describe_wait(&a))) } else { Err(format!("timed out after {ms} ms waiting for {}", describe_wait(&a))) };
        }
        let (name, args) = if let Some(id) = s.get("click") {
            ("browser_click", json!({ "id": id }))
        } else if let Some(t) = s["type"].as_str() {
            ("browser_type", json!({ "id": s["id"].clone(), "text": t, "submit": s["submit"] }))
        } else if let Some(v) = s.get("select") {
            ("browser_select", json!({ "id": s["id"].clone(), "value": v }))
        } else if let Some(k) = s["press"].as_str() {
            ("browser_press", json!({ "key": k, "id": s["id"].clone(), "modifiers": s["modifiers"] }))
        } else if let Some(d) = s["scroll"].as_str() {
            ("browser_scroll", json!({ "direction": d, "id": s["id"].clone(), "amount": s["amount"] }))
        } else {
            return Err(format!("unknown batch step {s}"));
        };
        let note = self.act(&p, name, &args)?;
        self.settle(&p.label, 1200);
        Ok(note)
    }

    /// Polls until the condition holds: (met, elapsed ms, the page it ended on).
    fn wait(&self, p: &Page, a: &Value) -> Result<(bool, u128, Page), String> {
        let t0 = Instant::now();
        let timeout = Duration::from_millis(a["timeout_ms"].as_f64().unwrap_or(5000.0).clamp(0.0, 60_000.0) as u64);
        let gone = a["gone"].as_bool() == Some(true);
        let (text, selector, url) = (a["text"].as_str(), a["selector"].as_str(), a["url"].as_str());
        if text.is_none() && selector.is_none() && url.is_none() {
            if a["idle"].as_bool() == Some(true) {
                let ms = self.settle(&p.label, timeout.as_millis() as u64);
                let label = p.label.clone();
                return Ok((!self.loading(&label), ms, Page { label, tab: p.tab }));
            }
            return Err("browser_wait_for needs `text`, `selector`, `url` or `idle: true`".into());
        }
        let mut page = Page { label: p.label.clone(), tab: p.tab };
        loop {
            if let Some(cur) = self.current() {
                page = cur;
            }
            let mut present = None;
            if !self.loading(&page.label) {
                let r = self.eval(&page.label, &json!({ "op": "find", "text": text, "selector": selector }));
                if let Ok(r) = r {
                    let at = r["url"].as_str().unwrap_or("");
                    let hit = (text.is_none() && selector.is_none() || r["found"].as_bool() == Some(true)) && url.is_none_or(|u| at.contains(u));
                    present = Some(hit);
                } else if let Err(e) = r
                    && e.contains("invalid CSS selector")
                {
                    return Err(e);
                }
            }
            if present.is_some_and(|h| h != gone) {
                // The page may still be painting what it just showed.
                self.settle(&page.label, 600);
                return Ok((true, t0.elapsed().as_millis(), page));
            }
            if t0.elapsed() >= timeout {
                return Ok((false, t0.elapsed().as_millis(), page));
            }
            std::thread::sleep(Duration::from_millis(60));
        }
    }
}

fn describe_wait(a: &Value) -> String {
    let gone = a["gone"].as_bool() == Some(true);
    let v = if gone { "disappear" } else { "appear" };
    match (a["text"].as_str(), a["selector"].as_str(), a["url"].as_str()) {
        (Some(t), _, _) => format!("{t:?} to {v}"),
        (_, Some(s), _) => format!("`{s}` to {v}"),
        (_, _, Some(u)) => format!("the URL to {} {u:?}", if gone { "stop containing" } else { "contain" }),
        _ => "the page to settle".into(),
    }
}

pub const INSTRUCTIONS: &str = "Browser tools (browser_*) drive the Browser panel beside this chat (a real WebKit page the person \
watches), never their own browser. browser_navigate opens a page (the panel opens if needed). browser_observe lists the \
page's interactive elements as `[12] role \"name\" value=… (x,y wxh)` plus the text in view; act by id with \
browser_click / browser_type (replaces the field's contents) / browser_select / browser_press / browser_scroll. Every \
action waits for the page to settle and returns the page again (or \"Page unchanged\"), so you rarely need to observe. Ids \
stay valid while the element is on the page; after a navigation observe again. Use browser_batch for several steps \
and browser_wait_for instead of sleeping; browser_screenshot only when visuals matter. Password fields show only \
whether they're filled.";

pub fn tools() -> Vec<Value> {
    let id = json!({ "description": "Element id from browser_observe, e.g. 12" });
    let observe = json!({ "type": "boolean", "description": "Return the page after the action settles (default true)." });
    vec![
        json!({
            "name": "browser_observe",
            "description": "Read the page in this chat's Browser panel: URL, title, loading state, then one line per interactive element in view (`[id] role \"name\" value=… (x,y wxh)` in CSS px of the viewport) and the visible text. Password fields never show their value. all=true includes elements scrolled out of view; screenshot=true adds a JPEG.",
            "inputSchema": { "type": "object", "properties": {
                "all": { "type": "boolean" }, "max": { "type": "number", "description": "Most elements to list (default 250)." },
                "text_max": { "type": "number", "description": "Most characters of visible text (default 2500; 0 for none)." },
                "screenshot": { "type": "boolean" }, "max_size": { "type": "number", "description": "Screenshot width in pixels (default 800)." }
            } }
        }),
        json!({
            "name": "browser_click",
            "description": "Click an element by id (scrolled into view first; the panel highlights it). Returns the page after it settles.",
            "inputSchema": { "type": "object", "required": ["id"], "properties": { "id": id, "observe": observe } }
        }),
        json!({
            "name": "browser_type",
            "description": "Set a text field's contents to `text` (replaces what it held; fires input/change like real typing, so React-style apps see it). submit=true presses Enter after (submits its form).",
            "inputSchema": { "type": "object", "required": ["id", "text"], "properties": {
                "id": id, "text": { "type": "string" }, "submit": { "type": "boolean" }, "observe": observe
            } }
        }),
        json!({
            "name": "browser_select",
            "description": "Choose an option of a <select> by its value or visible text (`values` for a multi-select, or `index`).",
            "inputSchema": { "type": "object", "required": ["id"], "properties": {
                "id": id, "value": { "type": "string" }, "values": { "type": "array", "items": { "type": "string" } }, "index": { "type": "number" }, "observe": observe
            } }
        }),
        json!({
            "name": "browser_scroll",
            "description": "Scroll the page (or the scroll box containing element `id`) up/down/left/right by `amount` viewports (default 0.8), or to top/bottom. With only `id`, scrolls that element into view.",
            "inputSchema": { "type": "object", "properties": {
                "direction": { "type": "string", "enum": ["up", "down", "left", "right", "top", "bottom"] }, "amount": { "type": "number" }, "id": id, "observe": observe
            } }
        }),
        json!({
            "name": "browser_press",
            "description": "Press a key on the focused element (or element `id`): Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, or one character; modifiers: shift, control, option, command.",
            "inputSchema": { "type": "object", "required": ["key"], "properties": {
                "key": { "type": "string" }, "modifiers": { "type": "array", "items": { "type": "string" } }, "id": id, "observe": observe
            } }
        }),
        json!({
            "name": "browser_navigate",
            "description": "Load a URL in the panel's current tab (http/https only; a bare host like example.com gets https://). Opens the Browser panel beside the chat if it isn't open. Returns the loaded page.",
            "inputSchema": { "type": "object", "required": ["url"], "properties": { "url": { "type": "string" } } }
        }),
        json!({ "name": "browser_back", "description": "Go back in the current tab's history; returns the page.", "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "browser_forward", "description": "Go forward in the current tab's history; returns the page.", "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "browser_reload", "description": "Reload the current tab; returns the page.", "inputSchema": { "type": "object", "properties": {} } }),
        json!({
            "name": "browser_tabs",
            "description": "The panel's tabs: list (default), new (url), switch (tab), close (tab). Tools act on the active tab.",
            "inputSchema": { "type": "object", "properties": {
                "action": { "type": "string", "enum": ["list", "new", "switch", "close"] }, "url": { "type": "string" }, "tab": { "type": "number" }
            } }
        }),
        json!({
            "name": "browser_wait_for",
            "description": "Wait until text shows on the page, a CSS selector matches a visible element, or the URL contains `url` (gone=true: until it no longer does), or the page settles (idle=true). Default timeout 5000 ms. Returns the page.",
            "inputSchema": { "type": "object", "properties": {
                "text": { "type": "string" }, "selector": { "type": "string" }, "url": { "type": "string" }, "gone": { "type": "boolean" }, "idle": { "type": "boolean" },
                "timeout_ms": { "type": "number" }
            } }
        }),
        json!({
            "name": "browser_screenshot",
            "description": "A JPEG of what the panel's page shows (max_size: width in pixels, default 800). Prefer browser_observe unless visuals matter.",
            "inputSchema": { "type": "object", "properties": { "max_size": { "type": "number" } } }
        }),
        json!({
            "name": "browser_batch",
            "description": "Run several steps in one call, each after the previous settles, then return the page. Steps: {\"click\":12}, {\"type\":\"text\",\"id\":4,\"submit\"?:true}, {\"select\":\"Blue\",\"id\":9}, {\"press\":\"Enter\",\"id\"?:4}, {\"scroll\":\"down\",\"id\"?:3}, {\"navigate\":\"url\"}, {\"back\":true}, {\"forward\":true}, {\"reload\":true}, {\"wait_for\":\"text\"|{\"text\"|\"selector\"|\"url\",\"gone\"?,\"timeout_ms\"?}}, {\"wait_ms\":300}. Stops at the first failing step.",
            "inputSchema": { "type": "object", "required": ["actions"], "properties": {
                "actions": { "type": "array", "items": { "type": "object" } }, "observe": observe
            } }
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(v: Value) -> Snap {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn renders_elements_and_text() {
        let s = snap(json!({
            "doc": "d1", "url": "https://example.com/", "title": "Example", "ready": "complete", "vw": 600, "vh": 800, "sy": 0, "sh": 2000,
            "els": [
                { "id": 1, "role": "heading", "level": 1, "name": "Example Domain", "x": 24, "y": 40, "w": 552, "h": 38 },
                { "id": 2, "role": "link", "name": "More information…", "href": "https://www.iana.org/", "x": 24, "y": 180, "w": 150, "h": 18 },
                { "id": 3, "role": "textbox", "name": "Email", "value": "a@b.c", "ph": "you@example.com", "focused": true, "req": true, "x": 1, "y": 2, "w": 3, "h": 4 },
                { "id": 4, "role": "checkbox", "name": "Remember me", "checked": false, "x": 0, "y": 0, "w": 10, "h": 10 },
                { "id": 5, "role": "button", "name": "Menu", "expanded": true, "disabled": true, "x": 0, "y": 0, "w": 10, "h": 10, "off": true },
                { "id": 6, "role": "combobox", "name": "Color", "value": "Blue", "opts": ["Red", "Blue"], "nopts": 5, "x": 0, "y": 0, "w": 10, "h": 10 }
            ],
            "more": 2, "text": "Example Domain\nThis domain is for examples.", "cut": true
        }));
        let r = render(&s, false);
        assert!(r.starts_with("Example — https://example.com/\nready · viewport 600x800 · scrolled 0 of 1200 px · 8 elements\n"), "{r}");
        assert!(r.contains("[1] heading h1 \"Example Domain\" (24,40 552x38)\n"), "{r}");
        assert!(r.contains("[2] link \"More information…\" → https://www.iana.org/ (24,180 150x18)\n"), "{r}");
        assert!(r.contains("[3] textbox \"Email\" value=\"a@b.c\" placeholder=\"you@example.com\" required focused (1,2 3x4)\n"), "{r}");
        assert!(r.contains("[4] checkbox \"Remember me\" unchecked (0,0 10x10)\n"), "{r}");
        assert!(r.contains("[5] button \"Menu\" expanded disabled (0,0 10x10) offscreen\n"), "{r}");
        assert!(r.contains("[6] combobox \"Color\" value=\"Blue\" options: Red | Blue (+3)"), "{r}");
        assert!(r.contains("… 2 more not listed"), "{r}");
        assert!(r.ends_with("Text in view:\nExample Domain\nThis domain is for examples. …\n"), "{r}");
        assert!(render(&s, true).contains("\nloading · "));
    }

    #[test]
    fn password_values_never_render() {
        // Even if a value slipped through from the page, a masked field never shows it.
        let s = snap(json!({ "url": "https://x.test/login", "els": [
            { "id": 7, "role": "textbox", "name": "Password", "type": "password", "pw": true, "filled": true, "value": "hunter2" },
            { "id": 8, "role": "textbox", "name": "Code", "pw": true, "filled": false }
        ] }));
        let r = render(&s, false);
        assert!(!r.contains("hunter2"), "{r}");
        assert!(r.contains("[7] textbox \"Password\" type=password (filled, hidden)"), "{r}");
        assert!(r.contains("[8] textbox \"Code\" (empty)"), "{r}");
    }

    #[test]
    fn element_ids_parse() {
        assert_eq!(element_id(&json!(12)), Some(12));
        assert_eq!(element_id(&json!("12")), Some(12));
        assert_eq!(element_id(&json!("[12]")), Some(12));
        assert_eq!(element_id(&json!(" [ 3 ] ")), Some(3));
        for bad in [json!(null), json!("k3f"), json!(-1), json!(1.5), json!({})] {
            assert_eq!(element_id(&bad), None, "{bad}");
        }
    }

    #[test]
    fn navigate_urls_follow_the_panel_rules() {
        let ok = |s: &str| agent_url(s, Some("http://localhost:1420")).map(|u| u.to_string());
        assert_eq!(ok("https://example.com/a?b#c").unwrap(), "https://example.com/a?b#c");
        assert_eq!(ok("example.com").unwrap(), "https://example.com/");
        assert_eq!(ok("docs.rs/serde").unwrap(), "https://docs.rs/serde");
        assert_eq!(ok("localhost:3000/x").unwrap(), "http://localhost:3000/x");
        assert_eq!(ok("127.0.0.1:8080").unwrap(), "http://127.0.0.1:8080/");
        for bad in [
            "file:///etc/hosts",
            "javascript:alert(1)",
            "data:text/html,hi",
            "about:blank",
            "tauri://localhost/",
            "coool-artifact://localhost/x",
            "http://ipc.localhost/x",
            "https://user:pw@example.com/",
            "http://localhost:1420/",
            "localhost:1420",
            "chrome://settings",
            "notaword",
            "two words.com",
            "",
        ] {
            assert!(ok(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_page_script_never_touches_storage() {
        for word in ["cookie", "localStorage", "sessionStorage", "indexedDB", "eval(", "Function(", "XMLHttpRequest", "fetch("] {
            let code: String = LIB.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
            assert!(!code.contains(word), "web_agent.js mentions {word}");
        }
    }

    #[test]
    fn tools_are_prefixed_and_described() {
        let t = tools();
        assert_eq!(t.len(), 14);
        for x in &t {
            assert!(x["name"].as_str().unwrap().starts_with("browser_"));
            assert!(x["description"].as_str().unwrap().len() > 20);
            assert_eq!(x["inputSchema"]["type"], "object");
        }
    }

    #[test]
    fn sync_keeps_only_panel_webviews() {
        let d = Devices::default();
        let tabs = vec![
            Tab { tab: 1, kind: "web".into(), id: Some("browser-3".into()), ..Default::default() },
            Tab { tab: 2, kind: "web".into(), id: Some("main".into()), ..Default::default() },
        ];
        d.web.sync(5, tabs, Some(2));
        let p = d.web.panels.lock().unwrap().get(&5).cloned().unwrap();
        assert_eq!(p.tabs[0].id.as_deref(), Some("browser-3"));
        assert_eq!(p.tabs[1].id, None);
        // No app: the tools say so instead of touching anything.
        let b = Browser::new(&d, 5);
        assert!(b.call("browser_observe", &json!({})).unwrap_err().contains("coool app"));
    }
}

/// The page script run against a small fake DOM in JavaScriptCore: ids, roles, names, masking, typing.
#[cfg(all(test, target_os = "macos"))]
mod js_tests {
    use super::LIB;
    use serde_json::{Value, json};
    use std::ffi::{CStr, CString, c_char, c_void};

    #[link(name = "JavaScriptCore", kind = "framework")]
    unsafe extern "C" {
        fn JSGlobalContextCreate(class: *const c_void) -> *mut c_void;
        fn JSGlobalContextRelease(ctx: *mut c_void);
        fn JSStringCreateWithUTF8CString(s: *const c_char) -> *mut c_void;
        fn JSStringRelease(s: *mut c_void);
        fn JSStringGetMaximumUTF8CStringSize(s: *mut c_void) -> usize;
        fn JSStringGetUTF8CString(s: *mut c_void, buf: *mut c_char, size: usize) -> usize;
        fn JSEvaluateScript(ctx: *mut c_void, script: *mut c_void, this: *mut c_void, url: *mut c_void, line: i32, exc: *mut *const c_void) -> *const c_void;
        fn JSValueToStringCopy(ctx: *mut c_void, v: *const c_void, exc: *mut *const c_void) -> *mut c_void;
    }

    struct Js(*mut c_void);
    impl Js {
        fn new() -> Self {
            // SAFETY: a fresh global context, released on drop.
            let js = Js(unsafe { JSGlobalContextCreate(std::ptr::null()) });
            js.run(FAKE_DOM);
            js
        }
        fn run(&self, src: &str) -> String {
            let src = CString::new(src).unwrap();
            // SAFETY: JSC C API on a context this thread owns; strings released after use.
            unsafe {
                let s = JSStringCreateWithUTF8CString(src.as_ptr());
                let mut exc: *const c_void = std::ptr::null();
                let v = JSEvaluateScript(self.0, s, std::ptr::null_mut(), std::ptr::null_mut(), 1, &mut exc);
                JSStringRelease(s);
                let out = if v.is_null() { exc } else { v };
                let js = JSValueToStringCopy(self.0, out, std::ptr::null_mut());
                let n = JSStringGetMaximumUTF8CStringSize(js);
                let mut buf = vec![0 as c_char; n];
                JSStringGetUTF8CString(js, buf.as_mut_ptr(), n);
                JSStringRelease(js);
                let r = CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned();
                assert!(!v.is_null(), "JS threw: {r}");
                r
            }
        }
        fn cmd(&self, c: Value) -> Value {
            let v: Value = serde_json::from_str(&self.run(&format!("{LIB}({c})"))).unwrap();
            v
        }
        fn ok(&self, c: Value) -> Value {
            let v = self.cmd(c);
            assert!(v.get("error").is_none(), "{v}");
            v["ok"].clone()
        }
    }
    impl Drop for Js {
        fn drop(&mut self) {
            // SAFETY: created in `new`.
            unsafe { JSGlobalContextRelease(self.0) }
        }
    }

    /// Just enough DOM for the script: elements with attributes, styles and rects, text nodes, events.
    const FAKE_DOM: &str = r#"
var log = [];
function Ev(type, init) { init = init || {}; this.type = type; for (var k in init) this[k] = init[k]; this.defaultPrevented = false; }
Ev.prototype.preventDefault = function () { if (this.cancelable) this.defaultPrevented = true; };
var Event = Ev, MouseEvent = Ev, KeyboardEvent = Ev, InputEvent = Ev, PointerEvent = Ev;
function Text(s) { this.nodeType = 3; this.nodeValue = s; this.textContent = s; }
function El(tag, a, kids) {
  this.nodeType = 1; this.localName = tag; this.tagName = tag.toUpperCase(); this.attrs = {}; this.childNodes = [];
  this.style = {}; this.isConnected = true; this.listeners = {};
  a = a || {};
  for (var k in a) {
    if (k === 'rect') this.rect = a.rect; else if (k === 'css') this.css = a.css; else if (k === 'props') { for (var p in a.props) this[p] = a.props[p]; }
    else this.attrs[k] = String(a[k]);
  }
  if (this.attrs.type) this.type = this.attrs.type;
  if (this.attrs.id) this.id = this.attrs.id;
  if (this.attrs.href) this.href = this.attrs.href;
  (kids || []).forEach(function (c) { this.appendChild(typeof c === 'string' ? new Text(c) : c); }, this);
}
El.prototype.appendChild = function (c) { c.parentNode = this; c.parentElement = this; this.childNodes.push(c); return c; };
El.prototype.removeChild = function (c) { this.childNodes = this.childNodes.filter(function (x) { return x !== c; }); c.parentNode = null; };
Object.defineProperty(El.prototype, 'children', { get: function () { return this.childNodes.filter(function (n) { return n.nodeType === 1; }); } });
Object.defineProperty(El.prototype, 'textContent', { get: function () { return this.childNodes.map(function (n) { return n.textContent; }).join(''); }, set: function (s) { this.childNodes = [new Text(s)]; } });
var valueStore = new WeakMap();
Object.defineProperty(El.prototype, 'value', { get: function () { return valueStore.has(this) ? valueStore.get(this) : (this.attrs.value || ''); }, set: function (v) { log.push('set:' + v); valueStore.set(this, String(v)); }, configurable: true });
El.prototype.getAttribute = function (k) { return k in this.attrs ? this.attrs[k] : null; };
El.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
El.prototype.hasAttribute = function (k) { return k in this.attrs; };
El.prototype.getBoundingClientRect = function () { var r = this.rect || [0, 0, 0, 0]; return { left: r[0], top: r[1], width: r[2], height: r[3], right: r[0] + r[2], bottom: r[1] + r[3] }; };
El.prototype.dispatchEvent = function (e) { log.push(e.type + '@' + (this.attrs.id || this.localName)); var n = this; while (n) { (n.listeners && n.listeners[e.type] || []).forEach(function (f) { f(e); }); n = n.parentNode; } return !e.defaultPrevented; };
El.prototype.addEventListener = function (t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); };
El.prototype.focus = function () { document.activeElement = this; log.push('focus@' + (this.attrs.id || this.localName)); };
El.prototype.click = function () { this.dispatchEvent(new Ev('click', { bubbles: true })); if (this.attrs.type === 'checkbox') this.checked = !this.checked; };
El.prototype.contains = function (o) { while (o) { if (o === this) return true; o = o.parentNode; } return false; };
El.prototype.querySelector = function () { return null; };
El.prototype.scrollIntoView = function () { log.push('scrollIntoView@' + (this.attrs.id || this.localName)); };
El.prototype.select = function () {};
function h(tag, a) { return new El(tag, a, Array.prototype.slice.call(arguments, 2)); }
var window = globalThis; var innerWidth = 600, innerHeight = 800, scrollX = 0, scrollY = 0;
var location = { href: 'https://example.com/form', origin: 'https://example.com' };
function URL(h, base) { var abs = /^https?:/.test(h) ? h : 'https://example.com' + h; this.origin = abs.replace(/^(https?:\/\/[^/]+).*$/, '$1'); var rest = abs.slice(this.origin.length); this.pathname = rest.replace(/[?#].*$/, '') || '/'; this.search = ''; this.hash = ''; }
function getComputedStyle(el) { var c = el.css || {}; return { display: c.display || 'block', visibility: c.visibility || 'visible', opacity: c.opacity || '1', cursor: c.cursor || 'auto', overflowX: 'visible', overflowY: 'visible' }; }
function MutationObserver() {} MutationObserver.prototype.observe = function () {};
var setTimeout = function () {};
var document = { title: 'Sign in', readyState: 'complete', activeElement: null, createElement: function (t) { return new El(t); },
  getElementById: function (id) { var f = null; (function walk(n) { if (n.attrs && n.attrs.id === id) f = n; (n.childNodes || []).forEach(walk); })(document.body); return f; } };
function page(body) { body.rect = [0, 0, 600, 2000]; document.body = body; document.documentElement = h('html', { rect: [0, 0, 600, 800] }, body); document.scrollingElement = { scrollWidth: 600, scrollHeight: 2000 }; }
var pw, email, remember, hiddenBtn;
page(h('body', {},
  h('h1', { rect: [10, 10, 300, 30] }, 'Sign in'),
  h('p', { rect: [10, 50, 300, 20] }, 'Welcome back.   Please   sign in.'),
  h('label', { rect: [10, 80, 100, 20] }, 'Email'),
  email = h('input', { id: 'email', type: 'email', placeholder: 'you@example.com', rect: [10, 100, 300, 30], props: { labels: [] } }),
  pw = h('input', { id: 'pw', type: 'password', 'aria-label': 'Password', value: 'hunter2', rect: [10, 140, 300, 30] }),
  remember = h('input', { id: 'remember', type: 'checkbox', 'aria-label': 'Remember me', rect: [10, 180, 20, 20], props: { checked: true } }),
  h('button', { id: 'go', rect: [10, 210, 100, 30] }, h('span', { rect: [20, 215, 50, 20] }, 'Continue')),
  h('a', { href: '/help', rect: [10, 250, 60, 20] }, 'Help'),
  h('div', { rect: [10, 280, 100, 20], css: { cursor: 'pointer' } }, h('span', { rect: [10, 280, 50, 20], css: { cursor: 'pointer' } }, 'Fancy')),
  hiddenBtn = h('button', { rect: [10, 300, 80, 20], css: { display: 'none' } }, 'Ghost'),
  h('button', { rect: [10, 1500, 80, 20] }, 'Far below'),
  h('div', { rect: [10, 320, 200, 20], css: { visibility: 'hidden' } }, 'secret text')
));
email.labels = [document.body.childNodes[2]];
"#;

    #[test]
    fn observe_lists_visible_controls_with_stable_ids() {
        let js = Js::new();
        let s = js.ok(json!({ "op": "observe" }));
        let els = s["els"].as_array().unwrap();
        let line = |e: &Value| format!("{} {} {}", e["id"], e["role"].as_str().unwrap(), e["name"].as_str().unwrap());
        let lines: Vec<String> = els.iter().map(line).collect();
        assert_eq!(lines, ["1 heading Sign in", "2 textbox Email", "3 textbox Password", "4 checkbox Remember me", "5 button Continue", "6 link Help", "7 clickable Fancy"]);
        assert_eq!(els[1]["ph"], "you@example.com");
        assert_eq!(els[1]["type"], "email");
        assert_eq!(els[3]["checked"], true);
        assert_eq!(els[5]["href"], "/help");
        assert_eq!(els[0]["level"], 1);
        // Visible text: collapsed, without the controls' own labels, nothing hidden.
        let text = s["text"].as_str().unwrap();
        assert!(text.contains("Welcome back. Please sign in."), "{text}");
        assert!(!text.contains("secret text") && !text.contains("Ghost") && !text.contains("Far below") && !text.contains("Continue"), "{text}");
        assert_eq!(s["url"], "https://example.com/form");
        // Same document, same ids; an element out of view gets the next id once listed.
        let again = js.ok(json!({ "op": "observe", "all": true }));
        let a: Vec<String> = again["els"].as_array().unwrap().iter().map(line).collect();
        assert_eq!(&a[..7], &lines[..]);
        assert_eq!(a[7], "8 button Far below");
        assert_eq!(again["els"][7]["off"], true);
        assert_eq!(again["doc"], s["doc"]);
    }

    #[test]
    fn password_values_never_leave_the_page() {
        let js = Js::new();
        let raw = js.run(&format!("{LIB}({})", json!({ "op": "observe", "all": true })));
        assert!(!raw.contains("hunter2"), "{raw}");
        let v: Value = serde_json::from_str(&raw).unwrap();
        let pw = v["ok"]["els"].as_array().unwrap().iter().find(|e| e["name"] == "Password").unwrap().clone();
        assert_eq!(pw["pw"], true);
        assert_eq!(pw["filled"], true);
        assert!(pw.get("value").is_none());
        // Typing into it says how many characters, never echoes them.
        let t = js.ok(json!({ "op": "type", "id": 3, "text": "s3cret!" }));
        assert_eq!(t["masked"], true);
        assert_eq!(t["len"], 7);
        assert!(t.get("now").is_none());
    }

    #[test]
    fn typing_replaces_and_fires_input_and_change() {
        let js = Js::new();
        js.ok(json!({ "op": "observe" }));
        js.run("log.length = 0; email.value = 'old@x.y'; log.length = 0;");
        let t = js.ok(json!({ "op": "type", "id": 2, "text": "me@example.com" }));
        assert_eq!(t["len"], 14);
        let log = js.run("log.join(',')");
        assert!(log.contains("focus@email"), "{log}");
        let set = log.find("set:me@example.com").expect(&log);
        let input = log.find(",input@email").expect(&log);
        let change = log.find("change@email").expect(&log);
        assert!(set < input && input < change, "{log}");
        assert_eq!(js.run("email.value"), "me@example.com");
        // Not a text field.
        let e = js.cmd(json!({ "op": "type", "id": 5, "text": "x" }));
        assert!(e["error"].as_str().unwrap().contains("not a text field"), "{e}");
    }

    #[test]
    fn click_fires_the_pointer_sequence() {
        let js = Js::new();
        js.ok(json!({ "op": "observe" }));
        js.run("log.length = 0");
        let r = js.ok(json!({ "op": "click", "id": 4 }));
        assert_eq!(r["x"], 20);
        assert_eq!(r["y"], 190);
        let log = js.run("log.join(',')");
        let order = ["pointerdown@remember", "mousedown@remember", "focus@remember", "pointerup@remember", "mouseup@remember", "click@remember"];
        let mut at = 0;
        for o in order {
            let i = log[at..].find(o).unwrap_or_else(|| panic!("{o} missing or out of order in {log}"));
            at += i + o.len();
        }
        assert_eq!(js.run("String(remember.checked)"), "false");
    }

    #[test]
    fn presence_draws_a_cursor_and_lets_the_click_land_after_it() {
        let js = Js::new();
        // Enough of the DOM for the cursor (no layout, no Web Animations), and timers the test runs by hand.
        js.run(
            "var timers = []; setTimeout = function (f, ms) { timers.push([f, ms || 0]); return timers.length; }; clearTimeout = function () {};
             var mkEl = document.createElement; document.createElement = function (t) { var e = mkEl(t); e.style.setProperty = function (k, v) { this[k] = v; }; e.attachShadow = function () { return this; }; return e; };
             document.createElementNS = function (ns, t) { return document.createElement(t); };
             function runTimers(upTo) { var due = timers.filter(function (t) { return t[1] <= upTo; }); timers = timers.filter(function (t) { return t[1] > upTo; }); due.forEach(function (t) { t[0](); }); return due.length; }",
        );
        js.ok(json!({ "op": "observe" }));
        js.run("log.length = 0");
        let p = json!({ "actor": "0:c1", "name": "Claude", "tint": "#0a84ff", "defer": 50, "from": [300, 600], "mark": null });
        let r = js.ok(json!({ "op": "click", "id": 4, "presence": p }));
        assert_eq!(r["at"], json!([20, 190]), "{r}");
        // The cursor is on its way: the click hasn't landed, and the page counts as busy until it does.
        assert!(!js.run("log.join(',')").contains("click@remember"));
        let idle = js.ok(json!({ "op": "idle" }));
        assert_eq!((idle["pending"].as_u64(), idle["quiet"].as_u64()), (Some(1), Some(0)), "{idle}");
        assert!(js.run("String(runTimers(50))") != "0");
        assert!(js.run("log.join(',')").contains("click@remember"));
        assert_eq!(js.run("String(remember.checked)"), "false");
        assert!(js.ok(json!({ "op": "idle" }))["pending"].is_null());
        // The label: who, then what.
        assert!(js.run("JSON.stringify(document.documentElement.childNodes.map(function n(e) { return e.textContent; }))").contains("ClaudeClicking Remember me"));
        // Ending the run rests the cursor, then fades it out.
        assert_eq!(js.ok(json!({ "op": "presence", "end": true, "presence": { "actor": "0:c1" } }))["ended"], true);
        // Without presence the click lands at once, as before.
        js.run("log.length = 0");
        js.ok(json!({ "op": "click", "id": 4 }));
        assert!(js.run("log.join(',')").contains("click@remember"));
    }

    #[test]
    fn stale_ids_and_documents_are_refused() {
        let js = Js::new();
        let s = js.ok(json!({ "op": "observe" }));
        let e = js.cmd(json!({ "op": "click", "id": 99 }));
        assert!(e["error"].as_str().unwrap().contains("no element [99]"), "{e}");
        let e = js.cmd(json!({ "op": "click", "id": 5, "doc": "another-document" }));
        assert!(e["error"].as_str().unwrap().contains("observe again"), "{e}");
        assert!(js.cmd(json!({ "op": "click", "id": 5, "doc": s["doc"] }))["ok"].is_object());
        // An element that left the page.
        js.run("document.body.childNodes[6].isConnected = false");
        let e = js.cmd(json!({ "op": "click", "id": 5 }));
        assert!(e["error"].as_str().unwrap().contains("no element [5]"), "{e}");
    }
}
