// Keeping underline ranges right while the person types: one contiguous edit per change, ranges shifted past it,
// and the stretch that needs re-checking. Pure: unit-tested in ranges.test.ts.

import type { Span } from "./text.ts";

export interface Edit {
  from: number;
  removed: number;
  inserted: number;
}

export function diffEdit(prev: string, next: string): Edit | null {
  if (prev === next) return null;
  const max = Math.min(prev.length, next.length);
  let p = 0;
  while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  return { from: p, removed: prev.length - p - s, inserted: next.length - p - s };
}

/** Typing right against a word (either edge) changes that word, so an edit touching an edge counts as touching. */
export function mapSpan<T extends Span>(s: T, e: Edit): T | null {
  const end = e.from + e.removed;
  if (end < s.from) return { ...s, from: s.from + e.inserted - e.removed, to: s.to + e.inserted - e.removed };
  if (e.from > s.to) return s;
  return null;
}

const wordChar = (c: string | undefined) => !!c && /[\p{L}\p{M}\p{N}_'’-]/u.test(c);

/** The edited stretch of `next`, widened to whole words plus one word on each side (a two-word library term may
 *  start or end next to the edit); with `sentence`, widened to the whole sentence (for grammar). */
export function dirtyRange(next: string, e: Edit, sentence = false): Span {
  let from = Math.max(0, Math.min(e.from, next.length));
  let to = Math.max(from, Math.min(e.from + e.inserted, next.length));
  if (sentence) {
    while (from > 0 && !/[.!?\n]/.test(next[from - 1])) from--;
    while (to < next.length && !/[.!?\n]/.test(next[to])) to++;
    if (to < next.length) to++;
    while (from < to && /\s/.test(next[from])) from++;
    return { from, to };
  }
  while (from > 0 && wordChar(next[from - 1])) from--;
  while (to < next.length && wordChar(next[to])) to++;
  // One neighbouring word each side.
  let f = from;
  while (f > 0 && !wordChar(next[f - 1]) && next[f - 1] !== "\n") f--;
  if (f < from && wordChar(next[f - 1])) {
    while (f > 0 && wordChar(next[f - 1])) f--;
    from = f;
  }
  let t = to;
  while (t < next.length && !wordChar(next[t]) && next[t] !== "\n") t++;
  if (t > to && wordChar(next[t])) {
    while (t < next.length && wordChar(next[t])) t++;
    to = t;
  }
  return { from, to };
}
