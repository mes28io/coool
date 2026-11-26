// The Changes panel (APP_SPEC "Changes"): what a chat's agent and its subagents changed, file by file, as real diffs,
// with Keep and Undo for a hunk, a file, a turn or the whole chat, and Commit. The data and every write come from
// crates/core/src/changes through lib/changes.ts; this file only draws it and asks.
//
// Views: Unreviewed (what isn't kept yet), All (since the chat started), or one turn. Keys while the panel has focus:
// j / k next and previous hunk, ] / [ next and previous file, Enter folds the file. Nothing destructive is on a key.

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/backend";
import { copyText, onContext } from "../lib/contextMenu";
import { changesFileMenu, changesHunkMenu } from "../lib/menus/panels";
import { type Chat, useChats } from "../lib/chat";
import { changesKeep, changesUndo, setSplitPref, setTellAgentPref, splitPref, tellAgentPref, type ChangesTarget } from "../lib/changes";
import { COMMIT_ASK, commitDraft, splitPath, totals, undoNote, unifiedText, type ChangeSet, type FileChange, type HunkView, type Outcome, type Scope } from "../lib/changesRules";
import { queueAgentNote } from "../lib/changeNotes";
import { ago } from "../lib/format";
import { useStore } from "../store";
import { DiffBody, StatusMark } from "./DiffView";
import { IAlert, ICheck, IChevron, IClose, ICommit, ICopy, IExternal, IGear, IReturn, ISplitRight } from "./icons";
import { Button, cx, IconButton, Popover, Segmented } from "./primitives";


