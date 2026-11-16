// The sessions payloads from the Tauri backend (APP_SPEC "Backend contract"):
// one full `sessions` payload, then `sessions-delta`s with only what changed.

import type { Activity, Agent, Session, Snapshot } from "./types";
import { sessionKey } from "./types";

/** The sessions payload fields besides the sessions themselves. */
export type SnapshotRest = Omit<Snapshot, "sessions">;
/** `COOOL_TRACE_SESSIONS` (backend): when the payload was emitted. */
export type Trace = { seq: number; at: number };
/** `sessions` event / `list_sessions`: the whole state. */
export type FullWire = SnapshotRest & { seq?: number; order?: string[]; sessions: Session[]; trace?: Trace };
/**
 * A list as a change to the one held: its `keep` items starting at `from`, each `edit` replacing the item at that
 * index (of the kept ones), then `tail`. Items not edited keep their object identity.
 */
export type ListPatch<T, E = T> = { from: number; keep: number; edit: [number, E][]; tail: T[] };
type AgentPatch = { head: Omit<Agent, "activity">; activity: ListPatch<Activity> };
/** A changed session the UI already holds: every field but the two lists, and those as list patches. */
export type SessionPatch = { head: Omit<Session, "activity" | "agents">; activity: ListPatch<Activity>; agents: ListPatch<Agent, AgentPatch> };
/**
 * `sessions-delta`: the sessions that changed since payload `base`, whole (`upsert`) or as a change to the one held
 * (`patch`); `order` lists every session key.
 */
export type DeltaWire = SnapshotRest & { seq: number; base: number; order: string[]; upsert: Record<string, Session>; patch?: Record<string, SessionPatch>; trace?: Trace };

class Gap extends Error {}

export function applyList<T, E>(old: T[], p: ListPatch<T, E>, edit: (old: T, e: E) => T): T[] {
  if (p.from < 0 || p.keep < 0 || p.from + p.keep > old.length) throw new Gap();
  // Nothing changed: the same array, so memos keyed on it hold.
  if (p.from === 0 && p.keep === old.length && !p.edit.length && !p.tail.length) return old;
  const out = old.slice(p.from, p.from + p.keep);
  for (const [i, e] of p.edit) {
    if (i < 0 || i >= out.length) throw new Gap();
    out[i] = edit(out[i], e);
  }
  return p.tail.length ? out.concat(p.tail) : out;
}

export function applySession(old: Session, p: SessionPatch): Session {
  return {
    ...p.head,
    activity: applyList(old.activity, p.activity, (_, e) => e),
    agents: applyList(old.agents, p.agents, (o, e) => ({ ...e.head, activity: applyList(o.activity, e.activity, (_, x) => x) })),
  } as Session;
}

/**
 * Rebuilds full snapshots from one `sessions` payload plus `sessions-delta`s
 * (APP_SPEC "Backend contract"). Unchanged sessions keep their object identity
 * across payloads, so memoised views skip them; within a patched session, so do
 * unchanged timeline entries, subagents and lists. A delta that doesn't apply to
 * what is held (one was missed) triggers a fresh `list_sessions`.
 */
export class SessionsMerge {
  private seq = -1;
  private byKey = new Map<string, Session>();
  private order: string[] = [];
  private rest: SnapshotRest = { pending: [] };

  /** Returns the snapshot, or null if `w` is older than what is held. */
  full(w: FullWire): Snapshot | null {
    const seq = w.seq ?? 0;
    if (seq < this.seq) return null;
    const { seq: _s, order, sessions, trace: _t, ...rest } = w;
    const keys = order && order.length === sessions.length ? order : sessions.map(sessionKey);
    const prev = this.byKey;
    this.byKey = new Map();
    keys.forEach((k, i) => {
      const old = prev.get(k);
      // Same content as before: keep the old object.
      this.byKey.set(k, old && sameSession(old, sessions[i]) ? old : sessions[i]);
    });
    this.order = keys;
    this.seq = seq;
    this.rest = rest;
    return this.snapshot();
  }

  /** Returns the snapshot, or "stale" (already have it) / "gap" (missed a payload: resync). */
  delta(w: DeltaWire): Snapshot | "stale" | "gap" {
    if (w.seq <= this.seq) return "stale";
    if (w.base !== this.seq) return "gap";
    const { seq, base: _b, order, upsert, patch, trace: _t, ...rest } = w;
    const next = new Map<string, Session>();
    for (const k of order) {
      const held = this.byKey.get(k);
      const p = patch?.[k];
      let s: Session | undefined = upsert[k];
      if (!s && p) {
        if (!held) return "gap";
        try {
          s = applySession(held, p);
        } catch (e) {
          if (e instanceof Gap) return "gap";
          throw e;
        }
      }
      s ??= held;
      if (!s) return "gap";
      next.set(k, s);
    }
    this.byKey = next;
    this.order = order;
    this.seq = seq;
    this.rest = rest;
    return this.snapshot();
  }

  snapshot(): Snapshot {
    return { ...this.rest, sessions: this.order.map((k) => this.byKey.get(k)!) };
  }
}

const sameSession = (a: Session, b: Session) => a.updated === b.updated && JSON.stringify(a) === JSON.stringify(b);
