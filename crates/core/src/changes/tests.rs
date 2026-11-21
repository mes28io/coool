//! The engine end to end on scratch folders (/tmp/coool-changes-unit-*): transcripts written as the CLIs write
//! them, the files changed on disk the same way, then load / undo / keep as the app calls them.

use super::*;
use serde_json::json;
use std::io::Write as _;
use std::process::Command;

struct T {
    dir: PathBuf,
    trash: PathBuf,
    transcript: PathBuf,
    sources: Vec<Source>,
    eng: Changes,
    n: usize,
    second: u64,
    key: String,
}

fn lines(n: usize) -> String {
    (1..=n).map(|i| format!("line {i}\n")).collect()
}

impl T {
    fn new(name: &str, kind: Kind) -> T {
        let base = PathBuf::from(format!("/tmp/coool-changes-unit-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("work");
        let trash = base.join("trash");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&trash).unwrap();
        let dir = dir.canonicalize().unwrap();
        let transcript = base.join("t.jsonl");
        std::fs::write(&transcript, "").unwrap();
        let sources = vec![Source { kind, agent: None, path: transcript.clone() }];
        T { dir, trash, transcript, sources, eng: Changes::new(Some(base.join("state"))), n: 0, second: 0, key: format!("test:{name}") }
    }

    fn p(&self, rel: &str) -> PathBuf {
        self.dir.join(rel)
    }

    fn ts(&mut self) -> String {
        self.second += 1;
        format!("2026-11-20T10:{:02}:{:02}Z", self.second / 60, self.second % 60)
    }

    fn line(&mut self, v: serde_json::Value) {
        let mut f = std::fs::OpenOptions::new().append(true).open(&self.transcript).unwrap();
        writeln!(f, "{v}").unwrap();
    }

    fn prompt(&mut self, text: &str) {
        let ts = self.ts();
        self.line(json!({"type":"user","timestamp":ts,"message":{"role":"user","content":text}}));
    }

    /// A Claude Edit, applied on disk and recorded as the CLI does.
    fn edit(&mut self, rel: &str, old: &str, new: &str) {
        let p = self.p(rel);
        let before = std::fs::read_to_string(&p).unwrap();
        assert!(before.contains(old), "{old:?} not in {rel}");
        std::fs::write(&p, before.replacen(old, new, 1)).unwrap();
        self.n += 1;
        let id = format!("toolu_{}", self.n);
        let (t1, t2) = (self.ts(), self.ts());
        self.line(json!({"type":"assistant","timestamp":t1,"message":{"content":[{"type":"tool_use","id":id,"name":"Edit","input":{"file_path":p,"old_string":old,"new_string":new}}]}}));
        self.line(json!({"type":"user","timestamp":t2,"message":{"content":[{"type":"tool_result","tool_use_id":id,"content":"ok"}]},"toolUseResult":{"filePath":p,"oldString":old,"newString":new,"originalFile":before,"structuredPatch":[]}}));
    }

    /// A Claude Write.
    fn write(&mut self, rel: &str, content: &str) {
        let p = self.p(rel);
        let before = std::fs::read_to_string(&p).ok();
        std::fs::write(&p, content).unwrap();
        self.n += 1;
        let id = format!("toolu_{}", self.n);
        let (t1, t2) = (self.ts(), self.ts());
        self.line(json!({"type":"assistant","timestamp":t1,"message":{"content":[{"type":"tool_use","id":id,"name":"Write","input":{"file_path":p,"content":content}}]}}));
        let r = match &before {
            None => json!({"type":"create","filePath":p,"content":content,"originalFile":null}),
            Some(b) => json!({"type":"update","filePath":p,"content":content,"originalFile":b}),
        };
        self.line(json!({"type":"user","timestamp":t2,"message":{"content":[{"type":"tool_result","tool_use_id":id,"content":"ok"}]},"toolUseResult":r}));
    }

    fn said(&mut self, text: &str) {
        let ts = self.ts();
        self.line(json!({"type":"assistant","timestamp":ts,"message":{"content":[{"type":"text","text":text}]}}));
    }

    /// A Codex apply_patch call that succeeded (the patch is applied on disk by the caller).
    fn patch(&mut self, patch: &str) {
        self.n += 1;
        let id = format!("call_{}", self.n);
        let (t1, t2) = (self.ts(), self.ts());
        self.line(json!({"timestamp":t1,"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":id,"input":patch}}));
        self.line(json!({"timestamp":t2,"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":id,"output":"Success. Updated the following files"}}));
    }

    fn codex_prompt(&mut self, text: &str) {
        let ts = self.ts();
        self.line(json!({"timestamp":ts,"type":"event_msg","payload":{"type":"user_message","message":text}}));
    }

    fn load(&mut self, scope: Scope) -> ChangeSet {
        let (key, dir, sources) = (self.key.clone(), self.dir.clone(), self.sources.clone());
        self.eng.load(&Request { key: &key, cwd: &dir, sources: &sources, scope, external: false })
    }

    fn file(&mut self, scope: Scope, rel: &str) -> Option<FileChange> {
        self.load(scope).files.into_iter().find(|f| f.rel == rel)
    }

    fn undo(&mut self, scope: Scope, rel: Option<&str>, hunk: Option<&str>, force: bool) -> Outcome {
        self.undo_ext(scope, rel, hunk, force, false)
    }

    fn undo_ext(&mut self, scope: Scope, rel: Option<&str>, hunk: Option<&str>, force: bool, external: bool) -> Outcome {
        let (key, dir, sources, trash) = (self.key.clone(), self.dir.clone(), self.sources.clone(), self.trash.clone());
        let path = rel.map(|r| dir.join(r).to_string_lossy().into_owned());
        let tr = move |p: &Path| -> Result<()> {
            let name = format!("{}-{}", now_ms(), p.file_name().unwrap().to_string_lossy());
            std::fs::rename(p, trash.join(name))?;
            Ok(())
        };
        self.eng.undo(&Request { key: &key, cwd: &dir, sources: &sources, scope, external }, path.as_deref(), hunk, force, &tr)
    }

    fn keep(&mut self, scope: Scope, rel: Option<&str>, hunk: Option<&str>, stage: bool) -> Outcome {
        let (key, dir, sources) = (self.key.clone(), self.dir.clone(), self.sources.clone());
        let path = rel.map(|r| dir.join(r).to_string_lossy().into_owned());
        self.eng.keep(&Request { key: &key, cwd: &dir, sources: &sources, scope, external: false }, path.as_deref(), hunk, stage, false)
    }

    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.p(rel)).unwrap()
    }

    fn trashed(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(&self.trash).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    fn git(&self, args: &[&str]) -> String {
        let o = Command::new("git").arg("-C").arg(&self.dir).args(args).env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t").output().unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    fn git_init(&self) {
        self.git(&["init", "-q", "-b", "main"]);
        self.git(&["config", "user.name", "t"]);
        self.git(&["config", "user.email", "t@t"]);
        self.git(&["config", "commit.gpgsign", "false"]);
    }
}

