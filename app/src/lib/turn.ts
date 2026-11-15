// The totals of a turn, for read-only sessions (chats carry them as events): where it began, how long it ran,
// how many steps it took. Derived from the HH:MM:SS stamps of the activity, so every number is "from the stamps".
import type { Activity, Session } from "./types";
import { tsToMs } from "./format";

export interface TurnTotals {
  /** Epoch ms of the person's prompt that started the turn (or the earliest kept entry, see `approxStart`). */
  startMs: number | null;
  endMs: number | null;
  /** Tool uses in the turn, subagents' steps included. */
  tools: number;
  /** The prompt is no longer in the kept window: `startMs` is the earliest entry shown. */
  approxStart: boolean;
}

export function turnTotals(s: Pick<Session, "activity" | "agents">): TurnTotals {
  const a: Activity[] = s.activity;
  if (!a.length) return { startMs: null, endMs: null, tools: 0, approxStart: false };
  let at = -1;
  for (let i = a.length - 1; i >= 0; i--) if (a[i].kind === "prompt") { at = i; break; }
  const from = at >= 0 ? at : 0;
  const startMs = tsToMs(a[from].ts);
  let endMs = tsToMs(a[a.length - 1].ts);
  if (startMs !== null && endMs !== null && endMs < startMs) endMs += 86_400_000; // midnight
  let tools = 0;
  for (let i = from; i < a.length; i++) if (a[i].kind === "tool" || a[i].kind === "agent") tools++;
  for (const g of s.agents) for (const x of g.activity) if (x.kind === "tool" || x.kind === "agent") tools++;
  return { startMs, endMs, tools, approxStart: at < 0 };
}
