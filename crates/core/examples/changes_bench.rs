//! The Changes engine's cost per call on a case made by app/scripts/perf/make-changes-home.py (docs/PERF.md
//! "Changes view"): a cold load, then warm loads with nothing new, as the app's polling makes them.
//!
//!     cargo run --release -p coool-core --example changes_bench -- <out-of-make-changes-home> [rounds]

use coool_core::changes::record::Kind;
use coool_core::changes::{Changes, Request, Scope, Source};
use std::path::PathBuf;
use std::time::Instant;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let out = PathBuf::from(a.get(1).expect("usage: changes_bench <out> [rounds]")).canonicalize().unwrap();
    let rounds: usize = a.get(2).and_then(|x| x.parse().ok()).unwrap_or(10);
    let cwd = out.join("proj/heavy-app");
    let enc = cwd.to_string_lossy().replace(['/', '.'], "-");
    let proj = out.join("home/.claude/projects").join(enc);
    let sid = "5e55c0de-0000-4000-8000-00000000c0de";
    let sources = vec![
        Source { kind: Kind::Claude, agent: None, path: proj.join(format!("{sid}.jsonl")) },
        Source { kind: Kind::Claude, agent: Some("a0c0ffee00".into()), path: proj.join(sid).join("subagents/agent-a0c0ffee00.jsonl") },
    ];
    let state = std::env::temp_dir().join(format!("coool-changes-bench-{}", std::process::id()));
    let key = format!("claude:{sid}");
    let mut eng = Changes::new(Some(state.clone()));
    for scope in [Scope::Pending, Scope::Chat] {
        let req = Request { key: &key, cwd: &cwd, sources: &sources, scope, external: true };
        let mut times = Vec::new();
        let mut bytes = 0;
        let mut files = 0;
        for i in 0..=rounds {
            let t = Instant::now();
            let cs = eng.load(&req);
            let json = serde_json::to_string(&cs).unwrap();
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            bytes = json.len();
            files = cs.files.len();
            if i == 0 && scope == Scope::Pending {
                println!("cold load ({scope:?}): {ms:.1} ms, {files} files, {} turns", cs.turns.len());
            } else {
                times.push(ms);
            }
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let med = times[times.len() / 2];
        println!("warm load ({scope:?}) x{}: median {med:.1} ms, min {:.1}, max {:.1}; {files} files, payload {:.1} KB", times.len(), times[0], times[times.len() - 1], bytes as f64 / 1024.0);
    }
    let _ = std::fs::remove_dir_all(state);
}
