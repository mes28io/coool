//! What a chat's agent starts with, for the Context panel (APP_SPEC "Context panel"): its folder, its instructions
//! and memory in the order the CLI loads them, its skills, and what coool itself adds at launch. Read only here;
//! the edits go through [`guard`], which holds the allow-list.
//!
//! The lookup follows what the installed CLIs were seen to load (each run with a throwaway HOME against a local
//! server that recorded the first request; nothing reached the network):
//!
//! **Claude Code 2.1.330**, in this order:
//! 1. `~/.claude/CLAUDE.md` and the files it imports (`@path`, relative to the importing file, up to 5 deep), then
//!    `~/.claude/rules/**/*.md`.
//! 2. Every folder from `/` down to the chat's folder: `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/**/*.md`,
//!    `CLAUDE.local.md` (folders above the repository and the home folder's own `CLAUDE.md` count too). Imports of
//!    these files load only once the folder is trusted in Claude Code.
//! 3. When none of those folders has a `CLAUDE.md` / `.claude/CLAUDE.md` / `CLAUDE.local.md`, each folder's
//!    `AGENTS.md` loads in its place (Claude Code's default `instructionFiles`).
//! 4. Auto memory: `~/.claude/projects/<slug of the repository's main folder>/memory/MEMORY.md` (its first 200
//!    lines); the memory files it points to are read when needed. The slug replaces every character outside
//!    `[A-Za-z0-9_-]` with `-`; a worktree uses its main repository's folder.
//! 5. Skills: `~/.claude/skills/*/SKILL.md`, then `.claude/skills/*/SKILL.md` in the chat's folder and its parents
//!    up to the repository, then plugins' `skills/` (installed and enabled ones, and `--plugin-dir`, coool's Ladder
//!    plugin among them), then Claude Code's own built-in skills (known from the transcript's listing). Only each
//!    skill's name and description are listed at start; the body loads when the skill is used.
//!
//! **Codex 0.171.0**: `~/.codex/AGENTS.override.md` or else `~/.codex/AGENTS.md`, then, from the repository's root
//! down to the chat's folder, each folder's `AGENTS.override.md` or else its `AGENTS.md`, all in one message (32 KiB
//! at most by default). Skills (listed by name and description): `.codex/skills` in the project, `~/.codex/skills`,
//! `~/.agents/skills`, `~/.codex/skills/.system` (Codex's own), `.agents/skills` in the project.
//!
//! Sizes are tokens at [`crate::context::PROSE_CPT`] characters each, the ratio the Models panel's context map
//! uses for memory and skills.

pub mod guard;
#[cfg(test)]
mod tests;

use crate::context::PROSE_CPT;
use crate::model::Provider;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

/// Imports nest at most this deep (Claude Code's limit).
const IMPORT_DEPTH: usize = 5;
/// Claude Code loads this many lines of MEMORY.md at start.
pub const MEMORY_INDEX_LINES: usize = 200;
/// Codex's default `project_doc_max_bytes`.
pub const CODEX_DOC_MAX: u64 = 32 * 1024;
/// Files larger than this are listed but not read (nothing a CLI loads whole is this large).
const READ_MAX: u64 = 2 << 20;
/// Instruction file names a project folder can hold (and the panel may edit).
pub const INSTRUCTION_NAMES: [&str; 4] = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md"];

/// Which part of the panel an item belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Group {
    Instructions,
    Memory,
    Skills,
    Coool,
    Mcp,
}

/// When an item reaches the model.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Load {
    /// In the first request.
    Start,
    /// Its name and description at start, the rest when used (skills).
    Listed,
    /// Read when the agent needs it (memory files, a skill's other files).
    OnDemand,
    /// Would load, but only once something is true (`note` says what).
    Conditional,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Item {
    /// Stable: the path, or a name for an item without one.
    pub id: String,
    pub group: Group,
    /// `user`, `project`, `local`, `parent`, `rules`, `import`, `memory_index`, `memory`, `skill`, `coool_text`,
    /// `coool_mcp`, `mcp`, `memory_db`.
    pub kind: String,
    pub label: String,
    /// Where it comes from, plainly ("User", "Project", "Plugin coool-ladder", "Built in").
    pub source: String,
    pub path: Option<String>,
    pub description: Option<String>,
    /// What it adds to the first request (0 when it doesn't load at start).
    pub tokens: u64,
    /// The whole file (a skill's body, a memory file).
    pub full_tokens: u64,
    pub load: Load,
    /// A skill the chat loaded during this session (the transcript shows it).
    pub used: bool,
    /// The panel may write it ([`guard`] decides again on every write).
    pub editable: bool,
    /// Imports: how deep (1 = imported by a top-level file).
    pub depth: u8,
    pub note: Option<String>,
    /// Text without a file (what coool appends at launch).
    pub text: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Folder {
    pub path: String,
    pub exists: bool,
    /// The repository's root (the worktree's own root for a worktree).
    pub repo_root: Option<String>,
    pub branch: Option<String>,
    /// For a git worktree: the main repository's folder.
    pub worktree_of: Option<String>,
}

/// Where the panel can create things for this chat (None: nothing to create there, or it exists already).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Targets {
    /// The project's instruction file, when it has none (CLAUDE.md or AGENTS.md, at the repository root).
    pub project_instructions: Option<String>,
    /// `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md`, when missing.
    pub user_instructions: Option<String>,
    /// The auto-memory folder, when it exists (Claude Code makes it; coool doesn't).
    pub memory_dir: Option<String>,
    pub project_skills: Option<String>,
    pub user_skills: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Overview {
    pub provider: Option<Provider>,
    pub folder: Folder,
    pub items: Vec<Item>,
    /// Sum of `tokens`: what these items add to the first request.
    pub total: u64,
    /// The auto-memory folder this chat's project uses (whether or not it exists).
    pub memory_dir: Option<String>,
    pub create: Targets,
    /// The model the session started with (its first reply), when the transcript says.
    pub started_model: Option<String>,
    /// The model coool asked for at launch (None: the CLI's default).
    pub launch_model: Option<String>,
    /// Reasoning effort, when the launch or the transcript says.
    pub effort: Option<String>,
    /// Plain sentences shown under the list.
    pub notes: Vec<String>,
}

/// What coool launched the chat with (None for a session coool only watches).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Launch {
    /// The CLI's arguments.
    pub args: Vec<String>,
    /// Codex: what coool adds to the thread's `developerInstructions` (Claude: in `args`).
    pub developer_instructions: Option<String>,
    /// The MCP servers coool attached.
    pub mcp: Vec<McpInfo>,
    /// The model asked for at launch.
    pub model: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct McpInfo {
    pub name: String,
    pub tools: u32,
    /// The tool definitions' size.
    pub tokens: u64,
}

/// An MCP server from the person's own config (Settings > Connections reads them).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserMcp {
    pub name: String,
    pub scope: String,
    pub file: String,
    pub disabled: bool,
}

