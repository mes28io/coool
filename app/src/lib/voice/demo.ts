// The browser mock's handle on voice (`window.__voice`), for scripted demos and screenshots: start listening in the
// first composer, queue what the mock "hears", read the state. Loaded only by the mock (VoiceHost), never in the app.
//
// `?voice=demo&voicestate=<state>` opens a chat and puts its composer's recording surface in one state, for
// screenshots: starting, listening, listening-toggle, listening-click, quiet (with `&level=flat`), working, done,
// nothing, nomodel, denied (with `&mic=denied`), nodevice (with `&mic=nodevice`), test, test-result, test-nothing
// (Settings > Voice's "Test your microphone" row). The direction is Turkish → English unless `&task=transcribe`.

import { mockHeard } from "./api.ts";
import * as c from "./controller.ts";
import * as M from "./memory.ts";
import { getMemory, setVoicePrefs, updateMemory } from "./prefs.ts";

const knob = (k: string) => new RegExp(`[?&]${k}=([\\w-]+)`).exec(location.search)?.[1] ?? null;

async function waitFor<T>(f: () => T | null | undefined, ms = 8000): Promise<T | null> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const v = f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

async function showState(state: string) {
  setVoicePrefs({ task: knob("task") === "transcribe" ? "transcribe" : "translate", language: "tr" });
  if (state.startsWith("test")) {
    const s = await import("../../store");
    s.useStore.getState().openSettings("voice");
    const btn = await waitFor(() => document.querySelector<HTMLButtonElement>("[data-voice-test]"));
    if (!btn) return;
    btn.scrollIntoView({ block: "center" });
    if (state === "test-result") mockHeard.push("Make the color of the button on the login page blue.");
    if (state === "test-nothing") mockHeard.push("");
    btn.click();
    if (state !== "test") {
      await waitFor(() => c.useVoice.getState().phase === "listening");
      await new Promise((r) => setTimeout(r, 1200));
      await c.stopListening();
    }
    return;
  }
  const a = await import("../actions");
  await a.newChat({ provider: "claude", cwd: "/Users/you/code/coool" });
  await new Promise((r) => setTimeout(r, 900));
  const el = await waitFor(() => document.querySelector<HTMLTextAreaElement>("[data-main] textarea[data-voice]") ?? document.querySelector<HTMLTextAreaElement>("textarea[data-voice]"));
  const t = el && c.targetOf(el);
  if (!el || !t) return;
  el.focus();
  if (state === "nomodel") setVoicePrefs({ model: null });
  const mode: c.Mode = state === "listening-toggle" ? "toggle" : state === "listening-click" ? "click" : "hold";
  if (state === "starting") return c.useVoice.setState({ phase: "starting", target: t.id, mode: "hold", notice: null });
  if (state === "working") return c.useVoice.setState({ phase: "transcribing", target: t.id, mode: "hold", partial: "Make the color of the button on the login page", notice: null });
  if (state === "done") {
    c.replaceRange(el, 0, el.value.length, "Then: ");
    const prev = el.value;
    c.insertText(t, "Make the color of the button on the login page blue and the error messages clearer.", "hold");
    return c.useVoice.setState({ notice: { kind: "done", target: t.id, at: Date.now(), undo: { value: prev, inserted: el.value } } });
  }
  if (state === "nothing") return c.useVoice.setState({ notice: { kind: "nothing", target: t.id, why: "silence", at: Date.now() } });
  await c.startListening(t, mode);
}

export function attach() {
  const w = window as unknown as Record<string, unknown>;
  w.__voice = {
    ...c,
    mockHeard,
    M,
    openOnboarding: () => import("../onboarding").then((o) => o.openOnboarding()),
    openSettings: () => import("../../store").then((s) => s.useStore.getState().openSettings("voice")),
    setVoicePrefs,
    updateMemory,
    getMemory,
    showState,
    /** Starts listening in the first composer (or `sel`). */
    start(sel = "textarea[data-voice]", mode: c.Mode = "hold") {
      const el = document.querySelector<HTMLTextAreaElement>(sel);
      const t = el && c.targetOf(el);
      if (t) void c.startListening(t, mode);
      return !!t;
    },
    state: () => c.useVoice.getState(),
    /** Opens a fresh chat (its composer is a voice target). */
    openChat: (cwd = "/Users/you/code/coool") => import("../actions").then((a) => a.newChat({ provider: "claude", cwd })),
    /** Types into a field the way a person would (React sees it). */
    type(text: string, sel = "textarea[data-voice]") {
      const el = document.querySelector<HTMLTextAreaElement>(sel);
      if (!el) return false;
      c.replaceRange(el, el.value.length, el.value.length, text);
      return true;
    },
  };
  const s = knob("voicestate");
  if (s) setTimeout(() => void showState(s), 600);
}
