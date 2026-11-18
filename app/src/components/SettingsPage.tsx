// The full-screen Settings page (Settings and Usage in the rail, ⌘,, the palette). It lies over the app's sheet
// (sidebar + panes stay mounted underneath, hidden and inert), so going back restores exactly what was there.
// Left: "Back to app" and the categories (a vertical tab list); right: the chosen category.

import { motion } from "motion/react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, isNotAvailable, isTauri } from "../lib/backend";
import { setMotionPref, useMotion, type MotionPref } from "../lib/motion";
import type { PilotLogStatus } from "../lib/backend";
import type { InsightsStatus } from "../lib/types";
import { SETTINGS_SECTIONS, useStore, type SettingsSection, type ThemePref } from "../store";
import { IAlert, IBack, ICheck, IGauge, IInfo, IList, IPhone, ISpark, ISun } from "./icons";
import { Button, cx, ease, Kbd, Segmented } from "./primitives";
import { UsageBlock, useUsageProviders } from "./Usage";

const META: Record<SettingsSection, { label: string; icon: ReactNode; desc: string }> = {
  appearance: { label: "Appearance", icon: <ISun size={16} />, desc: "How coool looks and moves." },
  sessions: { label: "Sessions", icon: <IList size={16} />, desc: "Which sessions coool lists." },
  insights: { label: "AI insights", icon: <ISpark size={16} />, desc: "Live headlines and “Needs you” reasons, written by a small model on your own API key." },
  pilot: { label: "Device pilot", icon: <IPhone size={16} />, desc: "The fast pilot that drives the iPhone and Browser panels for agents (pilot_run)." },
  usage: { label: "Usage", icon: <IGauge size={16} />, desc: "How much of your Claude and Codex plan limits is used, and when each window resets." },
  about: { label: "About", icon: <IInfo size={16} />, desc: "This build of coool and the CLIs it found." },
};

export function SettingsPage() {
  const section = useStore((s) => s.settings) ?? "appearance";
  const open = useStore((s) => s.openSettings);
  const close = useStore((s) => s.closeSettings);
  const tabs = useRef<Partial<Record<SettingsSection, HTMLButtonElement | null>>>({});

  // Focus moves into the page (whatever had it is hidden now) and goes back there on return. Read during the first
  // render: by the time effects run the app underneath is inert and has already dropped focus.
  const [prev] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => {
    tabs.current[useStore.getState().settings ?? "appearance"]?.focus({ preventScroll: true });
    return () => {
      // Only when focus went down with the page (not when the person clicked somewhere else to leave).
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost && prev?.isConnected && !prev.closest("[inert]")) prev.focus({ preventScroll: true });
    };
  }, [prev]);

  // Esc returns, unless the palette or a sheet is on top (they close first). Capture phase: it runs before their own handlers.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const st = useStore.getState();
      if (st.palette || st.sheet) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  const onNavKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = SETTINGS_SECTIONS.indexOf(section);
    const n = SETTINGS_SECTIONS.length;
    const to =
      e.key === "ArrowDown" ? SETTINGS_SECTIONS[(i + 1) % n] : e.key === "ArrowUp" ? SETTINGS_SECTIONS[(i - 1 + n) % n] : e.key === "Home" ? SETTINGS_SECTIONS[0] : e.key === "End" ? SETTINGS_SECTIONS[n - 1] : null;
    if (!to) return;
    e.preventDefault();
    open(to);
    tabs.current[to]?.focus();
  };

  return (
    <motion.div
      data-settings-page={section}
      className="absolute inset-0 z-10 flex bg-bg"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16, ease }}
    >
      <div className="flex w-[232px] shrink-0 flex-col border-r border-hairline">
        <div data-tauri-drag-region className="flex h-[48px] shrink-0 items-center px-2">
          <button
            type="button"
            onClick={close}
            title="Back to app (Esc)"
            className="flex h-[32px] items-center gap-2 rounded-[9px] pl-2 pr-2.5 text-base text-dim transition-colors duration-150 hover:bg-hover hover:text-fg"
            data-settings-back
          >
            <IBack size={16} />
            Back to app
          </button>
        </div>
        <div className="px-4 pb-1 pt-4 text-small text-dim">Settings</div>
        <div role="tablist" aria-orientation="vertical" aria-label="Settings" className="flex flex-col gap-0.5 px-2" onKeyDown={onNavKey}>
          {SETTINGS_SECTIONS.map((s) => {
            const on = s === section;
            return (
              <button
                key={s}
                ref={(el) => {
                  tabs.current[s] = el;
                }}
                type="button"
                role="tab"
                id={`settings-tab-${s}`}
                aria-selected={on}
                aria-controls="settings-panel"
                tabIndex={on ? 0 : -1}
                data-settings-tab={s}
                onClick={() => open(s)}
                className={cx(
                  "flex h-[34px] items-center gap-2.5 rounded-[9px] px-2.5 text-left text-base transition-colors duration-150",
                  on ? "bg-raised text-fg shadow-card" : "text-dim hover:bg-hover hover:text-fg",
                )}
              >
                <span className={cx("flex", on ? "text-fg" : "text-faint")}>{META[s].icon}</span>
                {META[s].label}
              </button>
            );
          })}
        </div>
        <div className="mt-auto flex items-center gap-1.5 px-4 pb-4 text-small text-faint">
          <Kbd className="h-[20px]">Esc</Kbd> back to app
        </div>
      </div>

      {/* Keyed: a new category starts at the top and fades in. */}
      <motion.div
        key={section}
        id="settings-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${section}`}
        className="scroll min-w-0 flex-1"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease }}
      >
        <div data-tauri-drag-region className="h-[48px]" />
        <div className="mx-auto w-full max-w-[680px] px-8 pb-12">
          <h1 className="text-display font-semibold tracking-[-0.02em] text-fg">{META[section].label}</h1>
          <p className="mt-1 text-base text-dim">{META[section].desc}</p>
          <div className="mt-6">
            {section === "appearance" ? <Appearance /> : section === "sessions" ? <Sessions /> : section === "insights" ? <Insights /> : section === "pilot" ? <Pilot /> : section === "usage" ? <UsageSection /> : <About />}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ---------- building blocks ----------

