//! What a Ladder lead may plan with, and what coool refuses (pure; the app gathers the inputs).
//!
//! - [`report`]: the `budget` tool's answer: the lead's model, each account's plan, every limit window with its use
//!   and reset time, the models on each provider with a relative cost, whether image generation is available, the
//!   machine's load, the helpers running and the parallel cap that follows from all of it.
//! - [`preflight`]: the `can` tool: before an image or cross-provider request (or a `spawn`), yes or no, with the
//!   reason and what to do instead. Nothing is sent when it says no.
//! - [`spawn_check`]: the `spawn` tool's limits: depth, concurrency, model (never above the caller), budget and
//!   permissions (never wider than the caller's; Bypass only when the caller runs in it and the person allowed it for
//!   helpers).

use super::{ImageLane, Ladder, rank};
use crate::model::Provider;
use crate::usage::PlanUsage;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Above this share of a window used, the lead plans narrow (fewer, cheaper helpers).
pub const TIGHT_PERCENT: f64 = 80.0;
/// Default reserve: requests and spawns on a provider stop when any of its windows has less than this left.
pub const DEFAULT_RESERVE: f64 = 10.0;

/// Whether one CLI can be used from here.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Cli {
    pub installed: bool,
    /// `codex --version` / `claude --version`.
    pub version: Option<String>,
    /// From the CLI's own status command (`codex login status`, `claude auth status`); None: unknown.
    pub logged_in: Option<bool>,
}

/// Whether this Codex can generate images: read from its own feature list (`codex features list`, which spends no
/// usage), cached by coool per Codex version.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ImageCap {
    /// The Codex version it was checked on.
    pub version: Option<String>,
    /// `image_generation` is on in that version; None: not checked.
    pub available: Option<bool>,
}

/// `image_generation` from `codex features list` output (`name  stage  enabled` per line).
pub fn parse_image_feature(features: &str) -> Option<bool> {
    features.lines().find_map(|l| {
        let mut w = l.split_whitespace();
        (w.next()? == "image_generation").then(|| l.split_whitespace().last() == Some("true"))
    })
}

/// The machine, as coool reads it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Load {
    /// 1-minute load average.
    pub load1: f64,
    pub cores: u32,
    /// `nominal`, `fair`, `serious`, `critical`.
    pub thermal: String,
    pub low_power: bool,
    pub on_battery: Option<bool>,
    pub battery_pct: Option<u8>,
}

impl Load {
    /// Busy enough that fewer parallel helpers is kinder (and faster per helper).
    pub fn strained(&self) -> bool {
        (self.cores > 0 && self.load1 > self.cores as f64 * 1.5) || matches!(self.thermal.as_str(), "serious" | "critical") || self.low_power || (self.on_battery == Some(true) && self.battery_pct.is_some_and(|p| p < 20))
    }
}

/// Everything the tools answer from.
#[derive(Clone, Debug)]
pub struct Inputs {
    pub now_ms: u64,
    /// The calling chat's CLI and the model it runs on (as reported; may be an alias or empty).
    pub provider: Provider,
    pub model: String,
    pub ladder: Ladder,
    pub claude: Cli,
    pub codex: Cli,
    pub usage_claude: Option<PlanUsage>,
    pub usage_codex: Option<PlanUsage>,
    pub image: ImageCap,
    pub load: Load,
    /// Helpers coool's `spawn` is running now (all chats).
    pub running: u32,
    /// Settings > Ladder "Keep in reserve" (percent of every window).
    pub reserve: f64,
}

