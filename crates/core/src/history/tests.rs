use super::*;
use crate::loader::tests::tmpdir;


fn iso(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    // Civil from days (H. Hinnant).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

const DAY: u64 = 86_400_000;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis() as u64
}

struct Home {
    root: PathBuf,
}

impl Home {
    fn new(name: &str) -> Self {
        Self { root: tmpdir(&format!("hist-{name}")) }
    }
    fn claude(&self) -> PathBuf {
        self.root.join("home/.claude")
    }
    fn codex(&self) -> PathBuf {
        self.root.join("home/.codex")
    }
    fn opts(&self, caps: Caps) -> Options {
        Options { claude_root: self.claude(), codex_root: self.codex(), dir: Some(self.root.join("index")), caps, own_sessions: None }
    }
    fn mem(&self) -> Options {
        Options { dir: None, ..self.opts(Caps::default()) }
    }
    /// A Claude transcript: `prompts` (prompt, reply) turns, the last one at `at`.
    fn claude_session(&self, id: &str, cwd: &str, at: u64, turns: &[(&str, &str)], extra: &str) -> PathBuf {
        let dir = self.claude().join("projects").join(cwd.replace(['/', '.'], "-"));
        fs::create_dir_all(&dir).unwrap();
        let mut s = String::new();
        for (k, (p, r)) in turns.iter().enumerate() {
            let t = at - (turns.len() - 1 - k) as u64 * 60_000;
            s += &format!("{{\"type\":\"user\",\"timestamp\":\"{}\",\"entrypoint\":\"cli\",\"cwd\":\"{cwd}\",\"sessionId\":\"{id}\",\"message\":{{\"content\":{}}}}}\n", iso(t), serde_json::to_string(p).unwrap());
            s += &format!("{{\"type\":\"assistant\",\"timestamp\":\"{}\",\"message\":{{\"model\":\"claude-opus-5-5\",\"content\":[{{\"type\":\"text\",\"text\":{}}}]}}}}\n", iso(t + 1000), serde_json::to_string(r).unwrap());
        }
        s += extra;
        let p = dir.join(format!("{id}.jsonl"));
        fs::write(&p, s).unwrap();
        p
    }
    fn codex_session(&self, id: &str, cwd: &str, at: u64, prompt: &str, reply: &str, originator: &str, source: &str) -> PathBuf {
        let day = self.codex().join("sessions/2025/06/01");
        fs::create_dir_all(&day).unwrap();
        let s = format!(
            "{{\"timestamp\":\"{t}\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\",\"cwd\":\"{cwd}\",\"originator\":\"{originator}\",\"source\":\"{source}\"}}}}\n\
             {{\"type\":\"turn_context\",\"payload\":{{\"model\":\"gpt-5.6\",\"cwd\":\"{cwd}\"}}}}\n\
             {{\"timestamp\":\"{t}\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":{p}}}]}}}}\n\
             {{\"timestamp\":\"{t}\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":{r}}}]}}}}\n",
            t = iso(at),
            p = serde_json::to_string(prompt).unwrap(),
            r = serde_json::to_string(reply).unwrap(),
        );
        let p = day.join(format!("rollout-2025-06-01T10-00-00-{id}.jsonl"));
        fs::write(&p, s).unwrap();
        p
    }
}

fn run(h: &mut History) {
    h.request_scan();
    while h.step(Duration::from_secs(5)) {}
}

fn no_names(_: Provider, _: &str) -> Option<String> {
    None
}

fn find(h: &mut History, q: Query) -> Page {
    h.query(&q, &no_names, None)
}

fn text(t: &str) -> Query {
    Query { text: t.into(), ..Query::default() }
}

const C1: &str = "11111111-1111-4111-8111-111111111111";
const C2: &str = "22222222-2222-4222-8222-222222222222";
const C3: &str = "33333333-3333-4333-8333-333333333333";

