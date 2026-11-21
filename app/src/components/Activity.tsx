import { AnimatePresence, motion } from "motion/react";
import { MessageAttachments } from "./Attachments";
import type { Attachment } from "../lib/attachRules";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Activity, Agent, ArtifactInfo, Session } from "../lib/types";
import { fmtElapsed, fmtTokens, homeShort, isThinking, shortDetail, splitTool, tsToMs } from "../lib/format";
import { MOODS, moodOfCurrent, toolMood, type Mood } from "../lib/activityMood";
import { useFold } from "../lib/cardFold";
import { isStopReason } from "../lib/stopped";
import { agentEnd } from "../lib/agentState";
import { AgentMark } from "./AgentMark";
import { MoodGlyph } from "./MoodGlyph";
import { Shimmer } from "./Shimmer";
import { useStore, type Since } from "../store";
import { api } from "../lib/backend";
import { useClock } from "../lib/clock";
import { turnTotals } from "../lib/turn";
import { liveJobs } from "../lib/live";
import { IAlert, IChevron, ICheck, toolIcon } from "./icons";
import { groupOf, toolRowFromText } from "../lib/toolNames";
import { agentFill, handoffLine } from "../lib/agentFill";
import { FillBar, Handoff } from "./AgentFill";
import { Elapsed, JumpToBottom, LiveClock, TokenCount, cx, ease } from "./primitives";
import { ThinkingDots, ThinkingWord } from "./ThinkingWord";
import { Markdown } from "./Markdown";
import { ModelTag } from "./Models";
import { modelLabel } from "../lib/models";
import { RailItem, RailList, Reveal, reducedMotion } from "./StepRail";
import { TimelineSkeleton } from "./Skeletons";
import { ArtifactCard, artifactVersions } from "./ArtifactCard";
import { countRender } from "../lib/perfCount";
import { sessionKey } from "../lib/types";
import { bringNear, KeepScope, useKept, Windowed, type WindowApi } from "./Windowed";
import { useKeepReadingPlace } from "../lib/layoutAnchor";

type Block =
  | { type: "prompt" | "text" | "error"; key: string; a: Activity }
  | { type: "steps"; key: string; items: { key: string; a: Activity }[] }
  /** An artifact's newest publish; earlier publishes of the same page fold into it. */
  | { type: "artifact"; key: string; a: Activity; info: ArtifactInfo; versions: number };

function buildBlocks(list: Activity[]): Block[] {
  const seen = new Map<string, number>();
  const out: Block[] = [];
  const pages = artifactVersions(list, (a) => a.artifact);
  // Artifact cards wait for the end of their turn (before the next prompt), so they read as the turn's result, after
  // the reply that talks about them.
  let held: Block[] = [];
  const flush = () => {
    out.push(...held);
    held = [];
  };
  list.forEach((a, i) => {
    const base = `${a.ts}|${a.kind}|${a.text.slice(0, 40)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const key = `${base}#${n}`;
    if (a.artifact) {
      const p = pages.get(a.artifact.url)!;
      // Keyed by the page, so a new version replaces the card instead of adding one.
      if (p.last === i) held.push({ type: "artifact", key: `artifact:${a.artifact.url}`, a, info: p.info, versions: p.versions });
    } else if (a.kind === "tool" || a.kind === "agent") {
      const last = out[out.length - 1];
      if (last?.type === "steps") last.items.push({ key, a });
      else out.push({ type: "steps", key, items: [{ key, a }] });
    } else {
      if (a.kind === "prompt") flush();
      out.push({ type: a.kind, key, a });
    }
  });
  flush();
  return out;
}

const sameEntry = (a: Activity, b: Activity) =>
  a === b || (a.ts === b.ts && a.kind === b.kind && a.text === b.text && a.full === b.full && !!a.shortened === !!b.shortened && !!a.step === !!b.step);
const sameBlock = (a: Block, b: Block) =>
  a.type === b.type &&
  (a.type === "steps"
    ? b.type === "steps" && a.items.length === b.items.length && a.items.every((x, i) => x.key === b.items[i].key && sameEntry(x.a, b.items[i].a))
    : a.type === "artifact"
      ? b.type === "artifact" && a.versions === b.versions && JSON.stringify(a.info) === JSON.stringify(b.info)
      : b.type !== "steps" && b.type !== "artifact" && sameEntry(a.a, b.a));

