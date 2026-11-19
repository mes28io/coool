//! The client of the root helper (native/coool-lid-helper.m) and its install, removal and restore jobs.
//!
//! Installed (one administrator approval, `osascript … with administrator privileges`, which runs a fixed script):
//! - `/Library/PrivilegedHelperTools/sh.coool.lid-helper` (root:wheel 0755): the binary embedded in coool. Its
//!   identity doesn't depend on coool's code signature, so rebuilding coool (a new ad-hoc signature each time) changes
//!   nothing; only a new helper protocol asks for a reinstall.
//! - `/Library/LaunchDaemons/sh.coool.lid-helper.plist` (root:wheel 0644): RunAtLoad + KeepAlive, `--uid <you>`.
//! The script copies both from a staging folder in coool's app data and checks their SHA-256 against what coool
//! wrote (computed from the bytes in memory), so a file swapped in between is refused.
//!
//! At run time the helper keeps `/var/db/sh.coool.lid-helper/` (its marker) and `/var/run/sh.coool.lid-helper/s` (the
//! socket, yours, 0600). Removal: the helper removes itself on request (no password: it is root already); if it doesn't
//! answer, a second approval runs the removal script. Both turn SleepDisabled off first if the helper's marker says it
//! set it.
//!
//! Dry run (a self-test, `COOOL_LID_DRYRUN=<folder>`): "installing" starts the embedded helper with `--dry-run` in that
//! folder (nothing is copied anywhere, no password), so the real client talks to the real helper code, which prints
//! what it would run.

use super::{HelperState, Job};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const LABEL: &str = "sh.coool.lid-helper";
pub const BIN: &str = "/Library/PrivilegedHelperTools/sh.coool.lid-helper";
pub const PLIST: &str = "/Library/LaunchDaemons/sh.coool.lid-helper.plist";
pub const SOCKET: &str = "/var/run/sh.coool.lid-helper/s";
/// The protocol this coool speaks (the helper's `VERSION`).
pub const PROTOCOL: u32 = 1;
const IO_TIMEOUT: Duration = Duration::from_secs(2);

/// The helper binary built by build.rs (empty when it couldn't be built).
pub static BINARY: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/coool-lid-helper"));

/// A dry-run helper: started by "Install…", stopped by "Remove helper" or when coool quits (its stdin closes).
pub struct DryRun {
    pub dir: PathBuf,
    child: Mutex<Option<Child>>,
}

