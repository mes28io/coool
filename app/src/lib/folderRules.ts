// The New session sheet's folder finder, the pure part (node tests it: folderRules.test.ts): recent projects from the
// sessions coool knows, search across the sidebar's places, Finder's type-to-select, breadcrumbs, and who works in a
// folder right now. The disk side is crates/core/src/folders (the `folders_*` commands).

import { score } from "./fuzzy.ts";

export interface SessionLike {
  provider: "claude" | "codex";
  id: string;
  cwd: string;
  project?: string;
  status: "busy" | "idle" | "ended";
  pid: number | null;
  updated: number;
  chat?: number | null;
}

export interface RecentProject {
  path: string;
  /** Sessions in it (both CLIs, worktrees and folders inside it included). */
  count: number;
  /** The newest session's time (ms). */
  last: number;
  providers: ("claude" | "codex")[];
}

const projectOf = (s: { project?: string; cwd: string }) => s.project || s.cwd;

/** Folders coool has seen sessions in, newest first, with how many and when last used. */
export function recentProjects(sessions: SessionLike[], max = 8): RecentProject[] {
  const by = new Map<string, RecentProject>();
  for (const s of sessions) {
    const p = projectOf(s);
    if (!p || !p.startsWith("/")) continue;
    const r = by.get(p) ?? { path: p, count: 0, last: 0, providers: [] };
    r.count++;
    r.last = Math.max(r.last, s.updated);
    if (!r.providers.includes(s.provider)) r.providers.push(s.provider);
    by.set(p, r);
  }
  return [...by.values()].sort((a, b) => b.last - a.last).slice(0, max);
}

/**
 * Sessions that ran in `path` itself or one of its worktrees, newest first; with `deep` (a repository's root) in the
 * folders inside it too. A plain folder that holds projects (~/code) doesn't count its projects' sessions as its own.
 */
export function sessionsIn<T extends SessionLike>(sessions: T[], path: string, deep = true): T[] {
  const p = trimSlash(path);
  return sessions.filter((s) => s.cwd === p || projectOf(s) === p || (deep && s.cwd.startsWith(p + "/"))).sort((a, b) => b.updated - a.updated);
}

/** A session still running: working, or idle with its process (or coool's chat) still there. */
export const isLive = (s: SessionLike) => s.status === "busy" || (s.status === "idle" && (s.pid !== null || (s.chat ?? null) !== null));

/** Agents working in this copy of the folder right now (not in one of its worktrees, which are copies of their own); `deep` as for `sessionsIn`. */
export function workingHere<T extends SessionLike>(sessions: T[], path: string, deep = true): T[] {
  const p = trimSlash(path);
  const inTree = (cwd: string) => (cwd === p || (deep && cwd.startsWith(p + "/"))) && !/\/\.(claude|codex|coool)\/worktrees\//.test(cwd.slice(p.length));
  return sessions.filter((s) => isLive(s) && inTree(s.cwd));
}

export const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

export function parentOf(p: string): string | null {
  const t = trimSlash(p);
  if (t === "/" || !t.startsWith("/")) return null;
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
}

export const baseName = (p: string) => trimSlash(p).split("/").pop() || "/";

/** Breadcrumbs from the home folder (shown as its name) or from `/` for a folder outside it. */
export function crumbs(path: string, home: string): { label: string; path: string }[] {
  const p = trimSlash(path);
  const h = trimSlash(home);
  const out: { label: string; path: string }[] = [];
  let rest: string;
  if (h && (p === h || p.startsWith(h + "/"))) {
    out.push({ label: baseName(h), path: h });
    rest = p.slice(h.length);
  } else {
    out.push({ label: "/", path: "/" });
    rest = p === "/" ? "" : p;
  }
  let at = out[0].path === "/" ? "" : out[0].path;
  for (const part of rest.split("/").filter(Boolean)) {
    at += "/" + part;
    out.push({ label: part, path: at });
  }
  return out;
}

/** `~/x` for a path in the home folder. */
export function tilde(p: string, home: string): string {
  const h = trimSlash(home);
  if (h && (p === h || p.startsWith(h + "/"))) return "~" + p.slice(h.length);
  return p;
}

export function untilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return trimSlash(home) + p.slice(1);
  return p;
}

