// "What this does and why" on a permission request (CHAT_SPEC "What this does and why"): the agent's own claim, shown
// at once (its description, its last words or reasoning, its plan), and the independent "AI read" (lib/explain.ts,
// lib/explainStore.ts) when AI insights is on, filling in when it arrives. Then "What to check": the Risky rule's reason
// (lib/risk.ts) and what the AI read adds, each marked with where it came from. Never "safe", never a countdown, never
// a default answer: the Allow / Deny buttons beside it work the same before, during and after a read.
//
// `full`: the Needs you page, under the payload. `compact`: the chat's approval card, one or two lines, "More" opens it.

import { useEffect, useMemo, useState } from "react";
import { agentClaim, checkItems, claimEmpty, explainRequest, redactSecrets, stepLine, type AiRead, type CheckItem, type Claim } from "../lib/explain";
import { askRead, dismissOffHint, offHint, useReads, type ReadState } from "../lib/explainStore";
import type { Chat, ChatItem } from "../lib/chat";
import { modelLabel } from "../lib/models";
import { chatContext, type NeedContext } from "../lib/needs";
import { riskOf } from "../lib/risk";
import { useStore } from "../store";
import { IAlert, IChevron, IClose, ISpark } from "./icons";
import { cx } from "./primitives";

type Perm = Extract<ChatItem, { kind: "permission" }>;
type Tool = Extract<ChatItem, { kind: "tool" }>;

const label = "font-mono text-micro font-medium uppercase tracking-[0.06em] text-faint";

export interface ExplainSource {
  /** The request id (the read's cache key). */
  id: string;
  tool: string;
  input: unknown;
  cwd: string;
  project: string | null;
  ctx: NeedContext;
  /** Step lines for the model ("Bash · cargo build"), oldest first. */
  steps: string[];
  who: string;
  /** A plan the agent had approved earlier in the chat (its title). */
  plan: string | null;
  /** False: show the agent's claim only, never ask for a read (a terminal wait whose command isn't known). */
  readable: boolean;
}

/** The read of a permission request in a coool chat. */
export function chatSource(perm: Perm, chat: Chat, project: string | null): ExplainSource {
  const ctx = chatContext(chat.items, perm.ts, perm.tool);
  const steps = ctx.steps.map((s) => (s.kind === "tool" ? stepLine(s.tool.name, s.tool.summary) : stepLine(s.a.text, "")));
  let plan: string | null = null;
  for (let i = chat.items.length - 1; i >= 0; i--) {
    const it = chat.items[i];
    if (it.ts > perm.ts) continue;
    if ((it.kind === "tool" || it.kind === "permission") && (it.kind === "tool" ? (it as Tool).name : it.tool) === "ExitPlanMode") {
      plan = agentClaim("ExitPlanMode", it.input, null).plan;
      break;
    }
  }
  return { id: perm.requestId, tool: perm.tool, input: perm.input, cwd: chat.cwd, project, ctx, steps, who: chat.provider === "codex" ? "Codex" : "Claude", plan, readable: true };
}

/** The chat's permission request, explained (the context is read once per change of the chat's items). */
export function PermExplain({ perm, chat, project, variant }: { perm: Perm; chat: Chat; project?: string | null; variant: "full" | "compact" }) {
  const src = useMemo(() => chatSource(perm, chat, project ?? null), [perm, chat, project]);
  return <Explain src={src} variant={variant} />;
}

function useRead(src: ExplainSource): ReadState | null {
  const r = useReads((st) => st.reads[src.id] ?? null);
  // `askRead` asks once per request id, however often `src` is rebuilt.
  useEffect(() => {
    if (src.readable) askRead(explainRequest({ id: src.id, tool: src.tool, input: src.input, cwd: src.cwd, project: src.project, ctx: src.ctx, steps: src.steps, agent: src.who }));
  }, [src]);
  return r;
}

