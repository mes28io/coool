// `?plan=chat`: a chat in the coool folder that runs the plan scenarios back to back
// (see the "Plan scenarios" note in mockChat.ts): a todo list that progresses (~+3s),
// one that stops with steps left (~+16s), a Codex-style update_plan (~+26s) and a
// plan-mode proposal that waits for approval (~+38s). `?plan=demo` is the standalone card.

import type { MockChat } from "./mockChat";

export async function runPlanChat(c: MockChat) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  c.always.add("Bash");
  c.always.add("Edit");
  c.always.add("Write");
  await wait(3000);
  c.send("Work through the todo list for the retry change");
  await wait(14000);
  c.send("Same again but todo stop early");
  await wait(11000);
  c.send("Show me the codex plan for it");
  await wait(11000);
  c.send("Now in plan mode, propose how to ship it");
}

/** `?steer=demo`: a chat mid-run (a slow multi-step turn, ~3s a step, 8 steps) to steer by typing into its composer. */
export async function runSteerDemo(c: MockChat) {
  c.always.add("Bash");
  c.always.add("Edit");
  c.always.add("Write");
  await new Promise((r) => setTimeout(r, 1500));
  c.send("Migrate the sync layer, slow steps please");
}

/** `?md=demo`: a chat whose reply exercises the markdown renderer, streamed slowly. */
export async function runMdDemo(c: MockChat) {
  await new Promise((r) => setTimeout(r, 1500));
  c.send("Run the markdown demo for my disk usage");
}
