// Demo for the Changes view. Open the browser build with `?changes=demo`: a chat in ~/code/invoices whose agent
// (and one subagent) changed five files over two turns: two edits far apart in src/format.ts, a new test file, a
// deleted module, a README line already kept, a binary logo. The chat opens with its Changes panel.
//
// Knobs: `changes=diverged` (src/format.ts edited by hand since: a hunk marked, its undo asks), `changes=live` (a third
// turn running: src/invoice.ts is being edited, new edits keep landing), `changes=empty` (a chat that changed nothing),
// `changes=pending` (a Write waiting for permission, the diff in the card); `theme=light|dark`, `split=1`, `scope=chat|turn:1`.
// The mock backend's changes* calls (lib/mock.ts) answer from the state here, with real line diffs.

import type { ChangeSet, DiffLine, FileChange, HunkView, Outcome } from "./changesRules";
import type { MockChat } from "./mockChat";

const knob = () => (typeof location !== "undefined" ? (/[?&]changes=(\w+)/.exec(location.search)?.[1] ?? "") : "");

// ------------------------------------------------------------------------------------------------ texts

const FORMAT0 = `// Formatting for invoices and exports.

import { DEFAULT_CURRENCY } from "./config";

/** "2026-03" for an invoice issued in March 2026. */
export function formatPeriod(d: Date): string {
  const year = d.getFullYear();
  const month = d.getMonth();
  return \`\${year}-\${String(month).padStart(2, "0")}\`;
}

/** "€12.50" */
export function formatAmount(cents: number, currency = DEFAULT_CURRENCY): string {
  const value = cents / 100;
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(value);
}

/** The due date, \`days\` after the issue date. */
export function formatDue(d: Date, days: number): string {
  const due = new Date(d);
  due.setDate(due.getDate() + days);
  return due.toISOString().slice(0, 10);
}

/** "INV-2026-0042" */
export function invoiceNumber(year: number, n: number): string {
  return \`INV-\${year}-\${String(n).padStart(4, "0")}\`;
}

/** A customer's name as it goes on the invoice. */
export function billedTo(name: string, company?: string): string {
  return company ? \`\${name}, \${company}\` : name;
}

/** Lines for the totals block. */
export function totalsLines(net: number, tax: number): string[] {
  return [
    \`Net: \${formatAmount(net)}\`,
    \`VAT: \${formatAmount(tax)}\`,
    \`Total: \${formatAmount(net + tax)}\`,
  ];
}
`;

const FORMAT1 = FORMAT0.replace("  const month = d.getMonth();\n", "  // getMonth() is zero-based: March is 2.\n  const month = d.getMonth() + 1;\n").replace(
  "    `Total: ${formatAmount(net + tax)}`,\n",
  "    `Total: ${formatAmount(Math.round(net + tax))}`,\n",
);

const INVOICE0 = `import { formatAmount, formatDue, invoiceNumber } from "./format";
import type { Customer, Line } from "./types";

export interface Invoice {
  number: string;
  customer: Customer;
  lines: Line[];
  issued: Date;
  due: string;
}

export function makeInvoice(customer: Customer, lines: Line[], issued: Date, n: number): Invoice {
  return {
    number: invoiceNumber(issued.getFullYear(), n),
    customer,
    lines,
    issued,
    due: formatDue(issued, customer.terms ?? 30),
  };
}

export function lineTotal(l: Line): string {
  return formatAmount(l.qty * l.unit);
}
`;

const INVOICE1 = INVOICE0.replace('import { formatAmount, formatDue, invoiceNumber } from "./format";', 'import { formatAmount, formatDue, formatPeriod, invoiceNumber } from "./format";')
  .replace("  due: string;\n}", "  due: string;\n  /** The month it bills, \"2026-03\". */\n  period: string;\n}")
  .replace("    due: formatDue(issued, customer.terms ?? 30),\n", "    due: formatDue(issued, customer.terms ?? 30),\n    period: formatPeriod(issued),\n");

const INVOICE2 = INVOICE1.replace("export function lineTotal(l: Line): string {\n  return formatAmount(l.qty * l.unit);\n}", "export function lineTotal(l: Line): string {\n  // Quantities can be fractional (hours): round the cents once.\n  return formatAmount(Math.round(l.qty * l.unit));\n}");

