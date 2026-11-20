// `?ladder=demo`: a Claude chat on Opus launched with Ladder. Turn one is finished: the lead spawned three delegates in
// parallel (two on Haiku, one on Sonnet; one ran the tests), then checked with `git diff --stat` and `pnpm test`.
// Turn two is still running with two delegates live, so Mission control's fan-out shows the tiers. See lib/ladderTiers.ts.

import { noteLaunched } from "./ladder";
import type { MockChat } from "./mockChat";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const rid = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

interface Delegate {
  desc: string;
  alias: "haiku" | "sonnet";
  model: string;
  steps: { name: string; summary: string; input: unknown; ms: number }[];
  say: string;
  tokens: number;
  /** false: left running (turn two). */
  finish: boolean;
}

const P = "src/lib";
const sh = (command: string) => ({ command });
const ONE: Delegate[] = [
  {
    desc: "Rename formatBytes call sites", alias: "haiku", model: "claude-haiku-5-5", tokens: 14_200, finish: true,
    say: "Renamed formatBytes to fmtBytes in 11 files; no other references remain.",
    steps: [{ name: "Grep", summary: "formatBytes", input: { pattern: "formatBytes" }, ms: 500 }, { name: "Edit", summary: `${P}/format.ts`, input: {}, ms: 600 }, { name: "Edit", summary: "src/components/Models.tsx", input: {}, ms: 600 }],
  },
  {
    desc: "Add unit tests for tokTotal", alias: "haiku", model: "claude-haiku-5-5", tokens: 17_900, finish: true,
    say: "Added 6 cases to tokTotal.test.ts; all pass.",
    steps: [{ name: "Read", summary: `${P}/tokens.ts`, input: {}, ms: 500 }, { name: "Write", summary: `${P}/tokTotal.test.ts`, input: {}, ms: 700 }, { name: "Bash", summary: "pnpm test tokTotal", input: sh("pnpm test tokTotal"), ms: 1200 }],
  },
  {
    desc: "Fix the stale cache in useModels", alias: "sonnet", model: "claude-sonnet-5-5", tokens: 26_800, finish: true,
    say: "useModels no longer returns a stale list after a login switch; the cache is keyed by account.",
    steps: [{ name: "Read", summary: `${P}/models.ts`, input: {}, ms: 500 }, { name: "Grep", summary: "useModels", input: { pattern: "useModels" }, ms: 500 }, { name: "Edit", summary: `${P}/models.ts`, input: {}, ms: 700 }, { name: "Bash", summary: "pnpm test", input: sh("pnpm test"), ms: 1300 }],
  },
];
const TWO: Delegate[] = [
  { desc: "Port the settings rows to the new primitives", alias: "sonnet", model: "claude-sonnet-5-5", tokens: 21_400, finish: false, say: "", steps: [{ name: "Read", summary: "src/components/SettingsPage.tsx", input: {}, ms: 400 }, { name: "Edit", summary: "src/components/SettingsPage.tsx", input: {}, ms: 400 }, { name: "Read", summary: "src/components/primitives.tsx", input: {}, ms: 400 }] },
  { desc: "Collect every TODO into a list", alias: "haiku", model: "claude-haiku-5-5", tokens: 9_300, finish: false, say: "", steps: [{ name: "Grep", summary: "TODO", input: { pattern: "TODO" }, ms: 400 }, { name: "Read", summary: "src/lib/mock.ts", input: {}, ms: 400 }] },
];

