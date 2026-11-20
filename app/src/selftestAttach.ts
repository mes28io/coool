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
  const inputsOf = (dir: string) => `${dir.replace(/\/+$/, "").replace(/\/[^/]+$/, "")}/attach-inputs`;

  /** A chat started in the test folder (no turn unless asked), on screen. */
  const open = async (provider: "claude" | "codex", dir: string, mode: string | null) => {
    const before = ids();
    await newChat({ provider, cwd: dir, model: provider === "claude" ? models.claude : models.codex, permissionMode: mode });
    const id = (await h.waitFor("the new chat", () => fresh(before), 15_000)).id;
    await h.waitFor("ready", () => chat(id)?.ready, 90_000);
    useStore.getState().open({ kind: "chat", id });
    await h.waitFor("the composer", () => $("[data-attach-button]"), 20_000);
    return id;
  };

  /** Allows each permission request until `done` holds (or the time is up). */
  const allowUntil = async (id: number, done: () => boolean, ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !done()) {
      const c = chat(id)!;
      if (c.pendingPermission) await h.invoke("chat_respond_permission", { id, requestId: c.pendingPermission, allow: true, always: false, remember: null }).catch(() => {});
      await h.sleep(400);
    }
    return done();
  };

  const replyText = (id: number, from: number) =>
    chat(id)!
      .items.filter((i) => i.kind === "text" && !i.parent)
      .slice(from)
      .map((r) => (r as { text: string }).text)
      .join("\n");

  /** An invented picture for a note: a blue triangle on white. */
  const bluePng = async (): Promise<File> => {
    const c = document.createElement("canvas");
    c.width = c.height = 200;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 200, 200);
    g.fillStyle = "#1546ff";
    g.beginPath();
    g.moveTo(100, 20);
    g.lineTo(185, 180);
    g.lineTo(15, 180);
    g.fill();
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
    return new File([blob], "image.png", { type: "image/png" });
  };

  /** A note with an image, typed while the agent works, must reach it in the same run. */
  const steerRun = async (provider: "claude" | "codex", dir: string) => {
    const tag = provider === "claude" ? "attach-steer" : "attach-steer-codex";
    let id = -1;
    await h.step(`${tag}: an image attached to a note mid-turn reaches the agent`, async () => {
      id = await open(provider, dir, provider === "claude" ? "default" : null);
      const n0 = chat(id)!.items.filter((i) => i.kind === "text" && !i.parent).length;
      await h.say("Run exactly this shell command and nothing else first: sleep 12 && echo waited. After it finishes, reply with one short sentence. If I send you a picture meanwhile, say in that sentence what shape and colour it shows.");
      // Wait for the command to be running (allowing it if asked).
      const running = await allowUntil(id, () => chat(id)!.items.some((i) => i.kind === "tool" && !i.parent && i.endTs === null), 90_000);
      if (!running) throw h.fail("the command never started");
      await h.sleep(1500);
      await addFiles(id, [await bluePng()]);
      await h.waitFor("the picture read", () => (useAttach.getState().drafts[id] ?? []).some((d) => d.state === "ready"), 15_000);
      if (chat(id)!.state === "idle") throw h.fail("the turn ended before the note could be sent");
      await h.say("Here is the picture.");
      const note = await h.waitFor("the queued note with its picture", () => chat(id)!.notes.find((n) => n.attachments?.length) ?? $("[data-note-attachments]"), 10_000);
      await h.shot(`${tag}-queued`);
      const ok = await allowUntil(id, () => chat(id)!.state === "idle" && /blue/i.test(replyText(id, n0)), 180_000);
      const text = replyText(id, n0);
      const n = chat(id)!.notes.find((x) => x.attachments?.length);
      if (!ok) throw h.fail(`no reply naming the picture: ${text.slice(0, 300)} (note: ${n?.state ?? "gone"})`);
      await h.shot(`${tag}-reply`);
      await h.invoke("chat_stop", { id }).catch(() => {});
      return `note ${typeof note === "object" && "state" in note ? "queued" : "shown"}, then ${n?.state ?? "delivered"}; reply: ${text.replace(/\s+/g, " ").slice(0, 220)}`;
    });
  };

  return {
    attach: (ctx) => run("claude", ctx.cfg.dir),
    "attach-codex": (ctx) => run("codex", ctx.cfg.dir),
    "attach-steer": (ctx) => steerRun("claude", ctx.cfg.dir),
    "attach-steer-codex": (ctx) => steerRun("codex", ctx.cfg.dir),

    // The three gestures (no model use): a drag delivered as Tauri delivers the system's, a paste event with files,
    // and the PDF preview drawn by Quartz.
    async "attach-gestures"(ctx) {
      const dir = ctx.cfg.dir;
      const inputs = inputsOf(dir);
      let id = -1;
      await h.step("attach-gestures: a drag over the chat shows the veil, leaving hides it, a drop fills the tray", async () => {
        id = await open("claude", dir, null);
        const box = $("[data-chat-drop]")!.getBoundingClientRect();
        const r = window.devicePixelRatio || 1;
        const at = { x: (box.left + box.width / 2) * r, y: (box.top + box.height / 2) * r };
        const paths = [`${inputs}/shape.png`, `${inputs}/notes.txt`];
        await h.invoke("selftest_drag", { kind: "enter", paths, ...at });
        await h.invoke("selftest_drag", { kind: "over", paths: [], ...at });
        const veil = await h.waitFor("the drop veil", () => $("[data-drop-veil]"), 5_000);
        if (veil.getAttribute("data-drop-veil") !== "2") throw h.fail(`veil counts ${veil.getAttribute("data-drop-veil")}`);
        await h.shot("attach-gestures-veil");
        await h.invoke("selftest_drag", { kind: "leave", paths: [], x: 0, y: 0 });
        await h.waitFor("the veil gone after leave", () => !$("[data-drop-veil]"), 5_000);
        // Outside any chat (the sidebar): no veil, and a drop there adds nothing.
        const side = { x: 40 * r, y: 300 * r };
        await h.invoke("selftest_drag", { kind: "enter", paths, ...side });
        await h.sleep(400);
        if ($("[data-drop-veil]")) throw h.fail("a veil over the sidebar");
        await h.invoke("selftest_drag", { kind: "drop", paths, ...side });
        await h.sleep(600);
        if ((useAttach.getState().drafts[id] ?? []).length) throw h.fail("a drop outside the chat was taken");
        await h.invoke("selftest_drag", { kind: "enter", paths, ...at });
        await h.invoke("selftest_drag", { kind: "drop", paths, ...at });
        await h.waitFor("the tray with both", () => $('[data-attach-tray="2"]') && (useAttach.getState().drafts[id] ?? []).every((d) => d.state === "ready"), 10_000);
        // The veil fades out (its exit animation): gone within a moment of the drop.
        await h.waitFor("the veil gone after the drop", () => !$("[data-drop-veil]"), 3_000);
        return (useAttach.getState().drafts[id] ?? []).map((d) => `${d.name} (${d.att?.kind})`).join(", ");
      });

      await h.step("attach-gestures: a paste event with an image and a file adds both", async () => {
        const ta = $("textarea") as HTMLTextAreaElement;
        const dt = new DataTransfer();
        dt.items.add(await bluePng());
        dt.items.add(new File(["pasted text file\nline two\n"], "pasted-notes.txt", { type: "text/plain" }));
        const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
        const carried = !!ev.clipboardData && ev.clipboardData.files.length === 2;
        if (!carried) Object.defineProperty(ev, "clipboardData", { value: dt });
        ta.dispatchEvent(ev);
        await h.waitFor("the tray with four", () => $('[data-attach-tray="4"]') && (useAttach.getState().drafts[id] ?? []).every((d) => d.state === "ready"), 10_000);
        if (!ev.defaultPrevented) throw h.fail("the paste was also typed");
        await h.shot("attach-gestures-pasted");
        const names = (useAttach.getState().drafts[id] ?? []).slice(2).map((d) => `${d.name} (${d.att?.kind})`);
        return `${carried ? "ClipboardEvent carried the files itself" : "WebKit dropped clipboardData from the constructor: set on the event"}; ${names.join(", ")}`;
      });

      await h.step("attach-gestures: a PDF's quick look shows its pages, drawn by Quartz", async () => {
        useAttach.getState().clear(id);
        await addPaths(id, [`${inputs}/spec.pdf`]);
        const chip = await h.waitFor("the PDF chip", () => $('[data-attach-file="spec.pdf"][data-attach-state="ready"] button'), 10_000);
        chip.click();
        const imgs = await h.waitFor("its pages", () => {
          const a = $$("[data-quicklook-pdf-page]") as HTMLImageElement[];
          return a.length > 0 && a.every((i) => i.complete && i.naturalWidth > 0) ? a : null;
        }, 15_000);
        // Measurable: the first page has ink (dark pixels) on white.
        const im = imgs[0];
        const c = document.createElement("canvas");
        c.width = im.naturalWidth;
        c.height = im.naturalHeight;
        const g = c.getContext("2d")!;
        g.drawImage(im, 0, 0);
        const px = g.getImageData(0, 0, c.width, c.height).data;
        let dark = 0;
        let white = 0;
        for (let i = 0; i < px.length; i += 4) {
          const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
          if (l < 100) dark++;
          else if (l > 245) white++;
        }
        const total = px.length / 4;
        if (dark < 500 || white < total * 0.5) throw h.fail(`page looks blank or wrong: ${dark} dark, ${white} white of ${total}`);
        if ($("iframe")) throw h.fail("an iframe is in the page");
        await h.shot("attach-gestures-pdf");
        useViewer.getState().open(null);
        await h.invoke("chat_stop", { id }).catch(() => {});
        return `${imgs.length} page(s), ${im.naturalWidth}×${im.naturalHeight}, ${dark} dark / ${white} white of ${total} pixels`;
      });
    },

    // The preview button on an image an agent writes (one Haiku turn), read only on click; and the refusals.
    async "attach-step-image"(ctx) {
      const dir = ctx.cfg.dir;
      const inputs = inputsOf(dir);
      let id = -1;
      await h.step("attach-step-image: an image the agent writes gets a preview, read only when clicked", async () => {
        id = await open("claude", dir, "default");
        // The chat's own folder as the CLI reports it (/tmp resolves to /private/tmp): the button only shows inside it.
        const target = `${(chat(id)!.cwd || dir).replace(/\/+$/, "")}/green.png`;
        const a = (await import("./lib/backend")).api();
        const orig = a.attachPreview.bind(a);
        let reads = 0;
        a.attachPreview = (p, io, root) => (reads++, orig(p, io, root));
        try {
          await h.say(`With one Bash command, use python3 (standard library only, zlib and struct) to write a 32x32 solid green PNG to ${target}. Use that absolute path in the command. Then reply with the path.`);
          const ok = await allowUntil(id, () => chat(id)!.state === "idle" && !!$("[data-step-images]"), 150_000);
          if (!ok) throw h.fail(`no preview button (state ${chat(id)!.state})`);
          await h.sleep(600);
          if (reads !== 0) throw h.fail(`${reads} reads before any click`);
          const btn = $("[data-step-images] button")!;
          btn.scrollIntoView({ block: "center" });
          await h.shot("attach-step-image-button");
          btn.click();
          const img = await h.waitFor("the lightbox image", () => $("[data-lightbox-image]") as HTMLImageElement | null, 10_000);
          await h.waitFor("loaded", () => img.complete && img.naturalWidth > 0, 5_000);
          await h.shot("attach-step-image-lightbox");
          useViewer.getState().open(null);
          return `button: ${btn.textContent}; reads before the click 0, after ${reads}; ${img.naturalWidth}×${img.naturalHeight}`;
        } finally {
          a.attachPreview = orig;
        }
      });

      await h.step("attach-step-image: outside the folder, a symlink out of it and a fake PNG are refused", async () => {
        const ask = (path: string) => h.invoke("attach_preview", { path, imagesOnly: true, root: dir }).then(() => "shown", (e) => String(e));
        const out = await ask(`${inputs}/shape.png`);
        const link = await ask(`${dir}/link-out.png`);
        const fake = await ask(`${dir}/fake.png`);
        const noRoot = await h.invoke("attach_preview", { path: `${dir}/green.png`, imagesOnly: true }).then(() => "shown", (e) => String(e));
        if (!/outside/.test(out) || !/outside/.test(link) || !/not an image/.test(fake) || !/no chat folder/.test(noRoot)) throw h.fail(`${out} | ${link} | ${fake} | ${noRoot}`);
        await h.invoke("chat_stop", { id }).catch(() => {});
        return `outside: "${out}"; symlink: "${link}"; fake: "${fake}"; no folder given: "${noRoot}"`;
      });
    },
  };
}
