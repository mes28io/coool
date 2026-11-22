// Steering UI: the strip of queued notes above the composer input, the "notes weren't
// used" strip after a turn, and a delivered note in the timeline.

import { AnimatePresence, motion } from "motion/react";
import type { Chat, ChatItem, Note } from "../lib/chat";
import { clockTime } from "../lib/format";
import { MessageAttachments } from "./Attachments";
import { canCancel, cancelNote, discardUnused, noteNow, sendUnused } from "../lib/steer";
import { IBolt, ICheck, IClip, IClose, IReturn } from "./icons";
import { ease } from "./primitives";
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
            <div className="flex flex-col gap-1.5 px-2.5 pb-1 pt-2.5">
              <div className="flex items-center gap-1.5 px-1 text-small font-medium text-running-text">
                <span className="relative flex size-[7px]" aria-hidden>
                  <span className="absolute inset-0 rounded-full bg-running opacity-40 motion-safe:animate-ping" />
                  <span className="relative size-[7px] rounded-full bg-running" />
                </span>
                {queued.length > 1 ? `${queued.length} queued` : "Queued"}
                <span className="font-normal text-faint">· {local ? "sends when this turn ends" : "goes in at the next step"}</span>
              </div>
              <AnimatePresence initial={false}>
                {queued.map((n) => (
                  <motion.div key={n.id} {...slide()} className="overflow-hidden">
                    <div className="group/note flex min-h-[34px] items-center gap-2 rounded-[12px] border border-[color-mix(in_oklab,var(--status-running)_22%,var(--border))] bg-[color-mix(in_oklab,var(--status-running)_7%,transparent)] py-1 pl-3 pr-1 text-base">
                      <span className="min-w-0 flex-1 truncate text-fg" title={n.text}>
                        {n.text}
                      </span>
                      <NoteAtts n={n} />
                      {!local && canCancel(chat, n) && (
                        <button type="button" onClick={() => void noteNow(chat, n.id)} title="Deliver now: interrupt the current step" data-note-now className="flex h-[24px] shrink-0 items-center gap-1 rounded-[7px] px-1.5 text-small font-medium text-dim hover:bg-hover hover:text-fg">
                          <IBolt size={12} /> Now
                        </button>
                      )}
                      {canCancel(chat, n) && (
                        <button type="button" onClick={() => void cancelNote(chat, n.id)} title="Remove" data-note-remove className="flex size-[24px] shrink-0 items-center justify-center rounded-[7px] text-faint hover:bg-hover hover:text-fg">
                          <IClose size={13} />
                        </button>
                      )}
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

/** A note's attachments: a clip and their count, names in the tooltip; they go in with the note. */
function NoteAtts({ n }: { n: Note }) {
  const a = n.attachments ?? [];
  if (!a.length) return null;
  const imgs = a.filter((x) => x.kind === "image").length;
  return (
    <span className="flex shrink-0 items-center gap-1 text-small text-dim" title={`With the note:\n${a.map((x) => x.name).join("\n")}`} data-note-attachments={a.length}>
      <IClip size={12} />
      {imgs && imgs === a.length ? `${imgs} image${imgs > 1 ? "s" : ""}` : `${a.length} attached`}
    </span>
  );
}

/**
 * A delivered note, where the agent took it in: the person's words as a message of theirs, marked as a note
 * ("Picked up" at a step boundary, "Interrupted" when it cut the step). Always in the timeline, so a note that left
 * the strip is always somewhere on screen.
 */
export function NoteBubble({ item }: { item: Extract<ChatItem, { kind: "note" }> }) {
  const cut = item.state === "interrupted";
  return (
    <div className="flex flex-col items-end gap-1 pt-1" data-note={item.state} data-note-id={item.noteId}>
      {!!item.attachments?.length && <MessageAttachments atts={item.attachments} scope={item.key} />}
      {item.text.trim() && (
        <div className="selectable max-w-[86%] whitespace-pre-wrap break-words rounded-[18px] rounded-br-[6px] border border-[color-mix(in_oklab,var(--status-running)_22%,var(--border))] bg-[color-mix(in_oklab,var(--status-running)_7%,var(--raised))] px-4 py-3 text-prose text-fg shadow-card">
          {item.text}
        </div>
      )}
      <span className="flex items-center gap-1 pr-1 font-mono text-mono-small text-faint tnum">
        {cut ? <IReturn size={11} /> : <ICheck size={11} />}
        {`${clockTime(item.ts)} · ${cut ? "Interrupted the step" : "Picked up mid-turn"}`}
      </span>
    </div>
  );
}
