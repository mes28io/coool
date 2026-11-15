// Live status and "Needs you" for any session, merging three sources:
// discovered Session status, chat run state (events), and AI insights.
// Selectors return primitives/strings so streamed deltas don't re-render lists.

import { useMemo } from "react";
import { chatNeeds, chatStatus, useChats } from "./chat";
import type { Agent, Session, Status } from "./types";

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
  /** "busy" also for a session that waits for the person while its background work runs. */
  status: Status;
  /** Why the session is blocked on the person, or null. */
  needs: string | null;
  /**
   * "approval" = a pending permission request in a coool chat; "cli" = the CLI
   * says it waits on the person; "job" = one of its child runs does;
   * "insight" = AI insight said so.
   */
  source: "approval" | "cli" | "job" | "insight" | null;
  /** "Working in background": what still runs ("2 jobs running"), or null. */
  background: string | null;
  /** Subagents of this session that still run (empty for an ended session). */
  agents: Agent[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Subagents still working inside a session (never for an ended one). */
export function runningAgents(s: Session): Agent[] {
  return s.status === "ended" ? [] : s.agents.filter((a) => !a.finished);
}

/** Jobs a live session runs beside its own turn: child runs plus background shells (when the backend lists them). */
export function liveJobs(s: Session): number {
  return s.status === "ended" ? 0 : (s.live_children ?? 0) + (s.shells?.length ?? 0);
}

/** "4 agents, 2 jobs running" / "Background tasks running" for an idle session with live subagents, child runs or shells; else null. */
export function backgroundLabel(s: Session, status: Status, agents = 0): string | null {
  if (status !== "idle") return null;
  const n = liveJobs(s);
  const parts = [agents > 0 && plural(agents, "agent", "agents"), n > 0 && plural(n, "job", "jobs"), n === 0 && !!s.background_tasks && "Background tasks"].filter(Boolean);
  // Without a shell list the CLI only says that background tasks run, not how many.
  return parts.length ? `${parts.join(", ")} running` : null;
}

export function attention(s: Session, d: ChatDigest): Attention {
  const chat = s.chat ?? null;
  const cs = chat !== null ? d.status[chat] : undefined;
  // A chat that exited still leaves a live PTY (open in terminal), so only trust "ended" from discovery then.
  const raw: Status = cs && !(cs === "ended" && s.managed !== null) ? cs : s.status;
  const agents = raw === "ended" ? [] : runningAgents(s);
  const background = backgroundLabel(s, raw, agents.length);
  const status: Status = background ? "busy" : raw;
  const approval = chat !== null ? (d.needs[chat] ?? null) : null;
  if (approval) return { status, needs: approval, source: "approval", background, agents };
  const live = raw !== "ended";
  if (live && s.waiting_for) return { status, needs: `Waiting for you: ${s.waiting_for}`, source: "cli", background, agents };
  if (live && s.child_needs) return { status, needs: s.child_needs, source: "job", background, agents };
  const ins = live ? (s.insight?.needs_you ?? null) : null;
  return { status, needs: ins, source: ins ? "insight" : null, background, agents };
}

export function useAttention(s: Session | null): Attention | null {
  const d = useChatDigest();
  return s ? attention(s, d) : null;
}
