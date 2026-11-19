// Voice's keys, for the whole window (mounted once in App.tsx), and the floating listening pill for fields that don't
// draw it themselves.
//
// - Push-to-talk: hold the hold key (Right ⌥ by default; Fn or Right ⌘ in Settings) alone while a voice field has
//   focus. Listening starts after 250 ms, so a quick ⌥ chord still types; any other key while holding cancels it.
//   Release: transcribe and insert.
// - Hands-free: the toggle chord (⌥Space by default) starts, the same chord inserts.
// - Esc while listening or transcribing cancels (and never reaches the composer, where Esc would stop the turn).
// - Never while a device panel has the keyboard (`keysCaptured`), or when voice isn't set up.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { keysCaptured } from "../../lib/macKeys";
import { voiceApi } from "../../lib/voice/api";
import { cancelListening, getTarget, registerTarget, startListening, stopListening, targetOf, useVoice, type Target } from "../../lib/voice/controller";
import { getVoicePrefs, loadMemory, voiceReady, type Chord } from "../../lib/voice/prefs";
import { VoiceStrip } from "./VoiceStrip";

const HOLD_MS = 250;

export const chordMatches = (e: KeyboardEvent, c: Chord | null) => !!c && e.code === c.code && e.metaKey === c.meta && e.ctrlKey === c.ctrl && e.altKey === c.alt && e.shiftKey === c.shift;

export function VoiceHost() {
  useEffect(() => {
    let armed: { t: Target; timer: ReturnType<typeof setTimeout> } | null = null;
    const disarm = () => {
      if (armed) clearTimeout(armed.timer);
      armed = null;
    };
    const arm = (t: Target) => {
      disarm();
      const p = getVoicePrefs();
      if (p.model) void voiceApi().preload(p.model);
      armed = { t, timer: setTimeout(() => ((armed = null), void startListening(t, "hold")), HOLD_MS) };
    };
    const release = () => {
      if (armed) return disarm();
      const s = useVoice.getState();
      if (s.phase === "listening" && s.mode === "hold") void stopListening();
    };
    const onDown = (e: KeyboardEvent) => {
      if (keysCaptured(e)) return;
      const s = useVoice.getState();
      if (e.key === "Escape" && (s.phase === "listening" || s.phase === "transcribing")) {
        e.preventDefault();
        e.stopPropagation();
        disarm();
        return cancelListening();
      }
      const p = getVoicePrefs();
      if (!voiceReady(p)) return;
      if (chordMatches(e, p.toggle)) {
        if (s.phase === "listening") {
          e.preventDefault();
          e.stopPropagation();
          return void stopListening();
        }
        const t = targetOf(document.activeElement);
        if (t && s.phase !== "transcribing") {
          e.preventDefault();
          e.stopPropagation();
          disarm();
          return void startListening(t, "toggle");
        }
        return;
      }
      if ((p.hold === "AltRight" || p.hold === "MetaRight") && e.code === p.hold && !e.repeat) {
        const t = targetOf(document.activeElement);
        if (t && (s.phase === "idle" || s.phase === "error")) arm(t);
        return;
      }
      // Another key while the hold key is down: it was a chord (⌥ + letter), not push-to-talk.
      if (armed) disarm();
    };
    const onUp = (e: KeyboardEvent) => {
      const p = getVoicePrefs();
      if (e.code === p.hold) release();
    };
    // Leaving the window while holding: what was said so far is inserted (as 2relay does on resign-active).
    const onBlur = () => release();
    const offFn = voiceApi().onFn((down) => {
      const p = getVoicePrefs();
      if (p.hold !== "Fn" || !voiceReady(p)) return;
      if (down) {
        const t = targetOf(document.activeElement);
        const s = useVoice.getState();
        if (t && (s.phase === "idle" || s.phase === "error")) arm(t);
      } else release();
    });
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", onBlur);
    if (voiceReady(getVoicePrefs())) void loadMemory();
    // The browser mock: a handle for scripted demos and screenshots (never in the app).
    if (voiceApi().kind === "mock") void import("../../lib/voice/demo").then((d) => d.attach());
    return () => {
      disarm();
      offFn();
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  return <FloatingPill />;
}

/** The listening pill over a field that has no strip of its own (an answer field, the new-session prompt). */
function FloatingPill() {
  const id = useVoice((s) => (s.phase !== "idle" ? s.target : null));
  const t = getTarget(id);
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!t || t.inline) return;
    const read = () => setRect(t.el.getBoundingClientRect());
    read();
    window.addEventListener("resize", read);
    window.addEventListener("scroll", read, true);
    return () => {
      window.removeEventListener("resize", read);
      window.removeEventListener("scroll", read, true);
    };
  }, [t]);
  if (!t || t.inline || !rect || !id) return null;
  const above = rect.top > 60;
  return (
    <div
      className="pointer-events-auto fixed z-[60]"
      style={{ left: Math.max(8, rect.left), width: Math.max(300, Math.min(520, rect.width)), top: above ? rect.top - 6 : rect.bottom + 6, transform: above ? "translateY(-100%)" : undefined }}
      data-voice-floating
    >
      <VoiceStrip target={id} compact floating />
    </div>
  );
}

const refs = new Map<string, (el: HTMLTextAreaElement | HTMLInputElement | null) => void>();
/** A callback ref that makes a field a voice target (with the floating pill), for fields rendered in a list. */
export function voiceRef(key: string) {
  let f = refs.get(key);
  if (!f) {
    let off: (() => void) | null = null;
    f = (el) => {
      off?.();
      off = el ? registerTarget({ id: key, el, inline: false }) : null;
      if (!el) refs.delete(key);
    };
    refs.set(key, f);
  }
  return f;
}

let seq = 0;
/** Makes a text field a voice target while mounted. `inline`: it draws <VoiceStrip> itself. */
export function useVoiceField(ref: RefObject<HTMLTextAreaElement | HTMLInputElement | null>, o: { inline?: boolean; send?: () => void; id?: string } = {}) {
  const [id] = useState(() => o.id ?? `v${++seq}`);
  const send = useRef(o.send);
  useEffect(() => {
    send.current = o.send;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return registerTarget({ id, el, inline: !!o.inline, send: () => send.current?.() });
  }, [ref, id, o.inline]);
  return id;
}
