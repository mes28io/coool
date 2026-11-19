// Unit tests for lib/voice/suggest.ts: `node --test app/src/lib/voice/suggest.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { aiNeeded, applyAll, applySuggestion, check, distance, phoneticKey, type SpellHit } from "./suggest.ts";
import { applyMemory, emptyMemory, recordAccept, recordDismiss, recordNever } from "./memory.ts";

const NOW = 1_800_000_000_000;
const brief = (s: { original: string; replacement: string; kind: string }) => [s.original, s.replacement, s.kind];

test("distance and phoneticKey", () => {
  assert.equal(distance("tori", "tauri"), 2);
  assert.equal(distance("tauree", "tauri"), 2);
  assert.equal(distance("ab", "ba"), 1);
  assert.equal(distance("kitten", "sitting"), 3);
  assert.equal(distance("kitten", "sitting", 1), 2); // gave up past 1
  assert.equal(phoneticKey("Tauri"), phoneticKey("tori"));
  assert.equal(phoneticKey("tory"), phoneticKey("Tauri"));
  assert.equal(phoneticKey("codecs"), phoneticKey("codex"));
  assert.notEqual(phoneticKey("tour"), phoneticKey("Tauri"));
  assert.notEqual(phoneticKey("tree"), phoneticKey("Tauri"));
});

test("term: a near miss of a library word, reason names it", () => {
  const out = check({ text: "Build it with Tori and Tauree.", memory: emptyMemory(), dictated: true });
  assert.deepEqual(out.map(brief), [
    ["Tori", "Tauri", "term"],
    ["Tauree", "Tauri", "term"],
  ]);
  assert.match(out[0].reason, /Tauri/);
  assert.ok(out[0].entryId);
});

test("term: common words and the library words themselves are not flagged", () => {
  const text = "Store the state in the config, then render the story with React, Rust and Tauri on a tour of the tree.";
  assert.deepEqual(check({ text, memory: emptyMemory(), dictated: true }), []);
});

test("term: multi-word windows and heard forms", () => {
  const out = check({ text: "ask cloud code to use zoo stand", memory: emptyMemory(), dictated: true });
  assert.deepEqual(out.map(brief), [
    ["cloud code", "Claude Code", "term"],
    ["zoo stand", "Zustand", "term"],
  ]);
});

test("memory: accepted once → offered as 'You fixed this before'; confirmed → applied, not suggested", () => {
  let m = recordAccept(emptyMemory(), "jest you", "Jesu", "edit", NOW);
  let out = check({ text: "ask jest you now", memory: m, dictated: true });
  assert.deepEqual(out.map(brief), [["jest you", "Jesu", "memory"]]);
  assert.equal(out[0].reason, "You fixed this before");
  m = recordAccept(m, "jest you", "Jesu", "edit", NOW);
  const applied = applyMemory(m, "ask jest you now").text;
  assert.equal(applied, "ask Jesu now");
  out = check({ text: applied, memory: m, dictated: true });
  assert.deepEqual(out, []);
});

test("suppressed pairs and Never are not suggested", () => {
  let m = recordDismiss(emptyMemory(), "Tori", "Tauri", NOW);
  assert.equal(check({ text: "use Tori", memory: m, dictated: true }).length, 1);
  m = recordDismiss(m, "Tori", "Tauri", NOW);
  assert.deepEqual(check({ text: "use Tori", memory: m, dictated: true }), []);
  m = recordAccept(emptyMemory(), "jest you", "Jesu", "edit", NOW);
  m = recordNever(m, "jest you", "Jesu", NOW);
  assert.deepEqual(check({ text: "ask jest you", memory: m, dictated: true }), []);
});

test("protected spans are never suggested in", () => {
  const text = "open tori.ts, useTori, `tori` and \"tori\" and /tori";
  assert.deepEqual(check({ text, memory: emptyMemory(), dictated: false, spell: [{ from: 5, to: 9, word: "tori", guesses: ["tore"] }] }), []);
});

