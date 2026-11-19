//! What fills a session's context window: the context map (CHAT_SPEC "Models used").
//!
//! No CLI reports a breakdown, only the size of each request (Claude: the
//! assistant record's `usage`, input + cache writes + cache reads; Codex:
//! `token_count.last_token_usage.input_tokens`). That size is
//! [`crate::model::Tokens::context`], and the map divides exactly that total:
//!
//! - **Per-step calibration.** Between two requests the context grows by
//!   `D = ctx[r] - ctx[r-1]`. Of that, the previous response's output is
//!   exact (`output_tokens`); it is split over that response's blocks (text,
//!   tool calls, thinking) by length, with thinking whose text the transcript
//!   leaves out taking what the other blocks don't explain. The rest,
//!   `D - output`, is what was added on the input side (tool results, prompts,
//!   attachments), split over those items by their text length. So every
//!   step's parts sum to that step's real growth, and the parts of the whole
//!   segment sum to the latest request's size.
//! - **Implausible steps.** When the input side is far larger than its text
//!   explains (under [`MIN_CPT`] characters per token), the CLI added context
//!   the transcript doesn't record (reminders, hook output): the items get
//!   their length-based estimate and the rest is "Not in the transcript".
//!   When the context shrank (the CLI cleared old thinking or tool results),
//!   the deficit comes off thinking first, then tool results, then the rest.
//! - **The fixed part.** The first request of a segment (the session, or
//!   since the last compaction) has nothing to diff against: what the
//!   transcript logged before it (the first prompt, attachments, a summary)
//!   is estimated at this transcript's own characters-per-token ratio (learned
//!   from the calibrated steps), and the rest of that first request is what the
//!   transcript never shows: system prompt, tool definitions, memory, skills.
//!   It is split only on evidence (a logged system prompt / tool list, the
//!   CLAUDE.md files on disk), otherwise one "System and tools" part.
//! - **Compaction.** Claude Code writes a `system` / `compact_boundary` record
//!   (with `compactMetadata.preTokens` / `postTokens`) and then the summary as a
//!   `user` record with `isCompactSummary`; Codex writes a `compacted` record
//!   whose `replacement_history` is the new history. Only what follows the
//!   latest boundary counts; the map before it is kept for "before → after".
//!
//! Cost: computed only for the transcript whose panel is open
//! ([`ContextMaps::map`]), incrementally from where it last read, and on the
//! first read only from the second-to-last compaction boundary.

use crate::model::Provider;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// What kind of thing a part of the context is; the UI tints by it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PartKind {
    /// System prompt, developer instructions, and the unitemised rest.
    System,
    /// Tool definitions (logged ones, tool-search results, MCP instructions).
    Tools,
    /// CLAUDE.md / AGENTS.md.
    Memory,
    Skills,
    /// One file read, written or edited into the context.
    File,
    /// Prompts and replies.
    Chat,
    Thinking,
    /// Tool results grouped by what they were (test runs, searches, shell, MCP...).
    Tool,
    /// Sub-agent results.
    Agent,
    Image,
    /// A compaction summary.
    Summary,
    /// Reminders and context the CLI added that the transcript doesn't record.
    Other,
}