#[test]
fn finds_old_sessions_of_both_clis_and_leaves_parts_out() {
    let home = Home::new("discover");
    let now = now_ms();
    // Two years old, well past the sidebar's day.
    home.claude_session("old-one", "/w/atlas", now - 700 * DAY, &[("Port the parser to Rust", "Done")], "");
    home.claude_session("recent", "/w/atlas", now - DAY / 2, &[("Fix flaky test", "Fixed")], "");
    // Nothing but metadata: not a session anyone ran.
    let empty = home.claude().join("projects/-w-atlas/empty.jsonl");
    fs::write(&empty, "{\"type\":\"file-history-snapshot\"}\n").unwrap();
    // Subagent transcripts sit below their session: part of it, never rows.
    let sub = home.claude().join("projects/-w-atlas/recent/subagents");
    fs::create_dir_all(&sub).unwrap();
    fs::write(sub.join("agent-a.jsonl"), "{\"type\":\"user\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"message\":{\"content\":\"sub prompt\"}}\n").unwrap();
    home.codex_session(C1, "/w/api", now - 300 * DAY, "Add rate limiting", "Token bucket", "codex_cli_rs", "cli");
    // A Codex subagent rollout: part of its parent thread.
    let child = home.codex_session(C2, "/w/api", now - 300 * DAY, "child work", "ok", "codex_cli_rs", "subagent");
    let body = fs::read_to_string(&child).unwrap().replacen("\"source\":\"subagent\"", &format!("\"source\":{{\"subagent\":{{\"thread_spawn\":{{\"parent_thread_id\":\"{C1}\"}}}}}}"), 1);
    fs::write(&child, body).unwrap();
    // An archived Codex thread.
    let arch = home.codex().join("archived_sessions");
    fs::create_dir_all(&arch).unwrap();
    let a = home.codex_session(C3, "/w/api", now - 400 * DAY, "Archived idea", "ok", "codex_cli_rs", "cli");
    fs::rename(&a, arch.join(a.file_name().unwrap())).unwrap();

    let mut h = History::open(home.mem());
    run(&mut h);
    let page = find(&mut h, Query::default());
    let keys: Vec<&str> = page.rows.iter().map(|r| r.key.as_str()).collect();
    assert_eq!(keys, vec!["claude:recent", &format!("codex:{C1}"), &format!("codex:{C3}"), "claude:old-one"]);
    let old = page.rows.iter().find(|r| r.id == "old-one").unwrap();
    assert_eq!((old.title.as_str(), old.via.as_str(), old.place, old.prompts), ("Port the parser to Rust", "Terminal", Where::Terminal, 1));
    assert!(page.rows.iter().find(|r| r.id == C3).unwrap().archived);
    assert!(find(&mut h, text("sub prompt")).rows.is_empty(), "subagent words are not a session of their own");
    assert!(find(&mut h, text("child work")).rows.is_empty());
    assert_eq!(h.path_of(Provider::Claude, "old-one").unwrap().file_name().unwrap(), "old-one.jsonl");
}

#[test]
fn reads_only_what_was_appended_and_rereads_a_replaced_file() {
    let home = Home::new("incremental");
    let now = now_ms();
    let p = home.claude_session("s", "/w/a", now - DAY, &[("alpha prompt", "alpha reply")], "");
    let mut h = History::open(home.opts(Caps::default()));
    run(&mut h);
    let first_offset = h.docs[0].offset;
    let log0 = h.log.len();
    assert_eq!(first_offset, fs::metadata(&p).unwrap().len());

    // Appended: only the new lines are read, and their words are added (one new record in the log).
    let more = format!("{{\"type\":\"user\",\"timestamp\":\"{}\",\"message\":{{\"content\":\"beta prompt\"}}}}\n", iso(now));
    fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(more.as_bytes()).unwrap();
    run(&mut h);
    assert_eq!(h.docs[0].meta.prompts, 2);
    let rec = h.log.records();
    assert_eq!(rec.len(), 2);
    assert_eq!(rec[1].0.f, first_offset, "the second pass started where the first stopped");
    assert!(h.log.len() - log0 < 200);
    assert_eq!(find(&mut h, text("alpha")).total, 1);
    assert_eq!(find(&mut h, text("beta")).total, 1);

    // A half-written last line waits until it is complete.
    fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(b"{\"type\":\"user\",\"message\":{\"content\":\"gam").unwrap();
    run(&mut h);
    assert_eq!(h.docs[0].meta.prompts, 2);
    fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(b"ma prompt\"}}\n").unwrap();
    run(&mut h);
    assert_eq!(h.docs[0].meta.prompts, 3);
    assert_eq!(find(&mut h, text("gamma")).total, 1);

    // Replaced by a different file: read again from the start, the old words gone.
    std::thread::sleep(Duration::from_millis(20));
    home.claude_session("s", "/w/a", now, &[("delta prompt", "delta reply")], "");
    run(&mut h);
    assert_eq!(h.docs[0].meta.prompts, 1);
    assert_eq!(find(&mut h, text("alpha")).total, 0);
    assert_eq!(find(&mut h, text("delta")).total, 1);
}

