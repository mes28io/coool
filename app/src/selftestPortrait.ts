// Self-test `portrait`: coool on a portrait screen (lib/layout.ts), in the real window, on the invented workspace of
// app/scripts/readme-shots (a stand-in `claude`, no model calls). Run it with the window already portrait:
//
//   COOOL_SELFTEST=portrait COOOL_SELFTEST_SIZE=1080x1920 (plus run.sh's HOME, PATH and BACKGROUND switches)
//
// It checks, at that size: the layout is stacked; Mission control, a chat, the Needs you page and Settings have no
// horizontal overflow; Mission control is one column; a chat's Browser panel and its Jobs panel sit above the chat at
// the pane's full width; a side-by-side split shows top / bottom. Then it resizes the window to landscape and back
// (`selftest_resize`) and checks the open chat is the same (same tab, its timeline not remounted, the Browser panel
// still chosen, beside then above again) and the reader's place in a scrolled timeline is kept.
//
// Shots (`real-portrait-<name>.png`): mission-dark, mission-light, chat-browser, chat-jobs, split, needs, settings,
// landscape, back.
//
// The iPhone and Mac panels are not opened here: they would list or start simulators and the sandbox VM on the
// machine running the test. Their stacking is the same frame as the Browser's (RightPanel `axis`), checked in the
// browser demo.

import { newChat } from "./lib/actions";
import { useChats } from "./lib/chat";
import { useLayout } from "./lib/layout";
import { sessionKey } from "./lib/types";
import { leaves, useStore } from "./store";

