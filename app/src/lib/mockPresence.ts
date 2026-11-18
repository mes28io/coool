// `?presence=iphone|mac|browser`: a scripted agent drives a device panel in the browser mock, so agent presence
// (APP_SPEC "Agent presence": the cursors, their labels, typed text arriving and the beam) can be seen and recorded
// without the app. Each opens a chat with that panel and loops a short script:
//
// - iphone: Claude opens General > About in a drawn Settings app, scrolls, renames the phone (typing it), then the
//   pilot goes back and opens Software Update (one step decided by Claude Haiku, one from muscle memory).
// - mac: two chats on the shared Mac at once: Claude types a sentence in a window while Codex works the Dock and menus
//   (two cursors, two tints).
// - browser: Claude fills the coffee-order form in a page that runs the real page script (device/web_agent.js), so
//   the page's own cursor, label and typing are what the app shows; then the pilot replays it from memory.
//
// Events go through the same channels as the real backend's (`sim-activity`, `browser-activity`).

import claudeSvg from "../assets/brands/claude.svg?raw";
import openaiSvg from "../assets/brands/openai.svg?raw";
import agentJs from "../../src-tauri/src/device/web_agent.js?raw";
import type { BrowserActivity, SimActivity } from "./backend";
import { emitMockSimActivity, quietMockSim, repaintMockSim, setMockSimScene } from "./mockSim";
import { quietMockMac, setMockMacText } from "./mockMac";
import type { MockChat } from "./mockChat";
import { chatPanelKey } from "./browserAgent";
import { useStore } from "../store";
import { api } from "./backend";

const browserListeners = new Set<(a: BrowserActivity) => void>();
export function onMockBrowserActivity(cb: (a: BrowserActivity) => void) {
  browserListeners.add(cb);
  return () => browserListeners.delete(cb);
}
const emitBrowser = (a: BrowserActivity) => browserListeners.forEach((cb) => cb(a));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type PresenceDemo = "iphone" | "mac" | "browser";
export const presenceDemo = (): PresenceDemo | null => {
  const m = /[?&]presence=(iphone|mac|browser)\b/.exec(typeof location === "undefined" ? "" : location.search)?.[1];
  return (m as PresenceDemo | undefined) ?? null;
};

/** Opens `chat` in the workspace with its right panel on `kind` (once the store knows the chat). */
async function show(chat: number, kind: "device" | "mac" | "browser") {
  await waitFor(() => {
    const st = useStore.getState();
    return st.ready && st.chatInfos[chat];
  });
  const st = useStore.getState();
  st.open({ kind: "chat", id: chat });
  const key = chatPanelKey(chat);
  if (kind !== "browser") useStore.getState().setRightPanel(key, kind);
  return key;
}

export async function runPresenceDemo(mode: PresenceDemo, make: (provider: "claude" | "codex", cwd: string) => MockChat) {
  if (mode === "iphone") return iphone(make("claude", "~/code/settings-check"));
  if (mode === "mac") return mac(make("claude", "~/code/owl-notes"), make("codex", "~/code/finder-tidy"));
  return browser(make("claude", "~/code/coffee-shop"));
}

// ---------- iPhone: a drawn Settings app ----------

