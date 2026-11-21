//! Living session titles: a title that follows what a session is about, with
//! the person's own names pinned. See docs/CHAT_SPEC.md "Session titles".
//!
//! Precedence, highest first:
//! 1. A name the person gave in coool ([`Titles::rename`]): pinned, never auto-replaced.
//! 2. A rename by the CLI itself: Claude Code `/rename` (`custom-title`), or a
//!    CLI title that changed after its first value (Claude `ai-title`, Codex thread name).
//! 3. The automatic title. It starts as the CLI's own first title (or the first
//!    prompt), and is re-evaluated only at a checkpoint: every [`REEVAL_PROMPTS`]
//!    prompts and at each compaction. At a checkpoint the candidate (the AI
//!    title when insights are on, else [`derive`]) replaces it only when it is
//!    clearly about something else ([`clearly_different`]); either way the next
//!    checkpoint is counted from there. So a title changes at most once per
//!    checkpoint, and only when the subject moved.
//!
//! Replaced titles are kept (newest first, [`MAX_PREVIOUS`]) so search still finds
//! a session by what it used to be called. State lives in coool's data folder
//! (`titles.json`), never under ~/.claude or ~/.codex.

use crate::model::{ActivityKind, Provider, Session, Status};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

/// Prompts between two re-evaluations of the automatic title.
pub const REEVAL_PROMPTS: u32 = 12;
/// A session younger than this (in prompts) keeps its first title.
pub const MIN_PROMPTS: u32 = 4;
pub const MAX_PREVIOUS: usize = 5;
const TITLE_MAX: usize = 56;
const MANUAL_MAX: usize = 120;
/// Recent prompts [`derive`] looks at.
const WINDOW: usize = 30;
const MAX_ENTRIES: usize = 3000;

/// What a transcript says about naming, filled by the parsers.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Facts {
    /// The CLI's first own title for the session (Claude `ai-title`, Codex thread name).
    #[serde(default)]
    pub cli_first: String,
    /// Claude Code `/rename`: the latest `custom-title`.
    #[serde(default)]
    pub custom: Option<String>,
    /// Prompts the person sent so far (the whole transcript; never shrinks).
    #[serde(default)]
    pub prompts: u32,
    /// Context compactions so far.
    #[serde(default)]
    pub compactions: u32,
    /// The latest compaction summary's "Primary Request and Intent", one line.
    #[serde(default)]
    pub intent: Option<String>,
}

impl Facts {
    /// A CLI title record: the first one is remembered as the CLI's own first title.
    pub fn cli_title(&mut self, t: &str) {
        if self.cli_first.is_empty() {
            self.cli_first = t.to_string();
        }
    }

    /// A compaction summary: counts it and keeps the opening of its stated intent.
    pub fn compaction(&mut self, summary: &str) {
        self.compactions += 1;
        if let Some(i) = intent_of(summary) {
            self.intent = Some(i);
        }
    }
}

/// Where a shown title comes from.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// The person named it in coool.
    Manual,
    /// The CLI renamed it.
    Cli,
    /// Written by the insights model at a checkpoint.
    Ai,
    /// Derived from the session's recent prompts at a checkpoint.
    Auto,
    /// The first title: the CLI's own, else the first prompt.
    #[default]
    First,
}

/// The title the UI shows for a session (`Session.name`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Name {
    pub title: String,
    pub source: Source,
    /// Titles it had before, newest first.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub previous: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Rec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    manual: Option<String>,
    /// The automatic title (kept up to date underneath a manual or CLI name).
    #[serde(default)]
    auto: String,
    #[serde(default)]
    source: Source,
    /// Facts at the last checkpoint.
    #[serde(default)]
    at_prompts: u32,
    #[serde(default)]
    at_compactions: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    previous: Vec<String>,
    /// Epoch seconds of the last change (for bounding the file).
    #[serde(default)]
    changed: u64,
    /// The last title shown, to record it in `previous` when it is replaced.
    #[serde(default)]
    shown: String,
}

#[derive(Serialize, Deserialize, Default)]
struct File {
    v: u32,
    #[serde(default)]
    sessions: HashMap<String, Rec>,
}

pub struct Titles {
    path: Option<PathBuf>,
    map: HashMap<String, Rec>,
    dirty: bool,
}

