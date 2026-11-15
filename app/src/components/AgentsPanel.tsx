// The Agents side panel: one card per subagent / child job of the session on screen.
// Takes plain cards (lib/agentCards.ts); knows nothing about where they came from.

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { countsText, isLive, orderCards, type AgentCardData } from "../lib/agentCards";
import { useNow } from "../lib/clock";
import { fmtClock, fmtElapsed } from "../lib/format";
import { MOODS, toolMood } from "../lib/activityMood";
import { useFold } from "../lib/cardFold";
import { modelLabel } from "../lib/models";
import { useStableOrder } from "../lib/stable";
import { ThinkingDots, ThinkingWord } from "./ThinkingWord";
import { ICheck, IChevron, toolIcon } from "./icons";
import { MoodGlyph } from "./MoodGlyph";
import { cx, ease, spring, StatusDot } from "./primitives";
import { reducedMotion } from "./StepRail";
import type { Shell } from "../lib/types";
import { useStore } from "../store";

/** Finished cards shown before "Show N more". */
const DONE_CAP = 6;
/** Finished steps listed under the bar. */
const RECENT = 3;
/** Segments of the bar: the most recent steps; older ones merge into one leading segment. */
const SEGMENTS = 24;

export function AgentsBody({
  cards,
  shells = [],
  onOpenCard,
  onStop,
  onStopShell,
}: {
  cards: AgentCardData[];
  /** Background shells of the session (APP_SPEC "Background shells"): listed between running and finished agents. */
  shells?: Shell[];
  onOpenCard: (c: AgentCardData) => void;
  onStop: (c: AgentCardData) => void;
  onStopShell?: (pid: number) => Promise<void>;
}) {
  const [hover, setHover] = useState(false);
  const [all, setAll] = useState(false);
  const ordered = useStableOrder(orderCards(cards), (c) => c.id, hover);
  // Finished = done, failed or stopped; they share one recency order and one "Show more" cap.
  const done = ordered.filter((c) => !isLive(c));
  const rest = ordered.filter(isLive);
  const shownDone = all ? done : done.slice(0, DONE_CAP);
  const more = done.length - shownDone.length;

  return (
    <div className="flex h-full flex-col" data-agents-panel="open">
      <div className="flex h-[44px] shrink-0 items-center gap-2 pl-4 pr-2">
        <span className="text-base font-semibold text-fg">Jobs</span>
        <span className="min-w-0 flex-1 truncate text-small text-dim tnum" data-agents-count>
          {countsText(cards, shells.length)}
        </span>
      </div>
      <div className="scroll min-h-0 flex-1 px-3 pb-3" onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
        <AnimatePresence initial={false}>
          {rest.map((c) => (
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
        <ShellsSection shells={shells} onStop={onStopShell} />
        <AnimatePresence initial={false}>
          {shownDone.map((c) => (
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
    </div>
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

function Card({ card, onOpen, onStop }: { card: AgentCardData; onOpen: () => void; onStop: () => void }) {
  // Finished (done, failed, stopped): folded to the header and the result line; see lib/cardFold.ts.
  const el = useRef<HTMLDivElement>(null);
  const [open, toggle] = useFold(card.id, card.state === "done" || card.state === "failed", el);
  const collapsed = !open;
  const full = `${card.kind}${card.description ? ` · ${card.description}` : ""}`;

  return (
    <div ref={el} className="overflow-hidden rounded-[14px] border border-hairline bg-bg shadow-card" data-agent-panel-card={card.id} data-state={card.stopped ? "stopped" : card.state} data-open={open}>
      <div role="button" tabIndex={0} onClick={toggle} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())} className="flex cursor-default items-start gap-2 px-3 pb-1 pt-2.5">
        <div className="min-w-0 flex-1">
          {/* The task is what tells agents apart, so it is the title; the model and kind sit under it. */}
          <div className="truncate text-base font-medium leading-[18px] text-fg" title={card.description || undefined}>
            {card.description || (card.model ? modelLabel(card.model) : "Agent")}
          </div>
          <div className="truncate text-small leading-[16px] text-dim" title={full}>
            {[card.model ? modelLabel(card.model) : null, card.kind].filter(Boolean).join(" · ")}
          </div>
        </div>
        <span className="-mt-[2px] flex shrink-0 items-center gap-2">
          {/* No status pill: the strip under the title already says Running / Done / Failed / Stopped / Needs you. */}
          <CardTotal card={card} />
        </span>
        <motion.span animate={{ rotate: collapsed ? 0 : 90 }} transition={{ duration: 0.18, ease }} className="-mr-1 -mt-px flex size-[20px] shrink-0 items-center justify-center text-faint" title={collapsed ? "Expand" : "Collapse"}>
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

// ---------- background shells ----------

/** A small uppercase "SHELLS" label, then one compact card per shell; a finished shell fades out (no history). */
function ShellsSection({ shells, onStop }: { shells: Shell[]; onStop?: (pid: number) => Promise<void> }) {
  const t = { duration: reducedMotion() ? 0 : 0.3, ease };
  return (
    <AnimatePresence initial={false}>
      {shells.length > 0 && (
        <motion.div key="shells" layout="position" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={t} className="overflow-hidden" data-shells-section>
          <div className="px-1 pb-1.5 pt-1 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">Shells</div>
          <AnimatePresence initial={false}>
            {shells.map((sh) => (
              <motion.div key={`${sh.pid}:${sh.started}`} layout="position" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0, transition: { duration: reducedMotion() ? 0 : 0.45, ease } }} transition={t} className="overflow-hidden">
                <div className="pb-2">
                  <ShellCard shell={sh} onStop={onStop} />
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          <div className="h-1" />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ShellElapsed({ since }: { since: number }) {
  const now = useNow();
  return (
    <span className="shrink-0 text-small leading-[18px] text-faint tnum" title="Running for">
      {fmtElapsed(Math.max(0, now - since))}
    </span>
  );
}

/** Stop with a one-step confirm: the button turns into "Stop?" for 3 s; a second click stops. */
function StopShell({ pid, onStop }: { pid: number; onStop?: (pid: number) => Promise<void> }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  if (!onStop) return null;
  const click = (e: { stopPropagation(): void }) => {
    e.stopPropagation();
    if (busy) return;
    if (!armed) return setArmed(true);
    setArmed(false);
    setBusy(true);
    onStop(pid)
      .catch((err) => useStore.getState().toast(`Couldn't stop the shell: ${err instanceof Error ? err.message : String(err)}`, "error"))
      .finally(() => setBusy(false));
  };
  return (
    <button
      type="button"
      onClick={click}
      data-stop-shell={pid}
      data-armed={armed || undefined}
      title={armed ? "Click again to stop this shell" : "Stop this shell"}
      className={cx("-my-px -mr-1.5 h-[22px] shrink-0 rounded-[6px] px-1.5 text-small transition-colors duration-150", armed ? "font-medium text-err-text hover:bg-hover" : "text-dim hover:bg-hover hover:text-fg", busy && "opacity-50")}
    >
      {busy ? "Stopping…" : armed ? "Stop?" : "Stop"}
    </button>
  );
}

function ShellCard({ shell, onStop }: { shell: Shell; onStop?: (pid: number) => Promise<void> }) {
  const el = useRef<HTMLDivElement>(null);
  const tail = shell.tail ?? [];
  const [open, toggle] = useFold(`shell:${shell.pid}:${shell.started}`, true, el);
  const expandable = tail.length > 0;
  const described = !!shell.description;
  const meta = [`pid ${shell.pid}`, `${shell.cpu}% CPU`, shell.background ? null : "foreground"].filter(Boolean).join(" · ");
  return (
    <div ref={el} className="overflow-hidden rounded-[12px] border border-hairline bg-bg shadow-card" data-shell-card={shell.pid} data-open={expandable && open}>
      <div
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
        onClick={expandable ? toggle : undefined}
        onKeyDown={expandable ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle()) : undefined}
        className="flex cursor-default items-start gap-2 px-3 py-2"
        title={meta}
      >
        <MoodGlyph mood="run" size={13} className="mt-[2.5px] text-dim" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={cx("min-w-0 truncate leading-[18px] text-fg", described ? "text-base font-medium" : "font-mono text-mono-small")} title={shell.description ?? shell.command}>
              {shell.description ?? shell.command}
            </span>
            {shell.idle_loop && (
              <span className="shrink-0 rounded-[5px] border border-hairline px-1 text-[11px] leading-[15px] text-faint" title="A polling loop that has been waiting at ~0% CPU" data-idle-loop>
                idle loop
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <span className={cx("min-w-0 flex-1 truncate leading-[18px]", described ? "font-mono text-mono-small text-dim" : "text-small text-faint")} title={described ? shell.command : meta}>
              {described ? shell.command : meta}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end">
          <span className="flex items-center gap-1">
            <ShellElapsed since={shell.started} />
            {expandable && (
              <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.18, ease }} className="-mr-1 flex size-[18px] items-center justify-center text-faint" title={open ? "Hide output" : "Show output"}>
                <IChevron size={13} />
              </motion.span>
            )}
          </span>
          <StopShell pid={shell.pid} onStop={onStop} />
        </div>
      </div>
      <AnimatePresence initial={false}>
        {expandable && open && (
          <motion.div key="tail" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: reducedMotion() ? 0 : 0.22, ease }} className="overflow-hidden">
            <div className="mx-3 mb-2.5 rounded-[8px] bg-raised px-2.5 py-1.5 font-mono text-[11px] leading-[17px] text-dim" data-shell-tail>
              {tail.map((l, i) => (
                <div key={i} className="truncate" title={l}>
                  {l}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