/// Everything [`overview`] looks at besides the disk.
#[derive(Clone, Debug, Default)]
pub struct Inputs {
    pub launch: Option<Launch>,
    /// What the session's transcript showed (see [`TranscriptScan`]).
    pub facts: Facts,
    /// Installed, enabled Claude Code plugins: (name, install folder).
    pub plugins: Vec<(String, PathBuf)>,
    pub user_mcp: Vec<UserMcp>,
}

/// Tokens of `bytes` bytes of prose.
pub fn tokens(bytes: u64) -> u64 {
    (bytes as f64 / PROSE_CPT).round() as u64
}

// ---------- folders ----------

/// The repository around `dir`: (its root, the `.git` entry there).
fn git_root(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut d = Some(dir);
    while let Some(x) = d {
        let g = x.join(".git");
        if g.exists() {
            return Some((x.to_path_buf(), g));
        }
        d = x.parent();
    }
    None
}

/// For a worktree's `.git` file: its git dir.
fn worktree_gitdir(dotgit: &Path) -> Option<PathBuf> {
    if !dotgit.is_file() {
        return None;
    }
    let s = std::fs::read_to_string(dotgit).ok()?;
    let rel = s.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let p = PathBuf::from(rel);
    Some(if p.is_absolute() { p } else { dotgit.parent()?.join(p) })
}

/// The main repository's folder of a worktree (`<main>/.git/worktrees/<name>` -> `<main>`).
fn main_of_worktree(gitdir: &Path) -> Option<PathBuf> {
    let mut d = gitdir.parent();
    while let Some(x) = d {
        if x.file_name().is_some_and(|n| n == ".git") {
            return x.parent().map(Path::to_path_buf);
        }
        d = x.parent();
    }
    None
}

fn branch(dotgit: &Path) -> Option<String> {
    let dir = worktree_gitdir(dotgit).unwrap_or_else(|| dotgit.to_path_buf());
    let head = std::fs::read_to_string(dir.join("HEAD")).ok()?;
    let head = head.trim();
    match head.strip_prefix("ref: refs/heads/") {
        Some(b) => Some(b.to_string()),
        None => head.get(..7).map(|s| format!("detached at {s}")),
    }
}

pub fn folder(cwd: &Path) -> Folder {
    let mut f = Folder { path: cwd.display().to_string(), exists: cwd.is_dir(), ..Folder::default() };
    if let Some((root, dotgit)) = git_root(cwd) {
        f.repo_root = Some(root.display().to_string());
        f.branch = branch(&dotgit);
        f.worktree_of = worktree_gitdir(&dotgit).and_then(|g| main_of_worktree(&g)).map(|m| m.display().to_string());
    }
    f
}

/// The folder Claude Code keys a project's auto memory by: the repository's main folder, else the chat's folder.
pub fn memory_key(cwd: &Path) -> PathBuf {
    match git_root(cwd) {
        Some((root, dotgit)) => worktree_gitdir(&dotgit).and_then(|g| main_of_worktree(&g)).unwrap_or(root),
        None => cwd.to_path_buf(),
    }
}

/// Claude Code's folder name for a project under `~/.claude/projects`.
pub fn slug(path: &Path) -> String {
    path.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect()
}

pub fn memory_dir(home: &Path, cwd: &Path) -> PathBuf {
    home.join(".claude").join("projects").join(slug(&memory_key(cwd))).join("memory")
}

/// `/` down to `cwd`.
fn ancestors_down(cwd: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = cwd.ancestors().map(Path::to_path_buf).collect();
    v.reverse();
    v
}

