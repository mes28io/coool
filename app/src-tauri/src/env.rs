//! PATH resolution for GUI launches.
//!
//! An app started from Finder / the Dock inherits launchd's minimal PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), so `claude` and `codex` (usually in
//! ~/.local/bin, ~/.npm-global/bin, /opt/homebrew/bin...) wouldn't be found.
//! We ask the user's login shell for its PATH once at startup, then append the
//! usual install dirs as a fallback. coool only locates binaries; it never
//! reads or passes credentials.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

const MARK: &str = "__COOOL_PATH__";

fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        // -i -l so both .zprofile and .zshrc style setups are honoured; markers
        // fence off anything a noisy rc file prints.
        let out = Command::new(&shell)
            .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        let _ = tx.send(out);
    });
    let out = rx.recv_timeout(Duration::from_secs(4)).ok()?.ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let start = s.find(MARK)? + MARK.len();
    let end = start + s[start..].find(MARK)?;
    let p = s[start..end].trim().to_string();
    (!p.is_empty()).then_some(p)
}

fn fallback_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(h) = dirs::home_dir() {
        for d in [".local/bin", ".npm-global/bin", ".bun/bin", ".cargo/bin", ".volta/bin", ".claude/local", "bin"] {
            v.push(h.join(d));
        }
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        v.push(PathBuf::from(d));
    }
    v
}

/// Merge login-shell PATH + current PATH + fallbacks (deduped, order kept)
/// and install it as this process's PATH. Call before spawning threads.
pub fn adopt_login_path() {
    let mut parts: Vec<PathBuf> = Vec::new();
    let mut add = |p: PathBuf| {
        if !p.as_os_str().is_empty() && !parts.contains(&p) {
            parts.push(p);
        }
    };
    if let Some(p) = login_shell_path() {
        std::env::split_paths(&p).for_each(&mut add);
    }
    if let Some(p) = std::env::var_os("PATH") {
        std::env::split_paths(&p).for_each(&mut add);
    }
    fallback_dirs().into_iter().for_each(&mut add);
    if let Ok(joined) = std::env::join_paths(parts) {
        // SAFETY: called at the top of `run()`, before Tauri or any of our threads start.
        unsafe { std::env::set_var("PATH", joined) };
    }
}

/// First executable named `bin` on PATH.
pub fn which(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(bin)).find(|p| is_executable(p))
}

#[cfg(not(unix))]
fn is_executable(p: &std::path::Path) -> bool {
    p.is_file()
}

#[cfg(unix)]
fn is_executable(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}
