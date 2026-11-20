// Keeping the reader's place when the layout mode changes (lib/layout.ts): rotating the display or dragging the window
// across the portrait line rewraps a timeline at a new width, and WebKit has no scroll anchoring, so a reader scrolled
// up would land somewhere else. The line at the top of the view is remembered as they scroll and put back where it
// was, through the frames the sidebar and panels take to settle. A timeline pinned to the bottom stays pinned (its own
// ResizeObserver does that).

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { useLayoutMode } from "./layout";

/** `stuck`: the timeline was pinned to the bottom when the reader left it there. */
type Anchor = { el: Element; off: number; stuck?: boolean };

/**
 * What the reader sees first: going down a few levels, the first element that reaches into the view, until one is
 * about a line or two tall; one that starts above the view gives way to the next sibling that starts inside it (its
 * own rewrapping would otherwise move what is under it). Returns it and how far below the view's top it sits.
 */
function pick(scroller: HTMLElement): Anchor | null {
  const top = scroller.getBoundingClientRect().top;
  const bottom = scroller.getBoundingClientRect().bottom;
  let node: Element = scroller;
  let found: Element | null = null;
  for (let depth = 0; depth < 12; depth++) {
    let next: Element | null = null;
    for (const c of node.children) {
      const r = c.getBoundingClientRect();
      if (r.height > 0 && r.bottom > top + 1) {
        next = c;
        break;
      }
    }
    if (!next) break;
    found = next;
    if (next.getBoundingClientRect().height < 80) break;
    node = next;
  }
  // Starts above the view: its own rewrapping would move what is under it, so the nearest element after it (at its
  // level or an outer one) that starts inside the view anchors instead, if there is one.
  for (let at: Element | null = found; at && at !== scroller && found && found.getBoundingClientRect().top < top - 1; at = at.parentElement) {
    let sib = at.nextElementSibling;
    while (sib && sib.getBoundingClientRect().height === 0) sib = sib.nextElementSibling;
    const sr = sib?.getBoundingClientRect();
    if (sib && sr && sr.top >= top - 1 && sr.top < bottom) {
      found = sib;
      break;
    }
  }
  return found ? { el: found, off: found.getBoundingClientRect().top - top } : null;
}

const SETTLE_MS = 900;

export function useKeepReadingPlace(scroller: RefObject<HTMLElement | null>, stick: RefObject<boolean>) {
  const mode = useLayoutMode();
  const anchor = useRef<Anchor | null>(null);
  const restoringUntil = useRef(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let raf = 0;
    let size = "";
    const record = () => {
      raf = 0;
      if (performance.now() < restoringUntil.current) return;
      // A scroll that comes with a new size is the layout's (the view got taller and the top clamped), not the
      // reader's: the place they left stays the one to go back to.
      const now = `${el.clientWidth}x${el.clientHeight}`;
      const resized = size !== "" && now !== size;
      size = now;
      if (resized) return;
      const a = pick(el);
      anchor.current = a && { ...a, stuck: !!stick.current };
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(record);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    record();
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [scroller]);
  const shown = useRef(mode);
  useLayoutEffect(() => {
    if (shown.current === mode) return;
    shown.current = mode;
    const el = scroller.current;
    const a = anchor.current;
    // Pinned to the bottom when the reader left it: it stays pinned (the timeline does that). Otherwise the place comes
    // back, even if a view tall enough to show everything counted as "at the bottom" in between.
    if (!el || !a || a.stuck || !a.el.isConnected) return;
    stick.current = false;
    restoringUntil.current = performance.now() + SETTLE_MS;
    const align = () => {
      const d = a.el.getBoundingClientRect().top - el.getBoundingClientRect().top - a.off;
      if (Math.abs(d) >= 1) el.scrollTop += d;
    };
    align();
    const ro = new ResizeObserver(align);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    const t = setTimeout(() => ro.disconnect(), SETTLE_MS);
    return () => {
      ro.disconnect();
      clearTimeout(t);
    };
  }, [mode, scroller, stick]);
}