/// `cwd` up to the repository root (just `cwd` outside a repository), nearest first.
pub fn project_dirs(cwd: &Path) -> Vec<PathBuf> {
    let root = git_root(cwd).map(|r| r.0);
    let mut v = Vec::new();
    for d in cwd.ancestors() {
        v.push(d.to_path_buf());
        if Some(d) == root.as_deref() || root.is_none() {
            break;
        }
    }
    v
}

// ---------- files ----------

fn file_len(p: &Path) -> Option<u64> {
    std::fs::metadata(p).ok().filter(|m| m.is_file()).map(|m| m.len())
}

fn read_small(p: &Path) -> Option<String> {
    let n = file_len(p)?;
    if n > READ_MAX {
        return None;
    }
    std::fs::read_to_string(p).ok()
}

/// `~/x` for display.
pub fn tilde(home: &Path, p: &Path) -> String {
    match p.strip_prefix(home) {
        Ok(r) if !home.as_os_str().is_empty() => format!("~/{}", r.display()),
        _ => p.display().to_string(),
    }
}

/// Markdown files under a rules folder, sorted, any depth.
fn md_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if out.len() < 500 {
                    stack.push(p);
                }
            } else if p.extension().is_some_and(|x| x == "md") {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// `@path` imports in a file's text, outside code spans and fenced blocks.
pub fn imports(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut fence = false;
    for line in text.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = !fence;
            continue;
        }
        if fence {
            continue;
        }
        let mut code = false;
        let b = line.as_bytes();
        let mut i = 0;
        while i < b.len() {
            match b[i] {
                b'`' => code = !code,
                b'@' if !code && (i == 0 || b[i - 1].is_ascii_whitespace() || b[i - 1] == b'(') => {
                    let rest = &line[i + 1..];
                    let end = rest.find(|c: char| c.is_whitespace() || c == ')' || c == ',' || c == ';').unwrap_or(rest.len());
                    let tok = rest[..end].trim_end_matches(['.', ':']);
                    let pathish = tok.starts_with('/') || tok.starts_with("~/") || tok.starts_with("./") || tok.starts_with("../") || tok.contains('/') || tok.contains('.');
                    if !tok.is_empty() && pathish && !tok.contains('@') && !out.iter().any(|x| x == tok) {
                        out.push(tok.to_string());
                    }
                    i += end;
                }
                _ => {}
            }
            i += 1;
        }
    }
    out
}

fn resolve_import(home: &Path, from: &Path, imp: &str) -> PathBuf {
    let p = if let Some(r) = imp.strip_prefix("~/") {
        home.join(r)
    } else if imp.starts_with('/') {
        PathBuf::from(imp)
    } else {
        from.parent().unwrap_or(Path::new("/")).join(imp)
    };
    lexical(&p)
}

/// `..` and `.` resolved without touching the disk.
pub fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c.as_os_str()),
        }
    }
    out
}

/// One skill folder's `SKILL.md` frontmatter: (name, description).
pub fn skill_meta(text: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut desc = None;
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let mut cur: Option<&str> = None;
    for l in lines {
        if l.trim() == "---" {
            break;
        }
        let unq = |v: &str| v.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
        if let Some(v) = l.strip_prefix("name:") {
            name = Some(unq(v)).filter(|s| !s.is_empty());
            cur = None;
        } else if let Some(v) = l.strip_prefix("description:") {
            let v = v.trim();
            if v == "|" || v == ">" || v == "|-" || v == ">-" || v.is_empty() {
                desc = Some(String::new());
                cur = Some("description");
            } else {
                desc = Some(unq(v));
                cur = None;
            }
        } else if cur == Some("description") && (l.starts_with(' ') || l.starts_with('\t')) {
            let d = desc.get_or_insert_with(String::new);
            if !d.is_empty() {
                d.push(' ');
            }
            d.push_str(l.trim());
        } else {
            cur = None;
        }
    }
    (name, desc.filter(|d| !d.is_empty()))
}

// ---------- the transcript ----------

/// What a session's transcript says about its context.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Facts {
    /// Skills the chat loaded (Claude: the Skill tool, `invoked_skills`; Codex: a SKILL.md it read).
    pub used: HashSet<String>,
    /// SKILL.md paths the agent read (Codex reads skills as files).
    pub used_paths: HashSet<String>,
    /// The CLI's own skill listing, (name, description), in its order.
    pub listed: Vec<(String, Option<String>)>,
    /// Instruction files the CLI said it loaded.
    pub loaded: Vec<String>,
    pub started_model: Option<String>,
    pub effort: Option<String>,
}

/// Reads a transcript incrementally for [`Facts`]; only lines that can matter are parsed.
pub struct TranscriptScan {
    provider: Provider,
    tail: crate::tail::Tail,
    pub facts: Facts,
}

impl TranscriptScan {
    pub fn new(path: &Path, provider: Provider) -> Self {
        Self { provider, tail: crate::tail::Tail::new(path), facts: Facts::default() }
    }

    pub fn update(&mut self) -> &Facts {
        let Self { provider, tail, facts } = self;
        if tail.rewound() {
            *facts = Facts::default();
        }
        tail.for_each_line(|l| match provider {
            Provider::Claude => claude_line(facts, l),
            Provider::Codex => codex_line(facts, l),
        });
        &self.facts
    }
}

