// Chat state, reduced from CHAT_SPEC events. One entry per chat id, kept for
// every chat the backend reports (not only open ones) so the sidebar, tabs and
// Mission control can show "Needs you" without the chat view being mounted.

import { create } from "zustand";
import type { Activity, ChatEvent, ChatInfo, ChatRunState, CommandInfo, ModelOption, ModelUse, Provider, Question, SlashCommand, Tokens } from "./types";

export type PermissionAnswer = "allow" | "always" | "deny" | "answered";
/** Picked labels / typed text per question; "declined"; or "answered" when settled elsewhere. */
export type QuestionAnswer = string[][] | "declined" | "answered";

export type ChatItem =
  | { kind: "prompt"; key: string; id: string; text: string; ts: number }
  | { kind: "text"; key: string; id: string; text: string; ts: number; streaming: boolean; parent: string | null; model: string | null }
  | { kind: "thinking"; key: string; id: string; text: string; ts: number; endTs: number | null; parent: string | null }
  | {
      kind: "tool";
      key: string;
      id: string;
      name: string;
      summary: string;
      input: unknown;
      ts: number;
      endTs: number | null;
      ok: boolean | null;
      output: string;
      parent: string | null;
      agent: boolean;
    }
  | { kind: "permission"; key: string; requestId: string; tool: string; summary: string; input: unknown; ts: number; answer: PermissionAnswer | null; answeredTs: number | null }
  | { kind: "question"; key: string; requestId: string; questions: Question[]; ts: number; answer: QuestionAnswer | null; answeredTs: number | null }
  | { kind: "notice"; key: string; level: "info" | "warn" | "error"; text: string; needsTerminal: boolean; ts: number }
  | { kind: "turn"; key: string; ts: number; durationMs: number; ok: boolean }
  | { kind: "exited"; key: string; ts: number; code: number | null };

export interface UsagePoint {
  ts: number;
  model: string | null;
  context: number;
}

export interface AgentUse {
  /** Tool call id that launched the subagent. */
  tool: string;
  models: Record<string, ModelUse>;
}

export interface Chat {
  id: number;
  provider: Provider;
  cwd: string;
  sessionId: string | null;
  model: string | null;
  permissionMode: string | null;
  slashCommands: SlashCommand[];
  /** Rich command list (kind, aliases, hints) when the backend sends one. */
  commands: CommandInfo[];
  modelOptions: ModelOption[];
  agentKinds: string[];
  contextWindow: number | null;
  ready: boolean;
  state: ChatRunState;
  running: boolean;
  exitCode: number | null;
  items: ChatItem[];
  seq: number;
  /** Epoch ms the current turn started (from event timestamps), null when idle. */
  turnStart: number | null;
  /** Epoch ms of the last event of any kind. */
  lastTs: number;
  /** Epoch ms the run state last changed. */
  stateSince: number;
  /** Latest context size of the main conversation. */
  context: number;
  tokens: Tokens;
  /** Main-thread usage by model. */
  models: Record<string, ModelUse>;
  /** Subagent usage by launching tool id. */
  agents: Record<string, AgentUse>;
  usageHistory: UsagePoint[];
  /** Prompts sent, oldest first (for up-arrow recall). */
  prompts: string[];
  pendingPermission: string | null;
  pendingQuestion: string | null;
  /** Parent of the most recent assistant output, to attribute the next `usage`. */
  lastParent: string | null;
  replayed: boolean;
}

const AGENT_TOOLS = /^(task|agent|subagent|spawn_agent)$/i;
export const isAgentTool = (name: string) => AGENT_TOOLS.test(name);

