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
  /** A file change made inside an agent's worktree in the project (`.claude/worktrees/<name>/…`): that worktree's name. */
  tree?: string;
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

/**
 * Pulls heredoc bodies out of a command: `<<'EOF' ... EOF` becomes `<<HEREDOC` in the command, and the body
 * is returned. Works on the full multi-line command (chats) and on the timeline's one-line form, where the
 * newlines are collapsed into spaces (`<<'EOF' Subject Body EOF )"`).
 */
export function heredocs(cmd: string): { cmd: string; docs: string[] } {
  const docs: string[] = [];
  let out = cmd;
  const re = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/g;
  for (let guard = 0; guard < 8; guard++) {
    const m = re.exec(out);
    if (!m || m[2] === "HEREDOC") break;
    const rest = out.slice(m.index + m[0].length);
    const tag = m[2];
    // Multi-line: the delimiter alone on a line. One-line: the delimiter as a word.
    const end = new RegExp(`\\n[ \\t]*${tag}[ \\t]*(?=\\n|$|\\))|\\s${tag}(?=\\s|$|\\)|")`).exec(rest);
    docs.push((end ? rest.slice(0, end.index) : rest).trim());
    out = out.slice(0, m.index) + "<<HEREDOC" + (end ? rest.slice(end.index + end[0].length) : "");
    re.lastIndex = m.index + 9;
  }
  return { cmd: out, docs };
}

/** A commit message's subject: its first line, without trailers a collapsed heredoc kept on that line. */
function subjectOf(msg: string): string {
  const first = msg.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return first.replace(/\s+(Co-Authored-By|Signed-off-by|Claude-Session):.*$/i, "").trim();
}

/** The message of a `git commit` segment: `-m`, `--message`, `-am` / `-qam`, `-F -` with a heredoc, or `-m "$(cat <<EOF …)"`. */
function commitMessage(seg: string, docs: string[]): string | null {
  const doc = docs[0] ?? null;
  if (doc !== null && /(?:^|\s)(-[a-zA-Z]*F\s*-|--file(?:=|\s+)-)(?=\s|$)/.test(seg)) return subjectOf(doc) || null;
  if (doc !== null && /<<HEREDOC/.test(seg) && /(?:^|\s)(-[a-zA-Z]*m|--message)[\s=]/.test(seg)) return subjectOf(doc) || null;
  const m = flag(seg, ["-m", "--message", "-[a-zA-Z]+m"]);
  return m ? subjectOf(m) || null : null;
}

/** Folders whose contents are generated (at any depth: app/dist, crates/x/target) or private to tools (.git, .claude at the root): never a change to the project. */
const NOISE_DIR = /^(\.git|\.claude)(\/|$)|(^|\/)(node_modules|target|dist|build|\.next|\.turbo|\.cache|coverage|__pycache__|\.venv|\.pytest_cache)(\/|$)/;
/** Throwaway files an agent makes and removes while it works: screenshots, recordings, logs. */
const SCRATCH_FILE = /\.(png|jpe?g|gif|webp|mp4|mov|webm|log|tmp|swp|pid)$/i;
/** Temp locations (macOS resolves /tmp and /var through /private). */
const TEMP = /^(\/private)?\/(tmp|var\/folders)\//;

const normPath = (x: string) => x.replace(/^\/private(?=\/(tmp|var)\/)/, "").replace(/\/+$/, "");

/**
 * Where `p` sits in the project at `root`: its repository-relative path, or null when it is outside the
 * project folder, in a temp folder, behind a shell variable, or in a generated or tool-private folder
 * (node_modules, target, dist, .claude…). A path inside an agent's worktree
 * (`.claude/worktrees/<name>/src/a.ts`) is the project's `src/a.ts`. Relative paths are relative to the
 * project; `~` is matched against the root's home part.
 */
export function projectPath(p: string, root: string): string | null {
  if (!p || p.includes("$")) return null;
  let rel: string;
  const a = normPath(p);
  if (!a.startsWith("/") && !a.startsWith("~")) rel = a.replace(/^(\.\/)+/, "");
  else {
    const base = normPath(root);
    // A temp folder is never the project's, unless the project itself lives there (a scratch repo in /tmp).
    if ((TEMP.test(p) || TEMP.test(a)) && !(base && a.startsWith(base + "/"))) return null;
    const tail = base.replace(/^\/(Users|home)\/[^/]+/, "~");
    if (base && a.startsWith(base + "/")) rel = a.slice(base.length + 1);
    else if (tail.startsWith("~") && a.startsWith(tail + "/")) rel = a.slice(tail.length + 1);
    else return null;
  }
  const wt = WORKTREE.exec(rel);
  if (wt) rel = wt[2];
  if (!rel || rel === "." || rel.startsWith("../") || NOISE_DIR.test(rel)) return null;
  return rel;
}

