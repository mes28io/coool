//! Plan usage: how much of the person's Claude subscription limits and Codex
//! (ChatGPT plan) limits are used, and when they reset. See docs/CHAT_SPEC.md,
//! "Plan usage".
//!
//! coool never touches credentials. Every number here comes from a surface of
//! the official CLIs, which do the authenticated work themselves:
//!
//! - Claude, free file read: `~/.claude.json` key `cachedUsageUtilization`,
//!   which the CLI writes whenever it fetches plan usage (its `/usage` screen,
//!   or the probe below). Only that key and three plan fields of
//!   `oauthAccount` are deserialized; nothing else in the file is kept.
//! - Claude, probe: a hidden `claude -p` in stream-json mode, sent the
//!   `get_usage` control request (`skip_behaviors: true`) and no prompt. No
//!   model turn runs (the CLI reports `total_cost_usd: 0`); the CLI makes one
//!   request to its plan-usage endpoint and refreshes the cache above.
//! - Claude, live: `rate_limit_event`s seen by coool's own structured chats
//!   ([`observe_claude_rate_limit_event`]); they come with turns the person is
//!   running anyway and carry the session and weekly windows only.
//! - Codex, free file read: the newest `token_count` event with `rate_limits`
//!   in `~/.codex/sessions/**/rollout-*.jsonl` (written after every turn).
//! - Codex, probe: a short-lived `codex app-server` asked `account/read` and
//!   `account/rateLimits/read`. No turn, no rollout file.
//!
//! [`UsageMonitor`] runs the file reads every few seconds (re-parsing only on
//! change) and the probes rarely, only while the app is in use, with back-off.
//! Neither probe spends model usage.

use crate::model::Provider;
use crate::util::parse_rfc3339;
use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------- cadence

/// File sources are checked this often (cheap: a stat, re-parse on change).
const FILE_EVERY_MS: u64 = 10_000;
/// A probe runs when the newest data is older than this (and the app is in use).
const PROBE_AFTER_MS: u64 = 5 * 60_000;
/// First retry after a failed probe; doubles per failure up to [`BACKOFF_MAX_MS`].
const BACKOFF_MS: u64 = 60_000;
const BACKOFF_MAX_MS: u64 = 30 * 60_000;
/// Data older than this is flagged `stale`.
const STALE_MS: u64 = 15 * 60_000;
/// After the window loses focus, probes keep running this long.
const ACTIVE_GRACE_MS: u64 = 10 * 60_000;
/// A probe that has not answered by then is killed.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// How much of the end of a rollout file is searched for `rate_limits`.
const ROLLOUT_TAIL: u64 = 512 * 1024;
/// How many of the newest rollout files are searched.
const ROLLOUT_FILES: usize = 4;

// ---------------------------------------------------------------- model

/// One provider's plan usage, as the frontend receives it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanUsage {
    pub provider: Provider,
    /// Plan as the CLI reports it, e.g. "Max 5x", "Pro", "Plus".
    pub plan: Option<String>,
    /// Every limit the CLI reported, in its order.
    pub windows: Vec<UsageWindow>,
    /// Pay-as-you-go credits beyond the plan (Claude "extra usage", Codex credits).
    pub credits: Option<UsageCredits>,
    /// Codex only: free full resets (weekly + 5 h) the account can redeem.
    pub reset_credits: Option<u64>,
    /// When the newest number here was obtained (ms since epoch).
    pub fetched_ms: u64,
    /// Where the newest number came from: `claude.get_usage`, `claude.cache`,
    /// `claude.stream`, `codex.app_server` or `codex.rollout`.
    pub source: String,
    /// The data is older than 15 minutes.
    pub stale: bool,
    /// The last attempt to refresh failed (the data shown may still be valid).
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UsageWindow {
    /// Stable key: Claude `session`, `weekly_all`, `weekly_scoped:<Model>`;
    /// Codex `<limit_id>:primary`, `<limit_id>:secondary`, `<limit_id>:spend`.
    pub id: String,
    pub label: String,
    /// `session` | `weekly` | `spend` | the CLI's own kind for anything else.
    pub kind: String,
    /// 0-100. `None` once the window has reset since the reading.
    pub used_percent: Option<f64>,
    pub resets_ms: Option<u64>,
    pub window_minutes: Option<u64>,
    /// The model a per-model limit applies to (Claude "Fable", "Opus", ...).
    pub model: Option<String>,
    /// Claude only, as the CLI says it: `normal`, `warning`, `critical`, `limited`, ...
    pub severity: Option<String>,
    /// Claude only: the limit that currently binds (`is_active`).
    pub binding: Option<bool>,
    /// When this window's number was read (windows can come from different sources).
    pub as_of_ms: u64,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct UsageCredits {
    pub enabled: Option<bool>,
    pub unlimited: Option<bool>,
    /// Codex: remaining balance as the CLI reports it (a decimal string).
    pub balance: Option<String>,
    /// Claude extra usage this month, in `currency` units.
    pub used: Option<f64>,
    pub limit: Option<f64>,
    pub used_percent: Option<f64>,
    pub currency: Option<String>,
    pub detail: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn iso_ms(v: &Value) -> Option<u64> {
    parse_rfc3339(v.as_str()?).filter(|s| *s > 0).map(|s| s as u64 * 1000)
}

/// Epoch seconds (or ms, if it is that large) to ms.
fn epoch_ms(v: &Value) -> Option<u64> {
    let n = v.as_f64().or_else(|| v.as_str()?.parse().ok())?;
    if n <= 0.0 {
        return None;
    }
    Some(if n > 1e12 { n as u64 } else { (n * 1000.0) as u64 })
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str()?.trim().parse().ok())
}

/// `snake_case` or `camelCase` field, whichever is present.
fn field<'a>(v: &'a Value, snake: &str, camel: &str) -> &'a Value {
    match &v[snake] {
        Value::Null => &v[camel],
        x => x,
    }
}

