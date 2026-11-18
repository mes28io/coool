// Where a turn's time went (CHAT_SPEC "Where the turn went"): the turn's wall-clock split by kind of
// step, and one row per tool call on a shared 0 -> turn-length axis. Coool chats only: transcript
// sessions have no end times, so nothing is guessed for them.
//
// Timing: when the model issues several calls in one message they all arrive at once, and the CLI runs
// them one after the other (only consecutive read-only built-ins run side by side). A later call's
// `endTs - ts` then includes the time it queued behind the earlier ones. Each call's start is moved to
// when the call before it in the same thread finished (see `correctStarts`).
//
// Pure: unit-tested by turnBreakdown.test.ts.

import type { ChatItem } from "./chat";
import { parseMcp, rowText, toolRow } from "./toolNames.ts";

export type TurnKind = "thinking" | "reading" | "editing" | "commands" | "web" | "agents" | "other" | "waiting" | "writing";

/** Bar order, left to right. */
export const KIND_ORDER: TurnKind[] = ["thinking", "reading", "editing", "commands", "web", "agents", "other", "waiting", "writing"];
export const KIND_LABEL: Record<TurnKind, string> = {
  thinking: "Thinking",
  reading: "Reading",
  editing: "Editing",
  commands: "Commands",
  web: "Web and devices",
  agents: "Sub-agents",
  other: "Other tools",
  waiting: "Waiting for you",
  writing: "Writing",
};

type Tool = Extract<ChatItem, { kind: "tool" }>;

const READ = /^(read|grep|glob|ls|notebookread|toolsearch|view_image|read_file|view_file|list_dir|search|find|rg)$/i;
const EDIT = /^(edit|multiedit|write|notebookedit|apply_patch|str_replace_based_edit_tool)$/i;
const SHELL = /^(bash|bashoutput|killshell|killbash|shell|exec_command|write_stdin|local_shell|unified_exec|monitor)$/i;
const WEB = /^(webfetch|websearch|web_search|web_fetch|fetch)$/i;
const AGENT = /^(task|agent|subagent|spawn_agent|wait_agent|send_message|followup_task)$/i;

export function toolKind(name: string): TurnKind {
  const mcp = parseMcp(name);
  if (mcp) return /^coool[-_]device$/i.test(mcp.server) || /browser|chrome|computer|simulator|playwright|puppeteer/i.test(mcp.server) ? "web" : "other";
  if (AGENT.test(name)) return "agents";
  // A question or a plan for the person: its whole span is theirs to answer.
  if (/^(AskUserQuestion|request_user_input|request_user_input_async|ExitPlanMode)$/.test(name)) return "waiting";
  if (READ.test(name)) return "reading";
  if (EDIT.test(name)) return "editing";
  if (SHELL.test(name)) return "commands";
  if (WEB.test(name)) return "web";
  return "other";
}

/** Read-only built-ins and subagents: the CLI runs a run of these side by side, so they never queue. */
const PARALLEL = (name: string) => READ.test(name) || WEB.test(name) || AGENT.test(name);

export interface CallTime {
  start: number;
  end: number;
}

/**
 * Corrected start per call, by id. Calls are grouped by thread (the main thread, or the subagent that made
 * them) and taken in the order they arrived: a call can't start before the previous call of its thread
 * finished, except within a run of side-by-side calls (read-only built-ins, subagents), which all start at
 * the gate the run began with.
 */
export function correctStarts(tools: Tool[], now: number): Map<string, CallTime> {
  const out = new Map<string, CallTime>();
  const lanes = new Map<string, Tool[]>();
  for (const t of tools) {
    const k = t.parent ?? "";
    const l = lanes.get(k) ?? [];
    l.push(t);
    lanes.set(k, l);
  }
  for (const lane of lanes.values()) {
    const sorted = [...lane].sort((a, b) => a.ts - b.ts);
    let gate = -Infinity;
    let run: { gate: number; max: number } | null = null;
    for (const t of sorted) {
      const end = t.endTs ?? now;
      let start: number;
      if (PARALLEL(t.name)) {
        if (!run) run = { gate, max: gate };
        start = Math.max(t.ts, run.gate);
        run.max = Math.max(run.max, end);
      } else {
        if (run) {
          gate = Math.max(gate, run.max);
          run = null;
        }
        start = Math.max(t.ts, gate);
        gate = Math.max(gate, end);
      }
      out.set(t.id, { start: Math.min(start, end), end });
    }
  }
  return out;
}

export interface WaterRow {
  key: string;
  id: string;
  name: string;
  /** The readable row text (lib/toolNames.ts). */
  label: string;
  kind: TurnKind;
  /** Offsets from the turn start, ms. */
  from: number;
  to: number;
  /** Its own time: the span minus any wait for the person inside it. */
  ms: number;
  running: boolean;
  failed: boolean;
  /** A subagent's own calls (folded under it). */
  children: WaterRow[];
}

export interface Segment {
  kind: TurnKind;
  ms: number;
  calls: number;
  slowest: { label: string; ms: number } | null;
}

export interface Breakdown {
  start: number;
  end: number;
  total: number;
  /** In KIND_ORDER, only kinds with time; their ms sum to `total`. */
  segments: Segment[];
  /** Top-level calls in order; subagents carry their calls as children. */
  rows: WaterRow[];
  /** The slowest call of the turn (any depth, not a subagent itself). */
  slowest: string | null;
  running: boolean;
}

/** The items of the turn ending at `turnIdx` (a `turn` item), or of the turn now running when it is -1. */
export function turnItems(items: ChatItem[], turnIdx: number): ChatItem[] {
  const end = turnIdx < 0 ? items.length : turnIdx;
  let from = 0;
  for (let i = end - 1; i >= 0; i--)
    if (items[i].kind === "turn") {
      from = i + 1;
      break;
    }
  return items.slice(from, end);
}

