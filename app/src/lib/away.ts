// "While you were away" (APP_SPEC "Mission control", CHAT_SPEC "App behaviour"): what happened while the
// person was not looking, as pure functions over what the app already has: a chat's items, the changes
// agents made (lib/mission.ts) and the store's seen marks.
//
// It stays quiet unless there is something worth saying:
// - The person was gone long enough: 5 minutes for one chat, 10 for Mission control.
// - And something happened that they would not see by just reading on: a turn failed, the CLI exited with
//   an error, something left the machine or the branch (a commit, push, merge, PR, deploy, publish or
//   migration), or two or more turns finished. One finished turn with edits only is routine: its reply is
//   right there, so no card.
// - What waits on the person is never repeated: "Needs you" (Mission control) and the chat's own approval
//   and question cards already show it. A session that needs the person now is left out of Mission
//   control's strip altogether.
//
// Self-contained (type imports only), so `node --test` runs away.test.ts without a bundler.

import type { Change, ChangeKind } from "./mission";

/** Minimum time away before a chat's card shows. */
export const AWAY_CHAT_MS = 5 * 60_000;
/** Minimum time away from the app before Mission control's strip shows. */
export const AWAY_MISSION_MS = 10 * 60_000;
/** At most this many rows in a chat's card before "+N more". */
export const AWAY_ROWS = 5;

/** Changes that left the machine or the branch: worth a word even alone. */
const SHIPPED = new Set<ChangeKind>(["commit", "push", "merge", "pr", "deploy", "publish", "migrate"]);
const FILES = new Set<ChangeKind>(["edit", "create", "delete", "move"]);

/** One absence: `left` is when the person last had it on screen, `back` when it came back (epoch ms). */
export interface Away {
  left: number;
  back: number;
  /** "Got it": the card is folded into a one-line divider for this visit. */
  folded?: boolean;
}

/** The parts of a chat item this needs (lib/chat.ts ChatItem). */
export type AwayItem = {
  kind: string;
  key: string;
  ts: number;
  parent?: string | null;
  text?: string;
  ok?: boolean | null;
  failed?: boolean;
  durationMs?: number;
  code?: number | null;
  answer?: unknown;
  level?: string;
  output?: string;
  stopped?: boolean;
};

export interface AwayTurn {
  /** The turn's end item (its "Worked for" row). */
  key: string;
  /** Its prompt's item key, when the prompt is in the chat. */
  prompt: string | null;
  /** The prompt's text (for the row and for Retry). */
  text: string;
  ts: number;
  durationMs: number;
  failed: boolean;
  /** Distinct files it changed. */
  files: number;
  /** What it shipped: "committed", "pushed"… */
  shipped: string[];
  /** A failed turn's last error line. */
  error: string | null;
}

export interface ChatAway {
  awayMs: number;
  /** Where the card goes: the first top-level item after the person left. */
  firstKey: string | null;
  failed: AwayTurn[];
  done: AwayTurn[];
  /** The CLI exited with an error while away. */
  exited: { key: string; code: number } | null;
  /** Distinct files changed while away. */
  files: number;
  /** Changes that left the machine or the branch while away, newest first. */
  shipped: Change[];
  /** Whether the card shows at all (see the top of this file). */
  worth: boolean;
}

