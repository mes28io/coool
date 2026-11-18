// Mission control's commit trail: the project's branch as a line of commits (newest on top), each
// merge curving out to the commits it brought in and back. The files a commit touched show as small
// chips. While an agent's `git commit` runs, a "Committing" row with a spinner sits on top; when git
// has the commit, the row settles into it. Data: `git_trail` (read-only, lib/gitTrail.ts).

import { AnimatePresence, motion } from "motion/react";
import { memo } from "react";
import { useClock } from "../lib/clock";
import { useMotion } from "../lib/motion";
import type { GitTrail, TrailCommit } from "../lib/types";
import { IBranch, IFile } from "./icons";
import { cx, ease, StatusDot } from "./primitives";
import { Skel } from "./Skeletons";
import { DOT, RAIL } from "./StepRail";

const MAIN_X = 9;
const SIDE_X = 23;
const GUTTER = 32;
/** Side-branch commits listed under a merge. */
const SIDE_SHOWN = 3;
/** Mainline rows listed. */
const MAIN_SHOWN = 7;

export interface Committing {
  /** The commit message, "" when the command has none on its line. */
  message: string;
  key: string;
}

type Row =
  | { key: string; kind: "committing"; c: Committing }
  | { key: string; kind: "main" | "merge"; commit: TrailCommit; first: boolean; last: boolean }
  | { key: string; kind: "side"; commit: TrailCommit; last: boolean }
  | { key: string; kind: "sidemore"; n: number };

function rows(t: GitTrail, committing: Committing | null): Row[] {
  const out: Row[] = [];
  if (committing) out.push({ key: `committing:${committing.key}`, kind: "committing", c: committing });
  const main = t.commits.slice(0, MAIN_SHOWN);
  main.forEach((c, i) => {
    const merge = c.merge && c.merge.commits.length > 0 ? c.merge : null;
    out.push({ key: c.sha, kind: merge ? "merge" : "main", commit: c, first: i === 0 && !committing, last: i === main.length - 1 && !t.more });
    if (merge) {
      const side = merge.commits.slice(0, SIDE_SHOWN);
      const more = merge.commits.length - side.length + merge.more;
      side.forEach((s, j) => out.push({ key: `${c.sha}>${s.sha}`, kind: "side", commit: s, last: j === side.length - 1 && more === 0 }));
      if (more > 0) out.push({ key: `${c.sha}>more`, kind: "sidemore", n: more });
    }
  });
  return out;
}

