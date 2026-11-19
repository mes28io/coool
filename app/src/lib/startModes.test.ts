// Unit tests for lib/startModes.ts: `node --test app/src/lib/startModes.test.ts` (Node 22.6+ strips the types).

import { test } from "node:test";
import assert from "node:assert/strict";
import { modeWords, START_MODES, startProvider } from "./startModes.ts";

const both = { claude: true, codex: true };

test("the caller's choice wins, then the chosen default, then the folder's, then Claude Code", () => {
  assert.equal(startProvider("codex", "claude", "claude", both), "codex");
  assert.equal(startProvider(undefined, "codex", "claude", both), "codex");
  assert.equal(startProvider(undefined, null, "codex", both), "codex");
  assert.equal(startProvider(undefined, null, undefined, both), "claude");
});

test("a CLI that isn't installed gives way to one that is; unknown keeps the choice", () => {
  assert.equal(startProvider(undefined, "codex", undefined, { claude: true, codex: false }), "claude");
  assert.equal(startProvider(undefined, null, undefined, { claude: false, codex: true }), "codex");
  assert.equal(startProvider(undefined, "codex", undefined, { claude: false, codex: false }), "codex");
  assert.equal(startProvider(undefined, "codex", undefined, null), "codex");
});

test("onboarding modes never include the never-ask ones", () => {
  const ids = [...START_MODES.claude, ...START_MODES.codex].map((m) => m.id);
  assert.deepEqual(ids, ["default", "acceptEdits", "plan", "untrusted", "on-request", "on-failure"]);
  assert.equal(modeWords("claude", "acceptEdits"), "Edit files freely, ask before commands");
  assert.equal(modeWords("claude", null), null);
  assert.equal(modeWords("claude", "bypassPermissions"), "bypassPermissions");
});
