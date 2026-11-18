// Where a turn went (lib/turnBreakdown.ts): the queueing correction, the split by kind, the waterfall rows.
// Run: node --test app/src/lib/turnBreakdown.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatItem } from "./chat";
import { breakdown, correctStarts, segmentText, toolKind, turnItems } from "./turnBreakdown.ts";

type Tool = Extract<ChatItem, { kind: "tool" }>;
let n = 0;
const tool = (name: string, ts: number, endTs: number | null, extra: Partial<Tool> = {}): Tool => ({
  kind: "tool",
  key: `k${++n}`,
  id: extra.id ?? `t${n}`,
  name,
  summary: "",
  input: {},
  ts,
  endTs,
  ok: endTs === null ? null : true,
  output: "",
  parent: null,
  agent: /^(task|agent)$/i.test(name),
  ...extra,
});
const D = (t: string) => `mcp__coool-device__${t}`;
const fmt = (ms: number) => `${Math.round(ms / 1000)}s`;

test("calls issued together queue behind each other: the screenshot didn't take 5 s", () => {
  // One message: wait_for (5 s, it timed out) then screenshot; both arrive at t=0, the screenshot ends at 5.2 s.
  const wait = tool(D("browser_wait_for"), 0, 5000, { input: { idle: true } });
  const shot = tool(D("browser_screenshot"), 0, 5200);
  const t = correctStarts([wait, shot], 9999);
  assert.deepEqual(t.get(wait.id), { start: 0, end: 5000 });
  assert.deepEqual(t.get(shot.id), { start: 5000, end: 5200 });
});

test("read-only built-ins run side by side and are not moved", () => {
  const a = tool("Read", 0, 300);
  const b = tool("Grep", 0, 500);
  const c = tool("Bash", 0, 2500); // waits for the reads (they were issued first)
  const t = correctStarts([a, b, c], 9999);
  assert.equal(t.get(a.id)!.start, 0);
  assert.equal(t.get(b.id)!.start, 0);
  assert.equal(t.get(c.id)!.start, 500);
});

test("parallel subagents keep their own start; their calls are their own threads", () => {
  const a1 = tool("Task", 0, 60_000, { id: "a1" });
  const a2 = tool("Task", 0, 90_000, { id: "a2" });
  const k1 = tool("Bash", 1000, 20_000, { parent: "a1" });
  const k2 = tool("Bash", 1000, 30_000, { parent: "a2" });
  const t = correctStarts([a1, a2, k1, k2], 99_999);
  assert.equal(t.get("a2")!.start, 0);
  assert.equal(t.get(k2.id)!.start, 1000);
});

test("calls in different messages are never moved", () => {
  const a = tool("Bash", 0, 1000);
  const b = tool("Bash", 3000, 4000);
  assert.equal(correctStarts([a, b], 0).get(b.id)!.start, 3000);
});

test("kinds", () => {
  assert.equal(toolKind("Read"), "reading");
  assert.equal(toolKind("Glob"), "reading");
  assert.equal(toolKind("Edit"), "editing");
  assert.equal(toolKind("apply_patch"), "editing");
  assert.equal(toolKind("Bash"), "commands");
  assert.equal(toolKind("exec_command"), "commands");
  assert.equal(toolKind("WebFetch"), "web");
  assert.equal(toolKind(D("browser_click")), "web");
  assert.equal(toolKind("coool-device.tap"), "web");
  assert.equal(toolKind("Task"), "agents");
  assert.equal(toolKind("mcp__supabase__execute_sql"), "other");
  assert.equal(toolKind("Skill"), "other");
  assert.equal(toolKind("AskUserQuestion"), "waiting");
});

