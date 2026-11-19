import assert from "node:assert/strict";
import { test } from "node:test";
import { shellTitle } from "./format.ts";

test("a wait loop is named for what it waits on, without its variables or long paths", () => {
  assert.equal(shellTitle('F=/private/tmp/claude-501/-Users-x/tasks/run.log; until grep -q done "$F"; do sleep 5; done'), "Waiting until grep -q done run.log");
  assert.equal(shellTitle("L=/private/tmp/a/b/out.txt\nwhile [ ! -s $L ]; do sleep 2; done"), "Waiting while ! -s out.txt");
});

test("other commands lose leading assignments and long paths only", () => {
  assert.equal(shellTitle("CARGO_TARGET_DIR=/private/tmp/x/y/tgt cargo test --workspace"), "cargo test --workspace");
  assert.equal(shellTitle("tail -f /Users/me/Library/Logs/app/run.log"), "tail -f run.log");
  assert.equal(shellTitle("pnpm -C app test"), "pnpm -C app test");
  assert.equal(shellTitle("X=1"), "X=1");
});