impl Inputs {
    fn cli(&self, p: Provider) -> &Cli {
        match p {
            Provider::Claude => &self.claude,
            Provider::Codex => &self.codex,
        }
    }
    fn usage(&self, p: Provider) -> Option<&PlanUsage> {
        match p {
            Provider::Claude => self.usage_claude.as_ref(),
            Provider::Codex => self.usage_codex.as_ref(),
        }
    }
    /// The fullest window of a provider: (used percent, its label, when it resets).
    pub fn fullest(&self, p: Provider) -> Option<(f64, String, Option<u64>)> {
        let u = self.usage(p)?;
        u.windows.iter().filter_map(|w| w.used_percent.map(|x| (x, w.label.clone(), w.resets_ms))).max_by(|a, b| a.0.total_cmp(&b.0))
    }
    /// The parallel cap now: the setting, halved when the machine is strained, down to 1 when the lead's own
    /// provider is tight.
    pub fn cap(&self) -> u32 {
        let mut c = self.ladder.max_parallel.max(1);
        if self.load.strained() {
            c = (c / 2).max(1);
        }
        if self.fullest(self.provider).is_some_and(|f| f.0 >= TIGHT_PERCENT) {
            c = 1;
        }
        c
    }
}

/// "in 2 h 5 min" / "in 3 days" from now to `at`.
pub fn until(now_ms: u64, at: u64) -> String {
    let m = at.saturating_sub(now_ms) / 60_000;
    if m < 60 {
        format!("in {m} min")
    } else if m < 48 * 60 {
        format!("in {} h {} min", m / 60, m % 60)
    } else {
        format!("in {} days", m / (24 * 60))
    }
}

/// The relative cost of a model within its provider: 1 (cheapest) to 5.
fn cost(p: Provider, model: &str) -> Option<u8> {
    let r = rank(p, model)?;
    Some(match p {
        Provider::Claude => r.saturating_sub(1).max(1),
        Provider::Codex => r + 1,
    })
}

