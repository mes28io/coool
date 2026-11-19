// The status-change log behind Mission control's agent lanes (lib/lanes.ts): for every session, what coool saw it
// doing and when (working, needs you, waiting, ended), noted from each sessions payload and chat change. Bounded: per
// session by time and count (`noteLane`), and sessions with nothing left to draw are dropped. UI only, never persisted:
// a session's lane starts when this app first saw it.

import { create } from "zustand";
import { useStore } from "../store";
import { chatNeeds, chatStatus, useChats } from "./chat";
import { laneStale, noteLane, type LaneLog, type LaneState } from "./lanes";
import { attention, type ChatDigest } from "./live";
import { sessionKey, type Session } from "./types";

export const useLaneLog = create<{ logs: Record<string, LaneLog> }>(() => ({ logs: {} }));

function digest(): ChatDigest {
  const st = useChats.getState();
  const d: ChatDigest = { needs: {}, status: {} };
  for (const c of Object.values(st.chats)) {
    if (!c.ready && !c.items.length) continue;
    d.status[c.id] = !c.running && st.handoff[c.id] ? "idle" : chatStatus(c);
    const n = chatNeeds(c);
    if (n) d.needs[c.id] = n;
  }
  return d;
}

function stateOf(s: Session, d: ChatDigest): LaneState {
  const a = attention(s, d);
  if (a.status === "ended") return "ended";
  if (a.needs) return "needs";
  return a.status === "busy" ? "working" : "idle";
}

/** The turn that just ended failed: the transcript's last line is an error that ended the turn (not one failed step). */
const endedInError = (s: Session) => {
  const last = s.activity[s.activity.length - 1];
  return !!last && last.kind === "error" && !last.step;
};

function note() {
  const st = useStore.getState();
  if (!st.ready) return;
  const d = digest();
  const now = Date.now();
  const prev = useLaneLog.getState().logs;
  let next: Record<string, LaneLog> | null = null;
  const live = new Set<string>();
  for (const s of st.allSessions) {
    const k = sessionKey(s);
    live.add(k);
    const state = stateOf(s, d);
    const old = prev[k];
    // A session first seen ended has no lane to start.
    if (!old && state === "ended") continue;
    const log = noteLane(old, state, now, (state === "idle" || state === "ended") && endedInError(s));
    if (log !== old) (next ??= { ...prev })[k] = log;
  }
  for (const [k, log] of Object.entries(next ?? prev)) {
    if (!live.has(k) || laneStale(log, now)) {
      next ??= { ...prev };
      delete next[k];
    }
  }
  if (next) useLaneLog.setState({ logs: next });
}

let started = false;
/** Start noting (once, at boot). Coalesced to one pass per 250 ms however often the stores change. */
export function startLaneLog() {
  if (started) return;
  started = true;
  let t: ReturnType<typeof setTimeout> | null = null;
  const soon = () => {
    if (t === null) t = setTimeout(() => ((t = null), note()), 250);
  };
  useStore.subscribe((s, p) => {
    if (s.allSessions !== p.allSessions || s.ready !== p.ready) soon();
  });
  useChats.subscribe((s, p) => {
    if (s.chats !== p.chats) soon();
  });
  // Quiet logs age out even when nothing changes.
  setInterval(note, 60_000);
  soon();
}
