// Live status and "Needs you" for any session, merging three sources:
// discovered Session status, chat run state (events), and AI insights.
// Selectors return primitives/strings so streamed deltas don't re-render lists.

import { useMemo } from "react";
import { chatNeeds, chatStatus, useChats } from "./chat";
import type { Session, Status } from "./types";

export interface ChatDigest {
  needs: Record<number, string>;
  status: Record<number, Status>;
}

/** One string per chat state change; parsed once per change. */
export function useChatDigest(): ChatDigest {
  const key = useChats((st) => {
    let out = "";
    for (const c of Object.values(st.chats)) {
      if (!c.ready && !c.items.length) continue;
      // Handed to a terminal: the CLI moves processes, the session goes on.
      const status = !c.running && st.handoff[c.id] ? "idle" : chatStatus(c);
      out += `${c.id}\u0001${status}\u0001${chatNeeds(c) ?? ""}\u0002`;
    }
    return out;
  });
  return useMemo(() => {
    const d: ChatDigest = { needs: {}, status: {} };
    for (const row of key.split("\u0002")) {
      if (!row) continue;
      const [id, status, needs] = row.split("\u0001");
      d.status[+id] = status as Status;
      if (needs) d.needs[+id] = needs;
    }
    return d;
  }, [key]);
}

export interface Attention {
  status: Status;
  /** Why the session is blocked on the person, or null. */
  needs: string | null;
  /** "approval" = a pending permission request; "insight" = AI insight said so. */
  source: "approval" | "insight" | null;
}

export function attention(s: Session, d: ChatDigest): Attention {
  const chat = s.chat ?? null;
  const cs = chat !== null ? d.status[chat] : undefined;
  // A chat that exited still leaves a live PTY (open in terminal), so only trust "ended" from discovery then.
  const status: Status = cs && !(cs === "ended" && s.managed !== null) ? cs : s.status;
  const approval = chat !== null ? (d.needs[chat] ?? null) : null;
  if (approval) return { status, needs: approval, source: "approval" };
  const ins = status !== "ended" ? (s.insight?.needs_you ?? null) : null;
  return { status, needs: ins, source: ins ? "insight" : null };
}

export function useAttention(s: Session | null): Attention | null {
  const d = useChatDigest();
  return s ? attention(s, d) : null;
}
