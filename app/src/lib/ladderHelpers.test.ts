import { test } from "node:test";
import assert from "node:assert/strict";
import { descendants, markHelpers, rootOf, treeOrder, type HelperInfo } from "./ladderHelpers.ts";

const h = (parent: number, depth = 1): HelperInfo => ({ parent, depth, model: "haiku", title: "t", worktree: null, done: false });

test("a helper's session nests under its caller's session; others keep their identity", () => {
  const lead = { id: "L", chat: 1 };
  const kid = { id: "K", chat: 2 };
  const other = { id: "O", chat: 3 };
  const before = [lead, kid, other];
  const out = markHelpers(before, { 2: h(1) }, (c) => (c === 1 ? "L" : null));
  assert.notEqual(out, before);
  assert.equal(out[0], lead);
  assert.equal(out[2], other);
  assert.deepEqual(out[1], { id: "K", chat: 2, nested: true, parent: "L" });
  // Already marked, or the caller has no session yet: the same array back.
  assert.equal(markHelpers(out, { 2: h(1) }, () => "L"), out);
  assert.equal(markHelpers(before, { 2: h(1) }, () => null), before);
  assert.equal(markHelpers(before, {}, () => "L"), before);
});

test("descendants walk the tree depth first with depths", () => {
  const kids: Record<string, string[]> = { L: ["A", "B"], A: ["A1"], A1: ["A2"] };
  const d = descendants("L", (id) => kids[id] ?? [], (x) => x);
  assert.deepEqual(d.map((x) => [x.item, x.depth, x.parent]), [
    ["A", 1, "L"],
    ["A1", 2, "A"],
    ["A2", 3, "A1"],
    ["B", 1, "L"],
  ]);
  // A cap on depth.
  assert.equal(descendants("L", (id) => kids[id] ?? [], (x) => x, 2).length, 3);
});

test("tree order keeps each child under its parent", () => {
  const cards = [
    { id: "c", parentRef: "a" },
    { id: "b" },
    { id: "a" },
    { id: "d", parentRef: "c" },
    { id: "x", parentRef: "gone" },
  ];
  assert.deepEqual(treeOrder(cards).map((c) => c.id), ["b", "a", "c", "d", "x"]);
  const byId = new Map(cards.map((c) => [c.id, c]));
  assert.equal(rootOf(cards[3], byId), "a");
  assert.equal(rootOf(cards[4], byId), "x");
});
