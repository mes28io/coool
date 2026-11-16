import { useRef } from "react";

/**
 * Keeps a list's order still while `frozen` (e.g. the pointer is over it):
 * items already shown keep their places, new ones are appended at the end.
 * When it unfreezes, the natural order returns and layout animations glide
 * rows into place, away from the cursor.
 */
export function useStableOrder<T>(items: T[], key: (t: T) => string, frozen: boolean): T[] {
  const last = useRef<string[]>([]);
  if (!frozen) {
    last.current = items.map(key);
    return items;
  }
  const by = new Map(items.map((t) => [key(t), t]));
  const out: T[] = [];
  for (const k of last.current) {
    const t = by.get(k);
    if (t) {
      out.push(t);
      by.delete(k);
    }
  }
  for (const t of items) if (by.has(key(t))) out.push(t);
  last.current = out.map(key);
  return out;
}

/**
 * Keys for a reorderable list that never glides rows across each other. Items that kept their relative order
 * (the longest run in the previous order) keep their key; an item that moved past others gets a new
 * generation, so its old place closes (exit) and its new place opens (enter). The list is always laid out
 * in flow, so no frame can show two rows on top of each other or a hole between them.
 */
export function useMoveKeys(keys: string[]): (key: string) => string {
  const st = useRef<{ sig: string; order: string[]; gen: Map<string, number> }>({ sig: "", order: [], gen: new Map() });
  const sig = keys.join("\n");
  const s = st.current;
  if (sig !== s.sig) {
    const prev = new Map(s.order.map((k, i) => [k, i]));
    const kept = keysInLongestRun(keys.filter((k) => prev.has(k)), prev);
    for (const k of keys) if (prev.has(k) && !kept.has(k)) s.gen.set(k, (s.gen.get(k) ?? 0) + 1);
    st.current = { sig, order: keys, gen: s.gen };
  }
  const gen = st.current.gen;
  return (k) => `${k}~${gen.get(k) ?? 0}`;
}

/** The keys on a longest increasing subsequence of their previous indices (O(n log n)). */
function keysInLongestRun(keys: string[], prev: Map<string, number>): Set<string> {
  const tails: number[] = [];
  const back: number[] = Array.from({ length: keys.length }, () => -1);
  for (let i = 0; i < keys.length; i++) {
    const v = prev.get(keys[i])!;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (prev.get(keys[tails[mid]])! < v) lo = mid + 1;
      else hi = mid;
    }
    back[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const out = new Set<string>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = back[i]) out.add(keys[i]);
  return out;
}
