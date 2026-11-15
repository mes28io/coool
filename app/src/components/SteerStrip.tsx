// Steering UI: the strip of queued notes above the composer input, the "notes weren't
// used" strip after a turn, and the rows that attach a delivered note under its step.

import { AnimatePresence, motion } from "motion/react";
import type { Chat, Note } from "../lib/chat";
import { cancelNote, discardUnused, noteNow, sendUnused } from "../lib/steer";
import { IBolt, ICheck, IClose, IReturn } from "./icons";
import { cx, ease } from "./primitives";
import { reducedMotion } from "./StepRail";

const slide = () => {
  const i = reducedMotion();
  return {
    initial: i ? false : { height: 0, opacity: 0 },
    animate: { height: "auto", opacity: 1 },
    exit: i ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 },
    transition: { duration: i ? 0 : 0.22, ease },
  } as const;
};

export function SteerStrip({ chat }: { chat: Chat }) {
  const queued = chat.notes.filter((n) => n.state === "queued");
  const unused = chat.notes.filter((n) => n.state === "unused");
  const local = queued.some((n) => n.local);
  return (
    <>
      <AnimatePresence initial={false}>
        {queued.length > 0 && (
          <motion.div key="queued" {...slide()} className="overflow-hidden" data-steer-queued={queued.length}>
            <div className="px-3.5 pb-0.5 pt-2.5">
              <div className="flex items-center gap-1.5 font-mono text-micro font-medium uppercase tracking-[0.06em] text-faint">
                {local ? "Queued for when this turn ends" : "Queued for the next step"}
                {queued.length > 1 && <span className="tnum">{queued.length}</span>}
              </div>
              <AnimatePresence initial={false}>
                {queued.map((n) => (
                  <motion.div key={n.id} {...slide()} className="overflow-hidden">
                    <div className="group/note flex h-[30px] items-center gap-2 text-base">
                      <span className="min-w-0 flex-1 truncate text-fg/85" title={n.text}>
                        {n.text}
                      </span>
                      {!local && (
                        <button type="button" onClick={() => void noteNow(chat, n.id)} title="Deliver now: interrupt the current step" data-note-now className="flex h-[24px] shrink-0 items-center gap-1 rounded-[7px] px-1.5 text-small font-medium text-dim hover:bg-hover hover:text-fg">
                          <IBolt size={12} /> Now
                        </button>
                      )}
                      <button type="button" onClick={() => void cancelNote(chat, n.id)} title="Remove" data-note-remove className="flex size-[24px] shrink-0 items-center justify-center rounded-[7px] text-faint hover:bg-hover hover:text-fg">
                        <IClose size={13} />
                      </button>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
        {unused.length > 0 && (
          <motion.div key="unused" {...slide()} className="overflow-hidden" data-steer-unused={unused.length}>
            <div className="flex items-center gap-2 px-3.5 pt-2.5 text-small text-dim">
              <span className="min-w-0 flex-1 truncate" title={unused.map((n) => n.text).join("\n")}>
                {unused.length === 1 ? "1 note wasn't used" : `${unused.length} notes weren't used`}
              </span>
              <button type="button" onClick={() => sendUnused(chat)} data-send-unused className="flex h-[24px] items-center rounded-[7px] px-2 font-medium text-fg hover:bg-hover">
                Send now
              </button>
              <button type="button" onClick={() => discardUnused(chat)} data-discard-unused className="flex h-[24px] items-center rounded-[7px] px-2 text-faint hover:bg-hover hover:text-fg">
                Discard
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** Delivered notes attached under the step they were picked up in. */
export function NoteRows({ notes }: { notes: Note[] }) {
  const shown = notes.filter((n) => n.state === "picked_up" || n.state === "interrupted");
  if (!shown.length) return null;
  return (
    <AnimatePresence initial={false}>
      {shown.map((n) => (
        <motion.div key={n.id} initial={reducedMotion() ? false : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} transition={{ duration: reducedMotion() ? 0 : 0.24, ease }} className="overflow-hidden" data-note={n.state}>
          <div className="flex h-[26px] items-center gap-2 pl-[28px] pr-2 text-small text-dim">
            <span className="shrink-0 text-faint">↳</span>
            <span className="min-w-0 flex-1 truncate" title={n.text}>
              {n.text}
            </span>
            <span className={cx("flex shrink-0 items-center gap-1 text-faint")}>
              {n.state === "interrupted" ? <IReturn size={12} /> : <ICheck size={12} />}
              {n.state === "interrupted" ? "Interrupted" : "Picked up"}
            </span>
          </div>
        </motion.div>
      ))}
    </AnimatePresence>
  );
}
