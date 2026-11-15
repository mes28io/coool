// The subagent "now" mark: one small glyph per activity mood (lib/activityMood.ts), quietly
// animated while live. The main agent gets a thinking orb (ThinkOrb); subagents get this, so a
// panel full of running agents stays calm. Drawn on the 16 grid of icons.tsx (1.5 stroke, round
// caps), one colour (currentColor). Motion is CSS keyframes in moodGlyph.css, only on transform,
// opacity and dash offset. `live={false}` and reduced motion show the first frame, which is a
// complete icon on its own. A change of mood cross-fades inside a fixed box (no layout shift).
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import type { Mood } from "../lib/activityMood";
import { cx } from "./primitives";
import { reducedMotion } from "./StepRail";
import "./moodGlyph.css";

/** A filled dot (the family's "point": 2 units across). */
const Dot = ({ x, y, r = 1, className }: { x: number; y: number; r?: number; className?: string }) => <circle cx={x} cy={y} r={r} fill="currentColor" stroke="none" className={className} />;

const RING = Array.from({ length: 8 }, (_, k) => {
  const a = ((k * 45 - 90) * Math.PI) / 180;
  return { x: +(8 + 4.75 * Math.cos(a)).toFixed(3), y: +(8 + 4.75 * Math.sin(a)).toFixed(3) };
});

const GLYPHS: Record<Mood, ReactNode> = {
  // A four-point spark breathing, a small star twinkling beside it.
  think: (
    <>
      <g className="mg-think-spark">
        <path d="M7.5 3.5C7.85 6.6 8.9 7.65 12 8C8.9 8.35 7.85 9.4 7.5 12.5C7.15 9.4 6.1 8.35 3 8C6.1 7.65 7.15 6.6 7.5 3.5Z" />
      </g>
      <Dot x={12.75} y={3.25} className="mg-think-star" />
    </>
  ),
  // Three rows; the marks tick in order, top to bottom.
  plan: (
    <>
      {[4, 8, 12].map((y, i) => (
        <g key={y}>
          <Dot x={4} y={y} className={`mg-plan-dot mg-plan-dot-${i}`} />
          <path d={`M2.5 ${y}l1.25 1.25L6.25 ${y - 1.5}`} className={`mg-plan-tick mg-plan-tick-${i}`} />
          <path d={`M8.75 ${y}H13.5`} />
        </g>
      ))}
    </>
  ),
  // A lens slowly sweeping a small circle.
  search: (
    <g className="mg-search">
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.25 3.25" />
    </g>
  ),
  // An open book; a page turns over every so often.
  read: (
    <>
      <path d="M8 5C6.7 3.7 4.8 3.2 2.5 3.4V11.9C4.8 11.7 6.7 12.2 8 13.25C9.3 12.2 11.2 11.7 13.5 11.9V3.4C11.2 3.2 9.3 3.7 8 5Z" />
      <path d="M8 5V13.25" />
      <path d="M8 5C9.3 3.7 11.2 3.2 13.5 3.4V11.9C11.2 11.7 9.3 12.2 8 13.25" className="mg-read-page" />
    </>
  ),
  // A pencil drawing the line under it.
  write: (
    <>
      <path d="M2.75 13.25H7.75" pathLength={1} className="mg-write-line" />
      <path d="M12.4 4.45L14.05 6.1L9.7 10.45L7.75 10.75L8.05 8.8Z" className="mg-write-pen" />
    </>
  ),
  // A prompt and its cursor.
  run: (
    <>
      <path d="M3.5 4.5L7 8L3.5 11.5" />
      <path d="M9.25 11.5H12.75" className="mg-run-cursor" />
    </>
  ),
  // One node handing work to two; a bead travels down each branch in turn.
  delegate: (
    <>
      <circle cx="3.75" cy="8" r="1.5" />
      <circle cx="12.25" cy="4" r="1.5" />
      <circle cx="12.25" cy="12" r="1.5" />
      <path d="M5.25 8C8 8 8 4 10.75 4M5.25 8C8 8 8 12 10.75 12" className="mg-dim" />
      <path d="M5.25 8C8 8 8 4 10.75 4" pathLength={1} className="mg-bead mg-bead-0" />
      <path d="M5.25 8C8 8 8 12 10.75 12" pathLength={1} className="mg-bead mg-bead-1" />
    </>
  ),
  // A ring of points filling one by one.
  start: (
    <>
      {RING.map((p, k) => (
        <Dot key={k} x={p.x} y={p.y} r={1.05} className={`mg-ring mg-ring-${k}`} />
      ))}
    </>
  ),
  // Two chevrons pressing a line between them.
  compact: (
    <>
      <path d="M5.25 2.75L8 5.25L10.75 2.75" className="mg-compact-top" />
      <path d="M3 8H13" className="mg-compact-mid" />
      <path d="M5.25 13.25L8 10.75L10.75 13.25" className="mg-compact-bot" />
    </>
  ),
  // Three points on a slow orbit.
  other: (
    <g className="mg-other">
      <Dot x={8} y={3.75} r={1.35} />
      <Dot x={11.68} y={10.125} r={1.35} className="mg-o2" />
      <Dot x={4.32} y={10.125} r={1.35} className="mg-o3" />
    </g>
  ),
};

/** The bare SVG of one mood (no cross-fade). */
export function MoodSvg({ mood, size = 14, live = true, className }: { mood: Mood; size?: number; live?: boolean; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("mg", className)}
      data-live={live ? "true" : "false"}
      data-mood={mood}
      aria-hidden
    >
      {GLYPHS[mood]}
    </svg>
  );
}

/** The glyph for a mood in a fixed `size` box; a new mood cross-fades over the old one. */
export function MoodGlyph({ mood, size = 14, live = true, className }: { mood: Mood; size?: 13 | 14 | number; live?: boolean; className?: string }) {
  const fade = reducedMotion() ? 0 : 0.22;
  return (
    <span className={cx("relative inline-block shrink-0", className)} style={{ width: size, height: size }} data-mood-glyph={mood}>
      <AnimatePresence initial={false}>
        <motion.span key={mood} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: fade, ease: "easeInOut" }}>
          <MoodSvg mood={mood} size={size} live={live} className="block" />
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
