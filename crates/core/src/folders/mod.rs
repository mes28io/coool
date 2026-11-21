//! The New session sheet's folder finder (APP_SPEC "New session"): a Finder-like listing of one folder, a background
//! index of the person's code folders and git repositories (depth-limited, cached in memory and on disk), path
//! completion, creating a folder, and a summary of the folder a chat is about to start in.
//!
//! Read only, except [`create`] (a new, empty folder inside the home folder, never over anything) and [`git_init`].
//! Nothing here reads a file's contents: listings, `stat`s and git's own status. The context summary goes through
//! [`crate::chatctx::overview`], the Context panel's lookup, which reads what the CLI would load and nothing more.
//!
//! macOS asks the person before an app lists Desktop, Documents, Downloads, iCloud Drive or another volume
//! ([`protected`]). The index never goes there; a listing, completion or summary there happens only when the caller
//! says the person chose to (`allow_protected`), so the prompt comes when they navigate there and not before.

#[cfg(test)]
mod tests;

use crate::chatctx::{self, Group, Inputs, Launch, Load};
use crate::model::Provider;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Folder names the index never walks into (and a listing still shows: they are the person's).
pub const IGNORE: &[&str] = &[
    "node_modules", ".git", "Library", "target", "build", "dist", "out", "vendor", "Pods", "DerivedData", "venv", ".venv", "__pycache__",
    ".next", ".nuxt", ".turbo", ".cache", "coverage", "Applications", "Movies", "Music", "Pictures", "Public", ".Trash", "bower_components",
    ".gradle", ".build", "site-packages", "Caches",
];

/// Folder names under the home folder that usually hold code (the index's roots, when they exist).
pub const CODE_ROOTS: &[&str] = &[
    "code", "Code", "Developer", "dev", "Dev", "src", "projects", "Projects", "repos", "Repos", "git", "GitHub", "github", "work", "Work",
    "workspace", "Workspace", "Sites", "dev-projects",
];

/// Folder "files" macOS shows as one item (an app, a library): never entered.
const PACKAGES: &[&str] = &[".app", ".bundle", ".framework", ".photoslibrary", ".musiclibrary", ".plugin", ".kext", ".xcarchive", ".pkg"];

/// A listing shows at most this many folders.
const LIST_MAX: usize = 4000;

// ------------------------------------------------------------------------------------------------ places

/// Which privacy-guarded place `p` is in, if any ("Desktop", "Documents", "Downloads", "iCloud Drive", "Volumes").
pub fn protected(home: &Path, p: &Path) -> Option<&'static str> {
    for (name, rel) in [("Desktop", "Desktop"), ("Documents", "Documents"), ("Downloads", "Downloads"), ("iCloud Drive", "Library/Mobile Documents")] {
        if p.starts_with(home.join(rel)) {
            return Some(name);
        }
    }
    let mut c = p.components();
    if c.next() == Some(std::path::Component::RootDir) && c.next().is_some_and(|x| x.as_os_str() == "Volumes") && c.next().is_some() {
        return Some("Volumes");
    }
    None
}

fn ignored(name: &str) -> bool {
    name.starts_with('.') || IGNORE.contains(&name) || is_package(name)
}

fn is_package(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    PACKAGES.iter().any(|s| l.ends_with(s))
}

fn ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A git repository's root: it has `.git` (a folder, or a file for a worktree).
pub fn is_repo(p: &Path) -> bool {
    std::fs::symlink_metadata(p.join(".git")).is_ok()
}

/// `~` and `~/x` to absolute paths.
pub fn expand(input: &str, home: &Path) -> PathBuf {
    if input == "~" {
        return home.to_path_buf();
    }
    if let Some(r) = input.strip_prefix("~/") {
        return home.join(r);
    }
    PathBuf::from(input)
}

/// Case-insensitive order with numbers by value ("v2" before "v10"), as Finder sorts.
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, _) => return std::cmp::Ordering::Less,
            (_, None) => return std::cmp::Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let mut n = String::new();
                while let Some(c) = x.peek().copied().filter(char::is_ascii_digit) {
                    n.push(c);
                    x.next();
                }
                let mut m = String::new();
                while let Some(d) = y.peek().copied().filter(char::is_ascii_digit) {
                    m.push(d);
                    y.next();
                }
                let (n, m) = (n.trim_start_matches('0'), m.trim_start_matches('0'));
                let o = n.len().cmp(&m.len()).then_with(|| n.cmp(m));
                if o != std::cmp::Ordering::Equal {
                    return o;
                }
            }
            (Some(c), Some(d)) => {
                let o = c.to_lowercase().cmp(d.to_lowercase());
                if o != std::cmp::Ordering::Equal {
                    return o;
                }
                x.next();
                y.next();
            }
        }
    }
}

