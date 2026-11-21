// Self-test `typing-steady`: the message list holds still while the person types in the composer (no model calls; the
// stand-in CLIs of app/scripts/readme-shots, set up by app/scripts/typing-e2e.sh).
//
// A Claude chat in a scratch git repository gets a long reply that ends with "Worked for … · 10 tool uses", "1 file
// changed" and the turn's bar; the chat is idle and pinned to the bottom. Then, measured every frame (the last turn's
// footer's top on screen, the timeline's scrollTop and size, the composer's height):
//   1. a long prompt typed key by key at a person's pace, with pauses, that keeps the composer at its height: the list
//      must not move at all;
//   2. the composer made to grow to 4+ lines (Shift+Enter): the list moves once per composer growth, in the same
//      direction and by the same amount, never back;
//   3. the prompt sent: the reply that comes in keeps the view pinned to the bottom.
// While typing, every element of the pane that changes size is recorded, so a failure names what moved the list.

import { newChat } from "./lib/actions";
import { useChats } from "./lib/chat";
import { useStore } from "./store";

export interface TypingKit {
  dir: string;
  shot: (name: string, settle?: number) => Promise<unknown>;
  log: (line: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
}

type Frame = { t: number; foot: number; top: number; sh: number; ch: number; ta: number; dock: number; gap: number };

const PROMPT =
  "Read the environment loader and tell me why the value set in my shell wins over the one in the file, then check that the cached copy is cleared when the folder changes and the tests still pass.";

function timeline(id: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-chat-timeline="${id}"]`);
}

function textarea(): HTMLTextAreaElement {
  const ta = [...document.querySelectorAll<HTMLTextAreaElement>(".composer-dock textarea")].filter((t) => t.offsetParent !== null);
  if (!ta.length) throw new Error("no chat composer on screen");
  return ta[ta.length - 1];
}

/** A key as a person presses it: keydown (React's onKeyDown), the text inserted the way the keyboard does, keyup. */
function press(ch: string, mods: KeyboardEventInit = {}) {
  const el = textarea();
  const k = ch === "\n" ? "Enter" : ch;
  const down = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods });
  if (el.dispatchEvent(down)) document.execCommand("insertText", false, ch === "\n" ? "\n" : ch);
  el.dispatchEvent(new KeyboardEvent("keyup", { key: k, bubbles: true, cancelable: true, ...mods }));
}

/** What the person sees, every frame, until stopped. */
function sampler(id: number) {
  const frames: Frame[] = [];
  let raf = 0;
  let on = true;
  const read = () => {
    const el = timeline(id);
    const feet = el ? el.querySelectorAll<HTMLElement>("[data-turn-end]") : [];
    const foot = feet.length ? feet[feet.length - 1] : null;
    const dock = document.querySelector<HTMLElement>(".composer-dock");
    let ta = 0;
    try {
      ta = textarea().getBoundingClientRect().height;
    } catch {
      /* no composer */
    }
    if (el)
      frames.push({
        t: performance.now(),
        foot: foot ? foot.getBoundingClientRect().top : NaN,
        top: el.scrollTop,
        sh: el.scrollHeight,
        ch: el.clientHeight,
        ta,
        dock: dock?.getBoundingClientRect().height ?? 0,
        gap: el.scrollHeight - el.scrollTop - el.clientHeight,
      });
    if (on) raf = requestAnimationFrame(read);
  };
  raf = requestAnimationFrame(read);
  return {
    frames,
    stop() {
      on = false;
      cancelAnimationFrame(raf);
    },
  };
}

/** Every element in the pane that changes size while watched (the suspects when the list moves). */
function sizeWatch(root: Element) {
  const seen = new Map<Element, number>();
  const changes: { t: number; what: string; from: number; to: number }[] = [];
  const name = (e: Element) => {
    const d = [...e.attributes].filter((a) => a.name.startsWith("data-")).map((a) => a.name + (a.value ? `=${a.value.slice(0, 20)}` : ""));
    const cls = (e.getAttribute("class") ?? "").split(/\s+/).slice(0, 4).join(".");
    return `${e.tagName.toLowerCase()}${d.length ? `[${d.join(" ")}]` : ""}${cls ? `.${cls}` : ""}`;
  };
  const ro = new ResizeObserver((entries) => {
    const t = performance.now();
    for (const e of entries) {
      const h = Math.round(e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height);
      const was = seen.get(e.target);
      seen.set(e.target, h);
      if (was !== undefined && was !== h) changes.push({ t, what: name(e.target), from: was, to: h });
    }
  });
  const all = [root, ...root.querySelectorAll("*")];
  for (const e of all) ro.observe(e);
  const mo = new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) if (n instanceof Element) [n, ...n.querySelectorAll("*")].forEach((x) => ro.observe(x));
  });
  mo.observe(root, { childList: true, subtree: true });
  return {
    changes,
    stop() {
      ro.disconnect();
      mo.disconnect();
    },
  };
}

/**
 * Frames where the footer moved on screen, with how much the composer's height changed over the last two frames (the
 * sampler reads in requestAnimationFrame, before the timeline's ResizeObserver re-pins it in that frame: a move shows
 * a frame after the composer's growth that caused it, though both are painted together).
 */
function moves(frames: Frame[]) {
  const out: { t: number; d: number; dta: number; ddock: number }[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[Math.max(0, i - 2)];
    const b = frames[i];
    const d = b.foot - frames[i - 1].foot;
    if (Math.abs(d) >= 0.5) out.push({ t: b.t, d: Math.round(d * 10) / 10, dta: Math.round(b.ta - a.ta), ddock: Math.round(b.dock - a.dock) });
  }
  return out;
}

export function typingScenarios(k: TypingKit): Record<string, () => Promise<void>> {
  const { dir, shot, sleep, waitFor, step, log } = k;
  const chats = () => useChats.getState().chats;

  return {
    async "typing-steady"() {
      let id = -1;
      await step("typing-steady: a stand-in Claude chat with a long reply, idle, pinned to the bottom", async () => {
        const before = new Set(Object.keys(chats()).map(Number));
        await newChat({ provider: "claude", cwd: dir, model: "opus", permissionMode: "bypassPermissions", prompt: "Write a long reply" });
        const found = await waitFor("the new chat", () => {
          const n = Object.keys(chats()).map(Number).find((i) => !before.has(i));
          return n === undefined ? null : { n };
        }, 20_000);
        id = found.n;
        useStore.getState().open({ kind: "chat", id });
        await waitFor("the turn to end", () => chats()[id]?.items.some((i) => i.kind === "turn"), 60_000);
        await waitFor("the files-changed line", () => timeline(id)?.querySelector("[data-turn-files]"), 30_000);
        await waitFor("the turn's bar", () => timeline(id)?.querySelector("[data-turn-end] [data-turn-bar]"), 30_000);
        // Settled: fonts, code blocks, the Changes count.
        await sleep(2500);
        const el = timeline(id)!;
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (gap > 1) throw new Error(`not at the bottom: ${gap}px below`);
        const foot = el.querySelector("[data-turn-end]")!.textContent?.replace(/\s+/g, " ").trim();
        await shot("typing-before", 300);
        return `chat ${id}; footer "${foot}"; timeline ${el.clientHeight}px tall, ${el.scrollHeight}px of content`;
      });

      await step("typing-steady: a long prompt typed key by key with pauses: the list does not move", async () => {
        const ta = textarea();
        ta.focus();
        await sleep(400);
        const pane = ta.closest("[data-pane-body]") ?? document.body;
        const watch = sizeWatch(pane);
        const s = sampler(id);
        await sleep(200);
        const t0 = performance.now();
        // A live chat's object changes now and then while the person types (usage, context, status): the timeline
        // renders again, and its window re-pins to the bottom. The same here, three times a second.
        const touch = setInterval(() => useChats.setState((st) => (st.chats[id] ? { chats: { ...st.chats, [id]: { ...st.chats[id] } } } : st)), 330);
        let n = 0;
        for (const ch of PROMPT) {
          press(ch);
          n++;
          // About 9 keys a second, a little uneven; a pause now and then, as a person thinks.
          await sleep(85 + ((n * 37) % 60));
          if (n % 28 === 0) await sleep(900);
        }
        await sleep(1500);
        clearInterval(touch);
        s.stop();
        watch.stop();
        const secs = (performance.now() - t0) / 1000;
        const m = moves(s.frames);
        const tas = [...new Set(s.frames.map((f) => Math.round(f.ta)))];
        const steadyComposer = m.filter((x) => x.dta === 0 && x.ddock === 0);
        // What changed size in the frames the list moved (the culprit), most often first.
        const blame = new Map<string, number>();
        for (const x of steadyComposer)
          for (const c of watch.changes)
            if (Math.abs(c.t - x.t) < 40) {
              const key = `${c.what} ${c.from}→${c.to}`;
              blame.set(key, (blame.get(key) ?? 0) + 1);
            }
        const top = [...blame.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([w, c]) => `${c}× ${w}`);
        const sizes = new Map<string, number>();
        for (const c of watch.changes) sizes.set(c.what, (sizes.get(c.what) ?? 0) + 1);
        const busiest = [...sizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([w, c]) => `${c}× ${w}`);
        await log(`typing-steady: ${n} keys in ${secs.toFixed(1)}s, ${s.frames.length} frames; composer heights ${tas.join("/")}; list moves ${m.length} (${steadyComposer.length} with the composer unchanged): ${m.slice(0, 24).map((x) => `${x.d > 0 ? "+" : ""}${x.d}${x.dta ? `(ta${x.dta})` : ""}`).join(" ")}`);
        if (top.length) await log(`typing-steady: resized in those frames: ${top.join(" | ")}`);
        for (const x of steadyComposer.slice(0, 4)) {
          const i = s.frames.findIndex((f) => f.t === x.t);
          const around = s.frames.slice(Math.max(0, i - 3), i + 3).map((f) => `[${Math.round(f.t - t0)}ms foot ${Math.round(f.foot)} top ${Math.round(f.top)} sh ${f.sh} ch ${f.ch} ta ${Math.round(f.ta)} dock ${Math.round(f.dock)} gap ${Math.round(f.gap)}]`);
          await log(`typing-steady: frames ${around.join(" ")}`);
        }
        if (busiest.length) await log(`typing-steady: resized while typing: ${busiest.join(" | ")}`);
        await shot("typing-typed", 300);
        if (steadyComposer.length) throw new Error(`the list moved ${steadyComposer.length} times while the composer kept its height`);
        const back = m.filter((x) => x.d > 0);
        if (back.length) throw new Error(`the list moved back down ${back.length} times`);
        const f = s.frames;
        // Pinned all along: off the bottom only in a frame where the composer has just grown (re-pinned before paint).
        const off = f.filter((x, i) => x.gap > 1 && !(i > 0 && x.dock !== f[i - 1].dock));
        if (off.length) throw new Error(`the list sat ${Math.max(...off.map((x) => Math.round(x.gap)))}px above the bottom in ${off.length} of ${f.length} frames`);
        const net = f[f.length - 1].foot - f[0].foot;
        const grew = f[f.length - 1].dock - f[0].dock;
        if (Math.abs(net + grew) > 2) throw new Error(`the list moved ${Math.round(net)}px for a composer ${Math.round(grew)}px taller`);
        return `${n} keys in ${secs.toFixed(1)}s, ${s.frames.length} frames: the list moved ${m.length} times, each with the composer's own growth (composer ${tas.join("/")}px)`;
      });

      await step("typing-steady: the composer grows to 4+ lines: the list moves once per growth, never back", async () => {
        const s = sampler(id);
        await sleep(200);
        for (let i = 0; i < 4; i++) {
          press("\n", { shiftKey: true });
          await sleep(250);
          for (const ch of `line ${i + 2}`) {
            press(ch);
            await sleep(70);
          }
          await sleep(500);
        }
        await sleep(800);
        s.stop();
        const m = moves(s.frames);
        const f = s.frames;
        const grew = f[f.length - 1].dock - f[0].dock;
        const net = f[f.length - 1].foot - f[0].foot;
        const back = m.filter((x) => x.d > 0);
        const loose = m.filter((x) => x.dta === 0 && x.ddock === 0);
        const growths = moves(f.map((x) => ({ ...x, foot: x.dock }))).length;
        await log(`typing-steady: composer +${Math.round(grew)}px in ${growths} growths; list moves ${m.length}: ${m.map((x) => `${x.d}(ta${x.dta})`).join(" ")}; net ${Math.round(net)}px`);
        await shot("typing-grown", 300);
        if (grew < 40) throw new Error(`the composer grew only ${Math.round(grew)}px`);
        if (back.length) throw new Error(`the list moved back down ${back.length} times`);
        if (loose.length) throw new Error(`the list moved ${loose.length} times without the composer growing`);
        if (Math.abs(net + grew) > 2) throw new Error(`the list moved ${Math.round(net)}px for a composer ${Math.round(grew)}px taller`);
        const el = timeline(id)!;
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (gap > 1) throw new Error(`no longer at the bottom: ${gap}px below`);
        return `composer +${Math.round(grew)}px in ${growths} steps; the list ${Math.round(net)}px in ${m.length} moves, none back; still at the bottom`;
      });

      await step("typing-steady: the last two lines deleted: the list follows the composer down, still pinned", async () => {
        const s = sampler(id);
        await sleep(200);
        for (let i = 0; i < 2; i++) {
          const el = textarea();
          const cut = el.value.lastIndexOf("\n");
          el.setSelectionRange(cut, el.value.length);
          document.execCommand("delete");
          await sleep(500);
        }
        await sleep(500);
        s.stop();
        const m = moves(s.frames);
        const f = s.frames;
        const shrank = f[0].dock - f[f.length - 1].dock;
        const net = f[f.length - 1].foot - f[0].foot;
        const up = m.filter((x) => x.d < 0);
        await log(`typing-steady: composer -${Math.round(shrank)}px; list moves ${m.length}: ${m.map((x) => `+${x.d}`).join(" ")}; net ${Math.round(net)}px`);
        if (shrank < 30) throw new Error(`the composer shrank only ${Math.round(shrank)}px`);
        if (up.length) throw new Error(`the list moved up ${up.length} times`);
        if (Math.abs(net - shrank) > 2) throw new Error(`the list moved ${Math.round(net)}px for a composer ${Math.round(shrank)}px shorter`);
        const el = timeline(id)!;
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (gap > 1) throw new Error(`no longer at the bottom: ${gap}px below`);
        return `composer -${Math.round(shrank)}px; the list +${Math.round(net)}px in ${m.length} moves; still at the bottom`;
      });

      await step("typing-steady: the prompt sent: the reply that comes in stays pinned to the bottom", async () => {
        const turns = chats()[id].items.filter((i) => i.kind === "turn").length;
        const s = sampler(id);
        await sleep(200);
        // "long reply" is in the prompt: the stand-in answers with another long reply.
        press(" long reply");
        await sleep(200);
        press("\n");
        await waitFor("the second turn to end", () => chats()[id]?.items.filter((i) => i.kind === "turn").length > turns, 60_000);
        await sleep(2000);
        s.stop();
        const el = timeline(id)!;
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        const end = s.frames.slice(-30);
        const off = end.filter((x) => x.gap > 1).length;
        await shot("typing-replied", 300);
        if (gap > 1 || off) throw new Error(`not pinned after the reply: ${gap}px below the bottom (${off} of the last 30 frames off)`);
        const most = Math.max(...s.frames.map((x) => x.gap));
        return `the reply came in (${s.frames.length} frames); at the bottom after it (largest gap on the way ${Math.round(most)}px)`;
      });
      await log("TYPING-DONE");
    },
  };
}
