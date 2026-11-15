//! The one place both frontends (TUI and desktop app) get their data from:
//! merges every provider's sessions and links them to the PTYs coool runs itself.
//!
//! Transcripts are parsed in the background (see `loader`): [`Hub::refresh`]
//! only does cheap work and returns what is known now, so it is safe to call
//! every second while holding a lock. Sessions not parsed yet come back with
//! `loaded == false`; [`Hub::loading`] says whether the initial load is still
//! running (poll more often meanwhile to see it stream in).

use crate::cache::Cache;
use crate::chat::{Chat, ChatInfo, ChatOptions, ChatState};
use crate::claude::ClaudeSource;
use crate::codex::CodexSource;
use crate::loader::{INLINE_BUDGET, Pool};
use crate::model::*;
use crate::pty::Managed;
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How long an exited PTY (final screen, raw log) stays around before its slot
/// is cleared to free the PTY, its buffers and the reaped child.
const EXITED_KEEP: Duration = Duration::from_secs(60);
/// The first refresh waits at most this long for background loading, so a warm
/// start (everything in the cache) comes back complete in one call.
const FIRST_WAIT: Duration = Duration::from_millis(50);

pub struct Hub {
    claude: ClaudeSource,
    codex: CodexSource,
    /// Background parsing; dropping the Hub stops and joins its threads.
    pool: Pool,
    refreshed: bool,
    loading: bool,
    /// Sessions launched by coool. Indices are stable for the life of the process;
    /// a slot becomes `None` some time after its process exits.
    pub managed: Vec<Option<Managed>>,
    /// Codex PTY -> session id, once matched, so the link can't hop to another
    /// session that later shares its folder.
    links: HashMap<usize, String>,
    exited_at: HashMap<usize, Instant>,
    /// Structured chats ([`crate::chat`]); ids are stable like `managed` indices.
    chats: Vec<Option<Chat>>,
    chat_exited_at: HashMap<usize, Instant>,
}

impl Hub {
    /// `recent_window`: how far back ended sessions are still listed.
    /// Parse state is cached under the user's cache dir (`.../coool`).
    pub fn new(recent_window: Duration) -> Self {
        Self::with_cache(recent_window, dirs::cache_dir().map(|d| d.join("coool")))
    }

    /// Like [`Hub::new`], with the parse cache rooted at `cache_root` (None: no cache).
    pub fn with_cache(recent_window: Duration, cache_root: Option<PathBuf>) -> Self {
        Self::with_sources(ClaudeSource::new(recent_window), CodexSource::new(recent_window), cache_root.map(Cache::at), Pool::default_threads())
    }

    fn with_sources(claude: ClaudeSource, codex: CodexSource, cache: Option<Cache>, threads: usize) -> Self {
        Self {
            claude,
            codex,
            pool: Pool::new(threads, cache),
            refreshed: false,
            loading: true,
            managed: Vec::new(),
            links: HashMap::new(),
            exited_at: HashMap::new(),
            chats: Vec::new(),
            chat_exited_at: HashMap::new(),
        }
    }

