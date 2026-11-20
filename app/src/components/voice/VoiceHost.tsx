// Voice's keys, for the whole window (mounted once in App.tsx), and the floating listening pill for fields that don't
// draw it themselves.
//
// In the app the keys come from AppKit (app/src-tauri/src/voice/keys.rs, `voice-key` events), so they work wherever
// focus is inside coool's window (a composer, the transcript, the sidebar, the Browser panel) and ⌥Space never types a
// non-breaking space. They work while coool is the front app only: reading keys while another app is in front would
// need macOS's Input Monitoring or Accessibility permission, which coool doesn't ask for. The browser mock reads the
// same keys from the page.
//
// - Push-to-talk: hold the hold key (Right ⌥ by default; Fn or Right ⌘ in Settings) alone. Listening starts after
//   250 ms, so a quick ⌥ chord still types; any other key while holding cancels it. Release: transcribe and insert.
// - Hands-free: the toggle chord (⌥Space by default) starts; the same chord, Return, or Done inserts.
// - Esc while starting, listening or transcribing cancels (and never reaches the composer, where Esc stops the turn).
// - Into the focused voice field, else the one focused last, else the composer on screen.
// - Never while a device panel has the keyboard (`data-key-capture`), or when voice isn't set up.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { keysCaptured, macKeyCode } from "../../lib/macKeys";
import { voiceApi, type KeyEvent } from "../../lib/voice/api";
import { cancelListening, getTarget, registerTarget, startListening, stopListening, targetOf, useVoice, type Target } from "../../lib/voice/controller";
import { getVoicePrefs, loadMemory, subscribeVoicePrefs, voiceReady, type Chord } from "../../lib/voice/prefs";
import { VoiceStrip } from "./VoiceStrip";

const HOLD_MS = 250;

export const chordMatches = (e: KeyboardEvent, c: Chord | null) => !!c && e.code === c.code && e.metaKey === c.meta && e.ctrlKey === c.ctrl && e.altKey === c.alt && e.shiftKey === c.shift;

let lastField: Target | null = null;
const visible = (el: Element) => el.isConnected && (el as HTMLElement).offsetParent !== null;

/** Where the keys dictate into: the focused voice field, else the one focused last (if still on screen), else the
 *  composer of the focused pane, else any composer on screen. */
export function keyTarget(): Target | null {
  const focused = targetOf(document.activeElement);
  if (focused) return focused;
  if (lastField && visible(lastField.el) && targetOf(lastField.el)) return lastField;
  for (const sel of ["[data-main] textarea[data-voice]", "textarea[data-voice]"]) {
    const el = [...document.querySelectorAll<HTMLTextAreaElement>(sel)].find(visible);
    const t = el ? targetOf(el) : null;
    if (t) return t;
  }
  return null;
}

/** The key monitor's settings from the prefs and the current phase. */
function keysConfig(captured: boolean) {
  const p = getVoicePrefs();
  const s = useVoice.getState();
  const busy = s.phase === "starting" || s.phase === "listening" || s.phase === "transcribing";
  return {
    enabled: voiceReady(p) && !captured,
    hold: p.hold,
    toggle: p.toggle && macKeyCode(p.toggle.code) !== null ? { key: macKeyCode(p.toggle.code)!, meta: p.toggle.meta, ctrl: p.toggle.ctrl, alt: p.toggle.alt, shift: p.toggle.shift } : null,
    active: busy,
    enter_finishes: (s.phase === "listening" || s.phase === "starting") && s.mode !== "hold",
  };
}

