import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSettled } from "./mdSplit.ts";

const cases = [
  "",
  "one line",
  "# Title\n\nA paragraph.\n\nAnother one, still being wri",
  "Intro:\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter the code.",
  "- a\n- b\n\n- c (loose list)\n\nThen prose.",
  "1. first\n\n   continued under the item\n\n2. second",
  "| a | b |\n|---|---|\n| 1 | 2 |\n\nNext",
  "Text\n\n\n\nMore after several blank lines\n",
];

test("the pieces join back to the text", () => {
  for (const c of cases) assert.equal(splitSettled(c).join(""), c);
  // Every prefix too (a message as it streams in).
  const long = cases.join("\n\n");
  for (let i = 0; i <= long.length; i++) assert.equal(splitSettled(long.slice(0, i)).join(""), long.slice(0, i));
});

test("cuts between finished blocks only", () => {
  assert.deepEqual(splitSettled("# Title\n\nA paragraph.\n\nTail"), ["# Title\n\n", "A paragraph.\n\n", "Tail"]);
  // Not inside a code fence.
  assert.deepEqual(splitSettled("```\na\n\nb\n```\n\nafter"), ["```\na\n\nb\n```\n\n", "after"]);
  assert.deepEqual(splitSettled("```\na\n\nb"), ["```\na\n\nb"]);
  // Not between the items of a loose list, and not before an indented continuation.
  assert.deepEqual(splitSettled("- a\n\n- b\n\nend"), ["- a\n\n- b\n\n", "end"]);
  assert.deepEqual(splitSettled("1. a\n\n   more\n\n2. b"), ["1. a\n\n   more\n\n2. b"]);
  assert.deepEqual(splitSettled("Intro:\n- a\n\n- b"), ["Intro:\n- a\n\n- b"]);
});