export function emptyChat(id: number, info?: Partial<ChatInfo>): Chat {
  return {
    id,
    provider: info?.provider ?? "claude",
    cwd: info?.cwd ?? "",
    sessionId: info?.session_id ?? null,
    model: info?.model ?? null,
    permissionMode: info?.permission_mode ?? null,
    slashCommands: [],
    commands: [],
    modelOptions: [],
    agentKinds: [],
    contextWindow: null,
    ready: false,
    state: info?.state ?? "idle",
    running: info?.running ?? true,
    exitCode: null,
    items: [],
    seq: 0,
    turnStart: null,
    lastTs: Date.now(),
    stateSince: Date.now(),
    context: 0,
    tokens: { input: 0, cached: 0, output: 0, context: 0 },
    models: {},
    agents: {},
    usageHistory: [],
    prompts: [],
    pendingPermission: null,
    pendingQuestion: null,
    lastParent: null,
    replayed: false,
  };
}

function bump(rec: Record<string, ModelUse>, model: string, t: Tokens, via?: boolean) {
  const cur = rec[model] ?? { model, input: 0, cached: 0, output: 0, messages: 0, ...(via ? { via_agent: true } : {}) };
  rec[model] = { ...cur, input: cur.input + t.input, cached: cur.cached + t.cached, output: cur.output + t.output, messages: cur.messages + 1 };
}

