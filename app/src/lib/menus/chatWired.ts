// Chat and sidebar menus wired to the app's handlers (the pure builders are in ./chat.ts).
import { openChatInTerminal, askRestart, chatCall } from "../actions";
import { api } from "../backend";
import { openChangesAt } from "../changes";
import { copyText, type MenuEntry } from "../contextMenu";
import { displayTitle, homeShort, titlePinned } from "../format";
import { leaves, useStore } from "../../store";
import { useChats } from "../chat";
import { sessionKey, type Session } from "../types";
import { renameSession } from "../../components/TitleEdit";
import { agentItems, codeItems, turnFilesItems, fileItems, linkItems, messageItems, projectItems, sessionItems, stepItems, tabItems, type StepMenuIn } from "./chat";

const toast = (e: unknown) => useStore.getState().toast(e instanceof Error ? e.message : String(e), "error");
const reveal = (path: string) => () => void api().attachReveal(path).catch(toast);

/** The selected text when the selection sits inside `el` (a menu over a message copies that, not the page's). */
export function selectionIn(el: Element | null): string {
  const sel = window.getSelection();
  if (!el || !sel || sel.isCollapsed || !sel.anchorNode || !el.contains(sel.anchorNode)) return "";
  return sel.toString();
}

const selectAllIn = (el: Element) => () => {
  const r = document.createRange();
  r.selectNodeContents(el);
  const s = window.getSelection();
  s?.removeAllRanges();
  s?.addRange(r);
};

/** A session's menu (sidebar row, chat header). `rename` starts the inline title edit. */
export function sessionMenu(s: Session, rename: () => void): MenuEntry[] {
  const st = useStore.getState();
  const key = sessionKey(s);
  const target = { kind: "session", key } as const;
  const chat = s.chat != null ? useChats.getState().chats[s.chat] : undefined;
  const visible = !st.activeTab || st.tabs.some((t) => leaves(t.root).some((l) => l.target?.kind === "session" && l.target.key === key));
  return sessionItems({
    title: displayTitle(s),
    id: s.id,
    pinned: titlePinned(s),
    running: !!chat && chat.running && chat.state !== "idle",
    restartable: s.chat != null && s.status !== "ended",
    visible,
    folder: s.cwd || null,
    chat: s.chat != null,
    a: {
      newTab: () => st.open(target, { newTab: true }),
      split: () => {
        st.split("row");
        useStore.getState().open(target);
      },
      rename,
      auto: () => renameSession(s, null),
      restart: () => askRestart(s.chat!),
      stop: () => void chatCall(s.chat!, () => api().chatInterrupt(s.chat!)),
      terminal: () => void openChatInTerminal(s.chat!, s),
      reveal: reveal(s.cwd),
      copy: copyText,
    },
  });
}

/** A project header's menu. */
export function projectMenu(path: string, collapsed: boolean, newChat: () => void): MenuEntry[] {
  const st = useStore.getState();
  return projectItems({ path, collapsed, a: { newChat, history: () => st.openHistory({ project: path }), reveal: reveal(path), copy: copyText, toggle: () => st.toggleCollapsed(path) } });
}

/** Menu for a message's text: the selection, the whole message, select all. */
export function messageMenu(el: Element | null, text: string): MenuEntry[] {
  return messageItems({ selection: selectionIn(el), text, copy: copyText, selectAll: el ? selectAllIn(el) : undefined });
}

export const codeMenu = (el: Element | null, code: string, lang: string): MenuEntry[] => codeItems({ code, lang, selection: selectionIn(el), copy: copyText });

export const linkMenu = (el: Element | null, href: string, web: boolean, panel: () => void): MenuEntry[] =>
  linkItems({ href, web, selection: selectionIn(el), panel, copy: copyText });

/** The file actions for an absolute path an agent touched. `chat`: its chat (Show diff opens that chat's changes). */
export function fileMenu(path: string, cwd: string, chat?: number | null): MenuEntry[] {
  return fileItems(fileIn(path, cwd, chat));
}

function fileIn(path: string, cwd: string, chat?: number | null) {
  const inside = !!cwd && path.startsWith(cwd.replace(/\/+$/, "") + "/");
  return {
    path,
    rel: inside ? path.slice(cwd.replace(/\/+$/, "").length + 1) : homeShort(path),
    a: {
      open: inside ? () => void api().changesOpen(cwd, path, 1).catch(toast) : undefined,
      diff: chat != null ? () => openChangesAt(chat, "chat") : undefined,
      reveal: reveal(path),
      copy: copyText,
    },
  };
}

/** A tool step's menu from its input and output; `file` is the absolute path it names, if any. */
export function stepMenu(a: { input: unknown; output: string; detail: string; cwd: string; chat?: number | null; file?: string | null; fold?: StepMenuIn["fold"] }): MenuEntry[] {
  const i = (a.input ?? {}) as Record<string, unknown>;
  const file = a.file && a.file.startsWith("/") ? a.file : null;
  return stepItems({ command: typeof i.command === "string" ? i.command : undefined, output: a.output, detail: a.detail, file: file ? fileIn(file, a.cwd, a.chat) : undefined, fold: a.fold, copy: copyText });
}

/** A workspace tab's menu. Split acts on the active tab, so the tab is activated first. */
export function tabMenu(tabId: string): MenuEntry[] {
  const st = useStore.getState();
  const split = (dir: "row" | "col") => () => {
    st.activate(tabId);
    useStore.getState().split(dir);
  };
  return tabItems({
    count: st.tabs.length,
    close: () => st.closeTab(tabId),
    closeOthers: () => st.tabs.filter((t) => t.id !== tabId).forEach((t) => useStore.getState().closeTab(t.id)),
    splitRight: split("row"),
    splitDown: split("col"),
  });
}

export function agentMenu(a: { task?: string; result?: string; fold: { open: boolean; toggle: () => void } }): MenuEntry[] {
  return agentItems({ ...a, copy: copyText });
}

/** The menu under a turn's "N files changed" line. */
export function turnFilesMenu(paths: string[], cwd: string, chat: number, show: () => void): MenuEntry[] {
  return turnFilesItems({
    show,
    files: paths.map((p) => {
      const f = fileIn(p, cwd, chat);
      return { label: f.rel, items: fileItems({ ...f, a: { ...f.a, diff: undefined } }) };
    }),
  });
}
