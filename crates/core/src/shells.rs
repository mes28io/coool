//! Background shells: the commands a live session is running in the
//! background (or has been running in the foreground for a while), found in
//! the process tree under the session's CLI process.
//!
//! - **Which processes.** Claude Code runs every Bash tool call as a direct
//!   child `zsh -c 'source <snapshot> … && eval '<cmd>' < /dev/null && pwd -P >| /tmp/claude-…-cwd'`.
//!   That wrapper is the main positive signal ([`wrapper_command`]); the real
//!   command is the `eval` word. Codex runs its commands as `zsh -lc '<cmd>'`
//!   (or `bash -c`) under the codex process: any other `<shell> -c <cmd>` child
//!   counts too ([`classify`]). Everything else under the CLI is its own
//!   helpers and is skipped; [`HELPERS`] names the known ones.
//! - **When it counts.** A wrapper that is still alive after [`MIN_AGE`]
//!   (quick foreground commands never flicker in), or at once when the
//!   transcript marks its call `run_in_background`.
//! - **From the transcript** (Claude only): the Bash call's `description` and
//!   its background output file, matched by command text and start time
//!   ([`match_calls`]). The last lines of that file are read from its tail
//!   (at most [`TAIL_BYTES`]), only for the sessions the UI says are on
//!   screen ([`Shells::set_focus`]), and only for a path a transcript named as
//!   Bash background output ([`output_path_ok`]). Nothing else is read.
//! - **Cost.** One pass over the session processes' children per
//!   [`SCAN_EVERY`] (a handful of `proc_pidinfo` calls on macOS, `/proc` reads
//!   on Linux; no external commands). Between passes the last answer is reused.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant, SystemTime};

/// A foreground command shows once it has run this long.
pub const MIN_AGE: Duration = Duration::from_secs(3);
/// The process tree is walked at most this often.
pub const SCAN_EVERY: Duration = Duration::from_secs(1);
/// Bytes read from the end of an output file.
pub const TAIL_BYTES: u64 = 4096;
/// Output lines kept per shell.
pub const TAIL_LINES: usize = 3;
/// A poll loop at ~0% CPU this long is tagged "idle loop".
pub const IDLE_AFTER: Duration = Duration::from_secs(45);
/// Descendants looked at under one shell (for its CPU), and depth walked.
const MAX_TREE: usize = 64;
const MAX_DEPTH: usize = 8;

/// One background shell of a live session.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Shell {
    /// The wrapper shell's pid (what Stop signals, with its process group).
    pub pid: u32,
    /// The command as the agent wrote it (the wrapper's `eval` word).
    pub command: String,
    /// The Bash call's `description`, when the transcript call was matched.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Process start, epoch ms (elapsed = now - started).
    pub started: u64,
    /// CPU % of the shell and everything under it (integer; only moves by a few points at a time).
    pub cpu: u32,
    /// Background output file the transcript named, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// Last lines of `output` (only while the session is on screen).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tail: Vec<String>,
    /// A `sleep` / `until` poll loop that has sat at ~0% CPU for a while.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub idle_loop: bool,
    /// The transcript marks the call `run_in_background` (else: a long foreground command).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub background: bool,
}

/// A Bash tool call as the transcript records it (see `claude::ParseState`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct BashCall {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub background: bool,
    /// When the call was made, epoch ms (0 = unknown).
    #[serde(default)]
    pub at: u64,
    /// "Output is being written to: <path>" from its tool_result.
    #[serde(default)]
    pub output: Option<String>,
    /// A foreground call that returned: its process is gone.
    #[serde(default)]
    pub done: bool,
}

/// Calls kept per transcript, per kind (background ones are kept apart so a
/// long-running one is not pushed out by a burst of quick commands).
pub const KEEP_CALLS: usize = 32;

/// Appends a call, keeping the newest [`KEEP_CALLS`] of its kind.
pub fn push_call(list: &mut Vec<BashCall>, c: BashCall) {
    let bg = c.background;
    list.push(c);
    let n = list.iter().filter(|x| x.background == bg).count();
    if n > KEEP_CALLS
        && let Some(i) = list.iter().position(|x| x.background == bg)
    {
        list.remove(i);
    }
}

/// The path in a Bash tool_result such as "Command running in background with
/// ID: x. Output is being written to: /private/tmp/…/tasks/x.output. You will be notified …".
pub fn output_from_result(text: &str) -> Option<String> {
    let rest = text.split("Output is being written to:").nth(1)?.trim_start();
    let p = rest.split_whitespace().next()?.trim_end_matches(['.', ',', ';']);
    // Put the ".output" back if the sentence's period was the only dot after it.
    let p = if p.ends_with(".output") || !rest.starts_with(&format!("{p}.output")) { p.to_string() } else { format!("{p}.output") };
    output_path_ok(&p).then_some(p)
}

/// Only a Claude Code background-task output file is ever read: an absolute
/// `…/tasks/<id>.output` under the CLI's temp folder (`/tmp/claude-<uid>/` or
/// `/private/tmp/claude-<uid>/`), no `..`. Symlinks are refused when reading.
pub fn output_path_ok(p: &str) -> bool {
    let under_tmp = p.starts_with("/private/tmp/claude-") || p.starts_with("/tmp/claude-");
    under_tmp && p.ends_with(".output") && p.contains("/tasks/") && !p.split('/').any(|c| c == "..") && !p.contains('\0')
}

// ---------- telling shells from helpers ----------

