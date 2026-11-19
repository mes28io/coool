// The Needs you page's reading of a request (components/needs/): what kind of thing the agent asks for, and the
// context that explains why (the person's prompt, what the agent said or thought just before, the steps that led
// there, the subagent asking). Pure: unit-tested in needs.test.ts.

import type { ChatItem } from "./chat";
import type { Activity, Session } from "./types";

type Tool = Extract<ChatItem, { kind: "tool" }>;

/** What a request is, in the page's terms (picks the icon, the payload view and the words). */
export type NeedKind = "command" | "edit" | "write" | "fetch" | "device" | "plan" | "tool" | "question" | "terminal" | "job" | "insight";

/** The kind of a permission request, from its tool and input. */
export function permKind(tool: string, input: unknown): NeedKind {
  const i = (input ?? {}) as Record<string, unknown>;
  if (i.coool_device && typeof i.coool_device === "object") return "device";
  if (tool === "ExitPlanMode") return "plan";
  if (/^(edit|multiedit)$/i.test(tool)) return "edit";
  if (/^(write|notebookedit)$/i.test(tool) || (typeof i.file_path === "string" && typeof i.content === "string")) return "write";
  if (typeof i.command === "string" || /^(bash|shell|exec|exec_command|local_shell)$/i.test(tool)) return "command";
  if (typeof i.url === "string") return "fetch";
  return "tool";
}

/** One step that led to the request: a chat's tool call, or a transcript activity row. */
export type NeedStep = { kind: "tool"; tool: Tool } | { kind: "activity"; a: Activity };

export interface NeedContext {
  /** The person's last prompt before it asked. */
  prompt: string | null;
  /** The agent's last words before it asked (its reply text). */
  said: string | null;
  /** Its last reasoning, when the CLI shows it. */
  thought: string | null;
  /** The last few steps, oldest first. */
  steps: NeedStep[];
  /** Asked from inside a subagent: its type and task. */
  agent: { kind: string; description: string } | null;
}

const STEPS = 6;
const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * The context of a request asked at `at` in a coool chat. `tool` is the requested tool's name: its own open call
 * (the CLI shows the call before it asks) is left out of the steps and tells which subagent asks, if any.
 */
export function chatContext(items: ChatItem[], at: number, tool?: string | null): NeedContext {
  let end = items.length;
  while (end > 0 && items[end - 1].ts > at) end--;
  let start = 0;
  for (let i = end - 1; i >= 0; i--)
    if (items[i].kind === "prompt") {
      start = i;
      break;
    }
  const prompt = items[start]?.kind === "prompt" ? (items[start] as Extract<ChatItem, { kind: "prompt" }>).text : null;
  // The request's own call: the newest open call of that tool.
  let own: Tool | null = null;
  if (tool)
    for (let i = end - 1; i >= start; i--) {
      const it = items[i];
      if (it.kind === "tool" && it.name === tool && it.endTs === null) {
        own = it;
        break;
      }
    }
  // Asked under another name (coool's device gate asks as "Browser" for a `browser_navigate` call): the call still
  // open when it asked is the one it waits on.
  if (!own && tool)
    for (let i = end - 1; i >= start; i--) {
      const it = items[i];
      if (it.kind === "tool" && it.endTs === null && !it.agent) {
        own = it;
        break;
      }
    }
  const parent = own?.parent ?? null;
  let said: string | null = null;
  let thought: string | null = null;
  const steps: Tool[] = [];
  const from = prompt !== null ? start + 1 : 0;
  for (let i = end - 1; i >= from; i--) {
    const it = items[i];
    // Inside a subagent: what that subagent said and did; otherwise the main thread.
    const mine = "parent" in it ? (it.parent ?? null) === parent : true;
    if (!mine) continue;
    if (it.kind === "text" && said === null && it.text.trim()) said = it.text.trim();
    else if (it.kind === "thinking" && thought === null && it.text.trim()) thought = it.text.trim();
    else if (it.kind === "tool" && it !== own && steps.length < STEPS) steps.push(it);
  }
  let agent: NeedContext["agent"] = null;
  if (parent) {
    const a = items.find((x) => x.kind === "tool" && x.id === parent) as Tool | undefined;
    const input = (a?.input ?? {}) as Record<string, unknown>;
    agent = { kind: str(input.subagent_type) || a?.name || "Agent", description: str(input.description) || a?.summary || "" };
  }
  return { prompt, said, thought, steps: steps.reverse().map((t) => ({ kind: "tool", tool: t })), agent };
}

/** The context a transcript gives for a session coool does not drive: its last prompt, last reply and last steps. */
export function sessionContext(s: Pick<Session, "activity" | "last_prompt">): NeedContext {
  const rows = s.activity;
  let start = -1;
  for (let i = rows.length - 1; i >= 0; i--)
    if (rows[i].kind === "prompt") {
      start = i;
      break;
    }
  const after = rows.slice(start + 1);
  const said = [...after].reverse().find((a) => a.kind === "text");
  const steps = after.filter((a) => a.kind === "tool").slice(-STEPS);
  const prompt = start >= 0 ? (rows[start].full ?? rows[start].text) : s.last_prompt;
  return { prompt: prompt || null, said: said ? (said.full ?? said.text) : null, thought: null, steps: steps.map((a) => ({ kind: "activity", a })), agent: null };
}

/**
 * Which item to select once the list changes: the same one while it is there; when it left (answered), the one that
 * took its place (the next, or the last when it was at the end); null when the list is empty.
 */
export function nextPick(keys: string[], before: string[], picked: string | null): string | null {
  if (!keys.length) return null;
  if (picked && keys.includes(picked)) return picked;
  const at = picked ? before.indexOf(picked) : -1;
  if (at < 0) return keys[0];
  // The first item after it that is still listed, else the nearest before it.
  for (let i = at + 1; i < before.length; i++) if (keys.includes(before[i])) return before[i];
  for (let i = at - 1; i >= 0; i--) if (keys.includes(before[i])) return before[i];
  return keys[Math.min(at, keys.length - 1)];
}

/** "rm -rf build" from "Waiting for you: permission to run `rm -rf build`": the command a terminal prompt names, if any. */
export function waitedCommand(text: string | null | undefined): string | null {
  const m = /`([^`]+)`/.exec(text ?? "");
  return m ? m[1] : null;
}
