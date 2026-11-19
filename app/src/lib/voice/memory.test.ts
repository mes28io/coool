// Unit tests for lib/voice/memory.ts: `node --test app/src/lib/voice/memory.test.ts`.
// The dictionary cases are 2relay's MisspellingDictionaryTests, on a memory without the seed.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addWord,
  applyMemory,
  emptyMemory,
  exportMemory,
  importMemory,
  initialPrompt,
  MAX_AI_CACHE,
  MAX_UNCONFIRMED,
  offered,
  parseMemory,
  PHRASES,
  prune,
  recordAccept,
  recordAlways,
  recordDismiss,
  recordNever,
  recordUse,
  removeEntry,
  SEED,
  STALE_DAYS,
  suppressed,
  type Entry,
  type Memory,
} from "./memory.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const bare = (): Memory => ({ ...emptyMemory(), entries: [] });
const apply = (m: Memory, t: string) => applyMemory(m, t).text;
const entry = (m: Memory, written: string) => m.entries.find((e) => e.written === written);

test("2relay: add and apply a correction", () => {
  const m = recordAlways(bare(), "cloud", "Claude", "you", NOW);
  assert.equal(apply(m, "please open cloud code"), "please open Claude code");
});

test("2relay: case-insensitive and whole-word", () => {
  const m = recordAlways(bare(), "cloud", "Claude", "you", NOW);
  assert.equal(apply(m, "CLOUD"), "Claude");
  assert.equal(apply(m, "cloudy"), "cloudy");
});

test("2relay: update an existing correction, and remove it", () => {
  let m = recordAlways(bare(), "cloud", "Claude", "you", NOW);
  m = recordAlways(m, "cloud", "Claude Code", "you", NOW + 1);
  // The heard form moves to the new word; the old one keeps no form of it.
  assert.deepEqual(entry(m, "Claude")?.heard, []);
  assert.deepEqual(entry(m, "Claude Code")?.heard, ["cloud"]);
  assert.equal(apply(m, "cloud"), "Claude Code");
  m = removeEntry(m, entry(m, "Claude Code")!.id);
  assert.equal(apply(m, "cloud"), "cloud");
});

test("applyMemory: longest first, multi-word across any whitespace", () => {
  const m = emptyMemory();
  assert.equal(apply(m, "open cloud code and ask clawed"), "open Claude Code and ask Claude");
  assert.equal(apply(m, "use type\n  script with git hub"), "use TypeScript with GitHub");
  assert.equal(apply(m, "the zoo stand store on local host"), "the Zustand store on localhost");
});

test("applyMemory: case rules and Applied offsets", () => {
  const m = emptyMemory();
  const r = applyMemory(m, "Local host is up. Local host again, and github too.");
  assert.equal(r.text, "Localhost is up. Localhost again, and GitHub too.");
  assert.deepEqual(
    r.applied.map((a) => [a.original, a.written, r.text.slice(a.from, a.to)]),
    [
      ["Local host", "Localhost", "Localhost"],
      ["Local host", "Localhost", "Localhost"],
      ["github", "GitHub", "GitHub"],
    ],
  );
  assert.equal(r.applied[0].entryId, entry(m, "localhost")!.id);
  // Mid-sentence keeps the written form as is.
  assert.equal(apply(m, "on Local host"), "on localhost");
  // A written form with a capital is exact even at a sentence start.
  assert.equal(apply(m, "Tori app"), "Tauri app");
});

test("applyMemory: never inside protected spans", () => {
  const m = emptyMemory();
  assert.equal(apply(m, "open tori.ts and useTori, `tori`, \"tori\" and tori"), "open tori.ts and useTori, `tori`, \"tori\" and Tauri");
  assert.equal(apply(m, "see https://tori.dev/tori"), "see https://tori.dev/tori");
});

test("applyMemory: phrases that are on", () => {
  let m = emptyMemory();
  assert.equal(apply(m, "first point. New line. second point new paragraph third"), "first point.\nsecond point\n\nthird");
  assert.equal(apply(m, "slash compact now"), "slash compact now");
  m = { ...m, phrases: m.phrases.map((p) => (p.spoken === "slash compact" || p.spoken === "open paren" || p.spoken === "close paren" ? { ...p, on: true } : p)) };
  const r = applyMemory(m, "slash compact open paren x close paren");
  assert.equal(r.text, "/compact (x)");
  assert.equal(r.applied[0].entryId, "phrase:slash compact");
});

