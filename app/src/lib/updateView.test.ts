import assert from "node:assert/strict";
import { test } from "node:test";
import { itemLine, railLabel, railUpdate, stopLine, type UpdateItem, type UpdateStatus } from "./updateView.ts";

const item = (id: UpdateItem["id"], o: Partial<UpdateItem> = {}): UpdateItem => ({
  id,
  name: id === "coool" ? "coool" : id === "claude" ? "Claude Code" : "Codex",
  current: "1.0.0",
  latest: null,
  state: "current",
  detail: null,
  command: null,
  method: null,
  progress: null,
  ...o,
});
const status = (o: Partial<Record<UpdateItem["id"], Partial<UpdateItem>>> = {}, s: Partial<UpdateStatus> = {}): UpdateStatus => ({
  items: [item("coool", o.coool), item("claude", o.claude), item("codex", o.codex)],
  auto_app: true,
  auto_cli: true,
  gate_open: true,
  checked_at: 1,
  blocked: null,
  ...s,
});

test("hidden when everything is current and idle", () => {
  assert.equal(railUpdate(null), "hidden");
  assert.equal(railUpdate(status()), "hidden");
  assert.equal(railUpdate(status({ codex: { state: "unknown" }, claude: { state: "missing" } })), "hidden");
  // A background check after launch stays quiet; the launch checks show.
  assert.equal(railUpdate(status({ coool: { state: "checking" } })), "hidden");
  assert.equal(railUpdate(status({ coool: { state: "checking" } }, { gate_open: false })), "busy");
});

test("activity, done and attention", () => {
  assert.equal(railUpdate(status({ coool: { state: "downloading", latest: "1.1.0", progress: { phase: "download", done: 5, total: 10 } } })), "busy");
  assert.equal(railUpdate(status({ codex: { state: "installing" } })), "busy");
  assert.equal(railUpdate(status({ coool: { state: "staged", latest: "1.1.0" } })), "done");
  assert.equal(railLabel(status({ coool: { state: "staged", latest: "1.1.0" } })), "Update installed · restart to apply");
  assert.equal(railUpdate(status({ codex: { state: "waiting", latest: "0.171.0" } })), "attention");
  assert.equal(railUpdate(status({ claude: { state: "failed" } })), "attention");
  assert.equal(railUpdate(status({ codex: { state: "manual", latest: "0.171.0" } })), "attention");
  // Waiting on the person beats the done check.
  assert.equal(railUpdate(status({ coool: { state: "staged" }, codex: { state: "waiting" } })), "attention");
  // coool available: a request only with automatic updates off (with them on it downloads, or retries quietly).
  assert.equal(railUpdate(status({ coool: { state: "available", latest: "1.1.0" } })), "hidden");
  assert.equal(railUpdate(status({ coool: { state: "available", latest: "1.1.0" } }, { auto_app: false })), "attention");
});

test("labels and lines", () => {
  assert.equal(railLabel(status({ coool: { state: "downloading", progress: { phase: "download", done: 1, total: 4 } } })), "Updating coool · 25%");
  assert.equal(railLabel(status({ codex: { state: "waiting" } })), "Codex update waiting");
  assert.equal(itemLine(item("codex", { current: "0.145.0", latest: "0.171.0", state: "waiting" })), "0.145.0 → 0.171.0 · waiting");
  assert.equal(itemLine(item("coool", { current: "0.1.0", latest: "0.2.0", state: "staged" })), "0.1.0 → 0.2.0 · installed, restart to apply");
  assert.equal(itemLine(item("claude", { state: "missing" })), "Not installed");
  assert.equal(stopLine(0), null);
  assert.match(stopLine(2)!, /^2 working chats will stop/);
});
