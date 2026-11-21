// Chats that outlive the app (APP_SPEC "Chats that outlive the app"), in the real app: scenarios that run across
// launches of the test build, driven by app/scripts/keepalive-e2e.sh (it quits, kills and relaunches the app between
// them, and checks the process list). Each case works in a folder of its own under the test folder, and the next
// launch finds its chat by that folder. Real model calls on the cheapest models; few turns.
//
// - `ka-claude-start`: a Haiku chat runs three Bash steps with sleeps (allowed by the folder's own settings file); once
//   the first is under way the app quits normally (quit_app, the Quit confirmation's path).
// - `ka-claude-after`: the next launch took the chat in (hosted, the same CLI pid), the steps that ran while coool was
//   closed are in the timeline (their events are timed before this launch), the turn ends with no gap or duplicate,
//   and a follow-up message works. Then `ka-kill` starts the same way and waits for the script's `kill -9`.
// - `ka-kill-after`: the chat survived the hard kill of the app and its turn finishes. Then `ka-perm` starts: a step
//   that sleeps, then one that needs the person (`touch`, not allowed by the folder); the app quits mid-sleep.
// - `ka-perm-after`: the permission request the CLI asked while coool was closed is shown, still waiting, and the
//   answer given now lets the turn finish. Then `ka-codex` starts the steps on Codex's cheapest model and quits.
// - `ka-codex-after`: the Codex chat was taken in, its turn finished, a follow-up works. Then the setting is turned off,
//   `ka-off` starts, and the app quits: the script checks that this chat's CLI ended (today's behaviour).
// - `ka-update-start` (bundle A, with COOOL_UPDATE_BASE): a Ladder lead mid-turn with a helper (`spawn`) running and a
//   queued note; Settings > About's "Update and restart" (the person's path) restarts the app into bundle B.
// - `ka-update-after` (bundle B): the version is the new one, the lead's turn and the helper finish without a gap or a
//   duplicate in the timeline, the helper is still the lead's child, `wait` returns its result, and the note was kept.

import { newChat } from "./lib/actions";
import { api } from "./lib/backend";
import { useChats, type Chat, type ChatItem } from "./lib/chat";
import type { ChatEvent } from "./lib/types";
import { useStore } from "./store";

