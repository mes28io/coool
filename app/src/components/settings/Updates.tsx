// Settings > General > Updates: the running version with "Check now", and the two switches (coool itself; Claude Code
// and Codex). The work is the backend's (app/src-tauri/src/update/); the rail's icon shows it while it happens.

import { useState } from "react";
import { api } from "../../lib/backend";
import { checkNow, useUpdates } from "../../lib/update";
import { itemLine } from "../../lib/updateView";
import { Button } from "../primitives";
import { ErrorLine, Group, Row, Switch } from "./ui";

function ago(ms: number | null): string {
  if (!ms) return "Not checked yet";
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 1 ? "Checked just now" : m < 60 ? `Checked ${m} min ago` : `Checked ${Math.round(m / 60)} h ago`;
}

export function UpdatesGroup() {
  const status = useUpdates((s) => s.status);
  const set = useUpdates((s) => s.set);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!status) return null;
  const app = status.items.find((i) => i.id === "coool");
  const clis = status.items.filter((i) => i.id !== "coool");
  const toggle = (o: { app?: boolean; cli?: boolean }) => {
    setErr(null);
    set({ ...status, auto_app: o.app ?? status.auto_app, auto_cli: o.cli ?? status.auto_cli });
    void api()
      .updateSetAuto(o)
      .catch((e) => setErr(String(e)));
  };
  const appLine = !app
    ? ""
    : app.state === "staged"
      ? `Update installed · restart to apply (${app.latest})`
      : app.state === "downloading" || app.state === "installing"
        ? itemLine(app)
        : app.latest && app.state === "available"
          ? `${app.latest} is available`
          : app.state === "current"
            ? "Up to date"
            : "";
  return (
    <Group label="Updates" footer={status.blocked ?? undefined} attr="updates">
      <Row
        attr="update-version"
        label={`coool ${app?.current ?? ""}`.trim()}
        k="version update check now"
        desc={[appLine, ago(status.checked_at)].filter(Boolean).join(" · ")}
        control={
          <Button
            variant="outline"
            className="h-[30px] px-2.5 text-small"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(await checkNow().catch(() => "coool couldn't check for updates."));
              setBusy(false);
            }}
          >
            {busy ? "Checking…" : "Check now"}
          </Button>
        }
      />
      <Row
        attr="update-auto-app"
        label="Keep coool up to date"
        k="automatic updates"
        desc="Checks at launch and a few times a day, and installs new versions. While you work, an update waits for you to restart."
        control={<Switch label="Keep coool up to date" on={status.auto_app} onChange={(v) => toggle({ app: v })} />}
      />
      <Row
        attr="update-auto-cli"
        label="Keep Claude Code and Codex up to date"
        k="cli claude codex npm update"
        desc={
          <>
            Off: new versions show in the updater and you choose when to install. On: coool installs them itself, the way each CLI was installed and never while one of its sessions is running. A brand-new CLI version may not have been tried with coool yet.
            {clis.length > 0 && (
              <span className="text-faint">
                {" "}
                {clis.map((c) => `${c.name} ${c.state === "missing" ? "not installed" : (c.current ?? "?")}`).join(" · ")}
              </span>
            )}
          </>
        }
        control={<Switch label="Keep Claude Code and Codex up to date" on={status.auto_cli} onChange={(v) => toggle({ cli: v })} />}
      />
      {err && (
        <div className="pb-3">
          <ErrorLine>{err}</ErrorLine>
        </div>
      )}
    </Group>
  );
}
