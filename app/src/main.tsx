import { markOnce } from "./lib/perfCount";
markOnce("coool-js");
import "./lib/boot";
import "./lib/animPause";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
// Pally is fetched at install time (licence forbids committing it); absent => Geist fallback.
import.meta.glob("./assets/fonts/pally/pally.css", { eager: true });
import App from "./App";
// The menu bar item's browser demo (`?menubar=idle|busy|needs|none`), loaded only when asked for.
const MenuBarDemo = lazy(() => import("./components/MenuBarDemo").then((m) => ({ default: m.MenuBarDemo })));
import { demoPage, GlyphsDemo, LedgerDemo, PlanDemo } from "./components/Demos";
import { initBackend } from "./lib/backend";
import { startBrowserAgent } from "./lib/browserAgent";
import { startPilot } from "./lib/pilot";
import { startPresence } from "./lib/presence";
import { startLaneLog } from "./lib/laneLog";
import { onMotion, reducedMotion, setMotionHints } from "./lib/motion";
import { useChats } from "./lib/chat";
import { rememberModels, seenModelsNow } from "./lib/prefs";
import { setLadderStatus } from "./lib/ladder";

// "Reduce motion: Auto" follows the device (Low Power Mode, heat, battery) as well as the system setting.
void initBackend().then((b) => {
  // The chat agents' browser tools (lib/browserAgent.ts).
  startBrowserAgent();
  // The device pilot's live steps in the chat (lib/pilot.ts).
  startPilot();
  // Agents' cursors and the beam in the device panels (lib/presence.ts); the page cursors follow Reduce motion too.
  startPresence();
  // What each session was doing and when, for Mission control's agent lanes (lib/laneLog.ts).
  startLaneLog();
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
  // Ladder: which CLIs are installed and logged in, and Codex's models, for the cross-provider and image lanes.
  const ladderStatus = () =>
    void b.ladderStatus().then((st) => {
      setLadderStatus(st);
      if (st?.codex.installed && st.codex_models.length && !seenModelsNow().codex.length) rememberModels("codex", st.codex_models);
    });
  ladderStatus();
  setInterval(ladderStatus, 10 * 60_000);
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
      {/[?&]menubar=/.test(location.search) ? (
        <Suspense fallback={null}>
          <MenuBarDemo />
        </Suspense>
      ) : demoPage() === "ledger" ? <LedgerDemo /> : demoPage() === "plan" ? <PlanDemo /> : demoPage() === "glyphs" ? <GlyphsDemo /> : <App />}
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
