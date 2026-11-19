// Dev-only self-test: scripted scenarios run through the real client (the same
// actions, store and DOM the person uses) against the real backend and CLIs,
// with a pass/fail log and screenshots. Inert unless the backend reports
// self-test mode, which only a debug build with COOOL_SELFTEST set does
// (see app/src-tauri/src/selftest.rs for how to run it).
//
// Scenarios (COOOL_SELFTEST=all, or a comma list): stream, approval, interrupt,
// model, slash, question, steer, markdown, resume, codex, insights, quit, and `perf` (CPU phases; not in `all`),
// `artifact` (the preview window and its sandbox; no model calls), `browser` (artifact, then the in-app browser's
// tabs and native webviews: layout tracking, hiding, IPC isolation, pop-ups vs tabs, eviction, restoring; needs the
// network for example.com; no model calls), `glass` (the frosted window chrome and device panels in both themes, the
// setting off, inactive, full screen, then frame pacing with it on and off; example.com; no model calls, nothing booted).
// Agents driving the panels through the `coool-device` MCP tools (not in `all`; real model calls, a few cents):
// `agent-browser` (a Claude Haiku chat fills a local form in the Browser panel), `agent-browser-codex` (the same on
// Codex's cheapest model), `agent-iphone` (a Haiku chat reads the iOS version in Settings on a simulator the test
// creates for itself, "coool selftest iPhone", and deletes at the end), `pilot-iphone` / `pilot-browser` (a Haiku chat hands
// Settings > About / the coffee form to the device pilot, `pilot_run`, twice: learned, then from muscle memory),
// `agent-mac` (a Haiku chat opens TextEdit in coool's sandbox Mac, types a sentence and reads it back; the harness
// reads the document from the Mac itself). Those answer the device gate's requests as they come ("this chat" for using
// a device or a site, "Allow once" for the rest). `gate-browser` / `gate-browser-codex` and `gate-mac` /
// `gate-mac-codex` (a chat in an asking mode: a form submit in the Browser panel, a `mac_shell` command; each stops
// and shows a request, Allow lets it run, Deny returns the denial to the agent and nothing happens).
// `browser-settle` (no model calls; needs `COOOL_SELFTEST_SITE`, a local site with static.html, spa.html, live.html,
// long.html and gone.html) drives the `browser_*` tools directly (`selftest_browser_tool`) and logs how long navigate,
// click and observe take on each page and what they returned. `browser-real` (no model calls; public network) opens
// four public affectui.com component pages the same way, saving the first screenshot after each navigation, and logs
// the Reduce motion state and the beam (with Reduce motion as it is, then Off).
// `needs` (the Needs you page: a Haiku chat in Ask mode; a Write and an Edit allowed, a command denied and a question
// answered from the page). `why` ("What this does and why": the agent's claim at once, the AI read on the insights key,
// a description that doesn't match its command, Allow / Deny before and after the read). Prompts are tiny and run on the cheapest models (Claude Haiku, a small Codex model).

import { ignoreChatDefaults, setTextSize } from "./lib/prefs";
import { newChat } from "./lib/actions";
import { api, isTauri } from "./lib/backend";
import { chatNeeds, useChats, type Chat, type ChatItem } from "./lib/chat";
import type { ArtifactInfo, ChatEvent } from "./lib/types";
import { sessionKey } from "./lib/types";
import { displayTitle } from "./lib/format";
import { decideMotion, setMotionPref, type MotionHints, type MotionPref } from "./lib/motion";
import { leaves, resolveTarget, useStore } from "./store";
import { activeTabKey, nativeId, tabKey, useBrowserState } from "./lib/browser";
import { chatPanelKey } from "./lib/browserAgent";
import { perfScenarios } from "./selftestPerf";
import { useReads } from "./lib/explainStore";
import { voiceScenarios } from "./selftestVoice";

interface Config {
  scenario: string;
  dir: string;
  shots: string;
  /** `COOOL_SELFTEST_SITE`: the local test site of `browser-settle`. */
  site?: string | null;
}

const PROMPT_BLUE = "Write three short sentences about the colour blue. Plain text, no lists, and keep every sentence under twelve words so the whole reply stays brief.";
const ALL = ["stream", "approval", "interrupt", "model", "slash", "question", "steer", "markdown", "resume", "codex", "origins", "pty", "usage", "insights", "quit"];
// `perf` is not in ALL: it takes ~4 minutes. Run it alone: COOOL_SELFTEST=perf,quit
const PERF_MODEL = "claude-haiku-5-5";
const CLAUDE_MODEL = "haiku";
const CODEX_MODEL = "gpt-5.6-luna";

let invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
let pass = 0;
let fail = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (line: string) => invoke("selftest_log", { line }).catch(() => {});

/** A screenshot of the main window, or of `window` (an in-app browser pop-up's label). `settle`: ms to wait first. */
async function shot(name: string, window?: string, settle = 700) {
  await sleep(settle); // let springs and fades settle
  try {
    await invoke("selftest_shot", { name, window });
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
function key(k: string, el: Element = composer(), mods: KeyboardEventInit = {}) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
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
    if (name.startsWith("sweep") || /^(mc|timeline|titles|settings|usage|motion|mac-input|pilot-mac|composer):/.test(name)) await shot(`fail-${name.slice(0, 40)}`, undefined, 0);
  }
}

// ---------- the browser tools driven directly (no model) ----------

interface ToolOut {
  ms: number;
  text: string;
  images: string[];
}
/** One `browser_*` tool on chat `chat`'s Browser panel, as its agent would call it (gate included); images saved as `<save>.jpg`. */
async function browserTool(chat: number, name: string, args: Record<string, unknown> = {}, save?: string): Promise<ToolOut> {
  const t = Date.now();
  const out = (await invoke("selftest_browser_tool", { chat, name, args, save })) as { type: string; text?: string; path?: string }[];
  return { ms: Date.now() - t, text: out.find((o) => o.type === "text")?.text ?? "", images: out.filter((o) => o.path).map((o) => o.path!) };
}
/** "(load 812 ms)" / "settle 90 ms" from a tool's text. */
const msOf = (text: string, what: string) => Number(new RegExp(`${what} (\\d+) ms`).exec(text)?.[1] ?? NaN);
/** The id of the element listed as `role "name"` in a page listing. */
function idOf(text: string, role: string, name: string): number {
  const m = new RegExp(`\\[(\\d+)\\] ${role} "${name}"`).exec(text);
  if (!m) throw new Fail(`no ${role} "${name}" in ${text.slice(0, 400)}`);
  return Number(m[1]);
}
const median = (xs: number[]) => {
  const v = xs.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : NaN;
};
/** The click outlines and press rings drawn on `chat`'s page now (device/web_agent.js), or -1 when the page can't say. */
async function pageMarks(chat: number): Promise<number> {
  const r = (await invoke("selftest_page_marks", { chat }).catch(() => null)) as number | null;
  return typeof r === "number" ? r : -1;
}

// ---------- scenarios ----------

interface Ctx {
  cfg: Config;
  /** The main Claude chat most scenarios continue in. */
  main: number | null;
  question: number | null;
  /** Model for the next startClaude (default: CLAUDE_MODEL). */
  model?: string;
}

async function startClaude(ctx: Ctx, prompt?: string): Promise<number> {
  const before = new Set(Object.keys(useChats.getState().chats).map(Number));
  const t = Date.now();
  await newChat({ provider: "claude", cwd: ctx.cfg.dir, model: ctx.model ?? CLAUDE_MODEL, prompt });
  await log(`INFO newChat returned after ${Date.now() - t}ms; chats ${Object.keys(useChats.getState().chats).join(",")}; ptys ${Object.keys(useStore.getState().ptys).join(",")}; toasts ${useStore.getState().toasts.map((x) => x.text).join(" | ")}`);
  return (await waitFor("the new chat", () => newId(before), 10_000)).id;
}

async function ensureMain(ctx: Ctx): Promise<number> {
  if (ctx.main !== null && chat(ctx.main)?.running) return ctx.main;
  ctx.main = await startClaude(ctx);
  await waitFor("ready", () => chat(ctx.main!)?.ready, 60_000);
  return ctx.main;
}

/** The right-panel key of the active pane (as SessionView computes it). */
function activePanelKey(): string | null {
  const st = useStore.getState();
  const tab = st.tabs.find((t) => t.id === st.activeTab);
  const leaf = tab && (tab.root.type === "leaf" ? tab.root : null);
  if (!leaf?.target) return null;
  const r = resolveTarget(leaf.target, st);
  return r.session ? sessionKey(r.session) : r.chat !== null ? `chat:${r.chat}` : null;
}

/** A chat on screen (no prompt: nothing reaches a model) whose browser panel the browser scenarios use. */
async function browserHost(ctx: Ctx): Promise<string> {
  await ensureMain(ctx);
  await waitFor("the chat on screen", () => $("[data-chat-timeline]"), 20_000);
  await sleep(1500); // let the chat link to its session, so the panel key settles
  return waitFor("the pane's panel key", activePanelKey, 10_000);
}

interface WebviewProbe {
  asked: [boolean, [number, number, number, number]] | null;
  hidden: boolean | null;
  frame: [number, number, number, number] | null;
}
const webview = (id: string) => invoke("selftest_webview", { id }) as Promise<WebviewProbe>;
interface PopupProbe {
  label: string;
  opener: string;
  title: string;
  frame: [number, number, number, number] | null;
  visible: boolean;
}
const popups = () => invoke("selftest_popups") as Promise<PopupProbe[]>;
interface PreviewProbe {
  label: string;
  url: string;
  title: string;
  page_title: string;
  page_url: string;
  frame: [number, number, number, number] | null;
  visible: boolean;
  child_of_main: boolean | null;
  main_frame: [number, number, number, number] | null;
}
const previews = () => invoke("selftest_previews") as Promise<PreviewProbe[]>;
const probeResults = async () => ((await invoke("selftest_probe_result")) as string[]).map((s) => JSON.parse(s) as Record<string, unknown>);
/** What an IPC probe (`ipcProbe` in selftest.rs) got that it shouldn't have. */
function ipcLeaks(r: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const k of ["selftestLog", "listSessions", "windowPlugin", "eventListen"]) {
    const v = String(r[k]);
    if (!/^refused|^no invoke/.test(v)) bad.push(`${k}: ${v}`);
  }
  if (r.ipcFetch === 200) bad.push("raw ipc:// fetch answered 200");
  return bad;
}
/** The native view's frame against the spot in the panel it should cover (CSS px, ±2). */
async function tracks(id: string): Promise<string | null> {
  const el = $("[data-browser-native]");
  if (!el) return "no native host in the panel";
  const r = el.getBoundingClientRect();
  const w = await webview(id);
  if (w.hidden !== false) return `webview hidden=${w.hidden}`;
  if (!w.frame) return "no frame";
  const want = [r.left, r.top, r.width, r.height];
  const off = w.frame.map((v, i) => Math.abs(v - want[i]));
  return off.some((d) => d > 2) ? `frame ${w.frame.map(Math.round).join(",")} vs panel ${want.map(Math.round).join(",")}` : null;
}

// ---------- agents driving the panels (coool-device MCP tools) ----------

type Tool = Extract<ChatItem, { kind: "tool" }>;
/** The chat's calls of coool-device tools (Claude: `mcp__coool-device__tap`, Codex: `coool-device.tap`). */
const deviceTools = (id: number, from = 0) => after(id, from).filter((i) => i.kind === "tool" && /coool-device(__|\.)/.test(i.name)) as Tool[];
const toolName = (t: Tool) => t.name.replace(/^.*coool-device(__|\.)/, "");
const toolLine = (t: Tool) => `${toolName(t)} ${t.ok ? "ok" : t.ok === false ? "FAILED" : "?"} ${t.endTs ? ((t.endTs - t.ts) / 1000).toFixed(1) + "s" : ""}`.trim();

/** A check polled while an agent's turn runs: what it saw (truthy) once it holds, with a screenshot then. */
interface Probe {
  name: string;
  test: () => unknown;
  shot?: string;
}

/** The cursors drawn on `chat`'s Browser page now (device/web_agent.js): "who: what" each, or null for none. */
async function pageCursors(chat: number): Promise<string | null> {
  const shown = ((await invoke("selftest_page_cursors", { chat })) ?? []) as { who: string; say: string }[];
  return shown.length ? shown.map((c) => `${c.who}: ${c.say}`).join(" | ") : null;
}
/** An agent cursor over a panel's screen (components/Presence.tsx), as "who: what", or null. */
function htmlCursor(): string | null {
  const c = $("[data-presence-cursor]");
  if (!c) return null;
  return `${c.querySelector("[data-presence-who]")?.textContent}: ${c.querySelector("[data-presence-say]")?.textContent}`;
}
/** After a run: the cursors rest, then fade, and the beam goes (sel: the panel's beam mark). */
async function presenceClears(beam: string, pageChat?: number): Promise<string> {
  const t = Date.now();
  await waitFor(`${beam} (the beam) to go`, () => !$(beam), 2_000);
  const beamMs = Date.now() - t;
  await waitFor("the cursors to fade", () => !$("[data-presence-cursor]"), 3_000);
  let page = "";
  if (pageChat !== undefined) {
    const end = Date.now() + 3_000;
    let left: string | null = "?";
    while (Date.now() < end && (left = await pageCursors(pageChat).catch(() => null))) await sleep(150);
    if (left) throw new Fail(`the page still shows ${left}`);
    page = `, page cursors gone ${Date.now() - t} ms after`;
  }
  return `beam off ${beamMs} ms, cursors gone ${Date.now() - t} ms after the turn ended${page}`;
}

interface AgentRun {
  tools: Tool[];
  /** Every tool the turn called. */
  all: string[];
  reply: string;
  turnMs: number;
  tokens: number | null;
  /** Per mark selector: ms after the prompt it first showed (absent: never). */
  seen: Record<string, number>;
  /** The device gate's requests during the turn, as they showed and were answered. */
  asks: DeviceAskSeen[];
}

/** A request of coool's device gate as the harness saw it: its kind, the card's text, "Needs you", the answer. */
interface DeviceAskSeen {
  kind: string;
  tool: string;
  text: string;
  needs: string | null;
  answer: "chat" | "project" | "once" | "deny";
  ms: number;
}
/** The default answers: "this chat" for using a device or a site, Allow once for the always-ask kinds. */
const allowAll = (a: Pick<DeviceAskSeen, "kind">): DeviceAskSeen["answer"] => (a.kind === "use" || a.kind === "site" ? "chat" : "once");

/**
 * Sends `prompt` to chat `id` and waits for the turn to end, meanwhile watching for each mark (a selector, with a
 * screenshot the first time it shows) and allowing any approval for a coool-device tool (other approvals: denied).
 */
