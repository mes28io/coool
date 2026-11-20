// The onboarding's one Ladder row ("How should your agents work?"): the switch for new chats.

import { LADDER, setLadderPrefs, useLadderPrefs } from "../lib/ladder";
import { Switch } from "./settings/ui";

export function LadderOnboardingRow() {
  const p = useLadderPrefs();
  return (
    <div className="flex items-center gap-3 rounded-[12px] border border-line bg-panel px-3.5 py-2" data-ladder-onboarding={p.on ? "on" : "off"}>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-base text-fg">{LADDER}: cheaper models do the pieces</span>
        <span className="text-small text-dim">The chat’s model plans and checks; results are checked before they are reported.</span>
      </div>
      <Switch label={`${LADDER} for new chats`} on={p.on} onChange={(v) => setLadderPrefs({ on: v })} />
    </div>
  );
}
