// The first-run onboarding: one calm centred column over the whole window, drawing the steps listed in steps.tsx
// (add a screen there: one component, one entry). It opens by itself once (lib/onboarding.ts keeps the flag in
// settings.json) and again from Settings > About or the palette. Every step can be skipped, the whole flow dismissed
// ("Skip setup"), and nothing is asked of macOS until the person presses the button for it.
//
// Keys: Enter continues (a focused button or switch keeps Enter for itself), Esc skips the step (on the finish step
// it closes), Tab stays inside. Focus moves to each step's title and goes back where it was on close.

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMotion } from "../../lib/motion";
import { closeOnboarding, maybeOpenOnboarding, useOnboarding } from "../../lib/onboarding";
import { matchShortcut } from "../../lib/shortcuts";
import { registerOverlay } from "../../lib/overlays";
import { projectOf } from "../../lib/format";
import { useStore } from "../../store";
import { Wordmark } from "../Wordmark";
import { IBack } from "../icons";
import { Button, cx, ease, Kbd } from "../primitives";
import { STEPS } from "./steps";
import type { Draft, StepCtx } from "./types";

export function Onboarding() {
  const open = useOnboarding((s) => s.open);
  const run = useOnboarding((s) => s.run);
  useEffect(() => maybeOpenOnboarding(), []);
  // The window key listener lives here, mounted with the app, so it is registered before every other capture-phase
  // listener (App's shortcuts, the Settings page's Esc) and runs first; the open flow supplies the handler.
  useEffect(() => {
    const k = (e: KeyboardEvent) => keyHandler?.(e);
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
  return <AnimatePresence>{open && <Flow key={run} />}</AnimatePresence>;
}

/** The open flow's key handler (see Onboarding). */
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

/** Things that keep Enter (and Space) for themselves. */
const OWN_ENTER = "button, a, [role=switch], [role=option], select, textarea";

function Flow() {
  const reduce = useMotion().reduce;
  const env = useStore((s) => s.env);
  const sessions = useStore((s) => s.sessions);
  const live = useMemo(() => {
    const seen: string[] = [];
    for (const s of sessions) {
      const p = projectOf(s);
      if (p && !seen.includes(p)) seen.push(p);
    }
    return seen.slice(0, 6);
  }, [sessions]);
  // Taken once (the first non-empty list): sessions re-sort as agents work, and choices shouldn't move under the pointer.
  const [frozen, setFrozen] = useState<string[] | null>(null);
  if (!frozen && live.length) setFrozen(live);
  const projects = frozen ?? live;
  const [draft, setDraftState] = useState<Draft>({ cwd: null });
  const ctx: StepCtx = { draft, setDraft: (patch) => setDraftState((d) => ({ ...d, ...patch })), env, projects };
  const steps = STEPS.filter((s) => !s.when || s.when(ctx));
  const [at, setAt] = useState(0);
  const [dir, setDir] = useState(1);
  const i = Math.min(at, steps.length - 1);
  const step = steps[i];
  const canSkip = step.canSkip !== false;

  // Where the person is, kept in step with every key press (two quick presses must move two steps, not one twice).
  const pos = useRef(0);
  const go = (to: number) => {
    setDir(to > pos.current ? 1 : -1);
    pos.current = to;
    setAt(to);
  };
  const leave = (act: "onNext" | "onSkip") => {
    const k = Math.min(pos.current, steps.length - 1);
    steps[k][act]?.(ctx);
    if (k === steps.length - 1) closeOnboarding();
    else go(k + 1);
  };
  const next = () => leave("onNext");
  const skip = () => leave("onSkip");
  const back = () => pos.current > 0 && go(Math.min(pos.current, steps.length - 1) - 1);

  const root = useRef<HTMLDivElement>(null);
  // Focus: the step's title as each step shows (read out, and Enter continues from there); back where it was after.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    return () => {
      // Unless something that opened after (the new-session sheet) took it.
      const a = document.activeElement;
      if (before?.isConnected && (!a || a === document.body)) before.focus();
    };
  }, []);
  // A native webview (the in-app browser) draws over any HTML: it hides while this is up (lib/overlays.ts).
  useEffect(() => (root.current ? registerOverlay(root.current) : undefined), []);

  // Keys are taken on the window, in the capture phase, ahead of App's shortcuts and the Settings page's Esc (see
  // Onboarding above), so they work wherever focus is. While it is up, the app's own shortcuts
  // (⌘K, ⌘T, ⌘W…) would act on things out of sight: they wait; the theme switch still works.
  const onKey = (e: KeyboardEvent) => {
    const take = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    if (e.key === "Escape") {
      take();
      skip();
    } else if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      const own = (e.target as HTMLElement | null)?.closest?.(OWN_ENTER);
      if (own && root.current?.contains(own) && !e.metaKey && !e.ctrlKey) return;
      take();
      next();
    } else if (e.key === "Tab") {
      // Keep Tab inside the onboarding.
      const f = [...(root.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input, [tabindex]:not([tabindex='-1'])") ?? [])].filter((el) => el.offsetParent !== null);
      if (!f.length) return;
      const at = f.indexOf(document.activeElement as HTMLElement);
      take();
      f[at < 0 ? (e.shiftKey ? f.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    } else {
      const sc = matchShortcut(e);
      if (sc && sc.id !== "theme") take();
    }
  };
  useLayoutEffect(() => {
    keyHandler = onKey;
  });
  useEffect(
    () => () => {
      keyHandler = null;
    },
    [],
  );

  const Body = step.component;
  const lead = typeof step.lead === "function" ? step.lead(ctx) : step.lead;
  const slide = reduce ? 0 : 14;

  return (
    <motion.div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-labelledby="onb-title"
      data-onboarding={step.id}
      className="fixed inset-0 z-[55] flex flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.16 } }}
      transition={{ duration: 0.2 }}
    >
      {/* The app's title bar shows through (App hides its controls while this is up), so the traffic lights, dragging
          and the frosted glass stay as they are; the sheet's rounded corners sit on a little of the same chrome. */}
      <div data-tauri-drag-region className="h-[44px] shrink-0" />
      <div className="pointer-events-none absolute inset-x-0 top-[44px] h-[20px] bg-chrome" aria-hidden />
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-[18px] border-t border-hairline bg-bg">
        <div className="absolute right-3 top-3 z-10">
          <Button variant="ghost" className="h-[30px] px-2.5 text-small" onClick={closeOnboarding} data-onb-dismiss>
            Skip setup
          </Button>
        </div>
        <div className="scroll min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-[460px] flex-col justify-center px-4 py-12 [@media(max-height:700px)]:py-6">
            <div className="flex items-center justify-between">
              <Wordmark size={22} />
              <StepDots count={steps.length} at={i} />
            </div>

            <AnimatePresence mode="wait" initial={false} custom={dir}>
              <motion.div
                key={step.id}
                custom={dir}
                initial={{ opacity: 0, x: dir * slide }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -dir * slide, transition: { duration: 0.12 } }}
                transition={{ duration: 0.22, ease }}
                className="mt-12 flex flex-col [@media(max-height:700px)]:mt-7"
                data-onb-step={step.id}
              >
                <StepTitle text={step.title} />
                {lead && <p className="mt-1.5 text-base text-dim">{lead}</p>}
                <div className="mt-7 [@media(max-height:700px)]:mt-5">
                  <Body ctx={ctx} next={next} />
                </div>
              </motion.div>
            </AnimatePresence>

            <div className="mt-10 flex items-center gap-2 [@media(max-height:700px)]:mt-7">
              <Button variant="ghost" className={cx("pl-2", i === 0 && "invisible")} onClick={back} data-onb-back>
                <IBack size={14} />
                Back
              </Button>
              <span className="flex-1" />
              {canSkip && (
                <Button variant="ghost" onClick={skip} title="Skip (Esc)" data-onb-skip>
                  Skip
                </Button>
              )}
              <Button variant="primary" onClick={next} data-onb-next>
                {step.nextLabel?.(ctx) ?? "Continue"}
                <Kbd className="ml-1 border-transparent bg-[color-mix(in_oklab,var(--bg)_16%,transparent)] text-current opacity-80">↵</Kbd>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/** The step's title, focused when it shows (each step mounts its own). */
function StepTitle({ text }: { text: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus({ preventScroll: true }), 30);
    return () => clearTimeout(t);
  }, []);
  return (
    <h1 ref={ref} id="onb-title" tabIndex={-1} className="text-display font-semibold tracking-[-0.02em] text-fg outline-none">
      {text}
    </h1>
  );
}

/** "Step 2 of 4" as a row of short bars: the current one longer and solid, the ones done a little firmer. */
function StepDots({ count, at }: { count: number; at: number }) {
  return (
    <div className="flex items-center gap-1" role="img" aria-label={`Step ${at + 1} of ${count}`} data-onb-dots={`${at + 1}/${count}`}>
      {Array.from({ length: count }, (_, k) => (
        <motion.span
          key={k}
          className={cx("h-[4px] rounded-full", k === at ? "bg-fg" : k < at ? "bg-[color-mix(in_oklab,var(--text)_35%,transparent)]" : "bg-[color-mix(in_oklab,var(--text)_14%,transparent)]")}
          initial={false}
          animate={{ width: k === at ? 18 : 6 }}
          transition={{ type: "spring", stiffness: 500, damping: 40 }}
        />
      ))}
    </div>
  );
}
