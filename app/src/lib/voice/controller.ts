// Voice's state and actions, shared by the key handling (components/voice/VoiceHost.tsx), the listening UI in each
// composer, the mic button and Settings. One utterance at a time:
//
//   idle → listening (mic open, level meter) → transcribing (mic already closed) → inserted at the caret → idle
//
// The text pipeline after whisper: clean-up (2relay's rules) → memory (confirmed corrections and the words library,
// applied at once and shown for a moment) → insert → the checker's suggestions (memory pairs offered before, words-library
// near misses, macOS spelling and grammar, optional AI polish), underlined in the composer, never applied on their own.
// What the person then fixes before sending teaches memory (learnFromEdit).

import { create } from "zustand";
import { api } from "../backend";
import { voiceApi, type MicPermission, type SpellHit } from "./api.ts";
import { aiCacheKey, cacheFixes, cachedFixes, validateAiFixes, type AiFix } from "./aiFix.ts";
import { cleanTranscript } from "./clean.ts";
import { learnFromEdit, singleWordFix, type Pair } from "./learn.ts";
import { applyMemory, initialPrompt, recordAccept, recordAlways, recordDismiss, recordNever, recordUse, type Applied } from "./memory.ts";
import { getMemory, getVoicePrefs, loadMemory, updateMemory } from "./prefs.ts";
import { aiNeeded, applySuggestion, check, type Suggestion } from "./suggest.ts";
import { overlaps, tokenize } from "./text.ts";

export type Phase = "idle" | "listening" | "transcribing" | "error";
export type Mode = "hold" | "toggle" | "click";

/** A text field voice can write into (a composer, an answer field, the new-session prompt). */
export interface Target {
  id: string;
  el: HTMLTextAreaElement | HTMLInputElement;
  /** The field shows the listening UI itself (ChatComposer); others get the floating pill. */
  inline: boolean;
  /** "Send when I release": how this field sends (ChatComposer's send). */
  send?: () => void;
}

/** What voice inserted into a field, for highlights, undo and learning. */
export interface Insertion {
  target: string;
  /** The field's text right after inserting (accepted suggestions update it). */
  before: string;
  /** The inserted range in `before`. */
  from: number;
  to: number;
  /** Memory replacements made while inserting (offsets in the field). */
  applied: (Applied & { at: number })[];
  at: number;
}

export interface VoiceState {
  phase: Phase;
  mode: Mode;
  target: string | null;
  level: number;
  /** Recent levels (oldest first) for the meter. */
  levels: number[];
  secs: number;
  since: number;
  partial: string;
  error: string | null;
  /** Shown once per error kind: "permission:denied" etc. */
  permission: MicPermission | null;
  /** The last insertion per field. */
  inserted: Record<string, Insertion>;
  /** Suggestions per field (offsets into the field's current text). */
  suggestions: Record<string, Suggestion[]>;
  /** The suggestion whose card is open, per field. */
  open: Record<string, string | null>;
  /** "Always write X for Y?" under a composer after a clear single-word fix. */
  offer: { target: string; pair: Pair } | null;
  /** Counters for the self-test and Settings (this run): spell checks, AI calls, AI cache hits, memory fixes. */
  stats: { spell: number; ai: number; aiCached: number; memory: number; checks: number };
}

export const useVoice = create<VoiceState>(() => ({
  phase: "idle",
  mode: "hold",
  target: null,
  level: 0,
  levels: [],
  secs: 0,
  since: 0,
  partial: "",
  error: null,
  permission: null,
  inserted: {},
  suggestions: {},
  open: {},
  offer: null,
  stats: { spell: 0, ai: 0, aiCached: 0, memory: 0, checks: 0 },
}));

const set = useVoice.setState;
const get = useVoice.getState;

// ---------------------------------------------------------------- targets

const targets = new Map<string, Target>();
/** The caret/selection in each field when listening started (the person may click elsewhere meanwhile). */
const savedSel = new Map<string, [number, number]>();

export function registerTarget(t: Target): () => void {
  targets.set(t.id, t);
  t.el.dataset.voice = t.id;
  return () => {
    if (targets.get(t.id) === t) targets.delete(t.id);
  };
}
export const targetOf = (el: Element | null): Target | null => {
  const id = el instanceof HTMLElement ? el.dataset.voice : undefined;
  const t = id ? targets.get(id) : undefined;
  return t && t.el === el && !t.el.disabled && !(t.el instanceof HTMLInputElement && t.el.type === "password") ? t : null;
};
export const getTarget = (id: string | null) => (id ? (targets.get(id) ?? null) : null);

