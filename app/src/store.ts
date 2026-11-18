// The one store. Backend events are the only source of truth for sessions;
// everything else here is UI state (tabs, splits, theme, overlays).

import { create } from "zustand";
import type { ChatInfo, Environment, PlanUsages, Provider, PtyInfo, Session, Snapshot } from "./lib/types";
import { sessionKey } from "./lib/types";
import { api, isTauri } from "./lib/backend";

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
  | { kind: "stop"; label: string; managed: number | null; pid: number | null; chat?: number | null };

/** What a browser tab shows (components/BrowserPanel.tsx). */
export type BrowserPage =
  /** A web page (http/https), in a native child webview. `n` changes on every load asked for, so asking for the same URL again loads it again. */
  | { kind: "web"; url: string; n: number }
  /** A new tab: an address field and the pages this chat mentions. */
  | { kind: "start" };
export interface BrowserTab {
  id: number;
  page: BrowserPage;
  /** Where the page has got to and its title, as it last reported (kept when its webview is closed). */
  url?: string;
  title?: string;
}
/** A session's browser panel: its tabs in order, and the id of the one showing. */
export interface BrowserTabs {
  tabs: BrowserTab[];
  active: number;
}
export type RightPanelKind = "agents" | "models" | "browser" | "device";

/** What the left sidebar panel shows: one view at a time. Projects is the default. */
export type SidebarView = "projects" | "needs";
/** The full-screen Settings page's categories, in order (components/SettingsPage.tsx). */
export const SETTINGS_SECTIONS = ["appearance", "sessions", "insights", "usage", "about"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

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
let browserOpens = 0;
let browserTabIds = 0;
const webTab = (id: number, url: string): BrowserTab => ({ id, page: { kind: "web", url, n: ++browserOpens }, url });
/** Remembered tabs, as new loads (their webviews were closed). */
const reviveTabs = (t: BrowserTabs | undefined): BrowserTabs | undefined =>
  t && t.tabs.length ? { ...t, tabs: t.tabs.map((x) => (x.page.kind === "web" ? { ...x, page: { ...x.page, n: ++browserOpens } } : x)) } : undefined;
const BROWSER_DEFAULT = 600;
/** The browser panel's narrowest; the pane's chat keeps at least `BROWSER_CHAT_MIN` beside it. */
export const BROWSER_MIN = 360;
export const BROWSER_CHAT_MIN = 320;
const clampBrowser = (w: number) => Math.round(Math.min(1600, Math.max(BROWSER_MIN, w)));
const DEVICE_DEFAULT = 400;
/** The iPhone panel's narrowest (the chat keeps `BROWSER_CHAT_MIN` beside it too) and widest. */
export const DEVICE_MIN = 340;
export const DEVICE_MAX = 720;
const clampDevice = (w: number) => Math.round(Math.min(DEVICE_MAX, Math.max(DEVICE_MIN, w)));

function readSettingsLast(): SettingsSection {
  try {
    const v = localStorage.getItem("coool.settingsSection");
    if (v && v !== "usage" && (SETTINGS_SECTIONS as readonly string[]).includes(v)) return v as SettingsSection;
  } catch {}
  return "appearance";
}

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
  /**
   * Sessions the UI lists: everything except runs other tools / agents started,
   * unless `showAutomation` is on. A live automation run flagged "Needs you" is
   * listed anyway, so nothing that waits on the person is hidden.
   */
  sessions: Session[];
  /** Every session the backend reported (for resolving open tabs). */
  allSessions: Session[];
  /** Automation runs left out of `sessions` right now. */
  hiddenAutomation: number;
  /** Settings: "Show runs started by other tools" (persisted by the backend). */
  showAutomation: boolean;
  setShowAutomation(v: boolean): void;
  pending: number[];
  ptys: Record<number, PtyInfo>;
  /** pty id -> session key, remembered after the PTY exits. */
  ptyOwner: Record<number, string>;
  /** session key -> most recent pty id that ran it. */
  sessionPty: Record<string, number>;
  exited: Record<number, boolean>;
  env: Environment | null;
  usage: PlanUsages;
  sidebarView: SidebarView;
  /** Show a view; a non-Projects view expands a collapsed sidebar. */
  setSidebarView(v: SidebarView): void;
  /** Same view again goes back to Projects. */
  toggleSidebarView(v: SidebarView): void;
  /**
   * The full-screen Settings page, open on this category; null = the app (sidebar and panes stay mounted underneath,
   * untouched). Opening a session or switching tabs closes it.
   */
  settings: SettingsSection | null;
  /** The category Settings opens on: the last one shown other than Usage (Usage has its own rail button); persisted. */
  settingsLast: SettingsSection;
  /** Open the page on `section`, or on the remembered category. */
  openSettings(section?: SettingsSection): void;
  closeSettings(): void;
  chatInfos: Record<number, ChatInfo>;
  /** chat id -> session key, once discovery linked them (Session.chat). */
  chatOwner: Record<number, string>;
  /** Running chats with no session yet. */
  pendingChats: number[];
  since: Record<string, Since>;

  /** Which finished turns the person has looked at: `base` covers everything older, `m` is session key -> its `updated` when last seen. */
  seen: Seen;
  /** Record that the person has seen this session as of `updated` (never moves backwards). */
  markSeen(key: string, updated: number): void;

  tabs: Tab[];
  activeTab: string | null;
  modes: Record<string, ViewMode>;

  themePref: ThemePref;
  theme: "dark" | "light";
  palette: boolean;
  sheet: Sheet;
  toasts: Toast[];
  sidebarWidth: number;
  sidebarOpen: boolean;
  /** Sidebar projects folded to one line, by project path (persisted). */
  collapsed: Record<string, true>;
  /**
   * Extra ended chats revealed past the resting cap, by project path. This run
   * only, never persisted, and cleared whenever the project is collapsed or
   * expanded: a project always opens in its short version.
   */
  revealed: Record<string, number>;
  /** A session's nested block (subagents + jobs) opened or folded by the person, by session key; this run only. Absent = automatic. */
  kidsOpen: Record<string, boolean>;
  setKidsOpen(key: string, open: boolean): void;
  /** A subagent to scroll to and open in its session's activity view (stamped; stale after a few seconds). */
  agentFocus: { id: string; at: number } | null;
  focusAgent(id: string): void;
  /** The right side panel per session (key: session key, or `chat:<id>`): one at a time, set by the person or by the Agents panel's first auto-open; this run only. Absent = never opened. */
  rightPanel: Record<string, RightPanelKind | "closed">;
  setRightPanel(key: string, v: RightPanelKind | "closed"): void;
  /** Width of the right panel (min 300, max 440); this run only. */
  agentsWidth: number;
  setAgentsWidth(w: number): void;
  /** Per session (same keys as `rightPanel`): the browser panel's tabs; this run only. Absent = no browser open. */
  browser: Record<string, BrowserTabs>;
  /**
   * Opens a page in that session's browser panel (and shows the panel, replacing Jobs / Models): a web page goes to
   * the tab already on that URL, else into the showing tab if it is a new-tab view, else a new tab after `after` (or
   * the showing one); `fresh` always makes a new tab. `start`: a new tab with the start view.
   */
  openBrowser(key: string, page: { kind: "web"; url: string } | { kind: "start" }, opts?: { after?: number; fresh?: boolean }): void;
  /** Loads `url` in that tab (the address field, the start view). */
  navigateBrowserTab(key: string, tab: number, url: string): void;
  selectBrowserTab(key: string, tab: number): void;
  /** Closes a tab (the caller closes its webview); the last one closes the browser like `closeBrowser`. */
  closeBrowserTab(key: string, tab: number): void;
  /** What a tab's page reported (where it is, its title). */
  noteBrowserTab(key: string, tab: number, url: string, title: string): void;
  /** The browser's own close: forgets its tabs (the panel closes their webviews) but remembers them in `lastBrowser`. */
  closeBrowser(key: string): void;
  /** Shows the remembered tabs again (fresh webviews), or a start view when there are none. */
  restoreBrowser(key: string): void;
  /** Per session: the tabs the browser had when it was last closed (URLs, titles, the active one; the header's globe restores them); this run only. */
  lastBrowser: Record<string, BrowserTabs>;
  /** Width of the browser panel (wider than the others; persisted). The pane may clamp it. */
  browserWidth: number;
  setBrowserWidth(w: number): void;
  /** Per session (same keys as `rightPanel`): the simulator its iPhone panel shows; this run only. */
  device: Record<string, { udid: string }>;
  setDevice(key: string, udid: string): void;
  /** Width of the iPhone panel (persisted). The pane may clamp it. */
  deviceWidth: number;
  setDeviceWidth(w: number): void;
  toggleCollapsed(project: string): void;
  setRevealed(project: string, n: number): void;

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
  toggleSidebar(): void;
}

