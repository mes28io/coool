// Model names, families and context windows.
// The context window comes from the CLI when it reports one (`ready` / `usage`
// `context_window`); otherwise a per-family table; otherwise an explicit
// "assumed" fallback that the UI must never present as a hard limit.

import type { ModelUse, Session, Tokens } from "./types";

export type WindowSource = "reported" | "family" | "assumed";
export interface ContextWindow {
  tokens: number;
  source: WindowSource;
}

const M = 1_000_000;
const K = 1_000;

/** Ordered: first match wins. Only used when the CLI did not report a window. */
const FAMILY: [RegExp, number][] = [
  [/\[1m\]|-1m\b/i, M],
  [/claude-(fable|mythos)/i, M],
  [/claude-(opus|sonnet)-[5-9]/i, M],
  [/claude-haiku-[5-9]/i, M],
  [/claude-(opus|sonnet)-4-[6-9]/i, M],
  [/claude-(opus|sonnet|haiku)-4|claude-[a-z]+-3|claude-3/i, 200 * K],
  [/^(opus|sonnet|haiku)$/i, 200 * K],
  [/gpt-5|codex/i, 272 * K],
  [/\bo[34]\b|o[34]-/i, 200 * K],
  [/gpt-4\.1/i, M],
];

export const ASSUMED_WINDOW = 200 * K;

export function contextWindow(model: string | null | undefined, reported?: number | null): ContextWindow {
  if (reported && reported > 0) return { tokens: reported, source: "reported" };
  if (model) for (const [re, n] of FAMILY) if (re.test(model)) return { tokens: n, source: "family" };
  return { tokens: ASSUMED_WINDOW, source: "assumed" };
}

/** "claude-opus-5-5" -> "Opus 5.5"; "claude-sonnet-4-5-20250929" -> "Sonnet 4.5"; others pass through. */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return "unknown";
  const one = /\[1m\]/i.test(id) ? " 1M" : "";
  const m = /claude-(?:3-(?:5|7)-)?([a-z]+)-?(\d{1,2}(?!\d))?(?:-(\d{1,2})(?!\d))?(?:-\d{8})?/i.exec(id.replace(/\[1m\]/i, ""));
  if (m && m[1]) {
    const fam = m[1][0].toUpperCase() + m[1].slice(1);
    const ver = m[2] ? (m[3] ? `${m[2]}.${m[3]}` : m[2]) : "";
    return `${fam}${ver ? " " + ver : ""}${one}`;
  }
  if (/^(opus|sonnet|haiku|default)$/i.test(id)) return id[0].toUpperCase() + id.slice(1);
  return id;
}

export function modelFamily(id: string | null | undefined): string {
  if (!id) return "other";
  const m = /(fable|mythos|opus|sonnet|haiku)/i.exec(id);
  if (m) return m[1].toLowerCase();
  if (/codex|gpt|o[34]/i.test(id)) return "gpt";
  return "other";
}

/** Stable colour per family, from the existing palette tokens. */
export function modelColor(id: string | null | undefined): string {
  switch (modelFamily(id)) {
    case "fable":
    case "mythos":
      return "var(--accent-2)";
    case "opus":
      return "var(--claude)";
    case "sonnet":
      return "var(--accent)";
    case "haiku":
      return "var(--busy)";
    case "gpt":
      return "var(--codex)";
    default:
      return "var(--dim)";
  }
}

export const tokTotal = (u: Pick<ModelUse, "input" | "cached" | "output">) => u.input + u.cached + u.output;

/**
 * Models a session used, most first. Prefers `Session.models` from the
 * backend; falls back to one row from `model` + `tokens` so older backends
 * still show something truthful.
 */
export function sessionModels(s: Pick<Session, "model" | "tokens" | "models">): ModelUse[] {
  if (s.models && s.models.length) return [...s.models].sort((a, b) => tokTotal(b) - tokTotal(a));
  if (!s.model) return [];
  const t: Tokens = s.tokens;
  return [{ model: s.model, input: t.input, cached: t.cached, output: t.output, messages: 0 }];
}

/** Merge several ModelUse lists by model id. */
export function mergeModels(lists: ModelUse[][]): ModelUse[] {
  const by = new Map<string, ModelUse>();
  for (const l of lists)
    for (const u of l) {
      const k = u.model + (u.via_agent ? "|a" : "");
      const cur = by.get(k);
      if (cur) {
        cur.input += u.input;
        cur.cached += u.cached;
        cur.output += u.output;
        cur.messages += u.messages;
      } else by.set(k, { ...u });
    }
  return [...by.values()].sort((a, b) => tokTotal(b) - tokTotal(a));
}