impl Drop for T {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.dir.parent().unwrap());
    }
}

/// Two edits far apart in one file, an edit to another, a new file: then undo a hunk, keep a file, undo the new
/// file, edit by hand and see the undo refused, then forced.
#[test]
fn claude_review_flow() {
    let mut t = T::new("flow", Kind::Claude);
    std::fs::write(t.p("a.txt"), lines(40)).unwrap();
    std::fs::write(t.p("b.txt"), "alpha\nbeta\n").unwrap();
    t.prompt("Tidy the files");
    t.edit("a.txt", "line 2\n", "line two\n");
    t.edit("a.txt", "line 30\n", "line thirty\n");
    t.edit("b.txt", "beta", "BETA");
    t.write("new.txt", "brand new\n");
    t.said("Renamed two lines and added new.txt.");

    let cs = t.load(Scope::Chat);
    assert_eq!(cs.turns.len(), 1);
    assert_eq!(cs.turns[0].files, 3);
    assert_eq!(cs.total, 3);
    assert_eq!(cs.pending, 3);
    let a = cs.files.iter().find(|f| f.rel == "a.txt").unwrap();
    assert_eq!((a.status, a.added, a.removed, a.hunks.len()), ("modified", 2, 2, 2));
    assert!(!a.diverged && a.blocked.is_none());
    assert_eq!(a.line, 2);
    let n = cs.files.iter().find(|f| f.rel == "new.txt").unwrap();
    assert_eq!(n.status, "added");
    assert_eq!(n.said.as_deref(), Some("Renamed two lines and added new.txt."));

    // Undo the second hunk of a.txt only.
    let h2 = a.hunks[1].id.clone();
    let o = t.undo(Scope::Chat, Some("a.txt"), Some(&h2), false);
    assert!(o.ok, "{o:?}");
    let txt = t.read("a.txt");
    assert!(txt.contains("line two\n") && txt.contains("line 30\n") && !txt.contains("thirty"));
    assert_eq!(t.file(Scope::Chat, "a.txt").unwrap().hunks.len(), 1);
    // coool's own undo is not "edited since".
    assert!(!t.file(Scope::Chat, "a.txt").unwrap().diverged);

    // Keep b.txt: it leaves the pending view, stays in the chat view as kept.
    let o = t.keep(Scope::Chat, Some("b.txt"), None, false);
    assert!(o.ok, "{o:?}");
    assert!(t.file(Scope::Pending, "b.txt").is_none());
    assert!(t.file(Scope::Chat, "b.txt").unwrap().kept);
    assert_eq!(t.load(Scope::Chat).pending, 2);

    // Undo the new file: to the Trash.
    let o = t.undo(Scope::Chat, Some("new.txt"), None, false);
    assert!(o.ok, "{o:?}");
    assert!(!t.p("new.txt").exists());
    assert_eq!(t.trashed().len(), 1);
    let n = t.file(Scope::Chat, "new.txt").unwrap();
    assert_eq!(n.status, "undone");
    assert!(n.undone_at.is_some());
    assert!(t.file(Scope::Pending, "new.txt").is_none(), "an undone file has nothing left to review");

    // Edit a.txt by hand in the agent's lines: undo is refused with a question.
    let txt = t.read("a.txt").replace("line two\n", "line two, and mine\n");
    std::fs::write(t.p("a.txt"), &txt).unwrap();
    let a = t.file(Scope::Chat, "a.txt").unwrap();
    assert!(a.diverged);
    assert!(a.hunks[0].since);
    let o = t.undo(Scope::Chat, Some("a.txt"), None, false);
    assert!(!o.ok);
    assert!(o.ask.as_deref().unwrap().contains("after the agent did (around line 2)"), "{o:?}");
    assert_eq!(t.read("a.txt"), txt, "nothing written");
    let o = t.undo(Scope::Chat, Some("a.txt"), Some(&a.hunks[0].id), false);
    assert!(o.ask.is_some());
    // Anyway: the person's version goes to the Trash first.
    let o = t.undo(Scope::Chat, Some("a.txt"), None, true);
    assert!(o.ok, "{o:?}");
    assert_eq!(t.read("a.txt"), lines(40));
    assert!(t.trashed().iter().any(|n| n.contains("a.txt (before undo)")));
}

