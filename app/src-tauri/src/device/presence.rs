//! Agent presence (APP_SPEC "Agent presence"): who is acting on a device panel, so the panel can show a cursor and
//! label per actor and a beam around its frame while one drives.
//!
//! An actor is one MCP connection of a chat (a chat's agent; a sub-agent that connects on its own is another), or one
//! `pilot_run` of a chat. Each connection is served on a thread of its own ([`super::mcp`]), so the actor is a
//! thread-local: the connection sets its id once, a pilot run marks itself for its duration and says, per step, who
//! decided (muscle memory or Claude Haiku). Every activity event ([`super::Activity`], `browser-activity`) carries it.

use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Actor {
    /// The MCP connection (0: none, e.g. a panel command or a test).
    pub conn: u64,
    /// The `pilot_run` this thread is in, if any.
    pub pilot: Option<u64>,
    /// Who chose the pilot's current step: `memory` or `haiku`.
    pub decider: Option<&'static str>,
}

thread_local! {
    static ACTOR: RefCell<Actor> = const { RefCell::new(Actor { conn: 0, pilot: None, decider: None }) };
}

static CONNS: AtomicU64 = AtomicU64::new(1);

/// A new connection's id, set as this thread's actor (called once per connection thread).
pub fn begin_connection() -> u64 {
    let id = CONNS.fetch_add(1, Ordering::Relaxed);
    ACTOR.with(|a| *a.borrow_mut() = Actor { conn: id, pilot: None, decider: None });
    id
}

pub fn current() -> Actor {
    ACTOR.with(|a| *a.borrow())
}

/// Marks this thread as pilot run `run` until the guard drops.
pub fn pilot(run: u64) -> PilotGuard {
    let prev = current();
    ACTOR.with(|a| *a.borrow_mut() = Actor { conn: prev.conn, pilot: Some(run), decider: None });
    PilotGuard(prev)
}

pub struct PilotGuard(Actor);

impl Drop for PilotGuard {
    fn drop(&mut self) {
        let prev = self.0;
        ACTOR.with(|a| *a.borrow_mut() = prev);
    }
}

/// The pilot's current step was chosen by `by` (`memory`, `haiku`, …).
pub fn decided(by: &'static str) {
    ACTOR.with(|a| a.borrow_mut().decider = Some(by));
}

impl Actor {
    /// A stable key for the panel: one cursor per key. `chat` scopes it (two chats on the shared Mac are two actors).
    pub fn key(&self, chat: Option<usize>) -> String {
        let c = chat.map(|c| c.to_string()).unwrap_or_else(|| "-".into());
        match self.pilot {
            Some(run) => format!("{c}:p{run}"),
            None => format!("{c}:c{}", self.conn),
        }
    }

    /// `pilot` or `agent`.
    pub fn by(&self) -> &'static str {
        if self.pilot.is_some() { "pilot" } else { "agent" }
    }
}

/// A short, safe-to-show form of typed text: secret-looking fields show dots.
pub fn shown_text(text: &str, field: Option<&str>) -> String {
    let secret = field.is_some_and(|f| {
        let f = f.to_lowercase();
        ["password", "passcode", "secret", "pin", "one-time", "verification code"].iter().any(|w| f.contains(w))
    });
    if secret { "••••".into() } else { text.chars().take(40).collect() }
}

// The marks drawn in a page's cursor label (web_agent.js), as `[viewBox, [[path, fill], …]]`. The app draws the same
// artwork from app/src/assets/brands; `PILOT_MARK` is coool's own pilot glyph (components/Presence.tsx `PilotMark`).
const CLAUDE_SVG: &str = include_str!("../../../src/assets/brands/claude.svg");
const OPENAI_SVG: &str = include_str!("../../../src/assets/brands/openai.svg");
pub const PILOT_MARK: (&str, &str) = ("0 0 16 16", "M8 1.6 13.6 14a.5.5 0 0 1-.7.6L8 12.1l-4.9 2.5a.5.5 0 0 1-.7-.6L8 1.6Z");

/// The mark of `provider` (`claude`, `codex`) or the pilot, for the page: `{viewBox, paths: [[d, fill]]}`.
pub fn mark(who: &str) -> serde_json::Value {
    if who == "pilot" {
        return serde_json::json!({ "viewBox": PILOT_MARK.0, "paths": [[PILOT_MARK.1, "currentColor"]] });
    }
    let svg = if who == "codex" { OPENAI_SVG } else { CLAUDE_SVG };
    let attr = |tag: &str, name: &str| -> Option<String> {
        let i = tag.find(&format!(" {name}=\""))? + name.len() + 3;
        Some(tag[i..].split('"').next()?.to_string())
    };
    let view = svg.split('>').next().and_then(|t| attr(t, "viewBox")).unwrap_or_else(|| "0 0 24 24".into());
    let paths: Vec<_> = svg
        .split("<path")
        .skip(1)
        .filter_map(|p| {
            let tag = p.split('>').next()?;
            Some(serde_json::json!([attr(tag, "d")?, attr(tag, "fill").unwrap_or_else(|| "currentColor".into())]))
        })
        .collect();
    serde_json::json!({ "viewBox": view, "paths": paths })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actors_are_per_connection_and_per_pilot_run() {
        let c = begin_connection();
        let a = current();
        assert_eq!(a.conn, c);
        assert_eq!(a.by(), "agent");
        assert_eq!(a.key(Some(3)), format!("3:c{c}"));
        {
            let _g = pilot(7);
            decided("memory");
            let p = current();
            assert_eq!((p.by(), p.decider, p.key(Some(3))), ("pilot", Some("memory"), "3:p7".to_string()));
        }
        assert_eq!(current(), a);
    }

    #[test]
    fn secret_fields_show_dots() {
        assert_eq!(shown_text("hunter2", Some("Password")), "••••");
        assert_eq!(shown_text("ada@example.com", Some("Email")), "ada@example.com");
    }

    #[test]
    fn marks_parse_the_brand_artwork() {
        for who in ["claude", "codex", "pilot"] {
            let m = mark(who);
            assert!(m["viewBox"].as_str().is_some_and(|v| v.split(' ').count() == 4), "{who}: {m}");
            let paths = m["paths"].as_array().unwrap();
            assert!(!paths.is_empty() && paths.iter().all(|p| p[0].as_str().is_some_and(|d| d.len() > 10)), "{who}: {m}");
        }
    }
}
