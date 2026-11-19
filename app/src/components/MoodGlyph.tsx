// The subagent "now" mark: one small glyph per activity mood (lib/activityMood.ts), quietly
// animated while live. The main agent gets a thinking orb (ThinkOrb); subagents get this, so a
// panel full of running agents stays calm. Drawn on the 16 grid of icons.tsx, in its Geist style
// (1.5 stroke, round caps and joins, .25/.75 grid, filled dots), one colour (currentColor).
// Motion (moodGlyph.css) runs on the compositor: every moving part is its own <svg> stacked in the glyph's box, and
// only that element's transform or opacity animates, never anything inside an SVG (WebKit repaints SVG content on the
// main thread every display frame while it animates; docs/PERF.md). `live={false}`, a static AnimateScope
// (lib/motion.ts) and reduced motion show the first frame, which is a complete icon on its own. A change of mood
// cross-fades inside a fixed box (no layout shift).
import type { ReactNode } from "react";
import type { Mood } from "../lib/activityMood";
import { useLive } from "../lib/motion";
import { cx } from "./primitives";
import "./moodGlyph.css";

/** A filled dot (the family's "point": 2 units across). */
const Dot = ({ x, y, r = 1 }: { x: number; y: number; r?: number }) => <circle cx={x} cy={y} r={r} fill="currentColor" stroke="none" />;

/** One layer of a glyph: the whole 16 grid, stacked over the others; `c` names its animation (moodGlyph.css). */
const L = ({ c, children }: { c?: string; children: ReactNode }) => (
  <svg viewBox="0 0 16 16" className={cx("mg-l", c)} aria-hidden>
    {children}
  </svg>
);

const RING = Array.from({ length: 8 }, (_, k) => {
  const a = ((k * 45 - 90) * Math.PI) / 180;
  return { x: +(8 + 4.75 * Math.cos(a)).toFixed(3), y: +(8 + 4.75 * Math.sin(a)).toFixed(3) };
});

const GLYPHS: Record<Mood, ReactNode> = {
  // A thought bubble; its three dots light in turn.
  think: (
    <>
      <L>
        <path d="M3.25 2.75h9.5a1.5 1.5 0 011.5 1.5v5.5a1.5 1.5 0 01-1.5 1.5h-4.5l-3.5 3v-3h-1.5a1.5 1.5 0 01-1.5-1.5v-5.5a1.5 1.5 0 011.5-1.5z" />
      </L>
      {[5.25, 8, 10.75].map((x, i) => (
        <L key={x} c={`mg-think-dot mg-think-dot-${i}`}>
          <Dot x={x} y={7} r={0.9} />
        </L>
      ))}
    </>
  ),
  // Three rows; the marks tick in order, top to bottom.
  plan: (
    <>
      <L>
        {[3.75, 8, 12.25].map((y) => (
          <path key={y} d={`M8.75 ${y}H14.25`} />
        ))}
      </L>
      {[3.75, 8, 12.25].map((y, i) => (
        <g key={y}>
          <L c={`mg-plan-dot mg-plan-dot-${i}`}>
            <Dot x={4} y={y} />
          </L>
          <L c={`mg-plan-tick mg-plan-tick-${i}`}>
            <path d={`M2.25 ${y}l1.5 1.5L6.5 ${y - 1.25}`} />
          </L>
        </g>
      ))}
    </>
  ),
  // A lens slowly sweeping a small circle.
  search: (
    <L c="mg-search">
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.25 3.25" />
    </L>
  ),
  // An open book; a page turns over every so often.
  read: (
    <>
      <L>
        <path d="M8 5C6.7 3.7 4.8 3.2 2.5 3.4V11.9C4.8 11.7 6.7 12.2 8 13.25C9.3 12.2 11.2 11.7 13.5 11.9V3.4C11.2 3.2 9.3 3.7 8 5Z" />
        <path d="M8 5V13.25" />
      </L>
      <L c="mg-read-page">
        <path d="M8 5C9.3 3.7 11.2 3.2 13.5 3.4V11.9C11.2 11.7 9.3 12.2 8 13.25" />
      </L>
    </>
  ),
  // A pencil drawing the line under it (the line shows through a window that opens left to right).
  write: (
    <>
      <span className="mg-write-win">
        <L c="mg-write-line">
          <path d="M2.25 13.25H7.75" />
        </L>
      </span>
      <L c="mg-write-pen">
        <path d="M12.4 4.45L14.05 6.1L9.7 10.45L7.75 10.75L8.05 8.8Z" />
      </L>
    </>
  ),
  // A prompt and its cursor.
  run: (
    <>
      <L>
        <path d="M3.25 4.25L7 8l-3.75 3.75" />
      </L>
      <L c="mg-run-cursor">
        <path d="M8.75 11.75H13" />
      </L>
    </>
  ),
  // One node handing work to two; a bead travels down each branch in turn.
  delegate: (
    <>
      <L>
        <circle cx="3.5" cy="8" r="1.75" />
        <circle cx="12.5" cy="3.75" r="1.75" />
        <circle cx="12.5" cy="12.25" r="1.75" />
        <path d="M5.25 8C8 8 8 3.75 10.75 3.75M5.25 8C8 8 8 12.25 10.75 12.25" opacity={0.6} />
      </L>
      <L c="mg-bead mg-bead-0">
        <Dot x={5.25} y={8} r={1.125} />
      </L>
      <L c="mg-bead mg-bead-1">
        <Dot x={5.25} y={8} r={1.125} />
      </L>
    </>
  ),
  // A ring of points filling one by one.
  start: (
    <>
      {RING.map((p, k) => (
        <L key={k} c={`mg-ring mg-ring-${k}`}>
          <Dot x={p.x} y={p.y} r={1.05} />
        </L>
      ))}
    </>
  ),
  // Two chevrons pressing a line between them.
  compact: (
    <>
      <L c="mg-compact-top">
        <path d="M5.25 2.75L8 5.25L10.75 2.75" />
      </L>
      <L c="mg-compact-mid">
        <path d="M3 8H13" />
      </L>
      <L c="mg-compact-bot">
        <path d="M5.25 13.25L8 10.75L10.75 13.25" />
      </L>
    </>
  ),
  // Three points on a slow orbit.
  other: (
    <L c="mg-other">
      <Dot x={8} y={3.75} r={1.35} />
      <g opacity={0.7}>
        <Dot x={11.68} y={10.125} r={1.35} />
      </g>
      <g opacity={0.45}>
        <Dot x={4.32} y={10.125} r={1.35} />
      </g>
    </L>
  ),
};

