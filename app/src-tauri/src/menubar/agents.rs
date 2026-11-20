//! coool's own picture for the menu bar: how many sessions work, need the person, or are done, which ones need them,
//! and which process belongs to which session. The same reading the app's sidebar makes (lib/live.ts `attention` and
//! store.ts `visibleSessions`), done here on the refresh's rows so it holds with the window closed to the Dock.

use serde::Serialize;
use std::collections::{HashMap, HashSet};

use super::stats::{Proc, ProcUse};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Cli {
    Claude,
    Codex,
}

impl Cli {
    pub fn name(self) -> &'static str {
        match self {
            Cli::Claude => "Claude Code",
            Cli::Codex => "Codex",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Run {
    Busy,
    Idle,
    Ended,
}

/// A coool chat's state, from the hub.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatRun {
    Working,
    Waiting,
    Idle,
}

/// One session as the refresh has it (only what this reading needs).
#[derive(Clone, Debug, Default)]
pub struct In {
    pub key: String,
    pub id: String,
    pub cli: Option<Cli>,
    pub title: String,
    pub project: String,
    pub status: Option<Run>,
    pub chat: Option<usize>,
    pub pid: Option<u32>,
    pub automation: bool,
    pub parent: Option<String>,
    pub waiting_for: Option<String>,
    pub insight_needs: Option<String>,
    /// Live subagents, child runs, shells or background tasks (the sidebar shows such an idle session as working).
    pub background: bool,
}

/// One chat coool runs: its state, whether its CLI still runs, and the CLI's pid.
#[derive(Clone, Copy, Debug)]
pub struct ChatIn {
    pub id: usize,
    pub state: ChatRun,
    pub running: bool,
    pub pid: Option<u32>,
    pub cli: Cli,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Need {
    /// The session key the app opens (`claude:<id>`), when the session is listed.
    pub key: Option<String>,
    pub chat: Option<usize>,
    pub title: String,
    pub project: String,
    /// What it waits for, in the sidebar's words.
    pub ask: String,
}

/// The session a process belongs to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Owner {
    pub key: Option<String>,
    pub chat: Option<usize>,
    pub title: String,
    pub cli: Cli,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Agents {
    pub working: u32,
    pub needs: u32,
    pub done: u32,
    /// The ones that need the person, oldest ask first as listed.
    pub needing: Vec<Need>,
    /// CLI pid -> its session.
    #[serde(skip)]
    pub pids: HashMap<i32, Owner>,
}

fn base(p: &str) -> String {
    std::path::Path::new(p).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string())
}

/// The sidebar's reading of every listed session. `show_automation`: Settings' "Show runs started by other tools".
pub fn summarize(rows: &[In], chats: &[ChatIn], show_automation: bool) -> Agents {
    let chat_of: HashMap<usize, &ChatIn> = chats.iter().map(|c| (c.id, c)).collect();
    let live = |s: &In| s.status != Some(Run::Ended);
    let self_needs = |s: &In| live(s) && (s.waiting_for.is_some() || s.insight_needs.is_some());
    let top: Vec<&In> = rows.iter().filter(|s| !s.automation || show_automation || self_needs(s)).collect();
    let ids: HashSet<&str> = top.iter().filter(|s| s.parent.is_none()).map(|s| s.id.as_str()).collect();
    let is_child = |s: &In| s.parent.as_deref().is_some_and(|p| ids.contains(p) && p != s.id);
    let listed: Vec<&In> = rows.iter().filter(|s| top.iter().any(|t| std::ptr::eq(*t, *s)) || is_child(s)).collect();
    // A child's "needs you" surfaces on its parent.
    let mut child_needs: HashMap<&str, String> = HashMap::new();
    for s in listed.iter().filter(|s| is_child(s) && live(s)) {
        let p = s.parent.as_deref().unwrap_or_default();
        if child_needs.contains_key(p) {
            continue;
        }
        let n = s.waiting_for.as_ref().map(|w| format!("A job is waiting for you: {w}")).or_else(|| s.insight_needs.as_ref().map(|n| format!("A job needs you: {n}")));
        if let Some(n) = n {
            child_needs.insert(p, n);
        }
    }

    let mut a = Agents::default();
    let mut chats_seen = HashSet::new();
    for s in &listed {
        let owner = Owner { key: Some(s.key.clone()), chat: s.chat, title: s.title.clone(), cli: s.cli.unwrap_or(Cli::Claude) };
        if let Some(pid) = s.pid {
            a.pids.insert(pid as i32, owner.clone());
        }
        let chat = s.chat.and_then(|c| chat_of.get(&c).copied());
        if let Some(c) = chat {
            chats_seen.insert(c.id);
            if let Some(pid) = c.pid {
                a.pids.insert(pid as i32, owner.clone());
            }
        }
        if is_child(s) {
            continue;
        }
        // A chat that runs says what it does; one that exited leaves discovery's reading.
        let raw = match chat.filter(|c| c.running) {
            Some(c) if c.state == ChatRun::Idle => Run::Idle,
            Some(_) => Run::Busy,
            None => s.status.unwrap_or(Run::Idle),
        };
        let status = if raw == Run::Idle && s.background { Run::Busy } else { raw };
        let approval = chat.is_some_and(|c| c.running && c.state == ChatRun::Waiting);
        let alive = raw != Run::Ended;
        let need = if approval {
            Some("Waiting for your answer".to_string())
        } else if alive && s.waiting_for.is_some() {
            s.waiting_for.as_ref().map(|w| format!("Waiting for you: {w}"))
        } else if alive && child_needs.contains_key(s.id.as_str()) {
            child_needs.get(s.id.as_str()).cloned()
        } else if alive {
            s.insight_needs.clone()
        } else {
            None
        };
        match (need, status) {
            (Some(ask), _) => {
                a.needs += 1;
                a.needing.push(Need { key: Some(s.key.clone()), chat: s.chat, title: s.title.clone(), project: base(&s.project), ask });
            }
            (None, Run::Busy) => a.working += 1,
            (None, Run::Idle) => a.done += 1,
            (None, Run::Ended) => {}
        }
    }
    // Chats the refresh hasn't tied to a session yet (just started): counted as they are.
    for c in chats.iter().filter(|c| c.running && !chats_seen.contains(&c.id)) {
        let title = format!("New {} chat", c.cli.name());
        if let Some(pid) = c.pid {
            a.pids.insert(pid as i32, Owner { key: None, chat: Some(c.id), title: title.clone(), cli: c.cli });
        }
        match c.state {
            ChatRun::Waiting => {
                a.needs += 1;
                a.needing.push(Need { key: None, chat: Some(c.id), title, project: String::new(), ask: "Waiting for your answer".into() });
            }
            ChatRun::Working => a.working += 1,
            ChatRun::Idle => a.done += 1,
        }
    }
    a
}

/// A process row of the menu: what it is and, for an agent's CLI or a tool it runs, which session.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProcRow {
    pub pid: i32,
    pub name: String,
    /// Percent of one core.
    pub cpu: f64,
    pub owner: Option<Owner>,
    /// This is the agent's CLI itself (not a tool it started).
    pub is_cli: bool,
    /// A Claude Code / Codex CLI coool doesn't list (by its name only).
    pub stray_cli: Option<Cli>,
}

