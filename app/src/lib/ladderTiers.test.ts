import { test } from "node:test";
import assert from "node:assert/strict";
import { candidates, modelRank, roleOf, tallyChecks, tallyModels, tierRows, tierTable, turnTally, type TallyItem } from "./ladderTiers.ts";

// What Claude Code 2.1.329 reported in `initialize.models` (aliases first, then ids), trimmed.
const CLAUDE = [
  { id: "default", label: "Default (recommended)" },
  { id: "opus", label: "Opus 5.5" },
  { id: "fable", label: "Fable 5.2" },
  { id: "sonnet", label: "Sonnet 5.5" },
  { id: "haiku", label: "Haiku 5.5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
];
// What codex 0.145 `model/list` reported.
const CODEX = [
  { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
  { id: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
  { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
];

test("Claude: the lead is never a tier, and each tier is a cheaper family alias with the CLI's label", () => {
  assert.deepEqual(tierTable("claude", "claude-opus-5-5", CLAUDE), [
    { role: "mid", model: "sonnet", label: "Sonnet 5.5" },
    { role: "small", model: "haiku", label: "Haiku 5.5" },
    { role: "bulk", model: "haiku", label: "Haiku 5.5" },
  ]);
  const fable = tierTable("claude", "fable", CLAUDE).map((t) => t.model);
  assert.deepEqual(fable, ["opus", "sonnet", "haiku"]);
  // Sonnet leads: Haiku carries every role.
  assert.deepEqual(new Set(tierTable("claude", "sonnet", CLAUDE).map((t) => t.model)), new Set(["haiku"]));
  // Haiku leads: nothing is cheaper, so no table (the lead works alone with the same checks).
  assert.deepEqual(tierTable("claude", "claude-haiku-5-5", CLAUDE), []);
  // CLI default (unknown lead): assumed Opus-class, so Opus is never a delegate by accident.
  assert.deepEqual(tierTable("claude", null, CLAUDE).map((t) => t.model), ["sonnet", "haiku", "haiku"]);
});

test("Claude with only full ids reported: the families they belong to, labelled by the newest id", () => {
  const ids = [
    { id: "claude-opus-5-5", label: "Opus 5.5" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
    { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  ];
  assert.deepEqual(tierTable("claude", "claude-opus-5-5", ids).map((t) => [t.model, t.label]), [
    ["sonnet", "Sonnet 5.5"],
    ["haiku", "Haiku 5.5"],
    ["haiku", "Haiku 5.5"],
  ]);
});

test("Claude before any chat reported models: the plain aliases", () => {
  assert.deepEqual(tierTable("claude", "opus", []), [
    { role: "mid", model: "sonnet", label: "Sonnet" },
    { role: "small", model: "haiku", label: "Haiku" },
    { role: "bulk", model: "haiku", label: "Haiku" },
  ]);
});

test("Codex: ranked by the size words in its model names", () => {
  assert.deepEqual(
    tierTable("codex", "gpt-5.6-sol", CODEX).map((t) => [t.role, t.model]),
    [
      ["mid", "gpt-5.6-terra"],
      ["small", "gpt-5.6-luna"],
      ["bulk", "gpt-5.6-luna"],
    ],
  );
  assert.equal(modelRank("codex", "gpt-5.1-codex-mini"), 1);
  assert.equal(modelRank("codex", "gpt-5.1-codex"), 3);
  // Newest version wins within a level.
  const c = candidates("codex", [...CODEX, { id: "gpt-6-luna", label: "GPT-6-Luna" }]);
  assert.equal(c.find((x) => x.rank === 1)?.model, "gpt-6-luna");
  assert.deepEqual(tierTable("codex", "gpt-5.6-luna", CODEX), []);
});

test("cap and picks", () => {
  const capped = tierTable("claude", "fable", CLAUDE, { cap: "small" });
  assert.deepEqual(capped.map((t) => t.model), ["sonnet", "sonnet", "haiku"]);
  const picked = tierTable("claude", "opus", CLAUDE, { pick: { mid: "haiku" } });
  assert.equal(picked[0].model, "haiku");
  // A pick that is not cheaper than the lead is ignored.
  assert.equal(tierTable("claude", "sonnet", CLAUDE, { pick: { mid: "opus" } })[0].model, "haiku");
});

test("rows fold roles that share a model; roleOf maps full ids onto aliases", () => {
  const t = tierTable("claude", "opus", CLAUDE);
  assert.deepEqual(tierRows(t).map((r) => [r.roles.join("+"), r.model]), [
    ["mid", "sonnet"],
    ["small+bulk", "haiku"],
  ]);
  assert.equal(roleOf(t, "claude-haiku-5-5", "claude"), "small");
  assert.equal(roleOf(t, "claude-opus-5-5", "claude"), null);
  assert.equal(roleOf(null, "haiku", "claude"), null);
});

const tool = (id: string, name: string, input: unknown, ts: number, o: Partial<{ parent: string | null; ok: boolean | null; endTs: number | null }> = {}): TallyItem => ({
  kind: "tool",
  id,
  name,
  input,
  ts,
  endTs: o.endTs === undefined ? ts + 1 : o.endTs,
  ok: o.ok === undefined ? true : o.ok,
  parent: o.parent ?? null,
});

test("the tally counts what ran, on which model, and what the lead checked afterwards", () => {
  const tiers = tierTable("claude", "opus", CLAUDE);
  const items: TallyItem[] = [
    tool("r0", "Bash", { command: "pnpm test" }, 1), // before any delegate: not a check of their work
    tool("a1", "Agent", { model: "haiku", prompt: "rename" }, 10),
    tool("a2", "Agent", { model: "haiku", prompt: "rename 2" }, 10),
    tool("a3", "Agent", { model: "sonnet", prompt: "feature" }, 10),
    { kind: "text", parent: "a3", model: "claude-sonnet-5-5" },
    tool("k1", "Bash", { command: "cd app && pnpm test -- --run" }, 12, { parent: "a3" }),
    tool("c1", "Bash", { command: "git diff --stat" }, 30),
    tool("c2", "Bash", { command: "pnpm test" }, 31, { ok: false }),
    tool("c3", "Bash", { command: "pnpm test" }, 40),
    tool("c4", "Read", { file_path: "/x/a.ts" }, 41),
  ];
  const agents = {
    a1: { models: { "claude-haiku-5-5": { model: "claude-haiku-5-5", input: 100, cached: 900, output: 50 } }, total: 1200 },
    a2: { models: {}, total: 800 },
  };
  const t = turnTally(items, agents, { provider: "claude", lead: "claude-opus-5-5", tiers });
  assert.equal(t.delegates.length, 3);
  assert.deepEqual(
    t.byModel.map((r) => [r.model, r.role, r.count, r.tokens]),
    [
      ["claude-haiku-5-5", "small", 2, 2000],
      ["claude-sonnet-5-5", "mid", 1, 0],
    ],
  );
  assert.equal(t.onLead, 0);
  assert.deepEqual(t.checks, { tests: 2, testsPassed: 1, testsFailed: 1, diffs: 1, reads: 1 });
  assert.equal(t.delegateTests, 1);
  assert.equal(tallyChecks(t), "tests run 2× (1 passed, 1 failed), 1 diff read, 1 file reread");
  assert.equal(tallyModels(t, tiers), "2 on Haiku 5.5, 1 on Sonnet 5.5");
});

test("a delegate on the lead's own model is counted, not hidden", () => {
  const t = turnTally([tool("a", "Agent", { prompt: "x" }, 1), { kind: "text", parent: "a", model: "claude-opus-5-5" }], {}, { provider: "claude", lead: "claude-opus-5-5", tiers: null });
  assert.equal(t.onLead, 1);
  assert.equal(tallyChecks(t), "nothing checked by the lead");
  assert.equal(turnTally([], {}, { provider: "codex", lead: null, tiers: null }).delegates.length, 0);
});
