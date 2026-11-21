// Ladder's helpers in the sidebar and the Jobs panel (APP_SPEC "Ladder"): a chat started by another chat's `spawn`
// (ChatInfo.helper) shows as that chat's child, and helpers with helpers of their own (native nested sub-agents, or
// spawned chats of spawned chats) show as a tree.
//
// Pure: unit-tested by ladderHelpers.test.ts.

/** What the backend says of a helper chat (`ChatRow.helper`). */
export interface HelperInfo {
  parent: number;
  depth: number;
  model: string;
  title: string;
  worktree: string | null;
  done: boolean;
}

type Sess = { id: string; chat?: number | null; nested?: boolean; parent?: string | null };

/**
 * Sessions whose chat is a helper become nested under their caller's session (once the caller has one). Only those
 * sessions are copied; every other object is returned as it was (the store keeps unchanged rows by identity).
 */
export function markHelpers<S extends Sess>(sessions: S[], helpers: Record<number, HelperInfo | null | undefined>, sessionOfChat: (chat: number) => string | null): S[] {
  let out: S[] | null = null;
  sessions.forEach((s, i) => {
    const h = s.chat != null ? helpers[s.chat] : null;
    if (!h) return;
    const parent = sessionOfChat(h.parent);
    if (!parent || (s.nested && s.parent === parent)) return;
    out ??= sessions.slice();
    out[i] = { ...s, nested: true, parent };
  });
  return out ?? sessions;
}

/** Every descendant of `root` (direct children first, each followed by its own), with its depth (1 = a child). */
export function descendants<T>(root: string, children: (id: string) => T[], idOf: (t: T) => string, max = 6): { item: T; depth: number; parent: string }[] {
  const out: { item: T; depth: number; parent: string }[] = [];
  const walk = (id: string, depth: number) => {
    if (depth > max) return;
    for (const c of children(id)) {
      out.push({ item: c, depth, parent: id });
      walk(idOf(c), depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

/**
 * Cards in tree order: each root where `ordered` put it, followed by its descendants (in their own `ordered` order).
 * A card whose parent isn't among the cards is a root.
 */
export function treeOrder<C extends { id: string; parentRef?: string | null }>(ordered: C[]): C[] {
  const ids = new Set(ordered.map((c) => c.id));
  const kids = new Map<string, C[]>();
  for (const c of ordered) {
    if (c.parentRef && ids.has(c.parentRef) && c.parentRef !== c.id) kids.set(c.parentRef, [...(kids.get(c.parentRef) ?? []), c]);
  }
  const out: C[] = [];
  const seen = new Set<string>();
  const put = (c: C) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    out.push(c);
    for (const k of kids.get(c.id) ?? []) put(k);
  };
  for (const c of ordered) if (!c.parentRef || !ids.has(c.parentRef)) put(c);
  // Cycles (never expected): whatever is left, in order.
  for (const c of ordered) put(c);
  return out;
}

/** The root card id of a card (itself when it has no parent among the cards). */
export function rootOf<C extends { id: string; parentRef?: string | null }>(c: C, byId: Map<string, C>): string {
  let cur = c;
  for (let i = 0; i < 8 && cur.parentRef && byId.has(cur.parentRef); i++) cur = byId.get(cur.parentRef)!;
  return cur.id;
}
