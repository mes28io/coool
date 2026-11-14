// The parts of the terminal layer that the rest of the app needs eagerly.
// Everything that imports xterm.js lives in ./terminals and is loaded lazily.

type Theme = "dark" | "light";
let theme: Theme = "dark";
const subs = new Set<(t: Theme) => void>();

export function setTerminalTheme(t: Theme) {
  theme = t;
  subs.forEach((f) => f(t));
}
export const terminalTheme = () => theme;
export function onTerminalTheme(f: (t: Theme) => void) {
  subs.add(f);
  return () => subs.delete(f);
}

/** Rough PTY size for a fresh launch, before a terminal has been fitted. */
export function estimateSize(): { rows: number; cols: number } {
  const main = document.querySelector("[data-main]") as HTMLElement | null;
  const w = (main?.clientWidth ?? window.innerWidth - 280) - 48;
  const h = (main?.clientHeight ?? window.innerHeight) - 210;
  return { cols: Math.max(60, Math.floor(w / 7.6)), rows: Math.max(16, Math.floor(h / 15.3)) };
}
