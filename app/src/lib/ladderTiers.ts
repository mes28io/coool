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
export const LADDER_LINE = "The chat's model plans and checks; helpers on the cheapest model that can carry each piece (Claude or Codex) do the work, several at once, and results are checked before they are reported.";

export type LadderRole = "mid" | "small" | "bulk";
export const ROLES: LadderRole[] = ["mid", "small", "bulk"];
export const ROLE_WORK: Record<LadderRole, string> = {
  mid: "Multi-file work, debugging, review",
  small: "Scoped edits, lookups, summaries",
  bulk: "Mechanical bulk work",
};

/** Every role a tier can play: the pickable ones, the lead's own model for parallel work, and the other CLI's lanes. */
export type TierRole = LadderRole | "same" | "exec" | "peer";
export const ROLE_LINE: Record<TierRole, string> = {
  same: "The lead's own model, only to run medium-high pieces in parallel",
  mid: ROLE_WORK.mid,
  small: ROLE_WORK.small,
  bulk: ROLE_WORK.bulk,
  exec: "Small self-contained parts, briefed step by step",
  peer: "A second opinion on a hard call",
};

/** One helper tier as the backend takes it (`ChatOptions.ladder.tiers` / `.cross`). */
export interface LadderTier {
  role: TierRole;
  /** What the CLI's delegate tool takes: a Claude Code alias (`sonnet`) or a Codex model id. */
  model: string;
  label: string;
}

/** `ChatOptions.ladder` (crates/core/src/ladder `Ladder`). */
export interface LadderOptions {
  /** The lead's model as shown ("Opus 5.5"); "" for the CLI's default. */
  lead?: string;
  tiers: LadderTier[];
  /** The other CLI's lanes (`codex exec` / `claude -p`). */
  cross?: LadderTier[];
  /** Image generation (Codex's built-in image tool). */
  image?: ImageLane | null;
  max_parallel: number;
  verify_tests: boolean;
  /** Helper nesting depth (1: helpers start none). */
  depth?: number;
  swarm?: boolean;
  /** coool's `coool-ladder` tools (budget, can, spawn). */
  tools?: boolean;
  /** Percent of every usage window kept back. */
  reserve?: number;
  bypass_helpers?: boolean;
}