impl DryRun {
    pub fn new(dir: PathBuf) -> Arc<Self> {
        Arc::new(DryRun { dir, child: Mutex::new(None) })
    }
    pub fn socket(&self) -> PathBuf {
        self.dir.join("run").join("s")
    }
    /// The readings file the helper re-reads (`--sensors`).
    pub fn sensors(&self) -> PathBuf {
        self.dir.join("sensors")
    }
    pub fn log(&self) -> PathBuf {
        self.dir.join("helper.log")
    }
    fn running(&self) -> bool {
        let mut c = self.child.lock().unwrap();
        match c.as_mut().map(|ch| ch.try_wait()) {
            Some(Ok(None)) => true,
            Some(_) => {
                *c = None;
                false
            }
            None => false,
        }
    }
    fn start(&self) -> Result<(), String> {
        if self.running() {
            return Ok(());
        }
        if BINARY.is_empty() {
            return Err("this build has no lid helper".into());
        }
        for d in ["bin", "run", "state"] {
            let p = self.dir.join(d);
            std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
            set_mode(&p, 0o700)?;
        }
        let bin = self.dir.join("bin").join(LABEL);
        std::fs::write(&bin, BINARY).map_err(|e| e.to_string())?;
        set_mode(&bin, 0o755)?;
        if !self.sensors().exists() {
            let _ = std::fs::write(self.sensors(), "battery=100 ac=1 thermal=0 lid=open causes=1\n");
        }
        let log = std::fs::OpenOptions::new().create(true).append(true).open(self.log()).map_err(|e| e.to_string())?;
        let err = log.try_clone().map_err(|e| e.to_string())?;
        let child = Command::new(&bin)
            .args(["--dry-run", "--uid", &uid().to_string(), "--exit-with-stdin", "--socket"])
            .arg(self.socket())
            .arg("--state")
            .arg(self.dir.join("state"))
            .arg("--sensors")
            .arg(self.sensors())
            .stdin(Stdio::piped())
            .stdout(log)
            .stderr(err)
            .spawn()
            .map_err(|e| e.to_string())?;
        *self.child.lock().unwrap() = Some(child);
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(3) {
            if UnixStream::connect(self.socket()).is_ok() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err("the dry-run helper didn't start (see helper.log)".into())
    }
    fn stop(&self) {
        if let Some(mut c) = self.child.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

impl Drop for DryRun {
    fn drop(&mut self) {
        self.stop();
    }
}

fn set_mode(p: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())
}

fn uid() -> u32 {
    // SAFETY: getuid has no failure mode.
    unsafe { libc::getuid() }
}

/// The real helper, or the dry-run one.
pub struct Socket {
    dry: Option<Arc<DryRun>>,
    /// coool's app data folder: the install job stages its files in `lid-helper/` there.
    data: PathBuf,
    /// The holding connection (open while holding: closing it lets go).
    conn: Option<UnixStream>,
}

impl Socket {
    pub fn real(data: PathBuf) -> Self {
        Socket { dry: None, data, conn: None }
    }
    pub fn dry(d: Arc<DryRun>) -> Self {
        let data = d.dir.clone();
        Socket { dry: Some(d), data, conn: None }
    }

    fn socket_path(&self) -> PathBuf {
        match &self.dry {
            Some(d) => d.socket(),
            None => PathBuf::from(SOCKET),
        }
    }

    fn installed(&self) -> bool {
        match &self.dry {
            Some(d) => d.running(),
            None => Path::new(PLIST).exists(),
        }
    }

    fn connect(&self) -> Result<UnixStream, String> {
        let s = UnixStream::connect(self.socket_path()).map_err(|e| e.to_string())?;
        s.set_read_timeout(Some(IO_TIMEOUT)).map_err(|e| e.to_string())?;
        s.set_write_timeout(Some(IO_TIMEOUT)).map_err(|e| e.to_string())?;
        Ok(s)
    }
}

/// Sends one request line and reads one reply line. Err: the reply's "ERR <code>" code, or an I/O error.
pub fn request(s: &mut UnixStream, line: &str) -> Result<String, String> {
    s.write_all(format!("{line}\n").as_bytes()).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut b = [0u8; 1];
    loop {
        match s.read(&mut b) {
            Ok(0) => return Err("the helper closed the connection".into()),
            Ok(_) if b[0] == b'\n' => break,
            Ok(_) => {
                out.push(b[0]);
                if out.len() > 256 {
                    return Err("reply too long".into());
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    let r = String::from_utf8_lossy(&out).into_owned();
    match r.strip_prefix("OK") {
        Some(rest) => Ok(rest.trim().to_string()),
        None => Err(r.strip_prefix("ERR ").unwrap_or(&r).to_string()),
    }
}

/// `v=1 held=0 …` -> the value of `key`.
pub fn field<'a>(reply: &'a str, key: &str) -> Option<&'a str> {
    reply.split_whitespace().find_map(|kv| kv.strip_prefix(key).and_then(|v| v.strip_prefix('=')))
}

impl super::Helper for Socket {
    fn probe(&mut self) -> HelperState {
        if self.dry.is_none() && BINARY.is_empty() && !Path::new(PLIST).exists() {
            return HelperState::Unavailable;
        }
        if !self.installed() {
            return HelperState::Missing;
        }
        let r = self.connect().and_then(|mut s| request(&mut s, "STATUS"));
        match r {
            Ok(r) => match field(&r, "v").and_then(|v| v.parse::<u32>().ok()) {
                Some(PROTOCOL) => HelperState::Ready,
                Some(v) => HelperState::Outdated(v),
                None => HelperState::Unreachable(format!("unexpected reply: {r}")),
            },
            Err(e) => HelperState::Unreachable(e),
        }
    }

    fn hold(&mut self, lease: u32) -> Result<(), String> {
        let mut s = match self.conn.take() {
            Some(s) => s,
            None => self.connect()?,
        };
        request(&mut s, &format!("HOLD {lease}"))?;
        self.conn = Some(s);
        Ok(())
    }

    fn beat(&mut self) -> Result<(), String> {
        let Some(s) = self.conn.as_mut() else { return Err("not connected".into()) };
        match request(s, "BEAT") {
            Ok(_) => Ok(()),
            Err(e) => {
                self.conn = None;
                Err(e)
            }
        }
    }

    fn release(&mut self) {
        if let Some(mut s) = self.conn.take() {
            let _ = request(&mut s, "RELEASE");
        }
    }

    fn uninstall(&mut self) -> Result<(), String> {
        self.release();
        let mut s = self.connect()?;
        request(&mut s, "UNINSTALL")?;
        if let Some(d) = &self.dry {
            // The dry-run helper exits after printing what it would remove.
            let t0 = Instant::now();
            while d.running() && t0.elapsed() < Duration::from_secs(3) {
                std::thread::sleep(Duration::from_millis(50));
            }
            d.stop();
        } else {
            // launchd boots it out; wait for its files to go.
            let t0 = Instant::now();
            while Path::new(PLIST).exists() && t0.elapsed() < Duration::from_secs(5) {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        Ok(())
    }

    fn install_job(&self) -> Job {
        if let Some(d) = &self.dry {
            let d = d.clone();
            return Box::new(move || d.start());
        }
        let data = self.data.clone();
        Box::new(move || install(&data))
    }

    fn remove_job(&self) -> Job {
        if let Some(d) = &self.dry {
            let d = d.clone();
            return Box::new(move || {
                d.stop();
                Ok(())
            });
        }
        Box::new(|| admin(REMOVE_SCRIPT, "coool wants to remove its lid helper and restore normal sleep."))
    }

    fn restore_job(&self) -> Job {
        if self.dry.is_some() {
            return Box::new(|| Ok(()));
        }
        Box::new(|| admin(RESTORE_SCRIPT, "coool wants to turn normal sleep back on (pmset disablesleep 0)."))
    }

    fn dry_run(&self) -> bool {
        self.dry.is_some()
    }

    fn drop_connection(&mut self) {
        // No RELEASE: as if coool had been killed.
        self.conn = None;
    }
}

// ---------- install, remove, restore (real) ----------

pub const REMOVE_SCRIPT: &str = "/bin/launchctl bootout system/sh.coool.lid-helper 2>/dev/null || true
if [ -e /var/db/sh.coool.lid-helper/held ]; then /usr/bin/pmset -a disablesleep 0; fi
/bin/rm -f /Library/LaunchDaemons/sh.coool.lid-helper.plist /Library/PrivilegedHelperTools/sh.coool.lid-helper /Library/PrivilegedHelperTools/sh.coool.lid-helper.new /Library/PrivilegedHelperTools/sh.coool.lid-helper.plist.new
/bin/rm -rf /var/db/sh.coool.lid-helper /var/run/sh.coool.lid-helper";

pub const RESTORE_SCRIPT: &str = "/usr/bin/pmset -a disablesleep 0";

pub fn plist(uid: u32) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{BIN}</string>
		<string>--uid</string>
		<string>{uid}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
</dict>
</plist>
"#
    )
}

fn sha256(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// Single-quotes `s` for /bin/sh.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The root script that installs the staged files (checked by hash) and loads the daemon.
pub fn install_script(stage: &Path, bin_hash: &str, plist_hash: &str) -> Result<String, String> {
    let st = stage.to_str().ok_or("the staging path isn't text")?;
    if st.chars().any(|c| c.is_control()) {
        return Err("the staging path has control characters".into());
    }
    let bin_src = sh_quote(&format!("{st}/{LABEL}"));
    let plist_src = sh_quote(&format!("{st}/{LABEL}.plist"));
    let d = "/Library/PrivilegedHelperTools";
    let check = |file: &str, hash: &str| {
        format!(
            "[ \"$(/usr/bin/shasum -a 256 {file} | /usr/bin/cut -c1-64)\" = '{hash}' ] || {{ /bin/rm -f {d}/{LABEL}.new {d}/{LABEL}.plist.new; echo 'the helper changed while it was being installed' >&2; exit 1; }}"
        )
    };
    Ok([
        "set -e".to_string(),
        "umask 022".into(),
        format!("/bin/mkdir -p {d}"),
        format!("/usr/bin/install -o root -g wheel -m 0755 {bin_src} {d}/{LABEL}.new"),
        check(&format!("{d}/{LABEL}.new"), bin_hash),
        format!("/usr/bin/install -o root -g wheel -m 0644 {plist_src} {d}/{LABEL}.plist.new"),
        check(&format!("{d}/{LABEL}.plist.new"), plist_hash),
        format!("/bin/launchctl bootout system/{LABEL} 2>/dev/null || true"),
        format!("/bin/mv -f {d}/{LABEL}.new {BIN}"),
        format!("/bin/mv -f {d}/{LABEL}.plist.new {PLIST}"),
        format!("/bin/launchctl bootstrap system {PLIST} || {{ /bin/sleep 1; /bin/launchctl bootstrap system {PLIST}; }}"),
    ]
    .join("\n"))
}

fn install(data: &Path) -> Result<(), String> {
    if BINARY.is_empty() {
        return Err("this build of coool has no lid helper".into());
    }
    let stage = data.join("lid-helper");
    std::fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    set_mode(&stage, 0o700)?;
    let p = plist(uid());
    std::fs::write(stage.join(LABEL), BINARY).map_err(|e| e.to_string())?;
    std::fs::write(stage.join(format!("{LABEL}.plist")), &p).map_err(|e| e.to_string())?;
    let script = install_script(&stage, &sha256(BINARY), &sha256(p.as_bytes()))?;
    let r = admin(&script, "coool wants to install a small helper so agents can keep working with the lid closed. It only turns sleep off while agents work, and back on when they stop.");
    let _ = std::fs::remove_dir_all(&stage);
    r?;
    // Wait for launchd to start it.
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(5) {
        if UnixStream::connect(SOCKET).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("installed, but the helper didn't start".into())
}

/// Runs `script` as root after the system's administrator prompt (`do shell script … with administrator
/// privileges`). The script is an argument, never spliced into AppleScript source.
fn admin(script: &str, prompt: &str) -> Result<(), String> {
    let out = Command::new("/usr/bin/osascript")
        .args(["-e", "on run argv", "-e", "do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges", "-e", "end run", script, prompt])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let e = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if e.contains("-128") {
        Err("cancelled".into())
    } else {
        Err(if e.is_empty() { "the administrator step failed".into() } else { e })
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests;
