// Settings > General and Settings > Notifications.

import { useEffect, useState } from "react";
import { api } from "../../lib/backend";
import { setChatDefault, updateAppPrefs, useAppPrefs, useChatDefaults, useInstalledApps, useSeenModels } from "../../lib/prefs";
import type { LoginStatus, NotifyPermission, PowerStatus } from "../../lib/settingsTypes";
import type { Provider } from "../../lib/types";
import { useStore } from "../../store";
import { PERMISSION_MODES } from "../ChatComposer";
import { IAlert, ICheck } from "../icons";
import { Button, ProviderMark } from "../primitives";
import { ErrorLine, errText, Group, Note, Row, Select, Switch, type Option } from "./ui";

const DEFAULT = "__default__";

/** Claude Code's `--model` aliases always work; the rest are what chats reported. */
const CLAUDE_ALIASES: Option<string>[] = [
  { value: "opus", label: "Opus (latest)", hint: "--model opus" },
  { value: "sonnet", label: "Sonnet (latest)", hint: "--model sonnet" },
  { value: "haiku", label: "Haiku (latest)", hint: "--model haiku" },
];

function ChatDefaultsRows({ provider }: { provider: Provider }) {
  const d = useChatDefaults()[provider];
  const seen = useSeenModels()[provider];
  const name = provider === "claude" ? "Claude Code" : "Codex";
  const models: Option<string>[] = [
    { value: DEFAULT, label: "CLI default", hint: provider === "claude" ? "Whatever claude picks (your /model choice)" : "What ~/.codex/config.toml says" },
    ...(provider === "claude" ? CLAUDE_ALIASES : []),
    ...seen.filter((m) => !CLAUDE_ALIASES.some((a) => a.value === m.id)).map((m) => ({ value: m.id, label: m.label, hint: m.id })),
  ];
  if (d.model && !models.some((m) => m.value === d.model)) models.push({ value: d.model, label: d.model });
  const modes: Option<string>[] = [{ value: DEFAULT, label: "CLI default", hint: "The CLI's own setting" }, ...(PERMISSION_MODES[provider] ?? []).map((m) => ({ value: m.id, label: m.label, hint: m.description }))];
  return (
    <>
      <Row
        attr={`default-model-${provider}`}
        label={
          <span className="flex items-center gap-2">
            <ProviderMark provider={provider} /> {name} model
          </span>
        }
        k={`${name} default model new chat`}
        desc={seen.length || provider === "claude" ? "The model a new chat starts on. You can still switch in the chat." : "The model a new chat starts on. More choices appear after a Codex chat runs."}
        control={<Select label={`${name} default model`} value={d.model ?? DEFAULT} options={models} width={260} onChange={(v) => setChatDefault(provider, { model: v === DEFAULT ? null : v })} />}
      />
      <Row
        attr={`default-mode-${provider}`}
        label={
          <span className="flex items-center gap-2">
            <ProviderMark provider={provider} /> {name} {provider === "claude" ? "permission mode" : "approvals"}
          </span>
        }
        k={`${name} default permission mode approvals new chat`}
        desc={provider === "claude" ? "What a new chat may do without asking." : "When a new Codex chat asks before running something."}
        control={<Select label={`${name} default permission mode`} value={d.mode ?? DEFAULT} options={modes} width={260} onChange={(v) => setChatDefault(provider, { mode: v === DEFAULT ? null : v })} />}
      />
    </>
  );
}

