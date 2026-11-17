//! What the desktop app sends of each session (APP_SPEC "Backend contract"),
//! and the one memo it keeps per session: the session as last sent, with its
//! JSON in parts. From that memo a refresh learns, without serializing, which
//! sessions are unchanged (they are not sent at all), serializes only the
//! timeline entries that are new, and sends a changed session the UI already
//! holds as a patch when that is smaller than the whole session.
//!
//! A busy session changes several times a second, but almost always by a few
//! new timeline entries at the end; its whole JSON (with every subagent's
//! timeline) can be over a megabyte. A patch is `{ head, activity, agents }`:
//! `head` is every field but the two lists, in full; `activity` and `agents`
//! are list patches `{ from, keep, edit: [[i, item]], tail: [items] }`: the
//! new list is the old one's `keep` items starting at `from`, with item `i` of
//! those replaced by each `edit`, followed by `tail`. In `agents`, an `edit`
//! item is `{ head, activity }` (that subagent's fields and its timeline's
//! patch) and `tail` items are whole agents.

use crate::insights::Insight;
use crate::model::{Activity, Agent, Session};
use std::sync::Arc;

/// One timeline entry's JSON (shared between rounds while the entry is unchanged).
pub type Entry = Arc<str>;

/// A [`Session`]'s JSON in parts; [`SessionJson::to_json`] puts it back together.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionJson {
    /// Every field but `activity` and `agents` (plus `insight`, when given), as one JSON object.
    pub head: String,
    pub activity: Vec<Entry>,
    pub agents: Vec<AgentJson>,
}

/// One [`Agent`] in parts (see [`SessionJson`]).
#[derive(Clone, Debug, PartialEq)]
pub struct AgentJson {
    pub id: String,
    /// Every field but `activity`, as one JSON object.
    pub head: String,
    pub activity: Vec<Entry>,
}

/// One session as the UI last got it: the session itself (to tell, without
/// serializing, whether anything changed) and its JSON in parts.
pub struct Sent {
    pub session: Session,
    insight: Option<Insight>,
    pub json: SessionJson,
}

impl Sent {
    /// `session` (plus `insight`, CHAT_SPEC "AI insights") in parts. Entries
    /// that `prev` already serialized are reused, so a session that grew by a
    /// few entries costs only those.
    pub fn new(session: Session, insight: Option<Insight>, prev: Option<&Sent>) -> Self {
        let p = prev.map(|p| (&p.session, &p.json));
        let mut head = without(serde_json::to_string(&head_of(&session)).unwrap_or_default(), "\"activity\":[],\"agents\":[],");
        if let Some(i) = &insight
            && head.ends_with('}')
            && let Ok(i) = serde_json::to_string(i)
        {
            head.pop();
            head.push_str(if head.len() > 1 { ",\"insight\":" } else { "\"insight\":" });
            head.push_str(&i);
            head.push('}');
        }
        let activity = entries(&session.activity, p.map(|(s, j)| (&s.activity[..], &j.activity[..])));
        let agents = session
            .agents
            .iter()
            .map(|a| {
                let old = p.and_then(|(s, j)| s.agents.iter().zip(&j.agents).find(|(o, _)| o.id == a.id));
                AgentJson {
                    id: a.id.clone(),
                    head: without(serde_json::to_string(&agent_head(a)).unwrap_or_default(), "\"activity\":[],"),
                    activity: entries(&a.activity, old.map(|(o, j)| (&o.activity[..], &j.activity[..]))),
                }
            })
            .collect();
        Self { session, insight, json: SessionJson { head, activity, agents } }
    }

    /// Nothing the UI shows of it changed: the memo can be kept, nothing is sent.
    pub fn same(&self, s: &Session, insight: &Option<Insight>) -> bool {
        self.session == *s && self.insight == *insight
    }

    pub fn to_json(&self) -> String {
        self.json.to_json()
    }

    /// This session as a patch against `prev` (see the module docs), or None
    /// when that would not be clearly smaller than the whole session.
    pub fn patch(&self, prev: &Sent) -> Option<String> {
        let (a, b) = (&prev.json, &self.json);
        let mut out = String::with_capacity(b.head.len() + 256);
        out.push_str("{\"head\":");
        out.push_str(&b.head);
        out.push_str(",\"activity\":");
        list_patch(&mut out, &a.activity, &b.activity, |x, y| x == y, |out, _, n| out.push_str(n));
        out.push_str(",\"agents\":");
        list_patch(
            &mut out,
            &a.agents,
            &b.agents,
            |x, y| x.id == y.id,
            |out, o: &AgentJson, n: &AgentJson| {
                out.push_str("{\"head\":");
                out.push_str(&n.head);
                out.push_str(",\"activity\":");
                list_patch(out, &o.activity, &n.activity, |x, y| x == y, |out, _, n| out.push_str(n));
                out.push('}');
            },
        );
        out.push('}');
        // Room for the patch's own keys: anything near the whole size goes out whole.
        (out.len() * 4 < approx_len(b) * 3).then_some(out)
    }
}

