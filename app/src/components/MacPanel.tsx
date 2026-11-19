// The Mac panel: the right panel's fifth kind (next to Jobs, Models, the browser and the iPhone). One sandboxed macOS
// virtual machine for the app (not per chat), streamed live (`macAttach` JPEG frames drawn to a canvas) while the panel
// shows it running. The person drives it with the pointer, wheel and keyboard (physical keys, `lib/macKeys.ts`, only
// while the screen has focus); the chats' agents drive it through the backend's MCP tools (`sim-activity` with
// `udid: "mac"`): each acting agent's cursor glides to where it acts, with a label, and a beam runs around the screen
// while one drives (components/Presence.tsx). The Mac is shared, so two chats can show two cursors at once.

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api, MAC_NETWORK_TRUTH, type MacInput, type MacNetworkMode, type MacStatus } from "../lib/backend";
import { macKeyCode } from "../lib/macKeys";
import { simTarget, usePresenceOf } from "../lib/presence";
import { Spinner, useBox } from "./DevicePanel";
import { IClose, IFolder, IGlobe, IGlobeLocal, IGlobeOff, IInfo, IMac } from "./icons";
import { PanelBeam, PresenceLayer } from "./Presence";
import { Button, cx, IconButton, Popover, Segmented } from "./primitives";
import { reducedMotion } from "./StepRail";