export interface Seen {
  base: number;
  m: Record<string, number>;
}
const SEEN_KEY = "coool.seen";
const SEEN_TTL = 30 * 24 * 3600_000;
function readSeen(): Seen {
  const now = Date.now();
  // First run: whatever is already idle counts as seen. (The browser mock has no history, so everything starts unseen.)
  let out: Seen = { base: isTauri ? now : 0, m: {} };
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Seen>;
      if (v && typeof v.base === "number" && v.m && typeof v.m === "object") {
        const cutoff = now - SEEN_TTL;
        const m: Record<string, number> = {};
        for (const [k, t] of Object.entries(v.m)) if (typeof t === "number" && t >= cutoff) m[k] = t;
        // Dropped entries were all older than the cutoff, so lifting the baseline keeps them seen.
        out = { base: isTauri ? Math.max(v.base, cutoff) : v.base, m };
      }
    } else localStorage.setItem(SEEN_KEY, JSON.stringify(out));
  } catch {
    /* storage unavailable: seen lasts for this run */
  }
  return out;
}
/** When the chat last had real activity (a prompt, a reply, a turn end): what unread compares against. `updated` is the transcript file's mtime, which other tools also bump. */
export const seenAt = (s: { last_event?: number | null; updated: number }) => s.last_event ?? s.updated;
/** True while the session finished a turn the person has not looked at yet. */
export const isUnseen = (seen: Seen, key: string, updated: number) => updated > (seen.m[key] ?? seen.base);