function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cx("relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40", on ? "bg-accent" : "bg-[color-mix(in_oklab,var(--dim)_35%,transparent)]")}
    >
      <motion.span
        className="absolute top-[2px] size-[18px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)]"
        initial={false}
        animate={{ left: on ? 18 : 2 }}
        transition={{ type: "spring", stiffness: 700, damping: 38 }}
      />
    </button>
  );
}

/** A card of rows with hairline dividers, with an optional small uppercase label above it. */
function Group({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <section className="pt-6 first:pt-0">
      {label && <div className="px-1 pb-2 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">{label}</div>}
      <div className="flex flex-col divide-y divide-hairline rounded-[12px] border border-line bg-raised px-4">{children}</div>
    </section>
  );
}

/** Label, optional dim description, control on the right; `children` go under the whole row. */
function Row({ label, desc, control, children, attr }: { label: string; desc?: ReactNode; control?: ReactNode; children?: ReactNode; attr?: string }) {
  return (
    <div className="flex flex-col gap-2.5 py-3.5" data-setting={attr}>
      <div className="flex items-start gap-6">
        <div className="min-w-0 flex-1">
          <div className="text-base text-fg">{label}</div>
          {desc && <div className="mt-0.5 text-small text-dim">{desc}</div>}
        </div>
        {control && <div className="mt-[1px] shrink-0">{control}</div>}
      </div>
      {children}
    </div>
  );
}

const inputCls =
  "h-[32px] w-full min-w-0 rounded-[8px] border border-line bg-bg px-2.5 font-mono text-mono-small outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-faint focus:border-[color-mix(in_oklab,var(--accent)_50%,var(--border))] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_12%,transparent)]";

// ---------- Appearance ----------

