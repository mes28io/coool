// Voice text basics: word tokens with offsets, and the spans no fixer may touch (code, paths, URLs, flags,
// identifiers, slash commands, @mentions, quoted text). Pure: unit-tested in text.test.ts.
// Offsets are JS string indices (UTF-16), so they map straight onto a textarea's selectionStart/End.

export interface Span {
  from: number;
  to: number;
}

/** Ranges overlap when they share at least one character. */
export function overlaps(a: Span, list: Span[]): boolean {
  for (const s of list) if (a.from < s.to && s.from < a.to) return true;
  return false;
}

/** A word: letters/digits, with ' or - allowed inside ("don't", "re-run"). */
export interface Token {
  text: string;
  lower: string;
  from: number;
  to: number;
}

const WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*[\p{L}\p{M}\p{N}]|[\p{L}\p{N}]/gu;

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(WORD)) {
    const from = m.index ?? 0;
    out.push({ text: m[0], lower: m[0].toLowerCase(), from, to: from + m[0].length });
  }
  return out;
}

/** Characters that make up a word, for whole-word boundaries (JS \b is ASCII-only). */
export const W = "\\p{L}\\p{M}\\p{N}_";
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** FNV-1a 32-bit, as 8 hex chars: stable ids and cache keys. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// A stutter like "b-b-but" or "the-the" is speech, not a kebab-case name.
const STUTTER = /^([\p{L}]{1,3})(?:-\1)+(?:-|$)/iu;

/** Whether a token (surrounding brackets/quotes/sentence punctuation already trimmed) is code-like. */
function codeLike(core: string, raw: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(core) || /^www\./i.test(core)) return true; // URL
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(core)) return true; // email
  if (core.startsWith("@") && core.length > 1) return true; // @mention
  if (/^(?:~\/|\.\.?\/|\/)./.test(core)) return true; // ~/x ./x ../x /x and slash commands
  if (/[\p{L}\p{N}_.~-]\/[\p{L}\p{N}_.-]/u.test(core)) return true; // src/lib/x
  if (/^--?[A-Za-z][\w-]*(?:=\S*)?$/.test(core)) return true; // -x --long-flag --flag=value
  if (/\p{Ll}\p{Lu}/u.test(core)) return true; // camelCase, PascalCase with an inner capital, macOS
  if (/[\p{L}\p{N}]_|_[\p{L}\p{N}]/u.test(core)) return true; // snake_case, SCREAMING_CASE
  if (/[\p{L}\p{N}_]\.[\p{L}\p{N}_]/u.test(core)) return true; // name.ext, Next.js, a.b (covers any file extension)
  if (/::|[()[\]{}=<>]/.test(core) || /\w[([]/.test(raw)) return true; // a::b, f(x), a[0], x=1, foo()
  if (!STUTTER.test(core)) {
    if (/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+){2,}$/u.test(core)) return true; // kebab-case-name
    if (/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+$/u.test(core) && /\d/.test(core)) return true; // gpt-4, utf-8
  }
  return false;
}

function mask(text: string, spans: Span[]): string {
  let out = text;
  for (const s of spans) out = out.slice(0, s.from) + " ".repeat(s.to - s.from) + out.slice(s.to);
  return out;
}

function merge(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => s.to > s.from).sort((a, b) => a.from - b.from || a.to - b.to);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ from: s.from, to: s.to });
  }
  return out;
}

export function protectedSpans(text: string): Span[] {
  const spans: Span[] = [];
  // Fences first (an unterminated one runs to the end), then inline code, each masked so its backticks can't pair
  // with others later on.
  const fences: Span[] = [];
  for (const m of text.matchAll(/```[\s\S]*?(?:```|$)/g)) fences.push({ from: m.index, to: m.index + m[0].length });
  let rest = mask(text, fences);
  const inline: Span[] = [];
  for (const m of rest.matchAll(/`[^`\n]+`/g)) inline.push({ from: m.index, to: m.index + m[0].length });
  rest = mask(rest, inline);
  const quoted: Span[] = [];
  for (const m of rest.matchAll(/"[^"\n]+"|“[^”\n]*”/g)) quoted.push({ from: m.index, to: m.index + m[0].length });
  spans.push(...fences, ...inline, ...quoted);
  rest = mask(rest, quoted);
  for (const m of rest.matchAll(/\S+/g)) {
    const raw = m[0];
    const lead = raw.match(/^[([{"'“‘`]+/)?.[0].length ?? 0;
    // Closing brackets stay with a token that opened one: f(x), arr[0].
    const body = raw.slice(lead);
    const trail = body.match(/[([{]/.test(body) ? /[.,;:!?"'”’`]+$/ : /[.,;:!?)\]}"'”’`]+$/)?.[0].length ?? 0;
    const core = raw.slice(lead, raw.length - trail);
    if (!core) continue;
    if (codeLike(core, raw)) spans.push({ from: m.index + lead, to: m.index + raw.length - trail });
  }
  return merge(spans);
}
