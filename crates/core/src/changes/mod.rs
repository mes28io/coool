//! The Changes view (APP_SPEC "Changes"): every file a chat's agent and its subagents changed, as diffs, with
//! Keep and Undo per hunk, per file, per turn and for the whole chat.
//!
//! **What "before" is.** The transcript, not git. Each edit the CLI records says what the file was right before
//! it (Claude Code's `originalFile`) or how to undo it (Claude's old/new strings, Codex's patch hunks, put back in
//! reverse); chained edit by edit that gives the file's content before the chat's first edit to it, before each
//! turn, and after each edit. Git is not the source because its HEAD mixes in the person's own uncommitted work
//! from before the chat, moves when the agent commits, and isn't there in a folder that isn't a repository. Git is
//! used for what it knows: a deleted file whose content wasn't recorded comes back from HEAD, Keep can stage,
//! Commit commits, a repository in the middle of a merge or rebase is left alone, and for a session that runs
//! outside coool (a terminal) an undo must also pass `git apply -R --check` on the working tree.
//!
//! **Divergence.** A file has diverged when what is on disk isn't what the agent's last edit left (Claude: that
//! edit's exact result; Codex: the file as coool first saw it after the edit). The diff shown is always "before ->
//! now on disk", and the hunks that touch lines changed since the agent's edit are marked `since`: undoing one of
//! those would undo the person's edits too, so it is refused with a question (Undo anyway backs their version up
//! to the Trash first). A file undo on a diverged file first tries to take out only the agent's hunks, keeping
//! the person's edits elsewhere in it; a hunk undo reverses that hunk on the file as it is now and refuses when
//! its lines aren't there any more.
//!
//! **Writes.** Only inside the chat's folder (resolved, symlinks followed, the file itself never a symlink),
//! each one atomic (a temporary file in the same folder renamed over the old one, its permissions kept), deletions
//! to the Trash (the caller's [`Trash`]). Nothing is pushed; `git commit` only through [`commit`].

pub mod diff;
pub mod git;
pub mod record;

use anyhow::{Result, anyhow, bail};
use diff::{CONTEXT, Hunk};
use record::{Edit, Kind, Known, Reader, Reverse};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

/// One transcript to read: the session's own, or a subagent's (`agent`).
#[derive(Clone, Debug)]
pub struct Source {
    pub kind: Kind,
    pub agent: Option<String>,
    pub path: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Scope {
    /// Everything since the chat started.
    Chat,
    /// What isn't kept yet.
    Pending,
    /// One turn (1-based, as [`TurnInfo::n`]).
    Turn(usize),
}

impl Scope {
    pub fn parse(s: &str) -> Scope {
        match s {
            "pending" => Scope::Pending,
            t if t.starts_with("turn:") => t[5..].parse().map(Scope::Turn).unwrap_or(Scope::Chat),
            _ => Scope::Chat,
        }
    }
    fn name(self) -> String {
        match self {
            Scope::Chat => "chat".into(),
            Scope::Pending => "pending".into(),
            Scope::Turn(n) => format!("turn:{n}"),
        }
    }
}

/// What a call is about.
pub struct Request<'a> {
    /// The session ("claude:<id>"), for what the person kept.
    pub key: &'a str,
    /// The chat's working folder: the only place writes go.
    pub cwd: &'a Path,
    pub sources: &'a [Source],
    pub scope: Scope,
    /// A session running outside coool (read from its transcript; undo only through git).
    pub external: bool,
}

