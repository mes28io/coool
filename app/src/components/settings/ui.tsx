// Building blocks of the Settings page: a card of rows (Group), a row (title, one plain line, a control), Switch,
// Select, and the search filter every Row applies itself (SearchScope / useQuery).

import { motion } from "motion/react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ICaret, ICheck } from "../icons";
import { Button, cx, Popover } from "../primitives";

// ---------- search ----------

interface Scope {
  /** Lower-cased words of the search, empty when not searching. */
  words: string[];
  /** The section's own name or description matched: every row in it shows. */
  all: boolean;
}
const SearchCtx = createContext<Scope>({ words: [], all: true });

export function SearchScope({ words, all, children }: { words: string[]; all: boolean; children: ReactNode }) {
  return <SearchCtx.Provider value={{ words, all }}>{children}</SearchCtx.Provider>;
}

export const textMatches = (words: string[], hay: string) => {
  const h = hay.toLowerCase();
  return words.every((w) => h.includes(w));
};

/** Whether a row with this text shows under the current search. */
export function useShown(text: string): boolean {
  const s = useContext(SearchCtx);
  return s.all || !s.words.length || textMatches(s.words, text);
}
export const useSearching = () => useContext(SearchCtx).words.length > 0;

// ---------- layout ----------

/** A card of rows with hairline dividers, an optional small uppercase label above; hidden when a search left no row. */
export function Group({ label, children, footer, attr }: { label?: ReactNode; children: ReactNode; footer?: ReactNode; attr?: string }) {
  return (
    <section className="pt-7 first:pt-0 [&:not(:has([data-setting]))]:hidden" data-group={attr}>
      {label && <div className="flex items-center gap-2 px-1 pb-2 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">{label}</div>}
      <div className="flex flex-col divide-y divide-hairline rounded-[12px] border border-line bg-raised px-4">{children}</div>
      {footer && <div className="px-1 pt-2 text-small text-faint">{footer}</div>}
    </section>
  );
}

/**
 * Title, a one-line plain description, the control on the right; `children` go under the whole row.
 * `k`: extra words the search matches (the title and a string description always do).
 */
export function Row({ label, desc, control, children, attr, k, dense }: { label: ReactNode; desc?: ReactNode; control?: ReactNode; children?: ReactNode; attr?: string; k?: string; dense?: boolean }) {
  const text = `${typeof label === "string" ? label : ""} ${typeof desc === "string" ? desc : ""} ${k ?? ""}`;
  if (!useShown(text)) return null;
  return (
    <div className={cx("flex flex-col gap-2.5", dense ? "py-2.5" : "py-3.5")} data-setting={attr ?? (typeof label === "string" ? label : undefined)}>
      <div className="flex items-start gap-6">
        <div className="min-w-0 flex-1">
          <div className="text-base text-fg">{label}</div>
          {desc && <div className="mt-0.5 text-small text-dim">{desc}</div>}
        </div>
        {control && <div className="mt-[1px] flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {children}
    </div>
  );
}

/** A quiet panel under a row: an explanation, a privacy note. */
export function Note({ children, tone }: { children: ReactNode; tone?: "warn" | "err" }) {
  return (
    <div
      className={cx(
        "rounded-[8px] px-3 py-2 text-small",
        tone === "err" ? "bg-[color-mix(in_oklab,var(--error)_10%,transparent)] text-fg/90" : tone === "warn" ? "bg-[color-mix(in_oklab,var(--busy)_12%,transparent)] text-fg/90" : "bg-[color-mix(in_oklab,var(--dim)_8%,transparent)] text-dim",
      )}
    >
      {children}
    </div>
  );
}

/** A path or command shown in mono, selectable. */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("selectable break-all font-mono text-mono-small", className)}>{children}</span>;
}

