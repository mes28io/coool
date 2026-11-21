// Ladder 2's real runs (COOOL_SELFTEST=ladder2-budget,ladder2-lane,ladder2-spawn,ladder2-refuse,ladder2-image), each a
// Claude Haiku lead in "Accept edits" with Ladder on, in the run's own folder (APP_SPEC "Ladder"):
//
// - `ladder2-budget`: the lead reads `budget` before planning a two-part job and says what it saw (plans, usage).
// - `ladder2-lane`: a small self-contained piece goes to Codex's cheapest model through `codex exec` (the policy's
//   lane, with an explicit model, effort and sandbox); the file exists and the lead ran it.
// - `ladder2-spawn`: the lead starts one helper with `spawn` and collects it with `wait`; the helper shows as the
//   lead's child (ChatInfo.helper, its session nested under the lead's in the sidebar, a card in the lead's Jobs
//   panel), and its answer comes back. Then, without a model turn, the helper (at the depth limit) is refused a
//   spawn of its own, and the lead's budget answer is checked.
// - `ladder2-refuse`: a lead launched with 99% kept in reserve (the budget declared too low): asked for an icon, its
//   `can image` says no, no `codex exec` runs, and the lead tells the person why. `spawn` is refused too.
// - `ladder2-image`: asked for "a small app icon for this project, saved as assets/icon.png" (no word about Codex),
//   the Haiku lead checks `can image`, hands it to a GPT helper (`codex exec`), the PNG exists, and the lead looked at
//   it before reporting.
//
// The harness answers the chats' permission requests itself: commands on an allowlist (codex exec, python3, ls, mkdir,
// file, sips, cat, test runners) and edits inside the run's folder are allowed once; anything else is denied.

import { newChat } from "./lib/actions";
import { api } from "./lib/backend";
import { useChats, type Chat, type ChatItem } from "./lib/chat";
import { launchedLadderNow } from "./lib/ladder";
import { laneOf } from "./lib/ladderTiers";
import { useStore } from "./store";