const firstLine = (s: string | undefined) => (s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
const VERB: Partial<Record<ChangeKind, string>> = { commit: "committed", push: "pushed", merge: "merged", pr: "opened a PR", deploy: "deployed", publish: "published", migrate: "migrated" };

/** The turns that ended in (from, to], with their prompt, files and what they shipped. */
function turnsIn(items: AwayItem[], changes: Change[], from: number, to: number): AwayTurn[] {
  const out: AwayTurn[] = [];
  let prompt: AwayItem | null = null;
  let error: string | null = null;
  for (const it of items) {
    if (it.parent) continue;
    if (it.kind === "prompt") {
      prompt = it;
      error = null;
      continue;
    }
    if (it.kind === "notice" && it.level === "error") error = firstLine(it.text) || error;
    else if (it.kind === "tool" && it.ok === false && !it.stopped) error = firstLine(it.output) || error;
    if (it.kind !== "turn" || it.ts <= from || it.ts > to) continue;
    // Stopped by the person (not ok, not failed): nothing to report.
    if (!it.ok && !it.failed) continue;
    const start = prompt?.ts ?? it.ts - (it.durationMs ?? 0);
    const mine = changes.filter((c) => c.ts >= start - 1000 && c.ts <= it.ts + 1000);
    const shipped = SHIP_ORDER.filter((k) => mine.some((c) => c.kind === k)).map((k) => VERB[k]!);
    out.push({
      key: it.key,
      prompt: prompt?.key ?? null,
      text: firstLine(prompt?.text),
      ts: it.ts,
      durationMs: it.durationMs ?? 0,
      failed: !!it.failed,
      files: new Set(mine.filter((c) => FILES.has(c.kind)).map((c) => c.object)).size,
      shipped,
      error: it.failed ? error : null,
    });
  }
  return out;
}

/** What happened in one coool chat while the person was away (`changes`: the chat's, from `changesFromChat`). */
export function chatAway(items: AwayItem[], changes: Change[], away: Away, minMs = AWAY_CHAT_MS): ChatAway {
  const { left, back } = away;
  const awayMs = Math.max(0, back - left);
  const turns = turnsIn(items, changes, left, back);
  const failed = turns.filter((t) => t.failed).reverse();
  const done = turns.filter((t) => !t.failed).reverse();
  let exited: ChatAway["exited"] = null;
  let firstKey: string | null = null;
  for (const it of items) {
    if (it.parent) continue;
    if (firstKey === null && it.ts > left) firstKey = it.key;
    if (it.kind === "exited" && it.ts > left && it.ts <= back && it.code !== null && it.code !== undefined && it.code !== 0) exited = { key: it.key, code: it.code };
  }
  const inWindow = changes.filter((c) => c.ts > left && c.ts <= back);
  const shipped = inWindow.filter((c) => SHIPPED.has(c.kind)).sort((a, b) => b.ts - a.ts);
  const files = new Set(inWindow.filter((c) => FILES.has(c.kind)).map((c) => c.object)).size;
  const worth = awayMs >= minMs && firstKey !== null && (failed.length > 0 || exited !== null || shipped.length > 0 || done.length >= 2);
  return { awayMs, firstKey, failed, done, exited, files, shipped, worth };
}

/** What Mission control's strip needs of a session. */
export interface AwaySession {
  key: string;
  project: string;
  /** Waiting on the person now: shown under "Needs you", so left out here. */
  needs: boolean;
  /** Working right now. */
  busy: boolean;
  /** When the person last had this session on screen (wall clock), if ever. */
  seenAt: number | null;
  /** Last real activity (Session.last_event). */
  lastEvent: number;
  /** A coool chat's items; null for a session read from its transcript. */
  items: AwayItem[] | null;
  /** Its changes (lib/mission.ts). */
  changes: Change[];
}

export type AwayCount = "failed" | "done" | ChangeKind;

export interface MissionAway {
  awayMs: number;
  failed: number;
  done: number;
  /** Shipped changes by kind (commit, push, pr…), in a stable order. */
  shipped: { kind: ChangeKind; n: number }[];
  /** The first session (most recent) for each segment, to jump to. */
  first: Partial<Record<AwayCount, string>>;
  /** Projects with something in the strip, most recent first. */
  projects: string[];
  worth: boolean;
}

const SHIP_ORDER: ChangeKind[] = ["commit", "push", "merge", "pr", "deploy", "publish", "migrate"];

/**
 * Across every session, what happened while the person was away from the app. A session's own window
 * starts when the person left, or when they last had it on screen if that is later; a session they have
 * opened since coming back is read, so it drops out. A chat counts its turns (failed, done); a session read
 * from its transcript has no turn ends, so it counts one "done" when it is no longer working and its last
 * activity falls in the window. Changes count from either.
 */
export function missionAway(sessions: AwaySession[], away: Away, minMs = AWAY_MISSION_MS): MissionAway {
  const { left, back } = away;
  const awayMs = Math.max(0, back - left);
  let failed = 0;
  let done = 0;
  const ship = new Map<ChangeKind, number>();
  const first: MissionAway["first"] = {};
  const latest: Partial<Record<AwayCount, number>> = {};
  const note = (k: AwayCount, key: string, ts: number) => {
    if ((latest[k] ?? -Infinity) < ts) {
      latest[k] = ts;
      first[k] = key;
    }
  };
  const projects = new Map<string, number>();
  for (const s of sessions) {
    if (s.needs) continue;
    if (s.seenAt !== null && s.seenAt > back) continue;
    const from = Math.max(left, s.seenAt ?? -Infinity);
    let any = 0;
    if (s.items) {
      for (const t of turnsIn(s.items, s.changes, from, back)) {
        if (t.failed) failed++;
        else done++;
        note(t.failed ? "failed" : "done", s.key, t.ts);
        any = Math.max(any, t.ts);
      }
    } else if (!s.busy && s.lastEvent > from && s.lastEvent <= back) {
      done++;
      note("done", s.key, s.lastEvent);
      any = Math.max(any, s.lastEvent);
    }
    for (const c of s.changes) {
      if (!SHIPPED.has(c.kind) || c.ts <= from || c.ts > back) continue;
      ship.set(c.kind, (ship.get(c.kind) ?? 0) + 1);
      note(c.kind, s.key, c.ts);
      any = Math.max(any, c.ts);
    }
    if (any) projects.set(s.project, Math.max(projects.get(s.project) ?? 0, any));
  }
  const shipped = SHIP_ORDER.filter((k) => ship.has(k)).map((kind) => ({ kind, n: ship.get(kind)! }));
  const worth = awayMs >= minMs && (failed > 0 || shipped.length > 0 || done >= 2);
  return { awayMs, failed, done, shipped, first, projects: [...projects.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p), worth };
}

/** "2h 14m", "45m", "3d 2h": how long the person was away (never seconds). */
export function awayFor(ms: number): string {
  const m = Math.max(1, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

const NOUN: Record<string, [string, string]> = { commit: ["commit", "commits"], push: ["push", "pushes"], merge: ["merge", "merges"], pr: ["PR", "PRs"], deploy: ["deploy", "deploys"], publish: ["publish", "publishes"], migrate: ["migration", "migrations"] };
/** "3 commits", "1 PR". */
export const shippedLabel = (kind: ChangeKind, n: number) => `${n} ${(NOUN[kind] ?? [kind, kind])[n === 1 ? 0 : 1]}`;