function Appearance() {
  const themePref = useStore((s) => s.themePref);
  const setThemePref = useStore((s) => s.setThemePref);
  const m = useMotion();
  const now =
    m.pref === "on" ? "Reduced: activity shows still" : m.pref === "off" ? "Full motion, always" : m.reduce ? `Auto · reduced now (${m.reason ?? "device"})` : "Auto · full motion";
  return (
    <Group>
      <Row
        attr="theme"
        label="Theme"
        desc="System follows macOS light and dark."
        control={<Segmented<ThemePref> size="sm" value={themePref} onChange={setThemePref} options={[{ value: "system", label: "System" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} />}
      />
      <Row
        attr="reduce-motion"
        label="Reduce motion"
        desc={
          <>
            Auto follows macOS Reduce motion, Low Power Mode, heat and a low battery.
            <span className="mt-1 block text-faint" data-motion-state={m.reduce ? "reduced" : "full"}>
              {now}
            </span>
          </>
        }
        control={<Segmented<MotionPref> size="sm" value={m.pref} onChange={setMotionPref} options={[{ value: "auto", label: "Auto" }, { value: "on", label: "On" }, { value: "off", label: "Off" }]} />}
      />
    </Group>
  );
}

// ---------- Sessions ----------

function Sessions() {
  const showAutomation = useStore((s) => s.showAutomation);
  const setShowAutomation = useStore((s) => s.setShowAutomation);
  const hiddenAutomation = useStore((s) => s.hiddenAutomation);
  return (
    <Group>
      <Row
        attr="show-automation"
        label="Show runs started by other tools"
        desc={
          <>
            Sessions that apps and agents launched programmatically (<span className="font-mono text-mono-small">claude -p</span>, the Agent SDK, <span className="font-mono text-mono-small">codex exec</span>). Off, only sessions you started are listed.
            {!showAutomation && hiddenAutomation > 0 && <span className="text-faint"> {hiddenAutomation} hidden right now.</span>}
          </>
        }
        control={<Switch label="Show runs started by other tools" on={showAutomation} onChange={setShowAutomation} />}
      />
    </Group>
  );
}

// ---------- AI insights ----------

function Insights() {
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
    <Group>
      <Row
        attr="insights"
        label="AI insights"
        desc="A one-line headline for each live session, and a “Needs you” flag with the reason when an agent is blocked on you."
        control={<Switch label="AI insights" on={!!st?.enabled} disabled={!st || !avail} onChange={(v) => void run(() => api().insightsSetEnabled(v), { enabled: v })} />}
      >
        <div className="rounded-[8px] bg-[color-mix(in_oklab,var(--dim)_8%,transparent)] px-3 py-2 text-small text-dim">
          Uses <span className="font-medium text-fg/85">your own Anthropic API key</span>, billed to you, never your Claude Code or Codex login. A small model (Claude Haiku 5.5) runs only for live sessions whose activity changed, at most once per
          session every 45s, with an hourly cap: roughly $0.03 per hour of nonstop agent work per session, usually far less.
        </div>
      </Row>
      <Row attr="insights-key" label="API key" desc={avail && st && !st.has_key ? "Stored in the macOS Keychain. coool can't show it again; you can only replace or remove it." : undefined}>
        {!avail ? (
          <div className="flex items-center gap-2 text-small text-dim">
            <IAlert size={14} className="shrink-0 text-busy-text" />
            Insights aren't available in this build of coool yet.
          </div>
        ) : st?.has_key && !replacing ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex h-[32px] min-w-[240px] flex-1 items-center gap-2 rounded-[8px] border border-line bg-bg px-2.5 text-small">
              <ICheck size={14} className="shrink-0 text-accent-text" />
              <span className="min-w-0 truncate text-fg/90">Key saved in your Keychain</span>
              <span className="ml-auto font-mono text-mono-small tracking-[0.2em] text-faint">••••</span>
            </span>
            <Button variant="outline" className="h-[32px]" onClick={() => setReplacing(true)}>
              Replace
            </Button>
            <Button variant="ghost" className="h-[32px] hover:text-err-text" onClick={() => void run(() => api().insightsClearKey(), { has_key: false })}>
              Remove
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <input type="password" autoComplete="off" spellCheck={false} className={cx(inputCls, "min-w-[240px] flex-1")} placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Anthropic API key" />
            <Button variant="primary" type="submit" className="h-[32px]" disabled={!key.trim() || saving}>
              {saving ? "Saving…" : "Save key"}
            </Button>
            {replacing && (
              <Button variant="ghost" className="h-[32px]" onClick={() => setReplacing(false)}>
                Cancel
              </Button>
            )}
          </form>
        )}
        {err && <div className="text-small text-err-text">{err}</div>}
      </Row>
    </Group>
  );
}

