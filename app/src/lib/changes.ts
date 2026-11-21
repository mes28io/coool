// The Changes view's client side: which session a pane's changes belong to, loading them (live while the agent
// works), the actions, and the requests that open the panel from elsewhere (the turn's "4 files changed").
// The rules are in changesRules.ts; the engine is crates/core/src/changes.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { create } from "zustand";
import { api } from "./backend";
import { addTime } from "./perfCount";
import type { Chat } from "./chat";
import type { Provider, Session } from "./types";
import { sessionKey } from "./types";
import { useStore } from "../store";
import { mergeWire, type ChangeSet, type Outcome, type Scope } from "./changesRules";

export { mergeWire };

export interface ChangesTarget {
  provider: Provider;
  sessionId: string;
  agents: string[];
  cwd: string;
  external: boolean;
}

/** The session behind a pane: its transcript is what the changes are read from. Null before it has one. */
export function changesTarget(session: Session | null | undefined, chat: Chat | null | undefined, external: boolean): ChangesTarget | null {
  const sessionId = chat?.sessionId ?? session?.id ?? null;
  const provider = chat?.provider ?? session?.provider;
  const cwd = chat?.cwd || session?.cwd || "";
  if (!sessionId || !provider || !cwd) return null;
  return { provider, sessionId, agents: (session?.agents ?? []).map((a) => a.id), cwd, external };
}

const targetKey = (t: ChangesTarget | null) => (t ? `${t.provider}:${t.sessionId}:${t.agents.length}:${t.cwd}:${t.external}` : "");

/** Whether the page is visible and the window focused (polling slows down or stops otherwise). */
const pageState = (() => {
  const subs = new Set<() => void>();
  let snap = "";
  const read = () => `${typeof document === "undefined" || document.visibilityState !== "hidden" ? 1 : 0}${typeof document === "undefined" || document.hasFocus() ? 1 : 0}`;
  const fire = () => {
    const n = read();
    if (n === snap) return;
    snap = n;
    for (const f of subs) f();
  };
  return {
    subscribe(f: () => void) {
      if (!subs.size && typeof window !== "undefined") {
        snap = read();
        document.addEventListener("visibilitychange", fire);
        window.addEventListener("focus", fire);
        window.addEventListener("blur", fire);
      }
      subs.add(f);
      return () => {
        subs.delete(f);
        if (!subs.size && typeof window !== "undefined") {
          document.removeEventListener("visibilitychange", fire);
          window.removeEventListener("focus", fire);
          window.removeEventListener("blur", fire);
        }
      };
    },
    get: () => snap || (snap = read()),
  };
})();
function usePageState(): { visible: boolean; focused: boolean } {
  const s = useSyncExternalStore(pageState.subscribe, pageState.get, () => "11");
  return { visible: s[0] === "1", focused: s[1] === "1" };
}

/**
 * The change set for `scope`. `full` false: the counts, turns and re-edited files only (the header with the panel
 * closed), no diffs. Asked again when `tick` changes (new activity), at most every `gap` ms, and every `every` ms
 * (every 4 s at most while the window isn't focused); nothing at all while the page is hidden. Each call sends the
 * revision the page has: when nothing changed the backend answers with a number, otherwise with only the files that
 * changed. Keeps the last good set while a reload is on its way.
 */
