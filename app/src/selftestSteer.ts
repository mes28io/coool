// Self-test `steer-queue` (CHAT_SPEC "Steering"): queued and Now notes in the real app with the stand-in Claude CLI in
// queue mode (app/scripts/readme-shots/standin-claude.py "queue mode": lifecycle frames, notes taken in mid-turn,
// background tasks whose notifications get turns of their own, interrupt, cancel_async_message), set up by
// app/scripts/steer-e2e.sh. Run once inside coool and once in a chat host. No model calls.
//
// Every note must end delivered (on screen in the timeline, and answered by the agent: the stand-in replies "Re: <the
// note>" to a note that starts a turn, and says "Noted: <the note>" for one taken in mid-turn) or visibly unused
// with Send now; never gone.
//
//   1. Now while a background command's notification waits in the CLI's queue: the note is answered first (it used
//      to be the notification's turn, the agent answering that as if the note had never been sent).
//   2. A turn the CLI runs on its own (a background helper reported): the chat shows as working, and Now cuts it.
//   3. A plain note taken in after a subagent step stays on screen after the agent replies.
//   4. Now from the strip on a note the CLI already holds: withdrawn and sent again, delivered once.
//   5. Now while the reply streams (no step).
//   6. Two Now notes in a row: both delivered.
//   7. A note queued when the chat restarts is left unused with Send now; sent, it is answered.

import { newChat } from "./lib/actions";
import { api } from "./lib/backend";
import { useChats, type ChatItem } from "./lib/chat";

export interface SteerKit {
  dir: string;
  shot: (name: string, settle?: number) => Promise<unknown>;
  log: (line: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

type Text = Extract<ChatItem, { kind: "text" }>;
type ToolItem = Extract<ChatItem, { kind: "tool" }>;
const items = (id: number) => useChats.getState().chats[id]?.items ?? [];
const chat = (id: number) => useChats.getState().chats[id];
const texts = (id: number) => items(id).filter((i): i is Text => i.kind === "text" && !i.parent && !i.streaming);
const bg = (i: ToolItem) => !!(i.input as { run_in_background?: boolean } | null)?.run_in_background;
/** The main-thread step running now (not a background command, whose step ends at once). */
const running = (id: number, name?: string) => items(id).find((i): i is ToolItem => i.kind === "tool" && !i.parent && i.endTs === null && !bg(i) && (!name || i.name === name));
const idle = (id: number) => chat(id)?.state === "idle";

function composer(): HTMLTextAreaElement {
  const ta = [...document.querySelectorAll<HTMLTextAreaElement>(".composer-dock textarea")].filter((t) => t.offsetParent !== null);
  if (!ta.length) throw new Error("no chat composer on screen");
  return ta[ta.length - 1];
}

/** Types `text` into the composer and sends it (Cmd+Enter: now). */
async function say(k: SteerKit, text: string, now = false) {
  const ta = composer();
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  set.call(ta, text);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  await k.sleep(60);
  composer().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: now, bubbles: true, cancelable: true }));
}

