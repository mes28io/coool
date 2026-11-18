// The mock backend's context map: one Claude session whose context grows,
// nears the limit, compacts and grows again, on a loop, so the Models panel's
// map can be seen moving without the real backend (crates/core/src/context.rs
// computes the real one). `?ctx=0.4` freezes the loop at that phase (0..1):
// ~0.35 mid-growth, ~0.74 near full, ~0.8 compacting, ~0.95 after.

import type { ContextMap, ContextPart } from "./types";

export const CTX_DEMO_ID = "a1f0c2";
const PERIOD = 80_000;
/** Phases of the loop: growth until GROW_END, compaction until COMPACT_END, then the fresh segment. */
const GROW_END = 0.76;
const COMPACT_END = 0.86;

const frozen = (() => {
  if (typeof location === "undefined") return null;
  const m = /[?&]ctx=([\d.]+)/.exec(location.search);
  return m ? Math.min(0.999, Math.max(0, Number(m[1]))) : null;
})();
const t0 = Date.now();

export function ctxPhase(now = Date.now()): number {
  return frozen ?? ((now - t0) % PERIOD) / PERIOD;
}

export const ctxCompacting = (now = Date.now()) => {
  const p = ctxPhase(now);
  return p >= GROW_END && p < COMPACT_END;
};

const P = (id: string, kind: ContextPart["kind"], label: string, tokens: number, extra: Partial<ContextPart> = {}): ContextPart => ({
  id,
  kind,
  label,
  tokens: Math.round(tokens),
  count: 0,
  basis: "calibrated",
  ...extra,
});

/** What the transcript never shows: the same in both segments. */
function fixed(): ContextPart[] {
  return [
    P("system:system prompt", "system", "System prompt", 3_100, { basis: "estimated" }),
    P("tools:tool definitions", "tools", "Tool definitions", 14_600, { basis: "estimated" }),
    P("memory:project memory", "memory", "Project memory", 4_200, { basis: "estimated" }),
    P("skills:skills", "skills", "Skills", 2_400, { basis: "estimated" }),
    P("system:other system context", "system", "Other system context", 5_800, { basis: "remainder" }),
  ];
}

const ramp = (g: number, from: number, to = 1) => Math.max(0, Math.min(1, (g - from) / (to - from)));
const HOME = "/Users/you/code/coool";

/** The first segment at growth `g` (0..1). */
function growing(g: number): ContextPart[] {
  const parts = fixed();
  parts.push(P("chat:conversation", "chat", "Conversation", 1_400 + 21_000 * g));
  if (g > 0.04) parts.push(P("thinking:thinking", "thinking", "Thinking", 13_500 * ramp(g, 0.04)));
  const files: [string, number, number][] = [
    ["app/src/lib/payment.ts", 0.05, 14_200],
    ["app/src/lib/checkout.spec.ts", 0.13, 6_100],
    ["app/src/components/Receipt.tsx", 0.42, 18_300],
    ["app/src/lib/stripe.ts", 0.55, 5_200],
    ["app/src/lib/cart.ts", 0.66, 3_300],
  ];
  for (const [path, at, size] of files) {
    if (g > at) parts.push(P(`file:${HOME}/${path}`, "file", path.split("/").pop()!, size * Math.min(1, ramp(g, at, at + 0.06)), { path: `${HOME}/${path}`, count: g > at + 0.3 ? 2 : 1 }));
  }
  if (g > 0.6) parts.push(P("file:*", "file", "5 other files", 5_000 * ramp(g, 0.6), { count: 5, path: `${HOME}/app/src/lib/money.ts\n${HOME}/app/src/lib/tax.ts\n${HOME}/package.json\n${HOME}/app/src/App.tsx` }));
  const tests = Math.floor(g * 20);
  if (tests > 0) parts.push(P("tool:test runs", "tool", "Test runs", 1_400 * tests, { count: tests }));
  const searches = Math.floor(g * 12);
  if (searches > 0) parts.push(P("tool:searches", "tool", "Searches", 600 * searches, { count: searches }));
  const shell = Math.floor(g * 18);
  if (shell > 0) parts.push(P("tool:shell", "tool", "Shell", 880 * shell, { count: shell }));
  if (g > 0.5) parts.push(P("agent:sub-agents", "agent", "Sub-agents", 6_500 * Math.min(1, ramp(g, 0.5, 0.56)), { count: 1 }));
  if (g > 0.7) parts.push(P("tool:mcp · supabase", "tool", "MCP · supabase", 4_000 * Math.min(1, ramp(g, 0.7, 0.75)), { count: 3 }));
  if (g > 0.3) parts.push(P("image:images", "image", "Images", 1_600, { count: 1 }));
  parts.push(P("other:reminders", "other", "Reminders", 900 + 2_000 * g));
  if (g > 0.2) parts.push(P("other:not in the transcript", "other", "Not in the transcript", 1_800 * ramp(g, 0.2), { basis: "estimated" }));
  return parts;
}

