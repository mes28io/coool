//! History (APP_SPEC "History"): every past Claude Code and Codex session on this Mac, wherever it ran, found by
//! its words and opened in coool's session view.
//!
//! - The index (`coool_core::history`) lives in coool's data folder (`<data>/coool/history`; a self-test keeps its
//!   own in its folder) and is kept current by one background thread at utility priority: a first pass over every
//!   transcript (newest first, in small steps), then only what changed, looked for every minute and whenever the
//!   page opens. The CLIs' transcripts are only read, in place: nothing is copied or written under ~/.claude or
//!   ~/.codex. Settings > Storage clears the index (`storage_clear("history")`).
//! - Opening a session pins its transcript into the Hub (`Hub::set_pinned`), so it is listed like a recent one:
//!   the session view, Changes, Context and the ended-session box that resumes it as a coool chat all work as for
//!   any session. Pins are remembered (the newest [`MAX_PINS`]) so a tab left open finds its session after a restart.
//! - A long session's timeline holds only its newest entries; `history_earlier` reads the rest from the transcript.

use crate::Core;
use coool_core::history::{History, Options, Page, Query, Status};
use coool_core::hub::Hub;
use coool_core::model::{Activity, ActivityKind, Provider};
use coool_core::watch::Waker;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;

/// Sessions opened from History that stay listed (newest kept).
const MAX_PINS: usize = 40;
/// One step of index work holds the lock this long at most (a search waits at most this).
const STEP: Duration = Duration::from_millis(25);
/// The words held for searching are freed after this long without a search.
const TEXTS_IDLE: Duration = Duration::from_secs(600);

#[derive(Clone, Serialize, Deserialize, PartialEq)]
struct Pin {
    provider: Provider,
    id: String,
    path: PathBuf,
}

pub struct HistoryState {
    index: Mutex<History>,
    waker: Arc<Waker>,
    pins: Mutex<Vec<Pin>>,
    pins_file: Option<PathBuf>,
    /// The last whole transcript read for `history_earlier`: (path, length, mtime, entries).
    earlier: Mutex<Option<(PathBuf, u64, std::time::SystemTime, Arc<Vec<Activity>>)>>,
}

impl HistoryState {
    /// `dir`: the index's folder; `own`: coool's list of its own sessions.
    pub fn new(dir: Option<PathBuf>, own: Option<PathBuf>) -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let mut opts = Options::for_home(&home, dir.clone());
        opts.own_sessions = own;
        let pins_file = dir.as_ref().map(|d| d.join("pins.json"));
        let pins: Vec<Pin> = pins_file.as_ref().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { index: Mutex::new(History::open(opts)), waker: Waker::new(), pins: Mutex::new(pins), pins_file, earlier: Mutex::new(None) }
    }

    /// The default folder: `<data>/coool/history`.
    pub fn default_dir() -> Option<PathBuf> {
        dirs::data_dir().map(|d| d.join("coool").join("history"))
    }

    pub fn dir(&self) -> Option<PathBuf> {
        self.index.lock().unwrap().dir().map(Path::to_path_buf)
    }

    /// Pins (still on disk) for the Hub, at launch and after each change.
    pub fn pins_for_hub(&self) -> Vec<(Provider, PathBuf)> {
        self.pins.lock().unwrap().iter().filter(|p| p.path.exists()).map(|p| (p.provider, p.path.clone())).collect()
    }

    fn pin(&self, p: Pin) {
        let mut pins = self.pins.lock().unwrap();
        pins.retain(|x| x.path != p.path);
        pins.insert(0, p);
        pins.truncate(MAX_PINS);
        if let (Some(f), Ok(b)) = (&self.pins_file, serde_json::to_vec(&*pins)) {
            if let Some(d) = f.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let _ = std::fs::write(f, b);
        }
    }

    /// Settings > Storage: forget the index (and the words file); it is rebuilt from the transcripts.
    pub fn clear(&self) {
        self.index.lock().unwrap().clear();
        self.waker.kick();
    }

    /// Writes what the index learned (at quit).
    pub fn save(&self) {
        self.index.lock().unwrap().save_if(Duration::ZERO, true);
    }

    /// Bytes on disk, for Settings > Storage.
    pub fn status(&self) -> Status {
        self.index.lock().unwrap().status()
    }

    /// The index thread: waits a little after launch (so the first paint is never slowed), then works in steps.
    pub fn spawn(self: &Arc<Self>) {
        let s = self.clone();
        let _ = std::thread::Builder::new().name("coool-history".into()).spawn(move || {
            #[cfg(target_os = "macos")]
            unsafe {
                libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0);
            }
            s.waker.wait(Duration::from_secs(6));
            loop {
                let more = {
                    let mut h = s.index.lock().unwrap();
                    let more = h.step(STEP);
                    h.save_if(Duration::from_secs(30), !more);
                    if h.texts_idle(TEXTS_IDLE) {
                        h.release_texts();
                    }
                    more
                };
                if more {
                    // Let searches in between steps.
                    std::thread::sleep(Duration::from_millis(3));
                } else {
                    s.waker.wait(Duration::from_secs(60));
                    s.index.lock().unwrap().request_scan();
                }
            }
        });
    }
}