/** The glyph's box: `size` square (an inline-block, like the single svg it was), its layers stacked in it. */
function Box({ size, className, live, children, ...data }: { size: number; className?: string; live: boolean; children: ReactNode; [k: `data-${string}`]: string | boolean | undefined }) {
  return (
    <span className={cx("mg", className)} style={{ width: size, height: size }} data-live={live ? "true" : "false"} aria-hidden {...data}>
      {children}
    </span>
  );
}

/** One mood's glyph (no cross-fade). */
export function MoodSvg({ mood, size = 14, live = true, className }: { mood: Mood; size?: number; live?: boolean; className?: string }) {
  // Static outside the panes the person is looking at (Home, sidebar) and while motion is reduced.
  const on = useLive() && live;
  return (
    <Box size={size} className={className} live={on} data-mood={mood}>
      {GLYPHS[mood]}
    </Box>
  );
}

/** The glyph for a mood in a fixed `size` box. A new mood replaces the old one outright (keyed, so never two at once, nothing to get stuck) and fades in over ~180 ms. */
export function MoodGlyph({ mood, size = 14, live = true, className }: { mood: Mood; size?: 13 | 14 | number; live?: boolean; className?: string }) {
  return (
    <span className={cx("relative inline-block shrink-0", className)} style={{ width: size, height: size }} data-mood-glyph={mood}>
      <MoodSvg key={mood} mood={mood} size={size} live={live} className="mg-in absolute inset-0 block" />
    </span>
  );
}

/** The browser button's globe: still, it is IGlobe; `live` (a page of this chat's browser is loading), it spins. */
export function GlobeGlyph({ size = 16, live = false, className }: { size?: number; live?: boolean; className?: string }) {
  const on = useLive() && live;
  return (
    <Box size={size} className={className} live={on} data-globe>
      <L>
        <circle cx="8" cy="8" r="6.25" />
        <path d="M1.75 8h12.5" strokeWidth={1} opacity={0.8} />
        {!on && <path d="M8 1.75c-2 2-3 3.9-3 6.25s1 4.25 3 6.25M8 1.75c2 2 3 3.9 3 6.25s-1 4.25-3 6.25" strokeWidth={1} opacity={0.8} />}
      </L>
      {on &&
        [0, 1, 2].map((i) => (
          <L key={i} c={`mg-meridian mg-meridian-${i}`}>
            <path d="M8 1.75a6.25 6.25 0 010 12.5" strokeWidth={1} opacity={0.8} />
          </L>
        ))}
    </Box>
  );
}
