// The coool context (APP_SPEC "coool context"): whether chats coool starts are told about coool (their own devices,
// the pilot, where the person sees them). The text is crates/core/src/agent_context.rs; the backend fills in what
// each chat really has, so the page only sends "on" (`{}`) or "off" (null).

import { useSyncExternalStore } from "react";
import { chatDefaultsIgnored } from "./prefs";

export const CONTEXT_LABEL = "Tell agents about coool";
/** Measured with Claude Code's context report (crates/core/examples/context_text.rs + a no-turn probe). */
export const CONTEXT_LINE =
  "Chats coool starts learn that they run in coool, and when to check their work in the Browser, the iPhone simulator or the sandboxed Mac, and to hand routine steps to the device pilot. About 270 tokens per chat (up to 360 with everything on).";

const KEY = "coool.context";

function read(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? true : JSON.parse(v) !== false;
  } catch {
    return true;
  }
}

let on = read();
const subs = new Set<() => void>();
export const contextPrefNow = () => on;
export const useContextPref = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => on,
  );
export function setContextPref(v: boolean) {
  on = v;
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* private mode: lasts for this window */
  }
  subs.forEach((f) => f());
}

/** Whether a chat about to start gets it: the caller's choice, else the setting (off during a self-test run, like Ladder). */
export const contextOn = (own?: boolean) => own ?? (chatDefaultsIgnored() ? false : on);

/** `ChatOptions.context` for a chat about to start. */
export const contextOptions = (own?: boolean): Record<string, never> | null => (contextOn(own) ? {} : null);

/** What each running chat was launched with, for its chip. */
const launched: Record<number, boolean> = {};
const lsubs = new Set<() => void>();
export function noteContextLaunched(id: number, v: boolean) {
  launched[id] = v;
  lsubs.forEach((f) => f());
}
export const launchedContextNow = (id: number): boolean | undefined => launched[id];
export const useLaunchedContext = (id: number): boolean | undefined =>
  useSyncExternalStore(
    (f) => (lsubs.add(f), () => lsubs.delete(f)),
    () => launched[id],
  );
