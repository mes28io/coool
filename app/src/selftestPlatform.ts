// Self-test `platform` (APP_SPEC "Claude Platform"): chats billed to an API key instead of the subscription, in the
// real app with the stand-in CLIs of app/scripts/readme-shots (no model, no network, no account), set up by
// app/scripts/platform-e2e.sh. The debug build's COOOL_PLATFORM_TEST_KEY stands in for the Keychain (an invented key,
// sk-ant-api03-…TEST), and the app runs with an invented CLAUDE_CODE_OAUTH_TOKEN in its environment, which an API-key
// chat must not get. The stand-in says how it is logged in with the key's last four, its key source, and what a command
// it ran sees (counts only), never the key. Run once with the chat host on (COOOL_CHAT_HOST_DIR: the CLI is the host's
// child, and runs the helper from there) and once without.
//
//   1. Settings > Claude Platform: a key added through the form lists as its name and ••TEST; nothing the page gets
//      holds the key.
//   2. A chat on the subscription: no API key, the OAuth variable left alone, no badge.
//   3. A chat on the key: the CLI's `--settings` names coool's executable as its `apiKeyHelper`, the stand-in gets the
//      key by running it, and neither its environment nor a command it runs holds the key (or another login); the
//      header's API badge with the key's name, the turn's cost from the CLI's own count; the command line holds no key.
//   4. A folder default: a chat started there with no choice runs on the key; the New session sheet shows it and can
//      pick the subscription instead.
//   5. Restart, and a resume after a stop, keep the key.
//   6. Removing the key clears the folder default; a new chat there runs on the subscription.

import { newChat, resumeSession } from "./lib/actions";
import { api } from "./lib/backend";
import { useChats, type ChatItem } from "./lib/chat";
import { loadPlatform, SUBSCRIPTION } from "./lib/platform";
import { useStore } from "./store";