const COLLAPSED_KEY = "coool.collapsedProjects";
function readCollapsed(): Record<string, true> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]");
    const out: Record<string, true> = {};
    if (Array.isArray(v)) for (const p of v) if (typeof p === "string") out[p] = true;
    return out;
  } catch {
    return {};
  }
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

let showAutomationSetAt = 0;

/** A live session blocked on the person, by what the CLI or an insight says. */
const selfNeeds = (s: Session) => (s.status !== "ended" ? (s.waiting_for ? `Waiting for you: ${s.waiting_for}` : (s.insight?.needs_you ?? null)) : null);

/**
 * Who the UI lists (see State.sessions): everything the person or coool
 * started; runs by other tools only when the setting is on, when one needs the
 * person, or when it is a child run of a listed session (then shown nested
 * under that session, never on its own).
 */
function visibleSessions(all: Session[], showAutomation: boolean): { sessions: Session[]; hidden: number } {
  const top = all.filter((s) => s.origin !== "automation" || showAutomation || !!selfNeeds(s));
  const ids = new Set(top.filter((s) => !s.parent).map((s) => s.id));
  const isChild = (s: Session) => !!s.parent && ids.has(s.parent) && s.parent !== s.id;
  const listed = all.filter((s) => top.includes(s) || isChild(s));
  // A child's "needs you" surfaces on its parent.
  const childNeeds = new Map<string, string>();
  for (const s of listed) {
    if (!isChild(s) || s.status === "ended" || childNeeds.has(s.parent!)) continue;
    const n = s.waiting_for ? `A job is waiting for you: ${s.waiting_for}` : s.insight?.needs_you ? `A job needs you: ${s.insight.needs_you}` : null;
    if (n) childNeeds.set(s.parent!, n);
  }
  const sessions = listed.map((s) => {
    const nested = isChild(s);
    const cn = childNeeds.get(s.id) ?? null;
    if (!nested && !cn) return s;
    // Reuse the copy made last time for the same session object, so memoised rows keep skipping it.
    const prev = derived.get(s);
    if (prev && prev.nested === nested && (prev.child_needs ?? null) === cn) return prev;
    const d = { ...s, nested, child_needs: cn };
    derived.set(s, d);
    return d;
  });
  return { sessions, hidden: all.length - sessions.length };
}
const derived = new WeakMap<Session, Session>();