fn title_case(s: &str) -> String {
    s.split(['_', '-', ' '])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect::<String>()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn window_label(minutes: u64) -> String {
    match minutes {
        300 => "5-hour".into(),
        10080 => "Weekly".into(),
        1440 => "Daily".into(),
        m if m % 1440 == 0 => format!("{}-day", m / 1440),
        m if m % 60 == 0 => format!("{}-hour", m / 60),
        m => format!("{m}-minute"),
    }
}

// ---------------------------------------------------------------- Claude parsers

fn claude_window(id: String, kind: &str, model: Option<String>, pct: Option<f64>, resets: Option<u64>, as_of: u64) -> UsageWindow {
    let (label, kind_out, minutes) = match kind {
        "session" => ("Current session".to_string(), "session", Some(300)),
        "weekly_all" => ("Weekly (all models)".to_string(), "weekly", Some(10080)),
        "weekly_scoped" => (format!("Weekly ({})", model.as_deref().unwrap_or("model")), "weekly", Some(10080)),
        other => (title_case(other), other, None),
    };
    UsageWindow {
        id,
        label,
        kind: kind_out.to_string(),
        used_percent: pct,
        resets_ms: resets,
        window_minutes: minutes,
        model,
        severity: None,
        binding: None,
        as_of_ms: as_of,
        detail: None,
    }
}

fn scoped_id(model: &str) -> String {
    format!("weekly_scoped:{model}")
}

/// The plan-usage object the CLI gets from its endpoint (the same shape in
/// `cachedUsageUtilization.utilization` and in `get_usage`'s `rate_limits`).
/// Prefers the `limits` array (kind, percent, severity, scope); falls back to
/// the named windows (`five_hour`, `seven_day`, `seven_day_opus`, ...).
pub fn parse_claude_limits(u: &Value, as_of: u64) -> (Vec<UsageWindow>, Option<UsageCredits>) {
    let mut out = Vec::new();
    if let Some(limits) = u["limits"].as_array().filter(|a| !a.is_empty()) {
        for l in limits {
            let Some(kind) = l["kind"].as_str() else { continue };
            let model = l["scope"]["model"]["display_name"].as_str().map(str::to_string);
            let surface = l["scope"]["surface"]["display_name"].as_str();
            let mut id = match (&model, kind) {
                (Some(m), "weekly_scoped") => scoped_id(m),
                (Some(m), k) => format!("{k}:{m}"),
                (None, k) => k.to_string(),
            };
            if let Some(s) = surface {
                id = format!("{id}@{s}");
            }
            let mut w = claude_window(id, kind, model, num(&l["percent"]), iso_ms(&l["resets_at"]), as_of);
            if let Some(s) = surface {
                w.label = format!("{} · {s}", w.label);
            }
            if kind != "session" && !kind.starts_with("weekly") {
                // Unknown meter: keep the server's group as the kind.
                if let Some(g) = l["group"].as_str() {
                    w.kind = g.to_string();
                }
            }
            w.severity = l["severity"].as_str().map(str::to_string);
            w.binding = l["is_active"].as_bool();
            out.push(w);
        }
    } else {
        let named = [("five_hour", "session", None), ("seven_day", "weekly_all", None), ("seven_day_opus", "weekly_scoped", Some("Opus")), ("seven_day_sonnet", "weekly_scoped", Some("Sonnet"))];
        for (key, kind, model) in named {
            let w = &u[key];
            if !w.is_object() {
                continue;
            }
            let id = model.map(scoped_id).unwrap_or_else(|| kind.to_string());
            out.push(claude_window(id, kind, model.map(str::to_string), num(&w["utilization"]), iso_ms(&w["resets_at"]), as_of));
        }
        for m in u["model_scoped"].as_array().into_iter().flatten() {
            let Some(name) = m["display_name"].as_str() else { continue };
            if out.iter().any(|w| w.id == scoped_id(name)) {
                continue;
            }
            out.push(claude_window(scoped_id(name), "weekly_scoped", Some(name.to_string()), num(&m["utilization"]), iso_ms(&m["resets_at"]), as_of));
        }
    }
    (out, parse_claude_credits(u))
}

fn parse_claude_credits(u: &Value) -> Option<UsageCredits> {
    let x = &u["extra_usage"];
    if !x.is_object() {
        return None;
    }
    // Amounts are in minor units when the CLI says how many decimal places.
    let scale = x["decimal_places"].as_u64().map(|d| 10f64.powi(d as i32)).unwrap_or(1.0);
    let enabled = x["is_enabled"].as_bool();
    let mut c = UsageCredits {
        enabled,
        used: num(&x["used_credits"]).map(|n| n / scale),
        limit: num(&x["monthly_limit"]).map(|n| n / scale),
        used_percent: num(&x["utilization"]),
        currency: x["currency"].as_str().map(str::to_string),
        ..Default::default()
    };
    if x["spend_limit_reached"].as_bool() == Some(true) {
        c.detail = Some("Monthly extra-usage limit reached".into());
    } else if enabled == Some(false) {
        c.detail = x["disabled_reason"].as_str().map(|r| format!("Off ({})", r.replace('_', " "))).or(Some("Off".into()));
    }
    Some(c)
}

/// Plan name from the CLI's profile fields or `get_usage`'s `subscription_type`.
fn claude_plan(org_type: Option<&str>, tier: Option<&str>, subscription: Option<&str>) -> Option<String> {
    let base = org_type
        .and_then(|t| t.strip_prefix("claude_"))
        .or(subscription)
        .filter(|s| !s.is_empty())
        .map(title_case);
    // `default_claude_max_5x` -> "5x".
    let mult = tier.and_then(|t| t.rsplit('_').next()).filter(|m| m.len() >= 2 && m.ends_with('x') && m[..m.len() - 1].bytes().all(|b| b.is_ascii_digit()));
    match (base, mult) {
        (Some(b), Some(m)) => Some(format!("{b} {m}")),
        (b, _) => b,
    }
}

/// Plan fields of the CLI's profile cache; nothing else is deserialized.
#[derive(Deserialize, Default)]
struct OauthAccount {
    #[serde(rename = "accountUuid")]
    account_uuid: Option<String>,
    #[serde(rename = "organizationType")]
    organization_type: Option<String>,
    #[serde(rename = "organizationRateLimitTier")]
    rate_limit_tier: Option<String>,
}

#[derive(Deserialize, Default)]
struct ClaudeConfig {
    #[serde(rename = "oauthAccount")]
    oauth_account: Option<OauthAccount>,
    #[serde(rename = "cachedUsageUtilization")]
    cached_usage: Option<Value>,
}

/// A full Claude reading (all windows at one time).
#[derive(Clone, Debug, PartialEq)]
struct ClaudeReading {
    as_of: u64,
    source: &'static str,
    windows: Vec<UsageWindow>,
    credits: Option<UsageCredits>,
    plan: Option<String>,
    /// e.g. "plan limits do not apply" for API-key sessions.
    note: Option<String>,
}

/// `~/.claude.json`: the usage cache (if it belongs to the signed-in account)
/// and the plan. `Ok(None)` when the CLI has never cached usage.
fn parse_claude_config(bytes: &[u8]) -> Result<(Option<ClaudeReading>, Option<String>)> {
    let cfg: ClaudeConfig = serde_json::from_slice(bytes).context("unreadable ~/.claude.json")?;
    let acct = cfg.oauth_account.unwrap_or_default();
    let plan = claude_plan(acct.organization_type.as_deref(), acct.rate_limit_tier.as_deref(), None);
    let Some(c) = cfg.cached_usage.filter(Value::is_object) else { return Ok((None, plan)) };
    // The CLI itself ignores a cache written for another account.
    if let (Some(a), Some(b)) = (acct.account_uuid.as_deref(), c["accountUuid"].as_str())
        && a != b
    {
        return Ok((None, plan));
    }
    let Some(as_of) = c["fetchedAtMs"].as_u64() else { return Ok((None, plan)) };
    let (windows, credits) = parse_claude_limits(&c["utilization"], as_of);
    Ok((Some(ClaudeReading { as_of, source: "claude.cache", windows, credits, plan: plan.clone(), note: None }), plan))
}

/// The `response` of a `get_usage` control response.
fn parse_claude_get_usage(r: &Value, as_of: u64) -> Result<ClaudeReading> {
    if !r.is_object() {
        bail!("get_usage: unexpected answer");
    }
    let sub = r["subscription_type"].as_str();
    let plan = claude_plan(None, None, sub);
    if r["rate_limits_available"].as_bool() == Some(false) || r["rate_limits"].is_null() {
        let note = if sub.is_none() { "Plan limits don't apply to this sign-in (API key or cloud provider)" } else { "The CLI could not read plan limits" };
        return Ok(ClaudeReading { as_of, source: "claude.get_usage", windows: vec![], credits: None, plan, note: Some(note.into()) });
    }
    let (windows, credits) = parse_claude_limits(&r["rate_limits"], as_of);
    Ok(ClaudeReading { as_of, source: "claude.get_usage", windows, credits, plan, note: None })
}

/// A stream-json `rate_limit_event` (`rate_limit_info`): utilization is a
/// fraction there, resets are epoch seconds.
fn parse_claude_rate_limit_event(info: &Value, as_of: u64) -> Vec<UsageWindow> {
    let sev = |s: &Value| {
        s.as_str().map(|s| match s {
            "allowed" => "normal".to_string(),
            "allowed_warning" => "warning".to_string(),
            "rejected" => "limited".to_string(),
            o => o.to_string(),
        })
    };
    let map = |key: &str| -> Option<(String, &'static str, Option<String>)> {
        Some(match key {
            "five_hour" => ("session".into(), "session", None),
            "seven_day" => ("weekly_all".into(), "weekly_all", None),
            "seven_day_opus" => (scoped_id("Opus"), "weekly_scoped", Some("Opus".into())),
            "seven_day_sonnet" => (scoped_id("Sonnet"), "weekly_scoped", Some("Sonnet".into())),
            _ => return None,
        })
    };
    let mut out = Vec::new();
    if let Some(ws) = info["unifiedWindows"].as_object() {
        for (key, w) in ws {
            let Some((id, kind, model)) = map(key) else { continue };
            let pct = num(&w["utilization"]).map(|f| (f * 1000.0).round() / 10.0);
            let mut win = claude_window(id, kind, model, pct, epoch_ms(&w["resetsAt"]), as_of);
            win.severity = sev(&w["status"]);
            out.push(win);
        }
    } else if let (Some((id, kind, model)), Some(u)) = (info["rateLimitType"].as_str().and_then(map), num(&info["utilization"])) {
        let mut win = claude_window(id, kind, model, Some((u * 1000.0).round() / 10.0), epoch_ms(&info["resetsAt"]), as_of);
        win.severity = sev(&info["status"]);
        out.push(win);
    }
    out
}

static CLAUDE_LIVE: Mutex<Option<(u64, Vec<UsageWindow>)>> = Mutex::new(None);

/// Feed a stream-json `rate_limit_event` line (the whole object) seen by a
/// structured Claude chat. Free: it rides on a turn the person is running.
pub fn observe_claude_rate_limit_event(v: &Value) {
    let ws = parse_claude_rate_limit_event(&v["rate_limit_info"], now_ms());
    if !ws.is_empty() {
        *CLAUDE_LIVE.lock().unwrap() = Some((now_ms(), ws));
    }
}

// ---------------------------------------------------------------- Codex parsers

/// A Codex rate-limit snapshot (rollout `rate_limits`, snake_case, or the
/// app-server's `RateLimitSnapshot`, camelCase): windows, credits, plan.
pub fn parse_codex_snapshot(s: &Value, as_of: u64) -> (Vec<UsageWindow>, Option<UsageCredits>, Option<String>) {
    let limit_id = field(s, "limit_id", "limitId").as_str().unwrap_or("codex").to_string();
    let limit_name = field(s, "limit_name", "limitName").as_str().map(str::to_string);
    let prefix = if limit_id == "codex" { None } else { Some(limit_name.clone().unwrap_or_else(|| title_case(&limit_id))) };
    let reached = field(s, "rate_limit_reached_type", "rateLimitReachedType").as_str().map(|r| r.replace('_', " "));
    let mut out = Vec::new();
    for slot in ["primary", "secondary"] {
        let w = &s[slot];
        if !w.is_object() {
            continue;
        }
        let minutes = field(w, "window_minutes", "windowDurationMins").as_u64();
        let base = minutes.map(window_label).unwrap_or_else(|| title_case(slot));
        let label = match &prefix {
            Some(p) => format!("{p} · {base}"),
            None => base,
        };
        let kind = match minutes {
            Some(300) => "session",
            Some(10080) => "weekly",
            _ => slot,
        };
        let pct = num(field(w, "used_percent", "usedPercent"));
        out.push(UsageWindow {
            id: format!("{limit_id}:{slot}"),
            label,
            kind: kind.into(),
            used_percent: pct,
            resets_ms: epoch_ms(field(w, "resets_at", "resetsAt")),
            window_minutes: minutes,
            model: None,
            severity: None,
            binding: None,
            as_of_ms: as_of,
            detail: reached.clone().filter(|_| pct.is_some_and(|p| p >= 100.0)),
        });
    }
    let sc = field(s, "individual_limit", "individualLimit");
    if sc.is_object() {
        let remaining = num(field(sc, "remaining_percent", "remainingPercent"));
        let detail = match (sc["used"].as_str(), sc["limit"].as_str()) {
            (Some(u), Some(l)) => Some(format!("{u} of {l}")),
            _ => None,
        };
        out.push(UsageWindow {
            id: format!("{limit_id}:spend"),
            label: "Spend limit".into(),
            kind: "spend".into(),
            used_percent: remaining.map(|r| (100.0 - r).max(0.0)),
            resets_ms: epoch_ms(field(sc, "resets_at", "resetsAt")),
            window_minutes: None,
            model: None,
            severity: None,
            binding: None,
            as_of_ms: as_of,
            detail,
        });
    }
    let c = &s["credits"];
    let credits = c.is_object().then(|| UsageCredits {
        enabled: field(c, "has_credits", "hasCredits").as_bool(),
        unlimited: c["unlimited"].as_bool(),
        balance: c["balance"].as_str().map(str::to_string).or_else(|| num(&c["balance"]).map(|n| n.to_string())),
        ..Default::default()
    });
    let plan = field(s, "plan_type", "planType").as_str().map(codex_plan);
    (out, credits, plan)
}

fn codex_plan(p: &str) -> String {
    match p {
        "plus" => "Plus".into(),
        "pro" => "Pro".into(),
        "prolite" => "Pro Lite".into(),
        "go" => "Go".into(),
        "free" => "Free".into(),
        "edu" => "Edu".into(),
        o => title_case(o),
    }
}

/// The newest `token_count` events with a non-empty `rate_limits`, one per
/// `limit_id`: `(record time ms, snapshot)`.
fn codex_rollout_limits(text: &str) -> HashMap<String, (u64, Value)> {
    let mut out: HashMap<String, (u64, Value)> = HashMap::new();
    for line in text.lines() {
        if !line.contains("\"rate_limits\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let p = &v["payload"];
        if v["type"] != "event_msg" || p["type"] != "token_count" {
            continue;
        }
        let rl = &p["rate_limits"];
        if !(rl["primary"].is_object() || rl["secondary"].is_object()) {
            continue;
        }
        let Some(ts) = iso_ms(&v["timestamp"]) else { continue };
        let id = rl["limit_id"].as_str().unwrap_or("codex").to_string();
        if out.get(&id).is_none_or(|(t, _)| ts >= *t) {
            out.insert(id, (ts, rl.clone()));
        }
    }
    out
}

// ---------------------------------------------------------------- file sources

fn claude_config_path() -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        Some(d) => Some(PathBuf::from(d).join(".claude.json")),
        None => dirs::home_dir().map(|h| h.join(".claude.json")),
    }
}