export function ChangesPanel({
  data,
  error,
  reload,
  target,
  scope,
  onScope,
  chat,
  width,
  onClose,
}: {
  data: ChangeSet | null;
  error: string | null;
  reload: () => Promise<void>;
  target: ChangesTarget | null;
  scope: Scope;
  onScope: (s: Scope) => void;
  chat: Chat | null;
  width: number;
  onClose: () => void;
}) {
  const [split, setSplit] = useState(splitPref);
  const canSplit = width >= 760;
  const sideBySide = split && canSplit;
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [asks, setAsks] = useState<Record<string, { q: string; hunk: string | null }>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Files folded or unfolded by hand: a big diff starts folded (BIG_DIFF), every other one open.
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const isFolded = useCallback((f: FileChange) => bigDiff(f) !== folded.has(f.path), [folded]);
  const scroller = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<{ f: number; h: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const files = useMemo(() => data?.files ?? [], [data]);
  const sum = totals(files);
  const readOnly = !!data?.git?.busy;
  const turnN = scope.startsWith("turn:") ? Number(scope.slice(5)) : null;
  const turn = turnN ? data?.turns.find((t) => t.n === turnN) : null;

  useEffect(() => {
    if (!note) return;
    const h = setTimeout(() => setNote(null), note.bad ? 9000 : 4500);
    return () => clearTimeout(h);
  }, [note]);

  const show = (o: Outcome) => setNote({ text: o.message || (o.ok ? "Done" : "Nothing changed"), bad: !o.ok });

  const act = useCallback(
    async (k: string, f: () => Promise<Outcome>, after?: (o: Outcome) => void) => {
      setBusyKey(k);
      try {
        const o = await f();
        after?.(o);
        // A question shows in its file card, not again as a note.
        if (!o.ask) show(o);
      } catch (e) {
        setNote({ text: String(e instanceof Error ? e.message : e), bad: true });
      } finally {
        setBusyKey(null);
        await reload();
      }
    },
    [reload],
  );

  const tellUndo = (o: Outcome, line?: number | null) => {
    if (!chat || !o.ok || !o.done.length || !tellAgentPref()) return;
    queueAgentNote(chat.id, undoNote(o.done, line));
  };

  const undo = (f: FileChange | null, h: HunkView | null, force = false) => {
    if (!target) return;
    const key = `${f?.path ?? "*"}#${h?.id ?? ""}`;
    void act(key, () => changesUndo(target, scope, f?.path ?? null, h?.id ?? null, force), (o) => {
      if (o.ask && f) setAsks((a) => ({ ...a, [f.path]: { q: o.ask!, hunk: h?.id ?? null } }));
      else if (f) setAsks((a) => {
        const { [f.path]: _, ...rest } = a;
        return rest;
      });
      tellUndo(o, h ? (h.lines.find((l) => l.k !== " ")?.n ?? h.new_start) : null);
    });
  };
  const keep = (f: FileChange | null, h: HunkView | null, stage = false, unkeep = false) => {
    if (!target) return;
    void act(`${f?.path ?? "*"}#keep${h?.id ?? ""}`, () => changesKeep(target, scope, f?.path ?? null, h?.id ?? null, stage, unkeep));
  };

  // Keyboard: j/k hunks, ]/[ files, Enter folds.
  const flat = useMemo(() => files.flatMap((f, fi) => (isFolded(f) ? [{ f: fi, h: -1 }] : f.hunks.length ? f.hunks.map((_, hi) => ({ f: fi, h: hi })) : [{ f: fi, h: -1 }])), [files, isFolded]);
  const goTo = (p: { f: number; h: number } | undefined) => {
    if (!p) return;
    setFocus(p);
    // A file's diff that hasn't been drawn yet (out of sight): its card.
    const el = root.current?.querySelector(p.h >= 0 ? `[data-file-index="${p.f}"] [data-hunk-index="${p.h}"]` : `[data-file-index="${p.f}"]`) ?? root.current?.querySelector(`[data-file-index="${p.f}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
    const at = focus ? flat.findIndex((x) => x.f === focus.f && x.h === focus.h) : -1;
    if (e.key === "j" || e.key === "ArrowDown") goTo(flat[Math.min(flat.length - 1, at + 1)]);
    else if (e.key === "k" || e.key === "ArrowUp") goTo(flat[Math.max(0, at - 1)]);
    else if (e.key === "]") goTo(flat.find((x) => x.f > (focus?.f ?? -1)));
    else if (e.key === "[") goTo([...flat].reverse().find((x) => x.f < (focus?.f ?? files.length)));
    else if (e.key === "Enter" && focus) {
      const p = files[focus.f]?.path;
      if (p) setFolded((s) => (s.has(p) ? new Set([...s].filter((x) => x !== p)) : new Set(s).add(p)));
    } else return;
    e.preventDefault();
  };

  const scopeOpts: { value: string; label: React.ReactNode; title: string }[] = [
    { value: "pending", label: <span className="flex items-center gap-1.5">Unreviewed{data ? <Count n={data.pending} /> : null}</span>, title: "What you haven't kept yet" },
    { value: "chat", label: <span className="flex items-center gap-1.5">All{data ? <Count n={data.total} /> : null}</span>, title: "Everything since the chat started" },
  ];

  return (
    <div ref={root} className="flex h-full min-h-0 flex-col outline-none" tabIndex={-1} onKeyDown={onKey} data-changes-panel={scope}>
      {/* header */}
      <div className="flex h-[48px] shrink-0 items-center gap-2 border-b border-hairline pl-3.5 pr-2">
        <span className="text-base font-semibold tracking-[-0.005em] text-fg">Changes</span>
        <Segmented size="sm" value={turnN ? ("turn" as string) : scope} options={[...scopeOpts, ...(turnN ? [{ value: "turn", label: <span>Turn {turnN}</span>, title: turn?.prompt ?? "" }] : [])]} onChange={(v) => v !== "turn" && onScope(v as Scope)} />
        <TurnPicker data={data} scope={scope} onScope={onScope} />
        <span className="flex-1" />
        {canSplit && (
          <IconButton title={sideBySide ? "Unified view" : "Side by side"} active={sideBySide} onClick={() => (setSplit(!split), setSplitPref(!split))}>
            <ISplitRight size={15} />
          </IconButton>
        )}
        <PanelMenu />
        <IconButton title="Close (Esc)" onClick={onClose}>
          <IClose size={14} />
        </IconButton>
      </div>

      {/* banners */}
      {data?.external && <Banner tone="info">This session runs outside coool. Its changes come from its transcript; undo works through git, on the working tree.</Banner>}
      {readOnly && <Banner tone="warn">The repository is in the middle of a {data!.git!.busy}. Changes are read-only until it's finished or aborted.</Banner>}
      {turn && (
        <div className="shrink-0 border-b border-hairline px-3.5 py-2 text-small text-dim" data-changes-turn={turn.n}>
          <span className="font-medium text-fg">Turn {turn.n}</span> · <span className="italic">“{turn.prompt}”</span>
        </div>
      )}

      {/* summary + bulk actions */}
      {files.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3.5 py-1.5 text-small">
          <span className="text-dim">
            <span className="tnum">{sum.files}</span> {sum.files === 1 ? "file" : "files"}
          </span>
          <span className="font-mono text-mono-small tnum">
            <span className="text-done-text">+{sum.added}</span> <span className="text-err-text">−{sum.removed}</span>
          </span>
          {data?.busy && <span className="breathe text-[var(--status-running)]" data-changes-live>· the agent is editing</span>}
          <span className="flex-1" />
          <Button variant="ghost" className="h-[28px] px-2 text-small" disabled={readOnly || !!busyKey} onClick={() => keep(null, null)} title={turnN ? "Mark this turn's changes as reviewed" : "Mark every change here as reviewed"} data-keep-all>
            <ICheck size={13} /> Keep all
          </Button>
          <UndoAll files={files} disabled={readOnly || !!busyKey} turn={turnN} onConfirm={() => undo(null, null)} />
        </div>
      )}

      {/* body */}
      <div ref={scroller} className="scroll min-h-0 flex-1" data-changes-body>
        {error && !data ? (
          <Empty title="Changes aren't available" text={error} />
        ) : !data ? (
          <div className="space-y-2 p-4">
            {[66, 48, 80].map((w, k) => (
              <div key={k} className="h-[10px] rounded-full bg-[color-mix(in_oklab,var(--dim)_12%,transparent)]" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : files.length === 0 ? (
          <Empty
            title={scope === "pending" && data.total > 0 ? "All reviewed" : "No changes yet"}
            text={scope === "pending" && data.total > 0 ? `You've kept every change in this chat. ${data.total} ${data.total === 1 ? "file" : "files"} under All.` : "Files the agent edits, creates or deletes show here as it works."}
            check={scope === "pending" && data.total > 0}
          />
        ) : (
          <div className="pb-6">
            {files.map((f, fi) => (
              <FileCard
                key={f.path}
                f={f}
                index={fi}
                split={sideBySide}
                scope={scope}
                root={data.root}
                folded={isFolded(f)}
                eager={fi < EAGER_FILES}
                scroller={scroller}
                onFold={() => setFolded((s) => (s.has(f.path) ? new Set([...s].filter((x) => x !== f.path)) : new Set(s).add(f.path)))}
                busyKey={busyKey}
                readOnly={readOnly}
                git={!!data.git}
                ask={asks[f.path] ?? null}
                focused={focus?.f === fi ? focus.h : null}
                onUndo={(h, force) => undo(f, h, force)}
                onKeep={(h, stage) => keep(f, h, stage)}
                onUnkeep={() => keep(f, null, false, true)}
                onDismissAsk={() =>
                  setAsks((a) => {
                    const { [f.path]: _, ...rest } = a;
                    return rest;
                  })
                }
                onCopied={() => setNote({ text: `Copied the diff of ${f.rel}`, bad: false })}
                onOpen={(line) => target && void api().changesOpen(target.cwd, f.path, line).catch((e) => setNote({ text: String(e), bad: true }))}
                onReveal={() => void api().attachReveal(f.path).catch((e) => setNote({ text: String(e), bad: true }))}
                chat={chat}
              />
            ))}
          </div>
        )}
      </div>

      <AnimatePresence>
        {note && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4, transition: { duration: 0.12 } }}
            className={cx("mx-3 mb-2 flex shrink-0 items-start gap-2 rounded-[10px] border px-3 py-2 text-small shadow-card", note.bad ? "border-[color-mix(in_oklab,var(--error)_35%,var(--border))] bg-raised text-fg" : "border-line bg-raised text-fg")}
            data-changes-note={note.bad ? "bad" : "ok"}
            role="status"
          >
            {note.bad ? <IAlert size={14} className="mt-px shrink-0 text-err-text" /> : <ICheck size={14} className="mt-px shrink-0 text-done-text" />}
            <span className="min-w-0 flex-1">{note.text}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {data?.git && <CommitBox data={data} chat={chat} cwd={target?.cwd ?? data.root} readOnly={readOnly} onDone={(o) => (show(o), void reload())} />}
    </div>
  );
}

