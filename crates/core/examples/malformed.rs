//! Feeds damaged copies of transcripts to every parser the app runs on them (the session list's loader, the
//! timeline, the context map, titles) and reports any panic. The damage is what real files show: a write cut off
//! mid-line or mid-character, garbage and empty lines, fields of the wrong type, a 4 MB line, deep nesting, a file
//! that vanishes. Reads `<dir>` (a HOME made by app/scripts/perf/make-home.py, or any folder with a
//! `.claude/projects` / `.codex/sessions` tree) and writes damaged copies under a throwaway folder.
//!
//! `cargo run --release -p coool-core --example malformed -- <home> [files]`
use coool_core::model::Provider;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn files(root: &Path, ext: &str, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            files(&p, ext, out);
        } else if p.extension().is_some_and(|x| x == ext) {
            out.push(p);
        }
    }
}

/// Deterministic damage: `k` picks the kind, `seed` the place.
fn damage(lines: &[&str], bytes: &[u8], k: usize, seed: usize) -> Vec<u8> {
    let at = |n: usize| if n == 0 { 0 } else { (seed.wrapping_mul(2654435761)) % n };
    match k % 9 {
        // Cut anywhere (mid-line, mid-UTF-8 sequence).
        0 => bytes[..at(bytes.len())].to_vec(),
        // A line cut in half in the middle of the file.
        1 => {
            let mut v: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
            if !v.is_empty() {
                let i = at(v.len());
                let half = v[i].len() / 2;
                v[i] = String::from_utf8_lossy(&v[i].as_bytes()[..half]).into_owned();
            }
            v.join("\n").into_bytes()
        }
        // Garbage, blank and non-UTF-8 lines.
        2 => {
            let mut v = Vec::new();
            for (i, l) in lines.iter().enumerate() {
                v.extend_from_slice(l.as_bytes());
                v.push(b'\n');
                if i % 7 == 0 {
                    v.extend_from_slice(b"\n   \n{\"type\":\n\xff\xfe\x00garbage\n[]\n42\nnull\n\"str\"\n");
                }
            }
            v
        }
        // Every value of a field swapped for the wrong type.
        3..=6 => {
            let swaps: [&str; 4] = ["null", "42", "\"x\"", "[]"];
            let mut out = Vec::new();
            for l in lines {
                match serde_json::from_str::<serde_json::Value>(l) {
                    Ok(mut v) => {
                        wreck(&mut v, swaps[k % 4], seed);
                        out.extend_from_slice(v.to_string().as_bytes());
                    }
                    Err(_) => out.extend_from_slice(l.as_bytes()),
                }
                out.push(b'\n');
            }
            out
        }
        // A 4 MB line and a deeply nested one.
        7 => {
            let mut v = bytes.to_vec();
            v.extend_from_slice(format!("{{\"type\":\"assistant\",\"message\":{{\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}]}}}}\n", "a".repeat(4 << 20)).as_bytes());
            v.extend_from_slice(format!("{}{}\n", "[".repeat(5000), "]".repeat(5000)).as_bytes());
            v.extend_from_slice(format!("{{\"type\":\"user\",\"message\":{}1{}}}\n", "{\"a\":".repeat(300), "}".repeat(300)).as_bytes());
            v
        }
        // Lines out of order and duplicated.
        _ => {
            let mut v: Vec<&str> = lines.to_vec();
            v.reverse();
            let mut out = v.join("\n");
            out.push('\n');
            out.push_str(&lines.join("\n"));
            out.into_bytes()
        }
    }
}

/// Replaces values deep in the record with `with` (every third field, chosen by `seed`).
fn wreck(v: &mut serde_json::Value, with: &str, seed: usize) {
    let w: serde_json::Value = serde_json::from_str(with).unwrap_or_default();
    let mut n = seed;
    fn walk(v: &mut serde_json::Value, w: &serde_json::Value, n: &mut usize, depth: usize) {
        match v {
            serde_json::Value::Object(m) => {
                for (_, x) in m.iter_mut() {
                    *n += 1;
                    if (*n).is_multiple_of(3) && depth > 0 {
                        *x = w.clone();
                    } else {
                        walk(x, w, n, depth + 1);
                    }
                }
            }
            serde_json::Value::Array(a) => a.iter_mut().for_each(|x| walk(x, w, n, depth + 1)),
            _ => {}
        }
    }
    walk(v, &w, &mut n, 0);
}

