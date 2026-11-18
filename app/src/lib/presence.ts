// Agent presence (APP_SPEC "Agent presence"): who is acting on each device panel right now, for the cursors, their
// labels and the beam around the panel's frame (components/Presence.tsx).
//
// - Targets: a simulator or the Mac (`sim:<udid>`, the Mac's udid is `mac`), or a chat's Browser panel
//   (`browser:<chat>`). Events: `sim-activity` and `browser-activity`, sent just before each action starts, with the
//   actor (a chat's MCP connection, or one of its `pilot_run`s), its provider and, for a pilot step, who decided.
// - A cursor per actor. It glides to each action's point; with no point (typing into the focused field, a key) it
//   stays where it is and only its words change. When its run ends (a pilot run's `end`, the chat's turn ending, or
//   no word for a long while) it rests for a moment, then fades.
// - The beam runs while any actor of the target is active, and fades shortly after the last one rests.
// - Tints: an actor keeps its slot (0: coool's running blue, then indigo, teal) while it is shown; the Browser
//   panel's slots come from the backend (the page draws the same tint).

import { create } from "zustand";
import { api, type BrowserActivity, type SimActivity } from "./backend";
import { useChats } from "./chat";
import { phrase, whoLine, type PresenceDevice } from "./presenceWords";

export type CursorPhase = "active" | "resting" | "leaving";

export interface Cursor {
  key: string;
  chat: number | null;
  /** Its tint: index into the `--presence-*` tokens. */
  slot: number;
  who: string;
  by: "agent" | "pilot";
  provider: "claude" | "codex" | null;
  /** What it is doing now (the label's second line). */
  say: string;
  /** The point it is at / gliding to, in the device's own coordinates (points, guest pixels); null: not placed yet. */
  x: number | null;
  y: number | null;
  /** A swipe / scroll / drag goes on from (x, y) to here. */
  x2: number | null;
  y2: number | null;
  /** Bumps on every new point (the view animates per move). */
  move: number;
  /** The kind of the latest action (`tap` gets a press ring on arrival). */
  kind: string;
  phase: CursorPhase;
}

export interface Presence {
  cursors: Cursor[];
  /** An actor is active: the beam runs. */
  driving: boolean;
  /** The beam's tint: the slot of the actor that acted last. */
  slot: number;
}

const EMPTY: Presence = { cursors: [], driving: false, slot: 0 };
/** After its run ends a cursor rests this long, then fades for `FADE_MS`. */
export const REST_MS = 900;
export const FADE_MS = 420;
/** No word from any actor for this long: the run is over (an agent can think between tool calls for a while). */
const IDLE_MS = 12_000;
/** An agent quiet this long between actions is thinking. */
const THINK_MS = 1_800;

export const usePresence = create<{ byTarget: Record<string, Presence> }>(() => ({ byTarget: {} }));

export const simTarget = (udid: string) => `sim:${udid}`;
export const browserTarget = (chat: number) => `browser:${chat}`;

/** A target's presence (stable when nothing changed). */
export function usePresenceOf(target: string | null): Presence {
  return usePresence((s) => (target ? (s.byTarget[target] ?? EMPTY) : EMPTY));
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function set(target: string, f: (p: Presence) => Presence) {
  usePresence.setState((s) => {
    const cur = s.byTarget[target] ?? EMPTY;
    const next = f(cur);
    if (next === cur) return s;
    const byTarget = { ...s.byTarget };
    if (!next.cursors.length && !next.driving) delete byTarget[target];
    else byTarget[target] = next;
    return { byTarget };
  });
}

function later(id: string, ms: number, f: () => void) {
  clearTimeout(timers.get(id));
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      f();
    }, ms),
  );
}

function freeSlot(cursors: Cursor[]): number {
  for (let i = 0; ; i++) if (!cursors.some((c) => c.slot === i)) return i;
}

type Event = Pick<SimActivity, "x" | "y" | "x2" | "y2" | "label" | "actor" | "by" | "decider" | "provider"> & { kind: string; chat: number | null; slot?: number; text?: string | null };

