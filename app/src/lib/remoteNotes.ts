// coool Remote (docs/REMOTE.md "Minor 1"): what the Needs-you page shows for each pending request (its first line,
// the risk tag, the AI read when there is one), handed to the backend so the phone shows the same words. Loaded by
// lib/remote.ts only in the app; nothing here asks for a read the page wouldn't have asked for.

import { permDetail } from "../components/Chat";
import { pendingPermission, useChats } from "./chat";
import { useReads } from "./explainStore";
import { permKind } from "./needs";
import { riskOf } from "./risk";

interface Note {
  what?: string;
  risk?: string;
  read?: { what: string; why: string; check: string[] };
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** The notes for every pending request now, keyed as the backend keys needs (`<chat>:<request id>`). */
export function needNotes(): Record<string, Note> {
  const out: Record<string, Note> = {};
  const reads = useReads.getState().reads;
  for (const c of Object.values(useChats.getState().chats)) {
    const p = pendingPermission(c);
    if (!p) continue;
    const kind = permKind(p.tool, p.input);
    const n: Note = { what: kind === "plan" ? "Approve a plan" : cap(permDetail(p, c.cwd).lead) };
    const risk = riskOf(p.tool, p.input, c.cwd);
    if (risk) n.risk = risk.reason;
    const r = reads[p.requestId];
    if (r && r.status === "done") n.read = { what: r.read.what, why: r.read.why, check: r.read.check };
    out[`${c.id}:${p.requestId}`] = n;
  }
  return out;
}