/** Pure reducer: returns a new Chat (items array copied only when it changes). */
export function applyEvents(c0: Chat, events: ChatEvent[]): Chat {
  let c = c0;
  let items: ChatItem[] | null = null;
  const its = () => (items ??= [...c.items]);
  const findLast = (pred: (i: ChatItem) => boolean) => {
    const a = items ?? c.items;
    for (let i = a.length - 1; i >= 0; i--) if (pred(a[i])) return i;
    return -1;
  };
  const patch = (i: number, p: Partial<ChatItem>) => {
    const a = its();
    a[i] = { ...a[i], ...p } as ChatItem;
  };
  const closeStreams = (parent: string | null, ts: number) => {
    const a = items ?? c.items;
    for (let i = a.length - 1; i >= Math.max(0, a.length - 12); i--) {
      const it = a[i];
      if (it.kind === "thinking" && it.endTs === null && it.parent === parent) patch(i, { endTs: ts });
      if (it.kind === "text" && it.streaming && it.parent === parent) patch(i, { streaming: false });
    }
  };

  for (const e of events) {
    if (e.seq > 0 && e.seq <= c.seq) continue;
    c = { ...c, seq: Math.max(c.seq, e.seq), lastTs: Math.max(c.lastTs, e.ts) };
    const key = `${e.type}:${e.seq}`;
    switch (e.type) {
      case "ready":
        c = {
          ...c,
          ready: true,
          running: true,
          sessionId: e.session_id ?? c.sessionId,
          model: e.model ?? c.model,
          cwd: e.cwd || c.cwd,
          permissionMode: e.permission_mode ?? c.permissionMode,
          slashCommands: e.slash_commands?.length ? e.slash_commands : c.slashCommands,
          modelOptions: e.models?.length ? e.models : c.modelOptions,
          agentKinds: e.agents ?? c.agentKinds,
          contextWindow: e.context_window ?? c.contextWindow,
        };
        break;
      case "user_message":
        its().push({ kind: "prompt", key, id: e.id, text: e.text, ts: e.ts });
        c = { ...c, prompts: c.prompts[c.prompts.length - 1] === e.text ? c.prompts : [...c.prompts, e.text].slice(-200), turnStart: c.turnStart ?? e.ts };
        break;
      case "thinking_delta": {
        const i = findLast((x) => x.kind === "thinking" && x.id === e.message_id && x.parent === e.parent_tool_id);
        if (i >= 0) {
          const it = (items ?? c.items)[i] as Extract<ChatItem, { kind: "thinking" }>;
          patch(i, { text: it.text + e.text });
        } else its().push({ kind: "thinking", key, id: e.message_id, text: e.text, ts: e.ts, endTs: null, parent: e.parent_tool_id });
        c = { ...c, lastParent: e.parent_tool_id };
        break;
      }
      case "text_delta": {
        const ti = findLast((x) => x.kind === "thinking" && x.id === e.message_id && x.endTs === null);
        if (ti >= 0) patch(ti, { endTs: e.ts });
        const i = findLast((x) => x.kind === "text" && x.id === e.message_id && x.parent === e.parent_tool_id);
        if (i >= 0) {
          const it = (items ?? c.items)[i] as Extract<ChatItem, { kind: "text" }>;
          patch(i, { text: it.text + e.text, streaming: true });
        } else its().push({ kind: "text", key, id: e.message_id, text: e.text, ts: e.ts, streaming: true, parent: e.parent_tool_id, model: null });
        c = { ...c, lastParent: e.parent_tool_id };
        break;
      }
      case "assistant_message": {
        const ti = findLast((x) => x.kind === "thinking" && x.id === e.id && x.endTs === null);
        if (ti >= 0) patch(ti, { endTs: e.ts });
        const i = findLast((x) => x.kind === "text" && x.id === e.id);
        if (i >= 0) patch(i, { text: e.text, streaming: false, model: e.model });
        else if (e.text) its().push({ kind: "text", key, id: e.id, text: e.text, ts: e.ts, streaming: false, parent: e.parent_tool_id, model: e.model });
        c = { ...c, lastParent: e.parent_tool_id };
        if (e.parent_tool_id && e.model) {
          const ag = c.agents[e.parent_tool_id] ?? { tool: e.parent_tool_id, models: {} };
          if (!ag.models[e.model]) c = { ...c, agents: { ...c.agents, [e.parent_tool_id]: { ...ag, models: { ...ag.models, [e.model]: { model: e.model, input: 0, cached: 0, output: 0, messages: 0 } } } } };
        }
        break;
      }
      case "tool_start":
        closeStreams(e.parent_tool_id, e.ts);
        c = { ...c, lastParent: e.parent_tool_id };
        its().push({
          kind: "tool",
          key,
          id: e.id,
          name: e.name,
          summary: e.summary,
          input: e.input,
          ts: e.ts,
          endTs: null,
          ok: null,
          output: "",
          parent: e.parent_tool_id,
          agent: isAgentTool(e.name),
        });
        break;
      case "tool_end": {
        const i = findLast((x) => x.kind === "tool" && x.id === e.id);
        if (i >= 0) patch(i, { endTs: e.ts, ok: e.ok, output: e.output });
        break;
      }
      case "commands":
        c = { ...c, commands: e.commands ?? [] };
        break;
      case "question":
        closeStreams(null, e.ts);
        its().push({ kind: "question", key, requestId: e.request_id, questions: e.questions ?? [], ts: e.ts, answer: null, answeredTs: null });
        c = { ...c, pendingQuestion: e.request_id };
        break;
      case "permission_request":
        its().push({ kind: "permission", key, requestId: e.request_id, tool: e.tool, summary: e.summary, input: e.input, ts: e.ts, answer: null, answeredTs: null });
        c = { ...c, pendingPermission: e.request_id };
        break;
      case "usage": {
        // `usage.tokens` is a running total for the whole chat (subagents included);
        // `tokens.context` is the size of the latest request. Per-model shares come
        // from the delta since the previous total, attributed to whoever spoke last.
        const model = e.model ?? c.model ?? "unknown";
        const parent = c.lastParent;
        const prev = c.tokens;
        const d: Tokens = {
          input: Math.max(0, e.tokens.input - prev.input),
          cached: Math.max(0, e.tokens.cached - prev.cached),
          output: Math.max(0, e.tokens.output - prev.output),
          context: e.tokens.context,
        };
        if (parent) {
          const ag = c.agents[parent] ?? { tool: parent, models: {} };
          const models = { ...ag.models };
          bump(models, model, d);
          c = { ...c, agents: { ...c.agents, [parent]: { ...ag, models } } };
        } else {
          const models = { ...c.models };
          bump(models, model, d);
          c = {
            ...c,
            models,
            context: e.tokens.context || c.context,
            contextWindow: e.context_window ?? c.contextWindow,
            usageHistory: e.tokens.context ? [...c.usageHistory, { ts: e.ts, model, context: e.tokens.context }].slice(-120) : c.usageHistory,
          };
        }
        c = {
          ...c,
          tokens: {
            input: Math.max(prev.input, e.tokens.input),
            cached: Math.max(prev.cached, e.tokens.cached),
            output: Math.max(prev.output, e.tokens.output),
            context: parent ? prev.context : e.tokens.context || prev.context,
          },
        };
        break;
      }
      case "state": {
        let pending = c.pendingPermission;
        if (e.state !== "waiting_permission" && pending) {
          // Answered somewhere (this UI, a replay, or the CLI itself).
          const i = findLast((x) => x.kind === "permission" && x.requestId === pending);
          if (i >= 0 && (((items ?? c.items)[i] as Extract<ChatItem, { kind: "permission" }>).answer === null)) patch(i, { answer: "answered", answeredTs: e.ts });
          pending = null;
        }
        let pq = c.pendingQuestion;
        if (e.state !== "waiting_permission" && pq) {
          const i = findLast((x) => x.kind === "question" && x.requestId === pq);
          if (i >= 0 && ((items ?? c.items)[i] as Extract<ChatItem, { kind: "question" }>).answer === null) patch(i, { answer: "answered", answeredTs: e.ts });
          pq = null;
        }
        c = {
          ...c,
          state: e.state,
          pendingPermission: pending,
          pendingQuestion: pq,
          stateSince: c.state === e.state ? c.stateSince : e.ts,
          turnStart: e.state === "idle" ? null : (c.turnStart ?? e.ts),
        };
        break;
      }
      case "turn_end":
        closeStreams(null, e.ts);
        {
          // Anything still marked running belongs to an interrupted or failed turn.
          const a = items ?? c.items;
          for (let i = 0; i < a.length; i++) {
            const it = a[i];
            if (it.kind === "tool" && it.endTs === null) patch(i, { endTs: e.ts, ok: false, output: it.output || "Stopped" });
            if (it.kind === "text" && it.streaming) patch(i, { streaming: false });
            if (it.kind === "thinking" && it.endTs === null) patch(i, { endTs: e.ts });
          }
        }
        its().push({ kind: "turn", key, ts: e.ts, durationMs: e.duration_ms, ok: e.ok });
        c = { ...c, turnStart: null };
        break;
      case "notice":
        its().push({ kind: "notice", key, level: e.level, text: e.text, needsTerminal: e.needs_terminal, ts: e.ts });
        break;
      case "exited": {
        const a = items ?? c.items;
        for (let i = 0; i < a.length; i++) {
          const it = a[i];
          if (it.kind === "tool" && it.endTs === null) patch(i, { endTs: e.ts, ok: false });
          if (it.kind === "text" && it.streaming) patch(i, { streaming: false });
          if (it.kind === "thinking" && it.endTs === null) patch(i, { endTs: e.ts });
          if (it.kind === "permission" && it.answer === null) patch(i, { answer: "answered", answeredTs: e.ts });
          if (it.kind === "question" && it.answer === null) patch(i, { answer: "answered", answeredTs: e.ts });
        }
        its().push({ kind: "exited", key, ts: e.ts, code: e.code });
        c = { ...c, running: false, exitCode: e.code, state: "idle", turnStart: null, pendingPermission: null, pendingQuestion: null, stateSince: e.ts };
        break;
      }
    }
  }
  if (items) {
    const arr: ChatItem[] = items;
    c = { ...c, items: arr.length > 1500 ? arr.slice(arr.length - 1500) : arr };
  }
  return c;
}