fn codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME").filter(|h| !h.is_empty()).map(PathBuf::from).or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
}

type Sig = Option<(SystemTime, u64)>;

fn sig(p: &Path) -> Sig {
    let m = std::fs::metadata(p).ok()?;
    Some((m.modified().ok()?, m.len()))
}

/// Children of `dir` whose names are all digits, highest first.
fn numeric_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<(String, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            (!n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())).then(|| (n, e.path()))
        })
        .collect();
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v.into_iter().map(|(_, p)| p).collect()
}

/// The newest rollout files under `sessions/YYYY/MM/DD`, newest first (last
/// three day folders that exist).
fn recent_rollouts(sessions: &Path) -> Vec<(PathBuf, SystemTime, u64)> {
    let mut days = Vec::new();
    'outer: for y in numeric_dirs(sessions) {
        for m in numeric_dirs(&y) {
            for d in numeric_dirs(&m) {
                days.push(d);
                if days.len() >= 3 {
                    break 'outer;
                }
            }
        }
    }
    let mut files: Vec<(PathBuf, SystemTime, u64)> = days
        .iter()
        .flat_map(|d| std::fs::read_dir(d).into_iter().flatten().flatten())
        .filter(|e| {
            let n = e.file_name();
            let n = n.to_string_lossy();
            n.starts_with("rollout-") && n.ends_with(".jsonl")
        })
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((e.path(), m.modified().ok()?, m.len()))
        })
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.1));
    files.truncate(ROLLOUT_FILES);
    files
}

