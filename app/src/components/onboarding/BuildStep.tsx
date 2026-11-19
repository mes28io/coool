// "What are you building?": what the person works on (saved with the app's prefs, editable in Settings > General),
// and from it which device panels coool sets up. The Browser is built in. The iPhone and the sandbox Mac are set up
// only when their box is ticked as the person continues, through the panels' own commands (`sim_ensure_device`,
// `mac_install`), in the background: progress shows where it always does (the panel, Settings > Devices), and a
// failed or cancelled set-up leaves the panel's usual "not set up" state with its own button. Skip installs nothing.

import { motion } from "motion/react";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { api, type MacStatus, type SimList } from "../../lib/backend";
import { useMotion } from "../../lib/motion";
import { updateAppPrefs, useAppPrefs } from "../../lib/prefs";
import type { Building } from "../../lib/settingsTypes";
import { useOnboarding } from "../../lib/onboarding";
import { useStore } from "../../store";
import { DOWNLOAD_GB, gb, macStateLabel, NEEDS_GB } from "../MacPanel";
import { ICheck, IGlobe, IMac, IPhone, ITerminal } from "../icons";
import { cx } from "../primitives";
import { Command } from "../settings/ui";

export const BUILD_KINDS: { id: Building; label: string; line: string; icon: ReactNode }[] = [
  { id: "mobile", label: "Mobile apps", line: "iOS, in an iPhone simulator", icon: <IPhone size={17} /> },
  { id: "web", label: "Websites, web apps", line: "Pages to open and test", icon: <IGlobe size={17} /> },
  { id: "desktop", label: "Mac, desktop apps", line: "On a sandbox Mac", icon: <IMac size={17} /> },
  { id: "other", label: "Backend and CLIs", line: "Libraries too: nothing extra", icon: <ITerminal size={17} /> },
];

type Dev = "iphone" | "mac";
/** Which answer recommends which device (the Browser is always there). */
const FOR: Record<Dev, Building> = { iphone: "mobile", mac: "desktop" };

/** The step's choices, kept for its run of the flow (Back and forth keep them; a new run starts from the saved answer). */
interface Choice {
  run: number;
  /** null until the person picks: the saved answer shows meanwhile (none on a first run, so nothing is preselected). */
  picks: Building[] | null;
  ticks: Record<Dev, boolean>;
}
/** What Continue acts on: the step's choices as last shown, and what can be set up right now (Xcode with a runtime,
 *  room on disk). Written after each render of the step. */
const shown: { picks: Building[]; ticks: Record<Dev, boolean>; can: Record<Dev, boolean>; c: Choice | null } = {
  picks: [],
  ticks: { iphone: false, mac: false },
  can: { iphone: false, mac: false },
  c: null,
};

/** What Continue does: saves the answer and starts each ticked set-up in the background. */
export function commitBuild() {
  const c = shown;
  if (!c.c || c.c.run !== useOnboarding.getState().run) return;
  void updateAppPrefs({ building: c.picks }).catch(() => {});
  const toast = useStore.getState().toast;
  if (c.ticks.iphone && c.can.iphone) {
    void api()
      .simEnsureDevice()
      .catch((e) => toast(`The iPhone wasn’t set up: ${e instanceof Error ? e.message : String(e)}. Try again from the iPhone panel.`, "error"));
  }
  if (c.ticks.mac && c.can.mac) {
    void api()
      .macInstall()
      .catch((e) => toast(`The sandbox Mac wasn’t installed: ${e instanceof Error ? e.message : String(e)}. Try again from the Mac panel.`, "error"));
  }
}