// ---------- Device pilot ----------

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Pilot() {
  const [st, setSt] = useState<PilotLogStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [avail, setAvail] = useState(true);
  useEffect(() => {
    api()
      .pilotLogStatus()
      .then(setSt)
      .catch((e) => (isNotAvailable(e) ? setAvail(false) : setErr(String(e))));
  }, []);
  const run = async (f: () => Promise<PilotLogStatus | void>) => {
    setErr(null);
    try {
      const next = await f();
      if (next) setSt(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const empty = !st || st.files === 0;
  return (
    <Group>
      <Row
        attr="pilot-log"
        label="Save pilot decisions for training"
        desc="Each step the pilot decides (the screen as it saw it, the action it chose, and whether the run got there) goes into a log on this Mac, for training a faster local pilot later. Nothing is uploaded."
        control={<Switch label="Save pilot decisions for training" on={!!st?.enabled} disabled={!st || !avail} onChange={(v) => void run(() => api().pilotLogSetEnabled(v))} />}
      >
        <div className="rounded-[8px] bg-[color-mix(in_oklab,var(--dim)_8%,transparent)] px-3 py-2 text-small text-dim">
          Never saved: what you or an agent typed (only the input’s name, like <span className="font-mono text-mono-small">email</span>), passwords and other hidden fields, screenshots, API keys.
        </div>
      </Row>
      <Row
        attr="pilot-log-file"
        label="Decision log"
        desc={
          !avail ? (
            "Not available in this build of coool."
          ) : st?.dir ? (
            <>
              <span className="selectable break-all font-mono text-mono-small" data-pilot-log-dir>
                {st.dir}
              </span>
              <span className="mt-1 block text-faint" data-pilot-log-size={st.bytes}>
                {empty ? "Empty" : `${fmtBytes(st.bytes)} in ${st.files} ${st.files === 1 ? "file" : "files"}`} · at most about 40 MB per project
              </span>
            </>
          ) : (
            "…"
          )
        }
      >
        {avail && st?.dir && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" className="h-[32px]" onClick={() => void run(() => api().pilotLogReveal())} data-pilot-log-reveal>
              Reveal in Finder
            </Button>
            {confirm ? (
              <>
                <Button
                  variant="ghost"
                  className="h-[32px] text-err-text"
                  onClick={() => {
                    setConfirm(false);
                    void run(() => api().pilotLogDelete());
                  }}
                  data-pilot-log-delete-confirm
                >
                  Delete the log
                </Button>
                <Button variant="ghost" className="h-[32px]" onClick={() => setConfirm(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="ghost" className="h-[32px] hover:text-err-text" disabled={empty} onClick={() => setConfirm(true)} data-pilot-log-delete>
                Delete
              </Button>
            )}
          </div>
        )}
        {err && <div className="text-small text-err-text">{err}</div>}
      </Row>
    </Group>
  );
}

// ---------- Usage ----------

function UsageSection() {
  const usage = useStore((s) => s.usage);
  const providers = useUsageProviders();
  return (
    <div className="flex flex-col gap-3" data-settings-usage role="region" aria-label="Plan usage">
      {providers.map((p) => (
        <div key={p} className="rounded-[12px] border border-line bg-raised px-1.5 py-0.5">
          <UsageBlock provider={p} usage={usage[p]} full />
        </div>
      ))}
      {providers.length === 0 && <div className="rounded-[12px] border border-dashed border-line px-4 py-5 text-center text-base text-dim">No supported CLI found.</div>}
      {providers.length > 0 && (
        <p className="px-1 pt-1 text-small text-faint">Use on other devices and on claude.ai or chatgpt.com counts against the same limits; it shows here after the next reading.</p>
      )}
    </div>
  );
}

// ---------- About ----------

function About() {
  const env = useStore((s) => s.env);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri) return;
    let live = true;
    void import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then((v) => live && setVersion(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const cli = (path: string | null | undefined) =>
    path === undefined ? <span className="text-faint">Looking…</span> : path ? <span className="selectable break-all font-mono text-mono-small text-dim">{path}</span> : <span className="text-faint">Not found</span>;
  return (
    <Group>
      <Row attr="version" label="coool" control={<span className="text-base text-dim tnum">{isTauri ? (version ? `Version ${version}` : "…") : "Browser preview"}</span>} />
      <Row attr="cli-claude" label="Claude Code CLI" desc={cli(env ? env.claude : undefined)} />
      <Row attr="cli-codex" label="Codex CLI" desc={cli(env ? env.codex : undefined)} />
    </Group>
  );
}
