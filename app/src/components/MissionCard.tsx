// Mission control's one card system (APP_SPEC "Mission control"): every card on the page (sessions,
// changes, commit trail) is built from these parts, so they read as one surface.
//
//   card     rounded 14, hairline border, page background
//   header   40px: a 16px icon column, the title (base, medium), one quiet meta on the right
//   row      36px, one line: the same 16px node column (status dot, change icon or graph node), text
//            from x = 40px (primary: base fg; secondary: small dim; mono only for paths and branches),
//            then right-aligned extras and a 32px time column ("12s", "4m", "3h", "2d")
//   footer   36px "Show all N", its text on the text column
//
// A list card fills the height its grid cell gives it and shows the rows that fit (`useFit`), so the
// two columns end together; "Show all" lists the rest.

import { useLayoutEffect, useRef, useState, type ComponentType, type ReactNode, type RefObject } from "react";
import { useClock } from "../lib/clock";
import { compactSpan } from "../lib/mission";
import { cx } from "./primitives";

/** One row's height (px); everything on the page is a multiple of it. */
export const ROW = 36;
/** Card padding left and right (px); the node column starts here. */
export const PAD = 14;
/** The node column (px), and the gap after it: text starts at PAD + NODE + GAP = 40px. */
export const NODE = 16;
export const GAP = 10;
export const TEXT_X = PAD + NODE + GAP;

type Icon = ComponentType<{ size?: number; className?: string }>;

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & Record<`data-${string}`, unknown>) {
  return (
    <section className={cx("flex min-w-0 flex-col overflow-hidden rounded-[14px] border border-hairline bg-bg", className)} {...rest}>
      {children}
    </section>
  );
}

export function CardHeader({ icon: I, title, meta, mono }: { icon: Icon; title: ReactNode; meta?: ReactNode; mono?: boolean }) {
  return (
    <header className="flex h-[40px] shrink-0 items-center gap-2.5 border-b border-hairline px-3.5">
      <span className="flex w-[16px] shrink-0 justify-center text-dim">
        <I size={14} />
      </span>
      <span className={cx("min-w-0 truncate font-medium text-fg", mono ? "font-mono text-mono-base" : "text-base")}>{title}</span>
      {meta != null && meta !== false && <span className="ml-auto flex shrink-0 items-center gap-2 text-small text-faint tnum">{meta}</span>}
    </header>
  );
}

/** The 16px node column of a row. */
export function Node({ children, className }: { children?: ReactNode; className?: string }) {
  return <span className={cx("flex w-[16px] shrink-0 items-center justify-center", className)}>{children}</span>;
}

/** The time column: a compact age (or, with `live`, a running elapsed time), right-aligned. */
export function Age({ ms, className, title }: { ms: number | null; className?: string; title?: string }) {
  const text = useClock((now) => (ms === null ? "" : compactSpan(now - ms)));
  return (
    <span className={cx("w-[32px] shrink-0 text-right text-small text-faint tnum", className)} title={title}>
      {text}
    </span>
  );
}

export function ShowAll({ total, all, onToggle }: { total: number; all: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} className="flex h-[36px] w-full shrink-0 items-center border-t border-hairline text-left text-small text-dim transition-colors duration-150 hover:bg-hover hover:text-fg" style={{ paddingLeft: TEXT_X }} data-mc-showall>
      {all ? "Show fewer" : `Show all ${total}`}
    </button>
  );
}

/**
 * How many rows fit the list area `ref` (its height over ROW), at least `min`. The area is the card's
 * flexible part: its own minimum is `min` rows, and a taller grid cell gives it more.
 */
export function useFit(ref: RefObject<HTMLElement | null>, min: number): number {
  const [n, setN] = useState(min);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setN(Math.max(min, Math.floor((el.clientHeight + 0.5) / ROW)));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, min]);
  return n;
}

/**
 * A card's list: shows the rows that fit its area (`render(count)`), with "Show all N" when some don't.
 * `minRows` is the area's own height in rows; `total` is how many rows there are.
 */
export function FitList({ total, minRows, render, className }: { total: number; minRows: number; render: (count: number) => ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [all, setAll] = useState(false);
  // The area's own height: up to `minRows` rows, the last of them the footer when not all fit.
  const own = Math.min(total, minRows);
  const fit = useFit(ref, own);
  const room = fit >= total ? total : Math.max(1, fit - 1);
  return (
    <div ref={ref} className={cx("flex min-h-0 flex-col overflow-hidden", !all && "flex-1", className)} style={{ minHeight: all ? undefined : own * ROW }}>
      {render(all ? total : room)}
      {(all ? total > own : total > room) && (
        <div className="mt-auto">
          <ShowAll total={total} all={all} onToggle={() => setAll((v) => !v)} />
        </div>
      )}
    </div>
  );
}
