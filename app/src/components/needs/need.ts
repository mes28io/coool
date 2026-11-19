// One item of the Needs you page, read once for the list row and the detail: what it asks in plain words, its
// kind, and since when it waits. Wording comes from the chat's own card (`permDetail` in Chat.tsx) and from
// `attention()` (lib/live.ts) for what a transcript says.

import { pendingPermission, pendingQuestion, useChats, type Chat, type ChatItem } from "../../lib/chat";
import { permKind, type NeedKind } from "../../lib/needs";
import { sessionKey } from "../../lib/types";
import { permDetail } from "../Chat";
import type { Needed } from "./useNeedsYou";

export type Perm = Extract<ChatItem, { kind: "permission" }>;
export type Ask = Extract<ChatItem, { kind: "question" }>;

export interface Need extends Needed {
  key: string;
  /** The coool chat driving the session, when there is one. */
  chat: Chat | null;
  perm: Perm | null;
  ask: Ask | null;
  kind: NeedKind;
  /** Epoch ms it has waited since (the request's own time in a chat; the transcript's last write otherwise). */
  since: number;
  /** "Claude" / "Codex". */
  who: string;
  /** The row's first line: what it wants, in plain words ("Run a command"). */
  what: string;
  /** What exactly, one line ("npm test", "src/lib.rs", the question). */
  detail: string;
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const strip = (t: string) => t.replace(/^Waiting for you: /, "").replace(/^A job (is waiting for you|needs you): /, "");

export function readNeed(n: Needed, chat: Chat | null): Need {
  const { s, a } = n;
  const perm = chat?.running ? pendingPermission(chat) : null;
  const ask = chat?.running && !perm ? pendingQuestion(chat) : null;
  const who = s.provider === "codex" ? "Codex" : "Claude";
  const base = { ...n, key: sessionKey(s), chat, perm, ask, who };
  if (perm) {
    const kind = permKind(perm.tool, perm.input);
    if (kind === "plan") {
      const raw = (perm.input as { plan?: unknown } | null)?.plan;
      const title = typeof raw === "string" ? (/^#+\s*(.+)$/m.exec(raw)?.[1] ?? raw.split("\n")[0]) : perm.summary;
      return { ...base, kind, since: perm.ts, what: "Approve a plan", detail: title.trim() };
    }
    const d = permDetail(perm, chat!.cwd);
    return { ...base, kind, since: perm.ts, what: cap(d.lead), detail: d.body.split("\n")[0] };
  }
  if (ask) {
    const q = ask.questions[0]?.question ?? "A question";
    return { ...base, kind: "question", since: ask.ts, what: ask.questions.length > 1 ? `${ask.questions.length} questions` : "A question", detail: q };
  }
  const text = a.needs ?? "";
  if (a.source === "cli") return { ...base, kind: "terminal", since: s.last_event ?? s.updated, what: "Waiting in its terminal", detail: strip(text) };
  if (a.source === "job") return { ...base, kind: "job", since: s.updated, what: "A job it started waits", detail: strip(text) };
  return { ...base, kind: "insight", since: s.insight?.generated_ms ?? s.updated, what: "It may need you", detail: text };
}

/** The item, kept current with its chat (only that chat's changes re-render). */
export function useNeed(n: Needed): Need {
  const chat = useChats((st) => (n.s.chat != null ? (st.chats[n.s.chat] ?? null) : null));
  return readNeed(n, chat);
}
