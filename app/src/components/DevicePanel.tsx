// The iPhone panel: the right panel's fourth kind (next to Jobs, Models and the browser). It shows one iOS Simulator
// per session (store `device[key]`), streamed live (`simAttach` JPEG frames drawn to a canvas) while the panel shows a
// booted device; the person drives it with the pointer and keyboard, and the chat's agent drives it through the
// backend's MCP tools: each acting agent's cursor glides to where it acts, with a label, and a beam runs around the
// screen while one drives (components/Presence.tsx). No device bezel art.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type SimDevice, type SimInput, type SimList } from "../lib/backend";
import { simTarget, usePresenceOf } from "../lib/presence";
import { useStore } from "../store";
import { ICaret, ICheck, IClose, IHome, ILock, IPhone } from "./icons";
import { PanelBeam, PresenceLayer } from "./Presence";
import { Button, cx, IconButton, Popover } from "./primitives";
import { reducedMotion } from "./StepRail";

/** Each device's screen size in points, as its last `simAttach` reported it (placeholders keep the same shape). */
const dims = new Map<string, { w: number; h: number }>();
const DEFAULT_DIMS = { w: 402, h: 874 };
const PAD = 18;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const stateLabel = (s: string) => (s === "Shutdown" ? "Shut down" : s === "Shutting Down" ? "Shutting down" : s || "Unknown");
const stateColor = (s: string) => (s === "Booted" ? "var(--accent)" : s === "Booting" || s === "Shutting Down" ? "var(--status-running)" : null);

function StateDot({ state }: { state: string }) {
  const c = stateColor(state);
  return (
    <span
      className="inline-block size-[7px] shrink-0 rounded-full"
      style={c ? { background: c } : { boxShadow: "inset 0 0 0 1.3px var(--dim)" }}
      aria-hidden
    />
  );
}

