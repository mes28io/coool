// Voice settings (Settings > Voice), kept with the app's other UI settings in localStorage, and the memory store
// (words library + learned corrections) loaded once from its JSON file in coool's app data folder and saved back
// shortly after each change.

import { useSyncExternalStore } from "react";
import { voiceApi } from "./api.ts";
import { emptyMemory, exportMemory, parseMemory, prune, type Memory } from "./memory.ts";

/** A key chord ("⌥Space"): the KeyboardEvent `code` plus modifiers. */
export interface Chord {
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}
/** Push-to-talk keys: held alone. Right Option is read by the page; Fn by the app (it never reaches web pages). */
export type HoldKey = "AltRight" | "MetaRight" | "Fn" | "off";

export interface VoicePrefs {
  /** Off until set up (the onboarding's Skip leaves it as it was). */
  enabled: boolean;
  task: "translate" | "transcribe";
  /** A whisper language code, or "auto". */
  language: string;
  /** The model file in use, and its catalogue id when it is one. */
  model: string | null;
  modelId: string | null;
  /** Input device by name; null = the system default. */
  device: string | null;
  hold: HoldKey;
  toggle: Chord | null;
  sendOnRelease: boolean;
  cleanup: boolean;
  /** Learn from my corrections (memory). */
  learn: boolean;
  /** macOS spelling and grammar suggestions on dictated text. */
  spell: boolean;
  /** Check typed text in the composer too (not only dictated text). */
  fixTyped: boolean;
  /** Optional AI polish of dictated text (only acts with AI insights on). */
  aiPolish: boolean;
  /** Keep the last recording as a WAV file in coool's voice folder, for troubleshooting (off by default). */
  keepRecording: boolean;
}

export const DEFAULT_TOGGLE: Chord = { code: "Space", meta: false, ctrl: false, alt: true, shift: false };
export const DEFAULTS: VoicePrefs = {
  enabled: false,
  task: "translate",
  language: "auto",
  model: null,
  modelId: null,
  device: null,
  hold: "AltRight",
  toggle: DEFAULT_TOGGLE,
  sendOnRelease: false,
  cleanup: true,
  learn: true,
  spell: true,
  fixTyped: false,
  aiPolish: true,
  keepRecording: false,
};

const KEY = "coool.voice";

function store<T>(init: T, write: (v: T) => void) {
  let v = init;
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set(next: T) {
      v = next;
      write(v);
      subs.forEach((f) => f());
    },
    sub: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  };
}

const read = (): VoicePrefs => {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
};
/** The browser mock's `?voice=demo`: voice on, with the mock's recommended model. */
const demo = (p: VoicePrefs): VoicePrefs =>
  typeof location !== "undefined" && /[?&]voice=demo\b/.test(location.search) && !/[?&]model=none\b/.test(location.search) && !p.model
    ? { ...p, enabled: true, model: "~/Library/Application Support/sh.coool.app/voice/models/ggml-medium-q5_0.bin", modelId: "medium-q5_0" }
    : p;
const prefs = store<VoicePrefs>(typeof localStorage === "undefined" ? DEFAULTS : demo(read()), (v) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* private mode: lasts for this window */
  }
});

export const getVoicePrefs = prefs.get;
export const setVoicePrefs = (patch: Partial<VoicePrefs>) => prefs.set({ ...prefs.get(), ...patch });
export const useVoicePrefs = () => useSyncExternalStore(prefs.sub, prefs.get);
export const subscribeVoicePrefs = prefs.sub;
/** Voice can listen: on, and a model chosen. */
export const voiceReady = (p: VoicePrefs) => p.enabled && !!p.model;

// ---------------------------------------------------------------- memory

const mem = store<Memory | null>(null, () => {});
let loading: Promise<Memory> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let version = 0;

/** The memory, loaded once (an empty one with coool's developer words when there is no file yet). */
export function loadMemory(): Promise<Memory> {
  const cur = mem.get();
  if (cur) return Promise.resolve(cur);
  loading ??= voiceApi()
    .memoryRead()
    .then((s) => {
      let m = emptyMemory();
      if (s) {
        try {
          m = parseMemory(JSON.parse(s), Date.now());
        } catch {
          /* unreadable: start fresh (the file is replaced on the next save) */
        }
      }
      if (!mem.get()) mem.set(m);
      return mem.get()!;
    })
    .catch(() => {
      if (!mem.get()) mem.set(emptyMemory());
      return mem.get()!;
    });
  return loading;
}

export const getMemory = () => mem.get() ?? emptyMemory();
export const useMemory = () => useSyncExternalStore(mem.sub, mem.get);
/** Bumped on every change (cache keys that depend on memory use it). */
export const memoryVersion = () => version;

/** Changes the memory and saves it (debounced) to its file. */
export function updateMemory(f: (m: Memory) => Memory) {
  const next = prune(f(getMemory()), Date.now());
  version++;
  mem.set(next);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void voiceApi().memoryWrite(exportMemory(next)).catch(() => {}), 400);
}

/** "Clear everything": the file is deleted; coool's own developer words come back. */
export async function clearMemory() {
  if (saveTimer) clearTimeout(saveTimer);
  await voiceApi().memoryClear();
  version++;
  mem.set(emptyMemory());
}
