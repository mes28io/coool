// Right-click menus of the right-hand panels (Changes, Context, Terminal, Browser, iPhone, Mac, Jobs). Plain builders:
// each takes what it shows plus the callbacks to run, so they test without a DOM (panels.test.ts).
import type { MenuEntry } from "../contextMenu";
import type { FileChange, HunkView } from "../changesRules.ts";
import { unifiedText } from "../changesRules.ts";

type Copy = (t: string) => unknown;
const copy = (label: string, text: string, copyText: Copy): MenuEntry => ({ label, action: () => void copyText(text) });

/** The first changed line of a hunk (where "Open at line" lands). */
export const hunkLine = (h: HunkView) => h.lines.find((l) => l.k !== " ")?.n ?? h.new_start;

/** A hunk as unified-diff text, with its file header. */
export const hunkText = (f: Pick<FileChange, "rel" | "from_rel" | "status">, h: HunkView) => unifiedText({ ...f, hunks: [h] });

export interface FileMenuDeps {
  copyText: Copy;
  open: (line: number) => void;
  keep: () => void;
  undo: () => void;
  reveal: () => void;
  /** Keep / Undo can't run now (busy, read-only). */
  locked: boolean;
}

/** A file card's menu. */
export function changesFileMenu(f: FileChange, d: FileMenuDeps): MenuEntry[] {
  const gone = f.status === "undone" || f.status === "unchanged";
  return [
    f.status !== "deleted" && { label: `Open at line ${f.line}`, action: () => d.open(f.line) },
    !gone && !f.kept && { label: "Keep", action: d.keep, enabled: !d.locked },
    f.status !== "deleted" && { label: "Reveal in Finder", action: d.reveal },
    "-",
    f.hunks.length > 0 && copy("Copy diff", unifiedText(f), d.copyText),
    copy("Copy path", f.path, d.copyText),
    "-",
    !gone && { label: "Undo", action: d.undo, enabled: !d.locked && !f.blocked },
  ];
}

export interface HunkMenuDeps {
  copyText: Copy;
  open: (line: number) => void;
  keep: () => void;
  undo: () => void;
  locked: boolean;
  /** Text the person selected in the diff. */
  selection?: string;
  /** The code of the line under the pointer. */
  line?: string | null;
}

/** A hunk's menu, after Copy / Copy line when there is a selection or a line under the pointer. */
export function changesHunkMenu(f: FileChange, h: HunkView, d: HunkMenuDeps): MenuEntry[] {
  const gone = f.status === "undone" || f.status === "unchanged";
  const lead = !!d.selection || d.line != null;
  return [
    d.selection ? copy("Copy", d.selection, d.copyText) : null,
    d.line != null ? copy("Copy line", d.line, d.copyText) : null,
    lead && "-",
    f.status !== "deleted" && { label: `Open at line ${hunkLine(h)}`, action: () => d.open(hunkLine(h)) },
    !gone && !h.kept && { label: "Keep hunk", action: d.keep, enabled: !d.locked },
    copy("Copy hunk", hunkText(f, h), d.copyText),
    "-",
    !gone && { label: "Undo hunk", action: d.undo, enabled: !d.locked && !h.blocked },
  ];
}

export interface TerminalMenuDeps {
  copyText: Copy;
  selection: string;
  exited: boolean;
  readClipboard: () => Promise<string>;
  paste: (text: string) => void;
  selectAll: () => void;
  clear: () => void;
}

/** xterm draws to a canvas, so the page's text menu can't see its selection: coool's own Copy / Paste. */
export function terminalMenu(d: TerminalMenuDeps): MenuEntry[] {
  return [
    { label: "Copy", enabled: d.selection.length > 0, action: () => void d.copyText(d.selection) },
    { label: "Paste", enabled: !d.exited, action: async () => d.paste(await d.readClipboard()) },
    "-",
    { label: "Select all", action: d.selectAll },
    { label: "Clear", action: d.clear },
  ];
}

export interface ContextItemMenuDeps {
  copyText: Copy;
  open?: () => void;
  edit?: () => void;
  reveal: () => void;
  trash?: () => void;
}

/** A Context panel item: Open and Edit where they apply, file actions for those with a path, Trash last. */
export function contextItemMenu(path: string | null, d: ContextItemMenuDeps): MenuEntry[] {
  return [
    d.open && { label: "Open", action: d.open },
    d.edit && { label: "Edit", action: d.edit },
    !!path && "-",
    path ? { label: "Reveal in Finder", action: d.reveal } : null,
    path ? copy("Copy path", path, d.copyText) : null,
    !!d.trash && "-",
    d.trash && { label: "Move to Trash…", action: d.trash },
  ];
}

