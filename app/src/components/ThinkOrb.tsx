// The "model is thinking" mark: a thinking-orbs orb in coool's neutral ink (the library's stock
// monochrome tuning, light ink on dark and dark ink on light). Pass `live={false}` to freeze it.
// The library only ships tunings for 20 and 64; 28 is the 20 tuning scaled up (see ORB28 below).
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { useStore } from "../store";
import { reducedMotion } from "./StepRail";

/** Which shipped tuning the 28px orb is drawn from. Chosen by looking at both in the demo (`?orbs=demo&sz`). */
export const ORB28: 20 | 64 = 20;

export function ThinkOrb({ state, size = 20, live = true, className, from }: { state: OrbState; size?: 20 | 28 | 64; live?: boolean; className?: string; from?: 20 | 64 }) {
  const theme = useStore((s) => s.theme);
  const paused = !live || reducedMotion();
  if (size === 28) {
    const src = from ?? ORB28;
    const k = 28 / src;
    return (
      <span className={className} style={{ display: "block", width: 28, height: 28, flexShrink: 0, position: "relative" }}>
        <span style={{ position: "absolute", left: 0, top: 0, width: src, height: src, transform: `scale(${k})`, transformOrigin: "0 0" }}>
          <ThinkingOrb state={state} size={src} theme={theme} paused={paused} style={{ display: "block" }} />
        </span>
      </span>
    );
  }
  return <ThinkingOrb state={state} size={size} theme={theme} paused={paused} className={className} style={{ display: "block", flexShrink: 0 }} />;
}
