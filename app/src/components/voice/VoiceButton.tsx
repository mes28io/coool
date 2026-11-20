// The mic in a composer's chip row: click to start listening into that composer, click again (or Done, or Return) to
// insert. Its tooltip says what it does and the two keys. Before voice is set up it opens Settings > Voice.

import { useStore } from "../../store";
import { getTarget, startListening, stopListening, useVoice } from "../../lib/voice/controller";
import { micTitle } from "../../lib/voice/surface";
import { useVoicePrefs, voiceReady } from "../../lib/voice/prefs";
import { cx } from "../primitives";
import { chordKeys, HOLD_LABEL, IMic } from "./parts";

export function VoiceButton({ target, disabled }: { target: string; disabled?: boolean }) {
  const p = useVoicePrefs();
  const phase = useVoice((s) => (s.target === target ? s.phase : "idle"));
  const on = phase === "listening" || phase === "starting";
  const ready = voiceReady(p);
  const title = micTitle(ready, on, p.hold !== "off" ? HOLD_LABEL[p.hold] : null, p.toggle ? chordKeys(p.toggle).join("") : null);
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
      title={title}
      aria-label={title}
      aria-pressed={on}
      className={cx(
        "inline-flex size-[28px] shrink-0 items-center justify-center rounded-[8px] transition-[background-color,color] duration-150 disabled:opacity-45",
        on ? "bg-[color-mix(in_oklab,var(--error)_16%,transparent)] text-err-text" : "text-dim hover:bg-hover hover:text-fg",
      )}
    >
      <IMic size={15} />
    </button>
  );
}
