use super::*;
use std::fs;

/// A throwaway home: `<tmp>/coool-folders-<n>/home`, removed on drop.
struct T {
    base: PathBuf,
    home: PathBuf,
}

impl T {
    fn new(tag: &str) -> Self {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!("coool-folders-{tag}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("home")).unwrap();
        let base = fs::canonicalize(&base).unwrap();
        Self { home: base.join("home"), base }
    }
    fn dir(&self, rel: &str) -> PathBuf {
        let p = self.home.join(rel);
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn file(&self, rel: &str) {
        let p = self.home.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "x").unwrap();
    }
    /// A folder that looks like a repository to the index (a `.git` folder), without running git.
    fn fake_repo(&self, rel: &str) -> PathBuf {
        let p = self.dir(rel);
        fs::create_dir_all(p.join(".git")).unwrap();
        p
    }
    fn git(&self, dir: &Path, args: &[&str]) {
        let o = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main"])
            .args(args)
            .env("HOME", &self.home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    }
}

impl Drop for T {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn names(h: &[Hit]) -> Vec<String> {
    let mut v: Vec<String> = h.iter().map(|h| h.name.clone()).collect();
    v.sort();
    v
}

fn has_git() -> bool {
    Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success())
}

#[test]
fn guarded_places() {
    let h = Path::new("/Users/p");
    assert_eq!(protected(h, Path::new("/Users/p/Desktop")), Some("Desktop"));
    assert_eq!(protected(h, Path::new("/Users/p/Desktop/a/b")), Some("Desktop"));
    assert_eq!(protected(h, Path::new("/Users/p/Documents/x")), Some("Documents"));
    assert_eq!(protected(h, Path::new("/Users/p/Downloads")), Some("Downloads"));
    assert_eq!(protected(h, Path::new("/Users/p/Library/Mobile Documents/x")), Some("iCloud Drive"));
    assert_eq!(protected(h, Path::new("/Volumes/USB/x")), Some("Volumes"));
    assert_eq!(protected(h, Path::new("/Volumes")), None);
    assert_eq!(protected(h, Path::new("/Users/p/DesktopX")), None);
    assert_eq!(protected(h, Path::new("/Users/p/code/Desktop")), None);
    assert_eq!(protected(h, Path::new("/Users/p")), None);
}

#[test]
fn natural_order() {
    let mut v = vec!["v10", "b", "V2", "a", "v1", "_x", "B2"];
    v.sort_by(|a, b| natural_cmp(a, b));
    assert_eq!(v, ["_x", "a", "b", "B2", "v1", "V2", "v10"]);
}

#[test]
fn listing_shows_folders_counts_files_and_marks_repos() {
    let t = T::new("list");
    let code = t.dir("code");
    t.fake_repo("code/api");
    t.dir("code/notes");
    t.dir("code/.hidden");
    t.dir("code/Thing.app");
    t.file("code/readme.md");
    std::os::unix::fs::symlink(code.join("notes"), code.join("notes-link")).unwrap();
    std::os::unix::fs::symlink(code.join("readme.md"), code.join("file-link")).unwrap();
    let l = list(&code, &t.home, false, false);
    assert!(l.error.is_none());
    assert_eq!(l.entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["api", "notes", "notes-link"]);
    assert!(l.entries[0].repo && !l.entries[1].repo);
    assert!(l.entries[2].link && !l.entries[2].repo);
    // readme, the app bundle and the link to a file.
    assert_eq!(l.files, 3);
    assert_eq!(l.hidden, 1);
    let l = list(&code, &t.home, true, false);
    assert!(l.entries.iter().any(|e| e.name == ".hidden" && e.hidden));
    assert_eq!(l.parent.as_deref(), Some(t.home.to_str().unwrap()));
    // Missing and file paths say so.
    assert_eq!(list(&code.join("nope"), &t.home, false, false).error.as_deref(), Some("This folder doesn't exist"));
    assert!(list(&code.join("readme.md"), &t.home, false, false).error.is_some());
}

#[test]
fn guarded_places_are_not_listed_until_asked() {
    let t = T::new("gate");
    t.dir("Desktop/proj");
    let l = list(&t.home.join("Desktop"), &t.home, false, false);
    assert!(l.gated && l.entries.is_empty() && l.protected.as_deref() == Some("Desktop"));
    let l = list(&t.home.join("Desktop"), &t.home, false, true);
    assert!(!l.gated && l.entries.len() == 1);
    assert!(complete("~/Desktop/p", &t.home, false).gated);
    assert_eq!(complete("~/Desktop/p", &t.home, true).completed.as_deref(), Some("~/Desktop/proj/"));
    let s = summary(&t.home.join("Desktop/proj"), &t.home, Provider::Claude, false);
    assert!(s.gated && !s.exists && s.git.is_none() && s.context.is_none());
}

#[test]
fn index_depth_limit_ignore_rules_and_no_descent_into_repos() {
    let t = T::new("index");
    t.fake_repo("code/a/repo1");
    t.fake_repo("code/a/b/repo2");
    t.fake_repo("code/a/b/c/repo3");
    t.fake_repo("code/a/b/c/d/repo4"); // 5 deep below code: past repo_depth 4
    t.fake_repo("code/repo0");
    t.fake_repo("code/repo0/nested"); // inside a repository: not walked
    t.fake_repo("code/node_modules/dep");
    t.fake_repo("code/x/target/gen");
    t.fake_repo("code/.cache/r");
    t.fake_repo("Library/Mine");
    t.fake_repo("Desktop/secret");
    t.dir("notes");
    t.dir("Pictures/p");
    let roots = default_roots(&t.home);
    assert_eq!(roots.len(), 2, "{roots:?}");
    let hits = scan(&roots, &t.home, Limits::default());
    let repos: Vec<String> = names(&hits.iter().filter(|h| h.repo).cloned().collect::<Vec<_>>());
    assert_eq!(repos, ["repo0", "repo1", "repo2", "repo3"]);
    let all = names(&hits);
    // Home's own folders (1 deep) and the code folders 2 deep by name; ignored and guarded ones never.
    for want in ["code", "notes", "a", "x", "b"] {
        assert!(all.contains(&want.to_string()), "{want} missing from {all:?}");
    }
    for never in ["Library", "Desktop", "Pictures", "node_modules", "dep", "target", "gen", ".cache", "nested", "secret", "Mine", "repo4", "c", "d"] {
        assert!(!all.contains(&never.to_string()), "{never} in {all:?}");
    }
    // The visit budget stops early and keeps what it found.
    let few = scan(&roots, &t.home, Limits { max_dirs: 1, deadline: Duration::from_secs(5) });
    assert!(few.len() < hits.len() && few.iter().all(|h| Path::new(&h.path).parent() == Some(t.home.as_path())));
}

#[test]
fn index_cache_answers_at_once_and_rescans_only_when_stale_or_forced() {
    let t = T::new("cache");
    t.fake_repo("code/one");
    let file = t.base.join("cache/folders.json");
    let idx = Arc::new(Index::new(Some(file.clone()), Duration::from_secs(600), Limits::default()));
    let roots = default_roots(&t.home);
    let wait = |idx: &Arc<Index>, n: u32| {
        let start = Instant::now();
        while idx.scans() < n {
            assert!(start.elapsed() < Duration::from_secs(10), "scan didn't finish");
            std::thread::sleep(Duration::from_millis(5));
        }
    };
    let v = idx.get(roots.clone(), &t.home, false);
    assert!(v.hits.is_empty() && v.scanning && v.at_ms == 0, "the first answer is immediate and empty");
    wait(&idx, 1);
    let v = idx.get(roots.clone(), &t.home, false);
    assert!(!v.scanning && v.hits.iter().any(|h| h.name == "one"));
    // A new repository isn't seen until the cache is stale or a refresh is forced.
    t.fake_repo("code/two");
    let v = idx.get(roots.clone(), &t.home, false);
    assert_eq!(idx.scans(), 1);
    assert!(!v.hits.iter().any(|h| h.name == "two"));
    let v = idx.get(roots.clone(), &t.home, true);
    assert!(v.scanning);
    wait(&idx, 2);
    assert!(idx.get(roots.clone(), &t.home, false).hits.iter().any(|h| h.name == "two"));
    // Other roots count as stale.
    let mut more = roots.clone();
    more.push(Root { path: t.dir("elsewhere"), depth: 1, repo_depth: 2 });
    assert!(idx.get(more, &t.home, false).scanning);
    wait(&idx, 3);
    // The next launch starts from the file.
    let again = Arc::new(Index::new(Some(file), Duration::from_secs(600), Limits::default()));
    assert!(again.st.lock().unwrap().saved.hits.iter().any(|h| h.name == "two"));
    // A zero TTL rescans on every ask.
    let eager = Arc::new(Index::new(None, Duration::ZERO, Limits::default()));
    eager.run(roots.clone(), &t.home);
    std::thread::sleep(Duration::from_millis(5));
    assert!(eager.get(roots, &t.home, false).scanning);
}

#[test]
fn completion() {
    let t = T::new("complete");
    t.dir("code/atlas-api");
    t.dir("code/Atlas-web");
    t.dir("code/pixelforge");
    t.dir("code/.secret");
    t.file("code/apple.txt");
    let c = |s: &str| complete(s, &t.home, false);
    assert_eq!(c("~/co").completed.as_deref(), Some("~/code/"));
    assert_eq!(c("~/code/pix").completed.as_deref(), Some("~/code/pixelforge/"));
    // Two matches: their common start (case-insensitive), both listed; files never.
    let a = c("~/code/a");
    assert_eq!(a.completed.as_deref(), Some("~/code/atlas-"));
    assert_eq!(a.matches, ["atlas-api", "Atlas-web"]);
    assert_eq!(c("~/code/atlas-").completed, None);
    assert_eq!(c("~/code/").matches, ["atlas-api", "Atlas-web", "pixelforge"]);
    assert_eq!(c("~/code/.s").completed.as_deref(), Some("~/code/.secret/"));
    assert!(c("~/code/zzz").matches.is_empty());
    assert_eq!(c("~").completed.as_deref(), Some("~/"));
    let abs = format!("{}/code/pi", t.home.display());
    assert_eq!(c(&abs).completed, Some(format!("{}/code/pixelforge/", t.home.display())));
    assert_eq!(c("relative"), Completion::default());
}

#[test]
fn creating_folders() {
    let t = T::new("create");
    let code = t.dir("code");
    let p = create(&code, " new-app ", &t.home).unwrap();
    assert_eq!(p, code.join("new-app"));
    assert!(p.is_dir());
    // Never over anything.
    assert!(create(&code, "new-app", &t.home).unwrap_err().contains("already exists"));
    t.file("code/file");
    assert!(create(&code, "file", &t.home).unwrap_err().contains("already exists"));
    std::os::unix::fs::symlink("/nonexistent-target", code.join("dangling")).unwrap();
    assert!(create(&code, "dangling", &t.home).unwrap_err().contains("already exists"));
    // Names.
    for bad in ["", "  ", ".", "..", "a/b", "a:b", "x\0y"] {
        assert!(create(&code, bad, &t.home).is_err(), "{bad:?}");
    }
    assert!(create(&code, &"n".repeat(256), &t.home).is_err());
    // Only inside home, not in Library or the Trash, not through a link out of home.
    let outside = t.base.join("outside");
    fs::create_dir_all(&outside).unwrap();
    assert!(create(&outside, "x", &t.home).unwrap_err().contains("home folder"));
    assert!(!outside.join("x").exists());
    std::os::unix::fs::symlink(&outside, t.home.join("out-link")).unwrap();
    assert!(create(&t.home.join("out-link"), "x", &t.home).unwrap_err().contains("home folder"));
    assert!(create(&t.dir("Library/App"), "x", &t.home).is_err());
    assert!(create(&t.dir(".Trash"), "x", &t.home).is_err());
    assert!(create(&code.join("missing"), "x", &t.home).is_err());
    assert!(create(&t.home, "top", &t.home).is_ok());
}

#[test]
fn git_init_and_summary() {
    if !has_git() {
        return;
    }
    let t = T::new("summary");
    let code = t.dir("code");
    let p = create(&code, "fresh", &t.home).unwrap();
    git_init(&p).unwrap();
    assert!(is_repo(&p));
    assert!(git_init(&p).is_err(), "never twice");

    // A fresh repository: no commits, nothing changed.
    let s = summary(&p, &t.home, Provider::Claude, false);
    assert!(s.exists && s.is_dir && s.inside_home && s.writable && !s.gated);
    let g = s.git.clone().unwrap();
    assert!(g.at_root && g.last.is_none() && g.changes == Some(0), "{g:?}");

    // A project with a commit, changes, instructions, a skill and a stack.
    let r = t.dir("code/api");
    t.git(&r, &["init", "-q"]);
    t.file("code/api/Cargo.toml");
    t.file("code/api/package.json");
    t.file("code/api/src/main.rs");
    fs::write(r.join("CLAUDE.md"), "# api\nUse cargo test.\n").unwrap();
    t.git(&r, &["add", "-A"]);
    t.git(&r, &["commit", "-qm", "First commit"]);
    t.git(&r, &["checkout", "-qb", "feature"]);
    t.file("code/api/new.txt");
    fs::write(r.join("Cargo.toml"), "changed").unwrap();
    t.file("code/api/.claude/skills/deploy/SKILL.md");
    fs::write(r.join("AGENTS.md"), "# agents\n").unwrap();
    t.file(".claude/CLAUDE.md");
    let s = summary(&r, &t.home, Provider::Claude, false);
    let g = s.git.clone().unwrap();
    assert_eq!(g.branch.as_deref(), Some("feature"));
    assert_eq!(g.changes, Some(4), "new.txt, Cargo.toml, .claude/, AGENTS.md: {g:?}");
    let last = g.last.unwrap();
    assert_eq!(last.subject, "First commit");
    assert!(last.when_ms > 0 && last.short.len() >= 7);
    assert_eq!(s.stack, ["Rust", "Node"]);
    assert_eq!((s.folders, s.files), (1, 5));
    let c = s.context.clone().unwrap();
    assert_eq!(c.project.iter().map(|f| f.label.as_str()).collect::<Vec<_>>(), ["~/code/api/CLAUDE.md"], "{c:?}");
    assert_eq!(c.project[0].source, "Project");
    assert_eq!(c.user, 1);
    assert_eq!((c.skills, c.project_skills), (1, 1));
    assert!(c.tokens > 0);
    // Codex reads AGENTS.md there instead.
    let cx = summary(&r, &t.home, Provider::Codex, false).context.unwrap();
    assert!(cx.project.iter().any(|f| f.label.contains("AGENTS.md")), "{cx:?}");

    // A folder inside the repository.
    let s = summary(&r.join("src"), &t.home, Provider::Claude, false);
    assert!(!s.git.unwrap().at_root);
    // Not a repository; missing; a file.
    let s = summary(&code, &t.home, Provider::Claude, false);
    assert!(s.git.is_none() && s.exists);
    let s = summary(&code.join("missing"), &t.home, Provider::Claude, false);
    assert!(!s.exists && s.git.is_none() && s.inside_home);
    let s = summary(&r.join("Cargo.toml"), &t.home, Provider::Claude, false);
    assert!(s.exists && !s.is_dir);
    let s = summary(Path::new("/"), &t.home, Provider::Claude, false);
    assert!(!s.inside_home);
}

#[test]
fn status_parse() {
    let out = "# branch.oid (initial)\n# branch.head main\n? a\n";
    assert_eq!(parse_status(out), (Some("main".into()), false, 1));
    let out = "# branch.oid 0123\n# branch.head (detached)\n1 .M N... 100644 100644 100644 a a a\n";
    assert_eq!(parse_status(out), (None, true, 1));
}
