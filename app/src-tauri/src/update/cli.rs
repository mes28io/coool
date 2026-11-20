//! Keeping the CLIs coool drives (Claude Code, Codex) up to date, each through its own install method's mechanism.
//!
//! | CLI | how it's installed (resolved binary path) | what coool runs |
//! |---|---|---|
//! | Claude Code | npm global (`…/lib/node_modules/@anthropic-ai/claude-code/…`) | `npm install -g --prefix <prefix> @anthropic-ai/claude-code@<v>` |
//! | Claude Code | native installer (`~/.local/share/claude/…`) | `claude update` |
//! | Codex | npm global (`…/lib/node_modules/@openai/codex/…`) | `npm install -g --prefix <prefix> @openai/codex@<v>` |
//! | Codex | standalone installer (`~/.codex/packages/standalone/…`) | `codex update` (with `CODEX_NON_INTERACTIVE=1`) |
//! | either | Homebrew | nothing: shows `brew upgrade --cask claude-code` / `brew upgrade --cask codex` |
//! | either | anything else | nothing: shows `claude update` / `codex update` |
//!
//! An npm prefix coool can't write to (it would need sudo) is shown as a command too. Nothing runs while any process
//! of that CLI is running anywhere on the Mac (an update under live sessions has broken npm installs before), and
//! after an update `--version` must still answer, or the repair command is shown.
//!
//! The newest version comes from the npm registry's `latest` tag for both (the native and standalone builds are
//! published under the same version numbers).

use super::{Source, Version};
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Cli {
    Claude,
    Codex,
}

impl Cli {
    pub const ALL: [Cli; 2] = [Cli::Claude, Cli::Codex];
    pub fn id(self) -> &'static str {
        match self {
            Cli::Claude => "claude",
            Cli::Codex => "codex",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Cli::Claude => "Claude Code",
            Cli::Codex => "Codex",
        }
    }
    pub fn bin(self) -> &'static str {
        self.id()
    }
    pub fn package(self) -> &'static str {
        match self {
            Cli::Claude => "@anthropic-ai/claude-code",
            Cli::Codex => "@openai/codex",
        }
    }
    fn cask(self) -> &'static str {
        match self {
            Cli::Claude => "claude-code",
            Cli::Codex => "codex",
        }
    }
    pub fn index(self) -> usize {
        self as usize
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Method {
    /// A global npm install under this prefix (the folder holding `lib/node_modules`).
    Npm { prefix: PathBuf },
    /// Claude Code's native installer.
    Native,
    /// Codex's standalone installer.
    Standalone,
    Brew,
    Unknown,
}

impl Method {
    pub fn label(&self) -> &'static str {
        match self {
            Method::Npm { .. } => "npm",
            Method::Native => "native installer",
            Method::Standalone => "standalone installer",
            Method::Brew => "Homebrew",
            Method::Unknown => "unknown",
        }
    }
}

/// How the CLI at `real` (its fully resolved path) was installed.
pub fn detect(cli: Cli, real: &Path) -> Method {
    let p = real.to_string_lossy();
    let npm_marker = format!("/lib/node_modules/{}/", cli.package());
    if let Some(at) = p.find(&npm_marker) {
        return Method::Npm { prefix: PathBuf::from(&p[..at]) };
    }
    if p.contains("/Caskroom/") || p.contains("/Cellar/") || p.starts_with("/opt/homebrew/") {
        return Method::Brew;
    }
    match cli {
        Cli::Claude if p.contains("/.local/share/claude/") => Method::Native,
        Cli::Codex if p.contains("/.codex/packages/standalone/") => Method::Standalone,
        _ => Method::Unknown,
    }
}

/// What updating means for one install: a command coool runs itself, or only one to show.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    /// The program and its arguments, when coool may run it.
    pub argv: Option<Vec<OsString>>,
    pub env: Vec<(&'static str, &'static str)>,
    /// The command as a person would type it.
    pub shown: String,
    /// Why coool doesn't run it itself (shown with the command).
    pub manual: Option<String>,
}

fn writable(p: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(p.as_os_str().as_bytes()) else { return false };
    // SAFETY: a valid NUL-terminated path.
    unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
}

