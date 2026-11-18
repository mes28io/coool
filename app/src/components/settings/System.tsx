// Settings > Providers, Devices and Storage.

import { useEffect, useState } from "react";
import { homeShort } from "../../lib/format";
import { api, isNotAvailable, type DeviceGrant, type DeviceKind, type MacStatus, type PilotLogStatus, type SimDevice, type SimList } from "../../lib/backend";
import { NetworkSwitch } from "../MacPanel";
import type { CliStatus, StorageStatus } from "../../lib/settingsTypes";
import { IAlert, ICheck, IClose, IRefresh } from "../icons";
import { Button, IconButton, ProviderMark } from "../primitives";
import { Command, ConfirmButton, ErrorLine, errText, fmtBytes, Group, Mono, Note, Row, Switch, Tag, useLoad } from "./ui";

// ---------- Providers ----------

function CliCard({ c }: { c: CliStatus }) {
  const state = !c.found ? "missing" : c.error ? "broken" : "ok";
  return (
    <Group
      attr={`cli-${c.provider}`}
      label={
        <>
          <ProviderMark provider={c.provider} size={12} /> {c.name}
        </>
      }
    >
      <Row
        attr={`cli-${c.provider}-status`}
        label="Status"
        k={`${c.name} cli version installed found broken`}
        desc={state === "ok" ? `Version ${c.version}` : state === "missing" ? `Not found on your PATH. coool can’t start ${c.name} chats until it’s installed.` : `Installed, but it doesn’t run.`}
        control={state === "ok" ? <Tag tone="ok">found</Tag> : state === "missing" ? <Tag>not found</Tag> : <Tag tone="err">broken</Tag>}
      >
        {c.error && (
          <Note tone="err">
            <span className="flex items-start gap-1.5">
              <IAlert size={13} className="mt-[2px] shrink-0 text-err-text" />
              <Mono className="text-fg/85">
                {c.error}
              </Mono>
            </span>
          </Note>
        )}
        {(c.fix || !c.found) && (
          <div className="flex flex-col gap-1.5">
            <div className="text-small text-dim">{c.found ? "To fix it, run this in a terminal, then Check again:" : "To install it, run this in a terminal, then Check again:"}</div>
            <Command cmd={c.fix ?? c.install} />
          </div>
        )}
      </Row>
      {c.path && <Row attr={`cli-${c.provider}-path`} label="Path" k={`${c.name} path binary`} desc={<Mono>{c.path}</Mono>} />}
      {state === "ok" && (
        <Row attr={`cli-${c.provider}-update`} label="Update" k={`${c.name} update upgrade install`} desc="coool uses whichever version is on your PATH. To update it:">
          <Command cmd={c.install} />
        </Row>
      )}
    </Group>
  );
}

export function Providers() {
  const { data, err, loading, reload } = useLoad<CliStatus[]>("cli", () => api().cliStatus());
  return (
    <>
      <div className="mb-5 flex items-center gap-3">
        <p className="min-w-0 flex-1 text-small text-faint">coool runs the Claude Code and Codex CLIs you installed, signed in with your own accounts. It never reads or shows their credentials.</p>
        <Button variant="outline" className="h-[30px] px-2.5 text-small" onClick={reload} disabled={loading} data-cli-recheck>
          <IRefresh size={13} className={loading ? "animate-spin" : undefined} />
          {loading ? "Checking…" : "Check again"}
        </Button>
      </div>
      {data ? data.map((c) => <CliCard key={c.provider} c={c} />) : !err && <div className="px-1 text-small text-faint">Looking for the CLIs…</div>}
      <ErrorLine>{err}</ErrorLine>
    </>
  );
}

// ---------- Devices ----------

const SIM_STATE: Record<string, string> = { Booted: "running", Booting: "starting", Shutdown: "off", "Shutting Down": "stopping" };