/** An agent's worktree inside the project: `.claude/worktrees/<name>/…` (also `.codex/` and `.coool/`). */
const WORKTREE = /^\.(?:claude|codex|coool)\/worktrees\/([^/]+)\/(.+)$/;

/** The worktree inside the project that `p` is in (its name), or null for the project's own checkout. */
export function worktreeOf(p: string, root: string): string | null {
  const a = normPath(p);
  const base = normPath(root);
  const tail = base.replace(/^\/(Users|home)\/[^/]+/, "~");
  const rel = !a.startsWith("/") && !a.startsWith("~") ? a.replace(/^(\.\/)+/, "") : base && a.startsWith(base + "/") ? a.slice(base.length + 1) : tail.startsWith("~") && a.startsWith(tail + "/") ? a.slice(tail.length + 1) : null;
  return rel === null ? null : (/^\.(?:claude|codex|coool)\/worktrees\/([^/]+)(?:\/|$)/.exec(rel)?.[1] ?? null);
}

/** `dir` joined with a relative `p` (`..` and `.` resolved); absolute and `~` paths come back as they are. */
function resolve(dir: string, p: string): string {
  if (p.startsWith("/") || p.startsWith("~")) return p;
  const parts = dir.split("/");
  for (const x of p.split("/")) {
    if (x === "..") parts.pop();
    else if (x && x !== ".") parts.push(x);
  }
  return parts.join("/");
}

type Effect = Pick<Change, "kind" | "action" | "object" | "before" | "after" | "detail" | "tree">;

/** `{ tree }` for a path inside one of the project's agent worktrees, else nothing. */
const inTree = (p: string, root: string): { tree?: string } => {
  const t = worktreeOf(p, root);
  return t ? { tree: t } : {};
};

/**
 * What a shell command changed, or null for commands that only read, build or tidy up. With the project
 * `root`, deletes and moves count only inside the project: not in a temp folder, a `$VAR/…` scratch path, a
 * path after `cd` to somewhere else, generated folders (dist, target, node_modules, .claude) or throwaway
 * files (screenshots, recordings, logs). Worktree and branch housekeeping (`git worktree remove`,
 * `git branch -d`) is never a change. A commit's message comes from `-m`, `-am`, or a heredoc.
 */