test("seed: conservative heard forms, builtin phrases", () => {
  const common = new Set(["cool", "cloud", "rust", "react", "jason", "code", "next", "node"]);
  for (const s of SEED) for (const h of s.heard) assert.ok(!common.has(h), h);
  const m = emptyMemory();
  assert.ok(m.entries.every((e) => e.source === "seed" && e.confirmed));
  assert.equal(new Set(m.entries.map((e) => e.id)).size, m.entries.length);
  assert.deepEqual(
    m.phrases.filter((p) => p.on).map((p) => p.spoken),
    ["new line", "new paragraph"],
  );
  assert.equal(PHRASES.length, m.phrases.length);
  assert.equal(apply(m, "the cloud is cool, rust and react"), "the cloud is cool, rust and react");
});

test("learning: accept once → offered, twice → confirmed and applied", () => {
  let m = recordAccept(emptyMemory(), "jest you", "Jesu", "edit", NOW);
  assert.equal(apply(m, "jest you"), "jest you");
  assert.deepEqual(
    offered(m).map((e) => e.written),
    ["Jesu"],
  );
  m = recordAccept(m, "jest you", "Jesu", "edit", NOW + 1);
  assert.equal(offered(m).length, 0);
  assert.equal(entry(m, "Jesu")?.confirmed, true);
  assert.equal(apply(m, "ask jest you"), "ask Jesu");
});

test("learning: a new form of a known word needs its own two acceptances", () => {
  let m = recordAccept(emptyMemory(), "tauree", "Tauri", "edit", NOW);
  assert.equal(apply(m, "tauree"), "tauree");
  assert.ok(offered(m).some((e) => e.written === "Tauri"));
  m = recordAccept(m, "tauree", "Tauri", "edit", NOW);
  assert.equal(apply(m, "tauree"), "Tauri");
});

test("learning: Always once → applied; Never → not applied nor offered", () => {
  let m = recordAlways(bare(), "pie torch", "PyTorch", "you", NOW);
  assert.equal(apply(m, "use pie torch"), "use PyTorch");
  m = recordNever(m, "pie torch", "PyTorch", NOW);
  assert.equal(apply(m, "use pie torch"), "use pie torch");
  assert.equal(offered(m).length, 0);
  assert.equal(suppressed(m, "pie torch", "PyTorch"), true);
  // Never on one form of a seed word mutes only that form.
  m = recordNever(emptyMemory(), "tori", "Tauri", NOW);
  assert.equal(apply(m, "tori and tory"), "tori and Tauri");
  assert.equal(suppressed(m, "tori", "Tauri"), true);
  assert.equal(suppressed(m, "tory", "Tauri"), false);
});

test("learning: two dismissals suppress (a stub is created for an unknown pair)", () => {
  let m = recordDismiss(bare(), "there", "their", NOW);
  assert.equal(suppressed(m, "there", "their"), false);
  assert.equal(entry(m, "their")?.confirmed, false);
  m = recordDismiss(m, "there", "their", NOW);
  assert.equal(suppressed(m, "there", "their"), true);
  assert.equal(suppressed(m, "thier", "their"), false);
  assert.equal(apply(m, "there"), "there");
  // The stub is not a library word.
  assert.equal(initialPrompt(m), "");
});

test("recordUse: counts uses and the last use", () => {
  const m = emptyMemory();
  const id = entry(m, "Tauri")!.id;
  const n = recordUse(m, [id, "phrase:new line"], NOW);
  assert.equal(entry(n, "Tauri")?.uses, 1);
  assert.equal(entry(n, "Tauri")?.lastUsed, NOW);
  assert.equal(entry(m, "Tauri")?.uses, 0); // pure
});

test("initialPrompt: the person's words first (uses, then recency), seed after, cut between words", () => {
  let m = emptyMemory();
  m = addWord(m, "Grafana", [], "you", NOW - 10);
  m = addWord(m, "Supabase", [], "you", NOW - 5);
  m = addWord(m, "Vercel", [], "you", NOW - 1);
  m = recordUse(m, [entry(m, "Grafana")!.id], NOW - 3);
  const p = initialPrompt(m);
  assert.ok(p.startsWith("Glossary: Grafana, Vercel, Supabase, "), p);
  assert.ok(p.endsWith("."));
  assert.ok(p.includes("Tauri"));
  const short = initialPrompt(m, 40);
  assert.equal(short, "Glossary: Grafana, Vercel, Supabase.");
  assert.ok(short.length <= 40);
  assert.equal(initialPrompt(bare()), "");
  assert.ok(initialPrompt(emptyMemory()).length <= 600);
});

