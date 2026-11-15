// Header button for a session's subagents: the `delegate` glyph (animated green while any run, static dim when none) plus a label ("2 running" / "5 agents · 1 failed").
// Toggles the Agents panel. Green and animated while any run, dim and still when all are done.

import { motion } from "motion/react";
import { isLive, type AgentCardData } from "../lib/agentCards";
import { MoodGlyph } from "./MoodGlyph";
import { cx } from "./primitives";

export function AgentsButton({ cards, open, onToggle, compact }: { cards: AgentCardData[]; open: boolean; onToggle: () => void; compact?: boolean }) {
  const live = cards.filter(isLive).length;
  const failed = cards.filter((c) => !isLive(c) && c.state === "failed" && !c.stopped).length;
  const n = cards.length;
  const full = live ? `${live} running` : `${n} ${n === 1 ? "agent" : "agents"}`;
  const title = `${open ? "Hide agents" : "Show agents"} (${full}${failed ? `, ${failed} failed` : ""})`;
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
      <MoodGlyph mood="delegate" size={15} live={live > 0} className={cx("transition-colors duration-300", live > 0 ? "text-working-text" : "text-dim")} />
      <motion.span key={live ? "live" : "idle"} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} className={live ? "font-medium text-working-text" : "text-dim"}>
        {compact ? (live || n) : full}
        {!compact && !live && failed > 0 && <span className="text-err-text"> · {failed} failed</span>}
      </motion.span>
    </button>
  );
}
