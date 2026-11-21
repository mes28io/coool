//! What an agent changed, read from its transcript: one [`Edit`] per file per successful edit tool call, the
//! turns (the person's prompts), what the agent said, and the edit calls still running.
//!
//! - Claude Code: an `Edit` / `MultiEdit` / `Write` call (`tool_use` in an assistant line) and its result (a user
//!   line's `tool_result`, with `toolUseResult` in the transcript or `tool_use_result` on the stream). The result's
//!   `originalFile` is the file's exact content before the edit; the content after is that with the edit applied
//!   (`Write`: its `content`). Older results without `originalFile` keep the old/new strings, undone on the file
//!   as it is now.
//! - Codex: `apply_patch` (a `custom_tool_call` / `function_call`, or a call inside code mode's `exec` script) with its
//!   patch text, or the `patch_apply_begin` event's `changes` (which also carry a deleted file's content). An update
//!   is hunks of context / removed / added lines, put back in reverse on the file as it is now to find what it was.
//!
//! Reading is incremental: [`Reader::feed`] takes the bytes appended since the last call.

use super::diff::{Hunk, Op, split_lines, strip_eol};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Content before or after an edit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Known {
    /// The file didn't exist (before a create, after a delete).
    Absent,
    Text(String),
    /// Not recorded: worked out from the other side when needed.
    Unknown,
}

impl Known {
    pub fn text(&self) -> Option<&str> {
        match self {
            Known::Text(t) => Some(t),
            _ => None,
        }
    }
}

/// A way to undo an edit when its "before" wasn't recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reverse {
    /// Claude's old/new strings, in the order applied.
    Strings(Vec<(String, String, bool)>),
    /// Patch hunks (Codex): context / removed / added lines without terminators, and the `@@ anchor` line if any.
    Patch(Vec<PatchHunk>),
    /// Nothing to go on.
    None,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PatchHunk {
    pub anchor: Option<String>,
    pub lines: Vec<(Op, String)>,
    /// The hunk sits at the file's end (`*** End of File`).
    pub eof: bool,
}

#[derive(Clone, Debug)]
pub struct Edit {
    pub tool_id: String,
    /// Epoch ms.
    pub ts: u64,
    /// The subagent that made it (its id), None for the session itself.
    pub agent: Option<String>,
    /// Absolute path the content ends up at.
    pub path: PathBuf,
    /// A move: where the file was before.
    pub from: Option<PathBuf>,
    pub before: Known,
    pub after: Known,
    pub reverse: Reverse,
    /// Index into the transcript's turns (0 before the first prompt).
    pub turn: usize,
    /// Order of reading (ties on `ts`).
    pub seq: usize,
}

#[derive(Clone, Debug)]
pub struct Turn {
    pub ts: u64,
    pub prompt: String,
}

/// An agent's text, for "what it said about this file".
#[derive(Clone, Debug)]
pub struct Said {
    pub ts: u64,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Claude,
    Codex,
}

/// One transcript, read so far.
#[derive(Debug)]
pub struct Reader {
    kind: Kind,
    agent: Option<String>,
    cwd: PathBuf,
    pub offset: u64,
    partial: Vec<u8>,
    pub edits: Vec<Edit>,
    pub turns: Vec<Turn>,
    pub said: Vec<Said>,
    /// Edit calls without a result yet: tool id -> (paths, input, ts).
    open: HashMap<String, (Vec<PathBuf>, Value, u64, String)>,
    /// Codex: changes announced by `patch_apply_begin`, by call id.
    begun: HashMap<String, Value>,
    /// Codex calls already recorded (the end event and the output both say so).
    done: std::collections::HashSet<String>,
    seq: usize,
}

const EDIT_TOOLS: &[&str] = &["Edit", "MultiEdit", "Write"];

impl Reader {
    pub fn new(kind: Kind, agent: Option<String>, cwd: &Path) -> Self {
        Self { kind, agent, cwd: cwd.to_path_buf(), offset: 0, partial: Vec::new(), edits: Vec::new(), turns: Vec::new(), said: Vec::new(), open: HashMap::new(), begun: HashMap::new(), done: Default::default(), seq: 0 }
    }

    /// Paths of edit calls still running.
    pub fn busy(&self) -> Vec<PathBuf> {
        self.open.values().flat_map(|(p, ..)| p.iter().cloned()).collect()
    }