// ---------------------------------------------------------------- listening

let unsubLevel: (() => void) | null = null;
let unsubPartial: (() => void) | null = null;

function errorText(e: unknown) {
  const s = e instanceof Error ? e.message : String(e);
  return s;
}

/** Starts listening into `t`. The microphone permission is asked here, the first time only. */
export async function startListening(t: Target, mode: Mode) {
  const st = get();
  if (st.phase === "listening" || st.phase === "transcribing") return;
  const p = getVoicePrefs();
  if (!p.model) {
    set({ phase: "error", target: t.id, error: "Choose a voice model first: Settings > Voice.", mode });
    return;
  }
  savedSel.set(t.id, [t.el.selectionStart ?? t.el.value.length, t.el.selectionEnd ?? t.el.value.length]);
  set({ phase: "listening", mode, target: t.id, level: 0, levels: [], secs: 0, since: performance.now(), partial: "", error: null, offer: null });
  void loadMemory();
  const v = voiceApi();
  try {
    unsubLevel?.();
    unsubLevel = v.onLevel(({ level, secs }) => {
      const s = get();
      if (s.phase !== "listening") return;
      const levels = s.levels.length >= 48 ? [...s.levels.slice(1), level] : [...s.levels, level];
      set({ level, secs, levels });
    });
    // The backend refuses until macOS allows the microphone. Only then, and only the first time (not determined),
    // is the system prompt shown; a self-test's injected fixture never asks.
    const open = async (retry: boolean): Promise<boolean> => {
      try {
        await v.start(p.device, p.model);
        return true;
      } catch (e) {
        const m = /^permission:(\w+)/.exec(errorText(e));
        if (!m) throw e;
        if (m[1] === "not_determined" && retry) {
          const r = await v.requestPermission();
          if (r === "authorized" && get().phase === "listening" && get().target === t.id) return open(false);
        }
        const perm = (m[1] === "not_determined" ? await v.permission() : m[1]) as MicPermission;
        stopEvents();
        set({ phase: "error", permission: perm, error: perm === "denied" || perm === "restricted" ? "coool isn't allowed to use the microphone." : "Microphone permission is needed." });
        return false;
      }
    };
    if (!(await open(true))) return;
    // Released before the microphone opened (a very short hold): stop now.
    if (get().phase !== "listening") void v.cancel();
  } catch (e) {
    stopEvents();
    set({ phase: "error", error: errorText(e) });
  }
}

function stopEvents() {
  unsubLevel?.();
  unsubLevel = null;
  unsubPartial?.();
  unsubPartial = null;
}

/** Esc: nothing is transcribed or inserted. */
export function cancelListening() {
  const s = get();
  if (s.phase === "idle") return;
  stopEvents();
  if (s.phase !== "error") void voiceApi().cancel();
  set({ phase: "idle", partial: "", error: null, level: 0 });
}

export const dismissError = () => set({ phase: "idle", error: null, permission: null });

/** Release (or the second press, or the mic button): close the mic, transcribe, insert. */
export async function stopListening() {
  const s = get();
  if (s.phase !== "listening" || !s.target) return;
  const t = targets.get(s.target);
  const p = getVoicePrefs();
  const mem = await loadMemory();
  set({ phase: "transcribing", level: 0, partial: "" });
  unsubLevel?.();
  unsubLevel = null;
  unsubPartial = voiceApi().onPartial((x) => set((st) => ({ partial: (st.partial + x).trimStart() })));
  try {
    const r = await voiceApi().stop({ model: p.model!, task: p.task, language: p.language === "auto" ? null : p.language, prompt: initialPrompt(mem) || null });
    stopEvents();
    if (get().phase !== "transcribing") return; // cancelled meanwhile
    set({ phase: "idle", partial: "" });
    if (r.silent || !r.text.trim()) {
      set({ phase: "error", error: "Didn't catch anything. Hold the key while you speak." });
      setTimeout(() => get().error?.startsWith("Didn't catch") && dismissError(), 2500);
      return;
    }
    if (!t) return;
    const ins = insertText(t, r.text, s.mode);
    if (ins && p.sendOnRelease && t.send) {
      // The send reads the composer's state: one frame later.
      requestAnimationFrame(() => t.send?.());
      return;
    }
    if (ins) void checkInsertion(t, ins);
  } catch (e) {
    stopEvents();
    if (get().phase === "transcribing") set({ phase: "error", error: errorText(e) });
  }
}

