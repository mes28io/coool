// The local checker: underlined suggestions from memory ("you fixed this before"), words-library near misses, macOS
// spelling/grammar hits, AI fixes and (typed text only) small clean-ups. Never inside code/paths/quotes, never
// overlapping, never for a suppressed pair. Pure: unit-tested in suggest.test.ts.
//
// Near misses use Damerau-Levenshtein (optimal string alignment) distance and, as a second chance, a phonetic key:
// "metaphone-lite" (see phoneticKey) — a consonant skeleton with every vowel run as one "a" slot, so "tori", "tory"
// and "Tauri" share "tara" but "tour" ("tar") and "tree" ("tra") don't.

import type { AiFix, AiReason } from "./aiFix.ts";
import { heardPattern, isLibrary, offeredPairs, suppressed, type Memory } from "./memory.ts";
import { hash, overlaps, protectedSpans, tokenize, W, type Span, type Token } from "./text.ts";

export type Kind = "memory" | "term" | "spelling" | "grammar" | "cleanup" | "ai";
export interface Suggestion {
  id: string;
  from: number;
  to: number;
  original: string;
  replacement: string;
  kind: Kind;
  reason: string;
  entryId?: string;
}
export interface SpellHit {
  from: number;
  to: number;
  word: string;
  guesses: string[];
  grammar?: string | null;
}
export interface CheckInput {
  text: string;
  memory: Memory;
  dictated: boolean;
  spell?: SpellHit[];
  ai?: AiFix[];
}

// Common English (and everyday developer) words: never flagged as a near miss of a library word.
const COMMON: ReadonlySet<string> = new Set(
  (
    "a about above after again against all also always am an and another any are around as ask at away back bad be because been " +
    "before being below best better between big both bring but by call came can cannot case change check clean clear close code codes " +
    "coded coding come could cloud data day did different do does doing done down each early either else end enough even ever every " +
    "fact far feel few file files find first fix for found free from full get give go going good got great had has have having he " +
    "help her here high him his hold home how however i if important in into is it its just keep kind know large last later left " +
    "less let life like line lines list little live local long look lot made make many may me mean might more most move much must " +
    "my name need never new next no not now number of off often old on once one only open or order other our out over own part " +
    "people place point put rather read real really right run same say see seem set she should show side since small so some " +
    "something start state still stop store such sure take tell than that the their them then there these they thing things think " +
    "this those though three through time to today together too top tour tree true try turn two type under until up upon us use " +
    "used user users using very want was way we well were what when where which while who whole why will with within without word " +
    "words work world would write wrong year yes yet you your " +
    "add added adding app apps build built bug bugs class config component components create created delete error errors event events " +
    "feature field fields folder function functions import input key layout load log merge method model module output page pages " +
    "path plan please port print project query react reload remove render request response return route save script search server " +
    "service session settings setup source stack status story string style table task test tests text theme token update upload " +
    "value values version view window branch commit push pull release deploy cache client cloudy coder codec cool rust node nodes " +
    "core course store stored stores stories states stated stare star stars storm story tory tours tower towers torn tore claw claws " +
    "clawed called cold could colder java jason local host hosts back off stand zoo stands next js mac os"
  ).split(" "),
);

/** Optimal-string-alignment Damerau-Levenshtein distance, giving up past `max`. */
export function distance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = Array.from({ length: b.length + 1 }, () => 0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur: number[] = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** "metaphone-lite": English spelling folded to how it sounds, vowels as one slot. */
export function phoneticKey(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return "";
  w = w.replace(/^(?:kn|gn|pn|wr)/, (m) => m[1]).replace(/^x/, "s").replace(/^wh/, "w");
  if (w.length > 3) w = w.replace(/e$/, ""); // silent final e
  w = w
    .replace(/x/g, "ks")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/sch/g, "sk")
    .replace(/[sc]h/g, "X")
    .replace(/th/g, "0")
    .replace(/dg/g, "j")
    .replace(/gh/g, "")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/[cq]/g, "k")
    .replace(/z/g, "s")
    .replace(/v/g, "f")
    .replace(/d/g, "t")
    .replace(/b/g, "p")
    .replace(/w(?![aeiouy])/g, "")
    .replace(/h(?![aeiouy])/g, "")
    .replace(/y(?![aeiou])/g, "a")
    .replace(/[aeiou]+/g, "a");
  return w.replace(/(.)\1+/g, "$1");
}

