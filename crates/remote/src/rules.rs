//! docs/REMOTE.md "Rules on the Mac", as code: what a remote command may do, checked here before anything reaches
//! the app. The app's side ([`crate::Host`]) only ever gets the narrow forms these functions produce: an answer is
//! [`Answer`] (allow once, deny, or a question's picks; there is no "always" to express), a start names a project
//! from the Mac's own list and carries the mode chosen by [`start_mode`].

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};

/// A command older than this when it arrives (by the phone's clock or the relay's) is dropped as expired.
pub const MAX_AGE_MS: u64 = 60_000;
/// Longest text a `send` or `start` may carry.
pub const MAX_TEXT: usize = 20_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Cli {
    Claude,
    Codex,
}

/// One session as the phone sees it (`snapshot`, `session`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub project: String,
    pub cli: Cli,
    /// "working", "waiting", "idle", "ended".
    pub state: String,
    pub model: String,
    /// Epoch ms.
    pub last_activity: u64,
    /// A chat coool runs: one a `send` or `stop` can reach.
    pub chat: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QuestionInfo {
    pub question: String,
    pub options: Vec<String>,
    pub multi: bool,
    pub allow_other: bool,
}

/// A pending request (`need`): what the Needs-you page shows.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Need {
    pub id: String,
    pub session: String,
    /// "permission", "plan" or "question".
    pub kind: String,
    pub tool: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub questions: Vec<QuestionInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk: Option<String>,
}

/// A folder a chat can start in (`projects`). `id` is opaque: the phone never sees or sends a path.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(skip)]
    pub path: String,
}

/// What a remote answer can do, and nothing else.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    AllowOnce,
    Deny,
    /// A question's picks: per question, the chosen option labels and/or typed text.
    Picks(Vec<Vec<String>>),
}

/// The opaque id of a project folder: 128 bits of SHA-256 of its path.
pub fn project_id(path: &str) -> String {
    use sha2::Digest;
    crate::proto::hex(&sha2::Sha256::digest(format!("coool-remote project\n{path}").as_bytes())[..16])
}

/// Checks an `answer` body against the need it names. Permission and plan requests take `allow_once` or `deny`;
/// questions take `deny`, `option` (one label of the first question) or `answers` (per question). Anything else,
/// "always" or a remember option among it, is refused.
pub fn check_answer(need: &Need, body: &Value) -> Result<Answer, String> {
    let choice = body.get("choice").and_then(Value::as_str).unwrap_or("");
    match (need.kind.as_str(), choice) {
        (_, "deny") => Ok(Answer::Deny),
        ("permission" | "plan", "allow_once") => Ok(Answer::AllowOnce),
        ("permission" | "plan", _) => Err("a remote answer can only allow once or deny".into()),
        ("question", "option") => {
            let label = body.get("option").and_then(Value::as_str).ok_or("missing option")?;
            let q = need.questions.first().ok_or("the question has no options")?;
            if !q.options.iter().any(|o| o == label) {
                return Err("not one of the question's options".into());
            }
            let mut picks = vec![vec![label.to_string()]];
            picks.resize(need.questions.len(), Vec::new());
            Ok(Answer::Picks(picks))
        }
        ("question", "answers") => {
            let a = body.get("answers").and_then(Value::as_array).ok_or("missing answers")?;
            if a.len() != need.questions.len() {
                return Err("one answer per question".into());
            }
            let mut picks = Vec::new();
            for (q, ans) in need.questions.iter().zip(a) {
                let ans: Vec<String> = ans.as_array().ok_or("an answer is a list")?.iter().map(|x| x.as_str().map(str::to_string).ok_or("an answer is text")).collect::<Result<_, _>>()?;
                if ans.is_empty() || (!q.multi && ans.len() > 1) || ans.iter().any(|x| x.len() > MAX_TEXT) {
                    return Err("not a valid answer for that question".into());
                }
                if !q.allow_other && ans.iter().any(|x| !q.options.contains(x)) {
                    return Err("not one of the question's options".into());
                }
                picks.push(ans);
            }
            Ok(Answer::Picks(picks))
        }
        ("question", _) => Err("a question takes an option, answers, or deny".into()),
        _ => Err("unknown request kind".into()),
    }
}

