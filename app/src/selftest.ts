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
// network for example.com; no model calls).
// Prompts are tiny and run on the cheapest models (Claude Haiku, a small Codex model).

import { newChat } from "./lib/actions";
import { api, isTauri } from "./lib/backend";
import { chatNeeds, useChats, type Chat, type ChatItem } from "./lib/chat";
import type { ArtifactInfo, ChatEvent } from "./lib/types";
import { sessionKey } from "./lib/types";
import { decideMotion, setMotionPref, type MotionHints, type MotionPref } from "./lib/motion";
import { resolveTarget, useStore } from "./store";
import { activeTabKey, nativeId, tabKey, useBrowserState } from "./lib/browser";

interface Config {
  scenario: string;
  dir: string;
  shots: string;
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

/** A screenshot of the main window, or of `window` (an in-app browser pop-up's label). */
async function shot(name: string, window?: string) {
  await sleep(700); // let springs and fades settle
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
  }
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
        if (Math.abs(x + fw / 2 - mx) > 4) bad.push(`not centred: x ${x + fw / 2} vs main ${mx}`);
        if (Math.abs(y + fh / 2 - my) > 24) bad.push(`not centred: y ${y + fh / 2} vs main ${my}`);
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
      // The Needs-you popover and the other theme, while the request is pending.
      const bell = ([...document.querySelectorAll("button[aria-label]")] as HTMLElement[]).find((x) => x.getAttribute("aria-label")!.startsWith("Needs you"));
      if (bell) {
        bell.click();
        await sleep(500);
        await shot("needs-popover");
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
      await step("a note sent during a step is queued under 'Queued for the next step'", async () => {
        id = await startClaude(ctx, "Run these three shell commands one at a time, each as its own tool call, never in parallel: sleep 3; sleep 3; sleep 3. Then reply done.");
        await waitFor("the first step to run", () => running(id), 90_000);
        await say(N1);
        const strip = await waitFor("the queued strip", () => $("[data-steer-queued]"), 5_000);
        if (!/Queued for the next step/.test(strip.textContent ?? "")) throw new Fail(`strip reads "${strip.textContent?.trim()}"`);
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
        const strong = $all("[data-chat-timeline] strong").find((e) => e.textContent === "2.5 GB free of 460 GB");
        const block = strong?.closest("[data-block]") as HTMLElement | null;
        const table = block?.querySelector("table");
        return strong && block && table && table.querySelectorAll("th, td").length === 6 && block.querySelector("pre") ? { strong, block, cells: 6 } : null;
      };
      const got = await waitFor("a rendered reply (strong, 6-cell table, pre)", find, 10_000).catch(async (e) => {
        const strong = $all("[data-chat-timeline] strong").find((x) => x.textContent === "2.5 GB free of 460 GB");
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
