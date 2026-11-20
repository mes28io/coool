// Ladder's "while working" surfaces: the tier word next to a delegate's model (sub-agent cards, Mission control
// fan-out) and the one-line tally under a turn's "Worked for" row. Only counts the app really has.

import { useMemo, useState } from "react";
import type { Chat, ChatItem } from "../lib/chat";
import { fmtTokens } from "../lib/format";
import { useLaunchedLadder } from "../lib/ladder";
import { LADDER, roleOf, tallyChecks, tallyModels, turnTally, type LadderRole, type LadderTier } from "../lib/ladderTiers";
import { modelLabel } from "../lib/models";
import { turnItems } from "../lib/turnBreakdown";
import type { Provider } from "../lib/types";
import { cx } from "./primitives";

/** The tiers a running chat was launched with (null: Ladder off or unknown). */
export function useChatTiers(chatId: number | null | undefined): LadderTier[] | null {
  const l = useLaunchedLadder(chatId ?? -1);
  return l?.tiers?.length ? l.tiers : null;
}

/** "small" for a delegate model on the chat's table, else null. */
export function tierWord(tiers: LadderTier[] | null, model: string | null | undefined, provider: Provider): LadderRole | null {
  return roleOf(tiers, model, provider);
}

/** Card id -> role for Mission control's fan-out (only for chats launched with Ladder tiers). */
export function cardRoles(tiers: LadderTier[] | null, cards: { id: string; model: string | null; provider: Provider }[]): Record<string, string> | undefined {
  if (!tiers) return undefined;
  const out: Record<string, string> = {};
  for (const c of cards) {
    const r = roleOf(tiers, c.model, c.provider);
    if (r) out[c.id] = r;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The role word before a delegate's model tag ("small"), quiet. */
export function TierTag({ role, className }: { role: LadderRole | null; className?: string }) {
  if (!role) return null;
  return (
    <span className={cx("shrink-0 text-small text-faint", className)} data-ladder-tier={role} title={`${LADDER} tier: ${role}`}>
      {role} ·
    </span>
  );
}

export function LadderTally({ chat, item }: { chat: Chat; item: Extract<ChatItem, { kind: "turn" }> }) {
  const launched = useLaunchedLadder(chat.id);
  const tiers = launched?.tiers?.length ? launched.tiers : null;
  const at = chat.items.indexOf(item);
  const lead = useMemo(() => {
    for (let i = at - 1; i >= 0; i--) {
      const it = chat.items[i];
      if (it.kind === "turn") break;
      if (it.kind === "text" && !it.parent && it.model) return it.model;
    }
    return chat.model;
  }, [chat.items, chat.model, at]);
  const t = useMemo(
    () => turnTally(turnItems(chat.items, at) as never, chat.agents as never, { provider: chat.provider, lead, tiers }),
    [chat.items, chat.agents, chat.provider, lead, tiers, at],
  );
  const [open, setOpen] = useState(false);
  const n = t.delegates.length;
  if (!n) return null;
  const tokens = t.delegates.reduce((s, d) => s + d.tokens, 0);
  const models = tallyModels(t, tiers) + (t.onLead > 0 ? `${t.byModel.length ? ", " : ""}${t.onLead} on the lead's own model` : "");
  const line = [
    `${n} delegate${n === 1 ? "" : "s"}`,
    models,
    tokens > 0 && `${fmtTokens(tokens)} tokens`,
    `checked: ${tallyChecks(t)}${t.delegateTests ? `, delegates ran tests ${t.delegateTests}×` : ""}`,
  ].filter(Boolean);
  return (
    <div className="mt-1" data-ladder-tally={n}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? "Hide the delegates" : "Show the delegates"} className="-mx-1 flex max-w-full items-baseline gap-1.5 rounded-[6px] px-1 text-left text-small leading-snug text-faint transition-colors duration-150 hover:bg-hover">
        {launched && <span className="shrink-0 font-medium text-dim">{LADDER}</span>}
        <span className="min-w-0">{line.join(" · ")}</span>
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-0.5 pl-1 text-small text-faint tnum" data-ladder-delegates>
          {t.delegates.map((d, i) => (
            <div key={d.id} className="flex items-baseline gap-2">
              <span className="w-[14px] shrink-0 text-right">{i + 1}</span>
              <span className="w-[44px] shrink-0">{d.role ?? "—"}</span>
              <span className="min-w-0 flex-1 truncate text-dim">{d.model ? modelLabel(d.model) : "model not reported"}</span>
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
