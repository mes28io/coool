// Unit tests for lib/hoverRest.ts: `node --test app/src/lib/hoverRest.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { firstLine, hoverAnchor } from "./hoverRest.ts";

const WIN = { w: 1200, h: 800 };
const CARD = { w: 300, h: 140 };

test("hoverAnchor: right of a sidebar row, flipped left near the edge, kept on screen", () => {
  assert.deepEqual(hoverAnchor({ left: 60, top: 100, right: 300, bottom: 130 }, "right", CARD, WIN), { left: 308, top: 96 });
  assert.deepEqual(hoverAnchor({ left: 800, top: 100, right: 1000, bottom: 130 }, "right", CARD, WIN), { left: 492, top: 96 });
  assert.equal(hoverAnchor({ left: 60, top: 760, right: 300, bottom: 790 }, "right", CARD, WIN).top, 800 - 140 - 8);
});

test("hoverAnchor: below a tab, above when there is no room, clamped sideways", () => {
  assert.deepEqual(hoverAnchor({ left: 400, top: 6, right: 600, bottom: 40 }, "below", CARD, WIN), { left: 400, top: 48 });
  assert.equal(hoverAnchor({ left: 1100, top: 6, right: 1190, bottom: 40 }, "below", CARD, WIN).left, 1200 - 300 - 8);
  assert.equal(hoverAnchor({ left: 10, top: 700, right: 100, bottom: 730 }, "below", CARD, WIN).top, 700 - 8 - 140);
});

test("firstLine: first non-empty line, trimmed and shortened", () => {
  assert.equal(firstLine("\n  Fix the login bug  \nand more"), "Fix the login bug");
  assert.equal(firstLine(null), "");
  assert.equal(firstLine("x".repeat(200), 10), `${"x".repeat(9)}…`);
});
