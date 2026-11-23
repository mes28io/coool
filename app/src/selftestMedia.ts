// Self-test `media` (CHAT_SPEC "Media"): media in a chat end to end, in the real app with the stand-in Claude CLI
// (app/scripts/readme-shots/standin-claude.py, "media demo" and "what happens in the recording"), set up by
// app/scripts/media-e2e.sh with invented files (a PNG chart, a 4 s MP4, an M4A, a one-page PDF, a screen recording
// .mov outside the folder, a picture outside the folder and a symlink to it). No model calls.
//
//   1. The agent's `show` calls put a picture and a video (a grid), a sound player and a PDF page in its reply; one
//      that names a file that is no media says so; the reply's markdown embeds the chart; a picture outside the
//      folder stays a link.
//   2. The video streams in ranges and plays in the viewer (its length read through the scheme); arrows move on.
//   3. The sound plays.
//   4. An explainer (.html, .svg) runs in its sandboxed frame at its own height: it can't fetch, reach the chat's
//      page, storage or coool's IPC; Replay and Full size work. The viewer's arrows go across all the chat's media.
//   5. `media_grant` refuses files the chat doesn't reference (outside the folder, a symlink out of it, a text file),
//      and a made-up token loads nothing.
//   6. A .mov the person attaches goes with key frames: the agent gets them as images (it says how many and their
//      times); the message plays the video and says how many frames went.
//   7. Reopened (stopped and resumed), the transcript's `show` steps and the video attachment come back.

import { newChat, resumeSession } from "./lib/actions";
import { addPaths, useAttach } from "./lib/attach";
import { useChats, type ChatItem } from "./lib/chat";
import { useStore } from "./store";
import type { MediaGrant } from "./lib/backend";

