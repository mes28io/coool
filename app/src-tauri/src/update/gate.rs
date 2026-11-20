//! The launch gate: chats and terminal sessions wait for the updater's launch step, bounded. The gate opens when the
//! step ends (however it ends: its guard opens it on drop, a panic included) or `max` after it was made, whichever
//! is first, so it can never hold the app. A CLI being updated also holds the starts of its own chats (bounded too).

use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

pub struct Gate {
    m: Mutex<Inner>,
    cv: Condvar,
    deadline: Instant,
}

struct Inner {
    open: bool,
    /// Per CLI (Claude Code, Codex): an update is running.
    busy: [bool; 2],
}

impl Gate {
    pub fn new(max: Duration) -> Gate {
        Gate { m: Mutex::new(Inner { open: false, busy: [false; 2] }), cv: Condvar::new(), deadline: Instant::now() + max }
    }

    pub fn open(&self) {
        self.m.lock().unwrap().open = true;
        self.cv.notify_all();
    }

    pub fn is_open(&self) -> bool {
        self.m.lock().unwrap().open || Instant::now() >= self.deadline
    }

    pub fn set_busy(&self, cli: usize, on: bool) {
        self.m.lock().unwrap().busy[cli] = on;
        self.cv.notify_all();
    }

    /// Waits until the gate is open, then (with `cli`) until that CLI isn't being updated, for at most `busy_max`.
    /// Returns how long it waited.
    pub fn wait(&self, cli: Option<usize>, busy_max: Duration) -> Duration {
        let t0 = Instant::now();
        let mut g = self.m.lock().unwrap();
        while !g.open {
            let now = Instant::now();
            if now >= self.deadline {
                break;
            }
            g = self.cv.wait_timeout(g, self.deadline - now).unwrap().0;
        }
        if let Some(i) = cli {
            let until = Instant::now() + busy_max;
            while g.busy[i] {
                let now = Instant::now();
                if now >= until {
                    break;
                }
                g = self.cv.wait_timeout(g, until - now).unwrap().0;
            }
        }
        t0.elapsed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn chats_start_when_the_step_ends() {
        let g = Arc::new(Gate::new(Duration::from_secs(30)));
        let g2 = g.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            g2.open();
        });
        let w = g.wait(Some(0), Duration::from_secs(30));
        assert!(w >= Duration::from_millis(100) && w < Duration::from_secs(5), "{w:?}");
        assert!(g.is_open());
    }

    #[test]
    fn chats_start_when_the_step_times_out() {
        // The launch step never ends (hung network, a bug): the gate opens by itself.
        let g = Gate::new(Duration::from_millis(250));
        assert!(!g.is_open());
        let w = g.wait(None, Duration::from_secs(30));
        assert!(w >= Duration::from_millis(200) && w < Duration::from_secs(3), "{w:?}");
        assert!(g.is_open());
    }

    #[test]
    fn chats_start_when_the_step_fails() {
        // The step's guard opens the gate when it is dropped, a panic included.
        let g = Arc::new(Gate::new(Duration::from_secs(30)));
        let g2 = g.clone();
        let _ = std::thread::spawn(move || {
            struct Open(Arc<Gate>);
            impl Drop for Open {
                fn drop(&mut self) {
                    self.0.open();
                }
            }
            let _o = Open(g2);
            panic!("the update check failed");
        })
        .join();
        let w = g.wait(Some(1), Duration::from_secs(30));
        assert!(w < Duration::from_secs(1), "{w:?}");
    }

    #[test]
    fn a_cli_update_holds_only_its_own_chats_and_only_so_long() {
        let g = Arc::new(Gate::new(Duration::ZERO));
        g.set_busy(1, true);
        // Claude Code's chats don't wait for Codex.
        assert!(g.wait(Some(0), Duration::from_secs(30)) < Duration::from_millis(100));
        // Codex's wait until its update ends...
        let g2 = g.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            g2.set_busy(1, false);
        });
        let w = g.wait(Some(1), Duration::from_secs(30));
        assert!(w >= Duration::from_millis(100) && w < Duration::from_secs(5), "{w:?}");
        // ...or at most `busy_max`.
        g.set_busy(1, true);
        let w = g.wait(Some(1), Duration::from_millis(200));
        assert!(w >= Duration::from_millis(150) && w < Duration::from_secs(3), "{w:?}");
    }
}
