// Run: node --test app/src/lib/macKeys.test.ts (Node strips the types itself).
import { test } from "node:test";
import assert from "node:assert/strict";
import { keyAction, macKeyCode } from "./macKeys.ts";

test("letters and digits map to kVK codes", () => {
  assert.equal(macKeyCode("KeyA"), 0);
  assert.equal(macKeyCode("KeyS"), 1);
  assert.equal(macKeyCode("KeyB"), 11);
  assert.equal(macKeyCode("KeyM"), 46);
  assert.equal(macKeyCode("Digit1"), 18);
  assert.equal(macKeyCode("Digit5"), 23);
  assert.equal(macKeyCode("Digit6"), 22);
  assert.equal(macKeyCode("Digit0"), 29);
});

test("named keys, modifiers and function keys", () => {
  assert.equal(macKeyCode("Enter"), 36);
  assert.equal(macKeyCode("Escape"), 53);
  assert.equal(macKeyCode("Backspace"), 51);
  assert.equal(macKeyCode("Delete"), 117);
  assert.equal(macKeyCode("MetaLeft"), 55);
  assert.equal(macKeyCode("OSLeft"), 55);
  assert.equal(macKeyCode("ShiftRight"), 60);
  assert.equal(macKeyCode("F1"), 122);
  assert.equal(macKeyCode("F12"), 111);
  assert.equal(macKeyCode("ArrowUp"), 126);
  assert.equal(macKeyCode("NumpadEnter"), 76);
});

test("all 26 letters and 10 digits are covered, each code once", () => {
  const letters = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((c) => macKeyCode(`Key${c}`));
  const digits = [..."0123456789"].map((c) => macKeyCode(`Digit${c}`));
  for (const c of [...letters, ...digits]) assert.equal(typeof c, "number");
  assert.equal(new Set([...letters, ...digits]).size, 36);
});

test("unknown keys are not passed through", () => {
  assert.equal(macKeyCode("KeyAB"), null);
  assert.equal(macKeyCode("MediaPlayPause"), null);
  assert.equal(macKeyCode(""), null);
});

const ev = (code: string, o: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean }> = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, ...o });

test("Cmd+V is the backend's paste, only when plain", () => {
  assert.deepEqual(keyAction(ev("KeyV", { metaKey: true })), { kind: "paste" });
  assert.deepEqual(keyAction(ev("KeyV", { metaKey: true, shiftKey: true })), { kind: "combo", code: 9, copyBack: false });
  assert.deepEqual(keyAction(ev("KeyV", { metaKey: true, repeat: true })), { kind: "ignore" });
});

test("Cmd+C and Cmd+X copy back to this Mac; other Command combos are pressed and released at once", () => {
  assert.deepEqual(keyAction(ev("KeyC", { metaKey: true })), { kind: "combo", code: 8, copyBack: true });
  assert.deepEqual(keyAction(ev("KeyX", { metaKey: true })), { kind: "combo", code: 7, copyBack: true });
  for (const code of ["KeyA", "KeyZ", "KeyQ", "KeyW", "KeyH", "KeyM", "Comma", "KeyN", "KeyT", "KeyF", "KeyS"]) {
    const a = keyAction(ev(code, { metaKey: true }));
    assert.equal(a.kind, "combo", code);
    assert.equal((a as { copyBack: boolean }).copyBack, false, code);
  }
  assert.equal(keyAction(ev("KeyZ", { metaKey: true, shiftKey: true })).kind, "combo");
});

test("modifiers and plain keys are held; Control+Option releases the keyboard", () => {
  assert.deepEqual(keyAction(ev("MetaLeft", { metaKey: true })), { kind: "key", code: 55 });
  assert.deepEqual(keyAction(ev("KeyA")), { kind: "key", code: 0 });
  assert.deepEqual(keyAction(ev("AltLeft", { ctrlKey: true, altKey: true })), { kind: "release" });
  assert.deepEqual(keyAction(ev("ControlLeft", { ctrlKey: true, altKey: true })), { kind: "release" });
  assert.equal(keyAction(ev("AltLeft", { altKey: true })).kind, "key");
  assert.equal(keyAction(ev("KeyA", { ctrlKey: true, altKey: true })).kind, "key");
});