#[test]
fn survives_a_restart_and_a_crash_between_saves() {
    let home = Home::new("persist");
    let now = now_ms();
    home.claude_session("s1", "/w/a", now - DAY, &[("persistent words here", "ok")], "");
    home.claude_session("s2", "/w/b", now - 2 * DAY, &[("other words", "ok")], "");
    {
        let mut h = History::open(home.opts(Caps::default()));
        run(&mut h);
        h.save();
    }
    // A pass after the last save wrote words the catalog never heard of (the app died before saving).
    {
        let mut h = History::open(home.opts(Caps::default()));
        h.request_scan();
        h.scan();
        assert!(h.queue.is_empty(), "nothing changed: nothing to read again");
        assert_eq!(find(&mut h, text("persistent")).total, 1);
        let p = home.claude().join("projects/-w-a/s1.jsonl");
        let more = format!("{{\"type\":\"user\",\"timestamp\":\"{}\",\"message\":{{\"content\":\"persistent again\"}}}}\n", iso(now));
        fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(more.as_bytes()).unwrap();
        run(&mut h);
        // No save: dropped as a crash would.
    }
    let mut h = History::open(home.opts(Caps::default()));
    run(&mut h);
    let page = find(&mut h, text("persistent"));
    assert_eq!(page.total, 1);
    // The appended prompt was read once: one "again" in the words, two prompts.
    assert_eq!(h.docs.iter().find(|d| d.meta.id == "s1").unwrap().meta.prompts, 2);
    let i = h.by_path[&home.claude().join("projects/-w-a/s1.jsonl")];
    let words = String::from_utf8(h.texts().lower[i].clone()).unwrap();
    assert_eq!(words.matches("again").count(), 1, "{words}");

    // A log that doesn't match the catalog (another id): start over, quietly.
    let log = home.root.join("index/text.log");
    let mut b = fs::read(&log).unwrap();
    b[9] ^= 0xff;
    fs::write(&log, b).unwrap();
    let mut h = History::open(home.opts(Caps::default()));
    assert!(h.docs.is_empty());
    run(&mut h);
    assert_eq!(find(&mut h, text("persistent")).total, 1);
}

#[test]
fn keeps_under_the_caps_and_rows_stay_findable() {
    let home = Home::new("caps");
    let now = now_ms();
    let long = "word ".repeat(400);
    for k in 0..10u64 {
        home.claude_session(&format!("s{k}"), "/w/a", now - k * DAY, &[(&format!("title{k} {long}"), &long)], "");
    }
    let caps = Caps { prompt: 300, reply: 200, total: 2000 };
    let mut h = History::open(home.opts(caps));
    run(&mut h);
    for d in &h.docs {
        assert!(d.text <= 500 + 4, "per session: {}", d.text);
    }
    let total: usize = h.docs.iter().map(|d| d.text).sum();
    assert!(total <= caps.total, "{total}");
    // The newest keep their words; the oldest lost them, but are still found by their first prompt.
    let newest = h.docs.iter().find(|d| d.meta.id == "s0").unwrap();
    let oldest = h.docs.iter().find(|d| d.meta.id == "s9").unwrap();
    assert!(newest.text > 0 && oldest.text == 0 && oldest.dropped);
    assert_eq!(find(&mut h, text("title9")).total, 1);
    assert_eq!(find(&mut h, Query::default()).total, 10);
    // Garbage in the log is rewritten away once it is more than half (forced here with a small log).
    h.save();
    assert!(h.log.len() < (4 << 20));
}

