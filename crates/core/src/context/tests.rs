use super::*;
use serde_json::json;

const TS: &str = "2026-11-18T10:00:00.000Z";

/// Small Claude Code transcript builder: one JSON record per line.
#[derive(Default)]
struct T {
    lines: Vec<String>,
    n: usize,
}

impl T {
    fn push(&mut self, v: Value) -> &mut Self {
        self.lines.push(v.to_string());
        self
    }
    fn uuid(&mut self) -> String {
        self.n += 1;
        format!("u{}", self.n)
    }
    fn prompt(&mut self, text: &str) -> &mut Self {
        let u = self.uuid();
        self.push(json!({"type":"user","timestamp":TS,"uuid":u,"message":{"role":"user","content":text}}))
    }
    /// One response: usage (context = `ctx`, output = `out`) and its blocks.
    fn reply(&mut self, id: &str, ctx: u64, out: u64, blocks: Value) -> &mut Self {
        let u = self.uuid();
        self.push(json!({"type":"assistant","timestamp":TS,"uuid":u,"message":{"id":id,"model":"claude-x","content":blocks,"usage":{"input_tokens":2,"cache_creation_input_tokens":ctx/2 - 2 + ctx%2,"cache_read_input_tokens":ctx/2,"output_tokens":out}}}))
    }
    fn result(&mut self, id: &str, content: &str) -> &mut Self {
        let u = self.uuid();
        self.push(json!({"type":"user","timestamp":TS,"uuid":u,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":content}]}}))
    }
    fn feed(&self, b: &mut Builder) {
        for l in &self.lines {
            b.claude_line(l);
        }
    }
    fn map(&self) -> ContextMap {
        let mut b = Builder::new(Provider::Claude);
        self.feed(&mut b);
        b.snapshot()
    }
}

fn tool(id: &str, name: &str, input: Value) -> Value {
    json!({"type":"tool_use","id":id,"name":name,"input":input})
}

fn part<'a>(m: &'a ContextMap, label: &str) -> &'a Part {
    m.parts.iter().find(|p| p.label == label).unwrap_or_else(|| panic!("no part {label:?} in {:?}", m.parts.iter().map(|p| (&p.label, p.tokens)).collect::<Vec<_>>()))
}

fn sum(m: &ContextMap) -> u64 {
    m.parts.iter().map(|p| p.tokens).sum()
}

/// A session that reads a file, runs the tests twice and greps once.
fn session() -> T {
    let mut t = T::default();
    t.prompt("Fix the checkout bug")
        .reply("m1", 10_000, 100, json!([{"type":"text","text":"Looking."}, tool("t1","Read",json!({"file_path":"/w/src/payment.ts"}))]))
        .result("t1", &"x".repeat(9_000))
        .reply("m2", 13_100, 60, json!([tool("t2","Bash",json!({"command":"pnpm test"}))]))
        .result("t2", &"y".repeat(1_500))
        .reply("m3", 13_660, 40, json!([tool("t3","Bash",json!({"command":"cd app && pnpm test -- checkout"}))]))
        .result("t3", &"y".repeat(1_500))
        .reply("m4", 14_200, 30, json!([tool("t4","Grep",json!({"pattern":"charge("}))]))
        .result("t4", &"z".repeat(600))
        .reply("m5", 14_430, 80, json!([{"type":"text","text":"Fixed it."}]));
    t
}

#[test]
fn parts_sum_to_the_reported_context() {
    let m = session().map();
    assert_eq!(m.total, 14_430);
    assert_eq!(sum(&m), m.total, "{:?}", m.parts);
    // Largest first.
    assert!(m.parts.windows(2).all(|w| w[0].tokens >= w[1].tokens));
}

#[test]
fn files_and_tool_results_are_attributed_by_step() {
    let m = session().map();
    // Step m1 -> m2 grew 3100: 100 output (text + Read call), 3000 the file.
    let f = part(&m, "payment.ts");
    assert_eq!(f.kind, PartKind::File);
    assert_eq!(f.path.as_deref(), Some("/w/src/payment.ts"));
    assert_eq!(f.basis, Basis::Calibrated);
    assert!((3_000..3_100).contains(&f.tokens), "{}", f.tokens);
    // Two test runs, merged, counted.
    let t = part(&m, "Test runs");
    assert_eq!((t.kind, t.count), (PartKind::Tool, 2));
    assert!((1_000..1_150).contains(&t.tokens), "{}", t.tokens);
    assert_eq!(part(&m, "Searches").count, 1);
}

#[test]
fn the_unitemised_rest_of_the_first_request_is_one_remainder() {
    let m = session().map();
    let s = part(&m, "System and tools");
    assert_eq!((s.kind, s.basis), (PartKind::System, Basis::Remainder));
    // 10k first request minus the short first prompt.
    assert!((9_980..10_000).contains(&s.tokens), "{}", s.tokens);
}

#[test]
fn logged_system_prompt_and_tools_split_the_remainder() {
    let mut t = T::default();
    t.push(json!({"type":"api-request-shape","shape":{"system":[{"type":"text","text":"s".repeat(9_000)}],"tools":[
        {"name":"Read","description":"d".repeat(6_000),"input_schema":{}},
        {"name":"Later","description":"d".repeat(60_000),"input_schema":{},"defer_loading":true}]}}));
    t.lines.extend(session().lines);
    let m = t.map();
    assert_eq!(sum(&m), m.total);
    let sys = part(&m, "System prompt");
    let tools = part(&m, "Tool definitions");
    assert_eq!(sys.basis, Basis::Estimated);
    // Deferred tools aren't in the context: only the 6k one counts.
    assert!(tools.tokens < sys.tokens, "{} vs {}", tools.tokens, sys.tokens);
    assert!(part(&m, "Other system context").basis == Basis::Remainder);
}

#[test]
fn claude_md_on_disk_is_evidence_only_when_not_logged() {
    let mut b = Builder::new(Provider::Claude);
    b.disk_memory = vec![("/w/CLAUDE.md".into(), 7_000)];
    session().feed(&mut b);
    let m = b.snapshot();
    assert_eq!(part(&m, "Project memory").basis, Basis::Estimated);
    assert_eq!(sum(&m), m.total);

    // Logged instructions win over the disk guess.
    let mut t = T::default();
    t.push(json!({"type":"attachment","attachment":{"type":"instructions","files":[{"path":"/w/CLAUDE.md","type":"Project","content":"c".repeat(4_000)}]}}));
    t.lines.extend(session().lines);
    let mut b = Builder::new(Provider::Claude);
    b.disk_memory = vec![("/w/CLAUDE.md".into(), 70_000)];
    t.feed(&mut b);
    let m = b.snapshot();
    let mem = part(&m, "Project memory");
    assert!(mem.tokens < 2_000, "estimated from the logged 4k chars, not the 70k file: {}", mem.tokens);
}

#[test]
fn hidden_context_and_shrinking_steps_still_sum() {
    let mut t = T::default();
    t.prompt("go")
        .reply("m1", 5_000, 50, json!([tool("t1","Bash",json!({"command":"ls"}))]))
        .result("t1", "a b c")
        // 3k appeared for a 5-character result: the CLI added something unlogged.
        .reply("m2", 8_050, 400, json!([{"type":"thinking","thinking":""}, tool("t2","Bash",json!({"command":"ls"}))]))
        .result("t2", "ok")
        // Shrank: old thinking was cleared.
        .reply("m3", 8_100, 10, json!([{"type":"text","text":"done"}]));
    let m = t.map();
    assert_eq!(m.total, 8_100);
    assert_eq!(sum(&m), 8_100);
    assert!(part(&m, "Not in the transcript").tokens > 2_500);
    // Thinking (400 - the tool call) was taken back first.
    assert!(m.parts.iter().find(|p| p.kind == PartKind::Thinking).is_none_or(|p| p.tokens < 400));
}

#[test]
fn redacted_thinking_takes_what_the_output_count_leaves() {
    let mut t = T::default();
    t.prompt("think hard")
        .reply("m1", 4_000, 2_000, json!([{"type":"thinking","thinking":"","signature":"sig"}, {"type":"text","text":"short answer"}]))
        .prompt("next")
        .reply("m2", 6_010, 10, json!([{"type":"text","text":"ok"}]));
    let m = t.map();
    let th = part(&m, "Thinking");
    assert_eq!(th.basis, Basis::Calibrated);
    assert!(th.tokens > 1_980, "{}", th.tokens);
    assert_eq!(sum(&m), 6_010);
}

#[test]
fn repeated_records_of_one_message_count_once() {
    let mut t = T::default();
    t.prompt("go")
        .reply("m1", 5_000, 10, json!([{"type":"text","text":"a"}]))
        .reply("m1", 5_000, 300, json!([tool("t1","Bash",json!({"command":"cargo test"}))]))
        .result("t1", &"r".repeat(3_000))
        .reply("m2", 6_300, 5, json!([{"type":"text","text":"b"}]));
    let m = t.map();
    assert_eq!(sum(&m), 6_300);
    // Output 300 (the larger count), then 1000 of results.
    let tests = part(&m, "Test runs");
    assert!((1_000..1_300).contains(&tests.tokens), "{}", tests.tokens);
}

fn compacted_session() -> T {
    let mut t = session();
    let keep = t.lines.len();
    t.push(json!({"type":"system","subtype":"compact_boundary","timestamp":TS,"compactMetadata":{"trigger":"auto","preTokens":14_500,"postTokens":6_100,"preservedMessages":{"uuids":["u8","u9"]}}}))
        .push(json!({"type":"user","timestamp":TS,"uuid":"s1","isCompactSummary":true,"message":{"role":"user","content":"S".repeat(6_000)}}))
        .prompt("carry on")
        .reply("m6", 12_400, 20, json!([tool("t9","Read",json!({"file_path":"/w/src/receipt.tsx"}))]))
        .result("t9", &"r".repeat(6_000))
        .reply("m7", 14_420, 10, json!([{"type":"text","text":"ok"}]));
    assert!(t.lines.len() > keep);
    t
}

#[test]
fn only_what_follows_the_boundary_counts() {
    let m = compacted_session().map();
    assert_eq!(m.total, 14_420);
    assert_eq!(sum(&m), 14_420);
    assert!(m.parts.iter().all(|p| p.label != "payment.ts" && p.label != "Test runs"), "{:?}", m.parts);
    assert!(part(&m, "Summary").tokens > 1_000);
    assert!(part(&m, "receipt.tsx").tokens > 1_900);
    let c = m.compaction.as_ref().expect("compaction");
    assert_eq!((c.before, c.after, c.auto), (14_500, 6_100, true));
    // The map just before it.
    assert_eq!(c.before_parts.iter().map(|p| p.tokens).sum::<u64>(), 14_430);
    assert!(c.before_parts.iter().any(|p| p.label == "payment.ts"));
}

#[test]
fn preserved_messages_come_back_after_the_boundary() {
    // u8/u9 are the last Grep call and its result: preserved, they are history again.
    let m = compacted_session().map();
    assert!(m.parts.iter().any(|p| p.label == "Searches"), "{:?}", m.parts);
}

// ---------- Codex ----------

fn codex() -> Vec<String> {
    let tc = |tot_in: u64, out_total: u64, ctx: u64, out: u64| json!({"timestamp":TS,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":tot_in,"cached_input_tokens":0,"output_tokens":out_total},"last_token_usage":{"input_tokens":ctx,"output_tokens":out}}}});
    let item = |p: Value| json!({"timestamp":TS,"type":"response_item","payload":p});
    vec![
        json!({"timestamp":TS,"type":"session_meta","payload":{"id":"c1","cwd":"/w","base_instructions":{"text":"b".repeat(12_000)}}}),
        item(json!({"type":"additional_tools","role":"developer","tools":[{"name":"exec","description":"d".repeat(3_000)}]})),
        item(json!({"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /w\n".to_string() + &"a".repeat(2_000)}]})),
        item(json!({"type":"message","role":"user","content":[{"type":"input_text","text":"fix the tests"}]})),
        // Request 1: its outputs and the call's result come before its token_count.
        item(json!({"type":"reasoning","encrypted_content":"e".repeat(400)})),
        item(json!({"type":"custom_tool_call","name":"exec","call_id":"c1","input":"cargo test"})),
        item(json!({"type":"custom_tool_call_output","call_id":"c1","output":"o".repeat(6_000)})),
        tc(10_000, 100, 10_000, 100),
        tc(10_000, 100, 10_000, 100), // re-sent: not a new response
        item(json!({"type":"function_call","name":"exec_command","call_id":"c2","arguments":"{\"cmd\":\"sed -n '1,80p' src/lib.rs\"}"})),
        item(json!({"type":"function_call_output","call_id":"c2","output":"l".repeat(3_000)})),
        tc(22_100, 150, 12_100, 50),
        item(json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]})),
        tc(35_160, 160, 13_060, 10),
    ]
    .into_iter()
    .map(|v| v.to_string())
    .collect()
}

