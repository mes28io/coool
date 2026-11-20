//! A project's git worktrees for Settings: which are agent worktrees, which
//! are merged and clean, how much disk each takes, and a safe remove.
//!
//! Reads run git with `GIT_OPTIONAL_LOCKS=0` so they never take the index
//! lock. Removal re-checks everything first and only ever uses
//! `git worktree remove` without `--force` and `git branch -d`, so git itself
//! refuses anything that would lose work.

use super::storage;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// A project's worktrees.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Worktrees {
    /// e.g. "git version 2.50.1".
    pub git: Option<String>,
    /// The main worktree.
    pub root: Option<String>,
    /// The branch checked out in the main worktree, else origin/HEAD's.
    pub main_branch: Option<String>,
    pub list: Vec<Worktree>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    /// Short sha.
    pub head: String,
    /// The main worktree.
    pub main: bool,
    pub agent: bool,
    pub merged: bool,
    pub dirty: bool,
    pub locked: bool,
    pub prunable: bool,
    pub bytes: Option<u64>,
    pub removable: bool,
    pub why_not: Option<String>,
}

/// One block of `git worktree list --porcelain`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RawWt {
    pub path: String,
    pub head: Option<String>,
    /// Short name, without `refs/heads/`.
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

/// Parses `git worktree list --porcelain`: blocks separated by blank lines.
pub fn parse_porcelain(s: &str) -> Vec<RawWt> {
    let mut v: Vec<RawWt> = Vec::new();
    let mut cur: Option<RawWt> = None;
    for line in s.lines().chain(std::iter::once("")) {
        if line.is_empty() {
            v.extend(cur.take());
            continue;
        }
        let (key, rest) = line.split_once(' ').unwrap_or((line, ""));
        if key == "worktree" {
            v.extend(cur.take());
            cur = Some(RawWt { path: rest.into(), ..Default::default() });
            continue;
        }
        let Some(w) = cur.as_mut() else { continue };
        match key {
            "HEAD" => w.head = Some(rest.into()),
            "branch" => w.branch = Some(rest.strip_prefix("refs/heads/").unwrap_or(rest).into()),
            "detached" => w.detached = true,
            "bare" => w.bare = true,
            "locked" => w.locked = true,
            "prunable" => w.prunable = true,
            _ => {}
        }
    }
    v
}

/// A worktree an agent made: under `.claude/worktrees/`, `.codex/worktrees/` or `.coool/worktrees/`.
pub fn is_agent_path(path: &str) -> bool {
    ["/.claude/worktrees/", "/.codex/worktrees/", "/.coool/worktrees/"].iter().any(|m| path.contains(m))
}

/// Runs git with stdin closed and optional locks off. Ok(stdout) on exit 0, else Err(first stderr line).
fn git(dir: Option<&Path>, args: &[&str]) -> Result<String, String> {
    let mut c = Command::new("git");
    // A folder from someone else can name a program in `core.fsmonitor`, which git would run.
    c.args(["-c", "core.fsmonitor=false"]);
    if let Some(d) = dir {
        c.arg("-C").arg(d);
    }
    let out = c
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Couldn't run git: {e}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    Err(err.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("git failed").chars().take(300).collect())
}

/// The branch to compare against and its display name.
fn main_ref(root: &Path, main: &RawWt) -> Option<(String, String)> {
    if let Some(b) = &main.branch {
        return Some((b.clone(), b.clone()));
    }
    let r = git(Some(root), &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).ok()?;
    let name = r.trim().strip_prefix("refs/remotes/origin/")?.to_string();
    Some((format!("origin/{name}"), name))
}

/// Why a worktree can't be removed, in the order the UI should explain it.
fn why_not(w: &Worktree) -> Option<&'static str> {
    if w.main {
        Some("The main worktree")
    } else if !w.agent {
        Some("Not an agent worktree")
    } else if w.locked {
        Some("Locked")
    } else if w.dirty {
        Some("Has uncommitted changes")
    } else if !w.merged {
        Some("Not merged into main")
    } else {
        None
    }
}

fn describe(root: &Path, main_ref: Option<&str>, raw: &RawWt, is_main: bool) -> Worktree {
    let head = raw.head.clone().unwrap_or_default();
    let path = Path::new(&raw.path);
    let exists = path.is_dir();
    let merged = match main_ref {
        Some(m) if !head.is_empty() => git(Some(root), &["merge-base", "--is-ancestor", &head, m]).is_ok(),
        _ => false,
    };
    // A status that fails counts as dirty, so it is never offered for removal.
    let dirty = exists && !raw.bare && !git(Some(path), &["status", "--porcelain"]).is_ok_and(|s| s.trim().is_empty());
    let bytes = if exists { storage::dir_size(path, storage::BUDGET).map(|s| s.0) } else { None };
    let mut w = Worktree {
        path: raw.path.clone(),
        branch: raw.branch.clone(),
        head: head.chars().take(7).collect(),
        main: is_main,
        agent: is_agent_path(&raw.path),
        merged,
        dirty,
        locked: raw.locked,
        prunable: raw.prunable,
        bytes,
        removable: false,
        why_not: None,
    };
    w.why_not = why_not(&w).map(str::to_string);
    w.removable = w.why_not.is_none();
    w
}