test("the split: every ms goes to one kind, waiting for you wins, the rest is writing", () => {
  // A 60 s turn: thinking 0-5, Read 5-8, Bash 10-40 with a permission wait 10-25 inside it, Edit 41-44.
  const items: ChatItem[] = [
    { kind: "prompt", key: "p", id: "p", text: "go", ts: 0 },
    { kind: "thinking", key: "th", id: "m1", text: "…", ts: 0, endTs: 5000, parent: null },
    tool("Read", 5000, 8000),
    tool("Bash", 10_000, 40_000, { input: { command: "pnpm test" }, summary: "Bash · pnpm test" }),
    { kind: "permission", key: "perm", requestId: "r", tool: "Bash", summary: "", input: {}, ts: 10_000, answer: "allow", answeredTs: 25_000, remember: [], remembered: null },
    tool("Edit", 41_000, 44_000),
    { kind: "turn", key: "turn", ts: 60_000, durationMs: 60_000, ok: true, failed: false, tools: 3, tokens: null },
  ];
  const b = breakdown(turnItems(items, items.length - 1), 0, 60_000);
  const ms = Object.fromEntries(b.segments.map((s) => [s.kind, s.ms]));
  assert.deepEqual(ms, { thinking: 5000, reading: 3000, editing: 3000, commands: 15_000, waiting: 15_000, writing: 19_000 });
  assert.equal(b.segments.reduce((n, s) => n + s.ms, 0), 60_000);
  // The Bash call's own time leaves out the wait for the person.
  const bash = b.rows.find((r) => r.name === "Bash")!;
  assert.equal(bash.ms, 15_000);
  assert.equal(bash.from, 10_000);
  assert.equal(b.slowest, bash.key);
  const cmd = b.segments.find((s) => s.kind === "commands")!;
  assert.equal(segmentText(cmd, fmt), "Commands · 15s · 1 call");
  assert.equal(segmentText(b.segments.find((s) => s.kind === "waiting")!, fmt), "Waiting for you · 15s · 1 request");
});

test("segment text names the slowest call when there are several", () => {
  const items: ChatItem[] = [tool("Bash", 0, 2000, { summary: "Bash · ls" }), tool("Bash", 2000, 120_000, { summary: "Bash · pnpm test" }), tool("Bash", 120_000, 121_000, { summary: "Bash · git status" })];
  const b = breakdown(items, 0, 125_000);
  const cmd = b.segments.find((s) => s.kind === "commands")!;
  assert.equal(cmd.calls, 3);
  assert.equal(segmentText(cmd, fmt), "Commands · 121s · 3 calls · slowest Bash pnpm test 118s");
});

test("subagents: their span is Sub-agents, their calls fold under them", () => {
  const items: ChatItem[] = [
    tool("Task", 1000, 31_000, { id: "a1", summary: "Task · Survey" }),
    tool("Grep", 2000, 3000, { parent: "a1" }),
    tool("Read", 3000, 9000, { parent: "a1" }),
  ];
  const b = breakdown(items, 0, 32_000);
  assert.deepEqual(
    b.segments.map((s) => [s.kind, s.ms]),
    [
      ["agents", 30_000],
      ["writing", 2000],
    ],
  );
  assert.equal(b.rows.length, 1);
  assert.equal(b.rows[0].children.length, 2);
  // The slowest is a call, never the subagent's own span.
  assert.equal(b.slowest, b.rows[0].children[1].key);
});

test("a running turn grows to now; a running call ends at now", () => {
  const items: ChatItem[] = [tool(D("browser_navigate"), 1000, null, { input: { url: "https://example.com" } })];
  const b = breakdown(items, 0, 4000, true);
  assert.equal(b.running, true);
  assert.deepEqual(
    b.segments.map((s) => [s.kind, s.ms]),
    [
      ["web", 3000],
      ["writing", 1000],
    ],
  );
  assert.equal(b.rows[0].label, "Opening example.com");
  assert.equal(b.rows[0].running, true);
});

test("turnItems: only the turn's own items", () => {
  const items: ChatItem[] = [
    { kind: "prompt", key: "p1", id: "p1", text: "a", ts: 0 },
    { kind: "turn", key: "t1", ts: 10, durationMs: 10, ok: true, failed: false, tools: 0, tokens: null },
    { kind: "prompt", key: "p2", id: "p2", text: "b", ts: 20 },
    tool("Bash", 21, 30),
    { kind: "turn", key: "t2", ts: 40, durationMs: 20, ok: true, failed: false, tools: 1, tokens: null },
    { kind: "prompt", key: "p3", id: "p3", text: "c", ts: 50 },
  ];
  assert.deepEqual(
    turnItems(items, 4).map((i) => i.key),
    ["p2", items[3].key],
  );
  assert.deepEqual(
    turnItems(items, -1).map((i) => i.key),
    ["p3"],
  );
});
