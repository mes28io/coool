// Where the turn went (CHAT_SPEC "Where the turn went"): a 4 px bar under "Worked for …", one segment per
// kind of step, a small popover per segment, and on click a waterfall of every call on the turn's axis.
// The maths is lib/turnBreakdown.ts; this file only draws it.

import { AnimatePresence, motion } from "motion/react";
import { memo, useMemo, useRef, useState } from "react";
import type { Chat, ChatItem } from "../lib/chat";
import { fmtElapsed } from "../lib/format";
import { breakdown, KIND_LABEL, segmentText, turnItems, type Breakdown, type TurnKind, type WaterRow } from "../lib/turnBreakdown";
import { useNow } from "../lib/clock";
import { IChevron, toolIcon } from "./icons";
import { cx, ease } from "./primitives";
import { reducedMotion } from "./StepRail";
import { countRender } from "../lib/perfCount";

const mix = (v: string, n: number) => `color-mix(in oklab, var(${v}) ${n}%, transparent)`;
/** Neutral tints; only waiting for the person has a status colour. */
export const KIND_COLOR: Record<TurnKind, string> = {
  thinking: mix("--text", 20),
  reading: mix("--text", 34),
  editing: mix("--text", 64),
  commands: mix("--text", 80),
  web: mix("--text", 48),
  agents: mix("--status-running", 45),
  other: mix("--text", 27),
  waiting: mix("--status-needs", 60),
  writing: mix("--text", 11),
};

const fmt = (ms: number) => (ms < 1000 ? `${Math.max(0, Math.round(ms / 100) / 10)}s` : fmtElapsed(ms));

/** Worth drawing: some step, thought or wait took part of it. */
const meaningful = (b: Breakdown) => b.total >= 1000 && b.segments.some((s) => s.kind !== "writing");

/** A finished turn's breakdown (null when there's nothing to show). */
export function useTurnBreakdown(chat: Chat, item: Extract<ChatItem, { kind: "turn" }>): Breakdown | null {
  return useMemo(() => {
    if (!(item.durationMs > 0)) return null;
    const idx = chat.items.indexOf(item);
    if (idx < 0) return null;
    const b = breakdown(turnItems(chat.items, idx), item.ts - item.durationMs, item.ts);
    return meaningful(b) ? b : null;
  }, [chat.items, item]);
}

/** The bar alone, growing while the turn runs (under the live row). */
export function LiveTurnBar({ chat }: { chat: Chat }) {
  countRender("LiveTurnBar");
  const now = useNow();
  const start = chat.turnStart;
  // Recomputed once a second at most (the clock's tick), and with every new item.
  const fresh = useMemo(() => (start === null ? null : breakdown(turnItems(chat.items, -1), start, Math.max(start, now), true)), [chat.items, start, now]);
  // The same object while its segments are (a streamed token changes none): the bar, whose segments measure their
  // layout on every render, renders again only when they change.
  const held = useRef<Breakdown | null>(null);
  const b = fresh && held.current && sameBars(held.current, fresh) ? held.current : fresh;
  held.current = b;
  if (!b || !meaningful(b)) return null;
  return <MemoBar b={b} className="mt-1.5" />;
}

const sameBars = (a: Breakdown, b: Breakdown) => a.running === b.running && a.total === b.total && a.segments.length === b.segments.length && a.segments.every((s, i) => s.kind === b.segments[i].kind && s.ms === b.segments[i].ms);

