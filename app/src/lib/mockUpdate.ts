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
// Add `updatepanel=1` to open the panel at once.

import type { Provider } from "./types";
import type { UpdateItem, UpdateStatus } from "./updateView";

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

function apply(s: UpdateStatus, p: Patch): UpdateStatus {
  return { ...s, items: s.items.map((i) => ({ ...i, ...p[i.id] })) };
}

export function mockUpdate() {
  const knob = typeof location !== "undefined" ? (/[?&]update=(\w+)/.exec(location.search)?.[1] ?? "") : "";
  let state: UpdateStatus | null = null;
  if (knob && (KNOBS[knob] || knob === "demo")) {
    const k = KNOBS[knob];
    state = apply({ ...base(), auto_app: k?.auto_app ?? true }, k?.patch ?? {});
  }
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
      // A browser can't restart: reload into the "new version".
      location.href = location.pathname;
    },
    onUpdateState(cb: (s: UpdateStatus) => void) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}
