// The "model is thinking" mark: a thinking-orbs orb in coool's neutral ink (the library's stock
// monochrome tuning, light ink on dark and dark ink on light). Pass `live={false}` to freeze it.
import { ThinkingOrb } from "thinking-orbs";
import { useStore } from "../store";
import type { ThinkOrbState } from "../lib/format";
import { reducedMotion } from "./StepRail";

export function ThinkOrb({ state, size = 20, live = true, className }: { state: ThinkOrbState; size?: 20 | 64; live?: boolean; className?: string }) {
  const theme = useStore((s) => s.theme);
  return <ThinkingOrb state={state} size={size} theme={theme} paused={!live || reducedMotion()} className={className} style={{ display: "block", flexShrink: 0 }} />;
}
