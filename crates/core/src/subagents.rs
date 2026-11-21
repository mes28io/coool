//! How a Claude Code subagent stands: running, done, stopped, failed, or quiet.
//!
//! A subagent's own files say little about its end: `meta.json` gets `"finished": true` only when it runs
//! to its end, and an agent that is stopped (TaskStop) or dies (a usage limit) writes nothing more at
//! all. Its parent's transcript records the rest, by agent id:
//!
//! - the launch: the `Agent` call's result, `toolUseResult: {status: "async_launched", agentId}` (a
//!   foreground call's result carries `{status: "completed", agentId}` instead);
//! - a stop: the `TaskStop` result, `toolUseResult: {task_id, task_type: "local_agent"}`;
//! - an end: a `<task-notification>` with `<task-id>` and `<status>` (completed / killed / failed), as
//!   a user message or a `queued_command` attachment (`commandMode: "task-notification"`);
//! - a resume: a `SendMessage` result naming `toolUseResult.resumedAgentId` (an agent that was stopped,
//!   failed or done runs again until its next end);
//! - a snapshot: a `task_status` attachment (`taskType: "local_agent"`, `status`) after a compaction.
//!
//! [`state`] folds these, by time, with what the agent's own transcript shows; when no end is on record
//! at all (the parent died, a transcript was cut), it looks for positive evidence that nothing runs
//! before it stops counting the agent as working (see [`state`]).

use crate::model::AgentState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// The parent's lifecycle records for one subagent: the latest (re)start and the latest end, by time.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Marks {
    /// Launched with `run_in_background` (it outlives the turn that started it).
    pub background: bool,
    /// Latest launch or resume, epoch ms.
    pub start: Option<u64>,
    /// Latest end, epoch ms, and how it ended.
    pub end: Option<(u64, AgentState)>,
}

impl Marks {
    fn started(&mut self, at: u64) {
        self.start = self.start.max(Some(at));
    }
    fn ended(&mut self, at: u64, how: AgentState) {
        if self.end.is_none_or(|(t, _)| at >= t) {
            self.end = Some((at, how));
        }
    }
}

/// Bound on the ids kept (task ids of background shells land here too).
const MAX_IDS: usize = 2048;

fn mark<'a>(map: &'a mut HashMap<String, Marks>, id: &str) -> Option<&'a mut Marks> {
    if id.is_empty() || (map.len() >= MAX_IDS && !map.contains_key(id)) {
        return None;
    }
    Some(map.entry(id.to_string()).or_default())
}

/// completed / killed / failed (and running, for a snapshot).
fn status(s: &str) -> Option<AgentState> {
    Some(match s {
        "completed" => AgentState::Done,
        "killed" | "stopped" => AgentState::Stopped,
        "failed" => AgentState::Failed,
        "running" => AgentState::Running,
        _ => return None,
    })
}

fn tag<'a>(body: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let i = body.find(&open)? + open.len();
    let j = body[i..].find(&format!("</{name}>"))?;
    Some(body[i..i + j].trim())
}

/// `s` without its `<result>…</result>` spans: an agent's result text follows a notification's head and
/// may quote anything, another notification included.
fn without_results(s: &str) -> std::borrow::Cow<'_, str> {
    if !s.contains("<result>") {
        return s.into();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("<result>") {
        out.push_str(&rest[..i]);
        rest = match rest[i..].find("</result>") {
            Some(j) => &rest[i + j + "</result>".len()..],
            None => "",
        };
    }
    out.push_str(rest);
    out.into()
}

/// Every `<task-notification>` in `s`: (task id, status). Each opens with its `<task-id>`.
fn notifications(s: &str) -> Vec<(String, AgentState)> {
    let s = without_results(s);
    s.split("<task-notification>")
        .skip(1)
        .filter_map(|chunk| {
            let chunk = chunk.trim_start();
            if !chunk.starts_with("<task-id>") {
                return None;
            }
            let body = chunk.split("</task-notification>").next()?;
            Some((tag(body, "task-id")?.to_string(), status(tag(body, "status")?)?))
        })
        .collect()
}

fn note(map: &mut HashMap<String, Marks>, s: &str, at: u64) {
    for (id, how) in notifications(s) {
        if let Some(m) = mark(map, &id) {
            if how == AgentState::Running { m.started(at) } else { m.ended(at, how) }
        }
    }
}

/// Folds `other`'s records into `into` (a nested agent's launch and end are in its parent agent's transcript).
pub(crate) fn merge(into: &mut HashMap<String, Marks>, other: &HashMap<String, Marks>) {
    for (id, m) in other {
        let t = into.entry(id.clone()).or_default();
        t.background |= m.background;
        if let Some(s) = m.start {
            t.started(s);
        }
        if let Some((at, how)) = m.end {
            t.ended(at, how);
        }
    }
}

