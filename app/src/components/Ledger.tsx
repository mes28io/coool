// Ledger: a card listing changes an agent made, newest first. Driven by plain props, so
// it can show any list of agent-made changes (files in a chat, outside effects, a
// service's records...). Undo is opt-in: nothing reversible is offered without `onUndo`.

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ago } from "../lib/format";
import { IFile, IForward, IList, ILock, ITerminal } from "./icons";
import { cx, ease } from "./primitives";
import { reducedMotion } from "./StepRail";

export interface LedgerChange {
  id: string;
  /** "Changed price", "Edited", "Committed". Medium weight. */
  action: string;
  /** What it touched, dim, after the action: "Pro plan", "src/App.tsx". */
  object: string;
  /** Second line when there is no before/after. */
  detail?: string;
  /** A before -> after pair; the old value is struck through. */
  before?: string;
  after?: string;
  /** Epoch ms. */
  ts: number;
  /** Where it happened, right side after the age: "Stripe", "Edit". */
  source: string;
  /** Tile glyph; defaults by `kind`. */
  kind?: "file" | "terminal";
  icon?: ComponentType<{ size?: number; className?: string }>;
  /** false: cannot be reversed (shows a "Can't undo" tag). Default true. */
  reversible?: boolean;
  undone?: boolean;
  /** Ids undone together with this one (shown as "Also undone" while hovering Undo). */
  undoWith?: string[];
  /** Opaque grouping key for callers (e.g. the turn a change belongs to). */
  group?: string;
}

const TILE = { file: IFile, terminal: ITerminal } as const;