    /// Re-scan disk (cheaply) and return all sessions as known now, busiest first.
    /// Parsing happens in the background; see [`Session::loaded`] and [`Hub::loading`].
    pub fn refresh(&mut self, live_only: bool) -> Vec<Session> {
        let mut budget = INLINE_BUDGET;
        self.pool.set_fresh_inline(!self.loading);
        self.claude.scan(&self.pool, &mut budget);
        self.codex.scan(&self.pool, &mut budget);
        if !self.refreshed {
            // Give the cache (and the Codex folder walk) a moment, then pick up
            // what they found: on a warm start this returns the complete set.
            self.refreshed = true;
            let deadline = Instant::now() + FIRST_WAIT;
            self.pool.wait_idle(deadline);
            self.claude.scan(&self.pool, &mut budget);
            self.codex.scan(&self.pool, &mut budget);
            self.pool.wait_idle(deadline);
        }
        let mut all = self.claude.sessions();
        all.extend(self.codex.sessions());
        if self.loading && self.codex.walked() && self.claude.complete() && self.codex.complete() {
            self.loading = false;
            if let Some(c) = self.pool.cache().cloned() {
                self.pool.idle_task(move || c.prune());
            }
        }

        self.reap();

        // Sessions handed from an ended chat to a terminal ("Open in terminal"):
        // the terminal owns them now, so the row stays one continuous session.
        let handed: Vec<&String> = self.links.iter().filter(|(mi, _)| self.get(**mi).is_some_and(|m| m.is_running())).map(|(_, id)| id).collect();
        // Chats know their provider session id exactly; link those first.
        for (ci, c) in self.chats.iter().enumerate() {
            let Some(c) = c else { continue };
            let Some(sid) = c.session_id() else { continue };
            if !c.is_running() && handed.contains(&&sid) {
                continue;
            }
            let Some(s) = all.iter_mut().find(|s| s.provider == c.provider && s.id == sid && s.chat.is_none()) else { continue };
            s.chat = Some(ci);
            if c.is_running() {
                s.status = match c.state() {
                    ChatState::Idle => Status::Idle,
                    ChatState::Working | ChatState::WaitingPermission => Status::Busy,
                };
                if c.state() == ChatState::WaitingPermission {
                    s.current = Some("waiting for permission".into());
                } else if c.state() == ChatState::Idle {
                    s.current = None;
                }
                s.pid = s.pid.or(c.pid);
            }
        }

        // Oldest PTY first, so each claims the earliest matching new transcript.
        let mut order: Vec<usize> = (0..self.managed.len()).filter(|&i| self.get(i).is_some_and(|m| m.is_running())).collect();
        order.sort_by_key(|&i| self.managed[i].as_ref().map(|m| m.started));
        for mi in order {
            let Some(m) = self.managed[mi].as_ref() else { continue };
            let free = |s: &Session| s.provider == m.provider && s.managed.is_none() && s.chat.is_none();
            let linked = self.links.get(&mi).and_then(|id| all.iter().position(|s| free(s) && s.id == *id));
            // `sticky`: confident enough to remember the link for later refreshes.
            let (hit, sticky) = match m.provider {
                // A known link (a chat handed to the terminal), else the pid registry.
                Provider::Claude if linked.is_some() => (linked, true),
                Provider::Claude => (all.iter().position(|s| free(s) && s.pid.is_some() && s.pid == m.pid), false),
                // Codex has no pid registry: a link made earlier, else the session
                // being resumed, else the first session started in that folder after
                // this PTY was launched; as a last resort the freshest one there.
                Provider::Codex => {
                    let by_id = |id: &str| all.iter().position(|s| free(s) && s.id == id);
                    let after_launch = |s: &Session| {
                        self.codex.session_started(&s.id).filter(|t| *t + Duration::from_secs(5) >= m.started)
                    };
                    let confident = self
                        .links
                        .get(&mi)
                        .and_then(|id| by_id(id))
                        .or_else(|| resume_id(&m.args).and_then(by_id))
                        .or_else(|| {
                            all.iter()
                                .enumerate()
                                .filter(|(_, s)| free(s) && same_dir(&s.cwd, &m.cwd))
                                .filter_map(|(i, s)| Some((i, after_launch(s)?)))
                                .min_by_key(|(_, t)| *t)
                                .map(|(i, _)| i)
                        });
                    match confident {
                        Some(i) => (Some(i), true),
                        // e.g. `resume --last`: a guess, re-evaluated every refresh.
                        None => (
                            all.iter()
                                .enumerate()
                                .filter(|(_, s)| free(s) && same_dir(&s.cwd, &m.cwd) && s.updated >= m.started)
                                .max_by_key(|(_, s)| s.updated)
                                .map(|(i, _)| i),
                            false,
                        ),
                    }
                }
            };
            if let Some(i) = hit {
                if sticky && !all[i].id.is_empty() {
                    self.links.insert(mi, all[i].id.clone());
                }
                all[i].managed = Some(mi);
                if all[i].status == Status::Ended {
                    all[i].status = Status::Idle;
                }
                all[i].pid = all[i].pid.or(m.pid);
            }
        }

        // A resumed Codex rollout can sit in an old day folder that is only
        // walked occasionally; look harder while a Codex PTY is still unmatched.
        let unmatched_codex = self.managed.iter().enumerate().any(|(i, m)| {
            m.as_ref().is_some_and(|m| m.provider == Provider::Codex && m.is_running()) && !all.iter().any(|s| s.managed == Some(i))
        }) || self.chats.iter().enumerate().any(|(i, c)| {
            c.as_ref().is_some_and(|c| c.provider == Provider::Codex && c.is_running() && c.session_id().is_some()) && !all.iter().any(|s| s.chat == Some(i))
        });
        if unmatched_codex {
            self.codex.scan_all_soon();
        }

        if live_only {
            all.retain(|s| s.status != Status::Ended || s.managed.is_some() || s.chat.is_some());
        }
        for s in &mut all {
            s.project = crate::project::project_root(&s.cwd);
        }
        all.sort_by(|a, b| a.status.cmp(&b.status).then(b.updated.cmp(&a.updated)));
        all
    }

