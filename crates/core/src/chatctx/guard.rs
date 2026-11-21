//! The Context panel's allow-list and its file operations. The panel writes into the person's own config folders,
//! so every read and write is checked here, in Rust, against a short list resolved after following symlinks:
//!
//! **Writable:** `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md` (and `.claude/CLAUDE.md`) in the
//! chat's folder and its parents up to the repository root; `~/.claude/CLAUDE.md`; `~/.codex/AGENTS.md`; files in
//! a skill's folder (`<root>/<skill>/…` for the roots `.claude/skills`, `.agents/skills` and `.codex/skills` in those
//! project folders, `~/.claude/skills`, `~/.agents/skills`); and Markdown files in this project's auto-memory folder.
//!
//! **Readable as well:** the instruction files of folders above the repository (Claude Code loads those), rules
//! folders (`.claude/rules`, `~/.claude/rules`), Codex's own skills (`~/.codex/skills`), and files the caller lists
//! (the skills of the chat's plugins, the files instruction files import).
//!
//! **Never**, whatever the list says or a symlink points to: anything else under `~/.claude` or `~/.codex`
//! (settings, credentials, sessions, transcripts, plugins' code, auth), `~/.claude.json`, and anything named like a
//! credential or key. Paths with `..` are refused before anything is resolved.

use super::{INSTRUCTION_NAMES, project_dirs};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
}

/// Why a path was refused (shown as is).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refused(pub String);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Refused {}

fn refuse<T>(why: impl Into<String>) -> Result<T, Refused> {
    Err(Refused(why.into()))
}

/// What the checks are relative to.
#[derive(Clone, Debug)]
pub struct Scope {
    pub home: PathBuf,
    pub cwd: PathBuf,
    /// Exact files (or folders, for everything inside) also readable: plugin skill folders, imported files.
    pub extra_read: Vec<PathBuf>,
}

impl Scope {
    pub fn new(home: &Path, cwd: &Path) -> Self {
        Self { home: home.to_path_buf(), cwd: cwd.to_path_buf(), extra_read: Vec::new() }
    }
}