const PRIORITY: Record<Kind, number> = { memory: 0, term: 1, ai: 2, spelling: 3, grammar: 4, cleanup: 5 };
const AI_REASON: Record<AiReason, string> = { mishearing: "Probably misheard", grammar: "Grammar", punctuation: "Punctuation", term: "Term" };
const FILLER_START = new RegExp(`(?<=^\\s*|[.!?]\\s+|\\n\\s*)(?:um+|uh+|er+|ah+|hmm+)(?![${W}])[,.]?\\s+(\\p{L})`, "giu");
const OK_TWICE: ReadonlySet<string> = new Set(["had", "that"]);

interface Target {
  written: string;
  form: string; // lowercase form compared against
  heard: boolean;
  entryId: string;
}

/** Library words and their heard forms, by word count. */
function targets(m: Memory): { byWords: Map<number, Target[]>; known: Set<string> } {
  const byWords = new Map<number, Target[]>();
  const known = new Set<string>();
  const put = (t: Target) => {
    const n = t.form.split(" ").length;
    if (n > 3) return;
    const list = byWords.get(n) ?? [];
    list.push(t);
    byWords.set(n, list);
  };
  for (const e of m.entries) {
    if (!isLibrary(e)) continue;
    known.add(e.written.toLowerCase());
    put({ written: e.written, form: e.written.toLowerCase(), heard: false, entryId: e.id });
    for (const h of e.heard) put({ written: e.written, form: h.toLowerCase().replace(/\s+/g, " "), heard: true, entryId: e.id });
  }
  return { byWords, known };
}

