// Built-in mock data source for running the UI in a plain browser.
// Realistic sessions across several projects that change over time:
// statuses flip, steps arrive, subagents run, and coool-run sessions get a
// fake terminal stream. Also the demo for coool.sh.

import { NotAvailable, type Backend, type ChatBatch, type PtyChunk } from "./backend";
import { AGENTS_DEMO_ID, AGENTS_JOBS_ID, AGENTS_SHELLS_ID } from "./agentsDemo";
import { MockChat, mockModels, type ChatHost } from "./mockChat";
import { SessionsMerge } from "./sessionsMerge";
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
  /** Demo: cycles working -> waiting -> needs you on its own clock (the "relay" project). */
  cycle?: number;
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
/** Mock terminal session with running subagents (sidebar nesting, Home card, header chip). */
const AGENTS_DEMO = AGENTS_DEMO_ID;
const SHOW_AUTOMATION_KEY = "coool.mock.showAutomation";
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
    project: p.project ?? p.cwd,
  };
}

export function mockBackend(): Backend {
  const now = Date.now();
  let showAutomation = (() => {
    try {
      return localStorage.getItem(SHOW_AUTOMATION_KEY) === "1";
    } catch {
      return false;
    }
  })();
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

  const c7 = add(
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
  // Full text for a read-only session: a multi-line prompt, a long Markdown reply with a table, and a cut one.
  const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
  const fullAct = (kind: ActivityKind, full: string, t: number, shortened?: boolean): Activity => ({ ...act(kind, oneLine(full).slice(0, 400), t), full, ...(shortened ? { shortened: true } : {}) });
  c7.activity.push(
    fullAct("prompt", "Why does the drain loop stall after a failed mutation?\n\nContext:\n- it only happens offline\n- the queue is ordered, so a failure blocks the rest\n\nPlease check src/sync/queue.rs and tell me what to change.", now - 150_000),
    fullAct(
      "text",
      "The loop stops on the first `Err` because `drain()` returns early instead of scheduling a retry.\n\nWhat I checked:\n\n| File | Line | Finding |\n|---|---:|---|\n| `src/sync/queue.rs` | 88 | `?` leaves the loop on any error |\n| `src/sync/retry.rs` | 14 | backoff exists but is never called |\n\nSuggested change:\n\n1. Catch the error in `drain()` and record the attempt.\n2. Wait `min(2^n, 60)` seconds before the next try.\n3. Keep the failed item at the head so order is preserved.\n\n```rust\nif let Err(e) = send(&m).await {\n    m.attempts += 1;\n    sleep(backoff(m.attempts)).await;\n    continue;\n}\n```\n\nNothing was changed; this is read-only analysis.",
      now - 140_000,
    ),
    fullAct("prompt", "Now paste the whole retry module with comments so I can review it offline.", now - 100_000),
    fullAct("text", "Here is the start of the module. The reply is long, so only the first part is kept:\n\n```rust\n// retry.rs\npub fn backoff(n: u32) -> Duration {\n    Duration::from_secs(2u64.pow(n.min(6)))\n}\n```\n\n(the rest of the module follows in the original transcript)", now - 90_000, true),
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
      id: "5c7e19",
      cwd: `/private/tmp/claude-501/-Users-me-code-atlas-api/b1cd1930-6f74-4abe-bf52-13f0eba84069/scratchpad/env-test`,
      project: atlas,
      title: "Check the env loader handles empty values",
      tokens: tok(6_000, 1_000, 8_000),
      activity: history("atlas", ["Check the env loader handles empty values"], now - 3 * 3600_000, 1, 4),
      updated: now - 3 * 3600_000,
    }),
    "atlas",
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

  // A long-lived project: many ended chats, so the sidebar cap, "Show N more"
  // paging and "Show less" can be seen.
  const OLD_TITLES = [
    "Sidebar: cap ended chats per project", "Keep the chat composer focused after send", "Fix the double-render on tab switch",
    "Plan usage popover: show reset times", "Speed up the first refresh on a cold cache", "Approval card: short file paths",
    "Palette: fuzzy match on folder names", "Make the theme follow the system", "Terminal: keep scrollback on resize",
    "Subagent rows under their session", "Explain the loader's priority queue", "Codex: link resumed rollouts",
    "Stop button for external sessions", "Self-test: screenshot every scenario", "Rename the mission control view",
    "Tighter row spacing in the sidebar", "Model picker: group by provider", "Remember the sidebar width",
    "Insights: hourly cap and backoff", "Fix the context meter for 1M windows", "Status colours: one dot per state",
    "Persist splits across reloads", "Wordmark intro animation", "Quit confirmation lists what runs",
    "Raw log: clamp the offset after drain", "Folder picker in the new-session sheet",
  ];
  OLD_TITLES.forEach((title, i) =>
    add(
      session({
        provider: i % 4 === 3 ? "codex" : "claude",
        id: `old${pad(i)}`,
        cwd: coool,
        title,
        tokens: tok(8_000 + i * 900, 1_200 + i * 40, 20_000),
        activity: history("coool", [title], now - (25 + i * 47) * 60_000, 1, 3),
        updated: now - (25 + i * 47) * 60_000,
      }),
      "coool",
    ),
  );
  // Runs other tools and agents started: hidden unless Settings says otherwise.
  for (let i = 0; i < 7; i++) {
    add(
      session({
        provider: "claude",
        id: `auto${i}`,
        cwd: `/private/tmp/claude-501/-Users-you-code-coool/7f3c${i}a10-1b2c-4d5e-8f90-a1b2c3d4e5f6/scratchpad/probe`,
        project: coool,
        origin: "automation",
        title: rnd(["Probe the transcript format", "Check what `claude -p` writes", "Smoke test the chat protocol", "Reply with one word"]),
        tokens: tok(2_000, 300, 4_000),
        activity: history("coool", ["Reply with exactly: ok"], now - (10 + i * 70) * 60_000, 1, 2),
        updated: now - (10 + i * 70) * 60_000,
      }),
      "coool",
    );
  }
  for (let i = 0; i < 5; i++) {
    add(
      session({
        provider: i === 4 ? "codex" : "claude",
        id: `kiln${i}`,
        cwd: `${HOME}/Library/Application Support/Kiln/agent`,
        origin: "automation",
        title: rnd(["Add a small green sphere named Dot", "Light it like a product shot", "Name the objects in the scene"]),
        tokens: tok(3_000, 500, 6_000),
        activity: history("pixel", ["Add a small green sphere named Dot"], now - (90 + i * 30) * 60_000, 1, 2),
        updated: now - (90 + i * 30) * 60_000,
      }),
      "pixel",
    );
  }
  // A terminal session that finished its turn while two jobs it launched in the
  // background still work (child runs), plus some that already ended.
  const parentId = "5e1f0a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
  add(
    session({
      provider: "claude",
      id: parentId,
      cwd: pixel,
      title: "Render the turntable previews",
      status: "idle",
      pid: 40220,
      background_tasks: true,
      tokens: tok(88_000, 9_000, 97_000),
      activity: history("pixel", ["Render the turntable previews in the background and tell me when they're done"], now - 6 * 60_000, 1, 5),
      updated: now - 5 * 60_000,
    }),
    "pixel",
  );
  const jobScratch = `/private/tmp/claude-501/-Users-you-code-pixelforge/${parentId}/scratchpad/jobs`;
  ["Render the turntable: hero model", "Render the turntable: props"].forEach((title, i) =>
    add(session({ provider: i ? "codex" : "claude", id: `job${i}`, cwd: jobScratch, project: pixel, origin: "automation", parent: parentId, title, status: "busy", pid: 40300 + i, current: "Bash · blender -b scene.blend -a", activity: history("pixel", [title], now - 4 * 60_000, 1, 3), updated: now - 2000 }), "pixel", 2),
  );
  ["Bake the light probes", "Check the UV seams", "Export the LODs", "Compress the textures"].forEach((title, i) =>
    add(session({ provider: "claude", id: `jobdone${i}`, cwd: jobScratch, project: pixel, origin: "automation", parent: parentId, title, activity: history("pixel", [title], now - (20 + i * 15) * 60_000, 1, 2), updated: now - (20 + i * 15) * 60_000 }), "pixel"),
  );

  // A project whose chats keep changing state (collapse it to see the live summary).
  const relay = `${HOME}/code/relay`;
  [
    { id: "r1a001", title: "Retry webhooks with backoff", cycle: 0 },
    { id: "r1a002", title: "Dedupe events by idempotency key", cycle: 3 },
    { id: "r1a003", title: "Load-test the fan-out worker", cycle: 6 },
  ].forEach(({ id, title, cycle }, i) => {
    const phase = Math.floor((cycle % 15) / 5);
    const s = session({ provider: i === 1 ? "codex" : "claude", id, cwd: relay, title, status: phase === 0 ? "busy" : "idle", current: phase === 0 ? "thinking…" : null, activity: history("atlas", [title], now - 60_000, 1, 3), updated: now - i * 1000 });
    live.push({ s, script: "atlas", step: 0, idleFor: 0, cycle });
  });

  // A terminal session between turns with four subagents still working (and three that
  // finished): the sidebar nests the running ones under it. One finishes after ~15 s.
  const p3d = `${HOME}/code/project-3d`;
  const ag3 = add(
    session({
      provider: "claude",
      id: AGENTS_DEMO,
      cwd: p3d,
      title: "Ship the Blender add-on milestone",
      status: "idle",
      pid: 40555,
      tokens: tok(64_000, 11_000, 92_000),
      activity: history("pixel", ["Split the milestone across four agents and report back when they finish"], now - 3 * 60_000, 1, 4),
      updated: now - 20_000,
    }),
    "pixel",
  );
  const mkAgent = (id: string, kind: string, description: string, finished: boolean, steps: string[], ageS: number, result?: string): Agent => ({
    id,
    kind,
    description,
    finished,
    current: finished ? null : steps[0],
    tokens: tok(9_000 + steps.length * 700, 1_200 + steps.length * 300, 16_000),
    activity: [...steps.map((x, i) => parseStep(x, now - (ageS - i * 6) * 1000)), ...(result ? [act("text", result, now - (ageS - steps.length * 6) * 1000)] : [])],
    model: kind === "Explore" ? "claude-haiku-5-5" : "claude-sonnet-5-5",
  });
  // What each running agent does next, one step every few seconds. `!` marks a failed step; the
  // last row of an agent that ends says how.
  const P = "~/code/project-3d/src";
  const AGENT_STEPS: Record<string, string[]> = {
    ag3d1: [`Read · ${P}/uv/unwrap.rs`, "Grep · seam_angle", `Edit · ${P}/uv/unwrap.rs`, "Bash · cargo test uv::", `Read · ${P}/texture/image.rs`, "Grep · ImageTexture", `Edit · ${P}/texture/image.rs`, `Edit · ${P}/uv/pack.rs`, "Bash · cargo test uv::pack", `Read · ${P}/texture/sampler.rs`, `Edit · ${P}/texture/sampler.rs`, "Bash · cargo clippy -p uv", `Read · ${P}/uv/mod.rs`, `Edit · ${P}/uv/mod.rs`, "Bash · cargo test texture::"],
    ag3d2: [`Glob · src/curves/**/*.rs`, `Read · ${P}/curves/bezier.rs`, `Edit · ${P}/text/outline.rs`, "Bash · cargo test curves::", "!Bash · cargo test curves::bezier", `Read · ${P}/curves/bezier.rs`, `Edit · ${P}/curves/bezier.rs`, "Bash · cargo test curves::bezier", `Grep · glyph_cache`, `Edit · ${P}/text/glyph.rs`, "Bash · cargo test text::", `Read · ${P}/text/layout.rs`, `Edit · ${P}/text/layout.rs`, "Bash · cargo test text::layout"],
    ag3d3: ["Grep · KHR_materials", `Read · ${P}/gltf/import.rs`, `Edit · ${P}/ui/modifiers.tsx`, "Bash · pnpm tsc --noEmit", `Edit · ${P}/gltf/import.rs`, "Web · KHR_materials_variants spec", "Grep · extensionsUsed", `Read · ${P}/gltf/extensions.rs`, `Edit · ${P}/gltf/extensions.rs`, "Bash · cargo test gltf::"],
    ag3d4: [`Read · ${P}/ui/Toolbar.tsx`, `Edit · ${P}/ui/Toolbar.tsx`, "Bash · pnpm vitest run", "Grep · TODO polish", `Edit · ${P}/ui/Tooltip.tsx`, `Edit · ${P}/ui/Panel.tsx`, "Bash · pnpm vitest run", `Edit · ${P}/ui/theme.ts`],
  };
  ag3.agents.push(
    mkAgent("ag3d1", "general-purpose", "UV unwrap and image textures", false, AGENT_STEPS.ag3d1.slice(0, 4), 24),
    mkAgent("ag3d2", "general-purpose", "Curves and text objects", false, AGENT_STEPS.ag3d2.slice(0, 3), 18),
    mkAgent("ag3d3", "Explore", "glTF import and modifier panel", false, AGENT_STEPS.ag3d3.slice(0, 5), 30),
    mkAgent("ag3d4", "general-purpose", "App polish fixes", false, AGENT_STEPS.ag3d4.slice(0, 2), 10),
    mkAgent("ag3d5", "Explore", "Survey the Blender operator API", true, ["Grep · bpy.ops", "Read · docs/operators.md", "Grep · register_class", "Read · docs/api/types.md"], 600, "Found 212 operators; the add-on needs 9 of them, all stable since Blender 3.6."),
    mkAgent("ag3d6", "general-purpose", "Set up the add-on test harness", true, ["Write · tests/conftest.py", "Bash · pytest -q", "Edit · tests/conftest.py", "Bash · pytest -q"], 520, "Harness runs headless Blender; 14 tests collected and passing."),
    mkAgent("ag3d7", "Explore", "Find the mesh export hot path", true, ["Grep · export_mesh", "Read · src/export/mesh.rs", "Bash · cargo flamegraph --bench export"], 440, "89% of export time is in normalize_normals; it recomputes per face."),
    mkAgent("ag3d8", "Explore", "Check the keymap for conflicts", true, ["Read · src/ui/keymap.rs", "Grep · KM_PRESS"], 400, "No conflicts with Blender's default keymap."),
    mkAgent("ag3d9", "general-purpose", "Write the add-on manifest", true, ["Write · blender_manifest.toml", "Bash · blender --command extension validate"], 360, "Manifest validates; permissions limited to files."),
    mkAgent("ag3d10", "Explore", "List deprecated bmesh calls", true, ["Grep · bmesh.ops", "Read · src/mesh/edit.rs", "Grep · bm.faces.ensure_lookup_table"], 320, "Three calls change in 4.2; patch list is in the notes."),
    mkAgent("ag3d11", "general-purpose", "Port the icon set to SVG", true, ["Glob · assets/icons/*.png", "Bash · inkscape --export-type=svg", "Write · assets/icons/index.json"], 280, "Converted 38 icons; two needed a manual trace."),
    mkAgent("ag3d12", "Explore", "Audit the preferences panel", true, ["Read · src/ui/prefs.rs", "Grep · AddonPreferences"], 200, "Preferences panel is fine; one label is untranslated."),
  );
  for (const a of ag3.agents) ag3.activity.push(act("agent", `Agent · ${a.description}`, now - 200_000));
  {
    let t0 = 0;
    const cursor: Record<string, number> = { ag3d1: 4, ag3d2: 3, ag3d3: 5, ag3d4: 2 };
    const due: Record<string, number> = { ag3d1: 1500, ag3d2: 2500, ag3d3: 3500, ag3d4: 4500 };
    const gap: Record<string, number> = { ag3d1: 2600, ag3d2: 3100, ag3d3: 2300, ag3d4: 2000 };
    setInterval(() => {
      // The clock starts once the startup scan has filled this session in.
      if (!t0) {
        if (scanned(live.find((l) => l.s === ag3)!) === "full") t0 = Date.now();
        return;
      }
      const el = Date.now() - t0;
      let changed = false;
      for (const a of ag3.agents) {
        const steps = AGENT_STEPS[a.id];
        if (a.finished || !steps || el < due[a.id]) continue;
        const t = Date.now();
        // The UV agent wraps up about 16 s in; the glTF one fails about 34 s in.
        if (a.id === "ag3d1" && el > 16_000) {
          a.finished = true;
          a.current = null;
          a.activity.push(act("tool", "Bash · cargo test uv::", t), act("text", "Unwrap now respects seam angles and image textures load through the sampler cache; 31 tests pass.", t + 1000));
          ag3.activity.push(act("text", "Subagent finished: UV unwrap and image textures.", t));
          changed = true;
          continue;
        }
        // The polish agent is stopped by the person about 24 s in.
        if (a.id === "ag3d4" && el > 24_000) {
          a.finished = true;
          a.current = null;
          a.activity.push(act("error", "Interrupted by user", t));
          ag3.activity.push(act("text", "Subagent stopped: App polish fixes.", t));
          changed = true;
          continue;
        }
        if (a.id === "ag3d3" && el > 34_000) {
          a.finished = true;
          a.current = null;
          a.activity.push(act("error", "Could not read the KHR_materials_variants spec: 404 Not Found", t));
          ag3.activity.push(act("text", "Subagent failed: glTF import and modifier panel.", t));
          changed = true;
          continue;
        }
        let next = steps[cursor[a.id] % steps.length];
        cursor[a.id]++;
        const failed = next.startsWith("!");
        if (failed) next = next.slice(1);
        a.current = next;
        a.activity.push(parseStep(next, t));
        if (failed) a.activity.push({ ts: hhmmss(t + 1000), kind: "error", text: "test curves::bezier::split_at_cusp failed: left 3, right 4", step: true });
        a.tokens.output += 160 + Math.floor(Math.random() * 260);
        a.tokens.input += 700;
        due[a.id] = el + gap[a.id] + Math.random() * 1200 + (failed ? 1200 : 0);
        changed = true;
      }
      ag3.updated = Date.now();
      if (changed) emitSessions();
    }, 500);
  }

  // A session that started two live child jobs (and has one that crashed): the Agents panel lists them too.
  const lightId = AGENTS_JOBS_ID;
  const lightSession = add(
    session({
      provider: "claude",
      id: lightId,
      cwd: p3d,
      title: "Bake the lighting rig",
      status: "idle",
      pid: 40601,
      background_tasks: true,
      tokens: tok(52_000, 7_400, 70_000),
      activity: history("pixel", ["Bake the three light probes in the background and tell me which ones fail"], now - 5 * 60_000, 1, 4),
      updated: now - 30_000,
    }),
    "pixel",
  );
  const lightScratch = `/private/tmp/claude-501/-Users-you-code-project-3d/${lightId}/scratchpad/jobs`;
  const lj0 = add(session({ provider: "claude", id: "lightjob0", cwd: lightScratch, project: p3d, origin: "automation", parent: lightId, title: "Bake the hall probe", status: "busy", pid: 40610, current: "Bash · blender -b rig.blend -f 1", tokens: tok(14_000, 2_100, 30_000), activity: history("coool", ["Bake the hall probe"], now - 40_000, 1, 4), updated: now - 2000 }), "coool", 4);
  {
    let n = 4;
    setInterval(() => {
      if (lj0.status !== "busy") return;
      const t = Date.now();
      if (n >= WORK.coool.length) {
        lj0.status = "ended";
        lj0.current = null;
        lj0.activity.push(act("text", "Baked the hall probe: 12.4 MB written to probes/hall.exr.", t));
      } else {
        const a = parseStep(WORK.coool[n++], t);
        lj0.activity.push(a);
        lj0.current = a.kind === "tool" ? a.text : "thinking…";
        lj0.tokens.output += 180;
      }
      lj0.updated = t;
      emitSessions();
    }, 2600);
  }
  add(session({ provider: "codex", id: "lightjob1", cwd: lightScratch, project: p3d, origin: "automation", parent: lightId, title: "Bake the garden probe", status: "idle", pid: 40611, waiting_for: "Allow Bash: blender -b garden.blend -f 1", tokens: tok(9_000, 1_300, 22_000), activity: history("pixel", ["Bake the garden probe"], now - 90_000, 1, 5), updated: now - 20_000 }), "pixel", 5);
  add(session({ provider: "claude", id: "lightjob2", cwd: lightScratch, project: p3d, origin: "automation", parent: lightId, title: "Bake the attic probe", status: "ended", tokens: tok(11_000, 1_700, 24_000), activity: [...history("pixel", ["Bake the attic probe"], now - 240_000, 1, 4), act("error", "blender exited with code 139: segfault in the denoiser", now - 200_000)], updated: now - 200_000 }), "pixel");

  // Background shells (APP_SPEC "Background shells"): the lighting session runs two beside its jobs,
  // and a session with shells only (no subagents, no jobs) serves the docs site.
  const tmpTasks = (sid: string, id: string) => `/private/tmp/claude-501/-Users-you-code-project-3d/${sid}/tasks/${id}.output`;
  lightSession.shells = [
    { pid: 40620, command: "cargo watch -x 'test -p rig'", description: "Re-run the rig tests on change", started: now - 143_000, cpu: 14, background: true, output: tmpTasks(lightId, "b4k2"), tail: ["   Compiling rig v0.3.1 (/Users/you/code/project-3d/rig)", "    Finished `test` profile [unoptimized] in 4.21s", "test result: ok. 48 passed; 0 failed; 0 ignored"] },
    { pid: 40624, command: "until [ -f probes/attic.exr ]; do sleep 5; done; echo attic baked", description: "Wait for the attic probe", started: now - 312_000, cpu: 0, idle_loop: true, background: true, output: tmpTasks(lightId, "b9q1"), tail: [] },
  ];
  const shellsId = AGENTS_SHELLS_ID;
  const docs = add(
    session({
      provider: "claude",
      id: shellsId,
      cwd: `${HOME}/code/relay-docs`,
      title: "Preview the docs site",
      status: "idle",
      pid: 40700,
      background_tasks: true,
      tokens: tok(21_000, 3_100, 31_000),
      activity: history("coool", ["Start the docs dev server and the link checker in the background"], now - 8 * 60_000, 1, 3),
      updated: now - 60_000,
    }),
    "coool",
  );
  docs.shells = [
    { pid: 40710, command: "pnpm dev --port 4321", description: "Docs dev server", started: now - 7 * 60_000 - 12_000, cpu: 2, background: true, output: tmpTasks(shellsId, "bd01"), tail: ["  VITE v6.2.0  ready in 412 ms", "  ➜  Local:   http://localhost:4321/", "  [hmr] /guide/install.md updated"] },
    { pid: 40716, command: "npx linkinator http://localhost:4321 --recurse --silent", started: now - 95_000, cpu: 31, background: true, output: tmpTasks(shellsId, "bd02"), tail: ["[200] /guide/install", "[200] /guide/agents", "[404] /guide/old-shells (from /changelog)"] },
    { pid: 40722, command: "while ! curl -sf localhost:4321/health >/dev/null; do sleep 2; done", description: "Wait for the server", started: now - 6 * 60_000, cpu: 0, idle_loop: true, background: true },
  ];
  {
    // The link checker prints a line now and then; the dev server reloads once in a while.
    let n = 0;
    const pages = ["/guide/sessions", "/guide/shells", "/reference/hub", "/reference/stop", "/blog/launch", "/guide/themes"];
    setInterval(() => {
      const lc = docs.shells?.find((x) => x.pid === 40716);
      if (!lc) return;
      lc.tail = [...(lc.tail ?? []), `[200] ${pages[n++ % pages.length]}`].slice(-3);
      lc.cpu = 25 + ((n * 7) % 15);
      docs.updated = Date.now();
      emitSessions();
    }, 1800);
  }

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
      .map(([l, st]) => (st === "cheap" ? cheap(structuredClone(l.s)) : { ...decorate(structuredClone(l.s), l), loaded: true }))
      // Like the backend: whatever coool runs is coool's.
      .map((s) => (s.chat != null || s.managed !== null ? { ...s, origin: "coool" as const } : s));
    // Like the backend: a parent counts its live child runs.
    for (const s of sessions) s.live_children = sessions.filter((c) => c.parent === s.id && c.status !== "ended").length;
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
      show_automation: showAutomation,
    };
  };
  // Like the Tauri backend (lib/backend.ts): unchanged sessions keep their object identity across payloads.
  const merge = new SessionsMerge();
  const emitSessions = () => {
    const s = merge.full(snapshot()) ?? snapshot();
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
    // Strips bracketed-paste markers (ESC [200~ / ESC [201~): the control character is the point.
    // oxlint-disable-next-line no-control-regex
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
  if (location.search.includes("checkpoints=demo")) void import("./mockCheckpoints").then((m) => m.runCheckpointsDemo(newChat("claude", coool, {}, 0))); // see mockCheckpoints.ts
  if (location.search.includes("plan=chat")) void import("./mockPlan").then((m) => m.runPlanChat(newChat("claude", coool, {}, 0))); // see mockPlan.ts
  if (location.search.includes("steer=demo")) void import("./mockPlan").then((m) => m.runSteerDemo(newChat("claude", coool, {}, 0))); // see mockPlan.ts
  if (location.search.includes("agents=stop")) {
    // `?agents=stop`: a chat whose turn the person stops while a step runs (see lib/agentsDemo.ts).
    const c = newChat("claude", `${HOME}/code/stop-demo`, {}, 0);
    c.always.add("Bash");
    c.always.add("Edit");
    setTimeout(() => c.send("Add a slash command menu to the chat composer"), 1500);
    let seen = 0;
    const iv = setInterval(() => {
      if (c.runningTool && ++seen === 3) {
        clearInterval(iv);
        c.interrupt();
      }
    }, 600);
  }
  if (location.search.includes("agents=chat")) void import("./mockAgents").then((m) => m.runAgentsChat(newChat("claude", `${HOME}/code/blender-addon`, {}, 0))); // see mockAgents.ts
  if (location.search.includes("md=demo")) void import("./mockPlan").then((m) => m.runMdDemo(newChat("claude", coool, {}, 0))); // see mockPlan.ts

  const insights: InsightsStatus = readInsights();
  const saveInsights = () => {
    try {
      localStorage.setItem(INSIGHTS_KEY, JSON.stringify({ enabled: insights.enabled, has_key: insights.has_key }));
    } catch {}
  };
  const decorate = (s: Session, l: Live | undefined): Session => {
    // The relay demo flags "Needs you" on its own, insights on or off.
    if (l?.cycle !== undefined && s.status === "idle" && l.cycle % 15 >= 10) return { ...s, insight: { headline: s.title, needs_you: "Asked whether to drop events older than 24h", generated_ms: s.updated } };
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
      if (s.background_tasks || s.id === AGENTS_DEMO) continue; // the demo parents wait for their jobs / agents
      if (s.parent) {
        // Background jobs: keep working; the first one sometimes waits for an approval.
        if (s.id === "job0") {
          const waiting = Math.floor(t / 9000) % 3 === 2;
          const was = !!s.waiting_for;
          s.waiting_for = waiting ? "permission to run `rm -rf renders/tmp`" : null;
          s.status = waiting ? "idle" : "busy";
          if (was !== waiting) changed = true;
        }
        if (s.status === "busy" && Math.random() < 0.3) {
          s.current = rnd(["Bash · blender -b scene.blend -a", "Read · renders/frame_0042.png", "thinking…"]);
          s.updated = t;
          changed = true;
        }
        continue;
      }
      if (l.cycle !== undefined) {
        // 0-4 working, 5-9 waiting, 10-14 waiting on the person.
        const before = Math.floor((l.cycle % 15) / 5);
        l.cycle++;
        const phase = Math.floor((l.cycle % 15) / 5);
        if (phase !== before) {
          s.status = phase === 0 ? "busy" : "idle";
          s.current = phase === 0 ? "thinking…" : null;
          s.updated = t;
          changed = true;
        }
        continue;
      }
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
    async stopShell(pid) {
      await delay(150);
      const l = live.find((x) => x.s.shells?.some((sh) => sh.pid === pid));
      if (!l) throw new Error("that process is not a background shell of a live session");
      l.s.shells = l.s.shells!.filter((sh) => sh.pid !== pid);
      if (!l.s.shells.length) l.s.background_tasks = false;
      l.s.updated = Date.now();
      emitSessions();
    },
    async shellsFocus() {},
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
    async chatSteer(id, text, now) {
      const c = chats[id];
      if (!c) throw new Error("no such chat");
      if (location.search.includes("steer=local")) throw new NotAvailable("chat_steer"); // exercise the client-side fallback
      return c.steer(text, now);
    },
    async chatSteerCancel(id, noteId) {
      chats[id]?.steerCancel(noteId);
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
    async setShowAutomation(enabled) {
      showAutomation = enabled;
      try {
        localStorage.setItem(SHOW_AUTOMATION_KEY, enabled ? "1" : "0");
      } catch {}
      emitSessions();
    },
  };
}
