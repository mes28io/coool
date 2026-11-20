// Notifications. Shows where the macOS permission stands; the system prompt appears only when the person presses
// Allow (lib/systemPerms.ts, the same logic as Settings > Notifications). Then "When should coool interrupt you?" as
// two plain choices over Settings > Notifications' switches: Needs you on, and Finishes a turn off or on; and the
// "needs you" and "done" sounds with Settings > Notifications' own picker and preview (`SoundPicker`, the same prefs).
// Skip puts all of it back as it was (keep.ts).

import { api } from "../../lib/backend";
import { loadAppPrefs, updateAppPrefs, useAppPrefs } from "../../lib/prefs";
import type { NotifyPrefs } from "../../lib/settingsTypes";
import { notifyText, useNotifyPermission } from "../../lib/systemPerms";
import { IAlert, IBell, ICheck } from "../icons";
import { Button, cx } from "../primitives";
import { SoundPicker } from "../settings/General";
import { restoreStep, useRestorePoint } from "./keep";

type When = "needs" | "finished";
const WHEN: { value: When; label: string; desc: string }[] = [
  { value: "needs", label: "Only when an agent needs me", desc: "A permission to give, or a question to answer." },
  { value: "finished", label: "Also when a turn finishes", desc: "When an agent is done and waiting for your next message." },
];
/** The choice Settings > Notifications' switches add up to (none: "Needs you" turned off there). */
export const whenOf = (n: Pick<NotifyPrefs, "needs_you" | "finished">): When | null => (n.finished ? "finished" : n.needs_you ? "needs" : null);

/** What this step can change. */
const TOUCHED = ["needs_you", "finished", "sound", "custom_sounds", "sound_needs", "sound_finished"] as const;
type Touched = (typeof TOUCHED)[number];
const pick = (n: NotifyPrefs) => Object.fromEntries(TOUCHED.map((k) => [k, n[k]])) as Pick<NotifyPrefs, Touched>;

/** Skip: the switches and sounds as they were when the step first showed. */
export const skipNotify = () => restoreStep("notifications");

export function NotifyStep() {
  const { perm, busy, err, ask, allowed } = useNotifyPermission();
  const [prefs] = useAppPrefs();
  const n = prefs?.notify;
  const when = n ? whenOf(n) : null;
  useRestorePoint("notifications", () => {
    let was: Pick<NotifyPrefs, Touched> | null = null;
    void loadAppPrefs().then((p) => p && (was = pick(p.notify)));
    return () =>
      void loadAppPrefs().then((p) => {
        if (p && was && JSON.stringify(pick(p.notify)) !== JSON.stringify(was)) void updateAppPrefs({ notify: { ...p.notify, ...was } }).catch(() => {});
      });
  });
  const choose = (w: When) => n && void updateAppPrefs({ notify: { ...n, needs_you: true, finished: w === "finished" } }).catch(() => {});
  // A sound picked here: sounds on, one per kind (Settings > Notifications' "A different sound for each").
  const pickSound = (patch: Partial<NotifyPrefs>) => n && void updateAppPrefs({ notify: { ...n, sound: true, custom_sounds: true, ...patch } }).catch(() => {});
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-[12px] border border-line bg-panel py-2.5 pl-3 pr-2" data-onb-notify={perm?.status ?? ""}>
        <span className="flex size-[18px] shrink-0 items-center justify-center">
          {allowed ? <ICheck size={15} className="text-accent-text" /> : perm?.status === "denied" ? <IAlert size={15} className="text-busy-text" /> : <IBell size={15} className="text-faint" />}
        </span>
        <span className="min-w-0 flex-1 text-small text-dim">{perm ? notifyText(perm) : "…"}</span>
        {perm?.status === "not_determined" && (
          <Button variant="outline" className="h-[30px] px-2.5 text-small" disabled={busy} onClick={() => void ask()} data-onb-allow>
            {busy ? "Asking…" : "Allow notifications"}
          </Button>
        )}
        {perm?.status === "denied" && (
          <Button variant="outline" className="h-[30px] px-2.5 text-small" onClick={() => void api().openSystemSettings("notifications").catch(() => {})} data-onb-open-settings>
            Open System Settings
          </Button>
        )}
      </div>
      {err && <div className="px-1 text-small text-err-text">{err}</div>}

      <div className="flex flex-col gap-2">
        <span id="onb-when" className="px-1 text-base font-medium text-fg">
          When should coool interrupt you?
        </span>
        <div role="radiogroup" aria-labelledby="onb-when" className="flex flex-col rounded-[12px] border border-line bg-panel" data-onb-when={when ?? ""}>
          {WHEN.map((o, k) => {
            const on = when === o.value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!n}
                onClick={() => choose(o.value)}
                data-onb-when-option={o.value}
                className={cx("flex items-center gap-3 px-3.5 py-2.5 text-left transition-colors duration-150 hover:bg-hover disabled:opacity-50", k > 0 && "border-t border-hairline", k === 0 ? "rounded-t-[12px]" : "rounded-b-[12px]")}
              >
                <span className={cx("flex size-[16px] shrink-0 items-center justify-center rounded-full border transition-colors duration-150", on ? "border-fg bg-fg" : "border-[color-mix(in_oklab,var(--dim)_45%,transparent)]")}>
                  {on && <span className="size-[6px] rounded-full bg-[var(--bg)]" />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-base text-fg">{o.label}</span>
                  <span className="text-small text-dim">{o.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
        {n && !n.needs_you && <span className="px-1 text-small text-faint">“Needs you” is off in Settings &gt; Notifications; either choice turns it back on.</span>}
      </div>

      {n && (
        <div className="flex flex-col gap-2" data-onb-sounds={n.sound ? (n.custom_sounds ? "custom" : "system") : "off"}>
          <span className="px-1 text-base font-medium text-fg">Sounds</span>
          <div className="flex flex-col rounded-[12px] border border-line bg-panel">
            <div className="flex items-center gap-3 border-b border-hairline px-3.5 py-2">
              <span className="min-w-0 flex-1 text-base text-fg">When an agent needs you</span>
              <SoundPicker attr="onb-sound-needs" label="Needs you sound" value={n.sound_needs} width={240} onChange={(v) => pickSound({ sound_needs: v })} />
            </div>
            <div className="flex items-center gap-3 px-3.5 py-2">
              <span className="min-w-0 flex-1 text-base text-fg">When a turn is done</span>
              <SoundPicker attr="onb-sound-finished" label="Finished sound" value={n.sound_finished} width={240} onChange={(v) => pickSound({ sound_finished: v })} />
            </div>
          </div>
          <span className="px-1 text-small text-faint">
            {!n.sound ? "Sounds are off now; picking one turns them on." : !n.custom_sounds ? "Now macOS’s notification sound for both; picking one gives each its own." : "Settings > Notifications has the sound for a failed turn too."}
          </span>
        </div>
      )}
    </div>
  );
}