function IPhone() {
  const [list, setList] = useState<SimList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const storage = useLoad<StorageStatus>("storage", () => api().storageStatus());
  const read = () =>
    api()
      .simDevices()
      .then(setList)
      .catch((e) => setErr(errText(e)));
  useEffect(() => {
    void read();
    return api().onSimState(() => void read());
  }, []);
  const own: SimDevice | undefined = list?.devices.find((d) => d.coool);
  const size = storage.data?.simulator?.udid === own?.udid ? storage.data?.simulator?.bytes : undefined;
  const run = async (what: string, f: () => Promise<void>) => {
    setErr(null);
    setBusy(what);
    try {
      await f();
    } catch (e) {
      setErr(errText(e));
    }
    setBusy(null);
    void read();
    storage.reload();
  };
  const booted = own?.state === "Booted" || own?.state === "Booting";
  return (
    <Group label="iPhone" attr="devices-iphone">
      {!list ? (
        <Row label="Simulator" desc="…" />
      ) : !list.available ? (
        <Row attr="sim-unavailable" label="Simulator" desc={list.reason ?? "Not available on this Mac."} k="iphone ios xcode" />
      ) : !own ? (
        <Row attr="sim-none" label="Simulator" desc="coool makes its own iPhone simulator the first time you open the iPhone panel; your own simulators are never touched." k="iphone ios" />
      ) : (
        <>
          <Row
            attr="sim-device"
            label={own.name}
            k="iphone simulator ios device"
            desc={`${own.deviceType} · ${own.runtime} · ${size !== undefined ? fmtBytes(size) + " on disk" : "size…"}`}
            control={<Tag tone={booted ? "ok" : "off"}>{SIM_STATE[own.state] ?? own.state.toLowerCase()}</Tag>}
          />
          <Row
            attr="sim-shutdown"
            label="Shut down"
            desc="Stops the simulator to free memory. The iPhone panel boots it again when you open it."
            k="iphone stop memory"
            control={
              <Button variant="outline" className="h-[30px] px-2.5 text-small" disabled={!booted || !!busy} onClick={() => void run("shutdown", () => api().simShutdown(own.udid))}>
                {busy === "shutdown" ? "Shutting down…" : "Shut down"}
              </Button>
            }
          />
          <Row
            attr="sim-erase"
            label="Erase"
            desc="Resets coool’s iPhone to factory settings: apps installed on it, their data and sign-ins go. Your own simulators stay."
            k="iphone reset factory wipe"
            control={busy === "erase" ? <span className="text-small text-faint">Erasing…</span> : <ConfirmButton label="Erase…" confirm="Erase the iPhone" attr="sim-erase" disabled={!!busy} onConfirm={() => run("erase", () => api().simErase(own.udid))} />}
          />
        </>
      )}
      {err && (
        <div className="pb-3">
          <ErrorLine>{err}</ErrorLine>
        </div>
      )}
    </Group>
  );
}

function Mac() {
  const [st, setSt] = useState<MacStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api()
      .macStatus()
      .then((s) => live && setSt(s))
      .catch((e) => live && setErr(errText(e)));
    const off = api().onMacState((p) => setSt((s) => (s ? { ...s, ...p } : s)));
    return () => {
      live = false;
      off();
    };
  }, []);
  return (
    <Group label="Mac" attr="devices-mac" footer="The sandbox Mac sees one folder of this computer, its shared folder, and none of your other files.">
      {!st ? (
        <Row label="Sandbox Mac" desc={err ?? "…"} />
      ) : !st.available || st.state === "absent" ? (
        <Row attr="mac-none" label="Sandbox Mac" k="mac vm virtual machine" desc={!st.available ? (st.reason ?? "Not available on this Mac.") : "Not installed. Install it from the Mac panel (the Mac button in a chat's header)."} />
      ) : (
        <Row attr="mac-network" label="Network" k="mac vm network internet offline local sandbox shared folder" desc="What the sandbox Mac can reach. A change applies at once while it runs (it keeps its network device), else at the next boot.">
          <div className="rounded-[8px] bg-[color-mix(in_oklab,var(--dim)_8%,transparent)] px-3 py-2 text-small">
            <NetworkSwitch status={st} />
          </div>
        </Row>
      )}
    </Group>
  );
}

const DEVICE_NAME: Record<DeviceKind, string> = { browser: "Browser", iphone: "iPhone", mac: "Mac" };

