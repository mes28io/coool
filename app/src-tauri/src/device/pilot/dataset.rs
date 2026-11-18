//! The pilot's decision log, kept for a later fine-tune (APP_SPEC "Device pilot", "Decision log"): every decision a
//! run made, one JSON line each, per project, next to the muscle memory (`<data>/pilot/<project hash>.decisions.jsonl`).
//!
//! A record is the screen as the decider saw it (the typed candidates and the compact summary), the action before,
//! which decider chose (`memory`, `haiku`, `checks` when the success checks held, or `caller` when the calling agent
//! acted after a `stuck` / `surprised`), the chosen id and the decision's latency; once the run ends, its outcome and
//! whether the step was on the path that got to `done`.
//!
//! Privacy: a text field's contents are never stored (only `<filled>`), nor a masked field's; the goal's input
//! *values* are replaced by their key (`<email>`) wherever they show up (labels, page text, the goal, the URL); no
//! screenshots; nothing that looks like an API key. The file stays on this Mac; nothing uploads it. Off with the
//! Settings toggle "Save pilot decisions for training".
//!
//! Size: a project's file rotates to `.decisions.1.jsonl` at [`MAX_FILE`] (the older one goes), and nothing more is
//! written while the whole folder holds more than [`MAX_TOTAL`].

use super::{Action, Goal, Kind, Outcome, Screen, Status, Target, Traced, Verb};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

/// The Settings toggle (on by default).
static ENABLED: AtomicBool = AtomicBool::new(true);

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

/// A project's file rotates at this size.
pub const MAX_FILE: u64 = 20 * 1024 * 1024;
/// Nothing more is written while the folder's logs hold more than this.
pub const MAX_TOTAL: u64 = 200 * 1024 * 1024;
/// Record format version.
pub const VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub v: u32,
    /// Unix ms.
    pub ts: u64,
    /// The run's id (records of one run share it).
    pub run: String,
    pub step: usize,
    /// `iphone` or `browser`.
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub goal: String,
    /// The goal's input names (never their values).
    pub input_keys: Vec<String>,
    /// The success checks, described.
    pub checks: Vec<String>,
    pub screen: ScreenRec,
    /// The action key before (`start` on the run's first screen).
    pub prev: String,
    /// The steps so far as the model reads them.
    #[serde(default)]
    pub history: Vec<String>,
    /// `memory`, `haiku`, `checks` or `caller`.
    pub decider: String,
    /// The chosen candidate's id.
    pub chosen: usize,
    /// The chosen action, described (for people reading the file).
    pub action: String,
    pub decision_ms: u64,
    /// The run's end: `done`, `stuck`, `surprised` or `out_of_budget`.
    pub outcome: String,
    pub verified: bool,
    /// The step is on the path to a `done`; `null` for the caller's choice (its run had ended `stuck` / `surprised`).
    pub on_success_path: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScreenRec {
    /// The compact summary (where, then each element and its state).
    pub summary: String,
    pub candidates: Vec<CandRec>,
}

/// A candidate as stored: `{id, verb, target?, input_key?, dir?}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CandRec {
    pub id: usize,
    pub verb: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<TargetRec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TargetRec {
    pub role: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub frame: [f64; 4],
    pub id: String,
}

// ---------- privacy ----------

/// Scrubs a string: each input value (3+ characters) becomes `<key>`, and anything that looks like an API key goes.
struct Scrub<'a> {
    /// (value, key), longest values first (so "Ada Lovelace" goes before "Ada").
    values: Vec<(&'a str, &'a str)>,
}

impl<'a> Scrub<'a> {
    fn new(inputs: &'a std::collections::BTreeMap<String, String>) -> Self {
        let mut values: Vec<(&str, &str)> = inputs.iter().map(|(k, v)| (v.trim(), k.as_str())).filter(|(v, _)| v.chars().count() >= 3).collect();
        values.sort_by_key(|(v, _)| std::cmp::Reverse(v.len()));
        Scrub { values }
    }

    fn s(&self, t: &str) -> String {
        let mut out = t.to_string();
        for (v, k) in &self.values {
            out = replace_ci(&out, v, &format!("<{k}>"));
        }
        redact_keys(&out)
    }
}