export interface BrowserMenuDeps {
  copyText: Copy;
  url: string | null;
  /** Only the tab on screen has a page to step through. */
  current: boolean;
  canBack: boolean;
  canForward: boolean;
  reloadable: boolean;
  go: (a: "back" | "forward" | "reload") => void;
  openExternal?: () => void;
}

/** Back / Forward / Reload, Copy URL, Open in default browser: the address bar's menu, and a tab's top part. */
export function browserPageMenu(d: BrowserMenuDeps): MenuEntry[] {
  return [
    d.current && { label: "Back", enabled: d.canBack, action: () => d.go("back") },
    d.current && { label: "Forward", enabled: d.canForward, action: () => d.go("forward") },
    d.current && { label: "Reload", enabled: d.reloadable, action: () => d.go("reload") },
    d.current && "-",
    d.url ? copy("Copy URL", d.url, d.copyText) : null,
    d.openExternal && { label: "Open in default browser", action: d.openExternal },
  ];
}

export interface TabMenuDeps extends BrowserMenuDeps {
  close: () => void;
  closeOthers?: () => void;
  duplicate?: () => void;
}

/** A browser tab's menu. */
export function browserTabMenu(d: TabMenuDeps): MenuEntry[] {
  return [
    ...browserPageMenu(d),
    !!d.duplicate && "-",
    d.duplicate && { label: "Duplicate", action: d.duplicate },
    "-",
    { label: "Close tab", action: d.close },
    d.closeOthers && { label: "Close other tabs", action: d.closeOthers },
  ];
}

export interface SimMenuDeps {
  booted: boolean;
  busy: boolean;
  press: (name: "home" | "lock") => void;
  paste: () => void;
  boot: () => void;
  shutdown: () => void;
}

/** The iPhone panel's menu (its screen and the space around it). */
export function simMenu(d: SimMenuDeps): MenuEntry[] {
  if (!d.booted) return [{ label: "Boot", enabled: !d.busy, action: d.boot }];
  return [
    { label: "Home", accelerator: "Shift+Cmd+H", action: () => d.press("home") },
    { label: "Lock", action: () => d.press("lock") },
    "-",
    { label: "Paste", action: d.paste },
    "-",
    { label: "Shut down", enabled: !d.busy, action: d.shutdown },
  ];
}

type NetMode = "on" | "local" | "off";
export interface MacMenuDeps {
  keysOn: boolean;
  sendKeys: () => void;
  paste: () => void;
  copyBack: () => void;
  /** The network setting; undefined hides the submenu. */
  network?: { mode: NetMode; labels: Record<NetMode, string>; pick: (m: NetMode) => void };
  shutdown?: () => void;
}

/** The sandbox Mac screen's menu. Null while keys are captured: then a right click is the Mac's own. */
export function macMenu(d: MacMenuDeps): MenuEntry[] | null {
  if (d.keysOn) return null;
  const n = d.network;
  const modes: NetMode[] = ["on", "local", "off"];
  return [
    { label: "Send keys to Mac", action: d.sendKeys },
    "-",
    { label: "Paste into Mac", action: d.paste },
    { label: "Copy from Mac", action: d.copyBack },
    n && { label: "Network", items: modes.map((m) => ({ label: n.labels[m], checked: n.mode === m, action: () => n.pick(m) })) },
    !!d.shutdown && "-",
    d.shutdown && { label: "Shut down", action: d.shutdown },
  ];
}

export interface JobMenuDeps {
  copyText: Copy;
  open?: () => void;
  /** What "Open" does, if not just "Open" ("Open in timeline" for an agent). */
  openLabel?: string;
  stop?: () => void;
  command?: string | null;
  output?: string | null;
  task?: string | null;
}

/** A Jobs card (agent, helper chat, or shell). */
export function jobMenu(d: JobMenuDeps): MenuEntry[] {
  return [
    d.open && { label: d.openLabel ?? "Open", action: d.open },
    d.task ? copy("Copy task", d.task, d.copyText) : null,
    d.command ? copy("Copy command", d.command, d.copyText) : null,
    d.output ? copy("Copy output", d.output, d.copyText) : null,
    !!d.stop && "-",
    d.stop && { label: "Stop", action: d.stop },
  ];
}
