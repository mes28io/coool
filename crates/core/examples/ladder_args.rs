//! Print the Claude Code launch flags coool adds for Ladder (APP_SPEC "Ladder"), as a JSON array, for a project
//! folder and a tier table. Used by the Ladder A/B benchmark (app/scripts/ladder-ab) so its "on" arm gets exactly what
//! a coool chat gets.
//!
//! ```sh
//! cargo run -q -p coool-core --example ladder_args -- <project> <plugin-root> '<tiers json>' [max_parallel]
//! # tiers json: [{"role":"mid","model":"haiku","label":"Haiku 5.5"}, ...]
//! ```

use coool_core::ladder::{Ladder, Tier, claude_args};
use std::path::Path;

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.len() < 3 {
        eprintln!("usage: ladder_args <project> <plugin-root> '<tiers json>' [max_parallel]");
        std::process::exit(2);
    }
    let tiers: Vec<Tier> = serde_json::from_str(&a[2]).expect("tiers json");
    let max_parallel = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(4);
    let l = Ladder { tiers, max_parallel, verify_tests: true, ..Default::default() };
    let args = claude_args(&l, Path::new(&a[0]), Some(Path::new(&a[1])));
    println!("{}", serde_json::to_string(&args).unwrap());
}
