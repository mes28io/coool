//! The pilot's model decider: Claude Haiku picks one candidate id per step.
//!
//! One Messages API call per decision, through the Anthropic API key coool already keeps for insights (macOS
//! Keychain, see `coool_core::insights::api_key`). Forced tool use with a single integer (`action_id`), no thinking,
//! low effort, a short timeout. The tools and system prompt never change, so they are one cached prefix; only the
//! step (goal, steps so far, the screen's candidates) is new each time. Input values never leave the machine: the
//! model sees their names only. The key is never logged, and is scrubbed from any error text.

use super::{DecideRequest, Decider, Decision};
use serde_json::{Value, json};
use std::fmt::Write as _;
use std::time::{Duration, Instant};

pub const MODEL: &str = "claude-haiku-5-5";
const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2026-10-21";
const TIMEOUT: Duration = Duration::from_secs(8);
/// USD per token (Claude Haiku 5.5, prompts under 100K tokens).
const IN: f64 = 0.10e-6;
const OUT: f64 = 0.50e-6;
const CACHE_WRITE: f64 = 0.125e-6;
const CACHE_READ: f64 = 0.01e-6;

const SYSTEM: &str = "You are the fast pilot of a phone, a browser or a Mac, working for a coding agent that gave you a goal. \
Each turn you get the goal, the names of the input values you may type, the steps already taken, and the current \
screen: its visible text and a numbered list of the actions possible right now. Call `act` with the number of the \
single best next action.

How to choose:
- Move toward the goal along the most direct path a person would take: open the screen whose name matches the next \
part of the goal (for \"Settings > General > About\", tap General, then About).
- `set_text <name> into <field>` types the input value called <name> into that field, replacing whatever it held. \
Fill each field once, with the input whose name matches the field. Never set a field that already holds that input.
- `submit` presses the keyboard's Return / Go key; prefer tapping the page's own button (Save, Submit, Done, Search) \
when there is one.
- `scroll down` reveals more of a list or page when what you need is not listed; `scroll up` goes back.
- `back` returns to the previous screen when you went the wrong way.
- On a Mac, `launch app <name>` opens that app (or brings it to the front): to open or use an app, launch it \
rather than looking for it in Finder, the Dock or a menu. `press command+n` makes a new window or document; `press \
escape` closes a menu, dialog or panel that is in the way.
- Something already selected, checked or showing the wanted value is done: don't tap it again.
- A step that changed nothing shouldn't be repeated; try another way.
- On a system alert, choose the button the goal implies; if the goal doesn't say, prefer the least permissive one.
- `done` only when the goal is visibly achieved on this screen (the wanted screen, text or value is showing).
- `stuck` only when no listed action can make progress.

Answer with the tool call only.";

/// The forced tool: an action id, nothing else.
fn tool() -> Value {
    json!({
        "name": "act",
        "description": "Perform one of the numbered actions on the device.",
        "input_schema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["action_id"],
            "properties": { "action_id": { "type": "integer", "description": "The number of the action, from the Actions list." } }
        },
        "strict": true
    })
}

/// The step as the model reads it: goal, input names, success checks, steps so far, the screen.
pub fn user_text(r: &DecideRequest) -> String {
    let mut s = format!("Goal: {}\n", r.goal.goal);
    let names: Vec<String> = r.goal.inputs.keys().map(|k| format!("<{k}>")).collect();
    let _ = writeln!(s, "Inputs you may type: {}", if names.is_empty() { "(none)".into() } else { names.join(", ") });
    if !r.goal.success.is_empty() {
        let _ = writeln!(s, "Done when: {}", r.goal.success.iter().map(|c| c.describe()).collect::<Vec<_>>().join("; "));
    }
    s.push_str("Steps so far:\n");
    if r.history.is_empty() {
        s.push_str("(none yet)\n");
    }
    for (i, h) in r.history.iter().enumerate() {
        let _ = writeln!(s, "{}. {h}", i + 1);
    }
    s.push_str("\nCurrent screen:\n");
    s.push_str(&super::render_for_model(r.screen, r.candidates));
    s
}

pub fn request_body(r: &DecideRequest) -> Value {
    json!({
        "model": MODEL,
        "max_tokens": 64,
        "thinking": { "type": "disabled" },
        "output_config": { "effort": "low" },
        "system": [{ "type": "text", "text": SYSTEM, "cache_control": { "type": "ephemeral" } }],
        "tools": [tool()],
        "tool_choice": { "type": "tool", "name": "act" },
        "messages": [{ "role": "user", "content": user_text(r) }]
    })
}

/// The chosen id and the usage of a 200 reply.
pub fn parse_reply(body: &str) -> Result<(usize, f64, u64, u64), String> {
    let v: Value = serde_json::from_str(body).map_err(|_| "unreadable reply".to_string())?;
    if v["stop_reason"] == "refusal" {
        return Err("the model declined".into());
    }
    let id = v["content"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|b| b["type"] == "tool_use")
        .and_then(|b| b["input"]["action_id"].as_u64())
        .ok_or("no action in the reply")? as usize;
    let u = &v["usage"];
    let n = |k: &str| u[k].as_u64().unwrap_or(0);
    let usd = n("input_tokens") as f64 * IN + n("output_tokens") as f64 * OUT + n("cache_creation_input_tokens") as f64 * CACHE_WRITE + n("cache_read_input_tokens") as f64 * CACHE_READ;
    Ok((id, usd, n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens"), n("cache_read_input_tokens")))
}

pub struct Haiku {
    key: String,
}

impl Haiku {
    /// None without a key (env `COOOL_ANTHROPIC_API_KEY`, else the Keychain item insights uses).
    pub fn from_keychain() -> Option<Self> {
        coool_core::insights::api_key().map(|key| Haiku { key })
    }

    fn redact(&self, s: &str) -> String {
        s.replace(&self.key, "[redacted]")
    }
}

impl Decider for Haiku {
    fn name(&self) -> &'static str {
        "haiku"
    }

    fn decide(&mut self, r: &DecideRequest) -> Result<Decision, String> {
        let t = Instant::now();
        let body = request_body(r).to_string();
        let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(TIMEOUT)).http_status_as_error(false).build().into();
        let mut resp = agent
            .post(API_URL)
            .header("x-api-key", &self.key)
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json")
            .send(&body)
            .map_err(|e| self.redact(&format!("network error: {e}")))?;
        let status = resp.status().as_u16();
        let text = resp.body_mut().read_to_string().map_err(|e| self.redact(&format!("couldn't read the reply: {e}")))?;
        if status != 200 {
            let msg = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["error"]["message"].as_str().map(String::from)).unwrap_or_else(|| "request failed".into());
            return Err(self.redact(&format!("Anthropic API error {status}: {}", msg.chars().take(200).collect::<String>())));
        }
        let (id, usd, input_tokens, cached_tokens) = parse_reply(&text)?;
        Ok(Decision { id, ms: t.elapsed().as_millis() as u64, usd, input_tokens, cached_tokens })
    }
}
