// Unit tests for lib/voice/clean.ts: `node --test app/src/lib/voice/clean.test.ts`.
// The first cases are 2relay's PromptCleanerTests, adapted: the "- " bullet is dropped and empty input gives "".

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTranscript, normalizeWhitespace, removeFillers, removeRepeatedPhrases, removeStutters, stripArtefacts } from "./clean.ts";
import { applyMemory, emptyMemory } from "./memory.ts";

test("2relay: the transcript comes back as is (no template, no bullet)", () => {
  const raw = "Hey claude, today we are going to design a website with you. Are you ready?";
  const out = cleanTranscript(raw);
  assert.equal(out, raw);
  assert.ok(!out.includes("Context:") && !out.includes("Constraints:") && !out.startsWith("- "));
});

test("2relay: whitespace is normalised", () => {
  assert.equal(normalizeWhitespace("  Hey   claude,\n\ntoday   we build  this  "), "Hey claude, today we build this");
  assert.equal(cleanTranscript("  Hey   claude,\n\ntoday   we build  this  "), "Hey claude, today we build this.");
});

test("2relay: empty input gives an empty string (2relay said 'No transcript captured.')", () => {
  assert.equal(cleanTranscript("   \n  "), "");
});

test("removeFillers: the 2relay list, and the punctuation left behind", () => {
  assert.equal(removeFillers("um I think uhh we hmmm should"), "I think we should");
  assert.equal(removeFillers("Um, so, uh, add it"), "so, add it");
  assert.equal(removeFillers("it works, you know."), "it works.");
  assert.equal(removeFillers("I mean, the build, er, fails"), "the build, fails");
  assert.equal(removeFillers("fine, um"), "fine");
  // Whole words only.
  assert.equal(removeFillers("the summer umbrella errand"), "the summer umbrella errand");
});

test("removeStutters: hyphen stutters and consecutive duplicates", () => {
  assert.equal(removeStutters("b-b-but it works"), "but it works");
  assert.equal(removeStutters("the-the end"), "the end");
  assert.equal(removeStutters("add a retry with with backoff"), "add a retry with backoff");
  assert.equal(removeStutters("to the, the upload"), "to the upload");
  assert.equal(removeStutters("Hello. hello."), "Hello.");
  assert.equal(removeStutters("re-read the file"), "re-read the file");
});

test("removeRepeatedPhrases: 2 to 4 word windows", () => {
  assert.equal(removeRepeatedPhrases("open the file open the file now"), "open the file now");
  assert.equal(removeRepeatedPhrases("we need to we need to fix it"), "we need to fix it");
  assert.equal(removeRepeatedPhrases("one two three"), "one two three");
  assert.equal(removeRepeatedPhrases("go to the go to the store"), "go to the store");
});

test("stripArtefacts: Whisper's markers and silence hallucinations", () => {
  assert.equal(stripArtefacts("[BLANK_AUDIO]"), "");
  assert.equal(stripArtefacts("[MUSIC] fix the build (music) ♪ *laughs* [Silence]"), "fix the build");
  assert.equal(stripArtefacts("Thank you."), "");
  assert.equal(stripArtefacts("Thanks for watching!"), "");
  assert.equal(stripArtefacts("Subtitles by the Amara.org community"), "");
  assert.equal(stripArtefacts(" you "), "");
  assert.equal(stripArtefacts("Thank you, now fix the tests."), "Thank you, now fix the tests.");
  assert.equal(stripArtefacts("check arr[0] and (see) this"), "check arr[0] and (see) this");
});

test("cleanTranscript: the full pass, then memory with the seed dictionary", () => {
  const raw = "Um, so, uh, add a retry with with exponential back off to the, the upload function, you know.";
  const cleaned = cleanTranscript(raw);
  assert.equal(cleaned, "So, add a retry with exponential back off to the upload function.");
  assert.equal(applyMemory(emptyMemory(), cleaned).text, "So, add a retry with exponential backoff to the upload function.");
});

test("cleanTranscript: capital first letter, a final period only for 4+ words", () => {
  assert.equal(cleanTranscript("fix the failing test"), "Fix the failing test.");
  assert.equal(cleanTranscript("run it"), "Run it");
  assert.equal(cleanTranscript("is it done?"), "Is it done?");
});

test("cleanTranscript: never changes protected spans", () => {
  assert.equal(cleanTranscript("um rename `the the` in foo.ts"), "Rename `the the` in foo.ts");
  assert.equal(cleanTranscript("/compact um now"), "/compact now");
  assert.equal(cleanTranscript('say "um um hello hello" to the the team'), 'Say "um um hello hello" to the team.');
  assert.equal(cleanTranscript("open ~/um/uh.ts and src/the/the.ts"), "Open ~/um/uh.ts and src/the/the.ts");
  assert.equal(cleanTranscript("pass --dry-run --dry-run twice"), "Pass --dry-run --dry-run twice.");
});

test("cleanTranscript: off only strips artefacts and whitespace; options turn steps off", () => {
  assert.equal(cleanTranscript("um  the the [MUSIC] thing", false), "um the the thing");
  assert.equal(cleanTranscript("um the the thing", true, { fillers: false }), "Um the thing");
  assert.equal(cleanTranscript("um the the thing", true, { stutters: false }), "The the thing");
});
