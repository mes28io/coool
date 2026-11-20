//! Minor 1: Mission control for the phone (docs/REMOTE.md "Minor 1"), from what the Mac already shows. The Changes
//! ledger follows app/src/lib/mission.ts (`changesFromActivity`, `sideEffect`) in a smaller form: file writes and
//! edits inside the project, and shell commands with an effect outside it (commit, push, merge, rebase, reset, PRs,
//! publishes, deploys, deletes). Overlaps: a file that two sessions edited in the same project within the window.
//! Pure functions over plain inputs; app/src-tauri/src/remote.rs feeds them each session's timeline.

use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepKind {
    Prompt,
    Tool,
    /// An error; `true` when it is one failed step (the tool call before it failed).
    Error(bool),
    Other,
}

/// One entry of a session's timeline: `text` is `Name · detail` for a tool (crates/core's Activity).
pub struct Step<'a> {
    pub ts: u64,
    pub kind: StepKind,
    pub text: &'a str,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Change {
    pub session: String,
    /// edit, create, delete, move, commit, push, merge, pr, publish, deploy.
    pub kind: &'static str,
    pub action: String,
    pub object: String,
    #[serde(skip_serializing_if = "is_one")]
    pub times: u32,
    pub ts: u64,
}

fn is_one(n: &u32) -> bool {
    *n == 1
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Overlap {
    pub file: String,
    pub sessions: Vec<String>,
    pub ts: u64,
}

fn split(text: &str) -> (&str, &str) {
    text.split_once(" · ").unwrap_or((text, ""))
}

fn is_file_tool(n: &str) -> bool {
    matches!(n.to_ascii_lowercase().as_str(), "write" | "edit" | "multiedit" | "notebookedit" | "apply_patch" | "patch" | "str_replace_based_edit_tool")
}

fn is_shell_tool(n: &str) -> bool {
    matches!(n.to_ascii_lowercase().as_str(), "bash" | "shell" | "exec_command" | "local_shell" | "command_execution")
}

fn clip(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n - 1).collect::<String>().trim_end()) }
}

/// A path inside the project, relative to it (`~/` expanded with `home`); None outside it.
pub fn project_path(p: &str, root: &str, home: &str) -> Option<String> {
    let p = p.trim();
    let abs = if let Some(r) = p.strip_prefix("~/") { format!("{home}/{r}") } else { p.to_string() };
    if !abs.starts_with('/') {
        return (!abs.starts_with("..")).then(|| abs.trim_start_matches("./").to_string());
    }
    let root = root.trim_end_matches('/');
    let rest = abs.strip_prefix(root)?.strip_prefix('/')?;
    (!rest.is_empty()).then(|| rest.to_string())
}

/// The message of a `git commit -m "…"` segment.
fn commit_message(seg: &str) -> Option<String> {
    let i = seg.find(" -m ").or_else(|| seg.find(" -am "))?;
    let rest = seg[i..].trim_start().split_once(' ')?.1.trim_start();
    let q = rest.chars().next()?;
    if q == '"' || q == '\'' {
        let body = &rest[1..];
        let end = body.find(q).unwrap_or(body.len());
        let m = body[..end].lines().next().unwrap_or("").trim().to_string();
        return (!m.is_empty() && !m.starts_with("$(")).then_some(m);
    }
    rest.split_whitespace().next().map(str::to_string)
}

fn words(seg: &str, skip: usize) -> Vec<&str> {
    seg.split_whitespace().skip(skip).filter(|w| !w.starts_with('-')).collect()
}

