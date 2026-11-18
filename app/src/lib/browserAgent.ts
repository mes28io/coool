// A chat's agent driving its Browser panel (APP_SPEC "Agent browser tools"; app/src-tauri/src/device/web.rs).
//
// - Sync: every chat's browser tabs (which is active, the webview of each) go to the backend whenever they change, so
//   the agent's `browser_*` tools act on the tab the person sees.
// - Requests: the tools ask the panel to open a page (`open`, showing the panel), open a `new` tab, `switch` or `close`
//   one, or bring back the webview of the active tab (`ensure`). Answered here, outside React: the chat's view may not
//   be on screen, and then the page opens hidden at the panel's size (`ensureNative`).
// - Activity: what the agent just did, per chat, for the panel's "Agent is browsing" mark and the header's globe.

import { useEffect, useState } from "react";
import { create } from "zustand";
import { useStore, type BrowserTabs } from "../store";
import { api, type BrowserActivity, type BrowserAgentRequest, type BrowserAgentTab } from "./backend";
import { closeNative, ensureNative, nativeId, onNatives, tabKey, useBrowserState } from "./browser";
import { sessionKey } from "./types";

/** The panel key (as in `store.rightPanel`) of a chat's session view (the same rule as `resolveTarget`). */
export function chatPanelKey(chat: number): string {
  const st = useStore.getState();
  const key = st.chatOwner[chat];
  if (key && st.allSessions.some((s) => sessionKey(s) === key)) return key;
  return `chat:${chat}`;
}

/** The chat a panel key belongs to, if any. */
function panelChat(key: string): number | null {
  if (key.startsWith("chat:")) return Number(key.slice(5));
  const s = useStore.getState().allSessions.find((x) => sessionKey(x) === key);
  return s?.chat ?? null;
}

/** The latest agent action per chat (for ~3 s it shows as "Agent is browsing"). */
export const useBrowserAgent = create<{ byChat: Record<number, BrowserActivity & { at: number }> }>(() => ({ byChat: {} }));

/** The chat's latest agent action on its browser while it is recent (`ms`), else null; re-renders when it expires. */
export function useAgentBrowsing(chat: number | null | undefined, ms = 3000): (BrowserActivity & { at: number }) | null {
  const a = useBrowserAgent((s) => (chat == null ? undefined : s.byChat[chat]));
  // The `at` of the action that has expired.
  const [expired, setExpired] = useState<number | null>(null);
  useEffect(() => {
    if (!a) return;
    const t = setTimeout(() => setExpired(a.at), Math.max(0, a.at + ms - Date.now()));
    return () => clearTimeout(t);
  }, [a, ms]);
  return a && expired !== a.at ? a : null;
}

function tabsOf(key: string, b: BrowserTabs | undefined): { tabs: BrowserAgentTab[]; active: number | null } {
  if (!b) return { tabs: [], active: null };
  const states = useBrowserState.getState().byKey;
  return {
    tabs: b.tabs.map((t) => {
      const k = tabKey(key, t.id);
      const web = t.page.kind === "web";
      return { tab: t.id, kind: web ? "web" : "start", id: web ? nativeId(k) : null, url: web ? states[k]?.url || t.url || (t.page.kind === "web" ? t.page.url : "") : "", title: states[k]?.title || t.title || "" };
    }),
    active: b.tabs.length ? b.active : null,
  };
}

const sent = new Map<number, string>();
let queued = false;
function sync() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    const st = useStore.getState();
    const chats = new Set<number>(sent.keys());
    for (const key of Object.keys(st.browser)) {
      const c = panelChat(key);
      if (c !== null) chats.add(c);
    }
    for (const chat of chats) {
      const key = chatPanelKey(chat);
      const { tabs, active } = tabsOf(key, st.browser[key]);
      const body = JSON.stringify([tabs, active]);
      if (sent.get(chat) === body) continue;
      if (!tabs.length) sent.delete(chat);
      else sent.set(chat, body);
      void api()
        .browserAgentSync(chat, tabs, active)
        .catch(() => {});
    }
  });
}

/** The web tab `tab` of `key`'s panel, with a webview (opened hidden if no panel shows it). */
function ensure(key: string, tab: number) {
  const t = useStore.getState().browser[key]?.tabs.find((x) => x.id === tab);
  if (t?.page.kind === "web") ensureNative(tabKey(key, t.id), t.page);
}

function handle(r: BrowserAgentRequest) {
  const key = chatPanelKey(r.chat);
  const st = useStore.getState();
  switch (r.op) {
    case "open": {
      // Asked when the panel has no page: a new tab's start view becomes the page (else a new tab); the panel shows.
      st.openBrowser(key, { kind: "web", url: r.url });
      const b = useStore.getState().browser[key];
      if (b) ensure(key, b.active);
      break;
    }
    case "new": {
      st.openBrowser(key, { kind: "web", url: r.url }, { fresh: true });
      const b = useStore.getState().browser[key];
      if (b) ensure(key, b.active);
      break;
    }
    case "switch":
      st.selectBrowserTab(key, r.tab);
      ensure(key, r.tab);
      break;
    case "ensure":
      ensure(key, r.tab);
      break;
    case "close":
      closeNative(tabKey(key, r.tab));
      st.closeBrowserTab(key, r.tab);
      break;
  }
  sync();
}

let started = false;
/** Wires the sync, the requests and the activity (once, at startup). */
export function startBrowserAgent() {
  if (started || !api().nativeBrowser) return;
  started = true;
  useStore.subscribe((s, prev) => {
    if (s.browser !== prev.browser || s.chatOwner !== prev.chatOwner || s.allSessions !== prev.allSessions) sync();
  });
  useBrowserState.subscribe(sync);
  onNatives(sync);
  api().onBrowserAgent(handle);
  api().onBrowserActivity((a) => useBrowserAgent.setState((s) => ({ byChat: { ...s.byChat, [a.chat]: { ...a, at: Date.now() } } })));
  sync();
}