    /// True until every session found at startup has been fully parsed (as of
    /// the last [`Hub::refresh`]). Later sessions don't turn it back on.
    pub fn loading(&self) -> bool {
        self.loading
    }

    /// Launch a provider CLI in a new PTY. Returns its managed index.
    pub fn spawn(&mut self, provider: Provider, args: &[String], cwd: &str, rows: u16, cols: u16) -> Result<usize> {
        let m = Managed::spawn(provider, args, cwd, rows, cols)?;
        self.managed.push(Some(m));
        Ok(self.managed.len() - 1)
    }

    pub fn get(&self, i: usize) -> Option<&Managed> {
        self.managed.get(i).and_then(|m| m.as_ref())
    }

    pub fn get_mut(&mut self, i: usize) -> Option<&mut Managed> {
        self.managed.get_mut(i).and_then(|m| m.as_mut())
    }

    /// Start a structured chat (see [`crate::chat`]). Returns its id, stable for the process.
    pub fn start_chat(&mut self, opts: ChatOptions) -> Result<usize> {
        let id = self.chats.len();
        let c = Chat::start(id, opts)?;
        self.chats.push(Some(c));
        Ok(id)
    }

    pub fn chat(&self, id: usize) -> Option<&Chat> {
        self.chats.get(id).and_then(|c| c.as_ref())
    }

    pub fn chat_mut(&mut self, id: usize) -> Option<&mut Chat> {
        self.chats.get_mut(id).and_then(|c| c.as_mut())
    }

    /// Every chat still held (running, or exited less than a minute ago).
    pub fn chats(&self) -> Vec<ChatInfo> {
        self.chats.iter().flatten().map(|c| c.info()).collect()
    }

    /// Running chats not yet matched to a discovered session (no transcript yet).
    pub fn pending_chats(&self, sessions: &[Session]) -> Vec<usize> {
        self.chats
            .iter()
            .enumerate()
            .filter(|(i, c)| c.as_ref().is_some_and(|c| c.is_running()) && !sessions.iter().any(|s| s.chat == Some(*i)))
            .map(|(i, _)| i)
            .collect()
    }

    /// Continue chat `id` in a terminal: stop the chat (one process per
    /// session), then resume the same session in a new PTY. Returns the PTY index.
    pub fn open_chat_in_terminal(&mut self, id: usize, rows: u16, cols: u16) -> Result<usize> {
        let c = self.chat_mut(id).context("no such chat")?;
        let sid = c.session_id().context("the chat has no session yet")?;
        let (provider, cwd) = (c.provider, c.cwd.clone());
        c.stop();
        let deadline = Instant::now() + Duration::from_millis(1500);
        while self.chat(id).is_some_and(|c| c.is_running()) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        let args = match provider {
            Provider::Claude => vec!["--resume".to_string(), sid.clone()],
            Provider::Codex => vec!["resume".to_string(), sid.clone()],
        };
        let pty = self.spawn(provider, &args, &cwd, rows, cols)?;
        // The session id is known exactly: link the terminal to it now instead
        // of waiting for the CLI to register (the row never reads "Ended").
        self.links.insert(pty, sid);
        Ok(pty)
    }

    /// Managed PTYs that are running but not yet matched to a transcript.
    pub fn pending(&self, sessions: &[Session]) -> Vec<usize> {
        let linked: Vec<usize> = sessions.iter().filter_map(|s| s.managed).collect();
        self.managed
            .iter()
            .enumerate()
            .filter(|(i, m)| m.as_ref().is_some_and(|m| m.is_running()) && !linked.contains(i))
            .map(|(i, _)| i)
            .collect()
    }

