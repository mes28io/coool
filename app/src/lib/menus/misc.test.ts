// Run: node --test app/src/lib/menus/misc.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachMenu, commitMenu, historyMenu, mediaMenu, missionSessionMenu, settingMenu } from "./misc.ts";

const labels = (m: unknown[]) => m.filter(Boolean).map((i) => (i === "-" ? "-" : (i as { label: string }).label));
const noop = () => {};

test("attachment menu: remove only on drafts, path items only with a path", () => {
  assert.deepEqual(labels(attachMenu({ name: "a.png", path: "/x/a.png", open: noop, reveal: noop })), ["Quick look", "-", "Reveal in Finder", "Copy path"]);
  assert.deepEqual(labels(attachMenu({ name: "a.png", reveal: noop, remove: noop })), ["Copy name", "-", "Remove"]);
});

test("media menu: copy and reveal need a token", () => {
  assert.deepEqual(labels(mediaMenu({ name: "a", token: "t", path: "/a", open: noop, copy: noop, reveal: noop })), ["Open in viewer", "-", "Copy", "Reveal in Finder", "Copy path"]);
  assert.deepEqual(labels(mediaMenu({ name: "a", token: null, open: noop, copy: noop, reveal: noop })), ["Open in viewer"]);
});

test("history menu: a missing folder offers to make it again", () => {
  const d = { open: noop, reveal: noop, makeFolder: noop };
  assert.ok(labels(historyMenu({ ...d, row: { id: "1", cwd: "/p", missing: false } })).includes("Reveal folder in Finder"));
  const gone = labels(historyMenu({ ...d, row: { id: "1", cwd: "/p", missing: true } }));
  assert.ok(gone.includes("Make the folder again") && !gone.includes("Reveal folder in Finder"));
});

test("setting, session and commit menus", () => {
  assert.deepEqual(labels(settingMenu({ name: "Theme", value: "Dark" })), ["Copy value", "Copy setting name"]);
  assert.deepEqual(labels(settingMenu({ name: "Theme", value: null })), ["Copy setting name"]);
  assert.deepEqual(labels(missionSessionMenu({ id: "1", folder: "", open: noop, reveal: noop })), ["Open session", "-", "Copy session ID"]);
  assert.deepEqual(labels(commitMenu({ sha: "abc", short: "a", subject: "s" })), ["Copy commit SHA", "Copy short SHA", "Copy message"]);
});
