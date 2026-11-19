// Agent lanes (APP_SPEC "Mission control"): one lane per live session over the last 30 minutes, a block per turn
// (working, needs you, failed, done) growing into "now". Pure functions (tested in lanes.test.ts):
//
//   - coool chats have exact history: their prompt / turn-end items and permission and question waits.
//   - Every other session only has what coool itself saw: a small bounded log of status changes, noted from each
//     sessions payload (`noteLane`). Its lane starts when coool first saw it; nothing before that is ever drawn.

export const LANE_WINDOW_MS = 30 * 60_000;
/** Marks older than this are dropped (all but the newest of them, which says what the state was at the window's start). */
export const LANE_KEEP_MS = LANE_WINDOW_MS + 5 * 60_000;
/** At most this many marks per session (oldest dropped first). */
export const LANE_MAX_MARKS = 240;

export type LaneState = "working" | "needs" | "idle" | "ended";
export interface LaneMark {
  at: number;
  state: LaneState;
  /** On the mark that ended a turn: the turn failed (an error ended it). */
  failed?: boolean;
}
export interface LaneLog {
  /** When coool first saw the session: the lane never starts before it. */
  first: number;
  marks: LaneMark[];
}

/** `log` with `state` noted at `at` (the same object back when nothing changed). Bounded by LANE_KEEP_MS and LANE_MAX_MARKS. */
export function noteLane(log: LaneLog | undefined, state: LaneState, at: number, failed = false): LaneLog {
  if (!log) return { first: at, marks: [{ at, state, ...(failed ? { failed } : {}) }] };
  const last = log.marks[log.marks.length - 1];
  if (last && last.state === state) return log;
  let marks = [...log.marks, { at: Math.max(at, last?.at ?? at), state, ...(failed ? { failed } : {}) }];
  const cut = at - LANE_KEEP_MS;
  let k = 0;
  while (k + 1 < marks.length && marks[k + 1].at <= cut) k++;
  if (k > 0) marks = marks.slice(k);
  if (marks.length > LANE_MAX_MARKS) marks = marks.slice(marks.length - LANE_MAX_MARKS);
  return { first: log.first, marks };
}

/** True when the log has nothing left to draw: its last mark is quiet and older than the kept window. */
export function laneStale(log: LaneLog, now: number): boolean {
  const last = log.marks[log.marks.length - 1];
  return !last || ((last.state === "idle" || last.state === "ended") && last.at < now - LANE_KEEP_MS);
}

export type BlockKind = "working" | "done" | "failed";
export interface LaneBlock {
  start: number;
  end: number;
  kind: BlockKind;
  /** Still running: its end is "now". */
  live: boolean;
  /** Stretches inside the turn when it waited on the person. */
  waits: { start: number; end: number }[];
}

function clip(blocks: LaneBlock[], from: number, now: number): LaneBlock[] {
  const out: LaneBlock[] = [];
  for (const b of blocks) {
    if (b.end < from || b.start > now) continue;
    const start = Math.max(b.start, from);
    const end = Math.min(Math.max(b.end, start), now);
    const waits = b.waits.filter((w) => w.end >= start && w.start <= end).map((w) => ({ start: Math.max(w.start, start), end: Math.min(w.end, end) }));
    out.push({ ...b, start, end, waits });
  }
  return out;
}

/** The turns in a status log, from `from` to `now`. A session first seen mid-turn starts its block at `first`. */
export function blocksFromMarks(log: LaneLog, from: number, now: number): LaneBlock[] {
  const out: LaneBlock[] = [];
  let cur: LaneBlock | null = null;
  let wait: number | null = null;
  for (const m of log.marks) {
    const at = Math.max(m.at, log.first);
    if (m.state === "working" || m.state === "needs") {
      if (!cur) cur = { start: at, end: at, kind: "working", live: true, waits: [] };
      if (m.state === "needs" && wait === null) wait = at;
      if (m.state === "working" && wait !== null) {
        cur.waits.push({ start: wait, end: at });
        wait = null;
      }
    } else if (cur) {
      if (wait !== null) cur.waits.push({ start: wait, end: at });
      wait = null;
      out.push({ ...cur, end: at, kind: m.failed ? "failed" : "done", live: false });
      cur = null;
    }
  }
  if (cur) {
    if (wait !== null) cur.waits.push({ start: wait, end: now });
    out.push({ ...cur, end: now });
  }
  return clip(out, Math.max(from, log.first), now);
}

/** The parts of a chat item the lanes read (lib/chat.ts ChatItem). */
export type LaneItem =
  | { kind: "prompt"; ts: number }
  | { kind: "turn"; ts: number; failed: boolean }
  | { kind: "exited"; ts: number; code: number | null }
  | { kind: "permission" | "question"; ts: number; answeredTs: number | null }
  | { kind: string; ts: number };

/** A chat's turns, from its items: prompt to turn end, its permission / question waits inside. `live`: the chat still runs. */
export function blocksFromChat(items: readonly LaneItem[], from: number, now: number, live: boolean): LaneBlock[] {
  const out: LaneBlock[] = [];
  let cur: LaneBlock | null = null;
  let lastTs = 0;
  for (const it of items) {
    lastTs = Math.max(lastTs, it.ts);
    if (it.kind === "prompt" && !("parent" in it && (it as { parent?: unknown }).parent)) {
      if (!cur) cur = { start: it.ts, end: it.ts, kind: "working", live: true, waits: [] };
    } else if (it.kind === "permission" || it.kind === "question") {
      const w = it as unknown as { ts: number; answeredTs: number | null };
      if (!cur) cur = { start: w.ts, end: w.ts, kind: "working", live: true, waits: [] };
      cur.waits.push({ start: w.ts, end: w.answeredTs ?? (live ? now : w.ts) });
    } else if (it.kind === "turn" || it.kind === "exited") {
      if (!cur) continue;
      const failed = it.kind === "turn" ? !!(it as { failed?: boolean }).failed : ((it as { code?: number | null }).code ?? 0) !== 0;
      out.push({ ...cur, end: it.ts, kind: failed ? "failed" : "done", live: false });
      cur = null;
    }
  }
  if (cur) out.push(live ? { ...cur, end: now } : { ...cur, end: Math.max(cur.start, lastTs), kind: "done", live: false });
  return clip(out, from, now);
}

/** Where `t` falls on a lane from `from` to `now`, 0..1. */
export const laneX = (t: number, from: number, now: number) => (now <= from ? 1 : Math.min(1, Math.max(0, (t - from) / (now - from))));

/** "3 working · 1 needs you" (the title bar's running-now pill); "" when nothing is live. */
export function runningLabel(working: number, needs: number): string {
  return [working > 0 && `${working} working`, needs > 0 && `${needs} need${needs === 1 ? "s" : ""} you`].filter(Boolean).join(" · ");
}
