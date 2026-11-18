//! Claude Code and Codex CLI detection for Settings: is the binary on PATH,
//! does `--version` run, and if not, the one shell command that fixes it.
//!
//! Only `<cli> --version` is run, with stdin closed and a timeout; nothing
//! about the person's account is read.

use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How long `--version` may take before the child is killed.
pub const TIMEOUT: Duration = Duration::from_secs(8);
/// Longest error detail line shown.
const MAX_DETAIL: usize = 200;

/// What Settings shows for one CLI.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CliStatus {
    /// "claude" or "codex".
    pub provider: String,
    /// "Claude Code" or "Codex".
    pub name: String,
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
    /// A shell command that fixes the problem (reinstall, or install when missing).
    pub fix: Option<String>,
    /// The install (or upgrade) command for this kind of install.
    pub install: String,
}

/// Display name of a provider.
fn display_name(provider: &str) -> &'static str {
    if provider == "codex" { "Codex" } else { "Claude Code" }
}

fn is_npm(path: &str) -> bool {
    path.contains("node_modules") || path.contains("npm")
}

fn is_brew(path: &str) -> bool {
    path.starts_with("/opt/homebrew") || path.contains("/usr/local/Cellar") || path.contains("/Caskroom/")
}

/// The command that installs (or, for Homebrew, upgrades) the CLI, given where it lives.
pub fn install_command(provider: &str, path: Option<&str>) -> String {
    let p = path.unwrap_or("");
    match provider {
        "codex" if !is_npm(p) && is_brew(p) => "brew upgrade codex".into(),
        "codex" => "npm install -g @openai/codex".into(),
        _ if is_npm(p) => "npm install -g @anthropic-ai/claude-code".into(),
        _ => "curl -fsSL https://claude.ai/install.sh | bash".into(),
    }
}

/// The command that reinstalls the CLI, given where it lives (the install command when it's missing).
pub fn fix_command(provider: &str, path: Option<&str>) -> String {
    let p = path.unwrap_or("");
    if provider == "codex" && !is_npm(p) && is_brew(p) {
        return "brew reinstall codex".into();
    }
    install_command(provider, path)
}

/// Length of the run of ASCII digits at the start of `b`.
fn digits(b: &[u8]) -> usize {
    b.iter().take_while(|c| c.is_ascii_digit()).count()
}

/// Length of a `\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?` match at the start of `b`, if any.
fn semver_at(b: &[u8]) -> Option<usize> {
    let mut i = 0;
    for part in 0..3 {
        let n = digits(&b[i..]);
        if n == 0 {
            return None;
        }
        i += n;
        if part < 2 {
            if b.get(i) != Some(&b'.') {
                return None;
            }
            i += 1;
        }
    }
    if b.get(i) == Some(&b'-') {
        let n = b[i + 1..].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == b'.').count();
        if n > 0 {
            i += 1 + n;
        }
    }
    while i > 0 && b[i - 1] == b'.' {
        i -= 1;
    }
    Some(i)
}

/// The first semver-like token in `--version` output, e.g. "2.1.14" or "0.46.0-alpha.3".
pub fn parse_version(out: &str) -> Option<String> {
    let b = out.as_bytes();
    (0..b.len())
        .filter(|&i| b[i].is_ascii_digit() && (i == 0 || !(b[i - 1].is_ascii_digit() || b[i - 1] == b'.')))
        .find_map(|i| semver_at(&b[i..]).map(|n| out[i..i + n].to_string()))
}

/// First non-empty line, trimmed and cut to [`MAX_DETAIL`] characters.
fn first_line(s: &str) -> Option<String> {
    let l = s.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(l.chars().take(MAX_DETAIL).collect())
}

fn with_detail(msg: String, detail: Option<String>) -> String {
    match detail {
        Some(d) => format!("{msg}: {d}"),
        None => msg,
    }
}

/// The result of running a program: exit success, stdout, stderr; or why it couldn't run.
enum Ran {
    Done { ok: bool, code: Option<i32>, out: String, err: String },
    Timeout,
    Failed(String),
}

/// Runs `path --version` with stdin closed, killing it after `timeout`.
fn run_version(path: &Path, timeout: Duration) -> Ran {
    let child = Command::new(path).arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => return Ran::Failed(e.to_string()),
    };
    let pipe = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut s = Vec::new();
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut s);
            }
            String::from_utf8_lossy(&s).into_owned()
        })
    };
    let out = pipe(child.stdout.take().map(|r| Box::new(r) as Box<dyn Read + Send>));
    let err = pipe(child.stderr.take().map(|r| Box::new(r) as Box<dyn Read + Send>));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Ran::Timeout;
            }
            Err(e) => return Ran::Failed(e.to_string()),
        }
    };
    Ran::Done { ok: status.success(), code: status.code(), out: out.join().unwrap_or_default(), err: err.join().unwrap_or_default() }
}

/// Checks the CLI at a known path.
pub fn check_path(provider: &str, path: &Path) -> CliStatus {
    check_path_with(provider, path, TIMEOUT)
}