fn canon(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// The real path: the file's own if it exists, else its folder's (which must exist) plus its name.
fn resolve(p: &Path) -> Result<PathBuf, Refused> {
    if std::fs::symlink_metadata(p).is_ok() {
        return std::fs::canonicalize(p).map_err(|_| Refused(format!("{} points nowhere", p.display())));
    }
    let (Some(parent), Some(name)) = (p.parent(), p.file_name()) else { return refuse("not a file path") };
    let parent = std::fs::canonicalize(parent).map_err(|_| Refused(format!("{} doesn't exist", parent.display())))?;
    Ok(parent.join(name))
}

/// File names that hold secrets wherever they are.
fn secret_name(name: &str) -> bool {
    name.contains("credential") || name == "auth.json" || name.ends_with(".key") || name.ends_with(".pem") || name.starts_with(".env")
}

/// Never read or written: anything under `~/.claude` / `~/.codex` but the instruction files, rules, skills and
/// auto-memory folders, `~/.claude.json`, and names that look like credentials. Checked on the path as given and as
/// resolved.
pub fn forbidden(home: &Path, p: &Path) -> bool {
    let homes = [home.to_path_buf(), canon(home)];
    let check = |p: &Path| -> bool {
        let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        if secret_name(&name) {
            return true;
        }
        for h in &homes {
            if p == h.join(".claude.json") || p.starts_with(h.join(".claude.json")) {
                return true;
            }
            if let Ok(rest) = p.strip_prefix(h.join(".claude")) {
                let c: Vec<String> = rest.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
                let ok = match c.first().map(String::as_str) {
                    None => true,
                    Some("CLAUDE.md") => c.len() == 1,
                    Some("rules") | Some("skills") => true,
                    // projects/<slug>/memory/…, nothing else there (transcripts).
                    Some("projects") => c.len() >= 3 && c[2] == "memory" || c.len() <= 2 && !c.last().is_some_and(|x| x.ends_with(".jsonl")),
                    // Plugins: only their skills, for reading (writes are never allowed there: see `allowed`).
                    Some("plugins") => c.iter().any(|x| x == "skills"),
                    Some("sessions") | Some("todos") | Some("shell-snapshots") | Some("file-history") => false,
                    // Other Markdown files there (a file CLAUDE.md imports, say): readable only when the caller lists them.
                    _ => name.ends_with(".md"),
                };
                if !ok {
                    return true;
                }
            }
            if let Ok(rest) = p.strip_prefix(h.join(".codex")) {
                let c: Vec<String> = rest.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
                let ok = match c.first().map(String::as_str) {
                    None => true,
                    Some("AGENTS.md") | Some("AGENTS.override.md") => c.len() == 1,
                    Some("skills") => true,
                    _ => false,
                };
                if !ok {
                    return true;
                }
            }
        }
        false
    };
    check(p) || check(&canon(p)) || p.parent().is_some_and(|d| check(&canon(d).join(p.file_name().unwrap_or_default())))
}

/// Skill roots whose `<root>/<skill>/…` may be written.
fn skill_roots(s: &Scope) -> Vec<PathBuf> {
    let mut v = vec![s.home.join(".claude").join("skills"), s.home.join(".agents").join("skills")];
    for d in project_dirs(&s.cwd) {
        v.push(d.join(".claude").join("skills"));
        v.push(d.join(".agents").join("skills"));
        v.push(d.join(".codex").join("skills"));
    }
    v
}

/// `rest` names something inside one skill's folder (or the folder): `<skill>[/…]`, the skill not hidden.
fn in_skill(rest: &Path) -> bool {
    let mut c = rest.components();
    match c.next() {
        Some(Component::Normal(n)) => !n.to_string_lossy().starts_with('.'),
        _ => false,
    }
}

fn allowed(s: &Scope, real: &Path, access: Access) -> bool {
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let parent = real.parent().map(Path::to_path_buf).unwrap_or_default();
    let project: Vec<PathBuf> = project_dirs(&s.cwd).iter().map(|d| canon(d)).collect();
    // Instruction files in the project's folders.
    if INSTRUCTION_NAMES.contains(&name.as_str()) && project.contains(&parent) {
        return true;
    }
    if name == "CLAUDE.md" && project.iter().any(|d| d.join(".claude") == parent) {
        return true;
    }
    // The user's own instruction files.
    if real == canon(&s.home.join(".claude")).join("CLAUDE.md") || real == canon(&s.home.join(".codex")).join("AGENTS.md") {
        return true;
    }
    // Skills.
    for r in skill_roots(s) {
        let r = canon(&r);
        if let Ok(rest) = real.strip_prefix(&r)
            && in_skill(rest)
        {
            return true;
        }
    }
    // This project's auto memory: Markdown files.
    let mem = canon(&super::memory_dir(&s.home, &s.cwd));
    if real.starts_with(&mem) && real != mem && name.ends_with(".md") {
        return true;
    }
    if access == Access::Write {
        return false;
    }
    read_only(s, real, &name, &parent)
}

/// Inside `~/.claude` and `~/.codex`, writes go only to the user's instruction file, skills and this project's
/// memory (a symlinked project folder must not lead elsewhere in them).
fn write_zone(s: &Scope, real: &Path) -> bool {
    let codex = canon(&s.home.join(".codex"));
    if real.starts_with(&codex) {
        return real == codex.join("AGENTS.md");
    }
    let claude = canon(&s.home.join(".claude"));
    if let Ok(rest) = real.strip_prefix(&claude) {
        let c: Vec<_> = rest.components().collect();
        return rest == Path::new("CLAUDE.md")
            || (c.len() >= 2 && rest.starts_with("skills"))
            || real.starts_with(canon(&super::memory_dir(&s.home, &s.cwd)));
    }
    true
}

fn read_only(s: &Scope, real: &Path, name: &str, parent: &Path) -> bool {
    // Read only: instruction files of any folder above, rules, Codex's skills, the caller's extras.
    if INSTRUCTION_NAMES.contains(&name) && s.cwd.ancestors().any(|d| canon(d) == parent || canon(d).join(".claude") == parent) {
        return true;
    }
    let rules = |d: &Path| real.starts_with(canon(&d.join(".claude").join("rules")));
    if rules(&s.home) || s.cwd.ancestors().any(rules) {
        return name.ends_with(".md");
    }
    if real.starts_with(canon(&s.home.join(".codex").join("skills"))) {
        return true;
    }
    s.extra_read.iter().any(|x| real.starts_with(canon(x)))
}

/// Checks `p` for `access`; the path to use (symlinks resolved).
pub fn check(s: &Scope, p: &Path, access: Access) -> Result<PathBuf, Refused> {
    if !p.is_absolute() {
        return refuse("the path must be absolute");
    }
    if p.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) || p.to_string_lossy().contains('\0') {
        return refuse("paths with .. are refused");
    }
    if forbidden(&s.home, p) {
        return refuse(format!("coool never opens {} (CLI settings, credentials and sessions are off limits)", p.display()));
    }
    let real = resolve(p)?;
    if forbidden(&s.home, &real) {
        return refuse(format!("{} leads to a file coool never opens", p.display()));
    }
    if !allowed(s, &real, access) || (access == Access::Write && !write_zone(s, &real)) {
        return refuse(match access {
            Access::Write => format!("coool only edits this chat's instructions, memory and skills, not {}", p.display()),
            Access::Read => format!("{} isn't part of this chat's context", p.display()),
        });
    }
    Ok(real)
}

