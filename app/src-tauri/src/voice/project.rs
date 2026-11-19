//! Words a project uses, offered for the words library when the person asks ("Find words in this project"): package
//! names from package.json and Cargo.toml, the top-level folder and file names, and the local git branch names. Read
//! locally, shown for review, never added on their own and never sent anywhere.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Word {
    pub word: String,
    /// Where it came from: "package.json", "Cargo.toml", "folder", "file", "branch".
    pub from: String,
}

const MAX: usize = 120;

pub fn words(root: &Path) -> Vec<Word> {
    let mut seen: BTreeMap<String, Word> = BTreeMap::new();
    let mut add = |w: &str, from: &str| {
        let w = w.trim().trim_start_matches('@');
        // Names worth teaching: letters in them, not too short or long, not a hidden file or a version.
        if w.len() < 3 || w.len() > 40 || !w.chars().any(|c| c.is_alphabetic()) || w.starts_with('.') {
            return;
        }
        let key = w.to_lowercase();
        seen.entry(key).or_insert_with(|| Word { word: w.to_string(), from: from.to_string() });
    };
    if let Ok(s) = std::fs::read_to_string(root.join("package.json"))
        && let Ok(v) = serde_json::from_str::<serde_json::Value>(&s)
    {
        if let Some(n) = v.get("name").and_then(|n| n.as_str()) {
            add(n, "package.json");
        }
        for k in ["dependencies", "devDependencies"] {
            if let Some(o) = v.get(k).and_then(|d| d.as_object()) {
                for name in o.keys() {
                    // "@tauri-apps/api" → "tauri-apps" and "api" are noise; the scope is the word people say.
                    let n = name.trim_start_matches('@').split('/').next().unwrap_or(name);
                    add(n, "package.json");
                }
            }
        }
    }
    if let Ok(s) = std::fs::read_to_string(root.join("Cargo.toml"))
        && let Ok(v) = s.parse::<toml::Table>()
    {
        if let Some(n) = v.get("package").and_then(|p| p.get("name")).and_then(|n| n.as_str()) {
            add(n, "Cargo.toml");
        }
        for k in ["dependencies", "dev-dependencies"] {
            if let Some(t) = v.get(k).and_then(|d| d.as_table()) {
                for name in t.keys() {
                    add(name, "Cargo.toml");
                }
            }
        }
    }
    if let Ok(rd) = std::fs::read_dir(root) {
        let mut names: Vec<(String, bool)> = rd.filter_map(|e| e.ok()).map(|e| (e.file_name().to_string_lossy().into_owned(), e.path().is_dir())).collect();
        names.sort();
        for (n, dir) in names {
            if matches!(n.as_str(), "node_modules" | "target" | "dist" | "build") {
                continue;
            }
            let stem = if dir { n.as_str() } else { n.rsplit_once('.').map_or(n.as_str(), |(a, _)| a) };
            add(stem, if dir { "folder" } else { "file" });
        }
    }
    // Local branch names, read from .git without running git.
    let heads = root.join(".git/refs/heads");
    let mut stack = vec![heads.clone()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(rel) = p.strip_prefix(&heads) {
                for part in rel.to_string_lossy().split(['/', '-', '_']) {
                    if part.len() >= 4 && !matches!(part, "main" | "master" | "feature" | "worktree" | "agent" | "develop") {
                        add(part, "branch");
                    }
                }
            }
        }
    }
    seen.into_values().take(MAX).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_packages_folders_and_branches() {
        let d = std::env::temp_dir().join(format!("coool-voice-proj-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::create_dir_all(d.join("node_modules/x")).unwrap();
        std::fs::create_dir_all(d.join(".git/refs/heads/feature")).unwrap();
        std::fs::write(d.join(".git/refs/heads/feature/zustand-store"), "x").unwrap();
        std::fs::write(d.join("package.json"), r#"{"name":"harbor","dependencies":{"zustand":"5","@tauri-apps/api":"2"}}"#).unwrap();
        std::fs::write(d.join("Cargo.toml"), "[package]\nname = \"coool-core\"\n[dependencies]\nserde = \"1\"\n").unwrap();
        std::fs::write(d.join("ChatComposer.tsx"), "").unwrap();
        let w: Vec<String> = words(&d).into_iter().map(|w| w.word).collect();
        for want in ["harbor", "zustand", "tauri-apps", "coool-core", "serde", "ChatComposer", "store"] {
            assert!(w.iter().any(|x| x == want), "{want} missing from {w:?}");
        }
        assert!(!w.iter().any(|x| x == "node_modules" || x == "feature"));
        std::fs::remove_dir_all(&d).unwrap();
    }
}