const TEST1 = `import { describe, expect, it } from "vitest";
import { formatPeriod, totalsLines } from "../src/format";

describe("formatPeriod", () => {
  it("names March as 03", () => {
    expect(formatPeriod(new Date(2026, 2, 14))).toBe("2026-03");
  });
  it("names December as 12", () => {
    expect(formatPeriod(new Date(2026, 11, 1))).toBe("2026-12");
  });
});

describe("totalsLines", () => {
  it("rounds the total once", () => {
    expect(totalsLines(1005, 190.95)[2]).toBe("Total: €11.96");
  });
});
`;

const LEGACY0 = `// Deprecated: use formatPeriod from ../format.
export function legacyPeriod(d: Date): string {
  return d.toISOString().slice(0, 7);
}
`;

const README0 = `# invoices

Generates monthly invoices as PDF and CSV.

    npm install
    npm test

Run \`npm run export -- --month 2026-03\` to export one month.
`;
const README1 = README0.replace("Run `npm run export -- --month 2026-03` to export one month.", "Run `npm run export -- --month 2026-03` to export one month (months are 01–12).");

const HAND = FORMAT1.replace("  // getMonth() is zero-based: March is 2.\n", "  // getMonth() is zero-based (March is 2), so add one.\n");

// ------------------------------------------------------------------------------------------------ state

interface DemoFile {
  rel: string;
  base: string | null;
  /** After each turn (1-based), when the turn touched it. */
  turns: Record<number, string | null>;
  agent?: string;
  said?: string;
  binary?: boolean;
}

interface Demo {
  root: string;
  files: DemoFile[];
  disk: Record<string, string | null>;
  kept: Set<string>;
  keptHunks: Set<string>;
  undone: Record<string, number>;
  staged: Set<string>;
  busy: Set<string>;
  turns: { ts: number; prompt: string }[];
}

let demo: Demo | null = null;
let empty: string | null = null;

function makeDemo(root: string, t0: number): Demo {
  const files: DemoFile[] = [
    { rel: "src/format.ts", base: FORMAT0, turns: { 1: FORMAT1 }, said: "Fixed the off-by-one month in formatPeriod and rounded the total once in totalsLines." },
    { rel: "src/legacy/period.ts", base: LEGACY0, turns: { 1: null }, said: "Removed legacyPeriod: nothing imports it any more." },
    { rel: "src/invoice.ts", base: INVOICE0, turns: { 2: INVOICE1 }, said: "Invoices now carry the period they bill." },
    { rel: "tests/format.test.ts", base: null, turns: { 2: TEST1 }, agent: "Write the format tests", said: "Three tests: March, December, and the rounded total. All pass." },
    { rel: "README.md", base: README0, turns: { 2: README1 } },
    { rel: "assets/logo.png", base: "PNG", turns: { 2: "PNG2" }, binary: true },
  ];
  const disk: Record<string, string | null> = {};
  for (const f of files) {
    const ks = Object.keys(f.turns).map(Number).sort();
    disk[f.rel] = f.turns[ks[ks.length - 1]];
  }
  const d: Demo = {
    root,
    files,
    disk,
    kept: new Set(["README.md"]),
    keptHunks: new Set(),
    undone: {},
    staged: new Set(),
    busy: new Set(),
    turns: [
      { ts: t0, prompt: "Why do invoices from March show the wrong month?" },
      { ts: t0 + 4 * 60_000, prompt: "Add the billed period to each invoice, and tests for formatPeriod" },
    ],
  };
  if (knob() === "diverged") d.disk["src/format.ts"] = HAND;
  return d;
}

// ------------------------------------------------------------------------------------------------ diffs

function lcsOps(a: string[], b: string[]): ("=" | "-" | "+")[] {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: ("=" | "-" | "+")[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push("=");
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push("+");
      j++;
    } else {
      ops.push("-");
      i++;
    }
  }
  // Removals first within a change run (as the engine shows them).
  const out: ("=" | "-" | "+")[] = [];
  let run: ("-" | "+")[] = [];
  for (const o of [...ops, "=" as const]) {
    if (o === "=") {
      out.push(...run.filter((x) => x === "-"), ...run.filter((x) => x === "+"));
      run = [];
      out.push("=");
    } else run.push(o);
  }
  out.pop();
  return out;
}

