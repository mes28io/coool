// The `ladder` self-test scenario (COOOL_SELFTEST=ladder): Ladder end to end in the real app (APP_SPEC "Ladder").
//
// 1. A chat with Ladder off launches without the policy (its CLI's own arguments and the running process's command
//    line, from `ps`). No prompt: nothing reaches a model.
// 2. A chat with it on (lead Sonnet, so Haiku is a cheaper tier) launches with `--append-system-prompt` and coool's
//    plugin folder inside the run's folder; one short real turn: the lead names its delegate tiers and hands a small
//    task to a delegate, which must ask for the small tier's model and answer on a Haiku model id (as the CLI reports
//    it); the turn's tally line shows on screen.
// 3. The chat's own toggle (off) applies to its next start: stopped and resumed, the CLI runs without the policy.
//
// One Sonnet turn (a few thousand tokens), no other model use.

import { newChat, resumeSession } from "./lib/actions";
import { useChats, type Chat, type ChatItem } from "./lib/chat";
import { launchedLadderNow, setChatLadder } from "./lib/ladder";
import { useStore } from "./store";

interface H {
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
  shot: (name: string) => Promise<void>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  fail: (msg: string) => Error;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

interface Launch {
  args: string[];
  ps: string;
  pid: number | null;
}

type Tool = Extract<ChatItem, { kind: "tool" }>;

const chat = (id: number): Chat | undefined => useChats.getState().chats[id];
const ids = () => new Set(Object.keys(useChats.getState().chats).map(Number));
const fresh = (before: Set<number>) => {
  const id = [...ids()].find((i) => !before.has(i));
  return id === undefined ? null : { id };
};

export function ladderScenarios(h: H): Record<string, (ctx: { cfg: { dir: string } }) => Promise<void>> {
  let dir = "";
  const launch = (id: number) => h.invoke("selftest_chat_launch", { chat: id }) as Promise<Launch>;
  const hasPolicy = (l: Launch) => l.args.some((a) => a.startsWith("--append-system-prompt=# Ladder")) || l.ps.includes("--append-system-prompt=# Ladder");

  async function start(o: { model: string; on: boolean; prompt?: string }): Promise<number> {
    const before = ids();
    await newChat({ provider: "claude", cwd: dir, model: o.model, prompt: o.prompt, ladder: { on: o.on } });
    const { id } = await h.waitFor("the new chat", () => fresh(before), 15_000);
    await h.waitFor("ready", () => chat(id)?.ready, 60_000);
    return id;
  }

  return {
    async ladder(ctx) {
      dir = ctx.cfg.dir;
      let on = -1;
      await h.step("ladder: off launches without the policy", async () => {
        const id = await start({ model: "haiku", on: false });
        const l = await launch(id);
        if (!l.ps) throw h.fail("no process command line");
        if (hasPolicy(l)) throw h.fail("policy present with Ladder off");
        if (l.args.some((a) => a.startsWith("--plugin-dir")) || l.ps.includes("--plugin-dir")) throw h.fail("plugin dir passed with Ladder off");
        if (launchedLadderNow(id) !== null) throw h.fail(`launched ladder: ${JSON.stringify(launchedLadderNow(id))}`);
        return `pid ${l.pid}: ${l.args.length} args, no --append-system-prompt, no --plugin-dir`;
      });

      await h.step("ladder: on launches with the policy and coool's own plugin folder", async () => {
        on = await start({
          model: "sonnet",
          on: true,
          prompt:
            "First, in one line each, list the delegate tiers your instructions give you, with their models. Then hand this to a delegate on your small tier: list the file names in the current folder (no subfolders) and return them. Reply with the tiers and the delegate's list.",
        });
        const l = await launch(on);
        if (!hasPolicy(l)) throw h.fail(`no policy in ${l.ps.slice(0, 200)}`);
        const plugin = l.args.find((a) => a.startsWith("--plugin-dir="))?.slice("--plugin-dir=".length) ?? "";
        const norm = (p: string) => p.replace(/^\/private(?=\/)/, "");
        if (!norm(plugin).startsWith(norm(dir))) throw h.fail(`plugin folder outside the run's folder: ${plugin}`);
        const policy = l.args.find((a) => a.startsWith("--append-system-prompt="))!;
        if (!/small\+bulk Haiku[^\n]*\(`haiku`\)|mid\+small\+bulk Haiku[^\n]*\(`haiku`\)/.test(policy)) throw h.fail(`tier table: ${policy.split("\n").slice(2, 5).join(" / ")}`);
        if (/--dangerously-skip-permissions(\s|$)/.test(l.ps)) throw h.fail("bypass flag on the command line");
        const t = launchedLadderNow(on);
        return `pid ${l.pid}; tiers ${t?.tiers.map((x) => `${x.role}=${x.model}`).join(", ")}; plugin ${norm(plugin).replace(norm(dir), "<run>")}`;
      });

      await h.step("ladder: the lead names its tiers and delegates on the cheaper model", async () => {
        await h.waitFor("the turn to end", () => chat(on)?.items.some((i) => i.kind === "turn"), 240_000);
        const c = chat(on)!;
        const calls = c.items.filter((i): i is Tool => i.kind === "tool" && i.parent === null && /^(agent|task)$/i.test(i.name));
        if (!calls.length) throw h.fail("no delegate call");
        const asked = calls.map((t) => (t.input as { model?: string } | null)?.model ?? "(none)");
        // The model each delegate answered on, as the CLI reports it: its streamed usage or text in the chat, else (a
        // delegate the CLI runs in the background may finish after the turn) the session's transcript, which the
        // sidebar reads. Waits up to 2 minutes for it.
        const reported = (t: Tool): string | null => {
          const cc = chat(on)!;
          const kids = Object.keys(cc.agents[t.id]?.models ?? {});
          const text = cc.items.find((i) => i.kind === "text" && i.parent === t.id && i.model) as Extract<ChatItem, { kind: "text" }> | undefined;
          const sess = useStore.getState().sessions.find((x) => x.id === cc.sessionId);
          const agent = sess?.agents?.find((a) => a.description === (t.input as { description?: string } | null)?.description);
          return kids[0] ?? text?.model ?? agent?.model ?? agent?.models?.[0]?.model ?? null;
        };
        await h.waitFor("each delegate's reported model", () => calls.every((t) => reported(t)), 120_000).catch(() => null);
        const answered = calls.map((t) => reported(t) ?? "(unreported)");
        if (!asked.every((m) => m === "haiku")) throw h.fail(`asked for ${asked.join(", ")}`);
        if (!answered.every((m) => /haiku/i.test(m))) throw h.fail(`answered on ${answered.join(", ")}`);
        const reply = [...c.items].reverse().find((i) => i.kind === "text" && !i.parent) as Extract<ChatItem, { kind: "text" }> | undefined;
        if (!/haiku/i.test(reply?.text ?? "")) throw h.fail(`the reply names no Haiku tier: ${reply?.text.slice(0, 160)}`);
        const tally = await h.waitFor("the turn's tally line", () => document.querySelector("[data-ladder-tally]"), 10_000);
        await h.shot("ladder-turn");
        return `${calls.length} delegate(s): asked ${asked.join(", ")}, answered on ${answered.join(", ")}; lead model ${reply?.model}; tally "${(tally.textContent ?? "").slice(0, 120)}"`;
      });

      await h.step("ladder: the chat's own toggle applies to its next start", async () => {
        const c = chat(on)!;
        const sid = c.sessionId!;
        setChatLadder(c, { on: false });
        if (!hasPolicy(await launch(on))) throw h.fail("the running process changed");
        await (await import("./lib/backend")).api().chatStop(on);
        const s = await h.waitFor("the session to end", () => useStore.getState().sessions.find((x) => x.id === sid && x.status === "ended"), 30_000);
        const before = ids();
        await resumeSession(s);
        const { id } = await h.waitFor("the resumed chat", () => fresh(before), 15_000);
        await h.waitFor("ready", () => chat(id)?.ready, 60_000);
        const l = await launch(id);
        if (!l.args.includes("--resume")) throw h.fail("not a resume");
        if (hasPolicy(l)) throw h.fail("policy still passed after turning it off for this chat");
        await (await import("./lib/backend")).api().chatStop(id);
        return `resumed ${sid.slice(0, 8)}… as chat ${id} without the policy`;
      });
    },
  };
}