/** "26m", "3h", "2d": the trail's compact age. */
function age(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 30))}mo`;
}

const base = (p: string) => p.split("/").pop() || p;

export function CommitTrail({ trail, loading, committing, className }: { trail: GitTrail | null; loading: boolean; committing: Committing | null; className?: string }) {
  const reduce = useMotion().reduce;
  const list = trail ? rows(trail, committing) : [];
  const n = trail ? trail.commits.length : 0;
  return (
    <section className={cx("overflow-hidden rounded-[14px] border border-hairline bg-bg", className)} data-mc-trail={n}>
      <header className="flex h-[40px] items-center gap-2 px-3.5">
        <IBranch size={14} className="shrink-0 text-dim" />
        {trail ? (
          <>
            <span className="min-w-0 truncate font-mono text-mono-base font-medium text-fg" title={trail.root}>
              {trail.branch ?? (trail.head ? trail.head.slice(0, 7) : "no commits")}
            </span>
            {!trail.branch && trail.head && <span className="shrink-0 text-small text-faint">detached</span>}
            {!!trail.uncommitted && (
              <span className="shrink-0 rounded-full border border-hairline px-1.5 text-small text-dim tnum" title="Files with changes not committed yet">
                {trail.uncommitted} uncommitted
              </span>
            )}
            <span className="ml-auto shrink-0 text-small text-faint tnum">{trail.more ? `latest ${Math.min(n, MAIN_SHOWN)}` : `${n} ${n === 1 ? "commit" : "commits"}`}</span>
          </>
        ) : (
          <Skel w={96} h={10} />
        )}
      </header>
      <div className="border-t border-hairline px-2 py-1.5">
        {!trail && loading ? (
          <TrailSkeleton />
        ) : trail && n === 0 && !committing ? (
          <div className="flex h-[40px] items-center px-1.5 text-small text-faint">No commits on this branch yet.</div>
        ) : (
          <ol>
            <AnimatePresence initial={false}>
              {list.map((r) => (
                <motion.li
                  key={r.key}
                  layout={reduce ? false : "position"}
                  initial={reduce ? false : { height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }}
                  transition={{ duration: reduce ? 0 : 0.34, ease }}
                  className="overflow-hidden"
                >
                  <TrailRow r={r} branch={trail?.branch ?? null} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
        )}
      </div>
    </section>
  );
}

const TrailRow = memo(function TrailRow({ r, branch }: { r: Row; branch: string | null }) {
  const now = useClock((t) => Math.floor(t / 30_000) * 30_000);
  if (r.kind === "committing") {
    return (
      <div className="flex h-[34px] items-center" data-mc-committing>
        <Gutter h={34} kind="committing" />
        <span className="min-w-0 flex-1 truncate text-base text-fg">{r.c.message || "Committing changes"}</span>
        <span className="ml-2 shrink-0 text-small font-medium text-running-text">Committing</span>
      </div>
    );
  }
  if (r.kind === "sidemore") {
    return (
      <div className="flex h-[24px] items-center">
        <Gutter h={24} kind="side" last />
        <span className="pl-3 text-small text-faint">+{r.n} more on the branch</span>
      </div>
    );
  }
  const c = r.commit;
  if (r.kind === "side") {
    return (
      <div className="flex h-[26px] items-center" title={`${c.short} · ${c.author}`}>
        <Gutter h={26} kind="side" last={r.last} />
        <span className="min-w-0 flex-1 truncate pl-3 text-small text-dim">{c.subject}</span>
        {c.files[0] && <FileChip path={c.files[0]} more={c.files.length - 1 + c.files_more} small />}
        <span className="ml-2 w-[30px] shrink-0 text-right text-small text-faint tnum">{age(c.time_ms, now)}</span>
      </div>
    );
  }
  const merge = r.kind === "merge" ? c.merge : null;
  const refs = c.refs.filter((x) => x !== branch && !x.endsWith(`/${branch}`)).slice(0, 1);
  const subject = merge ? c.subject.replace(/^Merge( branch '[^']*'( into \S+)?|:)\s*/, "") : c.subject;
  return (
    <div className="flex h-[34px] items-center" title={`${c.short} · ${c.author}`}>
      <Gutter h={34} kind={r.kind} first={r.first} last={r.last} />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {merge ? (
          <>
            <span className="shrink-0 text-base font-medium text-fg">Merged</span>
            {merge.from && (
              <span className="flex min-w-0 max-w-[45%] shrink items-center gap-1 rounded-[6px] border border-hairline bg-panel px-1.5 font-mono text-mono-small text-dim">
                <IBranch size={10} className="shrink-0" />
                <span className="truncate">{merge.from}</span>
              </span>
            )}
            {subject && <span className="min-w-0 truncate text-base text-dim">{subject}</span>}
          </>
        ) : (
          <>
            <span className="min-w-0 truncate text-base text-fg/90">{subject}</span>
            {c.files[0] && <FileChip path={c.files[0]} more={c.files.length - 1 + c.files_more} />}
          </>
        )}
      </span>
      {refs.map((x) => (
        <span key={x} className="ml-2 max-w-[96px] shrink-0 truncate rounded-full border border-hairline px-1.5 font-mono text-micro text-faint" title={x}>
          {x}
        </span>
      ))}
      <span className="ml-2 w-[30px] shrink-0 text-right text-small text-faint tnum">{age(c.time_ms, now)}</span>
    </div>
  );
});

function FileChip({ path, more, small }: { path: string; more: number; small?: boolean }) {
  return (
    <span className="ml-1.5 flex min-w-0 max-w-[40%] shrink items-center gap-1" title={path}>
      <span className={cx("flex min-w-0 items-center gap-1 rounded-[6px] border border-hairline bg-panel px-1.5 font-mono text-dim", small ? "text-micro" : "text-mono-small")}>
        <IFile size={10} className="shrink-0 text-faint" />
        <span className="truncate">{base(path)}</span>
      </span>
      {more > 0 && <span className="shrink-0 text-small text-faint tnum">+{more}</span>}
    </span>
  );
}

/** The graph for one row: the main line, the side lane, and the curves between them. */
function Gutter({ h, kind, first, last }: { h: number; kind: "committing" | "main" | "merge" | "side"; first?: boolean; last?: boolean }) {
  const cy = h / 2;
  const line = { stroke: RAIL, strokeWidth: 1.5, fill: "none", strokeLinecap: "round" as const };
  return (
    <span className="relative shrink-0 self-stretch" style={{ width: GUTTER }} aria-hidden>
      <svg width={GUTTER} height={h} className="absolute inset-0 overflow-visible">
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
      {kind === "committing" && (
        <span className="absolute" style={{ left: MAIN_X - 4, top: cy - 4 }}>
          <StatusDot status="busy" size={8} />
        </span>
      )}
    </span>
  );
}

function TrailSkeleton() {
  return (
    <div>
      {[150, 190, 120, 170].map((w, i) => (
        <div key={i} className="flex h-[34px] items-center">
          <span className="flex shrink-0 justify-start" style={{ width: GUTTER, paddingLeft: MAIN_X - 4 }}>
            <Skel w={8} h={8} i={i} />
          </span>
          <Skel w={w} h={9} i={i} />
          <Skel w={22} h={9} i={i} className="ml-auto" />
        </div>
      ))}
    </div>
  );
}
