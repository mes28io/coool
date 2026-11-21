// Self-test `restart` (CHAT_SPEC "Restart"): a chat's Restart, in the real app with the stand-in CLIs of
// app/scripts/readme-shots (no model, no network, no account), set up by app/scripts/restart-e2e.sh. Run once with the
// chat host on (COOOL_CHAT_HOST_DIR set: the chat restarts in its host) and once without (inside coool).
//
//   1. A Claude chat is asked for the "settings demo": the stand-in edits its MCP config and replies "restart Claude
//      Code, then come back and type continue" (saying its pid and session).
//   2. "Restart and continue" shows under that reply. Pressed: the old CLI process is gone, a new one runs with
//      `--resume <the same session>`, "continue" is sent, and the reply (from the new pid, the same session) arrives in
//      the same chat, tab and pane, with the earlier messages still on screen and no "process has ended" line.
//   3. `/restart` typed while a turn runs asks first ("Claude is working. Restart anyway?"); Restart there stops the
//      step and starts the CLI again (a new pid, the same session, the chat running and idle).

import { newChat } from "./lib/actions";
import { api } from "./lib/backend";
import { useChats, type ChatItem } from "./lib/chat";
import { sessionKey } from "./lib/types";
import { leaves, useStore } from "./store";

export interface RestartKit {
  dir: string;
  shot: (name: string, settle?: number) => Promise<unknown>;
  log: (line: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

interface Launch {
  args: string[];
  ps: string;
  pid: number | null;
}
interface Pids {
  chats: { id: number; pid: number | null; hosted: boolean; running: boolean }[];
  hosts: number[];
  keep: boolean;
}

type Text = Extract<ChatItem, { kind: "text" }>;
const items = (id: number) => useChats.getState().chats[id]?.items ?? [];
const replies = (id: number) => items(id).filter((i): i is Text => i.kind === "text" && !i.parent && !i.streaming);
const said = (t: string) => {
  const m = /stand-in pid (\d+), session ([0-9a-f-]+)/.exec(t);
  return m ? { pid: Number(m[1]), session: m[2] } : null;
};

function composer(): HTMLTextAreaElement {
  const ta = [...document.querySelectorAll<HTMLTextAreaElement>(".composer-dock textarea")].filter((t) => t.offsetParent !== null);
  if (!ta.length) throw new Error("no chat composer on screen");
  return ta[ta.length - 1];
}

/** The pane showing chat `id` in the active tab (its leaf id), if any. */
function paneOf(id: number): string | null {
  const st = useStore.getState();
  const tab = st.tabs.find((t) => t.id === st.activeTab);
  if (!tab) return null;
  const s = st.sessions.find((x) => x.chat === id);
  const key = s ? sessionKey(s) : null;
  const leaf = leaves(tab.root).find((l) => (l.target?.kind === "chat" && l.target.id === id) || (key !== null && l.target?.kind === "session" && l.target.key === key));
  return leaf ? `${tab.id}/${leaf.id}` : null;
}

export function restartScenarios(k: RestartKit): Record<string, () => Promise<void>> {
  const launch = (chat: number) => k.invoke("selftest_chat_launch", { chat }) as Promise<Launch>;
  const alive = async (pid: number) => !!(await k.invoke("selftest_keepalive", { action: "alive", pid }));
  const pids = () => k.invoke("selftest_keepalive", { action: "pids" }) as Promise<Pids>;

  return {
    async restart() {
      let id = -1;
      let first: { pid: number; session: string } | null = null;
      let pane: string | null = null;
      await k.step("restart: an agent's reply asks for a restart and the button shows under it", async () => {
        const before = new Set(Object.keys(useChats.getState().chats).map(Number));
        const ok = await newChat({ provider: "claude", cwd: k.dir, prompt: "settings demo: add the notes MCP server", model: null, permissionMode: null });
        if (!ok) throw new Error("couldn't start the chat");
        id = (await k.waitFor("the new chat", () => {
          const i = Object.keys(useChats.getState().chats).map(Number).find((x) => !before.has(x));
          return i === undefined ? null : { i };
        }, 20_000)).i;
        const r = await k.waitFor("the reply asking for a restart", () => replies(id).find((t) => /restart Claude Code/i.test(t.text)), 30_000);
        first = said(r.text);
        if (!first) throw new Error(`the reply doesn't say its pid: ${r.text}`);
        const l = await launch(id);
        if (l.pid !== first.pid) throw new Error(`the chat's CLI is pid ${l.pid}, the reply says ${first.pid}`);
        await k.waitFor("Restart and continue", () => document.querySelector(`[data-chat-timeline="${id}"] [data-restart-offer="idle"] button`), 10_000);
        if (!document.querySelector("[data-restart-button]")) throw new Error("no Restart button in the chat's header");
        pane = paneOf(id);
        const p = (await pids()).chats.find((c) => c.id === id);
        await k.shot("restart-offer");
        return `pid ${first.pid}, session ${first.session.slice(0, 8)}, ${p?.hosted ? "in the chat host" : "inside coool"}, pane ${pane}`;
      });
      if (id < 0 || !first) return;
      const was = first as { pid: number; session: string };

      await k.step("restart: Restart and continue ends the old CLI, resumes the same session in a new one, and the reply arrives in the same tab", async () => {
        const n = replies(id).length;
        const hostedBefore = (await pids()).chats.find((c) => c.id === id)?.hosted;
        const btn = document.querySelector<HTMLButtonElement>(`[data-chat-timeline="${id}"] [data-restart-offer] button`);
        if (!btn) throw new Error("the button went away");
        btn.click();
        const r = await k.waitFor("the reply after the restart", () => replies(id).slice(n).find((t) => /Continuing after the restart/.test(t.text)), 30_000);
        const now = said(r.text);
        if (!now) throw new Error(`the reply doesn't say its pid: ${r.text}`);
        if (now.pid === was.pid) throw new Error(`the same CLI process answered (pid ${now.pid})`);
        if (now.session !== was.session) throw new Error(`a different session: ${now.session} (was ${was.session})`);
        if (await alive(was.pid)) throw new Error(`the old CLI (pid ${was.pid}) is still running`);
        const l = await launch(id);
        if (l.pid !== now.pid) throw new Error(`the chat's CLI is pid ${l.pid}, the reply says ${now.pid}`);
        if (!l.args.some((a, i) => a === "--resume" && l.args[i + 1] === was.session)) throw new Error(`not started with --resume ${was.session}: ${l.args.join(" ").slice(0, 300)}`);
        const its = items(id);
        const prompts = its.filter((i) => i.kind === "prompt").map((i) => (i as Extract<ChatItem, { kind: "prompt" }>).text);
        if (!prompts[0]?.startsWith("settings demo") || prompts[prompts.length - 1] !== "continue") throw new Error(`the prompts on screen: ${JSON.stringify(prompts)}`);
        if (its.some((i) => i.kind === "exited")) throw new Error("a \"process has ended\" line stayed in the chat");
        if (!its.some((i) => i.kind === "notice" && /^Restarted Claude Code/.test(i.text))) throw new Error("no restart notice");
        if (!replies(id).some((t) => /restart Claude Code/i.test(t.text))) throw new Error("the earlier reply is gone from the chat");
        if (document.querySelector(`[data-chat-timeline="${id}"] [data-restart-offer]`)) throw new Error("the offer still shows after the restart");
        const c = useChats.getState().chats[id];
        if (!c?.running || c.state !== "idle") throw new Error(`the chat is ${c?.running ? c.state : "not running"}`);
        const p = paneOf(id);
        if (!p || p !== pane) throw new Error(`the chat moved: pane ${p}, was ${pane}`);
        const hosted = (await pids()).chats.find((x) => x.id === id)?.hosted;
        if (hosted !== hostedBefore) throw new Error(`hosted ${hostedBefore} -> ${hosted}`);
        await k.shot("restart-continued");
        return `pid ${was.pid} -> ${now.pid}, session kept, same chat ${id} in pane ${p}, ${hosted ? "restarted in the chat host" : "restarted inside coool"}`;
      });

      await k.step("restart: /restart while a turn runs asks first, then restarts", async () => {
        const n = items(id).filter((i) => i.kind === "turn").length;
        const before = (await launch(id)).pid;
        const ta = composer();
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
        set.call(ta, "slow demo");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        await k.sleep(80);
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        await k.waitFor("the slow step under way", () => items(id).some((i) => i.kind === "tool" && i.name === "Bash" && i.endTs === null), 20_000);
        set.call(composer(), "/restart");
        composer().dispatchEvent(new Event("input", { bubbles: true }));
        await k.sleep(120);
        composer().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        const sheet = await k.waitFor("the confirmation", () => useStore.getState().sheet?.kind === "restart" && [...document.querySelectorAll("div")].find((d) => d.textContent === "Claude is working. Restart anyway?"), 5_000);
        if (!sheet.parentElement?.textContent?.includes("The current step is stopped.")) throw new Error(`the confirmation says: ${sheet.parentElement?.textContent}`);
        const c0 = useChats.getState().chats[id];
        if (!c0 || c0.state === "idle") throw new Error("the turn ended before the confirmation");
        if ((await launch(id)).pid !== before) throw new Error("it restarted without asking");
        await k.shot("restart-ask");
        const go = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Restart" && b.closest(".shadow-pop"));
        if (!go) throw new Error("no Restart button in the confirmation");
        go.click();
        const after = await k.waitFor("the chat running again on a new CLI", () => {
          const c = useChats.getState().chats[id];
          return c?.running && c.state === "idle" && items(id).filter((i) => i.kind === "notice" && /^Restarted/.test(i.text)).length >= 2 ? c : null;
        }, 20_000);
        const l = await launch(id);
        if (!l.pid || l.pid === before) throw new Error(`the CLI is still pid ${l.pid}`);
        if (before && (await alive(before))) throw new Error(`the old CLI (pid ${before}) is still running`);
        const step = items(id).find((i) => i.kind === "tool" && i.name === "Bash");
        if (step?.kind === "tool" && step.endTs === null) throw new Error("the stopped step still shows as running");
        if (!l.args.some((a, i) => a === "--resume" && l.args[i + 1] === after.sessionId)) throw new Error("not resumed");
        await k.shot("restart-after-ask");
        return `asked while working; pid ${before} -> ${l.pid}; ${items(id).filter((i) => i.kind === "turn").length - n} turn(s) since`;
      });

      // The bug of 0.4.4: the old CLI's exit and the restart reached the UI's pump in one batch (the usual case for a
      // hosted chat), the pump took the exit as the chat's end, and nothing after it (the person's messages, the
      // replies) showed until coool was reopened. The pump is held here so they always arrive together, while the
      // chat's subagents stream, and a message is sent while the restart is still under way.
      await k.step("restart: with subagents streaming and the exit and restart arriving together, a message sent during the restart and one after it show and are answered", async () => {
        const before = (await launch(id)).pid;
        await api().chatSend(id, "run the agent fan-out");
        await k.waitFor("the subagents streaming", () => items(id).filter((i) => i.kind === "tool" && !!(i as { parent?: string | null }).parent).length >= 2, 20_000);
        const hold = (on: boolean) => k.invoke("selftest_keepalive", { action: "pump_hold", value: on });
        await hold(true);
        let during = "";
        try {
          const r = api().chatRestart(id, null);
          await k.sleep(60);
          const s = api().chatSend(id, "sent during the restart").then(() => "ok", (e) => `refused: ${String(e).slice(0, 120)}`);
          await r;
          during = await s;
          await k.sleep(400);
        } finally {
          await hold(false);
        }
        if (during !== "ok") throw new Error(`the message sent during the restart was ${during}`);
        const answered = (text: string) => {
          const its = items(id);
          const i = its.findIndex((x) => x.kind === "prompt" && (x as Extract<ChatItem, { kind: "prompt" }>).text === text);
          return i >= 0 && its.slice(i + 1).some((x) => x.kind === "text" && !x.parent && !x.streaming && /Done\./.test(x.text));
        };
        await k.waitFor("the message sent during the restart, shown and answered", () => answered("sent during the restart"), 20_000);
        const ta = composer();
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
        set.call(ta, "one more after the restart");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        await k.sleep(80);
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        await k.waitFor("a message typed after the restart, shown and answered", () => answered("one more after the restart"), 20_000);
        const l = await launch(id);
        if (!l.pid || l.pid === before) throw new Error(`the CLI is still pid ${l.pid}`);
        const c = useChats.getState().chats[id];
        if (!c?.running) throw new Error("the chat shows as ended");
        await k.shot("restart-streams-on");
        return `pid ${before} -> ${l.pid}; both messages shown and answered`;
      });

      // Leave nothing running.
      await api().chatStop(id).catch(() => {});
    },
  };
}