fn read_tail(p: &Path, n: u64) -> std::io::Result<String> {
    let mut f = std::fs::File::open(p)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(n);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf)?;
    let mut s = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        // Drop the partial first line.
        s = s.split_once('\n').map(|(_, r)| r.to_string()).unwrap_or_default();
    }
    Ok(s)
}

// ---------------------------------------------------------------- probes

/// Scratch folder the probes run in, so no project folder is involved.
fn scratch_dir() -> Result<PathBuf> {
    let d = std::env::temp_dir().join("coool-usage");
    std::fs::create_dir_all(&d).context("create scratch folder")?;
    Ok(d)
}

/// Spawn `program`, write `lines`, collect stdout JSON lines until `done`
/// says so or the timeout passes, then close stdin and make sure the process
/// group is gone.
fn run_probe(program: &str, args: &[&str], envs: &[(&str, &str)], lines: &[Value], mut done: impl FnMut(&Value) -> bool) -> Result<()> {
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(scratch_dir()?).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    cmd.process_group(0);
    let mut child = cmd.spawn().with_context(|| format!("couldn't run `{program}` (is it installed and on PATH?)"))?;
    let pid = child.id() as libc::pid_t;
    let kill_group = || unsafe {
        libc::killpg(pid, libc::SIGKILL);
    };
    let mut stdin = child.stdin.take().context("stdin")?;
    let stdout = child.stdout.take().context("stdout")?;
    let (tx, rx) = mpsc::channel::<Value>();
    let reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Ok(v) = serde_json::from_str::<Value>(&line)
                && tx.send(v).is_err()
            {
                break;
            }
        }
    });
    let mut write_err = None;
    for l in lines {
        if let Err(e) = stdin.write_all(format!("{l}\n").as_bytes()).and_then(|_| stdin.flush()) {
            write_err = Some(e);
            break;
        }
    }
    let deadline = std::time::Instant::now() + PROBE_TIMEOUT;
    let mut finished = false;
    if write_err.is_none() {
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match rx.recv_timeout(left) {
                Ok(v) => {
                    if done(&v) {
                        finished = true;
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    }
    // EOF on stdin ends both CLIs; give them a moment, then make sure.
    drop(stdin);
    let exit_by = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < exit_by => thread::sleep(Duration::from_millis(50)),
            _ => {
                kill_group();
                let _ = child.wait();
                break;
            }
        }
    }
    // Anything it left behind in its group.
    kill_group();
    drop(rx);
    let _ = reader.join();
    if let Some(e) = write_err {
        return Err(anyhow!("`{program}` exited early: {e}"));
    }
    if !finished {
        bail!("`{program}` did not answer within {}s", PROBE_TIMEOUT.as_secs());
    }
    Ok(())
}

/// Hidden `claude -p` asked for `get_usage`. No prompt is sent, so no model
/// turn runs; hooks and MCP servers are kept off; no session file is written.
fn probe_claude() -> Result<ClaudeReading> {
    let args = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--model",
        "haiku",
        "--strict-mcp-config",
        "--settings",
        r#"{"disableAllHooks":true}"#,
    ];
    let req = json!({"type": "control_request", "request_id": "coool-usage", "request": {"subtype": "get_usage", "skip_behaviors": true}});
    let mut answer = None;
    run_probe("claude", &args, &[("DISABLE_AUTOUPDATER", "1")], &[req], |v| {
        if v["type"] == "control_response" && v["response"]["request_id"] == "coool-usage" {
            answer = Some(v["response"].clone());
            return true;
        }
        false
    })?;
    let r = answer.context("no answer")?;
    if r["subtype"] != "success" {
        bail!("claude: {}", r["error"].as_str().unwrap_or("get_usage failed"));
    }
    parse_claude_get_usage(&r["response"], now_ms())
}

/// The app-server's answers to `account/read` (id 2) and
/// `account/rateLimits/read` (id 3).
#[derive(Clone, Debug, PartialEq)]
struct CodexProbe {
    as_of: u64,
    plan: Option<String>,
    note: Option<String>,
    buckets: HashMap<String, Value>,
    reset_credits: Option<u64>,
}

