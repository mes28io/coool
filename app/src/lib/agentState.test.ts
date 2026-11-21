// Unit tests for lib/agentState.ts: `node --test app/src/lib/agentState.test.ts` (Node 22.6+ strips the types).

import { test } from "node:test";
import assert from "node:assert/strict";
import { agentEnd, agentWorking, backgroundLabel, crewLabel, runningAgents, silentFor, stateOf } from "./agentState.ts";
import { cellCounts, cellState } from "./mission.ts";
import type { Agent, AgentState, Session } from "./types.ts";

const NOW = 1_800_000_000_000;
const agent = (id: string, state?: AgentState, finished = state !== undefined && state !== "running", last_event: number | null = null): Agent => ({
  id,
  kind: "general-purpose",
  description: id,
  finished,
  state,
  last_event,
  current: null,
  tokens: { input: 0, cached: 0, output: 0, context: 0, total: 0 } as Agent["tokens"],
  activity: [],
});
const session = (status: Session["status"], agents: Agent[], extra: Partial<Session> = {}): Session => ({ status, agents, live_children: 0, shells: [], background_tasks: false, ...extra }) as unknown as Session;

test("the state comes from core, and falls back to finished for older payloads", () => {
  assert.equal(stateOf(agent("a", "stopped")), "stopped");
  assert.equal(stateOf({ finished: true }), "done");
  assert.equal(stateOf({ finished: false }), "running");
});

test("only running agents of a live session are working", () => {
  const all = [agent("run", "running"), agent("stop", "stopped"), agent("fail", "failed"), agent("done", "done"), agent("quiet", "quiet"), agent("old", undefined, false)];
  const s = session("idle", all);
  assert.deepEqual(runningAgents(s).map((a) => a.id), ["run", "old"]);
  assert.deepEqual(runningAgents(session("ended", all)), []);
  assert.equal(agentWorking(s, agent("x", "running", true)), false, "finished wins over a stale state");
});

test("a session whose sub-agents were all stopped is not held working and says no N agents working", () => {
  // The owner's case: four agents stopped with TaskStop, the rest done; the session idle.
  const all = [...["a", "b", "c", "d"].map((id) => agent(id, "stopped")), ...Array.from({ length: 25 }, (_, i) => agent(`done${i}`, "done"))];
  const s = session("idle", all);
  const working = runningAgents(s).length;
  assert.equal(working, 0);
  assert.equal(backgroundLabel(s, "idle", working), null, "idle stays idle: no \"working in background\"");
  assert.equal(crewLabel(working, 0), null, "no \"4 agents working\"");
  // A resumed one runs again, and only it counts.
  const resumed = session("idle", [agent("a", "running"), ...all.slice(1)]);
  assert.equal(runningAgents(resumed).length, 1);
  assert.equal(backgroundLabel(resumed, "idle", 1), "1 agent running");
  assert.equal(crewLabel(1, 0), "1 agent working");
  assert.equal(crewLabel(4, 2), "4 agents, 2 jobs working");
});

test("how a finished agent reads: stopped neutral, failed red, quiet with its silence, never done", () => {
  assert.deepEqual(agentEnd(agent("s", "stopped")), { stopped: true, quiet: false, error: null });
  assert.deepEqual(agentEnd(agent("f", "failed")), { stopped: false, quiet: false, error: null });
  assert.deepEqual(agentEnd(agent("q", "quiet", true, NOW - 40 * 60_000), NOW), { stopped: true, quiet: true, error: "No activity for 40 min" });
  assert.equal(agentEnd(agent("d", "done")), null);
  assert.equal(agentEnd(agent("r", "running")), null);
  assert.equal(silentFor(125 * 60_000), "2h 5m");
  assert.equal(silentFor(3 * 86_400_000), "3 days");
});

test("in the fan-out a quiet or stopped agent is a neutral stopped cell, not running", () => {
  const cell = (state: "running" | "failed" | "done", stopped = false) => ({ id: state, state, stopped, startedAt: NOW, lastAt: NOW });
  const cells = [cell("failed", true), cell("failed", true), cell("failed"), cell("done"), cell("running")];
  assert.deepEqual(cellCounts(cells.map(cellState)), { running: 1, needs: 0, failed: 1, stopped: 2, done: 1 });
});