    pub fn running_count(&self) -> usize {
        self.managed.iter().flatten().filter(|m| m.is_running()).count()
    }

    /// Chats whose CLI process is still running.
    pub fn running_chats(&self) -> usize {
        self.chats.iter().flatten().filter(|c| c.is_running()).count()
    }

    /// Escalate unanswered stop requests, and free PTYs that exited a while ago.
    fn reap(&mut self) {
        let now = Instant::now();
        for (i, slot) in self.managed.iter_mut().enumerate() {
            let Some(m) = slot else { continue };
            m.escalate_kill(None);
            if m.is_running() {
                continue;
            }
            let since = *self.exited_at.entry(i).or_insert(now);
            if now.duration_since(since) >= EXITED_KEEP {
                *slot = None;
                self.exited_at.remove(&i);
                self.links.remove(&i);
            }
        }
        for (i, slot) in self.chats.iter_mut().enumerate() {
            let Some(c) = slot else { continue };
            c.escalate_kill(None);
            if c.is_running() {
                continue;
            }
            let since = *self.chat_exited_at.entry(i).or_insert(now);
            if now.duration_since(since) >= EXITED_KEEP {
                *slot = None;
                self.chat_exited_at.remove(&i);
            }
        }
    }

    /// Stop every managed session and chat: hang up, give them a moment to exit cleanly,
    /// then SIGKILL whatever is left. Blocks for at most about a second.
    pub fn kill_all(&mut self) {
        for m in self.managed.iter_mut().flatten() {
            m.kill();
        }
        for c in self.chats.iter_mut().flatten() {
            c.stop();
        }
        let chats_running = |h: &Self| h.chats.iter().flatten().any(|c| c.is_running());
        let deadline = Instant::now() + Duration::from_millis(1000);
        while Instant::now() < deadline && (self.running_count() > 0 || chats_running(self)) {
            std::thread::sleep(Duration::from_millis(25));
        }
        for m in self.managed.iter_mut().flatten() {
            m.escalate_kill(Some(Duration::ZERO));
        }
        for c in self.chats.iter_mut().flatten() {
            c.escalate_kill(Some(Duration::ZERO));
        }
    }
}

/// The session id in `resume <id>` (codex) / `--resume <id>` (claude) args.
fn resume_id(args: &[String]) -> Option<&str> {
    let i = args.iter().position(|a| a == "resume" || a == "--resume" || a == "-r")?;
    args.get(i + 1).map(|s| s.as_str()).filter(|s| !s.starts_with('-'))
}

