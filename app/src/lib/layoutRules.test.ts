// Run: node --test app/src/lib/layoutRules.test.ts (Node strips the types itself).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_MIN_H,
  decideMode,
  defaultFrac,
  fracOf,
  PANEL_MIN_H,
  panelAxis,
  readStack,
  sidebarKeys,
  splitDir,
  STACK_DEFAULT,
  stackHeight,
} from "./layoutRules.ts";

test("automatic: portrait windows stack, landscape ones stay side by side", () => {
  assert.equal(decideMode(1080, 1920, "auto"), "stacked");
  assert.equal(decideMode(1200, 1920, "auto"), "stacked");
  assert.equal(decideMode(1440, 2560, "auto"), "stacked");
  assert.equal(decideMode(1280, 800, "auto"), "wide");
  assert.equal(decideMode(1920, 1080, "auto"), "wide");
  assert.equal(decideMode(2560, 1440, "auto"), "wide");
  // A square window is not portrait.
  assert.equal(decideMode(1000, 1000, "auto"), "wide");
});

test("automatic has a band, so a window dragged across the line doesn't flap", () => {
  // Coming from wide, it needs 4% more height than width.
  assert.equal(decideMode(1000, 1030, "auto", "wide"), "wide");
  assert.equal(decideMode(1000, 1040, "auto", "wide"), "stacked");
  // Coming from stacked, it stays until no taller than 98% of the width.
  assert.equal(decideMode(1000, 1000, "auto", "stacked"), "stacked");
  assert.equal(decideMode(1000, 981, "auto", "stacked"), "stacked");
  assert.equal(decideMode(1000, 980, "auto", "stacked"), "wide");
});

test("the manual choices win over the window's shape", () => {
  assert.equal(decideMode(1080, 1920, "wide"), "wide");
  assert.equal(decideMode(1920, 1080, "stacked"), "stacked");
  assert.equal(decideMode(1080, 1920, "wide", "stacked"), "wide");
});

test("a window with no size yet keeps what it had", () => {
  assert.equal(decideMode(0, 0, "auto"), "wide");
  assert.equal(decideMode(0, 0, "auto", "stacked"), "stacked");
});

test("wide: every panel sits beside the chat", () => {
  for (const k of ["agents", "models", "browser", "device", "mac"] as const) assert.equal(panelAxis("wide", k, 2000, 1800, 400), "x");
});

test("stacked: the Browser, Mac, Jobs and Models go below the chat at full width", () => {
  for (const k of ["agents", "models", "browser", "mac"] as const) {
    assert.equal(panelAxis("stacked", k, 780, 1800, 400), "y");
    assert.equal(panelAxis("stacked", k, 1400, 2400, 400), "y");
  }
});

test("stacked: the iPhone stays beside a chat that keeps room, else goes below", () => {
  assert.equal(panelAxis("stacked", "device", 780, 1800, 400), "y");
  assert.equal(panelAxis("stacked", "device", 1020, 1800, 400), "x");
  assert.equal(panelAxis("stacked", "device", 819, 1800, 400), "y");
  assert.equal(panelAxis("stacked", "device", 820, 1800, 400), "x");
});

test("stacked: a pane too short to stack keeps its panel beside", () => {
  assert.equal(panelAxis("stacked", "browser", 1000, PANEL_MIN_H + CHAT_MIN_H - 1, 400), "x");
  assert.equal(panelAxis("stacked", "browser", 1000, PANEL_MIN_H + CHAT_MIN_H, 400), "y");
});

test("stacked heights: a share of the body, never squeezing the chat or the panel", () => {
  assert.equal(stackHeight(0.5, 1800), 900);
  // The chat keeps CHAT_MIN_H.
  assert.equal(stackHeight(0.85, 600), 600 - CHAT_MIN_H);
  // The panel keeps PANEL_MIN_H.
  assert.equal(stackHeight(0.15, 1000), PANEL_MIN_H);
  // A share out of range is clamped first.
  assert.equal(stackHeight(5, 2000), 1700);
});

test("a dragged height is remembered as a share, clamped", () => {
  assert.equal(fracOf(900, 1800), 0.5);
  assert.equal(fracOf(10, 1800), 0.15);
  assert.equal(fracOf(1790, 1800), 0.85);
  assert.equal(fracOf(100, 0), STACK_DEFAULT.browser);
});

test("the Mac's default share fits its 16:10 screen at full width", () => {
  // 780 px wide: about 488 px of screen + its bar, well under half of a tall pane.
  const f = defaultFrac("mac", 780, 1800);
  assert.ok(f < STACK_DEFAULT.mac && f > 0.3, String(f));
  // A short pane: capped at the default share.
  assert.equal(defaultFrac("mac", 1400, 900), STACK_DEFAULT.mac);
  assert.equal(defaultFrac("browser", 780, 1800), STACK_DEFAULT.browser);
});

test("remembered shares: malformed values are dropped, out-of-range ones clamped", () => {
  assert.deepEqual(readStack(null), {});
  assert.deepEqual(readStack("not json"), {});
  assert.deepEqual(readStack("[1,2]"), {});
  assert.deepEqual(readStack('{"browser":0.4,"mac":"x","device":9,"other":0.3}'), { browser: 0.4, device: 0.85 });
});

test("splits: stacked shows a narrow side-by-side split top / bottom; wide never changes it", () => {
  assert.equal(splitDir("stacked", "row", 780), "col");
  assert.equal(splitDir("stacked", "row", 959), "col");
  assert.equal(splitDir("stacked", "row", 960), "row");
  assert.equal(splitDir("stacked", "col", 780), "col");
  assert.equal(splitDir("wide", "row", 500), "row");
  assert.equal(splitDir("stacked", "row", 0), "row");
});

test("the sidebar is remembered per arrangement", () => {
  assert.deepEqual(sidebarKeys("wide"), { open: "coool.sidebarOpen", width: "coool.sidebar" });
  assert.notEqual(sidebarKeys("stacked").open, sidebarKeys("wide").open);
  assert.notEqual(sidebarKeys("stacked").width, sidebarKeys("wide").width);
});

test("the Context panel goes below a chat in a stacked pane and beside it otherwise", () => {
  assert.equal(panelAxis("stacked", "context", 1080, 1700, 400), "y");
  assert.equal(panelAxis("wide", "context", 1440, 800, 400), "x");
  assert.equal(panelAxis("stacked", "context", 1080, 400, 400), "x");
  assert.equal(STACK_DEFAULT.context, 0.48);
});
