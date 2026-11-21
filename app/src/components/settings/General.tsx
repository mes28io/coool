// Settings > General and Settings > Notifications.

import { useEffect, useState } from "react";
import { api } from "../../lib/backend";
import { setChatDefault, setDefaultCli, updateAppPrefs, useAppPrefs, useChatDefaults, useDefaultCli, useInstalledApps, useSeenModels } from "../../lib/prefs";
import type { MenuBarMode, NotifySounds, PowerStatus } from "../../lib/settingsTypes";
import { loginText, notifyText, useLoginItem, useNotifyPermission } from "../../lib/systemPerms";
import type { Provider } from "../../lib/types";
import { useStore } from "../../store";
import { PERMISSION_MODES } from "../ChatComposer";
import { IAlert, ICheck, IPlay } from "../icons";
import { BUILD_KINDS } from "../onboarding/BuildStep";
import { Button, cx, ProviderMark } from "../primitives";
import { LidAwakeRow } from "./LidAwake";
import { UpdatesGroup } from "./Updates";
import { ErrorLine, errText, Group, Note, Row, Select, Switch, type Option } from "./ui";

/** The "CLI default" choice in a Select (stored as null). */
export const DEFAULT = "__default__";

/** Claude Code's `--model` aliases always work; the rest are what chats reported. */
const CLAUDE_ALIASES: Option<string>[] = [
  { value: "opus", label: "Opus (latest)", hint: "--model opus" },
  { value: "sonnet", label: "Sonnet (latest)", hint: "--model sonnet" },
  { value: "haiku", label: "Haiku (latest)", hint: "--model haiku" },
];

/**
 * The models a new chat can start on (Settings > General and the onboarding): the CLI's own default, Claude Code's
 * aliases, then what chats reported (`ready.models`), plus the current choice if it is none of those.
 */
export function modelChoices(provider: Provider, seen: { id: string; label: string }[], current: string | null): Option<string>[] {
  const models: Option<string>[] = [
    { value: DEFAULT, label: "CLI default", hint: provider === "claude" ? "Whatever claude picks (your /model choice)" : "What ~/.codex/config.toml says" },
    ...(provider === "claude" ? CLAUDE_ALIASES : []),
    ...seen.filter((m) => !CLAUDE_ALIASES.some((a) => a.value === m.id)).map((m) => ({ value: m.id, label: m.label, hint: m.id })),
  ];
  if (current && !models.some((m) => m.value === current)) models.push({ value: current, label: current });
  return models;
}