/// A hand edit elsewhere in the file: the file undo takes out the agent's change and keeps the person's.
#[test]
fn undo_keeps_the_persons_edits_elsewhere() {
    let mut t = T::new("threeway", Kind::Claude);
    std::fs::write(t.p("a.txt"), lines(40)).unwrap();
    t.prompt("x");
    t.edit("a.txt", "line 3\n", "line three\n");
    let mine = t.read("a.txt").replace("line 35\n", "line 35, mine\n");
    std::fs::write(t.p("a.txt"), &mine).unwrap();
    let a = t.file(Scope::Chat, "a.txt").unwrap();
    assert!(a.diverged);
    assert_eq!(a.hunks.len(), 2);
    assert!(!a.hunks[0].since && a.hunks[1].since);
    let o = t.undo(Scope::Chat, Some("a.txt"), None, false);
    assert!(o.ok, "{o:?}");
    assert!(o.message.contains("were kept"));
    assert_eq!(t.read("a.txt"), lines(40).replace("line 35\n", "line 35, mine\n"));
}

#[test]
fn turns_and_pending() {
    let mut t = T::new("turns", Kind::Claude);
    std::fs::write(t.p("a.txt"), lines(40)).unwrap();
    t.prompt("first");
    t.edit("a.txt", "line 5\n", "line five\n");
    t.prompt("second");
    t.edit("a.txt", "line 25\n", "line twentyfive\n");
    let cs = t.load(Scope::Chat);
    assert_eq!(cs.turns.len(), 2);
    assert_eq!(cs.turns[1].prompt, "second");
    let t1 = t.file(Scope::Turn(1), "a.txt").unwrap();
    assert_eq!(t1.hunks.len(), 1);
    assert!(t1.hunks[0].lines.iter().any(|l| l.t == "line five"));
    // Keep turn 1: the pending view starts after it.
    t.keep(Scope::Turn(1), Some("a.txt"), None, false);
    let p = t.file(Scope::Pending, "a.txt").unwrap();
    assert_eq!(p.hunks.len(), 1);
    assert!(p.hunks[0].lines.iter().any(|l| l.t == "line twentyfive"));
    assert!(!p.hunks[0].lines.iter().any(|l| l.t == "line five"));
    // Undo turn 1 alone: turn 2's change stays.
    let o = t.undo(Scope::Turn(1), Some("a.txt"), None, false);
    assert!(o.ok, "{o:?}");
    let txt = t.read("a.txt");
    assert!(txt.contains("line 5\n") && txt.contains("line twentyfive\n"));
    // Turn 2 over the same line as turn 3: turn 2 can't be undone on its own any more.
    t.prompt("third");
    t.edit("a.txt", "line twentyfive\n", "line 25!\n");
    let t2 = t.file(Scope::Turn(2), "a.txt").unwrap();
    assert!(t2.hunks[0].blocked.is_some());
    let o = t.undo(Scope::Turn(2), Some("a.txt"), None, false);
    assert!(!o.ok && o.refused[0].1.contains("changed after that turn"), "{o:?}");
}