/**
 * `buildBlocks`, with every block that is the same as last time kept as the same object, so the memoised block
 * views skip it: a busy session re-renders only its newest blocks on each payload, not the whole timeline.
 */
function useBlocks(list: Activity[]): Block[] {
  const prev = useRef(new Map<string, Block>());
  return useMemo(() => {
    const next = buildBlocks(list).map((b) => {
      const old = prev.current.get(b.key);
      return old && sameBlock(old, b) ? old : b;
    });
    prev.current = new Map(next.map((b) => [b.key, b]));
    return next;
  }, [list]);
}

/** The subagents a group's "Agent" steps stand for, kept as the same array while they are the same objects. */
function useGroupAgents(blocks: Block[], agents: Agent[]): Map<string, Agent[]> {
  const prev = useRef(new Map<string, Agent[]>());
  return useMemo(() => {
    const next = new Map<string, Agent[]>();
    for (const b of blocks) {
      if (b.type !== "steps") continue;
      // In the session's order, so `agentOf` over this subset finds what it finds over all of them.
      const hit = new Set(b.items.filter((i) => i.a.kind === "agent").map((i) => agentOf(i.a, agents)));
      const list = hit.size ? agents.filter((g) => hit.has(g)) : NO_AGENTS;
      const old = prev.current.get(b.key);
      next.set(b.key, old && old.length === list.length && old.every((g, i) => g === list[i]) ? old : list);
    }
    prev.current = next;
    return next;
  }, [blocks, agents]);
}
const NO_AGENTS: Agent[] = [];

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
  countRender("Activity.Timeline");
  const earlier = useEarlier(session);
  const list = useMemo(() => (earlier.entries.length ? [...earlier.entries, ...session.activity] : session.activity), [earlier.entries, session.activity]);
  const blocks = useBlocks(list);
  const groupAgents = useGroupAgents(blocks, session.agents);
  const initial = useRef<Set<string> | null>(null);
  if (initial.current === null) initial.current = new Set(blocks.map((b) => b.key));
  const scroller = useRef<HTMLDivElement>(null);
  const keys = useMemo(() => blocks.map((b) => b.key), [blocks]);
  // A subagent card asked for (sidebar, header chip, Agents panel) is drawn wherever it is, and brought near.
  const focus = useStore((st) => st.agentFocus);
  const focusId = focus && Date.now() - focus.at < FOCUS_FRESH_MS ? focus.id : null;
  const focusKey = useMemo(() => (focusId ? (blocks.find((b) => groupAgents.get(b.key)?.some((g) => g.id === focusId))?.key ?? null) : null), [blocks, groupAgents, focusId]);
  const must = useMemo(() => (focusKey ? [focusKey] : NO_KEYS), [focusKey]);
  useEffect(() => {
    if (focusKey) bringNear(scroller.current, focusKey, stick);
  }, [focusKey]);
  const stick = useRef(true);
  // Rotating to portrait (or back) keeps a reader's place (lib/layoutAnchor.ts).
  useKeepReadingPlace(scroller, stick);
  const win = useRef<WindowApi | null>(null);
  const seenPrompt = useRef<string | null>(null);
  const lastKey = useRef<string | null>(null);
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);
  const [fresh, setFresh] = useState(false);
  const busy = session.status === "busy";
  const thinking = busy && (isThinking(session.current) || !session.current || blocks[blocks.length - 1]?.type !== "steps");
  const given = live ?? liveTime(undefined, session.updated, session.activity);
  // The same object while the values are, so blocks that take it can skip re-rendering.
  const lt = useMemo(() => ({ at: given.at, approx: given.approx }), [given.at, given.approx]);
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
    const tailSig = `${newest?.key}|${session.activity.length}|${thinking}`;
    const promptArrived = newest?.type === "prompt" && !initial.current!.has(newest.key) && seenPrompt.current !== newest.key;
    if (promptArrived) {
      seenPrompt.current = newest.key;
      stick.current = true;
    }
    if (stick.current) {
      setAway(false);
      setFresh(false);
      const smooth = initial.current!.size !== blocks.length && !reducedMotion();
      if (smooth) win.current?.hold(700);
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    } else if (tailSig !== lastKey.current) setFresh(true);
    // Earlier history added at the top is not news below: only a change at the end is.
    lastKey.current = tailSig;
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
      data-activity-timeline
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
      <div className={cx("mx-auto flex max-w-[700px] flex-col pb-[40px] pt-6", compact ? "gap-3 px-4" : "gap-4 px-8")}>
        <EarlierBar e={earlier} scroller={scroller} stick={stick} />
        <KeepScope.Provider value={`session:${sessionKey(session)}`}>
          <Windowed
            scroller={scroller}
            stick={stick}
            keys={keys}
            gap={compact ? 12 : 16}
            must={must}
            api={win}
            follow={false}
            className={cx("flex flex-col", compact ? "gap-3" : "gap-4")}
            estimate={(i) => activityHeight(blocks[i], i >= blocks.length - 2)}
            renderRow={(i, fresh) => {
              const b = blocks[i];
              const last = i === blocks.length - 1;
              const active = b.type === "steps" && busy && last && !thinking;
              const agents = groupAgents.get(b.key) ?? NO_AGENTS;
              return (
                <TimelineBlock
                  b={b}
                  fresh={fresh}
                  cv={!last && i < blocks.length - 6}
                  active={active}
                  latest={last || i >= blocks.length - 2}
                  agents={agents}
                  // Only a group with something running shows live time; the rest skip re-rendering as it moves.
                  live={active || agents.some((g) => !g.finished) ? lt : STILL}
                />
              );
            }}
          />
        </KeepScope.Provider>
        {!busy && turn.startMs !== null && turn.endMs !== null && turn.endMs > turn.startMs && blocks[blocks.length - 1]?.type !== "prompt" && (
          <div className="-mt-1 flex items-center gap-1.5 px-1 text-small text-faint" data-turn-end="done" title={turn.approxStart ? "since the earliest step shown" : undefined}>
            <ICheck size={13} />
            <span className="font-medium text-dim">
              Worked for <span className="tnum">{fmtElapsed(turn.endMs - turn.startMs)}</span>
            </span>
            {turn.tools > 0 && <span>· {turn.tools} tool {turn.tools === 1 ? "use" : "uses"}</span>}
            {!!session.tokens.turn_output && <TokenCount n={session.tokens.turn_output} className="text-small text-faint" />}
            {session.model && <span>· {modelLabel(session.model)}</span>}
          </div>
        )}
        <AnimatePresence>
          {busy && (
            <motion.div key="thinking" initial={enter} animate={shown} exit={{ opacity: 0, transition: { duration: 0.15 } }} transition={{ duration: 0.3, ease }}>
              <LiveIndicator since={lt.approx ? null : lt.at} mood={agentsRunning > 0 && !session.current ? "delegate" : now.mood} detail={now.detail} agents={agentsRunning} jobs={liveJobs(session)} mainActive={mainActive} timerSince={turn.startMs} tokens={session.tokens.turn_output} timerTitle={turn.approxStart ? "since the earliest step shown" : undefined} />
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
          // Smooth only through rows that are drawn (the last one is): from further up it is a jump.
          const glide = !reducedMotion() && !!keys.length && !!win.current?.drawn(keys[keys.length - 1]);
          if (glide) win.current?.hold(900);
          scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: glide ? "smooth" : "auto" });
        }}
      />
    </div>
    </div>
  );
}

