//! Sessions that coool launches itself, each in its own pseudo-terminal.

use crate::model::Provider;
use anyhow::{Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

/// Work for the writer thread. Writes go through a thread so a child that is
/// not reading its input (full PTY buffer) can never block the caller's UI thread.
enum Out {
    Bytes(Vec<u8>),
    Pause(Duration),
}

/// After `kill()` asks politely (SIGHUP), escalate to SIGKILL after this long.
const KILL_GRACE: Duration = Duration::from_secs(3);

/// Raw PTY output kept for GUI terminal emulators (xterm.js etc.), which need
/// the byte stream rather than the parsed screen. Capped; `total` only grows.
#[derive(Default)]
pub struct RawLog {
    buf: VecDeque<u8>,
    total: u64,
}

const RAW_CAP: usize = 4 * 1024 * 1024;

impl RawLog {
    fn push(&mut self, bytes: &[u8]) {
        self.buf.extend(bytes);
        self.total += bytes.len() as u64;
        if self.buf.len() > RAW_CAP {
            let drop = self.buf.len() - RAW_CAP;
            self.buf.drain(..drop);
        }
    }

    /// Bytes written since absolute offset `since` (clamped to what is still
    /// buffered) and the new offset to pass next time.
    pub fn read_since(&self, since: u64) -> (Vec<u8>, u64) {
        let start_abs = self.total - self.buf.len() as u64;
        let from = since.clamp(start_abs, self.total);
        let skip = (from - start_abs) as usize;
        (self.buf.iter().skip(skip).copied().collect(), self.total)
    }
}

pub struct Managed {
    pub provider: Provider,
    pub cwd: String,
    /// Arguments the CLI was started with (e.g. `resume <id>`).
    pub args: Vec<String>,
    pub pid: Option<u32>,
    pub started: SystemTime,
    pub parser: Arc<Mutex<vt100::Parser>>,
    pub exited: Arc<Mutex<bool>>,
    pub raw: Arc<Mutex<RawLog>>,
    master: Box<dyn MasterPty + Send>,
    writer: Sender<Out>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    size: (u16, u16),
    kill_requested: Option<Instant>,
}

impl Managed {
    pub fn spawn(provider: Provider, args: &[String], cwd: &str, rows: u16, cols: u16) -> Result<Self> {
        Self::spawn_env(provider, args, cwd, rows, cols, &[])
    }

    /// [`Self::spawn`] with `env` added; for a Claude Platform key's arguments ([`crate::platform::cli_args`]), any key
    /// and the other logins removed from its environment (as for a chat).
    pub fn spawn_env(provider: Provider, args: &[String], cwd: &str, rows: u16, cols: u16, env: &[(String, String)]) -> Result<Self> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .context("open pty")?;
        let mut cmd = CommandBuilder::new(provider.binary());
        cmd.args(args);
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (k, v) in env {
            cmd.env(k, v);
        }
        if crate::platform::uses_key(args) {
            for v in crate::platform::OTHER_AUTH {
                cmd.env_remove(v);
            }
        }
        let child = pair.slave.spawn_command(cmd).with_context(|| format!("spawn `{}`", provider.binary()))?;
        drop(pair.slave);

        let parser = Arc::new(Mutex::new(vt100::Parser::new(rows, cols, 2000)));
        let exited = Arc::new(Mutex::new(false));
        let raw = Arc::new(Mutex::new(RawLog::default()));
        let mut reader = pair.master.try_clone_reader()?;
        let mut pty_writer = pair.master.take_writer()?;
        let (writer, rx) = mpsc::channel::<Out>();
        thread::spawn(move || {
            for job in rx {
                match job {
                    Out::Bytes(b) => {
                        if pty_writer.write_all(&b).and_then(|_| pty_writer.flush()).is_err() {
                            break;
                        }
                    }
                    Out::Pause(d) => thread::sleep(d),
                }
            }
        });
        {
            let parser = parser.clone();
            let exited = exited.clone();
            let raw = raw.clone();
            thread::spawn(move || {
                let mut buf = [0u8; 16384];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            raw.lock().unwrap().push(&buf[..n]);
                            parser.lock().unwrap().process(&buf[..n]);
                        }
                    }
                }
                *exited.lock().unwrap() = true;
            });
        }
        Ok(Self {
            provider,
            cwd: cwd.to_string(),
            args: args.to_vec(),
            pid: child.process_id(),
            started: SystemTime::now(),
            parser,
            exited,
            raw,
            master: pair.master,
            writer,
            child: Mutex::new(child),
            size: (rows, cols),
            kill_requested: None,
        })
    }

    /// Queue bytes for the child's input. Never blocks.
    pub fn write(&mut self, bytes: &[u8]) {
        if !bytes.is_empty() {
            let _ = self.writer.send(Out::Bytes(bytes.to_vec()));
        }
    }

    /// Bytes for pasting `text`: wrapped in bracketed-paste markers when the
    /// child enabled that mode (so newlines don't submit early), raw otherwise.
    pub fn paste_bytes(&self, text: &str) -> Vec<u8> {
        let bracketed = self.parser.lock().unwrap().screen().bracketed_paste();
        paste_bytes(text, bracketed)
    }

    /// Type a prompt and submit it.
    pub fn send_prompt(&mut self, text: &str) {
        let b = self.paste_bytes(text);
        self.write(&b);
        // Give the TUI a moment to take the paste before Enter submits it;
        // the pause happens on the writer thread, not the caller's.
        let _ = self.writer.send(Out::Pause(Duration::from_millis(60)));
        self.write(b"\r");
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        if self.size == (rows, cols) || rows == 0 || cols == 0 {
            return;
        }
        self.size = (rows, cols);
        let _ = self.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        self.parser.lock().unwrap().screen_mut().set_size(rows, cols);
    }

    /// False once the child has exited (it is reaped here) or the PTY hit EOF.
    /// The child is checked directly: background processes it left holding the
    /// PTY would otherwise keep the reader from ever seeing EOF.
    pub fn is_running(&self) -> bool {
        if *self.exited.lock().unwrap() {
            return false;
        }
        // `exited` is left alone: it means "reader hit EOF, all output is in
        // `raw`/`parser`", which stream consumers rely on.
        matches!(self.child.lock().unwrap().try_wait(), Ok(None))
    }

    /// Ask the child (and its process group) to hang up, like closing a terminal
    /// window. Returns immediately; `Hub` escalates to SIGKILL after a grace period.
    pub fn kill(&mut self) {
        if !self.is_running() {
            return;
        }
        self.kill_requested.get_or_insert_with(Instant::now);
        self.signal(libc::SIGHUP);
    }

    fn signal(&self, sig: libc::c_int) {
        if let Some(p) = self.pid.and_then(crate::util::valid_pid) {
            // The child is a session leader (setsid), so its pgid is its pid.
            // SAFETY: plain signal delivery to our own child / its group.
            unsafe {
                libc::killpg(p, sig);
                libc::kill(p, sig);
            }
        }
    }

    /// SIGKILL if a `kill()` request has gone unanswered past the grace period.
    pub(crate) fn escalate_kill(&mut self, grace: Option<Duration>) {
        let grace = grace.unwrap_or(KILL_GRACE);
        if self.kill_requested.is_some_and(|t| t.elapsed() >= grace) && self.is_running() {
            // Not `Child::kill`: portable-pty's version sleeps up to 200ms.
            self.signal(libc::SIGKILL);
        }
    }
}

