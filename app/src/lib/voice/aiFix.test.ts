// Unit tests for lib/voice/aiFix.ts: `node --test app/src/lib/voice/aiFix.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { aiCacheKey, cachedFixes, cacheFixes, validateAiFixes } from "./aiFix.ts";
import { emptyMemory, MAX_AI_CACHE } from "./memory.ts";

const text = "Ask clawed to fix there tests in tori.ts before the release.";
const at = (s: string) => text.indexOf(s);

test("validateAiFixes: a good fix is kept", () => {
  const raw = { fixes: [{ from: at("clawed"), to: at("clawed") + 6, original: "clawed", replacement: "Claude", reason: "mishearing" }] };
  assert.deepEqual(validateAiFixes(text, raw), [{ from: 4, to: 10, original: "clawed", replacement: "Claude", reason: "mishearing" }]);
});

test("validateAiFixes: wrong offsets are corrected when the original occurs once", () => {
  const out = validateAiFixes(text, { fixes: [{ from: 0, to: 3, original: "there", replacement: "their", reason: "grammar" }] });
  assert.deepEqual(out, [{ from: at("there"), to: at("there") + 5, original: "there", replacement: "their", reason: "grammar" }]);
  // Ambiguous: "the" occurs more than once.
  assert.deepEqual(validateAiFixes(text, { fixes: [{ from: 0, to: 3, original: "the", replacement: "a", reason: "grammar" }] }), []);
});

test("validateAiFixes: protected spans, rewrites, bad reasons and overlaps are dropped", () => {
  const fix = (o: Record<string, unknown>) => validateAiFixes(text, { fixes: [o] });
  assert.deepEqual(fix({ from: at("tori.ts"), to: at("tori.ts") + 7, original: "tori.ts", replacement: "tauri.ts", reason: "term" }), []);
  assert.deepEqual(fix({ from: 0, to: text.length, original: text, replacement: "Something else entirely.", reason: "grammar" }), []);
  assert.deepEqual(fix({ from: 4, to: 10, original: "clawed", replacement: "Claude, the assistant made by a company that", reason: "term" }), []);
  assert.deepEqual(fix({ from: 4, to: 10, original: "clawed", replacement: "Claude", reason: "style" }), []);
  assert.deepEqual(fix({ from: 4, to: 10, original: "clawed", replacement: "clawed", reason: "term" }), []);
  assert.deepEqual(fix({ from: 4, to: 10, original: "", replacement: "x", reason: "term" }), []);
  const two = validateAiFixes(text, {
    fixes: [
      { from: 4, to: 13, original: "clawed to", replacement: "Claude to", reason: "term" },
      { from: 4, to: 10, original: "clawed", replacement: "Claude", reason: "term" },
    ],
  });
  assert.equal(two.length, 1);
});

test("validateAiFixes: garbage never throws", () => {
  for (const raw of [null, undefined, 3, "x", [], { fixes: "no" }, { fixes: [null, 1, "a", { from: "a" }] }, { fixes: [{ get from() { throw new Error("x"); } }] }])
    assert.deepEqual(validateAiFixes(text, raw), []);
});

test("validateAiFixes: at most 12 fixes", () => {
  const t = Array.from({ length: 20 }, (_, i) => "wrd" + String.fromCharCode(97 + i)).join(" ");
  const fixes = t.split(" ").map((w) => ({ from: t.indexOf(w), to: t.indexOf(w) + w.length, original: w, replacement: w + "x", reason: "mishearing" }));
  assert.equal(validateAiFixes(t, { fixes }).length, 12);
});

test("aiCacheKey: stable, whitespace-insensitive, mode-sensitive; cachedFixes hits", () => {
  assert.equal(aiCacheKey("fix  the tori\nbuild", "fix"), aiCacheKey("fix the tori build", "fix"));
  assert.notEqual(aiCacheKey("fix the tori build", "fix"), aiCacheKey("fix the tori build", "polish"));
  assert.notEqual(aiCacheKey("a", "fix"), aiCacheKey("b", "fix"));
  const key = aiCacheKey(text, "fix");
  let m = emptyMemory();
  assert.equal(cachedFixes(m, key), null);
  const fixes = validateAiFixes(text, { fixes: [{ from: 4, to: 10, original: "clawed", replacement: "Claude", reason: "mishearing" }] });
  m = cacheFixes(m, key, fixes, 1);
  assert.deepEqual(cachedFixes(m, key), fixes);
  m = cacheFixes(m, key, [], 2);
  assert.equal(m.aiCache.length, 1);
  for (let i = 0; i < MAX_AI_CACHE + 5; i++) m = cacheFixes(m, "k" + i, [], 10 + i);
  assert.equal(m.aiCache.length, MAX_AI_CACHE);
  assert.equal(cachedFixes(m, key), null);
});
