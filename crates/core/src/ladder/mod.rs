//! Ladder (APP_SPEC "Ladder"): the chat's own model leads and checks; cheaper models do the pieces, several at once.
//!
//! coool hands each chat it starts a short delegation policy at launch, through the CLIs' own per-launch
//! mechanisms, and never through the person's config or the project's files:
//!
//! - Claude Code: `--append-system-prompt=<policy>` (always loaded: the tier table and the rules) and
//!   `--plugin-dir=<coool's data dir>/ladder-plugin`, a plugin coool owns whose one skill (`<plugin>:briefs`)
//!   holds the longer brief guidance; only its one-line description is loaded until the lead invokes it.
//! - Codex: `developerInstructions` on `thread/start` / `thread/resume` (appended to any `developer_instructions`
//!   the person's config has, read with `config/read`), plus `-c agents.max_threads=<n>` and
//!   `-c agents.default_subagent_model=<small tier>` so a delegate spawned without a model still lands on a cheap
//!   tier. The brief guidance is inlined (Codex has no per-launch skill folder).
//!
//! Chats coool only watches (run in the person's own terminal) are never changed. Nothing here loosens
//! permissions: delegates run under the chat's permission mode and coool's device gate like any other tool call.
//!
//! The tier table is built by the app from the models the CLI reported (app/src/lib/ladder.ts) and sent in
//! [`Ladder::tiers`]; an empty table means no cheaper model is known, and the lead gets a short single-agent
//! discipline instead (plan, do, check, say what was checked).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The feature's name everywhere it is shown or written (rename here and in app/src/lib/ladder.ts).
pub const NAME: &str = "Ladder";

/// The plugin folder name and its skill prefix (`coool-ladder:briefs`).
pub fn plugin_name() -> String {
    format!("coool-{}", NAME.to_lowercase())
}

/// The skill the lead loads before its first brief.
pub fn briefs_skill() -> String {
    format!("{}:briefs", plugin_name())
}

const POLICY: &str = include_str!("policy.md");
const BRIEFS: &str = include_str!("briefs.md");

/// What a delegate tier is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Next below the lead: multi-file work, debugging, review.
    Mid,
    /// Scoped edits, lookups, summaries.
    Small,
    /// Mechanical bulk work from an exact rule set.
    Bulk,
}

impl Role {
    pub fn word(self) -> &'static str {
        match self {
            Role::Mid => "mid",
            Role::Small => "small",
            Role::Bulk => "bulk",
        }
    }
    fn work(self) -> &'static str {
        match self {
            Role::Mid => "multi-file work, debugging, research needing judgment, review",
            Role::Small => "scoped edits, pattern clones, lookups, summaries",
            Role::Bulk => "mechanical bulk work from an exact rule set",
        }
    }
}

/// One delegate tier: the model id the CLI takes (Claude Code's Agent tool: an alias such as `sonnet`; Codex's
/// `spawn_agent`: a model id) and how it is shown.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tier {
    pub role: Role,
    pub model: String,
    #[serde(default)]
    pub label: String,
}

/// A chat's Ladder settings, as the app sends them in [`crate::chat::ChatOptions::ladder`] (None: off).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ladder {
    /// Strongest first; empty: no cheaper model known (single-agent discipline).
    #[serde(default)]
    pub tiers: Vec<Tier>,
    #[serde(default = "default_max")]
    pub max_parallel: u32,
    /// Delegates that change code run the project's test command before they report.
    #[serde(default = "yes")]
    pub verify_tests: bool,
}

fn default_max() -> u32 {
    4
}
fn yes() -> bool {
    true
}

