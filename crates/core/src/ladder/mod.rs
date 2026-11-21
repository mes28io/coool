//! Ladder (APP_SPEC "Ladder"): the chat's own model leads, plans and checks. Helpers on the cheapest tier that can
//! carry each piece do the work, several at once, on either provider. Helpers may have helpers of their own, and big
//! jobs switch to swarm mode.
//!
//! coool hands each chat it starts a short policy at launch, through the CLIs' own per-launch mechanisms, and never
//! through the person's config or the project's files:
//!
//! - Claude Code: `--append-system-prompt=<policy>` (always loaded: the lead, the tier table with both providers'
//!   lanes and the image lane, and the hard rules), `--plugin-dir=<coool's data dir>/ladder-plugin/coool-ladder`, a
//!   plugin coool owns whose one skill (`coool-ladder:playbook`) holds the full playbook (only its one-line
//!   description is loaded until the lead invokes it), and `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=<depth>` (Claude
//!   Code's own limit for sub-agents that start sub-agents).
//! - Codex: `developerInstructions` on `thread/start` / `thread/resume` (after any `developer_instructions` from the
//!   person's config, read with `config/read`), plus `-c agents.max_threads=<n>`, `-c agents.max_depth=<depth>` and
//!   `-c agents.default_subagent_model=<small tier>`. Codex has no per-launch skill folder, so the policy points at
//!   the same playbook file, which the lead reads on demand.
//!
//! When the app's `coool-ladder` MCP server is attached ([`Ladder::tools`]), the policy also tells the lead to read
//! `budget` (plans, usage, resets, models, load) before planning, and to call `can` before any image or
//! cross-provider request ([`budget`]).
//!
//! Chats coool only watches (run in the person's own terminal) are never changed. Nothing here loosens permissions:
//! helpers run under the chat's permission mode and coool's device gate like any other tool call. The cross-provider
//! commands the policy gives never carry a bypass flag.
//!
//! The tier table is built by the app from the models each CLI reported (app/src/lib/ladderTiers.ts) and sent in
//! [`Ladder::tiers`] / [`Ladder::cross`] / [`Ladder::image`]. When no helper is known at all, the lead gets a short
//! single-agent discipline instead (plan, do, check, say what was checked).

pub mod budget;

use crate::model::Provider;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The feature's name everywhere it is shown or written (rename here and in app/src/lib/ladderTiers.ts).
pub const NAME: &str = "Ladder";
/// The MCP server coool attaches to a chat with Ladder on (`budget`, `can`, `spawn`, `wait`, `helpers`, `stop`).
pub const SERVER: &str = "coool-ladder";

/// The plugin folder name and its skill prefix (`coool-ladder:playbook`).
pub fn plugin_name() -> String {
    format!("coool-{}", NAME.to_lowercase())
}

/// The skill the lead loads before its first brief.
pub fn playbook_skill() -> String {
    format!("{}:playbook", plugin_name())
}

const POLICY: &str = include_str!("policy.md");
const PLAYBOOK: &str = include_str!("playbook.md");

/// What a helper tier is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// The lead's own model: only to run medium-high pieces in parallel.
    Same,
    /// Next below the lead: multi-file work, debugging, review.
    Mid,
    /// Scoped edits, lookups, summaries.
    Small,
    /// Mechanical bulk work from an exact rule set.
    Bulk,
    /// The other provider's executor: a small self-contained part, step by step.
    Exec,
    /// The other provider's strongest allowed model: a second opinion.
    Peer,
}

impl Role {
    pub fn word(self) -> &'static str {
        match self {
            Role::Same => "same",
            Role::Mid => "mid",
            Role::Small => "small",
            Role::Bulk => "bulk",
            Role::Exec => "exec",
            Role::Peer => "peer",
        }
    }
    fn work(self) -> &'static str {
        match self {
            Role::Same => "medium-high pieces run in parallel, only when time matters",
            Role::Mid => "multi-file work, debugging, research needing judgment, review",
            Role::Small => "scoped edits, pattern clones, lookups, summaries",
            Role::Bulk => "mechanical bulk work from an exact rule set",
            Role::Exec => "small self-contained parts (a function, script, test file), step-by-step brief",
            Role::Peer => "a second opinion on a hard call, as a peer question",
        }
    }
}

/// One helper tier: the model id the CLI takes (Claude Code's Agent tool and `claude -p --model`: an alias such as
/// `sonnet`; Codex's `spawn_agent` and `codex exec -m`: a model id) and how it is shown.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tier {
    pub role: Role,
    pub model: String,
    #[serde(default)]
    pub label: String,
}

