// Text handed to a chat's composer before it mounts: a prompt that never reached an agent, carried over to a new
// chat (a chat that couldn't be opened offers "New chat in this folder"). Taken once by the composer.

const drafts = new Map<number, string>();

export function setDraft(chat: number, text: string) {
  if (text.trim()) drafts.set(chat, text);
}

export function takeDraft(chat: number): string {
  const t = drafts.get(chat) ?? "";
  drafts.delete(chat);
  return t;
}
