// The in-app browser's native side, outside React (APP_SPEC "Browser panel").
//
// Each tab of a session's browser panel (by tab key: the panel key, as in `store.rightPanel`, plus the tab id) owns at
// most one native child webview (app/src-tauri/src/browser.rs). It outlives the SessionView that shows it (only the
// active pane tab and the active browser tab are mounted), so it lives here: shown and laid over the panel while its
// tab shows, hidden otherwise, closed with its tab or the panel's close button, or by the backend when too many are
// alive (then the tab remembers where it was and loads that again when it shows).
//
// A native view sits above every HTML element of the app, so anything that would draw over the panel hides it:
// sheets and the palette (checked by the panel), and popovers (registered by `Popover` in lib/overlays.ts).

import { createContext, useContext } from "react";
import { create } from "zustand";
import { onPanelRekey, useStore, type BrowserPage } from "../store";
import { api, type BrowserBounds, type BrowserState } from "./backend";
import type { ArtifactInfo } from "./types";

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
/** Told when a tab's webview appears or goes (lib/browserAgent.ts reports them to the backend). */
const nativeListeners = new Set<() => void>();
const nativesChanged = () => nativeListeners.forEach((f) => f());
export function onNatives(cb: () => void): () => void {
  nativeListeners.add(cb);
  return () => nativeListeners.delete(cb);
}
/** Tabs whose webview the backend closed (too many alive): where they were, for the open `n` they had. */
const resume = new Map<string, { url: string; n: number }>();

/** The key of a browser tab's webview. */
export const tabKey = (panelKey: string, tab: number) => `${panelKey}#tab${tab}`;
const splitKey = (key: string): [string, number] | null => {
  const i = key.lastIndexOf("#tab");
  return i < 0 ? null : [key.slice(0, i), Number(key.slice(i + 4))];
};
/** `rec` with every key of panel `from`'s tabs (`from#tabN`) renamed to `to#tabN`; `rec` itself when none. */
export function rekeyTabs<T>(rec: Record<string, T>, from: string, to: string): Record<string, T> {
  const p = `${from}#tab`;
  if (!Object.keys(rec).some((k) => k.startsWith(p))) return rec;
  return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k.startsWith(p) ? `${to}#tab${k.slice(p.length)}` : k, v]));
}

// A new chat's panel moves to its session's key (store.movePanels): its tabs' webviews, states and rects go along,
// so the page stays on screen and the agent keeps acting on it.
onPanelRekey((from, to) => {
  const p = `${from}#tab`;
  for (const m of [natives, resume] as Map<string, unknown>[]) {
    // A copy: the map changes as it goes.
    for (const [k, v] of Array.from(m)) {
      if (!k.startsWith(p)) continue;
      m.delete(k);
      m.set(`${to}#tab${k.slice(p.length)}`, v);
    }
  }
  useBrowserState.setState((s) => ({ byKey: rekeyTabs(s.byKey, from, to) }));
  useNativeRects.setState((s) => ({ byKey: rekeyTabs(s.byKey, from, to) }));
  nativesChanged();
});

/** The tab key of the tab a session's browser shows. */
export function activeTabKey(panelKey: string): string | null {
  const b = useStore.getState().browser[panelKey];
  return b ? tabKey(panelKey, b.active) : null;
}

/** What each tab's page reports (URL, title, history), by tab key. */
export const useBrowserState = create<{ byKey: Record<string, BrowserState> }>(() => ({ byKey: {} }));
/** The visible native views' rects, by panel key (toasts move out of their way). */
export const useNativeRects = create<{ byKey: Record<string, BrowserBounds> }>(() => ({ byKey: {} }));