fn claude_line(f: &mut Facts, l: &str) {
    let interesting = l.contains("\"Skill\"") || l.contains("skill_listing") || l.contains("invoked_skills") || l.contains("\"type\":\"instructions\"") || (f.started_model.is_none() && l.contains("\"type\":\"assistant\""));
    if !interesting {
        return;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(l) else { return };
    let a = &v["attachment"];
    match a["type"].as_str() {
        Some("skill_listing") => {
            let mut listed = Vec::new();
            for line in a["content"].as_str().unwrap_or("").lines() {
                if let Some(rest) = line.strip_prefix("- ") {
                    let (name, desc) = match rest.split_once(": ") {
                        Some((n, d)) => (n.trim(), Some(d.trim().to_string())),
                        None => (rest.trim(), None),
                    };
                    if !name.is_empty() && !name.contains(' ') {
                        listed.push((name.to_string(), desc));
                    }
                }
            }
            if !listed.is_empty() {
                f.listed = listed;
            }
        }
        Some("invoked_skills") => {
            for s in a["skills"].as_array().into_iter().flatten() {
                if let Some(n) = s["name"].as_str() {
                    f.used.insert(n.to_string());
                }
            }
        }
        Some("instructions") => {
            for file in a["files"].as_array().into_iter().flatten() {
                if let Some(p) = file["path"].as_str()
                    && !f.loaded.iter().any(|x| x == p)
                {
                    f.loaded.push(p.to_string());
                }
            }
        }
        _ => {}
    }
    if v["type"] == "assistant" {
        if f.started_model.is_none()
            && let Some(m) = v["message"]["model"].as_str().filter(|m| !m.starts_with('<'))
        {
            f.started_model = Some(m.to_string());
        }
        for b in v["message"]["content"].as_array().into_iter().flatten() {
            if b["type"] == "tool_use" && b["name"] == "Skill"
                && let Some(s) = b["input"]["skill"].as_str().or(b["input"]["command"].as_str())
            {
                f.used.insert(s.trim_start_matches('/').to_string());
            }
        }
    }
}

fn codex_line(f: &mut Facts, l: &str) {
    let interesting = l.contains("SKILL.md") || (f.started_model.is_none() && l.contains("turn_context"));
    if !interesting {
        return;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(l) else { return };
    let p = &v["payload"];
    if v["type"] == "turn_context" {
        if f.started_model.is_none() {
            f.started_model = p["model"].as_str().map(str::to_string);
        }
        if f.effort.is_none() {
            f.effort = p["effort"].as_str().or(p["reasoning_effort"].as_str()).map(str::to_string);
        }
        return;
    }
    // A shell call or a file read naming a SKILL.md: the skill was opened.
    if matches!(p["type"].as_str(), Some("function_call" | "custom_tool_call" | "local_shell_call")) {
        let args = p["arguments"].as_str().map(str::to_string).or_else(|| p["input"].as_str().map(str::to_string)).unwrap_or_else(|| p["action"].to_string());
        let mut rest = args.as_str();
        while let Some(i) = rest.find("SKILL.md") {
            let head = &rest[..i + "SKILL.md".len()];
            let start = head.rfind(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '=').map_or(0, |s| s + 1);
            let path = head[start..].replace("\\/", "/");
            if path.starts_with('/') || path.starts_with('~') {
                f.used_paths.insert(path);
            }
            rest = &rest[i + "SKILL.md".len()..];
        }
    }
}

// ---------- what coool adds ----------

/// The `--append-system-prompt` values of a Claude Code launch.
pub fn appended_prompts(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if let Some(v) = a.strip_prefix("--append-system-prompt=") {
            out.push(v.to_string());
        } else if a == "--append-system-prompt"
            && let Some(v) = it.next()
        {
            out.push(v.clone());
        }
    }
    out
}

/// The `--plugin-dir` values of a Claude Code launch.
pub fn plugin_dirs(args: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if let Some(v) = a.strip_prefix("--plugin-dir=") {
            out.push(PathBuf::from(v));
        } else if a == "--plugin-dir"
            && let Some(v) = it.next()
        {
            out.push(PathBuf::from(v));
        }
    }
    out
}

/// Text coool appended, split at its top-level `# ` headings (each part coool adds starts with one: Ladder's
/// policy, the "you are in coool" context): (heading, text).
pub fn sections(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in text.split_inclusive('\n') {
        if let Some(h) = line.strip_prefix("# ") {
            out.push((h.trim().to_string(), line.to_string()));
        } else if let Some(last) = out.last_mut() {
            last.1.push_str(line);
        } else {
            out.push((String::new(), line.to_string()));
        }
    }
    out.retain(|(_, t)| !t.trim().is_empty());
    out
}

