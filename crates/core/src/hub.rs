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
use crate::origin::OwnSessions;
use crate::pty::Managed;
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
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
    /// Sessions coool started or drove, remembered across restarts.
    own: OwnSessions,
    /// How chats introduce themselves to `codex app-server`.
    client_name: String,
    /// MCP servers coool hands each chat it starts, by chat id (see [`Hub::set_chat_mcp`]).
    chat_mcp: Option<crate::chat::McpFor>,
    /// Where coool keeps its Claude Code plugin for Ladder (see [`crate::ladder`]); None: the playbook goes inline.
    ladder_root: Option<PathBuf>,
    /// Live child run pid -> pid of the session above it (see [`crate::lineage`]).
    ancestors: crate::lineage::AncestorCache,
    /// Background shells under live sessions (see [`crate::shells`]).
    shells: crate::shells::Shells,
    /// Live sessions as of the last refresh (id, pid, cwd, provider, background tasks), for [`Hub::stop_shell`].
    shell_targets: Vec<(String, u32, String, Provider, bool)>,
    /// Chats the person typed into before they had a session id (recorded as typed once they have one).
    typed_pending: std::collections::HashSet<usize>,
    /// The chat host new chats start in (APP_SPEC "Chats that outlive the app"); None: inside this process.
    host: Option<Arc<crate::chat::host::Client>>,
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
            own: OwnSessions::at(OwnSessions::default_path()),
            client_name: crate::origin::CLIENT_NAME.to_string(),
            chat_mcp: None,
            ladder_root: crate::ladder::default_plugin_root(),
            ancestors: Default::default(),
            shells: Default::default(),
            shell_targets: Vec::new(),
            typed_pending: Default::default(),
            host: None,
        }
    }

    /// Where new chats start: in the chat host `c` (they outlive this process), or here (None).
    pub fn set_host(&mut self, c: Option<Arc<crate::chat::host::Client>>) {
        self.host = c;
    }

    pub fn host(&self) -> Option<Arc<crate::chat::host::Client>> {
        self.host.clone()
    }

    /// Takes in every chat host `c` runs that this hub doesn't hold yet (after a relaunch): their ids here, with what
    /// the host knows of them (options, MCP servers with their tokens, the app's record).
    pub fn adopt(&mut self, c: &Arc<crate::chat::host::Client>) -> Result<Vec<(usize, crate::chat::host::Entry)>> {
        let mut out = Vec::new();
        for e in c.list()? {
            if self.chats.iter().flatten().any(|x| x.host_key() == Some(e.key.as_str())) {
                continue;
            }
            // The id it had in the app that started it, when that slot is free here: what an agent was told about
            // its helpers (Ladder's `spawn` returns the id) stays true.
            let id = match e.meta["app_id"].as_u64().map(|i| i as usize) {
                Some(i) if self.chats.get(i).is_none_or(|s| s.is_none()) => i,
                _ => self.chats.len(),
            };
            let chat = Chat::hosted(id, c.clone(), &e);
            if let Some(sid) = chat.session_id() {
                self.own.record(chat.provider, &sid);
            }
            if self.chats.len() <= id {
                self.chats.resize_with(id + 1, || None);
            }
            self.chats[id] = Some(chat);
            out.push((id, e));
        }
        Ok(out)
    }

    /// Where the list of coool's own sessions is kept (default:
    /// [`OwnSessions::default_path`]; None: memory only). A test run points it
    /// into its throwaway folder so its chats are never remembered as the person's.
    pub fn set_own_sessions_file(&mut self, path: Option<PathBuf>) {
        self.own = OwnSessions::at(path);
    }

    /// The `clientInfo.name` new Codex chats send (default [`crate::origin::CLIENT_NAME`];
    /// a test run uses [`crate::origin::TEST_CLIENT_NAME`]).
    pub fn set_client_name(&mut self, name: &str) {
        self.client_name = name.to_string();
    }

    /// MCP servers each new chat gets, built from its chat id (the desktop app's `coool-device` server).
    pub fn set_chat_mcp(&mut self, f: Option<crate::chat::McpFor>) {
        self.chat_mcp = f;
    }

    /// Where Ladder's plugin folder is written (default: coool's data dir; a test run points it into its own folder).
    pub fn set_ladder_root(&mut self, root: Option<PathBuf>) {
        self.ladder_root = root;
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
            } else if c.provider == Provider::Codex && s.updated.elapsed().is_ok_and(|a| a >= Duration::from_secs(3)) {
                // Codex rollouts carry no pid, so the transcript alone would keep a stopped chat "idle" for two
                // minutes (or "busy" for ten after a Stop mid-turn) and offer no Resume. coool ran its only process,
                // which is gone: it ended, unless something else writes the rollout again (a `codex resume`).
                s.status = Status::Ended;
                s.current = None;
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

        // Whatever coool started or drives is the person's, now and after a restart.
        for c in self.chats.iter().flatten() {
            if let Some(sid) = c.session_id() {
                self.own.record(c.provider, &sid);
                if self.typed_pending.remove(&c.id) {
                    self.own.record_typed(c.provider, &sid);
                }
            }
        }
        for s in &mut all {
            if s.chat.is_some() || s.managed.is_some() {
                self.own.record(s.provider, &s.id);
            }
            if self.own.contains(s.provider, &s.id) {
                s.origin = Origin::Coool;
            }
        }
        self.link_children(&mut all);
        self.attach_shells(&mut all);

        if live_only {
            all.retain(|s| s.status != Status::Ended || s.managed.is_some() || s.chat.is_some());
        }
        for s in &mut all {
            s.project = crate::project::project_root(&s.cwd);
        }
        all.sort_by(|a, b| a.status.cmp(&b.status).then(b.updated.cmp(&a.updated)));
        all
    }

    /// Child runs: programmatic sessions started from inside another session
    /// (see [`crate::lineage`]) get `parent`; parents get `live_children`.
    fn link_children(&mut self, all: &mut [Session]) {
        use crate::lineage::session_ancestor;
        let live_pids: HashMap<u32, String> = all.iter().filter(|s| s.status != Status::Ended).filter_map(|s| Some((s.pid?, s.id.clone()))).collect();
        for s in all.iter_mut() {
            // A coool chat a Ladder helper ran in (remembered by [`Hub::note_helper`]) belongs to its caller, unless
            // the person has typed into it since.
            if s.origin == Origin::Coool {
                if s.parent.is_none() && !self.own.typed(s.provider, &s.id) {
                    s.parent = self.own.parent_of(s.provider, &s.id).filter(|p| *p != s.id).map(str::to_string);
                }
                continue;
            }
            if s.origin != Origin::Automation {
                continue;
            }
            let mut parent = None;
            if let Some(pid) = s.pid.filter(|_| s.status != Status::Ended) {
                let started = crate::util::process_start_ms(pid).unwrap_or(0);
                let above = self.ancestors.get(pid, started, || session_ancestor(pid, crate::util::parent_pid, |p| p != pid && live_pids.contains_key(&p)));
                if let Some(id) = above.and_then(|p| live_pids.get(&p)).filter(|id| **id != s.id) {
                    self.own.record_parent(s.provider, &s.id, id);
                    parent = Some(id.clone());
                }
            }
            s.parent = parent
                .or_else(|| self.own.parent_of(s.provider, &s.id).map(str::to_string))
                .or_else(|| crate::project::scratch_session(&s.cwd))
                .filter(|p| *p != s.id);
        }
        self.ancestors.retain(|p| live_pids.contains_key(&p) || all.iter().any(|s| s.pid == Some(p)));
        self.link_lanes(all);
        let mut live: HashMap<String, u32> = HashMap::new();
        for s in all.iter().filter(|s| s.status != Status::Ended) {
            if let Some(p) = &s.parent {
                *live.entry(p.clone()).or_default() += 1;
            }
        }
        for s in all.iter_mut() {
            s.live_children = live.get(&s.id).copied().unwrap_or(0);
        }
    }

    /// Helpers started from a session's shell (`codex exec`, `claude -p`; see [`crate::lanes`]): each is paired with
    /// the session it writes (by CLI, folder, model and start time), which then counts as that session's child even
    /// when its process left the parent's tree (`( codex exec … ) &`). Sets `lane` on the helper, `lanes` on the parent.
    fn link_lanes(&mut self, all: &mut [Session]) {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let codex = self.codex.views();
        let lanes_of = |s: &Session| match s.provider {
            Provider::Claude => self.claude.lanes(&s.id),
            Provider::Codex => codex.get(&s.id).map(|v| v.lanes.clone()).unwrap_or_default(),
        };
        // (parent index, lane)
        let lanes: Vec<(usize, crate::lanes::Lane)> = all.iter().enumerate().flat_map(|(i, s)| lanes_of(s).into_iter().map(move |l| (i, l))).collect();
        if lanes.is_empty() {
            return;
        }
        let kids: Vec<usize> = (0..all.len()).filter(|&i| all[i].origin == Origin::Automation).collect();
        let facts: Vec<crate::lanes::Child> = kids
            .iter()
            .map(|&i| {
                let s = &all[i];
                match s.provider {
                    Provider::Claude => self.claude.child(s),
                    Provider::Codex => codex.get(&s.id).map(|v| CodexSource::child(s, v)).unwrap_or_default(),
                }
            })
            .collect();
        let refs: Vec<(&str, &crate::lanes::Lane)> = lanes.iter().map(|(p, l)| (all[*p].cwd.as_str(), l)).collect();
        let pairs = crate::lanes::assign(&refs, &facts, |li, ci| {
            let (p, k) = (&all[lanes[li].0], &all[kids[ci]]);
            p.id != k.id && k.parent.as_ref().is_none_or(|x| *x == p.id)
        });
        let mut matched: HashMap<usize, usize> = HashMap::new();
        for (li, ci) in pairs {
            matched.insert(li, ci);
        }
        let mut infos: Vec<Vec<crate::lanes::LaneInfo>> = vec![Vec::new(); all.len()];
        for (li, (pi, l)) in lanes.iter().enumerate() {
            let parent_live = all[*pi].status != Status::Ended;
            let pid = all[*pi].id.clone();
            let info = match matched.get(&li) {
                Some(&ci) => {
                    let ki = kids[ci];
                    let info = crate::lanes::LaneInfo::new(&pid, l, Some((&all[ki].id, &facts[ci])), parent_live, now);
                    let provider = all[ki].provider;
                    let kid_id = all[ki].id.clone();
                    if all[ki].parent.is_none() {
                        self.own.record_parent(provider, &kid_id, &pid);
                    }
                    all[ki].parent = Some(pid.clone());
                    all[ki].lane = Some(info.clone());
                    info
                }
                None => crate::lanes::LaneInfo::new(&pid, l, None, parent_live, now),
            };
            infos[*pi].push(info);
        }
        for (s, v) in all.iter_mut().zip(infos) {
            s.lanes = v;
        }
    }

    /// `Session::shells` for every live session with a process.
    fn attach_shells(&mut self, all: &mut [Session]) {
        self.shell_targets = all
            .iter()
            .filter(|s| s.status != Status::Ended)
            .filter_map(|s| Some((s.id.clone(), s.pid?, s.cwd.clone(), s.provider, s.background_tasks)))
            .collect();
        let found = if self.shells.due() {
            // Bash calls only for the sessions walked this time.
            let shells = &self.shells;
            let targets = shell_scan_targets(&self.shell_targets, &self.claude, |id, pid, bg| shells.wants(id, pid, bg));
            self.shells.scan(&targets, false)
        } else {
            self.shells.scan(&[], false)
        };
        for s in all.iter_mut() {
            s.shells = match (s.status, s.pid) {
                (Status::Ended, _) | (_, None) => Vec::new(),
                (_, Some(pid)) => found.get(&pid).cloned().unwrap_or_default(),
            };
            if !s.shells.is_empty() && !s.lanes.is_empty() {
                let lanes = match s.provider {
                    Provider::Claude => self.claude.lanes(&s.id),
                    Provider::Codex => self.codex.views().get(&s.id).map(|v| v.lanes.clone()).unwrap_or_default(),
                };
                for sh in &mut s.shells {
                    sh.label = crate::lanes::shell_label(&sh.command, &lanes);
                }
            }
        }
    }

    /// Sessions on screen (ids): only their shells get output tails.
    pub fn set_shell_focus(&mut self, ids: impl IntoIterator<Item = String>) {
        self.shells.set_focus(ids);
    }

    /// Stops a background shell: only a pid that a fresh scan still lists as
    /// a shell of a live session. SIGTERM to its process group (when it leads
    /// its own) or to the pid, SIGKILL after 3 s if it is still there.
    pub fn stop_shell(&mut self, pid: u32) -> Result<()> {
        let targets = shell_scan_targets(&self.shell_targets, &self.claude, |_, _, _| true);
        let t = self.shells.verify(&targets, pid).context("that process is not a background shell of a live session")?;
        crate::shells::stop(t, Duration::from_secs(3)).context("couldn't signal the shell")?;
        Ok(())
    }

    /// True until every session found at startup has been fully parsed (as of
    /// the last [`Hub::refresh`]). Later sessions don't turn it back on.
    pub fn loading(&self) -> bool {
        self.loading
    }

    /// The transcript file of a listed session, or of one of its subagents
    /// (Claude: the subagent's own transcript; Codex: the subagent thread's rollout).
    pub fn transcript_path(&self, provider: Provider, session: &str, agent: Option<&str>) -> Option<std::path::PathBuf> {
        match provider {
            Provider::Claude => self.claude.transcript(session, agent),
            Provider::Codex => self.codex.transcript(agent.unwrap_or(session)),
        }
    }

    /// Lists these transcripts as sessions whatever their age: sessions opened from History, so their session
    /// view, Changes and Context work as for any other. Replaces the earlier set.
    pub fn set_pinned(&mut self, pins: &[(Provider, PathBuf)]) {
        let of = |want: Provider| pins.iter().filter(|(p, _)| *p == want).map(|(_, x)| x.clone()).collect();
        self.claude.set_pinned(of(Provider::Claude));
        self.codex.set_pinned(of(Provider::Codex));
    }

    /// Whether coool started or drove this session, now or before.
    pub fn is_own(&self, provider: Provider, id: &str) -> bool {
        self.own.contains(provider, id)
    }

    /// Every timeline entry of a transcript, uncapped: a long session's earlier history (a listed session keeps
    /// only its newest [`MAX_ACTIVITY`] entries). Reads the whole file: call it off the Hub's lock.
    pub fn full_activity(provider: Provider, path: &Path) -> std::io::Result<Vec<Activity>> {
        let kind = match provider {
            Provider::Claude => crate::loader::Kind::Claude,
            Provider::Codex => crate::loader::Kind::Codex,
        };
        crate::loader::full_activity(path, kind)
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
        let mut opts = opts;
        let mcp = self.chat_mcp.as_ref().map(|f| f(id, &opts)).unwrap_or_default();
        // Ladder's tools are named in the policy only when their server really is attached.
        if let Some(l) = opts.ladder.as_mut() {
            l.tools = l.tools && mcp.iter().any(|m| m.name == crate::ladder::SERVER);
        }
        let c = match self.host.clone().filter(|h| h.is_alive()) {
            Some(h) => {
                let req = crate::chat::host::StartReq { opts: opts.clone(), client_name: self.client_name.clone(), mcp: mcp.clone(), ladder_root: self.ladder_root.clone(), meta: serde_json::json!({ "app_id": id }) };
                match h.start(&req) {
                    Ok(e) => Chat::hosted(id, h, &e),
                    // The host can't take it: the chat still starts, inside this process.
                    Err(e) => {
                        let c = Chat::start(id, opts, &self.client_name, &mcp, self.ladder_root.as_deref())?;
                        c.handle().note(&format!("This chat runs inside coool and stops if coool quits (the chat host couldn't take it: {e:#})."));
                        c
                    }
                }
            }
            None => Chat::start(id, opts, &self.client_name, &mcp, self.ladder_root.as_deref())?,
        };
        // Claude chats know their session id up front: remember it before the
        // transcript exists, so a crash right away still leaves it marked.
        if let Some(sid) = c.session_id() {
            self.own.record(c.provider, &sid);
        }
        self.chats.push(Some(c));
        Ok(id)
    }

    /// Remembers that chat `chat` is a Ladder helper of chat `parent` (by their sessions, once both have one), so it
    /// is listed as the caller's helper after both ended, here and in History. Cheap to call every refresh.
    pub fn note_helper(&mut self, chat: usize, parent: usize) {
        let (Some(c), Some(p)) = (self.chat(chat), self.chat(parent)) else { return };
        let (Some(sid), Some(pid)) = (c.session_id(), p.session_id()) else { return };
        let provider = c.provider;
        self.own.record_parent(provider, &sid, &pid);
    }

    /// The person typed into chat `chat` (`chat_send`): its session is theirs, even one an agent started.
    pub fn note_typed(&mut self, chat: usize) {
        if let Some(c) = self.chat(chat) {
            match c.session_id() {
                Some(sid) => {
                    let provider = c.provider;
                    self.own.record_typed(provider, &sid);
                }
                None => {
                    self.typed_pending.insert(chat);
                }
            }
        }
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

    /// Running chats the chat host runs (they keep running when this process exits).
    pub fn running_hosted(&self) -> usize {
        self.chats.iter().flatten().filter(|c| c.is_running() && c.is_hosted()).count()
    }

    /// Stop the managed sessions and the chats of this process, and leave the hosted chats running (a quit with
    /// "Keep chats running when coool quits" on). Blocks for at most about a second.
    pub fn kill_local(&mut self) {
        self.kill_where(|c| !c.is_hosted());
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
        self.kill_where(|_| true);
    }

    fn kill_where(&mut self, which: impl Fn(&Chat) -> bool) {
        for m in self.managed.iter_mut().flatten() {
            m.kill();
        }
        for c in self.chats.iter_mut().flatten() {
            if which(c) {
                c.stop();
            }
        }
        let chats_running = |h: &Self| h.chats.iter().flatten().any(|c| which(c) && c.is_running());
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

/// What the shell scan needs per live session; Claude sessions bring their recent Bash calls.
/// `gather(id, pid, background)`: whether to collect that session's calls (else it isn't walked this time).
fn shell_scan_targets<'a>(live: &'a [(String, u32, String, Provider, bool)], claude: &ClaudeSource, gather: impl Fn(&str, u32, bool) -> bool) -> Vec<crate::shells::Target<'a>> {
    live.iter()
        .map(|(id, pid, cwd, p, bg)| {
            let calls = gather(id, *pid, *bg).then(|| if *p == Provider::Claude { claude.bash_calls(id) } else { Vec::new() });
            crate::shells::Target { id, pid: *pid, cwd, background: *bg, calls }
        })
        .collect()
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
        let mut h = Hub::with_sources(
            ClaudeSource::with_root(d.join("claude"), w),
            CodexSource::with_root(d.join("codex"), w),
            cache.then(|| Cache::at(d.join("cache"))),
            3,
        );
        h.set_own_sessions_file(Some(d.join("own-sessions.json")));
        h
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

    /// A session from long ago (opened from History) is listed while pinned, with its whole history readable.
    #[test]
    fn pinned_old_sessions_are_listed_and_read_in_full() {
        let d = tmpdir("pinned");
        let proj = d.join("claude/projects/-w");
        fs::create_dir_all(&proj).unwrap();
        let old = proj.join("old.jsonl");
        fs::write(&old, claude_transcript(400, 10)).unwrap();
        let year_ago = std::time::SystemTime::now() - Duration::from_secs(365 * 86400);
        fs::File::options().write(true).open(&old).unwrap().set_modified(year_ago).unwrap();
        let day = d.join("codex/sessions/2025/01/02");
        fs::create_dir_all(&day).unwrap();
        let rollout = day.join("rollout-2025-01-02T08-00-00-01a1da0b-637d-7063-8d51-c27a6ae5f35b.jsonl");
        fs::write(&rollout, codex_transcript(5, 10)).unwrap();
        fs::File::options().write(true).open(&rollout).unwrap().set_modified(year_ago).unwrap();
        let mut h = hub(&d, false);
        assert!(until_loaded(&mut h).is_empty(), "older than the window: not listed");
        h.set_pinned(&[(Provider::Claude, old.clone()), (Provider::Codex, rollout.clone())]);
        let deadline = Instant::now() + Duration::from_secs(60);
        let s = loop {
            let s = until_loaded(&mut h);
            if s.len() == 2 && s.iter().all(|s| s.loaded && !s.activity.is_empty()) || Instant::now() > deadline {
                break s;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(s.len(), 2, "{:?}", s.iter().map(|s| &s.id).collect::<Vec<_>>());
        let c = s.iter().find(|s| s.id == "old").unwrap();
        assert_eq!(c.status, Status::Ended);
        assert_eq!(c.activity.len(), MAX_ACTIVITY, "the listed timeline keeps the newest entries");
        // The whole history: every entry, and the listed ones are its end.
        let full = Hub::full_activity(Provider::Claude, &old).unwrap();
        assert!(full.len() > MAX_ACTIVITY);
        let tail: Vec<&str> = full[full.len() - MAX_ACTIVITY..].iter().map(|a| a.text.as_str()).collect();
        assert_eq!(tail, c.activity.iter().map(|a| a.text.as_str()).collect::<Vec<_>>());
        assert!(full[0].text.starts_with("prompt 0 "), "{}", full[0].text);
        h.set_pinned(&[]);
        assert!(until_loaded(&mut h).is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn origin_from_transcripts_and_own_sessions_across_restart() {
        let d = tmpdir("origin");
        let proj = d.join("claude/projects/-w");
        fs::create_dir_all(&proj).unwrap();
        use crate::origin::tests::{KILN, PHONE, TERMINAL_IN_SCRATCH};
        fs::write(proj.join("kiln.jsonl"), KILN).unwrap();
        fs::write(proj.join("phone.jsonl"), PHONE).unwrap();
        fs::write(proj.join("scratch-terminal.jsonl"), TERMINAL_IN_SCRATCH).unwrap();
        // A chat coool started in an earlier run: as programmatic as Kiln's.
        fs::write(proj.join("mine.jsonl"), KILN.replace("k1", "mine")).unwrap();
        // A human turn later in an sdk run (e.g. resumed and typed into) counts.
        fs::write(proj.join("big-human.jsonl"), format!("{KILN}{}", claude_transcript(5, 10)).replace("\"cwd\":\"/w\"", "\"cwd\":\"/w\",\"turnOrigin\":\"human\"")).unwrap();
        let day = d.join("codex/sessions").join(crate::codex::date_path(std::time::SystemTime::now()));
        fs::create_dir_all(&day).unwrap();
        let rollout = |id: &str, meta: &str| {
            let n = format!("rollout-2026-11-14T08-00-00-{id}.jsonl");
            let body = format!("{{\"timestamp\":\"2026-11-14T08:00:00Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\",\"cwd\":\"/c\",{meta}}}}}\n{{\"type\":\"turn_context\",\"payload\":{{\"model\":\"gpt-a\"}}}}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"token_count\",\"info\":{{\"total_token_usage\":{{\"input_tokens\":100,\"cached_input_tokens\":0,\"output_tokens\":5}}}}}}}}\n");
            fs::write(day.join(n), body).unwrap();
        };
        let id = |n: u8| format!("01a1da0b-637d-7063-8d51-c27a6ae5f3{n:02x}");
        rollout(&id(1), r#""originator":"codex_exec","source":"exec""#);
        rollout(&id(2), r#""originator":"coool","source":"vscode""#);
        rollout(&id(3), r#""originator":"Codex Desktop","source":"vscode""#);
        rollout(&id(4), &format!(r#""originator":"Codex Desktop","source":{{"subagent":{{"thread_spawn":{{"parent_thread_id":"{}","agent_nickname":"Galileo"}}}}}},"agent_nickname":"Galileo""#, id(3)));
        rollout(&id(5), r#""originator":"Codex Desktop","source":{"subagent":{"thread_spawn":{"parent_thread_id":"gone"}}}"#);
        rollout(&id(6), r#""originator":"coool-selftest","source":"vscode""#);
        // Two Ladder helper chats of "mine" from an earlier run; the person typed into the second one since.
        fs::write(proj.join("helper.jsonl"), KILN.replace("k1", "helper")).unwrap();
        fs::write(proj.join("taken.jsonl"), KILN.replace("k1", "taken")).unwrap();
        let mut own = OwnSessions::at(Some(d.join("own-sessions.json")));
        for x in ["mine", "helper", "taken"] {
            own.record(Provider::Claude, x);
        }
        own.record_parent(Provider::Claude, "helper", "mine");
        own.record_parent(Provider::Claude, "taken", "mine");
        own.record_typed(Provider::Claude, "taken");

        let mut h = hub(&d, false);
        let all = until_loaded(&mut h);
        let o = |sid: &str| all.iter().find(|s| s.id == sid).map(|s| s.origin);
        assert_eq!(o("kiln"), Some(Origin::Automation));
        assert_eq!(o("phone"), Some(Origin::User));
        assert_eq!(o("scratch-terminal"), Some(Origin::User), "classified by how it started, not where");
        assert_eq!(o("mine"), Some(Origin::Coool), "remembered from an earlier run");
        let parent_of = |sid: &str| all.iter().find(|s| s.id == sid).and_then(|s| s.parent.clone());
        assert_eq!((o("helper"), parent_of("helper").as_deref()), (Some(Origin::Coool), Some("mine")), "a helper stays its caller's");
        assert_eq!(parent_of("taken"), None, "a helper the person typed into is theirs");
        assert_eq!(parent_of("mine"), None);
        assert_eq!(o("big-human"), Some(Origin::User));
        assert_eq!(o(&id(1)), Some(Origin::Automation));
        assert_eq!(o(&id(2)), Some(Origin::Coool));
        assert_eq!(o(&id(3)), Some(Origin::User));
        assert_eq!(o(&id(4)), None, "a subagent with a listed parent is not its own session");
        assert_eq!(o(&id(5)), Some(Origin::Automation), "orphan subagent");
        assert_eq!(o(&id(6)), Some(Origin::Automation), "self-test threads are not the person's");
        let parent = all.iter().find(|s| s.id == id(3)).unwrap();
        assert_eq!(parent.agents.len(), 1);
        assert_eq!((parent.agents[0].id.as_str(), parent.agents[0].kind.as_str()), (id(4).as_str(), "Galileo"));
        assert!(parent.models.iter().any(|m| m.via_agent), "the subagent's tokens show under the parent");

        // Unparsed transcripts already know their origin from the head (no flash of automation rows).
        let mut cold = hub(&d, false);
        let first = cold.refresh(false);
        assert_eq!(first.iter().find(|s| s.id == "kiln").map(|s| s.origin), Some(Origin::Automation));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn child_runs_link_to_their_parent_by_scratch_path_and_live_ancestry() {
        use crate::origin::tests::{KILN, TERMINAL_IN_SCRATCH};
        let d = tmpdir("lineage");
        let proj = d.join("claude/projects/-w");
        fs::create_dir_all(&proj).unwrap();
        fs::create_dir_all(d.join("claude/sessions")).unwrap();
        let parent_id = "b1cd1930-6f74-4abe-bf52-13f0eba84069";
        // The person's terminal session...
        fs::write(proj.join(format!("{parent_id}.jsonl")), TERMINAL_IN_SCRATCH.replace("/private/tmp/claude-501/-Users-x-p/s/scratchpad", "/w")).unwrap();
        // ...and a run it left in its scratch folder (ended): attached by the path.
        let scratch = format!("/private/tmp/claude-501/-w/{parent_id}/scratchpad/exp");
        fs::write(proj.join("ended-child.jsonl"), KILN.replace("/Users/x/Library/Application Support/Kiln/agent", &scratch)).unwrap();
        // A live run whose process descends from a live session process: this
        // test process plays the child, its real parent process the parent session.
        let (me, pp) = (std::process::id(), crate::util::parent_pid(std::process::id()).expect("parent pid"));
        let reg = |pid: u32, sid: &str, ep: &str| {
            let started = crate::util::process_start_ms(pid).unwrap_or(0);
            fs::write(d.join(format!("claude/sessions/{pid}.json")), format!(r#"{{"pid":{pid},"sessionId":"{sid}","cwd":"/w","startedAt":{started},"kind":"interactive","entrypoint":"{ep}","status":"busy"}}"#)).unwrap();
        };
        let live_parent = "11111111-2222-4333-8444-555555555555";
        fs::write(proj.join(format!("{live_parent}.jsonl")), TERMINAL_IN_SCRATCH.replace("t1", live_parent)).unwrap();
        fs::write(proj.join("live-child.jsonl"), KILN.replace("k1", "live-child")).unwrap();
        reg(pp, live_parent, "cli");
        reg(me, "live-child", "sdk-cli");
        // An automation run with no known parent stays a parent-less (hidden) run.
        fs::write(proj.join("kiln.jsonl"), KILN).unwrap();

        let mut h = hub(&d, false);
        let all = until_loaded(&mut h);
        let get = |id: &str| all.iter().find(|s| s.id == id).unwrap_or_else(|| panic!("{id} listed"));
        assert_eq!(get("ended-child").parent.as_deref(), Some(parent_id));
        assert_eq!(get(parent_id).live_children, 0, "an ended child is not running");
        assert_eq!(get("live-child").parent.as_deref(), Some(live_parent), "found through the process tree");
        assert_eq!(get(live_parent).live_children, 1);
        assert_eq!(get("kiln").parent, None);
        assert_eq!(get(live_parent).parent, None, "the person's own session is nobody's child");
        // The live link is remembered: once the process is gone, the child stays attached.
        fs::remove_file(d.join(format!("claude/sessions/{me}.json"))).unwrap();
        let mut h2 = hub(&d, false);
        let all = until_loaded(&mut h2);
        let child = all.iter().find(|s| s.id == "live-child").unwrap();
        assert_eq!((child.status, child.parent.as_deref()), (Status::Ended, Some(live_parent)));
        let _ = fs::remove_dir_all(&d);
    }

    /// Helpers a lead starts from its shell become its children, each with its state and span: a foreground
    /// `codex exec` (done), a background one whose shell failed, a detached loop of two (one running, one done),
    /// one with no session file, and a `claude -p` a Codex lead started (record shapes of real sessions, invented
    /// content; crates/core/src/lane_fixtures).
    #[test]
    fn shell_helpers_link_to_their_lead_with_state_and_span() {
        let d = tmpdir("lanes");
        let proj = d.join("claude/projects/-w-lead");
        fs::create_dir_all(&proj).unwrap();
        let day = d.join("codex/sessions").join(crate::codex::date_path(std::time::SystemTime::now()));
        fs::create_dir_all(&day).unwrap();
        let fx = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lane_fixtures");
        for e in fs::read_dir(&fx).unwrap() {
            let p = e.unwrap().path();
            let name = p.file_name().unwrap().to_owned();
            let to = if name.to_string_lossy().starts_with("rollout-") { day.join(name) } else { proj.join(name) };
            // Written, not copied: a copy keeps the fixture's old mtime, and a Codex rollout untouched for 10 min has ended.
            fs::write(to, fs::read(&p).unwrap()).unwrap();
        }
        let mut h = hub(&d, false);
        let all = until_loaded(&mut h);
        let get = |id: &str| all.iter().find(|s| s.id == id).unwrap_or_else(|| panic!("{id} listed"));
        let u = |n: u8| format!("01a1da0b-637d-7063-8d51-c27a6ae5f3{n:02x}");
        let ms = |s: &str| crate::util::parse_rfc3339_ms(s).unwrap();
        let lead = get("lead");
        let lanes: Vec<(&str, u32, Option<&str>, AgentState)> = lead.lanes.iter().map(|l| (l.tool.as_str(), l.index, l.session.as_deref(), l.state)).collect();
        let (a, b, c, dd) = (u(0xa1), u(0xb1), u(0xc1), u(0xd1));
        assert_eq!(
            lanes,
            vec![
                ("t_fg", 0, Some(a.as_str()), AgentState::Done),
                ("t_bg", 0, Some(b.as_str()), AgentState::Failed),
                ("t_loop", 0, Some(c.as_str()), AgentState::Running),
                ("t_loop", 1, Some(dd.as_str()), AgentState::Done),
                ("t_img", 0, None, AgentState::Done),
            ],
            "the progress check (`pgrep -fl \"codex exec\"`) is not a launch"
        );
        for id in [&a, &b, &c, &dd] {
            assert_eq!(get(id).parent.as_deref(), Some("lead"), "{id}");
        }
        assert_eq!(get(&u(0xe1)).parent, None, "a later run in the same folder is not the loop's");
        let la = get(&a).lane.clone().unwrap();
        assert_eq!((la.model.as_deref(), la.cwd.as_deref(), la.brief.as_str()), (Some("gpt-6.2-sol"), Some("/w/wt/a"), "Fix the date parser in src/date.ts and run its tests."));
        assert_eq!((la.started, la.ended), (ms("2026-11-20T10:00:01Z"), Some(ms("2026-11-20T10:02:58Z"))), "its session's own span");
        let lc = get(&c).lane.clone().unwrap();
        assert!(lc.detached && lc.background && lc.ended.is_none());
        assert_eq!(lc.brief, "Read /w/out/brief-c.md and do it.");
        let ld = get(&dd).lane.clone().unwrap();
        assert_eq!(ld.ended, Some(ms("2026-11-20T10:14:10Z")), "not the shell's end two seconds in");
        // A Codex lead's `claude -p`.
        let x = get(&u(0xf1));
        assert_eq!(x.lanes.len(), 1);
        assert_eq!((x.lanes[0].provider, x.lanes[0].model.as_deref(), x.lanes[0].session.as_deref(), x.lanes[0].state), (Provider::Claude, Some("haiku"), Some("kid"), AgentState::Done));
        assert_eq!(get("kid").parent.as_deref(), Some(u(0xf1).as_str()));
        let _ = fs::remove_dir_all(&d);
    }

    /// Read-only check against a real session on this machine: `COOOL_REAL_SESSION=<claude session id> cargo test
    /// -p coool-core real_session_helpers -- --ignored --nocapture`. Reads ~/.claude and ~/.codex (nothing is written
    /// there: no cache, own-sessions in a temp folder) and prints only counts, states, models and durations.
    #[test]
    #[ignore]
    fn real_session_helpers() {
        let Ok(id) = std::env::var("COOOL_REAL_SESSION") else { return eprintln!("set COOOL_REAL_SESSION") };
        let home = dirs::home_dir().unwrap();
        let w = Duration::from_secs(12 * 3600);
        let d = tmpdir("real");
        let mut h = Hub::with_sources(ClaudeSource::with_root(home.join(".claude"), w), CodexSource::with_root(home.join(".codex"), w), None, 3);
        h.set_own_sessions_file(Some(d.join("own-sessions.json")));
        let all = until_loaded(&mut h);
        let s = all.iter().find(|s| s.id == id).expect("session listed");
        let secs = |a: Option<u64>, b: Option<u64>| match (a, b) {
            (Some(a), Some(b)) => format!("{}s", b.saturating_sub(a) / 1000),
            _ => "-".into(),
        };
        println!("lead: provider {:?}, status {:?}, {} subagents, {} shell lanes, {} shells", s.provider, s.status, s.agents.len(), s.lanes.len(), s.shells.len());
        for a in &s.agents {
            // HH:MM:SS of one day, as ms.
            let hms = |t: &str| -> Option<u64> {
                let v: Vec<u64> = t.split(':').map(|x| x.parse().ok()).collect::<Option<_>>()?;
                (v.len() == 3).then(|| (v[0] * 3600 + v[1] * 60 + v[2]) * 1000)
            };
            let ts: Vec<u64> = a.activity.iter().filter_map(|x| hms(&x.ts)).collect();
            println!(
                "  agent: model {}, state {:?}, {} steps, {} tokens, active {} (first to last step)",
                a.model,
                a.state,
                a.activity.iter().filter(|x| x.kind == ActivityKind::Tool).count(),
                a.tokens.total,
                secs(ts.iter().min().copied(), ts.iter().max().copied())
            );
        }
        for l in &s.lanes {
            let kid = l.session.as_ref().and_then(|k| all.iter().find(|x| x.id == *k));
            println!(
                "  lane: {:?} {}, call #{}.{}, background {}, detached {}, state {:?}, {} , session found {}, child status {:?}, child model {}, child output tokens {}, child steps {}",
                l.provider,
                l.model.as_deref().unwrap_or("default"),
                s.lanes.iter().position(|x| x.tool == l.tool).unwrap_or(0),
                l.index,
                l.background,
                l.detached,
                l.state,
                if l.ended.is_some() { format!("ran {}", secs(Some(l.started), l.ended)) } else { format!("running for {}", secs(Some(l.started), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as u64))) },
                kid.is_some(),
                kid.map(|k| k.status),
                kid.map(|k| k.model.as_str()).unwrap_or("-"),
                kid.map(|k| k.tokens.output).unwrap_or(0),
                kid.map(|k| k.activity.iter().filter(|x| x.kind == ActivityKind::Tool).count()).unwrap_or(0),
            );
        }
        for sh in &s.shells {
            println!("  shell: background {}, idle loop {}, label {:?}", sh.background, sh.idle_loop, sh.label);
        }
        let kids = all.iter().filter(|k| k.parent.as_deref() == Some(id.as_str())).count();
        println!("children linked to it: {kids}");
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
