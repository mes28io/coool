// The browser mock's git: a believable history per demo project (agent worktree branches merged
// with --no-ff, files per commit), and commits the mock sessions make while the demo runs.

import type { GitTrail, TrailCommit } from "./types";

type Seed = { s: string; f?: string[]; m?: number; side?: { s: string; f?: string[] }[]; from?: string; refs?: string[] };

const HEX = "0123456789abcdef";
let n = 0;
function sha(): string {
  n++;
  let x = (n * 2654435761) >>> 0;
  let out = "";
  for (let i = 0; i < 40; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += HEX[(x >>> 16) & 15];
  }
  return out;
}

function mk(subject: string, files: string[], t: number, refs: string[] = []): TrailCommit {
  const h = sha();
  return { sha: h, short: h.slice(0, 7), subject, author: "Claude", time_ms: t, files: files.slice(0, 6), files_more: Math.max(0, files.length - 6), refs, merge: null };
}

const HISTORY: Record<string, { branch: string; uncommitted: number; seeds: Seed[] }> = {
  coool: {
    branch: "main",
    uncommitted: 3,
    seeds: [
      { s: "Sidebar rows glide when a session's status changes", f: ["app/src/components/Sidebar.tsx"], m: 34 },
      { s: "Merge: the store treats every sessions event as authoritative", m: 52, from: "worktree-agent-3f1c9e", side: [{ s: "Drop the store's own diffing", f: ["app/src/store.ts"] }, { s: "Emit sessions only when the JSON differs", f: ["crates/core/src/hub.rs", "crates/core/src/wire.rs"] }, { s: "Test the refresh thread's dedupe", f: ["crates/core/src/hub.rs"] }] },
      { s: "Clamp the RawLog offset after a buffer drain", f: ["crates/core/src/pty.rs"], m: 95 },
      { s: "Merge branch 'palette-fuzzy'", m: 140, side: [{ s: "Fuzzy match folder names in the palette", f: ["app/src/lib/fuzzy.ts", "app/src/components/Palette.tsx"] }] },
      { s: "Bump version to 0.4.2", f: ["app/package.json", "Cargo.toml", "Cargo.lock"], m: 190, refs: ["v0.4.2"] },
      { s: "Terminal keeps its scrollback on resize", f: ["app/src/components/TerminalView.tsx"], m: 260 },
      { s: "Usage popover shows reset times", f: ["app/src/components/Usage.tsx"], m: 330 },
    ],
  },
  "atlas-api": {
    branch: "rate-limit",
    uncommitted: 2,
    seeds: [
      { s: "Read limiter budgets from config", f: ["src/config.rs", "config/default.toml"], m: 26 },
      { s: "Merge branch 'worktree-agent-b8e3aa' into rate-limit", m: 48, side: [{ s: "Token bucket keyed by API key", f: ["src/middleware/rate_limit.rs"] }, { s: "Wire the limiter into /v2 routes", f: ["src/routes/mod.rs"] }] },
      { s: "Fix rounding in the search score", f: ["src/search/score.rs"], m: 71 },
      { s: "Merge branch 'tower-auth'", m: 180, side: [{ s: "Port auth middleware to tower", f: ["src/middleware/auth.rs", "Cargo.toml"] }, { s: "Remove the old auth guard", f: ["src/guard.rs"] }] },
      { s: "Add /v2/search behind a flag", f: ["src/routes/search.rs", "src/flags.rs"], m: 300, refs: ["origin/main"] },
    ],
  },
  pixelforge: {
    branch: "wgpu-26",
    uncommitted: 5,
    seeds: [
      { s: "Port the bloom pass to the new entry points", f: ["render/bloom.rs"], m: 18 },
      { s: "Pipeline compilation options for every pass", f: ["render/pipeline.rs", "render/shadow.rs", "render/bloom.rs"], m: 44 },
      { s: "Merge branch 'metal-resolve'", m: 120, side: [{ s: "Resolve the HDR target before bloom on Metal", f: ["render/bloom.rs"] }, { s: "Golden image for the Metal bloom", f: ["tests/golden/bloom_metal.png"] }] },
      { s: "Bump wgpu to 26", f: ["Cargo.toml", "Cargo.lock"], m: 210 },
    ],
  },
  "notes-ios": {
    branch: "offline-sync",
    uncommitted: 1,
    seeds: [
      { s: "Outbox queue persisted in SQLite", f: ["Sync/OutboxQueue.swift", "Sync/Schema.sql"], m: 22 },
      { s: "Drain the outbox when the network returns", f: ["Sync/SyncEngine.swift"], m: 39 },
      { s: "Merge branch 'path-monitor'", m: 160, side: [{ s: "Wrap NWPathMonitor", f: ["Sync/Reachability.swift"] }] },
      { s: "Snapshot tests for the sync banner", f: ["NotesTests/SyncBannerTests.swift"], m: 240 },
    ],
  },
  "project-3d": {
    branch: "addon-milestone",
    uncommitted: 7,
    seeds: [
      { s: "Merge: add-on manifest and test harness", m: 9, from: "worktree-agent-ag3d9", side: [{ s: "Write the add-on manifest", f: ["blender_manifest.toml"] }, { s: "Headless Blender test harness", f: ["tests/conftest.py"] }] },
      { s: "Icons converted to SVG", f: ["assets/icons/index.json"], m: 15 },
      { s: "Normalize normals once per mesh", f: ["src/export/mesh.rs"], m: 61 },
      { s: "Merge branch 'keymap'", m: 130, side: [{ s: "Keymap without conflicts", f: ["src/ui/keymap.rs"] }] },
    ],
  },
  "relay-docs": {
    branch: "main",
    uncommitted: 0,
    seeds: [
      { s: "Guide: background shells", f: ["guide/shells.md"], m: 12 },
      { s: "Fix the link to the old shells page", f: ["changelog.md"], m: 40 },
    ],
  },
};

