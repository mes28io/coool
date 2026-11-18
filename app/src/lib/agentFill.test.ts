// Sub-agent cards' context fill and handoff (lib/agentFill.ts). Run: node --test app/src/lib/agentFill.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFill, fillModel, fillText, fmtK, handoffLine, taskPrompt } from "./agentFill.ts";

test("fill: used over the model's window, estimated unless the CLI reported it", () => {
  const f = agentFill(32_000, "claude-sonnet-4-5")!;
  assert.equal(f.window, 200_000);
  assert.equal(f.estimate, true);
  assert.equal(fillText(f), "32k / ~200k");
  assert.equal(f.high, false);
  const r = agentFill(180_000, "claude-sonnet-4-5", 200_000)!;
  assert.equal(r.estimate, false);
  assert.equal(r.high, true);
  assert.equal(fillText(r), "180k / 200k");
  assert.equal(fillText(agentFill(48_200, "claude-haiku-5-5")!), "48k / ~1M");
  assert.equal(fillText(agentFill(12_400, "gpt-5.1-codex")!), "12k / ~272k");
});

test("fill: nothing known hides the bar", () => {
  assert.equal(agentFill(0, "claude-haiku-5-5"), null);
  assert.equal(agentFill(undefined, "claude-haiku-5-5"), null);
  assert.equal(agentFill(null, null), null);
});

test("fill never goes past full", () => {
  assert.equal(agentFill(260_000, "claude-sonnet-4-5", 200_000)!.share, 1);
});

test("fmtK", () => {
  assert.equal(fmtK(840), "840");
  assert.equal(fmtK(1200), "1.2k");
  assert.equal(fmtK(1000), "1k");
  assert.equal(fmtK(32_400), "32k");
  assert.equal(fmtK(1_000_000), "1M");
  assert.equal(fmtK(1_250_000), "1.3M");
});

test("handoff: the prompt's first real line; nothing when it only repeats the title", () => {
  assert.equal(handoffLine("Find where empty carts crash.\n\nLook in src/cart first.", "Survey the cart"), "Find where empty carts crash.");
  assert.equal(handoffLine("## Task\n\n- Find the flaky test", null), "Task");
  assert.equal(handoffLine("   \n\n", "x"), null);
  assert.equal(handoffLine(null, "x"), null);
  assert.equal(handoffLine("Survey the cart", "Survey the cart"), null);
  assert.equal(handoffLine("x".repeat(300), null)!.length, 200);
});

test("taskPrompt: Claude Task / Agent and Codex spawn_agent inputs", () => {
  assert.equal(taskPrompt({ description: "Survey", prompt: "Find where empty carts crash", subagent_type: "Explore" }), "Find where empty carts crash");
  assert.equal(taskPrompt({ message: "Port the exporter" }), "Port the exporter");
  assert.equal(taskPrompt({ description: "only a description" }), null);
  assert.equal(taskPrompt(null), null);
});

test("fillModel: reported, else the model the lead asked for, else the lead's", () => {
  assert.equal(fillModel("claude-haiku-5-5", { model: "opus" }, "claude-sonnet-5"), "claude-haiku-5-5");
  assert.equal(fillModel(null, { model: "haiku", prompt: "x" }, "claude-opus-5-5"), "haiku");
  assert.equal(fillModel(null, { model: "haiku" }, "claude-haiku-5-5"), "claude-haiku-5-5", "the lead's own family: its model");
  assert.equal(fillModel(undefined, { prompt: "x" }, "claude-haiku-5-5"), "claude-haiku-5-5");
  assert.equal(fillModel(null, null, null), null);
});
