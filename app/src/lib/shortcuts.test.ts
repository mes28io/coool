// The shortcut table (lib/shortcuts.ts). Run: node --test app/src/lib/shortcuts.test.ts (Node 24 strips the types).

import assert from "node:assert/strict";
import { test } from "node:test";
import { matchShortcut, searchShortcuts, SHORTCUTS, type KeyEventLike } from "./shortcuts.ts";

const ev = (key: string, o: Partial<KeyEventLike> = {}): KeyEventLike => ({ key, metaKey: true, ctrlKey: false, shiftKey: false, ...o });

test("each global combo runs the right row", () => {
  const cases: [KeyEventLike, string | null][] = [
    [ev("k"), "palette"],
    [ev("K", { shiftKey: true }), "palette"],
    [ev("t"), "new"],
    [ev("T", { shiftKey: true }), null],
    [ev(","), "settings"],
    [ev("L", { shiftKey: true }), "theme"],
    [ev("l"), null],
    [ev("b"), "sidebar"],
    [ev("w"), "close"],
    [ev("\\"), "split-right"],
    [ev("|", { shiftKey: true, code: "Backslash" }), "split-down"],
    [ev("0"), "home"],
    [ev("1"), "tab"],
    [ev("9"), "tab"],
    [ev("!", { shiftKey: true }), null],
    [ev("k", { metaKey: false, ctrlKey: true }), "palette"],
    [ev("k", { metaKey: false }), null],
    [ev("Enter"), null],
  ];
  for (const [e, id] of cases) assert.equal(matchShortcut(e)?.id ?? null, id, `${e.shiftKey ? "⇧" : ""}${e.key}`);
});

test("no key event matches two global rows", () => {
  const keys = "abcdefghijklmnopqrstuvwxyz0123456789,.\\/;'[]".split("");
  for (const k of keys)
    for (const shiftKey of [false, true]) {
      const e = ev(shiftKey ? k.toUpperCase() : k, { shiftKey, code: k === "\\" ? "Backslash" : undefined });
      const hits = SHORTCUTS.filter((s) => s.match?.(e));
      assert.ok(hits.length <= 1, `${k} ${shiftKey}: ${hits.map((h) => h.id).join(", ")}`);
    }
});

test("rows are well formed", () => {
  const ids = new Set<string>();
  for (const s of SHORTCUTS) {
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
    ids.add(s.id);
    assert.ok(s.keys.length > 0 && s.label.length > 0);
    // A row is either run by the window handler or names where it is handled.
    assert.ok(!!s.match !== !!s.where, s.id);
  }
});

test("search", () => {
  assert.deepEqual(
    searchShortcuts("split").map((s) => s.id),
    ["split-right", "split-down"],
  );
  assert.deepEqual(
    searchShortcuts("dark").map((s) => s.id),
    ["theme"],
  );
  assert.equal(searchShortcuts("").length, SHORTCUTS.length);
  assert.equal(searchShortcuts("nothing like this").length, 0);
});
