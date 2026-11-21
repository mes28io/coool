//! Who started a session: the person, coool, or another tool / agent.
//!
//! The rule is "how it was started, never where": a terminal session inside a
//! scratch or app-support folder is still the person's.
//!
//! **Claude Code** writes `entrypoint` on every transcript record (the CLI's own
//! list: `cli`, `claude-vscode`, `claude-desktop`, `local-agent`, `remote`,
//! `github-action`, `sdk-cli`, `sdk-ts`/`sdk-typescript`, `sdk-py`/`sdk-python`,
//! plus `mcp`). The programmatic ones (`sdk-*`, `github-action`, `mcp`) are
//! [`Origin::Automation`] unless a user record says a human typed the turn
//! (`turnOrigin: "human"` or `origin.kind: "human"`, as a session driven from the
//! phone writes). Everything else, and anything missing or unknown, is
//! [`Origin::User`]: nothing is hidden by surprise.
//!
//! **Codex** rollouts start with `session_meta` carrying `originator` (the
//! app-server client's name, `codex_exec` for `codex exec`, `codex_cli_rs` for
//! the TUI) and `source` (`cli`, `vscode`, `exec`, `mcp`, or `{"subagent": ...}`).
//! `exec` / `mcp` / `codex_exec` are automation; [`CLIENT_NAME`] is coool;
//! subagents are attached to their parent thread by the Codex adapter.
//!
//! **coool's own chats** are `sdk-cli` like any other programmatic Claude run, so
//! [`OwnSessions`] remembers their ids in a small file in coool's data folder.

use crate::model::{Origin, Provider};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// coool's `clientInfo.name` for `codex app-server` (recorded as `originator`).
pub const CLIENT_NAME: &str = "coool";
/// The name a self-test run uses instead, so its threads never pass as the person's.
pub const TEST_CLIENT_NAME: &str = "coool-selftest";

/// Claude: from the first `entrypoint` seen and whether a human typed a turn.
pub(crate) fn claude(entrypoint: Option<&str>, human: bool) -> Origin {
    let programmatic = entrypoint.is_some_and(claude_programmatic);
    if programmatic && !human { Origin::Automation } else { Origin::User }
}

/// Codex: from `session_meta`'s `originator` and the kind of `source`
/// (`"subagent"` for an object with that key).
pub(crate) fn codex(originator: &str, source: &str) -> Origin {
    if originator == CLIENT_NAME {
        Origin::Coool
    } else if originator == TEST_CLIENT_NAME || originator == "codex_exec" || matches!(source, "exec" | "mcp" | "subagent") {
        Origin::Automation
    } else {
        Origin::User
    }
}

/// The kind of a Codex `source` value: its string, or the single key of an object.
pub(crate) fn codex_source_kind(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(m) => m.keys().next().cloned().unwrap_or_default(),
        _ => String::new(),
    }
}

// ---------- who started it: the person or an agent ----------

/// Whether the person started a session (and talked to it), or an agent / tool did. History, the sidebar's lists and
/// counts, ⌘K and the New session sheet list the person's by default; [`Starter::Unknown`] is listed with them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Starter {
    Person,
    Agent,
    /// The transcript doesn't say (no entrypoint, an unknown client): shown, never hidden by surprise.
    Unknown,
}

/// What a transcript (and coool's own records) say about how a session started. Metadata only.
#[derive(Clone, Copy, Debug)]
pub struct Facts<'a> {
    pub provider: Provider,
    /// Claude: the first `entrypoint`; Codex: `session_meta.originator`.
    pub entry: &'a str,
    /// Codex: the kind of `session_meta.source`.
    pub source: &'a str,
    /// Claude: a user record a person typed (`turnOrigin`/`origin.kind` "human").
    pub human: bool,
    /// Claude: some record came from an interactive client (`cli`, an IDE, the app): run or resumed by a person.
    pub interactive: bool,
    /// Claude: records marked `isSidechain` (a sub-agent's own transcript).
    pub sidechain: bool,
    /// coool started or drove it ([`OwnSessions::contains`]).
    pub own: bool,
    /// The person typed into it in coool ([`OwnSessions::typed`]).
    pub typed: bool,
    /// The session that started it, when known: a Codex subagent's parent thread, a link coool saw live (a lane, a
    /// child run, a Ladder helper), an agent scratch folder naming its session.
    pub parent: Option<&'a str>,
}

