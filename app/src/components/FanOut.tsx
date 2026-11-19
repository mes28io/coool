// Mission control's fan-out: a session's parallel work (subagents of its latest turn, child jobs,
// background shells) as one cell each, coloured by state, with done / total, tokens and elapsed
// time. Few workers: a short row of labelled chips; many: a grid. Hover shows what a cell is.

import { motion } from "motion/react";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentCardData } from "../lib/agentCards";
import { fmtTokens, shellTitle } from "../lib/format";
import { cellCounts, cellState, type CellState } from "../lib/mission";
import { useMotion } from "../lib/motion";
import { modelLabel } from "../lib/models";
import type { Shell } from "../lib/types";
import { IFanout } from "./icons";
import { cx, LiveClock, Ticker } from "./primitives";

/** Fill and edge per state, from the status tokens (stopped is neutral, like the Jobs panel). */
const TONE: Record<CellState, { fill: string; edge: string }> = {
  running: { fill: "color-mix(in oklab, var(--status-running) 22%, transparent)", edge: "color-mix(in oklab, var(--status-running) 60%, transparent)" },
  needs: { fill: "color-mix(in oklab, var(--status-needs) 45%, transparent)", edge: "var(--status-needs)" },
  failed: { fill: "color-mix(in oklab, var(--error) 30%, transparent)", edge: "color-mix(in oklab, var(--error) 70%, transparent)" },
  stopped: { fill: "color-mix(in oklab, var(--faint) 18%, transparent)", edge: "color-mix(in oklab, var(--faint) 45%, transparent)" },
  done: { fill: "color-mix(in oklab, var(--status-done) 28%, transparent)", edge: "color-mix(in oklab, var(--status-done) 55%, transparent)" },
};
const WORD: Record<CellState, string> = { running: "running", needs: "need you", failed: "failed", stopped: "stopped", done: "done" };
const ORDER: CellState[] = ["done", "running", "needs", "failed", "stopped"];

/** Up to this many workers show as labelled chips instead of a grid. */
const ROW_MAX = 5;

interface Cell {
  id: string;
  state: CellState;
  title: string;
  sub: string;
  step: string;
  tokens: number;
  since: number | null;
  card?: AgentCardData;
}

