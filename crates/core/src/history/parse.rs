//! What the History index takes from one transcript line: facts for the row ([`Meta`]) and the words to search
//! ([`Sink`]). Much lighter than the session parsers (`claude.rs`, `codex.rs`): no timeline, no token totals, and a
//! big tool result is never decoded (only its time is read), so a first pass over years of transcripts stays cheap.

use crate::util::{one_line, parse_rfc3339_ms};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Changed files a row remembers (the count goes on).
pub const MAX_EDITS: usize = 24;
/// A line longer than this that holds a tool result is skipped but for its time.
const BIG_LINE: usize = 2048;

/// The facts a History row shows, built up line by line (and kept between passes, so a growing file is read
/// only from where the last pass stopped).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Meta {
    pub id: String,
    pub cwd: String,
    /// The CLI's own title: Claude `ai-title` (else an old `summary`), Codex thread name (filled from the index).
    #[serde(default)]
    pub title: String,
    /// Claude Code `/rename`.
    #[serde(default)]
    pub custom: Option<String>,
    #[serde(default)]
    pub first_prompt: String,
    #[serde(default)]
    pub last_prompt: String,
    #[serde(default)]
    pub model: String,
    /// Claude: the first `entrypoint`; Codex: `session_meta.originator`.
    #[serde(default)]
    pub entry: String,
    /// Codex: the kind of `session_meta.source` (`cli`, `vscode`, `exec`, `subagent`, ...).
    #[serde(default)]
    pub source: String,
    /// Claude: a turn typed by a person through a programmatic client (see `origin::claude_human`).
    #[serde(default)]
    pub human: bool,
    /// Codex subagent rollouts: the thread that spawned it (such a rollout is part of its parent, not a row).
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub started_ms: Option<u64>,
    #[serde(default)]
    pub last_ms: Option<u64>,
    #[serde(default)]
    pub prompts: u32,
    #[serde(default)]
    pub compactions: u32,
    #[serde(default)]
    pub tools: u32,
    /// Files the session wrote (Edit / Write / apply_patch), first [`MAX_EDITS`].
    #[serde(default)]
    pub edits: Vec<String>,
    #[serde(default)]
    pub edits_n: u32,
}

impl Meta {
    fn at(&mut self, ms: u64) {
        self.started_ms = Some(self.started_ms.map_or(ms, |s| s.min(ms)));
        self.last_ms = Some(self.last_ms.map_or(ms, |s| s.max(ms)));
    }

    fn edit(&mut self, path: &str) {
        let path = path.trim();
        if path.is_empty() || self.edits.iter().any(|e| e == path) {
            return;
        }
        self.edits_n += 1;
        if self.edits.len() < MAX_EDITS {
            self.edits.push(path.to_string());
        }
    }

    fn prompt(&mut self, s: &str, sink: &mut Sink) {
        let (clean, atts) = crate::attach::split_markers(s);
        let t = clean.trim();
        // The CLI's own text (commands, reminders, environment), and interrupt markers, are not the person's words.
        if (t.is_empty() && atts.is_empty()) || t.starts_with('<') || t.starts_with("[Request interrupted") {
            return;
        }
        self.prompts += 1;
        let line = one_line(t, 200);
        if self.first_prompt.is_empty() {
            self.first_prompt = line.clone();
        }
        self.last_prompt = line;
        sink.prompt(t);
    }
}

/// The searchable words of one pass, within what is left of the session's budgets.
#[derive(Default)]
pub struct Sink {
    pub out: String,
    pub prompt_left: usize,
    pub reply_left: usize,
}

impl Sink {
    pub fn new(prompt_left: usize, reply_left: usize) -> Self {
        Self { out: String::new(), prompt_left, reply_left }
    }

    pub fn full(&self) -> bool {
        self.prompt_left == 0 && self.reply_left == 0
    }

