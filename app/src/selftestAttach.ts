// The `attach` and `attach-codex` self-test scenarios (COOOL_SELFTEST=attach / attach-codex): chat attachments end to
// end in the real app, with real model turns on the cheapest models.
//
// Needs a folder `attach-inputs` beside COOOL_SELFTEST_DIR holding an invented `shape.png` (a red circle on white, the
// picture the agent describes) and `notes.txt` (with a line "Code word: periwinkle-42" the agent quotes), made by the
// test's own script, and `COOOL_ATTACH_DIR` pointing coool's attachment store at a throwaway folder.
//
// 1. A new chat (Claude Haiku / Codex's cheapest model) in the test folder. The two files are added the way a drop or
//    the attach button adds them (`addPaths`, the code path behind the system picker, which is not driven here);
//    a third, pasted image goes through `addFiles` (the paste path). The tray shows them, then the prompt is typed and
//    sent with Enter through the composer.
// 2. The reply must describe the picture and quote the file's line: the agent got both.
// 3. The sent message shows the images and the file chip; the lightbox and the file preview open.
// 4. The chat is stopped and resumed: the earlier message, read back from the CLI's transcript, shows its attachments
//    again, and its images load.

import { newChat, resumeSession } from "./lib/actions";
import { addFiles, addPaths, useAttach } from "./lib/attach";
import { useChats, type Chat } from "./lib/chat";
import { useViewer } from "./components/Attachments";
import { useStore } from "./store";

interface H {
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
  shot: (name: string) => Promise<void>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  fail: (msg: string) => Error;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  say: (text: string) => Promise<void>;
}

const chat = (id: number): Chat | undefined => useChats.getState().chats[id];
const ids = () => new Set(Object.keys(useChats.getState().chats).map(Number));
const fresh = (before: Set<number>) => {
  const id = [...ids()].find((i) => !before.has(i));
  return id === undefined ? null : { id };
};
const $ = (s: string) => document.querySelector(s) as HTMLElement | null;
const $$ = (s: string) => [...document.querySelectorAll(s)] as HTMLElement[];

/** A small invented picture, drawn here, for the paste path: a yellow star-like burst on black. */
async function pastedPng(): Promise<File> {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = "#ffd400";
  g.beginPath();
  for (let i = 0; i < 16; i++) {
    const r = i % 2 ? 50 : 115;
    const a = (i / 16) * Math.PI * 2;
    g.lineTo(128 + Math.cos(a) * r, 128 + Math.sin(a) * r);
  }
  g.fill();
  const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
  return new File([blob], "image.png", { type: "image/png" });
}

