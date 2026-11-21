// The layout mode's rules (pure, so node can test them; lib/layout.ts applies them to the window).
//
// coool has two arrangements. "wide" is the landscape one everything was designed for: the sidebar, the main area,
// and a session's panels (Jobs, Models, the Browser, the iPhone, the Mac) beside the chat. "stacked" is for a window
// taller than it is wide (a monitor turned to portrait): what sits side by side in "wide" stacks where that reads
// better. Settings > Appearance > Layout picks Automatic (the default: follows the window's shape), Side by side or
// Stacked.

export type LayoutPref = "auto" | "wide" | "stacked";
export type LayoutMode = "wide" | "stacked";
export type PanelKind = "agents" | "models" | "browser" | "device" | "mac" | "context";
export type Axis = "x" | "y";

export const LAYOUT_PREFS: readonly LayoutPref[] = ["auto", "wide", "stacked"];

/**
 * Automatic stacks when the window is portrait: taller than wide by at least `ENTER` (4%), and goes back once it is
 * no taller than `LEAVE` × its width. The band between keeps a near-square window, dragged across the line, from
 * flipping back and forth on every pixel.
 */
export const ENTER = 1.04;
export const LEAVE = 0.98;

export function decideMode(w: number, h: number, pref: LayoutPref, prev?: LayoutMode): LayoutMode {
  if (pref !== "auto") return pref;
  if (!(w > 0 && h > 0)) return prev ?? "wide";
  if (prev === "stacked") return h > w * LEAVE ? "stacked" : "wide";
  if (prev === "wide") return h >= w * ENTER ? "stacked" : "wide";
  return h > w ? "stacked" : "wide";
}

/** Above a panel stacked below it, the chat keeps at least this much height (its composer and a few lines). */
export const CHAT_MIN_H = 300;
/** A stacked panel's least height. */
export const PANEL_MIN_H = 220;
/** An iPhone panel sits beside the chat in "stacked" only when the chat keeps at least this width next to it. */
export const BESIDE_CHAT_MIN = 420;

/**
 * Where a session's panel goes: "x" beside the chat (to its right), "y" below it. "wide" is always beside. "stacked"
 * puts the landscape panels (Browser, Mac) and Jobs / Models below the chat at the pane's full width; the iPhone,
 * itself portrait, stays beside a chat that keeps `BESIDE_CHAT_MIN` and goes below a narrower one. A pane too short
 * to stack (a short split) keeps its panel beside.
 */
export function panelAxis(mode: LayoutMode, kind: PanelKind, paneW: number, bodyH: number, deviceW: number): Axis {
  if (mode === "wide") return "x";
  if (bodyH < PANEL_MIN_H + CHAT_MIN_H) return "x";
  if (kind === "device" && paneW >= deviceW + BESIDE_CHAT_MIN) return "x";
  return "y";
}

/** Each kind's share of the pane's body height when stacked below the chat, until the person drags the divider. */
export const STACK_DEFAULT: Record<PanelKind, number> = { browser: 0.56, mac: 0.5, device: 0.56, agents: 0.36, models: 0.42, context: 0.48 };
const STACK_MIN = 0.15;
const STACK_MAX = 0.85;
export const clampFrac = (f: number) => Math.min(STACK_MAX, Math.max(STACK_MIN, f));

/**
 * The default share for a kind in a body of `paneW` × `bodyH`. The Mac's screen is 16:10: at the pane's full width
 * it needs about `paneW / 1.6` plus the panel's bar, so a tall pane doesn't give it a letterbox of empty height.
 */
export function defaultFrac(kind: PanelKind, paneW: number, bodyH: number): number {
  if (kind === "mac" && bodyH > 0) return clampFrac(Math.min(STACK_DEFAULT.mac, (paneW / 1.6 + 96) / bodyH));
  return STACK_DEFAULT[kind];
}

/** The stacked panel's height in px: its share of the body, at least `PANEL_MIN_H`, leaving the chat `CHAT_MIN_H`. */
export function stackHeight(frac: number, bodyH: number): number {
  const max = Math.max(PANEL_MIN_H, bodyH - CHAT_MIN_H);
  return Math.round(Math.min(max, Math.max(PANEL_MIN_H, clampFrac(frac) * bodyH)));
}

/** A dragged height back to the share that is remembered (shares survive rotating and resizing the window). */
export const fracOf = (h: number, bodyH: number) => (bodyH > 0 ? clampFrac(h / bodyH) : STACK_DEFAULT.browser);

/** Remembered shares, from localStorage's JSON: anything malformed is dropped, so each kind falls back to its default. */
export function readStack(raw: string | null): Partial<Record<PanelKind, number>> {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    if (!v || typeof v !== "object") return {};
    const out: Partial<Record<PanelKind, number>> = {};
    for (const k of Object.keys(STACK_DEFAULT) as PanelKind[]) {
      const f = (v as Record<string, unknown>)[k];
      if (typeof f === "number" && Number.isFinite(f)) out[k] = clampFrac(f);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * A split's direction on screen. In "stacked", a side-by-side split narrower than two readable panes shows its panes
 * top / bottom instead (the tree keeps "row", so going back to landscape shows them side by side again).
 */
export const SPLIT_SIDE_MIN = 480;
export function splitDir(mode: LayoutMode, dir: "row" | "col", boxW: number): "row" | "col" {
  return mode === "stacked" && dir === "row" && boxW > 0 && boxW < SPLIT_SIDE_MIN * 2 ? "col" : dir;
}

/** The sidebar is remembered per arrangement: open or closed, and its width (narrower by default when stacked). */
export const SIDEBAR_DEFAULT: Record<LayoutMode, number> = { wide: 300, stacked: 256 };
export function sidebarKeys(mode: LayoutMode): { open: string; width: string } {
  return mode === "wide" ? { open: "coool.sidebarOpen", width: "coool.sidebar" } : { open: "coool.sidebarOpen.stacked", width: "coool.sidebar.stacked" };
}