export interface PortraitKit {
  dir: string;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  shot: (name: string, settle?: number) => Promise<unknown>;
  log: (line: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
}

const $ = (s: string) => document.querySelector<HTMLElement>(s);
const $all = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
const rect = (el: Element | null) => el?.getBoundingClientRect() ?? null;

/** Every element on screen that scrolls sideways when it shouldn't, or spills past the window's right edge. */
function overflowX(): string[] {
  const bad: string[] = [];
  const doc = document.scrollingElement as HTMLElement;
  if (doc.scrollWidth > doc.clientWidth + 1) bad.push(`document ${doc.scrollWidth}>${doc.clientWidth}`);
  // Scroll containers that may only scroll vertically (tab strips and chip rows scroll sideways by design).
  for (const el of $all("[data-main], [data-mission], [data-chat-timeline], [data-activity-timeline], [data-needs-list], [data-needs-main], [data-pane-body], [data-right-panel]")) {
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "hidden") bad.push(`${Object.keys(el.dataset)[0] ?? el.tagName} ${el.scrollWidth}>${el.clientWidth}`);
  }
  // Nothing visible past the right edge of the window.
  for (const el of $all("main *, [data-sidebar-open] *, [data-needs-main] *")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.left < innerWidth && r.right > innerWidth + 1) {
      // Clipped by a scrolling or hidden-overflow ancestor: not visible past the edge.
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if ((o === "hidden" || o === "auto" || o === "scroll" || o === "clip") && p.getBoundingClientRect().right <= innerWidth + 1) {
          clipped = true;
          break;
        }
      }
      if (!clipped) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} right=${Math.round(r.right)}`);
    }
    if (bad.length > 6) break;
  }
  return bad;
}

export function portraitScenarios(k: PortraitKit): Record<string, () => Promise<void>> {
  const { dir, invoke, shot, sleep, waitFor, step } = k;
  const chats = () => useChats.getState().chats;
  const ids = () => new Set(Object.keys(chats()).map(Number));
  const sessionOfChat = (id: number) => useStore.getState().sessions.find((s) => s.chat === id);
  const layout = () => document.documentElement.dataset.layout;

  async function start(cwd: string, mode: string, prompt: string): Promise<number> {
    const before = ids();
    await newChat({ provider: "claude", cwd, model: "opus", permissionMode: mode, prompt });
    const found = await waitFor("the new chat", () => {
      const id = [...ids()].find((i) => !before.has(i));
      return id === undefined ? null : { id };
    }, 15_000);
    return found.id;
  }
  async function look(theme: "dark" | "light") {
    useStore.getState().setThemePref(theme);
    useStore.getState().setSheet(null);
    for (const t of useStore.getState().toasts ?? []) useStore.getState().dismissToast(t.id);
    (document.activeElement as HTMLElement | null)?.blur?.();
    await sleep(700);
  }
  async function resize(w: number, h: number, want: "wide" | "stacked") {
    await invoke("selftest_resize", { width: w, height: h });
    await waitFor(`the layout ${want} at ${w}x${h}`, () => layout() === want, 10_000);
    await sleep(1200);
  }
  const noOverflow = (where: string) => {
    const bad = overflowX();
    if (bad.length) throw new Error(`${where}: horizontal overflow: ${bad.join("; ")}`);
  };
  const panelKeyOf = (chat: number) => {
    const s = sessionOfChat(chat);
    return s ? sessionKey(s) : `chat:${chat}`;
  };
  /** The open pane's body, panel and timeline, as on screen. */
  const pane = () => ({ body: rect($("[data-pane-body]")), panel: $("[data-right-panel]"), timeline: $("[data-chat-timeline]") ?? $("[data-activity-timeline]") });

  return {
    async portrait() {
      let invoices = -1;
      let audit = -1;
      await step("portrait: the window is portrait and coool is stacked", async () => {
        await waitFor("the sessions", () => useStore.getState().sessions.length >= 8, 60_000);
        if (useLayout.getState().pref !== "auto") useLayout.getState().setPref("auto");
        if (innerHeight <= innerWidth) await resize(1080, 1920, "stacked");
        await waitFor("stacked", () => layout() === "stacked", 10_000);
        return `${innerWidth}x${innerHeight} (${useStore.getState().sessions.length} sessions, sidebar ${useStore.getState().sidebarWidth}px)`;
      });

      await step("portrait: Mission control is one column with nothing spilling sideways", async () => {
        useStore.getState().activate(null);
        await waitFor("Mission control", () => $("[data-mission]") && $("[data-mc-sessions]"), 30_000);
        await look("dark");
        await sleep(1500);
        noOverflow("Mission control");
        const cards = $all("[data-mission] [data-mc-sessions], [data-mission] [data-mc-ledger], [data-mission] [data-mc-trail]").map((c) => Math.round(c.getBoundingClientRect().left));
        if (new Set(cards).size > 1) throw new Error(`cards in more than one column: lefts ${cards.join(",")}`);
        await shot("portrait-mission-dark", 900);
        await look("light");
        await shot("portrait-mission-light", 900);
        await look("dark");
        return `${cards.length} cards at x=${cards[0]}`;
      });

      await step("portrait: two chats on the stand-in CLI", async () => {
        invoices = await start(`${dir}/invoices`, "acceptEdits", "Why do invoices from March show the wrong month?");
        await waitFor("the permission request", () => chats()[invoices]?.pendingPermission, 60_000);
        audit = await start(`${dir}/atlas-api`, "default", "Audit every /v2 route for handlers that skip the auth layer. Use one agent per route group and fix what they find.");
        await waitFor("three subagents at work", () => (chats()[audit]?.items ?? []).filter((i) => i.kind === "tool" && i.name === "Agent").length >= 3, 60_000);
        await waitFor("both chats listed", () => sessionOfChat(invoices) && sessionOfChat(audit), 60_000);
        return `chats ${invoices}, ${audit}`;
      });

      await step("portrait: a chat's Jobs panel sits above it at full width", async () => {
        useStore.getState().open({ kind: "chat", id: audit });
        await waitFor("the chat", () => $("[data-chat-timeline]"), 20_000);
        const key = panelKeyOf(audit);
        if (useStore.getState().rightPanel[key] !== "agents") useStore.getState().setRightPanel(key, "agents");
        const state = () => {
          const { panel, body } = pane();
          return `rightPanel[${key}]=${useStore.getState().rightPanel[key]}, frame ${panel?.dataset.rightPanel}/${panel?.dataset.panelAxis} ${Math.round(rect(panel)?.height ?? 0)}px, body ${Math.round(body?.width ?? 0)}x${Math.round(body?.height ?? 0)}, jobs button ${!!$all("button").find((b) => /running|Jobs/.test(b.textContent ?? ""))}`;
        };
        const p = await waitFor("the Jobs panel above the chat", () => {
          const { body, panel, timeline } = pane();
          if (!body || !panel || panel.dataset.rightPanel !== "agents" || panel.dataset.panelAxis !== "y" || !timeline) return null;
          const pr = panel.getBoundingClientRect();
          const tr = timeline.getBoundingClientRect();
          return pr.height > 150 && pr.bottom <= tr.top + 1 && Math.abs(pr.width - body.width) <= 2 ? { pr, tr } : null;
        }, 15_000).catch((e) => {
          throw new Error(`${e instanceof Error ? e.message : e} (${state()})`);
        });
        await sleep(800);
        noOverflow("chat with Jobs");
        await shot("portrait-chat-jobs", 1500);
        return `panel ${Math.round(p.pr.width)}x${Math.round(p.pr.height)} above a ${Math.round(p.tr.height)} px timeline`;
      });

      await step("portrait: a device panel (the Browser) stacks above the chat", async () => {
        useStore.getState().open({ kind: "chat", id: invoices });
        await waitFor("the chat", () => $("[data-chat-timeline]"), 20_000);
        const globe = await waitFor("the globe button", () => $all("button[title]").find((b) => /^Show the browser/.test(b.title)), 10_000);
        globe.click();
        const p = await waitFor("the Browser panel above the chat", () => {
          const { body, panel, timeline } = pane();
          if (!body || !panel || panel.dataset.rightPanel !== "browser" || panel.dataset.panelAxis !== "y" || !timeline) return null;
          const pr = panel.getBoundingClientRect();
          const tr = timeline.getBoundingClientRect();
          return pr.height > 300 && pr.bottom <= tr.top + 1 && Math.abs(pr.width - body.width) <= 2 ? { pr, tr } : null;
        }, 15_000);
        await sleep(900);
        noOverflow("chat with the Browser");
        await shot("portrait-chat-browser", 1800);
        return `panel ${Math.round(p.pr.width)}x${Math.round(p.pr.height)}, chat below ${Math.round(p.tr.height)} px`;
      });

      await step("portrait: a side-by-side split shows top and bottom", async () => {
        const st = useStore.getState();
        st.split("row");
        const s2 = useStore.getState();
        const tab = s2.tabs.find((t) => t.id === s2.activeTab)!;
        s2.setPaneTarget(tab.focus, { kind: "chat", id: audit });
        const split = await waitFor("the split shown as a column", () => $("[data-split]"), 10_000);
        if (split.dataset.split !== "col") throw new Error(`split shown as ${split.dataset.split}`);
        const tree = useStore.getState().tabs.find((t) => t.id === useStore.getState().activeTab)!.root;
        if (tree.type !== "split" || tree.dir !== "row") throw new Error("the tree's direction changed");
        await sleep(1200);
        noOverflow("split");
        await shot("portrait-split", 900);
        // Back to one pane, the invoices chat.
        const t3 = useStore.getState().tabs.find((t) => t.id === useStore.getState().activeTab)!;
        if (leaves(t3.root).length > 1) useStore.getState().closePane(t3.focus);
        return "row split drawn top / bottom; the tree keeps row";
      });

      await step("portrait: the Needs you page lists over its detail", async () => {
        const s = await waitFor("the chat's session", () => sessionOfChat(invoices), 20_000);
        useStore.getState().openNeeds(sessionKey(s));
        await waitFor("the detail", () => $("[data-needs-detail]"), 20_000);
        await sleep(1200);
        noOverflow("Needs you");
        const list = rect($("[data-needs-list]"));
        const main = rect($("[data-needs-main]"));
        if (!list || !main || list.bottom > main.top + 1) throw new Error(`list ${JSON.stringify(list)} not over the detail ${JSON.stringify(main)}`);
        await shot("portrait-needs", 900);
        useStore.getState().closeNeeds();
        return `list ${Math.round(list.height)} px over a ${Math.round(main.height)} px detail`;
      });

      await step("portrait: Settings fits, with the Layout choice", async () => {
        useStore.getState().openSettings("appearance");
        await waitFor("the Layout row", () => $all("[data-setting]").find((r) => r.dataset.setting === "layout") ?? $("[data-setting-layout]"), 10_000).catch(() => null);
        await sleep(900);
        noOverflow("Settings");
        const found = /Layout/.test(document.body.textContent ?? "") && /Side by side/.test(document.body.textContent ?? "");
        if (!found) throw new Error("no Layout row in Appearance");
        await shot("portrait-settings", 900);
        useStore.getState().closeSettings();
        return "Automatic / Side by side / Stacked";
      });

      await step("portrait: landscape and back keeps the open chat, its panel and the reader's place", async () => {
        useStore.getState().open({ kind: "chat", id: invoices });
        const tl = await waitFor("the timeline", () => $("[data-chat-timeline]"), 20_000);
        await sleep(800);
        // Its Browser panel showing (above the chat, in portrait).
        if ($("[data-right-panel]")?.dataset.rightPanel !== "browser") $all("button[title]").find((b) => /^Show the browser/.test(b.title))?.click();
        await waitFor("the Browser panel above", () => $("[data-right-panel]")?.dataset.rightPanel === "browser" && $("[data-right-panel]")?.dataset.panelAxis === "y", 10_000);
        await sleep(600);
        (tl as HTMLElement & { __mark?: number }).__mark = 1;
        const tabId = useStore.getState().activeTab;
        // A reader scrolled up, if the chat is long enough to scroll.
        const scrolls = tl.scrollHeight - tl.clientHeight > 120;
        if (scrolls) {
          tl.scrollTop = Math.round((tl.scrollHeight - tl.clientHeight) * 0.4);
          tl.dispatchEvent(new Event("scroll"));
          await sleep(500);
        }
        const topLine = () => {
          const top = tl.getBoundingClientRect().top;
          const el = [...tl.querySelectorAll("p, li, pre, [data-turn-end], img")].find((e) => e.getBoundingClientRect().top >= top - 1);
          return el ? { el, off: Math.round(el.getBoundingClientRect().top - top) } : null;
        };
        const before = topLine();
        const check = (where: string, axis: "x" | "y") => {
          const now = $("[data-chat-timeline]") as (HTMLElement & { __mark?: number }) | null;
          if (now !== tl || now.__mark !== 1) throw new Error(`${where}: the timeline was remounted`);
          if (useStore.getState().activeTab !== tabId) throw new Error(`${where}: another tab is active`);
          const panel = $("[data-right-panel]");
          if (panel?.dataset.rightPanel !== "browser" || panel.dataset.panelAxis !== axis) throw new Error(`${where}: panel ${panel?.dataset.rightPanel} ${panel?.dataset.panelAxis}`);
          if (scrolls && before) {
            const after = topLine();
            if (!after || after.el !== before.el || Math.abs(after.off - before.off) > 6) throw new Error(`${where}: the reader's place moved (${before.off} -> ${after?.el === before.el ? after?.off : "another line"})`);
          }
        };
        await resize(1440, 900, "wide");
        check("landscape", "x");
        noOverflow("landscape");
        await shot("portrait-landscape", 600);
        await resize(1080, 1920, "stacked");
        check("portrait again", "y");
        noOverflow("portrait again");
        await shot("portrait-back", 600);
        return scrolls ? `same timeline, panel beside then above, top line at ${before?.off} px both times` : "same timeline, panel beside then above (the chat is too short to scroll, so the reader's place was not checked)";
      });

      await step("portrait: a scrolled timeline keeps the reader's place across a rotation", async () => {
        // The invoices chat (paused on its permission request, so nothing moves under the reader) in a short landscape
        // window, where it scrolls, read part way up. (The audit chat streams above the view, which moves the line
        // whatever the layout does.)
        useStore.getState().open({ kind: "chat", id: invoices });
        useStore.getState().setRightPanel(panelKeyOf(invoices), "closed");
        await resize(1280, 560, "wide");
        const tl = await waitFor("its timeline", () => $("[data-chat-timeline]"), 20_000);
        await sleep(1500);
        if (tl.scrollHeight - tl.clientHeight < 200) throw new Error(`too short to scroll at 1280x560 (${tl.scrollHeight}/${tl.clientHeight})`);
        tl.scrollTop = Math.round((tl.scrollHeight - tl.clientHeight) * 0.35);
        tl.dispatchEvent(new Event("scroll"));
        await sleep(800);
        const top = () => tl.getBoundingClientRect().top;
        const first = [...tl.querySelectorAll("p, li, pre, button, img")].find((e) => e.getBoundingClientRect().top >= top() - 1 && e.getBoundingClientRect().height > 0);
        if (!first) throw new Error("nothing at the top");
        const off0 = Math.round(first.getBoundingClientRect().top - top());
        const moved: number[] = [];
        // A portrait window short enough that the chat still scrolls in it (a view showing everything has no place to keep).
        for (const [w, h, m] of [[820, 940, "stacked"], [1280, 560, "wide"]] as const) {
          await resize(w, h, m);
          if (!first.isConnected || $("[data-chat-timeline]") !== tl) throw new Error(`${m}: the timeline was remounted`);
          moved.push(Math.round(first.getBoundingClientRect().top - top()) - off0);
        }
        await resize(1080, 1920, "stacked");
        // Portrait rewraps the block at the top to a narrower width, so the line may sit a line or two lower in it (up to
        // 48 px); back in landscape it must be exactly where it was.
        if (Math.abs(moved[0]) > 48 || Math.abs(moved[1]) > 6) throw new Error(`the top line moved ${moved.join(" / ")} px (portrait / landscape again)`);
        return `top line ${off0} px below the view's top; moved ${moved.join(" / ")} px (portrait / landscape again)`;
      });
    },
  };
}