fn coool_items(launch: &Launch, provider: Provider) -> Vec<Item> {
    let mut out = Vec::new();
    let (texts, via) = match provider {
        Provider::Claude => (appended_prompts(&launch.args), "--append-system-prompt"),
        Provider::Codex => (launch.developer_instructions.iter().cloned().collect(), "developer instructions"),
    };
    for t in texts {
        for (i, (heading, body)) in sections(&t).into_iter().enumerate() {
            let label = heading.trim_end_matches("(set by coool)").trim().trim_end_matches(':').to_string();
            let label = if label.is_empty() { "Instructions from coool".to_string() } else { label };
            let ladder = heading.starts_with(crate::ladder::NAME);
            out.push(Item {
                id: format!("coool:{}:{i}", if ladder { "ladder" } else { &heading }),
                group: Group::Coool,
                kind: "coool_text".into(),
                label,
                source: format!("coool · {via}"),
                path: None,
                description: Some(heading.clone()),
                tokens: tokens(body.len() as u64),
                full_tokens: tokens(body.len() as u64),
                load: Load::Start,
                used: false,
                editable: false,
                depth: 0,
                note: ladder.then(|| format!("Settings > {} turns it on or off for new chats.", crate::ladder::NAME)),
                text: Some(body),
            });
        }
    }
    for m in &launch.mcp {
        out.push(Item {
            id: format!("coool-mcp:{}", m.name),
            group: Group::Coool,
            kind: "coool_mcp".into(),
            label: m.name.clone(),
            source: "coool · MCP server".into(),
            path: None,
            description: Some(format!("{} tools: the chat's iPhone, Mac and browser panels", m.tools)),
            tokens: if provider == Provider::Claude { 0 } else { m.tokens },
            full_tokens: m.tokens,
            load: if provider == Provider::Claude { Load::OnDemand } else { Load::Start },
            used: false,
            editable: false,
            depth: 0,
            note: Some(match provider {
                Provider::Claude => "Claude Code lists these tools by name at start and loads a tool's definition when the agent searches for it.".into(),
                Provider::Codex => "Codex sends every tool's definition with each request.".into(),
            }),
            text: None,
        });
    }
    out
}

// ---------- the lookup ----------

struct Ctx<'a> {
    home: &'a Path,
    items: Vec<Item>,
    seen: HashSet<PathBuf>,
}

impl Ctx<'_> {
    fn has(&mut self, p: &Path) -> bool {
        let key = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        !self.seen.insert(key)
    }

    #[allow(clippy::too_many_arguments)]
    fn file(&mut self, p: &Path, group: Group, kind: &str, label: &str, source: &str, load: Load, editable: bool, depth: u8) -> Option<String> {
        let len = file_len(p)?;
        if self.has(p) {
            return None;
        }
        let t = tokens(len);
        self.items.push(Item {
            id: p.display().to_string(),
            group,
            kind: kind.into(),
            label: label.into(),
            source: source.into(),
            path: Some(p.display().to_string()),
            description: None,
            tokens: if load == Load::Start { t } else { 0 },
            full_tokens: t,
            load,
            used: false,
            editable,
            depth,
            note: None,
            text: None,
        });
        read_small(p)
    }

    /// A Claude instruction file and what it imports.
    fn claude_file(&mut self, p: &Path, kind: &str, source: &str, editable: bool, trusted_imports: bool) {
        let label = tilde(self.home, p);
        let Some(text) = self.file(p, Group::Instructions, kind, &label, source, Load::Start, editable, 0) else { return };
        self.imports_of(p, &text, 1, trusted_imports);
    }

    fn imports_of(&mut self, from: &Path, text: &str, depth: usize, trusted: bool) {
        if depth > IMPORT_DEPTH {
            return;
        }
        for imp in imports(text) {
            let p = resolve_import(self.home, from, &imp);
            if guard::forbidden(self.home, &p) {
                continue;
            }
            let load = if trusted { Load::Start } else { Load::Conditional };
            let source = format!("Imported by {}", tilde(self.home, from));
            let label = tilde(self.home, &p);
            if let Some(t) = self.file(&p, Group::Instructions, "import", &label, &source, load, false, depth as u8) {
                if !trusted && let Some(last) = self.items.last_mut() {
                    last.note = Some("Claude Code loads imports in a project's files once the folder is trusted.".into());
                }
                self.imports_of(&p, &t, depth + 1, trusted);
            }
        }
    }
}

fn skill_items(dir: &Path, source: &str, prefix: &str, editable: bool, out: &mut Vec<Item>, seen: &mut HashSet<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.join("SKILL.md").is_file()).collect();
    dirs.sort();
    for d in dirs {
        let file = d.join("SKILL.md");
        let text = read_small(&file).unwrap_or_default();
        let (name, desc) = skill_meta(&text);
        let base = name.unwrap_or_else(|| d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        let name = format!("{prefix}{base}");
        if !seen.insert(name.clone()) {
            continue;
        }
        let listing = (name.len() + desc.as_deref().map_or(0, str::len) + 4) as u64;
        out.push(Item {
            id: file.display().to_string(),
            group: Group::Skills,
            kind: "skill".into(),
            label: name,
            source: source.into(),
            path: Some(file.display().to_string()),
            description: desc,
            tokens: tokens(listing),
            full_tokens: tokens(text.len() as u64),
            load: Load::Listed,
            used: false,
            editable,
            depth: 0,
            note: None,
            text: None,
        });
    }
}

fn plugin_name(dir: &Path) -> String {
    read_small(&dir.join(".claude-plugin").join("plugin.json"))
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["name"].as_str().map(str::to_string))
        .unwrap_or_else(|| dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
}