const aiTitle = (model: string) => `AI read by ${modelLabel(model)} (${model}): an independent reading of the request and the steps before it, made by coool's AI insights. It can be wrong; read the request itself.`;

export function Explain({ src, variant }: { src: ExplainSource; variant: "full" | "compact" }) {
  const r = useRead(src);
  const claim = useMemo<Claim>(() => {
    const c = agentClaim(src.tool, src.input, src.ctx);
    return { ...c, plan: c.plan ?? src.plan };
  }, [src.tool, src.input, src.ctx, src.plan]);
  const rule = useMemo(() => riskOf(src.tool, src.input, src.cwd)?.reason ?? null, [src.tool, src.input, src.cwd]);
  const read = r?.status === "done" ? r.read : null;
  const checks = checkItems(rule, read);
  const state = r?.status ?? (src.readable ? "pending" : "none");
  // The "turn on the AI read" hint: only when it's off, the first few requests.
  // (`offHint` counts each request id once, so reading it during render is stable.)
  const [dropped, setDropped] = useState(false);
  const off = r?.status === "off";
  const hint = off && !dropped && offHint(src.id);
  const props = { src, claim, r, read, checks, hint, dropHint: () => (dismissOffHint(), setDropped(true)) };
  return (
    <div data-explain={src.id} data-explain-state={state} data-explain-variant={variant}>
      {variant === "full" ? <Full {...props} /> : <Compact {...props} />}
    </div>
  );
}

interface Props {
  src: ExplainSource;
  claim: Claim;
  r: ReadState | null;
  read: AiRead | null;
  checks: CheckItem[];
  hint: boolean;
  dropHint: () => void;
}

// ---------- full (Needs you page) ----------

function Full({ src, claim, r, read, checks, hint, dropHint }: Props) {
  return (
    <section className="flex flex-col gap-3 rounded-[10px] border border-hairline bg-bg/60 px-3 py-2.5" data-explain-full>
      <div className={label}>What this does and why</div>
      <ClaimBlock who={src.who} claim={claim} />
      <AiBlock r={r} read={read} readable={src.readable} />
      {checks.length > 0 && <Checks checks={checks} />}
      {hint && <OffHint onClose={dropHint} />}
    </section>
  );
}

function ClaimBlock({ who, claim }: { who: string; claim: Claim }) {
  if (claimEmpty(claim))
    return (
      <p className="text-base text-dim" data-explain-claim="">
        {who} didn't say what this is for.
      </p>
    );
  return (
    <div className="flex flex-col gap-1" data-explain-claim={claim.description ?? claim.said ?? claim.thought ?? claim.plan ?? ""}>
      <div className="text-small text-dim">
        {who} says <span className="text-faint">· its own words, not checked</span>
      </div>
      {claim.description && <p className="selectable text-base text-fg">“{claim.description}”</p>}
      {claim.said && (
        <p className="selectable text-base text-dim">
          <span className="text-faint">Before asking: </span>
          {claim.said}
        </p>
      )}
      {claim.thought && (
        <p className="selectable text-base italic text-dim">
          <span className="not-italic text-faint">Its reasoning: </span>
          {claim.thought}
        </p>
      )}
      {claim.plan && (
        <p className="selectable text-base text-dim">
          <span className="text-faint">From its plan: </span>
          {claim.plan}
        </p>
      )}
    </div>
  );
}

function AiTag({ model }: { model?: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-[6px] bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] px-1.5 text-small font-medium text-accent-text" title={aiTitle(model ?? "claude-haiku-5-5")} data-explain-ai-tag>
      <ISpark size={11} />
      AI read
    </span>
  );
}

