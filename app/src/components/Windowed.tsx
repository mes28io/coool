// A long timeline drawn only near the viewport (CHAT_SPEC "Long timelines"): the rows within about a screen above
// and below what is shown are in the DOM; the rest are two spacers whose heights come from each row's measured
// height (cached per row key; an estimate until a row has been on screen once). What is read stays put while rows
// above it change height, are added or dropped (WebKit has no CSS scroll anchoring): the first row that starts in
// the viewport is the anchor, and after every commit and every measured change the scroller moves by however far
// that row moved. While the reader is pinned to the bottom, the window is the last rows and the view follows them.
//
// `must` rows are drawn wherever they are (a pending approval or question, a subagent card asked for), each in
// place between spacers; `api.ensure(key)` draws one for a caller about to scroll to it (checkpoints, the away
// card's turns), then it can be scrolled to like any element.

import { addTime } from "../lib/perfCount";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

export interface WindowApi {
  /** Draw the row `key` (if it isn't) and resolve with its element once it is in the DOM; null for no such row. */
  ensure(key: string): Promise<HTMLElement | null>;
  /** Whether the row is drawn now. */
  drawn(key: string): boolean;
  /** Keep the drawn rows as they are (no window moves, no anchoring) for `ms`: a programmatic smooth scroll runs undisturbed. */
  hold(ms: number): void;
}

/** px drawn beyond the viewport, above and below (at least a viewport). */
const OVERSCAN = 900;

type Range = { start: number; end: number };

