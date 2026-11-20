// The `remote` self-test scenario (COOOL_SELFTEST=remote): coool Remote end to end in the real app, with the
// stand-in phone (remote/phone/e2e.mjs) on the other side of the real relay. Run both with remote/e2e/run.sh.
//
// The two sides meet through files in the test's folder: the app writes the QR payload (remote-pair-url.txt, by
// the backend) and `remote-app-*.txt`; the phone writes `remote-phone-*.txt`.
//
// 1. Settings > Remote: on, Pair an iPhone shows a QR code; the phone claims it; the confirm shows the phone's
//    code; Pair. 2. The phone's snapshot holds only the test's own sessions and the invented ones (checked on both
//    sides: never a title of the person's). 3. A Haiku chat in Ask mode writes a file and runs a command; the
//    phone, watching the chat live, sees the write as a diff and allows both once; the chat says "Allowed Write /
//    Bash from <phone>". 3b. (minor 1, with COOOL_SELFTEST_SITE) the chat's Browser panel opens a local invented
//    page (no model); the phone watches it as pictures. 4. The phone sends a message (a long count) and stops the
//    chat mid-turn. 5. The phone asks for a chat in Bypass (refused), then starts one in the test's folder with a
//    model and mode it chose (Haiku, acceptEdits) and an invented picture; the agent describes the picture.
//    With an older phone (no `minor`), the start has no model or mode: the Bypass default here gives way to the
//    asking mode. 6. Settings > Remote: Remove; the phone is refused.
//
// Three short Haiku turns, nothing else reaches a model.

import { answerPermission } from "./lib/actions";
import { useChats, type ChatItem } from "./lib/chat";
import { remoteApi, type RemoteStatus } from "./lib/remote";
import { useStore } from "./store";

interface H {
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
  shot: (name: string) => Promise<void>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  fail: (msg: string) => Error;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  startIn: (cwd: string, mode: string | null) => Promise<number>;
  send: (id: number, text: string) => Promise<void>;
}

type Tool = Extract<ChatItem, { kind: "tool" }>;
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;

