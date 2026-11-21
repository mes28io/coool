// A file's diff as coool draws it: hunks of numbered lines, syntax coloured (lib/attachRules.ts `colorize`), the
// changed words inside a changed line marked (lib/mission.ts `wordDiff`, as InlineDiff does), the unchanged lines
// between hunks folded behind "Show N unchanged lines". Unified, or side by side when the pane is wide enough.
// Used by the Changes panel (ChangesPanel.tsx) and for a pending edit in a permission request (InlineDiff.tsx).

import { memo, useMemo, useState, type ReactNode } from "react";
import { colorize, type Tok } from "../lib/attachRules";
import { gaps, partners, splitRows, textLines, type DiffLine, type FileChange, type HunkView } from "../lib/changesRules";
import { wordDiff } from "../lib/mission";
import { cx } from "./primitives";

const TOK: Record<string, React.CSSProperties> = {
  kw: { color: "var(--ctx-file)" },
  str: { color: "var(--ctx-summary)" },
  num: { color: "var(--ctx-tool)" },
  com: { color: "var(--faint)", fontStyle: "italic" },
};

const ROW_BG = {
  "-": "bg-[color-mix(in_oklab,var(--error)_9%,transparent)]",
  "+": "bg-[color-mix(in_oklab,var(--status-done)_10%,transparent)]",
  " ": "",
} as const;
const WORD_BG = {
  "-": "rounded-[2px] bg-[color-mix(in_oklab,var(--error)_26%,transparent)]",
  "+": "rounded-[2px] bg-[color-mix(in_oklab,var(--status-done)_28%,transparent)]",
} as const;
const SIGN_TX = { "-": "text-err-text", "+": "text-done-text", " ": "text-faint" } as const;

function Toks({ toks }: { toks: Tok[] }) {
  return (
    <>
      {toks.map((t, k) => (
        <span key={k} style={t.k ? TOK[t.k] : undefined}>
          {t.t}
        </span>
      ))}
    </>
  );
}

/** One line's code: syntax coloured, and with its partner (the line it replaced or was replaced by) the changed words marked. */
function Code({ line, partner, toks, name }: { line: DiffLine; partner: DiffLine | null; toks: Tok[]; name: string }) {
  if (!partner || line.k === " ") return <Toks toks={toks} />;
  const parts = line.k === "-" ? wordDiff(line.t, partner.t) : wordDiff(partner.t, line.t);
  const mine = line.k === "-" ? "del" : "add";
  return (
    <>
      {parts
        .filter((p) => p.op === "same" || p.op === mine)
        .map((p, k) => {
          const inner = <Toks toks={colorize(p.text, name)[0] ?? []} />;
          return p.op === "same" ? <span key={k}>{inner}</span> : <span key={k} className={WORD_BG[line.k as "-" | "+"]}>{inner}</span>;
        })}
    </>
  );
}

const num = "select-none px-1.5 text-right tnum text-faint/80";

/** Lines of one hunk, unified. */
const UnifiedHunk = memo(function UnifiedHunk({ h, name, wide }: { h: HunkView; name: string; wide: number }) {
  const toks = useMemo(() => colorize(h.lines.map((l) => l.t).join("\n"), name), [h, name]);
  const pair = useMemo(() => partners(h.lines), [h]);
  return (
    <>
      {h.lines.map((l, i) => (
        <div key={i} className={cx("grid", ROW_BG[l.k])} style={{ gridTemplateColumns: `${wide}ch ${wide}ch 1.6ch minmax(0,1fr)` }} data-diff-line={l.k === " " ? "ctx" : l.k === "-" ? "del" : "add"}>
          <span className={num}>{l.o ?? ""}</span>
          <span className={num}>{l.n ?? ""}</span>
          <span className={cx("select-none text-center", SIGN_TX[l.k])}>{l.k === " " ? "" : l.k === "-" ? "−" : "+"}</span>
          <span className="whitespace-pre-wrap break-all pr-3 text-fg/90">
            <Code line={l} partner={pair[i] >= 0 ? h.lines[pair[i]] : null} toks={toks[i] ?? []} name={name} />
            {l.noeol && <span className="ml-1 select-none text-faint" title="No newline at end of file">⏎̸</span>}
          </span>
        </div>
      ))}
    </>
  );
});

