// Settings > Remote's mock (`pnpm dev`). Off with no devices by default; `?remote=demo` starts on, with two paired
// devices, a few recent actions, and a pairing that a phone "scans" three seconds after Pair an iPhone (so the QR
// code, then the 6-digit confirm, both show).

import type { RemoteApi, RemoteDevice, RemoteStatus } from "./remote";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function mockRemote(): RemoteApi {
  const demo = typeof location !== "undefined" && new URLSearchParams(location.search).get("remote") === "demo";
  const now = Date.now();
  const subs = new Set<() => void>();
  const changed = () => subs.forEach((f) => f());
  const s: RemoteStatus = {
    enabled: demo,
    connected: demo,
    error: null,
    relay: "https://example.convex.cloud",
    devices: demo
      ? [
          { id: "7f3a0c9e2b41d6a85e0f1c3b9d2a4e67", name: "Ada’s iPhone", added: now - 9 * 86_400_000, last_seen: now - 4 * 60_000 },
          { id: "c41e9a07b3d25f6e8a1b0c9d7e3f2a54", name: "Ada’s iPad", added: now - 30 * 86_400_000, last_seen: now - 3 * 86_400_000 },
        ]
      : [],
    pairing: null,
    actions: demo
      ? [
          { at: now - 5 * 60_000, device_id: "7f3a", device: "Ada’s iPhone", kind: "answer", session: "claude:demo", detail: "allowed Bash", ok: true },
          { at: now - 12 * 60_000, device_id: "7f3a", device: "Ada’s iPhone", kind: "send", session: "claude:demo", detail: "sent a message", ok: true },
          { at: now - 40 * 60_000, device_id: "7f3a", device: "Ada’s iPhone", kind: "start", session: "chat:3", detail: "started a chat in atlas (default)", ok: true },
        ]
      : [],
  };
  let claimTimer: ReturnType<typeof setTimeout> | null = null;
  const copy = (): RemoteStatus => structuredClone(s);
  return {
    async status() {
      return copy();
    },
    async setEnabled(on) {
      await wait(300);
      s.enabled = on;
      s.connected = on;
      if (!on) s.pairing = null;
      return copy();
    },
    async pairStart() {
      await wait(250);
      if (!s.connected) throw new Error("not connected to the relay yet");
      const secret = "R2l2ZW4gdG8gYSBtb2NrOyBub3QgYSByZWFsIHNlY3JldA";
      s.pairing = {
        url: `coool://pair?v=1&r=https%3A%2F%2Fexample.convex.cloud&m=00112233445566778899aabbccddeeff&p=0123456789abcdef0123456789abcdef&s=${secret}&ks=gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q&kx=pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk`,
        expires_at: Date.now() + 120_000,
        claim: null,
      };
      if (claimTimer) clearTimeout(claimTimer);
      claimTimer = setTimeout(() => {
        if (s.pairing) {
          s.pairing.claim = { name: "Grace’s iPhone", code: "482915" };
          changed();
        }
      }, 3000);
      return structuredClone(s.pairing);
    },
    async pairConfirm() {
      await wait(300);
      const c = s.pairing?.claim;
      if (!c) throw new Error("no phone has scanned the code yet");
      const d: RemoteDevice = { id: crypto.randomUUID().replace(/-/g, ""), name: c.name, added: Date.now(), last_seen: Date.now() };
      s.devices.push(d);
      s.pairing = null;
      return d;
    },
    async pairCancel() {
      if (claimTimer) clearTimeout(claimTimer);
      s.pairing = null;
    },
    async removeDevice(id) {
      await wait(250);
      s.devices = s.devices.filter((d) => d.id !== id);
      return copy();
    },
    onChange(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}
