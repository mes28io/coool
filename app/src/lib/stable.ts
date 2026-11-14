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