function AiBlock({ r, read, readable }: { r: ReadState | null; read: AiRead | null; readable: boolean }) {
  if (!readable) return null;
  if (read && r?.status === "done")
    return (
      <div className="flex flex-col gap-1 border-t border-hairline pt-2.5" data-explain-ai={read.what}>
        <div className="flex items-center gap-2">
          <AiTag model={r.model} />
          <span className="text-small text-faint">can be wrong</span>
        </div>
        <p className="selectable text-base text-fg">
          <span className="text-dim">What it does: </span>
          {read.what}
        </p>
        {read.why && (
          <p className="selectable text-base text-fg">
            <span className="text-dim">Why: </span>
            {read.why}
          </p>
        )}
      </div>
    );
  if (!r || r.status === "pending")
    return (
      <div className="flex items-center gap-2 border-t border-hairline pt-2.5 text-small text-faint" data-explain-ai-pending>
        <AiTag />
        <span className="animate-pulse">Reading the request…</span>
      </div>
    );
  if (r.status === "timeout" || r.status === "error" || r.status === "limited")
    return (
      <div className="flex items-center gap-2 border-t border-hairline pt-2.5 text-small text-faint" data-explain-ai-missing={r.status} title={r.status === "error" ? r.message : undefined}>
        <ISpark size={11} />
        {r.status === "timeout" ? "The AI read didn't come back in time." : r.status === "limited" ? "No AI read: the hourly limit of AI insights is reached." : "The AI read isn't available right now."}
      </div>
    );
  return null;
}

function Checks({ checks }: { checks: CheckItem[] }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-hairline pt-2.5" data-explain-check={checks.length}>
      <div className={label}>What to check</div>
      {checks.map((c, i) => (
        <div key={i} className="flex items-start gap-2 text-base" data-explain-check-from={c.from} data-explain-mismatch={c.mismatch ? "" : undefined}>
          <IAlert size={13} className="mt-[3px] shrink-0 text-needs-text" />
          <span className="selectable min-w-0 flex-1 text-fg">
            {c.mismatch && <span className="font-medium text-needs-text">Doesn't match what it said: </span>}
            {c.text}
          </span>
          <span className="mt-px shrink-0 text-small text-faint" title={c.from === "rule" ? "From coool's fixed Risky rules (a short list: a request without a match still deserves a read)" : aiTitle("claude-haiku-5-5")}>
            {c.from === "rule" ? "Risky rule" : "AI read"}
          </span>
        </div>
      ))}
    </div>
  );
}

function OffHint({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center gap-2 text-small text-faint" data-explain-hint>
      <ISpark size={11} className="shrink-0" />
      <span className="min-w-0">
        An independent AI read of each request is available with{" "}
        <button type="button" className="text-dim underline decoration-line underline-offset-2 hover:text-fg" onClick={() => useStore.getState().openSettings("insights")} data-explain-hint-open>
          AI insights in Settings
        </button>
        .
      </span>
      <button type="button" onClick={onClose} className="ml-auto shrink-0 rounded-[4px] p-0.5 hover:bg-hover hover:text-fg" title="Don't show this again" aria-label="Don't show this again">
        <IClose size={11} />
      </button>
    </div>
  );
}

// ---------- compact (the chat's approval card) ----------

