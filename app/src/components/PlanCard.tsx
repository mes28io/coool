// PlanCard: a plan as a numbered list that runs. Props-driven and reusable; coool only
// shows a plan the CLI owns, so there is no editing, reordering or re-running here.
// Number -> spinner -> check on each step, a rail that draws between finished steps,
// durations that fade in, a footer that cross-fades between phases, and a card height
// that animates as steps come and go.

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { IAlert, ICheck, IList } from "./icons";
import { Button, cx, ease } from "./primitives";
import { RAIL, reducedMotion } from "./StepRail";

export type PlanStatus = "pending" | "active" | "done" | "failed" | "skipped";
export type PlanPhase = "proposed" | "running" | "stopped" | "done" | "approved" | "kept";

export interface PlanStep {
  title: string;
  detail?: string;
  /** Tool the step will use, shown as a small mono chip. */
  tag?: string;
  status: PlanStatus;
  /** Shown once the step is done, when known. */
  durationMs?: number;
  /** One red line under a failed step. */
  error?: string;
}

const dur = (ms: number) => {
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

const Spinner = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" className="spin" aria-hidden>
    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
    <path d="M8 2a6 6 0 016 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

function Marker({ status, n }: { status: PlanStatus; n: number }) {
  const instant = reducedMotion();
  return (
    <span className="relative flex size-[18px] items-center justify-center">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={status}
          initial={instant ? false : { scale: 0.55, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ opacity: 0, scale: 0.85, transition: { duration: instant ? 0 : 0.12 } }}
          transition={{ duration: instant ? 0 : 0.2, ease }}
          className="absolute inset-0 flex items-center justify-center"
        >
          {status === "pending" ? (
            <span className="flex size-[18px] items-center justify-center rounded-full border border-line text-micro font-medium text-faint tnum">{n}</span>
          ) : status === "active" ? (
            <span className="text-working-text">
              <Spinner size={16} />
            </span>
          ) : status === "done" ? (
            <span className="flex size-[18px] items-center justify-center rounded-full bg-fg text-bg">
              <ICheck size={12} />
            </span>
          ) : status === "failed" ? (
            <span className="text-err-text">
              <IAlert size={18} />
            </span>
          ) : (
            <span className="flex size-[18px] items-center justify-center rounded-full border border-dashed border-line text-micro text-faint">–</span>
          )}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function StepRow({ s, i, last, fresh, prevDone }: { s: PlanStep; i: number; last: boolean; fresh: boolean; prevDone: boolean }) {
  const instant = reducedMotion();
  return (
    <motion.div
      initial={fresh && !instant ? { height: 0, opacity: 0 } : false}
      animate={{ height: "auto", opacity: 1 }}
      exit={instant ? undefined : { height: 0, opacity: 0 }}
      transition={{ duration: instant ? 0 : 0.28, ease }}
      className="relative overflow-hidden"
      data-plan-step={s.status}
    >
      <div className="relative flex gap-2.5 pb-[7px] pt-[5px]">
        {/* Rail: this row's lower half, and the upper half joining the previous row's. */}
        {[
          { show: !last, top: 26, bottom: 0, drawn: s.status === "done", delay: 0 },
          { show: i > 0, top: 0, height: 4, drawn: prevDone, delay: 0.2 },
        ].map(
          (g, k) =>
            g.show && (
              <span key={k}>
                <span aria-hidden className="absolute w-px" style={{ left: 8.5, top: g.top, bottom: g.bottom, height: g.height, background: "color-mix(in oklab, var(--border) 70%, transparent)" }} />
                <motion.span
                  aria-hidden
                  className="absolute w-px"
                  style={{ left: 8.5, top: g.top, bottom: g.bottom, height: g.height, background: RAIL, transformOrigin: "top" }}
                  initial={false}
                  animate={{ scaleY: g.drawn ? 1 : 0 }}
                  transition={{ duration: instant ? 0 : k ? 0.12 : 0.3, ease, delay: instant ? 0 : g.delay }}
                />
              </span>
            ),
        )}
        <span className="relative mt-[1px] shrink-0">
          <Marker status={s.status} n={i + 1} />
        </span>
        <div className="min-w-0 flex-1">
          <div className={cx("truncate text-base", s.status === "active" ? "font-medium text-fg" : s.status === "pending" ? "text-fg/85" : s.status === "skipped" ? "text-faint line-through" : "text-fg/80")} title={s.title}>
            {s.title}
          </div>
          {s.detail && (
            <div className="truncate text-small text-dim" title={s.detail}>
              {s.detail}
            </div>
          )}
          {s.status === "failed" && s.error && <div className="truncate text-small text-err-text" title={s.error}>{s.error}</div>}
        </div>
        <div className="flex shrink-0 items-start gap-2 pt-[1px]">
          {s.tag && <span className="inline-flex h-[20px] items-center rounded-[6px] bg-[color-mix(in_oklab,var(--dim)_11%,transparent)] px-1.5 font-mono text-mono-small text-dim">{s.tag}</span>}
          <span className="w-[38px] text-right text-small text-faint tnum">
            <AnimatePresence initial={false}>
              {s.status === "done" && s.durationMs !== undefined && (
                <motion.span key="d" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: instant ? 0 : 0.3 }}>
                  {dur(s.durationMs)}
                </motion.span>
              )}
            </AnimatePresence>
          </span>
        </div>
      </div>
    </motion.div>
  );
}

function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export function PlanCard({
  title,
  steps,
  phase,
  body,
  subtitle,
  startedAt,
  endedAt,
  onApprove,
  onReject,
  attention,
  ...data
}: {
  title: string;
  steps: PlanStep[];
  phase: PlanPhase;
  /** Shown instead of steps when the plan has no list to number. */
  body?: ReactNode;
  /** A dim line under the title (Codex's explanation of the plan). */
  subtitle?: string;
  startedAt?: number;
  endedAt?: number;
  /** Proposed phase only: when absent, no buttons are shown. */
  onApprove?: () => void;
  onReject?: () => void;
  /** Blocked on the person: the "Needs you" card edge. */
  attention?: boolean;
  [k: `data-${string}`]: string | undefined;
}) {
  const done = steps.filter((s) => s.status === "done").length;
  const failedAt = steps.findIndex((s) => s.status === "failed");
  const now = useNow(phase === "running");
  const seen = useRef<Set<string> | null>(null);
  const keyOf = (s: PlanStep, i: number) => `${i}:${s.title}`;
  if (seen.current === null) seen.current = new Set(steps.map(keyOf));
  const fresh = new Set(steps.map(keyOf).filter((k) => !seen.current!.has(k)));
  useEffect(() => {
    for (const k of fresh) seen.current!.add(k);
  });

  let footer: ReactNode;
  if (phase === "proposed")
    footer = (
      <>
        <span className="min-w-0 flex-1 truncate text-small text-dim">Nothing runs until you approve.</span>
        {onReject && (
          <Button variant="ghost" onClick={onReject} title="Keep planning (⌘⌫)" data-deny>
            Keep planning
          </Button>
        )}
        {onApprove && (
          <Button variant="primary" onClick={onApprove} title="Approve the plan (⌘↵)" data-allow-once>
            Approve plan
          </Button>
        )}
      </>
    );
  else if (phase === "running")
    footer = (
      <>
        <span className="text-working-text">
          <Spinner />
        </span>
        <span className="text-small text-dim tnum">
          Running · {Math.min(done + 1, Math.max(steps.length, 1))} of {steps.length}
        </span>
        <span className="flex-1" />
        {startedAt !== undefined && <span className="text-small text-faint tnum">{dur(Math.max(0, now - startedAt))}</span>}
      </>
    );
  else if (phase === "stopped")
    footer =
      failedAt >= 0 ? (
        <span className="flex items-center gap-1.5 text-small text-err-text">
          <IAlert size={14} /> Stopped · step {failedAt + 1} failed
        </span>
      ) : (
        <span className="text-small text-dim tnum">
          Stopped · {done} of {steps.length} done
        </span>
      );
  else if (phase === "done")
    footer = (
      <span className="flex items-center gap-1.5 text-small text-dim tnum">
        <ICheck size={14} className="text-faint" /> Done{startedAt !== undefined && endedAt !== undefined ? ` in ${dur(Math.max(0, endedAt - startedAt))}` : ""}
      </span>
    );
  else
    footer = (
      <span className="flex items-center gap-1.5 text-small text-dim">
        <ICheck size={14} className="text-faint" /> {phase === "approved" ? "Approved" : "Kept planning"}
      </span>
    );

  return (
    <div
      {...data}
      className={cx("rounded-[14px] border bg-raised shadow-card", attention ? "attn-card border-[color-mix(in_oklab,var(--status-needs)_30%,var(--border))]" : "border-hairline")}
      data-plan={phase}
    >
      <div className="px-3.5 pt-3">
        <div className="flex items-center gap-1.5 text-small text-dim">
          <IList size={14} className="text-faint" />
          <span>Plan{steps.length > 0 ? ` · ${steps.length} ${steps.length === 1 ? "step" : "steps"}` : ""}</span>
        </div>
        <div className="mt-1 text-title font-medium tracking-[-0.01em] text-fg">{title}</div>
        {subtitle && (
          <div className="mt-0.5 line-clamp-2 text-small text-dim" title={subtitle} data-plan-subtitle>
            {subtitle}
          </div>
        )}
      </div>
      <div className="px-3.5 pb-1 pt-1.5">
        {steps.length > 0 ? (
          <AnimatePresence initial={false}>
            {steps.map((s, i) => (
              <StepRow key={keyOf(s, i)} s={s} i={i} last={i === steps.length - 1} fresh={fresh.has(keyOf(s, i))} prevDone={i > 0 && steps[i - 1].status === "done"} />
            ))}
          </AnimatePresence>
        ) : (
          body && <div className="selectable max-h-[320px] overflow-y-auto pb-2 text-base text-fg/85">{body}</div>
        )}
      </div>
      <div className="relative h-[52px] border-t border-hairline">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={phase}
            initial={reducedMotion() ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: reducedMotion() ? 0 : 0.12 } }}
            transition={{ duration: reducedMotion() ? 0 : 0.2, ease }}
            className="absolute inset-0 flex items-center gap-2 px-3.5"
          >
            {footer}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
