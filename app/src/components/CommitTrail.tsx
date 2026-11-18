// Mission control's commit trail: the project's branch as a line of commits (newest on top), each
// merge curving out to the commits it brought in and back. It owns the project's git history (the
// ledger leaves commits and merges to it). While an agent's `git commit` runs, a "Committing" row with
// a spinner sits on top; when git has the commit, the row settles into it. Rows are on the card system
// of MissionCard.tsx: 36px, the graph in the node column. Data: `git_trail` (lib/gitTrail.ts).

import { AnimatePresence, motion } from "motion/react";
import { memo } from "react";
import { useMotion } from "../lib/motion";
import type { GitTrail, TrailCommit } from "../lib/types";
import { IBranch } from "./icons";
import { Age, Card, CardHeader, FitList, Node, PAD, ROW, TEXT_X } from "./MissionCard";
import { cx, ease, StatusDot } from "./primitives";
import { Skel } from "./Skeletons";
import { DOT, RAIL } from "./StepRail";

/** The graph's lanes, from the card's left edge: the main line at the node column's centre, the side lane one step right. */
const MAIN_X = PAD + 8;
const SIDE_X = MAIN_X + 14;
/** Side-branch commits listed under a merge (the rest are counted on the merge row). */
const SIDE_SHOWN = 2;

export interface Committing {
  /** The commit message, "" when the command has none on its line. */
  message: string;
  key: string;
}

type Row =
  | { key: string; kind: "committing"; c: Committing }
  | { key: string; kind: "main" | "merge"; commit: TrailCommit; first: boolean; last: boolean; hidden: number }
  | { key: string; kind: "side"; commit: TrailCommit; last: boolean };

function rows(t: GitTrail, committing: Committing | null): Row[] {
  const out: Row[] = [];
  if (committing) out.push({ key: `committing:${committing.key}`, kind: "committing", c: committing });
  t.commits.forEach((c, i) => {
    const merge = c.merge && c.merge.commits.length > 0 ? c.merge : null;
    const side = merge ? merge.commits.slice(0, SIDE_SHOWN) : [];
    const hidden = merge ? merge.commits.length - side.length + merge.more : 0;
    out.push({ key: c.sha, kind: merge ? "merge" : "main", commit: c, first: i === 0 && !committing, last: i === t.commits.length - 1 && !t.more, hidden });
    side.forEach((s, j) => out.push({ key: `${c.sha}>${s.sha}`, kind: "side", commit: s, last: j === side.length - 1 }));
  });
  return out;
}

const base = (p: string) => p.split("/").pop() || p;