/// The image lane: which model generates images, and on which CLI. For a Claude lead it is a Codex model run through
/// `codex exec`, whose built-in image tool does the work; for a Codex lead it is its own built-in tool.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageLane {
    pub provider: Provider,
    pub model: String,
    #[serde(default)]
    pub label: String,
}

/// Set on a chat that `spawn` started as another chat's helper.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelperOf {
    /// The chat that started it.
    pub parent: usize,
    /// 1: started by a lead, 2: by a helper, ...
    pub depth: u32,
}

/// A chat's Ladder settings, as the app sends them in [`crate::chat::ChatOptions::ladder`] (None: off).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ladder {
    /// The lead's model as shown ("Opus 5.5"); empty: the CLI's default.
    #[serde(default)]
    pub lead: String,
    /// The lead's own CLI, strongest first (a `same` tier first when allowed); empty: no helper model known.
    #[serde(default)]
    pub tiers: Vec<Tier>,
    /// The other CLI's lanes (`codex exec` from a Claude lead, `claude -p` from a Codex lead); empty: off or not
    /// installed.
    #[serde(default)]
    pub cross: Vec<Tier>,
    /// Image generation (None: off, or no provider here can).
    #[serde(default)]
    pub image: Option<ImageLane>,
    #[serde(default = "default_max")]
    pub max_parallel: u32,
    /// Helpers that change code run the project's test command before they report.
    #[serde(default = "yes")]
    pub verify_tests: bool,
    /// How deep helpers may nest: 1 = helpers start no helpers; 2 = a helper may start its own (the default).
    #[serde(default = "default_depth")]
    pub depth: u32,
    /// Swarm mode is offered for big jobs.
    #[serde(default = "yes")]
    pub swarm: bool,
    /// coool's `coool-ladder` MCP server (budget, can, spawn) is attached. The hub clears it when the server could
    /// not be attached, so the policy never names tools the chat doesn't have.
    #[serde(default)]
    pub tools: bool,
    /// This chat is a helper started by `spawn`.
    #[serde(default)]
    pub helper: Option<HelperOf>,
}

fn default_max() -> u32 {
    4
}
fn default_depth() -> u32 {
    2
}
fn yes() -> bool {
    true
}

impl Default for Ladder {
    fn default() -> Self {
        Self { lead: String::new(), tiers: Vec::new(), cross: Vec::new(), image: None, max_parallel: default_max(), verify_tests: true, depth: default_depth(), swarm: true, tools: false, helper: None }
    }
}

