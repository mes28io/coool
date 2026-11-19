// Number keys on question cards (CHAT_SPEC "Questions"): options are numbered, and 1–9 answer while the card has
// focus, never while typing in the composer or any field. Pure (tested in questionKeys.test.ts).

/** The option a key picks (0-based), or null: a plain 1–9 with no modifier, and only up to `count` options. */
export function digitPick(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; isComposing?: boolean }, count: number): number | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return null;
  if (!/^[1-9]$/.test(e.key)) return null;
  const i = Number(e.key) - 1;
  return i < count ? i : null;
}

/** True for anything the person types into (inputs, text areas, selects, editable text): keys there are text. */
export function isTyping(el: { tagName?: string; isContentEditable?: boolean; getAttribute?: (n: string) => string | null } | null | undefined): boolean {
  if (!el) return false;
  const tag = (el.tagName ?? "").toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    const type = (el.getAttribute?.("type") ?? "text").toLowerCase();
    return !/^(button|checkbox|radio|submit|reset|range|color|file|image)$/.test(type);
  }
  return !!el.isContentEditable;
}

/**
 * Which question of a card a number key answers: the one holding focus (`focused`, its index, or -1), else the first
 * one with nothing picked yet, else the first.
 */
export function keyQuestion(picked: readonly (readonly string[])[], focused: number): number {
  if (focused >= 0 && focused < picked.length) return focused;
  const open = picked.findIndex((p) => p.length === 0);
  return open >= 0 ? open : 0;
}

/** The card's one folded line: "Claude has a question · Which retry approach?" (the first question's text, one line). */
export function laterLine(who: string, questions: readonly { question: string; header?: string }[]): string {
  const q = questions[0];
  const text = (q?.question || q?.header || "").split("\n")[0].trim();
  const lead = questions.length > 1 ? `${who} has ${questions.length} questions` : `${who} has a question`;
  return text ? `${lead} · ${text}` : lead;
}