/// The update for `cli` installed by `method` at `bin`, to version `latest`. `npm`: the npm on PATH, if any.
pub fn plan(cli: Cli, method: &Method, bin: &Path, latest: &str, npm: Option<&Path>) -> Plan {
    let manual = |shown: String, why: &str| Plan { argv: None, env: vec![], shown, manual: Some(why.into()) };
    match method {
        Method::Npm { prefix } => {
            let shown = format!("npm install -g {}@latest", cli.package());
            let Some(npm) = npm else { return manual(shown, "npm isn't on coool's PATH.") };
            if !writable(&prefix.join("lib/node_modules")) {
                return manual(shown, "Its npm folder needs administrator rights, so coool won't run this itself.");
            }
            let argv = vec![npm.into(), "install".into(), "-g".into(), "--prefix".into(), prefix.into(), format!("{}@{latest}", cli.package()).into()];
            Plan { argv: Some(argv), env: vec![], shown, manual: None }
        }
        Method::Native => Plan { argv: Some(vec![bin.into(), "update".into()]), env: vec![], shown: "claude update".into(), manual: None },
        Method::Standalone => Plan { argv: Some(vec![bin.into(), "update".into()]), env: vec![("CODEX_NON_INTERACTIVE", "1")], shown: "codex update".into(), manual: None },
        Method::Brew => manual(format!("brew upgrade --cask {}", cli.cask()), "Installed with Homebrew: update it there."),
        Method::Unknown => manual(format!("{} update", cli.bin()), "coool can't tell how this was installed."),
    }
}

/// The command that puts a broken install right again.
pub fn repair(cli: Cli, method: &Method) -> String {
    match (cli, method) {
        (_, Method::Npm { .. }) => format!("npm install -g {}@latest", cli.package()),
        (_, Method::Brew) => format!("brew reinstall --cask {}", cli.cask()),
        (Cli::Claude, _) => "curl -fsSL https://claude.ai/install.sh | bash".into(),
        (Cli::Codex, _) => "curl -fsSL https://chatgpt.com/codex/install.sh | sh".into(),
    }
}

/// The version in a CLI's `--version` output (`2.1.329 (Claude Code)`, `codex-cli 0.145.0`).
pub fn parse_version(out: &str) -> Option<Version> {
    crate::prefs::clis::parse_version(out).and_then(|v| Version::parse(&v))
}

fn is_process_of(cli: Cli, args: &str) -> bool {
    let base = |s: &str| s.rsplit('/').next().unwrap_or(s).to_string();
    let mut words = args.split_whitespace();
    let first = words.next().map(base).unwrap_or_default();
    // A script run through its interpreter (`node …/cli.js`, `/bin/sh …/codex`) names the CLI second.
    let second = words.next().map(base).unwrap_or_default();
    let own = |w: &str| w == cli.bin() || (cli == Cli::Claude && w == "claude.exe");
    let interp = matches!(first.as_str(), "node" | "sh" | "bash" | "zsh" | "bun");
    own(&first)
        || (interp && own(&second))
        || args.contains(&format!("/node_modules/{}/", cli.package()))
        || match cli {
            Cli::Claude => args.contains("/.local/share/claude/versions/"),
            Cli::Codex => args.contains("/.codex/packages/standalone/"),
        }
}

/// How many lines of `ps -axo pid=,args=` are processes of `cli` (other than `skip`).
pub fn count_running(ps: &str, cli: Cli, skip: u32) -> usize {
    ps.lines()
        .filter_map(|l| {
            let l = l.trim_start();
            let (pid, args) = l.split_once(char::is_whitespace)?;
            Some((pid.parse::<u32>().ok()?, args.trim()))
        })
        .filter(|(pid, args)| *pid != skip && is_process_of(cli, args))
        .count()
}

/// Processes of `cli` running anywhere on this Mac (the person's own terminals included). `None`: `ps` failed, so
/// the caller must assume some are.
pub fn running(cli: Cli) -> Option<usize> {
    let out = Command::new("/bin/ps").args(["-axo", "pid=,args="]).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    out.status.success().then(|| count_running(&String::from_utf8_lossy(&out.stdout), cli, std::process::id()))
}