    /// Bytes appended to the transcript since the last call.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.offset += bytes.len() as u64;
        self.partial.extend_from_slice(bytes);
        let Some(last_nl) = self.partial.iter().rposition(|&c| c == b'\n') else { return };
        let done: Vec<u8> = self.partial.drain(..=last_nl).collect();
        for line in done.split(|&c| c == b'\n') {
            if line.is_empty() || !self.wanted(line) {
                continue;
            }
            if let Ok(v) = serde_json::from_slice::<Value>(line) {
                match self.kind {
                    Kind::Claude => self.claude(&v),
                    Kind::Codex => self.codex(&v),
                }
            }
        }
    }

    /// Cheap filter before parsing a line.
    fn wanted(&self, line: &[u8]) -> bool {
        let has = |n: &str| memchr::memmem::find(line, n.as_bytes()).is_some();
        match self.kind {
            Kind::Claude => has("\"type\":\"user\"") || (has("\"type\":\"assistant\"") && (has("\"text\"") || EDIT_TOOLS.iter().any(|t| has(&format!("\"name\":\"{t}\""))))),
            Kind::Codex => has("apply_patch") || has("patch_apply") || has("user_message") || has("agent_message") || has("\"output\""),
        }
    }

    fn abs(&self, p: &str) -> PathBuf {
        let p = Path::new(p);
        if p.is_absolute() { p.to_path_buf() } else { self.cwd.join(p) }
    }

    fn push(&mut self, mut e: Edit) {
        e.seq = self.seq;
        e.turn = self.turns.len();
        self.seq += 1;
        self.edits.push(e);
    }

    // ------------------------------------------------------------------------------------------------ Claude

    fn claude(&mut self, v: &Value) {
        let ts = v["timestamp"].as_str().and_then(crate::util::parse_rfc3339_ms).unwrap_or(0);
        match v["type"].as_str() {
            Some("assistant") => {
                for b in v["message"]["content"].as_array().into_iter().flatten() {
                    match b["type"].as_str() {
                        Some("tool_use") => {
                            let name = b["name"].as_str().unwrap_or("");
                            if !EDIT_TOOLS.contains(&name) {
                                continue;
                            }
                            let Some(id) = b["id"].as_str() else { continue };
                            let Some(fp) = b["input"]["file_path"].as_str() else { continue };
                            let p = self.abs(fp);
                            self.open.insert(id.to_string(), (vec![p], b["input"].clone(), ts, name.to_string()));
                        }
                        Some("text") if self.agent.is_none() => {
                            let t = b["text"].as_str().unwrap_or("").trim();
                            if !t.is_empty() {
                                self.said.push(Said { ts, text: crate::util::one_line(t, 300) });
                            }
                        }
                        _ => {}
                    }
                }
            }
            Some("user") => {
                let content = &v["message"]["content"];
                if self.agent.is_none() && v["isMeta"].as_bool() != Some(true) {
                    let prompt = content.as_str().map(str::to_string).or_else(|| {
                        let arr = content.as_array()?;
                        if arr.iter().any(|b| b["type"] == "tool_result") {
                            return None;
                        }
                        let t: Vec<&str> = arr.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
                        (!t.is_empty()).then(|| t.join(" "))
                    });
                    if let Some(p) = prompt {
                        let p = p.trim();
                        if !p.is_empty() && !p.starts_with('<') && !p.starts_with("[Request interrupted") {
                            self.turns.push(Turn { ts, prompt: crate::util::one_line(p, 160) });
                        }
                    }
                }
                let result = if v["toolUseResult"].is_object() { &v["toolUseResult"] } else { &v["tool_use_result"] };
                for b in content.as_array().into_iter().flatten() {
                    if b["type"] != "tool_result" {
                        continue;
                    }
                    let Some(id) = b["tool_use_id"].as_str() else { continue };
                    let Some((paths, input, call_ts, name)) = self.open.remove(id) else { continue };
                    if b["is_error"].as_bool() == Some(true) {
                        continue;
                    }
                    let path = paths.into_iter().next().unwrap();
                    if let Some(e) = claude_edit(id, &name, &input, result, path, if ts > 0 { ts } else { call_ts }, self.agent.clone()) {
                        self.push(e);
                    }
                }
            }
            _ => {}
        }
    }

    // ------------------------------------------------------------------------------------------------ Codex

    fn codex(&mut self, v: &Value) {
        let ts = v["timestamp"].as_str().and_then(crate::util::parse_rfc3339_ms).unwrap_or(0);
        let p = &v["payload"];
        match (v["type"].as_str(), p["type"].as_str()) {
            (Some("event_msg"), Some("user_message")) if self.agent.is_none() => {
                let t = p["message"].as_str().unwrap_or("").trim();
                if !t.is_empty() && !t.starts_with('<') {
                    self.turns.push(Turn { ts, prompt: crate::util::one_line(t, 160) });
                }
            }
            (Some("event_msg"), Some("agent_message")) if self.agent.is_none() => {
                let t = p["message"].as_str().unwrap_or("").trim();
                if !t.is_empty() {
                    self.said.push(Said { ts, text: crate::util::one_line(t, 300) });
                }
            }
            (Some("event_msg"), Some("patch_apply_begin")) => {
                if let Some(id) = p["call_id"].as_str() {
                    self.begun.insert(id.to_string(), p["changes"].clone());
                    if let Some(o) = self.open.get_mut(id) {
                        o.0 = change_paths(&p["changes"]).iter().map(|x| self.cwd.join(x)).collect();
                    }
                }
            }
            (Some("event_msg"), Some("patch_apply_end")) => {
                let Some(id) = p["call_id"].as_str() else { return };
                if p["success"].as_bool() == Some(false) {
                    self.open.remove(id);
                    self.begun.remove(id);
                    return;
                }
                let changes = if p["changes"].is_object() { p["changes"].clone() } else { self.begun.remove(id).unwrap_or(Value::Null) };
                if let Some((_, input, call_ts, _)) = self.open.remove(id) {
                    self.codex_done(id, &input, &changes, if ts > 0 { ts } else { call_ts });
                } else if changes.is_object() {
                    self.codex_done(id, &Value::Null, &changes, ts);
                }
            }
            (Some("response_item"), Some("function_call" | "custom_tool_call")) => {
                let name = p["name"].as_str().unwrap_or("");
                let input: Value = p["arguments"].as_str().and_then(|a| serde_json::from_str(a).ok()).unwrap_or_else(|| p["input"].clone());
                let (name, input) = crate::codex::code_mode_call(name, &input).unwrap_or((name.to_string(), input));
                if name != "apply_patch" {
                    return;
                }
                let text = input.as_str().or(input["input"].as_str()).or(input["patch"].as_str()).unwrap_or("").to_string();
                let Some(id) = p["call_id"].as_str() else { return };
                let paths = crate::codex::patch_paths(&text).iter().map(|x| self.abs(x)).collect();
                self.open.insert(id.to_string(), (paths, Value::String(text), ts, name));
            }
            (Some("response_item"), Some("function_call_output" | "custom_tool_call_output")) => {
                let Some(id) = p["call_id"].as_str() else { return };
                if !self.open.contains_key(id) {
                    return;
                }
                let text = match &p["output"] {
                    Value::String(t) => t.clone(),
                    o => o.as_array().map(|a| a.iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n")).or_else(|| o["output"].as_str().map(str::to_string)).unwrap_or_default(),
                };
                let failed = text.starts_with("Script failed")
                    || ["rejected by user", "declined by user", "patch rejected", "Failed to apply", "failed to apply", "Invalid patch", "verification failed"].iter().any(|k| text.contains(k));
                let (_, input, call_ts, _) = self.open.remove(id).unwrap();
                let changes = self.begun.remove(id).unwrap_or(Value::Null);
                if !failed {
                    self.codex_done(id, &input, &changes, if ts > 0 { ts } else { call_ts });
                }
            }
            _ => {}
        }
    }

    /// A patch that applied: its edits, from the event's changes when there are any, else from the patch text.
    fn codex_done(&mut self, id: &str, input: &Value, changes: &Value, ts: u64) {
        if !self.done.insert(id.to_string()) {
            return;
        }
        let mut edits = Vec::new();
        if let Some(map) = changes.as_object().filter(|m| !m.is_empty()) {
            for (path, c) in map {
                if let Some(e) = event_change(id, &self.abs(path), c, ts, self.agent.clone(), &self.cwd) {
                    edits.push(e);
                }
            }
        } else if let Some(text) = input.as_str() {
            for f in parse_patch(text) {
                let path = self.abs(&f.path);
                let to = f.move_to.as_deref().map(|m| self.abs(m));
                let (before, after, reverse) = match f.kind {
                    FileOp::Add => (Known::Absent, Known::Text(f.added), Reverse::None),
                    FileOp::Delete => (Known::Unknown, Known::Absent, Reverse::None),
                    FileOp::Update => (Known::Unknown, Known::Unknown, Reverse::Patch(f.hunks)),
                };
                let (path, from) = match to {
                    Some(t) => (t, Some(path)),
                    None => (path, None),
                };
                edits.push(Edit { tool_id: id.to_string(), ts, agent: self.agent.clone(), path, from, before, after, reverse, turn: 0, seq: 0 });
            }
        }
        for e in edits {
            self.push(e);
        }
    }
}