/// Moves a file to the Trash.
pub type Trash<'a> = &'a dyn Fn(&Path) -> Result<()>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HunkView {
    pub id: String,
    pub old_start: usize,
    pub old_count: usize,
    pub new_start: usize,
    pub new_count: usize,
    pub added: usize,
    pub removed: usize,
    pub lines: Vec<diff::Line>,
    /// Kept (reviewed) by the person.
    pub kept: bool,
    /// Touches lines changed after the agent's edit (by the person, or another tool).
    pub since: bool,
    /// Why it can't be undone now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FileChange {
    pub path: String,
    pub rel: String,
    /// A move: where it was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_rel: Option<String>,
    /// "added", "modified", "deleted", "renamed", "undone" (back to what it was), "unchanged" (the agent's edits
    /// cancel out).
    pub status: &'static str,
    pub added: usize,
    pub removed: usize,
    pub binary: bool,
    /// Too large to diff: why.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub large: Option<String>,
    /// On disk isn't what the agent's last edit left.
    pub diverged: bool,
    /// coool can't tell what it was before (shown as the agent's patch, nothing to undo).
    pub unknown_base: bool,
    /// Subagents that edited it (ids); empty when only the session did.
    pub agents: Vec<String>,
    /// Turns (1-based) that edited it.
    pub turns: Vec<usize>,
    pub edits: usize,
    /// Every edit (and hunk) of it in this view is kept.
    pub kept: bool,
    /// Staged in git.
    pub staged: bool,
    /// An edit call to it is running.
    pub busy: bool,
    /// The person undid it (epoch ms) and the agent hasn't edited it since.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub undone_at: Option<u64>,
    /// The agent edited it again after the person undid it, and hasn't been told yet.
    pub reedited: bool,
    /// What the agent said right after its last edit of it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub said: Option<String>,
    /// First changed line on the new side (1-based), for "open in editor".
    pub line: usize,
    pub hunks: Vec<HunkView>,
    /// The new side's whole text (the old side's for a deleted file), for "show more" context; None past the cap.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Why the file can't be undone now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TurnInfo {
    pub n: usize,
    pub ts: u64,
    pub prompt: String,
    pub files: usize,
    pub added: usize,
    pub removed: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChangeSet {
    /// Its revision (see [`Changes::load_wire`]).
    pub rev: u64,
    pub root: String,
    pub scope: String,
    pub git: Option<git::GitInfo>,
    pub turns: Vec<TurnInfo>,
    pub files: Vec<FileChange>,
    /// Files with something not kept (any scope).
    pub pending: usize,
    /// Files changed in the whole chat.
    pub total: usize,
    pub external: bool,
    /// The agent is editing something right now.
    pub busy: bool,
}

/// What an action did.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Outcome {
    pub ok: bool,
    pub message: String,
    /// Files written or trashed (relative).
    pub done: Vec<String>,
    /// Files left alone, and why.
    pub refused: Vec<(String, String)>,
    /// The action needs the person's go-ahead: the question (the UI offers "anyway", which sends `force`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask: Option<String>,
    /// For a commit: its short sha.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

/// What the person kept and undid in one session, saved as JSON.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Review {
    /// Kept edits (tool call ids) per file.
    #[serde(default)]
    pub kept: HashMap<String, HashSet<String>>,
    /// Kept hunks (fingerprints) per file.
    #[serde(default)]
    pub hunks: HashMap<String, HashSet<String>>,
    /// Undos per file: when, and the last edit then (to see the agent edit it again).
    #[serde(default)]
    pub undone: HashMap<String, Undone>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Undone {
    pub at: u64,
    pub last_tool: String,
    #[serde(default)]
    pub told: bool,
    /// What coool left in the file (None: removed): the new baseline for "edited since" until the agent edits it again.
    #[serde(default)]
    pub left: Option<Option<String>>,
}

/// A file's content: None when it doesn't exist.
type St = Option<String>;

/// One file's edits in order, and its content before and after each one (None where it isn't known).
struct Chain {
    path: PathBuf,
    from: Option<PathBuf>,
    edits: Vec<Edit>,
    pre: Vec<Option<St>>,
    post: Vec<Option<St>>,
    /// Its edits (tool ids, times, turns, moves) as a key.
    sig: u64,
}

#[derive(Debug)]
struct Disk {
    st: St,
    binary: bool,
}

fn read_disk(p: &Path) -> Disk {
    match std::fs::read(p) {
        Ok(b) if diff::is_binary(&b) => Disk { st: Some(String::new()), binary: true },
        Ok(b) => Disk { st: Some(String::from_utf8(b).unwrap_or_default()), binary: false },
        Err(_) => Disk { st: None, binary: false },
    }
}

fn known(k: &Known) -> Option<St> {
    match k {
        Known::Absent => Some(None),
        Known::Text(t) => Some(Some(t.clone())),
        Known::Unknown => None,
    }
}

/// Text past this size isn't sent for "show more".
const TEXT_CAP: usize = 400 * 1024;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The engine. Per session (its key), kept between calls: the transcript readers (read incrementally, only what was
/// appended), the files' edit chains (rebuilt only for a file that got a new edit), and each file's view per scope
/// (worked out again only when something it depends on changed: its edits, the file on disk (size, mtime, inode),
/// what the person kept or undid, staged, being edited, what the agent said after). A call costs a `stat` per file
/// when nothing changed. Every view and every set gets a revision number when its content changes, so the app asks
/// with the revision it has and gets back only what is new ([`Changes::load_wire`]). Sessions are locked one by one:
/// a long call on one never holds up another; the map of sessions is locked only to find one.
pub struct Changes {
    sessions: std::sync::Mutex<HashMap<String, std::sync::Arc<std::sync::Mutex<Sess>>>>,
    state_dir: Option<PathBuf>,
    /// Revisions: one counter for everything (starts at the time, so a revision from before a restart is never reused).
    rev: std::sync::atomic::AtomicU64,
}

/// One session's state between calls.
#[derive(Default)]
struct Sess {
    readers: HashMap<PathBuf, Reader>,
    /// Codex: the file right after an edit, as first seen (path, tool id) -> content.
    seen_after: HashMap<(PathBuf, String), St>,
    /// `resolved()` of the paths seen (only those whose folder existed).
    resolved: HashMap<PathBuf, PathBuf>,
    /// What the chains were built from (the sources and how many edits and turns each had).
    chains_key: u64,
    chains: Vec<Chain>,
    turns: Vec<record::Turn>,
    said: Vec<record::Said>,
    busy: HashSet<PathBuf>,
    /// The view of a file in a scope, and the key it was worked out for.
    memo: HashMap<(PathBuf, Scope), Memo>,
    /// A file's lines added and removed in one turn (for the turn list).
    counts: HashMap<(PathBuf, usize), (u64, Option<(usize, usize)>)>,
    /// Per (scope, summary): the set's key and revision.
    sets: HashMap<(Scope, bool), (u64, u64)>,
    /// The turn list's key and revision.
    turns_rev: (u64, u64),
    /// What the person kept and undid, with the file's (size, mtime) and a count of coool's own saves.
    review: Option<((u64, u128, u64), Review)>,
    saves: u64,
}

struct Memo {
    key: u64,
    file: Option<FileChange>,
    rev: u64,
}

/// What [`Changes::load_wire`] sends: the revision, and the set when it is newer than the one the app has.
#[derive(Clone, Debug, Serialize)]
pub struct Wire {
    pub rev: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set: Option<WireSet>,
}

/// A [`ChangeSet`] as sent: files the app already has (same revision) as their path only; the turns only when they
/// changed; no files at all for a summary (the header's count).
#[derive(Clone, Debug, Serialize)]
pub struct WireSet {
    pub rev: u64,
    pub root: String,
    pub scope: String,
    pub git: Option<git::GitInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turns: Option<Vec<TurnInfo>>,
    pub files: Vec<WireFile>,
    pub pending: usize,
    pub total: usize,
    pub external: bool,
    pub busy: bool,
    /// Files the agent edited again after the person undid them, not told yet: (path, rel).
    pub reedited: Vec<(String, String)>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum WireFile {
    /// Unchanged since the revision the app has.
    Same { path: String, same: bool },
    Full(FileChange),
}

fn hash_of(x: impl std::hash::Hash) -> u64 {
    use std::hash::Hasher;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    x.hash(&mut h);
    h.finish()
}

/// A file's size, mtime (ns) and inode; None when it isn't there.
fn stat_sig(p: &Path) -> Option<(u64, u128, u64)> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(p).ok()?;
    let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
    Some((m.len(), t, m.ino()))
}

/// What the person kept and undid for one file, as a key.
fn review_sig(r: &Review, key: &str) -> u64 {
    let mut kept: Vec<&String> = r.kept.get(key).map(|s| s.iter().collect()).unwrap_or_default();
    kept.sort();
    let mut hunks: Vec<&String> = r.hunks.get(key).map(|s| s.iter().collect()).unwrap_or_default();
    hunks.sort();
    let u = r.undone.get(key).map(|u| (u.at, &u.last_tool, u.told, &u.left));
    hash_of((kept, hunks, u))
}

/// The indices of a chain's edits in `scope`.
fn scope_idx(c: &Chain, scope: Scope, review: &Review) -> Vec<usize> {
    let kept = review.kept.get(c.path.to_string_lossy().as_ref());
    (0..c.edits.len())
        .filter(|&i| match scope {
            Scope::Chat => true,
            Scope::Pending => !kept.is_some_and(|k| k.contains(&c.edits[i].tool_id)),
            Scope::Turn(t) => c.edits[i].turn == t,
        })
        .collect()
}

/// What the agent said right after edit `last` of the chain, before the next prompt.
fn said_after<'a>(c: &Chain, last: usize, turns: &[record::Turn], said: &'a [record::Said]) -> Option<&'a str> {
    let ets = c.edits[last].ts;
    let next_turn = turns.iter().map(|t| t.ts).find(|&t| t > ets).unwrap_or(u64::MAX);
    said.iter().find(|s| s.ts >= ets && s.ts < next_turn).map(|s| s.text.as_str())
}

impl Sess {
    /// Reads what was appended to each transcript; rebuilds the chains of files that got new edits.
    fn refresh(&mut self, req: &Request, git: Option<&git::GitInfo>) {
        let mut key = Vec::new();
        let mut busy = HashSet::new();
        for s in req.sources {
            let len = std::fs::metadata(&s.path).map(|m| m.len()).unwrap_or(0);
            let r = self.readers.entry(s.path.clone()).or_insert_with(|| Reader::new(s.kind, s.agent.clone(), req.cwd));
            if len < r.offset {
                *r = Reader::new(s.kind, s.agent.clone(), req.cwd);
            }
            if len > r.offset
                && let Ok(mut f) = std::fs::File::open(&s.path)
            {
                use std::io::{Read, Seek, SeekFrom};
                let mut buf = Vec::new();
                if f.seek(SeekFrom::Start(r.offset)).is_ok() && f.take(len - r.offset).read_to_end(&mut buf).is_ok() {
                    r.feed(&buf);
                }
            }
            key.push((s.path.clone(), r.edits.len(), r.edits.last().map(|e| e.tool_id.clone()), r.turns.len()));
            if s.agent.is_none() {
                if r.turns.len() != self.turns.len() || r.turns.last().map(|t| t.ts) != self.turns.last().map(|t| t.ts) {
                    self.turns = r.turns.clone();
                }
                if r.said.len() != self.said.len() || r.said.last().map(|t| t.ts) != self.said.last().map(|t| t.ts) {
                    self.said = r.said.clone();
                }
            }
            busy.extend(r.busy());
        }
        self.busy = busy;
        // Readers of transcripts no longer named are dropped.
        self.readers.retain(|p, _| req.sources.iter().any(|s| s.path == *p));
        let key = hash_of(key);
        if key == self.chains_key {
            return;
        }
        self.chains_key = key;
        self.rebuild(req, git);
    }

