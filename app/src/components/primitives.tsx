import { animate, AnimatePresence, motion, useMotionValue, useTransform } from "motion/react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import type { Provider, Status } from "../lib/types";
import { fmtApprox, fmtElapsed, fmtTokens } from "../lib/format";
import { useNow } from "../lib/clock";
import { contextWindow } from "../lib/models";

export type UiStatus = Status | "starting" | "needs";

export const spring = { type: "spring", stiffness: 520, damping: 42, mass: 0.9 } as const;
export const softSpring = { type: "spring", stiffness: 340, damping: 34 } as const;
export const ease = [0.22, 0.8, 0.3, 1] as const;

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function StatusDot({ status, size = 7, className }: { status: UiStatus; size?: number; className?: string }) {
  const color = status === "busy" || status === "starting" ? "var(--busy)" : status === "idle" || status === "needs" ? "var(--accent)" : "var(--dim)";
  return (
    <span className={cx("relative inline-flex shrink-0", status === "needs" && "mx-[2px]", className)} style={{ width: size, height: size }}>
      {(status === "busy" || status === "starting") && (
        <span className="pulse-ring absolute inset-0 rounded-full" style={{ background: color }} />
      )}
      {status === "needs" && <span className="needs-ring absolute -inset-[2.5px] rounded-full" />}
      <motion.span
        className="relative rounded-full"
        initial={false}
        animate={{
          backgroundColor: status === "ended" ? "rgba(0,0,0,0)" : color,
          boxShadow: status === "ended" ? `inset 0 0 0 1.4px ${color}` : `inset 0 0 0 0px ${color}`,
        }}
        transition={{ duration: 0.25 }}
        style={{ width: size, height: size }}
      />
    </span>
  );
}

export const statusLabel = (s: UiStatus) =>
  s === "busy" ? "Working" : s === "idle" ? "Waiting" : s === "starting" ? "Starting" : s === "needs" ? "Needs you" : "Ended";

export function StatusPill({ status }: { status: UiStatus }) {
  if (status === "needs") return <NeedsBadge />;
  const tone =
    status === "busy" || status === "starting"
      ? "text-busy bg-[color-mix(in_oklab,var(--busy)_12%,transparent)]"
      : status === "idle"
        ? "text-accent bg-accent-soft"
        : "text-dim bg-hover";
  return (
    <span className={cx("inline-flex h-[20px] shrink-0 items-center gap-1.5 rounded-full pl-[7px] pr-2 text-xs font-medium", tone)}>
      <StatusDot status={status} size={6} />
      {statusLabel(status)}
    </span>
  );
}

export function ProviderMark({ provider, size = 13, className }: { provider: Provider; size?: number; className?: string }) {
  if (provider === "claude") {
    const rays = [0, 45, 90, 135, 180, 225, 270, 315];
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" className={cx("shrink-0", className)} aria-label="claude">
        <g stroke="var(--claude)" strokeWidth="1.9" strokeLinecap="round">
          {rays.map((a, i) => {
            const r = (a * Math.PI) / 180;
            const len = i % 2 ? 5.2 : 6.3;
            return <line key={a} x1={8 + Math.cos(r) * 1.6} y1={8 + Math.sin(r) * 1.6} x2={8 + Math.cos(r) * len} y2={8 + Math.sin(r) * len} />;
          })}
        </g>
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={cx("shrink-0", className)} aria-label="codex">
      <path d="M8 1.9l5.3 3.05v6.1L8 14.1l-5.3-3.05v-6.1z" fill="none" stroke="var(--codex)" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M6 6.6l1.7 1.4L6 9.4M8.6 9.6h1.6" fill="none" stroke="var(--codex)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Animated count: glides from the previous value instead of jumping. */
export function Ticker({ value, format = fmtTokens, className }: { value: number; format?: (n: number) => string; className?: string }) {
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) => format(v));
  useEffect(() => {
    const c = animate(mv, value, { duration: 0.7, ease: [0.16, 1, 0.3, 1] });
    return () => c.stop();
  }, [value, mv]);
  return <motion.span className={cx("tnum font-mono", className)}>{text}</motion.span>;
}

/**
 * A live timer. `approx` marks a start time that was estimated rather than
 * observed: it renders coarse ("~3m", "<1m") and never ticks seconds.
 */
export function Elapsed({ since, approx, className }: { since: number | null; approx?: boolean; className?: string }) {
  const now = useNow();
  if (since === null) return null;
  if (approx)
    return (
      <span className={cx("tnum font-mono", className)} title="Approximate: started before coool was watching">
        {fmtApprox(now - since)}
      </span>
    );
  return <span className={cx("tnum font-mono", className)}>{fmtElapsed(now - since)}</span>;
}

/**
 * Context used against the model's real window. The window comes from the CLI
 * when reported, else the family table, else an assumed 200k. Only a reported
 * window can turn the meter red; an estimate caps at the warning colour.
 */
