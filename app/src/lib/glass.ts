// "Translucent window" (Settings > Appearance, on by default): frosted glass in two places, the window chrome (title
// bar and icon rail) and the background of the device panels (iPhone, Mac, Browser). The blur is real macOS
// vibrancy, an NSVisualEffectView behind the webview (app/src-tauri/src/glass.rs); the page only leaves those two
// regions translucent, with a tint and a hairline from styles.css (`--chrome`, `--side-glass`, ...).
//
// The effective state is `data-glass="on"` on <html>, set only once the native view shows (and removed before it
// hides), so the page never goes see-through over an opaque window. Off when the setting is off, when macOS "Reduce
// transparency" is on (checked again whenever the window comes forward), and outside the desktop app.
//
// The device panels sit inside the opaque main sheet, so the sheet's background is its own layer with holes cut
// where those panels are (`useGlassHoles`): the content above it is never masked, and the holes follow the panels
// as they open, resize, move with a split or switch tabs.

import { useLayoutEffect, useSyncExternalStore } from "react";
import { isTauri } from "./backend";
import { holeMask, holeRects } from "./glassHoles";

const KEY = "coool.glass";

export interface GlassState {
  /** The person's choice (Settings > Appearance). */
  pref: boolean;
  /** Showing now. */
  active: boolean;
  /** macOS "Reduce transparency" is on (so the glass is off whatever the choice). */
  reduceTransparency: boolean;
  /** This build can show it (the macOS app; not the browser mock). */
  supported: boolean;
}

function loadPref(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

let state: GlassState = { pref: loadPref(), active: false, reduceTransparency: false, supported: isTauri };
const subs = new Set<() => void>();
let theme: "dark" | "light" = typeof document !== "undefined" && document.documentElement.dataset.theme === "light" ? "light" : "dark";
let seq = 0;

function set(next: Partial<GlassState>) {
  const s = { ...state, ...next };
  if (s.pref === state.pref && s.active === state.active && s.reduceTransparency === state.reduceTransparency && s.supported === state.supported) return;
  state = s;
  subs.forEach((f) => f());
}

export const glassState = () => state;
export const glassActive = () => state.active;
export function useGlass(): GlassState {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => state,
  );
}

const css = (on: boolean) => {
  if (typeof document === "undefined") return;
  if (on) document.documentElement.dataset.glass = "on";
  else delete document.documentElement.dataset.glass;
};

/**
 * Brings the native view and the page in line with the choice and `t` (the theme). Off: the page goes opaque first,
 * then the window. On: the window first, then the page. Returns whether the glass is showing; the caller paints the
 * window's solid colour when it isn't (lib/boot.ts).
 */
export async function syncGlass(t: "dark" | "light" = theme): Promise<boolean> {
  theme = t;
  if (!isTauri) return false;
  const mine = ++seq;
  const want = state.pref;
  if (!want) css(false);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const r = await invoke<{ active: boolean; reduce_transparency: boolean; supported: boolean }>("glass_set", { on: want, dark: t === "dark" });
    if (mine !== seq) return r.active; // a newer call is on its way
    if (!r.active) css(false);
    set({ active: r.active, reduceTransparency: r.reduce_transparency, supported: r.supported });
    css(r.active);
    return r.active;
  } catch {
    // An older backend without the command: solid, as before.
    css(false);
    set({ active: false, supported: false });
    return false;
  }
}

export function setGlassPref(on: boolean) {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch {
    /* private mode: lasts for this window */
  }
  set({ pref: on });
  void syncGlass().then(async (active) => {
    if (active) return;
    const { syncWindow } = await import("./boot");
    await syncWindow(theme);
  });
}

// "Reduce transparency" changes in System Settings, so it is read again whenever coool comes back to the front.
if (isTauri && typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    const was = state.active;
    void syncGlass().then(async (active) => {
      if (was && !active) {
        const { syncWindow } = await import("./boot");
        await syncWindow(theme);
      }
    });
  });
}

// ---------- holes in the sheet's background ----------

const holes = new Set<HTMLElement>();
let schedule: (() => void) | null = null;

/** Marks `el` (a device panel's frame) as a place where the sheet's background is cut away while `on`. */
export function useGlassHole(el: HTMLElement | null, on: boolean) {
  useLayoutEffect(() => {
    if (!el || !on) return;
    holes.add(el);
    schedule?.();
    return () => {
      holes.delete(el);
      schedule?.();
    };
  }, [el, on]);
}

/**
 * Keeps `bg` (the sheet's background layer) cut where the device panels are. Measures on any resize of the sheet,
 * a panel or its row, then for a few frames after (springs and tab fades move panels without resizing them), and
 * stops when nothing has moved for a while: no work at all while nothing changes.
 */
export function useGlassHoles(bg: HTMLElement | null) {
  useLayoutEffect(() => {
    if (!bg) return;
    let raf = 0;
    let still = 0;
    let last = "";
    const ro = new ResizeObserver(() => kick());
    const watched = new Set<Element>();
    const watch = () => {
      const want = new Set<Element>([bg]);
      for (const h of holes) {
        want.add(h);
        if (h.parentElement) want.add(h.parentElement);
      }
      for (const e of watched) {
        if (want.has(e)) continue;
        ro.unobserve(e);
        watched.delete(e);
      }
      for (const e of want) {
        if (watched.has(e)) continue;
        ro.observe(e);
        watched.add(e);
      }
    };
    const measure = () => {
      raf = 0;
      const rects = state.active ? holeRects(bg.getBoundingClientRect(), holes) : [];
      const key = rects.map((r) => r.map((n) => n.toFixed(2)).join(",")).join(";");
      if (key !== last) {
        last = key;
        still = 0;
        const m = holeMask(rects);
        const s = bg.style;
        s.maskImage = m?.maskImage ?? "";
        s.maskSize = m?.maskSize ?? "";
        s.maskPosition = m?.maskPosition ?? "";
        s.maskRepeat = m?.maskRepeat ?? "";
        s.maskComposite = m?.maskComposite ?? "";
      } else still++;
      // ~0.4 s without a change: stop until the next resize or hole change.
      if (still < 24) raf = requestAnimationFrame(measure);
    };
    const kick = () => {
      still = 0;
      if (!raf) raf = requestAnimationFrame(measure);
    };
    schedule = () => {
      watch();
      kick();
    };
    // The glass going on or off adds or drops every hole at once.
    const onGlass = () => kick();
    subs.add(onGlass);
    window.addEventListener("resize", kick);
    schedule();
    return () => {
      schedule = null;
      subs.delete(onGlass);
      window.removeEventListener("resize", kick);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [bg]);
}
