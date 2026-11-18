// Mission control's ledger: what agents changed in one project that the commit trail can't show
// (uncommitted edits, pushes, PRs, deploys, publishes, migrations, device runs), newest first. The rows
// come from lib/mission.ts (`ledgerRows`). One line per row on the card system of MissionCard.tsx; new
// rows slide in at the top. A row opens the session it came from.

import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useRef, type ComponentType } from "react";
import type { Change, ChangeKind } from "../lib/mission";
import { useMotion } from "../lib/motion";
import type { Provider } from "../lib/types";
import { IArrowUp, IArrowUpRight, IBranch, ICommit, IDeploy, IFile, IForward, IGlobe, IList, IPencil, IPhone, IPullRequest, IStack, ITrash } from "./icons";
import { Age, Card, CardHeader, FitList, Node, ROW, TEXT_X } from "./MissionCard";
import { cx, ease } from "./primitives";

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
/** Rows whose object is a path or a branch (mono). */
const MONO = new Set<ChangeKind>(["edit", "create", "delete", "move", "push"]);

export interface LedgerSource {
  provider: Provider;
  title: string;
}

export function ChangeLedger({ changes, sources, onOpen, minRows = 6, className }: { changes: Change[]; sources: Record<string, LedgerSource>; onOpen: (c: Change) => void; minRows?: number; className?: string }) {
  const reduce = useMotion().reduce;
  // Rows that arrive after the first paint slide in; the first paint is still.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(changes.map((c) => c.id));
  const fresh = new Set(changes.filter((c) => !seen.current!.has(c.id)).map((c) => c.id));
  useEffect(() => {
    for (const id of fresh) seen.current!.add(id);
  });

  return (
    <Card className={className} data-mc-ledger={changes.length}>
      <CardHeader icon={IList} title="Changes" meta={changes.length > 0 && changes.length} />
      {changes.length === 0 ? (
        <div className="flex h-[36px] items-center text-small text-faint" style={{ paddingLeft: TEXT_X }} data-mc-ledger-empty>
          Nothing uncommitted. Edits show here until they're committed, with pushes and deploys.
        </div>
      ) : (
        <FitList
          total={changes.length}
          minRows={minRows}
          render={(n) => (
            <AnimatePresence initial={false}>
              {changes.slice(0, n).map((c) => (
                <motion.div
                  key={c.id}
                  initial={fresh.has(c.id) && !reduce ? { height: 0, opacity: 0 } : false}
                  animate={{ height: ROW, opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: reduce ? 0 : 0.32, ease }}
                  className="shrink-0 overflow-hidden"
                >
                  <Row c={c} src={sources[c.session]} fresh={fresh.has(c.id) && !reduce} onOpen={onOpen} />
                </motion.div>
              ))}
            </AnimatePresence>
          )}
        />
      )}
    </Card>
  );
}

const Row = memo(function Row({ c, src, fresh, onOpen }: { c: Change; src?: LedgerSource; fresh: boolean; onOpen: (c: Change) => void }) {
  const Icon = ICON[c.kind];
  const counts = (c.added !== undefined || c.removed !== undefined) && (!!c.added || !!c.removed);
  const pair = c.before !== undefined && c.after !== undefined && c.kind !== "push";
  const mono = MONO.has(c.kind) && !/^\d+ files$/.test(c.object);
  return (
    <button
      type="button"
      onClick={() => onOpen(c)}
      title={src ? `Open “${src.title}”` : undefined}
      className={cx("group flex h-[36px] w-full items-center gap-2.5 px-3.5 text-left transition-colors duration-150 hover:bg-hover", fresh && "mc-fresh")}
      data-change={c.kind}
    >
      <Node className="text-faint">
        <Icon size={14} />
      </Node>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="shrink-0 text-base text-fg">{c.action}</span>
        <span className={cx("min-w-0 shrink truncate text-dim", mono ? "font-mono text-mono-small" : "text-base")} title={c.object}>
          {c.kind === "push" && c.after ? `${c.object} → ${c.after}` : c.object}
        </span>
        {c.times > 1 && <span className="shrink-0 text-small text-faint tnum">×{c.times}</span>}
        {pair ? (
          <span className="flex min-w-0 shrink-[2] items-baseline gap-1 truncate text-small text-faint">
            <span className="min-w-0 truncate line-through decoration-faint/60">{c.before}</span>
            <span className="shrink-0">→</span>
            <span className="min-w-0 truncate text-dim">{c.after}</span>
          </span>
        ) : c.detail ? (
          <span className="min-w-0 shrink-[2] truncate text-small text-faint">{c.detail}</span>
        ) : null}
      </span>
      {counts && (
        <span className="flex shrink-0 gap-1.5 font-mono text-mono-small tnum">
          {!!c.added && <span className="text-done-text">+{c.added}</span>}
          {!!c.removed && <span className="text-err-text">−{c.removed}</span>}
        </span>
      )}
      <Age ms={c.ts} />
    </button>
  );
});
