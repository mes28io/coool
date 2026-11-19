//! Optional AI status lines for sessions, via the Anthropic Messages API and a
//! key the person supplies. Off by default; see docs/CHAT_SPEC.md.
//!
//! The key is never logged, serialized, or placed in an error string.

use crate::model::{Activity, ActivityKind, Provider, Session, Status};
use crate::util::{one_line, truncate};
use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) const MODEL: &str = "claude-haiku-5-5";
const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2026-10-21";
const MAX_TOKENS: u32 = 300;
const KEYCHAIN_SERVICE: &str = "coool-anthropic-api-key";
const KEYCHAIN_ACCOUNT: &str = "coool";

const HISTORY_LINES: usize = 40;
const TEXT_MAX: usize = 300;
const HEADLINE_MAX: usize = 80;
const NEEDS_MAX: usize = 140;
const TITLE_MAX: usize = 56;
/// Earlier prompts sampled into the request, so the title names the whole session.
const EARLIER_PROMPTS: usize = 8;
const EARLIER_MAX: usize = 120;

const MIN_INTERVAL_MS: u64 = 45_000;
const BACKOFF_MS: u64 = 5 * 60_000;
const MAX_IN_FLIGHT: usize = 2;
const HOURLY_CAP: usize = 120;
const HOUR_MS: u64 = 3_600_000;
const KEY_RECHECK_MS: u64 = 30_000;

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Insight {
    pub headline: String,
    pub needs_you: Option<String>,
    /// The model's title for the session as a whole (see [`crate::titles`]): only
    /// a candidate, taken at a checkpoint when it names a different subject.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub generated_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---------------------------------------------------------------- key storage

/// Env `COOOL_ANTHROPIC_API_KEY`, else the macOS Keychain item.
pub fn api_key() -> Option<String> {
    if let Ok(k) = std::env::var("COOOL_ANTHROPIC_API_KEY") {
        let k = k.trim();
        if !k.is_empty() {
            return Some(k.to_string());
        }
    }
    keychain_get()
}

pub fn save_api_key(key: &str) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        bail!("empty API key");
    }
    keychain_set(key)
}

pub fn delete_api_key() -> Result<()> {
    keychain_delete()
}

#[cfg(target_os = "macos")]
fn keychain_get() -> Option<String> {
    keychain_get_in(KEYCHAIN_SERVICE)
}

#[cfg(target_os = "macos")]
fn keychain_get_in(service: &str) -> Option<String> {
    let out = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", service, "-w"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let k = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!k.is_empty()).then_some(k)
}

#[cfg(not(target_os = "macos"))]
fn keychain_get() -> Option<String> {
    None
}

/// A key `security -i` can take inside double quotes: printable ASCII without
/// quotes or backslashes (Anthropic keys are `sk-ant-` plus [A-Za-z0-9_-]).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn keychain_safe(key: &str) -> bool {
    !key.is_empty() && key.bytes().all(|b| (0x21..0x7f).contains(&b) && b != b'"' && b != b'\\' && b != b'\'')
}

/// Stores the key without it ever appearing on a command line.
///
/// `security add-generic-password -w <key>` would put the secret in argv, where
/// other processes of the same user can read it via `ps`. Instead the command
/// is written to `security -i` (interactive mode) on stdin. The item stays one
/// that `/usr/bin/security` created and is trusted for, so reading it back
/// (here and for items stored by earlier versions) never raises a Keychain
/// access prompt; going through the Security framework from the app itself
/// would tie the item's ACL to an unsigned binary whose identity changes on
/// every build, and prompt on each read.
#[cfg(target_os = "macos")]
fn keychain_set(key: &str) -> Result<()> {
    keychain_set_in(KEYCHAIN_SERVICE, key)
}

