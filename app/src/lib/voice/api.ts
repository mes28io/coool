// Voice's calls into the backend (app/src-tauri/src/voice): the Tauri commands and events, or a browser mock for
// `pnpm dev` (knobs: `?voice=demo` starts with a model ready; `&mic=denied|not_determined|authorized|restricted`;
// `&model=none|downloading`). Kept apart from lib/backend.ts so voice stays in its own files.

import { isTauri } from "../backend";
import type { AiFix } from "./aiFix.ts";

export type MicPermission = "not_determined" | "restricted" | "denied" | "authorized" | "unavailable";

export interface VoiceStatus {
  available: boolean;
  permission: MicPermission;
  loaded: string | null;
  listening: boolean;
  models_dir: string;
  memory_path: string;
}

export type Progress =
  | { state: "downloading"; bytes: number; total: number }
  | { state: "paused"; bytes: number; total: number }
  | { state: "verifying"; total: number }
  | { state: "done"; path: string }
  | { state: "failed"; error: string }
  | { state: "cancelled" };

export interface ModelRow {
  id: string;
  file: string;
  label: string;
  bytes: number;
  sha256: string;
  translates: boolean;
  note: string;
  path: string | null;
  partial: number | null;
  download: Progress | null;
}
export interface FoundModel {
  path: string;
  bytes: number;
  id: string | null;
  place: "coool" | "models" | "other";
}
export interface Models {
  catalog: ModelRow[];
  found: FoundModel[];
  dir: string;
  recommended: string;
  free: number | null;
}

export interface Transcript {
  text: string;
  language: string;
  ms: number;
  secs: number;
  load_ms: number;
  silent: boolean;
}
export interface StopReq {
  model: string;
  task: "translate" | "transcribe";
  language?: string | null;
  prompt?: string | null;
}
export interface SpellHit {
  from: number;
  to: number;
  word: string;
  guesses: string[];
  grammar?: string | null;
}
export interface ProjectWord {
  word: string;
  from: string;
}
export type PolishReply =
  | { status: "off"; has_key: boolean }
  | { status: "limited" }
  | { status: "error"; message: string }
  | { status: "done"; fixes: unknown; model: string; usd: number; ms: number };

export interface VoiceApi {
  kind: "tauri" | "mock";
  status(): Promise<VoiceStatus>;
  permission(): Promise<MicPermission>;
  requestPermission(): Promise<MicPermission>;
  openPrivacy(): Promise<void>;
  devices(): Promise<{ name: string; default: boolean }[]>;
  start(device: string | null, model: string | null): Promise<string>;
  stop(req: StopReq): Promise<Transcript>;
  cancel(): Promise<void>;
  preload(model: string): Promise<void>;
  models(): Promise<Models>;
  download(id: string): Promise<void>;
  pause(id: string): Promise<void>;
  cancelDownload(id: string): Promise<void>;
  deleteModel(id: string): Promise<void>;
  checkModel(path: string): Promise<FoundModel>;
  memoryRead(): Promise<string | null>;
  memoryWrite(json: string): Promise<void>;
  memoryClear(): Promise<void>;
  reveal(what: "memory" | "models"): Promise<void>;
  projectWords(cwd: string): Promise<ProjectWord[]>;
  spell(text: string, language: string | null, ignore: string[], grammar: boolean): Promise<SpellHit[]>;
  polish(text: string, words: string[], mode: string): Promise<PolishReply>;
  pickModelFile(): Promise<string | null>;
  onLevel(cb: (l: { level: number; secs: number }) => void): () => void;
  onPartial(cb: (text: string) => void): () => void;
  onModel(cb: (p: { id: string } & Progress) => void): () => void;
  onFn(cb: (down: boolean) => void): () => void;
  onError(cb: (e: string) => void): () => void;
}

let made: VoiceApi | null = null;
export function voiceApi(): VoiceApi {
  made ??= isTauri ? tauriVoice() : mockVoice();
  return made;
}