fn claude(home: &Path, cwd: &Path, inputs: &Inputs, ov: &mut Overview) {
    let mut cx = Ctx { home, items: Vec::new(), seen: HashSet::new() };
    let user_dir = home.join(".claude");
    cx.claude_file(&user_dir.join("CLAUDE.md"), "user", "User", true, true);
    for r in md_files(&user_dir.join("rules")) {
        let label = tilde(home, &r);
        cx.file(&r, Group::Instructions, "rules", &label, "User rules", Load::Start, false, 0);
    }
    let project: Vec<PathBuf> = project_dirs(cwd);
    let editable_dir = |d: &Path| project.iter().any(|p| p == d);
    let dirs = ancestors_down(cwd);
    let any_claude = dirs.iter().any(|d| {
        let is_home = d == home;
        d.join("CLAUDE.md").is_file() || (!is_home && d.join(".claude").join("CLAUDE.md").is_file()) || d.join("CLAUDE.local.md").is_file()
    });
    for d in &dirs {
        let is_home = d == home;
        let src = if editable_dir(d) { if d == cwd { "Project" } else { "Project (parent folder)" } } else { "Parent folder" };
        let edit = editable_dir(d);
        cx.claude_file(&d.join("CLAUDE.md"), if edit { "project" } else { "parent" }, src, edit, false);
        if !is_home {
            cx.claude_file(&d.join(".claude").join("CLAUDE.md"), if edit { "project" } else { "parent" }, src, edit, false);
            for r in md_files(&d.join(".claude").join("rules")) {
                let label = tilde(home, &r);
                cx.file(&r, Group::Instructions, "rules", &label, "Project rules", Load::Start, false, 0);
            }
        }
        if !any_claude {
            cx.claude_file(&d.join("AGENTS.md"), if edit { "project" } else { "parent" }, &format!("{src} · AGENTS.md (no CLAUDE.md here)"), edit, false);
        }
        cx.claude_file(&d.join("CLAUDE.local.md"), "local", if edit { "Local (not checked in)" } else { "Parent folder (local)" }, edit, false);
    }
    // Auto memory.
    let mem = memory_dir(home, cwd);
    ov.memory_dir = Some(mem.display().to_string());
    if mem.is_dir() {
        ov.create.memory_dir = Some(mem.display().to_string());
        let index = mem.join("MEMORY.md");
        if let Some(len) = file_len(&index) {
            let text = read_small(&index).unwrap_or_default();
            let head: usize = text.split_inclusive('\n').take(MEMORY_INDEX_LINES).map(str::len).sum();
            cx.items.push(Item {
                id: index.display().to_string(),
                group: Group::Memory,
                kind: "memory_index".into(),
                label: "MEMORY.md".into(),
                source: "Auto memory · index".into(),
                path: Some(index.display().to_string()),
                description: Some(format!("{} entries", text.lines().filter(|l| l.trim_start().starts_with("- ")).count())),
                tokens: tokens(head as u64),
                full_tokens: tokens(len),
                load: Load::Start,
                used: false,
                editable: true,
                depth: 0,
                note: (text.lines().count() > MEMORY_INDEX_LINES).then(|| format!("Only the first {MEMORY_INDEX_LINES} lines load at start.")),
                text: None,
            });
        }
        let mut files: Vec<PathBuf> = std::fs::read_dir(&mem).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "md") && p.file_name().is_some_and(|n| n != "MEMORY.md") && p.is_file()).collect();
        files.sort();
        for p in files {
            let text = read_small(&p).unwrap_or_default();
            let (name, desc) = skill_meta(&text);
            let len = text.len() as u64;
            cx.items.push(Item {
                id: p.display().to_string(),
                group: Group::Memory,
                kind: "memory".into(),
                label: name.unwrap_or_else(|| p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()),
                source: "Auto memory".into(),
                path: Some(p.display().to_string()),
                description: desc,
                tokens: 0,
                full_tokens: tokens(len),
                load: Load::OnDemand,
                used: false,
                editable: true,
                depth: 0,
                note: None,
                text: None,
            });
        }
    }
    let mut items = cx.items;
    // Skills.
    let mut seen = HashSet::new();
    let user_skills = user_dir.join("skills");
    skill_items(&user_skills, "User", "", true, &mut items, &mut seen);
    ov.create.user_skills = Some(user_skills.display().to_string());
    for d in &project {
        skill_items(&d.join(".claude").join("skills"), if d == cwd { "Project" } else { "Project (parent folder)" }, "", true, &mut items, &mut seen);
    }
    // New project skills go in the nearest existing skills folder, else at the repository's root.
    if let Some(top) = project.last() {
        let sd = project.iter().map(|d| d.join(".claude").join("skills")).find(|p| p.is_dir()).unwrap_or_else(|| top.join(".claude").join("skills"));
        ov.create.project_skills = Some(sd.display().to_string());
    }
    let launch_plugins = inputs.launch.as_ref().map(|l| plugin_dirs(&l.args)).unwrap_or_default();
    for p in &launch_plugins {
        let name = plugin_name(p);
        let coool = name.starts_with("coool-");
        skill_items(&p.join("skills"), &format!("Plugin {name}{}", if coool { " (coool, --plugin-dir)" } else { " (--plugin-dir)" }), &format!("{name}:"), false, &mut items, &mut seen);
    }
    for (name, dir) in &inputs.plugins {
        skill_items(&dir.join("skills"), &format!("Plugin {name}"), &format!("{name}:"), false, &mut items, &mut seen);
    }
    for (name, desc) in &inputs.facts.listed {
        if seen.insert(name.clone()) {
            let listing = (name.len() + desc.as_deref().map_or(0, str::len) + 4) as u64;
            items.push(Item {
                id: format!("builtin:{name}"),
                group: Group::Skills,
                kind: "skill".into(),
                label: name.clone(),
                source: if name.contains(':') { "Plugin".into() } else { "Built in or managed".into() },
                path: None,
                description: desc.clone(),
                tokens: tokens(listing),
                full_tokens: 0,
                load: Load::Listed,
                used: false,
                editable: false,
                depth: 0,
                note: Some("Listed by Claude Code for this session; its file isn't in a folder the panel reads.".into()),
                text: None,
            });
        }
    }
    for it in items.iter_mut().filter(|i| i.group == Group::Skills) {
        if inputs.facts.used.contains(&it.label) {
            it.used = true;
            it.tokens += it.full_tokens;
        }
    }
    // The project's own CLAUDE.md, when its root has none.
    if let Some(top) = project.last()
        && !top.join("CLAUDE.md").is_file()
        && !top.join(".claude").join("CLAUDE.md").is_file()
    {
        ov.create.project_instructions = Some(top.join("CLAUDE.md").display().to_string());
    }
    if !user_dir.join("CLAUDE.md").is_file() {
        ov.create.user_instructions = Some(user_dir.join("CLAUDE.md").display().to_string());
    }
    ov.items.extend(items);
    ov.notes.push("Changes to instructions, memory and skills reach Claude Code in its next session; a running chat keeps what it started with (a skill it hasn't used yet is read when it uses it, and memory files are read when needed).".into());
}

