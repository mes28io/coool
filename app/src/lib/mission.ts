// Mission control's data (APP_SPEC "Mission control"), as pure functions over what the
// backend already sends: the changes agents made (the ledger), the commit an agent is
// making right now, word diffs for a pending edit, and which subagents form one fan-out.
//
// Self-contained on purpose (type imports only), so `node --test` runs mission.test.ts
// without a bundler.

import type { Activity, ArtifactInfo } from "./types";

export type ChangeKind = "edit" | "create" | "delete" | "move" | "commit" | "push" | "merge" | "pr" | "deploy" | "publish" | "pilot" | "migrate" | "request";

/** One row of the ledger: something an agent changed. */
export interface Change {
  /** Stable across payloads (the source session plus the step that made it). */
  id: string;
  /** Session key it came from (`provider:id`). */
  session: string;
  kind: ChangeKind;
  /** "Edited", "Committed", "Pushed"... */
  action: string;
  /** What it touched: a repository-relative path, a commit message, a branch. */
  object: string;
  /** A before -> after pair (the old value is shown struck through). */
  before?: string;
  after?: string;
  /** A second line when there is no before -> after. */
  detail?: string;
  /** Lines added / removed, when the edit's text is known (chats). */
  added?: number;
  removed?: number;
  /** The same file edited again in the same turn: how many times. */
  times: number;
  /** Epoch ms. */
  ts: number;
  /** The chat tool call or timeline row it came from (to open the session there). */
  step: string;
}

