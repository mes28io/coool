// Right-click menus for attachments, shown media, history rows, settings rows, mission control and the commit trail.
// Plain builders: each takes what it acts on and the handlers to call, so the lists can be tested without a webview.
import type { MenuEntry } from "../contextMenu";

// Loaded on use: that module reaches the Tauri API, which a node test has no need to load.
const copyText = (t: string) => import("../contextMenu").then((m) => m.copyText(t));

const sel = () => (typeof window !== "undefined" ? (window.getSelection()?.toString() ?? "") : "");
/** "Copy" of the selected text first, when there is one. */
const selected = (): MenuEntry[] => {
  const t = sel().trim();
  return t ? [{ label: "Copy", action: () => copyText(t) }, "-"] : [];
};

// ---------- attachments ----------

export interface AttachDeps {
  name: string;
  /** Where the file is on disk, when coool knows. */
  path?: string;
  /** Open the viewer / quick look. */
  open?: () => void;
  reveal: (path: string) => void | Promise<void>;
  /** A draft in the composer's tray: it can be taken out. */
  remove?: () => void;
}

export function attachMenu(d: AttachDeps): MenuEntry[] {
  const { path } = d;
  return [
    d.open && { label: "Quick look", action: d.open },
    !!path && "-",
    !!path && { label: "Reveal in Finder", action: () => d.reveal(path) },
    !!path && { label: "Copy path", action: () => copyText(path) },
    !path && { label: "Copy name", action: () => copyText(d.name) },
    d.remove && "-",
    d.remove && { label: "Remove", action: d.remove },
  ];
}

// ---------- shown media ----------

export interface MediaDeps {
  name: string;
  path?: string;
  /** The grant's token: only a served file has one (an attached picture by key doesn't). */
  token: string | null;
  open: () => void;
  copy: (token: string) => void | Promise<void>;
  reveal: (token: string) => void | Promise<void>;
}

export function mediaMenu(d: MediaDeps): MenuEntry[] {
  const { token } = d;
  return [
    ...selected(),
    { label: "Open in viewer", action: d.open },
    !!token && "-",
    !!token && { label: "Copy", action: () => d.copy(token) },
    !!token && { label: "Reveal in Finder", action: () => d.reveal(token) },
    !!d.path && { label: "Copy path", action: () => copyText(d.path!) },
  ];
}

// ---------- history ----------

export interface HistoryDeps {
  row: { id: string; cwd: string; missing: boolean };
  open: (newTab: boolean) => void;
  reveal: (path: string) => void | Promise<void>;
  /** Recreates a folder that is gone (so the CLI can continue the session where it ran). */
  makeFolder: (cwd: string) => void | Promise<void>;
}

export function historyMenu(d: HistoryDeps): MenuEntry[] {
  const { row } = d;
  return [
    ...selected(),
    { label: "Open", action: () => d.open(false) },
    { label: "Open in new tab", action: () => d.open(true) },
    "-",
    { label: "Copy session ID", action: () => copyText(row.id) },
    { label: "Copy folder path", action: () => copyText(row.cwd) },
    !row.missing && { label: "Reveal folder in Finder", action: () => d.reveal(row.cwd) },
    row.missing && { label: "Make the folder again", action: () => d.makeFolder(row.cwd) },
  ];
}

// ---------- settings ----------

/** The label and the current value of a settings row, read from its DOM (rows are built from many controls). */
export function settingOf(row: Element): { name: string; value: string | null } {
  const name = row.getAttribute("data-setting") ?? "";
  const head = row.firstElementChild;
  const control = head && head.children.length > 1 ? head.lastElementChild : null;
  let value: string | null = null;
  if (control) {
    const sw = control.querySelector("[role=switch]");
    const field = control.querySelector("input:not([type=checkbox]):not([type=radio]), textarea") as HTMLInputElement | null;
    if (sw) value = sw.getAttribute("aria-checked") === "true" ? "On" : "Off";
    else if (field) value = field.type === "password" ? null : field.value;
    else value = control.textContent?.trim() || null;
  }
  return { name, value };
}

export function settingMenu(s: { name: string; value: string | null }): MenuEntry[] {
  return [
    ...selected(),
    s.value ? { label: "Copy value", action: () => copyText(s.value!) } : null,
    s.name ? { label: "Copy setting name", action: () => copyText(s.name) } : null,
  ];
}

export function configFileMenu(path: string, d: { open: () => void; reveal: (path: string) => void | Promise<void> }): MenuEntry[] {
  return [{ label: "Open file", action: d.open }, { label: "Reveal in Finder", action: () => d.reveal(path) }, { label: "Copy path", action: () => copyText(path) }];
}

// ---------- mission control ----------

export interface SessionDeps {
  id: string;
  folder: string;
  open: () => void;
  reveal: (path: string) => void | Promise<void>;
}

export function missionSessionMenu(d: SessionDeps): MenuEntry[] {
  return [
    ...selected(),
    { label: "Open session", action: d.open },
    "-",
    { label: "Copy session ID", action: () => copyText(d.id) },
    !!d.folder && { label: "Reveal folder in Finder", action: () => d.reveal(d.folder) },
  ];
}

export function commitMenu(c: { sha: string; short: string; subject: string }): MenuEntry[] {
  return [
    ...selected(),
    { label: "Copy commit SHA", action: () => copyText(c.sha) },
    { label: "Copy short SHA", action: () => copyText(c.short) },
    { label: "Copy message", action: () => copyText(c.subject) },
  ];
}
