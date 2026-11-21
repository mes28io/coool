// The Context panel's data (APP_SPEC "Context panel"): what a chat's agent starts with, from crates/core/src/chatctx
// (the lookup and the allow-list live there; the app only shows and asks). Pure helpers here, so node can test them.

import type { Provider } from "./types";

export type CtxGroup = "instructions" | "memory" | "skills" | "coool" | "mcp";
export type CtxLoad = "start" | "listed" | "on_demand" | "conditional";

export interface CtxItem {
  id: string;
  group: CtxGroup;
  kind: string;
  label: string;
  source: string;
  path: string | null;
  description: string | null;
  tokens: number;
  full_tokens: number;
  load: CtxLoad;
  used: boolean;
  editable: boolean;
  depth: number;
  note: string | null;
  text: string | null;
}

export interface CtxFolder {
  path: string;
  exists: boolean;
  repo_root: string | null;
  branch: string | null;
  worktree_of: string | null;
}

export interface CtxTargets {
  project_instructions: string | null;
  user_instructions: string | null;
  memory_dir: string | null;
  project_skills: string | null;
  user_skills: string | null;
}

export interface CtxOverview {
  provider: Provider | null;
  folder: CtxFolder;
  items: CtxItem[];
  total: number;
  memory_dir: string | null;
  create: CtxTargets;
  started_model: string | null;
  launch_model: string | null;
  effort: string | null;
  notes: string[];
}

export interface CtxStamp {
  len: number;
  hash: string;
  modified_ms: number;
}

export interface CtxFile {
  path: string;
  text: string;
  stamp: CtxStamp;
  eol: "lf" | "crlf";
  editable: boolean;
}

export type CtxSaveReply = { result: "saved"; stamp: CtxStamp } | { result: "changed"; stamp: CtxStamp | null };

export type CtxCreate =
  | { what: "memory"; title: string; description: string; kind?: string | null }
  | { what: "skill"; scope: "project" | "user" | "project-agents" | "user-agents"; name: string; description: string }
  | { what: "instructions"; path: string };

/** Which chat the panel is for (the backend finds its launch record and transcript). */
export interface CtxTarget {
  provider: Provider;
  cwd: string;
  chat: number | null;
  sessionId: string | null;
}

export const GROUPS: { group: CtxGroup; title: string }[] = [
  { group: "instructions", title: "Instructions" },
  { group: "memory", title: "Memory" },
  { group: "skills", title: "Skills" },
  { group: "coool", title: "What coool adds" },
  { group: "mcp", title: "Your MCP servers" },
];

export function grouped(items: CtxItem[]): { group: CtxGroup; title: string; items: CtxItem[]; tokens: number }[] {
  return GROUPS.map((g) => {
    const its = items.filter((i) => i.group === g.group);
    return { ...g, items: its, tokens: its.reduce((n, i) => n + i.tokens, 0) };
  }).filter((g) => g.items.length > 0);
}

/** How an item reaches the model, in a few words (the row's second line ends with it). */
export function loadWord(i: CtxItem): string {
  if (i.group === "skills") return i.used ? "used in this session" : "listed at start";
  switch (i.load) {
    case "start":
      return "loaded at start";
    case "listed":
      return "listed at start";
    case "on_demand":
      return i.kind === "memory" ? "read when needed" : "loaded when used";
    case "conditional":
      return "once the folder is trusted";
  }
}

/** `~/…` for a path under `home`. */
export function tildePath(p: string, home: string | null): string {
  if (home && (p === home || p.startsWith(home + "/"))) return "~" + p.slice(home.length);
  return p;
}

/** A memory file name from a title, as the backend makes it (lowercase, dashes): shown under the field. */
export function fileNameFor(title: string): string {
  const s = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "memory";
}

export const validSkillName = (n: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(n);

/** The text an item's preview shows: a file's, or coool's own text. Frontmatter is kept out of the rendered view. */
export function splitFrontmatter(text: string): { meta: [string, string][]; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: [], body: text };
  const meta: [string, string][] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv && kv[2] && !/^[|>]-?$/.test(kv[2])) meta.push([kv[1], kv[2].replace(/^["']|["']$/g, "")]);
  }
  return { meta, body: text.slice(m[0].length) };
}

/** Line count for the editor's gutter (a trailing newline doesn't open a numbered line). */
export function lineCount(text: string): number {
  if (!text) return 1;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 || 1 : n;
}

/** What a save, a change on disk and the editor's own edits add up to: what the editor should do. */
export function onDiskChange(dirty: boolean, mine: CtxStamp | null, disk: CtxStamp | null): "none" | "reload" | "conflict" | "gone" {
  if (!mine) return "none";
  if (!disk) return "gone";
  if (disk.hash === mine.hash && disk.len === mine.len) return "none";
  return dirty ? "conflict" : "reload";
}

/** What an edit means for the chat that is running, per CLI (verified against Claude Code 2.1.330 and Codex 0.171.0). */
export function whenItApplies(provider: Provider, group: CtxGroup): string {
  if (provider === "codex")
    return group === "skills"
      ? "Codex lists skills when a thread starts; the skill's file itself is read when the agent opens it."
      : "Codex reads AGENTS.md when a thread starts: new chats get this, and this chat once it is reopened.";
  if (group === "skills") return "New chats see the new name and description. A running chat reads a skill's body when it uses it.";
  if (group === "memory") return "MEMORY.md loads when a chat starts; memory files are read when the agent needs them, so a running chat can pick up an edited one.";
  return "Claude Code reads instructions when a chat starts: new chats get this edit, a running one keeps what it started with.";
}
