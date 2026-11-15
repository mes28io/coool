// Which sessions are on screen, for the backend's shell scan: only their background shells get
// output tails read (APP_SPEC "Background shells"). Every mounted session view registers its id.

import { useEffect } from "react";
import { api } from "./backend";

const counts = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let sent = "";

function flush() {
  timer = null;
  const ids = [...counts.keys()].sort();
  const key = ids.join("\n");
  if (key === sent) return;
  sent = key;
  void api()?.shellsFocus?.(ids);
}

export function useShellFocus(sessionId: string | null | undefined) {
  useEffect(() => {
    if (!sessionId) return;
    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
    timer ??= setTimeout(flush, 120);
    return () => {
      const n = (counts.get(sessionId) ?? 1) - 1;
      if (n > 0) counts.set(sessionId, n);
      else counts.delete(sessionId);
      timer ??= setTimeout(flush, 120);
    };
  }, [sessionId]);
}
