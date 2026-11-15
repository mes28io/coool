// Built-in mock data source for running the UI in a plain browser.
// Realistic sessions across several projects that change over time:
// statuses flip, steps arrive, subagents run, and coool-run sessions get a
// fake terminal stream. Also the demo for coool.sh.

import type { Backend, ChatBatch, PtyChunk } from "./backend";
import { MockChat, mockModels, type ChatHost } from "./mockChat";
import type { Activity, ActivityKind, Agent, ChatEvent, InsightsStatus, PlanUsage, Provider, Session, Snapshot, Tokens, UsageWindow } from "./types";

const HOME = "/Users/you";
const enc = new TextEncoder();

const pad = (n: number) => String(n).padStart(2, "0");
const hhmmss = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const rnd = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const tok = (i = 0, o = 0, c = 0): Tokens => ({ input: i, cached: Math.floor(i * 3.2), output: o, context: c });

// Work scripts: what an agent "does" in each project.
const WORK: Record<string, string[]> = {
  coool: [
    "Grep · listen<Snapshot>",
    "Read · ~/code/coool/app/src/lib/backend.ts",
    "Read · ~/code/coool/crates/core/src/hub.rs",
    "text:The refresh thread emits `sessions` only when the JSON differs, so the store can treat every event as authoritative and drop its own diffing.",
    "Edit · ~/code/coool/app/src/store.ts",
    "Bash · pnpm tsc --noEmit",
    "Edit · ~/code/coool/app/src/components/Sidebar.tsx",
    "Bash · cargo build -p coool-app",
    "text:Build is clean. Sidebar rows now animate with `layout` so a session that flips to working glides up instead of jumping.",
  ],
  atlas: [
    "Read · ~/code/atlas-api/src/routes/search.rs",
    "Grep · RateLimiter",
    "Read · ~/code/atlas-api/src/middleware/mod.rs",
    "text:There's no limiter yet. I'll add a token-bucket layer keyed by API key, with a per-route budget read from config.",
    "Write · ~/code/atlas-api/src/middleware/rate_limit.rs",
    "Edit · ~/code/atlas-api/src/routes/mod.rs",
    "Bash · cargo test -p atlas-api rate_limit",
    "error:test rate_limit::refills_after_window failed: left 9, right 10",
    "Edit · ~/code/atlas-api/src/middleware/rate_limit.rs",
    "Bash · cargo test -p atlas-api rate_limit",
    "text:All 14 tests pass. The bucket refills continuously now instead of on window boundaries, which fixed the off-by-one.",
  ],
  pixel: [
    "Read · ~/code/pixelforge/render/pipeline.rs",
    "Bash · rg -n \"wgpu::\" render | head -40",
    "text:Most breakage is the new `PipelineCompilationOptions` field and the `entry_point: Option<&str>` change.",
    "Edit · ~/code/pixelforge/render/pipeline.rs",
    "Edit · ~/code/pixelforge/render/bloom.rs",
    "Bash · cargo check --features gpu",
    "Edit · ~/code/pixelforge/render/shadow.rs",
    "Bash · cargo check --features gpu",
    "text:`cargo check` is green. Next I'll run the golden-image tests to make sure the bloom pass still matches.",
    "Bash · cargo test --features gpu golden_",
  ],
  notes: [
    "Read · ~/code/notes-ios/Sync/SyncEngine.swift",
    "Glob · Sync/**/*.swift",
    "text:I'll persist outgoing mutations in a small SQLite-backed queue and drain it when NWPathMonitor reports connectivity.",
    "Write · ~/code/notes-ios/Sync/OutboxQueue.swift",
    "Edit · ~/code/notes-ios/Sync/SyncEngine.swift",
    "Bash · xcodebuild -scheme Notes -destination 'platform=iOS Simulator,name=iPhone 17' build",
    "Bash · xcodebuild test -scheme NotesTests",
    "text:Build and tests pass. Mutations made offline now replay in order once the device reconnects.",
  ],
};

const PROMPTS: Record<string, string[]> = {
  coool: ["Wire the Tauri events into the session store", "Make sidebar rows glide when status changes", "Add Cmd+K jump to any session"],
  atlas: ["Add rate limiting to /v2/search", "Why does the refill test fail intermittently?", "Expose limiter budgets in /metrics"],
  pixel: ["Port the shader pipeline to wgpu 26", "Fix the bloom pass on Metal", "Profile the shadow cascade"],
  notes: ["Implement the offline sync queue", "Retry failed mutations with backoff", "Write tests for conflict resolution"],
};

interface Live {
  s: Session;
  script: string;
  step: number;
  idleFor: number;
  chat?: MockChat;
}

