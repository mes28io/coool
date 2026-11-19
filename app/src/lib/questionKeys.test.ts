// Unit tests for lib/questionKeys.ts: `node --test app/src/lib/questionKeys.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { digitPick, isTyping, keyQuestion, laterLine } from "./questionKeys.ts";

test("digitPick: plain 1-9 within the options", () => {
  assert.equal(digitPick({ key: "1" }, 3), 0);
  assert.equal(digitPick({ key: "3" }, 3), 2);
  assert.equal(digitPick({ key: "4" }, 3), null);
  assert.equal(digitPick({ key: "0" }, 3), null);
  assert.equal(digitPick({ key: "a" }, 3), null);
  assert.equal(digitPick({ key: "1", metaKey: true }, 3), null, "⌘1 switches tabs");
  assert.equal(digitPick({ key: "1", ctrlKey: true }, 3), null);
  assert.equal(digitPick({ key: "1", altKey: true }, 3), null);
  assert.equal(digitPick({ key: "1", isComposing: true }, 3), null);
});

test("isTyping: fields and editable text, not buttons", () => {
  const el = (tagName: string, type?: string, isContentEditable = false) => ({ tagName, isContentEditable, getAttribute: (n: string) => (n === "type" ? (type ?? null) : null) });
  assert.ok(isTyping(el("TEXTAREA")));
  assert.ok(isTyping(el("INPUT")));
  assert.ok(isTyping(el("INPUT", "password")));
  assert.ok(isTyping(el("DIV", undefined, true)));
  assert.ok(!isTyping(el("INPUT", "checkbox")));
  assert.ok(!isTyping(el("BUTTON")));
  assert.ok(!isTyping(el("DIV")));
  assert.ok(!isTyping(null));
});

test("keyQuestion: focused, else first unanswered, else first", () => {
  assert.equal(keyQuestion([[], []], 1), 1);
  assert.equal(keyQuestion([["a"], []], -1), 1);
  assert.equal(keyQuestion([["a"], ["b"]], -1), 0);
  assert.equal(keyQuestion([[]], 5), 0);
});

test("laterLine: one line, the first question", () => {
  assert.equal(laterLine("Claude", [{ question: "Which retry?\nmore" }]), "Claude has a question · Which retry?");
  assert.equal(laterLine("Codex", [{ question: "A?" }, { question: "B?" }]), "Codex has 2 questions · A?");
  assert.equal(laterLine("Claude", []), "Claude has a question");
});
