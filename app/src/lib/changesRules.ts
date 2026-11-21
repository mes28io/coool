// The Changes view's data (crates/core/src/changes, `changes_load`) and its pure rules: the split view's rows, the
// word pairs inside changed runs, the unchanged gaps between hunks, picking a turn, the agent's commit message, the
// notes to the agent. No imports, so node can test it (changesRules.test.ts).

export interface DiffLine {
  /** " " context, "-" removed, "+" added. */
  k: " " | "-" | "+";
  t: string;
  o?: number;
  n?: number;
  noeol?: boolean;
  crlf?: boolean;
}

export interface HunkView {
  id: string;
  old_start: number;
  old_count: number;
  new_start: number;
  new_count: number;
  added: number;
  removed: number;
  lines: DiffLine[];
  kept: boolean;
  since: boolean;
  blocked?: string;
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "undone" | "unchanged";

export interface FileChange {
  path: string;
  rel: string;
  from_rel?: string;
  status: FileStatus;
  added: number;
  removed: number;
  binary: boolean;
  large?: string;
  diverged: boolean;
  unknown_base: boolean;
  agents: string[];
  turns: number[];
  edits: number;
  kept: boolean;
  staged: boolean;
  busy: boolean;
  undone_at?: number;
  reedited: boolean;
  said?: string;
  line: number;
  hunks: HunkView[];
  text?: string;
  blocked?: string;
}

export interface TurnInfo {
  n: number;
  ts: number;
  prompt: string;
  files: number;
  added: number;
  removed: number;
}

export interface GitInfo {
  top: string;
  branch: string | null;
  busy: string | null;
  staged: string[];
}

export interface ChangeSet {
  root: string;
  scope: string;
  git: GitInfo | null;
  turns: TurnInfo[];
  files: FileChange[];
  pending: number;
  total: number;
  external: boolean;
  busy: boolean;
}

export interface Outcome {
  ok: boolean;
  message: string;
  done: string[];
  refused: [string, string][];
  ask?: string;
  commit?: string;
}

/** What the view shows: what isn't kept yet, everything since the chat started, or one turn. */
export type Scope = "pending" | "chat" | `turn:${number}`;

/** One row of the side-by-side view. */
export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Context on both sides; a run of removals beside the run of additions after it, line for line. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.k === " ") {
      out.push({ left: l, right: l });
      i++;
      continue;
    }
    const del: DiffLine[] = [];
    const add: DiffLine[] = [];
    while (i < lines.length && lines[i].k === "-") del.push(lines[i++]);
    while (i < lines.length && lines[i].k === "+") add.push(lines[i++]);
    for (let k = 0; k < Math.max(del.length, add.length); k++) out.push({ left: del[k] ?? null, right: add[k] ?? null });
  }
  return out;
}

/**
 * For word-level highlighting: index of each changed line's partner (the k-th removal of a run with the k-th
 * addition after it), -1 for none. Lines far apart in length aren't paired (a word diff of them is noise).
 */
export function partners(lines: DiffLine[]): number[] {
  const out = lines.map(() => -1);
  let i = 0;
  while (i < lines.length) {
    if (lines[i].k !== "-") {
      i++;
      continue;
    }
    const d0 = i;
    while (i < lines.length && lines[i].k === "-") i++;
    const a0 = i;
    while (i < lines.length && lines[i].k === "+") i++;
    const n = Math.min(a0 - d0, i - a0);
    for (let k = 0; k < n; k++) {
      const a = lines[d0 + k].t;
      const b = lines[a0 + k].t;
      const short = Math.min(a.length, b.length);
      const long = Math.max(a.length, b.length);
      if (long > 2000 || (long > 12 && short < long / 4)) continue;
      out[d0 + k] = a0 + k;
      out[a0 + k] = d0 + k;
    }
  }
  return out;
}

/** Unchanged lines (new side, 1-based, inclusive) before each hunk, and after the last one; null when none. */
export function gaps(hunks: Pick<HunkView, "new_start" | "new_count">[], total: number | null): { before: ([number, number] | null)[]; after: [number, number] | null } {
  const before: ([number, number] | null)[] = [];
  let next = 1;
  for (const h of hunks) {
    const start = h.new_count === 0 ? h.new_start + 1 : h.new_start;
    before.push(start > next ? [next, start - 1] : null);
    next = h.new_count === 0 ? h.new_start + 1 : h.new_start + h.new_count;
  }
  const after: [number, number] | null = total !== null && total >= next ? [next, total] : null;
  return { before, after };
}

/** Lines of a text (without the empty piece a final newline leaves). */
export function textLines(text: string): string[] {
  const l = text.replace(/\r\n/g, "\n").split("\n");
  if (l.length && l[l.length - 1] === "") l.pop();
  return l;
}