    /// The chains from the readers' edits, oldest first; a file's chain is kept as it was while its edits are.
    fn rebuild(&mut self, req: &Request, git: Option<&git::GitInfo>) {
        let mut all: Vec<&Edit> = req.sources.iter().filter_map(|s| self.readers.get(&s.path)).flat_map(|r| r.edits.iter()).collect();
        all.sort_by(|a, b| a.ts.cmp(&b.ts).then(a.seq.cmp(&b.seq)));
        let turns = &self.turns;
        // Turns by time (subagents' edits fall into the turn that ran them).
        let turn_of = |e: &Edit| if e.agent.is_some() || e.turn == 0 { turns.iter().take_while(|t| t.ts <= e.ts || t.ts == 0).count() } else { e.turn };
        let cache = &mut self.resolved;
        let mut res = |p: &Path| -> PathBuf {
            if let Some(r) = cache.get(p) {
                return r.clone();
            }
            let r = resolved(p);
            if p.parent().is_some_and(|d| d.exists()) {
                cache.insert(p.to_path_buf(), r.clone());
            }
            r
        };
        // One name per file (/tmp and /private/tmp are the same folder), in order of first edit.
        let mut order: Vec<PathBuf> = Vec::new();
        let mut groups: HashMap<PathBuf, Vec<(&Edit, usize, Option<PathBuf>)>> = HashMap::new();
        for e in all {
            let p = res(&e.path);
            let from = e.from.as_deref().map(&mut res);
            let g = groups.entry(p.clone()).or_insert_with(|| {
                order.push(p.clone());
                Vec::new()
            });
            g.push((e, turn_of(e), from));
        }
        let mut old: HashMap<PathBuf, Chain> = std::mem::take(&mut self.chains).into_iter().map(|c| (c.path.clone(), c)).collect();
        let mut chains = Vec::with_capacity(order.len());
        for p in order {
            let g = &groups[&p];
            let sig = hash_of(g.iter().map(|(e, t, f)| (&e.tool_id, e.ts, *t, f)).collect::<Vec<_>>());
            if let Some(c) = old.remove(&p).filter(|c| c.sig == sig) {
                chains.push(c);
                continue;
            }
            let edits: Vec<Edit> = g
                .iter()
                .map(|(e, t, f)| {
                    let mut e = (*e).clone();
                    e.path = p.clone();
                    e.from = f.clone();
                    e.turn = *t;
                    e
                })
                .collect();
            chains.push(build_chain(p.clone(), edits, sig, &mut self.seen_after, git));
        }
        self.chains = chains;
    }

    /// What the person kept and undid, read again only when its file changed.
    fn load_review(&mut self, eng: &Changes, key: &str) {
        let sig = eng.review_path(key).and_then(|p| stat_sig(&p)).map(|(l, t, _)| (l, t, self.saves)).unwrap_or((0, 0, self.saves));
        if self.review.as_ref().is_none_or(|(s, _)| *s != sig) {
            self.review = Some((sig, eng.review(key)));
        }
    }
}

/// One file's chain: its edits in order, and its content before and after each one where it can be told.
fn build_chain(path: PathBuf, edits: Vec<Edit>, sig: u64, seen_after: &mut HashMap<(PathBuf, String), St>, git: Option<&git::GitInfo>) -> Chain {
    // A move: where it was before its first edit.
    let from = edits.first().and_then(|e| e.from.clone());
    let mut c = Chain { path, from, edits, pre: Vec::new(), post: Vec::new(), sig };
    let n = c.edits.len();
    c.pre = c.edits.iter().map(|e| known(&e.before)).collect();
    c.post = c.edits.iter().map(|e| known(&e.after)).collect();
    if c.post[n - 1].is_none() {
        // What the agent's last edit left: as first seen after it (Codex), else the file now.
        let k = (c.path.clone(), c.edits[n - 1].tool_id.clone());
        let now = seen_after.entry(k).or_insert_with(|| {
            let d = read_disk(&c.path);
            if d.binary { None } else { d.st }
        });
        c.post[n - 1] = Some(now.clone());
    }
    for i in (0..n).rev() {
        if c.post[i].is_none() && i + 1 < n {
            c.post[i] = c.pre[i + 1].clone();
        }
        if c.pre[i].is_none() {
            c.pre[i] = match (&c.post[i], &c.edits[i].reverse) {
                (Some(Some(t)), Reverse::Strings(p)) => record::reverse_strings(t, p).map(Some),
                (Some(Some(t)), Reverse::Patch(h)) => record::apply_patch_hunks(t, h, true).map(Some),
                // A delete without its content: what HEAD has.
                (Some(None), _) => git.and_then(|g| git::head_content(Path::new(&g.top), c.edits[i].from.as_deref().unwrap_or(&c.path))).map(Some),
                _ => None,
            };
        }
        if i > 0 && c.post[i - 1].is_none() {
            c.post[i - 1] = c.pre[i].clone();
        }
    }
    c
}

impl Changes {
    pub fn new(state_dir: Option<PathBuf>) -> Self {
        Self { sessions: Default::default(), state_dir, rev: std::sync::atomic::AtomicU64::new(now_ms()) }
    }

    fn next_rev(&self) -> u64 {
        self.rev.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
    }

