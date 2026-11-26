// Renaming a session in coool (CHAT_SPEC "Session titles"): double-click the title (sidebar
// row, chat header) or right-click it for the menu (lib/menus/chatWired.ts sessionMenu: Rename… starts this). Enter saves, Esc cancels, an empty name
// goes back to the automatic title. A name given here is pinned: never auto-replaced.
import { useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/backend";
import { onContext } from "../lib/contextMenu";
import { displayTitle, titlePinned } from "../lib/format";
import { sessionMenu } from "../lib/menus/chatWired";
import type { Session } from "../lib/types";
import { useStore } from "../store";
import { cx } from "./primitives";

/** Saves a name (or, blank / null, the automatic title again). */
export function renameSession(s: Session, name: string | null) {
  const n = name?.trim() || null;
  if (n === null && !titlePinned(s)) return;
  if (n !== null && n === displayTitle(s) && titlePinned(s)) return;
  void api()
    .renameSession(s.provider, s.id, n)
    .catch((e) => useStore.getState().toast(`Couldn't rename the session: ${e instanceof Error ? e.message : String(e)}`, "error"));
}

/** Editing state for one title: `start` opens the field; `onContextMenu` is the session's native menu. */
export function useTitleEdit(s: Session | null | undefined) {
  const [editing, setEditing] = useState(false);
  const can = !!s?.id;
  const start = () => can && setEditing(true);
  return {
    editing: can && editing,
    start,
    stop: () => setEditing(false),
    onContextMenu: onContext((e) => (s && can && !(e.target as Element).closest("input") ? sessionMenu(s, start) : null)),
  };
}

/** The inline field. Enter saves, Esc cancels, leaving the field saves. */
export function TitleInput({ s, onDone, className }: { s: Session; onDone: () => void; className?: string }) {
  const [v, setV] = useState(() => displayTitle(s));
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && v.trim() !== displayTitle(s)) renameSession(s, v);
    onDone();
  };
  return (
    <input
      ref={ref}
      value={v}
      maxLength={120}
      aria-label="Session name"
      data-title-input
      placeholder="Empty: back to the automatic title"
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      className={cx("min-w-0 rounded-[6px] border border-accent bg-bg px-1.5 text-fg outline-none", className)}
    />
  );
}