/// A Claude edit from its call and result.
fn claude_edit(id: &str, name: &str, input: &Value, result: &Value, path: PathBuf, ts: u64, agent: Option<String>) -> Option<Edit> {
    let original = result["originalFile"].as_str().or(result["originalFileContents"].as_str()).map(str::to_string);
    let mk = |before: Known, after: Known, reverse: Reverse| Edit { tool_id: id.to_string(), ts, agent: agent.clone(), path: path.clone(), from: None, before, after, reverse, turn: 0, seq: 0 };
    match name {
        "Write" => {
            let content = input["content"].as_str().or(result["content"].as_str())?.to_string();
            let before = match (result["type"].as_str(), original) {
                (Some("create"), _) => Known::Absent,
                (_, Some(o)) => Known::Text(o),
                _ => Known::Unknown,
            };
            Some(mk(before, Known::Text(content), Reverse::None))
        }
        "Edit" | "MultiEdit" => {
            let pairs: Vec<(String, String, bool)> = match input["edits"].as_array() {
                Some(a) => a.iter().map(|e| (e["old_string"].as_str().unwrap_or("").to_string(), e["new_string"].as_str().unwrap_or("").to_string(), e["replace_all"].as_bool().unwrap_or(false))).collect(),
                None => vec![(input["old_string"].as_str()?.to_string(), input["new_string"].as_str()?.to_string(), input["replace_all"].as_bool().unwrap_or(false))],
            };
            match original {
                Some(o) => {
                    let after = forward_strings(&o, &pairs).or_else(|| structured_patch(&o, &result["structuredPatch"]));
                    let before = if o.is_empty() && pairs.len() == 1 && pairs[0].0.is_empty() && result["type"] == "create" { Known::Absent } else { Known::Text(o) };
                    Some(mk(before, after.map(Known::Text).unwrap_or(Known::Unknown), Reverse::Strings(pairs)))
                }
                None => Some(mk(Known::Unknown, Known::Unknown, Reverse::Strings(pairs))),
            }
        }
        _ => None,
    }
}

