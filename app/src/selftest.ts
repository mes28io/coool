// Dev-only self-test: scripted scenarios run through the real client (the same
// actions, store and DOM the person uses) against the real backend and CLIs,
// with a pass/fail log and screenshots. Inert unless the backend reports
// self-test mode, which only a debug build with COOOL_SELFTEST set does
// (see app/src-tauri/src/selftest.rs for how to run it).
//
// Scenarios (COOOL_SELFTEST=all, or a comma list): stream, approval, interrupt,
// model, slash, question, resume, codex, insights, quit.
// Prompts are tiny and run on the cheapest models (Claude Haiku, a small Codex model).

import { newChat } from "./lib/actions";
import { api, isTauri } from "./lib/backend";
import { chatNeeds, useChats, type Chat, type ChatItem } from "./lib/chat";
import type { ChatEvent } from "./lib/types";
import { sessionKey } from "./lib/types";
import { useStore } from "./store";

interface Config {
  scenario: string;
  dir: string;
  shots: string;
}

const PROMPT_BLUE = "Write three short sentences about the colour blue. Plain text, no lists, and keep every sentence under twelve words so the whole reply stays brief.";
const ALL = ["stream", "approval", "interrupt", "model", "slash", "question", "resume", "codex", "usage", "insights", "quit"];
const CLAUDE_MODEL = "haiku";
const CODEX_MODEL = "gpt-5.6-luna";

let invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
let pass = 0;
let fail = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (line: string) => invoke("selftest_log", { line }).catch(() => {});

async function shot(name: string) {
  await sleep(700); // let springs and fades settle
  try {
    await invoke("selftest_shot", { name });
  } catch (e) {
    await log(`WARN shot ${name}: ${e}`);
  }
}

class Fail extends Error {}

async function waitFor<T>(what: string, f: () => T | null | undefined | false, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Fail(`timed out after ${Math.round(ms / 1000)}s waiting for ${what}`);
    await sleep(100);
  }
}

// ---------- raw event tap (to prove streaming is live, batch by batch) ----------

const batches: Record<number, { at: number; events: ChatEvent[] }[]> = {};
function tap() {
  api().onChatEvent(({ id, events }) => {
    (batches[id] ??= []).push({ at: performance.now(), events });
  });
}
const evs = (id: number) => (batches[id] ?? []).flatMap((b) => b.events);

// ---------- store / DOM helpers ----------

/** A chat id not in `before`, boxed so that id 0 counts as found. */
const newId = (before: Set<number>) => {
  const id = Object.keys(useChats.getState().chats).map(Number).find((i) => !before.has(i));
  return id === undefined ? null : { id };
};
const chat = (id: number): Chat | undefined => useChats.getState().chats[id];
const items = (id: number) => chat(id)?.items ?? [];
const after = (id: number, n: number) => items(id).slice(n);
const turnEnds = (id: number) => items(id).filter((i) => i.kind === "turn") as Extract<ChatItem, { kind: "turn" }>[];
const lastText = (id: number) => {
  const t = items(id).filter((i) => i.kind === "text" && !i.parent) as Extract<ChatItem, { kind: "text" }>[];
  return t[t.length - 1];
};
/** On screen: laid out, and not hidden by visibility/opacity (inactive tabs stay mounted, hidden). */
const visible = (el: Element) => {
  const e = el as HTMLElement & { checkVisibility?: (o: object) => boolean };
  if (e.checkVisibility) return e.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  if (e.offsetParent === null) return false;
  for (let n: HTMLElement | null = e; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.visibility === "hidden" || cs.opacity === "0") return false;
  }
  return true;
};
const $all = (sel: string) => [...document.querySelectorAll(sel)].filter(visible) as HTMLElement[];
const $ = (sel: string) => $all(sel)[0] ?? null;
const button = (text: string | RegExp, root: ParentNode = document) =>
  ([...root.querySelectorAll("button")] as HTMLElement[]).filter(visible).find((b) => (typeof text === "string" ? b.textContent?.trim().startsWith(text) : text.test(b.textContent ?? ""))) ?? null;

function composer(): HTMLTextAreaElement {
  // The chat composer only: not the sheet's prompt, not xterm's hidden helper textarea.
  const ta = $all("[data-main] textarea").filter((t) => !t.closest("form") && !t.closest(".xterm"));
  if (!ta.length) throw new Fail("no chat composer on screen");
  return ta[ta.length - 1] as HTMLTextAreaElement;
}
/** Types into the real composer (React sees a normal input event). */
function type(text: string) {
  const el = composer();
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  set.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
function key(k: string, el: Element = composer()) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
}
async function say(text: string) {
  type(text);
  await sleep(60);
  key("Enter");
}

