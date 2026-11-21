//! The Changes engine's cost per call on a case made by app/scripts/perf/make-changes-home.py (docs/PERF.md
//! "Changes view"): a cold load, warm calls with nothing new (as the app's polling makes them), and calls after an
//! edit lands, a transcript line that isn't an edit, a hand edit. It changes the case (appends to the transcript,
//! edits a file): run it on a case of its own.
//!
//!     cargo run --release -p coool-core --example changes_bench -- <out-of-make-changes-home> [rounds]

use coool_core::changes::record::Kind;
use coool_core::changes::{Changes, Request, Scope, Source};
use serde_json::json;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

fn med(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn append(p: &Path, lines: &[serde_json::Value]) {
    let mut f = std::fs::OpenOptions::new().append(true).open(p).unwrap();
    for l in lines {
        writeln!(f, "{l}").unwrap();
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let out = PathBuf::from(a.get(1).expect("usage: changes_bench <out> [rounds]")).canonicalize().unwrap();
    let rounds: usize = a.get(2).and_then(|x| x.parse().ok()).unwrap_or(10);
    let cwd = out.join("proj/heavy-app");
    let enc = cwd.to_string_lossy().replace(['/', '.'], "-");
    let proj = out.join("home/.claude/projects").join(enc);
    let sid = "5e55c0de-0000-4000-8000-00000000c0de";
    let tp = proj.join(format!("{sid}.jsonl"));
    let sources = vec![
        Source { kind: Kind::Claude, agent: None, path: tp.clone() },
        Source { kind: Kind::Claude, agent: Some("a0c0ffee00".into()), path: proj.join(sid).join("subagents/agent-a0c0ffee00.jsonl") },
    ];
    let state = std::env::temp_dir().join(format!("coool-changes-bench-{}", std::process::id()));
    let key = format!("claude:{sid}");
    let eng = Changes::new(Some(state.clone()));
    let req = |scope| Request { key: &key, cwd: &cwd, sources: &sources, scope, external: true };
    let size = |w: &coool_core::changes::Wire| serde_json::to_vec(w).unwrap().len() as f64 / 1024.0;

    let t = Instant::now();
    let w = eng.load_wire(&req(Scope::Pending), 0, false);
    let kb = size(&w);
    let files = w.set.as_ref().map(|s| s.files.len()).unwrap_or(0);
    println!("cold, full: {:.1} ms, {files} files, {kb:.1} KB", ms(t));
    let mut rev = w.rev;

    let (mut full, mut same, mut summ) = (Vec::new(), Vec::new(), Vec::new());
    let (mut kb_full, mut kb_same, mut kb_summ) = (0.0, 0.0, 0.0);
    for _ in 0..rounds {
        let t = Instant::now();
        let w = eng.load_wire(&req(Scope::Pending), 0, false);
        kb_full = size(&w);
        full.push(ms(t));
        let t = Instant::now();
        let w = eng.load_wire(&req(Scope::Pending), rev, false);
        kb_same = size(&w);
        same.push(ms(t));
        rev = w.rev;
        let t = Instant::now();
        let w = eng.load_wire(&req(Scope::Pending), rev, true);
        kb_summ = size(&w);
        summ.push(ms(t));
    }
    println!("warm, nothing new, asked in full (since 0): median {:.2} ms, {kb_full:.1} KB", med(full));
    println!("warm, nothing new, since the last revision: median {:.2} ms, {kb_same:.2} KB", med(same));
    println!("warm, nothing new, summary (closed panel): median {:.2} ms, {kb_summ:.2} KB", med(summ));

    // A transcript line that isn't an edit (a busy session's text / tool call).
    let mut t_text = Vec::new();
    let mut kb_text = 0.0;
    for i in 0..rounds {
        append(&tp, &[json!({"type":"assistant","timestamp":"2030-01-01T00:00:00.000Z","sessionId":sid,"message":{"content":[{"type":"text","text":format!("Still working {i}")}]}})]);
        let t = Instant::now();
        let w = eng.load_wire(&req(Scope::Pending), rev, false);
        t_text.push(ms(t));
        kb_text = size(&w);
        rev = w.rev;
    }
    println!("a transcript line that isn't an edit, since the last revision: median {:.2} ms, {kb_text:.2} KB", med(t_text));

    // An Edit that lands (the file changed on disk, the call and its result in the transcript).
    let target = cwd.join("src/m1/mod1.ts");
    let mut t_edit = Vec::new();
    let mut kb_edit = Vec::new();
    for i in 0..rounds {
        let before = std::fs::read_to_string(&target).unwrap();
        let (old, new) = ("import { load } from './lib';".to_string(), format!("import {{ load }} from './lib';\n// bench {i}"));
        let after = before.replacen(&old, &new, 1);
        std::fs::write(&target, &after).unwrap();
        let id = format!("toolu_bench{i}");
        let ts = format!("2030-01-01T00:00:{:02}.000Z", i % 60);
        append(
            &tp,
            &[
                json!({"type":"assistant","timestamp":ts,"sessionId":sid,"message":{"content":[{"type":"tool_use","id":id,"name":"Edit","input":{"file_path":target,"old_string":old,"new_string":new}}]}}),
                json!({"type":"user","timestamp":ts,"sessionId":sid,"message":{"content":[{"type":"tool_result","tool_use_id":id,"content":"ok"}]},"toolUseResult":{"filePath":target,"oldString":old,"newString":new,"originalFile":before,"structuredPatch":[]}}),
            ],
        );
        let t = Instant::now();
        let w = eng.load_wire(&req(Scope::Pending), rev, false);
        t_edit.push(ms(t));
        kb_edit.push(size(&w));
        let full = w.set.as_ref().map(|s| s.files.iter().filter(|f| matches!(f, coool_core::changes::WireFile::Full(_))).count()).unwrap_or(0);
        if i == 0 {
            println!("  (first edit: {full} file(s) sent in full)");
        }
        rev = w.rev;
    }
    println!("an edit lands, since the last revision: median {:.2} ms, {:.1} KB", med(t_edit), med(kb_edit));

    // The person edits a file by hand (disk only).
    let hand = cwd.join("src/m2/mod2.ts");
    let mut t_hand = Vec::new();
    let mut kb_hand = 0.0;
    for i in 0..rounds {
        let mut s = std::fs::read_to_string(&hand).unwrap();
        s.push_str(&format!("// by hand {i}\n"));
        std::fs::write(&hand, s).unwrap();
        let t = Instant::now();
        let w = eng.load_wire(&req(Scope::Pending), rev, false);
        t_hand.push(ms(t));
        kb_hand = size(&w);
        rev = w.rev;
    }
    println!("a hand edit, since the last revision: median {:.2} ms, {kb_hand:.1} KB", med(t_hand));
    let _ = std::fs::remove_dir_all(state);
}
