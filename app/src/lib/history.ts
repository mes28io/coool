// History (APP_SPEC "History"): every past Claude Code and Codex session on this Mac, wherever it ran (coool, a
// terminal, an editor, another app), searched by its words and opened in coool's session view. The backend keeps an
// index in coool's own folder (app/src-tauri/src/history.rs, crates/core/src/history); the CLIs' transcripts are read
// in place and never copied or changed.
//
// `historyQuery` is the one query: the History page, the palette's "in your history" rows and the New session
// sheet's recent sessions per folder (`recentInFolder`) all ask it.

import type { Activity, ActivityKind, Provider } from "./types";
import { api } from "./backend";
import { useStore } from "../store";

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

export function historyTauri(soft: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>): HistoryBackend {
  return {
    historyQuery: (query) => soft("history_query", { query }),
    historyStatus: () => soft("history_status"),
    historyOpen: (provider, id) => soft("history_open", { provider, id }),
    historyEarlier: (a) => soft("history_earlier", { provider: a.provider, sessionId: a.sessionId, keep: a.keep, before: a.before ?? null, first: a.first ?? null, limit: a.limit }),
    historyFolder: (cwd) => soft("history_folder", { cwd }),
    historyMakeFolder: (cwd) => soft("history_make_folder", { cwd }),
  };
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

// ---------- the page's filters ----------

export type DateRange = "any" | "today" | "week" | "month" | "year" | "custom";

export interface HistoryFilters {
  text: string;
  project: string | null;
  provider: Provider | null;
  wheres: Where[];
  range: DateRange;
  /** "custom": yyyy-mm-dd, either may be empty. */
  from: string;
  to: string;
  changes: boolean;
}

export const NO_FILTERS: HistoryFilters = { text: "", project: null, provider: null, wheres: [], range: "any", from: "", to: "", changes: false };

const DAY = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The filters as a query. */
export function toQuery(f: HistoryFilters, now = Date.now()): HistoryQuery {
  let from: number | null = null;
  let to: number | null = null;
  if (f.range === "today") from = startOfDay(now);
  else if (f.range === "week") from = startOfDay(now) - 6 * DAY;
  else if (f.range === "month") from = startOfDay(now) - 29 * DAY;
  else if (f.range === "year") from = startOfDay(now) - 364 * DAY;
  else if (f.range === "custom") {
    const p = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`).getTime() : NaN);
    const a = p(f.from);
    const b = p(f.to);
    if (!Number.isNaN(a)) from = a;
    if (!Number.isNaN(b)) to = b + DAY - 1;
  }
  return {
    text: f.text.trim(),
    project: f.project,
    providers: f.provider ? [f.provider] : [],
    wheres: f.wheres,
    from_ms: from,
    to_ms: to,
    has_changes: f.changes,
  };
}

/** How many filters (beyond the words) are set. */
export function filtersOn(f: HistoryFilters): number {
  return (f.project ? 1 : 0) + (f.provider ? 1 : 0) + (f.wheres.length ? 1 : 0) + (f.range !== "any" ? 1 : 0) + (f.changes ? 1 : 0);
}

/** "Today", "Yesterday", "Tuesday" (this week), "Mon 3 Nov", "Mon 3 Nov 2024". */
export function dayLabel(ms: number, now = Date.now()): string {
  const d = startOfDay(ms);
  const today = startOfDay(now);
  const days = Math.round((today - d) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const date = new Date(ms);
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

/** Rows grouped by the day of their last activity, in the order given. */
export function byDay<T extends { last_ms: number }>(rows: T[], now = Date.now()): { day: string; rows: T[] }[] {
  const out: { day: string; rows: T[] }[] = [];
  for (const r of rows) {
    const day = dayLabel(r.last_ms, now);
    const last = out[out.length - 1];
    if (last && last.day === day) last.rows.push(r);
    else out.push({ day, rows: [r] });
  }
  return out;
}

/** "3 prompts", "1 prompt". */
export function promptsLabel(n: number): string {
  return `${n} ${n === 1 ? "prompt" : "prompts"}`;
}

/** How long it ran, first to last activity: "12 min", "3 h", "2 days" (null under a minute). */
export function spanLabel(started: number, last: number): string | null {
  const m = Math.round((last - started) / 60_000);
  if (m < 1) return null;
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}