interface H {
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
  shot: (name: string) => Promise<void>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  fail: (msg: string) => Error;
  log: (line: string) => Promise<unknown>;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

type Tool = Extract<ChatItem, { kind: "tool" }>;
type Perm = Extract<ChatItem, { kind: "permission" }>;
interface Pids {
  app: number;
  hosts: number[];
  chats: { id: number; pid: number | null; hosted: boolean; running: boolean; cwd: string; session_id: string | null }[];
  keep: boolean;
}

const STEPS =
  "Run these three shell commands one at a time, as three separate tool calls, each after the previous one has finished: `sleep 7; echo ka-step-1`, then `sleep 7; echo ka-step-2`, then `sleep 7; echo ka-step-3`. Don't combine them and don't run anything else. Then reply with only the word FINISHED.";
const PERM = "Run the shell command `sleep 9; echo ka-waited`. When it has finished, run the shell command `touch ka-perm.txt` (one call each, nothing else). Then reply with only the word DONE.";
const HELPER = "Run these two shell commands one at a time, as two separate tool calls: `sleep 8; echo ka-helper-1`, then `sleep 8; echo ka-helper-2`. Then reply with only the words HELPER DONE.";
const CODEX_MODEL = "gpt-5.6-luna";

const chat = (id: number): Chat | undefined => useChats.getState().chats[id];
const tools = (id: number) => (chat(id)?.items ?? []).filter((i): i is Tool => i.kind === "tool" && !i.parent);
const turns = (id: number) => (chat(id)?.items ?? []).filter((i) => i.kind === "turn").length;
const reply = (id: number) => ([...(chat(id)?.items ?? [])].reverse().find((i) => i.kind === "text" && !i.parent) as Extract<ChatItem, { kind: "text" }> | undefined)?.text ?? "";
const folder = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;
const sameDir = (a: string, b: string) => a.replace(/^\/private/, "") === b.replace(/^\/private/, "");
/** When this page (this launch of the app) started, epoch ms. */
const launchedAt = () => Date.now() - performance.now();

export function keepaliveScenarios(h: H): Record<string, (ctx: { cfg: { dir: string } }) => Promise<void>> {
  const pids = () => h.invoke("selftest_keepalive", { action: "pids" }) as Promise<Pids>;
  const noteSet = (key: string, value: unknown) => h.invoke("selftest_keepalive", { action: "note_set", key, value });
  const noteGet = <T>(key: string) => h.invoke("selftest_keepalive", { action: "note_get", key }) as Promise<T | null>;
  const ids = () => new Set(Object.keys(useChats.getState().chats).map(Number));

  /** Starts a chat in `name` and waits for its first tool call to be under way. */
  async function begin(dir: string, name: string, o: { provider?: "claude" | "codex"; model?: string; mode?: string | null; prompt: string; ladder?: boolean }) {
    const cwd = folder(dir, name);
    const before = ids();
    const ok = await newChat({ provider: o.provider ?? "claude", cwd, model: o.model ?? "haiku", permissionMode: o.mode ?? null, prompt: o.prompt, ladder: o.ladder ? { on: true } : undefined });
    if (!ok) throw h.fail(`couldn't start the ${name} chat`);
    const { id } = await h.waitFor("the new chat", () => {
      const i = [...ids()].find((x) => !before.has(x));
      return i === undefined ? null : { id: i };
    }, 20_000);
    useStore.getState().open({ kind: "chat", id });
    await h.waitFor(`${name}: the first step under way`, () => tools(id).length > 0, 120_000);
    return id;
  }

  /** Records what the next launch checks, then quits the way the Quit confirmation does. */
  async function quitWith(name: string, id: number) {
    const p = await pids();
    const c = p.chats.find((x) => x.id === id);
    await noteSet(name, { id, pid: c?.pid ?? null, hosted: c?.hosted ?? false, quit_at: Date.now(), tools: tools(id).length, app: p.app, hosts: p.hosts });
    await h.log(`KA-PIDS ${name} app=${p.app} cli=${c?.pid ?? "none"} hosted=${c?.hosted} hosts=${p.hosts.join(",")}`);
    await h.log(`KA-QUIT ${name}`);
    await h.sleep(300);
    await h.invoke("quit_app");
  }

  /** The chat in `name` this launch took in from the host. */
  async function adopted(dir: string, name: string): Promise<{ id: number; was: { pid: number | null; quit_at: number; tools: number } }> {
    const was = await noteGet<{ pid: number | null; quit_at: number; tools: number }>(name);
    if (!was) throw h.fail(`no record of the ${name} chat from the last launch`);
    const cwd = folder(dir, name);
    const { id } = await h.waitFor(`${name}: the chat taken in from the host`, () => {
      const c = Object.values(useChats.getState().chats).find((x) => sameDir(x.cwd, cwd));
      return c ? { id: c.id } : null;
    }, 30_000);
    return { id, was };
  }

  /** The chat's whole event history as the backend holds it: every seq once, in order, none missing. */
  async function history(id: number): Promise<ChatEvent[]> {
    const { events } = await api().chatReplay(id);
    const seqs = events.map((e) => e.seq);
    const bad = seqs.findIndex((s, i) => i > 0 && s !== seqs[i - 1] + 1);
    if (bad >= 0) throw h.fail(`a gap or duplicate in the timeline at seq ${seqs[bad - 1]} -> ${seqs[bad]}`);
    if (seqs[0] !== 1) throw h.fail(`the history starts at seq ${seqs[0]}, not 1`);
    return events;
  }

  async function checkAfter(dir: string, name: string, steps: string[]): Promise<number> {
    const { id, was } = await adopted(dir, name);
    useStore.getState().open({ kind: "chat", id });
    await h.step(`${name}: taken in again, the same CLI still running in the chat host`, async () => {
      const p = await pids();
      const c = p.chats.find((x) => x.id === id);
      if (!c?.hosted) throw h.fail(`not hosted: ${JSON.stringify(c)}`);
      if (was.pid && c.pid !== was.pid) throw h.fail(`CLI pid ${c.pid}, was ${was.pid}`);
      return `chat ${id}, CLI ${c.pid}, host ${p.hosts.join(",")}`;
    });
    await h.step(`${name}: what the agent did while coool was closed is in the timeline`, async () => {
      const t0 = launchedAt();
      const evs = await history(id);
      const closed = evs.filter((e) => e.ts > was.quit_at && e.ts < t0 && (e.type === "tool_end" || e.type === "tool_start" || e.type === "text_delta"));
      if (!closed.length) throw h.fail(`no step events between the quit (${was.quit_at}) and this launch (${Math.round(t0)})`);
      return `${closed.length} events from while it was closed (${[...new Set(closed.map((e) => e.type))].join(", ")}); ${evs.length} in all, seq 1..${evs[evs.length - 1].seq}`;
    });
    await h.step(`${name}: the turn finishes, every step once`, async () => {
      await h.waitFor("the turn to end", () => turns(id) >= 1, 240_000);
      const out = tools(id).map((t) => t.output).join("\n");
      const missing = steps.filter((s) => !out.includes(s));
      if (missing.length) throw h.fail(`steps missing from the tool output: ${missing.join(", ")}`);
      const twice = steps.filter((s) => out.split(s).length > 2);
      if (twice.length) throw h.fail(`steps shown twice: ${twice.join(", ")}`);
      await history(id);
      return `${tools(id).length} steps, reply "${reply(id).slice(0, 40)}"`;
    });
    return id;
  }

  async function followUp(name: string, id: number) {
    await h.step(`${name}: a follow-up message works`, async () => {
      const n = turns(id);
      await api().chatSend(id, "Reply with only the word PONG.");
      await h.waitFor("the follow-up turn", () => turns(id) > n, 120_000);
      if (!/PONG/i.test(reply(id))) throw h.fail(`reply: ${reply(id).slice(0, 80)}`);
      return reply(id).slice(0, 20);
    });
  }

  return {
    async "ka-claude-start"(ctx) {
      let id = -1;
      await h.step("ka-claude: a Haiku chat mid-turn in the chat host", async () => {
        id = await begin(ctx.cfg.dir, "ka-claude", { prompt: STEPS });
        const c = (await pids()).chats.find((x) => x.id === id);
        if (!c?.hosted) throw h.fail("the chat isn't hosted");
        return `chat ${id}, CLI ${c.pid}`;
      });
      if (id >= 0) await quitWith("ka-claude", id);
    },
    async "ka-claude-after"(ctx) {
      const id = await checkAfter(ctx.cfg.dir, "ka-claude", ["ka-step-1", "ka-step-2", "ka-step-3"]);
      await followUp("ka-claude", id);
      await h.shot("ka-claude-after");
      let k = -1;
      await h.step("ka-kill: a second chat mid-turn, for the hard kill", async () => {
        k = await begin(ctx.cfg.dir, "ka-kill", { prompt: STEPS });
        return `chat ${k}`;
      });
      if (k < 0) return;
      const p = await pids();
      const c = p.chats.find((x) => x.id === k);
      await noteSet("ka-kill", { id: k, pid: c?.pid ?? null, quit_at: Date.now(), tools: tools(k).length });
      await h.log(`KA-PIDS ka-kill app=${p.app} cli=${c?.pid ?? "none"} hosted=${c?.hosted} hosts=${p.hosts.join(",")}`);
      await h.log("KA-READY-KILL");
      // The script kills this process now.
      await h.sleep(120_000);
    },
    async "ka-kill-after"(ctx) {
      await checkAfter(ctx.cfg.dir, "ka-kill", ["ka-step-1", "ka-step-2", "ka-step-3"]);
      let id = -1;
      await h.step("ka-perm: a chat that will ask for a permission while coool is closed", async () => {
        id = await begin(ctx.cfg.dir, "ka-perm", { prompt: PERM });
        return `chat ${id}`;
      });
      if (id >= 0) await quitWith("ka-perm", id);
    },
    async "ka-perm-after"(ctx) {
      const { id, was } = await adopted(ctx.cfg.dir, "ka-perm");
      useStore.getState().open({ kind: "chat", id });
      let req: Perm | null = null;
      await h.step("ka-perm: the request asked while coool was closed is shown, still waiting", async () => {
        req = await h.waitFor("the pending permission request", () => (chat(id)?.items ?? []).find((i): i is Perm => i.kind === "permission" && i.answer === null) ?? null, 60_000);
        const evs = await history(id);
        const ev = evs.find((e) => e.type === "permission_request");
        if (!ev) throw h.fail("no permission_request event");
        if (!(ev.ts > was.quit_at && ev.ts < launchedAt())) throw h.fail(`asked at ${ev.ts}, not while coool was closed (${was.quit_at}..${Math.round(launchedAt())})`);
        if (chat(id)?.state !== "waiting_permission") throw h.fail(`state ${chat(id)?.state}`);
        await h.shot("ka-perm-waiting");
        return `${req.tool}: ${req.summary.slice(0, 60)}`;
      });
      await h.step("ka-perm: answered now, the CLI goes on and the turn finishes", async () => {
        const r = req as Perm | null;
        if (!r) throw h.fail("no request to answer");
        await api().chatRespondPermission(id, r.requestId, true, false);
        await h.waitFor("the turn to end", () => turns(id) >= 1, 120_000);
        const t = tools(id).find((x) => /touch/.test(JSON.stringify(x.input)));
        if (!t || t.ok !== true) throw h.fail(`the touch step: ${JSON.stringify(t ?? null).slice(0, 200)}`);
        return `reply "${reply(id).slice(0, 30)}"`;
      });
      let c = -1;
      await h.step("ka-codex: a Codex chat mid-turn in the chat host", async () => {
        c = await begin(ctx.cfg.dir, "ka-codex", { provider: "codex", model: CODEX_MODEL, mode: "never", prompt: STEPS });
        return `chat ${c}`;
      });
      if (c >= 0) await quitWith("ka-codex", c);
    },
    async "ka-codex-after"(ctx) {
      const id = await checkAfter(ctx.cfg.dir, "ka-codex", ["ka-step-1", "ka-step-2", "ka-step-3"]);
      await followUp("ka-codex", id);
      let off = -1;
      await h.step("ka-off: with the setting off, a new chat runs inside coool", async () => {
        const p = await api().prefsGet();
        await api().prefsSet({ ...p, keep_chats: false });
        off = await begin(ctx.cfg.dir, "ka-off", { prompt: STEPS });
        const c = (await pids()).chats.find((x) => x.id === off);
        if (c?.hosted) throw h.fail("hosted with the setting off");
        return `chat ${off}, CLI ${c?.pid}`;
      });
      if (off >= 0) await quitWith("ka-off", off);
    },
    async "ka-update-start"(ctx) {
      const { getVersion } = await import("@tauri-apps/api/app");
      await h.log(`KA-VERSION ${await getVersion()}`);
      let lead = -1;
      let helper = -1;
      await h.step("ka-update: a Ladder lead mid-turn, with a helper running and a queued note", async () => {
        lead = await begin(ctx.cfg.dir, "ka-update", { prompt: STEPS, ladder: true });
        const r = (await h.invoke("selftest_ladder", { action: "tool", chat: lead, name: "spawn", args: { brief: HELPER, title: "ka helper", model: "haiku" } })) as { ok: boolean; value?: { helper?: number }; error?: string };
        if (!r.ok || r.value?.helper === undefined) throw h.fail(`spawn: ${r.error ?? JSON.stringify(r.value)}`);
        helper = r.value.helper;
        await h.waitFor("the helper's first step", () => tools(helper).length > 0, 120_000);
        await api().chatSteer(lead, "When you reply FINISHED, also add the word NOTED.", false);
        const p = await pids();
        const hosted = [lead, helper].map((i) => p.chats.find((x) => x.id === i)?.hosted);
        if (!hosted.every(Boolean)) throw h.fail(`hosted: ${hosted}`);
        return `lead ${lead}, helper ${helper}`;
      });
      if (lead < 0 || helper < 0) return;
      const p = await pids();
      await noteSet("ka-update", { id: lead, helper, pid: p.chats.find((x) => x.id === lead)?.pid ?? null, helper_pid: p.chats.find((x) => x.id === helper)?.pid ?? null, quit_at: Date.now(), tools: tools(lead).length });
      await h.log(`KA-PIDS ka-update app=${p.app} cli=${p.chats.find((x) => x.id === lead)?.pid} helper=${p.chats.find((x) => x.id === helper)?.pid} hosts=${p.hosts.join(",")}`);
      await h.step("ka-update: Settings > About offers Update and restart", async () => {
        useStore.getState().openSettings("about");
        const b = await h.waitFor("About's Update and restart", () => document.querySelector("[data-about-update]") as HTMLButtonElement | null, 180_000);
        await h.waitFor("the update downloaded", () => !b.disabled && document.querySelector("[data-about-update]"), 300_000);
        await h.shot("ka-update-about");
        return (document.querySelector('[data-setting="about-update"]')?.textContent ?? "").slice(0, 160);
      });
      await h.log("KA-QUIT ka-update");
      (document.querySelector("[data-about-update]") as HTMLButtonElement | null)?.click();
      // The restart: the update screen says the chats keep running, then the app exits.
      for (let i = 0; i < 100; i++) {
        const t = document.body.textContent ?? "";
        if (/working chats? keeps? running/i.test(t)) {
          await h.log(`KA-SCREEN ${/Your[^.]*keeps? running\./.exec(t)?.[0] ?? "keep running"}`);
          break;
        }
        if (document.querySelector("[data-about-update-confirm]")) {
          await h.log(`KA-CONFIRM ${(document.querySelector("[data-about-update-confirm]")?.textContent ?? "").slice(0, 200)}`);
          break;
        }
        await h.sleep(50);
      }
      await h.sleep(30_000);
    },
    async "ka-update-after"(ctx) {
      const { getVersion } = await import("@tauri-apps/api/app");
      const v = await getVersion();
      await h.step("ka-update: running the new version", async () => {
        const want = await noteGet<string>("ka-update-to");
        if (want && v !== want) throw h.fail(`version ${v}, expected ${want}`);
        return v;
      });
      const id = await checkAfter(ctx.cfg.dir, "ka-update", ["ka-step-1", "ka-step-2", "ka-step-3"]);
      const was = await noteGet<{ helper: number; helper_pid: number | null }>("ka-update");
      await h.step("ka-update: the helper is still the lead's child and finishes", async () => {
        const hid = was?.helper ?? -1;
        await h.waitFor("the helper", () => chat(hid), 30_000);
        const row = useStore.getState().chatInfos[hid];
        if (row?.helper?.parent !== id) throw h.fail(`helper row ${JSON.stringify(row?.helper ?? null)}`);
        if (was?.helper_pid && !(await pids()).chats.some((x) => x.id === hid && x.pid === was.helper_pid)) throw h.fail("the helper's CLI changed");
        await h.waitFor("the helper's turn to end", () => turns(hid) >= 1, 240_000);
        const r = (await h.invoke("selftest_ladder", { action: "tool", chat: id, name: "wait", args: { helpers: [hid], timeout_s: 60 } })) as { ok: boolean; value?: { result?: string; state?: string }[]; error?: string };
        const res = r.value?.[0];
        if (!r.ok || res?.state !== "done" || !/HELPER DONE/i.test(res.result ?? "")) throw h.fail(`wait: ${JSON.stringify(r).slice(0, 200)}`);
        const out = tools(hid).map((t) => t.output).join("\n");
        if (!out.includes("ka-helper-1") || !out.includes("ka-helper-2")) throw h.fail("helper steps missing");
        return `helper ${hid}: "${res.result?.slice(0, 30)}"`;
      });
      await h.step("ka-update: the queued note was kept", async () => {
        const notes = chat(id)?.notes ?? [];
        const n = notes.find((x) => /NOTED/.test(x.text));
        if (!n) throw h.fail(`notes: ${JSON.stringify(notes).slice(0, 200)}`);
        return `${n.state}; reply "${reply(id).slice(0, 40)}"`;
      });
      await h.shot("ka-update-after");
    },
  };
}