/// Claude's string edits applied in order (`replace_all`, else the first match); None when one doesn't match.
pub fn forward_strings(text: &str, pairs: &[(String, String, bool)]) -> Option<String> {
    let mut t = text.to_string();
    for (old, new, all) in pairs {
        if old.is_empty() {
            if t.is_empty() {
                t = new.clone();
                continue;
            }
            return None;
        }
        if !t.contains(old.as_str()) {
            return None;
        }
        t = if *all { t.replace(old.as_str(), new) } else { t.replacen(old.as_str(), new, 1) };
    }
    Some(t)
}

/// Claude's string edits undone on `text` (the file after them): each new string, which must be there once
/// (`replace_all`: everywhere), back to the old one, last edit first.
pub fn reverse_strings(text: &str, pairs: &[(String, String, bool)]) -> Option<String> {
    let mut t = text.to_string();
    for (old, new, all) in pairs.iter().rev() {
        if new.is_empty() {
            // A deletion can't be found again in the text.
            if old.is_empty() {
                continue;
            }
            return None;
        }
        let n = t.matches(new.as_str()).count();
        if n == 0 || (!*all && n > 1) {
            return None;
        }
        t = t.replace(new.as_str(), old);
    }
    Some(t)
}

/// Claude's `structuredPatch` (`[{oldStart, oldLines, newStart, newLines, lines: [" x", "-y", "+z"]}]`) on `text`.
fn structured_patch(text: &str, sp: &Value) -> Option<String> {
    let arr = sp.as_array().filter(|a| !a.is_empty())?;
    let eol = super::diff::dominant_eol(text);
    let mut hs = Vec::new();
    for h in arr {
        let old_start = h["oldStart"].as_u64()?.saturating_sub(1) as usize;
        let new_start = h["newStart"].as_u64()?.saturating_sub(1) as usize;
        let mut hunk = Hunk { old_start, new_start, old: Vec::new(), new: Vec::new(), lines: Vec::new() };
        for l in h["lines"].as_array()? {
            let l = l.as_str()?;
            if l.starts_with('\\') {
                continue;
            }
            let (op, t) = match l.chars().next() {
                Some('-') => (Op::Del, &l[1..]),
                Some('+') => (Op::Ins, &l[1..]),
                Some(' ') => (Op::Eq, &l[1..]),
                _ => (Op::Eq, l),
            };
            let raw = format!("{t}{eol}");
            match op {
                Op::Eq => {
                    hunk.old.push(raw.clone());
                    hunk.new.push(raw.clone());
                }
                Op::Del => hunk.old.push(raw.clone()),
                Op::Ins => hunk.new.push(raw.clone()),
            }
            hunk.lines.push((op, raw));
        }
        hs.push(hunk);
    }
    super::diff::apply(text, &hs, false).ok()
}

/// Paths named in a Codex `changes` map.
fn change_paths(c: &Value) -> Vec<String> {
    c.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default()
}

