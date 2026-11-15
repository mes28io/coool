// The Checkpoints card: one row per completed turn of a chat, on a rail that forks
// into a new branch when a failed turn is retried. Pinned at the top of the chat
// timeline, collapsed to its header line by default. Rows are a fixed 28px tall, so
// the rail geometry is computed rather than measured and the card grows by a plain
// height animation (the new row is revealed by the growing clip).

import { motion } from "motion/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Chat } from "../lib/chat";
import { chatTitle } from "../lib/chat";
import type { Checkpoint, Checkpoints as Derived } from "../lib/checkpoints";
import { IAlert, IBranch, IChevron, IFolder, ISpark, toolIcon } from "./icons";
import { cx, ease } from "./primitives";
import { DOT, RAIL, Reveal, reducedMotion } from "./StepRail";

const ROW = 28;
const PT = 2;
const PB = 6;
const X0 = 16; // rail x of the first branch
const STEP = 12; // rail x step per branch
const MAX_ROWS = 8;

/** Expanded state per chat, for this app run. */
const remembered = new Map<number, boolean>();

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

/** A number that rolls in when it changes. */
function Tick({ v }: { v: number | string }) {
  return (
    <span className="inline-flex h-[18px] overflow-hidden align-bottom">
      <motion.span key={v} initial={{ y: 9, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.26, ease }} className="inline-block">
        {v}
      </motion.span>
    </span>
  );
}

interface Edge {
  key: string;
  d: string;
}

/** Rail paths between rows: straight down a branch, a curve out to the right where one forks. */
function edgesOf(list: Checkpoint[]): Edge[] {
  const x = (d: number) => X0 + d * STEP;
  const y = (i: number) => PT + i * ROW + ROW / 2;
  const out: Edge[] = [];
  for (let i = 1; i < list.length; i++) {
    const c = list[i];
    if (c.branchStart) {
      // Forks from the checkpoint before the abandoned one (or from the abandoned one itself when it was first).
      const p = i >= 2 ? i - 2 : i - 1;
      const [xs, xe, ys] = [x(list[p].depth), x(c.depth), y(p)];
      out.push({ key: `${list[p].key}>${c.key}`, d: `M${xs} ${ys}C${xs} ${ys + 14},${xe} ${ys + 8},${xe} ${ys + 22}L${xe} ${y(i)}` });
      if (p === i - 2) out.push({ key: `${list[p].key}>${list[i - 1].key}`, d: `M${xs} ${ys}L${xs} ${y(i - 1)}` });
    } else out.push({ key: `${list[i - 1].key}>${c.key}`, d: `M${x(c.depth)} ${y(i - 1)}L${x(c.depth)} ${y(i)}` });
  }
  return out;
}

export function CheckpointsCard({ chat, cps, onJump, onFiles }: { chat: Chat; cps: Derived; onJump: (key: string) => void; onFiles: (key: string) => void }) {
  const { list, attempts } = cps;
  const [open, setOpen] = useState(() => remembered.get(chat.id) ?? false);
  const toggle = () => {
    remembered.set(chat.id, !open);
    setOpen(!open);
  };
  const live = list.some((c) => c.live);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  // Rows and rail segments present on the first render are not "new".
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set([...list.map((c) => c.key), ...edgesOf(list).map((e) => e.key)]);
  const edges = useMemo(() => edgesOf(list), [list]);
  const fresh = new Set<string>();
  for (const k of [...list.map((c) => c.key), ...edges.map((e) => e.key)]) if (!seen.current.has(k)) fresh.add(k);
  useEffect(() => {
    for (const k of fresh) seen.current!.add(k);
  });

  const maxDepth = list.reduce((m, c) => Math.max(m, c.depth), 0);
  const left = X0 + 14 + maxDepth * STEP;
  const natural = list.length * ROW + PT + PB;
  const capped = natural > MAX_ROWS * ROW + PT + PB;
  const height = open ? Math.min(natural, MAX_ROWS * ROW + PT + PB) : 0;
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (open && capped && el) el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
  }, [list.length, open, capped]);

  const title = chatTitle(chat) ?? "";
  const width = X0 + 2 * STEP + 10;

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reducedMotion() ? 0 : 0.28, ease }}
      className={cx("relative overflow-hidden rounded-[14px] border border-hairline bg-raised shadow-card")}
      data-checkpoints={list.length}
    >
      <button type="button" onClick={toggle} aria-expanded={open} className="group flex h-[36px] w-full items-center gap-2 pl-3.5 pr-3 text-left text-base transition-colors duration-150 hover:bg-hover">
        <IBranch size={14} className="shrink-0 text-dim" />
        <span className="shrink-0 font-medium text-fg">Checkpoints</span>
        <span className="min-w-0 flex-1 truncate text-small text-dim">{title}</span>
        <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-small text-faint tnum">
          <span className="flex gap-[3px]">
            <Tick v={list.length} />
            {list.length === 1 ? "checkpoint" : "checkpoints"}
          </span>
          {attempts > 1 && (
            <>
              <span>·</span>
              <span className="flex gap-[3px]">
                <Tick v={attempts} />
                attempts
              </span>
            </>
          )}
        </span>
        <IChevron size={13} className={cx("shrink-0 text-faint transition-transform duration-200 group-hover:text-dim", open && "rotate-90")} />
      </button>
      <motion.div initial={false} animate={{ height }} transition={{ duration: reducedMotion() ? 0 : 0.32, ease }} className={cx(capped && open ? "scroll overflow-y-auto" : "overflow-hidden")} ref={scroller} inert={!open}>
        <div className="relative" style={{ height: natural, paddingTop: PT }}>
          <svg aria-hidden className="pointer-events-none absolute left-0 top-0" width={width} height={natural} fill="none">
            {edges.map((e) => (
              <motion.path
                key={e.key}
                d={e.d}
                stroke={RAIL}
                strokeWidth={1.25}
                strokeLinecap="round"
                initial={fresh.has(e.key) && !reducedMotion() ? { pathLength: 0 } : false}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.4, ease, delay: 0.1 }}
              />
            ))}
          </svg>
          {list.map((c, i) => (
            <Row key={c.key} c={c} last={i === list.length - 1} left={left} fresh={fresh.has(c.key)} now={now} onJump={onJump} onFiles={onFiles} />
          ))}
        </div>
      </motion.div>
    </motion.div>
  );
}

