// Session titles on the UI side (CHAT_SPEC "Session titles"): one title for every surface,
// previous titles for search and the tooltip. Run: node --test app/src/lib/titles.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { displayTitle, matchPrevious, previousTitles, titlePinned, titleWas } from "./format.ts";
import { score } from "./fuzzy.ts";

const base = { title: "Claude Code fast mode credits", last_prompt: "and the sidebar", cwd: "/Users/x/coool" };

test("the backend's resolved title wins everywhere", () => {
  const s = { ...base, name: { title: "coool: desktop app", source: "auto" as const, previous: ["Claude Code fast mode credits"] } };
  assert.equal(displayTitle(s), "coool: desktop app");
  // The insight headline (a status line that changes every turn) never becomes the title.
  assert.equal(displayTitle({ ...s, insight: { headline: "Running the tests", needs_you: null, generated_ms: 0 } }), "coool: desktop app");
  // Older backends without `name`: the CLI's name as before.
  assert.equal(displayTitle(base), "Claude Code fast mode credits");
});

test("previous titles and the tooltip", () => {
  const s = { ...base, name: { title: "RawLog fixes", source: "manual" as const, previous: ["RawLog fixes", "Fix RawLog offset clamp", "Old name"] } };
  assert.deepEqual(previousTitles(s), ["Fix RawLog offset clamp", "Old name"]);
  assert.equal(titleWas(s), "was: Fix RawLog offset clamp, Old name");
  assert.equal(titlePinned(s), true);
  assert.equal(titleWas({ ...base, name: { title: "x", source: "first" as const } }), null);
});

test("search finds a session by what it used to be called", () => {
  const previous = ["Claude Code fast mode credits"];
  const current = score("fast mode", "coool: desktop app");
  const m = matchPrevious("fast mode", previous, current, score);
  assert.equal(m?.title, "Claude Code fast mode credits");
  // A current-title match ranks above the same match on an old name.
  const now = score("desktop", "coool: desktop app");
  assert.equal(matchPrevious("desktop", ["coool: desktop app"], now, score), null);
  assert.equal(matchPrevious("", previous, 1, score), null);
  assert.equal(matchPrevious("zzz", previous, 0, score), null);
});
