// The updater's state on the page: the backend's last report (update-state events), whether the rail's panel is
// open, and the update screen's (components/UpdateScreen.tsx). The backend does the work (app/src-tauri/src/update/);
// lib/updateView.ts says what to show.

import { create } from "zustand";
import { api, isTauri } from "./backend";
import { FAILED_HOLD_MS, launchView, veilHolds, welcomeLine, type UpdateStatus } from "./updateView";
import { useStore } from "../store";

interface Updates {
  status: UpdateStatus | null;
  panel: boolean;
  /** At launch, the plain hold over the normal UI while coool's own check is out (the app only; lifts once). */
  veil: boolean;
  /** When the update screen came up (page ms); null while there is none. */
  screenSince: number | null;
  /** The screen says the failure line (until FAILED_HOLD_MS after it came). */
  screenFailed: boolean;
  setPanel: (on: boolean) => void;
  set: (s: UpdateStatus | null) => void;
}

/** When the update screen and the normal UI first showed (page ms), and the stages it said, for the self-test. */
export const launchTrace: { status?: number; screen?: number; uncovered?: number; stages: string[] } = { stages: [] };

const ACTIVE = ["download", "verify", "install", "restarting"];
let failTimer: ReturnType<typeof setTimeout> | null = null;

export const useUpdates = create<Updates>((set, get) => ({
  status: null,
  panel: false,
  veil: isTauri,
  screenSince: null,
  screenFailed: false,
  setPanel: (panel) => set({ panel }),
  set: (status) => {
    const l = status?.launch ?? null;
    const st = get();
    if (l && ACTIVE.includes(l.stage)) {
      // Up (again, for a Restart later on).
      if (failTimer) clearTimeout(failTimer);
      failTimer = null;
      const since = st.screenSince !== null && !st.screenFailed ? st.screenSince : performance.now();
      launchTrace.screen ??= since;
      const line = launchView(l, 0)?.stage;
      if (line && launchTrace.stages[launchTrace.stages.length - 1] !== line) launchTrace.stages.push(line);
      set({ status, screenSince: since, screenFailed: false, veil: false });
    } else if (l?.stage === "failed" && st.screenSince !== null && !st.screenFailed) {
      // A failure is said only by a screen that was up: the line for a moment, then it steps aside.
      launchTrace.stages.push("failed");
      failTimer = setTimeout(() => {
        failTimer = null;
        set({ screenSince: null, screenFailed: false });
      }, FAILED_HOLD_MS);
      set({ status, screenFailed: true });
    } else if (st.screenFailed) {
      set({ status });
    } else {
      set({ status, screenSince: null });
    }
  },
}));

/** The update screen, or the launch hold, covers the window: the app under it takes no input. */
export const coverOf = (s: Updates) => s.veil || s.screenSince !== null;

useUpdates.subscribe((s) => {
  if (!coverOf(s)) launchTrace.uncovered ??= performance.now();
});

/** Subscribes to the backend's reports (App's backend events); returns the unsubscribe. */
export function watchUpdates(): () => void {
  const b = api();
  const off = b.onUpdateState((s) => useUpdates.getState().set(s));
  void b.updateStatus().then((s) => {
    launchTrace.status ??= performance.now();
    if (s) useUpdates.getState().set(s);
  });
  // The launch hold lifts once coool's own check has answered (or after a short while), or the screen takes over.
  const t0 = performance.now();
  const veil = setInterval(() => {
    const s = useUpdates.getState();
    if (!s.veil || !veilHolds(s.status, performance.now() - t0)) {
      clearInterval(veil);
      useUpdates.setState({ veil: false });
    }
  }, 50);
  // After a restart into a new version: "Updated to", once.
  void b
    .updateWelcome()
    .then((w) => w && useStore.getState().toast(welcomeLine(w), "done"))
    .catch(() => {});
  return () => {
    off();
    clearInterval(veil);
  };
}

/** "Update and restart" (Settings > About, the rail's panel): installs the version the last check found when it isn't
 *  yet, then restarts into it. Chats the chat host runs keep running across it (APP_SPEC "Chats that outlive the app"). */
export async function updateAndRestart(): Promise<void> {
  const app = useUpdates.getState().status?.items.find((i) => i.id === "coool");
  if (app && app.state !== "staged") await api().updateInstall();
  await api().updateRestart();
}

/** "Check now": the fresh report, or an error line. */
export async function checkNow(): Promise<string | null> {
  const s = await api().updateCheck();
  if (!s) return "coool couldn't check for updates.";
  useUpdates.getState().set(s);
  return null;
}
