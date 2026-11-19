// Learning from the person's own edits of dictated text: a word-level diff of the text as dictated vs as sent, kept
// only for small fixes inside the dictation (a mishearing fixed by hand), never for rewrites. Pure: learn.test.ts.

import { overlaps, protectedSpans, tokenize, type Span, type Token } from "./text.ts";

export interface Pair {
  heard: string;
  written: string;
}

interface Hunk {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
}

const MAX_SIDE = 3;
const MAX_HUNKS = 3;
const REWRITE = 0.4;

/** Token hunks between a and b (LCS on exact text, so case changes count). Common ends are trimmed first. */
function hunks(a: Token[], b: Token[]): Hunk[] {
  let p = 0;
  while (p < a.length && p < b.length && a[p].text === b[p].text) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s].text === b[b.length - 1 - s].text) s++;
  const n = a.length - p - s;
  const m = b.length - p - s;
  if (n * m > 4_000_000) return [{ i0: p, i1: p + n, j0: p, j1: p + m }];
  // dp[i][j] = LCS length of a[p+i..] and b[p+j..]
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[p + i].text === b[p + j].text ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: Hunk | null = null;
  const close = () => {
    if (open) out.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[p + i].text === b[p + j].text) {
      close();
      i++;
      j++;
      continue;
    }
    open ??= { i0: p + i, i1: p + i, j0: p + j, j1: p + j };
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) open.j1 = p + ++j;
    else open.i1 = p + ++i;
  }
  close();
  return out;
}

const inside = (t: Token, s: Span) => t.from >= s.from && t.to <= s.to;
const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");
const atSentenceStart = (text: string, at: number) => /(?:^|[.!?\n])\s*["'“(]?$/.test(text.slice(0, at));
const numeric = (s: string) => /\d/.test(s);

export function learnFromEdit(before: string, inserted: { from: number; to: number }, sent: string): Pair[] {
  const bt = tokenize(before);
  const st = tokenize(sent);
  const ins = bt.filter((t) => inside(t, inserted));
  if (!ins.length) return [];
  const all = hunks(bt, st);
  // Hunks inside the dictation: the old side within it, or (pure insertions) both neighbours within it.
  const mine = all.filter((h) =>
    h.i1 > h.i0 ? bt.slice(h.i0, h.i1).every((t) => inside(t, inserted)) : h.i0 > 0 && h.i0 < bt.length && inside(bt[h.i0 - 1], inserted) && inside(bt[h.i0], inserted),
  );
  if (!mine.length || mine.length > MAX_HUNKS) return [];
  const changed = mine.reduce((n, h) => n + Math.max(h.i1 - h.i0, h.j1 - h.j0), 0);
  // A rewrite, not a fix. (At least one word may always change, so a one- or two-word dictation can still teach.)
  if (changed > Math.max(1, ins.length * REWRITE)) return [];
  const protBefore = protectedSpans(before);
  const protSent = protectedSpans(sent);
  const out: Pair[] = [];
  for (const h of mine) {
    const oldN = h.i1 - h.i0;
    const newN = h.j1 - h.j0;
    if (oldN < 1 || newN < 1 || oldN > MAX_SIDE || newN > MAX_SIDE) continue;
    const oldSpan = { from: bt[h.i0].from, to: bt[h.i1 - 1].to };
    const newSpan = { from: st[h.j0].from, to: st[h.j1 - 1].to };
    const heard = before.slice(oldSpan.from, oldSpan.to).replace(/\s+/g, " ");
    const written = sent.slice(newSpan.from, newSpan.to).replace(/\s+/g, " ");
    if (overlaps(oldSpan, protBefore)) continue;
    // A plain word whose own shape reads as an identifier ("GitHub", "macOS") is a fine target; anything else
    // protected around the new side (code, a path, a quote) is not.
    const own = (p: Span) => p.from === newSpan.from && p.to === newSpan.to && /^[\p{L}\s]+$/u.test(written);
    if (overlaps(newSpan, protSent.filter((p) => !own(p)))) continue;
    if (heard === written || letters(heard) === letters(written)) continue; // punctuation only
    if (heard.toLowerCase() === written.toLowerCase() && atSentenceStart(sent, newSpan.from)) continue; // "the" → "The"
    if (numeric(heard) || numeric(written)) {
      // "3" → "4" changes the meaning; it isn't a mishearing.
      if (letters(heard).replace(/\D/g, "") !== letters(written).replace(/\D/g, "")) continue;
    }
    if (!out.some((p) => p.heard === heard && p.written === written)) out.push({ heard, written });
  }
  return out;
}

export function singleWordFix(pairs: Pair[]): Pair | null {
  if (pairs.length !== 1) return null;
  const p = pairs[0];
  return /\s/.test(p.heard) || /\s/.test(p.written) ? null : p;
}
