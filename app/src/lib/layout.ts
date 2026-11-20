// The layout mode, one source of truth (rules in lib/layoutRules.ts): "wide" (landscape, as coool always was) or
// "stacked" (a portrait window). It follows the window live, so rotating the display or dragging the window across
// the line rearranges in place: nothing remounts, open chats and their scroll stay where they were.
//
// It is mirrored on <html data-layout>, which the `wide:` / `stacked:` CSS variants read (styles.css), so most
// surfaces switch with classes; components that size things in JS read `useLayoutMode()`.

import { create } from "zustand";
import { decideMode, LAYOUT_PREFS, readStack, type LayoutMode, type LayoutPref, type PanelKind } from "./layoutRules";

const PREF_KEY = "coool.layout";
const STACK_KEY = "coool.stackPanel";

function readPref(): LayoutPref {
  try {
    const v = localStorage.getItem(PREF_KEY) as LayoutPref | null;
    return v && LAYOUT_PREFS.includes(v) ? v : "auto";
  } catch {
    return "auto";
  }
}

const size = () => (typeof window === "undefined" ? { w: 0, h: 0 } : { w: window.innerWidth, h: window.innerHeight });

function apply(mode: LayoutMode) {
  if (typeof document !== "undefined" && document.documentElement.dataset.layout !== mode) document.documentElement.dataset.layout = mode;
}

interface LayoutState {
  pref: LayoutPref;
  mode: LayoutMode;
  /** Stacked panels' shares of their pane's height, by kind (persisted; a kind not here uses its default). */
  stack: Partial<Record<PanelKind, number>>;
  setPref(p: LayoutPref): void;
  setStack(kind: PanelKind, frac: number): void;
}

const first = (() => {
  const pref = readPref();
  const { w, h } = size();
  return { pref, mode: decideMode(w, h, pref) };
})();
apply(first.mode);

export const useLayout = create<LayoutState>((set, get) => ({
  ...first,
  stack: (() => {
    try {
      return readStack(localStorage.getItem(STACK_KEY));
    } catch {
      return {};
    }
  })(),
  setPref(pref) {
    try {
      if (pref === "auto") localStorage.removeItem(PREF_KEY);
      else localStorage.setItem(PREF_KEY, pref);
    } catch {}
    const { w, h } = size();
    set({ pref, mode: decideMode(w, h, pref, get().mode) });
  },
  setStack(kind, frac) {
    const stack = { ...get().stack, [kind]: frac };
    try {
      localStorage.setItem(STACK_KEY, JSON.stringify(stack));
    } catch {}
    set({ stack });
  },
}));

useLayout.subscribe((s, p) => {
  if (s.mode !== p.mode) apply(s.mode);
});

if (typeof window !== "undefined") {
  const sync = () => {
    const st = useLayout.getState();
    const { w, h } = size();
    const mode = decideMode(w, h, st.pref, st.mode);
    if (mode !== st.mode) useLayout.setState({ mode });
  };
  window.addEventListener("resize", sync);
  // A rotated display reports the new size with the next resize; this catches a window restored at a new shape.
  document.addEventListener("visibilitychange", sync);
}

export const useLayoutMode = () => useLayout((s) => s.mode);
export const layoutMode = () => useLayout.getState().mode;
