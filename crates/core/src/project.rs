//! Which folder a session is grouped under in the UI.
//!
//! Sessions are grouped by project, not by the raw `cwd`: a helper `claude`
//! launched from an agent's scratch directory belongs with its owner, and a
//! session in a repository subfolder or linked worktree belongs with the
//! repository. Everything here only reads files; no external command runs.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// The folder `cwd` should be grouped under (see the module docs). Computed once
/// per distinct `cwd` and cached for the life of the process. Empty in, empty out.
pub fn project_root(cwd: &str) -> String {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(p) = cache.lock().ok().and_then(|c| c.get(cwd).cloned()) {
        return p;
    }
    let p = resolve(cwd, Path::new("/"), dirs::home_dir().as_deref());
    if let Ok(mut c) = cache.lock() {
        c.insert(cwd.to_string(), p.clone());
    }
    p
}

/// [`project_root`] with the filesystem root and home directory passed in.
fn resolve(cwd: &str, fs_root: &Path, home: Option<&Path>) -> String {
    if cwd.is_empty() {
        return String::new();
    }
    if let Some(owner) = scratch_owner(cwd, fs_root) {
        return git_root(&owner, fs_root, home).unwrap_or(owner).to_string_lossy().into_owned();
    }
    git_root(Path::new(cwd), fs_root, home).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| cwd.to_string())
}

/// `/tmp/claude-<uid>/<encoded>/<session-id>/...` (also under `/private`, or any
/// `$TMPDIR` ending in `claude-<uid>`): the folder `<encoded>` stands for.
fn scratch_owner(cwd: &str, fs_root: &Path) -> Option<PathBuf> {
    let comps: Vec<&str> = cwd.split('/').filter(|c| !c.is_empty()).collect();
    let i = comps.iter().position(|c| c.strip_prefix("claude-").is_some_and(|u| !u.is_empty() && u.bytes().all(|b| b.is_ascii_digit())))?;
    let (encoded, _session) = (comps.get(i + 1)?, comps.get(i + 2)?);
    let rest = encoded.strip_prefix('-')?;
    let pieces: Vec<&str> = rest.split('-').collect();
    decode(fs_root, &pieces)
}

/// Directory-name form used in the encoding: every non-alphanumeric becomes `-`.
fn encode_name(name: &str) -> String {
    name.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Resolve `-`-separated `pieces` to an existing directory under `dir`, trying the
/// longest run of pieces first and backtracking when a choice dead-ends.
fn decode(dir: &Path, pieces: &[&str]) -> Option<PathBuf> {
    if pieces.is_empty() {
        return Some(dir.to_path_buf());
    }
    let subdirs: Vec<(String, PathBuf)> = fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| (encode_name(&e.file_name().to_string_lossy()), e.path()))
        .collect();
    for k in (1..=pieces.len()).rev() {
        let want = pieces[..k].join("-");
        for (_, path) in subdirs.iter().filter(|(enc, _)| *enc == want) {
            if let Some(found) = decode(path, &pieces[k..]) {
                return Some(found);
            }
        }
    }
    None
}

/// Nearest ancestor of `cwd` holding a `.git`, resolved to the main checkout for a
/// linked worktree. Never looks at `home` or above (or at `/`).
fn git_root(cwd: &Path, fs_root: &Path, home: Option<&Path>) -> Option<PathBuf> {
    for a in cwd.ancestors() {
        if a == fs_root || a.parent().is_none() || Some(a) == home {
            return None;
        }
        let dot = a.join(".git");
        if dot.is_dir() {
            return Some(a.to_path_buf());
        }
        if dot.is_file() {
            return Some(worktree_main(&dot, a).unwrap_or_else(|| a.to_path_buf()));
        }
    }
    None
}

/// Lexically drops `.` and resolves `..` (the path may not exist).
fn normalize(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    out
}

