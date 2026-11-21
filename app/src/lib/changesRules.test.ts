// Unit tests for lib/changesRules.ts: `node --test app/src/lib/changesRules.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { commitDraft, gaps, nearestTurn, partners, reeditNote, splitRows, splitPath, textLines, totals, turnFiles, undoNote, unifiedText, type DiffLine } from "./changesRules.ts";

const L = (k: DiffLine["k"], t: string, o?: number, n?: number): DiffLine => ({ k, t, o, n });

test("split rows put a run of removals beside the additions after it", () => {
  const rows = splitRows([L(" ", "a", 1, 1), L("-", "b", 2), L("-", "c", 3), L("+", "B", undefined, 2), L(" ", "d", 4, 3)]);
  assert.equal(rows.length, 4);
  assert.deepEqual([rows[1].left?.t, rows[1].right?.t], ["b", "B"]);
  assert.deepEqual([rows[2].left?.t, rows[2].right], ["c", null]);
  assert.equal(rows[3].left, rows[3].right);
  // A new comment line above the changed line gets a row of its own; the line sits beside its new version.
  const r2 = splitRows([L("-", "const month = d.getMonth();", 8), L("+", "// zero-based", undefined, 8), L("+", "const month = d.getMonth() + 1;", undefined, 9)]);
  assert.deepEqual(r2.map((r) => [r.left?.t ?? null, r.right?.t ?? null]), [
    [null, "// zero-based"],
    ["const month = d.getMonth();", "const month = d.getMonth() + 1;"],
  ]);
});

test("word pairs: the k-th removal with the k-th addition, never wildly different lengths", () => {
  const lines = [L("-", "const month = d.getMonth();"), L("+", "const month = d.getMonth() + 1;"), L(" ", "x"), L("-", "a"), L("+", "a very much longer line than the one it replaced, by far")];
  const p = partners(lines);
  assert.deepEqual(p.slice(0, 2), [1, 0]);
  assert.equal(p[2], -1);
  assert.deepEqual(p.slice(3), [-1, -1]);
  // A comment added above the changed line: the line pairs with its new version, not the comment.
  const q = partners([L("-", "const month = d.getMonth();"), L("+", "// getMonth() is zero-based: March is 2."), L("+", "const month = d.getMonth() + 1;")]);
  assert.deepEqual(q, [2, -1, 0]);
});

test("gaps between hunks and after the last one", () => {
  const g = gaps(
    [
      { new_start: 5, new_count: 7 },
      { new_start: 30, new_count: 6 },
    ],
    50,
  );
  assert.deepEqual(g.before, [[1, 4], [12, 29]]);
  assert.deepEqual(g.after, [36, 50]);
  assert.deepEqual(gaps([{ new_start: 1, new_count: 3 }], 3), { before: [null], after: null });
  // No text known: nothing after.
  assert.equal(gaps([{ new_start: 1, new_count: 3 }], null).after, null);
});

test("text lines drop the final newline's empty piece and CRs", () => {
  assert.deepEqual(textLines("a\r\nb\n"), ["a", "b"]);
  assert.deepEqual(textLines("a\nb"), ["a", "b"]);
});

test("a timeline turn finds its transcript turn by prompt, then time, then order", () => {
  const turns = [
    { n: 1, ts: 1_000_000, prompt: "Fix the March month" },
    { n: 2, ts: 2_000_000, prompt: "Add tests" },
  ];
  assert.equal(nearestTurn(turns, 0, "Add tests"), 2);
  assert.equal(nearestTurn(turns, 1_900_000), 2);
  assert.equal(nearestTurn(turns, 99_000_000, undefined, 1), 1);
  assert.equal(nearestTurn([], 5), null);
});

test("the agent's commit message comes out of its reply", () => {
  assert.equal(commitDraft("Here you go:\n```\nFix the March month\n\nformatPeriod used getMonth().\n```\n"), "Fix the March month\n\nformatPeriod used getMonth().");
  assert.equal(commitDraft('Commit message: "Round the total once"'), "Round the total once");
  assert.equal(commitDraft("   "), null);
});

test("notes to the agent name the files", () => {
  assert.match(undoNote(["src/a.ts"], 12), /undid your change to src\/a\.ts \(around line 12\)/);
  assert.match(undoNote(["a", "b", "c", "d", "e", "f"]), /and 2 more/);
  assert.match(reeditNote(["src/a.ts"]), /edited it again/);
});

test("copy diff gives unified text", () => {
  const t = unifiedText({ rel: "a.txt", status: "modified", hunks: [{ id: "x", old_start: 1, old_count: 2, new_start: 1, new_count: 2, added: 1, removed: 1, kept: false, since: false, lines: [L(" ", "a", 1, 1), L("-", "b", 2), L("+", "B", undefined, 2)] }] });
  assert.equal(t, "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n");
  assert.match(unifiedText({ rel: "n.txt", status: "added", hunks: [] }), /^--- \/dev\/null/);
});

test("paths, totals, and the files a turn changed", () => {
  assert.deepEqual(splitPath("src/lib/a.ts"), ["src/lib/", "a.ts"]);
  assert.deepEqual(splitPath("a.ts"), ["", "a.ts"]);
  assert.deepEqual(totals([{ added: 3, removed: 1, status: "modified" }, { added: 9, removed: 0, status: "undone" }]), { files: 1, added: 3, removed: 1 });
  const files = turnFiles([
    { name: "Edit", ok: true, input: { file_path: "/w/a.ts" } },
    { name: "Write", ok: false, input: { file_path: "/w/failed.ts" } },
    { name: "Read", ok: true, input: { file_path: "/w/r.ts" } },
    { name: "apply_patch", ok: true, input: { changes: [{ path: "/w/b.ts" }, { path: "/w/old.ts", move_path: "/w/new.ts" }] } },
    { name: "apply_patch", ok: true, input: "*** Begin Patch\n*** Add File: /w/c.ts\n+x\n*** End Patch" },
  ]);
  assert.deepEqual(files.sort(), ["/w/a.ts", "/w/b.ts", "/w/c.ts", "/w/new.ts"]);
});