const clip = (s: string, n = 48) => {
  const t = s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

/** `~/code/app/src/a.ts` or `/Users/x/code/app/src/a.ts` -> `src/a.ts` inside `root`; else the last two parts. */
export function relPath(p: string, root: string): string {
  const norm = (x: string) => x.replace(/^\/private(?=\/(tmp|var)\/)/, "").replace(/\/+$/, "");
  const a = norm(p);
  const base = norm(root);
  if (base && a.startsWith(base + "/")) return a.slice(base.length + 1);
  // Activity rows shorten the home folder to `~`: match the root's tail after its home part.
  const tail = base.replace(/^\/(Users|home)\/[^/]+/, "~");
  if (tail.startsWith("~") && a.startsWith(tail + "/")) return a.slice(tail.length + 1);
  const parts = a.split("/").filter(Boolean);
  return parts.length <= 2 ? a : parts.slice(-2).join("/");
}

/** Activity `ts` (local HH:MM:SS) -> epoch ms today, or yesterday when that would be in the future. */
export function hmsToMs(ts: string, now = Date.now()): number | null {
  const m = /^(\d\d):(\d\d):(\d\d)$/.exec(ts);
  if (!m) return null;
  const d = new Date(now);
  d.setHours(+m[1], +m[2], +m[3], 0);
  let t = d.getTime();
  if (t > now + 60_000) t -= 86_400_000;
  return t;
}

/** "Edit · ~/a/b.ts" -> { name: "Edit", detail: "~/a/b.ts" }. */
function split(text: string): { name: string; detail: string } {
  const i = text.indexOf(" · ");
  return i < 0 ? { name: text, detail: "" } : { name: text.slice(0, i), detail: text.slice(i + 3) };
}

const FILE_TOOL = /^(write|edit|multiedit|notebookedit|apply_patch|patch|str_replace_based_edit_tool)$/i;
const SHELL_TOOL = /^(bash|shell|exec_command|local_shell|command_execution)$/i;
export const isPilotTool = (name: string) => /coool-device(__|\.)pilot_run$/.test(name);

/** The value after a flag in a command segment: `-m "msg"`, `--title='x'`, `-m msg`. */
function flag(seg: string, names: string[]): string | null {
  for (const n of names) {
    const re = new RegExp(`(?:^|\\s)${n}(?:=|\\s+)(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)'|(\\S+))`);
    const m = re.exec(seg);
    if (m) return (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\"/g, '"');
  }
  return null;
}

/** Plain words of a segment after its command words (no flags). */
function args(seg: string, skip: number): string[] {
  const out: string[] = [];
  const words = seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (let i = skip; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith("-")) {
      // Flags that take a value: skip it too.
      if (/^(-m|-F|-C|-c|--title|--body|-t|-b|--base|--head)$/.test(w)) i++;
      continue;
    }
    out.push(w.replace(/^["']|["']$/g, ""));
  }
  return out;
}

type Effect = Pick<Change, "kind" | "action" | "object" | "before" | "after" | "detail">;

/** What a shell command changed outside the session, or null for commands that only read or build. */
export function sideEffect(cmd: string, branch: string | null = null): Effect | null {
  for (let seg of cmd.split(/&&|\|\||;|\n|\|(?!\|)/)) {
    seg = seg.trim().replace(/^(\w+=\S+\s+)+/, "").replace(/^sudo\s+/, "").replace(/^git\s+-C\s+\S+\s+/, "git ");
    if (!seg) continue;
    if (/^git\s+commit\b/.test(seg)) {
      const msg = flag(seg, ["-m", "--message"]);
      return { kind: "commit", action: "Committed", object: msg ? clip(msg, 72) : "a commit", detail: /--amend\b/.test(seg) ? "Amended the last commit" : undefined };
    }
    if (/^git\s+push\b/.test(seg)) {
      const [remote, ref] = args(seg, 2);
      const to = (ref && ref !== "HEAD" ? ref : branch) ?? "";
      return { kind: "push", action: "Pushed", object: to || remote || "to the remote", before: to ? to : undefined, after: to ? `${remote ?? "origin"}/${to.split(":").pop()}` : undefined, detail: /--force|-f\b/.test(seg) ? "Force push" : undefined };
    }
    if (/^git\s+merge\b/.test(seg) && !/--abort\b/.test(seg)) {
      const [from] = args(seg, 2);
      return { kind: "merge", action: "Merged", object: from ?? "a branch", before: from, after: from && branch ? branch : undefined };
    }
    if (/^git\s+rebase\b/.test(seg) && !/--(abort|continue|skip)\b/.test(seg)) {
      const [onto] = args(seg, 2);
      return { kind: "merge", action: "Rebased", object: branch ?? "the branch", detail: onto ? `onto ${onto}` : undefined };
    }
    if (/^git\s+reset\s+--hard\b/.test(seg)) return { kind: "delete", action: "Reset", object: args(seg, 3)[0] ?? "HEAD", detail: "Discarded uncommitted changes" };
    if (/^gh\s+pr\s+create\b/.test(seg)) {
      const title = flag(seg, ["--title", "-t"]);
      const base = flag(seg, ["--base", "-B"]);
      return { kind: "pr", action: "Opened PR", object: title ? clip(title, 72) : (branch ?? "a pull request"), before: branch ?? undefined, after: branch ? (base ?? "main") : undefined };
    }
    if (/^gh\s+pr\s+merge\b/.test(seg)) return { kind: "merge", action: "Merged PR", object: args(seg, 3)[0] ? `#${args(seg, 3)[0].replace(/^#/, "")}` : "a pull request" };
    if (/^(npm|pnpm|yarn|bun)\s+publish\b/.test(seg)) return { kind: "publish", action: "Published", object: "the package", detail: seg.split(/\s+/)[0] };
    if (/^cargo\s+publish\b/.test(seg)) return { kind: "publish", action: "Published", object: "the crate", detail: "crates.io" };
    const deploy = /^(?:npx\s+)?(vercel|netlify|firebase|wrangler|heroku|fly|flyctl|railway)\b(.*)$/.exec(seg);
    if (deploy && (/\b(deploy|publish|up)\b/.test(deploy[2]) || (deploy[1] === "vercel" && /^(\s+--prod)?\s*$/.test(deploy[2])))) {
      const name = deploy[1] === "flyctl" ? "Fly" : deploy[1][0].toUpperCase() + deploy[1].slice(1);
      return { kind: "deploy", action: "Deployed", object: /--prod\b|production/.test(seg) ? "to production" : "a preview", detail: name };
    }
    if (/^((npm|pnpm|yarn)\s+(run\s+)?(db:)?migrate|(npx\s+)?prisma\s+migrate\s+deploy|alembic\s+upgrade|diesel\s+migration\s+run|supabase\s+db\s+push|rails\s+db:migrate|sqlx\s+migrate\s+run)\b/.test(seg)) return { kind: "migrate", action: "Migrated", object: "the database", detail: clip(seg, 56) };
    if (/^rm\s/.test(seg)) {
      const [first, ...rest] = args(seg, 1);
      return first ? { kind: "delete", action: "Deleted", object: first, detail: rest.length ? `and ${rest.length} more` : undefined } : null;
    }
    if (/^(git\s+)?mv\s/.test(seg)) {
      const a = args(seg, /^git/.test(seg) ? 2 : 1);
      return a.length >= 2 ? { kind: "move", action: "Moved", object: a[0], before: a[0], after: a[a.length - 1] } : null;
    }
    if (/^curl\b.*(-X|--request)\s*=?\s*(POST|PUT|DELETE|PATCH)\b/i.test(seg)) {
      const url = /https?:\/\/[^\s'"]+/.exec(seg)?.[0];
      const method = /(POST|PUT|DELETE|PATCH)/i.exec(seg)![1].toUpperCase();
      return { kind: "request", action: `Sent ${method}`, object: url ? url.replace(/^https?:\/\//, "") : "a request" };
    }
  }
  return null;
}

/** The commit message while `current` (a session's step in progress) is a `git commit`; "" when it has none; null otherwise. */
export function committing(current: string | null | undefined): string | null {
  if (!current) return null;
  const { name, detail } = split(current);
  if (!SHELL_TOOL.test(name)) return null;
  const e = sideEffect(detail);
  return e?.kind === "commit" ? (e.object === "a commit" ? "" : e.object) : null;
}

/** Lines in a text (0 for empty). */
const lines = (s: string) => (s ? s.replace(/\n$/, "").split("\n") : []);

/** Longest-common-subsequence table walk over two token lists; null when too big to be worth it. */
function lcs<T>(a: T[], b: T[], max = 250_000): { op: "same" | "del" | "add"; v: T }[] | null {
  if (a.length * b.length > max) return null;
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { op: "same" | "del" | "add"; v: T }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "same", v: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "del", v: a[i++] });
    else out.push({ op: "add", v: b[j++] });
  }
  while (i < n) out.push({ op: "del", v: a[i++] });
  while (j < m) out.push({ op: "add", v: b[j++] });
  return out;
}

/** Lines an edit adds and removes (a line diff; the whole texts when they are too long to compare). */
export function lineCounts(before: string, after: string): { added: number; removed: number } {
  const a = lines(before);
  const b = lines(after);
  const d = lcs(a, b);
  if (!d) return { added: b.length, removed: a.length };
  return { added: d.filter((x) => x.op === "add").length, removed: d.filter((x) => x.op === "del").length };
}

export interface DiffPart {
  op: "same" | "del" | "add";
  text: string;
}

/**
 * A word-level diff for reading an edit as prose: runs of kept, struck and added text.
 * Tokens are words, runs of spaces and single punctuation marks, so code diffs stay legible.
 * Falls back to "all struck, all added" when the texts are too long to compare.
 */
export function wordDiff(before: string, after: string): DiffPart[] {
  const tok = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) ?? [];
  const d = lcs(tok(before), tok(after), 400_000) ?? [...tok(before).map((v) => ({ op: "del" as const, v })), ...tok(after).map((v) => ({ op: "add" as const, v }))];
  // Runs of changes (with the single spaces between them) become one struck run then one added run:
  // "every 5 seconds" -> "with exponential backoff" reads as one swap, not three.
  const out: DiffPart[] = [];
  let del = "";
  let add = "";
  const flush = () => {
    if (del) out.push({ op: "del", text: del });
    if (add) out.push({ op: "add", text: add });
    del = add = "";
  };
  for (let i = 0; i < d.length; i++) {
    const { op, v } = d[i];
    const between = op === "same" && /^\s+$/.test(v) && (del || add) && d.slice(i + 1).find((x) => !(x.op === "same" && /^\s+$/.test(x.v)))?.op !== "same" && i + 1 < d.length;
    if (op === "del") del += v;
    else if (op === "add") add += v;
    else if (between) {
      del += v;
      add += v;
    } else {
      flush();
      const last = out[out.length - 1];
      if (last?.op === "same") last.text += v;
      else out.push({ op: "same", text: v });
    }
  }
  flush();
  return out;
}

/** Changes in one changed text worth showing as before -> after: both sides one short line. */
function swap(before: string, after: string): { before: string; after: string } | null {
  if (!before || !after || before.includes("\n") || after.includes("\n")) return null;
  const [b, a] = [before.trim(), after.trim()];
  return b && a && b.length <= 60 && a.length <= 60 ? { before: b, after: a } : null;
}

/** Same file, same session, same turn: one row that counts ("Edited ×3"). */
function coalesce(rows: Change[], turnOf: Map<string, string>): Change[] {
  const out: Change[] = [];
  const at = new Map<string, Change>();
  for (const r of rows) {
    const key = r.kind === "edit" ? `${r.session}|${turnOf.get(r.id) ?? ""}|${r.object}` : null;
    const prev = key ? at.get(key) : undefined;
    if (prev) {
      prev.times += 1;
      prev.ts = Math.max(prev.ts, r.ts);
      prev.step = r.step;
      if (prev.added !== undefined || r.added !== undefined) {
        prev.added = (prev.added ?? 0) + (r.added ?? 0);
        prev.removed = (prev.removed ?? 0) + (r.removed ?? 0);
      }
      prev.before = prev.after = undefined;
      continue;
    }
    if (key) at.set(key, r);
    out.push(r);
  }
  return out;
}

/** A publish row from a step that published an artifact. */
function publishRow(a: ArtifactInfo): Effect {
  const v = a.version ?? 1;
  return { kind: "publish", action: "Published", object: a.title || "a page", before: v > 1 ? `v${v - 1}` : undefined, after: v > 1 ? `v${v}` : undefined, detail: v > 1 ? undefined : "New page on claude.ai" };
}

/**
 * The changes in a session's timeline (`Session.activity`): file edits, shell commands with outside
 * effects, published pages and device-pilot runs. The timeline has no tool results, so a failed step
 * shows too unless an error row follows it.
 */
export function changesFromActivity(session: string, activity: Activity[], root: string, branch: string | null = null, now = Date.now()): Change[] {
  const rows: Change[] = [];
  const turnOf = new Map<string, string>();
  let turn = "";
  for (let i = 0; i < activity.length; i++) {
    const a = activity[i];
    if (a.kind === "prompt") {
      turn = `${i}`;
      continue;
    }
    if (a.kind !== "tool") continue;
    // A failed step: the timeline puts its error right after it.
    const next = activity[i + 1];
    if (next?.kind === "error" && next.step) continue;
    const ts = hmsToMs(a.ts, now) ?? now;
    const id = `${session}|${a.ts}|${a.text}`;
    const { name, detail } = split(a.text);
    let e: Effect | null = null;
    if (a.artifact) e = publishRow(a.artifact);
    else if (FILE_TOOL.test(name) && detail) {
      const create = /^write$/i.test(name);
      e = { kind: create ? "create" : "edit", action: create ? "Wrote" : "Edited", object: relPath(detail, root) };
    } else if (SHELL_TOOL.test(name) && detail) e = sideEffect(detail, branch);
    else if (isPilotTool(name)) e = { kind: "pilot", action: "Drove the device", object: clip(detail || "a pilot run", 64) };
    if (!e) continue;
    const row: Change = { id, session, ...e, times: 1, ts, step: `a:${i}` };
    // Ids must be unique even for two identical steps in the same second.
    if (rows.some((r) => r.id === id)) row.id = `${id}#${i}`;
    turnOf.set(row.id, turn);
    rows.push(row);
  }
  return coalesce(rows, turnOf).reverse();
}

/** The parts of a chat tool call this needs (lib/chat.ts ChatItem, kind "tool"). */
export interface ToolLike {
  kind: "tool";
  id: string;
  name: string;
  summary: string;
  input: unknown;
  ts: number;
  endTs: number | null;
  ok: boolean | null;
  output: string;
  parent: string | null;
  artifact?: ArtifactInfo;
}
export type ItemLike = ToolLike | { kind: string; key?: string; ts?: number };

function commandOf(input: Record<string, unknown>): string | null {
  const c = input.command ?? input.cmd;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const last = c[c.length - 1];
    return typeof last === "string" ? last : c.join(" ");
  }
  return null;
}

/** Files a Codex patch touches, with +/- counts from its diff text. */
function patchFiles(input: Record<string, unknown>): { path: string; kind: "edit" | "create" | "delete"; added?: number; removed?: number }[] {
  const out: { path: string; kind: "edit" | "create" | "delete"; added?: number; removed?: number }[] = [];
  const count = (diff: unknown) => {
    if (typeof diff !== "string") return {};
    let added = 0;
    let removed = 0;
    for (const l of diff.split("\n")) {
      if (/^\+(?!\+\+)/.test(l)) added++;
      else if (/^-(?!--)/.test(l)) removed++;
    }
    return { added, removed };
  };
  if (Array.isArray(input.changes)) {
    for (const c of input.changes as { path?: string; kind?: { type?: string } | string; diff?: string }[]) {
      if (typeof c?.path !== "string") continue;
      const k = String(typeof c.kind === "string" ? c.kind : (c.kind?.type ?? "update"));
      out.push({ path: c.path, kind: /add|create/.test(k) ? "create" : /delete/.test(k) ? "delete" : "edit", ...count(c.diff) });
    }
    return out;
  }
  if (input.changes && typeof input.changes === "object") {
    for (const [p, v] of Object.entries(input.changes as Record<string, { type?: string; unified_diff?: string; content?: string }>))
      out.push({ path: p, kind: /add/.test(String(v?.type)) ? "create" : /delete/.test(String(v?.type)) ? "delete" : "edit", ...count(v?.unified_diff) });
    return out;
  }
  const text = [input.input, input.patch, input.diff].find((v) => typeof v === "string") as string | undefined;
  if (text)
    for (const block of text.split(/(?=\*\*\* (?:Add|Update|Delete) File: )/)) {
      const m = /^\*\*\* (Add|Update|Delete) File: (.+)/.exec(block);
      if (m) out.push({ path: m[2].trim(), kind: m[1] === "Add" ? "create" : m[1] === "Delete" ? "delete" : "edit", ...count(block) });
    }
  return out;
}

/** The changes in a coool chat: tool calls that succeeded (subagents' included), with line counts from the edit's own text. */
export function changesFromChat(session: string, items: ItemLike[], root: string, branch: string | null = null): Change[] {
  const rows: Change[] = [];
  const turnOf = new Map<string, string>();
  let turn = "";
  for (const it of items) {
    if (it.kind === "prompt") {
      turn = String((it as { key?: string }).key ?? rows.length);
      continue;
    }
    if (it.kind !== "tool") continue;
    const t = it as ToolLike;
    if (t.ok !== true) continue;
    const input = (t.input ?? {}) as Record<string, unknown>;
    const ts = t.endTs ?? t.ts;
    const base = { session, times: 1, ts, step: `c:${t.id}` };
    const push = (id: string, e: Effect & { added?: number; removed?: number }) => {
      const row: Change = { id: `${session}|${id}`, ...base, ...e };
      turnOf.set(row.id, turn);
      rows.push(row);
    };
    if (t.artifact) push(t.id, publishRow(t.artifact));
    else if (FILE_TOOL.test(t.name)) {
      if (/patch/i.test(t.name)) {
        for (const f of patchFiles(input))
          push(`${t.id}:${f.path}`, { kind: f.kind, action: f.kind === "create" ? "Created" : f.kind === "delete" ? "Deleted" : "Edited", object: relPath(f.path, root), added: f.added, removed: f.removed });
        continue;
      }
      const path = String(input.file_path ?? input.notebook_path ?? input.path ?? "");
      if (!path) continue;
      const object = relPath(path, root);
      if (/^write$/i.test(t.name)) {
        const created = /creat|new file/i.test(t.output);
        const n = typeof input.content === "string" ? lines(input.content).length : undefined;
        push(t.id, { kind: created ? "create" : "edit", action: created ? "Created" : "Wrote", object, added: n, removed: created ? 0 : undefined });
        continue;
      }
      // Edit: old_string/new_string; MultiEdit: edits[]
      const pairs: [string, string][] = Array.isArray(input.edits)
        ? (input.edits as { old_string?: unknown; new_string?: unknown }[]).map((e) => [String(e.old_string ?? ""), String(e.new_string ?? "")])
        : typeof input.old_string === "string" || typeof input.new_string === "string"
          ? [[String(input.old_string ?? ""), String(input.new_string ?? "")]]
          : [];
      const row: Effect & { added?: number; removed?: number } = { kind: "edit", action: "Edited", object };
      if (pairs.length) {
        let added = 0;
        let removed = 0;
        for (const [b, a] of pairs) {
          const c = lineCounts(b, a);
          added += c.added;
          removed += c.removed;
        }
        row.added = added;
        row.removed = removed;
        const sw = pairs.length === 1 ? swap(pairs[0][0], pairs[0][1]) : null;
        if (sw) Object.assign(row, sw);
      }
      push(t.id, row);
    } else if (SHELL_TOOL.test(t.name)) {
      const cmd = commandOf(input) ?? (t.summary || null);
      const e = cmd ? sideEffect(cmd, branch) : null;
      if (e) push(t.id, e);
    } else if (isPilotTool(t.name)) {
      const goal = typeof input.goal === "string" ? input.goal : t.summary;
      const target = typeof input.target === "string" ? input.target : "";
      push(t.id, { kind: "pilot", action: /browser|web/i.test(target) ? "Drove the browser" : /iphone|sim|ios/i.test(target) ? "Drove the iPhone" : "Drove the device", object: clip(goal || "a pilot run", 64) });
    }
  }
  return coalesce(rows, turnOf).reverse();
}

/** Newest first, across sessions; at most `cap`. */
export function mergeChanges(lists: Change[][], cap = 40): Change[] {
  return lists
    .flat()
    .sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id))
    .slice(0, cap);
}