fn key(p: Provider, id: &str) -> String {
    format!("{}:{id}", p.label())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl Titles {
    /// The default file in coool's data folder.
    pub fn default_path() -> Option<PathBuf> {
        dirs::data_dir().map(|d| d.join("coool").join("titles.json"))
    }

    /// Backed by `path` (None: in memory only). Reads what is there now.
    pub fn at(path: Option<PathBuf>) -> Self {
        let map = path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<File>(&b).ok())
            .map(|f| f.sessions)
            .unwrap_or_default();
        Titles { path, map, dirty: false }
    }

    /// The title to show for `s`, applying the change rule (module docs).
    /// `ai_on`: insights are on; `ai`: the insights model's latest title for it.
    pub fn resolve(&mut self, s: &Session, ai_on: bool, ai: Option<&str>) -> Name {
        let seed = seed(s);
        if s.id.is_empty() {
            return Name { title: seed, source: Source::First, previous: Vec::new() };
        }
        let f = &s.title_facts;
        let k = key(s.provider, &s.id);
        let fresh = !self.map.contains_key(&k);
        let rec = self.map.entry(k).or_insert_with(|| Rec { auto: seed.clone(), ..Rec::default() });
        let before = (rec.auto.clone(), rec.source, rec.at_prompts, rec.at_compactions);
        if rec.source == Source::First && rec.auto != seed {
            // Still the first title: it follows the CLI's own (it may arrive after the first prompt).
            rec.auto = seed;
        }
        let due = f.prompts >= MIN_PROMPTS && (f.prompts >= rec.at_prompts + REEVAL_PROMPTS || f.compactions > rec.at_compactions);
        if due {
            let candidate = match ai.map(clean).filter(|t| !t.is_empty()) {
                Some(t) => Some(Some((t, Source::Ai))),
                // Insights on: wait for the model's title, unless the session is over (no more insights).
                None if ai_on && s.status != Status::Ended => None,
                // Nothing title-worthy: the checkpoint is used up all the same (derive runs once per checkpoint).
                None => Some(derive(s, f.compactions > rec.at_compactions).map(|t| (t, Source::Auto))),
            };
            if let Some(c) = candidate {
                if let Some((t, src)) = c {
                    if clearly_different(&rec.auto, &t) {
                        rec.auto = t;
                        rec.source = src;
                    } else if rec.source == Source::First {
                        // Same subject: the first title stays, but is no longer the placeholder.
                        rec.source = src;
                    }
                }
                rec.at_prompts = f.prompts;
                rec.at_compactions = f.compactions;
            }
        }
        let (title, source) = match (&rec.manual, cli_rename(s)) {
            (Some(m), _) => (m.clone(), Source::Manual),
            (None, Some(c)) => (c, Source::Cli),
            (None, None) => (rec.auto.clone(), rec.source),
        };
        if rec.shown != title {
            if !rec.shown.is_empty() && !fresh {
                remember(&mut rec.previous, &rec.shown);
            }
            rec.shown = title.clone();
            self.dirty = true;
        }
        rec.previous.retain(|p| *p != title);
        if before != (rec.auto.clone(), rec.source, rec.at_prompts, rec.at_compactions) {
            rec.changed = now_secs();
            self.dirty = true;
        }
        Name { title, source, previous: rec.previous.clone() }
    }

    /// Names a session (`Some`, pinned) or returns it to its automatic title (`None` or blank).
    pub fn rename(&mut self, provider: Provider, id: &str, name: Option<&str>) {
        if id.is_empty() {
            return;
        }
        let name = name.map(|n| crate::util::truncate(&crate::util::one_line(n, usize::MAX), MANUAL_MAX)).filter(|n| !n.is_empty());
        let rec = self.map.entry(key(provider, id)).or_default();
        if rec.manual == name {
            return;
        }
        rec.manual = name;
        rec.changed = now_secs();
        self.dirty = true;
        self.save();
    }

    /// The title coool last showed for a session (the person's name for it, else the one resolved last), if it
    /// has seen it: what History shows for a session that is no longer in the sidebar.
    pub fn shown(&self, provider: Provider, id: &str) -> Option<&str> {
        let r = self.map.get(&key(provider, id))?;
        r.manual.as_deref().or(Some(r.shown.as_str()).filter(|s| !s.is_empty()))
    }

    pub fn manual(&self, provider: Provider, id: &str) -> Option<&str> {
        self.map.get(&key(provider, id)).and_then(|r| r.manual.as_deref())
    }

    /// Writes the file when something changed since the last save.
    pub fn save(&mut self) {
        if !self.dirty {
            return;
        }
        self.dirty = false;
        if self.map.len() > MAX_ENTRIES {
            // Oldest automatic entries go first; names the person gave are kept.
            let mut v: Vec<(u64, String)> = self.map.iter().filter(|(_, r)| r.manual.is_none()).map(|(k, r)| (r.changed, k.clone())).collect();
            v.sort();
            for (_, k) in v.into_iter().take(self.map.len() - MAX_ENTRIES) {
                self.map.remove(&k);
            }
        }
        let Some(p) = &self.path else { return };
        let file = File { v: 1, sessions: std::mem::take(&mut self.map) };
        let body = serde_json::to_vec(&file);
        self.map = file.sessions;
        if let Ok(b) = body {
            let _ = crate::origin::write_private(p, &b);
        }
    }
}

