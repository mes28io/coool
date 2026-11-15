//! Wake-ups for whatever calls [`crate::hub::Hub::refresh`] in a loop: as soon as
//! a transcript or registry file changes (FSEvents on macOS, inotify on Linux,
//! through `notify`), instead of only on a timer. Watching only; nothing under
//! the watched folders is ever written, and events for files coool never reads
//! (e.g. `~/.claude/sessions/*.key`) are ignored.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// File changes wake the waiter at most this often. The first change after a
/// quiet spell wakes it at once; the rest of a burst (a CLI appends several
/// lines at once, a rollout grows line by line) is collected into one more
/// wake-up this long after the previous one.
pub const COALESCE: Duration = Duration::from_millis(30);

#[derive(Default)]
struct State {
    kicked: bool,
    files: bool,
    /// When [`Waker::wait`] last returned [`Wake::Files`].
    last_files: Option<Instant>,
}

/// Why [`Waker::wait`] returned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wake {
    /// [`Waker::kick`]: something coool did (a chat started, a PTY exited).
    Kick,
    /// A watched file changed.
    Files,
    /// The timeout passed (time-based changes: process exits, sessions ageing out).
    Timer,
}

#[derive(Default)]
pub struct Waker {
    st: Mutex<State>,
    cv: Condvar,
}

impl Waker {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    /// Wake the waiter now.
    pub fn kick(&self) {
        self.st.lock().unwrap().kicked = true;
        self.cv.notify_one();
    }

    fn files_changed(&self) {
        let mut st = self.st.lock().unwrap();
        if !st.files {
            st.files = true;
            self.cv.notify_one();
        }
    }

    /// Blocks until kicked, a watched file changed (see [`COALESCE`]), or `timeout`.
    pub fn wait(&self, timeout: Duration) -> Wake {
        let st = self.st.lock().unwrap();
        let (mut st, _) = self.cv.wait_timeout_while(st, timeout, |s| !s.kicked && !s.files).unwrap();
        let why = if st.kicked {
            Wake::Kick
        } else if st.files {
            Wake::Files
        } else {
            Wake::Timer
        };
        if why == Wake::Files {
            // Right after the previous one: let more of the burst land (a kick cuts it short).
            if let Some(until) = st.last_files.map(|t| t + COALESCE) {
                loop {
                    let now = Instant::now();
                    if st.kicked || now >= until {
                        break;
                    }
                    st = self.cv.wait_timeout(st, until - now).unwrap().0;
                }
            }
            st.last_files = Some(Instant::now());
        }
        st.kicked = false;
        st.files = false;
        why
    }
}

/// One folder to watch.
pub struct Root {
    pub path: PathBuf,
    /// Also everything below it.
    pub recursive: bool,
    /// Only this file directly in it counts (e.g. `~/.codex/session_index.jsonl`,
    /// not `~/.codex/auth.json`).
    pub only: Option<&'static str>,
}

impl Root {
    pub fn new(path: PathBuf, recursive: bool) -> Self {
        Self { path, recursive, only: None }
    }
}