/// The CLI a process name says it is (`claude`, `codex`, `codex-<arch>`), if any.
pub fn cli_by_name(name: &str) -> Option<Cli> {
    let n = name.to_ascii_lowercase();
    if n == "claude" {
        Some(Cli::Claude)
    } else if n == "codex" || n.starts_with("codex-") {
        Some(Cli::Codex)
    } else {
        None
    }
}

/// The session `pid` belongs to: its own, or the nearest ancestor's (a `cargo` a Bash tool started), within 12 steps.
pub fn owner_of<'a>(pid: i32, parents: &HashMap<i32, i32>, pids: &'a HashMap<i32, Owner>) -> Option<(&'a Owner, bool)> {
    let mut p = pid;
    for depth in 0..12 {
        if let Some(o) = pids.get(&p) {
            return Some((o, depth == 0));
        }
        match parents.get(&p) {
            Some(&pp) if pp > 1 && pp != p => p = pp,
            _ => return None,
        }
    }
    None
}

/// The busiest `n` processes, each tied to its session when it has one.
pub fn top_rows(uses: &[ProcUse], all: &[Proc], agents: &Agents, n: usize) -> Vec<ProcRow> {
    let parents: HashMap<i32, i32> = all.iter().map(|p| (p.pid, p.ppid)).collect();
    uses.iter().take(n).map(|u| row_of(u, &parents, agents)).collect()
}

