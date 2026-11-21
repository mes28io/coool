import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetLine, candidates, crossTable, imageLane, itemsAfter, laneOf, modelRank, roleOf, sameTier, tallyChecks, tallyModels, tallyProviders, tierRows, tierTable, turnTally, untilWords, type TallyItem } from "./ladderTiers.ts";

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
  assert.deepEqual(t.checks, { tests: 2, images: 0, testsPassed: 1, testsFailed: 1, diffs: 1, reads: 1, outputs: 0, builds: 0, pending: false });
  assert.equal(t.delegateTests, 1);
  assert.equal(tallyChecks(t), "tests run 2× (1 passed, 1 failed), 1 diff read, 1 file reread");
  assert.equal(tallyModels(t, tiers), "2 small on Haiku 5.5, 1 mid on Sonnet 5.5");
});

test("a delegate on the lead's own model is counted, not hidden", () => {
  const t = turnTally([tool("a", "Agent", { prompt: "x" }, 1), { kind: "text", parent: "a", model: "claude-opus-5-5" }], {}, { provider: "claude", lead: "claude-opus-5-5", tiers: null });
  assert.equal(t.onLead, 1);
  assert.equal(tallyChecks(t), "nothing checked by the lead");
  assert.equal(turnTally([], {}, { provider: "codex", lead: null, tiers: null }).delegates.length, 0);
});

