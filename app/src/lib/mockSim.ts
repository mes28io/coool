// The iPhone panel's mock (`pnpm dev`): two simulators, a generated home screen streamed as JPEG frames, and a fake
// agent tap / swipe every ~6 s while a screen is attached, so DevicePanel's overlay can be seen.

import type { Backend, SimActivity, SimDevice } from "./backend";

type Sim = Pick<
  Backend,
  "simDevices" | "simEnsureDevice" | "simBoot" | "simShutdown" | "simAttach" | "simDetach" | "simInput" | "simBind" | "onSimActivity" | "onSimState"
>;

const W = 402;
const H = 874;
const COLORS = ["#ff9f0a", "#30d158", "#0a84ff", "#ff375f", "#bf5af2", "#64d2ff", "#ffd60a", "#ff453a", "#5e5ce6", "#32ade6", "#ac8e68", "#66d4cf"];

async function frame(touch: { x: number; y: number } | null): Promise<ArrayBuffer | null> {
  if (typeof OffscreenCanvas === "undefined") return null;
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext("2d");
  if (!g) return null;
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#1c2b4a");
  bg.addColorStop(1, "#4a2350");
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#fff";
  g.font = "600 17px -apple-system, system-ui, sans-serif";
  const d = new Date();
  g.fillText(`${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`, 44, 36);
  const size = 62;
  const gap = (W - 4 * size) / 5;
  for (let i = 0; i < 24; i++) {
    const x = gap + (i % 4) * (size + gap);
    const y = 90 + Math.floor(i / 4) * (size + 34);
    g.fillStyle = COLORS[i % COLORS.length];
    g.beginPath();
    g.roundRect(x, y, size, size, 14);
    g.fill();
  }
  g.fillStyle = "rgba(255,255,255,.22)";
  g.beginPath();
  g.roundRect(16, H - 120, W - 32, 92, 30);
  g.fill();
  g.fillStyle = "rgba(255,255,255,.85)";
  g.beginPath();
  g.roundRect(W / 2 - 68, H - 14, 136, 5, 3);
  g.fill();
  if (touch) {
    g.fillStyle = "rgba(255,255,255,.45)";
    g.beginPath();
    g.arc(touch.x, touch.y, 22, 0, Math.PI * 2);
    g.fill();
  }
  const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  return blob.arrayBuffer();
}

export function mockSim(): Sim {
  const devices: SimDevice[] = [
    { udid: "MOCK-COOOL-1", name: "coool iPhone", state: "Shutdown", runtime: "iOS 27.0", deviceType: "iPhone 18 Pro", coool: true },
    { udid: "MOCK-USER-1", name: "iPhone 18 Pro", state: "Shutdown", runtime: "iOS 27.0", deviceType: "iPhone 18 Pro", coool: false },
  ];
  const activity = new Set<(a: SimActivity) => void>();
  const state = new Set<(s: { udid: string; state: string }) => void>();
  const streams = new Map<number, { udid: string; timers: ReturnType<typeof setInterval>[]; onFrame: (b: ArrayBuffer) => void }>();
  const touches = new Map<string, { x: number; y: number } | null>();
  let ids = 0;
  const setState = (udid: string, s: string) => {
    const d = devices.find((x) => x.udid === udid);
    if (!d) return;
    d.state = s;
    for (const cb of state) cb({ udid, state: s });
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    async simDevices() {
      await wait(120);
      return { available: true, devices: devices.map((d) => ({ ...d })) };
    },
    async simEnsureDevice() {
      await wait(400);
      return devices.find((d) => d.coool)!.udid;
    },
    async simBoot(udid) {
      if (devices.find((d) => d.udid === udid)?.state === "Booted") return;
      setState(udid, "Booting");
      await wait(1500);
      setState(udid, "Booted");
    },
    async simShutdown(udid) {
      setState(udid, "Shutting Down");
      await wait(500);
      setState(udid, "Shutdown");
    },
    async simAttach(udid, onFrame) {
      const stream = ++ids;
      const send = () => void frame(touches.get(udid) ?? null).then((b) => b && streams.has(stream) && onFrame(b));
      let n = 0;
      const timers = [
        setInterval(send, 1000),
        setInterval(() => {
          const tap = n++ % 2 === 0;
          const a: SimActivity = tap
            ? { udid, chat: null, source: "agent", kind: "tap", x: 60 + Math.random() * (W - 120), y: 140 + Math.random() * 500, label: "Tap" }
            : { udid, chat: null, source: "agent", kind: "swipe", x: W / 2, y: H - 160, x2: W / 2, y2: 260, label: "Swipe up" };
          for (const cb of activity) cb(a);
        }, 6000),
      ];
      streams.set(stream, { udid, timers, onFrame });
      setTimeout(send, 60);
      return { w: W, h: H, scale: 3, stream };
    },
    async simDetach(_udid, stream) {
      streams.get(stream)?.timers.forEach(clearInterval);
      streams.delete(stream);
    },
    async simInput(udid, input) {
      if (input.kind !== "touch") return;
      touches.set(udid, input.phase === "up" ? null : { x: input.x, y: input.y });
      void frame(touches.get(udid) ?? null).then((b) => {
        if (!b) return;
        // Push the touched frame to that device's open streams (the real backend streams continuously).
        for (const s of streams.values()) if (s.udid === udid) s.onFrame(b);
      });
    },
    async simBind() {},
    onSimActivity(cb) {
      activity.add(cb);
      return () => activity.delete(cb);
    },
    onSimState(cb) {
      state.add(cb);
      return () => state.delete(cb);
    },
  };
}