#[test]
fn reedit_after_undo_is_flagged_until_told() {
    let mut t = T::new("reedit", Kind::Claude);
    std::fs::write(t.p("a.txt"), "x\n").unwrap();
    t.prompt("p");
    t.edit("a.txt", "x", "y");
    assert!(t.undo(Scope::Chat, Some("a.txt"), None, false).ok);
    assert_eq!(t.read("a.txt"), "x\n");
    assert!(!t.file(Scope::Chat, "a.txt").map(|f| f.reedited).unwrap_or(false));
    t.edit("a.txt", "x", "z");
    let f = t.file(Scope::Chat, "a.txt").unwrap();
    assert!(f.reedited);
    let key = t.key.clone();
    t.eng.mark_told(&key, std::slice::from_ref(&f.path));
    assert!(!t.file(Scope::Chat, "a.txt").unwrap().reedited);
}

#[test]
fn busy_and_outside_are_blocked() {
    let mut t = T::new("busy", Kind::Claude);
    std::fs::write(t.p("a.txt"), "x\n").unwrap();
    t.prompt("p");
    t.edit("a.txt", "x", "y");
    // An edit call without its result: the agent is in the middle of it.
    let p = t.p("a.txt");
    t.line(json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"open1","name":"Edit","input":{"file_path":p,"old_string":"y","new_string":"w"}}]}}));
    let f = t.file(Scope::Chat, "a.txt").unwrap();
    assert!(f.busy && f.blocked.as_deref().unwrap().contains("right now"));
    assert!(!t.undo(Scope::Chat, Some("a.txt"), None, false).ok);
    assert_eq!(t.read("a.txt"), "y\n");

    // A file outside the chat's folder: shown, never written.
    let outside = t.dir.parent().unwrap().join("outside.txt");
    std::fs::write(&outside, "o\n").unwrap();
    t.n += 1;
    let (t1, t2) = (t.ts(), t.ts());
    t.line(json!({"type":"assistant","timestamp":t1,"message":{"content":[{"type":"tool_use","id":"out1","name":"Write","input":{"file_path":outside,"content":"O\n"}}]}}));
    std::fs::write(&outside, "O\n").unwrap();
    t.line(json!({"type":"user","timestamp":t2,"message":{"content":[{"type":"tool_result","tool_use_id":"out1","content":"ok"}]},"toolUseResult":{"type":"update","filePath":outside,"content":"O\n","originalFile":"o\n"}}));
    let f = t.load(Scope::Chat).files.into_iter().find(|f| f.path.ends_with("outside.txt")).unwrap();
    assert!(f.blocked.as_deref().unwrap().contains("Outside"));
    let path = f.path.clone();
    let (key, dir, sources) = (t.key.clone(), t.dir.clone(), t.sources.clone());
    let o = t.eng.undo(&Request { key: &key, cwd: &dir, sources: &sources, scope: Scope::Chat, external: false }, Some(&path), None, false, &|_| Ok(()));
    assert!(!o.ok);
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "O\n");
}

#[test]
fn safe_targets() {
    let t = T::new("safe", Kind::Claude);
    let root = t.dir.clone();
    assert!(safe_target(&root, &root.join("a/b/new.txt")).is_ok());
    assert!(safe_target(&root, &root.join("../x")).is_err());
    assert!(safe_target(&root, Path::new("relative")).is_err());
    // A link to a folder outside: refused.
    let out = root.parent().unwrap().join("elsewhere");
    std::fs::create_dir_all(&out).unwrap();
    std::os::unix::fs::symlink(&out, root.join("link")).unwrap();
    assert!(safe_target(&root, &root.join("link/f.txt")).is_err());
    // A file that is a link: refused.
    std::fs::write(out.join("f"), "x").unwrap();
    std::os::unix::fs::symlink(out.join("f"), root.join("filelink")).unwrap();
    assert!(safe_target(&root, &root.join("filelink")).is_err());
}

#[test]
fn atomic_write_keeps_mode() {
    let t = T::new("atomic", Kind::Claude);
    let p = t.p("x.sh");
    std::fs::write(&p, "old").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    write_atomic(&p, b"new").unwrap();
    assert_eq!(std::fs::read_to_string(&p).unwrap(), "new");
    assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o755);
    assert_eq!(std::fs::read_dir(&t.dir).unwrap().count(), 1, "no temporary file left");
}

