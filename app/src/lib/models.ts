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

/** Stable colour per family, from the neutral and accent tokens. */
export function modelColor(id: string | null | undefined): string {
  const t = (n: number) => `color-mix(in oklab, var(--text) ${n}%, transparent)`;
  switch (modelFamily(id)) {
    case "fable":
    case "mythos":
      return t(80);
    case "opus":
      return t(100);
    case "sonnet":
      return t(60);
    case "haiku":
      return t(35);
    case "gpt":
      return t(50);
    default:
      return t(25);
  }
}

export const tokTotal = (u: Pick<ModelUse, "input" | "cached" | "output">) => u.input + u.cached + u.output;

/**
 * List API prices, USD per million tokens (in = input incl. cache writes, read = cache reads, out = output).
 * Source: the claude-api skill's model table, cached 2026-11-03. Cache reads are quoted there for Fable 5.2,
 * Opus 5.5 and Sonnet 5.5; the other cache-read prices are assumed at 0.1x input. Claude Code's `input` does not
 * separate cache writes, so those are priced at the input rate. Only used to weight shares, never shown.
 * Entries are matched top to bottom; a model id with an unknown version falls to its family's latest row.
 */
const PRICES: { re: RegExp; in: number; read: number; out: number }[] = [
  { re: /(fable|mythos)-5-2/, in: 8, read: 0.2, out: 40 },
  { re: /(fable|mythos)/, in: 10, read: 1, out: 50 },
  { re: /opus-5-5/, in: 4, read: 0.2, out: 20 },
  { re: /opus-(5|4)/, in: 5, read: 0.5, out: 25 },
  { re: /sonnet-5/, in: 2, read: 0.1, out: 10 },
  { re: /sonnet-4/, in: 3, read: 0.3, out: 15 },
  { re: /haiku-5/, in: 0.1, read: 0.01, out: 0.5 },
  { re: /haiku-4/, in: 1, read: 0.1, out: 5 },
  // Family fallbacks (latest generation).
  { re: /opus/, in: 4, read: 0.2, out: 20 },
  { re: /sonnet/, in: 2, read: 0.1, out: 10 },
  { re: /haiku/, in: 0.1, read: 0.01, out: 0.5 },
];

/** Price-weighted usage of one row, or null when the model has no known price. */
export function usageWeight(u: Pick<ModelUse, "model" | "input" | "cached" | "output">): number | null {
  const p = PRICES.find((x) => x.re.test(u.model.toLowerCase()));
  return p ? (u.input * p.in + u.cached * p.read + u.output * p.out) / 1e6 : null;
}

/**
 * Shares (0..1) within a group of rows: price-weighted when every row has a price; else, for a group with
 * no priced model at all (Codex / GPT: no prices in the repo), output tokens; else plain token share (`approx`).
 */
export function usageShares(rows: Pick<ModelUse, "model" | "input" | "cached" | "output">[]): { shares: number[]; approx: boolean } {
  const w = rows.map(usageWeight);
  let vals: number[];
  let approx = false;
  if (w.every((x) => x !== null)) vals = w as number[];
  else if (w.every((x) => x === null)) vals = rows.map((r) => r.output);
  else {
    vals = rows.map(tokTotal);
    approx = true;
  }
  const sum = vals.reduce((n, v) => n + v, 0);
  return { shares: vals.map((v) => (sum > 0 ? v / sum : 1 / rows.length)), approx };
}

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
