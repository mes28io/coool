// Unit tests for lib/historyRules.ts: `node --test app/src/lib/historyRules.test.ts` (Node 22.6+ strips the types).

import { test } from "node:test";
import assert from "node:assert/strict";
import { byAgent, byDay, dayLabel, filtersOn, NO_FILTERS, promptsLabel, spanLabel, toQuery } from "./historyRules.ts";

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const NOW = at(2026, 11, 21, 15);
const DAY = 86_400_000;

test("toQuery: words trimmed, one CLI, places, changed files", () => {
  const q = toQuery({ ...NO_FILTERS, text: "  login redirect ", provider: "codex", wheres: ["terminal", "ide"], changes: true, project: "/w/atlas" }, NOW);
  assert.deepEqual(q, { text: "login redirect", project: "/w/atlas", providers: ["codex"], wheres: ["terminal", "ide"], from_ms: null, to_ms: null, has_changes: true, agents: false });
  assert.deepEqual(toQuery(NO_FILTERS, NOW).providers, []);
});

test("toQuery: agents' sessions only on asking (the chip, or the Other tools place)", () => {
  assert.equal(toQuery(NO_FILTERS, NOW).agents, false);
  assert.equal(toQuery({ ...NO_FILTERS, agents: true }, NOW).agents, true);
  assert.equal(toQuery({ ...NO_FILTERS, wheres: ["automation"] }, NOW).agents, true);
  assert.equal(toQuery({ ...NO_FILTERS, wheres: ["terminal"] }, NOW).agents, false);
});

test("byAgent: programmatic runs and sessions with a known parent", () => {
  assert.equal(byAgent({ origin: "automation" }), true);
  assert.equal(byAgent({ origin: "coool", parent: "lead" }), true, "a Ladder helper");
  assert.equal(byAgent({ origin: "automation", parent: "lead" }), true, "a lane");
  assert.equal(byAgent({ origin: "user" }), false);
  assert.equal(byAgent({ origin: "coool", parent: null }), false);
  assert.equal(byAgent({}), false, "unknown: shown");
});

test("toQuery: date ranges start at midnight; a custom range covers its whole last day", () => {
  const midnight = at(2026, 11, 21, 0);
  assert.equal(toQuery({ ...NO_FILTERS, range: "today" }, NOW).from_ms, midnight);
  assert.equal(toQuery({ ...NO_FILTERS, range: "week" }, NOW).from_ms, midnight - 6 * DAY);
  assert.equal(toQuery({ ...NO_FILTERS, range: "month" }, NOW).from_ms, midnight - 29 * DAY);
  assert.equal(toQuery({ ...NO_FILTERS, range: "year" }, NOW).from_ms, midnight - 364 * DAY);
  const c = toQuery({ ...NO_FILTERS, range: "custom", from: "2025-03-01", to: "2025-03-31" }, NOW);
  assert.equal(c.from_ms, at(2025, 3, 1, 0));
  assert.equal(c.to_ms, at(2025, 4, 1, 0) - 1);
  // Half a range, or a bad date, leaves that end open.
  const h = toQuery({ ...NO_FILTERS, range: "custom", from: "", to: "nope" }, NOW);
  assert.equal(h.from_ms, null);
  assert.equal(h.to_ms, null);
});

test("filtersOn counts what is set beyond the words", () => {
  assert.equal(filtersOn(NO_FILTERS), 0);
  assert.equal(filtersOn({ ...NO_FILTERS, text: "x" }), 0);
  assert.equal(filtersOn({ ...NO_FILTERS, project: "/p", provider: "claude", wheres: ["app"], range: "week", changes: true }), 5);
  assert.equal(filtersOn({ ...NO_FILTERS, agents: true }), 1);
});

test("dayLabel and byDay", () => {
  assert.equal(dayLabel(at(2026, 11, 21, 1), NOW), "Today");
  assert.equal(dayLabel(at(2026, 11, 20, 23), NOW), "Yesterday");
  assert.equal(dayLabel(at(2026, 11, 17), NOW), new Date(at(2026, 11, 17)).toLocaleDateString(undefined, { weekday: "long" }));
  assert.ok(!dayLabel(at(2026, 3, 2), NOW).includes("2026"), "this year: no year");
  assert.ok(dayLabel(at(2024, 3, 2), NOW).includes("2024"), "an earlier year says so");
  const rows = [at(2026, 11, 21, 9), at(2026, 11, 21, 8), at(2026, 11, 20, 9), at(2025, 1, 1)].map((last_ms) => ({ last_ms }));
  assert.deepEqual(
    byDay(rows, NOW).map((g) => [g.day, g.rows.length]),
    [
      ["Today", 2],
      ["Yesterday", 1],
      [dayLabel(at(2025, 1, 1), NOW), 1],
    ],
  );
});

test("labels", () => {
  assert.equal(promptsLabel(1), "1 prompt");
  assert.equal(promptsLabel(3), "3 prompts");
  assert.equal(spanLabel(0, 20_000), null);
  assert.equal(spanLabel(0, 12 * 60_000), "12 min");
  assert.equal(spanLabel(0, 5 * 3600_000), "5 h");
  assert.equal(spanLabel(0, 3 * DAY), "3 days");
});