export function remoteScenarios(h: H): Record<string, (ctx: { cfg: { dir: string } }) => Promise<void>> {
  const status = async () => (await remoteApi()).status() as Promise<RemoteStatus>;
  const read = (name: string) => h.invoke("remote_selftest_read", { name }) as Promise<string | null>;
  const write = (name: string, text: string) => h.invoke("remote_selftest_write", { name, text });
  /** Waits for a file the phone writes; a `remote-phone-failed.txt` ends the wait at once. */
  async function phone(name: string, ms = 120_000): Promise<string> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await read(name);
      if (v !== null) return v;
      const f = await read("remote-phone-failed.txt");
      if (f !== null) throw h.fail(`the phone failed: ${f}`);
      if (Date.now() > end) throw h.fail(`timed out waiting for the phone's ${name}`);
      await h.sleep(250);
    }
  }
  const chat = (id: number) => useChats.getState().chats[id];
  const notices = (id: number) => (chat(id)?.items ?? []).filter((i) => i.kind === "notice").map((i) => (i as Extract<ChatItem, { kind: "notice" }>).text);

  return {
    async remote(ctx) {
      const dir = ctx.cfg.dir;
      const site = (ctx.cfg as { site?: string | null }).site ?? null;
      // Whether the phone speaks minor 1 (it says so in its folder as it starts); an older phone writes nothing.
      let minor = 0;
      let deviceId = "";
      let deviceName = "";
      let chatId = -1;
      // A remote start must not take the default mode when it is Bypass (rules::start_mode).
      await h.invoke("remote_set_defaults", {
        defaults: { claude: { model: "haiku", mode: "bypassPermissions" }, codex: { model: null, mode: "danger-full-access" }, models: { claude: [{ id: "haiku", label: "Haiku (latest)" }, { id: "sonnet", label: "Sonnet (latest)" }], codex: [] } },
      });

      await h.step("remote: turned on in Settings, connected to the relay", async () => {
        useStore.getState().openSettings("remote");
        const sw = await h.waitFor("the Remote switch", () => $('[data-setting="remote-enabled"] [role="switch"]'), 10_000);
        if ((await status()).enabled) throw h.fail("Remote was on before the test turned it on (it is off by default)");
        sw.click();
        const end = Date.now() + 30_000;
        let s = await status();
        while (!s.connected && Date.now() < end) {
          await h.sleep(300);
          s = await status();
        }
        if (!s.connected) throw h.fail(`not connected: ${s.error ?? "no error"}`);
        return `relay ${s.relay}`;
      });

      await h.step("remote: Pair an iPhone shows a QR code; the phone's claim shows its code; Pair adds it", async () => {
        const btn = await h.waitFor("Pair an iPhone, enabled", () => $("[data-remote-pair-start]:not([disabled])") as HTMLButtonElement | null, 20_000);
        btn.click();
        await h.waitFor("the QR code", () => $("[data-remote-qr]"), 10_000);
        await h.shot("remote-qr");
        const shown = await h.waitFor("the confirm", () => $("[data-remote-code]")?.getAttribute("data-remote-code"), 60_000);
        const theirs = (await phone("remote-phone-code.txt")).trim();
        if (shown !== theirs) throw h.fail(`codes differ: Mac ${shown}, phone ${theirs}`);
        if ((await status()).devices.length) throw h.fail("a device was listed before the Pair click");
        await h.shot("remote-confirm");
        $("[data-remote-pair-confirm]")!.click();
        const end = Date.now() + 15_000;
        let st = await status();
        while (!st.devices.length && Date.now() < end) {
          await h.sleep(250);
          st = await status();
        }
        if (!st.devices.length) throw h.fail("no device after Pair");
        deviceId = st.devices[0].id;
        deviceName = st.devices[0].name;
        await h.waitFor("the device row", () => $(`[data-setting="remote-device-${deviceId}"]`), 10_000);
        await h.shot("remote-devices");
        return `code ${shown}; paired "${deviceName}"`;
      });

      await h.step("remote: the phone's snapshot holds only this test's sessions and invented ones", async () => {
        const snap = JSON.parse(await phone("remote-phone-snapshot.txt")) as { sessions: { id: string; title: string; project: string }[] };
        minor = Number((await read("remote-phone-minor.txt"))?.trim() ?? "0") || 0;
        const base = dir.split("/").filter(Boolean).pop()!;
        const own = new Set([base, "invented-project"]);
        const foreign = snap.sessions.filter((s) => !own.has(s.project));
        if (foreign.length) throw h.fail(`sessions not of this test went to the phone: ${foreign.length} (projects ${[...new Set(foreign.map((f) => f.project))].join(", ").slice(0, 80)})`);
        // And every real row is a session whose folder is this test's (the backend's own `owns` check decided that;
        // the sidebar may hide old ended ones, so its list is not the measure).
        const mine = new Set(useStore.getState().sessions.map((s) => `${s.provider}:${s.id}`));
        const real = snap.sessions.filter((s) => !s.id.startsWith("selftest:invented-"));
        if (real.some((s) => s.project !== base)) throw h.fail("a real session from another folder");
        void mine;
        if (!snap.sessions.some((s) => s.id.startsWith("selftest:invented-"))) throw h.fail("no invented sessions");
        return `${snap.sessions.length} sessions: ${snap.sessions.map((s) => s.title).join(" | ").slice(0, 160)}`;
      });

      await h.step("remote: a Haiku chat writes a file and runs a command; the phone watches it live, sees the diff, allows both once", async () => {
        chatId = await h.startIn(dir, "default");
        await write("remote-app-chat.txt", String(chatId));
        await h.send(
          chatId,
          "Do exactly these two steps and nothing else. 1. Use the Write tool to create the file notes.txt containing exactly this one line: hello from coool remote . 2. Run exactly this one Bash command: echo coool-remote-ok > remote-ok.txt . Then reply with one word: done",
        );
        await h.waitFor("the pending request", () => chat(chatId)?.pendingPermission, 90_000);
        const answered = await phone("remote-phone-answered.txt", 240_000);
        await h.waitFor("the turn to end", () => (chat(chatId)?.items ?? []).some((i) => i.kind === "turn"), 180_000);
        const tools = (chat(chatId)?.items ?? []).filter((i) => i.kind === "tool") as Tool[];
        const bash = tools.find((t) => t.name === "Bash");
        if (!bash || bash.ok === false || !/coool-remote-ok/.test(JSON.stringify(bash))) throw h.fail(`the command didn't run: ${bash?.output.slice(0, 160)}`);
        const wrote = tools.find((t) => t.name === "Write");
        if (!wrote || wrote.ok === false) throw h.fail(`the file wasn't written: ${tools.map((t) => t.name).join(", ")}`);
        for (const w of [`Allowed Write from ${deviceName}`, `Allowed Bash from ${deviceName}`]) await h.waitFor(`"${w}" in the chat`, () => notices(chatId).includes(w), 10_000);
        await h.shot("remote-allowed");
        const live = minor ? await phone("remote-phone-live.txt", 60_000) : "an older phone: no live view";
        return `${answered.trim()}; ran: Write, ${bash.summary ?? "Bash"}; ${live.trim()}`;
      });

      if (minor && site) {
        await h.step("remote: the chat's Browser panel opens a local page; the phone watches it as pictures (view only)", async () => {
          // The chat asks before each change, so the device gate asks here (on the Mac) before the page opens: allowed
          // once here; the phone isn't involved in that.
          const nav = h.invoke("selftest_browser_tool", { chat: chatId, name: "browser_navigate", args: { url: `${site}/remote.html` } }) as Promise<{ type: string; text?: string }[]>;
          const ask = await Promise.race([nav.then(() => null), h.waitFor("the gate's ask", () => chat(chatId)?.pendingPermission, 20_000).catch(() => null)]);
          if (ask) answerPermission(chatId, ask, "allow");
          const r = await nav;
          const text = r.find((o) => o.type === "text")?.text ?? "";
          if (!/Remote frame test/.test(text)) throw h.fail(`the page didn't open: ${text.slice(0, 160)}`);
          await write("remote-app-browser.txt", "open");
          const frames = await phone("remote-phone-frames.txt", 120_000);
          const s = await status();
          if (!s.actions.some((a) => a.kind === "watch" && /Browser panel/.test(a.detail))) throw h.fail("the watch isn't recorded");
          return `${frames.trim()}; recorded: watched the Browser panel`;
        });
      }

      await h.step("remote: the phone sends a message, then stops the chat mid-turn", async () => {
        const stopped = await phone("remote-phone-stopped.txt", 180_000);
        const sent = `Sent from ${deviceName}`;
        const stop = `Stopped from ${deviceName}`;
        await h.waitFor("both lines in the chat", () => notices(chatId).includes(sent) && notices(chatId).includes(stop), 20_000);
        const users = (chat(chatId)?.items ?? []).filter((i) => i.kind === "prompt").length;
        if (users < 2) throw h.fail("the phone's message isn't in the chat");
        await h.waitFor("the chat idle after the stop", () => chat(chatId)?.state === "idle", 30_000);
        return stopped.trim();
      });

      await h.step(minor ? "remote: Bypass from the phone is refused; it starts a chat with the model and mode it chose (Haiku, acceptEdits) and a picture the agent describes" : "remote: the phone starts a chat in this folder, in the asking mode (not the Bypass default)", async () => {
        const started = JSON.parse(await phone("remote-phone-started.txt", 240_000)) as { session: string; mode: string; model?: string; reply?: string };
        const id = Number(started.session.replace("chat:", ""));
        const c = await h.waitFor("the started chat", () => chat(id), 20_000);
        const want = minor ? "acceptEdits" : "default";
        if (started.mode !== want) throw h.fail(`started in ${started.mode}`);
        const launch = (await h.invoke("selftest_chat_launch", { chat: id })) as { args: string[]; ps: string };
        const all = `${launch.args.join(" ")} ${launch.ps}`;
        // Every coool chat gets `--allow-dangerously-skip-permissions` (it only lets the person switch to Bypass from the
        // Mac later; it turns nothing on, and a phone has no command that changes a mode). What must not be there is
        // Bypass itself: the mode, or the switch that starts in it.
        if (/bypassPermissions|(^|\s)--dangerously-skip-permissions/.test(all)) throw h.fail(`launched in bypass: ${all.slice(0, 200)}`);
        const mode = await h.waitFor("the chat's mode as its CLI reports it", () => chat(id)?.permissionMode, 60_000);
        if (mode !== want) throw h.fail(`the CLI reports mode ${mode}`);
        if (!c.cwd.endsWith(dir.split("/").pop()!)) throw h.fail(`started in ${c.cwd}`);
        await h.waitFor(`"Started from ${deviceName}"`, () => notices(id).includes(`Started from ${deviceName}`), 20_000);
        await h.waitFor("its turn to end", () => (chat(id)?.items ?? []).some((i) => i.kind === "turn"), 120_000);
        const refusals = await phone("remote-phone-refusals.txt");
        if (!minor) return `chat ${id} in ${c.cwd.split("/").pop()} (${started.mode}); refused as expected: ${refusals.trim()}`;
        if (!/--model\s+haiku/.test(launch.args.join(" "))) throw h.fail(`not started on haiku: ${launch.args.join(" ").slice(0, 200)}`);
        const prompt = (chat(id)?.items ?? []).find((i) => i.kind === "prompt") as { attachments?: { kind: string; mime: string }[] } | undefined;
        const img = prompt?.attachments?.find((a) => a.kind === "image");
        if (!img) throw h.fail("the picture didn't arrive with the prompt");
        const replies = (chat(id)?.items ?? []).filter((i) => i.kind === "text").map((i) => (i as { text?: string }).text ?? "").join(" ");
        if (!/yellow|circle|blue|sun|ball|dot/i.test(replies)) throw h.fail(`the agent didn't describe the picture: ${replies.slice(0, 160)}`);
        const s = await status();
        if (!s.actions.some((a) => a.kind === "start" && !a.ok && /can't use that mode/.test(a.detail))) throw h.fail("the Bypass start isn't recorded as refused");
        if (!s.actions.some((a) => a.kind === "upload" && a.ok)) throw h.fail("the picture isn't recorded");
        return `chat ${id} (${started.mode}, ${started.model ?? "?"}) with a ${img.mime} picture; it said: ${replies.trim().slice(0, 80)}; refused as expected: ${refusals.trim()}`;
      });

      await h.step("remote: Remove in Settings; the phone is refused at the relay", async () => {
        useStore.getState().openSettings("remote");
        const ask = await h.waitFor("Remove", () => $(`[data-ask="remote-remove-${deviceId}"]`), 10_000);
        ask.click();
        (await h.waitFor("confirm Remove", () => $(`[data-confirm="remote-remove-${deviceId}"]`), 5_000)).click();
        const end = Date.now() + 15_000;
        while ((await status()).devices.length && Date.now() < end) await h.sleep(250);
        if ((await status()).devices.length) throw h.fail("still listed");
        await write("remote-app-removed.txt", deviceId);
        const refused = await phone("remote-phone-refused.txt", 60_000);
        if (!/revoked/.test(refused)) throw h.fail(`the phone was not refused: ${refused}`);
        const s = await status();
        await h.shot("remote-removed");
        return `${refused.trim()}; ${s.actions.length} actions recorded`;
      });

      await h.step("remote: turned off again", async () => {
        const s = await (await remoteApi()).setEnabled(false);
        if (s.enabled || s.connected) throw h.fail("still on");
      });
    },
  };
}
