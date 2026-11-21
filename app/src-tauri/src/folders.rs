//! The New session sheet's folder commands (APP_SPEC "New session"). `coool_core::folders` does the work; this file
//! knows the home folder, keeps the one index (cached in coool's cache folder) and adds the places the sheet's
//! sidebar starts from. Read only, except `folders_create` (an empty folder inside home, optionally `git init`) and
//! `worktree_create`. No network.
//!
//! `allow`: the person chose to open a place macOS guards (Desktop, Documents, Downloads, iCloud Drive, a volume).
//! Without it nothing there is read, so macOS's one-time prompt only ever comes when they go there.

use crate::{Res, prefs};
use coool_core::folders::{self, Completion, Index, IndexView, Limits, Listing, Root, Summary};
use coool_core::model::Provider;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// The index's results are kept this long before a later ask walks the disk again (in the background).
const TTL: Duration = Duration::from_secs(5 * 60);

fn home() -> Res<PathBuf> {
    dirs::home_dir().ok_or_else(|| "no home folder".to_string())
}

fn index() -> &'static Arc<Index> {
    static I: OnceLock<Arc<Index>> = OnceLock::new();
    I.get_or_init(|| Arc::new(Index::new(dirs::cache_dir().map(|d| d.join("coool").join("folder-index.json")), TTL, Limits::default())))
}

fn abs(p: &str) -> Res<PathBuf> {
    let p = PathBuf::from(crate::expand_tilde(p.trim()));
    if !p.is_absolute() {
        return Err("Type a full path (starting with / or ~)".into());
    }
    Ok(p)
}

#[derive(Serialize)]
pub struct Place {
    /// "home", "desktop", "documents", "downloads", "code".
    kind: &'static str,
    label: String,
    path: String,
    /// macOS asks once before coool can list it.
    guarded: bool,
}

#[derive(Serialize)]
pub struct IndexReply {
    home: String,
    places: Vec<Place>,
    #[serde(flatten)]
    view: IndexView,
}

/// The sidebar's places that exist (a `stat` of each, never a listing) and the index as it is now (a scan starts in
/// the background when it is older than five minutes, `refresh`, or `extra` adds roots: the parents of the person's
/// recent projects, two deep).
#[tauri::command(async)]
pub fn folders_index(extra: Vec<String>, refresh: bool) -> Res<IndexReply> {
    let home = home()?;
    let mut places = vec![Place { kind: "home", label: home.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Home".into()), path: home.display().to_string(), guarded: false }];
    for (kind, name) in [("desktop", "Desktop"), ("documents", "Documents"), ("downloads", "Downloads")] {
        let p = home.join(name);
        if p.is_dir() {
            places.push(Place { kind, label: name.into(), path: p.display().to_string(), guarded: true });
        }
    }
    let mut roots = folders::default_roots(&home);
    for r in roots.iter().skip(1) {
        places.push(Place { kind: "code", label: r.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), path: r.path.display().to_string(), guarded: false });
    }
    let mut extra: Vec<PathBuf> = extra.iter().filter_map(|e| abs(e).ok()).filter(|p| p.starts_with(&home) && *p != home && folders::protected(&home, p).is_none() && p.is_dir()).collect();
    extra.sort();
    extra.dedup();
    for p in extra.into_iter().take(12) {
        if !roots.iter().any(|r| p.starts_with(&r.path) && r.path != home) {
            roots.push(Root { path: p, depth: 1, repo_depth: 2 });
        }
    }
    let view = index().get(roots, &home, refresh);
    Ok(IndexReply { home: home.display().to_string(), places, view })
}

/// One folder's folders, Finder's way.
#[tauri::command(async)]
pub fn folders_list(path: String, hidden: bool, allow: bool) -> Res<Listing> {
    Ok(folders::list(&abs(&path)?, &home()?, hidden, allow))
}

/// Tab completion of the path field.
#[tauri::command(async)]
pub fn folders_complete(input: String, allow: bool) -> Res<Completion> {
    Ok(folders::complete(input.trim_start(), &home()?, allow))
}

/// The folder a chat is about to start in, for the sheet's details.
#[tauri::command(async)]
pub fn folders_summary(path: String, provider: Provider, allow: bool) -> Res<Summary> {
    Ok(folders::summary(&abs(&path)?, &home()?, provider, allow))
}

/// A new folder in `parent` (inside the home folder only, never over anything), with `git init` when asked; its path.
#[tauri::command(async)]
pub fn folders_create(parent: String, name: String, git: bool) -> Res<String> {
    let home = home()?;
    let p = folders::create(&abs(&parent)?, &name, &home)?;
    if git {
        folders::git_init(&p).map_err(|e| format!("Made the folder, but git init failed: {e}"))?;
    }
    Ok(p.display().to_string())
}

#[derive(Serialize)]
pub struct NewWorktree {
    path: String,
    branch: String,
}

/// A new worktree of `project`'s repository for a chat to start in (prefs/worktrees.rs `create`).
#[tauri::command(async)]
pub fn worktree_create(project: String, name: String) -> Res<NewWorktree> {
    let (path, branch) = prefs::worktrees::create(Path::new(&abs(&project)?), &name)?;
    Ok(NewWorktree { path, branch })
}
