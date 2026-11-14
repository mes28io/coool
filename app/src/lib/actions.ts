// User-level chat flows shared by the sheet, palette, session view and cards.
// Every flow fails soft when the backend has no chat commands yet
// (NotAvailable): it falls back to the PTY flow and says so.

import { useStore } from "../store";
import { api, isNotAvailable } from "./backend";
import { useChats, type PermissionAnswer } from "./chat";
import { estimateSize } from "./termlite";
import type { Provider, Session } from "./types";
import { sessionKey } from "./types";

const toast = (t: string, tone: "info" | "error" = "info") => useStore.getState().toast(t, tone);

function place(target: { kind: "chat"; id: number } | { kind: "pty"; id: number }, leaf?: string) {
  const st = useStore.getState();
  if (leaf) st.setPaneTarget(leaf, target);
  else st.open(target);
}

/** New chat (default for anything coool starts). Falls back to a terminal session. */
export async function newChat(a: { provider: Provider; cwd: string; prompt?: string; leaf?: string; model?: string | null; permissionMode?: string | null }): Promise<boolean> {
  try {
    const id = await api().startChat({ provider: a.provider, cwd: a.cwd, model: a.model ?? null, permission_mode: a.permissionMode ?? null });
    useChats.getState().ensure({ id, provider: a.provider, cwd: a.cwd, session_id: null, model: a.model ?? null, state: "idle", running: true });
    place({ kind: "chat", id }, a.leaf);
    if (a.prompt?.trim()) await api().chatSend(id, a.prompt.trim());
    return true;
  } catch (e) {
    if (!isNotAvailable(e)) throw e;
    toast("Chat sessions aren't available in this build yet, so this one opened in the terminal.");
    const { rows, cols } = estimateSize();
    const id = await api().spawnSession({ provider: a.provider, cwd: a.cwd, args: a.prompt?.trim() ? [a.prompt.trim()] : [], rows, cols });
    const st = useStore.getState();
    st.setMode({ kind: "pty", id }, "terminal");
    place({ kind: "pty", id }, a.leaf);
    return true;
  }
}

/** Resume an ended (or external, stopped) session as a chat; terminal as fallback or on request. */
export async function resumeSession(s: Session, leaf?: string, opts?: { terminal?: boolean }) {
  const st = useStore.getState();
  try {
    if (!opts?.terminal) {
      try {
        const id = await api().startChat({ provider: s.provider, cwd: s.cwd, resume: s.id, model: s.model || null });
        useChats.getState().ensure({ id, provider: s.provider, cwd: s.cwd, session_id: s.id, model: s.model || null, state: "idle", running: true });
        useChats.getState().setEarlier(id, s.activity);
        st.setMode({ kind: "session", key: sessionKey(s) }, "activity");
        place({ kind: "chat", id }, leaf);
        return;
      } catch (e) {
        if (!isNotAvailable(e)) throw e;
        toast("Chat sessions aren't available in this build yet, so this resumed in the terminal.");
      }
    }
    const { rows, cols } = estimateSize();
    const id = await api().resumeSession({ provider: s.provider, sessionId: s.id, cwd: s.cwd, rows, cols });
    st.setMode({ kind: "pty", id }, "terminal");
    st.setMode({ kind: "session", key: sessionKey(s) }, "terminal");
    place({ kind: "pty", id }, leaf);
  } catch (e) {
    toast(String(e), "error");
  }
}

/** Secondary action: continue a chat's session in the real CLI. */
export async function openChatInTerminal(chat: number, s: Session | null) {
  const st = useStore.getState();
  try {
    const pty = await api().openInTerminal(chat);
    if (s) {
      st.notePty(sessionKey(s), pty);
      st.setMode({ kind: "session", key: sessionKey(s) }, "terminal");
    } else {
      st.setMode({ kind: "pty", id: pty }, "terminal");
      st.open({ kind: "pty", id: pty });
    }
  } catch (e) {
    if (isNotAvailable(e)) {
      useChats.getState().local(chat, { level: "warn", text: "Open in terminal isn't available in this build yet." });
      if (s?.status === "ended") return resumeSession(s, undefined, { terminal: true });
      return;
    }
    toast(String(e), "error");
  }
}

/** Wrap a chat command: NotAvailable becomes an inline notice, other errors a toast. */
export async function chatCall(chat: number, f: () => Promise<unknown>): Promise<boolean> {
  try {
    await f();
    return true;
  } catch (e) {
    if (isNotAvailable(e)) useChats.getState().local(chat, { level: "warn", text: `${e.message}.` });
    else toast(String(e), "error");
    return false;
  }
}

/** Answer a question card: per question, the picked labels and/or typed text; null declines. */
export function answerQuestion(chat: number, requestId: string, answers: string[][] | null) {
  useChats.getState().answerQuestion(chat, requestId, answers ?? "declined");
  void chatCall(chat, () => (answers ? api().chatRespondQuestion(chat, requestId, answers) : api().chatRespondPermission(chat, requestId, false, false))).then((ok) => {
    // Refused (e.g. the turn ended meanwhile): let the card be answered again if it is still open.
    if (!ok) useChats.getState().answerQuestion(chat, requestId, "answered");
  });
}

export function answerPermission(chat: number, requestId: string, a: Exclude<PermissionAnswer, "answered">) {
  useChats.getState().answer(chat, requestId, a);
  void chatCall(chat, () => api().chatRespondPermission(chat, requestId, a !== "deny", a === "always"));
}