/// Same folder, tolerating symlinks such as macOS's /tmp -> /private/tmp.
fn same_dir(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let trim = |s: &str| s.trim_end_matches('/').to_string();
    if trim(a) == trim(b) {
        return true;
    }
    matches!((Path::new(a).canonicalize(), Path::new(b).canonicalize()), (Ok(x), Ok(y)) if x == y)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loader::tests::{claude_transcript, codex_transcript, tmpdir};
    use std::fs;
    use std::io::Write;

    /// Fake ~/.claude and ~/.codex with big transcripts, a subagent and a small one.
    fn fixture(name: &str) -> PathBuf {
        let d = tmpdir(name);
        let proj = d.join("claude/projects/-w");
        fs::create_dir_all(proj.join("big/subagents")).unwrap();
        fs::write(proj.join("big.jsonl"), claude_transcript(3000, 3000)).unwrap();
        fs::write(proj.join("small.jsonl"), claude_transcript(5, 10)).unwrap();
        fs::write(proj.join("big/subagents/agent-a1.meta.json"), r#"{"agentType":"Explore","description":"look"}"#).unwrap();
        fs::write(proj.join("big/subagents/agent-a1.jsonl"), claude_transcript(500, 1000)).unwrap();
        let day = d.join("codex/sessions").join(crate::codex::date_path(std::time::SystemTime::now()));
        fs::create_dir_all(&day).unwrap();
        fs::write(day.join("rollout-2026-11-14T08-00-00-01a1da0b-637d-7063-8d51-c27a6ae5f35a.jsonl"), codex_transcript(3000, 3000)).unwrap();
        d
    }

    fn hub(d: &Path, cache: bool) -> Hub {
        let w = Duration::from_secs(3600);
        Hub::with_sources(
            ClaudeSource::with_root(d.join("claude"), w),
            CodexSource::with_root(d.join("codex"), w),
            cache.then(|| Cache::at(d.join("cache"))),
            3,
        )
    }

    fn reference(d: &Path) -> Vec<Session> {
        let w = Duration::from_secs(3600);
        let mut all = ClaudeSource::with_root(d.join("claude"), w).refresh();
        all.extend(CodexSource::with_root(d.join("codex"), w).refresh());
        all.sort_by(|a, b| a.id.cmp(&b.id));
        all
    }

    fn until_loaded(h: &mut Hub) -> Vec<Session> {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let mut s = h.refresh(false);
            if !h.loading() {
                s.sort_by(|a, b| a.id.cmp(&b.id));
                return s;
            }
            assert!(Instant::now() < deadline, "loading never finished");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn summary(s: &[Session]) -> Vec<String> {
        s.iter()
            .map(|s| {
                let acts: Vec<&str> = s.activity.iter().map(|a| a.text.as_str()).collect();
                let agents: Vec<_> = s.agents.iter().map(|a| (a.id.clone(), a.tokens.clone(), a.models.clone(), a.activity.len())).collect();
                format!("{} {} {} {:?} {:?} {:?} {:?} {:?} {}", s.id, s.title, s.cwd, s.tokens, s.models, acts, agents, s.current, s.loaded)
            })
            .collect()
    }

    #[test]
    fn background_load_and_cache_resume_equal_full_parse() {
        let d = fixture("hub");
        let want = summary(&reference(&d));
        assert_eq!(want.len(), 3);

        let mut h = hub(&d, true);
        let t = Instant::now();
        let first = h.refresh(false);
        assert!(t.elapsed() < Duration::from_secs(2), "first refresh must not parse everything: {:?}", t.elapsed());
        assert_eq!(first.len(), 3, "every session is listed right away");
        assert!(first.iter().any(|s| s.id == "small" && s.loaded), "small files are parsed right away");
        let got = until_loaded(&mut h);
        assert_eq!(summary(&got), want);

        // A session that starts later (e.g. a new chat) shows up parsed at once,
        // so the chat/PTY linking in `refresh` sees it immediately.
        fs::write(d.join("claude/projects/-w/fresh.jsonl"), claude_transcript(3, 10)).unwrap();
        let s = h.refresh(false);
        let fresh = s.iter().find(|s| s.id == "fresh").expect("listed on the next refresh");
        assert!(fresh.loaded && fresh.tokens.output > 0);
        fs::remove_file(d.join("claude/projects/-w/fresh.jsonl")).unwrap();
        drop(h);
        let entries = fs::read_dir(d.join("cache").join(format!("transcripts-v{}", crate::cache::VERSION))).unwrap().count();
        assert_eq!(entries, 3, "big claude, its subagent, big codex");

        // Second launch resumes from the cache, also after the files grew.
        let more = claude_transcript(2, 5);
        fs::OpenOptions::new().append(true).open(d.join("claude/projects/-w/big.jsonl")).unwrap().write_all(more.as_bytes()).unwrap();
        let want = summary(&reference(&d));
        let mut h = hub(&d, true);
        assert_eq!(summary(&until_loaded(&mut h)), want);

        // Without a cache the result is the same.
        let mut h = hub(&d, false);
        assert_eq!(summary(&until_loaded(&mut h)), want);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn drop_while_loading_returns_promptly() {
        let d = fixture("hub-drop");
        let mut h = hub(&d, false);
        h.refresh(false);
        let t = Instant::now();
        drop(h);
        assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn resume_id_from_args() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(resume_id(&v(&["resume", "abc"])), Some("abc"));
        assert_eq!(resume_id(&v(&["--resume", "abc"])), Some("abc"));
        assert_eq!(resume_id(&v(&["resume", "--last"])), None);
        assert_eq!(resume_id(&v(&[])), None);
    }

    #[test]
    fn same_dir_ignores_trailing_slash_and_rejects_empty() {
        assert!(same_dir("/a/b/", "/a/b"));
        assert!(!same_dir("", ""));
        assert!(!same_dir("/a/b", "/a/c"));
    }
}