impl Facts<'_> {
    /// Nothing known yet but the CLI.
    pub fn new(provider: Provider) -> Self {
        Facts { provider, entry: "", source: "", human: false, interactive: false, sidechain: false, own: false, typed: false, parent: None }
    }
}

/// Claude entrypoints of interactive clients a person drives.
pub(crate) fn claude_interactive(e: &str) -> bool {
    matches!(e, "cli" | "claude-vscode" | "claude-desktop" | "local-agent") || e.starts_with("remote") || e.contains("jetbrains")
}

/// Claude entrypoints of programmatic runs (`claude -p`, the Agent SDK, CI, MCP).
pub(crate) fn claude_programmatic(e: &str) -> bool {
    e.starts_with("sdk-") || matches!(e, "github-action" | "mcp")
}

/// The rule (see the module docs and APP_SPEC "Who started it"):
/// 1. a person typed in it (a human turn, an interactive client, typing in coool): the person's, even when an agent
///    started it (a headless run continued by hand);
/// 2. otherwise a known parent or a sidechain: an agent's (Ladder helper, lane, child run, sub-agent);
/// 3. otherwise coool started or drove it: the person's (a chat or terminal they opened in coool);
/// 4. otherwise a programmatic run (`claude -p`, SDK, `codex exec`, MCP, a self-test's client): an agent's;
/// 5. an interactive client the CLI names (terminal, IDE, desktop, remote, Codex TUI / app): the person's;
/// 6. anything else: [`Starter::Unknown`].
pub fn started_by(f: &Facts) -> Starter {
    let continued = f.human || f.interactive || f.typed;
    if continued {
        return Starter::Person;
    }
    if f.sidechain || f.parent.is_some_and(|p| !p.is_empty()) {
        return Starter::Agent;
    }
    if f.own {
        return Starter::Person;
    }
    match f.provider {
        Provider::Claude => {
            if claude_programmatic(f.entry) {
                Starter::Agent
            } else if claude_interactive(f.entry) {
                Starter::Person
            } else {
                Starter::Unknown
            }
        }
        Provider::Codex => match codex(f.entry, f.source) {
            Origin::Automation => Starter::Agent,
            Origin::Coool => Starter::Person,
            Origin::User if f.entry.is_empty() && matches!(f.source, "" | "-") => Starter::Unknown,
            Origin::User => Starter::Person,
        },
    }
}

/// Bytes read from the start of a transcript that hasn't been parsed yet.
const SNIFF: u64 = 256 << 10;

