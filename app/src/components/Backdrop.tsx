// "Window backdrop: Colours" (Settings > Appearance, lib/glass.ts): coool's own field of soft colour behind the whole
// window, under the glass tint. It shows only where the page is see-through (the title bar and icon rail, and the
// right panels' background through the holes in the sheet); the sheet, the chat and the device screens stay opaque
// above it. Two layers of blobs (styles.css `--backdrop-a` / `--backdrop-b`) drift slowly against each other by
// `transform` alone: painted once, moved on the compositor. The drift rests under reduce motion (styles.css) and
// while the window is hidden or not in front, when nobody is looking at it.

import { useEffect, useState } from "react";
import { backdropShown, useGlass } from "../lib/glass";

export function Backdrop() {
  const shown = backdropShown(useGlass());
  const [rest, setRest] = useState(() => typeof document !== "undefined" && (document.hidden || !document.hasFocus()));
  useEffect(() => {
    if (!shown) return;
    const read = () => setRest(document.hidden || !document.hasFocus());
    read();
    document.addEventListener("visibilitychange", read);
    window.addEventListener("focus", read);
    window.addEventListener("blur", read);
    return () => {
      document.removeEventListener("visibilitychange", read);
      window.removeEventListener("focus", read);
      window.removeEventListener("blur", read);
    };
  }, [shown]);
  if (!shown) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[-1] overflow-hidden" style={{ background: "var(--backdrop-base)" }} aria-hidden data-backdrop-layer data-backdrop-rest={rest || undefined}>
      <div className="backdrop-layer" style={{ background: "var(--backdrop-a)" }} />
      <div className="backdrop-layer" style={{ background: "var(--backdrop-b)" }} />
    </div>
  );
}
