//! What coool keeps on disk, for Settings > Storage: each folder's size and,
//! for the ones that are safe to drop, a way to clear them.
//!
//! Only coool's own folders are listed and cleared. Clearing never follows a
//! symlink out of the folder and never removes the pilot folder itself, only
//! the matching files inside it.

use serde::Serialize;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How long one folder may take to measure before its size is reported as unknown.
pub const BUDGET: Duration = Duration::from_secs(3);

/// Where coool keeps its files. Any of them may be unknown.
#[derive(Clone, Debug, Default)]
pub struct Paths {
    /// `~/Library/Caches/coool`.
    pub cache: Option<PathBuf>,
    /// The app's local data folder, e.g. `~/Library/Application Support/sh.coool.app`.
    pub data: Option<PathBuf>,
    /// `~/Library/Application Support/coool`.
    pub config: Option<PathBuf>,
}

/// One row on the Storage page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Item {
    pub id: String,
    pub label: String,
    /// One plain line.
    pub desc: String,
    pub path: Option<String>,
    pub bytes: Option<u64>,
    pub files: Option<u64>,
    pub clearable: bool,
    pub clear_label: Option<String>,
}

/// Disk use of a file (allocated blocks, not the apparent length), without following a symlink.
#[cfg(test)]
pub fn file_size(path: &Path) -> Option<u64> {
    fs::symlink_metadata(path).ok().map(|m| m.blocks() * 512)
}

/// Disk use of everything under `path` and the number of files, without
/// following symlinks. None when it can't be read or takes longer than `budget`.
pub fn dir_size(path: &Path, budget: Duration) -> Option<(u64, u64)> {
    let deadline = Instant::now() + budget;
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_dir() {
        return Some((meta.blocks() * 512, 1));
    }
    let (mut bytes, mut files) = (meta.blocks() * 512, 0u64);
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            if Instant::now() >= deadline {
                return None;
            }
            let Ok(m) = fs::symlink_metadata(e.path()) else { continue };
            bytes += m.blocks() * 512;
            if m.is_dir() {
                stack.push(e.path());
            } else {
                files += 1;
            }
        }
    }
    Some((bytes, files))
}

/// Size of a set of files and folders added together. None if any of them couldn't be measured.
fn sum_sizes(paths: &[PathBuf]) -> Option<(u64, u64)> {
    paths.iter().try_fold((0, 0), |(b, f), p| dir_size(p, BUDGET).map(|(pb, pf)| (b + pb, f + pf)))
}

/// Names in `dir` (not following symlinks) that `keep` accepts.
fn entries_matching(dir: &Path, keep: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut v: Vec<PathBuf> = rd.flatten().filter(|e| e.file_name().to_str().is_some_and(&keep)).map(|e| e.path()).collect();
    v.sort();
    v
}

fn is_transcripts(name: &str) -> bool {
    name.starts_with("transcripts-v")
}

/// A pilot decision log: `*.decisions*.jsonl`.
fn is_pilot_log(name: &str) -> bool {
    name.ends_with(".jsonl") && name.contains(".decisions")
}

/// Pilot memory: `*.json`, never a decision log.
fn is_pilot_memory(name: &str) -> bool {
    name.ends_with(".json") && !is_pilot_log(name)
}

/// Only regular files and symlinks (the link itself), never folders.
fn plain_files(v: Vec<PathBuf>) -> Vec<PathBuf> {
    v.into_iter().filter(|p| fs::symlink_metadata(p).is_ok_and(|m| !m.is_dir())).collect()
}

fn item(id: &str, label: &str, desc: &str, path: &Path, size: Option<(u64, u64)>, clear: Option<&str>) -> Item {
    Item {
        id: id.into(),
        label: label.into(),
        desc: desc.into(),
        path: Some(path.display().to_string()),
        bytes: size.map(|s| s.0),
        files: size.map(|s| s.1),
        clearable: clear.is_some(),
        clear_label: clear.map(str::to_string),
    }
}

