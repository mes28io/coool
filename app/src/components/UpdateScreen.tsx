// The update screen: the whole window, while an install ends in a restart (at launch, or the updater's Restart), so
// the window going away and coming back is expected rather than a crash. Before it, at launch only, a plain hold of
// the window's background while coool's own check is out (at most VEIL_MAX_MS), so a found update's screen is the
// first thing shown. The backend drives it (update/mod.rs `Launch`); lib/updateView.ts says what each stage shows.

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/backend";
import { registerOverlay } from "../lib/overlays";
import { coverOf, useUpdates } from "../lib/update";
import { launchView, type LaunchView } from "../lib/updateView";
import { Button, cx, ease } from "./primitives";

/** Page ms, every 250 ms while `on` (when "Start coool now" is offered). */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export function UpdateScreen() {
  const launch = useUpdates((s) => s.status?.launch ?? null);
  const since = useUpdates((s) => s.screenSince);
  const cover = useUpdates(coverOf);
  const now = useNow(since !== null);
  const view: LaunchView | null = since !== null ? launchView(launch, Math.max(0, now - since)) : null;
  return (
    <AnimatePresence initial={false}>
      {cover && (
        <Cover key="cover">
          <AnimatePresence>{view && <Content key="content" view={view} />}</AnimatePresence>
        </Cover>
      )}
    </AnimatePresence>
  );
}

function Cover({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Native webviews (the browser panel) hide under it.
  useEffect(() => (ref.current ? registerOverlay(ref.current) : undefined), []);
  return (
    <motion.div
      ref={ref}
      data-update-screen
      data-tauri-drag-region
      className="fixed inset-0 z-[300] flex items-center justify-center bg-bg"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.32, ease } }}
      transition={{ duration: 0.22, ease }}
    >
      {children}
    </motion.div>
  );
}

function Content({ view: v }: { view: LaunchView }) {
  const [skipping, setSkipping] = useState(false);
  const skip = () => {
    setSkipping(true);
    void api()
      .updateLaunchSkip()
      .finally(() => setSkipping(false));
  };
  return (
    <motion.div
      data-tauri-drag-region
      className="flex w-[340px] flex-col items-center pb-[6vh] text-center"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.16 } }}
      transition={{ duration: 0.36, ease }}
      role="status"
      aria-live="polite"
      data-update-stage={v.failed ? "failed" : v.stage}
    >
      <div aria-hidden className="flex size-[64px] items-center justify-center rounded-[16px] bg-fg text-bg shadow-card">
        <span className="text-[16px] font-semibold leading-none tracking-[-0.01em]">coool</span>
      </div>
      {/* A failure is one plain line in the title's place; the rest stays as it was laid out, so nothing jumps. */}
      <div className={cx("mt-6 min-h-[24px] text-fg tnum", v.failed ? "text-[15px]" : "text-[17px] font-semibold")} data-update-title>
        {v.failed ? v.stage : v.title}
      </div>
      <div className="mt-1.5 min-h-[20px] text-base text-dim tnum" data-update-line>
        {!v.failed && v.stage}
        {v.pct !== null && <span className="text-faint"> · {v.pct}%</span>}
      </div>
      <div className="mt-5 h-[4px] w-[220px]">
        {v.bar !== "none" && <Bar view={v} />}
      </div>
      <div className="mt-2 min-h-[18px] text-small text-faint tnum">{v.bytes ?? v.note ?? ""}</div>
      <div className="mt-6 flex min-h-[52px] flex-col items-center gap-1.5">
        <AnimatePresence>
          {v.skip && (
            <motion.div key="skip" className="flex flex-col items-center gap-1.5" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease }}>
              <Button variant="outline" className="h-[30px] px-3 text-small" onClick={skip} disabled={skipping} data-update-skip>
                Start coool now
              </Button>
              <div className="text-small text-faint">The update finishes in the background.</div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

/** A determinate bar (scaled, not resized), a sliding segment while the length is unknown, or full. */
function Bar({ view: v }: { view: LaunchView }) {
  return (
    <div className="relative h-full w-full overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--text)_11%,transparent)]" data-update-bar={v.bar}>
      {v.bar === "indeterminate" ? (
        <div className="upd-indet absolute inset-y-0 left-0 w-[34%] rounded-full bg-running" />
      ) : (
        <div className="absolute inset-0 origin-left rounded-full bg-running transition-transform duration-300 ease-out" style={{ transform: `scaleX(${v.bar === "full" ? 1 : (v.pct ?? 0) / 100})` }} />
      )}
    </div>
  );
}