/// `hay` with every `needle` replaced, ignoring case when both are ASCII (an email shown lower-cased, a name in capitals).
fn replace_ci(hay: &str, needle: &str, with: &str) -> String {
    if !hay.is_ascii() || !needle.is_ascii() {
        return hay.replace(needle, with);
    }
    let (lh, ln) = (hay.to_ascii_lowercase(), needle.to_ascii_lowercase());
    let mut out = String::new();
    let mut rest = 0;
    for (i, _) in lh.match_indices(&ln) {
        out.push_str(&hay[rest..i]);
        out.push_str(with);
        rest = i + ln.len();
    }
    out.push_str(&hay[rest..]);
    out
}

/// Drops anything shaped like an Anthropic / OpenAI key (`sk-…`).
fn redact_keys(t: &str) -> String {
    if !t.contains("sk-") {
        return t.to_string();
    }
    let mut out = String::new();
    let mut rest = t;
    while let Some(i) = rest.find("sk-") {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let end = tail.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_')).unwrap_or(tail.len());
        if end >= 20 {
            out.push_str("<redacted>");
        } else {
            out.push_str(&tail[..end]);
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// Masked: a secure field (iOS), a password (web), or a value of only bullets.
fn masked(role: &str, label: &str, value: Option<&str>) -> bool {
    let r = role.to_lowercase();
    r.contains("secure")
        || r.contains("password")
        || label.to_lowercase().contains("password")
        || value.is_some_and(|v| !v.is_empty() && v.chars().all(|c| matches!(c, '•' | '●' | '*' | '·')))
}

/// The screen as stored: text fields and masked fields show only whether they hold something, input values become
/// their key everywhere.
fn clean_screen(s: &Screen, sc: &Scrub) -> Screen {
    let mut c = s.clone();
    for e in &mut c.elems {
        if e.kind == Kind::Input || masked(&e.role, &e.label, e.value.as_deref()) {
            e.value = e.value.as_deref().filter(|v| !v.is_empty()).map(|_| super::FILLED.to_string());
        } else {
            e.value = e.value.as_deref().map(|v| sc.s(v));
        }
        e.label = sc.s(&e.label);
    }
    c.app = sc.s(&c.app);
    c.url = c.url.as_deref().map(|u| sc.s(u));
    c.texts = c.texts.iter().map(|t| sc.s(t)).collect();
    c
}

fn clean_candidates(cands: &[Action], clean: &Screen, sc: &Scrub) -> Vec<CandRec> {
    cands
        .iter()
        .map(|a| CandRec {
            id: a.id,
            verb: a.verb.name().to_string(),
            target: a.target.as_ref().map(|t| {
                // The element as stored (its value already cleaned); else the target, cleaned the same way.
                let e = clean.elems.iter().find(|e| e.handle == t.id);
                let value = match e {
                    Some(e) => e.value.clone(),
                    None if a.verb == Verb::SetText || masked(&t.role, &t.label, t.value.as_deref()) => {
                        t.value.as_deref().filter(|v| !v.is_empty()).map(|_| super::FILLED.to_string())
                    }
                    None => t.value.as_deref().map(|v| sc.s(v)),
                };
                TargetRec { role: t.role.clone(), label: sc.s(&t.label), value, frame: t.frame, id: t.id.clone() }
            }),
            input_key: a.input_key.clone(),
            dir: a.dir.map(String::from),
        })
        .collect()
}

fn status_name(s: Status) -> &'static str {
    match s {
        Status::Done => "done",
        Status::Stuck => "stuck",
        Status::Surprised => "surprised",
        Status::OutOfBudget => "out_of_budget",
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// What every record of a run shares.
struct Base<'a> {
    run: &'a str,
    goal: &'a Goal,
    sc: Scrub<'a>,
    outcome: &'static str,
    verified: bool,
}

impl Base<'_> {
    fn record(&self, t: &Traced, on_path: Option<bool>) -> Record {
        let (step, prev, history, decider, chosen, ms) = (t.step, t.prev.as_str(), &t.history, t.decider, t.chosen, t.ms);
        let clean = clean_screen(&t.screen, &self.sc);
        let candidates = clean_candidates(&t.candidates, &clean, &self.sc);
        let action = t.candidates.get(chosen).map(|a| self.sc.s(&clean_describe(a, &candidates))).unwrap_or_default();

        Record {
            v: VERSION,
            ts: now_ms(),
            run: self.run.to_string(),
            step,
            target: match self.goal.target {
                Target::Iphone => "iphone",
                Target::Browser => "browser",
                Target::Mac => "mac",
            }
            .into(),
            app: self.goal.app.clone(),
            url: self.goal.url.as_deref().map(|u| self.sc.s(u)),
            goal: self.sc.s(&self.goal.goal),
            input_keys: self.goal.inputs.keys().cloned().collect(),
            checks: self.goal.success.iter().map(|c| self.sc.s(&c.describe())).collect(),
            screen: ScreenRec { summary: clean.summary(30), candidates },
            prev: self.sc.s(prev),
            history: history.iter().map(|h| self.sc.s(h)).collect(),
            decider: decider.to_string(),
            chosen,
            action,
            decision_ms: ms,
            outcome: self.outcome.to_string(),
            verified: self.verified,
            on_success_path: on_path,
        }
    }
}

/// The action described from its stored (cleaned) candidate.
fn clean_describe(a: &Action, cands: &[CandRec]) -> String {
    let mut a = a.clone();
    if let (Some(t), Some(c)) = (a.target.as_mut(), cands.get(a.id).and_then(|c| c.target.as_ref())) {
        t.label = c.label.clone();
        t.value = c.value.clone();
    }
    a.describe()
}

/// The run's records: one per decision, with its outcome and whether the step was on the path to `done`.
pub fn records(run: &str, goal: &Goal, o: &Outcome) -> Vec<Record> {
    let base = Base { run, goal, sc: Scrub::new(&goal.inputs), outcome: status_name(o.status), verified: o.verified };
    o.trace.iter().map(|t| base.record(t, Some(o.status == Status::Done && t.on_path))).collect()
}

// ---------- the file ----------

/// A project's log: `<dir>/<project hash>.decisions.jsonl`.
pub fn path(dir: &Path, project: &str) -> PathBuf {
    dir.join(format!("{:016x}.decisions.jsonl", super::fnv(project)))
}

/// Every log file in `dir` (current and rotated).
pub fn files(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.contains(".decisions") && n.ends_with(".jsonl")))
        .collect();
    v.sort();
    v
}

