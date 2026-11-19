// The voice memory: one store for the person's words library, learned corrections, spoken phrases and the AI cache.
// Replacement semantics ported from 2relay's MisspellingDictionary (longest first, case-insensitive, whole word,
// multi-word variants across any whitespace). Every function is pure and returns a new Memory; the caller persists it.
// Unit-tested in memory.test.ts.

import type { AiFix } from "./aiFix.ts";
import { escapeRe, overlaps, protectedSpans, W, type Span } from "./text.ts";

export type Source = "seed" | "you" | "edit" | "spelling" | "ai" | "project" | "import";
export interface Entry {
  id: string;
  written: string;
  heard: string[];
  source: Source;
  confirmed: boolean;
  accepts: number;
  dismissals: number;
  never: boolean;
  uses: number;
  lastUsed: number;
  created: number;
  /** A new heard form of an already-confirmed word, with its acceptances: it joins `heard` (auto-applied) only at
   *  CONFIRM_AT, so one acceptance never auto-applies it just because the word was known. Lowercase keys. */
  pending?: Record<string, number>;
  /** Heard forms suppressed for this word: dismissal count, or NEVER for "don't do this again". Per form, so muting
   *  one near-miss doesn't silence the whole word. Lowercase keys. */
  muted?: Record<string, number>;
}
export interface Phrase {
  spoken: string;
  written: string;
  on: boolean;
  builtin: boolean;
}
export interface AiCacheItem {
  key: string;
  fixes: AiFix[];
  at: number;
}
export interface Memory {
  version: 1;
  entries: Entry[];
  phrases: Phrase[];
  aiCache: AiCacheItem[];
}

export const CONFIRM_AT = 2;
export const SUPPRESS_AT = 2;
export const MAX_ENTRIES = 2000,
  MAX_UNCONFIRMED = 400,
  STALE_DAYS = 90,
  MAX_AI_CACHE = 200;
const NEVER = 99;
const DAY = 86_400_000;
const SOURCES: ReadonlySet<string> = new Set(["seed", "you", "edit", "spelling", "ai", "project", "import"]);

// coool's developer dictionary. No heard form is a common English word on its own ("cool", "cloud", "rust", "react").
export const SEED: ReadonlyArray<Pick<Entry, "written" | "heard">> = [
  { written: "Claude Code", heard: ["cloud code", "clawed code"] },
  { written: "Claude", heard: ["clawed"] },
  { written: "Codex", heard: ["codecs"] },
  { written: "GitHub", heard: ["git hub", "github"] },
  { written: "TypeScript", heard: ["type script", "typescript"] },
  { written: "JavaScript", heard: ["java script", "javascript"] },
  { written: "npm", heard: ["n p m"] },
  { written: "pnpm", heard: ["p n p m", "pnp m"] },
  { written: "Tauri", heard: ["tory", "towery", "tori"] },
  { written: "Zustand", heard: ["zoo stand", "zu stand", "zustan"] },
  { written: "Xcode", heard: ["x code"] },
  { written: "macOS", heard: ["mac os"] },
  { written: "API", heard: ["a p i"] },
  { written: "OAuth", heard: ["o auth"] },
  { written: "Next.js", heard: ["next js"] },
  { written: "Node.js", heard: ["node js"] },
  { written: "localhost", heard: ["local host"] },
  { written: "exponential backoff", heard: ["exponential back off"] },
  { written: "README", heard: ["read me"] },
  { written: "CLI", heard: ["c l i"] },
  { written: "JSON", heard: [] },
  { written: "Rust", heard: [] },
  { written: "React", heard: [] },
  { written: "coool", heard: [] },
];