// ------------------------------------------------------------------------------------------------ one folder

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    /// A git repository's root.
    pub repo: bool,
    pub hidden: bool,
    /// A symbolic link to a folder.
    pub link: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Listing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
    /// Files (not shown) directly in the folder.
    pub files: u32,
    /// Hidden folders not shown.
    pub hidden: u32,
    /// More folders than shown.
    pub more: bool,
    /// The place macOS guards that this is in; with `gated`, nothing was read.
    pub protected: Option<String>,
    /// Not listed: it is in a guarded place and the person hasn't chosen to go there yet.
    pub gated: bool,
    pub error: Option<String>,
}

/// The folders in `dir` (hidden ones too with `hidden`), sorted as Finder does. Files are only counted.
pub fn list(dir: &Path, home: &Path, hidden: bool, allow_protected: bool) -> Listing {
    let mut out = Listing { path: dir.display().to_string(), parent: dir.parent().map(|p| p.display().to_string()), ..Listing::default() };
    out.protected = protected(home, dir).map(str::to_string);
    if out.protected.is_some() && !allow_protected {
        out.gated = true;
        return out;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) => {
            out.error = Some(match e.kind() {
                std::io::ErrorKind::NotFound => "This folder doesn't exist".into(),
                std::io::ErrorKind::PermissionDenied => "coool isn't allowed to list this folder".into(),
                _ if e.raw_os_error() == Some(libc::ENOTDIR) => "This is a file, not a folder".into(),
                _ => e.to_string(),
            });
            return out;
        }
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(ft) = e.file_type() else { continue };
        let path = e.path();
        let (is_dir, link) = if ft.is_symlink() { (std::fs::metadata(&path).is_ok_and(|m| m.is_dir()), true) } else { (ft.is_dir(), false) };
        if !is_dir || is_package(&name) {
            out.files += 1;
            continue;
        }
        let dot = name.starts_with('.');
        if dot && !hidden {
            out.hidden += 1;
            continue;
        }
        if out.entries.len() >= LIST_MAX {
            out.more = true;
            continue;
        }
        out.entries.push(Entry { repo: !link && is_repo(&path), path: path.display().to_string(), name, hidden: dot, link });
    }
    out.entries.sort_by(|a, b| natural_cmp(&a.name, &b.name));
    out
}

// ------------------------------------------------------------------------------------------------ completion

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Completion {
    /// The folder the names are in, as typed (with `~` when typed so).
    pub dir: String,
    /// Folder names starting with what was typed after the last `/` (at most 50).
    pub matches: Vec<String>,
    /// What Tab puts in the field: the one match and a `/`, or the matches' longest common start (None: nothing to add).
    pub completed: Option<String>,
    pub gated: bool,
}

/// Tab completion of a folder path. Case-insensitive; hidden folders only when the typed name starts with `.`.
pub fn complete(input: &str, home: &Path, allow_protected: bool) -> Completion {
    let (dir_typed, prefix) = match input.rfind('/') {
        Some(i) => (&input[..=i], &input[i + 1..]),
        None if input == "~" => return Completion { dir: String::new(), matches: vec!["~".into()], completed: Some("~/".into()), gated: false },
        None => return Completion::default(),
    };
    let mut out = Completion { dir: dir_typed.to_string(), ..Completion::default() };
    let dir = expand(dir_typed.trim_end_matches('/'), home);
    let dir = if dir.as_os_str().is_empty() { PathBuf::from("/") } else { dir };
    if protected(home, &dir).is_some() && !allow_protected {
        out.gated = true;
        return out;
    }
    let low = prefix.to_lowercase();
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir() || (t.is_symlink() && e.path().is_dir())))
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| (!n.starts_with('.') || prefix.starts_with('.')) && !is_package(n) && n.to_lowercase().starts_with(&low))
                .collect()
        })
        .unwrap_or_default();
    names.sort_by(|a, b| natural_cmp(a, b));
    names.truncate(50);
    out.completed = match names.as_slice() {
        [] => None,
        [one] => Some(format!("{dir_typed}{one}/")),
        many => {
            let common = common_prefix_ci(many);
            (common.chars().count() > prefix.chars().count()).then(|| format!("{dir_typed}{common}"))
        }
    };
    out.matches = names;
    out
}