// ---------------------------------------------------------------- inserting

/** Types `text` into a field at `from..to` the way a person would (undo works, React sees an input event). */
export function replaceRange(el: HTMLTextAreaElement | HTMLInputElement, from: number, to: number, text: string) {
  el.focus({ preventScroll: true });
  el.setSelectionRange(from, to);
  // execCommand keeps the field's own undo history (⌘Z undoes the dictation like typing).
  const ok = typeof document.execCommand === "function" && document.execCommand("insertText", false, text);
  if (!ok || el.value.slice(from, from + text.length) !== text) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const v = el.value.slice(0, from) + text + el.value.slice(to);
    setter?.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.setSelectionRange(from + text.length, from + text.length);
  }
}

/** Cleans, applies memory, and inserts the text at the caret (with spaces where the words would otherwise touch). */
export function insertText(t: Target, raw: string, _mode: Mode): Insertion | null {
  const p = getVoicePrefs();
  let text = cleanTranscript(raw, p.cleanup);
  if (!text) return null;
  const el = t.el;
  const sel = el === document.activeElement ? [el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length] : (savedSel.get(t.id) ?? [el.value.length, el.value.length]);
  const [a, b] = sel;
  const before = el.value.slice(0, a);
  const after = el.value.slice(b);
  // Mid-sentence insertion: no capital at the start unless after a sentence end.
  if (before.trim() && !/[.!?\n]\s*$/.test(before) && /^[A-Z][a-z]/.test(text) && !/^I\b/.test(text)) text = text[0].toLowerCase() + text.slice(1);
  if (after.trim() && /^[a-z]/.test(after.trimStart()) && /[.]$/.test(text)) text = text.slice(0, -1);
  const mem = getMemory();
  const m = applyMemory(mem, text);
  text = m.text;
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) && !/^[.,;:!?)]/.test(after) ? " " : "";
  const ins = lead + text + trail;
  replaceRange(el, a, b, ins);
  const from = a + lead.length;
  const to = from + text.length;
  const now = Date.now();
  if (m.applied.length) {
    updateMemory((x) => recordUse(x, m.applied.map((r) => r.entryId), now));
    set((s) => ({ stats: { ...s.stats, memory: s.stats.memory + m.applied.length } }));
  }
  const record: Insertion = { target: t.id, before: el.value, from, to, applied: m.applied.map((r) => ({ ...r, from: r.from + from, to: r.to + from, at: now })), at: now };
  set((s) => ({ inserted: { ...s.inserted, [t.id]: record }, suggestions: { ...s.suggestions, [t.id]: [] } }));
  return record;
}

// ---------------------------------------------------------------- the checker

/** Words macOS's checker passed this session (lowercase). */
const goodWords = new Set<string>();

let insightsOn: boolean | null = null;
async function aiAvailable() {
  if (!getVoicePrefs().aiPolish) return false;
  if (insightsOn === null) {
    try {
      insightsOn = (await api().insightsStatus()).enabled;
    } catch {
      insightsOn = false;
    }
    setTimeout(() => (insightsOn = null), 60_000);
  }
  return insightsOn;
}

/** Suggestions for the inserted range (offsets into the field). Memory and the local checks run first; the AI only
 *  when insights is on, the utterance isn't cached, and the local checks didn't already cover it. */