function tauriVoice(): VoiceApi {
  const core = import("@tauri-apps/api/core");
  const ev = import("@tauri-apps/api/event");
  const call = async <T>(cmd: string, args?: Record<string, unknown>) => (await core).invoke<T>(cmd, args);
  const sub = <T>(name: string, cb: (p: T) => void) => {
    let off: (() => void) | null = null;
    let dead = false;
    void ev.then((e) => e.listen<T>(name, (x) => cb(x.payload))).then((u) => (dead ? u() : (off = u)));
    return () => {
      dead = true;
      off?.();
    };
  };
  return {
    kind: "tauri",
    status: () => call("voice_status"),
    permission: () => call("voice_permission"),
    requestPermission: () => call("voice_permission_request"),
    openPrivacy: () => call("voice_open_privacy"),
    devices: () => call("voice_devices"),
    start: (device, model) => call("voice_start", { device, model }),
    stop: (req) => call("voice_stop", { req }),
    cancel: () => call("voice_cancel"),
    preload: (model) => call("voice_preload", { model }),
    models: () => call("voice_models"),
    download: (id) => call("voice_model_download", { id }),
    pause: (id) => call("voice_model_pause", { id }),
    cancelDownload: (id) => call("voice_model_cancel", { id }),
    deleteModel: (id) => call("voice_model_delete", { id }),
    checkModel: (path) => call("voice_model_check", { path }),
    memoryRead: () => call("voice_memory_read"),
    memoryWrite: (json) => call("voice_memory_write", { json }),
    memoryClear: () => call("voice_memory_clear"),
    reveal: (what) => call("voice_reveal", { what }),
    projectWords: (cwd) => call("voice_project_words", { cwd }),
    spell: (text, language, ignore, grammar) => call("voice_spell", { text, language, ignore, grammar }),
    polish: (text, words, mode) => call("voice_polish", { req: { text, words, mode } }),
    pickModelFile: async () => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const r = await open({ multiple: false, directory: false, title: "Choose a whisper model (ggml-*.bin)", filters: [{ name: "Whisper model", extensions: ["bin"] }] });
      return typeof r === "string" ? r : null;
    },
    onLevel: (cb) => sub("voice-level", cb),
    onPartial: (cb) => sub("voice-partial", cb),
    onModel: (cb) => sub("voice-model", cb),
    onFn: (cb) => sub("voice-fn", cb),
    onError: (cb) => sub("voice-error", cb),
  };
}

// ---------------------------------------------------------------- browser mock

const knob = (k: string) => (typeof location !== "undefined" ? (new RegExp(`[?&]${k}=([\\w-]+)`).exec(location.search)?.[1] ?? null) : null);

/** What the mock "hears": the next queued line, else a fixed demo line (a mishearing of "Tauri", for the fixer). */
export const mockHeard: string[] = [];
const DEMO_LINE = "Um, update the tory config so the store can recieve events from the towry window.";

const CATALOG: Omit<ModelRow, "path" | "partial" | "download">[] = [
  { id: "base", file: "ggml-base.bin", label: "Base", bytes: 147_951_465, sha256: "", translates: true, note: "Fastest. Fine for English; rough for other languages and translation." },
  { id: "small", file: "ggml-small.bin", label: "Small", bytes: 487_601_967, sha256: "", translates: true, note: "Fast. Good English, usable translation." },
  { id: "medium-q5_0", file: "ggml-medium-q5_0.bin", label: "Medium (compact)", bytes: 539_212_467, sha256: "", translates: true, note: "Recommended. Medium's translation quality at a third of its size." },
  { id: "medium", file: "ggml-medium.bin", label: "Medium", bytes: 1_533_763_059, sha256: "", translates: true, note: "What 2relay uses. Best translation here; slower and large." },
  { id: "large-v3-turbo-q5_0", file: "ggml-large-v3-turbo-q5_0.bin", label: "Large v3 Turbo (compact)", bytes: 574_041_195, sha256: "", translates: false, note: "Best for “Transcribe as spoken”. Can't translate to English." },
];

