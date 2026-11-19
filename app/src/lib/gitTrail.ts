// Each project's git history for Mission control's commit trail (`git_trail`, read-only).
// Fetched when a trail mounts, again every POLL_MS while the window is visible, and right
// away when `poke` changes (an agent committed, pushed or merged: see MissionControl).
// One poll per project however many views show it (Mission control and the sidebar's
// overlap watch both read the same trail).

import { useEffect } from "react";
import { create } from "zustand";
import { api } from "./backend";
import type { GitTrail } from "./types";

const POLL_MS = 15_000;

interface Entry {
  trail: GitTrail | null;
  /** Not a repository, git missing, ... */
  error: string | null;
  at: number;
}

export const useGitTrails = create<{ by: Record<string, Entry> }>(() => ({ by: {} }));

const inflight = new Set<string>();

async function load(path: string) {
  if (inflight.has(path)) return;
  inflight.add(path);
  try {
    const trail = await api().gitTrail(path);
    useGitTrails.setState((s) => {
      const prev = s.by[path]?.trail;
      // Unchanged: keep the object, so nothing re-renders.
      const same = prev && JSON.stringify(prev) === JSON.stringify(trail);
      return { by: { ...s.by, [path]: { trail: same ? prev : trail, error: null, at: Date.now() } } };
    });
  } catch (e) {
    useGitTrails.setState((s) => ({ by: { ...s.by, [path]: { trail: null, error: String(e instanceof Error ? e.message : e), at: Date.now() } } }));
  } finally {
    inflight.delete(path);
  }
}

/** Polls per path, shared by every view of it: how many watch it, and the one timer. */
const polls = new Map<string, { n: number; timer: ReturnType<typeof setInterval> }>();

function watch(path: string): () => void {
  const p = polls.get(path);
  if (p) p.n++;
  else {
    void load(path);
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void load(path);
    }, POLL_MS);
    polls.set(path, { n: 1, timer });
  }
  return () => {
    const q = polls.get(path);
    if (!q || --q.n > 0) return;
    clearInterval(q.timer);
    polls.delete(path);
  };
}

/** The trail for `path` (undefined while the first read runs). */
export function useGitTrail(path: string, poke: string): Entry | undefined {
  const entry = useGitTrails((s) => s.by[path]);
  useEffect(() => watch(path), [path]);
  useEffect(() => {
    if (!poke) return;
    // A commit shows in git a moment after the command that made it ends.
    const t = setTimeout(() => void load(path), 400);
    return () => clearTimeout(t);
  }, [path, poke]);
  return entry;
}