// ---------- store ----------

interface ChatStore {
  chats: Record<number, Chat>;
  /** Transcript rows from before a resumed chat started (read-only history). */
  earlier: Record<number, Activity[]>;
  setEarlier(id: number, a: Activity[]): void;
  ensure(info: ChatInfo): void;
  apply(id: number, events: ChatEvent[]): void;
  /**
   * Rebuild a chat from a full replay. Live events that arrived before the
   * replay (seq above the replay's) are kept, so nothing is lost either way.
   */
  replace(id: number, info: ChatInfo | undefined, events: ChatEvent[], seq: number): void;
  markReplayed(id: number): void;
  /** Optimistic local answer so the card responds instantly. */
  answer(id: number, requestId: string, a: PermissionAnswer): void;
  answerQuestion(id: number, requestId: string, a: QuestionAnswer): void;
  /** Local-only row (e.g. "not available yet"), never sent to the backend. */
  local(id: number, item: { level: "info" | "warn" | "error"; text: string; needsTerminal?: boolean }): void;
}

let localSeq = 0;

// A resumed chat's earlier history survives a reload of the UI (chat ids are
// stable for the backend process; a new app launch starts a new storage session).
const EARLIER_KEY = "coool.earlier.";
function loadEarlier(): Record<number, Activity[]> {
  const out: Record<number, Activity[]> = {};
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(EARLIER_KEY)) out[Number(k.slice(EARLIER_KEY.length))] = JSON.parse(sessionStorage.getItem(k) ?? "[]");
    }
  } catch {}
  return out;
}

