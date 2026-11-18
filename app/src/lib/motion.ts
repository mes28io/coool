// "Reduce motion" (Settings > Appearance): Auto (default), On, Off.
//
// - On: every looping animation is static (first frame of glyphs, no shimmer, static dots, no sweeping bars) and
//   transitions are instant or opacity-only. Timers keep ticking. The needs-you ring stays as a slow opacity breathe.
// - Off: the normal, stepped motion, even when Auto would reduce.
// - Auto: reduced when macOS "Reduce motion" is on (`prefers-reduced-motion`), or the backend's device hints say so
//   (Low Power Mode, the Mac running hot, battery low; see app/src-tauri/src/motion.rs). The mock reads `?power=low`,
//   `?power=hot` or `?power=battery` instead.
//
// The effective state is one class on <html>, `reduce-motion`, that all the CSS keys off (styles.css, moodGlyph.css);
// `reducedMotion()` reads it for JS-driven motion. The choice is kept in localStorage, like the theme.

import { createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from "react";

export type MotionPref = "auto" | "on" | "off";
export type Thermal = "nominal" | "fair" | "serious" | "critical";
export interface MotionHints {
  low_power: boolean;
  thermal: Thermal;
  on_battery?: boolean | null;
  battery_pct?: number | null;
  intel?: boolean;
  memory_gb?: number | null;
  perf_cores?: number | null;
  busy_at_launch?: boolean;
  /** Auto would reduce now, from the device alone. */
  reduce: boolean;
  reason?: string | null;
}
export interface MotionState {
  pref: MotionPref;
  reduce: boolean;
  /** Why Auto reduces (null when it doesn't, or when the choice is On/Off). */
  reason: string | null;
}

const KEY = "coool.motion";
const QUERY = "(prefers-reduced-motion: reduce)";

function loadPref(): MotionPref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "on" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}

let pref: MotionPref = loadPref();
let hints: MotionHints | null = null;
let osReduce = typeof matchMedia !== "undefined" && matchMedia(QUERY).matches;
let state: MotionState = compute();
const subs = new Set<() => void>();

/** The effective state from the choice, the system setting and the device hints. */
export function decideMotion(p: MotionPref, os: boolean, h: MotionHints | null): MotionState {
  if (p === "on") return { pref: p, reduce: true, reason: null };
  if (p === "off") return { pref: p, reduce: false, reason: null };
  if (os) return { pref: p, reduce: true, reason: "macOS Reduce motion" };
  if (h?.reduce) return { pref: p, reduce: true, reason: h.reason ?? "device" };
  return { pref: p, reduce: false, reason: null };
}

function compute(): MotionState {
  return decideMotion(pref, osReduce, hints);
}

function apply() {
  const next = compute();
  if (next.pref === state.pref && next.reduce === state.reduce && next.reason === state.reason) return;
  state = next;
  if (typeof document !== "undefined") document.documentElement.classList.toggle("reduce-motion", state.reduce);
  subs.forEach((f) => f());
}

if (typeof document !== "undefined") document.documentElement.classList.toggle("reduce-motion", state.reduce);
if (typeof matchMedia !== "undefined") {
  matchMedia(QUERY).addEventListener("change", (e) => {
    osReduce = e.matches;
    apply();
  });
}

export function setMotionPref(p: MotionPref) {
  pref = p;
  try {
    if (p === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch {
    /* private mode: the choice lasts for this window */
  }
  apply();
}

export function setMotionHints(h: MotionHints | null) {
  hints = h;
  const before = state;
  apply();
  // Settings shows each hint: re-render it even when the decision stayed the same.
  if (state === before) {
    state = { ...state };
    subs.forEach((f) => f());
  }
}

/** The device hints as last read (null until the backend answers, or in a build without them). */
export const motionHints = () => hints;
/** Whether macOS "Reduce motion" (Accessibility) is on. */
export const systemReduceMotion = () => osReduce;

/** True while motion is reduced (any reason). Cheap; safe to call during render. */
export const reducedMotion = () => state.reduce;

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
export function useMotion(): MotionState {
  return useSyncExternalStore(subscribe, () => state);
}

// ---------- where activity animates ----------
//
// Activity loops (mood glyphs, the shimmering thinking word, thinking dots, running bars) animate only where the
// person is looking: inside the session(s) open in the workspace panes. Home and the sidebar wrap themselves in
// `<AnimateScope enabled={false}>` and show the same glyph and word static (the glyph's first frame, the word with no
// shimmer or cycling, still dots). Components ask `useLive()`; pure-CSS loops inside a static scope are stopped by
// the `[data-anim-static]` rules in styles.css, which the scope's owner puts on its root element.

const Live = createContext(true);

export function AnimateScope({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return createElement(Live.Provider, { value: enabled }, children);
}

/** Whether activity loops should run here: inside an animated scope and motion not reduced. */
export function useLive(): boolean {
  const scope = useContext(Live);
  const reduce = useMotion().reduce;
  return scope && !reduce;
}

/** `?power=low|hot|battery|weak|busy` in the browser mock: a device hint, for frames. */
export function mockHints(search: string): MotionHints | null {
  const m = /[?&]power=(\w+)/.exec(search)?.[1];
  if (m === "low") return { low_power: true, thermal: "nominal", reduce: true, reason: "Low Power Mode" };
  if (m === "hot") return { low_power: false, thermal: "serious", reduce: true, reason: "Mac running hot" };
  if (m === "weak") return { low_power: false, thermal: "nominal", reduce: true, reason: "8 GB memory", memory_gb: 8 };
  if (m === "busy") return { low_power: false, thermal: "nominal", reduce: true, reason: "Mac busy at launch", busy_at_launch: true };
  if (m === "battery") return { low_power: false, thermal: "nominal", on_battery: true, battery_pct: 12, reduce: true, reason: "battery low" };
  return null;
}