/** Entries a listed session's timeline keeps, its newest (crates/core `MAX_ACTIVITY`): a longer one has earlier history. */
export const TIMELINE_CAP = 300;

type Earlier = { key: string; entries: Activity[]; start: number | null; loading: boolean; failed: boolean };

/**
 * A long session's earlier history: the listed timeline holds only its newest entries; the rest are read from the
 * transcript on request (`history_earlier`), a few hundred at a time, and go above them.
 */
function useEarlier(session: Session) {
  const key = sessionKey(session);
  const [st, setSt] = useState<Earlier>({ key, entries: [], start: null, loading: false, failed: false });
  const cur: Earlier = st.key === key ? st : { key, entries: [], start: null, loading: false, failed: false };
  if (st.key !== key) setSt(cur);
  const capped = session.activity.length >= TIMELINE_CAP && !!session.id;
  const more = capped && !cur.failed && (cur.start === null || cur.start > 0);
  const busy = useRef(false);
  const load = () => {
    if (busy.current || !more) return;
    busy.current = true;
    setSt((s) => ({ ...s, loading: true }));
    const first = session.activity[0];
    api()
      .historyEarlier({
        provider: session.provider,
        sessionId: session.id,
        keep: session.activity.length,
        before: cur.start,
        first: cur.start === null && first ? { ts: first.ts, kind: first.kind, text: first.text } : null,
        limit: 400,
      })
      .then((r) => setSt((s) => (s.key !== key ? s : { ...s, entries: [...r.entries, ...s.entries], start: r.start, loading: false })))
      .catch(() => setSt((s) => ({ ...s, loading: false, failed: true })))
      .finally(() => (busy.current = false));
  };
  return { entries: cur.entries, start: cur.start, loading: cur.loading, capped, more, load };
}

