// Header button for a session's jobs (subagents and background shells): the `delegate` glyph (animated green while
// anything runs (blue, at the owner's request), static dim when nothing does) plus a short label: the number of running jobs (agents + shells,
// "3 running"), or a dim "Jobs" when nothing runs (counts live in the tooltip). Toggles the Jobs panel.

import { motion } from "motion/react";
import { isLive, type AgentCardData } from "../lib/agentCards";
import { MoodGlyph } from "./MoodGlyph";
import { cx } from "./primitives";

export function AgentsButton({ cards, shells = 0, open, onToggle, compact }: { cards: AgentCardData[]; shells?: number; open: boolean; onToggle: () => void; compact?: boolean }) {
  const agentsLive = cards.filter(isLive).length;
  const live = agentsLive + shells;
  const failed = cards.filter((c) => !isLive(c) && c.state === "failed" && !c.stopped).length;
  const n = cards.length;
  const label = live ? `${live} running` : "Jobs";
  // The tooltip keeps the breakdown the label leaves out.
  const detail = [agentsLive && `${agentsLive} ${agentsLive === 1 ? "agent" : "agents"} running`, shells && `${shells} ${shells === 1 ? "shell" : "shells"}`, !live && `${n} ${n === 1 ? "agent" : "agents"}`, failed && `${failed} failed`].filter(Boolean).join(", ");
  const title = `${open ? "Hide jobs" : "Show jobs"} (${detail})`;
  return (
    <button
      type="button"
      data-agents-button
      onClick={onToggle}
      title={title}
      aria-label={title}
      aria-pressed={open}
      className={cx(
        "flex h-[28px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[8px] px-2.5 text-small tabular-nums transition-colors duration-150",
        open ? "bg-hover" : "hover:bg-hover",
      )}
    >
      <MoodGlyph mood="delegate" size={15} live={live > 0} className={cx("transition-colors duration-300", live > 0 ? "text-needs-text" : "text-dim")} />
      <motion.span key={live ? "live" : "idle"} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} className={live ? "font-medium text-needs-text" : "text-dim"} data-agents-label>
        {compact ? live || null : label}
      </motion.span>
    </button>
  );
}