export const PHRASES: ReadonlyArray<Phrase> = [
  { spoken: "new line", written: "\n", on: true, builtin: true },
  { spoken: "new paragraph", written: "\n\n", on: true, builtin: true },
  { spoken: "open paren", written: "(", on: false, builtin: true },
  { spoken: "close paren", written: ")", on: false, builtin: true },
  // Off: the person may want to *say* "slash model"; never invent commands.
  { spoken: "slash compact", written: "/compact", on: false, builtin: true },
  { spoken: "slash clear", written: "/clear", on: false, builtin: true },
  { spoken: "slash model", written: "/model", on: false, builtin: true },
  { spoken: "at file", written: "@", on: false, builtin: true },
];

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const key = (s: string) => clean(s).toLowerCase();
const hasHeard = (e: Entry, h: string) => e.heard.some((x) => key(x) === key(h));
const copy = (e: Entry): Entry => ({ ...e, heard: [...e.heard], pending: e.pending && { ...e.pending }, muted: e.muted && { ...e.muted } });
const bump = (rec: Record<string, number> | undefined, k: string, by = 1) => ({ ...rec, [k]: (rec?.[k] ?? 0) + by });
function drop(rec: Record<string, number> | undefined, k: string): Record<string, number> | undefined {
  if (!rec || !(k in rec)) return rec;
  const out = { ...rec };
  delete out[k];
  return Object.keys(out).length ? out : undefined;
}

function nextId(entries: Entry[]): string {
  let max = 0;
  for (const e of entries) {
    const m = /^e([0-9a-z]+)$/.exec(e.id);
    if (m) max = Math.max(max, parseInt(m[1], 36));
  }
  return "e" + (max + 1).toString(36);
}

function newEntry(entries: Entry[], written: string, heard: string[], source: Source, now: number): Entry {
  return { id: nextId(entries), written, heard, source, confirmed: false, accepts: 0, dismissals: 0, never: false, uses: 0, lastUsed: now, created: now };
}

export function emptyMemory(): Memory {
  return {
    version: 1,
    entries: SEED.map((s, i) => ({
      id: "e" + (i + 1).toString(36),
      written: s.written,
      heard: [...s.heard],
      source: "seed",
      confirmed: true,
      accepts: 0,
      dismissals: 0,
      never: false,
      uses: 0,
      lastUsed: 0,
      created: 0,
    })),
    phrases: PHRASES.map((p) => ({ ...p })),
    aiCache: [],
  };
}

/** A heard form belongs to one word: the entry `owner` takes it from every other entry. */
function claim(entries: Entry[], owner: Entry, heard: string) {
  const k = key(heard);
  for (const e of entries) {
    if (e === owner) continue;
    if (hasHeard(e, heard)) e.heard = e.heard.filter((x) => key(x) !== k);
    e.pending = drop(e.pending, k);
  }
}

/** Library words (prompt bias and near-miss targets): not "never", not a bare dismissal stub. */
export function isLibrary(e: Entry): boolean {
  return !e.never && (e.confirmed || e.heard.length === 0 || e.accepts > 0);
}

// ---- disk / import ----------------------------------------------------------------------------------------------

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
function counts(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) if (typeof n === "number" && Number.isFinite(n) && n > 0) out[key(k)] = n;
  return Object.keys(out).length ? out : undefined;
}

function parseEntry(v: unknown, now: number): Entry | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "not an object";
  const o = v as Record<string, unknown>;
  if (typeof o.written !== "string" || !clean(o.written)) return "missing written";
  const written = clean(o.written);
  if (o.heard !== undefined && !Array.isArray(o.heard)) return "heard is not a list";
  const heard: string[] = [];
  for (const h of (o.heard as unknown[] | undefined) ?? [])
    if (typeof h === "string" && clean(h) && clean(h) !== written && !heard.some((x) => key(x) === key(h))) heard.push(clean(h));
  const e: Entry = {
    id: typeof o.id === "string" && /^[\w-]{1,40}$/.test(o.id) ? o.id : "",
    written,
    heard,
    source: typeof o.source === "string" && SOURCES.has(o.source) ? (o.source as Source) : "import",
    confirmed: o.confirmed === true,
    accepts: Math.floor(num(o.accepts, 0)),
    dismissals: Math.floor(num(o.dismissals, 0)),
    never: o.never === true,
    uses: Math.floor(num(o.uses, 0)),
    lastUsed: num(o.lastUsed, now),
    created: num(o.created, now),
  };
  const pending = counts(o.pending);
  const muted = counts(o.muted);
  if (pending) e.pending = pending;
  if (muted) e.muted = muted;
  return e;
}

function maxRec(a?: Record<string, number>, b?: Record<string, number>) {
  if (!a || !b) return a ?? b;
  const out = { ...a };
  for (const [k, n] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, n);
  return out;
}