    fn sess(&self, key: &str) -> std::sync::Arc<std::sync::Mutex<Sess>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).entry(key.to_string()).or_default().clone()
    }

    fn review_path(&self, key: &str) -> Option<PathBuf> {
        let safe: String = key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
        self.state_dir.as_ref().map(|d| d.join(format!("{safe}.json")))
    }

    pub fn review(&self, key: &str) -> Review {
        self.review_path(key).and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn save_review(&self, s: &mut Sess, key: &str, r: &Review) -> Result<()> {
        s.saves += 1;
        let Some(p) = self.review_path(key) else { return Ok(()) };
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d)?;
        }
        write_atomic(&p, serde_json::to_string(r)?.as_bytes())
    }

    /// The change set for `req.scope`, in full.
    pub fn load(&self, req: &Request) -> ChangeSet {
        let s = self.load_wire(req, 0, false).set.expect("a full load has its set");
        ChangeSet {
            rev: s.rev,
            root: s.root,
            scope: s.scope,
            git: s.git,
            turns: s.turns.unwrap_or_default(),
            files: s
                .files
                .into_iter()
                .filter_map(|f| match f {
                    WireFile::Full(f) => Some(f),
                    WireFile::Same { .. } => None,
                })
                .collect(),
            pending: s.pending,
            total: s.total,
            external: s.external,
            busy: s.busy,
        }
    }

    /// The change set for `req.scope` as newer than revision `since` (0: all of it): no set when the app has it
    /// already, the files it has as their path only. `summary`: counts, turns and re-edited files only (no diffs).
    pub fn load_wire(&self, req: &Request, since: u64, summary: bool) -> Wire {
        let root = canonical_root(req.cwd);
        let gi = git::info_cached(&root);
        let arc = self.sess(req.key);
        let mut guard = arc.lock().unwrap_or_else(|e| e.into_inner());
        let s = &mut *guard;
        s.refresh(req, gi.as_ref());
        s.load_review(self, req.key);
        let Sess { chains, turns, said, busy, memo, counts, review, turns_rev, sets, .. } = s;
        let review = &review.as_ref().expect("loaded above").1;
        let ctx = Ctx { root: &root, git: gi.as_ref(), busy, said, turns, review, external: req.external };
        let mut files = Vec::new();
        let mut list = Vec::new();
        let (mut pending, mut total) = (0, 0);
        let mut reedited = Vec::new();
        let mut tinfo: Vec<TurnInfo> = turns.iter().enumerate().map(|(i, t)| TurnInfo { n: i + 1, ts: t.ts, prompt: t.prompt.clone(), files: 0, added: 0, removed: 0 }).collect();
        for c in chains.iter() {
            let disk = stat_sig(&c.path);
            if let Some(f) = self.memo_view(memo, c, Scope::Chat, disk, &ctx).0 {
                if f.status != "unchanged" {
                    total += 1;
                }
                if f.reedited {
                    reedited.push((f.path.clone(), f.rel.clone()));
                }
            }
            if self.memo_view(memo, c, Scope::Pending, disk, &ctx).0.is_some() {
                pending += 1;
            }
            let (f, rev) = self.memo_view(memo, c, req.scope, disk, &ctx);
            if let Some(f) = f {
                list.push((f.path.clone(), rev));
                if !summary {
                    files.push(if rev > since { WireFile::Full(f.clone()) } else { WireFile::Same { path: f.path.clone(), same: true } });
                }
            }
            // The turns it changed, with its lines added and removed in each.
            let ts: std::collections::BTreeSet<usize> = c.edits.iter().map(|e| e.turn).collect();
            for t in ts {
                if t == 0 || t > tinfo.len() {
                    continue;
                }
                let k = hash_of((c.sig, disk, t));
                let e = counts.entry((c.path.clone(), t)).or_insert((k.wrapping_add(1), None));
                if e.0 != k {
                    *e = (k, view(c, Scope::Turn(t), &ctx).map(|v| (v.file.added, v.file.removed)));
                }
                if let Some((a, r)) = e.1 {
                    let ti = &mut tinfo[t - 1];
                    ti.files += 1;
                    ti.added += a;
                    ti.removed += r;
                }
            }
        }
        // Views of files no longer in the chat are dropped now and then.
        if memo.len() > chains.len() * 4 + 16 || counts.len() > chains.iter().map(|c| c.edits.len()).sum::<usize>() + 16 {
            let paths: HashSet<&PathBuf> = chains.iter().map(|c| &c.path).collect();
            memo.retain(|(p, _), _| paths.contains(p));
            counts.retain(|(p, _), _| paths.contains(p));
        }
        let tk = hash_of(tinfo.iter().map(|t| (t.n, t.ts, &t.prompt, t.files, t.added, t.removed)).collect::<Vec<_>>());
        if turns_rev.0 != tk || turns_rev.1 == 0 {
            *turns_rev = (tk, self.next_rev());
        }
        let turns_rev = turns_rev.1;
        let is_busy = !busy.is_empty();
        let sk = hash_of((&root, &gi, pending, total, is_busy, req.external, turns_rev, &reedited, &list));
        let e = sets.entry((req.scope, summary)).or_insert((sk.wrapping_add(1), 0));
        if e.0 != sk {
            *e = (sk, self.next_rev());
        }
        let rev = e.1;
        if rev <= since {
            return Wire { rev, set: None };
        }
        let set = WireSet {
            rev,
            root: root.to_string_lossy().into_owned(),
            scope: req.scope.name(),
            git: gi,
            turns: (turns_rev > since).then_some(tinfo),
            files,
            pending,
            total,
            external: req.external,
            busy: is_busy,
            reedited,
        };
        Wire { rev, set: Some(set) }
    }

    /// A file's view in `scope`, worked out again only when something it depends on changed; with its revision.
    fn memo_view<'m>(&self, memo: &'m mut HashMap<(PathBuf, Scope), Memo>, c: &Chain, scope: Scope, disk: Option<(u64, u128, u64)>, ctx: &Ctx) -> (Option<&'m FileChange>, u64) {
        let key = c.path.to_string_lossy();
        let idx = scope_idx(c, scope, ctx.review);
        let said = idx.last().and_then(|&l| said_after(c, l, ctx.turns, ctx.said));
        let k = hash_of((
            c.sig,
            disk,
            review_sig(ctx.review, &key),
            ctx.git.map(|g| (g.staged.iter().any(|s| *s == *key), &g.busy)),
            ctx.busy.contains(&c.path),
            ctx.external,
            said,
        ));
        let m = memo.entry((c.path.clone(), scope)).or_insert(Memo { key: k.wrapping_add(1), file: None, rev: 0 });
        if m.key != k {
            let f = view(c, scope, ctx).map(|v| v.file);
            if f != m.file || m.rev == 0 {
                m.rev = self.next_rev();
            }
            m.file = f;
            m.key = k;
        }
        (m.file.as_ref(), m.rev)
    }

    /// Undo: one hunk (`hunk`), one file, or every file of the scope (`file` None).
    pub fn undo(&self, req: &Request, file: Option<&str>, hunk: Option<&str>, force: bool, trash: Trash) -> Outcome {
        let root = canonical_root(req.cwd);
        let gi = git::info(&root);
        if let Some(b) = gi.as_ref().and_then(|g| g.busy.clone()) {
            return refused(format!("The repository is in the middle of a {b}. Finish or abort it first; until then changes are read-only."));
        }
        let arc = self.sess(req.key);
        let mut guard = arc.lock().unwrap_or_else(|e| e.into_inner());
        let s = &mut *guard;
        s.refresh(req, gi.as_ref());
        let (chains, turns, said, busy) = (&s.chains, &s.turns, &s.said, &s.busy);
        let mut review = self.review(req.key);
        let ctx = Ctx { root: &root, git: gi.as_ref(), busy, said, turns, review: &review, external: req.external };
        let picked: Vec<&Chain> = chains.iter().filter(|c| file.is_none_or(|f| Path::new(f) == c.path)).collect();
        if picked.is_empty() {
            return refused("That file isn't among this chat's changes any more.".into());
        }
        let mut out = Outcome::default();
        let mut undone_paths = Vec::new();
        for c in picked {
            let Some(v) = view(c, req.scope, &ctx) else { continue };
            let rel = v.file.rel.clone();
            if v.file.status == "undone" || v.file.status == "unchanged" {
                continue;
            }
            match plan_undo(c, &v, req.scope, hunk, force, &ctx) {
                Ok((ops, note)) => {
                    if let Err(e) = check_ops(&ops, &root, req.external, gi.as_ref(), &v) {
                        out.refused.push((rel, e));
                        continue;
                    }
                    match run_ops(&ops, trash) {
                        Ok(()) => {
                            out.done.push(rel.clone());
                            if let Some(n) = note {
                                out.message = n;
                            }
                            let left = ops.iter().rev().find_map(|o| match o {
                                FsOp::Write(p, t) if *p == c.path => Some(Some(t.clone())),
                                FsOp::Trash(p) if *p == c.path => Some(None),
                                _ => None,
                            });
                            undone_paths.push((c.path.to_string_lossy().into_owned(), c.edits.last().map(|e| e.tool_id.clone()).unwrap_or_default(), left));
                        }
                        Err(e) => out.refused.push((rel, format!("{e:#}"))),
                    }
                }
                Err(Refusal::Ask(q)) => {
                    if file.is_some() {
                        out.ask = Some(q);
                    }
                    out.refused.push((rel, "you changed it after the agent did".into()));
                }
                Err(Refusal::No(why)) => out.refused.push((rel, why)),
            }
        }
        if !undone_paths.is_empty() {
            for (p, t, left) in undone_paths {
                review.undone.insert(p, Undone { at: now_ms(), last_tool: t, told: false, left });
            }
            let _ = self.save_review(s, req.key, &review);
        }
        out.ok = !out.done.is_empty() && out.ask.is_none();
        if out.message.is_empty() {
            out.message = summary("Undid", &out);
        }
        out
    }

    /// Keep (or, with `unkeep`, mark unreviewed again): a hunk, a file, or every file of the scope. `stage` also
    /// stages the files in git.
    pub fn keep(&self, req: &Request, file: Option<&str>, hunk: Option<&str>, stage: bool, unkeep: bool) -> Outcome {
        let root = canonical_root(req.cwd);
        let gi = git::info(&root);
        let arc = self.sess(req.key);
        let mut guard = arc.lock().unwrap_or_else(|e| e.into_inner());
        let s = &mut *guard;
        s.refresh(req, gi.as_ref());
        let (chains, turns, said, busy) = (&s.chains, &s.turns, &s.said, &s.busy);
        let mut review = self.review(req.key);
        let mut out = Outcome::default();
        let mut to_stage = Vec::new();
        {
            let snapshot = review.clone();
            let ctx = Ctx { root: &root, git: gi.as_ref(), busy, said, turns, review: &snapshot, external: req.external };
            for c in chains.iter().filter(|c| file.is_none_or(|f| Path::new(f) == c.path)) {
                let Some(v) = view(c, if unkeep { Scope::Chat } else { req.scope }, &ctx) else { continue };
                let key = c.path.to_string_lossy().into_owned();
                if unkeep {
                    review.kept.remove(&key);
                    review.hunks.remove(&key);
                    out.done.push(v.file.rel.clone());
                    continue;
                }
                match hunk {
                    Some(h) => {
                        review.hunks.entry(key.clone()).or_default().insert(h.to_string());
                        let all = v.hunks.iter().all(|x| x.fingerprint() == h || snapshot.hunks.get(&key).is_some_and(|s| s.contains(&x.fingerprint())));
                        if all {
                            review.kept.entry(key.clone()).or_default().extend(v.scope_tools.iter().cloned());
                        }
                    }
                    None => {
                        review.kept.entry(key.clone()).or_default().extend(v.scope_tools.iter().cloned());
                        review.hunks.entry(key.clone()).or_default().extend(v.hunks.iter().map(|x| x.fingerprint()));
                    }
                }
                out.done.push(v.file.rel.clone());
                if stage {
                    to_stage.push(c.path.clone());
                    if let Some(f) = &c.from {
                        to_stage.push(f.clone());
                    }
                }
            }
        }
        if let Err(e) = self.save_review(s, req.key, &review) {
            return refused(format!("couldn't save what you kept: {e:#}"));
        }
        if stage && !to_stage.is_empty() {
            let Some(g) = gi.as_ref() else {
                out.ok = true;
                out.message = "Kept. Not staged: this folder isn't a git repository.".into();
                return out;
            };
            let inside: Vec<PathBuf> = to_stage.into_iter().filter(|p| safe_target(&root, p).is_ok()).collect();
            if let Err(e) = git::stage(Path::new(&g.top), &inside) {
                out.ok = false;
                out.message = format!("Kept, but not staged: {e:#}");
                return out;
            }
            out.message = format!("Kept and staged {}", plural(out.done.len(), "file"));
        }
        out.ok = !out.done.is_empty();
        if out.message.is_empty() {
            out.message = if unkeep { format!("Marked {} as not reviewed", plural(out.done.len(), "file")) } else { summary("Kept", &out) };
        }
        out
    }

    /// Notes about re-edited undone files were sent to the agent.
    pub fn mark_told(&self, key: &str, paths: &[String]) {
        let arc = self.sess(key);
        let mut guard = arc.lock().unwrap_or_else(|e| e.into_inner());
        let mut r = self.review(key);
        for p in paths {
            if let Some(u) = r.undone.get_mut(p) {
                u.told = true;
            }
        }
        let _ = self.save_review(&mut guard, key, &r);
    }
}

