//! Voice "AI polish": the small insights model reads one dictated utterance and returns span-level fixes for likely
//! mishearings, grammar, punctuation and technical terms, never a rewrite. Optional: only with AI insights on (its key,
//! switch and hourly cap, [`crate::insights::Insights::take_slot`]); the app shows the fixes as suggestions, never
//! applies them on its own, and keeps the feature whole without it.
//!
//! What is sent, and nothing else: the dictated text (secrets redacted with [`crate::explain::redact_secrets`], capped
//! in length) and up to 40 words from the person's own words library, so terms are spelled their way. Never the rest
//! of the chat, file contents, paths of the project, or the key.
//!
//! The answer is strict JSON (`{"fixes":[{from,to,original,replacement,reason}]}`). This module only checks that it is
//! that shape; the app validates each fix against the text it has (app/src/lib/voice/aiFix.ts: offsets, protected
//! spans like code, paths and commands, size limits) before showing it.

use crate::explain::redact_secrets;
use crate::insights::{MODEL, call_api_within, redact};
use crate::util::one_line;
use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const MAX_TOKENS: u32 = 500;
const TIMEOUT: Duration = Duration::from_secs(15);
const TEXT_MAX: usize = 1500;
const WORDS_MAX: usize = 40;
/// Claude Haiku 5.5, USD per token (as explain.rs).
const IN_USD: f64 = 0.10e-6;
const OUT_USD: f64 = 0.50e-6;

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Request {
    pub text: String,
    /// The person's words library (written forms), most used first.
    #[serde(default)]
    pub words: Vec<String>,
    /// "translate" (the text is whisper's English translation) or "transcribe".
    #[serde(default)]
    pub mode: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Reply {
    Off { has_key: bool },
    Limited,
    Error { message: String },
    /// `fixes`: the model's list, shape-checked only (see the module doc).
    Done { fixes: Value, model: String, usd: f64, ms: u64 },
}

const SYSTEM_PROMPT: &str = "You proofread one short dictated prompt that a developer spoke to a coding agent; a local \
speech recognizer wrote it down. Find only clear errors: words the recognizer misheard (often technical terms, product \
and library names), grammar slips, and missing or wrong punctuation. Return span-level fixes, each replacing a few words \
at most. Never rephrase, shorten, translate or change the meaning; never touch code, identifiers, file paths, URLs, \
command-line flags, slash commands or anything in quotes or backticks; never fix style. Prefer the spellings in the \
person's glossary. `from` and `to` are character offsets into the text; `original` must be exactly the text in that \
range. reason is one of: mishearing, grammar, punctuation, term. Return {\"fixes\": []} when nothing is clearly wrong.";

pub fn build_prompt(r: &Request) -> String {
    let text = redact_secrets(&crate::util::truncate(&r.text, TEXT_MAX));
    let words: Vec<String> = r.words.iter().take(WORDS_MAX).map(|w| one_line(w, 40)).filter(|w| !w.is_empty()).collect();
    let mut p = String::new();
    if !words.is_empty() {
        p.push_str("<glossary>\n");
        p.push_str(&words.join(", "));
        p.push_str("\n</glossary>\n");
    }
    if r.mode == "translate" {
        p.push_str("<note>The person spoke another language; the recognizer translated it to English.</note>\n");
    }
    p.push_str("<text>\n");
    p.push_str(&text);
    p.push_str("\n</text>\n");
    p
}

pub fn request_body(r: &Request) -> Value {
    json!({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "thinking": { "type": "disabled" },
        "system": SYSTEM_PROMPT,
        "messages": [{ "role": "user", "content": build_prompt(r) }],
        "output_config": {
            "effort": "low",
            "format": {
                "type": "json_schema",
                "schema": {
                    "type": "object",
                    "properties": {
                        "fixes": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "from": { "type": "integer" },
                                    "to": { "type": "integer" },
                                    "original": { "type": "string" },
                                    "replacement": { "type": "string" },
                                    "reason": { "type": "string", "enum": ["mishearing", "grammar", "punctuation", "term"] }
                                },
                                "required": ["from", "to", "original", "replacement", "reason"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": ["fixes"],
                    "additionalProperties": false
                }
            }
        }
    })
}

/// The `fixes` array from the model's text (strict JSON or JSON inside prose); an error when there is none.
pub fn parse_fixes(text: &str) -> Result<Value> {
    let (Some(a), Some(b)) = (text.find('{'), text.rfind('}')) else { bail!("reply contained no JSON object") };
    if b < a {
        bail!("reply contained no JSON object");
    }
    let v: Value = serde_json::from_str(&text[a..=b]).map_err(|_| anyhow!("reply was not valid JSON"))?;
    match v.get("fixes") {
        Some(f @ Value::Array(_)) => Ok(f.clone()),
        _ => bail!("reply had no fixes list"),
    }
}

pub fn parse_response(body: &str) -> Result<(Value, f64)> {
    let v: Value = serde_json::from_str(body).map_err(|_| anyhow!("API reply was not JSON"))?;
    if v.get("stop_reason").and_then(|s| s.as_str()) == Some("refusal") {
        bail!("the model declined");
    }
    let text: String = v
        .get("content")
        .and_then(|c| c.as_array())
        .map(|b| b.iter().filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text")).filter_map(|b| b.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join(""))
        .unwrap_or_default();
    let u = &v["usage"];
    let n = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0) as f64;
    let usd = (n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens")) * IN_USD + n("output_tokens") * OUT_USD;
    Ok((parse_fixes(&text)?, usd))
}

/// One blocking call (at most [`TIMEOUT`]).
pub fn run(key: &str, r: &Request) -> Reply {
    let t = Instant::now();
    let body = request_body(r).to_string();
    let out = (|| {
        let (status, text) = call_api_within(key, &body, TIMEOUT).map_err(|e| anyhow!(redact(&e.to_string(), key)))?;
        if status != 200 {
            let msg = serde_json::from_str::<Value>(&text).ok().and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(String::from)).unwrap_or_else(|| "request failed".into());
            bail!("{}", redact(&format!("Anthropic API error {status}: {}", one_line(&msg, 200)), key));
        }
        parse_response(&text)
    })();
    match out {
        Ok((fixes, usd)) => Reply::Done { fixes, model: MODEL.into(), usd, ms: t.elapsed().as_millis() as u64 },
        Err(e) => Reply::Error { message: redact(&e.to_string(), key) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_has_text_glossary_and_schema_but_no_secrets() {
        let r = Request { text: "update the tori config, token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789".into(), words: vec!["Tauri".into(), "Zustand".into()], mode: "translate".into() };
        let b = request_body(&r);
        assert_eq!(b["model"], MODEL);
        let user = b["messages"][0]["content"].as_str().unwrap();
        assert!(user.contains("tori config"));
        assert!(user.contains("Tauri, Zustand"));
        assert!(user.contains("translated it to English"));
        assert!(!user.contains("abcdefghijklmnop"), "{user}");
        assert_eq!(b["output_config"]["format"]["schema"]["required"][0], "fixes");
        assert!(!b.to_string().contains("x-api-key"));
    }

    #[test]
    fn parses_fixes_and_cost() {
        let body = json!({
            "content": [{ "type": "text", "text": "{\"fixes\":[{\"from\":11,\"to\":15,\"original\":\"tori\",\"replacement\":\"Tauri\",\"reason\":\"term\"}]}" }],
            "usage": { "input_tokens": 1000, "output_tokens": 100 }
        })
        .to_string();
        let (f, usd) = parse_response(&body).unwrap();
        assert_eq!(f[0]["replacement"], "Tauri");
        assert!((usd - (1000.0 * IN_USD + 100.0 * OUT_USD)).abs() < 1e-12);
        assert!(parse_fixes("no json here").is_err());
        assert!(parse_fixes("{\"other\":1}").is_err());
        assert!(parse_response("{\"stop_reason\":\"refusal\",\"content\":[]}").is_err());
    }
}
