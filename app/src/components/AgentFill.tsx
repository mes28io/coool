// A sub-agent's context fill and its handoff (CHAT_SPEC "Sub-agent cards"): a 2 px bar with "32k / 1M", and
// one dim line with the first line of what the lead handed it. Shared by the Jobs panel and the chat's cards.

import { motion } from "motion/react";
import { fmtK, type Fill } from "../lib/agentFill";
import { cx, softSpring, Ticker } from "./primitives";
import { reducedMotion } from "./StepRail";

export function FillBar({ fill, running, className }: { fill: Fill; running: boolean; className?: string }) {
  const color = fill.high ? "var(--status-needs-text)" : running ? "var(--status-running)" : "color-mix(in oklab, var(--text) 32%, transparent)";
  const pct = Math.round(fill.share * 100);
  const title = `Context ${fill.used.toLocaleString()} of ${fill.window.toLocaleString()} tokens (${pct}%)${fill.estimate ? ". The window is the model family's, not one the CLI reported" : ""}`;
  return (
    <div className={cx("flex items-center gap-2", className)} title={title} data-agent-fill={pct} data-fill-high={fill.high || undefined}>
      <span className="relative h-[2px] min-w-0 flex-1 overflow-hidden rounded-full" style={{ background: "color-mix(in oklab, var(--text) 9%, transparent)" }}>
        <motion.span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ background: color }}
          initial={false}
          animate={{ width: `${Math.max(1.5, fill.share * 100)}%` }}
          transition={reducedMotion() ? { duration: 0 } : softSpring}
        />
      </span>
      <span className={cx("shrink-0 text-small tnum", fill.high ? "text-needs-text" : "text-faint")}>
        <Ticker value={fill.used} format={fmtK} />
        {` / ${fill.estimate ? "~" : ""}${fmtK(fill.window)}`}
      </span>
    </div>
  );
}

export function Handoff({ text, full, className }: { text: string; full?: string | null; className?: string }) {
  return (
    <div className={cx("flex min-w-0 items-baseline gap-1 text-small text-faint", className)} title={full ?? text} data-agent-handoff>
      <span className="shrink-0">↳ from lead:</span>
      <span className="min-w-0 truncate text-dim">{text}</span>
    </div>
  );
}