const fp = (lines: DiffLine[]) => {
  let h = 2166136261;
  for (const l of lines) if (l.k !== " ") for (const c of l.k + l.t + "\n") h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
};

export function mkHunks(a: string, b: string, ctx = 3): HunkView[] {
  const al = a ? a.replace(/\n$/, "").split("\n") : [];
  const bl = b ? b.replace(/\n$/, "").split("\n") : [];
  const ops = lcsOps(al, bl);
  const rows: { k: " " | "-" | "+"; t: string; o?: number; n?: number }[] = [];
  let i = 0;
  let j = 0;
  for (const o of ops) {
    if (o === "=") rows.push({ k: " ", t: bl[j], o: ++i, n: ++j });
    else if (o === "-") rows.push({ k: "-", t: al[i], o: ++i });
    else rows.push({ k: "+", t: bl[j], n: ++j });
  }
  const changed = rows.map((r, x) => (r.k !== " " ? x : -1)).filter((x) => x >= 0);
  const groups: [number, number][] = [];
  for (const c of changed) {
    const s = Math.max(0, c - ctx);
    const e = Math.min(rows.length, c + ctx + 1);
    const g = groups[groups.length - 1];
    if (g && s <= g[1]) g[1] = Math.max(g[1], e);
    else groups.push([s, e]);
  }
  return groups.map(([s, e]) => {
    const lines = rows.slice(s, e) as DiffLine[];
    const first = lines[0];
    const old_start = first.o ?? (lines.find((l) => l.o)?.o ?? 1);
    const new_start = first.n ?? (lines.find((l) => l.n)?.n ?? 1);
    return {
      id: fp(lines),
      old_start,
      old_count: lines.filter((l) => l.k !== "+").length,
      new_start,
      new_count: lines.filter((l) => l.k !== "-").length,
      added: lines.filter((l) => l.k === "+").length,
      removed: lines.filter((l) => l.k === "-").length,
      lines,
      kept: false,
      since: false,
    };
  });
}

function stateAt(f: DemoFile, turn: number): string | null {
  let s = f.base;
  for (const k of Object.keys(f.turns).map(Number).sort()) if (k <= turn) s = f.turns[k];
  return s;
}

function fileView(d: Demo, f: DemoFile, scope: string): FileChange | null {
  const touched = Object.keys(f.turns).map(Number);
  const turnN = scope.startsWith("turn:") ? Number(scope.slice(5)) : null;
  if (turnN !== null && !touched.includes(turnN)) return null;
  const kept = d.kept.has(f.rel);
  if (scope === "pending" && (kept || d.undone[f.rel])) return null;
  const base = turnN !== null ? stateAt(f, turnN - 1) : f.base;
  const now = turnN !== null ? stateAt(f, turnN) : d.disk[f.rel];
  const agentAfter = stateAt(f, 99);
  const diverged = turnN === null && now !== agentAfter;
  const status: FileChange["status"] = base === null && now !== null ? "added" : base !== null && now === null ? "deleted" : base === now ? (d.undone[f.rel] ? "undone" : "unchanged") : "modified";
  const path = `${d.root}/${f.rel}`;
  const fc: FileChange = {
    path,
    rel: f.rel,
    status,
    added: 0,
    removed: 0,
    binary: !!f.binary,
    diverged,
    unknown_base: false,
    agents: f.agent ? [f.agent] : [],
    turns: touched,
    edits: touched.length,
    kept,
    staged: d.staged.has(f.rel),
    busy: d.busy.has(f.rel),
    reedited: false,
    said: f.said,
    line: 1,
    hunks: [],
    undone_at: d.undone[f.rel],
  };
  if (!f.binary && status !== "undone" && status !== "unchanged") {
    const hs = mkHunks(base ?? "", now ?? "");
    const handTouched = diverged && agentAfter !== null && now !== null ? new Set(mkHunks(agentAfter, now, 0).flatMap((h) => h.lines.filter((l) => l.n).map((l) => l.n!))) : new Set<number>();
    for (const h of hs) {
      h.kept = kept || d.keptHunks.has(`${f.rel}#${h.id}`);
      h.since = h.lines.some((l) => l.n && handTouched.has(l.n));
      fc.added += h.added;
      fc.removed += h.removed;
    }
    fc.hunks = hs;
    fc.line = hs[0]?.lines.find((l) => l.k !== " ")?.n ?? hs[0]?.new_start ?? 1;
    fc.text = (now ?? base) ?? undefined;
    if (scope === "pending" && hs.length && hs.every((h) => h.kept)) return null;
  }
  if (f.binary) {
    fc.added = 0;
    fc.removed = 0;
  }
  if (fc.busy) fc.blocked = "The agent is changing this file right now. Undo is back once its edit lands.";
  return fc;
}