function ChatDefaultsRows({ provider }: { provider: Provider }) {
  const d = useChatDefaults()[provider];
  const seen = useSeenModels()[provider];
  const name = provider === "claude" ? "Claude Code" : "Codex";
  const models = modelChoices(provider, seen, d.model);
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
  const defaultCli = useDefaultCli();
  const apps = useInstalledApps();
  const showAutomation = useStore((s) => s.showAutomation);
  const setShowAutomation = useStore((s) => s.setShowAutomation);
  const hiddenAutomation = useStore((s) => s.hiddenAutomation);
  const [err, setErr] = useState<string | null>(null);
  const power = usePower(!!prefs?.prevent_sleep);
  const { login, on: loginOn, blocked: loginBlocked, set: setLoginItem, err: loginErr } = useLoginItem();
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
      : power?.covered
        ? "Keeping this Mac awake now through “Keep working with the lid closed” (it covers this too)."
        : power?.held
        ? `Keeping this Mac awake now: ${power.working === 1 ? "1 agent is" : `${power.working} agents are`} working.`
        : "Not holding anything now: no agent is working.";

  return (
    <>
      <Group label="New chats" footer="Applies to chats you start from now on. A resumed session keeps the model and mode it had.">
        <Row
          attr="default-cli"
          label="Start new sessions with"
          k="default cli agent provider claude code codex new session"
          desc="The agent the New session sheet picks first. Not chosen: the agent the folder last used, else Claude Code."
          control={
            <Select<"auto" | Provider>
              label="Start new sessions with"
              value={defaultCli ?? "auto"}
              width={260}
              options={[
                { value: "auto", label: "Not chosen", hint: "The folder’s last agent, else Claude Code" },
                { value: "claude", label: "Claude Code" },
                { value: "codex", label: "Codex" },
              ]}
              onChange={(v) => setDefaultCli(v === "auto" ? null : v)}
            />
          }
        />
        <ChatDefaultsRows provider="claude" />
        <ChatDefaultsRows provider="codex" />
      </Group>

      <Group label="Your work" footer="Asked in the onboarding. Changing it installs nothing: the iPhone and the sandbox Mac are set up from their panels.">
        <Row attr="building" label="I’m building" k="building mobile ios web desktop mac backend cli onboarding devices" desc="Pick any that apply.">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="I’m building">
            {BUILD_KINDS.map((b) => {
              const on = !!prefs?.building?.includes(b.id);
              return (
                <button
                  key={b.id}
                  type="button"
                  aria-pressed={on}
                  disabled={off}
                  data-building={b.id}
                  onClick={() => save({ building: on ? (prefs?.building ?? []).filter((x) => x !== b.id) : [...(prefs?.building ?? []), b.id] })}
                  className={cx(
                    "h-[28px] rounded-[8px] border px-2.5 text-small transition-colors duration-150 disabled:opacity-50",
                    on ? "border-[color-mix(in_oklab,var(--text)_38%,var(--border))] bg-raised shadow-[0_1px_2px_rgb(0_0_0/0.10)] text-fg" : "border-line text-dim hover:bg-hover hover:text-fg",
                  )}
                >
                  {b.label}
                </button>
              );
            })}
          </div>
        </Row>
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
          attr="keep-chats"
          label="Keep chats running when coool quits"
          desc={
            prefs?.keep_chats === false
              ? "Off: quitting, or restarting for an update, stops every chat. Their transcripts stay, so you can resume them."
              : "Chats keep working while coool is closed, restarting or updating, and are right where they were when it opens again. Terminal sessions still stop."
          }
          k="quit restart update background host keep alive survive chats running"
          control={<Switch label="Keep chats running when coool quits" on={prefs?.keep_chats !== false} disabled={off} onChange={(v) => save({ keep_chats: v })} />}
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
              <div className="flex items-center gap-2 text-small text-dim" data-power-state={power?.held ? "held" : power?.covered ? "covered" : "idle"}>
                {power?.held || power?.covered ? <ICheck size={14} className="shrink-0 text-accent-text" /> : <span className="size-[6px] shrink-0 rounded-full bg-faint/60" />}
                {powerLine}
              </div>
              {!prefs?.lid?.enabled && <Note>Closing the lid still puts the Mac to sleep (unless an external display is connected and it’s on power). “Keep working with the lid closed” below handles that.</Note>}
            </div>
          )}
        </Row>
        <LidAwakeRow />
        <Row
          attr="login"
          label="Open coool at login"
          desc={loginText(login)}
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
                disabled={loginBlocked}
                onChange={(v) => {
                  setErr(null);
                  void setLoginItem(v);
                }}
              />
            </>
          }
        />
      </Group>

      <Group label="Menu bar" footer="Its menu shows CPU, memory, disk, network, heat and battery, the busiest processes (agents named by session), the sessions that need you and plan usage. It goes away when coool quits.">
        <Row
          attr="menubar-show"
          label="Show coool in the menu bar"
          k="menu bar status item cpu memory disk tray extension"
          desc="An item at the top right of the screen, while coool is open."
          control={<Switch label="Show coool in the menu bar" on={prefs?.menubar?.show ?? true} disabled={off || !prefs?.menubar} onChange={(v) => save({ menubar: { mode: prefs?.menubar?.mode ?? "cpu", show: v } })} />}
        />
        <Row
          attr="menubar-mode"
          label="Next to the icon"
          k="menu bar cpu memory needs you reading"
          desc="What the item shows beside its icon. A dot appears whenever a session needs you."
          control={
            <Select<MenuBarMode>
              label="Next to the icon"
              value={prefs?.menubar?.mode ?? "cpu"}
              width={220}
              disabled={off || !prefs?.menubar?.show}
              options={[
                { value: "nothing", label: "Nothing", hint: "The icon alone" },
                { value: "cpu", label: "CPU", hint: "All cores together, like Activity Monitor" },
                { value: "cpu_memory", label: "CPU, memory and disk", hint: "Memory used of the total, and free disk space" },
                { value: "needs", label: "Sessions needing you", hint: "How many, when any do" },
              ]}
              onChange={(v) => save({ menubar: { show: prefs?.menubar?.show ?? true, mode: v } })}
            />
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
      <UpdatesGroup />
      {unavailable && <p className="px-1 pt-3 text-small text-faint">This build of coool can’t save these options yet.</p>}
      <div className="px-1 pt-2">
        <ErrorLine>{err ?? loginErr}</ErrorLine>
      </div>
    </>
  );
}

// ---------- Notifications ----------

/** coool's own sounds (app/scripts/sounds/make-sounds.py): what each sounds like. */
const COOOL_SOUND_TEXT: Record<string, [string, string]> = {
  rise: ["Rise", "A soft two-note rise"],
  tap: ["Tap", "One low tap"],
  glass: ["Glass", "A glassy ping"],
  knock: ["Knock", "A wooden knock"],
  marimba: ["Marimba", "A soft marimba note"],
  chirp: ["Chirp", "A tiny synth chirp"],
  ticks: ["Ticks", "A subtle double tick"],
};

let soundsCache: Promise<NotifySounds> | null = null;
function useSounds(): NotifySounds | null {
  const [s, setS] = useState<NotifySounds | null>(null);
  useEffect(() => {
    let live = true;
    soundsCache ??= api()
      .notifySounds()
      .catch(() => ({ coool: Object.keys(COOOL_SOUND_TEXT), system: [], bundled: false }));
    void soundsCache.then((v) => live && setS(v));
    return () => {
      live = false;
    };
  }, []);
  return s;
}

/**
 * One kind's sound: a preview button and a picker (None, coool's sounds, the system's alert sounds), with the preview's
 * message under it. Settings > Notifications' rows and the onboarding's Notifications step both use it.
 */
