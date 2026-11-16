//! Lists the artifacts (Claude Code `Artifact` publishes) in one transcript.
//!
//! ```sh
//! cargo run -p coool-core --example artifacts -- ~/.claude/projects/<dir>/<session>.jsonl
//! ```

fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: artifacts <transcript.jsonl>");
        std::process::exit(2);
    };
    let timeline = coool_core::claude::timeline(std::path::Path::new(&path)).unwrap_or_else(|e| {
        eprintln!("{path}: {e}");
        std::process::exit(1);
    });
    for (i, a) in timeline.iter().enumerate() {
        let Some(x) = &a.artifact else { continue };
        let exists = std::path::Path::new(&x.file_path).is_file();
        println!("#{i} {} v{} {:?} icon={:?}", x.url, x.version.map_or("?".into(), |v| v.to_string()), x.title, x.icon);
        println!("    page  {} (local copy {})", x.file_path, if exists { "present" } else { "gone" });
        for (k, v) in &x.files {
            println!("    file  {k} -> {v}");
        }
    }
    let n = timeline.iter().filter(|a| a.artifact.is_some()).count();
    let other = timeline.iter().filter(|a| a.artifact.is_none() && a.text.starts_with("Artifact")).count();
    println!("{n} publishes, {other} other Artifact steps");
}