#[test]
fn codex_patches_reconstruct_and_undo() {
    let mut t = T::new("codex", Kind::Codex);
    std::fs::write(t.p("a.txt"), "one\ntwo\nthree\n").unwrap();
    std::fs::write(t.p("old.txt"), "keep me\nrename me\n").unwrap();
    t.codex_prompt("change things");
    // As Codex applies it.
    std::fs::write(t.p("a.txt"), "one\n2\nthree\n").unwrap();
    std::fs::write(t.p("n.txt"), "hi\n").unwrap();
    let pa = t.p("a.txt").to_string_lossy().into_owned();
    let pn = t.p("n.txt").to_string_lossy().into_owned();
    t.patch(&format!("*** Begin Patch\n*** Update File: {pa}\n@@\n one\n-two\n+2\n three\n*** Add File: {pn}\n+hi\n*** End Patch"));
    // A move with an edit.
    std::fs::remove_file(t.p("old.txt")).unwrap();
    std::fs::write(t.p("new.txt"), "keep me\nrenamed\n").unwrap();
    t.patch("*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n keep me\n-rename me\n+renamed\n*** End Patch");
    let cs = t.load(Scope::Chat);
    assert_eq!(cs.turns.len(), 1);
    let a = cs.files.iter().find(|f| f.rel == "a.txt").unwrap();
    assert_eq!((a.status, a.added, a.removed), ("modified", 1, 1));
    let r = cs.files.iter().find(|f| f.rel == "new.txt").unwrap();
    assert_eq!((r.status, r.from_rel.as_deref()), ("renamed", Some("old.txt")));
    assert_eq!((r.added, r.removed), (1, 1));
    assert!(t.undo(Scope::Chat, Some("a.txt"), None, false).ok);
    assert_eq!(t.read("a.txt"), "one\ntwo\nthree\n");
    let o = t.undo(Scope::Chat, Some("new.txt"), None, false);
    assert!(o.ok, "{o:?}");
    assert_eq!(t.read("old.txt"), "keep me\nrename me\n");
    assert!(!t.p("new.txt").exists());
    // A hand edit after the patch landed (coool saw the file after it first): diverged.
    std::fs::write(t.p("n.txt"), "hi, mine\n").unwrap();
    let n = t.file(Scope::Chat, "n.txt").unwrap();
    assert!(n.diverged);
    let o = t.undo(Scope::Chat, Some("n.txt"), None, false);
    assert!(o.ask.is_some(), "{o:?}");
    assert!(t.p("n.txt").exists());
}

