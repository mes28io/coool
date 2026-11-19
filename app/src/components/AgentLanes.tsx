// Agent lanes (APP_SPEC "Mission control"): under the project's cards, one 36px lane per live session over the last
// 30 minutes. A block per turn: blue while it works (growing into "now"), yellow where it waited on the person, red
// when the turn failed, a quiet green once done. Chats draw from their own items (exact); other sessions from what
// coool saw (lib/laneLog.ts), so a lane starts when coool first saw that session and nothing earlier is drawn.

import { memo, useMemo } from "react";
import { useChats } from "../lib/chat";
import { useClock } from "../lib/clock";
import { clockTime, displayTitle, fmtElapsed } from "../lib/format";
import { blocksFromChat, blocksFromMarks, LANE_WINDOW_MS, laneX, type LaneBlock } from "../lib/lanes";
import { useLaneLog } from "../lib/laneLog";
import type { Attention } from "../lib/live";
import { useMotion } from "../lib/motion";
import type { Session } from "../lib/types";
import { sessionKey } from "../lib/types";
import { useStore } from "../store";
import { Age, Card, CardHeader, Node } from "./MissionCard";
import { IActivity } from "./icons";
import { cx, StatusDot } from "./primitives";

/** The clock the lanes move on: every 5 s (a 30-minute lane is ~1 px per 5 s on a wide window). */
const useLaneNow = () => useClock((t) => Math.floor(t / 5000) * 5000);

/** The chats as they are now; `sig` (what changed) only says when to read them again. */
// eslint-disable-next-line no-unused-vars
const chatsAt = (_sig: string) => useChats.getState().chats;

interface Lane {
  s: Session;
  blocks: LaneBlock[];
  /** Where the lane's data begins (first sight, or the chat's first item); null: no data at all. */
  start: number | null;
}

/**
 * The lanes, and the "now" they are drawn to: the 5 s clock, or the newest chat item when that is later (so a wait
 * or a turn that began since the last tick shows at once, not up to 5 s later).
 */
function useLanes(sessions: Session[], tick: number): { lanes: Lane[]; now: number } {
  const logs = useLaneLog((st) => st.logs);
  // What the lanes read of each chat changes only with a new item, an answer or the chat ending (not every streamed word).
  const sig = useChats((st) =>
    sessions
      .map((s) => {
        const c = s.chat != null ? st.chats[s.chat] : undefined;
        return c ? `${c.id}:${c.items.length}:${c.pendingPermission ?? ""}:${c.pendingQuestion ?? ""}:${c.running ? 1 : 0}` : "-";
      })
      .join("|"),
  );
  return useMemo(() => {
    const chats = chatsAt(sig);
    let now = tick;
    for (const s of sessions) {
      const items = s.chat != null ? chats[s.chat]?.items : undefined;
      const last = items?.[items.length - 1];
      if (last && last.ts > now) now = last.ts;
    }
    const from = now - LANE_WINDOW_MS;
    const lanes = sessions.map((s) => {
      const c = s.chat != null ? chats[s.chat] : undefined;
      if (c && c.items.length) {
        const top = c.items.filter((i) => !("parent" in i && i.parent));
        return { s, blocks: blocksFromChat(top, from, now, c.running), start: top[0]?.ts ?? null };
      }
      const log = logs[sessionKey(s)];
      return { s, blocks: log ? blocksFromMarks(log, from, now) : [], start: log ? log.first : null };
    });
    return { lanes, now };
  }, [sessions, logs, sig, tick]);
}

export function AgentLanes({ sessions, att }: { sessions: Session[]; att: Map<Session, Attention> }) {
  const { lanes, now } = useLanes(sessions, useLaneNow());
  // Quiet until something happened in the window: an empty card would only push the page down.
  if (!lanes.some((l) => l.blocks.length)) return null;
  return (
    <Card className="mt-3" data-mc-lanes={lanes.length}>
      <CardHeader icon={IActivity} title="Lanes" meta={<Legend />} />
      <div className="relative">
        {lanes.map((l) => (
          <LaneRow key={sessionKey(l.s)} lane={l} att={att.get(l.s)} now={now} />
        ))}
      </div>
    </Card>
  );
}

