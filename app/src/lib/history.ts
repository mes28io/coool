// History (APP_SPEC "History"): every past Claude Code and Codex session on this Mac, wherever it ran (coool, a
// terminal, an editor, another app), searched by its words and opened in coool's session view. The backend keeps an
// index in coool's own folder (app/src-tauri/src/history.rs, crates/core/src/history); the CLIs' transcripts are read
// in place and never copied or changed.
//
// `historyQuery` is the one query: the History page, the palette's "in your history" rows and the New session
// sheet's recent sessions per folder (`recentInFolder`) all ask it.

import type { Activity, ActivityKind, Provider } from "./types";
import { api } from "./backend";
import { useEffect, useReducer } from "react";
import { useStore } from "../store";

export * from "./historyRules";

export type Where = "coool" | "terminal" | "ide" | "app" | "automation";

export const WHERE_LABEL: Record<Where, string> = {
  coool: "coool",
  terminal: "Terminal",
  ide: "Editor",
  app: "Other apps",
  automation: "Other tools",
};

export interface HistoryQuery {
  /** Words to find (all of them); "quoted words" as one phrase. */
  text?: string;
  /** One project (the folder the sidebar groups by). */
  project?: string | null;
  /** One folder and everything below it. */
  cwd?: string | null;
  providers?: Provider[];
  wheres?: Where[];
  /** Last activity between these (epoch ms). */
  from_ms?: number | null;
  to_ms?: number | null;
  /** Only sessions that changed files. */
  has_changes?: boolean;
  offset?: number;
  /** Rows to return (default 100). */
  limit?: number;
}

export interface HistorySeg {
  t: string;
  hit?: boolean;
}

export interface HistoryRow {
  /** `provider:id`: the session key the app opens by. */
  key: string;
  provider: Provider;
  id: string;
  cwd: string;
  project: string;
  title: string;
  /** The first prompt, one line. */
  prompt: string;
  model: string;
  where: Where;
  /** Where it ran, in words: "Terminal", "VS Code", "Claude app", "coool". */
  via: string;
  started_ms: number;
  last_ms: number;
  prompts: number;
  compactions: number;
  edits: number;
  files: string[];
  bytes: number;
  /** Its folder is gone (moved or deleted). */
  missing: boolean;
  archived: boolean;
  snippet?: HistorySeg[];
}

export interface HistoryStatus {
  sessions: number;
  transcripts: number;
  pending: number;
  text_bytes: number;
  log_bytes: number;
  ready: boolean;
}

export interface HistoryPage {
  rows: HistoryRow[];
  total: number;
  projects: { project: string; count: number; last_ms: number }[];
  status: HistoryStatus;
  took_ms: number;
}

export interface HistoryEarlier {
  /** Oldest first, right before the timeline's first entry (or before `start` of the previous answer). */
  entries: Activity[];
  /** Index of the first one in the whole history: 0 means nothing earlier is left. */
  start: number;
  total: number;
}

export interface HistoryFolder {
  exists: boolean;
  /** Existing folders of the same name other sessions ran in (where a moved project may be now). */
  moved_to: string[];
}

export interface HistoryBackend {
  historyQuery(q: HistoryQuery): Promise<HistoryPage>;
  /** How far the index is (and look for new sessions now). */
  historyStatus(): Promise<HistoryStatus>;
  /** Lists a past session in the app; resolves with its key once it is in the sessions payload. */
  historyOpen(provider: Provider, id: string): Promise<string>;
  /** The part of a long session's history before what its timeline holds. */
  historyEarlier(a: { provider: Provider; sessionId: string; keep: number; before?: number | null; first?: { ts: string; kind: ActivityKind; text: string } | null; limit: number }): Promise<HistoryEarlier>;
  historyFolder(cwd: string): Promise<HistoryFolder>;
  /** Makes a session's deleted folder again (empty), so the CLI can continue there. */
  historyMakeFolder(cwd: string): Promise<void>;
}

/** The New session sheet's "recent here": the newest sessions in a folder (and below it), any age, any CLI. */
export function recentInFolder(cwd: string, limit = 5): Promise<HistoryRow[]> {
  return api()
    .historyQuery({ cwd, limit })
    .then((p) => p.rows);
}

/**
 * Opens a past session in the focused pane: at once when the sidebar already lists it, else after the backend has
 * listed it (a session older than a day). The History page closes.
 */
export async function openHistoryRow(r: Pick<HistoryRow, "key" | "provider" | "id">, opts?: { newTab?: boolean }): Promise<boolean> {
  const st = useStore.getState();
  const known = st.sessions.some((s) => `${s.provider}:${s.id}` === r.key);
  try {
    const key = known ? r.key : await api().historyOpen(r.provider, r.id);
    // The payload that lists it may still be on its way to the store: wait for it (briefly).
    for (let i = 0; i < 40 && !useStore.getState().sessions.some((s) => `${s.provider}:${s.id}` === key); i++) await new Promise((ok) => setTimeout(ok, 50));
    useStore.getState().closeHistory();
    useStore.getState().open({ kind: "session", key }, opts?.newTab ? { newTab: true } : undefined);
    return true;
  } catch (e) {
    st.toast(String(e instanceof Error ? e.message : e), "error");
    return false;
  }
}

// ---------- how many sessions each project has (the sidebar's "Show N more") ----------

const counts = { map: new Map<string, number>(), at: 0, loading: false, subs: new Set<() => void>() };

function refreshCounts() {
  if (counts.loading || Date.now() - counts.at < 60_000) return;
  counts.loading = true;
  api()
    .historyQuery({ limit: 1 })
    .then((p) => {
      counts.map = new Map(p.projects.map((f) => [f.project, f.count]));
      // Still indexing: ask again soon.
      counts.at = p.status.ready ? Date.now() : Date.now() - 50_000;
      counts.subs.forEach((f) => f());
    })
    .catch(() => (counts.at = Date.now()))
    .finally(() => (counts.loading = false));
}

/** Sessions per project in the whole history (empty until known); refreshed at most once a minute. */
export function useHistoryCounts(): Map<string, number> {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    counts.subs.add(bump);
    refreshCounts();
    const t = setInterval(refreshCounts, 15_000);
    return () => {
      counts.subs.delete(bump);
      clearInterval(t);
    };
  }, []);
  return counts.map;
}
