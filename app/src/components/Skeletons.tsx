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

/** Mirrors ProjectGroup > Row: folder glyph + name, then indented title bars. */
export function SidebarSkeleton({ groups = 4 }: { groups?: number }) {
  const plan: { name: number; rows: number[] }[] = [
    { name: 84, rows: [150, 128, 170] },
    { name: 60, rows: [136, 160] },
    { name: 96, rows: [176, 120] },
    { name: 52, rows: [146] },
  ];
  let k = 0;
  return (
    <motion.div {...fade} aria-label="Loading sessions">
      {plan.slice(0, groups).map((g, gi) => (
        <div key={gi} className="mb-1">
          <div className="flex h-[34px] items-center gap-2.5 px-2.5">
            <Skel w={18} h={14} r={4} i={k++} />
            <Skel w={g.name} h={11} i={k++} />
          </div>
          <div className="flex flex-col gap-px pt-px">
            {g.rows.map((w, ri) => (
              <div key={ri} className="flex h-[30px] items-center pl-[38px] pr-3">
                <Skel w={w} h={10} i={k++} className="opacity-70" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </motion.div>
  );
}

// ---------- mission control ----------

/** Mirrors Card: top line, title (two lines), one "now" line, footer. */
export function CardSkeleton({ i = 0, label }: { i?: number; label?: string }) {
  const v = [
    [64, "88%", "52%", 210, 70],
    [52, "74%", "40%", 180, 54],
    [72, "92%", "60%", 230, 80],
  ][i % 3] as [number, string, string, number, number];
  const k = i * 3;
  return (
    <motion.div
      {...fade}
      layout
      className="flex flex-col rounded-[14px] border border-hairline bg-bg p-4"
      aria-label={label ?? "Loading session"}
    >
      <div className="flex h-[22px] items-center gap-1.5">
        <Skel w={14} h={14} i={k} />
        <Skel w={v[0]} h={10} i={k} />
        <Skel w={64} h={10} i={k + 1} className="ml-auto" />
      </div>
      <div className="mt-2.5 flex flex-col gap-0">
        <div className="flex h-[24px] items-center">
          <Skel w={v[1]} h={14} i={k + 1} />
        </div>
        <div className="flex h-[24px] items-center">
          <Skel w={v[2]} h={14} i={k + 2} />
        </div>
      </div>
      <div className="mt-3 flex h-[22px] items-center gap-2">
        <Skel w={15} h={13} r={3} i={k + 2} />
        <Skel w={v[3] / 1.4} h={10} i={k + 3} className="opacity-70" />
      </div>
      <div className="mt-4 flex h-[18px] items-center gap-3">
        <Skel w={56} h={4} i={k + 4} />
        <Skel w={30} h={9} i={k + 4} />
        <Skel w={v[4]} h={9} i={k + 5} />
      </div>
      {label && <span className="mt-3 text-small text-faint">{label}</span>}
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
      <div>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className={cx("flex h-[48px] items-center gap-3 px-1", i > 0 && "border-t border-hairline")}>
            <Skel w={15} h={15} i={i} />
            <Skel w={ws[i % ws.length]} h={11} i={i} />
            <Skel w={52} h={9} i={i} className="opacity-70" />
            <Skel w={44} h={9} i={i + 1} className="ml-auto opacity-70" />
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