fn codex_map(lines: &[String]) -> ContextMap {
    let mut b = Builder::new(Provider::Codex);
    for l in lines {
        b.codex_line(l);
    }
    b.snapshot()
}

#[test]
fn codex_steps_attribute_results_to_the_next_request() {
    let m = codex_map(&codex());
    assert_eq!(m.total, 13_060);
    assert_eq!(sum(&m), 13_060);
    // 12_100 - 10_000 - 100 output = 2000 for the test output, plus its call (a share of the 100).
    let t = part(&m, "Test runs");
    assert!((2_000..=2_010).contains(&t.tokens), "{}", t.tokens);
    let f = part(&m, "lib.rs");
    assert!((955..=965).contains(&f.tokens), "910 of results and its 50-token call: {}", f.tokens);
    assert_eq!(part(&m, "System prompt").basis, Basis::Estimated);
    assert!(part(&m, "AGENTS.md").tokens > 0);
    assert!(part(&m, "Tool definitions").tokens > 0);
}

#[test]
fn codex_compaction_restarts_from_the_replacement_history() {
    let mut lines = codex();
    lines.push(json!({"timestamp":TS,"type":"compacted","payload":{"message":"","replacement_history":[
        {"type":"message","role":"user","content":[{"type":"input_text","text":"fix the tests"}]},
        {"type":"compaction","encrypted_content":"c".repeat(8_000)}]}}).to_string());
    lines.push(json!({"timestamp":TS,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":43_000,"cached_input_tokens":0,"output_tokens":170},"last_token_usage":{"input_tokens":7_900,"output_tokens":10}}}}).to_string());
    let m = codex_map(&lines);
    assert_eq!((m.total, sum(&m)), (7_900, 7_900));
    assert!(part(&m, "Summary").tokens > 0);
    assert!(m.parts.iter().all(|p| p.label != "Test runs"));
    let c = m.compaction.unwrap();
    assert_eq!((c.before, c.after), (13_060, 7_900));
    assert_eq!(c.before_parts.iter().map(|p| p.tokens).sum::<u64>(), 13_060);
}

#[test]
fn codex_without_usage_has_only_a_note() {
    let dir = crate::loader::tests::tmpdir("ctx-codex-note");
    let p = dir.join("r.jsonl");
    std::fs::write(&p, codex()[..4].join("\n") + "\n").unwrap();
    let m = map_file(&p, Provider::Codex, "/w");
    assert_eq!(m.total, 0);
    assert!(m.parts.is_empty());
    assert!(m.note.is_some());
}

// ---------- classification ----------

#[test]
fn tool_calls_group_by_what_they_were() {
    let c = |name: &str, input: Value| classify(name, &input);
    assert_eq!(c("Bash", json!({"command":"cargo test --workspace"})), key(PartKind::Tool, "Test runs"));
    assert_eq!(c("Bash", json!({"command":"pnpm -C app test"})), key(PartKind::Tool, "Test runs"));
    assert_eq!(c("Bash", json!({"command":"test -f x && echo y"})), key(PartKind::Tool, "Shell"));
    assert_eq!(c("Bash", json!({"command":"git status"})), key(PartKind::Tool, "Shell"));
    assert_eq!(c("Bash", json!({"command":"sed -n '1,80p' src/a.rs"})), key(PartKind::File, "src/a.rs"));
    assert_eq!(c("Bash", json!({"command":"cat README.md | head"})), key(PartKind::Tool, "Shell"));
    assert_eq!(c("exec_command", json!({"cmd":"bash -lc 'cat Cargo.toml'"})), key(PartKind::File, "Cargo.toml"));
    assert_eq!(c("mcp__supabase__execute_sql", json!({})), key(PartKind::Tool, "MCP · supabase"));
    assert_eq!(c("Agent", json!({})), key(PartKind::Agent, "Sub-agents"));
    assert_eq!(c("Edit", json!({"file_path":"/w/a.ts"})), key(PartKind::File, "/w/a.ts"));
    assert_eq!(c("apply_patch", json!("*** Begin Patch\n*** Update File: src/x.rs\n@@")), key(PartKind::File, "src/x.rs"));
    assert_eq!(c("Grep", json!({})), key(PartKind::Tool, "Searches"));
}

#[test]
fn the_long_tail_of_files_merges() {
    let mut t = T::default();
    t.prompt("read everything");
    let mut ctx = 5_000;
    t.reply("m0", ctx, 10, json!([tool("r0","Read",json!({"file_path":"/w/f0.rs"}))]));
    for i in 0..10 {
        t.result(&format!("r{i}"), &"x".repeat(300 * (i + 1)));
        ctx += 10 + 100 * (i as u64 + 1);
        let next = format!("r{}", i + 1);
        t.reply(&format!("m{}", i + 1), ctx, 10, json!([tool(&next,"Read",json!({"file_path":format!("/w/f{}.rs", i + 1)}))]));
    }
    let m = t.map();
    assert_eq!(sum(&m), m.total);
    let files: Vec<&Part> = m.parts.iter().filter(|p| p.kind == PartKind::File).collect();
    assert_eq!(files.len(), FILES_SHOWN + 1);
    let other = files.iter().find(|p| p.id == "file:*").unwrap();
    assert_eq!(other.count, 4);
    assert_eq!(other.label, "4 other files");
    // The largest are shown on their own.
    assert!(m.parts.iter().any(|p| p.label == "f9.rs"));
}

// ---------- reading files ----------

#[test]
fn incremental_reads_match_a_single_pass() {
    let dir = crate::loader::tests::tmpdir("ctx-incremental");
    let p = dir.join("s.jsonl");
    let all = compacted_session().lines;
    let cut = all.len() / 2;
    std::fs::write(&p, all[..cut].join("\n") + "\n").unwrap();
    let mut maps = ContextMaps::new();
    let first = maps.map(&p, Provider::Claude, "");
    assert_eq!(sum(&first), first.total);
    std::fs::write(&p, all.join("\n") + "\n").unwrap();
    let later = maps.map(&p, Provider::Claude, "");
    let once = map_file(&p, Provider::Claude, "");
    assert_eq!(later, once);
    assert_eq!(later.total, 14_420);
}

#[test]
fn a_cold_read_starts_at_the_second_to_last_boundary() {
    // Three segments: parsing starts at the first boundary of the last two, so
    // the latest compaction still has its "before" map.
    let mut t = compacted_session();
    t.push(json!({"type":"system","subtype":"compact_boundary","timestamp":TS,"compactMetadata":{"trigger":"manual","preTokens":14_420,"postTokens":3_000}}))
        .prompt("again")
        .reply("m9", 3_500, 5, json!([{"type":"text","text":"hi"}]));
    let dir = crate::loader::tests::tmpdir("ctx-cold");
    let p = dir.join("s.jsonl");
    std::fs::write(&p, t.lines.join("\n") + "\n").unwrap();
    let (hits, _) = scan_markers(&p, b"\"subtype\":\"compact_boundary\"", &[]).unwrap();
    assert_eq!(hits.len(), 2);
    let m = map_file(&p, Provider::Claude, "");
    assert_eq!((m.total, sum(&m)), (3_500, 3_500));
    let c = m.compaction.unwrap();
    assert!(!c.auto);
    assert_eq!(c.before_parts.iter().map(|p| p.tokens).sum::<u64>(), 14_420);
    assert!(c.before_parts.iter().any(|p| p.label == "receipt.tsx"));
}