export const useChats = create<ChatStore>((set) => ({
  chats: {},
  earlier: loadEarlier(),
  setEarlier: (id, a) => {
    try {
      sessionStorage.setItem(EARLIER_KEY + id, JSON.stringify(a));
    } catch {}
    set((s) => ({ earlier: { ...s.earlier, [id]: a } }));
  },
  ensure: (info) =>
    set((s) => {
      const cur = s.chats[info.id];
      if (!cur) return { chats: { ...s.chats, [info.id]: emptyChat(info.id, info) } };
      // Snapshot fields fill gaps only; events stay authoritative.
      const next = {
        ...cur,
        provider: info.provider,
        cwd: cur.cwd || info.cwd,
        sessionId: cur.sessionId ?? info.session_id,
        model: cur.model ?? info.model,
        permissionMode: cur.permissionMode ?? info.permission_mode ?? null,
        running: cur.running && info.running,
      };
      if (next.running === cur.running && next.sessionId === cur.sessionId && next.model === cur.model && next.cwd === cur.cwd && next.permissionMode === cur.permissionMode) return s;
      return { chats: { ...s.chats, [info.id]: next } };
    }),
  apply: (id, events) =>
    set((s) => {
      const cur = s.chats[id] ?? emptyChat(id);
      const next = applyEvents(cur, events);
      return next === cur ? s : { chats: { ...s.chats, [id]: next } };
    }),
  replace: (id, info, events, seq) =>
    set((s) => {
      const cur = s.chats[id];
      const later = cur ? liveTail(cur, seq) : [];
      let next = applyEvents({ ...emptyChat(id, info ?? (cur ? { provider: cur.provider, cwd: cur.cwd, session_id: cur.sessionId, model: cur.model } : undefined)) }, events);
      if (later.length) next = applyEvents(next, later);
      return { chats: { ...s.chats, [id]: { ...next, replayed: true } } };
    }),
  markReplayed: (id) => set((s) => (s.chats[id] ? { chats: { ...s.chats, [id]: { ...s.chats[id], replayed: true } } } : s)),
  answer: (id, requestId, a) =>
    set((s) => {
      const c = s.chats[id];
      if (!c) return s;
      const items = c.items.map((it) => (it.kind === "permission" && it.requestId === requestId ? { ...it, answer: a, answeredTs: Date.now() } : it));
      return { chats: { ...s.chats, [id]: { ...c, items, pendingPermission: c.pendingPermission === requestId ? null : c.pendingPermission } } };
    }),
  answerQuestion: (id, requestId, a) =>
    set((s) => {
      const c = s.chats[id];
      if (!c) return s;
      const items = c.items.map((it) => (it.kind === "question" && it.requestId === requestId ? { ...it, answer: a, answeredTs: Date.now() } : it));
      return { chats: { ...s.chats, [id]: { ...c, items, pendingQuestion: c.pendingQuestion === requestId ? null : c.pendingQuestion } } };
    }),
  local: (id, n) =>
    set((s) => {
      const c = s.chats[id] ?? emptyChat(id);
      const item: ChatItem = { kind: "notice", key: `local:${++localSeq}`, level: n.level, text: n.text, needsTerminal: !!n.needsTerminal, ts: Date.now() };
      return { chats: { ...s.chats, [id]: { ...c, items: [...c.items, item] } } };
    }),
}));

