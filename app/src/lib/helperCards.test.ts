import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentCardData } from "./agentCards";
import type { Agent, LaneInfo } from "./types";
import { agentForCall, cardFromLane, isBackgroundCall, laneKind, lanesByCall, launchedAgentId, mergeBackground, withLane } from "./helperCards.ts";

const T0 = 1_800_000_000_000;
const S = 1000;

// The shape of Claude Code's acknowledgement for a background Agent call (invented ids and paths).
const ACK = "Async agent launched successfully.\nagentId: a1b2c3d4e5f6a7b8c (internal ID - do not mention to user. Use SendMessage with to: 'a1b2c3d4e5f6a7b8c' to continue this agent.)\noutput_file: /private/tmp/claude-501/-w/s1/tasks/a1b2c3d4e5f6a7b8c.output";

const card = (o: Partial<AgentCardData> = {}): AgentCardData => ({
  id: "chat:t1",
  source: "chat",
  ref: "t1",
  provider: "claude",
  model: "claude-sonnet-5-5",
  kind: "general-purpose",
  description: "Build the web driver",
  state: "done",
  tokens: 0,
  label: "",
  labelTool: null,
  since: T0,
  startedAt: T0,
  steps: [],
  active: -1,
  durationMs: 0,
  result: "Async agent launched successfully.",
  error: null,
  stopped: false,
  lastAt: T0,
  stoppable: false,
  fill: null,
  handoff: "Build the web driver and the live screen map.",
  handoffFull: null,
  ...o,
});

const agent = (id: string, description: string): Agent => ({ id, kind: "general-purpose", description, finished: false, current: null, tokens: { input: 0, cached: 0, output: 0, context: 0 } as Agent["tokens"], activity: [] });

test("a background launch is told by its input or its acknowledgement, and names its agent", () => {
  assert.equal(launchedAgentId(ACK), "a1b2c3d4e5f6a7b8c");
  assert.equal(launchedAgentId("Done."), null);
  assert.equal(isBackgroundCall({ run_in_background: true }, ""), true);
  assert.equal(isBackgroundCall({}, ACK), true);
  assert.equal(isBackgroundCall({ prompt: "x" }, "Here is what I found"), false);
  const agents = [agent("a0", "Research"), agent("a1b2c3d4e5f6a7b8c", "Build the web driver"), agent("a9", "Build the web driver")];
  assert.equal(agentForCall({ input: {}, output: ACK, ts: T0 }, agents)?.id, "a1b2c3d4e5f6a7b8c");
  // No result yet: by description, skipping one another call already claimed.
  assert.equal(agentForCall({ input: { description: "Research" }, output: "", ts: T0 }, agents)?.id, "a0");
  const at = (a: Agent) => ({ a1b2c3d4e5f6a7b8c: T0 + S, a9: T0 + 60 * S })[a.id as "a9"] ?? null;
  assert.equal(agentForCall({ input: { description: "Build the web driver" }, output: "", ts: T0 + 50 * S }, agents, new Set(), at)?.id, "a9");
  assert.equal(agentForCall({ input: { description: "Build the web driver" }, output: "", ts: T0 }, agents, new Set(["a1b2c3d4e5f6a7b8c"]), at)?.id, "a9");
});