/// Lists a project's worktrees with their state. Problems land in `error`, never a panic.
pub fn list(project: &Path) -> Worktrees {
    let mut out = Worktrees::default();
    match git(None, &["--version"]) {
        Ok(v) => out.git = Some(v.trim().to_string()),
        Err(_) => {
            out.error = Some("Git isn't installed".into());
            return out;
        }
    }
    let raws = match git(Some(project), &["worktree", "list", "--porcelain"]) {
        Ok(s) => parse_porcelain(&s),
        Err(e) => {
            out.error = Some(e);
            return out;
        }
    };
    let Some(first) = raws.first() else { return out };
    let root = PathBuf::from(&first.path);
    let main = main_ref(&root, first);
    out.root = Some(first.path.clone());
    out.main_branch = main.as_ref().map(|m| m.1.clone());
    let mref = main.as_ref().map(|m| m.0.as_str());
    out.list = std::thread::scope(|s| {
        let hs: Vec<_> = raws.iter().enumerate().map(|(i, r)| s.spawn({ let root = &root; move || describe(root, mref, r, i == 0) })).collect();
        hs.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    out
}

fn canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Removes an agent worktree that is merged, clean and unlocked, then deletes its branch with `git branch -d`.
pub fn remove(project: &Path, path: &Path) -> Result<(), String> {
    let wts = list(project);
    if let Some(e) = wts.error {
        return Err(e);
    }
    let root = wts.root.ok_or("No worktrees found")?;
    let want = canonical(path);
    let w = wts.list.into_iter().find(|w| canonical(Path::new(&w.path)) == want).ok_or("Not a worktree of this project")?;
    if !w.removable {
        return Err(w.why_not.unwrap_or_else(|| "Can't be removed".into()));
    }
    git(Some(Path::new(&root)), &["worktree", "remove", &w.path])?;
    if let Some(b) = &w.branch {
        // Safe delete: git refuses if the branch isn't merged. A failure here loses nothing.
        let _ = git(Some(Path::new(&root)), &["branch", "-d", b]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain() {
        let s = "worktree /r\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\n\
                 worktree /r/.claude/worktrees/a\nHEAD 2222222222222222222222222222222222222222\ndetached\nlocked reason here\n\n\
                 worktree /gone\nHEAD 3333333333333333333333333333333333333333\nbranch refs/heads/feat/x\nprunable gitdir file points to non-existent location\n";
        let v = parse_porcelain(s);
        assert_eq!(v.len(), 3);
        assert_eq!(v[0], RawWt { path: "/r".into(), head: Some("1".repeat(40)), branch: Some("main".into()), ..Default::default() });
        assert!(v[1].detached && v[1].locked && v[1].branch.is_none());
        assert_eq!(v[2].branch.as_deref(), Some("feat/x"));
        assert!(v[2].prunable);
        assert!(parse_porcelain("worktree /bare\nbare\n")[0].bare);
        assert!(parse_porcelain("").is_empty());
    }

    #[test]
    fn agent_paths() {
        assert!(is_agent_path("/p/.claude/worktrees/agent-1"));
        assert!(is_agent_path("/p/.codex/worktrees/x"));
        assert!(is_agent_path("/p/.coool/worktrees/x"));
        assert!(!is_agent_path("/p/worktrees/x"));
        assert!(!is_agent_path("/p/.claude/worktreesx/y"));
    }

    fn run(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"])
            .args(args)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(ok.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&ok.stderr));
    }

    #[test]
    fn list_and_remove_in_a_real_repo() {
        if crate::env::which("git").is_none() {
            return;
        }
        let base = std::env::temp_dir().join(format!("coool-wt-{}-{:?}", std::process::id(), std::time::Instant::now()));
        std::fs::create_dir_all(&base).unwrap();
        let repo = canonical(&base);
        run(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("f.txt"), "1").unwrap();
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "-qm", "init"]);
        let wt = |n: &str| repo.join(".claude/worktrees").join(n);
        for n in ["a", "b", "c"] {
            run(&repo, &["worktree", "add", "-q", "-b", n, wt(n).to_str().unwrap()]);
        }
        std::fs::write(wt("a").join("a.txt"), "a").unwrap();
        run(&wt("a"), &["add", "."]);
        run(&wt("a"), &["commit", "-qm", "a"]);
        run(&repo, &["merge", "-q", "--ff-only", "a"]);
        std::fs::write(wt("b").join("b.txt"), "b").unwrap();
        run(&wt("b"), &["add", "."]);
        run(&wt("b"), &["commit", "-qm", "b"]);
        std::fs::write(wt("c").join("untracked.txt"), "c").unwrap();

        let l = list(&repo);
        assert!(l.error.is_none(), "{:?}", l.error);
        assert_eq!(l.main_branch.as_deref(), Some("main"));
        assert_eq!(l.list.len(), 4);
        let get = |n: &str| l.list.iter().find(|w| w.branch.as_deref() == Some(n)).unwrap().clone();
        let main = get("main");
        assert!(main.main && !main.removable && main.why_not.as_deref() == Some("The main worktree"));
        let a = get("a");
        assert!(a.agent && a.merged && !a.dirty && a.removable, "{a:?}");
        assert!(a.bytes.is_some_and(|b| b > 0) && a.head.len() == 7);
        let b = get("b");
        assert_eq!(b.why_not.as_deref(), Some("Not merged into main"));
        let c = get("c");
        assert!(c.dirty && !c.removable && c.why_not.as_deref() == Some("Has uncommitted changes"));

        assert_eq!(remove(&repo, &wt("b")), Err("Not merged into main".into()));
        assert!(wt("b").exists());
        assert_eq!(remove(&repo, &wt("c")), Err("Has uncommitted changes".into()));
        assert!(remove(&repo, &repo).is_err());
        remove(&repo, &wt("a")).unwrap();
        assert!(!wt("a").exists());
        let branches = git(Some(&repo), &["branch", "--list", "a"]).unwrap();
        assert!(branches.trim().is_empty(), "branch a is gone");
        let _ = std::fs::remove_dir_all(&base);
    }
}