// ---------- reading and writing ----------

/// What a file was when it was read: a save refuses if it is no longer that.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stamp {
    pub len: u64,
    pub hash: String,
    pub modified_ms: u64,
}

fn fnv(b: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for x in b {
        h ^= *x as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn stamp_of(bytes: &[u8], meta: &std::fs::Metadata) -> Stamp {
    let ms = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
    Stamp { len: bytes.len() as u64, hash: fnv(bytes), modified_ms: ms }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FileText {
    pub path: String,
    /// With `\n` line endings (the file's own come back on save).
    pub text: String,
    pub stamp: Stamp,
    /// "crlf" or "lf".
    pub eol: String,
    pub editable: bool,
}

const MAX: u64 = 2 << 20;

pub fn read(s: &Scope, p: &Path) -> Result<FileText, Refused> {
    let real = check(s, p, Access::Read)?;
    let meta = std::fs::metadata(&real).map_err(|_| Refused("the file is gone".into()))?;
    if !meta.is_file() {
        return refuse("not a file");
    }
    if meta.len() > MAX {
        return refuse("the file is too large to show");
    }
    let bytes = std::fs::read(&real).map_err(|e| Refused(format!("couldn't read it ({})", e.kind())))?;
    let stamp = stamp_of(&bytes, &meta);
    let raw = String::from_utf8(bytes).map_err(|_| Refused("not a text file".into()))?;
    let crlf = raw.contains("\r\n");
    let editable = check(s, p, Access::Write).is_ok();
    Ok(FileText { path: p.display().to_string(), text: if crlf { raw.replace("\r\n", "\n") } else { raw }, stamp, eol: if crlf { "crlf" } else { "lf" }.into(), editable })
}

/// Why a save didn't happen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SaveError {
    Refused(Refused),
    /// The file changed on disk since it was read (or appeared, for a new one): its current stamp, if it exists.
    Changed(Option<Stamp>),
    Io(String),
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SaveError::Refused(r) => write!(f, "{r}"),
            SaveError::Changed(_) => f.write_str("the file changed on disk since it was opened"),
            SaveError::Io(e) => f.write_str(e),
        }
    }
}

impl From<Refused> for SaveError {
    fn from(r: Refused) -> Self {
        SaveError::Refused(r)
    }
}

/// Writes `text` over the file `expected` describes (None: a new file, which must not exist), atomically: a
/// temporary file beside it, synced, then renamed over it. Keeps the file's line endings and permissions.
pub fn save(s: &Scope, p: &Path, text: &str, expected: Option<&Stamp>) -> Result<Stamp, SaveError> {
    let real = check(s, p, Access::Write)?;
    let cur = std::fs::read(&real).ok();
    let meta = std::fs::metadata(&real).ok();
    match (expected, &cur, &meta) {
        (Some(e), Some(b), Some(m)) => {
            let now = stamp_of(b, m);
            if now.hash != e.hash || now.len != e.len {
                return Err(SaveError::Changed(Some(now)));
            }
        }
        (Some(_), _, _) => return Err(SaveError::Changed(None)),
        (None, Some(b), Some(m)) => return Err(SaveError::Changed(Some(stamp_of(b, m)))),
        (None, _, _) => {}
    }
    if meta.as_ref().is_some_and(|m| !m.is_file()) {
        return Err(SaveError::Refused(Refused("not a file".into())));
    }
    let crlf = cur.as_deref().is_some_and(|b| b.windows(2).any(|w| w == b"\r\n"));
    let body = if crlf { text.replace("\r\n", "\n").replace('\n', "\r\n") } else { text.to_string() };
    let dir = real.parent().ok_or_else(|| SaveError::Io("no folder".into()))?;
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.coool-{}-{}", std::process::id(), fnv(format!("{:?}", std::time::SystemTime::now()).as_bytes())));
    let io = |e: std::io::Error| SaveError::Io(format!("couldn't save ({})", e.kind()));
    let r = (|| {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
        if let Some(m) = &meta {
            std::fs::set_permissions(&tmp, m.permissions())?;
        }
        std::fs::rename(&tmp, &real)
    })();
    if let Err(e) = r {
        let _ = std::fs::remove_file(&tmp);
        return Err(io(e));
    }
    let m = std::fs::metadata(&real).map_err(io)?;
    Ok(stamp_of(body.as_bytes(), &m))
}

