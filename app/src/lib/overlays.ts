// Popovers and menus on screen, for the in-app browser: a native webview draws above every HTML element, so one
// that a popover overlaps hides while the popover is open (lib/browser.ts, components/BrowserPanel.tsx).

const overlays = new Set<HTMLElement>();
const listeners = new Set<() => void>();

export function registerOverlay(el: HTMLElement): () => void {
  overlays.add(el);
  listeners.forEach((f) => f());
  return () => {
    overlays.delete(el);
    listeners.forEach((f) => f());
  };
}

export function onOverlays(f: () => void): () => void {
  listeners.add(f);
  return () => void listeners.delete(f);
}

export function overlayCovers(r: { left: number; top: number; right: number; bottom: number }): boolean {
  for (const el of overlays) {
    const o = el.getBoundingClientRect();
    if (o.left < r.right && o.right > r.left && o.top < r.bottom && o.bottom > r.top) return true;
  }
  return false;
}
