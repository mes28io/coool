// The one store. Backend events are the only source of truth for sessions;
// everything else here is UI state (tabs, splits, theme, overlays).

import { create } from "zustand";
import type { ChatInfo, Environment, Provider, PtyInfo, Session, Snapshot } from "./lib/types";
import { sessionKey } from "./lib/types";

export type Target = { kind: "session"; key: string } | { kind: "pty"; id: number } | { kind: "chat"; id: number };
export type Leaf = { type: "leaf"; id: string; target: Target | null };
export type Split = { type: "split"; id: string; dir: "row" | "col"; a: Node; b: Node; ratio: number };
export type Node = Leaf | Split;
export interface Tab {
  id: string;
  root: Node;
  focus: string;
}
export type ViewMode = "activity" | "terminal";
export type ThemePref = "system" | "dark" | "light";
export type Sheet =
  | null
  | { kind: "new"; cwd?: string; provider?: Provider }
  | { kind: "quit"; running: number }
  | { kind: "stop"; label: string; managed: number | null; pid: number | null; chat?: number | null }
  | { kind: "settings" };

/**
 * When the UI saw a session's status / current tool change. `observed` is
 * false for values that were already set when the app first saw the session:
 * those times are estimates (from `updated`) and must not be shown as precise.
 */
export interface Since {
  status: string;
  current: string | null;
  statusAt: number;
  currentAt: number;
  observed: boolean;
  currentObserved: boolean;
}

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
}

const MAX_PANES = 4;
let uid = 0;
const nid = (p: string) => `${p}${++uid}`;

export const targetId = (t: Target) => (t.kind === "session" ? `s:${t.key}` : t.kind === "pty" ? `p:${t.id}` : `c:${t.id}`);
const sameTarget = (a: Target | null, b: Target) => !!a && targetId(a) === targetId(b);

