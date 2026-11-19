import { test } from "node:test";
import assert from "node:assert/strict";
import { turnTotals } from "./turn.ts";
import type { Activity } from "./types.ts";

const at = (h: number, m: number, s = 0) => new Date(2026, 10, 18, h, m, s).getTime();
const hms = (t: number) => new Date(t).toTimeString().slice(0, 8);
const act = (kind: Activity["kind"], t: number): Activity => ({ kind, ts: hms(t), text: kind }) as Activity;
const now = at(19, 55);

test("a turn begun without a prompt counts from its real start, not the old prompt", () => {
  // The prompt was ~10 h ago; a background task's notification started a turn 30 s ago.
  const activity = [act("prompt", at(10, 0)), act("tool", at(10, 1)), act("text", at(10, 2)), act("tool", at(19, 54, 40)), act("tool", at(19, 54, 50))];
  const old = turnTotals({ activity, agents: [] }, now);
  assert.equal(old.startMs, at(10, 0));
  const t = turnTotals({ activity, agents: [], tokens: { turn_start: at(19, 54, 30) + 250 } }, now);
  assert.equal(t.startMs, at(19, 54, 30) + 250);
  assert.equal(t.tools, 2);
  assert.equal(t.approxStart, false);
  assert.ok(t.endMs! >= t.startMs!);
});

test("a prompt that started the turn keeps the stamps' numbers", () => {
  const activity = [act("prompt", at(19, 50)), act("tool", at(19, 51)), act("tool", at(19, 52))];
  const t = turnTotals({ activity, agents: [], tokens: { turn_start: at(19, 50) + 400 } }, now);
  assert.equal(t.startMs, at(19, 50));
  assert.equal(t.tools, 2);
  assert.equal(t.endMs, at(19, 52));
});
