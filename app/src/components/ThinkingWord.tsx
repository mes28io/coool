// The thinking label: a word that changes every 8s (never with reduced motion), the new one sweeping
// in left to right. Words only: never claims a phase.
//
// Which word is shown is a pure function of (seed, time since origin): the render never depends on
// an effect having run, so a re-render, a skipped timer or a seed change can not leave the label
// empty or half-faded. `seed` must be fixed for the whole thinking stretch (a new seed starts a new
// stretch); `origin` is latched per seed. Pass `cycle={false}` when the stretch start is only an
// estimate: the one stable word of that stretch is shown and never changes.
import { useEffect, useRef, useState } from "react";
import { THINKING_WORD_MS, thinkingWordAt } from "../lib/format";
import { cx } from "./primitives";
import { reducedMotion, Reveal } from "./StepRail";

export function ThinkingWord({ seed, origin, cycle = true, className }: { seed: number | string | null | undefined; origin: number | null; cycle?: boolean; className?: string }) {
  const step = THINKING_WORD_MS;
  // Reduced motion: one word per stretch, no cycling.
  const cycling = cycle && !reducedMotion();
  const latched = useRef<{ seed: typeof seed; at: number }>({ seed, at: origin ?? Date.now() });
  if (latched.current.seed !== seed) latched.current = { seed, at: origin ?? Date.now() };
  const base = latched.current.at;
  const at = () => (cycling && Number.isFinite(base) ? Math.max(0, Math.floor((Date.now() - base) / step)) : 0);
  const [n, setN] = useState(at);
  useEffect(() => {
    if (!cycling || !Number.isFinite(base)) return;
    let id: ReturnType<typeof setTimeout>;
    const tick = () => {
      setN(at());
      id = setTimeout(tick, step - ((Date.now() - base) % step) + 5);
    };
    id = setTimeout(tick, step - ((Date.now() - base) % step) + 5);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, base, cycling]);
  const word = thinkingWordAt(seed, cycling ? n : 0) || "Thinking";
  const first = useRef(word);
  return (
    <span className={cx("inline-block whitespace-nowrap", className)}>
      {/* A new word replaces the old one outright (never both on screen), then sweeps in. No opacity animation on a wrapper here:
          the shimmer paints the text through background-clip, and a composited child layer would hide it. */}
      <Reveal key={word} text={word} fresh={word !== first.current} />
    </span>
  );
}

/** The trailing "…": three dots lighting up in turn. Static under reduced motion. Fixed width, so nothing after it moves. */
export function ThinkingDots({ className }: { className?: string }) {
  return (
    <span className={cx("think-dots inline-flex shrink-0 text-dim", className)}>
      <span className="sr-only">…</span>
      <span aria-hidden>.</span>
      <span aria-hidden>.</span>
      <span aria-hidden>.</span>
    </span>
  );
}
