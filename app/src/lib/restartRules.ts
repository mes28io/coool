// Restart (CHAT_SPEC "Restart"): the rules behind the chat's Restart button, `/restart` and the "Restart and continue"
// offer under a reply that asks for a restart. Pure, so they are unit-tested (restartRules.test.ts).

import type { ChatItem } from "./chat";

/** `/restart` (alone, or with a message to send once the CLI is back: `/restart continue`). Null: not a restart. */
export function parseRestart(text: string): { message: string } | null {
  const m = /^\/restart(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  return { message: (m[1] ?? "").trim() };
}

// What an agent writes when it wants the CLI started again. Plain phrases only: a reply that merely mentions restarting
// something else (a server, the app, the Mac) gets no button.
const ASK = [
  /\brestart(?:ing)?\s+(?:your\s+|the\s+)?claude(?:\s+code)?\b/i,
  /\brestart(?:ing)?\s+(?:your\s+|the\s+)?codex\b/i,
  /\brestart(?:ing)?\s+(?:this|the|your)\s+(?:claude\s+code\s+|codex\s+)?session\b/i,
  /\brelaunch(?:ing)?\b(?!\s+(?:the\s+)?(?:app|server|simulator|browser|dev\s+server)\b)/i,
];
// "No need to restart Claude Code", "without restarting the session", "don't relaunch": not an ask.
const NOT = /\b(?:no\s+need\s+to|needn't|don't|do\s+not|doesn't\s+need\s+to|without|never|not)\s+(?:\w+\s+){0,2}$/i;

/** Whether an agent's reply asks the person to restart Claude Code / Codex / the session. */
export function asksRestart(text: string): boolean {
  // Code (a command, a log) isn't the agent talking to the person.
  const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  for (const re of ASK) {
    const g = new RegExp(re.source, "gi");
    for (let m = g.exec(prose); m; m = g.exec(prose)) {
      const before = prose.slice(Math.max(0, m.index - 40), m.index);
      if (!NOT.test(before)) return true;
    }
  }
  return false;
}

/** The reply that offers "Restart and continue": the agent's last top-level reply, when it asks for a restart and
 *  nothing came after it (no newer prompt, no restart, no exit). Its item key, or null. */
export function restartOffer(items: readonly ChatItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if ("parent" in it && it.parent) continue;
    if (it.kind === "turn" || it.kind === "thinking") continue;
    if (it.kind === "text") return !it.streaming && asksRestart(it.text) ? it.key : null;
    // A prompt, a notice (the restart's own), a card, an exit: the moment has passed.
    return null;
  }
  return null;
}

/** The confirmation's words while a turn runs. */
export function restartAsk(provider: string): { title: string; body: string } {
  const cli = provider === "codex" ? "Codex" : "Claude";
  return { title: `${cli} is working. Restart anyway?`, body: "The current step is stopped. The conversation, its folder and settings stay, and it picks up from its transcript." };
}
