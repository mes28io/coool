import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useNow } from "../lib/clock";
import { registerOverlay } from "../lib/overlays";
import type { PlanUsages, Provider, UsageWindow } from "../lib/types";
import { useStore } from "../store";
import { IBell, IGauge, IGear, IHome, IMoon, ICompose, ISearch, ISun } from "./icons";
import { cx, ease, ProviderMark } from "./primitives";
import { useNeedsYou } from "./needs/useNeedsYou";
import { resetText, toneColor, usageHighest, usageTone, useUsageProviders } from "./Usage";
import { countRender } from "../lib/perfCount";
import { useNotifyClicks } from "../lib/notifyRoute";
import { sessionKey } from "../lib/types";
import { UpdateButton } from "./UpdatePanel";

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
  tipInline,
  onRich,
  tint,
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
  /** The rich tip is one line: centred on the button and shown sooner. */
  tipInline?: boolean;
  /** The pointer (or keyboard focus) came onto / left the button. */
  onRich?: (on: boolean) => void;
  /** A soft running-blue fill (the updater's icon when it has something to show). */
  tint?: boolean;
}) {
  const [rich, setRichState] = useState(false);
  const setRich = (on: boolean) => {
    setRichState(on);
    onRich?.(on);
  };
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
          active
            ? "bg-raised text-fg shadow-card"
            : tint
              ? "bg-[color-mix(in_oklab,var(--status-running)_14%,transparent)] text-running hover:bg-[color-mix(in_oklab,var(--status-running)_22%,transparent)]"
              : "text-dim hover:bg-hover hover:text-fg",
        )}
      >
        {children}
        {dot && <span className="absolute right-[8px] top-[8px] size-[7px] rounded-full ring-2 ring-panel" style={{ background: dot === "bad" ? "var(--error)" : "var(--busy)" }} />}
        {!!badge && badge > 0 && (
          <span
            className={cx(
              "absolute left-[21px] top-[5px] flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-needs px-[3.5px] text-[9.5px] font-bold leading-none text-needs-ink tnum ring-[1.5px]",
              // Cut out of the icon: a thin ring in the surface's own colour, so the number never sits on the bell's lines.
              active ? "ring-raised" : "ring-panel",
            )}
            data-rail-badge
          >
            {badge > 9 ? "9+" : badge}
          </span>
        )}
      </button>
      {tip ? (
        <AnimatePresence>{rich && <RichTip key="tip" inline={tipInline}>{tip}</RichTip>}</AnimatePresence>
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
function RichTip({ children, inline }: { children: ReactNode; inline?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (ref.current ? registerOverlay(ref.current) : undefined), []);
  return (
    <motion.div
      ref={ref}
      role="tooltip"
      className={cx("pointer-events-none absolute left-full z-50 ml-2 border border-line bg-raised text-fg shadow-pop", inline ? "top-1/2 rounded-full" : "bottom-0 rounded-[10px]")}
      style={inline ? { y: "-50%" } : undefined}
      initial={{ opacity: 0, x: inline ? -4 : 0 }}
      animate={{ opacity: 1, x: 0, transition: { delay: inline ? 0.12 : 0.5, duration: 0.15, ease } }}
      exit={{ opacity: 0, transition: { duration: 0.1 } }}
    >
      {children}
    </motion.div>
  );
}

/** How long the usage pill stays on one limit (styles.css `.usage-pill-fill` runs for the same time). */
const USAGE_PILL_MS = 2800;

/** One limit of one provider: what the usage pill shows at a time. */
type UsageItem = { p: Provider; w: UsageWindow };

/** The 5-hour and weekly limits with a reading, provider by provider (per-model limits and credits are on the page). */
function usageItems(usage: PlanUsages, providers: readonly Provider[]): UsageItem[] {
  return providers.flatMap((p) => (usage[p]?.windows ?? []).filter((w) => w.used_percent !== null && w.window_minutes !== null && !w.model).map((w) => ({ p, w })));
}

const leftOf = (w: UsageWindow) => Math.round(100 - Math.max(0, Math.min(100, w.used_percent ?? 0)));

/**
 * Usage at a glance, one limit at a time: "5-hour · 82% left", rolling to the next limit every couple of seconds while
 * the pointer stays (the rail's rings follow it). The dots say which of them it is; the page has the detail.
 */
function UsagePill({ items, index }: { items: UsageItem[]; index: number }) {
  const now = useNow();
  const at = items.length ? index % items.length : 0;
  const cur = items[at];
  const key = cur ? `${cur.p}:${cur.w.id}` : "";
  const reset = cur ? resetText(cur.w.resets_ms, now) : null;
  // The pill's width follows the line on show, so a longer limit name grows it smoothly instead of jumping. The first
  // measure is applied as it is (the pill appears at its size); later ones ease to the new width.
  const line = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<{ px: number; eased: boolean } | null>(null);
  useLayoutEffect(() => {
    const px = line.current?.offsetWidth;
    if (px) setWidth((w) => (w?.px === px ? w : { px, eased: w !== null }));
  }, [key, reset]);
  if (!cur) return <div className="flex h-[32px] items-center whitespace-nowrap px-3 text-small text-dim">No usage data yet</div>;
  const tone = usageTone(cur.w);
  return (
    <div className="flex h-[32px] items-center gap-3 whitespace-nowrap pl-2.5 pr-3 text-small" data-usage-pill>
      {/* The lines share one cell: the old one blurs out while the new one comes into focus over it. */}
      <div className="relative h-full" style={{ width: width?.px, transition: width?.eased ? "width 360ms cubic-bezier(0.2, 0, 0, 1)" : undefined }}>
        <AnimatePresence initial={false}>
          <motion.div
            key={key}
            ref={line}
            className="absolute left-0 top-0 flex h-full w-max items-center gap-1.5"
            initial={{ opacity: 0, filter: "blur(5px)", scale: 0.97 }}
            animate={{ opacity: 1, filter: "blur(0px)", scale: 1, transition: { duration: 0.34, ease, delay: 0.06 } }}
            exit={{ opacity: 0, filter: "blur(5px)", scale: 0.97, transition: { duration: 0.2, ease } }}
            style={{ transformOrigin: "left center" }}
            data-usage-pill-item={key}
          >
            <ProviderMark provider={cur.p} size={13} />
            <span className="text-fg">{cur.w.label}</span>
            <span className="text-faint">·</span>
            <span className="font-medium tnum" style={{ color: tone === "neutral" ? "var(--fg)" : toneColor[tone] }}>
              {leftOf(cur.w)}% left
            </span>
            {reset && <span className="text-faint">{reset.replace(/^Resets /, "· ")}</span>}
          </motion.div>
        </AnimatePresence>
      </div>
      {items.length > 1 && (
        <span className="flex shrink-0 items-center gap-[3px]" aria-hidden>
          {items.map((it, i) => (
            <span key={`${it.p}:${it.w.id}`} className="relative h-[4px] rounded-full bg-[color-mix(in_oklab,var(--dim)_35%,transparent)] transition-[width] duration-300" style={{ width: i === at ? 12 : 4 }}>
              {/* The dot of the limit on show stretches and fills while it is up: how long until the next one. */}
              {i === at && <span key={index} className="usage-pill-fill absolute inset-y-0 left-0 rounded-full bg-fg" />}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/** Sessions that are blocked on the person: the badge counts them, the Needs you page (components/needs/) lists them. */
function NeedsYou() {
  const list = useNeedsYou();
  // A click on a macOS notification opens this page (or the chat) through the same list (lib/notifyRoute.ts).
  useNotifyClicks(list.map((n) => sessionKey(n.s)));
  const on = useStore((s) => s.needsPage);
  const openNeeds = useStore((s) => s.openNeeds);
  const closeNeeds = useStore((s) => s.closeNeeds);
  return (
    <RailButton
      label="Needs you"
      // From the Settings page it opens the page (openNeeds closes Settings); the bell again goes back.
      onClick={() => (on ? closeNeeds() : openNeeds())}
      active={on}
      badge={list.length}
    >
      <IBell size={20} />
    </RailButton>
  );
}

/** Plan usage for Claude and Codex: the rail's rings show what is left, the pill one limit at a time, the page the detail. */
function UsageButton() {
  const onUsage = useStore((s) => s.settings === "usage");
  const openSettings = useStore((s) => s.openSettings);
  const closeSettings = useStore((s) => s.closeSettings);
  const usage = useStore((s) => s.usage);
  const providers = useUsageProviders();
  const all = ["claude", "codex"] as const;
  const hide = all.filter((p) => !providers.includes(p));
  const high = usageHighest(usage, [...hide]);
  const items = usageItems(usage, providers);
  const [hover, setHover] = useState(false);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!hover || items.length < 2) return;
    const t = setInterval(() => setIndex((i) => i + 1), USAGE_PILL_MS);
    return () => clearInterval(t);
  }, [hover, items.length]);
  // While the pill is up the rings are the provider it is talking about, and the ring of that limit stands out.
  const cur = hover && items.length > 0 ? items[index % items.length] : null;
  const rings = usageRings(usage, cur ? all.filter((p) => p !== cur.p) : [...hide]);
  const focus = !cur || !rings ? null : cur.w === rings.short ? "outer" : cur.w === rings.week ? "inner" : null;
  return (
    <RailButton
      label={high ? `Usage · ${high.label} ${high.percent}%` : "Usage"}
      onClick={() => (onUsage ? closeSettings() : openSettings("usage"))}
      active={onUsage}
      dot={high?.tone ?? null}
      tip={<UsagePill items={items} index={index} />}
      tipInline
      onRich={(on) => {
        setHover(on);
        // Start on the limit closest to running out.
        if (on) setIndex(items.reduce((best, it, i) => (it.w.used_percent! > items[best].w.used_percent! ? i : best), 0));
      }}
    >
      {rings ? <UsageRing size={20} outer={rings.short} inner={rings.week} focus={focus} /> : <IGauge size={20} />}
    </RailButton>
  );
}

/** The tightest short (5-hour) and weekly windows across the providers shown: what the rail's two rings draw. */
function usageRings(usage: PlanUsages, hide: Provider[]): { short: UsageWindow | null; week: UsageWindow | null } | null {
  let short: UsageWindow | null = null;
  let week: UsageWindow | null = null;
  for (const u of [usage.claude, usage.codex]) {
    if (!u || hide.includes(u.provider)) continue;
    for (const w of u.windows) {
      if (w.used_percent === null || w.window_minutes === null || w.model) continue;
      if (w.window_minutes <= 24 * 60) {
        if (!short || w.used_percent > short.used_percent!) short = w;
      } else if (!week || w.used_percent > week.used_percent!) week = w;
    }
  }
  return short || week ? { short, week } : null;
}

/**
 * One ring in two halves that empty as the limits are used, each filling from the bottom up like a gauge:
 * left = the 5-hour window, right = the weekly one (what is left of each).
 */
function UsageRing({ size, outer, inner, focus }: { size: number; outer: UsageWindow | null; inner: UsageWindow | null; focus?: "outer" | "inner" | null }) {
  const half = (w: UsageWindow | null, d: string, dim: boolean) => {
    const left = w ? Math.max(0, Math.min(100, 100 - w.used_percent!)) : 0;
    const tone = w ? usageTone(w) : "neutral";
    return (
      <>
        <path d={d} opacity={0.22} />
        {w && left > 0 && (
          <path
            d={d}
            pathLength={100}
            strokeDasharray={`${Math.max(0.5, left)} 100`}
            stroke={tone === "neutral" ? undefined : toneColor[tone]}
            opacity={dim ? 0.35 : 1}
            style={{ transition: "stroke-dasharray 600ms cubic-bezier(0.2, 0, 0, 1), opacity 200ms" }}
          />
        )}
      </>
    );
  };
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden data-usage-ring>
      {half(outer, "M6.915 14.155A6.25 6.25 0 0 1 6.915 1.845", focus === "inner")}
      {half(inner, "M9.085 14.155A6.25 6.25 0 0 0 9.085 1.845", focus === "outer")}
    </svg>
  );
}

export function Rail() {
  countRender("Rail");
  const activeTab = useStore((s) => s.activeTab);
  const activate = useStore((s) => s.activate);
  const setPalette = useStore((s) => s.setPalette);
  const setSheet = useStore((s) => s.setSheet);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const sheet = useStore((s) => s.sheet);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const needsPage = useStore((s) => s.needsPage);
  const settings = useStore((s) => s.settings);
  const openSettings = useStore((s) => s.openSettings);
  const closeSettings = useStore((s) => s.closeSettings);
  const onSettings = settings !== null && settings !== "usage";

  return (
    <nav data-tauri-drag-region aria-label="coool" className="relative z-20 flex w-[56px] shrink-0 flex-col items-center gap-1.5 pb-3 pt-1">
      <RailButton
        label="Home"
        active={settings === null && activeTab === null && !needsPage}
        onClick={() => activate(null)}
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
        {/* The updater (UpdatePanel.tsx): shown only while it works or something needs you. */}
        <UpdateButton>
          {(p) => (
            <RailButton label={p.label} onClick={p.onClick} active={p.active} dot={p.dot} hideTip={p.active} tint={p.tint}>
              {p.icon}
            </RailButton>
          )}
        </UpdateButton>
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
