// "How should your agents work?": what every new chat starts with, the same preferences as Settings > General > New
// chats (lib/prefs.ts: the CLI the New session sheet picks, and per CLI the model and permission mode `newChat` passes
// to `start_chat`), plus two switches from General > While agents run: Open coool at login (the login item,
// lib/systemPerms.ts) and Keep this Mac awake while agents work (`prevent_sleep`, the backend's power keeper).
// The CLIs shown are the ones the folder step found (`environment`). Only modes that still ask are offered here;
// bypass / never-ask stay in the composer and Settings with their warnings. Skip puts back what was there (keep.ts).

import { api, isMac } from "../../lib/backend";
import { chatDefaultsNow, defaultCliNow, loadAppPrefs, restoreChatDefaults, setChatDefault, setDefaultCli, updateAppPrefs, useAppPrefs, useChatDefaults, useDefaultCli, useSeenModels } from "../../lib/prefs";
import { START_MODES } from "../../lib/startModes";
import { loginBlocked as loginBlockedOf, loginOn as loginOnOf, loginText, useLoginItem } from "../../lib/systemPerms";
import type { Provider } from "../../lib/types";
import { PERMISSION_MODES } from "../ChatComposer";
import { Button, cx, ProviderMark, Segmented } from "../primitives";
import { DEFAULT, modelChoices } from "../settings/General";
import { Select, Switch, type Option } from "../settings/ui";
import { restoreStep, useRestorePoint } from "./keep";
import type { StepProps } from "./types";

const NAME: Record<Provider, string> = { claude: "Claude Code", codex: "Codex" };

/** Skip: the new-chat defaults, the keep-awake switch and the login item as they were when the step first showed. */
export const skipAgents = () => restoreStep("agents");

export function AgentsStep({ ctx }: StepProps) {
  const env = ctx.env;
  const found = (["claude", "codex"] as Provider[]).filter((p) => !!env?.[p]);
  // Until the backend answered, or with neither CLI on PATH, both (the choices apply once one is installed).
  const shown: Provider[] = found.length ? found : ["claude", "codex"];
  const cli = useDefaultCli();
  const [prefs] = useAppPrefs();
  const { login, on: loginOn, blocked, busy, err, set: setLogin } = useLoginItem();

  useRestorePoint("agents", () => {
    const was: { defaults: ReturnType<typeof chatDefaultsNow>; cli: Provider | null; awake: boolean | null; login: boolean | null } = { defaults: chatDefaultsNow(), cli: defaultCliNow(), awake: null, login: null };
    // Both switches stay disabled until these are read, so nothing can change before the snapshot has them.
    void loadAppPrefs().then((p) => (was.awake = p?.prevent_sleep ?? null));
    void api()
      .loginStatus()
      .then((l) => (was.login = loginOnOf(l)))
      .catch(() => {});
    return () => {
      if (JSON.stringify(chatDefaultsNow()) !== JSON.stringify(was.defaults)) restoreChatDefaults(was.defaults);
      if (defaultCliNow() !== was.cli) setDefaultCli(was.cli);
      void loadAppPrefs().then((p) => {
        if (p && was.awake !== null && p.prevent_sleep !== was.awake) void updateAppPrefs({ prevent_sleep: was.awake }).catch(() => {});
      });
      if (was.login !== null)
        void api()
          .loginStatus()
          .then((l) => {
            if (was.login !== null && loginOnOf(l) !== was.login && !loginBlockedOf(l)) return api().loginSet(was.login);
          })
          .catch(() => {});
    };
  });

  return (
    <div className="flex flex-col gap-4">
      {env && found.length === 2 ? (
        <div className="flex items-center gap-3 px-1" data-onb-cli-choice={cli ?? ""}>
          <span className="min-w-0 flex-1 text-base text-fg">Start new chats with</span>
          <Segmented<Provider>
            size="sm"
            value={cli ?? "claude"}
            onChange={setDefaultCli}
            options={(["claude", "codex"] as Provider[]).map((p) => ({
              value: p,
              label: (
                <>
                  <ProviderMark provider={p} size={13} /> {NAME[p]}
                </>
              ),
            }))}
          />
        </div>
      ) : (
        <p className="px-1 text-small text-dim" data-onb-cli-found={found.join(",")}>
          {!env ? "Looking for Claude Code and Codex…" : found.length === 1 ? `coool found ${NAME[found[0]]}, so new chats use it.` : "coool didn’t find Claude Code or Codex yet. These apply once you install one."}
        </p>
      )}

      <div className="flex flex-col rounded-[12px] border border-line bg-panel">
        {shown.map((p, k) => (
          <CliDefaults key={p} provider={p} first={k === 0} />
        ))}
      </div>

      <div className="flex flex-col rounded-[12px] border border-line bg-panel">
        <div className={cx("flex items-center gap-3 border-b border-hairline px-3.5 py-2", !isMac && "hidden")} data-onb-login={login?.status ?? ""}>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-base text-fg">Open coool at login</span>
            <span className="text-small text-dim">{login ? loginText(login, loginOn ? "On. It’s in System Settings > General > Login Items." : "Ready when you log in, watching every session.") : "…"}</span>
          </div>
          {login?.status === "requires_approval" && (
            <Button variant="ghost" className="h-[30px] px-2.5 text-small" onClick={() => void api().openSystemSettings("login").catch(() => {})}>
              Open Login Items
            </Button>
          )}
          <Switch label="Open coool at login" on={loginOn} disabled={blocked || busy} onChange={(v) => void setLogin(v)} />
        </div>
        <div className="flex items-center gap-3 px-3.5 py-2" data-onb-awake={prefs ? String(prefs.prevent_sleep) : ""}>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-base text-fg">Keep this Mac awake while agents work</span>
            <span className="text-small text-dim">Only mid-turn; the display can still turn off.</span>
          </div>
          <Switch label="Keep this Mac awake while agents work" on={!!prefs?.prevent_sleep} disabled={!prefs} onChange={(v) => void updateAppPrefs({ prevent_sleep: v }).catch(() => {})} />
        </div>
      </div>
      {err && <div className="px-1 text-small text-err-text">{err}</div>}
    </div>
  );
}

