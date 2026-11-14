import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { attention } from "../lib/live";
import { displayTitle } from "../lib/format";
import { sessionKey } from "../lib/types";
import { useStore } from "../store";
import { IBell, IGear, IHome, IMoon, ICompose, ISearch, ISun } from "./icons";
import { cx, ease, ProviderMark } from "./primitives";
import { useProjects } from "./Sidebar";

/** One rail button: a real button with an accessible name; the tooltip fades in on hover/focus. */
function RailButton({
  label,
  shortcut,
  onClick,
  active,
  badge,
  children,
  hideTip,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  active?: boolean;
  badge?: number;
  children: ReactNode;
  hideTip?: boolean;
}) {
  return (
    <div className="group relative">
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        className={cx(
          "relative flex size-[40px] items-center justify-center rounded-[10px] transition-colors duration-150",
          active ? "bg-raised text-fg shadow-card" : "text-dim hover:bg-hover hover:text-fg",
        )}
      >
        {children}
        {!!badge && badge > 0 && (
          <span className="absolute right-[3px] top-[3px] flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-micro font-semibold leading-none text-accent-ink tnum">{badge}</span>
        )}
      </button>
      {!hideTip && (
        <span
          role="tooltip"
          className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 flex h-[30px] -translate-y-1/2 items-center gap-2 whitespace-nowrap rounded-[8px] border border-line bg-raised px-2.5 text-small text-fg opacity-0 shadow-pop transition-opacity duration-150 group-hover:opacity-100 group-hover:delay-500 group-focus-within:opacity-100"
        >
          {label}
          {shortcut && <span className="font-mono text-micro text-faint">{shortcut}</span>}
        </span>
      )}
    </div>
  );
}

/** Sessions that are blocked on the person, as a small popover next to the rail. */
function NeedsYou() {
  const { projects, digest } = useProjects();
  const open = useStore((s) => s.open);
  const [show, setShow] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const list = projects.flatMap((p) => p.live.map((s) => ({ s, a: attention(s, digest) })).filter((x) => x.a.needs));

  useEffect(() => {
    if (!show) return;
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setShow(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setShow(false);
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, [show]);

  return (
    <div ref={box} className="relative">
      <RailButton label="Needs you" onClick={() => setShow((v) => !v)} active={show} badge={list.length} hideTip={show}>
        <IBell size={20} />
      </RailButton>
      <AnimatePresence>
        {show && (
          <motion.div
            initial={{ opacity: 0, x: -6, scale: 0.98 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.18, ease }}
            style={{ transformOrigin: "left top" }}
            className="absolute left-full top-0 z-50 ml-2 w-[340px] rounded-[12px] border border-line bg-raised p-1.5 shadow-pop"
            data-needs-popover
          >
            <div className="px-2.5 pb-1 pt-1.5 text-small text-dim">{list.length ? "Waiting for you" : "Nothing needs you right now."}</div>
            {list.map(({ s, a }) => (
              <button
                key={sessionKey(s)}
                type="button"
                data-needs-row={sessionKey(s)}
                onClick={() => {
                  open({ kind: "session", key: sessionKey(s) });
                  setShow(false);
                }}
                className="flex w-full items-start gap-2.5 rounded-[9px] px-2.5 py-2 text-left transition-colors duration-150 hover:bg-hover"
              >
                <ProviderMark provider={s.provider} size={15} className="mt-[3px]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base text-fg">{displayTitle(s)}</span>
                  <span className="block truncate text-small text-dim">{a.needs}</span>
                </span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function Rail() {
  const activeTab = useStore((s) => s.activeTab);
  const activate = useStore((s) => s.activate);
  const setPalette = useStore((s) => s.setPalette);
  const setSheet = useStore((s) => s.setSheet);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const sheet = useStore((s) => s.sheet);
  const sidebarOpen = useStore((s) => s.sidebarOpen);

  return (
    <nav data-tauri-drag-region aria-label="coool" className="relative z-20 flex w-[56px] shrink-0 flex-col items-center gap-1.5 pb-3 pt-1">
      <RailButton label="Home" active={activeTab === null} onClick={() => activate(null)}>
        <IHome size={20} />
      </RailButton>
      <RailButton label="Search" shortcut="⌘K" onClick={() => setPalette(true)}>
        <ISearch size={20} />
      </RailButton>
      <NeedsYou />
      {/* While the panel is open its "New session" row is the one entry point; the rail takes over when it is collapsed. */}
      <AnimatePresence initial={false}>
        {!sidebarOpen && (
          <motion.div
            key="new"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease }}
            className="flex flex-col items-center gap-1.5"
          >
            <span className="my-1 h-px w-6 bg-line" />
            <RailButton label="New session" shortcut="⌘T" active={sheet?.kind === "new"} onClick={() => setSheet({ kind: "new" })}>
              <ICompose size={20} />
            </RailButton>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mt-auto flex flex-col items-center gap-1.5">
        <RailButton label={`${theme === "dark" ? "Light" : "Dark"} theme`} shortcut="⌘⇧L" onClick={toggleTheme}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={theme}
              initial={{ opacity: 0, rotate: -40, scale: 0.7 }}
              animate={{ opacity: 1, rotate: 0, scale: 1 }}
              exit={{ opacity: 0, rotate: 40, scale: 0.7 }}
              transition={{ duration: 0.22, ease }}
              className="flex"
            >
              {theme === "dark" ? <IMoon size={20} /> : <ISun size={20} />}
            </motion.span>
          </AnimatePresence>
        </RailButton>
        <RailButton label="Settings" shortcut="⌘," active={sheet?.kind === "settings"} onClick={() => setSheet({ kind: "settings" })}>
          <IGear size={20} />
        </RailButton>
      </div>
    </nav>
  );
}
