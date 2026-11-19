// "Later" on a question card (CHAT_SPEC "Questions"): the card folds to one line just above the composer, so the
// person can keep reading the timeline; the line reopens it. UI state only (which questions are set aside), per chat
// and request, never persisted; answering, declining or the turn ending clears the line with the question.

import { AnimatePresence, motion } from "motion/react";
import { create } from "zustand";
import type { Chat, ChatItem } from "../lib/chat";
import { useMotion } from "../lib/motion";
import { laterLine } from "../lib/questionKeys";
import { cx, ease } from "./primitives";

const laterKey = (chat: number, requestId: string) => `${chat}:${requestId}`;

export const useQuestionLater = create<{ later: Record<string, true>; fold(chat: number, requestId: string): void; unfold(chat: number, requestId: string): void }>((set) => ({
  later: {},
  fold: (chat, requestId) => set((s) => ({ later: { ...s.later, [laterKey(chat, requestId)]: true } })),
  unfold: (chat, requestId) =>
    set((s) => {
      const later = { ...s.later };
      delete later[laterKey(chat, requestId)];
      return { later };
    }),
}));

export const useFolded = (chat: number, requestId: string) => useQuestionLater((s) => !!s.later[laterKey(chat, requestId)]);

/** Reopen a set-aside question and bring its card into view, focused (so 1–9 answer right away). */
export function reopenQuestion(chat: number, requestId: string, reduce: boolean) {
  useQuestionLater.getState().unfold(chat, requestId);
  // The card mounts once the folded placeholder has left (a frame or two): look for it for up to a second.
  const until = performance.now() + 1000;
  const find = () => {
    const card = document.querySelector<HTMLElement>(`[data-chat-timeline="${chat}"] [data-question="${CSS.escape(requestId)}"]`);
    if (!card) {
      if (performance.now() < until) requestAnimationFrame(find);
      return;
    }
    card.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    card.focus({ preventScroll: true });
  };
  requestAnimationFrame(find);
}

type Ask = Extract<ChatItem, { kind: "question" }>;

/** The folded line, at the bottom of the timeline (just above the composer). */
export function LaterBar({ chat, compact }: { chat: Chat; compact?: boolean }) {
  const reduce = useMotion().reduce;
  const id = chat.pendingQuestion;
  const item = id ? (chat.items.find((i) => i.kind === "question" && i.requestId === id) as Ask | undefined) : undefined;
  const folded = useQuestionLater((s) => !!(id && s.later[laterKey(chat.id, id)]));
  const show = !!item && folded && chat.running && item.answer === null;
  const who = chat.provider === "claude" ? "Claude" : "Codex";
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key={item.requestId}
          initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, height: "auto" }}
          exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, height: 0, transition: { duration: 0.14 } }}
          transition={{ duration: 0.2, ease }}
          className="relative z-[11] shrink-0 overflow-hidden"
        >
          <div className={cx("mx-auto max-w-[700px] pt-1.5", compact ? "px-4" : "px-8")}>
            <button
              type="button"
              onClick={() => reopenQuestion(chat.id, item.requestId, reduce)}
              className="flex h-[34px] w-full min-w-0 items-center gap-2 rounded-[10px] border border-[color-mix(in_oklab,var(--status-needs)_30%,var(--border))] bg-raised pl-2 pr-2.5 text-left shadow-card transition-colors duration-150 hover:bg-hover"
              data-question-later={item.requestId}
            >
              <span className="flex size-[20px] shrink-0 items-center justify-center rounded-[5px] bg-[color-mix(in_oklab,var(--status-needs)_16%,transparent)] text-small font-bold text-needs-text">?</span>
              <span className="min-w-0 flex-1 truncate text-base text-fg">{laterLine(who, item.questions)}</span>
              <span className="shrink-0 text-small font-medium text-dim">Answer</span>
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