/// Records what one parent transcript record says about its subagents. `at`: the record's time.
pub(crate) fn record(map: &mut HashMap<String, Marks>, v: &Value, at: u64) {
    match v["type"].as_str() {
        Some("user") => {
            let r = &v["toolUseResult"];
            if r.is_object() {
                if let Some(id) = r["agentId"].as_str() {
                    match r["status"].as_str() {
                        Some("async_launched") => {
                            if let Some(m) = mark(map, id) {
                                m.background = true;
                                m.started(at);
                            }
                        }
                        Some(s) => {
                            if let (Some(how), Some(m)) = (status(s).filter(|h| *h != AgentState::Running), mark(map, id)) {
                                m.ended(at, how);
                            }
                        }
                        None => {}
                    }
                }
                if let Some(id) = r["resumedAgentId"].as_str().or(r["revivedAgentId"].as_str())
                    && let Some(m) = mark(map, id)
                {
                    m.started(at);
                }
                if r["task_type"] == "local_agent"
                    && let Some(id) = r["task_id"].as_str()
                    && let Some(m) = mark(map, id)
                {
                    m.ended(at, AgentState::Stopped);
                }
            }
            let c = &v["message"]["content"];
            let mut texts: Vec<&str> = Vec::new();
            if let Some(s) = c.as_str() {
                texts.push(s);
            } else if let Some(a) = c.as_array() {
                texts.extend(a.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()));
            }
            for s in texts.into_iter().filter(|s| s.contains("<task-notification>")) {
                note(map, s, at);
            }
        }
        Some("attachment") => {
            let a = &v["attachment"];
            match a["type"].as_str() {
                Some("queued_command") if a["commandMode"] == "task-notification" => {
                    let p = &a["prompt"];
                    let s = p.as_str().map(str::to_string).unwrap_or_else(|| {
                        p.as_array().map(|a| a.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default()
                    });
                    note(map, &s, at);
                }
                Some("task_status") if a["taskType"] == "local_agent" => {
                    if let (Some(id), Some(how)) = (a["taskId"].as_str(), a["status"].as_str().and_then(status))
                        && let Some(m) = mark(map, id)
                    {
                        if how == AgentState::Running { m.started(at) } else { m.ended(at, how) }
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
}

/// Own transcript activity this long after a recorded end means it runs again (a resume the parent did
/// not record); allows for the last lines an agent writes as it is cut off.
pub(crate) const RESUME_SLACK_MS: u64 = 120_000;
/// A background agent with no end on record reads as quiet after both it and its parent have been
/// silent this long, and it is not inside a tool call.
pub(crate) const QUIET_MS: u64 = 30 * 60_000;
/// A process start this long after an agent's last sign of life is a later run of the CLI.
const RESTART_SLACK_MS: u64 = 10_000;

/// Everything [`state`] weighs for one subagent.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Facts {
    /// `meta.json` says `finished`, and when the file was last written (epoch ms).
    pub meta_finished: bool,
    pub meta_written: Option<u64>,
    /// `meta.json` says it was launched in the background (`requestShape`).
    pub meta_background: bool,
    /// The parent's records (see [`record`]).
    pub marks: Marks,
    /// Newest real event of its own transcript, epoch ms.
    pub own_last: Option<u64>,
    /// Its own transcript ends inside a tool call (a call with no result yet).
    pub in_tool: bool,
    /// The parent's process is alive, and when it started (registry `startedAt`, epoch ms).
    pub parent_live: bool,
    pub parent_started: Option<u64>,
    /// The parent's newest real event, and whether its turn is still open.
    pub parent_last: Option<u64>,
    pub parent_in_turn: bool,
    pub now: u64,
}

/// How a subagent stands.
///
/// 1. On record, latest first by time: an end (done / stopped / failed) after the latest (re)start is
///    how it stands, unless its own transcript went on well after it (resumed). A (re)start after the
///    latest end means it runs again, until `meta.json` is written `finished` after that start. With
///    no end on record, `meta.json`'s `finished` decides as before.
/// 2. Still running by the record, it reads as not running only on evidence:
///    - the parent's process is gone, or is a later run than the agent's last sign of life (a
///      subagent runs inside its parent's process and dies with it): quiet;
///    - a foreground agent whose parent's turn ended after its last sign of life (the turn waited on
///      it, so it was cut off with it): stopped;
///    - a background agent, out of any tool call, silent for [`QUIET_MS`] while its parent was too:
///      quiet. Inside a tool call it may run for hours, so silence alone never ends it.
pub(crate) fn state(f: &Facts) -> AgentState {
    let m = f.marks;
    match (m.start, m.end) {
        (start, Some((t, how))) if start.is_none_or(|s| s <= t) => {
            if f.own_last.is_none_or(|o| o <= t + RESUME_SLACK_MS) {
                return how;
            }
        }
        (Some(s), Some(_)) => {
            if f.meta_finished && f.meta_written.is_some_and(|w| w >= s) {
                return AgentState::Done;
            }
        }
        _ => {
            if f.meta_finished {
                return AgentState::Done;
            }
        }
    }
    let alive_at = f.own_last.max(m.start);
    if !f.parent_live {
        return AgentState::Quiet;
    }
    if let (Some(p), Some(a)) = (f.parent_started, alive_at)
        && p > a + RESTART_SLACK_MS
    {
        return AgentState::Quiet;
    }
    let background = m.background || f.meta_background;
    if !background
        && !f.parent_in_turn
        && let (Some(p), Some(a)) = (f.parent_last, alive_at)
        && p > a
    {
        return AgentState::Stopped;
    }
    let silent = |t: Option<u64>| t.is_some_and(|t| f.now.saturating_sub(t) >= QUIET_MS);
    if background && !f.in_tool && silent(alive_at) && silent(f.parent_last) {
        return AgentState::Quiet;
    }
    AgentState::Running
}

#[cfg(test)]
mod tests {
    use super::*;
    use AgentState::*;

    const MIN: u64 = 60_000;
    const T0: u64 = 1_800_000_000_000;

    fn parse(lines: &[&str]) -> HashMap<String, Marks> {
        let mut map = HashMap::new();
        for l in lines {
            let v: Value = serde_json::from_str(l).unwrap();
            let at = crate::util::parse_rfc3339_ms(v["timestamp"].as_str().unwrap()).unwrap();
            record(&mut map, &v, at);
        }
        map
    }

    /// A live parent that has just written something, and the agent too: only the record decides.
    fn live(marks: Marks, now: u64) -> Facts {
        Facts { marks, parent_live: true, parent_last: Some(now), own_last: Some(now - MIN), now, ..Facts::default() }
    }

    #[test]
    fn notification_tags_are_read() {
        let s = "<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>t</tool-use-id>\n<status>killed</status>\n<summary>x</summary>\n</task-notification> and <task-notification><task-id>b2</task-id><status>completed</status></task-notification>";
        assert_eq!(notifications(s), vec![("a1".to_string(), Stopped), ("b2".to_string(), Done)]);
        // An agent's result that quotes a notification is not one.
        let quoted = "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>s</summary>\n<result>it said <task-notification><task-id>zz</task-id><status>killed</status></task-notification> once</result>\n</task-notification>";
        assert_eq!(notifications(quoted), vec![("a1".to_string(), Done)]);
    }

    #[test]
    fn marks_merge_across_transcripts() {
        let mut a = HashMap::from([("x".to_string(), Marks { background: true, start: Some(1), end: Some((5, Stopped)) })]);
        let b = HashMap::from([("x".to_string(), Marks { background: false, start: Some(7), end: Some((3, Done)) })]);
        merge(&mut a, &b);
        assert_eq!(a["x"], Marks { background: true, start: Some(7), end: Some((5, Stopped)) });
    }

    #[test]
    fn end_after_start_decides_and_a_later_resume_runs_again() {
        let now = T0 + 60 * MIN;
        let started = Marks { background: true, start: Some(T0), end: None };
        assert_eq!(state(&live(started, now)), Running);
        for how in [Done, Stopped, Failed] {
            let ended = Marks { end: Some((T0 + MIN, how)), ..started };
            assert_eq!(state(&Facts { own_last: Some(T0 + MIN), ..live(ended, now) }), how);
            // Resumed by a message: runs again until its next end.
            let resumed = Marks { start: Some(T0 + 2 * MIN), ..ended };
            assert_eq!(state(&live(resumed, now)), Running, "{how:?} then resumed");
            let again = Marks { end: Some((T0 + 3 * MIN, Done)), ..resumed };
            assert_eq!(state(&Facts { own_last: Some(T0 + 3 * MIN), ..live(again, now) }), Done);
        }
    }

    #[test]
    fn own_activity_well_after_an_end_is_a_resume() {
        let now = T0 + 60 * MIN;
        let m = Marks { background: true, start: Some(T0), end: Some((T0 + MIN, Stopped)) };
        assert_eq!(state(&Facts { own_last: Some(T0 + MIN + 30_000), ..live(m, now) }), Stopped, "its last lines as it is cut off");
        assert_eq!(state(&Facts { own_last: Some(T0 + 10 * MIN), ..live(m, now) }), Running);
    }

    #[test]
    fn meta_finished_counts_only_when_written_after_the_latest_start() {
        let now = T0 + 60 * MIN;
        let m = Marks { background: true, start: Some(T0 + 10 * MIN), end: Some((T0 + 5 * MIN, Done)) };
        let stale = Facts { meta_finished: true, meta_written: Some(T0 + 5 * MIN), ..live(m, now) };
        assert_eq!(state(&stale), Running, "finished from its earlier run");
        assert_eq!(state(&Facts { meta_written: Some(T0 + 20 * MIN), ..stale }), Done);
        // No record at all: meta.json decides, as before.
        assert_eq!(state(&Facts { meta_finished: true, ..live(Marks::default(), now) }), Done);
        assert_eq!(state(&Facts { meta_background: true, ..live(Marks::default(), now) }), Running);
    }

    #[test]
    fn no_end_on_record_and_the_parent_gone_or_restarted_is_quiet() {
        let now = T0 + 5 * MIN;
        let m = Marks { background: true, start: Some(T0), end: None };
        assert_eq!(state(&Facts { parent_live: false, ..live(m, now) }), Quiet);
        let f = Facts { own_last: Some(T0 + MIN), parent_started: Some(T0 + 3 * MIN), ..live(m, now) };
        assert_eq!(state(&f), Quiet, "the CLI was restarted after its last sign of life");
        assert_eq!(state(&Facts { parent_started: Some(T0 - MIN), ..f }), Running, "the process that launched it");
    }

    #[test]
    fn silence_alone_never_ends_a_busy_agent() {
        let m = Marks { background: true, start: Some(T0), end: None };
        let now = T0 + 45 * MIN;
        let quiet = Facts { own_last: Some(T0 + MIN), parent_last: Some(T0 + 2 * MIN), parent_started: Some(T0 - MIN), ..live(m, now) };
        assert_eq!(state(&quiet), Quiet, "both silent past the limit, outside any tool call");
        assert_eq!(state(&Facts { in_tool: true, ..quiet }), Running, "inside one long tool call");
        assert_eq!(state(&Facts { parent_last: Some(now - MIN), ..quiet }), Running, "its parent is still active");
        assert_eq!(state(&Facts { own_last: Some(now - 10 * MIN), ..quiet }), Running, "silent for 10 min only");
    }

    #[test]
    fn a_foreground_agent_ends_with_the_turn_that_waited_on_it() {
        let now = T0 + 5 * MIN;
        let f = Facts { own_last: Some(T0), parent_last: Some(T0 + MIN), parent_in_turn: false, ..live(Marks::default(), now) };
        assert_eq!(state(&f), Stopped);
        assert_eq!(state(&Facts { parent_in_turn: true, ..f }), Running);
        assert_eq!(state(&Facts { meta_background: true, ..f }), Running, "a background agent outlives the turn");
    }

    /// The record shapes of a real session (invented content): launch, stop, kill notification, failure
    /// by a usage limit, resume by a message, completion.
    #[test]
    fn parent_records_fold_into_marks() {
        let fixture = include_str!("subagent_fixtures/parent.jsonl");
        let lines: Vec<&str> = fixture.lines().filter(|l| !l.trim().is_empty()).collect();
        let map = parse(&lines);
        let st = |id: &str, own: u64| {
            let m = map[id];
            state(&Facts { own_last: Some(own), parent_live: true, parent_last: Some(T0), now: T0, marks: m, ..Facts::default() })
        };
        let ms = |s: &str| crate::util::parse_rfc3339_ms(s).unwrap();
        // Stopped with TaskStop: its result and the "killed" notification.
        assert_eq!(map["a1111111111111111"].end.map(|e| e.1), Some(Stopped));
        assert_eq!(st("a1111111111111111", ms("2026-11-20T10:02:00Z")), Stopped);
        // Completed.
        assert_eq!(st("a2222222222222222", ms("2026-11-20T10:05:00Z")), Done);
        // Failed on a usage limit, resumed by a message, then completed.
        let m = map["a3333333333333333"];
        assert!(m.background && m.end.map(|e| e.1) == Some(Done) && m.start < m.end.map(|e| e.0));
        assert_eq!(st("a3333333333333333", ms("2026-11-20T10:20:00Z")), Done);
        // Failed and not resumed.
        assert_eq!(st("a4444444444444444", ms("2026-11-20T10:06:00Z")), Failed);
        // Stopped, then resumed by a message: running again.
        assert_eq!(st("a5555555555555555", ms("2026-11-20T10:31:00Z")), Running);
        // A foreground agent's result completes it.
        assert_eq!(map["a6666666666666666"].end.map(|e| e.1), Some(Done));
        assert!(!map["a6666666666666666"].background);
        // A compaction's snapshot says running: a start, before its "completed" end.
        assert_eq!(st("a7777777777777777", ms("2026-11-20T10:40:00Z")), Done);
        // Background shells' notifications are keyed apart and never match an agent.
        assert_eq!(map.get("bshell001").and_then(|m| m.end).map(|e| e.1), Some(Done));
    }
}
