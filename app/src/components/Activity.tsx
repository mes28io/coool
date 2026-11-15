import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Activity, Agent, Session } from "../lib/types";
import { fmtElapsed, homeShort, isThinking, shortDetail, splitTool, tsToMs } from "../lib/format";
import type { Since } from "../store";
import { IAlert, IChevron, ICheck, ISpark, toolIcon } from "./icons";
import { Elapsed, cx, ease, StatusDot } from "./primitives";
import { ModelTag } from "./Models";
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
export const liveTime = (since: Since | undefined, fallback: number): LiveTime =>
  since ? { at: since.currentAt, approx: !since.currentObserved } : { at: fallback, approx: true };

export function Timeline({ session, compact, live }: { session: Session; compact?: boolean; live?: LiveTime }) {
  const blocks = useMemo(() => buildBlocks(session.activity), [session.activity]);
  const initial = useRef<Set<string> | null>(null);
  if (initial.current === null) initial.current = new Set(blocks.map((b) => b.key));
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const busy = session.status === "busy";
  const thinking = busy && (isThinking(session.current) || !session.current || blocks[blocks.length - 1]?.type !== "steps");
  // Never time live work from HH:MM:SS activity stamps (wrong across a long think, and UTC-ish).
  const lt = live ?? { at: session.updated, approx: true };

  // Stay pinned to the bottom while the user is there; leave them alone once they scroll up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: initial.current!.size === blocks.length ? "auto" : "smooth" });
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
    <div
      ref={scroller}
      className="scroll h-full"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className={cx("mx-auto flex max-w-[700px] flex-col pb-10 pt-6", compact ? "gap-3 px-4" : "gap-4 px-8")}>
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
                <div className="selectable text-prose text-fg/90">
                  <Prose text={b.a.text} />
                </div>
              )}
              {b.type === "error" && (
                <div className="flex items-start gap-2 rounded-[8px] px-2.5 py-1.5 text-base text-err-text bg-[color-mix(in_oklab,var(--error)_7%,transparent)]">
                  <IAlert size={16} className="mt-[2px] shrink-0" />
                  <span className="selectable min-w-0 break-words">{b.a.text}</span>
                </div>
              )}
              {b.type === "steps" && (
                <StepGroup items={b.items} agents={session.agents} active={busy && last && !thinking} latest={last || i >= blocks.length - 2} live={lt} />
              )}
            </motion.div>
          );
        })}
        <AnimatePresence>
          {thinking && (
            <motion.div key="thinking" initial={enter} animate={shown} exit={{ opacity: 0, transition: { duration: 0.15 } }} transition={{ duration: 0.3, ease }}>
              <ThinkingRow since={lt.at} approx={lt.approx} />
            </motion.div>
          )}
        </AnimatePresence>
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
            <div className="selectable text-prose text-fg/90">
              <Prose text={b.a.text} />
            </div>
          )}
          {b.type === "error" && (
            <div className="flex items-start gap-2 rounded-[8px] bg-[color-mix(in_oklab,var(--error)_7%,transparent)] px-2.5 py-1.5 text-base text-err-text">
              <IAlert size={16} className="mt-[2px] shrink-0" />
              <span className="selectable min-w-0 break-words">{b.a.text}</span>
            </div>
          )}
          {b.type === "steps" && <StepGroup items={b.items} agents={[]} active={false} latest={false} live={STILL} />}
        </div>
      ))}
    </div>
  );
}

function PromptBlock({ a }: { a: Activity }) {
  return <PromptBubble text={a.text} stamp={a.ts} />;
}

export function PromptBubble({ text, stamp }: { text: string; stamp?: string }) {
  return (
    <div className="flex flex-col items-end gap-1 pt-1">
      <div className="selectable max-w-[86%] whitespace-pre-wrap break-words rounded-[18px] rounded-br-[6px] border border-hairline bg-raised px-4 py-3 text-prose text-fg shadow-card">
        {text}
      </div>
      {stamp && <span className="pr-1 font-mono text-mono-small text-faint tnum">{stamp}</span>}
    </div>
  );
}