/// What a child process of a CLI is.
#[derive(Debug, PartialEq, Eq)]
pub enum Class {
    /// A command the agent runs; the real command inside the wrapper.
    Shell(String),
    /// One of the CLI's own helpers; not a shell, not walked into.
    Helper,
    /// Something else: not listed, but walked into (e.g. Codex's native binary under its launcher).
    Other,
}

/// Known helpers the CLIs run next to the agent's commands: never shells.
/// (Shells are recognised positively, by their wrapper; this list keeps a
/// helper out even when it happens to be started through `sh -c`.)
/// Matched against the program name and, for `mcp`, anywhere in the command line.
pub const HELPERS: &[&str] = &[
    // Keeps the Mac awake while the CLI works.
    "caffeinate",
    // The CLIs themselves (a nested `claude -p` is a child *session*, listed on its own).
    "claude",
    "codex",
    // Language servers the CLIs start for code intelligence.
    "rust-analyzer",
    "typescript-language-server",
    "tsserver",
    "gopls",
    "pyright",
    "pyright-langserver",
    "sourcekit-lsp",
    "clangd",
    "jdtls",
];

fn base(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

/// MCP servers: `npm exec @x/mcp-server-y`, `npx … mcp`, `uvx mcp-…`,
/// `node …/mcp-server-…`, anything whose command line says "mcp"; plus the
/// programs named in the session's `.mcp.json` (`extra`).
fn is_helper(args: &[String], extra: &HashSet<String>) -> bool {
    let Some(prog) = args.first().map(|a| base(a)) else { return true };
    if HELPERS.contains(&prog) || prog.ends_with("-language-server") || prog.ends_with("-lsp") || extra.contains(prog) {
        return true;
    }
    let line = args.join(" ").to_ascii_lowercase();
    line.contains("mcp") || line.contains("language-server") || line.contains("--stdio")
}

const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "fish", "ksh"];

/// Classifies a CLI's child by its argv.
pub fn classify(args: &[String], extra_helpers: &HashSet<String>) -> Class {
    let Some(prog) = args.first() else { return Class::Helper };
    let prog = base(prog).trim_start_matches('-');
    if SHELLS.contains(&prog) && args.len() >= 3 && matches!(args[1].as_str(), "-c" | "-lc" | "-ic" | "-cl") {
        let script = &args[2];
        if let Some(cmd) = wrapper_command(script) {
            return Class::Shell(cmd);
        }
        // A plain `<shell> -c <cmd>` (Codex's exec): a shell unless it starts a helper.
        let words: Vec<String> = script.split_whitespace().map(str::to_string).collect();
        if is_helper(&words, extra_helpers) {
            return Class::Helper;
        }
        return Class::Shell(script.trim().to_string());
    }
    if is_helper(args, extra_helpers) { Class::Helper } else { Class::Other }
}

/// The command inside Claude Code's Bash wrapper, or None if `script` isn't one:
/// `source <…/shell-snapshots/snapshot-…> … && eval '<cmd>' < /dev/null && pwd -P >| /tmp/claude-…-cwd`.
pub fn wrapper_command(script: &str) -> Option<String> {
    let s = script.trim_start();
    if !s.starts_with("source ") || !s.contains("shell-snapshots/snapshot-") {
        return None;
    }
    // The setup before it never contains "eval " (aliases are removed with `\builtin`).
    let at = s.find("&& eval ")? + "&& eval ".len();
    let (word, _) = shell_word(&s[at..])?;
    let word = word.trim();
    (!word.is_empty()).then(|| word.to_string())
}

/// Reads one shell word (adjacent `'…'`, `"…"`, `\x` and bare runs, as in
/// `'it'"'"'s'` or `'it'\''s'`) from the start of `s`. Returns it and the rest.
pub fn shell_word(s: &str) -> Option<(String, &str)> {
    let mut out = String::new();
    let mut it = s.char_indices().peekable();
    let mut any = false;
    while let Some(&(i, c)) = it.peek() {
        match c {
            '\'' => {
                it.next();
                loop {
                    let (_, c) = it.next()?;
                    if c == '\'' {
                        break;
                    }
                    out.push(c);
                }
            }
            '"' => {
                it.next();
                loop {
                    let (_, c) = it.next()?;
                    match c {
                        '"' => break,
                        '\\' => {
                            let (_, n) = it.next()?;
                            if !matches!(n, '"' | '\\' | '$' | '`' | '\n') {
                                out.push('\\');
                            }
                            if n != '\n' {
                                out.push(n);
                            }
                        }
                        _ => out.push(c),
                    }
                }
            }
            '\\' => {
                it.next();
                let (_, n) = it.next()?;
                out.push(n);
            }
            c if c.is_whitespace() => return any.then(|| (out, &s[i..])),
            _ => {
                it.next();
                out.push(c);
            }
        }
        any = true;
    }
    any.then_some((out, ""))
}

/// `until …; do sleep 5; done`, `while …; sleep …`: a loop that mostly waits.
pub fn is_poll_loop(cmd: &str) -> bool {
    let has = |w: &str| cmd.split(|c: char| !c.is_ascii_alphanumeric() && c != '_').any(|t| t == w);
    has("sleep") && (has("until") || has("while") || has("for"))
}

// ---------- matching processes to transcript calls ----------

/// A shell process as found, before the transcript is consulted.
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub pid: u32,
    pub command: String,
    pub started: u64,
}

