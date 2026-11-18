// Run: node --test app/src/lib/glassHoles.test.ts (Node strips the types itself).
import { test } from "node:test";
import assert from "node:assert/strict";
import { holeMask, holeRects } from "./glassHoles.ts";

const box = (left: number, top: number, w: number, h: number, isConnected = true) => ({
  isConnected,
  getBoundingClientRect: () => ({ left, top, right: left + w, bottom: top + h }),
});
const sheet = { left: 57, top: 45, right: 1440, bottom: 900 };

test("a panel's rect, relative to the sheet's background", () => {
  assert.deepEqual(holeRects(sheet, [box(1000, 97, 440, 803)]), [[943, 52, 440, 803]]);
});

test("clipped to the sheet; closed, empty or detached panels make no hole", () => {
  assert.deepEqual(holeRects(sheet, [box(1300, 97, 300, 900)]), [[1243, 52, 140, 803]]);
  assert.deepEqual(holeRects(sheet, [box(1440, 97, 0, 803), box(900, 97, 300, 803, false)]), []);
});

test("the mask keeps everything but the holes", () => {
  assert.equal(holeMask([]), null);
  const m = holeMask([[943, 52, 440, 803], [10, 20, 30, 40]])!;
  assert.equal(m.maskImage.split("linear-gradient").length - 1, 3);
  assert.equal(m.maskSize, "100% 100%, 440px 803px, 30px 40px");
  assert.equal(m.maskPosition, "0 0, 943px 52px, 10px 20px");
  assert.equal(m.maskComposite, "exclude");
});