// What the AI-insights scheduler would say about each live session.
const HEADLINES: Record<string, string> = {
  a1f0c2: "Wiring Tauri events into the store; an Explore agent is auditing xterm resizing",
  c7d1e9: "Fixed the RawLog clamp; asked how to handle the old offset API",
  b8e3aa: "Adding a token-bucket limiter to /v2/search, writing the middleware now",
  c51f00: "Porting the render pipeline to wgpu 26; reading through the compile errors",
  d4410e: "Bloom pass fixed on Metal; golden-image tests still to run",
};
const NEEDS: Record<string, string> = {
  c7d1e9: "Asked whether to keep the old offset() API or update all 6 callers",
};
const INSIGHTS_KEY = "coool.mock.insights";
function readInsights(): InsightsStatus {
  try {
    const v = JSON.parse(localStorage.getItem(INSIGHTS_KEY) || "null");
    if (v && typeof v.enabled === "boolean") return { enabled: v.enabled, has_key: !!v.has_key, available: true };
  } catch {}
  return { enabled: false, has_key: false, available: true };
}

function act(kind: ActivityKind, text: string, t: number): Activity {
  return { ts: hhmmss(t), kind, text };
}

function parseStep(line: string, t: number): Activity {
  if (line.startsWith("text:")) return act("text", line.slice(5), t);
  if (line.startsWith("error:")) return act("error", line.slice(6), t);
  if (line.startsWith("Agent · ")) return act("agent", line, t);
  return act("tool", line, t);
}

/** `turns` past turns of `script`; the first `keep` rows (all if omitted) end at `until`. */
function history(script: string, prompts: string[], until: number, turns: number, keep?: number): Activity[] {
  const lines: { kind: "prompt" | "step"; text: string }[] = [];
  for (let k = 0; k < turns; k++) {
    lines.push({ kind: "prompt", text: prompts[k % prompts.length] });
    for (const line of WORK[script]) lines.push({ kind: "step", text: line });
  }
  const rows = lines.slice(0, keep ?? lines.length);
  let t = until;
  const stamps: number[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    stamps.unshift(t);
    t -= rows[i].kind === "prompt" ? 60_000 + Math.random() * 120_000 : 6000 + Math.random() * 22000;
  }
  return rows.map((r, i) => (r.kind === "prompt" ? act("prompt", r.text, stamps[i]) : parseStep(r.text, stamps[i])));
}

function session(p: Partial<Session> & Pick<Session, "provider" | "id" | "cwd">): Session {
  return {
    title: "",
    model: p.provider === "claude" ? "claude-opus-5-5" : "gpt-5.1-codex",
    pid: null,
    status: "ended",
    current: null,
    last_prompt: null,
    tokens: tok(),
    activity: [],
    agents: [],
    updated: Date.now(),
    managed: null,
    ...p,
  };
}