/** The segment after the compaction at growth `g` (0..1). */
function after(g: number): ContextPart[] {
  const parts = fixed();
  parts.push(P("summary:summary", "summary", "Summary", 7_800, { basis: "estimated", count: 1 }));
  parts.push(P("chat:conversation", "chat", "Conversation", 1_600 + 4_000 * g, { basis: g > 0.1 ? "calibrated" : "estimated" }));
  parts.push(P(`file:${HOME}/app/src/components/Receipt.tsx`, "file", "Receipt.tsx", 9_200, { path: `${HOME}/app/src/components/Receipt.tsx`, basis: "estimated", count: 1 }));
  parts.push(P(`file:${HOME}/app/src/lib/stripe.ts`, "file", "stripe.ts", 5_200, { path: `${HOME}/app/src/lib/stripe.ts`, basis: "estimated", count: 1 }));
  if (g > 0.15) parts.push(P("thinking:thinking", "thinking", "Thinking", 3_000 * ramp(g, 0.15)));
  const tests = Math.floor(g * 4);
  if (tests > 0) parts.push(P("tool:test runs", "tool", "Test runs", 1_400 * tests, { count: tests }));
  parts.push(P("other:reminders", "other", "Reminders", 500));
  return parts;
}

const sum = (ps: ContextPart[]) => ps.reduce((n, p) => n + p.tokens, 0);
const sorted = (ps: ContextPart[]) => ps.filter((p) => p.tokens > 0).sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));

/** The map at a phase of the loop (what `context_map` returns for the demo session). */
export function ctxDemoMap(now = Date.now()): ContextMap {
  const p = ctxPhase(now);
  const full = sorted(growing(1));
  if (p < COMPACT_END) {
    const parts = p < GROW_END ? sorted(growing(p / GROW_END)) : full;
    return { total: sum(parts), parts, compaction: null, note: null, chars_per_token: 2.9 };
  }
  const parts = sorted(after((p - COMPACT_END) / (1 - COMPACT_END)));
  const at = now - (p - COMPACT_END) * PERIOD;
  return {
    total: sum(parts),
    parts,
    compaction: { before: sum(full) + 1_300, after: sum(sorted(after(0))), at, auto: true, before_parts: full },
    note: null,
    chars_per_token: 2.9,
  };
}

/** A subagent's own (small) context: an Explore agent reading and searching. */
export function ctxAgentMap(now = Date.now()): ContextMap {
  const g = ((now - t0) % 30_000) / 30_000;
  const parts = sorted([
    P("system:system and tools", "system", "System and tools", 9_800, { basis: "remainder" }),
    P("chat:conversation", "chat", "Conversation", 600 + 900 * g),
    P("tool:searches", "tool", "Searches", 700 * (1 + Math.floor(g * 9)), { count: 1 + Math.floor(g * 9) }),
    P(`file:${HOME}/app/src/components/TerminalView.tsx`, "file", "TerminalView.tsx", 7_400, { path: `${HOME}/app/src/components/TerminalView.tsx`, count: 1 }),
    P(`file:${HOME}/app/src/lib/termlite.ts`, "file", "termlite.ts", 3_900 * Math.min(1, g * 3), { path: `${HOME}/app/src/lib/termlite.ts`, count: 1 }),
    P("thinking:thinking", "thinking", "Thinking", 1_200 + 2_000 * g),
  ]);
  return { total: sum(parts), parts, compaction: null, note: null, chars_per_token: 3.1 };
}