/** Same `written`: union of heard forms, max of counters, confirmed/never = either. */
function mergeInto(a: Entry, b: Entry) {
  for (const h of b.heard) if (!hasHeard(a, h)) a.heard.push(h);
  a.accepts = Math.max(a.accepts, b.accepts);
  a.dismissals = Math.max(a.dismissals, b.dismissals);
  a.uses = Math.max(a.uses, b.uses);
  a.lastUsed = Math.max(a.lastUsed, b.lastUsed);
  a.created = Math.min(a.created, b.created);
  a.confirmed ||= b.confirmed;
  a.never ||= b.never;
  if (a.source === "seed" && b.source !== "seed") a.source = b.source;
  const pending = maxRec(a.pending, b.pending);
  const muted = maxRec(a.muted, b.muted);
  if (pending) a.pending = pending;
  if (muted) a.muted = muted;
}

/** Merges duplicates, gives every entry a unique id, and leaves each heard form with one owner: confirmed beats
 *  unconfirmed, then the person's own ("you"), then the newer. */
function normalise(list: Entry[]): Entry[] {
  const out: Entry[] = [];
  const byWritten = new Map<string, Entry>();
  for (const e of list) {
    const have = byWritten.get(e.written);
    if (have) mergeInto(have, e);
    else {
      const c = copy(e);
      byWritten.set(e.written, c);
      out.push(c);
    }
  }
  const ids = new Set<string>();
  for (const e of out) {
    if (!e.id || ids.has(e.id)) e.id = "";
    else ids.add(e.id);
  }
  for (const e of out)
    if (!e.id) {
      e.id = nextId(out);
      ids.add(e.id);
    }
  const rank = (e: Entry) => [e.never ? 0 : 1, e.confirmed ? 1 : 0, e.source === "you" ? 1 : 0, e.lastUsed, e.created];
  const better = (a: Entry, b: Entry) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i];
    return false;
  };
  const owner = new Map<string, Entry>();
  for (const e of out)
    for (const h of e.heard) {
      const k = key(h);
      const o = owner.get(k);
      if (!o) owner.set(k, e);
      else if (better(e, o)) {
        o.heard = o.heard.filter((x) => key(x) !== k);
        owner.set(k, e);
      } else e.heard = e.heard.filter((x) => key(x) !== k);
    }
  return out;
}

function parsePhrases(v: unknown): Phrase[] {
  const out: Phrase[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(v) ? v : []) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (typeof o.spoken !== "string" || typeof o.written !== "string" || !clean(o.spoken) || !o.written) continue;
    const spoken = key(o.spoken);
    if (seen.has(spoken)) continue;
    seen.add(spoken);
    const builtin = PHRASES.some((b) => b.spoken === spoken);
    out.push({ spoken, written: o.written, on: o.on === true, builtin });
  }
  for (const b of PHRASES) if (!seen.has(b.spoken)) out.push({ ...b });
  return out;
}

function parseCache(v: unknown): AiCacheItem[] {
  const out: AiCacheItem[] = [];
  for (const c of Array.isArray(v) ? v : []) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    if (typeof o.key !== "string" || typeof o.at !== "number" || !Array.isArray(o.fixes)) continue;
    const fixes = o.fixes.filter(
      (f): f is AiFix =>
        !!f &&
        typeof f === "object" &&
        typeof f.from === "number" &&
        typeof f.to === "number" &&
        typeof f.original === "string" &&
        typeof f.replacement === "string" &&
        ["mishearing", "grammar", "punctuation", "term"].includes(f.reason),
    );
    out.push({ key: o.key, fixes, at: o.at });
  }
  return out.slice(-MAX_AI_CACHE);
}

export function parseMemory(v: unknown, now: number): Memory {
  try {
    if (!v || typeof v !== "object" || Array.isArray(v)) return emptyMemory();
    const o = v as Record<string, unknown>;
    if (!Array.isArray(o.entries)) return emptyMemory();
    const entries: Entry[] = [];
    for (const raw of o.entries) {
      const e = parseEntry(raw, now);
      if (typeof e !== "string") entries.push(e);
    }
    return { version: 1, entries: normalise(entries), phrases: parsePhrases(o.phrases), aiCache: parseCache(o.aiCache) };
  } catch {
    return emptyMemory();
  }
}