/// The registry's `latest` version of the CLI's package.
pub fn latest(src: &Source, cli: Cli, timeout: Duration) -> Result<Version, String> {
    #[derive(serde::Deserialize)]
    struct Latest {
        version: String,
    }
    let agent = src.agent_with(Some(timeout));
    let mut resp = super::get(&agent, &format!("{}{}/latest", src.registry, cli.package()), "application/json")?;
    let body = super::read_limited(&mut resp, super::MAX_JSON)?;
    let l: Latest = serde_json::from_slice(&body).map_err(|_| "The registry's answer wasn't a version.".to_string())?;
    Version::parse(&l.version).ok_or_else(|| "The registry's answer wasn't a version.".into())
}

/// Where the CLI is and what it reports.
#[derive(Debug, Clone)]
pub struct Probe {
    pub bin: PathBuf,
    pub method: Method,
    /// `None`: it didn't answer `--version`.
    pub version: Option<Version>,
    pub error: Option<String>,
}

/// Finds the CLI (in `dir` only, when given: the tests' stand-ins) and asks its version. `None`: not installed.
pub fn probe(cli: Cli, dir: Option<&Path>) -> Option<Probe> {
    let bin = match dir {
        Some(d) => Some(d.join(cli.bin())).filter(|p| p.is_file()),
        None => crate::env::which(cli.bin()),
    }?;
    let real = std::fs::canonicalize(&bin).unwrap_or_else(|_| bin.clone());
    let st = crate::prefs::clis::check_path(cli.id(), &bin);
    Some(Probe { method: detect(cli, &real), version: st.version.as_deref().and_then(parse_version), error: st.error, bin })
}

/// The last few lines of what a command printed, for an error message.
fn tail(s: &str) -> String {
    let lines: Vec<&str> = s.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines[lines.len().saturating_sub(3)..].join(" · ").chars().take(300).collect()
}