async function checkInsertion(t: Target, ins: Insertion) {
  const p = getVoicePrefs();
  const text = ins.before.slice(ins.from, ins.to);
  const mem = getMemory();
  let spell: SpellHit[] = [];
  // macOS's checker is asked only when the utterance has a word it hasn't passed this session and that isn't one of
  // the person's words: an utterance memory fully covers costs no check at all.
  const lib = new Set(mem.entries.filter((e) => !e.never).flatMap((e) => e.written.toLowerCase().split(/\s+/)));
  const tokens = tokenize(text);
  const unchecked = tokens.some((tk) => !/^\d/.test(tk.lower) && !goodWords.has(tk.lower) && !lib.has(tk.lower));
  if (p.spell && unchecked) {
    try {
      spell = await voiceApi().spell(text, p.task === "translate" ? "en" : null, mem.entries.map((e) => e.written), true);
      set((s) => ({ stats: { ...s.stats, spell: s.stats.spell + 1 } }));
      for (const tk of tokens) if (!overlaps(tk, spell)) goodWords.add(tk.lower);
      if (goodWords.size > 5000) goodWords.clear();
    } catch {
      /* no checker in this build */
    }
  }
  let local = check({ text, memory: mem, dictated: true, spell });
  let ai: AiFix[] = [];
  const key = aiCacheKey(text, p.task);
  const cached = cachedFixes(mem, key);
  if (cached) {
    ai = cached;
    set((s) => ({ stats: { ...s.stats, aiCached: s.stats.aiCached + 1 } }));
  } else if (aiNeeded(text, mem, spell, local) && (await aiAvailable())) {
    try {
      const r = await voiceApi().polish(text, mem.entries.filter((e) => !e.never).map((e) => e.written).slice(0, 40), p.task);
      if (r.status === "done") {
        ai = validateAiFixes(text, r.fixes);
        updateMemory((m) => cacheFixes(m, key, ai, Date.now()));
        set((s) => ({ stats: { ...s.stats, ai: s.stats.ai + 1 } }));
      }
    } catch {
      /* offline or no backend: local suggestions only */
    }
  }
  if (ai.length) local = check({ text, memory: getMemory(), dictated: true, spell, ai });
  // The field may have changed meanwhile: keep only suggestions whose words are still where they were.
  const cur = t.el.value;
  if (cur.slice(ins.from, ins.to) !== text) return;
  const list = local.map((s) => ({ ...s, from: s.from + ins.from, to: s.to + ins.from })).filter((s) => cur.slice(s.from, s.to) === s.original);
  set((s) => ({ suggestions: { ...s.suggestions, [t.id]: list }, stats: { ...s.stats, checks: s.stats.checks + 1 } }));
}

/** Typed text (Settings > Voice "Check what I type"): re-check the field, debounced by the caller. */
export async function checkTyped(t: Target) {
  const p = getVoicePrefs();
  if (!p.fixTyped) return;
  const text = t.el.value;
  if (!text.trim() || text.length > 4000) return set((s) => ({ suggestions: { ...s.suggestions, [t.id]: [] } }));
  const mem = getMemory();
  let spell: SpellHit[] = [];
  if (p.spell) {
    try {
      spell = await voiceApi().spell(text, null, mem.entries.map((e) => e.written), false);
      set((s) => ({ stats: { ...s.stats, spell: s.stats.spell + 1 } }));
    } catch {
      /* none */
    }
  }
  if (t.el.value !== text) return;
  const ins = get().inserted[t.id];
  // Dictated ranges were checked already (and keep their own suggestions).
  const own = (get().suggestions[t.id] ?? []).filter((s) => ins && s.from >= ins.from && s.to <= ins.to);
  const typed = check({ text, memory: mem, dictated: false, spell }).filter((s) => !own.some((o) => o.from < s.to && s.from < o.to));
  set((s) => ({ suggestions: { ...s.suggestions, [t.id]: [...own, ...typed].sort((a, b) => a.from - b.from) } }));
}

/** Keeps a field's suggestions and insertion record in step with an edit (from ranges.ts). */
export function shiftField(id: string, map: <T extends { from: number; to: number }>(r: T) => T | null, value: string) {
  set((s) => {
    const list = (s.suggestions[id] ?? []).map((x) => map(x)).filter((x): x is Suggestion => !!x);
    const ins = s.inserted[id];
    let inserted = s.inserted;
    if (ins) {
      const r = map({ from: ins.from, to: ins.to });
      // An edit inside the dictated range keeps the record (that's what learning reads); only its end moves.
      inserted = { ...s.inserted, [id]: { ...ins, ...r, applied: ins.applied.map((a) => map(a)).filter((a): a is Applied & { at: number } => !!a) } };
      void value;
    }
    return { suggestions: { ...s.suggestions, [id]: list }, inserted };
  });
}

// ---------------------------------------------------------------- acting on suggestions

const pairOf = (s: Suggestion) => ({ heard: s.original, written: s.replacement });