async function agentTurn(id: number, o: { prompt: string; marks: [string, string][]; probes?: Probe[]; ms: number; answer?: (a: Omit<DeviceAskSeen, "answer" | "ms">) => DeviceAskSeen["answer"]; allow?: RegExp }): Promise<AgentRun> {
  const turns = turnEnds(id).length;
  const n = items(id).length;
  const seen: Record<string, number> = {};
  const asks: DeviceAskSeen[] = [];
  const answered = new Set<string>();
  const t0 = Date.now();
  let busy = false;
  const watch = setInterval(() => {
    // Marks are noted even while a screenshot is being taken (a short run can show and clear one meanwhile).
    for (const [sel, name] of o.marks) {
      if (seen[sel] === undefined && $(sel)) {
        seen[sel] = Date.now() - t0;
        void log(`INFO mark ${sel} after ${seen[sel]} ms`);
        if (!busy) {
          busy = true;
          void shot(name).finally(() => (busy = false));
        }
      }
    }
    if (busy) return;
    // coool's own device gate: answered per `o.answer`, each request once, after a screenshot of the first of a kind.
    const dev = $("[data-device-approval]");
    if (dev && !answered.has(dev.dataset.approval ?? "")) {
      const rid = dev.dataset.approval ?? "";
      answered.add(rid);
      const perm = after(id, n).find((i) => i.kind === "permission" && i.requestId === rid) as Extract<ChatItem, { kind: "permission" }> | undefined;
      const base = { kind: dev.dataset.deviceApproval ?? "", tool: perm?.tool ?? "", text: (dev.textContent ?? "").replace(/\s+/g, " ").trim(), needs: chatNeeds(chat(id)) };
      const answer = (o.answer ?? allowAll)(base);
      asks.push({ ...base, answer, ms: Date.now() - t0 });
      busy = true;
      void (async () => {
        await log(`INFO device ask ${base.kind} (${answer}): ${base.text.slice(0, 200)} | needs: ${base.needs}`);
        if (asks.filter((a) => a.kind === base.kind).length === 1) await shot(`ask-${base.kind}-${id}`, undefined, 350);
        const target = answer === "deny" ? button("Deny", dev) : answer === "chat" || answer === "project" ? (dev.querySelector(`[data-remember="${answer}"]`) as HTMLElement | null) : button("Allow once", dev);
        (target ?? button("Allow once", dev))?.click();
      })().finally(() => (busy = false));
      return;
    }
    const card = $("[data-approval]");
    if (card && !card.hasAttribute("data-device-approval")) {
      // The card's own request (an earlier, answered one may come first).
      const pending = (after(id, n).find((i) => i.kind === "permission" && i.requestId === card.dataset.approval) ?? after(id, n).find((i) => i.kind === "permission" && !i.answer)) as { tool?: string; name?: string } | undefined;
      const what = JSON.stringify(pending ?? {}).slice(0, 160);
      const mine = /coool-device/.test(card.textContent ?? "") || /coool-device/.test(what) || !!o.allow?.test(what);
      void log(`INFO approval (${mine ? "allowing" : "denying"}): ${what}`);
      (button(mine ? "Allow once" : /Deny|Decline|Don't allow/, card) ?? button("Allow once", card))?.click();
    }
    // Probes (async checks, e.g. the page's own cursor): one at a time, each until it first holds.
    const p = (o.probes ?? []).find((x) => seen[x.name] === undefined);
    if (p) {
      busy = true;
      void Promise.resolve(p.test())
        .catch(() => null)
        .then(async (what) => {
          if (what) {
            seen[p.name] = Date.now() - t0;
            await log(`INFO probe ${p.name} after ${seen[p.name]} ms: ${what}`);
            if (p.shot) await shot(p.shot, undefined, 0);
          }
        })
        .finally(() => (busy = false));
      return;
    }
  }, 100);
  try {
    await say(o.prompt);
    const end = await nextTurn(id, turns, o.ms);
    await sleep(300);
    const all = after(id, n).filter((i) => i.kind === "tool") as Tool[];
    for (const t of deviceTools(id, n)) await log(`TOOL ${toolLine(t)} ${JSON.stringify(t.input).slice(0, 140)}${t.ok === false ? ` -> ${t.output.slice(0, 300)}` : ""}`);
    // The tools' own timings (what the presence work must not slow): act, settle, observe.
    for (const t of deviceTools(id, n)) {
      const m = /\(act (\d+) ms · settle (\d+) ms(?: · observe (\d+) ms)?\)|· (\d+) ms$/m.exec(t.output);
      if (m) await log(`ACT ${toolName(t)} act=${m[1] ?? m[4]} settle=${m[2] ?? "-"} observe=${m[3] ?? "-"}`);
    }
    for (const a of asks) await log(`ASK ${a.kind} ${a.answer} after ${a.ms} ms: ${a.text.slice(0, 160)}`);
    return { tools: deviceTools(id, n), all: all.map((t) => t.name), reply: lastText(id)?.text ?? "", turnMs: end.durationMs || Date.now() - t0, tokens: end.tokens, seen, asks };
  } finally {
    clearInterval(watch);
  }
}

/** A chat of `provider` on `model` opens a local form in its Browser panel, fills it in, submits, quotes the result. */
async function agentBrowser(ctx: Ctx, provider: "claude" | "codex", model: string) {
  const NAME = "Ada Lovelace";
  const CUPS = 3;
  const REF = `CUP-${100 + 7 * CUPS + NAME.length}`;
  let id = -1;
  let key = "";
  let url = "";
  // What earlier scenarios' pages posted.
  const earlier = (await probeResults()).length;
  const label = provider === "codex" ? "agent-browser-codex" : "agent-browser";
  await step(`${label}: a ${provider} chat on ${model} starts, its Browser panel closed`, async () => {
    url = ((await invoke("selftest_probe_server")) as string).replace(/\/probe$/, "/form");
    const before = new Set(Object.keys(useChats.getState().chats).map(Number));
    await newChat({ provider, cwd: ctx.cfg.dir, model });
    id = (await waitFor("the new chat", () => newId(before), 10_000)).id;
    await waitFor("ready", () => chat(id)?.ready, 90_000);
    await waitFor("the chat on screen", () => $("[data-chat-timeline]"), 20_000);
    await sleep(1500);
    key = await waitFor("the pane's panel key", activePanelKey, 10_000);
    if (useStore.getState().browser[key]?.tabs.length) throw new Fail("the panel already has tabs");
    return `chat ${id}, ${url}`;
  });
  if (id < 0) return;
  const r = await agentTurn(id, {
    prompt: `Use the browser_* tools (the Browser panel beside this chat), not the shell or curl. Open ${url} , type the name ${NAME} and the email ada@example.com, press the "Add cup" button until the cups counter shows ${CUPS}, then press "Submit order". Reply with the exact confirmation sentence the page shows, nothing else.`,
    marks: [
      ["[data-browser-driving]", `${label}-acting`],
      ["[data-browser-agent-tab]", `${label}-tab-mark`],
    ],
    probes: [{ name: "page-cursor", test: () => pageCursors(id), shot: `${label}-cursor` }],
    ms: 240_000,
  });
  await step(`${label}: the agent's cursor showed on the page with its label, the beam ran, and both clear after the turn`, async () => {
    if (r.seen["page-cursor"] === undefined) throw new Fail("no agent cursor on the page while it acted");
    if (r.seen["[data-browser-driving]"] === undefined) throw new Fail("no beam around the page");
    return `cursor after ${r.seen["page-cursor"]} ms, beam after ${r.seen["[data-browser-driving]"]} ms; ${await presenceClears("[data-browser-driving]", id)}`;
  });
  await step(`${label}: the agent's browser_* tool calls succeed`, async () => {
    const browser = r.tools.filter((t) => toolName(t).startsWith("browser_"));
    if (!browser.length) throw new Fail(`no browser_* calls; tools: ${r.all.join(", ") || "none"}`);
    const worked = (n: string) => browser.some((t) => t.ok && (toolName(t) === n || (toolName(t) === "browser_batch" && n !== "browser_navigate")));
    for (const n of ["browser_navigate", "browser_type", "browser_click"]) if (!worked(n)) throw new Fail(`no ${n} that worked: ${browser.map(toolLine).join("; ")}`);
    const failed = browser.filter((t) => t.ok === false).length;
    if (failed > 2) throw new Fail(`${failed} of ${browser.length} calls failed: ${browser.map(toolLine).join("; ")}`);
    return browser.map(toolLine).join("; ");
  });
  await step(`${label}: the page really changed (its own report), the panel shows it, the reply quotes it`, async () => {
    const forms = (await probeResults()).slice(earlier).filter((p) => p.step === "form");
    const last = forms[forms.length - 1];
    if (!last) throw new Fail("the page never reported a change");
    if (!last.submitted || last.name !== NAME || last.cups !== CUPS || last.email !== "ada@example.com") throw new Fail(`page state ${JSON.stringify(last)}`);
    if (!String(last.confirmation).includes(REF)) throw new Fail(`confirmation ${last.confirmation}`);
    await sleep(800);
    await shot(`${label}-done`);
    // The chat linked to its session meanwhile: its panel moved from `chat:<id>` to the session's key.
    const now = chatPanelKey(id);
    const b = useStore.getState().browser[now];
    const tab = b?.tabs.find((t) => t.id === b.active);
    if (!tab || tab.page.kind !== "web" || !tab.page.url.includes("/form")) throw new Fail(`panel ${key} -> ${now}: tab ${JSON.stringify(tab)}; panels with tabs: ${Object.keys(useStore.getState().browser).join(", ")}`);
    const wv = nativeId(tabKey(now, tab.id));
    if (!wv) throw new Fail("the tab has no webview");
    const bad = await tracks(wv);
    if (bad) throw new Fail(`the page isn't on screen in the panel: ${bad}`);
    if (!r.reply.includes(REF)) throw new Fail(`reply ${JSON.stringify(r.reply)} lacks ${REF}`);
    key = now;
    return `reply ${JSON.stringify(r.reply.trim().slice(0, 160))}; panel ${key}; turn ${r.turnMs} ms, ${r.tokens ?? "?"} tokens; ${forms.length} page reports`;
  });
  await step(`${label}: the tab's agent indicator showed while it acted`, async () => {
    if (r.seen["[data-browser-agent-tab]"] === undefined) throw new Fail("no agent mark on the tab");
    return `tab mark after ${r.seen["[data-browser-agent-tab]"]} ms`;
  });
  if (key) useStore.getState().closeBrowser(key);
}

// ---------- the device gate (APP_SPEC "Device permissions") ----------

/** A chat of `provider` in permission mode `mode`, on screen, its panels closed. */
async function gateChat(ctx: Ctx, provider: "claude" | "codex", model: string, mode: string): Promise<{ id: number; key: string }> {
  const before = new Set(Object.keys(useChats.getState().chats).map(Number));
  await newChat({ provider, cwd: ctx.cfg.dir, model, permissionMode: mode });
  const id = (await waitFor("the new chat", () => newId(before), 10_000)).id;
  await waitFor("ready", () => chat(id)?.ready, 90_000);
  await waitFor("the chat on screen", () => $("[data-chat-timeline]"), 20_000);
  await sleep(1500);
  const key = await waitFor("the pane's panel key", activePanelKey, 10_000);
  if (chat(id)?.permissionMode !== mode) throw new Fail(`mode ${chat(id)?.permissionMode}, not ${mode}`);
  return { id, key };
}

/** The denial the agent got back from a gated call in this run, if any. */
const denial = (r: AgentRun) => r.tools.find((t) => /Denied by the person/.test(t.output));

async function gateBrowser(ctx: Ctx, provider: "claude" | "codex", model: string, mode: string) {
  const label = provider === "codex" ? "gate-browser-codex" : "gate-browser";
  let id = -1;
  let url = "";
  await step(`${label}: a ${provider} chat in ${mode} mode starts`, async () => {
    url = ((await invoke("selftest_probe_server")) as string).replace(/\/probe$/, "/form");
    ({ id } = await gateChat(ctx, provider, model, mode));
    return `chat ${id}, ${url}`;
  });
  if (id < 0) return;
  const earlier = (await probeResults()).length;
  const allow = await agentTurn(id, {
    prompt: `Use the browser_* tools (the Browser panel beside this chat), not the shell or curl. Open ${url} , type the name Ada, press "Add cup" once, then press "Submit order". Reply with the confirmation sentence the page shows, nothing else.`,
    marks: [],
    ms: 240_000,
  });
  await step(`${label}: using the Browser asked once (with the site), the submit stopped and asked with its label, Allow submitted`, async () => {
    const use = allow.asks.find((a) => a.kind === "use");
    const sub = allow.asks.find((a) => a.kind === "submit");
    if (!use || !/127\.0\.0\.1/.test(use.text)) throw new Fail(`no "use the Browser" request naming the site: ${JSON.stringify(allow.asks)}`);
    if (!sub) throw new Fail(`the submit didn't ask: ${JSON.stringify(allow.asks)}; tools ${allow.tools.map(toolLine).join("; ")}`);
    if (!/Submit order/.test(sub.text) || !/127\.0\.0\.1/.test(sub.text)) throw new Fail(`the submit card doesn't say what and where: ${sub.text}`);
    if (!sub.needs || !/^Approve Browser/.test(sub.needs)) throw new Fail(`"Needs you" while it waited: ${sub.needs}`);
    if (allow.asks.filter((a) => a.kind === "use" || a.kind === "site").length > 1) throw new Fail(`asked again after "this chat": ${JSON.stringify(allow.asks)}`);
    const forms = (await probeResults()).slice(earlier).filter((p) => p.step === "form");
    const last = forms[forms.length - 1];
    if (!last?.submitted || last.name !== "Ada") throw new Fail(`the page wasn't submitted: ${JSON.stringify(last)}`);
    if (denial(allow)) throw new Fail("a call was denied");
    return `${allow.asks.map((a) => `${a.kind}→${a.answer} @${a.ms}ms`).join(", ")}; needs "${sub.needs}"; reply ${JSON.stringify(allow.reply.trim().slice(0, 120))}; turn ${allow.turnMs} ms`;
  });
  const mid = (await probeResults()).length;
  const deny = await agentTurn(id, {
    prompt: `Open ${url} again, type the name Bob, press "Add cup" once, then press "Submit order". If coool says the person denied it, don't try another way: reply with exactly DENIED.`,
    marks: [],
    ms: 240_000,
    answer: (a) => (a.kind === "submit" ? "deny" : allowAll(a)),
  });
  await step(`${label}: Deny returned the denial to the agent and the page was not submitted`, async () => {
    const sub = deny.asks.find((a) => a.kind === "submit");
    if (!sub) throw new Fail(`the submit didn't ask: ${JSON.stringify(deny.asks)}; tools ${deny.tools.map(toolLine).join("; ")}`);
    if (deny.asks.some((a) => a.kind === "use" || a.kind === "site")) throw new Fail(`asked to use the Browser again in the same chat: ${JSON.stringify(deny.asks)}`);
    const d = denial(deny);
    if (!d) throw new Fail(`no tool result carried the denial: ${deny.tools.map((t) => `${toolLine(t)} ${t.output.slice(0, 80)}`).join("; ")}`);
    const sent = (await probeResults()).slice(mid).filter((p) => p.step === "form" && p.submitted);
    if (sent.length) throw new Fail(`the page was submitted anyway: ${JSON.stringify(sent)}`);
    await shot(`${label}-denied`);
    return `denied ${toolName(d)}: ${JSON.stringify(d.output.slice(0, 140))}; reply ${JSON.stringify(deny.reply.trim().slice(0, 80))}; turn ${deny.turnMs} ms`;
  });
  useStore.getState().closeBrowser(chatPanelKey(id));
}

async function gateMac(ctx: Ctx, provider: "claude" | "codex", model: string, mode: string) {
  const label = provider === "codex" ? "gate-mac-codex" : "gate-mac";
  const mac = (request: Record<string, unknown>) => invoke("selftest_mac", { request }) as Promise<Record<string, unknown>>;
  const token = `gate-ok-${Math.floor(Math.random() * 1e6)}`;
  const denied = "/tmp/coool-gate-denied";
  let id = -1;
  try {
    await step(`${label}: the sandbox Mac is up and a ${provider} chat in ${mode} mode starts`, async () => {
      const st = await api().macStatus();
      if (!st.available || !st.installed) throw new Fail(`no sandbox Mac: ${st.reason ?? "not installed"}`);
      await api().macBoot();
      await mac({ cmd: "run", sh: `rm -f /tmp/coool-gate.txt ${denied}`, timeout: 10 });
      ({ id } = await gateChat(ctx, provider, model, mode));
      return `chat ${id}; network ${(await api().macStatus()).networkNow ?? "?"}`;
    });
    if (id < 0) return;
    const allow = await agentTurn(id, {
      prompt: `Use the coool-device tool mac_shell (it runs in coool's sandbox Mac) to run exactly this command: echo ${token} > /tmp/coool-gate.txt && cat /tmp/coool-gate.txt . Don't use your own shell. Reply with the command's output, nothing else.`,
      marks: [],
      ms: 240_000,
    });
    await step(`${label}: mac_shell stopped and asked, showing the command; Allow ran it`, async () => {
      const sh = allow.asks.find((a) => a.kind === "shell");
      if (!sh) throw new Fail(`mac_shell didn't ask: ${JSON.stringify(allow.asks)}; tools ${allow.tools.map(toolLine).join("; ")}`);
      if (!sh.text.includes(`echo ${token}`)) throw new Fail(`the card doesn't show the command: ${sh.text}`);
      if (!sh.needs || !/^Approve Mac/.test(sh.needs)) throw new Fail(`"Needs you" while it waited: ${sh.needs}`);
      const out = (await mac({ cmd: "run", sh: "cat /tmp/coool-gate.txt", timeout: 10 })) as { output?: string };
      if (!String(out.output ?? "").includes(token)) throw new Fail(`the file in the Mac holds ${JSON.stringify(out.output)}`);
      return `asked after ${sh.ms} ms: ${sh.text.slice(0, 140)}; needs "${sh.needs}"; the Mac's file holds ${token}; turn ${allow.turnMs} ms`;
    });
    const deny = await agentTurn(id, {
      prompt: `Use mac_shell again to run exactly: touch ${denied} . If coool says the person denied it, don't try another way: reply with exactly DENIED.`,
      marks: [],
      ms: 240_000,
      answer: (a) => (a.kind === "shell" ? "deny" : allowAll(a)),
    });
    await step(`${label}: Deny returned the denial to the agent and the command didn't run`, async () => {
      const sh = deny.asks.find((a) => a.kind === "shell");
      if (!sh) throw new Fail(`mac_shell didn't ask: ${JSON.stringify(deny.asks)}`);
      const d = denial(deny);
      if (!d) throw new Fail(`no tool result carried the denial: ${deny.tools.map((t) => `${toolLine(t)} ${t.output.slice(0, 80)}`).join("; ")}`);
      const out = (await mac({ cmd: "run", sh: `test -e ${denied} && echo present || echo absent`, timeout: 10 })) as { output?: string };
      if (!/absent/.test(String(out.output))) throw new Fail(`the command ran anyway: ${out.output}`);
      return `denied: ${JSON.stringify(d.output.slice(0, 140))}; ${denied} absent; reply ${JSON.stringify(deny.reply.trim().slice(0, 60))}`;
    });
  } finally {
    await mac({ cmd: "run", sh: `rm -f /tmp/coool-gate.txt ${denied}`, timeout: 10 }).catch(() => {});
  }
}

// ---------- the device pilot (pilot_run) ----------

interface PilotRunResult {
  status: string;
  verified: boolean;
  reason: string;
  steps: { n: number; decider: string; action: string; perceive_ms: number; decide_ms: number; act_ms: number; settle_ms: number }[];
  wall_ms: number;
  start_ms: number;
  start: string;
  deciders: Record<string, number>;
  decide_ms: number;
  haiku_usd: number;
  haiku_tokens: number;
  haiku_cached_tokens: number;
  checks: [string, boolean][];
}
/** The chat's pilot_run calls in a turn, with their outcomes (the JSON after the result's first line). */
function pilotRuns(r: AgentRun): { tool: Tool; out: PilotRunResult | null }[] {
  return r.tools
    .filter((t) => toolName(t) === "pilot_run")
    .map((t) => {
      const i = t.output.indexOf("\n{");
      let out: PilotRunResult | null = null;
      try {
        out = i >= 0 ? (JSON.parse(t.output.slice(i + 1)) as PilotRunResult) : null;
      } catch {
        out = null;
      }
      return { tool: t, out };
    });
}
/** One line of numbers for the log: wall, start, steps by decider, decision latency, cost. */
function pilotLine(o: PilotRunResult): string {
  const model = o.steps.filter((s) => s.decider !== "memory");
  const lat = model.map((s) => s.decide_ms);
  const by = Object.entries(o.deciders).map(([k, n]) => `${n} ${k}`).join(", ");
  return `${o.status}${o.verified ? " verified" : ""}: wall ${o.wall_ms} ms (start ${o.start_ms} ms, steps ${o.wall_ms - o.start_ms} ms), ${o.steps.length} steps (${by}); model decisions ${lat.length ? `${lat.join("/")} ms` : "none"}; memory decisions ${o.steps.filter((s) => s.decider === "memory").map((s) => s.decide_ms).join("/") || "none"} ms; haiku $${o.haiku_usd.toFixed(5)}, ${o.haiku_tokens} input tokens (${o.haiku_cached_tokens} cached); steps: ${o.steps.map((s) => `${s.n}.${s.action}[${s.decider} p${s.perceive_ms}/d${s.decide_ms}/a${s.act_ms}/s${s.settle_ms}]`).join(" ")}`;
}
/** A pilot decision-log record (device/pilot/dataset.rs `Record`). */
interface PilotRecord {
  run: string;
  step: number;
  target: string;
  goal: string;
  input_keys: string[];
  screen: { summary: string; candidates: { id: number; verb: string; input_key?: string }[] };
  prev: string;
  decider: string;
  chosen: number;
  decision_ms: number;
  outcome: string;
  verified: boolean;
  on_success_path: boolean | null;
}
/** The test's pilot decision log: the raw lines and the records. */
async function pilotLog(): Promise<{ raw: string; recs: PilotRecord[] }> {
  const lines = (await invoke("selftest_pilot_log")) as string[];
  return { raw: lines.join("\n"), recs: lines.map((l) => JSON.parse(l) as PilotRecord) };
}

// ---------- research: a Haiku chat walks a public website in its Browser panel ----------

/**
 * `inspo-<n>` (research only, never in `all`; real model calls and a public website): a fresh Claude Haiku chat
 * visits one batch of affectui.com's component pages in its Browser panel with the `browser_*` tools and reports
 * each page in a fixed format; the harness takes a window screenshot (twice, 1.2 s apart, to see motion) whenever
 * the agent takes a `browser_screenshot`, and logs the reply and every tool's timing. Batch 0 is the index.
 */
const INSPO_SITE = "https://www.affectui.com/components/";
const INSPO_BATCHES: string[][] = [
  ["", "agent-checkpoints", "agent-crew", "agent-cursors", "agent-findings", "agent-fleet"],
  ["agent-graph", "agent-handoff", "agent-inbox", "agent-lanes", "agent-ledger", "agent-monitor", "agent-plan", "agent-queue"],
  ["agent-recap", "agent-sequence", "agent-steering", "agent-trail", "agent-tree", "ai-answer", "approval-card", "approval-gates"],
  ["autonomy-dial", "away-summary", "change-summary", "chat-composer", "cited-answer", "code-block", "collaboration-stream", "command-menu"],
  ["commit-trail", "compact-breakdown", "conflict-radar", "context-map", "context-window", "cost-waterfall", "decision-card", "decision-inbox"],
  ["decision-tree", "delegate-board", "diff-timeline", "fallback-chain", "fan-out-grid", "inline-diff", "judge-bracket", "memory-graph"],
  ["memory-panel", "message-actions", "model-picker", "model-usage", "notification-stack", "parallel-attempts", "permission-request", "plan-vs-actual"],
  ["prompt-library", "rate-limit-planner", "reasoning-summary", "review-center", "root-cause-tree", "run-controls", "running-now", "scheduled-runs"],
  ["smart-recommendation", "thinking-loader", "thinking-state", "tool-access-map", "tool-call-card", "trace-waterfall", "usage-meter", "toaster"],
  ["segmented-control", "empty-state", "tree-view", "hover-card", "kbd", "badge", "stat-card", "trend-chart"],
  ["breadcrumb", "combobox", "tag-input", "button", "icon-button", "project-card", "dropzone", "skeleton"],
  // A re-check of the tools on two live previews (wait_for idle on a page that never goes quiet).
  ["trace-waterfall", "plan-vs-actual"],
];

async function inspo(ctx: Ctx, name: string) {
  const n = Number(name.slice("inspo-".length));
  const slugs = INSPO_BATCHES[n];
  if (!slugs) throw new Fail(`no batch ${name}`);
  const urls = slugs.map((s) => INSPO_SITE + s);
  let id = -1;
  await step(`${name}: a Haiku chat starts`, async () => {
    const before = new Set(Object.keys(useChats.getState().chats).map(Number));
    await newChat({ provider: "claude", cwd: ctx.cfg.dir, model: PERF_MODEL });
    id = (await waitFor("the new chat", () => newId(before), 10_000)).id;
    await waitFor("ready", () => chat(id)?.ready, 90_000);
    await waitFor("the chat on screen", () => $("[data-chat-timeline]"), 20_000);
    await sleep(1200);
    // A wide panel for the previews; not persisted (no setBrowserWidth, which writes localStorage).
    useStore.setState({ browserWidth: 900 });
    return `chat ${id}`;
  });
  if (id < 0) return;
  const index = slugs[0] === "";
  const prompt = [
    "You are cataloguing a public UI component website for design research. Use ONLY the browser_* tools (the Browser panel beside this chat): no shell, no curl, no web fetch, no other tools, no files.",
    "Never click 'Get Pro', pricing, buy, sign-in or sign-up links, never type anything into the site, never open code tabs. Read only what the public page shows.",
    index
      ? `First open ${urls[0]} with browser_navigate. It lists about 130 components. Call browser_observe with all=true and text_max=20000 to read the whole list, then browser_screenshot once. Report the category headings or filters and how the list is organised (and say if the listing came back cut short).`
      : "",
    `Then visit each of these pages one at a time, in this order: ${urls.slice(index ? 1 : 0).join(" , ")}`,
    "If a cookie banner shows, click its Decline button once (browser_click) and carry on.",
    "For each page: call browser_navigate with its URL (the result lists the page), then call browser_screenshot once to see the live preview. If the preview area is still empty in that screenshot, call browser_wait_for with idle=true, then browser_screenshot again; if it is below the fold, call browser_scroll down once and browser_screenshot again. Nothing else per page.",
    index ? "Start your reply with a block '### Index' that gives the tabs or category filters you saw, the number of components the page claims, how many component cards your observe listed, and whether the listing was cut short." : "",
    "When all pages are done, reply with one block per page in exactly this format and nothing else:",
    "### <component name>\n- url: <url>\n- category: <breadcrumb item after Components>\n- tagline: <the one-line description under the title, verbatim>\n- tier: <Pro if the page says 'Part of affectUI Pro' or 'Get Pro', else Free>\n- preview: <2-4 sentences: what the preview shows, its layout, the sample data, colours and states>\n- motion: <what looks animated or live in the preview, or 'static as far as visible'>\n- tool notes: <anything that went wrong with the browser tools on this page: errors, cut-off or empty listings, slow calls, missing elements; or 'none'>",
  ]
    .filter(Boolean)
    .join("\n\n");
  // Window screenshots whenever the agent looks at the page.
  let seen = items(id).length;
  let shots = 0;
  let busy = false;
  const watcher = setInterval(() => {
    if (busy) return;
    const fresh = items(id).slice(seen);
    const sc = fresh.find((i) => i.kind === "tool" && /browser_screenshot$/.test(i.name));
    if (!sc) return;
    seen = items(id).indexOf(sc) + 1;
    busy = true;
    const key = chatPanelKey(id);
    const b = useStore.getState().browser[key];
    const tab = b?.tabs.find((t) => t.id === b.active);
    const live = b ? useBrowserState.getState().byKey[activeTabKey(key) ?? ""]?.url : undefined;
    const url = live ?? (tab?.page.kind === "web" ? tab.page.url : "");
    const slug = (url.split("/components")[1] ?? "").replace(/^\//, "").replace(/[^a-z0-9-]/gi, "-") || "index";
    const host = $("[data-browser-native]")?.getBoundingClientRect();
    shots++;
    const nm = `inspo-${slug}-${shots}`;
    void (async () => {
      await shot(`${nm}-a`, undefined, 250);
      await shot(`${nm}-b`, undefined, 900);
      if (host) await log(`RECT ${nm} ${Math.round(host.left)},${Math.round(host.top)},${Math.round(host.width)},${Math.round(host.height)} dpr=${devicePixelRatio} url=${url}`);
    })().finally(() => (busy = false));
  }, 150);
  try {
    const r = await agentTurn(id, { prompt, marks: [["[data-browser-driving]", `${name}-beam`]], probes: [{ name: "page-cursor", test: () => pageCursors(id), shot: `${name}-cursor` }], ms: 1_200_000 });
    await log(`REPLY ${name} ${JSON.stringify(r.reply)}`);
    await step(`${name}: the agent visited the pages`, async () => {
      const failed = r.tools.filter((t) => t.ok === false);
      for (const t of failed) await log(`TOOLFAIL ${toolName(t)} ${JSON.stringify(t.input).slice(0, 200)} -> ${t.output.slice(0, 600).replace(/\n/g, " | ")}`);
      // Every tool's timing, with what it reported about itself (load / act / settle / observe ms).
      for (const t of r.tools) {
        const own = [...t.output.matchAll(/\((?:load|act|observe|screenshot)[^)]*\)/g)].map((m) => m[0]).join(" ");
        const head = t.output.split("\n").find((l) => /^ready|^loading|elements/.test(l)) ?? "";
        await log(`TIMING ${toolName(t)} ${t.endTs ? t.endTs - t.ts : "?"}ms ${JSON.stringify(t.input).slice(0, 120)} ${own} ${head.slice(0, 120)}`);
      }
      return `turn ${r.turnMs} ms, ${r.tokens ?? "?"} out tokens, ${r.tools.length} device calls, ${failed.length} failed, ${shots} screenshots; other tools: ${r.all.filter((a) => !/coool-device/.test(a)).join(", ") || "none"}`;
    });
  } finally {
    clearInterval(watcher);
  }
  await sleep(1500);
  const key = chatPanelKey(id);
  if (key) useStore.getState().closeBrowser(key);
}

const scenarios: Record<string, (ctx: Ctx) => Promise<void>> = {
  /**
   * The browser panel: an artifact preview window, then https://example.com in a tab's native child webview, which
   * follows the panel through a window resize and a panel resize, hides under the palette, when the panel switches
   * kind, and on another tab; a local probe page (a remote origin) can't reach coool's IPC or navigate anywhere but
   * http(s); a sized `window.open` opens a pop-up window that keeps `window.opener`, posts back, closes itself, and
   * has no IPC either; `target=_blank` and a bare `window.open` open tabs; switching and closing tabs; Open adds or
   * focuses a tab; at most 4 webviews stay alive and an evicted tab reloads where it was; a pop-up left open closes
   * with the panel; closing remembers the tabs and the globe restores them; the address bar; the start view and "+".
   * Needs the network (example.com); no model calls.
   */
  async browser(ctx) {
    await scenarios.artifact(ctx);
    const key = await waitFor("the pane's panel key", activePanelKey, 10_000);
    const st = () => useStore.getState();
    const tabs = () => st().browser[key];
    const activeKey = () => activeTabKey(key) ?? "";
    const state = () => useBrowserState.getState().byKey[activeKey()];
    /** The showing tab's webview, once it exists. */
    const current = (what = "the webview") => waitFor(what, () => nativeId(activeKey()), 10_000);
    const tabEl = (id: number) => document.querySelector<HTMLElement>(`[data-browser-tab="${id}"]`);
    const activeTab = () => tabs()?.tabs.find((t) => t.id === tabs()?.active);
    let id = "";
    await step("a web page opens in a tab, in the panel's native webview, laid over the panel", async () => {
      st().openBrowser(key, { kind: "web", url: "https://example.com" });
      id = await current();
      await waitFor("the page title", () => /Example Domain/.test(state()?.title ?? ""), 30_000);
      await sleep(900);
      await shot("browser-web");
      const bad = await tracks(id);
      if (bad) throw new Fail(bad);
      const title = $("[data-browser-title]")?.textContent;
      if (!/Example Domain/.test(title ?? "")) throw new Fail(`tab title ${title}`);
      if (tabs()?.tabs.length !== 1) throw new Fail(`${tabs()?.tabs.length} tabs`);
      if ($("[data-browser-tabs]")?.dataset.browserTabs !== "1") throw new Fail("no tab strip with one tab");
      return `${id}: ${state()?.url}`;
    });
    await step("it tracks the panel when the window resizes", async () => {
      await invoke("selftest_resize", { width: 1180, height: 760 });
      await sleep(1500);
      await shot("browser-resized");
      const bad = await tracks(id);
      await invoke("selftest_resize", { width: 1440, height: 900 });
      await sleep(1200);
      if (bad) throw new Fail(bad);
      const back = await tracks(id);
      if (back) throw new Fail(`after resizing back: ${back}`);
    });
    await step("it tracks the panel's own width (remembered)", async () => {
      const before = st().browserWidth;
      st().setBrowserWidth(760);
      await sleep(1000);
      const bad = await tracks(id);
      const saved = localStorage.getItem("coool.browserWidth");
      st().setBrowserWidth(before);
      await sleep(800);
      if (bad) throw new Fail(bad);
      if (saved !== "760") throw new Fail(`width saved as ${saved}`);
    });
    await step("it hides under the palette and comes back", async () => {
      st().setPalette(true);
      await sleep(500);
      const under = await webview(id);
      await shot("browser-palette");
      st().setPalette(false);
      await sleep(800);
      if (under.hidden !== true) throw new Fail(`under the palette hidden=${under.hidden}`);
      const bad = await tracks(id);
      if (bad) throw new Fail(`after the palette: ${bad}`);
    });
    await step("switching the panel to Models / Jobs hides it; the header globe brings it back", async () => {
      st().setRightPanel(key, "models");
      await sleep(900);
      const models = await webview(id);
      await shot("browser-switched-models");
      // Jobs: the chat has none, so asking for it closes the panel; the webview hides the same way.
      st().setRightPanel(key, "agents");
      await sleep(900);
      const jobs = await webview(id);
      if (models.hidden !== true) throw new Fail(`with Models showing hidden=${models.hidden}`);
      if (jobs.hidden !== true) throw new Fail(`with Jobs asked for hidden=${jobs.hidden}`);
      const globe = ([...document.querySelectorAll("button")] as HTMLElement[]).find((b) => /Show the browser/.test(b.title));
      if (!globe) throw new Fail("no header button to show the browser again");
      globe.click();
      await sleep(1200);
      const bad = await tracks(id);
      if (bad) throw new Fail(`after showing it again: ${bad}`);
    });
    await step("another tab hides it; coming back shows it", async () => {
      const tab = st().activeTab;
      st().activate(null);
      await sleep(900);
      const home = await webview(id);
      await shot("browser-home");
      st().activate(tab);
      await sleep(1500);
      if (home.hidden !== true) throw new Fail(`on Home hidden=${home.hidden}`);
      const bad = await tracks(id);
      if (bad) throw new Fail(`back on the tab: ${bad}`);
    });
    await step("only http(s) pages load: other schemes are refused", async () => {
      const refused: string[] = [];
      for (const u of ["file:///etc/hosts", "javascript:alert(1)", "coool-artifact://localhost/x/y.html", "tauri://localhost/", location.origin + "/"]) {
        const ok = await invoke("browser_navigate", { id, url: u }).then(
          () => true,
          () => false,
        );
        if (ok) refused.push(`navigated to ${u}`);
      }
      if (refused.length) throw new Fail(refused.join("; "));
    });
    await step("a remote page in it reaches none of coool's IPC and can't navigate out of http(s)", async () => {
      const url = (await invoke("selftest_probe_server")) as string;
      st().openBrowser(key, { kind: "web", url: `${url}?app=${encodeURIComponent(location.origin + "/")}` });
      const end = Date.now() + 40_000;
      let got: Record<string, unknown>[] = [];
      while (Date.now() < end) {
        got = ((await invoke("selftest_probe_result")) as string[]).map((s) => JSON.parse(s) as Record<string, unknown>);
        if (got.some((g) => g.step === "done")) break;
        await sleep(500);
      }
      await shot("browser-probe");
      const ipc = got.find((g) => g.step === "ipc");
      if (!ipc) throw new Fail(`no probe result (${JSON.stringify(got)})`);
      const bad = ipcLeaks(ipc);
      for (const g of got.filter((g) => g.tried)) if (!String(g.href).startsWith(url)) bad.push(`${g.step}: ended up at ${g.href}`);
      if (!got.some((g) => g.step === "done")) bad.push("the probe never finished");
      if (tabs()?.tabs.length !== 2) bad.push(`${tabs()?.tabs.length} tabs, not 2`);
      if (bad.length) throw new Fail(`${bad.join("; ")} (${JSON.stringify(got)})`);
      return JSON.stringify(got);
    });
    let base = "";
    let openerTab = 0;
    const seen = new Set<string>();
    await step("window.open with a size opens a pop-up window that keeps window.opener: it posts back and closes itself", async () => {
      base = ((await invoke("selftest_probe_server")) as string).replace(/\/probe$/, "");
      st().openBrowser(key, { kind: "web", url: `${base}/opener` });
      openerTab = tabs()!.active;
      id = await current("the opener's webview");
      await waitFor("the opener page", () => state()?.title === "Opener ready", 20_000).catch((e) => {
        throw new Fail(`${e.message}: ${JSON.stringify(state())} native ${nativeId(activeKey())}`);
      });
      if ((await popups()).length) throw new Fail("a pop-up is already open");
      // Script the app evaluates counts as a user gesture, as the person's click on "Continue with Google" does.
      await invoke("selftest_browser_eval", { id, js: `document.getElementById("open").click()` });
      let pop: PopupProbe | undefined;
      for (const end = Date.now() + 10_000; !pop && Date.now() < end; await sleep(200)) pop = (await popups())[0];
      if (!pop) throw new Fail(`no pop-up window (opener title: ${state()?.title})`);
      seen.add(pop.label);
      // Its page title, once loaded (the window is titled with it).
      for (const end = Date.now() + 10_000; Date.now() < end && !/pop-up probe/.test(pop.title); await sleep(200)) pop = (await popups()).find((p) => p.label === pop!.label) ?? pop;
      await shot("browser-popup", pop.label);
      await shot("browser-popup-opener");
      const bad: string[] = [];
      if (pop.opener !== id) bad.push(`opener ${pop.opener}, not ${id}`);
      if (!/pop-up probe/.test(pop.title)) bad.push(`window title "${pop.title}"`);
      if (!pop.visible) bad.push("pop-up not visible");
      await waitFor("the opener to get the pop-up's message", () => /^Opener got: /.test(state()?.title ?? ""), 20_000).catch(() => {});
      const got = state()?.title ?? "";
      if (!/^Opener got: hi/.test(got)) bad.push(`opener title "${got}"`);
      await waitFor("the pop-up to close itself", () => /pop-up closed$/.test(state()?.title ?? ""), 10_000).catch(() => bad.push(`opener title "${state()?.title}" (pop-up not closed?)`));
      await sleep(500);
      const left = await popups();
      if (left.length) bad.push(`pop-up window still open: ${JSON.stringify(left)}`);
      if (tabs()?.active !== openerTab) bad.push("the pop-up changed the panel's tab");
      const res = await probeResults();
      const ipc = res.find((r) => r.step === "popup-ipc");
      if (!ipc) bad.push("no IPC probe result from the pop-up");
      else {
        bad.push(...ipcLeaks(ipc).map((b) => `pop-up ${b}`));
        if (ipc.hasOpener !== true) bad.push("the pop-up had no window.opener");
        if (!/Version\/[\d.]+ Safari\//.test(String(ipc.userAgent))) bad.push(`pop-up user agent ${ipc.userAgent}`);
      }
      if (bad.length) throw new Fail(`${bad.join("; ")} (${JSON.stringify({ pop, ipc })})`);
      return `${pop.label} "${pop.title}" ${pop.frame?.map(Math.round).join(",")}; opener: "${got}"; ${JSON.stringify(ipc)}`;
    });
    const openerId = () => id;
    let blankTab = 0;
    let blankId = "";
    await step("a target=_blank link opens a new tab (no window); the opener's webview hides behind it", async () => {
      // A page that is one big target=_blank link, clicked for real (a script's click() isn't trusted).
      st().navigateBrowserTab(key, openerTab, `${base}/blanklink`);
      await waitFor("the link page", () => state()?.title === "Link page", 20_000);
      await sleep(600);
      const before = tabs()!.tabs.length;
      const pops = (await popups()).length;
      await invoke("selftest_click", { id: openerId() });
      await waitFor("a new tab", () => tabs()!.tabs.length === before + 1, 10_000).catch((e) => {
        throw new Fail(`${e.message} (link page title: "${state()?.title}")`);
      });
      blankTab = tabs()!.active;
      blankId = await current("the new tab's webview");
      await waitFor("the new tab's page", () => state()?.title === "Tab via=blank", 20_000);
      await sleep(900);
      await shot("browser-tab-blank");
      const bad: string[] = [];
      const order = tabs()!.tabs.map((t) => t.id);
      if (order.indexOf(blankTab) !== order.indexOf(openerTab) + 1) bad.push(`new tab at ${order.indexOf(blankTab)}, opener at ${order.indexOf(openerTab)}`);
      if ((await popups()).length !== pops) bad.push("a pop-up window opened");
      if ((await webview(openerId())).hidden !== true) bad.push("the opener's webview is still shown");
      const t = await tracks(blankId);
      if (t) bad.push(t);
      if (!/Tab via=blank/.test($("[data-browser-title]")?.textContent ?? "")) bad.push(`tab title ${$("[data-browser-title]")?.textContent}`);
      if (bad.length) throw new Fail(bad.join("; "));
      return `${blankId}: ${state()?.url}`;
    });
    await step("switching tabs swaps the visible webview", async () => {
      const el = tabEl(openerTab);
      if (!el) throw new Fail("no tab element for the opener");
      el.click();
      await sleep(1200);
      const bad: string[] = [];
      if (tabs()?.active !== openerTab) bad.push("the click did not switch");
      const t = await tracks(openerId());
      if (t) bad.push(`opener: ${t}`);
      if ((await webview(blankId)).hidden !== true) bad.push("the other tab's webview is still shown");
      await shot("browser-tab-switched");
      tabEl(blankTab)?.click();
      await sleep(1200);
      const back = await tracks(blankId);
      if (back) bad.push(`back: ${back}`);
      if ((await webview(openerId())).hidden !== true) bad.push("the opener's webview shows over the other tab");
      tabEl(openerTab)?.click();
      await sleep(900);
      if (bad.length) throw new Fail(bad.join("; "));
    });
    let plainTab = 0;
    await step("window.open without features opens a tab too; closing that tab closes its webview", async () => {
      st().navigateBrowserTab(key, openerTab, `${base}/opener`);
      await waitFor("the opener page", () => state()?.title === "Opener ready", 20_000);
      const before = tabs()!.tabs.length;
      const pops = (await popups()).length;
      await invoke("selftest_browser_eval", { id: openerId(), js: `document.getElementById("plain").click()` });
      await waitFor("a new tab", () => tabs()!.tabs.length === before + 1, 10_000);
      plainTab = tabs()!.active;
      const plainId = await current("the new tab's webview");
      await waitFor("the new tab's page", () => state()?.title === "Tab via=open", 20_000);
      if ((await popups()).length !== pops) throw new Fail("a pop-up window opened");
      await sleep(400);
      const x = document.querySelector<HTMLElement>(`[data-browser-tab-close="${plainTab}"]`);
      if (!x) throw new Fail("no close button on the tab");
      x.click();
      await sleep(900);
      const w = await webview(plainId);
      const bad: string[] = [];
      if (w.frame || w.hidden !== null) bad.push(`its webview is still there: ${JSON.stringify(w)}`);
      if (tabs()!.tabs.some((t) => t.id === plainTab)) bad.push("the tab is still listed");
      if (tabs()!.tabs.length !== before) bad.push(`${tabs()!.tabs.length} tabs`);
      // The neighbour shows (the tab to its right, else its left).
      const now = await current();
      const t = await tracks(now);
      if (t) bad.push(`after closing: ${t}`);
      if (bad.length) throw new Fail(bad.join("; "));
      return `closed ${plainId}; showing ${activeTab()?.title}`;
    });
    await step("Open (an artifact card's) opens a tab, or focuses the tab already on that URL", async () => {
      const u = `${base}/tabpage?via=card`;
      const before = tabs()!.tabs.length;
      st().openBrowser(key, { kind: "web", url: u });
      const cardTab = tabs()!.active;
      await waitFor("its page", () => state()?.title === "Tab via=card", 20_000);
      if (tabs()!.tabs.length !== before + 1) throw new Fail(`${tabs()!.tabs.length} tabs after the first Open`);
      tabEl(openerTab)?.click();
      await sleep(600);
      st().openBrowser(key, { kind: "web", url: u });
      await sleep(600);
      if (tabs()!.tabs.length !== before + 1) throw new Fail(`a second tab for the same URL (${tabs()!.tabs.length})`);
      if (tabs()!.active !== cardTab) throw new Fail("the tab on that URL was not focused");
      return `${tabs()!.tabs.length} tabs`;
    });
    await step("at most 4 webviews stay alive; an evicted tab reloads where it was when shown again", async () => {
      // Show every tab once (most recently shown last), then the first is the least recently shown.
      for (const t of tabs()!.tabs) {
        tabEl(t.id)?.click();
        await waitFor(`tab ${t.id}'s webview`, () => nativeId(tabKey(key, t.id)), 10_000);
        await sleep(500);
      }
      const all = tabs()!.tabs;
      const alive = all.filter((t) => nativeId(tabKey(key, t.id)));
      if (all.length <= 4) throw new Fail(`only ${all.length} tabs`);
      if (alive.length > 4) throw new Fail(`${alive.length} webviews alive`);
      const gone = all.find((t) => !nativeId(tabKey(key, t.id)));
      if (!gone) throw new Fail("no tab was evicted");
      const was = gone.url;
      tabEl(gone.id)?.click();
      const again = await current("a new webview for the evicted tab");
      await waitFor("its page again", () => !!state()?.url && !state()!.loading, 30_000);
      await sleep(800);
      await shot("browser-tab-evicted-back");
      if (state()?.url !== was) throw new Fail(`reloaded at ${state()?.url}, was ${was}`);
      const t = await tracks(again);
      if (t) throw new Fail(t);
      return `${all.length} tabs, ${alive.length} alive; tab ${gone.id} back at ${was} in ${again}`;
    });
    let stay = "";
    await step("a pop-up left open closes with the panel's webview", async () => {
      st().openBrowser(key, { kind: "web", url: `${base}/opener?stay=1` });
      id = await current();
      await waitFor("the opener page", () => state()?.title === "Opener ready", 20_000);
      await invoke("selftest_browser_eval", { id, js: `document.getElementById("open").click()` });
      for (const end = Date.now() + 10_000; !stay && Date.now() < end; await sleep(200)) stay = (await popups()).find((p) => !seen.has(p.label))?.label ?? "";
      if (!stay) throw new Fail("no pop-up window");
      await waitFor("the opener to get the pop-up's message", () => /^Opener got: hi/.test(state()?.title ?? ""), 20_000);
      await sleep(800);
      if (!(await popups()).some((p) => p.label === stay)) throw new Fail("the ?stay pop-up closed by itself");
      return stay;
    });
    let closed: { n: number; active: number; url: string; titles: string[] } = { n: 0, active: 0, url: "", titles: [] };
    await step("the panel's close button closes every tab's webview (and their pop-ups), remembering the tabs", async () => {
      const ids = tabs()!.tabs.map((t) => nativeId(tabKey(key, t.id))).filter(Boolean) as string[];
      closed = { n: tabs()!.tabs.length, active: tabs()!.active, url: activeTab()?.url ?? "", titles: tabs()!.tabs.map((t) => t.title ?? "") };
      const close = ([...document.querySelectorAll("[data-browser-panel] button")] as HTMLElement[]).find((b) => b.title === "Close");
      if (!close) throw new Fail("no close button");
      close.click();
      await sleep(900);
      await shot("browser-closed");
      for (const i of ids) {
        const w = await webview(i);
        if (w.frame || w.hidden !== null) throw new Fail(`${i} still there: ${JSON.stringify(w)}`);
      }
      const left = await popups();
      if (left.length) throw new Fail(`its pop-ups are still open: ${JSON.stringify(left)}`);
      if (st().browser[key]) throw new Fail("the panel still has tabs");
      if ($("[data-right-panel]")?.dataset.rightPanel !== "closed") throw new Fail(`panel ${$("[data-right-panel]")?.dataset.rightPanel}`);
      if (st().lastBrowser[key]?.tabs.length !== closed.n) throw new Fail(`remembered ${st().lastBrowser[key]?.tabs.length} tabs of ${closed.n}`);
      return `${ids.length} webviews closed; ${closed.n} tabs remembered`;
    });
    const globe = () => ([...document.querySelectorAll("button")] as HTMLElement[]).find((b) => /^(Show|Hide) the browser/.test(b.title));
    await step("after closing, the header's globe restores the tabs (URLs, titles, the active one)", async () => {
      const g = globe();
      if (!g) throw new Fail("no globe button in the header");
      if (!/opener\?stay=1|Opener/.test(g.title) || !/more tabs/.test(g.title)) throw new Fail(`globe title "${g.title}"`);
      g.click();
      const again = await current("a new webview");
      await waitFor("the last page", () => state()?.title === "Opener ready", 20_000);
      await sleep(600);
      await shot("browser-reopened");
      const bad: string[] = [];
      if (again === id) bad.push("the old webview came back (it should have been destroyed)");
      if (tabs()?.tabs.length !== closed.n) bad.push(`${tabs()?.tabs.length} tabs, not ${closed.n}`);
      if (tabs()?.active !== closed.active) bad.push("another tab is active");
      if (!/\/opener\?stay=1$/.test(state()?.url ?? "")) bad.push(`reopened at ${state()?.url}`);
      const titles = [...document.querySelectorAll<HTMLElement>("[data-browser-tab]")].map((e) => e.textContent ?? "");
      if (titles.length !== closed.n) bad.push(`${titles.length} tabs in the strip`);
      // Only the showing tab has a webview; the others load when shown.
      const live = tabs()!.tabs.filter((t) => nativeId(tabKey(key, t.id))).length;
      if (live !== 1) bad.push(`${live} webviews alive right after restoring`);
      const t = await tracks(again);
      if (t) bad.push(t);
      if (bad.length) throw new Fail(bad.join("; "));
      id = again;
      return `${again}: ${state()?.url}; tabs ${titles.join(" | ")}`;
    });
    /** Types into a React-controlled input and presses a key, as the person would. */
    const type = (el: HTMLInputElement, text: string, key: string) => {
      el.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    };
    await step("the address bar: Escape restores it, a non-http address is refused, Enter goes (in this tab)", async () => {
      const addr = () => $("[data-browser-panel] input[aria-label=Address]") as HTMLInputElement | null;
      const a = addr();
      if (!a) throw new Fail("no address field");
      const before = state()?.url;
      const n = tabs()!.tabs.length;
      type(a, "somewhere-else.example", "Escape");
      await sleep(300);
      if (addr()?.value.includes("somewhere-else")) throw new Fail(`Escape kept "${addr()?.value}"`);
      type(addr()!, "file:///etc/hosts", "Enter");
      await sleep(800);
      if (state()?.url !== before) throw new Fail(`file: navigated to ${state()?.url}`);
      addr()!.blur();
      type(addr()!, `${base}/opener`, "Enter");
      await waitFor("the typed page", () => /\/opener$/.test(state()?.url ?? ""), 20_000);
      if (tabs()!.tabs.length !== n) throw new Fail("typing an address opened a tab");
      return state()?.url;
    });
    await step("no tabs yet: the globe opens a start view; its address field loads in that tab; + adds a start tab", async () => {
      const close = ([...document.querySelectorAll("[data-browser-panel] button")] as HTMLElement[]).find((b) => b.title === "Close");
      close?.click();
      await sleep(900);
      useStore.setState((s) => {
        const lastBrowser = { ...s.lastBrowser };
        delete lastBrowser[key];
        return { lastBrowser };
      });
      await sleep(200);
      const g = globe();
      if (!g) throw new Fail("no globe button");
      g.click();
      const startView = await waitFor("the start view", () => $("[data-browser-start]"), 5000);
      await shot("browser-start");
      const field = startView.querySelector("input") as HTMLInputElement | null;
      if (!field) throw new Fail("no address field in the start view");
      type(field, "example.com", "Enter");
      await waitFor("example.com", () => /Example Domain/.test(state()?.title ?? ""), 30_000);
      const u = state()?.url ?? "";
      if (!u.startsWith("https://example.com")) throw new Fail(`opened ${u}`);
      if (tabs()?.tabs.length !== 1) throw new Fail(`${tabs()?.tabs.length} tabs`);
      const plus = ([...document.querySelectorAll("[data-browser-panel] button")] as HTMLElement[]).find((b) => b.title === "New tab");
      if (!plus) throw new Fail("no + button");
      plus.click();
      await waitFor("a start view in a new tab", () => $("[data-browser-start]"), 5000);
      await sleep(500);
      await shot("browser-new-tab");
      if (tabs()?.tabs.length !== 2) throw new Fail(`${tabs()?.tabs.length} tabs after +`);
      return u;
    });
    await step("closing the last tab closes the panel; the globe brings that tab back", async () => {
      // The new tab first, so the one left (example.com) is the last closed and the one remembered.
      for (const t of [...tabs()!.tabs].reverse()) {
        document.querySelector<HTMLElement>(`[data-browser-tab-close="${t.id}"]`)?.click();
        await sleep(600);
      }
      if (st().browser[key]) throw new Fail(`still ${st().browser[key]?.tabs.length} tabs`);
      if ($("[data-right-panel]")?.dataset.rightPanel !== "closed") throw new Fail(`panel ${$("[data-right-panel]")?.dataset.rightPanel}`);
      const g = globe();
      if (!g) throw new Fail("the globe went away");
      const last = st().lastBrowser[key];
      if (last?.tabs.length !== 1) throw new Fail(`remembered ${last?.tabs.length} tabs`);
      g.click();
      await waitFor("example.com again", () => /Example Domain/.test(state()?.title ?? ""), 30_000);
      const c = ([...document.querySelectorAll("[data-browser-panel] button")] as HTMLElement[]).find((b) => b.title === "Close");
      c?.click();
      await sleep(900);
      return state()?.url;
    });
  },
  /**
   * Artifact preview: the local copy opens in a preview window of its own (a child window of the main one, sized to
   * fit, centred, titled with the artifact and version), in a sandboxed frame with its supporting file, reaching
   * nothing of coool's; the window's own top frame gets nothing from the IPC either; opening it again reuses it.
   */
  async artifact(ctx) {
    await browserHost(ctx);
    const info = (await invoke("selftest_artifact")) as ArtifactInfo;
    let label = "";
    await step("an artifact's Preview opens a window of its own with the local copy, sandboxed, without coool's IPC", async () => {
      const ok = await api().artifactWindow(info.url);
      if (!ok) throw new Fail("artifact_window said the local copy is gone");
      let w: PreviewProbe | undefined;
      for (const end = Date.now() + 10_000; !w && Date.now() < end; await sleep(200)) w = (await previews()).find((p) => p.url === info.url);
      if (!w) throw new Fail("no preview window");
      label = w.label;
      // The host page hears the probe through postMessage and reports through its own title (no IPC).
      await invoke("selftest_preview_eval", {
        label,
        ipcProbe: false,
        js: `window.addEventListener("message", (e) => { const r = e.data && e.data.cooolArtifactProbe; if (r && !document.title.startsWith("probe:")) document.title = "probe:" + JSON.stringify(r); });`,
      });
      let p = w;
      for (const end = Date.now() + 15_000; Date.now() < end && !p.page_title.startsWith("probe:"); await sleep(250)) p = (await previews()).find((x) => x.label === label) ?? p;
      await shot("artifact-preview-window", label);
      await shot("artifact-preview-over-main");
      if (!p.page_title.startsWith("probe:")) throw new Fail(`the frame sent no probe result (${JSON.stringify(p)})`);
      const r = JSON.parse(p.page_title.slice(6)) as Record<string, unknown>;
      const bad: string[] = [];
      if (p.title !== `${info.title} · v${info.version}`) bad.push(`window title "${p.title}"`);
      if (!p.page_url.startsWith("data:text/html")) bad.push(`host page ${p.page_url}`);
      if (!p.visible) bad.push("not visible");
      if (p.child_of_main !== true) bad.push(`child of the main window: ${p.child_of_main}`);
      if (p.frame) {
        const [x, y, fw, fh] = p.frame;
        if (fw > 901 || fw < 320 || fh > 700 + 40 || fh < 240) bad.push(`size ${fw}x${fh}`);
        const m = p.main_frame ?? [0, 0, 0, 0];
        const mx = m[0] + m[2] / 2;
        const my = m[1] + m[3] / 2;
        // A test window kept off screen (COOOL_SELFTEST_BACKGROUND / WINDOW=back): macOS keeps the preview on a
        // display, so it can't be centred on the main window there.
        const mainOff = m[0] < 0 || m[1] < 0;
        if (!mainOff && Math.abs(x + fw / 2 - mx) > 4) bad.push(`not centred: x ${x + fw / 2} vs main ${mx}`);
        if (!mainOff && Math.abs(y + fh / 2 - my) > 24) bad.push(`not centred: y ${y + fh / 2} vs main ${my}`);
      } else bad.push("no frame");
      if (r.internals !== "undefined") bad.push(`__TAURI_INTERNALS__ ${r.internals}`);
      if (r.tauri !== "undefined") bad.push(`__TAURI__ ${r.tauri}`);
      if (r.parent !== "blocked") bad.push(`parent.document ${r.parent}`);
      if (r.origin !== "null") bad.push(`origin ${r.origin}`);
      if (r.img !== "loaded") bad.push(`supporting image ${r.img}`);
      if (r.secret === 200) bad.push("served a file outside the artifact's map");
      if (r.escape === 200) bad.push("served a path outside the folder");
      if (r.ipcFetch === 200) bad.push("raw ipc:// fetch answered 200");
      if (bad.length) throw new Fail(`${bad.join("; ")} (${JSON.stringify({ p, r })})`);
      return `${label} "${p.title}" ${p.frame?.map(Math.round).join(",")}; frame: ${JSON.stringify(r)}`;
    });
    await step("the preview window's own page (where Tauri's script runs) is refused every command", async () => {
      if (!label) throw new Fail("no preview window");
      await invoke("selftest_preview_eval", { label, ipcProbe: true, js: `ipcProbe("preview-ipc").then((r) => { document.title = "ipc:" + JSON.stringify(r); });` });
      let p: PreviewProbe | undefined;
      for (const end = Date.now() + 20_000; Date.now() < end && !p?.page_title.startsWith("ipc:"); await sleep(250)) p = (await previews()).find((x) => x.label === label);
      if (!p?.page_title.startsWith("ipc:")) throw new Fail(`no IPC probe result (${JSON.stringify(p)})`);
      const r = JSON.parse(p.page_title.slice(4)) as Record<string, unknown>;
      const bad = ipcLeaks(r);
      if (bad.length) throw new Fail(`${bad.join("; ")} (${JSON.stringify(r)})`);
      return JSON.stringify(r);
    });
    await step("Preview again focuses the same window; closing it forgets it", async () => {
      if (!label) throw new Fail("no preview window");
      await api().artifactWindow(info.url);
      await sleep(500);
      const open = await previews();
      if (open.length !== 1 || open[0].label !== label) throw new Fail(`windows ${JSON.stringify(open.map((p) => p.label))}`);
      await invoke("selftest_close_preview", { label });
      await sleep(800);
      const left = await previews();
      if (left.length) throw new Fail(`still open: ${JSON.stringify(left.map((p) => p.label))}`);
    });
  },
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
      if (!chip || chip.getBoundingClientRect().height > 28) throw new Fail(`models chip is ${chip?.getBoundingClientRect().height}px tall`);
      const row = $all("[data-session-row]").find((r) => r.textContent?.includes(title.replace(/…$/, "")));
      return `title "${title}"; path ends "${tail.textContent}"${clipped ? " (parent part middle-truncated)" : ""}; sidebar row ${row ? "matches" : "differs"}`;
    });
    await step("the chat is linked to its discovered session (one sidebar row)", async () => {
      const sid = await waitFor("session id", () => chat(id)?.sessionId, 10_000);
      const s = await waitFor("the session linked to the chat", () => useStore.getState().sessions.find((x) => x.chat === id), 20_000);
      const rows = useStore.getState().sessions.filter((x) => x.id === sid).length;
      if (rows !== 1) throw new Fail(`${rows} sessions with id ${sid}`);
      if (useStore.getState().pendingChats.includes(id)) throw new Fail("still listed as pending");
      const sidebarRows = $all(`[data-session-row="${sessionKey(s)}"]`).filter((r) => !r.closest("[data-ghost]")).length;
      if (sidebarRows !== 1) throw new Fail(`${sidebarRows} sidebar rows for the session`);
      // coool's own chat, even though the CLI records it as programmatic (sdk-cli).
      if (s.origin !== "coool") throw new Fail(`origin ${s.origin}, not coool`);
      return `session ${sid.slice(0, 8)}… linked, 1 sidebar row, origin coool`;
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
      // The Needs you page and the other theme, while the request is pending.
      const bell = ([...document.querySelectorAll("button[aria-label]")] as HTMLElement[]).find((x) => x.getAttribute("aria-label")!.startsWith("Needs you"));
      if (bell) {
        bell.click();
        await sleep(500);
        await shot("needs-page");
        bell.click();
        await sleep(200);
      }
      const themeBtn = ([...document.querySelectorAll("button[aria-label]")] as HTMLElement[]).find((x) => / theme$/.test(x.getAttribute("aria-label") ?? ""));
      if (themeBtn) {
        themeBtn.click();
        await sleep(600);
        await shot("approval-other-theme");
        themeBtn.click();
        await sleep(300);
      }
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

  /** Steering notes against the real Claude CLI: queued -> picked up under a step, "now" -> interrupted, unused after Stop. */
  async steer(ctx) {
    const note = (s: string) => $all("[data-chat-timeline]").map((t) => t.textContent ?? "").join(" ").split(s).length - 1;
    const running = (id: number) => items(id).find((i) => i.kind === "tool" && !i.parent && i.endTs === null) as Extract<ChatItem, { kind: "tool" }> | undefined;
    const prompts = (id: number) => items(id).filter((i) => i.kind === "prompt").length;
    const notes = (id: number) => chat(id)?.notes ?? [];
    // Bash asks; answer every approval with Allow once so the steps are not blocked.
    const allow = setInterval(() => {
      const c = $("[data-approval]");
      if (c) button("Allow once", c)?.click();
    }, 300);
    try {
      let id = 0;
      const N1 = "Keep the final reply to one word.";
      await step("a note sent during a step is queued under 'Queued · goes in at the next step'", async () => {
        id = await startClaude(ctx, "Run these three shell commands one at a time, each as its own tool call, never in parallel: sleep 3; sleep 3; sleep 3. Then reply done.");
        await waitFor("the first step to run", () => running(id), 90_000);
        await say(N1);
        const strip = await waitFor("the queued strip", () => $("[data-steer-queued]"), 5_000);
        // The strip's wording since the queued-notes restyle: "Queued · goes in at the next step".
        if (!/Queued\W*goes in at the next step/.test(strip.textContent ?? "")) throw new Fail(`strip reads "${strip.textContent?.trim()}"`);
        if (!strip.textContent?.includes(N1)) throw new Fail("the strip does not show the note");
        await shot("steer-queued");
        return `strip: "${strip.textContent?.trim().slice(0, 60)}"`;
      });
      await step("it leaves the strip and appears under a step as Picked up, with no prompt bubble of its own", async () => {
        const n = await waitFor("the note to be picked up", () => notes(id).find((x) => x.state === "picked_up"), 30_000);
        await waitFor("the strip to empty", () => !$("[data-steer-queued]"), 5_000);
        const row = await waitFor("the Picked up row", () => $all('[data-note="picked_up"]').find((r) => r.textContent?.includes(N1)), 8_000);
        if (!/Picked up/.test(row.textContent ?? "")) throw new Fail(`row reads "${row.textContent}"`);
        if (!n.toolId) throw new Fail("the note is not attached to a step");
        await shot("steer-picked-up");
        await sleep(1500); // the echo has arrived by now
        if (prompts(id) !== 1) throw new Fail(`${prompts(id)} prompt bubbles in the store`);
        if (note(N1) !== 1) throw new Fail(`the note text appears ${note(N1)}x in the timeline`);
        return `attached to step ${n.toolId.slice(0, 10)}…, ${prompts(id)} prompt bubble`;
      });
      await step("a note sent with Cmd+Enter during a step interrupts it ('Interrupted')", async () => {
        // A later step must be running (the chat may already be past the three commands).
        if (!(await waitFor("a step to run", () => running(id) ?? (chat(id)?.state === "idle" ? true : null), 45_000).then((v) => v !== true)))
          await say("Run the shell command sleep 8, then reply done.");
        await waitFor("a step to run", () => running(id), 60_000);
        const N2 = "Stop that and reply with only the word halted.";
        type(N2);
        await sleep(60);
        key("Enter", composer(), { metaKey: true });
        const row = await waitFor("the Interrupted row", () => $all('[data-note="interrupted"]').find((r) => r.textContent?.includes(N2)), 20_000);
        if (!/Interrupted/.test(row.textContent ?? "")) throw new Fail(`row reads "${row.textContent}"`);
        await shot("steer-interrupted");
        await waitFor("the note's own turn to answer", () => chat(id)?.state === "idle" && /halted/i.test(lastText(id)?.text ?? ""), 120_000);
        return `row: "${row.textContent?.trim().slice(0, 60)}"`;
      });
      await step("a withdrawn note leaves the strip for good; a note still queued at Stop is not sent ('weren't used': Send now / Discard)", async () => {
        const n = turnEnds(id).length;
        await say("Run the shell command sleep 12, then reply done.");
        await waitFor("the step to run", () => running(id), 90_000);
        const A = "First note, to be withdrawn.";
        await say(A);
        await waitFor("the first note queued", () => $("[data-steer-queued]")?.textContent?.includes(A), 5_000);
        $("[data-note-remove]")!.click();
        await waitFor("the strip to empty", () => !$("[data-steer-queued]"), 5_000);
        if (note(A)) throw new Fail("a withdrawn note is in the timeline");
        const B = "Second note, never reached.";
        await say(B);
        await waitFor("the second note queued", () => $("[data-steer-queued]")?.textContent?.includes(B), 5_000);
        $('button[title="Stop this turn (Esc)"]')!.click();
        const strip = await waitFor("the unused strip", () => $("[data-steer-unused]"), 30_000);
        if (!/n't used/.test(strip.textContent ?? "") || !button("Send now", strip) || !button("Discard", strip)) throw new Fail(`strip reads "${strip.textContent}"`);
        await waitFor("the chat to be idle", () => chat(id)?.state === "idle", 30_000);
        await shot("steer-unused");
        if (notes(id).some((x) => x.text === A)) throw new Fail("the withdrawn note came back");
        button("Discard", strip)!.click();
        await waitFor("the strip to go", () => !$("[data-steer-unused]"), 5_000);
        if (turnEnds(id).length !== n + 1) throw new Fail(`${turnEnds(id).length - n} turns ended, expected 1`);
        return `"${strip.textContent?.trim().slice(0, 50)}"; discarded; nothing sent`;
      });
    } finally {
      clearInterval(allow);
    }
  },

  /** Markdown in a real reply: bold with numbers, a table, a code block. */
  async markdown(ctx) {
    await step("a reply is rendered as Markdown: strong, table, code block, no literal syntax", async () => {
      const doc = "Only **2.5 GB free of 460 GB**.\n\n| Item | Size |\n|---|---|\n| Cache | 10 GB |\n| Logs | 2 GB |\n\n```sh\ndu -sh .\n```";
      const id = await startClaude(ctx, `Reply with exactly this markdown and nothing else:\n\n${doc}`);
      await nextTurn(id, 0);
      const find = () => {
        const strong = $all("[data-chat-timeline] strong").find((e) => e.textContent?.includes("2.5 GB free of 460 GB"));
        const block = strong?.closest("[data-block]") as HTMLElement | null;
        const table = block?.querySelector("table");
        return strong && block && table && table.querySelectorAll("th, td").length === 6 && block.querySelector("pre") ? { strong, block, cells: 6 } : null;
      };
      const got = await waitFor("a rendered reply (strong, 6-cell table, pre)", find, 10_000).catch(async (e) => {
        const strong = $all("[data-chat-timeline] strong").find((x) => x.textContent?.includes("2.5 GB free of 460 GB"));
        const html = ((strong?.closest("[data-block]") as HTMLElement | null)?.innerHTML ?? "").slice(-500);
        throw new Fail(`${e.message}; strong ${strong ? "present" : "missing"}; html tail ${JSON.stringify(html)}; reply ${JSON.stringify(lastText(id)?.text)}; timeline ${JSON.stringify(($("[data-chat-timeline]")?.textContent ?? "").slice(-300))}`);
      });
      const { strong, block, cells } = got;
      const txt = block.textContent ?? "";
      if (txt.includes("**") || txt.includes("|---|")) throw new Fail(`literal markdown left: "${txt.slice(0, 80)}"`);
      await shot("markdown");
      return `strong "${strong.textContent}", table ${cells} cells, pre present, no ** or |---|`;
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

  // Free: starts the CLI's own terminal UI in the throwaway folder (no prompt is sent), then stops it.
  /** Free: what every listed session's origin is (run after a restart to see coool's chats are still known). */
  async origins() {
    await step("sessions in the folder carry an origin; automation is hidden unless the setting is on", async () => {
      const st = useStore.getState();
      await waitFor("loading to finish", () => !useStore.getState().loading, 30_000).catch(() => {});
      const all = useStore.getState().allSessions;
      const counts: Record<string, number> = {};
      for (const s of all) counts[s.origin ?? "missing"] = (counts[s.origin ?? "missing"] ?? 0) + 1;
      for (const s of all) await log(`INFO origin ${s.origin} ${s.provider} ${s.id.slice(0, 8)} ${s.status} chat=${s.chat ?? "-"}`);
      // Child runs of a listed session are shown nested under it; only parent-less ones must be hidden.
      const listedAuto = useStore.getState().sessions.filter((s) => s.origin === "automation" && !s.nested && s.status === "ended").length;
      if (!st.showAutomation && listedAuto) throw new Fail(`${listedAuto} ended automation sessions listed while the setting is off`);
      const rows = $all("[data-session-row]").filter((r) => r.getAttribute("data-origin") === "automation" && !r.hasAttribute("data-nested")).length;
      if (!st.showAutomation && rows) throw new Fail(`${rows} automation rows in the sidebar`);
      return Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ") || "no sessions";
    });
    await shot("origins");
  },

  async pty(ctx) {
    await step("a starting terminal session is grouped under its project", async () => {
      const id = (await invoke("spawn_session", { req: { provider: "claude", cwd: ctx.cfg.dir, rows: 30, cols: 100 } })) as number;
      try {
        const info = await waitFor("the terminal row", () => useStore.getState().ptys[id] ?? null, 10_000);
        await sleep(900);
        await shot("pty-starting");
        const side = (document.querySelector("aside, [data-sidebar]") as HTMLElement | null)?.innerText ?? document.body.innerText;
        const want = (info.project || info.cwd).split("/").filter(Boolean).pop()!;
        const raw = info.cwd.split("/").filter(Boolean).pop()!;
        const lines = side.split("\n").map((l) => l.trim());
        if (!lines.includes(want)) throw new Fail(`sidebar has no project row "${want}"`);
        if (want !== raw && lines.includes(raw)) throw new Fail(`sidebar still shows the raw folder "${raw}" as a project`);
        return `cwd …/${raw}; project ${info.project ?? "(none)"}; sidebar shows "${want}"${want !== raw ? `, not "${raw}"` : ""}`;
      } finally {
        await invoke("stop_session", { managed: id, pid: null }).catch(() => {});
        await sleep(1500);
      }
    });
  },

  // Free: reads what the backend already gathered; no model turn.
  async usage() {
    await step("plan usage reaches the UI and the Usage page shows it", async () => {
      const u = await waitFor("a usage payload", () => {
        const x = (useStore.getState() as { usage?: { claude: unknown; codex: unknown } }).usage;
        return x && (x.claude || x.codex) ? x : null;
      }, 30_000);
      const btn = ([...document.querySelectorAll("button[aria-label]")] as HTMLElement[]).find((b) => b.getAttribute("aria-label")!.startsWith("Usage"));
      if (!btn) throw new Fail("no Usage button in the rail");
      btn.click();
      const pop = await waitFor("the Usage page", () => document.querySelector('[aria-label="Plan usage"]') as HTMLElement | null, 5_000);
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
        // Intentional: a failed clean-up must fail the check even when the body passed.
        // oxlint-disable-next-line no-unsafe-finally
        if (after.enabled) throw new Fail("still enabled");
      }
    });
  },

  /**
   * CPU measurement: a chat running a long, quiet tool stays open and focused. Phases are logged with timestamps
   * (A: Reduce motion as the person has it, normally Auto; B: On; C: On, no chat on screen = Home) so a sampler
   * (`ps` once a second) can average each measure window. Each phase: 30 s settle, 40 s measure. Restores the setting.
   */
  async perf(ctx) {
    const original = ((): MotionPref => {
      try {
        const v = localStorage.getItem("coool.motion");
        return v === "on" || v === "off" ? v : "auto";
      } catch {
        return "auto";
      }
    })();
    ctx.model = PERF_MODEL;
    const allow = setInterval(() => {
      const c = $("[data-approval]");
      if (c) button("Allow once", c)?.click();
    }, 300);
    const hintsSeen: MotionHints[] = [];
    api().onMotionHints((h) => hintsSeen.push(h));
    const report = async (tag: string) => {
      const h = (await invoke("motion_hints").catch(() => null)) as MotionHints | null;
      const m = decideMotion("auto", matchMedia("(prefers-reduced-motion: reduce)").matches, h);
      await log(`HINTS ${tag} ${JSON.stringify(h)} os_reduce=${matchMedia("(prefers-reduced-motion: reduce)").matches} auto_decision=${JSON.stringify(m)} pref=${original} html.reduce-motion=${document.documentElement.classList.contains("reduce-motion")} pushed=${hintsSeen.length}`);
    };
    const phase = async (name: string) => {
      await log(`PERF ${name} settle-start`);
      await sleep(30_000);
      await log(`PERF ${name} measure-start`);
      await sleep(40_000);
      await log(`PERF ${name} measure-end`);
    };
    try {
      const id = await startClaude(ctx, "Run this exact shell command in the foreground, one call at a time, never in parallel, five times in a row: python3 -c \"import time; time.sleep(60)\". Then reply done.");
      ctx.main = id;
      await waitFor("the chat timeline", () => $("[data-chat-timeline]"), 10_000);
      await waitFor("a running step", () => items(id).find((i) => i.kind === "tool" && !i.parent && i.endTs === null), 90_000);
      await log(`PERF chat ${id} model ${PERF_MODEL} requested; running=${chat(id)?.running}`);
      await report("start");
      await phase("A pref=" + original);
      await log(`PERF A running=${chat(id)?.running}`);
      setMotionPref("on");
      await report("after-on");
      await phase("B pref=on");
      await log(`PERF B running=${chat(id)?.running}`);
      useStore.setState({ activeTab: null });
      await sleep(500);
      await log(`PERF C home: main shows ${$("[data-chat-timeline]") ? "a chat (!)" : "no chat"}`);
      await phase("C pref=on home");
      await log(`PERF C running=${chat(id)?.running}`);
    } finally {
      ctx.model = undefined;
      clearInterval(allow);
      setMotionPref(original);
      await log(`PERF restored pref=${original}`);
    }
  },

  /**
   * The browser tools' settle rules against a local test site (no model): navigate to a client-rendered page that draws
   * 300–800 ms after load (is the content in the result?), act on a page that never stops changing (a 100 ms timer, an
   * animation, a carousel: how long does a click wait?), read a long `content-visibility: auto` page whole, and click
   * an element that removes itself (does its outline stay?). Logs `TIMING` lines; a plain static page is the baseline.
   */
  async "browser-settle"(ctx) {
    const site = (ctx.cfg.site ?? "").replace(/\/?$/, "/");
    let id = -1;
    await step("browser-settle: a chat (bypass mode, no prompt) for the panel", async () => {
      if (site === "/") throw new Fail("COOOL_SELFTEST_SITE is not set");
      ({ id } = await gateChat(ctx, "claude", PERF_MODEL, "bypassPermissions"));
      return `chat ${id}, site ${site}`;
    });
    if (id < 0) return;
    const T = (line: string) => log(`TIMING ${line}`);
    const head = (t: string, from = 0, to = 3) => JSON.stringify(t.split("\n").slice(from, to).join(" / "));
    await step("browser-settle: a static page", async () => {
      const loads: number[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await browserTool(id, "browser_navigate", { url: `${site}static.html?n=${i}` });
        if (!r.text.includes("Static content ready")) throw new Fail(`no content: ${r.text.slice(0, 300)}`);
        loads.push(msOf(r.text, "load"));
        await T(`static navigate load=${msOf(r.text, "load")} wall=${r.ms}`);
      }
      const b = await browserTool(id, "browser_click", { id: idOf((await browserTool(id, "browser_observe")).text, "button", "A button") });
      await T(`static click settle=${msOf(b.text, "settle")} wall=${b.ms}`);
      return `navigate load median ${median(loads)} ms; click settle ${msOf(b.text, "settle")} ms`;
    });
    await step("browser-settle: a client-rendered page shows its content in the navigate result and the first screenshot", async () => {
      const out: string[] = [];
      const missing: number[] = [];
      for (const d of [300, 550, 800, 300, 550, 800]) {
        const r = await browserTool(id, "browser_navigate", { url: `${site}spa.html?d=${d}&t=${Date.now()}` });
        const s = await browserTool(id, "browser_screenshot", {}, `settle-spa-${d}-${out.length}`);
        const has = r.text.includes("Route content ready");
        if (!has) missing.push(d);
        out.push(`d=${d}: load ${msOf(r.text, "load")} ms ${has ? "content" : "EMPTY"}`);
        await T(`spa d=${d} navigate load=${msOf(r.text, "load")} wall=${r.ms} content=${has} shot=${s.images[0] ?? ""} head=${head(r.text)}`);
      }
      if (missing.length) throw new Fail(`content missing after navigate for d=${missing.join(",")}: ${out.join("; ")}`);
      return out.join("; ");
    });
    await step("browser-settle: a page that never stops changing: navigate, click, observe", async () => {
      const r = await browserTool(id, "browser_navigate", { url: `${site}live.html` });
      await T(`live navigate load=${msOf(r.text, "load")} wall=${r.ms} head=${head(r.text, 1)}`);
      const add = idOf(r.text, "button", "Add item");
      const settles: number[] = [];
      let last = "";
      for (let i = 1; i <= 4; i++) {
        const c = await browserTool(id, "browser_click", { id: add });
        settles.push(msOf(c.text, "settle"));
        last = c.text;
        const seen = c.text.includes(`Item ${i} added`);
        await T(`live click#${i} settle=${msOf(c.text, "settle")} wall=${c.ms} item_seen=${seen} note=${head(c.text, 0, 2)}`);
        if (!seen) throw new Fail(`click ${i}: the item it adds isn't in the result: ${c.text.slice(0, 500)}`);
      }
      const o = await browserTool(id, "browser_observe");
      await T(`live observe wall=${o.ms}`);
      const w = await browserTool(id, "browser_wait_for", { idle: true, timeout_ms: 3000 }).catch((e) => ({ ms: -1, text: String(e), images: [] }));
      await T(`live wait_for-idle wall=${w.ms} head=${head(w.text, 0, 1)}`);
      return `click settle ${settles.join(", ")} ms (median ${median(settles)}); observe ${o.ms} ms; says it keeps changing: ${/changing on its own/.test(last)}`;
    });
    await step("browser-settle: a long content-visibility page, read whole", async () => {
      const n = await browserTool(id, "browser_navigate", { url: `${site}long.html` });
      await T(`long navigate load=${msOf(n.text, "load")} wall=${n.ms}`);
      const v = await browserTool(id, "browser_observe");
      const a = await browserTool(id, "browser_observe", { all: true });
      const words = (t: string) => new Set(t.match(/word-\d+-marker/g) ?? []).size;
      const end = a.text.includes("END-OF-PAGE-MARKER");
      await T(`long observe-view wall=${v.ms} chars=${v.text.length} sections=${words(v.text)}; observe-all wall=${a.ms} chars=${a.text.length} sections=${words(a.text)} end=${end} tail=${JSON.stringify(a.text.slice(-240))}`);
      if (words(a.text) < 20) throw new Fail(`observe all=true read ${words(a.text)} of 150 sections`);
      return `in view ${words(v.text)} sections (${v.ms} ms); all ${words(a.text)} sections, end marker ${end}, ${a.text.length} chars (${a.ms} ms)`;
    });
    await step("browser-settle: the click outline goes with an element that removes itself", async () => {
      const n = await browserTool(id, "browser_navigate", { url: `${site}gone.html` });
      const c = await browserTool(id, "browser_click", { id: idOf(n.text, "button", "Remove me") });
      const m0 = await pageMarks(id);
      await sleep(250);
      const m1 = await pageMarks(id);
      await T(`gone click settle=${msOf(c.text, "settle")} wall=${c.ms} marks_after=${m0} marks_250ms=${m1}`);
      const d = await browserTool(id, "browser_click", { id: idOf(c.text, "button", "Decline") });
      const m2 = await pageMarks(id);
      await sleep(250);
      const m3 = await pageMarks(id);
      await T(`gone decline settle=${msOf(d.text, "settle")} wall=${d.ms} marks_after=${m2} marks_250ms=${m3}`);
      if (m0 > 0 || m1 > 0 || m3 > 0) throw new Fail(`outlines left on the page: ${m0}, ${m1} (Remove me); ${m2}, ${m3} (Decline)`);
      return `marks after the click ${m0} / ${m1}; after Decline ${m2} / ${m3}`;
    });
    useStore.getState().closeBrowser(chatPanelKey(id));
  },

  /**
   * Four public affectui.com component pages, at a browsing pace (no sign-in, no model): the first screenshot after
   * each navigation is saved (`real-site-<n>.jpg`), with the navigate timing and whether its listing had the page's
   * title. Also logs Reduce motion and what the beam drew (as the person has it, then Off).
   */
  async "browser-real"(ctx) {
    let id = -1;
    await step("browser-real: a chat (bypass mode, no prompt) for the panel", async () => {
      ({ id } = await gateChat(ctx, "claude", PERF_MODEL, "bypassPermissions"));
      const h = (await invoke("motion_hints").catch(() => null)) as MotionHints | null;
      const os = matchMedia("(prefers-reduced-motion: reduce)").matches;
      await log(`MOTION pref=${localStorage.getItem("coool.motion") ?? "auto"} os_reduce=${os} hints=${JSON.stringify(h)} decision=${JSON.stringify(decideMotion("auto", os, h))} html.reduce-motion=${document.documentElement.classList.contains("reduce-motion")}`);
      return `chat ${id}`;
    });
    if (id < 0) return;
    const beam = () => `driving=${!!document.querySelector("[data-browser-driving]")} static-ring=${!!document.querySelector("[data-presence-static]")} reduce=${document.documentElement.classList.contains("reduce-motion")}`;
    const pages = [
      ["components", "Components"],
      ["components/agent-trail", "Agent Trail"],
      ["components/autonomy-dial", "Autonomy Dial"],
      ["components/agent-crew", "Agent Crew"],
    ];
    const keep = (localStorage.getItem("coool.motion") as MotionPref | null) ?? "auto";
    try {
      for (const [i, [path, title]] of pages.entries()) {
        if (i === 2) {
          setMotionPref("off");
          await sleep(300);
        }
        await step(`browser-real: ${path} (Reduce motion ${i >= 2 ? "off" : keep})`, async () => {
          const r = await browserTool(id, "browser_navigate", { url: `https://www.affectui.com/${path}` });
          const s = await browserTool(id, "browser_screenshot", {}, `real-site-${i}`);
          const b = beam();
          await shot(`real-site-${i}-window`, undefined, 150);
          const head = r.text.split("\n").slice(0, 3).join(" / ");
          await log(`REAL ${path} load=${msOf(r.text, "load")} wall=${r.ms} title_in_listing=${r.text.includes(title)} beam: ${b} shot=${s.images[0] ?? ""} head=${JSON.stringify(head)}`);
          const decline = /\[(\d+)\] button "Decline"/.exec(r.text);
          if (decline) await browserTool(id, "browser_click", { id: Number(decline[1]) });
          await sleep(4000);
          return `load ${msOf(r.text, "load")} ms; ${head}; ${b}`;
        });
      }
    } finally {
      setMotionPref(keep);
    }
    useStore.getState().closeBrowser(chatPanelKey(id));
  },

  /** A Claude Haiku chat opens a local form in its Browser panel, fills it, submits and quotes the confirmation. */
  async "agent-browser"(ctx) {
    await agentBrowser(ctx, "claude", PERF_MODEL);
  },

  /** The same on Codex's cheapest model. */
  async "agent-browser-codex"(ctx) {
    await agentBrowser(ctx, "codex", CODEX_MODEL);
  },

  /** The device gate in an asking mode (Claude "default"): a form submit stops and asks; Allow submits, Deny doesn't. */
  async "gate-browser"(ctx) {
    await gateBrowser(ctx, "claude", PERF_MODEL, "default");
  },
  async "gate-browser-codex"(ctx) {
    await gateBrowser(ctx, "codex", CODEX_MODEL, "on-request");
  },
  /** The device gate on the sandbox Mac: a `mac_shell` command stops and asks, showing the command; Allow runs it, Deny doesn't. */
  async "gate-mac"(ctx) {
    await gateMac(ctx, "claude", PERF_MODEL, "default");
  },
  async "gate-mac-codex"(ctx) {
    await gateMac(ctx, "codex", CODEX_MODEL, "on-request");
  },

  /**
   * The sandbox Mac's network switch (no model calls): booted Off it has no network interface and no route out while
   * coool's tools still work; booted Local it reaches this computer only; switched to On live it reaches the internet.
   * Ends shut down, with the setting back to On.
   */
  async "mac-network"() {
    const mac = (sh: string) => invoke("selftest_mac", { request: { cmd: "run", sh, timeout: 20 } }) as Promise<{ output?: string; status?: number }>;
    const NET = "ifconfig -l; echo; ifconfig en0 2>&1 | grep -E 'inet |status' ; echo ROUTE; route -n get default 2>&1 | grep -E 'gateway|interface|not in table'; echo DNS; scutil --dns | grep -m2 nameserver; echo CURL; curl -sS -m 6 -o /dev/null -w '%{http_code}' https://example.com 2>&1; echo; echo PING; ping -c1 -t3 1.1.1.1 2>&1 | tail -2";
    const bootWith = async (m: "on" | "local" | "off") => {
      await api().macShutdown().catch(() => {});
      await api().macNetwork(m);
      const t = Date.now();
      await api().macBoot();
      return Date.now() - t;
    };
    try {
      await step("mac-network: booted Off, the Mac has no network device, no route out, and coool's tools work", async () => {
        const st = await api().macStatus();
        if (!st.available || !st.installed) throw new Fail(`no sandbox Mac: ${st.reason ?? "not installed"}`);
        const ms = await bootWith("off");
        const s = await api().macStatus();
        if (s.network !== "off" || s.networkNow !== "off") throw new Fail(`status network ${s.network}/${s.networkNow}`);
        const out = String((await mac(NET)).output);
        await log(`INFO off: ${out.replace(/\n/g, " | ")}`);
        if (/\ben0\b/.test(out.split("\n")[0])) throw new Fail(`en0 exists: ${out}`);
        if (!/not in table/.test(out)) throw new Fail(`a default route exists: ${out}`);
        if (/\b200\b/.test(out.split("CURL")[1] ?? "")) throw new Fail(`reached example.com: ${out}`);
        const screen = (await invoke("selftest_mac_screen")) as string;
        if (!/elements/.test(screen)) throw new Fail(`no screen read: ${screen.slice(0, 200)}`);
        await shot("mac-network-off");
        return `boot ${ms} ms; ${out.replace(/\n/g, " | ").slice(0, 300)}; screen: ${screen.split("\n")[0]}`;
      });
      await step("mac-network: booted Local, the Mac reaches this computer only", async () => {
        const ms = await bootWith("local");
        // DHCP on the host-only network can take a moment after the agent answers.
        let addr = "";
        for (let i = 0; i < 20 && !/\d+\.\d+/.test(addr); i++) {
          addr = String((await mac("ipconfig getifaddr en0 2>&1")).output);
          if (!/\d+\.\d+/.test(addr)) await sleep(2000);
        }
        await log(`INFO local en0: ${addr.trim()} | ${String((await mac("ipconfig getpacket en0 2>&1 | head -30")).output).replace(/\n/g, " | ")}`);
        const out = String((await mac(NET + "; echo GW; G=$(ipconfig getoption en0 server_identifier 2>/dev/null); echo $G; ping -c1 -t3 $G 2>&1 | tail -2")).output);
        await log(`INFO local: ${out.replace(/\n/g, " | ")}`);
        if (!/\d+\.\d+/.test(addr)) throw new Fail(`no address on en0: ${out}`);
        if (/\b200\b/.test((out.split("CURL")[1] ?? "").split("PING")[0])) throw new Fail(`reached example.com: ${out}`);
        if (!/1 packets received|1 received/.test(out.split("GW")[1] ?? "")) throw new Fail(`can't reach this computer: ${out}`);
        return `boot ${ms} ms; ${out.replace(/\n/g, " | ").slice(0, 400)}`;
      });
      await step("mac-network: switched to On while running, it reaches the internet at once", async () => {
        const r = await api().macNetwork("on");
        if (r.applies !== "now" || r.networkNow !== "on") throw new Fail(`applies ${r.applies}, now ${r.networkNow}`);
        let out = "";
        for (let i = 0; i < 10 && !/\b200\b/.test(out); i++) {
          await sleep(2000);
          out = String((await mac("curl -sS -m 6 -o /dev/null -w '%{http_code}' https://example.com 2>&1")).output);
        }
        if (!/\b200\b/.test(out)) throw new Fail(`no internet after switching on: ${out}`);
        return `example.com ${out}`;
      });
    } finally {
      await step("mac-network: the Mac is shut down and its setting is On again", async () => {
        await api().macShutdown().catch(() => {});
        const r = await api().macNetwork("on");
        if (r.network !== "on") throw new Fail(`setting ${r.network}`);
        return r.truth;
      });
    }
  },

  /**
   * A Claude Haiku chat opens Settings on the iPhone in its panel and reports the iOS version. The test makes a
   * simulator of its own (SIM_NAME in selftest.rs; the person's are never touched), boots it, and deletes it after.
   */
  async "agent-iphone"(ctx) {
    const SIM = "coool selftest iPhone";
    let id = -1;
    let key = "";
    let udid = "";
    let runtime = "";
    try {
      await step("the test's own simulator is created and booted, shown in the chat's iPhone panel", async () => {
        const list = await api().simDevices();
        if (!list.available) throw new Fail(`no simulators: ${list.reason}`);
        const others = list.devices.filter((d) => d.coool && d.name !== SIM);
        if (others.length) throw new Fail(`other devices count as coool's in a test run: ${others.map((d) => d.name).join(", ")}`);
        const t = Date.now();
        udid = await api().simEnsureDevice();
        const made = Date.now() - t;
        await api().simBoot(udid);
        const booted = Date.now() - t - made;
        const dev = (await api().simDevices()).devices.find((d) => d.udid === udid);
        if (dev?.name !== SIM) throw new Fail(`made ${dev?.name}`);
        runtime = dev.runtime;
        ctx.model = PERF_MODEL;
        id = await startClaude(ctx);
        ctx.model = undefined;
        await waitFor("ready", () => chat(id)?.ready, 60_000);
        await waitFor("the chat on screen", () => $("[data-chat-timeline]"), 20_000);
        await sleep(1500);
        key = await waitFor("the pane's panel key", activePanelKey, 10_000);
        useStore.getState().setRightPanel(key, "device");
        await waitFor("the panel showing the booted device", () => $(`[data-sim-screen="${udid}"]`) && $('[data-device-panel="Booted"]'), 30_000);
        await sleep(1500);
        await shot("agent-iphone-before");
        return `${dev.name} ${udid} (${dev.deviceType}, ${runtime}); create ${made} ms, boot ${booted} ms`;
      });
      if (id < 0) return;
      const r = await agentTurn(id, {
        prompt:
          "Use the coool-device tools (observe, tap, app, ...) on the iPhone simulator shown in this chat's panel. Open the Settings app, go to General, then About, and read the iOS version shown there. Don't use the shell. Then reply with one line: iOS version: <the version>.",
        marks: [["[data-sim-driving]", "agent-iphone-driving"]],
        probes: [{ name: "cursor", test: htmlCursor, shot: "agent-iphone-cursor" }],
        ms: 240_000,
      });
      await step("agent-iphone: the agent's cursor and label showed over the screen, the beam ran, and both clear after the turn", async () => {
        if (r.seen.cursor === undefined) throw new Fail("no agent cursor over the iPhone");
        if (r.seen["[data-sim-driving]"] === undefined) throw new Fail("no beam around the iPhone");
        return `cursor after ${r.seen.cursor} ms, beam after ${r.seen["[data-sim-driving]"]} ms; ${await presenceClears("[data-sim-driving]")}`;
      });
      await step("the agent drives the iPhone through coool-device tools that succeed", async () => {
        if (!r.tools.length) throw new Fail(`no coool-device tool calls; tools: ${r.all.join(", ") || "none"}`);
        const failed = r.tools.filter((t) => t.ok === false);
        if (failed.length === r.tools.length) throw new Fail(`every call failed: ${r.tools.map(toolLine).join("; ")}`);
        return r.tools.map(toolLine).join("; ");
      });
      await step("the simulator really shows Settings > About (the backend's own tree), and the reply has the version", async () => {
        const seen = r.tools.some((t) => /About/.test(t.output) && /iOS Version|Software Version|\biOS\b/.test(t.output));
        if (!seen) throw new Fail("no tool result showed the About screen");
        const major = runtime.split(" ")[1]?.split(".")[0] ?? "?";
        if (!new RegExp(`\\b${major}(\\.\\d+)*\\b`).test(r.reply)) throw new Fail(`reply ${JSON.stringify(r.reply)} lacks ${runtime}`);
        if (r.seen["[data-sim-driving]"] === undefined) throw new Fail("the panel never showed \"Agent is driving\"");
        // Opened before the first prompt (under `chat:<id>`), it stays open once the chat has its session.
        const now = chatPanelKey(id);
        if (useStore.getState().rightPanel[now] !== "device" || !$(`[data-sim-screen="${udid}"]`)) throw new Fail(`the iPhone panel closed (${key} -> ${now}: ${useStore.getState().rightPanel[now]})`);
        key = now;
        await shot("agent-iphone-after");
        return `reply ${JSON.stringify(r.reply.trim().slice(0, 160))}; runtime ${runtime}; driving mark after ${r.seen["[data-sim-driving]"]} ms; turn ${r.turnMs} ms, ${r.tokens ?? "?"} tokens`;
      });
    } finally {
      await step("the test's simulator is shut down and deleted", async () => {
        if (id >= 0) useStore.getState().setRightPanel(chatPanelKey(id), "closed");
        await sleep(500);
        const gone = (await invoke("selftest_sim_delete")) as string[];
        const left = (await api().simDevices()).devices.filter((d) => d.name === SIM);
        if (left.length) throw new Fail(`still there: ${left.map((d) => d.udid).join(", ")}`);
        return `deleted ${gone.join(", ") || "nothing"}`;
      });
    }
  },

  /**
   * A Claude Haiku chat drives coool's sandbox Mac (the VM behind the Mac panel; it must be installed already, as the
   * person's base Mac, which this test reuses): it opens TextEdit, types a given sentence into a new document and
   * reads it back. The harness reads the document from the Mac's own accessibility tree to check it, apart from the
   * reply, and cleans TextEdit up after.
   */
  async "agent-mac"(ctx) {
    const SENTENCE = "Seven purple owls read 42 maps at dawn.";
    let id = -1;
    let key = "";
    const mac = (request: Record<string, unknown>) => invoke("selftest_mac", { request }) as Promise<Record<string, unknown>>;
    const resetTextEdit = async () => {
      // A blank document on launch (no Open panel, no restored windows), and nothing left from an earlier run.
      await mac({
        cmd: "run",
        sh: "killall TextEdit 2>/dev/null; sleep 0.5; defaults write com.apple.TextEdit NSShowAppCentricOpenPanelInsteadOfUntitledFile -bool false; defaults write com.apple.TextEdit ApplePersistenceIgnoreState -bool true; defaults write com.apple.TextEdit RichText -bool false; rm -rf \"$HOME/Library/Containers/com.apple.TextEdit/Data/Library/Autosave Information\" \"$HOME/Library/Containers/com.apple.TextEdit/Data/Library/Saved Application State\"; echo done",
        timeout: 20,
      });
    };
    try {
      await step("the sandbox Mac boots (or is already up) and shows in a Haiku chat's Mac panel", async () => {
        const st = await api().macStatus();
        if (!st.available) throw new Fail(`no sandbox Mac: ${st.reason}`);
        if (!st.installed) throw new Fail("the sandbox Mac isn't installed (install it from the Mac panel first)");
        const t = Date.now();
        await api().macBoot();
        const boot = Date.now() - t;
        await resetTextEdit();
        ctx.model = PERF_MODEL;
        id = await startClaude(ctx);
        ctx.model = undefined;
        await waitFor("ready", () => chat(id)?.ready, 60_000);
        await waitFor("the chat on screen", () => $("[data-chat-timeline]"), 20_000);
        await sleep(1500);
        key = await waitFor("the pane's panel key", activePanelKey, 10_000);
        useStore.getState().setRightPanel(key, "mac");
        await waitFor("the Mac panel showing the running Mac", () => $("[data-mac-screen]") && $('[data-mac-panel="running"]'), 60_000);
        await sleep(2000);
        await shot("agent-mac-before");
        const after = await api().macStatus();
        return `${after.os} · ${after.cpus} CPUs · ${after.memoryMB} MB · disk ${((after.diskBytes ?? 0) / 1e9).toFixed(1)} GB used; boot ${boot} ms (state was ${st.state})`;
      });
      if (id < 0) return;
      const r = await agentTurn(id, {
        prompt:
          `Use the coool-device mac_* tools (mac_app, mac_type, mac_observe, ...) on the sandbox Mac shown in this chat's panel. Launch TextEdit, type exactly this sentence into its new document: ${SENTENCE} Then read the document's text back from the screen with mac_observe. Don't use the shell or mac_shell. Reply with one line: Text: <the document's text>.`,
        marks: [["[data-sim-driving]", "agent-mac-driving"]],
        probes: [{ name: "cursor", test: htmlCursor, shot: "agent-mac-cursor" }],
        ms: 240_000,
      });
      await step("agent-mac: the agent's cursor and label showed over the screen, the beam ran, and both clear after the turn", async () => {
        if (r.seen.cursor === undefined) throw new Fail("no agent cursor over the Mac");
        if (r.seen["[data-sim-driving]"] === undefined) throw new Fail("no beam around the Mac");
        return `cursor after ${r.seen.cursor} ms, beam after ${r.seen["[data-sim-driving]"]} ms; ${await presenceClears("[data-sim-driving]")}`;
      });
      await step("the agent drives the Mac through coool-device mac_* tools that succeed", async () => {
        const mine = r.tools.filter((t) => toolName(t).startsWith("mac_"));
        if (!mine.length) throw new Fail(`no mac_* tool calls; tools: ${r.all.join(", ") || "none"}`);
        if (mine.some((t) => toolName(t) === "mac_shell")) throw new Fail("used mac_shell");
        const failed = mine.filter((t) => t.ok === false);
        if (failed.length === mine.length) throw new Fail(`every call failed: ${mine.map(toolLine).join("; ")}`);
        return mine.map(toolLine).join("; ");
      });
      await step("TextEdit in the Mac really holds the sentence (the backend's own read), and the reply quotes it", async () => {
        const screen = (await invoke("selftest_mac_screen")) as string;
        const doc = screen.split("\n").find((l) => /\b(textarea|textfield)\b/.test(l) && l.includes(SENTENCE));
        if (!/app "TextEdit"/.test(screen)) throw new Fail(`TextEdit isn't in front: ${screen.split("\n")[0]}`);
        if (!doc) throw new Fail(`no text area holds the sentence:\n${screen.slice(0, 1500)}`);
        if (!r.reply.includes(SENTENCE)) throw new Fail(`reply ${JSON.stringify(r.reply)} lacks the sentence`);
        if (r.seen["[data-sim-driving]"] === undefined) throw new Fail('the panel never showed "Agent is driving"');
        await shot("agent-mac-after");
        return `document line: ${doc.trim().slice(0, 140)}; reply ${JSON.stringify(r.reply.trim().slice(0, 160))}; driving mark after ${r.seen["[data-sim-driving]"]} ms; turn ${r.turnMs} ms, ${r.tokens ?? "?"} tokens`;
      });
    } finally {
      await step("TextEdit is closed without saving, the panel closed", async () => {
        if (id >= 0) useStore.getState().setRightPanel(chatPanelKey(id), "closed");
        await resetTextEdit().catch(() => {});
        return "ok";
      });
    }
  },

  /**
   * A Claude Haiku chat hands "Settings > General > About" to the device pilot (`pilot_run`) on the test's own
   * simulator, twice: the first run learns the path (Claude Haiku decides), the second replays it from muscle memory.
   * The harness reads the simulator's screen itself to confirm About is showing.
   */
  async "pilot-iphone"(ctx) {
    const SIM = "coool selftest iPhone";
    let id = -1;
    let udid = "";
    let runtime = "";
    const prompt =
      'Call the coool-device tool pilot_run exactly once, with goal "Open General, then About", target "iphone", app "com.apple.Preferences" and success [{"text_visible":"iOS Version"}]. Don\'t call any other tool. Then reply with one line: iOS version: <the version in the final screen>.';
    try {
      await step("pilot-iphone: the test's own simulator is booted in a Haiku chat's iPhone panel", async () => {
        const t = Date.now();
        udid = await api().simEnsureDevice();
        await api().simBoot(udid);
        const dev = (await api().simDevices()).devices.find((d) => d.udid === udid);
        if (dev?.name !== SIM) throw new Fail(`made ${dev?.name}`);
        runtime = dev.runtime;
        ctx.model = PERF_MODEL;
        id = await startClaude(ctx);
        ctx.model = undefined;
        await waitFor("ready", () => chat(id)?.ready, 60_000);
        await waitFor("the chat on screen", () => $("[data-chat-timeline]"), 20_000);
        await sleep(1500);
        const key = await waitFor("the pane's panel key", activePanelKey, 10_000);
        useStore.getState().setRightPanel(key, "device");
        await waitFor("the panel showing the booted device", () => $(`[data-sim-screen="${udid}"]`) && $('[data-device-panel="Booted"]'), 60_000);
        // Let a fresh device finish its first-boot work before timing anything.
        await sleep(4000);
        return `${udid} (${runtime}) ready in ${Date.now() - t} ms`;
      });
      if (id < 0) return;
      const runs: PilotRunResult[] = [];
      for (const n of [1, 2]) {
        const r = await agentTurn(id, {
          prompt,
          marks: [
            ["[data-pilot-substep]", `pilot-iphone-run${n}-live`],
            ["[data-sim-driving]", `pilot-iphone-run${n}-driving`],
          ],
          probes: [{ name: "pilot-cursor", test: () => (/^Pilot · (memory|Haiku)/.test(htmlCursor() ?? "") ? htmlCursor() : null), shot: `pilot-iphone-run${n}-cursor` }],
          ms: 240_000,
        });
        await step(`pilot-iphone run ${n}: pilot_run ends done, its checks verified`, async () => {
          const p = pilotRuns(r);
          if (p.length !== 1) throw new Fail(`${p.length} pilot_run calls; tools: ${r.all.join(", ") || "none"}`);
          const o = p[0].out;
          if (!o) throw new Fail(`no outcome in ${p[0].tool.output.slice(0, 300)}`);
          if (o.status !== "done" || !o.verified) throw new Fail(`${o.status}: ${o.reason}; ${pilotLine(o)}`);
          runs.push(o);
          await log(`PILOT iphone run ${n} ${pilotLine(o)}`);
          return pilotLine(o);
        });
        await step(`pilot-iphone run ${n}: the simulator shows About (the backend's own read), the reply has the version, the chat showed the run`, async () => {
          const screen = (await invoke("selftest_sim_screen", { udid })) as string;
          if (!/iOS Version/.test(screen) || !/About/.test(screen)) throw new Fail(`screen:\n${screen.slice(0, 600)}`);
          const major = runtime.split(" ")[1]?.split(".")[0] ?? "?";
          if (!new RegExp(`\\b${major}(\\.\\d+)*\\b`).test(r.reply)) throw new Fail(`reply ${JSON.stringify(r.reply)} lacks ${runtime}`);
          if (r.seen["[data-pilot-substep]"] === undefined) throw new Fail("the chat never showed the pilot's live steps");
          const card = $("[data-pilot-status]");
          if (!card || !/done/.test(card.textContent ?? "")) throw new Fail(`pilot step shows ${card?.textContent}`);
          await shot(`pilot-iphone-run${n}-after`);
          return `reply ${JSON.stringify(r.reply.trim().slice(0, 100))}; live steps after ${r.seen["[data-pilot-substep]"]} ms; turn ${r.turnMs} ms`;
        });
        await step(`pilot-iphone run ${n}: the beam and the Pilot's cursor (with who decided) showed, and both clear after the run`, async () => {
          if (r.seen["[data-sim-driving]"] === undefined) throw new Fail("the panel never showed the beam");
          if (r.seen["pilot-cursor"] === undefined) throw new Fail("no Pilot cursor saying memory or Haiku");
          return `pilot cursor after ${r.seen["pilot-cursor"]} ms; ${await presenceClears("[data-sim-driving]")}`;
        });
      }
      await step("pilot-iphone: the second run is mostly muscle memory and faster", async () => {
        if (runs.length < 2) throw new Fail("a run failed");
        const [a, b] = runs;
        const mem = b.deciders.memory ?? 0;
        if (mem * 2 < b.steps.length) throw new Fail(`only ${mem} of ${b.steps.length} steps from memory`);
        if (b.wall_ms >= a.wall_ms) throw new Fail(`second run took ${b.wall_ms} ms vs ${a.wall_ms} ms`);
        return `run 1: ${a.wall_ms} ms (start ${a.start_ms} ms, ${JSON.stringify(a.deciders)}); run 2: ${b.wall_ms} ms (start ${b.start_ms} ms, ${JSON.stringify(b.deciders)})`;
      });
      await step("pilot-iphone: the second run is a warm start (Settings was in front: no relaunch), about 3 s or less", async () => {
        if (runs.length < 2) throw new Fail("a run failed");
        const b = runs[1];
        if (!/^warm:/.test(b.start)) throw new Fail(`start: ${b.start}`);
        if (b.wall_ms > 3500) throw new Fail(`the warm run took ${b.wall_ms} ms (start ${b.start_ms} ms: ${b.start})`);
        await log(`PILOT iphone warm ${b.wall_ms} ms: ${b.start}`);
        return `${b.wall_ms} ms; ${b.start}`;
      });
      await step("pilot-iphone: the decision log has both runs' decisions, on the successful path", async () => {
        const { recs } = await pilotLog();
        const mine = recs.filter((r) => r.target === "iphone");
        const byRun = new Map<string, PilotRecord[]>();
        for (const r of mine) byRun.set(r.run, [...(byRun.get(r.run) ?? []), r]);
        const all = [...byRun.values()];
        if (all.length < 2) throw new Fail(`${all.length} runs logged (${mine.length} records)`);
        const [r1, r2] = all.slice(-2);
        const who = (rs: PilotRecord[]) => rs.map((r) => r.decider).join(",");
        if (!r1.some((r) => r.decider === "haiku") || r1[r1.length - 1].decider !== "checks") throw new Fail(`run 1 deciders ${who(r1)}`);
        if (!r2.some((r) => r.decider === "memory") || r2.some((r) => r.decider === "haiku")) throw new Fail(`run 2 deciders ${who(r2)}`);
        for (const r of [...r1, ...r2]) {
          if (r.outcome !== "done" || !r.verified || r.on_success_path !== true) throw new Fail(`record ${JSON.stringify(r).slice(0, 300)}`);
          if (!r.screen.candidates.length || !r.screen.summary || r.chosen >= r.screen.candidates.length) throw new Fail(`screen of ${r.run}/${r.step}`);
        }
        await log(`PILOT log sample ${JSON.stringify(r2[0]).slice(0, 1500)}`);
        return `${mine.length} iphone records; run 1 ${who(r1)}, run 2 ${who(r2)} (prev ${r2.map((r) => r.prev).join(" / ")})`;
      });
      await step("pilot-iphone: Settings > Device pilot shows the log's folder and size", async () => {
        useStore.getState().openSettings("devices");
        const el = await waitFor("the log's size", () => $("[data-pilot-log-size]"), 10_000);
        const bytes = Number(el.getAttribute("data-pilot-log-size"));
        const dir = $("[data-pilot-log-dir]")?.textContent ?? "";
        if (!(bytes > 0) || !dir.includes(".coool-device")) throw new Fail(`size ${bytes}, dir ${dir}`);
        if (!$('[data-setting="pilot-log"] [role="switch"][aria-checked="true"]')) throw new Fail("the toggle isn't on");
        await shot("pilot-settings");
        useStore.getState().closeSettings();
        return `${dir}: ${el.textContent}`;
      });
    } finally {
      await step("pilot-iphone: the test's simulator is shut down and deleted", async () => {
        if (id >= 0) useStore.getState().setRightPanel(chatPanelKey(id), "closed");
        await sleep(500);
        const gone = (await invoke("selftest_sim_delete")) as string[];
        const left = (await api().simDevices()).devices.filter((d) => d.name === SIM);
        if (left.length) throw new Fail(`still there: ${left.map((d) => d.udid).join(", ")}`);
        return `deleted ${gone.join(", ") || "nothing"}`;
      });
    }
  },

  /**
   * A Claude Haiku chat hands the coffee-order form (the `agent-browser` page) to the device pilot on the Browser
   * panel, twice. The page's own reports confirm what was typed, clicked and submitted.
   */
  async "pilot-browser"(ctx) {
    const NAME = "Ada Lovelace";
    const CUPS = 3;
    const REF = `CUP-${100 + 7 * CUPS + NAME.length}`;
    let id = -1;
    let url = "";
    await step("pilot-browser: a Haiku chat starts, its Browser panel closed", async () => {
      url = ((await invoke("selftest_probe_server")) as string).replace(/\/probe$/, "/form");
      const before = new Set(Object.keys(useChats.getState().chats).map(Number));
      await newChat({ provider: "claude", cwd: ctx.cfg.dir, model: PERF_MODEL });
      id = (await waitFor("the new chat", () => newId(before), 10_000)).id;
      await waitFor("ready", () => chat(id)?.ready, 90_000);
      await waitFor("the chat on screen", () => $("[data-chat-timeline]"), 20_000);
      await sleep(1500);
      return `chat ${id}, ${url}`;
    });
    if (id < 0) return;
    const runs: PilotRunResult[] = [];
    for (const n of [1, 2]) {
      const earlier = (await probeResults()).length;
      const r = await agentTurn(id, {
        prompt: `Call the coool-device tool pilot_run exactly once with target "browser", url "${url}", goal "Fill in the name and the email, press Add cup until the cups counter shows ${CUPS}, then press Submit order", inputs {"name":"${NAME}","email":"ada@example.com"} and success [{"text_visible":"${CUPS} cups, reference"}]. Don't call any other tool. Then reply with the exact confirmation sentence from the final screen, nothing else.`,
        marks: [
          ["[data-pilot-substep]", `pilot-browser-run${n}-live`],
          ["[data-browser-driving]", `pilot-browser-run${n}-acting`],
        ],
        probes: [{ name: "page-cursor", test: async () => ((await pageCursors(id))?.includes("Pilot · ") ? pageCursors(id) : null), shot: `pilot-browser-run${n}-cursor` }],
        ms: 240_000,
      });
      await step(`pilot-browser run ${n}: pilot_run ends done, its checks verified`, async () => {
        const p = pilotRuns(r);
        if (p.length !== 1) throw new Fail(`${p.length} pilot_run calls; tools: ${r.all.join(", ") || "none"}`);
        const o = p[0].out;
        if (!o) throw new Fail(`no outcome in ${p[0].tool.output.slice(0, 300)}`);
        if (o.status !== "done" || !o.verified) throw new Fail(`${o.status}: ${o.reason}; ${pilotLine(o)}`);
        runs.push(o);
        await log(`PILOT browser run ${n} ${pilotLine(o)}`);
        return pilotLine(o);
      });
      await step(`pilot-browser run ${n}: the page really took the order (its own report), the reply quotes it`, async () => {
        const forms = (await probeResults()).slice(earlier).filter((p) => p.step === "form");
        const last = forms[forms.length - 1];
        if (!last) throw new Fail("the page never reported a change");
        if (!last.submitted || last.name !== NAME || last.cups !== CUPS || last.email !== "ada@example.com") throw new Fail(`page state ${JSON.stringify(last)}`);
        if (!String(last.confirmation).includes(REF)) throw new Fail(`confirmation ${last.confirmation}`);
        if (!r.reply.includes(REF)) throw new Fail(`reply ${JSON.stringify(r.reply)} lacks ${REF}`);
        await shot(`pilot-browser-run${n}-after`);
        return `reply ${JSON.stringify(r.reply.trim().slice(0, 120))}; turn ${r.turnMs} ms`;
      });
      await step(`pilot-browser run ${n}: the beam and the Pilot's cursor on the page showed, and both clear after the run`, async () => {
        if (r.seen["[data-browser-driving]"] === undefined) throw new Fail("no beam around the page");
        if (r.seen["page-cursor"] === undefined) throw new Fail("no Pilot cursor on the page");
        return `page cursor after ${r.seen["page-cursor"]} ms; ${await presenceClears("[data-browser-driving]", id)}`;
      });
    }
    await step("pilot-browser: the second run leans on muscle memory", async () => {
      if (runs.length < 2) throw new Fail("a run failed");
      const [a, b] = runs;
      const mem = b.deciders.memory ?? 0;
      if (mem * 2 < b.steps.length) throw new Fail(`only ${mem} of ${b.steps.length} steps from memory`);
      return `run 1: ${a.wall_ms} ms ${JSON.stringify(a.deciders)}; run 2: ${b.wall_ms} ms ${JSON.stringify(b.deciders)}`;
    });
    await step("pilot-browser: the decision log has the form's decisions, and nothing that was typed", async () => {
      const { raw, recs } = await pilotLog();
      const mine = recs.filter((r) => r.target === "browser");
      if (mine.length < 4) throw new Fail(`${mine.length} browser records`);
      const low = raw.toLowerCase();
      for (const v of [NAME.toLowerCase(), "ada@example.com"]) if (low.includes(v)) throw new Fail(`the log holds the input value ${JSON.stringify(v)}`);
      if (!mine.every((r) => r.input_keys.join(",") === "email,name")) throw new Fail(`input keys ${JSON.stringify(mine[0].input_keys)}`);
      const typed = mine.filter((r) => r.screen.candidates[r.chosen]?.verb === "set_text");
      if (typed.length < 2) throw new Fail(`${typed.length} set_text decisions`);
      if (!raw.includes("<filled>")) throw new Fail("no filled field recorded as <filled>");
      const done = mine.filter((r) => r.outcome === "done" && r.on_success_path === true).length;
      return `${mine.length} browser records (${done} on a successful path), set_text by key ${typed.map((r) => r.screen.candidates[r.chosen].input_key).join(", ")}; no input values`;
    });
    useStore.getState().closeBrowser(chatPanelKey(id));
  },

  /**
   * The frosted glass (lib/glass.ts, Settings > Appearance > Translucent window): screenshots of the chrome and the
   * three device panels in both themes, Settings, the setting off, an inactive window and full screen; then frame
   * pacing while a long chat scrolls and the window resizes, glass on and off (`glass-perf`). No model calls, nothing
   * booted: the iPhone panel shows a shut-down simulator (or its set-up state), the Mac panel its stopped state.
   * Restores the theme and the setting. `COOOL_REDUCE_TRANSPARENCY=1` (debug builds) runs it as with Reduce transparency.
   */
  async glass(ctx) {
    const keep = { theme: localStorage.getItem("coool.theme"), glass: localStorage.getItem("coool.glass") };
    const st = () => useStore.getState();
    const g = () => document.documentElement.dataset.glass === "on";
    const rt = (await import("./lib/glass")).glassState().reduceTransparency;
    const tag = rt ? "rt-" : "";
    const { setGlassPref } = await import("./lib/glass");
    try {
      const key = await browserHost(ctx);
      const id = ctx.main!;
      // A shut-down simulator for the iPhone panel's device frame (none is booted or made here).
      const sims = await api().simDevices().catch(() => null);
      const off = sims?.devices.find((d) => d.state === "Shutdown");
      if (off) st().setDevice(key, off.udid);
      const mac = await api().macStatus().catch(() => null);
      const macIdle = !mac || !/run|boot|start/i.test(String(mac.state));
      await step(`glass ${rt ? "stays off with Reduce transparency" : "is on by default"}`, async () => {
        setGlassPref(true);
        await sleep(600);
        if (rt ? g() : !g()) throw new Fail(`data-glass=${document.documentElement.dataset.glass}`);
        const chrome = getComputedStyle(document.querySelector("#root > div")!).backgroundColor;
        return `data-glass ${g() ? "on" : "off"}, chrome ${chrome}, body ${getComputedStyle(document.body).backgroundColor}`;
      });
      const tour = async (t: "light" | "dark", pre: string) => {
        st().setThemePref(t);
        await sleep(900);
        st().setRightPanel(key, "closed");
        await shot(`${pre}${t}-chat`, undefined, 900);
        st().setRightPanel(key, "device");
        await waitFor("the iPhone panel", () => $("[data-device-panel]"), 10_000);
        await shot(`${pre}${t}-iphone`, undefined, 1200);
        if (macIdle) {
          st().setRightPanel(key, "mac");
          await shot(`${pre}${t}-mac`, undefined, 1500);
        }
        if (!st().browser[key]) st().openBrowser(key, { kind: "web", url: "https://example.com" });
        else st().setRightPanel(key, "browser");
        await waitFor("the page", () => nativeId(activeTabKey(key) ?? ""), 10_000).catch(() => null);
        await shot(`${pre}${t}-browser`, undefined, 2500);
        st().openSettings("appearance");
        await shot(`${pre}${t}-settings`, undefined, 900);
        st().closeSettings();
      };
      await step("light and dark: chrome, iPhone, Mac, Browser, Settings", async () => {
        await tour("light", `glass-${tag}`);
        await tour("dark", `glass-${tag}`);
        const hole = ($("[data-sheet-bg]") as HTMLElement | null)?.style.maskImage ?? "";
        if (!rt && !hole.includes("gradient")) throw new Fail("no hole in the sheet behind the browser panel");
        return `mac ${macIdle ? "shown" : `skipped (${mac?.state})`}; sim ${off?.name ?? "none shut down"}; hole ${hole ? "cut" : "none"}`;
      });
      if (rt) return;
      await step("inactive window (another app in front)", async () => {
        st().setRightPanel(key, "device");
        await log("GLASS inactive-now");
        await sleep(1500);
        await shot("glass-dark-inactive", undefined, 300);
        st().setThemePref("light");
        await sleep(900);
        await shot("glass-light-inactive", undefined, 300);
        await log("GLASS active-now");
        await invoke("selftest_window", { action: "focus" });
        await sleep(800);
        return document.hasFocus() ? "focused again" : "not focused";
      });
      await step("the setting off: solid, as before", async () => {
        setGlassPref(false);
        await sleep(700);
        if (g()) throw new Fail("still glass");
        await shot("glass-off-light-iphone");
        st().setThemePref("dark");
        await sleep(900);
        await shot("glass-off-dark-iphone");
        setGlassPref(true);
        await sleep(700);
        if (!g()) throw new Fail("glass did not come back");
      });
      await step("full screen", async () => {
        await invoke("selftest_window", { action: "fullscreen" });
        await sleep(2500);
        await shot("glass-dark-fullscreen", undefined, 200);
        st().setThemePref("light");
        await sleep(900);
        await shot("glass-light-fullscreen", undefined, 200);
        await invoke("selftest_window", { action: "windowed" });
        await sleep(2000);
        st().setThemePref("dark");
        await sleep(600);
        return `glass ${g() ? "on" : "off"}`;
      });
      // ---------- frame pacing ----------
      await step("glass-perf: a long chat scrolls and the window resizes, glass on and off", async () => {
        const evs: ChatEvent[] = [];
        let seq = 1_000_000;
        const para = "The panel keeps its place while the agent works through the list, and every row stays readable. ";
        for (let i = 0; i < 120; i++) {
          evs.push({ seq: seq++, ts: Date.now(), type: "user_message", id: `glass-u${i}`, text: `Question ${i}: what changed in step ${i}?` } as ChatEvent);
          evs.push({ seq: seq++, ts: Date.now(), type: "assistant_message", id: `glass-a${i}`, text: `**Step ${i}.** ${para.repeat(3)}\n\n- one\n- two\n- three\n\n${para.repeat(2)}`, model: null, parent_tool_id: null } as ChatEvent);
        }
        useChats.getState().apply(id, evs);
        st().setRightPanel(key, "device");
        await sleep(1500);
        const el = $(`[data-chat-timeline="${id}"]`);
        if (!el || el.scrollHeight < el.clientHeight * 5) throw new Fail(`chat not long enough: ${el?.scrollHeight}/${el?.clientHeight}`);
        const frames = (ms: number, each: (i: number) => void | Promise<void>) =>
          new Promise<number[]>((done) => {
            const out: number[] = [];
            let last = 0;
            let i = 0;
            const t0 = performance.now();
            const tick = (t: number) => {
              if (last) out.push(t - last);
              last = t;
              void each(i++);
              if (t - t0 < ms) requestAnimationFrame(tick);
              else done(out);
            };
            requestAnimationFrame(tick);
          });
        const stats = (d: number[]) => {
          const s = [...d].sort((a, b) => a - b);
          const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
          const med = q(0.5);
          return `${d.length} frames, median ${med.toFixed(1)} ms, p95 ${q(0.95).toFixed(1)}, p99 ${q(0.99).toFixed(1)}, max ${s[s.length - 1].toFixed(1)}, over 1.5x median ${d.filter((x) => x > med * 1.5).length}`;
        };
        const out: string[] = [];
        // A first pass lays the long chat out and warms the caches; not counted.
        for (let i = 0; i < 40; i++) {
          el.scrollTop = (el.scrollHeight * i) / 40;
          await sleep(30);
        }
        for (const on of [true, false, true, false]) {
          setGlassPref(on);
          await sleep(1200);
          const label = on ? "on" : "off";
          el.scrollTop = 0;
          await sleep(500);
          await log(`PERF glass=${label} scroll-start`);
          const sc = await frames(5000, () => {
            el.scrollTop = el.scrollTop + 14 >= el.scrollHeight - el.clientHeight ? 0 : el.scrollTop + 14;
          });
          await log(`PERF glass=${label} scroll-end ${stats(sc)}`);
          await sleep(800);
          await log(`PERF glass=${label} resize-start`);
          const rs = await frames(5000, (i) => {
            if (i % 2) return;
            const k = (i / 2) % 60;
            const w = 1440 - (k < 30 ? k : 60 - k) * 8;
            return invoke("selftest_resize", { width: w, height: 900 - (k < 30 ? k : 60 - k) * 4 }).then(() => {});
          });
          await invoke("selftest_resize", { width: 1440, height: 900 });
          await log(`PERF glass=${label} resize-end ${stats(rs)}`);
          await sleep(1500);
          await log(`PERF glass=${label} idle-start`);
          await sleep(5000);
          await log(`PERF glass=${label} idle-end`);
          out.push(`${label}: scroll ${stats(sc)} | resize ${stats(rs)}`);
        }
        return out.join(" || ");
      });
    } finally {
      setGlassPref(keep.glass !== "off");
      st().setThemePref(keep.theme === "light" || keep.theme === "dark" ? keep.theme : "system");
      await log(`GLASS restored theme=${keep.theme} glass=${keep.glass}`);
    }
  },

  /** `glass` in short: the iPhone panel over the glass in both themes (for trying materials). */
  async "glass-peek"(ctx) {
    const keep = localStorage.getItem("coool.theme");
    const st = () => useStore.getState();
    const key = await browserHost(ctx);
    st().setRightPanel(key, "device");
    for (const t of ["light", "dark"] as const) {
      st().setThemePref(t);
      await shot(`peek-${t}`, undefined, 1500);
    }
    st().setThemePref(keep === "light" || keep === "dark" ? keep : "system");
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

// ---------- the sweep: today's features against the real backend (a git repo in the test folder) ----------
//
// `sweep-mc` (Claude Haiku chats in the test folder, which must be a git repository with commits, a --no-ff merge and
// an uncommitted edit): project tabs, the Sessions / Changes / trail cards, the inline edit review answered from
// Mission control, the file-overlap row, the live Committing row, the fan-out with real sub-agents (and their cards in
// the chat), "While you were away" (the window ordered out while two turns run; the absence then made 15 minutes long
// by moving the person's last-seen marks back, since the rules want 10 minutes away). `sweep-timeline` (Haiku; the
// folder's `.mcp.json` names a `weather` server): readable tool rows for coool-device and another MCP server, where the
// turn went (bar and waterfall), the context map against the chat's context figure, then `/compact`. `sweep-titles`
// (no model of its own: names the chats earlier scenarios made) and `sweep-titles-restart` (a second launch: the name
// survived). `sweep-settings` (no model but one short Bash turn for the sleep assertion), `sweep-usage` (no model; never
// presses "Use a reset" for real), `sweep-motion` (no model: the Browser tools driven directly under Reduce motion
// Off / On / Auto), `sweep-mac-input` (no model: the person's own click and keys into the sandbox Mac),
// `sweep-pilot-mac` (Haiku: `pilot_run` with target "mac"), `sweep-composer` (no model: the hint row in narrow panes),
// `sweep-noconfirm` (last: Confirm before quitting off, ⌘Q with a chat running quits at once).

const sweepState: { a: number; b: number; c: number; d: number } = { a: -1, b: -1, c: -1, d: -1 };
const home = () => useStore.getState().activate(null);
/** Mission control on project `name` (its tab clicked when another shows). */
function onTab(name: string) {
  const t = $all("[data-mc-tab]").find((x) => x.dataset.mcSwitchTo === name);
  if (t && t.getAttribute("aria-selected") !== "true") t.click();
}
/**
 * The person looking at the window again. While another app is in front (the person using this Mac during the
 * test), macOS won't let the test window become key, so the page never gets its own focus event: this is the event
 * the window would get.
 */
const lookBack = () => window.dispatchEvent(new Event("focus"));
const textOf = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const sessionOf = (id: number) => {
  const sid = chat(id)?.sessionId;
  return sid ? useStore.getState().sessions.find((s) => s.id === sid) : undefined;
};
async function startIn(cwd: string, mode: string | null, prompt?: string): Promise<number> {
  const before = new Set(Object.keys(useChats.getState().chats).map(Number));
  await newChat({ provider: "claude", cwd, model: PERF_MODEL, permissionMode: mode, prompt });
  const id = (await waitFor("the new chat", () => newId(before), 10_000)).id;
  await waitFor("ready", () => chat(id)?.ready, 90_000);
  return id;
}
/** Sends `text` to chat `id` (shown first) and waits for the turn, allowing / denying nothing (the caller does). */
async function turn(id: number, text: string, ms = 150_000) {
  useStore.getState().open({ kind: "chat", id });
  await waitFor("the chat on screen", () => $("[data-chat-timeline]"), 20_000);
  await sleep(300);
  const n = turnEnds(id).length;
  await say(text);
  return nextTurn(id, n, ms);
}
/** Sends without waiting (the chat must be on screen). */
async function send(id: number, text: string) {
  useStore.getState().open({ kind: "chat", id });
  await waitFor("the chat on screen", () => $("[data-chat-timeline]"), 20_000);
  await sleep(300);
  await say(text);
}
/** A setting's row by its `attr`. */
const settingRow = (attr: string) => document.querySelector(`[data-setting="${CSS.escape(attr)}"]`) as HTMLElement | null;
const switchIn = (el: Element | null) => el?.querySelector('[role="switch"]') as HTMLElement | null;
const dbl = (el: Element) => el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
function ctxMenu(el: Element) {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 5, button: 2 }));
}
function setInput(el: HTMLInputElement | HTMLTextAreaElement, v: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
const sweep: Record<string, (ctx: Ctx) => Promise<void>> = {
  async "sweep-mc"(ctx) {
    const dir = ctx.cfg.dir;
    await step("mc: a real repo shows its trail (merge curve, branch, uncommitted) with a live session, two project tabs", async () => {
      sweepState.a = await startIn(dir, "default");
      sweepState.d = await startIn(`${dir}/sub`, "bypassPermissions");
      home();
      const trail = await waitFor("the commit trail", () => $("[data-mc-trail]"), 30_000);
      await waitFor("the trail's commits", () => /Add b\.ts/.test(textOf(trail)), 30_000);
      await sleep(1200);
      const tabs = $all("[data-mc-tab]").map((t) => `${t.dataset.mcTab?.split("/").pop()}=${textOf(t)}`);
      await shot("sweep-mc-start");
      const t = textOf(trail);
      const want = ["main", "Add b.ts", "colours", "Add a.ts"];
      const miss = want.filter((w) => !t.includes(w));
      if (miss.length) throw new Fail(`trail lacks ${miss.join(", ")}: ${t.slice(0, 400)}`);
      if (!/uncommitted/.test(t)) throw new Fail(`no "uncommitted" in the trail header: ${t.slice(0, 200)}`);
      if (tabs.length < 2) throw new Fail(`project tabs: ${tabs.join(" | ")}`);
      // Switch to the other tab and back.
      const other = $all("[data-mc-tab]").find((x) => x.getAttribute("aria-selected") !== "true");
      other?.click();
      await sleep(700);
      await shot("sweep-mc-tab-sub");
      const sel = $all("[data-mc-tab]").find((x) => x.getAttribute("aria-selected") === "true");
      const back = $all("[data-mc-tab]").find((x) => x.dataset.mcTab === dir || x.dataset.mcTab?.endsWith("/proj"));
      back?.click();
      await sleep(700);
      if (back?.getAttribute("aria-selected") !== "true") throw new Fail("the proj tab didn't take the click");
      const sessions = textOf($("[data-mc-sessions]"));
      return `tabs ${tabs.join(" | ")}; switched to ${sel?.dataset.mcTab?.split("/").pop()}; trail: ${t.slice(0, 260)}; sessions card: ${sessions.slice(0, 160)}`;
    });
    await step("mc: no Needs-you strip on Home; a real pending Edit shows on the Needs you page with its word diff, Allow there applies it", async () => {
      const id = sweepState.a;
      await send(id, "Use the Edit tool to change the word red to blue in notes.txt. Do not do anything else, then reply with: done");
      await waitFor("the pending edit", () => chat(id)?.pendingPermission, 90_000);
      home();
      await sleep(800);
      if ($("[data-mc-needs]") || $("[data-mc-needs-card]")) throw new Fail("Mission control still shows a Needs-you strip");
      const key = needsKeyOf(id);
      useStore.getState().openNeeds(key);
      const card = await waitFor("the Needs you page's edit", () => $all("[data-needs-detail]").find((c) => /notes\.txt/.test(textOf(c))), 15_000);
      await sleep(800);
      await shot("sweep-mc-edit-review");
      const txt = textOf(card);
      const ins = [...card.querySelectorAll("ins, [data-add]")].map(textOf).join(",");
      const del = [...card.querySelectorAll("del, s, [data-del]")].map(textOf).join(",");
      const allow = card.querySelector("[data-allow-once]") as HTMLElement | null;
      if (!allow) throw new Fail(`no Allow: ${txt}`);
      allow.click();
      const end = await nextTurn(id, turnEnds(id).length, 90_000);
      const tool = (items(id).filter((i) => i.kind === "tool") as Tool[]).find((t) => t.name === "Edit");
      if (!tool || tool.ok === false) throw new Fail(`the Edit didn't succeed: ${tool?.output.slice(0, 200)}`);
      return `card: ${txt.slice(0, 200)}; added [${ins}] removed [${del}]; turn ${end.ok ? "ok" : "not ok"}`;
    });
    await step("mc: two chats editing notes.txt make a pinned overlap row (same copy) and sidebar marks", async () => {
      sweepState.b = await startIn(dir, "bypassPermissions");
      await turn(sweepState.b, "Use the Edit tool to append a new last line 'Owls are wise.' to notes.txt. Do nothing else, then reply with: done");
      home();
      const row = await waitFor("the overlap row", () => (onTab("proj"), $("[data-mc-overlap]")), 30_000);
      await sleep(600);
      const t = textOf(row);
      row.click();
      await sleep(600);
      await shot("sweep-mc-overlap");
      const marks = $all("[data-overlap-mark]").length;
      const edits = $all("[data-mc-overlap-edit]").map(textOf);
      if (!/notes\.txt/.test(t)) throw new Fail(`overlap row: ${t}`);
      return `"${t}"; ${edits.length} author rows: ${edits.join(" | ").slice(0, 300)}; sidebar marks ${marks}`;
    });
    await step("mc: the Committing row shows with its message while an agent's git commit runs, then settles into the trail", async () => {
      const id = sweepState.b;
      const n0 = turnEnds(id).length;
      await send(id, "Run exactly this one Bash command and nothing else: sleep 8 && git add other.txt && git commit -m 'Add other notes' . Then reply with: done");
      home();
      const t0 = Date.now();
      const row = await waitFor("the Committing row", () => (onTab("proj"), $("[data-mc-committing]")), 60_000);
      const seen = Date.now() - t0;
      const rt = textOf(row);
      await shot("sweep-mc-committing", undefined, 150);
      await nextTurn(id, n0, 90_000).catch(() => null);
      await waitFor("the commit in the trail", () => (onTab("proj"), /Add other notes/.test(textOf($("[data-mc-trail]"))) && !$("[data-mc-committing]")), 40_000);
      await sleep(500);
      await shot("sweep-mc-committed");
      return `Committing row after ${seen} ms: "${rt}"; settled into the trail`;
    });
    await step("mc: the fan-out shows two real sub-agents; their chat cards show the context bar and the lead's handoff", async () => {
      sweepState.c = await startIn(dir, "bypassPermissions");
      const id = sweepState.c;
      await send(
        id,
        "In one message, launch two sub-agents in parallel with the Agent (Task) tool, both with model haiku and subagent_type general-purpose. Sub-agent one: 'Run the Bash command ping -c 25 127.0.0.1 > /dev/null in the foreground, then reply with the word alpha.' Sub-agent two: 'Run the Bash command ping -c 25 127.0.0.1 > /dev/null in the foreground, then reply with the word beta.' After both finish, reply with: done",
      );
      home();
      const fan = await waitFor("the fan-out", () => (onTab("proj"), $("[data-mc-fanout]")), 90_000);
      await sleep(1500);
      await shot("sweep-mc-fanout");
      const ft = textOf(fan);
      useStore.getState().open({ kind: "chat", id });
      const cards = await waitFor("two sub-agent cards with a fill", () => ($all("[data-agent-card]").length >= 2 && $("[data-agent-fill]") ? $all("[data-agent-card]") : null), 60_000);
      await sleep(800);
      await shot("sweep-chat-subagents-running");
      const fills = $all("[data-agent-fill]").map(textOf);
      const hand = $all("[data-agent-handoff]").map(textOf);
      await nextTurn(id, 0, 180_000);
      await sleep(1000);
      await shot("sweep-chat-subagents-done");
      const fillsDone = $all("[data-agent-fill]").map(textOf);
      if (!hand.length) throw new Fail(`no handoff line; cards: ${cards.map(textOf).join(" | ").slice(0, 300)}`);
      return `fan-out "${ft.slice(0, 200)}"; fills running [${fills.join(", ")}], done [${fillsDone.join(", ")}]; handoff ${hand.join(" | ").slice(0, 200)}`;
    });
    await step("mc: While you were away (window ordered out during two turns, the absence then 15 minutes) on Home and in the chat", async () => {
      const id = sweepState.b;
      useStore.getState().open({ kind: "chat", id });
      await sleep(500);
      lookBack(); // the person has the chat on screen before leaving
      await sleep(300);
      await invoke("selftest_window", { action: "hide" });
      await sleep(1500);
      const vis = document.visibilityState;
      const bKey = useStore.getState().chatOwner[id];
      await log(`INFO away: hidden, visibility ${vis}, focus ${document.hasFocus()}, B key ${bKey}, B seen.at ${useStore.getState().seen.at?.[bKey]} (now ${Date.now()})`);
      const n = turnEnds(id).length;
      await say("Run exactly this Bash command and nothing else: git add README.md && git commit -m 'Update README' . Then reply with: done");
      await nextTurn(id, n, 90_000);
      await say("Reply with the single word: two");
      await nextTurn(id, n + 1, 60_000);
      // Fifteen minutes away: the marks move back (the rules need 10 minutes; nothing else is changed).
      useStore.setState((s) => ({ seen: { ...s.seen, at: Object.fromEntries(Object.entries(s.seen.at ?? {}).map(([k, t]) => [k, t - 15 * 60_000])) } }));
      home();
      await invoke("selftest_window", { action: "show" });
      await sleep(400);
      lookBack();
      const strip = await waitFor("the away strip", () => $("[data-mc-away]"), 10_000);
      await sleep(900);
      await shot("sweep-mc-away");
      const st = textOf(strip);
      useStore.getState().open({ kind: "chat", id });
      await sleep(300);
      lookBack();
      await sleep(1200);
      {
        const st = useStore.getState();
        const tab = st.tabs.find((t) => t.id === st.activeTab);
        await log(`INFO away: after open, focus ${document.hasFocus()} vis ${document.visibilityState}; leaves ${JSON.stringify(tab ? leaves(tab.root).map((l) => l.target) : null)}; B in sessions ${st.sessions.some((x) => sessionKey(x) === bKey)}, in allSessions ${st.allSessions.some((x) => sessionKey(x) === bKey)}`);
      }
      await log(`INFO away: after show, away keys ${JSON.stringify(Object.fromEntries(Object.entries(useStore.getState().away).map(([k, v]) => [k, Math.round((v.back - v.left) / 1000)])))}; B seen.at ${useStore.getState().seen.at?.[bKey]}`);
      const card = await waitFor("the chat's away card", () => $("[data-away-card]"), 10_000).catch(() => null);
      await sleep(700);
      await shot("sweep-chat-away");
      const ct = textOf(card);
      (card?.querySelector("[data-away-dismiss]") as HTMLElement | null)?.click();
      await sleep(500);
      const div = textOf($("[data-away-divider]"));
      if (!card) throw new Fail(`strip "${st}", but no card in the chat`);
      return `hidden: visibility ${vis}; strip "${st}"; card "${ct.slice(0, 200)}"; after Got it "${div}"`;
    });
  },

  async "sweep-timeline"(ctx) {
    const dir = ctx.cfg.dir;
    const url = ((await invoke("selftest_probe_server")) as string).replace(/\/probe$/, "/form");
    let id = -1;
    let r: AgentRun | null = null;
    await step("timeline: a Haiku chat (Ask mode) drives the Browser and calls the folder's weather MCP server", async () => {
      id = await startIn(dir, "default");
      sweepState.d = id;
      useStore.getState().open({ kind: "chat", id });
      await waitFor("the chat on screen", () => $("[data-chat-timeline]"), 20_000);
      await sleep(1200);
      r = await agentTurn(id, {
        prompt: `Do these in order. 1) Open ${url} with the coool-device browser_navigate tool. 2) Click the "Add cup" button once with browser_click. 3) Call the get_forecast tool of the weather MCP server for the city Paris. Then reply with one line: the forecast text.`,
        marks: [],
        ms: 180_000,
        answer: (a) => (a.kind === "use" || a.kind === "site" ? "project" : "once"),
        allow: /weather/,
      });
      return `tools: ${r.all.join(", ")}; reply ${JSON.stringify(r.reply.slice(0, 120))}; asks ${r.asks.map((a) => a.kind).join(",")}`;
    });
    if (id < 0) return;
    await step("timeline: tool rows read as phrases (Browser, weather) and chips count by group", async () => {
      // Open every step list so every row is in the DOM.
      for (const t of $all("[data-turn-toggle]")) void t;
      const head = $all("[data-step-chip]").map((c) => c.dataset.stepChip);
      // A finished turn's step list is folded: open it (only the "Ran N steps" headers, not the turn's footer).
      if (!$all("[data-step-family]").length) for (const b of [...document.querySelectorAll("[data-chat-timeline] button")] as HTMLElement[]) if (/^Ran \d+ steps?/.test(textOf(b))) b.click();
      await sleep(600);
      const rows = $all("[data-step-family]").map((x) => `${x.dataset.stepFamily}: ${textOf(x)}`);
      await shot("sweep-timeline-rows");
      const all = rows.join(" | ");
      if (/mcp__/.test(all)) throw new Fail(`a raw MCP name shows: ${all.slice(0, 500)}`);
      if (!/Opened\s*127\.0\.0\.1/.test(all)) throw new Fail(`no "Opened 127.0.0.1…" row: ${all.slice(0, 500)}`);
      if (!/weather/.test(all)) throw new Fail(`no weather row: ${all.slice(0, 500)}`);
      return `chips [${head.join(", ")}]; rows ${all.slice(0, 600)}`;
    });
    await step("timeline: where the turn went: the bar under Worked for, its waterfall on click", async () => {
      const bar = await waitFor("the turn bar", () => $all("[data-turn-bar]").pop(), 5_000);
      const segs = bar.dataset.turnBar;
      const toggle = $all("[data-turn-toggle]").pop();
      if (toggle?.getAttribute("aria-expanded") !== "true") toggle?.click();
      const wf = await waitFor("the waterfall", () => $all("[data-waterfall]").pop(), 5_000);
      await sleep(700);
      wf.scrollIntoView({ block: "center" });
      // It must stay open (not reset by later events re-rendering the footer).
      let closedAfter = -1;
      for (let i = 0; i < 30 && closedAfter < 0; i++) {
        await sleep(100);
        if (!document.querySelector("[data-waterfall]")) closedAfter = i * 100;
      }
      await shot("sweep-timeline-waterfall");
      const rows = [...document.querySelectorAll("[data-wf-row]")].map(textOf);
      if (closedAfter >= 0) throw new Fail(`the waterfall closed by itself ${closedAfter} ms after opening (aria-expanded ${toggle?.getAttribute("aria-expanded")})`);
      return `bar segments ${segs}; waterfall ${wf.dataset.waterfall} rows: ${rows.join(" | ").slice(0, 500)}; slowest ${textOf($("[data-slowest]"))}`;
    });
    await step("timeline: the context map in Models equals the chat's context figure; parts sum to the total", async () => {
      const key = await waitFor("the pane's panel key", activePanelKey, 10_000);
      useStore.getState().setRightPanel(key, "models");
      const map = await waitFor("the context map", () => $("[data-context-map]"), 20_000);
      await sleep(1500);
      await shot("sweep-context-map");
      const c = chat(id)!;
      const m = await api().contextMap({ provider: "claude", sessionId: c.sessionId!, cwd: c.cwd });
      const sum = m.parts.reduce((n, p) => n + p.tokens, 0);
      const head = textOf(map).slice(0, 80);
      if (m.total !== c.context) throw new Fail(`map total ${m.total} vs chat context ${c.context}`);
      if (sum !== m.total) throw new Fail(`parts sum ${sum} vs total ${m.total}`);
      return `total ${m.total} = chat context ${c.context} = parts sum; header "${head}"; composer chip ${fmtTokensLocal(c.context)}; ${m.parts.length} parts: ${m.parts.slice(0, 6).map((p) => `${p.label} ${p.tokens}`).join(", ")}`;
    });
    await step("timeline: /compact compacts for real; the map shows Compacted before → after with Show before", async () => {
      const n = turnEnds(id).length;
      let sawCompacting = false;
      const w = setInterval(() => (sawCompacting ||= !!chat(id)?.compacting || !!$("[data-ctx-compacting]")), 100);
      try {
        type("/compact");
        await sleep(300);
        composer().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); // picks /compact in the command menu
        await sleep(300);
        if (composer().value.trim()) composer().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); // sends it
        await nextTurn(id, n, 180_000);
        await sleep(1500);
        await shot("sweep-compact-done");
        await turn(id, "Reply with the single word: ok", 90_000);
      } finally {
        clearInterval(w);
      }
      const key = await waitFor("the pane's panel key", activePanelKey, 10_000);
      useStore.getState().setRightPanel(key, "models");
      const map = await waitFor("the context map", () => $("[data-context-map]"), 20_000);
      await waitFor("the Compacted line", () => /Compacted/.test(textOf(map)), 20_000).catch(() => null);
      await sleep(1200);
      await shot("sweep-compact-map");
      const t = textOf(map);
      const before = button("Show before", map);
      before?.click();
      await sleep(900);
      await shot("sweep-compact-map-before");
      const m = await api().contextMap({ provider: "claude", sessionId: chat(id)!.sessionId!, cwd: chat(id)!.cwd });
      if (!m.compaction) throw new Fail(`no compaction in the map; text "${t.slice(0, 200)}"`);
      return `compacting seen live: ${sawCompacting}; ${m.compaction.before} → ${m.compaction.after} (auto ${m.compaction.auto}); map text "${t.match(/Compacted[^·]*·[^S]*/)?.[0] ?? t.slice(0, 120)}"; Show before ${before ? "clicked" : "MISSING"}`;
    });
  },

  async "sweep-titles"(ctx) {
    let id = sweepState.a;
    if (id < 0) id = await startIn(ctx.cfg.dir, "bypassPermissions", "Reply with the single word: hello");
    const s0 = await waitFor("the chat's session", () => sessionOf(id), 30_000);
    const key = sessionKey(s0);
    const auto0 = displayTitle(s0);
    await step("titles: rename in the sidebar (double-click, type, Enter) pins it; header, tab and palette agree", async () => {
      const row = await waitFor("the sidebar row", () => document.querySelector(`[data-session-row="${CSS.escape(key)}"]`), 10_000);
      dbl(row.parentElement ?? row);
      const input = await waitFor("the name field", () => $("[data-title-input]") as HTMLInputElement | null, 3_000);
      setInput(input, "Sweep sidebar name");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const s = await waitFor("the manual title", () => useStore.getState().sessions.find((x) => sessionKey(x) === key && x.name?.source === "manual" && displayTitle(x) === "Sweep sidebar name"), 10_000);
      useStore.getState().open({ kind: "chat", id });
      await sleep(800);
      const header = textOf($("[data-session-title]"));
      await shot("sweep-title-sidebar");
      if (header !== "Sweep sidebar name") throw new Fail(`header shows "${header}"`);
      return `was "${auto0}"; now "${displayTitle(s)}" (${s.name?.source}); previous ${JSON.stringify(s.name?.previous)}`;
    });
    await step("titles: rename in the header; ⌘K finds the session by a previous title (was: …)", async () => {
      const h = await waitFor("the header title", () => $("[data-session-title]"), 5_000);
      dbl(h);
      const input = await waitFor("the name field", () => $("[data-title-input]") as HTMLInputElement | null, 3_000);
      setInput(input, "Sweep header name");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await waitFor("the header name", () => useStore.getState().sessions.find((x) => sessionKey(x) === key && displayTitle(x) === "Sweep header name"), 10_000);
      useStore.getState().setPalette(true);
      const pin = await waitFor("the palette input", () => $('input[placeholder^="Jump to a session"]') as HTMLInputElement | null, 3_000);
      setInput(pin, "Sweep sidebar");
      await sleep(700);
      await shot("sweep-title-palette");
      const hits = $all("[data-i]").map(textOf);
      useStore.getState().setPalette(false);
      const hit = hits.find((t) => /Sweep header name/.test(t) && /was/.test(t));
      if (!hit) throw new Fail(`palette rows for "Sweep sidebar": ${hits.slice(0, 5).join(" | ")}`);
      return `palette: "${hit}"`;
    });
    await step("titles: right-click > Use automatic title unpins it; renamed again for the restart check", async () => {
      const h = await waitFor("the header title", () => $("[data-session-title]"), 5_000);
      ctxMenu(h);
      const menu = await waitFor("the title menu", () => $("[data-title-menu]"), 3_000);
      await shot("sweep-title-menu", undefined, 300);
      const useAuto = button("Use automatic title", menu);
      if (!useAuto) throw new Fail(`menu: ${textOf(menu)}`);
      useAuto.click();
      const s = await waitFor("an automatic title", () => useStore.getState().sessions.find((x) => sessionKey(x) === key && x.name?.source !== "manual"), 10_000);
      const autoNow = displayTitle(s);
      await api().renameSession(s.provider, s.id, "Sweep survives restart");
      await waitFor("the restart name", () => useStore.getState().sessions.find((x) => sessionKey(x) === key && displayTitle(x) === "Sweep survives restart"), 10_000);
      await log(`TITLEKEY ${key}`);
      return `automatic again: "${autoNow}" (${s.name?.source}); renamed "Sweep survives restart" for the next launch`;
    });
  },

  async "sweep-titles-restart"() {
    await step("titles: after a restart the pinned name is still there, in the sidebar too", async () => {
      const s = await waitFor("the renamed session", () => useStore.getState().sessions.find((x) => displayTitle(x) === "Sweep survives restart"), 30_000);
      const row = document.querySelector(`[data-session-row="${CSS.escape(sessionKey(s))}"]`);
      await shot("sweep-title-restart");
      return `source ${s.name?.source}; sidebar row ${row ? `"${textOf(row).slice(0, 60)}"` : "not shown"}`;
    });
  },

  async "sweep-settings"(ctx) {
    const st = useStore.getState();
    const open = async (sec: Parameters<typeof st.openSettings>[0]) => {
      useStore.getState().openSettings(sec);
      await waitFor("the settings page", () => $("[data-settings-page]"), 5_000);
      await sleep(900);
    };
    await step("settings: General rows (confirm quit, prevent sleep, login item state, open with editors)", async () => {
      await open("general");
      await shot("sweep-settings-general");
      const rows = ["open-with", "confirm-quit", "prevent-sleep", "login"].map((a) => `${a}: ${textOf(settingRow(a)).slice(0, 160)}`);
      const apps = (await invoke("apps_installed").catch((e) => `err ${e}`)) as unknown;
      const login = await api().loginStatus().catch((e) => `err ${e}`);
      return `login status ${JSON.stringify(login)}; ${rows.join(" || ")}; installed apps ${JSON.stringify(apps).slice(0, 300)}`;
    });
    await step("settings: Notifications in this dev binary: the permission row says why, Send a test", async () => {
      await open("notifications");
      await shot("sweep-settings-notifications");
      const perm = await api().notifyPermission().catch((e) => `err ${e}`);
      let test = "no test button";
      const tb = button("Send a test");
      if (tb) {
        tb.click();
        await sleep(1500);
        test = `clicked; row now "${textOf(settingRow("notify-permission")).slice(0, 160)}"`;
      }
      const direct = await api().notifyTest().then(() => "ok", (e) => `error: ${e}`);
      return `permission ${JSON.stringify(perm)}; row "${textOf(settingRow("notify-permission")).slice(0, 200)}"; ${test}; notify_test: ${direct}`;
    });
    await step("settings: Prevent sleep holds one assertion while a chat works and releases it after", async () => {
      await open("general");
      const before = await api().powerStatus();
      const sw = switchIn(settingRow("prevent-sleep"));
      if (!sw) throw new Fail("no switch");
      if (sw.getAttribute("aria-checked") !== "true") sw.click();
      await sleep(800);
      const id = await startIn(ctx.cfg.dir, "bypassPermissions");
      await send(id, "Run exactly this Bash command in the foreground and nothing else: ping -c 20 127.0.0.1 > /dev/null . Then reply with: done");
      await waitFor("the chat working", () => chat(id)?.state !== "idle" && chat(id)?.turnStart, 30_000);
      await sleep(4000);
      const during = await api().powerStatus();
      await log("SLEEPCHECK during");
      await sleep(4000);
      await open("general");
      const rowDuring = textOf(settingRow("prevent-sleep"));
      await shot("sweep-settings-sleep-held");
      useStore.getState().open({ kind: "chat", id });
      await nextTurn(id, 0, 90_000);
      await sleep(3000);
      const after = await api().powerStatus();
      await log("SLEEPCHECK after");
      await sleep(4000);
      await open("general");
      const sw2 = switchIn(settingRow("prevent-sleep"));
      if (sw2?.getAttribute("aria-checked") === "true") sw2.click();
      await sleep(500);
      return `before ${JSON.stringify(before)}; during ${JSON.stringify(during)} row "${rowDuring.slice(0, 160)}"; after ${JSON.stringify(after)}`;
    });
    await step("settings: Text size changes the type scale", async () => {
      await open("appearance");
      const px = () => getComputedStyle(document.documentElement).getPropertyValue("--text-scale").trim();
      const out: string[] = [];
      for (const sz of ["larger", "small", "default"] as const) {
        setTextSize(sz);
        await sleep(400);
        out.push(`${sz}: --text-scale ${px()} body ${getComputedStyle(document.body).fontSize}`);
        if (sz === "larger") await shot("sweep-settings-text-larger");
      }
      return out.join("; ");
    });
    await step("settings: Git & worktrees lists the merged agent worktree; Remove… removes it safely", async () => {
      await open("git");
      const row = await waitFor("the agent-sweep worktree row", () => settingRow("worktree-agent-sweep"), 15_000);
      await sleep(500);
      await shot("sweep-settings-git");
      const t = textOf(row);
      const ask = document.querySelector('[data-ask="wt-remove-agent-sweep"]') as HTMLElement | null;
      if (!ask) throw new Fail(`no Remove… for a merged agent worktree: ${t}`);
      ask.click();
      const go = await waitFor("the confirm", () => document.querySelector('[data-confirm="wt-remove-agent-sweep"]') as HTMLElement | null, 3_000);
      await shot("sweep-settings-git-confirm", undefined, 300);
      go.click();
      await waitFor("the row gone", () => !settingRow("worktree-agent-sweep"), 15_000);
      await sleep(500);
      await shot("sweep-settings-git-removed");
      return `row "${t.slice(0, 200)}"; removed`;
    });
    await step("settings: Connections shows the folder's MCP server with its secret masked", async () => {
      await open("connections");
      const row = await waitFor("the weather server row", () => settingRow("mcp-claude-weather"), 15_000);
      row.scrollIntoView({ block: "center" });
      await sleep(600);
      await shot("sweep-settings-connections");
      const page = textOf($("[data-settings-page]"));
      const t = textOf(row);
      if (/sk-selftest|SECRET|fake-value/.test(page)) throw new Fail(`a secret shows: ${t}`);
      if (!/••••/.test(t)) throw new Fail(`nothing masked: ${t}`);
      return `"${t.slice(0, 260)}"`;
    });
    await step("settings: Storage lists sizes", async () => {
      await open("storage");
      await waitFor("sizes", () => $all("[data-storage-bytes]").length > 0, 20_000);
      await sleep(500);
      await shot("sweep-settings-storage");
      return $all("[data-setting^='storage-']").map((r) => textOf(r).slice(0, 90)).join(" | ");
    });
    await step("settings: Devices: Mac network state, Agent permissions list and revoke (a grant made in sweep-timeline)", async () => {
      await open("devices");
      await sleep(800);
      const net = textOf(settingRow("mac-network"));
      const grants = $all("[data-setting^='grants-']").map((r) => textOf(r).slice(0, 160));
      const perm = document.querySelector('[data-group="devices-permissions"]');
      perm?.scrollIntoView({ block: "center" });
      await sleep(400);
      await shot("sweep-settings-devices");
      let revoked = "nothing to revoke";
      const ask = perm?.querySelector("[data-ask]") as HTMLElement | null;
      if (ask) {
        const which = ask.dataset.ask;
        ask.click();
        const go = await waitFor("the confirm", () => perm?.querySelector(`[data-confirm="${which}"]`) as HTMLElement | null, 3_000);
        go.click();
        await sleep(1200);
        revoked = `revoked (${which}); now ${(await api().deviceGrants()).length ?? "?"} grants; rows: ${$all("[data-setting^='grants-']").map((r) => textOf(r).slice(0, 80)).join(" | ")}`;
      }
      return `network "${net.slice(0, 160)}"; grants [${grants.join(" | ")}]; ${revoked}`;
    });
    await step("settings: search finds rows across categories; Esc clears", async () => {
      await open("general");
      const box = (await waitFor("the search box", () => $("[data-settings-search]"), 3_000)) as HTMLInputElement;
      const box2 = box.tagName === "INPUT" ? box : (box.querySelector("input") as HTMLInputElement);
      setInput(box2, "sleep");
      await sleep(700);
      await shot("sweep-settings-search");
      const hits = $all("[data-setting]").map((r) => r.dataset.setting);
      setInput(box2, "zzzz nothing");
      await sleep(400);
      const none = textOf($("[data-settings-page]")).includes("Nothing matches");
      setInput(box2, "");
      if (!hits.includes("prevent-sleep")) throw new Fail(`"sleep" found ${hits.join(", ")}`);
      return `"sleep" -> ${hits.join(", ")}; nonsense -> Nothing matches ${none}`;
    });
    await step("settings: Open files and folders in an installed editor (Xcode here): the palette's Open opens the folder there", async () => {
      const apps = ((await invoke("apps_installed").catch(() => [])) as { id: string; name: string }[]) ?? [];
      const ed = apps.find((a) => a.id === "xcode") ?? apps.find((a) => !/terminal|iterm|ghostty|warp/i.test(a.id));
      if (!ed) return `no editor installed (found ${apps.map((a) => a.name).join(", ") || "none"})`;
      const prev = await api().prefsGet();
      await api().prefsSet({ ...prev, open_with: ed.id });
      try {
        await open("general");
        const row = textOf(settingRow("open-with"));
        await shot("sweep-settings-open-with", undefined, 300);
        useStore.getState().closeSettings();
        useStore.getState().setPalette(true);
        const pin = await waitFor("the palette input", () => $('input[placeholder^="Jump to a session"]') as HTMLInputElement | null, 3_000);
        setInput(pin, "open proj");
        await sleep(600);
        const hit = $all("[data-i]").find((r) => /Open proj in/.test(textOf(r)));
        await shot("sweep-palette-open-in", undefined, 0);
        if (!hit) {
          const rows = $all("[data-i]").map(textOf).slice(0, 6).join(" | ");
          useStore.getState().setPalette(false);
          throw new Fail(`no "Open proj in ${ed.name}" in the palette: ${rows}`);
        }
        hit.click();
        await log(`OPENED-IN ${ed.id}`);
        await sleep(6000);
        return `row "${row.slice(0, 120)}"; palette row "${textOf(hit)}" clicked (the shell side checks ${ed.name} has the folder open)`;
      } finally {
        useStore.getState().setPalette(false);
        await api().prefsSet({ ...(await api().prefsGet()), open_with: prev.open_with });
      }
    });
    useStore.getState().closeSettings();
  },

  async "sweep-usage"() {
    await step("usage: the rail ring and the rolling pill show real limits", async () => {
      await waitFor("a usage payload", () => (useStore.getState() as { usage?: { claude: unknown } }).usage?.claude, 30_000);
      const ring = await waitFor("the ring", () => $("[data-usage-ring]"), 10_000);
      const halves = [...ring.querySelectorAll("path[stroke-dasharray]")].map((p) => p.getAttribute("stroke-dasharray")?.split(" ")[0]);
      await shot("sweep-usage-rail-ring", undefined, 300);
      // Hover: React's pointer enter comes from pointerover.
      const btn = ring.closest("button")!;
      btn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
      btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await waitFor("the pill", () => $("[data-usage-pill]"), 5_000);
      await sleep(900);
      await shot("sweep-usage-pill", undefined, 0);
      const pills: string[] = [];
      const t = Date.now();
      while (Date.now() - t < 14_000) {
        const p = textOf($("[data-usage-pill]"));
        if (p && pills[pills.length - 1] !== p) pills.push(p);
        await sleep(250);
      }
      btn.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" }));
      btn.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      if (pills.length < 2) throw new Fail(`the pill didn't roll: ${pills.join(" → ") || "never showed"}`);
      return `ring halves (left of 100, 5-hour | weekly) ${halves.join(" | ")}; button "${btn.getAttribute("aria-label")}"; pill rolled through: ${pills.join(" → ")}`;
    });
    await step("usage: the Usage page, and Use a reset stops at its confirmation (never pressed for real)", async () => {
      useStore.getState().openSettings("usage");
      const page = await waitFor("the usage page", () => $("[data-settings-usage]") ?? $('[aria-label="Plan usage"]'), 5_000);
      await sleep(1200);
      await shot("sweep-usage-page");
      const prov = $all("[data-usage-provider]").map((p) => `${p.dataset.usageProvider}: ${textOf(p).slice(0, 200)}`);
      const open = $("[data-usage-reset-open]");
      let confirm = "no reset button (no free resets reported)";
      if (open) {
        open.click();
        const c = await waitFor("the confirmation", () => $("[data-usage-reset-confirm]"), 3_000);
        await sleep(400);
        await shot("sweep-usage-reset-confirm");
        confirm = `confirmation: "${textOf(c).slice(0, 240)}"`;
        const cancel = button(/Cancel|Keep|Not now/, c);
        if (!cancel) throw new Fail(`no way out of the confirmation: ${textOf(c)}`);
        cancel.click();
        await sleep(400);
        if ($("[data-usage-reset-confirm]")) throw new Fail("the confirmation stayed");
      }
      void page;
      return `${prov.join(" || ")}; ${confirm}; Claude no-reset line: ${textOf($("[data-usage-claude-no-reset]")).slice(0, 100)}`;
    });
    useStore.getState().closeSettings();
  },

  async "sweep-motion"(ctx) {
    let id = -1;
    const keep = (localStorage.getItem("coool.motion") as MotionPref | null) ?? "auto";
    await step("motion: a chat (bypass, no prompt) with the Browser panel", async () => {
      ({ id } = await gateChat(ctx, "claude", PERF_MODEL, "bypassPermissions"));
      return `chat ${id}`;
    });
    if (id < 0) return;
    const url = ((await invoke("selftest_probe_server")) as string).replace(/\/probe$/, "/form");
    try {
      for (const pref of ["off", "on", "auto"] as MotionPref[]) {
        await step(`motion: Reduce motion ${pref}: the beam and cursor while the Browser tools act`, async () => {
          setMotionPref(pref);
          await sleep(400);
          const nav = await browserTool(id, "browser_navigate", { url: `${url}?m=${pref}` });
          const add = idOf(nav.text, "button", "Add cup");
          const p = browserTool(id, "browser_click", { id: add });
          let seen = "";
          const end = Date.now() + 4000;
          while (Date.now() < end && !seen) {
            const beam = document.querySelector("[data-browser-driving]");
            if (beam) {
              const anims = ((beam as HTMLElement).getAnimations?.({ subtree: true }) ?? []).map((a) => `${(a as CSSAnimation).animationName ?? "?"}:${a.playState}`).join(",");
              seen = `beam ${beam.tagName.toLowerCase()} anims=${anims} static=${!!document.querySelector("[data-presence-static]")} reduce-class=${document.documentElement.classList.contains("reduce-motion")}`;
              await shot(`sweep-motion-${pref}`, undefined, 0);
            }
            await sleep(30);
          }
          await p;
          const cur = await pageCursors(id).catch(() => null);
          return `${seen || "no beam seen"}; page cursor ${cur}`;
        });
      }
    } finally {
      setMotionPref(keep);
      useStore.getState().closeBrowser(chatPanelKey(id));
    }
  },

  async "sweep-mac-input"(ctx) {
    const mac = (request: Record<string, unknown>) => invoke("selftest_mac", { request }) as Promise<Record<string, unknown>>;
    let id = -1;
    await step("mac-input: the Mac boots and shows in a chat's Mac panel with TextEdit open", async () => {
      const st = await api().macStatus();
      if (!st.installed) throw new Fail("no sandbox Mac installed");
      await api().macBoot();
      await mac({ cmd: "run", sh: "killall TextEdit 2>/dev/null; sleep 0.5; defaults write com.apple.TextEdit NSShowAppCentricOpenPanelInsteadOfUntitledFile -bool false; defaults write com.apple.TextEdit ApplePersistenceIgnoreState -bool true; defaults write com.apple.TextEdit RichText -bool false; rm -rf \"$HOME/Library/Containers/com.apple.TextEdit/Data/Library/Autosave Information\" \"$HOME/Library/Containers/com.apple.TextEdit/Data/Library/Saved Application State\"; open -a TextEdit; sleep 2; echo ok", timeout: 30 });
      ({ id } = await gateChat(ctx, "claude", PERF_MODEL, "bypassPermissions"));
      const key = await waitFor("the pane's panel key", activePanelKey, 10_000);
      useStore.getState().setRightPanel(key, "mac");
      await waitFor("the Mac panel running", () => $("[data-mac-screen]") && $('[data-mac-panel="running"]'), 90_000);
      await sleep(2500);
      await shot("sweep-mac-input-before");
      return `${st.os ?? ""} state was ${st.state}`;
    });
    if (id < 0) return;
    await step("mac-input: the person's own clicks and keys in the panel reach the Mac (typed text lands in TextEdit; a click moves the caret)", async () => {
      // Where TextEdit's text area is, from the backend's own read of the Mac (points of a W x H pt screen).
      const read = async () => (await invoke("selftest_mac_screen")) as string;
      const screen0 = await read();
      const size = /(\d+)x(\d+) pt/.exec(screen0);
      const area = screen0.split("\n").find((l) => /\btextarea\b/.test(l));
      const fr = area && /\((-?\d+),(-?\d+) (\d+)x(\d+)\)\s*$/.exec(area);
      if (!size || !fr) throw new Fail(`no TextEdit text area on screen:\n${screen0.slice(0, 1200)}`);
      const [W, H] = [Number(size[1]), Number(size[2])];
      const [ax, ay, aw, ah] = fr.slice(1).map(Number);
      const el = $("[data-mac-screen]")!;
      const c = el.querySelector("canvas")!.getBoundingClientRect();
      const at = (gx: number, gy: number) => ({ x: c.left + (gx / W) * c.width, y: c.top + (gy / H) * c.height });
      // Click in the middle of the document, type; then click at the very start of its first line and type again.
      const mid = at(ax + aw / 2, ay + ah / 2);
      await invoke("selftest_native", { ...mid, click: true, text: null });
      await sleep(700); // a person's first key comes a moment after the click
      await invoke("selftest_native", { ...mid, click: false, text: "hello coool 42" });
      await sleep(1200);
      const focused = document.activeElement === el;
      const doc1 = (await read()).split("\n").find((l) => /\btextarea\b/.test(l)) ?? "";
      const start = at(ax + 8, ay + 9);
      await invoke("selftest_native", { ...start, click: true, text: null });
      await sleep(700);
      await invoke("selftest_native", { ...start, click: false, text: "go " });
      await sleep(1200);
      await shot("sweep-mac-input-typed");
      const doc2 = (await read()).split("\n").find((l) => /\btextarea\b/.test(l)) ?? "";
      if (!/hello coool 42/.test(doc1)) throw new Fail(`typed text didn't land: ${doc1}; panel focused ${focused}`);
      if (!/value="go hello coool 42"/.test(doc2)) throw new Fail(`the second click didn't put the caret at the start: ${doc2}`);
      return `panel focused ${focused}; after typing: ${doc1.trim().slice(0, 100)}; after a click at the start and "go ": ${doc2.trim().slice(0, 100)}`;
    });
    await step("mac-input: TextEdit closed unsaved, panel closed", async () => {
      await mac({ cmd: "run", sh: "killall TextEdit 2>/dev/null; echo ok", timeout: 15 }).catch(() => null);
      useStore.getState().setRightPanel(chatPanelKey(id), "closed");
      return "ok";
    });
  },

  async "sweep-pilot-mac"(ctx) {
    const mac = (request: Record<string, unknown>) => invoke("selftest_mac", { request }) as Promise<Record<string, unknown>>;
    let id = -1;
    await step("pilot-mac: a Haiku chat with the Mac panel", async () => {
      await api().macBoot();
      await mac({ cmd: "run", sh: "killall TextEdit 2>/dev/null; killall Calculator 2>/dev/null; echo ok", timeout: 15 });
      ({ id } = await gateChat(ctx, "claude", PERF_MODEL, "bypassPermissions"));
      const key = await waitFor("the pane's panel key", activePanelKey, 10_000);
      useStore.getState().setRightPanel(key, "mac");
      await waitFor("the Mac panel running", () => $('[data-mac-panel="running"]'), 90_000);
      await sleep(1500);
      return `chat ${id}`;
    });
    if (id < 0) return;
    const r = await agentTurn(id, {
      prompt:
        'Call the coool-device tool pilot_run exactly once with target "mac", goal "Open the Calculator app", and success [{"text_visible":"Calculator"}]. Don\'t call any other coool-device tool. Then reply with the run\'s status and how many steps it took, one line.',
      marks: [["[data-sim-driving]", "sweep-pilot-mac-driving"]],
      probes: [{ name: "cursor", test: htmlCursor, shot: "sweep-pilot-mac-cursor" }],
      ms: 180_000,
    });
    await step("pilot-mac: pilot_run on the Mac ran, and what it returned", async () => {
      const runs = pilotRuns(r);
      await shot("sweep-pilot-mac-after");
      const screen = ((await invoke("selftest_mac_screen").catch((e) => `err ${e}`)) as string).split("\n")[0];
      if (!runs.length) throw new Fail(`no pilot_run; tools ${r.all.join(", ")}; reply ${r.reply}`);
      const o = runs[0].out;
      return `${o ? pilotLine(o) : runs[0].tool.output.slice(0, 300)}; screen: ${screen}; reply ${JSON.stringify(r.reply.slice(0, 160))}; cursor ${r.seen.cursor ?? "never"} ms, beam ${r.seen["[data-sim-driving]"] ?? "never"} ms`;
    });
    await mac({ cmd: "run", sh: "killall Calculator 2>/dev/null; echo ok", timeout: 15 }).catch(() => null);
    useStore.getState().setRightPanel(chatPanelKey(id), "closed");
  },

  async "sweep-composer"(ctx) {
    await step("composer: the hint row never wraps or clips while a turn runs, at any pane width", async () => {
      const id = await startIn(ctx.cfg.dir, "bypassPermissions");
      await send(id, "Run exactly this Bash command in the foreground and nothing else: ping -c 25 127.0.0.1 > /dev/null . Then reply with: done");
      await waitFor("working", () => chat(id)?.turnStart, 30_000);
      const key = await waitFor("the pane's panel key", activePanelKey, 10_000);
      const out: string[] = [];
      for (const [w, panel] of [[1440, "closed"], [1440, "browser"], [1100, "browser"], [960, "closed"]] as const) {
        await invoke("selftest_resize", { width: w, height: 900 });
        if (panel === "browser") useStore.getState().openBrowser(key, { kind: "start" });
        else useStore.getState().setRightPanel(key, "closed");
        await sleep(900);
        const comp = composer().closest(".composer-dock") as HTMLElement | null;
        const hint = ($("[data-steer-hint]") ?? $("[data-steer-hint-short]")) as HTMLElement | null;
        const row = hint?.parentElement;
        const bad = hint && (hint.getBoundingClientRect().height > 30 || hint.scrollWidth > hint.clientWidth + 1 || (row && hint.getBoundingClientRect().right > row.getBoundingClientRect().right + 1));
        const name = `sweep-composer-${w}-${panel}`;
        await shot(name, undefined, 200);
        out.push(`${w}/${panel}: composer ${Math.round(comp?.getBoundingClientRect().width ?? 0)}px, hint ${hint ? `"${textOf(hint)}" h=${Math.round(hint.getBoundingClientRect().height)}` : "hidden"}${bad ? " BROKEN" : ""}`);
      }
      await invoke("selftest_resize", { width: 1440, height: 900 });
      useStore.getState().setRightPanel(key, "closed");
      await nextTurn(id, 0, 60_000).catch(() => null);
      const broken = out.filter((o) => o.includes("BROKEN"));
      if (broken.length) throw new Fail(out.join("; "));
      return out.join("; ");
    });
  },

  /** Reduce motion Off for the scenarios after it (the beam at full strength); `sweep-motion-auto` puts Auto back. */
  async "sweep-motion-off"() {
    setMotionPref("off");
    await log(`INFO Reduce motion Off (reduce-motion class ${document.documentElement.classList.contains("reduce-motion")})`);
  },
  async "sweep-motion-auto"() {
    setMotionPref("auto");
    await log("INFO Reduce motion Auto");
  },

  async "sweep-noconfirm"() {
    await step("Confirm before quitting off: ⌘Q with a chat working quits at once (no sheet)", async () => {
      const p = await api().prefsGet();
      await api().prefsSet({ ...p, confirm_quit: false });
      const running = Object.values(useChats.getState().chats).filter((c) => c.running).length;
      await log(`SUMMARY pass=${pass + 1} fail=${fail}`);
      await log(`QUITTING-NOCONFIRM (${running} chats running)`);
      await invoke("selftest_request_quit");
      await sleep(4000);
      throw new Fail(`still running; sheet ${!!$("[data-quit-sheet]")} ${textOf(document.querySelector('[role="dialog"]')).slice(0, 120)}`);
    });
  },
};
/** The session key the Needs you page lists chat `id` under, once discovery linked them. */
const needsKeyOf = (id: number) => {
  const s = useStore.getState().sessions.find((x) => x.chat === id);
  return s ? sessionKey(s) : null;
};
/** Opens the Needs you page on chat `id`'s item and returns its detail once it shows `kind`. */
async function needsDetail(id: number, kind: string, ms = 90_000): Promise<HTMLElement> {
  const key = await waitFor("the chat's session (for its Needs you item)", () => needsKeyOf(id), ms);
  useStore.getState().openNeeds(key);
  return waitFor(`the Needs you page showing a ${kind}`, () => $all("[data-needs-detail]").find((d) => d.dataset.needsDetail === key && d.dataset.needsDetailKind === kind) ?? null, ms);
}

/**
 * `needs`: the Needs you page against a real Claude Haiku chat in Ask mode (`default`). A Write request shows with its
 * file and the person's prompt as context, and Allow on the page runs it; a command shows whole with Deny, which
 * returns the denial; an Edit shows its diff and is allowed from the page; a question is answered from the page.
 * Each answered item leaves the list; Mission control has no Needs-you strip; Esc goes back. A few cents of Haiku.
 */
const needsScenarios: Record<string, (ctx: Ctx) => Promise<void>> = {
  async needs(ctx) {
    let id = -1;
    await step("needs: a Write request shows on the page with its file and the prompt; Allow there runs it and the turn goes on", async () => {
      id = await startIn(ctx.cfg.dir, "default");
      const prompt = "Use the Write tool to create the file needs-a.txt containing the text owls. Do nothing else, then reply with one word: done";
      const n = turnEnds(id).length;
      await send(id, prompt);
      await waitFor("the pending write", () => chat(id)?.pendingPermission, 90_000);
      if ($("[data-mc-needs]")) throw new Fail("a Needs-you strip on Home");
      const d = await needsDetail(id, "write");
      const why = textOf(d.querySelector("[data-needs-why]"));
      const facts = textOf(d.querySelector("[data-needs-facts]"));
      if (!/needs-a\.txt/.test(textOf(d))) throw new Fail(`no file in the detail: ${textOf(d).slice(0, 200)}`);
      if (!/create the file needs-a\.txt/.test(why)) throw new Fail(`no prompt in "why": ${why.slice(0, 200)}`);
      if (!/Ask/.test(facts)) throw new Fail(`permission mode not shown: ${facts.slice(0, 200)}`);
      const row = $(`[data-needs-item="${CSS.escape(needsKeyOf(id)!)}"]`);
      if (!row || row.getAttribute("aria-selected") !== "true") throw new Fail("the item isn't selected in the list");
      await shot("needs-write");
      (d.querySelector("[data-allow-once]") as HTMLElement).click();
      const end = await nextTurn(id, n, 120_000);
      const tool = (items(id).filter((i) => i.kind === "tool") as Tool[]).find((t) => t.name === "Write");
      if (!tool || tool.ok === false) throw new Fail(`the Write didn't run: ${tool?.output.slice(0, 160)}`);
      await waitFor("the item to leave the list", () => !$(`[data-needs-item="${CSS.escape(needsKeyOf(id)!)}"]`), 10_000);
      return `title "${textOf(d.querySelector("h1"))}"; why: ${why.slice(0, 140)}; turn ${end.ok ? "ok" : "not ok"}`;
    });
    await step("needs: a command shows whole on the page; Deny there returns the denial to the agent", async () => {
      const n = turnEnds(id).length;
      await send(id, "Run exactly this one Bash command and nothing else: echo needs-check > needs-b.txt . If it is denied, reply with one word: denied");
      await waitFor("the pending command", () => chat(id)?.pendingPermission, 90_000);
      const d = await needsDetail(id, "command");
      const cmd = textOf(d.querySelector("[data-needs-command]"));
      if (!/echo needs-check > needs-b\.txt/.test(cmd)) throw new Fail(`command: ${cmd}`);
      await shot("needs-command");
      (d.querySelector("[data-deny]") as HTMLElement).click();
      await nextTurn(id, n, 120_000);
      const tool = (items(id).filter((i) => i.kind === "tool") as Tool[]).filter((t) => t.name === "Bash").pop();
      if (!tool || tool.ok !== false) throw new Fail(`the command wasn't denied: ${tool?.output.slice(0, 160)}`);
      return `"${cmd}" denied: ${tool.output.slice(0, 100)}`;
    });
    await step("needs: an Edit shows its word diff on the page; Allow there applies it", async () => {
      const n = turnEnds(id).length;
      await send(id, "Use the Edit tool to change the word owls to larks in needs-a.txt. Do nothing else, then reply with one word: done");
      await waitFor("the pending edit", () => chat(id)?.pendingPermission, 90_000);
      const d = await needsDetail(id, "edit");
      const diff = d.querySelector("[data-mc-diff]");
      const ins = [...(diff?.querySelectorAll("ins") ?? [])].map(textOf).join(",");
      const del = [...(diff?.querySelectorAll("del") ?? [])].map(textOf).join(",");
      if (!/larks/.test(ins) || !/owls/.test(del)) throw new Fail(`diff: +[${ins}] -[${del}]`);
      const steps = textOf(d.querySelector("[data-needs-steps]"));
      await shot("needs-edit");
      (d.querySelector("[data-allow-once]") as HTMLElement).click();
      await nextTurn(id, n, 120_000);
      const tool = (items(id).filter((i) => i.kind === "tool") as Tool[]).filter((t) => t.name === "Edit").pop();
      if (!tool || tool.ok === false) throw new Fail(`the Edit didn't run: ${tool?.output.slice(0, 160)}`);
      return `+[${ins}] -[${del}]; steps: ${steps.slice(0, 120) || "(none)"}`;
    });
    await step("needs: a question is answered from the page; Esc goes back", async () => {
      const n = turnEnds(id).length;
      await send(id, "Use the AskUserQuestion tool exactly once to ask me which colour I prefer, with the options Red and Blue (single choice). After I answer, reply with only the colour I picked.");
      await waitFor("the pending question", () => chat(id)?.pendingQuestion, 90_000);
      const d = await needsDetail(id, "question");
      await shot("needs-question");
      const blue = d.querySelector('[data-option="Blue"]') as HTMLElement | null;
      if (!blue) throw new Fail(`no Blue option: ${textOf(d).slice(0, 200)}`);
      blue.click();
      await nextTurn(id, n, 120_000);
      const t = lastText(id)?.text ?? "";
      if (!/blue/i.test(t)) throw new Fail(`reply: ${t.slice(0, 80)}`);
      await waitFor("the empty state or another item", () => !$(`[data-needs-detail="${CSS.escape(needsKeyOf(id)!)}"]`), 10_000);
      await shot("needs-after");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await sleep(400);
      if (useStore.getState().needsPage) throw new Fail("Esc didn't close the page");
      return `answered Blue; reply "${t.trim().slice(0, 30)}"`;
    });
  },
};
Object.assign(scenarios, needsScenarios);

const fmtTokensLocal = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`);
Object.assign(scenarios, sweep);

// ---------- the first-run onboarding (components/onboarding/) ----------
//
// `onboarding` (no model; a fresh test folder, so its settings file has no "seen" flag): it opens by itself, walks the
// steps with the keyboard, checks the macOS states render honestly WITHOUT pressing Allow or the login switch (a build
// without an app bundle reports them unavailable / not found; nothing on this Mac changes), dismisses it, checks the
// flag was saved, re-opens it from Settings > About and the palette's entry, and finishes on Home.
// `onboarding-restart` (a second launch on the same folder): it stays closed, the flag survived. Only these scenarios
// see the onboarding at all; every other run counts it as seen (`onboarding_seen`).

const onb = () => $("[data-onboarding]")?.dataset.onboarding ?? null;
const winKey = (key: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
const onboarding: Record<string, (ctx: Ctx) => Promise<void>> = {
  async onboarding() {
    await step("onboarding: opens by itself on a first launch, on the folder step", async () => {
      await waitFor("the onboarding", () => onb() === "folder", 10_000);
      await waitFor("the CLI lines", () => $all("[data-onb-cli]").every((e) => e.dataset.found !== ""), 10_000);
      const env = useStore.getState().env;
      const lines = $all("[data-onb-cli]").map((e) => `${e.dataset.onbCli}=${e.dataset.found} "${textOf(e)}"`);
      for (const e of $all("[data-onb-cli]")) {
        const p = e.dataset.onbCli as "claude" | "codex";
        if (String(!!env?.[p]) !== e.dataset.found) throw new Fail(`${p} line says ${e.dataset.found}, environment says ${env?.[p]}`);
      }
      await shot("onb-1-folder");
      return lines.join("; ");
    });
    await step("onboarding: a known project is one click, Enter continues to Notifications", async () => {
      const chip = $("[data-onb-projects] button");
      if (chip) {
        chip.click();
        await waitFor("the folder", () => $("[data-onb-folder]")?.dataset.onbFolder || null, 2_000);
      }
      ($("#onb-title") as HTMLElement | null)?.focus();
      winKey("Enter");
      await waitFor("the notifications step", () => onb() === "notifications", 3_000);
      return chip ? `picked ${$("[data-onb-folder]")?.dataset.onbFolder ?? "?"}` : "no known projects in the test folder";
    });
    await step("onboarding: Notifications says where the permission stands (not pressed)", async () => {
      const st = await waitFor("the permission", () => $("[data-onb-notify]")?.dataset.onbNotify || null, 5_000);
      const text = textOf($("[data-onb-notify]"));
      await shot("onb-2-notify");
      // A self-test build has no app bundle: the honest answer is "unavailable" and no Allow button.
      if (st === "unavailable" && $("[data-onb-allow]")) throw new Fail("an Allow button for an unavailable permission");
      if (st === "not_determined" && !$("[data-onb-allow]")) throw new Fail("no Allow button while macOS hasn't asked");
      if (st === "denied" && !$("[data-onb-open-settings]")) throw new Fail("no Open System Settings when denied");
      return `${st}: ${text}`;
    });
    await step("onboarding: Esc skips to Open at login, which says why its switch can't work here (not pressed)", async () => {
      winKey("Escape");
      await waitFor("the login step", () => onb() === "login", 3_000);
      const st = await waitFor("the login status", () => $("[data-onb-login]")?.dataset.onbLogin || null, 5_000);
      const sw = $("[data-onb-login] [role=switch]") as HTMLButtonElement | null;
      await shot("onb-3-login");
      if ((st === "not_found" || st === "unavailable") && !sw?.disabled) throw new Fail(`switch enabled for ${st}`);
      return `${st}, switch ${sw?.disabled ? "disabled" : "enabled"}: ${textOf($("[data-onb-login]"))}`;
    });
    await step("onboarding: Esc to the finish step, Back works, Skip setup dismisses it and saves the flag", async () => {
      winKey("Escape");
      await waitFor("the finish step", () => onb() === "done", 3_000);
      await shot("onb-4-done");
      $("[data-onb-back]")!.click();
      await waitFor("back on login", () => onb() === "login", 3_000);
      $("[data-onb-dismiss]")!.click();
      await waitFor("it to close", () => !$("[data-onboarding]"), 3_000);
      await sleep(300);
      if (!(await api().onboardingSeen())) throw new Fail("the flag wasn't saved");
      return "seen=true";
    });
    await step("onboarding: Settings > About re-opens it at the first step; Esc on the finish step returns to Settings", async () => {
      useStore.getState().openSettings("about");
      const again = await waitFor("Show onboarding again", () => $("[data-onboarding-again]"), 5_000);
      await shot("onb-5-about");
      again.click();
      await waitFor("the folder step", () => onb() === "folder", 3_000);
      winKey("Escape");
      winKey("Escape");
      winKey("Escape");
      await waitFor("the finish step", () => onb() === "done", 3_000);
      winKey("Escape");
      await waitFor("it to close", () => !$("[data-onboarding]"), 3_000);
      if (useStore.getState().settings === null) throw new Fail("Settings closed with it");
    });
    await step("onboarding: the palette's entry opens it; ⌘K waits while it is up; Go to Home lands on Home", async () => {
      useStore.getState().closeSettings();
      useStore.getState().setPalette(true);
      const input = await waitFor("the palette", () => $("input[placeholder^='Jump']") as HTMLInputElement | null, 3_000);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "onboarding again");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(200);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await waitFor("the folder step", () => onb() === "folder", 3_000);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", metaKey: true, bubbles: true, cancelable: true }));
      await sleep(300);
      if (useStore.getState().palette) throw new Fail("⌘K opened the palette over the onboarding");
      $("[data-onb-skip]")!.click(); // the folder step skipped: no folder, so the end is Home
      await waitFor("notifications", () => onb() === "notifications", 3_000);
      $("[data-onb-skip]")!.click();
      await waitFor("login", () => onb() === "login", 3_000);
      $("[data-onb-skip]")!.click();
      await waitFor("done", () => onb() === "done", 3_000);
      const label = textOf($("[data-onb-next]"));
      if (!label.startsWith("Go to Home")) throw new Fail(`finish button says "${label}"`);
      $("[data-onb-next]")!.click();
      await waitFor("it to close", () => !$("[data-onboarding]"), 3_000);
      const st = useStore.getState();
      if (st.sheet) throw new Fail(`a ${st.sheet.kind} sheet opened`);
      await shot("onb-6-home");
      return `active tab ${st.activeTab ?? "none (Home)"}`;
    });
    await step("onboarding: the flag is in the test folder's settings file", async () => {
      const seen = await api().onboardingSeen();
      if (!seen) throw new Fail("not saved");
      return "seen=true";
    });
  },

  async "onboarding-restart"() {
    await step("onboarding-restart: a second launch keeps it closed (the flag survived)", async () => {
      await sleep(4000);
      if ($("[data-onboarding]")) throw new Fail("it opened again");
      if (!(await api().onboardingSeen())) throw new Fail("the flag is gone");
      await shot("onb-7-restart");
      return "closed, seen=true";
    });
  },
};
Object.assign(scenarios, onboarding);

// ---------- the sandbox Mac: a clean boot, the pilot driven directly, click-then-type ----------

const macReq = (request: Record<string, unknown>) => invoke("selftest_mac", { request }) as Promise<Record<string, unknown>>;
const macSh = async (sh: string, timeout = 30) => String(((await macReq({ cmd: "run", sh, timeout })) as { output?: string }).output ?? "");
/** The guest's screen as the host helper reads it (OCR): its words, and a JPEG of it saved as `<shots>/mac-<name>.jpg`. */
async function macScreen(ctx: Ctx, name?: string): Promise<string[]> {
  if (name) await invoke("selftest_vm", { request: { cmd: "screenshot", path: `${ctx.cfg.shots}/mac-${name}.jpg`, quality: 0.85 } }).catch((e) => log(`WARN mac screenshot ${name}: ${e}`));
  const r = (await invoke("selftest_vm", { request: { cmd: "ocr" } })) as { items?: { text: string }[] };
  return (r.items ?? []).map((i) => i.text);
}
const BANNER = /can run in the|Background Activity|Background Items/i;
/** A chat on screen (bypass, no prompt) with its Mac panel running. */
async function macChat(ctx: Ctx): Promise<number> {
  await api().macBoot();
  const { id, key } = await gateChat(ctx, "claude", PERF_MODEL, "bypassPermissions");
  useStore.getState().setRightPanel(key, "mac");
  await waitFor("the Mac panel running", () => $("[data-mac-screen]") && $('[data-mac-panel="running"]'), 120_000);
  await sleep(1500);
  return id;
}
/** Answers coool's device gate for chat `id` while `p` runs ("this chat" for using a device, Allow once otherwise). */
async function answeringGate<T>(p: Promise<T>): Promise<T> {
  const done = new Set<string>();
  const t = setInterval(() => {
    const dev = $("[data-device-approval]");
    const rid = dev?.dataset.approval ?? "";
    if (!dev || done.has(rid)) return;
    done.add(rid);
    const kind = dev.dataset.deviceApproval ?? "";
    void log(`INFO device ask ${kind}: ${textOf(dev).slice(0, 160)}`);
    const b = kind === "use" || kind === "site" ? (dev.querySelector('[data-remember="chat"]') as HTMLElement | null) : button("Allow once", dev);
    (b ?? button("Allow once", dev))?.click();
  }, 100);
  try {
    return await p;
  } finally {
    clearInterval(t);
  }
}

/** Screenshots while `run` drives a panel (its beam on): at a few moments of the beam's loop, as `<name>-<n>`. */
async function beamShots(name: string, run: Promise<unknown>, sel = "[data-sim-driving]"): Promise<string> {
  const st = { done: false };
  void run.finally(() => (st.done = true));
  const t = Date.now();
  while (!st.done && !$(sel) && Date.now() - t < 30_000) await sleep(50);
  if (!$(sel)) return "never drove";
  const seen = Date.now() - t;
  const shots: number[] = [];
  // The package's loop is about 2 s: 0.3, 0.8, 1.3, 1.9 s after the beam came on.
  for (const at of [300, 800, 1300, 1900]) {
    const wait = t + seen + at - Date.now();
    if (wait > 0) await sleep(wait);
    if (!$(sel)) break;
    await shot(`${name}-${shots.length + 1}`, undefined, 0);
    shots.push(at);
    if (shots.length === 1) {
      const b = document.querySelector(`${sel} [data-presence-beam]`) as HTMLElement | null;
      if (b) {
        const a = getComputedStyle(b, "::after");
        const r = b.getBoundingClientRect();
        await log(`INFO beam ${Math.round(r.width)}x${Math.round(r.height)} active=${b.hasAttribute("data-active")} after: opacity ${a.opacity} padding ${a.padding} filter ${a.filter.slice(0, 80)} bg ${a.backgroundImage.slice(0, 300)}`);
      } else await log("INFO beam: no [data-presence-beam] inside the driving frame");
    }
  }
  await run.catch(() => null);
  return `beam after ${seen} ms; ${shots.length} shots`;
}
const themeButton = () => ([...document.querySelectorAll("button[aria-label]")] as HTMLElement[]).find((x) => / theme$/.test(x.getAttribute("aria-label") ?? "")) ?? null;

const fix2: Record<string, (ctx: Ctx) => Promise<void>> = {
  /** The beam around the iPhone and the Mac while the pilot drives them, Reduce motion Off, in both themes. */
  async "beam-shots"(ctx) {
    const keep = (localStorage.getItem("coool.motion") as MotionPref | null) ?? "auto";
    setMotionPref("off");
    let udid = "";
    try {
      for (const theme of ["first", "second"]) {
        if (theme === "second") {
          themeButton()?.click();
          await sleep(800);
        }
        const dark = document.documentElement.dataset.theme !== "light";
        const tag = dark ? "dark" : "light";
        await step(`beam-shots: the iPhone, ${tag}`, async () => {
          if (!udid) {
            udid = await api().simEnsureDevice();
            await api().simBoot(udid);
          }
          const { id, key } = await gateChat(ctx, "claude", PERF_MODEL, "bypassPermissions");
          useStore.getState().setRightPanel(key, "device");
          await waitFor("the booted device", () => $(`[data-sim-screen="${udid}"]`) && $('[data-device-panel="Booted"]'), 90_000);
          await sleep(3000);
          const run = answeringGate(invoke("selftest_pilot", { chat: id, args: { target: "iphone", app: "com.apple.Preferences", goal: "Open General, then About", success: [{ text_visible: "iOS Version" }] } }) as Promise<string>);
          const r = await beamShots(`beam-iphone-${tag}`, run);
          useStore.getState().setRightPanel(key, "closed");
          return r;
        });
        await step(`beam-shots: the Mac, ${tag}`, async () => {
          await macSh("killall Calculator 2>/dev/null; echo ok").catch(() => "");
          const id = await macChat(ctx);
          const run = answeringGate(invoke("selftest_pilot", { chat: id, args: { target: "mac", goal: "Open the Calculator app, then type 12+34= on its keypad", success: [{ text_visible: "46" }], max_steps: 12 } }) as Promise<string>);
          const r = await beamShots(`beam-mac-${tag}`, run);
          useStore.getState().setRightPanel(chatPanelKey(id), "closed");
          return r;
        });
      }
      themeButton()?.click();
    } finally {
      setMotionPref(keep);
      await macSh("killall Calculator 2>/dev/null; echo ok").catch(() => "");
      if (udid) await invoke("selftest_sim_delete").catch(() => null);
    }
  },
  /** Two real Haiku chats edit notes.txt (the folder: a git repo with it): the overlap row, clicked, lists both authors. */
  async "mc-overlap"(ctx) {
    await step("mc-overlap: a click anywhere on the overlap row expands its author rows; again collapses; its text (a button) does too", async () => {
      const dir = ctx.cfg.dir;
      const a = await startIn(dir, "bypassPermissions");
      await turn(a, "Use the Edit tool to append a new last line 'Cats are calm.' to notes.txt. Do nothing else, then reply with: done");
      const b = await startIn(dir, "bypassPermissions");
      await turn(b, "Use the Edit tool to append a new last line 'Owls are wise.' to notes.txt. Do nothing else, then reply with: done");
      home();
      const row = await waitFor("the overlap row", () => (onTab("proj"), $("[data-mc-overlap]")), 30_000);
      await sleep(800);
      const n = () => $all("[data-mc-overlap-edit]").length;
      const out: string[] = [`row "${textOf(row)}"`];
      // The row itself (its padding, where the time is), as the sweep clicked it.
      row.click();
      await sleep(700);
      out.push(`row click: ${n()} author rows`);
      await shot("mc-overlap-open");
      const opened = n();
      row.click();
      await sleep(700);
      const closed = n();
      out.push(`again: ${closed}`);
      (row.querySelector("[data-mc-overlap-toggle]") as HTMLElement).click();
      await sleep(700);
      const viaText = n();
      out.push(`its text: ${viaText}`);
      out.push(`rows: ${$all("[data-mc-overlap-edit]").map(textOf).join(" | ").slice(0, 200)}`);
      if (opened < 2 || closed !== 0 || viaText < 2) throw new Fail(out.join("; "));
      return out.join("; ");
    });
  },
  /** The Mac's status, a boot, and the status after (for a Mac that won't come up). */
  async "mac-status"(ctx) {
    await step("mac-status: status, boot, status", async () => {
      const s0 = JSON.stringify(await api().macStatus());
      await log(`INFO before: ${s0}`);
      const t = Date.now();
      const r = await invoke("mac_boot").then((v) => `ok ${JSON.stringify(v)}`, (e) => `ERR ${e}`);
      await log(`INFO boot after ${Date.now() - t} ms: ${r}`);
      await macScreen(ctx, "status").catch(() => []);
      const ping = await macReq({ cmd: "ping" }).then((v) => JSON.stringify(v), (e) => `ERR ${e}`);
      return `boot: ${r}; ping ${ping}; after: ${JSON.stringify(await api().macStatus())}`;
    });
  },
  /** A cold boot of the sandbox Mac: no "can run in the background" banners on its screen. */
  async "mac-clean-boot"(ctx) {
    await step("mac-clean-boot: from shut down, a boot shows no background-item banners", async () => {
      const st = await api().macStatus();
      if (!st.installed) throw new Fail("no sandbox Mac installed");
      if (st.state === "running") {
        await api().macShutdown();
        for (let i = 0; i < 90 && (await api().macStatus()).state !== "stopped"; i++) await sleep(1000);
      }
      const t = Date.now();
      await api().macBoot();
      const bootMs = Date.now() - t;
      const out: string[] = [];
      // Banners post a few seconds after login: look at once, then for 20 s.
      for (const at of [0, 5_000, 12_000, 20_000]) {
        const wait = t + bootMs + at - Date.now();
        if (wait > 0) await sleep(wait);
        const words = await macScreen(ctx, `boot-${at / 1000}s`);
        const hits = words.filter((w) => BANNER.test(w));
        out.push(`+${at / 1000}s: ${hits.length ? hits.join(" | ") : "none"}`);
        if (hits.length) throw new Fail(`banners on screen after boot (${bootMs} ms): ${out.join("; ")}`);
      }
      return `booted in ${bootMs} ms; banners ${out.join("; ")}`;
    });
  },

  /**
   * An agent update as macOS sees it: re-signs the installed agent, with or without the hardened-runtime flag,
   * whichever it hasn't (a new cdhash; the same identifier and designated requirement, so its Accessibility grant
   * stays), and restarts it. The next launch's `mac-clean-boot` shows whether the reboot brought a new "can run in the
   * background" alert (coool's stderr says "closed N agent alert(s)" when it closed any).
   */
  async "mac-btm-resign"() {
    await step("mac-btm-resign: the agent re-signed (a new cdhash) and restarted, still trusted, run by /bin/sh", async () => {
      await api().macBoot();
      const APP = "\"$HOME/Library/Application Support/coool/coool agent.app\"";
      const before = await macSh(`codesign -dvvv ${APP} 2>&1 | grep -E 'CDHash=|^CodeDirectory'`);
      const flag = /runtime/.test(before) ? "" : "-o runtime";
      await macSh(`codesign -s - -f ${flag} -i sh.coool.vm-agent -r='designated => identifier "sh.coool.vm-agent"' ${APP} >/dev/null 2>&1; (sleep 1; launchctl kickstart -k gui/$(id -u)/sh.coool.vm-agent) >/dev/null 2>&1 &`);
      // launchd restarts a job that ran under 10 s only after a pause.
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        if (await macReq({ cmd: "ping" }).then(() => true, () => false)) break;
      }
      const after = await macSh(`codesign -dvvv ${APP} 2>&1 | grep -E 'CDHash=|^CodeDirectory'; launchctl print gui/$(id -u)/sh.coool.vm-agent 2>&1 | grep -E 'program =|state =' | head -2`);
      const ping = await macReq({ cmd: "ping" });
      const hash = (s: string) => /CDHash=(\w+)/.exec(s)?.[1];
      if (hash(before) === hash(after)) throw new Fail(`the cdhash didn't change: ${after}`);
      if (ping.trusted !== true) throw new Fail(`the agent lost Accessibility: ${JSON.stringify(ping)}`);
      return `before ${before.replace(/\s+/g, " ")}; after ${after.replace(/\s+/g, " ")}; trusted ${ping.trusted}`;
    });
  },

  /**
   * The person's click into the Mac panel and their keys right after it (`selftest_native`: a trusted click and the
   * keys in one go, microseconds apart), ten times: each word lands whole, in order, at the end of TextEdit's document.
   */
  async "mac-click-type"(ctx) {
    let id = -1;
    await step("mac-click-type: TextEdit with an empty document in a chat's Mac panel", async () => {
      await api().macBoot();
      await macSh("killall TextEdit 2>/dev/null; sleep 0.5; defaults write com.apple.TextEdit NSShowAppCentricOpenPanelInsteadOfUntitledFile -bool false; defaults write com.apple.TextEdit ApplePersistenceIgnoreState -bool true; defaults write com.apple.TextEdit RichText -bool false; rm -rf \"$HOME/Library/Containers/com.apple.TextEdit/Data/Library/Autosave Information\" \"$HOME/Library/Containers/com.apple.TextEdit/Data/Library/Saved Application State\"; open -a TextEdit; sleep 2; echo ok");
      id = await macChat(ctx);
      await sleep(1000);
      return `chat ${id}`;
    });
    if (id < 0) return;
    const read = async () => (await invoke("selftest_mac_screen")) as string;
    const s0 = await read();
    const size = /(\d+)x(\d+) pt/.exec(s0);
    const area = s0.split("\n").find((l) => /\btextarea\b/.test(l));
    const fr = area && /\((-?\d+),(-?\d+) (\d+)x(\d+)\)\s*$/.exec(area);
    if (!size || !fr) {
      await step("mac-click-type: the document is on screen", async () => {
        throw new Fail(`no TextEdit text area:\n${s0.slice(0, 1000)}`);
      });
      return;
    }
    const [W, H] = [Number(size[1]), Number(size[2])];
    const [ax, ay, aw, ah] = fr.slice(1).map(Number);
    const c = $("[data-mac-screen]")!.querySelector("canvas")!.getBoundingClientRect();
    const at = (gx: number, gy: number) => ({ x: c.left + (gx / W) * c.width, y: c.top + (gy / H) * c.height });
    // Below the last line: the caret goes to the end of the text. Alternate sides, so every click moves the pointer.
    const points = [at(ax + aw * 0.75, ay + ah - 12), at(ax + aw * 0.25, ay + ah - 30)];
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
    // The last two words typed: the document (TextEdit can bring back an earlier untitled one, and a long value is
    // shortened in the read) must end with them, whole and in order.
    let want = "";
    let ok = 0;
    const out: string[] = [];
    for (let n = 0; n < words.length; n++) {
      const w = `${words[n]}${n} `;
      const t = performance.now();
      await invoke("selftest_native", { ...points[n % 2], click: true, text: w });
      const ms = performance.now() - t;
      want = `${want.split(" ").filter(Boolean).slice(-1).join(" ")} ${w}`.trimStart();
      // The document as the Mac has it, once its keys have landed.
      let doc = "";
      const lands = () => doc.trimEnd().endsWith(want.trimEnd()) && (n === 0 || doc.trimEnd().length > want.trimEnd().length || doc.trimEnd() === want.trimEnd());
      for (let i = 0; i < 20; i++) {
        await sleep(150);
        doc = /value="([^"]*)"/.exec((await read()).split("\n").find((l) => /\btextarea\b/.test(l)) ?? "")?.[1] ?? "";
        if (lands()) break;
      }
      const good = lands();
      if (good) ok++;
      else want = doc.split(" ").filter(Boolean).slice(-1).join(" "); // go on from what the document holds
      out.push(`${n + 1}:${good ? "ok" : `LOST (doc ends "${doc.slice(-24)}")`} ${ms.toFixed(1)}ms`);
    }
    await shot("mac-click-type", undefined, 300);
    await step(`mac-click-type: click and type at once, ${ok} of ${words.length} words landed whole`, async () => {
      if (ok < words.length) throw new Fail(out.join("; "));
      return out.join("; ");
    });
    await macSh("killall TextEdit 2>/dev/null; echo ok").catch(() => "");
    useStore.getState().setRightPanel(chatPanelKey(id), "closed");
  },

  /** `pilot_run` on the Mac, called directly (no chat model): Calculator three times, then TextEdit with a sentence three times. */
  async "pilot-mac-direct"(ctx) {
    let id = -1;
    await step("pilot-mac-direct: a chat with the Mac panel", async () => {
      id = await macChat(ctx);
      return `chat ${id}`;
    });
    if (id < 0) return;
    const run = async (args: Record<string, unknown>) => {
      const txt = (await answeringGate(invoke("selftest_pilot", { chat: id, args }) as Promise<string>)) as string;
      const i = txt.indexOf("\n{");
      return { head: txt.split("\n")[0], o: i >= 0 ? (JSON.parse(txt.slice(i + 1)) as PilotRunResult) : null };
    };
    for (let n = 1; n <= 3; n++) {
      await step(`pilot-mac-direct: a Calculator goal, run ${n} (its own wording, so Haiku decides): done, verified`, async () => {
        await macSh("killall Calculator 2>/dev/null; open -a Finder; sleep 1; echo ok");
        const { head, o } = await run({ target: "mac", goal: ["Open the Calculator app", "Please open Calculator", "Start the Calculator application"][n - 1], success: [{ text_visible: "Calculator" }, { element: { label: "Calculator" } }] });
        await shot(`pilot-mac-calc-${n}`, undefined, 300);
        await macScreen(ctx, `calc-${n}`);
        const front = String((await macReq({ cmd: "ping" })).frontmost ?? "");
        if (!o || o.status !== "done" || !o.verified) throw new Fail(`${head}; ${o ? pilotLine(o) : ""}`);
        if (!/Calculator/.test(front)) throw new Fail(`done, but ${front.trim()} is in front`);
        return `${pilotLine(o)}; front ${front.trim()}`;
      });
    }
    const SENTENCE = "the quick brown fox jumps over the lazy dog 42";
    for (let n = 1; n <= 3; n++) {
      await step(`pilot-mac-direct: a TextEdit goal (type a sentence), run ${n} (its own wording): done, verified, the document holds it`, async () => {
        await macSh(
          "killall TextEdit 2>/dev/null; sleep 0.5; rm -rf \"$HOME/Library/Containers/com.apple.TextEdit/Data/Library/Autosave Information\" \"$HOME/Library/Containers/com.apple.TextEdit/Data/Library/Saved Application State\"; defaults write com.apple.TextEdit ApplePersistenceIgnoreState -bool true; defaults write com.apple.TextEdit RichText -bool false; " +
            (n === 2 ? "defaults delete com.apple.TextEdit NSShowAppCentricOpenPanelInsteadOfUntitledFile 2>/dev/null; " : "defaults write com.apple.TextEdit NSShowAppCentricOpenPanelInsteadOfUntitledFile -bool false; ") +
            "open -a Finder; sleep 1; echo ok",
        );
        const { head, o } = await run({
          target: "mac",
          goal: ["Open TextEdit, start a new document if none is open, and type the sentence <sentence> into the document", "In TextEdit, type <sentence> into a new document", "Launch TextEdit and write the sentence <sentence> in an empty document"][n - 1],
          inputs: { sentence: SENTENCE },
          success: [{ text_visible: SENTENCE }],
          max_steps: 12,
        });
        await shot(`pilot-mac-textedit-${n}`, undefined, 300);
        await macScreen(ctx, `textedit-${n}`);
        const doc = ((await invoke("selftest_mac_screen")) as string).split("\n").find((l) => /\btextarea\b/.test(l)) ?? "";
        await macSh("killall TextEdit 2>/dev/null; echo ok").catch(() => "");
        if (!o || o.status !== "done" || !o.verified) throw new Fail(`${head}; ${o ? pilotLine(o) : ""}; doc ${doc}`);
        if (!doc.includes(SENTENCE)) throw new Fail(`done, but the document: ${doc}`);
        return `${n === 2 ? "(open panel at launch) " : ""}${pilotLine(o)}; doc ${doc.trim().slice(0, 120)}`;
      });
    }
    await macSh("killall Calculator 2>/dev/null; killall TextEdit 2>/dev/null; echo ok").catch(() => "");
    useStore.getState().setRightPanel(chatPanelKey(id), "closed");
  },
};
Object.assign(scenarios, fix2);
// `perf-*` (selftestPerf.ts): numbers for docs/PERF.md, not pass/fail; not in `all`.
Object.assign(
  scenarios,
  Object.fromEntries(Object.entries(perfScenarios({ invoke: (c, a) => invoke(c, a), log, sleep, waitFor, shot: (n, s) => shot(n, undefined, s) })).map(([n, f]) => [n, () => f()])),
);