export function mockBackend(): Backend {
  const now = Date.now();
  const live: Live[] = [];
  const add = (s: Session, script: string, step = 0) => {
    live.push({ s, script, step, idleFor: 0 });
    return s;
  };

  const coool = `${HOME}/code/coool`;
  const atlas = `${HOME}/code/atlas-api`;
  const pixel = `${HOME}/code/pixelforge`;
  const notes = `${HOME}/code/notes-ios`;

  const s1 = add(
    session({
      provider: "claude",
      id: "a1f0c2",
      cwd: coool,
      title: "Wire Tauri events into the session store",
      status: "busy",
      pid: 41022,
      tokens: tok(48_200, 9_800, 86_400),
      activity: history("coool", PROMPTS.coool, now - 4_000, 2, 16),
      current: "Bash · pnpm tsc --noEmit",
      updated: now - 2000,
    }),
    "coool",
    5,
  );
  s1.agents.push({
    id: "ag1",
    kind: "Explore",
    description: "Audit xterm resize handling",
    finished: false,
    current: "Grep · fitAddon.fit",
    tokens: tok(12_000, 1_400, 22_000),
    activity: [
      act("tool", "Glob · app/src/**/*.tsx", now - 30_000),
      act("tool", "Read · ~/code/coool/app/src/components/Terminal.tsx", now - 19_000),
      act("tool", "Grep · fitAddon.fit", now - 3_000),
    ],
  });
  s1.activity.push(act("agent", "Agent · Audit xterm resize handling", now - 34_000));

  add(
    session({
      provider: "codex",
      id: "c7d1e9",
      cwd: coool,
      title: "Fix RawLog offset clamp after buffer drain",
      status: "idle",
      tokens: tok(21_000, 4_100, 38_000),
      activity: history("coool", ["Fix RawLog offset clamp after buffer drain"], now - 120_000, 1),
      updated: now - 4 * 60_000,
    }),
    "coool",
  );

  add(
    session({
      provider: "claude",
      id: "b8e3aa",
      cwd: atlas,
      title: "Add rate limiting to /v2/search",
      status: "busy",
      pid: 39811,
      tokens: tok(102_000, 18_300, 131_000),
      activity: history("atlas", PROMPTS.atlas, now - 9_000, 1, 6),
      current: "Write · ~/code/atlas-api/src/middleware/rate_limit.rs",
      updated: now - 1000,
    }),
    "atlas",
    6,
  );
  add(
    session({
      provider: "claude",
      id: "b2c4ff",
      cwd: atlas,
      title: "Migrate auth middleware to tower",
      tokens: tok(64_000, 12_000, 72_000),
      activity: history("atlas", ["Migrate auth middleware to tower"], now - 41 * 60_000, 1),
      updated: now - 41 * 60_000,
    }),
    "atlas",
  );
  add(
    session({
      provider: "codex",
      id: "c0a9d1",
      cwd: atlas,
      title: "Explain the search ranking pipeline",
      tokens: tok(30_000, 6_000, 31_000),
      activity: history("atlas", ["Explain the search ranking pipeline"], now - 3 * 3600_000, 1),
      updated: now - 3 * 3600_000,
    }),
    "atlas",
  );
  add(
    session({
      provider: "codex",
      id: "c51f00",
      cwd: pixel,
      title: "Port the shader pipeline to wgpu 26",
      status: "busy",
      tokens: tok(77_000, 15_500, 119_000),
      activity: history("pixel", PROMPTS.pixel, now - 20_000, 1, 4),
      current: "thinking…",
      updated: now - 3000,
    }),
    "pixel",
    4,
  );
  add(
    session({
      provider: "claude",
      id: "d4410e",
      cwd: pixel,
      title: "Fix the bloom pass on Metal",
      status: "idle",
      pid: 40112,
      tokens: tok(54_000, 8_800, 61_000),
      activity: history("pixel", ["Fix the bloom pass on Metal"], now - 7 * 60_000, 1),
      updated: now - 7 * 60_000,
    }),
    "pixel",
  );
  add(
    session({
      provider: "claude",
      id: "f1aa20",
      cwd: `${HOME}/infra`,
      title: "Terraform: split the staging VPC",
      tokens: tok(22_000, 5_000, 25_000),
      activity: history("atlas", ["Terraform: split the staging VPC"], now - 5 * 3600_000, 1, 7),
      updated: now - 5 * 3600_000,
    }),
    "atlas",
  );
  add(
    session({
      provider: "codex",
      id: "c9e0b3",
      cwd: `${HOME}/code/site`,
      title: "Landing page hero copy pass",
      tokens: tok(9_000, 2_000, 12_000),
      activity: history("coool", ["Landing page hero copy pass"], now - 9 * 3600_000, 1, 5),
      updated: now - 9 * 3600_000,
    }),
    "coool",
  );

  // ---------- event plumbing ----------
  const subs = {
    sessions: new Set<(s: Snapshot) => void>(),
    out: new Set<(c: PtyChunk) => void>(),
    exit: new Set<(id: number) => void>(),
    chat: new Set<(b: ChatBatch) => void>(),
  };
  const ptys: { id: number; provider: Provider; cwd: string; running: boolean; started: number; log: number[]; line: string; total: number }[] = [];

  // ---------- startup scan simulation ----------
  // Like the real backend: nothing for ~400ms, then the cheap facts for each
  // session (loaded: false), with details filling in over the next ~2s.
  // `?slow=1` stretches this to ~30s and reveals sessions a few at a time.
  const slow = typeof location !== "undefined" && /[?&]slow=1\b/.test(location.search);
  const scanOrder = live.map((l) => l.s.id);
  const scan = { started: false, shown: 0, loaded: 0, loading: true };
  setTimeout(() => {
    scan.started = true;
    scan.shown = slow ? 3 : scanOrder.length;
    scan.loaded = slow ? 0 : 2;
    emitSessions();
    const t = setInterval(
      () => {
        if (slow) {
          if (scan.shown < scanOrder.length) scan.shown++;
          else scan.loaded++;
          if (scan.shown > 4) scan.loaded = Math.max(scan.loaded, scan.shown - 4);
        } else scan.loaded++;
        if (scan.loaded >= scanOrder.length) {
          scan.loading = false;
          clearInterval(t);
        }
        emitSessions();
      },
      slow ? 2600 : 260,
    );
  }, 400);
  const scanned = (l: Live): "hidden" | "cheap" | "full" => {
    if (l.chat) return "full";
    const i = scanOrder.indexOf(l.s.id);
    if (i < 0 || !scan.loading) return "full";
    if (!scan.started || i >= scan.shown) return "hidden";
    return i < scan.loaded ? "full" : "cheap";
  };
  const cheap = (s: Session): Session => ({
    ...s,
    model: "",
    current: null,
    last_prompt: null,
    tokens: { input: 0, cached: 0, output: 0, context: 0 },
    activity: [],
    agents: [],
    models: undefined,
    insight: null,
    loaded: false,
  });

  // ---------- plan usage ----------
  // `?usage=none` (nothing known), `?usage=error` (Claude not signed in), `?usage=stale` (old readings).
  const usageMode = typeof location !== "undefined" ? (/[?&]usage=(\w+)/.exec(location.search)?.[1] ?? "") : "";
  const nextMonday = () => {
    const d = new Date();
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  };
  const win = (id: string, label: string, kind: string, used: number | null, resets: number | null, minutes: number, extra: Partial<UsageWindow> = {}): UsageWindow => ({
    id, label, kind, used_percent: used, resets_ms: resets, window_minutes: minutes, model: null, severity: null, binding: null, as_of_ms: Date.now(), detail: null, ...extra,
  });
  const mkUsage = (): { claude: PlanUsage | null; codex: PlanUsage | null } => {
    if (usageMode === "none") return { claude: null, codex: null };
    const t = Date.now();
    const fetched = usageMode === "stale" ? t - 41 * 60_000 : t - 2 * 60_000;
    const stale = usageMode === "stale";
    const claude: PlanUsage = {
      provider: "claude", plan: "Max 5x", source: "claude.get_usage", fetched_ms: fetched, stale, error: null, reset_credits: null,
      credits: { enabled: true, unlimited: false, balance: null, used: 20, limit: 50, used_percent: 40, currency: "USD", detail: "20.00 of 50.00" },
      windows: [
        win("session", "Current session", "session", usageMode === "warn" ? 80 : 91, t + (60 + 54) * 60_000, 300, { severity: usageMode === "warn" ? "warning" : "critical", binding: true }),
        win("weekly_all", "Weekly (all models)", "weekly", 24, nextMonday(), 10080, { severity: "normal", binding: false }),
        win("weekly_scoped:Fable", "Weekly (Fable)", "weekly", 10, nextMonday(), 10080, { severity: "normal", model: "Fable", binding: false }),
      ],
    };
    const codex: PlanUsage = {
      provider: "codex", plan: "Plus", source: "codex.app_server", fetched_ms: fetched, stale, error: null, reset_credits: 3,
      credits: { enabled: false, unlimited: false, balance: "0", used: null, limit: null, used_percent: null, currency: null, detail: null },
      windows: [
        win("codex:primary", "5-hour", "session", null, null, 300, { detail: "Reset since the last reading" }),
        win("codex:secondary", "Weekly", "weekly", 5, t + 26 * 3600_000, 10080),
      ],
    };
    if (usageMode === "error") return { claude: { ...claude, plan: null, windows: [], credits: null, error: "Not signed in" }, codex };
    return { claude, codex };
  };
  const usage = mkUsage();

  const snapshot = (): Snapshot => {
    if (!scan.started) return { sessions: [], pending: [], ptys: [], chats: [], loading: true };
    const sessions = live
      .map((l) => [l, scanned(l)] as const)
      .filter(([, st]) => st !== "hidden")
      .map(([l, st]) => (st === "cheap" ? cheap(structuredClone(l.s)) : { ...decorate(structuredClone(l.s), l), loaded: true }));
    const order = { busy: 0, idle: 1, ended: 2 } as const;
    sessions.sort((a, b) => order[a.status] - order[b.status] || b.updated - a.updated);
    const linked = new Set(sessions.map((s) => s.managed).filter((m) => m !== null));
    return {
      sessions,
      pending: ptys.filter((p) => p.running && !linked.has(p.id)).map((p) => p.id),
      ptys: ptys.map(({ id, provider, cwd, running, started }) => ({ id, provider, cwd, running, started })),
      chats: chats.map((c) => c.info()),
      loading: scan.loading,
      usage,
    };
  };
  const emitSessions = () => {
    const s = snapshot();
    subs.sessions.forEach((cb) => cb(s));
  };

  // ---------- fake terminal ----------
  const C = {
    r: "\x1b[0m",
    dim: "\x1b[2m",
    b: "\x1b[1m",
    acc: "\x1b[38;2;232;149;107m",
    grn: "\x1b[32m",
    cyan: "\x1b[36m",
    gray: "\x1b[90m",
  };
  const out = (p: (typeof ptys)[number], s: string) => {
    if (!p.running) return;
    const b = enc.encode(s);
    p.log.push(...b);
    p.total += b.length;
    const chunk = { id: p.id, bytes: b, offset: p.total };
    subs.out.forEach((cb) => cb(chunk));
  };
  const W = 60;
  // A box row: `plain` sets the width, `styled` is what gets drawn.
  const boxRow = (plain: string, styled: string) => `${C.acc}│${C.r}${styled}${" ".repeat(Math.max(0, W - plain.length))}${C.acc}│${C.r}\r\n`;
  const promptLine = (p: (typeof ptys)[number]) => out(p, `\r\n${C.gray}${"─".repeat(W + 2)}${C.r}\r\n${C.b}>${C.r} `);
  const banner = (p: (typeof ptys)[number]) => {
    const folder = p.cwd.replace(HOME, "~");
    const name = p.provider === "claude" ? "Claude Code" : "Codex";
    const welcome = ` ✻ Welcome to ${name}`;
    const cwdLine = `   cwd: ${folder}`;
    out(
      p,
      `${C.acc}╭${"─".repeat(W)}╮${C.r}\r\n` +
        boxRow(welcome, ` ${C.acc}✻${C.r} Welcome to ${C.b}${name}${C.r}`) +
        boxRow("", "") +
        boxRow(cwdLine, `   ${C.dim}cwd: ${folder}${C.r}`) +
        `${C.acc}╰${"─".repeat(W)}╯${C.r}\r\n\r\n` +
        `${C.dim}  coool mock terminal (browser demo). Type a prompt and press enter.${C.r}\r\n`,
    );
    promptLine(p);
  };
  const reply = (p: (typeof ptys)[number], text: string) => {
    out(p, `\r\n${C.gray}${"─".repeat(W + 2)}${C.r}\r\n\r\n`);
    const lines = [
      `${C.acc}●${C.r} I'll look into: ${C.b}${text.slice(0, 48)}${C.r}`,
      `${C.grn}●${C.r} ${C.b}Read${C.r}(${C.cyan}src/lib.rs${C.r})`,
      `  ${C.gray}⎿  Read 214 lines${C.r}`,
      `${C.grn}●${C.r} ${C.b}Bash${C.r}(${C.cyan}cargo check${C.r})`,
      `  ${C.gray}⎿  Finished dev profile in 2.41s${C.r}`,
      `${C.acc}●${C.r} Done. This is a mock: no model was called.`,
    ];
    lines.forEach((l, i) => setTimeout(() => out(p, l + "\r\n"), 260 * (i + 1)));
    setTimeout(() => promptLine(p), 260 * (lines.length + 1));
  };
  const handleInput = (p: (typeof ptys)[number], data: string) => {
    const clean = data.replace(/\x1b\[20[01]~/g, "");
    for (const ch of clean) {
      if (ch === "\r") {
        const t = p.line;
        p.line = "";
        if (t.trim()) {
          reply(p, t);
          const s = live.find((l) => l.s.managed === p.id);
          if (s) startTurn(s, t);
        } else promptLine(p);
      } else if (ch === "\x7f") {
        if (p.line) {
          p.line = p.line.slice(0, -1);
          out(p, "\b \b");
        }
      } else if (ch >= " ") {
        p.line += ch;
        out(p, ch);
      }
    }
  };
  const newPty = (provider: Provider, cwd: string) => {
    const p = { id: ptys.length, provider, cwd, running: true, started: Date.now(), log: [] as number[], line: "", total: 0 };
    ptys.push(p);
    setTimeout(() => banner(p), 350);
    return p;
  };
  const endPty = (id: number) => {
    const p = ptys[id];
    if (!p || !p.running) return;
    out(p, `\r\n${C.gray}[process exited]${C.r}\r\n`);
    p.running = false;
    subs.exit.forEach((cb) => cb(id));
  };

  // ---------- models used (CHAT_SPEC "Models used") ----------
  // Most sessions report them; the two oldest don't, to exercise the fallback.
  for (const l of live) {
    const s = l.s;
    if (s.id === "c9e0b3" || s.id === "f1aa20") continue;
    s.models = mockModels(s.provider, s.tokens, s.agents.length > 0 || s.provider === "claude", s.model);
    for (const a of s.agents) {
      a.model = a.kind === "Explore" ? "claude-haiku-5-5" : "claude-sonnet-5-5";
      a.models = [{ model: a.model, input: a.tokens.input, cached: a.tokens.cached, output: a.tokens.output, messages: a.activity.length }];
    }
  }
  // A long Codex session near its (family-table) window, and an older Claude model.
  const pix = live.find((l) => l.s.id === "c51f00")!.s;
  pix.tokens.context = 236_000;
  const bloom = live.find((l) => l.s.id === "d4410e")!.s;
  bloom.model = "claude-sonnet-4-5-20250929";
  bloom.models = mockModels("claude", bloom.tokens, false, bloom.model);

  // ---------- chats (CHAT_SPEC) ----------
  const chats: MockChat[] = [];
  const chatReady = new Map<number, Promise<void>>();
  const pendingBatches = new Map<number, ChatEvent[]>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushChat = (c: MockChat, e: ChatEvent) => {
    if (c.vt !== null) return; // seeded history is picked up by chat_replay
    const b = pendingBatches.get(c.id) ?? [];
    b.push(e);
    pendingBatches.set(c.id, b);
    flushTimer ??= setTimeout(() => {
      flushTimer = null;
      for (const [id, events] of pendingBatches) subs.chat.forEach((cb) => cb({ id, events }));
      pendingBatches.clear();
    }, 16);
  };
  let sessionsTimer: ReturnType<typeof setTimeout> | null = null;
  const host: ChatHost = {
    link(c, s) {
      live.push({ s, script: "coool", step: 0, idleFor: 0, chat: c });
      emitSoon();
    },
    changed: () => emitSoon(),
    newPty: (provider, cwd) => newPty(provider, cwd).id,
  };
  function emitSoon() {
    sessionsTimer ??= setTimeout(() => {
      sessionsTimer = null;
      emitSessions();
    }, 60);
  }
  const newChat = (provider: Provider, cwd: string, o: { model?: string | null; mode?: string | null; resume?: string | null } = {}, readyIn = 450) => {
    const c = new MockChat(chats.length, provider, cwd, host, flushChat, o);
    chats.push(c);
    chatReady.set(
      c.id,
      new Promise<void>((r) =>
        readyIn <= 0
          ? (c.ready(), r())
          : setTimeout(() => {
              c.ready();
              r();
            }, readyIn),
      ),
    );
    return c;
  };

  // A chat with history that is about to ask for permission to run its tests.
  const chNotes = newChat("claude", notes, {}, 0);
  void chNotes.seed(["Implement the offline sync queue"], now - 6 * 60_000).then(() => {
    setTimeout(() => chNotes.send("Retry failed mutations with exponential backoff, keep the order"), 1200);
  });
  // A chat that starts working right away (Bash already allowed), so streaming is visible on load.
  const chCoool = newChat("claude", coool, {}, 0);
  chCoool.always.add("Bash");
  setTimeout(() => chCoool.send("Add a slash command menu to the chat composer"), 2200);

  const insights: InsightsStatus = readInsights();
  const saveInsights = () => {
    try {
      localStorage.setItem(INSIGHTS_KEY, JSON.stringify({ enabled: insights.enabled, has_key: insights.has_key }));
    } catch {}
  };
  const decorate = (s: Session, l: Live | undefined): Session => {
    if (!insights.enabled || !insights.has_key || s.status === "ended") return { ...s, insight: null };
    const c = l?.chat;
    let needs: string | null = NEEDS[s.id] ?? null;
    let headline = HEADLINES[s.id] ?? "";
    if (c) {
      const perm = c.waiting ? [...c.events].reverse().find((e) => e.type === "permission_request") : undefined;
      if (perm && perm.type === "permission_request") needs = `Wants to run \`${perm.summary}\` before finishing`;
      const lastText = [...s.activity].reverse().find((a) => a.kind === "text");
      headline = lastText ? lastText.text.replace(/`/g, "").split(/(?<=\.)\s/)[0].slice(0, 110) : "Getting started";
    }
    if (!headline) headline = s.title;
    return { ...s, insight: { headline, needs_you: needs, generated_ms: s.updated } };
  };

  // ---------- simulation ----------
  function startTurn(l: Live, prompt: string) {
    const t = Date.now();
    l.s.activity.push(act("prompt", prompt, t));
    l.s.last_prompt = prompt;
    l.s.status = "busy";
    l.s.current = "thinking…";
    l.s.updated = t;
    l.step = 0;
    l.idleFor = 0;
  }

  function tick() {
    const t = Date.now();
    let changed = false;
    for (const l of live) {
      const s = l.s;
      if (l.chat) continue; // chats drive their own session
      if (s.status === "busy") {
        if (Math.random() < 0.42) {
          const script = WORK[l.script];
          if (l.step >= script.length) {
            s.status = "idle";
            s.current = null;
            for (const a of s.agents) {
              a.finished = true;
              a.current = null;
            }
          } else {
            const a = parseStep(script[l.step++], t);
            s.activity.push(a);
            if (s.activity.length > 300) s.activity.splice(0, s.activity.length - 300);
            s.current = a.kind === "tool" || a.kind === "agent" ? a.text : "thinking…";
            s.tokens.input += 800 + Math.floor(Math.random() * 3000);
            s.tokens.cached += 4000 + Math.floor(Math.random() * 9000);
            s.tokens.output += 120 + Math.floor(Math.random() * 900);
            s.tokens.context = Math.min(s.provider === "codex" ? 262_000 : 420_000, s.tokens.context + 600 + Math.floor(Math.random() * 3400));
            const m = s.models?.[0];
            if (m) {
              m.input = Math.round(s.tokens.input * 0.82);
              m.cached = Math.round(s.tokens.cached * 0.85);
              m.output = Math.round(s.tokens.output * 0.8);
              m.messages++;
            }
            // Occasionally launch a subagent.
            if (a.kind === "tool" && Math.random() < 0.08 && !s.agents.some((g) => !g.finished)) {
              const desc = rnd(["Find all callers of refresh()", "Review the diff for regressions", "Survey test coverage gaps"]);
              s.activity.push(act("agent", `Agent · ${desc}`, t));
              const kind = rnd(["Explore", "general-purpose"]);
              const model = kind === "Explore" ? "claude-haiku-5-5" : "claude-sonnet-5-5";
              s.agents.push({ id: `ag${t}`, kind, description: desc, finished: false, current: "thinking…", tokens: tok(), activity: [], model, models: [{ model, input: 0, cached: 0, output: 0, messages: 0 }] });
            }
          }
          s.updated = t;
          changed = true;
        }
        for (const a of s.agents) {
          if (a.finished || Math.random() > 0.35) continue;
          if (a.activity.length >= 7) {
            a.finished = true;
            a.current = null;
            s.activity.push(act("text", `Subagent finished: ${a.description.toLowerCase()}. Nothing blocking found.`, t));
          } else {
            const step = parseStep(rnd(WORK[l.script].filter((x) => !x.includes(":") || x.includes(" · "))), t);
            a.activity.push(step);
            a.current = step.text;
            a.tokens.input += 900;
            a.tokens.output += 200;
            const am = a.models?.[0];
            if (am) {
              am.input += 900;
              am.output += 200;
              am.messages++;
            }
          }
          changed = true;
        }
      } else if (s.status === "idle") {
        l.idleFor++;
        if (l.idleFor > 14 && Math.random() < 0.06 && s.managed === null) {
          startTurn(l, rnd(PROMPTS[l.script] ?? PROMPTS.coool));
          changed = true;
        }
      }
    }
    if (changed) emitSessions();
  }
  setInterval(tick, 1100);

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const linkAfter = (p: (typeof ptys)[number], ms: number, existing?: Live, firstPrompt?: string) => {
    setTimeout(() => {
      if (!p.running) return;
      let l = existing;
      if (!l) {
        const s = session({ provider: p.provider, id: Math.random().toString(16).slice(2, 8), cwd: p.cwd, status: "idle", pid: 50000 + p.id, managed: p.id, updated: Date.now() });
        const key = Object.keys(PROMPTS).find((k) => p.cwd.includes(k)) ?? "coool";
        l = { s, script: key, step: 0, idleFor: 0 };
        live.push(l);
      }
      l.s.managed = p.id;
      l.s.status = "idle";
      l.s.updated = Date.now();
      if (firstPrompt) {
        startTurn(l, firstPrompt);
        l.s.title = firstPrompt.slice(0, 60);
      }
      emitSessions();
    }, ms);
  };

  return {
    kind: "mock",
    listSessions: async () => snapshot(),
    async spawnSession({ provider, cwd, args }) {
      await delay(120);
      const p = newPty(provider, cwd);
      const first = args?.find((a) => !a.startsWith("-"));
      if (first) setTimeout(() => out(p, first), 500);
      if (first) setTimeout(() => reply(p, first), 700);
      linkAfter(p, 1800, undefined, first);
      emitSessions();
      return p.id;
    },
    async resumeSession({ provider, sessionId, cwd }) {
      await delay(120);
      const p = newPty(provider, cwd);
      const l = live.find((x) => x.s.id === sessionId);
      linkAfter(p, 1200, l);
      emitSessions();
      return p.id;
    },
    async ptyWrite(id, data) {
      const p = ptys[id];
      if (p) handleInput(p, data);
    },
    async ptyResize() {},
    async ptyReplay(id) {
      const p = ptys[id];
      return { bytes: new Uint8Array(p?.log ?? []), offset: p?.total ?? 0 };
    },
    async sendPrompt(id, text) {
      const p = ptys[id];
      if (p) handleInput(p, text.replace(/\n/g, " ") + "\r");
    },
    async stopSession({ managed, pid }) {
      await delay(150);
      const l = live.find((x) => (managed != null && x.s.managed === managed) || (pid != null && x.s.pid === pid));
      if (managed != null) endPty(managed);
      if (l) {
        l.s.status = "ended";
        l.s.current = null;
        l.s.managed = null;
        l.s.pid = null;
        l.s.updated = Date.now();
        l.s.agents.forEach((a: Agent) => ((a.finished = true), (a.current = null)));
      }
      emitSessions();
    },
    async pickFolder() {
      await delay(200);
      return `${HOME}/code/new-project`;
    },
    async environment() {
      return { home: HOME, claude: "/usr/local/bin/claude", codex: "/opt/homebrew/bin/codex" };
    },
    async quit() {
      ptys.forEach((p) => endPty(p.id));
    },
    async usageRefresh(provider) {
      await delay(900);
      const u = usage[provider];
      if (!u || u.error || usageMode === "norefresh") return;
      u.fetched_ms = Date.now();
      u.stale = false;
      u.windows = u.windows.map((w) => (w.used_percent === null ? w : { ...w, used_percent: Math.min(100, w.used_percent + 1), as_of_ms: u.fetched_ms }));
      emitSessions();
    },
    onSessions(cb) {
      subs.sessions.add(cb);
      return () => subs.sessions.delete(cb);
    },
    onPtyOutput(cb) {
      subs.out.add(cb);
      return () => subs.out.delete(cb);
    },
    onPtyExit(cb) {
      subs.exit.add(cb);
      return () => subs.exit.delete(cb);
    },
    onConfirmQuit() {
      return () => {};
    },

    // ---------- chats ----------
    async startChat({ provider, cwd, resume, model, permission_mode }) {
      await delay(140);
      if (resume) {
        const l = live.find((x) => x.s.id === resume);
        if (l?.chat?.running) return l.chat.id;
        const c = newChat(provider, cwd, { model: model ?? l?.s.model, mode: permission_mode, resume });
        if (l) {
          c.session = l.s;
          l.chat = c;
          l.s.chat = c.id;
          l.s.status = "idle";
          l.s.pid = 52000 + c.id;
          l.s.updated = Date.now();
        }
      } else newChat(provider, cwd, { model, mode: permission_mode });
      emitSessions();
      return chats.length - 1;
    },
    async chatSend(id, text) {
      const c = chats[id];
      if (!c) throw new Error("no such chat");
      await chatReady.get(id);
      c.send(text);
    },
    async chatInterrupt(id) {
      chats[id]?.interrupt();
    },
    async chatSetModel(id, model) {
      await delay(120);
      chats[id]?.setModel(model);
    },
    async chatSetPermissionMode(id, mode) {
      chats[id]?.setMode(mode);
    },
    async chatRespondPermission(id, requestId, allow, always, remember) {
      await delay(60);
      chats[id]?.respond(requestId, allow, always, remember);
    },
    async chatRespondQuestion(id, requestId, answers) {
      await delay(60);
      chats[id]?.answer(requestId, answers);
    },
    async chatStop(id) {
      await delay(120);
      chats[id]?.stop(null);
      emitSessions();
    },
    async chatReplay(id) {
      const c = chats[id];
      return { events: c ? c.events.slice() : [], seq: c?.seq ?? 0 };
    },
    async openInTerminal(id) {
      const c = chats[id];
      if (!c) throw new Error("no such chat");
      await delay(160);
      if (c.running) {
        c.emit({ type: "notice", level: "info", text: "Continuing this session in the terminal.", needs_terminal: false });
        c.stop(0);
      }
      const p = newPty(c.provider, c.cwd);
      if (c.session) {
        c.session.managed = p.id;
        c.session.status = "idle";
        c.session.pid = 50000 + p.id;
        c.session.updated = Date.now();
      }
      emitSessions();
      return p.id;
    },
    onChatEvent(cb) {
      subs.chat.add(cb);
      return () => subs.chat.delete(cb);
    },

    // ---------- insights ----------
    async insightsStatus() {
      await delay(80);
      return { ...insights };
    },
    async insightsSetKey(key) {
      await delay(260);
      if (!/^sk-ant-/.test(key.trim())) throw new Error("That doesn't look like an Anthropic API key (it should start with sk-ant-).");
      insights.has_key = true;
      saveInsights();
      emitSessions();
    },
    async insightsClearKey() {
      await delay(120);
      insights.has_key = false;
      saveInsights();
      emitSessions();
    },
    async insightsSetEnabled(enabled) {
      insights.enabled = enabled;
      saveInsights();
      emitSessions();
    },
  };
}
