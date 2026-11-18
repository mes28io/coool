// The device pilot in the chat (APP_SPEC "Device pilot"; app/src-tauri/src/device/pilot): a `pilot_run` tool call
// shows as one step with its goal and live sub-steps. Progress arrives as `pilot-progress` events while the call
// runs; afterwards the tool's own result (its JSON) has the whole run, so a reopened chat shows it too.

import { create } from "zustand";
import { api, type PilotOutcome, type PilotProgress } from "./backend";

/** The `coool-device` pilot tool (Claude: `mcp__coool-device__pilot_run`, Codex: `coool-device.pilot_run`). */
export const isPilotTool = (name: string) => /coool-device(__|\.)pilot_run$/.test(name);

/** Each chat's latest pilot runs, by run id. */
export const usePilot = create<{ runs: Record<number, PilotProgress> }>(() => ({ runs: {} }));

/** The run behind a tool call of chat `chat` started at `ts` with goal `goal`: live progress, if any came. */
export function liveRun(runs: Record<number, PilotProgress>, chat: number, ts: number, goal: string): PilotProgress | null {
  let best: PilotProgress | null = null;
  for (const r of Object.values(runs)) {
    if (r.chat !== chat || r.outcome.goal !== goal || r.started < ts - 5_000) continue;
    if (!best || r.started < best.started) best = r;
  }
  return best;
}

/** The outcome in a finished call's result: a summary line, then the JSON. */
export function parseOutcome(output: string): PilotOutcome | null {
  const i = output.indexOf("\n{");
  if (i < 0) return null;
  try {
    const o = JSON.parse(output.slice(i + 1)) as PilotOutcome;
    return o && Array.isArray(o.steps) ? o : null;
  } catch {
    return null;
  }
}

let started = false;
export function startPilot() {
  if (started) return;
  started = true;
  api().onPilotProgress((p) =>
    usePilot.setState((s) => {
      const runs = { ...s.runs, [p.run]: p };
      // Keep the latest few dozen.
      const ids = Object.keys(runs).map(Number).sort((a, b) => a - b);
      for (const id of ids.slice(0, Math.max(0, ids.length - 40))) delete runs[id];
      return { runs };
    }),
  );
}