function Legend() {
  const dot = (c: string) => <span className="size-[6px] rounded-[2px]" style={{ background: c }} />;
  return (
    <span className="hidden items-center gap-3 @[640px]:flex" aria-hidden>
      <span className="flex items-center gap-1.5">{dot(TONE.working)}working</span>
      <span className="flex items-center gap-1.5">{dot(WAIT)}needs you</span>
      <span className="flex items-center gap-1.5">{dot(TONE.failed)}failed</span>
      <span className="flex items-center gap-1.5">{dot(TONE.done)}done</span>
      <span className="text-faint">last 30 min</span>
    </span>
  );
}

const TONE: Record<LaneBlock["kind"], string> = {
  working: "var(--status-running)",
  done: "color-mix(in oklab, var(--status-done) 42%, transparent)",
  failed: "color-mix(in oklab, var(--error) 80%, transparent)",
};
const WAIT = "var(--status-needs)";

function blockTitle(b: LaneBlock, now: number): string {
  const what = b.kind === "working" ? "Working" : b.kind === "failed" ? "Failed" : "Done";
  const waited = b.waits.reduce((n, w) => n + Math.max(0, w.end - w.start), 0);
  const end = b.live ? "now" : clockTime(b.end);
  return `${what} · ${clockTime(b.start)}–${end} · ${fmtElapsed(Math.max(0, (b.live ? now : b.end) - b.start))}${waited >= 1000 ? ` · waited on you ${fmtElapsed(waited)}` : ""}`;
}

const LaneRow = memo(function LaneRow({ lane, att, now }: { lane: Lane; att: Attention | undefined; now: number }) {
  const open = useStore((st) => st.open);
  const reduce = useMotion().reduce;
  const { s, blocks, start } = lane;
  const from = now - LANE_WINDOW_MS;
  const key = sessionKey(s);
  const status = att?.needs ? "needs" : (att?.status ?? s.status);
  const last = blocks[blocks.length - 1];
  const seen = start !== null && start > from ? laneX(start, from, now) : 0;
  const pct = (t: number) => `${(laneX(t, from, now) * 100).toFixed(3)}%`;
  const width = (a: number, b: number) => `max(3px, ${((laneX(b, from, now) - laneX(a, from, now)) * 100).toFixed(3)}%)`;
  return (
    <button type="button" onClick={() => open({ kind: "session", key })} className="group flex h-[36px] w-full items-center gap-2.5 px-3.5 text-left transition-colors duration-150 hover:bg-hover" data-mc-lane={key} data-lane-blocks={blocks.map((b) => b.kind + (b.waits.length ? "+wait" : "")).join(",")}>
      <Node>
        <StatusDot status={status} size={8} />
      </Node>
      <span className="w-[26%] min-w-[80px] max-w-[220px] shrink-0 truncate text-base text-fg" title={displayTitle(s)}>
        {displayTitle(s)}
      </span>
      <span className="relative h-full min-w-0 flex-1" aria-hidden>
        {/* The watched stretch: a hairline from when the lane's data begins to now; before it, nothing is known. */}
        <span className="absolute top-1/2 h-px -translate-y-1/2 bg-hairline" style={{ left: `${seen * 100}%`, right: 0 }} />
        {seen > 0.004 && <span className="absolute top-1/2 h-[8px] w-px -translate-y-1/2 bg-line" style={{ left: `${seen * 100}%` }} title={`coool started watching at ${clockTime(start!)}`} />}
        {[1 / 3, 2 / 3].map((t) => (
          <span key={t} className="absolute top-1/2 h-[6px] w-px -translate-y-1/2 bg-hairline" style={{ left: `${t * 100}%` }} />
        ))}
        {blocks.map((b) => (
          <span
            key={b.start}
            className={cx("absolute top-1/2 h-[10px] -translate-y-1/2 overflow-hidden rounded-[3px]", !reduce && "transition-[left,width] duration-700 ease-linear")}
            style={{ left: pct(b.start), width: width(b.start, b.end), background: TONE[b.kind] }}
            title={blockTitle(b, now)}
            data-lane-block={b.kind}
          >
            {b.waits.map((w) => (
              <span key={w.start} className="absolute inset-y-0" style={{ left: `${((w.start - b.start) / Math.max(1, b.end - b.start)) * 100}%`, width: `max(2px, ${((w.end - w.start) / Math.max(1, b.end - b.start)) * 100}%)`, background: WAIT }} data-lane-wait />
            ))}
          </span>
        ))}
      </span>
      <Age ms={last ? (last.live ? last.start : last.end) : null} title={last?.live ? "This turn has run for" : "Last turn ended"} className={last?.live ? "text-dim" : undefined} />
    </button>
  );
});
