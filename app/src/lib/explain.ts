// "What this does and why" on a permission request (CHAT_SPEC "What this does and why"). Two sources, in this order:
//   a. what the agent itself gave, free and at once: the Bash tool's `description`, its last words and reasoning
//      before it asked, a plan's text. Shown as the agent's own claim ("Claude says: …").
//   b. an independent "AI read" by the small insights model (crates/core/src/explain.rs), only when AI insights is on.
// Pure: no React, no store (tested in explain.test.ts). The UI is components/Explain.tsx, the fetching lib/explainStore.ts.
//
// Wording rules: nothing here, from the rules or from the model, ever says a request is safe or fine (`REASSURE` is
// filtered out of every model text, and the UI's own words never say it); the "Risky" tag stays rule-only.

import type { NeedContext } from "./needs";

/** What the backend's `explain_request` takes (local IPC; explain.rs decides what of it reaches the model). */
export interface ExplainRequest {
  id: string;
  tool: string;
  input: unknown;
  cwd: string;
  project: string | null;
  prompt: string | null;
  said: string | null;
  thought: string | null;
  steps: string[];
  agent: string;
}

export interface AiRead {
  what: string;
  why: string;
  check: string[];
  mismatch: boolean;
}

/** What `explain_request` returns. */
export type ExplainReply =
  | { status: "off"; has_key: boolean }
  | { status: "limited" }
  | { status: "error"; message: string }
  | { status: "done"; read: AiRead; model: string; usd: number; ms: number };

// ---------------------------------------------------------------- redaction

