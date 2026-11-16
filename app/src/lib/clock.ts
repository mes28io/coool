// One shared clock for every live timer on screen, instead of an interval per component.
import { useSyncExternalStore } from "react";

let now = Date.now();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void) {
  subs.add(cb);
  if (!timer)
    timer = setInterval(() => {
      // Nothing on screen to update while the window is hidden; catch up on the next tick after.
      if (typeof document !== "undefined" && document.hidden) return;
      now = Date.now();
      subs.forEach((f) => f());
    }, 1000);
  return () => {
    subs.delete(cb);
    if (!subs.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}

/**
 * What a component shows from the clock (a label, a flag): it re-renders only when that value changes,
 * not on every tick. `pick` must return a primitive (compared with Object.is); it may close over props.
 */
export function useClock<T extends string | number | boolean | null>(pick: (now: number) => T): T {
  return useSyncExternalStore(subscribe, () => pick(now));
}
