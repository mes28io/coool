import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { newChat } from "../lib/actions";
import { api, isNotAvailable } from "../lib/backend";
import { folderName, homeShort, projectOf } from "../lib/format";
import { estimateSize } from "../lib/termlite";
import type { InsightsStatus, Provider } from "../lib/types";
import { useStore, type Sheet, type ThemePref } from "../store";
import { IAlert, ICheck, IFolder, IGear, ISpark, ITerminal } from "./icons";
import { Button, cx, Kbd, ProviderMark, Segmented } from "./primitives";

export function Sheets() {
  const sheet = useStore((s) => s.sheet);
  const setSheet = useStore((s) => s.setSheet);
  const close = () => setSheet(null);
  return (
    <AnimatePresence>
      {sheet && (
        <motion.div
          key={sheet.kind}
          className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.14 } }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-[var(--backdrop)] backdrop-blur-[2px]" onMouseDown={close} />
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.99, transition: { duration: 0.14 } }}
            transition={{ type: "spring", stiffness: 460, damping: 36 }}
            className="relative w-[480px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[18px] border border-line bg-raised shadow-pop"
            onKeyDown={(e) => e.key === "Escape" && close()}
          >
            <SheetBody sheet={sheet} close={close} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SheetBody({ sheet, close }: { sheet: NonNullable<Sheet>; close: () => void }) {
  if (sheet.kind === "new") return <NewSession initialCwd={sheet.cwd} initialProvider={sheet.provider} close={close} />;
  if (sheet.kind === "quit") return <QuitConfirm running={sheet.running} close={close} />;
  if (sheet.kind === "settings") return <Settings close={close} />;
  return <StopConfirm label={sheet.label} managed={sheet.managed} pid={sheet.pid} chat={sheet.chat ?? null} close={close} />;
}

function Field({ label, children, aside }: { label: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-small font-medium text-dim">{label}</span>
        {aside}
      </div>
      {children}
    </div>
  );
}

const inputCls =
  "w-full rounded-[10px] border border-line bg-bg px-3 text-base outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-faint focus:border-[color-mix(in_oklab,var(--accent)_50%,var(--border))] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_12%,transparent)]";

