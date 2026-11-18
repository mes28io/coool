// A sub-agent card's two extra facts (CHAT_SPEC "Sub-agent cards"): how full its context is, and what the
// lead handed it. Pure: unit-tested by agentFill.test.ts.

import { contextWindow } from "./models.ts";

export interface Fill {
  /** Its latest context (plus that response's output, as Claude Code counts a subagent). */
  used: number;
  window: number;
  /** 0..1 */
  share: number;
  /** The window is the model family's, not one the CLI reported. */
  estimate: boolean;
  /** Above 80%. */
  high: boolean;
}

/** null when nothing is known (Codex child jobs, a subagent before its first response): the bar is hidden. */
export function agentFill(used: number | null | undefined, model: string | null | undefined, reported?: number | null): Fill | null {
  if (!used || used <= 0) return null;
  const w = contextWindow(model, reported);
  const share = Math.min(1, used / w.tokens);
  return { used, window: w.tokens, share, estimate: w.source !== "reported", high: share > 0.8 };
}

/** "32k", "1M", "272k", "1.2k". */
export function fmtK(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`.replace(".0M", "M");
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`.replace(".0k", "k");
  return String(Math.round(n));
}

/** "32k / 200k" (with "~" before the window when it is the family's estimate). */
export const fillText = (f: Fill) => `${fmtK(f.used)} / ${f.estimate ? "~" : ""}${fmtK(f.window)}`;

/** The first line of what the lead handed over, or null when it says nothing the title doesn't. */
export function handoffLine(prompt: string | null | undefined, title?: string | null): string | null {
  const line = (prompt ?? "")
    .split("\n")
    .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (title && norm(line) === norm(title)) return null;
  return line.length > 200 ? line.slice(0, 199) + "…" : line;
}

/** The prompt of a Task / Agent / spawn_agent call (Claude `prompt`, Codex `message` / `prompt`). */
export function taskPrompt(input: unknown): string | null {
  const i = (input ?? {}) as Record<string, unknown>;
  for (const k of ["prompt", "message", "task", "instructions"]) if (typeof i[k] === "string" && (i[k] as string).trim()) return i[k] as string;
  return null;
}
