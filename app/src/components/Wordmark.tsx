import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cx } from "./primitives";

const RED = "#FF5F57";
const YELLOW = "#FEBC2E";
const GREEN = "#28C840";

/**
 * The name "coool" in Pally. It reads "cool", then a third "o" (the yellow one) pops in with a
 * bounce. `intro` plays that once after first paint; hovering replays it (once per hover, never
 * while playing). The final width is reserved from the start so nothing shifts.
 */
export function Wordmark({ size = 20, intro = false, className }: { size?: number; intro?: boolean; className?: string }) {
  const reduced = useReducedMotion();
  const [full, setFull] = useState(reduced || !intro);
  const playing = useRef(false);
  const squash = useAnimationControls();
  const timers = useRef<number[]>([]);
  const later = (fn: () => void, ms: number) => void timers.current.push(window.setTimeout(fn, ms));

  const pop = (delay: number) => {
    playing.current = true;
    later(() => setFull(true), delay);
    later(() => void squash.start({ scaleY: [1, 0.94, 1], transition: { duration: 0.24, ease: "easeOut" } }), delay + 260);
    later(() => (playing.current = false), delay + 700);
  };

  useEffect(() => {
    if (!intro || reduced) return;
    const t = window.setTimeout(() => pop(450), 0);
    timers.current.push(t);
    return () => timers.current.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const replay = () => {
    if (reduced || playing.current) return;
    playing.current = true;
    setFull(false);
    later(() => {
      playing.current = false;
      pop(0);
    }, 140);
  };

  const letter = "inline-block leading-none";
  return (
    <span
      aria-label="coool"
      role="img"
      onPointerEnter={replay}
      className={cx("relative inline-block select-none font-bold tracking-[-0.01em] text-fg", className)}
      style={{ fontSize: size, lineHeight: 1.1 }}
    >
      <span aria-hidden className="invisible whitespace-pre">coool</span>
      <motion.span aria-hidden animate={squash} style={{ transformOrigin: "50% 85%" }} className="absolute inset-0 flex items-baseline whitespace-pre">
        <motion.span layout="position" className={letter}>c</motion.span>
        <motion.span layout="position" className={letter} style={{ color: RED }}>o</motion.span>
        <AnimatePresence initial={false}>
          {full && (
            <motion.span
              key="pop"
              layout="position"
              className={letter}
              style={{ color: YELLOW }}
              initial={reduced ? false : { scale: 0, y: 0 }}
              animate={{ scale: 1, y: 0, transition: { scale: { type: "spring", stiffness: 500, damping: 14 }, y: { duration: 0.34, times: [0, 0.4, 1], ease: "easeOut" } } }}
              exit={{ scale: 0, opacity: 0, transition: { duration: 0.1 } }}
            >
              o
            </motion.span>
          )}
        </AnimatePresence>
        <motion.span layout="position" className={letter} style={{ color: GREEN }}>o</motion.span>
        <motion.span layout="position" className={letter}>l</motion.span>
      </motion.span>
    </span>
  );
}