/// The asking modes a remote start may use, per CLI (the app's `ASKING_MODES`); the first is the fallback.
const CLAUDE_ASKING: [&str; 3] = ["default", "acceptEdits", "plan"];
const CODEX_ASKING: [&str; 2] = ["untrusted", "on-request"];

/// The mode a remote `start` uses: the CLI's default if it is one that asks, else the asking mode (Bypass,
/// full access, "never", an unknown or empty mode all give way to it).
pub fn start_mode(cli: Cli, default: Option<&str>) -> &'static str {
    let allowed: &[&'static str] = match cli {
        Cli::Claude => &CLAUDE_ASKING,
        Cli::Codex => &CODEX_ASKING,
    };
    default.and_then(|d| allowed.iter().find(|m| **m == d).copied()).unwrap_or(allowed[0])
}

/// A checked `start`: a project from the Mac's list, a CLI, the text.
#[derive(Debug, PartialEq)]
pub struct Start {
    pub project: Project,
    pub cli: Cli,
    pub mode: &'static str,
    pub text: String,
}

pub fn check_start(body: &Value, projects: &[Project], default_mode: impl Fn(Cli) -> Option<String>) -> Result<Start, String> {
    // Only an id from the list: a body that names a path is refused outright, whatever else it says.
    if ["path", "cwd", "dir", "folder"].iter().any(|k| body.get(k).is_some()) {
        return Err("a remote start takes a project id, never a path".into());
    }
    let id = body.get("project").and_then(Value::as_str).unwrap_or("");
    let project = projects.iter().find(|p| p.id == id && crate::proto::is_id(id)).ok_or("unknown project")?;
    let cli = match body.get("cli").and_then(Value::as_str) {
        Some("claude") => Cli::Claude,
        Some("codex") => Cli::Codex,
        _ => return Err("unknown CLI".into()),
    };
    let text = check_text(body)?;
    let mode = start_mode(cli, default_mode(cli).as_deref());
    Ok(Start { project: project.clone(), cli, mode, text })
}

pub fn check_text(body: &Value) -> Result<String, String> {
    let t = body.get("text").and_then(Value::as_str).unwrap_or("");
    if t.trim().is_empty() {
        return Err("empty message".into());
    }
    if t.len() > MAX_TEXT {
        return Err("message too long".into());
    }
    Ok(t.to_string())
}

/// Whether a command is too old (or from too far ahead) to run: `sent` by the sender's clock, `queued` when the
/// relay took it, `now` the Mac's clock.
pub fn expired(sent: u64, queued: u64, now: u64) -> bool {
    now.saturating_sub(sent) > MAX_AGE_MS || now.saturating_sub(queued) > MAX_AGE_MS || sent > now + MAX_AGE_MS
}

