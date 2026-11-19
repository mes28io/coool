// Unit tests for lib/voice/learn.ts: `node --test app/src/lib/voice/learn.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { learnFromEdit, singleWordFix } from "./learn.ts";

/** The whole field is the dictation. */
const all = (before: string, sent: string) => learnFromEdit(before, { from: 0, to: before.length }, sent);

test("a single-word fix", () => {
  const pairs = all("Add a new command to the tori backend please.", "Add a new command to the Tauri backend please.");
  assert.deepEqual(pairs, [{ heard: "tori", written: "Tauri" }]);
  assert.deepEqual(singleWordFix(pairs), { heard: "tori", written: "Tauri" });
});

test("a multi-word fix", () => {
  const pairs = all("Move the session list into the zoo stand store for the sidebar.", "Move the session list into the Zustand store for the sidebar.");
  assert.deepEqual(pairs, [{ heard: "zoo stand", written: "Zustand" }]);
  assert.equal(singleWordFix(pairs), null);
});

test("two small fixes in one dictation", () => {
  const pairs = all("Ask clawed to bump the tori version and run the tests again now.", "Ask Claude to bump the Tauri version and run the tests again now.");
  assert.deepEqual(pairs, [
    { heard: "clawed", written: "Claude" },
    { heard: "tori", written: "Tauri" },
  ]);
  assert.equal(singleWordFix(pairs), null);
});

test("a rewrite teaches nothing", () => {
  assert.deepEqual(all("Make the button blue and bigger please.", "Actually remove the button entirely from the page."), []);
  // More than three hunks.
  assert.deepEqual(
    all("one two three four five six seven eight nine ten eleven twelve thirteen", "one 2 three 4 five 6 seven 8 nine ten eleven twelve thirteen"),
    [],
  );
});

test("pure insertions and deletions teach nothing", () => {
  assert.deepEqual(all("Fix the failing test in the upload module.", "Fix the failing unit test in the upload module."), []);
  assert.deepEqual(all("Fix the failing test in the upload module.", "Fix the test in the upload module."), []);
});

test("punctuation-only and sentence-start case changes are ignored", () => {
  assert.deepEqual(all("fix it, then run the build again please", "Fix it. Then run the build again please."), []);
  assert.deepEqual(all("I dont know why the build fails here.", "I don't know why the build fails here."), []);
});

test("a case change mid-sentence is a pair", () => {
  assert.deepEqual(all("Push the branch to github and open a pull request.", "Push the branch to GitHub and open a pull request."), [{ heard: "github", written: "GitHub" }]);
});

test("edits outside the inserted span are ignored", () => {
  const typed = "Earlier text about tori. ";
  const dictated = "Now update the config file for the build.";
  const before = typed + dictated;
  const sent = "Earlier text about Tauri. " + dictated;
  assert.deepEqual(learnFromEdit(before, { from: typed.length, to: before.length }, sent), []);
  // The same fix inside the span is learned.
  const before2 = typed + "Now update the tori config file please.";
  const sent2 = typed + "Now update the Tauri config file please.";
  assert.deepEqual(learnFromEdit(before2, { from: typed.length, to: before2.length }, sent2), [{ heard: "tori", written: "Tauri" }]);
});

test("number changes are meaning changes, not mishearings", () => {
  assert.deepEqual(all("Set the retry count to 3 for the upload job.", "Set the retry count to 4 for the upload job."), []);
});

test("protected spans are not learned from", () => {
  assert.deepEqual(all("Open the tori.ts file and check the setup again.", "Open the tauri.ts file and check the setup again."), []);
  assert.deepEqual(all("Rename the useTori hook in the app shell now.", "Rename the useTauri hook in the app shell now."), []);
});

test("a short dictation can still teach one word", () => {
  assert.deepEqual(all("open tori", "open Tauri"), [{ heard: "tori", written: "Tauri" }]);
  assert.deepEqual(all("nothing changed here", "nothing changed here"), []);
});

test("singleWordFix", () => {
  assert.equal(singleWordFix([]), null);
  assert.deepEqual(singleWordFix([{ heard: "a", written: "b" }]), { heard: "a", written: "b" });
  assert.equal(
    singleWordFix([
      { heard: "a", written: "b" },
      { heard: "c", written: "d" },
    ]),
    null,
  );
});