function NewSession({ initialCwd, initialProvider, close }: { initialCwd?: string; initialProvider?: Provider; close: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const env = useStore((s) => s.env);
  const toast = useStore((s) => s.toast);
  const recents = useMemo(() => {
    const seen: string[] = [];
    for (const s of sessions) if (projectOf(s) && !seen.includes(projectOf(s))) seen.push(projectOf(s));
    return seen.slice(0, 6);
  }, [sessions]);
  const [provider, setProvider] = useState<Provider>(initialProvider ?? sessions.find((s) => projectOf(s) === initialCwd)?.provider ?? "claude");
  const [cwd, setCwd] = useState(initialCwd ? homeShort(initialCwd) : recents[0] ? homeShort(recents[0]) : "");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const missing = env ? !env[provider] : false;

  const expand = (p: string) => (p.startsWith("~") && env?.home ? env.home + p.slice(1) : p);
  const launch = async () => {
    if (!cwd.trim() || busy) return;
    setBusy(true);
    try {
      if (terminal) {
        const { rows, cols } = estimateSize();
        const args = prompt.trim() ? [prompt.trim()] : [];
        const id = await api().spawnSession({ provider, cwd: expand(cwd.trim()), args, rows, cols });
        const st = useStore.getState();
        st.setMode({ kind: "pty", id }, "terminal");
        st.open({ kind: "pty", id });
      } else await newChat({ provider, cwd: expand(cwd.trim()), prompt });
      close();
    } catch (e) {
      toast(String(e), "error");
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        launch();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          launch();
        }
      }}
    >
      <div className="px-4 pb-3 pt-4">
        <div className="text-title font-semibold tracking-[-0.01em]">New session</div>
        <div className="mt-0.5 text-base text-dim">Runs the official CLI as a chat coool drives. Your own login, your own subscription.</div>
      </div>
      <div className="flex flex-col gap-4 px-4 pb-4">
        <Field label="Agent">
          <div className="grid grid-cols-2 gap-2">
            {(["claude", "codex"] as Provider[]).map((p) => {
              const on = p === provider;
              const found = env ? !!env[p] : true;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProvider(p)}
                  className={cx(
                    "relative flex h-[56px] items-center gap-2.5 rounded-[12px] border px-3 text-left transition-[border-color,background-color] duration-150",
                    on ? "border-[color-mix(in_oklab,var(--accent)_55%,var(--border))] bg-accent-soft" : "border-line hover:bg-hover",
                  )}
                >
                  <ProviderMark provider={p} size={18} />
                  <span className="flex flex-col">
                    <span className="text-base font-semibold">{p === "claude" ? "Claude Code" : "Codex"}</span>
                    <span className={cx("text-small", found ? "text-faint" : "text-err-text")}>{found ? `${p} CLI` : "not installed"}</span>
                  </span>
                  {on && (
                    <motion.span layoutId="prov-check" className="ml-auto size-[8px] rounded-full bg-accent" transition={{ type: "spring", stiffness: 500, damping: 35 }} />
                  )}
                </button>
              );
            })}
          </div>
        </Field>
        <Field label="Folder">
          <div className="flex gap-2">
            <input autoFocus className={cx(inputCls, "h-[40px] font-mono text-mono-small")} value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/code/project" spellCheck={false} />
            <Button
              variant="outline"
              className="h-[40px]"
              onClick={async () => {
                const p = await api().pickFolder();
                if (p) setCwd(homeShort(p));
              }}
            >
              <IFolder size={15} />
              Choose…
            </Button>
          </div>
          {recents.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {recents.map((r) => {
                const on = expand(cwd.trim()) === r;
                return (
                  <button
                    key={r}
                    type="button"
                    title={homeShort(r)}
                    onClick={() => setCwd(homeShort(r))}
                    className={cx(
                      "h-[28px] rounded-[8px] border px-2 text-small transition-colors duration-150",
                      on ? "border-[color-mix(in_oklab,var(--accent)_50%,var(--border))] bg-accent-soft text-fg" : "border-line text-dim hover:bg-hover hover:text-fg",
                    )}
                  >
                    {folderName(r)}
                  </button>
                );
              })}
            </div>
          )}
        </Field>
        <Field label="First prompt" aside={<span className="text-small text-faint">optional</span>}>
          <textarea
            className={cx(inputCls, "selectable min-h-[72px] resize-none py-2 leading-[19px]")}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should it work on?"
          />
        </Field>
      </div>
      <div className="flex items-center gap-2 border-t border-hairline bg-panel/60 px-4 py-3">
        {missing ? (
          <span className="text-small text-err-text">Install the {provider} CLI first.</span>
        ) : (
          <button
            type="button"
            onClick={() => setTerminal(!terminal)}
            title="Open the CLI's own terminal UI instead of a chat"
            className={cx("flex h-[30px] items-center gap-1.5 rounded-[8px] px-2 text-small transition-colors duration-150", terminal ? "bg-press text-fg" : "text-dim hover:bg-hover hover:text-fg")}
          >
            <ITerminal size={15} />
            {terminal ? "In a terminal" : "Use terminal instead"}
          </button>
        )}
        <span className="ml-auto" />
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={!cwd.trim() || busy || missing}>
          {busy ? "Starting…" : terminal ? "Start in terminal" : "Start chat"}
          <span className="ml-1 flex gap-0.5 opacity-80">
            <Kbd className="border-transparent bg-[color-mix(in_oklab,var(--bg)_16%,transparent)] text-current">⌘</Kbd>
            <Kbd className="border-transparent bg-[color-mix(in_oklab,var(--bg)_16%,transparent)] text-current">↵</Kbd>
          </span>
        </Button>
      </div>
    </form>
  );
}

