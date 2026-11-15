//! Which session started which: a programmatic run (`claude -p`, `codex exec`)
//! launched from inside another session (a background shell, a tool call) is a
//! *child run* of that session.
//!
//! - Live: walk the run's parent pids up to the first pid that is itself a
//!   listed session (a Claude registry pid or a coool chat). Cached per
//!   (pid, start time), so a reused pid never inherits an old answer.
//! - Durable: a run whose folder is an agent scratch folder
//!   (`/tmp/claude-<uid>/<project>/<session id>/...`) names its owner in the path
//!   ([`crate::project::scratch_session`]). Links found live are also remembered
//!   in coool's own-sessions file, so an ended child stays attached.

use std::collections::HashMap;

/// Hops walked at most (shell, sh -c, zsh, ... rarely more than a handful).
const MAX_HOPS: usize = 32;

/// The first ancestor of `pid` (not `pid` itself) for which `is_session` holds.
/// `ppid` looks up a parent pid; the walk stops at pid 1 or an unreadable pid.
pub(crate) fn session_ancestor(pid: u32, ppid: impl Fn(u32) -> Option<u32>, is_session: impl Fn(u32) -> bool) -> Option<u32> {
    let mut cur = pid;
    for _ in 0..MAX_HOPS {
        let p = ppid(cur)?;
        if p <= 1 || p == cur {
            return None;
        }
        if is_session(p) {
            return Some(p);
        }
        cur = p;
    }
    None
}

/// Per-pid cache of [`session_ancestor`] answers, keyed with the process start
/// time so a reused pid is looked up again.
#[derive(Default)]
pub(crate) struct AncestorCache {
    map: HashMap<(u32, u64), Option<u32>>,
}

impl AncestorCache {
    pub(crate) fn get(&mut self, pid: u32, started: u64, walk: impl FnOnce() -> Option<u32>) -> Option<u32> {
        *self.map.entry((pid, started)).or_insert_with(walk)
    }
    /// Drops entries for pids that are no longer of interest.
    pub(crate) fn retain(&mut self, keep: impl Fn(u32) -> bool) {
        self.map.retain(|(p, _), _| keep(*p));
    }
}

/// What a parent shows for its background work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Background {
    /// Nothing running in the background (or the session itself is busy / ended).
    None,
    /// Waiting for the person's next prompt while child runs or background
    /// shells still work: shown as working ("Working in background").
    Working,
}

/// Derived state of a session that is otherwise idle. `live_children`: child
/// runs still alive; `shells`: the CLI reports background tasks running.
pub fn background(status: crate::model::Status, live_children: u32, shells: bool) -> Background {
    if status == crate::model::Status::Idle && (live_children > 0 || shells) { Background::Working } else { Background::None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Status;

    #[test]
    fn walks_up_to_the_first_session() {
        // 68620 claude -> 68614 sh -> 68610 zsh -> 33757 claude (session) -> 1000 terminal -> 1
        let tree: HashMap<u32, u32> = [(68620, 68614), (68614, 68610), (68610, 33757), (33757, 1000), (1000, 1)].into();
        let ppid = |p: u32| tree.get(&p).copied();
        let sessions = [33757u32, 68620];
        let is = |p: u32| sessions.contains(&p);
        assert_eq!(session_ancestor(68620, ppid, is), Some(33757), "not itself, the nearest session above");
        assert_eq!(session_ancestor(33757, ppid, is), None, "a top-level session has no parent session");
        assert_eq!(session_ancestor(4242, ppid, is), None, "unknown pid");
        // Nested: a run inside a run belongs to the nearest one.
        let tree2: HashMap<u32, u32> = [(9, 8), (8, 7), (7, 6), (6, 5)].into();
        assert_eq!(session_ancestor(9, |p| tree2.get(&p).copied(), |p| p == 7 || p == 5), Some(7));
        // A cycle or a self-parent never loops.
        assert_eq!(session_ancestor(3, |p| Some(if p == 3 { 4 } else { 3 }), |_| false), None);
        assert_eq!(session_ancestor(3, |_| Some(3), |_| true), None);
    }

    #[test]
    fn cache_is_per_process_instance() {
        let mut c = AncestorCache::default();
        let mut calls = 0;
        assert_eq!(c.get(10, 111, || { calls += 1; Some(5) }), Some(5));
        assert_eq!(c.get(10, 111, || { calls += 1; Some(6) }), Some(5));
        assert_eq!(calls, 1);
        // Same pid, another start time: a different process.
        assert_eq!(c.get(10, 222, || None), None);
        c.retain(|p| p != 10);
        assert_eq!(c.get(10, 111, || Some(7)), Some(7));
    }

    #[test]
    fn background_status() {
        assert_eq!(background(Status::Idle, 2, false), Background::Working);
        assert_eq!(background(Status::Idle, 0, true), Background::Working);
        assert_eq!(background(Status::Idle, 0, false), Background::None);
        assert_eq!(background(Status::Busy, 2, true), Background::None, "busy is already working");
        assert_eq!(background(Status::Ended, 1, true), Background::None);
    }

    #[test]
    fn real_process_tree_resolves() {
        // This test process's parent chain is readable: its parent is not a "session".
        let me = std::process::id();
        let parent = crate::util::parent_pid(me);
        if let Some(pp) = parent {
            assert_eq!(session_ancestor(me, crate::util::parent_pid, |p| p == pp), Some(pp));
        }
    }
}