/** Lines of one hunk, side by side. */
const SplitHunk = memo(function SplitHunk({ h, name, wide }: { h: HunkView; name: string; wide: number }) {
  const rows = useMemo(() => splitRows(h.lines), [h]);
  const cell = (l: DiffLine | null, other: DiffLine | null, side: "-" | "+") => {
    if (!l) return [<span key="n" className={cx(num, "bg-[color-mix(in_oklab,var(--dim)_6%,transparent)]")} />, <span key="c" className="bg-[color-mix(in_oklab,var(--dim)_6%,transparent)]" />];
    const k = l.k === " " ? " " : side;
    return [
      <span key="n" className={cx(num, ROW_BG[k])}>
        {side === "-" ? l.o : l.n}
      </span>,
      <span key="c" className={cx("whitespace-pre-wrap break-all pr-3 text-fg/90", ROW_BG[k])}>
        <Code line={l} partner={l.k !== " " && other && other.k !== " " ? other : null} toks={colorize(l.t, name)[0] ?? []} name={name} />
      </span>,
    ];
  };
  return (
    <>
      {rows.map((r, i) => (
        <div key={i} className="grid" style={{ gridTemplateColumns: `${wide}ch minmax(0,1fr) ${wide}ch minmax(0,1fr)` }} data-diff-row>
          {cell(r.left, r.right, "-")}
          {cell(r.right, r.left, "+")}
        </div>
      ))}
    </>
  );
});

/** Unchanged lines, folded until asked for (from the file's text, new side). */
function Gap({ range, text, name, wide, split, offset, edge }: { range: [number, number]; text: string[] | null; name: string; wide: number; split: boolean; offset: number; edge: "top" | "mid" | "end" }) {
  const [open, setOpen] = useState(false);
  const count = range[1] - range[0] + 1;
  if (!text) return edge === "mid" ? <div className="h-px bg-hairline" /> : null;
  // Small gaps aren't worth a click.
  if (!open && count > 4) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 bg-[color-mix(in_oklab,var(--dim)_6%,transparent)] px-2 py-[3px] text-left font-sans text-small text-faint transition-colors hover:bg-hover hover:text-dim"
        data-diff-gap={count}
      >
        <span className="tnum">⋯</span>
        Show {count} unchanged {count === 1 ? "line" : "lines"}
      </button>
    );
  }
  const lines = text.slice(range[0] - 1, range[1]);
  return (
    <>
      {lines.map((t, i) => {
        const n = range[0] + i;
        const toks = colorize(t, name)[0] ?? [];
        return split ? (
          <div key={i} className="grid opacity-80" style={{ gridTemplateColumns: `${wide}ch minmax(0,1fr) ${wide}ch minmax(0,1fr)` }}>
            <span className={num}>{n - offset}</span>
            <span className="whitespace-pre-wrap break-all pr-3 text-fg/80"><Toks toks={toks} /></span>
            <span className={num}>{n}</span>
            <span className="whitespace-pre-wrap break-all pr-3 text-fg/80"><Toks toks={toks} /></span>
          </div>
        ) : (
          <div key={i} className="grid opacity-80" style={{ gridTemplateColumns: `${wide}ch ${wide}ch 1.6ch minmax(0,1fr)` }}>
            <span className={num}>{n - offset}</span>
            <span className={num}>{n}</span>
            <span />
            <span className="whitespace-pre-wrap break-all pr-3 text-fg/80"><Toks toks={toks} /></span>
          </div>
        );
      })}
    </>
  );
}

export interface HunkSlots {
  /** Above a hunk: its header row's right side (Keep / Undo buttons). */
  actions?: (h: HunkView, i: number) => ReactNode;
  /** Under a hunk: a question about it (Undo anyway?). */
  below?: (h: HunkView, i: number) => ReactNode;
  /** The hunk the keyboard is on. */
  focused?: number | null;
}