/// Every field but the two lists. A struct literal, not `..`, so a new field can't be left out.
fn head_of(s: &Session) -> Session {
    Session {
        provider: s.provider,
        id: s.id.clone(),
        title: s.title.clone(),
        cwd: s.cwd.clone(),
        project: s.project.clone(),
        model: s.model.clone(),
        pid: s.pid,
        status: s.status,
        current: s.current.clone(),
        last_prompt: s.last_prompt.clone(),
        tokens: s.tokens.clone(),
        activity: Default::default(),
        agents: Vec::new(),
        updated: s.updated,
        last_event: s.last_event,
        managed: s.managed,
        chat: s.chat,
        models: s.models.clone(),
        loaded: s.loaded,
        origin: s.origin,
        parent: s.parent.clone(),
        live_children: s.live_children,
        background_tasks: s.background_tasks,
        waiting_for: s.waiting_for.clone(),
        shells: s.shells.clone(),
    }
}

fn agent_head(a: &Agent) -> Agent {
    Agent {
        id: a.id.clone(),
        kind: a.kind.clone(),
        description: a.description.clone(),
        finished: a.finished,
        current: a.current.clone(),
        tokens: a.tokens.clone(),
        activity: Default::default(),
        model: a.model.clone(),
        models: a.models.clone(),
    }
}

/// Each entry's JSON, reusing what `prev` (old entries and their JSON) has for an equal entry at the aligned place.
fn entries(list: &[Activity], prev: Option<(&[Activity], &[Entry])>) -> Vec<Entry> {
    let ser = |a: &Activity| Entry::from(serde_json::to_string(a).unwrap_or_else(|_| "null".into()));
    let Some((old, json)) = prev else { return list.iter().map(ser).collect() };
    let d = align(old, list, |x, y| x == y);
    list.iter().enumerate().map(|(i, a)| if old.get(d + i) == Some(a) { json[d + i].clone() } else { ser(a) }).collect()
}

/// `json` without the one `"name":[],` run serde wrote for an emptied list. (Inside a
/// JSON string every `"` is escaped, so the run can only be that field.)
fn without(mut json: String, field: &str) -> String {
    if let Some(at) = json.find(field) {
        json.replace_range(at..at + field.len(), "");
    }
    json
}

/// `head` (a JSON object) with `"key":[items]` appended.
fn with_list<'a>(head: &str, key: &str, items: impl Iterator<Item = &'a str>, extra: usize) -> String {
    let mut out = String::with_capacity(head.len() + key.len() + extra + 8);
    out.push_str(head.strip_suffix('}').unwrap_or(head));
    if out.len() > 1 {
        out.push(',');
    }
    out.push('"');
    out.push_str(key);
    out.push_str("\":[");
    for (i, it) in items.enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(it);
    }
    out.push_str("]}");
    out
}

fn list_len<S: AsRef<str>>(items: &[S]) -> usize {
    items.iter().map(|s| s.as_ref().len() + 1).sum()
}

impl AgentJson {
    pub fn to_json(&self) -> String {
        with_list(&self.head, "activity", self.activity.iter().map(|e| &**e), list_len(&self.activity))
    }
}

impl SessionJson {
    /// The whole session as one JSON object (the same value as `Session::to_json`, plus `insight`).
    pub fn to_json(&self) -> String {
        let head = with_list(&self.head, "activity", self.activity.iter().map(|e| &**e), list_len(&self.activity));
        let agents: Vec<String> = self.agents.iter().map(AgentJson::to_json).collect();
        with_list(&head, "agents", agents.iter().map(String::as_str), list_len(&agents))
    }
}

fn approx_len(j: &SessionJson) -> usize {
    j.head.len() + list_len(&j.activity) + j.agents.iter().map(|a| a.head.len() + list_len(&a.activity) + 16).sum::<usize>() + 32
}

/// Where `new` starts in `old`: the first `old[d]` that is `new[0]` by `key`
/// (and `new[1]` follows it, when both lists have one). Timelines only lose
/// entries at the front (`MAX_ACTIVITY`), so this is usually 0 or a few.
/// Only the patch size depends on it, never the result.
fn align<T>(old: &[T], new: &[T], key: impl Fn(&T, &T) -> bool) -> usize {
    let Some(first) = new.first() else { return old.len() };
    (0..old.len())
        .find(|&d| {
            key(&old[d], first)
                && match (old.get(d + 1), new.get(1)) {
                    (Some(o), Some(n)) => key(o, n),
                    _ => true,
                }
        })
        .unwrap_or(0)
}