test("a background agent is running from launch to its end, timed by its own transcript, never by the acknowledgement", () => {
  const call = { ts: T0, output: ACK, ok: true, endTs: T0 + 15 };
  const chat = card();
  // Still running (its transcript says so): live steps, no "Finished", no result.
  const running = mergeBackground(chat, card({ id: "agent:a1", source: "agent", ref: "a1", state: "running", durationMs: null, result: null, steps: [{ key: "k", name: "Read", label: "Read a.ts", failed: false, ms: null }], active: 0, tokens: 27_000, startedAt: T0 + 2 * S }), call, true);
  assert.equal(running.state, "running");
  assert.equal(running.id, "chat:t1", "keeps the call's identity (timeline focus, nesting)");
  assert.equal(running.description, "Build the web driver");
  assert.equal(running.result, null);
  assert.equal(running.steps.length, 1);
  assert.equal(running.tokens, 27_000);
  assert.equal(running.startedAt, T0);
  // Completed: its own first to last step.
  const done = mergeBackground(chat, card({ id: "agent:a1", state: "done", durationMs: 352 * S, result: "The report is at notes/cua.md.", startedAt: T0 + S, lastAt: T0 + 353 * S }), call, true);
  assert.equal(done.state, "done");
  assert.equal(done.durationMs, 352 * S);
  assert.equal(done.result, "The report is at notes/cua.md.");
  // Stopped (TaskStop / killed): neutral.
  const stopped = mergeBackground(chat, card({ id: "agent:a1", state: "failed", stopped: true, error: "Stopped", durationMs: 40 * S }), call, true);
  assert.deepEqual([stopped.state, stopped.stopped, stopped.error], ["failed", true, "Stopped"]);
  // Its transcript not read yet: running from the launch while the chat lives; the acknowledgement is not a result.
  const early = mergeBackground(chat, null, call, true);
  assert.deepEqual([early.state, early.durationMs, early.result, early.startedAt], ["running", null, null, T0]);
  const gone = mergeBackground(chat, null, call, false);
  assert.deepEqual([gone.state, gone.quiet, gone.result], ["failed", true, null]);
  // A launch that failed outright stays failed as the call says.
  const refused = card({ state: "failed", error: "Agent type not found" });
  assert.equal(mergeBackground(refused, null, { ts: T0, output: "Agent type not found", ok: false, endTs: T0 + 5 }, true), refused);
});

const lane = (o: Partial<LaneInfo> = {}): LaneInfo => ({
  parent: "lead",
  tool: "t_loop",
  index: 0,
  provider: "codex",
  model: "gpt-6.2-sol",
  cwd: "/tmp/spike-wt/bench",
  brief: "Read the brief at /tmp/s/brief-bench.md and carry it out.",
  background: true,
  detached: true,
  image: false,
  at: T0,
  started: T0 + 700,
  ended: null,
  state: "running",
  session: "s-bench",
  ...o,
});

test("a shell helper's card takes its CLI, model, folder, brief, state and span from its lane", () => {
  const job = card({ id: "job:codex:s-bench", source: "job", ref: "codex:s-bench", provider: "codex", model: "gpt-6.2-sol", kind: "job", description: "Read the brief", state: "running", handoff: null, durationMs: null, result: null, active: 3, steps: [{ key: "1", name: "exec_command", label: "Ran ls", failed: false, ms: 1 }] });
  const run = withLane(job, lane(), "gpt-6.2-sol", "/Users/x/spike");
  assert.deepEqual([run.state, run.provider, run.model, run.kind, run.startedAt, run.durationMs, run.active], ["running", "codex", "gpt-6.2-sol", "codex exec · spike-wt/bench", T0 + 700, null, 3]);
  assert.equal(run.description, "Read the brief at /tmp/s/brief-bench.md and carry it out.");
  assert.equal(run.handoff, run.description);
  const done = withLane({ ...job, state: "done" }, lane({ state: "done", ended: T0 + 455 * S }), "gpt-6.2-sol");
  assert.deepEqual([done.state, done.durationMs, done.active], ["done", 455 * S - 700, -1]);
  const failed = withLane({ ...job, state: "done" }, lane({ state: "failed", ended: T0 + 40 * S }), null);
  assert.deepEqual([failed.state, failed.stopped, failed.error], ["failed", false, "Failed"]);
  // A `claude -p` a Codex lead started, whose run kept no session file.
  const solo = cardFromLane("/w/x", lane({ provider: "claude", model: "haiku", cwd: "/w/x", tool: "c7", session: null, state: "done", started: T0, ended: T0 + 2 * S, detached: false, background: false }));
  assert.deepEqual([solo.id, solo.ref, solo.kind, solo.model, solo.state, solo.durationMs], ["lane:c7:0", "c7", "claude -p", "haiku", "done", 2 * S]);
  const lost = cardFromLane("/w", lane({ session: null, state: "quiet" }));
  assert.deepEqual([lost.state, lost.quiet, lost.error], ["failed", true, "No session file found"]);
  assert.equal(laneKind({ provider: "codex", cwd: "/w" }, "/w"), "codex exec");
  const by = lanesByCall([lane({ index: 1 }), lane({ index: 0 }), lane({ tool: "t9" })]);
  assert.deepEqual(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.map((l) => l.index)])), { t_loop: [0, 1], t9: [0] });
});