export function sideEffect(command: string, branch: string | null = null, root: string | null = null): Effect | null {
  const { cmd, docs } = heredocs(command);
  // Where relative paths point: the project, until a `cd` goes elsewhere (`away`).
  let dir = root ? normPath(root) : "";
  let away = false;
  for (let seg of cmd.split(/&&|\|\||;|\n|\|(?!\|)/)) {
    seg = seg.trim().replace(/^\(+/, "").replace(/^(\w+=\S+\s+)+/, "").replace(/^sudo\s+/, "").replace(/^git\s+-C\s+\S+\s+/, "git ");
    if (!seg) continue;
    const cd = /^(?:cd|pushd)\s+(\S+)/.exec(seg);
    if (cd && root) {
      const to = cd[1].replace(/^["']|["']$/g, "");
      if (to.includes("$")) away = true;
      else {
        dir = resolve(dir, to);
        away = normPath(dir) !== normPath(root) && projectPath(`${dir}/x`, root) === null;
      }
      continue;
    }
    if (/^git\s+commit\b/.test(seg)) {
      const msg = commitMessage(seg, docs);
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
    if (/^(git\s+)?rm\s/.test(seg)) {
      const git = /^git/.test(seg);
      let targets = args(seg, git ? 2 : 1);
      // Only what is in the project, and neither generated nor throwaway (`git rm` is always in the repository).
      if (root) targets = away && !git ? [] : targets.map((t) => projectPath(resolve(dir, t), root)).filter((t): t is string => t !== null && !SCRATCH_FILE.test(t));
      const [first, ...rest] = targets;
      if (!first) continue;
      return { kind: "delete", action: "Deleted", object: first, detail: rest.length ? `and ${rest.length} more` : undefined };
    }
    if (/^(git\s+)?mv\s/.test(seg)) {
      const git = /^git/.test(seg);
      const a = args(seg, git ? 2 : 1);
      if (a.length < 2) continue;
      const from = root ? projectPath(resolve(dir, a[0]), root) : a[0];
      const to = root ? projectPath(resolve(dir, a[a.length - 1]), root) : a[a.length - 1];
      if (!from || !to || (away && !git) || SCRATCH_FILE.test(from)) continue;
      return { kind: "move", action: "Moved", object: from, before: from, after: to };
    }
    if (/^curl\b.*(-X|--request)\s*=?\s*(POST|PUT|DELETE|PATCH)\b/i.test(seg)) {
      const url = /https?:\/\/[^\s'"]+/.exec(seg)?.[0];
      // A request to this machine is an agent trying its own server, not a change somewhere else.
      if (url && /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/]|$)/.test(url)) continue;
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
    const effects: Effect[] = [];
    if (a.artifact) effects.push(publishRow(a.artifact));
    else if (FILE_TOOL.test(name) && detail) {
      const create = /^write$/i.test(name);
      // A Codex patch's line names each file it writes ("apply_patch · ~/w/a.rs, ~/w/b.rs", crates/core/src/codex.rs).
      for (const f of /^(apply_patch|patch)$/i.test(name) ? detail.split(", ") : [detail]) {
        const object = projectPath(f, root);
        if (object !== null) effects.push({ kind: create ? "create" : "edit", action: create ? "Wrote" : "Edited", object, ...inTree(f, root) });
      }
    } else if (SHELL_TOOL.test(name) && detail) {
      const e = sideEffect(detail, branch, root);
      if (e) effects.push(e);
    } else if (isPilotTool(name)) effects.push({ kind: "pilot", action: "Drove the device", object: clip(detail || "a pilot run", 64) });
    effects.forEach((e, k) => {
      const base = k ? `${id}|${k}` : id;
      const row: Change = { id: base, session, ...e, times: 1, ts, step: `a:${i}` };
      // Ids must be unique even for two identical steps in the same second.
      if (rows.some((r) => r.id === base)) row.id = `${base}#${i}`;
      turnOf.set(row.id, turn);
      rows.push(row);
    });
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
        for (const f of patchFiles(input)) {
          const object = projectPath(f.path, root);
          if (object !== null) push(`${t.id}:${f.path}`, { kind: f.kind, action: f.kind === "create" ? "Created" : f.kind === "delete" ? "Deleted" : "Edited", object, added: f.added, removed: f.removed, ...inTree(f.path, root) });
        }
        continue;
      }
      const path = String(input.file_path ?? input.notebook_path ?? input.path ?? "");
      if (!path) continue;
      const object = projectPath(path, root);
      if (object === null) continue;
      if (/^write$/i.test(t.name)) {
        const created = /creat|new file/i.test(t.output);
        const n = typeof input.content === "string" ? lines(input.content).length : undefined;
        push(t.id, { kind: created ? "create" : "edit", action: created ? "Created" : "Wrote", object, added: n, removed: created ? 0 : undefined, ...inTree(path, root) });
        continue;
      }
      // Edit: old_string/new_string; MultiEdit: edits[]
      const pairs: [string, string][] = Array.isArray(input.edits)
        ? (input.edits as { old_string?: unknown; new_string?: unknown }[]).map((e) => [String(e.old_string ?? ""), String(e.new_string ?? "")])
        : typeof input.old_string === "string" || typeof input.new_string === "string"
          ? [[String(input.old_string ?? ""), String(input.new_string ?? "")]]
          : [];
      const row: Effect & { added?: number; removed?: number } = { kind: "edit", action: "Edited", object, ...inTree(path, root) };
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
      const e = cmd ? sideEffect(cmd, branch, root) : null;
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
 * The cards that make up the session's fan-out: every one still running or waiting on the person (a
 * background agent started turns ago is still parallel work), plus those started in its latest turn (at
 * or after `turnStart`; all of them when the turn start is unknown) while they linger after finishing.
 * `extra` counts other workers shown with them (background shells). A fan-out needs two workers; when
 * none still runs, it stays for `linger` ms after the last one finished.
 */
export function fanout<T extends CellLike>(cards: T[], turnStart: number | null, now = Date.now(), linger = 90_000, extra = 0): T[] {
  const live = (c: T) => c.state === "running" || c.state === "needs";
  const batch = cards.filter((c) => live(c) || turnStart === null || (c.startedAt ?? c.lastAt) >= turnStart - 1000);
  if (batch.length === 0 || batch.length + extra < 2) return [];
  if (extra > 0 || batch.some(live)) return batch;
  const last = Math.max(...batch.map((c) => c.lastAt));
  return now - last < linger ? batch : [];
}

/** Count per state, in the legend's order. */
export function cellCounts(states: CellState[]): Record<CellState, number> {
  const out: Record<CellState, number> = { running: 0, needs: 0, failed: 0, stopped: 0, done: 0 };
  for (const s of states) out[s]++;
  return out;
}

// ---------- the ledger's rows ----------

/** A file's folder for a summary: its first two path parts (`app/src/a.ts` -> `app/src`), or "the root". */
const folderOf = (p: string) => {
  const parts = p.split("/");
  return parts.length <= 1 ? "" : parts.slice(0, Math.min(2, parts.length - 1)).join("/");
};

/**
 * A fan-out's subagents edit many files at once: past `max` file rows from one session's subagents, they
 * fold into one row that says what a person can use: how many distinct files, by how many agents, and
 * where ("Agents edited 18 files", "12 agents · app/src, crates/core and 2 more"). Writes and edits fold
 * together; the same file touched by several agents counts once. `agentOf` names the subagent a row came
 * from (null for the session's own rows, which never fold).
 */
export function foldAgentRows(rows: Change[], agentOf: (c: Change) => string | null, max = 3): Change[] {
  const fileRow = (r: Change) => r.kind === "edit" || r.kind === "create";
  const groups = new Map<string, Change[]>();
  for (const r of rows) {
    if (!agentOf(r) || !fileRow(r)) continue;
    groups.set(r.session, [...(groups.get(r.session) ?? []), r]);
  }
  const folded = new Map<string, Change>();
  for (const [k, g] of groups) {
    const files = new Set(g.map((r) => r.object));
    if (files.size <= max) continue;
    const agents = new Set(g.map(agentOf));
    const newest = g.reduce((a, b) => (b.ts > a.ts ? b : a));
    const sum = (f: (r: Change) => number | undefined) => (g.some((r) => f(r) !== undefined) ? g.reduce((n, r) => n + (f(r) ?? 0), 0) : undefined);
    // Folders by how many of the files are in them.
    const by = new Map<string, number>();
    for (const f of files) by.set(folderOf(f), (by.get(folderOf(f)) ?? 0) + 1);
    const top = [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([d]) => d || "the root");
    const where = top.length <= 2 ? top.join(", ") : `${top.slice(0, 2).join(", ")} and ${top.length - 2} more`;
    folded.set(k, {
      ...newest,
      id: `${k}|fold`,
      kind: g.every((r) => r.kind === "create") ? "create" : "edit",
      action: g.every((r) => r.kind === "create") ? "Agents wrote" : "Agents edited",
      object: `${files.size} files`,
      before: undefined,
      after: undefined,
      detail: `${agents.size} ${agents.size === 1 ? "agent" : "agents"} · ${where}`,
      added: sum((r) => r.added),
      removed: sum((r) => r.removed),
      times: 1,
    });
  }
  const out: Change[] = [];
  const placed = new Set<string>();
  for (const r of rows) {
    const f = agentOf(r) && fileRow(r) ? folded.get(r.session) : undefined;
    if (!f) out.push(r);
    else if (!placed.has(r.session)) {
      placed.add(r.session);
      out.push(f);
    }
  }
  return out;
}

/** What the ledger needs of the commit trail: when each commit was made and the files it lists. */
export interface TrailCommitLike {
  time_ms: number;
  files: string[];
  /** The subject and how many more files than `files` it touched (git_trail's fields), when known. */
  subject?: string;
  files_more?: number;
  merge?: { commits: { time_ms: number; files: string[]; subject?: string; files_more?: number }[] } | null;
}

/** Git history: the commit trail shows these, so the ledger leaves them to it. ("Merged PR" happens on the host; it stays.) */
const isHistory = (c: Change) => c.kind === "commit" || (c.kind === "merge" && c.action !== "Merged PR");
const FILE_KINDS = new Set<ChangeKind>(["edit", "create", "delete", "move"]);

/**
 * The ledger's rows from every change in a project (newest first): what the commit trail can't show.
 * - Edits that are committed leave: one whose author (the session, or the subagent) committed after it, or
 *   that a commit on the trail made after it lists.
 * - With a trail, commits, merges and rebases leave (the trail owns git history); without one they stay.
 * - Then subagents' file rows fold (`foldAgentRows`), and the list is capped.
 * Pushes, PRs, deploys, publishes, migrations, requests, device runs and deletes always stay.
 */
export function ledgerRows(rows: Change[], o: { agentOf: (c: Change) => string | null; trail: TrailCommitLike[] | null; cap?: number }): Change[] {
  const committed = committedBy(rows, o.agentOf, o.trail);
  const kept = rows.filter((c) => !(FILE_KINDS.has(c.kind) && committed(c)) && !(o.trail && isHistory(c)));
  return sameFile(foldAgentRows(kept, o.agentOf)).slice(0, o.cap ?? 40);
}

/** Commits on the trail, with the commits its merges brought in. */
const trailCommits = (trail: TrailCommitLike[] | null) => (trail ?? []).flatMap((t) => [t, ...(t.merge?.commits ?? [])]);
/** A file on the trail in a commit made after `ts` (a second of slack for clocks). */
const onTrail = (commits: TrailCommitLike[], file: string, ts: number) => commits.some((t) => t.time_ms >= ts - 1000 && t.files.includes(file));

/** Whether a file change is committed: its author (the session, or that subagent) committed after it, or a commit on the trail made after it lists the file. */
function committedBy(rows: Change[], agentOf: (c: Change) => string | null, trail: TrailCommitLike[] | null): (c: Change, file?: string) => boolean {
  const author = (c: Change) => `${c.session}|${agentOf(c) ?? ""}`;
  const commits = trailCommits(trail);
  // Each author's commits (time, message).
  const mine = new Map<string, Change[]>();
  for (const c of rows) if (c.kind === "commit") mine.set(author(c), [...(mine.get(author(c)) ?? []), c]);
  // A commit of the author's covers the file unless the trail has that commit (same message, made after the edit)
  // with its whole file list, and the file isn't in it: `git add other.txt && git commit` leaves notes.txt pending.
  const covers = (k: Change, file: string, ts: number) => {
    const t = commits.find((x) => x.subject !== undefined && x.time_ms >= ts - 1000 && sameSubject(x.subject, k.object));
    return !t || (t.files_more ?? 0) > 0 || t.files.includes(file);
  };
  return (c, file = c.object) => (mine.get(author(c)) ?? []).some((k) => k.ts >= c.ts && covers(k, file, c.ts)) || onTrail(commits, file, c.ts);
}

/** A trail subject and a ledger commit message (clipped to 72 with "…") name the same commit. */
function sameSubject(subject: string, msg: string): boolean {
  const m = msg.replace(/…$/, "");
  return subject === msg || (msg.endsWith("…") && subject.startsWith(m)) || subject === m.split("\n")[0];
}

// ---------- file overlap between live sessions ----------

/** What overlap detection needs of a session. */
export interface OverlapSession {
  /** Live: working, or idle with its process still there. */
  live: boolean;
  /** Its copy of the project: "" for the project's own checkout, else the worktree (`treeOf`). */
  tree: string;
}

export interface OverlapEdit {
  session: string;
  /** The subagent that made it (its id), or null for the session's own edit. */
  agent: string | null;
  /** The copy the edit was made in ("" = the project's checkout). */
  tree: string;
  /** Its latest pending change to the file. */
  ts: number;
  added?: number;
  removed?: number;
  /** How many pending changes it made to the file. */
  times: number;
}

export interface Overlap {
  file: string;
  /** "same": two sessions change the same copy of the file (a real clash); "merge": only in separate worktrees (their branches will need a merge). */
  kind: "same" | "merge";
  /** One per author (a session, or one of its subagents), newest first. */
  by: OverlapEdit[];
  /** Between the latest edits of the two authors that edited it most recently. */
  gapMs: number;
  /** The newest edit. */
  ts: number;
}

/**
 * A session's copy of the project from its folder: "" when it works in the project's checkout (or a folder
 * inside it), the worktree's name for `.claude/worktrees/<name>` (`.codex/`, `.coool/`), else its own folder
 * (a checkout elsewhere).
 */
export function treeOf(cwd: string, project: string): string {
  const a = normPath(cwd);
  const base = normPath(project);
  if (!a || a === base) return "";
  const wt = worktreeOf(a, base);
  if (wt) return wt;
  return a.startsWith(base + "/") ? "" : a;
}

/** Generated files every agent touches (lockfiles, snapshots): never an overlap. */
const GENERATED = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|go\.sum|[^/]+\.lock)$|(^|\/)__snapshots__\/|\.snap$/;

/** Who made an edit: the session, or one of its subagents (an orchestrator's agents in worktrees are separate hands). */
export const authorOf = (e: { session: string; agent: string | null }) => `${e.session}|${e.agent ?? ""}`;

/**
 * Files that two or more authors (sessions, or subagents of one: an orchestrator's agents each work in their
 * own worktree) of a project changed and neither has landed, while at least one of their sessions is live. A change still counts while it is pending:
 * - In the project's checkout: not committed yet (`committedBy`: the author committed after it, or a commit on
 *   the trail made after it lists the file).
 * - In a worktree: not merged yet. Its own commits stay in the worktree's branch, so only the trail (the
 *   project's branch, merges included) can say it landed.
 * A move counts for both its old and its new path. Lockfiles and snapshots are left out. Two authors in the
 * same copy make it "same"; otherwise "merge". Same-copy clashes first, then newest.
 */
export function overlaps(rows: Change[], sessions: Record<string, OverlapSession>, o: { agentOf: (c: Change) => string | null; trail: TrailCommitLike[] | null }): Overlap[] {
  const committed = committedBy(rows, o.agentOf, o.trail);
  const commits = trailCommits(o.trail);
  const by = new Map<string, Map<string, OverlapEdit>>();
  for (const c of rows) {
    if (!FILE_KINDS.has(c.kind) || c.id.endsWith("|fold")) continue;
    const who = sessions[c.session];
    if (!who) continue;
    const tree = c.tree ?? who.tree;
    for (const file of c.kind === "move" && c.after && c.after !== c.object ? [c.object, c.after] : [c.object]) {
      if (GENERATED.test(file)) continue;
      const pending = tree === "" ? !committed(c, file) : !onTrail(commits, file, c.ts);
      if (!pending) continue;
      const m = by.get(file) ?? new Map<string, OverlapEdit>();
      by.set(file, m);
      const agent = o.agentOf(c);
      const k = `${c.session}|${agent ?? ""}|${tree}`;
      const prev = m.get(k);
      if (!prev) m.set(k, { session: c.session, agent, tree, ts: c.ts, added: c.added, removed: c.removed, times: c.times });
      else {
        prev.ts = Math.max(prev.ts, c.ts);
        prev.times += c.times;
        if (prev.added !== undefined || c.added !== undefined) {
          prev.added = (prev.added ?? 0) + (c.added ?? 0);
          prev.removed = (prev.removed ?? 0) + (c.removed ?? 0);
        }
      }
    }
  }
  const out: Overlap[] = [];
  for (const [file, m] of by) {
    // One entry per author: its newest copy (an author rarely edits one file in two copies).
    const per = new Map<string, OverlapEdit>();
    for (const e of m.values()) {
      const p = per.get(authorOf(e));
      if (!p || e.ts > p.ts) per.set(authorOf(e), e);
    }
    const edits = [...per.values()].sort((a, b) => b.ts - a.ts || authorOf(a).localeCompare(authorOf(b)));
    if (edits.length < 2 || !edits.some((e) => sessions[e.session]?.live)) continue;
    // Same copy: two different authors edited it in one tree.
    const all = [...m.values()];
    const same = all.some((e) => all.some((f) => f.tree === e.tree && authorOf(f) !== authorOf(e)));
    out.push({ file, kind: same ? "same" : "merge", by: edits, gapMs: edits[0].ts - edits[1].ts, ts: edits[0].ts });
  }
  // Clashes in the same copy first, then by the newest edit.
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "same" ? -1 : 1) || b.ts - a.ts || a.file.localeCompare(b.file));
}

/** One row per uncommitted file: the same file edited from several sessions or turns is one row, newest, "×N". */
function sameFile(rows: Change[]): Change[] {
  const out: Change[] = [];
  const at = new Map<string, Change>();
  for (const r of rows) {
    if ((r.kind !== "edit" && r.kind !== "create") || r.id.endsWith("|fold")) {
      out.push(r);
      continue;
    }
    const prev = at.get(r.object);
    if (!prev) {
      const copy = { ...r };
      at.set(r.object, copy);
      out.push(copy);
      continue;
    }
    prev.times += r.times;
    if (prev.added !== undefined || r.added !== undefined) {
      prev.added = (prev.added ?? 0) + (r.added ?? 0);
      prev.removed = (prev.removed ?? 0) + (r.removed ?? 0);
    }
    prev.before = prev.after = undefined;
  }
  return out;
}

/** Mission control's one time format: "12s", "4m", "3h", "2d" (an age or an elapsed time alike). */
export function compactSpan(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