type Row = { label: string; value?: string; icon?: string };
const ROW_H = 46;
const GROUP_GAP = 34;
const SETTINGS: Row[][] = [
  [
    { label: "Wi‑Fi", value: "coool-5G", icon: "#0a84ff" },
    { label: "Bluetooth", value: "On", icon: "#0a84ff" },
    { label: "Cellular", icon: "#30d158" },
  ],
  [
    { label: "General", icon: "#8e8e93" },
    { label: "Accessibility", icon: "#0a84ff" },
    { label: "Camera", icon: "#8e8e93" },
    { label: "Privacy & Security", icon: "#0a84ff" },
    { label: "Screen Time", icon: "#5e5ce6" },
  ],
];
const GENERAL: Row[][] = [
  [{ label: "About" }, { label: "Software Update" }],
  [{ label: "AirDrop" }, { label: "AirPlay & Continuity" }, { label: "Picture in Picture" }],
  [{ label: "iPhone Storage" }, { label: "Background App Refresh" }],
  [{ label: "Date & Time" }, { label: "Keyboard" }, { label: "Fonts" }, { label: "Language & Region" }],
];
const about = (name: string): Row[][] => [
  [{ label: "Name", value: name }, { label: "iOS Version", value: "27.0" }, { label: "Model Name", value: "iPhone 18 Pro" }, { label: "Model Number", value: "MG7X4LL/A" }, { label: "Serial Number", value: "F2LXK9H1QJ" }],
  [{ label: "Songs", value: "0" }, { label: "Videos", value: "0" }, { label: "Photos", value: "12" }, { label: "Applications", value: "9" }],
  [{ label: "Capacity", value: "256 GB" }, { label: "Available", value: "231.4 GB" }],
  [{ label: "Wi‑Fi Address", value: "4C:20:B8:91:3E:07" }, { label: "Bluetooth", value: "4C:20:B8:91:3E:08" }],
];
const UPDATE: Row[][] = [[{ label: "Automatic Updates", value: "On" }, { label: "Beta Updates", value: "Off" }]];

interface Screen {
  title: string;
  back?: string;
  groups: Row[][];
  scroll: number;
  /** The rename sheet: the field's text and whether its caret shows. */
  edit?: string;
  note?: string;
}

const TOP = 150;
/** Where row `r` of group `g` is on screen (its centre), for the script's taps. */
function rowAt(s: Screen, g: number, r: number): { x: number; y: number } {
  let y = TOP - s.scroll;
  for (let i = 0; i < g; i++) y += s.groups[i].length * ROW_H + GROUP_GAP;
  return { x: 201, y: y + r * ROW_H + ROW_H / 2 };
}

function drawSettings(s: Screen) {
  return (g: OffscreenCanvasRenderingContext2D, W: number, H: number) => {
    const font = (w: number, px: number) => `${w} ${px}px -apple-system, "SF Pro Text", system-ui, sans-serif`;
    g.fillStyle = "#f2f2f7";
    g.fillRect(0, 0, W, H);
    if (s.edit != null) {
      // The rename screen: a single field.
      g.fillStyle = "#007aff";
      g.font = font(400, 17);
      g.fillText("‹ About", 12, 70);
      g.fillStyle = "#000";
      g.font = font(600, 17);
      g.textAlign = "center";
      g.fillText("Name", W / 2, 70);
      g.textAlign = "left";
      g.fillStyle = "#fff";
      g.beginPath();
      g.roundRect(16, 108, W - 32, 46, 11);
      g.fill();
      g.fillStyle = "#000";
      g.font = font(400, 17);
      g.fillText(s.edit, 32, 137);
      const tw = g.measureText(s.edit).width;
      g.fillStyle = "#007aff";
      g.fillRect(33 + tw, 120, 2, 22);
      // The keyboard.
      g.fillStyle = "#d1d3d9";
      g.fillRect(0, H - 300, W, 300);
      g.fillStyle = "#fff";
      const keys = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
      keys.forEach((row, i) => {
        const kw = 33;
        const x0 = (W - row.length * (kw + 6)) / 2;
        [...row].forEach((k, j) => {
          g.fillStyle = "#fff";
          g.beginPath();
          g.roundRect(x0 + j * (kw + 6), H - 286 + i * 56, kw, 44, 6);
          g.fill();
          g.fillStyle = "#000";
          g.font = font(400, 20);
          g.textAlign = "center";
          g.fillText(k, x0 + j * (kw + 6) + kw / 2, H - 257 + i * 56);
          g.textAlign = "left";
        });
      });
      g.fillStyle = "#007aff";
      g.beginPath();
      g.roundRect(W - 104, H - 118, 92, 44, 6);
      g.fill();
      g.fillStyle = "#fff";
      g.font = font(500, 16);
      g.fillText("done", W - 78, H - 90);
      return;
    }
    let y = TOP - s.scroll;
    g.save();
    g.beginPath();
    g.rect(0, 92, W, H - 92);
    g.clip();
    g.fillStyle = "#000";
    g.font = font(700, 32);
    g.fillText(s.title, 20, y - 16);
    for (const group of s.groups) {
      g.fillStyle = "#fff";
      g.beginPath();
      g.roundRect(16, y, W - 32, group.length * ROW_H, 11);
      g.fill();
      group.forEach((row, i) => {
        const ry = y + i * ROW_H;
        let x = 32;
        if (row.icon) {
          g.fillStyle = row.icon;
          g.beginPath();
          g.roundRect(28, ry + 9, 28, 28, 7);
          g.fill();
          x = 68;
        }
        g.fillStyle = "#000";
        g.font = font(400, 17);
        g.fillText(row.label, x, ry + 29);
        g.fillStyle = "#8a8a8e";
        g.textAlign = "right";
        g.fillText(`${row.value ?? ""}${row.value ? "  " : ""}›`, W - 32, ry + 29);
        g.textAlign = "left";
        if (i < group.length - 1) {
          g.fillStyle = "#e5e5ea";
          g.fillRect(x, ry + ROW_H - 0.5, W - 16 - x, 1);
        }
      });
      y += group.length * ROW_H + GROUP_GAP;
    }
    if (s.note) {
      g.fillStyle = "#6c6c70";
      g.font = font(400, 13);
      g.fillText(s.note, 32, y - 10);
    }
    g.restore();
    // The bar on top, with the back button and the small title once scrolled.
    g.fillStyle = "rgba(242,242,247,.94)";
    g.fillRect(0, 0, W, 92);
    g.fillStyle = "#000";
    g.font = font(600, 17);
    const d = new Date();
    g.fillText(`${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`, 44, 36);
    if (s.back) {
      g.fillStyle = "#007aff";
      g.font = font(400, 17);
      g.fillText(`‹ ${s.back}`, 12, 70);
    }
    if (s.scroll > 40) {
      g.fillStyle = "#000";
      g.font = font(600, 17);
      g.textAlign = "center";
      g.fillText(s.title, W / 2, 70);
      g.textAlign = "left";
    }
    g.fillStyle = "rgba(0,0,0,.85)";
    g.beginPath();
    g.roundRect(W / 2 - 68, H - 14, 136, 5, 3);
    g.fill();
  };
}