#[test]
fn ranking_title_first_then_words_and_recency() {
    let home = Home::new("rank");
    let now = now_ms();
    home.claude_session("body-old", "/w/a", now - 200 * DAY, &[("refactor the parser", "we touched the sidebar widget code")], "");
    home.claude_session("body-new", "/w/a", now - DAY, &[("refactor the parser", "we touched the sidebar widget code")], "");
    home.claude_session("titled", "/w/a", now - 100 * DAY, &[("ok", "ok")], "{\"type\":\"ai-title\",\"aiTitle\":\"Sidebar widget redesign\"}\n");
    home.claude_session("other", "/w/a", now, &[("nothing to see", "really nothing")], "");
    let mut h = History::open(home.mem());
    run(&mut h);
    let page = find(&mut h, text("sidebar widget"));
    let ids: Vec<&str> = page.rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, vec!["titled", "body-new", "body-old"]);
    // All words must be there.
    assert_eq!(find(&mut h, text("sidebar nothing")).total, 0);
    // "Quoted words" are one phrase.
    assert_eq!(find(&mut h, text("\"widget code\"")).total, 2);
    assert_eq!(find(&mut h, text("\"code widget\"")).total, 0);
    // Case does not matter, and the snippet marks the words.
    let p = find(&mut h, text("WIDGET"));
    let snip = &p.rows.iter().find(|r| r.id == "body-new").unwrap().snippet;
    assert!(snip.iter().any(|s| s.hit && s.t == "widget"), "{snip:?}");
    assert_eq!(snip.iter().map(|s| s.t.as_str()).collect::<String>().trim(), "refactor the parser we touched the sidebar widget code");
}

#[test]
fn filters() {
    let home = Home::new("filters");
    let now = now_ms();
    home.claude_session("a1", "/w/atlas", now - DAY, &[("one", "x")], "{\"type\":\"assistant\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"Write\",\"input\":{\"file_path\":\"/w/atlas/a.txt\"}}]}}\n");
    home.claude_session("a2", "/w/atlas/sub", now - 40 * DAY, &[("two", "x")], "");
    home.claude_session("b1", "/w/beacon", now - 3 * DAY, &[("three", "x")], "");
    let ide = home.claude_session("v1", "/w/beacon", now - 2 * DAY, &[("four", "x")], "");
    fs::write(&ide, fs::read_to_string(&ide).unwrap().replace("\"entrypoint\":\"cli\"", "\"entrypoint\":\"claude-vscode\"")).unwrap();
    let auto = home.claude_session("p1", "/w/beacon", now - 2 * DAY, &[("five", "x")], "");
    fs::write(&auto, fs::read_to_string(&auto).unwrap().replace("\"entrypoint\":\"cli\"", "\"entrypoint\":\"sdk-cli\"")).unwrap();
    home.codex_session(C1, "/w/atlas", now - 5 * DAY, "six", "x", "codex_cli_rs", "cli");
    let mut h = History::open(home.mem());
    run(&mut h);
    let ids = |p: Page| {
        let mut v: Vec<String> = p.rows.into_iter().map(|r| r.id).collect();
        v.sort();
        v
    };
    assert_eq!(ids(find(&mut h, Query { cwd: Some("/w/atlas".into()), ..Query::default() })), vec![C1.to_string(), "a1".into(), "a2".into()]);
    assert_eq!(ids(find(&mut h, Query { cwd: Some("/w/atlas/sub".into()), ..Query::default() })), vec!["a2".to_string()]);
    assert_eq!(ids(find(&mut h, Query { providers: vec![Provider::Codex], ..Query::default() })), vec![C1.to_string()]);
    assert_eq!(ids(find(&mut h, Query { wheres: vec![Where::Ide], ..Query::default() })), vec!["v1".to_string()]);
    assert_eq!(ids(find(&mut h, Query { wheres: vec![Where::Automation], ..Query::default() })), vec!["p1".to_string()]);
    assert_eq!(ids(find(&mut h, Query { has_changes: true, ..Query::default() })), vec!["a1".to_string()]);
    assert_eq!(ids(find(&mut h, Query { from_ms: Some(now - 10 * DAY), to_ms: Some(now - 2 * DAY + 5000), ..Query::default() })), vec![C1.to_string(), "b1".into(), "p1".into(), "v1".into()]);
    // The project facet counts what the other filters leave, whatever project is picked.
    let p = find(&mut h, Query { providers: vec![Provider::Claude], project: Some("/w/beacon".into()), ..Query::default() });
    assert_eq!(p.total, 3);
    let facet: HashMap<String, usize> = p.projects.iter().map(|f| (f.project.clone(), f.count)).collect();
    assert_eq!(facet.get("/w/beacon"), Some(&3));
    assert_eq!(facet.get("/w/atlas"), Some(&1));
    assert_eq!(facet.get("/w/atlas/sub"), Some(&1));
    // A scope (the self-test's folder) hides everything else.
    let only: &dyn Fn(&str) -> bool = &|c: &str| c.starts_with("/w/beacon");
    assert_eq!(h.query(&Query::default(), &no_names, Some(only)).total, 3);
    // coool's name for a session is its title, and is searched.
    let named = |_: Provider, id: &str| (id == "b1").then(|| "Billing export".to_string());
    let p = h.query(&text("billing"), &named, None);
    assert_eq!(p.rows.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), vec!["Billing export"]);
}