export function CommitTrail({ trail, loading, committing, minRows = 8, className }: { trail: GitTrail | null; loading: boolean; committing: Committing | null; minRows?: number; className?: string }) {
  const reduce = useMotion().reduce;
  const list = trail ? rows(trail, committing) : [];
  const n = trail ? trail.commits.length : 0;
  const meta = trail ? (trail.uncommitted ? <span title="Files with changes not committed yet">{trail.uncommitted} uncommitted</span> : !trail.branch && trail.head ? "detached" : null) : null;
  return (
    <Card className={className} data-mc-trail={n}>
      <CardHeader icon={IBranch} mono title={trail ? (trail.branch ?? (trail.head ? trail.head.slice(0, 7) : "no commits")) : <Skel w={96} h={10} />} meta={meta} />
      {!trail && loading ? (
        <TrailSkeleton />
      ) : trail && n === 0 && !committing ? (
        <div className="flex h-[36px] items-center text-small text-faint" style={{ paddingLeft: TEXT_X }}>
          No commits on this branch yet.
        </div>
      ) : (
        <FitList
          total={list.length}
          minRows={minRows}
          render={(count) => (
            <ol className="shrink-0">
              <AnimatePresence initial={false}>
                {list.slice(0, count).map((r, i) => (
                  <motion.li
                    key={r.key}
                    layout={reduce ? false : "position"}
                    initial={reduce ? false : { height: 0, opacity: 0 }}
                    animate={{ height: ROW, opacity: 1 }}
                    exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }}
                    transition={{ duration: reduce ? 0 : 0.34, ease }}
                    className="overflow-hidden"
                  >
                    {/* The last row shown keeps its line running down when more rows follow. */}
                    <TrailRow r={r} branch={trail?.branch ?? null} cut={i === count - 1 && count < list.length} />
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
          )}
        />
      )}
    </Card>
  );
}

const TrailRow = memo(function TrailRow({ r, branch, cut }: { r: Row; branch: string | null; cut: boolean }) {
  if (r.kind === "committing") {
    return (
      <div className="relative flex h-[36px] items-center gap-2.5 px-3.5" data-mc-committing>
        <Gutter kind="committing" />
        <Node>
          <StatusDot status="busy" size={8} />
        </Node>
        <span className="min-w-0 flex-1 truncate text-base text-fg">{r.c.message || "Committing changes"}</span>
        <span className="shrink-0 text-small text-running-text">Committing</span>
      </div>
    );
  }
  const c = r.commit;
  if (r.kind === "side") {
    return (
      <div className="relative flex h-[36px] items-center gap-2.5 px-3.5" title={`${c.short} · ${c.author}`}>
        <Gutter kind="side" last={r.last && !cut} />
        <Node />
        <span className="min-w-0 flex-1 truncate pl-[14px] text-small text-dim">{c.subject}</span>
        <Files c={c} />
        <Age ms={c.time_ms} />
      </div>
    );
  }
  const merge = r.kind === "merge" ? c.merge : null;
  const refs = c.refs.filter((x) => x !== branch && !x.endsWith(`/${branch}`)).slice(0, 1);
  const subject = merge ? c.subject.replace(/^Merge( branch '[^']*'( into \S+)?|:)\s*/, "") || "Merged" : c.subject;
  return (
    <div className="relative flex h-[36px] items-center gap-2.5 px-3.5" title={`${c.short} · ${c.author}${merge?.from ? ` · merged ${merge.from}` : ""}`}>
      <Gutter kind={r.kind} first={r.first} last={r.last && !cut} />
      <Node />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="min-w-0 shrink truncate text-base text-fg">{subject}</span>
        {merge ? (
          <>
            {merge.from && subject === "Merged" && <span className="min-w-0 shrink-[2] truncate font-mono text-mono-small text-dim">{merge.from}</span>}
            {r.hidden > 0 && <span className="shrink-0 text-small text-faint tnum">+{r.hidden}</span>}
          </>
        ) : null}
      </span>
      {!merge && <Files c={c} />}
      {refs.map((x) => (
        <span key={x} className="max-w-[96px] shrink-0 truncate font-mono text-mono-small text-faint" title={x}>
          {x}
        </span>
      ))}
      <Age ms={c.time_ms} />
    </div>
  );
});

/** The first file a commit touched (mono, like every path on the page) and how many more. */
function Files({ c }: { c: TrailCommit }) {
  if (!c.files[0]) return null;
  const more = c.files.length - 1 + c.files_more;
  return (
    <span className="flex min-w-0 max-w-[38%] shrink items-baseline gap-1" title={c.files.join("\n")}>
      <span className="min-w-0 truncate font-mono text-mono-small text-dim">{base(c.files[0])}</span>
      {more > 0 && <span className="shrink-0 text-small text-faint tnum">+{more}</span>}
    </span>
  );
}

/** The graph for one row, drawn under the node column: the main line, the side lane, and the curves between them. */
function Gutter({ kind, first, last }: { kind: "committing" | "main" | "merge" | "side"; first?: boolean; last?: boolean }) {
  const h = ROW;
  const cy = h / 2;
  const line = { stroke: RAIL, strokeWidth: 1.5, fill: "none", strokeLinecap: "round" as const };
  return (
    <svg width={SIDE_X + 8} height={h} className="pointer-events-none absolute left-0 top-0 overflow-visible" aria-hidden>
      {kind === "committing" ? (
        <path d={`M${MAIN_X} ${cy + 7} V${h}`} {...line} strokeDasharray="2 3" />
      ) : kind === "side" ? (
        <>
          <path d={`M${MAIN_X} 0 V${h}`} {...line} />
          {last ? <path d={`M${SIDE_X} 0 V${cy} C${SIDE_X} ${cy + 9}, ${MAIN_X} ${h - 7}, ${MAIN_X} ${h}`} {...line} /> : <path d={`M${SIDE_X} 0 V${h}`} {...line} />}
          <circle cx={SIDE_X} cy={cy} r={2.75} fill="var(--bg)" stroke={DOT} strokeWidth={1.5} />
        </>
      ) : (
        <>
          <path d={`M${MAIN_X} ${first ? cy : 0} V${last ? cy : h}`} {...line} />
          {kind === "merge" && <path d={`M${MAIN_X} ${cy} C${MAIN_X} ${cy + 9}, ${SIDE_X} ${h - 7}, ${SIDE_X} ${h}`} {...line} />}
          <circle cx={MAIN_X} cy={cy} r={first ? 4 : 3.5} fill="var(--bg)" stroke={first ? "var(--text)" : "var(--faint)"} strokeWidth={1.5} />
          {kind === "merge" && <circle cx={MAIN_X} cy={cy} r={1.25} fill="var(--faint)" />}
        </>
      )}
    </svg>
  );
}

function TrailSkeleton() {
  return (
    <div>
      {[150, 190, 120, 170].map((w, i) => (
        <div key={i} className={cx("flex h-[36px] items-center gap-2.5 px-3.5")}>
          <Node>
            <Skel w={8} h={8} i={i} />
          </Node>
          <Skel w={w} h={9} i={i} />
          <Skel w={22} h={9} i={i} className="ml-auto" />
        </div>
      ))}
    </div>
  );
}