export function changesLoadMock(cwd: string, scope: string): ChangeSet {
  const d = demo && cwd === demo.root ? demo : null;
  if (!d) return { root: cwd, scope, git: null, turns: [], files: [], pending: 0, total: 0, external: false, busy: false };
  const files = d.files.map((f) => fileView(d, f, scope)).filter((x): x is FileChange => !!x);
  const chat = d.files.map((f) => fileView(d, f, "chat")).filter((x): x is FileChange => !!x && x.status !== "unchanged");
  return {
    root: d.root,
    scope,
    git: { top: d.root, branch: "fix/march-period", busy: null, staged: [...d.staged].map((r) => `${d.root}/${r}`) },
    turns: d.turns.map((t, i) => {
      const fs = d.files.map((f) => fileView(d, f, `turn:${i + 1}`)).filter((x): x is FileChange => !!x);
      return { n: i + 1, ts: t.ts, prompt: t.prompt, files: fs.length, added: fs.reduce((n, f) => n + f.added, 0), removed: fs.reduce((n, f) => n + f.removed, 0) };
    }),
    files,
    pending: d.files.map((f) => fileView(d, f, "pending")).filter(Boolean).length,
    total: chat.length,
    external: false,
    busy: d.busy.size > 0,
  };
}

const relOf = (d: Demo, path: string | null) => (path ? path.replace(d.root + "/", "") : null);

export function changesUndoMock(cwd: string, scope: string, path: string | null, hunk: string | null, force: boolean): Outcome {
  const d = demo && cwd === demo.root ? demo : null;
  if (!d) return { ok: false, message: "Nothing to undo", done: [], refused: [] };
  const rel = relOf(d, path);
  const done: string[] = [];
  const refused: [string, string][] = [];
  for (const f of d.files.filter((x) => !rel || x.rel === rel)) {
    const v = fileView(d, f, scope);
    if (!v || v.status === "undone" || v.status === "unchanged") continue;
    if (v.busy) {
      refused.push([f.rel, v.blocked!]);
      continue;
    }
    if (f.binary) {
      refused.push([f.rel, "It's a binary file now, not what the agent wrote: coool won't overwrite it"]);
      continue;
    }
    if (hunk) {
      const h = v.hunks.find((x) => x.id === hunk);
      if (!h) continue;
      if (h.since && !force) return { ok: false, message: "", done: [], refused: [[f.rel, "you changed it after the agent did"]], ask: `You changed lines here (around line ${h.new_start}) after the agent's edit. Undoing this part would undo your edits too.` };
      const lines = (d.disk[f.rel] ?? "").replace(/\n$/, "").split("\n");
      const old = h.lines.filter((l) => l.k !== "+").map((l) => l.t);
      lines.splice(h.new_start - 1, h.new_count, ...old);
      d.disk[f.rel] = lines.join("\n") + "\n";
      done.push(f.rel);
      continue;
    }
    if (v.hunks.some((h) => h.since) && !force) {
      if (rel) return { ok: false, message: "", done: [], refused: [[f.rel, "you changed it after the agent did"]], ask: `You edited ${f.rel} after the agent did (around line ${v.hunks.find((h) => h.since)!.new_start}), in the same lines. Undoing the agent's change would throw your edits away.` };
      refused.push([f.rel, "you changed it after the agent did"]);
      continue;
    }
    d.disk[f.rel] = scope.startsWith("turn:") ? stateAt(f, Number(scope.slice(5)) - 1) : f.base;
    d.undone[f.rel] = Date.now();
    done.push(f.rel);
  }
  const message = done.length === 1 && !refused.length ? `Undid ${done[0]}` : done.length ? `Undid ${done.length} files${refused.length ? `; ${refused.length} left as they are` : ""}` : refused.length === 1 ? `${refused[0][0]}: ${refused[0][1]}` : "Nothing to undo";
  return { ok: done.length > 0, message, done, refused };
}

