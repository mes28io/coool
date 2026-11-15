// The changes an agent made in a chat, derived from tool calls that succeeded:
// file writes/edits, and shell commands with outside effects (a short explicit list).
// Read-only here: coool does not restore files, so nothing is marked reversible.

import type { LedgerChange } from "../components/Ledger";
import type { Chat, ChatItem } from "./chat";
import { homeShort } from "./format";

type Tool = Extract<ChatItem, { kind: "tool" }>;

const FILE_TOOL = /^(write|edit|multiedit|notebookedit|apply_patch|patch)$/i;
const SHELL_TOOL = /(bash|shell|exec|command)/i;

const clip = (s: string, n = 40) => {
  const t = s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

function rel(p: string, cwd: string): string {
  const norm = (x: string) => x.replace(/^\/private(?=\/(tmp|var)\/)/, "").replace(/\/+$/, "");
  const [a, base] = [norm(p), norm(cwd)];
  return base && a.startsWith(base + "/") ? a.slice(base.length + 1) : homeShort(p);
}

/** [pattern on one command segment, action]. First match wins; segments are split on && ; | and newlines. */
const SIDE_EFFECTS: [RegExp, string][] = [
  [/^git\s+commit\b/, "Committed"],
  [/^git\s+push\b/, "Pushed"],
  [/^git\s+merge\b/, "Merged"],
  [/^git\s+rebase\b/, "Rebased"],
  [/^git\s+reset\b/, "Reset"],
  [/^(npm|pnpm|yarn|bun)\s+publish\b/, "Published"],
  [/^(npx\s+)?(vercel|netlify|firebase|wrangler|heroku)\b.*\b(deploy|publish)\b|^(npx\s+)?vercel(\s+--prod)?$/, "Deployed"],
  [/^(fly|flyctl)\s+deploy\b/, "Deployed"],
  [/^gh\s+pr\s+create\b/, "Opened a PR"],
  [/^gh\s+pr\s+merge\b/, "Merged a PR"],
  [/^rm\s/, "Deleted"],
  [/^mv\s/, "Moved"],
  [/^((npm|pnpm|yarn)\s+(run\s+)?(db:)?migrate|prisma\s+migrate|alembic\s+upgrade|diesel\s+migration\s+run|supabase\s+db\s+push|rails\s+db:migrate|sqlx\s+migrate\s+run)\b/, "Migrated"],
  [/^curl\b.*(-X|--request)\s*=?\s*(POST|PUT|DELETE|PATCH)\b/i, "Sent a request"],
];

function commandOf(t: Tool): string | null {
  const i = (t.input ?? {}) as Record<string, unknown>;
  const c = i.command ?? i.cmd;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    // Codex: ["bash", "-lc", "<script>"]
    const last = c[c.length - 1];
    return typeof last === "string" ? last : c.join(" ");
  }
  return null;
}

export function sideEffect(cmd: string): string | null {
  for (let seg of cmd.split(/&&|\|\||;|\n/)) {
    seg = seg.trim().replace(/^(\w+=\S+\s+)+/, "").replace(/^sudo\s+/, "");
    for (const [re, action] of SIDE_EFFECTS) if (re.test(seg)) return action;
  }
  return null;
}

/** Files a Codex patch touches, with what it does to each. */
function patchFiles(t: Tool): { path: string; action: "Created" | "Edited" | "Deleted" }[] {
  const i = (t.input ?? {}) as Record<string, unknown>;
  const out: { path: string; action: "Created" | "Edited" | "Deleted" }[] = [];
  // Codex fileChange items: changes: [{ path, kind: { type: "add" | "update" | "delete" }, diff }]
  if (Array.isArray(i.changes))
    for (const c of i.changes as { path?: string; kind?: { type?: string } | string }[]) {
      if (typeof c?.path !== "string") continue;
      const k = String(typeof c.kind === "string" ? c.kind : (c.kind?.type ?? "update"));
      out.push({ path: c.path, action: /add|create/.test(k) ? "Created" : /delete/.test(k) ? "Deleted" : "Edited" });
    }
  else if (i.changes && typeof i.changes === "object")
    for (const [p, v] of Object.entries(i.changes as Record<string, { type?: string }>)) out.push({ path: p, action: /add/.test(String(v?.type)) ? "Created" : "Edited" });
  const text = [i.input, i.patch, i.diff, t.input].find((v) => typeof v === "string") as string | undefined;
  if (text) for (const m of text.matchAll(/\*\*\* (Add|Update|Delete) File: (.+)/g)) out.push({ path: m[2].trim(), action: m[1] === "Add" ? "Created" : m[1] === "Delete" ? "Deleted" : "Edited" });
  return out;
}

export function deriveLedger(chat: Chat): LedgerChange[] {
  const rows: LedgerChange[] = [];
  const byKey = new Map<string, { row: LedgerChange; n: number }>();
  let turn = "";
  for (const it of chat.items) {
    if (it.kind === "prompt") {
      turn = it.key;
      continue;
    }
    if (it.kind !== "tool" || it.ok !== true) continue;
    const ts = it.endTs ?? it.ts;
    const i = (it.input ?? {}) as Record<string, unknown>;
    if (FILE_TOOL.test(it.name)) {
      const files: { path: string; action: string }[] = /patch/i.test(it.name)
        ? patchFiles(it)
        : [{ path: String(i.file_path ?? i.notebook_path ?? i.path ?? ""), action: /^write$/i.test(it.name) ? (/creat|new file/i.test(it.output) ? "Created" : "Wrote") : "Edited" }];
      for (const f of files) {
        if (!f.path) continue;
        const key = `${turn}|${f.action}|${f.path}`;
        const prev = byKey.get(key);
        if (prev) {
          prev.n++;
          prev.row.action = `${f.action} ×${prev.n}`;
          prev.row.detail = `${prev.n} edits in this turn`;
          prev.row.before = prev.row.after = undefined;
          prev.row.ts = ts;
          continue;
        }
        const row: LedgerChange = { id: it.id + (files.length > 1 ? `:${f.path}` : ""), action: f.action, object: rel(f.path, chat.cwd), ts, source: it.name, kind: "file", group: turn };
        if (/^(edit|multiedit)$/i.test(it.name) && typeof i.old_string === "string" && typeof i.new_string === "string") {
          const [b, a] = [clip(i.old_string), clip(i.new_string)];
          if (b && a) [row.before, row.after] = [b, a];
          else if (a) row.detail = `+ ${a}`;
          else if (b) row.detail = `− ${b}`;
        } else if (/^write$/i.test(it.name) && typeof i.content === "string") {
          const n = i.content.split("\n").length;
          row.detail = `${n} ${n === 1 ? "line" : "lines"}`;
        }
        byKey.set(key, { row, n: 1 });
        rows.push(row);
      }
    } else if (SHELL_TOOL.test(it.name)) {
      const cmd = commandOf(it);
      const action = cmd && sideEffect(cmd);
      if (!cmd || !action) continue;
      rows.push({ id: it.id, action, object: clip(cmd, 56), ts, source: it.name, kind: "terminal", reversible: false, group: turn });
    }
  }
  return rows.reverse();
}