impl Drop for Managed {
    /// The reader thread keeps a handle on the PTY master, so dropping a
    /// running session would otherwise leave the child running unattended.
    fn drop(&mut self) {
        if self.is_running() {
            self.signal(libc::SIGHUP);
        }
    }
}

fn paste_bytes(text: &str, bracketed: bool) -> Vec<u8> {
    let mut b = Vec::new();
    if bracketed {
        // A literal end marker inside the text would end the paste early and
        // let the rest be interpreted as typed keys.
        let text = text.replace("\x1b[201~", "");
        b.extend_from_slice(b"\x1b[200~");
        b.extend_from_slice(text.as_bytes());
        b.extend_from_slice(b"\x1b[201~");
    } else {
        b.extend_from_slice(text.as_bytes());
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paste_is_bracketed_only_when_enabled_and_cannot_escape() {
        assert_eq!(paste_bytes("a\nb", false), b"a\nb");
        assert_eq!(paste_bytes("x\x1b[201~rm -rf\r", true), b"\x1b[200~xrm -rf\r\x1b[201~");
    }

    /// Needs `claude` on PATH: `cargo test -- --ignored`
    #[test]
    #[ignore]
    fn spawns_cli_in_pty_and_reads_screen() {
        let m = Managed::spawn(Provider::Claude, &["--version".into()], ".", 24, 80).unwrap();
        for _ in 0..100 {
            if !m.is_running() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let screen = m.parser.lock().unwrap().screen().contents();
        assert!(screen.contains("Claude Code"), "screen was: {screen:?}");
        assert!(!m.is_running());
    }
}