/// Commits what is staged in `cwd`'s repository (the person's click; never pushes).
pub fn commit(cwd: &Path, message: &str) -> Outcome {
    let root = canonical_root(cwd);
    let Some(g) = git::info(&root) else { return refused("This folder isn't a git repository.".into()) };
    match git::commit(Path::new(&g.top), message) {
        Ok(sha) => Outcome { ok: true, message: format!("Committed {sha}"), commit: Some(sha), ..Default::default() },
        Err(e) => refused(format!("{e:#}")),
    }
}

fn refused(message: String) -> Outcome {
    Outcome { ok: false, message, ..Default::default() }
}

fn plural(n: usize, w: &str) -> String {
    if n == 1 { format!("1 {w}") } else { format!("{n} {w}s") }
}

fn summary(verb: &str, o: &Outcome) -> String {
    match (o.done.len(), o.refused.len()) {
        (0, 0) => "Nothing to do".into(),
        (1, 0) => format!("{verb} {}", o.done[0]),
        (n, 0) => format!("{verb} {}", plural(n, "file")),
        (0, 1) => format!("{}: {}", o.refused[0].0, o.refused[0].1),
        (0, r) => format!("Nothing done: {} couldn't be changed", plural(r, "file")),
        (n, r) => format!("{verb} {}; {} left as they are", plural(n, "file"), plural(r, "file")),
    }
}

struct Ctx<'a> {
    root: &'a Path,
    git: Option<&'a git::GitInfo>,
    busy: &'a HashSet<PathBuf>,
    said: &'a [record::Said],
    turns: &'a [record::Turn],
    review: &'a Review,
    external: bool,
}

/// A file as the view shows it, with what the actions need.
struct View {
    file: FileChange,
    hunks: Vec<Hunk>,
    base: Option<St>,
    /// The new side (on disk, or after the turn).
    new: St,
    disk: Disk,
    /// What the agent's last edit left.
    agent_after: Option<St>,
    scope_tools: Vec<String>,
}

fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).map(|r| r.to_string_lossy().into_owned()).unwrap_or_else(|_| p.to_string_lossy().into_owned())
}

