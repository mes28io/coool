//! The agent's view of the screen: the helper's accessibility nodes turned into a compact text listing with short,
//! stable element ids.
//!
//! An id is a hash of what identifies the element to a person (role + accessibility identifier, else label, else
//! value; position only when there is nothing else) plus its occurrence among equal keys, so the same button keeps
//! its id across observes, scrolls and unrelated changes elsewhere on the screen.

use serde_json::Value;
use std::collections::HashMap;
use std::fmt::Write;

#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    pub id: String,
    pub role: String,
    pub label: Option<String>,
    pub value: Option<String>,
    pub identifier: Option<String>,
    pub placeholder: Option<String>,
    pub frame: [f64; 4],
    pub depth: usize,
    pub flags: Vec<&'static str>,
}

impl Node {
    pub fn center(&self) -> (f64, f64) {
        (self.frame[0] + self.frame[2] / 2.0, self.frame[1] + self.frame[3] / 2.0)
    }

    /// Whether any visible text of this element contains `needle` (case-insensitive).
    pub fn mentions(&self, needle: &str) -> bool {
        let n = needle.to_lowercase();
        [&self.label, &self.value, &self.identifier, &self.placeholder].iter().any(|t| t.as_ref().is_some_and(|t| t.to_lowercase().contains(&n)))
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tree {
    /// The frontmost app's name ("" on the home screen).
    pub app: String,
    pub nodes: Vec<Node>,
    pub w: f64,
    pub h: f64,
}

const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";

fn short(mut h: u64, len: usize) -> String {
    (0..len)
        .map(|_| {
            let c = ALPHABET[(h % ALPHABET.len() as u64) as usize] as char;
            h /= ALPHABET.len() as u64;
            c
        })
        .collect()
}

fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
}

fn text(v: &Value) -> Option<String> {
    let s = match v {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => return None,
    };
    (!s.is_empty()).then_some(s)
}

pub fn parse(desc: &Value) -> Tree {
    // The helper walks breadth-first; list depth-first (each element right after its parent) so indentation reads
    // as nesting.
    let bfs = desc["nodes"].as_array().cloned().unwrap_or_default();
    let mut kids: Vec<Vec<usize>> = vec![Vec::new(); bfs.len()];
    let mut roots = Vec::new();
    for (i, n) in bfs.iter().enumerate() {
        match n["parent"].as_i64() {
            Some(p) if p >= 0 && (p as usize) < i => kids[p as usize].push(i),
            _ => roots.push(i),
        }
    }
    let mut raw = Vec::with_capacity(bfs.len());
    let mut stack: Vec<usize> = roots.into_iter().rev().collect();
    while let Some(i) = stack.pop() {
        raw.push(bfs[i].clone());
        stack.extend(kids[i].iter().rev());
    }
    let mut tree = Tree { w: desc["screen"]["w"].as_f64().unwrap_or(0.0), h: desc["screen"]["h"].as_f64().unwrap_or(0.0), ..Default::default() };
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut used: HashMap<String, ()> = HashMap::new();
    for (i, n) in raw.iter().enumerate() {
        let f = |k: usize| n["frame"][k].as_f64().unwrap_or(0.0);
        let frame = [f(0), f(1), f(2), f(3)];
        let role = n["role"].as_str().unwrap_or("element").to_string();
        let label = text(&n["label"]);
        let value = text(&n["value"]);
        let identifier = text(&n["identifier"]);
        if i == 0 && role == "application" {
            tree.app = label.clone().unwrap_or_default();
            continue;
        }
        if frame[2] <= 0.0 || frame[3] <= 0.0 {
            continue;
        }
        let what = identifier.clone().or_else(|| label.clone()).or_else(|| value.clone()).unwrap_or_else(|| format!("@{:.0},{:.0}", frame[0] / 8.0, frame[1] / 8.0));
        let key = format!("{role}|{what}");
        let nth = seen.entry(key.clone()).or_insert(0);
        *nth += 1;
        let h = fnv(&format!("{key}#{nth}"));
        let mut id = short(h, 3);
        let mut len = 3;
        while used.contains_key(&id) {
            len += 1;
            id = short(h.rotate_left(len as u32 * 7), len);
        }
        used.insert(id.clone(), ());
        let mut flags = Vec::new();
        if n["disabled"].as_bool() == Some(true) {
            flags.push("disabled");
        }
        if n["selected"].as_bool() == Some(true) {
            flags.push("selected");
        }
        if n["focused"].as_bool() == Some(true) {
            flags.push("focused");
        }
        // Listed but scrolled out of view: scroll before tapping it.
        if tree.h > 0.0 && (frame[1] >= tree.h || frame[1] + frame[3] <= 0.0 || frame[0] >= tree.w || frame[0] + frame[2] <= 0.0) {
            flags.push("offscreen");
        }
        tree.nodes.push(Node {
            id,
            role,
            label,
            value,
            identifier,
            placeholder: text(&n["placeholder"]),
            frame,
            depth: n["depth"].as_u64().unwrap_or(1).saturating_sub(1) as usize,
            flags,
        });
    }
    tree
}

fn q(s: &str) -> String {
    let s: String = s.chars().map(|c| if c == '\n' { ' ' } else { c }).collect();
    let s = if s.chars().count() > 120 { format!("{}…", s.chars().take(119).collect::<String>()) } else { s };
    format!("\"{}\"", s.replace('"', "\\\""))
}

/// The listing an agent reads. One line per element:
/// `[k3f] button "General" (16,300 370x52)`, indented by depth, values and states after the label.
pub fn render(t: &Tree, device: &str) -> String {
    let mut s = String::new();
    let app = if t.app.is_empty() { "home screen".to_string() } else { format!("app {}", q(&t.app)) };
    let _ = writeln!(s, "{device} · {}x{} pt · {app} · {} elements", t.w, t.h, t.nodes.len());
    for n in &t.nodes {
        let _ = write!(s, "{}[{}] {}", "  ".repeat(n.depth.min(6)), n.id, n.role);
        let label = n.label.as_deref().or(n.identifier.as_deref());
        if let Some(l) = label {
            let _ = write!(s, " {}", q(l));
        }
        if let Some(v) = n.value.as_deref().filter(|v| Some(*v) != label) {
            let _ = write!(s, " value={}", q(v));
        }
        if let Some(p) = n.placeholder.as_deref().filter(|p| Some(*p) != label && Some(*p) != n.value.as_deref()) {
            let _ = write!(s, " placeholder={}", q(p));
        }
        if let Some(id) = n.identifier.as_deref().filter(|i| Some(*i) != label && !i.contains(' ') && Some(*i) != n.label.as_deref()) {
            let _ = write!(s, " id={}", q(id));
        }
        for f in &n.flags {
            let _ = write!(s, " {f}");
        }
        let [x, y, w, h] = n.frame;
        let _ = writeln!(s, " ({x:.0},{y:.0} {w:.0}x{h:.0})");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn desc(extra: Value) -> Value {
        let mut nodes = vec![
            json!({"role":"application","label":"Settings","frame":[0,0,402,874],"depth":0}),
            json!({"role":"button","label":"General","identifier":"com.apple.settings.general","frame":[16,300,370,52],"depth":1}),
            json!({"role":"textfield","value":"Hello","placeholder":"Search","frame":[28,808,346,28],"depth":1,"focused":true}),
            json!({"role":"button","label":"Back","frame":[0,50,60,44],"depth":1}),
        ];
        if !extra.is_null() {
            nodes.insert(1, extra);
        }
        json!({"nodes": nodes, "screen": {"w": 402, "h": 874}})
    }

    #[test]
    fn ids_are_stable_when_unrelated_elements_come_and_go() {
        let a = parse(&desc(Value::Null));
        let b = parse(&desc(json!({"role":"text","label":"Banner","frame":[0,0,402,40],"depth":1})));
        assert_eq!(a.app, "Settings");
        assert_eq!(a.nodes.len(), 3);
        for n in &a.nodes {
            assert_eq!(b.nodes.iter().find(|m| m.role == n.role && m.label == n.label).unwrap().id, n.id);
        }
        let ids: std::collections::HashSet<_> = b.nodes.iter().map(|n| &n.id).collect();
        assert_eq!(ids.len(), b.nodes.len());
    }

    #[test]
    fn breadth_first_input_lists_depth_first() {
        let d = json!({"screen":{"w":402,"h":874},"nodes":[
            {"role":"application","label":"A","frame":[0,0,402,874],"depth":0,"parent":-1},
            {"role":"group","label":"List","frame":[0,0,402,800],"depth":1,"parent":0},
            {"role":"button","label":"Done","frame":[300,40,80,40],"depth":1,"parent":0},
            {"role":"button","label":"Row","frame":[0,100,402,50],"depth":2,"parent":1},
            {"role":"button","label":"Far","frame":[0,900,402,50],"depth":2,"parent":1}]});
        let t = parse(&d);
        let labels: Vec<_> = t.nodes.iter().map(|n| n.label.clone().unwrap()).collect();
        assert_eq!(labels, ["List", "Row", "Far", "Done"]);
        assert_eq!(t.nodes[1].depth, 1);
        assert!(t.nodes[2].flags.contains(&"offscreen") && !t.nodes[1].flags.contains(&"offscreen"));
    }

    #[test]
    fn render_is_compact() {
        let t = parse(&desc(Value::Null));
        let r = render(&t, "coool iPhone");
        assert!(r.starts_with("coool iPhone · 402x874 pt · app \"Settings\" · 3 elements\n"));
        assert!(r.contains("button \"General\" id=\"com.apple.settings.general\" (16,300 370x52)"), "{r}");
        assert!(r.contains("textfield value=\"Hello\" placeholder=\"Search\" focused (28,808 346x28)"), "{r}");
        assert_eq!(t.nodes[1].center(), (201.0, 822.0));
    }
}