fn remember(prev: &mut Vec<String>, t: &str) {
    prev.retain(|p| p != t);
    prev.insert(0, t.to_string());
    prev.truncate(MAX_PREVIOUS);
}

fn clean(t: &str) -> String {
    let t = crate::util::one_line(t, usize::MAX);
    let t = t.trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '“' | '”' | '‘' | '’') || c.is_whitespace());
    crate::util::truncate(t.trim_end_matches(['.', '。']).trim_end(), TITLE_MAX)
}

// ------------------------------------------------------------ the CLI's names

fn folder(cwd: &str) -> &str {
    cwd.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

/// The CLI's placeholder name for an unnamed session: "<folder>-<n>" (e.g. "coool-52").
fn generic(title: &str, cwd: &str) -> bool {
    let f = folder(cwd);
    !f.is_empty()
        && title.len() > f.len() + 1
        && title.starts_with(f)
        && title.as_bytes()[f.len()] == b'-'
        && title[f.len() + 1..].len() <= 8
        && title[f.len() + 1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// A name the CLI made from the prompt itself rather than a real title.
fn prompt_like(t: &str) -> bool {
    t.chars().count() > TITLE_MAX || t.contains('\n')
}

/// What the CLI calls the session after renaming it, if it did.
fn cli_rename(s: &Session) -> Option<String> {
    let f = &s.title_facts;
    if let Some(c) = f.custom.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        return Some(clean_cli(c));
    }
    let t = s.title.trim();
    (!f.cli_first.is_empty() && !t.is_empty() && t != f.cli_first.trim() && !generic(t, &s.cwd)).then(|| clean_cli(t))
}

fn clean_cli(t: &str) -> String {
    if prompt_like(t) { short_title(t, TITLE_MAX) } else { t.to_string() }
}

/// The first title: the CLI's own name, else the first prompt, else the latest, else the folder.
fn seed(s: &Session) -> String {
    let t = s.title.trim();
    if !t.is_empty() && !(generic(t, &s.cwd) && (s.last_prompt.is_some() || !s.activity.is_empty())) {
        return clean_cli(t);
    }
    let first = s.activity.iter().find(|a| a.kind == ActivityKind::Prompt && !is_compaction(&a.text) && !a.text.trim().is_empty());
    if let Some(p) = first.map(|a| a.full.as_deref().unwrap_or(&a.text)).or(s.last_prompt.as_deref()) {
        let st = short_title(p, TITLE_MAX);
        if !st.is_empty() {
            return st;
        }
    }
    if !t.is_empty() {
        return t.to_string();
    }
    let f = folder(&s.cwd);
    if f.is_empty() { "untitled".into() } else { f.to_string() }
}

// ---------------------------------------------------------- the change rule

const STOP: &[&str] = &[
    "the", "and", "for", "with", "that", "this", "from", "into", "onto", "about", "your", "you", "our", "its", "are", "was", "were", "has",
    "have", "had", "not", "but", "all", "any", "can", "could", "should", "would", "will", "just", "also", "then", "than", "when", "what",
    "which", "where", "while", "there", "here", "them", "they", "their", "it's", "let", "lets", "let's", "make", "made", "please", "now",
    "new", "one", "use", "using", "via", "out", "get", "set", "add", "fix", "build", "work", "working", "session", "chat", "how", "why",
    "who", "does", "did", "done", "like", "some", "more", "most", "only", "each", "every", "very", "really", "still", "too", "yes", "okay",
    "sure", "want", "need", "see", "look", "check", "try", "keep", "show", "give", "take", "put", "way", "thing", "things", "good", "bad",
    "same", "other", "into", "over", "under", "after", "before", "again", "these", "those", "been", "being", "is", "be", "do", "to", "of",
    "in", "on", "at", "by", "or", "an", "a", "it", "we", "i", "me", "my", "so", "if", "no", "up", "as",
];

fn stem(w: &str) -> String {
    let w = w.trim_end_matches("'s");
    if w.len() > 5 && (w.ends_with("ses") || w.ends_with("xes") || w.ends_with("ches") || w.ends_with("shes")) {
        return w[..w.len() - 2].to_string();
    }
    if w.len() > 4 && w.ends_with('s') && !w.ends_with("ss") {
        return w[..w.len() - 1].to_string();
    }
    w.to_string()
}

/// Same word, roughly: equal, or one a prefix of the other ("update" / "updated", "fix" / "fixing").
fn same_word(a: &str, b: &str) -> bool {
    a == b || (a.len().min(b.len()) >= 3 && a.len().abs_diff(b.len()) <= 3 && (a.starts_with(b) || b.starts_with(a)))
}

/// Content words of a text, lowercased and roughly stemmed.
fn words(t: &str) -> HashSet<String> {
    t.split(|c: char| !(c.is_alphanumeric() || c == '\''))
        .map(|w| w.trim_matches('\'').to_lowercase())
        .filter(|w| w.chars().count() >= 3 && !STOP.contains(&w.as_str()) && !w.chars().all(|c| c.is_ascii_digit()))
        .map(|w| stem(&w))
        .collect()
}

/// Two titles name different subjects: they share under half the content words
/// of the shorter one. "Living chat titles" vs "Living titles and rename": same;
/// "Claude Code fast mode credits" vs "coool desktop app": different.
pub fn clearly_different(old: &str, new: &str) -> bool {
    let (a, b) = (words(old), words(new));
    if a.is_empty() || b.is_empty() {
        return old.trim().to_lowercase() != new.trim().to_lowercase();
    }
    let shared = a.iter().filter(|x| b.iter().any(|y| same_word(x, y))).count();
    shared * 2 < a.len().min(b.len())
}

// -------------------------------------------------- the deterministic title

fn is_compaction(t: &str) -> bool {
    t.starts_with("This session is being continued from a previous conversation")
}

/// A prompt that carries a subject: not a slash command, not "yes" / "continue".
fn substantial(t: &str) -> bool {
    let t = t.trim();
    // Codex puts its own context into user messages: "# AGENTS.md instructions for …", "# Files mentioned by the user".
    let injected = t.starts_with("# AGENTS.md") || t.starts_with("# Files mentioned") || t.starts_with("# Context from my IDE");
    !t.is_empty() && !injected && !t.starts_with('/') && !is_compaction(t) && t.split_whitespace().count() >= 4 && words(t).len() >= 2
}

/// Lines that say where or how to work, not what: "Repo: ~/x (Tauri…)", "Work in your worktree".
fn boilerplate(l: &str) -> bool {
    let l = l.trim().trim_start_matches(['#', '*', '-', '>', ' ']).to_lowercase();
    l.is_empty()
        || ["repo:", "repository:", "cwd:", "context:", "working directory", "work in ", "rules", "note:", "fyi", "ps:"].iter().any(|p| l.starts_with(p))
        || l.starts_with("http")
        || l.starts_with('/')
        || l.starts_with('~')
        || l.starts_with("```")
        // A list item is a detail, not the subject.
        || l.split_once(['.', ')']).is_some_and(|(n, rest)| !n.is_empty() && n.len() <= 2 && n.bytes().all(|b| b.is_ascii_digit()) && rest.starts_with(' '))
}

/// The headline of a prompt: its first line that says what (skipping repo / rules boilerplate), shortened.
fn headline(p: &str) -> String {
    let line = p.lines().map(str::trim).find(|l| !boilerplate(l) && words(l).len() >= 2).unwrap_or_else(|| p.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or(""));
    let line = line.trim_start_matches(['#', '*', '-', '>', ' ']).replace("**", "").replace('`', "");
    short_title(&line, TITLE_MAX)
}

const FILLER: &[&str] = &[
    "also", "ok", "okay", "yes", "yeah", "no", "so", "and", "but", "hmm", "i", "i'm", "im", "it", "it's", "this", "that", "why", "what",
    "how", "can", "could", "would", "please", "now", "then", "still", "wait", "hey", "great", "nice", "thanks", "thank", "perfect", "good",
    "cool", "well", "btw", "actually", "just", "is", "are", "do", "does", "did", "there", "here", "when", "where", "which", "who", "you",
    "we", "let's", "lets", "sure", "right", "oh", "seems", "looks", "same", "again", "maybe", "in", "on", "at", "for", "to", "with", "if",
];

/// A headline that reads as a title: starts with a capital, is not a question or
/// small talk ("also…", "i think…"), and is not a pasted command line or image tag.
fn titleworthy(h: &str) -> bool {
    let first = h.split_whitespace().next().unwrap_or("").trim_matches(|c: char| !c.is_alphanumeric() && c != '\'').to_lowercase();
    h.chars().next().is_some_and(|c| c.is_uppercase() || c.is_ascii_digit())
        && !h.trim_end_matches('…').trim_end().ends_with('?')
        && !FILLER.contains(&first.as_str())
        && !h.contains("[Image")
        && !h.contains('%')
        && !h.contains("$ ")
        && !h.contains('@')
        && words(h).len() >= 2
}

/// The deterministic title: the headline of the recent prompt that best
/// represents the session's recent direction (the one whose words recur most
/// across the last [`WINDOW`] substantial prompts, later ones winning ties),
/// else the latest compaction's stated intent.
pub fn derive(s: &Session, compacted: bool) -> Option<String> {
    // The CLI's own summary of the whole session, when one was written since the last checkpoint.
    if compacted && let Some(t) = s.title_facts.intent.as_deref().and_then(intent_title) {
        return Some(t);
    }
    let prompts: Vec<&str> = s
        .activity
        .iter()
        .filter(|a| a.kind == ActivityKind::Prompt)
        .map(|a| a.full.as_deref().unwrap_or(&a.text))
        .filter(|t| substantial(t))
        .collect();
    let recent = &prompts[prompts.len().saturating_sub(WINDOW)..];
    if recent.len() < 3 {
        return None;
    }
    // Words of each prompt's opening (where the subject is stated), and in how many prompts each occurs.
    let sets: Vec<HashSet<String>> = recent.iter().map(|p| words(&p.chars().take(600).collect::<String>())).collect();
    let mut df: HashMap<&str, usize> = HashMap::new();
    for set in &sets {
        for w in set {
            *df.entry(w.as_str()).or_default() += 1;
        }
    }
    let n = recent.len() as f64;
    let mut best: Option<(f64, usize)> = None;
    for (i, set) in sets.iter().enumerate() {
        let h = headline(recent[i]);
        // A headline that had to be cut mid-sentence is a sentence, not a subject.
        if !titleworthy(&h) || h.ends_with('…') {
            continue;
        }
        let head = words(&h);
        // Confidence: at least two of its words keep coming back across the window.
        let common = (recent.len() / 5).max(3);
        if head.iter().filter(|w| df.get(w.as_str()).is_some_and(|&d| d >= common)).count() < 2 {
            continue;
        }
        // The headline's words, weighted by how often the window comes back to them.
        let recur: f64 = head.iter().map(|w| df.get(w.as_str()).copied().unwrap_or(1).saturating_sub(1) as f64).sum::<f64>() / (head.len() as f64).sqrt();
        let body: f64 = set.iter().map(|w| (df[w.as_str()] - 1) as f64).sum::<f64>() / (set.len().max(1) as f64).sqrt();
        let score = (recur * 2.0 + body * 0.5) * (1.0 + 0.5 * i as f64 / n);
        if best.is_none_or(|(b, _)| score >= b) {
            best = Some((score, i));
        }
    }
    let (_, i) = best?;
    Some(headline(recent[i]))
}

/// A compaction's stated intent as a title: its first sentence without
/// parentheticals, "X is a Y" as "X: Y" ("coool (MIT) is a desktop app…" ->
/// "coool: desktop app…"). None for rules and other bookkeeping.
fn intent_title(intent: &str) -> Option<String> {
    let mut t = String::new();
    let mut depth = 0;
    for c in intent.chars() {
        match c {
            '(' => depth += 1,
            ')' if depth > 0 => depth -= 1,
            _ if depth == 0 => t.push(c),
            _ => {}
        }
    }
    let t = t.replace("**", "").replace('`', "");
    let t = crate::util::one_line(&t, usize::MAX).replace(" ,", ",");
    let low = t.to_lowercase();
    if ["rule", "context", "initial", "follow ", "ongoing", "the user", "user "].iter().any(|p| low.starts_with(p)) {
        return None;
    }
    let words_: Vec<&str> = t.split_whitespace().collect();
    let t = match words_.iter().take(5).position(|w| *w == "is" || *w == "are") {
        Some(i) if i > 0 && words_.get(i + 1).is_some_and(|a| *a == "a" || *a == "an" || *a == "the") => {
            format!("{}: {}", words_[..i].join(" "), words_[i + 2..].join(" "))
        }
        _ => t,
    };
    let h = short_title(&t, TITLE_MAX);
    let first = h.split_whitespace().next().unwrap_or("").to_lowercase();
    (words(&h).len() >= 2 && !h.ends_with('?') && !FILLER.contains(&first.as_str())).then_some(h)
}

/// "Primary Request and Intent:" from a Claude Code compaction summary, one line.
fn intent_of(summary: &str) -> Option<String> {
    let at = summary.find("Primary Request and Intent")?;
    let rest = &summary[at..];
    let rest = rest.split_once(':').map(|(_, r)| r)?;
    let body: String = rest.lines().map(str::trim).filter(|l| !l.is_empty()).take(3).collect::<Vec<_>>().join(" ");
    // Drop a leading "**Label:**" the summaries like to start with.
    let body = body.trim_start_matches(['-', '*', ' ']);
    let body = match body.split_once(":**") {
        Some((label, rest)) if label.split_whitespace().count() <= 4 => rest,
        _ => body,
    };
    let body = body.trim_start_matches(['-', '*', ' ']);
    let t = crate::util::one_line(body, 300);
    (!t.is_empty()).then_some(t)
}

/// A prompt -> a short title: its first sentence (or line), cut at a clause
/// break or a word boundary when still long (the Rust twin of `shortTitle`
/// in app/src/lib/format.ts).
pub fn short_title(text: &str, max: usize) -> String {
    let first = text.trim().lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let mut t = first.split_whitespace().collect::<Vec<_>>().join(" ");
    // First sentence: . ! ? followed by a space, after at least 8 chars and a 2-char word end (not "e.g. ").
    let chars: Vec<char> = t.chars().collect();
    for i in 8..chars.len() {
        if matches!(chars[i], '.' | '!' | '?')
            && chars.get(i + 1) == Some(&' ')
            && i >= 2
            && !chars[i - 1].is_whitespace()
            && chars[i - 1] != '.'
            && !chars[i - 2].is_whitespace()
            && chars[i - 2] != '.'
        {
            t = chars[..=i].iter().collect::<String>();
            t = t.trim_end_matches('.').to_string();
            break;
        }
    }
    if t.chars().count() <= max {
        return t;
    }
    let head: String = t.chars().take(max).collect();
    // A ": " or " — " early on usually ends the subject ("Build living titles: a title should…").
    let clause = ["; ", ": ", " - ", " — ", ", "].iter().filter_map(|b| head.find(b)).filter(|&c| head[..c].split_whitespace().count() >= 2).min();
    if let Some(c) = clause
        && head[..c].chars().count() >= 12
    {
        return head[..c].trim_end().to_string();
    }
    let cut = head.rfind(' ').filter(|&w| head[..w].chars().count() * 2 >= max).unwrap_or(head.len());
    format!("{}…", head[..cut].trim_end_matches([' ', ',', ';', ':', '.', '-']))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Activity;
    use std::sync::Arc;

    fn sess(title: &str, prompts: &[&str]) -> Session {
        let mut s = crate::wire::tests::session("abc", 0, 0);
        s.cwd = "/Users/x/coool".into();
        s.title = title.into();
        s.status = Status::Idle;
        s.activity = Arc::new(prompts.iter().map(|p| Activity::message(String::new(), ActivityKind::Prompt, p, 400)).collect());
        s.title_facts.cli_first = if title.is_empty() { String::new() } else { title.to_string() };
        s.title_facts.prompts = prompts.len() as u32;
        s
    }

    fn grow(s: &mut Session, more: &[&str]) {
        let mut a = (*s.activity).clone();
        a.extend(more.iter().map(|p| Activity::message(String::new(), ActivityKind::Prompt, p, 400)));
        s.activity = Arc::new(a);
        s.title_facts.prompts += more.len() as u32;
    }

    const THEME: [&str; 6] = [
        "Make the sidebar rows show the unread dot for desktop app sessions",
        "The desktop app sidebar flickers when sessions update, fix the sidebar",
        "Add keyboard navigation to the desktop app sidebar rows",
        "Sidebar rows in the desktop app need a hover state like the tabs",
        "Desktop app sidebar: group sessions by project folder",
        "Polish the sidebar spacing in the desktop app",
    ];

    #[test]
    fn young_sessions_keep_their_first_title() {
        let mut t = Titles::at(None);
        let s = sess("Claude Code fast mode credits", &["what are fast mode credits", "and how do I get more"]);
        let n = t.resolve(&s, false, None);
        assert_eq!((n.title.as_str(), n.source), ("Claude Code fast mode credits", Source::First));
    }

    #[test]
    fn a_long_session_moves_to_its_recent_direction_once() {
        let mut t = Titles::at(None);
        let mut s = sess("Claude Code fast mode credits", &["what are fast mode credits exactly please"]);
        assert_eq!(t.resolve(&s, false, None).title, "Claude Code fast mode credits");
        for _ in 0..2 {
            grow(&mut s, &THEME);
        }
        let n = t.resolve(&s, false, None);
        assert_eq!(n.source, Source::Auto);
        assert!(n.title.to_lowercase().contains("sidebar"), "{}", n.title);
        assert_eq!(n.previous, vec!["Claude Code fast mode credits".to_string()]);
        // Stability: every later refresh, and new prompts short of a checkpoint, keep it.
        let first = n.title.clone();
        for p in ["Rewrite the sidebar in the desktop app", "Desktop app sidebar search box please"] {
            grow(&mut s, &[p]);
            assert_eq!(t.resolve(&s, false, None).title, first);
        }
    }

    #[test]
    fn same_subject_at_a_checkpoint_keeps_the_title() {
        let mut t = Titles::at(None);
        let mut s = sess("Desktop app sidebar polish", &[]);
        grow(&mut s, &THEME);
        grow(&mut s, &THEME);
        let n = t.resolve(&s, false, None);
        assert_eq!(n.title, "Desktop app sidebar polish", "the candidate is about the sidebar too");
        assert!(n.previous.is_empty());
    }

    #[test]
    fn ai_titles_are_gated_like_the_others() {
        let mut t = Titles::at(None);
        let mut s = sess("Fix the parser", &["fix the parser crash on empty lines now"]);
        // Not at a checkpoint: the model's title is not taken.
        assert_eq!(t.resolve(&s, true, Some("Session list redesign")).title, "Fix the parser");
        grow(&mut s, &THEME);
        grow(&mut s, &THEME);
        // Due, insights on, no model title yet: wait (no deterministic flip-flop).
        assert_eq!(t.resolve(&s, true, None).title, "Fix the parser");
        let n = t.resolve(&s, true, Some("\"Desktop sidebar redesign.\""));
        assert_eq!((n.title.as_str(), n.source), ("Desktop sidebar redesign", Source::Ai));
        // A reworded model title right after does not replace it.
        grow(&mut s, &THEME);
        grow(&mut s, &THEME);
        assert_eq!(t.resolve(&s, true, Some("Redesigned desktop sidebar")).title, "Desktop sidebar redesign");
    }

    #[test]
    fn compaction_is_a_checkpoint() {
        let mut t = Titles::at(None);
        let mut s = sess("Fix the parser", &THEME);
        s.title_facts.prompts = 5;
        let n0 = t.resolve(&s, true, Some("Parser fix"));
        assert_eq!(n0.title, "Fix the parser", "5 prompts: before the first checkpoint");
        s.title_facts.compaction("Summary:\n1. Primary Request and Intent:\n   Build the sidebar.");
        assert_eq!(t.resolve(&s, true, Some("Sidebar grouping by project")).title, "Sidebar grouping by project");
        assert_eq!(s.title_facts.intent.as_deref(), Some("Build the sidebar."));
    }

    #[test]
    fn manual_names_pin_and_revert() {
        let mut t = Titles::at(None);
        let mut s = sess("Fix the parser", &["fix the parser crash on empty lines now"]);
        t.resolve(&s, false, None);
        t.rename(Provider::Claude, "abc", Some("  My parser  "));
        let n = t.resolve(&s, false, None);
        assert_eq!((n.title.as_str(), n.source), ("My parser", Source::Manual));
        assert_eq!(n.previous, vec!["Fix the parser".to_string()]);
        // Pinned through checkpoints and CLI renames.
        grow(&mut s, &THEME);
        grow(&mut s, &THEME);
        s.title_facts.custom = Some("cli name".into());
        assert_eq!(t.resolve(&s, false, None).title, "My parser");
        s.title_facts.custom = None;
        // Back to automatic: the automatic title kept evolving underneath.
        t.rename(Provider::Claude, "abc", Some("   "));
        let n = t.resolve(&s, false, None);
        assert!(n.title.to_lowercase().contains("sidebar"), "{}", n.title);
        assert_eq!(n.previous.first().map(String::as_str), Some("My parser"));
    }

    #[test]
    fn manual_names_survive_restarts() {
        let d = crate::loader::tests::tmpdir("titles");
        let p = d.join("data").join("titles.json");
        let s = sess("Fix the parser", &["fix the parser crash on empty lines now"]);
        {
            let mut t = Titles::at(Some(p.clone()));
            t.resolve(&s, false, None);
            t.rename(Provider::Claude, "abc", Some("Parser work"));
            t.save();
        }
        let mut t = Titles::at(Some(p.clone()));
        assert_eq!(t.manual(Provider::Claude, "abc"), Some("Parser work"));
        let n = t.resolve(&s, false, None);
        assert_eq!((n.title.as_str(), n.previous.as_slice()), ("Parser work", &["Fix the parser".to_string()][..]));
        // An automatic title also stays what it was across a restart.
        let mut s2 = sess("Old subject here", &[]);
        s2.id = "def".into();
        grow(&mut s2, &THEME);
        grow(&mut s2, &THEME);
        let auto = t.resolve(&s2, false, None).title;
        t.save();
        let mut t = Titles::at(Some(p));
        assert_eq!(t.resolve(&s2, false, None).title, auto);
    }

    #[test]
    fn the_cli_renaming_wins_over_automatic() {
        let mut t = Titles::at(None);
        let mut s = sess("Fix the parser", &["fix the parser crash on empty lines now"]);
        t.resolve(&s, false, None);
        // The same CLI title again is not a rename.
        assert_eq!(t.resolve(&s, false, None).source, Source::First);
        s.title = "Parser and lexer rewrite".into();
        let n = t.resolve(&s, false, None);
        assert_eq!((n.title.as_str(), n.source), ("Parser and lexer rewrite", Source::Cli));
        s.title_facts.custom = Some("Bambu printer config".into());
        assert_eq!(t.resolve(&s, false, None).title, "Bambu printer config");
    }

    #[test]
    fn first_title_without_a_cli_name() {
        let mut t = Titles::at(None);
        let mut s = sess("", &["Fix the login bug. Then add tests for it", "ok"]);
        s.title = "coool-52".into();
        s.last_prompt = Some("ok".into());
        assert_eq!(t.resolve(&s, false, None).title, "Fix the login bug");
        // The latest prompt changing does not move the first title.
        s.last_prompt = Some("now do the other thing".into());
        assert_eq!(t.resolve(&s, false, None).title, "Fix the login bug");
        // The CLI's own title arriving later replaces the placeholder, silently.
        s.title = "Login bug fix".into();
        s.title_facts.cli_first = "Login bug fix".into();
        let n = t.resolve(&s, false, None);
        assert_eq!((n.title.as_str(), n.source), ("Login bug fix", Source::First));
    }

    #[test]
    fn derive_skips_boilerplate_and_small_talk() {
        let mut s = sess("", &[]);
        grow(
            &mut s,
            &[
                "Repo: /Users/x/coool (Tauri app)\nBuild **living chat titles**: a title should change over time",
                "yes",
                "Living chat titles: make sure the rename survives restarts of the app",
                "/compact",
                "The living titles need search over previous chat titles",
                "commit it",
            ],
        );
        assert_eq!(derive(&s, false).as_deref(), Some("Living chat titles"));
    }

    #[test]
    fn different_means_a_different_subject() {
        assert!(!clearly_different("Living chat titles", "Living titles and rename"));
        assert!(clearly_different("Claude Code fast mode credits", "coool desktop app for agents"));
        assert!(!clearly_different("Sidebar unread dots", "Unread dots in the sidebar"));
    }

    #[test]
    fn the_claude_parser_fills_the_facts() {
        let mut p = crate::claude::Parsed::default();
        for l in [
            r#"{"type":"ai-title","aiTitle":"First name"}"#,
            r#"{"type":"user","message":{"content":"hello there"},"timestamp":"2026-01-01T00:00:00Z"}"#,
            r#"{"type":"ai-title","aiTitle":"First name"}"#,
            r#"{"type":"user","isCompactSummary":true,"message":{"content":"This session is being continued from a previous conversation. Summary:\n1. Primary Request and Intent:\n   - **Project:** coool (MIT) is a desktop app for agents.\n2. Key"},"timestamp":"2026-01-01T00:00:01Z"}"#,
            r#"{"type":"user","message":{"content":"next thing"},"timestamp":"2026-01-01T00:00:02Z"}"#,
            r#"{"type":"custom-title","customTitle":"My name","sessionId":"x"}"#,
        ] {
            p.line(l);
        }
        let f = p.view().title_facts;
        assert_eq!((f.cli_first.as_str(), f.custom.as_deref(), f.prompts, f.compactions), ("First name", Some("My name"), 2, 1));
        assert_eq!(f.intent.as_deref().and_then(intent_title).as_deref(), Some("coool: desktop app for agents"));
    }

    #[test]
    fn short_titles() {
        assert_eq!(short_title("Fix the login bug. Then add tests", 56), "Fix the login bug");
        assert_eq!(short_title("Build living chat titles: a session's title should change over time as it goes", 56), "Build living chat titles");
        assert_eq!(short_title("e.g. this is fine", 56), "e.g. this is fine");
    }
}