fn view(c: &Chain, scope: Scope, ctx: &Ctx) -> Option<View> {
    let key = c.path.to_string_lossy().into_owned();
    let kept = ctx.review.kept.get(&key);
    let kept_hunks = ctx.review.hunks.get(&key);
    let idx: Vec<usize> = (0..c.edits.len())
        .filter(|&i| match scope {
            Scope::Chat => true,
            Scope::Pending => !kept.is_some_and(|k| k.contains(&c.edits[i].tool_id)),
            Scope::Turn(t) => c.edits[i].turn == t,
        })
        .collect();
    let (&first, &last) = (idx.first()?, idx.last()?);
    let disk = read_disk(&c.path);
    let base = c.pre[first].clone();
    let new: St = match scope {
        Scope::Turn(_) => c.post[last].clone().unwrap_or_else(|| disk.st.clone()),
        _ => disk.st.clone(),
    };
    // What disk should be if nobody else touched it: the agent's last result, or what coool's own undo left since.
    let agent_after = match ctx.review.undone.get(&key) {
        Some(u) if u.left.is_some() && c.edits.last().is_some_and(|e| e.tool_id == u.last_tool) => u.left.clone(),
        _ => c.post[c.edits.len() - 1].clone(),
    };
    let rel = rel_of(ctx.root, &c.path);
    let mut f = FileChange {
        path: key.clone(),
        rel: rel.clone(),
        from_rel: c.from.as_ref().map(|p| rel_of(ctx.root, p)),
        status: "modified",
        added: 0,
        removed: 0,
        binary: false,
        large: None,
        diverged: false,
        unknown_base: base.is_none(),
        agents: {
            let mut a: Vec<String> = idx.iter().filter_map(|&i| c.edits[i].agent.clone()).collect();
            a.dedup();
            a
        },
        turns: {
            let mut t: Vec<usize> = idx.iter().map(|&i| c.edits[i].turn).filter(|&t| t > 0).collect();
            t.dedup();
            t
        },
        edits: idx.len(),
        kept: false,
        staged: ctx.git.is_some_and(|g| g.staged.contains(&key)),
        busy: ctx.busy.contains(&c.path),
        undone_at: None,
        reedited: false,
        said: None,
        line: 1,
        hunks: Vec::new(),
        text: None,
        blocked: None,
    };
    if let Some(u) = ctx.review.undone.get(&key) {
        let after_undo = c.edits.iter().position(|e| e.tool_id == u.last_tool).map(|p| p + 1 < c.edits.len()).unwrap_or(false);
        if after_undo {
            f.reedited = !u.told;
        } else {
            f.undone_at = Some(u.at);
        }
    }
    // What the agent said after its last edit here, before the next prompt.
    let ets = c.edits[last].ts;
    let next_turn = ctx.turns.iter().map(|t| t.ts).find(|&t| t > ets).unwrap_or(u64::MAX);
    f.said = ctx.said.iter().find(|s| s.ts >= ets && s.ts < next_turn).map(|s| s.text.clone());
    let scope_tools: Vec<String> = idx.iter().map(|&i| c.edits[i].tool_id.clone()).collect();
    f.kept = kept.is_some_and(|k| scope_tools.iter().all(|t| k.contains(t)));

    let Some(base) = base else {
        // Only the agent's patch to go on.
        f.status = if new.is_none() { "deleted" } else { "modified" };
        for &i in &idx {
            if let Reverse::Patch(hs) = &c.edits[i].reverse {
                for h in hs {
                    let lines: Vec<diff::Line> = h.lines.iter().map(|(op, t)| diff::Line { k: match op { diff::Op::Eq => " ", diff::Op::Del => "-", diff::Op::Ins => "+" }, t: t.clone(), o: None, n: None, noeol: false, crlf: false }).collect();
                    let added = lines.iter().filter(|l| l.k == "+").count();
                    let removed = lines.iter().filter(|l| l.k == "-").count();
                    f.added += added;
                    f.removed += removed;
                    f.hunks.push(HunkView { id: format!("p{}-{}", i, f.hunks.len()), old_start: 0, old_count: 0, new_start: 0, new_count: 0, added, removed, lines, kept: false, since: false, blocked: Some("coool can't tell what this file was before".into()) });
                }
            }
        }
        f.blocked = Some("coool can't tell what this file was before this change (it changed since in a way the agent's patch doesn't explain)".into());
        return Some(View { file: f, hunks: Vec::new(), base: None, new, disk, agent_after, scope_tools });
    };
    f.status = match (&base, &new) {
        (None, Some(_)) => {
            if c.from.is_some() {
                "renamed"
            } else {
                "added"
            }
        }
        (Some(_), None) => "deleted",
        (Some(a), Some(b)) if a == b && !disk.binary => {
            if c.from.is_some() {
                "renamed"
            } else if f.undone_at.is_some() {
                "undone"
            } else {
                "unchanged"
            }
        }
        (None, None) => "undone",
        _ => {
            if c.from.is_some() {
                "renamed"
            } else {
                "modified"
            }
        }
    };
    // Nothing left to review: undone (back to before), or the agent's edits cancel out. All still lists them.
    if matches!(f.status, "unchanged" | "undone") && scope == Scope::Pending {
        return None;
    }
    let (a, b) = (base.clone().unwrap_or_default(), new.clone().unwrap_or_default());
    f.diverged = !matches!(scope, Scope::Turn(_)) && (disk.binary || agent_after.as_ref().is_some_and(|x| *x != disk.st));
    let mut hs = Vec::new();
    if disk.binary && !matches!(scope, Scope::Turn(_)) {
        f.binary = true;
    } else if diff::too_large(&a) || diff::too_large(&b) {
        f.large = Some(format!("Too large to show as a diff ({} lines before, {} after)", a.lines().count(), b.lines().count()));
    } else {
        hs = diff::hunks(&a, &b, CONTEXT);
        let since: Vec<usize> = match (f.diverged, &agent_after) {
            (true, Some(Some(aa))) => diff::touched(aa, &b),
            (true, _) => (0..=b.lines().count()).collect(),
            _ => Vec::new(),
        };
        for h in &hs {
            let (s, e) = h.new_span();
            let (added, removed) = h.counts();
            f.added += added;
            f.removed += removed;
            let id = h.fingerprint();
            let blocked = match scope {
                Scope::Turn(_) => match &disk.st {
                    Some(d) if diff::apply(d, std::slice::from_ref(h), true).is_ok() => None,
                    _ => Some("This part has changed since that turn, so it can't be undone on its own".to_string()),
                },
                _ => None,
            };
            f.hunks.push(HunkView {
                id: id.clone(),
                old_start: h.old_start + 1,
                old_count: h.old.len(),
                new_start: h.new_start + 1,
                new_count: h.new.len(),
                added,
                removed,
                lines: h.view(),
                kept: kept_hunks.is_some_and(|k| k.contains(&id)) || f.kept,
                since: since.iter().any(|&i| i >= s && i <= e),
                blocked,
            });
        }
        f.line = f.hunks.first().map(|h| h.lines.iter().find(|l| l.k != " ").and_then(|l| l.n.or(l.o)).unwrap_or(h.new_start as u32) as usize).unwrap_or(1);
        let t = if new.is_some() { &b } else { &a };
        if t.len() <= TEXT_CAP {
            f.text = Some(t.clone());
        }
    }
    if matches!(scope, Scope::Pending) && !f.hunks.is_empty() && f.hunks.iter().all(|h| h.kept) {
        return None;
    }
    if !f.hunks.is_empty() && f.hunks.iter().all(|h| h.kept) {
        f.kept = true;
    }
    f.blocked = blocked_reason(c, &f, ctx);
    Some(View { file: f, hunks: hs, base: Some(base), new, disk, agent_after, scope_tools })
}

fn blocked_reason(c: &Chain, f: &FileChange, ctx: &Ctx) -> Option<String> {
    if f.busy {
        return Some("The agent is changing this file right now. Undo is back once its edit lands.".into());
    }
    if let Some(b) = ctx.git.and_then(|g| g.busy.as_ref()) {
        return Some(format!("The repository is in the middle of a {b}: read-only until it's finished"));
    }
    if safe_target(ctx.root, &c.path).is_err() || c.from.as_ref().is_some_and(|p| safe_target(ctx.root, p).is_err()) {
        return Some("Outside this chat's folder: coool only changes files inside it".into());
    }
    if ctx.external && ctx.git.is_none() {
        return Some("This session runs outside coool: undo works through git, and this folder isn't a git repository".into());
    }
    None
}

/// A hunk's first changed line (new side, else old side), 1-based.
fn first_changed(h: &HunkView) -> usize {
    h.lines.iter().find(|l| l.k != " ").and_then(|l| l.n.or(l.o)).map(|n| n as usize).unwrap_or(h.new_start)
}

enum Refusal {
    /// Needs the person's go-ahead (the question).
    Ask(String),
    No(String),
}

#[derive(Debug)]
enum FsOp {
    Write(PathBuf, String),
    Trash(PathBuf),
    /// A copy of the file to the Trash (the person's version, before overwriting it).
    Backup(PathBuf),
}