fn codex(home: &Path, cwd: &Path, inputs: &Inputs, ov: &mut Overview) {
    let mut cx = Ctx { home, items: Vec::new(), seen: HashSet::new() };
    let cdir = home.join(".codex");
    let over = cdir.join("AGENTS.override.md");
    if file_len(&over).is_some() {
        let label = tilde(home, &over);
        cx.file(&over, Group::Instructions, "user", &label, "User (override)", Load::Start, false, 0);
    } else {
        let label = tilde(home, &cdir.join("AGENTS.md"));
        cx.file(&cdir.join("AGENTS.md"), Group::Instructions, "user", &label, "User", Load::Start, true, 0);
    }
    let mut project = project_dirs(cwd);
    project.reverse();
    let mut budget = CODEX_DOC_MAX;
    for d in &project {
        let o = d.join("AGENTS.override.md");
        let p = if file_len(&o).is_some() { o } else { d.join("AGENTS.md") };
        let src = if d == cwd { "Project" } else { "Project (parent folder)" };
        let label = tilde(home, &p);
        let over = p.file_name().is_some_and(|n| n == "AGENTS.override.md");
        if cx.file(&p, Group::Instructions, "project", &label, &if over { format!("{src} · override") } else { src.to_string() }, Load::Start, true, 0).is_some()
            && let Some(last) = cx.items.last_mut()
        {
            let len = file_len(&p).unwrap_or(0);
            if len > budget {
                last.note = Some(format!("Codex reads {} KiB of project instructions at most; the rest of this file is left out.", CODEX_DOC_MAX / 1024));
                last.tokens = tokens(budget);
            }
            budget = budget.saturating_sub(len);
        }
    }
    let mut items = cx.items;
    let mut seen = HashSet::new();
    let near: Vec<PathBuf> = project_dirs(cwd);
    for d in &near {
        skill_items(&d.join(".codex").join("skills"), if d == cwd { "Project · .codex/skills" } else { "Project (parent) · .codex/skills" }, "", true, &mut items, &mut seen);
    }
    skill_items(&cdir.join("skills"), "User · ~/.codex/skills", "", false, &mut items, &mut seen);
    let agents_user = home.join(".agents").join("skills");
    skill_items(&agents_user, "User · ~/.agents/skills", "", true, &mut items, &mut seen);
    skill_items(&cdir.join("skills").join(".system"), "Codex (system)", "", false, &mut items, &mut seen);
    for d in &near {
        skill_items(&d.join(".agents").join("skills"), if d == cwd { "Project · .agents/skills" } else { "Project (parent) · .agents/skills" }, "", true, &mut items, &mut seen);
    }
    ov.create.user_skills = Some(agents_user.display().to_string());
    if let Some(top) = near.last() {
        ov.create.project_skills = Some(near.iter().map(|d| d.join(".agents").join("skills")).find(|p| p.is_dir()).unwrap_or_else(|| top.join(".agents").join("skills")).display().to_string());
        if !near.iter().any(|d| d.join("AGENTS.md").is_file() || d.join("AGENTS.override.md").is_file()) {
            ov.create.project_instructions = Some(top.join("AGENTS.md").display().to_string());
        }
    }
    if !cdir.join("AGENTS.md").is_file() && !over_exists(&cdir) {
        ov.create.user_instructions = Some(cdir.join("AGENTS.md").display().to_string());
    }
    for it in items.iter_mut().filter(|i| i.group == Group::Skills) {
        let hit = it.path.as_deref().is_some_and(|p| inputs.facts.used_paths.iter().any(|u| u == p || p.ends_with(u.trim_start_matches('~')) || u.ends_with(&p[p.len().saturating_sub(40)..])));
        if hit {
            it.used = true;
            it.tokens += it.full_tokens;
        }
    }
    if cdir.join("memories_1.sqlite").is_file() || cdir.join("memories").is_dir() {
        items.push(Item {
            id: "codex:memories".into(),
            group: Group::Memory,
            kind: "memory_db".into(),
            label: "Codex memories".into(),
            source: "Codex".into(),
            path: None,
            description: Some("Kept by Codex in its own database".into()),
            tokens: 0,
            full_tokens: 0,
            load: Load::OnDemand,
            used: false,
            editable: false,
            depth: 0,
            note: Some("Codex keeps these in ~/.codex (a database coool doesn't open); manage them in Codex.".into()),
            text: None,
        });
    }
    ov.items.extend(items);
    ov.notes.push("Codex reads AGENTS.md and the skill list when a thread starts: changes reach new chats (and this one after it is reopened), not a turn in progress.".into());
}

