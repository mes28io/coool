// The Agents side panel: one card per subagent / child job of the session on screen.
// Takes plain cards (lib/agentCards.ts); knows nothing about where they came from.

import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";
import { countsText, fmtOut, orderCards, type AgentCardData } from "../lib/agentCards";
import { useNow } from "../lib/clock";
import { fmtClock, fmtElapsed } from "../lib/format";
import { MOODS, toolMood } from "../lib/activityMood";
import { useFold } from "../lib/cardFold";
import { modelLabel } from "../lib/models";
import { useStableOrder } from "../lib/stable";
import { ThinkingDots, ThinkingWord } from "./ThinkingWord";
import { ICheck, IChevron, toolIcon } from "./icons";
import { MoodGlyph } from "./MoodGlyph";
import { cx, ease, ProviderMark, spring, StatusDot } from "./primitives";
import { reducedMotion } from "./StepRail";

/** Finished cards shown before "Show N more". */
const DONE_CAP = 6;
/** Finished steps listed under the bar. */
const RECENT = 3;
/** Segments of the bar: the most recent steps; older ones merge into one leading segment. */
const SEGMENTS = 24;

export function AgentsPanel({
  cards,
  open,
  width,
  dragging,
  onWidth,
  onDragging,
  onOpenCard,
  onStop,
}: {
  cards: AgentCardData[];
  open: boolean;
  width: number;
  dragging: boolean;
  onWidth: (w: number) => void;
  onDragging: (d: boolean) => void;
  onOpenCard: (c: AgentCardData) => void;
  onStop: (c: AgentCardData) => void;
}) {
  const [hover, setHover] = useState(false);
  const [all, setAll] = useState(false);
  const ordered = useStableOrder(orderCards(cards), (c) => c.id, hover);
  const done = ordered.filter((c) => c.state === "done");
  const rest = ordered.filter((c) => c.state !== "done");
  const shownDone = all ? done : done.slice(0, DONE_CAP);
  const more = done.length - shownDone.length;
  const start = useRef<{ x: number; w: number } | null>(null);

  return (
    <motion.aside
      initial={false}
      animate={{ width: open ? width : 0 }}
      transition={dragging || reducedMotion() ? { duration: 0 } : spring}
      className="relative h-full shrink-0 overflow-hidden"
      aria-hidden={!open}
      inert={!open}
      data-agents-panel={open ? "open" : "closed"}
    >
      <div className="absolute inset-y-0 left-0 flex flex-col border-l border-hairline bg-panel" style={{ width }}>
        <div className="flex h-[44px] shrink-0 items-center gap-2 pl-4 pr-2">
          <span className="text-base font-semibold text-fg">Agents</span>
          <span className="min-w-0 flex-1 truncate text-small text-dim tnum" data-agents-count>
            {countsText(cards)}
          </span>
        </div>
        <div className="scroll min-h-0 flex-1 px-3 pb-3" onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
          <AnimatePresence initial={false}>
            {[...rest, ...shownDone].map((c) => (
              <motion.div
                key={c.id}
                layout="position"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: reducedMotion() ? 0 : 0.3, ease, layout: reducedMotion() ? { duration: 0 } : spring }}
                className="overflow-hidden"
              >
                <div className="pb-2">
                  <Card card={c} onOpen={() => onOpenCard(c)} onStop={() => onStop(c)} />
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          {(more > 0 || (all && done.length > DONE_CAP)) && (
            <button type="button" onClick={() => setAll(!all)} className="flex h-[28px] w-full items-center justify-center rounded-[8px] text-small text-dim transition-colors duration-150 hover:bg-hover hover:text-fg">
              {all ? "Show fewer" : `Show ${more} more`}
            </button>
          )}
        </div>
        {/* Drag the left edge to resize. */}
        <div
          className="group absolute inset-y-0 left-0 z-10 w-[6px] cursor-col-resize"
          onPointerDown={(e) => {
            start.current = { x: e.clientX, w: width };
            onDragging(true);
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => start.current && onWidth(start.current.w + start.current.x - e.clientX)}
          onPointerUp={() => {
            start.current = null;
            onDragging(false);
          }}
        >
          <div className="h-full w-[2px] bg-fg opacity-0 transition-opacity duration-150 group-hover:opacity-40" />
        </div>
      </div>
    </motion.aside>
  );
}

function Timer({ since, className }: { since: number | null; className?: string }) {
  const now = useNow();
  if (since === null) return null;
  if (since > now + 5000) return null;
  return <span className={cx("tnum", className)}>{fmtClock(now - since)}</span>;
}

/** The agent's total time at the top right: ticking while it runs (from its first step), final once done. */
function CardTotal({ card }: { card: AgentCardData }) {
  const now = useNow();
  const ms = card.state === "running" || card.state === "needs" ? (card.startedAt !== null && card.startedAt <= now + 5000 ? now - card.startedAt : null) : card.durationMs;
  if (ms === null) return null;
  return (
    <span className="shrink-0 text-small text-faint tnum" title="Total time" data-card-total>
      {fmtClock(ms)}
    </span>
  );
}

function Pill({ card }: { card: AgentCardData }) {
  const s = card.state;
  return (
    <span className="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full border border-line bg-raised pl-[7px] pr-2 text-small font-medium text-fg/85" data-card-status={s}>
      {s === "running" ? (
        <StatusDot status="busy" size={7} />
      ) : s === "needs" ? (
        <StatusDot status="needs" size={7} />
      ) : s === "failed" ? (
        <span className={cx("size-[7px] rounded-full", card.stopped ? "bg-faint" : "bg-err")} />
      ) : (
        <ICheck size={12} className="-ml-[2px] text-dim" />
      )}
      {s === "running" ? "Running" : s === "needs" ? "Needs you" : s === "failed" ? (card.stopped ? "Stopped" : "Failed") : "Done"}
    </span>
  );
}

function Card({ card, onOpen, onStop }: { card: AgentCardData; onOpen: () => void; onStop: () => void }) {
  // Finished (done, failed, stopped): folded to the header and the result line; see lib/cardFold.ts.
  const el = useRef<HTMLDivElement>(null);
  const [open, toggle] = useFold(card.id, card.state === "done" || card.state === "failed", el);
  const collapsed = !open;
  const full = `${card.kind}${card.description ? ` · ${card.description}` : ""}`;

  return (
    <div ref={el} className="overflow-hidden rounded-[14px] border border-hairline bg-bg shadow-card" data-agent-panel-card={card.id} data-state={card.stopped ? "stopped" : card.state} data-open={open}>
      <div role="button" tabIndex={0} onClick={toggle} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())} className="flex cursor-default items-center gap-2 px-3 pb-1 pt-2.5">
        <ProviderMark provider={card.provider} size={16} />
        <div className="min-w-0 flex-1">
          {/* The task is what tells agents apart, so it is the title; the model and kind sit under it. */}
          <div className="truncate text-base font-medium leading-[18px] text-fg" title={card.description || undefined}>
            {card.description || (card.model ? modelLabel(card.model) : "Agent")}
          </div>
          <div className="truncate text-small leading-[16px] text-dim" title={full}>
            {[card.model ? modelLabel(card.model) : null, card.kind].filter(Boolean).join(" · ")}
          </div>
        </div>
        <CardTotal card={card} />
        <Pill card={card} />
        <motion.span animate={{ rotate: collapsed ? 0 : 90 }} transition={{ duration: 0.18, ease }} className="-mr-1 flex size-[20px] shrink-0 items-center justify-center text-faint" title={collapsed ? "Expand" : "Collapse"}>
          <IChevron size={14} />
        </motion.span>
      </div>
      <div className="px-3 pb-2.5 pt-1.5">
        <Strip card={card} />
      </div>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div key="body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: reducedMotion() ? 0 : 0.26, ease }} className="overflow-hidden">
            <div className="px-3 pb-2.5">
              <Bar card={card} />
              <Recent card={card} />
              <div className="mt-1.5 flex h-[24px] items-center gap-2 text-small text-faint">
                <span className="tnum">
                  {card.steps.length} {card.steps.length === 1 ? "step" : "steps"}
                  {card.tokens > 0 && <> · {fmtOut(card.tokens)} tokens</>}
                </span>
                <span className="flex-1" />
                {card.stoppable && (
                  <button type="button" onClick={onStop} className="-my-px h-[24px] rounded-[6px] px-1.5 text-small text-dim transition-colors duration-150 hover:bg-hover hover:text-fg">
                    Stop
                  </button>
                )}
                <button type="button" onClick={onOpen} data-open-card className="-mr-1.5 h-[24px] rounded-[6px] px-1.5 text-small text-dim transition-colors duration-150 hover:bg-hover hover:text-fg">
                  {card.source === "job" ? "Open" : "Open in timeline ↗"}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The "now" strip. */
export function Strip({ card }: { card: AgentCardData; fresh?: { current: boolean } }) {
  const base = "flex h-[34px] items-center gap-2 rounded-[8px] bg-raised px-2.5 text-base";
  if (card.state === "done")
    return (
      <div className={base}>
        <ICheck size={13} className="shrink-0 text-faint" />
        <span className="shrink-0 font-medium text-fg">{card.durationMs !== null ? `Finished in ${fmtElapsed(card.durationMs)}` : "Finished"}</span>
        {card.result && (
          <span className="min-w-0 flex-1 truncate text-small text-dim" title={card.result}>
            {card.result}
          </span>
        )}
      </div>
    );
  if (card.state === "failed" || card.state === "needs")
    return (
      <div className={base}>
        <span className="flex size-[13px] shrink-0 items-center justify-center">
          {card.state === "failed" ? <span className={cx("size-[7px] rounded-full", card.stopped ? "bg-faint" : "bg-err")} /> : <StatusDot status="needs" size={7} />}
        </span>
        {card.stopped && <span className="shrink-0 font-medium text-fg">Stopped</span>}
        <span className={cx("min-w-0 flex-1 truncate", card.stopped ? "text-small text-dim" : "font-medium text-fg")} title={card.error ?? undefined}>
          {card.stopped ? (card.error && card.error !== "Stopped" ? card.error : "") : card.error || (card.state === "failed" ? "Failed" : "Needs you")}
        </span>
        {card.state === "needs" && <Timer since={card.since} className="shrink-0 text-small text-faint" />}
      </div>
    );
  return <NowStrip card={card} className={base} />;
}

/**
 * The strip while the agent runs: the same orb + word as everywhere (from what it is doing), then the step's detail.
 * Seeded by the card and its step count (fixed while one activity lasts), so the once-a-second card rebuild cannot move them.
 */
function NowStrip({ card, className }: { card: AgentCardData; className: string }) {
  const mood = card.labelTool ? toolMood(card.labelTool) : "think";
  const seed = `${card.id}:${card.steps.length}:${mood}`;
  const [mounted] = useState(() => Date.now());
  const detail = card.labelTool ? card.label.replace(new RegExp(`^${card.labelTool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"), "") : "";
  return (
    <div className={className} data-now-strip>
      {/* Subagents get words, not orbs: a small glyph of what it is doing keeps the slot. */}
      <MoodGlyph mood={mood} size={14} className="text-working-text" />
      <span className="flex min-w-0 flex-1 items-baseline">
        <span className="inline-flex shrink-0 font-medium" data-word-mood={mood}>
          <ThinkingWord seed={seed} origin={card.since ?? mounted} words={MOODS[mood].words} cycle={card.since !== null} />
          <ThinkingDots />
        </span>
        {detail && <span className="ml-2 min-w-0 truncate font-mono text-mono-small text-dim" title={card.label}>{detail}</span>}
      </span>
    </div>
  );
}

/** One segment per step (most recent 24; older ones are one dim leading segment). */
function Bar({ card }: { card: AgentCardData }) {
  const n = card.steps.length;
  const cut = Math.max(0, n - SEGMENTS);
  const segs = card.steps.slice(cut).map((s, i) => ({ key: s.key, failed: s.failed, run: cut + i === card.active }));
  return (
    <div className="mb-2 flex h-[3px] gap-[2px]" data-step-bar={n}>
      {n === 0 && <span className="h-full flex-1 rounded-full" style={{ background: "color-mix(in oklab, var(--text) 10%, transparent)" }} />}
      {cut > 0 && <span className="h-full flex-1 rounded-full" style={{ background: "color-mix(in oklab, var(--text) 16%, transparent)" }} />}
      <AnimatePresence initial={false}>
        {segs.map((s) => (
          <motion.span
            key={s.key}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
            className={cx("h-full flex-1 rounded-full", s.failed ? "seg-fail" : s.run && "seg-run")}
            style={s.failed || s.run ? undefined : { background: "color-mix(in oklab, var(--text) 35%, transparent)" }}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

/** The last three finished steps, newest on top; a new one enters from the top and pushes the rest down. */
function Recent({ card }: { card: AgentCardData }) {
  const finished = card.steps.filter((_, i) => i !== card.active);
  const rows = finished.slice(-RECENT).reverse();
  return (
    <div>
      <AnimatePresence initial={false}>
        {rows.map((s) => {
          const Icon = toolIcon(s.name);
          return (
            <motion.div
              key={s.key}
              initial={{ height: 0, opacity: 0, y: -6 }}
              animate={{ height: "auto", opacity: 1, y: 0 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: reducedMotion() ? 0 : 0.3, ease }}
              className="overflow-hidden"
            >
              <div className="flex h-[26px] items-center gap-2 text-small">
                <Icon size={12} className={cx("shrink-0", s.failed ? "text-err-text" : "text-faint")} />
                <span className={cx("min-w-0 flex-1 truncate", s.failed ? "text-err-text/90" : "text-fg/80")} title={s.label}>
                  {s.label}
                </span>
                {s.failed ? <span className="shrink-0 text-err-text">Failed</span> : s.ms !== null && <span className="shrink-0 text-faint tnum">{fmtElapsed(s.ms)}</span>}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