// ---------- creating and deleting ----------

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "what", rename_all = "snake_case")]
pub enum Create {
    /// A memory file in the auto-memory folder and its line in MEMORY.md.
    Memory { title: String, description: String, #[serde(default)] kind: Option<String> },
    /// A skill: `scope` "project" or "user".
    Skill { scope: String, name: String, description: String },
    /// The project's (or the user's) instruction file, from a short template.
    Instructions { path: String },
}

/// A skill's or memory file's name: lowercase letters, digits and dashes.
pub fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 64 && n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') && !n.starts_with('-')
}

pub fn file_name_for(title: &str) -> String {
    let mut s: String = title.trim().to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    let s = s.trim_matches('-').chars().take(48).collect::<String>();
    if s.is_empty() { "memory".into() } else { s }
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn yaml_str(s: &str) -> String {
    let s = one_line(s);
    if s.is_empty() || s.contains(": ") || s.starts_with(['"', '\'', '-', '[', '{', '>', '|', '#', '&', '*', '!', '%', '@', '`']) || s.contains(" #") {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        s
    }
}

/// Today as ISO 8601 (UTC, ms), without a date library.
fn now_iso() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil from days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, d.subsec_millis())
}

/// Creates it; the new file's path.
pub fn create(s: &Scope, c: &Create) -> Result<PathBuf, SaveError> {
    match c {
        Create::Memory { title, description, kind } => {
            let dir = super::memory_dir(&s.home, &s.cwd);
            if !dir.is_dir() {
                return Err(SaveError::Refused(Refused("this project has no auto-memory folder yet (Claude Code makes it when it first saves a memory)".into())));
            }
            let base = file_name_for(title);
            let mut path = dir.join(format!("{base}.md"));
            let mut n = 2;
            while path.exists() {
                path = dir.join(format!("{base}-{n}.md"));
                n += 1;
            }
            let kind = kind.as_deref().filter(|k| matches!(*k, "user" | "feedback" | "project" | "reference")).unwrap_or("project");
            let body = format!(
                "---\nname: {}\ndescription: {}\nmetadata:\n  type: {kind}\n  modified: {}\n---\n\n",
                base,
                yaml_str(description),
                now_iso()
            );
            save(s, &path, &body, None)?;
            // Its line in the index, in Claude Code's own shape: `- [Title](file.md) — description`.
            let index = dir.join("MEMORY.md");
            let line = format!("- [{}]({}) — {}\n", one_line(title), path.file_name().unwrap_or_default().to_string_lossy(), one_line(description));
            let r = match read(s, &index) {
                Ok(f) => {
                    let mut t = f.text.clone();
                    if !t.is_empty() && !t.ends_with('\n') {
                        t.push('\n');
                    }
                    t.push_str(&line);
                    save(s, &index, &t, Some(&f.stamp)).map(|_| ())
                }
                Err(_) => save(s, &index, &line, None).map(|_| ()),
            };
            r?;
            Ok(path)
        }
        Create::Skill { scope, name, description } => {
            if !valid_name(name) {
                return Err(SaveError::Refused(Refused("a skill's name is lowercase letters, digits and dashes (at most 64)".into())));
            }
            let root = match scope.as_str() {
                "user" => s.home.join(".claude").join("skills"),
                "user-agents" => s.home.join(".agents").join("skills"),
                "project" | "project-agents" => {
                    let dirs = project_dirs(&s.cwd);
                    let sub = if scope == "project" { [".claude", "skills"] } else { [".agents", "skills"] };
                    let top = dirs.last().cloned().unwrap_or_else(|| s.cwd.clone());
                    dirs.iter().map(|d| d.join(sub[0]).join(sub[1])).find(|p| p.is_dir()).unwrap_or_else(|| top.join(sub[0]).join(sub[1]))
                }
                _ => return Err(SaveError::Refused(Refused("unknown skill scope".into()))),
            };
            let dir = root.join(name);
            if dir.exists() {
                return Err(SaveError::Changed(None));
            }
            // The folder must be allowed before anything is made.
            if root.exists() {
                check(s, &dir, Access::Write)?;
            } else {
                check_new_root(s, &root, name)?;
            }
            std::fs::create_dir_all(&dir).map_err(|e| SaveError::Io(format!("couldn't make the folder ({})", e.kind())))?;
            let body = format!("---\nname: {name}\ndescription: {}\n---\n\n# {name}\n\nWhat to do when this skill is used.\n", yaml_str(description));
            match save(s, &dir.join("SKILL.md"), &body, None) {
                Ok(_) => Ok(dir.join("SKILL.md")),
                Err(e) => {
                    let _ = std::fs::remove_dir(&dir);
                    Err(e)
                }
            }
        }
        Create::Instructions { path } => {
            let p = PathBuf::from(path);
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let body = if name == "AGENTS.md" {
                "# AGENTS.md\n\nInstructions for coding agents working in this folder.\n"
            } else {
                "# CLAUDE.md\n\nInstructions for Claude Code in this folder.\n"
            };
            save(s, &p, body, None)?;
            Ok(p)
        }
    }
}