/// How a part's size is known.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Basis {
    /// From the per-step usage numbers, split by text length.
    Calibrated,
    /// From text length (or file size) at this transcript's chars-per-token ratio.
    Estimated,
    /// What the first request held beyond everything itemised.
    Remainder,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Part {
    /// Stable across updates (the UI animates by it).
    pub id: String,
    pub kind: PartKind,
    pub label: String,
    pub tokens: u64,
    /// Calls / items merged into it ("Test runs ×20"); 0 when not counted.
    pub count: u32,
    /// For files: the path (also the files merged into "Other files", up to a few).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub basis: Basis,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Compaction {
    /// Context before (Claude: `preTokens`; Codex: the last request before it).
    pub before: u64,
    /// Context after: the first request after it (what the session's context figure shows), until then Claude's
    /// `postTokens` (the summary and kept messages only, without the system prompt and tools). 0 until known.
    pub after: u64,
    /// Epoch ms.
    pub at: Option<u64>,
    /// Started by the CLI at the limit (vs `/compact`).
    pub auto: bool,
    /// The map just before it, when the transcript was read from before it.
    pub before_parts: Vec<Part>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ContextMap {
    /// The latest request's context: equals [`crate::model::Tokens::context`].
    pub total: u64,
    /// Sum to `total`, largest first.
    pub parts: Vec<Part>,
    pub compaction: Option<Compaction>,
    /// Set when the total can't be broken down; says why, plainly.
    pub note: Option<String>,
    /// This transcript's learned characters per token (None: too little to learn from).
    pub chars_per_token: Option<f64>,
}

/// Characters per token before a transcript has taught us better (JSON-ish tool output).
const DEFAULT_CPT: f64 = 3.0;
/// Prose (memory, skills, prompts, summaries): typical characters per token.
const PROSE_CPT: f64 = 3.8;
/// Tool schemas (JSON with prose descriptions).
const SCHEMA_CPT: f64 = 3.2;
/// Below this many characters per token, the step held more than its text explains.
const MIN_CPT: f64 = 1.2;
/// Above this, a step's sample is not used to learn the ratio (it is still split by length).
const MAX_CPT: f64 = 8.0;
/// Files shown on their own; the rest merge into "Other files".
const FILES_SHOWN: usize = 6;
/// Records remembered for Claude's preserved segments (re-added after a compaction).
const RECENT: usize = 96;

type Key = (PartKind, String);

fn key(kind: PartKind, name: impl Into<String>) -> Key {
    (kind, name.into())
}

#[derive(Clone, Debug, Default)]
struct Acc {
    tokens: f64,
    /// Of `tokens`, how much came from calibrated steps.
    cal: f64,
    count: u32,
}

#[derive(Clone, Debug, Default)]
struct Req {
    id: String,
    ctx: u64,
    out: u64,
    /// Output blocks: chars, or None when the text isn't logged (redacted thinking).
    outs: Vec<(Key, Option<f64>)>,
}

/// What the transcript says about the unitemised part (in characters).
#[derive(Clone, Debug, Default)]
struct Evidence {
    system: f64,
    tools: f64,
}

/// Builds one transcript's map, line by line.
#[derive(Clone, Debug, Default)]
pub(crate) struct Builder {
    codex: bool,
    parts: HashMap<Key, Acc>,
    /// Logged before the segment's first request.
    pre: Vec<(Key, f64)>,
    /// Input items since the last request.
    inputs: Vec<(Key, f64)>,
    /// Codex: outputs logged before their `token_count`.
    staged_outs: Vec<(Key, Option<f64>)>,
    /// Codex: results of calls the not-yet-counted request made (they go in the next step).
    deferred: Vec<(Key, f64)>,
    cur: Option<Req>,
    base: u64,
    total: u64,
    cal_chars: f64,
    cal_tokens: f64,
    evidence: Evidence,
    /// Tool call id -> its part.
    calls: HashMap<String, Key>,
    /// Codex: call ids made by the not-yet-counted request.
    staged_calls: HashSet<String>,
    /// Claude: (uuid, its input items), newest last.
    recent: VecDeque<(String, Vec<(Key, f64)>)>,
    compaction: Option<Compaction>,
    /// Codex: last cumulative totals, to tell a new response from a re-send.
    codex_totals: (u64, u64, u64),
    codex_meta: bool,
    /// Memory files on disk: (path, bytes); evidence when the transcript logs none.
    pub(crate) disk_memory: Vec<(String, u64)>,
}

impl Builder {
    pub(crate) fn new(provider: Provider) -> Self {
        Self { codex: provider == Provider::Codex, ..Self::default() }
    }

    fn cpt(&self) -> f64 {
        if self.cal_tokens >= 1500.0 { (self.cal_chars / self.cal_tokens).clamp(1.5, 6.0) } else { DEFAULT_CPT }
    }

    fn bump(&mut self, k: &Key) {
        self.parts.entry(k.clone()).or_default().count += 1;
    }

    fn add(&mut self, k: &Key, tokens: f64, calibrated: bool) {
        let a = self.parts.entry(k.clone()).or_default();
        a.tokens += tokens;
        if calibrated {
            a.cal += tokens;
        }
    }

    fn input(&mut self, k: Key, chars: f64) {
        if chars <= 0.0 {
            return;
        }
        if self.cur.is_none() { self.pre.push((k, chars)) } else { self.inputs.push((k, chars)) }
    }

    fn output(&mut self, k: Key, chars: Option<f64>) {
        if self.codex {
            self.staged_outs.push((k, chars));
        } else if let Some(c) = self.cur.as_mut() {
            c.outs.push((k, chars));
        }
    }

    /// A request of `ctx` tokens whose response had `out` output tokens.
    fn request(&mut self, id: String, ctx: u64, out: u64) {
        match self.cur.take() {
            None => {
                self.base = ctx;
                // The first request after a compaction is what the context really holds now (the figure the
                // session shows). Claude's `postTokens` leaves out the system prompt and tools: a small chat
                // compacted "29k -> 7.9k" whose next request was 29k again.
                if let Some(c) = self.compaction.as_mut() {
                    c.after = ctx;
                }
            }
            Some(prev) => {
                let d = ctx as f64 - prev.ctx as f64;
                self.spread_outputs(&prev.outs, prev.out as f64);
                let u = d - prev.out as f64;
                let inputs = std::mem::take(&mut self.inputs);
                self.spread_inputs(&inputs, u);
            }
        }
        self.inputs = std::mem::take(&mut self.deferred);
        let outs = std::mem::take(&mut self.staged_outs);
        self.staged_calls.clear();
        self.cur = Some(Req { id, ctx, out, outs });
        self.total = ctx;
    }

    /// Characters per token for a kind of text: prose (memory, skills, prompts,
    /// summaries) and tool schemas at fixed typical ratios; tool output and files
    /// at the ratio this transcript's calibrated steps taught.
    fn cpt_for(&self, k: PartKind) -> f64 {
        match k {
            PartKind::Memory | PartKind::Skills | PartKind::Summary | PartKind::Chat | PartKind::System => PROSE_CPT,
            PartKind::Tools => SCHEMA_CPT,
            PartKind::Image => DEFAULT_CPT,
            _ => self.cpt(),
        }
    }

    /// Estimated tokens of `chars` characters of a part.
    fn est(&self, k: &Key, chars: f64) -> f64 {
        chars / self.cpt_for(k.0)
    }

    fn spread_outputs(&mut self, outs: &[(Key, Option<f64>)], out: f64) {
        if out <= 0.0 {
            return;
        }
        if outs.is_empty() {
            self.add(&key(PartKind::Chat, "Conversation"), out, true);
            return;
        }
        let ests: Vec<Option<f64>> = outs.iter().map(|(k, c)| c.map(|c| self.est(k, c))).collect();
        let known: f64 = ests.iter().flatten().sum();
        let unknown = ests.iter().filter(|c| c.is_none()).count();
        if unknown == 0 {
            // The exact output count, split by estimated size.
            for ((k, _), e) in outs.iter().zip(&ests) {
                let t = if known > 0.0 { out * e.unwrap_or(0.0) / known } else { out / outs.len() as f64 };
                self.add(k, t, true);
            }
            return;
        }
        // Thinking the transcript leaves out takes what the logged blocks don't explain.
        let scale = if known > out { out / known } else { 1.0 };
        let rest = (out - known * scale).max(0.0) / unknown as f64;
        for ((k, _), e) in outs.iter().zip(&ests) {
            self.add(k, e.map_or(rest, |e| e * scale), true);
        }
    }

    fn spread_inputs(&mut self, inputs: &[(Key, f64)], u: f64) {
        let ests: Vec<f64> = inputs.iter().map(|(k, c)| self.est(k, *c)).collect();
        let est: f64 = ests.iter().sum();
        let chars: f64 = inputs.iter().map(|(_, c)| c).sum();
        if u < 0.0 {
            // The context shrank: the new items still came in; older ones went.
            for ((k, _), e) in inputs.iter().zip(&ests) {
                self.add(k, *e, false);
            }
            self.remove(-u + est);
            return;
        }
        if est <= 0.0 {
            if u > 0.0 {
                self.add(&key(PartKind::Other, "Not in the transcript"), u, false);
            }
            return;
        }
        if u > 0.0 && chars / u < MIN_CPT {
            // More arrived than the logged items explain: they get their estimate, the rest is unlogged.
            let mut used = 0.0;
            for ((k, _), e) in inputs.iter().zip(&ests) {
                let t = e.min(u - used);
                used += t;
                self.add(k, t, false);
            }
            self.add(&key(PartKind::Other, "Not in the transcript"), u - used, false);
            return;
        }
        // Learn the ratio from steps of plain tool output only.
        let learnable = inputs.iter().all(|(k, _)| matches!(k.0, PartKind::Tool | PartKind::File | PartKind::Agent));
        if learnable && u > 0.0 && chars >= 400.0 && chars / u <= MAX_CPT {
            self.cal_chars += chars;
            self.cal_tokens += u;
        }
        // The step's real growth, split by estimated size.
        for ((k, _), e) in inputs.iter().zip(&ests) {
            self.add(k, u * e / est, true);
        }
    }

    /// Takes `amount` tokens off the parts: thinking first, then tool output, then the rest.
    fn remove(&mut self, mut amount: f64) {
        let tiers: [&[PartKind]; 3] = [
            &[PartKind::Thinking],
            &[PartKind::Tool, PartKind::File, PartKind::Agent, PartKind::Image],
            &[PartKind::Chat, PartKind::Other, PartKind::Skills, PartKind::Tools, PartKind::Memory, PartKind::Summary, PartKind::System],
        ];
        for tier in tiers {
            if amount <= 0.0 {
                break;
            }
            let have: f64 = self.parts.iter().filter(|(k, _)| tier.contains(&k.0)).map(|(_, a)| a.tokens).sum();
            if have <= 0.0 {
                continue;
            }
            let take = amount.min(have);
            let f = take / have;
            for (_, a) in self.parts.iter_mut().filter(|(k, _)| tier.contains(&k.0)) {
                a.cal -= a.cal * f;
                a.tokens -= a.tokens * f;
            }
            amount -= take;
        }
        // Whatever is left comes off the fixed part (see `snapshot`).
        if amount > 0.0 {
            self.base = self.base.saturating_sub(amount.round() as u64);
        }
    }

    fn compacted(&mut self, before: Option<u64>, after: Option<u64>, at: Option<u64>, auto: bool) {
        let before_parts = if self.cur.is_some() { self.snapshot().parts } else { Vec::new() };
        let before = before.filter(|b| *b > 0).unwrap_or(self.total);
        let keep = (self.evidence.clone(), self.disk_memory.clone(), self.cal_chars, self.cal_tokens, std::mem::take(&mut self.recent));
        *self = Self { codex: self.codex, codex_totals: self.codex_totals, codex_meta: self.codex_meta, ..Self::default() };
        (self.evidence, self.disk_memory, self.cal_chars, self.cal_tokens, self.recent) = keep;
        // A history that starts compacted (a forked rollout) is no compaction of this one.
        self.compaction = (before > 0).then(|| Compaction { before, after: after.unwrap_or(0), at, auto, before_parts });
    }

    /// The map as of the latest request.
    pub(crate) fn snapshot(&self) -> ContextMap {
        let Some(_) = &self.cur else {
            // Compacted, no request since: the latest request is still the one
            // before it (what the session list shows), so that is the map.
            if let Some(c) = &self.compaction
                && !c.before_parts.is_empty()
            {
                return ContextMap {
                    total: c.before_parts.iter().map(|p| p.tokens).sum(),
                    parts: c.before_parts.clone(),
                    compaction: self.compaction.clone(),
                    note: Some("Compacted: the map shows the last request before it until the next reply.".into()),
                    chars_per_token: None,
                };
            }
            return ContextMap { compaction: self.compaction.clone(), ..ContextMap::default() };
        };
        let cpt = self.cpt();
        let mut parts: HashMap<Key, Acc> = self.parts.clone();
        // The first request held what was logged before it plus what the
        // transcript never shows. Both are sized by length (the logged items,
        // and the evidence of the unlogged: a logged system prompt / tool list,
        // CLAUDE.md files on disk); if they add up to more than the request,
        // all shrink alike; what they don't explain is the remainder.
        let memory_logged = self.pre.iter().any(|(k, _)| k.0 == PartKind::Memory) || parts.keys().any(|k| k.0 == PartKind::Memory);
        let mut ev: Vec<(Key, f64)> = Vec::new();
        if self.evidence.system > 0.0 {
            ev.push((key(PartKind::System, "System prompt"), self.evidence.system / PROSE_CPT));
        }
        if self.evidence.tools > 0.0 {
            ev.push((key(PartKind::Tools, "Tool definitions"), self.evidence.tools / SCHEMA_CPT));
        }
        if !memory_logged {
            let bytes: u64 = self.disk_memory.iter().map(|(_, b)| b).sum();
            if bytes > 0 {
                ev.push((key(PartKind::Memory, "Project memory"), bytes as f64 / PROSE_CPT));
            }
        }
        let pool: Vec<(Key, f64)> = self.pre.iter().map(|(k, c)| (k.clone(), self.est(k, *c))).chain(ev.iter().cloned()).collect();
        let pooled: f64 = pool.iter().map(|(_, t)| t).sum();
        let base = self.base as f64;
        let scale = if pooled > base && pooled > 0.0 { base / pooled } else { 1.0 };
        for (k, t) in &pool {
            parts.entry(k.clone()).or_default().tokens += t * scale;
        }
        let fixed = (base - pooled * scale).max(0.0);
        let rest_label = if ev.is_empty() { "System and tools" } else { "Other system context" };
        if fixed >= 1.0 {
            parts.entry(key(PartKind::System, rest_label)).or_default().tokens += fixed;
        }

        let mut out = self.parts_out(parts, rest_label, &ev);
        round_to(&mut out, self.total);
        let mut out: Vec<Part> = out.into_iter().map(|(p, _)| p).filter(|p| p.tokens > 0).collect();
        out.sort_by(|a, b| b.tokens.cmp(&a.tokens).then(a.id.cmp(&b.id)));
        ContextMap {
            total: self.total,
            parts: out,
            compaction: self.compaction.clone(),
            note: None,
            chars_per_token: (self.cal_tokens >= 1500.0).then(|| (cpt * 100.0).round() / 100.0),
        }
    }

    fn parts_out(&self, parts: HashMap<Key, Acc>, rest_label: &str, ev: &[(Key, f64)]) -> Vec<(Part, f64)> {
        let mut files: Vec<(Key, Acc)> = Vec::new();
        let mut out: Vec<(Part, f64)> = Vec::new();
        for (k, a) in parts {
            if a.tokens <= 0.0 {
                continue;
            }
            if k.0 == PartKind::File {
                files.push((k, a));
                continue;
            }
            let basis = if k.0 == PartKind::System && k.1 == rest_label {
                Basis::Remainder
            } else if ev.iter().any(|(e, _)| *e == k) || a.cal < a.tokens * 0.5 {
                Basis::Estimated
            } else {
                Basis::Calibrated
            };
            let id = format!("{:?}:{}", k.0, k.1).to_lowercase();
            out.push((Part { id, kind: k.0, label: k.1.clone(), tokens: 0, count: a.count, path: None, basis }, a.tokens));
        }
        files.sort_by(|a, b| b.1.tokens.total_cmp(&a.1.tokens).then(a.0.1.cmp(&b.0.1)));
        let rest = if files.len() > FILES_SHOWN + 1 { files.split_off(FILES_SHOWN) } else { Vec::new() };
        for (k, a) in files {
            let basis = if a.cal < a.tokens * 0.5 { Basis::Estimated } else { Basis::Calibrated };
            let label = Path::new(&k.1).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_else(|| k.1.clone());
            out.push((Part { id: format!("file:{}", k.1), kind: PartKind::File, label, tokens: 0, count: a.count, path: Some(k.1), basis }, a.tokens));
        }
        if !rest.is_empty() {
            let t: f64 = rest.iter().map(|(_, a)| a.tokens).sum();
            let cal: f64 = rest.iter().map(|(_, a)| a.cal).sum();
            let names: Vec<String> = rest.iter().take(4).map(|(k, _)| k.1.clone()).collect();
            let basis = if cal < t * 0.5 { Basis::Estimated } else { Basis::Calibrated };
            out.push((
                Part { id: "file:*".into(), kind: PartKind::File, label: format!("{} other files", rest.len()), tokens: 0, count: rest.len() as u32, path: Some(names.join("\n")), basis },
                t,
            ));
        }
        out
    }

    // ---------- Claude Code ----------

    pub(crate) fn claude_line(&mut self, line: &str) {
        if line.contains("\"type\":\"api-request\"") || line.contains("\"type\":\"api-request-blob\"") || line.contains("\"type\":\"file-history-snapshot\"") {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { return };
        self.claude_value(&v);
    }

    fn claude_value(&mut self, v: &Value) {
        match v["type"].as_str() {
            Some("system") if v["subtype"] == "compact_boundary" => {
                let m = &v["compactMetadata"];
                let preserved: HashSet<&str> = m["preservedMessages"]["uuids"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                let kept: Vec<(Key, f64)> = self.recent.iter().filter(|(u, _)| preserved.contains(u.as_str())).flat_map(|(_, items)| items.clone()).collect();
                let at = v["timestamp"].as_str().and_then(crate::util::parse_rfc3339_ms);
                self.compacted(m["preTokens"].as_u64(), m["postTokens"].as_u64(), at, m["trigger"] != "manual");
                for (k, c) in kept {
                    self.input(k, c);
                }
            }
            Some("api-request-shape") => {
                let s = &v["shape"];
                self.claude_shape(&s["system"], &s["tools"]);
            }
            Some("attachment") => self.claude_attachment(&v["attachment"]),
            Some("user") => self.claude_user(v),
            Some("assistant") => self.claude_assistant(v),
            _ => {}
        }
    }

    fn claude_shape(&mut self, system: &Value, tools: &Value) {
        let sys: usize = system.as_array().into_iter().flatten().map(|b| b["text"].as_str().or(b.as_str()).map_or(0, str::len)).sum();
        if sys > 0 {
            self.evidence.system = sys as f64;
        }
        if let Some(ts) = tools.as_array() {
            let n: usize = ts.iter().filter(|t| t["defer_loading"] != true && t["schema"]["defer_loading"] != true).map(|t| json_len(t.get("schema").unwrap_or(t))).sum();
            if n > 0 {
                self.evidence.tools = n as f64;
            }
        }
    }

    fn claude_attachment(&mut self, a: &Value) {
        let k = a["type"].as_str().unwrap_or("");
        match k {
            "instructions" => {
                for f in a["files"].as_array().into_iter().flatten() {
                    let path = f["path"].as_str().unwrap_or("CLAUDE.md");
                    let len = f["content"].as_str().map_or(0, str::len);
                    let k = key(PartKind::Memory, memory_label(path));
                    self.bump(&k);
                    self.input(k, len as f64);
                }
            }
            "skill_listing" => self.input(key(PartKind::Skills, "Skills"), str_len(&a["content"])),
            "invoked_skills" => {
                let n: usize = a["skills"].as_array().into_iter().flatten().map(|s| s["content"].as_str().map_or(0, str::len)).sum();
                self.input(key(PartKind::Skills, "Skills"), n as f64);
            }
            "deferred_tools_delta" | "mcp_instructions_delta" | "agent_listing_delta" => self.input(key(PartKind::Tools, "Tool definitions"), json_len(a) as f64),
            "file" | "edited_text_file" => {
                let f = &a["content"]["file"];
                let path = f["filePath"].as_str().or(a["filename"].as_str()).unwrap_or("file").to_string();
                let len = f["content"].as_str().map(str::len).unwrap_or_else(|| a["snippet"].as_str().map_or(json_len(&a["content"]), str::len));
                let k = key(PartKind::File, path);
                self.bump(&k);
                self.input(k, len as f64);
            }
            "queued_command" => self.input(key(PartKind::Chat, "Conversation"), json_len(&a["prompt"]) as f64),
            "prompt_snapshot" => self.claude_shape(&a["systemPrompt"], &a["tools"]),
            // Bookkeeping, not context.
            "compact_file_reference" | "deferred_tools_record" | "total_tokens_reminder" | "credential_org" | "remote_session_change" | "session_cron_carry" | "thinking_drop" => {}
            _ => self.input(key(PartKind::Other, "Reminders"), json_len(a) as f64),
        }
    }

    /// Input items logged from here on, for [`Builder::remember`].
    fn mark(&self) -> (usize, usize) {
        (self.pre.len(), self.inputs.len())
    }

    /// Claude: remembers a record's items under its uuid, so a compaction that
    /// preserves it verbatim can count it again.
    fn remember(&mut self, v: &Value, (pre, inputs): (usize, usize), extra: Vec<(Key, f64)>) {
        let Some(uuid) = v["uuid"].as_str() else { return };
        let mut items: Vec<(Key, f64)> = self.pre.get(pre..).unwrap_or_default().to_vec();
        items.extend_from_slice(self.inputs.get(inputs..).unwrap_or_default());
        items.extend(extra);
        if items.is_empty() {
            return;
        }
        self.recent.push_back((uuid.to_string(), items));
        if self.recent.len() > RECENT {
            self.recent.pop_front();
        }
    }

    fn claude_user(&mut self, v: &Value) {
        let mark = self.mark();
        let meta = v["isMeta"] == true;
        let content = &v["message"]["content"];
        if v["isCompactSummary"] == true {
            let k = key(PartKind::Summary, "Summary");
            self.bump(&k);
            self.input(k, json_text_len(content));
        } else if let Some(s) = content.as_str() {
            self.input(user_text_key(s, meta), s.len() as f64);
        } else {
            for b in content.as_array().into_iter().flatten() {
                match b["type"].as_str() {
                    Some("tool_result") => {
                        let k = b["tool_use_id"].as_str().and_then(|id| self.calls.remove(id)).unwrap_or_else(|| key(PartKind::Tool, "Other tools"));
                        let (chars, images) = result_len(&b["content"]);
                        self.input(k, chars);
                        if images > 0.0 {
                            self.input(key(PartKind::Image, "Images"), images);
                        }
                    }
                    Some("text") => {
                        let s = b["text"].as_str().unwrap_or("");
                        self.input(user_text_key(s, meta), s.len() as f64);
                    }
                    Some("image") => {
                        let k = key(PartKind::Image, "Images");
                        self.bump(&k);
                        self.input(k, image_chars(b));
                    }
                    Some("document") => self.input(key(PartKind::File, "Documents"), json_len(&b["source"]) as f64 / 4.0),
                    _ => {}
                }
            }
        }
        if v["isCompactSummary"] != true {
            self.remember(v, mark, Vec::new());
        }
    }

    fn claude_assistant(&mut self, v: &Value) {
        let msg = &v["message"];
        if msg["model"] == "<synthetic>" {
            return;
        }
        let u = &msg["usage"];
        let g = |k: &str| u[k].as_u64().unwrap_or(0);
        let ctx = g("input_tokens") + g("cache_creation_input_tokens") + g("cache_read_input_tokens");
        let id = msg["id"].as_str().or(v["requestId"].as_str()).unwrap_or("").to_string();
        match self.cur.as_mut() {
            Some(c) if c.id == id && !id.is_empty() => c.out = c.out.max(g("output_tokens")),
            _ if ctx > 0 => self.request(id, ctx, g("output_tokens")),
            _ => return,
        }
        let mark = self.mark();
        let before = self.cur.as_ref().map_or(0, |c| c.outs.len());
        for b in msg["content"].as_array().into_iter().flatten() {
            match b["type"].as_str() {
                Some("text") => self.output(key(PartKind::Chat, "Conversation"), Some(str_len(&b["text"]))),
                Some("thinking") => {
                    let n = str_len(&b["thinking"]);
                    self.output(key(PartKind::Thinking, "Thinking"), (n > 0.0).then_some(n));
                }
                Some("redacted_thinking") => self.output(key(PartKind::Thinking, "Thinking"), None),
                Some("tool_use") => {
                    let name = b["name"].as_str().unwrap_or("tool");
                    let k = classify(name, &b["input"]);
                    self.bump(&k);
                    if let Some(id) = b["id"].as_str() {
                        self.calls.insert(id.to_string(), k.clone());
                    }
                    self.output(k, Some(json_len(&b["input"]) as f64));
                }
                _ => {}
            }
        }
        // Preserved verbatim by a later compaction, these come back as plain history.
        let outs: Vec<(Key, f64)> = self.cur.as_ref().map(|c| c.outs[before.min(c.outs.len())..].iter().map(|(k, c)| (k.clone(), c.unwrap_or(0.0))).collect()).unwrap_or_default();
        self.remember(v, mark, outs);
    }

    // ---------- Codex ----------

    pub(crate) fn codex_line(&mut self, line: &str) {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return };
        self.codex_value(&v);
    }

    fn codex_value(&mut self, v: &Value) {
        let p = &v["payload"];
        match (v["type"].as_str(), p["type"].as_str()) {
            (Some("session_meta"), _) if !self.codex_meta => {
                self.codex_meta = true;
                let n = p["base_instructions"]["text"].as_str().or(p["instructions"].as_str()).map_or(0, str::len);
                if n > 0 {
                    self.evidence.system = n as f64;
                }
            }
            (Some("compacted"), _) => {
                let at = v["timestamp"].as_str().and_then(crate::util::parse_rfc3339_ms);
                self.compacted(None, None, at, true);
                let msg = str_len(&p["message"]);
                if msg > 0.0 {
                    let k = key(PartKind::Summary, "Summary");
                    self.bump(&k);
                    self.input(k, msg);
                }
                for item in p["replacement_history"].as_array().into_iter().flatten() {
                    self.codex_item(item, true);
                }
            }
            (Some("response_item"), _) => self.codex_item(p, false),
            (Some("event_msg"), Some("token_count")) if p["info"]["total_token_usage"].is_object() => {
                let tot = &p["info"]["total_token_usage"];
                let g = |o: &Value, k: &str| o[k].as_u64().unwrap_or(0);
                let now = (g(tot, "input_tokens"), g(tot, "cached_input_tokens"), g(tot, "output_tokens"));
                let last = &p["info"]["last_token_usage"];
                let ctx = g(last, "input_tokens");
                if now != self.codex_totals && ctx > 0 {
                    self.codex_totals = now;
                    self.request(String::new(), ctx, g(last, "output_tokens"));
                } else if ctx > 0 {
                    self.total = ctx;
                }
            }
            _ => {}
        }
    }

    /// One history item. `restored`: from a compaction's replacement history (all inputs).
    fn codex_item(&mut self, p: &Value, restored: bool) {
        let t = p["type"].as_str().unwrap_or("");
        let out = |s: &mut Self, k: Key, c: Option<f64>| if restored { s.input(k, c.unwrap_or(0.0)) } else { s.output(k, c) };
        match t {
            "message" => {
                let role = p["role"].as_str().unwrap_or("");
                let (text, images) = codex_content(&p["content"]);
                if images > 0.0 {
                    let k = key(PartKind::Image, "Images");
                    self.bump(&k);
                    self.input(k, images);
                }
                match role {
                    "assistant" => out(self, key(PartKind::Chat, "Conversation"), Some(text.len() as f64)),
                    "developer" | "system" => self.input(key(PartKind::System, "Developer instructions"), text.len() as f64),
                    _ => {
                        let head: String = text.chars().take(300).collect();
                        let k = if head.contains("AGENTS.md") || head.contains("<user_instructions>") {
                            key(PartKind::Memory, "AGENTS.md")
                        } else if head.trim_start().starts_with('<') {
                            key(PartKind::Other, "Reminders")
                        } else {
                            key(PartKind::Chat, "Conversation")
                        };
                        self.input(k, text.len() as f64);
                    }
                }
            }
            "agent_message" => {
                let (text, _) = codex_content(&p["content"]);
                let n = if text.is_empty() { json_len(p) } else { text.len() };
                self.input(key(PartKind::Agent, "Sub-agents"), n as f64);
            }
            "reasoning" => {
                let n = p["encrypted_content"].as_str().map_or(0.0, |s| s.len() as f64 * 0.75);
                let summary: usize = p["summary"].as_array().into_iter().flatten().map(|s| s["text"].as_str().map_or(0, str::len)).sum();
                // Encrypted: its length says little; logged as unknown so the output count decides.
                out(self, key(PartKind::Thinking, "Thinking"), if restored { Some(n.max(summary as f64)) } else { None });
            }
            "function_call" | "custom_tool_call" | "local_shell_call" => {
                let name = p["name"].as_str().unwrap_or(if t == "local_shell_call" { "shell" } else { "tool" });
                let args: Value = match &p["arguments"] {
                    Value::String(s) => serde_json::from_str(s).unwrap_or_else(|_| Value::String(s.clone())),
                    Value::Null => p.get("input").or(p.get("action")).cloned().unwrap_or(Value::Null),
                    a => a.clone(),
                };
                // Code mode: the `exec` script's tool call is what the step does (a patch goes to its file).
                let k = match crate::codex::code_mode_call(name, &args) {
                    Some((n, a)) => classify(&n, &a),
                    None => classify(name, &args),
                };
                self.bump(&k);
                if let Some(id) = p["call_id"].as_str() {
                    self.calls.insert(id.to_string(), k.clone());
                    if !restored {
                        self.staged_calls.insert(id.to_string());
                    }
                }
                out(self, k, Some(json_len(&args) as f64));
            }
            "function_call_output" | "custom_tool_call_output" | "local_shell_call_output" => {
                let id = p["call_id"].as_str().unwrap_or("");
                let k = self.calls.get(id).cloned().unwrap_or_else(|| key(PartKind::Tool, "Other tools"));
                let (chars, images) = match &p["output"] {
                    Value::String(s) => (s.len() as f64, 0.0),
                    o => result_len(o),
                };
                if !restored && self.staged_calls.contains(id) {
                    self.deferred.push((k, chars));
                    if images > 0.0 {
                        self.deferred.push((key(PartKind::Image, "Images"), images));
                    }
                } else {
                    self.input(k, chars);
                    if images > 0.0 {
                        self.input(key(PartKind::Image, "Images"), images);
                    }
                }
            }
            "additional_tools" => self.input(key(PartKind::Tools, "Tool definitions"), json_len(&p["tools"]) as f64),
            "compaction" => {
                let k = key(PartKind::Summary, "Summary");
                self.bump(&k);
                self.input(k, p["encrypted_content"].as_str().map_or(0.0, |s| s.len() as f64 * 0.75));
            }
            _ => {}
        }
    }
}

/// Tokens as whole numbers that sum to `total` exactly (largest remainder).
fn round_to(parts: &mut [(Part, f64)], total: u64) {
    let sum: f64 = parts.iter().map(|(_, t)| t.max(0.0)).sum();
    if sum <= 0.0 {
        return;
    }
    let f = total as f64 / sum;
    let mut floors: Vec<(usize, f64)> = Vec::with_capacity(parts.len());
    let mut used = 0u64;
    for (i, (p, t)) in parts.iter_mut().enumerate() {
        let x = t.max(0.0) * f;
        p.tokens = x.floor() as u64;
        used += p.tokens;
        floors.push((i, x - x.floor()));
    }
    floors.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut left = total.saturating_sub(used);
    for (i, _) in floors {
        if left == 0 {
            break;
        }
        parts[i].0.tokens += 1;
        left -= 1;
    }
}

pub(crate) fn json_len(v: &Value) -> usize {
    match v {
        Value::Null => 0,
        Value::String(s) => s.len(),
        v => serde_json::to_string(v).map_or(0, |s| s.len()),
    }
}

fn str_len(v: &Value) -> f64 {
    v.as_str().map_or(0.0, |s| s.len() as f64)
}

/// Text length of a message content (a string or blocks).
fn json_text_len(c: &Value) -> f64 {
    if let Some(s) = c.as_str() {
        return s.len() as f64;
    }
    c.as_array().into_iter().flatten().map(|b| b["text"].as_str().map_or(0, str::len)).sum::<usize>() as f64
}

/// A tool result's (text chars, image chars-equivalent).
fn result_len(c: &Value) -> (f64, f64) {
    match c {
        Value::String(s) => (s.len() as f64, 0.0),
        Value::Array(a) => {
            let mut text = 0.0;
            let mut img = 0.0;
            for b in a {
                match b["type"].as_str() {
                    Some("image") | Some("input_image") => img += image_chars(b),
                    Some("tool_reference") => text += 600.0,
                    _ => text += b["text"].as_str().map_or_else(|| json_len(b) as f64, |s| s.len() as f64),
                }
            }
            (text, img)
        }
        Value::Null => (0.0, 0.0),
        o => (json_len(o) as f64, 0.0),
    }
}

/// An image block as characters at the default ratio: Claude bills ~w*h/750
/// tokens after scaling the long edge to 1568px; PNG headers give the size.
fn image_chars(b: &Value) -> f64 {
    let data = b["source"]["data"].as_str().or(b["image_url"].as_str()).unwrap_or("");
    let data = data.split_once("base64,").map_or(data, |(_, d)| d);
    let tokens = png_size(data)
        .map(|(w, h)| {
            let s = (1568.0 / w.max(h) as f64).min(1.0);
            ((w as f64 * s) * (h as f64 * s) / 750.0).clamp(85.0, 1600.0)
        })
        .unwrap_or(1600.0);
    tokens * DEFAULT_CPT
}

fn png_size(b64: &str) -> Option<(u32, u32)> {
    let head = b64.get(..32)?;
    let bytes = b64_decode(head)?;
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    (w > 0 && h > 0).then_some((w, h))
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        } as u32)
    };
    let mut out = Vec::new();
    for ch in s.as_bytes().chunks(4) {
        if ch.len() < 4 {
            break;
        }
        let n = (val(ch[0])? << 18) | (val(ch[1])? << 12) | (val(ch[2])? << 6) | val(ch[3])?;
        out.extend_from_slice(&[(n >> 16) as u8, (n >> 8) as u8, n as u8]);
    }
    Some(out)
}

