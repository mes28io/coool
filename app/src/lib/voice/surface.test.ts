import { test } from "node:test";
import assert from "node:assert/strict";
import { direction, isQuiet, micTitle, surface, type SurfaceInput } from "./surface.ts";

const label = (c: string) => ({ tr: "Turkish", en: "English", de: "German" })[c] ?? c;
const base: SurfaceInput = {
  phase: "idle",
  mode: "hold",
  secs: 0,
  levels: [],
  error: null,
  errorKind: null,
  notice: null,
  direction: "Turkish → English",
  holdLabel: "Right ⌥",
  toggleLabel: "⌥Space",
};
const speaking = Array.from({ length: 60 }, (_, i) => (i % 5 ? 0.5 : 0.2));
const flat = Array.from({ length: 60 }, () => 0.05);

test("idle: nothing shown", () => {
  assert.equal(surface(base).kind, "hidden");
});

test("starting: says so, can be cancelled", () => {
  const s = surface({ ...base, phase: "starting" });
  assert.equal(s.kind, "starting");
  assert.deepEqual(s.actions, ["cancel"]);
});

test("listening by holding: release to finish, the direction, meter and clock", () => {
  const s = surface({ ...base, phase: "listening", secs: 3, levels: speaking });
  assert.equal(s.kind, "listening");
  assert.equal(s.title, "Listening");
  assert.equal(s.detail, "Turkish → English");
  assert.equal(s.finish, "Release Right ⌥ to finish");
  assert.deepEqual(s.actions, ["cancel"]);
  assert.ok(s.meter && s.clock);
});

test("listening hands-free: a Done button and the keys that finish", () => {
  const t = surface({ ...base, phase: "listening", mode: "toggle", secs: 3, levels: speaking });
  assert.equal(t.finish, "Press ⌥Space or Return to finish");
  assert.deepEqual(t.actions, ["done", "cancel"]);
  const c = surface({ ...base, phase: "listening", mode: "click", secs: 3, levels: speaking });
  assert.equal(c.finish, "Click Done or press Return to finish");
  assert.deepEqual(c.actions, ["done", "cancel"]);
});

test("a flat level for two seconds: coool says it can't hear anything", () => {
  assert.equal(surface({ ...base, phase: "listening", secs: 1.5, levels: flat.slice(0, 37) }).kind, "listening");
  const q = surface({ ...base, phase: "listening", secs: 2.5, levels: flat });
  assert.equal(q.kind, "quiet");
  assert.equal(q.title, "coool can't hear anything");
  assert.equal(q.detail, "Check the microphone in Settings > Voice.");
  assert.ok(q.actions.includes("settings"));
  // Speaking again clears it.
  assert.equal(surface({ ...base, phase: "listening", secs: 4, levels: [...flat, ...speaking] }).kind, "listening");
  assert.equal(isQuiet([...flat.slice(0, 40), 0.6, ...flat.slice(0, 9)], 3), false);
});

test("working, then done or nothing", () => {
  assert.equal(surface({ ...base, phase: "transcribing" }).title, "Turning speech into text…");
  assert.deepEqual(surface({ ...base, phase: "transcribing" }).actions, ["cancel"]);
  const d = surface({ ...base, notice: { kind: "done" } });
  assert.equal(d.kind, "done");
  assert.ok(d.actions.includes("undo"));
  const n = surface({ ...base, notice: { kind: "nothing", why: "echo" } });
  assert.equal(n.kind, "nothing");
  assert.match(n.title, /didn't hear any words/);
});

test("errors say what to do next, with the button that goes there", () => {
  const m = surface({ ...base, phase: "error", error: "No voice model yet.", errorKind: "model" });
  assert.deepEqual(m.actions, ["settings", "dismiss"]);
  assert.match(m.detail, /Settings > Voice/);
  assert.deepEqual(surface({ ...base, phase: "error", error: "x", errorKind: "permission" }).actions, ["privacy", "dismiss"]);
  assert.deepEqual(surface({ ...base, phase: "error", error: "x", errorKind: "device" }).actions, ["settings", "dismiss"]);
  assert.deepEqual(surface({ ...base, phase: "error", error: "x", errorKind: "other" }).actions, ["dismiss"]);
});

test("direction and the mic button's tooltip", () => {
  assert.equal(direction("translate", "tr", label), "Turkish → English");
  assert.equal(direction("translate", "auto", label), "Any language → English");
  assert.equal(direction("translate", "en", label), "English");
  assert.equal(direction("transcribe", "tr", label), "Turkish, as spoken");
  assert.match(direction("transcribe", "auto", label), /^As spoken/);
  assert.equal(micTitle(true, false, "Right ⌥", "⌥Space"), "Dictate: click to start, or hold Right ⌥, or press ⌥Space");
  assert.match(micTitle(false, false, null, null), /Settings > Voice/);
});
