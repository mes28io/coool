//! Asking the History index: filters, full-text search and its ranking, one page of rows.
//!
//! The same call serves the History page and anything else that wants past sessions (the New session sheet's
//! "recent in this folder": `cwd` + `limit`).

use super::{listed, History, Status};
use crate::model::Provider;
use memchr::memmem;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Instant;

/// Where a session ran.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Where {
    /// A coool chat or a terminal coool ran.
    Coool,
    /// The CLI in a terminal.
    Terminal,
    /// An editor extension (VS Code, JetBrains).
    Ide,
    /// Another app: the Claude or Codex desktop app, a remote or phone client.
    App,
    /// Started by a script, another tool or an agent (`claude -p`, the Agent SDK, `codex exec`).
    Automation,
}

/// What to list. Every field is optional; the default lists every session, newest first.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Query {
    /// Words to find (all of them, anywhere: title, prompts, replies, folder, files); "quoted words" as one.
    pub text: String,
    /// Only this project (the folder rows are grouped under, see `project::project_root`).
    pub project: Option<String>,
    /// Only sessions in this folder or below it.
    pub cwd: Option<String>,
    pub providers: Vec<Provider>,
    pub wheres: Vec<Where>,
    /// Last activity within [from, to] (epoch ms).
    pub from_ms: Option<u64>,
    pub to_ms: Option<u64>,
    /// Only sessions that changed files.
    pub has_changes: bool,
    pub offset: usize,
    /// Rows to return (0: 100).
    pub limit: usize,
}

/// One project in the results (for the project filter).
#[derive(Clone, Debug, Serialize)]
pub struct Facet {
    pub project: String,
    pub count: usize,
    pub last_ms: u64,
}