fn parse_codex_app_server(account: &Value, limits: &Value, as_of: u64) -> Result<CodexProbe> {
    let acct = &account["account"];
    let plan = acct["planType"].as_str().map(codex_plan);
    let note = match acct["type"].as_str() {
        Some("chatgpt") | None => None,
        Some(_) => Some("Plan limits don't apply to this sign-in (API key or cloud provider)".to_string()),
    };
    let mut buckets = HashMap::new();
    if let Some(m) = limits["rateLimitsByLimitId"].as_object() {
        for (k, v) in m {
            buckets.insert(k.clone(), v.clone());
        }
    }
    if buckets.is_empty() && limits["rateLimits"].is_object() {
        let s = &limits["rateLimits"];
        buckets.insert(s["limitId"].as_str().unwrap_or("codex").to_string(), s.clone());
    }
    if buckets.is_empty() && note.is_none() && limits.is_null() {
        bail!("codex: no rate limits in the answer");
    }
    let reset_credits = limits["rateLimitResetCredits"]["availableCount"].as_u64();
    Ok(CodexProbe { as_of, plan, note, buckets, reset_credits })
}

fn probe_codex() -> Result<CodexProbe> {
    let info = json!({"name": "coool", "title": "coool", "version": env!("CARGO_PKG_VERSION")});
    let lines = [
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"clientInfo": info, "capabilities": null}}),
        json!({"jsonrpc": "2.0", "method": "initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "account/read", "params": {"refreshToken": false}}),
        json!({"jsonrpc": "2.0", "id": 3, "method": "account/rateLimits/read", "params": null}),
    ];
    let (mut account, mut limits, mut err) = (None, None, None);
    run_probe("codex", &["app-server"], &[], &lines, |v| {
        let id = v["id"].as_u64();
        if let Some(e) = v.get("error").filter(|e| !e.is_null())
            && matches!(id, Some(2 | 3))
        {
            err = Some(e["message"].as_str().unwrap_or("request failed").to_string());
            return true;
        }
        match id {
            Some(2) => account = Some(v["result"].clone()),
            Some(3) => limits = Some(v["result"].clone()),
            _ => {}
        }
        account.is_some() && limits.is_some()
    })?;
    if let Some(e) = err {
        bail!("codex: {e}");
    }
    parse_codex_app_server(&account.unwrap_or(Value::Null), &limits.unwrap_or(Value::Null), now_ms())
}

// ---------------------------------------------------------------- monitor

#[derive(Default)]
struct Sched {
    last_file_ms: u64,
    file_sig: Sig,
    file_busy: bool,
    probe_busy: bool,
    next_probe_ms: u64,
    failures: u32,
    error: Option<String>,
    forced: bool,
}

impl Sched {
    fn probe_failed(&mut self, now: u64, e: String) {
        self.failures += 1;
        let back = BACKOFF_MS.saturating_mul(1 << (self.failures - 1).min(10)).min(BACKOFF_MAX_MS);
        self.next_probe_ms = now + back;
        self.error = Some(e);
    }
    fn probe_ok(&mut self, now: u64) {
        self.failures = 0;
        self.next_probe_ms = now + PROBE_AFTER_MS;
        self.error = None;
    }
}

#[derive(Default)]
struct ClaudeState {
    sched: Sched,
    /// Newest full reading (cache file or probe).
    full: Option<ClaudeReading>,
    /// Plan from the profile, for when the reading does not carry one.
    profile_plan: Option<String>,
    live: Option<(u64, Vec<UsageWindow>)>,
}

