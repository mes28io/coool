// The sessions payloads from the Tauri backend (APP_SPEC "Backend contract"):
// one full `sessions` payload, then `sessions-delta`s with only what changed.

import type { Session, Snapshot } from "./types";
import { sessionKey } from "./types";

/** The sessions payload fields besides the sessions themselves. */
export type SnapshotRest = Omit<Snapshot, "sessions">;
/** `COOOL_TRACE_SESSIONS` (backend): when the payload was emitted. */
export type Trace = { seq: number; at: number };
/** `sessions` event / `list_sessions`: the whole state. */
export type FullWire = SnapshotRest & { seq?: number; order?: string[]; sessions: Session[]; trace?: Trace };
/** `sessions-delta`: the sessions that changed since payload `base`; `order` lists every session key. */
export type DeltaWire = SnapshotRest & { seq: number; base: number; order: string[]; upsert: Record<string, Session>; trace?: Trace };

/**
 * Rebuilds full snapshots from one `sessions` payload plus `sessions-delta`s
 * (APP_SPEC "Backend contract"). Unchanged sessions keep their object identity
 * across payloads, so memoised views skip them. A delta that doesn't apply to
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
    const { seq, base: _b, order, upsert, trace: _t, ...rest } = w;
    const next = new Map<string, Session>();
    for (const k of order) {
      const s = upsert[k] ?? this.byKey.get(k);
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