/** A shell command with a Copy button. */
export function Command({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-[8px] border border-line bg-bg py-1 pl-2.5 pr-1">
      <Mono className="min-w-0 flex-1 text-fg/90">{cmd}</Mono>
      <Button
        variant="ghost"
        className="h-[26px] px-2 text-small"
        onClick={() =>
          void navigator.clipboard?.writeText(cmd).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          })
        }
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/** A small rounded tag ("user", "stdio", "merged"). */
export function Tag({ children, tone }: { children: ReactNode; tone?: "ok" | "warn" | "err" | "off" }) {
  return (
    <span
      className={cx(
        "inline-flex h-[18px] items-center rounded-[5px] px-1.5 font-mono text-micro",
        tone === "ok" && "bg-accent-soft text-accent-text",
        tone === "warn" && "bg-[color-mix(in_oklab,var(--busy)_16%,transparent)] text-busy-text",
        tone === "err" && "bg-[color-mix(in_oklab,var(--error)_14%,transparent)] text-err-text",
        (!tone || tone === "off") && "bg-[color-mix(in_oklab,var(--dim)_12%,transparent)] text-dim",
      )}
    >
      {children}
    </span>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  return children ? <div className="text-small text-err-text">{children}</div> : null;
}

// ---------- controls ----------

export function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cx("relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40", on ? "bg-accent" : "bg-[color-mix(in_oklab,var(--dim)_35%,transparent)]")}
    >
      <motion.span
        className="absolute top-[2px] size-[18px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)]"
        initial={false}
        animate={{ left: on ? 18 : 2 }}
        transition={{ type: "spring", stiffness: 700, damping: 38 }}
      />
    </button>
  );
}

export interface Option<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** A dropdown: the current choice on a button, the options in a popover. */
export function Select<T extends string>({ value, options, onChange, label, width = 220, disabled }: { value: T; options: Option<T>[]; onChange: (v: T) => void; label: string; width?: number; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const cur = options.find((o) => o.value === value);
  return (
    <div className="relative">
      <button
        type="button"
        data-pop-anchor
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex h-[30px] max-w-[260px] items-center gap-1.5 rounded-[8px] border border-line bg-bg pl-2.5 pr-1.5 text-small text-fg transition-colors duration-150 hover:border-[color-mix(in_oklab,var(--dim)_45%,var(--border))] disabled:opacity-45"
      >
        <span className="min-w-0 truncate">{cur?.label ?? value}</span>
        <ICaret size={13} className="shrink-0 text-faint" />
      </button>
      <Popover open={open} onClose={close} align="end" width={width}>
        <div role="listbox" aria-label={label} className="scroll flex max-h-[320px] flex-col p-1">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              onClick={() => {
                onChange(o.value);
                close();
              }}
              className="flex items-start gap-2 rounded-[8px] px-2 py-1.5 text-left transition-colors duration-100 hover:bg-hover"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-small text-fg">{o.label}</span>
                {o.hint && <span className="block truncate text-micro text-faint">{o.hint}</span>}
              </span>
              <ICheck size={13} className={cx("mt-[3px] shrink-0 text-accent-text", o.value !== value && "invisible")} />
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}

/** A button that asks once inline before doing something that can't be undone. */
export function ConfirmButton({ label, confirm, onConfirm, disabled, attr }: { label: string; confirm: string; onConfirm: () => Promise<unknown> | void; disabled?: boolean; attr?: string }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (busy) return <span className="px-2 text-small text-faint">Working…</span>;
  return asking ? (
    <span className="flex items-center gap-1">
      <Button
        variant="ghost"
        className="h-[30px] px-2.5 text-small text-err-text"
        data-confirm={attr}
        onClick={() => {
          setAsking(false);
          setBusy(true);
          void Promise.resolve(onConfirm()).finally(() => setBusy(false));
        }}
      >
        {confirm}
      </Button>
      <Button variant="ghost" className="h-[30px] px-2.5 text-small" onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </span>
  ) : (
    <Button variant="outline" className="h-[30px] px-2.5 text-small" disabled={disabled} onClick={() => setAsking(true)} data-ask={attr}>
      {label}
    </Button>
  );
}

// ---------- data ----------

const cache = new Map<string, unknown>();

/**
 * Loads once per key and keeps the result for the page's life (switching sections or searching doesn't reload);
 * `reload` fetches again. `err` is the error text.
 */
export function useLoad<T>(key: string | null, f: () => Promise<T>): { data: T | undefined; err: string | null; loading: boolean; reload: () => void; set: (v: T) => void } {
  const [data, setData] = useState<T | undefined>(() => (key ? (cache.get(key) as T | undefined) : undefined));
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fRef = useRef(f);
  fRef.current = f;
  const current = useRef(key);
  current.current = key;
  const run = useCallback(() => {
    if (!key) return;
    setLoading(true);
    setErr(null);
    fRef
      .current()
      .then((v) => {
        cache.set(key, v);
        // A late answer for a key no longer shown (another project picked meanwhile) only fills the cache.
        if (current.current === key) setData(v);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [key]);
  useEffect(() => {
    if (!key) return;
    setData(cache.get(key) as T | undefined);
    if (!cache.has(key)) run();
  }, [key, run]);
  const set = useCallback(
    (v: T) => {
      if (key) cache.set(key, v);
      setData(v);
    },
    [key],
  );
  return { data, err, loading, reload: run, set };
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "size unknown";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