/** The best library match for a window of tokens, or null. */
function nearMiss(win: Token[], list: Target[], known: Set<string>): Target | null {
  const phrase = win.map((t) => t.lower).join(" ");
  if (known.has(phrase) || /^\d/.test(phrase)) return null;
  let best: Target | null = null;
  let bestD = Infinity;
  for (const t of list) if (t.heard && t.form === phrase) return t; // a known mishearing, even of a common word
  const fuzzy = win.length === 1 ? phrase.length >= 4 && !COMMON.has(phrase) : phrase.length >= 6 && win.some((t) => !COMMON.has(t.lower));
  if (!fuzzy) return null;
  const max = Math.max(1, Math.floor(phrase.length / 4));
  const key = win.length === 1 ? phoneticKey(phrase) : "";
  for (const t of list) {
    const d = distance(phrase, t.form, Math.max(max, Math.ceil(phrase.length / 2)));
    const ok = d <= max || (key.length >= 3 && d <= Math.ceil(phrase.length / 2) && phoneticKey(t.form) === key);
    if (ok && d < bestD) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

export function check(input: CheckInput): Suggestion[] {
  const { text, memory, dictated } = input;
  const prot = protectedSpans(text);
  const cands: Suggestion[] = [];
  const add = (from: number, to: number, replacement: string, kind: Kind, reason: string, entryId?: string) => {
    const original = text.slice(from, to);
    if (to <= from || original === replacement || overlaps({ from, to }, prot)) return;
    if (suppressed(memory, original, replacement)) return;
    const s: Suggestion = { id: `${kind}:${from}:${hash(original + "\u0000" + replacement)}`, from, to, original, replacement, kind, reason };
    if (entryId) s.entryId = entryId;
    cands.push(s);
  };

  for (const p of offeredPairs(memory))
    for (const x of text.matchAll(heardPattern(p.heard))) add(x.index, x.index + x[0].length, p.written, "memory", "You fixed this before", p.entryId);

  const tokens = tokenize(text);
  // A near variant of a one-word fix made before (whisper hears "Zustin" once and "Zustan" the next time).
  for (const p of offeredPairs(memory)) {
    const h = p.heard.toLowerCase();
    if (h.includes(" ") || h.length < 4) continue;
    const max = Math.max(1, Math.floor(h.length / 4));
    for (const t of tokens)
      if (t.lower !== h && t.lower[0] === h[0] && t.lower !== p.written.toLowerCase() && !COMMON.has(t.lower) && distance(t.lower, h, max) <= max)
        add(t.from, t.to, p.written, "memory", "Close to a fix you made before", p.entryId);
  }
  const { byWords, known } = targets(memory);
  for (const [n, list] of byWords)
    for (let i = 0; i + n <= tokens.length; i++) {
      const win = tokens.slice(i, i + n);
      if (win.some((t, k) => k > 0 && !/^\s+$/.test(text.slice(win[k - 1].to, t.from)))) continue;
      const hit = nearMiss(win, list, known);
      if (hit) add(win[0].from, win[n - 1].to, hit.written, "term", `Sounds like a word you use: ${hit.written}`, hit.entryId);
    }

  for (const f of input.ai ?? [])
    if (text.slice(f.from, f.to) === f.original) add(f.from, f.to, f.replacement, "ai", AI_REASON[f.reason] ?? "Suggested fix");

  const library = new Set(known);
  for (const e of memory.entries) if (isLibrary(e)) for (const h of e.heard) library.add(h.toLowerCase());
  for (const h of input.spell ?? []) {
    if (text.slice(h.from, h.to) !== h.word || !h.guesses.length || library.has(h.word.toLowerCase())) continue;
    if (h.grammar) add(h.from, h.to, h.guesses[0], "grammar", h.grammar);
    else add(h.from, h.to, h.guesses[0], "spelling", "Spelling");
  }

  if (!dictated) {
    for (let i = 1; i < tokens.length; i++) {
      const a = tokens[i - 1];
      const b = tokens[i];
      if (a.lower === b.lower && !OK_TWICE.has(b.lower) && /^[ \t]+$/.test(text.slice(a.to, b.from))) add(a.to, b.to, "", "cleanup", "Repeated word");
    }
    for (const x of text.matchAll(FILLER_START)) add(x.index, x.index + x[0].length, x[1].toUpperCase(), "cleanup", "Filler word");
    for (const x of text.matchAll(/(?<=\S) {2,}(?=\S)/g)) add(x.index, x.index + x[0].length, " ", "cleanup", "Double space");
  }

  cands.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.from - b.from || b.to - a.to);
  const out: Suggestion[] = [];
  for (const s of cands) if (!overlaps(s, out)) out.push(s);
  return out.sort((a, b) => a.from - b.from);
}

export function applySuggestion(text: string, s: Suggestion): { text: string; caret: number } {
  return { text: text.slice(0, s.from) + s.replacement + text.slice(s.to), caret: s.from + s.replacement.length };
}

export function applyAll(text: string, list: Suggestion[]): string {
  let out = text;
  let limit = Infinity;
  for (const s of [...list].sort((a, b) => b.from - a.from)) {
    if (s.to > limit) continue; // overlaps one already applied
    out = out.slice(0, s.from) + s.replacement + out.slice(s.to);
    limit = s.from;
  }
  return out;
}

/** True when the AI step is worth running. The opposite of "memory and the local checker already cover it": some
 *  word is unknown (not common, not in the library, not flagged by spelling), or a local suggestion is still open. */
export function aiNeeded(text: string, memory: Memory, spell: SpellHit[], local: Suggestion[]): boolean {
  if (local.length) return true;
  const prot = protectedSpans(text);
  const flagged: Span[] = spell.map((h) => ({ from: h.from, to: h.to }));
  const lib = new Set<string>();
  for (const e of memory.entries)
    if (isLibrary(e)) for (const f of [e.written, ...e.heard]) for (const w of f.toLowerCase().split(/\s+/)) lib.add(w);
  for (const t of tokenize(text)) {
    if (/^\d/.test(t.lower) || COMMON.has(t.lower) || lib.has(t.lower)) continue;
    if (overlaps(t, prot) || overlaps(t, flagged)) continue;
    return true;
  }
  return false;
}