// ---------- fan-out ----------

export type CellState = "running" | "needs" | "failed" | "done" | "stopped";

/** What the fan-out grid needs of an Agents-panel card (lib/agentCards.ts). */
export interface CellLike {
  id: string;
  state: "running" | "needs" | "failed" | "done";
  stopped: boolean;
  startedAt: number | null;
  lastAt: number;
}

export const cellState = (c: CellLike): CellState => (c.state === "failed" && c.stopped ? "stopped" : c.state);

/**
 * The cards that make up the session's current fan-out: those started in its latest turn (at or
 * after `turnStart`; all of them when the turn start is unknown). Shown while any still runs, and
 * for `linger` ms after the last one finished.
 */
export function fanout<T extends CellLike>(cards: T[], turnStart: number | null, now = Date.now(), linger = 90_000): T[] {
  const batch = turnStart === null ? cards : cards.filter((c) => (c.startedAt ?? c.lastAt) >= turnStart - 1000);
  if (batch.length < 2) return [];
  const live = batch.some((c) => c.state === "running" || c.state === "needs");
  const last = Math.max(...batch.map((c) => c.lastAt));
  return live || now - last < linger ? batch : [];
}

/** Count per state, in the legend's order. */
export function cellCounts(states: CellState[]): Record<CellState, number> {
  const out: Record<CellState, number> = { running: 0, needs: 0, failed: 0, stopped: 0, done: 0 };
  for (const s of states) out[s]++;
  return out;
}