/// The rows for the Storage page: only folders that exist, except the two pilot rows, which show 0 when empty.
pub fn items(paths: &Paths) -> Vec<Item> {
    let mut v = Vec::new();
    if let Some(cache) = &paths.cache {
        let dirs = entries_matching(cache, is_transcripts);
        if !dirs.is_empty() {
            let desc = "Parsed transcripts, so the sidebar loads fast. Rebuilt from the CLIs' own files.";
            v.push(item("transcripts", "Transcript cache", desc, cache, sum_sizes(&dirs), Some("Clear cache")));
        }
        let web = cache.join("WebKit");
        if web.exists() {
            v.push(item("webcache", "Web view cache", "The app's own web view cache.", &web, dir_size(&web, BUDGET), None));
        }
    }
    if let Some(data) = &paths.data {
        let pilot = data.join("pilot");
        let mem = plain_files(entries_matching(&pilot, is_pilot_memory));
        let desc = "Learned routes and muscle memory for the device pilot.";
        v.push(item("pilot_memory", "Pilot memory", desc, &pilot, sum_sizes(&mem), Some("Forget learned routes")));
        let log = plain_files(entries_matching(&pilot, is_pilot_log));
        let desc = "The pilot's decision log, kept for training.";
        v.push(item("pilot_log", "Pilot decision log", desc, &pilot, sum_sizes(&log), Some("Delete log")));
        let bin = data.join("bin");
        if bin.exists() {
            let desc = "The device helper coool installs into the simulator.";
            v.push(item("helper", "Device helper", desc, &bin, dir_size(&bin, BUDGET), None));
        }
        let vm = data.join("vm");
        if vm.exists() {
            v.push(item("vm", "Mac sandbox", "The Mac sandbox's disk.", &vm, dir_size(&vm, BUDGET), None));
        }
    }
    if let Some(config) = &paths.config
        && config.exists()
    {
        let desc = "Your coool preferences and the list of sessions coool started.";
        v.push(item("settings", "Settings", desc, config, dir_size(config, BUDGET), None));
    }
    v
}

/// Removes a file, a symlink (the link, not its target) or a whole folder tree.
fn remove_entry(p: &Path) -> std::io::Result<()> {
    let m = fs::symlink_metadata(p)?;
    if m.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) }
}

/// Clears one clearable item: `transcripts`, `pilot_memory` or `pilot_log`. Anything else is refused.
pub fn clear(paths: &Paths, id: &str) -> Result<(), String> {
    let targets = match id {
        "transcripts" => entries_matching(paths.cache.as_deref().ok_or("No cache folder")?, is_transcripts),
        "pilot_memory" | "pilot_log" => {
            let pilot = paths.data.as_deref().ok_or("No app data folder")?.join("pilot");
            let keep = if id == "pilot_log" { is_pilot_log } else { is_pilot_memory };
            plain_files(entries_matching(&pilot, keep))
        }
        _ => return Err(format!("\"{id}\" can't be cleared here")),
    };
    for p in targets {
        remove_entry(&p).map_err(|e| format!("Couldn't delete {}: {e}", p.display()))?;
    }
    Ok(())
}

/// A simulator UDID: 36 characters of uppercase hex and dashes.
fn valid_udid(udid: &str) -> bool {
    udid.len() == 36 && udid.chars().all(|c| c == '-' || c.is_ascii_digit() || ('A'..='F').contains(&c))
}

/// Disk use of a simulator device under `home`. None for an invalid UDID or a folder that can't be measured.
pub fn simulator_size_in(home: &Path, udid: &str) -> Option<u64> {
    if !valid_udid(udid) {
        return None;
    }
    dir_size(&home.join("Library/Developer/CoreSimulator/Devices").join(udid), BUDGET).map(|s| s.0)
}

