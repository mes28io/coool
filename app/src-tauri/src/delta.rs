//! The session data of `sessions-delta` (APP_SPEC "Backend contract"): what the
//! UI last got of each session, and a changed session as a patch against that.
//!
//! A busy session changes several times a second, but almost always by a few
//! new timeline entries at the end; its whole JSON (with every subagent's
//! timeline) can be over a megabyte. So a session the UI already holds goes out
//! as `patch`: its fields besides the two lists in full (`head`), and `activity`
//! and `agents` as list patches. A list patch is
//! `{ from, keep, edit: [[i, item]], tail: [items] }`: the new list is the old
//! one's `keep` items starting at `from`, with item `i` of those replaced by
//! each `edit`, followed by `tail`. In `agents`, an `edit` item is itself
//! `{ head, activity }` (that subagent's fields and its timeline's patch) and
//! `tail` items are whole agents.

use coool_core::insights::Insight;
use coool_core::model::{AgentJson, Session, SessionJson};

/// One session as the UI last got it.
pub struct Sent {
    pub session: Session,
    insight: Option<Insight>,
    json: SessionJson,
}

impl Sent {
    /// A session's JSON is `Session` plus what the app knows about it beyond
    /// discovery (`insight`, CHAT_SPEC "AI insights", only while insights are on).
    pub fn new(session: Session, insight: Option<Insight>) -> Self {
        let mut json = session.json_parts();
        if let Some(i) = &insight
            && json.head.ends_with('}')
            && let Ok(i) = serde_json::to_string(i)
        {
            json.head.pop();
            json.head.push_str(if json.head.len() > 1 { ",\"insight\":" } else { "\"insight\":" });
            json.head.push_str(&i);
            json.head.push('}');
        }
        Self { session, insight, json }
    }

    /// Nothing the UI shows of it changed.
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

fn approx_len(j: &SessionJson) -> usize {
    let list = |l: &[String]| l.iter().map(|s| s.len() + 1).sum::<usize>();
    j.head.len() + list(&j.activity) + j.agents.iter().map(|a| a.head.len() + list(&a.activity) + 16).sum::<usize>() + 32
}

/// Where `new` starts in `old`: the first `old[d]` that is `new[0]` by `key`
/// (and `new[1]` follows it, when both lists have one). Timelines only lose
/// entries at the front (`MAX_ACTIVITY`), so this is usually 0 or a few.
/// Only the patch size depends on it, never the result.
fn align<T>(old: &[T], new: &[T], key: impl Fn(&T, &T) -> bool) -> usize {
    let Some(first) = new.first() else { return old.len() };
    (0..old.len())
        .find(|&d| key(&old[d], first) && match (old.get(d + 1), new.get(1)) {
            (Some(o), Some(n)) => key(o, n),
            _ => true,
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
impl Whole for String {
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
mod tests {
    use super::*;
    use serde_json::{Value, json};

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
        let (a, b) = (Sent::new(old.clone(), None), Sent::new(new.clone(), None));
        let p = b.patch(&a)?;
        let p: Value = serde_json::from_str(&p).unwrap();
        let before: Value = serde_json::from_str(&a.to_json()).unwrap();
        let want: Value = serde_json::from_str(&new.to_json()).unwrap();
        assert_eq!(apply_session(&before, &p), want);
        Some(p.to_string())
    }

    #[test]
    fn patches_rebuild_the_session() {
        let mut a = crate::tests::session("x", 1, 60);
        let mut ag = crate::tests::agent("ag1", 40);
        a.agents = vec![ag.clone(), crate::tests::agent("ag2", 40)];
        let whole = a.to_json().len();

        // Appended entries, a subagent's new step, a field: a small patch.
        let mut b = a.clone();
        b.updated = std::time::UNIX_EPOCH + std::time::Duration::from_millis(2);
        b.activity.push(crate::tests::entry("new one"));
        ag.activity.push(crate::tests::entry("agent step"));
        ag.current = Some("Read".into());
        b.agents[0] = ag.clone();
        let p = check(&a, &b).expect("a patch");
        assert!(p.len() * 10 < whole, "{} vs {whole}", p.len());
        let v: Value = serde_json::from_str(&p).unwrap();
        assert_eq!((&v["activity"]["from"], &v["activity"]["keep"], v["activity"]["tail"].as_array().map(Vec::len)), (&json!(0), &json!(60), Some(1)));
        assert_eq!(v["agents"]["edit"].as_array().map(Vec::len), Some(1));

        // Entries dropped at the front, one in the middle rewritten, a new subagent.
        let mut c = b.clone();
        c.activity.drain(..3);
        c.activity[10].full = None;
        c.activity[10].shortened = true;
        c.agents.push(crate::tests::agent("ag3", 2));
        let v: Value = serde_json::from_str(&check(&b, &c).expect("a patch")).unwrap();
        assert_eq!((&v["activity"]["from"], v["activity"]["edit"].as_array().map(Vec::len)), (&json!(3), Some(1)));

        // Everything different: sent whole.
        let mut d = crate::tests::session("x", 3, 60);
        for e in &mut d.activity {
            e.text.push('!');
        }
        assert!(check(&c, &d).is_none());
        // Emptied lists and shrinking lists still rebuild exactly.
        let mut e = c.clone();
        e.activity.truncate(5);
        e.agents.clear();
        let _ = check(&c, &e);
    }
}
