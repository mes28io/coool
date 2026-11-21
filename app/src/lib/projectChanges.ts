// A project's changes, from every session of it that is live or ended within the ledger's window (Mission
// control's ledger, the file-overlap marks in the sidebar). Pure rules live in lib/mission.ts.

import { useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import { useChats } from "./chat";
import { displayTitle, projectOf } from "./format";
import { authorOf, changesFromActivity, changesFromChat, mergeChanges, treeOf, type Change, type ItemLike, type Overlap, type OverlapEdit, type OverlapSession } from "./mission";
import { agentWorking } from "./agentState";
import type { Provider } from "./types";
import { sessionKey } from "./types";

/** Sessions that ended this long ago still feed their project's ledger. */
export const LEDGER_WINDOW_MS = 6 * 3600_000;

export interface ChangeSource {
  provider: Provider;
  title: string;
  /** Its subagents' descriptions, by id (transcript sessions). */
  agents?: Record<string, string>;
}

/** "Session title", or "Session title · agent description" for a subagent's edit. */
export function authorLabel(e: Pick<OverlapEdit, "session" | "agent">, sources: Record<string, ChangeSource>): string {
  const src = sources[e.session];
  const title = src?.title ?? e.session;
  if (!e.agent) return title;
  return `${title} · ${src?.agents?.[e.agent] ?? "an agent"}`;
}

/** A subagent's rows carry `g:<agent id>` as their step. */
export const agentOf = (c: Change) => (c.step.startsWith("g:") ? c.step.slice(2) : null);

// One session's rows, kept while its activity (or chat items) is the same array: a payload about one session
// recomputes that session's rows, not every row of the project. Redone after a minute anyway, since rows of
// entries without a usable time are stamped with the time they were read.
const rowsMemo = new WeakMap<object, { key: string; at: number; rows: Change[] }>();
function rowsOf(list: object, key: string, f: () => Change[]): Change[] {
  const m = rowsMemo.get(list);
  const now = Date.now();
  if (m && m.key === key && now - m.at < 60_000) return m.rows;
  const rows = f();
  rowsMemo.set(list, { key, at: now, rows });
  return rows;
}

/** Every change in the project's sessions (live, or ended within the window), newest first, before the ledger's rules. */
export function useProjectChanges(path: string, branch: string | null): { changes: Change[]; sources: Record<string, ChangeSource>; people: Record<string, OverlapSession> } {
  const feeding = useStore(
    useShallow((st) => {
      const cut = Date.now() - LEDGER_WINDOW_MS;
      return st.sessions.filter((s) => projectOf(s) === path && (s.status !== "ended" || s.updated > cut));
    }),
  );
  const items = useChats(useShallow((st) => feeding.map((s) => (s.chat != null ? st.chats[s.chat]?.items : undefined))));
  return useMemo(() => {
    const lists: Change[][] = [];
    const sources: Record<string, ChangeSource> = {};
    const people: Record<string, OverlapSession> = {};
    feeding.forEach((s, i) => {
      const key = sessionKey(s);
      sources[key] = { provider: s.provider, title: displayTitle(s), agents: Object.fromEntries(s.agents.map((a) => [a.id, a.description || a.kind])) };
      people[key] = { live: s.status !== "ended", tree: treeOf(s.cwd, path), agents: Object.fromEntries(s.agents.map((a) => [a.id, agentWorking(s, a)])) };
      // Paths are judged against the project (an agent's worktree inside it maps back to the project's files).
      const its = items[i];
      const memoKey = `${key}\u0001${path}\u0001${branch}`;
      if (its && its.length) {
        lists.push(rowsOf(its, memoKey, () => changesFromChat(key, its as ItemLike[], path, branch)));
        return;
      }
      // Clock times walked back from the newest event: a long session's old edits keep their days.
      lists.push(rowsOf(s.activity, `${memoKey}\u0001${s.last_event}`, () => changesFromActivity(key, s.activity, path, branch, Date.now(), s.last_event ?? null)));
      const cut = Date.now() - LEDGER_WINDOW_MS;
      for (const a of s.agents) {
        // A subagent that ended before the window is history, like an ended session.
        if (!agentWorking(s, a) && a.last_event && a.last_event < cut) continue;
        lists.push(rowsOf(a.activity, `${memoKey}\u0001${a.id}\u0001${a.last_event}`, () => changesFromActivity(key, a.activity, path, branch, Date.now(), a.last_event ?? null).map((c) => ({ ...c, id: `${c.id}@${a.id}`, step: `g:${a.id}` }))));
      }
    });
    return { changes: mergeChanges(lists, Infinity), sources, people };
  }, [feeding, items, path, branch]);
}

/**
 * File overlaps per project, published by whoever computed them last (Mission control for its project, the
 * sidebar's watcher for every project with two or more sessions), so session rows can mark theirs.
 */
export const useOverlaps = create<{ by: Record<string, Overlap[]> }>(() => ({ by: {} }));

const sameOverlaps = (a: Overlap[] | undefined, b: Overlap[]) =>
  !!a && a.length === b.length && a.every((o, i) => o.file === b[i].file && o.kind === b[i].kind && o.ts === b[i].ts && o.by.map(authorOf).join() === b[i].by.map(authorOf).join());

export function publishOverlaps(path: string, list: Overlap[]) {
  const prev = useOverlaps.getState().by[path];
  if (sameOverlaps(prev, list) || (!prev && list.length === 0)) return;
  useOverlaps.setState((s) => ({ by: { ...s.by, [path]: list } }));
}

/** The overlaps a session is in (any project). */
export function useSessionOverlaps(key: string): Overlap[] {
  return useOverlaps(useShallow((s) => Object.values(s.by).flatMap((l) => l.filter((o) => o.by.some((e) => e.session === key)))));
}