async function iphone(chat: MockChat) {
  quietMockSim();
  await show(chat.id, "device");
  const udid = await waitFor(() => useStore.getState().device[chatPanelKey(chat.id)]?.udid);
  await api().simBoot(udid);
  const root: Screen = { title: "Settings", groups: SETTINGS, scroll: 0 };
  let s: Screen = root;
  const paint = (next: Screen) => {
    s = next;
    setMockSimScene(drawSettings(s));
  };
  paint(root);
  const ev = (who: { actor: string; by: "agent" | "pilot"; decider?: string }, a: Partial<SimActivity> & { kind: SimActivity["kind"] }) =>
    emitMockSimActivity({ udid, chat: chat.id, source: "agent", provider: "claude", ...who, ...a });
  const claude = { actor: `${chat.id}:c1`, by: "agent" as const };
  const scrollTo = async (to: number) => {
    const from = s.scroll;
    for (let i = 1; i <= 10; i++) {
      paint({ ...s, scroll: from + ((to - from) * (1 - Math.pow(1 - i / 10, 3))) });
      await wait(30);
    }
  };
  for (;;) {
    paint(root);
    await wait(1400);
    ev(claude, { kind: "observe" });
    await wait(900);
    const general = rowAt(s, 1, 0);
    ev(claude, { kind: "tap", ...general, label: "General" });
    await wait(330);
    paint({ title: "General", back: "Settings", groups: GENERAL, scroll: 0 });
    await wait(1100);
    ev(claude, { kind: "tap", ...rowAt(s, 0, 0), label: "About" });
    await wait(330);
    paint({ title: "About", back: "General", groups: about("coool iPhone"), scroll: 0 });
    await wait(1000);
    ev(claude, { kind: "scroll", x: 201, y: 640, x2: 201, y2: 380, label: "down" });
    await wait(200);
    await scrollTo(260);
    await wait(900);
    ev(claude, { kind: "scroll", x: 201, y: 380, x2: 201, y2: 640, label: "up" });
    await wait(200);
    await scrollTo(0);
    await wait(800);
    ev(claude, { kind: "tap", ...rowAt(s, 0, 0), label: "Name" });
    await wait(330);
    paint({ ...s, edit: "" });
    await wait(500);
    const name = "Ada's iPhone";
    ev(claude, { kind: "type", x: 120, y: 131, label: "Name", text: name });
    for (let i = 1; i <= name.length; i++) {
      paint({ ...s, edit: name.slice(0, i) });
      await wait(55);
    }
    await wait(500);
    ev(claude, { kind: "press", label: "return" });
    await wait(250);
    paint({ title: "About", back: "General", groups: about(name), scroll: 0 });
    await wait(900);
    ev(claude, { kind: "observe" });
    await wait(700);
    ev(claude, { kind: "end" });
    // The pilot takes the next goal: back to General, then Software Update.
    await wait(1800);
    const pilot = { actor: `${chat.id}:p1`, by: "pilot" as const };
    ev({ ...pilot }, { kind: "app", label: "pilot" });
    await wait(300);
    ev({ ...pilot, decider: "haiku" }, { kind: "think" });
    await wait(1100);
    ev({ ...pilot, decider: "haiku" }, { kind: "tap", x: 40, y: 64, label: "General" });
    await wait(330);
    paint({ title: "General", back: "Settings", groups: GENERAL, scroll: 0 });
    await wait(700);
    ev({ ...pilot, decider: "memory" }, { kind: "tap", ...rowAt(s, 0, 1), label: "Software Update" });
    await wait(330);
    paint({ title: "Software Update", back: "General", groups: UPDATE, scroll: 0, note: "iOS 27.0 · iOS is up to date" });
    await wait(900);
    ev(pilot, { kind: "end" });
    await wait(3200);
    repaintMockSim();
  }
}