test("export/import: round trip, merge, malformed input", () => {
  let m = recordAlways(emptyMemory(), "pie torch", "PyTorch", "you", NOW);
  const json = exportMemory(m);
  const parsed = parseMemory(JSON.parse(json), NOW);
  assert.deepEqual(parsed.entries.map((e) => e.written).sort(), m.entries.map((e) => e.written).sort());
  const written = JSON.parse(json).entries.map((e: Entry) => e.written);
  assert.deepEqual(written, [...written].sort((a: string, b: string) => a.localeCompare(b)));
  assert.equal(apply(parsed, "pie torch"), "PyTorch");

  const r = importMemory(
    m,
    JSON.stringify({
      entries: [
        { written: "PyTorch", heard: ["pi torch"], accepts: 5, confirmed: true },
        { written: "Svelte", heard: ["svelt"] },
        { heard: ["nothing"] },
        "junk",
      ],
    }),
    NOW,
  );
  assert.equal(r.added, 1);
  assert.equal(r.merged, 1);
  assert.equal(r.errors.length, 2);
  m = r.memory;
  assert.deepEqual(entry(m, "PyTorch")?.heard, ["pie torch", "pi torch"]);
  assert.equal(entry(m, "PyTorch")?.accepts, 5);
  assert.equal(entry(m, "Svelte")?.source, "import");
  assert.equal(new Set(m.entries.map((e) => e.id)).size, m.entries.length);

  assert.deepEqual(importMemory(m, "{nope", NOW).errors.length, 1);
  assert.equal(parseMemory("garbage", NOW).entries.length, SEED.length);
  assert.equal(parseMemory({ entries: [{ written: 3 }, null] }, NOW).entries.length, 0);
  assert.equal(parseMemory({ entries: [] }, NOW).phrases.length, PHRASES.length);
});

test("parseMemory: same written merges; a heard form shared by two words goes to the person's one", () => {
  const m = parseMemory(
    {
      entries: [
        { id: "e1", written: "Tauri", heard: ["tori"], source: "seed", confirmed: true, lastUsed: 1 },
        { id: "e1", written: "Tauri", heard: ["TORY", "tori"], accepts: 3 },
        { id: "e9", written: "Tory", heard: ["tori"], source: "you", confirmed: true, lastUsed: 2 },
      ],
    },
    NOW,
  );
  assert.equal(m.entries.length, 2);
  assert.deepEqual(entry(m, "Tauri")?.heard, ["TORY"]);
  assert.equal(entry(m, "Tauri")?.accepts, 3);
  assert.deepEqual(entry(m, "Tory")?.heard, ["tori"]);
});

test("prune: stale unconfirmed pairs dropped, caps kept, AI cache bounded", () => {
  let m = emptyMemory();
  m = recordAccept(m, "old one", "Old", "edit", NOW - (STALE_DAYS + 1) * DAY);
  m = recordAccept(m, "new one", "New", "edit", NOW - DAY);
  for (let i = 0; i < MAX_UNCONFIRMED + 5; i++) m = { ...m, entries: [...m.entries, { ...entry(m, "New")!, id: "x" + i, written: "W" + i, heard: ["w" + i], lastUsed: NOW - i }] };
  m = { ...m, aiCache: Array.from({ length: MAX_AI_CACHE + 3 }, (_, i) => ({ key: "k" + i, fixes: [], at: i })) };
  const p = prune(m, NOW);
  assert.equal(entry(p, "Old"), undefined);
  assert.ok(entry(p, "Tauri"));
  assert.equal(p.entries.filter((e) => !e.confirmed && e.heard.length > 0).length, MAX_UNCONFIRMED);
  assert.ok(entry(p, "W0"));
  assert.equal(entry(p, "W" + (MAX_UNCONFIRMED + 4)), undefined);
  assert.equal(p.aiCache.length, MAX_AI_CACHE);
  assert.equal(p.aiCache[0].key, "k3");
});
