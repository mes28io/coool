import { AnimatePresence, motion } from "motion/react";
import { type ReactNode } from "react";
import { useStore } from "../store";
import { IBell, IGauge, IGear, IHome, IMoon, ICompose, ISearch, ISun } from "./icons";
import { cx, ease } from "./primitives";
import { useNeedsYou } from "./LeftPanels";
import { usageHighest, useUsageProviders } from "./Usage";

/** One rail button: a real button with an accessible name; the tooltip fades in on hover/focus. */
function RailButton({
  label,
  shortcut,
  onClick,
  active,
  badge,
  dot,
  children,
  hideTip,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  active?: boolean;
  badge?: number;
  /** A small state dot instead of a count. */
  dot?: "warn" | "bad" | null;
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
          "relative flex size-[40px] items-center justify-center rounded-[11px] transition-colors duration-150",
          active ? "bg-raised text-fg shadow-card" : "text-dim hover:bg-hover hover:text-fg",
        )}
      >
        {children}
        {dot && <span className="absolute right-[8px] top-[8px] size-[7px] rounded-full ring-2 ring-panel" style={{ background: dot === "bad" ? "var(--error)" : "var(--busy)" }} />}
        {!!badge && badge > 0 && (
          <span className="absolute right-[3px] top-[3px] flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-needs px-1 text-micro font-semibold leading-none text-needs-ink tnum">{badge}</span>
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

/** Sessions that are blocked on the person: the badge counts them, the view lists them. */
function NeedsYou() {
  const list = useNeedsYou();
  const view = useStore((s) => s.sidebarView);
  const open = useStore((s) => s.sidebarOpen);
  const toggle = useStore((s) => s.toggleSidebarView);
  return (
    <RailButton label="Needs you" onClick={() => toggle("needs")} active={open && view === "needs"} badge={list.length}>
      <IBell size={20} />
    </RailButton>
  );
}

/** Plan usage for Claude and Codex: the rail dot shows the worst window, the view shows the detail. */
function UsageButton() {
  const view = useStore((s) => s.sidebarView);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggle = useStore((s) => s.toggleSidebarView);
  const usage = useStore((s) => s.usage);
  const providers = useUsageProviders();
  const hide = (["claude", "codex"] as const).filter((p) => !providers.includes(p));
  const high = usageHighest(usage, [...hide]);
  return (
    <RailButton label={high ? `Usage · ${high.label} ${high.percent}%` : "Usage"} onClick={() => toggle("usage")} active={sidebarOpen && view === "usage"} dot={high?.tone ?? null}>
      <IGauge size={20} />
    </RailButton>
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
  const view = useStore((s) => s.sidebarView);
  const setView = useStore((s) => s.setSidebarView);
  const toggleView = useStore((s) => s.toggleSidebarView);

  return (
    <nav data-tauri-drag-region aria-label="coool" className="relative z-20 flex w-[56px] shrink-0 flex-col items-center gap-1.5 pb-3 pt-1">
      <RailButton
        label="Home"
        active={activeTab === null && view === "projects"}
        onClick={() => {
          activate(null);
          setView("projects");
        }}
      >
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
        <UsageButton />
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
        <RailButton label="Settings" shortcut="⌘," active={sidebarOpen && view === "settings"} onClick={() => toggleView("settings")}>
          <IGear size={20} />
        </RailButton>
      </div>
    </nav>
  );
}
