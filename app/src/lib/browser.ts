// The in-app browser's native side, outside React (APP_SPEC "Browser panel").
//
// Each session's browser panel (by panel key, as in `store.rightPanel`) owns at most one native child webview
// (app/src-tauri/src/browser.rs). It outlives the SessionView that shows it (only the active tab is mounted), so it
// lives here: shown and laid over the panel while the panel shows a web page, hidden otherwise, closed by the
// panel's own close button (or by the backend when too many are alive).
//
// A native view sits above every HTML element of the app, so anything that would draw over the panel hides it:
// sheets and the palette (checked by the panel), and popovers (registered by `Popover` in lib/overlays.ts).

import { createContext, useContext } from "react";
import { create } from "zustand";
import { useStore, type BrowserPage } from "../store";
import { api, type BrowserBounds, type BrowserState } from "./backend";

interface Native {
  id: string | null;
  /** The open (`BrowserPage.n`) it shows. */
  n: number;
  /** The newest open asked for. */
  page: Extract<BrowserPage, { kind: "web" }>;
  /** Last bounds sent, and newer ones waiting for the call in flight (calls are serialized so they land in order). */
  sent: BrowserBounds | null;
  want: BrowserBounds;
  busy: boolean;
  dead: boolean;
}

const natives = new Map<string, Native>();

/** What each panel's page reports (URL, title, history), by panel key. */
export const useBrowserState = create<{ byKey: Record<string, BrowserState> }>(() => ({ byKey: {} }));
/** The visible native views' rects, by panel key (toasts move out of their way). */
export const useNativeRects = create<{ byKey: Record<string, BrowserBounds> }>(() => ({ byKey: {} }));

const keyOf = (id: string) => [...natives].find(([, n]) => n.id === id)?.[0];
const forget = (key: string) => {
  natives.delete(key);
  useBrowserState.setState((s) => {
    const byKey = { ...s.byKey };
    delete byKey[key];
    return { byKey };
  });
  setRect(key, null);
};
function setRect(key: string, b: BrowserBounds | null) {
  const cur = useNativeRects.getState().byKey[key];
  if (!b?.visible && !cur) return;
  if (b?.visible && cur && same(cur, b)) return;
  useNativeRects.setState((s) => {
    const byKey = { ...s.byKey };
    if (b?.visible) byKey[key] = b;
    else delete byKey[key];
    return { byKey };
  });
}

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  api().onBrowserState((s) => {
    const key = keyOf(s.id);
    if (key) useBrowserState.setState((st) => ({ byKey: { ...st.byKey, [key]: s } }));
  });
  api().onBrowserClosed((id) => {
    const key = keyOf(id);
    if (key) forget(key);
  });
}

const same = (a: BrowserBounds, b: BrowserBounds) => a.visible === b.visible && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

function flush(key: string, nat: Native) {
  if (nat.busy || nat.dead || !nat.id) return;
  const b = nat.want;
  // Hidden twice is hidden: no need to resend a rect nobody sees.
  if (nat.sent && (same(nat.sent, b) || (!nat.sent.visible && !b.visible))) return;
  nat.busy = true;
  nat.sent = b;
  setRect(key, b);
  api()
    .browserBounds(nat.id, b)
    .catch(() => {})
    .finally(() => {
      nat.busy = false;
      flush(key, nat);
    });
}

/** Loads the newest requested open, once the webview exists. */
function navigate(nat: Native) {
  if (!nat.id || nat.n === nat.page.n) return;
  nat.n = nat.page.n;
  void api()
    .browserNavigate(nat.id, nat.page.url)
    .catch((e) => useStore.getState().toast(`Couldn't open the page: ${e}`, "error"));
}

/** Lays panel `key`'s webview over `b`, opening it (or loading `page` in it) as needed. */
export function place(key: string, page: Extract<BrowserPage, { kind: "web" }>, b: BrowserBounds) {
  wire();
  const nat = natives.get(key);
  if (!nat) {
    const fresh: Native = { id: null, n: page.n, page, sent: b, want: b, busy: true, dead: false };
    natives.set(key, fresh);
    setRect(key, b);
    api()
      .browserOpen(page.url, b)
      .then((id) => {
        fresh.id = id;
        fresh.busy = false;
        if (fresh.dead) return void api().browserClose(id);
        navigate(fresh);
        flush(key, fresh);
      })
      .catch((e) => {
        forget(key);
        useStore.getState().toast(`Couldn't open the page: ${e}`, "error");
      });
    return;
  }
  nat.want = b;
  nat.page = page;
  navigate(nat);
  flush(key, nat);
}

/** Hides panel `key`'s webview (it keeps its page and history). */
export function hide(key: string) {
  const nat = natives.get(key);
  if (!nat) return;
  nat.want = { ...nat.want, visible: false };
  flush(key, nat);
}

/** Closes panel `key`'s webview for good. */
export function closeNative(key: string) {
  const nat = natives.get(key);
  if (!nat) return;
  nat.dead = true;
  forget(key);
  if (nat.id) void api().browserClose(nat.id).catch(() => {});
}

export const nativeId = (key: string) => natives.get(key)?.id ?? null;

// ---------- overlays ----------

export { onOverlays, overlayCovers, registerOverlay } from "./overlays";

// ---------- opening pages from anywhere in a session view ----------

export type OpenPage = Extract<BrowserPage, { kind: "artifact" }> | { kind: "web"; url: string };
/** Shows a page in the browser panel of the session view around it (provided by SessionView). */
export const BrowserContext = createContext<((p: OpenPage) => void) | null>(null);

/** Only http(s) links open in the browser panel. */
export function webUrl(href: string | undefined | null): string | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Opens a page in this session's browser panel; outside a session view, web pages go to the system browser when the opener allows them (claude.ai). */
export function useOpenPage(): (p: OpenPage) => void {
  const ctx = useContext(BrowserContext);
  return (p) => {
    if (ctx) return ctx(p);
    if (p.kind === "web") void api().openArtifact(p.url).catch(() => {});
  };
}
