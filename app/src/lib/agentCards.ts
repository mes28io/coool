// The Agents panel's cards as plain data, from three sources: a session's subagents
// (read-only transcripts: `Session.agents`), a chat's subagent tool calls (chat items
// with a parent tool id) and the child jobs a session started (other sessions).
// The panel component only ever sees `AgentCardData`.

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import type { Chat, ChatItem } from "./chat";
import { displayTitle, homeShort, isThinking, shortDetail, splitTool, stripToolName, thinkingWord, tsToMs } from "./format";
import { attention, useChatDigest, type ChatDigest } from "./live";
import { isStopReason } from "./stopped";
import type { Activity, Agent, Provider, Session } from "./types";
import { sessionKey } from "./types";

export type CardState = "running" | "needs" | "failed" | "done";

export interface CardStep {
  key: string;
  /** Tool name, for the icon. */
  name: string;
  /** One line: "Read uv/unwrap.rs". */
  label: string;
  failed: boolean;
  /** How long it took; null when unknown. */
  ms: number | null;
}

export interface AgentCardData {
  /** Unique within the panel. */
  id: string;
  source: "agent" | "chat" | "job";
  /** agent / tool id (timeline cards) or session key (jobs). */
  ref: string;
  provider: Provider;
  model: string | null;
  kind: string;
  description: string;
  state: CardState;
  /** Output tokens. */
  tokens: number;
  /** The now strip while running. */
  label: string;
  labelTool: string | null;
  /** Epoch ms the current step began; null when unknown. */
  since: number | null;
  /** Epoch ms the agent began (its first step); null when unknown. */
  startedAt: number | null;
  /** Every tool step, oldest first. */
  steps: CardStep[];
  /** Index of the step in progress, or -1. */
  active: number;
  /** First to last entry (done cards). */
  durationMs: number | null;
  /** First line of the last text entry (done cards). */
  result: string | null;
  /** First line of the failure / what the job needs from the person. */
  error: string | null;
  /** A "failed" card the person stopped (interrupted by user): shown neutral, as "Stopped". */
  stopped: boolean;
  /** Recency, epoch ms. */
  lastAt: number;
  /** A job coool itself runs: the Stop action applies. */
  stoppable: boolean;
}