export function Ledger({
  changes,
  title,
  onUndo,
  bare,
  maxHeight,
  now: nowProp,
}: {
  changes: LedgerChange[];
  title?: string;
  /** Present => reversible rows offer Undo on hover. Absent => read-only. */
  onUndo?: (id: string) => void;
  /** No card chrome (inside a panel that already is one). */
  bare?: boolean;
  maxHeight?: number;
  now?: number;
}) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (nowProp !== undefined) return;
    const t = setInterval(() => setTick(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [nowProp]);
  const now = nowProp ?? tick;
  const [hover, setHover] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(changes.map((c) => c.id));
  const fresh = new Set(changes.filter((c) => !seen.current!.has(c.id)).map((c) => c.id));
  useEffect(() => {
    for (const id of fresh) seen.current!.add(id);
  });
  const undone = changes.filter((c) => c.undone).length;
  const hovered = onUndo ? changes.find((c) => c.id === hover && !c.undone && c.reversible !== false) : undefined;
  const also = new Set(hovered?.undoWith ?? []);
  const instant = reducedMotion();

  return (
    <div className={cx("overflow-hidden", !bare && "rounded-[14px] border border-hairline bg-raised shadow-card")} data-ledger={changes.length}>
      <div className="flex h-[36px] items-center gap-2 px-3.5 text-base">
        <IList size={14} className="shrink-0 text-dim" />
        <span className="shrink-0 font-medium text-fg">Ledger</span>
        <span className="min-w-0 flex-1 truncate text-small text-dim">{title}</span>
        <span className="flex shrink-0 gap-1 whitespace-nowrap text-small text-faint tnum">
          {changes.length} {changes.length === 1 ? "change" : "changes"}
          {undone > 0 && <span>· {undone} undone</span>}
        </span>
      </div>
      <div className={cx(!!maxHeight && "scroll overflow-y-auto")} style={maxHeight ? { maxHeight } : undefined}>
        {changes.length === 0 && <div className="px-3.5 pb-4 pt-2 text-small text-faint">Nothing has been changed yet.</div>}
        <AnimatePresence initial={false}>
          {changes.map((c) => (
            <motion.div
              key={c.id}
              initial={fresh.has(c.id) && !instant ? { height: 0, opacity: 0 } : false}
              animate={{ height: "auto", opacity: 1 }}
              transition={{ duration: instant ? 0 : 0.3, ease }}
              className="overflow-hidden"
            >
              <Row c={c} now={now} onUndo={onUndo} also={also.has(c.id)} hot={hovered?.id === c.id} onHover={(on) => setHover((h) => (on ? c.id : h === c.id ? null : h))} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Row({ c, now, onUndo, also, hot, onHover }: { c: LedgerChange; now: number; onUndo?: (id: string) => void; also: boolean; hot: boolean; onHover: (on: boolean) => void }) {
  const Icon = c.icon ?? TILE[c.kind ?? "file"];
  const canUndo = !!onUndo && !c.undone && c.reversible !== false;
  const strike = c.undone && "line-through decoration-faint/50";
  let right: ReactNode;
  let rightKey: string;
  if (c.undone) {
    rightKey = "undone";
    right = <span className="text-small text-faint">Undone</span>;
  } else if (also) {
    rightKey = "also";
    right = <span className="text-small text-dim">Also undone</span>;
  } else {
    rightKey = "age";
    right = (
      <span className="text-small text-faint tnum">
        {ago(c.ts, now)} · {c.source}
      </span>
    );
  }
  return (
    <div
      onMouseEnter={() => canUndo && onHover(true)}
      onMouseLeave={() => canUndo && onHover(false)}
      className={cx("group relative mx-1.5 flex min-h-[48px] items-center gap-2.5 rounded-[8px] px-2 py-1.5 transition-colors duration-150", (hot || also) && "bg-hover")}
      data-change={c.id}
    >
      <span className={cx("flex size-[28px] shrink-0 items-center justify-center rounded-[8px] border border-hairline bg-bg text-dim transition-opacity duration-300", c.undone && "opacity-50")}>
        <Icon size={14} />
      </span>
      <div className={cx("min-w-0 flex-1 transition-opacity duration-300", c.undone && "opacity-55")}>
        <div className="flex min-w-0 items-center gap-2 text-base">
          <span className={cx("shrink-0 font-medium text-fg transition-colors", strike)}>{c.action}</span>
          <span className={cx("min-w-0 truncate text-dim", strike, c.kind === "terminal" && "font-mono text-mono-small")} title={c.object}>
            {c.object}
          </span>
        </div>
        {(c.before !== undefined && c.after !== undefined) || c.detail || (c.reversible === false && !c.undone) ? (
          <div className={cx("flex min-w-0 items-center gap-1.5 text-small text-faint", strike)}>
          {c.reversible === false && !c.undone && (
            <span className="flex shrink-0 items-center gap-1 rounded-[6px] border border-line bg-raised px-1.5 text-micro font-medium text-dim" title="This can't be undone from here">
              <span className="size-[6px] rounded-full bg-busy" />
              <ILock size={11} />
              Can't undo
            </span>
          )}

            {c.before !== undefined && c.after !== undefined ? (
              <>
                <span className="min-w-0 truncate line-through decoration-faint/60">{c.before}</span>
                <IForward size={12} className="shrink-0 text-faint" />
                <span className="min-w-0 truncate text-dim">{c.after}</span>
              </>
            ) : (
              <span className="min-w-0 truncate">{c.detail}</span>
            )}
          </div>
        ) : null}
      </div>
      {/* Right side: a fixed box so swapping age / Undo / state never shifts the row. */}
      <div className="relative h-[24px] w-[112px] shrink-0">
        <AnimatePresence initial={false}>
          <motion.div
            key={rightKey}
            initial={{ opacity: 0 }}
            animate={{ opacity: canUndo && hot && rightKey === "age" ? 0 : 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion() ? 0 : 0.2 }}
            className="absolute inset-0 flex items-center justify-end whitespace-nowrap"
          >
            {right}
          </motion.div>
        </AnimatePresence>
        {canUndo && (
          <button
            type="button"
            onClick={() => onUndo!(c.id)}
            tabIndex={hot ? 0 : -1}
            data-undo={c.id}
            className={cx(
              "absolute right-0 top-0 h-[24px] rounded-[7px] border border-line bg-raised px-2.5 text-small font-medium text-fg transition-opacity duration-150 hover:bg-press focus-visible:opacity-100",
              hot ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          >
            Undo
          </button>
        )}
      </div>
    </div>
  );
}