impl Default for Ladder {
    fn default() -> Self {
        Self { tiers: Vec::new(), max_parallel: default_max(), verify_tests: true }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cli {
    Claude,
    Codex,
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
            let label = if t.label.is_empty() || t.label == t.model { format!("`{}`", t.model) } else { format!("{} (`{}`)", t.label, t.model) };
            let words: Vec<&str> = roles.iter().map(|r| r.word()).collect();
            let work: Vec<&str> = roles.iter().map(|r| r.work()).collect();
            format!("  {} {label}: {}", words.join("+"), work.join("; "))
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

/// The line that makes delegates test their own work (when the setting is on).
fn delegate_tests(l: &Ladder, tests: Option<&str>) -> String {
    match (l.verify_tests, tests) {
        (true, Some(t)) => format!("\n- Delegates that change code run `{t}` before they report."),
        (true, None) => "\n- Delegates that change code run the project's tests, if any, before they report.".into(),
        (false, _) => String::new(),
    }
}

const CODEX_BRIEFS: &str = "Briefs: mid gets the goal, missing context, constraints and what done looks like; small gets named files, ordered steps, the output shape and what not to touch; bulk gets one exact rule set with examples, in small batches. Each brief ends with what to report: files changed, the command run and its exact result. Wait for the delegates, then check. End your answer with one line: delegates run, their models, what you checked.";

/// The always-loaded policy text for a chat (Claude Code: the appended system prompt; Codex: developer
/// instructions). `briefs_inline`: put the brief guidance in the text (Codex, or a Claude chat whose plugin folder
/// could not be written) instead of pointing at the skill.
pub fn policy(cli: Cli, l: &Ladder, cwd: &Path, briefs_inline: bool) -> String {
    let tests = if l.verify_tests { test_command(cwd) } else { None };
    if l.tiers.is_empty() {
        return format!(
            "# {NAME}: how this chat works (set by coool)\nNo cheaper model is available to this chat, so work alone with the same discipline: plan first, do the work, then check it before you call it done ({}). Say what you checked. Ask the person before anything destructive or outward-facing (deleting, force-pushing, publishing, sending, spending), as usual.\n",
            match tests.as_deref() {
                Some(t) => format!("run `{t}`, read the diff"),
                None => "run the tests if there are any, read the diff".into(),
            }
        );
    }
    let field = match cli {
        Cli::Claude => "the Agent tool's `model`",
        Cli::Codex => "`spawn_agent`'s `model`",
    };
    let briefs = match (cli, briefs_inline) {
        (Cli::Codex, _) => CODEX_BRIEFS.to_string(),
        (Cli::Claude, true) => format!("\n{BRIEFS}"),
        (Cli::Claude, false) => format!("Before your first brief, load the `{}` skill (brief shape per tier).", briefs_skill()),
    };
    POLICY.replace("{{NAME}}", NAME)
        .replace("{{TIERS}}", &tier_lines(&l.tiers))
        .replace("{{MODEL_FIELD}}", field)
        .replace("{{MAX}}", &l.max_parallel.max(1).to_string())
        .replace("{{CHECK}}", &check_phrase(l, tests.as_deref()))
        .replace("{{DELEGATE_TESTS}}", &delegate_tests(l, tests.as_deref()))
        .replace("{{BRIEFS}}", &briefs)
}

/// Where coool keeps its plugin (under its own data dir, never `~/.claude`).
pub fn default_plugin_root() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("coool").join("ladder-plugin"))
}

/// Writes (when missing or out of date) the plugin Claude Code loads with `--plugin-dir`: a manifest and the briefs
/// skill. Returns the plugin folder.
pub fn ensure_plugin(root: &Path) -> std::io::Result<PathBuf> {
    let dir = root.join(plugin_name());
    let manifest = serde_json::json!({
        "name": plugin_name(),
        "version": env!("CARGO_PKG_VERSION"),
        "description": format!("coool {NAME}: brief guidance for delegates (loaded by coool per chat)"),
    });
    let skill = format!(
        "---\nname: briefs\ndescription: {NAME} brief shapes per delegate tier and how to check a delegate's report. Load before writing your first delegate brief.\n---\n\n# {NAME} briefs\n\n{BRIEFS}"
    );
    let put = |p: PathBuf, body: &str| -> std::io::Result<()> {
        if std::fs::read_to_string(&p).ok().as_deref() == Some(body) {
            return Ok(());
        }
        std::fs::create_dir_all(p.parent().expect("has a parent"))?;
        std::fs::write(p, body)
    };
    put(dir.join(".claude-plugin").join("plugin.json"), &serde_json::to_string_pretty(&manifest).unwrap_or_default())?;
    put(dir.join("skills").join("briefs").join("SKILL.md"), &skill)?;
    Ok(dir)
}

/// Claude Code launch flags for a chat with Ladder on. `plugin_root`: coool's plugin folder root (None, or a write
/// that fails: the brief guidance goes inline).
pub fn claude_args(l: &Ladder, cwd: &Path, plugin_root: Option<&Path>) -> Vec<String> {
    let plugin = if l.tiers.is_empty() { None } else { plugin_root.and_then(|r| ensure_plugin(r).ok()) };
    let mut a = vec![format!("--append-system-prompt={}", policy(Cli::Claude, l, cwd, plugin.is_none()))];
    if let Some(p) = plugin {
        a.push(format!("--plugin-dir={}", p.display()));
    }
    a
}

/// Codex `app-server` overrides for a chat with Ladder on (the policy itself rides on `thread/start`).
pub fn codex_args(l: &Ladder) -> Vec<String> {
    let mut a = vec!["-c".into(), format!("agents.max_threads={}", l.max_parallel.max(1))];
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
            Tier { role: Role::Mid, model: "sonnet".into(), label: "Sonnet 4.6".into() },
            Tier { role: Role::Small, model: "haiku".into(), label: "Haiku 4.5".into() },
            Tier { role: Role::Bulk, model: "haiku".into(), label: "Haiku 4.5".into() },
        ]
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("coool-ladder-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn claude_policy_names_tiers_rules_and_the_skill() {
        let l = Ladder { tiers: tiers(), ..Default::default() };
        let p = policy(Cli::Claude, &l, Path::new("/definitely/not/here"), false);
        assert!(p.contains("  mid Sonnet 4.6 (`sonnet`): multi-file"));
        assert!(p.contains("  small+bulk Haiku 4.5 (`haiku`): scoped edits, pattern clones, lookups, summaries; mechanical bulk"), "{p}");
        assert!(p.contains("the Agent tool's `model`"));
        assert!(p.contains("at most 4 at once"));
        assert!(p.contains("coool-ladder:briefs"));
        assert!(p.contains("Ask the person before anything destructive"));
        assert!(!p.contains("{{"), "every placeholder filled: {p}");
        // Not hard-coded to one lead model.
        for m in ["Opus", "Fable", "Mythos"] {
            assert!(!p.contains(m), "names {m}");
        }
        // Small enough to load in every chat.
        assert!(approx_tokens(&p) < 380, "{} tokens", approx_tokens(&p));
    }

