// The updater's state on the page: the backend's last report (update-state events), and whether the rail's panel
// is open. The backend does the work (app/src-tauri/src/update/); lib/updateView.ts says what to show.

import { create } from "zustand";
import { api } from "./backend";
import type { UpdateStatus } from "./updateView";

interface Updates {
  status: UpdateStatus | null;
  panel: boolean;
  setPanel: (on: boolean) => void;
  set: (s: UpdateStatus | null) => void;
}

export const useUpdates = create<Updates>((set) => ({
  status: null,
  panel: false,
  setPanel: (panel) => set({ panel }),
  set: (status) => set({ status }),
}));

/** Subscribes to the backend's reports (App's backend events); returns the unsubscribe. */
export function watchUpdates(): () => void {
  const b = api();
  const off = b.onUpdateState((s) => useUpdates.getState().set(s));
  void b.updateStatus().then((s) => s && useUpdates.getState().set(s));
  return off;
}

/** "Check now": the fresh report, or an error line. */
export async function checkNow(): Promise<string | null> {
  const s = await api().updateCheck();
  if (!s) return "coool couldn't check for updates.";
  useUpdates.getState().set(s);
  return null;
}