/// The longest start all names share, ignoring case (in the first name's spelling).
fn common_prefix_ci(names: &[String]) -> String {
    let first: Vec<char> = names[0].chars().collect();
    let mut n = first.len();
    for s in &names[1..] {
        let k = first.iter().zip(s.chars()).take_while(|(a, b)| a.to_lowercase().eq(b.to_lowercase())).count();
        n = n.min(k);
    }
    first[..n].iter().collect()
}

// ------------------------------------------------------------------------------------------------ the index

/// Where the index looks, and how deep.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Root {
    pub path: PathBuf,
    /// Folders this deep below the root are indexed by name (1 = its children).
    pub depth: usize,
    /// Repositories are looked for this deep (>= `depth`).
    pub repo_depth: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hit {
    pub path: String,
    pub name: String,
    pub repo: bool,
    /// Its git index's (else the folder's) modification time: when it was last worked in, roughly.
    pub modified_ms: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Folders visited at most, over all roots.
    pub max_dirs: usize,
    pub deadline: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self { max_dirs: 30_000, deadline: Duration::from_secs(6) }
    }
}

/// The default roots: the home folder's own folders (1 deep, names only), and the code folders that exist (repositories
/// up to 4 deep). Guarded places are never roots.
pub fn default_roots(home: &Path) -> Vec<Root> {
    let mut v = vec![Root { path: home.to_path_buf(), depth: 1, repo_depth: 1 }];
    let mut seen = HashSet::new();
    for n in CODE_ROOTS {
        let p = home.join(n);
        // A case-insensitive volume has one folder for "code" and "Code".
        if let Ok(c) = std::fs::canonicalize(&p)
            && p.is_dir()
            && seen.insert(c)
        {
            v.push(Root { path: p, depth: 2, repo_depth: 4 });
        }
    }
    v
}

/// Walks `roots` breadth first, never into ignored, hidden, guarded or package folders nor through links, and never
/// below a repository's root. Stops at the limits (what was found so far is kept).
pub fn scan(roots: &[Root], home: &Path, lim: Limits) -> Vec<Hit> {
    let start = Instant::now();
    let mut visited = 0usize;
    let mut out: Vec<Hit> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    for r in roots {
        if protected(home, &r.path).is_some() {
            continue;
        }
        let max = r.depth.max(r.repo_depth);
        let mut queue = std::collections::VecDeque::from([(r.path.clone(), 0usize)]);
        while let Some((dir, d)) = queue.pop_front() {
            if visited >= lim.max_dirs || start.elapsed() > lim.deadline {
                return out;
            }
            visited += 1;
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let Ok(ft) = e.file_type() else { continue };
                if !ft.is_dir() {
                    continue;
                }
                let name = e.file_name().to_string_lossy().into_owned();
                if ignored(&name) {
                    continue;
                }
                let p = e.path();
                if protected(home, &p).is_some() || !seen.insert(p.clone()) {
                    continue;
                }
                let depth = d + 1;
                let repo = is_repo(&p);
                if depth <= r.depth || repo {
                    let stamp = std::fs::metadata(p.join(".git").join("index")).or_else(|_| std::fs::metadata(&p)).and_then(|m| m.modified()).map(ms).unwrap_or(0);
                    out.push(Hit { path: p.display().to_string(), name, repo, modified_ms: stamp });
                }
                if !repo && depth < max {
                    queue.push_back((p, depth));
                }
            }
        }
    }
    out
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct IndexView {
    pub hits: Vec<Hit>,
    /// When the hits were found (0: never).
    pub at_ms: u64,
    /// A scan runs now; ask again for its result.
    pub scanning: bool,
    pub roots: Vec<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    roots: Vec<Root>,
    at_ms: u64,
    hits: Vec<Hit>,
}

#[derive(Default)]
struct IndexState {
    saved: Saved,
    scanning: bool,
    scans: u32,
}

