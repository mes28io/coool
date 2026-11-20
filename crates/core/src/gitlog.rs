//! A project's recent git history for Mission control's commit trail
//! (APP_SPEC "Mission control"): the current branch, its recent commits along
//! the first-parent line, and for each merge the commits it brought in (the
//! side branch, drawn as a curve). Read-only: only `log`, `rev-parse`,
//! `symbolic-ref`, `status` and `for-each-ref` run, always with
//! `--no-optional-locks` so not even the index is refreshed. Nothing here can
//! write to a repository.
//!
//! Mission control asks every 15 s per project. The history part (one `git log`,
//! plus one per merge in it) is reused while HEAD and every ref are where they
//! were, so a quiet repository costs two processes a poll (`status`,
//! `for-each-ref`) instead of five to seventeen.

use anyhow::{Context, Result, bail};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

/// `git` processes started so far (the self-test's perf scenarios read it).
pub static SPAWNS: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
thread_local! {
    /// This thread's `git` processes (tests run in parallel; the global count mixes them).
    static MINE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Mainline commits returned.
pub const MAINLINE: usize = 12;
/// Side-branch commits returned per merge.
pub const SIDE: usize = 4;
/// File names kept per commit.
pub const FILES: usize = 6;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct TrailCommit {
    pub sha: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    /// Author time, epoch ms.
    pub time_ms: i64,
    /// Changed paths (relative to the repository root), at most [`FILES`].
    pub files: Vec<String>,
    /// Changed paths not listed in `files`.
    pub files_more: u32,
    /// Branch and tag names pointing at this commit (`HEAD -> ` stripped).
    pub refs: Vec<String>,
    /// Set on merge commits: what came in from the second parent.
    pub merge: Option<MergeInfo>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct MergeInfo {
    /// The merged branch's name, from the subject or a ref on the side tip; None when neither says.
    pub from: Option<String>,
    /// The side branch's own commits, newest first (first-parent line from the second parent), at most [`SIDE`].
    pub commits: Vec<TrailCommit>,
    /// Side commits not listed.
    pub more: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct GitTrail {
    /// Repository top level.
    pub root: String,
    /// Current branch; None when HEAD is detached.
    pub branch: Option<String>,
    /// HEAD's sha (None in a repository with no commits yet).
    pub head: Option<String>,
    pub commits: Vec<TrailCommit>,
    /// More mainline commits exist past `commits`.
    pub more: bool,
    /// Paths with uncommitted changes (tracked and untracked), when known.
    pub uncommitted: Option<u32>,
}

/// One `git log` record before the graph is assembled.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Raw {
    sha: String,
    short: String,
    parents: Vec<String>,
    time_ms: i64,
    author: String,
    refs: Vec<String>,
    subject: String,
    files: Vec<String>,
}

/// Field and record separators in [`LOG_FORMAT`].
const FS: char = '\x1f';
const RS: char = '\x1e';
const LOG_FORMAT: &str = "--format=%x1e%H%x1f%h%x1f%P%x1f%at%x1f%an%x1f%D%x1f%s";

/// The only subcommands this module runs. Anything else is a bug and is refused.
const READ_ONLY: &[&str] = &["log", "rev-parse", "symbolic-ref", "status", "for-each-ref"];

fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let Some(sub) = args.first() else { bail!("no git subcommand") };
    if !READ_ONLY.contains(sub) {
        bail!("git {sub} is not a read-only command");
    }
    SPAWNS.fetch_add(1, Ordering::Relaxed);
    #[cfg(test)]
    MINE.with(|m| m.set(m.get() + 1));
    let out = Command::new("git")
        .arg("--no-optional-locks")
        .args(["-c", "core.quotepath=off", "-c", "log.showSignature=false", "-c", "color.ui=never"])
        // A folder from someone else can name a program in `core.fsmonitor`, which `git status` would run.
        .args(["-c", "core.fsmonitor=false"])
        .args(args)
        .current_dir(dir)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| "running git")?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        bail!("git {sub}: {}", err.lines().next().unwrap_or("failed").trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Parses `git log LOG_FORMAT --name-only` output.
fn parse_log(out: &str) -> Vec<Raw> {
    let mut v = Vec::new();
    for rec in out.split(RS) {
        let rec = rec.trim_start_matches('\n');
        if rec.trim().is_empty() {
            continue;
        }
        let mut lines = rec.lines();
        let Some(head) = lines.next() else { continue };
        let f: Vec<&str> = head.splitn(7, FS).collect();
        if f.len() < 7 || f[0].len() < 7 {
            continue;
        }
        v.push(Raw {
            sha: f[0].to_string(),
            short: f[1].to_string(),
            parents: f[2].split_whitespace().map(str::to_string).collect(),
            time_ms: f[3].trim().parse::<i64>().unwrap_or(0) * 1000,
            author: f[4].to_string(),
            refs: parse_refs(f[5]),
            subject: f[6].to_string(),
            files: lines.map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect(),
        });
    }
    v
}

/// `%D`: "HEAD -> main, origin/main, tag: v1.2" -> ["main", "origin/main", "v1.2"].
fn parse_refs(d: &str) -> Vec<String> {
    d.split(", ")
        .map(str::trim)
        .filter(|r| !r.is_empty() && *r != "HEAD" && !r.ends_with("/HEAD"))
        .map(|r| r.strip_prefix("HEAD -> ").or_else(|| r.strip_prefix("tag: ")).unwrap_or(r).to_string())
        .collect()
}

/// The branch a merge commit brought in, from its subject (git's, GitHub's and GitLab's wording).
pub fn merged_branch(subject: &str) -> Option<String> {
    let quoted = |s: &str| s.split('\'').nth(1).filter(|b| !b.is_empty()).map(str::to_string);
    if let Some(rest) = subject.strip_prefix("Merge branch ").or_else(|| subject.strip_prefix("Merge remote-tracking branch ")) {
        return quoted(rest);
    }
    if let Some(rest) = subject.strip_prefix("Merge pull request #") {
        // "Merge pull request #12 from owner/feature-x"
        let from = rest.split(" from ").nth(1)?.split_whitespace().next()?;
        return Some(from.split_once('/').map_or(from, |(_, b)| b).to_string());
    }
    None
}

fn commit(r: Raw) -> TrailCommit {
    let n = r.files.len();
    TrailCommit {
        sha: r.sha,
        short: r.short,
        subject: r.subject,
        author: r.author,
        time_ms: r.time_ms,
        files_more: n.saturating_sub(FILES) as u32,
        files: r.files.into_iter().take(FILES).collect(),
        refs: r.refs,
        merge: None,
    }
}

/// Builds the trail from the mainline log and, per merge, the log of its side branch
/// (`side(first_parent, second_parent)` returns that `git log` output).
fn assemble(main: &str, limit: usize, mut side: impl FnMut(&str, &str) -> Option<String>) -> (Vec<TrailCommit>, bool) {
    let raws = parse_log(main);
    let more = raws.len() > limit;
    let mut out = Vec::new();
    for r in raws.into_iter().take(limit) {
        let merge = (r.parents.len() >= 2).then(|| {
            let (p1, p2) = (r.parents[0].clone(), r.parents[1].clone());
            let side_raws = side(&p1, &p2).map(|o| parse_log(&o)).unwrap_or_default();
            let tip_ref = side_raws.first().and_then(|t| t.refs.iter().find(|x| !x.contains('/')).cloned());
            let n = side_raws.len();
            MergeInfo {
                from: merged_branch(&r.subject).or(tip_ref),
                more: n.saturating_sub(SIDE) as u32,
                commits: side_raws.into_iter().take(SIDE).map(commit).collect(),
            }
        });
        let mut c = commit(r);
        c.merge = merge;
        out.push(c);
    }
    (out, more)
}

/// `git status --porcelain` lines -> how many paths changed.
fn count_status(out: &str) -> u32 {
    out.lines().filter(|l| l.len() > 3).count() as u32
}

/// What `git status --porcelain=v2 --branch` says: (branch, head, changed paths).
fn parse_status_v2(out: &str) -> (Option<String>, Option<String>, u32) {
    let (mut branch, mut head, mut n) = (None, None, 0);
    for l in out.lines() {
        if let Some(h) = l.strip_prefix("# branch.head ") {
            branch = Some(h.trim().to_string()).filter(|b| !b.is_empty() && b != "(detached)");
        } else if let Some(o) = l.strip_prefix("# branch.oid ") {
            head = Some(o.trim().to_string()).filter(|o| !o.is_empty() && o != "(initial)");
        } else if !l.starts_with('#') && l.len() > 2 {
            n += 1;
        }
    }
    (branch, head, n)
}

/// The last history read per folder: its repository root, the refs it was read at, and what it found.
struct Known {
    root: String,
    refs: String,
    commits: Vec<TrailCommit>,
    more: bool,
}

fn known() -> &'static Mutex<HashMap<PathBuf, Known>> {
    static K: OnceLock<Mutex<HashMap<PathBuf, Known>>> = OnceLock::new();
    K.get_or_init(Default::default)
}

/// The trail for the repository containing `dir`. Steady state: `status` (branch, head, uncommitted) and
/// `for-each-ref`; the history is read again only when HEAD or a ref moved.
pub fn trail(dir: &Path) -> Result<GitTrail> {
    if !dir.is_dir() {
        bail!("{} is not a folder", dir.display());
    }
    // `--no-ahead-behind`: the upstream comparison can walk many commits and nothing here shows it.
    let Ok(st) = git(dir, &["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "--untracked-files=normal"]) else {
        // Not a repository, or a git without v2 status: the full read says which (and works with an old git).
        return trail_uncached(dir);
    };
    let (branch, head, uncommitted) = parse_status_v2(&st);
    let Some(h) = head.clone() else {
        // No commits yet: nothing to cache.
        return trail_uncached(dir);
    };
    let refs = format!("{h}\n{}", git(dir, &["for-each-ref", "--format=%(objectname) %(refname)"]).unwrap_or_default());
    if let Some(k) = known().lock().unwrap().get(dir).filter(|k| k.refs == refs) {
        return Ok(GitTrail { root: k.root.clone(), branch, head, commits: k.commits.clone(), more: k.more, uncommitted: Some(uncommitted) });
    }
    let t = trail_uncached(dir)?;
    // A ref that moved between the two reads makes the next poll read again (the key no longer matches).
    if t.head.as_deref() == Some(h.as_str()) {
        let mut k = known().lock().unwrap();
        if k.len() > 64 {
            k.clear();
        }
        k.insert(dir.to_path_buf(), Known { root: t.root.clone(), refs, commits: t.commits.clone(), more: t.more });
    }
    Ok(t)
}

/// Everything read afresh.
fn trail_uncached(dir: &Path) -> Result<GitTrail> {
    let root = git(dir, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    let branch = git(dir, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let head = git(dir, &["rev-parse", "-q", "--verify", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let mut t = GitTrail { root, branch, head, ..Default::default() };
    if t.head.is_none() {
        return Ok(t);
    }
    let n = (MAINLINE + 1).to_string();
    // --first-parent shows a merge's files against its first parent: what the merge brought in.
    let main = git(dir, &["log", "--first-parent", "-n", &n, LOG_FORMAT, "--name-only", "HEAD", "--"])?;
    let side_n = (SIDE + 1).to_string();
    let (commits, more) = assemble(&main, MAINLINE, |p1, p2| git(dir, &["log", "--first-parent", "-n", &side_n, LOG_FORMAT, "--name-only", &format!("{p1}..{p2}"), "--"]).ok());
    t.commits = commits;
    t.more = more;
    t.uncommitted = git(dir, &["status", "--porcelain=v1", "--untracked-files=normal"]).ok().map(|o| count_status(&o));
    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(sha: &str, parents: &str, t: i64, refs: &str, subject: &str, files: &[&str]) -> String {
        let mut s = format!("{RS}{sha}{FS}{}{FS}{parents}{FS}{t}{FS}Ada{FS}{refs}{FS}{subject}\n", &sha[..7]);
        if !files.is_empty() {
            s.push('\n');
            for f in files {
                s.push_str(f);
                s.push('\n');
            }
        }
        s
    }

    #[test]
    fn parses_records_files_and_refs() {
        let out = rec("aaaaaaaaaa", "bbbbbbbbbb", 1_700_000_000, "HEAD -> main, origin/main, tag: v1.2", "Fix rounding in proration", &["src/proration.ts", "src/a b.ts"])
            + &rec("bbbbbbbbbb", "", 1_699_999_000, "", "Initial commit", &[]);
        let v = parse_log(&out);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].short, "aaaaaaa");
        assert_eq!(v[0].time_ms, 1_700_000_000_000);
        assert_eq!(v[0].refs, ["main", "origin/main", "v1.2"]);
        assert_eq!(v[0].files, ["src/proration.ts", "src/a b.ts"]);
        assert_eq!(v[0].parents, ["bbbbbbbbbb"]);
        assert!(v[1].parents.is_empty() && v[1].files.is_empty());
        // A subject containing the field separator's neighbours and colons survives.
        let odd = rec("cccccccccc", "", 1, "", "Merge: a | b: c", &[]);
        assert_eq!(parse_log(&odd)[0].subject, "Merge: a | b: c");
        assert!(parse_log("").is_empty());
        assert!(parse_log("garbage\n").is_empty());
    }

    #[test]
    fn merged_branch_names() {
        assert_eq!(merged_branch("Merge branch 'worktree-agent-ab12' into main").as_deref(), Some("worktree-agent-ab12"));
        assert_eq!(merged_branch("Merge branch 'invoice-pdf'").as_deref(), Some("invoice-pdf"));
        assert_eq!(merged_branch("Merge remote-tracking branch 'origin/tax-rates'").as_deref(), Some("origin/tax-rates"));
        assert_eq!(merged_branch("Merge pull request #482 from acme/pricing-v2").as_deref(), Some("pricing-v2"));
        assert_eq!(merged_branch("Merge: fast device pilot"), None);
        assert_eq!(merged_branch("Fix the merge button"), None);
    }

    #[test]
    fn assembles_merges_with_their_side_branch() {
        let main = rec("m2m2m2m2m2", "c1c1c1c1c1 s9s9s9s9s9", 300, "HEAD -> main", "Merge: invoice PDFs", &["src/pdf.ts", "src/routes.ts"])
            + &rec("c1c1c1c1c1", "m1m1m1m1m1", 200, "", "Bump version", &["package.json"])
            + &rec("m1m1m1m1m1", "r0r0r0r0r0 t5t5t5t5t5", 100, "", "Merge branch 'tax-rates'", &["tax.ts"]);
        let mut asked = Vec::new();
        let (v, more) = assemble(&main, 2, |p1, p2| {
            asked.push(format!("{p1}..{p2}"));
            Some(rec("s9s9s9s9s9", "s8s8s8s8s8", 250, "worktree-agent-x, origin/worktree-agent-x", "Render line items", &["src/pdf.ts"]) + &rec("s8s8s8s8s8", "c1c1c1c1c1", 240, "", "Embed fonts", &[]))
        });
        assert!(more, "a third mainline record was cut by the limit");
        assert_eq!(v.len(), 2);
        assert_eq!(asked, ["c1c1c1c1c1..s9s9s9s9s9"], "only merges inside the limit are expanded");
        let m = v[0].merge.as_ref().expect("merge info");
        assert_eq!(m.from.as_deref(), Some("worktree-agent-x"), "a local branch on the side tip names it");
        assert_eq!(m.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["Render line items", "Embed fonts"]);
        assert_eq!(m.more, 0);
        assert!(v[1].merge.is_none());
        assert_eq!(v[0].refs, ["main"]);
    }

    #[test]
    fn caps_files_and_side_commits() {
        let files: Vec<String> = (0..9).map(|i| format!("f{i}.rs")).collect();
        let refs: Vec<&str> = files.iter().map(String::as_str).collect();
        let main = rec("m1m1m1m1m1", "a0a0a0a0a0 b0b0b0b0b0", 10, "", "Merge branch 'big'", &refs);
        let side: String = (0..7).map(|i| rec(&format!("s{i}s{i}s{i}s{i}s{i}"), "x", 9 - i, "", &format!("side {i}"), &[])).collect();
        let (v, more) = assemble(&main, 5, |_, _| Some(side.clone()));
        assert!(!more);
        assert_eq!(v[0].files.len(), FILES);
        assert_eq!(v[0].files_more, 3);
        let m = v[0].merge.as_ref().unwrap();
        assert_eq!(m.from.as_deref(), Some("big"));
        assert_eq!(m.commits.len(), SIDE);
        assert_eq!(m.more, 3);
        // A side log that failed leaves an empty side branch, not an error.
        let (v, _) = assemble(&main, 5, |_, _| None);
        assert!(v[0].merge.as_ref().unwrap().commits.is_empty());
    }

    #[test]
    fn counts_status_lines() {
        assert_eq!(count_status(" M src/a.rs\n?? new.txt\nA  b.rs\n"), 3);
        assert_eq!(count_status(""), 0);
    }

    #[test]
    fn reads_status_v2() {
        let out = "# branch.oid 1234567890abcdef\n# branch.head main\n# branch.upstream origin/main\n1 .M N... 100644 100644 100644 a b src/a.rs\n2 R. N... 100644 100644 100644 a b R100 new.rs\told.rs\n? new.txt\n";
        assert_eq!(parse_status_v2(out), (Some("main".into()), Some("1234567890abcdef".into()), 3));
        assert_eq!(parse_status_v2("# branch.oid (initial)\n# branch.head main\n"), (Some("main".into()), None, 0));
        assert_eq!(parse_status_v2("# branch.oid abc\n# branch.head (detached)\n").0, None);
    }

    /// The second read of an unchanged repository reuses the history: same trail, two processes.
    #[test]
    fn reuses_history_while_refs_stay() {
        let here = Path::new(env!("CARGO_MANIFEST_DIR"));
        let Ok(a) = trail(here) else { return }; // not a git checkout
        let before = MINE.with(|m| m.get());
        let b = trail(here).unwrap();
        let spawned = MINE.with(|m| m.get()) - before;
        // Unless a ref moved in between (someone committed): then it reads again.
        if a.head == b.head && a.commits == b.commits {
            assert_eq!(spawned, 2);
        }
        assert_eq!(a.root, b.root);
        assert_eq!(a.branch, b.branch);
        let fresh = trail_uncached(here).unwrap();
        if fresh.head == b.head {
            assert_eq!(fresh.commits, b.commits);
            assert_eq!(fresh.more, b.more);
            assert_eq!(fresh.branch, b.branch);
        }
    }

    #[test]
    fn refuses_writing_commands() {
        let d = std::env::temp_dir();
        for sub in ["commit", "push", "merge", "reset", "checkout", "gc", "fetch"] {
            let e = git(&d, &[sub]).unwrap_err().to_string();
            assert!(e.contains("not a read-only"), "{sub}: {e}");
        }
    }

    /// Against this repository itself (a git checkout with many `--no-ff` merges of worktree branches).
    #[test]
    fn reads_this_repository() {
        let here = Path::new(env!("CARGO_MANIFEST_DIR"));
        let Ok(t) = trail(here) else { return }; // not a git checkout (a source tarball): nothing to check
        assert!(t.head.is_some());
        assert!(!t.commits.is_empty() && t.commits.len() <= MAINLINE);
        assert!(t.commits.windows(2).all(|w| w[0].sha != w[1].sha));
        for c in &t.commits {
            assert!(c.time_ms > 1_600_000_000_000, "{c:?}");
            if let Some(m) = &c.merge {
                assert!(m.commits.len() <= SIDE);
            }
        }
    }
}