function waitFor<T>(f: () => T | null | undefined): Promise<T> {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      const v = f();
      if (v) {
        clearInterval(t);
        resolve(v);
      }
    }, 50);
  });
}

// ---------- Mac: two chats at once ----------

async function mac(a: MockChat, b: MockChat) {
  quietMockMac();
  await show(a.id, "mac");
  await api().macInstall();
  await api().macBoot();
  setMockMacText("");
  const ev = (chat: MockChat, actor: string, x: Partial<SimActivity> & { kind: SimActivity["kind"] }) =>
    emitMockSimActivity({ udid: "mac", chat: chat.id, source: "agent", provider: chat.provider, actor, by: "agent", ...x });
  const A = `${a.id}:c1`;
  const B = `${b.id}:c1`;
  const sentence = "Seven purple owls read 42 maps at dawn.";
  for (;;) {
    setMockMacText("");
    await wait(1200);
    ev(a, A, { kind: "app", label: "launch" });
    await wait(700);
    ev(a, A, { kind: "tap", x: 560, y: 300, label: "Untitled" });
    await wait(500);
    // Codex, in another chat, works the same Mac meanwhile.
    void (async () => {
      await wait(300);
      ev(b, B, { kind: "tap", x: 640 - 150, y: 768, label: "Finder" });
      await wait(1500);
      ev(b, B, { kind: "tap", x: 95, y: 12, label: "File" });
      await wait(1300);
      ev(b, B, { kind: "scroll", x: 1100, y: 420, label: "down" });
      await wait(1400);
      ev(b, B, { kind: "tap", x: 1080, y: 640, label: "Downloads" });
      await wait(900);
      ev(b, B, { kind: "end" });
    })();
    ev(a, A, { kind: "type", x: 560, y: 300, label: "Untitled", text: sentence });
    for (let i = 1; i <= sentence.length; i++) {
      setMockMacText(sentence.slice(0, i));
      await wait(45);
    }
    await wait(500);
    ev(a, A, { kind: "press", label: "return" });
    await wait(900);
    ev(a, A, { kind: "observe" });
    await wait(1200);
    ev(a, A, { kind: "end" });
    await wait(4000);
  }
}

// ---------- Browser: the real page script in a framed page ----------

