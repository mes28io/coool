// The browser mock's handle on voice (`window.__voice`), for scripted demos and screenshots: start listening in the
// first composer, queue what the mock "hears", read the state. Loaded only by the mock (VoiceHost), never in the app.

import { mockHeard } from "./api.ts";
import * as c from "./controller.ts";
import * as M from "./memory.ts";
import { getMemory, setVoicePrefs, updateMemory } from "./prefs.ts";

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
}