/// Codex message content: (joined text, image chars-equivalent).
fn codex_content(c: &Value) -> (String, f64) {
    if let Some(s) = c.as_str() {
        return (s.to_string(), 0.0);
    }
    let mut text = String::new();
    let mut img = 0.0;
    for b in c.as_array().into_iter().flatten() {
        if b["type"] == "input_image" {
            img += image_chars(b);
        } else if let Some(t) = b["text"].as_str() {
            text.push_str(t);
        }
    }
    (text, img)
}

fn user_text_key(s: &str, meta: bool) -> Key {
    if s.starts_with("Base directory for this skill") {
        key(PartKind::Skills, "Skills")
    } else if meta || s.trim_start().starts_with("<system-reminder>") {
        key(PartKind::Other, "Reminders")
    } else {
        key(PartKind::Chat, "Conversation")
    }
}

fn memory_label(path: &str) -> &'static str {
    let user = dirs::home_dir().is_some_and(|h| Path::new(path).starts_with(h.join(".claude")));
    if user { "User memory" } else { "Project memory" }
}

/// Which part a tool call (and its result) belongs to.
pub(crate) fn classify(name: &str, input: &Value) -> Key {
    let path = |k: &str| input[k].as_str().filter(|s| !s.is_empty()).map(str::to_string);
    let file = |p: Option<String>| p.map(|p| key(PartKind::File, p));
    if let Some(rest) = name.strip_prefix("mcp__") {
        let server = rest.split("__").next().unwrap_or(rest);
        return key(PartKind::Tool, format!("MCP · {server}"));
    }
    match name {
        "Read" | "NotebookRead" | "Write" | "Edit" | "MultiEdit" | "read_file" | "view_file" => file(path("file_path").or(path("path"))).unwrap_or_else(|| key(PartKind::Tool, "Other tools")),
        "NotebookEdit" => file(path("notebook_path")).unwrap_or_else(|| key(PartKind::Tool, "Other tools")),
        "apply_patch" => {
            let patch = input.as_str().map(str::to_string).or(path("input")).or(path("patch")).unwrap_or_default();
            patch
                .lines()
                .find_map(|l| ["*** Update File: ", "*** Add File: ", "*** Delete File: "].iter().find_map(|p| l.strip_prefix(p)))
                .map(|p| key(PartKind::File, p.trim()))
                .unwrap_or_else(|| key(PartKind::Tool, "Edits"))
        }
        "Grep" | "Glob" | "LS" | "grep" | "glob" | "find" | "list_dir" => key(PartKind::Tool, "Searches"),
        "ToolSearch" => key(PartKind::Tools, "Tool definitions"),
        "WebFetch" | "WebSearch" | "web_search" | "web_fetch" => key(PartKind::Tool, "Web"),
        "Agent" | "Task" | "spawn_agent" | "wait_agent" | "followup_task" | "send_message" | "send_input" | "wait" | "close_agent" | "resume_agent" => key(PartKind::Agent, "Sub-agents"),
        "Skill" => key(PartKind::Skills, "Skills"),
        "view_image" => key(PartKind::Image, "Images"),
        "Bash" | "shell" | "exec_command" | "exec" | "local_shell" | "container.exec" | "unified_exec" => {
            let cmd = match input {
                Value::String(s) => s.clone(),
                _ => match &input["command"] {
                    Value::String(s) => s.clone(),
                    Value::Array(a) => a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "),
                    _ => input["cmd"].as_str().or(input["code"].as_str()).unwrap_or("").to_string(),
                },
            };
            shell_key(&cmd)
        }
        "BashOutput" | "TaskOutput" | "KillShell" | "Monitor" | "write_stdin" => key(PartKind::Tool, "Shell"),
        _ => key(PartKind::Tool, "Other tools"),
    }
}