impl Ladder {
    /// No helper of any kind: the lead works alone.
    pub fn solo(&self) -> bool {
        self.tiers.is_empty() && self.cross.is_empty() && self.image.is_none() && !self.tools
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cli {
    Claude,
    Codex,
}

impl Cli {
    pub fn of(p: Provider) -> Self {
        match p {
            Provider::Claude => Cli::Claude,
            Provider::Codex => Cli::Codex,
        }
    }
    fn other_name(self) -> &'static str {
        match self {
            Cli::Claude => "Codex",
            Cli::Codex => "Claude",
        }
    }
}

/// How strong a model is within its provider (higher is stronger; None when unknown). Mirrors `modelRank` in
/// app/src/lib/ladderTiers.ts: Claude by family, Codex by the size words in its ids.
pub fn rank(p: Provider, model: &str) -> Option<u8> {
    let s = model.to_lowercase();
    match p {
        Provider::Claude => {
            for (f, r) in [("fable", 5), ("mythos", 5), ("opus", 4), ("sonnet", 3), ("haiku", 2)] {
                if s.contains(f) {
                    return Some(r);
                }
            }
            None
        }
        Provider::Codex => {
            if s.contains("nano") {
                Some(0)
            } else if ["luna", "mini", "spark", "small", "lite", "flash"].iter().any(|w| s.contains(w)) {
                Some(1)
            } else if s.contains("terra") || s.contains("medium") {
                Some(2)
            } else if ["sol", "astra", "gpt", "codex"].iter().any(|w| s.contains(w)) || s.starts_with('o') && s[1..].starts_with(|c: char| c.is_ascii_digit()) {
                Some(3)
            } else {
                None
            }
        }
    }
}

/// The project's test command, from the files at its root (read only). None when nothing says.
pub fn test_command(cwd: &Path) -> Option<String> {
    let has = |f: &str| cwd.join(f).is_file();
    let read = |f: &str| std::fs::read_to_string(cwd.join(f)).unwrap_or_default();
    if has("package.json") {
        let pkg: serde_json::Value = serde_json::from_str(&read("package.json")).unwrap_or_default();
        if pkg["scripts"]["test"].as_str().is_some_and(|t| !t.contains("no test specified") && !t.trim().is_empty()) {
            let pm = if has("pnpm-lock.yaml") {
                "pnpm"
            } else if has("yarn.lock") {
                "yarn"
            } else if has("bun.lockb") || has("bun.lock") {
                "bun"
            } else {
                "npm"
            };
            return Some(format!("{pm} test"));
        }
    }
    if has("Cargo.toml") {
        return Some("cargo test".into());
    }
    if has("go.mod") {
        return Some("go test ./...".into());
    }
    if has("Package.swift") {
        return Some("swift test".into());
    }
    if has("pytest.ini") || has("conftest.py") || read("pyproject.toml").contains("pytest") || read("setup.cfg").contains("pytest") || read("tox.ini").contains("pytest") {
        return Some("pytest".into());
    }
    if read("Makefile").lines().any(|l| l.starts_with("test:")) {
        return Some("make test".into());
    }
    None
}

fn label_of(t: &Tier) -> String {
    if t.label.is_empty() || t.label == t.model { format!("`{}`", t.model) } else { format!("{} (`{}`)", t.label, t.model) }
}

/// One line per model, strongest first; roles that share a model share its line ("small+bulk Haiku 5.5 …").
fn tier_lines(tiers: &[Tier]) -> String {
    let mut rows: Vec<(Vec<Role>, &Tier)> = Vec::new();
    for t in tiers {
        match rows.iter_mut().find(|(_, x)| x.model == t.model) {
            Some((roles, _)) => roles.push(t.role),
            None => rows.push((vec![t.role], t)),
        }
    }
    rows.iter()
        .map(|(roles, t)| {
            let words: Vec<&str> = roles.iter().map(|r| r.word()).collect();
            let work: Vec<&str> = roles.iter().map(|r| r.work()).collect();
            format!("  {} {}: {}", words.join("+"), label_of(t), work.join("; "))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn check_phrase(l: &Ladder, tests: Option<&str>) -> String {
    match (l.verify_tests, tests) {
        (true, Some(t)) => format!("read the diff, run `{t}` or open the output yourself"),
        (true, None) => "read the diff, run the tests if any, or open the output yourself".into(),
        (false, _) => "read the diff or open the output yourself".into(),
    }
}

/// The line that makes helpers test their own work (when the setting is on).
fn delegate_tests(l: &Ladder, tests: Option<&str>) -> String {
    match (l.verify_tests, tests) {
        (true, Some(t)) => format!("\n- Helpers that change code run `{t}` before they report."),
        (true, None) => "\n- Helpers that change code run the project's tests, if any, before they report.".into(),
        (false, _) => String::new(),
    }
}

/// The exact command a lane runs on (the playbook has the full form).
fn lane_command(cli: Cli) -> &'static str {
    match cli {
        Cli::Claude => "`codex exec -m <model> -c model_reasoning_effort=\"low\" -s <read-only|workspace-write> -C <dir> -o <file> \"<brief>\" < /dev/null`",
        Cli::Codex => "`claude -p --model <alias> --permission-mode <default|acceptEdits> \"<brief>\" < /dev/null`",
    }
}

fn cross_lines(cli: Cli, l: &Ladder) -> String {
    if l.cross.is_empty() {
        return String::new();
    }
    format!("\n{} lanes, run as {}:\n{}", cli.other_name(), lane_command(cli), tier_lines(&l.cross))
}

fn image_line(cli: Cli, l: &Ladder) -> String {
    let Some(i) = &l.image else { return String::new() };
    let label = if i.label.is_empty() { i.model.clone() } else { i.label.clone() };
    match (cli, i.provider) {
        (Cli::Claude, Provider::Codex) => format!(
            "\nImage generation: you have no image model, so use a GPT helper. Run `codex exec -m {} -c model_reasoning_effort=\"low\" -s workspace-write -C <project> \"<brief>\" < /dev/null`; its built-in image tool draws ({label}). The brief names the subject, style, size, background, variants and the output path inside this project. View the file before you report.",
            i.model
        ),
        (Cli::Codex, Provider::Codex) => "\nImage generation: your built-in image tool. Save the result inside this project and look at it before you report.".into(),
        // A Claude image lane doesn't exist; anything else is shown as given.
        _ => format!("\nImage generation: {label} (`{}`).", i.model),
    }
}

fn nest_line(l: &Ladder) -> String {
    let at = l.helper.map(|h| h.depth).unwrap_or(0);
    if l.depth > at + 1 {
        format!(" A helper may split its piece and start helpers of its own, down to depth {} (you are at {at}); tell it so only when its piece has independent parts.", l.depth)
    } else {
        " Helpers do not start helpers of their own.".into()
    }
}

fn helper_line(l: &Ladder) -> String {
    match l.helper {
        Some(h) => format!("\nYou are a helper that another coool chat started (depth {} of {}). Do your piece, report facts (files changed, commands run and their results, what you could not do), then end your turn.", h.depth, l.depth),
        None => String::new(),
    }
}

fn budget_lines(l: &Ladder) -> String {
    let mut s = String::new();
    if l.tools {
        s.push_str(&format!(
            "\n- Before planning a job of several parts, call `budget` ({SERVER}: plans, usage, resets, models, load) and adapt to it. Before any image or cross-provider request, call `can`. If it says no, don't send the request: tell the person why and offer the alternative it names."
        ));
        if l.depth > l.helper.map(|h| h.depth).unwrap_or(0) + 1 {
            s.push_str(" `spawn` starts a helper as a visible coool chat (its own worktree), and `wait` returns its result.");
        }
    }
    if !l.cross.is_empty() || l.image.is_some() || l.tools {
        s.push_str("\n- Never start a job that would run a usage limit out mid-way without telling the person first.");
    }
    s
}

/// Where the playbook lives on disk for a plugin root (the Claude skill file; Codex reads it by path).
pub fn playbook_path(root: &Path) -> PathBuf {
    root.join(plugin_name()).join("skills").join("playbook").join("SKILL.md")
}

const CODEX_BRIEFS: &str = "Briefs: same/mid get the goal, the missing context, the constraints and what done looks like. Small gets named files, ordered steps, the output shape and what not to touch. Bulk gets one exact rule set with examples, in small batches. Exec gets numbered steps with an acceptance check each. Peer gets the open question and the evidence. Each brief ends with what to report: files changed, the commands run and their exact results. Wait for the helpers, then check. End your answer with one line: helpers run, their models and providers, what you checked.";

/// How the lead finds the full playbook.
pub enum Playbook<'a> {
    /// Claude: the plugin skill.
    Skill,
    /// Codex: a file path the lead reads.
    File(&'a Path),
    /// No file could be written: inlined (Claude: the full playbook; Codex: a short brief guide).
    Inline,
}

/// The always-loaded policy text for a chat (Claude Code: the appended system prompt; Codex: developer
/// instructions).
pub fn policy(cli: Cli, l: &Ladder, cwd: &Path, playbook: Playbook) -> String {
    let tests = if l.verify_tests { test_command(cwd) } else { None };
    if l.solo() {
        return format!(
            "# {NAME}: how this chat works (set by coool)\nNo helper model is available to this chat, so work alone with the same discipline: plan first, do the work, then check it before you call it done ({}). Say what you checked. Ask the person before anything destructive or outward-facing (deleting, force-pushing, publishing, sending, spending), as usual.{}\n",
            match tests.as_deref() {
                Some(t) => format!("run `{t}`, read the diff"),
                None => "run the tests if there are any, read the diff".into(),
            },
            helper_line(l)
        );
    }
    let field = match cli {
        Cli::Claude => "the Agent tool's `model`",
        Cli::Codex => "`spawn_agent`'s `model`, with `fork_turns: \"none\"`",
    };
    let playbook = match (cli, playbook) {
        (Cli::Claude, Playbook::Skill) => format!("Load the `{}` skill before your first brief, and before any cross-provider, image or swarm work.", playbook_skill()),
        (_, Playbook::File(p)) => format!("Read the playbook at `{}` before your first brief, and before any cross-provider, image or swarm work.", p.display()),
        (Cli::Claude, Playbook::Inline) => format!("\n{PLAYBOOK}"),
        (Cli::Codex, _) => CODEX_BRIEFS.to_string(),
    };
    let lead = if l.lead.is_empty() { String::new() } else { format!(" on {}", l.lead) };
    let tiers = if l.tiers.is_empty() { "  (no helper on your own CLI)".to_string() } else { tier_lines(&l.tiers) };
    let swarm = if l.swarm && l.helper.is_none() {
        "\n- For a big job (3 or more independent parts on separate files, or 30 or more files of mechanical change), use swarm mode from the playbook."
    } else {
        ""
    };
    POLICY.replace("{{NAME}}", NAME)
        .replace("{{LEAD}}", &lead)
        .replace("{{TIERS}}", &tiers)
        .replace("{{CROSS}}", &cross_lines(cli, l))
        .replace("{{CAPS}}", &format!("{}{}", image_line(cli, l), helper_line(l)))
        .replace("{{MODEL_FIELD}}", field)
        .replace("{{SAME}}", if l.tiers.iter().any(|t| t.role == Role::Same) { " Use `same` only to run medium-high pieces in parallel, never by default." } else { "" })
        .replace("{{MAX}}", &l.max_parallel.max(1).to_string())
        .replace("{{NEST}}", &nest_line(l))
        .replace("{{SWARM}}", swarm)
        .replace("{{CHECK}}", &check_phrase(l, tests.as_deref()))
        .replace("{{DELEGATE_TESTS}}", &delegate_tests(l, tests.as_deref()))
        .replace("{{BUDGET}}", &budget_lines(l))
        .replace("{{PLAYBOOK}}", &playbook)
}

/// The full playbook as the skill (and the Codex file) holds it.
pub fn playbook_text() -> String {
    format!(
        "---\nname: playbook\ndescription: {NAME} playbook: routing by difficulty, brief shape per tier, cross-provider lanes (codex exec / claude -p), image generation, budget-aware planning, nested helpers and swarm mode. Load before your first helper brief.\n---\n\n# {NAME} playbook\n\n{PLAYBOOK}"
    )
}

/// Where coool keeps its plugin (under its own data dir, never `~/.claude`).
pub fn default_plugin_root() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("coool").join("ladder-plugin"))
}

/// Writes (when missing or out of date) the plugin Claude Code loads with `--plugin-dir`: a manifest and the
/// playbook skill. Codex chats read the same skill file by path. Returns the plugin folder.
pub fn ensure_plugin(root: &Path) -> std::io::Result<PathBuf> {
    let dir = root.join(plugin_name());
    let manifest = serde_json::json!({
        "name": plugin_name(),
        "version": env!("CARGO_PKG_VERSION"),
        "description": format!("coool {NAME}: the routing playbook for helpers (loaded by coool per chat)"),
    });
    let put = |p: PathBuf, body: &str| -> std::io::Result<()> {
        if std::fs::read_to_string(&p).ok().as_deref() == Some(body) {
            return Ok(());
        }
        std::fs::create_dir_all(p.parent().expect("has a parent"))?;
        std::fs::write(p, body)
    };
    put(dir.join(".claude-plugin").join("plugin.json"), &serde_json::to_string_pretty(&manifest).unwrap_or_default())?;
    put(playbook_path(root), &playbook_text())?;
    // The skill of an older coool (`briefs`) goes: the playbook replaces it.
    let _ = std::fs::remove_dir_all(dir.join("skills").join("briefs"));
    Ok(dir)
}

/// Claude Code launch flags for a chat with Ladder on. `plugin_root`: coool's plugin folder root (None, or a write
/// that fails: the playbook goes inline).
pub fn claude_args(l: &Ladder, cwd: &Path, plugin_root: Option<&Path>) -> Vec<String> {
    let plugin = if l.solo() { None } else { plugin_root.and_then(|r| ensure_plugin(r).ok()) };
    let pb = if plugin.is_some() { Playbook::Skill } else { Playbook::Inline };
    let mut a = vec![format!("--append-system-prompt={}", policy(Cli::Claude, l, cwd, pb))];
    if let Some(p) = plugin {
        a.push(format!("--plugin-dir={}", p.display()));
    }
    a
}

/// Environment for a Claude Code chat with Ladder on: its own sub-agent nesting limit.
pub fn claude_env(l: &Ladder) -> Vec<(String, String)> {
    let left = l.depth.saturating_sub(l.helper.map(|h| h.depth).unwrap_or(0)).max(1);
    vec![("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH".into(), left.to_string())]
}

/// The Codex developer instructions for a chat with Ladder on (the playbook file written under `plugin_root` when
/// it can be; else a short inline guide).
pub fn codex_policy(l: &Ladder, cwd: &Path, plugin_root: Option<&Path>) -> String {
    let written = if l.solo() { None } else { plugin_root.and_then(|r| ensure_plugin(r).ok().map(|_| playbook_path(r))) };
    match &written {
        Some(p) => policy(Cli::Codex, l, cwd, Playbook::File(p)),
        None => policy(Cli::Codex, l, cwd, Playbook::Inline),
    }
}

/// Codex `app-server` overrides for a chat with Ladder on (the policy itself rides on `thread/start`).
pub fn codex_args(l: &Ladder) -> Vec<String> {
    let left = l.depth.saturating_sub(l.helper.map(|h| h.depth).unwrap_or(0)).max(1);
    let mut a = vec!["-c".into(), format!("agents.max_threads={}", l.max_parallel.max(1)), "-c".into(), format!("agents.max_depth={left}")];
    let small = l.tiers.iter().find(|t| t.role == Role::Small).or(l.tiers.last());
    if let Some(t) = small {
        a.extend(["-c".into(), format!("agents.default_subagent_model={}", serde_json::to_string(&t.model).unwrap_or_default())]);
    }
    a
}

/// The person's own developer instructions (from `config/read`) with the policy after them.
pub fn merge_instructions(theirs: Option<&str>, ours: &str) -> String {
    match theirs.map(str::trim).filter(|s| !s.is_empty()) {
        Some(t) => format!("{t}\n\n{ours}"),
        None => ours.to_string(),
    }
}

/// Rough token count (about 4 characters per token for English prose); the real cost is measured with Claude Code's
/// `get_context_usage` (see docs/CHAT_SPEC.md "Ladder").
pub fn approx_tokens(s: &str) -> usize {
    s.chars().count().div_ceil(4)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiers() -> Vec<Tier> {
        vec![
            Tier { role: Role::Same, model: "opus".into(), label: "Opus 5.5".into() },
            Tier { role: Role::Mid, model: "sonnet".into(), label: "Sonnet 5.5".into() },
            Tier { role: Role::Small, model: "haiku".into(), label: "Haiku 5.5".into() },
            Tier { role: Role::Bulk, model: "haiku".into(), label: "Haiku 5.5".into() },
        ]
    }
    fn cross() -> Vec<Tier> {
        vec![
            Tier { role: Role::Peer, model: "gpt-6.2-astra".into(), label: "GPT-6.2-Astra".into() },
            Tier { role: Role::Exec, model: "gpt-6.2-sol".into(), label: "GPT-6.2-Sol".into() },
            Tier { role: Role::Bulk, model: "gpt-6-luna".into(), label: "GPT-6-Luna".into() },
        ]
    }
    fn full() -> Ladder {
        Ladder { lead: "Opus 5.5".into(), tiers: tiers(), cross: cross(), image: Some(ImageLane { provider: Provider::Codex, model: "gpt-6-luna".into(), label: "GPT-6-Luna".into() }), tools: true, ..Default::default() }
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("coool-ladder-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn claude_policy_names_lead_tiers_lanes_image_and_rules() {
        let p = policy(Cli::Claude, &full(), Path::new("/definitely/not/here"), Playbook::Skill);
        assert!(p.contains("You lead on Opus 5.5."), "{p}");
        assert!(p.contains("  same Opus 5.5 (`opus`): medium-high pieces run in parallel"));
        assert!(p.contains("  mid Sonnet 5.5 (`sonnet`): multi-file"));
        assert!(p.contains("  small+bulk Haiku 5.5 (`haiku`): scoped edits"), "{p}");
        assert!(p.contains("Codex lanes, run as `codex exec -m <model>"));
        assert!(p.contains("  peer GPT-6.2-Astra (`gpt-6.2-astra`): a second opinion"));
        assert!(p.contains("  exec GPT-6.2-Sol (`gpt-6.2-sol`): small self-contained parts"));
        assert!(p.contains("Image generation: you have no image model, so use a GPT helper. Run `codex exec -m gpt-6-luna"));
        assert!(p.contains("output path inside this project"));
        assert!(p.contains("the Agent tool's `model`"));
        assert!(p.contains("at most 4 at once"));
        assert!(p.contains("down to depth 2 (you are at 0)"));
        assert!(p.contains("use swarm mode from the playbook"));
        assert!(p.contains("call `budget` (coool-ladder"));
        assert!(p.contains("call `can`. If it says no, don't send the request"));
        assert!(p.contains("`spawn` starts a helper"));
        assert!(p.contains("run a usage limit out mid-way"));
        assert!(p.contains("coool-ladder:playbook"));
        assert!(p.contains("Ask the person before anything destructive"));
        assert!(!p.contains("--dangerously"), "never a bypass flag");
        assert!(!p.contains("{{"), "every placeholder filled: {p}");
        // Small enough to load in every chat (the playbook is on demand).
        assert!(approx_tokens(&p) < 1000, "{} tokens", approx_tokens(&p));
    }

    #[test]
    fn tools_off_means_no_tool_names() {
        let l = Ladder { tools: false, ..full() };
        let p = policy(Cli::Claude, &l, Path::new("/nope"), Playbook::Skill);
        assert!(!p.contains("`budget`") && !p.contains("`can`") && !p.contains("`spawn`"), "{p}");
        assert!(p.contains("run a usage limit out mid-way"), "still warned: it has cross lanes");
    }

    #[test]
    fn codex_policy_reads_the_playbook_file_and_uses_spawn_agent() {
        let root = tmp("codexpb");
        let l = Ladder {
            lead: "GPT-6.2-Sol".into(),
            tiers: vec![Tier { role: Role::Mid, model: "gpt-6.1-terra".into(), label: "GPT-6.1 Terra".into() }, Tier { role: Role::Small, model: "gpt-6-luna".into(), label: "GPT-6-Luna".into() }],
            cross: vec![Tier { role: Role::Mid, model: "sonnet".into(), label: "Sonnet 5.5".into() }],
            image: Some(ImageLane { provider: Provider::Codex, model: "gpt-6.2-sol".into(), label: String::new() }),
            max_parallel: 2,
            verify_tests: false,
            ..Default::default()
        };
        let p = codex_policy(&l, Path::new("/nope"), Some(&root));
        assert!(p.contains("`spawn_agent`'s `model`, with `fork_turns: \"none\"`"));
        assert!(p.contains(&format!("Read the playbook at `{}`", playbook_path(&root).display())));
        assert!(playbook_path(&root).is_file());
        assert!(p.contains("Claude lanes, run as `claude -p --model <alias>"));
        assert!(p.contains("Image generation: your built-in image tool"));
        assert!(p.contains("at most 2 at once"));
        assert!(p.contains("read the diff or open the output yourself"));
        assert!(!p.contains("before they report"));
        let a = codex_args(&l);
        assert_eq!(a, vec!["-c", "agents.max_threads=2", "-c", "agents.max_depth=2", "-c", "agents.default_subagent_model=\"gpt-6-luna\""]);
        // No folder: a short inline guide.
        let inline = codex_policy(&l, Path::new("/nope"), None);
        assert!(inline.contains("Briefs: same/mid get"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn depth_reaches_both_clis_and_shrinks_for_helpers() {
        let l = Ladder { depth: 3, ..full() };
        assert_eq!(claude_env(&l), vec![("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH".to_string(), "3".to_string())]);
        let h = Ladder { helper: Some(HelperOf { parent: 0, depth: 2 }), ..l.clone() };
        assert_eq!(claude_env(&h)[0].1, "1");
        assert!(codex_args(&h).contains(&"agents.max_depth=1".to_string()));
        let p = policy(Cli::Claude, &h, Path::new("/nope"), Playbook::Skill);
        assert!(p.contains("You are a helper that another coool chat started (depth 2 of 3)"));
        assert!(p.contains("Helpers do not start helpers of their own."));
        assert!(!p.contains("`spawn` starts"), "no spawn at the limit");
        assert!(!p.contains("swarm mode"), "helpers don't swarm");
        let flat = Ladder { depth: 1, ..full() };
        assert!(policy(Cli::Claude, &flat, Path::new("/nope"), Playbook::Skill).contains("Helpers do not start helpers of their own."));
    }

    #[test]
    fn no_helper_means_single_agent_discipline() {
        let p = policy(Cli::Claude, &Ladder::default(), Path::new("/nope"), Playbook::Skill);
        assert!(p.contains("work alone"));
        assert!(!p.contains("Agent tool"));
        assert!(p.contains("Ask the person"));
        let root = tmp("solo");
        let a = claude_args(&Ladder::default(), Path::new("/nope"), Some(&root));
        assert_eq!(a.len(), 1);
        assert!(!root.join(plugin_name()).exists());
        // A Haiku lead with only cross lanes is not solo.
        let haiku = Ladder { cross: vec![Tier { role: Role::Bulk, model: "gpt-6-luna".into(), label: String::new() }], ..Default::default() };
        assert!(!haiku.solo());
        assert!(policy(Cli::Claude, &haiku, Path::new("/nope"), Playbook::Skill).contains("(no helper on your own CLI)"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn test_command_comes_from_the_project_and_reaches_the_policy() {
        let d = tmp("tests");
        assert_eq!(test_command(&d), None);
        std::fs::write(d.join("package.json"), r#"{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}"#).unwrap();
        assert_eq!(test_command(&d), None, "npm's placeholder is not a test command");
        std::fs::write(d.join("package.json"), r#"{"scripts":{"test":"vitest run"}}"#).unwrap();
        std::fs::write(d.join("pnpm-lock.yaml"), "").unwrap();
        assert_eq!(test_command(&d).as_deref(), Some("pnpm test"));
        let p = policy(Cli::Claude, &full(), &d, Playbook::Skill);
        assert!(p.contains("Helpers that change code run `pnpm test` before they report"));
        let off = Ladder { verify_tests: false, ..full() };
        assert!(!policy(Cli::Claude, &off, &d, Playbook::Skill).contains("pnpm test"));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn claude_args_write_only_under_the_given_root() {
        let root = tmp("plugin");
        let proj = tmp("proj");
        let l = full();
        // An older coool's skill is replaced.
        std::fs::create_dir_all(root.join("coool-ladder/skills/briefs")).unwrap();
        let a = claude_args(&l, &proj, Some(&root));
        assert!(a[0].starts_with("--append-system-prompt=# Ladder"));
        let dir = root.join("coool-ladder");
        assert_eq!(a[1], format!("--plugin-dir={}", dir.display()));
        assert!(dir.join(".claude-plugin/plugin.json").is_file());
        assert!(!dir.join("skills/briefs").exists());
        let skill = std::fs::read_to_string(dir.join("skills/playbook/SKILL.md")).unwrap();
        assert!(skill.starts_with("---\nname: playbook\n"));
        for part in ["## 2. Routing by difficulty", "## 5. Cross-provider lanes", "## 6. Image generation", "## 7. Budget", "## 8. Nested helpers", "## 9. Swarm mode", "## 10. Hard rules"] {
            assert!(skill.contains(part), "{part}");
        }
        assert_eq!(std::fs::read_dir(&proj).unwrap().count(), 0, "the project folder is untouched");
        let t0 = std::fs::metadata(dir.join("skills/playbook/SKILL.md")).unwrap().modified().unwrap();
        claude_args(&l, &proj, Some(&root));
        assert_eq!(std::fs::metadata(dir.join("skills/playbook/SKILL.md")).unwrap().modified().unwrap(), t0, "a second launch rewrites nothing");
        let inline = claude_args(&l, &proj, None);
        assert_eq!(inline.len(), 1);
        assert!(inline[0].contains("## 9. Swarm mode"));
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(proj);
    }

    #[test]
    fn rank_matches_the_app() {
        assert_eq!(rank(Provider::Claude, "claude-fable-5-2"), Some(5));
        assert_eq!(rank(Provider::Claude, "opus"), Some(4));
        assert_eq!(rank(Provider::Claude, "claude-haiku-5-5"), Some(2));
        assert_eq!(rank(Provider::Claude, "default"), None);
        assert_eq!(rank(Provider::Codex, "gpt-6.2-astra"), Some(3));
        assert_eq!(rank(Provider::Codex, "gpt-6.1-terra"), Some(2));
        assert_eq!(rank(Provider::Codex, "gpt-6-luna"), Some(1));
        assert_eq!(rank(Provider::Codex, "o4"), Some(3));
    }

    #[test]
    fn token_costs() {
        // Printed for the docs (`cargo test -p coool-core token_costs -- --nocapture`).
        let p = policy(Cli::Claude, &full(), Path::new("/nope"), Playbook::Skill);
        let pb = playbook_text();
        println!("LADDER_TOKENS policy(claude, full)={} playbook={}", approx_tokens(&p), approx_tokens(&pb));
        assert!(approx_tokens(&pb) < 4000);
    }

    #[test]
    fn instructions_follow_the_persons_own() {
        assert_eq!(merge_instructions(None, "P"), "P");
        assert_eq!(merge_instructions(Some("  "), "P"), "P");
        assert_eq!(merge_instructions(Some("Mine."), "P"), "Mine.\n\nP");
    }

    #[test]
    fn options_parse_with_defaults() {
        let l: Ladder = serde_json::from_str(r#"{"tiers":[{"role":"small","model":"haiku"}]}"#).unwrap();
        assert_eq!(l.max_parallel, 4);
        assert!(l.verify_tests && l.swarm && !l.tools);
        assert_eq!(l.depth, 2);
        assert_eq!(l.tiers[0].role, Role::Small);
        assert!(l.cross.is_empty() && l.image.is_none() && l.helper.is_none());
    }
}
