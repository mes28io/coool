// Where a tooltip goes: beside its element, inside the window, off the areas it must not cover.

export type Box = { left: number; top: number; right: number; bottom: number };
export type Side = "below" | "above" | "right" | "left";

const GAP = 6;
const EDGE = 8;

const hits = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/**
 * The tooltip's top-left corner and side for an element at `anchor`: below it (centred), else above, right, left,
 * taking the first side where it fits the window `win` with an 8px margin and overlaps none of `avoid`. When no side
 * does, the first that fits the window; when none fits, below, pushed inside the window.
 */
export function placeTip(anchor: Box, tip: { w: number; h: number }, win: { w: number; h: number }, avoid: Box[] = []): { left: number; top: number; side: Side } {
  const cx = (anchor.left + anchor.right) / 2;
  const cy = (anchor.top + anchor.bottom) / 2;
  const clampX = (x: number) => Math.round(Math.max(EDGE, Math.min(x, win.w - EDGE - tip.w)));
  const clampY = (y: number) => Math.round(Math.max(EDGE, Math.min(y, win.h - EDGE - tip.h)));
  const tries: { side: Side; left: number; top: number; fits: boolean }[] = [
    { side: "below", left: clampX(cx - tip.w / 2), top: Math.round(anchor.bottom + GAP), fits: anchor.bottom + GAP + tip.h <= win.h - EDGE },
    { side: "above", left: clampX(cx - tip.w / 2), top: Math.round(anchor.top - GAP - tip.h), fits: anchor.top - GAP - tip.h >= EDGE },
    { side: "right", left: Math.round(anchor.right + GAP), top: clampY(cy - tip.h / 2), fits: anchor.right + GAP + tip.w <= win.w - EDGE },
    { side: "left", left: Math.round(anchor.left - GAP - tip.w), top: clampY(cy - tip.h / 2), fits: anchor.left - GAP - tip.w >= EDGE },
  ];
  const box = (t: { left: number; top: number }): Box => ({ left: t.left, top: t.top, right: t.left + tip.w, bottom: t.top + tip.h });
  const pick = tries.find((t) => t.fits && !avoid.some((a) => hits(box(t), a))) ?? tries.find((t) => t.fits);
  if (pick) return { left: pick.left, top: pick.top, side: pick.side };
  return { left: tries[0].left, top: clampY(tries[0].top), side: "below" };
}