/// A skill root that doesn't exist yet (the first project skill): allowed when it is one of the roots, made here.
fn check_new_root(s: &Scope, root: &Path, name: &str) -> Result<PathBuf, Refused> {
    if !skill_roots(s).iter().any(|r| r == root) {
        return refuse("not a skills folder of this chat");
    }
    // Its parent must exist and resolve where the root's would (no symlink out).
    let mut d = root.to_path_buf();
    while !d.exists() {
        d = d.parent().map(Path::to_path_buf).ok_or_else(|| Refused("no folder".into()))?;
    }
    if forbidden(&s.home, &canon(&d)) || forbidden(&s.home, root) {
        return refuse("not a skills folder of this chat");
    }
    std::fs::create_dir_all(root).map_err(|e| Refused(format!("couldn't make {} ({})", root.display(), e.kind())))?;
    check(s, &root.join(name), Access::Write)
}

/// Moves it to the Trash with `trash` (a skill: its whole folder; a memory file: also its line in MEMORY.md).
pub fn delete(s: &Scope, p: &Path, trash: impl Fn(&Path) -> std::io::Result<()>) -> Result<PathBuf, SaveError> {
    let real = check(s, p, Access::Write)?;
    // A skill's SKILL.md (or its folder) goes with the folder.
    let mut target = real.clone();
    for r in skill_roots(s) {
        let r = canon(&r);
        if let Ok(rest) = real.strip_prefix(&r)
            && let Some(Component::Normal(n)) = rest.components().next()
            && (rest.components().count() == 1 || real.file_name().is_some_and(|f| f == "SKILL.md"))
        {
            target = r.join(n);
        }
    }
    if !target.exists() {
        return Err(SaveError::Changed(None));
    }
    trash(&target).map_err(|e| SaveError::Io(format!("couldn't move it to the Trash ({e})")))?;
    let mem = canon(&super::memory_dir(&s.home, &s.cwd));
    if real.parent() == Some(mem.as_path()) && real.file_name().is_some_and(|n| n != "MEMORY.md") {
        let index = mem.join("MEMORY.md");
        let fname = real.file_name().unwrap_or_default().to_string_lossy().into_owned();
        if let Ok(f) = read(s, &index) {
            let needle = format!("]({fname})");
            let kept: Vec<&str> = f.text.split_inclusive('\n').filter(|l| !l.contains(&needle)).collect();
            let t = kept.concat();
            if t != f.text {
                save(s, &index, &t, Some(&f.stamp))?;
            }
        }
    }
    Ok(target)
}

/// The Trash of a throwaway HOME (tests, the self-test): `<home>/.Trash/<name>`, numbered when taken.
pub fn trash_into(home: &Path, p: &Path) -> std::io::Result<()> {
    let bin = home.join(".Trash");
    std::fs::create_dir_all(&bin)?;
    let name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let mut dest = bin.join(&name);
    let mut n = 2;
    while dest.exists() {
        dest = bin.join(format!("{name} {n}"));
        n += 1;
    }
    std::fs::rename(p, dest)
}