/** One action (or `think` / `end`) of an actor on `target`. */
export function feed(target: string, e: Event, device: PresenceDevice) {
  const key = e.actor ?? `${e.chat ?? "-"}:agent`;
  if (e.kind === "end") return end(target, (c) => c.key === key);
  set(target, (p) => {
    const old = p.cursors.find((c) => c.key === key);
    const placed = e.x != null && e.y != null;
    const by = e.by === "pilot" ? "pilot" : "agent";
    const c: Cursor = {
      key,
      chat: e.chat,
      slot: e.slot ?? old?.slot ?? freeSlot(p.cursors),
      who: whoLine({ by, provider: e.provider, decider: e.decider }),
      by,
      provider: e.provider ?? null,
      say: phrase({ kind: e.kind, label: e.label, decider: e.decider, by }, device),
      x: placed ? e.x! : (old?.x ?? null),
      y: placed ? e.y! : (old?.y ?? null),
      x2: placed && e.x2 != null && e.y2 != null ? e.x2 : null,
      y2: placed && e.x2 != null && e.y2 != null ? e.y2! : null,
      move: (old?.move ?? 0) + (placed ? 1 : 0),
      kind: e.kind,
      phase: "active",
    };
    const cursors = old ? p.cursors.map((x) => (x === old ? c : x)) : [...p.cursors, c];
    return { cursors, driving: true, slot: c.slot };
  });
  // Quiet for a while: "Thinking"; quiet for long: the run is over.
  // Typing takes a while on a device (key by key): it isn't thinking meanwhile.
  const busy = e.kind === "type" ? (e.text?.length ?? 0) * 60 : 0;
  later(`${target}|${key}|think`, THINK_MS + busy, () => {
    if (e.by === "pilot") return;
    set(target, (p) => ({ ...p, cursors: p.cursors.map((c) => (c.key === key && c.phase === "active" ? { ...c, say: "Thinking" } : c)) }));
  });
  later(`${target}|idle`, IDLE_MS, () => end(target, () => true));
}

/** The matching actors' runs are over: each rests, then fades; the beam goes once none is active. */
export function end(target: string, which: (c: Cursor) => boolean) {
  const p = usePresence.getState().byTarget[target];
  if (!p) return;
  const ending = p.cursors.filter((c) => c.phase === "active" && which(c));
  if (!ending.length) return;
  set(target, (cur) => {
    const cursors = cur.cursors.map((c) => (ending.some((x) => x.key === c.key) ? { ...c, phase: "resting" as const } : c));
    return { ...cur, cursors, driving: cursors.some((c) => c.phase === "active") };
  });
  for (const c of ending) {
    clearTimeout(timers.get(`${target}|${c.key}|think`));
    later(`${target}|${c.key}|rest`, REST_MS, () => {
      set(target, (cur) => ({ ...cur, cursors: cur.cursors.map((x) => (x.key === c.key && x.phase === "resting" ? { ...x, phase: "leaving" as const } : x)) }));
      later(`${target}|${c.key}|gone`, FADE_MS, () => set(target, (cur) => ({ ...cur, cursors: cur.cursors.filter((x) => !(x.key === c.key && x.phase === "leaving")) })));
    });
  }
}

let started = false;
/** Wires the events (once, at startup). */
export function startPresence() {
  if (started) return;
  started = true;
  api().onSimActivity((a) => {
    if (a.source !== "agent") return;
    feed(simTarget(a.udid), a, a.udid === "mac" ? "mac" : "iphone");
  });
  api().onBrowserActivity((a: BrowserActivity) => {
    feed(browserTarget(a.chat), { ...a, label: a.label ?? undefined, provider: a.provider ?? null, slot: a.slot }, "browser");
  });
  // A turn that ended isn't acting any more: its chat's cursors rest and fade, everywhere.
  useChats.subscribe((s, prev) => {
    for (const [id, c] of Object.entries(s.chats)) {
      const chat = Number(id);
      if (prev.chats[chat]?.turnStart != null && c.turnStart == null) {
        for (const t of Object.keys(usePresence.getState().byTarget)) end(t, (x) => x.chat === chat);
      }
    }
  });
}
