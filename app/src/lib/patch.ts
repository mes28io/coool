// A Codex patch (its `apply_patch` request in a coool chat) read for the approval card, the Needs you page and the
// Risky rule. The Codex chat backend (crates/core/src/chat/codex.rs, `patch_input`) sends
// `{ files: [absolute paths], changes: [{ path, kind: "add" | "delete" | "update", move_path?, diff }] }`: an update's
// `diff` is a unified diff, an added or deleted file's is its content. Pure: unit-tested in patch.test.ts.

export interface PatchFile {
  path: string;
  kind: "add" | "delete" | "update";
  movePath: string | null;
  diff: string;
}

/** The files of a patch request, or null when the input isn't one. */
export function patchFiles(input: unknown): PatchFile[] | null {
  const c = input && typeof input === "object" ? (input as { changes?: unknown }).changes : null;
  if (!Array.isArray(c) || !c.length) return null;
  const out: PatchFile[] = [];
  for (const x of c as Record<string, unknown>[]) {
    if (!x || typeof x.path !== "string") continue;
    const k = typeof x.kind === "string" ? x.kind : typeof (x.kind as { type?: unknown } | null)?.type === "string" ? (x.kind as { type: string }).type : "update";
    out.push({
      path: x.path,
      kind: k === "add" || k === "delete" ? k : "update",
      movePath: typeof x.move_path === "string" ? x.move_path : null,
      diff: typeof x.diff === "string" ? x.diff : "",
    });
  }
  return out.length ? out : null;
}

/** An added file's text: a content diff (`+` on every line, as some versions send it) loses its markers. */
function plain(text: string): string {
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length && lines.every((l) => l.startsWith("+")) && !/^\+\+\+ /.test(lines[0])) return lines.map((l) => l.slice(1)).join("\n");
  return text.replace(/\n$/, "");
}

/**
 * old/new text pairs for the word diff (components/InlineDiff.tsx): one pair per hunk of an update (context lines on
 * both sides), the whole text for an added (new only) or deleted (old only) file.
 */
export function patchPairs(f: PatchFile): [string, string][] {
  if (f.kind === "add") return [["", plain(f.diff)]];
  if (f.kind === "delete") return [[plain(f.diff), ""]];
  const pairs: [string, string][] = [];
  let a: string[] | null = null;
  let b: string[] = [];
  const flush = () => {
    if (a && (a.length || b.length)) pairs.push([a.join("\n"), b.join("\n")]);
  };
  for (const l of f.diff.split("\n")) {
    if (l.startsWith("@@")) {
      flush();
      a = [];
      b = [];
      continue;
    }
    if (l.startsWith("--- ") || l.startsWith("+++ ") || l.startsWith("\\")) continue;
    if (!a) {
      // A diff without hunk headers: every line counts, as one hunk.
      if (!l) continue;
      a = [];
      b = [];
    }
    if (l.startsWith("-")) a.push(l.slice(1));
    else if (l.startsWith("+")) b.push(l.slice(1));
    else {
      const t = l.startsWith(" ") ? l.slice(1) : l;
      a.push(t);
      b.push(t);
    }
  }
  flush();
  // Trailing blank context left by the final newline.
  return pairs.map(([x, y]) => [x.replace(/\n$/, ""), y.replace(/\n$/, "")] as [string, string]).filter(([x, y]) => x !== y || x !== "");
}

/** "edit a file", "create a file", "edit 3 files": what the request does, for "Codex wants to …". */
export function patchLead(files: PatchFile[]): string {
  if (files.length > 1) return `change ${files.length} files`;
  const f = files[0];
  return f.kind === "add" ? "create a file" : f.kind === "delete" ? "delete a file" : f.movePath ? "move and edit a file" : "edit a file";
}