/// A shell command's part: a test run, a plain file read, or shell output.
fn shell_key(cmd: &str) -> Key {
    let cmd = cmd.trim();
    // `bash -lc '...'` wrappers (Codex).
    let inner = ["bash -lc ", "bash -c ", "zsh -lc ", "sh -c "].iter().find_map(|p| cmd.strip_prefix(p)).map(|s| s.trim_matches(|c| c == '\'' || c == '"')).unwrap_or(cmd);
    if is_test(inner) {
        return key(PartKind::Tool, "Test runs");
    }
    if let Some(p) = file_read(inner) {
        return key(PartKind::File, p);
    }
    key(PartKind::Tool, "Shell")
}

fn is_test(cmd: &str) -> bool {
    const WORDS: &[&str] = &["test", "tests", "pytest", "vitest", "jest", "nextest", "rspec", "playwright", "phpunit", "mocha", "ctest"];
    let toks: Vec<&str> = cmd.split(|c: char| c.is_whitespace() || c == ';' || c == '&' || c == '|' || c == '(' || c == ')').filter(|t| !t.is_empty()).collect();
    toks.iter().enumerate().any(|(i, t)| {
        let t = t.rsplit('/').next().unwrap_or(t);
        let w = t.split(':').next().unwrap_or(t);
        // `test -f x` is the shell's test, not a test run.
        WORDS.contains(&w) && !(w == "test" && (i == 0 || toks.get(i + 1).is_some_and(|n| n.len() == 2 && n.starts_with('-') && n.as_bytes()[1].is_ascii_alphabetic())))
    })
}

