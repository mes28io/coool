// Ladder's "while working" surfaces: the tier word next to a delegate's model (sub-agent cards, Mission control
// fan-out) and the one-line tally under a turn's "Worked for" row. Only counts the app really has.

import { useMemo, useState } from "react";
import type { Chat, ChatItem } from "../lib/chat";
import { fmtTokens } from "../lib/format";
import { useLaunchedLadder } from "../lib/ladder";
import { itemsAfter, LADDER, roleOf, tallyChecks, tallyModels, tallyProviders, turnTally, type LadderTier, type TallyExtra, type TierRole } from "../lib/ladderTiers";
import { agentForCall, isBackgroundCall, lanesByCall } from "../lib/helperCards";
import { stateOf } from "../lib/agentState";
import { tsToMs } from "../lib/format";
import { useStore } from "../store";
import type { Session } from "../lib/types";
import { modelLabel } from "../lib/models";
import { turnItems } from "../lib/turnBreakdown";
import type { Provider } from "../lib/types";
import { cx } from "./primitives";

/** The tiers a running chat was launched with (null: Ladder off or unknown). */
export function useChatTiers(chatId: number | null | undefined): LadderTier[] | null {
  const l = useLaunchedLadder(chatId ?? -1);
  return l?.tiers?.length ? l.tiers : null;
}

/** The other CLI's lanes a running chat was launched with (`codex exec` / `claude -p` tiers; null: none). */
export function useChatCross(chatId: number | null | undefined): LadderTier[] | null {
  const l = useLaunchedLadder(chatId ?? -1);
  return l?.cross?.length ? l.cross : null;
}

/** "small" for a delegate model on the chat's table, else null. */
export function tierWord(tiers: LadderTier[] | null, model: string | null | undefined, provider: Provider): TierRole | null {
  return roleOf(tiers, model, provider);
}

