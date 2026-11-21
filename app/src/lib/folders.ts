// The New session sheet's folder finder, the app side: the `folders_*` commands' types (crates/core/src/folders,
// app/src-tauri/src/folders.rs), small caches so a folder already seen lists at once, and the person's favourites and
// the guarded places they opened (localStorage, like the other UI settings).

import { useSyncExternalStore } from "react";
import type { Provider } from "./types";

export interface FolderEntry {
  name: string;
  path: string;
  repo: boolean;
  hidden: boolean;
  link: boolean;
}
export interface FolderListing {
  path: string;
  parent: string | null;
  entries: FolderEntry[];
  files: number;
  hidden: number;
  more: boolean;
  protected: string | null;
  /** In a place macOS guards that the person hasn't opened yet: nothing was read. */
  gated: boolean;
  error: string | null;
}
export interface FolderHit {
  path: string;
  name: string;
  repo: boolean;
  modified_ms: number;
}
export interface FolderPlace {
  kind: "home" | "desktop" | "documents" | "downloads" | "code";
  label: string;
  path: string;
  guarded: boolean;
}
export interface FolderIndex {
  home: string;
  places: FolderPlace[];
  hits: FolderHit[];
  at_ms: number;
  scanning: boolean;
  roots: string[];
}
export interface FolderCompletion {
  dir: string;
  matches: string[];
  completed: string | null;
  gated: boolean;
}
export interface FolderCommit {
  short: string;
  subject: string;
  when_ms: number;
}
export interface FolderGit {
  root: string;
  branch: string | null;
  changes: number | null;
  last: FolderCommit | null;
  worktree_of: string | null;
  at_root: boolean;
}
export interface FolderCtxFile {
  label: string;
  path: string;
  source: string;
  tokens: number;
}
export interface FolderCtx {
  project: FolderCtxFile[];
  user: number;
  skills: number;
  project_skills: number;
  memory: boolean;
  tokens: number;
}
export interface FolderSummary {
  path: string;
  exists: boolean;
  is_dir: boolean;
  inside_home: boolean;
  writable: boolean;
  protected: string | null;
  gated: boolean;
  folders: number;
  files: number;
  stack: string[];
  git: FolderGit | null;
  context: FolderCtx | null;
}

/** The calls (lib/backend.ts implements them for Tauri and the browser mock). */
export interface FoldersBackend {
  foldersIndex(extra: string[], refresh: boolean): Promise<FolderIndex>;
  foldersList(path: string, hidden: boolean, allow: boolean): Promise<FolderListing>;
  foldersComplete(input: string, allow: boolean): Promise<FolderCompletion>;
  foldersSummary(path: string, provider: Provider, allow: boolean): Promise<FolderSummary>;
  /** A new folder inside the home folder (never over anything); `git`: `git init` it. Its path. */
  foldersCreate(parent: string, name: string, git: boolean): Promise<string>;
  /** A new worktree of the folder's repository for a chat (`.coool/worktrees/<name>`, branch `coool/<name>`). */
  worktreeCreate(project: string, name: string): Promise<{ path: string; branch: string }>;
}

// ---------- the person's choices ----------

function stored<T>(key: string, d: T) {
  let v: T = d;
  try {
    const s = localStorage.getItem(key);
    if (s) v = JSON.parse(s) as T;
  } catch {
    /* private mode or a bad value: the default */
  }
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set(next: T) {
      v = next;
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* lasts for this window */
      }
      subs.forEach((f) => f());
    },
    use: () =>
      useSyncExternalStore(
        (f) => (subs.add(f), () => subs.delete(f)),
        () => v,
      ),
  };
}

const favourites = stored<string[]>("coool.folders.favourites", []);
export const useFavourites = favourites.use;
export function toggleFavourite(path: string) {
  const cur = favourites.get();
  favourites.set(cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path]);
}

/** Places macOS guards that the person chose to open in coool (so they list straight away from then on). */
const opened = stored<string[]>("coool.folders.opened", []);
export const useOpenedPlaces = opened.use;
export function noteOpened(place: string) {
  if (!opened.get().includes(place)) opened.set([...opened.get(), place]);
}

/** Show hidden folders (⌘⇧. as in Finder). */
const hiddenPref = stored<boolean>("coool.folders.hidden", false);
export const useShowHidden = hiddenPref.use;
export const setShowHidden = hiddenPref.set;

// ---------- caches: a folder already seen shows at once, then refreshes ----------

const listings = new Map<string, FolderListing>();
export const cachedListing = (path: string, hidden: boolean) => listings.get(`${hidden ? 1 : 0}${path}`);
export const keepListing = (l: FolderListing, hidden: boolean) => {
  if (listings.size > 200) listings.clear();
  listings.set(`${hidden ? 1 : 0}${l.path}`, l);
};

const summaries = new Map<string, FolderSummary>();
export const cachedSummary = (path: string, provider: Provider) => summaries.get(`${provider}${path}`);
export const keepSummary = (s: FolderSummary, provider: Provider) => {
  if (summaries.size > 100) summaries.clear();
  summaries.set(`${provider}${s.path}`, s);
};
export const forgetFolder = (path: string) => {
  for (const k of listings.keys()) if (k.slice(1) === path) listings.delete(k);
  for (const k of summaries.keys()) if (k.endsWith(path)) summaries.delete(k);
};

let lastIndex: FolderIndex | null = null;
export const cachedIndex = () => lastIndex;
export const keepIndex = (i: FolderIndex) => (lastIndex = i);
