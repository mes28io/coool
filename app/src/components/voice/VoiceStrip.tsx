// The recording surface on a composer (and, as a floating pill, over the other voice fields). What it says at each
// moment comes from lib/voice/surface.ts: starting, Listening (live level, elapsed time, the direction, how to finish,
// Done / Cancel), "can't hear anything", Turning speech into text… (cancellable), Added (Undo) or nothing heard, and
// each error with the button that fixes it.

import { AnimatePresence, motion } from "motion/react";
import { useStore } from "../../store";
import { cancelListening, dismissError, dismissNotice, stopListening, undoDictation, useVoice } from "../../lib/voice/controller";
import { voiceApi } from "../../lib/voice/api";
import { direction, surface, type Action } from "../../lib/voice/surface";
import { useVoicePrefs } from "../../lib/voice/prefs";
import { cx, ease, Kbd } from "../primitives";
import { chordKeys, fmtSecs, HOLD_LABEL, IMic, Meter } from "./parts";
import { LANGUAGES } from "./languages";

const langLabel = (c: string) => LANGUAGES.find((l) => l.value === c)?.label ?? c;

export function VoiceStrip({ target, compact, floating }: { target: string; compact?: boolean; floating?: boolean }) {
  const mine = useVoice((s) => s.target === target);
  const phase = useVoice((s) => (s.target === target ? s.phase : "idle"));
  const levels = useVoice((s) => s.levels);
  const secs = useVoice((s) => s.secs);
  const mode = useVoice((s) => s.mode);
  const partial = useVoice((s) => s.partial);
  const error = useVoice((s) => s.error);
  const errorKind = useVoice((s) => s.errorKind);
  const notice = useVoice((s) => (s.notice?.target === target ? s.notice : null));
  const p = useVoicePrefs();
  const holdLabel = p.hold !== "off" ? HOLD_LABEL[p.hold] : null;
  const toggleLabel = p.toggle ? chordKeys(p.toggle).join("") : null;
  const v = surface({ phase: mine ? phase : "idle", mode, secs, levels, error, errorKind, notice, direction: direction(p.task, p.language, langLabel), holdLabel, toggleLabel });
  const show = v.kind !== "hidden";
  const live = v.kind === "listening" || v.kind === "quiet";
  const run = (a: Action) => {
    if (a === "done") void stopListening();
    else if (a === "cancel") cancelListening();
    else if (a === "undo") undoDictation();
    else if (a === "dismiss") (v.kind === "error" ? dismissError : dismissNotice)();
    else if (a === "privacy") void voiceApi().openPrivacy();
    else if (a === "settings") {
      if (v.kind === "error") dismissError();
      else cancelListening();
      useStore.getState().openSettings("voice");
    }
  };
  const tone = v.kind === "error" || v.kind === "quiet" ? "text-busy-text" : v.kind === "listening" ? "text-err-text" : "text-dim";
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key="voice"
          initial={{ opacity: 0, height: floating ? "auto" : 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: floating ? "auto" : 0 }}
          transition={{ duration: 0.16, ease }}
          className={cx("overflow-hidden", floating && "rounded-[12px] border border-line bg-raised shadow-pop")}
          data-voice-strip={phase}
          data-voice-surface={v.kind}
          role="status"
          aria-live="polite"
        >
          <div
            className={cx(
              "flex min-h-[44px] flex-wrap items-center gap-x-2.5 gap-y-1 px-3.5 py-2",
              !floating && "border-b border-hairline",
              live && "bg-[color-mix(in_oklab,var(--error)_6%,transparent)]",
            )}
          >
            {live ? (
              <span className="relative flex size-[9px] shrink-0 rounded-full bg-[var(--error)]" title="The microphone is on" data-voice-dot />
            ) : v.kind === "working" || v.kind === "starting" ? (
              <Spinner />
            ) : (
              <IMic size={14} className={cx("shrink-0", tone)} />
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-2">
                <span className={cx("shrink-0 text-small font-medium", v.kind === "listening" ? "text-fg" : v.kind === "quiet" ? "text-busy-text" : "text-fg/90")} data-voice-title>
                  {v.title}
                </span>
                {v.meter && <Meter levels={levels} bars={compact ? 18 : 30} tone={v.kind === "quiet" ? "var(--status-needs)" : "var(--error)"} />}
                {v.clock && (
                  <span className="shrink-0 font-mono text-mono-small text-dim tnum" data-voice-secs>
                    {fmtSecs(secs)}
                  </span>
                )}
              </span>
              {(v.detail || v.kind === "working") && (
                <span className="min-w-0 truncate text-small text-dim" data-voice-detail>
                  {v.kind === "working" && partial ? <span className="text-fg/75">{partial}</span> : v.detail}
                </span>
              )}
              {v.finish && (
                <span className="text-small text-faint" data-voice-finish>
                  {v.finish}
                  {" · "}
                  <Kbd className="h-[18px] px-1">esc</Kbd> to cancel
                </span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {v.actions.map((a) => (
                <ActionButton key={a} a={a} primary={a === "done" || (a === "settings" && v.kind === "error") || a === "privacy"} onClick={() => run(a)} />
              ))}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const LABEL: Record<Action, string> = { done: "Done", cancel: "Cancel", settings: "Settings > Voice", privacy: "Open System Settings", undo: "Undo", dismiss: "Dismiss" };

function ActionButton({ a, primary, onClick }: { a: Action; primary: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      data-voice-action={a}
      className={cx(
        "h-[26px] whitespace-nowrap rounded-[7px] px-2 text-small transition-colors duration-150",
        primary ? "bg-fg font-medium text-bg hover:bg-fg/85" : a === "dismiss" || a === "cancel" ? "text-faint hover:text-fg" : "border border-line font-medium text-fg hover:bg-hover",
      )}
    >
      {LABEL[a]}
    </button>
  );
}

/** A small spinner: one rotating arc (a CSS animation that runs only while this is on screen). */
function Spinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" className="shrink-0 animate-spin text-dim" aria-hidden data-voice-spinner>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