fn main() {
    let mut args = std::env::args().skip(1);
    let home = PathBuf::from(args.next().expect("usage: malformed <home> [files]"));
    let limit: usize = args.next().and_then(|a| a.parse().ok()).unwrap_or(40);
    let out = std::env::temp_dir().join(format!("coool-malformed-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    let (mut claude, mut codex) = (Vec::new(), Vec::new());
    files(&home.join(".claude/projects"), "jsonl", &mut claude);
    files(&home.join(".codex/sessions"), "jsonl", &mut codex);
    claude.sort_by_key(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0));
    codex.sort();
    // Small to large, spread over the range.
    let pick = |v: &[PathBuf]| -> Vec<PathBuf> { if v.len() <= limit { v.to_vec() } else { (0..limit).map(|i| v[i * v.len() / limit].clone()).collect() } };
    let mut panics = 0;
    let mut cases = 0;
    let t = Instant::now();
    for (provider, list, dir) in [(Provider::Claude, pick(&claude), ".claude/projects/-perf-malformed"), (Provider::Codex, pick(&codex), ".codex/sessions/2026/01/01")] {
        for (fi, src) in list.iter().enumerate() {
            let bytes = std::fs::read(src).unwrap_or_default();
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let lines: Vec<&str> = text.lines().collect();
            for k in 0..9 {
                cases += 1;
                let d = out.join(dir);
                std::fs::create_dir_all(&d).unwrap();
                let name = if provider == Provider::Claude { format!("{:08}-0000-4000-8000-{:012}.jsonl", fi, k) } else { format!("rollout-2026-01-01T00-00-00-{:08}-0000-4000-8000-{:012}.jsonl", fi, k) };
                let p = d.join(name);
                std::fs::write(&p, damage(&lines, &bytes, k, fi * 31 + k)).unwrap();
                let r = catch_unwind(AssertUnwindSafe(|| {
                    if provider == Provider::Claude {
                        let _ = coool_core::claude::timeline(&p);
                    }
                    let _ = coool_core::context::map_file(&p, provider, "/tmp");
                    let _ = coool_core::context::reported_context(&p, provider);
                }));
                if r.is_err() {
                    panics += 1;
                    eprintln!("PANIC {provider:?} damage {k} on {}", src.display());
                }
            }
        }
    }
    // The session list's own loader over all of it (a HOME of damaged files), twice: cold, then from its cache.
    // SAFETY: single-threaded so far; the Hub's threads start after.
    unsafe { std::env::set_var("HOME", &out) };
    for pass in 0..2 {
        let r = catch_unwind(AssertUnwindSafe(|| {
            let mut hub = coool_core::hub::Hub::with_cache(Duration::from_secs(3600 * 24 * 3650), Some(out.join("cache")));
            hub.set_own_sessions_file(None);
            let deadline = Instant::now() + Duration::from_secs(300);
            let mut all = hub.refresh(false);
            while hub.loading() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
                all = hub.refresh(false);
            }
            let mut titles = coool_core::titles::Titles::at(None);
            for s in &all {
                let _ = titles.resolve(s, false, None);
            }
            all.len()
        }));
        match r {
            Ok(n) => println!("loader pass {pass}: {n} sessions"),
            Err(_) => {
                panics += 1;
                eprintln!("PANIC in the loader, pass {pass}");
            }
        }
    }
    println!("{cases} damaged files, {panics} panics, {:.1}s", t.elapsed().as_secs_f64());
    let _ = std::fs::remove_dir_all(&out);
    if panics > 0 {
        std::process::exit(1);
    }
}
