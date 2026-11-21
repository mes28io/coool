// Built-in mock data source for running the UI in a plain browser.
// Realistic sessions across several projects that change over time:
// statuses flip, steps arrive, subagents run, and coool-run sessions get a
// fake terminal stream. Also the demo for coool.sh.

import { mockCtx } from "./mockChatContext";
import { mockExplain, runWhyDemo } from "./mockWhy";
import { NotAvailable, type Backend, type ChatBatch, type PtyChunk } from "./backend";
import { AGENTS_DEMO_ID, AGENTS_JOBS_ID, AGENTS_SHELLS_ID } from "./agentsDemo";
import { MockChat, mockModels, type ChatHost } from "./mockChat";
import { SessionsMerge } from "./sessionsMerge";
import { mockHints } from "./motion";
import { mockSettings } from "./mockSettings";
import { mockUpdate } from "./mockUpdate";
import { mockSim } from "./mockSim";
import { onMockBrowserActivity, presenceDemo, runPresenceDemo } from "./mockPresence";

const PRESENCE_PROMPTS = {
  iphone: "Open Settings > General > About on the iPhone and rename it to Ada's iPhone",
  mac: "Write the owl sentence in TextEdit on the Mac",
  browser: "Order three coffees for Ada Lovelace in the browser",
} as const;
import { MockGit } from "./mockGit";
import { committing, relPath } from "./mission";
import { mockMac } from "./mockMac";
import { mockName, mockRename } from "./mockTitles";
import { CTX_DEMO_ID, ctxAgentMap, ctxCompacting, ctxDemoMap } from "./mockContext";
import type { Activity, ActivityKind, Agent, ArtifactInfo, ChatEvent, InsightsStatus, PlanUsage, Provider, Session, Snapshot, Tokens, UsageWindow } from "./types";

const HOME = "/Users/you";
const enc = new TextEncoder();

const pad = (n: number) => String(n).padStart(2, "0");
const hhmmss = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const rnd = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const tok = (i = 0, o = 0, c = 0): Tokens => ({ input: i, cached: Math.floor(i * 3.2), output: o, context: c, turn_output: Math.floor(o / 5), total: c + o });

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
    'Bash · git add -A && git commit -m "Sidebar rows glide with layout animations"',
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
    'Bash · git commit -m "Refill the token bucket continuously"',
    "Bash · git push origin rate-limit",
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
    'Bash · git commit -m "Shadow cascade on the wgpu 26 pipeline"',
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
    "mcp__coool-device__pilot_run · Turn on airplane mode, add a note, and check the sync banner",
    'Bash · git commit -m "Replay offline mutations in order"',
    "text:Build and tests pass. Mutations made offline now replay in order once the device reconnects.",
  ],
};

// project-3d: the lighting rig's probe bakes and the add-on milestone.
WORK.p3d = [
  "Read · ~/code/project-3d/rig/probes.py",
  "Grep · bake_probe",
  "Edit · ~/code/project-3d/rig/probes.py",
  "Bash · blender -b rig.blend -P rig/bake.py -- --probe hall",
  "Write · ~/code/project-3d/probes/hall.json",
  "text:The hall probe is baked; writing its irradiance grid next to the scene.",
];

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
  /** Ticks left on a `git commit` step (the commit lands when it reaches 0). */
  hold?: number;
  /** Files edited since the last commit (its file chips). */
  edited?: string[];
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

