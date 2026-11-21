//! The Context panel's commands (APP_SPEC "Context panel"). `coool_core::chatctx` does the work and holds the
//! allow-list (every read and write is checked there); this file gathers what only the app knows: the chat's launch
//! record, its transcript, the size of coool's device tools, the person's plugins and MCP servers (read only, as
//! Settings > Connections does), and moves deleted files to the Trash. Nothing here touches the network.

use crate::{Core, Res, prefs};
use coool_core::chatctx::{self, Inputs, Overview, TranscriptScan, UserMcp, guard};
use coool_core::model::Provider;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;

/// Which chat the panel is for.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    provider: Provider,
    cwd: String,
    /// A chat coool runs: its launch record says what coool added.
    #[serde(default)]
    chat: Option<usize>,
    /// The session's transcript: which skills it used, the model it started with.
    #[serde(default)]
    session_id: Option<String>,
}

/// Transcripts read for the panel (incrementally), and the person's plugins / MCP servers per folder (briefly cached:
/// the panel asks every few seconds while open).
#[derive(Default)]
pub struct ContextState {
    scans: Mutex<HashMap<PathBuf, (TranscriptScan, Instant)>>,
    config: Mutex<HashMap<(Provider, String), Config>>,
}

/// When it was read, the enabled plugins (name, folder), the MCP servers.
type Config = (Instant, Vec<(String, PathBuf)>, Vec<UserMcp>);

const KEEP_SCANS: usize = 6;
const CONFIG_TTL: Duration = Duration::from_secs(20);

fn home() -> Res<PathBuf> {
    dirs::home_dir().ok_or_else(|| "no home folder".to_string())
}

fn cwd_of(t: &Target) -> Res<PathBuf> {
    let p = PathBuf::from(&t.cwd);
    if !p.is_absolute() {
        return Err("this chat has no folder".into());
    }
    Ok(p)
}

fn inputs(core: &Core, st: &ContextState, t: &Target, home: &Path) -> Inputs {
    let (launch, transcript) = {
        let hub = core.hub.lock().unwrap();
        let launch = t.chat.and_then(|id| hub.chat(id)).map(|c| c.launch_info().clone());
        let transcript = t.session_id.as_deref().and_then(|s| hub.transcript_path(t.provider, s, None));
        (launch, transcript)
    };
    let launch = launch.map(|mut l| {
        for m in &mut l.mcp {
            if m.name == crate::device::mcp::SERVER_NAME {
                let (n, bytes) = crate::device::mcp::tools_size();
                m.tools = n;
                m.tokens = chatctx::schema_tokens(bytes);
            }
        }
        l
    });
    let facts = transcript
        .map(|p| {
            let mut scans = st.scans.lock().unwrap();
            if !scans.contains_key(&p) && scans.len() >= KEEP_SCANS {
                let oldest = scans.iter().min_by_key(|(_, (_, at))| *at).map(|(k, _)| k.clone());
                if let Some(k) = oldest {
                    scans.remove(&k);
                }
            }
            let e = scans.entry(p.clone()).or_insert_with(|| (TranscriptScan::new(&p, t.provider), Instant::now()));
            e.1 = Instant::now();
            e.0.update().clone()
        })
        .unwrap_or_default();
    let (plugins, user_mcp) = {
        let key = (t.provider, t.cwd.clone());
        let mut cache = st.config.lock().unwrap();
        match cache.get(&key).filter(|(at, ..)| at.elapsed() < CONFIG_TTL) {
            Some((_, p, m)) => (p.clone(), m.clone()),
            None => {
                let project = Some(Path::new(&t.cwd));
                let conns = prefs::connections::read(home, project);
                let conn = if t.provider == Provider::Claude { conns.claude } else { conns.codex };
                let m: Vec<UserMcp> = conn.mcp.into_iter().map(|s| UserMcp { name: s.name, scope: s.scope, file: s.file, disabled: s.disabled }).collect();
                let p = if t.provider == Provider::Claude { prefs::connections::enabled_plugins(home, project) } else { Vec::new() };
                cache.insert(key, (Instant::now(), p.clone(), m.clone()));
                (p, m)
            }
        }
    };
    Inputs { launch, facts, plugins, user_mcp }
}

fn overview_for(core: &Core, st: &ContextState, t: &Target) -> Res<(Overview, guard::Scope)> {
    let home = home()?;
    let cwd = cwd_of(t)?;
    let ov = chatctx::overview(t.provider, &cwd, &home, &inputs(core, st, t, &home));
    let mut scope = guard::Scope::new(&home, &cwd);
    scope.extra_read = chatctx::extra_reads(&ov);
    Ok((ov, scope))
}