interface H {
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
  shot: (name: string) => Promise<void>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  fail: (msg: string) => Error;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

type Tool = Extract<ChatItem, { kind: "tool" }>;
type FileRow = { path: string; bytes: number; png: [number, number] | null };

const chat = (id: number): Chat | undefined => useChats.getState().chats[id];
const ids = () => new Set(Object.keys(useChats.getState().chats).map(Number));
const toolsOf = (id: number) => (chat(id)?.items ?? []).filter((i): i is Tool => i.kind === "tool");
const cmdOf = (t: Tool) => String((t.input as { command?: unknown } | null)?.command ?? "");
const replyOf = (id: number) => ([...(chat(id)?.items ?? [])].reverse().find((i) => i.kind === "text" && !i.parent) as Extract<ChatItem, { kind: "text" }> | undefined)?.text ?? "";
const isLadderTool = (t: Tool, name: string) => new RegExp(`coool-ladder(__|\\.|/)${name}$`).test(t.name);

const ALLOW = /(^|[\s;&|(])(codex exec|python3?|ls|mkdir|file|sips|cat|head|wc|test|pnpm test|make test|pytest|cp|mv|echo|printf|pwd|grep|find|stat)\b/;

/** Answers permission requests in every chat while `on()` holds (see the header). */
function approver(dir: string, on: () => boolean, log: string[]) {
  const done = new Set<string>();
  const tick = async () => {
    for (const c of Object.values(useChats.getState().chats)) {
      for (const p of c.items) {
        if (p.kind !== "permission" || p.answer !== null || done.has(`${c.id}:${p.requestId}`)) continue;
        done.add(`${c.id}:${p.requestId}`);
        const input = (p.input ?? {}) as { command?: unknown; file_path?: unknown };
        const cmd = typeof input.command === "string" ? input.command : "";
        const file = typeof input.file_path === "string" ? input.file_path : "";
        const ok = cmd ? ALLOW.test(cmd) && !/\brm\s|--dangerously|sudo/.test(cmd) : file ? file.replace(/^\/private/, "").startsWith(dir.replace(/^\/private/, "")) : /coool-ladder/.test(p.tool);
        log.push(`${ok ? "allowed" : "denied"} ${p.tool}: ${(cmd || file || p.summary).slice(0, 120)}`);
        await api().chatRespondPermission(c.id, p.requestId, ok, false).catch(() => {});
      }
    }
  };
  const t = setInterval(() => {
    if (!on()) clearInterval(t);
    else void tick();
  }, 400);
}

export function ladder2Scenarios(h: H): Record<string, (ctx: { cfg: { dir: string } }) => Promise<void>> {
  const files = () => h.invoke("selftest_ladder", { action: "files" }) as Promise<FileRow[]>;
  const tool = (chatId: number, name: string, args: unknown = {}) => h.invoke("selftest_ladder", { action: "tool", chat: chatId, name, args }) as Promise<{ ok: boolean; value?: unknown; error?: string }>;

  async function lead(dir: string, prompt: string, ladder: { reserve?: number; depth?: number } = {}): Promise<number> {
    const before = ids();
    await newChat({ provider: "claude", cwd: dir, model: "haiku", permissionMode: "acceptEdits", prompt, ladder: { on: true, ...ladder } });
    const id = (await h.waitFor("the new chat", () => [...ids()].find((i) => !before.has(i)), 15_000)) as number;
    await h.waitFor("ready", () => chat(id)?.ready, 60_000);
    return id;
  }
  const turn = (id: number, ms = 300_000) => h.waitFor("the turn to end", () => chat(id)?.items.some((i) => i.kind === "turn"), ms);
  const stop = (id: number) => api().chatStop(id).catch(() => {});

  return {
    async "ladder2-budget"(ctx) {
      const log: string[] = [];
      let live = true;
      approver(ctx.cfg.dir, () => live, log);
      let id = -1;
      await h.step("ladder2: launched with the coool-ladder server, Haiku's lanes and the nesting limit", async () => {
        id = await lead(ctx.cfg.dir, "We will add two small modules to this folder later. Before planning anything, read your Ladder budget tool and tell me, in two lines: the plan name and the fullest usage window of each account with its reset time, and whether image generation is available. Do not create files.");
        const l = (await h.invoke("selftest_chat_launch", { chat: id })) as { args: string[]; ps: string };
        const policy = l.args.find((a) => a.startsWith("--append-system-prompt=")) ?? "";
        if (!policy.includes("call `budget`")) throw h.fail("the policy names no budget tool");
        if (!/Codex lanes, run as `codex exec/.test(policy)) throw h.fail(`no Codex lanes: ${policy.slice(0, 600)}`);
        if (!/Image generation: you have no image model/.test(policy)) throw h.fail("no image lane");
        const mcp = l.args.find((a) => a.startsWith("--mcp-config="));
        if (!mcp) throw h.fail("no --mcp-config");
        const env = (await h.invoke("selftest_ladder", { action: "env", chat: id })) as string[];
        const lo = launchedLadderNow(id);
        return `cross ${lo?.cross?.map((t) => `${t.role}=${t.model}`).join(", ")}; image ${lo?.image?.model}; env ${env.join(" ") || "(not visible to ps)"}`;
      });
      await h.step("ladder2: the lead reads budget before planning", async () => {
        await turn(id, 180_000);
        const calls = toolsOf(id).filter((t) => isLadderTool(t, "budget"));
        if (!calls.length) throw h.fail(`no budget call; tools: ${toolsOf(id).map((t) => t.name).join(", ")}`);
        const r = replyOf(id);
        if (!/max|plus|pro|team/i.test(r)) throw h.fail(`the reply names no plan: ${r.slice(0, 300)}`);
        await h.shot("ladder2-budget");
        return `budget called ${calls.length}×; reply: ${r.replace(/\s+/g, " ").slice(0, 300)}`;
      });
      live = false;
      await stop(id);
      if (log.length) await h.step("ladder2: permission answers", async () => log.join(" | "));
    },

    async "ladder2-lane"(ctx) {
      const log: string[] = [];
      let live = true;
      approver(ctx.cfg.dir, () => live, log);
      let id = -1;
      await h.step("ladder2: a small piece goes to Codex's cheapest model through codex exec", async () => {
        id = await lead(
          ctx.cfg.dir,
          "Hand this small self-contained piece to your Codex lane (not to yourself, not to a Claude helper): create slug.py with a function slugify(s) that lowercases s and replaces spaces with dashes, and at the bottom `assert slugify('Hello World') == 'hello-world'` and `print('ok')`. Then run `python3 slug.py` yourself to check it, and report in two lines what ran and the result.",
        );
        await turn(id, 360_000);
        const lanes = toolsOf(id).map((t) => ({ t, lane: laneOf(cmdOf(t)) })).filter((x) => x.lane?.provider === "codex");
        if (!lanes.length) throw h.fail(`no codex exec; tools: ${toolsOf(id).map((t) => `${t.name}:${cmdOf(t).slice(0, 60)}`).join(" | ")}`);
        const cmd = cmdOf(lanes[0].t);
        if (!/-m\s+\S+/.test(cmd) || !/-s\s+(workspace-write|read-only)/.test(cmd)) throw h.fail(`lane without explicit model or sandbox: ${cmd}`);
        if (/dangerously/.test(cmd)) throw h.fail("bypass flag in the lane");
        const f = (await files()).find((x) => x.path === "slug.py");
        if (!f) throw h.fail("slug.py was not written");
        const ran = toolsOf(id).some((t) => /python3?\s+slug\.py/.test(cmdOf(t)) && t.ok);
        if (!ran) throw h.fail("the lead didn't run slug.py");
        await h.shot("ladder2-lane");
        return `lane: ${cmd.slice(0, 200)}; model ${lanes[0].lane?.model}; slug.py ${f.bytes} bytes; lead ran it; tally ${document.querySelector("[data-ladder-tally]")?.textContent?.slice(0, 160) ?? "(none)"}`;
      });
      live = false;
      await stop(id);
      await h.step("ladder2: permission answers", async () => log.join(" | ") || "none asked");
    },

    async "ladder2-spawn"(ctx) {
      const log: string[] = [];
      let live = true;
      approver(ctx.cfg.dir, () => live, log);
      let id = -1;
      let kid = -1;
      await h.step("ladder2: one helper through spawn, shown as the lead's child, its result returned", async () => {
        id = await lead(ctx.cfg.dir, "Use your Ladder `spawn` tool once: model haiku, brief \"Reply with exactly the word PONG and nothing else.\" Then call `wait` for it and tell me, in one line, the helper's id and exactly what it replied.", { depth: 1 });
        kid = (await h.waitFor("the helper chat", () => Object.values(useStore.getState().chatInfos).find((c) => c.helper?.parent === id)?.id, 180_000)) as number;
        const info = useStore.getState().chatInfos[kid];
        if (info.helper?.depth !== 1) throw h.fail(`depth ${info.helper?.depth}`);
        await turn(id, 300_000);
        const spawned = toolsOf(id).filter((t) => isLadderTool(t, "spawn"));
        const waited = toolsOf(id).filter((t) => isLadderTool(t, "wait"));
        if (!spawned.length || !waited.length) throw h.fail(`spawn ${spawned.length}, wait ${waited.length}`);
        const out = waited.map((t) => t.output ?? "").join("\n");
        if (!/PONG/.test(out)) throw h.fail(`wait returned: ${out.slice(0, 300)}`);
        if (!/PONG/.test(replyOf(id))) throw h.fail(`the lead's reply: ${replyOf(id).slice(0, 200)}`);
        // The sidebar: the helper's session is nested under the lead's.
        const leadSid = chat(id)?.sessionId;
        const kidSid = await h.waitFor("the helper's session", () => chat(kid)?.sessionId ?? useStore.getState().chatInfos[kid]?.session_id, 30_000);
        const nested = await h.waitFor("the helper nested under the lead", () => useStore.getState().allSessions.find((s) => s.id === kidSid && s.nested && s.parent === leadSid), 30_000).catch(() => null);
        await h.shot("ladder2-spawn");
        return `helper chat ${kid} (depth 1, model ${info.helper?.model}); wait → ${out.replace(/\s+/g, " ").slice(0, 160)}; sidebar nested: ${nested ? "yes" : "no (no session row yet)"}`;
      });
      await h.step("ladder2: the helper at the depth limit is refused a spawn (no model turn)", async () => {
        const r = await tool(kid, "spawn", { model: "haiku", brief: "x" });
        if (r.ok || !/depth limit \(1 of 1\)/.test(r.error ?? "")) throw h.fail(JSON.stringify(r));
        const other = await tool(id, "stop", { helper: 999 });
        if (other.ok) throw h.fail("stop of a helper that isn't the lead's was accepted");
        const b = await tool(id, "budget");
        const v = b.value as { accounts?: { claude?: { plan?: string } }; helpers?: { max_depth?: number } };
        return `refused: ${r.error}; foreign stop refused: ${other.error}; budget: claude plan ${v?.accounts?.claude?.plan}, max_depth ${v?.helpers?.max_depth}`;
      });
      live = false;
      await stop(id);
      await stop(kid);
      await h.step("ladder2: permission answers", async () => log.join(" | ") || "none asked");
    },

    async "ladder2-refuse"(ctx) {
      const log: string[] = [];
      let live = true;
      approver(ctx.cfg.dir, () => live, log);
      let id = -1;
      await h.step("ladder2: budget declared too low: no image request is sent, the lead says why", async () => {
        id = await lead(ctx.cfg.dir, "Make a small app icon for this project, saved as assets/refused-icon.png.", { reserve: 99 });
        await turn(id, 240_000);
        const can = toolsOf(id).filter((t) => isLadderTool(t, "can"));
        if (!can.length) throw h.fail(`no can call; tools: ${toolsOf(id).map((t) => t.name).join(", ")}`);
        const said = can.map((t) => t.output ?? "").join(" ");
        if (!/usage too low/.test(said)) throw h.fail(`can said: ${said.slice(0, 300)}`);
        const sent = toolsOf(id).filter((t) => laneOf(cmdOf(t))?.provider === "codex");
        if (sent.length) throw h.fail(`codex exec ran anyway: ${cmdOf(sent[0])}`);
        const r = replyOf(id);
        if (!/usage|reserve|limit|reset/i.test(r)) throw h.fail(`the reply doesn't say why: ${r.slice(0, 300)}`);
        if ((await files()).some((f) => f.path === "assets/refused-icon.png" && f.png)) throw h.fail("a PNG appeared");
        await h.shot("ladder2-refuse");
        return `can → ${said.replace(/\s+/g, " ").slice(0, 220)}; no codex exec; reply: ${r.replace(/\s+/g, " ").slice(0, 240)}`;
      });
      await h.step("ladder2: spawn refused under the reserve (no model turn)", async () => {
        const r = await tool(id, "spawn", { model: "haiku", brief: "x" });
        if (r.ok || !/usage too low/.test(r.error ?? "")) throw h.fail(JSON.stringify(r));
        const before = ids().size;
        await h.sleep(500);
        if (ids().size !== before) throw h.fail("a chat started");
        return r.error ?? "";
      });
      live = false;
      await stop(id);
      await h.step("ladder2: permission answers", async () => log.join(" | ") || "none asked");
    },

    async "ladder2-image"(ctx) {
      const log: string[] = [];
      let live = true;
      approver(ctx.cfg.dir, () => live, log);
      let id = -1;
      await h.step("ladder2: a Haiku lead hands an icon to a GPT helper, then looks at it", async () => {
        id = await lead(ctx.cfg.dir, "Make a small app icon for this project, saved as assets/icon.png.");
        await turn(id, 480_000);
        const ts = toolsOf(id);
        const can = ts.filter((t) => isLadderTool(t, "can"));
        const lane = ts.find((t) => laneOf(cmdOf(t))?.provider === "codex");
        if (!lane) throw h.fail(`no GPT helper; tools: ${ts.map((t) => `${t.name}:${cmdOf(t).slice(0, 60)}`).join(" | ")}`);
        if (can.length && can[0].ts > lane.ts) throw h.fail("can came after the request");
        const png = (await files()).find((f) => f.path === "assets/icon.png");
        if (!png?.png) throw h.fail(`no PNG at assets/icon.png: ${JSON.stringify(png)}`);
        const looked = ts.some((t) => t.ts > lane.ts && /^read$/i.test(t.name) && /icon\.png$/.test(String((t.input as { file_path?: unknown })?.file_path ?? "")));
        if (!looked) throw h.fail("the lead didn't look at the image");
        await h.waitFor("the tally", () => document.querySelector("[data-ladder-tally]"), 10_000).catch(() => null);
        const tally = document.querySelector("[data-ladder-tally]")?.textContent ?? "";
        await h.shot("ladder2-image");
        return `can ${can.length}× before; lane: ${cmdOf(lane).slice(0, 160)}; PNG ${png.png.join("×")} ${png.bytes} bytes; lead viewed it; tally "${tally.slice(0, 160)}"`;
      });
      live = false;
      await stop(id);
      await h.step("ladder2: permission answers", async () => log.join(" | ") || "none asked");
    },
  };
}