/// A shell command's effect outside the session (follows mission.ts `sideEffect`, smaller).
pub fn side_effect(cmd: &str) -> Option<(&'static str, String, String)> {
    for seg in cmd.split(['\n', ';', '|', '&']) {
        let mut seg = seg.trim().trim_start_matches('(').trim();
        while let Some((first, rest)) = seg.split_once(' ') {
            if first.contains('=') && !first.starts_with('-') {
                seg = rest.trim_start();
            } else {
                break;
            }
        }
        let seg = seg.strip_prefix("sudo ").unwrap_or(seg);
        let seg = if let Some(r) = seg.strip_prefix("git -C ") { r.split_once(' ').map(|(_, r)| format!("git {r}")).unwrap_or_default() } else { seg.to_string() };
        let s = seg.as_str();
        if s.starts_with("git commit") {
            return Some(("commit", "Committed".into(), commit_message(s).map(|m| clip(&m, 72)).unwrap_or_else(|| "a commit".into())));
        }
        if s.starts_with("git push") {
            let w = words(s, 2);
            return Some(("push", "Pushed".into(), w.get(1).or(w.first()).map(|x| x.to_string()).unwrap_or_else(|| "to the remote".into())));
        }
        if s.starts_with("git merge") && !s.contains("--abort") {
            return Some(("merge", "Merged".into(), words(s, 2).first().map(|x| x.to_string()).unwrap_or_else(|| "a branch".into())));
        }
        if s.starts_with("git rebase") && !s.contains("--abort") && !s.contains("--continue") && !s.contains("--skip") {
            return Some(("merge", "Rebased".into(), words(s, 2).first().map(|x| format!("onto {x}")).unwrap_or_else(|| "the branch".into())));
        }
        if s.starts_with("git reset --hard") {
            return Some(("delete", "Reset".into(), words(s, 3).first().map(|x| x.to_string()).unwrap_or_else(|| "HEAD".into())));
        }
        if s.starts_with("gh pr create") {
            return Some(("pr", "Opened PR".into(), "a pull request".into()));
        }
        if s.starts_with("gh pr merge") {
            return Some(("merge", "Merged PR".into(), words(s, 3).first().map(|x| format!("#{}", x.trim_start_matches('#'))).unwrap_or_else(|| "a pull request".into())));
        }
        if ["npm publish", "pnpm publish", "yarn publish", "bun publish", "cargo publish"].iter().any(|p| s.starts_with(p)) {
            return Some(("publish", "Published".into(), if s.starts_with("cargo") { "the crate".into() } else { "the package".into() }));
        }
        let t = s.strip_prefix("npx ").unwrap_or(s);
        for (tool, name) in [("vercel", "Vercel"), ("netlify", "Netlify"), ("firebase", "Firebase"), ("wrangler", "Wrangler"), ("fly", "Fly"), ("flyctl", "Fly")] {
            if let Some(rest) = t.strip_prefix(tool).filter(|r| r.is_empty() || r.starts_with(' ')) {
                if rest.contains("deploy") || rest.contains("publish") || (tool == "vercel" && (rest.trim().is_empty() || rest.trim() == "--prod")) {
                    return Some(("deploy", "Deployed".into(), format!("{} ({name})", if rest.contains("--prod") || rest.contains("production") { "to production" } else { "a preview" })));
                }
            }
        }
        if s.starts_with("git rm ") || s.starts_with("rm ") {
            let git = s.starts_with("git");
            if let Some(first) = words(s, if git { 2 } else { 1 }).first() {
                return Some(("delete", "Deleted".into(), first.to_string()));
            }
        }
    }
    None
}