export function SoundPicker({ attr, label, value, onChange, width = 260 }: { attr: string; label: string; value: string; onChange: (v: string) => void; width?: number }) {
  const sounds = useSounds();
  const [msg, setMsg] = useState<string | null>(null);
  const opts: Option<string>[] = [
    { value: "none", label: "None" },
    ...(sounds?.coool ?? Object.keys(COOOL_SOUND_TEXT)).map((id) => ({ value: `coool:${id}`, label: COOOL_SOUND_TEXT[id]?.[0] ?? id, hint: `coool · ${COOOL_SOUND_TEXT[id]?.[1] ?? ""}` })),
    ...(sounds?.system ?? []).map((id) => ({ value: `system:${id}`, label: `System: ${id}`, hint: "macOS alert sound" })),
  ];
  if (!opts.some((o) => o.value === value)) opts.push({ value, label: value });
  const preview = () => {
    setMsg(null);
    api()
      .notifySoundPreview(value)
      .then((r) => r === "muted" && setMsg("Muted during a self-test."))
      .catch((e) => setMsg(errText(e)));
  };
  return (
    <span className="flex flex-col items-end gap-1">
      <span className="flex items-center gap-1.5">
        <Button variant="ghost" className="h-[30px] w-[30px] px-0" disabled={value === "none"} onClick={preview} aria-label={`Play ${label.toLowerCase()}`} title="Play it" data-sound-preview={attr}>
          <IPlay size={13} />
        </Button>
        <Select label={label} value={value} options={opts} width={width} onChange={onChange} />
      </span>
      {msg && <span className="text-small text-dim">{msg}</span>}
    </span>
  );
}

/** One kind's sound as a Settings row. */
function SoundRow({ attr, label, value, onChange }: { attr: string; label: string; value: string; onChange: (v: string) => void }) {
  const sounds = useSounds();
  return (
    <Row
      attr={attr}
      label={label}
      desc={sounds && !sounds.bundled ? "This build has no app bundle, so macOS shows no notifications; the sound still plays here." : undefined}
      k="sound sounds chime tone preview play"
      control={<SoundPicker attr={attr} label={label} value={value} onChange={onChange} />}
    />
  );
}

export function Notifications() {
  const [prefs] = useAppPrefs();
  // Read again when the window regains focus (coming back from System Settings).
  const { perm, busy, err: askErr, ask: askPerm, allowed } = useNotifyPermission();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const n = prefs?.notify;
  const set = (patch: Partial<NonNullable<typeof n>>) => n && void updateAppPrefs({ notify: { ...n, ...patch } }).catch((e) => setMsg({ ok: false, text: errText(e) }));
  const ask = () => {
    setMsg(null);
    return askPerm();
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
              {perm ? notifyText(perm) : "…"}
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
          {!msg && askErr && <div className="text-small text-err-text">{askErr}</div>}
        </Row>
      </Group>
      <Group label="Notify me when an agent">
        <Row attr="notify-needs" label="Needs you" desc="Asks for permission or has a question for you." k="permission question blocked" control={<Switch label="Needs you" on={!!n?.needs_you} disabled={off} onChange={(v) => set({ needs_you: v })} />} />
        <Row attr="notify-finished" label="Finishes a turn" desc="Ends its turn and waits for your next message." k="done complete" control={<Switch label="Finishes a turn" on={!!n?.finished} disabled={off} onChange={(v) => set({ finished: v })} />} />
        <Row attr="notify-failed" label="Fails" desc="A turn ends in an error, or the CLI exits with one. Not when you stopped it." k="error crash" control={<Switch label="Fails" on={!!n?.failed} disabled={off} onChange={(v) => set({ failed: v })} />} />
      </Group>
      <Group label="How" footer={!allowed && perm ? "These apply once macOS allows coool’s notifications." : undefined}>
        <Row attr="notify-sound" label="Play a sound" desc={n?.custom_sounds ? "The sound chosen for each kind below." : "The system notification sound."} k="sound audio" control={<Switch label="Play a sound" on={!!n?.sound} disabled={off} onChange={(v) => set({ sound: v })} />} />
        <Row
          attr="notify-custom-sounds"
          label="A different sound for each"
          desc="Tell a request from a finished turn without looking. Plays in coool too while it’s in front."
          k="sound sounds custom chime tone different per kind"
          control={<Switch label="A different sound for each" on={!!n?.custom_sounds} disabled={off || !n?.sound} onChange={(v) => set({ custom_sounds: v })} />}
        />
        {n?.sound && n.custom_sounds && (
          <>
            <SoundRow attr="notify-sound-needs" label="Needs you sound" value={n.sound_needs} onChange={(v) => set({ sound_needs: v })} />
            <SoundRow attr="notify-sound-finished" label="Finished sound" value={n.sound_finished} onChange={(v) => set({ sound_finished: v })} />
            <SoundRow attr="notify-sound-failed" label="Failed sound" value={n.sound_failed} onChange={(v) => set({ sound_failed: v })} />
          </>
        )}
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
