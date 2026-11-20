// The updater in the browser demo. `?update=<state>` shows the rail's update icon and its panel in one state:
//   demo       the launch step plays out: checks, coool downloads and installs ("restart to apply"), Codex waits
//   available  coool 0.2.0 found with automatic updates off (the panel offers Download)
//   busy       coool downloading, 42%
//   staged     coool installed beside the running app: "Update installed · restart to apply"
//   waiting    a Codex update held while 2 Codex sessions run
//   cli        Claude Code updating
//   failed     Codex doesn't start after its update (the repair command)
//   unverified a coool release whose signature didn't verify (nothing installed)
//   manual     Claude Code installed with Homebrew: the command to run
//   current    everything up to date (the icon hides)
// The update screen (an install at launch that ends in a restart, components/UpdateScreen.tsx):
//   launch            the whole thing: Downloading (bytes), Checking the download, Installing, Restarting, then the
//                     "new version" opens with its "Updated to" confirmation (?update=updated)
//   launch-start      Downloading, before the first bytes (indeterminate)
//   launch-download   Downloading, 44% (21 MB of 48 MB); "Start coool now" after 4 s
//   launch-verify     Checking the download
//   launch-install    Installing
//   launch-restarting Restarting
//   launch-failed     the download stops: "Couldn't update right now…", then the app
//   launch-slow       a crawling download: "Start coool now" after 4 s lets the app start; it ends as "restart to apply"
//   updated           the confirmation after a restart: "Updated to 0.3.2 · from 0.3.1"
// The panel's Restart (?update=staged) shows "Restarting" too, then opens ?update=updated.
// Add `updatepanel=1` to open the panel at once.

import type { Provider } from "./types";
import type { LaunchUpdate, UpdateItem, UpdateStatus, UpdateWelcome } from "./updateView";

type Patch = Partial<Record<UpdateItem["id"], Partial<UpdateItem>>>;

const base = (): UpdateStatus => ({
  items: [
    { id: "coool", name: "coool", current: "0.1.0", latest: null, state: "current", detail: null, command: null, method: null, progress: null },
    { id: "claude", name: "Claude Code", current: "2.1.329", latest: "2.1.329", state: "current", detail: null, command: null, method: "npm", progress: null },
    { id: "codex", name: "Codex", current: "0.171.0", latest: "0.171.0", state: "current", detail: null, command: null, method: "standalone installer", progress: null },
  ],
  auto_app: true,
  auto_cli: false,
  gate_open: true,
  checked_at: Date.now() - 4 * 60_000,
  blocked: null,
});

const APP_NEW: Partial<UpdateItem> = { latest: "0.2.0" };
const CODEX_OLD: Partial<UpdateItem> = { current: "0.145.0", latest: "0.171.0" };

