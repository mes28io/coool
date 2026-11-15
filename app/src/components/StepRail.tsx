// Shared timeline-rail pieces: the continuous neutral rail with a dot per row, the
// left-to-right label reveal, and rows that grow by height instead of popping.
// Used by the step lists in Chat and Activity.

import { motion } from "motion/react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { cx, ease } from "./primitives";

export const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Rail colour: neutral, a touch stronger than a hairline. */
export const RAIL = "color-mix(in oklab, var(--border) 45%, var(--faint))";
/** Past dots: neutral and light. */
export const DOT = "color-mix(in oklab, var(--faint) 60%, var(--border))";

/** Text whose characters fade in from faint to full in a soft left-to-right sweep (~400ms). */
export function Reveal({ text, fresh }: { text: string; fresh?: boolean }) {
  const [on, setOn] = useState(() => !!fresh && text.length > 0 && !reducedMotion());
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => setOn(false), 640);
    return () => clearTimeout(t);
  }, [on]);
  if (!on) return <>{text}</>;
  const chars = [...text];
  return (
    <span aria-label={text}>
      {chars.map((c, i) => (
        <span key={i} aria-hidden className="cp-ch" style={{ animationDelay: `${Math.round((i / chars.length) * 200)}ms` }}>
          {c}
        </span>
      ))}
    </span>
  );
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
      className={cx("relative pl-[20px]", clip && "overflow-hidden")}
    >
      {!first && <Seg style={{ top: 0, height: dotY }} grow={fresh && !instant} delay={0.16} />}
      {!last && <Seg style={{ top: dotY, bottom: 0 }} grow={lowerBorn} delay={0} />}
      <span
        aria-hidden
        className={cx("absolute -translate-x-1/2 -translate-y-1/2 rounded-full transition-[width,height,background-color] duration-300", active ? "size-[7px] bg-working" : "size-[5px]")}
        style={{ left: 6.5, top: dotY, ...(active ? null : { background: DOT }) }}
      />
      {children}
    </motion.li>
  );
}

function Seg({ style, grow, delay }: { style: React.CSSProperties; grow: boolean; delay: number }) {
  return (
    <motion.span
      aria-hidden
      className="absolute w-px"
      style={{ left: 6, background: RAIL, transformOrigin: "top", ...style }}
      initial={grow ? { scaleY: 0 } : false}
      animate={{ scaleY: 1 }}
      transition={{ duration: 0.18, ease: "linear", delay }}
    />
  );
}