/// The writes an undo makes, and a note for the person.
fn plan_undo(c: &Chain, v: &View, scope: Scope, hunk: Option<&str>, force: bool, ctx: &Ctx) -> Result<(Vec<FsOp>, Option<String>), Refusal> {
    if let Some(b) = &v.file.blocked {
        return Err(Refusal::No(b.clone()));
    }
    if v.file.binary {
        return Err(Refusal::No("It's a binary file now, not what the agent wrote: coool won't overwrite it".into()));
    }
    let base = v.base.clone().ok_or_else(|| Refusal::No("coool can't tell what this file was before".into()))?;
    let disk = &v.disk.st;
    let rel = &v.file.rel;
    let to = |content: &St| -> Vec<FsOp> {
        let mut ops = Vec::new();
        match (content, &c.from) {
            (Some(t), Some(from)) => {
                ops.push(FsOp::Write(from.clone(), t.clone()));
                if disk.is_some() {
                    ops.push(FsOp::Trash(c.path.clone()));
                }
            }
            (Some(t), None) => ops.push(FsOp::Write(c.path.clone(), t.clone())),
            (None, _) => {
                if disk.is_some() {
                    ops.push(FsOp::Trash(c.path.clone()));
                }
            }
        }
        ops
    };
    let first_since = |v: &View| v.file.hunks.iter().find(|h| h.since).map(first_changed).unwrap_or(1);
    if let Some(id) = hunk {
        let i = v.file.hunks.iter().position(|h| h.id == id).ok_or_else(|| Refusal::No("That part isn't in the diff any more (the file changed); look again".into()))?;
        let h = &v.hunks[i];
        let hv = &v.file.hunks[i];
        if let Some(b) = &hv.blocked {
            return Err(Refusal::No(b.clone()));
        }
        if hv.since && !force {
            return Err(Refusal::Ask(format!("You changed lines here (around line {}) after the agent's edit. Undoing this part would undo your edits too.", first_changed(hv))));
        }
        let cur = disk.clone().unwrap_or_default();
        let text = diff::apply(&cur, std::slice::from_ref(h), true).map_err(|e| Refusal::No(format!("This part no longer applies ({e}). The file changed since.")))?;
        let mut ops = Vec::new();
        if hv.since {
            ops.push(FsOp::Backup(c.path.clone()));
        }
        if text.is_empty() && base.is_none() {
            ops.push(FsOp::Trash(c.path.clone()));
        } else {
            ops.push(FsOp::Write(c.path.clone(), text));
        }
        return Ok((ops, None));
    }
    match scope {
        Scope::Turn(_) => {
            let after = v.new.clone();
            if *disk == after {
                return Ok((to(&base), None));
            }
            match (&base, &after, disk) {
                (Some(_), Some(_), Some(d)) => {
                    let t = diff::apply(d, &v.hunks, true).map_err(|e| Refusal::No(format!("{rel} changed after that turn ({e}); undo its parts one by one, or the newer turns first")))?;
                    Ok((vec![FsOp::Write(c.path.clone(), t)], None))
                }
                _ => Err(Refusal::No(format!("{rel} changed after that turn, so the turn can't be undone on its own"))),
            }
        }
        _ => {
            if !v.file.diverged || v.file.hunks.iter().all(|h| !h.since) {
                return Ok((to(&base), None));
            }
            // Diverged: take out only the agent's hunks, keeping the person's edits elsewhere.
            if let (Some(Some(b)), Some(Some(aa)), Some(d)) = (&Some(base.clone()), &v.agent_after, disk) {
                let agent = diff::hunks(b, aa, CONTEXT);
                if let Ok(t) = diff::apply(d, &agent, true) {
                    return Ok((vec![FsOp::Write(c.path.clone(), t)], Some(format!("Undid the agent's changes to {rel}; your own edits to it were kept"))));
                }
            }
            if force {
                let mut ops = vec![FsOp::Backup(c.path.clone())];
                ops.extend(to(&base));
                return Ok((ops, Some(format!("Restored {rel} to before the agent; your version is in the Trash"))));
            }
            let _ = ctx;
            Err(Refusal::Ask(format!("You edited {rel} after the agent did (around line {}), in the same lines. Undoing the agent's change would throw your edits away.", first_since(v))))
        }
    }
}

/// Every target inside the chat's folder; a terminal session's undo must also pass git.
fn check_ops(ops: &[FsOp], root: &Path, external: bool, gi: Option<&git::GitInfo>, v: &View) -> Result<(), String> {
    for op in ops {
        let p = match op {
            FsOp::Write(p, _) | FsOp::Trash(p) | FsOp::Backup(p) => p,
        };
        safe_target(root, p).map_err(|e| format!("{e:#}"))?;
    }
    if external {
        let g = gi.ok_or("undo works through git for a session outside coool, and this folder isn't a repository")?;
        let top = Path::new(&g.top);
        for op in ops {
            match op {
                FsOp::Write(p, text) => {
                    let cur = std::fs::read_to_string(p).ok();
                    if let Some(cur) = cur {
                        // The change as a patch on the working tree: git must agree it reverses cleanly.
                        let hs = diff::hunks(text, &cur, CONTEXT);
                        let rel = p.strip_prefix(top).map_err(|_| "outside the repository".to_string())?;
                        git::reverse_applies(top, &unified(&rel.to_string_lossy(), &hs)).map_err(|e| format!("git says it doesn't apply on the working tree: {e}"))?;
                    }
                }
                FsOp::Trash(p) => {
                    if v.file.status == "added" && git::tracked(top, p) {
                        return Err("it's committed or staged in git since the agent created it: undo it with git".into());
                    }
                }
                FsOp::Backup(_) => {}
            }
        }
    }
    Ok(())
}

fn run_ops(ops: &[FsOp], trash: Trash) -> Result<()> {
    for op in ops {
        match op {
            FsOp::Write(p, t) => {
                if let Some(d) = p.parent() {
                    std::fs::create_dir_all(d)?;
                }
                write_atomic(p, t.as_bytes())?
            }
            FsOp::Trash(p) => {
                if p.exists() {
                    trash(p)?
                }
            }
            FsOp::Backup(p) => {
                if p.exists() {
                    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
                    let dir = std::env::temp_dir().join(format!("coool-backup-{}-{}", std::process::id(), now_ms()));
                    std::fs::create_dir_all(&dir)?;
                    let copy = dir.join(format!("{name} (before undo)"));
                    std::fs::copy(p, &copy)?;
                    trash(&copy)?;
                    let _ = std::fs::remove_dir(&dir);
                }
            }
        }
    }
    Ok(())
}

/// A unified diff of `hs` for `rel` (a/ b/ prefixes), as `git apply` reads it.
pub fn unified(rel: &str, hs: &[Hunk]) -> String {
    let mut s = format!("--- a/{rel}\n+++ b/{rel}\n");
    for h in hs {
        let os = if h.old.is_empty() { h.old_start } else { h.old_start + 1 };
        let ns = if h.new.is_empty() { h.new_start } else { h.new_start + 1 };
        s.push_str(&format!("@@ -{os},{} +{ns},{} @@\n", h.old.len(), h.new.len()));
        for (op, l) in &h.lines {
            s.push(match op {
                diff::Op::Eq => ' ',
                diff::Op::Del => '-',
                diff::Op::Ins => '+',
            });
            s.push_str(l);
            if !l.ends_with('\n') {
                s.push_str("\n\\ No newline at end of file\n");
            }
        }
    }
    s
}

