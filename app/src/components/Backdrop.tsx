// "Window backdrop: Colours" (Settings > Appearance, lib/glass.ts): coool's own field of soft colour behind the whole
// window, under the glass tint. It shows only where the page is see-through (the title bar and icon rail, and the
// device panels' background through the holes in the sheet); the sheet, the chat and the device screens stay opaque
// above it. Pure CSS (the theme's `--backdrop` gradients), drawn once and never animated, so it costs nothing while
// the window sits still.

import { backdropShown, useGlass } from "../lib/glass";

export function Backdrop() {
  const shown = backdropShown(useGlass());
  if (!shown) return null;
  return <div className="pointer-events-none fixed inset-0 z-[-1]" style={{ background: "var(--backdrop)" }} aria-hidden data-backdrop-layer />;
}
