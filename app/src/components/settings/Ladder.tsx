// Settings > Ladder: the default for new chats, per CLI the helper tier table and its lanes to the other CLI, how
// helpers work (same-tier helpers, cross-provider lanes, images, nesting, swarm, coool's tools, the reserve), and the
// budget picture the lead plans with.

import { DEPTHS, LADDER, LADDER_LINE, MAX_PARALLEL, RESERVES, defaultLead, setLadderCap, setLadderPick, setLadderPrefs, useLadderPrefs, useLadderPreview } from "../../lib/ladder";
import { candidates, modelRank, ROLE_LINE, ROLE_WORK, ROLES, roleWord, rolesWord, tierRows, tierTable, type LadderCap, type LadderRole } from "../../lib/ladderTiers";
import { useSeenModels } from "../../lib/prefs";
import { LadderBudget } from "../LadderBudget";
import { CONTEXT_LABEL, CONTEXT_LINE, setContextPref, useContextPref } from "../../lib/agentContext";
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
  const preview = useLadderPreview(provider, lead, { on: true });
  const other = provider === "claude" ? "Codex" : "Claude";
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
      {preview && (preview.tiers.some((t) => t.role === "same") || preview.cross?.length || preview.image) ? (
        <Row
          attr={`ladder-lanes-${provider}`}
          label={`With ${lead ? (preview.lead || lead) : "the default model"} leading`}
          k={`${LADDER} ${name} lanes cross provider image same tier`}
          desc={[
            ...(preview.tiers.filter((t) => t.role === "same").map((t) => `Same: ${t.label} (parallel work only)`)),
            ...tierRows(preview.cross ?? []).map((r) => `${other} ${rolesWord(r.roles).toLowerCase()}: ${r.label} (${r.roles.map((x) => ROLE_LINE[x]).join("; ").toLowerCase()})`),
            ...(preview.image ? [provider === "claude" ? `Image: a GPT helper on ${preview.image.label || preview.image.model}` : "Image: its own image tool"] : []),
          ].join(" · ")}
        />
      ) : null}
    </Group>
  );
}

export function LadderSettings() {
  const prefs = useLadderPrefs();
  const context = useContextPref();
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
        <Row
          attr="context-on"
          label={CONTEXT_LABEL}
          desc={CONTEXT_LINE}
          k="coool context agents devices browser iphone mac pilot instructions"
          control={<Switch label={CONTEXT_LABEL} on={context} onChange={setContextPref} />}
        />
      </Group>
      {(["claude", "codex"] as Provider[]).map((p) => (
        <ProviderRows key={p} provider={p} />
      ))}
      <Group label="Helpers">
        <Row
          attr="ladder-parallel"
          label="Max parallel helpers"
          desc="How many helpers the chat may run at once. coool lowers it while the machine is busy or a usage window is past 80%."
          k={`${LADDER} parallel subagents helpers`}
          control={<Select<string> label="Max parallel helpers" value={String(prefs.maxParallel)} options={MAX_PARALLEL.map((n) => ({ value: String(n), label: String(n) }))} width={110} onChange={(v) => setLadderPrefs({ maxParallel: Number(v) })} />}
        />
        <Row
          attr="ladder-same"
          label="Helpers on the lead’s own model"
          desc="For medium-high pieces that can run in parallel; never above the lead."
          k={`${LADDER} same tier opus helpers`}
          control={<Switch label="Helpers on the lead's own model" on={prefs.same} onChange={(v) => setLadderPrefs({ same: v })} />}
        />
        <Row
          attr="ladder-cross"
          label="Use the other CLI too"
          desc="A Claude lead hands small self-contained parts, second opinions and bulk work to Codex (codex exec), and a Codex lead to Claude (claude -p), when it is installed and logged in."
          k={`${LADDER} cross provider codex exec claude gpt`}
          control={<Switch label="Use the other CLI too" on={prefs.cross} onChange={(v) => setLadderPrefs({ cross: v })} />}
        />
        <Row
          attr="ladder-image"
          label="Image generation"
          desc="Claude has no image model: images go to a GPT helper through Codex’s built-in image tool (your ChatGPT plan, no API key), after coool checks it is available."
          k={`${LADDER} image generation gpt codex icon`}
          control={<Switch label="Image generation" on={prefs.image} onChange={(v) => setLadderPrefs({ image: v })} />}
        />
        <Row
          attr="ladder-depth"
          label="Helpers start helpers"
          desc="How deep helpers may nest, so each context stays small on big jobs."
          k={`${LADDER} nested subagents depth`}
          control={<Select<string> label="Helper nesting depth" value={String(prefs.depth)} options={DEPTHS.map((n) => ({ value: String(n), label: n === 1 ? "No" : `${n} levels` }))} width={110} onChange={(v) => setLadderPrefs({ depth: Number(v) })} />}
        />
        <Row
          attr="ladder-swarm"
          label="Swarm mode for big jobs"
          desc="Three or more independent parts on separate files: split with file ownership, one worktree each, waves under the cap, each part checked as it lands, merged and tested once."
          k={`${LADDER} swarm big jobs worktrees waves`}
          control={<Switch label="Swarm mode for big jobs" on={prefs.swarm} onChange={(v) => setLadderPrefs({ swarm: v })} />}
        />
        <Row
          attr="ladder-verify"
          label="Helpers run the project’s tests before they report"
          k={`${LADDER} verify tests`}
          control={<Switch label="Helpers run the project's tests before they report" on={prefs.verifyTests} onChange={(v) => setLadderPrefs({ verifyTests: v })} />}
        />
      </Group>
      <Group label="Budget">
        <div className="py-3" data-setting="ladder-budget-now">
          <LadderBudget reserve={prefs.reserve} />
        </div>
        <Row
          attr="ladder-tools"
          label="coool’s planning tools"
          desc="The lead reads plans, usage, resets and load (budget), checks a lane before using it (can), and can start helpers as chats you see in the sidebar (spawn)."
          k={`${LADDER} budget tool spawn mcp`}
          control={<Switch label="coool's planning tools" on={prefs.tools} onChange={(v) => setLadderPrefs({ tools: v })} />}
        />
        <Row
          attr="ladder-reserve"
          label="Keep in reserve"
          desc="No new helper or lane starts on an account once a usage window has less than this left."
          k={`${LADDER} reserve usage limit`}
          control={<Select<string> label="Keep in reserve" value={String(prefs.reserve)} options={RESERVES.map((n) => ({ value: String(n), label: `${n}%` }))} width={110} onChange={(v) => setLadderPrefs({ reserve: Number(v) })} />}
        />
        <Row
          attr="ladder-bypass"
          label="Helpers may use Bypass"
          desc="Only for a chat already in Bypass. Off: its helpers run in Accept edits. Helpers never get wider permissions than their chat."
          k={`${LADDER} bypass permissions helpers`}
          control={<Switch label="Helpers may use Bypass" on={prefs.bypassHelpers} onChange={(v) => setLadderPrefs({ bypassHelpers: v })} />}
        />
        <div className="py-3.5" data-setting="ladder-note">
          <Note>Sent at launch as the CLI’s own per-chat instructions: about 1,050 tokens in a Claude Code chat with every lane on (measured with its context report; fewer with fewer lanes); the full playbook (about 3,500 tokens) loads only when the lead asks for it. Nothing in ~/.claude, ~/.codex or your project is changed. Chats you run in your own terminal are not changed.</Note>
        </div>
      </Group>
    </div>
  );
}