/// The logs' total size in bytes, and how many files.
pub fn size(dir: &Path) -> (u64, usize) {
    let f = files(dir);
    (f.iter().filter_map(|p| std::fs::metadata(p).ok()).map(|m| m.len()).sum(), f.len())
}

/// Deletes every log file in `dir` (nothing else there): how many.
pub fn delete(dir: &Path) -> usize {
    files(dir).iter().filter(|p| std::fs::remove_file(p).is_ok()).count()
}

/// Appends records to `file` (rotating at `max_file`; nothing while the folder holds over `max_total`): how many
/// were written.
pub fn append(file: &Path, recs: &[Record], max_file: u64, max_total: u64) -> std::io::Result<usize> {
    if recs.is_empty() {
        return Ok(0);
    }
    let mut buf = Vec::new();
    for r in recs {
        serde_json::to_writer(&mut buf, r)?;
        buf.push(b'\n');
    }
    let dir = file.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    if size(dir).0 + buf.len() as u64 > max_total {
        return Ok(0);
    }
    let cur = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
    if cur > 0 && cur + buf.len() as u64 > max_file {
        // Rotate: the current file becomes `.1` (replacing the older one).
        std::fs::rename(file, file.with_extension("1.jsonl"))?;
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(file)?;
    f.write_all(&buf)?;
    Ok(recs.len())
}

/// Reads a log back (lines that don't parse are skipped).
pub fn read(file: &Path) -> Vec<Record> {
    std::fs::read_to_string(file).map(|s| s.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()).unwrap_or_default()
}

// ---------- the caller's choice after `stuck` ----------

/// A run that ended stuck / surprised, waiting for the calling agent's next action on that screen.
struct Waiting {
    file: PathBuf,
    record: Record,
    raw: Vec<Action>,
    at: Instant,
}

static WAITING: Mutex<Option<HashMap<usize, Waiting>>> = Mutex::new(None);

/// Logs a finished run for `chat` into `file` (when the toggle is on); after `stuck` / `surprised`, the caller's
/// next action on that screen is logged too ([`caller_acted`]).
pub fn log_run(file: &Path, chat: usize, run: &str, goal: &Goal, o: &Outcome) {
    let mut w = WAITING.lock().unwrap();
    w.get_or_insert_with(HashMap::new).remove(&chat);
    if !enabled() {
        return;
    }
    let recs = records(run, goal, o);
    if let Err(e) = append(file, &recs, MAX_FILE, MAX_TOTAL) {
        eprintln!("coool: pilot decision log not written: {e}");
    }
    if matches!(o.status, Status::Stuck | Status::Surprised)
        && let Some(screen) = &o.last
        && !o.candidates.is_empty()
    {
        let base = Base { run, goal, sc: Scrub::new(&goal.inputs), outcome: status_name(o.status), verified: false };
        let prev = o.trace.last().map(|t| t.candidates.get(t.chosen).map(|a| a.key()).unwrap_or_default()).unwrap_or_else(|| "start".into());
        let history: Vec<String> = o.steps.iter().map(|s| s.action.clone()).collect();
        let t = Traced {
            step: o.steps.len() + 1,
            screen: screen.clone(),
            candidates: o.candidates.clone(),
            prev,
            history,
            decider: "caller",
            chosen: 0,
            ms: 0,
            on_path: false,
        };
        let record = base.record(&t, None);
        w.get_or_insert_with(HashMap::new).insert(chat, Waiting { file: file.to_path_buf(), record, raw: o.candidates.clone(), at: Instant::now() });
    }
}

/// The candidate a device tool call picks, if it is one of them: a tap / click on a candidate's element, a scroll,
/// back. Typing free text isn't (the pilot only types inputs by key).
pub fn match_call(cands: &[Action], name: &str, a: &serde_json::Value) -> Option<usize> {
    // An element id: `target` (iPhone `tap`) or `id` (`browser_click`; a number there).
    let id = [&a["target"], &a["id"]]
        .into_iter()
        .find_map(|v| v.as_str().map(|s| s.trim().trim_start_matches('[').trim_end_matches(']').to_string()).or_else(|| v.as_u64().map(|n| n.to_string())));
    let verb = |v: Verb| cands.iter().find(|c| c.verb == v).map(|c| c.id);
    match name {
        "tap" | "browser_click" => {
            let id = id?;
            cands.iter().find(|c| c.verb == Verb::Tap && c.target.as_ref().is_some_and(|t| t.id == id)).map(|c| c.id)
        }
        "swipe" | "browser_scroll" => {
            let dir = a["scroll"].as_str().or_else(|| a["direction"].as_str())?;
            cands.iter().find(|c| c.verb == Verb::Scroll && c.dir == Some(if dir == "up" { "up" } else { "down" })).map(|c| c.id)
        }
        "browser_back" => verb(Verb::Back),
        "press" | "browser_press" => {
            let k = a["key"].as_str().or_else(|| a["button"].as_str()).unwrap_or("").to_lowercase();
            if k == "return" || k == "enter" { verb(Verb::Submit) } else { None }
        }
        _ => None,
    }
}

/// A device tool call from `chat`: when its last pilot run is waiting for the caller and the call picks one of the
/// candidates, logs it (decider `caller`). Only the first device action after the run counts.
pub fn caller_acted(chat: usize, name: &str, a: &serde_json::Value) {
    if name == "pilot_run" || name == "observe" || name == "browser_observe" || name == "device" || name == "wait_for" {
        return;
    }
    let Some(w) = WAITING.lock().unwrap().as_mut().and_then(|m| m.remove(&chat)) else { return };
    if !enabled() {
        return;
    }
    let Some(id) = match_call(&w.raw, name, a) else { return };
    let mut r = w.record;
    r.chosen = id;
    r.action = r.screen.candidates.get(id).map(describe_rec).unwrap_or_default();
    r.decision_ms = w.at.elapsed().as_millis() as u64;
    r.ts = now_ms();
    if let Err(e) = append(&w.file, &[r], MAX_FILE, MAX_TOTAL) {
        eprintln!("coool: pilot decision log not written: {e}");
    }
}

fn describe_rec(c: &CandRec) -> String {
    match &c.target {
        Some(t) => format!("{} {} {:?}", c.verb, t.role, t.label),
        None => match &c.dir {
            Some(d) => format!("{} {d}", c.verb),
            None => c.verb.clone(),
        },
    }
}

// ---------- eval ----------

/// Per-step accuracy, as the spike's offline eval computed it (`spikes/pilot/offline_eval.py`): over the labelled
/// states (steps on the path of a run that ended `done`, verified when it had checks), the share where the
/// predicted candidate id is the gold one (the id chosen on that path).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Eval {
    pub n: usize,
    pub correct: usize,
    pub accuracy: f64,
    /// Per decider that chose the gold step: (states, correct).
    pub by_decider: std::collections::BTreeMap<String, (usize, usize)>,
}