#[cfg(target_os = "macos")]
fn keychain_set_in(service: &str, key: &str) -> Result<()> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    if !keychain_safe(key) {
        bail!("that doesn't look like an Anthropic API key (unexpected characters)");
    }
    let mut child = Command::new("/usr/bin/security")
        .arg("-i")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("could not run /usr/bin/security")?;
    {
        let mut stdin = child.stdin.take().context("security stdin")?;
        let line = format!("add-generic-password -U -a {KEYCHAIN_ACCOUNT} -s {service} -w \"{key}\"\n");
        stdin.write_all(line.as_bytes()).context("could not talk to /usr/bin/security")?;
        // Dropping stdin ends the interactive session.
    }
    child.wait().context("could not run /usr/bin/security")?;
    // `security -i` exits 0 even when a command fails: read it back to be sure.
    if keychain_get_in(service).as_deref() != Some(key) {
        bail!("Keychain refused to store the key");
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn keychain_set(_key: &str) -> Result<()> {
    bail!("storing the key is only supported on macOS; set COOOL_ANTHROPIC_API_KEY instead")
}

#[cfg(target_os = "macos")]
fn keychain_delete() -> Result<()> {
    keychain_delete_in(KEYCHAIN_SERVICE)
}

#[cfg(target_os = "macos")]
fn keychain_delete_in(service: &str) -> Result<()> {
    let out = std::process::Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", service])
        .stdin(std::process::Stdio::null())
        .output()
        .context("could not run /usr/bin/security")?;
    // Exit 44: item not found. Deleting something already gone is fine.
    if !out.status.success() && out.status.code() != Some(44) {
        bail!("Keychain refused to delete the key (security exited with {})", out.status.code().unwrap_or(-1));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn keychain_delete() -> Result<()> {
    bail!("deleting the key is only supported on macOS")
}

// ------------------------------------------------------------- prompt / parse

const SYSTEM_PROMPT: &str = "You write one-line status updates for a dashboard of coding-agent sessions. \
You are given a snapshot of one session. Reply with JSON only.\n\
headline: one plain line, at most 80 characters, saying what the agent is doing (present tense while the \
status is busy) or did (past tense when idle). No quotes, no emoji, no trailing period.\n\
needs_you: null unless the session is blocked on the person: it asked a question, is awaiting approval, \
hit an error it cannot get past, or is looping. Then one short line saying what it needs from them.\n\
title: a name for the whole session, not the current step: a short noun phrase (2 to 6 words, at most 48 \
characters) naming what it is building or fixing, like \"Living chat titles\" or \"Sidebar unread dot fix\". \
Never \"Chat about\", \"Session on\" or \"Discussion of\"; no quotes, no trailing period. If the current title \
still names what the session is about, return it unchanged, word for word.";

fn kind_label(k: ActivityKind) -> &'static str {
    match k {
        ActivityKind::Prompt => "prompt",
        ActivityKind::Text => "text",
        ActivityKind::Tool => "tool",
        ActivityKind::Error => "error",
        ActivityKind::Agent => "agent",
    }
}

fn status_label(s: Status) -> &'static str {
    match s {
        Status::Busy => "busy",
        Status::Idle => "idle",
        Status::Ended => "ended",
    }
}

fn folder_name(cwd: &str) -> String {
    std::path::Path::new(cwd).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The user message sent to the model.
pub(crate) fn build_prompt(s: &Session) -> String {
    let mut p = String::new();
    p.push_str(&format!("provider: {}\n", s.provider.label()));
    let title = s.name.as_ref().map(|n| n.title.as_str()).unwrap_or(&s.title);
    p.push_str(&format!("current title: {}\n", one_line(title, TEXT_MAX)));
    p.push_str(&format!("folder: {}\n", folder_name(&s.cwd)));
    p.push_str(&format!("status: {}\n", status_label(s.status)));
    p.push_str(&format!("current tool: {}\n", s.current.as_deref().map(|c| one_line(c, TEXT_MAX)).unwrap_or_else(|| "none".into())));
    p.push_str(&format!("last prompt: {}\n", s.last_prompt.as_deref().map(|c| one_line(c, TEXT_MAX)).unwrap_or_else(|| "none".into())));
    // A spread of the session's prompts (the first one, then evenly over the rest), so the
    // title can name the whole session and not only its last 40 steps.
    let prompts: Vec<&Activity> = s.activity.iter().filter(|a| a.kind == ActivityKind::Prompt).collect();
    if prompts.len() > 1 {
        p.push_str("prompts across the session (oldest first):\n");
        let n = prompts.len().min(EARLIER_PROMPTS);
        let mut last = usize::MAX;
        for i in 0..n {
            let at = if n == 1 { 0 } else { i * (prompts.len() - 1) / (n - 1) };
            if at != last {
                p.push_str(&format!("- {}\n", one_line(&prompts[at].text, EARLIER_MAX)));
                last = at;
            }
        }
    }
    p.push_str("recent activity (oldest first):\n");
    let start = s.activity.len().saturating_sub(HISTORY_LINES);
    for a in &s.activity[start..] {
        p.push_str(&format!("[{}] {}\n", kind_label(a.kind), one_line(&a.text, TEXT_MAX)));
    }
    p
}

fn request_body(s: &Session) -> Value {
    json!({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        // Short, simple task: no reasoning, lowest effort.
        "thinking": { "type": "disabled" },
        "system": SYSTEM_PROMPT,
        "messages": [{ "role": "user", "content": build_prompt(s) }],
        "output_config": {
            "effort": "low",
            "format": {
                "type": "json_schema",
                "schema": {
                    "type": "object",
                    "properties": {
                        "headline": { "type": "string" },
                        "needs_you": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                        "title": { "type": "string" }
                    },
                    "required": ["headline", "needs_you", "title"],
                    "additionalProperties": false
                }
            }
        }
    })
}

fn clean_headline(h: &str) -> String {
    let h = one_line(h, usize::MAX);
    let h = h.trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '“' | '”' | '‘' | '’') || c.is_whitespace());
    let h = h.trim_end_matches(['.', '。']).trim_end();
    truncate(h, HEADLINE_MAX)
}