const KNOBS: Record<string, { patch: Patch; auto_app?: boolean }> = {
  available: { patch: { coool: { ...APP_NEW, state: "available" } }, auto_app: false },
  busy: { patch: { coool: { ...APP_NEW, state: "downloading", progress: { phase: "download", done: 42, total: 100 } } } },
  staged: { patch: { coool: { ...APP_NEW, state: "staged" } } },
  waiting: { patch: { codex: { ...CODEX_OLD, state: "waiting", detail: "2 Codex sessions are running. It updates once none are.", command: "codex update" } } },
  cli: { patch: { claude: { current: "2.1.300", latest: "2.1.329", state: "installing" } } },
  failed: {
    patch: {
      codex: { ...CODEX_OLD, state: "failed", detail: "Codex doesn't start after the update. Run this in Terminal to repair it:", command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" },
    },
  },
  unverified: {
    patch: { coool: { ...APP_NEW, state: "failed", detail: "The update couldn't be verified: its signature doesn't match coool's release key. Nothing was installed." } },
  },
  manual: { patch: { claude: { current: "2.1.300", latest: "2.1.329", method: "Homebrew", state: "manual", detail: "Installed with Homebrew: update it there.", command: "brew upgrade --cask claude-code" } } },
  current: { patch: {} },
};

const MB = 1048576;
const L_FROM = "0.3.1";
const L_TO = "0.3.2";
const L = (o: Partial<LaunchUpdate>): LaunchUpdate => ({ from: L_FROM, to: L_TO, stage: "download", progress: null, timed_out: false, detail: null, ...o });
const dl = (mb: number) => ({ phase: "download" as const, done: Math.round(mb * MB), total: 48 * MB });
/** The update screen's knobs: their screen state. */
const LAUNCH: Record<string, LaunchUpdate> = {
  "launch-start": L({}),
  "launch-download": L({ progress: dl(21) }),
  "launch-verify": L({ stage: "verify" }),
  "launch-install": L({ stage: "install" }),
  "launch-restarting": L({ stage: "restarting" }),
};

function apply(s: UpdateStatus, p: Patch): UpdateStatus {
  return { ...s, items: s.items.map((i) => ({ ...i, ...p[i.id] })) };
}

export function mockUpdate() {
  const knob = typeof location !== "undefined" ? (/[?&]update=([\w-]+)/.exec(location.search)?.[1] ?? "") : "";
  let state: UpdateStatus | null = null;
  const launchKnob = knob === "launch" || knob.startsWith("launch-");
  if (knob && (KNOBS[knob] || knob === "demo" || knob === "updated" || launchKnob)) {
    const k = KNOBS[knob];
    state = apply({ ...base(), auto_app: k?.auto_app ?? true }, k?.patch ?? {});
  }
  if (launchKnob && state) {
    state = apply({ ...state, gate_open: false, launch: LAUNCH[knob] ?? L({}) }, { coool: { current: L_FROM, latest: L_TO, state: "downloading" } });
  }
  let welcome: UpdateWelcome | null = knob === "updated" ? { from: L_FROM, to: L_TO } : null;
  const subs = new Set<(s: UpdateStatus) => void>();
  const set = (p: Patch, o: Partial<UpdateStatus> = {}) => {
    if (!state) return;
    state = { ...apply(state, p), ...o };
    for (const cb of subs) cb(state);
  };
  if (knob === "demo" && state) {
    // The launch step: checks (the gate holds chats), coool downloads, verifies and is installed beside the app; a
    // Codex update waits for its sessions.
    state = apply({ ...state, gate_open: false }, { coool: { state: "checking" }, claude: { state: "checking" }, codex: { state: "checking" } });
    const at = (ms: number, f: () => void) => setTimeout(f, ms);
    at(1400, () => set({ coool: { ...APP_NEW, state: "downloading", progress: { phase: "download", done: 0, total: 100 } }, claude: { state: "current" }, codex: { state: "checking" } }));
    for (let i = 1; i <= 10; i++) at(1400 + i * 450, () => set({ coool: { progress: { phase: "download", done: i * 10, total: 100 } } }));
    at(2200, () => set({ codex: { ...CODEX_OLD, state: "waiting", detail: "2 Codex sessions are running. It updates once none are.", command: "codex update" } }, { gate_open: true }));
    at(6200, () => set({ coool: { state: "installing", progress: { phase: "verify", done: 0, total: null } } }));
    at(7400, () => set({ coool: { state: "staged", progress: null } }));
  }
  // The update screen playing out (times from the start of the page).
  const at = (ms: number, f: () => void) => setTimeout(f, ms);
  const launchTo = (l: Partial<LaunchUpdate>, p: Patch = {}, o: Partial<UpdateStatus> = {}) => set(p, { launch: state?.launch ? { ...state.launch, ...l } : null, ...o });
  if (knob === "launch") {
    for (let i = 0; i <= 24; i++) at(500 + i * 190, () => launchTo({ progress: dl(i * 2) }, { coool: { progress: dl(i * 2) } }));
    at(5300, () => launchTo({ stage: "verify", progress: null }, { coool: { state: "installing" } }));
    at(6900, () => launchTo({ stage: "install" }));
    at(8000, () => launchTo({ stage: "restarting" }));
    // The "new version" opens.
    at(9300, () => (location.href = `${location.pathname}?update=updated`));
  }
  if (knob === "launch-failed") {
    for (let i = 0; i <= 6; i++) at(300 + i * 200, () => launchTo({ progress: dl(i * 2) }));
    at(1900, () => launchTo({ stage: "failed", progress: null }, { coool: { state: "available", latest: L_TO, progress: null } }, { gate_open: true }));
  }
  if (knob === "launch-slow") {
    let mb = 0;
    const tick = setInterval(() => {
      if (!state) return clearInterval(tick);
      mb = Math.min(48, mb + 0.6);
      if (state.launch?.stage !== "background") launchTo({ progress: dl(mb) }, { coool: { progress: dl(mb) } });
      else set({ coool: { state: "downloading", progress: dl(mb) } });
      if (mb >= 48) {
        clearInterval(tick);
        set({ coool: { state: "staged", progress: null } }, { launch: null, gate_open: true });
      }
    }, 300);
  }
  if (/[?&]updatepanel=1/.test(typeof location !== "undefined" ? location.search : ""))
    setTimeout(() => void import("./update").then((m) => m.useUpdates.getState().setPanel(true)), 900);
  return {
    async updateStatus() {
      return state;
    },
    async updateCheck() {
      await new Promise((r) => setTimeout(r, 700));
      set({}, { checked_at: Date.now() });
      return state;
    },
    async updateSetAuto({ app, cli }: { app?: boolean; cli?: boolean }) {
      set({}, { ...(app !== undefined ? { auto_app: app } : {}), ...(cli !== undefined ? { auto_cli: cli } : {}) });
    },
    async updateInstall() {
      set({ coool: { state: "downloading", progress: { phase: "download", done: 0, total: 100 } } });
      for (let i = 1; i <= 10; i++) {
        await new Promise((r) => setTimeout(r, 250));
        set({ coool: { progress: { phase: "download", done: i * 10, total: 100 } } });
      }
      set({ coool: { state: "staged", progress: null } });
    },
    async updateCliNow(provider: Provider) {
      set({ [provider]: { state: "installing", detail: null } });
      await new Promise((r) => setTimeout(r, 1500));
      set({ [provider]: { state: "current", current: state?.items.find((i) => i.id === provider)?.latest, command: null } });
    },
    async updateRestart() {
      // A browser can't restart: "Restarting" for a moment, then reload into the "new version".
      const app = state?.items.find((i) => i.id === "coool");
      set({}, { launch: L({ from: app?.current ?? L_FROM, to: app?.latest ?? L_TO, stage: "restarting" }) });
      await new Promise((r) => setTimeout(r, 1200));
      location.href = `${location.pathname}?update=updated`;
    },
    async updateLaunchSkip() {
      if (!state?.launch || !["download", "verify"].includes(state.launch.stage)) return false;
      set({}, { launch: { ...state.launch, stage: "background" }, gate_open: true });
      return true;
    },
    async updateWelcome() {
      const w = welcome;
      welcome = null;
      return w;
    },
    onUpdateState(cb: (s: UpdateStatus) => void) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}