function Count({ n }: { n: number }) {
  return <span className="rounded-[5px] bg-[color-mix(in_oklab,var(--dim)_14%,transparent)] px-1 font-mono text-[10.5px] tnum text-dim">{n}</span>;
}

function Banner({ tone, children }: { tone: "info" | "warn"; children: React.ReactNode }) {
  return (
    <div className={cx("flex shrink-0 items-start gap-2 border-b border-hairline px-3.5 py-2 text-small", tone === "warn" ? "bg-[color-mix(in_oklab,var(--status-needs)_10%,transparent)] text-fg" : "text-dim")} data-changes-banner={tone}>
      {tone === "warn" ? <IAlert size={14} className="mt-px shrink-0 text-needs-text" /> : <IReturn size={14} className="mt-px shrink-0 text-faint" />}
      <span>{children}</span>
    </div>
  );
}

function Empty({ title, text, check }: { title: string; text: string; check?: boolean }) {
  return (
    <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-1.5 px-8 text-center" data-changes-empty>
      {check && <ICheck size={20} className="mb-1 text-done-text" />}
      <div className="text-base font-medium text-fg">{title}</div>
      <div className="max-w-[340px] text-small leading-[18px] text-dim">{text}</div>
    </div>
  );
}

function TurnPicker({ data, scope, onScope }: { data: ChangeSet | null; scope: Scope; onScope: (s: Scope) => void }) {
  const [open, setOpen] = useState(false);
  const turns = (data?.turns ?? []).filter((t) => t.files > 0);
  if (!turns.length) return null;
  return (
    <div className="relative">
      <button type="button" data-pop-anchor onClick={() => setOpen(!open)} className="inline-flex h-[28px] items-center gap-1 rounded-[8px] px-2 text-small font-medium text-dim hover:bg-hover hover:text-fg" title="Changes of one turn" data-turn-picker>
        By turn
        <IChevron size={11} className="rotate-90" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} width={320}>
        <div className="max-h-[320px] overflow-y-auto p-1">
          {turns.map((t) => (
            <button
              key={t.n}
              type="button"
              onClick={() => (onScope(`turn:${t.n}`), setOpen(false))}
              className={cx("flex w-full items-start gap-2 rounded-[8px] px-2.5 py-1.5 text-left hover:bg-hover", scope === `turn:${t.n}` && "bg-hover")}
              data-turn-option={t.n}
            >
              <span className="mt-px shrink-0 font-mono text-mono-small text-faint tnum">{t.n}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-small text-fg">{t.prompt || "Untitled turn"}</span>
                <span className="block text-small text-faint">
                  {t.files} {t.files === 1 ? "file" : "files"} · <span className="text-done-text">+{t.added}</span> <span className="text-err-text">−{t.removed}</span>
                </span>
              </span>
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}

function PanelMenu() {
  const [open, setOpen] = useState(false);
  const [tell, setTell] = useState(tellAgentPref);
  return (
    <div className="relative">
      <IconButton title="Options" onClick={() => setOpen(!open)}>
        <IGear size={14} />
      </IconButton>
      <Popover open={open} onClose={() => setOpen(false)} align="end" width={290}>
        <label className="flex cursor-pointer items-start gap-2.5 p-3 text-small">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={tell}
            onChange={(e) => {
              setTell(e.target.checked);
              setTellAgentPref(e.target.checked);
            }}
            data-tell-agent
          />
          <span>
            <span className="block font-medium text-fg">Tell the agent when I undo</span>
            <span className="block text-dim">A short note so it doesn't redo what you took out: at its next step while it works, or with its next turn.</span>
          </span>
        </label>
      </Popover>
    </div>
  );
}

function UndoAll({ files, disabled, turn, onConfirm }: { files: FileChange[]; disabled: boolean; turn: number | null; onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  const live = files.filter((f) => f.status !== "undone" && f.status !== "unchanged");
  const created = live.filter((f) => f.status === "added").length;
  return (
    <div className="relative">
      <Button variant="ghost" className="h-[28px] px-2 text-small hover:text-err-text" disabled={disabled || !live.length} onClick={() => setOpen(true)} data-undo-all data-pop-anchor>
        <IReturn size={13} /> Undo all
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} align="end" width={300}>
        <div className="p-3 text-small" data-undo-all-confirm>
          <div className="font-medium text-fg">
            Undo {turn ? `turn ${turn}'s changes to` : "the agent's changes to"} {live.length} {live.length === 1 ? "file" : "files"}?
          </div>
          <div className="mt-1 text-dim">
            {created > 0 && `${created} new ${created === 1 ? "file goes" : "files go"} to the Trash. `}Files you've edited since in the same lines are left alone, and you'll be asked about each.
          </div>
          <div className="mt-2.5 flex justify-end gap-1.5">
            <Button variant="ghost" className="h-[28px] px-2.5 text-small" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" className="h-[28px] px-2.5 text-small" onClick={() => (setOpen(false), onConfirm())} data-undo-all-go>
              Undo all
            </Button>
          </div>
        </div>
      </Popover>
    </div>
  );
}

/** Files drawn at once; the rest draw their diffs when they come near the panel's view (LazyDiff). */
const EAGER_FILES = 6;
/** A diff of more lines than this starts folded (its header shows; a click opens it). */
const BIG_DIFF = 800;
const bigDiff = (f: FileChange) => f.hunks.reduce((n, h) => n + h.lines.length, 0) > BIG_DIFF;

/**
 * A file's diff, drawn once it comes within ~1.5 screens of the panel's view (until then a box of about its height:
 * 19 px a line, 27 px a hunk header). When one above the view is drawn, the view is moved by the difference, so what
 * the person looks at stays put.
 */
function LazyDiff({ f, eager, scroller, children }: { f: FileChange; eager: boolean; scroller: React.RefObject<HTMLDivElement | null>; children: () => React.ReactNode }) {
  const [seen, setSeen] = useState(eager);
  const box = useRef<HTMLDivElement>(null);
  const est = useMemo(() => f.hunks.reduce((n, h) => n + 27 + h.lines.length * 19, 2), [f.hunks]);
  const was = useRef<number | null>(null);
  useEffect(() => {
    if (seen || !box.current || typeof IntersectionObserver === "undefined") return void (seen || setSeen(true));
    const io = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        const el = box.current;
        const sc = scroller.current;
        // Above the view: remember its estimated height to make up the difference once drawn.
        was.current = el && sc && el.getBoundingClientRect().bottom <= sc.getBoundingClientRect().top ? el.offsetHeight : null;
        setSeen(true);
      },
      { root: scroller.current, rootMargin: "1500px 0px" },
    );
    io.observe(box.current);
    return () => io.disconnect();
  }, [seen, scroller]);
  useLayoutEffect(() => {
    if (!seen || was.current === null || !box.current || !scroller.current) return;
    scroller.current.scrollTop += box.current.offsetHeight - was.current;
    was.current = null;
  }, [seen, scroller]);
  return (
    <div ref={box} style={seen ? undefined : { height: est }} data-diff-lazy={seen ? undefined : "waiting"}>
      {seen ? children() : null}
    </div>
  );
}

function FileCard({
  f,
  index,
  split,
  scope,
  root,
  folded,
  eager,
  scroller,
  onFold,
  busyKey,
  readOnly,
  git,
  ask,
  focused,
  onUndo,
  onKeep,
  onUnkeep,
  onDismissAsk,
  onCopied,
  onOpen,
  onReveal,
  chat,
}: {
  f: FileChange;
  index: number;
  split: boolean;
  scope: Scope;
  root: string;
  folded: boolean;
  eager: boolean;
  scroller: React.RefObject<HTMLDivElement | null>;
  onFold: () => void;
  busyKey: string | null;
  readOnly: boolean;
  git: boolean;
  ask: { q: string; hunk: string | null } | null;
  focused: number | null;
  onUndo: (h: HunkView | null, force?: boolean) => void;
  onKeep: (h: HunkView | null, stage?: boolean) => void;
  onUnkeep: () => void;
  onDismissAsk: () => void;
  onCopied: () => void;
  onOpen: (line: number) => void;
  onReveal: () => void;
  chat: Chat | null;
}) {
  const [dir, name] = splitPath(f.rel);
  const gone = f.status === "undone" || f.status === "unchanged";
  const undoWhy = f.blocked ?? (readOnly ? "read-only" : null);
  const working = !!busyKey?.startsWith(f.path + "#");
  const agents = useAgentNames(chat, f.agents);
  const showHunks = !folded && !gone && !f.binary && !f.large;
  const locked = working || readOnly;
  const fileMenu = onContext(() =>
    changesFileMenu(f, { copyText: (t) => void copyText(t).then(onCopied), open: onOpen, keep: () => onKeep(null), undo: () => onUndo(null), reveal: onReveal, locked }),
  );
  const hunkActions = (h: HunkView) =>
    gone ? null : (
      <span className="flex items-center gap-0.5 opacity-70 transition-opacity group-hover/h:opacity-100">
        {!h.kept && (
          <MiniButton title="Keep this part (mark it reviewed)" onClick={() => onKeep(h)} disabled={working || readOnly} data-keep-hunk={h.id}>
            <ICheck size={12} /> Keep
          </MiniButton>
        )}
        <MiniButton title={h.blocked ?? undoWhy ?? "Undo just this part"} onClick={() => onUndo(h)} disabled={working || !!undoWhy || !!h.blocked} danger data-undo-hunk={h.id}>
          <IReturn size={12} /> Undo
        </MiniButton>
      </span>
    );
  return (
    <section onContextMenu={fileMenu} className={cx("border-b border-hairline", f.kept && scope === "chat" && "opacity-[0.92]")} data-file-index={index} data-change-file={f.rel} data-file-kept={f.kept || undefined} data-file-diverged={f.diverged || undefined} data-file-busy={f.busy || undefined}>
      <div className="sticky top-0 z-[2] flex min-h-[40px] items-center gap-2 bg-panel/95 px-3 py-1.5 backdrop-blur-[6px]">
        <button type="button" onClick={onFold} className="flex size-[18px] shrink-0 items-center justify-center text-faint hover:text-fg" title={folded ? "Show the diff" : "Fold"} aria-expanded={!folded}>
          <IChevron size={11} className={cx("transition-transform duration-150", !folded && "rotate-90")} />
        </button>
        <StatusMark status={f.status} />
        <span className="min-w-0 flex-1 truncate font-mono text-mono-small" title={f.path}>
          <span className="text-faint">{dir}</span>
          <span className={cx("text-fg", gone && "line-through decoration-[color-mix(in_oklab,var(--dim)_60%,transparent)]")}>{name}</span>
          {f.from_rel && <span className="text-faint"> ← {f.from_rel}</span>}
        </span>
        {!gone && !f.binary && (
          <span className="flex shrink-0 gap-1 font-mono text-mono-small tnum">
            {f.added > 0 && <span className="text-done-text">+{f.added}</span>}
            {f.removed > 0 && <span className="text-err-text">−{f.removed}</span>}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1">
          {f.busy && <Tag tone="live">editing</Tag>}
          {f.diverged && !f.busy && !gone && <Tag tone="warn" title="On disk isn't what the agent left: you (or another tool) changed it since">edited since</Tag>}
          {f.staged && <Tag>staged</Tag>}
          {f.kept && !gone && <Tag tone="ok">kept</Tag>}
          {gone && <Tag>{f.status === "undone" ? `undone${f.undone_at ? ` ${ago(f.undone_at)}` : ""}` : "no net change"}</Tag>}
        </span>
        {!gone && (
          <span className="flex shrink-0 items-center gap-0.5">
            {f.kept ? (
              <MiniButton title="Mark as not reviewed" onClick={onUnkeep} disabled={working} data-unkeep-file>
                Unkeep
              </MiniButton>
            ) : (
              <KeepButton git={git} disabled={working || readOnly} onKeep={(stage) => onKeep(null, stage)} />
            )}
            <MiniButton title={undoWhy ?? (f.status === "added" ? "Undo: the new file goes to the Trash" : f.status === "deleted" ? "Undo: put the file back" : "Undo the agent's changes to this file")} onClick={() => onUndo(null)} disabled={working || !!undoWhy} danger data-undo-file>
              <IReturn size={12} /> Undo
            </MiniButton>
            <FileMenu f={f} onCopied={onCopied} onOpen={() => onOpen(f.line)} root={root} />
          </span>
        )}
      </div>
      {(f.said || agents.length > 0) && !folded && (
        <div className="-mt-0.5 px-3 pb-1.5 pl-[52px] text-small text-dim" data-file-said>
          {agents.length > 0 && <span className="mr-1.5 rounded-[5px] bg-[color-mix(in_oklab,var(--status-running)_12%,transparent)] px-1.5 py-px text-[var(--status-running)]">{agents.join(", ")}</span>}
          {f.said && <span className="italic">“{f.said}”</span>}
        </div>
      )}
      {folded && !gone && bigDiff(f) && (
        <button type="button" onClick={onFold} className="mx-3 mb-2 block rounded-[8px] bg-[color-mix(in_oklab,var(--dim)_7%,transparent)] px-3 py-1.5 text-left text-small text-dim hover:bg-hover hover:text-fg" data-file-big>
          A large diff ({f.hunks.reduce((n, h) => n + h.lines.length, 0)} lines): show it
        </button>
      )}
      {f.reedited && <div className="mx-3 mb-2 rounded-[8px] border border-[color-mix(in_oklab,var(--status-needs)_30%,var(--border))] px-2.5 py-1.5 text-small text-fg" data-file-reedited>The agent edited this again after you undid its change.</div>}
      <AnimatePresence initial={false}>
        {ask && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mx-3 mb-2 rounded-[10px] border border-[color-mix(in_oklab,var(--status-needs)_35%,var(--border))] bg-[color-mix(in_oklab,var(--status-needs)_7%,var(--raised))] p-2.5 text-small" data-undo-ask>
              <div className="flex gap-2">
                <IAlert size={14} className="mt-px shrink-0 text-needs-text" />
                <span className="text-fg">{ask.q}</span>
              </div>
              <div className="mt-2 flex justify-end gap-1.5">
                <Button variant="ghost" className="h-[26px] px-2 text-small" onClick={onDismissAsk}>
                  Keep my edits
                </Button>
                <Button variant="outline" className="h-[26px] px-2 text-small hover:text-err-text" onClick={() => onUndo(f.hunks.find((h) => h.id === ask.hunk) ?? null, true)} data-undo-anyway>
                  Undo anyway · your version to the Trash
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {!folded && !gone && (f.binary || f.large || f.unknown_base) && (
        <div className="mx-3 mb-2 rounded-[8px] bg-[color-mix(in_oklab,var(--dim)_7%,transparent)] px-3 py-2 text-small text-dim" data-file-notice>
          {f.binary ? "Binary file: not shown as a diff." : f.large ? `${f.large}.` : (f.blocked ?? "coool can't tell what this file was before.")}
          {f.unknown_base && f.hunks.length > 0 && " Showing the agent's patch."}
        </div>
      )}
      {showHunks && f.hunks.length > 0 && (
        <div className={cx("mx-3 mb-3 overflow-hidden rounded-[10px] border border-hairline bg-bg", f.busy && "border-[color-mix(in_oklab,var(--status-running)_35%,var(--border))]")}>
          <LazyDiff f={f} eager={eager} scroller={scroller}>
            {() => <DiffBody file={f} split={split} foldKept={scope !== "pending"} slots={{
                actions: hunkActions,
                focused,
                menu: (h, _i, at) => changesHunkMenu(f, h, { copyText: (t) => copyText(t), open: onOpen, keep: () => onKeep(h), undo: () => onUndo(h), locked, ...at }),
              }} />}
          </LazyDiff>
        </div>
      )}

      {!folded && f.unknown_base && f.hunks.length > 0 && !showHunks && null}
    </section>
  );
}

function useAgentNames(chat: Chat | null, ids: string[]): string[] {
  const sessions = useStore((s) => (ids.length ? s.sessions : null));
  return useMemo(() => {
    if (!ids.length) return [];
    const names = new Map<string, string>();
    for (const s of sessions ?? []) for (const a of s.agents) names.set(a.id, a.description || a.kind);
    void chat;
    return ids.map((i) => names.get(i) ?? i).map((n) => (n.length > 40 ? n.slice(0, 39) + "…" : n));
  }, [ids, sessions, chat]);
}

function Tag({ children, tone, title }: { children: React.ReactNode; tone?: "ok" | "warn" | "live"; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        "rounded-[5px] px-1.5 py-px text-[11px] font-medium leading-[16px]",
        tone === "ok" ? "bg-[color-mix(in_oklab,var(--status-done)_13%,transparent)] text-done-text" : tone === "warn" ? "bg-[color-mix(in_oklab,var(--status-needs)_16%,transparent)] text-needs-text" : tone === "live" ? "breathe bg-[color-mix(in_oklab,var(--status-running)_14%,transparent)] text-[var(--status-running)]" : "bg-[color-mix(in_oklab,var(--dim)_12%,transparent)] text-dim",
      )}
    >
      {children}
    </span>
  );
}

function MiniButton({ children, onClick, title, disabled, danger, ...data }: { children: React.ReactNode; onClick: () => void; title?: string; disabled?: boolean; danger?: boolean; [k: `data-${string}`]: string | boolean | undefined }) {
  return (
    <button
      type="button"
      {...data}
      title={title}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      className={cx(
        "inline-flex h-[24px] shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-small font-medium transition-colors duration-150",
        disabled ? "cursor-default text-faint opacity-60" : danger ? "text-dim hover:bg-hover hover:text-err-text" : "text-dim hover:bg-hover hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function KeepButton({ git, disabled, onKeep }: { git: boolean; disabled: boolean; onKeep: (stage: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <MiniButton title="Keep: mark this file reviewed" onClick={() => onKeep(false)} disabled={disabled} data-keep-file>
        <ICheck size={12} /> Keep
      </MiniButton>
      {git && (
        <>
          <button type="button" data-pop-anchor aria-label="More ways to keep" title="Keep and stage" disabled={disabled} onClick={() => setOpen(!open)} className="-ml-1 inline-flex h-[24px] w-[16px] items-center justify-center rounded-[6px] text-faint hover:bg-hover hover:text-fg disabled:opacity-50" data-keep-more>
            <IChevron size={9} className="rotate-90" />
          </button>
          <Popover open={open} onClose={() => setOpen(false)} align="end" width={200}>
            <div className="p-1">
              <button type="button" onClick={() => (setOpen(false), onKeep(true))} className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-small text-fg hover:bg-hover" data-keep-stage>
                <ICommit size={13} className="text-faint" /> Keep and stage
              </button>
            </div>
          </Popover>
        </>
      )}
    </span>
  );
}

function FileMenu({ f, onCopied, onOpen, root }: { f: FileChange; onCopied: () => void; onOpen: () => void; root: string }) {
  const [open, setOpen] = useState(false);
  void root;
  return (
    <span className="relative inline-flex">
      <button type="button" data-pop-anchor onClick={() => setOpen(!open)} className="inline-flex h-[24px] w-[22px] items-center justify-center rounded-[6px] text-faint hover:bg-hover hover:text-fg" aria-label="More" title="More" data-file-menu>
        ⋯
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align="end" width={220}>
        <div className="p-1 text-small">
          {f.status !== "deleted" && (
            <button type="button" onClick={() => (setOpen(false), onOpen())} className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-fg hover:bg-hover" data-open-editor>
              <IExternal size={13} className="text-faint" /> Open at line {f.line}
            </button>
          )}
          {f.hunks.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void navigator.clipboard?.writeText(unifiedText(f)).then(onCopied);
              }}
              className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-fg hover:bg-hover"
              data-copy-diff
            >
              <ICopy size={13} className="text-faint" /> Copy diff
            </button>
          )}
        </div>
      </Popover>
    </span>
  );
}

/** Staged files and the commit message; Commit only on the person's click, never a push. */
function CommitBox({ data, chat, cwd, readOnly, onDone }: { data: ChangeSet; chat: Chat | null; cwd: string; readOnly: boolean; onDone: (o: Outcome) => void }) {
  const staged = data.git?.staged ?? [];
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState<{ from: number } | null>(null);
  const [drafted, setDrafted] = useState(false);
  const items = useChats((s) => (asked && chat ? s.chats[chat.id]?.items : null));
  // The agent's reply to "write a commit message": its message goes in the box (never committed by itself).
  useEffect(() => {
    if (!asked || !items) return;
    const after = items.slice(asked.from);
    const end = after.findIndex((i) => i.kind === "turn");
    if (end < 0) return;
    const texts = after.slice(0, end).filter((i) => i.kind === "text" && !i.parent) as { text: string }[];
    const m = texts.length ? commitDraft(texts[texts.length - 1].text) : null;
    if (m) {
      setMsg((cur) => (cur.trim() ? cur : m));
      setDrafted(true);
    }
    setAsked(null);
  }, [asked, items]);
  if (!staged.length && !msg) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-t border-hairline px-3.5 py-2 text-small text-faint" data-commit-box="empty">
        <ICommit size={13} />
        <span className="min-w-0 flex-1 truncate">{data.git?.branch ? `On ${data.git.branch}. ` : ""}Keep and stage files to commit them here.</span>
      </div>
    );
  }
  const canAsk = !!chat && chat.running && chat.state === "idle" && !asked;
  const commit = async () => {
    setBusy(true);
    try {
      const o = await api().changesCommit(cwd, msg);
      if (o.ok) {
        setMsg("");
        setDrafted(false);
      }
      onDone(o.ok ? { ...o, message: `${o.message} on ${data.git?.branch ?? "this branch"} · not pushed` } : o);
    } catch (e) {
      onDone({ ok: false, message: String(e instanceof Error ? e.message : e), done: [], refused: [] });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shrink-0 border-t border-hairline px-3 py-2.5" data-commit-box={staged.length}>
      <div className="mb-1.5 flex items-center gap-2 text-small">
        <ICommit size={13} className="text-faint" />
        <span className="font-medium text-fg">
          {staged.length} staged
        </span>
        <span className="min-w-0 flex-1 truncate text-faint">{data.git?.branch ? `on ${data.git.branch}` : ""}</span>
        {chat && (
          <button type="button" disabled={!canAsk} onClick={() => chat && (setAsked({ from: chat.items.length }), void api().chatSend(chat.id, COMMIT_ASK))} className="text-small text-dim underline-offset-2 hover:text-fg hover:underline disabled:opacity-50 disabled:hover:no-underline" title={canAsk ? "Sends the agent a message asking for a commit message; its reply fills the box" : asked ? "Waiting for the agent's reply…" : "When the agent is idle"} data-ask-commit>
            {asked ? "Asking the agent…" : "Ask the agent for a message"}
          </button>
        )}
      </div>
      <div className="flex items-end gap-2">
        <textarea
          value={msg}
          onChange={(e) => (setMsg(e.target.value), setDrafted(false))}
          rows={Math.min(5, Math.max(1, msg.split("\n").length))}
          placeholder="Commit message"
          className="min-h-[34px] min-w-0 flex-1 resize-none rounded-[9px] border border-line bg-raised px-2.5 py-[7px] text-base text-fg outline-none placeholder:text-faint focus:border-[color-mix(in_oklab,var(--dim)_55%,var(--border))]"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && msg.trim() && staged.length && !busy) {
              e.preventDefault();
              void commit();
            }
          }}
          data-commit-message
        />
        <Button variant="primary" disabled={!msg.trim() || !staged.length || busy || readOnly} onClick={() => void commit()} title="Commit what is staged (⌘↵). Nothing is pushed." data-commit>
          {busy ? "Committing…" : "Commit"}
        </Button>
      </div>
      {drafted && <div className="mt-1 text-small text-faint">Drafted by the agent: check it before you commit.</div>}
    </div>
  );
}