#[derive(Default)]
struct CodexState {
    sched: Sched,
    /// Per `limit_id`: newest snapshot, when, and from where.
    buckets: HashMap<String, (u64, &'static str, Value)>,
    plan: Option<(u64, String)>,
    note: Option<String>,
    reset_credits: Option<u64>,
    rollout_files: Vec<(PathBuf, SystemTime, u64)>,
}

#[derive(Default)]
struct Inner {
    claude: ClaudeState,
    codex: CodexState,
    /// Last time the app was in use (focused); 0 = never told, treated as in use.
    active_until_ms: u64,
    focused: bool,
}

/// Keeps both providers' plan usage fresh. Every method returns at once; the
/// work runs on short-lived background threads.
#[derive(Clone)]
pub struct UsageMonitor {
    inner: Arc<Mutex<Inner>>,
    probes: bool,
}

impl Default for UsageMonitor {
    fn default() -> Self {
        Self::new()
    }
}

impl UsageMonitor {
    /// Probes on, app treated as in use until [`set_active`](Self::set_active) says otherwise.
    pub fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(Inner { focused: true, ..Default::default() })), probes: true }
    }

    /// Off: only the free file sources are read (probes never spawn, even on
    /// [`refresh_now`](Self::refresh_now)).
    pub fn set_probes(&mut self, on: bool) {
        self.probes = on;
    }

    /// Whether the app is in use (window focused). Probes keep running for ten
    /// minutes after focus is lost, then pause; file reads never pause.
    pub fn set_active(&self, focused: bool) {
        let mut g = self.inner.lock().unwrap();
        if g.focused && !focused {
            g.active_until_ms = now_ms() + ACTIVE_GRACE_MS;
        }
        g.focused = focused;
    }

    /// Ask for a probe of `provider` at the next [`tick`](Self::tick), past
    /// any back-off and regardless of focus.
    pub fn refresh_now(&self, provider: Provider) {
        let mut g = self.inner.lock().unwrap();
        let s = match provider {
            Provider::Claude => &mut g.claude.sched,
            Provider::Codex => &mut g.codex.sched,
        };
        s.forced = true;
        s.last_file_ms = 0;
        drop(g);
        self.tick();
    }

    /// Start whatever is due. Cheap; call it after each `Hub::refresh`.
    pub fn tick(&self) {
        let now = now_ms();
        let mut g = self.inner.lock().unwrap();
        if let Some(l) = CLAUDE_LIVE.lock().unwrap().clone()
            && g.claude.live.as_ref().is_none_or(|(t, _)| l.0 > *t)
        {
            g.claude.live = Some(l);
        }
        let active = g.focused || now < g.active_until_ms;
        for p in [Provider::Claude, Provider::Codex] {
            let (fetched, any_reset_passed) = {
                let u = Self::compose(&g, p, now);
                (u.as_ref().map(|u| u.fetched_ms), u.is_some_and(|u| u.windows.iter().any(|w| w.used_percent.is_none() && w.resets_ms.is_some())))
            };
            let s = match p {
                Provider::Claude => &mut g.claude.sched,
                Provider::Codex => &mut g.codex.sched,
            };
            if !s.file_busy && now.saturating_sub(s.last_file_ms) >= FILE_EVERY_MS {
                s.file_busy = true;
                s.last_file_ms = now;
                let me = self.clone();
                thread::spawn(move || me.read_files(p));
            }
            let old = fetched.is_none_or(|f| now.saturating_sub(f) >= PROBE_AFTER_MS) || any_reset_passed;
            let due = s.forced || (active && old && now >= s.next_probe_ms);
            // Let the first file read land before deciding a probe is needed.
            let files_seen = s.file_sig.is_some() || s.last_file_ms + 1000 < now || s.forced;
            if self.probes && due && files_seen && !s.probe_busy {
                s.probe_busy = true;
                s.forced = false;
                let me = self.clone();
                thread::spawn(move || me.probe(p));
            } else if !self.probes {
                s.forced = false;
            }
        }
    }

    pub fn get(&self, provider: Provider) -> Option<PlanUsage> {
        let g = self.inner.lock().unwrap();
        Self::compose(&g, provider, now_ms())
    }

    fn read_files(&self, p: Provider) {
        match p {
            Provider::Claude => {
                let path = claude_config_path();
                let cur = path.as_deref().and_then(sig);
                let changed = self.inner.lock().unwrap().claude.sched.file_sig != cur;
                let parsed = match (&path, changed && cur.is_some()) {
                    (Some(path), true) => std::fs::read(path).ok().and_then(|b| parse_claude_config(&b).ok()),
                    _ => None,
                };
                let mut g = self.inner.lock().unwrap();
                let c = &mut g.claude;
                c.sched.file_busy = false;
                c.sched.file_sig = cur;
                if let Some((reading, plan)) = parsed {
                    c.profile_plan = plan;
                    if let Some(r) = reading
                        && c.full.as_ref().is_none_or(|f| r.as_of > f.as_of)
                    {
                        c.full = Some(r);
                    }
                }
            }
            Provider::Codex => {
                let files = codex_home().map(|h| recent_rollouts(&h.join("sessions"))).unwrap_or_default();
                let unchanged = self.inner.lock().unwrap().codex.rollout_files == files;
                let mut found: HashMap<String, (u64, Value)> = HashMap::new();
                if !unchanged {
                    for (path, _, _) in &files {
                        let Ok(text) = read_tail(path, ROLLOUT_TAIL) else { continue };
                        for (id, (t, v)) in codex_rollout_limits(&text) {
                            if found.get(&id).is_none_or(|(ft, _)| t > *ft) {
                                found.insert(id, (t, v));
                            }
                        }
                    }
                }
                let mut g = self.inner.lock().unwrap();
                let c = &mut g.codex;
                c.sched.file_busy = false;
                // A marker so the first-read gate opens even with no files.
                c.sched.file_sig = Some((SystemTime::UNIX_EPOCH, files.len() as u64));
                c.rollout_files = files;
                for (id, (t, v)) in found {
                    if let Some(pl) = v["plan_type"].as_str()
                        && c.plan.as_ref().is_none_or(|(pt, _)| t >= *pt)
                    {
                        c.plan = Some((t, codex_plan(pl)));
                    }
                    if c.buckets.get(&id).is_none_or(|(bt, _, _)| t > *bt) {
                        c.buckets.insert(id, (t, "codex.rollout", v));
                    }
                }
            }
        }
    }

    fn probe(&self, p: Provider) {
        match p {
            Provider::Claude => {
                let r = probe_claude();
                let now = now_ms();
                let mut g = self.inner.lock().unwrap();
                let c = &mut g.claude;
                c.sched.probe_busy = false;
                match r {
                    Ok(r) => {
                        c.sched.probe_ok(now);
                        c.full = Some(r);
                    }
                    Err(e) => c.sched.probe_failed(now, format!("{e:#}")),
                }
            }
            Provider::Codex => {
                let r = probe_codex();
                let now = now_ms();
                let mut g = self.inner.lock().unwrap();
                let c = &mut g.codex;
                c.sched.probe_busy = false;
                match r {
                    Ok(r) => {
                        c.sched.probe_ok(now);
                        if let Some(pl) = r.plan {
                            c.plan = Some((r.as_of, pl));
                        }
                        c.note = r.note;
                        c.reset_credits = r.reset_credits;
                        for (id, v) in r.buckets {
                            c.buckets.insert(id, (r.as_of, "codex.app_server", v));
                        }
                    }
                    Err(e) => c.sched.probe_failed(now, format!("{e:#}")),
                }
            }
        }
    }

    fn compose(g: &Inner, p: Provider, now: u64) -> Option<PlanUsage> {
        let mut u = match p {
            Provider::Claude => {
                let c = &g.claude;
                let mut u = match &c.full {
                    Some(f) => PlanUsage {
                        provider: p,
                        // The profile names the tier ("Max 5x"), `get_usage` only the family.
                        plan: c.profile_plan.clone().or_else(|| f.plan.clone()),
                        windows: f.windows.clone(),
                        credits: f.credits.clone(),
                        reset_credits: None,
                        fetched_ms: f.as_of,
                        source: f.source.into(),
                        stale: false,
                        error: c.sched.error.clone().or_else(|| f.note.clone()),
                    },
                    None if c.sched.error.is_some() || c.live.is_some() => PlanUsage {
                        provider: p,
                        plan: c.profile_plan.clone(),
                        windows: vec![],
                        credits: None,
                        reset_credits: None,
                        fetched_ms: 0,
                        source: String::new(),
                        stale: false,
                        error: c.sched.error.clone(),
                    },
                    None => return None,
                };
                // Newer live numbers win, window by window.
                if let Some((t, live)) = &c.live
                    && *t > u.fetched_ms
                {
                    for lw in live {
                        match u.windows.iter_mut().find(|w| w.id == lw.id) {
                            Some(w) => {
                                w.used_percent = lw.used_percent;
                                w.resets_ms = lw.resets_ms.or(w.resets_ms);
                                w.severity = lw.severity.clone().or(w.severity.take());
                                w.as_of_ms = lw.as_of_ms;
                            }
                            None => u.windows.push(lw.clone()),
                        }
                    }
                    u.fetched_ms = *t;
                    u.source = "claude.stream".into();
                }
                u
            }
            Provider::Codex => {
                let c = &g.codex;
                if c.buckets.is_empty() && c.sched.error.is_none() && c.note.is_none() {
                    return None;
                }
                let mut ids: Vec<&String> = c.buckets.keys().collect();
                // `codex` first, then the rest by name.
                ids.sort_by_key(|k| (k.as_str() != "codex", k.as_str()));
                let (mut windows, mut credits, mut fetched, mut source) = (Vec::new(), None, 0, "");
                for id in ids {
                    let (t, src, v) = &c.buckets[id];
                    let (ws, cr, _) = parse_codex_snapshot(v, *t);
                    windows.extend(ws);
                    if credits.is_none() || id == "codex" {
                        credits = cr.or(credits);
                    }
                    if *t >= fetched {
                        fetched = *t;
                        source = src;
                    }
                }
                PlanUsage {
                    provider: p,
                    plan: c.plan.as_ref().map(|(_, p)| p.clone()),
                    windows,
                    credits,
                    reset_credits: c.reset_credits,
                    fetched_ms: fetched,
                    source: source.into(),
                    stale: false,
                    error: c.sched.error.clone().or_else(|| c.note.clone()),
                }
            }
        };
        finish(&mut u, now);
        Some(u)
    }
}

