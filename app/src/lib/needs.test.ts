// Unit tests for lib/needs.ts: `node --test app/src/lib/needs.test.ts` (Node 22.6+ strips the types).

import { test } from "node:test";
import assert from "node:assert/strict";
import { chatContext, nextPick, permKind, sessionContext, waitedCommand } from "./needs.ts";
import type { ChatItem } from "./chat.ts";

const tool = (id: string, name: string, ts: number, o: { parent?: string | null; open?: boolean; agent?: boolean; input?: unknown } = {}): ChatItem => ({
  kind: "tool",
  key: id,
  id,
  name,
  summary: `${name} · x`,
  input: o.input ?? {},
  ts,
  endTs: o.open ? null : ts + 1,
  ok: o.open ? null : true,
  output: "",
  parent: o.parent ?? null,
  agent: !!o.agent,
});
const text = (id: string, t: string, ts: number, parent: string | null = null): ChatItem => ({ kind: "text", key: id, id, text: t, ts, streaming: false, parent, model: null });
const prompt = (id: string, t: string, ts: number): ChatItem => ({ kind: "prompt", key: id, id, text: t, ts });

test("permKind: commands, edits, writes, pages, devices, plans and other tools", () => {
  assert.equal(permKind("Bash", { command: "ls" }), "command");
  assert.equal(permKind("shell", {}), "command");
  assert.equal(permKind("Edit", { file_path: "/a", old_string: "a", new_string: "b" }), "edit");
  assert.equal(permKind("MultiEdit", {}), "edit");
  assert.equal(permKind("Write", { file_path: "/a", content: "x" }), "write");
  assert.equal(permKind("WebFetch", { url: "https://a.dev" }), "fetch");
  assert.equal(permKind("Browser", { coool_device: { device: "browser", lead: "use the Browser" } }), "device");
  assert.equal(permKind("ExitPlanMode", { plan: "# x" }), "plan");
  assert.equal(permKind("mcp__github__create_pull_request", { title: "x" }), "tool");
});

test("chatContext: the prompt, the last words and steps before the request, its own open call left out", () => {
  const items: ChatItem[] = [
    prompt("p0", "an older prompt", 1),
    tool("t0", "Read", 2),
    prompt("p1", "Retry failed mutations", 10),
    text("x1", "I'll read the queue first.", 11),
    tool("t1", "Read", 12),
    tool("t2", "Grep", 13),
    text("x2", "Now the tests.", 14),
    tool("t3", "Bash", 15, { open: true, input: { command: "npm test" } }),
    // After the request: not context.
    text("x3", "later", 30),
  ];
  const c = chatContext(items, 16, "Bash");
  assert.equal(c.prompt, "Retry failed mutations");
  assert.equal(c.said, "Now the tests.");
  assert.deepEqual(
    c.steps.map((s) => (s.kind === "tool" ? s.tool.id : "")),
    ["t1", "t2"],
  );
  assert.equal(c.agent, null);
});

test("chatContext: a request from inside a subagent names it and reads its own words and steps", () => {
  const items: ChatItem[] = [
    prompt("p", "Survey and fix", 1),
    text("m", "Starting an agent.", 2),
    tool("ag", "Task", 3, { open: true, agent: true, input: { subagent_type: "Explore", description: "Survey test coverage" } }),
    tool("s1", "Glob", 4, { parent: "ag" }),
    text("s2", "Coverage is thin.", 5, "ag"),
    tool("s3", "Bash", 6, { parent: "ag", open: true }),
  ];
  const c = chatContext(items, 7, "Bash");
  assert.deepEqual(c.agent, { kind: "Explore", description: "Survey test coverage" });
  assert.equal(c.said, "Coverage is thin.");
  assert.deepEqual(
    c.steps.map((s) => (s.kind === "tool" ? s.tool.id : "")),
    ["s1"],
  );
});

test("chatContext: a request asked under another name (the device gate's Browser) leaves its open call out", () => {
  const items: ChatItem[] = [prompt("p", "Check the sign-in page", 1), tool("g", "Grep", 2), tool("nav", "mcp__coool-device__browser_navigate", 3, { open: true })];
  const c = chatContext(items, 4, "Browser");
  assert.deepEqual(
    c.steps.map((s) => (s.kind === "tool" ? s.tool.id : "")),
    ["g"],
  );
});

test("sessionContext:a transcript's last prompt, reply and steps", () => {
  const c = sessionContext({
    last_prompt: "fallback",
    activity: [
      { ts: "10:00:00", kind: "prompt", text: "old" },
      { ts: "10:01:00", kind: "prompt", text: "Bake the probe", full: "Bake the probe\nat 4k" },
      { ts: "10:01:10", kind: "text", text: "Baking now." },
      { ts: "10:01:20", kind: "tool", text: "Bash · blender -b garden.blend" },
    ],
  });
  assert.equal(c.prompt, "Bake the probe\nat 4k");
  assert.equal(c.said, "Baking now.");
  assert.equal(c.steps.length, 1);
  assert.equal(sessionContext({ last_prompt: "only this", activity: [] }).prompt, "only this");
});

test("nextPick: keeps the pick, moves to the next once it is answered, then to the last", () => {
  assert.equal(nextPick(["a", "b", "c"], ["a", "b", "c"], "b"), "b");
  assert.equal(nextPick(["a", "c"], ["a", "b", "c"], "b"), "c");
  assert.equal(nextPick(["a"], ["a", "b"], "b"), "a");
  assert.equal(nextPick([], ["a"], "a"), null);
  assert.equal(nextPick(["x"], [], null), "x");
});

test("waitedCommand: the command a terminal wait names", () => {
  assert.equal(waitedCommand("Waiting for you: permission to run `rm -rf renders/tmp`"), "rm -rf renders/tmp");
  assert.equal(waitedCommand("Waiting for you: a login"), null);
});