function Confirm({ title, body, action, danger, onConfirm, close }: { title: string; body: ReactNode; action: string; danger?: boolean; onConfirm: () => void; close: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      } else if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onConfirm, close]);
  return (
    <div>
      <div className="px-4 pb-3 pt-4">
        <div className="text-title font-semibold tracking-[-0.01em]">{title}</div>
        <div className="mt-1 text-base text-dim">{body}</div>
      </div>
      <div className="flex justify-end gap-2 border-t border-hairline bg-panel/60 px-4 py-3">
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>
          {action}
        </Button>
      </div>
    </div>
  );
}

function QuitConfirm({ running, close }: { running: number; close: () => void }) {
  return (
    <Confirm
      title="Quit coool?"
      body={`${running} ${running === 1 ? "session is" : "sessions are"} running inside coool and will be stopped. Their transcripts stay on disk, so you can resume them later.`}
      action="Stop and quit"
      danger
      onConfirm={() => api().quit()}
      close={close}
    />
  );
}

function StopConfirm({ label, managed, pid, chat, close }: { label: string; managed: number | null; pid: number | null; chat: number | null; close: () => void }) {
  const toast = useStore((s) => s.toast);
  return (
    <Confirm
      title={`Stop “${label.length > 48 ? label.slice(0, 47) + "…" : label}”?`}
      body={
        chat !== null
          ? "Ends the CLI process behind this chat. The transcript stays on disk, so you can resume it later."
          : managed !== null
            ? "The CLI process coool launched will be terminated. You can resume the session afterwards."
            : `Sends SIGTERM to process ${pid}, which is running outside coool.`
      }
      action="Stop session"
      danger
      onConfirm={async () => {
        close();
        try {
          if (chat !== null) await api().chatStop(chat);
          else await api().stopSession({ managed, pid });
          toast("Stop signal sent");
        } catch (e) {
          toast(String(e), "error");
        }
      }}
      close={close}
    />
  );
}

// ---------- settings ----------

function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cx("relative h-[24px] w-[34px] shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40", on ? "bg-accent" : "bg-[color-mix(in_oklab,var(--dim)_35%,transparent)]")}
    >
      <motion.span
        className="absolute top-[2px] size-[20px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)]"
        initial={false}
        animate={{ left: on ? 16 : 2 }}
        transition={{ type: "spring", stiffness: 700, damping: 38 }}
      />
    </button>
  );
}