/** What projects allowed the agents' device tools to do without asking ("Always in this project"), revocable. */
function Permissions() {
  const [rows, setRows] = useState<DeviceGrant[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [avail, setAvail] = useState(true);
  useEffect(() => {
    api()
      .deviceGrants()
      .then(setRows)
      .catch((e) => (isNotAvailable(e) ? setAvail(false) : setErr(errText(e))));
  }, []);
  const revoke = (project: string, device?: DeviceKind, site?: string) =>
    api()
      .deviceGrantsRevoke(project, device, site)
      .then(setRows)
      .catch((e) => setErr(errText(e)));
  const chip = (label: string, title: string, onRemove: () => void, attr: string) => (
    <span key={label} className="inline-flex items-center gap-1 rounded-[6px] border border-line bg-raised py-px pl-1.5 pr-0.5 text-small text-fg" data-grant={attr}>
      {label}
      <button type="button" title={title} aria-label={title} onClick={onRemove} className="flex size-[16px] items-center justify-center rounded-[4px] text-faint hover:bg-hover hover:text-fg">
        <IClose size={10} />
      </button>
    </span>
  );
  return (
    <Group
      label="Agent permissions"
      attr="devices-permissions"
      footer="In chats that ask before commands, agents ask before they first change something on a device, and always before a form submit, a password, a new site, a command in the Mac or an install. What a project allowed for good is listed here."
    >
      {!avail ? (
        <Row label="Allowed in projects" desc="Not available in this build of coool." />
      ) : !rows ? (
        <Row label="Allowed in projects" desc={err ?? "…"} />
      ) : rows.length === 0 ? (
        <Row attr="grants-none" label="Allowed in projects" k="permissions allow always project browser iphone mac sites" desc="Nothing yet. Choosing “Always … in this project” on a request adds it here." />
      ) : (
        rows.map((g) => (
          <Row
            key={g.project}
            attr={`grants-${g.project}`}
            label={<Mono>{homeShort(g.project)}</Mono>}
            k={`permissions allow always project ${g.project} ${g.devices.join(" ")} ${g.sites.join(" ")}`}
            control={<ConfirmButton label="Revoke all…" confirm="Revoke" attr="grants-revoke-all" onConfirm={() => revoke(g.project)} />}
          >
            <div className="flex flex-col gap-1.5 text-small text-dim">
              {g.devices.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="w-[64px] shrink-0 text-faint">Devices</span>
                  {g.devices.map((d) => chip(DEVICE_NAME[d], `Ask again before ${DEVICE_NAME[d]} changes in this project`, () => void revoke(g.project, d), `device-${d}`))}
                </div>
              )}
              {g.sites.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="w-[64px] shrink-0 text-faint">Sites</span>
                  {g.sites.map((s) => chip(s, `Ask again before opening ${s}`, () => void revoke(g.project, undefined, s), `site-${s}`))}
                </div>
              )}
            </div>
          </Row>
        ))
      )}
      {err && rows && (
        <div className="pb-3">
          <ErrorLine>{err}</ErrorLine>
        </div>
      )}
    </Group>
  );
}

function Pilot() {
  const [st, setSt] = useState<PilotLogStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [avail, setAvail] = useState(true);
  const storage = useLoad<StorageStatus>("storage", () => api().storageStatus());
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
      setErr(errText(e));
    }
  };
  const mem = storage.data?.items.find((i) => i.id === "pilot_memory");
  const empty = !st || st.files === 0;
  return (
    <Group label="Device pilot" attr="devices-pilot" footer="The fast pilot agents hand routine iPhone and Browser steps to (pilot_run).">
      <Row
        attr="pilot-memory"
        label="Learned routes"
        k="pilot memory muscle forget"
        desc={mem ? `${fmtBytes(mem.bytes)} in ${mem.files ?? 0} ${mem.files === 1 ? "file" : "files"}. The paths through apps the pilot verified, so it can repeat them without a model.` : "The paths through apps the pilot verified, so it can repeat them without a model."}
        control={
          <ConfirmButton
            label="Forget…"
            confirm="Forget learned routes"
            attr="pilot-forget"
            disabled={!mem || !mem.bytes}
            onConfirm={() =>
              api()
                .storageClear("pilot_memory")
                .then(storage.set)
                .catch((e) => setErr(errText(e)))
            }
          />
        }
      />
      <Row
        attr="pilot-log"
        label="Save pilot decisions for training"
        desc="Each step the pilot decides goes into a log on this Mac, for training a faster local pilot later. Nothing is uploaded."
        k="dataset training log"
        control={<Switch label="Save pilot decisions for training" on={!!st?.enabled} disabled={!st || !avail} onChange={(v) => void run(() => api().pilotLogSetEnabled(v))} />}
      >
        <Note>
          Never saved: what you or an agent typed (only the input’s name, like <span className="font-mono text-mono-small">email</span>), passwords and other hidden fields, screenshots, API keys.
        </Note>
      </Row>
      <Row
        attr="pilot-log-file"
        label="Decision log"
        k="pilot log folder"
        desc={
          !avail ? (
            "Not available in this build of coool."
          ) : st?.dir ? (
            <>
              <Mono>
                <span data-pilot-log-dir>{st.dir}</span>
              </Mono>
              <span className="mt-1 block text-faint" data-pilot-log-size={st.bytes}>
                {empty ? "Empty" : `${fmtBytes(st.bytes)} in ${st.files} ${st.files === 1 ? "file" : "files"}`} · at most about 40 MB per project
              </span>
            </>
          ) : (
            "…"
          )
        }
        control={
          avail &&
          st?.dir && (
            <>
              <Button variant="ghost" className="h-[30px] px-2.5 text-small" onClick={() => void run(() => api().pilotLogReveal())} data-pilot-log-reveal>
                Reveal
              </Button>
              <ConfirmButton
                label="Delete…"
                confirm="Delete the log"
                attr="pilot-log-delete"
                disabled={empty}
                onConfirm={() =>
                  run(async () => {
                    const s = await api().pilotLogDelete();
                    storage.reload();
                    return s;
                  })
                }
              />
            </>
          )
        }
      />
      {err && (
        <div className="pb-3">
          <ErrorLine>{err}</ErrorLine>
        </div>
      )}
    </Group>
  );
}

