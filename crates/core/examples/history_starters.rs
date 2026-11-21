//! Who started the sessions on this Mac, by History's rule (`origin::started_by`): counts only, never a title, a
//! path or a word of a transcript. The index is built in memory (nothing is written; `~/.claude`, `~/.codex` and
//! coool's own-sessions file are only read).
//!
//!     cargo run -p coool-core --release --example history_starters

use coool_core::history::{History, Options, Query, Starter, Where};
use coool_core::model::Provider;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

fn main() {
    let home = dirs::home_dir().expect("home");
    let opts = Options::for_home(&home, None);
    let mut h = History::open(opts);
    let t0 = Instant::now();
    h.request_scan();
    while h.step(Duration::from_secs(2)) {}
    let none = |_: Provider, _: &str| None;
    let mut by: BTreeMap<String, usize> = BTreeMap::new();
    let mut nested = 0usize;
    let mut offset = 0;
    loop {
        let p = h.query(&Query { agents: true, offset, limit: 1000, ..Query::default() }, &none, None);
        for r in &p.rows {
            *by.entry(format!("{:?} {:?} {:?}", r.by, r.provider, r.place)).or_default() += 1;
            for x in &r.helpers {
                nested += 1;
                *by.entry(format!("Agent(nested) {:?} {:?}", x.provider, x.place)).or_default() += 1;
            }
        }
        offset += p.rows.len();
        if p.rows.is_empty() || offset >= p.total {
            break;
        }
    }
    let st = h.status();
    let def = h.query(&Query { limit: 1, ..Query::default() }, &none, None);
    println!("indexed in {:.1} s: {} transcripts", t0.elapsed().as_secs_f64(), st.transcripts);
    println!("listed by default (person + unknown): {}  started by agents: {}  (nested under their session: {nested})", st.sessions, st.agents);
    println!("default query total {}  agents counted {}", def.total, def.agents);
    for (k, n) in by {
        println!("  {k}: {n}");
    }
    let _ = (Starter::Person, Where::Coool);
}
