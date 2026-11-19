// The mic in a composer's chip row: click to start listening into that composer, click again to insert. Shown once
// voice is set up; before that it opens Settings > Voice.

import { useStore } from "../../store";
import { getTarget, startListening, stopListening, useVoice } from "../../lib/voice/controller";
import { useVoicePrefs, voiceReady } from "../../lib/voice/prefs";
import { cx } from "../primitives";
import { chordKeys, HOLD_LABEL, IMic } from "./parts";

export function VoiceButton({ target, disabled }: { target: string; disabled?: boolean }) {
  const p = useVoicePrefs();
  const phase = useVoice((s) => (s.target === target ? s.phase : "idle"));
  const on = phase === "listening";
  const ready = voiceReady(p);
  const how = [p.hold !== "off" ? `hold ${HOLD_LABEL[p.hold]}` : null, p.toggle ? `${chordKeys(p.toggle).join("")} hands-free` : null].filter(Boolean).join(", or ");
  return (
    <button
      type="button"
      data-voice-button={phase}
      disabled={disabled || phase === "transcribing"}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (!ready) return useStore.getState().openSettings("voice");
        if (on) return void stopListening();
        const t = getTarget(target);
        if (t) void startListening(t, "click");
      }}
      title={!ready ? "Voice: set it up in Settings" : on ? "Insert what you said" : `Dictate${how ? ` (${how})` : ""}`}
      aria-label={on ? "Stop listening and insert" : "Dictate"}
      className={cx(
        "inline-flex size-[28px] shrink-0 items-center justify-center rounded-[8px] transition-[background-color,color] duration-150 disabled:opacity-45",
        on ? "bg-[color-mix(in_oklab,var(--error)_16%,transparent)] text-err-text" : "text-dim hover:bg-hover hover:text-fg",
      )}
    >
      <IMic size={15} />
    </button>
  );
}
