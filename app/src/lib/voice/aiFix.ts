// The optional AI fixer's output, checked before it can become a suggestion: span-level fixes only, never inside
// code/paths/URLs/quotes, never a rewrite. Plus a small cache for identical utterances. Pure: aiFix.test.ts.

import { hash, overlaps, protectedSpans } from "./text.ts";
import { MAX_AI_CACHE, type Memory } from "./memory.ts";

export type AiReason = "mishearing" | "grammar" | "punctuation" | "term";
export interface AiFix {
  from: number;
  to: number;
  original: string;
  replacement: string;
  reason: AiReason;
}

const REASONS: ReadonlySet<string> = new Set(["mishearing", "grammar", "punctuation", "term"]);
const MAX_FIXES = 12;
const MAX_WORDS = 6;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

function occurrences(text: string, s: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(s); i >= 0 && out.length < 2; i = text.indexOf(s, i + 1)) out.push(i);
  return out;
}

export function validateAiFixes(text: string, raw: unknown): AiFix[] {
  try {
    if (typeof text !== "string" || !raw || typeof raw !== "object") return [];
    const list = (raw as { fixes?: unknown }).fixes;
    if (!Array.isArray(list)) return [];
    const prot = protectedSpans(text);
    const ok: AiFix[] = [];
    for (const f of list.slice(0, 100)) {
      if (!f || typeof f !== "object") continue;
      const { from, to, original, replacement, reason } = f as Record<string, unknown>;
      if (typeof original !== "string" || typeof replacement !== "string" || typeof reason !== "string") continue;
      if (!REASONS.has(reason) || original === "" || original === replacement) continue;
      if (words(original) > MAX_WORDS || words(replacement) > MAX_WORDS) continue;
      if (replacement.length > original.length * 2 + 12) continue;
      let start = typeof from === "number" && Number.isInteger(from) ? from : -1;
      const end = typeof to === "number" && Number.isInteger(to) ? to : -1;
      if (start < 0 || end !== start + original.length || text.slice(start, end) !== original) {
        // Models miscount offsets: trust the text when it occurs exactly once.
        const at = occurrences(text, original);
        if (at.length !== 1) continue;
        start = at[0];
      }
      const fix: AiFix = { from: start, to: start + original.length, original, replacement, reason: reason as AiReason };
      if (overlaps(fix, prot)) continue;
      ok.push(fix);
    }
    ok.sort((a, b) => a.from - b.from);
    const out: AiFix[] = [];
    for (const f of ok) {
      const last = out[out.length - 1];
      if (last && f.from < last.to) continue; // overlapping: keep the earlier
      out.push(f);
      if (out.length >= MAX_FIXES) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function aiCacheKey(text: string, mode: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return `${mode}:${hash(t)}:${t.length}`;
}

export function cachedFixes(m: Memory, key: string): AiFix[] | null {
  const hit = m.aiCache.find((c) => c.key === key);
  return hit ? hit.fixes.map((f) => ({ ...f })) : null;
}

export function cacheFixes(m: Memory, key: string, fixes: AiFix[], now: number): Memory {
  const rest = m.aiCache.filter((c) => c.key !== key);
  rest.push({ key, fixes: fixes.map((f) => ({ ...f })), at: now });
  rest.sort((a, b) => a.at - b.at);
  return { ...m, aiCache: rest.slice(Math.max(0, rest.length - MAX_AI_CACHE)) };
}
