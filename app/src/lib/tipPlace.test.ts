import assert from "node:assert/strict";
import { test } from "node:test";
import { placeTip } from "./tipPlace.ts";

const win = { w: 1000, h: 700 };
const tip = { w: 200, h: 40 };

test("below and centred when there is room, kept inside the window's edges", () => {
  assert.deepEqual(placeTip({ left: 400, top: 100, right: 500, bottom: 130 }, tip, win), { left: 350, top: 136, side: "below" });
  assert.deepEqual(placeTip({ left: 0, top: 100, right: 40, bottom: 130 }, tip, win), { left: 8, top: 136, side: "below" });
  assert.equal(placeTip({ left: 960, top: 100, right: 1000, bottom: 130 }, tip, win).left, 792);
});

test("above at the bottom of the window", () => {
  assert.deepEqual(placeTip({ left: 400, top: 660, right: 500, bottom: 690 }, tip, win), { left: 350, top: 614, side: "above" });
});

test("it stays off an area it must not cover", () => {
  const page = { left: 300, top: 140, right: 1000, bottom: 700 };
  // A toolbar button just above the page: below would cover the page, so above.
  assert.equal(placeTip({ left: 400, top: 100, right: 430, bottom: 130 }, tip, win, [page]).side, "above");
  // No side clear of it: the first that fits the window.
  assert.equal(placeTip({ left: 400, top: 300, right: 430, bottom: 330 }, tip, win, [{ left: 0, top: 0, right: 1000, bottom: 700 }]).side, "below");
});