export function leaves(n: Node): Leaf[] {
  return n.type === "leaf" ? [n] : [...leaves(n.a), ...leaves(n.b)];
}
function mapNode(n: Node, f: (l: Leaf) => Node): Node {
  if (n.type === "leaf") return f(n);
  return { ...n, a: mapNode(n.a, f), b: mapNode(n.b, f) };
}
function removeLeaf(n: Node, id: string): Node | null {
  if (n.type === "leaf") return n.id === id ? null : n;
  const a = removeLeaf(n.a, id);
  const b = removeLeaf(n.b, id);
  if (!a) return b;
  if (!b) return a;
  return { ...n, a, b };
}

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem("coool.theme");
    if (v === "dark" || v === "light") return v;
  } catch {}
  return "system";
}
const systemTheme = () => (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
function readNum(k: string, d: number) {
  try {
    const v = Number(localStorage.getItem(k));
    return Number.isFinite(v) && v > 0 ? v : d;
  } catch {
    return d;
  }
}

interface State {
  /** A real sessions payload has arrived (until then: skeletons, never the empty state). */
  ready: boolean;
  /** Backend is still parsing transcripts in the background (Snapshot.loading). */
  loading: boolean;
  sessions: Session[];
  pending: number[];
  ptys: Record<number, PtyInfo>;
  /** pty id -> session key, remembered after the PTY exits. */
  ptyOwner: Record<number, string>;
  /** session key -> most recent pty id that ran it. */
  sessionPty: Record<string, number>;
  exited: Record<number, boolean>;
  env: Environment | null;
  chatInfos: Record<number, ChatInfo>;
  /** chat id -> session key, once discovery linked them (Session.chat). */
  chatOwner: Record<number, string>;
  /** Running chats with no session yet. */
  pendingChats: number[];
  since: Record<string, Since>;

  tabs: Tab[];
  activeTab: string | null;
  modes: Record<string, ViewMode>;

  themePref: ThemePref;
  theme: "dark" | "light";
  palette: boolean;
  sheet: Sheet;
  toasts: Toast[];
  sidebarWidth: number;

  setSnapshot(s: Snapshot): void;
  setEnv(e: Environment): void;
  markExited(id: number): void;
  open(t: Target, opts?: { newTab?: boolean }): void;
  focusPane(tab: string, leaf: string): void;
  setPaneTarget(leaf: string, t: Target): void;
  split(dir: "row" | "col"): void;
  closePane(leaf: string): void;
  closeTab(tab: string): void;
  closeFocused(): void;
  activate(tab: string | null): void;
  activateIndex(i: number): void;
  reorder(ids: string[]): void;
  setRatio(split: string, r: number): void;
  setMode(target: Target, m: ViewMode): void;
  /** Remember a PTY for a session before the next snapshot links it. */
  notePty(key: string, id: number): void;
  setThemePref(p: ThemePref): void;
  toggleTheme(): void;
  setSystemTheme(): void;
  setPalette(v: boolean): void;
  setSheet(s: Sheet): void;
  toast(text: string, tone?: Toast["tone"]): void;
  dismissToast(id: number): void;
  setSidebarWidth(w: number): void;
}

/** Swap pty / chat targets for the session they turned into, once the backend linked them. */
function normalizeTabs(tabs: Tab[], owner: Record<number, string>, chatOwner: Record<number, string>): Tab[] {
  let changed = false;
  const next = tabs.map((tab) => {
    const root = mapNode(tab.root, (l) => {
      if (l.target?.kind === "pty" && owner[l.target.id]) {
        changed = true;
        return { ...l, target: { kind: "session", key: owner[l.target.id] } };
      }
      if (l.target?.kind === "chat" && chatOwner[l.target.id]) {
        changed = true;
        return { ...l, target: { kind: "session", key: chatOwner[l.target.id] } };
      }
      return l;
    });
    return root === tab.root ? tab : { ...tab, root };
  });
  return changed ? next : tabs;
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  loading: false,
  sessions: [],
  pending: [],
  ptys: {},
  ptyOwner: {},
  sessionPty: {},
  exited: {},
  env: null,
  chatInfos: {},
  chatOwner: {},
  pendingChats: [],
  since: {},
  tabs: [],
  activeTab: null,
  modes: {},
  themePref: readPref(),
  theme: readPref() === "system" ? systemTheme() : (readPref() as "dark" | "light"),
  palette: false,
  sheet: null,
  toasts: [],
  sidebarWidth: readNum("coool.sidebar", 272),

  setSnapshot(snap) {
    const st = get();
    const ptyOwner = { ...st.ptyOwner };
    const sessionPty = { ...st.sessionPty };
    for (const s of snap.sessions) {
      if (s.managed !== null) {
        ptyOwner[s.managed] = sessionKey(s);
        sessionPty[sessionKey(s)] = s.managed;
      }
    }
    const ptys: Record<number, PtyInfo> = { ...st.ptys };
    for (const p of snap.ptys ?? []) ptys[p.id] = p;
    const chatOwner = { ...st.chatOwner };
    for (const s of snap.sessions) if (s.chat != null) chatOwner[s.chat] = sessionKey(s);
    const chatInfos: Record<number, ChatInfo> = { ...st.chatInfos };
    for (const c of snap.chats ?? []) chatInfos[c.id] = c;
    const linkedChats = new Set(snap.sessions.map((s) => s.chat).filter((c) => c != null));
    const pendingChats = (snap.chats ?? []).filter((c) => c.running && !linkedChats.has(c.id)).map((c) => c.id);
    // Status / tool change times as observed here (see Since).
    const now = Date.now();
    const since: Record<string, Since> = {};
    const first = !st.ready;
    for (const s of snap.sessions) {
      const k = sessionKey(s);
      const prev = st.since[k];
      if (!prev) {
        // First sight: we don't know when it started; `updated` (last transcript write) is the best guess.
        const guess = Math.min(now, s.updated || now);
        since[k] = { status: s.status, current: s.current, statusAt: guess, currentAt: guess, observed: !first, currentObserved: !first };
      } else {
        const sc = prev.status !== s.status;
        const cc = prev.current !== s.current;
        since[k] = {
          status: s.status,
          current: s.current,
          statusAt: sc ? now : prev.statusAt,
          currentAt: cc || sc ? now : prev.currentAt,
          observed: sc ? true : prev.observed,
          currentObserved: cc || sc ? true : prev.currentObserved,
        };
      }
    }
    // Keep terminal mode as the default for anything coool launched.
    const modes = { ...st.modes };
    for (const [pid, key] of Object.entries(ptyOwner)) {
      const pm = modes[`p:${pid}`];
      if (pm && !modes[`s:${key}`]) modes[`s:${key}`] = pm;
    }
    set({
      ready: true,
      loading: !!snap.loading,
      sessions: snap.sessions,
      pending: snap.pending,
      ptys,
      ptyOwner,
      sessionPty,
      modes,
      chatOwner,
      chatInfos,
      pendingChats,
      since,
      tabs: normalizeTabs(st.tabs, ptyOwner, chatOwner),
    });
  },
  setEnv: (env) => set({ env }),
  markExited: (id) => set((s) => ({ exited: { ...s.exited, [id]: true } })),

  open(t, opts) {
    const { tabs, activeTab } = get();
    let target = t;
    if (t.kind === "pty" && get().ptyOwner[t.id]) target = { kind: "session", key: get().ptyOwner[t.id] };
    if (t.kind === "chat" && get().chatOwner[t.id]) target = { kind: "session", key: get().chatOwner[t.id] };
    // Already visible somewhere: go there.
    for (const tab of tabs) {
      const hit = leaves(tab.root).find((l) => sameTarget(l.target, target));
      if (hit) return set({ activeTab: tab.id, tabs: tabs.map((x) => (x.id === tab.id ? { ...x, focus: hit.id } : x)) });
    }
    // An empty pane is waiting for a session: fill it.
    const cur = tabs.find((x) => x.id === activeTab);
    const empty = cur && !opts?.newTab ? leaves(cur.root).find((l) => l.id === cur.focus && !l.target) : undefined;
    if (cur && empty) {
      return set({
        tabs: tabs.map((x) => (x.id === cur.id ? { ...x, root: mapNode(x.root, (l) => (l.id === empty.id ? { ...l, target } : l)) } : x)),
      });
    }
    const leaf: Leaf = { type: "leaf", id: nid("pane"), target };
    const tab: Tab = { id: nid("tab"), root: leaf, focus: leaf.id };
    const i = tabs.findIndex((x) => x.id === activeTab);
    const next = [...tabs];
    next.splice(i < 0 ? next.length : i + 1, 0, tab);
    set({ tabs: next, activeTab: tab.id });
  },
  focusPane: (tab, leaf) => set((s) => ({ tabs: s.tabs.map((x) => (x.id === tab ? { ...x, focus: leaf } : x)) })),
  setPaneTarget: (leafId, t) =>
    set((s) => ({
      tabs: s.tabs.map((x) => ({ ...x, root: mapNode(x.root, (l) => (l.id === leafId ? { ...l, target: t } : l)) })),
    })),
  split(dir) {
    const { tabs, activeTab } = get();
    const tab = tabs.find((x) => x.id === activeTab);
    if (!tab) return get().toast("Open a session first, then split it");
    if (leaves(tab.root).length >= MAX_PANES) return get().toast(`Up to ${MAX_PANES} panes per tab`);
    const fresh: Leaf = { type: "leaf", id: nid("pane"), target: null };
    const root = mapNode(tab.root, (l) => (l.id === tab.focus ? { type: "split", id: nid("split"), dir, a: l, b: fresh, ratio: 0.5 } : l));
    set({ tabs: tabs.map((x) => (x.id === tab.id ? { ...x, root, focus: fresh.id } : x)) });
  },
  closePane(leafId) {
    const { tabs } = get();
    const tab = tabs.find((x) => leaves(x.root).some((l) => l.id === leafId));
    if (!tab) return;
    const root = removeLeaf(tab.root, leafId);
    if (!root) return get().closeTab(tab.id);
    const focus = tab.focus === leafId ? leaves(root)[0].id : tab.focus;
    set({ tabs: tabs.map((x) => (x.id === tab.id ? { ...x, root, focus } : x)) });
  },
  closeTab(id) {
    const { tabs, activeTab } = get();
    const i = tabs.findIndex((x) => x.id === id);
    if (i < 0) return;
    const next = tabs.filter((x) => x.id !== id);
    const act = activeTab === id ? (next[i] ?? next[i - 1] ?? null)?.id ?? null : activeTab;
    set({ tabs: next, activeTab: act });
  },
  closeFocused() {
    const { tabs, activeTab } = get();
    const tab = tabs.find((x) => x.id === activeTab);
    if (!tab) return;
    if (tab.root.type === "split") get().closePane(tab.focus);
    else get().closeTab(tab.id);
  },
  activate: (tab) => set({ activeTab: tab }),
  activateIndex(i) {
    const { tabs } = get();
    const t = i === 8 ? tabs[tabs.length - 1] : tabs[i];
    if (t) set({ activeTab: t.id });
  },
  reorder(ids) {
    const by = new Map(get().tabs.map((t) => [t.id, t]));
    set({ tabs: ids.map((id) => by.get(id)!).filter(Boolean) });
  },
  setRatio: (id, r) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        const walk = (n: Node): Node => (n.type === "leaf" ? n : n.id === id ? { ...n, ratio: r } : { ...n, a: walk(n.a), b: walk(n.b) });
        return { ...t, root: walk(t.root) };
      }),
    })),
  setMode: (t, m) => set((s) => ({ modes: { ...s.modes, [targetId(t)]: m } })),
  notePty: (key, id) => set((s) => ({ sessionPty: { ...s.sessionPty, [key]: id }, ptyOwner: { ...s.ptyOwner, [id]: key } })),

  setThemePref(p) {
    try {
      if (p === "system") localStorage.removeItem("coool.theme");
      else localStorage.setItem("coool.theme", p);
    } catch {}
    set({ themePref: p, theme: p === "system" ? systemTheme() : p });
  },
  toggleTheme() {
    get().setThemePref(get().theme === "dark" ? "light" : "dark");
  },
  setSystemTheme() {
    if (get().themePref === "system") set({ theme: systemTheme() });
  },
  setPalette: (v) => set({ palette: v }),
  setSheet: (sheet) => set({ sheet }),
  toast(text, tone = "info") {
    const id = ++uid;
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }));
    setTimeout(() => get().dismissToast(id), tone === "error" ? 6000 : 3200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setSidebarWidth(w) {
    const v = Math.round(Math.min(420, Math.max(220, w)));
    try {
      localStorage.setItem("coool.sidebar", String(v));
    } catch {}
    set({ sidebarWidth: v });
  },
}));