/** Above a long timeline: its earlier history, loaded when the reader scrolls up to it (or clicks), then "the start". */
function EarlierBar({ e, scroller, stick }: { e: ReturnType<typeof useEarlier>; scroller: React.RefObject<HTMLDivElement | null>; stick: { current: boolean } }) {
  const ref = useRef<HTMLButtonElement>(null);
  const load = useRef(e.load);
  load.current = e.load;
  useEffect(() => {
    const el = ref.current;
    if (!el || !e.more) return;
    // Only once the reader has scrolled up (a timeline opens at its end).
    const io = new IntersectionObserver((ents) => ents.some((x) => x.isIntersecting) && !stick.current && load.current(), { root: scroller.current, rootMargin: "400px 0px 0px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [e.more, e.entries.length, scroller, stick]);
  if (!e.capped) return null;
  if (!e.more) {
    return (
      <div className="flex items-center justify-center gap-2 py-1 text-small text-faint" data-earlier="start">
        {e.start === 0 ? "The start of this session" : null}
      </div>
    );
  }
  return (
    <button
      ref={ref}
      type="button"
      onClick={e.load}
      disabled={e.loading}
      data-earlier="more"
      className="mx-auto flex h-[30px] items-center gap-1.5 rounded-[9px] px-3 text-small text-dim transition-colors duration-150 hover:bg-hover hover:text-fg"
    >
      {e.loading ? "Loading earlier history…" : e.start ? `Show earlier history (${e.start.toLocaleString()} more steps)` : "Show earlier history"}
    </button>
  );
}

const STILL: LiveTime = { at: 0, approx: true };
const NO_KEYS: string[] = [];

/** A block's height before it has been drawn (Windowed's estimate; measured once drawn). */
function activityHeight(b: Block, latest: boolean): number {
  if (b.type === "steps") return 30 + (latest || b.items.length <= 2 ? b.items.length * 30 : 0);
  if (b.type === "artifact") return 120;
  const t = b.a.full ?? b.a.text;
  if (b.type === "prompt") return 70 + Math.ceil(t.length / 70) * 24;
  if (b.type === "error") return 32;
  return 30 + Math.ceil(t.length / 80) * 26;
}

/** One block of the timeline; memoised, so a payload re-renders only the blocks it changed (see `useBlocks`). */
const TimelineBlock = memo(function TimelineBlock({
  b,
  fresh,
  cv,
  active,
  latest,
  agents,
  live,
}: {
  b: Block;
  fresh: boolean;
  cv: boolean;
  active: boolean;
  latest: boolean;
  agents: Agent[];
  live: LiveTime;
}) {
  countRender("Activity.Block");
  return (
    // A row arriving fades and rises in (`.row-in`, a CSS one-off on the compositor, not a script animation per frame).
    <div className={cx(cv && "cv-auto", fresh && "row-in")}>
      {b.type === "prompt" && <PromptBlock a={b.a} />}
      {b.type === "text" && <ActivityText a={b.a} />}
      {b.type === "error" && <ErrorBlock a={b.a} />}
      {b.type === "steps" && <StepGroup items={b.items} agents={agents} active={active} latest={latest} live={live} />}
      {b.type === "artifact" && <ArtifactCard info={b.info} versions={b.versions} />}
    </div>
  );
});

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
          {b.type === "artifact" && <ArtifactCard info={b.info} versions={b.versions} />}
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
  return <PromptBubble text={bodyOf(a)} stamp={a.ts} shortened={shortenedOf(a)} attachments={a.attachments} scope={`h:${a.ts}:${a.text.slice(0, 24)}`} />;
}

/** `unsent`: shown as sent but it never reached the agent (the chat couldn't be opened): drawn dashed and dimmed. */
export function PromptBubble({ text, stamp, shortened, unsent, attachments, scope }: { text: string; stamp?: string; shortened?: boolean; unsent?: boolean; attachments?: Attachment[]; scope?: string }) {
  return (
    <div className="flex flex-col items-end gap-1 pt-1" data-prompt-unsent={unsent || undefined}>
      {!!attachments?.length && <MessageAttachments atts={attachments} scope={scope ?? stamp ?? ""} />}
      {(text.trim() || !attachments?.length) && <div
        className={cx(
          "selectable max-w-[86%] whitespace-pre-wrap break-words rounded-[18px] rounded-br-[6px] border px-4 py-3 text-prose",
          unsent ? "border-dashed border-line bg-transparent text-dim" : "border-hairline bg-raised text-fg shadow-card",
        )}
      >
        {text}
        {shortened && <div className="mt-1 text-small text-faint">… shortened</div>}
      </div>}
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
  tokens,
}: {
  since: number | null;
  /** Output tokens of the turn, shown left of the timer. */
  tokens?: number;
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
  // Same shimmer as the subagent strips: the default tone (a near-full-text base hid the sweep in the large row).
  const label = given ? (
    <Shimmer style={{ ["--shimmer-hi" as string]: "var(--text)" }}>{given}</Shimmer>
  ) : (
    <ThinkingWord seed={seed} origin={exact ? since : null} words={m.words} cycle={exact} />
  );
  const dots = <ThinkingDots />;
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
      <div className="live-layer flex items-center gap-2.5 pb-1 pt-2.5 text-base" data-live-row data-mood={mood}>
        <span className="flex size-[20px] shrink-0 items-center justify-center">
          <MoodGlyph mood={mood} size={16} live={live} className="text-dim" />
        </span>
        <span className="inline-flex shrink-0 font-medium">
          {label}
          {dots}
        </span>
        {detail && <span className="selectable min-w-0 flex-1 truncate font-mono text-mono-small text-dim">{shortDetail(detail)}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2 pr-2 text-small text-dim">
          <TokenCount n={tokens} />
          <LiveClock since={timerSince !== undefined ? timerSince : exact ? since : null} title={timerTitle} />
        </span>
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
  tokens,
}: {
  since: number | null;
  tokens?: number;
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
  const parts = [agents > 0 && `${agents} ${agents === 1 ? "agent" : "agents"}`, jobs > 0 && `${jobs} ${jobs === 1 ? "job" : "jobs"}`].filter(Boolean) as string[];
  const still = reducedMotion();
  // Thinking <-> "N agents running" hand over instead of cutting: the old row lifts and fades out while the new one
  // settles in from just below (the timer sits in the same spot in both, so the eye stays on it).
  return (
    <div className="relative">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={quiet ? "quiet" : "think"}
          initial={still ? false : { opacity: 0, y: 7, filter: "blur(2px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={still ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -7, filter: "blur(2px)" }}
          transition={{ duration: 0.32, ease }}
        >
          {quiet ? (
            <div className="flex items-center gap-2.5 pb-1 pt-2.5 text-small text-dim" data-live-quiet>
              <span className="flex size-[20px] shrink-0 items-center justify-center">
                <span className="size-[7px] rounded-full bg-running" />
              </span>
              <span className="flex items-baseline whitespace-pre">
                {parts.map((p, i) => (
                  <motion.span key={i === 0 ? (agents > 0 ? "agents" : "jobs") : "jobs"} layout={still ? false : "position"} transition={{ duration: 0.28, ease }} className="flex items-baseline whitespace-pre">
                    {i > 0 && ", "}
                    <Roll text={p} still={still} />
                  </motion.span>
                ))}
                <motion.span layout={still ? false : "position"} transition={{ duration: 0.28, ease }} className="whitespace-pre">
                  {" running"}
                </motion.span>
              </span>
              {/* No token count here: the main agent is idle, so its count isn't moving; each job shows its own. */}
              <span className="ml-auto flex shrink-0 items-center gap-2 pr-2 text-small text-dim">
                <LiveClock since={timerSince !== undefined ? timerSince : since} title={timerTitle} />
              </span>
            </div>
          ) : (
            <ThinkingRow since={since} mood={mood} detail={detail} large timerSince={timerSince} timerTitle={timerTitle} tokens={tokens} />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/**
 * Text that rolls when it changes ("1 agent" -> "2 agents"): the old value slides up and out while the new one comes
 * in from below. Its width follows the new text (layout animation), so the words after it move along smoothly.
 */
function Roll({ text, still }: { text: string; still: boolean }) {
  return (
    <motion.span layout={still ? false : "position"} className="relative inline-flex overflow-hidden" transition={{ duration: 0.28, ease }}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={text}
          className="inline-block whitespace-pre"
          initial={still ? false : { y: "0.9em", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={still ? { opacity: 0, transition: { duration: 0 } } : { y: "-0.9em", opacity: 0 }}
          transition={{ duration: 0.28, ease }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </motion.span>
  );
}

function summarize(items: { a: Activity }[]): { name: string; n: number }[] {
  const m = new Map<string, number>();
  for (const { a } of items) {
    const n = a.kind === "agent" ? "Agent" : groupOf(splitTool(a.text).name);
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
  countRender("Activity.StepGroup");
  const [open, setOpen] = useKept<boolean | null>(`steps:${items[0].key}`, null);
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
          <Shimmer className="font-medium">{`Running ${items.length === 1 ? "a step" : `${items.length} steps`}`}</Shimmer>
        ) : (
          <span className="font-medium text-dim group-hover:text-fg/85">Ran {items.length === 1 ? "1 step" : `${items.length} steps`}</span>
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {chips.map((c) => (
            <span key={c.name} className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[6px] bg-[color-mix(in_oklab,var(--dim)_11%,transparent)] px-1.5 text-small font-medium text-dim">
              {c.name}
              {c.n > 1 && <span className="tnum text-faint">×{c.n}</span>}
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
  const r = toolRowFromText(a.text);
  return <StepLine name={r.label} tool={r.raw} detail={r.detail} active={active} dense={dense} fresh={fresh} stamp={a.ts} since={live.at} approx={live.approx} />;
}

/** One step: icon (or spinner), tool name, mono detail, timer or timestamp. Shared by Activity and Chat. */
export function StepLine({
  name,
  detail,
  active,
  stamp,
  since,
  approx,
  failed: failedIn,
  stopped,
  waiting,
  fresh,
  onClick,
  open,
  dense,
  tool,
  soft,
}: {
  /** What the row says (lib/toolNames.ts): "Opened", "Bash". */
  name: string;
  /** The tool's own name, for the icon, the glyph and the tooltip, when `name` is a phrase. */
  tool?: string;
  /** Failed, but nothing to act on (a wait that timed out): neutral grey, never red. */
  soft?: boolean;
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
  const Icon = toolIcon(tool ?? name);
  const failed = failedIn && !soft;
  return (
    <div
      onClick={onClick}
      className={cx(
        "group relative flex items-center gap-2.5 rounded-[7px] pr-2",
        "h-[28px]",
        active && !waiting && "sweep live-layer",
        onClick && "hover:bg-hover",
        open && "bg-hover",
      )}
      style={active ? { ["--sweep" as string]: "var(--status-running)" } : undefined}
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
          <MoodGlyph mood={toolMood(tool ?? name)} size={13} />
        ) : (
          <Icon size={12} />
        )}
      </span>
      <span
        className={cx("max-w-[78%] shrink-0 truncate text-base font-medium", waiting ? "text-fg/85" : failed && !stopped ? "text-err-text/90" : stopped || soft ? "text-dim" : !active && "text-fg/80")}
        title={tool && tool !== name ? tool : undefined}
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
/** "quiet": no end on record and no sign of life for long (lib/agentState.ts); `reason` says for how long. */
export type AgentEnd = "done" | "failed" | "stopped" | "quiet";
export function agentResultParts(uses: number, ms: number | null, tokens = 0): string[] {
  return [uses > 0 && `${uses} tool ${uses === 1 ? "use" : "uses"}`, tokens > 0 && `↓ ${fmtTokens(tokens)} tokens`, ms !== null && ms > 0 && fmtElapsed(ms)].filter(Boolean) as string[];
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
  const label = end === "failed" ? "Failed" : end === "stopped" ? "Stopped" : end === "quiet" ? reason || "No activity" : "Done";
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-[7px] text-left transition-colors duration-150 hover:bg-hover" data-agent-result={end} title={reason || undefined}>
      <span className="flex size-[14px] shrink-0 items-center justify-center">
        {end === "failed" ? <IAlert size={13} className="text-err-text" /> : end === "stopped" || end === "quiet" ? <span className="size-[7px] rounded-full bg-faint" /> : <ICheck size={13} className="text-faint" />}
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
  const recorded = agent ? agentEnd(agent) : null;
  const reason = recorded?.error ?? (failedEnd ? (last.full ?? last.text) : null);
  // As its session recorded the end (stopped, failed, quiet), else from its own last entry.
  const end: AgentEnd = recorded ? (recorded.quiet ? "quiet" : recorded.stopped ? "stopped" : "failed") : failedEnd ? (isStopReason(reason) ? "stopped" : "failed") : "done";
  const t0 = all.length ? tsToMs(all[0].ts) : null;
  const t1 = last ? tsToMs(last.ts) : null;
  const parts = agentResultParts(all.filter((x) => x.kind === "tool" || x.kind === "agent").length, t0 !== null && t1 !== null ? t1 - t0 : null, agent?.tokens.total || agent?.tokens.output || 0);
  const [open, toggle] = useFold(`agent:${agent?.id ?? a.text}`, !running, card);
  useEffect(() => {
    if (asked && !open) toggle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);
  const title = detail || agent?.description || "Subagent";
  const fill = agent ? agentFill(agent.tokens.total, agent.model || agent.models?.[0]?.model) : null;
  const handed = all.find((x) => x.kind === "prompt");
  const handoff = handed ? handoffLine(handed.full ?? handed.text, title) : null;
  const extra = (fill || handoff) && (
    <div className="flex flex-col gap-1 px-3 pb-1.5" data-agent-extra>
      {fill && <FillBar fill={fill} running={running} />}
      {handoff && <Handoff text={handoff} full={handed?.full ?? handed?.text} />}
    </div>
  );
  return (
    <div className="flex gap-2.5 py-1">
      <span className="relative z-[1] mt-[7px] flex size-[18px] shrink-0 items-center justify-center rounded-full bg-bg text-dim">
        <AgentMark size={14} state={running ? "live" : end === "quiet" ? "stopped" : end} />
      </span>
      <div
        ref={card}
        data-agent-card={agent?.id}
        data-open={open}
        className={cx(
          "min-w-0 flex-1 overflow-hidden rounded-[10px] border bg-raised shadow-card transition-[border-color] duration-500",
          focused ? "border-[color-mix(in_oklab,var(--status-needs)_45%,var(--border))]" : "border-hairline",
        )}
      >
        {running ? (
          <div role="button" tabIndex={0} onClick={toggle} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())} className="flex cursor-default items-center gap-2 px-3 pt-2 pb-1.5">
            <span className="rounded-[6px] bg-[color-mix(in_oklab,var(--accent-2)_14%,transparent)] px-1.5 text-small font-medium text-dim">
              {agent?.kind || "subagent"}
            </span>
            <span className="min-w-0 flex-1 truncate text-base font-medium text-fg">{title}</span>
            {agent && <AgentModels agent={agent} />}
            <TokenCount n={agent?.tokens.total || agent?.tokens.output} total={!!agent?.tokens.total} what="by this agent" className="shrink-0 text-small text-dim" />
            <span className="size-[7px] shrink-0 rounded-full bg-running" />
            <FoldChevron open={open} />
          </div>
        ) : (
          <FinishedAgentHead end={end} title={title} parts={parts} reason={reason} open={open} onToggle={toggle} />
        )}
        {running && extra}
        <FoldBody open={open}>
          {!running && (
            <div className="flex items-center gap-2 px-3 pb-1">
              <span className="rounded-[6px] bg-[color-mix(in_oklab,var(--accent-2)_14%,transparent)] px-1.5 text-small font-medium text-dim">{agent?.kind || "subagent"}</span>
              {agent && <AgentModels agent={agent} />}
              {reason && <span className={cx("min-w-0 flex-1 truncate text-small", end === "failed" ? "text-err-text/90" : "text-dim")} title={reason}>{reason}</span>}
            </div>
          )}
          {!running && extra}
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
  const [open, setOpen] = useKept(`error:${a.ts}|${a.text.slice(0, 60)}`, false);
  const body = bodyOf(a);
  if (a.step) {
    const stopped = isStopReason(a.full ?? a.text);
    return (
      <button
        type="button"
        onClick={() => setOpen(!open)}
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
