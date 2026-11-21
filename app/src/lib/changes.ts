// The Changes view's client side: which session a pane's changes belong to, loading them (live while the agent
// works), the actions, and the requests that open the panel from elsewhere (the turn's "4 files changed").
// The rules are in changesRules.ts; the engine is crates/core/src/changes.

import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { api } from "./backend";
import type { Chat } from "./chat";
import type { Provider, Session } from "./types";
import { sessionKey } from "./types";
import { useStore } from "../store";
import type { ChangeSet, Outcome, Scope } from "./changesRules";

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

/**
 * The change set for `scope`, reloaded when `tick` changes (new activity) and every `every` ms (1.5 s while the agent
 * is working). Keeps the last good set while a reload is on its way.
 */
export function useChanges(target: ChangesTarget | null, scope: Scope, tick: unknown, every: number | null, enabled = true): { data: ChangeSet | null; error: string | null; reload: () => Promise<void> } {
  const [data, setData] = useState<ChangeSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useRef(target);
  t.current = target;
  const k = targetKey(target);
  const sc = useRef(scope);
  sc.current = scope;
  const seq = useRef(0);
  // One load at a time: a reload asked for while one is on its way runs once after it (a slow load on a long session
  // must never pile up calls that each hold one of the backend's threads).
  const inFlight = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const reload = useCallback(async () => {
    if (inFlight.current) {
      again.current = true;
      return inFlight.current;
    }
    const run = async () => {
      do {
        again.current = false;
        const tg = t.current;
        if (!tg) return;
        const my = ++seq.current;
        try {
          const cs = await api().changesLoad({ ...tg, scope: sc.current });
          if (my === seq.current) {
            setData(cs);
            setError(null);
          }
        } catch (e) {
          if (my === seq.current) setError(String(e instanceof Error ? e.message : e));
        }
      } while (again.current);
    };
    inFlight.current = run().finally(() => (inFlight.current = null));
    return inFlight.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k, scope]);
  useEffect(() => {
    if (!enabled) return;
    const h = setTimeout(() => void reload(), 250);
    return () => clearTimeout(h);
  }, [reload, tick, enabled]);
  useEffect(() => {
    if (!enabled || !every) return;
    const h = setInterval(() => void reload(), every);
    return () => clearInterval(h);
  }, [reload, every, enabled]);
  useEffect(() => {
    setData(null);
    setError(null);
  }, [k]);
  return { data, error, reload };
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