/// A command as compared: whitespace collapsed, and a leading `cd <dir> &&`
/// dropped (Claude Code strips a `cd` into the session's own folder before running it).
fn norm_command(s: &str) -> String {
    let mut t = s.trim();
    if let Some(rest) = t.strip_prefix("cd ")
        && let Some((_, after)) = shell_word(rest.trim_start())
        && let Some(after) = after.trim_start().strip_prefix("&&")
    {
        t = after.trim_start();
    }
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// For each found process, the index of its transcript call (or None).
/// Same command text ([`norm_command`]) first; among those, a call made
/// before the process started (allowing 5 s of clock skew), foreground calls
/// that already returned excluded, closest in time first. Each call is used once.
pub fn match_calls(found: &[Found], calls: &[BashCall]) -> Vec<Option<usize>> {
    let norm = norm_command;
    let mut used = vec![false; calls.len()];
    let mut order: Vec<usize> = (0..found.len()).collect();
    order.sort_by_key(|&i| found[i].started);
    let mut out = vec![None; found.len()];
    for i in order {
        let f = &found[i];
        let cmd = norm(&f.command);
        let best = calls
            .iter()
            .enumerate()
            .filter(|(j, c)| !used[*j] && !c.done && norm(&c.command) == cmd)
            .filter(|(_, c)| c.at == 0 || c.at <= f.started + 5_000)
            .min_by_key(|(_, c)| if c.at == 0 { u64::MAX } else { f.started.saturating_sub(c.at) });
        if let Some((j, _)) = best {
            used[j] = true;
            out[i] = Some(j);
        }
    }
    out
}

// ---------- output tails ----------

/// Strips ANSI escapes and carriage-return redraws from one line.
fn clean_line(l: &str) -> String {
    let l = l.rsplit('\r').find(|p| !p.trim().is_empty()).unwrap_or("");
    let mut out = String::with_capacity(l.len());
    let mut it = l.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' {
            if it.peek() == Some(&'[') {
                it.next();
                // CSI: parameters, then one final byte in @..~
                for n in it.by_ref() {
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            } else {
                it.next();
            }
            continue;
        }
        if !c.is_control() || c == '\t' {
            out.push(c);
        }
    }
    crate::util::truncate(out.trim_end(), 300)
}

/// The last [`TAIL_LINES`] non-empty lines of `bytes` (a file's tail; a cut
/// first line is dropped unless it is all there is).
pub fn last_lines(bytes: &[u8], from_start: bool) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    let mut lines: Vec<&str> = text.split('\n').collect();
    if !from_start && lines.len() > 1 {
        lines.remove(0);
    }
    let mut out: Vec<String> = lines.iter().rev().map(|l| clean_line(l)).filter(|l| !l.trim().is_empty()).take(TAIL_LINES).collect();
    out.reverse();
    out
}

/// Reads the end of a validated output file: at most [`TAIL_BYTES`], never through a symlink.
fn read_tail(path: &str) -> Option<(u64, SystemTime, Vec<String>)> {
    use std::io::{Read, Seek, SeekFrom};
    if !output_path_ok(path) {
        return None;
    }
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    let len = meta.len();
    let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let mut f = std::fs::File::open(path).ok()?;
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.take(TAIL_BYTES).read_to_end(&mut buf).ok()?;
    Some((len, mtime, last_lines(&buf, start == 0)))
}

// ---------- process table ----------

/// What the scan needs to know about one process.
#[derive(Clone, Debug)]
pub struct Proc {
    pub pid: u32,
    pub pgid: u32,
    pub start_ms: u64,
    pub args: Vec<String>,
    /// Total CPU time so far, ns.
    pub cpu_ns: u64,
}

pub mod sys {
    //! Reading processes, no external commands. macOS: `proc_listchildpids`,
    //! `proc_pidinfo`, `sysctl(KERN_PROCARGS2)`. Linux: `/proc`.
    use super::Proc;

