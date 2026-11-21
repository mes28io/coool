// Notes to the agent about the person's undos (the Changes panel's "Tell the agent when I undo", on by default), so
// it doesn't fight them: sent through steering (lib/steer.ts) while the agent works, at its next step; held while
// the chat is idle and sent once its next turn starts (never a message of their own, which would start a turn).
// Also: when the agent edits a file again after the person undid its change there, it is told once.

import { useEffect } from "react";
import { create } from "zustand";
import { api } from "./backend";
import { type Chat, useChats } from "./chat";
import { tellAgentPref, type ChangesTarget } from "./changes";
import { reeditNote, type ChangeSet } from "./changesRules";
import { steer } from "./steer";

const held = create<{ notes: Record<number, string[]> }>(() => ({ notes: {} }));

const working = (c: Chat | undefined) => !!c && c.running && c.state !== "idle";

/** A note for the chat's agent: now if it is working, else with its next turn. */
export function queueAgentNote(chatId: number, text: string) {
  const c = useChats.getState().chats[chatId];
  if (working(c)) {
    void steer(c!, text, false);
    return;
  }
  held.setState((s) => ({ notes: { ...s.notes, [chatId]: [...(s.notes[chatId] ?? []), text] } }));
}

/** The notes held for a chat (shown in the panel). */
export const useHeldNotes = (chatId: number | null) => held((s) => (chatId === null ? 0 : (s.notes[chatId]?.length ?? 0)));

/** Delivers held notes when the chat's next turn starts, and tells the agent about files it edited again after an undo. */
export function useChangeNotes(chat: Chat | null, data: ChangeSet | null, target: ChangesTarget | null) {
  const isWorking = working(chat ?? undefined);
  const id = chat?.id ?? null;
  const pending = useHeldNotes(id);
  useEffect(() => {
    if (id === null || !isWorking || !pending) return;
    const c = useChats.getState().chats[id];
    const notes = held.getState().notes[id] ?? [];
    if (!c || !notes.length) return;
    held.setState((s) => ({ notes: { ...s.notes, [id]: [] } }));
    void steer(c, notes.join("\n\n"), false);
  }, [id, isWorking, pending]);
  // From the set's own list: a summary (the panel closed) has no files.
  const reedited = data?.reedited ?? [];
  const sig = reedited.map(([p]) => p).join("\n");
  useEffect(() => {
    if (id === null || !sig || !target || !tellAgentPref()) return;
    const paths = sig.split("\n");
    const rels = reedited.map(([, r]) => r);
    void api().changesTold({ ...target, scope: "chat" }, paths).catch(() => {});
    queueAgentNote(id, reeditNote(rels));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, sig]);
}