/** Mission control's demo projects, in the order the `coool.mock.projects` knob keeps them. */
const MC_PROJECTS = ["coool", "atlas-api", "project-3d", "pixelforge", "notes-ios", "relay", "relay-docs", "pocket-ledger"];
function mockProjectCap(): number {
  try {
    const n = Number(localStorage.getItem("coool.mock.projects"));
    return n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** The file-overlap demo sessions (see "File overlap between live agents" below): never stepped. */
const OVERLAP_DEMO = new Set(["ov1a01", "ov1b02", "ov2a03", "ov2b04"]);
const MOCK_ARTIFACT_URL = "https://claude.ai/artifact/9xQmT4kVdR2wLpE7";

/** Settings > Devices > Agent permissions in the mock: what two projects allowed for good. */
let deviceGrants: { project: string; devices: ("browser" | "iphone" | "mac")[]; sites: string[] }[] = [
  { project: "/Users/you/code/atlas", devices: ["browser", "iphone"], sites: ["localhost", "stripe.com"] },
  { project: "/Users/you/code/notes-app", devices: ["mac"], sites: [] },
];

export function mockBackend(): Backend {
  // Stable across reloads (refreshed every 6h) so "seen" state, which compares session times, survives a reload in the browser demo.
  const now = (() => {
    try {
      const v = Number(localStorage.getItem("coool.mockEpoch"));
      if (v > 0 && Date.now() - v < 6 * 3600_000) return v;
      localStorage.setItem("coool.mockEpoch", String(Date.now()));
    } catch {
      /* private mode */
    }
    return Date.now();
  })();
  let showAutomation = (() => {
    try {
      return localStorage.getItem(SHOW_AUTOMATION_KEY) === "1";
    } catch {
      return false;
    }
  })();
  const live: Live[] = [];
  const git = new MockGit(HOME);
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
      // A 200k-window model, so the context map demo (mockContext.ts) reaches the warning tone before it compacts.
      model: "claude-sonnet-4-5-20250929",
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
  // The owner's real Mission control, reproduced (APP_SPEC "Mission control"): an orchestrator session whose
  // agents work in worktrees inside the project and in a temp scratchpad, delete their scratch files, commit
  // through a heredoc, and get merged with long subjects; two of its agents (started turns ago) and two
  // background shells still run, so its row says "2 agents, 2 jobs working" and shows that fan-out.
  {
    const S = "/private/tmp/claude-501/-Users-you-code-coool/7d2e41/scratchpad";
    const wt = (a: string) => `~/code/coool/.claude/worktrees/agent-${a}`;
    const t0 = now - 70 * 60_000;
    const mins = (m: number) => t0 + m * 60_000;
    const orch = add(
      session({
        provider: "claude",
        id: "f4570d",
        cwd: coool,
        title: "Claude Code fast mode credits",
        status: "busy",
        pid: 41180,
        tokens: tok(91_000, 22_000, 148_000),
        current: "Bash · until [ -s rec/done ]; do sleep 5; done",
        activity: [
          act("prompt", "Run the design pass on Mission control and the Mac panel in parallel", mins(0)),
          act("agent", "Agent · Mac panel: sandbox macOS VM", mins(1)),
          act("agent", "Agent · Settings page", mins(1)),
          act("tool", `Bash · git merge --no-ff worktree-agent-a91c -m "Merge: Mac panel (sandbox macOS VM) and the mac_* tools in coool-device"`, mins(26)),
          act("tool", "Bash · git worktree remove .claude/worktrees/agent-a91c --force && git branch -d worktree-agent-a91c", mins(26.5)),
          act("tool", `Bash · git merge --no-ff worktree-agent-b07e -m "Merge: full Settings (general, notifications, appearance, shortcuts, models)"`, mins(31)),
          act("tool", "Bash · git worktree remove .claude/worktrees/agent-b07e --force && git branch -d worktree-agent-b07e", mins(31.5)),
          act("tool", `Write · ${S}/rec/bb-br.png`, mins(40)),
          act("tool", `Bash · rm -rf "$S/bb-br" "$S/bb-br2" "$S/bb-br3"`, mins(55)),
          act("tool", `Bash · cd ${S} && rm -rf br-dark br-light`, mins(60)),
          act("tool", "Bash · rm -f ip-full.png", mins(62)),
          act("prompt", "Mission control: one project at a time", mins(64)),
          act("tool", "Edit · ~/code/coool/app/src/components/MissionControl.tsx", mins(66)),
          act("tool", "Edit · ~/code/coool/docs/APP_SPEC.md", mins(67)),
          act("tool", "Bash · git add -A && git commit -q -F - <<'EOF' Mission control: one project at a time; its header switches between the projects with live agents Co-Authored-By: Claude EOF", mins(68)),
          act("tool", "Edit · ~/code/coool/app/src/components/Sidebar.tsx", mins(69)),
          act("tool", "Bash · until [ -s rec/done ]; do sleep 5; done", mins(69.5)),
        ],
        updated: now - 3000,
      }),
      "coool",
    );
    const agent = (id: string, description: string, finished: boolean, rows: [string, number][], kind = "general-purpose"): Agent => ({
      id,
      kind,
      description,
      finished,
      current: finished ? null : (rows[rows.length - 1]?.[0] ?? null),
      tokens: tok(18_000, 3_000, 40_000),
      activity: rows.map(([text, m]) => act("tool", text, mins(m))),
    });
    // Two agents that wrote and committed in their worktrees (then merged), and scratch everywhere.
    const macFiles = ["app/src/components/MacPanel.tsx", "app/src-tauri/src/device/mac.rs", "app/src-tauri/src/device/vm.rs", "app/src-tauri/build.rs", "crates/device/src/mac.rs", "crates/device/src/lib.rs"];
    orch.agents.push(
      agent("a91c", "Mac panel: sandbox macOS VM", true, [
        ...macFiles.map((f, i): [string, number] => [`Write · ${wt("a91c")}/${f}`, 2 + i]),
        ...Array.from({ length: 14 }, (_, i): [string, number] => [`Write · ${S}/mac/shot-${i}.png`, 9 + i * 0.5]),
        [`Bash · cd ${wt("a91c")} && git add -A && git commit -q -m "Sandbox Mac: a Virtualization.framework VM in the right panel"`, 24],
      ]),
      agent("b07e", "Settings page", true, [
        ...["app/src/components/SettingsPage.tsx", "app/src/lib/prefs.ts", "app/src/lib/mockSettings.ts"].map((f, i): [string, number] => [`Edit · ${wt("b07e")}/${f}`, 3 + i]),
        [`Write · ${S}/settings/check.mjs`, 10],
        [`Bash · cd ${wt("b07e")} && git commit -qam "Settings: General, Notifications, shortcuts and models"`, 29],
      ]),
      // Many reviewers writing notes to the scratchpad only (never the project).
      ...Array.from({ length: 6 }, (_, k) =>
        agent(`rv${k}`, `Review pass ${k + 1}`, true, [
          [`Write · ${S}/review/${k}/notes.md`, 33 + k],
          [`Write · ${S}/review/${k}/shots.html`, 33.5 + k],
          [`Bash · rm -rf ${S}/review/${k}/tmp`, 34 + k],
        ], "Explore"),
      ),
      // Still running, started turns ago: uncommitted edits in their worktrees.
      agent("c3d1", "Ledger: drop noise rows", false, [
        [`Edit · ${wt("c3d1")}/app/src/lib/mission.ts`, 20],
        [`Edit · ${wt("c3d1")}/app/src/lib/mission.test.ts`, 22],
        [`Edit · ${wt("c3d1")}/app/src/components/ChangeLedger.tsx`, 50],
        [`Edit · ${wt("c3d1")}/app/src/lib/mission.ts`, 66],
        ["Bash · node --test src/lib/mission.test.ts", 69],
      ]),
      agent("c3d2", "Trail: one row rhythm", false, [
        [`Edit · ${wt("c3d2")}/app/src/components/CommitTrail.tsx`, 21],
        [`Edit · ${wt("c3d2")}/app/src/components/MissionCard.tsx`, 48],
        [`Write · ${S}/mc/shot.mjs`, 60],
        ["Bash · node shot.mjs after", 69],
      ]),
    );
    orch.shells = [
      { pid: 41190, command: "until [ -s rec/done ]; do sleep 5; done", description: "Wait for the recording", started: now - 4 * 60_000, cpu: 0, idle_loop: true, background: true },
      { pid: 41191, command: "pnpm -C app exec vite --port 1490", description: "Mock server for screenshots", started: now - 9 * 60_000, cpu: 1.2, background: true },
    ];
  }
  // Artifacts (Claude Code's Artifact tool): one page published three times, and one whose local copy is gone.
  {
    const scratch = `/private/tmp/claude-501/-Users-you-code-coool/3f1c9e/scratchpad/guide`;
    const guide = (version: number): ArtifactInfo => ({
      url: "https://claude.ai/artifact/9xQmT4kVdR2wLpE7",
      version,
      file_path: `${scratch}/onboarding.html`,
      files: { "diagram.svg": `${scratch}/diagram.svg` },
      // Like Claude Code: the icon word comes with the first publish only.
      ...(version === 1 ? { icon: "wrench" } : {}),
      title: "Onboarding guide: running agents",
    });
    const step = (text: string, t: number, artifact?: ArtifactInfo): Activity => ({ ...act("tool", text, t), ...(artifact ? { artifact } : {}) });
    const t0 = now - 50 * 60_000;
    add(
      session({
        provider: "claude",
        id: "art01e",
        cwd: coool,
        title: "Write the onboarding guide page",
        status: "ended",
        tokens: tok(31_000, 6_400, 52_000),
        activity: [
          act("prompt", "Make a one-page onboarding guide for running agents in coool, with a diagram, and publish it", t0),
          step("Artifact · quickstart", t0 + 9_000),
          step(`Write · ${scratch}/onboarding.html`, t0 + 40_000),
          step(`Write · ${scratch}/diagram.svg`, t0 + 52_000),
          step("Artifact · scratchpad/guide/onboarding.html", t0 + 70_000, guide(1)),
          act("text", "Published the guide. It has the three steps and the diagram of a session's lifecycle.", t0 + 75_000),
          act("prompt", "Make the steps numbered and add a dark theme", t0 + 6 * 60_000),
          step(`Edit · ${scratch}/onboarding.html`, t0 + 6 * 60_000 + 20_000),
          step("Artifact · scratchpad/guide/onboarding.html", t0 + 6 * 60_000 + 30_000, guide(2)),
          step(`Edit · ${scratch}/onboarding.html`, t0 + 6 * 60_000 + 50_000),
          step("Artifact · scratchpad/guide/onboarding.html", t0 + 6 * 60_000 + 60_000, guide(3)),
          act("text", "Updated: numbered steps, and the page follows the system theme.", t0 + 6 * 60_000 + 64_000),
          act("prompt", "Also publish last week's release notes page", t0 + 9 * 60_000),
          step("Artifact · scratchpad/notes/release.html", t0 + 9 * 60_000 + 20_000, {
            url: "https://claude.ai/artifact/R7nB2cYw8sKq",
            version: 1,
            file_path: "/private/tmp/claude-501/-Users-you-code-coool/0b77aa/scratchpad/notes/release.html",
            files: {},
            icon: "doc",
            title: "Release notes, week 46",
          }),
          act("text", "Published the release notes.", t0 + 9 * 60_000 + 24_000),
        ],
        updated: t0 + 9 * 60_000 + 24_000,
      }),
      "coool",
    );
  }
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
  // File overlap between live agents (APP_SPEC "Mission control", lib/mission.ts `overlaps`): two sessions with
  // uncommitted edits to the same file in atlas-api's own checkout (a clash), and two agents in separate
  // worktrees of coool changing the same file (a merge to come). They sit still (OVERLAP_DEMO in `tick`).
  {
    const step = (text: string, m: number) => (text.startsWith("text:") ? act("text", text.slice(5), now - m * 60_000) : act(text.includes(" · ") ? "tool" : "prompt", text, now - m * 60_000));
    const still = (p: Partial<Session> & Pick<Session, "provider" | "id" | "cwd">, rows: [string, number][]) =>
      add(session({ status: "idle", pid: 40_500 + live.length, tokens: tok(26_000, 4_800, 41_000), ...p, activity: rows.map(([t, m]) => step(t, m)), updated: now - rows[rows.length - 1][1] * 60_000 }), "atlas");
    still({ provider: "claude", id: "ov1a01", cwd: atlas, title: "Return 429 with a Retry-After header" }, [
      ["Return 429 with a Retry-After header when a key is over budget", 16],
      ["Read · ~/code/atlas-api/src/config.rs", 15.5],
      ["Edit · ~/code/atlas-api/src/config.rs", 14],
      ["Edit · ~/code/atlas-api/src/routes/search.rs", 13],
      ["text:Over-budget keys now get a 429 with Retry-After; the window comes from `RateConfig`.", 12.5],
    ]);
    still({ provider: "codex", id: "ov1b02", cwd: atlas, title: "Read limiter budgets from env" }, [
      ["Let the limiter budgets come from the environment, with the config file as fallback", 11],
      ["Edit · ~/code/atlas-api/src/config.rs", 9],
      ["Bash · cargo check", 8.5],
      ["text:`ATLAS_RATE_*` variables override the config file now. `cargo check` is clean.", 8],
    ]);
    const wt = (a: string, f: string) => `~/code/coool/.claude/worktrees/agent-${a}/${f}`;
    still({ provider: "claude", id: "ov2a03", cwd: `${coool}/.claude/worktrees/agent-7a1f`, project: coool, title: "Relative times in the sidebar" }, [
      ["Show relative times in the sidebar rows", 30],
      ["Edit · " + wt("7a1f", "app/src/lib/format.ts"), 27],
      ["Edit · " + wt("7a1f", "app/src/components/Sidebar.tsx"), 26],
      ['Bash · git add -A && git commit -m "Sidebar: relative times on hover"', 25],
      ["text:Committed in the worktree's branch; ready to merge.", 24.5],
    ]);
    still({ provider: "codex", id: "ov2b04", cwd: `${coool}/.claude/worktrees/agent-9c2e`, project: coool, title: "Durations in the Jobs panel" }, [
      ["Format job durations like the chat footer", 12],
      ["Edit · " + wt("9c2e", "app/src/lib/format.ts"), 10],
      ["Edit · " + wt("9c2e", "app/src/components/AgentsPanel.tsx"), 9],
      ["text:Durations read `4m 12s` everywhere now.", 8],
    ]);
  }
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
      activity: history("p3d", ["Split the milestone across four agents and report back when they finish"], now - 3 * 60_000, 1, 4),
      updated: now - 20_000,
    }),
    "pixel",
  );
  const HANDOFF: Record<string, string> = {
    ag3d1: "Make UV unwrapping respect seams over 60°, then wire image textures through the new sampler.\nRun cargo test uv:: and texture:: before reporting.",
    ag3d2: "Fix the curve-to-mesh crash on empty splines and port text objects to the glyph cache.",
    ag3d3: "Read the glTF importer and list what KHR_materials_variants needs; don't edit anything.",
    ag3d4: "Polish pass on the toolbar, tooltips and panel spacing from the design review notes.",
    ag3d5: "List every bpy.ops operator the add-on calls and since which Blender version each is stable.",
  };
  const mkAgent = (id: string, kind: string, description: string, finished: boolean, steps: string[], ageS: number, result?: string): Agent => ({
    id,
    kind,
    description,
    finished,
    current: finished ? null : steps[0],
    // `total`: Claude Code's count for a subagent (latest context plus output), what its context bar shows.
    tokens: { ...tok(9_000 + steps.length * 700, 1_200 + steps.length * 300, 16_000), total: id === "ag3d2" ? 842_000 : 14_000 + steps.length * 11_000 },
    // The lead's handoff is the subagent's first prompt.
    activity: [act("prompt", HANDOFF[id] ?? description, now - ageS * 1000 - 1000), ...steps.map((x, i) => parseStep(x, now - (ageS - i * 6) * 1000)), ...(result ? [act("text", result, now - (ageS - steps.length * 6) * 1000)] : [])],
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
        ag3.tokens.turn_output = (ag3.tokens.turn_output ?? 0) + 120;
        a.tokens.input += 700;
        a.tokens.total = (a.tokens.total ?? 0) + 900;
        due[a.id] = el + gap[a.id] + Math.random() * 1200 + (failed ? 1200 : 0);
        changed = true;
      }
      ag3.updated = Date.now();
      if (changed) emitSessions();
    }, 500);
  }

  // A fan-out (Mission control's grid): one job handed to 24 agents at once, one per endpoint. They
  // finish over ~40 s (two fail), the session reports, rests, and hands out the next round.
  const fan = add(
    session({
      provider: "claude",
      id: "f4a0e124",
      cwd: atlas,
      title: "Migrate every endpoint to the v3 error format",
      status: "busy",
      pid: 39901,
      tokens: tok(58_000, 9_400, 84_000),
      activity: [],
      updated: now,
    }),
    "atlas",
  );
  {
    const EP = ["search", "suggest", "users", "users_me", "sessions", "tokens", "orgs", "org_members", "invites", "billing", "invoices", "plans", "webhooks", "events", "exports", "imports", "files", "uploads", "audit", "health", "metrics", "flags", "keys", "limits"];
    const STEPS = (ep: string) => [`Read · ~/code/atlas-api/src/routes/${ep}.rs`, "Grep · ApiError::", `Edit · ~/code/atlas-api/src/routes/${ep}.rs`, `Edit · ~/code/atlas-api/tests/${ep}_errors.rs`, `Bash · cargo test -p atlas-api ${ep}::errors`];
    const plan = new Map<string, { end: number; next: number; fail: boolean; k: number; ep: string }>();
    let round = 0;
    let rest = 0;
    let t0 = 0;
    const launch = () => {
      const t = Date.now();
      round++;
      fan.status = "busy";
      const prompt = round === 1 ? "Migrate every endpoint to the v3 error format, one agent per endpoint" : `Round ${round}: re-run the migration on the endpoints that changed since`;
      fan.activity.push(act("prompt", prompt, t - 1500));
      fan.last_prompt = prompt;
      fan.agents = [];
      plan.clear();
      const failing = new Set([3 + (round % 5), 14 + (round % 7)]);
      EP.forEach((ep, i) => {
        const id = `fan${round}x${i}`;
        const model = i % 3 === 0 ? "claude-haiku-5-5" : "claude-sonnet-5-5";
        fan.agents.push({ id, kind: "general-purpose", description: `Migrate /v2/${ep.replace("_", "/")}`, finished: false, current: STEPS(ep)[0], tokens: tok(3_000, 200, 8_000), activity: [act("tool", STEPS(ep)[0], t)], model, models: [{ model, input: 3_000, cached: 9_000, output: 200, messages: 1 }] });
        fan.activity.push(act("agent", `Agent · Migrate /v2/${ep}`, t));
        plan.set(id, { end: t + 5_000 + ((i * 7919) % 36) * 1000 + Math.random() * 3000, next: t + 1500 + Math.random() * 2000, fail: failing.has(i), k: 1, ep });
      });
      fan.current = "Agent · Migrate /v2/search";
      fan.updated = t;
    };
    setInterval(() => {
      if (!t0) {
        if (scanned(live.find((l) => l.s === fan)!) !== "full") return;
        t0 = Date.now();
        launch();
        emitSessions();
        return;
      }
      const t = Date.now();
      if (rest) {
        if (t > rest) {
          rest = 0;
          launch();
          emitSessions();
        }
        return;
      }
      let changed = false;
      for (const a of fan.agents) {
        const p = plan.get(a.id);
        if (a.finished || !p) continue;
        if (t >= p.end) {
          a.finished = true;
          a.current = null;
          a.activity.push(p.fail ? act("error", `cargo test -p atlas-api ${p.ep}::errors failed: expected 422, got 500`, t) : act("text", `/v2/${p.ep} returns v3 errors; 6 tests pass.`, t));
          changed = true;
        } else if (t >= p.next) {
          const step = STEPS(p.ep)[p.k++ % 5];
          a.current = step;
          a.activity.push(act("tool", step, t));
          a.tokens.output += 140 + Math.floor(Math.random() * 220);
          a.tokens.total = (a.tokens.total ?? 0) + 1400;
          p.next = t + 1800 + Math.random() * 2600;
          changed = true;
        }
      }
      if (fan.agents.every((a) => a.finished)) {
        const failed = fan.agents.filter((a) => a.activity[a.activity.length - 1]?.kind === "error").length;
        fan.activity.push(act("text", `Migrated ${fan.agents.length - failed} of ${fan.agents.length} endpoints to v3 errors; ${failed} need a look.`, t));
        fan.status = "idle";
        fan.current = null;
        rest = t + 22_000;
        changed = true;
      }
      if (changed) {
        fan.updated = t;
        fan.tokens.output += 300;
        emitSessions();
      }
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
      activity: history("p3d", ["Bake the three light probes in the background and tell me which ones fail"], now - 5 * 60_000, 1, 4),
      updated: now - 30_000,
    }),
    "pixel",
  );
  const lightScratch = `/private/tmp/claude-501/-Users-you-code-project-3d/${lightId}/scratchpad/jobs`;
  const lj0 = add(session({ provider: "claude", id: "lightjob0", cwd: lightScratch, project: p3d, origin: "automation", parent: lightId, title: "Bake the hall probe", status: "busy", pid: 40610, current: "Bash · blender -b rig.blend -f 1", tokens: tok(14_000, 2_100, 30_000), activity: history("p3d", ["Bake the hall probe"], now - 40_000, 1, 4), updated: now - 2000 }), "coool", 4);
  {
    let n = 4;
    setInterval(() => {
      if (lj0.status !== "busy") return;
      const t = Date.now();
      if (n >= WORK.p3d.length) {
        lj0.status = "ended";
        lj0.current = null;
        lj0.activity.push(act("text", "Baked the hall probe: 12.4 MB written to probes/hall.exr.", t));
      } else {
        const a = parseStep(WORK.p3d[n++], t);
        lj0.activity.push(a);
        lj0.current = a.kind === "tool" ? a.text : "thinking…";
        lj0.tokens.output += 180;
        lj0.tokens.turn_output = (lj0.tokens.turn_output ?? 0) + 180;
      }
      lj0.updated = t;
      emitSessions();
    }, 2600);
  }
  // `?needs=demo`: a session in a terminal outside coool, blocked on its own permission prompt (the Needs you page's
  // "outside coool" item: what the transcript knows, no answer buttons).
  // `?why=demo`: a terminal wait that doesn't name its command (the transcript's words only, no AI read).
  if (typeof location !== "undefined" && location.search.includes("why=demo"))
    add(session({ provider: "claude", id: "termwait2", cwd: pixel, title: "File the crash as an issue", status: "idle", pid: 40_731, waiting_for: "permission to use the Linear tool (create issue)", tokens: tok(9_000, 1_400, 18_000), activity: history("pixel", ["File the shader crash as a Linear issue with the stack trace"], now - 50_000, 1, 4), updated: now - 50_000 }), "pixel", 98);
  if (typeof location !== "undefined" && location.search.includes("needs=demo"))
    add(session({ provider: "claude", id: "termwait1", cwd: pixel, title: "Clear the shader cache", status: "idle", pid: 40_720, waiting_for: "permission to run `rm -rf target/shader-cache`", tokens: tok(14_000, 2_100, 30_000), activity: history("pixel", ["Clear the shader cache, then rebuild the pipeline"], now - 70_000, 1, 6), updated: now - 70_000 }), "pixel", 99);
  add(session({ provider: "codex", id: "lightjob1", cwd: lightScratch, project: p3d, origin: "automation", parent: lightId, title: "Bake the garden probe", status: "idle", pid: 40611, waiting_for: "Allow Bash: blender -b garden.blend -f 1", tokens: tok(9_000, 1_300, 22_000), activity: history("p3d", ["Bake the garden probe"], now - 90_000, 1, 5), updated: now - 20_000 }), "pixel", 5);
  add(session({ provider: "claude", id: "lightjob2", cwd: lightScratch, project: p3d, origin: "automation", parent: lightId, title: "Bake the attic probe", status: "ended", tokens: tok(11_000, 1_700, 24_000), activity: [...history("p3d", ["Bake the attic probe"], now - 240_000, 1, 4), act("error", "blender exited with code 139: segfault in the denoiser", now - 200_000)], updated: now - 200_000 }), "pixel");

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
  const noNeeds = typeof location !== "undefined" && location.search.includes("needs=none");
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
  // `?usage=none` (nothing known), `?usage=error` (Claude not signed in), `?usage=stale` (old readings),
  // `?usage=limited` (Codex weekly limit hit, so a reset is worth it), `?usage=noresets` (no Codex reset credits),
  // `?usage=resetfail` (redeeming a reset fails). Redeeming in the mock spends nothing real.
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
      provider: "claude", plan: "Max 5x", source: "claude.get_usage", fetched_ms: fetched, stale, error: null, reset_credits: null, reset_credits_expire_ms: null,
      credits: { enabled: true, unlimited: false, balance: null, used: 20, limit: 50, used_percent: 40, currency: "USD", detail: "20.00 of 50.00" },
      windows: [
        win("session", "Current session", "session", usageMode === "warn" ? 80 : 91, t + (60 + 54) * 60_000, 300, { severity: usageMode === "warn" ? "warning" : "critical", binding: true }),
        win("weekly_all", "Weekly (all models)", "weekly", 24, nextMonday(), 10080, { severity: "normal", binding: false }),
        win("weekly_scoped:Fable", "Weekly (Fable)", "weekly", 10, nextMonday(), 10080, { severity: "normal", model: "Fable", binding: false }),
      ],
    };
    const codex: PlanUsage = {
      provider: "codex", plan: "Plus", source: "codex.app_server", fetched_ms: fetched, stale, error: null,
      reset_credits: usageMode === "noresets" ? 0 : 3, reset_credits_expire_ms: usageMode === "noresets" ? null : t + 12 * 24 * 3600_000,
      credits: { enabled: false, unlimited: false, balance: "0", used: null, limit: null, used_percent: null, currency: null, detail: null },
      windows:
        usageMode === "limited"
          ? [
              win("codex:primary", "5-hour", "session", 64, t + (3 * 60 + 12) * 60_000, 300),
              win("codex:secondary", "Weekly", "weekly", 100, t + (3 * 24 + 5) * 3600_000, 10080, { detail: "rate limit reached" }),
            ]
          : [
              win("codex:primary", "5-hour", "session", null, null, 300, { detail: "Reset since the last reading" }),
              win("codex:secondary", "Weekly", "weekly", 5, t + 26 * 3600_000, 10080),
            ],
    };
    if (usageMode === "error") return { claude: { ...claude, plan: null, windows: [], credits: null, error: "Not signed in" }, codex };
    return { claude, codex };
  };
  const usage = mkUsage();
  const resetKeys = new Set<string>();

  const snapshot = (): Snapshot => {
    if (!scan.started) return { sessions: [], pending: [], ptys: [], chats: [], loading: true };
    let sessions = live
      .map((l) => [l, scanned(l)] as const)
      .filter(([, st]) => st !== "hidden")
      .map(([l, st]) => (st === "cheap" ? cheap(structuredClone(l.s)) : { ...decorate(structuredClone(l.s), l), loaded: true }))
      // Like the backend: whatever coool runs is coool's.
      .map((s) => (s.chat != null || s.managed !== null ? { ...s, origin: "coool" as const } : s))
      // CHAT_SPEC "Session titles": the resolved title rides on every session.
      .map((s) => ({ ...s, name: mockName(s) }))
      // `?needs=none`: no terminal waits and no insight flags either.
      .map((s) => (noNeeds ? { ...s, waiting_for: null, insight: s.insight ? { ...s.insight, needs_you: null } : s.insight } : s));
    // Demo knob (Mission control's project tabs): `coool.mock.projects` = N keeps the live sessions of N projects;
    // 8 adds an eighth project.
    const cap = mockProjectCap();
    if (cap) {
      const keep = new Set(MC_PROJECTS.slice(0, cap));
      sessions = sessions.filter((s) => s.status === "ended" || keep.has((s.project || s.cwd).split("/").pop() ?? ""));
      if (cap >= 8) sessions.push(((x) => ({ ...x, name: mockName(x) }))(session({ provider: "codex", id: "pk8a01", cwd: `${HOME}/code/pocket-ledger`, title: "Import bank CSVs with column mapping", status: "idle", updated: Date.now() - 6 * 60_000, loaded: true })));
    }
    // Like the backend: a parent counts its live child runs.
    for (const s of sessions) s.live_children = sessions.filter((c) => c.parent === s.id && c.status !== "ended").length;
    const order = { busy: 0, idle: 1, ended: 2 } as const;
    sessions.sort((a, b) => order[a.status] - order[b.status] || b.updated - a.updated);
    const linked = new Set(sessions.map((s) => s.managed).filter((m) => m !== null));
    return {
      sessions,
      pending: ptys.filter((p) => p.running && !linked.has(p.id)).map((p) => p.id),
      ptys: ptys.map(({ id, provider, cwd, running, started }) => ({ id, provider, cwd, running, started })),
      chats: chats.map((c) => c.info()).filter((c) => !cap || MC_PROJECTS.slice(0, cap).includes((c.project || c.cwd).split("/").pop() ?? "")),
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
    // `?needs=none`: nothing waits on the person (the Needs you page's empty state): chats never ask.
    const c = new MockChat(chats.length, provider, cwd, host, flushChat, noNeeds ? { ...o, mode: "bypassPermissions" } : o);
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
  // A chat whose edit waits for the person: Mission control shows it inline (Allow / Deny).
  const chAtlas = newChat("claude", atlas, {}, 0);
  setTimeout(() => chAtlas.send("Make limiter budgets follow config reloads (review edits)"), 2600);
  // `?away=demo`: the person left 2h 14m ago (the store's seen marks say so), and a chat in pocket-ledger did
  // four turns meanwhile: one failed, one committed and pushed. Mission control shows "While you were away"
  // under Needs you; opening the chat shows the card where the person left (components/Away.tsx).
  if (location.search.includes("away=demo")) {
    const left = Date.now() - (2 * 60 + 14) * 60_000;
    const ch = newChat("claude", `${HOME}/code/pocket-ledger`, {}, 0);
    ch.always.add("Bash");
    void ch
      .seed(["Sketch the invoice data model"], left - 10 * 60_000)
      .then(() => ch.seed(["Add the invoice PDF route", "Run the migration tests, show me the error", "Link the PDF from the receipt email, then commit and push", "Tidy the README's setup section"], Date.now() - 12 * 60_000))
      .then(() => import("../store"))
      .then(({ useStore, APP_SEEN }) => {
        const st = useStore.getState();
        const key = ch.session ? `${ch.session.provider}:${ch.session.id}` : null;
        // Seen marks as if the person had the app, and this chat, on screen until they left.
        useStore.setState({ seen: { ...st.seen, at: { ...st.seen.at, [APP_SEEN]: left, ...(key ? { [key]: left } : {}) } } });
        st.touchSeen([APP_SEEN]);
      });
  }
  // `?resume=fail`: a Codex chat resumed from a thread saved by a newer Codex than the installed one: it ends as not
  // opened, the prompt typed meanwhile not sent, the chips disabled (mockChat.ts `failOpen`). Opened on load.
  if (location.search.includes("resume=fail")) {
    const c = new MockChat(chats.length, "codex", `${HOME}/code/relay`, host, flushChat, { resume: "019a4c2e-7d1b-7c3e-9f00-5b2a1d6e8c41" });
    chats.push(c);
    chatReady.set(c.id, Promise.resolve());
    void c.failOpen("hey");
    void import("../store").then(({ useStore }) => setTimeout(() => useStore.getState().open({ kind: "chat", id: c.id }), 300));
  }
  // `?needs=demo`: more for the Needs you page (the notes chat above already asks to run something, atlas to edit):
  // a chat with a pending question, one whose Browser step the device gate asks about, and a plan to approve.
  if (location.search.includes("needs=demo")) {
    const cq = newChat("claude", `${HOME}/code/atlas`, {}, 0);
    setTimeout(() => cq.send("Which retry approach should I choose? ask me"), 1600);
    const cd = newChat("claude", `${HOME}/code/fieldnotes-web`, {}, 0);
    setTimeout(() => cd.send("Check the sign-in page's error states in the Browser (device gate)"), 1900);
    const cp = newChat("claude", `${HOME}/code/notes-ios`, {}, 0);
    setTimeout(() => cp.send("Plan the retry change first (plan mode)"), 2200);
  }
  // `?why=demo`: requests that show each state of "What this does and why" (lib/mockWhy.ts).
  if (location.search.includes("why=demo")) runWhyDemo((cwd) => newChat("claude", cwd, {}, 0), HOME);
  // `?ideas=demo`: agent lanes with half an hour of history, the running-now pill, hover cards, a question card with
  // number keys and Later, and a Risky permission request (lib/mockIdeas.ts).
  if (location.search.includes("ideas=demo")) void import("./mockIdeas").then((m) => m.runIdeasDemo((cwd) => newChat("claude", cwd, {}, 0), `${HOME}/code/harbor`));
  if (location.search.includes("changes=")) void import("./mockChanges").then((m) => m.runChangesDemo(newChat("claude", `${HOME}/code/invoices`, {}, 0), `${HOME}/code/invoices`)); // see mockChanges.ts
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
  if (location.search.includes("context=")) void import("./mockChatContext").then((m) => m.ctxDemo() && m.runContextDemo((cwd) => newChat("claude", cwd, { model: "claude-opus-5-5" }, 0))); // see mockChatContext.ts
  if (location.search.includes("ladder=demo")) void import("./mockLadder").then((m) => m.runLadderChat(newChat("claude", `${HOME}/code/blender-addon`, { model: "claude-opus-5-5" }, 0))); // see mockLadder.ts
  // `?tools=demo`: a chat that drives the Browser, iPhone and Mac through coool-device (readable step rows, where the
  // turn went, a subagent near its context limit): one finished turn, then a live one (`?tools=demo&live=0`: no live turn).
  if (location.search.includes("tools=demo")) {
    const c = newChat("claude", `${HOME}/code/affect-study`, {}, 0);
    void c.seed(["Walk the affectUI agent components in the Browser panel (device demo)"], now - 4 * 60_000).then(() => {
      if (!location.search.includes("live=0")) setTimeout(() => c.send("Now check the sign-in flow again on a fresh page (device demo)"), 1500);
    });
  }
  if (location.search.includes("attach=")) void import("./mockAttach").then((m) => m.runAttachDemo(newChat("claude", `${HOME}/code/invoices`, {}, 0))); // see mockAttach.ts
  if (location.search.includes("md=demo")) void import("./mockPlan").then((m) => m.runMdDemo(newChat("claude", coool, {}, 0))); // see mockPlan.ts

  // `?presence=iphone|mac|browser`: an agent drives that panel on a loop (lib/mockPresence.ts).
  const presence = presenceDemo();
  if (presence) {
    void runPresenceDemo(presence, (provider, cwd) => {
      const c = newChat(provider, cwd.replace(/^~/, HOME), {}, 0);
      void c.seed([PRESENCE_PROMPTS[presence]], now - 20_000);
      return c;
    });
  }

  const insights: InsightsStatus = readInsights();
  const sim = mockSim();
  const pilotLog = { enabled: true, dir: "~/Library/Application Support/sh.coool.app/pilot", bytes: 184_320, files: 1 };
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
      if (s.background_tasks || s.id === AGENTS_DEMO || s.id === "f4a0e124" || OVERLAP_DEMO.has(s.id)) continue; // the demo parents wait for their jobs / agents; the overlap demo sits still
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
        if ((l.hold ?? 0) > 0) {
          // A `git commit` runs for a few ticks; then the commit is on the branch and the agent moves on.
          l.hold!--;
          if (l.hold === 0) {
            git.commit(s.project || s.cwd, committing(s.current) || "Commit the work in progress", l.edited ?? []);
            l.edited = [];
            s.current = "thinking…";
            s.updated = t;
            changed = true;
          }
        } else if (Math.random() < 0.42) {
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
            if (/^(Edit|Write) · /.test(a.text)) {
              const f = relPath(a.text.split(" · ")[1], s.project || s.cwd);
              if (!(l.edited ??= []).includes(f)) l.edited.push(f);
              git.touch(s.project || s.cwd);
            }
            if (committing(a.text) !== null) l.hold = 3;
            if (s.activity.length > 300) s.activity.splice(0, s.activity.length - 300);
            s.current = a.kind === "tool" || a.kind === "agent" ? a.text : "thinking…";
            s.tokens.input += 800 + Math.floor(Math.random() * 3000);
            s.tokens.cached += 4000 + Math.floor(Math.random() * 9000);
            s.tokens.output += 120 + Math.floor(Math.random() * 900);
            if (s.id !== CTX_DEMO_ID) s.tokens.context = Math.min(s.provider === "codex" ? 262_000 : 420_000, s.tokens.context + 600 + Math.floor(Math.random() * 3400));
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

  // The context-map demo session (mockContext.ts): its context follows the scripted map, compaction included.
  setInterval(() => {
    const s = live.find((l) => l.s.id === CTX_DEMO_ID)?.s;
    if (!s) return;
    const total = ctxDemoMap().total;
    const compacting = ctxCompacting();
    const cur = compacting ? "Compacting conversation" : s.current === "Compacting conversation" ? "thinking…" : s.current;
    if (s.tokens.context === total && cur === s.current) return;
    s.tokens.context = total;
    if (compacting) s.status = "busy";
    s.current = cur;
    const ag = s.agents.find((a) => a.id === "ag1");
    if (ag) ag.tokens.context = ctxAgentMap().total;
    s.updated = Date.now();
    emitSessions();
  }, 1000);

  // `?stress=sidebar`: a seeded storm of status flips (top-level rows and child jobs), so the sidebar's
  // reorder / cap / exit animations can be checked frame by frame (scripts drive it over CDP).
  if (location.search.includes("stress=sidebar")) {
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const pool = () => live.filter((l) => !l.chat && l.s.managed === null);
    setInterval(() => {
      const ls = pool();
      for (let n = 1 + Math.floor(rand() * 3); n > 0 && ls.length; n--) {
        const s = ls[Math.floor(rand() * ls.length)].s;
        const r = rand();
        s.status = r < 0.4 ? "busy" : r < 0.75 ? "idle" : "ended";
        s.waiting_for = s.status === "idle" && rand() < 0.4 ? "permission to run `cargo test`" : null;
        s.current = s.status === "busy" ? "thinking…" : null;
        s.updated = Date.now();
      }
      emitSessions();
    }, 140);
  }

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
    async renameSession(provider, id, name) {
      await delay(60);
      mockRename(provider, id, name);
      emitSessions();
    },
    async pickFolder() {
      await delay(200);
      return `${HOME}/code/new-project`;
    },
    async gitTrail(path) {
      await delay(80 + Math.random() * 120);
      return git.trail(path);
    },
    async changesLoad(t) {
      await delay(40);
      return (await import("./mockChanges")).changesLoadMock(t.cwd, t.scope);
    },
    async changesUndo(t, file, hunk, force) {
      await delay(120);
      return (await import("./mockChanges")).changesUndoMock(t.cwd, t.scope, file, hunk, force);
    },
    async changesKeep(t, file, hunk, stage, unkeep) {
      await delay(80);
      return (await import("./mockChanges")).changesKeepMock(t.cwd, t.scope, file, hunk, stage, unkeep);
    },
    async changesTold() {},
    async changesCommit(cwd, message) {
      await delay(300);
      return (await import("./mockChanges")).changesCommitMock(cwd, message);
    },
    async changesPreview(cwd, tool, input) {
      await delay(60);
      return (await import("./mockChanges")).changesPreviewMock(cwd, tool, input);
    },
    async changesOpen() {},
    async contextMap({ sessionId, agentId }) {
      await delay(30);
      if (sessionId === CTX_DEMO_ID) return agentId ? ctxAgentMap() : ctxDemoMap();
      // Others: the total only, as for a transcript that can't be itemised.
      const s = live.find((l) => l.s.id === sessionId)?.s;
      const a = agentId ? s?.agents.find((x) => x.id === agentId) : null;
      return { total: (a ?? s)?.tokens.context ?? 0, parts: [], compaction: null, note: "The mock itemises only the first session's context.", chars_per_token: null };
    },
    // The Context panel: an in-memory set of files (mockChatContext.ts).
    chatContext: (t) => mockCtx.chatContext(t),
    chatContextRead: (t, p) => mockCtx.chatContextRead(t, p),
    chatContextSave: (t, p, text, stamp) => mockCtx.chatContextSave(t, p, text, stamp),
    chatContextCreate: (t, c) => mockCtx.chatContextCreate(t, c),
    chatContextTrash: (t, p) => mockCtx.chatContextTrash(t, p),
    chatContextReveal: () => mockCtx.chatContextReveal(),
    async environment() {
      // `?env=nocodex` / `?env=noclaude` / `?env=none`: a CLI not installed (the onboarding's and the new-session sheet's lines).
      const e = /[?&]env=(\w+)/.exec(location.search)?.[1] ?? "";
      return { home: HOME, claude: e === "noclaude" || e === "none" ? null : "/usr/local/bin/claude", codex: e === "nocodex" || e === "none" ? null : "/opt/homebrew/bin/codex" };
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
    async usageResetCodex(key) {
      await delay(1200);
      if (usageMode === "resetfail") throw new Error("codex: rate limit reset consume timed out");
      const u = usage.codex;
      if (!u) throw new Error("codex: no usage data");
      if (resetKeys.has(key)) return "already_redeemed";
      if (!u.reset_credits) return "no_credit";
      if (!u.windows.some((w) => (w.used_percent ?? 0) > 0)) return "nothing_to_reset";
      resetKeys.add(key);
      const t = Date.now();
      u.reset_credits -= 1;
      if (u.reset_credits === 0) u.reset_credits_expire_ms = null;
      u.fetched_ms = t;
      u.stale = false;
      u.windows = u.windows.map((w) => ({ ...w, used_percent: 0, detail: null, as_of_ms: t, resets_ms: w.window_minutes ? t + w.window_minutes * 60_000 : w.resets_ms }));
      emitSessions();
      return "reset";
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
    async motionHints() {
      // A healthy Apple-silicon laptop on power unless `?power=` says otherwise (Settings > Appearance lists each hint).
      return mockHints(location.search) ?? { low_power: false, thermal: "nominal", on_battery: false, battery_pct: 86, intel: false, memory_gb: 36, perf_cores: 12, busy_at_launch: false, reduce: false, reason: null };
    },
    onMotionHints() {
      return () => {};
    },
    // Artifacts: the guide's local copy is "there" (served from app/public/mock-artifact), the release notes' is gone.
    async artifactStatus(urls) {
      return Object.fromEntries(urls.map((u) => [u, u === MOCK_ARTIFACT_URL]));
    },
    // A plain browser has no preview window: a pop-up window of the mock page stands in.
    async artifactWindow(url) {
      if (url !== MOCK_ARTIFACT_URL) return false;
      window.open("/mock-artifact/onboarding.html", `preview-${url.slice(-6)}`, "popup,width=900,height=700,noopener");
      return true;
    },
    async openArtifact(url) {
      window.open(url, "_blank", "noopener");
    },
    // No native webviews in a plain browser: the panel frames the page instead (BrowserPanel's MockFrame).
    nativeBrowser: false,
    async browserOpen() {
      return "mock";
    },
    async browserBounds() {},
    async browserNavigate() {},
    async browserGo() {},
    async browserPoll() {},
    async browserClose() {},
    async browserOpenExternal() {},
    onBrowserState() {
      return () => {};
    },
    onBrowserClosed() {
      return () => {};
    },
    onBrowserNewTab() {
      return () => {};
    },
    // No agent browser tools without the app.
    async browserAgentSync() {},
    onBrowserAgent() {
      return () => {};
    },
    onBrowserActivity(cb) {
      return onMockBrowserActivity(cb);
    },
    async browserPresenceEnd() {},
    async presenceMotion() {},
    onPilotProgress() {
      return () => {};
    },
    // The iPhone panel (lib/mockSim.ts).
    ...sim,
    // The Mac panel (lib/mockMac.ts).
    ...mockMac(),
    // The Settings page (lib/mockSettings.ts).
    ...mockSettings({ shutdown: (udid) => sim.simShutdown(udid) }),
    ...mockUpdate(),

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
    async chatSend(id, text, attachments) {
      const c = chats[id];
      if (!c) throw new Error("no such chat");
      await chatReady.get(id);
      c.send(text, attachments);
    },
    attachPaths: (paths) => import("./mockAttach").then((m) => m.mockAttachPaths(paths)),
    attachBytes: (name, data) => import("./mockAttach").then((m) => m.mockAttachBytes(name, data)),
    attachImage: (key) => import("./mockAttach").then((m) => m.mockAttachImage(key)),
    attachPreview: (path, imagesOnly, root) => import("./mockAttach").then((m) => m.mockAttachPreview(path, imagesOnly, root)),
    attachReveal: async () => {},
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
    explainRequest: (req) => mockExplain(req, insights.enabled && insights.has_key),
    async pilotLogStatus() {
      return { ...pilotLog };
    },
    async pilotLogSetEnabled(enabled) {
      pilotLog.enabled = enabled;
      return { ...pilotLog };
    },
    async deviceGrants() {
      return deviceGrants.map((g) => ({ ...g, devices: [...g.devices], sites: [...g.sites] }));
    },
    async deviceGrantsRevoke(project, device, site) {
      const g = deviceGrants.find((x) => x.project === project);
      if (g) {
        if (device) g.devices = g.devices.filter((d) => d !== device);
        else if (site) g.sites = g.sites.filter((s) => s !== site);
        else g.devices = g.sites = [];
      }
      deviceGrants = deviceGrants.filter((x) => x.devices.length || x.sites.length);
      return this.deviceGrants();
    },
    async pilotLogReveal() {},
    async pilotLogDelete() {
      pilotLog.bytes = 0;
      pilotLog.files = 0;
      return { ...pilotLog };
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
