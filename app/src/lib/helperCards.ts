// How the Jobs panel reads a lead's helpers beyond the plain sub-agent call (APP_SPEC "Ladder 2", "Jobs"):
//
// - A background `Agent` call returns at once ("Async agent launched …, agentId: …"): that result is not the
//   helper's end and not its result. The helper runs until its completion notification (or a stop / failure, or the
//   silence rule: crates/core/src/subagents.rs); its steps, tokens and timing come from its own sub-agent
//   transcript (the session's `agents`), found by the agent id in that acknowledgement.
// - A helper started from the shell (`codex exec`, `claude -p`; crates/core/src/lanes.rs): the backend pairs it with
//   the session it writes and says how it stands (`Session.lane`); one whose session was not found is still shown,
//   from the lead's `lanes`.
//
// Pure: unit-tested by helperCards.test.ts.

import type { AgentCardData } from "./agentCards";
import type { Agent, AgentState, LaneInfo, Provider } from "./types";

/** What Claude Code returns for an `Agent` call launched with `run_in_background`. */
export const ASYNC_ACK = /^\s*Async agent launched/i;

/** The agent id in a background launch's acknowledgement ("agentId: a2208cbfae92b7f28 (…)"). */
export function launchedAgentId(output: string | null | undefined): string | null {
  const m = /\bagentId:\s*([A-Za-z0-9_-]+)/.exec(output ?? "");
  return m ? m[1] : null;
}

/** The call was launched in the background (by its input, or by the acknowledgement it returned). */
export function isBackgroundCall(input: unknown, output: string | null | undefined): boolean {
  return (input as { run_in_background?: unknown } | null)?.run_in_background === true || ASYNC_ACK.test(output ?? "");
}

/**
 * The transcript sub-agent a background call started: by the agent id it returned, else (no result yet) the one
 * with the call's description that no other call claimed, started closest after it.
 */
export function agentForCall(call: { input: unknown; output: string | null | undefined; ts: number }, agents: Agent[], claimed: Set<string> = new Set(), firstAt: (a: Agent) => number | null = () => null): Agent | null {
  const id = launchedAgentId(call.output);
  if (id) return agents.find((a) => a.id === id) ?? null;
  const desc = (call.input as { description?: unknown } | null)?.description;
  if (typeof desc !== "string" || !desc) return null;
  const same = agents.filter((a) => a.description === desc && !claimed.has(a.id));
  if (same.length <= 1) return same[0] ?? null;
  const after = same.map((a) => ({ a, t: firstAt(a) })).filter((x) => x.t === null || x.t >= call.ts - 5_000);
  after.sort((x, y) => (x.t ?? Infinity) - (y.t ?? Infinity));
  return after[0]?.a ?? null;
}

export type HelperCardState = "running" | "done" | "failed";

/** A lane's state as a card shows it: stopped and quiet are neutral "failed" cards, like a sub-agent's. */
export function laneCardState(s: AgentState): { state: HelperCardState; stopped: boolean; quiet: boolean } {
  switch (s) {
    case "running":
      return { state: "running", stopped: false, quiet: false };
    case "done":
      return { state: "done", stopped: false, quiet: false };
    case "failed":
      return { state: "failed", stopped: false, quiet: false };
    case "stopped":
      return { state: "failed", stopped: true, quiet: false };
    case "quiet":
      return { state: "failed", stopped: true, quiet: true };
  }
}

/** The last two segments of a folder: "spike-wt/bench". */
export function shortDir(dir: string | null | undefined): string {
  if (!dir) return "";
  const parts = dir.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

/** "codex exec · spike-wt/bench": how it was started and where (its worktree when one was given). */
export function laneKind(l: Pick<LaneInfo, "provider" | "cwd">, parentCwd?: string | null): string {
  const how = l.provider === "codex" ? "codex exec" : "claude -p";
  const where = l.cwd && l.cwd !== parentCwd ? shortDir(l.cwd) : "";
  return where ? `${how} · ${where}` : how;
}

/** Its own span: ended - started, or null while it runs. */
export const laneDuration = (l: Pick<LaneInfo, "started" | "ended">): number | null => (l.ended !== null ? Math.max(0, l.ended - l.started) : null);

/** What a lane card says when it did not end on its own record. */
export function laneError(l: Pick<LaneInfo, "state" | "session">): string | null {
  switch (l.state) {
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    case "quiet":
      return l.session ? "Ended without a final record" : "No session file found";
    default:
      return null;
  }
}

/** A lead's lanes by the call that started them, in launch order. */
export function lanesByCall(lanes: LaneInfo[] | null | undefined): Record<string, LaneInfo[]> {
  const out: Record<string, LaneInfo[]> = {};
  for (const l of lanes ?? []) (out[l.tool] ??= []).push(l);
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.index - b.index);
  return out;
}