/// Sliding-window limits per device and kind of command.
#[derive(Default)]
pub struct Limiter {
    hits: HashMap<(String, &'static str), VecDeque<u64>>,
}

impl Limiter {
    /// Per minute: answers 30, sends 20, stops 20, starts 5.
    pub fn allow(&mut self, device: &str, kind: &'static str, now: u64) -> bool {
        let max = match kind {
            "answer" => 30,
            "send" | "stop" => 20,
            "start" => 5,
            _ => 60,
        };
        let q = self.hits.entry((device.to_string(), kind)).or_default();
        while q.front().is_some_and(|t| now.saturating_sub(*t) >= 60_000) {
            q.pop_front();
        }
        if q.len() >= max {
            return false;
        }
        q.push_back(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn permission() -> Need {
        Need { id: "n1".into(), session: "s".into(), kind: "permission".into(), tool: "Bash".into(), summary: "Run npm test".into(), command: Some("npm test".into()), questions: vec![], explanation: None, risk: None }
    }

    #[test]
    fn answer_cannot_pick_always_allow() {
        let n = permission();
        assert_eq!(check_answer(&n, &json!({"choice": "allow_once"})), Ok(Answer::AllowOnce));
        assert_eq!(check_answer(&n, &json!({"choice": "deny"})), Ok(Answer::Deny));
        for bad in [json!({"choice": "always"}), json!({"choice": "allow_always"}), json!({"choice": "remember", "remember": "r1"}), json!({"choice": "option", "option": "Always allow `npm test` in this project"}), json!({})] {
            assert!(check_answer(&n, &bad).is_err(), "{bad}");
        }
        // A remember option riding along is not an answer of its own: it is allow once, nothing more.
        assert_eq!(check_answer(&n, &json!({"choice": "allow_once", "remember": "r1", "always": true})), Ok(Answer::AllowOnce));
        let plan = Need { kind: "plan".into(), ..permission() };
        assert!(check_answer(&plan, &json!({"choice": "option", "option": "acceptEdits"})).is_err());
    }

    #[test]
    fn question_answers_must_be_its_options() {
        let n = Need { kind: "question".into(), questions: vec![QuestionInfo { question: "Which?".into(), options: vec!["A".into(), "B".into()], multi: false, allow_other: false }], ..permission() };
        assert_eq!(check_answer(&n, &json!({"choice": "option", "option": "B"})), Ok(Answer::Picks(vec![vec!["B".into()]])));
        assert!(check_answer(&n, &json!({"choice": "option", "option": "C"})).is_err());
        assert!(check_answer(&n, &json!({"choice": "allow_once"})).is_err());
        assert!(check_answer(&n, &json!({"choice": "answers", "answers": [["A", "B"]]})).is_err());
        assert!(check_answer(&n, &json!({"choice": "answers", "answers": [["free text"]]})).is_err());
    }

    #[test]
    fn start_never_uses_bypass_or_full_access() {
        assert_eq!(start_mode(Cli::Claude, Some("bypassPermissions")), "default");
        assert_eq!(start_mode(Cli::Claude, Some("acceptEdits")), "acceptEdits");
        assert_eq!(start_mode(Cli::Claude, None), "default");
        assert_eq!(start_mode(Cli::Claude, Some("dontAsk")), "default");
        assert_eq!(start_mode(Cli::Codex, Some("danger-full-access")), "untrusted");
        assert_eq!(start_mode(Cli::Codex, Some("never")), "untrusted");
        assert_eq!(start_mode(Cli::Codex, Some("on-request")), "on-request");
        assert_eq!(start_mode(Cli::Codex, Some("")), "untrusted");
    }

    #[test]
    fn start_takes_only_a_known_project_id() {
        let path = "/private/tmp/known";
        let ps = vec![Project { id: project_id(path), name: "known".into(), path: path.into() }];
        let bypass = |_| Some("bypassPermissions".to_string());
        let ok = check_start(&json!({"project": project_id(path), "cli": "claude", "text": "hi"}), &ps, bypass).unwrap();
        assert_eq!((ok.project.path.as_str(), ok.mode), (path, "default"));
        assert_eq!(check_start(&json!({"project": project_id("/elsewhere"), "cli": "claude", "text": "hi"}), &ps, bypass), Err("unknown project".into()));
        assert_eq!(check_start(&json!({"project": path, "cli": "claude", "text": "hi"}), &ps, bypass), Err("unknown project".into()));
        assert!(check_start(&json!({"project": project_id(path), "path": "/etc", "cli": "claude", "text": "hi"}), &ps, bypass).is_err());
        assert!(check_start(&json!({"project": project_id(path), "cwd": path, "cli": "claude", "text": "hi"}), &ps, bypass).is_err());
        assert!(check_start(&json!({"project": project_id(path), "cli": "sh", "text": "hi"}), &ps, bypass).is_err());
        assert!(check_start(&json!({"project": project_id(path), "cli": "claude", "text": "  "}), &ps, bypass).is_err());
    }

    #[test]
    fn a_command_older_than_sixty_seconds_is_expired() {
        let now = 1_000_000_000;
        assert!(!expired(now - 59_000, now - 59_000, now));
        assert!(expired(now - 61_000, now - 1_000, now));
        assert!(expired(now - 1_000, now - 61_000, now));
        assert!(expired(now + 61_000, now, now));
    }

    #[test]
    fn rate_limits_per_device_per_minute() {
        let mut l = Limiter::default();
        for i in 0..5 {
            assert!(l.allow("d1", "start", 1000 + i));
        }
        assert!(!l.allow("d1", "start", 2000));
        assert!(l.allow("d2", "start", 2000));
        assert!(l.allow("d1", "start", 61_001));
    }
}