export function Devices() {
  return (
    <>
      <Group label="Browser" attr="devices-browser">
        <Row
          attr="browser-profile"
          label="Its own profile"
          k="browser cookies sign in web"
          desc="Pages in the Browser panel keep their sign-ins and cookies in coool, apart from Safari and Chrome. Agents in a chat see only the tabs of that chat."
        />
      </Group>
      <IPhone />
      <Mac />
      <Permissions />
      <Pilot />
    </>
  );
}

// ---------- Storage ----------

export function Storage() {
  const { data, err, loading, reload, set } = useLoad<StorageStatus>("storage", () => api().storageStatus());
  const [clearErr, setClearErr] = useState<string | null>(null);
  const total = (data?.items ?? []).reduce((n, i) => n + (i.bytes ?? 0), 0) + (data?.simulator?.bytes ?? 0);
  return (
    <>
      <div className="mb-5 flex items-center gap-3">
        <p className="min-w-0 flex-1 text-small text-faint">{data ? `${fmtBytes(total)} in all. Clearing never touches your projects or the CLIs’ own files.` : "Measuring…"}</p>
        <IconButton title="Measure again" onClick={reload} disabled={loading}>
          <IRefresh size={14} className={loading ? "animate-spin" : undefined} />
        </IconButton>
      </div>
      <Group label="On this Mac">
        {(data?.items ?? []).map((i) => (
          <Row
            key={i.id}
            attr={`storage-${i.id}`}
            label={i.label}
            k={`${i.desc} storage disk size clear cache`}
            desc={
              <>
                {i.desc}
                <span className="mt-0.5 block text-faint" data-storage-bytes={i.bytes ?? ""}>
                  {fmtBytes(i.bytes)}
                  {i.files ? ` · ${i.files} ${i.files === 1 ? "file" : "files"}` : ""}
                </span>
                {i.path && <Mono className="block text-faint">{homeShort(i.path)}</Mono>}
              </>
            }
            control={
              i.clearable ? (
                <ConfirmButton
                  label={`${i.clear_label ?? "Clear"}…`}
                  confirm={i.clear_label ?? "Clear"}
                  attr={`storage-clear-${i.id}`}
                  disabled={!i.bytes}
                  onConfirm={() =>
                    api()
                      .storageClear(i.id)
                      .then(set)
                      .catch((e) => setClearErr(errText(e)))
                  }
                />
              ) : (
                <span className="text-small text-faint">{i.id === "vm" ? "Managed by the Mac panel" : "In use"}</span>
              )
            }
          />
        ))}
        {data?.simulator && (
          <Row
            attr="storage-simulator"
            label="iPhone simulator"
            k="simulator iphone disk"
            desc={
              <>
                coool’s own simulator ({data.simulator.device_type}, {data.simulator.runtime}).
                <span className="mt-0.5 block text-faint">{fmtBytes(data.simulator.bytes)}</span>
              </>
            }
            control={<span className="text-small text-faint">Erase it in Devices</span>}
          />
        )}
        {!data && <Row label="Storage" desc={err ? err : "Measuring…"} />}
      </Group>
      <div className="px-1 pt-2">
        <ErrorLine>{clearErr}</ErrorLine>
      </div>
      {data && (
        <p className="flex items-center gap-1.5 px-1 pt-3 text-small text-faint">
          <ICheck size={13} className="shrink-0" /> The transcript cache rebuilds itself from Claude Code’s and Codex’s own files on the next start.
        </p>
      )}
    </>
  );
}
