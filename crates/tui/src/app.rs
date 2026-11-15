use coool_core::hub::Hub;
use crate::keys;
use coool_core::model::*;
use crate::theme::Theme;
use crate::ui;
use anyhow::Result;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::DefaultTerminal;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq)]
pub enum RowKey {
    Session(Provider, String),
    Agent(Provider, String, String),
    Pending(usize),
}

#[derive(Clone, Debug)]
pub enum Row {
    Session(usize),
    Agent(usize, usize),
    /// A managed PTY whose transcript hasn't appeared yet.
    Pending(usize),
}

pub enum Mode {
    Normal,
    Attach(usize),
    NewSession { provider: Provider, cwd: String },
    Prompt { managed: usize, input: String },
    ConfirmKill { label: String, target: KillTarget },
    ConfirmQuit,
    Help,
}

#[derive(Clone)]
pub enum KillTarget {
    Managed(usize),
    /// An external Claude session: (pid, session id). Re-validated before signalling.
    Pid(u32, String),
}

pub struct Opts {
    pub theme: Option<bool>,
    pub window_hours: u64,
}

pub struct App {
    pub theme: Theme,
    pub sessions: Vec<Session>,
    pub rows: Vec<Row>,
    pub selected: usize,
    pub hub: Hub,
    pub mode: Mode,
    pub live_only: bool,
    /// Also list sessions other tools / agents started (`a`); off by default.
    pub show_automation: bool,
    /// How many were left out by that (for the header).
    pub hidden_automation: usize,
    pub feed_scroll: u16,
    pub flash: Option<(String, Instant)>,
    pub tick: u64,
    pub attach_size: (u16, u16),
    last_refresh: Instant,
    force_refresh: bool,
    quit: bool,
}

impl App {
    pub fn new(opts: Opts) -> Self {
        let window = Duration::from_secs(opts.window_hours.saturating_mul(3600));
        let mut app = Self {
            theme: Theme::load(opts.theme),
            sessions: Vec::new(),
            rows: Vec::new(),
            selected: 0,
            hub: Hub::new(window),
            mode: Mode::Normal,
            live_only: false,
            show_automation: false,
            hidden_automation: 0,
            feed_scroll: 0,
            flash: None,
            tick: 0,
            attach_size: (24, 80),
            last_refresh: Instant::now(),
            force_refresh: false,
            quit: false,
        };
        app.refresh();
        app
    }

    pub fn run(mut self, terminal: &mut DefaultTerminal) -> Result<()> {
        while !self.quit {
            // While the initial load streams in, look more often.
            let every = if self.hub.loading() { 200 } else { 1000 };
            if self.force_refresh || self.last_refresh.elapsed() >= Duration::from_millis(every) {
                self.refresh();
            }
            if let Mode::Attach(i) = self.mode {
                let (r, c) = self.attach_size;
                match self.hub.get_mut(i) {
                    Some(m) if m.is_running() => m.resize(r, c),
                    _ => {
                        self.mode = Mode::Normal;
                        self.flash("session exited");
                    }
                }
            }
            terminal.draw(|f| ui::draw(f, &mut self))?;
            let timeout = if matches!(self.mode, Mode::Attach(_)) { 16 } else { 100 };
            if event::poll(Duration::from_millis(timeout))? {
                // Drain everything queued so typing in attach mode stays snappy.
                loop {
                    let ev = event::read()?;
                    self.on_event(ev);
                    if !event::poll(Duration::ZERO)? {
                        break;
                    }
                }
            }
            self.tick += 1;
        }
        self.hub.kill_all();
        Ok(())
    }

