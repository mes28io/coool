// Unit tests for lib/lid.ts: `node --test app/src/lib/lid.test.ts` (Node 22.6+ strips the types).

import { test } from "node:test";
import assert from "node:assert/strict";
import { lidLine, pillText, spanText, stopText } from "./lid.ts";
import type { LidStatus } from "./settingsTypes.ts";

const T = new Date(2026, 10, 19, 2, 14, 0).getTime();
const base = (o: Partial<LidStatus> = {}): LidStatus => ({
  enabled: true,
  helper: { state: "ready" },
  dry_run: false,
  via: null,
  blocked: null,
  working: 0,
  since: null,
  reading: { on_battery: false, battery_pct: 80, thermal: "nominal", lid_closed: false, lid_sleeps: true, sleep_disabled: false },
  stops: [],
  stale: false,
  error: null,
  prefs: { enabled: true, only_on_power: true, min_battery: 20, max_hours: 8 },
  ...o,
});

test("spans", () => {
  assert.equal(spanText(20_000), "under a minute");
  assert.equal(spanText(3 * 60_000), "3m");
  assert.equal(spanText(72 * 60_000), "1h 12m");
  assert.equal(spanText(125 * 60_000), "2h 05m");
});

test("holding: agents, power, time of the limit", () => {
  const s = base({ via: "helper", working: 2, since: T - 72 * 60_000 });
  assert.deepEqual(lidLine(s, T), { tone: "held", text: "Holding the Mac awake: 2 agents working, on power, 1h 12m of 8h." });
  const d = base({ via: "display", working: 1, since: T - 3 * 60_000, prefs: { ...s.prefs, max_hours: 0 } });
  assert.equal(lidLine(d, T).text, "Holding the Mac awake (closed-display mode): 1 agent working, on power, 3m.");
});

test("not holding, and why", () => {
  assert.equal(lidLine(base({ working: 1, blocked: "on_battery", reading: { ...base().reading, on_battery: true } }), T).text, "Not holding: on battery. It holds again when the Mac is plugged in.");
  assert.equal(lidLine(base({ working: 1, blocked: "low_battery", reading: { ...base().reading, on_battery: true, battery_pct: 19 } }), T).text, "Not holding: battery 19% (the limit is 20%).");
  assert.equal(lidLine(base({ working: 1, blocked: "hot" }), T).tone, "blocked");
  assert.match(lidLine(base({ working: 1, blocked: "needs_helper", helper: { state: "missing" } }), T).text, /Install the helper/);
  assert.equal(lidLine(base({ working: 1, blocked: "already_disabled" }), T).tone, "idle");
});

test("idle states: ready, needs approval, closed-display mode, stale", () => {
  assert.match(lidLine(base(), T).text, /^Ready\./);
  assert.match(lidLine(base({ helper: { state: "missing" } }), T).text, /^Needs one-time approval/);
  assert.match(lidLine(base({ helper: { state: "missing" }, reading: { ...base().reading, lid_sleeps: false } }), T).text, /^Ready in closed-display mode/);
  assert.match(lidLine(base({ helper: { state: "outdated", detail: 0 } }), T).text, /Install it again/);
  assert.equal(lidLine(base({ stale: true }), T).tone, "warn");
});

test("an automatic release reads like the notification", () => {
  assert.equal(stopText({ at: T, code: "low_battery", detail: "battery 20%" }), "Stopped holding the Mac awake at 02:14: battery 20%.");
  assert.equal(stopText({ at: T, code: "recovered", detail: "coool quit while holding the Mac awake; normal sleep was restored" }), "02:14: coool quit while holding the Mac awake; normal sleep was restored.");
});

test("the pill's footer", () => {
  assert.equal(pillText(null, null), null);
  assert.equal(pillText(base({ enabled: false }), { held: false }), null);
  assert.equal(pillText(base({ via: "helper", working: 1 }), { held: false, covered: true }), "Keeping the Mac awake, lid closed too");
  assert.equal(pillText(base({ working: 1, blocked: "on_battery" }), { held: true }), "Lid closed would sleep the Mac: on battery (idle sleep is held)");
  assert.equal(pillText(base({ enabled: false }), { held: true }), "Keeping the Mac awake (lid open)");
});