export function useChanges(
  target: ChangesTarget | null,
  scope: Scope,
  tick: unknown,
  every: number | null,
  enabled = true,
  full = true,
  gap = 1000,
): { data: ChangeSet | null; full: boolean; error: string | null; reload: () => Promise<void> } {
  const [state, setState] = useState<{ data: ChangeSet | null; full: boolean }>({ data: null, full: false });
  const [error, setError] = useState<string | null>(null);
  const t = useRef(target);
  t.current = target;
  const k = targetKey(target);
  const mode = `${k}|${scope}|${full ? "full" : "summary"}`;
  // What the page has: for which target, scope and mode, at which revision.
  const have = useRef<{ mode: string; rev: number; data: ChangeSet | null }>({ mode: "", rev: 0, data: null });
  const seq = useRef(0);
  const last = useRef(0);
  const { visible, focused } = usePageState();
  // Main-thread ms from a new set to its layout (perf scenarios, lib/perfCount.ts).
  const applied = useRef(0);
  useLayoutEffect(() => {
    if (!applied.current) return;
    // Layout included (what the frame after it would pay).
    void document.querySelector("[data-changes-body]")?.scrollHeight;
    addTime("changes.render", performance.now() - applied.current);
    addTime("changes.updates", 1);
    applied.current = 0;
  }, [state]);
  const reload = useCallback(async () => {
    const tg = t.current;
    if (!tg) return;
    const my = ++seq.current;
    last.current = performance.now();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const h = have.current;
        const since = h.mode === mode && h.data ? h.rev : 0;
        const t0 = performance.now();
        const w = await api().changesLoad({ ...tg, scope }, since, !full);
        addTime("changes.ipc", performance.now() - t0);
        if (my !== seq.current) return;
        const merged = mergeWire(since ? h.data : null, w);
        if (!merged) {
          // The page lacks a file the reply leaves out: ask again in full.
          have.current = { mode: "", rev: 0, data: null };
          continue;
        }
        have.current = { mode, rev: w.rev, data: merged };
        if (merged !== h.data) {
          applied.current = performance.now();
          setState({ data: merged, full });
        }
        setError(null);
        return;
      }
    } catch (e) {
      if (my === seq.current) setError(String(e instanceof Error ? e.message : e));
    }
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = enabled && visible;
  // New activity, at most every `gap` ms (a busy terminal session writes several lines a second); at once when the
  // mode changed (the panel opened: its diffs are wanted now).
  useEffect(() => {
    if (!live) return;
    const fresh = have.current.mode !== mode;
    const wait = fresh ? 0 : Math.max(250, gap - (performance.now() - last.current));
    const h = setTimeout(() => void reload(), wait);
    return () => clearTimeout(h);
  }, [reload, tick, live, gap, mode]);
  const period = every && !focused ? Math.max(every, 4000) : every;
  useEffect(() => {
    if (!live || !period) return;
    const h = setInterval(() => void reload(), period);
    return () => clearInterval(h);
  }, [reload, period, live]);
  useEffect(() => {
    have.current = { mode: "", rev: 0, data: null };
    setState({ data: null, full: false });
    setError(null);
  }, [k]);
  return { data: state.data, full: state.full, error, reload };
}

export const changesUndo = (t: ChangesTarget, scope: Scope, file: string | null, hunk: string | null, force = false): Promise<Outcome> => api().changesUndo({ ...t, scope }, file, hunk, force);
export const changesKeep = (t: ChangesTarget, scope: Scope, file: string | null, hunk: string | null, stage = false, unkeep = false): Promise<Outcome> => api().changesKeep({ ...t, scope }, file, hunk, stage, unkeep);

/** Requests to open a pane's Changes panel at a scope (from the timeline), by panel key. */
export const useChangesOpen = create<{ req: Record<string, { scope: Scope | { at: number; prompt?: string; ordinal?: number }; n: number }>; open(key: string, scope: Scope | { at: number; prompt?: string; ordinal?: number }): void }>((set) => ({
  req: {},
  open: (key, scope) => set((s) => ({ req: { ...s.req, [key]: { scope, n: (s.req[key]?.n ?? 0) + 1 } } })),
}));

/** The panel key of a chat's pane (its session's key once listed, as SessionView keys its panels). */
export function chatPanelKeyOf(chatId: number): string {
  const s = useStore.getState().sessions.find((x) => x.chat === chatId);
  return s ? sessionKey(s) : `chat:${chatId}`;
}

/** Opens a chat's Changes panel at a turn: the one whose prompt is `prompt`, sent at `at` (the `ordinal`-th otherwise). */
export function openChangesAt(chatId: number, at: { at: number; prompt?: string; ordinal?: number } | Scope) {
  useChangesOpen.getState().open(chatPanelKeyOf(chatId), at);
}

const TELL_KEY = "coool.changes.tell";
/** Tell the agent when the person undoes its changes (a short note through steering). On unless turned off. */
export function tellAgentPref(): boolean {
  try {
    return localStorage.getItem(TELL_KEY) !== "0";
  } catch {
    return true;
  }
}
export function setTellAgentPref(on: boolean) {
  try {
    localStorage.setItem(TELL_KEY, on ? "1" : "0");
  } catch {}
}

const SPLIT_KEY = "coool.changes.split";
export function splitPref(): boolean {
  try {
    return localStorage.getItem(SPLIT_KEY) === "1";
  } catch {
    return false;
  }
}
export function setSplitPref(on: boolean) {
  try {
    localStorage.setItem(SPLIT_KEY, on ? "1" : "0");
  } catch {}
}
