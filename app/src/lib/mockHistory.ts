// The browser demo's History (lib/history.ts): invented past sessions across projects, CLIs, places and two years,
// searched the way the backend does (every word, title first, then words, newer first). Knobs:
// `?history=<n>` sessions (default 420), `?history=indexing` (the first pass still running), `?history=empty`,
// `?historyPage=1` opens the page at load (`&historyq=<words>` types a search, `&historyProject=<name>` filters).

import type { Activity, Provider } from "./types";
import type { HistoryBackend, HistoryPage, HistoryQuery, HistoryRow, HistorySeg, Where } from "./history";

const PROJECTS = ["atlas-api", "notes-ios", "pixelforge", "relay", "relay-docs", "pocket-ledger", "coool", "blender-addon", "harbor", "invoices"];
const GONE = new Set(["harbor"]);
const TASKS = [
  "Fix the login redirect loop after the session expires",
  "Add rate limiting to the public upload endpoint",
  "Port the markdown parser to the new tokenizer",
  "Make the sidebar remember which projects are collapsed",
  "Investigate flaky checkout test on CI",
  "Move invoice PDFs to background jobs",
  "Write release notes for 2.4",
  "Speed up cold start: lazy-load the settings page",
  "Add dark mode to the onboarding screens",
  "Replace the date picker with the native one",
  "Find why the export drops the last row",
  "Refactor the sync engine into smaller modules",
  "Add a CSV importer with column mapping",
  "Clean up warnings in the iOS build",
  "Rename the billing tables and migrate data",
  "Draft the API docs for webhooks",
  "Bisect the memory leak in the renderer",
  "Hook up push notifications for replies",
  "Make search results highlight the matched words",
  "Add keyboard shortcuts to the editor toolbar",
];
const REPLIES = [
  "The redirect happened because the refresh token check ran after the route guard; I moved it into the loader and added a test.",
  "I added a token bucket per API key (60 requests a minute) with a Retry-After header, and documented it in the README.",
  "The tokenizer now emits spans; the parser walks them once, which removes the second pass and the regex fallback.",
  "Collapsed state now lives in localStorage keyed by project path, so it survives reloads.",
  "The test raced the debounce timer; it now waits for the request instead of a fixed timeout.",
  "PDF rendering moved into a queue worker; the request returns at once with a job id.",
  "Release notes drafted from the merged PRs, grouped by feature, fixes and breaking changes.",
  "Settings is code-split now, cold start went from 1.9 s to 1.2 s on the M1.",
  "The export loop used < instead of <= on the last page; fixed and covered by a test.",
  "The leak was a listener added on every render of the canvas view; it is removed on unmount now.",
];
const FILES = ["src/auth/session.ts", "src/routes/upload.ts", "src/parser/tokenize.rs", "src/ui/Sidebar.tsx", "tests/checkout.test.ts", "jobs/invoice_pdf.py", "CHANGELOG.md", "src/app/boot.ts", "src/export/csv.ts", "docs/webhooks.md"];
const VIA: [Where, string][] = [
  ["terminal", "Terminal"],
  ["terminal", "Terminal"],
  ["terminal", "Terminal"],
  ["coool", "coool"],
  ["coool", "coool"],
  ["ide", "VS Code"],
  ["app", "Claude app"],
  ["app", "Codex app"],
  ["automation", "Other tools"],
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Doc {
  row: HistoryRow;
  words: string;
}

function hex(r: () => number, n: number) {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(r() * 16).toString(16);
  return s;
}

function build(home: string, n: number, now: number): Doc[] {
  const r = rng(42);
  const docs: Doc[] = [];
  for (let i = 0; i < n; i++) {
    const project = PROJECTS[Math.floor(r() ** 1.4 * PROJECTS.length)];
    const provider: Provider = r() < 0.68 ? "claude" : "codex";
    const [where, via0] = VIA[Math.floor(r() * VIA.length)];
    const via = where === "app" ? (provider === "claude" ? "Claude app" : "Codex app") : via0;
    // Newer days are busier; a long tail back two years.
    const ageDays = i < 6 ? r() * 0.6 : (r() ** 2.2) * 730;
    const last = now - ageDays * 86_400_000 - r() * 3_600_000;
    const prompts = 1 + Math.floor(r() ** 2 * 60);
    const task = TASKS[Math.floor(r() * TASKS.length)];
    const reply = REPLIES[Math.floor(r() * REPLIES.length)];
    const edits = r() < 0.6 ? 1 + Math.floor(r() * 9) : 0;
    const id = provider === "claude" ? `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-8${hex(r, 3)}-${hex(r, 12)}` : `019a${hex(r, 4)}-${hex(r, 4)}-7${hex(r, 3)}-8${hex(r, 3)}-${hex(r, 12)}`;
    const sub = r() < 0.15 ? "/.claude/worktrees/agent-" + hex(r, 8) : "";
    const cwd = `${home}/code/${project}${sub}`;
    const row: HistoryRow = {
      key: `${provider}:${id}`,
      provider,
      id,
      cwd,
      project: `${home}/code/${project}`,
      title: task.length > 56 ? task.slice(0, 55) + "…" : task,
      prompt: task,
      model: provider === "claude" ? ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"][Math.floor(r() * 3)] : ["gpt-5.6", "gpt-5.6-luna"][Math.floor(r() * 2)],
      where,
      via,
      started_ms: last - prompts * (2 + r() * 6) * 60_000,
      last_ms: last,
      prompts,
      compactions: prompts > 40 ? 1 + Math.floor(r() * 3) : 0,
      edits,
      files: FILES.slice(0, Math.min(edits, 5)),
      bytes: Math.floor(prompts * (20_000 + r() * 80_000)),
      missing: GONE.has(project),
      archived: provider === "codex" && r() < 0.05,
    };
    docs.push({ row, words: `${task}\n${reply}\n${FILES.slice(0, edits).join(" ")}` });
  }
  docs.sort((a, b) => b.row.last_ms - a.row.last_ms);
  return docs;
}

function terms(text: string): string[] {
  const out: string[] = [];
  text.split('"').forEach((p, k) => (k % 2 ? p.trim() && out.push(p.trim().toLowerCase()) : out.push(...p.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase()))));
  return [...new Set(out)];
}