/// Parses the model's text (strict JSON, or JSON wrapped in prose) into an Insight.
pub(crate) fn parse_insight_text(text: &str, generated_ms: u64) -> Result<Insight> {
    let (a, b) = (text.find('{'), text.rfind('}'));
    let (Some(a), Some(b)) = (a, b) else { bail!("reply contained no JSON object") };
    if b < a {
        bail!("reply contained no JSON object");
    }
    let v: Value = serde_json::from_str(&text[a..=b]).map_err(|_| anyhow!("reply was not valid JSON"))?;
    let headline = v.get("headline").and_then(|h| h.as_str()).map(clean_headline).unwrap_or_default();
    if headline.is_empty() {
        bail!("reply had no headline");
    }
    let needs_you = v
        .get("needs_you")
        .and_then(|n| n.as_str())
        .map(|n| one_line(n, usize::MAX))
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty() && !n.eq_ignore_ascii_case("null") && !n.eq_ignore_ascii_case("none"))
        .map(|n| truncate(&n, NEEDS_MAX));
    let title = v
        .get("title")
        .and_then(|t| t.as_str())
        .map(|t| truncate(&clean_headline(t), TITLE_MAX))
        .filter(|t| !t.is_empty() && !t.to_lowercase().starts_with("chat about") && !t.to_lowercase().starts_with("session "));
    Ok(Insight { headline, needs_you, title, generated_ms })
}

/// Parses a full Messages API response body.
pub(crate) fn parse_response(body: &str, generated_ms: u64) -> Result<Insight> {
    let v: Value = serde_json::from_str(body).map_err(|_| anyhow!("API reply was not JSON"))?;
    if v.get("stop_reason").and_then(|s| s.as_str()) == Some("refusal") {
        bail!("the model declined to summarize this session");
    }
    let text: String = v
        .get("content")
        .and_then(|c| c.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    parse_insight_text(&text, generated_ms)
}

/// One blocking API call.
pub fn summarize(key: &str, s: &Session) -> Result<Insight> {
    let body = request_body(s).to_string();
    let res = call_api(key, &body).map_err(|e| anyhow!(redact(&e.to_string(), key)));
    let (status, text) = res?;
    if status != 200 {
        let msg = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(String::from))
            .unwrap_or_else(|| "request failed".into());
        bail!("{}", redact(&format!("Anthropic API error {status}: {}", one_line(&msg, 200)), key));
    }
    parse_response(&text, now_ms()).map_err(|e| anyhow!(redact(&e.to_string(), key)))
}