export function Windowed({
  scroller,
  stick,
  keys,
  renderRow,
  estimate,
  gap,
  must,
  api,
  follow = true,
  className,
}: {
  scroller: RefObject<HTMLDivElement | null>;
  /** Pinned to the bottom: the window is the last rows and the view follows them. */
  stick: { current: boolean };
  keys: string[];
  /** One row's content. `fresh`: it arrived while on screen and is drawn for the first time (entrance animation). */
  renderRow: (i: number, fresh: boolean) => ReactNode;
  /** A row's height before it has been measured. */
  estimate: (i: number) => number;
  /** The column's gap between rows (px). */
  gap: number;
  /** Rows drawn wherever they are. */
  must?: readonly string[];
  api?: { current: WindowApi | null };
  /** While pinned, keep the bottom in view as rows change height (off: the caller scrolls, e.g. smoothly). */
  follow?: boolean;
  className?: string;
}) {
  const heights = useRef(new Map<string, number>());
  const els = useRef(new Map<string, HTMLElement>());
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  /** The first row starting in the viewport, and its top relative to the viewport's top (px). */
  const anchor = useRef<{ key: string; index: number; top: number } | null>(null);
  const forced = useRef(new Map<string, number>());
  const waiting = useRef(new Map<string, ((el: HTMLElement | null) => void)[]>());
  const holdUntil = useRef(0);
  const held = useRef<string[] | null>(null);
  const drawn = useRef<string[]>([]);
  const range = useRef<Range>({ start: 0, end: 0 });
  // Rows there from the first render, and rows first seen while not drawn: neither ever animates in.
  const initial = useRef<Set<string> | null>(null);
  const born = useRef(new Map<string, boolean>());
  const [, setTick] = useState(0);
  const ro = useRef<ResizeObserver | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const est = useRef(estimate);
  est.current = estimate;
  const followRef = useRef(follow);
  followRef.current = follow;

  const h = (i: number, ks = keysRef.current) => heights.current.get(ks[i]) ?? est.current(i);

  /** The rows to draw: the window around the anchor (or the last rows while pinned). */
  const compute = (ks: string[]): Range => {
    const n = ks.length;
    const el = scroller.current;
    const view = el?.clientHeight || 800;
    const over = Math.max(OVERSCAN, view);
    const a = anchor.current;
    let ai = -1;
    if (!stick.current && a) {
      ai = a.index < n && ks[a.index] === a.key ? a.index : ks.indexOf(a.key);
      // The anchor row left (a chat past its item cap dropped it): the nearest row by position.
      if (ai < 0) ai = Math.min(n - 1, a.index);
    }
    if (ai < 0) {
      let start = n;
      let acc = 0;
      while (start > 0 && acc < view + over) acc += h(--start, ks) + gap;
      return { start, end: n };
    }
    let start = ai;
    let acc = 0;
    const above = Math.max(0, a!.top) + over;
    while (start > 0 && acc < above) acc += h(--start, ks) + gap;
    let end = ai;
    acc = Math.min(0, a!.top);
    const below = view + over;
    while (end < n && acc < below) acc += h(end++, ks) + gap;
    return { start, end };
  };

  /** Keep the anchor row where it was (or the bottom in view while pinned). Layout is clean when this runs. */
  const fix = () => {
    const el = scroller.current;
    if (!el || performance.now() < holdUntil.current) return;
    if (stick.current) {
      if (!followRef.current) return;
      const max = el.scrollHeight - el.clientHeight;
      if (Math.abs(el.scrollTop - max) > 1) el.scrollTop = max;
      return;
    }
    const a = anchor.current;
    const node = a && els.current.get(a.key);
    if (!a || !node) return;
    const d = node.getBoundingClientRect().top - el.getBoundingClientRect().top - a.top;
    if (Math.abs(d) >= 0.5) el.scrollTop += d;
  };

  /** The anchor: the first drawn row that starts inside the viewport, else the one covering its top. */
  const save = () => {
    const el = scroller.current;
    if (!el || !box.current) return;
    const sr = el.getBoundingClientRect();
    const ks = keysRef.current;
    let cover: { key: string; top: number } | null = null;
    // Drawn rows are in order.
    for (const key of drawn.current) {
      const node = els.current.get(key);
      if (!node) continue;
      const r = node.getBoundingClientRect();
      if (r.bottom <= sr.top) continue;
      if (r.top >= sr.bottom) break;
      if (r.top >= sr.top - 0.5) {
        anchor.current = { key, index: ks.indexOf(key), top: r.top - sr.top };
        return;
      }
      cover = { key, top: r.top - sr.top };
    }
    if (cover) {
      anchor.current = { ...cover, index: ks.indexOf(cover.key) };
      return;
    }
    // Nothing drawn in view (a jump into the spacers): the row at the viewport's top, by the heights known.
    if (!ks.length) return;
    let y = box.current.getBoundingClientRect().top - sr.top;
    let i = 0;
    while (i < ks.length - 1 && y + h(i) + gap <= 0) y += h(i++) + gap;
    anchor.current = { key: ks[i], index: i, top: y };
  };

  // Re-draw when what should be drawn differs from what is (once per frame at most).
  const frame = useRef(0);
  const check = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (performance.now() < holdUntil.current) return;
      const r = compute(keysRef.current);
      if (r.start !== range.current.start || r.end !== range.current.end) setTick((t) => t + 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = scroller.current;
    const obs = new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const t = e.target as HTMLElement;
        if (t === el) {
          changed = true;
          continue;
        }
        const key = t.dataset.vrow;
        if (key === undefined || !els.current.has(key)) continue;
        const v = e.borderBoxSize?.[0]?.blockSize ?? t.getBoundingClientRect().height;
        if (heights.current.get(key) !== v) {
          heights.current.set(key, v);
          changed = true;
        }
      }
      fix();
      if (changed) check();
    });
    ro.current = obs;
    for (const node of els.current.values()) obs.observe(node);
    if (el) obs.observe(el);
    const onScroll = () => {
      if (performance.now() < holdUntil.current) return;
      save();
      check();
    };
    el?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      obs.disconnect();
      ro.current = null;
      el?.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refFor = (key: string) => {
    let f = refs.current.get(key);
    if (!f) {
      f = (node: HTMLElement | null) => {
        const old = els.current.get(key);
        if (old && old !== node) {
          ro.current?.unobserve(old);
          els.current.delete(key);
          // Drawn again later (scrolled back to): no entrance then.
          born.current.set(key, false);
        }
        if (node) {
          els.current.set(key, node);
          ro.current?.observe(node);
        } else refs.current.delete(key);
      };
      refs.current.set(key, f);
    }
    return f;
  };

  // ---------- what to draw ----------
  const tw = performance.now();
  const n = keys.length;
  const now = performance.now();
  let set: string[];
  let r: Range;
  if (now < holdUntil.current && held.current) {
    r = range.current;
    const have = new Set(keys);
    set = held.current.filter((k) => have.has(k));
  } else {
    r = compute(keys);
    set = [];
  }
  const show = new Set<number>();
  if (set.length) {
    const at = new Map(keys.map((k, i) => [k, i]));
    for (const k of set) show.add(at.get(k)!);
  }
  for (let i = r.start; i < r.end; i++) show.add(i);
  const extra = [...(must ?? []), ...forced.current.keys()];
  if (extra.length) {
    const want = new Set(extra);
    for (let i = 0; i < n && want.size; i++)
      if (want.has(keys[i])) {
        show.add(i);
        want.delete(keys[i]);
      }
  }
  const order = [...show].sort((a, b) => a - b);
  if (initial.current === null) initial.current = new Set(keys);
  const drawnKeys = order.map((i) => keys[i]);
  {
    const on = new Set(drawnKeys);
    // New rows arrive at the end: from there back to the first one already known.
    for (let i = n - 1; i >= 0 && !born.current.has(keys[i]); i--) born.current.set(keys[i], !initial.current.has(keys[i]) && on.has(keys[i]));
  }

  const out: ReactNode[] = [];
  let prev = 0;
  const pad = (a: number, b: number) => {
    let s = gap * (b - a - 1);
    for (let i = a; i < b; i++) s += h(i);
    return s;
  };
  for (const i of order) {
    if (i > prev) out.push(<div key={`pad:${prev}`} aria-hidden data-vpad style={{ height: pad(prev, i) }} />);
    const key = keys[i];
    out.push(
      <div key={key} data-vrow={key} ref={refFor(key)}>
        {renderRow(i, born.current.get(key) === true)}
      </div>,
    );
    prev = i + 1;
  }
  if (prev < n) out.push(<div key={`pad:${prev}`} aria-hidden data-vpad style={{ height: pad(prev, n) }} />);

  addTime("windowed.render", performance.now() - tw);
  // After every commit: what was drawn, the scroll kept, waiting callers answered.
  useLayoutEffect(() => {
    const te = performance.now();
    range.current = r;
    drawn.current = drawnKeys;
    fix();
    if (!anchor.current || !els.current.has(anchor.current.key)) save();
    for (const [key, cbs] of waiting.current) {
      const node = els.current.get(key);
      if (node || !keysRef.current.includes(key)) {
        waiting.current.delete(key);
        cbs.forEach((cb) => cb(node ?? null));
      }
    }
    const t = performance.now();
    for (const [key, until] of forced.current) if (t > until) forced.current.delete(key);
    addTime("windowed.effect", performance.now() - te);
  });

  if (api)
    api.current = {
      ensure: (key) => {
        if (!keysRef.current.includes(key)) return Promise.resolve(null);
        const node = els.current.get(key);
        if (node) return Promise.resolve(node);
        forced.current.set(key, performance.now() + 4000);
        return new Promise((done) => {
          const l = waiting.current.get(key) ?? [];
          l.push(done);
          waiting.current.set(key, l);
          setTick((t) => t + 1);
        });
      },
      drawn: (key) => els.current.has(key),
      hold: (ms) => {
        holdUntil.current = performance.now() + ms;
        held.current = drawn.current.slice();
        setTimeout(() => {
          if (performance.now() < holdUntil.current) return;
          held.current = null;
          save();
          setTick((t) => t + 1);
        }, ms + 20);
      },
    };

  return (
    <div ref={box} className={className} data-windowed={n}>
      {out}
    </div>
  );
}

