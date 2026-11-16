import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Activity, Agent, Session } from "../lib/types";
import { fmtElapsed, homeShort, isThinking, shortDetail, splitTool, tsToMs } from "../lib/format";
import { MOODS, moodOfCurrent, toolMood, type Mood } from "../lib/activityMood";
import { useFold } from "../lib/cardFold";
import { isStopReason } from "../lib/stopped";
import { AgentMark } from "./AgentMark";
import { MoodGlyph } from "./MoodGlyph";
import { useStore, type Since } from "../store";
import { useClock } from "../lib/clock";
import { turnTotals } from "../lib/turn";
import { liveJobs } from "../lib/live";
import { IAlert, IChevron, ICheck, toolIcon } from "./icons";
import { Elapsed, JumpToBottom, LiveClock, cx, ease, StatusDot } from "./primitives";
import { ThinkingDots, ThinkingWord } from "./ThinkingWord";
import { Markdown } from "./Markdown";
import { ModelTag } from "./Models";
import { modelLabel } from "../lib/models";
import { RailItem, RailList, Reveal, reducedMotion } from "./StepRail";
import { TimelineSkeleton } from "./Skeletons";

type Block =
  | { type: "prompt" | "text" | "error"; key: string; a: Activity }
  | { type: "steps"; key: string; items: { key: string; a: Activity }[] };

function buildBlocks(list: Activity[]): Block[] {
  const seen = new Map<string, number>();
  const out: Block[] = [];
  for (const a of list) {
    const base = `${a.ts}|${a.kind}|${a.text.slice(0, 40)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const key = `${base}#${n}`;
    if (a.kind === "tool" || a.kind === "agent") {
      const last = out[out.length - 1];
      if (last?.type === "steps") last.items.push({ key, a });
      else out.push({ type: "steps", key, items: [{ key, a }] });
    } else out.push({ type: a.kind, key, a });
  }
  return out;
}

const enter = { opacity: 0, y: 10 };
const shown = { opacity: 1, y: 0 };