function mockVoice(): VoiceApi {
  const demo = knob("voice") === "demo";
  let perm: MicPermission = (knob("mic") as MicPermission | null) ?? (demo ? "authorized" : "not_determined");
  const dir = "~/Library/Application Support/sh.coool.app/voice/models";
  const have = new Map<string, string>();
  if (demo && knob("model") !== "none") have.set("medium-q5_0", `${dir}/ggml-medium-q5_0.bin`);
  const dl = new Map<string, Progress>();
  if (knob("model") === "downloading") dl.set("medium-q5_0", { state: "downloading", bytes: 212_000_000, total: 539_212_467 });
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const levelCbs = new Set<(l: { level: number; secs: number }) => void>();
  const partialCbs = new Set<(t: string) => void>();
  const modelCbs = new Set<(p: { id: string } & Progress) => void>();
  let listening: { t0: number; timer: ReturnType<typeof setInterval> } | null = null;
  let memory: string | null = null;
  const on = <T>(set: Set<T>, cb: T) => (set.add(cb), () => void set.delete(cb));
  const stopLevels = () => {
    if (listening) clearInterval(listening.timer);
    listening = null;
    levelCbs.forEach((f) => f({ level: 0, secs: 0 }));
  };
  return {
    kind: "mock",
    status: async () => ({ available: true, permission: perm, loaded: null, listening: !!listening, models_dir: dir, memory_path: "~/Library/Application Support/sh.coool.app/voice/memory.json" }),
    permission: async () => perm,
    requestPermission: async () => {
      if (perm === "not_determined") perm = "authorized";
      return perm;
    },
    openPrivacy: async () => {},
    devices: async () => [
      { name: "MacBook Pro Microphone", default: true },
      { name: "AirPods Pro", default: false },
    ],
    start: async () => {
      if (perm !== "authorized") throw new Error(`permission:${perm}`);
      const t0 = performance.now();
      const timer = setInterval(() => {
        const s = (performance.now() - t0) / 1000;
        // Speech-like: syllable bursts over a slow swell, with short pauses.
        const level = Math.max(0, 0.25 + 0.45 * Math.abs(Math.sin(s * 7.3)) * (0.6 + 0.4 * Math.sin(s * 1.7)) - (Math.sin(s * 2.1) > 0.92 ? 0.4 : 0));
        levelCbs.forEach((f) => f({ level: Math.min(1, level), secs: s }));
      }, 40);
      listening = { t0, timer };
      return "MacBook Pro Microphone";
    },
    stop: async () => {
      const secs = listening ? (performance.now() - listening.t0) / 1000 : 0;
      stopLevels();
      const text = mockHeard.shift() ?? DEMO_LINE;
      await new Promise((r) => setTimeout(r, 160));
      partialCbs.forEach((f) => f(text));
      await new Promise((r) => setTimeout(r, 120));
      return { text, language: "en", ms: 280, secs, load_ms: 0, silent: false };
    },
    cancel: async () => stopLevels(),
    preload: async () => {},
    models: async () => ({
      catalog: CATALOG.map((c) => ({ ...c, path: have.get(c.id) ?? null, partial: null, download: dl.get(c.id) ?? null })),
      found: [...have.entries()].map(([id, path]) => ({ path, bytes: CATALOG.find((c) => c.id === id)!.bytes, id, place: "coool" as const })),
      dir,
      recommended: "medium-q5_0",
      free: 212_000_000_000,
    }),
    download: async (id) => {
      const c = CATALOG.find((x) => x.id === id)!;
      const cur = dl.get(id);
      let bytes = cur && "bytes" in cur ? cur.bytes : 0;
      clearInterval(timers.get(id));
      timers.set(
        id,
        setInterval(() => {
          bytes = Math.min(c.bytes, bytes + c.bytes / 60);
          const p: Progress = bytes >= c.bytes ? { state: "done", path: `${dir}/${c.file}` } : { state: "downloading", bytes, total: c.bytes };
          dl.set(id, p);
          if (p.state === "done") {
            have.set(id, p.path);
            clearInterval(timers.get(id));
          }
          modelCbs.forEach((f) => f({ id, ...p }));
        }, 250),
      );
    },
    pause: async (id) => {
      clearInterval(timers.get(id));
      const cur = dl.get(id);
      if (cur?.state === "downloading") {
        const p: Progress = { state: "paused", bytes: cur.bytes, total: cur.total };
        dl.set(id, p);
        modelCbs.forEach((f) => f({ id, ...p }));
      }
    },
    cancelDownload: async (id) => {
      clearInterval(timers.get(id));
      dl.delete(id);
      modelCbs.forEach((f) => f({ id, state: "cancelled" }));
    },
    deleteModel: async (id) => void have.delete(id),
    checkModel: async (path) => ({ path, bytes: 1_533_763_059, id: "medium", place: "other" }),
    memoryRead: async () => memory,
    memoryWrite: async (j) => void (memory = j),
    memoryClear: async () => void (memory = null),
    reveal: async () => {},
    projectWords: async () => [
      { word: "harbor", from: "package.json" },
      { word: "zustand", from: "package.json" },
      { word: "tauri-apps", from: "package.json" },
      { word: "ChatComposer", from: "file" },
      { word: "coool-core", from: "Cargo.toml" },
    ],
    spell: async (text) => {
      // A tiny stand-in for NSSpellChecker: flags a few known misspellings.
      const bad: Record<string, string> = { recieve: "receive", teh: "the", seperate: "separate", definately: "definitely" };
      const out: SpellHit[] = [];
      for (const m of text.matchAll(/\p{L}+/gu)) {
        const g = bad[m[0].toLowerCase()];
        if (g) out.push({ from: m.index!, to: m.index! + m[0].length, word: m[0], guesses: [g] });
      }
      return out;
    },
    polish: async () => ({ status: "off", has_key: false }),
    pickModelFile: async () => "~/models/ggml-medium.bin",
    onLevel: (cb) => on(levelCbs, cb),
    onPartial: (cb) => on(partialCbs, cb),
    onModel: (cb) => on(modelCbs, cb),
    onFn: () => () => {},
    onError: () => () => {},
  };
}

export type { AiFix };