fn names(core: &Core) -> impl Fn(Provider, &str) -> Option<String> + '_ {
    move |p, id| core.titles.lock().ok().and_then(|t| t.shown(p, id).map(str::to_string))
}

/// One page of past sessions (the History page, and the New session sheet's recent sessions per folder).
#[tauri::command(async)]
pub fn history_query(core: State<'_, Arc<Core>>, history: State<'_, Arc<HistoryState>>, query: Query) -> Page {
    let names = names(&core);
    let owns = core.selftest.as_ref().map(|t| move |c: &str| t.owns(c));
    let scope: Option<&dyn Fn(&str) -> bool> = owns.as_ref().map(|f| f as &dyn Fn(&str) -> bool);
    history.index.lock().unwrap().query(&query, &names, scope)
}

/// How far the index is; also starts a look for new sessions.
#[tauri::command(async)]
pub fn history_status(history: State<'_, Arc<HistoryState>>) -> Status {
    history.index.lock().unwrap().request_scan();
    history.waker.kick();
    history.status()
}

/// Lists a past session in the app (pinned into the Hub) and returns its key once the UI has been sent it.
#[tauri::command(async)]
pub fn history_open(core: State<'_, Arc<Core>>, history: State<'_, Arc<HistoryState>>, provider: Provider, id: String) -> Result<String, String> {
    let key = format!("{}:{id}", provider.label());
    let path = history.index.lock().unwrap().path_of(provider, &id).ok_or("That session's transcript isn't there any more.")?;
    if let Some(t) = &core.selftest {
        // A self-test opens only what is under its own folder.
        let cwd = history.index.lock().unwrap().cwd_of(provider, &id).unwrap_or_default();
        if !t.owns(&cwd) {
            return Err("not this test's session".into());
        }
    }
    history.pin(Pin { provider, id, path });
    core.hub.lock().unwrap().set_pinned(&history.pins_for_hub());
    core.kick();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if core.published.lock().unwrap().order.iter().any(|k| *k == key) {
            return Ok(key);
        }
        std::thread::sleep(Duration::from_millis(25));
        core.kick();
    }
    Err("The session didn't open in time. Try again in a moment.".into())
}

#[derive(Deserialize)]
pub struct FirstEntry {
    ts: String,
    kind: ActivityKind,
    text: String,
}

#[derive(Serialize)]
pub struct Earlier {
    /// Oldest first; they come right before entry `start + entries.len()`.
    entries: Vec<Activity>,
    /// Index of the first returned entry in the whole history (0: nothing earlier is left).
    start: usize,
    /// Entries in the whole history.
    total: usize,
}

/// Where the shown timeline starts in the whole history: the entry matching its first one nearest `guess`.
fn anchor(full: &[Activity], guess: usize, first: Option<&FirstEntry>) -> usize {
    let Some(f) = first else { return guess };
    let hit = |i: usize| full.get(i).is_some_and(|a| a.ts == f.ts && a.kind == f.kind && a.text == f.text);
    (0..=64).flat_map(|d| [guess.checked_add(d), guess.checked_sub(d)]).flatten().find(|&i| hit(i)).unwrap_or(guess)
}