/// `cat path`, `sed -n '1,80p' path`, `head -50 path`...: the path, when the whole command is a read of one file.
fn file_read(cmd: &str) -> Option<String> {
    if cmd.contains(['|', ';', '>', '&', '$', '`']) {
        return None;
    }
    let toks: Vec<&str> = cmd.split_whitespace().collect();
    let prog = *toks.first()?;
    if !matches!(prog, "cat" | "head" | "tail" | "nl" | "sed" | "bat" | "less") || (prog == "sed" && !toks.contains(&"-n")) || toks.len() < 2 {
        return None;
    }
    let last = toks.last()?.trim_matches(|c| c == '\'' || c == '"');
    // A path, or a name with an extension ("1,80p" is neither).
    let pathish = last.contains('/') || last.rsplit_once('.').is_some_and(|(a, b)| !a.is_empty() && b.chars().all(|c| c.is_ascii_alphanumeric()) && b.chars().any(|c| c.is_ascii_alphabetic()));
    (!last.starts_with('-') && pathish).then(|| last.to_string())
}

/// CLAUDE.md files Claude Code would load for `cwd` (user, each folder up from it), with their sizes.
pub fn claude_memory_files(cwd: &str) -> Vec<(String, u64)> {
    let mut out = Vec::new();
    let mut add = |p: PathBuf| {
        if let Ok(m) = std::fs::metadata(&p)
            && m.is_file()
            && m.len() > 0
        {
            out.push((p.to_string_lossy().into_owned(), m.len()));
        }
    };
    if let Some(h) = dirs::home_dir() {
        add(h.join(".claude").join("CLAUDE.md"));
    }
    if cwd.is_empty() {
        return out;
    }
    let mut dir = Some(Path::new(cwd));
    while let Some(d) = dir {
        if dirs::home_dir().as_deref() == Some(d) && d != Path::new(cwd) {
            // The home folder's own CLAUDE.md, if any, still counts; nothing above it.
            add(d.join("CLAUDE.md"));
            break;
        }
        add(d.join("CLAUDE.md"));
        add(d.join("CLAUDE.local.md"));
        add(d.join(".claude").join("CLAUDE.md"));
        dir = d.parent();
    }
    out
}