function Settings({ close }: { close: () => void }) {
  const themePref = useStore((s) => s.themePref);
  const setThemePref = useStore((s) => s.setThemePref);
  const showAutomation = useStore((s) => s.showAutomation);
  const setShowAutomation = useStore((s) => s.setShowAutomation);
  const hiddenAutomation = useStore((s) => s.hiddenAutomation);
  const [st, setSt] = useState<InsightsStatus | null>(null);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);

  useEffect(() => {
    api()
      .insightsStatus()
      .then(setSt)
      .catch(() => setSt({ enabled: false, has_key: false, available: false }));
  }, []);
  const avail = st?.available !== false;
  const run = async (f: () => Promise<void>, next: Partial<InsightsStatus>) => {
    setErr(null);
    try {
      await f();
      setSt((s) => (s ? { ...s, ...next } : s));
      return true;
    } catch (e) {
      setErr(isNotAvailable(e) ? "Insights aren't available in this build of coool yet." : e instanceof Error ? e.message : String(e));
      return false;
    }
  };
  const save = async () => {
    const k = key.trim();
    if (!k || saving) return;
    setSaving(true);
    // The key goes straight to the backend (Keychain) and is dropped from UI state right away.
    setKey("");
    const ok = await run(() => api().insightsSetKey(k), { has_key: true });
    setSaving(false);
    if (ok) setReplacing(false);
  };

  return (
    <div>
      <div className="px-4 pb-3 pt-4">
        <div className="text-title font-semibold tracking-[-0.01em]">Settings</div>
      </div>
      <div className="flex flex-col gap-4 px-4 pb-4">
        <Field label="Theme">
          <Segmented<ThemePref>
            value={themePref}
            onChange={setThemePref}
            options={[
              { value: "system", label: "System" },
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ]}
          />
        </Field>

        <div className="flex items-start gap-3 rounded-[14px] border border-line p-4" data-setting="show-automation">
          <span className="mt-[1px] flex size-[30px] shrink-0 items-center justify-center rounded-[8px] bg-[color-mix(in_oklab,var(--dim)_12%,transparent)] text-dim">
            <IGear size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold">Show runs started by other tools</div>
            <div className="mt-0.5 text-base text-dim">
              Sessions that apps and agents launched programmatically (<span className="font-mono text-mono-small">claude -p</span>, the Agent SDK, <span className="font-mono text-mono-small">codex exec</span>). Off, only sessions you started, in a terminal, an editor or here, are listed.
              {!showAutomation && hiddenAutomation > 0 && <span className="text-faint"> {hiddenAutomation} hidden right now.</span>}
            </div>
          </div>
          <Switch label="Show runs started by other tools" on={showAutomation} onChange={setShowAutomation} />
        </div>

        <div className="flex flex-col gap-3 rounded-[14px] border border-line p-4">
          <div className="flex items-start gap-3">
            <span className="mt-[1px] flex size-[30px] shrink-0 items-center justify-center rounded-[8px] bg-[color-mix(in_oklab,var(--accent-2)_14%,transparent)] text-dim">
              <ISpark size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-base font-semibold">AI insights</div>
              <div className="mt-0.5 text-base text-dim">A one-line headline for each live session, and a “Needs you” flag with the reason when an agent is blocked on you.</div>
            </div>
            <Switch
              label="AI insights"
              on={!!st?.enabled}
              disabled={!st || !avail}
              onChange={(v) => void run(() => api().insightsSetEnabled(v), { enabled: v })}
            />
          </div>
          <div className="rounded-[8px] bg-[color-mix(in_oklab,var(--dim)_8%,transparent)] px-3 py-2 text-small text-dim">
            Uses <span className="font-medium text-fg/85">your own Anthropic API key</span>, billed to you, never your Claude Code or Codex login. A small model (Claude Haiku 5.5) runs only for
            live sessions whose activity changed, at most once per session every 45s, with an hourly cap. That is roughly $0.03 per hour of nonstop agent work per session, and
            usually far less.
          </div>
          {!avail ? (
            <div className="flex items-center gap-2 text-small text-dim">
              <IAlert size={15} className="text-busy-text" />
              Insights aren't available in this build of coool yet.
            </div>
          ) : st?.has_key && !replacing ? (
            <div className="flex items-center gap-2">
              <span className="flex h-[38px] flex-1 items-center gap-2 rounded-[10px] border border-line bg-bg px-3 text-base">
                <ICheck size={15} className="text-accent-text" />
                <span className="text-fg/90">Key saved in your Keychain</span>
                <span className="ml-auto font-mono text-mono-small tracking-[0.2em] text-faint">••••••••</span>
              </span>
              <Button variant="outline" className="h-[38px]" onClick={() => setReplacing(true)}>
                Replace
              </Button>
              <Button variant="ghost" className="h-[38px] hover:text-err-text" onClick={() => void run(() => api().insightsClearKey(), { has_key: false })}>
                Remove
              </Button>
            </div>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                className={cx(inputCls, "h-[38px] font-mono text-mono-small")}
                placeholder="sk-ant-…"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                aria-label="Anthropic API key"
              />
              <Button variant="primary" type="submit" className="h-[38px]" disabled={!key.trim() || saving}>
                {saving ? "Saving…" : "Save key"}
              </Button>
              {replacing && (
                <Button variant="ghost" className="h-[38px]" onClick={() => setReplacing(false)}>
                  Cancel
                </Button>
              )}
            </form>
          )}
          {err && <div className="text-small text-err-text">{err}</div>}
          {avail && st && !st.has_key && <div className="text-small text-faint">Stored in the macOS Keychain. coool can't show it again; you can only replace or remove it.</div>}
        </div>
      </div>
      <div className="flex justify-end border-t border-hairline bg-panel/60 px-4 py-3">
        <Button variant="ghost" onClick={close} title="Close settings">
          Done
        </Button>
      </div>
    </div>
  );
}
