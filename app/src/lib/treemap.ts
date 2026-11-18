// Squarified treemap layout (Bruls, Huizing & van Wijk): rows of tiles laid
// along the shorter side, each row grown while that keeps its tiles closer to
// square. Values in the order given (largest first gives the squarest tiles).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The worst aspect ratio in a row of `areas` laid along a side of length `side`. */
function worst(areas: number[], side: number): number {
  const s = areas.reduce((n, a) => n + a, 0);
  if (s <= 0 || side <= 0) return Infinity;
  const s2 = s * s;
  const side2 = side * side;
  let w = 0;
  for (const a of areas) if (a > 0) w = Math.max(w, (side2 * a) / s2, s2 / (side2 * a));
  return w;
}

/** One rectangle per value, tiling `r` exactly (zero values get empty rectangles). */
export function squarify(values: number[], r: Rect): Rect[] {
  const total = values.reduce((n, v) => n + Math.max(0, v), 0);
  const out: Rect[] = values.map(() => ({ x: r.x, y: r.y, w: 0, h: 0 }));
  if (total <= 0 || r.w <= 0 || r.h <= 0) return out;
  const scale = (r.w * r.h) / total;
  const idx = values.map((_, i) => i).filter((i) => values[i] > 0);
  const areas = idx.map((i) => values[i] * scale);
  let rect = { ...r };
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(rect.w, rect.h);
    let row = [areas[i]];
    let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]], side) <= worst(row, side)) row = [...row, areas[j++]];
    const sum = row.reduce((n, a) => n + a, 0);
    const last = j >= areas.length;
    if (rect.w >= rect.h) {
      // A column on the left.
      const cw = last ? rect.w : sum / rect.h;
      let y = rect.y;
      row.forEach((a, k) => {
        const h = k === row.length - 1 ? rect.y + rect.h - y : a / cw;
        out[idx[i + k]] = { x: rect.x, y, w: cw, h };
        y += h;
      });
      rect = { x: rect.x + cw, y: rect.y, w: rect.w - cw, h: rect.h };
    } else {
      // A row along the top.
      const rh = last ? rect.h : sum / rect.w;
      let x = rect.x;
      row.forEach((a, k) => {
        const w = k === row.length - 1 ? rect.x + rect.w - x : a / rh;
        out[idx[i + k]] = { x, y: rect.y, w, h: rh };
        x += w;
      });
      rect = { x: rect.x, y: rect.y + rh, w: rect.w, h: rect.h - rh };
    }
    i = j;
  }
  return out;
}