/// `p` with its folder resolved (symlinks followed), the name kept; as it is when the folder doesn't exist.
pub fn resolved(p: &Path) -> PathBuf {
    match (p.parent().and_then(|d| d.canonicalize().ok()), p.file_name()) {
        (Some(d), Some(n)) => d.join(n),
        _ => p.to_path_buf(),
    }
}

/// The chat's folder, resolved.
pub fn canonical_root(cwd: &Path) -> PathBuf {
    cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf())
}

/// `p` as a place coool may write: absolute, no `..`, inside `root` once its nearest existing folder is resolved
/// (so a symlinked folder can't lead out), and not itself a symlink.
pub fn safe_target(root: &Path, p: &Path) -> Result<PathBuf> {
    if !p.is_absolute() {
        bail!("not a full path");
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        bail!("the path has '..' in it");
    }
    if std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()) {
        bail!("{} is a symbolic link: coool doesn't write through links", p.display());
    }
    let mut anc = p.parent().ok_or_else(|| anyhow!("no folder"))?.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = vec![p.file_name().ok_or_else(|| anyhow!("no file name"))?.to_os_string()];
    while !anc.exists() {
        rest.push(anc.file_name().ok_or_else(|| anyhow!("no folder"))?.to_os_string());
        anc = anc.parent().ok_or_else(|| anyhow!("no folder"))?.to_path_buf();
    }
    let mut real = anc.canonicalize()?;
    if !real.starts_with(root) {
        bail!("{} is outside this chat's folder", p.display());
    }
    for r in rest.into_iter().rev() {
        real.push(r);
    }
    Ok(real)
}

/// Writes `bytes` to `p` atomically: a temporary file beside it, synced, its mode set to the old file's, renamed over.
pub fn write_atomic(p: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let dir = p.parent().ok_or_else(|| anyhow!("no folder"))?;
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.coool-{}-{}.tmp", std::process::id(), now_ms()));
    let res = (|| -> Result<()> {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        if let Ok(m) = std::fs::metadata(p) {
            std::fs::set_permissions(&tmp, m.permissions())?;
        }
        std::fs::rename(&tmp, p)?;
        Ok(())
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

// ------------------------------------------------------------------------------------------------ preview

/// A pending edit (a permission request) as the diff it would make on the file as it is now, with full context.
/// Read-only. `tool`: Edit / MultiEdit / Write, or apply_patch with `{changes: [{path, kind, move_path, diff}]}`.
pub fn preview(cwd: &Path, tool: &str, input: &serde_json::Value) -> Vec<FileChange> {
    let root = canonical_root(cwd);
    let mut out = Vec::new();
    let mut one = |path: &Path, before: St, after: St, note: Option<String>| {
        let (a, b) = (before.clone().unwrap_or_default(), after.clone().unwrap_or_default());
        let mut f = FileChange {
            path: path.to_string_lossy().into_owned(),
            rel: rel_of(&root, path),
            from_rel: None,
            status: match (&before, &after) {
                (None, _) => "added",
                (_, None) => "deleted",
                _ => "modified",
            },
            added: 0,
            removed: 0,
            binary: false,
            large: None,
            diverged: false,
            unknown_base: false,
            agents: Vec::new(),
            turns: Vec::new(),
            edits: 1,
            kept: false,
            staged: false,
            busy: false,
            undone_at: None,
            reedited: false,
            said: note,
            line: 1,
            hunks: Vec::new(),
            text: None,
            blocked: None,
        };
        if diff::too_large(&a) || diff::too_large(&b) {
            f.large = Some("Too large to show as a diff".into());
        } else {
            for h in diff::hunks(&a, &b, CONTEXT) {
                let (added, removed) = h.counts();
                f.added += added;
                f.removed += removed;
                f.hunks.push(HunkView { id: h.fingerprint(), old_start: h.old_start + 1, old_count: h.old.len(), new_start: h.new_start + 1, new_count: h.new.len(), added, removed, lines: h.view(), kept: false, since: false, blocked: None });
            }
            f.line = f.hunks.first().map(|h| h.new_start).unwrap_or(1);
            let t = if after.is_some() { b } else { a };
            if t.len() <= TEXT_CAP {
                f.text = Some(t);
            }
        }
        out.push(f);
    };
    let read = |p: &Path| -> Option<St> {
        let m = std::fs::metadata(p);
        match m {
            Ok(m) if !m.is_file() || m.len() as usize > diff::MAX_BYTES => None,
            Ok(_) => {
                let d = read_disk(p);
                if d.binary { None } else { Some(d.st) }
            }
            Err(_) => Some(None),
        }
    };
    let abs = |p: &str| resolved(&if Path::new(p).is_absolute() { PathBuf::from(p) } else { root.join(p) });
    match tool {
        "Edit" | "MultiEdit" | "Write" => {
            let Some(fp) = input["file_path"].as_str() else { return out };
            let p = abs(fp);
            let Some(cur) = read(&p) else { return out };
            if tool == "Write" {
                one(&p, cur, Some(input["content"].as_str().unwrap_or("").to_string()), None);
                return out;
            }
            let pairs: Vec<(String, String, bool)> = match input["edits"].as_array() {
                Some(a) => a.iter().map(|e| (e["old_string"].as_str().unwrap_or("").to_string(), e["new_string"].as_str().unwrap_or("").to_string(), e["replace_all"].as_bool().unwrap_or(false))).collect(),
                None => vec![(input["old_string"].as_str().unwrap_or("").to_string(), input["new_string"].as_str().unwrap_or("").to_string(), input["replace_all"].as_bool().unwrap_or(false))],
            };
            match record::forward_strings(cur.as_deref().unwrap_or(""), &pairs) {
                Some(after) => one(&p, cur, Some(after), None),
                None => {
                    // The text to replace isn't in the file as it is now: show the edit itself.
                    let a: String = pairs.iter().map(|x| x.0.clone() + "\n").collect();
                    let b: String = pairs.iter().map(|x| x.1.clone() + "\n").collect();
                    one(&p, Some(a), Some(b), Some("The text it wants to replace isn't in the file as it is now; this is the edit alone.".into()));
                }
            }
        }
        _ => {
            for c in input["changes"].as_array().into_iter().flatten() {
                let Some(path) = c["path"].as_str() else { continue };
                let p = abs(path);
                let kind = c["kind"].as_str().or(c["kind"]["type"].as_str()).unwrap_or("update");
                let text = c["diff"].as_str().unwrap_or("");
                match kind {
                    "add" => {
                        let content = if text.lines().all(|l| l.starts_with('+')) && !text.starts_with("+++ ") { text.lines().map(|l| format!("{}\n", &l[1..])).collect() } else { text.to_string() };
                        one(&p, None, Some(content), None)
                    }
                    "delete" => {
                        let cur = read(&p).flatten().or_else(|| Some(text.to_string()));
                        one(&p, cur, None, None)
                    }
                    _ => {
                        let Some(cur) = read(&p) else { continue };
                        let hs = record::unified_hunks(text);
                        match cur.as_deref().and_then(|t| record::apply_patch_hunks(t, &hs, false)) {
                            Some(after) => one(&p, cur, Some(after), None),
                            None => {
                                let a: String = hs.iter().flat_map(|h| h.lines.iter().filter(|x| x.0 != diff::Op::Ins).map(|x| x.1.clone() + "\n")).collect();
                                let b: String = hs.iter().flat_map(|h| h.lines.iter().filter(|x| x.0 != diff::Op::Del).map(|x| x.1.clone() + "\n")).collect();
                                one(&p, Some(a), Some(b), Some("The patch doesn't match the file as it is now; this is the patch alone.".into()));
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests;
