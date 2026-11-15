// Shared timeline-rail pieces: the continuous neutral rail with a dot per row, the
// left-to-right label reveal, and rows that grow by height instead of popping.
// Used by the step lists in Chat and Activity.

import { motion } from "motion/react";
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cx, ease } from "./primitives";

export const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Rail x (px) and the gutter before the row's icon: dot and icon sit close, in one column. */
const RAIL_X = 6;
const GUTTER = 18;

/** Rail colour: neutral, a touch stronger than a hairline. */
export const RAIL = "color-mix(in oklab, var(--border) 45%, var(--faint))";
/** Past dots: neutral and light. */
export const DOT = "color-mix(in oklab, var(--faint) 60%, var(--border))";

/**
 * Text that arrives with a soft left-to-right sweep (~420ms). The text is ONE text node for its whole life
 * (never per-character spans, which change kerning and advances), and the sweep is a mask on its wrapper, so
 * glyph positions are identical before, during and after. `inner` is for text that carries its own
 * `background-clip: text` treatment (the shimmer): it must sit inside the masked wrapper, not outside it.
 */
export function Reveal({ text, fresh, inner }: { text: string; fresh?: boolean; inner?: { className?: string; style?: CSSProperties } }) {
  const [on, setOn] = useState(() => !!fresh && text.length > 0 && !reducedMotion());
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => setOn(false), 520);
    return () => clearTimeout(t);
  }, [on]);
  return <span className={on ? "rv-sweep" : undefined}>{inner ? <span className={inner.className} style={inner.style}>{text}</span> : text}</span>;
}

const Ready = createContext<{ current: boolean }>({ current: true });

/** The list; rows that mount after its first commit animate (height, rail drawing). */
export function RailList({ className, children }: { className?: string; children: ReactNode }) {
  const ready = useRef(false);
  useEffect(() => {
    ready.current = true;
  }, []);
  return (
    <Ready.Provider value={ready}>
      <ol className={className}>{children}</ol>
    </Ready.Provider>
  );
}

/**
 * One row of a rail list: a 20px gutter holding the rail segments and the dot, then
 * the row. Segments draw downward when a row arrives; the row grows by height.
 */
export function RailItem({ first, last, fresh, active, dotY = 14, children }: { first: boolean; last: boolean; fresh: boolean; active?: boolean; dotY?: number; children: ReactNode }) {
  const ready = useContext(Ready);
  const instant = reducedMotion();
  const [clip, setClip] = useState(fresh && !instant);
  const lowerBorn = ready.current && !instant;
  return (
    <motion.li
      initial={fresh && !instant ? { height: 0, opacity: 0 } : false}
      animate={{ height: "auto", opacity: 1 }}
      transition={{ duration: instant ? 0 : 0.28, ease }}
      onAnimationComplete={() => setClip(false)}
      className={cx("relative", clip && "overflow-hidden")} style={{ paddingLeft: GUTTER }}
    >
      {!first && <Seg style={{ top: 0, height: dotY }} grow={fresh && !instant} delay={0.16} />}
      {!last && <Seg style={{ top: dotY, bottom: 0 }} grow={lowerBorn} delay={0} />}
      {/* One mark per step, on the rail: a dot, or the spinner while the step runs. */}
      <span aria-hidden className="absolute flex size-[14px] -translate-x-1/2 -translate-y-1/2 items-center justify-center" style={{ left: RAIL_X + 0.5, top: dotY }}>
        {active ? (
          <svg width="12" height="12" viewBox="0 0 16 16" className="spin text-working-text">
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.2" />
            <path d="M8 2a6 6 0 016 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        ) : (
          <span className="size-[5px] rounded-full" style={{ background: DOT }} />
        )}
      </span>
      {children}
    </motion.li>
  );
}

function Seg({ style, grow, delay }: { style: React.CSSProperties; grow: boolean; delay: number }) {
  return (
    <motion.span
      aria-hidden
      className="absolute w-px"
      style={{ left: RAIL_X, background: RAIL, transformOrigin: "top", ...style }}
      initial={grow ? { scaleY: 0 } : false}
      animate={{ scaleY: 1 }}
      transition={{ duration: 0.18, ease: "linear", delay }}
    />
  );
}