/** The turn a timeline turn is: the one whose prompt time is nearest `ts` (within 10 minutes), else by order. */
export function nearestTurn(turns: Pick<TurnInfo, "n" | "ts" | "prompt">[], ts: number, prompt?: string, ordinal?: number): number | null {
  if (!turns.length) return null;
  if (prompt) {
    const p = prompt.replace(/\s+/g, " ").trim().slice(0, 60);
    const byText = turns.filter((t) => t.prompt.replace(/\s+/g, " ").startsWith(p));
    if (byText.length === 1) return byText[0].n;
    if (byText.length > 1) return byText.reduce((a, b) => (Math.abs(b.ts - ts) < Math.abs(a.ts - ts) ? b : a)).n;
  }
  const best = turns.reduce((a, b) => (Math.abs(b.ts - ts) < Math.abs(a.ts - ts) ? b : a));
  if (Math.abs(best.ts - ts) < 600_000) return best.n;
  if (ordinal && ordinal <= turns.length) return turns[ordinal - 1].n;
  return null;
}

/** The commit message in the agent's reply: its first fenced block, else the reply itself (quotes and "Commit message:" taken off). */
export function commitDraft(reply: string): string | null {
  const fence = /```[\w-]*\n([\s\S]*?)```/.exec(reply);
  let m = (fence ? fence[1] : reply).trim();
  m = m.replace(/^(suggested )?commit message:\s*/i, "").replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!m || m.length > 2000) return null;
  return m;
}

export const COMMIT_ASK =
  "Write a git commit message for the changes I have staged (see `git diff --cached`). Reply with only the message in one fenced code block: a subject line under 72 characters, then, if it helps, a blank line and a short body. Don't commit or change any files.";

/** What the agent is told after the person undoes some of its changes. */
export function undoNote(rels: string[], line?: number | null): string {
  const what = rels.length === 1 ? `your change to ${rels[0]}${line ? ` (around line ${line})` : ""}` : `your changes to ${rels.slice(0, 4).join(", ")}${rels.length > 4 ? ` and ${rels.length - 4} more` : ""}`;
  return `Note from coool: I undid ${what}. Please leave ${rels.length === 1 ? "that" : "those"} as ${rels.length === 1 ? "it is" : "they are"} now unless I ask for it again.`;
}

/** What the agent is told when it edits a file again after the person undid its change there. */
export function reeditNote(rels: string[]): string {
  return `Note from coool: I had undone your earlier change to ${rels.join(", ")}, and you've just edited ${rels.length === 1 ? "it" : "them"} again. Check that you aren't redoing what I took out; ask me if you think it's needed.`;
}

/** A file's diff as unified text (Copy diff). */
export function unifiedText(f: Pick<FileChange, "rel" | "from_rel" | "status" | "hunks">): string {
  const a = f.status === "added" ? "/dev/null" : `a/${f.from_rel ?? f.rel}`;
  const b = f.status === "deleted" ? "/dev/null" : `b/${f.rel}`;
  const out = [`--- ${a}`, `+++ ${b}`];
  for (const h of f.hunks) {
    out.push(`@@ -${h.old_count ? h.old_start : h.old_start - 1},${h.old_count} +${h.new_count ? h.new_start : h.new_start - 1},${h.new_count} @@`);
    for (const l of h.lines) {
      out.push(`${l.k}${l.t}`);
      if (l.noeol) out.push("\\ No newline at end of file");
    }
  }
  return out.join("\n") + "\n";
}

/** "src/lib/", "a.ts" */
export function splitPath(rel: string): [string, string] {
  const i = rel.lastIndexOf("/");
  return i < 0 ? ["", rel] : [rel.slice(0, i + 1), rel.slice(i + 1)];
}

/** Totals for a header: files, lines added and removed. */
export function totals(files: Pick<FileChange, "added" | "removed" | "status">[]): { files: number; added: number; removed: number } {
  const shown = files.filter((f) => f.status !== "unchanged" && f.status !== "undone");
  return { files: shown.length, added: shown.reduce((n, f) => n + f.added, 0), removed: shown.reduce((n, f) => n + f.removed, 0) };
}

/** The files a timeline turn's steps wrote or edited (Claude file_path, Codex patch paths), for "4 files changed". */
export function turnFiles(tools: { name: string; ok: boolean | null; input: unknown }[]): string[] {
  const out = new Set<string>();
  for (const t of tools) {
    if (!/^(write|edit|multiedit|apply_patch)$/i.test(t.name) || t.ok === false) continue;
    const i = (t.input ?? {}) as Record<string, unknown>;
    if (typeof i.file_path === "string") out.add(i.file_path);
    if (Array.isArray(i.changes)) for (const c of i.changes as { path?: unknown; move_path?: unknown }[]) if (typeof c?.path === "string") out.add(typeof c.move_path === "string" ? c.move_path : c.path);
    const patch = typeof i.input === "string" ? i.input : typeof t.input === "string" ? t.input : "";
    for (const m of patch.matchAll(/\*\*\* (?:Add|Update|Delete) File: (.+)/g)) out.add(m[1].trim());
  }
  return [...out];
}
