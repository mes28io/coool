// The Mac panel's mock (`pnpm dev`): a VM that "installs" in a few seconds (progress events), boots through a short
// setup, streams a generated desktop as JPEG frames, and makes a fake agent click every ~7 s while attached.

import { MAC_NETWORK_TRUTH, type Backend, type MacStatus } from "./backend";
import { emitMockSimActivity } from "./mockSim";

type Mac = Pick<Backend, "macStatus" | "macInstall" | "macBoot" | "macShutdown" | "macAttach" | "macDetach" | "macInput" | "macBind" | "macNetwork" | "onMacState">;

const W = 1280;
const H = 800;

async function frame(cursor: { x: number; y: number }, typed: string): Promise<ArrayBuffer | null> {
  if (typeof OffscreenCanvas === "undefined") return null;
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext("2d");
  if (!g) return null;
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#2a3d66");
  bg.addColorStop(1, "#6b3a5e");
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  // Menu bar.
  g.fillStyle = "rgba(255,255,255,.72)";
  g.fillRect(0, 0, W, 24);
  g.fillStyle = "#111";
  g.font = "600 13px -apple-system, system-ui, sans-serif";
  g.fillText("Finder   File   Edit   View   Go   Window   Help", 36, 17);
  const d = new Date();
  g.fillText(`${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`, W - 56, 17);
  // A window.
  g.fillStyle = "rgba(246,246,246,.96)";
  g.beginPath();
  g.roundRect(220, 140, 720, 440, 12);
  g.fill();
  for (const [i, col] of ["#ff5f57", "#febc2e", "#28c840"].entries()) {
    g.fillStyle = col;
    g.beginPath();
    g.arc(244 + i * 20, 162, 6, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = "#222";
  g.font = "15px ui-monospace, Menlo, monospace";
  g.fillText(`$ ${typed}▌`, 244, 210);
  // Dock.
  g.fillStyle = "rgba(255,255,255,.28)";
  g.beginPath();
  g.roundRect(W / 2 - 260, H - 76, 520, 64, 18);
  g.fill();
  // Pointer.
  g.fillStyle = "#fff";
  g.strokeStyle = "#000";
  g.beginPath();
  g.moveTo(cursor.x, cursor.y);
  g.lineTo(cursor.x, cursor.y + 18);
  g.lineTo(cursor.x + 5, cursor.y + 14);
  g.lineTo(cursor.x + 12, cursor.y + 13);
  g.closePath();
  g.fill();
  g.stroke();
  const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  return blob.arrayBuffer();
}

/** The presence demo (lib/mockPresence.ts): what TextEdit's window holds, pushed to the screen at once. */
const typedHooks = { set: (_t: string) => {}, quiet: false };
export const setMockMacText = (t: string) => typedHooks.set(t);
export const quietMockMac = () => (typedHooks.quiet = true);

export function mockMac(): Mac {
  const st: MacStatus = {
    available: true,
    state: "absent",
    installed: false,
    provisioned: false,
    os: "macOS 27.0",
    cpus: 4,
    memoryMB: 8192,
    w: W,
    h: H,
    diskBytes: 0,
    free: 182e9,
    sharedDir: "/Users/you/Library/Application Support/sh.coool/mac/shared",
    network: "on",
  };
  const listeners = new Set<(s: Partial<MacStatus>) => void>();
  const emit = (p: Partial<MacStatus>) => {
    Object.assign(st, p);
    for (const cb of listeners) cb(p);
  };
  const streams = new Map<number, { timers: ReturnType<typeof setInterval>[]; onFrame: (b: ArrayBuffer) => void }>();
  const cursor = { x: W / 2, y: H / 2 };
  let typed = "";
  let ids = 0;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const push = () =>
    void frame(cursor, typed).then((b) => {
      if (b) for (const s of streams.values()) s.onFrame(b);
    });
  typedHooks.set = (t) => {
    typed = t;
    push();
  };
  return {
    async macStatus() {
      await wait(100);
      return { ...st, progress: st.progress && { ...st.progress } };
    },
    async macInstall() {
      if (st.installed) return;
      const total = 16e9;
      for (let i = 0; i <= 20; i++) {
        emit({ state: "downloading", progress: { phase: "download", fraction: i / 20, done: (total * i) / 20, total } });
        await wait(150);
      }
      for (let i = 0; i <= 10; i++) {
        emit({ state: "installing", progress: { phase: "install", fraction: i / 10 } });
        await wait(200);
      }
      st.installed = true;
      st.diskBytes = 24e9;
      emit({ state: "stopped", progress: undefined });
    },
    async macBoot() {
      if (st.state === "running") return;
      emit({ state: "starting", error: undefined });
      await wait(1200);
      if (!st.provisioned) {
        for (const step of ["Creating the user account", "Skipping Setup Assistant", "Installing the coool agent"]) {
          emit({ state: "setting-up", step });
          await wait(1000);
        }
        st.provisioned = true;
      }
      emit({ state: "running", step: undefined, networkNow: st.network ?? "on" });
    },
    async macShutdown() {
      emit({ state: "stopping" });
      await wait(700);
      emit({ state: "stopped", networkNow: null });
    },
    async macAttach(onFrame) {
      const stream = ++ids;
      const timers = [
        setInterval(push, 2000),
        setInterval(() => {
          if (typedHooks.quiet) return;
          const x = 260 + Math.random() * 640;
          const y = 180 + Math.random() * 360;
          emitMockSimActivity({ udid: "mac", chat: null, source: "agent", kind: "tap", x, y, label: "Click" });
        }, 7000),
      ];
      streams.set(stream, { timers, onFrame });
      setTimeout(push, 60);
      return { w: W, h: H, stream };
    },
    async macDetach(stream) {
      streams.get(stream)?.timers.forEach(clearInterval);
      streams.delete(stream);
    },
    async macInput(inputs) {
      for (const input of inputs) {
        if (input.kind === "pointer" || input.kind === "scroll") {
          cursor.x = input.x;
          cursor.y = input.y;
        } else if (input.kind === "text") typed += input.text;
        else if (input.kind === "keyDown") {
          if (input.code === 51) typed = typed.slice(0, -1);
          else if (input.code === 36) typed = "";
          else if (input.code === 49) typed += " ";
        } else continue;
        push();
      }
    },
    async macBind() {},
    async macNetwork(mode) {
      if (mode) {
        // Live when the running Mac has a network device (it always does in the mock).
        emit({ network: mode, networkNow: st.state === "running" ? mode : null });
      }
      const n = st.network ?? "on";
      return { network: n, networkNow: st.networkNow ?? null, applies: st.state === "running" ? "now" : "next boot", truth: MAC_NETWORK_TRUTH[n] };
    },
    onMacState(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