export function attachScenarios(h: H, models: { claude: string; codex: string }): Record<string, (ctx: { cfg: { dir: string } }) => Promise<void>> {
  const run = async (provider: "claude" | "codex", dir: string) => {
    // Beside the test folder, not in it: the agent reads the file where it is.
    const inputs = `${dir.replace(/\/+$/, "").replace(/\/[^/]+$/, "")}/attach-inputs`;
    const tag = provider === "claude" ? "attach" : "attach-codex";
    let id = -1;
    let sid = "";
    await h.step(`${tag}: a new chat takes two dropped files and a pasted image`, async () => {
      const before = ids();
      await newChat({ provider, cwd: dir, model: provider === "claude" ? models.claude : models.codex, permissionMode: provider === "claude" ? "default" : null });
      id = (await h.waitFor("the new chat", () => fresh(before), 15_000)).id;
      await h.waitFor("ready", () => chat(id)?.ready, 90_000);
      useStore.getState().open({ kind: "chat", id });
      await h.waitFor("the composer", () => $("[data-attach-button]"), 20_000);
      await addPaths(id, [`${inputs}/shape.png`, `${inputs}/notes.txt`]);
      await addFiles(id, [await pastedPng()]);
      const ds = await h.waitFor("all three read", () => {
        const d = useAttach.getState().drafts[id] ?? [];
        return d.length === 3 && d.every((x) => x.state !== "reading") && d;
      }, 20_000);
      const bad = ds.filter((d) => d.state === "error");
      if (bad.length) throw h.fail(`refused: ${bad.map((d) => `${d.name}: ${d.error}`).join("; ")}`);
      await h.waitFor("the tray", () => $('[data-attach-tray="3"]'), 5_000);
      await h.shot(`${tag}-composer`);
      return ds.map((d) => `${d.name} (${d.att?.kind}, ${d.att?.mime}, ${d.att?.size} B)`).join(", ");
    });

    await h.step(`${tag}: the agent sees the images and reads the file`, async () => {
      const n = chat(id)!.items.filter((i) => i.kind === "text").length;
      await h.say(
        "Two images are attached, plus a text file. In one short reply: name the main shape and its colour in the first image, the colour of the shape in the second image, and quote the line of the text file that starts with 'Code word'. If a tool asks for permission to read it, that is fine.",
      );
      // Reading a file outside the folder may ask for permission (Claude's Read): allow it.
      const deadline = Date.now() + 180_000;
      let text = "";
      while (Date.now() < deadline) {
        const c = chat(id)!;
        if (c.pendingPermission) {
          await h.invoke("chat_respond_permission", { id, requestId: c.pendingPermission, allow: true, always: false, remember: null }).catch(() => {});
        }
        const replies = c.items.filter((i) => i.kind === "text" && !i.streaming && !i.parent);
        if (c.state === "idle" && replies.length > n) {
          text = replies.slice(n).map((r) => (r as { text: string }).text).join("\n");
          break;
        }
        await h.sleep(500);
      }
      if (!text) throw h.fail("no reply in time");
      const low = text.toLowerCase();
      const okShape = low.includes("red") && (low.includes("circle") || low.includes("disc") || low.includes("dot"));
      const okPaste = low.includes("yellow") || low.includes("gold");
      const okFile = text.includes("periwinkle-42");
      if (!okShape || !okFile) throw h.fail(`reply missed ${!okShape ? "the picture" : ""} ${!okFile ? "the file" : ""}: ${text.slice(0, 400)}`);
      sid = chat(id)!.sessionId ?? "";
      return `${okPaste ? "all three" : "picture and file (pasted one not named)"}; reply: ${text.replace(/\s+/g, " ").slice(0, 260)}`;
    });

    await h.step(`${tag}: the sent message shows its images and file; lightbox and preview open`, async () => {
      const m = await h.waitFor("the message's attachments", () => $('[data-message-attachments="3"]'), 10_000);
      await h.waitFor("its images loaded", () => m.querySelectorAll("img").length >= 2 && m, 10_000);
      m.scrollIntoView({ block: "center" });
      await h.shot(`${tag}-message`);
      (m.querySelector("[data-attach-image] button") as HTMLElement).click();
      await h.waitFor("the lightbox", () => $("[data-lightbox-image]"), 10_000);
      await h.shot(`${tag}-lightbox`);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
      await h.waitFor("the next image", () => $('[data-lightbox="1"]'), 5_000);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await h.waitFor("closed", () => !$("[data-lightbox]"), 5_000);
      (m.querySelector('[data-attach-file="notes.txt"] button') as HTMLElement).click();
      const q = await h.waitFor("the file preview", () => $("[data-quicklook-text]"), 10_000);
      if (!q.textContent?.includes("periwinkle-42")) throw h.fail("the preview doesn't show the file");
      await h.shot(`${tag}-preview`);
      useViewer.getState().open(null);
      return "grid, lightbox (next with →, Esc), text preview";
    });

    await h.step(`${tag}: reopened, the transcript gives the attachments back`, async () => {
      if (!sid) throw h.fail("no session id");
      await h.invoke("chat_stop", { id });
      const s = await h.waitFor("the session to end", () => useStore.getState().sessions.find((x) => x.id === sid && x.status === "ended" && x.activity.some((a) => a.attachments?.length)), 60_000);
      const atts = s.activity.find((a) => a.attachments?.length)!.attachments!;
      const before = ids();
      await resumeSession(s);
      const { id: rid } = await h.waitFor("the resumed chat", () => fresh(before), 15_000);
      useStore.getState().open({ kind: "chat", id: rid });
      const m = await h.waitFor("the earlier message's attachments", () => $$("[data-message-attachments]").find((x) => x.getAttribute("data-message-attachments") === String(atts.length)), 30_000);
      await h.waitFor("its images loaded", () => m.querySelectorAll("img").length >= 2, 15_000);
      // Once the resumed chat has started (the timeline stops following its start), the message is shown.
      await h.waitFor("the resumed chat ready", () => chat(rid)?.ready, 90_000).catch(() => null);
      await h.sleep(800);
      ($$("[data-message-attachments]").find((x) => x.isConnected) ?? m).scrollIntoView({ block: "center" });
      await h.shot(`${tag}-reopened`);
      await h.invoke("chat_stop", { id: rid }).catch(() => {});
      return `from the transcript: ${atts.map((a) => `${a.name} (${a.kind}${a.key ? ", key" : ""}${a.path ? ", path" : ""})`).join(", ")}`;
    });
  };
  return {
    attach: (ctx) => run("claude", ctx.cfg.dir),
    "attach-codex": (ctx) => run("codex", ctx.cfg.dir),
  };
}