/// The changes in one session's timeline, newest first. Same file, same session, same turn: one row ("×3").
pub fn changes(session: &str, steps: &[Step], root: &str, home: &str) -> Vec<Change> {
    let mut rows: Vec<(Change, usize)> = Vec::new();
    let mut turn = 0usize;
    for (i, a) in steps.iter().enumerate() {
        match a.kind {
            StepKind::Prompt => {
                turn = i;
                continue;
            }
            StepKind::Tool => {}
            _ => continue,
        }
        if matches!(steps.get(i + 1).map(|s| s.kind), Some(StepKind::Error(true))) {
            continue;
        }
        let (name, detail) = split(a.text);
        let mut effects: Vec<(&'static str, String, String)> = Vec::new();
        if is_file_tool(name) && !detail.is_empty() {
            let create = name.eq_ignore_ascii_case("write");
            let files: Vec<&str> = if matches!(name.to_ascii_lowercase().as_str(), "apply_patch" | "patch") { detail.split(", ").collect() } else { vec![detail] };
            for f in files {
                if let Some(o) = project_path(f, root, home) {
                    effects.push(if create { ("create", "Wrote".into(), o) } else { ("edit", "Edited".into(), o) });
                }
            }
        } else if is_shell_tool(name) && !detail.is_empty() {
            effects.extend(side_effect(detail));
        }
        for (kind, action, object) in effects {
            if kind == "edit"
                && let Some((prev, _)) = rows.iter_mut().find(|(r, t)| r.kind == "edit" && *t == turn && r.object == object)
            {
                prev.times += 1;
                prev.ts = prev.ts.max(a.ts);
                continue;
            }
            rows.push((Change { session: session.into(), kind, action, object, times: 1, ts: a.ts }, turn));
        }
    }
    let mut out: Vec<Change> = rows.into_iter().map(|(c, _)| c).collect();
    out.reverse();
    out
}

/// Files edited (or written) by two or more sessions within `window_ms` of each other.
pub fn overlaps(all: &[Change], window_ms: u64) -> Vec<Overlap> {
    let mut by: BTreeMap<&str, Vec<&Change>> = BTreeMap::new();
    for c in all.iter().filter(|c| c.kind == "edit" || c.kind == "create") {
        by.entry(c.object.as_str()).or_default().push(c);
    }
    let mut out = Vec::new();
    for (file, cs) in by {
        let mut sessions: Vec<String> = Vec::new();
        for c in &cs {
            if !sessions.contains(&c.session) {
                sessions.push(c.session.clone());
            }
        }
        if sessions.len() < 2 {
            continue;
        }
        let (lo, hi) = (cs.iter().map(|c| c.ts).min().unwrap_or(0), cs.iter().map(|c| c.ts).max().unwrap_or(0));
        if hi - lo <= window_ms {
            out.push(Overlap { file: file.to_string(), sessions, ts: hi });
        }
    }
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(ts: u64, text: &str) -> Step<'_> {
        Step { ts, kind: StepKind::Tool, text }
    }

    #[test]
    fn edits_inside_the_project_coalesce_per_turn() {
        let steps = vec![
            Step { ts: 1, kind: StepKind::Prompt, text: "go" },
            tool(2, "Edit · /w/app/src/a.rs"),
            tool(3, "Edit · /w/app/src/a.rs"),
            tool(4, "Write · /w/app/src/new.rs"),
            tool(5, "Edit · /etc/hosts"),
            tool(6, "Edit · /w/app/src/b.rs"),
            Step { ts: 7, kind: StepKind::Error(true), text: "failed" },
            tool(8, "Read · /w/app/src/c.rs"),
            Step { ts: 9, kind: StepKind::Prompt, text: "again" },
            tool(10, "Edit · ~/w/app/src/a.rs"),
        ];
        let c = changes("s1", &steps, "/w/app", "/Users/x");
        let rows: Vec<(&str, &str, u32)> = c.iter().map(|c| (c.action.as_str(), c.object.as_str(), c.times)).collect();
        assert_eq!(rows, vec![("Wrote", "src/new.rs", 1), ("Edited", "src/a.rs", 2)]);
        let c = changes("s1", &steps, "/w/app", "");
        assert_eq!(c[0].object, "src/a.rs");
        assert_eq!(c.len(), 3, "the next turn's edit is its own row");
    }

    #[test]
    fn shell_commands_with_effects() {
        let e = |c: &str| side_effect(c).map(|(k, a, o)| (k, a, o));
        assert_eq!(e(r#"git add -A && git commit -m "Fix the parser""#), Some(("commit", "Committed".into(), "Fix the parser".into())));
        assert_eq!(e("cd app && git push origin main"), Some(("push", "Pushed".into(), "main".into())));
        assert_eq!(e("git merge feature/login"), Some(("merge", "Merged".into(), "feature/login".into())));
        assert_eq!(e("npx vercel --prod").unwrap().2, "to production (Vercel)");
        assert_eq!(e("cargo test"), None);
        assert_eq!(e("git status"), None);
        assert_eq!(e("FOO=1 git commit -am wip").unwrap().2, "wip");
    }

    #[test]
    fn two_sessions_on_one_file_is_an_overlap() {
        let a = changes("s1", &[tool(1_000, "Edit · /w/app/src/a.rs"), tool(1_000, "Edit · /w/app/src/only.rs")], "/w/app", "/");
        let b = changes("s2", &[tool(5_000, "Edit · /w/app/src/a.rs")], "/w/app", "/");
        let all: Vec<Change> = a.into_iter().chain(b).collect();
        let o = overlaps(&all, 3_600_000);
        assert_eq!(o.len(), 1);
        assert_eq!((o[0].file.as_str(), o[0].sessions.len()), ("src/a.rs", 2));
        assert!(overlaps(&all, 1_000).is_empty());
    }
}
