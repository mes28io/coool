// Ladder (APP_SPEC "Ladder"): the chat's own model leads and checks; cheaper models do the pieces, several at once.
// This file is the pure part: the tier table a chat launches with, built from the models its CLI reported, and the
// per-turn tally of what really ran. The policy text itself is crates/core/src/ladder (sent at launch).
//
// Pure: unit-tested by ladderTiers.test.ts.

import { modelFamily, modelLabel } from "./models.ts";
import type { Provider } from "./types";

/** The feature's name everywhere it shows (rename here and in crates/core/src/ladder/mod.rs). */
export const LADDER = "Ladder";
/** What it does for the person, in one line (mechanism only: no claimed savings). */
export const LADDER_LINE = "The chat's model plans and checks; cheaper models do the pieces, several at once, and results are checked before they are reported.";

export type LadderRole = "mid" | "small" | "bulk";
export const ROLES: LadderRole[] = ["mid", "small", "bulk"];
export const ROLE_WORK: Record<LadderRole, string> = {
  mid: "Multi-file work, debugging, review",
  small: "Scoped edits, lookups, summaries",
  bulk: "Mechanical bulk work",
};

/** One delegate tier as the backend takes it (`ChatOptions.ladder.tiers`). */
export interface LadderTier {
  role: LadderRole;
  /** What the CLI's delegate tool takes: a Claude Code alias (`sonnet`) or a Codex model id. */
  model: string;
  label: string;
}

/** `ChatOptions.ladder` (crates/core/src/ladder `Ladder`). */
export interface LadderOptions {
  tiers: LadderTier[];
  max_parallel: number;
  verify_tests: boolean;
}

/** The highest role a delegate may take: "small" keeps the mid tier's work on the small tier's model. */
export type LadderCap = "mid" | "small";

export interface ModelChoice {
  id: string;
  label: string;
}

const CLAUDE_RANK: Record<string, number> = { fable: 5, mythos: 5, opus: 4, sonnet: 3, haiku: 2 };
const CLAUDE_ALIASES = ["fable", "opus", "sonnet", "haiku"];

/** "claude-sonnet-4-6" -> 4.6; "gpt-5.6-luna" -> 5.6; none -> 0. */
function version(id: string): number {
  const m = /(\d+)(?:[.-](\d{1,2})(?!\d))?/.exec(id.replace(/-\d{8}$/, "").replace(/^claude-[a-z]+-/, "").replace(/^gpt-/, ""));
  return m ? Number(m[1]) + (m[2] ? Number(m[2]) / 100 : 0) : 0;
}

/**
 * How strong a model is within its CLI's list (higher is stronger; null when unknown). Claude: by family. Codex: by
 * the size words its names carry (sol / astra > terra > luna / mini > nano); a plain gpt id ranks with the top.
 */
export function modelRank(provider: Provider, id: string | null | undefined): number | null {
  if (!id) return null;
  if (provider === "claude") {
    const f = modelFamily(id);
    return f in CLAUDE_RANK ? CLAUDE_RANK[f] : null;
  }
  const s = id.toLowerCase();
  if (/nano/.test(s)) return 0;
  if (/luna|mini|spark|small|lite|flash/.test(s)) return 1;
  if (/terra|medium/.test(s)) return 2;
  if (/sol|astra|gpt|codex|o\d/.test(s)) return 3;
  return null;
}

interface Cand {
  model: string;
  label: string;
  rank: number;
  ver: number;
}

/**
 * The delegate candidates a CLI offers, one per strength level, best version first. Claude Code: its family aliases
 * (what the Agent tool's `model` takes), labelled as the CLI labels them ("Sonnet 5.5"); with nothing reported yet,
 * the plain aliases. Codex: the reported model ids.
 */
export function candidates(provider: Provider, seen: ModelChoice[]): Cand[] {
  const out: Cand[] = [];
  if (provider === "claude") {
    for (const a of CLAUDE_ALIASES) {
      const s = seen.find((m) => m.id === a);
      // The alias's own label when the CLI gave one ("Sonnet 5.5"); else the newest id of that family.
      const ids = seen.filter((m) => modelFamily(m.id) === a && m.id !== a).sort((x, y) => version(y.id) - version(x.id));
      // A family the CLI lists neither as an alias nor as an id is not offered (with nothing reported: all are).
      if (seen.length && !s && !ids.length) continue;
      const label = s && s.label && s.label.toLowerCase() !== a ? s.label : ids[0] ? modelLabel(ids[0].id) : modelLabel(a);
      out.push({ model: a, label, rank: CLAUDE_RANK[a], ver: 0 });
    }
    return out;
  }
  for (const m of seen) {
    const r = modelRank(provider, m.id);
    if (r === null) continue;
    out.push({ model: m.id, label: m.label || m.id, rank: r, ver: version(m.id) });
  }
  // One per level: the newest version.
  const best = new Map<number, Cand>();
  for (const c of out) {
    const b = best.get(c.rank);
    if (!b || c.ver > b.ver) best.set(c.rank, c);
  }
  return [...best.values()].sort((a, b) => b.rank - a.rank);
}

