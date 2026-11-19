// Mission control's ledger: what agents changed in one project that the commit trail can't show
// (uncommitted edits, pushes, PRs, deploys, publishes, migrations, device runs), newest first. The rows
// come from lib/mission.ts (`ledgerRows`). One line per row on the card system of MissionCard.tsx; new
// rows slide in at the top. A row opens the session it came from. Files that two live sessions both have
// pending edits to (`overlaps`) are pinned on top; a click lists each session's edit with Open.

import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useRef, useState, type ComponentType } from "react";
import { authorOf, compactSpan, type Change, type ChangeKind, type Overlap, type OverlapEdit } from "../lib/mission";
import { authorLabel } from "../lib/projectChanges";
import { useMotion } from "../lib/motion";
import type { Provider } from "../lib/types";
import { IArrowUp, IArrowUpRight, IBranch, ICommit, IDeploy, IFile, IForward, IGlobe, IList, IOverlap, IPencil, IPhone, IPullRequest, IStack, ITrash } from "./icons";
import { Age, Card, CardHeader, FitList, Node, ROW, TEXT_X } from "./MissionCard";
import { cx, ease, ProviderMark } from "./primitives";

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
  agents?: Record<string, string>;
}

type Unit = { id: string; ov?: Overlap; edit?: OverlapEdit; c?: Change };

