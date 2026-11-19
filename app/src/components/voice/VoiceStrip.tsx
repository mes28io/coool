// The listening UI inside a composer (and, as a floating pill, over the other voice fields): while listening, a red
// dot, the live level, the elapsed time and how to finish; while transcribing, the words as they decode; an error
// with the one action that fixes it (allow the microphone, open System Settings, choose a model).

import { AnimatePresence, motion } from "motion/react";
import { useStore } from "../../store";
import { cancelListening, dismissError, stopListening, useVoice } from "../../lib/voice/controller";
import { voiceApi } from "../../lib/voice/api";
import { cx, ease } from "../primitives";
import { FinishHint, fmtSecs, IMic, Meter } from "./parts";

export function VoiceStrip({ target, compact, floating }: { target: string; compact?: boolean; floating?: boolean }) {
  const phase = useVoice((s) => (s.target === target ? s.phase : "idle"));
  const levels = useVoice((s) => s.levels);
  const secs = useVoice((s) => s.secs);
  const mode = useVoice((s) => s.mode);
  const partial = useVoice((s) => s.partial);
  const error = useVoice((s) => s.error);
  const perm = useVoice((s) => s.permission);
  const show = phase !== "idle";
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
          role="status"
          aria-live="polite"
        >
          <div className={cx("flex min-h-[40px] items-center gap-2.5 px-3.5", !floating && "border-b border-hairline", floating && "py-1.5")}>
            {phase === "listening" && (
              <>
                <span className="relative flex size-[8px] shrink-0 rounded-full bg-[var(--error)]" title="The microphone is on" />
                <span className="text-small font-medium text-fg">Listening</span>
                <Meter levels={levels} bars={compact ? 16 : 28} tone="var(--error)" />
                <span className="font-mono text-mono-small text-dim tnum" data-voice-secs>
                  {fmtSecs(secs)}
                </span>
                <span className="flex-1" />
                {mode === "click" ? (
                  <button type="button" onClick={() => void stopListening()} className="text-small font-medium text-fg hover:underline">
                    Insert
                  </button>
                ) : null}
                <FinishHint mode={mode} compact={compact} />
              </>
            )}
            {phase === "transcribing" && (
              <>
                <IMic size={14} className="shrink-0 text-dim" />
                <span className="min-w-0 flex-1 truncate text-small text-dim" data-voice-partial>
                  {partial ? <span className="text-fg/80">{partial}</span> : "Writing it down…"}
                </span>
                <button type="button" onClick={cancelListening} className="text-small text-faint hover:text-fg">
                  Cancel
                </button>
              </>
            )}
            {phase === "error" && (
              <>
                <IMic size={14} className="shrink-0 text-busy-text" />
                <span className="min-w-0 flex-1 text-small text-fg/90" data-voice-error>
                  {error}
                </span>
                {perm === "denied" || perm === "restricted" ? (
                  <button type="button" className="text-small font-medium text-fg hover:underline" onClick={() => void voiceApi().openPrivacy()}>
                    Open System Settings
                  </button>
                ) : /model/i.test(error ?? "") ? (
                  <button
                    type="button"
                    className="text-small font-medium text-fg hover:underline"
                    onClick={() => {
                      dismissError();
                      useStore.getState().openSettings("voice");
                    }}
                  >
                    Settings
                  </button>
                ) : null}
                <button type="button" onClick={dismissError} className="text-small text-faint hover:text-fg" aria-label="Dismiss">
                  Dismiss
                </button>
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