/// The labelled states of a log: records on a successful path.
pub fn gold(records: &[Record]) -> Vec<&Record> {
    records.iter().filter(|r| r.on_success_path == Some(true) && r.outcome == "done" && (r.verified || r.checks.is_empty())).collect()
}

/// Scores `predict` (a scorer: record in, candidate id out) on the log's labelled states.
pub fn eval(records: &[Record], mut predict: impl FnMut(&Record) -> Option<usize>) -> Eval {
    let mut e = Eval::default();
    for r in gold(records) {
        let ok = predict(r) == Some(r.chosen);
        e.n += 1;
        e.correct += ok as usize;
        let d = e.by_decider.entry(r.decider.clone()).or_insert((0, 0));
        d.0 += 1;
        d.1 += ok as usize;
    }
    e.accuracy = if e.n > 0 { e.correct as f64 / e.n as f64 } else { 0.0 };
    e
}

/// A log's summary for people (`coool --coool-pilot-eval <file>`): its size, the labelled states, and how often each
/// logged decider's choice was on the successful path.
pub fn report(file: &Path) -> String {
    let recs = read(file);
    let runs = recs.iter().map(|r| r.run.as_str()).collect::<std::collections::BTreeSet<_>>().len();
    let gold = gold(&recs).len();
    let by = decider_accuracy(&recs).into_iter().map(|(d, (n, ok))| format!("{d} {ok}/{n}")).collect::<Vec<_>>().join(", ");
    let mut deciders = std::collections::BTreeMap::<&str, usize>::new();
    for r in &recs {
        *deciders.entry(r.decider.as_str()).or_insert(0) += 1;
    }
    let all = deciders.iter().map(|(d, n)| format!("{d} {n}")).collect::<Vec<_>>().join(", ");
    // The floor any scorer must clear: always the first candidate.
    let floor = eval(&recs, |_| Some(0));
    format!(
        "{}: {} records from {runs} runs ({all}); {gold} labelled states (steps on a successful path) for a scorer's per-step accuracy \
         (always-the-first-action baseline {:.0}%); logged deciders' choices on the successful path, over runs that ended done: {}",
        file.display(),
        recs.len(),
        floor.accuracy * 100.0,
        if by.is_empty() { "none".into() } else { by }
    )
}

/// How often each logged decider's own choice was right, over every state it decided whose run ended `done`
/// (wrong = off the successful path): the baseline a fine-tuned scorer has to beat.
pub fn decider_accuracy(records: &[Record]) -> std::collections::BTreeMap<String, (usize, usize)> {
    let mut m = std::collections::BTreeMap::new();
    for r in records.iter().filter(|r| r.outcome == "done" && r.on_success_path.is_some()) {
        let d = m.entry(r.decider.clone()).or_insert((0, 0));
        d.0 += 1;
        d.1 += (r.on_success_path == Some(true)) as usize;
    }
    m
}
