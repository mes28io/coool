// Checkpoints: one per turn of a chat (a user prompt up to the turn's end), derived
// from the chat items the timeline already has. Nothing here is stored.

import { type Chat, type ChatItem, isAgentTool } from "./chat";
import { shortTitle } from "./format";

type Tool = Extract<ChatItem, { kind: "tool" }>;

export interface Checkpoint {
  /** The prompt item's key: stable, and what the timeline block is keyed by. */
  key: string;
  label: string;
  /** Name of the most significant tool used (for its icon), null when none. */
  tool: string | null;
  /** Distinct files written or edited in the turn. */
  files: number;
  startTs: number;
  /** null while the turn is in progress. */
  endTs: number | null;
  /** Epoch ms of the chat's first prompt. */
  originTs: number;
  failed: boolean;
  live: boolean;
  /** 1 for the first run; +1 after each failed checkpoint that a later prompt followed. */
  attempt: number;
  /** Branch depth (rail column), capped at 2. */
  depth: number;
  /** A failed checkpoint that a later prompt followed: the abandoned end of its branch. */
  stub: boolean;
  /** First checkpoint of a retry branch. */
  branchStart: boolean;
}

export interface Checkpoints {
  list: Checkpoint[];
  attempts: number;
}

const WRITE = /(edit|write|notebook|apply_patch|patch)/i;
const SHELL = /(bash|shell|exec|command)/i;
const LOOK = /(read|view|grep|glob|search|find|rg)/i;

/** Higher wins: edit/write > shell > search/read > agent > anything else. */
function rank(t: Tool): number {
  if (t.agent || isAgentTool(t.name)) return 2;
  if (WRITE.test(t.name)) return 5;
  if (SHELL.test(t.name)) return 4;
  if (LOOK.test(t.name)) return 3;
  return 1;
}

/** Files a write/edit tool touched: Claude's file_path / notebook_path, or Codex patch paths. */
function filesOf(t: Tool): string[] {
  if (!WRITE.test(t.name) || t.ok === false) return [];
  const i = (t.input ?? {}) as Record<string, unknown>;
  const one = [i.file_path, i.notebook_path, i.path].find((v) => typeof v === "string") as string | undefined;
  if (one) return [one];
  const out: string[] = [];
  if (Array.isArray(i.changes)) {
    for (const c of i.changes as { path?: unknown }[]) if (typeof c?.path === "string") out.push(c.path);
  } else if (i.changes && typeof i.changes === "object") out.push(...Object.keys(i.changes as object));
  const patch = [i.input, i.patch, i.diff, t.input].find((v) => typeof v === "string") as string | undefined;
  if (patch) for (const m of patch.matchAll(/\*\*\* (?:Add|Update|Delete) File: (.+)/g)) out.push(m[1].trim());
  return out;
}

export function deriveCheckpoints(chat: Chat): Checkpoints {
  const list: Checkpoint[] = [];
  const items = chat.items;
  let origin = 0;
  let cur: { p: Extract<ChatItem, { kind: "prompt" }>; tools: Tool[]; last: number } | null = null;

  const close = (end: number | null, okFlag: boolean | null) => {
    if (!cur) return;
    const tools = cur.tools;
    let tool: Tool | null = null;
    for (const t of tools) if (!tool || rank(t) > rank(tool)) tool = t;
    const lastTool = tools[tools.length - 1];
    // A denied permission is the person's choice, not a failure.
    const stepFailed = !!lastTool && lastTool.ok === false && !/denied/i.test(lastTool.output);
    const files = new Set<string>();
    for (const t of tools) for (const f of filesOf(t)) files.add(f);
    list.push({
      key: cur.p.key,
      label: shortTitle(cur.p.text, 48) || "Untitled turn",
      tool: tool ? (tool.agent ? "Agent" : tool.name) : null,
      files: files.size,
      startTs: cur.p.ts,
      endTs: end,
      originTs: origin,
      failed: okFlag === false || stepFailed,
      live: end === null,
      attempt: 1,
      depth: 0,
      stub: false,
      branchStart: false,
    });
    cur = null;
  };

  for (const it of items) {
    if ("parent" in it && it.parent) continue;
    if (it.kind === "prompt") {
      if (cur) close(cur.last, null);
      if (!origin) origin = it.ts;
      cur = { p: it, tools: [], last: it.ts };
      continue;
    }
    if (!cur) continue;
    if (it.kind === "tool") {
      cur.tools.push(it);
      cur.last = Math.max(cur.last, it.endTs ?? it.ts);
    } else if (it.kind === "turn") close(it.ts, it.ok);
    else if (it.kind === "exited") close(it.ts, it.code === null || it.code === 0 ? null : false);
    else cur.last = Math.max(cur.last, it.ts);
  }
  if (cur) {
    const c = cur as { last: number };
    if (chat.running && chat.state !== "idle") close(null, null);
    else close(c.last, null);
  }

  let attempts = 1;
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    if (prev.failed) {
      prev.stub = true;
      list[i].attempt = prev.attempt + 1;
      list[i].branchStart = true;
    } else list[i].attempt = prev.attempt;
    list[i].depth = Math.min(list[i].attempt - 1, 2);
    attempts = Math.max(attempts, list[i].attempt);
  }
  return { list, attempts };
}