function usePower(on: boolean) {
  const [p, setP] = useState<PowerStatus | null>(null);
  useEffect(() => {
    let live = true;
    const tick = () =>
      api()
        .powerStatus()
        .then((v) => live && setP(v))
        .catch(() => {});
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [on]);
  return p;
}

export function General() {
  const [prefs, , unavailable] = useAppPrefs();
  const apps = useInstalledApps();
  const showAutomation = useStore((s) => s.showAutomation);
  const setShowAutomation = useStore((s) => s.setShowAutomation);
  const hiddenAutomation = useStore((s) => s.hiddenAutomation);
  const [err, setErr] = useState<string | null>(null);
  const power = usePower(!!prefs?.prevent_sleep);
  const [login, setLogin] = useState<LoginStatus | null>(null);
  useEffect(() => {
    api()
      .loginStatus()
      .then(setLogin)
      .catch(() => setLogin({ status: "unavailable", reason: "Not in this build of coool." }));
  }, []);
  const save = (patch: Parameters<typeof updateAppPrefs>[0]) => {
    setErr(null);
    void updateAppPrefs(patch).catch((e) => setErr(errText(e)));
  };
  const off = !prefs;
  const openOpts: Option<string>[] = [{ value: "system", label: "System default", hint: "Finder for folders, each file's own app" }, ...(apps ?? []).map((a) => ({ value: a.id, label: a.name, hint: a.path }))];
  const powerLine = !prefs?.prevent_sleep
    ? null
    : power?.failed
      ? "macOS refused to keep the Mac awake."
      : power?.held
        ? `Keeping this Mac awake now: ${power.working === 1 ? "1 agent is" : `${power.working} agents are`} working.`
        : "Not holding anything now: no agent is working.";
  const loginOn = login?.status === "enabled" || login?.status === "requires_approval";

  return (
    <>
      <Group label="New chats" footer="Applies to chats you start from now on. A resumed session keeps the model and mode it had.">
        <ChatDefaultsRows provider="claude" />
        <ChatDefaultsRows provider="codex" />
      </Group>

      <Group label="Files and folders">
        <Row
          attr="open-with"
          label="Open files and folders in"
          desc={apps && apps.length === 0 ? "No editor found in Applications; System default it is." : "Used by “Open … in …” in the ⌘K palette and Connections’ “Open file”."}
          k="editor vs code cursor xcode zed finder app"
          control={<Select label="Open files and folders in" value={prefs?.open_with ?? "system"} options={openOpts} width={280} disabled={off} onChange={(v) => save({ open_with: v })} />}
        />
      </Group>

      <Group label="While agents run">
        <Row
          attr="confirm-quit"
          label="Confirm before quitting"
          desc="Ask before ⌘Q or closing the window stops chats and terminals that are still running."
          k="quit close exit"
          control={<Switch label="Confirm before quitting" on={!!prefs?.confirm_quit} disabled={off} onChange={(v) => save({ confirm_quit: v })} />}
        />
        <Row
          attr="prevent-sleep"
          label="Prevent sleep while agents are working"
          desc="Keeps the Mac awake only while a chat or terminal session is mid-turn, then lets it sleep again. The display can still turn off."
          k="sleep awake caffeinate power battery lid"
          control={<Switch label="Prevent sleep while agents are working" on={!!prefs?.prevent_sleep} disabled={off} onChange={(v) => save({ prevent_sleep: v })} />}
        >
          {prefs?.prevent_sleep && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-small text-dim" data-power-state={power?.held ? "held" : "idle"}>
                {power?.held ? <ICheck size={14} className="shrink-0 text-accent-text" /> : <span className="size-[6px] shrink-0 rounded-full bg-faint/60" />}
                {powerLine}
              </div>
              <Note>On battery, closing the lid still puts the Mac to sleep; macOS doesn’t let an app stop that.</Note>
            </div>
          )}
        </Row>
        <Row
          attr="login"
          label="Open coool at login"
          desc={
            login?.status === "requires_approval"
              ? "macOS is waiting for you to allow it in System Settings > General > Login Items."
              : login?.status === "unavailable"
                ? (login.reason ?? "Not available in this build.")
                : "Starts coool when you log in to this Mac. Listed in System Settings > General > Login Items."
          }
          k="startup launch login items"
          control={
            <>
              {login?.status === "requires_approval" && (
                <Button variant="ghost" className="h-[30px] px-2.5 text-small" onClick={() => void api().openSystemSettings("login")}>
                  Open Login Items
                </Button>
              )}
              <Switch
                label="Open coool at login"
                on={loginOn}
                disabled={!login || login.status === "unavailable" || login.status === "not_found"}
                onChange={(v) => {
                  setErr(null);
                  void api()
                    .loginSet(v)
                    .then(setLogin)
                    .catch((e) => setErr(errText(e)));
                }}
              />
            </>
          }
        />
      </Group>

      <Group label="Sessions">
        <Row
          attr="show-automation"
          label="Show runs started by other tools"
          k="automation claude -p sdk codex exec hidden"
          desc={
            <>
              Sessions that apps and agents launched programmatically (<span className="font-mono text-mono-small">claude -p</span>, the Agent SDK, <span className="font-mono text-mono-small">codex exec</span>). Off, only sessions you started are
              listed.
              {!showAutomation && hiddenAutomation > 0 && <span className="text-faint"> {hiddenAutomation} hidden right now.</span>}
            </>
          }
          control={<Switch label="Show runs started by other tools" on={showAutomation} onChange={setShowAutomation} />}
        />
      </Group>
      {unavailable && <p className="px-1 pt-3 text-small text-faint">This build of coool can’t save these options yet.</p>}
      <div className="px-1 pt-2">
        <ErrorLine>{err}</ErrorLine>
      </div>
    </>
  );
}

