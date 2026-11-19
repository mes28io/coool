//! Settings > General > "Prevent sleep while agents are working".
//!
//! While the setting is on and at least one chat or coool-launched terminal session is working (a turn is running),
//! coool holds one macOS power assertion, `PreventUserIdleSystemSleep` (what `caffeinate -i` takes): the Mac does not
//! idle-sleep, the display still may. It is released as soon as nothing is working, or the setting goes off, or coool
//! quits (the OS drops a process's assertions when it exits, even on a crash). A closed lid still sleeps the Mac
//! (except in closed-display mode: on power with an external display): the kernel doesn't look at assertions when
//! the lid closes.
//!
//! [`Keeper::update`] runs on every refresh (about once a second) with the number of working agents; it takes or
//! releases the assertion only on a change, so it never stacks.
//!
//! "Keep working with the lid closed" (lid/) works with it through [`Keeper::set_lid`]: in closed-display mode it
//! needs this same assertion (taken then even with this setting off), and while its helper holds SleepDisabled, which
//! stops idle sleep too, this assertion steps aside ("covered") so the Mac is never held twice.

use serde::Serialize;

/// Takes and releases the actual assertion (IOKit on macOS; a fake in tests).
pub trait Assertor: Send {
    /// The assertion's id, or None when the OS refused.
    fn take(&mut self, reason: &str) -> Option<u32>;
    fn release(&mut self, id: u32);
}

pub struct Keeper {
    a: Box<dyn Assertor>,
    enabled: bool,
    working: usize,
    held: Option<u32>,
    /// The OS refused the last take (shown in Settings).
    failed: bool,
    /// The lid hold wants the assertion (closed-display mode).
    lid_assert: bool,
    /// The lid hold's SleepDisabled covers idle sleep: no assertion needed.
    covered: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct PowerStatus {
    pub enabled: bool,
    /// The assertion is held right now.
    pub held: bool,
    /// Chats and terminal sessions working right now.
    pub working: usize,
    pub failed: bool,
    /// The lid hold (SleepDisabled through its helper) is keeping the Mac awake instead.
    pub covered: bool,
}

impl Keeper {
    pub fn new(a: Box<dyn Assertor>, enabled: bool) -> Self {
        Keeper { a, enabled, working: 0, held: None, failed: false, lid_assert: false, covered: false }
    }

    pub fn set_enabled(&mut self, on: bool) {
        self.enabled = on;
        self.sync();
    }

    /// The number of agents working now (called on every refresh).
    pub fn update(&mut self, working: usize) {
        if working == self.working && (self.held.is_some() == self.want() || self.failed) {
            return;
        }
        self.working = working;
        self.sync();
    }

    /// What the lid hold needs (see the module doc); applied at once on a change.
    pub fn set_lid(&mut self, assert: bool, covered: bool) {
        if (assert, covered) == (self.lid_assert, self.covered) {
            return;
        }
        self.lid_assert = assert;
        self.covered = covered;
        self.sync();
    }

    fn want(&self) -> bool {
        (self.enabled || self.lid_assert) && self.working > 0 && !self.covered
    }

    fn sync(&mut self) {
        match (self.want(), self.held) {
            (true, None) => {
                let why = if self.working == 1 { "An agent is working in coool".to_string() } else { format!("{} agents are working in coool", self.working) };
                self.held = self.a.take(&why);
                self.failed = self.held.is_none();
            }
            (false, Some(id)) => {
                self.a.release(id);
                self.held = None;
                self.failed = false;
            }
            (false, None) => self.failed = false,
            (true, Some(_)) => {}
        }
    }

    pub fn status(&self) -> PowerStatus {
        PowerStatus { enabled: self.enabled, held: self.held.is_some(), working: self.working, failed: self.failed, covered: self.covered && self.working > 0 }
    }
}

impl Drop for Keeper {
    fn drop(&mut self) {
        if let Some(id) = self.held.take() {
            self.a.release(id);
        }
    }
}

/// The real assertion on macOS; elsewhere nothing (take says refused).
pub fn system() -> Box<dyn Assertor> {
    Box::new(sys::Iokit)
}

#[cfg(target_os = "macos")]
mod sys {
    use std::ffi::{CString, c_char, c_void};

