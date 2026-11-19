// The session hover card's pure parts (components/HoverCard.tsx; tested in hoverRest.test.ts): how long the pointer
// rests before it shows, where it goes beside its row, and the last prompt's first line.

export const HOVER_REST_MS = 500;
const GAP = 8;
const EDGE = 8;

type Rect = { left: number; top: number; right: number; bottom: number };

/**
 * Where the card goes: right of a sidebar row (top-aligned), or below a tab (left-aligned). Kept inside the window;
 * a card with no room on the right goes on the left, one with no room below goes above.
 */
export function hoverAnchor(r: Rect, side: "right" | "below", card: { w: number; h: number }, win: { w: number; h: number }): { left: number; top: number } {
  const clampX = (x: number) => Math.max(EDGE, Math.min(x, win.w - card.w - EDGE));
  const clampY = (y: number) => Math.max(EDGE, Math.min(y, win.h - card.h - EDGE));
  if (side === "right") {
    const right = r.right + GAP;
    const left = right + card.w + EDGE <= win.w ? right : r.left - GAP - card.w;
    return { left: clampX(left), top: clampY(r.top - 4) };
  }
  const below = r.bottom + GAP;
  const top = below + card.h + EDGE <= win.h ? below : r.top - GAP - card.h;
  return { left: clampX(r.left), top: clampY(top) };
}

/** A prompt's first non-empty line, trimmed, at most `max` characters (with "…"); "" for none. */
export function firstLine(text: string | null | undefined, max = 160): string {
  const line = (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