function snippet(words: string, ts: string[]): HistorySeg[] {
  const low = words.toLowerCase();
  const at = Math.max(0, Math.min(...ts.map((t) => low.indexOf(t)).filter((i) => i >= 0)));
  const a = Math.max(0, at - 50);
  const text = words.slice(a, at + 150).replace(/\s+/g, " ");
  const segs: HistorySeg[] = [];
  const re = new RegExp(`(${ts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  if (a > 0) segs.push({ t: "…" });
  for (const part of text.split(re)) if (part) segs.push(re.test(part) ? { t: part, hit: true } : { t: part });
  return segs;
}

/** The mock's History; `open` lists a row as a session (the backend's pin). */
export function mockHistory(home: string, open: (r: HistoryRow, activity: Activity[]) => void): HistoryBackend {
  const knob = typeof location !== "undefined" ? (/[?&]history=([\w-]+)/.exec(location.search)?.[1] ?? "") : "";
  const n = knob === "empty" ? 0 : Number.isFinite(Number(knob)) && Number(knob) > 0 ? Number(knob) : 420;
  const now = Date.now();
  const docs = build(home, n, now);
  const started = Date.now();
  const status = () => {
    const pending = knob === "indexing" ? Math.max(0, docs.length - Math.floor((Date.now() - started) / 40)) : 0;
    return { sessions: docs.length - pending, transcripts: docs.length, pending, text_bytes: docs.length * 9_000, log_bytes: docs.length * 11_000, ready: pending === 0 };
  };
  const timeline = (r: HistoryRow, long: boolean): Activity[] => {
    const out: Activity[] = [];
    const turns = long ? 140 : Math.min(r.prompts, 8);
    const t0 = r.last_ms - turns * 240_000;
    const ts = (ms: number) => new Date(ms).toTimeString().slice(0, 8);
    for (let k = 0; k < turns; k++) {
      const at = t0 + k * 240_000;
      out.push({ ts: ts(at), kind: "prompt", text: k === 0 ? r.prompt : `${["Now", "Also", "Then", "Next"][k % 4]} ${TASKS[(k * 7) % TASKS.length].toLowerCase()} (step ${k + 1})` } as Activity);
      out.push({ ts: ts(at + 20_000), kind: "tool", text: `Read · ${FILES[k % FILES.length]}` } as Activity);
      out.push({ ts: ts(at + 60_000), kind: "text", text: REPLIES[k % REPLIES.length] } as Activity);
    }
    return out;
  };
  const full = new Map<string, Activity[]>();
  return {
    async historyQuery(q: HistoryQuery): Promise<HistoryPage> {
      const t = performance.now();
      await new Promise((ok) => setTimeout(ok, 30));
      const st = status();
      const ready = docs.slice(0, docs.length - st.pending);
      const ts = terms(q.text ?? "");
      const facets = new Map<string, { count: number; last_ms: number }>();
      let hits = ready.filter(({ row: r }) => {
        if (q.providers?.length && !q.providers.includes(r.provider)) return false;
        if (q.wheres?.length && !q.wheres.includes(r.where)) return false;
        if (q.from_ms != null && r.last_ms < q.from_ms) return false;
        if (q.to_ms != null && r.last_ms > q.to_ms) return false;
        if (q.has_changes && !r.edits) return false;
        if (q.cwd && r.cwd !== q.cwd && !r.cwd.startsWith(q.cwd + "/")) return false;
        const f = facets.get(r.project) ?? { count: 0, last_ms: 0 };
        f.count++;
        f.last_ms = Math.max(f.last_ms, r.last_ms);
        facets.set(r.project, f);
        return !q.project || r.project === q.project;
      });
      const scored = hits.map((d) => {
        if (!ts.length) return { d, s: 0 };
        const title = d.row.title.toLowerCase();
        const words = d.words.toLowerCase();
        let s = 0;
        for (const w of ts) {
          if (!title.includes(w) && !words.includes(w) && !d.row.cwd.toLowerCase().includes(w)) return { d, s: -1 };
          s += (title.includes(w) ? 10 : 0) + (words.includes(w) ? 1 : 0);
        }
        return { d, s: s * (1 + 1 / (1 + (now - d.row.last_ms) / 86_400_000 / 14)) };
      });
      hits = scored.filter((x) => x.s >= 0).sort((a, b) => b.s - a.s || b.d.row.last_ms - a.d.row.last_ms).map((x) => x.d);
      const off = q.offset ?? 0;
      const rows = hits.slice(off, off + (q.limit || 100)).map((d) => (ts.length ? { ...d.row, snippet: snippet(d.words, ts) } : d.row));
      return {
        rows,
        total: hits.length,
        projects: [...facets].map(([project, f]) => ({ project, ...f })).sort((a, b) => b.last_ms - a.last_ms),
        status: st,
        took_ms: performance.now() - t,
      };
    },
    async historyStatus() {
      return status();
    },
    async historyOpen(provider, id) {
      const d = docs.find((x) => x.row.provider === provider && x.row.id === id);
      if (!d) throw new Error("That session's transcript isn't there any more.");
      // Every fifth session is a long one: its timeline holds the newest entries, the rest load as "earlier".
      const long = d.row.prompts > 30;
      const all = timeline(d.row, long);
      full.set(d.row.key, all);
      open(d.row, all.slice(-300));
      await new Promise((ok) => setTimeout(ok, 120));
      return d.row.key;
    },
    async historyEarlier({ provider, sessionId, keep, before, limit }) {
      await new Promise((ok) => setTimeout(ok, 160));
      const all = full.get(`${provider}:${sessionId}`) ?? [];
      const end = before ?? Math.max(0, all.length - keep);
      const start = Math.max(0, end - limit);
      return { entries: all.slice(start, end), start, total: all.length };
    },
    async historyFolder(cwd) {
      const name = cwd.split("/").pop() ?? "";
      const exists = !GONE.has(name);
      return { exists, moved_to: exists ? [] : [`${home}/work/${name}`] };
    },
    async historyMakeFolder(cwd) {
      GONE.delete(cwd.split("/").pop() ?? "");
    },
  };
}

