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
import { setMotionHints } from "./lib/motion";

// "Reduce motion: Auto" follows the device (Low Power Mode, heat, battery) as well as the system setting.
void initBackend().then((b) => {
  b.onMotionHints(setMotionHints);
  void b.motionHints().then(setMotionHints);
});

// Wait for the bundled fonts so xterm measures Geist Mono, not a fallback.
Promise.all([
  initBackend(),
  document.fonts.load('14px "Geist Mono"').catch(() => {}),
  document.fonts.load('13px "Pally"').catch(() => {}),
  document.fonts.load('13px "Geist"').catch(() => {}),
]).then(() => {
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