export function DevicePanel({ panelKey, chat, active, onClose }: { panelKey: string; chat: number | null; active: boolean; onClose: () => void }) {
  const udid = useStore((s) => s.device[panelKey]?.udid ?? null);
  const setDevice = useStore((s) => s.setDevice);
  const [list, setList] = useState<SimList | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "boot" | "shutdown" | "setup">(null);
  const [err, setErr] = useState<{ text: string; retry: () => void } | null>(null);

  const refresh = useCallback(
    () =>
      api()
        .simDevices()
        .then(
          (l) => {
            setList(l);
            setListErr(null);
            return l;
          },
          (e) => {
            setListErr(msg(e));
            return null;
          },
        ),
    [],
  );
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);
  useEffect(() => api().onSimState(({ udid: u, state }) => setList((l) => l && { ...l, devices: l.devices.map((d) => (d.udid === u ? { ...d, state } : d)) })), []);

  // coool's own devices first, then the person's other simulators.
  const devices = useMemo(() => (list ? [...list.devices.filter((d) => d.coool), ...list.devices.filter((d) => !d.coool)] : []), [list]);
  const device = devices.find((d) => d.udid === udid) ?? null;
  const pick = useCallback(
    (u: string) => {
      setDevice(panelKey, u);
      // The chat's agent acts on the device its panel shows.
      if (chat !== null) void api().simBind(chat, u).catch(() => {});
    },
    [panelKey, chat, setDevice],
  );
  // No device yet (or it's gone): coool's first one. A device the list doesn't know yet (just made) gets one re-read first.
  const recheck = useRef<string | null>(null);
  useEffect(() => {
    if (!list?.available || device) return;
    if (udid && recheck.current !== udid) {
      recheck.current = udid;
      void refresh();
      return;
    }
    const first = devices.find((d) => d.coool);
    if (first) pick(first.udid);
  }, [list, device, devices, udid, pick, refresh]);

  const run = (kind: "boot" | "shutdown" | "setup", f: () => Promise<void>) => {
    setBusy(kind);
    setErr(null);
    void f()
      .catch((e) => setErr({ text: msg(e), retry: () => run(kind, f) }))
      .finally(() => {
        setBusy(null);
        void refresh();
      });
  };
  const boot = (u: string) => run("boot", () => api().simBoot(u));
  const shutdown = (u: string) => run("shutdown", () => api().simShutdown(u));
  const setup = () =>
    run("setup", async () => {
      const u = await api().simEnsureDevice();
      pick(u);
      await refresh();
      await api().simBoot(u);
    });
  const press = (name: "home" | "lock") => udid && void api().simInput(udid, { kind: "button", name }).catch(() => {});

  const st = device?.state ?? "";
  const booted = st === "Booted" && busy !== "shutdown";
  const booting = busy === "boot" || busy === "setup" || st === "Booting";
  const stopping = busy === "shutdown" || st === "Shutting Down";

  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const box = useBox(body);
  const shape = (udid && dims.get(udid)) || DEFAULT_DIMS;

  let content: ReactNode;
  if (!list) {
    content = listErr ? (
      <Empty title="Couldn't list the simulators" text={listErr} action={<Button variant="outline" onClick={() => void refresh()}>Try again</Button>} />
    ) : null;
  } else if (!list.available) {
    content = <Empty title="No iPhone here" text={list.reason ?? "The iOS Simulator needs macOS with Xcode installed."} />;
  } else if (!device) {
    content = devices.some((d) => d.coool) ? null : (
      <Empty
        title="An iPhone beside the chat"
        text="coool sets up its own simulator, “coool iPhone”, that you and the agent can both use. Your other simulators stay as they are."
        action={
          <Button variant="primary" onClick={setup} disabled={busy === "setup"}>
            <IPhone size={15} />
            {busy === "setup" ? "Setting up…" : "Set up iPhone"}
          </Button>
        }
        error={err}
      />
    );
  } else if (booted) {
    content = (
      <SimScreen key={device.udid} udid={device.udid} active={active} box={box} />
    );
  } else {
    content = (
      <Frame box={box} d={shape}>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0b0b0d] px-4 text-center text-white/80">
          {booting || stopping ? (
            <>
              <Spinner />
              <span className="text-small font-medium">{stopping ? "Shutting down…" : "Booting…"}</span>
            </>
          ) : err ? (
            <>
              <span className="text-small text-white/70">{err.text}</span>
              <Button variant="outline" onClick={err.retry}>
                Try again
              </Button>
            </>
          ) : (
            <>
              <span className="text-small text-white/60">{device.name} is shut down</span>
              <Button variant="primary" onClick={() => boot(device.udid)} className="bg-white text-black">
                Boot
              </Button>
            </>
          )}
        </div>
      </Frame>
    );
  }

  return (
    <div className="flex h-full flex-col" data-device-panel={device?.state ?? (list ? (list.available ? "none" : "unavailable") : "loading")}>
      <div className="flex h-[40px] shrink-0 items-center gap-0.5 border-b border-hairline pl-2 pr-1.5">
        <DevicePicker devices={devices} current={device} onPick={pick} disabled={!list?.available || !devices.length} />
        <span className="min-w-0 flex-1" />
        {device &&
          (booted || stopping ? (
            <Button className="h-[28px] px-2 text-small" disabled={stopping} onClick={() => shutdown(device.udid)} title="Shut the simulator down">
              Shut down
            </Button>
          ) : (
            <Button className="h-[28px] px-2 text-small" disabled={booting} onClick={() => boot(device.udid)} title="Boot the simulator">
              Boot
            </Button>
          ))}
        <IconButton title="Home (⇧⌘H)" disabled={!booted} onClick={() => press("home")}>
          <IHome size={15} />
        </IconButton>
        <IconButton title="Lock" disabled={!booted} onClick={() => press("lock")}>
          <ILock size={15} />
        </IconButton>
        <IconButton title="Close" onClick={onClose}>
          <IClose size={14} />
        </IconButton>
      </div>
      <div ref={setBody} className="relative min-h-0 flex-1 overflow-hidden">
        {content}
        {device && err && booted && (
          <div className="absolute inset-x-3 top-3 flex items-center gap-2 rounded-[10px] border border-line bg-raised px-3 py-2 text-small shadow-card">
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

export function useBox(el: HTMLElement | null) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return box;
}

/**
 * The screen's box: the device's aspect, fitted to the panel body with padding, rounded, a hairline edge. `around`:
 * the beam around it while an agent drives.
 */
function Frame({
  box,
  d,
  focused,
  around,
  children,
  ...rest
}: { box: { w: number; h: number }; d: { w: number; h: number }; focused?: boolean; around?: { on: boolean; slot: number }; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  const s = Math.max(0, Math.min((box.w - PAD * 2) / d.w, (box.h - PAD * 2) / d.h));
  const w = d.w * s;
  const h = d.h * s;
  // The screen's corners as the device has them: a tall, all-screen iPhone's display corner is about an eighth of its
  // width; a device with square display corners (an older iPhone, an iPad) gets a small one.
  const radius = d.h / d.w > 1.9 ? w * 0.125 : w * 0.03;
  const frame = (
    <div
      {...rest}
      className={cx(
        "relative size-full overflow-hidden bg-black outline-none ring-1 ring-inset transition-shadow duration-150",
        focused ? "ring-[1.5px] ring-[color-mix(in_oklab,var(--dim)_70%,transparent)]" : "ring-hairline",
      )}
      style={{ borderRadius: radius }}
    >
      {children}
    </div>
  );
  const size = { width: w, height: h, visibility: box.w ? ("visible" as const) : ("hidden" as const) };
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      {around ? (
        <PanelBeam on={around.on} slot={around.slot} radius={radius} style={size}>
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

const KEYS: Record<string, string> = {
  Enter: "return",
  Backspace: "backspace",
  Tab: "tab",
  Escape: "escape",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/** The live screen of a booted device: attached while `active`, driven by pointer and keyboard. */
function SimScreen({ udid, active, box }: { udid: string; active: boolean; box: { w: number; h: number } }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [d, setD] = useState(() => dims.get(udid) ?? DEFAULT_DIMS);
  const [attachErr, setAttachErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
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
      .simAttach(udid, draw)
      .then(
        (r) => {
          if (dead) return void api().simDetach(udid, r.stream).catch(() => {});
          stream = r.stream;
          dims.set(udid, { w: r.w, h: r.h });
          setD({ w: r.w, h: r.h });
        },
        (e) => !dead && setAttachErr(msg(e)),
      );
    return () => {
      dead = true;
      if (stream !== null) void api().simDetach(udid, stream).catch(() => {});
    };
    // `attempt`: "Try again" re-attaches.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [udid, active, attempt]);

  // The agents acting on it: their cursors over the screen, the beam around it.
  const presence = usePresenceOf(simTarget(udid));

  // Input, in device points.
  const send = (input: SimInput) => void api().simInput(udid, input).catch(() => {});
  const down = useRef(false);
  const moveAt = useRef<{ x: number; y: number } | null>(null);
  const raf = useRef(0);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const toPt = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const cl = (v: number, max: number) => Math.round(Math.min(max, Math.max(0, v)) * 10) / 10;
    return { x: cl(((e.clientX - r.left) / (r.width || 1)) * d.w, d.w), y: cl(((e.clientY - r.top) / (r.height || 1)) * d.h, d.h) };
  };
  const pasteWait = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key;
    const cmd = e.metaKey && !e.ctrlKey && !e.altKey;
    if (cmd && !e.shiftKey && k.toLowerCase() === "v") {
      // Let the paste event carry the text; if the webview sends none (nothing editable is focused), read the clipboard.
      clearTimeout(pasteWait.current);
      pasteWait.current = setTimeout(() => {
        void navigator.clipboard
          ?.readText()
          .then((t) => t && send({ kind: "text", text: t }))
          .catch(() => {});
      }, 80);
      e.stopPropagation();
      return;
    }
    if (cmd && e.shiftKey && k.toLowerCase() === "h") send({ kind: "button", name: "home" });
    else if (e.metaKey || e.ctrlKey) return; // app shortcuts pass through
    else if (KEYS[k]) send({ kind: "key", name: KEYS[k], ...(e.shiftKey ? { modifiers: ["shift" as const] } : {}) });
    else if ([...k].length === 1) send({ kind: "text", text: k });
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <Frame
      box={box}
      d={d}
      focused={focused}
      around={{ on: presence.driving, slot: presence.slot }}
      tabIndex={0}
      role="application"
      aria-label="iPhone screen"
      data-sim-screen={udid}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={onKeyDown}
      onPaste={(e) => {
        clearTimeout(pasteWait.current);
        const t = e.clipboardData.getData("text/plain");
        if (t) send({ kind: "text", text: t });
        e.preventDefault();
      }}
      onPointerDown={(e) => {
        if (e.button !== 0 || attachErr) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).focus({ preventScroll: true });
        e.currentTarget.setPointerCapture(e.pointerId);
        down.current = true;
        send({ kind: "touch", phase: "down", ...toPt(e) });
      }}
      onPointerMove={(e) => {
        if (!down.current) return;
        moveAt.current = toPt(e);
        if (raf.current) return;
        raf.current = requestAnimationFrame(() => {
          raf.current = 0;
          const m = moveAt.current;
          moveAt.current = null;
          if (m && down.current) send({ kind: "touch", phase: "move", ...m });
        });
      }}
      onPointerUp={(e) => {
        if (!down.current) return;
        down.current = false;
        cancelAnimationFrame(raf.current);
        raf.current = 0;
        moveAt.current = null;
        send({ kind: "touch", phase: "up", ...toPt(e) });
      }}
      onPointerCancel={(e) => {
        if (!down.current) return;
        down.current = false;
        send({ kind: "touch", phase: "up", ...toPt(e) });
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
      <PresenceLayer target={simTarget(udid)} d={d} />
    </Frame>
  );
}

export function Spinner() {
  return <span className={cx("size-[20px] rounded-full border-2 border-white/20 border-t-white/85", !reducedMotion() && "spin")} aria-label="Loading" />;
}

function Empty({ title, text, action, error }: { title: string; text: string; action?: ReactNode; error?: { text: string; retry: () => void } | null }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <IPhone size={28} className="mb-1 text-faint" />
      <div className="text-base font-semibold text-fg">{title}</div>
      <div className="max-w-[300px] text-small text-dim">{text}</div>
      {action && <div className="mt-2">{action}</div>}
      {error && <div className="mt-1 max-w-[300px] text-small text-err">{error.text}</div>}
    </div>
  );
}

/** The device picker: coool's own simulators first, then the person's others under a quiet label. */
function DevicePicker({ devices, current, onPick, disabled }: { devices: SimDevice[]; current: SimDevice | null; onPick: (udid: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const mine = devices.filter((d) => d.coool);
  const theirs = devices.filter((d) => !d.coool);
  const row = (d: SimDevice) => (
    <button
      key={d.udid}
      type="button"
      onClick={() => {
        setOpen(false);
        onPick(d.udid);
      }}
      className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left hover:bg-hover"
      data-sim-device={d.udid}
    >
      <StateDot state={d.state} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-small font-medium text-fg">{d.name}</span>
        <span className="block truncate text-micro text-dim">
          {[d.deviceType !== d.name ? d.deviceType : null, d.runtime, stateLabel(d.state)].filter(Boolean).join(" · ")}
        </span>
      </span>
      {current?.udid === d.udid && <ICheck size={13} className="shrink-0 text-dim" />}
    </button>
  );
  return (
    <div className="relative min-w-0 shrink">
      <button
        type="button"
        data-pop-anchor
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title={current ? `${current.name} · ${current.deviceType} · ${current.runtime}` : "Choose a simulator"}
        className={cx(
          "inline-flex h-[28px] max-w-full items-center gap-1.5 rounded-[8px] px-2 text-small font-medium transition-[background-color,color] duration-150 disabled:opacity-45",
          open ? "bg-press text-fg" : "text-fg hover:bg-hover",
        )}
      >
        {current ? <StateDot state={current.state} /> : <IPhone size={13} className="shrink-0 text-dim" />}
        <span className="min-w-0 truncate">{current?.name ?? "iPhone"}</span>
        {current && <span className="shrink-0 font-normal text-dim">{stateLabel(current.state)}</span>}
        <ICaret size={11} className="shrink-0 text-dim" />
      </button>
      <Popover open={open} onClose={close} width={280}>
        <div className="max-h-[360px] overflow-y-auto p-1">
          {mine.map(row)}
          {theirs.length > 0 && (
            <>
              <div className="px-2 pb-1 pt-2 text-micro font-medium text-faint">Your simulators</div>
              {theirs.map(row)}
            </>
          )}
        </div>
      </Popover>
    </div>
  );
}