// What codex 0.171 lists (`codex debug models`, visibility "list").
const CODEX6 = [
  { id: "gpt-6.2-sol", label: "GPT-6.2-Sol" },
  { id: "gpt-6.2-astra", label: "GPT-6.2-Astra" },
  { id: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
  { id: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
  { id: "gpt-6-astra", label: "GPT-6-Astra" },
  { id: "gpt-6-luna", label: "GPT-6-Luna" },
  { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
];
const CLAUDE55 = [...CLAUDE, { id: "claude-fable-5-2", label: "Fable 5.2" }];

test("the owner's example: a Fable lead orchestrates Opus, Sonnet, Haiku and Codex's strong and small models", () => {
  const lead = "claude-fable-5-2";
  assert.deepEqual(sameTier("claude", lead, CLAUDE55), { role: "same", model: "fable", label: "Fable 5.2" });
  assert.deepEqual(tierTable("claude", lead, CLAUDE55).map((t) => [t.role, t.model]), [
    ["mid", "opus"],
    ["small", "sonnet"],
    ["bulk", "haiku"],
  ]);
  assert.deepEqual(crossTable("claude", lead, CODEX6).map((t) => [t.role, t.model]), [
    ["peer", "gpt-6.2-astra"],
    ["exec", "gpt-6.2-sol"],
    ["bulk", "gpt-6-luna"],
  ]);
  assert.deepEqual(imageLane("claude", lead, CODEX6), { provider: "codex", model: "gpt-6-luna", label: "GPT-6-Luna" });
});

test("an Opus lead: helpers on Opus (parallel only), Sonnet or Haiku, and Codex's strong lanes", () => {
  const lead = "claude-opus-5-5";
  assert.equal(sameTier("claude", lead, CLAUDE55)?.model, "opus");
  assert.deepEqual(tierTable("claude", lead, CLAUDE55).map((t) => t.model), ["sonnet", "haiku", "haiku"]);
  assert.deepEqual(crossTable("claude", lead, CODEX6).map((t) => t.model), ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6-luna"]);
});

test("cross lanes never sit above the lead", () => {
  // Sonnet: Codex one rank below (terra, luna), never sol or astra.
  assert.deepEqual(crossTable("claude", "sonnet", CODEX6).map((t) => [t.role, t.model]), [
    ["exec", "gpt-6.1-terra"],
    ["bulk", "gpt-6-luna"],
  ]);
  // Haiku: only Codex's smallest.
  assert.deepEqual(crossTable("claude", "claude-haiku-5-5", CODEX6).map((t) => [t.role, t.model]), [
    ["exec", "gpt-6-luna"],
    ["bulk", "gpt-6-luna"],
  ]);
  // A Codex lead: Claude at or below its rank (Sonnet and Haiku for sol; Haiku for terra; nothing for luna).
  assert.deepEqual(crossTable("codex", "gpt-6.2-sol", CLAUDE).map((t) => [t.role, t.model]), [
    ["mid", "sonnet"],
    ["bulk", "haiku"],
  ]);
  assert.deepEqual(crossTable("codex", "gpt-6.1-terra", CLAUDE).map((t) => t.model), ["haiku", "haiku"]);
  assert.deepEqual(crossTable("codex", "gpt-6-luna", CLAUDE), []);
  // Nothing known of the other CLI: no lanes.
  assert.deepEqual(crossTable("claude", "opus", []), []);
  // The CLI's default lead (unknown): no same tier.
  assert.equal(sameTier("claude", null, CLAUDE), null);
  assert.equal(imageLane("claude", "opus", []), null);
  assert.deepEqual(imageLane("codex", "gpt-6.2-sol", []), { provider: "codex", model: "gpt-6.2-sol", label: "gpt-6.2-sol" });
});

test("lanes from the shell: codex exec and claude -p, image work recognised", () => {
  assert.deepEqual(laneOf(`codex exec -m gpt-6-luna -c model_reasoning_effort="low" -s workspace-write -C . "Generate an app icon, save as assets/icon.png" < /dev/null`), { provider: "codex", model: "gpt-6-luna", image: true });
  assert.deepEqual(laneOf("cd x && codex exec --model gpt-6.2-sol -s read-only 'review the parser'"), { provider: "codex", model: "gpt-6.2-sol", image: false });
  assert.deepEqual(laneOf("claude -p --model haiku --permission-mode default 'summarise'"), { provider: "claude", model: "haiku", image: false });
  assert.equal(laneOf("codex --version"), null);
  assert.equal(laneOf("echo claude"), null);
});

test("the tally counts helpers per tier and provider, and an image helper as image · GPT", () => {
  const lead = "claude-opus-5-5";
  const tiers = tierTable("claude", lead, CLAUDE55);
  const cross = crossTable("claude", lead, CODEX6);
  const items: TallyItem[] = [
    tool("a1", "Agent", { model: "haiku", prompt: "x" }, 10),
    tool("l1", "Bash", { command: "codex exec -m gpt-6.2-sol -s workspace-write 'write parse_date in util.py'" }, 11),
    tool("l2", "Bash", { command: "codex exec -m gpt-6-luna -s workspace-write 'Generate an icon image, save at assets/icon.png'" }, 12),
    tool("s1", "mcp__coool-ladder__spawn", { model: "sonnet", brief: "refactor" }, 13),
    tool("v1", "Read", { file_path: "/p/assets/icon.png" }, 20),
    tool("c1", "Bash", { command: "pnpm test" }, 21),
  ];
  const t = turnTally(items, {}, { provider: "claude", lead, tiers, cross });
  assert.equal(t.delegates.length, 4);
  assert.deepEqual(t.delegates.map((d) => [d.provider, d.via, d.role]), [
    ["claude", "agent", "small"],
    ["codex", "lane", "exec"],
    ["codex", "lane", "image"],
    ["claude", "spawn", "mid"],
  ]);
  assert.equal(tallyModels(t, tiers, cross, "claude"), "1 small on Haiku 5.5, 1 exec on GPT-6.2-Sol (Codex), 1 image · GPT, 1 mid on Sonnet 5.5");
  assert.equal(tallyProviders(t, "claude"), "2 Claude, 2 Codex");
  assert.equal(t.checks.images, 1);
  assert.equal(t.checks.tests, 1);
  assert.match(tallyChecks(t), /1 image viewed/);
  // The lane commands themselves are not the lead's checks.
  assert.equal(t.checks.diffs, 0);
  // All on the lead's own CLI: no provider split shown.
  assert.equal(tallyProviders(turnTally([tool("a", "Agent", { model: "haiku" }, 1)], {}, { provider: "claude", lead, tiers }), "claude"), "");
});

test("the budget line: plan, fullest window, reset, tight and reserve", () => {
  const now = 0;
  const u = (pct: number) => ({ plan: "Max 5x", error: null, windows: [{ label: "5-hour", used_percent: pct, resets_ms: 3 * 3600_000 }, { label: "Weekly", used_percent: 10, resets_ms: 72 * 3600_000 }] });
  assert.deepEqual(budgetLine(u(27), 10, now, { installed: true, loggedIn: true }), { text: "Max 5x · 5-hour 27%, resets in 3 h 0 min", tight: false });
  assert.equal(budgetLine(u(85), 10, now, null).tight, true);
  assert.match(budgetLine(u(92), 10, now, null).text, /in reserve: no new helpers/);
  assert.deepEqual(budgetLine(null, 10, now, { installed: false, loggedIn: null }), { text: "not installed", tight: false });
  assert.equal(budgetLine(u(5), 10, now, { installed: true, loggedIn: false }).text, "not logged in");
  assert.equal(budgetLine(null, 10, now, null).text, "usage not read yet");
  assert.equal(untilWords(0, 3 * 86400_000), "in 3 days");
  assert.equal(untilWords(0, 59 * 60_000), "in 59 min");
});

test("the tally counts each shell launch once, takes background helpers' real ends, and counts the lead's real checks after they return", () => {
  const lead = "claude-opus-5-5";
  const tiers = tierTable("claude", "opus", CLAUDE);
  const cross = crossTable("claude", lead, CODEX6);
  const ACK = "Async agent launched successfully.\nagentId: a7 (internal ID)";
  const loop = 'for p in tasks bench; do (codex exec -m gpt-6.2-sol -C /tmp/wt/$p -o /tmp/s/report-$p.txt "go" > /tmp/s/log-$p.txt 2>&1) & done';
  const turn: TallyItem[] = [
    { ...tool("r", "Agent", { model: "sonnet", description: "Research", run_in_background: true }, 10, { endTs: 10 }), output: ACK } as TallyItem,
    { ...tool("h", "Agent", { model: "haiku", description: "Summarise", run_in_background: true }, 11, { endTs: 11 }), output: ACK } as TallyItem,
    tool("b", "Agent", { model: "sonnet", description: "Build", run_in_background: true }, 12, { endTs: 12 }),
    tool("L", "Bash", { command: loop, run_in_background: true }, 13),
    tool("p", "Bash", { command: 'pgrep -fl "codex exec"' }, 14),
  ];
  const running = { provider: "codex" as const, model: "gpt-6.2-sol", image: false, state: "running", ended: null, tokens: 0 };
  // While every helper still runs: nothing of theirs to check yet.
  const early = turnTally(turn, {}, { provider: "claude", lead, tiers, cross }, { lanes: { L: [running, running] }, returned: { r: { end: null, ok: null, model: "claude-sonnet-5-5" }, h: { end: null, ok: null, model: "claude-haiku-5-5" } } });
  assert.equal(early.delegates.length, 5, "3 Claude agents and both Codex launches of the loop");
  assert.deepEqual(early.delegates.map((d) => d.ok), [null, null, null, null, null], "a launch acknowledgement is not a return");
  assert.equal(tallyProviders(early, "claude"), "3 Claude, 2 Codex");
  assert.equal(tallyModels(early, tiers, cross, "claude"), "2 mid on Sonnet 5.5, 1 small on Haiku 5.5, 2 exec on GPT-6.2-Sol (Codex)");
  assert.equal(tallyChecks(early), "helpers still running", "the progress check is not a check of their work");
  // Later turns, up to the next helper launch: the research agent returned at 20; the lead read a Codex helper's log,
  // typechecked, ran the tests and looked at the diff.
  const later: TallyItem[] = [
    tool("x1", "Bash", { command: "tail -c 300 /tmp/s/log-bench.txt" }, 25),
    tool("x2", "Bash", { command: "pnpm -C app tsc --noEmit" }, 26),
    tool("x3", "Bash", { command: "pnpm test" }, 27),
    tool("x4", "Bash", { command: "git -C /tmp/wt/bench diff --stat" }, 28),
    tool("x5", "BashOutput", { bash_id: "b1" }, 29),
    tool("n1", "Agent", { model: "haiku", prompt: "next" }, 30),
    tool("x6", "Bash", { command: "pnpm test" }, 31),
  ];
  const all = [...turn, { kind: "turn" } as TallyItem, ...later];
  const after = itemsAfter(all, turn.length);
  assert.equal(after.length, 5, "stops at the next helper launch");
  const t = turnTally(turn, {}, { provider: "claude", lead, tiers, cross }, {
    lanes: { L: [{ ...running, state: "done", ended: 40, tokens: 242_000 }, { ...running, tokens: 120_000 }] },
    returned: { r: { end: 20, ok: true, model: "claude-sonnet-5-5", tokens: 100_000 }, h: { end: 22, ok: true, model: "claude-haiku-5-5", tokens: 50_000 } },
    after,
  });
  assert.deepEqual(t.delegates.map((d) => d.ok), [true, true, null, true, null]);
  assert.equal(t.delegates.reduce((n, d) => n + d.tokens, 0), 512_000);
  assert.deepEqual(t.checks, { tests: 1, images: 0, testsPassed: 1, testsFailed: 0, diffs: 1, reads: 0, outputs: 2, builds: 1, pending: false });
  assert.equal(tallyChecks(t), "tests run 1× (1 passed), build or typecheck run 1×, 1 diff read, 2 helper outputs read");
  // Without the session's records a loop is one launch (as before), and its model comes from the command.
  assert.equal(turnTally(turn, {}, { provider: "claude", lead, tiers, cross }).delegates.filter((d) => d.provider === "codex").length, 1);
});

test("a Codex lead's claude -p helpers are counted per launch", () => {
  const items: TallyItem[] = [tool("c7", "exec_command", { cmd: 'claude -p --model haiku "Summarise the README"' }, 1, { endTs: 40 })];
  const t = turnTally(items, {}, { provider: "codex", lead: "gpt-6.2-sol", tiers: null, cross: crossTable("codex", "gpt-6.2-sol", CLAUDE) }, { lanes: { c7: [{ provider: "claude", model: "claude-haiku-5-5", image: false, state: "done", ended: 40, tokens: 220 }] } });
  assert.deepEqual(t.delegates.map((d) => [d.provider, d.model, d.role, d.ok, d.tokens]), [["claude", "claude-haiku-5-5", "bulk", true, 220]]);
});