    type CFStringRef = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(alloc: *const c_void, s: *const c_char, encoding: u32) -> CFStringRef;
        fn CFRelease(cf: *const c_void);
    }
    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPMAssertionCreateWithName(kind: CFStringRef, level: u32, name: CFStringRef, id: *mut u32) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }
    const UTF8: u32 = 0x0800_0100;
    const LEVEL_ON: u32 = 255;

    fn cf(s: &str) -> Option<CFStringRef> {
        let c = CString::new(s).ok()?;
        let r = unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), UTF8) };
        (!r.is_null()).then_some(r)
    }

    pub struct Iokit;
    impl super::Assertor for Iokit {
        fn take(&mut self, reason: &str) -> Option<u32> {
            let kind = cf("PreventUserIdleSystemSleep")?;
            let Some(name) = cf(reason) else {
                unsafe { CFRelease(kind) };
                return None;
            };
            let mut id = 0u32;
            let r = unsafe { IOPMAssertionCreateWithName(kind, LEVEL_ON, name, &mut id) };
            unsafe {
                CFRelease(kind);
                CFRelease(name);
            }
            (r == 0).then_some(id)
        }
        fn release(&mut self, id: u32) {
            unsafe { IOPMAssertionRelease(id) };
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod sys {
    pub struct Iokit;
    impl super::Assertor for Iokit {
        fn take(&mut self, _reason: &str) -> Option<u32> {
            None
        }
        fn release(&mut self, _id: u32) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Records takes and releases; refuses when `refuse` is set.
    #[derive(Clone, Default)]
    struct Fake {
        log: Arc<Mutex<Vec<String>>>,
        refuse: Arc<Mutex<bool>>,
        next: Arc<Mutex<u32>>,
    }
    impl Assertor for Fake {
        fn take(&mut self, reason: &str) -> Option<u32> {
            if *self.refuse.lock().unwrap() {
                self.log.lock().unwrap().push("refused".into());
                return None;
            }
            let mut n = self.next.lock().unwrap();
            *n += 1;
            self.log.lock().unwrap().push(format!("take {n} {reason}"));
            Some(*n)
        }
        fn release(&mut self, id: u32) {
            self.log.lock().unwrap().push(format!("release {id}"));
        }
    }
    fn log(f: &Fake) -> Vec<String> {
        std::mem::take(&mut *f.log.lock().unwrap())
    }

    #[test]
    fn held_only_while_working_and_enabled() {
        let f = Fake::default();
        let mut k = Keeper::new(Box::new(f.clone()), true);
        k.update(0);
        assert!(log(&f).is_empty(), "idle: nothing taken");
        k.update(1);
        assert_eq!(log(&f), ["take 1 An agent is working in coool"]);
        assert!(k.status().held);
        // More agents, or the same count again, never stack a second assertion.
        k.update(3);
        k.update(3);
        k.update(1);
        assert!(log(&f).is_empty());
        k.update(0);
        assert_eq!(log(&f), ["release 1"]);
        assert!(!k.status().held);
    }

    #[test]
    fn the_setting_takes_and_releases_at_once() {
        let f = Fake::default();
        let mut k = Keeper::new(Box::new(f.clone()), false);
        k.update(2);
        assert!(log(&f).is_empty(), "off: never taken");
        k.set_enabled(true);
        assert_eq!(log(&f), ["take 1 2 agents are working in coool"]);
        k.set_enabled(false);
        assert_eq!(log(&f), ["release 1"]);
        assert_eq!(k.status(), PowerStatus { enabled: false, held: false, working: 2, failed: false, covered: false });
    }

    #[test]
    fn the_lid_hold_borrows_or_covers_the_assertion() {
        let f = Fake::default();
        let mut k = Keeper::new(Box::new(f.clone()), false);
        k.update(1);
        assert!(log(&f).is_empty());
        // Closed-display mode: the lid hold needs the assertion even with keep-awake off.
        k.set_lid(true, false);
        assert_eq!(log(&f), ["take 1 An agent is working in coool"]);
        // Its helper took over (SleepDisabled): the assertion steps aside, so nothing is held twice.
        k.set_lid(false, true);
        assert_eq!(log(&f), ["release 1"]);
        k.set_enabled(true);
        assert!(log(&f).is_empty(), "keep-awake on, but covered");
        assert!(k.status().covered);
        // The helper let go (a limit): keep-awake's own assertion comes back at once.
        k.set_lid(false, false);
        assert_eq!(log(&f), ["take 2 An agent is working in coool"]);
        k.update(0);
        assert_eq!(log(&f), ["release 2"]);
    }

    #[test]
    fn released_on_drop() {
        let f = Fake::default();
        {
            let mut k = Keeper::new(Box::new(f.clone()), true);
            k.update(1);
        }
        assert_eq!(log(&f), ["take 1 An agent is working in coool", "release 1"]);
    }

    #[test]
    fn a_refusal_is_reported_and_not_retried_every_tick() {
        let f = Fake::default();
        *f.refuse.lock().unwrap() = true;
        let mut k = Keeper::new(Box::new(f.clone()), true);
        k.update(1);
        assert!(k.status().failed);
        k.update(1);
        assert_eq!(log(&f), ["refused"], "one try per change");
        // Idle clears it; the next working agent tries again.
        k.update(0);
        *f.refuse.lock().unwrap() = false;
        k.update(1);
        assert_eq!(log(&f), ["take 1 An agent is working in coool"]);
        assert!(!k.status().failed);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_real_assertion_can_be_taken_and_released() {
        let mut a = system();
        let id = a.take("coool unit test assertion").expect("IOKit refused the assertion");
        let listed = || {
            let out = std::process::Command::new("pmset").args(["-g", "assertions"]).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
            out.contains("coool unit test assertion")
        };
        assert!(listed(), "pmset doesn't list the assertion");
        a.release(id);
        assert!(!listed(), "still listed after release");
    }
}
