// Plans, derived from the chat item model.
//  - The agent's task list: Claude's `TodoWrite` (input.todos: [{content, status, activeForm}])
//    and Codex's `update_plan` (input.plan: [{step, status}], optional explanation). Each call
//    replaces the list; one card per turn shows the latest state.
//  - Plan approval: Claude's `ExitPlanMode` permission request, whose input.plan is markdown.
// Statuses on the wire are "pending" | "in_progress" | "completed" in both.

import type { PlanPhase, PlanStep, PlanStatus } from "../components/PlanCard";
import type { ChatItem } from "./chat";
import { shortTitle } from "./format.ts";

type Tool = Extract<ChatItem, { kind: "tool" }>;

export const isPlanTool = (name: string) => /^(TodoWrite|update_plan)$/i.test(name);

/** Claude's raw task-list tools: noise next to the card once the driver's synthetic `TodoWrite` carries the list. */
export const isTaskNoise = (name: string) => /^Task(Create|Update|List|Get)$/.test(name);
/** The driver's synthetic `TodoWrite` (built from TaskCreate / TaskUpdate). */
export const isSyntheticPlan = (t: { name: string; input: unknown }) => /^TodoWrite$/i.test(t.name) && !!(t.input as { _synthetic?: unknown } | null)?._synthetic;

const STATUS: Record<string, PlanStatus> = { pending: "pending", in_progress: "active", inprogress: "active", completed: "done", complete: "done", done: "done" };

interface Item {
  text: string;
  active: string | null;
  status: PlanStatus;
}

function itemsOf(t: Tool): Item[] | null {
  const i = (t.input ?? {}) as Record<string, unknown>;
  const list = Array.isArray(i.todos) ? i.todos : Array.isArray(i.plan) ? i.plan : null;
  if (!list) return null;
  const out: Item[] = [];
  for (const x of list as Record<string, unknown>[]) {
    const text = String(x.content ?? x.step ?? "").trim();
    if (!text) continue;
    out.push({ text, active: typeof x.activeForm === "string" && x.activeForm ? x.activeForm : null, status: STATUS[String(x.status ?? "pending").toLowerCase()] ?? "pending" });
  }
  return out;
}

export interface TurnPlan {
  title: string;
  /** Codex's `explanation`, when the latest call has one. */
  subtitle?: string;
  steps: PlanStep[];
  phase: PlanPhase;
  startedAt: number;
  endedAt?: number;
}

/**
 * The card for one turn. `calls` are that turn's TodoWrite/update_plan calls in order;
 * `end` is the turn's end item (null while the turn is in progress); `live`: the chat is
 * still running this turn.
 */
export function planForTurn(calls: Tool[], prompt: string, end: { ts: number; ok: boolean } | null, live: boolean): TurnPlan | null {
  let latest: Item[] | null = null;
  let subtitle: string | undefined;
  // Step -> when it became active, from call timestamps: only steps seen going active get a duration.
  const activeAt = new Map<string, number>();
  const took = new Map<string, number>();
  for (const c of calls) {
    const its = itemsOf(c);
    if (!its) continue;
    latest = its;
    const ex = (c.input as { explanation?: unknown } | null)?.explanation;
    subtitle = typeof ex === "string" && ex.trim() ? ex.trim() : undefined;
    for (const it of its) {
      if (it.status === "active" && !activeAt.has(it.text)) activeAt.set(it.text, c.ts);
      if (it.status === "done" && activeAt.has(it.text) && !took.has(it.text)) took.set(it.text, Math.max(0, c.ts - activeAt.get(it.text)!));
    }
  }
  if (!latest || !latest.length) return null;
  const finished = latest.every((s) => s.status === "done");
  const ended = end !== null || !live;
  const phase: PlanPhase = finished ? "done" : ended ? "stopped" : "running";
  const failedTurn = end !== null && !end.ok;
  const steps: PlanStep[] = latest.map((it) => ({
    title: it.status === "active" && it.active ? it.active : it.text,
    status: it.status === "active" && ended ? (failedTurn ? "failed" : "pending") : it.status,
    durationMs: took.get(it.text),
  }));
  return { title: shortTitle(prompt, 64) || "Plan", subtitle, steps, phase, startedAt: calls[0].ts, endedAt: finished ? (calls[calls.length - 1].endTs ?? calls[calls.length - 1].ts) : end?.ts };
}

// ---------- plan approval (ExitPlanMode) ----------

export interface ProposedPlan {
  title: string;
  steps: PlanStep[];
  /** Paragraphs to show when the markdown has no list. */
  body: string | null;
}

const plain = (s: string) => s.replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();

/** Title = first heading or first line; steps = top-level list items, nested items -> detail. */
export function parsePlan(md: string): ProposedPlan {
  const lines = md.replace(/\r/g, "").split("\n");
  const heading = lines.find((l) => /^#{1,6}\s+\S/.test(l));
  const first = lines.find((l) => l.trim());
  const title = plain(heading ? heading.replace(/^#+\s+/, "") : (first ?? "Plan").replace(/^([-*+]|\d+[.)])\s+/, "")) || "Plan";
  const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const list = lines.map((l) => item.exec(l)).filter((m): m is RegExpExecArray => !!m);
  if (!list.length) return { title, steps: [], body: md.trim() };
  const base = Math.min(...list.map((m) => m[1].length));
  const steps: PlanStep[] = [];
  for (const m of list) {
    if (m[1].length <= base) {
      let text = m[3].trim();
      let detail: string | undefined;
      const bold = /^\*\*([^*]+)\*\*\s*[:–—-]?\s*(.*)$/.exec(text);
      if (bold && bold[2]) [text, detail] = [bold[1], bold[2]];
      steps.push({ title: plain(text), detail: detail ? plain(detail) : undefined, status: "pending" });
    } else if (steps.length) {
      const s = steps[steps.length - 1];
      s.detail = s.detail ? `${s.detail}; ${plain(m[3])}` : plain(m[3]);
    }
  }
  return { title, steps, body: null };
}