/** Which CLI a helper's provider word is ("Codex", "Claude"). */
export const providerWord = (p: Provider) => (p === "codex" ? "Codex" : "Claude");

/**
 * A background `Agent` call's card. `own`: the card its own transcript gives (state, steps, tokens, span), when the
 * sub-agent was found; the call's card keeps its identity, kind, brief and place. Without it: running from the launch
 * while the chat lives (the acknowledgement is neither its end nor its result), quiet once the chat is gone.
 */
export function mergeBackground(card: AgentCardData, own: AgentCardData | null, t: { ts: number; output: string; ok: boolean | null; endTs: number | null }, chatRunning: boolean): AgentCardData {
  if (own)
    return {
      ...own,
      id: card.id,
      source: card.source,
      ref: card.ref,
      kind: card.kind,
      description: card.description || own.description,
      model: own.model ?? card.model,
      tokens: own.tokens || card.tokens,
      fill: own.fill ?? card.fill,
      handoff: card.handoff ?? own.handoff,
      handoffFull: card.handoffFull ?? own.handoffFull,
      startedAt: Math.min(t.ts, own.startedAt ?? t.ts),
      lastAt: Math.max(own.lastAt, t.ts),
      depth: card.depth,
      parentRef: card.parentRef,
    };
  // A launch that failed outright (no acknowledgement) is what the call says.
  if (!ASYNC_ACK.test(t.output) && t.endTs !== null && t.ok === false) return card;
  return {
    ...card,
    state: chatRunning ? "running" : "failed",
    stopped: !chatRunning,
    quiet: !chatRunning,
    error: chatRunning ? null : "No activity recorded",
    durationMs: null,
    result: null,
    active: chatRunning ? card.active : -1,
    since: chatRunning ? (card.since ?? t.ts) : card.since,
    startedAt: t.ts,
  };
}

/** A helper started from the shell: how it stands and its span come from its lane (crates/core/src/lanes.rs). */
export function withLane(card: AgentCardData, l: LaneInfo, model: string | null, parentCwd?: string | null): AgentCardData {
  const s = laneCardState(l.state);
  const running = s.state === "running";
  return {
    ...card,
    provider: l.provider,
    model: model || l.model || card.model,
    kind: laneKind(l, parentCwd),
    description: l.brief || card.description,
    state: running && card.state === "needs" ? "needs" : s.state,
    stopped: s.stopped,
    quiet: s.quiet,
    error: running ? card.error : s.state === "failed" ? (card.state === "failed" && !card.stopped && card.error) || laneError(l) : null,
    startedAt: l.started,
    durationMs: laneDuration(l),
    active: running ? card.active : -1,
    lastAt: l.ended ?? Math.max(card.lastAt, l.started),
    ...(card.handoff ? {} : { handoff: l.brief || null, handoffFull: l.brief || null }),
  };
}

/** A shell helper whose own session was not found (e.g. `claude -p --no-session-persistence`): from the lead's record only. */
export function cardFromLane(parentCwd: string, l: LaneInfo): AgentCardData {
  const base: AgentCardData = {
    id: `lane:${l.tool}:${l.index}`,
    source: "chat",
    ref: l.tool,
    provider: l.provider,
    model: l.model,
    kind: "",
    description: "",
    state: "running",
    tokens: 0,
    label: "Working",
    labelTool: null,
    since: l.started,
    startedAt: l.started,
    steps: [],
    active: -1,
    durationMs: null,
    result: null,
    error: null,
    stopped: false,
    lastAt: l.started,
    stoppable: false,
    fill: null,
    handoff: null,
    handoffFull: null,
  };
  return withLane(base, l, null, parentCwd);
}
