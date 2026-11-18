// Keyboard shortcuts: the one table. App.tsx's window handler runs the `global` ones from here (`matchShortcut`),
// and Settings > Keyboard shortcuts lists every row. The `inChat` and `inSheet` rows are handled where they apply
// (ChatComposer, SessionView, Sheets); they are listed here so the page is complete, and each names the component
// that implements it so a change there is a change here.

export type ShortcutGroup = "General" | "Tabs and panes" | "In a chat" | "In sheets and lists";

export interface KeyEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
}

export interface Shortcut {
  id: string;
  group: ShortcutGroup;
  label: string;
  /** Keycaps as shown, in order ("⌘", "⇧", "L"). */
  keys: string[];
  /** Extra words the search matches ("dark", "light"). */
  terms?: string;
  /** Only for rows the window handler runs: whether this key event is it. ⌘ and Ctrl count the same. */
  match?: (e: KeyEventLike) => boolean;
  /** Skipped (and swallowed) while the Settings page is up: it would act on panes out of sight. */
  hiddenBySettings?: boolean;
  /** Where a contextual shortcut is handled. */
  where?: string;
}

const mod = (e: KeyEventLike) => e.metaKey || e.ctrlKey;
const key = (e: KeyEventLike) => e.key.toLowerCase();
const plain = (k: string) => (e: KeyEventLike) => mod(e) && !e.shiftKey && key(e) === k;
const backslash = (e: KeyEventLike) => key(e) === "\\" || e.code === "Backslash";

export const SHORTCUTS: Shortcut[] = [
  { id: "palette", group: "General", label: "Search and commands", keys: ["⌘", "K"], terms: "palette jump find", match: (e) => mod(e) && key(e) === "k" },
  { id: "new", group: "General", label: "New session", keys: ["⌘", "T"], terms: "chat start", match: plain("t") },
  { id: "settings", group: "General", label: "Settings", keys: ["⌘", ","], terms: "preferences", match: plain(",") },
  { id: "theme", group: "General", label: "Switch light and dark theme", keys: ["⌘", "⇧", "L"], terms: "appearance dark light", match: (e) => mod(e) && e.shiftKey && key(e) === "l" },
  { id: "sidebar", group: "General", label: "Show or hide the sidebar", keys: ["⌘", "B"], match: plain("b"), hiddenBySettings: true },
  { id: "home", group: "Tabs and panes", label: "Home", keys: ["⌘", "0"], terms: "mission control overview", match: plain("0") },
  { id: "tab", group: "Tabs and panes", label: "Go to tab 1 to 9", keys: ["⌘", "1…9"], terms: "switch", match: (e) => mod(e) && !e.shiftKey && /^[1-9]$/.test(e.key) },
  { id: "close", group: "Tabs and panes", label: "Close the focused pane or tab", keys: ["⌘", "W"], match: plain("w"), hiddenBySettings: true },
  { id: "split-right", group: "Tabs and panes", label: "Split right", keys: ["⌘", "\\"], match: (e) => mod(e) && !e.shiftKey && backslash(e), hiddenBySettings: true },
  { id: "split-down", group: "Tabs and panes", label: "Split down", keys: ["⌘", "⇧", "\\"], match: (e) => mod(e) && e.shiftKey && backslash(e), hiddenBySettings: true },
  { id: "send", group: "In a chat", label: "Send the message (steers a running turn)", keys: ["↵"], where: "ChatComposer" },
  { id: "newline", group: "In a chat", label: "New line", keys: ["⇧", "↵"], where: "ChatComposer" },
  { id: "steer-now", group: "In a chat", label: "Interrupt and send now", keys: ["⌘", "↵"], terms: "steer", where: "ChatComposer" },
  { id: "interrupt", group: "In a chat", label: "Interrupt the turn (empty composer)", keys: ["Esc"], terms: "stop", where: "ChatComposer" },
  { id: "history", group: "In a chat", label: "Earlier prompts", keys: ["↑", "↓"], terms: "history recall", where: "ChatComposer" },
  { id: "allow", group: "In a chat", label: "Allow the permission request", keys: ["⌘", "↵"], terms: "approve", where: "SessionView" },
  { id: "always", group: "In a chat", label: "Always allow in this chat", keys: ["⌘", "⇧", "↵"], terms: "remember approve", where: "SessionView" },
  { id: "deny", group: "In a chat", label: "Deny the permission request", keys: ["⌘", "⌫"], where: "SessionView" },
  { id: "launch", group: "In sheets and lists", label: "Start the new session", keys: ["⌘", "↵"], where: "Sheets" },
  { id: "back", group: "In sheets and lists", label: "Close a sheet, the palette or Settings", keys: ["Esc"], terms: "back", where: "Sheets, Palette, SettingsPage" },
];

/** The global shortcut this key event is, if any (first match in table order). */
export function matchShortcut(e: KeyEventLike): Shortcut | null {
  if (!mod(e)) return null;
  return SHORTCUTS.find((s) => s.match?.(e)) ?? null;
}

/** Rows whose label, keys or terms contain every word of `q`. */
export function searchShortcuts(q: string, list: Shortcut[] = SHORTCUTS): Shortcut[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((s) => {
    const hay = `${s.label} ${s.group} ${s.keys.join(" ")} ${s.terms ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