fn call_api(key: &str, body: &str) -> Result<(u16, String)> {
    call_api_within(key, body, Duration::from_secs(30))
}

/// One POST to the Messages API, giving up after `timeout` (also used by [`crate::explain`]).
pub(crate) fn call_api_within(key: &str, body: &str, timeout: Duration) -> Result<(u16, String)> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .build()
        .into();
    let mut resp = agent
        .post(API_URL)
        .header("x-api-key", key)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json")
        .send(body)
        .map_err(|e| anyhow!("network error: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.body_mut().read_to_string().map_err(|e| anyhow!("could not read reply: {e}"))?;
    Ok((status, text))
}

pub(crate) fn redact(msg: &str, key: &str) -> String {
    if key.is_empty() { msg.to_string() } else { msg.replace(key, "[redacted]") }
}

// ------------------------------------------------------------------ scheduler

type SessionKey = (Provider, String);

#[derive(Default)]
struct Entry {
    /// Fingerprint the last successful insight was generated for.
    done_fp: Option<u64>,
    last_req_ms: Option<u64>,
    backoff_until_ms: u64,
    in_flight: bool,
    insight: Option<Insight>,
}

/// Hash of what makes a new insight worthwhile: activity length, last entry, status, current tool.
fn fingerprint(s: &Session) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.activity.len().hash(&mut h);
    s.activity.last().map(|a: &Activity| (kind_label(a.kind), a.text.as_str())).hash(&mut h);
    status_label(s.status).hash(&mut h);
    s.current.hash(&mut h);
    h.finish()
}

/// Per-session decision (pure): is a request due for a session with this fingerprint?
fn session_due(e: Option<&Entry>, fp: u64, now_ms: u64) -> bool {
    let Some(e) = e else { return true };
    !e.in_flight
        && e.done_fp != Some(fp)
        && now_ms >= e.backoff_until_ms
        && e.last_req_ms.is_none_or(|t| now_ms.saturating_sub(t) >= MIN_INTERVAL_MS)
}

/// Global limits (pure).
fn global_allows(in_flight: usize, requests_last_hour: usize) -> bool {
    in_flight < MAX_IN_FLIGHT && requests_last_hour < HOURLY_CAP
}

type Done = (SessionKey, u64, Result<Insight, String>);

/// What [`Insights::take_slot`] allows.
pub enum Slot {
    /// AI insights is off in Settings.
    Off,
    /// On, but no key is stored.
    NoKey,
    /// The hourly cap is reached.
    Limited,
    /// Go, with this key (never logged).
    Go(String),
}

pub struct Insights {
    enabled: bool,
    key: Option<String>,
    key_checked_ms: Option<u64>,
    entries: HashMap<SessionKey, Entry>,
    recent: VecDeque<u64>,
    in_flight: usize,
    last_error: Option<String>,
    tx: Sender<Done>,
    rx: Receiver<Done>,
}

impl Default for Insights {
    fn default() -> Self {
        Self::new()
    }
}

impl Insights {
    pub fn new() -> Self {
        let (tx, rx) = channel();
        Insights {
            enabled: false,
            key: None,
            key_checked_ms: None,
            entries: HashMap::new(),
            recent: VecDeque::new(),
            in_flight: 0,
            last_error: None,
            tx,
            rx,
        }
    }