/// For a `.git` file `gitdir: <main>/.git/worktrees/<name>`, the `<main>` folder.
fn worktree_main(dot_git: &Path, base: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(dot_git).ok()?;
    let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let gd = normalize(&base.join(target));
    let worktrees = gd.parent()?;
    let dot = worktrees.parent()?;
    (worktrees.file_name()? == "worktrees" && dot.file_name()? == ".git").then(|| dot.parent().map(Path::to_path_buf))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("coool-project-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn scratch_dir_maps_to_owner_with_hyphens() {
        let root = tmp("scratch");
        fs::create_dir_all(root.join("Users/me/Desktop/project-3d")).unwrap();
        fs::create_dir_all(root.join("Users/me/Desktop/project")).unwrap();
        fs::create_dir_all(root.join("Users/me/.cfg/my-app.v2")).unwrap();
        for (enc, want) in [
            ("-Users-me-Desktop-project-3d", "Users/me/Desktop/project-3d"),
            ("-Users-me--cfg-my-app-v2", "Users/me/.cfg/my-app.v2"),
        ] {
            let cwd = format!("/private/tmp/claude-501/{enc}/b1cd1930/scratchpad/env-test");
            assert_eq!(resolve(&cwd, &root, None), s(&root.join(want)));
            let cwd = format!("/var/folders/ab/cd/T/claude-501/{enc}/sid");
            assert_eq!(resolve(&cwd, &root, None), s(&root.join(want)));
        }
        // Backtracking: "Desktop-project" does not exist, so it must back out and use "project".
        fs::create_dir_all(root.join("Users/me/Desktop-project")).unwrap();
        let cwd = "/tmp/claude-501/-Users-me-Desktop-project/sid/x";
        assert_eq!(resolve(cwd, &root, None), s(&root.join("Users/me/Desktop-project")));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unresolvable_scratch_falls_back_to_cwd() {
        let root = tmp("nores");
        let cwd = "/tmp/claude-501/-nope-nothing/sid/scratchpad/ct";
        assert_eq!(resolve(cwd, &root, None), cwd);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn git_repo_and_subfolder() {
        let root = tmp("git");
        let repo = root.join("home/me/code/app");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join("src/deep")).unwrap();
        let home = root.join("home/me");
        assert_eq!(resolve(&s(&repo.join("src/deep")), &root, Some(&home)), s(&repo));
        assert_eq!(resolve(&s(&repo), &root, Some(&home)), s(&repo));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn linked_worktree_maps_to_main_and_submodule_to_itself() {
        let root = tmp("wt");
        let home = root.join("home/me");
        let main = home.join("code/app");
        fs::create_dir_all(main.join(".git/worktrees/feat")).unwrap();
        fs::create_dir_all(main.join(".git/modules/sub")).unwrap();
        let wt = home.join("code/app-feat");
        fs::create_dir_all(wt.join("src")).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", main.join(".git/worktrees/feat").display())).unwrap();
        assert_eq!(resolve(&s(&wt.join("src")), &root, Some(&home)), s(&main));
        // Relative gitdir.
        fs::write(wt.join(".git"), "gitdir: ../app/.git/worktrees/feat\n").unwrap();
        assert_eq!(resolve(&s(&wt), &root, Some(&home)), s(&main));
        // Submodule.
        let sub = main.join("vendor/sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join(".git"), "gitdir: ../../.git/modules/sub\n").unwrap();
        assert_eq!(resolve(&s(&sub), &root, Some(&home)), s(&sub));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn scratch_owner_in_repo_subfolder_groups_with_repo() {
        let root = tmp("owner");
        let home = root.join("home/me");
        fs::create_dir_all(home.join("code/app/.git")).unwrap();
        fs::create_dir_all(home.join("code/app/pkg")).unwrap();
        let cwd = "/tmp/claude-501/-home-me-code-app-pkg/sid/scratchpad/x";
        assert_eq!(resolve(cwd, &root, Some(&home)), s(&home.join("code/app")));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn git_in_home_is_ignored() {
        let root = tmp("home");
        let home = root.join("home/me");
        fs::create_dir_all(home.join(".git")).unwrap();
        fs::create_dir_all(home.join("Desktop/plain")).unwrap();
        let plain = s(&home.join("Desktop/plain"));
        assert_eq!(resolve(&plain, &root, Some(&home)), plain);
        assert_eq!(resolve(&s(&home), &root, Some(&home)), s(&home));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn plain_and_empty() {
        assert_eq!(resolve("", Path::new("/"), None), "");
        assert_eq!(resolve("/definitely/not/here", Path::new("/"), None), "/definitely/not/here");
    }
}