export function exportMemory(m: Memory): string {
  const entries = [...m.entries].sort((a, b) => a.written.localeCompare(b.written) || a.id.localeCompare(b.id));
  return JSON.stringify({ ...m, entries }, null, 2);
}

export function importMemory(m: Memory, json: string, now: number): { memory: Memory; added: number; merged: number; errors: string[] } {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { memory: m, added: 0, merged: 0, errors: [`Not JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const o = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const list = Array.isArray(parsed) ? parsed : Array.isArray(o?.entries) ? (o.entries as unknown[]) : null;
  if (!list) return { memory: m, added: 0, merged: 0, errors: ["No entries found"] };
  const entries = m.entries.map(copy);
  let added = 0;
  let merged = 0;
  list.forEach((raw, i) => {
    const e = parseEntry(raw, now);
    if (typeof e === "string") {
      errors.push(`Entry ${i + 1}: ${e}`);
      return;
    }
    const have = entries.find((x) => x.written === e.written);
    if (have) {
      mergeInto(have, e);
      merged++;
    } else {
      entries.push({ ...e, id: nextId(entries), source: e.source === "seed" ? "import" : e.source });
      added++;
    }
  });
  const phrases = !Array.isArray(parsed) && Array.isArray(o?.phrases) ? mergePhrases(m.phrases, parsePhrases(o.phrases)) : m.phrases;
  return { memory: { ...m, entries: normalise(entries), phrases }, added, merged, errors };
}

function mergePhrases(mine: Phrase[], theirs: Phrase[]): Phrase[] {
  const out = mine.map((p) => ({ ...p }));
  for (const p of theirs) {
    const have = out.find((x) => x.spoken === p.spoken);
    if (!have) out.push(p);
    else if (!have.builtin) Object.assign(have, { written: p.written, on: p.on });
  }
  return out;
}

export function prune(m: Memory, now: number): Memory {
  const cutoff = now - STALE_DAYS * DAY;
  const pair = (e: Entry) => !e.confirmed && !e.never && e.heard.length > 0;
  let entries = m.entries.filter((e) => !(pair(e) && Math.max(e.lastUsed, e.created) < cutoff));
  const unconfirmed = entries.filter(pair);
  if (unconfirmed.length > MAX_UNCONFIRMED) {
    const keep = new Set(unconfirmed.sort((a, b) => b.lastUsed - a.lastUsed).slice(0, MAX_UNCONFIRMED));
    entries = entries.filter((e) => !pair(e) || keep.has(e));
  }
  if (entries.length > MAX_ENTRIES) {
    // Least worth keeping first: never/dismissal stubs, then unconfirmed pairs, then the person's words, seeds last.
    const tier = (e: Entry) => (e.never || (!e.confirmed && e.accepts === 0 && e.heard.length > 0) ? 0 : pair(e) ? 1 : e.source === "seed" ? 3 : 2);
    const keep = new Set([...entries].sort((a, b) => tier(b) - tier(a) || b.uses - a.uses || b.lastUsed - a.lastUsed).slice(0, MAX_ENTRIES));
    entries = entries.filter((e) => keep.has(e));
  }
  const aiCache = [...m.aiCache].sort((a, b) => a.at - b.at).slice(-MAX_AI_CACHE);
  return { ...m, entries, aiCache };
}

// ---- applying ---------------------------------------------------------------------------------------------------

export interface Applied {
  from: number;
  to: number;
  original: string;
  written: string;
  entryId: string;
}

/** The whole-word, case-insensitive pattern for a heard form; its words match across any whitespace. */
export function heardPattern(heard: string): RegExp {
  const body = clean(heard).split(" ").map(escapeRe).join("\\s+");
  return new RegExp(`(?<![${W}])${body}(?![${W}])`, "giu");
}

const sentenceStart = (before: string) => /(?:^|[.!?\n])\s*$/.test(before);

export function applyMemory(m: Memory, text: string): { text: string; applied: Applied[] } {
  interface Rule {
    heard: string;
    written: string;
    id: string;
    phrase: boolean;
  }
  const rules: Rule[] = [];
  for (const e of m.entries)
    if (e.confirmed && !e.never)
      for (const h of e.heard) if ((e.muted?.[key(h)] ?? 0) < NEVER) rules.push({ heard: h, written: e.written, id: e.id, phrase: false });
  for (const p of m.phrases) if (p.on) rules.push({ heard: p.spoken, written: p.written, id: "phrase:" + p.spoken, phrase: true });
  rules.sort((a, b) => b.heard.length - a.heard.length);
  const prot = protectedSpans(text);
  const hits: (Span & { rule: Rule })[] = [];
  for (const r of rules)
    for (const x of text.matchAll(heardPattern(r.heard))) {
      let from = x.index;
      let to = from + x[0].length;
      if (overlaps({ from, to }, prot) || (!r.phrase && x[0] === r.written)) continue;
      if (r.phrase) {
        // "new line" eats the spaces (and a dictated comma/period) around it; "(" the space after; ")" the space before.
        const ws = /^\s+$/.test(r.written);
        if (ws || /^[)\]]/.test(r.written)) from -= text.slice(0, from).match(/[ \t]*$/)?.[0].length ?? 0;
        if (ws || /[([@]$/.test(r.written)) to += text.slice(to).match(ws ? /^[,.]?[ \t]*/ : /^[ \t]*/)?.[0].length ?? 0;
      }
      if (overlaps({ from, to }, hits)) continue;
      hits.push({ from, to, rule: r });
    }
  hits.sort((a, b) => a.from - b.from);
  let out = "";
  let at = 0;
  const applied: Applied[] = [];
  for (const h of hits) {
    out += text.slice(at, h.from);
    const original = text.slice(h.from, h.to);
    let written = h.rule.written;
    // Exact when the written form has a capital or a non-letter (TypeScript, Next.js, "\n"); else follow a capital
    // at a sentence start ("Local host" → "Localhost").
    if (!h.rule.phrase && !/[^\p{Ll}\s]/u.test(written) && /^\p{Lu}/u.test(original) && sentenceStart(text.slice(0, h.from)))
      written = written[0].toUpperCase() + written.slice(1);
    applied.push({ from: out.length, to: out.length + written.length, original, written, entryId: h.rule.id });
    out += written;
    at = h.to;
  }
  out += text.slice(at);
  return { text: out, applied };
}

// ---- learning ---------------------------------------------------------------------------------------------------

function update(m: Memory, written: string, fn: (e: Entry | undefined, entries: Entry[]) => Entry | undefined): Memory {
  const entries = m.entries.map(copy);
  const e = entries.find((x) => x.written === written);
  const made = fn(e, entries);
  if (made && !e) entries.push(made);
  return { ...m, entries };
}

export function recordAccept(m: Memory, heard: string, written: string, source: Source, now: number): Memory {
  const h = clean(heard);
  const w = clean(written);
  if (!h || !w || h === w) return m;
  const k = key(h);
  return update(m, w, (e, entries) => {
    if (!e) {
      const n = newEntry(entries, w, [h], source, now);
      n.accepts = 1;
      n.confirmed = n.accepts >= CONFIRM_AT;
      if (n.confirmed) claim(entries, n, h);
      return n;
    }
    e.muted = drop(e.muted, k);
    e.accepts++;
    e.lastUsed = now;
    if (e.confirmed && !hasHeard(e, h)) {
      e.pending = bump(e.pending, k);
      if (e.pending[k] >= CONFIRM_AT) {
        e.pending = drop(e.pending, k);
        e.heard.push(h);
        claim(entries, e, h);
      }
      return undefined;
    }
    if (!hasHeard(e, h)) e.heard.push(h);
    if (!e.confirmed && e.accepts >= CONFIRM_AT) {
      e.confirmed = true;
      e.never = false;
      for (const x of e.heard) claim(entries, e, x);
    }
    return undefined;
  });
}

export function recordAlways(m: Memory, heard: string, written: string, source: Source, now: number): Memory {
  const h = clean(heard);
  const w = clean(written);
  if (!h || !w || h === w) return m;
  const k = key(h);
  return update(m, w, (e, entries) => {
    const t = e ?? newEntry(entries, w, [], source, now);
    if (!hasHeard(t, h)) t.heard.push(h);
    t.pending = drop(t.pending, k);
    t.muted = drop(t.muted, k);
    t.confirmed = true;
    t.never = false;
    t.accepts++;
    t.lastUsed = now;
    claim(entries, t, h);
    return e ? undefined : t;
  });
}

export function recordDismiss(m: Memory, heard: string, written: string, now: number): Memory {
  const h = clean(heard);
  const w = clean(written);
  if (!h || !w) return m;
  return update(m, w, (e, entries) => {
    // No entry yet (an AI or spelling suggestion): a stub remembers the dismissal so a second one suppresses it.
    const t = e ?? newEntry(entries, w, [h], "you", now);
    t.dismissals++;
    t.muted = bump(t.muted, key(h));
    return e ? undefined : t;
  });
}

export function recordNever(m: Memory, heard: string, written: string, now: number): Memory {
  const h = clean(heard);
  const w = clean(written);
  if (!h || !w) return m;
  const k = key(h);
  return update(m, w, (e, entries) => {
    if (!e) {
      const n = newEntry(entries, w, [h], "you", now);
      n.never = true;
      return n;
    }
    if (e.source !== "seed" && e.heard.length > 0 && e.heard.every((x) => key(x) === k)) {
      // The entry is just this pair: retire it.
      e.never = true;
      e.confirmed = false;
    } else {
      // A word with other forms (or a library word): mute only this form.
      e.heard = e.heard.filter((x) => key(x) !== k);
      e.pending = drop(e.pending, k);
      e.muted = { ...e.muted, [k]: NEVER };
    }
    return undefined;
  });
}

export function recordUse(m: Memory, ids: string[], now: number): Memory {
  const set = new Set(ids);
  if (!m.entries.some((e) => set.has(e.id))) return m;
  return { ...m, entries: m.entries.map((e) => (set.has(e.id) ? { ...e, uses: e.uses + 1, lastUsed: now } : e)) };
}

export function suppressed(m: Memory, heard: string, written: string): boolean {
  const e = m.entries.find((x) => x.written === clean(written));
  if (!e) return false;
  return e.never || (e.muted?.[key(heard)] ?? 0) >= SUPPRESS_AT;
}

export function offered(m: Memory): Entry[] {
  return m.entries.filter((e) => !e.never && ((!e.confirmed && e.accepts >= 1 && e.heard.length > 0) || Object.keys(e.pending ?? {}).length > 0));
}

/** The heard → written pairs behind offered(): what the checker underlines as "You fixed this before". */
export function offeredPairs(m: Memory): { heard: string; written: string; entryId: string }[] {
  const out: { heard: string; written: string; entryId: string }[] = [];
  for (const e of offered(m)) {
    const forms = e.confirmed ? Object.keys(e.pending ?? {}) : e.heard;
    for (const h of forms) if (!suppressed(m, h, e.written)) out.push({ heard: h, written: e.written, entryId: e.id });
  }
  return out;
}

/** Adds a word to the library (or more heard forms to it). Words the person adds are confirmed. */
export function addWord(m: Memory, written: string, heard: string[], source: Source, now: number): Memory {
  const w = clean(written);
  if (!w) return m;
  let out = update(m, w, (e, entries) => (e ? undefined : { ...newEntry(entries, w, [], source, now), confirmed: true }));
  for (const h of heard) out = recordAlways(out, h, w, source, now);
  return out;
}

export function removeEntry(m: Memory, id: string): Memory {
  return { ...m, entries: m.entries.filter((e) => e.id !== id) };
}

export function initialPrompt(m: Memory, maxChars = 600): string {
  const words = m.entries
    .filter(isLibrary)
    .sort((a, b) => Number(a.source === "seed") - Number(b.source === "seed") || b.uses - a.uses || b.lastUsed - a.lastUsed);
  const seen = new Set<string>();
  const list: string[] = [];
  let len = "Glossary: .".length;
  for (const e of words) {
    const k = e.written.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const add = (list.length ? 2 : 0) + e.written.length;
    if (len + add > maxChars) break; // cut between words, never inside one
    list.push(e.written);
    len += add;
  }
  return list.length ? `Glossary: ${list.join(", ")}.` : "";
}
