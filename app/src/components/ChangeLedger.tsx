// Mission control's ledger: what agents changed in one project, newest first (lib/mission.ts derives
// the rows from session timelines and chat tool calls). New rows slide in at the top and the count
// ticks up. A row opens the session it came from.

import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useRef, useState, type ComponentType } from "react";
import { useClock } from "../lib/clock";
import { ago } from "../lib/format";
import type { Change, ChangeKind } from "../lib/mission";
import { useMotion } from "../lib/motion";
import type { Provider } from "../lib/types";
import { IArrowUp, IArrowUpRight, IBranch, ICommit, IDeploy, IFile, IForward, IGlobe, IList, IPencil, IPhone, IPullRequest, IStack, ITrash } from "./icons";
import { cx, ease, ProviderMark, Ticker } from "./primitives";

type Icon = ComponentType<{ size?: number; className?: string }>;
const ICON: Record<ChangeKind, Icon> = {
  edit: IPencil,
  create: IFile,
  delete: ITrash,
  move: IForward,
  commit: ICommit,
  push: IArrowUp,
  merge: IBranch,
  pr: IPullRequest,
  deploy: IDeploy,
  publish: IArrowUpRight,
  pilot: IPhone,
  migrate: IStack,
  request: IGlobe,
};
const PATHY = new Set<ChangeKind>(["edit", "create", "delete", "move"]);

/** Rows shown before "Show all". */
const CAP = 5;

export interface LedgerSource {
  provider: Provider;
  title: string;
}

export function ChangeLedger({ changes, sources, onOpen, className }: { changes: Change[]; sources: Record<string, LedgerSource>; onOpen: (c: Change) => void; className?: string }) {
  const [all, setAll] = useState(false);
  const reduce = useMotion().reduce;
  // Rows that arrive after the first paint slide in; the first paint is still.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(changes.map((c) => c.id));
  const fresh = new Set(changes.filter((c) => !seen.current!.has(c.id)).map((c) => c.id));
  useEffect(() => {
    for (const id of fresh) seen.current!.add(id);
  });
  const shown = all ? changes : changes.slice(0, CAP);
  const total = changes.reduce((n, c) => n + c.times, 0);

  return (
    <section className={cx("overflow-hidden rounded-[14px] border border-hairline bg-bg", className)} data-mc-ledger={changes.length}>
      <header className="flex h-[40px] items-center gap-2 px-3.5">
        <IList size={14} className="shrink-0 text-dim" />
        <span className="text-base font-medium text-fg">Changes</span>
        <span className="ml-auto flex shrink-0 items-baseline gap-1 text-small text-faint">
          <Ticker value={total} format={(n) => String(Math.round(n))} className="text-dim" />
          {total === 1 ? "change" : "changes"}
        </span>
      </header>
      {changes.length === 0 ? (
        <div className="flex h-[56px] items-center gap-2.5 border-t border-hairline px-3.5 text-small text-faint" data-mc-ledger-empty>
          Nothing changed yet. Edits, commits, pushes and deploys show up here as agents make them.
        </div>
      ) : (
        <div className="border-t border-hairline py-1">
          <AnimatePresence initial={false}>
            {shown.map((c) => (
              <motion.div
                key={c.id}
                initial={fresh.has(c.id) && !reduce ? { height: 0, opacity: 0 } : false}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: reduce ? 0 : 0.32, ease }}
                className="overflow-hidden"
              >
                <Row c={c} src={sources[c.session]} fresh={fresh.has(c.id) && !reduce} onOpen={onOpen} />
              </motion.div>
            ))}
          </AnimatePresence>
          {changes.length > CAP && (
            <button type="button" onClick={() => setAll((v) => !v)} className="mx-1.5 mt-0.5 flex h-[28px] items-center rounded-[7px] px-2 text-small text-dim transition-colors hover:bg-hover hover:text-fg">
              {all ? "Show fewer" : `Show all ${changes.length}`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

const Row = memo(function Row({ c, src, fresh, onOpen }: { c: Change; src?: LedgerSource; fresh: boolean; onOpen: (c: Change) => void }) {
  const Icon = ICON[c.kind];
  const age = useClock((now) => ago(c.ts, now));
  const counts = c.added !== undefined || c.removed !== undefined;
  const pair = c.before !== undefined && c.after !== undefined;
  return (
    <button
      type="button"
      onClick={() => onOpen(c)}
      title={src ? `Open “${src.title}”` : undefined}
      className={cx("group relative mx-1.5 flex min-h-[44px] w-[calc(100%-12px)] items-center gap-2.5 rounded-[9px] px-2 py-[7px] text-left transition-colors duration-150 hover:bg-hover", fresh && "mc-fresh")}
      data-change={c.kind}
    >
      <span className="flex size-[28px] shrink-0 items-center justify-center rounded-[8px] border border-hairline bg-panel text-dim">
        <Icon size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5 text-base">
          <span className="shrink-0 font-medium text-fg">{c.action}</span>
          <span className={cx("min-w-0 truncate text-dim", PATHY.has(c.kind) && "font-mono text-mono-small")} title={c.object}>
            {c.object}
          </span>
          {c.times > 1 && <span className="shrink-0 text-small text-faint tnum">×{c.times}</span>}
        </span>
        <span className={cx("min-w-0 items-center gap-1.5 text-small text-faint", counts || pair || c.detail ? "flex h-[18px]" : "hidden")}>
          {counts && (
            <span className="flex shrink-0 gap-1.5 font-mono text-mono-small tnum">
              {!!c.added && <span className="text-done-text">+{c.added}</span>}
              {!!c.removed && <span className="text-err-text">−{c.removed}</span>}
              {!c.added && !c.removed && <span>no line changes</span>}
            </span>
          )}
          {pair ? (
            <>
              <span className="min-w-0 max-w-[45%] truncate line-through decoration-faint/60">{c.before}</span>
              <IForward size={11} className="shrink-0" />
              <span className="min-w-0 truncate text-dim">{c.after}</span>
            </>
          ) : c.detail ? (
            <span className="min-w-0 truncate">{c.detail}</span>
          ) : null}
        </span>
      </span>
      <span className="flex w-[78px] shrink-0 items-center justify-end gap-1.5">
        {src && <ProviderMark provider={src.provider} size={11} className="opacity-70" />}
        <span className="text-small text-faint tnum">{age}</span>
      </span>
    </button>
  );
});
