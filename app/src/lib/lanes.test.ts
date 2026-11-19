// Unit tests for lib/lanes.ts: `node --test app/src/lib/lanes.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksFromChat, blocksFromMarks, LANE_KEEP_MS, LANE_MAX_MARKS, LANE_WINDOW_MS, laneStale, laneX, noteLane, runningLabel, type LaneLog } from "./lanes.ts";

const M = 60_000;
const NOW = 1_800_000_000_000;
const FROM = NOW - LANE_WINDOW_MS;

test("noteLane: first sight starts the log; repeats are no-ops (same object)", () => {
  const a = noteLane(undefined, "working", NOW - 10 * M);
  assert.equal(a.first, NOW - 10 * M);
  assert.equal(a.marks.length, 1);
  assert.equal(noteLane(a, "working", NOW - 9 * M), a);
  const b = noteLane(a, "idle", NOW - 8 * M, true);
  assert.deepEqual(b.marks[1], { at: NOW - 8 * M, state: "idle", failed: true });
  assert.equal(b.first, a.first);
});

test("noteLane: bounded by time (keeps the state at the window's start) and by count", () => {
  let log: LaneLog | undefined;
  const t0 = NOW - 2 * LANE_KEEP_MS;
  for (let i = 0; i < 40; i++) log = noteLane(log, i % 2 ? "idle" : "working", t0 + i * M);
  log = noteLane(log, "working", NOW);
  assert.ok(log.marks[0].at <= NOW - LANE_KEEP_MS, "one mark before the cut stays");
  assert.ok(log.marks.slice(1).every((m) => m.at > NOW - LANE_KEEP_MS));
  let many: LaneLog | undefined;
  for (let i = 0; i < LANE_MAX_MARKS * 2; i++) many = noteLane(many, i % 2 ? "idle" : "working", NOW - LANE_MAX_MARKS * 2 + i);
  assert.equal(many!.marks.length, LANE_MAX_MARKS);
});

test("laneStale: only quiet logs older than the kept window", () => {
  assert.ok(!laneStale(noteLane(undefined, "working", NOW - 2 * LANE_KEEP_MS), NOW), "still working");
  assert.ok(laneStale(noteLane(undefined, "idle", NOW - 2 * LANE_KEEP_MS), NOW));
  assert.ok(!laneStale(noteLane(undefined, "idle", NOW - M), NOW));
});

test("blocksFromMarks: turns from working to idle, waits inside, live into now", () => {
  let log = noteLane(undefined, "idle", NOW - 25 * M);
  log = noteLane(log, "working", NOW - 20 * M);
  log = noteLane(log, "needs", NOW - 18 * M);
  log = noteLane(log, "working", NOW - 16 * M);
  log = noteLane(log, "idle", NOW - 12 * M);
  log = noteLane(log, "working", NOW - 10 * M);
  log = noteLane(log, "idle", NOW - 8 * M, true);
  log = noteLane(log, "working", NOW - 3 * M);
  const b = blocksFromMarks(log, FROM, NOW);
  assert.equal(b.length, 3);
  assert.deepEqual(b[0], { start: NOW - 20 * M, end: NOW - 12 * M, kind: "done", live: false, waits: [{ start: NOW - 18 * M, end: NOW - 16 * M }] });
  assert.equal(b[1].kind, "failed");
  assert.deepEqual([b[2].kind, b[2].live, b[2].end], ["working", true, NOW]);
});

test("blocksFromMarks: never before coool first saw the session, and clipped to the window", () => {
  // First seen mid-turn 5 minutes ago: the block starts then, not earlier.
  const seen = noteLane(undefined, "working", NOW - 5 * M);
  assert.deepEqual(blocksFromMarks(seen, FROM, NOW).map((x) => x.start), [NOW - 5 * M]);
  // A turn that began before the window starts at the window's edge.
  let old = noteLane(undefined, "working", NOW - 40 * M);
  old = noteLane(old, "idle", NOW - 20 * M);
  assert.deepEqual(blocksFromMarks(old, FROM, NOW).map((x) => [x.start, x.end]), [[FROM, NOW - 20 * M]]);
  // Waiting on the person right now: a live block with an open wait.
  const needs = noteLane(noteLane(undefined, "working", NOW - 4 * M), "needs", NOW - 2 * M);
  assert.deepEqual(blocksFromMarks(needs, FROM, NOW)[0].waits, [{ start: NOW - 2 * M, end: NOW }]);
  // Nothing but idle: no blocks.
  assert.deepEqual(blocksFromMarks(noteLane(undefined, "idle", NOW - M), FROM, NOW), []);
});

test("blocksFromChat: prompt to turn end, failed turns, waits, a live turn", () => {
  const items = [
    { kind: "prompt", ts: NOW - 22 * M },
    { kind: "tool", ts: NOW - 21 * M },
    { kind: "permission", ts: NOW - 20 * M, answeredTs: NOW - 19 * M },
    { kind: "turn", ts: NOW - 15 * M, failed: false },
    { kind: "prompt", ts: NOW - 12 * M },
    { kind: "turn", ts: NOW - 11 * M, failed: true },
    { kind: "prompt", ts: NOW - 4 * M },
    { kind: "question", ts: NOW - 2 * M, answeredTs: null },
  ];
  const b = blocksFromChat(items, FROM, NOW, true);
  assert.deepEqual(b.map((x) => x.kind), ["done", "failed", "working"]);
  assert.deepEqual(b[0].waits, [{ start: NOW - 20 * M, end: NOW - 19 * M }]);
  assert.deepEqual(b[2].waits, [{ start: NOW - 2 * M, end: NOW }]);
  assert.equal(b[2].end, NOW);
  // The CLI exited mid-turn with an error code: that turn failed.
  const crash = blocksFromChat([{ kind: "prompt", ts: NOW - 3 * M }, { kind: "exited", ts: NOW - 2 * M, code: 1 }], FROM, NOW, false);
  assert.deepEqual(crash.map((x) => [x.kind, x.end]), [["failed", NOW - 2 * M]]);
  // Items older than the window are dropped.
  assert.deepEqual(blocksFromChat([{ kind: "prompt", ts: NOW - 50 * M }, { kind: "turn", ts: NOW - 45 * M, failed: false }], FROM, NOW, true), []);
});

test("laneX and runningLabel", () => {
  assert.equal(laneX(FROM, FROM, NOW), 0);
  assert.equal(laneX(NOW, FROM, NOW), 1);
  assert.equal(laneX(NOW + M, FROM, NOW), 1);
  assert.equal(runningLabel(3, 1), "3 working · 1 needs you");
  assert.equal(runningLabel(0, 2), "2 need you");
  assert.equal(runningLabel(1, 0), "1 working");
  assert.equal(runningLabel(0, 0), "");
});
