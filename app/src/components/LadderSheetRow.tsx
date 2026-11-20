// New session sheet: whether Ladder is on for the chat about to start, with its tiers, and a switch for this chat only.

import { useState } from "react";
import { LADDER, ladderOn, useLadderPrefs, useLadderPreview, defaultLead, type ChatLadder } from "../lib/ladder";
import { tierRows } from "../lib/ladderTiers";
import type { Provider } from "../lib/types";
import { Switch } from "./settings/ui";

export function useSheetLadder(provider: Provider) {
  const [on, setOn] = useState<boolean | null>(null);
  const prefs = useLadderPrefs();
  const own: ChatLadder | undefined = on === null ? undefined : { on };
  const lead = defaultLead(provider);
  const preview = useLadderPreview(provider, lead, { ...own, on: true });
  return { on: ladderOn(own, prefs), setOn, tiers: preview?.tiers ?? [], choice: own };
}

export function LadderSheetRow({ l }: { l: ReturnType<typeof useSheetLadder> }) {
  const summary = l.tiers.length ? tierRows(l.tiers).map((r) => r.label).join(" · ") : "the lead works alone";
  return (
    <div className="flex items-center gap-3 px-0.5" data-ladder-sheet={l.on ? "on" : "off"}>
      <span className="min-w-0 flex-1 truncate text-small text-dim">
        <span className="text-fg/80">{LADDER}</span> {l.on ? `on: ${summary}` : "off for this chat"}
      </span>
      <Switch label={`${LADDER} for this chat`} on={l.on} onChange={(v) => l.setOn(v)} />
    </div>
  );
}