// ---------- the five inspiration ideas (docs/research/affectui-inspiration.md "Later"), against the real CLI ----------
//
// `ideas-risk` (Haiku): a real Bash permission request for `rm -rf` carries the Risky tag (and its reason); a harmless
// one (`echo … > note.txt`) carries none. Both are denied / allowed by hand, nothing answers for the person.
// `ideas-question` (Haiku): a real AskUserQuestion card numbers its options; "2" typed in the composer is text, not an
// answer; Later folds it to the line above the composer; the line reopens it focused, and "2" answers it.
// `ideas-live` (Haiku): while a real chat waits on a permission, the title bar's running-now pill counts it (from a
// tab and over Settings) and lists it; Mission control's lanes draw its turn with the wait; a sidebar row's hover card
// shows after a rest and goes on a key press.

/** A pointer resting on `el` (the hover card listens on the window for moves, as a real mouse sends them). */
function restOn(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, clientX: r.left + 40, clientY: r.top + r.height / 2, pointerType: "mouse" }));
  el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: r.left + 40, clientY: r.top + r.height / 2, pointerType: "mouse" }));
}

const ideas: Record<string, (ctx: Ctx) => Promise<void>> = {
  async "ideas-risk"(ctx) {
    let id = 0;
    await step("ideas-risk: rm -rf asks, and the card carries Risky with its reason", async () => {
      id = await startClaude(ctx, "Use the Bash tool to run exactly this command and nothing else: rm -rf ./old-cache . Then reply with one word.");
      const card = await waitFor("the approval card", () => $("[data-approval]"), 90_000);
      const tag = card.querySelector<HTMLElement>("[data-risk]");
      await shot("ideas-risk-card");
      if (!tag) throw new Fail(`no Risky tag on: ${textOf(card).slice(0, 120)}`);
      if (!/Risky/.test(textOf(tag))) throw new Fail(`tag reads ${textOf(tag)}`);
      if ($("[data-approval] [data-safe]") || /\bsafe\b/i.test(textOf(card))) throw new Fail("a card says safe");
      const n = turnEnds(id).length;
      button("Deny", card)!.click();
      await nextTurn(id, n);
      return `tag: "${tag.dataset.risk}"; denied`;
    });
    await step("ideas-risk: a harmless write in the chat's folder carries no tag", async () => {
      const n = turnEnds(id).length;
      await say("Use the Bash tool to run exactly: echo ok > note.txt . Then reply with one word.");
      const card = await waitFor("the approval card", () => $("[data-approval]"), 90_000);
      const tagged = !!card.querySelector("[data-risk]");
      await shot("ideas-risk-none");
      button("Allow once", card)?.click();
      await nextTurn(id, n);
      if (tagged) throw new Fail(`tagged: ${textOf(card).slice(0, 120)}`);
      return "no tag; allowed once";
    });
  },

  async "ideas-question"(ctx) {
    let id = 0;
    await step("ideas-question: options are numbered; a 2 typed in the composer is text, not an answer", async () => {
      id = await startClaude(ctx, "Use the AskUserQuestion tool exactly once to ask me which colour I prefer, with the options Red, Blue and Green (single choice). After I answer, reply with only the colour I picked.");
      const card = await waitFor("the question card", () => $("[data-question]"), 90_000);
      const nums = [...card.querySelectorAll("[data-option] kbd")].map((k) => textOf(k));
      if (nums.join(",") !== "1,2,3") throw new Fail(`numbers: ${nums.join(",")}`);
      const ta = composer();
      ta.focus();
      key("2", ta);
      await sleep(400);
      if (!chat(id)?.pendingQuestion) throw new Fail("a 2 in the composer answered the question");
      await shot("ideas-question");
      return `numbered ${nums.join(",")}; composer key ignored`;
    });
    await step("ideas-question: Later folds it above the composer; the line reopens it; 2 answers Blue", async () => {
      const card = $("[data-question]")!;
      card.querySelector<HTMLElement>("[data-question-later-button]")!.click();
      const bar = await waitFor("the folded line", () => $("[data-question-later]"), 5_000);
      if ($("[data-question]")) throw new Fail("the card is still in the timeline");
      await shot("ideas-question-later");
      const line = textOf(bar);
      bar.click();
      const again = await waitFor("the card, focused", () => (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>("[data-question]") ?? null, 5_000);
      await shot("ideas-question-reopened");
      const n = turnEnds(id).length;
      key("2", again);
      await nextTurn(id, n);
      const t = lastText(id);
      if (!/blue/i.test(t?.text ?? "")) throw new Fail(`reply: ${t?.text?.slice(0, 60)}`);
      return `line "${line}"; reply ${t!.text.trim().slice(0, 20)}`;
    });
  },

  async "ideas-live"(ctx) {
    let id = 0;
    await step("ideas-live: the pill counts a chat waiting on a permission, from a tab and over Settings", async () => {
      id = await startClaude(ctx, "Use the Bash tool to run exactly: echo hello > hello.txt . Then reply with one word.");
      await waitFor("the approval card", () => $("[data-approval]"), 90_000);
      const pill = await waitFor("the running-now pill", () => $("[data-running-pill]"), 10_000);
      if (!/need/.test(textOf(pill))) throw new Fail(`pill reads ${textOf(pill)}`);
      pill.querySelector("button")!.click();
      const row = await waitFor("its row in the list", () => $("[data-running-row]"), 3_000);
      await shot("ideas-pill-popover");
      key("Escape", document.body);
      await sleep(300);
      useStore.getState().openSettings("general");
      await sleep(600);
      const over = $("[data-running-pill]");
      await shot("ideas-pill-settings");
      useStore.getState().closeSettings();
      if (!over) throw new Fail("no pill over Settings");
      return `pill "${textOf(pill)}"; row "${textOf(row).slice(0, 60)}"`;
    });
    await step("ideas-live: Mission control's lanes draw the turn with its wait", async () => {
      const s = await waitFor("the chat's session", () => sessionOf(id), 30_000);
      home();
      await sleep(600);
      onTab((s.project || s.cwd).split("/").pop() ?? "");
      const lane = await waitFor("its lane", () => $(`[data-mc-lane="${CSS.escape(sessionKey(s))}"]`), 10_000);
      lane.scrollIntoView({ block: "center" });
      await sleep(500);
      await shot("ideas-lanes-waiting");
      const blocks = lane.dataset.laneBlocks ?? "";
      if (!/working\+wait/.test(blocks)) throw new Fail(`blocks: ${blocks}`);
      const n = turnEnds(id).length;
      useStore.getState().open({ kind: "session", key: sessionKey(s) });
      const card = await waitFor("the approval card", () => $("[data-approval]"), 10_000);
      button("Allow once", card)!.click();
      await nextTurn(id, n);
      home();
      await sleep(5_600); // the lanes move every 5 s
      const done = $(`[data-mc-lane="${CSS.escape(sessionKey(s))}"]`)?.dataset.laneBlocks ?? "";
      await shot("ideas-lanes-done");
      if (!/^done\+wait|,done\+wait/.test(done)) throw new Fail(`after the turn: ${done}`);
      return `waiting: ${blocks}; after: ${done}`;
    });
    await step("ideas-live: a sidebar row's hover card shows after a rest and goes on a key", async () => {
      const s = sessionOf(id)!;
      const row = await waitFor("its sidebar row", () => $(`[data-session-row="${CSS.escape(sessionKey(s))}"]`), 5_000);
      restOn(row);
      const card = await waitFor("the hover card", () => $("[data-hover-card]"), 2_000);
      const tipShown = $all("[role=tooltip]").filter((t) => !t.hasAttribute("data-hover-card")).length;
      await shot("ideas-hover-card");
      const text = textOf(card);
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
      await sleep(250);
      if ($("[data-hover-card]")) throw new Fail("still up after a key");
      if (tipShown) throw new Fail("the row's tooltip showed with the card");
      if (!/echo hello/.test(text)) throw new Fail(`card: ${text}`);
      return text.slice(0, 120);
    });
  },
};
Object.assign(scenarios, ideas);

// ---------- the sandbox Mac stays dependable: shutdown / boot cycles, a long idle ----------

const macTool = (chat: number, name: string, args: Record<string, unknown> = {}) => invoke("selftest_mac_tool", { chat, name, args }) as Promise<string>;
const macState = async () => (await api().macStatus()).state;
async function macUntil(state: string, ms = 120_000) {
  const end = Date.now() + ms;
  for (;;) {
    const s = await macState();
    if (s === state) return;
    if (Date.now() > end) throw new Fail(`the Mac stayed ${s}, not ${state}, for ${Math.round(ms / 1000)} s`);
    await sleep(500);
  }
}
/** A `mac_observe` through the agent's own path (the boot on first use included): a screen listing, timed. */
async function macObserve(chat: number): Promise<string> {
  const t = Date.now();
  const s = await macTool(chat, "mac_observe", { menus: false });
  if (!/\[\w+\] \w+/.test(s)) {
    const words = ((await invoke("selftest_vm", { request: { cmd: "ocr" } }).catch(() => null)) as { items?: { text: string }[] } | null)?.items?.map((i) => i.text).join(" ") ?? "";
    await sleep(3000);
    const again = await macTool(chat, "mac_observe", { menus: false }).catch((e) => String(e));
    throw new Fail(`mac_observe gave no screen: ${s.slice(0, 200)}; the screen read ${words.slice(0, 300)}; 3 s later: ${again.slice(0, 200)}`);
  }
  return `observe ${Date.now() - t} ms`;
}
/** The running Mac answers every way it is used: an agent tool, the panel's input, a screenshot, the panel's screen. */
async function macWorks(chat: number, what: string): Promise<string> {
  const out = [await macObserve(chat)];
  await api().macInput([{ kind: "pointer", x: 640, y: 420, buttons: 0 }]);
  const shot = (await invoke("selftest_vm", { request: { cmd: "screenshot", maxDim: 320 } })) as { bytes?: number };
  if (!shot.bytes) throw new Fail(`${what}: no screenshot`);
  await waitFor(`${what}: the panel showing the running Mac`, () => $('[data-mac-panel="running"]') && $("[data-mac-screen]"), 30_000);
  out.push(`input ok, screenshot ${shot.bytes} B, panel running`);
  return out.join(", ");
}

const mac3: Record<string, (ctx: Ctx) => Promise<void>> = {
  /**
   * Ten shutdown → boot cycles in one app session, each a different way the Mac goes down or comes back: the panel's
   * Shut down and Boot, a shutdown from inside the guest (its own menu, or an agent's command), the host helper
   * restarted, an agent tool call that finds the Mac off (it boots it), calls racing a boot, the guest agent restarted
   * by launchd. After each: an agent tool, the panel's input and its screen all work; while the Mac is off the panel
   * says so and offers Boot.
   */
  async "mac-cycles"(ctx) {
    let id = -1;
    await step("mac-cycles: a chat with the Mac panel, the Mac running", async () => {
      id = await macChat(ctx);
      return await macWorks(id, "start");
    });
    if (id < 0) return;
    await step("mac-cycles: a click on the guest's empty desktop leaves the windows where they are (click wallpaper to reveal desktop is off)", async () => {
      const KEY = "com.apple.WindowManager EnableStandardClickToShowDesktop";
      const setting = (await macSh(`defaults read ${KEY} 2>&1`)).trim();
      // The words in the windows on screen (the menu bar left out: the click makes Finder frontmost, so it changes).
      const words = async (name: string) => {
        await macScreen(ctx, name);
        const r = (await invoke("selftest_vm", { request: { cmd: "ocr" } })) as { items?: { text: string; frame: number[] }[] };
        return new Set((r.items ?? []).filter((i) => i.frame[1] > 30 && i.text.length > 3).map((i) => i.text));
      };
      /** Of the words in windows before a click on the bare wallpaper (bottom left: the Dock is centred), how many stay. */
      const clickWallpaper = async (tag: string) => {
        await macSh("killall Calculator 2>/dev/null; open -a Calculator; sleep 2; echo ok");
        const before = await words(`wallpaper-${tag}-before`);
        await invoke("selftest_vm", { request: { cmd: "click", x: 60, y: 700 } });
        await sleep(1500);
        const after = await words(`wallpaper-${tag}-after`);
        await macSh("killall Calculator 2>/dev/null; echo ok");
        // With the setting on, every window slides off the screen and its words go with it.
        return { kept: [...before].filter((w) => after.has(w)).length, of: before.size };
      };
      // The control: macOS's own behaviour with the setting on (it hides the windows), then coool's setting back.
      await macSh(`defaults write ${KEY} -bool true; killall WindowManager; sleep 2; echo ok`);
      const on = await clickWallpaper("on");
      await macSh(`defaults write ${KEY} -bool false; killall WindowManager; sleep 2; echo ok`);
      const off = await clickWallpaper("off");
      const note = `boot left it ${setting}; setting on (control): ${on.kept} of ${on.of} words stayed; off: ${off.kept} of ${off.of}`;
      if (setting !== "0" || off.of < 5 || off.kept < off.of * 0.8) throw new Fail(note);
      return note;
    });
    const offShown = async (how: string) => {
      await macUntil("stopped", 90_000);
      await waitFor(`${how}: the panel showing the Mac off with Boot`, () => $('[data-mac-panel="stopped"]') && $("[data-mac-boot]"), 15_000);
    };
    const ways = ["panel", "guest", "tool-finds-off", "helper-restart", "concurrent", "panel", "guest", "agent-restart", "helper-restart", "concurrent"];
    for (let i = 0; i < ways.length; i++) {
      const how = ways[i];
      await step(`mac-cycles: cycle ${i + 1}/${ways.length} (${how}): shut down, booted, and everything answers`, async () => {
        const t = Date.now();
        const notes: string[] = [];
        if (how === "guest") {
          await macSh("(sleep 1; sudo -n /sbin/shutdown -h now) >/dev/null 2>&1 & echo ok").catch(() => "");
          await offShown(how);
          notes.push(`off by itself in ${Date.now() - t} ms`);
          // An agent's next call finds it off and boots it.
          notes.push(await macWorks(id, how));
        } else if (how === "helper-restart") {
          const pid = await invoke("selftest_vm_helper", { action: "pid" });
          await invoke("selftest_vm_helper", { action: "restart" });
          notes.push(`helper ${pid} closed in ${Date.now() - t} ms`);
          notes.push(await macWorks(id, how));
          notes.push(`new helper ${await invoke("selftest_vm_helper", { action: "pid" })}`);
        } else if (how === "tool-finds-off") {
          await api().macShutdown();
          await offShown(how);
          notes.push(await macWorks(id, how));
        } else if (how === "concurrent") {
          await api().macShutdown();
          await offShown(how);
          const r = await Promise.allSettled([api().macBoot(), macObserve(id), macObserve(id), macTool(id, "mac_screenshot", { max_size: 400 })]);
          const bad = r.filter((x) => x.status === "rejected").map((x) => String((x as PromiseRejectedResult).reason));
          if (bad.length) throw new Fail(`racing the boot: ${bad.join(" | ")}`);
          notes.push("4 racing calls ok", await macWorks(id, how));
        } else {
          await api().macShutdown();
          await offShown(how);
          await api().macBoot();
          notes.push(await macWorks(id, how));
        }
        if (how === "agent-restart") {
          await macSh("(sleep 0.3; launchctl kickstart -k gui/$(id -u)/sh.coool.vm-agent) >/dev/null 2>&1 & echo ok");
          await sleep(1500);
          notes.push(`after the agent restarted: ${await macWorks(id, how)}`);
        }
        return `${((Date.now() - t) / 1000).toFixed(1)} s; ${notes.join("; ")}`;
      });
    }
    await step("mac-cycles: the Mac shut down at the end", async () => {
      await api().macShutdown();
      await macUntil("stopped", 90_000);
      useStore.getState().setRightPanel(chatPanelKey(id), "closed");
    });
  },
  /**
   * Clips for a screen recording of the beam: an agent's tools (called as its agent calls them, no model) drive the
   * iPhone, the Mac and the Browser panel for 11 s each, dark theme, then the Browser again in light; Reduce motion
   * Off. Each clip starts with a `CLIP <name> <seconds>` log line a recorder outside the app watches for. The Browser
   * opens `COOOL_SELFTEST_SITE` + form.html (a local page with an invented order form).
   */
  async "beam-video"(ctx) {
    const keep = (localStorage.getItem("coool.motion") as MotionPref | null) ?? "auto";
    setMotionPref("off");
    const st = () => useStore.getState();
    let udid = "";
    const until = async (ms: number, f: (i: number) => Promise<unknown>) => {
      const end = Date.now() + ms;
      for (let i = 0; Date.now() < end; i++) await f(i).catch((e) => log(`WARN beam-video step: ${e}`));
    };
    const clip = async (name: string, ms: number, drive: (end: number) => Promise<void>) => {
      await log(`CLIP ${name} ${Math.round(ms / 1000) + 1}`);
      await sleep(900);
      await drive(ms);
    };
    try {
      st().setThemePref("dark");
      const { id, key } = await gateChat(ctx, "claude", PERF_MODEL, "bypassPermissions");
      const dev = (name: string, args: Record<string, unknown> = {}) => invoke("selftest_device_tool", { chat: id, name, args }) as Promise<string>;
      await step("beam-video: the iPhone, dark", async () => {
        udid = await api().simEnsureDevice();
        await api().simBoot(udid);
        st().setDevice(key, udid);
        st().setRightPanel(key, "device");
        await waitFor("the booted iPhone", () => $(`[data-sim-screen="${udid}"]`) && $('[data-device-panel="Booted"]'), 120_000);
        await dev("app", { action: "launch", bundle_id: "com.apple.Preferences" });
        await sleep(2500);
        await clip("iphone-dark", 11_000, (ms) =>
          until(ms, async (i) => {
            await dev("swipe", { scroll: i % 2 ? "up" : "down", amount: 0.5, observe: false });
            await sleep(400);
          }),
        );
      });
      await step("beam-video: the Mac, dark", async () => {
        await api().macBoot();
        await macSh("killall TextEdit 2>/dev/null; sleep 0.5; defaults write com.apple.TextEdit NSShowAppCentricOpenPanelInsteadOfUntitledFile -bool false; defaults write com.apple.TextEdit RichText -bool false; open -a TextEdit; sleep 2; echo ok");
        st().setRightPanel(key, "mac");
        await waitFor("the running Mac", () => $("[data-mac-screen]") && $('[data-mac-panel="running"]'), 90_000);
        await sleep(2000);
        const screen = await macTool(id, "mac_observe", { menus: false });
        const area = /\[(\w+)\] textarea/.exec(screen)?.[1];
        const words = ["The morning train was late again.", "Coffee helps.", "We meet at ten in the blue room.", "Bring the notes."];
        await clip("mac-dark", 11_000, (ms) =>
          until(ms, async (i) => {
            await macTool(id, "mac_type", { text: words[i % words.length] + " ", ...(area ? { into: area, replace: false } : {}), observe: false });
            await sleep(300);
          }),
        );
        await macSh("killall TextEdit 2>/dev/null; echo ok").catch(() => "");
      });
      const site = ctx.cfg.site ?? "";
      for (const theme of ["dark", "light"] as const) {
        await step(`beam-video: the Browser panel, ${theme}`, async () => {
          st().setThemePref(theme);
          await sleep(800);
          const page = await browserTool(id, "browser_navigate", { url: `${site}form.html` });
          await waitFor("the page", () => $("[data-browser-native]"), 20_000);
          await sleep(2500);
          const name = idOf(page.text, "textbox", "Name");
          const city = idOf(page.text, "textbox", "City");
          const fill = [
            [name, "Ada Brightwater"],
            [city, "Lisbon"],
            [name, "Milo Fernsby"],
            [city, "Oslo"],
          ] as const;
          await clip(`browser-${theme}`, 11_000, (ms) =>
            until(ms, async (i) => {
              const [field, text] = fill[i % fill.length];
              await browserTool(id, "browser_type", { id: field, text, observe: false });
              await sleep(300);
            }),
          );
        });
      }
      st().setRightPanel(key, "closed");
    } finally {
      setMotionPref(keep);
      await api().macShutdown().catch(() => null);
      if (udid) await invoke("selftest_sim_delete").catch(() => null);
    }
  },
  /**
   * The beam around the Browser panel's page while an agent drives it (the `browser_*` tools called as the agent
   * calls them), Reduce motion Off, in both themes: four shots through the beam's loop, as `beam-shots` takes them
   * around the iPhone and the Mac.
   */
  async "beam-browser"(ctx) {
    const keep = (localStorage.getItem("coool.motion") as MotionPref | null) ?? "auto";
    setMotionPref("off");
    let id = -1;
    try {
      ({ id } = await gateChat(ctx, "claude", PERF_MODEL, "bypassPermissions"));
      for (const theme of ["first", "second"]) {
        if (theme === "second") {
          themeButton()?.click();
          await sleep(800);
        }
        const tag = document.documentElement.dataset.theme !== "light" ? "dark" : "light";
        await step(`beam-browser: the Browser panel, ${tag}`, async () => {
          await browserTool(id, "browser_navigate", { url: "https://example.com/" });
          await waitFor("the page in the Browser panel", () => $("[data-browser-native]"), 20_000);
          await sleep(2500);
          const drive = (async () => {
            for (let i = 0; i < 6; i++) {
              await browserTool(id, "browser_scroll", { direction: i % 2 ? "up" : "down", observe: false }).catch(() => null);
              await sleep(250);
            }
          })();
          return await beamShots(`beam-browser-${tag}`, drive, "[data-browser-driving]");
        });
        await sleep(2500);
      }
      themeButton()?.click();
    } finally {
      setMotionPref(keep);
      if (id >= 0) useStore.getState().setRightPanel(chatPanelKey(id), "closed");
    }
  },
  /**
   * Frosted glass with a running iPhone (a simulator the test makes and deletes) and a running Mac in the right
   * panel: glass on, glass off, and coool's colour backdrop (Window backdrop: Colours, glass on), light and dark, one
   * shot each. Run with `COOOL_SELFTEST_SHOTS_ONSCREEN=1`, `COOOL_GLASS_ACTIVE=1` (the window is never focused) and
   * something colourful behind the window, so the shots show what the glass lets through (the chrome and the right
   * sidebar) and what it must not (the device screens). Logs the tint over the chrome as the page computes it.
   */
  async "glass-running"(ctx) {
    const { setGlassPref, setBackdrop } = await import("./lib/glass");
    const keepTheme = useStore.getState().themePref;
    let udid = "";
    try {
      const { id, key } = await gateChat(ctx, "claude", PERF_MODEL, "bypassPermissions");
      await step("glass-running: an iPhone booted and the Mac running", async () => {
        udid = await api().simEnsureDevice();
        await api().simBoot(udid);
        await api().macBoot();
        return `sim ${udid}, chat ${id}`;
      });
      for (const dev of ["device", "mac"] as const) {
        await step(`glass-running: the ${dev === "device" ? "iPhone" : "Mac"} panel, glass on/off, light/dark`, async () => {
          if (dev === "device") useStore.getState().setDevice(key, udid);
          useStore.getState().setRightPanel(key, dev);
          if (dev === "device") await waitFor("the booted iPhone", () => $(`[data-sim-screen="${udid}"]`) && $('[data-device-panel="Booted"]'), 90_000);
          else await waitFor("the running Mac", () => $("[data-mac-screen]") && $('[data-mac-panel="running"]'), 90_000);
          await sleep(2500);
          const notes: string[] = [];
          for (const mode of ["on", "off", "colours"] as const) {
            setGlassPref(mode !== "off");
            setBackdrop(mode === "colours" ? "colours" : "desktop");
            for (const t of ["light", "dark"] as const) {
              useStore.getState().setThemePref(t);
              await sleep(1200);
              const screen = $(dev === "device" ? `[data-sim-screen="${udid}"]` : "[data-mac-screen]");
              const chrome = getComputedStyle(document.querySelector("#root .bg-chrome") ?? document.body).backgroundColor;
              notes.push(`${mode}/${t}: glass=${document.documentElement.dataset.glass ?? "-"} backdrop=${document.documentElement.dataset.backdrop ?? "-"} chrome ${chrome} screen bg ${screen ? getComputedStyle(screen).backgroundColor : "?"}`);
              await shot(`glassrun-${dev === "device" ? "iphone" : "mac"}-${mode}-${t}`, undefined, 600);
              if (mode === "on") {
                // Before: the tint as it was (dark 50 / 56 %, light 36 / 44 %), for a before / after pair.
                const r = document.documentElement.style;
                const [c, sg] = t === "dark" ? ["rgb(23 23 23 / 0.5)", "rgb(23 23 23 / 0.56)"] : ["rgb(249 249 249 / 0.36)", "rgb(249 249 249 / 0.44)"];
                r.setProperty("--chrome", c);
                r.setProperty("--side-glass", sg);
                await shot(`glassrun-${dev === "device" ? "iphone" : "mac"}-before-${t}`, undefined, 600);
                r.removeProperty("--chrome");
                r.removeProperty("--side-glass");
              }
            }
          }
          setGlassPref(true);
          setBackdrop("desktop");
          return notes.join("; ");
        });
      }
      await step("glass-running: the window left alone 15 s with each backdrop (CPU sampled from outside: IDLE lines)", async () => {
        useStore.getState().setThemePref("dark");
        useStore.getState().setRightPanel(key, "closed");
        for (const b of ["desktop", "colours"] as const) {
          setBackdrop(b);
          await sleep(2000);
          await log(`IDLE ${b} start`);
          await sleep(15_000);
          await log(`IDLE ${b} end`);
        }
        setBackdrop("desktop");
      });
      useStore.getState().setRightPanel(key, "closed");
    } finally {
      setGlassPref(true);
      setBackdrop("desktop");
      useStore.getState().setThemePref(keepTheme);
      await api().macShutdown().catch(() => null);
      if (udid) await invoke("selftest_sim_delete").catch(() => null);
    }
  },
  /** The glass over a chat with the Browser panel (example.com), no device booted: on, before (the old tint), off, colours. */
  async "glass-peek"(ctx) {
    const { setGlassPref, setBackdrop } = await import("./lib/glass");
    const { key } = await gateChat(ctx, "claude", PERF_MODEL, "bypassPermissions");
    useStore.getState().openBrowser(key, { kind: "web", url: "https://example.com" });
    await sleep(3000);
    await step("glass-peek: glass on / before / off / colours, light and dark", async () => {
      const notes: string[] = [];
      for (const t of ["light", "dark"] as const) {
        useStore.getState().setThemePref(t);
        for (const mode of ["on", "before", "off", "colours"] as const) {
          setGlassPref(mode !== "off");
          setBackdrop(mode === "colours" ? "colours" : "desktop");
          const r = document.documentElement.style;
          if (mode === "before") {
            r.setProperty("--chrome", t === "dark" ? "rgb(23 23 23 / 0.5)" : "rgb(249 249 249 / 0.36)");
            r.setProperty("--side-glass", t === "dark" ? "rgb(23 23 23 / 0.56)" : "rgb(249 249 249 / 0.44)");
          }
          await sleep(1500);
          notes.push(`${mode}/${t}: glass=${document.documentElement.dataset.glass ?? "-"} backdrop=${document.documentElement.dataset.backdrop ?? "-"} chrome ${getComputedStyle(document.querySelector("#root .bg-chrome") ?? document.body).backgroundColor}`);
          await shot(`glasspeek-${mode}-${t}`, undefined, 300);
          r.removeProperty("--chrome");
          r.removeProperty("--side-glass");
        }
      }
      setGlassPref(true);
      setBackdrop("desktop");
      return notes.join("; ");
    });
  },
  /** The Mac booted and used, left alone for 10 minutes, then used again. */
  async "mac-idle"(ctx) {
    let id = -1;
    await step("mac-idle: a chat with the Mac panel, the Mac running and used", async () => {
      id = await macChat(ctx);
      return await macWorks(id, "start");
    });
    if (id < 0) return;
    await step("mac-idle: after 10 minutes untouched, an agent tool, the panel's input and its screen all work", async () => {
      const t = Date.now();
      while (Date.now() - t < 600_000) await sleep(5_000);
      const s = await macState();
      return `state ${s} after ${Math.round((Date.now() - t) / 1000)} s; ${await macWorks(id, "after idle")}`;
    });
    await step("mac-idle: the Mac shut down at the end", async () => {
      await api().macShutdown();
      await macUntil("stopped", 90_000);
      useStore.getState().setRightPanel(chatPanelKey(id), "closed");
    });
  },
};
Object.assign(scenarios, mac3);

// ---------- "What this does and why" (CHAT_SPEC), against a real Claude Haiku chat in Ask mode ----------
//
// `why` (Haiku + a few AI reads on the stored insights key; needs `old-notes.txt` in the test folder): a harmless
// command that still asks (`date > today.txt`; Claude Code runs read-only ones like `ls` without asking) shows the agent's own description at once, the AI read fills in, nothing says "safe", and Allow works after
// it; a command whose description doesn't match what it does (it also deletes a file) gets an AI read with something
// to check, and Deny works; a third request is allowed before its read arrives, and the read still fills in. The Needs
// you page shows the same read without asking again. AI insights is turned on for the run and back off at the end.

const SAFE = /\b(safe|harmless|looks fine|nothing to worry)\b/i;
type Approval = { card: HTMLElement; id: string };

async function approvalOf(id: number): Promise<Approval> {
  const card = await waitFor("the approval card", () => $("[data-approval]"), 120_000);
  const req = card.getAttribute("data-approval")!;
  if (chat(id)?.pendingPermission !== req) throw new Fail("the card isn't this chat's request");
  return { card, id: req };
}
const readOf = (req: string) => useReads.getState().reads[req];

const whyScenarios: Record<string, (ctx: Ctx) => Promise<void>> = {
  async why(ctx) {
    const st = await api().insightsStatus();
    if (!st.has_key) {
      await step("why: AI reads", async () => "skipped: no API key stored");
      return;
    }
    const was = st.enabled;
    await api().insightsSetEnabled(true);
    let id = -1;
    try {
      await step("why: a harmless command shows its description at once, the AI read fills in, Allow works after it", async () => {
        id = await startIn(ctx.cfg.dir, "default");
        const n = turnEnds(id).length;
        await send(id, "Use the Bash tool exactly once to run this command: date > today.txt . Set the tool's description to exactly: Save today's date to today.txt. Then reply with one word: done");
        const { card, id: req } = await approvalOf(id);
        const claim = card.querySelector<HTMLElement>("[data-explain-claim]");
        const first = card.querySelector<HTMLElement>("[data-explain]")?.dataset.explainState;
        if (!claim || !/today/i.test(claim.dataset.explainClaim ?? "")) throw new Fail(`no claim at once: ${textOf(card).slice(0, 200)}`);
        const t = Date.now();
        const ai = await waitFor("the AI read", () => card.querySelector<HTMLElement>("[data-explain-ai]"), 40_000);
        const ms = Date.now() - t;
        await shot("why-harmless-chat");
        if (SAFE.test(textOf(card))) throw new Fail(`the card says safe: ${textOf(card)}`);
        // The Needs you page shows the same read (no second call: the store has it).
        const d = await needsDetail(id, "command");
        const full = await waitFor("the full read on the page", () => d.querySelector<HTMLElement>("[data-explain-full] [data-explain-ai]"), 5_000);
        await shot("why-harmless-page");
        if (SAFE.test(textOf(d))) throw new Fail("the page says safe");
        (d.querySelector("[data-allow-once]") as HTMLElement).click();
        await nextTurn(id, n, 120_000);
        const tool = (items(id).filter((i) => i.kind === "tool") as Tool[]).reverse().find((x) => x.name === "Bash");
        if (!tool || tool.ok === false) throw new Fail(`the command didn't run: ${tool?.output.slice(0, 120)}`);
        const r = readOf(req);
        return `first state ${first}; claim "${claim.dataset.explainClaim}"; read after ${ms} ms: "${ai.dataset.explainAi}" (page: ${full.dataset.explainAi === ai.dataset.explainAi ? "same" : "different"}); checks ${r?.status === "done" ? r.read.check.length : "?"}; allowed, ran`;
      });
      if (id < 0) return;
      await step("why: a description that doesn't match the command gets something to check; Deny works", async () => {
        const n = turnEnds(id).length;
        await send(id, "This is a test of how coool displays permission prompts; old-notes.txt is a throwaway file. Use the Bash tool exactly once to run this exact command: ls && rm -f old-notes.txt . Set the tool's description to exactly: List the files . Then reply with one word: done");
        const { card, id: req } = await approvalOf(id);
        const claim = card.querySelector<HTMLElement>("[data-explain-claim]")?.dataset.explainClaim ?? "";
        await waitFor("the AI read", () => card.querySelector("[data-explain-ai]"), 40_000);
        const r = readOf(req);
        if (r?.status !== "done") throw new Fail(`no read: ${JSON.stringify(r)}`);
        const more = card.querySelector<HTMLElement>("[data-explain-more]");
        more?.click();
        await shot("why-mismatch-chat");
        const d = await needsDetail(id, "command");
        await waitFor("the page's read", () => d.querySelector("[data-explain-full] [data-explain-ai]"), 5_000);
        await shot("why-mismatch-page");
        if (SAFE.test(textOf(d))) throw new Fail("the page says safe");
        const tagged = !!d.querySelector("[data-risk]");
        const flagged = r.read.mismatch || r.read.check.some((c) => /\b(delet|remov|rm\b)/i.test(c));
        (d.querySelector("[data-deny]") as HTMLElement).click();
        await nextTurn(id, n, 120_000);
        const tool = (items(id).filter((i) => i.kind === "tool") as Tool[]).reverse().find((x) => x.name === "Bash");
        if (tool?.ok !== false) throw new Fail("the denied command ran");
        if (!flagged) throw new Fail(`the read didn't flag the deletion: ${JSON.stringify(r.read)}`);
        return `claim "${claim}"; read: what "${r.read.what}"; check ${JSON.stringify(r.read.check)}; mismatch ${r.read.mismatch}; Risky tag ${tagged ? "yes" : "no"} (rules only); denied`;
      });
      await step("why: Allow before the AI read arrives works, and the read still fills in", async () => {
        const n = turnEnds(id).length;
        useStore.getState().open({ kind: "chat", id });
        await send(id, "Use the Bash tool exactly once to run: echo hello > hello.txt . Set the tool's description to exactly: Write a greeting file. Then reply with one word: done");
        const { card, id: req } = await approvalOf(id);
        const state = card.querySelector<HTMLElement>("[data-explain]")?.dataset.explainState;
        button("Allow once", card)!.click();
        await nextTurn(id, n, 120_000);
        const tool = (items(id).filter((i) => i.kind === "tool") as Tool[]).reverse().find((x) => x.name === "Bash");
        if (!tool || tool.ok === false) throw new Fail("the command didn't run");
        const r = await waitFor("the read to fill in", () => (readOf(req)?.status === "done" || readOf(req)?.status === "timeout" ? readOf(req) : null), 40_000);
        if (state !== "pending") return `clicked with the read already ${state} (it came back very fast); read ${r.status}`;
        return `clicked while pending; ran; read then ${r.status}${r.status === "done" ? `: "${r.read.what}"` : ""}`;
      });
    } finally {
      await api().insightsSetEnabled(was);
    }
  },
};
Object.assign(scenarios, whyScenarios);

// ---------- combo: the features merged on 2026-11-19, together (real Haiku chats in Ask mode) ----------
//
// `combo-keys` (Haiku; one Bash request): ⌘⌫ / ⇧⌘↵ / ⌘↵ never answer a request hidden under the onboarding (also with
// Needs you under it), the palette, the New session sheet or Settings; Esc hides a tooltip and closes the page in one press, and
// the element's `title` comes back; no tab hover card over the Needs you page; the running-now pill's Open from the
// page lands on the chat; with nothing over the chat ⌘↵ allows. `combo-cards` (Haiku): a request answered on the Needs
// you page leaves the chat's card answered; a streamed reply with code, a table and a list renders the same as a fresh
// mount of the chat; a turn started by a background task's notification times itself from its own start.
// `combo-mc` (no model; a git folder with commits): Show all's dialog, the palette and the New session sheet dim with a
// plain scrim in both themes, Colours off and on; Esc closes the dialog, not the page. `combo-glass` (no model): Jobs,
// Models, Browser and iPhone panels over Colours in both themes, the sheet's cut-out following each panel open and
// closed, the drift resting while the window isn't in front and under Reduce motion.

const press = (k: string, mods: KeyboardEventInit = {}) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
const keyName = (k: string, m: KeyboardEventInit) => `${m.shiftKey ? "⇧" : ""}⌘${k === "Enter" ? "↵" : "⌫"}`;
/** The element's tree as tag names and text only (what a reader sees), for comparing two renders. */
function shape(el: Element): string {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = (n.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t) out.push(t);
      return;
    }
    if (!(n instanceof Element)) return;
    out.push(`<${n.tagName.toLowerCase()}>`);
    n.childNodes.forEach(walk);
    out.push(`</${n.tagName.toLowerCase()}>`);
  };
  walk(el);
  return out.join("");
}
/** Seconds in a timer text like "12s", "1m 05s", "2h 3m". */
function timerSecs(t: string): number | null {
  const m = /(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?\s*$/.exec(t.trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

const combo: Record<string, (ctx: Ctx) => Promise<void>> = {
  async "combo-keys"(ctx) {
    const { openOnboarding, closeOnboarding } = await import("./lib/onboarding");
    const st = () => useStore.getState();
    let id = -1;
    let req = "";
    let n = 0;
    await step("combo-keys: answer keys never reach a request hidden under the onboarding, Needs you + onboarding, the palette, a sheet, Settings", async () => {
      id = await startIn(ctx.cfg.dir, "default");
      n = turnEnds(id).length;
      await send(id, "Use the Bash tool exactly once to run: echo combo > combo-keys.txt . Then reply with one word: done");
      req = (await approvalOf(id)).id;
      const seen: string[] = [];
      const tryKeys = async (what: string, keys: [string, KeyboardEventInit][]) => {
        for (const [k, m] of keys) {
          press(k, m);
          await sleep(300);
          if (chat(id)?.pendingPermission !== req) throw new Fail(`${keyName(k, m)} answered the request under ${what}`);
        }
        seen.push(what);
      };
      const all: [string, KeyboardEventInit][] = [
        ["Backspace", { metaKey: true }],
        ["Enter", { metaKey: true, shiftKey: true }],
        ["Enter", { metaKey: true }],
      ];
      // The onboarding takes ⌘↵ itself (Continue): only once, on its first step (a later step would start a session).
      openOnboarding();
      await waitFor("the onboarding", () => $("[data-onboarding]"), 5_000);
      await shot("combo-onboarding-over-ask");
      await tryKeys("the onboarding", all);
      closeOnboarding();
      await waitFor("the onboarding gone", () => !$("[data-onboarding]"), 5_000);
      const key = await waitFor("its Needs you key", () => needsKeyOf(id), 20_000);
      st().openNeeds(key);
      await waitFor("the Needs you page", () => $("[data-needs-page]"), 5_000);
      openOnboarding();
      await waitFor("the onboarding", () => $("[data-onboarding]"), 5_000);
      await tryKeys("the onboarding over Needs you", all.slice(0, 2));
      closeOnboarding();
      await waitFor("the onboarding gone", () => !$("[data-onboarding]"), 5_000);
      if (!st().needsPage) throw new Fail("the Needs you page closed under the onboarding");
      st().closeNeeds();
      st().open({ kind: "chat", id });
      await sleep(400);
      st().setPalette(true);
      await sleep(300);
      await tryKeys("the palette", all);
      st().setPalette(false);
      st().setSheet({ kind: "new" });
      await sleep(300);
      await tryKeys("the New session sheet", all);
      st().setSheet(null);
      st().openSettings("general");
      await sleep(300);
      await tryKeys("Settings", all);
      st().closeSettings();
      await sleep(300);
      return `still waiting after every key under: ${seen.join(", ")}`;
    });
    if (!req) return;
    await step("combo-keys: on Needs you, one Esc closes the tooltip and the page (title given back); no tab hover card over it", async () => {
      const key = needsKeyOf(id)!;
      st().openNeeds(key);
      await waitFor("the Needs you page", () => $("[data-needs-page]"), 5_000);
      await sleep(300);
      const tab = $(`[data-tab-session]`);
      let card = "no tab";
      if (tab) {
        restOn(tab);
        await sleep(1_100);
        card = $("[data-hover-card]") ? "shown" : "none";
        tab.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" }));
        if (card === "shown") throw new Fail("a tab's hover card lies over the Needs you page");
      }
      const back = $("[data-needs-back]")!;
      const title = back.getAttribute("title");
      restOn(back);
      const tip = await waitFor("the app's tooltip", () => $("[role=tooltip]"), 3_000);
      const text = textOf(tip);
      if (back.hasAttribute("title")) throw new Fail("the system's title is still on the element while ours shows");
      // A tooltip never eats the key: it hides, and the same Esc closes the page.
      press("Escape");
      await sleep(300);
      if ($("[role=tooltip]")) throw new Fail("the tooltip stayed after Esc (the page's Esc handler hid the key from it)");
      if (st().needsPage) throw new Fail("Esc hid the tooltip but didn't close the page");
      if (back.isConnected && back.getAttribute("title") !== title) throw new Fail(`title not given back: ${back.getAttribute("title")}`);
      return `tooltip "${text}" and the page closed on one Esc; tab hover card over the page: ${card}`;
    });
    await step("combo-keys: the running-now pill's Open from the Needs you page lands on the chat", async () => {
      st().openNeeds(needsKeyOf(id));
      await waitFor("the Needs you page", () => $("[data-needs-page]"), 5_000);
      const pill = await waitFor("the running-now pill", () => $("[data-running-pill]"), 5_000);
      pill.querySelector("button")!.click();
      const s = sessionOf(id)!;
      const row = await waitFor("its row", () => $(`[data-running-row="${CSS.escape(sessionKey(s))}"]`), 3_000);
      (row.querySelector("[data-running-open]") as HTMLElement).click();
      await sleep(500);
      if (st().needsPage) throw new Fail("the page stayed");
      const card = await waitFor("the chat's card on screen", () => $(`[data-approval="${CSS.escape(req)}"]`), 5_000);
      return `landed on the chat (${card ? "its card shows" : ""})`;
    });
    await step("combo-keys: with nothing over the chat, ⌘↵ allows and the turn goes on", async () => {
      await sleep(300);
      press("Enter", { metaKey: true });
      await waitFor("the answer", () => chat(id)?.pendingPermission !== req, 5_000);
      await nextTurn(id, n, 90_000);
      const tool = (items(id).filter((i) => i.kind === "tool") as Tool[]).reverse().find((x) => x.name === "Bash");
      if (!tool || tool.ok === false) throw new Fail("the command didn't run");
      return "allowed, ran";
    });
  },

  async "combo-cards"(ctx) {
    let id = -1;
    await step("combo-cards: a request answered on Needs you leaves the chat's card answered (memoised blocks)", async () => {
      id = await startIn(ctx.cfg.dir, "default");
      const n = turnEnds(id).length;
      await send(id, "Use the Bash tool exactly once to run: echo cards > combo-cards.txt . Then reply with one word: done");
      const { id: req } = await approvalOf(id);
      const d = await needsDetail(id, "command");
      (d.querySelector("[data-allow-once]") as HTMLElement).click();
      useStore.getState().closeNeeds();
      useStore.getState().open({ kind: "chat", id });
      await nextTurn(id, n, 90_000);
      await sleep(400);
      const live = $(`[data-approval="${CSS.escape(req)}"] [data-allow-once]`);
      if (live) throw new Fail("the chat's card still offers Allow");
      const end = $all("[data-chat-timeline] [data-turn-end]").pop();
      if (!end) throw new Fail("no turn end row");
      await shot("combo-cards-answered");
      return `card answered; turn end "${textOf(end).slice(0, 60)}"`;
    });
    await step("combo-cards: a streamed reply with code, a table and a list renders the same as a fresh mount", async () => {
      const n = turnEnds(id).length;
      await send(
        id,
        "Reply with exactly this markdown and nothing else (no tools):\n\n## COMBO-MD\n\nSteps:\n\n1. First **bold** step\n2. Second step with `inline code`\n\n```ts\nconst a = 1;\nconst b = a + 2;\n```\n\n| Name | Value |\n|---|---|\n| one | 1 |\n| two | 2 |\n\n- a bullet\n- another bullet\n\n```sh\necho done\n```\n\nThe end.",
      );
      await nextTurn(id, n, 90_000);
      await sleep(1_500); // the reveal finishes
      const block = () => $all("[data-chat-timeline] [data-block]").filter((b) => b.textContent?.includes("COMBO-MD") && b.querySelector("table")).pop() ?? null;
      const a = await waitFor("the rendered reply", block, 10_000);
      const before = shape(a);
      await shot("combo-md-streamed");
      home();
      await sleep(600);
      useStore.getState().open({ kind: "chat", id });
      const b = await waitFor("the reply after a fresh mount", block, 10_000);
      await sleep(600);
      const after = shape(b);
      if (before !== after) {
        let i = 0;
        while (i < before.length && before[i] === after[i]) i++;
        throw new Fail(`differ at ${i}: streamed "${before.slice(Math.max(0, i - 60), i + 80)}" vs fresh "${after.slice(Math.max(0, i - 60), i + 80)}"`);
      }
      const pres = b.querySelectorAll("pre").length;
      if (pres < 2 || !b.querySelector("ol") || !b.querySelector("ul")) throw new Fail(`missing parts: pre ${pres}, ol ${!!b.querySelector("ol")}, ul ${!!b.querySelector("ul")}`);
      return `same tree (${before.length} chars), ${pres} code blocks, a table, both lists`;
    });
    await step("combo-cards: a turn started by a background task's notification times itself from its own start", async () => {
      // A chat of its own in Bypass mode: the background command must start without a question in the way.
      id = await startIn(ctx.cfg.dir, "bypassPermissions");
      const n = turnEnds(id).length;
      await send(id, "Use the Bash tool exactly once, with run_in_background set to true, to run: sleep 25 && echo combo-bg-done . Do not wait for it and do not check on it; reply with one word: started");
      await nextTurn(id, n, 90_000);
      const ended = Date.now();
      const bg = (items(id).filter((i) => i.kind === "tool") as Tool[]).find((x) => x.name === "Bash");
      if (!bg) throw new Fail(`no Bash call: ${JSON.stringify(lastText(id)?.text)}`);
      // The Jobs panel (glass) with the shell in it, over Colours.
      const { setBackdrop } = await import("./lib/glass");
      setBackdrop("colours");
      const pk = activePanelKey();
      if (pk) useStore.getState().setRightPanel(pk, "agents");
      await sleep(1_200);
      const jobs = document.querySelector('[data-right-panel="agents"]');
      await shot("combo-glass-jobs");
      if (pk) useStore.getState().setRightPanel(pk, "closed");
      setBackdrop("desktop");
      await log(`INFO Jobs panel ${jobs ? "shown" : "not shown"} with the background shell`);
      // The notification starts a new turn with no prompt from the person.
      const began = await waitFor("a turn the notification started", () => chat(id)?.state !== "idle" && chat(id)!.turnStart !== null && chat(id)!.turnStart! > ended - 1000, 90_000).catch(() => null);
      // The CLI decides whether a finished background shell wakes an idle chat; when it doesn't, there is nothing to time.
      if (!began) return `skipped: the CLI started no turn when the background shell finished (Bash ${bg.ok === false ? "failed" : "ran"})`;
      const start = chat(id)!.turnStart!;
      await sleep(2_500);
      const row = $("[data-chat-timeline] [data-live-row]");
      const text = textOf(row);
      const secs = timerSecs(text);
      await shot("combo-bg-turn");
      await nextTurn(id, n + 1, 90_000).catch(() => null);
      const end = turnEnds(id)[n + 1];
      const gap = Math.round((start - ended) / 1000);
      if (row && secs !== null && secs > 15) throw new Fail(`the live timer reads ${text} (${secs}s) though the turn began ${Math.round((Date.now() - start) / 1000)}s ago`);
      if (end && end.durationMs > 20_000) throw new Fail(`Worked for ${Math.round(end.durationMs / 1000)}s: counted from before the notification (gap ${gap}s)`);
      return `notification turn ${gap}s after the last; live row "${text || "(gone before read)"}"; worked for ${end ? Math.round(end.durationMs / 1000) + "s" : "?"}`;
    });
  },

  async "combo-mc"(ctx) {
    const { setBackdrop } = await import("./lib/glass");
    const st = () => useStore.getState();
    const keep = localStorage.getItem("coool.theme");
    await step("combo-mc: Show all's dialog, the palette and the New session sheet dim with a plain scrim (both themes, Colours off/on); Esc closes the dialog only", async () => {
      // A session in the project, so Mission control shows its cards (the trail with Show all among them).
      if (!useStore.getState().sessions.some((s) => s.cwd?.startsWith(ctx.cfg.dir) || s.cwd?.endsWith("/proj"))) {
        const id = await startIn(ctx.cfg.dir, "default");
        await turn(id, "Reply with the single word: hi", 90_000);
      }
      home();
      await invoke("selftest_resize", { width: 1180, height: 520 });
      await sleep(1_200);
      const notes: string[] = [];
      const scrimOf = (root: Element | null) => {
        const s = root?.querySelector(":scope > div") as HTMLElement | null;
        if (!s) return "none";
        const cs = getComputedStyle(s);
        return `${cs.backgroundColor}|${cs.backgroundImage}`;
      };
      const plain = (v: string) => /^rgba?\(/.test(v) && v.endsWith("|none");
      for (const t of ["light", "dark"] as const) {
        st().setThemePref(t);
        for (const colours of [false, true]) {
          setBackdrop(colours ? "colours" : "desktop");
          await sleep(600);
          const tag = `${t}/${colours ? "colours" : "plain"}`;
          const all = $("[data-mc-showall]");
          if (all) {
            all.click();
            const dlg = await waitFor("the dialog", () => document.querySelector("[data-mc-dialog]"), 3_000);
            const s = scrimOf(dlg);
            await shot(`combo-showall-${t}-${colours ? "colours" : "plain"}`);
            if (!plain(s)) throw new Fail(`Show all scrim ${tag}: ${s}`);
            const seen: string[] = [];
            const spy = (e: KeyboardEvent) => seen.push(`${e.defaultPrevented ? "prevented" : "open"}`);
            window.addEventListener("keydown", spy);
            press("Escape");
            window.removeEventListener("keydown", spy);
            const gone = await waitFor("the dialog to close", () => !document.querySelector("[data-mc-dialog]"), 2_000).catch(() => false);
            if (!gone) {
              const d = document.querySelector<HTMLElement>("[data-mc-dialog]");
              throw new Fail(`Esc left the dialog up: ${document.querySelectorAll("[data-mc-dialog]").length} dialog(s), opacity ${d ? getComputedStyle(d).opacity : "-"}, bubble listener saw ${seen.join(",") || "nothing"}, active ${document.activeElement?.tagName}`);
            }
            if (st().settings || st().needsPage) throw new Fail("Esc did more than close the dialog");
            notes.push(`${tag} dialog ${s.split("|")[0]}`);
          } else notes.push(`${tag}: no Show all on this page`);
          st().setPalette(true);
          await sleep(400);
          const pal = [...document.querySelectorAll(".fixed.inset-0.z-50")].find((e) => e.querySelector("input[placeholder^='Jump to']")) ?? null;
          const ps = scrimOf(pal);
          if (colours && t === "dark") await shot("combo-palette-dark-colours");
          st().setPalette(false);
          if (!plain(ps)) throw new Fail(`palette scrim ${tag}: ${ps}`);
          st().setSheet({ kind: "new" });
          await sleep(400);
          const sh = [...document.querySelectorAll(".fixed.inset-0.z-50")].find((e) => e.querySelector("form")) ?? null;
          const ss = scrimOf(sh);
          if (colours && t === "light") await shot("combo-newsession-light-colours");
          st().setSheet(null);
          await sleep(300);
          if (!plain(ss)) throw new Fail(`New session scrim ${tag}: ${ss}`);
        }
      }
      setBackdrop("desktop");
      st().setThemePref(keep === "light" || keep === "dark" ? keep : "system");
      await invoke("selftest_resize", { width: 1440, height: 900 });
      if ($("[data-mc-needs]")) throw new Fail("a Needs-you strip is back on Mission control");
      return notes.join("; ");
    });
  },

  async "combo-glass"(ctx) {
    const { setBackdrop, setGlassPref } = await import("./lib/glass");
    const st = () => useStore.getState();
    const keep = localStorage.getItem("coool.theme");
    const key = await browserHost(ctx);
    await step("combo-glass: Jobs, Models, Browser, iPhone over Colours, both themes; the sheet's cut-out follows each panel", async () => {
      setGlassPref(false);
      setBackdrop("colours");
      const bg = document.querySelector("[data-sheet-bg]") as HTMLElement;
      const notes: string[] = [];
      for (const t of ["dark", "light"] as const) {
        st().setThemePref(t);
        for (const kind of ["agents", "models", "browser", "device"] as const) {
          if (kind === "browser") st().openBrowser(key, { kind: "web", url: "https://example.com" });
          st().setRightPanel(key, kind);
          await sleep(120);
          const mid = bg.style.maskImage;
          await sleep(1_100);
          const aside = document.querySelector(`[data-right-panel="${kind}"]`) as HTMLElement | null;
          if (!aside) {
            notes.push(`${kind}: not shown`);
            continue;
          }
          const r = aside.getBoundingClientRect();
          const m = bg.style.maskImage;
          await shot(`combo-glass-${kind}-${t}`, undefined, 200);
          if (!m) throw new Fail(`${kind}/${t}: no cut-out in the sheet with the panel open (${Math.round(r.width)}px)`);
          notes.push(`${kind}/${t} ${Math.round(r.width)}px${mid && mid !== m ? " (cut moved while opening)" : ""}`);
        }
        st().setRightPanel(key, "closed");
        await sleep(1_200);
        if (bg.style.maskImage) throw new Fail(`${t}: the cut-out stayed after the panel closed`);
      }
      setBackdrop("desktop");
      st().setThemePref(keep === "light" || keep === "dark" ? keep : "system");
      return notes.join("; ");
    });
    await step("combo-glass: the Colours drift rests while the window isn't in front and under Reduce motion", async () => {
      setBackdrop("colours");
      await sleep(400);
      const layer = await waitFor("the backdrop", () => document.querySelector<HTMLElement>("[data-backdrop-layer]"), 3_000);
      const rest = layer.dataset.backdropRest !== undefined;
      const focused = document.hasFocus();
      const play = () => getComputedStyle(layer.querySelector(".backdrop-layer")!).animationPlayState;
      const unfocused = play();
      if (!focused && (!rest || unfocused !== "paused")) throw new Fail(`window not in front, drift ${unfocused} (rest ${rest})`);
      setMotionPref("on");
      await sleep(200);
      const reduced = play();
      setMotionPref("auto");
      setBackdrop("desktop");
      if (reduced !== "paused") throw new Fail(`Reduce motion on, drift ${reduced}`);
      return `focused ${focused}, rest ${rest}, drift ${unfocused}; Reduce motion: ${reduced}`;
    });
  },
  /** The window switches: hide / show / focus never give the test window focus unless no switch is set. No model. */
  async "combo-window"() {
    await step("combo-window: hide, show and focus keep the window where its switch puts it", async () => {
      const at = () => `${window.screenX},${window.screenY} focus=${document.hasFocus()} vis=${document.visibilityState}`;
      const start = at();
      await invoke("selftest_window", { action: "hide" });
      await sleep(800);
      const hidden = at();
      await invoke("selftest_window", { action: "show" });
      await sleep(800);
      const shown = at();
      await invoke("selftest_window", { action: "focus" });
      await sleep(800);
      const focused = at();
      return `start ${start}; hidden ${hidden}; shown ${shown}; after focus ${focused}`;
    });
  },
};
Object.assign(scenarios, combo);
// Voice (selftestVoice.ts): fixtures through the real engine, the composer, memory; no microphone, no model calls.
Object.assign(scenarios, voiceScenarios({ step, shot, log, sleep, waitFor, fail: (m) => new Fail(m) }, (cmd, args) => invoke(cmd, args)));

// React StrictMode (dev server) mounts effects twice; two runs would race each
// other in the same window and click each other's cards.
let started = false;

export async function maybeRunSelfTest() {
  if (!isTauri || started) return;
  started = true;
  ({ invoke } = await import("@tauri-apps/api/core"));
  const cfg = (await invoke("selftest_config").catch(() => null)) as Config | null;
  if (!cfg) return;
  // A test's chats start the way it says, never with the person's Settings > General defaults.
  ignoreChatDefaults();
  tap();
  const names = cfg.scenario === "all" ? ALL : cfg.scenario.split(",").map((s) => s.trim());
  await log(`START ${names.join(",")} in ${cfg.dir}`);
  await waitFor("the first sessions payload", () => useStore.getState().ready, 30_000).catch(() => {});
  await sleep(1500);
  // The perf scenarios take no screenshots (and the window must not be disturbed before they measure).
  if (!names.every((n) => n.startsWith("perf-"))) await shot("start");
  const ctx: Ctx = { cfg, main: null, question: null };
  for (const n of names) {
    const f = scenarios[n] ?? (/^inspo-\d+$/.test(n) ? (c: Ctx) => inspo(c, n) : undefined);
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