export function steerScenarios(k: SteerKit): Record<string, () => Promise<void>> {
  const pids = () => k.invoke("selftest_keepalive", { action: "pids" }) as Promise<{ chats: { id: number; hosted: boolean }[] }>;
  const timeline = (id: number) => document.querySelector(`[data-chat-timeline="${id}"]`);
  /** The note's bubble in the timeline (on screen), by its text. */
  const bubble = (id: number, text: string, state?: string) =>
    [...(timeline(id)?.querySelectorAll<HTMLElement>(state ? `[data-note="${state}"]` : "[data-note]") ?? [])].find((b) => b.textContent?.includes(text));
  /** Waits (the window is drawn off screen, at its own pace) until the note shows: as a note bubble in `state`, or
   * (no state) anywhere in the timeline, a note or a prompt bubble. */
  const shown = (id: number, text: string, state?: string) =>
    k
      .waitFor("the note on screen", () => (state ? bubble(id, text, state) : bubble(id, text) || [...(timeline(id)?.querySelectorAll("[data-prompt-unsent], .selectable") ?? [])].find((b) => b.textContent?.trim() === text)), 5_000)
      .then(() => true, () => false);
  const bubbles = (id: number, text: string) => [...(timeline(id)?.querySelectorAll<HTMLElement>("[data-note]") ?? [])].filter((b) => b.textContent?.includes(text)).length;
  /** What the store and the screen hold for a note (for a failure's message). */
  const diag = (id: number, text: string) => {
    const its = items(id).filter((i) => (i.kind === "note" || i.kind === "prompt") && i.text === text).map((i) => (i.kind === "note" ? `note:${i.state}` : "prompt"));
    const tls = document.querySelectorAll(`[data-chat-timeline="${id}"]`).length;
    const shown = [...document.querySelectorAll("[data-note]")].map((b) => `${b.getAttribute("data-note")}:${(b.textContent ?? "").slice(0, 20)}`);
    return `items [${its.join(", ")}], ${tls} timeline(s), on screen [${shown.join(" | ")}]`;
  };
  const strip = () => document.querySelector("[data-steer-queued]");
  const unusedStrip = () => document.querySelector<HTMLElement>("[data-steer-unused]");
  /** Delivered exactly once: one `user_message` echo for it, in the store. */
  const echoes = (id: number, text: string) => items(id).filter((i) => (i.kind === "note" || i.kind === "prompt") && i.text === text).length;
  const replyIdx = (id: number, re: RegExp) => texts(id).findIndex((t) => re.test(t.text));
  const settle = (id: number, ms = 20_000) => k.waitFor("the chat to be idle", () => idle(id) && !strip(), ms);
  const noUnused = () => {
    if (unusedStrip()) throw new Error(`a note was left unused: "${unusedStrip()?.textContent}"`);
  };

  /** A new chat (each step has its own, so one step's failure leaves the next one alone) with its first prompt. */
  const fresh = async (prompt: string) => {
    const before = new Set(Object.keys(useChats.getState().chats).map(Number));
    const ok = await newChat({ provider: "claude", cwd: k.dir, prompt, model: null, permissionMode: null });
    if (!ok) throw new Error("couldn't start the chat");
    const id = (await k.waitFor("the new chat", () => {
      const i = Object.keys(useChats.getState().chats).map(Number).find((x) => !before.has(x));
      return i === undefined ? null : { i };
    }, 20_000)).i;
    ids.push(id);
    return id;
  };
  const ids: number[] = [];

  return {
    async "steer-queue"() {
      let id = -1;
      let hosted = false;
      await k.step("steer-queue: Now while a background command's notification waits: the note is answered first, and stays on screen", async () => {
        id = await fresh("steer demo");
        hosted = !!(await pids()).chats.find((c) => c.id === id)?.hosted;
        const step = await k.waitFor("the first foreground step", () => items(id).some((i) => i.kind === "tool" && bg(i)) && running(id, "Bash"), 20_000);
        // The background command (2 s) finishes during the step: its notification waits in the CLI's queue.
        await k.sleep(2600);
        if (running(id, "Bash")?.id !== step.id) throw new Error("the step ended before the note");
        const N = "Use the second config file instead.";
        await say(k, N, true);
        await k.waitFor("the note's reply", () => replyIdx(id, /^Re: Use the second config file instead\./) >= 0, 15_000);
        await k.waitFor("the notification's turn after it", () => replyIdx(id, /The background task "Build in the background" finished/) >= 0, 15_000);
        const re = replyIdx(id, /^Re: Use the second/);
        const nt = replyIdx(id, /The background task "Build in the background" finished/);
        if (nt < re) throw new Error(`the agent answered the background notification first (reply ${nt}) and the note after (reply ${re})`);
        await settle(id);
        const n = useChats.getState().chats[id]?.notes.find((x) => x.text === N);
        if (n?.state !== "interrupted") throw new Error(`the note is ${n?.state ?? "gone from the store"}`);
        if (n.toolId !== step.id) throw new Error(`cut step ${n.toolId}, expected ${step.id}`);
        if (!(await shown(id, N, "interrupted"))) throw new Error(`the note is not on screen (${diag(id, N)})`);
        if (echoes(id, N) !== 1 || bubbles(id, N) !== 1) throw new Error(`delivered ${echoes(id, N)}x, shown ${bubbles(id, N)}x`);
        noUnused();
        await k.shot("steer-now-before-notification");
        return `${hosted ? "in the chat host" : "inside coool"}: the note's reply #${re}, the notification's #${nt}; on screen as Interrupted`;
      });

      await k.step("steer-queue: a turn the CLI runs on its own (a helper reported) shows as working, and Now cuts it", async () => {
        const id = await fresh("helper demo");
        await k.waitFor("the turn that started the helper to end", () => replyIdx(id, /^Started a helper/) >= 0 && idle(id), 15_000);
        const step = await k.waitFor("the helper's own turn, with a step", () => running(id, "Bash"), 15_000);
        const c = chat(id);
        if (c?.state !== "working") throw new Error(`the chat shows ${c?.state} while the CLI runs the helper's turn`);
        const t0 = Date.now();
        const N = "Skip the report, the helper was wrong.";
        await say(k, N, true);
        await k.waitFor("the note's reply", () => replyIdx(id, /^Re: Skip the report/) >= 0, 10_000);
        const took = Date.now() - t0;
        const s = items(id).find((i): i is ToolItem => i.kind === "tool" && i.id === step.id);
        if (!s || s.endTs === null) throw new Error("the helper turn's step still runs");
        if (took > 4000) throw new Error(`answered after ${took} ms: the step was not cut`);
        await settle(id);
        if (!(await shown(id, N, "interrupted"))) throw new Error(`the note is not on screen (${diag(id, N)})`);
        noUnused();
        await k.shot("steer-now-auto-turn");
        return `working during the CLI's own turn; cut and answered in ${took} ms`;
      });

      await k.step("steer-queue: a plain note taken in after a subagent step stays on screen after the reply", async () => {
        const id = await fresh("agent step demo");
        await k.waitFor("the subagent step", () => running(id, "Agent"), 15_000);
        const N = "Check the README too.";
        await say(k, N);
        await k.waitFor("the queued strip", () => strip()?.textContent?.includes(N), 5_000);
        await k.waitFor("the reply that saw the note", () => texts(id).some((t) => t.text.includes(`Noted: ${N}`)), 20_000);
        await settle(id);
        const n = chat(id)?.notes.find((x) => x.text === N);
        if (n?.state !== "picked_up") throw new Error(`the note is ${n?.state}`);
        const agentStep = items(id).find((i) => i.kind === "tool" && i.name === "Agent" && i.id === n.toolId);
        if (!agentStep) throw new Error(`picked up after ${n.toolId}, not the subagent step`);
        if (!(await shown(id, N, "picked_up"))) throw new Error(`the note left the strip and is nowhere on screen (${diag(id, N)})`);
        if (echoes(id, N) !== 1) throw new Error(`delivered ${echoes(id, N)}x`);
        noUnused();
        await k.shot("steer-after-subagent");
        return "picked up after the Agent step, shown as Picked up after the reply";
      });

      await k.step("steer-queue: Now from the strip on a note the CLI already holds: delivered once, interrupting", async () => {
        const id = await fresh("steer demo");
        await k.waitFor("a foreground step", () => running(id, "Bash"), 15_000);
        await k.sleep(300);
        const N = "Rename it to notes.md.";
        await say(k, N);
        const now = await k.waitFor("the strip's Now", () => strip()?.textContent?.includes(N) && document.querySelector<HTMLButtonElement>("[data-note-now]"), 5_000);
        await k.sleep(300);
        now.click();
        await k.waitFor("the note's reply", () => replyIdx(id, /^Re: Rename it to notes\.md\./) >= 0, 10_000);
        await settle(id);
        await k.sleep(500);
        if (echoes(id, N) !== 1) throw new Error(`delivered ${echoes(id, N)}x`);
        if (texts(id).filter((t) => t.text === `Re: ${N}`).length !== 1) throw new Error("answered more than once");
        if (!(await shown(id, N, "interrupted"))) throw new Error(`the note is not on screen as Interrupted (${diag(id, N)})`);
        noUnused();
        return "withdrawn from the CLI, sent again as Now, delivered once";
      });

      await k.step("steer-queue: Now while the reply streams", async () => {
        const id = await fresh("story demo");
        await k.waitFor("the reply streaming", () => items(id).some((i) => i.kind === "text" && i.streaming && !i.parent), 10_000);
        await k.sleep(800);
        const N = "Make it a poem instead.";
        await say(k, N, true);
        await k.waitFor("the note's reply", () => replyIdx(id, /^Re: Make it a poem instead\./) >= 0, 10_000);
        await settle(id);
        if (!(await shown(id, N))) throw new Error(`the note is not on screen (${diag(id, N)})`);
        if (echoes(id, N) !== 1) throw new Error(`delivered ${echoes(id, N)}x`);
        noUnused();
        return `on screen as ${bubble(id, N)?.getAttribute("data-note") ?? "a prompt"}`;
      });

      await k.step("steer-queue: two Now notes in a row are both delivered", async () => {
        const id = await fresh("steer demo");
        await k.waitFor("a foreground step", () => running(id, "Bash"), 15_000);
        await k.sleep(400);
        const A = "First: use tabs.";
        const B = "Second: and keep the header.";
        await say(k, A, true);
        await k.sleep(30);
        await say(k, B, true);
        await k.waitFor("both answered", () => replyIdx(id, /^Re: First: use tabs\./) >= 0 && (replyIdx(id, /^Re: Second: and keep the header\./) >= 0 || texts(id).some((t) => t.text.includes(`Noted: ${B}`))), 15_000);
        await settle(id);
        for (const N of [A, B]) {
          if (echoes(id, N) !== 1) throw new Error(`"${N}" delivered ${echoes(id, N)}x`);
          if (!(await shown(id, N))) throw new Error(`"${N}" is not on screen (${diag(id, N)})`);
        }
        noUnused();
        await k.shot("steer-two-now");
        return "both delivered and on screen";
      });

      await k.step("steer-queue: a note queued when the chat restarts is left unused with Send now, and sent it is answered", async () => {
        const id = await fresh("steer demo");
        await k.waitFor("a foreground step", () => running(id, "Bash"), 15_000);
        const N = "After the restart, carry on.";
        await say(k, N);
        await k.waitFor("the queued strip", () => strip()?.textContent?.includes(N), 5_000);
        await api().chatRestart(id, null);
        const un = await k.waitFor("the unused strip", () => unusedStrip(), 20_000);
        if (!un.textContent?.includes("wasn't used")) throw new Error(`the strip reads "${un.textContent}"`);
        await k.waitFor("the chat running and idle again", () => chat(id)?.running && idle(id), 20_000);
        const send = [...un.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Send now");
        if (!send) throw new Error("no Send now");
        send.click();
        await k.waitFor("the note's reply", () => replyIdx(id, /^Re: After the restart, carry on\./) >= 0, 15_000);
        await settle(id);
        noUnused();
        await k.shot("steer-after-restart");
        return "unused at the restart, Send now delivered it to the new CLI";
      });

      for (const c of ids) await api().chatStop(c).catch(() => {});
    },
  };
}
