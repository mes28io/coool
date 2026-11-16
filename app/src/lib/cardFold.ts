// Open/closed state of a subagent card (Agents panel, chat and timeline cards). A finished card
// (done, failed or stopped) starts collapsed; a running one stays open and folds by itself shortly
// after it finishes, unless the person opened or closed it by hand. A hand-set state is kept for
// the app run (cards remount when the panel or the session changes).
import { useEffect, useRef, useState, type RefObject } from "react";
import { reducedMotion as reduced } from "./motion";

const chosen = new Map<string, boolean>();

/** How long a just-finished card stays open before it folds. */
const SETTLE_MS = 900;
/** Longest fold animation of the cards (keeps the scroll anchor that long). */
const FOLD_MS = 360;

/**
 * Folding a card above what the person is reading must not move it: while the fold animates,
 * keep the card's bottom edge where it was by moving the scroller (no-op when the card starts in view).
 */
export function keepAbove(el: HTMLElement | null) {
  const sc = el?.closest<HTMLElement>(".scroll");
  if (!el || !sc) return;
  if (el.getBoundingClientRect().top >= sc.getBoundingClientRect().top) return;
  let prev = el.getBoundingClientRect().bottom;
  const until = performance.now() + FOLD_MS + 80;
  const step = () => {
    const b = el.getBoundingClientRect().bottom;
    if (b !== prev) sc.scrollTop += b - prev;
    prev = el.getBoundingClientRect().bottom;
    if (performance.now() < until) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function useFold(id: string, finished: boolean, anchor?: RefObject<HTMLElement | null>): [open: boolean, toggle: () => void] {
  const [open, setOpen] = useState(() => chosen.get(id) ?? !finished);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (chosen.has(id)) return setOpen(chosen.get(id)!);
    if (!finished) return setOpen(true);
    if (!openRef.current) return;
    const t = setTimeout(() => {
      if (chosen.has(id)) return;
      keepAbove(anchor?.current ?? null);
      setOpen(false);
    }, reduced() ? 0 : SETTLE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, finished]);
  const toggle = () => {
    const next = !openRef.current;
    chosen.set(id, next);
    keepAbove(anchor?.current ?? null);
    setOpen(next);
  };
  return [open, toggle];
}