/// Writes `new` as a list patch against `old`. `key` matches up items (see
/// [`align`]), `==` finds the ones that changed, `edit` writes a changed one
/// (given its old and new value); `tail` items are written whole.
fn list_patch<T: PartialEq + Whole>(out: &mut String, old: &[T], new: &[T], key: impl Fn(&T, &T) -> bool, edit: impl Fn(&mut String, &T, &T)) {
    let from = align(old, new, key);
    let keep = old.len().saturating_sub(from).min(new.len());
    out.push_str("{\"from\":");
    out.push_str(&from.to_string());
    out.push_str(",\"keep\":");
    out.push_str(&keep.to_string());
    out.push_str(",\"edit\":[");
    let mut first = true;
    for i in 0..keep {
        if old[from + i] != new[i] {
            if !first {
                out.push(',');
            }
            first = false;
            out.push('[');
            out.push_str(&i.to_string());
            out.push(',');
            edit(out, &old[from + i], &new[i]);
            out.push(']');
        }
    }
    out.push_str("],\"tail\":[");
    for (i, n) in new[keep..].iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        n.write_whole(out);
    }
    out.push_str("]}");
}

/// An item written whole (a `tail` item).
trait Whole {
    fn write_whole(&self, out: &mut String);
}
impl Whole for Entry {
    fn write_whole(&self, out: &mut String) {
        out.push_str(self);
    }
}
impl Whole for AgentJson {
    fn write_whole(&self, out: &mut String) {
        out.push_str(&self.to_json());
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::model::{Activity, ActivityKind, Origin, Provider, Status, Tokens};
    use serde_json::{Value, json};
    use std::time::{Duration, SystemTime};

    pub(crate) fn entry(text: &str) -> Activity {
        Activity::message("10:00:00".into(), ActivityKind::Text, &format!("{text}\nwith a second line"), 80)
    }

    pub(crate) fn agent(id: &str, n: usize) -> Agent {
        Agent {
            id: id.into(),
            kind: "Explore".into(),
            description: format!("task {id}"),
            finished: false,
            current: None,
            tokens: Tokens::default(),
            activity: Arc::new((0..n).map(|i| entry(&format!("{id} step {i}"))).collect()),
            model: String::new(),
            models: Vec::new(),
        }
    }

    pub(crate) fn session(id: &str, updated_ms: u64, n: usize) -> Session {
        Session {
            provider: Provider::Claude,
            id: id.into(),
            title: String::new(),
            cwd: String::new(),
            project: String::new(),
            model: String::new(),
            pid: None,
            status: Status::Idle,
            current: None,
            last_prompt: None,
            tokens: Tokens::default(),
            activity: Arc::new((0..n).map(|i| entry(&format!("{id} entry {i}"))).collect()),
            agents: Vec::new(),
            updated: SystemTime::UNIX_EPOCH + Duration::from_millis(updated_ms),
            last_event: None,
            managed: None,
            chat: None,
            models: Vec::new(),
            loaded: true,
            origin: Origin::User,
            parent: None,
            live_children: 0,
            background_tasks: false,
            waiting_for: None,
            shells: Vec::new(),
        }
    }

    fn val(s: &Session) -> Value {
        serde_json::from_str(&s.to_json()).unwrap()
    }

    #[test]
    fn parts_put_back_together_equal_to_json() {
        let mut s = session("x", 1, 2);
        s.title = r#""activity":[],"agents":[],"#.into();
        let mut a = agent("ag", 2);
        a.description = r#"look "activity":[], around"#.into();
        s.agents = vec![a.clone(), Agent { id: "ag2".into(), activity: Default::default(), ..a }];
        let sent = Sent::new(s.clone(), None, None);
        let head: Value = serde_json::from_str(&sent.json.head).unwrap();
        assert!(head.get("activity").is_none() && head.get("agents").is_none() && head["title"] == val(&s)["title"], "{}", sent.json.head);
        assert_eq!(serde_json::from_str::<Value>(&sent.to_json()).unwrap(), val(&s));
        s.activity = Default::default();
        s.agents.clear();
        assert_eq!(serde_json::from_str::<Value>(&Sent::new(s.clone(), None, None).to_json()).unwrap(), val(&s));
    }

    #[test]
    fn insight_is_added_to_the_head() {
        let s = session("x", 0, 2);
        let i = Insight { headline: "h".into(), needs_you: None, generated_ms: 5 };
        let with: Value = serde_json::from_str(&Sent::new(s, Some(i), None).to_json()).unwrap();
        assert_eq!((&with["id"], &with["insight"], with["activity"].as_array().map(Vec::len)), (&json!("x"), &json!({"headline": "h", "needs_you": null, "generated_ms": 5}), Some(2)));
    }

    #[test]
    fn unchanged_entries_are_not_serialized_again() {
        let a = session("x", 1, 50);
        let first = Sent::new(a.clone(), None, None);
        let mut b = a.clone();
        let list = Arc::make_mut(&mut b.activity);
        list.drain(..2);
        list.push(entry("new"));
        let second = Sent::new(b.clone(), None, Some(&first));
        assert!(Arc::ptr_eq(&second.json.activity[0], &first.json.activity[2]), "kept entries share their JSON");
        assert_eq!(serde_json::from_str::<Value>(&second.to_json()).unwrap(), val(&b));
    }

    /// The frontend's apply (`applyList` in sessionsMerge.ts), for checking patches.
    fn apply(old: &[Value], p: &Value, edit: &dyn Fn(&Value, &Value) -> Value) -> Vec<Value> {
        let (from, keep) = (p["from"].as_u64().unwrap() as usize, p["keep"].as_u64().unwrap() as usize);
        let mut out: Vec<Value> = old[from..from + keep].to_vec();
        for e in p["edit"].as_array().unwrap() {
            let i = e[0].as_u64().unwrap() as usize;
            out[i] = edit(&out[i], &e[1]);
        }
        out.extend(p["tail"].as_array().unwrap().iter().cloned());
        out
    }

    fn apply_session(old: &Value, p: &Value) -> Value {
        let mut s = p["head"].clone();
        s["activity"] = Value::Array(apply(old["activity"].as_array().unwrap(), &p["activity"], &|_, n| n.clone()));
        s["agents"] = Value::Array(apply(old["agents"].as_array().unwrap(), &p["agents"], &|o, e| {
            let mut a = e["head"].clone();
            a["activity"] = Value::Array(apply(o["activity"].as_array().unwrap(), &e["activity"], &|_, n| n.clone()));
            a
        }));
        s
    }

    fn check(old: &Session, new: &Session) -> Option<String> {
        let a = Sent::new(old.clone(), None, None);
        let b = Sent::new(new.clone(), None, Some(&a));
        let p = b.patch(&a)?;
        let p: Value = serde_json::from_str(&p).unwrap();
        let before: Value = serde_json::from_str(&a.to_json()).unwrap();
        assert_eq!(apply_session(&before, &p), val(new));
        Some(p.to_string())
    }

    #[test]
    fn patches_rebuild_the_session() {
        let mut a = session("x", 1, 60);
        let mut ag = agent("ag1", 40);
        a.agents = vec![ag.clone(), agent("ag2", 40)];
        let whole = a.to_json().len();

        // Appended entries, a subagent's new step, a field: a small patch.
        let mut b = a.clone();
        b.updated = SystemTime::UNIX_EPOCH + Duration::from_millis(2);
        Arc::make_mut(&mut b.activity).push(entry("new one"));
        Arc::make_mut(&mut ag.activity).push(entry("agent step"));
        ag.current = Some("Read".into());
        b.agents[0] = ag.clone();
        let p = check(&a, &b).expect("a patch");
        assert!(p.len() * 10 < whole, "{} vs {whole}", p.len());
        let v: Value = serde_json::from_str(&p).unwrap();
        assert_eq!((&v["activity"]["from"], &v["activity"]["keep"], v["activity"]["tail"].as_array().map(Vec::len)), (&json!(0), &json!(60), Some(1)));
        assert_eq!(v["agents"]["edit"].as_array().map(Vec::len), Some(1));

        // Entries dropped at the front, one in the middle rewritten, a new subagent.
        let mut c = b.clone();
        let list = Arc::make_mut(&mut c.activity);
        list.drain(..3);
        list[10].full = None;
        list[10].shortened = true;
        c.agents.push(agent("ag3", 2));
        let v: Value = serde_json::from_str(&check(&b, &c).expect("a patch")).unwrap();
        assert_eq!((&v["activity"]["from"], v["activity"]["edit"].as_array().map(Vec::len)), (&json!(3), Some(1)));

        // Everything different: sent whole.
        let mut d = session("x", 3, 60);
        for e in Arc::make_mut(&mut d.activity) {
            e.text.push('!');
        }
        assert!(check(&c, &d).is_none());
        // Emptied and shrinking lists still rebuild exactly.
        let mut e = c.clone();
        Arc::make_mut(&mut e.activity).truncate(5);
        e.agents.clear();
        let _ = check(&c, &e);
    }
}