test("spelling and grammar from macOS: first guess, library words dropped", () => {
  const text = "Teh Zustand store has an eror.";
  const spell: SpellHit[] = [
    { from: 0, to: 3, word: "Teh", guesses: ["The", "Ten"] },
    { from: 4, to: 11, word: "Zustand", guesses: ["Zealand"] },
    { from: text.indexOf("eror"), to: text.indexOf("eror") + 4, word: "eror", guesses: [] },
    { from: text.indexOf(" an ") + 1, to: text.indexOf(" an ") + 3, word: "an", guesses: ["a"], grammar: "Use “a” before a consonant sound" },
  ];
  const out = check({ text, memory: emptyMemory(), dictated: true, spell });
  assert.deepEqual(out.map(brief), [
    ["Teh", "The", "spelling"],
    ["an", "a", "grammar"],
  ]);
  assert.equal(out[1].reason, "Use “a” before a consonant sound");
});

test("priority and no overlap: memory > term > ai > spelling", () => {
  const text = "ship the tori build";
  const at = text.indexOf("tori");
  const out = check({
    text,
    memory: emptyMemory(),
    dictated: true,
    spell: [{ from: at, to: at + 4, word: "tori", guesses: ["tore"] }],
    ai: [{ from: at - 4, to: at + 4, original: "the tori", replacement: "the Tauri", reason: "term" }],
  });
  assert.deepEqual(out.map(brief), [["tori", "Tauri", "term"]]);
  const ai = check({ text: "fix there tests", memory: emptyMemory(), dictated: true, ai: [{ from: 4, to: 9, original: "there", replacement: "their", reason: "grammar" }] });
  assert.deepEqual(ai.map(brief), [["there", "their", "ai"]]);
});

test("cleanup only for typed text: repeated word, sentence-start filler, double space", () => {
  const text = "um, fix the the build.  Then ship";
  const typed = check({ text, memory: emptyMemory(), dictated: false });
  assert.deepEqual(typed.map(brief), [
    ["um, f", "F", "cleanup"],
    [" the", "", "cleanup"],
    ["  ", " ", "cleanup"],
  ]);
  assert.equal(applyAll(text, typed), "Fix the build. Then ship");
  assert.deepEqual(check({ text, memory: emptyMemory(), dictated: true }), []);
});

test("ids are stable; applySuggestion returns the caret", () => {
  const a = check({ text: "use Tori", memory: emptyMemory(), dictated: true });
  const b = check({ text: "use Tori", memory: emptyMemory(), dictated: true });
  assert.equal(a[0].id, b[0].id);
  assert.deepEqual(applySuggestion("use Tori now", a[0]), { text: "use Tauri now", caret: 9 });
});

test("aiNeeded: false when memory and the local checker cover the text", () => {
  const m = emptyMemory();
  assert.equal(aiNeeded("use the Tauri app with React and Rust", m, [], []), false);
  assert.equal(aiNeeded("open `weirdthing` in foo.ts", m, [], []), false);
  // An unknown word not flagged by spelling.
  assert.equal(aiNeeded("use the Grafana dashboard", m, [], []), true);
  // Flagged by spelling: the spelling suggestion covers it.
  assert.equal(aiNeeded("use the Grafana app", m, [{ from: 8, to: 15, word: "Grafana", guesses: [] }], []), false);
  // A local suggestion still open.
  const local = check({ text: "use Tori", memory: m, dictated: true });
  assert.equal(aiNeeded("use Tori", m, [], local), true);
});

test("memory: a near variant of a one-word fix made before is offered too", () => {
  const m = recordAccept(emptyMemory(), "Zustin", "Zustand", "edit", NOW);
  const s = check({ text: "move it into the Zustan store", memory: m, dictated: true });
  assert.deepEqual(s.map(brief), [["Zustan", "Zustand", "memory"]]);
  assert.match(s[0].reason, /fix you made before/);
  // Not for a different first letter.
  assert.equal(check({ text: "the Bustin store", memory: m, dictated: true }).filter((x) => x.kind === "memory").length, 0);
});
