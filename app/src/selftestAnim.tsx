// Every looping animation of the app, as the components draw it, for the `perf-anim-*` self-tests (selftestPerf.ts,
// docs/PERF.md): `AnimGallery` shows each once in a cell marked `data-anim-cell` (frames at fixed times, compared
// between builds), `AnimLab` six copies of one (what that loop alone costs).

import { motion } from "motion/react";
import type { ReactNode } from "react";
import { MOODS, type Mood } from "./lib/activityMood";
import { GlobeGlyph, MoodSvg } from "./components/MoodGlyph";
import { NeedsBadge, StatusDot } from "./components/primitives";
import { Skel } from "./components/Skeletons";
import { Reveal } from "./components/StepRail";
import { ThinkingDots } from "./components/ThinkingWord";

const MOOD_LIST = Object.keys(MOODS) as Mood[];

/** One instance of each loop, by name. */
export const LOOPS: Record<string, () => ReactNode> = {
  spin: () => <StatusDot status="busy" size={7} />,
  "needs-ring": () => <StatusDot status="needs" size={7} />,
  "needs-badge": () => <NeedsBadge />,
  breathe: () => <span className="block size-[7px] rounded-full bg-needs breathe" />,
  "shimmer-word": () => (
    <span className="text-base font-medium">
      <Reveal text="Thinking" inner={{ className: "shimmer", style: { ["--shimmer-hi" as string]: "var(--text)" } }} />
    </span>
  ),
  "shimmer-row": () => (
    <span className="text-base font-medium">
      <Reveal text="Bash" inner={{ className: "shimmer", style: { ["--shimmer-base" as string]: "var(--text)", ["--shimmer-hi" as string]: "var(--dim)" } }} />
    </span>
  ),
  "shimmer-steps": () => (
    <span className="flex text-base font-medium">
      <Reveal text="Running 3 steps" inner={{ className: "shimmer" }} />
    </span>
  ),
  "think-dots": () => (
    <span className="text-base">
      Thinking
      <ThinkingDots />
    </span>
  ),
  caret: () => <span className="caret" />,
  "md-live": () => (
    <div className="md md-live text-base">
      <p>Streaming text</p>
    </div>
  ),
  sweep: () => (
    <div className="sweep live-layer relative flex h-[28px] w-[260px] items-center rounded-[7px] px-2 text-base" style={{ ["--sweep" as string]: "var(--status-running)" }}>
      Active step
    </div>
  ),
  "seg-run": () => (
    <div className="flex h-[6px] w-[140px] gap-[2px]">
      <span className="h-full flex-1 rounded-full bg-running/40" />
      <span className="seg-run h-full flex-1 rounded-full" />
    </div>
  ),
  skel: () => <Skel w={140} h={10} i={0} />,
  "attn-card": () => <div className="attn-card h-[30px] w-[200px] rounded-[10px] border border-line bg-raised" />,
  globe: () => <GlobeGlyph size={19} live />,
  // The new chat's provider mark: the Motion loop it was, and the CSS class it is (absent from older builds).
  "welcome-motion": () => (
    <motion.div animate={{ rotate: [0, 8, 0] }} transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }} className="size-[26px] rounded-[6px] bg-running" />
  ),
  "welcome-css": () => <div className="welcome-sway size-[26px] rounded-[6px] bg-running" />,
  ...Object.fromEntries(
    MOOD_LIST.map((m) => [
      `mood-${m}`,
      () => (
        <span className="flex items-center gap-3 text-running">
          <MoodSvg mood={m} size={14} />
          <span className="origin-left scale-[3]">
            <MoodSvg mood={m} size={14} />
          </span>
        </span>
      ),
    ]),
  ),
};

const Cell = ({ id, children }: { id: string; children: ReactNode }) => (
  <div className="flex h-[40px] items-center gap-3">
    <span className="w-[110px] shrink-0 text-small text-faint">{id}</span>
    <div className="flex items-center px-1" data-anim-cell={id}>
      {children}
    </div>
  </div>
);

export function AnimGallery() {
  const names = Object.keys(LOOPS).filter((n) => n !== "welcome-motion");
  const cols = [names.filter((n) => !n.startsWith("mood-")).slice(0, 10), names.filter((n) => !n.startsWith("mood-")).slice(10), names.filter((n) => n.startsWith("mood-"))];
  return (
    <div className="fixed inset-0 z-[99999] overflow-hidden bg-bg p-6 text-fg" data-anim-gallery>
      <div className="grid grid-cols-3 gap-x-6">
        {cols.map((c, i) => (
          <div key={i}>
            {c.map((n) => (
              <Cell key={n} id={n}>
                {LOOPS[n]()}
              </Cell>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Six copies of one loop in the window's corner. */
export function AnimLab({ name }: { name: string }) {
  return (
    <div className="fixed bottom-2 left-2 z-[99999] flex items-center gap-2 bg-bg p-1 text-fg" id="perf-lab" data-anim-lab={name}>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i}>{LOOPS[name]()}</div>
      ))}
    </div>
  );
}
