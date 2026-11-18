// "While you were away" (APP_SPEC "Mission control", CHAT_SPEC "App behaviour"): what happened while the
// person was not looking, in two places. The rules (what counts, the thresholds, what is never repeated)
// are in lib/away.ts; the absence itself is recorded by the store's `touchSeen` when something comes back on
// screen.
//
//   AwayStrip  Mission control, under "Needs you": one line across all projects, each count jumps to the
//              most recent session it is about.
//   AwayCard   A chat, at the point the person left: failed turns (Retry), finished ones (open the turn),
//              "Got it" folds it into a one-line divider for the rest of the visit.

import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { AWAY_ROWS, awayFor, chatAway, missionAway, shippedLabel, type Away, type AwayItem, type AwaySession, type ChatAway } from "../lib/away";
import type { Chat } from "../lib/chat";
import { useChats } from "../lib/chat";
import { fmtElapsed, folderName, projectOf } from "../lib/format";
import type { Attention } from "../lib/live";
import { changesFromActivity, changesFromChat, type ItemLike } from "../lib/mission";
import { useMotion } from "../lib/motion";
import type { Session } from "../lib/types";
import { sessionKey } from "../lib/types";
import { APP_SEEN, useStore } from "../store";
import { IAlert, ICheck, IClock, IReturn } from "./icons";
import { Age, Card, Node, TEXT_X } from "./MissionCard";
import { cx, ease, Ticker } from "./primitives";

const count = (n: number) => String(Math.round(n));

/** A status-coloured dot and a count: "● 2 failed". */
function Count({ n, tone, label }: { n: number; tone: "failed" | "done"; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cx("size-[6px] shrink-0 rounded-full", tone === "failed" ? "bg-err" : "bg-done")} />
      <span className={tone === "failed" ? "text-err-text" : "text-dim"}>
        <Ticker value={n} format={count} /> {label}
      </span>
    </span>
  );
}

// ---------- Mission control ----------

/** One line under "Needs you": what happened across every project while the person was away from the app. */
export function AwayStrip({ att }: { att: Map<Session, Attention> }) {
  const away = useStore((st) => st.away[APP_SEEN]);
  if (!away || away.folded) return null;
  return <AwayStripBody away={away} att={att} />;
}

function AwayStripBody({ away, att }: { away: Away; att: Map<Session, Attention> }) {
  const sessions = useStore(useShallow((st) => st.sessions.filter((s) => !s.nested)));
  const seenAt = useStore((st) => st.seen.at);
  const open = useStore((st) => st.open);
  const fold = useStore((st) => st.foldAway);
  const reduce = useMotion().reduce;
  const items = useChats(useShallow((st) => sessions.map((s) => (s.chat != null ? st.chats[s.chat]?.items : undefined))));
  const sum = useMemo(() => {
    const list: AwaySession[] = sessions.map((s, i) => {
      const key = sessionKey(s);
      const root = projectOf(s);
      const its = items[i];
      const a = att.get(s);
      return {
        key,
        project: root,
        needs: !!a?.needs,
        busy: a?.status === "busy",
        seenAt: seenAt?.[key] ?? null,
        lastEvent: s.last_event ?? s.updated,
        items: its && its.length ? (its as AwayItem[]) : null,
        changes: its && its.length ? changesFromChat(key, its as ItemLike[], root) : changesFromActivity(key, s.activity, root),
      };
    });
    return missionAway(list, away);
  }, [sessions, items, att, seenAt, away]);
  if (!sum.worth) return null;
  const jump = (k: keyof typeof sum.first) => {
    const key = sum.first[k];
    if (key) open({ kind: "session", key });
  };
  const seg = "flex h-[28px] shrink-0 items-center rounded-[8px] px-2 text-small transition-colors duration-150 hover:bg-hover";
  const where = sum.projects.map(folderName);
  return (
    <motion.section
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease }}
      className="mb-6"
      data-mc-away={Math.round(sum.awayMs / 60_000)}
    >
      <Card className="flex-row items-center">
        <div className="flex h-[40px] min-w-0 flex-1 items-center gap-2.5 pl-3.5 pr-1.5">
          <Node className="text-dim">
            <IClock size={14} />
          </Node>
          <span className="shrink-0 text-base font-medium text-fg">While you were away</span>
          <span className="shrink-0 text-small text-faint tnum">{awayFor(sum.awayMs)}</span>
          <span className="ml-1 flex h-[28px] min-w-0 flex-1 flex-wrap items-center gap-x-0.5 overflow-hidden">
            {sum.failed > 0 && (
              <button type="button" className={seg} onClick={() => jump("failed")} title="Open the session that failed last" data-mc-away-seg="failed">
                <Count n={sum.failed} tone="failed" label="failed" />
              </button>
            )}
            {sum.done > 0 && (
              <button type="button" className={seg} onClick={() => jump("done")} title="Open the session that finished last" data-mc-away-seg="done">
                <Count n={sum.done} tone="done" label="done" />
              </button>
            )}
            {sum.shipped.slice(0, 3).map((x) => (
              <button key={x.kind} type="button" className={cx(seg, "text-dim hover:text-fg")} onClick={() => jump(x.kind)} title={`Open the session behind the last ${shippedLabel(x.kind, 1).slice(2)}`} data-mc-away-seg={x.kind}>
                {shippedLabel(x.kind, x.n)}
              </button>
            ))}
            {where.length > 0 && (
              <span className="ml-1.5 flex h-[28px] min-w-0 items-center truncate text-small text-faint" title={where.join(", ")}>
                in {where.length <= 2 ? where.join(" and ") : `${where.slice(0, 2).join(", ")} and ${where.length - 2} more`}
              </span>
            )}
          </span>
          <button type="button" onClick={() => fold(APP_SEEN)} className="ml-auto h-[28px] shrink-0 rounded-[8px] px-2.5 text-small text-dim transition-colors duration-150 hover:bg-hover hover:text-fg" data-mc-away-dismiss>
            Got it
          </button>
        </div>
      </Card>
    </motion.section>
  );
}

