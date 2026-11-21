// Settings > Assist, Usage and About.

import { useEffect, useState } from "react";
import { api, isNotAvailable, isTauri } from "../../lib/backend";
import type { InsightsStatus } from "../../lib/types";
import { useStore } from "../../store";
import { openOnboarding } from "../../lib/onboarding";
import { checkNow, updateAndRestart, useUpdates } from "../../lib/update";
import { itemLine, keepLine, stopLine } from "../../lib/updateView";
import type { QuitCounts } from "../../lib/backend";
import { IAlert, ICheck } from "../icons";
import { Button, cx } from "../primitives";
import { UsageBlock, useUsageProviders } from "../Usage";
import { Group, Note, Row, Switch } from "./ui";

const inputCls =
  "h-[32px] w-full min-w-0 rounded-[8px] border border-line bg-bg px-2.5 font-mono text-mono-small outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-faint focus:border-[color-mix(in_oklab,var(--fg)_30%,var(--border))] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--fg)_6%,transparent)]";

// ---------- Assist ----------

export function Insights() {
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
      setErr(isNotAvailable(e) ? "Assist isn't available in this build of coool yet." : e instanceof Error ? e.message : String(e));
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
        label="Assist"
        desc="A one-line headline for each live session, and a “Needs you” flag with the reason when an agent is blocked on you."
        control={<Switch label="Assist" on={!!st?.enabled} disabled={!st || !avail} onChange={(v) => void run(() => api().insightsSetEnabled(v), { enabled: v })} />}
      >
        <Note>
          Uses <span className="font-medium text-fg/85">your own Anthropic API key</span>, billed to you, never your Claude Code or Codex login. A small model (Claude Haiku 5.5) runs only for live sessions whose activity changed, at most once per
          session every 45s, with an hourly cap: roughly $0.03 per hour of nonstop agent work per session, usually far less.
        </Note>
      </Row>
      <Row attr="insights-key" label="API key" desc={avail && st && !st.has_key ? "Stored in the macOS Keychain. coool can't show it again; you can only replace or remove it." : undefined}>
        {!avail ? (
          <div className="flex items-center gap-2 text-small text-dim">
            <IAlert size={14} className="shrink-0 text-busy-text" />
            Assist isn't available in this build of coool yet.
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

// ---------- Usage ----------

export function UsageSection() {
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

/** A newer coool on GitHub (the hourly check or Check now found it): "Update and restart", the same path as the rail
 *  panel's Restart. Working chats the chat host runs keep running across it; anything that would stop is named first. */
function AboutUpdate() {
  const status = useUpdates((s) => s.status);
  const [confirm, setConfirm] = useState<QuitCounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const app = status?.items.find((i) => i.id === "coool");
  if (!app || !app.latest || !["available", "downloading", "installing", "staged", "failed"].includes(app.state)) {
    // Nothing to install: say so, when coool last looked, and offer a fresh look. The same row turns into
    // "Update and restart" the moment a release is found.
    const at = status?.checked_at ? new Date(status.checked_at) : null;
    const when = at ? `checked ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "not checked yet";
    const check = async () => {
      setErr(null);
      setChecking(true);
      setErr(await checkNow().catch((e) => (e instanceof Error ? e.message : String(e))));
      setChecking(false);
    };
    return (
      <Row
        attr="about-update"
        label="Updates"
        desc={`${app?.state === "current" || app?.latest == null ? "coool is up to date" : itemLine(app)} · ${when}. coool checks every hour; when a version is out, this row offers Update and restart, and working chats keep running.`}
        k="update upgrade new version release restart check"
        control={
          <Button variant="outline" className="h-[30px] px-2.5 text-small" disabled={checking || !isTauri} onClick={() => void check()} data-about-check>
            {checking ? "Checking…" : "Check now"}
          </Button>
        }
      >
        {err && <div className="text-small text-err-text">{err}</div>}
      </Row>
    );
  }
  const go = async () => {
    setErr(null);
    setBusy(true);
    try {
      await updateAndRestart();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const press = async () => {
    const q = await api().quitCounts();
    if (q.stop > 0) setConfirm(q);
    else await go();
  };
  const working = app.state === "downloading" || app.state === "installing";
  const desc = working ? itemLine(app) : app.state === "staged" ? `coool ${app.latest} is installed. Restart to use it; working chats keep running.` : `coool ${app.latest} is out. Update and restart; working chats keep running.`;
  return (
    <Row
      attr="about-update"
      label="Update available"
      desc={desc}
      k="update upgrade new version release restart"
      control={
        <Button variant="primary" className="h-[30px] px-2.5 text-small" disabled={busy || working || !!status?.blocked} onClick={() => void press()} data-about-update={app.state}>
          {busy ? "Updating…" : "Update and restart"}
        </Button>
      }
    >
      {confirm && (
        <div className="flex flex-col gap-2 rounded-[10px] bg-[color-mix(in_oklab,var(--busy)_12%,transparent)] px-3 py-2.5" data-about-update-confirm>
          <div className="text-small text-fg/90">coool will restart into {app.latest}. {[stopLine(confirm.stop), keepLine(confirm.keep)].filter(Boolean).join(" ")}</div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" className="h-[28px] px-2.5 text-small" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="danger" className="h-[28px] px-2.5 text-small" onClick={() => void go()}>
              Stop and restart
            </Button>
          </div>
        </div>
      )}
      {status?.blocked && <Note>{status.blocked}</Note>}
      {err && <div className="text-small text-err-text">{err}</div>}
    </Row>
  );
}

export function About() {
  const open = useStore((s) => s.openSettings);
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
  return (
    <Group>
      <Row attr="version" label="coool" desc="Open source (MIT). A workspace for the coding agents you already pay for." k="version build" control={<span className="text-base text-dim tnum">{isTauri ? (version ? `Version ${version}` : "…") : "Browser preview"}</span>} />
      <AboutUpdate />
      <Row
        attr="about-clis"
        label="Claude Code and Codex"
        desc="Which CLIs coool found, their versions and how to fix one that’s broken."
        k="cli path"
        control={
          <Button variant="outline" className="h-[30px] px-2.5 text-small" onClick={() => open("providers")}>
            Providers
          </Button>
        }
      />
      <Row
        attr="onboarding"
        label="Onboarding"
        desc="The first-run steps: the look, a project folder, what you build, how your agents work, notifications and voice."
        k="onboarding welcome setup first run intro"
        control={
          <Button variant="outline" className="h-[30px] px-2.5 text-small" onClick={openOnboarding} data-onboarding-again>
            Show onboarding again
          </Button>
        }
      />
    </Group>
  );
}
