// Settings > Ladder: the default for new chats, per CLI the delegate tier table, and how delegates work.

import { LADDER, LADDER_LINE, MAX_PARALLEL, defaultLead, setLadderCap, setLadderPick, setLadderPrefs, useLadderPrefs } from "../../lib/ladder";
import { candidates, modelRank, ROLE_WORK, ROLES, roleWord, tierTable, type LadderCap, type LadderRole } from "../../lib/ladderTiers";
import { useSeenModels } from "../../lib/prefs";
import type { Provider } from "../../lib/types";
import { ProviderMark } from "../primitives";
import { Group, Note, Row, Select, Switch, type Option } from "./ui";

const AUTO = "__auto__";
const NAME: Record<Provider, string> = { claude: "Claude Code", codex: "Codex" };

function ProviderRows({ provider }: { provider: Provider }) {
  const prefs = useLadderPrefs();
  const seen = useSeenModels()[provider];
  const lead = defaultLead(provider);
  const pick = prefs.pick[provider];
  const cap = prefs.cap[provider];
  const auto = tierTable(provider, lead, seen);
  const cands = candidates(provider, seen);
  const leadR = modelRank(provider, lead) ?? (provider === "claude" ? 4 : Math.max(0, ...cands.map((c) => c.rank)));
  const below = cands.filter((c) => c.rank < leadR);
  const name = NAME[provider];
  return (
    <Group
      label={
        <>
          <ProviderMark provider={provider} size={13} /> {name}
        </>
      }
      attr={`ladder-${provider}`}
    >
      {!below.length && !cands.length ? (
        <Row label="Tiers appear after a chat" k={`${LADDER} ${name} tiers`} desc={`The tiers come from the models ${name} reports when a chat starts.`} />
      ) : !below.length ? (
        <Row label="No cheaper model"k={`${LADDER} ${name} tiers`} desc="No model in this CLI is cheaper than the default one: the lead works alone, with the same checks." />
      ) : (
        <>
          {ROLES.map((r: LadderRole) => {
            const a = auto.find((t) => t.role === r);
            const options: Option<string>[] = [{ value: AUTO, label: `Automatic${a ? ` (${a.label})` : ""}` }, ...below.map((c) => ({ value: c.model, label: c.label }))];
            const cur = pick[r];
            return (
              <Row
                key={r}
                attr={`ladder-pick-${provider}-${r}`}
                label={`${roleWord(r)} tier`}
                desc={ROLE_WORK[r]}
                k={`${LADDER} ${name} delegate model tier`}
                control={<Select label={`${name} ${r} tier model`} value={cur && below.some((c) => c.model === cur) ? cur : AUTO} options={options} width={220} onChange={(v) => setLadderPick(provider, r, v === AUTO ? null : v)} />}
              />
            );
          })}
          <Row
            attr={`ladder-cap-${provider}`}
            label="Highest delegate tier"
            desc="Small gives the mid tier's work to the small tier's model."
            k={`${LADDER} ${name} cap`}
            control={
              <Select<LadderCap>
                label={`${name} highest delegate tier`}
                value={cap}
                width={220}
                options={[
                  { value: "mid", label: "Mid" },
                  { value: "small", label: "Small" },
                ]}
                onChange={(v) => setLadderCap(provider, v)}
              />
            }
          />
        </>
      )}
    </Group>
  );
}

export function LadderSettings() {
  const prefs = useLadderPrefs();
  return (
    <div data-ladder-settings>
      <Group label={LADDER}>
        <Row
          attr="ladder-on"
          label="On for new chats"
          desc={LADDER_LINE}
          k={`${LADDER} delegate cheaper models subagents`}
          control={<Switch label={`${LADDER} on for new chats`} on={prefs.on} onChange={(v) => setLadderPrefs({ on: v })} />}
        />
      </Group>
      {(["claude", "codex"] as Provider[]).map((p) => (
        <ProviderRows key={p} provider={p} />
      ))}
      <Group label="Delegates">
        <Row
          attr="ladder-parallel"
          label="Max parallel delegates"
          desc="How many delegates the chat may run at once."
          k={`${LADDER} parallel subagents`}
          control={<Select<string> label="Max parallel delegates" value={String(prefs.maxParallel)} options={MAX_PARALLEL.map((n) => ({ value: String(n), label: String(n) }))} width={110} onChange={(v) => setLadderPrefs({ maxParallel: Number(v) })} />}
        />
        <Row
          attr="ladder-verify"
          label="Delegates run the project’s tests before they report"
          k={`${LADDER} verify tests`}
          control={<Switch label="Delegates run the project's tests before they report" on={prefs.verifyTests} onChange={(v) => setLadderPrefs({ verifyTests: v })} />}
        />
        <div className="py-3.5" data-setting="ladder-note">
          <Note>Sent at launch as the CLI’s own per-chat instructions: about 520 tokens in a Claude Code chat (measured with its context report). Nothing in ~/.claude, ~/.codex or your project is changed. Chats you run in your own terminal are not changed.</Note>
        </div>
      </Group>
    </div>
  );
}