/// What the chat starts with, for the panel.
#[tauri::command(async)]
pub fn chat_context(core: State<'_, Arc<Core>>, st: State<'_, ContextState>, target: Target) -> Res<Overview> {
    overview_for(&core, &st, &target).map(|r| r.0)
}

/// One file of the chat's context, for the preview and the editor (refused unless the allow-list has it).
#[tauri::command(async)]
pub fn chat_context_read(core: State<'_, Arc<Core>>, st: State<'_, ContextState>, target: Target, path: String) -> Res<guard::FileText> {
    let (_, scope) = overview_for(&core, &st, &target)?;
    guard::read(&scope, Path::new(&path)).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum SaveReply {
    Saved { stamp: guard::Stamp },
    /// It changed on disk since it was opened: nothing was written.
    Changed { stamp: Option<guard::Stamp> },
}

fn save_err(e: guard::SaveError) -> Res<SaveReply> {
    match e {
        guard::SaveError::Changed(stamp) => Ok(SaveReply::Changed { stamp }),
        e => Err(e.to_string()),
    }
}

/// Saves an edit (atomically; refused if the file changed since `stamp`, or isn't on the allow-list).
#[tauri::command(async)]
pub fn chat_context_save(target: Target, path: String, text: String, stamp: Option<guard::Stamp>) -> Res<SaveReply> {
    let scope = guard::Scope::new(&home()?, &cwd_of(&target)?);
    match guard::save(&scope, Path::new(&path), &text, stamp.as_ref()) {
        Ok(stamp) => Ok(SaveReply::Saved { stamp }),
        Err(e) => save_err(e),
    }
}

/// A new memory file, skill or instruction file; its path.
#[tauri::command(async)]
pub fn chat_context_create(target: Target, create: guard::Create) -> Res<String> {
    let scope = guard::Scope::new(&home()?, &cwd_of(&target)?);
    guard::create(&scope, &create).map(|p| p.display().to_string()).map_err(|e| match e {
        guard::SaveError::Changed(_) => "it already exists".to_string(),
        e => e.to_string(),
    })
}

/// Moves a file (a skill: its folder) to the Trash; what went.
#[tauri::command(async)]
pub fn chat_context_trash(target: Target, path: String) -> Res<String> {
    let home = home()?;
    let scope = guard::Scope::new(&home, &cwd_of(&target)?);
    let h = home.clone();
    guard::delete(&scope, Path::new(&path), move |p| trash(&h, p)).map(|p| p.display().to_string()).map_err(|e| e.to_string())
}

/// Shows the chat's folder, or a file of its context, in Finder.
#[tauri::command(async)]
pub fn chat_context_reveal(core: State<'_, Arc<Core>>, st: State<'_, ContextState>, target: Target, path: String) -> Res<()> {
    let p = PathBuf::from(&path);
    if p != Path::new(&target.cwd) {
        let (_, scope) = overview_for(&core, &st, &target)?;
        guard::check(&scope, &p, guard::Access::Read).map_err(|e| e.to_string())?;
    }
    if !p.exists() {
        return Err("it is gone (moved or deleted?)".into());
    }
    std::process::Command::new("/usr/bin/open").arg("-R").arg(&p).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// The person's own home folder (the account's, whatever `HOME` says).
fn account_home() -> Option<PathBuf> {
    // SAFETY: getpwuid returns a pointer into static storage or null; read right away on this thread.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_dir.is_null() {
            return None;
        }
        Some(PathBuf::from(std::ffi::CStr::from_ptr((*pw).pw_dir).to_string_lossy().into_owned()))
    }
}

/// To the Trash: Finder's (Put Back works) for the person's own files; with a throwaway `HOME` (the self-test), that
/// home's `.Trash`, so a test never fills the person's Trash.
fn trash(home: &Path, p: &Path) -> std::io::Result<()> {
    let own = account_home().is_some_and(|a| std::fs::canonicalize(&a).ok() == std::fs::canonicalize(home).ok());
    if !own {
        return guard::trash_into(home, p);
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSFileManager, NSString, NSURL};
        let url = NSURL::fileURLWithPath(&NSString::from_str(&p.to_string_lossy()));
        NSFileManager::defaultManager().trashItemAtURL_resultingItemURL_error(&url, None).map_err(|e| std::io::Error::other(e.localizedDescription().to_string()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        guard::trash_into(home, p)
    }
}
