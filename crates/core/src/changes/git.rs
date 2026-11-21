//! The git side of the Changes view. Reads use `--no-optional-locks` (nothing refreshed); the only writes are
//! `git add` (Keep and stage) and `git commit` (Commit, on the person's click), both refused while the repository is
//! in the middle of a merge, rebase, cherry-pick or revert. Nothing here pushes, fetches, resets or checks out.

use anyhow::{Context, Result, bail};
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct GitInfo {
    /// The repository's top level.
    pub top: String,
    pub branch: Option<String>,
    /// "merge", "rebase", "cherry-pick", "revert" while one is under way: only reading is allowed then.
    pub busy: Option<String>,
    /// Staged paths (absolute).
    pub staged: Vec<String>,
}

/// `git` processes started (the perf scenarios count them).
pub static SPAWNS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn run(dir: &Path, args: &[&str], input: Option<&[u8]>) -> Result<(bool, String, String)> {
    SPAWNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut c = Command::new("git");
    c.arg("-C").arg(dir).arg("--no-optional-locks").args(args).stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Never ask for anything (a credential, an editor).
    c.env("GIT_TERMINAL_PROMPT", "0").env("GIT_EDITOR", "true");
    let mut ch = c.spawn().context("couldn't run git")?;
    if let Some(i) = input {
        ch.stdin.take().unwrap().write_all(i)?;
    }
    let o = ch.wait_with_output()?;
    Ok((o.status.success(), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).trim().to_string()))
}

fn ok(dir: &Path, args: &[&str]) -> Result<String> {
    let (s, out, err) = run(dir, args, None)?;
    if !s {
        bail!("git {}: {}", args.first().unwrap_or(&""), err);
    }
    Ok(out)
}

/// The repository `dir` is in, or None when it isn't one (or git is missing).
pub fn info(dir: &Path) -> Option<GitInfo> {
    let out = ok(dir, &["rev-parse", "--show-toplevel", "--absolute-git-dir"]).ok()?;
    let mut l = out.lines();
    let top = l.next()?.to_string();
    let gd = PathBuf::from(l.next()?);
    let busy = busy_state(&gd);
    let branch = ok(dir, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let staged = ok(dir, &["diff", "--cached", "--name-only", "-z"])
        .map(|s| s.split('\0').filter(|p| !p.is_empty()).map(|p| Path::new(&top).join(p).to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    Some(GitInfo { top, branch, busy, staged })
}

/// What the repository is in the middle of, from its git dir.
pub fn busy_state(git_dir: &Path) -> Option<String> {
    if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        return Some("rebase".into());
    }
    if git_dir.join("MERGE_HEAD").exists() {
        return Some("merge".into());
    }
    if git_dir.join("CHERRY_PICK_HEAD").exists() {
        return Some("cherry-pick".into());
    }
    if git_dir.join("REVERT_HEAD").exists() {
        return Some("revert".into());
    }
    None
}

/// The file as HEAD has it (None when HEAD doesn't have it).
pub fn head_content(top: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(top).ok()?;
    let spec = format!("HEAD:{}", rel.to_string_lossy());
    let (s, out, _) = run(top, &["show", &spec], None).ok()?;
    s.then_some(out)
}

/// True when git tracks the path (in the index).
pub fn tracked(top: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(top) else { return false };
    run(top, &["ls-files", "--error-unmatch", "--", &rel.to_string_lossy()], None).map(|r| r.0).unwrap_or(false)
}

/// `git apply -R --check` of a patch (relative to `top`): would undoing it apply cleanly on the working tree?
pub fn reverse_applies(top: &Path, patch: &str) -> Result<(), String> {
    match run(top, &["apply", "-R", "--check", "--whitespace=nowarn", "-"], Some(patch.as_bytes())) {
        Ok((true, ..)) => Ok(()),
        Ok((false, _, e)) => Err(e.lines().next().unwrap_or("git apply refused it").to_string()),
        Err(e) => Err(format!("{e:#}")),
    }
}

fn refuse_busy(top: &Path) -> Result<()> {
    if let Some(i) = info(top)
        && let Some(b) = i.busy
    {
        bail!("the repository is in the middle of a {b}: finish or abort it first");
    }
    Ok(())
}

/// `git add -A -- paths` (deletions and renames included).
pub fn stage(top: &Path, paths: &[PathBuf]) -> Result<()> {
    refuse_busy(top)?;
    let rels: Vec<String> = paths.iter().filter_map(|p| p.strip_prefix(top).ok()).map(|r| r.to_string_lossy().into_owned()).collect();
    if rels.is_empty() {
        bail!("nothing to stage in this repository");
    }
    let mut args = vec!["add", "-A", "--"];
    args.extend(rels.iter().map(String::as_str));
    ok(top, &args)?;
    Ok(())
}

/// Commits what is staged with `message` (hooks run as usual). Returns the new commit's short sha.
pub fn commit(top: &Path, message: &str) -> Result<String> {
    refuse_busy(top)?;
    let m = message.trim();
    if m.is_empty() {
        bail!("write a commit message first");
    }
    let (clean, ..) = run(top, &["diff", "--cached", "--quiet"], None)?;
    if clean {
        bail!("nothing is staged: keep and stage some changes first");
    }
    // The message on stdin: nothing in it is read as an option.
    let (s, _, err) = run(top, &["commit", "-q", "-F", "-"], Some(m.as_bytes()))?;
    if !s {
        bail!("git commit: {err}");
    }
    Ok(ok(top, &["rev-parse", "--short", "HEAD"])?.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_states_from_the_git_dir() {
        let d = std::env::temp_dir().join(format!("coool-changes-gitdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(busy_state(&d), None);
        std::fs::write(d.join("MERGE_HEAD"), "x").unwrap();
        assert_eq!(busy_state(&d).as_deref(), Some("merge"));
        std::fs::create_dir_all(d.join("rebase-merge")).unwrap();
        assert_eq!(busy_state(&d).as_deref(), Some("rebase"));
        std::fs::remove_dir_all(&d).unwrap();
    }
}