/** Raw events kept per chat (bounded) so a late replay can be merged, see `replace`. */
const tails: Record<number, ChatEvent[]> = {};
export function rememberLive(id: number, events: ChatEvent[]) {
  const t = (tails[id] ??= []);
  t.push(...events);
  if (t.length > 4000) t.splice(0, t.length - 4000);
}
function liveTail(c: Chat, seq: number): ChatEvent[] {
  return (tails[c.id] ?? []).filter((e) => e.seq > seq);
}

// ---------- derived ----------

export function pendingPermission(c: Chat | undefined | null): Extract<ChatItem, { kind: "permission" }> | null {
  if (!c?.pendingPermission) return null;
  for (let i = c.items.length - 1; i >= 0; i--) {
    const it = c.items[i];
    if (it.kind === "permission" && it.requestId === c.pendingPermission) return it.answer === null ? it : null;
  }
  return null;
}

export function pendingQuestion(c: Chat | undefined | null): Extract<ChatItem, { kind: "question" }> | null {
  if (!c?.pendingQuestion) return null;
  for (let i = c.items.length - 1; i >= 0; i--) {
    const it = c.items[i];
    if (it.kind === "question" && it.requestId === c.pendingQuestion) return it.answer === null ? it : null;
  }
  return null;
}

/** Waiting on the person: a permission request or a question. */
export const needsAnswer = (c: Chat | undefined | null) => !!pendingPermission(c) || !!pendingQuestion(c);

/** Why this chat is blocked on the person, or null. */
export function chatNeeds(c: Chat | undefined | null): string | null {
  const q = pendingQuestion(c);
  if (q) return `Answer: ${q.questions[0]?.question ?? "a question"}${q.questions.length > 1 ? ` (+${q.questions.length - 1})` : ""}`;
  const p = pendingPermission(c);
  if (!p) return null;
  const what = p.summary.startsWith(p.tool + " · ") ? p.summary.slice(p.tool.length + 3) : p.summary;
  return `Approve ${p.tool}${what ? `: ${what}` : ""}`;
}

export function chatStatus(c: Chat): "busy" | "idle" | "ended" {
  if (!c.running) return "ended";
  return c.state === "idle" ? "idle" : "busy";
}

/** Title for a chat that has no discovered session yet. */
export function chatTitle(c: Chat): string | null {
  const p = c.items.find((i) => i.kind === "prompt") as Extract<ChatItem, { kind: "prompt" }> | undefined;
  if (!p) return null;
  const one = p.text.split(/\s+/).join(" ");
  return one.length > 60 ? one.slice(0, 59) + "…" : one;
}

export function chatModels(c: Chat): { main: ModelUse[]; agents: { tool: string; label: string; models: ModelUse[] }[] } {
  // Main thread, plus subagent usage rolled up and flagged (same shape as Session.models).
  const sub: Record<string, ModelUse> = {};
  for (const a of Object.values(c.agents))
    for (const u of Object.values(a.models)) {
      const cur = sub[u.model] ?? { model: u.model, input: 0, cached: 0, output: 0, messages: 0, via_agent: true };
      sub[u.model] = { ...cur, input: cur.input + u.input, cached: cur.cached + u.cached, output: cur.output + u.output, messages: cur.messages + u.messages };
    }
  const main = [...Object.values(c.models), ...Object.values(sub).filter((u) => u.input + u.cached + u.output > 0)].sort(
    (a, b) => b.input + b.cached + b.output - (a.input + a.cached + a.output),
  );
  const agents = Object.values(c.agents).map((a) => {
    const t = c.items.find((i) => i.kind === "tool" && i.id === a.tool) as Extract<ChatItem, { kind: "tool" }> | undefined;
    return { tool: a.tool, label: t?.summary || t?.name || "subagent", models: Object.values(a.models) };
  });
  return { main, agents };
}