export function changesKeepMock(cwd: string, scope: string, path: string | null, hunk: string | null, stage: boolean, unkeep: boolean): Outcome {
  const d = demo && cwd === demo.root ? demo : null;
  if (!d) return { ok: false, message: "Nothing to keep", done: [], refused: [] };
  const rel = relOf(d, path);
  const done: string[] = [];
  for (const f of d.files.filter((x) => !rel || x.rel === rel)) {
    const v = fileView(d, f, unkeep ? "chat" : scope);
    if (!v) continue;
    if (unkeep) {
      d.kept.delete(f.rel);
      for (const h of v.hunks) d.keptHunks.delete(`${f.rel}#${h.id}`);
    } else if (hunk) {
      d.keptHunks.add(`${f.rel}#${hunk}`);
      if (v.hunks.every((h) => h.id === hunk || h.kept)) d.kept.add(f.rel);
    } else d.kept.add(f.rel);
    if (stage) d.staged.add(f.rel);
    done.push(f.rel);
  }
  return { ok: done.length > 0, message: unkeep ? "Marked as not reviewed" : stage ? `Kept and staged ${done.length === 1 ? done[0] : `${done.length} files`}` : `Kept ${done.length === 1 ? done[0] : `${done.length} files`}`, done, refused: [] };
}

export function changesCommitMock(cwd: string, message: string): Outcome {
  const d = demo && cwd === demo.root ? demo : null;
  if (!d || !d.staged.size) return { ok: false, message: "nothing is staged: keep and stage some changes first", done: [], refused: [] };
  if (!message.trim()) return { ok: false, message: "write a commit message first", done: [], refused: [] };
  d.staged.clear();
  return { ok: true, message: "Committed 3f9a2c1", done: [], refused: [], commit: "3f9a2c1" };
}

export function changesPreviewMock(cwd: string, tool: string, input: unknown): FileChange[] {
  const i = (input ?? {}) as { file_path?: string; content?: string; old_string?: string; new_string?: string };
  if (!i.file_path) return [];
  const rel = i.file_path.replace(cwd + "/", "");
  const cur = demo && cwd === demo.root ? (demo.disk[rel] ?? null) : null;
  const after = tool === "Write" ? (i.content ?? "") : cur && i.old_string ? cur.replace(i.old_string, i.new_string ?? "") : null;
  if (after === null) return [];
  const hs = mkHunks(cur ?? "", after);
  return [{ path: i.file_path, rel, status: cur === null ? "added" : "modified", added: hs.reduce((n, h) => n + h.added, 0), removed: hs.reduce((n, h) => n + h.removed, 0), binary: false, diverged: false, unknown_base: false, agents: [], turns: [], edits: 1, kept: false, staged: false, busy: false, reedited: false, line: hs[0]?.new_start ?? 1, hunks: hs, text: after }];
}

// ------------------------------------------------------------------------------------------------ the chat

let n = 0;
const id = () => `chg_${++n}`;

async function turn(c: MockChat, prompt: string, steps: { name: string; input: unknown; summary: string; parent?: string }[], reply: string, hold = false) {
  const gen = c.gen;
  c.ensureSession();
  c.emit({ type: "user_message", id: id(), text: prompt });
  c.setState("working");
  const start = c.now();
  await c.sleep(300, gen);
  for (const s of steps) {
    const tid = id();
    c.emit({ type: "tool_start", id: tid, name: s.name, summary: s.summary, input: s.input, parent_tool_id: s.parent ?? null });
    await c.sleep(500, gen);
    c.emit({ type: "tool_end", id: tid, ok: true, output: "ok" });
  }
  if (hold) return;
  c.emit({ type: "assistant_message", id: id(), text: reply, model: c.model, parent_tool_id: null });
  c.emit({ type: "turn_end", duration_ms: c.now() - start, ok: true });
  c.setState("idle");
}

