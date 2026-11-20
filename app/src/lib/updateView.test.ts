import assert from "node:assert/strict";
import { test } from "node:test";
import { FAILED_LINE, itemLine, launchView, railLabel, railUpdate, SKIP_AFTER_MS, stopLine, veilHolds, VEIL_MAX_MS, VEIL_SILENT_MS, welcomeLine, type LaunchUpdate, type UpdateItem, type UpdateStatus } from "./updateView.ts";

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
  assert.equal(railLabel(status({ coool: { state: "failed", detail: "The update couldn't be verified: the release has no signature." } })), "coool update couldn't be verified");
  assert.equal(railUpdate(status({ coool: { state: "failed" } })), "attention");
  assert.equal(itemLine(item("codex", { current: "0.145.0", latest: "0.171.0", state: "waiting" })), "0.145.0 → 0.171.0 · waiting");
  assert.equal(itemLine(item("coool", { current: "0.1.0", latest: "0.2.0", state: "staged" })), "0.1.0 → 0.2.0 · installed, restart to apply");
  assert.equal(itemLine(item("claude", { state: "missing" })), "Not installed");
  assert.equal(stopLine(0), null);
  assert.match(stopLine(2)!, /^2 working chats will stop/);
});

const launch = (o: Partial<LaunchUpdate> = {}): LaunchUpdate => ({ from: "0.3.1", to: "0.3.2", stage: "download", progress: null, timed_out: false, detail: null, ...o });

test("the update screen: one view per stage", () => {
  assert.equal(launchView(null, 0), null);
  assert.equal(launchView(undefined, 0), null);
  // "Start coool now" pressed: the screen is gone.
  assert.equal(launchView(launch({ stage: "background" }), 9000), null);
  const d0 = launchView(launch(), 0)!;
  assert.equal(d0.title, "Updating coool to 0.3.2");
  assert.equal(d0.stage, "Downloading");
  assert.equal(d0.bar, "indeterminate", "no bytes yet: indeterminate");
  assert.equal(d0.skip, false);
  const d = launchView(launch({ progress: { phase: "download", done: 21 * 1048576, total: 48 * 1048576 } }), 1000)!;
  assert.equal(d.bar, "progress");
  assert.equal(d.pct, 44);
  assert.equal(d.bytes, "21 MB of 48 MB");
  assert.equal(launchView(launch({ progress: { phase: "download", done: 524288, total: 3 * 1048576 } }), 0)!.bytes, "0.5 MB of 3.0 MB");
  // Unknown size: indeterminate, no bytes line.
  const u = launchView(launch({ progress: { phase: "download", done: 5, total: null } }), 0)!;
  assert.equal(u.bar, "indeterminate");
  assert.equal(u.bytes, null);
  const v = launchView(launch({ stage: "verify" }), 0)!;
  assert.equal(v.stage, "Checking the download");
  assert.equal(v.bar, "indeterminate");
  assert.equal(launchView(launch({ stage: "install" }), 0)!.stage, "Installing");
  const r = launchView(launch({ stage: "restarting" }), 0)!;
  assert.equal(r.stage, "Restarting");
  assert.equal(r.bar, "full");
  assert.match(r.note!, /open again/);
  const f = launchView(launch({ stage: "failed", timed_out: true }), 0)!;
  assert.equal(f.stage, FAILED_LINE);
  assert.equal(f.stage, "Couldn't update right now. coool will try again later.");
  assert.equal(f.failed, true);
  assert.equal(f.bar, "none");
});

test("the update screen offers Start coool now only while it downloads or checks, after a few seconds", () => {
  assert.equal(launchView(launch(), SKIP_AFTER_MS - 1)!.skip, false);
  assert.equal(launchView(launch(), SKIP_AFTER_MS)!.skip, true);
  assert.equal(launchView(launch({ stage: "verify" }), SKIP_AFTER_MS)!.skip, true);
  // Once the swap starts it's too late.
  assert.equal(launchView(launch({ stage: "install" }), 60_000)!.skip, false);
  assert.equal(launchView(launch({ stage: "restarting" }), 60_000)!.skip, false);
  assert.equal(launchView(launch({ stage: "failed" }), 60_000)!.skip, false);
});

test("the launch hold: only while coool's own check is out, and briefly", () => {
  // No word from the backend yet: held, but not for long.
  assert.equal(veilHolds(null, 0), true);
  assert.equal(veilHolds(null, VEIL_SILENT_MS), false);
  const checking = status({ coool: { state: "checking" } }, { gate_open: false });
  assert.equal(veilHolds(checking, 100), true);
  assert.equal(veilHolds(checking, VEIL_MAX_MS), false);
  // Answered (nothing newer, or offline): the app shows at once.
  assert.equal(veilHolds(status({ coool: { state: "current" } }, { gate_open: false }), 100), false);
  assert.equal(veilHolds(status({ coool: { state: "unknown" } }, { gate_open: false }), 100), false);
  // Automatic updates off, a build that can't update itself, the gate already open: no hold.
  assert.equal(veilHolds(status({ coool: { state: "checking" } }, { gate_open: false, auto_app: false }), 100), false);
  assert.equal(veilHolds(status({ coool: { state: "checking" } }, { gate_open: false, blocked: "dev build" }), 100), false);
  assert.equal(veilHolds(status({ coool: { state: "checking" } }), 100), false);
  // The screen is up: it takes over from the hold.
  assert.equal(veilHolds(status({ coool: { state: "downloading" } }, { gate_open: false, launch: launch() }), 100), false);
});

test("the confirmation after a restart", () => {
  assert.equal(welcomeLine({ from: "0.3.1", to: "0.3.2" }), "Updated to 0.3.2 · from 0.3.1");
});
