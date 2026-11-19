// Settings > General > "Keep working with the lid closed" (backend app/src-tauri/src/lid/, docs/LID.md). Exported on
// its own so the onboarding can show the same row later: `<LidAwakeRow />` and `useLidStatus`.

import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/backend";
import { useClock } from "../../lib/clock";
import { BATTERY_STEPS, HOUR_STEPS, lidLine, stopText, wayText } from "../../lib/lid";
import { updateAppPrefs, useAppPrefs } from "../../lib/prefs";
import type { LidPrefs, LidStatus } from "../../lib/settingsTypes";
import { IAlert, ICheck } from "../icons";
import { Button } from "../primitives";
import { ErrorLine, errText, Note, Row, Select, Switch, Tag, type Option } from "./ui";

const DEFAULTS: LidPrefs = { enabled: false, only_on_power: true, min_battery: 20, max_hours: 8 };

/** `lid_status`, re-read every 2 s while shown (and at once after an action). */
export function useLidStatus(active = true): [LidStatus | null, (s: LidStatus) => void, () => void] {
  const [s, setS] = useState<LidStatus | null>(null);
  const reload = useCallback(() => {
    api()
      .lidStatus()
      .then(setS)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!active) return;
    reload();
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [active, reload]);
  return [s, setS, reload];
}

const batteryOpts: Option<string>[] = BATTERY_STEPS.map((p) => ({ value: String(p), label: `${p}%` }));
const hourOpts: Option<string>[] = HOUR_STEPS.map((h) => ({ value: String(h), label: h ? `${h} hour${h === 1 ? "" : "s"}` : "No limit", hint: h ? undefined : "Holds as long as agents work" }));

