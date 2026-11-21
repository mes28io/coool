//! The Changes view's commands (APP_SPEC "Changes") around `coool_core::changes`.
//!
//! - `changes_load`: the diff of a session's changes for a scope (the chat, what isn't kept, one turn). Transcripts
//!   are found through the hub (the session's own and its subagents', by the ids the page names), never a path the
//!   page gives.
//! - `changes_undo`, `changes_keep`: write only inside the session's folder (resolved), atomically; deletions go to the
//!   Trash (NSFileManager, no prompt); refused mid merge or rebase. Keep's `stage` runs `git add`.
//! - `changes_commit`: `git commit` of what is staged, on the person's click. Nothing here pushes.
//! - `changes_told`: notes about files the agent edited again after an undo were sent.
//! - `changes_preview`: a pending edit (a permission request) as its diff on the file as it is now. Read-only.
//! - `changes_open`: a file at a line in the editor chosen in Settings > General.

use crate::{Core, Res};
use coool_core::changes::{self, ChangeSet, FileChange, Outcome, Request, Scope, Source};
use coool_core::changes::record::Kind;
use coool_core::model::Provider;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

/// Which session and what part of its changes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    provider: Provider,
    session_id: String,
    /// Its subagents (Claude agent ids, Codex thread ids), from the session as listed.
    #[serde(default)]
    agents: Vec<String>,
    cwd: String,
    #[serde(default)]
    scope: String,
    /// Runs outside coool (a terminal): undo only through git.
    #[serde(default)]
    external: bool,
}

fn sources(core: &Core, t: &Target) -> Vec<Source> {
    let hub = core.hub.lock().unwrap();
    let kind = match t.provider {
        Provider::Claude => Kind::Claude,
        Provider::Codex => Kind::Codex,
    };
    let mut out = Vec::new();
    if let Some(p) = hub.transcript_path(t.provider, &t.session_id, None) {
        out.push(Source { kind, agent: None, path: p });
    }
    for a in t.agents.iter().take(200) {
        if let Some(p) = hub.transcript_path(t.provider, &t.session_id, Some(a)).filter(|p| !out.iter().any(|s| s.path == *p)) {
            out.push(Source { kind, agent: Some(a.clone()), path: p });
        }
    }
    out
}

fn key(t: &Target) -> String {
    format!("{}:{}", t.provider.label(), t.session_id)
}

fn with<R>(core: &Core, t: &Target, f: impl FnOnce(&mut changes::Changes, &Request) -> R) -> Res<R> {
    if t.cwd.trim().is_empty() || !Path::new(&t.cwd).is_absolute() {
        return Err("this session has no folder".into());
    }
    let src = sources(core, t);
    if src.is_empty() {
        return Err("this session's transcript isn't known yet".into());
    }
    let k = key(t);
    let cwd = PathBuf::from(&t.cwd);
    let req = Request { key: &k, cwd: &cwd, sources: &src, scope: Scope::parse(&t.scope), external: t.external };
    let mut eng = core.changes.lock().unwrap();
    Ok(f(&mut eng, &req))
}

/// Where what the person kept is saved (a self-test keeps it in its folder).
pub fn state_dir(selftest: Option<&crate::selftest::SelfTest>) -> Option<PathBuf> {
    match selftest {
        Some(t) => Some(t.dir().join(".coool-selftest-changes")),
        None => dirs::config_dir().map(|d| d.join("coool").join("changes")),
    }
}

#[tauri::command(async)]
pub fn changes_load(core: State<'_, Arc<Core>>, target: Target) -> Res<ChangeSet> {
    let t = std::time::Instant::now();
    let r = with(&core, &target, |e, r| e.load(r));
    if core.selftest.is_some() {
        use crate::perf::*;
        bump(&CHANGES_LOADS, 1);
        bump(&CHANGES_US, t.elapsed().as_micros() as u64);
        if let Ok(cs) = &r {
            bump(&CHANGES_BYTES, serde_json::to_vec(cs).map(|v| v.len() as u64).unwrap_or(0));
        }
    }
    r
}

#[tauri::command(async)]
pub fn changes_undo(core: State<'_, Arc<Core>>, target: Target, file: Option<String>, hunk: Option<String>, force: Option<bool>) -> Res<Outcome> {
    with(&core, &target, |e, r| e.undo(r, file.as_deref(), hunk.as_deref(), force.unwrap_or(false), &trash))
}

#[tauri::command(async)]
pub fn changes_keep(core: State<'_, Arc<Core>>, target: Target, file: Option<String>, hunk: Option<String>, stage: Option<bool>, unkeep: Option<bool>) -> Res<Outcome> {
    with(&core, &target, |e, r| e.keep(r, file.as_deref(), hunk.as_deref(), stage.unwrap_or(false), unkeep.unwrap_or(false)))
}

#[tauri::command(async)]
pub fn changes_told(core: State<'_, Arc<Core>>, target: Target, paths: Vec<String>) -> Res<()> {
    core.changes.lock().unwrap().mark_told(&key(&target), &paths);
    Ok(())
}

#[tauri::command(async)]
pub fn changes_commit(cwd: String, message: String) -> Res<Outcome> {
    if !Path::new(&cwd).is_absolute() {
        return Err("not a full path".into());
    }
    Ok(changes::commit(Path::new(&cwd), &message))
}

#[tauri::command(async)]
pub fn changes_preview(cwd: String, tool: String, input: serde_json::Value) -> Res<Vec<FileChange>> {
    if !Path::new(&cwd).is_absolute() {
        return Err("not a full path".into());
    }
    Ok(changes::preview(Path::new(&cwd), &tool, &input))
}

/// Opens `path` at `line` in the editor from Settings > General (only a file inside `cwd`).
#[tauri::command(async)]
pub fn changes_open(core: State<'_, Arc<Core>>, cwd: String, path: String, line: Option<u32>) -> Res<()> {
    let root = changes::canonical_root(Path::new(&cwd));
    let p = changes::resolved(Path::new(&path));
    if !p.starts_with(&root) || !p.is_file() {
        return Err("only a file inside this chat's folder opens from here".into());
    }
    let app = crate::settings::load(core.selftest.as_ref()).open_with;
    crate::apps::open_at(&app, &p.to_string_lossy(), line.unwrap_or(1).max(1))
}

/// Moves a file to the Trash (Finder can put it back), without asking for any permission.
#[cfg(target_os = "macos")]
pub fn trash(p: &Path) -> anyhow::Result<()> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let s = NSString::from_str(&p.to_string_lossy());
    let url = NSURL::fileURLWithPath(&s);
    let fm = NSFileManager::defaultManager();
    fm.trashItemAtURL_resultingItemURL_error(&url, None).map_err(|e| anyhow::anyhow!("couldn't move {} to the Trash: {}", p.display(), e.localizedDescription()))
}

#[cfg(not(target_os = "macos"))]
pub fn trash(p: &Path) -> anyhow::Result<()> {
    anyhow::bail!("no Trash on this system for {}", p.display())
}
