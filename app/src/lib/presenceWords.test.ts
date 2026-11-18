// The cursor label's words (lib/presenceWords.ts). Run: node --test app/src/lib/presenceWords.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { glideMs, phrase, targetName, typingPhrase, whoLine } from "./presenceWords.ts";

test("verb phrases read like a person doing it", () => {
  assert.equal(phrase({ kind: "tap", label: "General" }, "iphone"), "Tapping General");
  assert.equal(phrase({ kind: "tap", label: "Save" }, "mac"), "Clicking Save");
  assert.equal(phrase({ kind: "click", label: 'button "Add cup"' }, "browser"), "Clicking Add cup");
  assert.equal(phrase({ kind: "type", label: "Email" }, "iphone"), "Typing the email");
  assert.equal(phrase({ kind: "type", label: 'textbox "Full name"' }, "browser"), "Typing the full name");
  assert.equal(phrase({ kind: "type", label: "Search for a setting, an app or a contact" }, "iphone"), "Typing");
  assert.equal(phrase({ kind: "type" }, "mac"), "Typing");
  assert.equal(phrase({ kind: "scroll", label: "down" }, "iphone"), "Scrolling down");
  assert.equal(phrase({ kind: "press", label: "return" }, "iphone"), "Pressing Return");
  assert.equal(phrase({ kind: "press", label: "home" }, "iphone"), "Going home");
  assert.equal(phrase({ kind: "press", label: "a" }, "mac"), "Pressing A");
  assert.equal(phrase({ kind: "observe" }, "browser"), "Reading the page");
  assert.equal(phrase({ kind: "think", decider: "haiku", by: "pilot" }, "iphone"), "Haiku is choosing");
  assert.equal(phrase({ kind: "navigate", label: "https://www.example.com/form" }, "browser"), "Opening example.com");
});

test("names are trimmed to fit a label", () => {
  assert.equal(targetName("Manage your overall setup and preferences for iPhone"), "Manage your overall setup a…");
  assert.equal(typingPhrase("PIN"), "Typing the PIN");
  assert.equal(typingPhrase("Untitled"), "Typing in Untitled");
  assert.equal(typingPhrase("First name"), "Typing the first name");
});

test("who: the provider, or the pilot and who decided", () => {
  assert.equal(whoLine({ by: "agent", provider: "claude" }), "Claude");
  assert.equal(whoLine({ by: "agent", provider: "codex" }), "Codex");
  assert.equal(whoLine({ by: "pilot", provider: "claude", decider: "memory" }), "Pilot · memory");
  assert.equal(whoLine({ by: "pilot", decider: "haiku" }), "Pilot · Haiku");
  assert.equal(whoLine({}), "Agent");
});

test("glides are quick and bounded", () => {
  assert.equal(glideMs(0), 0);
  assert.equal(glideMs(20), 160);
  assert.ok(glideMs(300) > 200 && glideMs(300) < 260);
  assert.equal(glideMs(5000), 340);
});
