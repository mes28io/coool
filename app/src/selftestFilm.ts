// Self-test `film` / `film-measure`: motion footage of the real window for the launch film, on the invented workspace
// of app/scripts/readme-shots (film.sh builds it, runs this and assembles the video). No model calls: the chats talk
// to the stand-in `claude` (standin-claude.py), which drives the Browser and iPhone panels through coool's own
// `coool-device` MCP server, and the workspace's live process (film_live.py) makes moments happen when this logs
// `CUE <name>` (a session starting in a terminal, an overlap, sessions waiting, commits, a push, a merge).
//
// Each burst (`selftest_film`, app/src-tauri/src/selftest/film.rs) records window-alone stills back to back into
// `<shots>/film-<name>/`; `FILMMARK <burst> <label> <json>` lines note moments (and element rectangles, CSS px from
// the window's top-left) for the assembler's stills and crops.
//
// The provider logos are hidden in every shot (the film may not show the Claude or OpenAI marks); everything else is
// the app as it is.
//
// `film-measure`: how fast window-alone stills come (bursts with 1-6 workers and png / jpg / bmp).

import { newChat } from "./lib/actions";
import { api } from "./lib/backend";
import { chatPanelKey } from "./lib/browserAgent";
import { useChats } from "./lib/chat";
import { useUpdates } from "./lib/update";
import { setBackdrop, setGlassPref } from "./lib/glass";
import { sessionKey } from "./lib/types";
import { resolveTarget, useStore } from "./store";

export interface FilmKit {
  dir: string;
  site?: string | null;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  shot: (name: string, settle?: number) => Promise<unknown>;
  log: (line: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
}

const $ = (s: string, root: ParentNode = document) => root.querySelector<HTMLElement>(s);
const $all = (s: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(s)];
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const button = (label: string | RegExp, root: ParentNode = document) =>
  $all("button", root).find((b) => (typeof label === "string" ? text(b) === label || text(b).startsWith(label) : label.test(text(b)))) ?? null;
const rect = (el: Element | null | undefined) => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
};

