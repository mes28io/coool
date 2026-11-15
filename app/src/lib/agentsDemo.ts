// `?agents=demo` opens the browser mock's session with running subagents ("Ship the Blender
// add-on milestone"), `?agents=jobs` the one with child jobs (and two background shells), `?agents=shells`
// one with background shells only, `?agents=chat` a chat whose
// subagents arrive as chat items, `?agents=stop` a chat whose turn is stopped mid-step. The ids are shared with lib/mock.ts.

import { sessionKey } from "./types";
import { useStore } from "../store";

export const AGENTS_DEMO_ID = "3d0a7e51-9c2b-4f1d-b6a8-5e4c3d2b1a09";
export const AGENTS_JOBS_ID = "7b2c9d10-4e5f-4a6b-8c7d-1e2f3a4b5c6d";
/** A session with background shells only (no subagents, no jobs). */
export const AGENTS_SHELLS_ID = "9c4e1f20-5a6b-4c7d-8e9f-2a3b4c5d6e7f";

/** Once the mock has listed what it needs, open it in the active tab (once). No-op without the switch. */
export function openAgentsDemo() {
  const mode = /[?&]agents=(\w+)/.exec(location.search)?.[1];
  if (!mode) return;
  const off = useStore.subscribe((st) => {
    if (mode === "chat" || mode === "stop") {
      const info = Object.values(st.chatInfos).find((c) => c.cwd.endsWith(mode === "stop" ? "/stop-demo" : "/blender-addon"));
      if (!info) return;
      off();
      st.open({ kind: "chat", id: info.id });
      return;
    }
    const id = mode === "jobs" ? AGENTS_JOBS_ID : mode === "shells" ? AGENTS_SHELLS_ID : AGENTS_DEMO_ID;
    const s = st.sessions.find((x) => x.id === id);
    if (!s) return;
    off();
    st.open({ kind: "session", key: sessionKey(s) });
  });
}