export function ThinkingRow({ since, approx, label = "Thinking" }: { since: number | null; approx?: boolean; label?: string }) {
  return (
    <div className="flex items-center gap-2.5 py-1 text-base">
      <span className="relative flex size-[22px] items-center justify-center">
        <ISpark size={16} className="text-dim breathe" />
      </span>
      <span className="shimmer font-medium" style={{ ["--shimmer-hi" as string]: "var(--text)" }}>
        {label}
      </span>
      <Elapsed since={since} approx={approx} className="text-small text-faint" />
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
  const isOpen = open ?? (latest || items.length <= 2);
  const mountKeys = useRef(new Set(items.map((i) => i.key)));
  const opened = useRef(isOpen);
  const chips = summarize(items);
  const first = tsToMs(items[0].a.ts);
  const lastT = tsToMs(items[items.length - 1].a.ts);
  const span = first !== null && lastT !== null ? lastT - first : 0;

  return (
    <div className="rounded-[10px]">
      <button
        type="button"
        onClick={() => {
          opened.current = false;
          setOpen(!isOpen);
        }}
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
            transition={{ duration: 0.24, ease }}
            className="overflow-hidden"
          >
            <ol className="relative ml-[9px] mt-1 border-l border-hairline pb-1 pl-3">
              {items.map((it, i) => {
                const isActive = active && i === items.length - 1;
                const fresh = !mountKeys.current.has(it.key);
                const delay = !fresh && opened.current ? Math.min(i, 14) * 0.035 : 0;
                return (
                  <motion.li
                    key={it.key}
                    initial={fresh || opened.current ? { opacity: 0, y: 6 } : false}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.26, ease, delay }}
                  >
                    {it.a.kind === "agent" ? (
                      <AgentStep a={it.a} agents={agents} active={isActive} live={live} />
                    ) : (
                      <StepRow a={it.a} active={isActive} live={live} />
                    )}
                  </motion.li>
                );
              })}
            </ol>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

function StepRow({ a, active, dense, live }: { a: Activity; active: boolean; dense?: boolean; live: LiveTime }) {
  const { name, detail } = splitTool(a.text);
  return <StepLine name={name} detail={detail} active={active} dense={dense} stamp={a.ts} since={live.at} approx={live.approx} />;
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
  waiting,
  onClick,
  open,
}: {
  name: string;
  detail: string;
  active: boolean;
  dense?: boolean;
  stamp?: string;
  since?: number | null;
  approx?: boolean;
  failed?: boolean;
  waiting?: boolean;
  onClick?: () => void;
  open?: boolean;
}) {
  const Icon = toolIcon(name);
    return (
    <div
      onClick={onClick}
      className={cx(
        "group relative -ml-[19px] flex items-center gap-2.5 rounded-[7px] pr-2",
        "h-[28px]",
        active && !waiting && "sweep",
        onClick && "hover:bg-hover",
        open && "bg-hover",
      )}
      style={active ? { ["--sweep" as string]: "var(--status-working)" } : undefined}
    >
      <span
        className={cx(
          "relative z-[1] flex size-[18px] shrink-0 items-center justify-center rounded-full bg-bg",
          waiting ? "text-needs-text" : active ? "text-working-text" : failed ? "text-err-text" : "text-faint",
        )}
      >
        {waiting ? (
          <span className="size-[7px] rounded-full bg-needs breathe" />
        ) : active ? (
          <svg width="13" height="13" viewBox="0 0 16 16" className="spin">
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
            <path d="M8 2a6 6 0 016 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        ) : failed ? (
          <IAlert size={14} />
        ) : (
          <Icon size={12} />
        )}
      </span>
      <span
        className={cx("shrink-0 text-base font-medium", active && !waiting ? "shimmer" : waiting ? "text-fg/85" : failed ? "text-err-text/90" : "text-fg/80")}
        style={active && !waiting ? { ["--shimmer-base" as string]: "var(--text)", ["--shimmer-hi" as string]: "var(--dim)" } : undefined}
      >
        {name}
      </span>
      {detail && (
        <span className={cx("selectable min-w-0 flex-1 truncate font-mono text-mono-small", failed ? "text-err-text/70 line-through decoration-err/40" : "text-dim")} title={failed ? detail : undefined}>
          {/* A struck-through path is read at a glance: short, like the rest of the timeline. */}
          {failed ? shortDetail(homeShort(detail)) : detail}
        </span>
      )}
      {!detail && <span className="flex-1" />}
      {waiting ? (
        <span className="shrink-0 text-small text-needs-text">waiting for you</span>
      ) : active ? (
        <Elapsed since={since ?? null} approx={approx} className="shrink-0 text-small text-faint" />
      ) : (
        stamp && <span className="shrink-0 font-mono text-mono-small text-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100 tnum">{stamp}</span>
      )}
    </div>
  );
}

function AgentStep({ a, agents, active, live }: { a: Activity; agents: Agent[]; active: boolean; live: LiveTime }) {
  const { detail } = splitTool(a.text);
  const agent = agents.find((g) => g.description && (g.description === detail || detail.startsWith(g.description))) ?? null;
  const running = agent ? !agent.finished : active;
  const steps = agent?.activity.filter((x) => x.kind === "tool" || x.kind === "agent").slice(-5) ?? [];
  return (
    <div className="-ml-[19px] flex gap-2.5 py-1">
      <span className="relative z-[1] mt-[7px] flex size-[18px] shrink-0 items-center justify-center rounded-full bg-bg text-dim">
        <ISpark size={14} />
      </span>
      <div
        className={cx(
          "min-w-0 flex-1 overflow-hidden rounded-[10px] border bg-raised shadow-card",
          "border-hairline",
        )}
      >
        <div className="flex items-center gap-2 px-3 pt-2 pb-1.5">
          <span className="rounded-[6px] bg-[color-mix(in_oklab,var(--accent-2)_14%,transparent)] px-1.5 text-small font-medium text-dim">
            {agent?.kind || "subagent"}
          </span>
          <span className="min-w-0 flex-1 truncate text-base font-medium text-fg">{detail || agent?.description}</span>
          {agent && <AgentModels agent={agent} />}
          {running ? (
            <StatusDot status="busy" size={7} />
          ) : (
            <span className="flex items-center gap-1 text-small text-dim">
              <ICheck size={14} className="text-faint" /> done
            </span>
          )}
        </div>
        {steps.length > 0 && (
          <ol className="relative ml-[21px] border-l border-hairline pb-1.5 pl-3">
            <AnimatePresence initial={false}>
              {steps.map((s, i) => (
                <motion.li key={`${s.ts}${s.text}`} layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease }}>
                  <StepRow a={s} active={running && i === steps.length - 1} dense live={live} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
        )}
        {running && steps.length === 0 && (
          <div className="px-3 pb-2">
            <ThinkingRow since={live.at} approx={live.approx} label="Starting" />
          </div>
        )}
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
