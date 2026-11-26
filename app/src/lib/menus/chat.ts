// Right-click menus for chats and the sidebar: plain builders from data and callbacks (no store, no backend), so
// they are testable. lib/menus/chatWired.ts connects them to the app's handlers.
import type { MenuEntry } from "../contextMenu.ts";

type Act = () => void | Promise<void>;
type Copy = (text: string) => void | Promise<void>;

export interface SessionMenuIn {
  title: string;
  id: string;
  /** A name was given by the person (Use automatic title applies). */
  pinned: boolean;
  /** A turn is running in its chat. */
  running: boolean;
  /** The chat can restart (has a live chat, not ended). */
  restartable: boolean;
  /** Session is open in a pane already (then "Open in split" doesn't apply). */
  visible: boolean;
  folder: string | null;
  /** Has a chat to hand to the terminal. */
  chat: boolean;
  a: { newTab: Act; split: Act; rename: Act; auto: Act; restart: Act; stop: Act; terminal: Act; reveal: Act; copy: Copy };
}

export function sessionItems(d: SessionMenuIn): MenuEntry[] {
  return [
    { label: "Open in new tab", action: d.a.newTab },
    !d.visible && { label: "Open in split", action: d.a.split },
    "-",
    { label: "Rename…", action: d.a.rename },
    d.pinned && { label: "Use automatic title", action: d.a.auto },
    "-",
    d.restartable && { label: "Restart", action: d.a.restart },
    d.running && { label: "Stop", action: d.a.stop },
    d.chat && { label: "Open in Terminal", action: d.a.terminal },
    "-",
    { label: "Copy title", action: () => d.a.copy(d.title) },
    { label: "Copy session ID", action: () => d.a.copy(d.id) },
    !!d.folder && { label: "Reveal folder in Finder", action: d.a.reveal },
  ];
}

export interface ProjectMenuIn {
  path: string;
  collapsed: boolean;
  a: { newChat: Act; history: Act; reveal: Act; copy: Copy; toggle: Act };
}

export function projectItems(d: ProjectMenuIn): MenuEntry[] {
  return [
    { label: "New chat here", action: d.a.newChat },
    { label: "History for this project", action: d.a.history },
    "-",
    { label: "Reveal in Finder", action: d.a.reveal },
    { label: "Copy path", action: () => d.a.copy(d.path) },
    "-",
    { label: d.collapsed ? "Expand" : "Collapse", action: d.a.toggle },
  ];
}

/** A message: the selection first (when there is one), then the whole message. */
export function messageItems(d: { selection: string; text: string; copy: Copy; selectAll?: Act }): MenuEntry[] {
  const sel = d.selection.trim() ? d.selection : "";
  return [
    !!sel && { label: "Copy", action: () => d.copy(sel) },
    !!d.text.trim() && { label: "Copy message", action: () => d.copy(d.text) },
    !!d.selectAll && { label: "Select all in message", action: d.selectAll },
  ];
}

export function codeItems(d: { code: string; lang: string; selection: string; copy: Copy }): MenuEntry[] {
  return [
    !!d.selection.trim() && { label: "Copy", action: () => d.copy(d.selection) },
    { label: "Copy code", action: () => d.copy(d.code) },
    { label: "Copy as markdown", action: () => d.copy("```" + d.lang + "\n" + d.code + "\n```") },
  ];
}

export function linkItems(d: { href: string; web: boolean; selection: string; panel: Act; browser?: Act; copy: Copy }): MenuEntry[] {
  return [
    !!d.selection.trim() && { label: "Copy", action: () => d.copy(d.selection) },
    d.web && { label: "Open in browser panel", action: d.panel },
    d.web && !!d.browser && { label: "Open in default browser", action: d.browser },
    { label: "Copy link", action: () => d.copy(d.href) },
  ];
}

export interface FileMenuIn {
  /** Absolute path. */
  path: string;
  /** As the reader sees it (relative to the chat's folder). */
  rel: string;
  a: { open?: Act; diff?: Act; reveal: Act; copy: Copy };
}

export function fileItems(d: FileMenuIn): MenuEntry[] {
  return [
    !!d.a.open && { label: "Open", action: d.a.open },
    !!d.a.diff && { label: "Show diff", action: d.a.diff },
    { label: "Reveal in Finder", action: d.a.reveal },
    { label: "Copy relative path", action: () => d.a.copy(d.rel) },
    { label: "Copy full path", action: () => d.a.copy(d.path) },
  ];
}

export interface StepMenuIn {
  command?: string;
  output?: string;
  /** What the row says, when it has neither a command nor a path. */
  detail?: string;
  file?: FileMenuIn;
  /** Folds the output; absent when the step has none to show. */
  fold?: { open: boolean; toggle: Act };
  copy: Copy;
}

export function stepItems(d: StepMenuIn): MenuEntry[] {
  return [
    !!d.command && { label: "Copy command", action: () => d.copy(d.command!) },
    !d.command && !d.file && !!d.detail && { label: "Copy details", action: () => d.copy(d.detail!) },
    !!d.output?.trim() && { label: "Copy output", action: () => d.copy(d.output!) },
    !!d.fold && { label: d.fold.open ? "Collapse" : "Expand", action: d.fold.toggle },
    !!d.file && "-",
    ...(d.file ? fileItems(d.file) : []),
  ];
}

export function tabItems(d: { count: number; close: Act; closeOthers: Act; splitRight: Act; splitDown: Act }): MenuEntry[] {
  return [
    { label: "Close tab", action: d.close },
    { label: "Close other tabs", action: d.closeOthers, enabled: d.count > 1 },
    "-",
    { label: "Split right", action: d.splitRight },
    { label: "Split down", action: d.splitDown },
  ];
}

/** A subagent's card: its task and result, and folding it. */
export function agentItems(d: { task?: string; result?: string; fold: { open: boolean; toggle: Act }; copy: Copy }): MenuEntry[] {
  return [
    !!d.task?.trim() && { label: "Copy task", action: () => d.copy(d.task!) },
    !!d.result?.trim() && { label: "Copy result", action: () => d.copy(d.result!) },
    { label: d.fold.open ? "Collapse" : "Expand", action: d.fold.toggle },
  ];
}

/** "N files changed": the changes panel, and each file's own actions (a submenu per file when there are several). */
export function turnFilesItems(d: { files: { label: string; items: MenuEntry[] }[]; show: Act }): MenuEntry[] {
  const one = d.files.length === 1;
  return [
    { label: "Show changes", action: d.show },
    "-",
    ...(one ? d.files[0].items : d.files.slice(0, 12).map((f) => ({ label: f.label, items: f.items }))),
  ];
}