    #[test]
    fn codex_policy_inlines_briefs_and_uses_spawn_agent() {
        let l = Ladder { tiers: vec![Tier { role: Role::Mid, model: "gpt-5.6-terra".into(), label: "GPT-5.6-Terra".into() }, Tier { role: Role::Small, model: "gpt-5.6-luna".into(), label: "GPT-5.6-Luna".into() }], max_parallel: 2, verify_tests: false };
        let p = policy(Cli::Codex, &l, Path::new("/nope"), true);
        assert!(p.contains("`spawn_agent`'s `model`"));
        assert!(p.contains("Briefs: mid gets"));
        assert!(p.contains("at most 2 at once"));
        assert!(p.contains("read the diff or open the output yourself"));
        assert!(!p.contains("before they report"));
        assert!(!p.contains("coool-ladder:briefs"));
        let a = codex_args(&l);
        assert_eq!(a, vec!["-c", "agents.max_threads=2", "-c", "agents.default_subagent_model=\"gpt-5.6-luna\""]);
    }

    #[test]
    fn no_cheaper_model_means_single_agent_discipline() {
        let p = policy(Cli::Claude, &Ladder::default(), Path::new("/nope"), false);
        assert!(p.contains("work alone"));
        assert!(!p.contains("Agent tool"));
        assert!(p.contains("Ask the person"));
        // No plugin for it either.
        let root = tmp("solo");
        let a = claude_args(&Ladder::default(), Path::new("/nope"), Some(&root));
        assert_eq!(a.len(), 1);
        assert!(!root.join(plugin_name()).exists());
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
        let l = Ladder { tiers: tiers(), ..Default::default() };
        let p = policy(Cli::Claude, &l, &d, false);
        assert!(p.contains("Delegates that change code run `pnpm test` before they report"));
        let off = Ladder { verify_tests: false, ..l };
        assert!(!policy(Cli::Claude, &off, &d, false).contains("pnpm test"));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn claude_args_write_only_under_the_given_root() {
        let root = tmp("plugin");
        let proj = tmp("proj");
        let l = Ladder { tiers: tiers(), ..Default::default() };
        let a = claude_args(&l, &proj, Some(&root));
        assert!(a[0].starts_with("--append-system-prompt=# Ladder"));
        let dir = root.join("coool-ladder");
        assert_eq!(a[1], format!("--plugin-dir={}", dir.display()));
        assert!(dir.join(".claude-plugin/plugin.json").is_file());
        let skill = std::fs::read_to_string(dir.join("skills/briefs/SKILL.md")).unwrap();
        assert!(skill.starts_with("---\nname: briefs\n"));
        assert!(skill.contains("## small tier"));
        // The project folder is untouched.
        assert_eq!(std::fs::read_dir(&proj).unwrap().count(), 0);
        // A second launch rewrites nothing.
        let t0 = std::fs::metadata(dir.join("skills/briefs/SKILL.md")).unwrap().modified().unwrap();
        claude_args(&l, &proj, Some(&root));
        assert_eq!(std::fs::metadata(dir.join("skills/briefs/SKILL.md")).unwrap().modified().unwrap(), t0);
        // Without a root (or one that can't be written) the briefs go inline.
        let inline = claude_args(&l, &proj, None);
        assert_eq!(inline.len(), 1);
        assert!(inline[0].contains("## small tier"));
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(proj);
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
        assert!(l.verify_tests);
        assert_eq!(l.tiers[0].role, Role::Small);
    }
}