// ---------- Notifications ----------

const PERM_TEXT: Record<NotifyPermission["status"], string> = {
  authorized: "Allowed. macOS shows coool’s notifications.",
  provisional: "Delivered quietly to Notification Center.",
  denied: "Turned off for coool in System Settings.",
  not_determined: "macOS hasn’t asked yet. Allow once and coool can notify you.",
  unavailable: "Not available.",
};

export function Notifications() {
  const [prefs] = useAppPrefs();
  const [perm, setPerm] = useState<NotifyPermission | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const read = () =>
      api()
        .notifyPermission()
        .then(setPerm)
        .catch(() => setPerm({ status: "unavailable", reason: "Not in this build of coool." }));
    read();
    // Coming back from System Settings: read it again.
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, []);
  const n = prefs?.notify;
  const set = (patch: Partial<NonNullable<typeof n>>) => n && void updateAppPrefs({ notify: { ...n, ...patch } }).catch((e) => setMsg({ ok: false, text: errText(e) }));
  const allowed = perm?.status === "authorized" || perm?.status === "provisional";
  const ask = async () => {
    setBusy(true);
    setMsg(null);
    try {
      setPerm(await api().notifyRequest());
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
    setBusy(false);
  };
  const test = async () => {
    setMsg(null);
    try {
      await api().notifyTest();
      setMsg({ ok: true, text: "Sent. It should be in the top right corner now." });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  };
  const off = !n;
  return (
    <>
      <Group>
        <Row
          attr="notify-permission"
          label="macOS permission"
          k="allow notifications system settings"
          desc={
            <span className="flex items-center gap-1.5" data-notify-permission={perm?.status ?? ""}>
              {allowed ? <ICheck size={13} className="shrink-0 text-accent-text" /> : perm?.status === "denied" ? <IAlert size={13} className="shrink-0 text-busy-text" /> : null}
              {perm ? (perm.status === "unavailable" ? (perm.reason ?? PERM_TEXT.unavailable) : PERM_TEXT[perm.status]) : "…"}
            </span>
          }
          control={
            perm?.status === "not_determined" ? (
              <Button variant="primary" className="h-[30px] px-3 text-small" disabled={busy} onClick={() => void ask()}>
                {busy ? "Asking…" : "Allow notifications"}
              </Button>
            ) : perm?.status === "denied" ? (
              <Button variant="outline" className="h-[30px] px-2.5 text-small" onClick={() => void api().openSystemSettings("notifications")}>
                Open System Settings
              </Button>
            ) : allowed ? (
              <Button variant="outline" className="h-[30px] px-2.5 text-small" onClick={() => void test()}>
                Send a test
              </Button>
            ) : null
          }
        >
          {msg && <div className={msg.ok ? "text-small text-dim" : "text-small text-err-text"}>{msg.text}</div>}
        </Row>
      </Group>
      <Group label="Notify me when an agent">
        <Row attr="notify-needs" label="Needs you" desc="Asks for permission or has a question for you." k="permission question blocked" control={<Switch label="Needs you" on={!!n?.needs_you} disabled={off} onChange={(v) => set({ needs_you: v })} />} />
        <Row attr="notify-finished" label="Finishes a turn" desc="Ends its turn and waits for your next message." k="done complete" control={<Switch label="Finishes a turn" on={!!n?.finished} disabled={off} onChange={(v) => set({ finished: v })} />} />
        <Row attr="notify-failed" label="Fails" desc="A turn ends in an error, or the CLI exits with one. Not when you stopped it." k="error crash" control={<Switch label="Fails" on={!!n?.failed} disabled={off} onChange={(v) => set({ failed: v })} />} />
      </Group>
      <Group label="How" footer={!allowed && perm ? "These apply once macOS allows coool’s notifications." : undefined}>
        <Row attr="notify-sound" label="Play a sound" desc="The system notification sound." k="sound audio" control={<Switch label="Play a sound" on={!!n?.sound} disabled={off} onChange={(v) => set({ sound: v })} />} />
        <Row
          attr="notify-unfocused"
          label="Only when coool isn’t in front"
          desc="Stay quiet while you’re looking at coool."
          k="focus focused background"
          control={<Switch label="Only when coool isn’t in front" on={!!n?.only_unfocused} disabled={off} onChange={(v) => set({ only_unfocused: v })} />}
        />
      </Group>
    </>
  );
}