// ---------- derived helpers ----------

export interface Resolved {
  session: Session | null;
  /** PTY id whose terminal belongs to this target (running or exited). */
  pty: number | null;
  /** Launched by coool as a PTY but no transcript yet. */
  starting: PtyInfo | null;
  /** Chat id driving this target, if any. */
  chat: number | null;
  /** Chat started by coool with no session yet. */
  startingChat: ChatInfo | null;
}

const NONE: Resolved = { session: null, pty: null, starting: null, chat: null, startingChat: null };

export function resolveTarget(t: Target | null, st: Pick<State, "sessions" | "ptyOwner" | "sessionPty" | "ptys" | "chatOwner" | "chatInfos">): Resolved {
  if (!t) return NONE;
  const key = t.kind === "session" ? t.key : t.kind === "pty" ? st.ptyOwner[t.id] : st.chatOwner[t.id];
  if (key) {
    const session = st.sessions.find((s) => sessionKey(s) === key) ?? null;
    const pty = session?.managed ?? st.sessionPty[key] ?? (t.kind === "pty" ? t.id : null);
    const chat = session?.chat ?? (t.kind === "chat" ? t.id : null);
    return { session, pty, starting: null, chat, startingChat: null };
  }
  if (t.kind === "pty") return { ...NONE, pty: t.id, starting: st.ptys[t.id] ?? null };
  if (t.kind === "chat") return { ...NONE, chat: t.id, startingChat: st.chatInfos[t.id] ?? null };
  return NONE;
}
