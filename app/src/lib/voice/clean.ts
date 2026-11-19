// The clean-up of a raw dictation, ported from 2relay's PromptCleaner (normalizeWhitespace, removeFillers,
// removeStutters, removeRepeatedPhrases), plus Whisper's artefacts. 2relay's "- " bullet and Goal/Context template are
// left out: the text goes into a chat composer. Pure: unit-tested in clean.test.ts.

import { protectedSpans, W } from "./text.ts";

export interface CleanOptions {
  fillers: boolean;
  stutters: boolean;
  repeats: boolean;
}

export function normalizeWhitespace(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

const B0 = `(?<![${W}])`;
const B1 = `(?![${W}])`;
// 2relay's list: um+, uh+, er+, ah+, hmm+, "you know", "i mean".
const FILLER = new RegExp(`${B0}(?:um+|uh+|er+|ah+|hmm+|you know|i mean)${B1}`, "giu");

export function removeFillers(t: string): string {
  let s = normalizeWhitespace(t.replace(FILLER, " "));
  // Tidy the punctuation a removed filler leaves behind: "so , , add" → "so, add", a leading ", " and "x, ." → "x.".
  s = s.replace(/\s+([,.;:!?])/g, "$1");
  s = s.replace(/([,;:])(?:\s*[,;:])+/g, "$1");
  s = s.replace(/[,;:]+(?=[.!?])/g, "");
  s = s.replace(/^[\s,;:.!?]+/, "");
  s = s.replace(/,\s*$/, "");
  return s;
}

/** 2relay's normalizedToken: punctuation trimmed from both ends, lowercased. */
const norm = (tok: string) => tok.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "").toLowerCase();
const trailPunct = (tok: string) => tok.match(/[\p{P}\p{S}]*$/u)?.[0] ?? "";

export function removeStutters(t: string): string {
  // "b-b-but" → "but" (a repeated prefix before the word), then 2relay's "the-the" → "the".
  const s = t
    .replace(/(?<![\p{L}\p{N}_])([a-z]{1,3})(?:-\1)+-(?=\1[a-z])/giu, "")
    .replace(/(?<![\p{L}\p{N}_])([a-z]{1,3})(?:-\1)+(?![\p{L}\p{N}_])/giu, "$1");
  const tokens = s.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const tok of tokens) {
    const last = out[out.length - 1];
    if (last !== undefined && norm(tok) !== "" && norm(last) === norm(tok)) {
      // A consecutive duplicate: keep the first one's spelling with the restart's punctuation, so "the, the upload"
      // reads "the upload" (2relay kept "the,").
      out[out.length - 1] = last.slice(0, last.length - trailPunct(last).length) + trailPunct(tok);
      continue;
    }
    out.push(tok);
  }
  return normalizeWhitespace(out.join(" "));
}

export function removeRepeatedPhrases(t: string): string {
  const tokens = t.split(/\s+/).filter(Boolean);
  if (tokens.length <= 3) return t;
  const result: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let collapsed = false;
    const maxWindow = Math.min(4, Math.floor((tokens.length - i) / 2));
    for (let w = maxWindow; w >= 2; w--) {
      let same = true;
      for (let k = 0; k < w && same; k++) same = norm(tokens[i + k]) === norm(tokens[i + w + k]);
      if (same) {
        result.push(...tokens.slice(i, i + w));
        i += w * 2;
        collapsed = true;
        break;
      }
    }
    if (collapsed) continue;
    result.push(tokens[i]);
    i++;
  }
  return removeStutters(result.join(" "));
}

const ARTEFACT_WORDS = "music|silence|applause|laughs?|laughing|laughter|sighs?|coughs?|coughing|noise|inaudible|static|clears throat|breathing|typing|background noise";
const ARTEFACTS = [
  /\[[A-Z][A-Z_ ]*\]/g, // [BLANK_AUDIO], [MUSIC]
  new RegExp(`\\[(?:${ARTEFACT_WORDS})\\]`, "gi"), // [Silence]
  new RegExp(`\\((?:${ARTEFACT_WORDS})\\)`, "gi"),
  new RegExp(`\\*(?:${ARTEFACT_WORDS})\\*`, "gi"),
  /[♪♫♬]+/g,
];
// What Whisper says over silence. Only dropped when it is the whole transcript.
const HALLUCINATIONS = [
  /^(?:thank you|thanks)(?: (?:so|very) much)?$/,
  /^(?:thanks|thank you) for (?:watching|listening)$/,
  /^(?:please )?(?:like and )?subscribe(?: to (?:my|the|our) channel)?$/,
  /^(?:subtitles|captions|transcription|transcribed|subtitled)(?: by| created by)? .*$/,
  /^you$/,
  /^bye$/,
];

export function stripArtefacts(t: string): string {
  let s = t;
  for (const re of ARTEFACTS) s = s.replace(re, " ");
  s = normalizeWhitespace(s);
  const bare = s.toLowerCase().replace(/[.!?,…\s]+$/u, "").replace(/^[.!?,…\s]+/u, "");
  if (bare === "" || HALLUCINATIONS.some((re) => re.test(bare))) return "";
  return s;
}

// Protected spans become one-character-wide private-use placeholders while the gaps are cleaned, so nothing inside
// code, paths or quotes can change and a span never merges with its neighbours.
const OPEN = "";
const CLOSE = "";
const holder = (i: number) => OPEN + String.fromCharCode(0xe100 + i) + CLOSE;

export function cleanTranscript(t: string, on = true, o: Partial<CleanOptions> = {}): string {
  const base = stripArtefacts(t);
  if (!on) return normalizeWhitespace(base);
  const opt: CleanOptions = { fillers: true, stutters: true, repeats: true, ...o };
  const spans = protectedSpans(base).slice(0, 0x1e00);
  const kept: string[] = [];
  let s = "";
  let at = 0;
  for (const sp of spans) {
    s += base.slice(at, sp.from) + holder(kept.length);
    kept.push(base.slice(sp.from, sp.to));
    at = sp.to;
  }
  s += base.slice(at);
  if (opt.fillers) s = removeFillers(s);
  if (opt.stutters) s = removeStutters(s);
  if (opt.repeats) s = removeRepeatedPhrases(s);
  s = normalizeWhitespace(s);
  s = s.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  if (/[\p{L}\p{N}]$/u.test(s) && s.split(" ").filter((w) => /[\p{L}\p{N}\uE000]/u.test(w)).length >= 4) s += ".";
  return s.replace(new RegExp(`${OPEN}([\\s\\S])${CLOSE}`, "g"), (_, c: string) => kept[c.charCodeAt(0) - 0xe100] ?? "");
}
