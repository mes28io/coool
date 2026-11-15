// `?agents=demo` opens the browser mock's session with running subagents ("Ship the Blender
// add-on milestone"), `?agents=jobs` the one with child jobs, `?agents=chat` a chat whose
// subagents arrive as chat items. The ids are shared with lib/mock.ts.

import { sessionKey } from "./types";
import { useStore } from "../store";

export const AGENTS_DEMO_ID = "3d0a7e51-9c2b-4f1d-b6a8-5e4c3d2b1a09";
export const AGENTS_JOBS_ID = "7b2c9d10-4e5f-4a6b-8c7d-1e2f3a4b5c6d";

/** Once the mock has listed what it needs, open it in the active tab (once). No-op without the switch. */
export function openAgentsDemo() {
  const mode = /[?&]agents=(\w+)/.exec(location.search)?.[1];
  if (!mode) return;
  const off = useStore.subscribe((st) => {
    if (mode === "chat") {
      const info = Object.values(st.chatInfos).find((c) => c.cwd.endsWith("/blender-addon"));
      if (!info) return;
      off();
      st.open({ kind: "chat", id: info.id });
      return;
    }
    const id = mode === "jobs" ? AGENTS_JOBS_ID : AGENTS_DEMO_ID;
    const s = st.sessions.find((x) => x.id === id);
    if (!s) return;
    off();
    st.open({ kind: "session", key: sessionKey(s) });
  });
}