export interface PlatformKit {
  dir: string;
  shot: (name: string, settle?: number) => Promise<unknown>;
  log: (line: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

type Text = Extract<ChatItem, { kind: "text" }>;
const items = (id: number) => useChats.getState().chats[id]?.items ?? [];
const replies = (id: number) => items(id).filter((i): i is Text => i.kind === "text" && !i.parent && !i.streaming);
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

export function platformScenarios(k: PlatformKit): Record<string, () => Promise<void>> {
  const launch = (chat: number) => k.invoke("selftest_chat_launch", { chat }) as Promise<{ args: string[]; ps: string; pid: number | null }>;
  const newId = async (before: Set<number>) =>
    (await k.waitFor("the new chat", () => {
      const i = Object.keys(useChats.getState().chats).map(Number).find((x) => !before.has(x));
      return i === undefined ? null : { i };
    }, 20_000)).i;
  const ids = () => new Set(Object.keys(useChats.getState().chats).map(Number));
  const billing = async (id: number, n = 0) => (await k.waitFor("the billing check reply", () => replies(id).slice(n).find((t) => /^Billing check/.test(t.text)), 30_000)).text;
  const start = async (account: string | undefined) => {
    const before = ids();
    if (!(await newChat({ provider: "claude", cwd: k.dir, prompt: "billing check", model: null, permissionMode: null, account }))) throw new Error("couldn't start the chat");
    return newId(before);
  };
  const noKeyIn = (what: string, s: string) => {
    if (/sk-ant-/.test(s)) throw new Error(`${what} holds an API key`);
  };
  // The key came from coool's helper, and neither the CLI's environment nor a command it runs holds it.
  const viaHelper = /api key ••TEST, other logins: none, key source: apiKeyHelper, a command's env: ANTHROPIC_API_KEY×0, the key×0/;

  return {
    async platform() {
      let keyId = "";
      await k.step("platform: Settings > Claude Platform stores a key and lists only its name and last four", async () => {
        await k.waitFor("ready", () => useStore.getState().ready, 60_000);
        useStore.getState().openSettings("platform");
        const name = await k.waitFor("the add form", () => $<HTMLInputElement>("[data-platform-name]"), 10_000);
        const keyField = $<HTMLInputElement>("[data-platform-key]")!;
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        set.call(name, "Work e2e");
        name.dispatchEvent(new Event("input", { bubbles: true }));
        set.call(keyField, "sk-ant-api03-TESTTESTTEST");
        keyField.dispatchEvent(new Event("input", { bubbles: true }));
        await k.sleep(80);
        $<HTMLButtonElement>("[data-platform-add]")!.click();
        await k.waitFor("the key listed", () => [...document.querySelectorAll("[data-setting^='platform-key-']")].find((r) => r.textContent?.includes("Work e2e")), 10_000);
        if (keyField.value) throw new Error("the key stayed in the form");
        const st = await api().platformStatus();
        noKeyIn("platform_status", JSON.stringify(st));
        const kk = st.keys.find((x) => x.name === "Work e2e");
        if (!kk || kk.last4 !== "TEST") throw new Error(`listed as ${JSON.stringify(kk)}`);
        keyId = kk.id;
        if (!document.body.textContent?.includes("••TEST")) throw new Error("the row doesn't show ••TEST");
        noKeyIn("the page", document.body.innerText);
        await k.shot("platform-settings");
        useStore.getState().closeSettings();
        return `key ${keyId} (••TEST)`;
      });
      if (!keyId) return;

      let sub = -1;
      await k.step("platform: a subscription chat gets no API key and its usual environment, and no badge", async () => {
        sub = await start(SUBSCRIPTION);
        const r = await billing(sub);
        if (!/no api key, other logins: CLAUDE_CODE_OAUTH_TOKEN/.test(r)) throw new Error(`the CLI says: ${r}`);
        if (useChats.getState().chats[sub]?.account) throw new Error("the chat reads as an API-key chat");
        if ($(`[data-platform-badge]`)) throw new Error("a badge shows for a subscription chat");
        await api().chatStop(sub).catch(() => {});
        return r;
      });

      let id = -1;
      let firstPid: number | null = null;
      await k.step("platform: a chat on the key gets it from coool's helper (none in its env, no other login), shows the API badge and its cost", async () => {
        id = await start(keyId);
        const r = await billing(id);
        if (!viaHelper.test(r)) throw new Error(`the CLI says: ${r}`);
        const c = await k.waitFor("the chat's account", () => (useChats.getState().chats[id]?.account === keyId ? useChats.getState().chats[id] : null), 10_000);
        const badge = await k.waitFor("the header badge", () => $(`[data-platform-badge="${keyId}"]`), 10_000);
        if (!badge.textContent?.includes("Work e2e")) throw new Error(`the badge says ${badge.textContent}`);
        const cost = await k.waitFor("the cost on the badge", () => $("[data-platform-cost]"), 10_000);
        if (Math.abs(c.costUsd - 0.0125) > 1e-6 && Math.abs(useChats.getState().chats[id].costUsd - 0.0125) > 1e-6) throw new Error(`cost ${useChats.getState().chats[id].costUsd}`);
        const l = await launch(id);
        noKeyIn("the CLI's command line", l.ps + " " + l.args.join(" "));
        const settings = l.args.find((a) => a.startsWith("--settings="));
        const helper = settings ? (JSON.parse(settings.slice("--settings=".length)) as { apiKeyHelper?: string }).apiKeyHelper : undefined;
        if (!helper || !helper.endsWith(` --coool-api-key ${keyId}`)) throw new Error(`no coool key helper on the command line: ${settings}`);
        firstPid = l.pid;
        if (items(id).some((i) => i.kind === "notice" && /Claude Platform/.test(i.text))) throw new Error("a key-source warning showed");
        await k.shot("platform-badge");
        return `${r} · badge "${badge.textContent}" · cost ${cost.textContent}`;
      });
      if (id < 0) return;

      await k.step("platform: restart keeps the key", async () => {
        const n = replies(id).length;
        await api().chatRestart(id, "billing check");
        const r = await billing(id, n);
        if (!viaHelper.test(r)) throw new Error(`after the restart the CLI says: ${r}`);
        const l = await launch(id);
        if (l.pid === firstPid) throw new Error("the same CLI answered");
        if (useChats.getState().chats[id]?.account !== keyId) throw new Error("the chat lost its account");
        return `pid ${firstPid} -> ${l.pid}: ${r}`;
      });

      await k.step("platform: a resume after a stop keeps the key", async () => {
        const sid = useChats.getState().chats[id]?.sessionId;
        if (!sid) throw new Error("no session id");
        await api().chatStop(id);
        await k.waitFor("the chat stopped", () => !useChats.getState().chats[id]?.running, 10_000);
        const s = await k.waitFor("its session", () => useStore.getState().sessions.find((x) => x.id === sid), 20_000);
        const before = ids();
        await resumeSession(s);
        const rid = await newId(before);
        await k.waitFor("the resumed chat on the key", () => useChats.getState().chats[rid]?.account === keyId, 10_000);
        await api().chatSend(rid, "billing check");
        const r = await billing(rid);
        if (!viaHelper.test(r)) throw new Error(`the resumed CLI says: ${r}`);
        await api().chatStop(rid).catch(() => {});
        return `session ${sid.slice(0, 8)} resumed as chat ${rid}: ${r}`;
      });

      await k.step("platform: a folder default applies with no choice made, and the sheet shows it", async () => {
        await api().platformSetFolder(k.dir, keyId);
        await loadPlatform();
        const fid = await start(undefined);
        const r = await billing(fid);
        if (!viaHelper.test(r)) throw new Error(`the CLI says: ${r}`);
        await api().chatStop(fid).catch(() => {});
        useStore.getState().setSheet({ kind: "new", cwd: k.dir });
        const chip = await k.waitFor("the account chip on the folder default", () => $(`[data-ns-account="${keyId}"]`), 10_000);
        (chip.closest("button") as HTMLButtonElement).click();
        const opt = await k.waitFor("the subscription option", () => $<HTMLButtonElement>(`[data-account-option="${SUBSCRIPTION}"]`), 5_000);
        await k.shot("platform-sheet-menu");
        opt.click();
        await k.waitFor("the chip on the subscription", () => $(`[data-ns-account="${SUBSCRIPTION}"]`), 5_000);
        useStore.getState().setSheet(null);
        return `default chat ${fid}: ${r}; the sheet picked the subscription over it`;
      });

      await k.step("platform: removing the key clears its folder default; new chats there use the subscription", async () => {
        await api().platformRemoveKey(keyId);
        const st = await api().platformStatus();
        if (st.keys.some((x) => x.id === keyId) || Object.values(st.folders).includes(keyId)) throw new Error(`still listed: ${JSON.stringify(st)}`);
        await loadPlatform();
        const nid = await start(undefined);
        const r = await billing(nid);
        if (!/no api key/.test(r)) throw new Error(`the CLI says: ${r}`);
        await api().chatStop(nid).catch(() => {});
        return r;
      });
    },
  };
}
