// coool Remote (docs/REMOTE.md): Settings > Remote's calls (app/src-tauri/src/remote.rs), kept apart from the main
// Backend so the feature stays in its own files. In a plain browser (`pnpm dev`) they go to lib/mockRemote.ts
// (`?remote=demo`: a pairing in progress with its QR code, then the confirm, and two paired devices).

import { isTauri } from "./backend";
import { chatDefaultsNow, seenModelsNow } from "./prefs";
import { contextPrefNow } from "./agentContext";

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
// Claude Code's `--model` aliases always work (Settings > General lists them first); the rest are what chats reported.
const CLAUDE_ALIASES = [
  { id: "opus", label: "Opus (latest)" },
  { id: "sonnet", label: "Sonnet (latest)" },
  { id: "haiku", label: "Haiku (latest)" },
];
function syncDefaults() {
  const d = chatDefaultsNow();
  // Minor 1: the models a phone may start a chat on, the same list Settings > General offers.
  const seen = seenModelsNow();
  const models = {
    claude: [...CLAUDE_ALIASES, ...seen.claude.filter((m) => !CLAUDE_ALIASES.some((a) => a.id === m.id))],
    codex: seen.codex,
  };
  const context = contextPrefNow();
  const s = JSON.stringify({ d, models, context });
  if (s === lastDefaults) return;
  lastDefaults = s;
  import("@tauri-apps/api/core").then(({ invoke }) => invoke("remote_set_defaults", { defaults: { ...d, models, context } }).catch(() => (lastDefaults = "")));
}
// Minor 1: the Needs-you page's words, risk tags and AI reads for the pending requests, so the phone shows them too.
let lastNotes = "";
function syncNotes() {
  import("./remoteNotes").then(({ needNotes }) => {
    const n = needNotes();
    const s = JSON.stringify(n);
    if (s === lastNotes) return;
    lastNotes = s;
    import("@tauri-apps/api/core").then(({ invoke }) => invoke("remote_set_need_notes", { notes: n }).catch(() => (lastNotes = "")));
  });
}
/**
 * Minor 2, voice to prompt from the phone: the Mac decoded the phone's recording; it goes through this Mac's own
 * dictation with the person's settings (their model, translate or transcribe, language, their words), then is cleaned
 * and corrected from their word memory as a dictation here is (lib/voice), and the text goes back to the phone to be
 * checked before it is sent. The recording itself stays in the backend's memory and is dropped when this ends.
 */
async function remoteVoice(id: string) {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const { getVoicePrefs, loadMemory } = await import("./voice/prefs");
    const { echoWords, applyMemory } = await import("./voice/memory");
    const { cleanTranscript } = await import("./voice/clean");
    const p = getVoicePrefs();
    if (!p.model) throw new Error("No voice model on this Mac yet: download one in Settings > Voice.");
    const mem = await loadMemory();
    const r = (await invoke("remote_voice_run", { id, req: { model: p.model, task: p.task, language: p.language === "auto" ? null : p.language, vocabulary: echoWords(mem), keep: false } })) as { text: string; heard: string };
    let text = r.heard === "words" ? cleanTranscript(r.text, p.cleanup) : "";
    if (text) text = applyMemory(mem, text).text;
    await invoke("remote_voice_done", { id, text, heard: text ? r.heard : r.heard === "words" ? "unclear" : r.heard, error: null });
  } catch (e) {
    await invoke("remote_voice_done", { id, text: null, heard: null, error: e instanceof Error ? e.message : String(e) }).catch(() => {});
  }
}
if (isTauri && typeof window !== "undefined") {
  syncDefaults();
  setInterval(syncDefaults, 5_000);
  setInterval(syncNotes, 1_500);
  void import("@tauri-apps/api/event").then(({ listen }) => listen<{ id: string }>("remote-voice", (e) => void remoteVoice(e.payload.id)));
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