/// Part of a snippet; `hit` parts are what the search matched.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Seg {
    pub t: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub hit: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Row {
    /// `provider:id`, the key the app opens sessions by.
    pub key: String,
    pub provider: Provider,
    pub id: String,
    pub cwd: String,
    pub project: String,
    pub title: String,
    /// The first prompt, one line.
    pub prompt: String,
    pub model: String,
    #[serde(rename = "where")]
    pub place: Where,
    /// Where it ran, in words ("Terminal", "VS Code", "Claude app").
    pub via: String,
    pub started_ms: u64,
    pub last_ms: u64,
    pub prompts: u32,
    pub compactions: u32,
    /// Files it changed, and the first few of them.
    pub edits: u32,
    pub files: Vec<String>,
    /// Transcript size.
    pub bytes: u64,
    /// Its folder is gone (moved or deleted).
    pub missing: bool,
    /// Codex: an archived thread.
    pub archived: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub snippet: Vec<Seg>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Page {
    pub rows: Vec<Row>,
    /// Rows matching, in all.
    pub total: usize,
    /// Projects among the sessions matching every filter but the project and the words, busiest first.
    pub projects: Vec<Facet>,
    pub status: Status,
    pub took_ms: f64,
}

/// The words of a query: lowercased (ASCII), "quoted" runs kept together.
pub(crate) fn terms(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut quoted = false;
    for (k, part) in text.split('"').enumerate() {
        quoted = k % 2 == 1;
        if quoted {
            let p = part.trim();
            if !p.is_empty() {
                out.push(p.to_ascii_lowercase());
            }
        } else {
            out.extend(part.split_whitespace().map(str::to_ascii_lowercase));
        }
    }
    let _ = quoted;
    out.sort();
    out.dedup();
    out
}

/// Recency weight: a session from today counts about twice one from months ago.
fn recency(last_ms: u64, now_ms: u64) -> f64 {
    let days = now_ms.saturating_sub(last_ms) as f64 / 86_400_000.0;
    1.0 + 1.0 / (1.0 + days / 14.0)
}

/// A whole-word (or word-start) hit at `at` in `hay`.
fn word_start(hay: &[u8], at: usize) -> bool {
    at == 0 || !hay[at - 1].is_ascii_alphanumeric()
}

struct Cand {
    i: usize,
    title: String,
    last: u64,
    project: String,
    score: f64,
    /// First hit in the words: (byte offset, term length).
    hit: Option<(usize, usize)>,
}

impl History {
    /// One page of sessions for `q`. `names`: the title coool shows for a session, when it has one (renamed or
    /// seen before); `scope`: keep only folders it accepts (a self-test lists its own folder only).
    pub fn query(&mut self, q: &Query, names: &dyn Fn(Provider, &str) -> Option<String>, scope: Option<&dyn Fn(&str) -> bool>) -> Page {
        let t0 = Instant::now();
        let terms = terms(&q.text);
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let mut facets: HashMap<String, (usize, u64)> = HashMap::new();
        let mut cands: Vec<Cand> = Vec::new();
        for (i, d) in self.docs.iter().enumerate() {
            if !listed(d) {
                continue;
            }
            let m = &d.meta;
            if scope.is_some_and(|f| !f(&m.cwd)) {
                continue;
            }
            if !q.providers.is_empty() && !q.providers.contains(&d.provider) {
                continue;
            }
            if !q.wheres.is_empty() && !q.wheres.contains(&self.where_of(d).0) {
                continue;
            }
            let last = m.last_ms.unwrap_or(d.mtime);
            if q.from_ms.is_some_and(|f| last < f) || q.to_ms.is_some_and(|t| last > t) {
                continue;
            }
            if q.has_changes && m.edits_n == 0 {
                continue;
            }
            if let Some(c) = q.cwd.as_deref().map(|c| c.trim_end_matches('/')).filter(|c| !c.is_empty())
                && m.cwd != c
                && !m.cwd.strip_prefix(c).is_some_and(|r| r.starts_with('/'))
            {
                continue;
            }
            let project = crate::project::project_root(&m.cwd);
            let f = facets.entry(project.clone()).or_default();
            f.0 += 1;
            f.1 = f.1.max(last);
            if q.project.as_deref().is_some_and(|p| p != project) {
                continue;
            }
            cands.push(Cand { i, title: self.title_of(d, names), last, project, score: 0.0, hit: None });
        }

        if terms.is_empty() {
            cands.sort_by(|a, b| b.last.cmp(&a.last));
        } else {
            let finders: Vec<memmem::Finder> = terms.iter().map(|t| memmem::Finder::new(t.as_bytes())).collect();
            // Longest words first: the snippet centres on the most telling one.
            let mut by_len: Vec<usize> = (0..terms.len()).collect();
            by_len.sort_by_key(|&k| std::cmp::Reverse(terms[k].len()));
            self.texts();
            let docs = &self.docs;
            let texts = &self.texts.as_ref().expect("loaded above").lower;
            cands.retain_mut(|c| {
                let d = &docs[c.i];
                let m = &d.meta;
                let title = c.title.to_ascii_lowercase();
                let prompt = m.first_prompt.to_ascii_lowercase();
                let place = format!("{} {}", m.cwd, m.edits.join(" ")).to_ascii_lowercase();
                let words = texts.get(c.i).map(Vec::as_slice).unwrap_or_default();
                // A title that is the first prompt already shows it: the snippet looks for a hit past it.
                let skip = if prompt.starts_with(title.trim_end_matches('…').trim_end()) { m.head_words as usize } else { 0 };
                let mut score = 0.0;
                for &k in &by_len {
                    let t = &terms[k];
                    let in_title = title.find(t.as_str());
                    let in_prompt = prompt.contains(t.as_str());
                    let in_place = place.contains(t.as_str());
                    let mut n = 0usize;
                    let mut first = None;
                    let mut later = None;
                    let mut whole = false;
                    for at in finders[k].find_iter(words).take(8) {
                        if first.is_none() {
                            first = Some(at);
                        }
                        if later.is_none() && at >= skip {
                            later = Some(at);
                        }
                        whole |= word_start(words, at);
                        n += 1;
                    }
                    if in_title.is_none() && !in_prompt && !in_place && n == 0 {
                        return false;
                    }
                    if let Some(at) = in_title {
                        score += if word_start(title.as_bytes(), at) { 10.0 } else { 6.0 };
                    }
                    if in_prompt {
                        score += 3.0;
                    }
                    if in_place {
                        score += 2.0;
                    }
                    if n > 0 {
                        score += (1.0 + (n as f64).ln()) * if whole { 1.3 } else { 1.0 };
                    }
                    if c.hit.is_none()
                        && let Some(at) = later.or(first)
                    {
                        c.hit = Some((at, t.len()));
                    }
                }
                c.score = score * recency(c.last, now_ms);
                true
            });
            cands.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then(b.last.cmp(&a.last)));
        }

        let total = cands.len();
        let limit = if q.limit == 0 { 100 } else { q.limit.min(1000) };
        let page: Vec<Cand> = cands.into_iter().skip(q.offset).take(limit).collect();
        let mut rows = Vec::with_capacity(page.len());
        for c in page {
            let snippet = match c.hit {
                Some((at, n)) => self.snippet(c.i, at, n, &terms),
                None => Vec::new(),
            };
            let missing = !self.folder_exists(&self.docs[c.i].meta.cwd.clone());
            let d = &self.docs[c.i];
            let (place, via) = self.where_of(d);
            let m = &d.meta;
            rows.push(Row {
                key: format!("{}:{}", d.provider.label(), m.id),
                provider: d.provider,
                id: m.id.clone(),
                cwd: m.cwd.clone(),
                project: c.project,
                title: c.title,
                prompt: m.first_prompt.clone(),
                model: m.model.clone(),
                place,
                via,
                started_ms: m.started_ms.unwrap_or(c.last),
                last_ms: c.last,
                prompts: m.prompts,
                compactions: m.compactions,
                edits: m.edits_n,
                files: m.edits.iter().take(5).cloned().collect(),
                bytes: d.len,
                missing,
                archived: d.archived,
                snippet,
            });
        }
        let mut projects: Vec<Facet> = facets.into_iter().map(|(project, (count, last_ms))| Facet { project, count, last_ms }).collect();
        projects.sort_by(|a, b| b.last_ms.cmp(&a.last_ms).then(a.project.cmp(&b.project)));
        Page { rows, total, projects, status: self.status(), took_ms: t0.elapsed().as_secs_f64() * 1000.0 }
    }

    /// About two lines of the words around a hit, the matched words marked.
    fn snippet(&mut self, i: usize, at: usize, n: usize, terms: &[String]) -> Vec<Seg> {
        let len = self.texts().lower[i].len();
        let lower = &self.texts.as_ref().unwrap().lower[i];
        let s = std::str::from_utf8(lower).unwrap_or("");
        let mut a = at.saturating_sub(60);
        while a > 0 && !s.is_char_boundary(a) {
            a -= 1;
        }
        // Start at a word when one begins close by.
        if a > 0
            && let Some(k) = s[a..at].find(char::is_whitespace)
            && k < 24
        {
            a += k + 1;
        }
        let mut b = (at + n + 140).min(len);
        while b < len && !s.is_char_boundary(b) {
            b += 1;
        }
        let text = self.original(i, a, b).replace(['\n', '\r', '\t'], " ");
        let low = text.to_ascii_lowercase();
        // Marked ranges, merged.
        let mut marks: Vec<(usize, usize)> = Vec::new();
        for t in terms {
            for k in memmem::find_iter(low.as_bytes(), t.as_bytes()) {
                marks.push((k, k + t.len()));
            }
        }
        marks.sort();
        let mut merged: Vec<(usize, usize)> = Vec::new();
        for (x, y) in marks {
            match merged.last_mut() {
                Some(l) if x <= l.1 => l.1 = l.1.max(y),
                _ => merged.push((x, y)),
            }
        }
        let mut out = Vec::new();
        let mut pos = 0;
        let push = |out: &mut Vec<Seg>, t: &str, hit: bool| {
            if !t.is_empty() {
                out.push(Seg { t: t.to_string(), hit });
            }
        };
        if a > 0 {
            push(&mut out, "…", false);
        }
        for (x, y) in merged {
            if !text.is_char_boundary(x) || !text.is_char_boundary(y) {
                continue;
            }
            push(&mut out, &text[pos..x], false);
            push(&mut out, &text[x..y], true);
            pos = y;
        }
        push(&mut out, &text[pos..], false);
        if b < len {
            push(&mut out, "…", false);
        }
        // Collapse runs of spaces in the plain parts (the marked ones are kept exactly).
        for sgm in out.iter_mut().filter(|s| !s.hit) {
            let mut t = String::with_capacity(sgm.t.len());
            let mut space = false;
            for ch in sgm.t.chars() {
                if ch == ' ' {
                    if !space {
                        t.push(' ');
                    }
                    space = true;
                } else {
                    t.push(ch);
                    space = false;
                }
            }
            sgm.t = t;
        }
        out
    }
}