/// One file of a Codex `changes` map: `{add: {content}}` / `{type: "add", content}`, delete likewise, update with
/// `unified_diff` and `move_path`.
fn event_change(id: &str, path: &Path, c: &Value, ts: u64, agent: Option<String>, cwd: &Path) -> Option<Edit> {
    let (kind, body) = if let Some(t) = c["type"].as_str() { (t.to_string(), c) } else { c.as_object()?.iter().next().map(|(k, v)| (k.clone(), v))? };
    let mk = |path: PathBuf, from: Option<PathBuf>, before: Known, after: Known, reverse: Reverse| Edit { tool_id: id.to_string(), ts, agent: agent.clone(), path, from, before, after, reverse, turn: 0, seq: 0 };
    match kind.as_str() {
        "add" => Some(mk(path.to_path_buf(), None, Known::Absent, Known::Text(body["content"].as_str().unwrap_or("").to_string()), Reverse::None)),
        "delete" => Some(mk(path.to_path_buf(), None, body["content"].as_str().map(|s| Known::Text(s.to_string())).unwrap_or(Known::Unknown), Known::Absent, Reverse::None)),
        "update" => {
            let diff = body["unified_diff"].as_str().or(body["diff"].as_str()).unwrap_or("");
            let hunks = unified_hunks(diff);
            let to = body["move_path"].as_str().map(|m| if Path::new(m).is_absolute() { PathBuf::from(m) } else { cwd.join(m) });
            match to {
                Some(t) => Some(mk(t, Some(path.to_path_buf()), Known::Unknown, Known::Unknown, Reverse::Patch(hunks))),
                None => Some(mk(path.to_path_buf(), None, Known::Unknown, Known::Unknown, Reverse::Patch(hunks))),
            }
        }
        _ => None,
    }
}

/// The hunks of a unified diff (`@@ -a,b +c,d @@` headers), as patch hunks.
pub fn unified_hunks(diff: &str) -> Vec<PatchHunk> {
    let mut out: Vec<PatchHunk> = Vec::new();
    let mut cur: Option<PatchHunk> = None;
    for l in diff.lines() {
        if l.starts_with("@@") {
            if let Some(h) = cur.take() {
                out.push(h);
            }
            cur = Some(PatchHunk { anchor: None, lines: Vec::new(), eof: false });
            continue;
        }
        if l.starts_with("--- ") || l.starts_with("+++ ") || l.starts_with('\\') {
            continue;
        }
        let h = cur.get_or_insert_with(|| PatchHunk { anchor: None, lines: Vec::new(), eof: false });
        match l.chars().next() {
            Some('-') => h.lines.push((Op::Del, l[1..].to_string())),
            Some('+') => h.lines.push((Op::Ins, l[1..].to_string())),
            Some(' ') => h.lines.push((Op::Eq, l[1..].to_string())),
            None => h.lines.push((Op::Eq, String::new())),
            _ => {}
        }
    }
    if let Some(h) = cur {
        out.push(h);
    }
    out.retain(|h| h.lines.iter().any(|(o, _)| *o != Op::Eq));
    out
}

#[derive(Debug, PartialEq, Eq)]
pub enum FileOp {
    Add,
    Delete,
    Update,
}

#[derive(Debug)]
pub struct PatchFile {
    pub path: String,
    pub kind: FileOp,
    pub move_to: Option<String>,
    /// An added file's content.
    pub added: String,
    pub hunks: Vec<PatchHunk>,
}

/// Codex's patch format: `*** Begin Patch`, then per file `*** Add File: p` (`+` lines), `*** Delete File: p`, or
/// `*** Update File: p` (optionally `*** Move to: q`) with `@@ [anchor]` hunks of ` `, `-`, `+` lines and an optional
/// `*** End of File`; `*** End Patch`.
pub fn parse_patch(text: &str) -> Vec<PatchFile> {
    let mut out: Vec<PatchFile> = Vec::new();
    for l in text.lines() {
        if let Some(p) = l.strip_prefix("*** Add File: ") {
            out.push(PatchFile { path: p.trim().into(), kind: FileOp::Add, move_to: None, added: String::new(), hunks: Vec::new() });
            continue;
        }
        if let Some(p) = l.strip_prefix("*** Delete File: ") {
            out.push(PatchFile { path: p.trim().into(), kind: FileOp::Delete, move_to: None, added: String::new(), hunks: Vec::new() });
            continue;
        }
        if let Some(p) = l.strip_prefix("*** Update File: ") {
            out.push(PatchFile { path: p.trim().into(), kind: FileOp::Update, move_to: None, added: String::new(), hunks: Vec::new() });
            continue;
        }
        if l.starts_with("*** Begin Patch") || l.starts_with("*** End Patch") {
            continue;
        }
        let Some(f) = out.last_mut() else { continue };
        if let Some(p) = l.strip_prefix("*** Move to: ") {
            f.move_to = Some(p.trim().into());
            continue;
        }
        match f.kind {
            FileOp::Add => {
                if let Some(t) = l.strip_prefix('+') {
                    f.added.push_str(t);
                    f.added.push('\n');
                }
            }
            FileOp::Delete => {}
            FileOp::Update => {
                if l.starts_with("*** End of File") {
                    if let Some(h) = f.hunks.last_mut() {
                        h.eof = true;
                    }
                    continue;
                }
                if let Some(a) = l.strip_prefix("@@") {
                    let a = a.trim();
                    f.hunks.push(PatchHunk { anchor: (!a.is_empty()).then(|| a.to_string()), lines: Vec::new(), eof: false });
                    continue;
                }
                if f.hunks.is_empty() {
                    f.hunks.push(PatchHunk { anchor: None, lines: Vec::new(), eof: false });
                }
                let h = f.hunks.last_mut().unwrap();
                match l.chars().next() {
                    Some('-') => h.lines.push((Op::Del, l[1..].to_string())),
                    Some('+') => h.lines.push((Op::Ins, l[1..].to_string())),
                    Some(' ') => h.lines.push((Op::Eq, l[1..].to_string())),
                    None => h.lines.push((Op::Eq, String::new())),
                    _ => {}
                }
            }
        }
    }
    for f in &mut out {
        f.hunks.retain(|h| h.lines.iter().any(|(o, _)| *o != Op::Eq));
    }
    out
}