/** Inline `code` spans in assistant prose. */
export function Prose({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
          <code key={i} className="rounded-[4px] bg-[color-mix(in_oklab,var(--dim)_14%,transparent)] px-[5px] py-[1px] font-mono text-[0.88em] text-fg">
            {p.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** Live timing for a discovered session: precise only when the change was observed. */
export interface LiveTime {
  at: number;
  approx: boolean;
}
/**
 * When the current activity began. Best: the change coool observed. Next: the last activity entry's own HH:MM:SS stamp
 * (local; a long thinking stretch starts right after that entry, a running tool IS that entry). Only with neither is it
 * an estimate (`approx`), and callers then show no timer. A stamp that lands in the future (clock skew) is not trusted.
 */
export const liveTime = (since: Since | undefined, fallback: number, activity?: Activity[]): LiveTime => {
  if (since?.currentObserved) return { at: since.currentAt, approx: false };
  const last = activity?.[activity.length - 1];
  const at = last ? tsToMs(last.ts) : null;
  if (at !== null && at <= Date.now() + 5000) return { at, approx: false };
  return since ? { at: since.currentAt, approx: true } : { at: fallback, approx: true };
};

export function Timeline({ session, compact, live }: { session: Session; compact?: boolean; live?: LiveTime }) {
  const blocks = useMemo(() => buildBlocks(session.activity), [session.activity]);
  const initial = useRef<Set<string> | null>(null);
  if (initial.current === null) initial.current = new Set(blocks.map((b) => b.key));
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const seenPrompt = useRef<string | null>(null);
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);
  const [fresh, setFresh] = useState(false);
  const busy = session.status === "busy";
  const thinking = busy && (isThinking(session.current) || !session.current || blocks[blocks.length - 1]?.type !== "steps");
  const lt = live ?? liveTime(undefined, session.updated, session.activity);
  const turn = useMemo(() => turnTotals(session), [session]);
  const agentsRunning = session.agents.filter((a) => !a.finished).length;
  const now = moodOfCurrent(isThinking(session.current) ? null : session.current, 0);
  // The main agent is doing something of its own unless it is only waiting on subagents.
  const mainActive = agentsRunning === 0 || isThinking(session.current) || (!!session.current && now.mood !== "delegate");

  // Stay pinned to the bottom while the user is there; leave them alone once they scroll up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // A new prompt (input) always scrolls to the bottom and re-pins; other new output only follows while pinned.
    // Only once per prompt: the newest block stays that prompt for a while, and re-pinning on every later
    // re-run would drag a reader who scrolled up back down.
    const newest = blocks[blocks.length - 1];
    const promptArrived = newest?.type === "prompt" && !initial.current!.has(newest.key) && seenPrompt.current !== newest.key;
    if (promptArrived) {
      seenPrompt.current = newest.key;
      stick.current = true;
    }
    if (stick.current) {
      setAway(false);
      setFresh(false);
      el.scrollTo({ top: el.scrollHeight, behavior: initial.current!.size === blocks.length || reducedMotion() ? "auto" : "smooth" });
    } else setFresh(true);
  }, [blocks.length, session.activity.length, thinking]);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  if (!blocks.length && session.loaded === false) return <TimelineSkeleton compact={compact} />;
  if (!blocks.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <div className="text-title font-semibold tracking-[-0.01em] text-fg/90">No activity yet</div>
        <div className="max-w-[280px] text-base text-dim">Prompts, tool calls and replies appear here as the session transcript grows.</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
    <div
      ref={scroller}
      className="scroll min-h-0 flex-1"
      onScroll={(e) => {
        const el = e.currentTarget;
        const at = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        // Only the reader moving up unpins. A smooth scroll to the bottom passes through "not at the bottom"
        // while moving down, and content growing below never changes scrollTop: neither means the reader left.
        const up = el.scrollTop < lastTop.current - 1;
        lastTop.current = el.scrollTop;
        if (at) stick.current = true;
        else if (up) stick.current = false;
        const isAway = !stick.current;
        setAway((a) => (a === isAway ? a : isAway));
        if (at) setFresh(false);
      }}
    >
      <div className={cx("mx-auto flex max-w-[700px] flex-col pb-[72px] pt-6", compact ? "gap-3 px-4" : "gap-4 px-8")}>
        {blocks.map((b, i) => {
          const fresh = !initial.current!.has(b.key);
          const last = i === blocks.length - 1;
          return (
            <motion.div
              key={b.key}
              className={cx(!last && i < blocks.length - 6 && "cv-auto")}
              initial={fresh ? enter : false}
              animate={shown}
              transition={{ duration: 0.32, ease }}
            >
              {b.type === "prompt" && <PromptBlock a={b.a} />}
              {b.type === "text" && (
                <ActivityText a={b.a} />
              )}
              {b.type === "error" && <ErrorBlock a={b.a} />}
              {b.type === "steps" && (
                <StepGroup items={b.items} agents={session.agents} active={busy && last && !thinking} latest={last || i >= blocks.length - 2} live={lt} />
              )}
            </motion.div>
          );
        })}
        {!busy && turn.startMs !== null && turn.endMs !== null && turn.endMs > turn.startMs && blocks[blocks.length - 1]?.type !== "prompt" && (
          <div className="-mt-1 flex items-center gap-1.5 px-1 text-small text-faint" data-turn-end="done" title={turn.approxStart ? "since the earliest step shown" : undefined}>
            <ICheck size={13} />
            <span className="font-medium text-dim">
              Worked for <span className="tnum">{fmtElapsed(turn.endMs - turn.startMs)}</span>
            </span>
            {turn.tools > 0 && <span>· {turn.tools} tool {turn.tools === 1 ? "use" : "uses"}</span>}
            {session.model && <span>· {modelLabel(session.model)}</span>}
          </div>
        )}
        <AnimatePresence>
          {busy && (
            <motion.div key="thinking" initial={enter} animate={shown} exit={{ opacity: 0, transition: { duration: 0.15 } }} transition={{ duration: 0.3, ease }}>
              <LiveIndicator since={lt.approx ? null : lt.at} mood={agentsRunning > 0 && !session.current ? "delegate" : now.mood} detail={now.detail} agents={agentsRunning} jobs={liveJobs(session)} mainActive={mainActive} timerSince={turn.startMs} timerTitle={turn.approxStart ? "since the earliest step shown" : undefined} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
    <div className="relative h-0 shrink-0">
      <JumpToBottom
        away={away}
        fresh={fresh}
        needs={false}
        onClick={() => {
          stick.current = true;
          setAway(false);
          setFresh(false);
          scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
        }}
      />
    </div>
    </div>
  );
}

const STILL: LiveTime = { at: 0, approx: true };

/** Finished transcript rows drawn like the timeline, without live state (a resumed chat's history). */
export function HistoryBlocks({ rows }: { rows: Activity[] }) {
  const blocks = useMemo(() => buildBlocks(rows), [rows]);
  return (
    <div className="flex flex-col gap-4">
      {blocks.map((b) => (
        <div key={b.key}>
          {b.type === "prompt" && <PromptBlock a={b.a} />}
          {b.type === "text" && (
            <ActivityText a={b.a} />
          )}
          {b.type === "error" && <ErrorBlock a={b.a} />}
          {b.type === "steps" && <StepGroup items={b.items} agents={[]} active={false} latest={false} live={STILL} />}
        </div>
      ))}
    </div>
  );
}

/** The text of a transcript entry: the full text when the core sends it, else the one-line form. */
const bodyOf = (a: Activity): string => a.full ?? a.text;
const shortenedOf = (a: Activity): boolean => !!a.shortened;

function ActivityText({ a }: { a: Activity }) {
  return (
    <div>
      <Markdown text={bodyOf(a)} className="text-prose text-fg/90" />
      {shortenedOf(a) && <div className="mt-1 text-small text-faint">… shortened</div>}
    </div>
  );
}

function PromptBlock({ a }: { a: Activity }) {
  return <PromptBubble text={bodyOf(a)} stamp={a.ts} shortened={shortenedOf(a)} />;
}

export function PromptBubble({ text, stamp, shortened }: { text: string; stamp?: string; shortened?: boolean }) {
  return (
    <div className="flex flex-col items-end gap-1 pt-1">
      <div className="selectable max-w-[86%] whitespace-pre-wrap break-words rounded-[18px] rounded-br-[6px] border border-hairline bg-raised px-4 py-3 text-prose text-fg shadow-card">
        {text}
        {shortened && <div className="mt-1 text-small text-faint">… shortened</div>}
      </div>
      {stamp && <span className="pr-1 font-mono text-mono-small text-faint tnum">{stamp}</span>}
    </div>
  );
}

/**
 * The live "now" indicator: orb + word + dots, the tool's short detail, and an exact timer. `since` is the exact start of
 * the current activity (null: unknown, so no timer and one fixed word). The orb and the word come from `mood`
 * (lib/activityMood.ts); a new mood or start is a new stretch. `large` is the timeline's turn row (28px orb, prose size,
 * full-strength text, timer at the right edge); the small form sits inside step cards.
 */
export function ThinkingRow({
  since,
  mood = "think",
  label: given,
  detail,
  big,
  large,
  live = true,
  timerSince,
  timerTitle,
}: {
  since: number | null;
  /** The running total shown at the right (the turn's start); defaults to `since`. Never restarts with the activity. */
  timerSince?: number | null;
  timerTitle?: string;
  mood?: Mood;
  /** A fixed label instead of the mood's words ("Starting claude in coool"). */
  label?: string;
  detail?: string;
  /** Centered, larger glyph above the label (the empty "Starting…" screens). */
  big?: boolean;
  large?: boolean;
  live?: boolean;
}) {
  const exact = since !== null && Number.isFinite(since);
  const [mounted] = useState(() => Date.now());
  // One seed per stretch: the start of the activity and what it is. A new activity restarts word, orb and timer.
  const seed = `${exact ? since : `m${mounted}`}:${mood}`;
  const m = MOODS[mood];
  const tone = large ? { base: "color-mix(in oklab, var(--text) 92%, var(--bg))", hi: "var(--text)" } : undefined;
  const label = given ? (
    <span className="shimmer inline-block" style={{ ["--shimmer-hi" as string]: "var(--text)" }}>
      {given}
    </span>
  ) : (
    <ThinkingWord seed={seed} origin={exact ? since : null} words={m.words} cycle={exact} tone={tone} />
  );
  const dots = <ThinkingDots color={large ? "color-mix(in oklab, var(--text) 92%, var(--bg))" : undefined} />;
  if (big)
    return (
      <div className="flex flex-col items-center gap-3 py-1 text-base">
        <MoodGlyph mood={mood} size={28} live={live} className="text-dim" />
        <div className="flex items-center gap-2.5">
          <span className="inline-flex font-medium">
            {label}
            {dots}
          </span>
          <LiveClock since={exact ? since : null} className="text-small text-faint" />
        </div>
      </div>
    );
  if (large)
    return (
      <div className="flex items-center gap-3 pb-1 pt-2.5 text-prose" data-live-row data-mood={mood}>
        <span className="flex size-[20px] shrink-0 items-center justify-center">
          <MoodGlyph mood={mood} size={16} live={live} className="text-dim" />
        </span>
        <span className="inline-flex shrink-0 font-medium">
          {label}
          {dots}
        </span>
        {detail && <span className="selectable min-w-0 flex-1 truncate font-mono text-mono-small text-dim">{shortDetail(detail)}</span>}
        <LiveClock since={timerSince !== undefined ? timerSince : exact ? since : null} title={timerTitle} className="ml-auto shrink-0 pr-2 text-small text-dim" />
      </div>
    );
  return (
    <div className="flex items-center gap-2.5 py-1 text-base">
      <span className="relative flex size-[22px] items-center justify-center">
        <MoodGlyph mood={mood} size={14} live={live} className="text-dim" />
      </span>
      {/* Fixed-width slot (widest word) so the timer does not jitter as the word changes. */}
      <span className="inline-flex font-medium" style={{ minWidth: given ? undefined : "15ch" }}>
        {label}
        {dots}
      </span>
      <LiveClock since={exact ? since : null} className="text-small text-faint" />
    </div>
  );
}

/**
 * The live row of a running turn. While the main agent itself is working it is the animated ThinkingRow. When only
 * subagents/jobs are running and the main agent is idle it is a quiet static line ("4 agents running", exact timer),
 * like Claude Code's own status line: no orb, no shimmer, no cycling word. The orb for delegating is shown only for the
 * moment the main agent is making the Agent call.
 */
export function LiveIndicator({
  since,
  mood,
  detail,
  agents,
  jobs = 0,
  mainActive,
  timerSince,
  timerTitle,
}: {
  since: number | null;
  timerSince?: number | null;
  timerTitle?: string;
  mood: Mood;
  detail?: string;
  agents: number;
  jobs?: number;
  mainActive: boolean;
}) {
  // Only the flag drives a re-render, not every tick.
  const launching = useClock((now) => mood === "delegate" && since !== null && now - since < 1500);
  const quiet = !mainActive && agents + jobs > 0 && !launching;
  if (!quiet) return <ThinkingRow since={since} mood={mood} detail={detail} large timerSince={timerSince} timerTitle={timerTitle} />;
  const parts = [agents > 0 && `${agents} ${agents === 1 ? "agent" : "agents"}`, jobs > 0 && `${jobs} ${jobs === 1 ? "job" : "jobs"}`].filter(Boolean).join(", ");
  return (
    <div className="flex items-center gap-2 py-1 text-small text-dim" data-live-quiet>
      <span className="flex size-[22px] shrink-0 items-center justify-center">
        <span className="size-[7px] rounded-full bg-working" />
      </span>
      <span>{parts} running</span>
      <LiveClock since={timerSince !== undefined ? timerSince : since} title={timerTitle} className="ml-auto shrink-0 pr-2 text-small text-dim" />
    </div>
  );
}

function summarize(items: { a: Activity }[]): { name: string; n: number }[] {
  const m = new Map<string, number>();
  for (const { a } of items) {
    const n = a.kind === "agent" ? "Agent" : splitTool(a.text).name;
    m.set(n, (m.get(n) ?? 0) + 1);
  }
  return [...m.entries()].map(([name, n]) => ({ name, n })).slice(0, 4);
}

const StepGroup = memo(function StepGroup({
  items,
  agents,
  active,
  latest,
  live,
}: {
  items: { key: string; a: Activity }[];
  agents: Agent[];
  active: boolean;
  latest: boolean;
  live: LiveTime;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const focus = useStore((st) => st.agentFocus);
  const holdsFocus = !!focus && Date.now() - focus.at < FOCUS_FRESH_MS && items.some((i) => i.a.kind === "agent" && agentOf(i.a, agents)?.id === focus.id);
  useEffect(() => {
    if (holdsFocus) setOpen(true);
  }, [holdsFocus]);
  const isOpen = open ?? (latest || items.length <= 2);
  const mountKeys = useRef(new Set(items.map((i) => i.key)));
  const chips = summarize(items);
  const first = tsToMs(items[0].a.ts);
  const lastT = tsToMs(items[items.length - 1].a.ts);
  const span = first !== null && lastT !== null ? lastT - first : 0;

  return (
    <div className="rounded-[10px]">
      <button
        type="button"
        onClick={() => setOpen(!isOpen)}
        className="group flex w-full items-center gap-2 rounded-[8px] py-1 pl-0.5 pr-2 text-left text-base transition-colors duration-150 hover:bg-hover"
      >
        <motion.span animate={{ rotate: isOpen ? 90 : 0 }} transition={{ duration: 0.18, ease }} className="flex size-[22px] items-center justify-center text-faint group-hover:text-dim">
          <IChevron size={14} />
        </motion.span>
        {active ? (
          <span className="shimmer font-medium">Running {items.length === 1 ? "a step" : `${items.length} steps`}</span>
        ) : (
          <span className="font-medium text-dim group-hover:text-fg/85">Ran {items.length === 1 ? "1 step" : `${items.length} steps`}</span>
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {chips.map((c) => (
            <span key={c.name} className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[6px] bg-[color-mix(in_oklab,var(--dim)_11%,transparent)] px-1.5 text-small font-medium text-dim">
              {c.name}
              {c.n > 1 && <span className="tnum text-faint">{c.n}</span>}
            </span>
          ))}
        </span>
        {!active && span > 0 && <span className="shrink-0 text-small text-faint tnum">{fmtElapsed(span)}</span>}
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            key="list"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reducedMotion() ? 0 : 0.24, ease }}
            className="overflow-hidden"
          >
            <RailList className="ml-[12px] mt-1 pb-1">
              {items.map((it, i) => {
                const isActive = active && i === items.length - 1;
                const fresh = !mountKeys.current.has(it.key);
                return (
                  <RailItem key={it.key} first={i === 0} last={i === items.length - 1} fresh={fresh} active={isActive} dotY={it.a.kind === "agent" ? 20 : 14}>
                    {it.a.kind === "agent" ? (
                      <AgentStep a={it.a} agents={agents} active={isActive} live={live} />
                    ) : (
                      <StepRow a={it.a} active={isActive} live={live} fresh={fresh} />
                    )}
                  </RailItem>
                );
              })}
            </RailList>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

function StepRow({ a, active, dense, live, fresh }: { a: Activity; active: boolean; dense?: boolean; live: LiveTime; fresh?: boolean }) {
  const { name, detail } = splitTool(a.text);
  return <StepLine name={name} detail={detail} active={active} dense={dense} fresh={fresh} stamp={a.ts} since={live.at} approx={live.approx} />;
}

/** One step: icon (or spinner), tool name, mono detail, timer or timestamp. Shared by Activity and Chat. */
export function StepLine({
  name,
  detail,
  active,
  stamp,
  since,
  approx,
  failed,
  stopped,
  waiting,
  fresh,
  onClick,
  open,
  dense,
}: {
  name: string;
  detail: string;
  active: boolean;
  /** Inside a subagent card: the running step shows the subagent's live glyph. */
  dense?: boolean;
  /** Cut off by Stop / an interrupt: neutral, never red. */
  stopped?: boolean;
  stamp?: string;
  since?: number | null;
  approx?: boolean;
  failed?: boolean;
  waiting?: boolean;
  /** Arrived just now: reveal the label left to right. */
  fresh?: boolean;
  onClick?: () => void;
  open?: boolean;
}) {
  const Icon = toolIcon(name);
    return (
    <div
      onClick={onClick}
      className={cx(
        "group relative flex items-center gap-2.5 rounded-[7px] pr-2",
        "h-[28px]",
        active && !waiting && "sweep",
        onClick && "hover:bg-hover",
        open && "bg-hover",
      )}
      style={active ? { ["--sweep" as string]: "var(--status-working)" } : undefined}
    >
      <span
        className={cx(
          "relative flex size-[18px] shrink-0 items-center justify-center",
          waiting ? "text-needs-text" : active ? "text-dim" : failed && !stopped ? "text-err-text" : "text-faint",
        )}
      >
        {waiting ? (
          <span className="size-[7px] rounded-full bg-needs breathe" />
        ) : failed && !stopped ? (
          <IAlert size={14} />
        ) : active && dense ? (
          <MoodGlyph mood={toolMood(name)} size={13} />
        ) : (
          <Icon size={12} />
        )}
      </span>
      <span
        className={cx("shrink-0 text-base font-medium", waiting ? "text-fg/85" : failed && !stopped ? "text-err-text/90" : stopped ? "text-dim" : !active && "text-fg/80")}
      >
        <Reveal
          text={name}
          fresh={fresh}
          inner={active && !waiting ? { className: "shimmer", style: { ["--shimmer-base" as string]: "var(--text)", ["--shimmer-hi" as string]: "var(--dim)" } } : undefined}
        />
      </span>
      {detail && (
        <span className={cx("selectable min-w-0 flex-1 truncate font-mono text-mono-small", failed && !stopped ? "text-err-text/70 line-through decoration-err/40" : "text-dim")} title={failed ? detail : undefined}>
          {/* A struck-through path is read at a glance: short, like the rest of the timeline. */}
          <Reveal text={failed && !stopped ? shortDetail(homeShort(detail)) : detail} fresh={fresh} />
        </span>
      )}
      {!detail && <span className="flex-1" />}
      {waiting ? (
        <span className="shrink-0 text-small text-needs-text">waiting for you</span>
      ) : stopped ? (
        <span className="shrink-0 text-small text-faint" data-step-stopped>
          stopped
        </span>
      ) : active ? (
        <Elapsed since={since ?? null} approx={approx} className="shrink-0 text-small text-faint" />
      ) : (
        stamp && <span className="shrink-0 font-mono text-mono-small text-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100 tnum">{stamp}</span>
      )}
    </div>
  );
}

/** The subagent an "Agent · description" step belongs to. */
const agentOf = (a: Activity, agents: Agent[]): Agent | null => {
  const { detail } = splitTool(a.text);
  return agents.find((g) => g.description && (g.description === detail || detail.startsWith(g.description))) ?? null;
};

/** Asked (from the sidebar or the header chip) to show this subagent's card, and recent enough to still mean it. */
const FOCUS_FRESH_MS = 6000;

/** Scroll a card into view when it was asked for (sidebar, header chip, Agents panel) and keep it lit for a moment. */
export function useFocusLit(asked: boolean, card: { current: HTMLElement | null }): boolean {
  const [lit, setLit] = useState(false);
  useEffect(() => {
    if (!asked) return;
    // After the group has opened and the timeline has settled at the bottom.
    const t = setTimeout(() => {
      card.current?.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
      useStore.setState({ agentFocus: null });
      setLit(true);
    }, 380);
    return () => clearTimeout(t);
  }, [asked, card]);
  useEffect(() => {
    if (!lit) return;
    const t = setTimeout(() => setLit(false), 1800);
    return () => clearTimeout(t);
  }, [lit]);
  return lit;
}

/** How a finished subagent ended, and its one-line result: "Done · 3 tool uses · 5s". */
export type AgentEnd = "done" | "failed" | "stopped";
export function agentResultParts(uses: number, ms: number | null): string[] {
  return [uses > 0 && `${uses} tool ${uses === 1 ? "use" : "uses"}`, ms !== null && ms > 0 && fmtElapsed(ms)].filter(Boolean) as string[];
}

/** The chevron of a foldable card: › folded, ⌄ open. */
export function FoldChevron({ open }: { open: boolean }) {
  return (
    <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: reducedMotion() ? 0 : 0.18, ease }} className="-mr-1 flex size-[20px] shrink-0 items-center justify-center text-faint" title={open ? "Collapse" : "Expand"}>
      <IChevron size={14} />
    </motion.span>
  );
}

/** The header of a finished subagent card, and all of it when folded: status, task, result line, chevron. */
export function FinishedAgentHead({ end, title, parts, reason, open, onToggle }: { end: AgentEnd; title: string; parts: string[]; reason?: string | null; open: boolean; onToggle: () => void }) {
  const label = end === "failed" ? "Failed" : end === "stopped" ? "Stopped" : "Done";
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-[7px] text-left transition-colors duration-150 hover:bg-hover" data-agent-result={end} title={reason || undefined}>
      <span className="flex size-[14px] shrink-0 items-center justify-center">
        {end === "failed" ? <IAlert size={13} className="text-err-text" /> : end === "stopped" ? <span className="size-[7px] rounded-full bg-faint" /> : <ICheck size={13} className="text-faint" />}
      </span>
      <span className="min-w-0 flex-1 truncate text-base font-medium text-fg">{title}</span>
      <span className={cx("shrink-0 text-small tnum", end === "failed" ? "text-err-text" : "text-faint")}>
        <span className={cx("font-medium", end !== "failed" && "text-dim")}>{label}</span>
        {parts.length > 0 && <> · {parts.join(" · ")}</>}
      </span>
      <FoldChevron open={open} />
    </button>
  );
}

/** Folds with the same ease the Agents panel uses. */
export function FoldBody({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div key="body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: reducedMotion() ? 0 : 0.26, ease }} className="overflow-hidden">
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function AgentStep({ a, agents, active, live }: { a: Activity; agents: Agent[]; active: boolean; live: LiveTime }) {
  const { detail } = splitTool(a.text);
  const agent = agentOf(a, agents);
  const card = useRef<HTMLDivElement>(null);
  const focus = useStore((st) => st.agentFocus);
  const asked = !!agent && !!focus && focus.id === agent.id && Date.now() - focus.at < FOCUS_FRESH_MS;
  const focused = useFocusLit(asked, card);
  const running = agent ? !agent.finished : active;
  const all = agent?.activity ?? [];
  const steps = all.filter((x) => x.kind === "tool" || x.kind === "agent").slice(-5);
  const agentSeen = useRef(new Set(steps.map((s) => `${s.ts}${s.text}`)));
  // How it ended: a closing error is a failure, or a stop when it says the person interrupted it.
  const last = all[all.length - 1];
  const failedEnd = !running && !!last && last.kind === "error" && !last.step;
  const reason = failedEnd ? (last.full ?? last.text) : null;
  const end: AgentEnd = failedEnd ? (isStopReason(reason) ? "stopped" : "failed") : "done";
  const t0 = all.length ? tsToMs(all[0].ts) : null;
  const t1 = last ? tsToMs(last.ts) : null;
  const parts = agentResultParts(all.filter((x) => x.kind === "tool" || x.kind === "agent").length, t0 !== null && t1 !== null ? t1 - t0 : null);
  const [open, toggle] = useFold(`agent:${agent?.id ?? a.text}`, !running, card);
  useEffect(() => {
    if (asked && !open) toggle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);
  const title = detail || agent?.description || "Subagent";
  return (
    <div className="flex gap-2.5 py-1">
      <span className="relative z-[1] mt-[7px] flex size-[18px] shrink-0 items-center justify-center rounded-full bg-bg text-dim">
        <AgentMark size={14} state={running ? "live" : end} />
      </span>
      <div
        ref={card}
        data-agent-card={agent?.id}
        data-open={open}
        className={cx(
          "min-w-0 flex-1 overflow-hidden rounded-[10px] border bg-raised shadow-card transition-[border-color] duration-500",
          focused ? "border-[color-mix(in_oklab,var(--status-working)_45%,var(--border))]" : "border-hairline",
        )}
      >
        {running ? (
          <div role="button" tabIndex={0} onClick={toggle} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())} className="flex cursor-default items-center gap-2 px-3 pt-2 pb-1.5">
            <span className="rounded-[6px] bg-[color-mix(in_oklab,var(--accent-2)_14%,transparent)] px-1.5 text-small font-medium text-dim">
              {agent?.kind || "subagent"}
            </span>
            <span className="min-w-0 flex-1 truncate text-base font-medium text-fg">{title}</span>
            {agent && <AgentModels agent={agent} />}
            <StatusDot status="busy" size={7} />
            <FoldChevron open={open} />
          </div>
        ) : (
          <FinishedAgentHead end={end} title={title} parts={parts} reason={reason} open={open} onToggle={toggle} />
        )}
        <FoldBody open={open}>
          {!running && (
            <div className="flex items-center gap-2 px-3 pb-1">
              <span className="rounded-[6px] bg-[color-mix(in_oklab,var(--accent-2)_14%,transparent)] px-1.5 text-small font-medium text-dim">{agent?.kind || "subagent"}</span>
              {agent && <AgentModels agent={agent} />}
              {reason && <span className={cx("min-w-0 flex-1 truncate text-small", end === "failed" ? "text-err-text/90" : "text-dim")} title={reason}>{reason}</span>}
            </div>
          )}
          {steps.length > 0 && (
            <div className="pb-1.5 pl-[14px] pr-1">
              <RailList>
                {steps.map((s, i) => {
                  const k = `${s.ts}${s.text}`;
                  const fresh = !agentSeen.current.has(k);
                  return (
                    <RailItem key={k} first={i === 0} last={i === steps.length - 1} fresh={fresh} active={running && i === steps.length - 1}>
                      <StepRow a={s} active={running && i === steps.length - 1} dense live={live} fresh={fresh} />
                    </RailItem>
                  );
                })}
              </RailList>
            </div>
          )}
          {running && steps.length === 0 && (
            <div className="px-3 pb-2">
              <ThinkingRow since={live.approx ? null : live.at} label="Starting" mood="start" />
            </div>
          )}
        </FoldBody>
      </div>
    </div>
  );
}

export function Section({ children }: { children: ReactNode }) {
  return <div className="font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">{children}</div>;
}

function AgentModels({ agent }: { agent: Agent }) {
  const ids = agent.models?.length ? agent.models.map((m) => m.model) : agent.model ? [agent.model] : [];
  if (!ids.length) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {ids.slice(0, 2).map((m) => (
        <ModelTag key={m} model={m} />
      ))}
    </span>
  );
}


/**
 * An error in the timeline. A failed step (one tool call that returned an error; the agent
 * usually carries on) is a quiet one-line row that expands on click. Anything else (the turn
 * or the API failed) keeps the red block.
 */
function ErrorBlock({ a }: { a: Activity }) {
  const [open, setOpen] = useState(false);
  const body = bodyOf(a);
  if (a.step) {
    const stopped = isStopReason(a.full ?? a.text);
    return (
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? undefined : body}
        className="flex w-full items-start gap-2 rounded-[8px] px-2.5 py-1 text-left text-small text-dim transition-colors duration-150 hover:bg-hover"
      >
        {stopped ? (
          <span className="mt-[2px] flex size-[14px] shrink-0 items-center justify-center">
            <span className="size-[7px] rounded-full bg-faint" />
          </span>
        ) : (
          <IAlert size={14} className="mt-[2px] shrink-0 text-err-text opacity-80" />
        )}
        <span className={open ? "selectable min-w-0 whitespace-pre-wrap break-words" : "min-w-0 truncate"} data-step-error={stopped ? "stopped" : "failed"}>
          <span className="text-faint">{stopped ? "A step was stopped · " : "A step failed · "}</span>
          {body}
          {open && shortenedOf(a) && <span className="text-faint"> … shortened</span>}
        </span>
      </button>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-[8px] bg-[color-mix(in_oklab,var(--error)_7%,transparent)] px-2.5 py-1.5 text-base text-err-text">
      <IAlert size={16} className="mt-[2px] shrink-0" />
      <span className="selectable min-w-0 whitespace-pre-wrap break-words">
        {body}
        {shortenedOf(a) && <span className="text-faint"> … shortened</span>}
      </span>
    </div>
  );
}