/** Waits for the next turn of chat `id` to end (counting from `before`). */
async function nextTurn(id: number, before: number, ms = 120_000) {
  return waitFor(`turn ${before + 1} to end`, () => turnEnds(id)[before], ms);
}

async function step(name: string, f: () => Promise<string | void>) {
  const t = Date.now();
  try {
    const detail = await f();
    pass++;
    await log(`PASS ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)${detail ? `: ${detail}` : ""}`);
  } catch (e) {
    fail++;
    await log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------- scenarios ----------

interface Ctx {
  cfg: Config;
  /** The main Claude chat most scenarios continue in. */
  main: number | null;
  question: number | null;
}

async function startClaude(ctx: Ctx, prompt?: string): Promise<number> {
  const before = new Set(Object.keys(useChats.getState().chats).map(Number));
  const t = Date.now();
  await newChat({ provider: "claude", cwd: ctx.cfg.dir, model: CLAUDE_MODEL, prompt });
  await log(`INFO newChat returned after ${Date.now() - t}ms; chats ${Object.keys(useChats.getState().chats).join(",")}; ptys ${Object.keys(useStore.getState().ptys).join(",")}; toasts ${useStore.getState().toasts.map((x) => x.text).join(" | ")}`);
  return (await waitFor("the new chat", () => newId(before), 10_000)).id;
}

async function ensureMain(ctx: Ctx): Promise<number> {
  if (ctx.main !== null && chat(ctx.main)?.running) return ctx.main;
  ctx.main = await startClaude(ctx);
  await waitFor("ready", () => chat(ctx.main!)?.ready, 60_000);
  return ctx.main;
}

const scenarios: Record<string, (ctx: Ctx) => Promise<void>> = {
  async stream(ctx) {
    await step("new session sheet opens a chat, not a terminal", async () => {
      useStore.getState().setSheet({ kind: "new", cwd: ctx.cfg.dir, provider: "claude" });
      await waitFor("the sheet", () => button("Start chat"), 5_000);
      await shot("new-session");
      useStore.getState().setSheet(null);
      await sleep(300);
      const ptysBefore = Object.keys(useStore.getState().ptys).length;
      const id = await startClaude(ctx, PROMPT_BLUE);
      ctx.main = id;
      const tab = useStore.getState().tabs.find((t) => t.id === useStore.getState().activeTab);
      const leaf = tab && (tab.root.type === "leaf" ? tab.root : null);
      if (leaf?.target?.kind !== "chat") throw new Fail(`the new tab shows ${JSON.stringify(leaf?.target)}, not a chat`);
      if (Object.keys(useStore.getState().ptys).length !== ptysBefore) throw new Fail("a PTY was started");
      await waitFor("the chat timeline", () => $("[data-chat-timeline]") && !$("[data-main] .xterm"), 5_000);
      return `chat ${id} in the new tab, no PTY, no xterm on screen`;
    });
    const id = ctx.main!;
    await step("reply streams live (text deltas in several batches before the final message)", async () => {
      await nextTurn(id, 0);
      const bs = batches[id] ?? [];
      const deltaBatches = bs.filter((b) => b.events.some((e) => e.type === "text_delta"));
      const deltas = evs(id).filter((e) => e.type === "text_delta").length;
      const finalAt = bs.find((b) => b.events.some((e) => e.type === "assistant_message"))?.at ?? 0;
      const firstDelta = deltaBatches[0]?.at ?? 0;
      const types = evs(id).map((e) => e.type);
      if (types[0] !== "ready" && !types.includes("ready")) throw new Fail("no ready event");
      if (deltas < 2 || deltaBatches.length < 2) throw new Fail(`only ${deltas} deltas in ${deltaBatches.length} batches`);
      if (!(firstDelta < finalAt)) throw new Fail("deltas did not arrive before the final message");
      const t = lastText(id);
      if (!t || !/blue/i.test(t.text)) throw new Fail(`unexpected reply: ${t?.text?.slice(0, 80)}`);
      // ready is reported before or after the echo of the first prompt; both must be there.
      const order = `${types.indexOf("user_message") < types.indexOf("ready") ? "prompt-before-ready" : "ready-first"}`;
      return `${deltas} deltas in ${deltaBatches.length} batches over ${Math.round(finalAt - firstDelta)}ms; ${order}; model ${t.model}`;
    });
    await shot("chat-streamed");
    await step("the first chat after launch knows its skills before its first turn ends", async () => {
      const first = evs(id).find((e) => e.type === "commands");
      const end = evs(id).findIndex((e) => e.type === "turn_end");
      const at = evs(id).findIndex((e) => e.type === "commands");
      if (!first || first.type !== "commands") throw new Fail("no commands event");
      const skills = first.commands.filter((c) => c.kind === "skill").map((c) => c.name);
      if (!skills.length) throw new Fail("the first commands event tags no skills");
      if (end >= 0 && at > end) throw new Fail("commands came after the first turn");
      return `${skills.length} skills in the first commands event (e.g. ${skills.slice(0, 3).join(", ")})`;
    });
    await step("title is short, path shortens, chips stay on one line", async () => {
      const h2 = await waitFor("the header title", () => $("[data-main] h2"), 5_000);
      const title = h2.textContent ?? "";
      if (title === PROMPT_BLUE || title.length > 60) throw new Fail(`title "${title}"`);
      const path = $("[data-main] [data-path]");
      const tail = path?.lastElementChild as HTMLElement | null;
      if (!path || !tail || path.textContent?.startsWith("/Users/")) throw new Fail(`path "${path?.textContent}"`);
      if (tail.scrollWidth > tail.clientWidth + 1) throw new Fail(`the last folder is clipped: "${tail.textContent}"`);
      const head = path.firstElementChild as HTMLElement;
      const clipped = head !== tail && head.scrollWidth > head.clientWidth + 1;
      const chip = $("[data-main] [data-models-chip]");
      if (!chip || chip.getBoundingClientRect().height > 24) throw new Fail(`models chip is ${chip?.getBoundingClientRect().height}px tall`);
      const row = $all("[data-session-row]").find((r) => r.textContent?.includes(title.replace(/…$/, "")));
      return `title "${title}"; path ends "${tail.textContent}"${clipped ? " (parent part middle-truncated)" : ""}; sidebar row ${row ? "matches" : "differs"}`;
    });
    await step("the chat is linked to its discovered session (one sidebar row)", async () => {
      const sid = await waitFor("session id", () => chat(id)?.sessionId, 10_000);
      const s = await waitFor("the session linked to the chat", () => useStore.getState().sessions.find((x) => x.chat === id), 20_000);
      const rows = useStore.getState().sessions.filter((x) => x.id === sid).length;
      if (rows !== 1) throw new Fail(`${rows} sessions with id ${sid}`);
      if (useStore.getState().pendingChats.includes(id)) throw new Fail("still listed as pending");
      const sidebarRows = $all(`[data-session-row="${sessionKey(s)}"]`).length;
      if (sidebarRows !== 1) throw new Fail(`${sidebarRows} sidebar rows for the session`);
      return `session ${sid.slice(0, 8)}… linked, 1 sidebar row`;
    });
  },

  async approval(ctx) {
    const id = await ensureMain(ctx);
    const write = (f: string) => `Use the Write tool to create the file ${f} containing the text ok. Do nothing else and do not reply with text afterwards beyond one word.`;
    const ask = async (f: string) => {
      const n = turnEnds(id).length;
      const from = items(id).length;
      await say(write(f));
      return { n, from };
    };
    const card = () => $("[data-approval]");
    const remembers = (c: HTMLElement) => [...c.querySelectorAll("[data-remember]")] as HTMLElement[];
    await step("tool call asks for approval; the card says what remembering would do; Allow once runs it", async () => {
      const { n, from } = await ask("a.txt");
      const c = await waitFor("the approval card", card, 90_000);
      if (!chatNeeds(chat(id))) throw new Fail("chat does not report Needs you");
      if (!$all("[data-needs]").length && !document.body.textContent?.includes("Needs you")) throw new Fail("no Needs you badge on screen");
      // Write: the CLI offers acceptEdits for this session only.
      const opts = remembers(c);
      const labels = opts.map((o) => `${o.dataset.rememberScope}: ${o.textContent?.trim()}`);
      if (!opts.length || opts[0].dataset.rememberScope !== "chat" || !/Allow all edits in this chat/.test(opts[0].textContent ?? "")) throw new Fail(`unexpected options: ${labels.join(" | ")}`);
      if (button("Always allow", c)) throw new Fail("an unlabelled Always allow button is still there");
      await shot("approval");
      button("Allow once", c)!.click();
      await nextTurn(id, n);
      const tool = after(id, from).find((i) => i.kind === "tool" && i.name === "Write") as Extract<ChatItem, { kind: "tool" }> | undefined;
      if (!tool?.ok) throw new Fail(`Write did not succeed: ${tool?.output}`);
      if (chat(id)?.permissionMode !== "default") throw new Fail(`Allow once changed the mode to ${chat(id)?.permissionMode}`);
      return `Write a.txt ran; offered ${labels.join(" | ")}`;
    });
    await step("Deny stops the tool; the struck-through path is short", async () => {
      const { n, from } = await ask("b.txt");
      const c = await waitFor("the approval card", card, 90_000);
      button("Deny", c)!.click();
      await nextTurn(id, n);
      const tool = after(id, from).find((i) => i.kind === "tool" && i.name === "Write") as Extract<ChatItem, { kind: "tool" }> | undefined;
      if (!tool || tool.ok !== false) throw new Fail("the denied Write did not fail");
      await sleep(400);
      const struck = $all("[data-chat-timeline] .line-through").map((e) => e.textContent ?? "");
      const last = struck[struck.length - 1] ?? "";
      if (!last.includes("b.txt") || last.startsWith("/") || last.length > 40) throw new Fail(`struck-through detail reads "${last}"`);
      return `Write b.txt denied; shows "${last}"`;
    });
    await step("a command's saved rule comes second; the this-chat option applies a session rule only", async () => {
      const n = turnEnds(id).length;
      await say("Use the Bash tool to run exactly this command: touch e.txt  Then reply with one word.");
      const c = await waitFor("the approval card", card, 90_000);
      const opts = remembers(c);
      const labels = opts.map((o) => `${o.dataset.rememberScope}: ${o.textContent?.trim()}`);
      const saved = opts.find((o) => o.dataset.rememberScope !== "chat");
      if (opts[0]?.dataset.rememberScope !== "chat") throw new Fail(`first option is not this-chat-only: ${labels.join(" | ")}`);
      if (saved && !/settings\.local\.json/.test(saved.textContent ?? "")) throw new Fail(`the saved option doesn't name its file: ${saved.textContent}`);
      await shot("approval-command");
      opts[0].click();
      await nextTurn(id, n);
      const note = await waitFor("the applied note", () => $("[data-remembered]"), 5_000);
      if (note.dataset.remembered !== "chat" || !/in this chat/.test(note.textContent ?? "")) throw new Fail(`note: ${note.textContent}`);
      // The same command again runs without asking (the session rule), and the mode didn't change.
      const before = items(id).filter((i) => i.kind === "permission").length;
      const n2 = turnEnds(id).length;
      await say("Run exactly the same Bash command again: touch e.txt  Then reply with one word.");
      await nextTurn(id, n2);
      const asked = items(id).filter((i) => i.kind === "permission").length - before;
      if (asked) throw new Fail(`asked again ${asked}x after the session rule`);
      if (chat(id)?.permissionMode !== "default") throw new Fail(`mode changed to ${chat(id)?.permissionMode}`);
      return `offered ${labels.join(" | ")}; note "${note.textContent?.trim()}"`;
    });
    await step("Allow all edits switches this chat to Accept edits: note and mode chip say so; later edits don't ask", async () => {
      const { n } = await ask("c.txt");
      const c = await waitFor("the approval card", card, 90_000);
      const opt = remembers(c).find((o) => /Allow all edits/.test(o.textContent ?? ""));
      if (!opt) throw new Fail("no Allow all edits option");
      opt.click();
      await nextTurn(id, n);
      const chip = await waitFor("the mode chip to read Accept edits", () => $all("[data-mode-chip]").find((e) => e.dataset.modeChip === "acceptEdits" && /Accept edits/.test(e.textContent ?? "")), 10_000);
      const note = $all("[data-remembered]").pop();
      if (!note || !/Accept edits mode/.test(note.textContent ?? "")) throw new Fail(`note: ${note?.textContent}`);
      await shot("approval-mode-switched");
      const before = items(id).filter((i) => i.kind === "permission").length;
      const r = await ask("d.txt");
      await nextTurn(id, r.n);
      const asked = items(id).filter((i) => i.kind === "permission").length - before;
      const tool = after(id, r.from).find((i) => i.kind === "tool" && i.name === "Write") as Extract<ChatItem, { kind: "tool" }> | undefined;
      if (asked) throw new Fail(`asked again ${asked}x after Allow all edits`);
      if (!tool?.ok) throw new Fail("Write d.txt did not run");
      return `chip "${chip.textContent}", note "${note.textContent?.trim()}"; d.txt written without asking`;
    });
    await shot("approvals-done");
  },

  async interrupt(ctx) {
    const id = await ensureMain(ctx);
    await step("Stop interrupts mid-turn; the chat continues", async () => {
      const n = turnEnds(id).length;
      const seen = evs(id).filter((e) => e.type === "text_delta").length;
      await say("Count from 1 to 400, one number per line, nothing else.");
      await waitFor("streaming to start", () => evs(id).filter((e) => e.type === "text_delta").length > seen + 3, 60_000);
      const stop = await waitFor("the Stop button", () => $('button[title="Stop this turn (Esc)"]'), 5_000);
      stop.click();
      const end = await nextTurn(id, n, 30_000);
      if (end.ok) throw new Fail("interrupted turn reported ok");
      await shot("interrupted");
      const m = turnEnds(id).length;
      await say("Reply with exactly the word: continued");
      await nextTurn(id, m);
      const t = lastText(id);
      if (!/continued/i.test(t?.text ?? "")) throw new Fail(`after interrupt: ${t?.text?.slice(0, 60)}`);
      return "turn stopped, next turn answered";
    });
  },

  async model(ctx) {
    const id = await ensureMain(ctx);
    await step("model switch from the picker applies to the next turn", async () => {
      const before = chat(id)?.model ?? "";
      const chip = await waitFor("model chip", () => $('button[title="Model (/model)"]'), 5_000);
      chip.click();
      await waitFor("the model picker", () => $("[data-model-option]"), 5_000);
      await shot("model-picker");
      const opts = $all("[data-model-option]");
      const want = opts.find((o) => /haiku/i.test(o.dataset.modelOption ?? "") && !/haiku-5|5\.5/.test(o.textContent ?? "") && o.dataset.modelOption !== before);
      if (want) want.click();
      else {
        // Not listed: the "Other model id" field takes any id.
        const input = $('input[placeholder="Other model id…"]') as HTMLInputElement;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "claude-haiku-4-5");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(50);
        input.form!.requestSubmit();
      }
      const model = await waitFor("the new model", () => (chat(id)?.model && chat(id)!.model !== before ? chat(id)!.model : null), 20_000);
      const n = turnEnds(id).length;
      await say("Reply with exactly the word: ok");
      await nextTurn(id, n);
      const t = lastText(id);
      if (!t?.model || t.model === before || !/haiku/.test(t.model)) throw new Fail(`answered by ${t?.model}`);
      return `${before} -> ${model}; next reply by ${t.model}`;
    });
  },

  async slash(ctx) {
    const id = await ensureMain(ctx);
    await step("the / menu lists the real commands, grouped and tagged", async () => {
      type("/");
      const list = await waitFor("the command menu", () => $("[data-slash-count]"), 5_000);
      const n = Number(list.dataset.slashCount);
      const groups = new Set($all("[data-group]").map((b) => b.dataset.group));
      const grp = (c: string) => $(`[data-cmd="${c}"]`)?.dataset.group;
      const want = { context: "app", model: "app", clear: "app", usage: "app", compact: "command", doctor: "terminal" } as Record<string, string>;
      const wrong = Object.entries(want).filter(([c, g]) => grp(c) !== g);
      await shot("slash-menu");
      if (n < 50) throw new Fail(`only ${n} commands`);
      if (wrong.length) throw new Fail(`wrong groups: ${wrong.map(([c]) => `${c}=${grp(c)}`).join(", ")}`);
      type("/res");
      await sleep(150);
      const first = $("[data-cmd]")?.dataset.cmd;
      type("/cost");
      await sleep(150);
      const cost = $("[data-cmd]");
      if (cost?.dataset.group !== "app") throw new Fail(`/cost resolves to ${cost?.dataset.cmd} (${cost?.dataset.group})`);
      type("/pdf");
      await sleep(150);
      const skill = $("[data-cmd]")?.dataset.group;
      await shot("slash-filter");
      type("");
      return `${n} commands in ${[...groups].join("/")}; /res -> ${first}, /cost -> /${cost.dataset.cmd} (in app), /pdf -> ${skill}`;
    });
    await step("an in-app command (/context) opens the native panel and sends nothing", async () => {
      const sent = evs(id).filter((e) => e.type === "user_message").length;
      await say("/context");
      await waitFor("the context panel", () => $("[data-info-panel]"), 5_000);
      await shot("slash-in-app");
      key("Escape", document.body);
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await sleep(300);
      if (evs(id).filter((e) => e.type === "user_message").length !== sent) throw new Fail("/context was sent to the CLI");
      return "panel shown, nothing sent";
    });
    await step("a CLI command (/config) runs in the chat", async () => {
      const from = items(id).length;
      await say("/config");
      const n = await waitFor("its output", () => after(id, from).find((i) => i.kind === "notice" && /config/i.test(i.text)) as Extract<ChatItem, { kind: "notice" }> | undefined, 30_000);
      if (n.needsTerminal) throw new Fail("flagged as terminal-only");
      return n.text.split("\n")[0].slice(0, 60);
    });
    await step("a terminal-only command (/doctor) offers Open in terminal, which works", async () => {
      const from = items(id).length;
      await say("/doctor");
      await waitFor("the needs-terminal notice", () => after(id, from).find((i) => i.kind === "notice" && i.needsTerminal), 10_000);
      await shot("needs-terminal");
      const b = await waitFor("Open in terminal", () => button("Open in terminal"), 5_000);
      // Watch the handoff: the header must never read "Ended", and no separate "Starting…" row may appear.
      const seen = new Set<string>();
      let pendingRow = false;
      const watch = setInterval(() => {
        const pill = $("[data-main] [data-status-pill]");
        if (pill) seen.add(pill.dataset.statusPill!);
        if (useStore.getState().pending.length) pendingRow = true;
      }, 50);
      b.click();
      const pty = await waitFor("a PTY", () => Object.values(useStore.getState().ptys).find((p) => p.running) ?? null, 15_000);
      await waitFor("the terminal view", () => $("[data-main] .xterm"), 15_000);
      await sleep(4_000); // the TUI draws
      clearInterval(watch);
      await shot("open-in-terminal");
      if (seen.has("ended")) throw new Fail(`the header read Ended during the handoff (${[...seen].join(",")})`);
      if (pendingRow) throw new Fail("a separate Starting… row appeared during the handoff");
      await waitFor("the chat to hand over", () => !chat(id)?.running, 10_000);
      await api().stopSession({ managed: pty.id });
      await waitFor("the PTY to exit", () => !useStore.getState().ptys[pty.id]?.running || useStore.getState().exited[pty.id], 15_000);
      ctx.main = null;
      return `PTY ${pty.id} ran the CLI's TUI for the same session (header: ${[...seen].join(" → ")}), then stopped`;
    });
  },

  async question(ctx) {
    let id = 0;
    await step("a question card appears, counts as Needs you, and a pick answers it", async () => {
      id = await startClaude(
        ctx,
        "Use the AskUserQuestion tool exactly once to ask me which colour I prefer, with the options Red and Blue (single choice). After I answer, reply with only the colour I picked.",
      );
      ctx.question = id;
      const card = await waitFor("the question card", () => $("[data-question]"), 90_000);
      const needs = chatNeeds(chat(id));
      if (!needs?.startsWith("Answer")) throw new Fail(`Needs you says: ${needs}`);
      await shot("question");
      card.querySelector<HTMLElement>('[data-option="Blue"]')!.click();
      await nextTurn(id, 0);
      const t = lastText(id);
      if (!/blue/i.test(t?.text ?? "")) throw new Fail(`reply: ${t?.text?.slice(0, 60)}`);
      return `"${needs}"; answered Blue; reply: ${t!.text.trim().slice(0, 30)}`;
    });
    await step("several questions, multi-select and typed text", async () => {
      const n = turnEnds(id).length;
      await say(
        "Use the AskUserQuestion tool exactly once with two questions: 'Which fruits?' (header Fruits, multiSelect true, options Apple, Pear, Plum) and 'Which size?' (header Size, options Small, Large). Then reply with only the exact tool result text.",
      );
      const card = await waitFor("the question card", () => $all("[data-question]").find((c) => c.querySelectorAll("[data-q]").length === 2), 90_000);
      card.querySelector<HTMLElement>('[data-option="Apple"]')!.click();
      card.querySelector<HTMLElement>('[data-option="Pear"]')!.click();
      const other = card.querySelector<HTMLInputElement>('[data-other="1"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(other, "Medium");
      other.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(200);
      await shot("question-multi");
      card.querySelector<HTMLElement>("[data-submit-question]")!.click();
      await nextTurn(id, n);
      const out = (items(id).filter((i) => i.kind === "tool" && i.name === "AskUserQuestion").pop() as Extract<ChatItem, { kind: "tool" }> | undefined)?.output ?? "";
      if (!/Apple, Pear/.test(out) || !/Medium/.test(out)) throw new Fail(`tool result: ${out.slice(0, 120)}`);
      await shot("question-answered");
      return out.slice(0, 110);
    });
  },

  async resume(ctx) {
    const id = ctx.question ?? (await startClaude(ctx, "Reply with exactly the word: Blue"));
    if (!turnEnds(id).length) await nextTurn(id, 0);
    let resumed = 0;
    await step("an ended chat resumes as a chat, with its history above", async () => {
      const sid = chat(id)!.sessionId!;
      await api().chatStop(id);
      const s = await waitFor("the session to end", () => useStore.getState().sessions.find((x) => x.id === sid && x.status === "ended"), 30_000);
      useStore.getState().open({ kind: "session", key: sessionKey(s) });
      await waitFor("the session view", () => $('button[title="Resume this session inside coool"]'), 10_000);
      const before = new Set(Object.keys(useChats.getState().chats).map(Number));
      $('button[title="Resume this session inside coool"]')!.click();
      resumed = (await waitFor("the resumed chat", () => newId(before), 15_000)).id;
      await waitFor("ready", () => chat(resumed)?.ready, 60_000);
      const earlier = await waitFor("earlier history on screen", () => $("[data-earlier]"), 10_000);
      if (chat(resumed)!.sessionId !== sid) throw new Fail(`resumed into ${chat(resumed)!.sessionId}, not ${sid}`);
      if ($("[data-main] .xterm")) throw new Fail("a terminal is showing");
      await say("Which colour did I pick in my first answer? Reply with one word.");
      await nextTurn(resumed, 0);
      const t = lastText(resumed);
      await shot("resumed");
      if (!/blue/i.test(t?.text ?? "")) throw new Fail(`resumed reply: ${t?.text?.slice(0, 60)}`);
      ctx.main = resumed;
      return `same session ${sid.slice(0, 8)}…, ${earlier.dataset.earlier} earlier rows shown, remembers: ${t!.text.trim()}`;
    });
  },

  async codex(ctx) {
    await step("Codex chat: a shell command asks for approval, Allow once runs it", async () => {
      const before = new Set(Object.keys(useChats.getState().chats).map(Number));
      // "untrusted": ask before running anything not known to be safe.
      const ok = await newChat({ provider: "codex", cwd: ctx.cfg.dir, model: CODEX_MODEL, permissionMode: "untrusted", prompt: "Run the shell command `touch codex.txt` and then reply with one word: done" });
      if (!ok) throw new Fail("could not start");
      const id = (await waitFor("the chat", () => newId(before), 10_000)).id;
      const card = await waitFor("the approval card", () => $("[data-approval]"), 120_000);
      const opts = [...card.querySelectorAll("[data-remember]")] as HTMLElement[];
      const labels = opts.map((o) => `${o.dataset.rememberScope}: ${o.textContent?.trim()}`);
      // A saved rule must say where it goes.
      const bad = opts.find((o) => o.dataset.rememberScope !== "chat" && !/default\.rules/.test(o.textContent ?? ""));
      if (bad) throw new Fail(`saved option without its file: ${bad.textContent}`);
      await shot("codex-approval");
      button("Allow once", card)!.click();
      await nextTurn(id, 0, 180_000);
      const tool = items(id).find((i) => i.kind === "tool" && i.name === "shell") as Extract<ChatItem, { kind: "tool" }> | undefined;
      await shot("codex-done");
      if (!tool?.ok) throw new Fail(`shell: ${tool?.ok} ${tool?.output}`);
      return `model ${chat(id)?.model}, mode ${chat(id)?.permissionMode}; offered ${labels.join(" | ") || "nothing to remember"}`;
    });
  },

  // Free: reads what the backend already gathered; no model turn.
  async usage() {
    await step("plan usage reaches the UI and the rail popover shows it", async () => {
      const u = await waitFor("a usage payload", () => {
        const x = (useStore.getState() as { usage?: { claude: unknown; codex: unknown } }).usage;
        return x && (x.claude || x.codex) ? x : null;
      }, 30_000);
      const btn = ([...document.querySelectorAll("button[aria-label]")] as HTMLElement[]).find((b) => b.getAttribute("aria-label")!.startsWith("Usage"));
      if (!btn) throw new Fail("no Usage button in the rail");
      btn.click();
      const pop = await waitFor("the usage popover", () => document.querySelector('[aria-label="Plan usage"]') as HTMLElement | null, 5_000);
      await sleep(600);
      await shot("usage");
      const text = (pop.textContent ?? "").replace(/\s+/g, " ");
      if (!/%/.test(text)) throw new Fail(`popover shows no percentages: ${text.slice(0, 160)}`);
      // Refresh: only meaningful when the backend may probe (COOOL_SELFTEST_PROBES=1).
      type U = { claude: { fetched_ms: number } | null; codex: { fetched_ms: number } | null };
      const cur = () => (useStore.getState() as unknown as { usage: U }).usage;
      const results: string[] = [];
      for (const prov of ["claude", "codex"] as const) {
        const before = cur()[prov]?.fetched_ms ?? 0;
        const rb = ([...pop.querySelectorAll("button[title]")] as HTMLElement[]).find((x) => x.title.toLowerCase().includes(`refresh ${prov}`));
        if (!rb) { results.push(`${prov}: no refresh button`); continue; }
        rb.click();
        const t0 = Date.now();
        const newer = await waitFor(`${prov} newer reading`, () => ((cur()[prov]?.fetched_ms ?? 0) > before ? true : null), 20_000).catch(() => false);
        await sleep(400);
        const foot = (pop.textContent ?? "").replace(/\s+/g, " ").match(/(Updated[^.]*?ago|Updated just now|Checking…|Couldn't refresh[^.]*)/g);
        results.push(`${prov}: ${newer ? `newer reading after ${Date.now() - t0}ms` : "NO newer reading in 20s"}; footer says ${JSON.stringify(foot)}`);
      }
      await shot("usage-refreshed");
      // Dark theme in the real window.
      const themeBtn = ([...document.querySelectorAll("button[aria-label]")] as HTMLElement[]).find((x) => / theme$/.test(x.getAttribute("aria-label") ?? ""));
      if (themeBtn) {
        themeBtn.click();
        await sleep(700);
        await shot("usage-other-theme");
        btn.click();
        await sleep(400);
        await shot("home-other-theme");
        themeBtn.click();
        await sleep(300);
      } else btn.click();
      return `claude ${u.claude ? "yes" : "no"}, codex ${u.codex ? "yes" : "no"}; ${results.join(" | ")}`;
    });
  },

  async insights() {
    await step("AI insights: on, one insight shown, off again", async () => {
      const st = await api().insightsStatus();
      if (!st.has_key) return "skipped: no API key stored";
      await api().insightsSetEnabled(true);
      try {
        const s = await waitFor("an insight", () => useStore.getState().sessions.find((x) => x.insight?.headline), 90_000);
        useStore.getState().activate(null);
        await shot("insights");
        return `"${s.insight!.headline}"`;
      } finally {
        await api().insightsSetEnabled(false);
        const after = await api().insightsStatus();
        if (after.enabled) throw new Fail("still enabled");
      }
    });
  },

  async quit(ctx) {
    await step("Quit with chats running asks first, then stops them", async () => {
      await ensureMain(ctx);
      const running = (useStore.getState().chatInfos ? Object.values(useStore.getState().chatInfos) : []).filter((c) => c.running);
      await log(`PIDS ${running.map((c) => c.pid).filter(Boolean).join(" ")}`);
      await invoke("selftest_request_quit");
      const sheet = await waitFor("the quit confirmation", () => (useStore.getState().sheet?.kind === "quit" ? useStore.getState().sheet : null), 5_000);
      await shot("quit-confirm");
      await log(`SUMMARY pass=${pass + 1} fail=${fail}`);
      await log(`QUITTING (${(sheet as { running: number }).running} running)`);
      button("Stop and quit")!.click();
      await sleep(10_000); // the app exits before this resolves
      throw new Fail("the app did not exit");
    });
  },
};

// React StrictMode (dev server) mounts effects twice; two runs would race each
// other in the same window and click each other's cards.
let started = false;

export async function maybeRunSelfTest() {
  if (!isTauri || started) return;
  started = true;
  ({ invoke } = await import("@tauri-apps/api/core"));
  const cfg = (await invoke("selftest_config").catch(() => null)) as Config | null;
  if (!cfg) return;
  tap();
  const names = cfg.scenario === "all" ? ALL : cfg.scenario.split(",").map((s) => s.trim());
  await log(`START ${names.join(",")} in ${cfg.dir}`);
  await waitFor("the first sessions payload", () => useStore.getState().ready, 30_000).catch(() => {});
  await sleep(1500);
  await shot("start");
  const ctx: Ctx = { cfg, main: null, question: null };
  for (const n of names) {
    const f = scenarios[n];
    if (!f) {
      fail++;
      await log(`FAIL unknown scenario ${n}`);
      continue;
    }
    await log(`SCENARIO ${n}`);
    try {
      await f(ctx);
    } catch (e) {
      fail++;
      await log(`FAIL ${n}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await log(`SUMMARY pass=${pass} fail=${fail}`);
  await log("END");
}