fn account(i: &Inputs, p: Provider) -> Value {
    let cli = i.cli(p);
    let u = i.usage(p);
    let windows: Vec<Value> = u
        .map(|u| {
            u.windows
                .iter()
                .map(|w| {
                    json!({
                        "window": w.label,
                        "used_percent": w.used_percent,
                        "resets": w.resets_ms.map(|r| until(i.now_ms, r)),
                        "resets_ms": w.resets_ms,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "installed": cli.installed,
        "version": cli.version,
        "logged_in": cli.logged_in,
        "plan": u.and_then(|u| u.plan.clone()),
        "windows": windows,
        "usage_error": u.and_then(|u| u.error.clone()),
    })
}

fn models(i: &Inputs) -> Value {
    let own = |t: &super::Tier, p: Provider| json!({ "role": t.role.word(), "model": t.model, "label": t.label, "provider": p.label(), "relative_cost": cost(p, &t.model) });
    let other = match i.provider {
        Provider::Claude => Provider::Codex,
        Provider::Codex => Provider::Claude,
    };
    let mut v: Vec<Value> = i.ladder.tiers.iter().map(|t| own(t, i.provider)).collect();
    v.extend(i.ladder.cross.iter().map(|t| own(t, other)));
    Value::Array(v)
}

/// The `budget` tool's answer.
pub fn report(i: &Inputs) -> Value {
    let img = preflight(i, Lane::Image);
    let advice = advice(i);
    json!({
        "lead": { "provider": i.provider.label(), "model": if i.model.is_empty() { i.ladder.lead.clone() } else { i.model.clone() }, "relative_cost": cost(i.provider, &i.model) },
        "accounts": { "claude": account(i, Provider::Claude), "codex": account(i, Provider::Codex) },
        "models": models(i),
        "image_generation": { "available": img.ok, "lane": i.ladder.image.as_ref().map(|l| format!("{} {}", l.provider.label(), l.model)), "why": img.reason },
        "load": { "load1": (i.load.load1 * 100.0).round() / 100.0, "cores": i.load.cores, "thermal": i.load.thermal, "low_power": i.load.low_power, "on_battery": i.load.on_battery, "strained": i.load.strained() },
        "helpers": { "running": i.running, "parallel_cap_now": i.cap(), "max_depth": i.ladder.depth, "your_depth": i.ladder.helper.map(|h| h.depth).unwrap_or(0) },
        "reserve_percent": i.reserve,
        "advice": advice,
    })
}

/// One line of planning advice from the numbers (the playbook's section 7, applied).
fn advice(i: &Inputs) -> String {
    let mut out = Vec::new();
    let other = match i.provider {
        Provider::Claude => Provider::Codex,
        Provider::Codex => Provider::Claude,
    };
    match i.fullest(i.provider) {
        Some((x, w, r)) if x >= 100.0 - i.reserve => out.push(format!("{} {w} is at {x:.0}% (reserve {:.0}%): don't start new work on it; resets {}", i.provider.label(), i.reserve, r.map(|r| until(i.now_ms, r)).unwrap_or("at an unknown time".into()))),
        Some((x, w, _)) if x >= TIGHT_PERCENT => out.push(format!("{} {w} is at {x:.0}%: plan narrow (cheaper tiers, one helper at a time)", i.provider.label())),
        Some((x, _, _)) if x < 50.0 => out.push(format!("{} has room ({x:.0}% used at most)", i.provider.label())),
        _ => {}
    }
    if !i.ladder.cross.is_empty() || i.ladder.image.is_some() {
        match i.fullest(other) {
            Some((x, w, r)) if x >= 100.0 - i.reserve => out.push(format!("{} {w} is at {x:.0}%: no {} lanes until it resets {}", other.label(), other.label(), r.map(|r| until(i.now_ms, r)).unwrap_or("later".into()))),
            Some((x, _, _)) if x < 50.0 => out.push(format!("{} has room ({x:.0}%): move suitable pieces there when {} is tight", other.label(), i.provider.label())),
            _ => {}
        }
    }
    if i.load.strained() {
        out.push("the machine is busy or hot: fewer parallel helpers".into());
    }
    out.push(format!("parallel cap now: {}", i.cap()));
    out.join("; ")
}

/// What a request needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lane {
    /// An image through the image lane.
    Image,
    /// Any request on this provider (a cross-provider lane, or a spawn on it).
    Provider(Provider),
}

impl Lane {
    pub fn parse(s: &str) -> Option<Lane> {
        match s.trim().to_lowercase().as_str() {
            "image" | "images" | "image_generation" => Some(Lane::Image),
            "codex" | "gpt" | "openai" => Some(Lane::Provider(Provider::Codex)),
            "claude" | "anthropic" => Some(Lane::Provider(Provider::Claude)),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Verdict {
    pub ok: bool,
    pub reason: String,
    /// What to do instead (empty when ok).
    pub instead: String,
}

fn no(reason: impl Into<String>, instead: impl Into<String>) -> Verdict {
    Verdict { ok: false, reason: reason.into(), instead: instead.into() }
}

/// Whether a provider can take a request now: installed, logged in, and its fullest window under the reserve.
fn provider_ok(i: &Inputs, p: Provider, instead: &str) -> Verdict {
    let name = match p {
        Provider::Claude => "Claude Code",
        Provider::Codex => "Codex",
    };
    let cli = i.cli(p);
    if !cli.installed {
        return no(format!("{name} is not installed on this Mac"), instead);
    }
    if cli.logged_in == Some(false) {
        return no(format!("{name} is installed but not logged in"), format!("ask the person to log in to {name} in a terminal; meanwhile {instead}"));
    }
    if let Some((x, w, r)) = i.fullest(p)
        && x >= 100.0 - i.reserve
    {
        let when = r.map(|r| until(i.now_ms, r)).unwrap_or_else(|| "at an unknown time".into());
        return no(format!("{name} usage too low: {w} is at {x:.0}% used (coool keeps {:.0}% in reserve); it resets {when}", i.reserve), format!("{instead}, or wait for the reset ({when})"));
    }
    Verdict { ok: true, reason: format!("{name} is ready"), instead: String::new() }
}

/// The `can` tool.
pub fn preflight(i: &Inputs, lane: Lane) -> Verdict {
    match lane {
        Lane::Image => {
            const INSTEAD: &str = "draw an SVG yourself, or leave a placeholder and say so";
            let Some(ImageLane { provider, .. }) = &i.ladder.image else {
                return no("image generation is off for this chat (Settings > Ladder), or no provider here can generate images", INSTEAD);
            };
            if *provider != Provider::Codex {
                return no("only Codex generates images here", INSTEAD);
            }
            let v = provider_ok(i, Provider::Codex, INSTEAD);
            if !v.ok {
                return v;
            }
            match i.image.available {
                Some(true) if i.image.version.is_some() && i.image.version == i.codex.version => Verdict { ok: true, reason: format!("Codex {} has its built-in image tool", i.image.version.as_deref().unwrap_or("")), instead: String::new() },
                Some(true) => no("this Codex was updated since its image tool was checked; coool is checking again", "try `can` again in a minute"),
                Some(false) => no(format!("this Codex version ({}) has no image generation tool", i.image.version.as_deref().unwrap_or("unknown")), INSTEAD),
                None => no("coool has not checked Codex's image tool yet", "try `can` again in a minute"),
            }
        }
        Lane::Provider(p) => {
            let instead = if p == i.provider { "do the piece yourself or on a cheaper tier" } else { "use a helper on your own provider, or do it yourself" };
            provider_ok(i, p, instead)
        }
    }
}

/// A `spawn` request, as the caller asked.
#[derive(Clone, Debug, Deserialize)]
pub struct SpawnReq {
    /// `claude` or `codex` (default: the caller's).
    #[serde(default)]
    pub provider: Option<Provider>,
    pub model: String,
}

/// The caller of `spawn`.
#[derive(Clone, Debug)]
pub struct Caller {
    /// Its permission mode as the CLI reports it (`default`, `acceptEdits`, `untrusted`, ...).
    pub mode: String,
    /// The person allowed Bypass for helpers (Settings > Ladder); only matters when the caller runs in it.
    pub allow_bypass: bool,
}

/// What coool starts the helper with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnPlan {
    pub provider: Provider,
    pub model: String,
    pub permission_mode: String,
    pub depth: u32,
}

/// How much a permission mode lets a chat do without asking: 0 plans only, 1 asks, 2 edits without asking,
/// 3 does anything (Bypass / Full access).
pub fn mode_level(p: Provider, mode: &str) -> u8 {
    match (p, mode) {
        (Provider::Claude, "plan") => 0,
        (Provider::Claude, "acceptEdits" | "auto") => 2,
        (Provider::Claude, "bypassPermissions") => 3,
        (Provider::Codex, "on-request" | "on-failure") => 2,
        (Provider::Codex, "never") => 3,
        // default, dontAsk, manual, untrusted, unknown: asks.
        _ => 1,
    }
}

/// The helper's mode at a level, in its CLI's words.
pub fn mode_at(p: Provider, level: u8) -> &'static str {
    match (p, level) {
        (Provider::Claude, 0) => "plan",
        (Provider::Claude, 1) => "default",
        (Provider::Claude, 2) => "acceptEdits",
        (Provider::Claude, _) => "bypassPermissions",
        (Provider::Codex, 0 | 1) => "untrusted",
        (Provider::Codex, 2) => "on-request",
        (Provider::Codex, _) => "never",
    }
}

/// Whether `to` (on `to_p`) is at or below the caller's model (on `from_p`). Same provider: by rank. Across:
/// Codex's top (sol/astra) sits with Sonnet, so a Claude caller may use Codex models one rank below its own, and a
/// Codex caller Claude models at or below its rank. An unknown caller model counts as its CLI's usual default
/// (Opus-class for Claude, the top for Codex).
pub fn within(from_p: Provider, from: &str, to_p: Provider, to: &str) -> bool {
    let f = rank(from_p, from).unwrap_or(match from_p {
        Provider::Claude => 4,
        Provider::Codex => 3,
    });
    let Some(t) = rank(to_p, to) else { return false };
    match (from_p, to_p) {
        (a, b) if a == b => t <= f,
        (Provider::Claude, Provider::Codex) => t < f,
        _ => t <= f,
    }
}

/// The `spawn` tool's limits, in order: depth, model, provider (installed, logged in, budget), concurrency,
/// permissions. Err: the refusal, in words the lead can pass on.
pub fn spawn_check(i: &Inputs, req: &SpawnReq, caller: &Caller) -> Result<SpawnPlan, String> {
    let at = i.ladder.helper.map(|h| h.depth).unwrap_or(0);
    if at + 1 > i.ladder.depth {
        return Err(format!("refused: depth limit ({} of {}): do this piece yourself", at, i.ladder.depth));
    }
    let p = req.provider.unwrap_or(i.provider);
    if req.model.trim().is_empty() {
        return Err("refused: name the helper's model explicitly".into());
    }
    if !within(i.provider, &i.model, p, &req.model) {
        return Err(format!("refused: `{}` is above your model (`{}`); pick one at or below it", req.model, if i.model.is_empty() { "the CLI default" } else { &i.model }));
    }
    let v = preflight(i, Lane::Provider(p));
    if !v.ok {
        return Err(format!("refused: {}; instead: {}", v.reason, v.instead));
    }
    let cap = i.cap();
    if i.running >= cap {
        return Err(format!("refused: {} helpers already running, the cap now is {cap} (machine load and usage); wait for one with `wait`, or do it yourself", i.running));
    }
    let lvl = mode_level(i.provider, &caller.mode);
    let lvl = if lvl >= 3 && !caller.allow_bypass { 2 } else { lvl };
    Ok(SpawnPlan { provider: p, model: req.model.clone(), permission_mode: mode_at(p, lvl).to_string(), depth: at + 1 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ladder::{HelperOf, Role, Tier};
    use crate::usage::UsageWindow;

    fn win(label: &str, used: f64, resets: u64) -> UsageWindow {
        UsageWindow { id: label.into(), label: label.into(), kind: String::new(), used_percent: Some(used), resets_ms: Some(resets), window_minutes: None, model: None, severity: None, binding: None, as_of_ms: 0, detail: None }
    }
    fn usage(p: Provider, plan: &str, used: f64) -> PlanUsage {
        PlanUsage { provider: p, plan: Some(plan.into()), windows: vec![win("5-hour", used, 3_600_000 * 3), win("Weekly", used / 2.0, 3_600_000 * 72)], credits: None, reset_credits: None, reset_credits_expire_ms: None, fetched_ms: 0, source: String::new(), stale: false, error: None }
    }
    fn ok_cli() -> Cli {
        Cli { installed: true, version: Some("0.171.0".into()), logged_in: Some(true) }
    }
    fn inputs() -> Inputs {
        Inputs {
            now_ms: 0,
            provider: Provider::Claude,
            model: "claude-opus-5-5".into(),
            ladder: Ladder {
                lead: "Opus 5.5".into(),
                tiers: vec![Tier { role: Role::Same, model: "opus".into(), label: "Opus 5.5".into() }, Tier { role: Role::Mid, model: "sonnet".into(), label: "Sonnet 5.5".into() }, Tier { role: Role::Small, model: "haiku".into(), label: "Haiku 5.5".into() }],
                cross: vec![Tier { role: Role::Exec, model: "gpt-6.2-sol".into(), label: "GPT-6.2-Sol".into() }],
                image: Some(ImageLane { provider: Provider::Codex, model: "gpt-6-luna".into(), label: "GPT-6-Luna".into() }),
                tools: true,
                ..Default::default()
            },
            claude: ok_cli(),
            codex: ok_cli(),
            usage_claude: Some(usage(Provider::Claude, "Max 5x", 27.0)),
            usage_codex: Some(usage(Provider::Codex, "Plus", 4.0)),
            image: ImageCap { version: Some("0.171.0".into()), available: Some(true) },
            load: Load { load1: 3.0, cores: 12, thermal: "nominal".into(), ..Default::default() },
            running: 0,
            reserve: DEFAULT_RESERVE,
        }
    }

    #[test]
    fn report_has_plans_windows_resets_models_image_and_load() {
        let r = report(&inputs());
        assert_eq!(r["lead"]["model"], "claude-opus-5-5");
        assert_eq!(r["accounts"]["claude"]["plan"], "Max 5x");
        assert_eq!(r["accounts"]["codex"]["plan"], "Plus");
        assert_eq!(r["accounts"]["claude"]["windows"][0]["used_percent"], 27.0);
        assert_eq!(r["accounts"]["claude"]["windows"][0]["resets"], "in 3 h 0 min");
        assert_eq!(r["accounts"]["codex"]["windows"][1]["resets"], "in 3 days");
        let models = r["models"].as_array().unwrap();
        assert_eq!(models.len(), 4);
        assert_eq!(models[0]["role"], "same");
        assert_eq!(models[3]["provider"], "codex");
        assert_eq!(models[2]["relative_cost"], 1, "haiku is the cheapest Claude");
        assert_eq!(r["image_generation"]["available"], true);
        assert_eq!(r["load"]["cores"], 12);
        assert_eq!(r["helpers"]["parallel_cap_now"], 4);
        assert!(r["advice"].as_str().unwrap().contains("claude has room"), "{}", r["advice"]);
        // Nothing secret: no tokens, emails or paths.
        let s = r.to_string();
        assert!(!s.contains('@') && !s.contains("/Users/"), "{s}");
    }

    #[test]
    fn cap_shrinks_with_load_and_a_tight_window() {
        let mut i = inputs();
        assert_eq!(i.cap(), 4);
        i.load.load1 = 40.0;
        assert_eq!(i.cap(), 2);
        i.load = Load { thermal: "serious".into(), cores: 12, ..Default::default() };
        assert_eq!(i.cap(), 2);
        i.load = Load { cores: 12, ..Default::default() };
        i.usage_claude = Some(usage(Provider::Claude, "Max 5x", 85.0));
        assert_eq!(i.cap(), 1);
        assert!(report(&i)["advice"].as_str().unwrap().contains("plan narrow"));
    }

    #[test]
    fn image_preflight_yes_and_every_refusal() {
        let i = inputs();
        assert!(preflight(&i, Lane::Image).ok);
        // Not installed.
        let mut a = inputs();
        a.codex.installed = false;
        let v = preflight(&a, Lane::Image);
        assert!(!v.ok && v.reason.contains("not installed") && v.instead.contains("SVG"), "{v:?}");
        // Not logged in.
        let mut b = inputs();
        b.codex.logged_in = Some(false);
        let v = preflight(&b, Lane::Image);
        assert!(!v.ok && v.reason.contains("not logged in") && v.instead.contains("log in"), "{v:?}");
        // No image tool in this version.
        let mut c = inputs();
        c.image.available = Some(false);
        let v = preflight(&c, Lane::Image);
        assert!(!v.ok && v.reason.contains("no image generation tool"), "{v:?}");
        // Checked on an older version: not trusted until re-checked.
        let mut d = inputs();
        d.codex.version = Some("0.172.0".into());
        assert!(!preflight(&d, Lane::Image).ok);
        // Not checked yet.
        let mut e = inputs();
        e.image.available = None;
        assert!(preflight(&e, Lane::Image).reason.contains("not checked"));
        // Usage too low: says when it resets and offers waiting.
        let mut f = inputs();
        f.usage_codex = Some(usage(Provider::Codex, "Plus", 93.0));
        let v = preflight(&f, Lane::Image);
        assert!(!v.ok && v.reason.contains("usage too low") && v.reason.contains("resets in 3 h") && v.instead.contains("wait for the reset"), "{v:?}");
        // A declared reserve: 4% used but 97% kept back.
        let mut g = inputs();
        g.reserve = 97.0;
        assert!(preflight(&g, Lane::Image).reason.contains("usage too low"));
        // Lane off.
        let mut h = inputs();
        h.ladder.image = None;
        assert!(preflight(&h, Lane::Image).reason.contains("off for this chat"));
    }

    #[test]
    fn provider_preflight() {
        let i = inputs();
        assert!(preflight(&i, Lane::Provider(Provider::Codex)).ok);
        let mut j = inputs();
        j.claude.installed = false;
        assert!(preflight(&j, Lane::Provider(Provider::Claude)).reason.contains("Claude Code is not installed"));
        assert_eq!(Lane::parse("image"), Some(Lane::Image));
        assert_eq!(Lane::parse("GPT"), Some(Lane::Provider(Provider::Codex)));
        assert_eq!(Lane::parse("nope"), None);
    }

    #[test]
    fn features_list_parses() {
        let t = "image_detail_original                    removed            false\nimage_generation                         stable             true\nimage_generation_animation               under development  false\n";
        assert_eq!(parse_image_feature(t), Some(true));
        assert_eq!(parse_image_feature("image_generation   stable   false"), Some(false));
        assert_eq!(parse_image_feature("apps  stable  true"), None);
    }

    fn caller(mode: &str) -> Caller {
        Caller { mode: mode.into(), allow_bypass: false }
    }

    #[test]
    fn spawn_within_limits() {
        let i = inputs();
        let p = spawn_check(&i, &SpawnReq { provider: None, model: "haiku".into() }, &caller("acceptEdits")).unwrap();
        assert_eq!(p, SpawnPlan { provider: Provider::Claude, model: "haiku".into(), permission_mode: "acceptEdits".into(), depth: 1 });
        // The lead's own tier is allowed (for parallel work).
        assert!(spawn_check(&i, &SpawnReq { provider: None, model: "opus".into() }, &caller("default")).is_ok());
        // Cross-provider, permissions mapped to Codex's words.
        let c = spawn_check(&i, &SpawnReq { provider: Some(Provider::Codex), model: "gpt-6-luna".into() }, &caller("default")).unwrap();
        assert_eq!(c.permission_mode, "untrusted");
        let c = spawn_check(&i, &SpawnReq { provider: Some(Provider::Codex), model: "gpt-6-luna".into() }, &caller("acceptEdits")).unwrap();
        assert_eq!(c.permission_mode, "on-request");
    }

    #[test]
    fn spawn_refusals() {
        // Depth.
        let mut d = inputs();
        d.ladder.helper = Some(HelperOf { parent: 0, depth: 2 });
        let e = spawn_check(&d, &SpawnReq { provider: None, model: "haiku".into() }, &caller("default")).unwrap_err();
        assert!(e.contains("depth limit (2 of 2)"), "{e}");
        // A model above the caller's.
        let mut h = inputs();
        h.model = "claude-haiku-5-5".into();
        let e = spawn_check(&h, &SpawnReq { provider: None, model: "sonnet".into() }, &caller("default")).unwrap_err();
        assert!(e.contains("above your model"), "{e}");
        // Haiku may use Codex's smallest, not its top.
        assert!(spawn_check(&h, &SpawnReq { provider: Some(Provider::Codex), model: "gpt-6-luna".into() }, &caller("default")).is_ok());
        assert!(spawn_check(&h, &SpawnReq { provider: Some(Provider::Codex), model: "gpt-6.2-sol".into() }, &caller("default")).is_err());
        // No model named.
        assert!(spawn_check(&inputs(), &SpawnReq { provider: None, model: " ".into() }, &caller("default")).unwrap_err().contains("explicitly"));
        // Concurrency (cap 4).
        let mut c = inputs();
        c.running = 4;
        assert!(spawn_check(&c, &SpawnReq { provider: None, model: "haiku".into() }, &caller("default")).unwrap_err().contains("4 helpers already running"));
        // Budget: the caller's provider declared too low.
        let mut b = inputs();
        b.reserve = 80.0;
        let e = spawn_check(&b, &SpawnReq { provider: None, model: "haiku".into() }, &caller("default")).unwrap_err();
        assert!(e.contains("usage too low") && e.contains("resets in"), "{e}");
        // Not installed.
        let mut n = inputs();
        n.codex.installed = false;
        assert!(spawn_check(&n, &SpawnReq { provider: Some(Provider::Codex), model: "gpt-6-luna".into() }, &caller("default")).unwrap_err().contains("not installed"));
    }

    #[test]
    fn spawn_never_widens_permissions() {
        let i = inputs();
        for (mode, want) in [("plan", "plan"), ("default", "default"), ("dontAsk", "default"), ("acceptEdits", "acceptEdits")] {
            assert_eq!(spawn_check(&i, &SpawnReq { provider: None, model: "haiku".into() }, &caller(mode)).unwrap().permission_mode, want, "{mode}");
        }
        // Bypass only when the person allowed it for helpers.
        let b = spawn_check(&i, &SpawnReq { provider: None, model: "haiku".into() }, &caller("bypassPermissions")).unwrap();
        assert_eq!(b.permission_mode, "acceptEdits");
        let b = spawn_check(&i, &SpawnReq { provider: None, model: "haiku".into() }, &Caller { mode: "bypassPermissions".into(), allow_bypass: true }).unwrap();
        assert_eq!(b.permission_mode, "bypassPermissions");
        // Allowing it never lifts a caller that isn't in Bypass.
        let b = spawn_check(&i, &SpawnReq { provider: None, model: "haiku".into() }, &Caller { mode: "default".into(), allow_bypass: true }).unwrap();
        assert_eq!(b.permission_mode, "default");
        // A Codex caller in Full access → a Claude helper never gets Bypass unless allowed.
        let mut x = inputs();
        x.provider = Provider::Codex;
        x.model = "gpt-6.2-sol".into();
        let p = spawn_check(&x, &SpawnReq { provider: Some(Provider::Claude), model: "haiku".into() }, &caller("never")).unwrap();
        assert_eq!(p.permission_mode, "acceptEdits");
        for l in 0..=3 {
            for p in [Provider::Claude, Provider::Codex] {
                assert!(mode_level(p, mode_at(p, l)) <= l.max(1), "{p:?} {l}");
            }
        }
    }

    #[test]
    fn within_ranks() {
        assert!(within(Provider::Claude, "claude-fable-5-2", Provider::Claude, "opus"));
        assert!(within(Provider::Claude, "claude-fable-5-2", Provider::Codex, "gpt-6.2-astra"));
        assert!(within(Provider::Claude, "claude-opus-5-5", Provider::Codex, "gpt-6.2-astra"));
        assert!(!within(Provider::Claude, "sonnet", Provider::Codex, "gpt-6.2-sol"));
        assert!(within(Provider::Claude, "sonnet", Provider::Codex, "gpt-6.1-terra"));
        assert!(within(Provider::Codex, "gpt-6.2-sol", Provider::Claude, "sonnet"));
        assert!(!within(Provider::Codex, "gpt-6.2-sol", Provider::Claude, "opus"));
        assert!(!within(Provider::Codex, "gpt-6-luna", Provider::Claude, "haiku"));
        // Unknown caller model: the CLI's usual default.
        assert!(within(Provider::Claude, "", Provider::Claude, "opus"));
        assert!(!within(Provider::Claude, "", Provider::Claude, "fable"));
        assert!(!within(Provider::Claude, "opus", Provider::Claude, "mystery-model"));
    }
}