/** A brand SVG as the page script's mark: `{viewBox, paths: [[d, fill]]}` (as device/presence.rs `mark`). */
function markOf(svg: string) {
  const attr = (tag: string, n: string) => new RegExp(`\\s${n}="([^"]*)"`).exec(tag)?.[1];
  const head = svg.split(">")[0];
  const paths = svg
    .split("<path")
    .slice(1)
    .map((p) => p.split(">")[0])
    .map((t) => [attr(t, "d") ?? "", attr(t, "fill") ?? "currentColor"]);
  return { viewBox: attr(head, "viewBox") ?? "0 0 24 24", paths };
}
const MARKS = { claude: markOf(claudeSvg), codex: markOf(openaiSvg), pilot: { viewBox: "0 0 16 16", paths: [["M8 1.6 13.6 14a.5.5 0 0 1-.7.6L8 12.1l-4.9 2.5a.5.5 0 0 1-.7-.6L8 1.6Z", "currentColor"]] } };

const FORM = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Order coffee</title>
<style>
  body { margin: 0; font: 15px/1.45 -apple-system, system-ui, sans-serif; background: #f6f5f2; color: #1d1b17; }
  main { max-width: 380px; margin: 48px auto; background: #fff; border-radius: 14px; padding: 26px 28px 28px; box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 12px 32px -18px rgba(0,0,0,.25); }
  h1 { font-size: 21px; margin: 0 0 4px; } p.sub { margin: 0 0 20px; color: #6f6a61; font-size: 14px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 6px; }
  input { box-sizing: border-box; width: 100%; height: 38px; border: 1px solid #ddd8cf; border-radius: 9px; padding: 0 11px; font: inherit; background: #fff; color: #1d1b17; }
  .cups { display: flex; align-items: center; gap: 12px; margin-top: 18px; }
  .cups output { font-weight: 600; min-width: 64px; }
  button { height: 36px; border-radius: 9px; border: 1px solid #ddd8cf; background: #fff; font: inherit; font-weight: 600; padding: 0 14px; }
  button.go { width: 100%; margin-top: 22px; background: #1d1b17; color: #fff; border-color: #1d1b17; height: 40px; }
  #done { margin-top: 16px; color: #1a7f37; font-weight: 600; min-height: 22px; }
</style></head><body><main>
<h1>Order coffee</h1><p class="sub">Pick up at the counter in about five minutes.</p>
<label for="n">Name</label><input id="n" autocomplete="off">
<label for="e">Email</label><input id="e" type="email" autocomplete="off">
<div class="cups"><output id="c">1 cup</output><button id="add" type="button">Add cup</button></div>
<button class="go" id="go" type="button">Submit order</button>
<div id="done"></div>
</main><script>
var cups = 1;
document.getElementById("add").onclick = function () { cups++; document.getElementById("c").textContent = cups + " cups"; };
document.getElementById("go").onclick = function () { document.getElementById("done").textContent = "Order confirmed for " + document.getElementById("n").value + ": " + cups + " cups, reference CUP-" + (100 + 7 * cups + document.getElementById("n").value.length) + "."; };
var LIB = __LIB__;
addEventListener("message", function (e) {
  var d = e.data;
  if (!d || d.coool !== 1) return;
  if (d.reset) { location.reload(); return; }
  parent.postMessage({ coool: 1, id: d.id, out: LIB(d.cmd) }, "*");
});
</script></body></html>`;

async function browser(chat: MockChat) {
  await waitFor(() => useStore.getState().chatInfos[chat.id]);
  const key = await show(chat.id, "browser");
  const url = URL.createObjectURL(new Blob([FORM.replace("__LIB__", agentJs.trim().replace(/;?\s*$/, ""))], { type: "text/html" }));
  useStore.getState().openBrowser(key, { kind: "web", url });
  let n = 0;
  const call = async (cmd: Record<string, unknown>) => {
    const frame = await waitFor(() => document.querySelector<HTMLIFrameElement>("[data-browser-panel] iframe"));
    const id = ++n;
    return new Promise<Record<string, unknown>>((resolve) => {
      const on = (e: MessageEvent) => {
        if (e.data?.coool !== 1 || e.data.id !== id) return;
        removeEventListener("message", on);
        const out = JSON.parse(e.data.out as string);
        resolve((out.ok ?? {}) as Record<string, unknown>);
      };
      addEventListener("message", on);
      frame.contentWindow?.postMessage({ coool: 1, id, cmd }, "*");
    });
  };
  const reset = async () => {
    document.querySelector<HTMLIFrameElement>("[data-browser-panel] iframe")?.contentWindow?.postMessage({ coool: 1, reset: true }, "*");
    await wait(600);
  };
  const tab = () => useStore.getState().browser[key]?.active ?? null;
  const cursors = new Map<string, number[]>();
  const act = async (who: { actor: string; by: "agent" | "pilot"; decider?: string; slot: number }, op: string, extra: Record<string, unknown>, kind = op, label?: string, text?: string) => {
    const name = who.by === "pilot" ? "Pilot" : "Claude";
    const presence = { actor: who.actor, name, mark: who.by === "pilot" ? MARKS.pilot : MARKS.claude, tint: ["#0a84ff", "#5e5ce6", "#2a9fbc"][who.slot], decider: who.decider ?? null, from: cursors.get(who.actor) ?? null, reduce: document.documentElement.classList.contains("reduce-motion"), defer: 50 };
    const r = await call({ op, ...extra, presence });
    if (Array.isArray(r.at)) cursors.set(who.actor, r.at as number[]);
    emitBrowser({ chat: chat.id, tab: tab(), kind, label: label ?? (r.what as string) ?? null, text: text ?? null, actor: who.actor, by: who.by, decider: who.decider ?? null, provider: "claude", slot: who.slot });
    return r;
  };
  const end = async (who: { actor: string; by: "agent" | "pilot"; slot: number }) => {
    await call({ op: "presence", end: true, presence: { actor: who.actor } });
    emitBrowser({ chat: chat.id, tab: tab(), kind: "end", actor: who.actor, by: who.by, provider: "claude", slot: who.slot });
  };
  for (;;) {
    await wait(1500);
    const snap = await call({ op: "observe" });
    const els = (snap.els ?? []) as { id: number; name: string }[];
    const id = (name: string) => els.find((e) => e.name === name)?.id;
    const claude = { actor: `${chat.id}:c1`, by: "agent" as const, slot: 0 };
    emitBrowser({ chat: chat.id, tab: tab(), kind: "navigate", label: "https://coffee.example/order", actor: claude.actor, by: "agent", provider: "claude", slot: 0 });
    await wait(700);
    await act(claude, "observe", { say: "Reading the page" }, "observe");
    await wait(900);
    await act(claude, "type", { id: id("Name"), text: "Ada Lovelace" }, "type", undefined, "Ada Lovelace");
    await wait(1300);
    await act(claude, "type", { id: id("Email"), text: "ada@example.com" }, "type", undefined, "ada@example.com");
    await wait(1300);
    await act(claude, "click", { id: id("Add cup") }, "click");
    await wait(900);
    await act(claude, "click", { id: id("Add cup") }, "click");
    await wait(1000);
    await act(claude, "click", { id: id("Submit order") }, "click");
    await wait(1400);
    await end(claude);
    await wait(2600);
    // The pilot replays the same form from muscle memory, fast.
    await reset();
    const again = await call({ op: "observe" });
    const els2 = (again.els ?? []) as { id: number; name: string }[];
    const id2 = (name: string) => els2.find((e) => e.name === name)?.id;
    const pilot = { actor: `${chat.id}:p1`, by: "pilot" as const, decider: "memory", slot: 1 };
    await act(pilot, "type", { id: id2("Name"), text: "Grace Hopper" }, "type", undefined, "Grace Hopper");
    await wait(650);
    await act(pilot, "type", { id: id2("Email"), text: "grace@example.com" }, "type", undefined, "grace@example.com");
    await wait(650);
    for (let i = 0; i < 2; i++) {
      await act(pilot, "click", { id: id2("Add cup") }, "click");
      await wait(420);
    }
    await act(pilot, "click", { id: id2("Submit order") }, "click");
    await wait(900);
    await end(pilot);
    await wait(3000);
    await reset();
  }
}