// ---------- reading transcripts ----------

/// Byte offsets of the starts of lines containing `needle` (unescaped JSON, so
/// mentions inside strings don't match), and of the last line containing any of `extra`.
fn scan_markers(path: &Path, needle: &[u8], extra: &[&[u8]]) -> std::io::Result<(Vec<u64>, Option<u64>)> {
    let mut f = File::open(path)?;
    let mut buf = vec![0u8; 4 << 20];
    let mut carry: Vec<u8> = Vec::new();
    let mut base = 0u64; // file offset of carry[0], always a line start
    let mut hits = Vec::new();
    let mut extra_hit = None;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        carry.extend_from_slice(&buf[..n]);
        // Process complete lines only; keep the tail for the next round.
        let Some(last_nl) = memchr::memrchr(b'\n', &carry) else { continue };
        let block = &carry[..=last_nl];
        for pos in memchr::memmem::find_iter(block, needle) {
            let ls = memchr::memrchr(b'\n', &block[..pos]).map_or(base, |i| base + i as u64 + 1);
            if hits.last() != Some(&ls) {
                hits.push(ls);
            }
        }
        for e in extra {
            if let Some(pos) = memchr::memmem::rfind(block, e) {
                let ls = memchr::memrchr(b'\n', &block[..pos]).map_or(base, |i| base + i as u64 + 1);
                if extra_hit.is_none_or(|h| ls > h) {
                    extra_hit = Some(ls);
                }
            }
        }
        let consumed = last_nl + 1;
        base += consumed as u64;
        carry.drain(..consumed);
    }
    Ok((hits, extra_hit))
}