export function acceptSuggestion(id: string, sug: Suggestion, always = false) {
  const t = targets.get(id);
  if (!t || t.el.value.slice(sug.from, sug.to) !== sug.original) return;
  const { caret } = applySuggestion(t.el.value, sug);
  replaceRange(t.el, sug.from, sug.to, sug.replacement);
  t.el.setSelectionRange(caret, caret);
  const delta = sug.replacement.length - (sug.to - sug.from);
  const p = getVoicePrefs();
  // Spelling and grammar fixes of typed text teach memory only when the person says "Always".
  const teaches = p.learn && (always || sug.kind === "memory" || sug.kind === "term" || sug.kind === "ai" || isDictated(id, sug));
  if (teaches && /\S/.test(sug.original)) {
    const { heard, written } = pairOf(sug);
    const source = sug.kind === "ai" ? "ai" : sug.kind === "spelling" || sug.kind === "grammar" ? "spelling" : "you";
    updateMemory((m) => (always ? recordAlways(m, heard, written, source, Date.now()) : recordAccept(m, heard, written, source, Date.now())));
  }
  set((s) => {
    const ins = s.inserted[id];
    const list = (s.suggestions[id] ?? []).filter((x) => x.id !== sug.id).map((x) => (x.from >= sug.to ? { ...x, from: x.from + delta, to: x.to + delta } : x));
    // The accepted fix is part of the baseline learning compares against (it isn't the person's own edit).
    const inserted = ins && sug.from >= ins.from && sug.to <= ins.to ? { ...s.inserted, [id]: { ...ins, before: t.el.value, to: ins.to + delta } } : s.inserted;
    return { suggestions: { ...s.suggestions, [id]: list }, inserted, open: { ...s.open, [id]: null } };
  });
}

const isDictated = (id: string, s: { from: number; to: number }) => {
  const ins = get().inserted[id];
  return !!ins && s.from >= ins.from && s.to <= ins.to;
};

export function dismissSuggestion(id: string, sug: Suggestion) {
  if (getVoicePrefs().learn) updateMemory((m) => recordDismiss(m, sug.original, sug.replacement, Date.now()));
  set((s) => ({ suggestions: { ...s.suggestions, [id]: (s.suggestions[id] ?? []).filter((x) => x.id !== sug.id) }, open: { ...s.open, [id]: null } }));
}

export function fixAll(id: string) {
  const list = [...(get().suggestions[id] ?? [])].sort((a, b) => b.from - a.from);
  for (const s of list) acceptSuggestion(id, s);
}

export const openSuggestion = (id: string, sugId: string | null) => set((s) => ({ open: { ...s.open, [id]: sugId } }));

/** "Undo, and don't do this again" on a word memory changed. */
export function undoApplied(id: string, a: Applied & { at: number }) {
  const t = targets.get(id);
  if (!t || t.el.value.slice(a.from, a.to) !== a.written) return;
  replaceRange(t.el, a.from, a.to, a.original);
  updateMemory((m) => recordNever(m, a.original, a.written, Date.now()));
  const delta = a.original.length - a.written.length;
  set((s) => {
    const ins = s.inserted[id];
    if (!ins) return {};
    return { inserted: { ...s.inserted, [id]: { ...ins, before: t.el.value, to: ins.to + delta, applied: ins.applied.filter((x) => x !== a) } } };
  });
}

// ---------------------------------------------------------------- learning on send

/** The composer sent `sent`: compare it with what voice inserted and learn the person's small fixes. */
export function noteSent(id: string, sent: string) {
  const s = get();
  const ins = s.inserted[id];
  set((st) => ({ inserted: Object.fromEntries(Object.entries(st.inserted).filter(([k]) => k !== id)), suggestions: { ...st.suggestions, [id]: [] }, open: { ...st.open, [id]: null } }));
  if (!ins || !getVoicePrefs().learn) return;
  const pairs = learnFromEdit(ins.before, { from: ins.from, to: ins.to }, sent);
  if (!pairs.length) return;
  const now = Date.now();
  updateMemory((m) => pairs.reduce((acc, p) => recordAccept(acc, p.heard, p.written, "edit", now), m));
  const one = singleWordFix(pairs);
  const e = one && getMemory().entries.find((x) => x.written === one.written);
  if (one && !e?.confirmed) set({ offer: { target: id, pair: one } });
}

export function answerOffer(add: boolean) {
  const o = get().offer;
  set({ offer: null });
  if (o && add) updateMemory((m) => recordAlways(m, o.pair.heard, o.pair.written, "you", Date.now()));
}