#[test]
fn moved_and_deleted_folders() {
    let home = Home::new("moved");
    let now = now_ms();
    let old = home.root.join("old/place/atlas");
    let new = home.root.join("new/place/atlas");
    fs::create_dir_all(&new).unwrap();
    home.claude_session("gone", old.to_str().unwrap(), now - 30 * DAY, &[("before the move", "x")], "");
    home.claude_session("here", new.to_str().unwrap(), now - DAY, &[("after the move", "x")], "");
    let mut h = History::open(home.mem());
    run(&mut h);
    let p = find(&mut h, Query::default());
    let gone = p.rows.iter().find(|r| r.id == "gone").unwrap();
    let here = p.rows.iter().find(|r| r.id == "here").unwrap();
    assert!(gone.missing && !here.missing);
    // Where it may be now: a folder of the same name other sessions ran in.
    assert_eq!(h.folders_named("atlas", old.to_str().unwrap()), vec![new.to_str().unwrap().to_string()]);
    // A transcript removed from disk leaves the list.
    fs::remove_file(home.claude().join("projects").join(old.to_str().unwrap().replace(['/', '.'], "-")).join("gone.jsonl")).unwrap();
    run(&mut h);
    assert_eq!(find(&mut h, Query::default()).total, 1);
}

#[test]
fn search_speed_on_thousands() {
    let home = Home::new("speed");
    let now = now_ms();
    let words = ["parser", "sidebar", "billing", "release", "flaky", "cache", "router", "schema", "deploy", "invoice"];
    for k in 0..3000u64 {
        let w = words[(k % 10) as usize];
        let reply = format!("{} {}", "lorem ipsum dolor sit amet ".repeat(30), w);
        home.claude_session(&format!("s{k}"), &format!("/w/p{}", k % 12), now - k * DAY / 10, &[(&format!("work on the {w} number {k}"), &reply), ("next step please", &reply)], "");
    }
    let t = Instant::now();
    let mut h = History::open(home.opts(Caps::default()));
    run(&mut h);
    let build = t.elapsed();
    h.save();
    let q = Instant::now();
    let p = find(&mut h, text("billing"));
    let first = q.elapsed();
    let q = Instant::now();
    for w in ["bil", "bill", "billi", "billin", "billing number 1"] {
        find(&mut h, text(w));
    }
    let each = q.elapsed() / 5;
    eprintln!("history: 3000 sessions built in {build:?}; first search {first:?} (loads words), then {each:?} per search; log {} KB", h.log.len() / 1024);
    assert_eq!(p.total, 300);
    assert!(each < Duration::from_millis(if cfg!(debug_assertions) { 400 } else { 40 }), "{each:?}");
}

/// The person's real folders, read only (memory-only index, nothing written), printing numbers only:
/// `cargo test --release -p coool-core real_history_numbers -- --ignored --nocapture`.
#[test]
#[ignore]
fn real_history_numbers() {
    let home = dirs::home_dir().unwrap();
    let mut h = History::open(Options { own_sessions: None, ..Options::for_home(&home, None) });
    let t = Instant::now();
    run(&mut h);
    let built = t.elapsed();
    let s = h.status();
    let mut times = Vec::new();
    for w in ["the", "fix test", "a", "\"error\"", "zzzzqqq"] {
        let q = Instant::now();
        let p = find(&mut h, text(w));
        times.push((q.elapsed().as_secs_f64() * 1000.0, p.total));
    }
    let q = Instant::now();
    let all = find(&mut h, Query::default());
    eprintln!(
        "real: {} sessions, {} transcripts, {} MB words, built in {:.1} s; searches (ms, hits): {:?}; list {:.1} ms ({} rows)",
        s.sessions,
        s.transcripts,
        s.text_bytes / (1 << 20),
        built.as_secs_f64(),
        times,
        q.elapsed().as_secs_f64() * 1000.0,
        all.total
    );
}
