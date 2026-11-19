// Step 2: notifications. Shows where the macOS permission stands; the system prompt appears only when the person
// presses Allow (lib/systemPerms.ts, the same logic as Settings > Notifications).

import { api } from "../../lib/backend";
import { updateAppPrefs, useAppPrefs } from "../../lib/prefs";
import { notifyText, useNotifyPermission } from "../../lib/systemPerms";
import { IAlert, IBell, ICheck } from "../icons";
import { Button } from "../primitives";
import { Switch } from "../settings/ui";

export function NotifyStep() {
  const { perm, busy, err, ask, allowed } = useNotifyPermission();
  const [prefs] = useAppPrefs();
  const n = prefs?.notify;
  return (
    <div className="flex flex-col gap-3">
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
      {n && (
        <label className="flex items-center gap-3 px-1 text-small text-dim" data-onb-finished>
          <span className="min-w-0 flex-1">Also when an agent finishes a turn</span>
          <Switch label="Also when an agent finishes a turn" on={n.finished} onChange={(v) => void updateAppPrefs({ notify: { ...n, finished: v } }).catch(() => {})} />
        </label>
      )}
    </div>
  );
}