/// The origin a transcript's first records state, read cheaply before the full
/// parse gets to it (so programmatic runs never flash into view). None if the
/// head doesn't say (the parse decides later).
pub(crate) fn sniff(path: &Path, provider: Provider) -> Option<Origin> {
    let f = fs::File::open(path).ok()?;
    let mut r = BufReader::new(f.take(SNIFF));
    let mut line = String::new();
    let mut entrypoint: Option<String> = None;
    for _ in 0..64 {
        line.clear();
        if r.read_line(&mut line).ok()? == 0 || !line.ends_with('\n') {
            break;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        match provider {
            Provider::Codex => {
                if v["type"] != "session_meta" {
                    return None;
                }
                let p = &v["payload"];
                return Some(codex(p["originator"].as_str().unwrap_or(""), &codex_source_kind(&p["source"])));
            }
            Provider::Claude => {
                if entrypoint.is_none() {
                    entrypoint = v["entrypoint"].as_str().map(str::to_string);
                }
                if v["type"] == "user" && v["entrypoint"].is_string() {
                    // The first real turn says whether a human typed it.
                    return Some(claude(entrypoint.as_deref(), claude_human(&v)));
                }
            }
        }
    }
    None
}

/// A Claude user record typed by a person.
pub(crate) fn claude_human(v: &serde_json::Value) -> bool {
    v["turnOrigin"] == "human" || v["origin"]["kind"] == "human"
}

// ---------- coool's own sessions ----------

/// Entries kept at most (oldest dropped first).
const MAX_ENTRIES: usize = 5000;
/// Entries not seen for this long are dropped.
const MAX_AGE: Duration = Duration::from_secs(180 * 86400);
/// A remembered session seen again refreshes its date at most this often.
const TOUCH_EVERY: u64 = 86400;

#[derive(Serialize, Deserialize, Default)]
struct File {
    v: u32,
    sessions: Vec<Row>,
    /// Child run -> the session that started it, as found while both were live
    /// (see [`crate::lineage`]), so an ended child stays attached.
    #[serde(default)]
    parents: Vec<ParentRow>,
    /// Sessions the person typed into in coool (a helper or a child run they took over is theirs from then on).
    #[serde(default)]
    typed: Vec<Row>,
}

#[derive(Serialize, Deserialize, Clone)]
struct ParentRow {
    provider: Provider,
    id: String,
    parent: String,
    seen: u64,
}

#[derive(Serialize, Deserialize, Clone)]
struct Row {
    provider: Provider,
    id: String,
    /// Last seen in use by coool, epoch seconds.
    seen: u64,
}

/// Ids of sessions coool started or drove (chats, terminals), kept in
/// `<data dir>/coool/own-sessions.json` so they are still known after a restart.
/// Bounded ([`MAX_ENTRIES`], [`MAX_AGE`]); written atomically, user-only
/// permissions; merged with what is on disk before each write, so two coool
/// processes don't drop each other's entries. Never touches `~/.claude` / `~/.codex`.
pub struct OwnSessions {
    path: Option<PathBuf>,
    ids: HashMap<(Provider, String), u64>,
    parents: HashMap<(Provider, String), (String, u64)>,
    typed: HashMap<(Provider, String), u64>,
}

type Maps = (HashMap<(Provider, String), u64>, HashMap<(Provider, String), (String, u64)>, HashMap<(Provider, String), u64>);

/// Keeps the newest `max` entries of `m` (by their time), dropping ones older than `max_age`.
fn bound<V>(m: &mut HashMap<(Provider, String), V>, seen: impl Fn(&V) -> u64, now: u64) {
    let max_age = MAX_AGE.as_secs();
    m.retain(|_, v| now.saturating_sub(seen(v)) <= max_age);
    if m.len() > MAX_ENTRIES {
        let mut v: Vec<_> = m.iter().map(|(k, x)| (seen(x), k.clone())).collect();
        v.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.1.cmp(&b.1.1)));
        for (_, k) in v.iter().take(m.len() - MAX_ENTRIES) {
            m.remove(k);
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl OwnSessions {
    /// The default file under the user's data folder.
    pub fn default_path() -> Option<PathBuf> {
        dirs::data_dir().map(|d| d.join("coool").join("own-sessions.json"))
    }

    /// Backed by `path` (None: in memory only). Reads what is there now.
    pub fn at(path: Option<PathBuf>) -> Self {
        let mut s = Self { path, ids: HashMap::new(), parents: HashMap::new(), typed: HashMap::new() };
        (s.ids, s.parents, s.typed) = s.read();
        s
    }

    fn read(&self) -> Maps {
        let Some(p) = &self.path else { return Default::default() };
        let f: File = fs::read(p).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        (
            f.sessions.into_iter().map(|r| ((r.provider, r.id), r.seen)).collect(),
            f.parents.into_iter().map(|r| ((r.provider, r.id), (r.parent, r.seen))).collect(),
            f.typed.into_iter().map(|r| ((r.provider, r.id), r.seen)).collect(),
        )
    }

    /// The session that started `id`, as remembered from an earlier sighting.
    pub fn parent_of(&self, provider: Provider, id: &str) -> Option<&str> {
        self.parents.get(&(provider, id.to_string())).map(|(p, _)| p.as_str())
    }

    /// Remembers that `parent` started `id` (written only when new or changed).
    pub fn record_parent(&mut self, provider: Provider, id: &str, parent: &str) {
        if id.is_empty() || parent.is_empty() || id == parent {
            return;
        }
        let key = (provider, id.to_string());
        if self.parents.get(&key).is_some_and(|(p, _)| p == parent) {
            return;
        }
        let now = now_secs();
        self.parents.insert(key, (parent.to_string(), now));
        self.save(now);
    }

    /// Whether the person typed into `id` in coool.
    pub fn typed(&self, provider: Provider, id: &str) -> bool {
        self.typed.contains_key(&(provider, id.to_string()))
    }

    /// Remembers that the person typed into `id` in coool (written only when new, or a day stale).
    pub fn record_typed(&mut self, provider: Provider, id: &str) {
        if id.is_empty() {
            return;
        }
        let now = now_secs();
        let key = (provider, id.to_string());
        if self.typed.get(&key).is_some_and(|t| now.saturating_sub(*t) < TOUCH_EVERY) {
            return;
        }
        self.typed.insert(key, now);
        self.save(now);
    }

    pub fn contains(&self, provider: Provider, id: &str) -> bool {
        self.ids.contains_key(&(provider, id.to_string()))
    }

    /// Remembers that coool started / drove `id`. Writes only when that is new
    /// (or the entry is a day stale), so calling it every refresh is cheap.
    pub fn record(&mut self, provider: Provider, id: &str) {
        if id.is_empty() {
            return;
        }
        let now = now_secs();
        let key = (provider, id.to_string());
        if self.ids.get(&key).is_some_and(|t| now.saturating_sub(*t) < TOUCH_EVERY) {
            return;
        }
        self.ids.insert(key, now);
        self.save(now);
    }

    fn save(&mut self, now: u64) {
        // Merge: another coool process may have added entries since we read.
        let (ids, parents, typed) = self.read();
        for (k, t) in ids {
            let e = self.ids.entry(k).or_insert(t);
            *e = (*e).max(t);
        }
        for (k, t) in typed {
            let e = self.typed.entry(k).or_insert(t);
            *e = (*e).max(t);
        }
        for (k, v) in parents {
            self.parents.entry(k).or_insert(v);
        }
        bound(&mut self.ids, |t| *t, now);
        bound(&mut self.parents, |(_, t)| *t, now);
        bound(&mut self.typed, |t| *t, now);
        let Some(p) = &self.path else { return };
        let mut rows: Vec<Row> = self.ids.iter().map(|((provider, id), seen)| Row { provider: *provider, id: id.clone(), seen: *seen }).collect();
        rows.sort_by(|a, b| b.seen.cmp(&a.seen).then(a.id.cmp(&b.id)));
        let mut prows: Vec<ParentRow> = self.parents.iter().map(|((provider, id), (parent, seen))| ParentRow { provider: *provider, id: id.clone(), parent: parent.clone(), seen: *seen }).collect();
        prows.sort_by(|a, b| b.seen.cmp(&a.seen).then(a.id.cmp(&b.id)));
        let mut trows: Vec<Row> = self.typed.iter().map(|((provider, id), seen)| Row { provider: *provider, id: id.clone(), seen: *seen }).collect();
        trows.sort_by(|a, b| b.seen.cmp(&a.seen).then(a.id.cmp(&b.id)));
        let Ok(body) = serde_json::to_vec(&File { v: 1, sessions: rows, parents: prows, typed: trows }) else { return };
        let _ = write_private(p, &body);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.ids.len()
    }
}

pub(crate) fn write_private(p: &Path, body: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(d) = p.parent() {
        let mut b = fs::DirBuilder::new();
        b.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
        b.create(d)?;
    }
    let tmp = p.with_extension(format!("tmp{}", std::process::id()));
    let mut o = fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let r = o.open(&tmp).and_then(|mut f| f.write_all(body)).and_then(|_| fs::rename(&tmp, p));
    if r.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    r
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::loader::tests::tmpdir;

    #[test]
    fn claude_rule() {
        assert_eq!(claude(Some("cli"), false), Origin::User);
        assert_eq!(claude(Some("claude-vscode"), false), Origin::User);
        assert_eq!(claude(Some("claude-desktop"), false), Origin::User);
        assert_eq!(claude(Some("remote_mobile"), false), Origin::User);
        assert_eq!(claude(Some("sdk-cli"), false), Origin::Automation);
        assert_eq!(claude(Some("sdk-ts"), false), Origin::Automation);
        assert_eq!(claude(Some("sdk-python"), false), Origin::Automation);
        assert_eq!(claude(Some("github-action"), false), Origin::Automation);
        assert_eq!(claude(Some("mcp"), false), Origin::Automation);
        // A person typing through a programmatic client (e.g. from the phone).
        assert_eq!(claude(Some("sdk-cli"), true), Origin::User);
        // Unknown or missing: never hidden by surprise.
        assert_eq!(claude(Some("something-new"), false), Origin::User);
        assert_eq!(claude(None, false), Origin::User);
    }

    #[test]
    fn codex_rule() {
        assert_eq!(codex("coool", "vscode"), Origin::Coool);
        assert_eq!(codex("coool-selftest", "vscode"), Origin::Automation);
        assert_eq!(codex("Codex Desktop", "vscode"), Origin::User);
        assert_eq!(codex("codex_cli_rs", "cli"), Origin::User);
        assert_eq!(codex("codex_vscode", "vscode"), Origin::User);
        assert_eq!(codex("codex_exec", "exec"), Origin::Automation);
        assert_eq!(codex("some_tool", "mcp"), Origin::Automation);
        assert_eq!(codex("Codex Desktop", "subagent"), Origin::Automation);
        assert_eq!(codex("", ""), Origin::User);
        assert_eq!(codex_source_kind(&serde_json::json!({"subagent": {"thread_spawn": {}}})), "subagent");
        assert_eq!(codex_source_kind(&serde_json::json!("exec")), "exec");
    }

    /// Head records as the CLIs write them (trimmed real examples).
    pub(crate) const KILN: &str = r#"{"type":"session-owner","sessionId":"k1"}
{"type":"queue-operation","operation":"enqueue","timestamp":"2026-11-14T12:59:22.385Z","sessionId":"k1","content":"Add a sphere"}
{"parentUuid":null,"isSidechain":false,"type":"user","timestamp":"2026-11-14T12:59:22.472Z","permissionMode":"dontAsk","promptSource":"sdk","turnOrigin":"sdk","userType":"external","entrypoint":"sdk-cli","cwd":"/Users/x/Library/Application Support/Kiln/agent","sessionId":"k1","message":{"role":"user","content":"Add a sphere"}}
"#;
    pub(crate) const PHONE: &str = r#"{"type":"session-owner","sessionId":"p1"}
{"type":"user","timestamp":"2026-11-14T08:41:38.793Z","promptSource":"sdk","turnOrigin":"human","origin":{"kind":"human"},"clientPlatform":"ios","entrypoint":"sdk-cli","cwd":"/Users/x","sessionId":"p1","message":{"role":"user","content":"hey"}}
"#;
    pub(crate) const TERMINAL_IN_SCRATCH: &str = r#"{"type":"mode","mode":"default"}
{"type":"user","timestamp":"2026-11-14T08:41:38.793Z","promptSource":"typed","origin":{"kind":"human"},"entrypoint":"cli","cwd":"/private/tmp/claude-501/-Users-x-p/s/scratchpad","sessionId":"t1","message":{"role":"user","content":"hi"}}
"#;

    #[test]
    fn sniff_reads_the_head() {
        let d = tmpdir("sniff");
        let w = |n: &str, b: &str| {
            let p = d.join(n);
            fs::write(&p, b).unwrap();
            p
        };
        assert_eq!(sniff(&w("k.jsonl", KILN), Provider::Claude), Some(Origin::Automation));
        assert_eq!(sniff(&w("p.jsonl", PHONE), Provider::Claude), Some(Origin::User));
        assert_eq!(sniff(&w("t.jsonl", TERMINAL_IN_SCRATCH), Provider::Claude), Some(Origin::User));
        assert_eq!(sniff(&w("e.jsonl", "{\"type\":\"session-owner\"}\n"), Provider::Claude), None);
        let meta = |orig: &str, src: &str| format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"c\",\"originator\":\"{orig}\",\"source\":{src}}}}}\n");
        assert_eq!(sniff(&w("c1.jsonl", &meta("coool", "\"vscode\"")), Provider::Codex), Some(Origin::Coool));
        assert_eq!(sniff(&w("c2.jsonl", &meta("codex_exec", "\"exec\"")), Provider::Codex), Some(Origin::Automation));
        assert_eq!(sniff(&w("c3.jsonl", &meta("Codex Desktop", "\"vscode\"")), Provider::Codex), Some(Origin::User));
        // A line still being written is not trusted.
        assert_eq!(sniff(&w("c4.jsonl", meta("coool", "\"vscode\"").trim_end()), Provider::Codex), None);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn registry_survives_restart_merges_and_is_bounded() {
        let d = tmpdir("own");
        let p = d.join("sub").join("own-sessions.json");
        let mut a = OwnSessions::at(Some(p.clone()));
        a.record(Provider::Claude, "s1");
        a.record(Provider::Codex, "t1");
        a.record(Provider::Claude, "");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // A later launch sees them; provider matters.
        let mut b = OwnSessions::at(Some(p.clone()));
        assert!(b.contains(Provider::Claude, "s1") && b.contains(Provider::Codex, "t1"));
        assert!(!b.contains(Provider::Codex, "s1"));
        // Two processes writing: neither loses the other's entries.
        a.record(Provider::Claude, "from-a");
        b.record(Provider::Claude, "from-b");
        let c = OwnSessions::at(Some(p.clone()));
        assert!(c.contains(Provider::Claude, "from-a") && c.contains(Provider::Claude, "from-b") && c.contains(Provider::Claude, "s1"));

        // Old entries go; the size cap drops the oldest first.
        let old = now_secs() - MAX_AGE.as_secs() - 10;
        let mut rows = vec![Row { provider: Provider::Claude, id: "ancient".into(), seen: old }];
        for i in 0..MAX_ENTRIES + 3 {
            rows.push(Row { provider: Provider::Claude, id: format!("n{i}"), seen: now_secs() - 1000 + (i as u64 % 500) });
        }
        rows.push(Row { provider: Provider::Claude, id: "newest".into(), seen: now_secs() });
        fs::write(&p, serde_json::to_vec(&File { v: 1, sessions: rows, parents: vec![], typed: vec![] }).unwrap()).unwrap();
        let mut e = OwnSessions::at(Some(p.clone()));
        e.record(Provider::Codex, "fresh");
        assert_eq!(e.len(), MAX_ENTRIES);
        assert!(!e.contains(Provider::Claude, "ancient"));
        assert!(e.contains(Provider::Codex, "fresh") && e.contains(Provider::Claude, "newest"));

        // Parent links persist too, and merge across processes.
        e.record_parent(Provider::Claude, "child", "newest");
        e.record_parent(Provider::Claude, "self", "self");
        let f = OwnSessions::at(Some(p.clone()));
        assert_eq!(f.parent_of(Provider::Claude, "child"), Some("newest"));
        assert_eq!(f.parent_of(Provider::Claude, "self"), None);
        assert_eq!(f.parent_of(Provider::Codex, "child"), None);

        // Garbage on disk is ignored, not fatal.
        fs::write(&p, "not json").unwrap();
        let mut g = OwnSessions::at(Some(p.clone()));
        assert!(!g.contains(Provider::Claude, "s1"));
        g.record(Provider::Claude, "after-garbage");
        assert!(OwnSessions::at(Some(p)).contains(Provider::Claude, "after-garbage"));
        let _ = fs::remove_dir_all(&d);
    }
}

#[cfg(test)]
mod starter_tests {
    use super::*;

    fn f(provider: Provider, entry: &'static str) -> Facts<'static> {
        Facts { entry, ..Facts::new(provider) }
    }

    #[test]
    fn who_started_it() {
        use Starter::*;
        let c = |e| f(Provider::Claude, e);
        // Interactive clients: the person's.
        for e in ["cli", "claude-vscode", "claude-desktop", "remote_mobile", "local-agent", "jetbrains-idea"] {
            assert_eq!(started_by(&c(e)), Person, "{e}");
        }
        // Programmatic: an agent's or another tool's.
        for e in ["sdk-cli", "sdk-ts", "sdk-py", "github-action", "mcp"] {
            assert_eq!(started_by(&c(e)), Agent, "{e}");
        }
        // Can't tell: shown.
        assert_eq!(started_by(&c("")), Unknown);
        assert_eq!(started_by(&c("something-new")), Unknown);
        // coool's own chat: the person's; with a parent (a Ladder helper): an agent's; typed into since: the person's.
        assert_eq!(started_by(&Facts { own: true, ..c("sdk-cli") }), Person);
        assert_eq!(started_by(&Facts { own: true, parent: Some("p"), ..c("sdk-cli") }), Agent);
        assert_eq!(started_by(&Facts { own: true, parent: Some("p"), typed: true, ..c("sdk-cli") }), Person);
        // A sidechain, a lane with its parent: agents'. A headless run continued by hand: the person's.
        assert_eq!(started_by(&Facts { sidechain: true, ..c("sdk-cli") }), Agent);
        assert_eq!(started_by(&Facts { parent: Some("p"), ..c("sdk-cli") }), Agent);
        assert_eq!(started_by(&Facts { parent: Some(""), ..c("sdk-cli") }), Agent);
        assert_eq!(started_by(&Facts { interactive: true, ..c("sdk-cli") }), Person);
        assert_eq!(started_by(&Facts { human: true, ..c("sdk-cli") }), Person);
        // A terminal session in an agent's scratch folder is still the person's.
        assert_eq!(started_by(&Facts { parent: Some("p"), interactive: true, ..c("cli") }), Person);
        // Codex.
        let x = |o, s| Facts { source: s, ..f(Provider::Codex, o) };
        assert_eq!(started_by(&x("codex_cli_rs", "cli")), Person);
        assert_eq!(started_by(&x("Codex Desktop", "vscode")), Person);
        assert_eq!(started_by(&x("codex_vscode", "vscode")), Person);
        assert_eq!(started_by(&x("coool", "vscode")), Person);
        assert_eq!(started_by(&Facts { parent: Some("p"), ..x("coool", "vscode") }), Agent);
        assert_eq!(started_by(&x("codex_exec", "exec")), Agent);
        assert_eq!(started_by(&x("tool", "mcp")), Agent);
        assert_eq!(started_by(&x("coool-selftest", "vscode")), Agent);
        assert_eq!(started_by(&x("Codex Desktop", "subagent")), Agent);
        assert_eq!(started_by(&x("", "")), Unknown);
        assert_eq!(started_by(&x("", "-")), Unknown);
    }
}