/** The lead's strength when the chat starts on the CLI's own default (unknown here): Claude assumes Opus, Codex its top. */
function leadRank(provider: Provider, lead: string | null, cands: Cand[]): number {
  const r = modelRank(provider, lead);
  if (r !== null) return r;
  if (provider === "claude") return CLAUDE_RANK.opus;
  return cands.length ? Math.max(...cands.map((c) => c.rank)) : 0;
}

/**
 * The tier table for a chat about to start: only models weaker than the lead (the lead is never a delegate tier),
 * mid = the strongest of them, small = the next, bulk = the weakest; fewer levels collapse onto the ones there are.
 * `pick`: a model chosen per role in Settings (ignored when it is not weaker than the lead). `cap: "small"` gives the
 * mid tier's work to the small tier's model. Empty when nothing is weaker (the lead works alone, with the same checks).
 */
export function tierTable(
  provider: Provider,
  lead: string | null,
  seen: ModelChoice[],
  o: { cap?: LadderCap; pick?: Partial<Record<LadderRole, string | null>> } = {},
): LadderTier[] {
  const cands = candidates(provider, seen);
  const top = leadRank(provider, lead, cands);
  const below = cands.filter((c) => c.rank < top);
  if (!below.length) return [];
  const at = (i: number) => below[Math.min(i, below.length - 1)];
  // One level: all three roles. Two: mid, then small and bulk. Three or more: the strongest, the next, the weakest.
  const auto: Record<LadderRole, Cand> = { mid: at(0), small: at(1), bulk: below[below.length - 1] };
  const chosen: Record<LadderRole, Cand> = { ...auto };
  for (const r of ROLES) {
    const id = o.pick?.[r];
    const c = id ? below.find((x) => x.model === id) : undefined;
    if (c) chosen[r] = c;
  }
  if (o.cap === "small") chosen.mid = chosen.small;
  return ROLES.map((role) => ({ role, model: chosen[role].model, label: chosen[role].label }));
}

/** The role a delegate's model plays in a chat's table (the first role it holds), or null when it is off the table. */
export function roleOf(tiers: LadderTier[] | null | undefined, model: string | null | undefined, provider: Provider): LadderRole | null {
  if (!tiers?.length || !model) return null;
  const exact = tiers.find((t) => t.model === model);
  if (exact) return exact.role;
  // A delegate reports its full id ("claude-haiku-5-5"); the table holds the alias ("haiku").
  if (provider === "claude") {
    const f = modelFamily(model);
    return tiers.find((t) => modelFamily(t.model) === f)?.role ?? null;
  }
  return null;
}

/** Rows to show: roles that share a model fold into one row ("Small and bulk"). */
export function tierRows(tiers: LadderTier[]): { roles: LadderRole[]; model: string; label: string }[] {
  const rows: { roles: LadderRole[]; model: string; label: string }[] = [];
  for (const t of tiers) {
    const r = rows.find((x) => x.model === t.model);
    if (r) r.roles.push(t.role);
    else rows.push({ roles: [t.role], model: t.model, label: t.label });
  }
  return rows;
}

export const roleWord = (r: LadderRole) => r[0].toUpperCase() + r.slice(1);
export const rolesWord = (rs: LadderRole[]) => rs.map((r, i) => (i ? r : roleWord(r))).join(" and ");

// ---------- the per-turn tally (from what the chat really shows) ----------

/** The slice of a chat item the tally reads (lib/chat.ts `ChatItem`). */
export type TallyItem =
  | { kind: "tool"; id: string; name: string; input: unknown; ts: number; endTs: number | null; ok: boolean | null; parent: string | null; summary?: string }
  | { kind: "text"; parent: string | null; model: string | null }
  | { kind: string; parent?: string | null };

export interface TallyAgentUse {
  models: Record<string, { model: string; input: number; cached: number; output: number }>;
  total?: number;
}

export interface Delegate {
  id: string;
  model: string | null;
  role: LadderRole | null;
  tokens: number;
  ok: boolean | null;
  /** Test commands the delegate ran itself, and whether the last one passed. */
  tests: number;
}

export interface Tally {
  delegates: Delegate[];
  /** Per model, in first-seen order: how many delegates and their tokens. */
  byModel: { model: string; role: LadderRole | null; count: number; tokens: number }[];
  /** Delegates whose model is not cheaper than the lead's (should not happen with Ladder on). */
  onLead: number;
  /** The lead's own checks after the first delegate started. */
  checks: { tests: number; testsPassed: number; testsFailed: number; diffs: number; reads: number };
  /** Test commands delegates ran themselves. */
  delegateTests: number;
}