/// The part of a session's history before what its timeline holds (`keep` entries, the first of them `first`), or
/// before entry `before` of the whole history; `limit` entries at most.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn history_earlier(core: State<'_, Arc<Core>>, history: State<'_, Arc<HistoryState>>, provider: Provider, session_id: String, keep: usize, before: Option<usize>, first: Option<FirstEntry>, limit: usize) -> Result<Earlier, String> {
    let path = core.hub.lock().unwrap().transcript_path(provider, &session_id, None).or_else(|| history.index.lock().unwrap().path_of(provider, &session_id)).ok_or("no transcript for that session")?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let stamp = (meta.len(), meta.modified().unwrap_or(std::time::UNIX_EPOCH));
    let cached = history.earlier.lock().unwrap().as_ref().filter(|(p, l, m, _)| *p == path && (*l, *m) == stamp).map(|c| c.3.clone());
    let full = match cached {
        Some(f) => f,
        None => {
            let f = Arc::new(Hub::full_activity(provider, &path).map_err(|e| e.to_string())?);
            *history.earlier.lock().unwrap() = Some((path, stamp.0, stamp.1, f.clone()));
            f
        }
    };
    let end = match before {
        Some(b) => b.min(full.len()),
        None => anchor(&full, full.len().saturating_sub(keep), first.as_ref()),
    };
    let start = end.saturating_sub(limit.clamp(1, 2000));
    Ok(Earlier { entries: full[start..end].to_vec(), start, total: full.len() })
}

#[derive(Serialize)]
pub struct Folder {
    exists: bool,
    /// Existing folders of the same name other sessions ran in: where a moved project may be now.
    moved_to: Vec<String>,
}

/// Whether a session's folder is still there, and where it may have moved.
#[tauri::command(async)]
pub fn history_folder(history: State<'_, Arc<HistoryState>>, cwd: String) -> Folder {
    let exists = Path::new(&cwd).is_dir();
    let name = Path::new(&cwd).file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let moved_to = if exists || name.is_empty() { Vec::new() } else { history.index.lock().unwrap().folders_named(&name, &cwd) };
    Folder { exists, moved_to }
}

/// Makes a deleted session folder again (empty), so the CLI can continue the session where it ran. Only a folder a
/// listed session ran in, and only when it is gone.
#[tauri::command(async)]
pub fn history_make_folder(history: State<'_, Arc<HistoryState>>, cwd: String) -> Result<(), String> {
    let p = Path::new(&cwd);
    if !p.is_absolute() || cwd.contains("/../") || p.exists() {
        return Err("That folder can't be made here.".into());
    }
    if !history.index.lock().unwrap().knows_folder(&cwd) {
        return Err("No session ran in that folder.".into());
    }
    std::fs::create_dir_all(p).map_err(|e| format!("Couldn't make {cwd}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(ts: &str, text: &str) -> Activity {
        Activity::line(ts.into(), ActivityKind::Tool, text)
    }

    #[test]
    fn anchor_finds_the_shown_start() {
        let full: Vec<Activity> = (0..500).map(|i| a(&format!("10:{:02}:{:02}", i / 60 % 60, i % 60), &format!("step {i}"))).collect();
        let first = |i: usize| FirstEntry { ts: full[i].ts.clone(), kind: full[i].kind, text: full[i].text.clone() };
        // Exactly where the guess says.
        assert_eq!(anchor(&full, 200, Some(&first(200))), 200);
        // The timeline grew (or shrank) a little since: found nearby.
        assert_eq!(anchor(&full, 200, Some(&first(203))), 203);
        assert_eq!(anchor(&full, 200, Some(&first(190))), 190);
        // Not found: the guess.
        let none = FirstEntry { ts: "x".into(), kind: ActivityKind::Tool, text: "nope".into() };
        assert_eq!(anchor(&full, 200, Some(&none)), 200);
        assert_eq!(anchor(&full, 200, None), 200);
    }
}