export interface MediaKit {
  dir: string;
  shot: (name: string, settle?: number) => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

type Text = Extract<ChatItem, { kind: "text" }>;
const chat = (id: number) => useChats.getState().chats[id];
const items = (id: number) => chat(id)?.items ?? [];
const texts = (id: number) => items(id).filter((i): i is Text => i.kind === "text" && !i.parent && !i.streaming);
const $ = <T extends HTMLElement = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector(s) as T | null;
const $$ = <T extends HTMLElement = HTMLElement>(s: string, root: ParentNode = document) => [...root.querySelectorAll(s)] as T[];
const ids = () => new Set(Object.keys(useChats.getState().chats).map(Number));

function composer(): HTMLTextAreaElement {
  const ta = [...document.querySelectorAll<HTMLTextAreaElement>(".composer-dock textarea")].filter((t) => t.offsetParent !== null);
  if (!ta.length) throw new Error("no chat composer on screen");
  return ta[ta.length - 1];
}

async function say(k: MediaKit, text: string) {
  const ta = composer();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, text);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  await k.sleep(80);
  composer().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

const loaded = (img: HTMLImageElement | null) => !!img && img.complete && img.naturalWidth > 0;

export function mediaScenarios(k: MediaKit): Record<string, () => Promise<void>> {
  const parent = k.dir.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
  const timeline = (id: number) => $(`[data-chat-timeline="${id}"]`) ?? document;
  // What explainers' sandbox probes report (the test's flow.html posts one).
  const probes: Record<string, string>[] = [];
  window.addEventListener("message", (e) => {
    const p = (e.data as { cooolProbe?: Record<string, string> } | null)?.cooolProbe;
    if (p) probes.push(p);
  });
  return {
    async media() {
      let id = -1;
      let sid = "";
      await k.step("media: the agent shows a picture and a video, a sound and a PDF in its reply", async () => {
        const before = ids();
        if (!(await newChat({ provider: "claude", cwd: k.dir, prompt: "media demo", model: null, permissionMode: null }))) throw new Error("couldn't start the chat");
        id = (await k.waitFor("the new chat", () => {
          const i = [...ids()].find((x) => !before.has(x));
          return i === undefined ? null : { i };
        }, 20_000)).i;
        useStore.getState().open({ kind: "chat", id });
        await k.waitFor("the reply", () => texts(id).some((t) => t.text.includes("The chart inline")) && chat(id)?.state === "idle", 60_000);
        sid = chat(id)?.sessionId ?? "";
        const tl = timeline(id);
        const shows = await k.waitFor("four shows on screen", () => ($$("[data-media-show]", tl).length >= 4 ? $$("[data-media-show]", tl) : null), 10_000);
        const grid = shows.find((s) => !!$('[data-media-tile="chart.png"]', s))!;
        grid.scrollIntoView({ block: "center" });
        await k.waitFor("the chart's tile loaded", () => loaded($('[data-media-tile="chart.png"] img', grid) as HTMLImageElement), 15_000);
        await k.waitFor("the video's poster loaded", () => loaded($('[data-media-tile="flow.mp4"] img', grid) as HTMLImageElement), 15_000);
        const audio = await k.waitFor("the sound's player", () => ($('[data-media-shown="voice.m4a"]', tl)?.scrollIntoView({ block: "center" }), $('[data-media-audio="voice.m4a"]', tl)), 10_000);
        const pdf = $('[data-media-shown="spec.pdf"]', tl);
        pdf?.scrollIntoView({ block: "center" });
        await k.waitFor("the PDF's first page", () => loaded($("img", pdf ?? document) as HTMLImageElement), 15_000);
        const failed = await k.waitFor("the refused show", () => $("[data-media-failed]", tl), 10_000);
        if (!/not a picture/i.test(failed.textContent ?? "")) throw new Error(`the refused show says "${failed.textContent}"`);
        const inline = await k.waitFor("the chart in the reply's markdown", () => $('[data-media-inline="chart.png"]', tl), 10_000);
        inline.scrollIntoView({ block: "center" });
        await k.waitFor("its picture loaded", () => loaded($("img", inline) as HTMLImageElement), 15_000);
        if ($('[data-media-inline="hidden.png"]', tl)) throw new Error("a picture outside the chat's folder was shown");
        const link = $('[data-media-link="flow.mp4"]', tl);
        if (!link) throw new Error("the link to the recording is no media link");
        grid.scrollIntoView({ block: "start" });
        await k.shot("media-reply");
        inline.scrollIntoView({ block: "end" });
        await k.shot("media-reply-markdown");
        return `${shows.length} shows (grid, sound${audio ? "" : " missing"}, PDF); "${failed.textContent?.trim().slice(0, 80)}"; markdown picture shown, outside one a link`;
      });

      await k.step("media: the video streams and plays in the viewer; arrows move on", async () => {
        const tile = $<HTMLButtonElement>('[data-media-tile="flow.mp4"]', timeline(id))!;
        tile.click();
        const v = await k.waitFor("the viewer's video", () => $<HTMLVideoElement>("[data-media-video]"), 10_000);
        v.muted = true;
        await k.waitFor("its length (read in ranges through coool-media://)", () => v.readyState >= 1 && v.duration > 3 && v.duration < 5, 15_000);
        await v.play().catch(() => {});
        await k.waitFor("it plays", () => v.currentTime > 0.4, 15_000);
        await k.shot("media-viewer-video");
        const t = v.currentTime;
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
        await k.waitFor("the previous item (the chart)", () => $('[data-media-image="chart.png"]'), 5_000);
        await k.shot("media-viewer-image");
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await k.waitFor("closed", () => !$("[data-media-viewer]"), 5_000);
        return `duration ${v.duration.toFixed(2)} s, played to ${t.toFixed(2)} s; ← to the chart; Esc`;
      });

      await k.step("media: the sound plays", async () => {
        const p = $('[data-media-audio="voice.m4a"]', timeline(id))!;
        const a = p.querySelector("audio")!;
        a.muted = true;
        ($<HTMLButtonElement>("[data-media-play]", p))!.click();
        await k.waitFor("it plays", () => a.currentTime > 0.2, 15_000);
        await k.shot("media-sound");
        a.pause();
        return `played to ${a.currentTime.toFixed(2)} s of ${a.duration.toFixed(2)} s; the clock reads "${$("[data-media-time]", p)?.textContent}"`;
      });

      await k.step("media: an explainer runs sandboxed at its own height; Replay and Full size; arrows go across the chat", async () => {
        const tl = timeline(id);
        const box = await k.waitFor("the explainer", () => $('[data-explainer="flow.html"]', tl), 10_000);
        box.scrollIntoView({ block: "center" });
        const probe = await k.waitFor("its sandbox probe", () => probes[0], 15_000);
        const want = { fetch: "blocked", parent: "blocked", storage: "blocked", img: "blocked" } as Record<string, string>;
        const leaks = Object.entries(want).filter(([kk, v]) => probe[kk] !== v).map(([kk]) => `${kk}=${probe[kk]}`);
        if (probe.ipc === "answered") leaks.push("ipc=answered");
        if (leaks.length) throw new Error(`the explainer could: ${leaks.join(", ")}`);
        const h = await k.waitFor("its height from its page", () => {
          const v = Number(box.getAttribute("data-explainer-height"));
          return v !== 240 && v >= 120 && v;
        }, 10_000);
        await k.waitFor("the SVG explainer", () => $('[data-explainer="loop.svg"]', tl), 10_000);
        await k.sleep(1200);
        await k.shot("media-explainer");
        const f0 = $("iframe", box);
        $<HTMLButtonElement>("[data-explainer-replay]", box)!.click();
        await k.waitFor("a fresh frame", () => $("iframe", box) !== f0, 5_000);
        $<HTMLButtonElement>("[data-explainer-open]", box)!.click();
        await k.waitFor("full size", () => $('[data-media-viewer][data-media-kind="explainer"] [data-explainer-frame]'), 5_000);
        await k.sleep(1000);
        await k.shot("media-explainer-full");
        const count = $("[data-media-count]")?.textContent ?? "";
        const n = Number(/of (\d+)/.exec(count)?.[1] ?? 0);
        if (n !== 6) throw new Error(`the viewer's arrows go across ${n} items ("${count}")`);
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await k.waitFor("closed", () => !$("[data-media-viewer]"), 5_000);
        return `probe ${JSON.stringify(probe)}; height ${h} px; replayed; full size "${count}"`;
      });

      await k.step("media: files the chat doesn't reference are refused; a made-up token loads nothing", async () => {
        const g = (await k.invoke("media_grant", { chat: id, session: null, paths: ["/etc/hosts", `${parent}/secret/hidden.png`, "out/link.png", "README.md", "out/chart.png", "../secret/hidden.png"] })) as MediaGrant[];
        const by = (p: string) => g.find((x) => x.path === p)!;
        const bad = g.filter((x) => x.path !== "out/chart.png" && x.url);
        if (bad.length) throw new Error(`served: ${bad.map((x) => x.path).join(", ")}`);
        if (!by("out/chart.png").url) throw new Error(`the chart was refused: ${by("out/chart.png").error}`);
        const none = (await k.invoke("media_grant", { chat: null, session: null, paths: ["out/chart.png"] }).then(() => "granted", (e) => String(e))) as string;
        if (none === "granted") throw new Error("granted without a chat");
        const img = new Image();
        const r = await new Promise<string>((res) => {
          img.onload = () => res("loaded");
          img.onerror = () => res("refused");
          img.src = "coool-media://localhost/0123456789abcdef0123456789abcdef";
          setTimeout(() => res("timeout"), 4000);
        });
        if (r === "loaded") throw new Error("a made-up token served something");
        return g.map((x) => `${x.path}: ${x.url ? "served" : x.error}`).join("; ") + `; no chat: ${none}; made-up token: ${r}`;
      });

      await k.step("media: a screen recording the person attaches goes with key frames", async () => {
        await addPaths(id, [`${parent}/media-inputs/rec.mov`]);
        const d = await k.waitFor("the video read", () => {
          const x = (useAttach.getState().drafts[id] ?? [])[0];
          return x && x.state !== "reading" && x;
        }, 30_000);
        if (d.state === "error" || !d.att) throw new Error(`refused: ${d.error}`);
        const frames = d.att.frames ?? [];
        if (frames.length < 2 || !d.att.duration) throw new Error(`frames ${frames.length}, duration ${d.att.duration}`);
        await k.shot("media-attach-tray");
        const n = texts(id).length;
        await say(k, "What happens in the recording?");
        const reply = await k.waitFor("the agent's answer", () => texts(id).slice(n).find((t) => t.text.startsWith("I got")), 30_000);
        if (!reply.text.includes(`I got ${frames.length} images`)) throw new Error(`the agent says: ${reply.text}`);
        const m = await k.waitFor("the message's video", () => $('[data-attached-media="rec.mov"]', timeline(id)), 10_000);
        m.scrollIntoView({ block: "center" });
        const v = await k.waitFor("its player", () => $<HTMLVideoElement>("video", m), 10_000);
        await k.waitFor("its poster", () => !!v.poster, 10_000);
        await k.sleep(800);
        await k.shot("media-attached-video");
        return `${frames.length} frames at ${frames.map((f) => f.t).join(", ")} s of ${d.att.duration} s; agent: ${reply.text.replace(/\*/g, "").slice(0, 160)}`;
      });

      await k.step("media: reopened, the shown media and the video attachment come back from the transcript", async () => {
        if (!sid) throw new Error("no session id");
        await k.invoke("chat_stop", { id });
        const s = await k.waitFor("the session to end", () => useStore.getState().sessions.find((x) => x.id === sid && x.status === "ended" && x.activity.some((a) => a.media)), 60_000);
        const shown = s.activity.filter((a) => a.media).length;
        const withFrames = s.activity.find((a) => a.attachments?.some((x) => x.frames?.length))?.attachments?.find((x) => x.frames?.length);
        const before = ids();
        await resumeSession(s);
        const rid = (await k.waitFor("the resumed chat", () => {
          const i = [...ids()].find((x) => !before.has(x));
          return i === undefined ? null : { i };
        }, 15_000)).i;
        useStore.getState().open({ kind: "chat", id: rid });
        await k.waitFor("the earlier shows", () => $$("[data-earlier] [data-media-show]").filter((x) => x.offsetParent !== null).length >= 4, 20_000);
        const g = $$("[data-earlier] [data-media-show]").find((x) => x.offsetParent !== null && !!$('[data-media-tile="chart.png"]', x))!;
        g.scrollIntoView({ block: "center" });
        // The resumed chat follows its newest line while it starts: keep the earlier grid in view.
        await k.waitFor("the resumed chat ready", () => chat(rid)?.ready, 30_000).catch(() => null);
        await k.waitFor("the earlier chart loaded", () => (g.scrollIntoView({ block: "center" }), loaded($('[data-media-tile="chart.png"] img', g) as HTMLImageElement)), 15_000).catch((e) => {
          const t = $('[data-media-tile="chart.png"]', g);
          const sidNow = useChats.getState().chats[rid]?.sessionId;
          const r0 = t?.getBoundingClientRect();
          void k.shot("media-reopened-fail");
          const where = `rect ${r0 ? [r0.x, r0.y, r0.width, r0.height].map(Math.round).join(",") : "-"} in ${innerWidth}x${innerHeight}; cv ${t?.closest(".cv-auto") ? "yes" : "no"}`;
          return k.invoke("media_grant", { chat: rid, session: `claude:${sidNow}`, paths: ["out/chart.png"] }).then((r) => {
            throw new Error(`${e}; the tile: ${t ? `"${t.getAttribute("title")}", near ${t.getAttribute("data-near")}, ${t.querySelectorAll("img").length} img` : "none"}; grant now ${JSON.stringify(r).slice(0, 120)}; ${where}`);
          });
        });
        await k.shot("media-reopened");
        await k.invoke("chat_stop", { id: rid }).catch(() => {});
        return `${shown} show steps in the transcript; the video's frames read back: ${withFrames ? `${withFrames.frames!.length} (${withFrames.frames!.every((f) => f.key) ? "with keys" : "no keys"})` : "none"}`;
      });
    },
  };
}