/// Flags staleness and blanks windows that have reset since they were read.
fn finish(u: &mut PlanUsage, now: u64) {
    u.stale = u.fetched_ms == 0 || now.saturating_sub(u.fetched_ms) > STALE_MS;
    for w in &mut u.windows {
        if w.resets_ms.is_some_and(|r| r <= now) && w.used_percent.is_some() {
            w.used_percent = None;
            w.detail = Some("Reset since the last reading".into());
        }
    }
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = include_str!("usage_fixtures/claude_config.json");
    const GET_USAGE: &str = include_str!("usage_fixtures/claude_get_usage.json");
    const APP_SERVER: &str = include_str!("usage_fixtures/codex_app_server.jsonl");
    const ROLLOUT: &str = include_str!("usage_fixtures/codex_rollout_tail.jsonl");

    fn win<'a>(ws: &'a [UsageWindow], id: &str) -> &'a UsageWindow {
        ws.iter().find(|w| w.id == id).unwrap_or_else(|| panic!("no window {id} in {ws:?}"))
    }

    #[test]
    fn claude_config_cache_and_plan() {
        let (r, plan) = parse_claude_config(CONFIG.as_bytes()).unwrap();
        assert_eq!(plan.as_deref(), Some("Max 5x"));
        let r = r.unwrap();
        assert_eq!(r.source, "claude.cache");
        assert_eq!(r.as_of, 1794671937605);
        let ids: Vec<&str> = r.windows.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, ["session", "weekly_all", "weekly_scoped:Fable"]);
        let s = win(&r.windows, "session");
        assert_eq!(s.used_percent, Some(89.0));
        assert_eq!(s.window_minutes, Some(300));
        assert_eq!(s.binding, Some(true));
        assert_eq!(s.severity.as_deref(), Some("warning"));
        assert_eq!(s.resets_ms, Some(parse_rfc3339("2026-11-14T18:00:00Z").unwrap() as u64 * 1000));
        let f = win(&r.windows, "weekly_scoped:Fable");
        assert_eq!((f.used_percent, f.model.as_deref(), f.label.as_str(), f.kind.as_str()), (Some(10.0), Some("Fable"), "Weekly (Fable)", "weekly"));
        let c = r.credits.unwrap();
        assert_eq!(c.enabled, Some(false));
    }

    #[test]
    fn claude_config_for_another_account_is_ignored() {
        let mut v: Value = serde_json::from_str(CONFIG).unwrap();
        v["oauthAccount"]["accountUuid"] = json!("someone-else");
        let (r, plan) = parse_claude_config(&serde_json::to_vec(&v).unwrap()).unwrap();
        assert!(r.is_none());
        assert!(plan.is_some());
        let (r, plan) = parse_claude_config(br#"{"numStartups":1}"#).unwrap();
        assert!(r.is_none() && plan.is_none());
        assert!(parse_claude_config(b"not json").is_err());
    }

    #[test]
    fn claude_get_usage_answer() {
        let v: Value = serde_json::from_str(GET_USAGE).unwrap();
        assert_eq!(v["response"]["request_id"], "u1");
        let r = parse_claude_get_usage(&v["response"]["response"], 42).unwrap();
        assert_eq!(r.plan.as_deref(), Some("Max"));
        assert_eq!(r.windows.len(), 3);
        assert_eq!(win(&r.windows, "session").used_percent, Some(89.0));
        assert_eq!(win(&r.windows, "session").severity.as_deref(), Some("warning"));
        assert_eq!(win(&r.windows, "weekly_all").used_percent, Some(24.0));
        assert!(r.windows.iter().all(|w| w.as_of_ms == 42));
        assert!(r.note.is_none());
    }

    #[test]
    fn claude_get_usage_without_plan_limits() {
        let r = parse_claude_get_usage(&json!({"subscription_type": null, "rate_limits_available": false, "rate_limits": null}), 1).unwrap();
        assert!(r.windows.is_empty() && r.plan.is_none());
        assert!(r.note.unwrap().contains("don't apply"));
        assert!(parse_claude_get_usage(&Value::Null, 1).is_err());
    }

    #[test]
    fn claude_named_windows_fallback() {
        let u = json!({
            "five_hour": {"utilization": 12.5, "resets_at": "2026-11-14T18:00:00+00:00"},
            "seven_day": {"utilization": 40, "resets_at": "2026-11-17T04:00:00+00:00"},
            "seven_day_opus": null,
            "seven_day_sonnet": {"utilization": 7, "resets_at": null},
            "model_scoped": [{"display_name": "Fable", "utilization": 3, "resets_at": "2026-11-17T04:00:00+00:00"}],
            "extra_usage": {"is_enabled": true, "monthly_limit": 5000, "used_credits": 1250, "utilization": 25, "currency": "USD", "decimal_places": 2}
        });
        let (ws, c) = parse_claude_limits(&u, 1);
        let ids: Vec<&str> = ws.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, ["session", "weekly_all", "weekly_scoped:Sonnet", "weekly_scoped:Fable"]);
        assert_eq!(ws[0].used_percent, Some(12.5));
        assert_eq!(ws[2].resets_ms, None);
        let c = c.unwrap();
        assert_eq!((c.used, c.limit, c.used_percent, c.currency.as_deref()), (Some(12.5), Some(50.0), Some(25.0), Some("USD")));
    }

    #[test]
    fn claude_unknown_limit_kinds_are_kept() {
        let u = json!({"limits": [{"kind": "monthly_all", "group": "monthly", "percent": 5, "resets_at": null, "severity": "normal", "scope": {"model": null, "surface": {"display_name": "Desktop"}}, "is_active": false}]});
        let (ws, _) = parse_claude_limits(&u, 1);
        assert_eq!(ws[0].id, "monthly_all@Desktop");
        assert_eq!(ws[0].kind, "monthly");
        assert_eq!(ws[0].label, "Monthly All · Desktop");
        assert_eq!(ws[0].window_minutes, None);
    }

    #[test]
    fn claude_rate_limit_event() {
        // From crates/core/src/chat/fixtures/claude_permission_subagent.jsonl.
        let info = json!({"status":"allowed","resetsAt":1794661200,"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false,
            "unifiedWindows":{"five_hour":{"utilization":0.67,"resetsAt":1794661200,"status":"allowed"},"seven_day":{"utilization":0.09,"resetsAt":1794888000,"status":"allowed_warning"},"mystery":{"utilization":0.5}}});
        let ws = parse_claude_rate_limit_event(&info, 7);
        assert_eq!(ws.len(), 2);
        let s = win(&ws, "session");
        assert_eq!((s.used_percent, s.resets_ms, s.severity.as_deref()), (Some(67.0), Some(1794661200000), Some("normal")));
        assert_eq!(win(&ws, "weekly_all").severity.as_deref(), Some("warning"));
        // Older CLIs: just the binding window at the top level.
        let ws = parse_claude_rate_limit_event(&json!({"status":"rejected","rateLimitType":"seven_day","utilization":1.0,"resetsAt":1794888000}), 7);
        assert_eq!((ws[0].id.as_str(), ws[0].used_percent, ws[0].severity.as_deref()), ("weekly_all", Some(100.0), Some("limited")));
        assert!(parse_claude_rate_limit_event(&json!({"status":"allowed"}), 7).is_empty());
    }

    #[test]
    fn claude_plan_names() {
        assert_eq!(claude_plan(Some("claude_max"), Some("default_claude_max_20x"), None).as_deref(), Some("Max 20x"));
        assert_eq!(claude_plan(Some("claude_pro"), Some("default_claude_ai"), None).as_deref(), Some("Pro"));
        assert_eq!(claude_plan(None, None, Some("team")).as_deref(), Some("Team"));
        assert_eq!(claude_plan(None, None, None), None);
    }

    #[test]
    fn codex_rollout_newest_per_limit() {
        let extra = r#"{"timestamp":"2026-11-14T15:10:00.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{}}}
{"timestamp":"2026-11-14T15:11:00.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex_bengal","limit_name":"GPT-Bengal","primary":{"used_percent":40.0,"window_minutes":300,"resets_at":1794679069},"secondary":null}}}
{"timestamp":"2026-11-14T15:12:00.000Z","type":"response_item","payload":{"type":"message","content":"talking about \"rate_limits\""}}
not json"#;
        let text = format!("{ROLLOUT}{extra}\n");
        let m = codex_rollout_limits(&text);
        assert_eq!(m.len(), 2);
        let (t, v) = &m["codex"];
        assert_eq!(*t, parse_rfc3339("2026-11-14T14:57:50Z").unwrap() as u64 * 1000);
        let (ws, credits, plan) = parse_codex_snapshot(v, *t);
        assert_eq!(plan.as_deref(), Some("Plus"));
        assert_eq!(ws.len(), 2);
        let p = win(&ws, "codex:primary");
        assert_eq!((p.label.as_str(), p.kind.as_str(), p.used_percent, p.window_minutes, p.resets_ms), ("5-hour", "session", Some(0.0), Some(300), Some(1794679069000)));
        let s = win(&ws, "codex:secondary");
        assert_eq!((s.label.as_str(), s.used_percent), ("Weekly", Some(5.0)));
        let c = credits.unwrap();
        assert_eq!((c.enabled, c.unlimited, c.balance.as_deref()), (Some(false), Some(false), Some("0")));
        let (ws, _, _) = parse_codex_snapshot(&m["codex_bengal"].1, 1);
        assert_eq!(ws.len(), 1);
        assert_eq!(ws[0].id, "codex_bengal:primary");
        assert_eq!(ws[0].label, "GPT-Bengal · 5-hour");
    }

    #[test]
    fn codex_app_server_answers() {
        let lines: Vec<Value> = APP_SERVER.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        let by_id = |id: u64| lines.iter().find(|v| v["id"] == id).unwrap()["result"].clone();
        let r = parse_codex_app_server(&by_id(2), &by_id(3), 9).unwrap();
        assert_eq!(r.plan.as_deref(), Some("Plus"));
        assert_eq!(r.reset_credits, Some(3));
        assert!(r.note.is_none());
        let (ws, credits, plan) = parse_codex_snapshot(&r.buckets["codex"], r.as_of);
        assert_eq!(plan.as_deref(), Some("Plus"));
        assert_eq!(win(&ws, "codex:secondary").used_percent, Some(5.0));
        assert_eq!(win(&ws, "codex:secondary").window_minutes, Some(10080));
        assert_eq!(credits.unwrap().balance.as_deref(), Some("0"));
    }

    #[test]
    fn codex_spend_control_and_api_key_accounts() {
        let snap = json!({"limitId":"codex","primary":{"usedPercent":100,"windowDurationMins":300,"resetsAt":1794679070},"individualLimit":{"limit":"50.00","used":"20.00","remainingPercent":60,"resetsAt":1794741408},"rateLimitReachedType":"rate_limit_reached"});
        let (ws, _, _) = parse_codex_snapshot(&snap, 1);
        assert_eq!(ws[0].detail.as_deref(), Some("rate limit reached"));
        let sp = win(&ws, "codex:spend");
        assert_eq!((sp.used_percent, sp.detail.as_deref()), (Some(40.0), Some("20.00 of 50.00")));
        let r = parse_codex_app_server(&json!({"account":{"type":"apiKey"},"requiresOpenaiAuth":true}), &json!({"rateLimits":{}}), 1).unwrap();
        assert!(r.note.is_some() && r.plan.is_none());
    }

    #[test]
    fn compose_merges_live_and_flags_resets() {
        let now = 1_800_000_000_000;
        let mut g = Inner::default();
        let (ws, credits) = parse_claude_limits(&serde_json::from_str::<Value>(GET_USAGE).unwrap()["response"]["response"]["rate_limits"], now - 20 * 60_000);
        g.claude.full = Some(ClaudeReading { as_of: now - 20 * 60_000, source: "claude.get_usage", windows: ws, credits, plan: Some("Max".into()), note: None });
        let u = UsageMonitor::compose(&g, Provider::Claude, now).unwrap();
        assert!(u.stale);
        // All three fixture windows reset before `now`.
        assert!(u.windows.iter().all(|w| w.used_percent.is_none() && w.detail.is_some()));
        let mut live = claude_window("session".into(), "session", None, Some(5.0), Some(now + 3_600_000), now - 1000);
        live.severity = Some("normal".into());
        g.claude.live = Some((now - 1000, vec![live]));
        let u = UsageMonitor::compose(&g, Provider::Claude, now).unwrap();
        assert!(!u.stale);
        assert_eq!(u.source, "claude.stream");
        assert_eq!(win(&u.windows, "session").used_percent, Some(5.0));
        assert_eq!(win(&u.windows, "session").as_of_ms, now - 1000);
        assert_eq!(u.windows.len(), 3);
        assert!(UsageMonitor::compose(&Inner::default(), Provider::Codex, now).is_none());
    }

    #[test]
    fn backoff_doubles_and_caps() {
        let mut s = Sched::default();
        s.probe_failed(0, "x".into());
        assert_eq!(s.next_probe_ms, BACKOFF_MS);
        s.probe_failed(0, "x".into());
        assert_eq!(s.next_probe_ms, 2 * BACKOFF_MS);
        for _ in 0..20 {
            s.probe_failed(0, "x".into());
        }
        assert_eq!(s.next_probe_ms, BACKOFF_MAX_MS);
        s.probe_ok(5);
        assert_eq!((s.failures, s.error.clone(), s.next_probe_ms), (0, None, 5 + PROBE_AFTER_MS));
    }

    #[test]
    fn plan_usage_json_shape() {
        let (ws, credits, plan) = parse_codex_snapshot(&codex_rollout_limits(ROLLOUT)["codex"].1, 1);
        let u = PlanUsage { provider: Provider::Codex, plan, windows: ws, credits, reset_credits: Some(3), fetched_ms: 1, source: "codex.rollout".into(), stale: false, error: None };
        let v = serde_json::to_value(&u).unwrap();
        assert_eq!(v["provider"], "codex");
        assert_eq!(v["windows"][0]["used_percent"], 0.0);
        assert!(v["windows"][0]["model"].is_null());
        let back: PlanUsage = serde_json::from_value(v).unwrap();
        assert_eq!(back, u);
    }
}