const keyOf = (id: string) => [...natives].find(([, n]) => n.id === id)?.[0];
const forget = (key: string) => {
  natives.delete(key);
  nativesChanged();
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
    if (!key) return;
    useBrowserState.setState((st) => ({ byKey: { ...st.byKey, [key]: s } }));
    const k = splitKey(key);
    if (k) useStore.getState().noteBrowserTab(k[0], k[1], s.url, s.title);
  });
  api().onBrowserClosed((id) => {
    const key = keyOf(id);
    if (!key) return;
    const nat = natives.get(key)!;
    const url = useBrowserState.getState().byKey[key]?.url || nat.page.url;
    resume.set(key, { url, n: nat.n });
    forget(key);
  });
  // `target=_blank` and `window.open` without a size: a new tab next to the page's own.
  api().onBrowserNewTab(({ id, url }) => {
    const key = keyOf(id);
    const k = key && splitKey(key);
    if (k) useStore.getState().openBrowser(k[0], { kind: "web", url }, { after: k[1], fresh: true });
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

/** Lays tab `key`'s webview over `b`, opening it (or loading `page` in it) as needed. */
export function place(key: string, page: Extract<BrowserPage, { kind: "web" }>, b: BrowserBounds) {
  wire();
  const nat = natives.get(key);
  if (!nat) {
    // Closed by the backend while hidden: back where it was, unless another page was asked for since.
    const back = resume.get(key);
    resume.delete(key);
    const url = back && back.n === page.n ? back.url : page.url;
    const fresh: Native = { id: null, n: page.n, page, sent: b, want: b, busy: true, dead: false };
    natives.set(key, fresh);
    setRect(key, b);
    api()
      .browserOpen(url, b)
      .then((id) => {
        fresh.id = id;
        fresh.busy = false;
        if (fresh.dead) return void api().browserClose(id);
        nativesChanged();
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

/** Hides tab `key`'s webview (it keeps its page and history). */
export function hide(key: string) {
  const nat = natives.get(key);
  if (!nat) return;
  nat.want = { ...nat.want, visible: false };
  flush(key, nat);
}

/** Closes tab `key`'s webview for good. */
export function closeNative(key: string) {
  resume.delete(key);
  const nat = natives.get(key);
  if (!nat) return;
  nat.dead = true;
  forget(key);
  if (nat.id) void api().browserClose(nat.id).catch(() => {});
}

export const nativeId = (key: string) => natives.get(key)?.id ?? null;

/**
 * Makes sure tab `key` has a webview, for the chat's agent: when no panel shows it (another pane tab is in front,
 * the pane is too narrow), it opens hidden at the panel's usual size, so the agent's tools work without the page on
 * screen. A panel that shows it later just moves it into place.
 */
export function ensureNative(key: string, page: Extract<BrowserPage, { kind: "web" }>) {
  if (natives.has(key)) return;
  const w = useStore.getState().browserWidth;
  const h = Math.max(400, window.innerHeight - 120);
  place(key, page, { x: Math.max(0, window.innerWidth - w), y: 100, w, h, visible: false });
}

// ---------- overlays ----------

export { onOverlays, overlayCovers, registerOverlay } from "./overlays";

// ---------- opening pages from anywhere in a session view ----------

export type OpenPage = { kind: "web"; url: string };
/** Shows a page in a tab of the browser panel of the session view around it (provided by SessionView). */
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

/** Opens a page in a tab of this session's browser panel; outside a session view, web pages go to the system browser when the opener allows them (claude.ai). */
export function useOpenPage(): (p: OpenPage) => void {
  const ctx = useContext(BrowserContext);
  return (p) => {
    if (ctx) return ctx(p);
    void api().openArtifact(p.url).catch(() => {});
  };
}

/** Opens an artifact's local copy in its preview window; when that copy is gone, `fallback` (its claude.ai page in a tab). */
export function previewArtifact(url: string, fallback?: () => void) {
  void api()
    .artifactWindow(url)
    .then((ok) => {
      if (ok) return;
      if (fallback) fallback();
      else useStore.getState().toast("The copy saved on this Mac is gone: open the claude.ai page instead");
    })
    .catch((e) => useStore.getState().toast(`Couldn't open the preview: ${e}`, "error"));
}

/** What the address field accepts: an http(s) URL, or a bare domain / host[:port][/path] (https:// is added). */
export function addressUrl(text: string): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  // A scheme (but not `host:port`, which also looks like one).
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^/:]+:\d+(\/|$)/.test(t)) return webUrl(t);
  const u = webUrl(`https://${t}`);
  if (!u) return null;
  // A bare word is not a site: a dot in the host (example.com), localhost or an IP.
  const h = new URL(u).hostname;
  return h.includes(".") || h === "localhost" || h.startsWith("[") ? u : null;
}

/** A page this chat mentions, for the browser's start view. */
export type RecentPage = { kind: "artifact"; info: ArtifactInfo; versions: number } | { kind: "web"; url: string };

const LINK = /https?:\/\/[^\s<>()"'`[\]{}]+/g;

/** The chat's artifacts (newest publish of each) and the http(s) links in its messages, newest first, each once. */
export function recentPages(entries: { text?: string; artifact?: ArtifactInfo }[], max = 12): RecentPage[] {
  const versions = new Map<string, number>();
  for (const e of entries) if (e.artifact) versions.set(e.artifact.url, Math.max((versions.get(e.artifact.url) ?? 0) + 1, e.artifact.version ?? 0));
  const out: RecentPage[] = [];
  const seen = new Set<string>();
  for (let i = entries.length - 1; i >= 0 && out.length < max; i--) {
    const e = entries[i];
    if (e.artifact) {
      if (!seen.has(e.artifact.url)) {
        seen.add(e.artifact.url);
        out.push({ kind: "artifact", info: e.artifact, versions: versions.get(e.artifact.url) ?? 1 });
      }
      continue;
    }
    const links = [...(e.text ?? "").matchAll(LINK)].map((m) => m[0].replace(/[.,;:!?*_~]+$/, ""));
    for (let j = links.length - 1; j >= 0 && out.length < max; j--) {
      const u = webUrl(links[j]);
      if (!u || seen.has(u) || seen.has(links[j])) continue;
      seen.add(u);
      seen.add(links[j]);
      out.push({ kind: "web", url: u });
    }
  }
  return out;
}
