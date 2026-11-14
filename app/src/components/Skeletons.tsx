// Loading placeholders. Each mirrors the real layout block for block (same
// heights, paddings and gaps), so swapping in content causes no layout shift.
// Motion: a slow, soft opacity pulse, slightly staggered; static under
// reduced motion. No sweeps here: the sweep/shimmer means "live work".

import { motion } from "motion/react";
import type { CSSProperties } from "react";
import { cx } from "./primitives";

let seq = 0;
/** One placeholder block. `i` staggers the pulse; widths read as content when varied. */
export function Skel({ w, h, r = 999, i, className, style }: { w?: number | string; h: number; r?: number; i?: number; className?: string; style?: CSSProperties }) {
  const n = i ?? seq++ % 9;
  return <span className={cx("skel block shrink-0", className)} style={{ width: w, height: h, borderRadius: r, animationDelay: `${(n % 9) * 0.14}s`, ...style }} />;
}

const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0, transition: { duration: 0.15 } }, transition: { duration: 0.3 } };

// ---------- sidebar ----------

/** Mirrors ProjectGroup > SessionRow / AgentRow. */
export function SidebarSkeleton({ groups = 4 }: { groups?: number }) {
  const plan: { name: number; rows: { t: number; s: number; agent?: boolean }[] }[] = [
    { name: 58, rows: [{ t: 150, s: 112 }, { t: 128, s: 84, agent: true }, { t: 170, s: 96 }] },
    { name: 44, rows: [{ t: 136, s: 118 }, { t: 160, s: 70 }] },
    { name: 66, rows: [{ t: 176, s: 100 }, { t: 120, s: 88, agent: true }] },
    { name: 38, rows: [{ t: 146, s: 64 }] },
  ];
  let k = 0;
  return (
    <motion.div {...fade} aria-label="Loading sessions">
      {plan.slice(0, groups).map((g, gi) => (
        <div key={gi} className="mb-1.5">
          <div className="flex h-[34px] items-center gap-1.5 pl-1.5 pr-1">
            <Skel w={8} h={8} r={2} i={k++} className="mx-[1.5px]" />
            <Skel w={g.name} h={12} i={k++} />
            <Skel w={28} h={20} i={k++} />
          </div>
          <div className="flex flex-col gap-px pt-px">
            {g.rows.map((r, ri) => (
              <div key={ri}>
                <div className="flex items-start gap-2 py-[5px] pl-[10px] pr-2">
                  <span className="flex h-[22px] w-[8px] items-center justify-center">
                    <Skel w={8} h={8} i={k} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex h-[22px] items-center gap-1.5">
                      <Skel w={13} h={13} i={k} />
                      <Skel w={r.t * 1.2} h={11} i={k++} />
                    </span>
                    <span className="flex h-[18px] items-center">
                      <Skel w={r.s * 1.2} h={9} i={k++} className="opacity-70" />
                    </span>
                  </span>
                </div>
                {r.agent && (
                  <div className="flex items-start gap-2 py-[5px] pl-[26px] pr-2">
                    <span className="mt-[3px] h-[12px] w-[9px] shrink-0 rounded-bl-[5px] border-b border-l border-line" />
                    <span className="flex flex-1 flex-col">
                      <span className="flex h-[18px] items-center gap-1.5">
                        <Skel w={6} h={6} i={k} />
                        <Skel w={(r.t - 30) * 1.2} h={9} i={k++} />
                      </span>
                      <span className="flex h-[18px] items-center">
                        <Skel w={(r.s - 10) * 1.2} h={8} i={k++} className="opacity-70" />
                      </span>
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </motion.div>
  );
}

// ---------- mission control ----------

/** Mirrors Card: header, title, current-activity bar, two activity lines, footer. */
export function CardSkeleton({ i = 0, label }: { i?: number; label?: string }) {
  const v = [
    [64, 210, 180, 230, 150],
    [52, 250, 140, 190, 210],
    [72, 180, 200, 160, 120],
  ][i % 3];
  const k = i * 3;
  return (
    <motion.div
      {...fade}
      layout
      className="flex h-[256px] flex-col rounded-[10px] border border-hairline bg-raised/60 p-3.5"
      aria-label={label ?? "Loading session"}
    >
      <div className="flex h-[24px] items-center gap-1.5">
        <Skel w={14} h={14} i={k} />
        <Skel w={v[0]} h={10} i={k} />
        <Skel w={80} h={24} i={k + 1} className="ml-auto" />
      </div>
      <div className="mt-2.5 flex h-[24px] items-center">
        <Skel w={v[1]} h={14} i={k + 1} />
      </div>
      <Skel h={36} r={8} i={k + 2} className="mt-2.5 w-full opacity-70" />
      <div className="mt-2.5 flex flex-1 flex-col gap-1">
        {[v[2], v[3]].map((w, j) => (
          <div key={j} className="flex h-[22px] items-center gap-1.5">
            <Skel w={14} h={11} r={3} i={k + 3 + j} />
            <Skel w={w} h={9} i={k + 3 + j} />
          </div>
        ))}
        {label && <span className="mt-auto text-small text-faint">{label}</span>}
      </div>
      <div className="mt-auto flex items-center gap-3 border-t border-hairline pt-2.5">
        <Skel w={56} h={4} i={k + 5} />
        <Skel w={30} h={9} i={k + 5} />
        <Skel w={40} h={9} i={k + 6} />
        <Skel w={v[4] / 2.4} h={9} i={k + 6} className="ml-auto" />
        <Skel w={30} h={22} r={5} i={k + 7} />
      </div>
    </motion.div>
  );
}

/** Mirrors the "Recently ended" list. */
export function RecentSkeleton({ rows = 4 }: { rows?: number }) {
  const ws = [190, 240, 160, 210, 180];
  return (
    <motion.section {...fade} className="mt-9" aria-label="Loading recent sessions">
      <div className="mb-2 flex h-[16px] items-center px-1">
        <Skel w={96} h={8} i={0} />
      </div>
      <div className="overflow-hidden rounded-[10px] border border-hairline">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className={cx("flex h-[44px] items-center gap-3 bg-raised/50 px-3.5", i > 0 && "border-t border-hairline")}>
            <Skel w={14} h={14} i={i} />
            <Skel w={ws[i % ws.length]} h={11} i={i} />
            <Skel w={52} h={8} i={i} className="opacity-70" />
            <Skel w={40} h={8} i={i + 1} className="ml-auto opacity-70" />
          </div>
        ))}
      </div>
    </motion.section>
  );
}

// ---------- session view ----------

/** Timeline shapes: prompt bubble, step-group row, paragraph lines, a subagent card. */
export function TimelineSkeleton({ compact, label }: { compact?: boolean; label?: string }) {
  return (
    <motion.div {...fade} className={cx("mx-auto flex max-w-[700px] flex-col pt-6", compact ? "gap-3 px-4" : "gap-4 px-8")} aria-label={label ?? "Loading"}>
      <div className="flex flex-col items-end gap-1 pt-1">
        <Skel w="44%" h={52} r={12} i={0} className="rounded-br-[4px]" />
        <Skel w={52} h={8} i={0} className="mr-1 opacity-60" />
      </div>
      <div className="flex flex-col gap-[16px] py-[8px]">
        {["92%", "86%", "54%"].map((w, i) => (
          <Skel key={i} w={w} h={11} i={1 + i} />
        ))}
      </div>
      <div className="flex h-[32px] items-center gap-2 pl-0.5">
        <Skel w={12} h={12} r={3} i={4} className="mx-[3px]" />
        <Skel w={84} h={11} i={4} />
        <Skel w={44} h={22} r={5} i={5} />
        <Skel w={50} h={22} r={5} i={5} />
        <Skel w={34} h={9} i={6} className="ml-auto mr-2 opacity-70" />
      </div>
      <div className="ml-[9px] flex flex-col gap-1 border-l border-hairline pb-1 pl-3">
        {[180, 260].map((w, i) => (
          <div key={i} className="-ml-[19px] flex h-[34px] items-center gap-2.5">
            <Skel w={17} h={17} i={6 + i} />
            <Skel w={38} h={10} i={6 + i} />
            <Skel w={w} h={9} i={6 + i} className="opacity-70" />
          </div>
        ))}
        <div className="-ml-[19px] flex gap-2.5 py-1">
          <Skel w={15} h={15} i={8} className="mt-[7px]" />
          <div className="flex-1 rounded-[10px] border border-hairline px-3 pb-2.5 pt-2">
            <div className="flex h-[20px] items-center gap-2">
              <Skel w={58} h={18} r={5} i={8} />
              <Skel w={190} h={10} i={8} />
              <Skel w={64} h={18} r={5} i={1} className="ml-auto" />
            </div>
            {[150, 210].map((w, i) => (
              <div key={i} className="ml-[9px] flex h-[24px] items-center gap-2.5">
                <Skel w={13} h={13} i={2 + i} />
                <Skel w={34} h={9} i={2 + i} />
                <Skel w={w} h={8} i={2 + i} className="opacity-70" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-[16px] py-[8px]">
        {["78%", "64%"].map((w, i) => (
          <Skel key={i} w={w} h={11} i={3 + i} />
        ))}
      </div>
      {label && <span className="text-small text-faint">{label}</span>}
    </motion.div>
  );
}

/** Whole session view: header, timeline shapes, composer. For a tab whose session hasn't arrived yet. */
export function SessionSkeleton({ compact }: { compact?: boolean }) {
  return (
    <div className="flex h-full min-w-0 flex-col" aria-label="Loading session">
      <div className={cx("flex shrink-0 items-center gap-3 border-b border-hairline", compact ? "h-[58px] px-3" : "h-[64px] px-5")}>
        <Skel w={17} h={17} i={0} />
        <div className="flex min-w-0 flex-1 flex-col gap-[7px]">
          <div className="flex items-center gap-2">
            <Skel w={300} h={14} i={0} />
            <Skel w={76} h={24} i={1} />
          </div>
          <div className="flex items-center gap-2">
            <Skel w={120} h={8} i={1} className="opacity-70" />
            <Skel w={64} h={8} i={2} className="opacity-70" />
          </div>
        </div>
        {!compact && (
          <div className="hidden items-center gap-4 lg:flex">
            <Skel w={80} h={4} i={2} />
            <Skel w={44} h={9} i={3} />
            <Skel w={70} h={9} i={3} />
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <TimelineSkeleton compact={compact} />
      </div>
      <div className={cx("shrink-0 pb-3 pt-1", compact ? "px-3" : "px-6")}>
        <div className="mx-auto flex max-w-[700px] flex-col gap-3 rounded-[12px] border border-line bg-raised/60 px-3.5 pb-2 pt-3.5">
          <Skel w={200} h={12} i={4} className="opacity-70" />
          <div className="flex items-center gap-2">
            <Skel w={84} h={28} r={7} i={5} />
            <Skel w={56} h={28} r={7} i={5} />
            <Skel w={48} h={28} r={7} i={6} />
            <Skel w={34} h={34} r={8} i={6} className="ml-auto" />
          </div>
        </div>
      </div>
    </div>
  );
}
