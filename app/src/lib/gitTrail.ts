// Each project's git history for Mission control's commit trail (`git_trail`, read-only).
// Fetched when a trail mounts, again every POLL_MS while the window is visible, and right
// away when `poke` changes (an agent committed, pushed or merged: see MissionControl).

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

/** The trail for `path` (undefined while the first read runs). */
export function useGitTrail(path: string, poke: string): Entry | undefined {
  const entry = useGitTrails((s) => s.by[path]);
  useEffect(() => {
    void load(path);
    const t = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void load(path);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [path]);
  useEffect(() => {
    if (!poke) return;
    // A commit shows in git a moment after the command that made it ends.
    const t = setTimeout(() => void load(path), 400);
    return () => clearTimeout(t);
  }, [path, poke]);
  return entry;
}
