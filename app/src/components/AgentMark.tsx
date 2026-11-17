import { MoodGlyph } from "./MoodGlyph";
import { cx } from "./primitives";

// The mark for a subagent (cards in the chat, Agent/Task step rows): the branching "delegate" glyph, the same one
// the header's Agents button uses. Animated in working green while the agent runs; still afterwards, coloured by
// how it ended. `plain` takes its colour from the parent (step rows).

export type AgentMarkState = "live" | "done" | "failed" | "stopped" | "plain";

const TONE: Record<AgentMarkState, string> = { live: "text-running", done: "text-dim", failed: "text-err-text", stopped: "text-faint", plain: "" };

export function AgentMark({ size = 14, state = "plain", className }: { size?: number; state?: AgentMarkState; className?: string }) {
  return (
    <span className={cx("inline-flex shrink-0 transition-colors duration-300", TONE[state], className)} data-agent-mark={state}>
      <MoodGlyph mood="delegate" size={size} live={state === "live"} />
    </span>
  );
}