    #[cfg(target_os = "macos")]
    pub fn children(pid: u32) -> Vec<u32> {
        let Some(p) = crate::util::valid_pid(pid) else { return Vec::new() };
        let mut buf = vec![0 as libc::pid_t; 512];
        // SAFETY: the buffer is `buf.len()` pids long; the call writes at most that many bytes.
        let n = unsafe { libc::proc_listchildpids(p, buf.as_mut_ptr() as *mut libc::c_void, (buf.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int) };
        if n <= 0 {
            return Vec::new();
        }
        buf.truncate((n as usize).min(buf.len()));
        buf.into_iter().filter(|&c| c > 0).map(|c| c as u32).collect()
    }

    #[cfg(target_os = "macos")]
    pub fn info(pid: u32) -> Option<Proc> {
        let p = crate::util::valid_pid(pid)?;
        // SAFETY: proc_pidinfo writes at most `size` bytes into the zeroed structs we own.
        let (bsd, task) = unsafe {
            let mut bsd: libc::proc_bsdinfo = std::mem::zeroed();
            let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
            if libc::proc_pidinfo(p, libc::PROC_PIDTBSDINFO, 0, &mut bsd as *mut _ as *mut libc::c_void, size) != size {
                return None;
            }
            let mut task: libc::proc_taskinfo = std::mem::zeroed();
            let tsize = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
            let ok = libc::proc_pidinfo(p, libc::PROC_PIDTASKINFO, 0, &mut task as *mut _ as *mut libc::c_void, tsize) == tsize;
            (bsd, ok.then_some(task))
        };
        let cpu_ticks = task.map(|t| t.pti_total_user + t.pti_total_system).unwrap_or(0);
        Some(Proc {
            pid,
            pgid: bsd.pbi_pgid,
            start_ms: bsd.pbi_start_tvsec * 1000 + bsd.pbi_start_tvusec / 1000,
            args: args(p).unwrap_or_default(),
            cpu_ns: ticks_to_ns(cpu_ticks),
        })
    }

    #[cfg(target_os = "macos")]
    fn ticks_to_ns(t: u64) -> u64 {
        #[repr(C)]
        struct Timebase {
            numer: u32,
            denom: u32,
        }
        unsafe extern "C" {
            fn mach_timebase_info(info: *mut Timebase) -> libc::c_int;
        }
        static TB: std::sync::OnceLock<(u64, u64)> = std::sync::OnceLock::new();
        let (n, d) = *TB.get_or_init(|| {
            let mut tb = Timebase { numer: 1, denom: 1 };
            // SAFETY: writes the two fields of the struct we own.
            if unsafe { mach_timebase_info(&mut tb) } != 0 || tb.denom == 0 {
                return (1, 1);
            }
            (tb.numer as u64, tb.denom as u64)
        });
        (t as u128 * n as u128 / d as u128) as u64
    }

    /// argv from `KERN_PROCARGS2`: argc, the exec path, padding, then argc strings.
    #[cfg(target_os = "macos")]
    fn args(pid: libc::pid_t) -> Option<Vec<String>> {
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
        let mut size: libc::size_t = 0;
        // SAFETY: a size query (null buffer), then a read into a buffer of that size.
        unsafe {
            if libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) != 0 || size < 4 {
                return None;
            }
            let mut buf = vec![0u8; size];
            if libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr() as *mut libc::c_void, &mut size, std::ptr::null_mut(), 0) != 0 {
                return None;
            }
            buf.truncate(size);
            parse_procargs(&buf)
        }
    }

    /// Parses a `KERN_PROCARGS2` buffer (pub for tests).
    pub fn parse_procargs(buf: &[u8]) -> Option<Vec<String>> {
        let argc = i32::from_ne_bytes(buf.get(..4)?.try_into().ok()?);
        if argc <= 0 {
            return None;
        }
        let mut rest = &buf[4..];
        // Exec path, then NUL padding.
        let end = rest.iter().position(|&b| b == 0)?;
        rest = &rest[end..];
        let start = rest.iter().position(|&b| b != 0)?;
        rest = &rest[start..];
        let mut out = Vec::with_capacity(argc as usize);
        for part in rest.split(|&b| b == 0).take(argc as usize) {
            out.push(String::from_utf8_lossy(part).into_owned());
        }
        Some(out)
    }

    #[cfg(target_os = "linux")]
    pub fn children(pid: u32) -> Vec<u32> {
        std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))
            .map(|s| s.split_whitespace().filter_map(|t| t.parse().ok()).collect())
            .unwrap_or_default()
    }

    #[cfg(target_os = "linux")]
    pub fn info(pid: u32) -> Option<Proc> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let f: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
        // After comm: state(0) ppid(1) pgrp(2) … utime(11) stime(12).
        let pgid = f.get(2)?.parse().ok()?;
        let ticks: u64 = f.get(11)?.parse::<u64>().ok()? + f.get(12)?.parse::<u64>().ok()?;
        // SAFETY: sysconf has no preconditions.
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as u64;
        let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
        let args = cmdline.split(|&b| b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned()).collect();
        Some(Proc { pid, pgid, start_ms: crate::util::process_start_ms(pid)?, args, cpu_ns: ticks * 1_000_000_000 / hz })
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    pub fn children(_: u32) -> Vec<u32> {
        Vec::new()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    pub fn info(_: u32) -> Option<Proc> {
        None
    }
}