// Keep the previous object when a new payload carries the same content, so selectors on it don't fire.
const sameList = <T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean = Object.is) => a.length === b.length && a.every((x, i) => eq(x, b[i]));
const keepList = <T>(prev: T[], next: T[], eq?: (x: T, y: T) => boolean) => (sameList(prev, next, eq) ? prev : next);
const json = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
/** Per entry: an unchanged value keeps its old object; nothing changed at all keeps the old record. */
function keepRecord<V>(prev: Record<string | number, V>, next: Record<string | number, V>, eq: (a: V, b: V) => boolean = Object.is) {
  let same = Object.keys(prev).length === Object.keys(next).length;
  for (const k of Object.keys(next)) {
    if (k in prev && eq(prev[k], next[k])) next[k] = prev[k];
    else same = false;
  }
  return same ? prev : next;
}
const sameSince = (a: Since, b: Since) =>
  a.status === b.status && a.current === b.current && a.statusAt === b.statusAt && a.currentAt === b.currentAt && a.observed === b.observed && a.currentObserved === b.currentObserved;

/** Told when a panel's state moves to another key (lib/browser.ts moves its tabs' webviews along). */
const rekeyListeners = new Set<(from: string, to: string) => void>();
export function onPanelRekey(cb: (from: string, to: string) => void): () => void {
  rekeyListeners.add(cb);
  return () => rekeyListeners.delete(cb);
}

/**
 * A new chat's view keeps its right panel under `chat:<id>` until its session exists, then under the session's key.
 * Without moving them, a panel opened before that (the agent's browser on the first prompt, the iPhone) vanished
 * mid-turn and the agent's next tool found no page. Each `[from, to]` moves only when `to` has nothing of its own.
 */