/// The index: answers at once from what it has, and walks the disk again in the background when that is older than
/// `ttl`, the roots changed, or the caller forces it. What it found is kept in `file` for the next launch.
pub struct Index {
    st: Mutex<IndexState>,
    ttl: Duration,
    file: Option<PathBuf>,
    limits: Limits,
}

impl Index {
    pub fn new(file: Option<PathBuf>, ttl: Duration, limits: Limits) -> Self {
        let saved = file.as_ref().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice::<Saved>(&b).ok()).unwrap_or_default();
        Self { st: Mutex::new(IndexState { saved, ..Default::default() }), ttl, file, limits }
    }

    /// How many scans ran (tests).
    pub fn scans(&self) -> u32 {
        self.st.lock().unwrap().scans
    }

    /// What the index has now; starts a scan in the background when it is stale.
    pub fn get(self: &Arc<Self>, roots: Vec<Root>, home: &Path, force: bool) -> IndexView {
        let mut st = self.st.lock().unwrap();
        let now = ms(SystemTime::now());
        let stale = st.saved.roots != roots || now.saturating_sub(st.saved.at_ms) > self.ttl.as_millis() as u64 || st.saved.at_ms == 0;
        if (stale || force) && !st.scanning {
            st.scanning = true;
            let me = Arc::clone(self);
            let (roots, home) = (roots.clone(), home.to_path_buf());
            std::thread::Builder::new()
                .name("coool-folder-index".into())
                .spawn(move || me.run(roots, &home))
                .ok();
        }
        // Results for other roots still help while the new ones are found (most roots stay).
        IndexView { hits: st.saved.hits.clone(), at_ms: st.saved.at_ms, scanning: st.scanning, roots: roots.iter().map(|r| r.path.display().to_string()).collect() }
    }

    /// Scans now, on this thread.
    pub fn run(&self, roots: Vec<Root>, home: &Path) {
        let hits = scan(&roots, home, self.limits);
        let mut st = self.st.lock().unwrap();
        st.saved = Saved { roots, at_ms: ms(SystemTime::now()), hits };
        st.scanning = false;
        st.scans += 1;
        if let Some(f) = &self.file
            && let Ok(b) = serde_json::to_vec(&st.saved)
        {
            if let Some(d) = f.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let tmp = f.with_extension("tmp");
            if std::fs::write(&tmp, b).is_ok() {
                let _ = std::fs::rename(&tmp, f);
            }
        }
    }
}

// ------------------------------------------------------------------------------------------------ creating

/// Why a name can't be a folder's (None: it can).
pub fn name_problem(name: &str) -> Option<&'static str> {
    let n = name.trim();
    if n.is_empty() {
        Some("Give the folder a name")
    } else if n == "." || n == ".." {
        Some("That name is taken by the system")
    } else if n.contains('/') || n.contains(':') || n.contains('\0') {
        Some("A folder name can't contain “/” or “:”")
    } else if n.len() > 255 {
        Some("That name is too long")
    } else {
        None
    }
}

/// Makes the empty folder `name` in `parent`: only inside the home folder (not in its Library or Trash), never over
/// anything that exists (a file, a folder or a link). Returns its path.
pub fn create(parent: &Path, name: &str, home: &Path) -> Result<PathBuf, String> {
    if let Some(p) = name_problem(name) {
        return Err(p.into());
    }
    let name = name.trim();
    let home_c = std::fs::canonicalize(home).map_err(|_| "No home folder".to_string())?;
    let parent_c = std::fs::canonicalize(parent).map_err(|_| format!("{} doesn't exist", parent.display()))?;
    if !parent_c.is_dir() {
        return Err(format!("{} isn't a folder", parent.display()));
    }
    if !parent_c.starts_with(&home_c) {
        return Err("New folders go inside your home folder only".into());
    }
    if parent_c.starts_with(home_c.join("Library")) || parent_c.starts_with(home_c.join(".Trash")) {
        return Err("coool doesn't make folders in Library or the Trash".into());
    }
    let target = parent_c.join(name);
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(format!("“{name}” already exists here"));
    }
    // create_dir (not create_dir_all) fails if something appeared meanwhile: never over an existing path.
    std::fs::create_dir(&target).map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { format!("“{name}” already exists here") } else { e.to_string() })?;
    Ok(parent.join(name))
}