/** Mirrors `RULES` in crates/core/src/explain.rs (same rules, same order). */
const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "[redacted]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[redacted]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[redacted]"],
  [/\bnpm_[A-Za-z0-9]{30,}/g, "[redacted]"],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\b(authorization\s*:\s*)(?:(?:bearer|basic|token)\s+)?[^\s'"]+/gi, "$1[redacted]"],
  [/\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "Bearer [redacted]"],
  [/\b(x-api-key|api-key|x-auth-token|private-token|cookie)(\s*:\s*)[^'"\n]+/gi, "$1$2[redacted]"],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]+):[^@\s/'"]+@/gi, "$1:[redacted]@"],
  [/(--?(?:password|passwd|pass|token|api-key|apikey|secret|auth-token|access-token)(?:=|\s+))('[^']*'|"[^"]*"|\S+)/gi, "$1[redacted]"],
  [/\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_-]*)("?\s*[=:]\s*)('[^']*'|"[^"]*"|[^\s&"';,}]+)/gi, "$1$2[redacted]"],
];

/** `text` with obvious secrets replaced by `[redacted]` (by their shape, or by the name a flag, header, URL or assignment gives them). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, w] of RULES) out = out.replace(re, w);
  return out;
}

/** How many secrets `redactSecrets` hid in `text`. */
export function redactedCount(text: string): number {
  const before = (text.match(/\[redacted/g) ?? []).length;
  return (redactSecrets(text).match(/\[redacted/g) ?? []).length - before;
}

// ---------------------------------------------------------------- wording

/** Words that would imply a request is safe. Mirrors `REASSURE` in explain.rs. */
export const REASSURE = /\b(safe|safely|harmless|benign|innocuous|risk[- ]free|no risks?|low[- ]risk|nothing to worry|no (?:need|reason) to worry|looks (?:fine|good|ok|okay)|(?:is|are|seems|should be) (?:fine|ok|okay)|routine|nothing (?:to check|dangerous|risky))\b/i;

/** An item about what the agent said. Mirrors `SAYS` in explain.rs. */
const SAYS = /\b(descri\w*|says|said|stated|claims?|purpose)\b/i;

/** `t` without the sentences that imply safety. */
export function noReassurance(t: string): string {
  // Sentences end at . ! ? ; followed by a space or the end (so "./src" and "v1.2" stay whole).
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    cur += t[i];
    if (".!?;".includes(t[i]) && (i + 1 === t.length || /\s/.test(t[i + 1]))) {
      parts.push(cur);
      cur = "";
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts
    .filter((s) => !REASSURE.test(s))
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
}

const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
const clip = (t: string, max: number) => (t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`);

/** The backend's read, checked again on this side: right types, capped, no reassurance. Null when unusable. */
export function cleanRead(raw: unknown): AiRead | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const line = (v: unknown, max: number) => (typeof v === "string" ? clip(noReassurance(redactSecrets(oneLine(v))), max) : "");
  const what = line(o.what, 260);
  if (!what) return null;
  const check: string[] = [];
  if (Array.isArray(o.check))
    for (const c of o.check) {
      if (typeof c !== "string" || REASSURE.test(c)) continue;
      const s = line(c, 160);
      if (s && !check.some((x) => x.toLowerCase() === s.toLowerCase())) check.push(s);
      if (check.length === 4) break;
    }
  const mismatch = o.mismatch === true;
  // The item that says how the stated purpose differs goes first (it is shown as the mismatch).
  const i = mismatch ? check.findIndex((c) => SAYS.test(c)) : -1;
  if (i > 0) check.unshift(...check.splice(i, 1));
  return { what, why: line(o.why, 220), check, mismatch };
}

/** A reply from the backend (or the mock) made safe to show; anything malformed is an error. */
export function cleanReply(raw: unknown): ExplainReply {
  const r = raw as Partial<Record<string, unknown>> | null;
  if (r?.status === "off") return { status: "off", has_key: r.has_key === true };
  if (r?.status === "limited") return { status: "limited" };
  if (r?.status === "done") {
    const read = cleanRead(r.read);
    if (read) return { status: "done", read, model: typeof r.model === "string" ? r.model : "claude-haiku-5-5", usd: typeof r.usd === "number" ? r.usd : 0, ms: typeof r.ms === "number" ? r.ms : 0 };
  }
  return { status: "error", message: typeof r?.message === "string" ? redactSecrets(r.message) : "unexpected reply" };
}

// ---------------------------------------------------------------- the agent's own claim

export interface Claim {
  /** The tool call's own description (Bash `description`, a subagent's task). */
  description: string | null;
  /** Its last words before asking, short. */
  said: string | null;
  /** Its last reasoning before asking, short (when the CLI shows it). */
  thought: string | null;
  /** A plan's title (ExitPlanMode). */
  plan: string | null;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The last paragraph of `t`, one line, at most `max` characters (what was said just before asking). */
export function lastWords(t: string | null, max = 280): string | null {
  if (!t) return null;
  const paras = t
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^[#>*\-\s]+/gm, "").trim())
    .filter(Boolean);
  const p = paras[paras.length - 1];
  return p ? clip(redactSecrets(oneLine(p)), max) : null;
}

/** What the agent itself gave about a request: always shown, no model call. */
export function agentClaim(tool: string, input: unknown, ctx: Pick<NeedContext, "said" | "thought"> | null): Claim {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const description = str(i.description) || str(i.justification) || str(i.reason) || null;
  let plan: string | null = null;
  if (tool === "ExitPlanMode" && typeof i.plan === "string") plan = clip(oneLine(/^#+\s*(.+)$/m.exec(i.plan)?.[1] ?? i.plan.split("\n")[0]), 160);
  return {
    description: description ? clip(redactSecrets(oneLine(description)), 240) : null,
    said: lastWords(ctx?.said ?? null),
    thought: ctx?.said ? null : lastWords(ctx?.thought ?? null, 220),
    plan,
  };
}

export const claimEmpty = (c: Claim) => !c.description && !c.said && !c.thought && !c.plan;

/** One step as a line for the model ("Bash · cargo build"). */
export const stepLine = (name: string, detail: string) => clip(oneLine(detail ? `${name} · ${detail}` : name), 140);

/** The request for `explain_request`. */
export function explainRequest(o: { id: string; tool: string; input: unknown; cwd: string; project: string | null; ctx: NeedContext; steps: string[]; agent: string }): ExplainRequest {
  const t = (s: string | null, max: number) => (s ? clip(redactSecrets(s), max) : null);
  return { id: o.id, tool: o.tool, input: o.input, cwd: o.cwd, project: o.project, prompt: t(o.ctx.prompt, 1200), said: t(o.ctx.said, 1200), thought: t(o.ctx.thought, 1200), steps: o.steps.slice(-6), agent: o.agent };
}

// ---------------------------------------------------------------- what to check

export interface CheckItem {
  text: string;
  /** "rule": the fixed Risky rules (lib/risk.ts); "ai": the AI read. Shown apart. */
  from: "rule" | "ai";
  mismatch?: boolean;
}

/** The "What to check" list: the rule's reason first (when the Risky tag shows), then what the AI read adds. */
export function checkItems(rule: string | null, read: AiRead | null): CheckItem[] {
  const out: CheckItem[] = [];
  if (rule) out.push({ text: rule, from: "rule" });
  if (read) {
    read.check.forEach((c, i) => out.push({ text: c, from: "ai", mismatch: read.mismatch && i === 0 }));
    if (read.mismatch && !read.check.length) out.push({ text: "What it does may not match what the agent said it is for.", from: "ai", mismatch: true });
  }
  return out;
}