/// Disk use of a simulator device (`~/Library/Developer/CoreSimulator/Devices/<udid>`).
pub fn simulator_size(udid: &str) -> Option<u64> {
    simulator_size_in(&dirs::home_dir()?, udid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("coool-storage-{name}-{}-{:?}", std::process::id(), Instant::now()));
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn write(p: &Path, s: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, s).unwrap();
    }
    fn get<'a>(v: &'a [Item], id: &str) -> Option<&'a Item> {
        v.iter().find(|i| i.id == id)
    }

    #[test]
    fn dir_size_counts_files_and_skips_symlinked_folders() {
        let d = tmp("size");
        write(&d.join("a.txt"), &"x".repeat(10_000));
        write(&d.join("sub/b.txt"), "hello");
        let outside = tmp("outside");
        write(&outside.join("big.bin"), &"y".repeat(100_000));
        std::os::unix::fs::symlink(&outside, d.join("link")).unwrap();
        let (bytes, files) = dir_size(&d, BUDGET).unwrap();
        assert_eq!(files, 3, "two files plus the symlink itself");
        assert!((10_000..100_000).contains(&bytes), "{bytes}");
        assert_eq!(dir_size(&d.join("missing"), BUDGET), None);
        assert!(file_size(&d.join("a.txt")).unwrap() >= 10_000);
        assert_eq!(dir_size(&d, Duration::ZERO), None, "over budget");
    }

    #[test]
    fn items_and_clear() {
        let root = tmp("items");
        let paths = Paths { cache: Some(root.join("cache")), data: Some(root.join("data")), config: Some(root.join("config")) };
        write(&root.join("cache/transcripts-v3/x.json"), "abc");
        write(&root.join("cache/transcripts-v4/y.json"), "abc");
        write(&root.join("cache/other/keep.txt"), "keep");
        write(&root.join("data/pilot/routes.json"), "{}");
        write(&root.join("data/pilot/run.decisions.2026-11.jsonl"), "{}\n");
        write(&root.join("data/vm/disk.img"), "disk");
        write(&root.join("config/prefs.json"), "{}");

        let v = items(&paths);
        let t = get(&v, "transcripts").unwrap();
        assert_eq!(t.files, Some(2));
        assert!(t.clearable && t.clear_label.as_deref() == Some("Clear cache"));
        assert!(get(&v, "webcache").is_none() && get(&v, "helper").is_none(), "missing folders aren't listed");
        assert_eq!(get(&v, "pilot_memory").unwrap().files, Some(1));
        assert_eq!(get(&v, "pilot_log").unwrap().files, Some(1));
        assert!(!get(&v, "vm").unwrap().clearable && !get(&v, "settings").unwrap().clearable);

        assert!(clear(&paths, "vm").is_err() && clear(&paths, "settings").is_err() && clear(&paths, "webcache").is_err());
        assert!(root.join("data/vm/disk.img").exists());

        clear(&paths, "pilot_memory").unwrap();
        assert!(!root.join("data/pilot/routes.json").exists());
        assert!(root.join("data/pilot/run.decisions.2026-11.jsonl").exists(), "memory clear keeps the log");
        write(&root.join("data/pilot/routes.json"), "{}");
        clear(&paths, "pilot_log").unwrap();
        assert!(!root.join("data/pilot/run.decisions.2026-11.jsonl").exists());
        assert!(root.join("data/pilot/routes.json").exists(), "log clear keeps the memory");
        assert!(root.join("data/pilot").is_dir(), "the pilot folder itself stays");

        clear(&paths, "transcripts").unwrap();
        assert!(!root.join("cache/transcripts-v3").exists() && !root.join("cache/transcripts-v4").exists());
        assert!(root.join("cache/other/keep.txt").exists());
        assert!(get(&items(&paths), "transcripts").is_none());
        let empty = Paths { data: Some(root.join("nothing")), ..Default::default() };
        let v = items(&empty);
        assert_eq!(get(&v, "pilot_memory").unwrap().bytes, Some(0), "pilot rows show 0 when absent");
    }

    #[test]
    fn transcripts_clear_removes_a_symlink_not_its_target() {
        let root = tmp("link");
        let target = tmp("link-target");
        write(&target.join("precious.txt"), "keep");
        fs::create_dir_all(root.join("cache")).unwrap();
        std::os::unix::fs::symlink(&target, root.join("cache/transcripts-v9")).unwrap();
        clear(&Paths { cache: Some(root.join("cache")), ..Default::default() }, "transcripts").unwrap();
        assert!(target.join("precious.txt").exists());
        assert!(fs::symlink_metadata(root.join("cache/transcripts-v9")).is_err());
    }

    #[test]
    fn udid_validation() {
        assert!(valid_udid("A1B2C3D4-0000-4111-8222-ABCDEF012345"));
        assert!(!valid_udid("a1b2c3d4-0000-4111-8222-abcdef012345"), "lowercase");
        assert!(!valid_udid("../../../../etc/passwd-aaaaaaaaaaaaaaaa"));
        assert!(!valid_udid("A1B2C3D4"));
        assert_eq!(simulator_size_in(Path::new("/nonexistent"), "../x"), None);
    }
}