export function ContextMeter({
  context,
  model,
  window: reported,
  compact,
  className,
}: {
  context: number;
  model?: string | null;
  window?: number | null;
  compact?: boolean;
  className?: string;
}) {
  const w = contextWindow(model, reported);
  const exact = w.source === "reported";
  const raw = context / w.tokens;
  const pct = Math.min(1, raw);
  const color = exact && pct > 0.85 ? "var(--error)" : pct > (exact ? 0.65 : 0.75) ? "var(--busy)" : "var(--accent)";
  const tip =
    `Context ${fmtTokens(context)} of ${fmtTokens(w.tokens)}` +
    (w.source === "reported" ? " (reported by the CLI)" : w.source === "family" ? ` (estimated for ${model})` : " (window unknown; 200k assumed)");
  return (
    <div className={cx("flex items-center gap-2", className)} title={tip}>
      <div className={cx("relative h-[4px] overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--dim)_20%,transparent)]", compact ? "w-14" : "w-20")}>
        <motion.div
          className="absolute inset-y-0 left-0 rounded-full"
          initial={false}
          animate={{ width: `${Math.max(2, pct * 100)}%`, backgroundColor: color }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        />
        {!exact && <span className="absolute inset-y-0 right-0 w-[3px] bg-[repeating-linear-gradient(90deg,var(--dim)_0_1px,transparent_1px_2px)] opacity-60" />}
      </div>
      <span className="text-xs text-dim">
        <Ticker value={context} className="text-fg/80" />
        {!compact && (
          <span className="text-faint">
            {" / "}
            {exact ? "" : "~"}
            {fmtTokens(w.tokens)}
          </span>
        )}
      </span>
    </div>
  );
}

/** The distinct "blocked on you" badge: solid accent, so it reads differently from "Waiting". */
export function NeedsBadge({ small, className }: { small?: boolean; className?: string }) {
  return (
    <span
      className={cx(
        "needs-badge inline-flex shrink-0 items-center gap-1 rounded-full bg-accent font-semibold text-accent-ink",
        small ? "h-[15px] px-1.5 text-[9.5px] uppercase tracking-[0.04em]" : "h-[20px] pl-[6px] pr-2 text-xs",
        className,
      )}
    >
      <svg width={small ? 8 : 10} height={small ? 8 : 10} viewBox="0 0 10 10" aria-hidden>
        <path d="M5 1.2v4.3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="5" cy="8.1" r="1" fill="currentColor" />
      </svg>
      Needs you
    </span>
  );
}

/**
 * Anchored popover. Render inside a `relative` wrapper; it positions itself
 * against that wrapper. Closes on outside pointer-down and Escape.
 */
export function Popover({
  open,
  onClose,
  children,
  side = "bottom",
  align = "start",
  className,
  width,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "end";
  className?: string;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node) && !(el.parentElement?.contains(e.target as Node) && (e.target as HTMLElement).closest("[data-pop-anchor]"))) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const t = setTimeout(() => window.addEventListener("pointerdown", down, true), 0);
    window.addEventListener("keydown", key, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open, onClose]);
  const y = side === "bottom" ? -6 : 6;
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          initial={{ opacity: 0, y, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: y / 2, scale: 0.985, transition: { duration: 0.12 } }}
          transition={{ type: "spring", stiffness: 620, damping: 40 }}
          style={{ width, transformOrigin: `${side === "bottom" ? "top" : "bottom"} ${align === "start" ? "left" : "right"}` }}
          className={cx(
            "absolute z-40 overflow-hidden rounded-[12px] border border-line bg-raised shadow-pop",
            side === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5",
            align === "start" ? "left-0" : "right-0",
            className,
          )}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** A small chip button used for model / mode pickers. */
export function Chip({
  children,
  onClick,
  active,
  title,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-pop-anchor
      title={title}
      onClick={onClick}
      className={cx(
        "inline-flex h-[24px] shrink-0 items-center gap-1.5 rounded-[7px] px-2 text-xs font-medium transition-[background-color,color] duration-150",
        active ? "bg-press text-fg" : "text-dim hover:bg-hover hover:text-fg",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-line bg-raised px-1 font-sans text-2xs font-medium text-dim",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function IconButton({
  children,
  onClick,
  title,
  className,
  active,
  disabled,
}: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  className?: string;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-[7px] text-dim transition-[background-color,color] duration-150",
        "hover:bg-hover hover:text-fg active:bg-press disabled:opacity-40 disabled:hover:bg-transparent",
        active && "bg-hover text-fg",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "md",
}: {
  value: T;
  options: { value: T; label: ReactNode; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  const id = useId();
  return (
    <div className={cx("relative inline-flex rounded-[8px] bg-[color-mix(in_oklab,var(--dim)_12%,transparent)] p-[2px]", size === "sm" ? "h-[26px]" : "h-[30px]")}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            title={o.title}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cx(
              "relative z-0 flex items-center gap-1.5 rounded-[6px] font-medium transition-colors duration-150 disabled:opacity-40",
              size === "sm" ? "px-2 text-xs" : "px-2.5 text-sm",
              on ? "text-fg" : "text-dim hover:text-fg",
            )}
          >
            {on && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 -z-10 rounded-[6px] bg-raised shadow-[0_1px_2px_rgb(0_0_0/0.12),0_0_0_0.5px_var(--border)]"
                transition={spring}
              />
            )}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "ghost",
  className,
  disabled,
  title,
  type = "button",
  ...data
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "outline" | "danger";
  className?: string;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  /** `data-*` attributes (hooks for the self-test and styling). */
  [data: `data-${string}`]: string | boolean | undefined;
}) {
  return (
    <button
      {...data}
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "inline-flex h-[28px] shrink-0 items-center justify-center gap-1.5 rounded-[8px] px-2.5 text-sm font-medium transition-[background-color,color,border-color,opacity,transform] duration-150 active:scale-[0.98] disabled:opacity-45 disabled:active:scale-100",
        variant === "primary" && "bg-accent text-accent-ink hover:brightness-[1.06]",
        variant === "ghost" && "text-dim hover:bg-hover hover:text-fg",
        variant === "outline" && "border border-line bg-raised text-fg shadow-card hover:border-[color-mix(in_oklab,var(--dim)_45%,var(--border))]",
        variant === "danger" && "bg-err text-white hover:brightness-110",
        className,
      )}
    >
      {children}
    </button>
  );
}