export function VoiceHost() {
  useEffect(() => {
    const api = voiceApi();
    let armed: { t: Target; timer: ReturnType<typeof setTimeout> } | null = null;
    const disarm = () => {
      if (armed) clearTimeout(armed.timer);
      armed = null;
    };
    const arm = (t: Target) => {
      disarm();
      const p = getVoicePrefs();
      if (p.model) void api.preload(p.model);
      armed = { t, timer: setTimeout(() => ((armed = null), void startListening(t, "hold")), HOLD_MS) };
    };
    const release = () => {
      if (armed) return disarm();
      const s = useVoice.getState();
      if ((s.phase === "listening" || s.phase === "starting") && s.mode === "hold") void stopListening();
    };
    const idle = () => ["idle", "error"].includes(useVoice.getState().phase);
    /** One key, from AppKit (the app) or the page (the mock). */
    const onKey = (k: KeyEvent) => {
      const s = useVoice.getState();
      if (k.kind === "escape") {
        disarm();
        return cancelListening();
      }
      if (k.kind === "enter") return void stopListening();
      if (k.kind === "chord") return disarm();
      if (!voiceReady(getVoicePrefs())) return k.kind === "hold" && !k.down ? release() : undefined;
      if (k.kind === "toggle") {
        if (s.phase === "listening" || s.phase === "starting") return void stopListening();
        const t = keyTarget();
        if (t && idle()) {
          disarm();
          t.el.focus({ preventScroll: true });
          void startListening(t, "toggle");
        }
        return;
      }
      if (k.kind === "hold") {
        if (!k.down) return release();
        const t = keyTarget();
        if (t && idle()) arm(t);
      }
    };

    // The page's own key events: the browser mock's only source (in the app AppKit's monitor sees them first and
    // swallows the ones voice uses, so these would double up).
    const page = api.kind === "mock";
    let holdDown = false;
    const onDown = (e: KeyboardEvent) => {
      if (keysCaptured(e)) return;
      const s = useVoice.getState();
      const busy = s.phase === "starting" || s.phase === "listening" || s.phase === "transcribing";
      const eat = () => (e.preventDefault(), e.stopPropagation());
      if (e.key === "Escape" && busy) return eat(), onKey({ kind: "escape" });
      if (e.key === "Enter" && !e.shiftKey && (s.phase === "listening" || s.phase === "starting") && s.mode !== "hold") return eat(), onKey({ kind: "enter" });
      const p = getVoicePrefs();
      if (!voiceReady(p)) return;
      if (chordMatches(e, p.toggle)) return eat(), e.repeat ? undefined : onKey({ kind: "toggle" });
      if ((p.hold === "AltRight" || p.hold === "MetaRight") && e.code === p.hold) {
        if (!e.repeat && !holdDown) {
          holdDown = true;
          onKey({ kind: "hold", down: true });
        }
        return;
      }
      if (holdDown) onKey({ kind: "chord" });
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== getVoicePrefs().hold || !holdDown) return;
      holdDown = false;
      onKey({ kind: "hold", down: false });
    };
    // Leaving the window while holding: what was said so far is inserted (as 2relay does on resign-active).
    const onBlur = () => {
      holdDown = false;
      release();
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = targetOf(e.target as Element);
      if (t) lastField = t;
      sync();
    };
    // The key monitor's view of things, kept current.
    let sent = "";
    const sync = () => {
      const captured = !!(document.activeElement instanceof Element && document.activeElement.closest("[data-key-capture]"));
      const cfg = keysConfig(captured);
      const k = JSON.stringify(cfg);
      if (k === sent) return;
      sent = k;
      void api.keys(cfg).catch(() => (sent = ""));
    };
    sync();
    const offPrefs = subscribeVoicePrefs(sync);
    const offState = useVoice.subscribe((s, prev) => (s.phase !== prev.phase || s.mode !== prev.mode) && sync());
    const offKey = api.onKey(onKey);
    if (page) {
      window.addEventListener("keydown", onDown, true);
      window.addEventListener("keyup", onUp, true);
    }
    window.addEventListener("blur", onBlur);
    document.addEventListener("focusin", onFocusIn);
    if (voiceReady(getVoicePrefs())) void loadMemory();
    // The browser mock: a handle for scripted demos and screenshots (never in the app).
    if (page) void import("../../lib/voice/demo").then((d) => d.attach());
    return () => {
      disarm();
      offKey();
      offPrefs();
      offState();
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, []);
  return <FloatingPill />;
}

/** The listening pill over a field that has no strip of its own (an answer field, the new-session prompt). */
function FloatingPill() {
  const id = useVoice((s) => (s.phase !== "idle" ? s.target : (s.notice?.target ?? null)));
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
