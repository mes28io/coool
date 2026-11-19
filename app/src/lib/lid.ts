// "Keep working with the lid closed" (Settings > General; backend app/src-tauri/src/lid/, docs/LID.md): the words
// for its state, as pure functions over `lid_status`, so Settings, the running-now pill and (later) the onboarding
// say the same thing.

import type { LidCode, LidStatus, LidStop } from "./settingsTypes";

export type LidTone = "held" | "idle" | "blocked" | "warn";

/** "1h 12m", "3m", "under a minute". */
export function spanText(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "under a minute";
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

/** "14:05" in the person's time. */
export function clockText(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const agents = (n: number) => (n === 1 ? "1 agent working" : `${n} agents working`);

function power(s: LidStatus): string {
  const r = s.reading;
  if (r.on_battery === true) return r.battery_pct != null ? `on battery (${r.battery_pct}%)` : "on battery";
  if (r.on_battery === false) return "on power";
  return "";
}

/** Which way this Mac can hold right now, in a few words. */
export function wayText(s: LidStatus): string {
  if (s.reading.lid_closed == null) return "This Mac has no lid.";
  if (s.reading.lid_sleeps === false) return "Closed-display mode (an external display, on power): the lid alone doesn’t sleep this Mac.";
  return s.helper.state === "ready" ? "The helper turns sleep off while agents work." : "Closing the lid sleeps this Mac unless the helper is installed.";
}

const BLOCKED: Record<LidCode, (s: LidStatus) => string> = {
  on_battery: () => "Not holding: on battery. It holds again when the Mac is plugged in.",
  low_battery: (s) => `Not holding: battery ${s.reading.battery_pct ?? "low"}${s.reading.battery_pct != null ? "%" : ""} (the limit is ${s.prefs.min_battery}%).`,
  hot: () => "Not holding: the Mac got hot. It won’t hold again until the agents stop.",
  max_duration: (s) => `Not holding: the ${s.prefs.max_hours} h limit was reached. It won’t hold again until the agents stop.`,
  needs_helper: () => "Not holding: closing the lid would sleep this Mac. Install the helper, or use an external display on power.",
  helper_error: (s) => `Not holding: the helper didn’t hold${s.helper.state === "unreachable" ? ` (${s.helper.detail})` : s.error ? ` (${s.error})` : ""}.`,
  already_disabled: () => "Sleep is already turned off on this Mac (pmset disablesleep), so the lid won’t sleep it. coool isn’t holding anything.",
  no_lid: () => "This Mac has no lid. “Prevent sleep while agents are working” is all it needs.",
  helper_let_go: () => "The helper let go. coool asks again shortly.",
  recovered: () => "",
  waiting: () => "",
};

/** The status line under the switch: what is happening now. */
export function lidLine(s: LidStatus, now: number): { tone: LidTone; text: string } {
  if (s.stale) return { tone: "warn", text: "Sleep is still turned off from when coool quit while holding, and the helper isn’t answering. Restore normal sleep below." };
  if (s.via && s.grace_until != null && s.working === 0) {
    const who = s.grace_title ? `“${s.grace_title}”` : "An agent";
    return { tone: "held", text: `Holding a little longer: ${who} is waiting for your answer. If nobody answers, the Mac can sleep at ${clockText(s.grace_until)}.` };
  }
  if (s.via) {
    const parts = [agents(s.working), power(s), s.since != null ? `${spanText(now - s.since)}${s.prefs.max_hours ? ` of ${s.prefs.max_hours}h` : ""}` : ""].filter(Boolean);
    return { tone: "held", text: `Holding the Mac awake${s.via === "display" ? " (closed-display mode)" : ""}: ${parts.join(", ")}.` };
  }
  if (s.blocked) return { tone: s.blocked === "already_disabled" || s.blocked === "no_lid" ? "idle" : "blocked", text: BLOCKED[s.blocked](s) };
  if (s.helper.state === "ready") return { tone: "idle", text: "Ready. It holds while an agent works and lets go when they stop." };
  if (s.helper.state === "outdated") return { tone: "warn", text: "The installed helper is from another version of coool. Install it again to update it." };
  if (s.helper.state === "unreachable") return { tone: "warn", text: `The helper is installed but not answering (${s.helper.detail}).` };
  if (s.reading.lid_closed == null) return { tone: "idle", text: BLOCKED.no_lid(s) };
  if (s.reading.lid_sleeps === false) return { tone: "idle", text: "Ready in closed-display mode. Without an external display, it needs the helper." };
  if (s.helper.state === "unavailable") return { tone: "warn", text: "This build of coool has no helper. It only works in closed-display mode (an external display, on power)." };
  return { tone: "warn", text: "Needs one-time approval: install the helper so the lid can close without an external display." };
}

/** "Stopped holding the Mac awake at 02:14: battery 20%." (the same words as the notification). */
export function stopText(s: LidStop): string {
  if (s.code === "recovered" || s.code === "helper_let_go") return `${clockText(s.at)}: ${s.detail}.`;
  if (s.code === "waiting") return `Let the Mac sleep at ${clockText(s.at)}: ${s.detail}.`;
  return `Stopped holding the Mac awake at ${clockText(s.at)}: ${s.detail}.`;
}

/** The running-now pill's quiet footer, or null when there's nothing to say. */
export function pillText(s: LidStatus | null, keepAwake: { held: boolean; covered?: boolean } | null): string | null {
  if (s?.via) return s.via === "helper" ? "Keeping the Mac awake, lid closed too" : "Keeping the Mac awake (closed-display mode)";
  if (s?.enabled && s.blocked && s.blocked !== "no_lid" && s.blocked !== "already_disabled") {
    const why: Partial<Record<LidCode, string>> = { on_battery: "on battery", low_battery: "battery low", hot: "the Mac got hot", max_duration: "time limit", needs_helper: "needs the helper", helper_error: "helper not answering" };
    return `Lid closed would sleep the Mac: ${why[s.blocked] ?? "not holding"}${keepAwake?.held ? " (idle sleep is held)" : ""}`;
  }
  if (keepAwake?.held) return "Keeping the Mac awake (lid open)";
  return null;
}

export const BATTERY_STEPS = [10, 15, 20, 25, 30, 40, 50];
export const HOUR_STEPS = [1, 2, 4, 8, 12, 24, 0];
export const GRACE_STEPS = [0, 1, 2, 5, 10];

// ---------- a chat in a mode that stops to ask, while the lid hold is on ----------

/** Permission modes in which the CLI stops to ask the person (Claude's and Codex's own names). */
export const ASKING_MODES = new Set(["default", "acceptEdits", "plan", "untrusted", "on-request"]);
/** Modes that don't ask only because they allow everything, unsandboxed: never picked for the person. */
export const BYPASS_MODES = new Set(["bypassPermissions", "danger-full-access"]);

export function asksBeforeActing(mode: string | null | undefined): boolean {
  return ASKING_MODES.has(mode ?? "default");
}

/**
 * What the banner's button does for a chat in `current` mode, given the CLI's modes in the menu's order (least
 * permissive first): switch to the first one that doesn't stop to ask and isn't a bypass, or, when only a bypass
 * avoids prompts, open the mode menu so the person picks. Null: the mode doesn't ask.
 */
export function lidModeFix(current: string | null | undefined, modes: { id: string; label: string }[]): { kind: "switch"; id: string; label: string } | { kind: "menu" } | null {
  if (!asksBeforeActing(current)) return null;
  const m = modes.find((x) => !ASKING_MODES.has(x.id) && !BYPASS_MODES.has(x.id));
  return m ? { kind: "switch", id: m.id, label: m.label } : { kind: "menu" };
}

/** The setting is on and something would hold a closed Mac now (the helper, or closed-display mode). */
export function lidWouldHold(s: LidStatus | null): boolean {
  if (!s?.enabled || s.reading.lid_closed == null || s.blocked === "already_disabled" || s.stale) return false;
  return s.helper.state === "ready" || s.reading.lid_sleeps === false;
}

export const LID_ASK_TEXT = "Lid-closed is on, but this chat asks before it acts: it will pause, and the Mac will sleep, at its first prompt.";

/** The Settings row's live line: "2 working chats are in a mode that asks". */
export function askingChatsText(n: number): string {
  return n === 1 ? "1 working chat is in a mode that asks" : `${n} working chats are in a mode that asks`;
}

/** The `waiting` stop a Needs you item caused, if any: same session, and the same request when both are known. */
export function pausedBy(stops: LidStop[] | null | undefined, key: string, request: string | null): LidStop | null {
  return stops?.find((st) => st.code === "waiting" && st.session === key && (!request || !st.request || st.request === request)) ?? null;
}

/** The Needs you header's line for it. */
export function pausedText(st: LidStop): string {
  return `This paused a lid-closed run at ${clockText(st.at)}`;
}