fn over_exists(cdir: &Path) -> bool {
    cdir.join("AGENTS.override.md").is_file()
}

/// The context of a chat in `cwd` for `provider`, from the disk and `inputs`.
pub fn overview(provider: Provider, cwd: &Path, home: &Path, inputs: &Inputs) -> Overview {
    let mut ov = Overview { provider: Some(provider), folder: folder(cwd), ..Overview::default() };
    match provider {
        Provider::Claude => claude(home, cwd, inputs, &mut ov),
        Provider::Codex => codex(home, cwd, inputs, &mut ov),
    }
    if let Some(l) = &inputs.launch {
        ov.items.extend(coool_items(l, provider));
        ov.launch_model = l.model.clone();
        ov.effort = effort_arg(&l.args);
    } else {
        ov.notes.push("This session runs outside coool: coool added nothing to it.".into());
    }
    for m in &inputs.user_mcp {
        ov.items.push(Item {
            id: format!("mcp:{}:{}", m.scope, m.name),
            group: Group::Mcp,
            kind: "mcp".into(),
            label: m.name.clone(),
            source: format!("{} · {}", cap(&m.scope), tilde(home, Path::new(&m.file))),
            path: None,
            description: m.disabled.then(|| "Turned off for this project".to_string()),
            tokens: 0,
            full_tokens: 0,
            load: Load::OnDemand,
            used: false,
            editable: false,
            depth: 0,
            note: Some("Its tools are known once the CLI connects to it.".into()),
            text: None,
        });
    }
    ov.started_model = inputs.facts.started_model.clone();
    if ov.effort.is_none() {
        ov.effort = inputs.facts.effort.clone();
    }
    // Instruction files the CLI said it loaded but the lookup didn't find (a setting or a version this doesn't know).
    let known: HashSet<String> = ov.items.iter().filter_map(|i| i.path.clone()).collect();
    for p in &inputs.facts.loaded {
        if !known.contains(p) && !guard::forbidden(home, Path::new(p)) {
            let len = file_len(Path::new(p)).unwrap_or(0);
            ov.items.push(Item {
                id: p.clone(),
                group: if p.contains("/memory/") { Group::Memory } else { Group::Instructions },
                kind: "loaded".into(),
                label: tilde(home, Path::new(p)),
                source: "Loaded by the CLI (from the transcript)".into(),
                path: Some(p.clone()),
                description: None,
                tokens: tokens(len),
                full_tokens: tokens(len),
                load: Load::Start,
                used: false,
                editable: false,
                depth: 0,
                note: None,
                text: None,
            });
        }
    }
    ov.total = ov.items.iter().map(|i| i.tokens).sum();
    ov
}

fn cap(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

fn effort_arg(args: &[String]) -> Option<String> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if let Some(v) = a.strip_prefix("--effort=") {
            return Some(v.to_string());
        }
        if a == "--effort" {
            return it.next().cloned();
        }
        if let Some(v) = a.strip_prefix("model_reasoning_effort=") {
            return Some(v.trim_matches('"').to_string());
        }
    }
    None
}

/// Claude Code's instruction files loaded at start for `cwd` (path, bytes): what the context map counts as memory.
pub fn claude_start_files(home: &Path, cwd: &Path) -> Vec<(String, u64)> {
    let ov = overview(Provider::Claude, cwd, home, &Inputs { launch: Some(Launch::default()), ..Inputs::default() });
    ov.items
        .iter()
        .filter(|i| matches!(i.group, Group::Instructions | Group::Memory) && i.load == Load::Start)
        .filter_map(|i| {
            let p = i.path.clone()?;
            let len = if i.kind == "memory_index" { (i.tokens as f64 * PROSE_CPT).round() as u64 } else { file_len(Path::new(&p))? };
            Some((p, len))
        })
        .collect()
}

/// Tokens per group (for the panel's header and tests).
pub fn by_group(ov: &Overview) -> HashMap<&'static str, u64> {
    let mut m = HashMap::new();
    for i in &ov.items {
        let k = match i.group {
            Group::Instructions => "instructions",
            Group::Memory => "memory",
            Group::Skills => "skills",
            Group::Coool => "coool",
            Group::Mcp => "mcp",
        };
        *m.entry(k).or_insert(0) += i.tokens;
    }
    m
}