/// `git init` in a folder that isn't in a repository yet.
pub fn git_init(dir: &Path) -> Result<(), String> {
    if is_repo(dir) {
        return Err("It is a git repository already".into());
    }
    git(dir, &["init", "-q"], Duration::from_secs(10)).map(|_| ())
}

// ------------------------------------------------------------------------------------------------ the summary

/// Runs git (no optional locks, no fsmonitor program, nothing asked of the person) with a deadline.
fn git(dir: &Path, args: &[&str], within: Duration) -> Result<String, String> {
    let mut c = Command::new("git");
    c.arg("-c").arg("core.fsmonitor=false").arg("-C").arg(dir).args(args);
    c.env("GIT_OPTIONAL_LOCKS", "0").env("GIT_TERMINAL_PROMPT", "0").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut ch = c.spawn().map_err(|e| format!("couldn't run git: {e}"))?;
    let start = Instant::now();
    loop {
        match ch.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > within => {
                let _ = ch.kill();
                let _ = ch.wait();
                return Err("git took too long".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let o = ch.wait_with_output().map_err(|e| e.to_string())?;
    if o.status.success() {
        Ok(String::from_utf8_lossy(&o.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&o.stderr).lines().next().unwrap_or("git failed").to_string())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Commit {
    pub short: String,
    pub subject: String,
    pub when_ms: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct GitInfo {
    pub root: String,
    /// None when HEAD is detached (or there are no commits yet: see `last`).
    pub branch: Option<String>,
    /// Paths with uncommitted changes (untracked included); None when git didn't answer in time.
    pub changes: Option<u32>,
    pub last: Option<Commit>,
    /// A worktree: the main repository's folder.
    pub worktree_of: Option<String>,
    /// The folder is the repository's root (not a folder inside it).
    pub at_root: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct CtxFile {
    pub label: String,
    pub path: String,
    pub source: String,
    pub tokens: u64,
}

/// What the chosen CLI starts with in this folder, from the Context panel's lookup.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct CtxSummary {
    /// Instruction files of this project (its folder, the repository and the folders between), in load order.
    pub project: Vec<CtxFile>,
    /// The person's own instruction files (all projects).
    pub user: u32,
    pub skills: u32,
    /// Of those, the project's own.
    pub project_skills: u32,
    /// Claude Code's auto memory for this project has an index.
    pub memory: bool,
    /// Tokens these add to the first request.
    pub tokens: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Summary {
    pub path: String,
    pub exists: bool,
    pub is_dir: bool,
    pub inside_home: bool,
    pub writable: bool,
    pub protected: Option<String>,
    /// In a guarded place the person hasn't opened yet: nothing below `protected` was read.
    pub gated: bool,
    pub folders: u32,
    pub files: u32,
    /// What it looks like from its file names ("Rust", "Node", "Swift"...).
    pub stack: Vec<String>,
    pub git: Option<GitInfo>,
    pub context: Option<CtxSummary>,
}

/// File names that say what a project is built with (names only; nothing is opened).
const STACKS: &[(&str, &str)] = &[
    ("Cargo.toml", "Rust"),
    ("package.json", "Node"),
    ("pyproject.toml", "Python"),
    ("requirements.txt", "Python"),
    ("go.mod", "Go"),
    ("Package.swift", "Swift"),
    ("Gemfile", "Ruby"),
    ("pom.xml", "Java"),
    ("build.gradle", "Gradle"),
    ("build.gradle.kts", "Gradle"),
    ("composer.json", "PHP"),
    ("mix.exs", "Elixir"),
    ("deno.json", "Deno"),
    ("pubspec.yaml", "Dart"),
    ("CMakeLists.txt", "C/C++"),
    ("Makefile", "Make"),
    ("Dockerfile", "Docker"),
];

fn is_writable(p: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(p.as_os_str().as_bytes()) else { return false };
    // SAFETY: a valid NUL-terminated path.
    unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
}

/// Parses `git status --porcelain=v2 --branch`: (branch, has a commit, changed paths).
pub fn parse_status(out: &str) -> (Option<String>, bool, u32) {
    let (mut branch, mut head, mut n) = (None, false, 0);
    for l in out.lines() {
        if let Some(h) = l.strip_prefix("# branch.head ") {
            branch = Some(h.trim().to_string()).filter(|b| !b.is_empty() && b != "(detached)");
        } else if let Some(o) = l.strip_prefix("# branch.oid ") {
            head = o.trim() != "(initial)";
        } else if !l.starts_with('#') && l.len() > 2 {
            n += 1;
        }
    }
    (branch, head, n)
}

fn git_info(dir: &Path) -> Option<GitInfo> {
    let f = chatctx::folder(dir);
    let root = f.repo_root.clone()?;
    let mut g = GitInfo { root: root.clone(), branch: f.branch.clone(), worktree_of: f.worktree_of.clone(), at_root: Path::new(&root) == dir, ..GitInfo::default() };
    let within = Duration::from_millis(2500);
    let mut has_commit = true;
    if let Ok(st) = git(dir, &["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "--untracked-files=normal"], within) {
        let (b, h, n) = parse_status(&st);
        g.branch = b.or(g.branch);
        g.changes = Some(n);
        has_commit = h;
    }
    if has_commit && let Ok(l) = git(dir, &["log", "-1", "--format=%h%x00%ct%x00%s"], within) {
        let mut it = l.trim_end().splitn(3, '\0');
        if let (Some(short), Some(t), Some(subject)) = (it.next(), it.next(), it.next()) {
            g.last = Some(Commit { short: short.into(), subject: subject.into(), when_ms: t.parse::<u64>().unwrap_or(0) * 1000 });
        }
    }
    Some(g)
}

fn ctx_summary(provider: Provider, dir: &Path, home: &Path) -> CtxSummary {
    // As coool would launch it (no "runs outside coool" note); what coool itself adds isn't counted here.
    let ov = chatctx::overview(provider, dir, home, &Inputs { launch: Some(Launch::default()), ..Inputs::default() });
    let mut s = CtxSummary::default();
    for i in &ov.items {
        match i.group {
            Group::Instructions if i.load == Load::Start || i.load == Load::Conditional => {
                if i.kind == "user" || i.kind == "rules" && i.source.starts_with("User") || i.kind == "import" {
                    s.user += u32::from(i.kind != "import");
                } else if let Some(p) = &i.path {
                    s.project.push(CtxFile { label: i.label.clone(), path: p.clone(), source: i.source.clone(), tokens: i.tokens });
                }
            }
            Group::Memory if i.kind == "memory_index" => s.memory = true,
            Group::Skills => {
                s.skills += 1;
                s.project_skills += u32::from(i.source.starts_with("Project"));
            }
            _ => {}
        }
        if i.group != Group::Coool {
            s.tokens += i.tokens;
        }
    }
    s
}

/// The folder a chat is about to start in: whether it exists and may be written, what it holds (counts and a stack
/// guessed from file names), its git state and what `provider` starts with there.
pub fn summary(dir: &Path, home: &Path, provider: Provider, allow_protected: bool) -> Summary {
    let home_c = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let mut s = Summary { path: dir.display().to_string(), protected: protected(home, dir).map(str::to_string), ..Summary::default() };
    s.inside_home = std::fs::canonicalize(dir).map(|c| c.starts_with(&home_c)).unwrap_or_else(|_| dir.starts_with(home));
    if s.protected.is_some() && !allow_protected {
        s.gated = true;
        return s;
    }
    let Ok(m) = std::fs::metadata(dir) else { return s };
    s.exists = true;
    s.is_dir = m.is_dir();
    if !s.is_dir {
        return s;
    }
    s.writable = is_writable(dir);
    let mut stack: Vec<String> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                s.folders += u32::from(!name.starts_with('.'));
            } else {
                s.files += u32::from(!name.starts_with('.'));
                if let Some((_, k)) = STACKS.iter().find(|(f, _)| *f == name)
                    && !stack.iter().any(|x| x == k)
                {
                    stack.push((*k).to_string());
                }
            }
            if name.ends_with(".xcodeproj") && !stack.iter().any(|x| x == "Xcode") {
                stack.push("Xcode".into());
            }
        }
    }
    stack.sort_by_key(|k| STACKS.iter().position(|(_, x)| x == k).unwrap_or(99));
    s.stack = stack;
    s.git = git_info(dir);
    s.context = Some(ctx_summary(provider, dir, home));
    s
}
