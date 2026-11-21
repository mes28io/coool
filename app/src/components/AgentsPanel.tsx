// The Agents side panel: one card per subagent / child job of the session on screen.
// Takes plain cards (lib/agentCards.ts); knows nothing about where they came from.

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { countsText, isLive, orderCards, type AgentCardData } from "../lib/agentCards";
import { useClock } from "../lib/clock";
import { fmtClock, fmtElapsed } from "../lib/format";
import { MOODS, toolMood } from "../lib/activityMood";
import { useFold } from "../lib/cardFold";
import { modelLabel } from "../lib/models";
import { useStableOrder } from "../lib/stable";
import { ThinkingDots, ThinkingWord } from "./ThinkingWord";
import { IArrowUpRight, ICheck, IChevron, toolIcon } from "./icons";
import { MoodGlyph } from "./MoodGlyph";
import { FillBar, Handoff } from "./AgentFill";
import { cx, ease, spring, StatusDot, TokenCount } from "./primitives";
import { reducedMotion } from "./StepRail";
import type { Shell } from "../lib/types";
import { useStore } from "../store";
import { rootOf, treeOrder } from "../lib/ladderHelpers";

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
  roles,
}: {
  cards: AgentCardData[];
  /** Card id -> Ladder tier ("small"), for a chat launched with Ladder. */
  roles?: Record<string, string>;
  /** Background shells of the session (APP_SPEC "Background shells"): listed between running and finished agents. */
  shells?: Shell[];
  onOpenCard: (c: AgentCardData) => void;
  onStop: (c: AgentCardData) => void;
  onStopShell?: (pid: number) => Promise<void>;
}) {
  const [hover, setHover] = useState(false);
  const [all, setAll] = useState(false);
  const stable = useStableOrder(orderCards(cards), (c) => c.id, hover);
  // Nested helpers (Ladder) sit under their parent: a tree, grouped by whether its root is live.
  const nested = stable.some((c) => c.parentRef);
  const ordered = nested ? treeOrder(stable) : stable;
  const byId = new Map(ordered.map((c) => [c.id, c]));
  const liveRoot = (c: AgentCardData) => (nested ? isLive(byId.get(rootOf(c, byId)) ?? c) || isLive(c) : isLive(c));
  // Finished = done, failed or stopped; they share one recency order and one "Show more" cap.
  const done = ordered.filter((c) => !liveRoot(c));
  const rest = ordered.filter(liveRoot);
  const shownDone = all ? done : done.slice(0, DONE_CAP);
  const more = done.length - shownDone.length;
  // What can move a card: the lists' order and the shells between them. Layout animations re-measure only when
  // this changes, not on every sessions payload (each one re-renders the panel; a measure touches every motion
  // element in the window).
  const order = `${rest.map((c) => c.id).join()}|${shells.map((s) => s.pid).join()}|${shownDone.map((c) => c.id).join()}`;

  return (
    <div className="flex h-full flex-col" data-agents-panel="open">
      <div className="flex h-[44px] shrink-0 items-center gap-2 pl-4 pr-2">
        <span className="text-base font-semibold text-fg">Jobs</span>
        <span className="min-w-0 flex-1 truncate text-small text-dim tnum" data-agents-count>
          {countsText(cards, shells.length)}
        </span>
      </div>
      {/* The scrollbar's reserved gutter (10px, styles.css `.scroll`) is part of the right margin: 2 + 10 = the left's 12. */}
      <div className="scroll min-h-0 flex-1 pb-3 pl-3 pr-[2px]" onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
        <AnimatePresence initial={false}>
          {rest.map((c) => (
            <motion.div
              key={c.id}
              layout="position"
              layoutDependency={order}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: reducedMotion() ? 0 : 0.3, ease, layout: reducedMotion() ? { duration: 0 } : spring }}
              className="overflow-hidden"
            >
              <div className="pb-2" style={c.depth ? { paddingLeft: Math.min(c.depth, 4) * 14 } : undefined} data-agent-depth={c.depth || undefined}>
                <Card role={roleWord(c, roles)} card={c} onOpen={() => onOpenCard(c)} onStop={() => onStop(c)} />
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
              layoutDependency={order}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: reducedMotion() ? 0 : 0.3, ease, layout: reducedMotion() ? { duration: 0 } : spring }}
              className="overflow-hidden"
            >
              <div className="pb-2" style={c.depth ? { paddingLeft: Math.min(c.depth, 4) * 14 } : undefined} data-agent-depth={c.depth || undefined}>
                <Card role={roleWord(c, roles)} card={c} onOpen={() => onOpenCard(c)} onStop={() => onStop(c)} />
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

/** The Ladder word before a card's model: its tier ("small"), "image" for an image job, "helper" for a coool chat. */
function roleWord(c: AgentCardData, roles?: Record<string, string>): string | undefined {
  if (roles?.[c.id]) return roles[c.id];
  if (c.helper) return /\b(image|icon|illustration|logo|png)\b/i.test(`${c.helper.title} ${c.description}`) ? "image" : "helper";
  return undefined;
}

function Timer({ since, className }: { since: number | null; className?: string }) {
  const text = useClock((now) => (since === null || since > now + 5000 ? null : fmtClock(now - since)));
  if (text === null) return null;
  return <span className={cx("tnum", className)}>{text}</span>;
}

/** The agent's total time at the top right: ticking while it runs (from its first step), final once done. */
function CardTotal({ card }: { card: AgentCardData }) {
  const live = card.state === "running" || card.state === "needs";
  const startedAt = card.startedAt;
  const ticking = useClock((now) => (live && startedAt !== null && startedAt <= now + 5000 ? fmtClock(now - startedAt) : null));
  const text = live ? ticking : card.durationMs === null ? null : fmtClock(card.durationMs);
  if (text === null) return null;
  return (
    <span className="flex shrink-0 items-center gap-2 text-small text-faint">
      <TokenCount n={card.tokens} total={card.source !== "job"} what="by this agent" />
      <span className="tnum" title="Total time" data-card-total>
        {text}
      </span>
    </span>
  );
}

function Card({ card, role, onOpen, onStop }: { card: AgentCardData; role?: string; onOpen: () => void; onStop: () => void }) {
  // Finished (done, failed, stopped): folded to the header and the result line; see lib/cardFold.ts.
  const el = useRef<HTMLDivElement>(null);
  const [open, toggle] = useFold(card.id, card.state === "done" || card.state === "failed", el);
  const collapsed = !open;
  const full = `${card.kind}${card.description ? ` · ${card.description}` : ""}`;

  return (
    <div ref={el} className="overflow-hidden rounded-[14px] border border-hairline bg-bg shadow-card" data-agent-panel-card={card.id} data-state={card.quiet ? "quiet" : card.stopped ? "stopped" : card.state} data-open={open}>
      <div role="button" tabIndex={0} onClick={toggle} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())} className="flex cursor-default items-start gap-2 px-3 pb-1 pt-2.5">
        <div className="min-w-0 flex-1">
          {/* The task is what tells agents apart, so it is the title; the model and kind sit under it. */}
          <div className="truncate text-base font-medium leading-[18px] text-fg" title={card.description || undefined}>
            {card.description || (card.model ? modelLabel(card.model) : "Agent")}
          </div>
          <div className="truncate text-small leading-[16px] text-dim" title={full}>
            {[card.model ? (role ? `${role} · ${role === "image" && /gpt|codex/i.test(card.model) ? "GPT" : modelLabel(card.model)}` : modelLabel(card.model)) : null, card.depth ? `nested ${card.depth}` : null, card.kind].filter(Boolean).join(" · ")}
          </div>
        </div>
        <span className="-mt-[2px] flex shrink-0 items-center gap-1">
          {/* No status pill: the strip under the title already says Running / Done / Failed / Stopped / Needs you.
              Steps, time and tokens are in the footer, which stays visible when the card is folded. */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            onKeyDown={(e) => e.stopPropagation()}
            data-open-card
            title={card.source === "job" ? "Open" : "Open in timeline"}
            aria-label={card.source === "job" ? "Open" : "Open in timeline"}
            className="-my-0.5 flex size-[22px] items-center justify-center rounded-[6px] text-faint transition-colors duration-150 hover:bg-hover hover:text-fg"
          >
            <IArrowUpRight size={13} />
          </button>
        </span>
        <motion.span animate={{ rotate: collapsed ? 0 : 90 }} transition={{ duration: 0.18, ease }} className="-mr-1 -mt-px flex size-[20px] shrink-0 items-center justify-center text-faint" title={collapsed ? "Expand" : "Collapse"}>
          <IChevron size={14} />
        </motion.span>
      </div>
      {(card.fill || card.handoff) && (
        <div className="flex flex-col gap-1 px-3 pt-1" data-agent-extra>
          {card.fill && <FillBar fill={card.fill} running={isLive(card)} />}
          {card.handoff && <Handoff text={card.handoff} full={card.handoffFull} />}
        </div>
      )}
      <div className="px-3 pb-1.5 pt-1.5">
        <Strip card={card} />
      </div>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div key="body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: reducedMotion() ? 0 : 0.26, ease }} className="overflow-hidden">
            <div className="px-3 pb-1">
              <Bar card={card} />
              <Recent card={card} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="px-3 pb-2">
        <div className="flex h-[24px] items-center gap-2 text-small text-faint">
          <span className="tnum">
            {card.steps.length} {card.steps.length === 1 ? "step" : "steps"}
          </span>
          {card.stoppable && (
            <button type="button" onClick={onStop} className="-my-px h-[24px] rounded-[6px] px-1.5 text-small text-dim transition-colors duration-150 hover:bg-hover hover:text-fg">
              Stop
            </button>
          )}
          <span className="flex-1" />
          <CardTotal card={card} />
        </div>
      </div>
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
        {card.stopped && !card.quiet && <span className="shrink-0 font-medium text-fg">Stopped</span>}
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
  // "Read src/a.ts" -> "src/a.ts"; a phrase ("Opened affectui.com", lib/toolNames.ts) stays whole.
  const detail = card.labelTool ? (card.label.startsWith(card.labelTool) ? card.label.slice(card.labelTool.length).trim() : card.label) : "";
  return (
    <div className={cx(className, "live-layer")} data-now-strip>
      {/* Subagents get words, not orbs: a small glyph of what it is doing keeps the slot. */}
      <MoodGlyph mood={mood} size={14} className="text-running" />
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
            style={s.failed || s.run ? undefined : { background: "var(--status-done)" }}
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
  // Re-measure for layout animations only when the list changes (see `order` in AgentsBody).
  const order = shells.map((s) => `${s.pid}:${s.started}`).join();
  return (
    <AnimatePresence initial={false}>
      {shells.length > 0 && (
        <motion.div key="shells" layout="position" layoutDependency={order} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={t} className="overflow-hidden" data-shells-section>
          <div className="px-1 pb-1.5 pt-1 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">Shells</div>
          <AnimatePresence initial={false}>
            {shells.map((sh) => (
              <motion.div key={`${sh.pid}:${sh.started}`} layout="position" layoutDependency={order} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0, transition: { duration: reducedMotion() ? 0 : 0.45, ease } }} transition={t} className="overflow-hidden">
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
  const text = useClock((now) => fmtElapsed(Math.max(0, now - since)));
  return (
    <span className="shrink-0 text-small leading-[18px] text-faint tnum" title="Running for">
      {text}
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
  // A plain label for a shell that only waits on (or starts) helpers: "waiting for 2 Codex helpers" (crates/core/src/lanes.rs).
  const title = shell.label ?? shell.description;
  const described = !!title;
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
            <span className={cx("min-w-0 truncate leading-[18px] text-fg", described ? "text-base font-medium" : "font-mono text-mono-small")} title={shell.label ? `${shell.label}${shell.description ? ` · ${shell.description}` : ""}` : (shell.description ?? shell.command)} data-shell-label={shell.label ? "" : undefined}>
              {title ?? shell.command}
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
