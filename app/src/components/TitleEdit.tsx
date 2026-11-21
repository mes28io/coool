// Renaming a session in coool (CHAT_SPEC "Session titles"): double-click the title (sidebar
// row, chat header) or right-click it for the menu. Enter saves, Esc cancels, an empty name
// goes back to the automatic title. A name given here is pinned: never auto-replaced.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/backend";
import { displayTitle, previousTitles, titlePinned } from "../lib/format";
import { registerOverlay } from "../lib/overlays";
import type { Session } from "../lib/types";
import { useStore } from "../store";
import { IPencil, IRefresh, ISpark } from "./icons";
import { askRestart } from "../lib/actions";
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

/** Editing state for one title: `start` opens the field, `menu` the right-click menu. */
export function useTitleEdit(s: Session | null | undefined) {
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const can = !!s?.id;
  return {
    editing: can && editing,
    start: () => can && setEditing(true),
    stop: () => setEditing(false),
    menu: can ? menu : null,
    openMenu: (e: ReactMouseEvent) => {
      if (!can) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY });
    },
    closeMenu: () => setMenu(null),
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

/** The right-click menu: Rename…, and Use automatic title while a name is pinned. */
export function TitleMenu({ s, at, onClose, onRename }: { s: Session; at: { x: number; y: number }; onClose: () => void; onRename: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const t = setTimeout(() => window.addEventListener("pointerdown", down, true), 0);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  useEffect(() => {
    if (ref.current) return registerOverlay(ref.current);
  }, []);
  const pinned = titlePinned(s);
  const was = previousTitles(s)[0];
  const item = "flex h-[30px] w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-base text-fg hover:bg-hover";
  return createPortal(
    <AnimatePresence>
      <motion.div
        ref={ref}
        role="menu"
        data-title-menu
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.12 }}
        style={{ left: Math.min(at.x, window.innerWidth - 248), top: Math.min(at.y, window.innerHeight - 120) }}
        className="fixed z-50 w-[240px] rounded-[12px] border border-line bg-raised p-1 shadow-pop"
      >
        <button
          type="button"
          role="menuitem"
          className={item}
          onClick={() => {
            onClose();
            onRename();
          }}
        >
          <IPencil size={14} className="text-dim" />
          Rename…
        </button>
        {s.chat != null && s.status !== "ended" && (
          <button
            type="button"
            role="menuitem"
            className={item}
            title="Starts the CLI again on this conversation: it reads its settings, MCP and instructions again"
            data-title-menu-restart
            onClick={() => {
              onClose();
              askRestart(s.chat!);
            }}
          >
            <IRefresh size={14} className="text-dim" />
            Restart
          </button>
        )}
        {pinned && (
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              onClose();
              renameSession(s, null);
            }}
          >
            <ISpark size={14} className="text-dim" />
            Use automatic title
          </button>
        )}
        {was && <div className="truncate px-2.5 pb-1 pt-1.5 text-small text-faint" title={previousTitles(s).join("\n")}>was: {was}</div>}
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