/** A drawn row far from the view (more than a screen away): scroll it to a third of the way down, at once. */
export function bringNear(el: HTMLElement | null, key: string, stick: { current: boolean }) {
  const row = el?.querySelector<HTMLElement>(`[data-vrow="${CSS.escape(key)}"]`);
  if (!el || !row) return;
  const top = row.getBoundingClientRect().top - el.getBoundingClientRect().top;
  if (top > -el.clientHeight && top < el.clientHeight * 2) return;
  stick.current = false;
  el.scrollTop += top - el.clientHeight / 3;
}

/** Where UI state that must outlive a row's unmounting (scrolled out of the window) is kept: the timeline's id. */
export const KeepScope = createContext<string>("");

const kept = new Map<string, unknown>();

/**
 * `useState` for a row's own open/closed state that survives the row being dropped from the window and drawn
 * again. Only a value the person set is kept (for the app run).
 */
export function useKept<T>(name: string, init: T | (() => T)): [T, (v: T) => void] {
  const scope = useContext(KeepScope);
  const key = `${scope}\u0001${name}`;
  const [v, setV] = useState<T>(() => (kept.has(key) ? (kept.get(key) as T) : typeof init === "function" ? (init as () => T)() : init));
  const set = useCallback(
    (x: T) => {
      kept.set(key, x);
      setV(x);
    },
    [key],
  );
  return [v, set];
}