/// Files whose change can change what a refresh returns.
fn relevant(p: &Path, only: &[(PathBuf, &'static str)]) -> bool {
    if !matches!(p.extension().and_then(|e| e.to_str()), Some("jsonl" | "json")) {
        return false;
    }
    let (dir, name) = (p.parent(), p.file_name().and_then(|n| n.to_str()));
    only.iter().all(|(d, n)| dir != Some(d.as_path()) || name == Some(*n))
}

/// Keeps the watches alive; dropping it stops them.
pub struct Watch {
    waker: Arc<Waker>,
    watcher: Option<RecommendedWatcher>,
    roots: Vec<(PathBuf, RecursiveMode)>,
    /// Roots being watched (a missing folder is retried by [`Watch::ensure`]).
    active: Vec<bool>,
    last_try: Option<Instant>,
}

impl Watch {
    /// Watch `roots` (folders; missing ones are picked up once they exist).
    pub fn new(waker: Arc<Waker>, roots: Vec<Root>) -> Self {
        let w = waker.clone();
        let only: Vec<(PathBuf, &'static str)> = roots.iter().filter_map(|r| Some((r.path.clone(), r.only?))).collect();
        let watcher = notify::recommended_watcher(move |r: notify::Result<Event>| {
            let Ok(ev) = r else { return };
            if matches!(ev.kind, EventKind::Access(_)) {
                return;
            }
            // An event without paths (e.g. "rescan": the OS dropped events) could be anything.
            if ev.paths.is_empty() || ev.paths.iter().any(|p| relevant(p, &only)) {
                w.files_changed();
            }
        })
        .ok();
        let roots: Vec<_> = roots.into_iter().map(|r| (r.path, if r.recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive })).collect();
        let active = vec![false; roots.len()];
        let mut me = Self { waker, watcher, roots, active, last_try: None };
        me.ensure();
        me
    }

    /// The folders the Claude Code and Codex adapters read.
    pub fn sources(waker: Arc<Waker>) -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        Self::new(
            waker,
            vec![
                Root::new(home.join(".claude").join("projects"), true),
                Root::new(home.join(".claude").join("sessions"), false),
                Root::new(home.join(".codex").join("sessions"), true),
                // Thread titles.
                Root { path: home.join(".codex"), recursive: false, only: Some("session_index.jsonl") },
            ],
        )
    }

    /// Whether every root is being watched (false: no watcher, or a folder doesn't exist yet).
    pub fn complete(&self) -> bool {
        self.watcher.is_some() && self.active.iter().all(|a| *a)
    }

    /// Start watching roots that didn't exist before (at most every few seconds).
    pub fn ensure(&mut self) {
        if self.complete() || self.last_try.is_some_and(|t| t.elapsed() < Duration::from_secs(5)) {
            return;
        }
        self.last_try = Some(Instant::now());
        let Some(w) = self.watcher.as_mut() else { return };
        let mut added = false;
        for (i, (p, mode)) in self.roots.iter().enumerate() {
            if !self.active[i] && p.is_dir() && w.watch(p, *mode).is_ok() {
                self.active[i] = true;
                added = true;
            }
        }
        if added {
            // Whatever appeared before the watch started.
            self.waker.files_changed();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn kick_and_timeout() {
        let w = Waker::new();
        assert_eq!(w.wait(Duration::from_millis(10)), Wake::Timer);
        w.kick();
        assert_eq!(w.wait(Duration::from_secs(5)), Wake::Kick);
    }

    #[test]
    fn a_write_wakes_within_a_moment_and_irrelevant_files_do_not() {
        let d = std::env::temp_dir().join(format!("coool-watch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("proj")).unwrap();
        // Canonical: FSEvents reports /private/var/... for /var/...
        let d = d.canonicalize().unwrap();
        let w = Waker::new();
        let watch = Watch::new(w.clone(), vec![Root::new(d.join("proj"), true), Root { path: d.clone(), recursive: false, only: Some("index.jsonl") }, Root::new(d.join("missing"), false)]);
        assert!(!watch.complete(), "a missing folder is retried later");
        // Let the stream start (and drain the initial wake-up).
        std::thread::sleep(Duration::from_millis(300));
        let _ = w.wait(Duration::from_millis(1));
        fs::write(d.join("proj/other.key"), "x").unwrap();
        fs::write(d.join("auth.json"), "x").unwrap();
        assert_eq!(w.wait(Duration::from_millis(400)), Wake::Timer, "not a file coool reads");
        fs::write(d.join("index.jsonl"), "{}\n").unwrap();
        assert_eq!(w.wait(Duration::from_secs(5)), Wake::Files, "the one file read at the top");
        std::thread::sleep(COALESCE);
        let t = Instant::now();
        fs::write(d.join("proj/s.jsonl"), "{}\n").unwrap();
        assert_eq!(w.wait(Duration::from_secs(5)), Wake::Files);
        assert!(t.elapsed() < Duration::from_millis(1000), "{:?}", t.elapsed());
        // More writes right after: one more wake-up, no sooner than COALESCE after the last.
        let t = Instant::now();
        for i in 0..5 {
            fs::write(d.join(format!("proj/s{i}.jsonl")), "{}\n").unwrap();
        }
        assert_eq!(w.wait(Duration::from_secs(5)), Wake::Files);
        assert!(t.elapsed() >= COALESCE.saturating_sub(Duration::from_millis(5)), "{:?}", t.elapsed());
        drop(watch);
        let _ = fs::remove_dir_all(&d);
    }
}