    pub fn set_enabled(&mut self, on: bool) {
        self.enabled = on;
        // Re-read the key on the next tick (it may have just been saved or removed).
        self.key = None;
        self.key_checked_ms = None;
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// Call after every Hub::refresh. Never blocks on the network.
    pub fn tick(&mut self, sessions: &[Session]) {
        let now = now_ms();
        self.collect(now);
        let Some(key) = self.ensure_key(now) else { return };
        for (k, fp, s) in self.plan(sessions, now) {
            let (tx, key) = (self.tx.clone(), key.clone());
            std::thread::spawn(move || {
                let r = summarize(&key, &s).map_err(|e| redact(&e.to_string(), &key));
                let _ = tx.send((k, fp, r));
            });
        }
    }

    /// A request outside the per-session scheduler (the "AI read" of a permission request, [`crate::explain`]):
    /// the same switch, key and hourly cap as insights. Counts against the cap when it returns `Go`.
    pub fn take_slot(&mut self) -> Slot {
        let now = now_ms();
        if !self.enabled {
            return Slot::Off;
        }
        let Some(key) = self.ensure_key(now) else { return Slot::NoKey };
        while self.recent.front().is_some_and(|t| now.saturating_sub(*t) >= HOUR_MS) {
            self.recent.pop_front();
        }
        if self.recent.len() >= HOURLY_CAP {
            return Slot::Limited;
        }
        self.recent.push_back(now);
        Slot::Go(key)
    }

    pub fn get(&self, provider: Provider, session_id: &str) -> Option<&Insight> {
        self.entries.get(&(provider, session_id.to_string())).and_then(|e| e.insight.as_ref())
    }

    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    fn ensure_key(&mut self, now: u64) -> Option<String> {
        if !self.enabled {
            return None;
        }
        if self.key.is_none() && self.key_checked_ms.is_none_or(|t| now.saturating_sub(t) >= KEY_RECHECK_MS) {
            self.key_checked_ms = Some(now);
            self.key = api_key();
        }
        self.key.clone()
    }

    /// Applies finished requests.
    fn collect(&mut self, now: u64) {
        while let Ok((k, fp, res)) = self.rx.try_recv() {
            self.in_flight = self.in_flight.saturating_sub(1);
            let e = self.entries.entry(k).or_default();
            e.in_flight = false;
            match res {
                Ok(ins) => {
                    e.done_fp = Some(fp);
                    e.insight = Some(ins);
                    self.last_error = None;
                }
                Err(msg) => {
                    e.backoff_until_ms = now + BACKOFF_MS;
                    self.last_error = Some(msg);
                }
            }
        }
    }

    /// Decides which sessions get a request now and records them as in flight.
    fn plan(&mut self, sessions: &[Session], now: u64) -> Vec<(SessionKey, u64, Session)> {
        while self.recent.front().is_some_and(|t| now.saturating_sub(*t) >= HOUR_MS) {
            self.recent.pop_front();
        }
        let mut out = Vec::new();
        for s in sessions {
            if s.status == Status::Ended || s.activity.is_empty() {
                continue;
            }
            if !global_allows(self.in_flight, self.recent.len()) {
                break;
            }
            let k = (s.provider, s.id.clone());
            let fp = fingerprint(s);
            if !session_due(self.entries.get(&k), fp, now) {
                continue;
            }
            let e = self.entries.entry(k.clone()).or_default();
            e.in_flight = true;
            e.last_req_ms = Some(now);
            self.in_flight += 1;
            self.recent.push_back(now);
            out.push((k, fp, s.clone()));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Tokens;

    fn act(kind: ActivityKind, text: &str) -> Activity {
        Activity::line("00:00:00".into(), kind, text)
    }

    fn session(id: &str, n: usize) -> Session {
        Session {
            provider: Provider::Claude,
            id: id.into(),
            title: "Fix the parser".into(),
            cwd: "/Users/x/code/myproj".into(),
            project: String::new(),
            model: "m".into(),
            pid: None,
            status: Status::Busy,
            current: Some("Bash · cargo test".into()),
            last_prompt: Some("make the tests pass".into()),
            tokens: Tokens::default(),
            activity: std::sync::Arc::new((0..n).map(|i| act(ActivityKind::Text, &format!("line {i}"))).collect()),
            agents: vec![],
            updated: SystemTime::now(),
            last_event: None,
            managed: None,
            chat: None,
            models: vec![],
            loaded: true,
            origin: Default::default(),
            parent: None,
            live_children: 0,
            background_tasks: false,
            waiting_for: None,
            shells: Vec::new(),
            title_facts: Default::default(),
            name: None,
        }
    }

    #[test]
    fn prompt_has_fields_and_last_40() {
        let p = build_prompt(&session("a", 100));
        assert!(p.contains("provider: claude"));
        assert!(p.contains("folder: myproj"));
        assert!(p.contains("status: busy"));
        assert!(p.contains("current tool: Bash · cargo test"));
        assert!(p.contains("last prompt: make the tests pass"));
        assert!(p.contains("[text] line 99\n"));
        assert!(p.contains("[text] line 60\n"));
        assert!(!p.contains("line 59\n"));
        assert_eq!(p.matches("[text]").count(), 40);
    }

    #[test]
    fn prompt_truncates_long_text() {
        let mut s = session("a", 0);
        std::sync::Arc::make_mut(&mut s.activity).push(act(ActivityKind::Error, &"x".repeat(1000)));
        let p = build_prompt(&s);
        let line = p.lines().find(|l| l.starts_with("[error]")).unwrap();
        assert!(line.chars().count() <= "[error] ".len() + 300);
        assert!(line.ends_with('…'));
    }

    #[test]
    fn request_shape_has_no_key_and_right_model() {
        let b = request_body(&session("a", 3));
        assert_eq!(b["model"], "claude-haiku-5-5");
        assert_eq!(b["output_config"]["format"]["type"], "json_schema");
        assert!(b["max_tokens"].as_u64().unwrap() <= 400);
    }

    #[test]
    fn parses_valid_json() {
        let i = parse_insight_text(r#"{"headline":"Running the test suite","needs_you":null}"#, 7).unwrap();
        assert_eq!(i.headline, "Running the test suite");
        assert_eq!(i.needs_you, None);
        assert_eq!(i.generated_ms, 7);
        let i = parse_insight_text(r#"{"headline":"Waiting","needs_you":"Approve the deploy"}"#, 0).unwrap();
        assert_eq!(i.needs_you.as_deref(), Some("Approve the deploy"));
    }

    #[test]
    fn the_title_rides_along_in_the_same_request() {
        let mut s = session("a", 3);
        std::sync::Arc::make_mut(&mut s.activity).insert(0, act(ActivityKind::Prompt, "build the parser"));
        std::sync::Arc::make_mut(&mut s.activity).push(act(ActivityKind::Prompt, "now the lexer"));
        s.name = Some(crate::titles::Name { title: "Parser rewrite".into(), source: crate::titles::Source::Ai, previous: vec![] });
        let p = build_prompt(&s);
        assert!(p.contains("current title: Parser rewrite\n"), "{p}");
        assert!(p.contains("- build the parser\n- now the lexer\n"), "{p}");
        let b = request_body(&s);
        assert_eq!(b["output_config"]["format"]["schema"]["required"], json!(["headline", "needs_you", "title"]));
        // Fixture reply (no network): the title is parsed and cleaned.
        let body = r#"{"content":[{"type":"text","text":"{\"headline\":\"Editing lexer.rs\",\"needs_you\":null,\"title\":\"\\\"Parser and lexer rewrite.\\\"\"}"}],"stop_reason":"end_turn"}"#;
        let i = parse_response(body, 1).unwrap();
        assert_eq!(i.title.as_deref(), Some("Parser and lexer rewrite"));
        assert_eq!(parse_insight_text(r#"{"headline":"h","needs_you":null,"title":"Chat about parsers"}"#, 0).unwrap().title, None);
        assert_eq!(parse_insight_text(r#"{"headline":"h","needs_you":null}"#, 0).unwrap().title, None);
    }

    #[test]
    fn parses_json_wrapped_in_prose() {
        let i = parse_insight_text("Sure! Here you go:\n```json\n{\"headline\": \"Fixed the build.\", \"needs_you\": \"\"}\n```", 0).unwrap();
        assert_eq!(i.headline, "Fixed the build");
        assert_eq!(i.needs_you, None);
    }

    #[test]
    fn missing_fields() {
        let i = parse_insight_text(r#"{"headline":"Only a headline"}"#, 0).unwrap();
        assert_eq!(i.needs_you, None);
        assert!(parse_insight_text(r#"{"needs_you":"x"}"#, 0).is_err());
        assert!(parse_insight_text(r#"{"headline":"  "}"#, 0).is_err());
        assert!(parse_insight_text("no json here", 0).is_err());
    }

    #[test]
    fn long_headline_is_clamped_and_cleaned() {
        let i = parse_insight_text(&format!(r#"{{"headline":"\"{}\"","needs_you":"{}"}}"#, "word ".repeat(40), "y".repeat(500)), 0).unwrap();
        assert!(crate::util::display_width(&i.headline) <= HEADLINE_MAX);
        assert!(!i.headline.starts_with('"'));
        assert!(crate::util::display_width(i.needs_you.as_deref().unwrap()) <= NEEDS_MAX);
    }

    #[test]
    fn parses_api_response_and_refusal() {
        let body = r#"{"content":[{"type":"text","text":"{\"headline\":\"Editing main.rs\",\"needs_you\":null}"}],"stop_reason":"end_turn"}"#;
        assert_eq!(parse_response(body, 1).unwrap().headline, "Editing main.rs");
        assert!(parse_response(r#"{"content":[],"stop_reason":"refusal"}"#, 1).is_err());
    }

    #[test]
    fn keychain_input_is_quotable() {
        assert!(keychain_safe("sk-ant-api03-AbC_d-9"));
        assert!(!keychain_safe(""));
        assert!(!keychain_safe("a\"b"));
        assert!(!keychain_safe("a b"));
        assert!(!keychain_safe("a\nadd-generic-password"));
        assert!(!keychain_safe("a\\b"));
        assert!(!keychain_safe("ключ"));
    }

    /// Round trip through the real Keychain, on a throwaway item (never the real one).
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "touches the login Keychain"]
    fn keychain_round_trip_without_argv() {
        let svc = "coool-test-keychain-round-trip";
        keychain_set_in(svc, "sk-ant-test-1").unwrap();
        assert_eq!(keychain_get_in(svc).as_deref(), Some("sk-ant-test-1"));
        keychain_set_in(svc, "sk-ant-test-2").unwrap();
        assert_eq!(keychain_get_in(svc).as_deref(), Some("sk-ant-test-2"));
        assert!(keychain_set_in(svc, "bad\"quote").is_err());
        keychain_delete_in(svc).unwrap();
        keychain_delete_in(svc).unwrap();
        assert_eq!(keychain_get_in(svc), None);
    }

    #[test]
    fn redact_hides_key() {
        assert_eq!(redact("bad key sk-ant-123 here", "sk-ant-123"), "bad key [redacted] here");
    }

    #[test]
    fn session_due_rules() {
        let fp = 1;
        assert!(session_due(None, fp, 0));
        let mut e = Entry { done_fp: Some(fp), last_req_ms: Some(0), ..Default::default() };
        // Unchanged fingerprint: never due.
        assert!(!session_due(Some(&e), fp, 10 * MIN_INTERVAL_MS));
        // Changed fingerprint, but within 45s.
        assert!(!session_due(Some(&e), 2, MIN_INTERVAL_MS - 1));
        assert!(session_due(Some(&e), 2, MIN_INTERVAL_MS));
        // In flight.
        e.in_flight = true;
        assert!(!session_due(Some(&e), 2, 10 * MIN_INTERVAL_MS));
        // Backoff after an error.
        e.in_flight = false;
        e.backoff_until_ms = 1_000_000;
        assert!(!session_due(Some(&e), 2, 999_999));
        assert!(session_due(Some(&e), 2, 1_000_000));
    }

    #[test]
    fn global_limits() {
        assert!(global_allows(0, 0));
        assert!(global_allows(1, 119));
        assert!(!global_allows(2, 0));
        assert!(!global_allows(0, 120));
    }

    #[test]
    fn fingerprint_tracks_changes() {
        let mut s = session("a", 3);
        let f = fingerprint(&s);
        assert_eq!(f, fingerprint(&s.clone()));
        std::sync::Arc::make_mut(&mut s.activity).push(act(ActivityKind::Text, "more"));
        assert_ne!(f, fingerprint(&s));
        let f = fingerprint(&s);
        s.status = Status::Idle;
        assert_ne!(f, fingerprint(&s));
        let f = fingerprint(&s);
        s.current = None;
        assert_ne!(f, fingerprint(&s));
    }

    #[test]
    fn plan_applies_all_limits() {
        let mut ins = Insights::new();
        let mut ended = session("ended", 5);
        ended.status = Status::Ended;
        let sessions = vec![session("a", 5), session("b", 5), session("c", 5), ended];

        // Max two in flight; ended never planned.
        let p = ins.plan(&sessions, 1_000);
        assert_eq!(p.iter().map(|x| x.0.1.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        assert!(ins.plan(&sessions, 1_001).is_empty());

        // Finish a (ok) and b (error): c becomes eligible, b is backed off.
        let mk = |id: &str, ok: bool| {
            let fp = fingerprint(sessions.iter().find(|s| s.id == id).unwrap());
            let r = if ok { Ok(Insight { headline: "h".into(), needs_you: None, title: None, generated_ms: 0 }) } else { Err("boom".to_string()) };
            ((Provider::Claude, id.to_string()), fp, r)
        };
        ins.tx.send(mk("a", true)).unwrap();
        ins.tx.send(mk("b", false)).unwrap();
        ins.collect(2_000);
        assert_eq!(ins.last_error(), Some("boom"));
        assert!(ins.get(Provider::Claude, "a").is_some());
        let p = ins.plan(&sessions, 2_000);
        assert_eq!(p.iter().map(|x| x.0.1.as_str()).collect::<Vec<_>>(), vec!["c"]);
        // a unchanged -> not due even much later; b still backed off just before 5 min.
        ins.in_flight = 0;
        ins.entries.get_mut(&(Provider::Claude, "c".into())).unwrap().in_flight = false;
        let later = 2_000 + BACKOFF_MS - 1;
        assert!(ins.plan(&sessions, later).iter().all(|x| x.0.1 != "a" && x.0.1 != "b"));
        ins.in_flight = 0;
        ins.entries.get_mut(&(Provider::Claude, "c".into())).unwrap().in_flight = false;
        let p = ins.plan(&sessions, 2_000 + BACKOFF_MS);
        assert!(p.iter().any(|x| x.0.1 == "b"));
    }

    #[test]
    fn hourly_cap_rolls() {
        let mut ins = Insights::new();
        for i in 0..HOURLY_CAP {
            ins.recent.push_back(i as u64);
        }
        let sessions = vec![session("a", 5)];
        assert!(ins.plan(&sessions, 1_000).is_empty());
        // After an hour has passed the old entries roll off.
        assert_eq!(ins.plan(&sessions, HOUR_MS + HOURLY_CAP as u64).len(), 1);
    }

    #[test]
    fn disabled_or_keyless_does_nothing() {
        let mut ins = Insights::new();
        assert!(!ins.enabled());
        ins.tick(&[session("a", 5)]);
        assert_eq!(ins.in_flight, 0);
        assert!(ins.entries.is_empty());
    }

    #[test]
    #[ignore = "calls the real Anthropic API (spends a little money)"]
    fn real_api_call() {
        let key = api_key().expect("no API key configured");
        let mut s = session("live", 0);
        s.activity = std::sync::Arc::new(vec![
            act(ActivityKind::Prompt, "make the parser tests pass"),
            act(ActivityKind::Tool, "Bash · cargo test -p parser"),
            act(ActivityKind::Error, "test parse_nested failed: expected 3, got 2"),
            act(ActivityKind::Text, "I will fix the off-by-one in the nesting counter."),
        ]);
        let i = summarize(&key, &s).unwrap();
        println!("headline: {}\nneeds_you: {:?}", i.headline, i.needs_you);
        assert!(!i.headline.is_empty());
    }
}