export class MockGit {
  private trails = new Map<string, GitTrail>();

  constructor(home: string) {
    const now = Date.now();
    for (const [name, h] of Object.entries(HISTORY)) {
      const root = `${home}/code/${name}`;
      const commits = h.seeds.map((sd) => {
        const t = now - (sd.m ?? 60) * 60_000;
        if (!sd.side) return mk(sd.s, sd.f ?? [], t, sd.refs);
        const files = sd.side.flatMap((x) => x.f ?? []);
        const c = mk(sd.s, [...new Set(files)], t, sd.refs);
        const from = sd.from ?? /'([^']+)'/.exec(sd.s)?.[1] ?? null;
        c.merge = { from, commits: sd.side.map((x, i) => mk(x.s, x.f ?? [], t - (i + 1) * 4 * 60_000)), more: 0 };
        return c;
      });
      if (commits[0]) commits[0].refs = [h.branch, ...commits[0].refs];
      this.trails.set(root, { root, branch: h.branch, head: commits[0]?.sha ?? null, commits, more: true, uncommitted: h.uncommitted });
    }
  }

  trail(path: string): GitTrail {
    for (const [root, t] of this.trails) if (path === root || path.startsWith(root + "/")) return structuredClone(t);
    throw new Error(`git rev-parse: not a git repository (or any of the parent directories): ${path}`);
  }

  /** An agent's `git commit` finished: the commit lands on the branch. */
  commit(path: string, subject: string, files: string[]) {
    const t = [...this.trails.entries()].find(([root]) => path === root || path.startsWith(root + "/"))?.[1];
    if (!t) return;
    const c = mk(subject, files, Date.now(), t.branch ? [t.branch] : []);
    for (const old of t.commits) old.refs = old.refs.filter((r) => r !== t.branch);
    t.commits = [c, ...t.commits].slice(0, 12);
    t.head = c.sha;
    t.uncommitted = Math.max(0, (t.uncommitted ?? 0) - files.length);
  }

  /** Files edited since the last commit (the commit's file chips). */
  touch(path: string, n = 1) {
    const t = [...this.trails.entries()].find(([root]) => path === root || path.startsWith(root + "/"))?.[1];
    if (t) t.uncommitted = (t.uncommitted ?? 0) + n;
  }
}
