// Unit tests for lib/voice/ranges.ts: `node --test app/src/lib/voice/ranges.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { diffEdit, dirtyRange, mapSpan } from "./ranges.ts";

test("diffEdit: one contiguous change", () => {
  assert.equal(diffEdit("abc", "abc"), null);
  assert.deepEqual(diffEdit("hello world", "hello big world"), { from: 6, removed: 0, inserted: 4 });
  assert.deepEqual(diffEdit("hello world", "hello"), { from: 5, removed: 6, inserted: 0 });
  assert.deepEqual(diffEdit("aaa", "aaaa"), { from: 3, removed: 0, inserted: 1 });
  assert.deepEqual(diffEdit("the tori app", "the Tauri app"), { from: 4, removed: 2, inserted: 3 });
});

test("mapSpan: edits before shift, after leave alone, touching drops", () => {
  const prev = "fix the tori app now";
  const s = { from: 8, to: 12, id: "x" }; // "tori"
  const before = diffEdit(prev, "please fix the tori app now")!;
  const moved = mapSpan(s, before)!;
  assert.deepEqual(moved, { from: 15, to: 19, id: "x" });
  assert.equal("please fix the tori app now".slice(moved.from, moved.to), "tori");
  assert.deepEqual(mapSpan(s, diffEdit(prev, "fix the tori app now!")!), s);
  assert.equal(mapSpan(s, diffEdit(prev, "fix the toari app now")!), null);
  assert.equal(mapSpan(s, diffEdit(prev, "fix the toris app now")!), null); // typed against its end
  assert.deepEqual(mapSpan(s, diffEdit(prev, "fix a tori app now")!), { from: 6, to: 10, id: "x" });
});

test("dirtyRange: whole words plus a neighbour, or the sentence", () => {
  const next = "One two. Fix the tauri app now. Three.";
  const e = diffEdit("One two. Fix the tori app now. Three.", next)!;
  const r = dirtyRange(next, e);
  assert.equal(next.slice(r.from, r.to), "the tauri app");
  const s = dirtyRange(next, e, true);
  assert.equal(next.slice(s.from, s.to), "Fix the tauri app now.");
  const start = dirtyRange("tauri x", { from: 0, removed: 0, inserted: 1 });
  assert.deepEqual(start, { from: 0, to: 7 });
});
