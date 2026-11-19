// `?ideas=demo` (browser mock only): the five ideas from docs/research/affectui-inspiration.md "Later", with data.
//
//   - harbor (a made-up project) gets three chats with half an hour of turns behind them: one failed, one asks to run
//     `rm -rf dist && git push --force` (the Risky tag), one asks a single question (number keys, Later).
//   - Every other live mock session gets an invented status log, as if coool had been watching it (agent lanes); one
//     in three was "first seen" 9 minutes ago, so its lane starts there.
//   - Live sessions keep the running-now pill and the hover cards busy.

import { useStore } from "../store";
import { useLaneLog } from "./laneLog";
import { noteLane, type LaneLog, type LaneState } from "./lanes";
import type { MockChat } from "./mockChat";
import { sessionKey } from "./types";

const M = 60_000;

export function runIdeasDemo(newChat: (cwd: string) => MockChat, cwd: string) {
  const now = Date.now();
  const a = newChat(cwd);
  void a
    .seed(["Map the release script's steps"], now - 24 * M)
    .then(() => a.seed(["Run the release dry run, show me the error"], now - 15 * M))
    .then(() => a.seed(["Bump the changelog for 2.4"], now - 6 * M))
    .then(() => setTimeout(() => a.send("Clean up after the release (risky)"), 900));
  const b = newChat(cwd);
  void b
    .seed(["Sketch the cache layer", "Wire the cache into the image route"], now - 18 * M)
    .then(() => b.seed(["Measure the cold start"], now - 4 * M))
    .then(() => setTimeout(() => b.send("Which cache should back the image route? pick one, ask me"), 1400));
  const c = newChat(cwd);
  void c.seed(["Read the deploy docs"], now - 11 * M).then(() => setTimeout(() => c.send("Walk the upload path end to end (long)"), 2000));
  void seedLanes(now);
}

/** An invented, plausible log for each live transcript session (the mock has no real history to show). */
async function seedLanes(now: number) {
  for (let i = 0; i < 100 && !(useStore.getState().ready && useStore.getState().allSessions.length); i++) await new Promise((r) => setTimeout(r, 100));
  const logs: Record<string, LaneLog> = {};
  useStore.getState().allSessions.forEach((s, i) => {
    if (s.status === "ended" || s.chat != null) return;
    const first = i % 3 === 2 ? now - 9 * M : now - 31 * M;
    const plan: [number, LaneState, boolean?][] = [
      [first, "idle"],
      [now - (27 - (i % 4)) * M, "working"],
      [now - (21 - (i % 3)) * M, "needs"],
      [now - (19 - (i % 3)) * M, "working"],
      [now - 15 * M, "idle", i % 4 === 1],
      [now - (11 - (i % 5)) * M, "working"],
      [now - (5 - (i % 3)) * M, "idle"],
    ];
    let log: LaneLog | undefined;
    for (const [at, state, failed] of plan) if (at >= first) log = noteLane(log ?? { first, marks: [] }, state, at, !!failed);
    const cur: LaneState = s.status === "busy" ? "working" : "idle";
    log = noteLane(log ?? { first, marks: [] }, cur, now - 2 * M);
    logs[sessionKey(s)] = { ...log, first };
  });
  useLaneLog.setState((st) => ({ logs: { ...st.logs, ...logs } }));
}
