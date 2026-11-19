// The totals of a turn, for read-only sessions (chats carry them as events): where it began, how long it ran,
// how many steps it took. Derived from the HH:MM:SS stamps of the activity, so every number is "from the stamps",
// except the start when the backend knows it exactly (`tokens.turn_start`): a turn need not begin with a prompt
// (a background task's notification starts one), and counting from the last prompt then showed a live
// "Thinking 9h 54m" for a turn that had just begun.
import type { Activity, Session } from "./types";
import { tsToMs } from "./format.ts";

export interface TurnTotals {
  /** Epoch ms of the person's prompt that started the turn (or the earliest kept entry, see `approxStart`). */
  startMs: number | null;
  endMs: number | null;
  /** Tool uses in the turn, subagents' steps included. */
  tools: number;
  /** The prompt is no longer in the kept window: `startMs` is the earliest entry shown. */
  approxStart: boolean;
}

export function turnTotals(s: Pick<Session, "activity" | "agents"> & { tokens?: Pick<Session["tokens"], "turn_start"> }, now = Date.now()): TurnTotals {
  const a: Activity[] = s.activity;
  if (!a.length) return { startMs: null, endMs: null, tools: 0, approxStart: false };
  let at = -1;
  for (let i = a.length - 1; i >= 0; i--) if (a[i].kind === "prompt") { at = i; break; }
  let from = at >= 0 ? at : 0;
  let startMs = tsToMs(a[from].ts, now);
  let approxStart = at < 0;
  // The exact start, when it is after the prompt found (or no prompt is kept): the turn began there.
  const exact = s.tokens?.turn_start ?? null;
  if (exact !== null && exact <= now + 60_000 && (startMs === null || approxStart || exact > startMs + 1000)) {
    startMs = exact;
    approxStart = false;
    // Its first entry: the first stamped at or after the start (to the second; stamps carry no milliseconds).
    let i = a.length;
    while (i > 0) {
      const t = tsToMs(a[i - 1].ts, now);
      if (t === null || t < exact - 999) break;
      i--;
    }
    from = i;
  }
  let endMs = tsToMs(a[a.length - 1].ts, now);
  // Past midnight (an exact start has milliseconds the stamps lack: a second either way is the same moment).
  if (startMs !== null && endMs !== null && endMs < startMs - 1000) endMs += 86_400_000;
  if (startMs !== null && endMs !== null && endMs < startMs) endMs = startMs;
  let tools = 0;
  for (let i = from; i < a.length; i++) if (a[i].kind === "tool" || a[i].kind === "agent") tools++;
  for (const g of s.agents) for (const x of g.activity) if (x.kind === "tool" || x.kind === "agent") tools++;
  return { startMs, endMs, tools, approxStart };
}
