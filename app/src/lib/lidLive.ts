// The lid hold's status for surfaces outside Settings (a chat's "this chat asks" line, the Needs you header): one
// shared `lid_status` poll every 3 s while any of them is shown, and the chats whose line was dismissed.

import { useEffect, useSyncExternalStore } from "react";
import { api } from "./backend";
import type { LidStatus } from "./settingsTypes";

let current: LidStatus | null = null;
const subs = new Set<() => void>();
let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const emit = () => subs.forEach((f) => f());
const poll = () =>
  void api()
    .lidStatus()
    .then((s) => {
      current = s;
      emit();
    })
    .catch(() => {});
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};

/** `lid_status`, shared and re-read every 3 s while some caller is `active`. */
export function useLidLive(active = true): LidStatus | null {
  useEffect(() => {
    if (!active) return;
    users += 1;
    if (users === 1) {
      poll();
      timer = setInterval(poll, 3000);
    }
    return () => {
      users -= 1;
      if (users === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, [active]);
  return useSyncExternalStore(subscribe, () => current);
}

// ---------- "Dismiss for this chat" ----------

const KEY = "coool.lidAsk.dismissed";
let dismissed: string[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
})();
let version = 0;

/** A chat's keys: this run's id, and its session once known (so a dismissal outlives a restart). */
export function lidAskKeys(chatId: number, sessionId: string | null): string[] {
  return sessionId ? [`chat:${chatId}`, `session:${sessionId}`] : [`chat:${chatId}`];
}

export function dismissLidAsk(keys: string[]) {
  dismissed = [...dismissed.filter((k) => !keys.includes(k)), ...keys].slice(-200);
  try {
    localStorage.setItem(KEY, JSON.stringify(dismissed.filter((k) => k.startsWith("session:"))));
  } catch {
    // Private window or blocked storage: the dismissal lasts this run.
  }
  version += 1;
  emit();
}

export function useLidAskDismissed(keys: string[]): boolean {
  useSyncExternalStore(subscribe, () => version);
  return keys.some((k) => dismissed.includes(k));
}
