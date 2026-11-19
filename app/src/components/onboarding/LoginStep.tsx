// Step 3: open coool at login. One switch over the login item (`SMAppService`, lib/systemPerms.ts, as in
// Settings > General); a build macOS doesn't know as an app says so and the switch stays off.

import { api } from "../../lib/backend";
import { loginText, useLoginItem } from "../../lib/systemPerms";
import { Button } from "../primitives";
import { Switch } from "../settings/ui";

export function LoginStep() {
  const { login, on, blocked, busy, err, set } = useLoginItem();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 rounded-[12px] border border-line bg-panel py-3 pl-3.5 pr-3" data-onb-login={login?.status ?? ""}>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-base font-medium text-fg">Open coool at login</span>
          <span className="text-small text-dim">{login ? loginText(login, on ? "On. It’s listed in System Settings > General > Login Items." : "Off. You can change it any time in Settings > General.") : "…"}</span>
        </div>
        {login?.status === "requires_approval" && (
          <Button variant="ghost" className="h-[30px] px-2.5 text-small" onClick={() => void api().openSystemSettings("login").catch(() => {})}>
            Open Login Items
          </Button>
        )}
        <Switch label="Open coool at login" on={on} disabled={blocked || busy} onChange={(v) => void set(v)} />
      </div>
      {err && <div className="px-1 text-small text-err-text">{err}</div>}
    </div>
  );
}