fn row_of(u: &ProcUse, parents: &HashMap<i32, i32>, agents: &Agents) -> ProcRow {
    let own = owner_of(u.pid, parents, &agents.pids);
    ProcRow {
        pid: u.pid,
        name: u.name.clone(),
        cpu: u.cpu,
        owner: own.map(|(o, _)| o.clone()),
        is_cli: own.is_some_and(|(_, me)| me),
        stray_cli: if own.is_none() { cli_by_name(&u.name) } else { None },
    }
}

/// Every process tied to a session (for the self-test's check of the mapping).
pub fn owned_rows(uses: &[ProcUse], all: &[Proc], agents: &Agents) -> Vec<ProcRow> {
    let parents: HashMap<i32, i32> = all.iter().map(|p| (p.pid, p.ppid)).collect();
    uses.iter().map(|u| row_of(u, &parents, agents)).filter(|r| r.owner.is_some()).collect()
}

/// CPU of the agents and every tool they run, together (percent of one core).
pub fn agents_cpu(uses: &[ProcUse], all: &[Proc], agents: &Agents) -> f64 {
    let parents: HashMap<i32, i32> = all.iter().map(|p| (p.pid, p.ppid)).collect();
    uses.iter().filter(|u| owner_of(u.pid, &parents, &agents.pids).is_some()).map(|u| u.cpu).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(key: &str, status: Run) -> In {
        In { key: format!("claude:{key}"), id: key.into(), cli: Some(Cli::Claude), title: format!("T {key}"), project: format!("/code/{key}"), status: Some(status), ..Default::default() }
    }

    #[test]
    fn counts_follow_the_sidebar() {
        let rows = vec![
            s("busy", Run::Busy),
            s("idle", Run::Idle),
            s("ended", Run::Ended),
            In { waiting_for: Some("permission to run `rm`".into()), ..s("wait", Run::Idle) },
            In { insight_needs: Some("Pick a colour".into()), ..s("insight", Run::Idle) },
            // An idle session with live background work reads as working.
            In { background: true, ..s("bg", Run::Idle) },
            // Ended sessions don't need anyone, whatever an old insight said.
            In { insight_needs: Some("old".into()), ..s("old", Run::Ended) },
        ];
        let a = summarize(&rows, &[], false);
        assert_eq!((a.working, a.needs, a.done), (2, 2, 1));
        assert_eq!(a.needing.iter().map(|n| (n.title.as_str(), n.ask.as_str(), n.project.as_str())).collect::<Vec<_>>(), vec![("T wait", "Waiting for you: permission to run `rm`", "wait"), ("T insight", "Pick a colour", "insight")]);
    }

    #[test]
    fn a_chat_says_what_it_does() {
        let rows = vec![In { chat: Some(3), ..s("c", Run::Idle) }, In { chat: Some(4), ..s("d", Run::Busy) }, In { chat: Some(5), ..s("e", Run::Busy) }];
        let chats = [
            ChatIn { id: 3, state: ChatRun::Waiting, running: true, pid: Some(300), cli: Cli::Claude },
            ChatIn { id: 4, state: ChatRun::Idle, running: true, pid: Some(400), cli: Cli::Claude },
            // Exited: discovery's reading stands.
            ChatIn { id: 5, state: ChatRun::Working, running: false, pid: None, cli: Cli::Claude },
            // Not tied to a session yet.
            ChatIn { id: 6, state: ChatRun::Working, running: true, pid: Some(600), cli: Cli::Codex },
        ];
        let a = summarize(&rows, &chats, false);
        assert_eq!((a.working, a.needs, a.done), (2, 1, 1));
        assert_eq!(a.needing[0].key.as_deref(), Some("claude:c"));
        assert_eq!(a.needing[0].chat, Some(3));
        assert_eq!(a.pids[&300].key.as_deref(), Some("claude:c"));
        assert_eq!(a.pids[&600], Owner { key: None, chat: Some(6), title: "New Codex chat".into(), cli: Cli::Codex });
    }

    #[test]
    fn automation_runs_hide_unless_they_need_you_and_children_surface_on_parents() {
        let rows = vec![
            In { automation: true, ..s("auto", Run::Busy) },
            In { automation: true, waiting_for: Some("Allow Bash".into()), ..s("autowait", Run::Idle) },
            s("parent", Run::Busy),
            In { parent: Some("parent".into()), automation: true, waiting_for: Some("Allow Bash: blender".into()), pid: Some(77), ..s("child", Run::Idle) },
        ];
        let a = summarize(&rows, &[], false);
        // auto hidden; autowait listed (needs you); the child's ask lands on its parent, not counted twice.
        assert_eq!((a.working, a.needs, a.done), (0, 2, 0));
        let asks: Vec<_> = a.needing.iter().map(|n| n.ask.as_str()).collect();
        assert!(asks.contains(&"A job is waiting for you: Allow Bash: blender"), "{asks:?}");
        assert_eq!(a.pids[&77].key.as_deref(), Some("claude:child"));
        let shown = summarize(&rows, &[], true);
        assert_eq!(shown.working, 1, "the setting shows the busy automation run");
    }

    #[test]
    fn processes_map_to_their_session() {
        let rows = vec![In { pid: Some(100), ..s("a", Run::Busy) }];
        let chats = [ChatIn { id: 1, state: ChatRun::Working, running: true, pid: Some(200), cli: Cli::Codex }];
        let a = summarize(&rows, &chats, false);
        let p = |pid, ppid, name: &str| Proc { pid, ppid, name: name.into(), cpu_ns: 0 };
        let all = vec![p(100, 50, "claude"), p(101, 100, "zsh"), p(102, 101, "cargo"), p(103, 102, "rustc"), p(200, 1, "codex"), p(300, 1, "claude"), p(400, 1, "Safari")];
        let u = |pid, name: &str, cpu| ProcUse { pid, ppid: 0, name: name.into(), cpu };
        let uses = vec![u(103, "rustc", 300.0), u(400, "Safari", 40.0), u(200, "codex", 20.0), u(300, "claude", 10.0), u(100, "claude", 5.0)];
        let rows = top_rows(&uses, &all, &a, 4);
        assert_eq!(rows.len(), 4);
        // rustc, three levels under the CLI: that session's, not the CLI itself.
        assert_eq!((rows[0].owner.as_ref().and_then(|o| o.key.as_deref()), rows[0].is_cli), (Some("claude:a"), false));
        assert_eq!((rows[1].owner.as_ref(), rows[1].stray_cli), (None, None), "Safari is nobody's");
        assert_eq!((rows[2].owner.as_ref().map(|o| o.title.as_str()), rows[2].is_cli), (Some("New Codex chat"), true));
        // A claude coool doesn't list: named for what it is, no session.
        assert_eq!((rows[3].owner.as_ref(), rows[3].stray_cli), (None, Some(Cli::Claude)));
        assert_eq!(agents_cpu(&uses, &all, &a), 325.0);
        assert_eq!(owned_rows(&uses, &all, &a).len(), 3);
        assert_eq!(cli_by_name("codex-aarch64-apple-darwin"), Some(Cli::Codex));
        assert_eq!(cli_by_name("claudette"), None);
        // A parent loop never hangs.
        let looped: HashMap<i32, i32> = [(1000, 1001), (1001, 1000)].into();
        assert!(owner_of(1000, &looped, &a.pids).is_none());
    }
}