fn check_path_with(provider: &str, path: &Path, timeout: Duration) -> CliStatus {
    let name = display_name(provider);
    let shown = path.display().to_string();
    // The resolved path tells an npm or Homebrew install apart from the PATH link.
    let kind = std::fs::canonicalize(path).map(|p| p.display().to_string()).unwrap_or_else(|_| shown.clone());
    let mut st = CliStatus {
        provider: provider.into(),
        name: name.into(),
        found: true,
        path: Some(shown),
        version: None,
        error: None,
        fix: None,
        install: install_command(provider, Some(&kind)),
    };
    let error = match run_version(path, timeout) {
        Ran::Failed(e) => format!("{name} is installed but won't start: {e}"),
        Ran::Timeout => format!("{name} didn't answer `--version` within {} s", timeout.as_secs()),
        Ran::Done { ok: false, code, out, err } => {
            let code = code.map_or("a signal".to_string(), |c| format!("status {c}"));
            with_detail(format!("{name} exited with {code}"), first_line(&err).or_else(|| first_line(&out)))
        }
        Ran::Done { ok: true, out, err, .. } => match parse_version(&out).or_else(|| parse_version(&err)) {
            Some(v) => {
                st.version = Some(v);
                return st;
            }
            None => with_detail(format!("Couldn't read {name}'s version"), first_line(&out).or_else(|| first_line(&err))),
        },
    };
    st.error = Some(error);
    st.fix = Some(fix_command(provider, Some(&kind)));
    st
}

/// Finds `claude` or `codex` on PATH and checks that it runs.
pub fn check(provider: &str) -> CliStatus {
    let bin = if provider == "codex" { "codex" } else { "claude" };
    match crate::env::which(bin) {
        Some(p) => check_path(provider, &p),
        None => {
            let install = install_command(provider, None);
            CliStatus {
                provider: provider.into(),
                name: display_name(provider).into(),
                found: false,
                path: None,
                version: None,
                error: None,
                fix: Some(install.clone()),
                install,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    fn script(name: &str, body: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("coool-clis-{}-{:?}", std::process::id(), Instant::now()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join(name);
        std::fs::write(&p, body).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[test]
    fn versions() {
        let v = |s: &str| parse_version(s);
        assert_eq!(v("2.1.14 (Claude Code)").as_deref(), Some("2.1.14"));
        assert_eq!(v("codex-cli 0.98.0\n").as_deref(), Some("0.98.0"));
        assert_eq!(v("codex-cli 0.46.0-alpha.3").as_deref(), Some("0.46.0-alpha.3"));
        let warned = "(node:4242) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.\n2.0.1 (Claude Code)";
        assert_eq!(v(warned).as_deref(), Some("2.0.1"));
        assert_eq!(v("version 1.2.3.").as_deref(), Some("1.2.3"));
        assert_eq!(v("1.2.3-"), Some("1.2.3".into()));
        assert_eq!(v("garbage"), None);
        assert_eq!(v("1.2 and 3"), None);
        assert_eq!(v(""), None);
        assert_eq!(v("12.34"), None);
    }

    #[test]
    fn commands() {
        assert_eq!(fix_command("claude", None), "curl -fsSL https://claude.ai/install.sh | bash");
        assert_eq!(fix_command("claude", Some("/Users/x/.local/share/claude/versions/2.1.14")), "curl -fsSL https://claude.ai/install.sh | bash");
        assert_eq!(fix_command("claude", Some("/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js")), "npm install -g @anthropic-ai/claude-code");
        assert_eq!(fix_command("claude", Some("/Users/x/.npm-global/bin/claude")), "npm install -g @anthropic-ai/claude-code");
        assert_eq!(fix_command("codex", None), "npm install -g @openai/codex");
        assert_eq!(fix_command("codex", Some("/opt/homebrew/Caskroom/codex/0.98.0/codex")), "brew reinstall codex");
        assert_eq!(fix_command("codex", Some("/usr/local/Cellar/codex/0.98.0/bin/codex")), "brew reinstall codex");
        assert_eq!(fix_command("codex", Some("/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js")), "npm install -g @openai/codex", "npm on Homebrew's node");
        assert_eq!(install_command("codex", Some("/opt/homebrew/Caskroom/codex/0.98.0/codex")), "brew upgrade codex");
    }

    #[test]
    fn check_fake_binaries() {
        let ok = check_path("codex", &script("codex", "#!/bin/sh\necho \"codex-cli 1.2.3\"\n"));
        assert!(ok.found && ok.error.is_none() && ok.fix.is_none());
        assert_eq!(ok.version.as_deref(), Some("1.2.3"));

        let broken = check_path("codex", &script("codex", "#!/nonexistent/interp\n"));
        assert!(broken.found && broken.version.is_none());
        assert!(broken.error.as_deref().unwrap().starts_with("Codex is installed but won't start"), "{:?}", broken.error);
        assert_eq!(broken.fix.as_deref(), Some("npm install -g @openai/codex"));

        let failing = check_path("claude", &script("claude", "#!/bin/sh\necho >&2\necho '  Error: Cannot find module x  ' >&2\nexit 3\n"));
        assert_eq!(failing.error.as_deref(), Some("Claude Code exited with status 3: Error: Cannot find module x"));

        let odd = check_path("claude", &script("claude", "#!/bin/sh\necho hello\n"));
        assert_eq!(odd.error.as_deref(), Some("Couldn't read Claude Code's version: hello"));

        let slow = check_path_with("claude", &script("claude", "#!/bin/sh\nsleep 30\n"), Duration::from_millis(200));
        assert!(slow.error.as_deref().unwrap().contains("didn't answer"));
    }
}
