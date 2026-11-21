//! Print the Claude Code launch flags coool adds for Ladder (APP_SPEC "Ladder"), for a project folder and a tier
//! table or a whole Ladder setup. Used by the Ladder A/B benchmark (app/scripts/ladder-ab) so its "on" arm gets exactly
//! what a coool chat gets.
//!
//! ```sh
//! cargo run -q -p coool-core --example ladder_args -- <project> <plugin-root> '<tiers json>' [max_parallel]
//! # tiers json: [{"role":"mid","model":"haiku","label":"Haiku 5.5"}, ...]  -> a JSON array of flags
//! cargo run -q -p coool-core --example ladder_args -- <project> <plugin-root> '<ladder json>'
//! # ladder json: {"lead":"Sonnet 5.5","tiers":[...],"cross":[...],"image":{...},"depth":2}
//! #   -> {"args":[...],"env":{"CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH":"2"}}
//! ```

use coool_core::ladder::{Ladder, Tier, claude_args, claude_env};
use std::path::Path;

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.len() < 3 {
        eprintln!("usage: ladder_args <project> <plugin-root> '<tiers json | ladder json>' [max_parallel]");
        std::process::exit(2);
    }
    let v: serde_json::Value = serde_json::from_str(&a[2]).expect("json");
    if v.is_object() {
        let l: Ladder = serde_json::from_value(v).expect("ladder json");
        let args = claude_args(&l, Path::new(&a[0]), Some(Path::new(&a[1])));
        let env: serde_json::Map<String, serde_json::Value> = claude_env(&l).into_iter().map(|(k, v)| (k, v.into())).collect();
        println!("{}", serde_json::json!({ "args": args, "env": env }));
        return;
    }
    let tiers: Vec<Tier> = serde_json::from_value(v).expect("tiers json");
    let max_parallel = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(4);
    let l = Ladder { tiers, max_parallel, verify_tests: true, ..Default::default() };
    let args = claude_args(&l, Path::new(&a[0]), Some(Path::new(&a[1])));
    println!("{}", serde_json::to_string(&args).unwrap());
}
