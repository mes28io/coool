// Demo chat for the Checkpoints card. Open the browser build with `?checkpoints=demo`:
// a chat in the coool folder that has three finished turns, then (in real time, from
// load) completes a 4th at ~+5s and a 5th at ~+9s, fails the 6th at ~+14s, is retried
// at ~+18s (a new attempt branch), and leaves an 8th turn in progress whose steps keep
// arriving, for ~25s. Seeded turns use virtual time so the first row reads minutes in.

import type { MockChat } from "./mockChat";

interface Step {
  name: string;
  summary: string;
  input?: unknown;
  ms?: number;
  fail?: boolean;
  output?: string;
}

const F = "/Users/demo/coool/app/src";
const edit = (file: string, ms = 700): Step => ({ name: "Edit", summary: file, input: { file_path: `${F}/${file}`, old_string: "const plan = basic;\nreturn plan", new_string: "const plan = pro(tier);\nreturn plan" }, ms, output: "Updated 2 hunks" });
const read = (file: string, ms = 500): Step => ({ name: "Read", summary: file, input: { file_path: `${F}/${file}` }, ms, output: "180 lines" });
const git = (cmd: string): Step => ({ name: "Bash", summary: cmd, input: { command: cmd }, ms: 700, output: "done" });
const bash = (cmd: string, ms = 900, fail = false): Step => ({ name: "Bash", summary: cmd, input: { command: cmd }, ms, fail, output: fail ? "error: 3 tests failed" : "ok" });

let n = 0;
const id = () => `demo_${++n}`;

async function turn(c: MockChat, prompt: string, steps: Step[], opts: { fail?: boolean; hold?: boolean; reply?: string } = {}) {
  const gen = c.gen;
  c.ensureSession();
  c.emit({ type: "user_message", id: id(), text: prompt });
  c.setState("working");
  const start = c.now();
  await c.sleep(400, gen);
  for (const s of steps) {
    const tid = id();
    c.emit({ type: "tool_start", id: tid, name: s.name, summary: s.summary, input: s.input ?? {}, parent_tool_id: null });
    await c.sleep(s.ms ?? 700, gen);
    c.emit({ type: "tool_end", id: tid, ok: !s.fail, output: s.output ?? "" });
  }
  if (opts.hold) return;
  const mid = id();
  const text = opts.reply ?? "Done. The change is in place.";
  c.emit({ type: "assistant_message", id: mid, text, model: c.model, parent_tool_id: null });
  c.total = { input: c.total.input + 1800, cached: c.total.cached + 9000, output: c.total.output + 900 + Math.round(Math.random() * 700) };
  c.emit({ type: "usage", model: c.model, tokens: { ...c.total, context: 40_000 }, context_window: 1_000_000 });
  c.emit({ type: "turn_end", duration_ms: c.now() - start, ok: !opts.fail });
  c.setState("idle");
}

export async function runCheckpointsDemo(c: MockChat) {
  c.vt = Date.now() - 9 * 60_000;
  await turn(c, "Read the brief and sketch the pricing page", [read("pages/pricing.tsx"), read("lib/plans.ts")]);
  c.vt += 40_000;
  await turn(c, "Scaffold the pricing page with the three plans", [edit("pages/pricing.tsx"), edit("components/PlanCard.tsx"), { name: "Write", summary: "components/PlanTable.tsx", input: { file_path: `${F}/components/PlanTable.tsx` }, output: "Created" }]);
  c.vt += 40_000;
  await turn(c, "Write the plan copy, short and plain", [edit("lib/plans.ts")]);
  c.vt = null;

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(5000);
  await turn(c, "Build the pricing comparison table", [read("components/PlanTable.tsx"), edit("components/PlanTable.tsx"), edit("styles/table.css")]);
  await wait(1500);
  await turn(c, "Add the Stripe checkout button, then run the tests", [edit("pages/pricing.tsx"), edit("lib/checkout.ts"), edit("lib/stripe.ts"), edit("lib/stripe.ts"), bash("pnpm test", 1000), git("git add -A && git commit -m \"Add Stripe checkout\"")]);
  await wait(2000);
  await turn(c, "Wire the plan picker to the checkout", [edit("components/PlanPicker.tsx"), bash("pnpm test", 1200, true)], { fail: true, reply: "Tests fail: 3 of 12." });
  await wait(3000);
  await turn(c, "Switch to Stripe Elements instead of the redirect", [read("lib/checkout.ts"), edit("lib/checkout.ts"), edit("components/PlanPicker.tsx"), bash("pnpm test", 1000)]);
  await wait(2500);
  await turn(
    c,
    "Make the tests pass and ship it",
    [read("lib/checkout.ts"), edit("lib/checkout.ts", 1500), bash("pnpm test", 2200), edit("components/PlanPicker.tsx", 2000), edit("styles/table.css", 2000), bash("pnpm build", 3000), edit("pages/pricing.tsx", 2500)],
    { reply: "All green. Pricing page shipped." },
  );
}