export function FanOut({ cards, shells, onOpen }: { cards: AgentCardData[]; shells: Shell[]; onOpen: (c: AgentCardData) => void }) {
  const cells: Cell[] = [
    ...cards.map((c) => ({
      id: c.id,
      state: cellState(c),
      title: c.description || c.kind,
      sub: [c.source === "job" ? "Job" : c.kind, c.model ? modelLabel(c.model) : null].filter(Boolean).join(" · "),
      step: c.state === "running" || c.state === "needs" ? (c.error ?? c.label) : (c.error ?? c.result ?? ""),
      tokens: c.tokens,
      since: c.startedAt,
      card: c,
    })),
    ...shells.map((s) => ({ id: `sh${s.pid}`, state: "running" as const, title: s.description || shellTitle(s.command), sub: "Background shell", step: s.tail?.[s.tail.length - 1] ?? s.command, tokens: 0, since: s.started })),
  ];
  const counts = cellCounts(cells.map((c) => c.state));
  const finished = counts.done + counts.failed + counts.stopped;
  const tokens = cards.reduce((n, c) => n + c.tokens, 0);
  const start = cells.reduce<number | null>((m, c) => (c.since !== null && (m === null || c.since < m) ? c.since : m), null);
  const live = counts.running + counts.needs > 0;
  const [hover, setHover] = useState<{ cell: Cell; el: HTMLElement } | null>(null);
  const row = cells.length <= ROW_MAX;

  return (
    <div className="rounded-[10px] border border-hairline bg-panel px-3 pb-2.5 pt-2" data-mc-fanout={cells.length} onPointerLeave={() => setHover(null)}>
      <div className="flex h-[22px] items-center gap-2 text-small">
        <IFanout size={13} className="shrink-0 text-dim" />
        <span className="font-medium text-fg">Fan-out</span>
        <span className="min-w-0 truncate text-faint">{cells.length} workers</span>
        <span className="ml-auto flex shrink-0 items-baseline gap-3 tnum">
          <span className="text-dim">
            <Ticker value={finished} format={(n) => String(Math.round(n))} className="text-fg" />
            <span className="text-faint"> / {cells.length}</span>
          </span>
          {tokens > 0 && (
            <span className="text-faint">
              <Ticker value={tokens} className="text-dim" /> tokens
            </span>
          )}
          {live && start !== null && <LiveClock since={start} className="text-faint" />}
        </span>
      </div>

      {row ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {cells.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => c.card && onOpen(c.card)}
              onPointerEnter={(e) => setHover({ cell: c, el: e.currentTarget })}
              className="flex h-[26px] min-w-0 max-w-[220px] items-center gap-1.5 rounded-[7px] border border-hairline bg-bg pl-1.5 pr-2 text-small text-dim transition-colors hover:text-fg"
            >
              <Square state={c.state} size={10} />
              <span className="truncate">{c.title}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-2 grid gap-[4px]" style={{ gridTemplateColumns: "repeat(auto-fill, 14px)" }}>
          {cells.map((c) => (
            <button key={c.id} type="button" aria-label={`${c.title}: ${WORD[c.state]}`} onClick={() => c.card && onOpen(c.card)} onPointerEnter={(e) => setHover({ cell: c, el: e.currentTarget })} className="size-[14px] rounded-[4px] outline-offset-1">
              <Square state={c.state} size={14} />
            </button>
          ))}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-faint tnum">
        {ORDER.filter((s) => counts[s] > 0).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <Square state={s} size={8} still />
            <span className="text-dim">{counts[s]}</span>
            {WORD[s]}
          </span>
        ))}
      </div>
      {hover && <HoverCard cell={hover.cell} anchor={hover.el} />}
    </div>
  );
}

/** One cell. It pops once when its state changes; a running one breathes (still under Reduce motion). */
const Square = memo(function Square({ state, size, still }: { state: CellState; size: number; still?: boolean }) {
  const reduce = useMotion().reduce;
  const pop = !still && !reduce;
  const t = TONE[state];
  return (
    <motion.span
      key={pop ? state : "s"}
      initial={pop ? { scale: 0.6 } : false}
      animate={{ scale: 1 }}
      transition={{ type: "spring", stiffness: 520, damping: 22 }}
      className={cx("block shrink-0 rounded-[4px] transition-[background-color,box-shadow] duration-300", state === "running" && !still && "breathe")}
      style={{ width: size, height: size, background: t.fill, boxShadow: `inset 0 0 0 1px ${t.edge}`, borderRadius: size <= 8 ? 2.5 : 4 }}
    />
  );
});

function HoverCard({ cell, anchor }: { cell: Cell; anchor: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = ref.current?.offsetWidth ?? 260;
    const h = ref.current?.offsetHeight ?? 90;
    const x = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    const below = r.bottom + 8 + h < window.innerHeight;
    setPos({ x, y: below ? r.bottom + 8 : r.top - h - 8 });
  }, [anchor, cell]);
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-50 w-[260px] rounded-[10px] border border-line bg-raised px-3 py-2 shadow-pop"
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}
      data-mc-cell-card
    >
      <div className="flex items-center gap-2">
        <Square state={cell.state} size={9} still />
        <span className="min-w-0 flex-1 truncate text-base font-medium text-fg">{cell.title}</span>
      </div>
      <div className="mt-0.5 flex gap-2 text-small text-faint">
        <span className="min-w-0 truncate">{cell.sub}</span>
        <span className="ml-auto shrink-0 tnum">
          {WORD[cell.state]}
          {cell.tokens > 0 && ` · ${fmtTokens(cell.tokens)} tokens`}
        </span>
      </div>
      {cell.step && <div className="mt-1 line-clamp-2 font-mono text-mono-small text-dim">{cell.step}</div>}
    </div>,
    document.body,
  );
}
