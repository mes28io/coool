import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import { initBackend } from "./lib/backend";

// Wait for the bundled fonts so xterm measures Geist Mono, not a fallback.
Promise.all([
  initBackend(),
  document.fonts.load('12.5px "Geist Mono"').catch(() => {}),
  document.fonts.load('13px "Geist"').catch(() => {}),
]).then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
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