    fn put(out: &mut String, left: &mut usize, s: &str) {
        let s = s.trim();
        if *left == 0 || s.is_empty() {
            return;
        }
        let mut end = s.len().min(*left);
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        out.push_str(&s[..end]);
        out.push('\n');
        *left -= end.min(*left);
        // A cut text stops the budget (the next text would be an orphan fragment).
        if end < s.len() {
            *left = 0;
        }
    }

    fn prompt(&mut self, s: &str) {
        Self::put(&mut self.out, &mut self.prompt_left, s);
    }

    fn reply(&mut self, s: &str) {
        Self::put(&mut self.out, &mut self.reply_left, s);
    }
}

/// `"timestamp":"..."` read straight from the text (for lines not worth decoding).
fn raw_time(l: &str) -> Option<u64> {
    let at = l.find("\"timestamp\":\"")? + 13;
    let end = l[at..].find('"')? + at;
    parse_rfc3339_ms(&l[at..end])
}

/// One Claude Code transcript line.
pub fn claude_line(l: &str, m: &mut Meta, sink: &mut Sink) {
    if l.contains("\"type\":\"api-request") || l.contains("\"type\":\"file-history-snapshot\"") || l.contains("\"type\":\"queue-operation\"") {
        return;
    }
    // Tool results come in lines of their own (never with the person's words): a big one only gives its time.
    if l.len() > BIG_LINE && l.contains("\"type\":\"tool_result\"") {
        if let Some(t) = raw_time(l) {
            m.at(t);
        }
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(l) else { return };
    if let Some(t) = crate::claude::event_ms(&v) {
        m.at(t);
    }
    if m.entry.is_empty()
        && let Some(e) = v["entrypoint"].as_str()
    {
        m.entry = e.to_string();
    }
    if v["type"] == "user" && crate::origin::claude_human(&v) {
        m.human = true;
    }
    if m.cwd.is_empty()
        && let Some(c) = v["cwd"].as_str()
    {
        m.cwd = c.to_string();
    }
    match v["type"].as_str() {
        Some("ai-title") => {
            if let Some(t) = v["aiTitle"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
                m.title = t.to_string();
            }
        }
        // Older Claude Code versions name a session by its summary.
        Some("summary") if m.title.is_empty() => {
            if let Some(t) = v["summary"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
                m.title = one_line(t, 120);
            }
        }
        Some("custom-title") => {
            if let Some(t) = v["customTitle"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
                m.custom = Some(t.to_string());
            }
        }
        Some("user") if v["isCompactSummary"].as_bool() == Some(true) => m.compactions += 1,
        Some("user") if v["isMeta"].as_bool() == Some(true) => {}
        Some("user") => {
            let c = &v["message"]["content"];
            if let Some(s) = c.as_str() {
                m.prompt(s, sink);
            } else if let Some(arr) = c.as_array() {
                let text: Vec<&str> = arr.iter().filter(|i| i["type"] == "text").filter_map(|i| i["text"].as_str()).collect();
                if !text.is_empty() {
                    m.prompt(&text.join("\n"), sink);
                }
            }
        }
        Some("attachment") if v["attachment"]["type"] == "queued_command" && v["attachment"]["commandMode"].as_str().is_none_or(|x| x == "prompt") => {
            if let Some(s) = v["attachment"]["prompt"].as_str() {
                m.prompt(s, sink);
            }
        }
        Some("assistant") => {
            let msg = &v["message"];
            if let Some(model) = msg["model"].as_str().filter(|x| *x != "<synthetic>" && !x.is_empty()) {
                m.model = model.to_string();
            }
            for b in msg["content"].as_array().map(Vec::as_slice).unwrap_or_default() {
                match b["type"].as_str() {
                    Some("text") => sink.reply(b["text"].as_str().unwrap_or("")),
                    Some("tool_use") => {
                        m.tools += 1;
                        if matches!(b["name"].as_str(), Some("Edit" | "Write" | "MultiEdit" | "NotebookEdit")) {
                            let inp = &b["input"];
                            if let Some(p) = inp["file_path"].as_str().or(inp["notebook_path"].as_str()) {
                                m.edit(p);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

/// One Codex rollout line.
pub fn codex_line(l: &str, m: &mut Meta, sink: &mut Sink) {
    if l.len() > BIG_LINE && (l.contains("\"function_call_output\"") || l.contains("\"custom_tool_call_output\"")) {
        if let Some(t) = raw_time(l) {
            m.at(t);
        }
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(l) else { return };
    if let Some(t) = crate::codex::event_ms(&v) {
        m.at(t);
    }
    let p = &v["payload"];
    match (v["type"].as_str(), p["type"].as_str()) {
        (Some("session_meta"), _) if m.entry.is_empty() && m.source.is_empty() => {
            if let Some(id) = p["id"].as_str() {
                m.id = id.to_string();
            }
            if let Some(c) = p["cwd"].as_str() {
                m.cwd = c.to_string();
            }
            m.entry = p["originator"].as_str().unwrap_or("").to_string();
            m.source = crate::origin::codex_source_kind(&p["source"]);
            if m.source.is_empty() {
                m.source = "-".into();
            }
            let spawn = &p["source"]["subagent"]["thread_spawn"];
            m.parent = spawn["parent_thread_id"].as_str().or(p["parent_thread_id"].as_str()).filter(|_| m.source == "subagent").map(str::to_string);
            if let Some(t) = p["timestamp"].as_str().or(v["timestamp"].as_str()).and_then(parse_rfc3339_ms) {
                m.at(t);
            }
        }
        (Some("turn_context"), _) => {
            if let Some(c) = p["cwd"].as_str() {
                m.cwd = c.to_string();
            }
            if let Some(x) = p["model"].as_str() {
                m.model = x.to_string();
            }
        }
        (Some("event_msg"), Some("thread_settings_applied")) => {
            if let Some(x) = p["thread_settings"]["model"].as_str() {
                m.model = x.to_string();
            }
        }
        (Some("response_item"), Some("message")) => {
            let items = p["content"].as_array().map(Vec::as_slice).unwrap_or_default();
            let text: Vec<&str> = items.iter().filter_map(|c| c["text"].as_str()).filter(|t| !t.trim_start().starts_with("<image") && !t.trim_start().starts_with("</image")).collect();
            let text = text.join("\n");
            match p["role"].as_str() {
                Some("user") => m.prompt(&text, sink),
                Some("assistant") => sink.reply(&text),
                _ => {}
            }
        }
        (Some("compacted"), _) => m.compactions += 1,
        (Some("response_item"), Some("function_call" | "custom_tool_call")) => {
            m.tools += 1;
            let name = p["name"].as_str().unwrap_or("");
            let input: Value = p["arguments"].as_str().and_then(|a| serde_json::from_str(a).ok()).unwrap_or_else(|| p["input"].clone());
            let (name, input) = crate::codex::code_mode_call(name, &input).unwrap_or((name.to_string(), input));
            if name == "apply_patch" {
                let text = input.as_str().or(input["input"].as_str()).or(input["patch"].as_str()).unwrap_or("");
                for f in crate::codex::patch_paths(text) {
                    m.edit(&f);
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_facts_and_words() {
        let mut m = Meta::default();
        let mut s = Sink::new(1000, 1000);
        let lines = [
            r#"{"type":"user","timestamp":"2026-03-01T10:00:00Z","entrypoint":"cli","cwd":"/w/app","message":{"content":"Fix the login redirect"}}"#,
            r#"{"type":"user","timestamp":"2026-03-01T10:00:01Z","isMeta":true,"message":{"content":"<system-reminder>x</system-reminder>"}}"#,
            r#"{"type":"assistant","timestamp":"2026-03-01T10:00:02Z","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"Looking at auth.ts"},{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/w/app/auth.ts"}}]}}"#,
            r#"{"type":"user","timestamp":"2026-03-01T10:05:00Z","message":{"content":[{"type":"text","text":"<command-name>/compact</command-name>"}]}}"#,
            r#"{"type":"user","timestamp":"2026-03-01T10:06:00Z","isCompactSummary":true,"message":{"content":"Summary"}}"#,
            r#"{"type":"user","timestamp":"2026-03-01T10:07:00Z","message":{"content":"And the logout one"}}"#,
            r#"{"type":"ai-title","aiTitle":"Login redirect fix"}"#,
            r#"{"type":"custom-title","customTitle":"auth work"}"#,
        ];
        for l in lines {
            claude_line(l, &mut m, &mut s);
        }
        assert_eq!((m.prompts, m.compactions, m.tools, m.edits_n), (2, 1, 1, 1));
        assert_eq!((m.first_prompt.as_str(), m.last_prompt.as_str()), ("Fix the login redirect", "And the logout one"));
        assert_eq!((m.title.as_str(), m.custom.as_deref(), m.model.as_str(), m.entry.as_str(), m.cwd.as_str()), ("Login redirect fix", Some("auth work"), "claude-opus-5-5", "cli", "/w/app"));
        assert_eq!(m.started_ms, parse_rfc3339_ms("2026-03-01T10:00:00Z"));
        assert_eq!(m.last_ms, parse_rfc3339_ms("2026-03-01T10:07:00Z"));
        assert!(s.out.contains("Fix the login redirect") && s.out.contains("Looking at auth.ts") && !s.out.contains("system-reminder"));
    }

    #[test]
    fn big_tool_results_only_give_their_time() {
        let mut m = Meta::default();
        let mut s = Sink::new(1000, 1000);
        let blob = "z".repeat(10_000);
        let l = format!(r#"{{"type":"user","timestamp":"2026-03-02T00:00:00Z","message":{{"content":[{{"type":"tool_result","tool_use_id":"t","content":"{blob}"}}]}}}}"#);
        claude_line(&l, &mut m, &mut s);
        assert_eq!(m.last_ms, parse_rfc3339_ms("2026-03-02T00:00:00Z"));
        assert!(s.out.is_empty() && m.prompts == 0);
    }

    #[test]
    fn budgets_cut_once() {
        let mut s = Sink::new(10, 0);
        s.prompt("hello world, a long prompt");
        s.prompt("next");
        assert_eq!(s.out, "hello worl\n");
        assert!(s.full());
        // A multi-byte character is never split.
        let mut s = Sink::new(2, 0);
        s.prompt("é1");
        assert_eq!(s.out, "é\n");
    }

    #[test]
    fn codex_facts() {
        let mut m = Meta::default();
        let mut s = Sink::new(1000, 1000);
        for l in [
            r#"{"timestamp":"2026-01-05T09:00:00Z","type":"session_meta","payload":{"id":"c-1","cwd":"/w/api","originator":"codex_cli_rs","source":"cli"}}"#,
            r#"{"type":"turn_context","payload":{"model":"gpt-5.6","cwd":"/w/api"}}"#,
            r#"{"timestamp":"2026-01-05T09:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}"#,
            r#"{"timestamp":"2026-01-05T09:00:02Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Add rate limiting"}]}}"#,
            r#"{"timestamp":"2026-01-05T09:00:03Z","type":"response_item","payload":{"type":"function_call","name":"apply_patch","arguments":"{\"input\":\"*** Begin Patch\\n*** Update File: src/limit.rs\\n*** End Patch\"}","call_id":"c"}}"#,
            r#"{"timestamp":"2026-01-05T09:00:04Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done: a token bucket"}]}}"#,
            r#"{"timestamp":"2026-01-05T09:01:00Z","type":"compacted","payload":{"message":"s"}}"#,
        ] {
            codex_line(l, &mut m, &mut s);
        }
        assert_eq!((m.id.as_str(), m.cwd.as_str(), m.model.as_str(), m.entry.as_str(), m.source.as_str()), ("c-1", "/w/api", "gpt-5.6", "codex_cli_rs", "cli"));
        assert_eq!((m.prompts, m.tools, m.compactions, m.edits.clone()), (1, 1, 1, vec!["src/limit.rs".to_string()]));
        assert!(s.out.contains("Add rate limiting") && s.out.contains("token bucket"));
    }
}
