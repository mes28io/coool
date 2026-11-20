// Self-test `readme-shots`: the README's screenshots, taken from the real window (app/scripts/readme-shots/run.sh
// makes the invented workspace, runs this and copies the pictures to docs/media). No model calls: the sessions are
// transcripts in the workspace's HOME, read through the normal discovery, and the two chats talk to the stand-in
// `claude` (app/scripts/readme-shots/standin-claude.py) over the real stream-json protocol.
//
// Each shot waits for what it shows (the sessions listed, the commit trail, the permission card, the subagents) and
// never for pixel positions, so changes to the composer or the rail don't break it.
//
// Shots (`real-readme-<name>.png` in COOOL_SELFTEST_SHOTS): mission-dark, mission-light, approval-dark, needs-dark,
// agents-dark.

import { newChat } from "./lib/actions";
import { useChats } from "./lib/chat";
import { setBackdrop, setGlassPref } from "./lib/glass";
import { sessionKey } from "./lib/types";
import { useStore } from "./store";

export interface ReadmeKit {
  dir: string;
  shot: (name: string, settle?: number) => Promise<unknown>;
  log: (line: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
}

const $ = (s: string) => document.querySelector<HTMLElement>(s);
const $all = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

export function readmeScenarios(k: ReadmeKit): Record<string, () => Promise<void>> {
  const { dir, shot, sleep, waitFor, step } = k;
  const chats = () => useChats.getState().chats;
  const ids = () => new Set(Object.keys(chats()).map(Number));
  const sessionOfChat = (id: number) => useStore.getState().sessions.find((s) => s.chat === id);

  async function start(cwd: string, mode: string, prompt: string): Promise<number> {
    const before = ids();
    await newChat({ provider: "claude", cwd, model: "opus", permissionMode: mode, prompt });
    // Boxed: chat ids start at 0.
    const found = await waitFor("the new chat", () => {
      const id = [...ids()].find((i) => !before.has(i));
      return id === undefined ? null : { id };
    }, 15_000);
    return found.id;
  }

  /** The window as a person would leave it: theme, frosted glass over the desktop, no sheet or toast open. */
  async function look(theme: "dark" | "light") {
    setGlassPref(true);
    setBackdrop("desktop");
    useStore.getState().setThemePref(theme);
    useStore.getState().setSheet(null);
    for (const t of useStore.getState().toasts ?? []) useStore.getState().dismissToast(t.id);
    (document.activeElement as HTMLElement | null)?.blur?.();
    await sleep(900);
  }

  return {
    async "readme-shots"() {
      let invoices = -1;
      let audit = -1;
      await step("readme: the invented sessions are listed", async () => {
        await waitFor("the sessions", () => useStore.getState().sessions.length >= 12, 60_000);
        await look("dark");
        return `${useStore.getState().sessions.length} sessions`;
      });
      await step("readme: two chats on the stand-in CLI (a permission request, three subagents)", async () => {
        invoices = await start(`${dir}/invoices`, "acceptEdits", "Why do invoices from March show the wrong month?");
        await waitFor("the permission request", () => chats()[invoices]?.pendingPermission, 60_000);
        audit = await start(`${dir}/atlas-api`, "default", "Audit every /v2 route for handlers that skip the auth layer. Use one agent per route group and fix what they find.");
        await waitFor("three subagents at work", () => {
          const tools = (chats()[audit]?.items ?? []).filter((i) => i.kind === "tool");
          return tools.filter((i) => i.name === "Agent").length >= 3 && tools.filter((i) => i.parent).length >= 8;
        }, 60_000);
        await waitFor("both chats listed", () => sessionOfChat(invoices) && sessionOfChat(audit), 60_000);
        await sleep(6000);
        return "ok";
      });
      await step("readme: Mission control, dark and light", async () => {
        useStore.getState().activate(null);
        const tab = await waitFor("the atlas-api tab", () => $all("[data-mc-tab]").find((t) => t.dataset.mcSwitchTo === "atlas-api"), 30_000);
        if (tab.getAttribute("aria-selected") !== "true") tab.click();
        await waitFor("the commit trail", () => /Read limiter budgets from config/.test(text($("[data-mc-trail]"))), 30_000);
        await look("dark");
        await sleep(2500);
        await shot("readme-mission-dark", 1200);
        await look("light");
        await sleep(1500);
        await shot("readme-mission-light", 1200);
        await look("dark");
        return text($("[data-mc-trail]")).slice(0, 160);
      });
      await step("readme: the permission request in its chat", async () => {
        useStore.getState().open({ kind: "chat", id: invoices });
        await waitFor("the card", () => $("[data-chat-timeline]") && $("[data-allow-once]"), 20_000);
        await sleep(2500);
        await shot("readme-approval-dark", 1200);
      });
      await step("readme: the Needs you page", async () => {
        const s = await waitFor("the chat's session", () => sessionOfChat(invoices), 20_000);
        useStore.getState().openNeeds(sessionKey(s));
        await waitFor("the detail", () => $("[data-needs-detail]"), 20_000);
        await sleep(2500);
        await shot("readme-needs-dark", 1200);
        useStore.getState().closeNeeds();
      });
      await step("readme: a chat with three subagents at work", async () => {
        useStore.getState().open({ kind: "chat", id: audit });
        await waitFor("the chat", () => $("[data-chat-timeline]"), 20_000);
        await sleep(2500);
        await shot("readme-agents-dark", 1200);
      });
    },
  };
}