export function movePanels(st: Pick<State, "rightPanel" | "browser" | "lastBrowser" | "device">, moves: [string, string][]): Partial<Pick<State, "rightPanel" | "browser" | "lastBrowser" | "device">> {
  const out: Partial<Pick<State, "rightPanel" | "browser" | "lastBrowser" | "device">> = {};
  for (const field of ["rightPanel", "browser", "lastBrowser", "device"] as const) {
    let rec: Record<string, unknown> = st[field];
    for (const [from, to] of moves) {
      if (!(from in rec) || to in rec) continue;
      rec = { ...rec, [to]: rec[from] };
      delete rec[from];
    }
    if (rec !== st[field]) (out as Record<string, unknown>)[field] = rec;
  }
  return out;
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  loading: false,
  sessions: [],
  allSessions: [],
  hiddenAutomation: 0,
  showAutomation: false,
  setShowAutomation(v) {
    showAutomationSetAt = Date.now();
    const { sessions, hidden } = visibleSessions(get().allSessions, v);
    set({ showAutomation: v, sessions, hiddenAutomation: hidden });
    api()
      .setShowAutomation(v)
      .catch((e) => get().toast(`Couldn't save the setting: ${e instanceof Error ? e.message : String(e)}`, "error"));
  },
  pending: [],
  ptys: {},
  ptyOwner: {},
  sessionPty: {},
  exited: {},
  env: null,
  usage: { claude: null, codex: null },
  sidebarView: "projects",
  setSidebarView(v) {
    if (v !== "projects" && !get().sidebarOpen) {
      try {
        localStorage.setItem("coool.sidebarOpen", "1");
      } catch {}
      set({ sidebarOpen: true });
    }
    set({ sidebarView: v });
  },
  toggleSidebarView(v) {
    const s = get();
    s.setSidebarView(s.sidebarOpen && s.sidebarView === v ? "projects" : v);
  },
  settings: null,
  settingsLast: readSettingsLast(),
  openSettings(section) {
    const v = section ?? get().settingsLast;
    if (v !== "usage" && v !== get().settingsLast) {
      try {
        localStorage.setItem("coool.settingsSection", v);
      } catch {}
      set({ settingsLast: v });
    }
    set({ settings: v });
  },
  closeSettings: () => set({ settings: null }),
  chatInfos: {},
  chatOwner: {},
  pendingChats: [],
  since: {},
  seen: readSeen(),
  markSeen(key, updated) {
    const { seen } = get();
    if (!isUnseen(seen, key, updated)) return;
    const next: Seen = { base: seen.base, m: { ...seen.m, [key]: updated } };
    set({ seen: next });
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  },
  tabs: [],
  activeTab: null,
  modes: {},
  themePref: readPref(),
  theme: readPref() === "system" ? systemTheme() : (readPref() as "dark" | "light"),
  palette: false,
  sheet: null,
  toasts: [],
  sidebarWidth: readNum("coool.sidebar", 300),
  collapsed: readCollapsed(),
  revealed: {},
  kidsOpen: {},
  setKidsOpen: (key, open) => set((s) => ({ kidsOpen: { ...s.kidsOpen, [key]: open } })),
  agentFocus: null,
  focusAgent: (id) => set({ agentFocus: { id, at: Date.now() } }),
  rightPanel: {},
  setRightPanel: (key, v) => set((s) => ({ rightPanel: { ...s.rightPanel, [key]: v } })),
  agentsWidth: 340,
  setAgentsWidth: (w) => set({ agentsWidth: Math.round(Math.min(440, Math.max(300, w))) }),
  browser: {},
  openBrowser: (key, page, opts) =>
    set((s) => {
      const cur = s.browser[key] ?? reviveTabs(s.lastBrowser[key]) ?? { tabs: [], active: -1 };
      const showing = cur.tabs.find((t) => t.id === cur.active);
      let next: BrowserTabs;
      const there = page.kind === "web" && !opts?.fresh ? cur.tabs.find((t) => t.page.kind === "web" && (t.url === page.url || t.page.url === page.url)) : undefined;
      if (there) next = { ...cur, active: there.id };
      else if (page.kind === "web" && !opts?.fresh && showing?.page.kind === "start") next = { ...cur, tabs: cur.tabs.map((t) => (t === showing ? webTab(t.id, page.url) : t)) };
      else {
        const tab = page.kind === "web" ? webTab(++browserTabIds, page.url) : { id: ++browserTabIds, page: { kind: "start" as const } };
        const at = cur.tabs.findIndex((t) => t.id === (opts?.after ?? cur.active));
        const tabs = [...cur.tabs];
        tabs.splice(at < 0 ? tabs.length : at + 1, 0, tab);
        next = { tabs, active: tab.id };
      }
      return { browser: { ...s.browser, [key]: next }, rightPanel: { ...s.rightPanel, [key]: "browser" } };
    }),
  navigateBrowserTab: (key, id, url) =>
    set((s) => {
      const cur = s.browser[key];
      if (!cur) return s;
      return { browser: { ...s.browser, [key]: { ...cur, tabs: cur.tabs.map((t) => (t.id === id ? webTab(id, url) : t)) } } };
    }),
  selectBrowserTab: (key, id) =>
    set((s) => {
      const cur = s.browser[key];
      if (!cur || cur.active === id || !cur.tabs.some((t) => t.id === id)) return s;
      return { browser: { ...s.browser, [key]: { ...cur, active: id } } };
    }),
  closeBrowserTab: (key, id) => {
    const cur = get().browser[key];
    if (!cur) return;
    if (cur.tabs.length <= 1) return get().closeBrowser(key);
    set((s) => {
      const i = cur.tabs.findIndex((t) => t.id === id);
      const tabs = cur.tabs.filter((t) => t.id !== id);
      const active = cur.active === id ? tabs[Math.min(Math.max(i, 0), tabs.length - 1)].id : cur.active;
      return { browser: { ...s.browser, [key]: { tabs, active } } };
    });
  },
  noteBrowserTab: (key, id, url, title) =>
    set((s) => {
      const cur = s.browser[key];
      const t = cur?.tabs.find((x) => x.id === id);
      if (!cur || !t || (t.url === (url || t.url) && t.title === (title || t.title))) return s;
      return { browser: { ...s.browser, [key]: { ...cur, tabs: cur.tabs.map((x) => (x === t ? { ...t, url: url || t.url, title: title || t.title } : x)) } } };
    }),
  closeBrowser: (key) =>
    set((s) => {
      const browser = { ...s.browser };
      const cur = browser[key];
      delete browser[key];
      const lastBrowser = { ...s.lastBrowser };
      // Remembered at where each page had got to.
      if (cur) lastBrowser[key] = { ...cur, tabs: cur.tabs.map((t) => (t.page.kind === "web" ? { ...t, page: { ...t.page, url: t.url || t.page.url } } : t)) };
      return { browser, lastBrowser, rightPanel: { ...s.rightPanel, [key]: "closed" } };
    }),
  restoreBrowser: (key) =>
    set((s) => ({
      browser: { ...s.browser, [key]: reviveTabs(s.lastBrowser[key]) ?? { tabs: [{ id: ++browserTabIds, page: { kind: "start" } }], active: browserTabIds } },
      rightPanel: { ...s.rightPanel, [key]: "browser" },
    })),
  lastBrowser: {},
  browserWidth: clampBrowser(readNum("coool.browserWidth", BROWSER_DEFAULT)),
  setBrowserWidth(w) {
    const v = clampBrowser(w);
    try {
      localStorage.setItem("coool.browserWidth", String(v));
    } catch {}
    set({ browserWidth: v });
  },
  device: {},
  setDevice: (key, udid) => set((s) => (s.device[key]?.udid === udid ? s : { device: { ...s.device, [key]: { udid } } })),
  deviceWidth: clampDevice(readNum("coool.deviceWidth", DEVICE_DEFAULT)),
  setDeviceWidth(w) {
    const v = clampDevice(w);
    try {
      localStorage.setItem("coool.deviceWidth", String(v));
    } catch {}
    set({ deviceWidth: v });
  },
  toggleCollapsed(project) {
    const collapsed = { ...get().collapsed };
    if (collapsed[project]) delete collapsed[project];
    else collapsed[project] = true;
    try {
      // Bounded: only the most recent few hundred folders are remembered.
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Object.keys(collapsed).slice(-300)));
    } catch {}
    const revealed = { ...get().revealed };
    delete revealed[project];
    set({ collapsed, revealed });
  },
  setRevealed: (project, n) => set((s) => ({ revealed: { ...s.revealed, [project]: Math.max(0, n) } })),
  sidebarOpen: (() => {
    try {
      return localStorage.getItem("coool.sidebarOpen") !== "0";
    } catch {
      return true;
    }
  })(),

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
    // A payload built before a local change of the setting still carries the old value.
    const showAutomation = Date.now() - showAutomationSetAt < 3000 ? st.showAutomation : !!snap.show_automation;
    const vis = visibleSessions(snap.sessions, showAutomation);
    const usage = { claude: snap.usage?.claude ?? null, codex: snap.usage?.codex ?? null };
    const keptPtyOwner = keepRecord(st.ptyOwner, ptyOwner);
    const keptChatOwner = keepRecord(st.chatOwner, chatOwner);
    // A chat that just got its session: its view's panels move from `chat:<id>` to the session's key.
    const moves: [string, string][] = Object.entries(chatOwner)
      .filter(([c, k]) => st.chatOwner[Number(c)] !== k)
      .map(([c, k]) => [`chat:${c}`, k]);
    const panels = movePanels(st, moves);
    // The webviews first, so a panel rendering under the new key finds its tabs' views instead of opening new ones.
    for (const [from, to] of moves) if (panels.browser?.[to] || panels.lastBrowser?.[to]) rekeyListeners.forEach((f) => f(from, to));
    set({
      ...panels,
      ready: true,
      loading: !!snap.loading,
      sessions: keepList(st.sessions, vis.sessions),
      allSessions: keepList(st.allSessions, snap.sessions),
      hiddenAutomation: vis.hidden,
      showAutomation,
      pending: keepList(st.pending, snap.pending),
      ptys: keepRecord(st.ptys, ptys, json),
      ptyOwner: keptPtyOwner,
      sessionPty: keepRecord(st.sessionPty, sessionPty),
      modes: keepRecord(st.modes, modes),
      chatOwner: keptChatOwner,
      chatInfos: keepRecord(st.chatInfos, chatInfos, json),
      pendingChats: keepList(st.pendingChats, pendingChats),
      since: keepRecord(st.since, since, sameSince),
      usage: json(st.usage, usage) ? st.usage : usage,
      tabs: normalizeTabs(st.tabs, keptPtyOwner, keptChatOwner),
    });
  },
  setEnv: (env) => set({ env }),
  markExited: (id) => set((s) => ({ exited: { ...s.exited, [id]: true } })),

  open(t, opts) {
    if (get().settings) set({ settings: null });
    const { tabs, activeTab } = get();
    let target = t;
    if (t.kind === "pty" && get().ptyOwner[t.id]) target = { kind: "session", key: get().ptyOwner[t.id] };
    if (t.kind === "chat" && get().chatOwner[t.id]) target = { kind: "session", key: get().chatOwner[t.id] };
    if (target.kind === "session") {
      const s = get().sessions.find((x) => sessionKey(x) === (target as { key: string }).key);
      if (s) get().markSeen(sessionKey(s), seenAt(s));
    }
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
  activate: (tab) => set({ activeTab: tab, settings: null }),
  activateIndex(i) {
    const { tabs } = get();
    const t = i === 8 ? tabs[tabs.length - 1] : tabs[i];
    if (t) set({ activeTab: t.id, settings: null });
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
  toggleSidebar() {
    const v = !get().sidebarOpen;
    try {
      localStorage.setItem("coool.sidebarOpen", v ? "1" : "0");
    } catch {}
    set({ sidebarOpen: v });
  },
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

export function resolveTarget(t: Target | null, st: Pick<State, "allSessions" | "ptyOwner" | "sessionPty" | "ptys" | "chatOwner" | "chatInfos">): Resolved {
  if (!t) return NONE;
  const key = t.kind === "session" ? t.key : t.kind === "pty" ? st.ptyOwner[t.id] : st.chatOwner[t.id];
  if (key) {
    // Every session, so a tab stays open on a run that the setting now hides.
    const session = st.allSessions.find((s) => sessionKey(s) === key) ?? null;
    const pty = session?.managed ?? st.sessionPty[key] ?? (t.kind === "pty" ? t.id : null);
    const chat = session?.chat ?? (t.kind === "chat" ? t.id : null);
    return { session, pty, starting: null, chat, startingChat: null };
  }
  if (t.kind === "pty") return { ...NONE, pty: t.id, starting: st.ptys[t.id] ?? null };
  if (t.kind === "chat") return { ...NONE, chat: t.id, startingChat: st.chatInfos[t.id] ?? null };
  return NONE;
}