export interface ImageLane {
  provider: Provider;
  model: string;
  label: string;
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

/** The lead's own model as a `same` tier (parallel medium-high work only); null when the lead is the CLI's default. */
export function sameTier(provider: Provider, lead: string | null, seen: ModelChoice[]): LadderTier | null {
  const r = modelRank(provider, lead);
  if (!lead || r === null) return null;
  if (provider === "claude") {
    const c = candidates(provider, seen).find((x) => x.rank === r && modelFamily(x.model) === modelFamily(lead));
    return c ? { role: "same", model: c.model, label: c.label } : null;
  }
  return { role: "same", model: lead, label: seen.find((m) => m.id === lead)?.label || lead };
}

const newest = (cs: Cand[]) => [...cs].sort((a, b) => b.ver - a.ver)[0];

/**
 * The other CLI's lanes for a lead, never above it. Codex's top (sol/astra) sits with Sonnet: a Claude lead may use
 * Codex models one rank below its own (Fable/Opus: astra and sol; Sonnet: terra and luna; Haiku: luna), and a Codex
 * lead Claude models at or below its rank (sol/astra: Sonnet and Haiku; terra: Haiku). Claude lead: peer = astra
 * (second opinion), exec = sol (else the best allowed), bulk = the smallest. Codex lead: mid = the strongest allowed
 * Claude model (multi-file reasoning, review, prose), bulk = the cheapest. `seen`: the other CLI's models.
 */
export function crossTable(provider: Provider, lead: string | null, seen: ModelChoice[]): LadderTier[] {
  const other: Provider = provider === "claude" ? "codex" : "claude";
  const lr = modelRank(provider, lead) ?? (provider === "claude" ? CLAUDE_RANK.opus : 3);
  const t = (role: TierRole, c: Cand): LadderTier => ({ role, model: c.model, label: c.label });
  if (provider === "claude") {
    const all: Cand[] = seen.flatMap((m) => {
      const r = modelRank(other, m.id);
      return r === null || r >= lr ? [] : [{ model: m.id, label: m.label || m.id, rank: r, ver: version(m.id) }];
    });
    if (!all.length) return [];
    const named = (w: string) => newest(all.filter((c) => c.model.includes(w)));
    const top = Math.max(...all.map((c) => c.rank));
    const out: LadderTier[] = [];
    const peer = named("astra");
    if (peer) out.push(t("peer", peer));
    const exec = named("sol") ?? newest(all.filter((c) => c.rank === top && !c.model.includes("astra"))) ?? newest(all.filter((c) => c.rank === top));
    if (exec) out.push(t("exec", exec));
    const low = Math.min(...all.map((c) => c.rank));
    const bulk = newest(all.filter((c) => c.rank === low));
    if (bulk) out.push(t("bulk", bulk));
    return out;
  }
  const cs = candidates(other, seen).filter((c) => c.rank <= lr);
  if (!cs.length) return [];
  return [t("mid", cs[0]), t("bulk", cs[cs.length - 1])];
}

/**
 * Image generation: Codex's built-in image tool. A Claude lead (no image model of its own) reaches it through
 * `codex exec` on Codex's cheapest listed model; a Codex lead uses its own tool. Null when Codex isn't installed or
 * its models aren't known yet (`codexSeen` empty), or when switched off.
 */
export function imageLane(provider: Provider, lead: string | null, codexSeen: ModelChoice[]): ImageLane | null {
  if (provider === "codex") return { provider: "codex", model: lead ?? "", label: lead ?? "" };
  const cs = candidates("codex", codexSeen);
  const c = cs[cs.length - 1];
  return c ? { provider: "codex", model: c.model, label: c.label } : null;
}

/** The role a delegate's model plays in a chat's table (the first role it holds), or null when it is off the table. */
export function roleOf(tiers: LadderTier[] | null | undefined, model: string | null | undefined, provider: Provider): TierRole | null {
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
export function tierRows(tiers: LadderTier[]): { roles: TierRole[]; model: string; label: string }[] {
  const rows: { roles: TierRole[]; model: string; label: string }[] = [];
  for (const t of tiers) {
    const r = rows.find((x) => x.model === t.model);
    if (r) r.roles.push(t.role);
    else rows.push({ roles: [t.role], model: t.model, label: t.label });
  }
  return rows;
}

export const roleWord = (r: TierRole) => r[0].toUpperCase() + r.slice(1);
export const rolesWord = (rs: TierRole[]) => rs.map((r, i) => (i ? r : roleWord(r))).join(" and ");

// ---------- the per-turn tally (from what the chat really shows) ----------

/** The slice of a chat item the tally reads (lib/chat.ts `ChatItem`). */
export type TallyItem =
  | { kind: "tool"; id: string; name: string; input: unknown; ts: number; endTs: number | null; ok: boolean | null; parent: string | null; summary?: string; output?: string }
  | { kind: "text"; parent: string | null; model: string | null }
  | { kind: string; parent?: string | null };

export interface TallyAgentUse {
  models: Record<string, { model: string; input: number; cached: number; output: number }>;
  total?: number;
}

export interface Delegate {
  id: string;
  model: string | null;
  role: TierRole | "image" | null;
  /** Which CLI ran it: the lead's own (Agent tool / spawn_agent), the other one (`codex exec`, `claude -p`), or a
   * `spawn`ed coool chat on either. */
  provider: Provider;
  /** How it ran: a native sub-agent, a shell lane, or a coool chat. */
  via: "agent" | "lane" | "spawn";
  tokens: number;
  ok: boolean | null;
  /** Test commands the delegate ran itself, and whether the last one passed. */
  tests: number;
}

export interface Tally {
  delegates: Delegate[];
  /** Per model, in first-seen order: how many delegates and their tokens. */
  byModel: { model: string; role: TierRole | "image" | null; provider: Provider; count: number; tokens: number }[];
  /** Delegates whose model is not cheaper than the lead's (should not happen with Ladder on). */
  onLead: number;
  /**
   * The lead's own checks once a helper had returned (its result in hand): test runs, builds / typechecks / lints,
   * diffs, files reread, helper outputs read, images viewed. `pending`: no helper has returned yet.
   */
  checks: { tests: number; images: number; testsPassed: number; testsFailed: number; diffs: number; reads: number; outputs: number; builds: number; pending: boolean };
  /** Test commands delegates ran themselves. */
  delegateTests: number;
}

const AGENT = /^(task|agent|subagent|spawn_agent)$/i;
/** coool's own helper tool (`mcp__coool-ladder__spawn`, Codex's `coool-ladder.spawn`). */
const SPAWN = /coool-ladder(__|\.|\/)spawn$/i;
/** A cross-provider lane run from the shell: `codex exec -m <model> …` or `claude -p … --model <model>`. */
export function laneOf(cmd: string): { provider: Provider; model: string | null; image: boolean } | null {
  const c = cmd.replace(/\\\n/g, " ");
  const codex = /(^|[\s;&|(])codex\s+(exec|e)\b/.exec(c);
  if (codex) {
    const m = /\s(?:-m|--model)[=\s]+["']?([\w.:-]+)/.exec(c.slice(codex.index));
    return { provider: "codex", model: m ? m[1] : null, image: /\b(image|icon|illustration|logo|picture|png|sprite|texture)\b/i.test(c) };
  }
  const claude = /(^|[\s;&|(])claude\s+(-p|--print)\b/.exec(c);
  if (claude) {
    const m = /\s--model[=\s]+["']?([\w.:-]+)/.exec(c.slice(claude.index));
    return { provider: "claude", model: m ? m[1] : null, image: false };
  }
  return null;
}
const SHELL = /^(bash|shell|exec_command|local_shell|unified_exec)$/i;
/** Builds, typechecks and linters: verification too. */
export const BUILD_CMD = /(^|[\s;&|(])(tsc|vue-tsc|eslint|oxlint|biome (check|lint)|ruff|mypy|pyright|clippy|cargo (check|build|clippy)|go (vet|build)|swift build|xcodebuild( [\w-]+)* build|(npm|pnpm|yarn|bun)( -C \S+)?( run)? (build|lint|typecheck|check|tsc))\b/;
/** Reading a file's content in the shell. */
const PEEK_CMD = /(^|[\s;&|(])(cat|tail|head|less|jq|wc|grep|rg|sed -n)\s/;
/** Tools that read a background task's or helper's output. */
const OUTPUT_TOOL = /^(bashoutput|taskoutput|read_output|wait_agent)$/i;
/** Test runners: what counts as "ran the tests". */
export const TEST_CMD = /(^|[\s;&|(])(cargo (nextest|test)|go test|pytest|python -m pytest|vitest|jest|mocha|swift test|xcodebuild test|(npm|pnpm|yarn|bun)( run)? test|make (test|check)|node --test|deno test|rspec|phpunit|mix test|gradle(w)? test|mvn test)\b/;
const DIFF_CMD = /(^|[\s;&|(])git( -C \S+)? (diff|show|status|log -p)\b/;
const READ = /^(read|view_file|read_file)$/i;

const cmdOf = (input: unknown): string => {
  const i = input as { command?: unknown; cmd?: unknown } | null;
  const c = i?.command ?? i?.cmd;
  return Array.isArray(c) ? c.join(" ") : typeof c === "string" ? c : "";
};

/** Paths a command names: "/tmp/s/log-a.txt". */
const pathsIn = (cmd: string) => cmd.match(/(?:~|\.{0,2})?\/[\w.@%+~/${}-]*[\w}]/g) ?? [];
/** A path a launch names, as a pattern: a shell variable in it (a loop's `$p`) matches one path segment. */
const pathPattern = (p: string) => new RegExp(`^${p.split(/\$\{?\w+\}?/).map((x) => x.replace(/[.*+?^()|[\]\\{}$]/g, "\\$&")).join("[^/]+")}$`);
/** A background Agent call: it returns at once with an acknowledgement (lib/helperCards.ts). */
const backgroundCall = (t: { input: unknown; output?: string }) =>
  (t.input as { run_in_background?: unknown } | null)?.run_in_background === true || /^\s*Async agent launched/i.test(t.output ?? "");

/** What the chat's session adds to a turn's own items (all optional; without it the tally reads the items alone). */
export interface TallyExtra {
  /**
   * The lead's shell helpers by the call that started them (`Session.lanes`, crates/core/src/lanes.rs): one per
   * launch (a loop of two is two), with the model it ran on, how it stands, when it ended and its tokens.
   */
  lanes?: Record<string, { provider: Provider; model: string | null; image: boolean; state: string; ended: number | null; tokens?: number }[]>;
  /** Background Agent calls by call id: when the helper returned (null while it runs), whether it succeeded, its model and tokens. */
  returned?: Record<string, { end: number | null; ok: boolean | null; model?: string | null; tokens?: number }>;
  /** Items after the turn, up to the next helper launch: the lead's checks after a background helper returned land there. */
  after?: TallyItem[];
}

/** The items after `at` up to (not including) the next top-level call that starts a helper. */
export function itemsAfter(items: TallyItem[], at: number): TallyItem[] {
  const out: TallyItem[] = [];
  for (let i = at + 1; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "tool" && (it as { parent: string | null }).parent === null) {
      const t = it as Extract<TallyItem, { kind: "tool" }>;
      if (AGENT.test(t.name) || SPAWN.test(t.name) || (SHELL.test(t.name) && laneOf(cmdOf(t.input)))) break;
    }
    out.push(it);
  }
  return out;
}

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
export function turnTally(items: TallyItem[], agents: Record<string, TallyAgentUse | undefined>, o: { provider: Provider; lead: string | null; tiers: LadderTier[] | null; cross?: LadderTier[] | null }, extra: TallyExtra = {}): Tally {
  const tools = items.filter((i): i is Extract<TallyItem, { kind: "tool" }> => i.kind === "tool");
  const top = tools.filter((t) => t.parent === null);
  const calls = top.filter((t) => AGENT.test(t.name));
  type Lane = { t: (typeof top)[number]; lane: { provider: Provider; model: string | null; image: boolean }; via: "lane" | "spawn" };
  const lanes = top.flatMap((t): Lane[] => {
    if (SPAWN.test(t.name)) {
      const i = (t.input ?? {}) as { model?: unknown; provider?: unknown };
      const p: Provider = i.provider === "codex" || i.provider === "claude" ? i.provider : o.provider;
      return [{ t, lane: { provider: p, model: typeof i.model === "string" ? i.model : null, image: false }, via: "spawn" }];
    }
    if (!SHELL.test(t.name)) return [];
    const lane = laneOf(cmdOf(t.input));
    return lane ? [{ t, lane, via: "lane" }] : [];
  });
  const leadR = modelRank(o.provider, o.lead);
  // When each helper returned (its result in hand), epoch ms; null while it runs.
  const ends = new Map<string, number | null>();
  const native: Delegate[] = calls.map((t) => {
    const use = agents[t.id];
    const bg = backgroundCall(t) ? extra.returned?.[t.id] : undefined;
    const reported = use ? Object.values(use.models).sort((a, b) => b.output + b.input - (a.output + a.input))[0]?.model : undefined;
    const spoke = (items.find((i) => i.kind === "text" && i.parent === t.id && (i as { model: string | null }).model) as { model: string | null } | undefined)?.model;
    // A helper's own transcript knows its model; usage events of agents running side by side can be credited to the wrong one.
    const model = bg?.model || spoke || reported || askedModel(t.input) || null;
    const sum = use ? Object.values(use.models).reduce((n, u) => n + u.input + u.cached + u.output, 0) : 0;
    const kids = tools.filter((k) => k.parent === t.id && SHELL.test(k.name) && TEST_CMD.test(cmdOf(k.input)));
    const background = backgroundCall(t);
    ends.set(t.id, background ? (bg?.end ?? null) : t.endTs);
    const ok = background ? (bg ? bg.ok : null) : t.endTs === null ? null : t.ok;
    return { id: t.id, model, role: roleOf(o.tiers, model, o.provider), provider: o.provider, via: "agent", tokens: bg?.tokens || use?.total || sum, ok, tests: kids.length };
  });
  const roleFor = (lane: { provider: Provider; model: string | null; image: boolean }) =>
    lane.image ? "image" : roleOf(lane.provider === o.provider ? o.tiers : (o.cross ?? null), lane.model, lane.provider);
  const crossed: Delegate[] = lanes.flatMap(({ t, lane, via }): Delegate[] => {
    // Each launch once: a loop or `a & b` starts several from one call (as the backend read them).
    const known = via === "lane" ? extra.lanes?.[t.id] : undefined;
    if (known?.length)
      return known.map((k, i) => {
        const id = `${t.id}#${i}`;
        ends.set(id, k.state === "running" ? null : k.ended);
        const l = { provider: k.provider, model: k.model ?? lane.model, image: k.image || lane.image };
        return { id, model: l.model, role: roleFor(l), provider: l.provider, via, tokens: k.tokens ?? 0, ok: k.state === "running" ? null : k.state === "done", tests: 0 };
      });
    const background = (t.input as { run_in_background?: unknown } | null)?.run_in_background === true;
    ends.set(t.id, background ? null : t.endTs);
    return [{ id: t.id, model: lane.model, role: roleFor(lane), provider: lane.provider, via, tokens: 0, ok: t.endTs === null || background ? null : t.ok, tests: 0 }];
  });
  const callTs = (id: string) => tools.find((t) => t.id === id.split("#")[0])?.ts ?? 0;
  const delegates = [...native, ...crossed].sort((a, b) => callTs(a.id) - callTs(b.id));
  const byModel: Tally["byModel"] = [];
  // One row per model; Claude's alias and full id of one family ("haiku", "claude-haiku-5-5") are the same row.
  const same = (a: string, b: string) => a === b || (o.provider === "claude" && a !== "unknown" && b !== "unknown" && modelFamily(a) === modelFamily(b));
  for (const d of delegates) {
    const k = d.model ?? "unknown";
    const row = byModel.find((r) => r.provider === d.provider && (r.role === "image") === (d.role === "image") && same(r.model, k));
    if (row) {
      row.count++;
      row.tokens += d.tokens;
    } else byModel.push({ model: k, role: d.role, provider: d.provider, count: 1, tokens: d.tokens });
  }
  // On the lead's own model or above it (same CLI): counted, never hidden.
  const onLead = leadR === null ? 0 : delegates.filter((d) => d.provider === o.provider && d.model && (modelRank(o.provider, d.model) ?? -1) >= leadR).length;
  // Checks count from when the first helper returned: before that there is nothing of theirs to check.
  const returnedAt = [...ends.values()].filter((e): e is number => e !== null && e !== undefined);
  const first = returnedAt.length ? Math.min(...returnedAt) : Infinity;
  const laneIds = new Set(lanes.map((l) => l.t.id));
  const callIds = new Set(calls.map((c) => c.id));
  const later = (extra.after ?? []).filter((i): i is Extract<TallyItem, { kind: "tool" }> => i.kind === "tool");
  const mine = [...tools, ...later].filter((t) => t.parent === null && t.ts >= first && !laneIds.has(t.id) && !callIds.has(t.id));
  const shell = (t: (typeof mine)[number]) => (SHELL.test(t.name) ? cmdOf(t.input) : "");
  const tests = mine.filter((t) => TEST_CMD.test(shell(t)));
  // Files the helpers write (`-o`, `> log`) and Claude Code's task output files: reading one is reading a helper's result.
  const written = lanes.flatMap((l) => pathsIn(cmdOf(l.t.input))).filter((p) => p.length > 4).map(pathPattern);
  const readsOutput = (cmd: string) => PEEK_CMD.test(cmd) && pathsIn(cmd).some((p) => p.endsWith(".output") || written.some((w) => w.test(p)));
  return {
    delegates,
    byModel,
    onLead,
    checks: {
      tests: tests.length,
      images: mine.filter((t) => READ.test(t.name) && /\.(png|jpe?g|webp|gif)$/i.test(String((t.input as { file_path?: unknown; path?: unknown } | null)?.file_path ?? (t.input as { path?: unknown } | null)?.path ?? ""))).length,
      testsPassed: tests.filter((t) => t.ok === true).length,
      testsFailed: tests.filter((t) => t.ok === false).length,
      diffs: mine.filter((t) => DIFF_CMD.test(shell(t))).length,
      reads: mine.filter((t) => READ.test(t.name)).length,
      outputs: mine.filter((t) => OUTPUT_TOOL.test(t.name) || readsOutput(shell(t))).length,
      builds: mine.filter((t) => !TEST_CMD.test(shell(t)) && BUILD_CMD.test(shell(t))).length,
      pending: delegates.length > 0 && !returnedAt.length,
    },
    delegateTests: delegates.reduce((n, d) => n + d.tests, 0),
  };
}

/** "2 on Haiku 5.5, 1 on Sonnet 5.5" from a tally (labels via the tier table when the model is on it). */
export function tallyModels(t: Tally, tiers: LadderTier[] | null, cross?: LadderTier[] | null, lead?: Provider): string {
  return t.byModel
    .map((r) => {
      if (r.role === "image") return `${r.count} image · ${r.provider === "codex" ? "GPT" : "Claude"}`;
      const table = lead && r.provider !== lead ? cross : tiers;
      const label = table?.find((x) => x.role === r.role && x.model === r.model)?.label ?? table?.find((x) => x.role === r.role)?.label ?? (r.model === "unknown" ? "an unreported model" : modelLabel(r.model));
      const where = lead && r.provider !== lead ? ` (${r.provider === "codex" ? "Codex" : "Claude"})` : "";
      return `${r.count}${r.role ? ` ${r.role}` : ""} on ${label}${where}`;
    })
    .join(", ");
}

/** Helpers per provider ("3 Claude, 1 Codex"); empty when all ran on the lead's own CLI. */
export function tallyProviders(t: Tally, lead: Provider): string {
  const n = (p: Provider) => t.delegates.filter((d) => d.provider === p).length;
  if (!t.delegates.some((d) => d.provider !== lead)) return "";
  return (["claude", "codex"] as Provider[]).filter((p) => n(p)).map((p) => `${n(p)} ${p === "claude" ? "Claude" : "Codex"}`).join(", ");
}

/**
 * "tests run 2× (1 passed, 1 failed), 1 diff read" — what the lead checked once a helper returned; "helpers still
 * running" before any did; "nothing checked by the lead" when it did none of it.
 */
export function tallyChecks(t: Tally): string {
  const parts: string[] = [];
  const c = t.checks;
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  if (c.tests) parts.push(`tests run ${c.tests}× (${c.testsPassed} passed${c.testsFailed ? `, ${c.testsFailed} failed` : ""})`);
  if (c.builds) parts.push(`build or typecheck run ${c.builds}×`);
  if (c.diffs) parts.push(`${n(c.diffs, "diff")} read`);
  if (c.outputs) parts.push(`${n(c.outputs, "helper output")} read`);
  if (c.reads) parts.push(`${n(c.reads, "file")} reread`);
  if (c.images) parts.push(`${n(c.images, "image")} viewed`);
  if (parts.length) return parts.join(", ");
  return c.pending ? "helpers still running" : "nothing checked by the lead";
}

// ---------- the budget picture (chip, Settings) ----------

/** "in 2 h 5 min" / "in 3 days". */
export function untilWords(now: number, at: number): string {
  const m = Math.max(0, Math.floor((at - now) / 60_000));
  if (m < 60) return `in ${m} min`;
  if (m < 48 * 60) return `in ${Math.floor(m / 60)} h ${m % 60} min`;
  return `in ${Math.floor(m / (24 * 60))} days`;
}

/**
 * One account's line: "Max 5x · 5-hour 27%, resets in 3 h 0 min", flagged tight at 80% or within the reserve (the
 * lead plans narrow there; `can` and `spawn` refuse inside the reserve). `cli`: installed / logged in, when known.
 */
export function budgetLine(
  u: { plan: string | null; windows: { label: string; used_percent: number | null; resets_ms: number | null }[]; error: string | null } | null,
  reserve: number,
  now: number,
  cli: { installed: boolean; loggedIn: boolean | null } | null,
): { text: string; tight: boolean } {
  if (cli && !cli.installed) return { text: "not installed", tight: false };
  if (cli && cli.loggedIn === false) return { text: "not logged in", tight: true };
  if (!u) return { text: "usage not read yet", tight: false };
  const ws = u.windows.filter((w) => w.used_percent !== null);
  const top = ws.sort((a, b) => (b.used_percent ?? 0) - (a.used_percent ?? 0))[0];
  const plan = u.plan ? `${u.plan} · ` : "";
  if (!top) return { text: `${plan}${u.error ? "usage unavailable" : "no limits reported"}`, tight: false };
  const pct = Math.round(top.used_percent ?? 0);
  const out = pct >= 100 - reserve;
  const reset = top.resets_ms ? `, resets ${untilWords(now, top.resets_ms)}` : "";
  return { text: `${plan}${top.label} ${pct}%${reset}${out ? " · in reserve: no new helpers" : ""}`, tight: out || pct >= 80 };
}