export function BuildStep() {
  const run = useOnboarding((s) => s.run);
  const [prefs] = useAppPrefs();
  const reduce = useMotion().reduce;
  const [c, setC] = useState<Choice>(() => (shown.c?.run === run ? shown.c : { run, picks: null, ticks: { iphone: false, mac: false } }));
  // A re-opened flow starts from the saved answer; its devices stay unticked until the person picks.
  const saved = prefs?.building;
  const picks = c.picks ?? saved ?? [];

  const [sim, setSim] = useState<SimList | "err" | null>(null);
  const [mac, setMac] = useState<MacStatus | "err" | null>(null);
  useEffect(() => {
    let live = true;
    api()
      .simDevices()
      .then((v) => live && setSim(v))
      .catch(() => live && setSim("err"));
    api()
      .macStatus()
      .then((v) => live && setMac(v))
      .catch(() => live && setMac("err"));
    const off = api().onMacState((p) => setMac((s) => (s && s !== "err" ? { ...s, ...p } : s)));
    return () => {
      live = false;
      off();
    };
  }, []);

  const iphone = iphoneRow(sim);
  const macR = macRow(mac);
  const can: Record<Dev, boolean> = { iphone: iphone.can, mac: macR.can };
  const iCan = iphone.can;
  const mCan = macR.can;
  useLayoutEffect(() => {
    Object.assign(shown, { c, picks: c.picks ?? saved ?? [], ticks: c.ticks, can: { iphone: iCan, mac: mCan } });
  }, [c, saved, iCan, mCan]);

  const pick = (k: Building) =>
    setC((x) => {
      const cur = x.picks ?? saved ?? [];
      const next = cur.includes(k) ? cur.filter((p) => p !== k) : [...cur, k];
      const ticks = { ...x.ticks };
      for (const d of ["iphone", "mac"] as Dev[]) if (FOR[d] === k) ticks[d] = next.includes(k);
      return { ...x, picks: next, ticks };
    });
  const tick = (d: Dev) => setC((x) => ({ ...x, ticks: { ...x.ticks, [d]: !x.ticks[d] } }));

  const going = (["iphone", "mac"] as Dev[]).filter((d) => c.ticks[d] && can[d]);
  const summary = going.length ? `Continue sets up ${going.map((d) => (d === "iphone" ? "the iPhone" : "the sandbox Mac")).join(" and ")}, in the background.` : "Nothing will be installed.";

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="What are you building? Pick any that apply" data-onb-build>
        {BUILD_KINDS.map((k) => {
          const on = picks.includes(k.id);
          return (
            <button
              key={k.id}
              type="button"
              aria-pressed={on}
              onClick={() => pick(k.id)}
              data-onb-kind={k.id}
              className={cx(
                "flex flex-col items-start gap-0.5 rounded-[12px] border px-3 py-2 text-left transition-colors duration-150",
                on ? "border-[color-mix(in_oklab,var(--accent)_50%,var(--border))] bg-accent-soft" : "border-line bg-panel hover:bg-hover",
              )}
            >
              <span className="flex w-full items-center gap-2">
                <span className={cx("shrink-0", on ? "text-accent-text" : "text-dim")}>{k.icon}</span>
                <span className="min-w-0 flex-1 truncate text-base font-medium text-fg">{k.label}</span>
                <Box on={on} reduce={reduce} />
              </span>
              <span className="pl-[25px] text-small text-dim">{k.line}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-2">
        <span className="px-1 text-small text-faint">coool will set up</span>
        <div className="flex flex-col divide-y divide-[var(--border)] rounded-[12px] border border-line bg-panel" data-onb-devices>
          <DeviceRow id="browser" icon={<IGlobe size={15} />} name="Browser" state={{ kind: "ready", tag: "Built in" }} text="Always on, nothing to install." reduce={reduce} />
          <DeviceRow id="iphone" icon={<IPhone size={15} />} name="iPhone" state={iphone.state} text={iphone.text} extra={iphone.extra} on={c.ticks.iphone && iphone.can} onToggle={() => tick("iphone")} reduce={reduce} />
          <DeviceRow id="mac" icon={<IMac size={15} />} name="Sandbox Mac" state={macR.state} text={macR.text} extra={macR.extra} on={c.ticks.mac && macR.can} onToggle={() => tick("mac")} reduce={reduce} />
        </div>
        <motion.p key={summary} initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }} className="px-1 text-small text-faint" data-onb-summary={going.join(",")}>
          {summary}
        </motion.p>
      </div>
    </div>
  );
}

type RowState = { kind: "loading" } | { kind: "ready"; tag: string } | { kind: "busy"; tag: string } | { kind: "blocked" } | { kind: "choose" };
interface RowInfo {
  state: RowState;
  text: ReactNode;
  extra?: ReactNode;
  /** Ticking it would set something up. */
  can: boolean;
}

function iphoneRow(sim: SimList | "err" | null): RowInfo {
  if (sim === null) return { state: { kind: "loading" }, text: "Looking for Xcode…", can: false };
  if (sim === "err") return { state: { kind: "blocked" }, text: "Couldn’t ask Xcode about simulators. You can set the iPhone up later from its panel.", can: false };
  if (!sim.available)
    return {
      state: { kind: "blocked" },
      text: "Needs Xcode, which isn’t on this Mac. Install it from the App Store, open it once, and add the iOS platform when it asks. Then set the iPhone up from its panel.",
      extra: <Command cmd='open "macappstore://apps.apple.com/app/id497799835"' />,
      can: false,
    };
  const own = sim.devices.find((d) => d.coool);
  if (own) return { state: { kind: "ready", tag: "Ready" }, text: `Already set up: ${own.name}, ${own.runtime}.`, can: false };
  if (!sim.runtime)
    return {
      state: { kind: "blocked" },
      text: "Xcode is here, but without an iOS simulator runtime. Add it in Xcode > Settings > Components, or in Terminal (a download of several GB):",
      extra: <Command cmd="xcodebuild -downloadPlatform iOS" />,
      can: false,
    };
  return { state: { kind: "choose" }, text: `Makes coool’s own simulator, “coool iPhone”, with ${sim.runtime} from your Xcode. Seconds; nothing to download.`, can: true };
}

function macRow(mac: MacStatus | "err" | null): RowInfo {
  if (mac === null) return { state: { kind: "loading" }, text: "Checking…", can: false };
  if (mac === "err" || !mac.available) return { state: { kind: "blocked" }, text: (mac !== "err" && mac.reason) || "The sandbox Mac isn’t available on this Mac.", can: false };
  if (mac.state === "downloading" || mac.state === "installing") return { state: { kind: "busy", tag: macStateLabel(mac) }, text: "Installing now. Its progress is in the Mac panel.", can: false };
  if (mac.installed || mac.state !== "absent") return { state: { kind: "ready", tag: "Ready" }, text: "Already installed.", can: false };
  const free = mac.free;
  const short = free != null && free < NEEDS_GB * 1e9;
  const room = free == null ? "" : `; ${gb(free)} free on this Mac`;
  if (short)
    return {
      state: { kind: "blocked" },
      text: `Downloads about ${DOWNLOAD_GB} GB of macOS from Apple and needs about ${NEEDS_GB} GB of disk${room}: not enough room. Free some space, then install it from the Mac panel.`,
      can: false,
    };
  return {
    state: { kind: "choose" },
    text: `Downloads about ${DOWNLOAD_GB} GB of macOS from Apple and needs about ${NEEDS_GB} GB of disk${room}. Takes 20 minutes or more, in the background.`,
    can: true,
  };
}

function DeviceRow({ id, icon, name, state, text, extra, on, onToggle, reduce }: { id: string; icon: ReactNode; name: string; state: RowState; text: ReactNode; extra?: ReactNode; on?: boolean; onToggle?: () => void; reduce: boolean }) {
  const desc = `onb-dev-${id}`;
  const locked = state.kind !== "choose";
  // Built in / already there: ticked and locked. Can't be set up (or still checking): unticked and locked.
  const checked = state.kind === "ready" ? true : state.kind === "choose" ? !!on : false;
  return (
    <div className="flex items-start gap-3 px-3 py-2.5" data-onb-device={id} data-state={state.kind} data-on={String(checked)}>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-disabled={locked || undefined}
        aria-label={`Set up ${name}`}
        aria-describedby={desc}
        onClick={() => !locked && onToggle?.()}
        className={cx("mt-[1px] flex size-[20px] shrink-0 items-center justify-center rounded-[6px]", locked ? "cursor-default" : "cursor-pointer")}
        data-onb-tick={id}
      >
        <Box on={checked} dim={locked} reduce={reduce} />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className={cx("shrink-0", state.kind === "blocked" ? "text-faint" : "text-dim")}>{icon}</span>
          <span className={cx("min-w-0 flex-1 text-base font-medium", state.kind === "blocked" ? "text-dim" : "text-fg")}>{name}</span>
          {(state.kind === "ready" || state.kind === "busy") && (
            <span className={cx("shrink-0 text-small", state.kind === "ready" ? "text-accent-text" : "text-dim")} data-onb-device-tag>
              {state.tag}
            </span>
          )}
        </span>
        <span id={desc} className="text-small text-dim">
          {text}
        </span>
        {extra && <div className="mt-1">{extra}</div>}
      </div>
    </div>
  );
}

/** A checkbox's square: filled with a tick when on; quieter when it can't be changed. */
function Box({ on, dim, reduce }: { on: boolean; dim?: boolean; reduce: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        "flex size-[16px] shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-150",
        on ? "border-transparent bg-accent text-[var(--bg)]" : "border-[color-mix(in_oklab,var(--text)_28%,transparent)]",
        dim && (on ? "opacity-55" : "opacity-50"),
      )}
    >
      {on && (
        <motion.span initial={reduce ? false : { scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.14 }} className="flex">
          <ICheck size={11} />
        </motion.span>
      )}
    </span>
  );
}