/**
 * A fan-out's subagents edit many files at once: past `max` rows of one kind from one session's
 * subagents, they fold into one row ("Edited 18 files", "by 12 agents"), so the ledger stays readable.
 * `agentOf` names the subagent a row came from (null for the session's own rows, which never fold).
 */
export function foldAgentRows(rows: Change[], agentOf: (c: Change) => string | null, max = 3): Change[] {
  const groups = new Map<string, Change[]>();
  for (const r of rows) {
    if (!agentOf(r) || (r.kind !== "edit" && r.kind !== "create")) continue;
    const k = `${r.session}|${r.kind}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const folded = new Map<string, Change>();
  for (const [k, g] of groups) {
    if (g.length <= max) continue;
    const files = new Set(g.map((r) => r.object));
    const agents = new Set(g.map(agentOf));
    const newest = g.reduce((a, b) => (b.ts > a.ts ? b : a));
    const sum = (f: (r: Change) => number | undefined) => (g.some((r) => f(r) !== undefined) ? g.reduce((n, r) => n + (f(r) ?? 0), 0) : undefined);
    folded.set(k, {
      ...newest,
      id: `${k}|fold`,
      action: g[0].kind === "create" ? "Wrote" : "Edited",
      object: `${files.size} files`,
      before: undefined,
      after: undefined,
      detail: `by ${agents.size} ${agents.size === 1 ? "agent" : "agents"}`,
      added: sum((r) => r.added),
      removed: sum((r) => r.removed),
      times: 1,
    });
  }
  const out: Change[] = [];
  const placed = new Set<string>();
  for (const r of rows) {
    const k = `${r.session}|${r.kind}`;
    const f = agentOf(r) ? folded.get(k) : undefined;
    if (!f) out.push(r);
    else if (!placed.has(k)) {
      placed.add(k);
      out.push(f);
    }
  }
  return out;
}