/** The agent's actions on the Mac arrive as `sim-activity` with this udid. */
export const MAC_UDID = "mac";
const DEFAULT_DIMS = { w: 1280, h: 800 };
const PAD = 12;
/** What installing takes (shown before it starts). */
export const DOWNLOAD_GB = 16;
export const NEEDS_GB = 40;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pct = (f?: number) => (f == null ? null : Math.max(0, Math.min(100, Math.round(f * 100))));
export const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(b >= 1e11 ? 0 : 1)} GB` : `${Math.max(0, Math.round(b / 1e6))} MB`);

export function macStateLabel(s: Pick<MacStatus, "state" | "progress" | "step">): string {
  const p = pct(s.progress?.fraction);
  switch (s.state) {
    case "absent":
      return "Not installed";
    case "downloading":
      return p == null ? "Downloading" : `Downloading ${p}%`;
    case "installing":
      return p == null ? "Installing" : `Installing ${p}%`;
    case "stopped":
      return "Off";
    case "starting":
      return "Starting";
    case "setting-up":
      return s.step ? `Setting up: ${s.step}` : "Setting up";
    case "running":
      return "Running";
    case "stopping":
      return "Shutting down";
  }
}
const busyState = (s: MacStatus["state"]) => s === "downloading" || s === "installing" || s === "starting" || s === "setting-up" || s === "stopping";

function StatePill({ status }: { status: MacStatus }) {
  const c = status.state === "running" ? "var(--accent)" : busyState(status.state) ? "var(--status-running)" : null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-small text-dim" title={macStateLabel(status)} data-mac-state={status.state}>
      <span
        className={cx("inline-block size-[7px] shrink-0 rounded-full", busyState(status.state) && "breathe")}
        style={c ? { background: c } : { boxShadow: "inset 0 0 0 1.3px var(--dim)" }}
        aria-hidden
      />
      <span className="min-w-0 truncate">{macStateLabel(status)}</span>
    </span>
  );
}

export function MacPanel({ chat, active, onClose }: { chat: number | null; active: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<MacStatus | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "install" | "boot" | "shutdown">(null);
  const [err, setErr] = useState<{ text: string; retry: () => void } | null>(null);
  const [confirm, setConfirm] = useState(false);

  const refresh = useCallback(
    () =>
      api()
        .macStatus()
        .then(
          (s) => {
            setStatus(s);
            setLoadErr(null);
          },
          (e) => setLoadErr(msg(e)),
        ),
    [],
  );
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);
  // `mac-state` is partial: merge it (a field it leaves out keeps its value; `progress`/`step` clear with their state).
  useEffect(
    () =>
      api().onMacState((p) =>
        setStatus((s) => {
          if (!s) return s;
          const n = { ...s, ...p };
          if (p.state && p.state !== s.state) {
            if (!("progress" in p)) n.progress = undefined;
            if (!("step" in p)) n.step = undefined;
            if (p.state === "stopped" || p.state === "running") n.installed = true;
            if (p.state === "running") n.provisioned = true;
          }
          return n;
        }),
      ),
    [],
  );
  // The chat's agent tools act on the Mac while its panel shows (SessionView unbinds when it closes).
  useEffect(() => {
    if (active && chat !== null) void api().macBind(chat, true).catch(() => {});
  }, [active, chat]);

  const run = (kind: "install" | "boot" | "shutdown", f: () => Promise<void>) => {
    setBusy(kind);
    setErr(null);
    void f()
      .catch((e) => setErr({ text: msg(e), retry: () => run(kind, f) }))
      .finally(() => {
        setBusy(null);
        void refresh();
      });
  };
  const install = () => {
    setConfirm(false);
    run("install", () => api().macInstall());
  };
  const boot = () => run("boot", () => api().macBoot());
  const shutdown = () => run("shutdown", () => api().macShutdown());

  const st = status?.state;
  const running = st === "running" && busy !== "shutdown";
  const starting = st === "starting" || st === "setting-up" || (busy === "boot" && st !== "running");
  const stopping = st === "stopping" || busy === "shutdown";
  const installing = st === "downloading" || st === "installing" || (busy === "install" && st === "absent");
  const shownErr = err ?? (status?.error ? { text: status.error, retry: st === "absent" ? () => setConfirm(true) : boot } : null);

  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const box = useBox(body);
  const shape = status && status.w > 0 && status.h > 0 ? { w: status.w, h: status.h } : DEFAULT_DIMS;

  let content: ReactNode;
  if (!status) {
    content = loadErr ? (
      <Empty title="Couldn't read the Mac's state" text={loadErr} action={<Button variant="outline" onClick={() => void refresh()}>Try again</Button>} />
    ) : null;
  } else if (!status.available) {
    content = <Empty title="No Mac here" text={status.reason ?? "The sandbox Mac needs a Mac with Apple silicon."} />;
  } else if (installing) {
    content = <InstallProgress status={status} />;
  } else if (st === "absent") {
    content = confirm ? (
      <InstallConfirm free={status.free} onCancel={() => setConfirm(false)} onInstall={install} />
    ) : (
      <Empty
        title="A Mac beside the chat"
        text="coool can run a sandboxed macOS virtual machine that you and the agent both use. It has its own disk, apps and accounts; nothing on this Mac is touched."
        action={
          <Button variant="primary" onClick={() => setConfirm(true)} data-mac-install>
            <IMac size={15} />
            Install the Mac
          </Button>
        }
        error={shownErr}
      />
    );
  } else if (running) {
    content = (
      <MacScreen active={active} box={box} initial={shape} onLost={() => void refresh()} />
    );
  } else {
    content = (
      <Frame box={box} d={shape}>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0b0b0d] px-4 text-center text-white/80">
          {starting || stopping ? (
            <>
              <Spinner />
              <span className="text-small font-medium">{stopping ? "Shutting down…" : st === "setting-up" ? "Setting up the Mac…" : "Starting…"}</span>
              {st === "setting-up" && <span className="max-w-[360px] text-small text-white/55">{status.step ?? "The first start sets the Mac up for coool. This takes a few minutes."}</span>}
            </>
          ) : shownErr ? (
            <>
              <span className="max-w-[360px] text-small text-white/70">{shownErr.text}</span>
              <Button variant="outline" onClick={shownErr.retry}>
                Try again
              </Button>
            </>
          ) : (
            <>
              <span className="text-small text-white/60">The Mac is off</span>
              <Button variant="primary" onClick={boot} className="bg-white text-black" data-mac-boot>
                Boot
              </Button>
            </>
          )}
        </div>
      </Frame>
    );
  }

  const available = !!status?.available;
  return (
    <div className="flex h-full flex-col" data-mac-panel={status ? (available ? status.state : "unavailable") : "loading"}>
      <div className="flex h-[40px] shrink-0 items-center gap-2 border-b border-hairline pl-3 pr-1.5">
        <IMac size={14} className="shrink-0 text-dim" />
        <span className="shrink-0 text-small font-medium text-fg">Mac</span>
        {status && available && <StatePill status={status} />}
        {status?.os && available && st !== "absent" && <span className="hidden shrink-0 text-small text-faint min-[520px]:inline">{status.os}</span>}
        <span className="min-w-0 flex-1" />
        {status &&
          available &&
          (st === "absent" ? (
            <Button className="h-[28px] px-2 text-small" disabled={installing || confirm} onClick={() => setConfirm(true)} title="Download and install macOS">
              Install
            </Button>
          ) : installing ? null : running || stopping ? (
            <Button className="h-[28px] px-2 text-small" disabled={stopping} onClick={shutdown} title="Shut the Mac down">
              Shut down
            </Button>
          ) : (
            <Button className="h-[28px] px-2 text-small" disabled={starting} onClick={boot} title="Boot the Mac">
              Boot
            </Button>
          ))}
        {status && available && st !== "absent" && <NetworkMark status={status} />}
        {status && available && st !== "absent" && <MacInfo status={status} />}
        <IconButton title="Close" onClick={onClose}>
          <IClose size={14} />
        </IconButton>
      </div>
      <div ref={setBody} className="relative min-h-0 flex-1 overflow-hidden">
        {content}
        {err && running && (
          <div className="absolute inset-x-3 top-3 z-10 flex items-center gap-2 rounded-[10px] border border-line bg-raised px-3 py-2 text-small shadow-card">
            <span className="min-w-0 flex-1 text-dim">{err.text}</span>
            <Button className="h-[26px] px-2 text-small" onClick={err.retry}>
              Retry
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export const NETWORK_LABEL: Record<MacNetworkMode, string> = { on: "On", local: "This computer only", off: "Off" };

/** What the Mac's network is now (running: what is attached; else the setting for the next boot), and when a change lands. */
export function macNetworkShown(s: Pick<MacStatus, "state" | "network" | "networkNow">): { now: MacNetworkMode; pending: MacNetworkMode | null } {
  const setting = s.network ?? "on";
  const now = s.state === "running" && s.networkNow ? s.networkNow : setting;
  return { now, pending: now !== setting ? setting : null };
}

/** The header's network mark: a globe (on), a globe around a house (this computer only), a crossed-out globe (off). */
function NetworkMark({ status }: { status: MacStatus }) {
  const { now, pending } = macNetworkShown(status);
  const Icon = now === "on" ? IGlobe : now === "local" ? IGlobeLocal : IGlobeOff;
  const tip = `Network: ${NETWORK_LABEL[now]}${pending ? ` (${NETWORK_LABEL[pending]} at the next boot)` : ""}. ${MAC_NETWORK_TRUTH[now]}`;
  return (
    <span className={cx("flex size-[26px] shrink-0 items-center justify-center", now === "on" ? "text-dim" : "text-fg")} title={tip} aria-label={tip} data-mac-network={now} data-mac-network-pending={pending ?? undefined}>
      <Icon size={14} />
    </span>
  );
}

/** The header's details: CPUs, memory, disk, the network, and the folder shared with the guest. */
function MacInfo({ status }: { status: MacStatus }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const [copied, setCopied] = useState(false);
  const specs = [
    status.cpus ? `${status.cpus} CPU${status.cpus === 1 ? "" : "s"}` : null,
    status.memoryMB ? `${status.memoryMB >= 1024 ? `${Math.round(status.memoryMB / 1024)} GB` : `${status.memoryMB} MB`} memory` : null,
    status.diskBytes ? `${gb(status.diskBytes)} on disk` : null,
  ].filter(Boolean);
  const copy = () => {
    if (!status.sharedDir) return;
    void navigator.clipboard
      ?.writeText(status.sharedDir)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {});
  };
  return (
    <div className="relative shrink-0">
      <span data-pop-anchor className="inline-flex">
        <IconButton title={specs.length ? `About this Mac: ${specs.join(" · ")}` : "About this Mac"} active={open} onClick={() => setOpen((o) => !o)}>
          <IInfo size={15} />
        </IconButton>
      </span>
      <Popover open={open} onClose={close} align="end" width={300}>
        <div className="flex flex-col gap-2 p-3 text-small" data-mac-info>
          <div className="font-medium text-fg">{status.os ?? "macOS"}</div>
          {specs.length > 0 && <div className="text-dim">{specs.join(" · ")}</div>}
          <NetworkSwitch status={status} />
          {status.sharedDir && (
            <div className="flex flex-col gap-1 border-t border-hairline pt-2">
              <div className="flex items-center gap-1.5 text-dim">
                <IFolder size={13} className="shrink-0" />
                Shared folder
                <span className="text-faint">(in the Mac: /Volumes/My Shared Files)</span>
              </div>
              <div className="flex items-start gap-1.5">
                <span className="min-w-0 flex-1 select-text break-all font-mono text-micro text-fg" data-mac-shared>
                  {status.sharedDir}
                </span>
                <Button className="h-[24px] px-1.5 text-micro" onClick={copy} title="Copy the folder's path">
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Popover>
    </div>
  );
}

/** The network switch (also in Settings > Devices), with its one line of plain truth. */
export function NetworkSwitch({ status }: { status: Pick<MacStatus, "state" | "network" | "networkNow"> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const { now, pending } = macNetworkShown(status);
  const pick = (m: MacNetworkMode) => {
    if (m === (status.network ?? "on")) return;
    setBusy(true);
    setErr(null);
    void api()
      .macNetwork(m)
      .then((r) => setNote(r.applies === "next boot" && status.state === "running" ? `${NETWORK_LABEL[m]} from the next boot: this Mac started without a network device.` : null))
      .catch((e) => setErr(msg(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col gap-1.5 border-t border-hairline pt-2" data-mac-network-switch>
      <div className="flex items-center gap-2 text-dim">
        <span className="min-w-0 flex-1">Network</span>
        <Segmented<MacNetworkMode>
          size="sm"
          value={status.network ?? "on"}
          onChange={pick}
          options={(["on", "local", "off"] as const).map((m) => ({ value: m, label: m === "local" ? "Local" : NETWORK_LABEL[m], disabled: busy, title: MAC_NETWORK_TRUTH[m] }))}
        />
      </div>
      <div className="text-faint" data-mac-network-truth>
        {MAC_NETWORK_TRUTH[now]}
        {pending ? ` ${NETWORK_LABEL[pending]} from the next boot.` : ""}
      </div>
      {note && <div className="text-faint">{note}</div>}
      {err && <div className="text-err-text">{err}</div>}
    </div>
  );
}

function InstallConfirm({ free, onCancel, onInstall }: { free?: number; onCancel: () => void; onInstall: () => void }) {
  const short = free != null && free < NEEDS_GB * 1e9;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center" data-mac-confirm>
      <IMac size={28} className="mb-1 text-faint" />
      <div className="text-base font-semibold text-fg">Download macOS?</div>
      <div className="max-w-[340px] text-small text-dim">
        It downloads about {DOWNLOAD_GB} GB from Apple and needs about {NEEDS_GB} GB of free disk. It can take 20 minutes or more; you can keep working meanwhile.
      </div>
      {free != null && <div className={cx("text-small", short ? "text-err" : "text-faint")}>{gb(free)} free on this Mac{short ? ": not enough room" : ""}</div>}
      <div className="mt-2 flex gap-2">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onInstall} disabled={short}>
          Download and install
        </Button>
      </div>
    </div>
  );
}

function InstallProgress({ status }: { status: MacStatus }) {
  const p = status.progress;
  const f = p?.fraction;
  const reduce = reducedMotion();
  const detail =
    p?.done != null && p.total ? `${gb(p.done)} of ${gb(p.total)}` : status.state === "installing" ? "Installing macOS on the Mac's disk" : "Downloading macOS from Apple";
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center" data-mac-progress>
      <IMac size={28} className="mb-1 text-faint" />
      <div className="text-base font-semibold text-fg">{macStateLabel(status)}</div>
      <div className="h-[4px] w-full max-w-[300px] overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--dim)_18%,transparent)]">
        {f != null ? (
          <motion.div className="h-full rounded-full bg-[var(--status-running)]" initial={false} animate={{ width: `${pct(f)}%` }} transition={{ duration: reduce ? 0 : 0.3, ease: "easeOut" }} />
        ) : (
          <div className={cx("h-full w-1/3 rounded-full bg-[var(--status-running)]", !reduce && "breathe")} />
        )}
      </div>
      <div className="text-small tabular-nums text-dim">{detail}</div>
      <div className="max-w-[300px] text-small text-faint">This takes a while; you can keep working.</div>
    </div>
  );
}

/**
 * The screen's box: the guest display's aspect, fitted to the panel body with padding, slightly rounded, a hairline
 * edge. `around`: the beam around it while an agent drives.
 */
function Frame({
  box,
  d,
  focused,
  around,
  children,
  ref,
  ...rest
}: { box: { w: number; h: number }; d: { w: number; h: number }; focused?: boolean; around?: { on: boolean; slot: number }; children: ReactNode; ref?: React.Ref<HTMLDivElement> } & React.HTMLAttributes<HTMLDivElement>) {
  const s = Math.max(0, Math.min((box.w - PAD * 2) / d.w, (box.h - PAD * 2) / d.h));
  const frame = (
    <div
      {...rest}
      ref={ref}
      className={cx(
        "relative size-full overflow-hidden rounded-[8px] bg-black outline-none ring-1 ring-inset transition-shadow duration-150",
        focused ? "ring-[1.5px] ring-[color-mix(in_oklab,var(--dim)_70%,transparent)]" : "ring-hairline",
      )}
    >
      {children}
    </div>
  );
  const size = { width: d.w * s, height: d.h * s, visibility: box.w ? ("visible" as const) : ("hidden" as const) };
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      {around ? (
        <PanelBeam on={around.on} slot={around.slot} radius={8} style={size}>
          {frame}
        </PanelBeam>
      ) : (
        <div className="relative" style={size}>
          {frame}
        </div>
      )}
    </div>
  );
}

/** Command keys: on macOS a key pressed while Command is held gets no keyup in WebKit, so they are released with it. */
const META = new Set([54, 55]);
const MODIFIERS = new Set([54, 55, 56, 57, 58, 59, 60, 61, 62, 63]);
/** Errors that mean the Mac is gone (not running, its helper stopped). */
const GONE = /isn.t running|helper stopped/;

/** The live screen of the running Mac: attached while `active`, driven by pointer, wheel and keyboard. `onLost`: the
 * screen or the input found the Mac gone (shut down from inside it, say), so the panel reads its state again. */
function MacScreen({ active, box, initial, onLost }: { active: boolean; box: { w: number; h: number }; initial: { w: number; h: number }; onLost: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const frameEl = useRef<HTMLDivElement>(null);
  const [d, setD] = useState(initial);
  const [attachErr, setAttachErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const lost = useEffectEvent(onLost);
  const [shown, setShown] = useState(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!active) return;
    let dead = false;
    let stream: number | null = null;
    // One decode at a time; frames that arrive meanwhile collapse into the newest.
    let decoding = false;
    let next: ArrayBuffer | null = null;
    const draw = (buf: ArrayBuffer) => {
      if (dead) return;
      if (decoding) {
        next = buf;
        return;
      }
      decoding = true;
      createImageBitmap(new Blob([buf], { type: "image/jpeg" }))
        .then(
          (bm) => {
            const c = canvas.current;
            if (!dead && c) {
              if (c.width !== bm.width || c.height !== bm.height) {
                c.width = bm.width;
                c.height = bm.height;
              }
              c.getContext("2d")?.drawImage(bm, 0, 0);
              setShown(true);
            }
            bm.close();
          },
          () => {},
        )
        .finally(() => {
          decoding = false;
          const n = next;
          next = null;
          if (n) draw(n);
        });
    };
    api()
      .macAttach(draw)
      .then(
        (r) => {
          if (dead) return void api().macDetach(r.stream).catch(() => {});
          stream = r.stream;
          if (r.w > 0 && r.h > 0) setD({ w: r.w, h: r.h });
        },
        (e) => {
          if (dead) return;
          setAttachErr(msg(e));
          if (GONE.test(msg(e))) lost();
        },
      );
    return () => {
      dead = true;
      if (stream !== null) void api().macDetach(stream).catch(() => {});
    };
    // `attempt`: "Try again" re-attaches.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [active, attempt]);

  // The agents acting on it (in guest pixels): their cursors over the screen, the beam around it.
  const presence = usePresenceOf(simTarget(MAC_UDID));

  // ---- input ----
  // One call at a time, in order: the backend runs each call on a thread of its own, so two calls in flight can reach
  // the Mac in either order (a key's up before its down loses the key; keys before the click that focuses a field land
  // elsewhere). What comes in while a call is in flight goes in the next one, as a batch.
  const queue = useRef<MacInput[]>([]);
  const sending = useRef(false);
  const flush = () => {
    const batch = queue.current.splice(0);
    if (!batch.length) {
      sending.current = false;
      return;
    }
    sending.current = true;
    void api()
      .macInput(batch)
      .catch((e) => GONE.test(msg(e)) && onLost())
      .finally(flush);
  };
  const send = (input: MacInput) => {
    queue.current.push(input);
    if (!sending.current) flush();
  };
  const buttons = useRef(0);
  const at = useRef({ x: 0, y: 0 });
  const moveAt = useRef<{ x: number; y: number } | null>(null);
  const moveRaf = useRef(0);
  const wheel = useRef({ dx: 0, dy: 0, raf: 0 });
  const held = useRef(new Set<number>());
  useEffect(
    () => () => {
      cancelAnimationFrame(moveRaf.current);
      cancelAnimationFrame(wheel.current.raf);
    },
    [],
  );
  const dRef = useRef(d);
  useLayoutEffect(() => {
    dRef.current = d;
  }, [d]);
  const toPx = (e: { clientX: number; clientY: number }) => {
    const d = dRef.current;
    const r = canvas.current!.getBoundingClientRect();
    const cl = (v: number, max: number) => Math.round(Math.min(max - 1, Math.max(0, v)));
    const p = { x: cl(((e.clientX - r.left) / (r.width || 1)) * d.w, d.w), y: cl(((e.clientY - r.top) / (r.height || 1)) * d.h, d.h) };
    at.current = p;
    return p;
  };
  // Browser `buttons` (1 left, 2 right, 4 middle) to the guest's (1 left, 2 right).
  const btns = (b: number) => b & 3;
  const flushMove = () => {
    moveRaf.current = 0;
    const m = moveAt.current;
    moveAt.current = null;
    if (m) send({ kind: "pointer", ...m, buttons: buttons.current });
  };
  const releaseKeys = (only?: (code: number) => boolean) => {
    for (const code of held.current) {
      if (only && !only(code)) continue;
      held.current.delete(code);
      send({ kind: "keyUp", code });
    }
  };
  const releaseAll = () => {
    releaseKeys();
    if (buttons.current) {
      buttons.current = 0;
      send({ kind: "pointer", ...at.current, buttons: 0 });
    }
  };

  // The wheel: native and non-passive so the page never scrolls; deltas coalesced to one event per frame.
  useEffect(() => {
    const el = frameEl.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const w = wheel.current;
      w.dx += -e.deltaX * k;
      w.dy += -e.deltaY * k;
      const p = toPx(e);
      if (w.raf) return;
      w.raf = requestAnimationFrame(() => {
        w.raf = 0;
        const dx = Math.round(w.dx);
        const dy = Math.round(w.dy);
        w.dx = 0;
        w.dy = 0;
        if (dx || dy) send({ kind: "scroll", ...p, dx, dy });
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // toPx and send read refs and the canvas only.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies, react-hooks/exhaustive-deps
  }, []);

  const pasteWait = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onKeyDown = (e: React.KeyboardEvent) => {
    // Every key is the Mac's while it has focus (Escape too: the panel doesn't close).
    e.stopPropagation();
    if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyV") {
      // Paste this Mac's clipboard as text: Command goes up in the guest first, so it types rather than shortcuts.
      releaseKeys((c) => META.has(c));
      clearTimeout(pasteWait.current);
      // Let the paste event carry the text; if the webview sends none, read the clipboard.
      pasteWait.current = setTimeout(() => {
        void navigator.clipboard
          ?.readText()
          .then((t) => t && send({ kind: "text", text: t }))
          .catch(() => {});
      }, 80);
      return;
    }
    e.preventDefault();
    const code = macKeyCode(e.code);
    if (code == null || e.repeat) return; // the guest repeats held keys itself
    held.current.add(code);
    send({ kind: "keyDown", code });
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const code = macKeyCode(e.code);
    if (code == null) return;
    if (held.current.delete(code)) send({ kind: "keyUp", code });
    if (META.has(code)) releaseKeys((c) => !MODIFIERS.has(c));
  };

  return (
    <Frame
      box={box}
      d={d}
      focused={focused}
      around={{ on: presence.driving, slot: presence.slot }}
      ref={frameEl}
      tabIndex={0}
      role="application"
      aria-label="Mac screen"
      data-mac-screen
      data-key-capture
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        releaseAll();
      }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onPaste={(e) => {
        clearTimeout(pasteWait.current);
        const t = e.clipboardData.getData("text/plain");
        if (t) send({ kind: "text", text: t });
        e.preventDefault();
      }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (attachErr || (e.button !== 0 && e.button !== 2)) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).focus({ preventScroll: true });
        e.currentTarget.setPointerCapture(e.pointerId);
        cancelAnimationFrame(moveRaf.current);
        moveRaf.current = 0;
        moveAt.current = null;
        buttons.current = btns(e.buttons) || (e.button === 2 ? 2 : 1);
        send({ kind: "pointer", ...toPx(e), buttons: buttons.current });
      }}
      onPointerMove={(e) => {
        if (attachErr) return;
        moveAt.current = toPx(e);
        if (!moveRaf.current) moveRaf.current = requestAnimationFrame(flushMove);
      }}
      onPointerUp={(e) => {
        if (!buttons.current) return;
        cancelAnimationFrame(moveRaf.current);
        moveRaf.current = 0;
        moveAt.current = null;
        buttons.current = btns(e.buttons);
        send({ kind: "pointer", ...toPx(e), buttons: buttons.current });
      }}
      onPointerCancel={() => {
        if (!buttons.current) return;
        buttons.current = 0;
        send({ kind: "pointer", ...at.current, buttons: 0 });
      }}
    >
      <canvas ref={canvas} className="absolute inset-0 size-full touch-none select-none" />
      {!shown && !attachErr && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0b0b0d]">
          <Spinner />
        </div>
      )}
      {attachErr && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0b0b0d] px-4 text-center">
          <span className="text-small text-white/70">Couldn't show the screen: {attachErr}</span>
          <Button
            variant="outline"
            onClick={() => {
              setAttachErr(null);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </div>
      )}
      <PresenceLayer target={simTarget(MAC_UDID)} d={d} />
      <KeyboardHint on={focused} onRelease={() => frameEl.current?.blur()} />
    </Frame>
  );
}

/** While the screen has focus: keys go to the Mac (Escape too), so say so and offer a way out. */
function KeyboardHint({ on, onRelease }: { on: boolean; onRelease: () => void }) {
  const reduce = reducedMotion();
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
      <AnimatePresence>
        {on && (
          <motion.div
            initial={{ opacity: 0, y: reduce ? 0 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.18 }}
            className="pointer-events-auto flex h-[24px] items-center gap-1.5 rounded-full bg-[rgb(0_0_0/0.55)] pl-2.5 pr-1 text-micro text-white/85 backdrop-blur-md"
            data-mac-captured
            // Pressing the hint is no click on the Mac, and doesn't move focus before Release lands.
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            Keyboard goes to the Mac
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRelease();
              }}
              className="rounded-full bg-white/15 px-2 py-[2px] font-medium text-white hover:bg-white/25"
            >
              Release
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Empty({ title, text, action, error }: { title: string; text: string; action?: ReactNode; error?: { text: string; retry: () => void } | null }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <IMac size={28} className="mb-1 text-faint" />
      <div className="text-base font-semibold text-fg">{title}</div>
      <div className="max-w-[340px] text-small text-dim">{text}</div>
      {action && <div className="mt-2">{action}</div>}
      {error && <div className="mt-1 max-w-[340px] text-small text-err">{error.text}</div>}
    </div>
  );
}
