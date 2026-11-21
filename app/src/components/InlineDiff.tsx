// A pending edit: the agent asks to change a file (a permission request in a coool chat). It shows as the diff it
// would make on the file as it is now, with context (`changes_preview`, drawn by DiffView.tsx like the Changes panel),
// or, when the file can't be read that way, as prose with the removed words struck and the added ones marked.
// Allow / Deny answer the request; it is one decision for the whole edit, as the CLI asks it.

import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/backend";
import type { FileChange } from "../lib/changesRules";
import { lineCounts, relPath, wordDiff } from "../lib/mission";
import { DiffBody } from "./DiffView";
import { IFile } from "./icons";
import { Button, cx } from "./primitives";

/** old/new pairs of an Edit / MultiEdit request (a Write: its whole content as new), or null when the request isn't a text edit. */
export function editPairs(tool: string, input: unknown): { path: string; pairs: [string, string][] } | null {
  if (!/^(edit|multiedit|write)$/i.test(tool) || !input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const path = typeof i.file_path === "string" ? i.file_path : "";
  if (/^write$/i.test(tool)) return path && typeof i.content === "string" ? { path, pairs: [["", i.content]] } : null;
  const pairs: [string, string][] = Array.isArray(i.edits)
    ? (i.edits as { old_string?: unknown; new_string?: unknown }[]).map((e) => [String(e.old_string ?? ""), String(e.new_string ?? "")])
    : typeof i.old_string === "string" && typeof i.new_string === "string"
      ? [[i.old_string, i.new_string]]
      : [];
  return path && pairs.length ? { path, pairs } : null;
}

/** The request as `changes_preview` takes it. */
export interface PreviewReq {
  tool: string;
  input: unknown;
}

/**
 * Without `onAllow` / `onDeny` it is the diff alone (the Needs you page puts the answer below it); `tall` lets it
 * grow. `preview`: the request itself, for the full-context diff.
 */
export function InlineDiff({ path, pairs, root, onAllow, onDeny, tall, preview }: { path: string; pairs: [string, string][]; root: string; onAllow?: () => void; onDeny?: () => void; tall?: boolean; preview?: PreviewReq }) {
  const [full, setFull] = useState<FileChange | null>(null);
  const key = preview ? JSON.stringify([root, preview.tool, preview.input]) : "";
  useEffect(() => {
    setFull(null);
    if (!preview || !root) return;
    let gone = false;
    api()
      .changesPreview(root, preview.tool, preview.input)
      .then((fs) => {
        const f = fs.find((x) => x.hunks.length > 0);
        if (!gone && f) setFull(f);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const parts = useMemo(() => pairs.map(([a, b]) => wordDiff(a, b)), [pairs]);
  const counts = useMemo(
    () =>
      full
        ? { added: full.added, removed: full.removed }
        : pairs.reduce(
            (n, [a, b]) => {
              const c = lineCounts(a, b);
              return { added: n.added + c.added, removed: n.removed + c.removed };
            },
            { added: 0, removed: 0 },
          ),
    [pairs, full],
  );
  return (
    <div className="mt-2.5 overflow-hidden rounded-[10px] border border-hairline bg-panel" data-mc-diff data-diff-preview={full ? "full" : "prose"}>
      <div className="flex h-[30px] items-center gap-1.5 border-b border-hairline px-2.5 text-small">
        <IFile size={12} className="shrink-0 text-faint" />
        <span className="min-w-0 truncate font-mono text-mono-small text-dim" title={path}>
          {relPath(path, root)}
        </span>
        {full?.status === "added" && <span className="shrink-0 rounded-[5px] bg-[color-mix(in_oklab,var(--status-done)_13%,transparent)] px-1.5 text-[11px] font-medium text-done-text">new file</span>}
        <span className="ml-auto flex shrink-0 gap-1.5 font-mono text-mono-small tnum">
          {counts.added > 0 && <span className="text-done-text">+{counts.added}</span>}
          {counts.removed > 0 && <span className="text-err-text">−{counts.removed}</span>}
        </span>
      </div>
      {full ? (
        <div className={cx("scroll selectable overflow-y-auto bg-bg", tall ? "max-h-[min(560px,58vh)]" : "max-h-[260px]")}>
          {full.said && <div className="border-b border-hairline px-2.5 py-1.5 text-small text-dim">{full.said}</div>}
          <DiffBody file={full} split={false} />
        </div>
      ) : (
        <div className={cx("scroll selectable overflow-y-auto px-2.5 py-2 font-mono text-mono-small text-dim", tall ? "max-h-[min(520px,55vh)]" : "max-h-[168px]")}>
          {parts.map((p, k) => (
            <div key={k} className={cx("whitespace-pre-wrap break-words", k > 0 && "mt-2 border-t border-dashed border-hairline pt-2")}>
              {p.map((s, j) =>
                s.op === "same" ? (
                  <span key={j}>{s.text}</span>
                ) : s.op === "del" ? (
                  <del key={j} className="rounded-[3px] bg-[color-mix(in_oklab,var(--error)_14%,transparent)] text-err-text decoration-[color-mix(in_oklab,var(--error)_70%,transparent)]">
                    {s.text}
                  </del>
                ) : (
                  <ins key={j} className="rounded-[3px] bg-[color-mix(in_oklab,var(--status-done)_16%,transparent)] text-done-text no-underline">
                    {s.text}
                  </ins>
                ),
              )}
            </div>
          ))}
        </div>
      )}
      {onAllow && onDeny && (
        <div className="flex items-center justify-end gap-1.5 border-t border-hairline px-2 py-1.5">
          <Button variant="ghost" className="h-[28px] px-2.5 text-small" onClick={onDeny} data-mc-deny>
            Deny
          </Button>
          <Button variant="primary" className="h-[28px] px-3 text-small" onClick={onAllow} data-mc-allow>
            Allow edit
          </Button>
        </div>
      )}
    </div>
  );
}
