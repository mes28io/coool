// How a transcript-read subagent stands, as the Agents panel, the fan-out, Mission control's
// "N agents working" and the sidebar's nested rows all show it. crates/core decides the state from
// the parent's records (crates/core/src/subagents.rs); this file only reads it. Plain data, no React,
// so it can be unit tested (agentState.test.ts).

import type { Agent, AgentState, Session, Status } from "./types";

/** The agent's state; a payload without one (older backend, mocks) falls back to `finished`. */
export const stateOf = (a: Pick<Agent, "finished" | "state">): AgentState => a.state ?? (a.finished ? "done" : "running");

/** Still working: running by the record, in a session that has not ended. */
export const agentWorking = (s: Pick<Session, "status">, a: Pick<Agent, "finished" | "state">) => s.status !== "ended" && stateOf(a) === "running" && !a.finished;

/** Subagents still working inside a session (never for an ended one). */
export function runningAgents(s: Session): Agent[] {
  return s.status === "ended" ? [] : s.agents.filter((a) => agentWorking(s, a));
}

/** "40 min", "2h 5m", "3 days". */
export function silentFor(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.round(h / 24)} days`;
}

/**
 * How a finished agent's card reads: a stopped one neutral ("Stopped"), a failed one red, a quiet one neutral
 * with how long it has been silent ("No activity for 40 min") and never "Done". Null for running / done.
 */
export function agentEnd(a: Pick<Agent, "finished" | "state" | "last_event">, now = Date.now()): { stopped: boolean; quiet: boolean; error: string | null } | null {
  switch (stateOf(a)) {
    case "stopped":
      return { stopped: true, quiet: false, error: null };
    case "failed":
      return { stopped: false, quiet: false, error: null };
    case "quiet":
      return { stopped: true, quiet: true, error: a.last_event ? `No activity for ${silentFor(now - a.last_event)}` : "No activity" };
    default:
      return null;
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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

/** Mission control's row: "4 agents working", "1 agent, 2 jobs working", or null when none works. */
export function crewLabel(agents: number, jobs: number): string | null {
  return agents ? `${plural(agents, "agent", "agents")}${jobs > 0 ? `, ${plural(jobs, "job", "jobs")}` : ""} working` : null;
}
