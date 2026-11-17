import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNow } from "../lib/clock";
import { registerOverlay } from "../lib/overlays";
import type { UsageWindow } from "../lib/types";
import { useStore } from "../store";
import { IBell, IGauge, IGear, IHome, IMoon, ICompose, ISearch, ISun } from "./icons";
import { cx, ease, ProviderMark } from "./primitives";
import { useNeedsYou } from "./LeftPanels";
import { NAME, resetText, toneColor, usageHighest, usageTone, useUsageProviders } from "./Usage";

/**
 * One rail button: a real button with an accessible name; the tooltip fades in on hover/focus. `tip` replaces the
 * one-line label tooltip with a richer card, mounted only while the pointer (or keyboard focus) is on the button.
 */
function RailButton({
  label,
  shortcut,
  onClick,
  active,
  badge,
  dot,
  children,
  hideTip,
  tip,
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
  tip?: ReactNode;
}) {
  const [rich, setRich] = useState(false);
  return (
    <div
      className="group relative"
      onPointerEnter={tip ? () => setRich(true) : undefined}
      onPointerLeave={tip ? () => setRich(false) : undefined}
      onFocus={tip ? (e) => e.target.matches(":focus-visible") && setRich(true) : undefined}
      onBlur={tip ? () => setRich(false) : undefined}
    >
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onClick={() => {
          setRich(false);
          onClick();
        }}
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
      {tip ? (
        <AnimatePresence>{rich && <RichTip key="tip">{tip}</RichTip>}</AnimatePresence>
      ) : (
        !hideTip && (
          <span
            role="tooltip"
            className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 flex h-[30px] -translate-y-1/2 items-center gap-2 whitespace-nowrap rounded-[8px] border border-line bg-raised px-2.5 text-small text-fg opacity-0 shadow-pop transition-opacity duration-150 group-hover:opacity-100 group-hover:delay-500 group-focus-within:opacity-100"
          >
            {label}
            {shortcut && <span className="font-mono text-micro text-faint">{shortcut}</span>}
          </span>
        )
      )}
    </div>
  );
}

/**
 * The rich tooltip's card: bottom-aligned with its button (the buttons that use it sit low in the rail, so it grows
 * upward), after the same half-second delay as the label tooltips. A native browser page it would overlap hides meanwhile.
 */
function RichTip({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (ref.current ? registerOverlay(ref.current) : undefined), []);
  return (
    <motion.div
      ref={ref}
      role="tooltip"
      className="pointer-events-none absolute bottom-0 left-full z-50 ml-2 rounded-[10px] border border-line bg-raised text-fg shadow-pop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { delay: 0.5, duration: 0.15, ease } }}
      exit={{ opacity: 0, transition: { duration: 0.1 } }}
    >
      {children}
    </motion.div>
  );
}

/** Usage at a glance: each provider's windows with percent used, a thin bar and when it resets. */
function UsageTip() {
  const usage = useStore((s) => s.usage);
  const providers = useUsageProviders();
  return (
    <div className="flex w-[260px] flex-col gap-3 px-3 pb-3 pt-2.5" data-usage-tip>
      <div className="flex items-baseline justify-between">
        <span className="text-small font-medium text-fg">Usage</span>
        <span className="text-micro text-faint">Click for details</span>
      </div>
      {providers.map((p) => {
        const u = usage[p];
        return (
          <div key={p} data-usage-tip-provider={p}>
            <div className="flex h-[18px] items-center gap-1.5">
              <ProviderMark provider={p} size={13} />
              <span className="text-small font-medium text-fg">{NAME[p]}</span>
              {u?.plan && <span className="min-w-0 truncate text-small text-faint">{u.plan}</span>}
            </div>
            {!u || u.windows.length === 0 ? (
              <div className="mt-1 text-small text-dim">{u?.error ?? "No usage data yet"}</div>
            ) : (
              <div className="mt-1.5 flex flex-col gap-2">
                {u.windows.map((w) => (
                  <TipRow key={w.id} w={w} />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {providers.length === 0 && <div className="text-small text-dim">No supported CLI found.</div>}
    </div>
  );
}

function TipRow({ w }: { w: UsageWindow }) {
  const now = useNow();
  const known = w.used_percent !== null;
  const pct = known ? Math.max(0, Math.min(100, w.used_percent!)) : 0;
  const note = known ? (resetText(w.resets_ms, now) ?? w.detail) : (w.detail ?? "No reading since the reset");
  return (
    <div data-usage-tip-window={w.id}>
      <div className="flex items-baseline gap-2 text-small">
        <span className="min-w-0 flex-1 truncate text-fg/90">{w.label}</span>
        <span className="shrink-0 text-fg tnum">{known ? `${Math.round(pct)}%` : "—"}</span>
      </div>
      <div className="mt-1 h-[2px] overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--dim)_20%,transparent)]">
        {known && <div className="h-full rounded-full" style={{ width: `${Math.max(2, pct)}%`, background: toneColor[usageTone(w)] }} />}
      </div>
      {note && <div className="mt-1 truncate text-micro text-faint">{note}</div>}
    </div>
  );
}

/** Sessions that are blocked on the person: the badge counts them, the view lists them. */
function NeedsYou() {
  const list = useNeedsYou();
  const view = useStore((s) => s.sidebarView);
  const open = useStore((s) => s.sidebarOpen);
  const settings = useStore((s) => s.settings !== null);
  const toggle = useStore((s) => s.toggleSidebarView);
  const setView = useStore((s) => s.setSidebarView);
  const closeSettings = useStore((s) => s.closeSettings);
  return (
    <RailButton
      label="Needs you"
      onClick={() => {
        // From the Settings page: back to the app, showing the list (never toggling it away unseen).
        if (settings) {
          closeSettings();
          setView("needs");
        } else toggle("needs");
      }}
      active={!settings && open && view === "needs"}
      badge={list.length}
    >
      <IBell size={20} />
    </RailButton>
  );
}

/** Plan usage for Claude and Codex: the rail dot shows the worst window, the tooltip the glance, the page the detail. */
function UsageButton() {
  const onUsage = useStore((s) => s.settings === "usage");
  const openSettings = useStore((s) => s.openSettings);
  const closeSettings = useStore((s) => s.closeSettings);
  const usage = useStore((s) => s.usage);
  const providers = useUsageProviders();
  const hide = (["claude", "codex"] as const).filter((p) => !providers.includes(p));
  const high = usageHighest(usage, [...hide]);
  return (
    <RailButton
      label={high ? `Usage · ${high.label} ${high.percent}%` : "Usage"}
      onClick={() => (onUsage ? closeSettings() : openSettings("usage"))}
      active={onUsage}
      dot={high?.tone ?? null}
      tip={<UsageTip />}
    >
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
  const settings = useStore((s) => s.settings);
  const openSettings = useStore((s) => s.openSettings);
  const closeSettings = useStore((s) => s.closeSettings);
  const onSettings = settings !== null && settings !== "usage";

  return (
    <nav data-tauri-drag-region aria-label="coool" className="relative z-20 flex w-[56px] shrink-0 flex-col items-center gap-1.5 pb-3 pt-1">
      <RailButton
        label="Home"
        active={settings === null && activeTab === null && view === "projects"}
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
        <RailButton label="Settings" shortcut="⌘," active={onSettings} onClick={() => (onSettings ? closeSettings() : openSettings())}>
          <IGear size={20} />
        </RailButton>
      </div>
    </nav>
  );
}