/** One CLI's model and permission mode for new chats (the same values as Settings > General > New chats). */
function CliDefaults({ provider, first }: { provider: Provider; first: boolean }) {
  const d = useChatDefaults()[provider];
  const seen = useSeenModels()[provider];
  const models = modelChoices(provider, seen, d.model);
  const modes: Option<string>[] = [
    { value: DEFAULT, label: "As the CLI is set up", hint: provider === "claude" ? "Claude Code’s own settings decide" : "~/.codex/config.toml decides" },
    ...START_MODES[provider].map((m) => ({ value: m.id, label: m.label, hint: provider === "claude" ? `--permission-mode ${m.cli}` : `approval policy: ${m.cli}` })),
  ];
  // A riskier mode chosen in Settings shows as it is (it is not offered here).
  if (d.mode && !modes.some((m) => m.value === d.mode)) {
    const m = PERMISSION_MODES[provider]?.find((x) => x.id === d.mode);
    modes.push({ value: d.mode, label: `${m?.label ?? d.mode} (chosen in Settings)`, hint: m?.description });
  }
  return (
    <div className={cx("flex flex-col py-1", !first && "border-t border-hairline")} data-onb-defaults={provider} data-model={d.model ?? ""} data-mode={d.mode ?? ""}>
      <div className="flex items-center gap-3 px-3.5 py-1.5">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-base font-medium text-fg">
          <ProviderMark provider={provider} size={14} />
          {NAME[provider]}
        </span>
        <span className="text-small text-faint">Model</span>
        <Select label={`${NAME[provider]} model for new chats`} value={d.model ?? DEFAULT} options={models} width={260} onChange={(v) => setChatDefault(provider, { model: v === DEFAULT ? null : v })} />
      </div>
      <div className="flex items-center gap-3 py-1.5 pl-[42px] pr-3.5">
        <span className="min-w-0 flex-1 truncate font-mono text-mono-small text-faint" title="The CLI’s own name for it">
          {d.mode ? (provider === "claude" ? `--permission-mode ${d.mode}` : `approval: ${d.mode}`) : ""}
        </span>
        <span className="shrink-0 text-small text-faint">Permissions</span>
        <Select label={`${NAME[provider]} permissions for new chats`} value={d.mode ?? DEFAULT} options={modes} width={320} onChange={(v) => setChatDefault(provider, { mode: v === DEFAULT ? null : v })} />
      </div>
    </div>
  );
}