export function ChangeLedger({
  changes,
  sources,
  onOpen,
  overlaps = [],
  onOpenSession,
  onOpenBoth,
  minRows = 6,
  className,
}: {
  changes: Change[];
  sources: Record<string, LedgerSource>;
  onOpen: (c: Change) => void;
  /** Files two sessions both have pending edits to (lib/mission.ts `overlaps`): pinned on top. */
  overlaps?: Overlap[];
  /** Open a session (on that subagent, for a subagent's edit). */
  onOpenSession?: (e: OverlapEdit) => void;
  /** Open the two authors' sessions side by side. */
  onOpenBoth?: (edits: OverlapEdit[]) => void;
  minRows?: number;
  className?: string;
}) {
  const reduce = useMotion().reduce;
  const [opened, setOpened] = useState<string | null>(null);
  // One list of 36px rows: overlaps (and the open one's sessions), then the changes.
  const units: Unit[] = [
    ...overlaps.flatMap((o): Unit[] => [{ id: `ov:${o.file}`, ov: o }, ...(opened === o.file ? o.by.map((e) => ({ id: `ov:${o.file}:${authorOf(e)}`, ov: o, edit: e })) : [])]),
    ...changes.map((c) => ({ id: c.id, c })),
  ];
  // Rows that arrive after the first paint slide in; the first paint is still.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(units.map((u) => u.id));
  const fresh = new Set(units.filter((u) => !seen.current!.has(u.id)).map((u) => u.id));
  useEffect(() => {
    for (const id of fresh) seen.current!.add(id);
  });
  const count = changes.length + overlaps.length;

  return (
    <Card className={className} data-mc-ledger={changes.length} data-mc-overlaps={overlaps.length || undefined}>
      <CardHeader icon={IList} title="Changes" meta={count > 0 && count} />
      {units.length === 0 ? (
        <div className="flex h-[36px] items-center text-small text-faint" style={{ paddingLeft: TEXT_X }} data-mc-ledger-empty>
          No agent changes yet. Their edits show here until they're committed, with pushes and deploys.
        </div>
      ) : (
        <FitList
          total={units.length}
          minRows={minRows}
          title="Changes"
          render={(n) => (
            <AnimatePresence initial={false}>
              {units.slice(0, n).map((u) => (
                <motion.div
                  key={u.id}
                  initial={fresh.has(u.id) && !reduce ? { height: 0, opacity: 0 } : false}
                  animate={{ height: ROW, opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: reduce ? 0 : u.edit ? 0.2 : 0.32, ease }}
                  className="shrink-0 overflow-hidden"
                >
                  {u.c ? (
                    <Row c={u.c} src={sources[u.c.session]} fresh={fresh.has(u.id) && !reduce} onOpen={onOpen} />
                  ) : u.edit ? (
                    <OverlapEditRow e={u.edit} src={sources[u.edit.session]} label={authorLabel(u.edit, sources)} onOpen={() => onOpenSession?.(u.edit!)} />
                  ) : (
                    <OverlapRow
                      o={u.ov!}
                      sources={sources}
                      open={opened === u.ov!.file}
                      fresh={fresh.has(u.id) && !reduce}
                      onToggle={() => setOpened((f) => (f === u.ov!.file ? null : u.ov!.file))}
                      onOpenBoth={onOpenBoth ? () => onOpenBoth(u.ov!.by.slice(0, 2)) : undefined}
                    />
                  )}
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

/** "src/lib/stripe.ts" -> "stripe.ts" (the rest is in the tooltip). */
const base = (p: string) => p.split("/").pop() || p;
const shortTitle = (t: string) => (t.length > 28 ? t.slice(0, 27).trimEnd() + "…" : t);

/**
 * A file that two (or more) sessions both have pending edits to. Same copy: in the needs-you tone, "both
 * editing the same copy". Separate worktrees: neutral, "will need a merge". A click lists each session's
 * edit with Open; "Open both" puts the two side by side.
 */
function OverlapRow({ o, sources, open, fresh, onToggle, onOpenBoth }: { o: Overlap; sources: Record<string, LedgerSource>; open: boolean; fresh: boolean; onToggle: () => void; onOpenBoth?: () => void }) {
  const same = o.kind === "same";
  const names = o.by.map((e) => authorLabel(e, sources));
  const tip = same
    ? `${names.join(" and ")} both have uncommitted edits to ${o.file} in the same copy: one can overwrite the other. Open both and let one finish first.`
    : `${names.join(" and ")} both changed ${o.file} in separate worktrees: their branches will need a merge.`;
  return (
    // The whole row toggles (it highlights as one on hover), not only its text: its button's click (a pointer, or
    // Enter / Space) bubbles up to here; Open both stops its own.
    <div className={cx("group flex h-[36px] w-full cursor-default items-center gap-2.5 px-3.5 transition-colors duration-150 hover:bg-hover", fresh && "mc-fresh")} data-mc-overlap={o.kind} onClick={onToggle}>
      <button type="button" title={tip} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" data-mc-overlap-toggle>
        <Node className={same ? "text-needs-text" : "text-faint"}>
          <IOverlap size={14} />
        </Node>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 text-base text-fg">{o.by.length === 2 ? "Both editing" : `${o.by.length} editing`}</span>
          <span className="min-w-0 shrink truncate font-mono text-mono-small text-dim" title={o.file}>
            {o.file}
          </span>
          <span className={cx("min-w-0 shrink-[2] truncate text-small", same ? "text-needs-text" : "text-faint")}>
            {same ? "same copy" : "will need a merge"}
            {o.gapMs >= 1000 && <span className="text-faint"> · {compactSpan(o.gapMs)} apart</span>}
          </span>
        </span>
        <span className="flex shrink-0 items-center -space-x-0.5" aria-hidden>
          {o.by.slice(0, 3).map((e) => (sources[e.session] ? <ProviderMark key={authorOf(e)} provider={sources[e.session].provider} size={13} className="rounded-full bg-bg ring-2 ring-bg" /> : null))}
        </span>
      </button>
      {onOpenBoth && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenBoth();
          }}
          title={`Open ${names.slice(0, 2).map(shortTitle).join(" and ")} side by side`}
          className="hidden h-[24px] shrink-0 items-center gap-1 rounded-[7px] px-1.5 text-small text-dim transition-colors hover:bg-press hover:text-fg group-hover:flex focus-visible:flex"
          data-mc-open-both
        >
          Open both
        </button>
      )}
      <Age ms={o.ts} title={`${base(o.file)} last edited`} />
    </div>
  );
}

/** One session's pending edit to an overlapping file, under the overlap row: its title, +/−, its copy, Open. */
function OverlapEditRow({ e, src, label, onOpen }: { e: OverlapEdit; src?: LedgerSource; label: string; onOpen: () => void }) {
  const where = e.tree === "" ? "project checkout" : `worktree ${e.tree.includes("/") ? e.tree.split("/").pop() : e.tree}`;
  return (
    <button type="button" onClick={onOpen} className="group flex h-[36px] w-full items-center gap-2.5 px-3.5 text-left transition-colors duration-150 hover:bg-hover" data-mc-overlap-edit={e.session} title={`Open “${label}”`}>
      <Node>{src && <ProviderMark provider={src.provider} size={13} />}</Node>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="min-w-0 shrink truncate text-base text-fg">{label}</span>
        <span className="min-w-0 shrink-[2] truncate text-small text-faint">
          {e.times > 1 ? `${e.times} edits` : "1 edit"} · {where}
        </span>
      </span>
      {(!!e.added || !!e.removed) && (
        <span className="flex shrink-0 gap-1.5 font-mono text-mono-small tnum">
          {!!e.added && <span className="text-done-text">+{e.added}</span>}
          {!!e.removed && <span className="text-err-text">−{e.removed}</span>}
        </span>
      )}
      <span className="flex shrink-0 items-center gap-1 text-small text-dim transition-colors group-hover:text-fg">
        Open
        <IForward size={11} />
      </span>
      <Age ms={e.ts} />
    </button>
  );
}