    /// Refreshes until the initial background load is done, or `timeout`.
    pub fn wait_loaded(&mut self, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        while self.hub.loading() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
            self.refresh();
        }
    }

    pub fn flash(&mut self, msg: impl Into<String>) {
        self.flash = Some((msg.into(), Instant::now()));
    }

    // ---------- data ----------

    fn refresh(&mut self) {
        self.last_refresh = Instant::now();
        self.force_refresh = false;
        let prev_key = self.selected_key();

        self.sessions = self.hub.refresh(self.live_only);
        if !self.show_automation {
            let before = self.sessions.len();
            self.sessions.retain(|s| s.origin != Origin::Automation);
            self.hidden_automation = before - self.sessions.len();
        } else {
            self.hidden_automation = 0;
        }

        self.rows.clear();
        for (i, s) in self.sessions.iter().enumerate() {
            self.rows.push(Row::Session(i));
            for (ai, a) in s.agents.iter().enumerate() {
                // Show running agents of any session, and all agents of live sessions.
                if !a.finished || s.status != Status::Ended {
                    self.rows.push(Row::Agent(i, ai));
                }
            }
        }
        for mi in self.hub.pending(&self.sessions) {
            self.rows.push(Row::Pending(mi));
        }

        if let Some(k) = prev_key {
            let found = self.rows.iter().position(|r| self.row_key(r) == k).or_else(|| match k {
                // A starting PTY whose transcript just appeared becomes a session row.
                RowKey::Pending(m) => self.rows.iter().position(|r| matches!(r, Row::Session(i) if self.sessions[*i].managed == Some(m))),
                _ => None,
            });
            if let Some(i) = found {
                self.selected = i;
            }
        }
        self.selected = self.selected.min(self.rows.len().saturating_sub(1));
    }

    fn row_key(&self, r: &Row) -> RowKey {
        match *r {
            Row::Session(i) => RowKey::Session(self.sessions[i].provider, self.sessions[i].id.clone()),
            Row::Agent(i, a) => RowKey::Agent(self.sessions[i].provider, self.sessions[i].id.clone(), self.sessions[i].agents[a].id.clone()),
            Row::Pending(m) => RowKey::Pending(m),
        }
    }

    fn selected_key(&self) -> Option<RowKey> {
        self.rows.get(self.selected).map(|r| self.row_key(r))
    }

    pub fn selected_session(&self) -> Option<&Session> {
        match self.rows.get(self.selected)? {
            Row::Session(i) | Row::Agent(i, _) => self.sessions.get(*i),
            Row::Pending(_) => None,
        }
    }

    fn selected_managed(&self) -> Option<usize> {
        match self.rows.get(self.selected)? {
            Row::Session(i) => self.sessions[*i].managed,
            Row::Pending(m) => Some(*m),
            Row::Agent(..) => None,
        }
    }

    fn launch(&mut self, provider: Provider, args: Vec<String>, cwd: &str) {
        let (r, c) = self.attach_size;
        match self.hub.spawn(provider, &args, cwd, r, c) {
            Ok(idx) => {
                self.mode = Mode::Attach(idx);
                self.refresh();
            }
            Err(e) => {
                self.mode = Mode::Normal;
                self.flash(format!("couldn't start {}: {e:#}", provider.label()));
            }
        }
    }

    // ---------- input ----------

    fn on_event(&mut self, ev: Event) {
        match ev {
            Event::Key(k) if k.kind != KeyEventKind::Release => self.on_key(k),
            Event::Paste(text) => match &mut self.mode {
                Mode::Attach(i) => {
                    if let Some(Some(m)) = self.hub.managed.get_mut(*i) {
                        let b = m.paste_bytes(&text);
                        m.write(&b);
                    }
                }
                Mode::Prompt { input, .. } => input.push_str(&text),
                Mode::NewSession { cwd, .. } => cwd.push_str(text.trim()),
                _ => {}
            },
            _ => {}
        }
    }

    fn on_key(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        match &mut self.mode {
            Mode::Attach(i) => {
                let i = *i;
                if keys::is_detach(&k) {
                    self.mode = Mode::Normal;
                    return;
                }
                if let Some(Some(m)) = self.hub.managed.get_mut(i) {
                    let b = keys::to_bytes(&k);
                    if !b.is_empty() {
                        m.write(&b);
                    }
                }
            }
            Mode::Help => self.mode = Mode::Normal,
            Mode::ConfirmQuit => match k.code {
                KeyCode::Char('y') | KeyCode::Char('q') | KeyCode::Enter => self.quit = true,
                _ => self.mode = Mode::Normal,
            },
            Mode::ConfirmKill { target, .. } => {
                let target = target.clone();
                self.mode = Mode::Normal;
                if matches!(k.code, KeyCode::Char('y') | KeyCode::Enter) {
                    let sent = match target {
                        KillTarget::Managed(i) => match self.hub.get_mut(i) {
                            Some(m) => {
                                m.kill();
                                true
                            }
                            None => false,
                        },
                        // The pid was read from a registry file up to a second ago (and the
                        // dialog may have been open for longer): make sure it still is that
                        // Claude session and not a recycled pid before signalling it.
                        KillTarget::Pid(pid, sid) => match coool_core::util::valid_pid(pid) {
                            Some(p) if coool_core::claude::live_pid_for(&sid, pid) => {
                                // SAFETY: plain signal delivery to a validated single pid.
                                unsafe { libc::kill(p, libc::SIGTERM) == 0 }
                            }
                            _ => false,
                        },
                    };
                    self.flash(if sent { "stop signal sent" } else { "session is no longer running" });
                    self.force_refresh = true;
                }
            }
            Mode::NewSession { provider, cwd } => match k.code {
                KeyCode::Esc => self.mode = Mode::Normal,
                KeyCode::Tab | KeyCode::BackTab => *provider = provider.toggle(),
                KeyCode::Backspace => {
                    cwd.pop();
                }
                KeyCode::Char('u') if ctrl => cwd.clear(),
                KeyCode::Char(c) if !ctrl => cwd.push(c),
                KeyCode::Enter => {
                    let p = *provider;
                    let dir = expand_tilde(cwd.trim());
                    if std::path::Path::new(&dir).is_dir() {
                        self.launch(p, vec![], &dir);
                    } else {
                        self.flash(format!("not a directory: {dir}"));
                    }
                }
                _ => {}
            },
            Mode::Prompt { managed, input } => match k.code {
                KeyCode::Esc => self.mode = Mode::Normal,
                KeyCode::Backspace => {
                    input.pop();
                }
                KeyCode::Char('u') if ctrl => input.clear(),
                KeyCode::Enter if k.modifiers.intersects(KeyModifiers::SHIFT | KeyModifiers::ALT) => input.push('\n'),
                // ctrl+j is a literal newline in raw mode; most terminals can't send shift+enter.
                KeyCode::Char('j') if ctrl => input.push('\n'),
                KeyCode::Char(c) if !ctrl => input.push(c),
                KeyCode::Enter => {
                    let (mi, text) = (*managed, input.clone());
                    if text.trim().is_empty() {
                        return;
                    }
                    self.mode = Mode::Normal;
                    match self.hub.get_mut(mi) {
                        Some(m) if m.is_running() => {
                            m.send_prompt(&text);
                            self.flash("prompt sent");
                        }
                        _ => self.flash("session is no longer running"),
                    }
                }
                _ => {}
            },
            Mode::Normal => self.on_normal_key(k),
        }
    }

    fn on_normal_key(&mut self, k: KeyEvent) {
        let n = self.rows.len();
        match k.code {
            KeyCode::Char('q') | KeyCode::Esc => {
                let running = self.hub.running_count();
                if running > 0 { self.mode = Mode::ConfirmQuit } else { self.quit = true }
            }
            KeyCode::Char('c') if k.modifiers.contains(KeyModifiers::CONTROL) => self.mode = Mode::ConfirmQuit,
            KeyCode::Down | KeyCode::Char('j')
                if n > 0 => {
                    self.selected = (self.selected + 1).min(n - 1);
                    self.feed_scroll = 0;
                }
            KeyCode::Up | KeyCode::Char('k') => {
                self.selected = self.selected.saturating_sub(1);
                self.feed_scroll = 0;
            }
            KeyCode::Char('g') | KeyCode::Home => {
                self.selected = 0;
                self.feed_scroll = 0;
            }
            KeyCode::Char('G') | KeyCode::End => {
                self.selected = n.saturating_sub(1);
                self.feed_scroll = 0;
            }
            KeyCode::PageUp => self.feed_scroll = self.feed_scroll.saturating_add(10),
            KeyCode::PageDown => self.feed_scroll = self.feed_scroll.saturating_sub(10),
            KeyCode::Char('t') => {
                self.theme = self.theme.toggled();
                self.theme.save();
            }
            KeyCode::Char('f') => {
                self.live_only = !self.live_only;
                self.refresh();
                self.flash(if self.live_only { "showing live sessions" } else { "showing live + recent" });
            }
            KeyCode::Char('a') => {
                self.show_automation = !self.show_automation;
                self.refresh();
                self.flash(if self.show_automation { "showing runs by other tools" } else { "hiding runs by other tools" });
            }
            KeyCode::Char('?') => self.mode = Mode::Help,
            KeyCode::Char('n') => {
                let cwd = self
                    .selected_session()
                    .map(|s| s.cwd.clone())
                    .filter(|c| !c.is_empty())
                    .or_else(|| std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned()))
                    .unwrap_or_default();
                let provider = self.selected_session().map(|s| s.provider).unwrap_or(Provider::Claude);
                self.mode = Mode::NewSession { provider, cwd: coool_core::util::home_short(&cwd) };
            }
            KeyCode::Enter => match self.selected_managed() {
                Some(mi) => self.mode = Mode::Attach(mi),
                None => match self.selected_session() {
                    Some(s) if s.status == Status::Ended => self.flash("session ended — press r to resume it inside coool"),
                    Some(_) => self.flash("running outside coool — r resumes a copy here once it's stopped"),
                    None => {}
                },
            },
            KeyCode::Char('r') => {
                let Some(s) = self.selected_session().cloned() else { return };
                if s.managed.is_some() {
                    self.flash("already running in coool — press enter");
                } else if s.status != Status::Ended {
                    self.flash("still running elsewhere — stop it first (x) to resume here");
                } else if s.id.is_empty() || s.cwd.is_empty() {
                    self.flash("can't resume: missing session id or cwd");
                } else {
                    let args = match s.provider {
                        Provider::Claude => vec!["--resume".into(), s.id.clone()],
                        Provider::Codex => vec!["resume".into(), s.id.clone()],
                    };
                    self.launch(s.provider, args, &s.cwd);
                }
            }
            KeyCode::Char('p') => match self.selected_managed() {
                Some(mi) => self.mode = Mode::Prompt { managed: mi, input: String::new() },
                None => self.flash("prompts can only be sent to sessions launched in coool (n / r)"),
            },
            KeyCode::Char('x') => {
                let label;
                let target = match self.rows.get(self.selected) {
                    Some(Row::Pending(m)) => {
                        label = "starting session".to_string();
                        KillTarget::Managed(*m)
                    }
                    Some(Row::Session(i)) => {
                        let s = &self.sessions[*i];
                        label = display_title(s);
                        match (s.managed, s.pid) {
                            (Some(m), _) => KillTarget::Managed(m),
                            (None, Some(pid)) if s.provider == Provider::Claude && s.status != Status::Ended => KillTarget::Pid(pid, s.id.clone()),
                            _ => {
                                self.flash("no live process to stop");
                                return;
                            }
                        }
                    }
                    _ => {
                        self.flash("select a session to stop");
                        return;
                    }
                };
                self.mode = Mode::ConfirmKill { label, target };
            }
            _ => {}
        }
    }
}

pub fn display_title(s: &Session) -> String {
    s.display_title()
}

fn expand_tilde(p: &str) -> String {
    if let Some(rest) = p.strip_prefix('~')
        && let Some(h) = dirs::home_dir() {
            return format!("{}{rest}", h.to_string_lossy());
        }
    p.to_string()
}
