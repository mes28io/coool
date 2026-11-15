// Steering: notes sent to the agent while a turn runs.
//
// Client calls (the backend contract, coded against; absent => local fallback):
//   chat_steer({ id, text, now }) -> noteId   now=false: deliver at the next step boundary;
//                                             now=true: interrupt the current step and deliver at once
//   chat_steer_cancel({ id, noteId })
// Events (the source of truth for note state, reconciled by note_id; see chat.ts):
//   { type: "steer", note_id, text, state: "queued"|"picked_up"|"interrupted"|"unused", tool_id }
// Fallback when chat_steer is not available: now=false keeps the note in the client and sends
// it as the next prompt when the turn ends; now=true interrupts (chat_interrupt), waits for the
// turn to end, then sends the note as a prompt.

import { useStore } from "../store";
import { chatCall } from "./actions";
import { api, isNotAvailable } from "./backend";
import { type Chat, useChats } from "./chat";

let missing = false;
let n = 0;

export const steerIsLocal = () => missing;

const toolNow = (chat: Chat): string | null => {
  for (let i = chat.items.length - 1; i >= 0; i--) {
    const it = chat.items[i];
    if (it.kind === "prompt") return null;
    if (it.kind === "tool" && !it.parent) return it.id;
  }
  return null;
};

/** Run `f` once the chat's turn has ended. */
function whenIdle(id: number, f: () => void) {
  const off = useChats.subscribe((s) => {
    const c = s.chats[id];
    if (!c || c.state === "idle" || !c.running) {
      off();
      setTimeout(f, 50);
    }
  });
}

export async function steer(chat: Chat, text: string, now: boolean): Promise<void> {
  const t = text.trim();
  if (!t) return;
  const st = useChats.getState();
  if (!missing) {
    try {
      const id = await api().chatSteer(chat.id, t, now);
      st.noteAdd(chat.id, { id, text: t, state: now ? "interrupted" : "queued", toolId: now ? toolNow(chat) : null, ts: Date.now() });
      return;
    } catch (e) {
      if (!isNotAvailable(e)) {
        useStore.getState().toast(String(e), "error");
        return;
      }
      missing = true;
    }
  }
  const id = `local:${++n}`;
  if (!now) {
    st.noteAdd(chat.id, { id, text: t, state: "queued", toolId: null, ts: Date.now(), local: true });
    return;
  }
  st.noteAdd(chat.id, { id, text: t, state: "interrupted", toolId: toolNow(chat), ts: Date.now(), local: true });
  await chatCall(chat.id, () => api().chatInterrupt(chat.id));
  whenIdle(chat.id, () => void chatCall(chat.id, () => api().chatSend(chat.id, t)));
}

export async function cancelNote(chat: Chat, noteId: string) {
  const note = chat.notes.find((x) => x.id === noteId);
  useChats.getState().noteDrop(chat.id, noteId);
  if (note && !note.local) await api().chatSteerCancel(chat.id, noteId).catch(() => {});
}

/** Deliver a queued note immediately: cancel it and send its text again with now=true. */
export async function noteNow(chat: Chat, noteId: string) {
  const note = chat.notes.find((x) => x.id === noteId);
  if (!note) return;
  await cancelNote(chat, noteId);
  await steer(chat, note.text, true);
}

/** Notes the turn ended without using: send them now as the next prompt, or discard. */
export function sendUnused(chat: Chat) {
  const un = chat.notes.filter((x) => x.state === "unused");
  if (!un.length) return;
  for (const x of un) useChats.getState().noteDrop(chat.id, x.id);
  void chatCall(chat.id, () => api().chatSend(chat.id, un.map((x) => x.text).join("\n\n")));
}
export function discardUnused(chat: Chat) {
  for (const x of chat.notes) if (x.state === "unused") useChats.getState().noteDrop(chat.id, x.id);
}

/** Fallback: notes held in the client are sent as one prompt when the turn has ended. */
export function flushLocal(chat: Chat) {
  const held = chat.notes.filter((x) => x.local && x.state === "queued");
  if (!held.length) return;
  for (const x of held) useChats.getState().noteDrop(chat.id, x.id);
  void chatCall(chat.id, () => api().chatSend(chat.id, held.map((x) => x.text).join("\n\n")));
}