export function LidAwakeRow() {
  const [prefs] = useAppPrefs();
  const p = prefs?.lid ?? DEFAULTS;
  const [s, setS, reload] = useLidStatus(true);
  const now = useClock((t) => Math.floor(t / 30_000) * 30_000);
  const [busy, setBusy] = useState<"install" | "remove" | "restore" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const off = !prefs;
  const save = (patch: Partial<LidPrefs>) => {
    setErr(null);
    void updateAppPrefs({ lid: { ...p, ...patch } })
      .then(reload)
      .catch((e) => setErr(errText(e)));
  };
  const act = (kind: "install" | "remove" | "restore") => {
    setErr(null);
    setBusy(kind);
    const call = kind === "install" ? api().lidInstall() : kind === "remove" ? api().lidRemove() : api().lidRestore();
    void call
      .then(setS)
      .catch((e) => {
        const t = errText(e);
        setErr(t === "cancelled" ? "Cancelled: nothing was installed." : t);
        reload();
      })
      .finally(() => setBusy(null));
  };
  const line = s ? lidLine(s, now) : null;
  const helper = s?.helper.state;
  const installed = helper === "ready" || helper === "outdated" || helper === "unreachable";
  return (
    <Row
      attr="lid-awake"
      label="Keep working with the lid closed"
      desc="Agents keep running when you close the lid. Normal sleep comes back as soon as they stop, wait on you, or a limit below is reached."
      k="lid closed clamshell sleep awake battery helper pmset disablesleep amphetamine bag heat"
      control={<Switch label="Keep working with the lid closed" on={p.enabled} disabled={off} onChange={(v) => save({ enabled: v })} />}
    >
      {p.enabled && (
        <div className="flex flex-col gap-2.5" data-lid-row>
          {line && (
            <div className="flex items-start gap-2 text-small text-dim" data-lid-state={s?.via ? `held-${s.via}` : s?.stale ? "stale" : (s?.blocked ?? helper ?? "")}>
              <span className="mt-[3px] flex w-[14px] shrink-0 justify-center">
                {line.tone === "held" ? <ICheck size={14} className="text-accent-text" /> : line.tone === "warn" ? <IAlert size={13} className="text-busy-text" /> : <span className={line.tone === "blocked" ? "mt-[2px] size-[6px] rounded-full bg-[var(--busy)]" : "mt-[2px] size-[6px] rounded-full bg-faint/60"} />}
              </span>
              <span>{line.text}</span>
              {s?.dry_run && <Tag tone="off">dry run</Tag>}
            </div>
          )}
          {s?.stale && (
            <div>
              <Button variant="primary" className="h-[30px] px-3 text-small" disabled={busy !== null} onClick={() => act("restore")}>
                {busy === "restore" ? "Asking…" : "Restore normal sleep…"}
              </Button>
            </div>
          )}

          <div className="rounded-[10px] border border-hairline px-3 py-2.5" data-lid-helper={helper ?? ""}>
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1 text-small">
                <div className="text-fg">
                  Helper{" "}
                  {helper === "ready" ? (
                    <Tag tone="ok">installed</Tag>
                  ) : helper === "outdated" ? (
                    <Tag tone="warn">needs update</Tag>
                  ) : helper === "unreachable" ? (
                    <Tag tone="warn">not answering</Tag>
                  ) : helper === "unavailable" ? (
                    <Tag tone="off">not in this build</Tag>
                  ) : (
                    <Tag tone="off">not installed</Tag>
                  )}
                </div>
                <div className="mt-1 text-dim">{s ? wayText(s) : "…"}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {(helper === "missing" || helper === "outdated") && (
                  <Button variant="primary" className="h-[30px] px-3 text-small" disabled={busy !== null} onClick={() => act("install")} data-lid-install>
                    {busy === "install" ? "Waiting for approval…" : helper === "outdated" ? "Update…" : "Install…"}
                  </Button>
                )}
                {installed && (
                  <Button variant="outline" className="h-[30px] px-2.5 text-small" disabled={busy !== null} onClick={() => act("remove")} data-lid-remove>
                    {busy === "remove" ? "Removing…" : "Remove helper"}
                  </Button>
                )}
              </div>
            </div>
            <p className="mt-2 text-small text-faint">
              macOS sleeps a MacBook when its lid closes, whatever apps ask, unless sleep is switched off system-wide (<span className="font-mono text-mono-small">pmset disablesleep</span>), which needs an administrator. Install asks for your password
              once and adds a small helper that runs as root (<span className="font-mono text-mono-small">sh.coool.lid-helper</span>). Its only job is to turn sleep off while coool’s agents work and back on when they stop, when coool quits or crashes,
              and at every restart. Remove helper takes it all away, and so does switching this off. Without it, this works only in closed-display mode (an external display, on power).
            </p>
          </div>

          <div className="flex flex-col gap-2 text-small">
            <div className="flex items-center gap-3">
              <span className="min-w-0 flex-1 text-fg">Only while on power</span>
              <Switch label="Only while on power" on={p.only_on_power} disabled={off} onChange={(v) => save({ only_on_power: v })} />
            </div>
            <div className="flex items-center gap-3">
              <span className="min-w-0 flex-1 text-fg">On battery, let the Mac sleep at</span>
              <Select label="On battery, let the Mac sleep at" value={String(p.min_battery)} options={batteryOpts} width={140} disabled={off} onChange={(v) => save({ min_battery: Number(v) })} />
            </div>
            <div className="flex items-center gap-3">
              <span className="min-w-0 flex-1 text-fg">Longest hold</span>
              <Select label="Longest hold" value={String(p.max_hours)} options={hourOpts} width={200} disabled={off} onChange={(v) => save({ max_hours: Number(v) })} />
            </div>
            {p.max_hours === 0 && <Note tone="warn">No limit: a stuck agent can keep a closed Mac awake until the battery or the heat limit stops it.</Note>}
          </div>

          <Note tone="warn">
            <span className="flex items-start gap-2">
              <IAlert size={13} className="mt-[2px] shrink-0 text-busy-text" />
              <span>
                Don’t put a Mac that’s holding awake in a bag or sleeve. With the lid closed it can’t shed heat there. coool lets go when macOS reports serious heat, but heat builds up before that. Leave it open on a desk, or closed on a hard
                surface.
              </span>
            </span>
          </Note>

          {s && s.stops.length > 0 && (
            <div className="flex flex-col gap-0.5 text-small" data-lid-stops>
              <span className="text-faint">Last automatic stops</span>
              {s.stops.slice(0, 3).map((st) => (
                <span key={`${st.at}-${st.code}`} className="text-dim">
                  {stopText(st)}
                </span>
              ))}
            </div>
          )}
          <ErrorLine>{err ?? (s?.error && !s.via ? s.error : null)}</ErrorLine>
        </div>
      )}
    </Row>
  );
}
