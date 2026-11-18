// The geometry of the holes cut in the sheet's background where the device panels' glass shows (lib/glass.ts).
// Pure, so it runs under `node --test` (glassHoles.test.ts).

/** What `holeRects` needs of an element. */
interface Box {
  isConnected: boolean;
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number };
}

/** Rects of the holes inside `bg` (CSS px, relative to it), clipped to it. Hidden or empty ones are left out. */
export function holeRects(bg: { left: number; top: number; right: number; bottom: number }, els: Iterable<Box>): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (const el of els) {
    if (!el.isConnected) continue;
    const r = el.getBoundingClientRect();
    const x0 = Math.max(r.left, bg.left);
    const y0 = Math.max(r.top, bg.top);
    const x1 = Math.min(r.right, bg.right);
    const y1 = Math.min(r.bottom, bg.bottom);
    if (x1 - x0 < 0.5 || y1 - y0 < 0.5) continue;
    out.push([x0 - bg.left, y0 - bg.top, x1 - x0, y1 - y0]);
  }
  return out;
}

/** The mask that keeps `bg` everywhere but the rects (null: no holes, no mask). */
export function holeMask(rects: [number, number, number, number][]): Record<string, string> | null {
  if (!rects.length) return null;
  const solid = "linear-gradient(#000 0 0)";
  const image = [solid, ...rects.map(() => solid)].join(", ");
  const size = ["100% 100%", ...rects.map(([, , w, h]) => `${w}px ${h}px`)].join(", ");
  const pos = ["0 0", ...rects.map(([x, y]) => `${x}px ${y}px`)].join(", ");
  return { maskImage: image, maskSize: size, maskPosition: pos, maskRepeat: "no-repeat", maskComposite: "exclude" };
}
