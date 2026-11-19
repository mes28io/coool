import { markOnce } from "./lib/perfCount";
markOnce("coool-js");
import "./lib/boot";
import "./lib/animPause";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
// Pally is fetched at install time (licence forbids committing it); absent => Geist fallback.
import.meta.glob("./assets/fonts/pally/pally.css", { eager: true });
import App from "./App";
import { demoPage, GlyphsDemo, LedgerDemo, PlanDemo } from "./components/Demos";
import { initBackend } from "./lib/backend";
import { startBrowserAgent } from "./lib/browserAgent";
import { startPilot } from "./lib/pilot";
import { startPresence } from "./lib/presence";
import { onMotion, reducedMotion, setMotionHints } from "./lib/motion";
import { useChats } from "./lib/chat";
import { rememberModels } from "./lib/prefs";

// "Reduce motion: Auto" follows the device (Low Power Mode, heat, battery) as well as the system setting.
void initBackend().then((b) => {
  // The chat agents' browser tools (lib/browserAgent.ts).
  startBrowserAgent();
  // The device pilot's live steps in the chat (lib/pilot.ts).
  startPilot();
  // Agents' cursors and the beam in the device panels (lib/presence.ts); the page cursors follow Reduce motion too.
  startPresence();
  let reduce: boolean | null = null;
  const sendMotion = () => {
    if (reduce === reducedMotion()) return;
    reduce = reducedMotion();
    void b.presenceMotion(reduce).catch(() => {});
  };
  sendMotion();
  onMotion(sendMotion);
  b.onMotionHints(setMotionHints);
  void b.motionHints().then(setMotionHints);
  // The models chats report, for Settings > General's default model before any chat of that provider runs.
  useChats.subscribe((s, p) => {
    if (s.chats === p.chats) return;
    for (const c of Object.values(s.chats)) if (c.modelOptions.length && p.chats[c.id]?.modelOptions !== c.modelOptions) rememberModels(c.provider, c.modelOptions);
  });
});

// Wait for the bundled fonts so xterm measures Geist Mono, not a fallback.
Promise.all([
  initBackend(),
  document.fonts.load('14px "Geist Mono"').catch(() => {}),
  document.fonts.load('13px "Pally"').catch(() => {}),
  document.fonts.load('13px "Geist"').catch(() => {}),
]).then(() => {
  markOnce("coool-render");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {demoPage() === "ledger" ? <LedgerDemo /> : demoPage() === "plan" ? <PlanDemo /> : demoPage() === "glyphs" ? <GlyphsDemo /> : <App />}
    </StrictMode>,
  );
});

// Overlay scrollbars: mark a scroller while it scrolls so its thumb shows (see .scroll in styles.css).
{
  const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  document.addEventListener(
    "scroll",
    (e) => {
      const el = e.target as Element;
      if (!(el instanceof HTMLElement) || !el.classList.contains("scroll")) return;
      el.classList.add("is-scrolling");
      clearTimeout(timers.get(el));
      timers.set(el, setTimeout(() => el.classList.remove("is-scrolling"), 900));
    },
    true,
  );
}