fn read_line_at(path: &Path, offset: u64) -> Option<String> {
    let mut f = File::open(path).ok()?;
    f.seek(SeekFrom::Start(offset)).ok()?;
    let mut out = Vec::new();
    let mut buf = [0u8; 64 << 10];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        if let Some(i) = memchr::memchr(b'\n', &buf[..n]) {
            out.extend_from_slice(&buf[..i]);
            break;
        }
        out.extend_from_slice(&buf[..n]);
        if out.len() > 64 << 20 {
            return None;
        }
    }
    String::from_utf8(out).ok()
}

struct Scan {
    provider: Provider,
    tail: crate::tail::Tail,
    b: Builder,
    used: Instant,
}

impl Scan {
    fn open(path: &Path, provider: Provider, cwd: &str) -> Self {
        let (needle, extra): (&[u8], Vec<&[u8]>) = match provider {
            Provider::Claude => (b"\"subtype\":\"compact_boundary\"", vec![&b"\"type\":\"api-request-shape\""[..], &b"\"type\":\"prompt_snapshot\""[..]]),
            Provider::Codex => (b"\"type\":\"compacted\"", vec![]),
        };
        let (hits, shape) = scan_markers(path, needle, &extra).unwrap_or_default();
        // From the second-to-last boundary, so the latest compaction has its "before".
        let start = if hits.len() >= 2 { hits[hits.len() - 2] } else { 0 };
        let mut b = Builder::new(provider);
        if provider == Provider::Claude {
            b.disk_memory = claude_memory_files(cwd);
        }
        if start > 0 {
            // Evidence logged before where parsing starts.
            if let Some(off) = shape.filter(|o| *o < start)
                && let Some(l) = read_line_at(path, off)
                && let Ok(v) = serde_json::from_str::<Value>(&l)
            {
                match v["type"].as_str() {
                    Some("api-request-shape") => b.claude_shape(&v["shape"]["system"], &v["shape"]["tools"]),
                    _ => b.claude_shape(&v["attachment"]["systemPrompt"], &v["attachment"]["tools"]),
                }
            }
            if provider == Provider::Codex
                && let Some(l) = read_line_at(path, 0)
            {
                b.codex_line(&l);
            }
        }
        Self { provider, tail: crate::tail::Tail::resume(path, start, None), b, used: Instant::now() }
    }