// ---------- a chat ----------

/** This visit's absence for the chat and what happened in it, or null when there is nothing to say. */
export function useChatAway(chat: Chat): { key: string; away: Away; sum: ChatAway } | null {
  const key = useStore((st) => st.chatOwner[chat.id] ?? null);
  const away = useStore((st) => (key ? st.away[key] : undefined));
  return useMemo(() => {
    if (!key || !away) return null;
    const sum = chatAway(chat.items as AwayItem[], changesFromChat(key, chat.items as ItemLike[], chat.cwd), away);
    return sum.worth ? { key, away, sum } : null;
  }, [key, away, chat.items, chat.cwd]);
}

type Row = { id: string; kind: "failed" | "done" | "exited"; title: string; detail: string; ts: number; jump: string | null; retry?: string };

/** One line for the divider and the folded state: "Away 2h 14m · 5 done · 1 failed". */
const summaryLine = (s: ChatAway) =>
  [`Away ${awayFor(s.awayMs)}`, s.done.length > 0 && `${s.done.length} done`, s.failed.length > 0 && `${s.failed.length} failed`, s.exited && "the CLI exited"].filter(Boolean).join(" · ");

/**
 * The card in the chat at the point the person left. Rows (at most AWAY_ROWS before "+N more"): failed turns
 * first with their last error line and Retry, then the CLI exiting, then finished turns ("Finished <prompt> ·
 * 4m · 3 files · pushed"). A row scrolls to that turn and folds the card; so does "Got it". Folded, it is a
 * one-line divider for the rest of the visit. Not part of the transcript (never copied or exported).
 */