const AGENT = /^(task|agent|subagent|spawn_agent)$/i;
const SHELL = /^(bash|shell|exec_command|local_shell|unified_exec)$/i;
/** Test runners: what counts as "ran the tests". */
export const TEST_CMD = /(^|[\s;&|(])(cargo (nextest|test)|go test|pytest|python -m pytest|vitest|jest|mocha|swift test|xcodebuild test|(npm|pnpm|yarn|bun)( run)? test|make (test|check)|node --test|deno test|rspec|phpunit|mix test|gradle(w)? test|mvn test)\b/;
const DIFF_CMD = /(^|[\s;&|(])git (diff|show|status|log -p)\b/;
const READ = /^(read|view_file|read_file)$/i;

const cmdOf = (input: unknown): string => {
  const i = input as { command?: unknown; cmd?: unknown } | null;
  const c = i?.command ?? i?.cmd;
  return Array.isArray(c) ? c.join(" ") : typeof c === "string" ? c : "";
};

/** The model a delegate was asked for (Agent tool / spawn_agent `model`). */
const askedModel = (input: unknown): string | null => {
  const m = (input as { model?: unknown } | null)?.model;
  return typeof m === "string" && m ? m : null;
};

/**
 * What a finished (or running) turn delegated and checked, from its items only: delegate calls (with the model each
 * really answered on when the CLI reported it, else the one asked for), their tokens (Claude Code's count per
 * delegate), and the lead's own test runs, diffs and reads after the first delegate began. Nothing is estimated.
 */
export function turnTally(items: TallyItem[], agents: Record<string, TallyAgentUse | undefined>, o: { provider: Provider; lead: string | null; tiers: LadderTier[] | null }): Tally {
  const tools = items.filter((i): i is Extract<TallyItem, { kind: "tool" }> => i.kind === "tool");
  const calls = tools.filter((t) => t.parent === null && AGENT.test(t.name));
  const leadR = modelRank(o.provider, o.lead);
  const delegates: Delegate[] = calls.map((t) => {
    const use = agents[t.id];
    const reported = use ? Object.values(use.models).sort((a, b) => b.output + b.input - (a.output + a.input))[0]?.model : undefined;
    const spoke = (items.find((i) => i.kind === "text" && i.parent === t.id && (i as { model: string | null }).model) as { model: string | null } | undefined)?.model;
    const model = reported || spoke || askedModel(t.input) || null;
    const sum = use ? Object.values(use.models).reduce((n, u) => n + u.input + u.cached + u.output, 0) : 0;
    const kids = tools.filter((k) => k.parent === t.id && SHELL.test(k.name) && TEST_CMD.test(cmdOf(k.input)));
    return { id: t.id, model, role: roleOf(o.tiers, model, o.provider), tokens: use?.total || sum, ok: t.endTs === null ? null : t.ok, tests: kids.length };
  });
  const byModel: Tally["byModel"] = [];
  // One row per model; Claude's alias and full id of one family ("haiku", "claude-haiku-5-5") are the same row.
  const same = (a: string, b: string) => a === b || (o.provider === "claude" && a !== "unknown" && b !== "unknown" && modelFamily(a) === modelFamily(b));
  for (const d of delegates) {
    const k = d.model ?? "unknown";
    const row = byModel.find((r) => same(r.model, k));
    if (row) {
      row.count++;
      row.tokens += d.tokens;
    } else byModel.push({ model: k, role: d.role, count: 1, tokens: d.tokens });
  }
  const onLead = leadR === null ? 0 : delegates.filter((d) => d.model && (modelRank(o.provider, d.model) ?? -1) >= leadR).length;
  const first = calls.length ? Math.min(...calls.map((c) => c.ts)) : Infinity;
  const mine = tools.filter((t) => t.parent === null && t.ts >= first);
  const tests = mine.filter((t) => SHELL.test(t.name) && TEST_CMD.test(cmdOf(t.input)));
  return {
    delegates,
    byModel,
    onLead,
    checks: {
      tests: tests.length,
      testsPassed: tests.filter((t) => t.ok === true).length,
      testsFailed: tests.filter((t) => t.ok === false).length,
      diffs: mine.filter((t) => SHELL.test(t.name) && DIFF_CMD.test(cmdOf(t.input))).length,
      reads: mine.filter((t) => READ.test(t.name)).length,
    },
    delegateTests: delegates.reduce((n, d) => n + d.tests, 0),
  };
}

/** "2 on Haiku 5.5, 1 on Sonnet 5.5" from a tally (labels via the tier table when the model is on it). */
export function tallyModels(t: Tally, tiers: LadderTier[] | null): string {
  return t.byModel
    .map((r) => {
      const label = tiers?.find((x) => x.role === r.role)?.label ?? (r.model === "unknown" ? "an unreported model" : modelLabel(r.model));
      return `${r.count} on ${label}`;
    })
    .join(", ");
}

/** "tests run (1 passed), 2 diffs read" — what the lead checked; "nothing checked yet" when it did none of it. */
export function tallyChecks(t: Tally): string {
  const parts: string[] = [];
  const c = t.checks;
  if (c.tests) parts.push(`tests run ${c.tests}× (${c.testsPassed} passed${c.testsFailed ? `, ${c.testsFailed} failed` : ""})`);
  if (c.diffs) parts.push(`${c.diffs} diff${c.diffs === 1 ? "" : "s"} read`);
  if (c.reads) parts.push(`${c.reads} file${c.reads === 1 ? "" : "s"} reread`);
  return parts.length ? parts.join(", ") : "nothing checked by the lead";
}