export async function runLadderChat(c: MockChat) {
  c.always.add("Bash");
  c.always.add("Edit");
  c.always.add("Write");
  noteLaunched(c.id, {
    tiers: [
      { role: "mid", model: "sonnet", label: "Sonnet 5.5" },
      { role: "small", model: "haiku", label: "Haiku 5.5" },
      { role: "bulk", model: "haiku", label: "Haiku 5.5" },
    ],
    max_parallel: 4,
    verify_tests: true,
  });
  await wait(900);
  let out = 0;
  const usage = (model: string) => {
    out += 300 + Math.floor(Math.random() * 200);
    c.emit({ type: "usage", model, tokens: { input: out * 4, cached: out * 9, output: out, context: 60_000 }, context_window: 1_000_000 });
  };
  const tool = async (name: string, summary: string, input: unknown, ms: number, parent: string | null, ok = true) => {
    const id = `toolu_${rid()}`;
    c.emit({ type: "tool_start", id, name, summary, input, parent_tool_id: parent });
    await wait(ms);
    c.emit({ type: "tool_end", id, ok, output: ok ? "ok" : "failed" });
    return id;
  };
  const delegate = async (d: Delegate) => {
    const aid = `toolu_${rid()}`;
    c.emit({ type: "tool_start", id: aid, name: "Agent", summary: d.desc, input: { subagent_type: "general-purpose", description: d.desc, prompt: `${d.desc}. Keep the change small and run the relevant tests before you report.`, model: d.alias }, parent_tool_id: null });
    for (const s of d.steps) {
      if (s.name === "Bash") {
        const id = `toolu_${rid()}`;
        c.emit({ type: "tool_start", id, name: "Bash", summary: s.summary, input: s.input, parent_tool_id: aid });
        await wait(s.ms);
        c.emit({ type: "tool_end", id, ok: true, output: "Tests  6 passed" });
      } else await tool(s.name, s.summary, s.input, s.ms, aid);
      c.emit({ type: "assistant_message", id: `msg_${rid()}`, text: `Checked ${s.summary}.`, model: d.model, parent_tool_id: aid });
      usage(d.model);
    }
    c.emit({ type: "agent_total", tool_id: aid, tokens: d.tokens });
    if (!d.finish) return;
    c.emit({ type: "assistant_message", id: `msg_${rid()}`, text: d.say, model: d.model, parent_tool_id: aid });
    usage(d.model);
    c.emit({ type: "agent_total", tool_id: aid, tokens: d.tokens });
    c.emit({ type: "tool_end", id: aid, ok: true, output: d.say });
  };

  // Turn one: finished.
  c.ensureSession();
  c.emit({ type: "user_message", id: `u_${rid()}`, text: "Rename formatBytes, add tokTotal tests and fix the stale useModels cache" });
  c.setState("working");
  c.turnStart = Date.now();
  await wait(400);
  c.emit({ type: "assistant_message", id: `msg_${rid()}`, text: "Three independent pieces. I'll brief a delegate for each, in parallel, then check the results myself.", model: c.model, parent_tool_id: null });
  usage(c.model);
  await Promise.all(ONE.map((d, i) => wait(i * 250).then(() => delegate(d))));
  await tool("Bash", "git diff --stat", sh("git diff --stat"), 600, null);
  await tool("Bash", "pnpm test", sh("pnpm test"), 1500, null);
  c.emit({ type: "assistant_message", id: `msg_${rid()}`, text: "All three pieces are in and I checked them: the diff touches 14 files as briefed and the full test run passes. The cache is now keyed by account.", model: c.model, parent_tool_id: null });
  usage(c.model);
  c.emit({ type: "turn_end", duration_ms: Date.now() - c.turnStart, ok: true });
  c.setState("idle");

  // Turn two: two delegates still working.
  await wait(500);
  c.emit({ type: "user_message", id: `u_${rid()}`, text: "Now port the settings rows to the new primitives and list every TODO" });
  c.setState("working");
  c.turnStart = Date.now();
  await wait(400);
  c.emit({ type: "assistant_message", id: `msg_${rid()}`, text: "Two pieces again: the port needs care, the TODO sweep is mechanical.", model: c.model, parent_tool_id: null });
  usage(c.model);
  await Promise.all(TWO.map((d, i) => wait(i * 250).then(() => delegate(d))));
}
