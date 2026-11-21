// The History page's filters and labels (pure; lib/history.ts re-exports them). Tests: historyRules.test.ts.

import type { Provider } from "./types";
import type { HistoryQuery, Where } from "./history";

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
  /** "Started by agents": also the sessions agents and other tools started. */
  agents: boolean;
}

export const NO_FILTERS: HistoryFilters = { text: "", project: null, provider: null, wheres: [], range: "any", from: "", to: "", changes: false, agents: false };

/**
 * A live session an agent or another tool started (the sidebar hides these unless "Show" is on, or lists them under
 * the session that started them): a programmatic run, or one with a known parent (a Ladder helper, a lane, a child
 * run). History's rule for past sessions is the backend's (`started_by`); this is the same rule on what the sessions
 * payload says.
 */
export function byAgent(s: { origin?: string | null; parent?: string | null }): boolean {
  return s.origin === "automation" || !!s.parent;
}

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
    // "Other tools" are agents' runs: picking that place asks for them.
    agents: f.agents || f.wheres.includes("automation"),
  };
}

/** How many filters (beyond the words) are set. */
export function filtersOn(f: HistoryFilters): number {
  return (f.project ? 1 : 0) + (f.provider ? 1 : 0) + (f.wheres.length ? 1 : 0) + (f.range !== "any" ? 1 : 0) + (f.changes ? 1 : 0) + (f.agents ? 1 : 0);
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

