//! Prints the context map of transcripts and checks it against the context
//! size the session list shows. Reads only.
//!
//! `cargo run --release -p coool-core --example context_print -- [--kinds] <claude|codex> <transcript.jsonl>...`
//!
//! `--kinds` prints totals per kind only (no file names), for sharing.
use coool_core::context::{map_file, reported_context, PartKind};
use coool_core::model::Provider;
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Instant;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let kinds = args.first().is_some_and(|a| a == "--kinds");
    if kinds {
        args.remove(0);
    }
    let provider = match args.first().map(String::as_str) {
        Some("codex") => Provider::Codex,
        Some("claude") => Provider::Claude,
        _ => {
            eprintln!("usage: context_print [--kinds] <claude|codex> <file>...");
            std::process::exit(2);
        }
    };
    for f in &args[1..] {
        let p = Path::new(f);
        let t = Instant::now();
        let m = map_file(p, provider, "");
        let took = t.elapsed();
        let reported = reported_context(p, provider);
        let sum: u64 = m.parts.iter().map(|x| x.tokens).sum();
        let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        println!(
            "{} MB, map in {:?}: total {} (reported {}{}), parts sum {}, chars/token {:?}{}",
            size / 1_000_000,
            took,
            m.total,
            reported,
            if m.total == reported { ", equal" } else { ", DIFFERENT" },
            sum,
            m.chars_per_token,
            m.note.as_deref().map(|n| format!(", note: {n}")).unwrap_or_default()
        );
        if let Some(c) = &m.compaction {
            println!("  compaction: {} -> {} (auto {}), before map sums to {}", c.before, c.after, c.auto, c.before_parts.iter().map(|x| x.tokens).sum::<u64>());
        }
        if kinds {
            let mut by: BTreeMap<PartKind, (u64, usize)> = BTreeMap::new();
            for x in &m.parts {
                let e = by.entry(x.kind).or_default();
                e.0 += x.tokens;
                e.1 += 1;
            }
            for (k, (t, n)) in by {
                println!("  {:<9} {:>8} {:>5.1}%  ({n} part{})", format!("{k:?}"), t, 100.0 * t as f64 / m.total.max(1) as f64, if n == 1 { "" } else { "s" });
            }
            let est: u64 = m.parts.iter().filter(|x| !matches!(x.basis, coool_core::context::Basis::Calibrated)).map(|x| x.tokens).sum();
            println!("  not calibrated (estimate or remainder): {:.1}%", 100.0 * est as f64 / m.total.max(1) as f64);
        } else {
            for x in &m.parts {
                let n = if x.count > 1 { format!(" ×{}", x.count) } else { String::new() };
                println!("  {:>8}  {:<9} {}{n}  [{:?}]", x.tokens, format!("{:?}", x.kind), x.label, x.basis);
            }
        }
    }
}