/** A file's hunks. `split`: side by side. Kept hunks fold to one line (`foldKept`). */
export function DiffBody({ file, split, slots, foldKept }: { file: Pick<FileChange, "rel" | "hunks" | "text" | "status">; split: boolean; slots?: HunkSlots; foldKept?: boolean }) {
  const name = file.rel.split("/").pop() ?? file.rel;
  // A new or deleted file is all one hunk: nothing unchanged around it.
  const whole = file.status === "added" || file.status === "deleted";
  const text = useMemo(() => (file.text != null && !whole ? textLines(file.text) : null), [file.text, whole]);
  const g = useMemo(() => gaps(file.hunks, text ? text.length : null), [file.hunks, text]);
  const maxN = file.hunks.reduce((m, h) => Math.max(m, h.old_start + h.old_count, h.new_start + h.new_count), text?.length ?? 0);
  const wide = Math.max(4, String(maxN).length + 2);
  const [unfold, setUnfold] = useState<Set<string>>(new Set());
  return (
    <div className="font-mono text-mono-small leading-[19px]" data-diff-body={file.rel}>
      {file.hunks.map((h, i) => {
        const before = g.before[i];
        // Old = new - offset for the unchanged lines before this hunk.
        const offset = h.new_start - h.old_start;
        const folded = foldKept && h.kept && !unfold.has(h.id);
        const first = h.lines.find((l) => l.k !== " ");
        return (
          <div key={h.id + i} data-hunk={h.id} data-hunk-index={i} data-hunk-kept={h.kept || undefined} data-hunk-since={h.since || undefined}>
            {before && !whole && <Gap range={before} text={text} name={name} wide={wide} split={split} offset={offset} edge={i === 0 ? "top" : "mid"} />}
            <div
              className={cx(
                "group/h sticky top-0 z-[1] flex min-h-[26px] items-center gap-2 border-y border-hairline bg-panel px-2 font-sans text-small",
                slots?.focused === i && "shadow-[inset_2px_0_0_var(--text)]",
                h.since && "bg-[color-mix(in_oklab,var(--status-needs)_8%,var(--panel))]",
              )}
              data-hunk-head
            >
              <span className="font-mono text-mono-small text-faint tnum">
                {h.old_count || h.new_count ? `Line ${first?.n ?? first?.o ?? h.new_start}` : ""}
              </span>
              <span className="flex shrink-0 gap-1 font-mono text-mono-small tnum">
                {h.added > 0 && <span className="text-done-text">+{h.added}</span>}
                {h.removed > 0 && <span className="text-err-text">−{h.removed}</span>}
              </span>
              {h.since && <span className="truncate text-needs-text" title="Lines here changed after the agent's edit (by you, or another tool)">Edited since</span>}
              {h.kept && (
                <button type="button" className="truncate text-faint hover:text-dim" onClick={() => setUnfold((s) => new Set(s).add(h.id))} disabled={!folded}>
                  {folded ? "Kept · show" : "Kept"}
                </button>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-1">{slots?.actions?.(h, i)}</span>
            </div>
            {!folded && (split ? <SplitHunk h={h} name={name} wide={wide} /> : <UnifiedHunk h={h} name={name} wide={wide} />)}
            {slots?.below?.(h, i)}
          </div>
        );
      })}
      {g.after && !whole && file.hunks.length > 0 && <Gap range={g.after} text={text} name={name} wide={wide} split={split} offset={file.hunks[file.hunks.length - 1].new_start + file.hunks[file.hunks.length - 1].new_count - (file.hunks[file.hunks.length - 1].old_start + file.hunks[file.hunks.length - 1].old_count)} edge="end" />}
    </div>
  );
}

/** "A", "M", "D", "R" in a small tinted square. */
export function StatusMark({ status }: { status: FileChange["status"] }) {
  const m: Record<string, [string, string, string]> = {
    added: ["A", "text-done-text", "bg-[color-mix(in_oklab,var(--status-done)_14%,transparent)]"],
    modified: ["M", "text-dim", "bg-[color-mix(in_oklab,var(--dim)_14%,transparent)]"],
    deleted: ["D", "text-err-text", "bg-[color-mix(in_oklab,var(--error)_14%,transparent)]"],
    renamed: ["R", "text-dim", "bg-[color-mix(in_oklab,var(--dim)_14%,transparent)]"],
    undone: ["↺", "text-faint", "bg-[color-mix(in_oklab,var(--dim)_10%,transparent)]"],
    unchanged: ["=", "text-faint", "bg-[color-mix(in_oklab,var(--dim)_10%,transparent)]"],
  };
  const [l, tx, bg] = m[status] ?? m.modified;
  return (
    <span className={cx("inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] font-mono text-[10.5px] font-semibold", tx, bg)} title={status} data-file-status={status}>
      {l}
    </span>
  );
}