const Row = memo(function Row({ c, last, left, fresh, now, onJump, onFiles }: { c: Checkpoint; last: boolean; left: number; fresh: boolean; now: number; onJump: (key: string) => void; onFiles: (key: string) => void }) {
  const Icon = c.tool ? toolIcon(c.tool) : ISpark;
  const newest = last && !c.stub;
  const dim = c.stub;
  const elapsed = (c.endTs ?? now) - c.originTs;
  return (
    <button
      type="button"
      onClick={() => onJump(c.key)}
      className="group relative mx-1.5 flex h-[28px] items-center gap-2 rounded-[8px] pr-2 text-left text-base transition-[padding-left,background-color] duration-300 hover:bg-hover"
      style={{ width: "calc(100% - 12px)", paddingLeft: left - 6 }}
      title={c.label}
    >
      <span
        aria-hidden
        className={cx(
          "absolute z-[1] -translate-x-1/2 -translate-y-1/2 rounded-full transition-[width,height,background-color,border-color,left] duration-300",
          dim ? "size-[7px] border-[1.5px] bg-raised" : newest ? "size-[8px]" : "size-[5px]",
          newest && (c.live ? "bg-working" : "bg-fg"),
        )}
        style={{ left: X0 + c.depth * STEP - 6, top: 14, ...(dim ? { borderColor: DOT } : newest ? null : { background: DOT }) }}
      />
      <span className={cx("flex size-[18px] shrink-0 items-center justify-center", dim ? "text-faint/60" : "text-dim")}>{c.failed && dim ? <IAlert size={13} /> : <Icon size={13} />}</span>
      <span className={cx("min-w-0 truncate", dim ? "text-faint" : "text-fg")}>
        <Reveal text={c.label} fresh={fresh} />
      </span>
      {c.failed && <span className="shrink-0 rounded-[5px] bg-[color-mix(in_oklab,var(--error)_12%,transparent)] px-1.5 text-micro font-medium text-err-text">Failed</span>}
      {c.branchStart && <span className="shrink-0 rounded-[5px] bg-[color-mix(in_oklab,var(--dim)_12%,transparent)] px-1.5 text-micro font-medium text-dim">Attempt {c.attempt}</span>}
      <span className="flex-1" />
      {c.files > 0 && (
        <span
          role="button"
          title="Show these changes"
          onClick={(e) => {
            e.stopPropagation();
            onFiles(c.key);
          }}
          className={cx("-my-0.5 flex shrink-0 items-center gap-1 rounded-[6px] px-1 text-small tnum hover:bg-hover hover:text-fg", dim ? "text-faint/60" : "text-faint")}
        >
          <IFolder size={12} />
          <span className="flex gap-[3px]">
            <Tick v={c.files} />
            {c.files === 1 ? "file" : "files"}
          </span>
        </span>
      )}
      <span className={cx("w-[42px] shrink-0 text-right text-small tnum", dim ? "text-faint/60" : "text-faint")}>{clock(elapsed)}</span>
    </button>
  );
});