/// `pid` and everything under it (bounded), not crossing into `stop` pids.
fn subtree(pid: u32, stop: &HashSet<u32>) -> Vec<u32> {
    let mut out = vec![pid];
    let mut frontier = vec![pid];
    for _ in 0..MAX_DEPTH {
        let mut next = Vec::new();
        for p in frontier {
            for c in sys::children(p) {
                if out.len() >= MAX_TREE {
                    return out;
                }
                if !stop.contains(&c) && !out.contains(&c) {
                    out.push(c);
                    next.push(c);
                }
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    out
}

/// The shell processes under one session process: its children (and, through
/// unlisted intermediate processes, grandchildren), not inside other sessions.
fn shells_under(root: u32, sessions: &HashSet<u32>, helpers: &HashSet<String>) -> Vec<(Proc, String)> {
    let mut out = Vec::new();
    let mut frontier = vec![root];
    for _ in 0..3 {
        let mut next = Vec::new();
        for p in frontier {
            for c in sys::children(p) {
                if sessions.contains(&c) {
                    continue;
                }
                let Some(info) = sys::info(c) else { continue };
                match classify(&info.args, helpers) {
                    Class::Shell(cmd) => out.push((info, cmd)),
                    Class::Helper => {}
                    Class::Other => next.push(c),
                }
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    out
}

/// Program names from a project's `.mcp.json` (`mcpServers.*.command`).
fn mcp_commands(cwd: &str) -> HashSet<String> {
    let p = std::path::Path::new(cwd).join(".mcp.json");
    let Some(v) = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) else { return HashSet::new() };
    v["mcpServers"].as_object().map(|m| m.values().filter_map(|s| s["command"].as_str()).map(|c| base(c).to_string()).collect()).unwrap_or_default()
}

// ---------- the scanner the Hub keeps ----------

/// One shell as last seen, with the bookkeeping that spans scans.
struct Seen {
    shell: Shell,
    /// The session pid it is under, and that process's group.
    session_pid: u32,
    session_pgid: u32,
    pgid: u32,
    /// Per pid in its subtree: CPU ns at the last scan.
    cpu: HashMap<u32, u64>,
    low_since: Option<Instant>,
    tail_key: Option<(u64, SystemTime)>,
}

/// What a live session contributes to a scan.
pub struct Target<'a> {
    pub id: &'a str,
    pub pid: u32,
    pub cwd: &'a str,
    pub calls: Vec<BashCall>,
}

#[derive(Default)]
pub struct Shells {
    last: Option<Instant>,
    /// (pid, start ms) -> state.
    seen: HashMap<(u32, u64), Seen>,
    /// Session ids whose shells get output tails.
    focus: HashSet<String>,
    /// cwd -> MCP program names, re-read at most once a minute.
    mcp: HashMap<String, (Instant, HashSet<String>)>,
}

impl Shells {
    /// Sessions on screen: only their shells get output tails.
    pub fn set_focus(&mut self, ids: impl IntoIterator<Item = String>) {
        let next: HashSet<String> = ids.into_iter().collect();
        if next != self.focus {
            self.focus = next;
            self.last = None;
        }
    }

    /// Whether the next [`Shells::scan`] walks the process tree (else `targets` is unused).
    pub fn due(&self) -> bool {
        self.last.is_none_or(|t| t.elapsed() >= SCAN_EVERY)
    }

    /// Shells per session pid. Walks the process tree when the last walk is
    /// older than [`SCAN_EVERY`] (or `force`), else returns the last answer.
    pub fn scan(&mut self, targets: &[Target], force: bool) -> HashMap<u32, Vec<Shell>> {
        let now = Instant::now();
        if force || self.last.is_none_or(|t| now.duration_since(t) >= SCAN_EVERY) {
            self.walk(targets, now);
            self.last = Some(now);
        }
        let mut out: HashMap<u32, Vec<Shell>> = HashMap::new();
        for s in self.seen.values() {
            out.entry(s.session_pid).or_default().push(s.shell.clone());
        }
        for v in out.values_mut() {
            v.sort_by_key(|s| (s.started, s.pid));
        }
        out
    }

    fn walk(&mut self, targets: &[Target], now: Instant) {
        let wall_ms = |t: Instant| t.duration_since(self.last.unwrap_or(t)).as_millis() as u64;
        let dt_ms = wall_ms(now);
        let epoch_now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let session_pids: HashSet<u32> = targets.iter().map(|t| t.pid).collect();
        let mut alive: HashSet<(u32, u64)> = HashSet::new();
        for t in targets {
            let helpers = match self.mcp.get(t.cwd) {
                Some((at, h)) if now.duration_since(*at) < Duration::from_secs(60) => h.clone(),
                _ => {
                    let h = mcp_commands(t.cwd);
                    self.mcp.insert(t.cwd.to_string(), (now, h.clone()));
                    h
                }
            };
            let session_pgid = sys::info(t.pid).map(|p| p.pgid).unwrap_or(0);
            let procs = shells_under(t.pid, &session_pids, &helpers);
            let found: Vec<Found> = procs.iter().map(|(p, cmd)| Found { pid: p.pid, command: cmd.clone(), started: p.start_ms }).collect();
            let matched = match_calls(&found, &t.calls);
            for ((p, cmd), m) in procs.into_iter().zip(matched) {
                let call = m.map(|j| &t.calls[j]);
                let background = call.is_some_and(|c| c.background);
                let age = epoch_now.saturating_sub(p.start_ms);
                if !background && age < MIN_AGE.as_millis() as u64 {
                    continue;
                }
                let key = (p.pid, p.start_ms);
                alive.insert(key);
                let e = self.seen.entry(key).or_insert_with(|| Seen {
                    shell: Shell { pid: p.pid, command: cmd.clone(), description: None, started: p.start_ms, cpu: 0, output: None, tail: Vec::new(), idle_loop: false, background: false },
                    session_pid: t.pid,
                    session_pgid,
                    pgid: p.pgid,
                    cpu: HashMap::new(),
                    low_since: None,
                    tail_key: None,
                });
                e.session_pid = t.pid;
                e.session_pgid = session_pgid;
                e.pgid = p.pgid;
                e.shell.command = cmd;
                e.shell.description = call.and_then(|c| c.description.clone()).filter(|d| !d.trim().is_empty());
                e.shell.output = call.and_then(|c| c.output.clone()).filter(|o| output_path_ok(o));
                e.shell.background = background;

                // CPU over the shell and everything under it, since the last walk.
                let tree = subtree(p.pid, &session_pids);
                let mut used_ns = 0u64;
                let mut next_cpu = HashMap::new();
                let fresh = e.cpu.is_empty();
                for q in tree {
                    let Some(info) = (if q == p.pid { Some(p.clone()) } else { sys::info(q) }) else { continue };
                    let prev = e.cpu.get(&q).copied();
                    used_ns += match prev {
                        Some(c) => info.cpu_ns.saturating_sub(c),
                        // New since the last walk: all of its time falls in this interval.
                        None if !fresh && info.start_ms + dt_ms >= epoch_now => info.cpu_ns,
                        None => 0,
                    };
                    next_cpu.insert(q, info.cpu_ns);
                }
                e.cpu = next_cpu;
                let pct = if fresh || dt_ms == 0 {
                    // First sight: the lifetime average of the shell itself.
                    (p.cpu_ns / 1_000_000).saturating_mul(100).checked_div(age.max(1)).unwrap_or(0)
                } else {
                    (used_ns / 1_000_000).saturating_mul(100) / dt_ms
                } as u32;
                // Small wobbles don't count as a change (keeps deltas quiet).
                let old = e.shell.cpu;
                if fresh || pct.abs_diff(old) >= 5 || (pct == 0) != (old == 0) {
                    e.shell.cpu = pct;
                }
                if pct == 0 {
                    e.low_since.get_or_insert(now);
                } else {
                    e.low_since = None;
                }
                e.shell.idle_loop = is_poll_loop(&e.shell.command) && e.low_since.is_some_and(|t| now.duration_since(t) >= IDLE_AFTER);

                // Output tail: on-screen sessions only, re-read when the file changed.
                match (&e.shell.output, self.focus.contains(t.id)) {
                    (Some(path), true) => {
                        let st = std::fs::symlink_metadata(path).ok().map(|m| (m.len(), m.modified().unwrap_or(SystemTime::UNIX_EPOCH)));
                        if st.is_some() && st != e.tail_key
                            && let Some((len, mtime, lines)) = read_tail(path)
                        {
                            e.tail_key = Some((len, mtime));
                            e.shell.tail = lines;
                        }
                    }
                    _ => {
                        e.tail_key = None;
                        e.shell.tail.clear();
                    }
                }
            }
        }
        self.seen.retain(|k, _| alive.contains(k));
        self.mcp.retain(|cwd, _| targets.iter().any(|t| t.cwd == cwd));
    }

    /// For Stop: re-scans now and, if `pid` is one of the shells listed for a
    /// live session, returns what to signal: its own process group when it has
    /// one (not the session's), else the pid alone.
    pub fn verify(&mut self, targets: &[Target], pid: u32) -> Option<StopTarget> {
        self.scan(targets, true);
        let s = self.seen.values().find(|s| s.shell.pid == pid)?;
        if session_pids_contain(targets, pid) {
            return None;
        }
        let group = s.pgid == pid && s.pgid != s.session_pgid && s.pgid > 1;
        Some(StopTarget { pid, start_ms: s.shell.started, group })
    }
}

fn session_pids_contain(targets: &[Target], pid: u32) -> bool {
    targets.iter().any(|t| t.pid == pid)
}

/// What [`stop`] signals.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StopTarget {
    pub pid: u32,
    /// Process start (ms) seen at verification: the SIGKILL follow-up is only
    /// sent if the pid still names that same process.
    pub start_ms: u64,
    /// Signal the process group `pid` leads (the wrapper and everything it started).
    pub group: bool,
}

/// SIGTERM now, SIGKILL after `grace` if the same process is still there.
#[cfg(unix)]
pub fn stop(t: StopTarget, grace: Duration) -> std::io::Result<()> {
    let p = crate::util::valid_pid(t.pid).ok_or_else(|| std::io::Error::other("refusing to signal that pid"))?;
    let target = if t.group { -p } else { p };
    // SAFETY: `p` > 1, so `target` names exactly that process or the group it leads.
    if unsafe { libc::kill(target, libc::SIGTERM) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    std::thread::spawn(move || {
        std::thread::sleep(grace);
        if crate::util::process_start_ms(t.pid) == Some(t.start_ms) || (t.group && group_alive(p)) {
            // SAFETY: as above; the start time check rules out a reused pid.
            unsafe { libc::kill(target, libc::SIGKILL) };
        }
    });
    Ok(())
}

#[cfg(unix)]
fn group_alive(pgid: libc::pid_t) -> bool {
    // SAFETY: signal 0 only checks that some process in the group exists.
    unsafe { libc::kill(-pgid, 0) == 0 }
}

#[cfg(not(unix))]
pub fn stop(_: StopTarget, _: Duration) -> std::io::Result<()> {
    Err(std::io::Error::other("stopping shells isn't supported on this platform yet"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    /// As Claude Code 2.1.325 runs a Bash call (captured from `ps`).
    const REAL: &str = r#"source /Users/u/.claude/shell-snapshots/snapshot-zsh-1794654012205-7m85n3.sh 2>/dev/null || true && \builtin setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL NO_BRACE_CCL NO_MAGIC_EQUAL_SUBST 2>/dev/null || true && { \builtin unalias -- 'which'; \builtin unset -f -- 'which'; } >/dev/null 2>&1 || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'ps -o command= -p $$ | head -c 3000; echo; echo ---; ps -Ao pid,ppid,command | awk '"'"'$2==33634'"'"' | cut -c1-200' < /dev/null && pwd -P >| /tmp/claude-1e69-cwd"#;

    #[test]
    fn extracts_the_command_from_the_bash_wrapper() {
        assert_eq!(wrapper_command(REAL).as_deref(), Some("ps -o command= -p $$ | head -c 3000; echo; echo ---; ps -Ao pid,ppid,command | awk '$2==33634' | cut -c1-200"));
        let w = |cmd: &str| format!("source /h/.claude/shell-snapshots/snapshot-zsh-1-x.sh 2>/dev/null || true && eval {cmd} < /dev/null && pwd -P >| /tmp/claude-ab-cwd");
        assert_eq!(wrapper_command(&w("'sleep 60'")).as_deref(), Some("sleep 60"));
        assert_eq!(wrapper_command(&w(r#"'echo it'\''s'"#)).as_deref(), Some("echo it's"));
        assert_eq!(wrapper_command(&w(r#"'a "b" $c'"#)).as_deref(), Some(r#"a "b" $c"#));
        assert_eq!(wrapper_command(&w("'until [ -f x ]; do\n  sleep 5\ndone'")).as_deref(), Some("until [ -f x ]; do\n  sleep 5\ndone"));
        // Not a wrapper: a plain script, an unterminated quote, an empty command.
        assert_eq!(wrapper_command("sleep 60"), None);
        assert_eq!(wrapper_command("source /etc/profile && eval 'x'"), None, "no shell snapshot");
        assert_eq!(wrapper_command(&w("'unterminated")), None);
        assert_eq!(wrapper_command(&w("''")), None);
    }

    #[test]
    fn shell_words() {
        assert_eq!(shell_word("'a b' rest"), Some(("a b".into(), " rest")));
        assert_eq!(shell_word(r#"a"b c"\ d e"#), Some(("ab c d".into(), " e")));
        assert_eq!(shell_word(r#""x\"y\$z\q""#), Some((r#"x"y$z\q"#.into(), "")));
        assert_eq!(shell_word(" leading"), None);
        assert_eq!(shell_word(""), None);
    }

    #[test]
    fn classifies_children_and_excludes_helpers() {
        let none = HashSet::new();
        let wrapper = v(&["/bin/zsh", "-c", REAL]);
        assert!(matches!(classify(&wrapper, &none), Class::Shell(c) if c.starts_with("ps -o")));
        // Codex: `zsh -lc <cmd>` / `bash -c <cmd>`.
        assert_eq!(classify(&v(&["/bin/zsh", "-lc", "cargo test"]), &none), Class::Shell("cargo test".into()));
        assert_eq!(classify(&v(&["bash", "-c", "sleep 60"]), &none), Class::Shell("sleep 60".into()));
        // The CLIs' own helpers (as seen under a live Claude session), never shells.
        assert_eq!(classify(&v(&["npm", "exec", "@supabase/mcp-server-supabase@latest", "--project-ref=x"]), &none), Class::Helper);
        assert_eq!(classify(&v(&["node", "/Users/u/.npm/_npx/53/node_modules/.bin/mcp-server-supabase", "--project-ref=x"]), &none), Class::Helper);
        assert_eq!(classify(&v(&["caffeinate", "-i", "-t", "300"]), &none), Class::Helper);
        assert_eq!(classify(&v(&["/usr/local/bin/claude", "-p", "hi"]), &none), Class::Helper);
        assert_eq!(classify(&v(&["rust-analyzer"]), &none), Class::Helper);
        assert_eq!(classify(&v(&["typescript-language-server", "--stdio"]), &none), Class::Helper);
        assert_eq!(classify(&v(&["uvx", "mcp-server-git"]), &none), Class::Helper);
        assert_eq!(classify(&v(&["sh", "-c", "npx -y @modelcontextprotocol/server-mcp-x"]), &none), Class::Helper, "a helper started through sh -c");
        assert_eq!(classify(&v(&[]), &none), Class::Helper);
        // Programs a project's .mcp.json starts.
        let mcp: HashSet<String> = ["my-tools".to_string()].into();
        assert_eq!(classify(&v(&["/opt/bin/my-tools", "serve"]), &mcp), Class::Helper);
        assert_eq!(classify(&v(&["sh", "-c", "my-tools serve"]), &mcp), Class::Helper);
        // Unknown processes are walked into, not listed (e.g. Codex's native binary).
        assert_eq!(classify(&v(&["/opt/codex/bin/codex-aarch64-apple-darwin"]), &none), Class::Other);
        assert_eq!(classify(&v(&["/opt/x/native-runner"]), &none), Class::Other);
        // A shell without -c is an interactive shell, not a command.
        assert_eq!(classify(&v(&["/bin/zsh", "-l"]), &none), Class::Other);
    }

    #[test]
    fn poll_loops() {
        assert!(is_poll_loop("until [ -s /tmp/t1.time ]; do sleep 5; done; cat /tmp/t1.time"));
        assert!(is_poll_loop("while true; do curl -s x; sleep 2; done"));
        assert!(!is_poll_loop("sleep 60"));
        assert!(!is_poll_loop("cargo build --release"));
        assert!(!is_poll_loop("until_ready.sh && sleepy"));
    }

    #[test]
    fn output_paths_from_results() {
        let r = "Command running in background with ID: bn70dqyyj. Output is being written to: /private/tmp/claude-501/-Users-x-p/c5e7/tasks/bn70dqyyj.output. You will be notified when it completes.";
        assert_eq!(output_from_result(r).as_deref(), Some("/private/tmp/claude-501/-Users-x-p/c5e7/tasks/bn70dqyyj.output"));
        assert_eq!(output_from_result("Output is being written to: /tmp/claude-501/p/s/tasks/a.output"), Some("/tmp/claude-501/p/s/tasks/a.output".into()));
        // Never anything else.
        assert_eq!(output_from_result("Output is being written to: /Users/x/.claude/.credentials.json."), None);
        assert_eq!(output_from_result("Output is being written to: /tmp/claude-501/../../etc/tasks/x.output"), None);
        assert_eq!(output_from_result("Output is being written to: ~/.ssh/tasks/id.output"), None);
        assert_eq!(output_from_result("done"), None);
        assert!(!output_path_ok("/private/tmp/claude-501/p/s/tasks/x.key"));
    }

    #[test]
    fn matches_calls_by_command_and_time() {
        let call = |id: &str, cmd: &str, at: u64, done: bool| BashCall { id: id.into(), command: cmd.into(), at, done, ..Default::default() };
        let calls = vec![
            call("old", "sleep 60", 1_000, true),
            call("a", "sleep 60", 10_000, false),
            call("b", "sleep 60", 20_000, false),
            call("c", "npm run dev", 30_000, false),
            call("future", "make", 900_000, false),
        ];
        let found = |pid: u32, cmd: &str, started: u64| Found { pid, command: cmd.into(), started };
        let got = match_calls(&[found(2, "sleep 60", 20_400), found(1, "sleep  60", 10_300), found(3, "npm run dev", 30_100), found(4, "make", 50_000), found(5, "ls", 1)], &calls);
        assert_eq!(got, vec![Some(2), Some(1), Some(3), None, None], "closest earlier call, each once; done and future calls never");
        // Claude Code drops a leading `cd <session folder> &&` before running a command.
        let cd = vec![call("cd", "cd /Users/x/p && CARGO_TARGET_DIR=/t cargo build -p x", 1_000, false)];
        assert_eq!(match_calls(&[found(1, "CARGO_TARGET_DIR=/t cargo build -p x", 1_200)], &cd), vec![Some(0)]);
        assert_eq!(match_calls(&[found(1, "cd /Users/x/p && CARGO_TARGET_DIR=/t cargo build -p x", 1_200)], &cd), vec![Some(0)]);
        // Two processes, one call: the second gets nothing rather than a wrong description.
        assert_eq!(match_calls(&[found(1, "sleep 60", 10_100), found(2, "sleep 60", 10_200)], &calls[1..2]), vec![Some(0), None]);
    }

    #[test]
    fn keeps_recent_calls_per_kind() {
        let mut l = Vec::new();
        push_call(&mut l, BashCall { id: "bg".into(), background: true, ..Default::default() });
        for i in 0..100 {
            push_call(&mut l, BashCall { id: format!("f{i}"), ..Default::default() });
        }
        assert_eq!(l.len(), KEEP_CALLS + 1);
        assert!(l.iter().any(|c| c.id == "bg"), "a burst of quick commands keeps the background one");
        assert_eq!(l.last().map(|c| c.id.as_str()), Some("f99"));
    }

    #[test]
    fn tail_lines_are_clean_and_bounded() {
        assert_eq!(last_lines(b"cut line\nl1\n\nl2\nl3\nl4\n", false), vec!["l2", "l3", "l4"]);
        assert_eq!(last_lines(b"only", true), vec!["only"]);
        assert_eq!(last_lines(b"x\n\x1b[32mok\x1b[0m done\nprogress 10%\rprogress 90%\n", true), vec!["x", "ok done", "progress 90%"]);
        assert!(last_lines(b"", true).is_empty());
    }

    #[test]
    fn procargs_parse() {
        let mut b = 3i32.to_ne_bytes().to_vec();
        b.extend_from_slice(b"/bin/zsh\0\0\0\0zsh\0-c\0sleep 5\0PATH=/bin\0");
        assert_eq!(sys::parse_procargs(&b), Some(v(&["zsh", "-c", "sleep 5"])));
        assert_eq!(sys::parse_procargs(&[0, 0]), None);
    }

    /// A real `zsh -c '<snapshot wrapper>'` child of this test process is found
    /// with its command; a child with no wrapper (a helper look-alike) is not.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn finds_a_real_wrapper_child_and_stops_it() {
        let me = std::process::id();
        let script = "source /nonexistent/.claude/shell-snapshots/snapshot-zsh-0-t.sh 2>/dev/null || true && eval 'sleep 30' < /dev/null && pwd -P >| /dev/null";
        let sh = if std::path::Path::new("/bin/zsh").exists() { "/bin/zsh" } else { "/bin/sh" };
        use std::os::unix::process::CommandExt;
        let mut child = std::process::Command::new(sh).arg("-c").arg(script).process_group(0).spawn().unwrap();
        let mut helper = std::process::Command::new("/bin/sh").arg("-c").arg("exec sleep 30 # mcp-server").spawn().unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let found = shells_under(me, &HashSet::new(), &HashSet::new());
        let ours: Vec<_> = found.iter().filter(|(p, _)| p.pid == child.id()).collect();
        assert_eq!(ours.len(), 1, "{found:?}");
        assert_eq!(ours[0].1, "sleep 30");
        assert!(!found.iter().any(|(p, _)| p.pid == helper.id()), "helper excluded");
        // The scanner lists it as background (matched call) right away, and Stop verifies it.
        let mut s = Shells::default();
        let calls = vec![BashCall { id: "t".into(), command: "sleep 30".into(), background: true, description: Some("wait".into()), at: 1, ..Default::default() }];
        let targets = [Target { id: "sess", pid: me, cwd: "/nonexistent", calls }];
        let got = s.scan(&targets, true);
        let sh = got.get(&me).and_then(|v| v.iter().find(|x| x.pid == child.id())).cloned().expect("listed");
        assert_eq!((sh.command.as_str(), sh.description.as_deref(), sh.background), ("sleep 30", Some("wait"), true));
        assert!(s.verify(&targets, helper.id()).is_none(), "only listed shells can be stopped");
        assert!(s.verify(&targets, me).is_none());
        let t = s.verify(&targets, child.id()).expect("verifies");
        assert!(t.group, "the wrapper leads its own group");
        stop(t, Duration::from_millis(500)).unwrap();
        let status = child.wait().unwrap();
        assert!(!status.success());
        let _ = helper.kill();
        let _ = helper.wait();
    }
}
