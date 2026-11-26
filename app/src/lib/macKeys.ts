// Physical keys (`KeyboardEvent.code`) to macOS virtual key codes (Carbon's kVK_*), for the Mac panel's keyboard
// pass-through. Physical, not `key`: the guest applies its own layout and modifiers, so what is held is what is sent.

const LETTERS: Record<string, number> = {
  A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11, Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17,
  O: 31, U: 32, I: 34, P: 35, L: 37, J: 38, K: 40, N: 45, M: 46,
};
const DIGITS: Record<string, number> = { "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29 };

const NAMED: Record<string, number> = {
  Equal: 24,
  Minus: 27,
  BracketRight: 30,
  BracketLeft: 33,
  Enter: 36,
  Quote: 39,
  Semicolon: 41,
  Backslash: 42,
  Comma: 43,
  Slash: 44,
  Period: 47,
  Tab: 48,
  Space: 49,
  Backquote: 50,
  Backspace: 51,
  Escape: 53,
  MetaRight: 54,
  MetaLeft: 55,
  ShiftLeft: 56,
  CapsLock: 57,
  AltLeft: 58,
  ControlLeft: 59,
  ShiftRight: 60,
  AltRight: 61,
  ControlRight: 62,
  Fn: 63,
  F1: 122,
  F2: 120,
  F3: 99,
  F4: 118,
  F5: 96,
  F6: 97,
  F7: 98,
  F8: 100,
  F9: 101,
  F10: 109,
  F11: 103,
  F12: 111,
  Home: 115,
  PageUp: 116,
  Delete: 117,
  End: 119,
  PageDown: 121,
  ArrowLeft: 123,
  ArrowRight: 124,
  ArrowDown: 125,
  ArrowUp: 126,
  NumpadEnter: 76,
  // Older WebKit names the Command keys OSLeft / OSRight.
  OSLeft: 55,
  OSRight: 54,
};

/** A key pressed inside an element that takes every key for itself (the Mac screen, `data-key-capture`): app shortcuts stand aside. */
export const keysCaptured = (e: KeyboardEvent) => !!(e.target instanceof Element && e.target.closest("[data-key-capture]"));

/** Command keys: on macOS a key pressed while Command is held gets no keyup in WebKit, so it is pressed and released at once. */
export const META = new Set([54, 55]);
export const MODIFIERS = new Set([54, 55, 56, 57, 58, 59, 60, 61, 62, 63]);

export type KeyAction =
  /** Control and Option together: hand the keyboard back to coool. */
  | { kind: "release" }
  /** Cmd+V: the host clipboard to the Mac, then a real Cmd+V there. */
  | { kind: "paste" }
  /** A key with Command held: pressed and released at once; `copyBack` after Cmd+C / Cmd+X. */
  | { kind: "combo"; code: number; copyBack: boolean }
  | { kind: "key"; code: number }
  | { kind: "ignore" };

type KeyLike = { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean };

/** What a key press in the Mac screen (keys captured) does. */
export function keyAction(e: KeyLike): KeyAction {
  if (e.ctrlKey && e.altKey && !e.metaKey && /^(Control|Alt)(Left|Right)$/.test(e.code)) return { kind: "release" };
  if (e.repeat) return { kind: "ignore" };
  if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyV") return { kind: "paste" };
  const code = macKeyCode(e.code);
  if (code == null) return { kind: "ignore" };
  if (e.metaKey && !MODIFIERS.has(code)) return { kind: "combo", code, copyBack: !e.ctrlKey && !e.altKey && !e.shiftKey && (e.code === "KeyC" || e.code === "KeyX") };
  return { kind: "key", code };
}

/** The macOS virtual key code for a `KeyboardEvent.code`, or null for a key the Mac panel doesn't pass through. */
export function macKeyCode(code: string): number | null {
  if (code.startsWith("Key") && code.length === 4) return LETTERS[code[3]] ?? null;
  if (code.startsWith("Digit") && code.length === 6) return DIGITS[code[5]] ?? null;
  return NAMED[code] ?? null;
}
