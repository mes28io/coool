// The composer's Ladder chip: on or off for this chat, the lead and the tier table it runs (or will run) on both
// providers, the image lane, nesting depth, swarm mode, the budget picture, the highest helper tier and how many
// helpers run at once. A choice made here applies when the chat next starts or resumes.

import { useState } from "react";
import { type Chat } from "../lib/chat";
import { DEPTHS, LADDER, LADDER_LINE, ladderOn, MAX_PARALLEL, sameLadder, setChatLadder, useChatLadder, useLadderPrefs, useLadderPreview, useLaunchedLadder } from "../lib/ladder";
import { ROLE_LINE, rolesWord, tierRows, type LadderCap, type LadderTier } from "../lib/ladderTiers";
import { LadderBudget } from "./LadderBudget";
import { useSeenModels } from "../lib/prefs";
import { useStore } from "../store";
import { ICaret } from "./icons";
import { Chip, cx, Popover } from "./primitives";
import { Select, Switch } from "./settings/ui";

/** `disabled`: why the chip can't be used (its tooltip), e.g. the chat couldn't be opened. */
export function LadderChip({ chat, disabled }: { chat: Chat; disabled?: string | null }) {
  const [open, setOpen] = useState(false);
  const seen = useSeenModels()[chat.provider];
  const own = useChatLadder(chat);
  const prefs = useLadderPrefs();
  const launched = useLaunchedLadder(chat.id);
  const lead = chat.model || null;
  const on = ladderOn(own, prefs);
  const preview = useLadderPreview(chat.provider, lead, own);
  const asOn = useLadderPreview(chat.provider, lead, { ...own, on: true });
  const openSettings = useStore((s) => s.openSettings);
  const shown = launched ?? asOn;
  const tiers = (launched?.tiers.length ? launched.tiers : asOn?.tiers) ?? [];
  const cross = shown?.cross ?? [];
  const image = shown?.image ?? null;
  const depth = own.depth ?? prefs.depth;
  const swarm = own.swarm ?? prefs.swarm;
  const other = chat.provider === "claude" ? "Codex" : "Claude";
  const cap: LadderCap = own.cap ?? prefs.cap[chat.provider];
  const par = own.maxParallel ?? prefs.maxParallel;
  const differs = launched !== undefined && !sameLadder(launched, preview);
  // Tiers can only be judged with the chat's model and the CLI's model list both known.
  const unknown = !lead || !seen.length;

  return (
    <div className="relative" data-ladder-chip={on ? "on" : "off"}>
      <Chip active={open} onClick={() => setOpen(!open)} title={disabled ?? `${LADDER}: ${on ? "on" : "off"} for this chat`} disabled={!!disabled}>
        <span className={cx("size-[6px] rounded-full", on ? "bg-fg/60" : "border border-faint")} />
        <span className={cx(!on && "text-faint")}>{LADDER}</span>
        <ICaret size={10} />
      </Chip>
      <Popover open={open} onClose={() => setOpen(false)} side="top" width={320}>
        <div className="flex flex-col gap-2.5 p-3" data-ladder-menu>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-base font-medium text-fg">{LADDER} on for this chat</div>
              <div className="mt-0.5 text-small leading-[17px] text-dim">{LADDER_LINE}</div>
            </div>
            <Switch label={`${LADDER} on for this chat`} on={on} onChange={(v) => setChatLadder(chat, { on: v })} />
          </div>
          {shown?.lead ? <div className="text-small text-dim" data-ladder-lead>Lead: <span className="text-fg">{shown.lead}</span></div> : null}
          {tiers.length ? (
            <TierBlock tiers={tiers} dim={!on} attr="own" />
          ) : unknown ? (
            <div className="border-t border-hairline pt-2.5 text-small text-dim" data-ladder-unknown>
              {!lead ? "This chat hasn’t said which model it runs yet" : `${chat.provider === "claude" ? "Claude Code" : "Codex"} hasn’t listed its models yet`}, so the tiers can’t be shown.
            </div>
          ) : (
            <div className="border-t border-hairline pt-2.5 text-small text-dim">No cheaper model in this CLI{cross.length ? `; ${other} lanes below` : ": the lead works alone, with the same checks"}.</div>
          )}
          {cross.length > 0 && (
            <>
              <div className="text-small text-faint">{other} lanes ({chat.provider === "claude" ? "codex exec" : "claude -p"})</div>
              <TierBlock tiers={cross} dim={!on} attr="cross" />
            </>
          )}
          {image && (
            <div className={cx("flex items-baseline gap-2 text-small", !on && "opacity-60")} data-ladder-image>
              <span className="w-[104px] shrink-0 whitespace-nowrap text-dim">Image</span>
              <span className="text-fg">{chat.provider === "claude" ? `GPT helper · ${image.label || image.model}` : "its own image tool"}</span>
            </div>
          )}
          <div className="border-t border-hairline pt-2.5">
            <LadderBudget reserve={own.reserve ?? prefs.reserve} compact />
          </div>
          {(tiers.length > 0 || cross.length > 0) && (
            <>
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 text-small text-dim">Highest helper tier</span>
                <Select<LadderCap>
                  label="Highest helper tier"
                  value={cap}
                  width={110}
                  options={[
                    { value: "mid", label: "Mid" },
                    { value: "small", label: "Small" },
                  ]}
                  onChange={(v) => setChatLadder(chat, { cap: v })}
                />
              </div>
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 text-small text-dim">Max parallel helpers</span>
                <Select<string>
                  label="Max parallel helpers"
                  value={String(par)}
                  width={110}
                  options={MAX_PARALLEL.map((n) => ({ value: String(n), label: String(n) }))}
                  onChange={(v) => setChatLadder(chat, { maxParallel: Number(v) })}
                />
              </div>
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 text-small text-dim">Helpers start helpers</span>
                <Select<string>
                  label="Helper nesting depth"
                  value={String(depth)}
                  width={110}
                  options={DEPTHS.map((n) => ({ value: String(n), label: n === 1 ? "No" : `${n} levels` }))}
                  onChange={(v) => setChatLadder(chat, { depth: Number(v) })}
                />
              </div>
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 text-small text-dim">Swarm mode for big jobs</span>
                <Switch label="Swarm mode for big jobs" on={swarm} onChange={(v) => setChatLadder(chat, { swarm: v })} />
              </div>
            </>
          )}
          {differs && <div className="text-small text-faint">Applies when this chat next starts or resumes.</div>}
          <button
            type="button"
            className="self-start text-small text-dim underline-offset-2 hover:text-fg hover:underline"
            onClick={() => {
              setOpen(false);
              openSettings("ladder");
            }}
          >
            Defaults in Settings
          </button>
        </div>
      </Popover>
    </div>
  );
}

/** Tier rows: roles that share a model fold into one row, with what each does. */
function TierBlock({ tiers, dim, attr }: { tiers: LadderTier[]; dim: boolean; attr: string }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-hairline pt-2.5" data-ladder-tiers={attr}>
      {tierRows(tiers).map((r) => (
        <div key={r.model} className={cx("flex flex-col", dim && "opacity-60")}>
          <div className="flex items-baseline gap-2 text-small">
            <span className="w-[104px] shrink-0 whitespace-nowrap text-dim">{rolesWord(r.roles)}</span>
            <span className="text-fg">{r.label}</span>
          </div>
          <div className="pl-[112px] text-small text-faint">{r.roles.map((x) => ROLE_LINE[x]).join("; ")}</div>
        </div>
      ))}
    </div>
  );
}
