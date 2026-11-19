// The AI reads of permission requests (lib/explain.ts), one per request id, shared by the chat's card and the Needs
// you page so a request is read once. Never blocks anything: a read is asked for in the background, fills in when it
// arrives, and gives up quietly after `WAIT_MS` (the backend caps its own call too). UI state only, never persisted.

import { create } from "zustand";
import { api } from "./backend";
import { cleanReply, type ExplainReply, type ExplainRequest } from "./explain";

export type ReadState = { status: "pending"; since: number } | { status: "timeout" } | ExplainReply;

export const WAIT_MS = 25_000;

export const useReads = create<{ reads: Record<string, ReadState> }>(() => ({ reads: {} }));

const set = (id: string, r: ReadState) => useReads.setState((st) => ({ reads: { ...st.reads, [id]: r } }));

/** Asks for the read of `req` unless it was asked already (an error or "off" can be asked again with `retry`). */
export function askRead(req: ExplainRequest, retry = false) {
  const cur = useReads.getState().reads[req.id];
  if (cur && !(retry && (cur.status === "error" || cur.status === "off" || cur.status === "timeout" || cur.status === "limited"))) return;
  set(req.id, { status: "pending", since: Date.now() });
  let done = false;
  const timer = setTimeout(() => {
    if (!done && useReads.getState().reads[req.id]?.status === "pending") set(req.id, { status: "timeout" });
  }, WAIT_MS);
  void api()
    .explainRequest(req)
    .then((raw) => cleanReply(raw))
    .catch((e: unknown) => ({ status: "error", message: e instanceof Error ? e.message : String(e) }) as ExplainReply)
    .then((r) => {
      done = true;
      clearTimeout(timer);
      // A read that comes back after the wait still fills in.
      set(req.id, r);
    });
}

// ---- "Turn on the AI read" hint: the first few times only (a per-viewer convenience) ----

const HINT_KEY = "coool.explain.offHint";
const HINT_TIMES = 3;
const hinted = new Set<string>();

/** True while the hint should show for request `id` (counted once per request, at most `HINT_TIMES` requests). */
export function offHint(id: string): boolean {
  if (hinted.has(id)) return true;
  let n = 0;
  try {
    n = Number(localStorage.getItem(HINT_KEY) || "0") || 0;
  } catch {}
  if (n >= HINT_TIMES) return false;
  hinted.add(id);
  try {
    localStorage.setItem(HINT_KEY, String(n + 1));
  } catch {}
  return true;
}

/** Hides the hint for good. */
export function dismissOffHint() {
  try {
    localStorage.setItem(HINT_KEY, String(HINT_TIMES));
  } catch {}
  hinted.clear();
}