function Compact({ src, claim, r, read, checks, hint, dropHint }: Props) {
  const [open, setOpen] = useState(false);
  const said = claim.description ?? claim.said ?? claim.thought ?? claim.plan;
  const aiChecks = checks.filter((c) => c.from === "ai");
  const more = !!read && (!!read.why || aiChecks.length > 0 || (!!claim.description && !!claim.said));
  return (
    <div className="mt-1.5 flex flex-col gap-1 text-small" data-explain-compact>
      <div className="flex min-w-0 items-baseline gap-1.5" data-explain-claim={said ?? ""}>
        <span className="shrink-0 text-faint">{src.who} says:</span>
        <span className={cx("selectable min-w-0 text-dim", !open && "truncate")} title={open ? undefined : (said ?? undefined)}>
          {said ?? <span className="text-faint">nothing about what this is for</span>}
        </span>
      </div>
      {src.readable && read && r?.status === "done" && (
        <div className="flex min-w-0 items-baseline gap-1.5" data-explain-ai={read.what}>
          <AiTag model={r.model} />
          <span className={cx("selectable min-w-0 flex-1 text-fg/90", !open && "truncate")} title={open ? undefined : read.what}>
            {read.what}
          </span>
          {aiChecks.length > 0 && !open && (
            <span className="flex shrink-0 items-center gap-1 text-needs-text" data-explain-check={aiChecks.length}>
              <IAlert size={11} />
              {aiChecks.length === 1 ? "1 to check" : `${aiChecks.length} to check`}
            </span>
          )}
          {more && (
            <button type="button" onClick={() => setOpen((v) => !v)} className="flex shrink-0 items-center gap-0.5 text-faint hover:text-fg" aria-expanded={open} data-explain-more>
              {open ? "Less" : "More"}
              <IChevron size={10} className={cx("transition-transform", open ? "-rotate-90" : "rotate-90")} />
            </button>
          )}
        </div>
      )}
      {src.readable && (!r || r.status === "pending") && (
        <div className="flex items-center gap-1.5 text-faint" data-explain-ai-pending>
          <ISpark size={11} />
          <span className="animate-pulse">AI read…</span>
        </div>
      )}
      {open && read && (
        <div className="flex flex-col gap-1 pl-0.5 pt-0.5">
          {claim.description && claim.said && (
            <p className="selectable text-dim">
              <span className="text-faint">Before asking: </span>
              {claim.said}
            </p>
          )}
          {read.why && (
            <p className="selectable text-fg/90">
              <span className="text-faint">Why: </span>
              {read.why}
            </p>
          )}
          {aiChecks.map((c, i) => (
            <div key={i} className="flex items-start gap-1.5" data-explain-check-from="ai" data-explain-mismatch={c.mismatch ? "" : undefined}>
              <IAlert size={11} className="mt-[3px] shrink-0 text-needs-text" />
              <span className="selectable min-w-0 text-fg/90">
                {c.mismatch && <span className="font-medium text-needs-text">Doesn't match what it said: </span>}
                {c.text}
              </span>
            </div>
          ))}
        </div>
      )}
      {hint && <OffHint onClose={dropHint} />}
    </div>
  );
}

// ---------- a session coool doesn't drive (a terminal waiting on its own prompt) ----------

/** What the transcript gives: its last prompt, words and steps; the read only when the wait names the command. */
export function terminalSource(o: { key: string; command: string | null; cwd: string; project: string | null; ctx: NeedContext; who: string }): ExplainSource {
  const steps = o.ctx.steps.map((s) => (s.kind === "activity" ? stepLine(s.a.text, "") : stepLine(s.tool.name, s.tool.summary)));
  return { id: `term:${o.key}:${o.command ?? ""}`, tool: "Bash", input: o.command ? { command: o.command } : {}, cwd: o.cwd, project: o.project, ctx: o.ctx, steps, who: o.who, plan: null, readable: !!o.command };
}

// ---------- the payload with its secrets hidden ----------

/** A `<pre>` of `text` with obvious secrets hidden (lib/explain.ts `redactSecrets`), and a toggle to show them. */
export function RedactedPre({ text, className, title, ...data }: { text: string; className?: string; title?: string } & Record<`data-${string}`, string | boolean | undefined>) {
  const [show, setShow] = useState(false);
  const hidden = useMemo(() => redactSecrets(text), [text]);
  const n = hidden === text ? 0 : (hidden.match(/\[redacted/g) ?? []).length - (text.match(/\[redacted/g) ?? []).length;
  return (
    <>
      <pre className={className} title={title} {...data}>
        {show || !n ? text : hidden}
      </pre>
      {n > 0 && (
        <button type="button" onClick={() => setShow((v) => !v)} className="mt-1 text-small text-faint hover:text-fg" data-redacted={n}>
          {show ? "Hide the secret values" : n === 1 ? "1 value that looks secret is hidden · Show" : `${n} values that look secret are hidden · Show`}
        </button>
      )}
    </>
  );
}