#[test]
fn codex_delete_comes_back() {
    let mut t = T::new("codexdel", Kind::Codex);
    t.codex_prompt("remove it");
    let p = t.p("gone.txt").to_string_lossy().into_owned();
    t.line(json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"c1","input":format!("*** Begin Patch\n*** Delete File: {p}\n*** End Patch")}}));
    t.line(json!({"type":"event_msg","payload":{"type":"patch_apply_begin","call_id":"c1","changes":{p.clone():{"delete":{"content":"bye\n"}}}}}));
    t.line(json!({"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"c1","success":true}}));
    let f = t.file(Scope::Chat, "gone.txt").unwrap();
    assert_eq!(f.status, "deleted");
    assert!(t.undo(Scope::Chat, Some("gone.txt"), None, false).ok);
    assert_eq!(t.read("gone.txt"), "bye\n");
}

#[test]
fn binary_and_large_files() {
    let mut t = T::new("binlarge", Kind::Claude);
    t.prompt("p");
    t.write("img.dat", "text for now\n");
    std::fs::write(t.p("img.dat"), [0u8, 1, 2, 255]).unwrap();
    let f = t.file(Scope::Chat, "img.dat").unwrap();
    assert!(f.binary && f.hunks.is_empty() && f.diverged);
    let o = t.undo(Scope::Chat, Some("img.dat"), None, false);
    assert!(!o.ok);
    assert!(t.p("img.dat").exists());

    let big = lines(diff::MAX_LINES + 10);
    std::fs::write(t.p("big.txt"), &big).unwrap();
    t.edit("big.txt", "line 7\n", "line seven\n");
    let f = t.file(Scope::Chat, "big.txt").unwrap();
    assert!(f.large.as_deref().unwrap().contains("Too large"));
    assert!(f.hunks.is_empty() && f.text.is_none());
    assert!(t.undo(Scope::Chat, Some("big.txt"), None, false).ok);
    assert_eq!(t.read("big.txt"), big);
}

#[test]
fn crlf_and_no_trailing_newline_survive_undo() {
    let mut t = T::new("crlf", Kind::Claude);
    std::fs::write(t.p("w.txt"), "a\r\nb\r\nc").unwrap();
    t.prompt("p");
    t.edit("w.txt", "b", "B");
    t.edit("w.txt", "c", "C");
    let f = t.file(Scope::Chat, "w.txt").unwrap();
    assert!(f.hunks[0].lines.iter().any(|l| l.crlf));
    assert!(f.hunks[0].lines.iter().any(|l| l.noeol));
    let id = f.hunks[0].id.clone();
    assert!(t.undo(Scope::Chat, Some("w.txt"), Some(&id), false).ok);
    assert_eq!(t.read("w.txt"), "a\r\nb\r\nc");
}

#[test]
fn git_merge_refuses_writes_stage_and_commit_work() {
    let mut t = T::new("git", Kind::Claude);
    t.git_init();
    std::fs::write(t.p("a.txt"), "x\n").unwrap();
    t.git(&["add", "."]);
    t.git(&["commit", "-q", "-m", "init"]);
    t.prompt("p");
    t.edit("a.txt", "x", "y");
    t.write("n.txt", "new\n");

    let gd = t.dir.join(".git/MERGE_HEAD");
    std::fs::write(&gd, "0000000000000000000000000000000000000000\n").unwrap();
    let cs = t.load(Scope::Chat);
    assert_eq!(cs.git.as_ref().unwrap().busy.as_deref(), Some("merge"));
    assert!(cs.files.iter().all(|f| f.blocked.as_deref().is_some_and(|b| b.contains("merge"))));
    let o = t.undo(Scope::Chat, None, None, false);
    assert!(!o.ok && o.message.contains("merge"));
    assert_eq!(t.read("a.txt"), "y\n");
    let o = t.keep(Scope::Chat, Some("a.txt"), None, true);
    assert!(!o.ok && o.message.contains("not staged"), "{o:?}");
    std::fs::remove_file(&gd).unwrap();

    let o = t.keep(Scope::Chat, None, None, true);
    assert!(o.ok, "{o:?}");
    let staged = t.git(&["diff", "--cached", "--name-only"]);
    assert_eq!(staged.lines().collect::<Vec<_>>(), vec!["a.txt", "n.txt"]);
    assert!(t.load(Scope::Chat).files.iter().all(|f| f.staged && f.kept));
    let dir = t.dir.clone();
    let o = commit(&dir, "Agent edits, reviewed");
    assert!(o.ok, "{o:?}");
    assert_eq!(t.git(&["log", "-1", "--format=%s"]).trim(), "Agent edits, reviewed");
    assert!(t.git(&["status", "--porcelain"]).trim().is_empty());
    assert!(!commit(&dir, "again").ok, "nothing staged");
    assert!(!commit(&dir, "  ").ok, "no message");
}

#[test]
fn outside_sessions_undo_only_through_git() {
    let mut t = T::new("external", Kind::Claude);
    std::fs::write(t.p("a.txt"), "x\ny\n").unwrap();
    t.prompt("p");
    t.edit("a.txt", "y", "Y");
    // Not a repository: read-only.
    let (key, dir, sources) = (t.key.clone(), t.dir.clone(), t.sources.clone());
    let cs = t.eng.load(&Request { key: &key, cwd: &dir, sources: &sources, scope: Scope::Chat, external: true });
    assert!(cs.files[0].blocked.as_deref().unwrap().contains("git"));
    assert!(!t.undo_ext(Scope::Chat, Some("a.txt"), None, false, true).ok);
    // In a repository: git checks it.
    t.git_init();
    t.git(&["add", "."]);
    t.git(&["commit", "-q", "-m", "init"]);
    let o = t.undo_ext(Scope::Chat, Some("a.txt"), None, false, true);
    assert!(o.ok, "{o:?}");
    assert_eq!(t.read("a.txt"), "x\ny\n");
}

#[test]
fn subagent_edits_carry_their_agent() {
    let mut t = T::new("subagent", Kind::Claude);
    std::fs::write(t.p("a.txt"), "x\n").unwrap();
    t.prompt("p");
    let sub = t.dir.parent().unwrap().join("agent-a1.jsonl");
    let p = t.p("a.txt");
    std::fs::write(&p, "y\n").unwrap();
    std::fs::write(
        &sub,
        format!(
            "{}\n{}\n",
            json!({"type":"assistant","timestamp":"2026-11-20T10:05:00Z","message":{"content":[{"type":"tool_use","id":"s1","name":"Edit","input":{"file_path":p,"old_string":"x","new_string":"y"}}]}}),
            json!({"type":"user","timestamp":"2026-11-20T10:05:01Z","message":{"content":[{"type":"tool_result","tool_use_id":"s1","content":"ok"}]},"toolUseResult":{"filePath":p,"originalFile":"x\n"}})
        ),
    )
    .unwrap();
    t.sources.push(Source { kind: Kind::Claude, agent: Some("a1".into()), path: sub });
    let f = t.file(Scope::Chat, "a.txt").unwrap();
    assert_eq!(f.agents, vec!["a1".to_string()]);
    assert_eq!(f.turns, vec![1]);
}

#[test]
fn hunk_keep_marks_the_file_once_all_are_kept() {
    let mut t = T::new("hunkkeep", Kind::Claude);
    std::fs::write(t.p("a.txt"), lines(30)).unwrap();
    t.prompt("p");
    t.edit("a.txt", "line 2\n", "line two\n");
    t.edit("a.txt", "line 28\n", "line 28!\n");
    let f = t.file(Scope::Chat, "a.txt").unwrap();
    t.keep(Scope::Chat, Some("a.txt"), Some(&f.hunks[0].id), false);
    let p = t.file(Scope::Pending, "a.txt").unwrap();
    assert!(p.hunks[0].kept && !p.hunks[1].kept && !p.kept);
    t.keep(Scope::Chat, Some("a.txt"), Some(&f.hunks[1].id), false);
    assert!(t.file(Scope::Pending, "a.txt").is_none());
    assert!(t.file(Scope::Chat, "a.txt").unwrap().kept);
}

#[test]
fn preview_shows_the_pending_edit_in_context() {
    let t = T::new("preview", Kind::Claude);
    std::fs::write(t.p("a.txt"), lines(20)).unwrap();
    let p = t.p("a.txt");
    let fs = preview(&t.dir, "Edit", &json!({"file_path":p,"old_string":"line 10\n","new_string":"line ten\n"}));
    assert_eq!(fs.len(), 1);
    assert_eq!((fs[0].added, fs[0].removed), (1, 1));
    assert_eq!(fs[0].hunks[0].new_start, 7);
    assert!(fs[0].text.as_deref().unwrap().contains("line ten"));
    let fs = preview(&t.dir, "Write", &json!({"file_path":t.p("n.txt"),"content":"hi\n"}));
    assert_eq!(fs[0].status, "added");
    let fs = preview(&t.dir, "apply_patch", &json!({"changes":[{"path":p,"kind":"update","diff":"@@ -1,2 +1,2 @@\n line 1\n-line 2\n+line 2!\n"}]}));
    assert_eq!((fs[0].added, fs[0].removed), (1, 1));
    // Untouched on disk.
    assert_eq!(std::fs::read_to_string(&p).unwrap(), lines(20));
}

#[test]
fn unified_patches_apply_with_git() {
    let a = "1\n2\n3\n";
    let b = "1\nTWO\n3\n";
    let hs = diff::hunks(a, b, 3);
    let u = unified("f.txt", &hs);
    assert!(u.contains("@@ -1,3 +1,3 @@"));
    assert!(u.contains("-2\n+TWO\n"));
}

// ------------------------------------------------------------------------------------------------ the incremental engine

impl T {
    fn wire(&mut self, since: u64, summary: bool) -> Wire {
        let (key, dir, sources) = (self.key.clone(), self.dir.clone(), self.sources.clone());
        self.eng.load_wire(&Request { key: &key, cwd: &dir, sources: &sources, scope: Scope::Pending, external: false }, since, summary)
    }
}

/// The files of a reply: (name, sent in full).
fn sent(w: &Wire) -> Vec<(String, bool)> {
    w.set
        .as_ref()
        .map(|s| {
            s.files
                .iter()
                .map(|f| match f {
                    WireFile::Full(f) => (f.rel.clone(), true),
                    WireFile::Same { path, .. } => (Path::new(path).file_name().unwrap().to_string_lossy().into_owned(), false),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The set as the app would draw it, without its revision: to compare a warm engine with a fresh one.
fn shown(cs: &ChangeSet) -> String {
    let mut v = serde_json::to_value(cs).unwrap();
    v["rev"] = json!(0);
    v.to_string()
}

#[test]
fn incremental_unchanged_is_a_number_and_deltas_carry_only_what_changed() {
    let mut t = T::new("inc-delta", Kind::Claude);
    std::fs::write(t.p("a.txt"), lines(30)).unwrap();
    std::fs::write(t.p("b.txt"), lines(30)).unwrap();
    t.prompt("Edit both");
    t.edit("a.txt", "line 3\n", "line three\n");
    t.edit("b.txt", "line 4\n", "line four\n");
    let w = t.wire(0, false);
    assert_eq!(sent(&w), vec![("a.txt".into(), true), ("b.txt".into(), true)]);
    assert!(w.set.as_ref().unwrap().turns.is_some());
    // Nothing new: the same revision, no set.
    let w2 = t.wire(w.rev, false);
    assert_eq!(w2.rev, w.rev);
    assert!(w2.set.is_none());
    // What the agent said after its edits is part of both cards (the first text after each edit, in the turn): both
    // again, no turns.
    t.said("Done with both.");
    let w3 = t.wire(w.rev, false);
    assert_eq!(sent(&w3), vec![("a.txt".into(), true), ("b.txt".into(), true)]);
    assert!(w3.set.as_ref().unwrap().turns.is_none());
    // A transcript line about nothing here: nothing to send.
    t.said("Anything else?");
    assert!(t.wire(w3.rev, false).set.is_none(), "nothing new after the second text");
    // Another edit of a.txt: a in full, b as its path; the turns again (their counts changed).
    t.edit("a.txt", "line 20\n", "line twenty\n");
    let w5 = t.wire(w3.rev, false);
    assert_eq!(sent(&w5), vec![("a.txt".into(), true), ("b.txt".into(), false)]);
    assert!(w5.set.as_ref().unwrap().turns.is_some());
    // b.txt written again with the same content (its mtime moves): worked out again, the same, nothing sent.
    std::fs::write(t.p("b.txt"), t.read("b.txt")).unwrap();
    assert!(t.wire(w5.rev, false).set.is_none());
}

#[test]
fn incremental_reads_only_the_tail_and_waits_for_a_whole_line() {
    let mut t = T::new("inc-tail", Kind::Claude);
    std::fs::write(t.p("a.txt"), lines(10)).unwrap();
    t.prompt("Edit it");
    t.edit("a.txt", "line 2\n", "line two\n");
    let w = t.wire(0, false);
    assert_eq!(w.set.as_ref().unwrap().files.len(), 1);
    // The next edit's lines with the last one cut short: the call is seen (busy), not its result.
    t.edit("a.txt", "line 5\n", "line five\n");
    let full = std::fs::read(&t.transcript).unwrap();
    std::fs::write(&t.transcript, &full[..full.len() - 40]).unwrap();
    let w2 = t.wire(w.rev, false);
    let s = w2.set.as_ref().unwrap();
    assert!(s.busy);
    match &s.files[0] {
        WireFile::Full(f) => assert!(f.busy && f.edits == 1, "{f:?}"),
        x => panic!("a.txt not sent: {x:?}"),
    }
    // The rest of the line: the edit lands.
    std::fs::write(&t.transcript, &full).unwrap();
    let w3 = t.wire(w2.rev, false);
    match &w3.set.as_ref().unwrap().files[0] {
        WireFile::Full(f) => assert!(!f.busy && f.edits == 2 && f.added == 2, "{f:?}"),
        x => panic!("a.txt not sent: {x:?}"),
    }
}

#[test]
fn incremental_sees_a_hand_edit_a_keep_and_staging() {
    let mut t = T::new("inc-inval", Kind::Claude);
    t.git_init();
    std::fs::write(t.p("a.txt"), lines(20)).unwrap();
    std::fs::write(t.p("b.txt"), lines(20)).unwrap();
    t.git(&["add", "-A"]);
    t.git(&["commit", "-q", "-m", "start"]);
    t.prompt("Edit both");
    t.edit("a.txt", "line 3\n", "line three\n");
    t.edit("b.txt", "line 3\n", "line three\n");
    let w = t.wire(0, false);
    // A hand edit of b.txt (on disk only): b again, diverged; a as its path.
    let mut s = t.read("b.txt");
    s.push_str("by hand\n");
    std::fs::write(t.p("b.txt"), s).unwrap();
    let w2 = t.wire(w.rev, false);
    assert_eq!(sent(&w2), vec![("a.txt".into(), false), ("b.txt".into(), true)]);
    match &w2.set.as_ref().unwrap().files[1] {
        WireFile::Full(f) => assert!(f.diverged),
        _ => unreachable!(),
    }
    // Keep and stage a.txt: it leaves Unreviewed; All shows it staged.
    assert!(t.keep(Scope::Pending, Some("a.txt"), None, true).ok);
    let w3 = t.wire(w2.rev, false);
    assert_eq!(sent(&w3), vec![("b.txt".into(), false)]);
    assert_eq!(w3.set.as_ref().unwrap().pending, 1);
    assert!(t.file(Scope::Chat, "a.txt").unwrap().staged);
    // Unstaged in a terminal: the index changed, so git is asked again.
    t.git(&["reset", "-q", "a.txt"]);
    assert!(!t.file(Scope::Chat, "a.txt").unwrap().staged);
}

#[test]
fn incremental_summary_and_a_warm_engine_match_a_fresh_one() {
    let mut t = T::new("inc-same", Kind::Claude);
    std::fs::write(t.p("a.txt"), lines(40)).unwrap();
    std::fs::write(t.p("b.txt"), "alpha\nbeta\n").unwrap();
    t.prompt("First");
    t.edit("a.txt", "line 2\n", "line two\n");
    let _ = t.wire(0, false);
    let _ = t.load(Scope::Chat);
    t.prompt("Second");
    t.edit("a.txt", "line 30\n", "line thirty\n");
    t.write("n.txt", "new\n");
    let _ = t.wire(0, true);
    t.edit("b.txt", "beta\n", "BETA\n");
    assert!(t.undo(Scope::Pending, Some("n.txt"), None, false).ok);
    // The summary: counts and turns, no files.
    let w = t.wire(0, true);
    let s = w.set.as_ref().unwrap();
    assert!(s.files.is_empty());
    assert_eq!((s.pending, s.total, s.turns.as_ref().unwrap().len()), (2, 3, 2));
    // Every scope, warm, as a fresh engine (the same saved review) sees it.
    let fresh = Changes::new(Some(t.dir.parent().unwrap().join("state")));
    for scope in [Scope::Pending, Scope::Chat, Scope::Turn(1), Scope::Turn(2)] {
        let warm = t.load(scope);
        let (key, dir, sources) = (t.key.clone(), t.dir.clone(), t.sources.clone());
        let cold = fresh.load(&Request { key: &key, cwd: &dir, sources: &sources, scope, external: false });
        assert_eq!(shown(&warm), shown(&cold), "{scope:?}");
    }
}