const PRIORITY: TurnKind[] = ["waiting", "agents", "commands", "editing", "web", "reading", "other", "thinking"];

/**
 * The breakdown of one turn. `items` are the turn's items (`turnItems`), `start`/`end` its wall-clock span
 * (epoch ms). Every instant is given to one kind: waiting for the person first, then a running subagent,
 * then the main thread's tool by kind, then thinking; whatever is left the model spent writing.
 */
export function breakdown(items: ChatItem[], start: number, end: number, running = false): Breakdown {
  const total = Math.max(0, end - start);
  const tools = items.filter((i): i is Tool => i.kind === "tool" && !isPlanNoise(i.name));
  const times = correctStarts(tools, end);
  const clampT = (t: number) => Math.min(end, Math.max(start, t));

  type Span = { from: number; to: number; kind: TurnKind };
  const spans: Span[] = [];
  const waits: Span[] = [];
  for (const it of items) {
    if ((it.kind === "permission" || it.kind === "question") && it.ts <= end) waits.push({ from: clampT(it.ts), to: clampT(it.answeredTs ?? end), kind: "waiting" });
    if (it.kind === "thinking" && !it.parent) spans.push({ from: clampT(it.ts), to: clampT(it.endTs ?? end), kind: "thinking" });
  }
  spans.push(...waits);
  for (const t of tools) {
    if (t.parent) continue;
    const c = times.get(t.id)!;
    spans.push({ from: clampT(c.start), to: clampT(c.end), kind: t.agent ? "agents" : toolKind(t.name) });
  }

  // Sweep: each elementary interval goes to the highest-priority kind active in it.
  const cuts = [...new Set([start, end, ...spans.flatMap((s) => [s.from, s.to])])].sort((a, b) => a - b);
  const ms = new Map<TurnKind, number>();
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a = cuts[k];
    const b = cuts[k + 1];
    if (b <= a) continue;
    let best: TurnKind = "writing";
    let rank = PRIORITY.length;
    for (const s of spans) {
      if (s.from <= a && s.to >= b && s.to > s.from) {
        const r = PRIORITY.indexOf(s.kind);
        if (r < rank) {
          rank = r;
          best = s.kind;
        }
      }
    }
    ms.set(best, (ms.get(best) ?? 0) + (b - a));
  }

  const waitIn = (from: number, to: number) => waits.reduce((n, w) => n + Math.max(0, Math.min(to, w.to) - Math.max(from, w.from)), 0);
  const row = (t: Tool, kids: Tool[]): WaterRow => {
    const c = times.get(t.id)!;
    const from = clampT(c.start) - start;
    const to = clampT(c.end) - start;
    const tr = toolRow({ name: t.name, input: t.input, output: t.output, summary: t.summary, ok: t.ok, running: t.endTs === null });
    return {
      key: t.key,
      id: t.id,
      name: t.name,
      // A subagent reads as its task ("Catalogue the agent components"), not "Task Catalogue…".
      label: t.agent ? tr.detail || "Sub-agent" : rowText(tr),
      kind: t.agent ? "agents" : toolKind(t.name),
      from,
      to,
      ms: Math.max(0, to - from - waitIn(from + start, to + start)),
      running: t.endTs === null,
      // A wait that timed out is neutral (lib/toolNames.ts `soft`).
      failed: t.ok === false && !t.stopped && !tr.soft,
      children: kids.map((k) => row(k, [])),
    };
  };
  const byParent = new Map<string, Tool[]>();
  for (const t of tools) if (t.parent) byParent.set(t.parent, [...(byParent.get(t.parent) ?? []), t]);
  const rows = tools.filter((t) => !t.parent).map((t) => row(t, byParent.get(t.id) ?? []));

  const all = rows.flatMap((r) => [r, ...r.children]);
  const segments: Segment[] = [];
  for (const kind of KIND_ORDER) {
    const v = ms.get(kind) ?? 0;
    if (v <= 0) continue;
    const mine = kind === "waiting" || kind === "thinking" || kind === "writing" ? [] : rows.filter((r) => r.kind === kind);
    const slow = mine.reduce<WaterRow | null>((m, r) => (!m || r.ms > m.ms ? r : m), null);
    segments.push({
      kind,
      ms: v,
      calls: kind === "waiting" ? waits.length : mine.length,
      slowest: slow ? { label: slow.label, ms: slow.ms } : null,
    });
  }
  const leaf = all.filter((r) => r.kind !== "agents" && r.kind !== "waiting");
  const slowestRow = leaf.reduce<WaterRow | null>((m, r) => (!m || r.ms > m.ms ? r : m), null);
  return { start, end, total, segments, rows, slowest: leaf.length > 1 && slowestRow && slowestRow.ms > 0 ? slowestRow.key : null, running };
}

/** Task-list bookkeeping is shown as its own card and takes no time worth a row. */
const isPlanNoise = (name: string) => /^(TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|update_plan)$/.test(name);

/** "Commands · 2m 41s · 7 calls · slowest `pnpm test` 1m 58s" */
export function segmentText(s: Segment, fmt: (ms: number) => string): string {
  const parts = [KIND_LABEL[s.kind], fmt(s.ms)];
  if (s.calls > 0) parts.push(s.kind === "waiting" ? `${s.calls} ${s.calls === 1 ? "request" : "requests"}` : `${s.calls} ${s.calls === 1 ? "call" : "calls"}`);
  if (s.slowest && s.calls > 1) parts.push(`slowest ${s.slowest.label} ${fmt(s.slowest.ms)}`);
  return parts.join(" · ");
}