export async function runChangesDemo(c: MockChat, root: string) {
  const k = knob();
  if (k === "empty") {
    empty = root;
    await turn(c, "What does formatPeriod return for March?", [{ name: "Read", input: { file_path: `${root}/src/format.ts` }, summary: "src/format.ts" }], "It returns `2026-02` for March: `getMonth()` is zero-based.");
    return openPanel(c);
  }
  c.vt = Date.now() - 12 * 60_000;
  demo = makeDemo(root, c.vt + 300);
  const edit = (rel: string) => ({ name: "Edit", input: { file_path: `${root}/${rel}`, old_string: "a", new_string: "b" }, summary: rel });
  await turn(c, demo.turns[0].prompt, [{ name: "Read", input: { file_path: `${root}/src/format.ts` }, summary: "src/format.ts" }, edit("src/format.ts"), edit("src/format.ts"), { name: "Bash", input: { command: "git rm src/legacy/period.ts" }, summary: "git rm src/legacy/period.ts" }, { name: "apply_patch", input: { changes: [{ path: `${root}/src/legacy/period.ts`, kind: "delete", diff: "" }] }, summary: "src/legacy/period.ts" }], "Fixed: `formatPeriod` used `getMonth()` as is. I also removed the unused `legacyPeriod`.");
  demo.turns[1].ts = c.now() + 300;
  await turn(
    c,
    demo.turns[1].prompt,
    [edit("src/invoice.ts"), { name: "Agent", input: { description: "Write the format tests", prompt: "tests" }, summary: "Write the format tests" }, { name: "Write", input: { file_path: `${root}/tests/format.test.ts`, content: TEST1 }, summary: "tests/format.test.ts" }, edit("README.md"), { name: "Write", input: { file_path: `${root}/assets/logo.png`, content: "" }, summary: "assets/logo.png" }],
    "Each invoice now has `period`, and `tests/format.test.ts` covers March, December and the rounded total.",
  );
  c.vt = null;
  openPanel(c);
  if (k === "live") {
    demo.turns.push({ ts: Date.now(), prompt: "Round fractional quantities in line totals" });
    const f = demo.files.find((x) => x.rel === "src/invoice.ts")!;
    void turn(c, demo.turns[2].prompt, [{ name: "Read", input: { file_path: `${root}/src/invoice.ts` }, summary: "src/invoice.ts" }], "", true);
    setTimeout(() => {
      if (!demo) return;
      demo.busy.add("src/invoice.ts");
      f.turns[3] = INVOICE2;
      demo.disk["src/invoice.ts"] = INVOICE2;
    }, 1500);
  }
  if (k === "pending") {
    setTimeout(() => c.send("Add a CHANGELOG entry for the month fix (review edits)"), 800);
  }
}

function openPanel(c: MockChat) {
  void import("../store").then(({ useStore }) => {
    const theme = /[?&]theme=(light|dark)/.exec(location.search)?.[1] as "light" | "dark" | undefined;
    if (/[?&]split=1/.test(location.search)) {
      void import("./changes").then((m) => m.setSplitPref(true));
      useStore.getState().setChangesWidth(1000);
    }
    if (theme) useStore.getState().setThemePref(theme);
    useStore.getState().open({ kind: "chat", id: c.id });
    setTimeout(() => {
      const key = c.session ? `${c.session.provider}:${c.session.id}` : `chat:${c.id}`;
      if (knob() !== "pending") useStore.getState().setRightPanel(key, "changes");
      const sc = /[?&]scope=([\w:]+)/.exec(location.search)?.[1];
      if (sc) void import("./changes").then((m) => m.useChangesOpen.getState().open(key, sc as never));
      // `click=undo|undoall|keephunk|stage`: press a button once the panel is up (for screenshots of what follows).
      const click = /[?&]click=(\w+)/.exec(location.search)?.[1];
      const sel: Record<string, string[]> = {
        undo: ['[data-change-file="src/format.ts"] [data-undo-file]'],
        undoall: ["[data-undo-all]"],
        keephunk: ['[data-change-file="src/format.ts"] [data-keep-hunk]'],
        stage: ['[data-change-file="src/format.ts"] [data-keep-more]', "[data-keep-stage]"],
      };
      if (click && sel[click]) {
        let t = 1200;
        for (const s of sel[click]) {
          setTimeout(() => document.querySelector<HTMLElement>(s)?.click(), t);
          t += 600;
        }
      }
    }, 600);
  });
}

export const changesEmptyRoot = () => empty;
