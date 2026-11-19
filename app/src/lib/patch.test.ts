// Unit tests for lib/patch.ts: `node --test app/src/lib/patch.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { patchFiles, patchLead, patchPairs } from "./patch.ts";
import { permKind } from "./needs.ts";
import { riskOf } from "./risk.ts";

const CWD = "/Users/dev/code/app";
// The shape chat/codex.rs `patch_input` sends.
const input = {
  files: [`${CWD}/notes.md`, `${CWD}/new.txt`],
  changes: [
    { path: `${CWD}/notes.md`, kind: "update", diff: "@@ -1,3 +1,3 @@\n # Notes\n-owls\n+larks\n tail\n@@ -9 +9 @@\n-a\n+b\n" },
    { path: `${CWD}/new.txt`, kind: "add", diff: "hello\nworld\n" },
  ],
  reason: null,
};

test("patchFiles reads the changes; anything else is not a patch", () => {
  const f = patchFiles(input)!;
  assert.deepEqual(
    f.map((x) => [x.path.split("/").pop(), x.kind]),
    [
      ["notes.md", "update"],
      ["new.txt", "add"],
    ],
  );
  // Codex's own item shape (kind as an object) reads the same.
  assert.equal(patchFiles({ changes: [{ path: "/a", kind: { type: "delete" }, diff: "x" }] })![0].kind, "delete");
  assert.equal(patchFiles({ command: "ls" }), null);
  assert.equal(patchFiles({ changes: [] }), null);
  assert.equal(patchFiles(null), null);
});

test("patchPairs: one pair per hunk with its context; added files are all new text", () => {
  const [up, add] = patchFiles(input)!;
  assert.deepEqual(patchPairs(up), [
    ["# Notes\nowls\ntail", "# Notes\nlarks\ntail"],
    ["a", "b"],
  ]);
  assert.deepEqual(patchPairs(add), [["", "hello\nworld"]]);
  assert.deepEqual(patchPairs({ path: "/a", kind: "add", movePath: null, diff: "+one\n+two\n" }), [["", "one\ntwo"]]);
  assert.deepEqual(patchPairs({ path: "/a", kind: "delete", movePath: null, diff: "gone\n" }), [["gone", ""]]);
  assert.deepEqual(patchPairs({ path: "/a", kind: "update", movePath: null, diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-x\n\\ No newline at end of file\n+y\n" }), [["x", "y"]]);
});

test("a patch is an edit for the Needs you page, says what it does, and is Risky outside the folder", () => {
  assert.equal(permKind("apply_patch", input), "edit");
  assert.equal(patchLead(patchFiles(input)!), "change 2 files");
  assert.equal(patchLead([{ path: "/a", kind: "add", movePath: null, diff: "" }]), "create a file");
  assert.equal(riskOf("apply_patch", input, CWD), null);
  const out = { changes: [{ path: "/Users/dev/.zshrc", kind: "update", diff: "" }] };
  assert.match(riskOf("apply_patch", out, CWD)!.reason, /outside this chat's folder \(\/Users\/dev\/\.zshrc\)/);
  const moved = { changes: [{ path: `${CWD}/a.rs`, kind: "update", move_path: "/Users/dev/other/a.rs", diff: "" }] };
  assert.ok(riskOf("apply_patch", moved, CWD));
});