const firstLine = (s: string | null | undefined) => (s ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";
/** "[Request interrupted by user for tool use]" -> "Request interrupted by user for tool use". */
const unbracket = (s: string) => s.replace(/^\[(.*)\]$/, "$1");

/** "Read · ~/a/b/c.rs" -> "Read b/c.rs". */
export function stepLabel(text: string): { name: string; label: string } {
  const { name, detail } = splitTool(text);
  return { name, label: detail ? `${name} ${shortDetail(homeShort(detail))}` : name };
}

/** Steps from a transcript timeline: tool rows are steps, a failed-step error marks the one before it; a step lasts until the next entry. */
function stepsFromActivity(list: Activity[]): CardStep[] {
  const out: CardStep[] = [];
  const seen = new Map<string, number>();
  const at = list.map((a) => tsToMs(a.ts));
  const idx: number[] = [];
  list.forEach((a, i) => {
    if (a.kind === "tool" || a.kind === "agent") {
      const base = `${a.ts}|${a.text.slice(0, 40)}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const { name, label } = stepLabel(a.text);
      const next = at[i + 1];
      out.push({ key: `${base}#${n}`, name, label, failed: false, ms: at[i] !== null && next !== undefined && next !== null ? Math.max(0, next - at[i]!) : null });
      idx.push(i);
    } else if (a.kind === "error" && a.step) {
      // A step the person interrupted did not fail.
      if (isStopReason(a.text)) return;
      const last = out[out.length - 1];
      if (last) last.failed = true;
      else out.push({ key: `${a.ts}|${a.text.slice(0, 40)}#f`, name: "Error", label: firstLine(a.text), failed: true, ms: null });
    }
  });
  return out;
}

function lastOf<T>(a: T[], pred: (t: T) => boolean): T | undefined {
  for (let i = a.length - 1; i >= 0; i--) if (pred(a[i])) return a[i];
  return undefined;
}

function fromTimeline(base: Pick<AgentCardData, "id" | "source" | "ref" | "provider" | "model" | "kind" | "description" | "tokens" | "stoppable">, list: Activity[], o: { current: string | null; live: boolean; needs?: string | null; canFail?: boolean }): AgentCardData {
  const last = list[list.length - 1];
  const failed = o.canFail !== false && !!last && last.kind === "error" && !last.step;
  const steps = stepsFromActivity(list);
  const running = o.live && !failed;
  const lastTool = lastOf(list, (a) => a.kind === "tool" || a.kind === "agent");
  const cur = o.current;
  const text = cur && !isThinking(cur) ? cur : isThinking(cur) || !lastTool ? null : lastTool.text;
  const now = text ? stepLabel(text) : { name: null as string | null, label: thinkingWord(list.length) };
  const lastText = lastOf(list, (a) => a.kind === "text");
  const first = list.length ? tsToMs(list[0].ts) : null;
  const end = last ? tsToMs(last.ts) : null;
  const state: CardState = failed ? "failed" : o.needs ? "needs" : running ? "running" : "done";
  return {
    ...base,
    state,
    label: now.label,
    labelTool: now.name,
    since: end,
    startedAt: first,
    steps,
    active: running && steps.length ? steps.length - 1 : -1,
    durationMs: first !== null && end !== null ? Math.max(0, end - first) : null,
    result: lastText ? firstLine(lastText.full ?? lastText.text) || null : null,
    error: failed ? unbracket(firstLine(last!.full ?? last!.text)) : (o.needs ?? null),
    stopped: failed && isStopReason(last!.full ?? last!.text),
    lastAt: end ?? 0,
  };
}

/** A subagent of a transcript-read session. */
export function cardFromAgent(s: Session, a: Agent): AgentCardData {
  const live = !a.finished && s.status !== "ended";
  return fromTimeline(
    { id: `agent:${a.id}`, source: "agent", ref: a.id, provider: s.provider, model: a.model ?? a.models?.[0]?.model ?? null, kind: a.kind, description: a.description, tokens: a.tokens.output, stoppable: false },
    a.activity,
    { current: a.current, live },
  );
}

/** A child job: another session this one started. */
export function cardFromJob(c: Session, digest: ChatDigest): AgentCardData {
  const att = attention(c, digest);
  const card = fromTimeline(
    { id: `job:${sessionKey(c)}`, source: "job", ref: sessionKey(c), provider: c.provider, model: c.model || null, kind: "job", description: displayTitle(c), tokens: c.tokens.output, stoppable: c.status !== "ended" && (c.managed !== null || c.chat != null) },
    c.activity,
    { current: c.current, live: att.status === "busy", needs: att.needs, canFail: att.status === "ended" },
  );
  if (card.since === null) card.since = c.updated;
  return card;
}

/** A subagent of a chat: a Task tool call and the items nested under it. */
export function cardFromChatTool(chat: Chat, tool: Extract<ChatItem, { kind: "tool" }>, kids: ChatItem[]): AgentCardData {
  const tools = kids.filter((k): k is Extract<ChatItem, { kind: "tool" }> => k.kind === "tool");
  const texts = kids.filter((k): k is Extract<ChatItem, { kind: "text" }> => k.kind === "text");
  const live = tool.endTs === null && chat.running;
  const failed = tool.endTs !== null && tool.ok === false;
  const stopped = failed && (!!tool.stopped || !tool.output.trim() || isStopReason(tool.output));
  const steps: CardStep[] = tools.map((t) => {
    const { name } = splitTool(t.name);
    const detail = shortDetail(homeShort(stripToolName(t.name, t.summary || "")));
    return { key: t.key, name, label: detail ? `${name} ${detail}` : name, failed: t.ok === false && !t.stopped && !(stopped && (t.endTs === null || isStopReason(t.output))), ms: t.endTs !== null ? Math.max(0, t.endTs - t.ts) : null };
  });
  let run = -1;
  tools.forEach((t, i) => {
    if (t.endTs === null) run = i;
  });
  const lastText = texts[texts.length - 1];
  const uses = Object.values(chat.agents[tool.id]?.models ?? {});
  const model = uses[0]?.model ?? ([...texts].reverse().find((t) => t.model)?.model ?? null);
  const lastTool = tools[tools.length - 1];
  const lastEnd = lastTool ? (lastTool.endTs ?? lastTool.ts) : tool.ts;
  const end = tool.endTs ?? lastEnd;
  const state: CardState = failed ? "failed" : live ? "running" : "done";
  const label = run >= 0 ? steps[run].label : thinkingWord(steps.length);
  return {
    id: `chat:${tool.id}`,
    source: "chat",
    ref: tool.id,
    provider: chat.provider,
    model,
    kind: (tool.input as { subagent_type?: string } | null)?.subagent_type || "subagent",
    description: stripToolName(tool.name, tool.summary),
    state,
    tokens: uses.reduce((n, u) => n + u.output, 0),
    label,
    labelTool: run >= 0 ? steps[run].name : null,
    since: live ? (run >= 0 ? tools[run].ts : lastEnd) : end,
    startedAt: tool.ts,
    steps,
    active: live ? run : -1,
    durationMs: tool.endTs !== null ? Math.max(0, tool.endTs - tool.ts) : null,
    result: lastText ? firstLine(lastText.text) || firstLine(tool.output) || null : firstLine(tool.output) || null,
    error: failed ? unbracket(firstLine(tool.output)) || "Stopped" : null,
    stopped,
    lastAt: end,
    stoppable: false,
  };
}

const EMPTY: Session[] = [];

const agentCards = new WeakMap<Agent, { status: Session["status"]; provider: Session["provider"]; card: AgentCardData }>();

export function buildCards(session: Session | null, chat: Chat | undefined, kids: Session[], digest: ChatDigest): AgentCardData[] {
  const out: AgentCardData[] = [];
  const chatAgents = chat ? chat.items.filter((i): i is Extract<ChatItem, { kind: "tool" }> => i.kind === "tool" && i.agent && !i.parent) : [];
  if (chat && chatAgents.length) {
    const nested = new Map<string, ChatItem[]>();
    for (const it of chat.items) {
      const p = "parent" in it ? it.parent : null;
      if (p) nested.set(p, [...(nested.get(p) ?? []), it]);
    }
    for (const t of chatAgents) out.push(cardFromChatTool(chat, t, nested.get(t.id) ?? []));
  } else if (session) {
    for (const a of session.agents) {
      // A subagent the last payload left alone keeps its object (sessionsMerge), and so its card.
      const hit = agentCards.get(a);
      if (hit && hit.status === session.status && hit.provider === session.provider) out.push(hit.card);
      else {
        const card = cardFromAgent(session, a);
        agentCards.set(a, { status: session.status, provider: session.provider, card });
        out.push(card);
      }
    }
  }
  for (const k of kids) out.push(cardFromJob(k, digest));
  return out;
}

export function useAgentCards(session: Session | null, chat: Chat | undefined): AgentCardData[] {
  const kids = useStore(useShallow((st) => (session ? st.sessions.filter((c) => c.nested && c.parent === session.id) : EMPTY)));
  const digest = useChatDigest();
  return useMemo(() => buildCards(session, chat, kids, digest), [session, chat?.items, chat?.running, kids, digest]);
}

/**
 * Needs-you first, then running, then every finished card (done, failed or stopped) most recent first:
 * a failed or stopped agent is history like a done one and must not sit above newer results.
 * Running cards are ordered by when they were started, not by their latest step: with
 * several agents stepping every couple of seconds, "most recently active first" swaps the
 * cards on nearly every tick and nothing can be followed. Flip this to restore recency order.
 */
export const RUNNING_BY_RECENCY = false;

export function orderCards(cards: AgentCardData[]): AgentCardData[] {
  const rank = (c: AgentCardData) => (c.state === "needs" ? 0 : c.state === "running" ? 1 : 2);
  return cards
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const r = rank(a.c) - rank(b.c);
      if (r) return r;
      if (a.c.state === "running" && !RUNNING_BY_RECENCY) return a.i - b.i;
      return b.c.lastAt - a.c.lastAt || b.i - a.i;
    })
    .map((x) => x.c);
}

export const isLive = (c: AgentCardData) => c.state === "running" || c.state === "needs";

/** "3 running · 1 failed · 5 done"; running counts the session's background shells too. */
export function countsText(cards: AgentCardData[], shells = 0): string {
  const n = (f: (c: AgentCardData) => boolean) => cards.filter(f).length;
  const parts = [
    [n(isLive) + shells, "running"],
    [n((c) => c.state === "failed" && !c.stopped), "failed"],
    [n((c) => c.state === "failed" && c.stopped), "stopped"],
    [n((c) => c.state === "done"), "done"],
  ] as const;
  return parts.filter(([k]) => k > 0).map(([k, w]) => `${k} ${w}`).join(" · ");
}

/** 840 -> "840", 12400 -> "12.4k", 124000 -> "124k". */
export function fmtOut(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 100_000) return `${(Math.round(n / 100) / 10).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