/** Which place macOS guards `p` is in (as crates/core/src/folders `protected`). */
export function guardedPlace(p: string, home: string): string | null {
  const h = trimSlash(home);
  for (const [name, rel] of [["Desktop", "Desktop"], ["Documents", "Documents"], ["Downloads", "Downloads"], ["iCloud Drive", "Library/Mobile Documents"]] as const) {
    const g = `${h}/${rel}`;
    if (p === g || p.startsWith(g + "/")) return name;
  }
  if (/^\/Volumes\/[^/]+/.test(p)) return "Volumes";
  return null;
}

export type Source = "recent" | "favourite" | "repo" | "folder" | "here";
export interface Candidate {
  path: string;
  name: string;
  source: Source;
  repo?: boolean;
  /** Newer ranks a little higher on a tie. */
  last?: number;
}
const SOURCE_RANK: Record<Source, number> = { recent: 4, favourite: 4, here: 3, repo: 2, folder: 0 };

/**
 * Folders whose name matches `q` (fuzzy, like the palette), best first: a name that starts with it beats one that
 * contains it, which beats a scattered match; recent projects and favourites beat repositories, which beat plain
 * folders. A multi-word query must match every word (in the name, or the path for words after the first). One row per
 * path (its best source).
 */
export function searchFolders(q: string, cands: Candidate[], max = 60): Candidate[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const best = new Map<string, { c: Candidate; s: number }>();
  for (const c of cands) {
    const name = c.name.toLowerCase();
    const first = words[0];
    let s = score(first, name);
    if (!s) continue;
    if (name === first) s += 60;
    else if (name.startsWith(first)) s += 30;
    else if (name.includes(first)) s += 12;
    const path = c.path.toLowerCase();
    if (words.slice(1).some((w) => !path.includes(w))) continue;
    s += SOURCE_RANK[c.source] * 3 + (c.repo ? 2 : 0) + Math.min(2, (c.last ?? 0) / 1e13);
    const had = best.get(c.path);
    const repo = !!(c.repo || had?.c.repo);
    if (!had || s > had.s) best.set(c.path, { c: { ...c, repo, source: had && SOURCE_RANK[had.c.source] > SOURCE_RANK[c.source] ? had.c.source : c.source }, s });
    else if (repo && !had.c.repo) had.c = { ...had.c, repo };
  }
  return [...best.values()].sort((a, b) => b.s - a.s || a.c.path.length - b.c.path.length).slice(0, max).map((x) => x.c);
}

/**
 * Finder's type-to-select: the first name that starts with what was typed (case-insensitive), else the first that
 * contains it; -1 for none. Typing the same letter again steps through names starting with it.
 */
export function typeSelect(names: string[], typed: string, current: number): number {
  const t = typed.toLowerCase();
  if (!t) return -1;
  const low = names.map((n) => n.toLowerCase());
  if (t.length > 1 && [...t].every((ch) => ch === t[0])) {
    const starts = low.map((n, i) => (n.startsWith(t[0]) ? i : -1)).filter((i) => i >= 0);
    if (starts.length) return starts.find((i) => i > current) ?? starts[0];
  }
  const s = low.findIndex((n) => n.startsWith(t));
  if (s >= 0) return s;
  return low.findIndex((n) => n.includes(t));
}

/** Why a typed folder name can't be used (as crates/core/src/folders `name_problem`), or null. */
export function nameProblem(name: string, taken: string[]): string | null {
  const n = name.trim();
  if (!n) return "Give the folder a name";
  if (n === "." || n === "..") return "That name is taken by the system";
  if (/[/:\0]/.test(n)) return "A folder name can't contain “/” or “:”";
  if (new TextEncoder().encode(n).length > 255) return "That name is too long";
  if (taken.some((t) => t.toLowerCase() === n.toLowerCase())) return `“${n}” already exists here`;
  return null;
}

/** "untitled folder", then "untitled folder 2"... (Finder's names), free among `taken`. */
export function freshName(taken: string[], base = "untitled folder"): string {
  const low = new Set(taken.map((t) => t.toLowerCase()));
  if (!low.has(base)) return base;
  for (let i = 2; ; i++) if (!low.has(`${base} ${i}`)) return `${base} ${i}`;
}