export function AwayCard({ chatKey, sum, folded, canRetry, onRetry, onJump }: { chatKey: string; sum: ChatAway; folded: boolean; canRetry: boolean; onRetry: (prompt: string) => void; onJump: (key: string) => void }) {
  const fold = useStore((st) => st.foldAway);
  const reduce = useMotion().reduce;
  const [all, setAll] = useState(false);
  const rows: Row[] = [
    ...sum.failed.map((t): Row => ({ id: t.key, kind: "failed", title: t.text || "A turn", detail: t.error ?? `Failed after ${fmtElapsed(t.durationMs)}`, ts: t.ts, jump: t.key, retry: t.text || undefined })),
    ...(sum.exited ? [{ id: sum.exited.key, kind: "exited" as const, title: `The CLI exited with code ${sum.exited.code}`, detail: "Resume to continue", ts: 0, jump: sum.exited.key }] : []),
    ...sum.done.map((t): Row => ({
      id: t.key,
      kind: "done",
      title: t.text || "A turn",
      detail: [fmtElapsed(t.durationMs).replace(/ \d+s$/, ""), t.files > 0 && `${t.files} ${t.files === 1 ? "file" : "files"}`, ...t.shipped].filter(Boolean).join(" · "),
      ts: t.ts,
      jump: t.prompt ?? t.key,
    })),
  ];
  const shown = all ? rows : rows.slice(0, rows.length > AWAY_ROWS ? AWAY_ROWS - 1 : AWAY_ROWS);
  const more = rows.length - shown.length;
  const close = () => fold(chatKey);
  const t = reduce ? { duration: 0 } : { duration: 0.18, ease };
  return (
    <div className="select-none" data-away-card={folded ? "folded" : "open"} data-no-export>
      <AnimatePresence initial={false} mode="wait">
        {folded ? (
          <motion.div key="divider" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={t} className="overflow-hidden">
            <div className="flex items-center gap-3 py-1 text-small text-faint" data-away-divider>
              <span className="h-px flex-1 bg-hairline" />
              <span className="flex items-center gap-1.5 tnum">
                <IClock size={12} />
                {summaryLine(sum)}
              </span>
              <span className="h-px flex-1 bg-hairline" />
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="card"
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, height: 0, transition: t }}
            transition={{ duration: 0.32, ease }}
            className="overflow-hidden"
          >
            <Card>
              <header className="flex h-[40px] shrink-0 items-center gap-2.5 border-b border-hairline pl-3.5 pr-1.5">
                <Node className="text-dim">
                  <IClock size={14} />
                </Node>
                <span className="shrink-0 text-base font-medium text-fg">While you were away</span>
                <span className="shrink-0 text-small text-faint tnum">{awayFor(sum.awayMs)}</span>
                <span className="ml-auto flex shrink-0 items-center gap-3 text-small">
                  {sum.failed.length > 0 && <Count n={sum.failed.length} tone="failed" label="failed" />}
                  {sum.done.length > 0 && <Count n={sum.done.length} tone="done" label="done" />}
                </span>
                <button type="button" onClick={close} className="h-[28px] shrink-0 rounded-[8px] px-2.5 text-small text-dim transition-colors duration-150 hover:bg-hover hover:text-fg" data-away-dismiss>
                  Got it
                </button>
              </header>
              <div className="py-1">
                {shown.map((r) => (
                  <AwayRow
                    key={r.id}
                    r={r}
                    canRetry={canRetry}
                    onOpen={() => {
                      if (r.jump) onJump(r.jump);
                      close();
                    }}
                    onRetry={() => {
                      onRetry(r.retry!);
                      close();
                    }}
                  />
                ))}
                {more > 0 && (
                  <button type="button" onClick={() => setAll(true)} className="flex h-[32px] w-full items-center text-left text-small text-dim transition-colors duration-150 hover:bg-hover hover:text-fg" style={{ paddingLeft: TEXT_X }}>
                    +{more} more
                  </button>
                )}
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AwayRow({ r, canRetry, onOpen, onRetry }: { r: Row; canRetry: boolean; onOpen: () => void; onRetry: () => void }) {
  const failed = r.kind !== "done";
  return (
    <div className="group flex h-[36px] items-center gap-2.5 pl-3.5 pr-1.5 transition-colors duration-150 hover:bg-hover" data-away-row={r.kind}>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" title={r.title}>
        <Node className={failed ? "text-err-text" : "text-done-text"}>{r.kind === "done" ? <ICheck size={13} /> : r.kind === "exited" ? <IReturn size={13} /> : <IAlert size={13} />}</Node>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 text-base text-fg">{r.kind === "done" ? "Finished" : r.kind === "failed" ? "Failed" : ""}</span>
          <span className="min-w-0 shrink truncate text-base text-dim">{r.title}</span>
          {r.detail && <span className={cx("min-w-0 shrink-[2] truncate text-small", r.kind === "failed" ? "text-err-text/85" : "text-faint")}>{r.detail}</span>}
        </span>
      </button>
      {r.retry && canRetry && (
        <button type="button" onClick={onRetry} className="h-[26px] shrink-0 rounded-[7px] border border-hairline px-2 text-small text-dim transition-colors duration-150 hover:bg-press hover:text-fg" data-away-retry>
          Retry
        </button>
      )}
      {r.ts > 0 ? <Age ms={r.ts} /> : <span className="w-[32px] shrink-0" />}
    </div>
  );
}