/** Types `t` into the chat composer a few characters at a time, as a person would, then sends it (Enter). */
async function typeOut(t: string, sleep: (ms: number) => Promise<unknown>) {
  const ta = $all("[data-main] textarea").filter((x) => !x.closest("form") && !x.closest(".xterm"));
  const el = ta[ta.length - 1] as HTMLTextAreaElement | undefined;
  if (!el) throw new Error("no chat composer on screen");
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  for (let i = 1; i <= t.length; i += 2) {
    set.call(el, t.slice(0, i));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(28);
  }
  set.call(el, t);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(500);
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

/**
 * Plays the page `s` times slower than real time: its CSS and Web animations (spinners, fades, springs run as Web
 * Animations), and the clock JS animations read (`performance.now`, requestAnimationFrame's timestamps). Timers and
 * `Date.now` keep real time (the ages the app shows are real).
 */
function dilate(s: number, what = "all") {
  if (s <= 1) return;
  const rate = 1 / s;
  setInterval(() => {
    for (const a of document.getAnimations()) if (a.playbackRate > 0 && a.playbackRate !== rate) a.playbackRate = rate;
  }, 5);
  if (what !== "all") return;
  const realNow = performance.now.bind(performance);
  const base = realNow();
  performance.now = () => base + (realNow() - base) / s;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((ts) => cb(base + (ts - base) / s));
}

export function filmScenarios(k: FilmKit): Record<string, () => Promise<void>> {
  const { invoke, sleep, waitFor, step, log, dir } = k;
  const film = (action: string, a: Record<string, unknown> = {}) => invoke("selftest_film", { action, ...a }) as Promise<{ frames?: number; ms?: number; slow?: number; dilate?: string }>;
  const chats = () => useChats.getState().chats;
  const ids = () => new Set(Object.keys(chats()).map(Number));
  const sessionOfChat = (id: number) => useStore.getState().sessions.find((s) => s.chat === id);
  const sessions = () => useStore.getState().sessions;
  /** `film` runs its scene `slow` times slower than real time (`COOOL_FILM_SLOW`); waits in scene time. */
  let slow = 1;
  const fsleep = (ms: number) => sleep(ms * slow);
  const fwait = <T,>(what: string, f: () => T | null | undefined | false, ms = 60_000) => waitFor(what, f, ms * slow);

  let current = "";
  /** A moment in the running burst, with the rectangles of `els` (name -> element). */
  async function mark(label: string, els: Record<string, Element | null | undefined> = {}) {
    const r: Record<string, number[] | null> = {};
    for (const [n, e] of Object.entries(els)) r[n] = rect(e);
    await log(`FILMMARK ${current} ${label} ${JSON.stringify(r)}`);
  }
  async function burst(name: string, f: () => Promise<void>) {
    current = name;
    await film("start", { name, format: "png" });
    try {
      await f();
    } finally {
      const r = await film("stop");
      await log(`INFO burst ${name}: ${r.frames} frames in ${r.ms} ms = ${((r.frames! * 1000) / r.ms!).toFixed(1)} fps`);
    }
  }
  const cue = (name: string) => log(`CUE ${name}`);

  async function start(cwd: string, prompt: string, mode = "default"): Promise<number> {
    const before = ids();
    await newChat({ provider: "claude", cwd, model: "opus", permissionMode: mode, prompt });
    const found = await waitFor("the new chat", () => {
      const id = [...ids()].find((i) => !before.has(i));
      return id === undefined ? null : { id };
    }, 15_000);
    return found.id;
  }

  /** The window as a person would leave it, minus the provider logos. */
  async function look(theme: "dark" | "light") {
    setGlassPref(true);
    setBackdrop("desktop");
    useStore.getState().setThemePref(theme);
    useStore.getState().setSheet(null);
    for (const t of useStore.getState().toasts ?? []) useStore.getState().dismissToast(t.id);
    (document.activeElement as HTMLElement | null)?.blur?.();
    await sleep(900);
  }
  function hideLogos() {
    const s = document.createElement("style");
    s.dataset.filmNoLogos = "";
    s.textContent = `[role="img"][aria-label="Claude"], [role="img"][aria-label="Codex (OpenAI)"] { visibility: hidden !important; }`;
    document.head.appendChild(s);
  }

  async function missionTab(project: string) {
    useStore.getState().closeNeeds();
    useStore.getState().activate(null);
    const tab = await waitFor(`the ${project} tab`, () => $all("[data-mc-tab]").find((t) => t.dataset.mcSwitchTo === project), 30_000);
    if (tab.getAttribute("aria-selected") !== "true") tab.click();
    await waitFor("the commit trail", () => $("[data-mc-trail]"), 30_000);
  }
  const mcHas = (t: string) => text($("[data-mc-sessions]")).includes(t) || text($("[data-mission]")).includes(t);

  function activePanelKey(): string | null {
    const st = useStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTab);
    const leaf = tab && (tab.root.type === "leaf" ? tab.root : null);
    if (!leaf?.target) return null;
    const r = resolveTarget(leaf.target, st);
    return r.session ? sessionKey(r.session) : r.chat !== null ? `chat:${r.chat}` : null;
  }

  /** Answers coool's device gate for this chat ("this chat"), and any CLI permission card with Allow once. */
  function autoAnswer(): () => void {
    const seen = new Set<string>();
    const t = setInterval(() => {
      const dev = $("[data-device-approval]");
      if (dev && !seen.has(dev.dataset.approval ?? "")) {
        seen.add(dev.dataset.approval ?? "");
        void mark("device-ask", { card: dev });
        setTimeout(() => (($('[data-remember="chat"]', dev) as HTMLElement | null) ?? button("Allow once", dev))?.click(), 1400 * slow);
      }
    }, 100);
    return () => clearInterval(t);
  }

  return {
    async "film-measure"() {
      await step("film: the sessions are listed", async () => {
        await waitFor("the sessions", () => useStore.getState().sessions.length >= 12, 60_000);
        await film("visible");
        await sleep(3000);
      });
      for (const [workers, format] of [[2, "png"], [3, "png"], [4, "png"], [3, "jpg"], [3, "bmp"]] as const) {
        await step(`film: burst ${workers}x ${format}`, async () => {
          await film("start", { name: `m-${workers}-${format}`, workers, format });
          await sleep(5000);
          const r = await film("stop");
          return `${r.frames} frames in ${r.ms} ms = ${((r.frames! * 1000) / r.ms!).toFixed(1)} fps`;
        });
      }
    },

    // A check of the slowed-down page: a chat's last reply and its turn's end must still show.
    async "film-probe"() {
      await step("film-probe: a chat's reply shows with the page slowed down", async () => {
        await waitFor("the sessions", () => sessions().length >= 12, 60_000);
        const v = await film("visible");
        slow = v.slow ?? 1;
        dilate(slow, v.dilate);
        const id = await start(`${dir}/invoices`, "Invoices from March still look wrong in the export. Check it.", "acceptEdits");
        useStore.getState().open({ kind: "chat", id });
        await waitFor("the card", () => $("[data-allow-once]"), 60_000);
        $("[data-allow-once]")?.click();
        await sleep(15_000);
        const items = chats()[id]?.items ?? [];
        const store = items.filter((i) => i.kind === "text").map((i) => ((i as { text?: string }).text ?? "").slice(0, 30));
        const dom = text($("[data-chat-timeline]"));
        const anims = document.getAnimations().map((a) => `${a.playState}@${Math.round(Number(a.currentTime ?? -1))}/${a.playbackRate}:${(a.effect as KeyframeEffect | null)?.target?.className?.toString().slice(0, 40) ?? "?"}`).slice(0, 30);
        await log(`INFO probe store=${JSON.stringify(store)} domHasReply=${/tests pass/.test(dom)} running=${chats()[id]?.running} anims=${JSON.stringify(anims)}`);
        if (!/tests pass/.test(dom)) throw new Error("the reply is not on screen");
      });
    },

    async film() {
      await step("film: the invented sessions are listed", async () => {
        await fwait("the sessions", () => sessions().length >= 12, 60_000);
        const v = await film("visible");
        slow = v.slow ?? 1;
        dilate(slow, v.dilate);
        hideLogos();
        await log(`INFO updates ${JSON.stringify(useUpdates.getState().status).slice(0, 600)}`);
        await look("dark");
        await fsleep(4000);
        return `${sessions().length} sessions`;
      });

      // 1. Both CLIs in one window; a session started in a terminal shows up live, then a Codex one.
      await step("film: terminal sessions appear live in Mission control (mc-terminal)", async () => {
        await missionTab("atlas-api");
        await fsleep(2500);
        await burst("mc-terminal", async () => {
          await fsleep(2500);
          await mark("before", { sessions: $("[data-mc-sessions]"), sidebar: $("[data-sidebar-view]") });
          await cue("terminal");
          await fwait("the terminal session's row", () => mcHas("Add request IDs"), 20_000);
          const row = $all("[data-mc-session]").find((r) => text(r).includes("Add request IDs"));
          await mark("claude-row", { row, sessions: $("[data-mc-sessions]") });
          await fsleep(4000);
          await cue("terminal-codex");
          await fwait("the Codex session's row", () => mcHas("Document the v3 error"), 20_000);
          const crow = $all("[data-mc-session]").find((r) => text(r).includes("Document the v3 error"));
          await mark("codex-row", { row: crow, sessions: $("[data-mc-sessions]") });
          await fsleep(5000);
          await mark("end", { sessions: $("[data-mc-sessions]") });
        });
        return text($("[data-mc-sessions]")).slice(0, 200);
      });

      // 2. Two agents, one file: the overlap marks and the "Both editing" row appear.
      await step("film: the overlap warning appears (overlap)", async () => {
        await burst("overlap", async () => {
          await fsleep(2500);
          await mark("before", { ledger: $("[data-mc-ledger]") });
          await cue("overlap");
          await fwait("the overlap row", () => $("[data-mc-overlap]"), 20_000);
          await mark("overlap-row", { overlap: $("[data-mc-overlap]"), ledger: $("[data-mc-ledger]"), marks: $("[data-overlap-mark]") });
          await fsleep(1500);
          const marks = $all("[data-overlap-mark]");
          await mark("sidebar-marks", Object.fromEntries(marks.map((m, i) => [`mark${i}`, m.closest("[data-session-row]") ?? m])));
          await fsleep(3500);
        });
        return text($("[data-mc-overlap]"));
      });

      // 4 (before the needs, which move sessions on). What they did: commits, a push, a merge, in two projects.
      await step("film: changes and the commit trail update in two projects (changes)", async () => {
        await burst("changes", async () => {
          await fsleep(2000);
          await mark("before", { trail: $("[data-mc-trail]"), ledger: $("[data-mc-ledger]") });
          await cue("commit-atlas");
          await fwait("the atlas commit on the trail", () => /Return 429 when a key is over budget/.test(text($("[data-mc-trail]"))), 30_000);
          await mark("atlas-commit", { trail: $("[data-mc-trail]"), ledger: $("[data-mc-ledger]") });
          await fwait("the push in the ledger", () => /Pushed|push/i.test(text($("[data-mc-ledger]"))), 20_000).catch(() => null);
          await mark("atlas-push", { trail: $("[data-mc-trail]"), ledger: $("[data-mc-ledger]") });
          await fsleep(3000);
          const tab = $all("[data-mc-tab]").find((t) => t.dataset.mcSwitchTo === "pixelforge");
          tab?.click();
          await mark("tab-pixelforge", { tab });
          await fsleep(2500);
          await cue("commit-pixel");
          await fwait("the pixelforge merge on the trail", () => /Merged ?wgpu-port/.test(text($("[data-mc-trail]"))) && !$("[data-mc-committing]"), 40_000);
          await mark("pixel-merge", { trail: $("[data-mc-trail]"), ledger: $("[data-mc-ledger]") });
          await fsleep(4000);
        });
        return text($("[data-mc-trail]")).slice(0, 200);
      });

      // 3. Requests that explain themselves, in one place.
      let invoices = -1;
      await step("film: the Needs you page fills, one request is read and allowed (needs)", async () => {
        invoices = await start(`${dir}/invoices`, "Why do invoices from March show the wrong month?", "acceptEdits");
        // A Codex chat too (the stand-in `codex app-server`): it asks to force-push a rebased branch.
        const before = ids();
        await newChat({ provider: "codex", cwd: `${dir}/atlas-api`, model: "gpt-5.6", prompt: "Rebase the v3 errors branch on main and push it." });
        const codex = (await fwait("the Codex chat", () => { const i = [...ids()].find((x) => !before.has(x)); return i === undefined ? null : { i }; }, 15_000)).i;
        useStore.getState().openNeeds(null);
        await fwait("the Needs page", () => $("[data-needs-page]"), 10_000);
        await burst("needs", async () => {
          await fsleep(1200);
          await mark("start", { list: $("[data-needs-list]") });
          await fwait("the chats' requests", () => chats()[invoices]?.pendingPermission && $all("[data-needs-item]").length >= 1, 30_000);
          await mark("first-item", { list: $("[data-needs-list]") });
          await fsleep(1500);
          await cue("needs");
          await fwait("four requests", () => $all("[data-needs-item]").length >= 4, 20_000).catch(() => log(`WARN needs: ${$all("[data-needs-item]").length} items; codex chat ${JSON.stringify(chats()[codex]?.pendingPermission ?? null).slice(0, 120)}`));
          await mark("all-items", { list: $("[data-needs-list]") });
          await fsleep(1800);
          const s = sessionOfChat(invoices);
          const item = $all("[data-needs-item]").find((i) => text(i).includes("rm -rf node_modules") || text(i).includes("Why do invoices"));
          if (item) item.click();
          else if (s) useStore.getState().openNeeds(sessionKey(s));
          await fwait("the detail of the rm -rf request", () => /rm -rf/.test(text($("[data-needs-detail]"))), 10_000);
          await fsleep(500);
          const detail = $("[data-needs-detail]");
          await mark("detail", { detail, why: $("[data-needs-why]", detail ?? document), command: $("[data-needs-command]", detail ?? document), allow: $("[data-allow-once]", detail ?? document), risky: $all("span", detail ?? document).find((x) => text(x) === "Risky") ?? null });
          await fsleep(4000);
          const allow = $("[data-allow-once]", detail ?? document);
          await mark("allow-click", { allow });
          allow?.click();
          await fwait("the request gone", () => !$all("[data-needs-item]").some((i) => text(i).includes("rm -rf node_modules")), 10_000);
          await mark("answered", { list: $("[data-needs-list]") });
          await fsleep(3500);
        });
        useStore.getState().closeNeeds();
        return `${$all("[data-needs-item]").length} left`;
      });

      // A chat streaming steps, its permission card arriving and allowed (a second invoices question).
      await step("film: a chat streams, asks, is allowed and finishes (chat-approval)", async () => {
        const id = await start(`${dir}/invoices`, "Invoices from March still look wrong in the export. Check it.", "acceptEdits");
        useStore.getState().open({ kind: "chat", id });
        await burst("chat-approval", async () => {
          await fwait("the card", () => $("[data-chat-timeline]") && $("[data-allow-once]"), 40_000);
          await mark("card", { card: $("[data-approval]"), allow: $("[data-allow-once]"), timeline: $("[data-chat-timeline]") });
          await fsleep(3500);
          await mark("allow-click", { allow: $("[data-allow-once]") });
          $("[data-allow-once]")?.click();
          await fwait("the reply after the tests", () => (chats()[id]?.items ?? []).some((i) => i.kind === "text" && /tests pass/.test((i as { text?: string }).text ?? "")), 20_000).catch(() => null);
          await fsleep(3000);
          await mark("end", { timeline: $("[data-chat-timeline]") });
        });
      });

      // Sub-agents at work.
      await step("film: a lead with three subagents (agents)", async () => {
        const id = await start(`${dir}/atlas-api`, "Audit every /v2 route for handlers that skip the auth layer. Use one agent per route group and fix what they find.");
        useStore.getState().open({ kind: "chat", id });
        await burst("agents", async () => {
          await fwait("three subagents at work", () => (chats()[id]?.items ?? []).filter((i) => i.kind === "tool" && i.parent).length >= 8, 60_000);
          await mark("agents", { timeline: $("[data-chat-timeline]") });
          await fsleep(3000);
        });
        await api().chatStop(id);
      });

      // 5. Its own browser: the stand-in agent drives the Browser panel on a local invented page.
      await step("film: an agent drives the Browser panel (browser)", async () => {
        if (!k.site) throw new Error("no COOOL_SELFTEST_SITE");
        const stop = autoAnswer();
        try {
          const before = ids();
          await newChat({ provider: "claude", cwd: `${dir}/atlas-api`, model: "opus", permissionMode: "default" });
          const id = (await fwait("the new chat", () => ([...ids()].find((i) => !before.has(i)) ?? -1) >= 0 && { id: [...ids()].find((i) => !before.has(i))! }, 15_000)).id;
          await fwait("ready", () => chats()[id]?.ready, 60_000);
          await fwait("the chat on screen", () => $("[data-chat-timeline]"), 20_000);
          await fsleep(1500);
          await burst("browser", async () => {
            await fsleep(800);
            await mark("typing", { composer: $("[data-main] textarea") });
            await typeOut(`In the Browser panel, open ${k.site} and create an API key named ci-runner with a 60 / min budget.`, fsleep);
            await fwait("the panel driven", () => $("[data-browser-driving]"), 30_000).catch(() => log("WARN browser: no driving mark"));
            await mark("driving", { panel: $("[data-right-panel]") });
            await fwait("the turn's end", () => !chats()[id]?.running || /ci-runner/.test(text($("[data-chat-timeline]")).split("Done:")[1] ?? ""), 90_000);
            await fsleep(3500);
            await mark("end", { panel: $("[data-right-panel]"), timeline: $("[data-chat-timeline]") });
          });
          void chatPanelKey;
          void activePanelKey;
        } finally {
          stop();
        }
      });

      // 5b. Its own phone: the test's own simulator ("coool selftest iPhone", deleted afterwards) in the iPhone panel.
      await step("film: an agent drives the iPhone panel (iphone)", async () => {
        const list = await api().simDevices();
        if (!list.available) throw new Error(`no simulators: ${list.reason}`);
        const udid = await api().simEnsureDevice();
        await api().simBoot(udid);
        const stop = autoAnswer();
        try {
          const before = ids();
          await newChat({ provider: "claude", cwd: `${dir}/notes-ios`, model: "opus", permissionMode: "default" });
          const id = (await fwait("the new chat", () => ([...ids()].find((i) => !before.has(i)) ?? -1) >= 0 && { id: [...ids()].find((i) => !before.has(i))! }, 15_000)).id;
          await fwait("ready", () => chats()[id]?.ready, 60_000);
          await fwait("the chat on screen", () => $("[data-chat-timeline]"), 20_000);
          await fsleep(1000);
          const key = await fwait("the pane's panel key", activePanelKey, 10_000);
          useStore.getState().setRightPanel(key, "device");
          await fwait("the booted device in the panel", () => $(`[data-sim-screen="${udid}"]`) && $('[data-device-panel="Booted"]'), 60_000);
          // A freshly booted simulator draws its home screen icons a while after it boots.
          await sleep(20_000);
          await burst("iphone", async () => {
            await fsleep(800);
            await typeOut("On the iPhone in the panel, open Settings and read the iOS version in General > About.", fsleep);
            await fwait("the phone driven", () => $("[data-sim-driving]"), 40_000).catch(() => null);
            await mark("driving", { panel: $("[data-right-panel]") });
            await fwait("the turn's end", () => !chats()[id]?.running || (chats()[id]?.items ?? []).some((i) => i.kind === "text" && /iOS version:|failed/.test((i as { text?: string }).text ?? "")), 90_000);
            await fsleep(3000);
            await mark("end", { panel: $("[data-right-panel]") });
          });
          useStore.getState().setRightPanel(chatPanelKey(id), "closed");
        } finally {
          stop();
          await fsleep(500);
          await invoke("selftest_sim_delete").catch(() => null);
        }
      });

      // Cutaways: the theme switch on Mission control, and Mission control in light.
      await step("film: the light / dark switch (theme)", async () => {
        await missionTab("atlas-api");
        await fsleep(2000);
        await burst("theme", async () => {
          await fsleep(1500);
          await mark("to-light");
          useStore.getState().setThemePref("light");
          await fsleep(3000);
          await mark("to-dark");
          useStore.getState().setThemePref("dark");
          await fsleep(3000);
        });
      });
      await step("film: Mission control in light, live (mc-light)", async () => {
        await look("light");
        await burst("mc-light", async () => {
          await fsleep(8000);
          await mark("end", { sessions: $("[data-mc-sessions]"), trail: $("[data-mc-trail]"), ledger: $("[data-mc-ledger]") });
        });
        await look("dark");
      });
    },
  };
}