    fn update(&mut self) {
        let Self { provider, tail, b, .. } = self;
        match provider {
            Provider::Claude => tail.for_each_line(|l| b.claude_line(l)),
            Provider::Codex => tail.for_each_line(|l| b.codex_line(l)),
        }
    }
}

/// Context maps of the transcripts whose panels are open, kept warm and read
/// incrementally. Holds at most a few; the least recently asked for goes first.
#[derive(Default)]
pub struct ContextMaps {
    scans: HashMap<PathBuf, Scan>,
}

const KEEP: usize = 4;

impl ContextMaps {
    pub fn new() -> Self {
        Self::default()
    }

    /// The map of the transcript at `path` (a session's or a subagent's) as of its latest request.
    pub fn map(&mut self, path: &Path, provider: Provider, cwd: &str) -> ContextMap {
        let rewound = self.scans.get_mut(path).is_some_and(|s| s.tail.rewound());
        if rewound || self.scans.get(path).is_some_and(|s| s.provider != provider) {
            self.scans.remove(path);
        }
        if !self.scans.contains_key(path) {
            if self.scans.len() >= KEEP
                && let Some(old) = self.scans.iter().min_by_key(|(_, s)| s.used).map(|(p, _)| p.clone())
            {
                self.scans.remove(&old);
            }
            self.scans.insert(path.to_path_buf(), Scan::open(path, provider, cwd));
        }
        let s = self.scans.get_mut(path).expect("inserted above");
        s.used = Instant::now();
        s.update();
        let mut m = s.b.snapshot();
        if m.total == 0 && m.note.is_none() {
            m.note = Some(match provider {
                Provider::Claude => "No reply yet: the map appears after the first response.".into(),
                Provider::Codex => "This rollout reports no per-request usage, so only the total is known.".into(),
            });
        }
        m
    }

    /// Forget a transcript (its panel closed).
    pub fn drop_path(&mut self, path: &Path) {
        self.scans.remove(path);
    }
}

/// The context size the session list shows for this transcript (the adapters'
/// own full parse), to check a map against.
pub fn reported_context(path: &Path, provider: Provider) -> u64 {
    let mut tail = crate::tail::Tail::new(path);
    match provider {
        Provider::Claude => {
            let mut p = crate::claude::Parsed::default();
            tail.for_each_line(|l| p.line(l));
            p.view().tokens.context
        }
        Provider::Codex => {
            let mut p = crate::codex::Parsed::default();
            tail.for_each_line(|l| p.line(l));
            p.view().tokens.context
        }
    }
}

/// One transcript's map in a single pass (tools and tests; the app uses [`ContextMaps`]).
pub fn map_file(path: &Path, provider: Provider, cwd: &str) -> ContextMap {
    ContextMaps::new().map(path, provider, cwd)
}

#[cfg(test)]
mod tests;