export function TurnBar({ b, className }: { b: Breakdown; className?: string }) {
  const [hover, setHover] = useState<{ kind: TurnKind; x: number } | null>(null);
  const seg = hover ? b.segments.find((s) => s.kind === hover.kind) : null;
  let at = 0;
  return (
    <div className={cx("relative", className)} onPointerLeave={() => setHover(null)} data-turn-bar={b.segments.map((s) => s.kind).join(",")}>
      <div className="flex h-[4px] w-full gap-px overflow-hidden rounded-full">
        {b.segments.map((s, i) => {
          const left = at;
          at += s.ms;
          const live = b.running && i === b.segments.length - 1;
          return (
            <motion.span
              key={s.kind}
              layout={!reducedMotion()}
              className={cx("h-full min-w-[3px] first:rounded-l-full last:rounded-r-full", live && !reducedMotion() && "breathe")}
              style={{ flexGrow: s.ms, flexBasis: 0, background: KIND_COLOR[s.kind] }}
              onPointerEnter={() => setHover({ kind: s.kind, x: (left + s.ms / 2) / Math.max(1, b.total) })}
              data-seg={s.kind}
              transition={{ duration: 0.3, ease }}
            />
          );
        })}
      </div>
      {/* A taller invisible hit area, so the 4 px bar is easy to hover. */}
      <div className="absolute inset-x-0 -top-1.5 h-[16px]" onPointerMove={(e) => pick(e, b, setHover)} />
      <AnimatePresence>
        {seg && hover && (
          <motion.div
            key="pop"
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={{ duration: 0.14, ease }}
            className="pointer-events-none absolute top-full z-30 mt-2 whitespace-nowrap max-w-[min(360px,90%)] rounded-[8px] border border-line bg-raised px-2.5 py-1.5 text-small text-fg shadow-pop"
            style={{ left: `${Math.min(100, Math.max(0, hover.x * 100))}%`, transform: "translateX(-50%)" }}
            role="tooltip"
            data-seg-pop={seg.kind}
          >
            <span className="flex items-center gap-1.5">
              <span className="size-[7px] shrink-0 rounded-full" style={{ background: KIND_COLOR[seg.kind] }} />
              <span className="truncate tnum">{segmentText(seg, fmt)}</span>
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const MemoBar = memo(TurnBar);

function pick(e: React.PointerEvent<HTMLDivElement>, b: Breakdown, set: (h: { kind: TurnKind; x: number } | null) => void) {
  const r = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - r.left) / Math.max(1, r.width);
  let at = 0;
  for (const s of b.segments) {
    const w = s.ms / Math.max(1, b.total);
    if (x <= at + w || s === b.segments[b.segments.length - 1]) return set({ kind: s.kind, x: at + w / 2 });
    at += w;
  }
}

/** The per-call timeline: one row per call on a shared 0 -> turn-length axis; subagents fold their calls. */
export function Waterfall({ b }: { b: Breakdown }) {
  const [openAgents, setOpenAgents] = useState<Set<string>>(() => new Set());
  const toggle = (k: string) =>
    setOpenAgents((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  return (
    <div className="mt-2 overflow-hidden rounded-[10px] border border-hairline bg-raised" data-waterfall={b.rows.length}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline px-3 py-2 text-small text-dim">
        {b.segments.map((s) => (
          <span key={s.kind} className="flex items-center gap-1.5 tnum" title={segmentText(s, fmt)}>
            <span className="size-[7px] rounded-full" style={{ background: KIND_COLOR[s.kind] }} />
            {KIND_LABEL[s.kind]}
            <span className="text-faint">{fmt(s.ms)}</span>
          </span>
        ))}
      </div>
      <div className="scroll max-h-[340px] py-1">
        {b.rows.length === 0 && <div className="px-3 py-2 text-small text-faint">No tool calls in this turn.</div>}
        {b.rows.map((r) => (
          <div key={r.key}>
            <Row r={r} total={b.total} slowest={b.slowest} open={openAgents.has(r.key)} onToggle={r.children.length ? () => toggle(r.key) : undefined} />
            <AnimatePresence initial={false}>
              {openAgents.has(r.key) && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: reducedMotion() ? 0 : 0.2, ease }} className="overflow-hidden">
                  {r.children.map((k) => (
                    <Row key={k.key} r={k} total={b.total} slowest={b.slowest} nested />
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>
    </div>
  );
}

function Row({ r, total, slowest, nested, open, onToggle }: { r: WaterRow; total: number; slowest: string | null; nested?: boolean; open?: boolean; onToggle?: () => void }) {
  const Icon = toolIcon(r.name);
  const left = (r.from / Math.max(1, total)) * 100;
  const width = Math.max(0.6, ((r.to - r.from) / Math.max(1, total)) * 100);
  const isSlow = slowest === r.key;
  return (
    <div
      role={onToggle ? "button" : undefined}
      tabIndex={onToggle ? 0 : undefined}
      onClick={onToggle}
      onKeyDown={onToggle ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onToggle()) : undefined}
      className={cx("grid h-[26px] grid-cols-[minmax(0,1fr)_minmax(64px,38%)_auto] items-center gap-2.5 pl-3 pr-3 text-small", onToggle && "cursor-default hover:bg-hover")}
      data-wf-row={r.kind}
      data-slowest={isSlow || undefined}
    >
      <span className={cx("flex min-w-0 items-center gap-2", nested && "pl-5")}>
        {onToggle ? (
          <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.16, ease }} className="flex size-[12px] shrink-0 items-center justify-center text-faint">
            <IChevron size={11} />
          </motion.span>
        ) : (
          <Icon size={12} className={cx("shrink-0", r.failed ? "text-err-text" : "text-faint")} />
        )}
        <span className={cx("min-w-0 truncate", r.failed ? "text-err-text/90" : "text-fg/85")} title={`${r.label} · ${r.name}`}>
          {r.label}
          {onToggle && <span className="text-faint"> · {r.children.length} {r.children.length === 1 ? "call" : "calls"}</span>}
        </span>
        {isSlow && <span className="shrink-0 text-micro font-medium text-needs-text">slowest</span>}
      </span>
      <span className="relative h-[6px] rounded-full" style={{ background: mix("--text", 6) }}>
        <span className={cx("absolute inset-y-0 rounded-full", r.running && !reducedMotion() && "breathe")} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%`, background: KIND_COLOR[r.kind] }} />
      </span>
      <span className="w-[44px] text-right text-faint tnum">{fmt(r.ms)}</span>
    </div>
  );
}
