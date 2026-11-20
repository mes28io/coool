// coool Remote (docs/REMOTE.md): Settings > Remote's calls (app/src-tauri/src/remote.rs), kept apart from the main
// Backend so the feature stays in its own files. In a plain browser (`pnpm dev`) they go to lib/mockRemote.ts
// (`?remote=demo`: a pairing in progress with its QR code, then the confirm, and two paired devices).

import { isTauri } from "./backend";
import { chatDefaultsNow } from "./prefs";

export interface RemoteDevice {
  id: string;
  name: string;
  added: number;
  last_seen: number;
}

export interface RemoteAction {
  at: number;
  device_id: string;
  device: string;
  /** "answer" | "send" | "stop" | "start" | "refused". */
  kind: string;
  session: string | null;
  detail: string;
  ok: boolean;
}

export interface RemotePairing {
  /** The QR code's payload (`coool://pair?...`). */
  url: string;
  expires_at: number;
  /** Set once a phone scanned it: the name it gave and the code both sides show. */
  claim: { name: string; code: string } | null;
}

export interface RemoteStatus {
  enabled: boolean;
  connected: boolean;
  error: string | null;
  relay: string;
  devices: RemoteDevice[];
  pairing: RemotePairing | null;
  actions: RemoteAction[];
}

export interface RemoteApi {
  status(): Promise<RemoteStatus>;
  setEnabled(enabled: boolean): Promise<RemoteStatus>;
  pairStart(): Promise<RemotePairing>;
  pairConfirm(): Promise<RemoteDevice>;
  pairCancel(): Promise<void>;
  removeDevice(id: string): Promise<RemoteStatus>;
  /** Calls `f` when the backend says Remote's status changed (a phone scanned the code, an action, a connection). */
  onChange(f: () => void): () => void;
}

function tauriRemote(): RemoteApi {
  const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => (await import("@tauri-apps/api/core")).invoke<T>(cmd, args);
  return {
    status: () => invoke("remote_status"),
    setEnabled: (enabled) => invoke("remote_set_enabled", { enabled }),
    pairStart: () => invoke("remote_pair_start"),
    pairConfirm: () => invoke("remote_pair_confirm"),
    pairCancel: () => invoke("remote_pair_cancel"),
    removeDevice: (id) => invoke("remote_remove_device", { id }),
    onChange(f) {
      let off: (() => void) | null = null;
      let dead = false;
      import("@tauri-apps/api/event").then(({ listen }) => listen("remote-changed", () => f()).then((u) => (dead ? u() : (off = u))));
      return () => {
        dead = true;
        off?.();
      };
    },
  };
}

let impl: RemoteApi | null = null;
export async function remoteApi(): Promise<RemoteApi> {
  if (impl) return impl;
  impl = isTauri ? tauriRemote() : (await import("./mockRemote")).mockRemote();
  return impl;
}

// A remote `start` uses the same model as a new chat here, and the same mode when it is one that asks (the backend
// replaces Bypass and full access with the asking mode itself, whatever this says). Kept in step from the page.
let lastDefaults = "";
function syncDefaults() {
  const d = chatDefaultsNow();
  const s = JSON.stringify(d);
  if (s === lastDefaults) return;
  lastDefaults = s;
  import("@tauri-apps/api/core").then(({ invoke }) => invoke("remote_set_defaults", { defaults: d }).catch(() => (lastDefaults = "")));
}
if (isTauri && typeof window !== "undefined") {
  syncDefaults();
  setInterval(syncDefaults, 5_000);
}

/** "Seen 3 min ago" style words for a device's last-seen time. */
export function seenWords(ms: number, now: number): string {
  if (!ms) return "Not seen yet";
  const d = Math.max(0, now - ms);
  if (d < 90_000) return "Seen just now";
  if (d < 3_600_000) return `Seen ${Math.round(d / 60_000)} min ago`;
  if (d < 86_400_000) return `Seen ${Math.round(d / 3_600_000)} h ago`;
  return `Seen ${new Date(ms).toLocaleDateString()}`;
}