/// Runs an update command with stdin closed; the whole process group is killed after `timeout`.
pub fn run(plan: &Plan, timeout: Duration) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let argv = plan.argv.as_ref().ok_or("This update has to be run by hand.")?;
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    for (k, v) in &plan.env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't run `{}`: {e}", plan.shown))?;
    let pid = child.id() as libc::pid_t;
    let pipe = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut s = Vec::new();
            if let Some(r) = r {
                let _ = r.take(1 << 20).read_to_end(&mut s);
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
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                // SAFETY: signalling the group this child leads.
                unsafe { libc::killpg(pid, libc::SIGKILL) };
                let _ = child.wait();
                return Err(format!("`{}` didn't finish within {} minutes and was stopped.", plan.shown, timeout.as_secs() / 60));
            }
        }
    };
    let (out, err) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
    if status.success() {
        Ok(())
    } else {
        let detail = tail(if err.trim().is_empty() { &out } else { &err });
        Err(if detail.is_empty() { format!("`{}` failed.", plan.shown) } else { format!("`{}` failed: {detail}", plan.shown) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_of_both_clis() {
        assert_eq!(parse_version("2.1.329 (Claude Code)\n").unwrap().to_string(), "2.1.329");
        assert_eq!(parse_version("codex-cli 0.145.0\n").unwrap().to_string(), "0.145.0");
        assert_eq!(parse_version("codex-cli 0.46.0-alpha.3").unwrap().to_string(), "0.46.0-alpha.3");
        assert!(parse_version("command not found").is_none());
        assert!(parse_version("codex-cli 0.171.0").unwrap() > parse_version("codex-cli 0.145.0").unwrap());
    }

    #[test]
    fn install_methods() {
        let p = |s: &str| PathBuf::from(s);
        assert_eq!(detect(Cli::Claude, &p("/Users/a/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe")), Method::Npm { prefix: p("/Users/a/.npm-global") });
        assert_eq!(detect(Cli::Claude, &p("/Users/a/.local/share/claude/versions/2.1.329")), Method::Native);
        assert_eq!(detect(Cli::Claude, &p("/opt/homebrew/Caskroom/claude-code/2.1.0/claude")), Method::Brew);
        assert_eq!(detect(Cli::Claude, &p("/usr/local/bin/claude")), Method::Unknown);
        assert_eq!(detect(Cli::Codex, &p("/Users/a/.codex/packages/standalone/releases/0.145.0-aarch64-apple-darwin/bin/codex")), Method::Standalone);
        assert_eq!(detect(Cli::Codex, &p("/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js")), Method::Npm { prefix: p("/opt/homebrew") });
        assert_eq!(detect(Cli::Codex, &p("/opt/homebrew/Caskroom/codex/0.171.0/codex-aarch64-apple-darwin")), Method::Brew);
        // Claude's npm path is not Codex's.
        assert_eq!(detect(Cli::Codex, &p("/x/lib/node_modules/@anthropic-ai/claude-code/cli.js")), Method::Unknown);
    }

    #[test]
    fn plans_per_method() {
        let bin = Path::new("/x/codex");
        let tmp = std::env::temp_dir().join(format!("coool-cli-plan-{}", std::process::id()));
        std::fs::create_dir_all(tmp.join("lib/node_modules")).unwrap();
        let npm = Path::new("/usr/local/bin/npm");
        let p = plan(Cli::Claude, &Method::Npm { prefix: tmp.clone() }, bin, "2.2.0", Some(npm));
        assert_eq!(p.argv.unwrap().iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>(), ["/usr/local/bin/npm", "install", "-g", "--prefix", &tmp.to_string_lossy(), "@anthropic-ai/claude-code@2.2.0"]);
        assert!(plan(Cli::Claude, &Method::Npm { prefix: tmp.clone() }, bin, "2.2.0", None).argv.is_none(), "no npm");
        let ro = plan(Cli::Codex, &Method::Npm { prefix: PathBuf::from("/nonexistent-prefix") }, bin, "1.0.0", Some(npm));
        assert!(ro.argv.is_none() && ro.manual.is_some() && ro.shown == "npm install -g @openai/codex@latest");
        let s = plan(Cli::Codex, &Method::Standalone, bin, "1.0.0", None);
        assert_eq!(s.argv.unwrap(), vec![OsString::from("/x/codex"), "update".into()]);
        assert_eq!(s.env, vec![("CODEX_NON_INTERACTIVE", "1")]);
        assert!(plan(Cli::Claude, &Method::Native, bin, "1.0.0", None).argv.is_some());
        let b = plan(Cli::Codex, &Method::Brew, bin, "1.0.0", None);
        assert!(b.argv.is_none() && b.shown == "brew upgrade --cask codex");
        let u = plan(Cli::Claude, &Method::Unknown, bin, "1.0.0", None);
        assert!(u.argv.is_none() && u.shown == "claude update");
        assert_eq!(repair(Cli::Claude, &Method::Npm { prefix: tmp.clone() }), "npm install -g @anthropic-ai/claude-code@latest");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn running_processes_are_counted() {
        let ps = "\
  101 /Users/a/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --resume x
  102 claude
  103 node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js
  104 /Users/a/.local/bin/codex resume 123
  105 /Users/a/.codex/packages/standalone/releases/0.145.0/bin/codex-code-mode-host
  106 /Applications/coool.app/Contents/MacOS/coool
  107 /bin/zsh -l
  108 vim claude-notes.md
  109 /bin/sh /tmp/fake/codex --version
  110 grep codex
";
        assert_eq!(count_running(ps, Cli::Claude, 0), 3);
        assert_eq!(count_running(ps, Cli::Codex, 0), 3);
        assert_eq!(count_running(ps, Cli::Codex, 104), 2, "skips itself");
        assert_eq!(count_running("", Cli::Claude, 0), 0);
    }

    #[test]
    fn run_reports_failures_and_timeouts() {
        let sh = |script: &str| Plan { argv: Some(vec!["/bin/sh".into(), "-c".into(), script.into()]), env: vec![("X_UPD", "1")], shown: "fake update".into(), manual: None };
        assert!(run(&sh("test \"$X_UPD\" = 1"), Duration::from_secs(5)).is_ok());
        let e = run(&sh("echo boom >&2; exit 3"), Duration::from_secs(5)).unwrap_err();
        assert!(e.contains("boom"), "{e}");
        let t0 = Instant::now();
        let e = run(&sh("sleep 30"), Duration::from_millis(300)).unwrap_err();
        assert!(e.contains("didn't finish") && t0.elapsed() < Duration::from_secs(5), "{e}");
        assert!(run(&Plan { argv: None, env: vec![], shown: "x".into(), manual: Some("y".into()) }, Duration::from_secs(1)).is_err());
    }
}