/** Card id -> role for Mission control's fan-out (only for chats launched with Ladder tiers); a helper on the other CLI takes its lane's role ("exec"). */
export function cardRoles(tiers: LadderTier[] | null, cards: { id: string; model: string | null; provider: Provider }[], cross?: LadderTier[] | null): Record<string, string> | undefined {
  if (!tiers && !cross) return undefined;
  const out: Record<string, string> = {};
  for (const c of cards) {
    const r = roleOf(tiers, c.model, c.provider) ?? roleOf(cross, c.model, c.provider);
    if (r) out[c.id] = r;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The role word before a delegate's model tag ("small"), quiet. */
export function TierTag({ role, className }: { role: TierRole | "image" | null; className?: string }) {
  if (!role) return null;
  return (
    <span className={cx("shrink-0 text-small text-faint", className)} data-ladder-tier={role} title={`${LADDER} tier: ${role}`}>
      {role} ·
    </span>
  );
}

/**
 * What the session adds to a turn's tally: each shell launch with its session's model, state and tokens (`kids`: the
 * helper sessions' model and tokens by id); when each of the turn's background helpers returned; the items after the turn.
 */
function tallyExtra(chat: Chat, at: number, session: Session | null, kids: Record<string, { model: string; tokens: number }>): TallyExtra {
  const lanes: NonNullable<TallyExtra["lanes"]> = {};
  for (const [tool, ls] of Object.entries(lanesByCall(session?.lanes)))
    lanes[tool] = ls.map((l) => {
      const kid = l.session ? kids[l.session] : undefined;
      return { provider: l.provider, model: kid?.model || l.model, image: l.image, state: l.state, ended: l.ended, tokens: kid?.tokens ?? 0 };
    });
  const returned: NonNullable<TallyExtra["returned"]> = {};
  if (session?.agents.length) {
    const claimed = new Set<string>();
    const firstAt = (a: Session["agents"][number]) => (a.activity.length ? tsToMs(a.activity[0].ts) : null);
    for (const it of turnItems(chat.items, at)) {
      if (it.kind !== "tool" || !it.agent || it.parent || !isBackgroundCall(it.input, it.output)) continue;
      const a = agentForCall({ input: it.input, output: it.output, ts: it.ts }, session.agents, claimed, firstAt);
      if (!a) continue;
      claimed.add(a.id);
      const st = stateOf(a);
      returned[it.id] = { end: st === "running" ? null : (a.last_event ?? it.ts), ok: st === "running" ? null : st === "done", model: a.model || null, tokens: a.tokens.total || 0 };
    }
  }
  return { lanes, returned, after: itemsAfter(chat.items as never, at) };
}

export function LadderTally({ chat, item }: { chat: Chat; item: Extract<ChatItem, { kind: "turn" }> }) {
  const launched = useLaunchedLadder(chat.id);
  const tiers = launched?.tiers?.length ? launched.tiers : null;
  const cross = launched?.cross?.length ? launched.cross : null;
  const at = chat.items.indexOf(item);
  const lead = useMemo(() => {
    for (let i = at - 1; i >= 0; i--) {
      const it = chat.items[i];
      if (it.kind === "turn") break;
      if (it.kind === "text" && !it.parent && it.model) return it.model;
    }
    return chat.model;
  }, [chat.items, chat.model, at]);
  // The chat's own session (its transcript): background helpers' ends and the shell helpers' launches and sessions.
  const session = useStore((st) => st.sessions.find((s) => s.chat === chat.id && s.provider === chat.provider) ?? null);
  // The helper sessions' model and tokens only (not the whole list: this row must not redo its sums on every refresh).
  const kidKey = useStore((st) => {
    const ids = new Set((session?.lanes ?? []).map((l) => l.session).filter(Boolean));
    if (!ids.size) return "";
    return st.sessions
      .filter((s) => ids.has(s.id))
      .map((s) => `${s.id}\t${s.model}\t${s.tokens.input + s.tokens.cached + s.tokens.output}`)
      .join("\n");
  });
  const kids = useMemo(() => Object.fromEntries(kidKey.split("\n").filter(Boolean).map((r) => r.split("\t")).map(([id, model, n]) => [id, { model, tokens: Number(n) }])), [kidKey]);
  const extra = useMemo(() => tallyExtra(chat, at, session, kids), [chat, at, session, kids]);
  const t = useMemo(
    () => turnTally(turnItems(chat.items, at) as never, chat.agents as never, { provider: chat.provider, lead, tiers, cross }, extra),
    [chat.items, chat.agents, chat.provider, lead, tiers, cross, at, extra],
  );
  const [open, setOpen] = useState(false);
  const n = t.delegates.length;
  if (!n) return null;
  const tokens = t.delegates.reduce((s, d) => s + d.tokens, 0);
  const models = tallyModels(t, tiers, cross, chat.provider) + (t.onLead > 0 ? ` (${t.onLead} on the lead's own model or above)` : "");
  const providers = tallyProviders(t, chat.provider);
  const line = [
    `${n} helper${n === 1 ? "" : "s"}${providers ? ` (${providers})` : ""}`,
    models,
    tokens > 0 && `${fmtTokens(tokens)} tokens`,
    `checked: ${tallyChecks(t)}${t.delegateTests ? `, helpers ran tests ${t.delegateTests}×` : ""}`,
  ].filter(Boolean);
  return (
    <div className="mt-1" data-ladder-tally={n}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? "Hide the helpers" : "Show the helpers"} className="-mx-1 flex max-w-full items-baseline gap-1.5 rounded-[6px] px-1 text-left text-small leading-snug text-faint transition-colors duration-150 hover:bg-hover">
        {launched && <span className="shrink-0 font-medium text-dim">{LADDER}</span>}
        <span className="min-w-0">{line.join(" · ")}</span>
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-0.5 pl-1 text-small text-faint tnum" data-ladder-delegates>
          {t.delegates.map((d, i) => (
            <div key={d.id} className="flex items-baseline gap-2">
              <span className="w-[14px] shrink-0 text-right">{i + 1}</span>
              <span className="w-[44px] shrink-0">{d.role ?? "—"}</span>
              <span className="min-w-0 flex-1 truncate text-dim">
                {d.role === "image" ? `image · ${d.provider === "codex" ? "GPT" : "Claude"}` : d.model ? modelLabel(d.model) : "model not reported"}
                {d.provider !== chat.provider ? ` · ${d.provider === "codex" ? "Codex" : "Claude"}` : ""}
                {d.via === "spawn" ? " · coool chat" : d.via === "lane" ? " · lane" : ""}
              </span>
              <span className="shrink-0">{d.tokens > 0 ? `${fmtTokens(d.tokens)} tokens` : ""}</span>
              <span className="w-[56px] shrink-0 text-right">{d.ok === null ? "running" : d.ok ? "ok" : "failed"}</span>
              <span className="w-[72px] shrink-0 text-right">{d.tests ? `tests ${d.tests}×` : ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