/// Patch hunks put on `text`, forward or in reverse, matching lines without their terminators (the file's own are
/// kept, and its usual one goes on new lines). None when a hunk's lines aren't there.
pub fn apply_patch_hunks(text: &str, hs: &[PatchHunk], reverse: bool) -> Option<String> {
    let eol = super::diff::dominant_eol(text);
    let mut lines: Vec<String> = split_lines(text).into_iter().map(str::to_string).collect();
    let final_nl = text.is_empty() || text.ends_with('\n');
    let order: Vec<&PatchHunk> = if reverse { hs.iter().rev().collect() } else { hs.iter().collect() };
    for h in order {
        let want: Vec<&str> = h.lines.iter().filter(|(o, _)| *o == Op::Eq || *o == if reverse { Op::Ins } else { Op::Del }).map(|(_, t)| t.as_str()).collect();
        let put: Vec<&str> = h.lines.iter().filter(|(o, _)| *o == Op::Eq || *o == if reverse { Op::Del } else { Op::Ins }).map(|(_, t)| t.as_str()).collect();
        let fits = |p: usize, loose: bool| {
            want.iter().enumerate().all(|(k, w)| {
                let have = strip_eol(&lines[p + k]);
                if loose { have.trim_end() == w.trim_end() } else { have == *w }
            })
        };
        let from = match (&h.anchor, reverse) {
            (Some(a), _) => lines.iter().position(|l| strip_eol(l).trim() == a.trim()).map(|i| i + 1).unwrap_or(0),
            _ => 0,
        };
        if want.len() > lines.len() {
            return None;
        }
        let last = lines.len() - want.len();
        let cands: Vec<usize> = if h.eof { vec![last] } else { (from.min(last)..=last).chain(0..from.min(last)).collect() };
        let at = cands.iter().copied().find(|&p| fits(p, false)).or_else(|| cands.iter().copied().find(|&p| fits(p, true)))?;
        let is_last = at + want.len() == lines.len();
        let mut repl: Vec<String> = put.iter().map(|t| format!("{t}{eol}")).collect();
        if is_last && !final_nl
            && let Some(l) = repl.last_mut()
        {
            *l = strip_eol(l).to_string();
        }
        // Context lines keep the file's own text (and terminators).
        let mut k_old = 0;
        let mut k_new = 0;
        for (op, _) in &h.lines {
            let in_old = *op == Op::Eq || *op == if reverse { Op::Ins } else { Op::Del };
            let in_new = *op == Op::Eq || *op == if reverse { Op::Del } else { Op::Ins };
            if *op == Op::Eq {
                repl[k_new] = lines[at + k_old].clone();
            }
            if in_old {
                k_old += 1;
            }
            if in_new {
                k_new += 1;
            }
        }
        lines.splice(at..at + want.len(), repl);
    }
    Some(lines.concat())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(r: &mut Reader, lines: &[String]) {
        for l in lines {
            r.feed(format!("{l}\n").as_bytes());
        }
    }

    fn claude_lines(dir: &str) -> Vec<String> {
        let p = format!("{dir}/a.txt");
        let n = format!("{dir}/new.txt");
        vec![
            serde_json::json!({"type":"user","timestamp":"2026-11-20T10:00:00Z","message":{"role":"user","content":"Fix the greeting"}}).to_string(),
            serde_json::json!({"type":"assistant","timestamp":"2026-11-20T10:00:01Z","message":{"content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":p,"old_string":"hello","new_string":"hi"}}]}}).to_string(),
            serde_json::json!({"type":"user","timestamp":"2026-11-20T10:00:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"toolUseResult":{"filePath":p,"oldString":"hello","newString":"hi","originalFile":"hello world\n","structuredPatch":[]}}).to_string(),
            serde_json::json!({"type":"assistant","timestamp":"2026-11-20T10:00:03Z","message":{"content":[{"type":"text","text":"Shortened the greeting."}]}}).to_string(),
            serde_json::json!({"type":"assistant","timestamp":"2026-11-20T10:00:04Z","message":{"content":[{"type":"tool_use","id":"t2","name":"Write","input":{"file_path":n,"content":"fresh\n"}}]}}).to_string(),
            serde_json::json!({"type":"user","timestamp":"2026-11-20T10:00:05Z","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"ok"}]},"toolUseResult":{"type":"create","filePath":n,"content":"fresh\n","originalFile":null}}).to_string(),
            serde_json::json!({"type":"assistant","timestamp":"2026-11-20T10:00:06Z","message":{"content":[{"type":"tool_use","id":"t3","name":"Edit","input":{"file_path":p,"old_string":"nope","new_string":"x"}}]}}).to_string(),
            serde_json::json!({"type":"user","timestamp":"2026-11-20T10:00:07Z","message":{"content":[{"type":"tool_result","tool_use_id":"t3","content":"String not found","is_error":true}]}}).to_string(),
            serde_json::json!({"type":"assistant","timestamp":"2026-11-20T10:00:08Z","message":{"content":[{"type":"tool_use","id":"t4","name":"Edit","input":{"file_path":p,"old_string":"world","new_string":"there"}}]}}).to_string(),
        ]
    }

    #[test]
    fn claude_edits_writes_turns_and_open_calls() {
        let mut r = Reader::new(Kind::Claude, None, Path::new("/w"));
        feed_all(&mut r, &claude_lines("/w"));
        assert_eq!(r.turns.len(), 1);
        assert_eq!(r.turns[0].prompt, "Fix the greeting");
        assert_eq!(r.edits.len(), 2, "the failed edit is left out");
        assert_eq!(r.edits[0].before, Known::Text("hello world\n".into()));
        assert_eq!(r.edits[0].after, Known::Text("hi world\n".into()));
        assert_eq!(r.edits[0].turn, 1);
        assert_eq!(r.edits[1].before, Known::Absent);
        assert_eq!(r.edits[1].after, Known::Text("fresh\n".into()));
        assert_eq!(r.busy(), vec![PathBuf::from("/w/a.txt")]);
        assert_eq!(r.said[0].text, "Shortened the greeting.");
    }

    #[test]
    fn feeding_in_pieces_is_the_same() {
        let all = claude_lines("/w").join("\n") + "\n";
        let mut r = Reader::new(Kind::Claude, None, Path::new("/w"));
        for chunk in all.as_bytes().chunks(37) {
            r.feed(chunk);
        }
        assert_eq!(r.edits.len(), 2);
        assert_eq!(r.offset as usize, all.len());
    }

    #[test]
    fn claude_stream_result_and_no_original() {
        let mut r = Reader::new(Kind::Claude, Some("ag1".into()), Path::new("/w"));
        feed_all(
            &mut r,
            &[
                serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"MultiEdit","input":{"file_path":"/w/b.rs","edits":[{"old_string":"a","new_string":"b"},{"old_string":"c","new_string":"d"}]}}]}}).to_string(),
                serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"tool_use_result":{"filePath":"/w/b.rs"}}).to_string(),
            ],
        );
        assert_eq!(r.edits.len(), 1);
        assert_eq!(r.edits[0].agent.as_deref(), Some("ag1"));
        assert_eq!(r.edits[0].before, Known::Unknown);
        assert!(matches!(&r.edits[0].reverse, Reverse::Strings(p) if p.len() == 2));
        assert_eq!(reverse_strings("b x d", match &r.edits[0].reverse { Reverse::Strings(p) => p, _ => unreachable!() }).as_deref(), Some("a x c"));
    }

    #[test]
    fn string_edits_forward_and_back() {
        let pairs = vec![("one".to_string(), "1".to_string(), false), ("two".to_string(), "2".to_string(), true)];
        assert_eq!(forward_strings("one two two", &pairs).as_deref(), Some("1 2 2"));
        assert_eq!(reverse_strings("1 2 2", &pairs).as_deref(), Some("one two two"));
        // The new string twice where one replace made it: can't tell which.
        assert_eq!(reverse_strings("1 1", &[("one".into(), "1".into(), false)]), None);
        assert_eq!(forward_strings("abc", &[("zzz".into(), "y".into(), false)]), None);
    }

    #[test]
    fn claude_structured_patch_when_strings_dont_match() {
        let sp = serde_json::json!([{"oldStart":2,"oldLines":1,"newStart":2,"newLines":1,"lines":["-b","+B"]}]);
        assert_eq!(structured_patch("a\nb\nc\n", &sp).as_deref(), Some("a\nB\nc\n"));
    }

    #[test]
    fn codex_patch_text_parses() {
        let t = "*** Begin Patch\n*** Add File: n.txt\n+one\n+two\n*** Update File: a.txt\n*** Move to: b.txt\n@@ fn main\n ctx\n-old\n+new\n*** End of File\n*** Delete File: c.txt\n*** End Patch";
        let fs = parse_patch(t);
        assert_eq!(fs.len(), 3);
        assert_eq!(fs[0].added, "one\ntwo\n");
        assert_eq!(fs[1].move_to.as_deref(), Some("b.txt"));
        assert_eq!(fs[1].hunks[0].anchor.as_deref(), Some("fn main"));
        assert!(fs[1].hunks[0].eof);
        assert_eq!(fs[2].kind, FileOp::Delete);
    }

    #[test]
    fn codex_hunks_reverse_and_forward() {
        let hs = parse_patch("*** Begin Patch\n*** Update File: a\n@@\n a\n-b\n+B\n c\n*** End Patch").remove(0).hunks;
        assert_eq!(apply_patch_hunks("a\nB\nc\n", &hs, true).as_deref(), Some("a\nb\nc\n"));
        assert_eq!(apply_patch_hunks("a\nb\nc\n", &hs, false).as_deref(), Some("a\nB\nc\n"));
        // CRLF file, the patch without CRs.
        assert_eq!(apply_patch_hunks("a\r\nB\r\nc\r\n", &hs, true).as_deref(), Some("a\r\nb\r\nc\r\n"));
        // No newline at the end.
        assert_eq!(apply_patch_hunks("a\nB\nc", &hs, true).as_deref(), Some("a\nb\nc"));
        // Diverged: the hunk's lines aren't there.
        assert_eq!(apply_patch_hunks("a\nX\nc\n", &hs, true), None);
    }

    #[test]
    fn codex_rollout_patch_calls() {
        let mut r = Reader::new(Kind::Codex, None, Path::new("/w"));
        let patch = "*** Begin Patch\n*** Update File: /w/a.txt\n@@\n-x\n+y\n*** Add File: /w/n.txt\n+hi\n*** End Patch";
        feed_all(
            &mut r,
            &[
                serde_json::json!({"timestamp":"2026-11-20T10:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"rename x"}}).to_string(),
                serde_json::json!({"timestamp":"2026-11-20T10:00:01Z","type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"c1","input":patch}}).to_string(),
                serde_json::json!({"timestamp":"2026-11-20T10:00:02Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":"Success. Updated the following files:\nM /w/a.txt\nA /w/n.txt"}}).to_string(),
                serde_json::json!({"timestamp":"2026-11-20T10:00:03Z","type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"c2","input":"*** Begin Patch\n*** Delete File: /w/a.txt\n*** End Patch"}}).to_string(),
                serde_json::json!({"timestamp":"2026-11-20T10:00:04Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c2","output":"patch rejected by user"}}).to_string(),
            ],
        );
        assert_eq!(r.turns.len(), 1);
        assert_eq!(r.edits.len(), 2);
        assert_eq!(r.edits[1].after, Known::Text("hi\n".into()));
        assert!(matches!(r.edits[0].reverse, Reverse::Patch(_)));
    }

    #[test]
    fn codex_event_changes_carry_deleted_content() {
        let mut r = Reader::new(Kind::Codex, None, Path::new("/w"));
        feed_all(
            &mut r,
            &[
                serde_json::json!({"type":"response_item","payload":{"type":"function_call","name":"apply_patch","call_id":"c1","arguments":"{\"input\":\"*** Begin Patch\\n*** Delete File: /w/d.txt\\n*** End Patch\"}"}}).to_string(),
                serde_json::json!({"type":"event_msg","payload":{"type":"patch_apply_begin","call_id":"c1","changes":{"/w/d.txt":{"delete":{"content":"bye\n"}}}}}).to_string(),
                serde_json::json!({"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"c1","success":true}}).to_string(),
            ],
        );
        assert_eq!(r.edits.len(), 1);
        assert_eq!(r.edits[0].before, Known::Text("bye\n".into()));
        assert_eq!(r.edits[0].after, Known::Absent);
    }

    #[test]
    fn unified_diffs_parse() {
        let hs = unified_hunks("--- a\n+++ b\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
        assert_eq!(hs.len(), 1);
        assert_eq!(apply_patch_hunks("a\nB\nc\n", &hs, true).as_deref(), Some("a\nb\nc\n"));
    }
}
