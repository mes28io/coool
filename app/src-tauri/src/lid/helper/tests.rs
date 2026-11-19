//! The real helper binary (embedded by build.rs) in `--dry-run` mode: every check runs, the commands are printed
//! instead of run. Nothing here touches the Mac's power settings or needs root.

use super::*;
use crate::lid::Helper as _;
use std::sync::atomic::{AtomicUsize, Ordering};

/// A short folder of its own (a socket path must stay under 104 bytes), removed on drop.
fn tmp() -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let d = PathBuf::from(format!("/tmp/coool-lid-t{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    set_mode(&d, 0o700).unwrap();
    d
}

struct H {
    dir: PathBuf,
    child: Option<Child>,
}

impl H {
    fn bin(dir: &Path) -> PathBuf {
        let b = dir.join("h");
        if !b.exists() {
            std::fs::write(&b, BINARY).unwrap();
            set_mode(&b, 0o755).unwrap();
        }
        b
    }
    /// Runs the helper to completion with these arguments: (exit code, output).
    fn run(dir: &Path, args: &[&str]) -> (i32, String) {
        let o = Command::new(Self::bin(dir)).args(args).output().unwrap();
        (o.status.code().unwrap_or(-1), format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)))
    }
    fn start_in(dir: PathBuf, sensors: &str, prep: impl FnOnce(&Path)) -> Self {
        for d in ["run", "state"] {
            std::fs::create_dir_all(dir.join(d)).unwrap();
            set_mode(&dir.join(d), 0o700).unwrap();
        }
        std::fs::write(dir.join("sensors"), sensors).unwrap();
        prep(&dir);
        let out = std::fs::File::create(dir.join("out")).unwrap();
        let child = Command::new(Self::bin(&dir))
            .args(["--dry-run", "--uid", &uid().to_string(), "--socket"])
            .arg(dir.join("run/s"))
            .arg("--state")
            .arg(dir.join("state"))
            .arg("--sensors")
            .arg(dir.join("sensors"))
            .stdout(out)
            .spawn()
            .unwrap();
        let h = H { dir, child: Some(child) };
        h.wait_for("listening on");
        h
    }
    fn start(sensors: &str) -> Self {
        Self::start_in(tmp(), sensors, |_| {})
    }
    fn out(&self) -> String {
        std::fs::read_to_string(self.dir.join("out")).unwrap_or_default()
    }
    fn wait_for(&self, what: &str) {
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(12) {
            if self.out().contains(what) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("the helper never printed {what:?}; it printed:\n{}", self.out());
    }
    fn count(&self, what: &str) -> usize {
        self.out().matches(what).count()
    }
    fn conn(&self) -> UnixStream {
        let s = UnixStream::connect(self.dir.join("run/s")).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        s
    }
    fn sensors(&self, s: &str) {
        std::fs::write(self.dir.join("sensors"), s).unwrap();
    }
    fn exited(&mut self) -> bool {
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(5) {
            if let Some(Ok(Some(_))) = self.child.as_mut().map(|c| c.try_wait()) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }
}

impl Drop for H {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

const ON: &str = "would run: /usr/bin/pmset -a disablesleep 1";
const OFF: &str = "would run: /usr/bin/pmset -a disablesleep 0";
const PLUGGED: &str = "battery=80 ac=1 thermal=0 lid=open causes=1";

#[test]
fn built_and_embedded() {
    assert!(BINARY.len() > 10_000, "build.rs didn't build native/coool-lid-helper.m");
}

#[test]
fn hold_beat_release() {
    let h = H::start(PLUGGED);
    let mut c = h.conn();
    assert_eq!(request(&mut c, "STATUS").unwrap(), "v=1 held=0 sleepdisabled=0 lid=open battery=80 ac=1 thermal=0");
    assert_eq!(request(&mut c, "HOLD 30"), Ok(String::new()));
    h.wait_for(ON);
    assert_eq!(field(&request(&mut c, "STATUS").unwrap(), "held"), Some("1"));
    assert!(h.dir.join("state/held").exists(), "the marker");
    assert_eq!(request(&mut c, "BEAT"), Ok(String::new()));
    // A second connection can't take over or renew.
    let mut other = h.conn();
    assert_eq!(request(&mut other, "HOLD 30"), Err("busy".into()));
    assert_eq!(request(&mut other, "BEAT"), Err("not-holding".into()));
    assert_eq!(request(&mut other, "RELEASE"), Ok(String::new()), "a RELEASE from a non-holder is a no-op");
    assert_eq!(h.count(OFF), 0);
    assert_eq!(request(&mut c, "RELEASE"), Ok(String::new()));
    h.wait_for(OFF);
    assert!(!h.dir.join("state/held").exists());
    assert_eq!(field(&request(&mut c, "STATUS").unwrap(), "sleepdisabled"), Some("0"));
}

#[test]
fn the_connection_closing_lets_go_at_once() {
    let h = H::start(PLUGGED);
    let mut c = h.conn();
    request(&mut c, "HOLD 300").unwrap();
    h.wait_for(ON);
    drop(c);
    h.wait_for("normal sleep restored (coool went away)");
}

#[test]
fn a_killed_holder_is_let_go() {
    // A separate process holds (nc speaking the protocol), then is killed with SIGKILL, as a force-quit coool would be.
    let h = H::start(PLUGGED);
    let mut nc = Command::new("/usr/bin/nc").arg("-U").arg(h.dir.join("run/s")).stdin(Stdio::piped()).stdout(Stdio::null()).spawn().unwrap();
    nc.stdin.as_mut().unwrap().write_all(b"HOLD 300\n").unwrap();
    h.wait_for(ON);
    // SAFETY: kill on our own child's pid.
    unsafe { libc::kill(nc.id() as i32, libc::SIGKILL) };
    let _ = nc.wait();
    h.wait_for("normal sleep restored (coool went away)");
}

#[test]
fn no_heartbeat_lets_go() {
    let h = H::start(PLUGGED);
    let mut c = h.conn();
    request(&mut c, "HOLD 1").unwrap();
    h.wait_for(ON);
    // The connection stays open (a hung coool), but no BEAT comes.
    h.wait_for("normal sleep restored (no heartbeat from coool)");
    assert_eq!(request(&mut c, "BEAT"), Err("not-holding".into()));
}

#[test]
fn letting_go_with_the_lid_closed_sleeps_now() {
    let h = H::start("battery=80 ac=1 thermal=0 lid=closed causes=1");
    let mut c = h.conn();
    request(&mut c, "HOLD 30").unwrap();
    request(&mut c, "RELEASE").unwrap();
    h.wait_for("would run: /usr/bin/pmset sleepnow");
    // Closed-display mode (the lid doesn't sleep the Mac): no sleepnow.
    let h = H::start("battery=80 ac=1 thermal=0 lid=closed causes=0");
    let mut c = h.conn();
    request(&mut c, "HOLD 30").unwrap();
    request(&mut c, "RELEASE").unwrap();
    h.wait_for(OFF);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(h.count("sleepnow"), 0);
}

#[test]
fn its_own_limits_battery_floor_and_heat() {
    // Refused at the floor (10%) on battery, whatever coool's own threshold is.
    let h = H::start("battery=10 ac=0 thermal=0 lid=open");
    let mut c = h.conn();
    assert_eq!(request(&mut c, "HOLD 30"), Err("battery".into()));
    h.sensors("battery=10 ac=1 thermal=0 lid=open");
    assert_eq!(request(&mut c, "HOLD 30"), Ok(String::new()), "on power the level doesn't matter");
    // Mid-hold: hot -> let go at the next check (every 5 s).
    h.sensors("battery=10 ac=1 thermal=2 lid=open");
    h.wait_for("normal sleep restored (thermal pressure)");
    assert_eq!(request(&mut c, "HOLD 30"), Err("thermal".into()));
    h.sensors("battery=50 ac=1 thermal=0 lid=open");
    request(&mut c, "HOLD 30").unwrap();
    h.sensors("battery=9 ac=0 thermal=0 lid=open");
    h.wait_for("normal sleep restored (battery at the floor)");
}

#[test]
fn a_marker_at_start_restores_first() {
    // The last run (or the Mac before a restart) left the switch on.
    let h = H::start_in(tmp(), PLUGGED, |d| std::fs::write(d.join("state/held"), b"").unwrap());
    let out = h.out();
    let restored = out.find("normal sleep restored (found its marker at start)").expect(&out);
    assert!(out.find(OFF).unwrap() < restored && restored < out.find("listening on").unwrap());
    assert!(!h.dir.join("state/held").exists());
}

#[test]
fn bad_requests_are_refused_and_the_connection_closed() {
    let h = H::start(PLUGGED);
    for (line, want) in [
        ("HOLD 0", "lease"),
        ("HOLD 301", "lease"),
        ("HOLD -5", "lease"),
        ("HOLD 1000", "lease"),
        ("HOLD 5x", "lease"),
        ("HOLD  5", "lease"),
        ("HOLD", "unknown"),
        ("hold 5", "unknown"),
        ("STATUS now", "unknown"),
        ("rm -rf /", "unknown"),
        ("", "unknown"),
    ] {
        let mut c = h.conn();
        assert_eq!(request(&mut c, line), Err(want.into()), "{line:?}");
        assert!(request(&mut c, "STATUS").is_err(), "{line:?}: the connection should be closed");
    }
    // Non-printable bytes, and a line longer than 63 bytes.
    let mut c = h.conn();
    assert_eq!(request(&mut c, "STATUS\u{1}"), Err("input".into()));
    let mut c = h.conn();
    assert_eq!(request(&mut c, &"A".repeat(100)), Err("too-long".into()));
    // Nothing was ever held.
    assert_eq!(h.count("would run"), 0);
    // Still serving.
    assert!(request(&mut h.conn(), "STATUS").is_ok());
}

#[test]
fn only_four_connections_at_once() {
    let h = H::start(PLUGGED);
    let mut keep: Vec<UnixStream> = (0..4).map(|_| h.conn()).collect();
    for c in keep.iter_mut() {
        request(c, "STATUS").unwrap();
    }
    assert_eq!(request(&mut h.conn(), "STATUS"), Err("busy".into()));
    keep.pop();
    std::thread::sleep(Duration::from_millis(100));
    assert!(request(&mut h.conn(), "STATUS").is_ok());
}

#[test]
fn uninstall_lets_go_and_exits() {
    let mut h = H::start(PLUGGED);
    let mut c = h.conn();
    request(&mut c, "HOLD 30").unwrap();
    assert_eq!(request(&mut h.conn(), "UNINSTALL"), Ok(String::new()));
    assert!(h.exited());
    let out = h.out();
    assert!(out.contains("normal sleep restored (uninstall)"), "{out}");
    assert!(out.contains("would remove: /Library/LaunchDaemons/sh.coool.lid-helper.plist /Library/PrivilegedHelperTools/sh.coool.lid-helper /var/db/sh.coool.lid-helper /var/run/sh.coool.lid-helper"), "{out}");
    assert!(out.contains("would run: /bin/launchctl bootout system/sh.coool.lid-helper"), "{out}");
    assert!(!h.dir.join("run/s").exists());
}

#[test]
fn sigterm_lets_go() {
    let mut h = H::start(PLUGGED);
    let mut c = h.conn();
    request(&mut c, "HOLD 30").unwrap();
    h.wait_for(ON);
    // SAFETY: our own child.
    unsafe { libc::kill(h.child.as_ref().unwrap().id() as i32, libc::SIGTERM) };
    assert!(h.exited());
    assert!(h.out().contains("normal sleep restored (helper stopping)"));
}

#[test]
fn start_up_refusals() {
    let d = tmp();
    let me = uid().to_string();
    let refused = |args: &[&str], why: &str| {
        let (code, out) = H::run(&d, args);
        assert_eq!(code, 2, "{args:?}: {out}");
        assert!(out.contains(why), "{args:?}: {out}");
    };
    // The installed form: root only, and it takes no paths.
    if uid() != 0 {
        refused(&["--uid", &me], "must run as root");
    }
    refused(&["--uid", &me, "--socket", "/tmp/x"], "for --dry-run only");
    refused(&["--uid", &me, "--state", "/tmp"], "for --dry-run only");
    refused(&["--uid", &me, "--exit-with-stdin"], "for --dry-run only");
    refused(&["--uid", "0"], "not root");
    refused(&["--uid", "5x"], "usage");
    refused(&["--uid", "-1"], "usage");
    refused(&["--uid", "1234567890"], "usage");
    refused(&[], "usage");
    refused(&["--uid", &me, "--please"], "usage");
    // Dry run: its folders must be the caller's own, not symlinks, not writable by others.
    std::fs::create_dir_all(d.join("open")).unwrap();
    set_mode(&d.join("open"), 0o777).unwrap();
    std::fs::create_dir_all(d.join("ok")).unwrap();
    set_mode(&d.join("ok"), 0o700).unwrap();
    std::os::unix::fs::symlink(d.join("ok"), d.join("link")).unwrap();
    let sock = d.join("ok/s");
    let s = sock.to_str().unwrap();
    refused(&["--dry-run", "--uid", &me, "--socket", s, "--state", d.join("open").to_str().unwrap()], "writable by others");
    refused(&["--dry-run", "--uid", &me, "--socket", s, "--state", d.join("link").to_str().unwrap()], "is a symlink");
    refused(&["--dry-run", "--uid", &me, "--socket", d.join("open/s").to_str().unwrap(), "--state", d.join("ok").to_str().unwrap()], "writable by others");
    refused(&["--dry-run", "--uid", &me, "--socket", s], "usage");
    // A file where the socket goes is never removed.
    std::fs::write(&sock, b"keep").unwrap();
    refused(&["--dry-run", "--uid", &me, "--socket", s, "--state", d.join("ok").to_str().unwrap()], "isn't a socket");
    assert_eq!(std::fs::read(&sock).unwrap(), b"keep");
    let long = format!("/tmp/{}", "x".repeat(120));
    refused(&["--dry-run", "--uid", &me, "--socket", &long, "--state", d.join("ok").to_str().unwrap()], "too long");
    let _ = std::fs::remove_dir_all(&d);
}

// ---------- coool's client against it ----------

#[test]
fn the_client_installs_holds_and_removes_the_dry_run_helper() {
    let dry = DryRun::new(tmp());
    let mut s = Socket::dry(dry.clone());
    assert_eq!(s.probe(), HelperState::Missing);
    (s.install_job())().unwrap();
    assert_eq!(s.probe(), HelperState::Ready);
    s.hold(10).unwrap();
    s.beat().unwrap();
    s.release();
    assert!(s.beat().is_err(), "not connected after release");
    s.hold(10).unwrap();
    // A simulated kill: the connection drops without RELEASE; the helper lets go.
    s.drop_connection();
    let log = || std::fs::read_to_string(dry.log()).unwrap_or_default();
    let t0 = Instant::now();
    while !log().contains("normal sleep restored (coool went away)") && t0.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(log().contains("normal sleep restored (coool went away)"), "{}", log());
    s.uninstall().unwrap();
    assert_eq!(s.probe(), HelperState::Missing);
    assert!(log().contains("would remove: "));
    let _ = std::fs::remove_dir_all(&dry.dir);
}

#[test]
fn the_dry_run_helper_exits_with_its_parent() {
    // stdin closing (coool gone) stops it, letting go first.
    let dry = DryRun::new(tmp());
    dry.start().unwrap();
    let mut s = Socket::dry(dry.clone());
    s.hold(10).unwrap();
    let child = dry.child.lock().unwrap().take().unwrap();
    let mut child = child;
    drop(child.stdin.take());
    let t0 = Instant::now();
    while child.try_wait().unwrap().is_none() && t0.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(child.try_wait().unwrap().is_some(), "still running");
    let log = std::fs::read_to_string(dry.log()).unwrap();
    assert!(log.contains("normal sleep restored (helper stopping)"), "{log}");
    let _ = std::fs::remove_dir_all(&dry.dir);
}

#[test]
fn the_lid_hold_end_to_end_with_the_dry_run_helper() {
    use crate::lid::{Lid, Prefs, Reading, Via, sensors::Fake};
    let dry = DryRun::new(tmp());
    let s = Fake::default();
    *s.0.lock().unwrap() = Reading { on_battery: Some(false), battery_pct: Some(90), thermal: Some(crate::motion::Thermal::Nominal), lid_closed: Some(false), lid_sleeps: Some(true), sleep_disabled: Some(false) };
    let mut lid = Lid::new(Box::new(Socket::dry(dry.clone())), Box::new(s.clone()), Some(dry.dir.join("app")), Prefs { enabled: true, ..Prefs::default() }, 0);
    (lid.install_job())().unwrap();
    lid.refresh_helper(0);
    lid.tick(1000, 1);
    assert_eq!(lid.status(1000).via, Some(Via::Helper));
    let log = || std::fs::read_to_string(dry.log()).unwrap_or_default();
    assert!(log().contains("holding: SleepDisabled on (lease 60 s)"), "{}", log());
    lid.tick(2000, 0);
    assert!(log().contains("normal sleep restored (coool let go)"), "{}", log());
    assert_eq!(lid.status(2000).via, None);
    lid.set_prefs(Prefs::default(), 3000);
    assert!(log().contains("would remove: "), "turning it off removes the helper");
    drop(lid);
    let _ = std::fs::remove_dir_all(&dry.dir);
}

#[test]
fn the_install_script_checks_hashes_and_quotes_paths() {
    let s = install_script(Path::new("/Users/o'neil/Library/Application Support/coool/lid-helper"), "aa", "bb").unwrap();
    assert!(s.contains(r#"/usr/bin/install -o root -g wheel -m 0755 '/Users/o'\''neil/Library/Application Support/coool/lid-helper/sh.coool.lid-helper' /Library/PrivilegedHelperTools/sh.coool.lid-helper.new"#), "{s}");
    assert!(s.contains("= 'aa' ]") && s.contains("= 'bb' ]"));
    assert!(s.starts_with("set -e\n"));
    assert!(s.contains("/bin/launchctl bootstrap system /Library/LaunchDaemons/sh.coool.lid-helper.plist"));
    assert!(install_script(Path::new("/tmp/a\nb"), "aa", "bb").is_err());
    let p = plist(501);
    assert!(p.contains("<string>/Library/PrivilegedHelperTools/sh.coool.lid-helper</string>\n\t\t<string>--uid</string>\n\t\t<string>501</string>"));
    // The plist is what plutil accepts.
    let d = tmp();
    std::fs::write(d.join("p.plist"), &p).unwrap();
    let ok = Command::new("/usr/bin/plutil").arg("-lint").arg(d.join("p.plist")).output().unwrap();
    assert!(ok.status.success(), "{}", String::from_utf8_lossy(&ok.stdout));
    let _ = std::fs::remove_dir_all(&d);
}
