// The History page (the rail's clock, ⌘Y, ⌘K "History"): every Claude Code and Codex session on this Mac, from the
// first one on, wherever it ran: coool, a terminal, an editor, another app. Newest first, grouped by day; a search
// finds sessions by their words (prompts, replies, files, folders), best match first. A row opens the session in
// coool's session view (lib/history.ts `openHistoryRow`), where the ended-session box continues it as a coool chat.
// It lies over the sheet like the Needs you page: going back finds the app as it was. Nothing is imported: the CLIs'
// transcripts are read where they are (the note under the search says so).
// It lists the sessions the person started (crates/core/src/origin.rs `started_by`); "Started by agents (N)" adds the
// ones agents and other tools started, each under the session that started it when that one is listed.
//
// Keys: type to search, ↑ ↓ move, ↵ opens (⌘↵ in a new tab), Esc clears the search, then goes back.

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/backend";
import { onContext } from "../lib/contextMenu";
import { historyMenu } from "../lib/menus/misc";
import { folderName, homeShort } from "../lib/format";
import { byDay, filtersOn, NO_FILTERS, openHistoryRow, promptsLabel, spanLabel, toQuery, WHERE_LABEL, type DateRange, type HistoryFilters, type HistoryHelper, type HistoryPage as Page, type HistoryRow, type Where } from "../lib/history";
import { modelLabel } from "../lib/models";
import { useMotion } from "../lib/motion";
import { sessionKey, type Provider } from "../lib/types";
import { useStore } from "../store";
import { IBack, ICheck, IChevron, IClock, IClose, IDiff, IFanout, IFolder, IInfo, ISearch } from "./icons";
import { Chip, cx, ease, Kbd, Popover, ProviderMark, Segmented, StatusDot } from "./primitives";

const PAGE = 120;

export function HistoryPage() {
  const req = useStore((s) => s.history);
  const close = useStore((s) => s.closeHistory);
  const reduce = useMotion().reduce;
  const [f, setF] = useState<HistoryFilters>(() => ({ ...NO_FILTERS, ...req?.filters }));
  // A new open (another project's "Show N more") applies its filters to the page already up.
  const [seq, setSeq] = useState(req?.seq);
  const [text, setText] = useState(f.text);
  if (req && req.seq !== seq) {
    setSeq(req.seq);
    setF({ ...NO_FILTERS, ...req.filters });
    setText(req.filters.text ?? "");
  }
  const [page, setPage] = useState<Page | null>(null);
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [busy, setBusy] = useState(true);
  const [sel, setSel] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The words go to the query a moment after typing stops; filters at once.
  useEffect(() => {
    const t = setTimeout(() => setF((x) => (x.text === text ? x : { ...x, text })), 110);
    return () => clearTimeout(t);
  }, [text]);

  const query = useMemo(() => toQuery(f), [f]);
  const gen = useRef(0);
  const run = useCallback(
    (offset: number) => {
      const g = ++gen.current;
      if (offset === 0) setBusy(true);
      return api()
        .historyQuery({ ...query, offset, limit: PAGE })
        .then((p) => {
          if (g !== gen.current) return;
          setPage(p);
          setRows((old) => (offset === 0 ? p.rows : [...old, ...p.rows]));
          if (offset === 0) setSel(0);
        })
        .catch((e) => useStore.getState().toast(String(e), "error"))
        .finally(() => g === gen.current && setBusy(false));
    },
    [query],
  );
  useEffect(() => {
    void run(0);
  }, [run]);
  // The page looks for new sessions when it opens.
  useEffect(() => {
    void api().historyStatus().catch(() => {});
  }, []);
  // While the first pass runs, results stream in.
  const ready = page?.status.ready ?? false;
  useEffect(() => {
    if (ready || !page) return;
    const t = setTimeout(() => void run(0), 1500);
    return () => clearTimeout(t);
  }, [ready, page, run]);

  const more = () => {
    if (!page || busy || rows.length >= page.total) return;
    setBusy(true);
    void run(rows.length);
  };

  // Sessions the sidebar shows as live: their dot.
  const liveSig = useStore((s) => s.sessions.filter((x) => x.status !== "ended").map((x) => `${sessionKey(x)}=${x.status}`).join("\n"));
  const live = useMemo(() => new Map(liveSig.split("\n").filter(Boolean).map((l) => l.split("=") as [string, "busy" | "idle"])), [liveSig]);

  const open = useCallback(async (r: HistoryRow, newTab = false) => {
    setOpening(r.key);
    await openHistoryRow(r, { newTab });
    setOpening(null);
  }, []);

  // Focus goes into the search and back where it was on return (as the Needs you page does).
  const [prev] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    return () => {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost && prev?.isConnected && !prev.closest("[inert]")) prev.focus({ preventScroll: true });
    };
  }, [prev]);

  const latest = useRef({ rows, sel, text, open });
  useLayoutEffect(() => {
    latest.current = { rows, sel, text, open };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (st.palette || st.sheet || e.defaultPrevented) return;
      if (document.querySelector("[data-history-pop]")) return;
      const { rows, sel, text, open } = latest.current;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const inSearch = !!t?.matches("[data-history-search]");
      const typing = !inSearch && !!t?.closest("input, textarea, select, [contenteditable='true']");
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (text) {
          setText("");
          setF((x) => ({ ...x, text: "" }));
        } else close();
        return;
      }
      if (typing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const i = Math.max(0, Math.min(rows.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1)));
        setSel(i);
        listRef.current?.querySelector(`[data-history-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (e.key === "Enter" && rows[sel]) {
        e.preventDefault();
        void open(rows[sel], e.metaKey || e.ctrlKey);
        return;
      }
      // Typing anywhere on the page goes to the search.
      if (!inSearch && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  const searching = f.text.trim().length > 0;
  // Each group with the list index of its first row (↑ ↓ move through them all).
  const groups = useMemo(() => {
    const g = searching ? [{ day: "Best matches", rows }] : byDay(rows);
    let n = 0;
    return g.map((x) => ({ ...x, base: (n += x.rows.length) - x.rows.length }));
  }, [rows, searching]);
  const st = page?.status;
  const nOn = filtersOn(f);

  return (
    <motion.div
      data-history-page={page?.total ?? ""}
      tabIndex={-1}
      className="@container absolute inset-0 z-10 flex flex-col bg-bg outline-none"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16, ease }}
    >
      <div data-tauri-drag-region className="flex h-[48px] shrink-0 items-center px-2">
        <button
          type="button"
          onClick={close}
          title="Back to app (Esc)"
          className="flex h-[32px] items-center gap-2 rounded-[9px] pl-2 pr-2.5 text-base text-dim transition-colors duration-150 hover:bg-hover hover:text-fg"
          data-history-back
        >
          <IBack size={16} />
          Back to app
        </button>
        <div data-tauri-drag-region className="ml-auto flex min-w-0 items-baseline gap-2 px-2">
          <h2 className="truncate text-base font-semibold text-fg">History</h2>
          {page && (
            <span className="shrink-0 text-small text-dim tnum" data-history-count>
              {searching || nOn ? `${page.total.toLocaleString()} of ${((st?.sessions ?? 0) + (query.agents ? (st?.agents ?? 0) : 0)).toLocaleString()}` : (st?.sessions ?? 0).toLocaleString()} sessions
            </span>
          )}
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[880px] min-h-0 flex-1 flex-col px-4 @[700px]:px-8">
        {/* Search */}
        <label className="flex h-[48px] shrink-0 items-center gap-3 rounded-[14px] border border-line bg-raised px-3.5 shadow-card focus-within:border-[color-mix(in_oklab,var(--text)_28%,var(--border))]">
          <ISearch size={17} className="shrink-0 text-dim" />
          <input
            ref={inputRef}
            data-history-search
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search every session: words, files, folders…"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-prose text-fg outline-none placeholder:text-faint"
          />
          {text ? (
            <button type="button" title="Clear (Esc)" onClick={() => (setText(""), setF((x) => ({ ...x, text: "" })))} className="flex size-[24px] shrink-0 items-center justify-center rounded-[7px] text-faint hover:bg-hover hover:text-fg">
              <IClose size={11} />
            </button>
          ) : (
            <Kbd className="hidden shrink-0 @[520px]:inline-flex">⌘Y</Kbd>
          )}
        </label>

        {/* Filters */}
        <div className="mt-2.5 flex shrink-0 flex-wrap items-center gap-1.5" data-history-filters>
          <ProjectFilter value={f.project} facets={page?.projects ?? []} onChange={(project) => setF((x) => ({ ...x, project }))} />
          <Segmented<"all" | Provider>
            size="sm"
            value={f.provider ?? "all"}
            onChange={(v) => setF((x) => ({ ...x, provider: v === "all" ? null : v }))}
            options={[
              { value: "all", label: "Both" },
              { value: "claude", label: <><ProviderMark provider="claude" size={12} />Claude</> },
              { value: "codex", label: <><ProviderMark provider="codex" size={12} />Codex</> },
            ]}
          />
          <WhereFilter value={f.wheres} onChange={(wheres) => setF((x) => ({ ...x, wheres }))} />
          <DateFilter f={f} onChange={(d) => setF((x) => ({ ...x, ...d }))} />
          <Chip active={f.changes} onClick={() => setF((x) => ({ ...x, changes: !x.changes }))} title="Only sessions that changed files">
            <IDiff size={14} />
            Changed files
          </Chip>
          {page && (page.agents > 0 || f.agents) && (
            <span data-history-agents={page.agents} data-on={f.agents || undefined} className="contents">
              <Chip
                active={f.agents}
                onClick={() => setF((x) => ({ ...x, agents: !x.agents }))}
                title={f.agents ? "Hide the sessions agents and other tools started" : "Also list the sessions agents and other tools started (Ladder helpers, lanes, claude -p, codex exec), under the session that started them"}
              >
                <IFanout size={14} />
                Started by agents <span className="tnum text-faint">({page.agents.toLocaleString()})</span>
              </Chip>
            </span>
          )}
          {nOn > 0 && (
            <button type="button" onClick={() => setF({ ...NO_FILTERS, text: f.text })} className="ml-1 h-[28px] rounded-[8px] px-2 text-small text-dim hover:bg-hover hover:text-fg" data-history-clear>
              Clear filters
            </button>
          )}
        </div>

        {/* Where the history is, and how far the index is */}
        <div className="mt-2 flex shrink-0 items-start gap-1.5 px-0.5 text-small text-faint" data-history-note>
          <IInfo size={13} className="mt-[2px] shrink-0" />
          <span className="min-w-0">
            Read in place from ~/.claude and ~/.codex: nothing is copied or changed, your history stays where it is.
            {st && !st.ready && (
              <span className="text-dim" data-history-indexing>
                {" "}
                Indexing… {st.pending.toLocaleString()} {st.pending === 1 ? "file" : "files"} to go.
              </span>
            )}
          </span>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          role="listbox"
          aria-label="Sessions"
          className="scroll -mx-2 mt-3 min-h-0 flex-1 px-2 pb-10"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) more();
          }}
          data-history-list
        >
          {!page && <ListSkeleton />}
          {page && rows.length === 0 && !busy && <Empty searching={searching} filters={nOn > 0} indexing={!ready} onClear={() => (setText(""), setF(NO_FILTERS))} text={f.text} />}
          {groups.map((g) => (
            <section key={g.day} className="mb-3" data-history-day={g.day}>
              <div className="sticky top-0 z-[1] -mx-2 flex h-[30px] items-center bg-bg px-3 text-small font-medium text-dim">
                {g.day}
                {searching && page && (
                  <span className="ml-auto font-normal text-faint tnum" data-history-took>
                    {page.total.toLocaleString()} found · {page.took_ms < 1 ? "<1" : Math.round(page.took_ms)} ms
                  </span>
                )}
              </div>
              {g.rows.map((r, k) => {
                const i = g.base + k;
                return (
                  <div key={r.key}>
                    <Row r={r} i={i} on={i === sel} live={live.get(r.key)} searching={searching} opening={opening === r.key} reduce={reduce} onHover={() => setSel(i)} onOpen={(nt) => void open(r, nt)} />
                    {r.helpers?.length ? <Helpers parent={r} rows={r.helpers} live={live} opening={opening} searching={searching} onOpen={(h, nt) => void open({ ...r, ...h, helpers: undefined, by: "agent" } as HistoryRow, nt)} /> : null}
                  </div>
                );
              })}
            </section>
          ))}
          {page && rows.length < page.total && (
            <button type="button" onClick={more} className="mx-auto mt-1 flex h-[32px] items-center rounded-[9px] px-3 text-small text-dim hover:bg-hover hover:text-fg" data-history-more>
              {busy ? "Loading…" : `Show more (${(page.total - rows.length).toLocaleString()})`}
            </button>
          )}
        </div>
        <div className="hidden shrink-0 items-center gap-1.5 pb-4 pt-1 text-small text-faint @[620px]:flex">
          <Kbd className="h-[20px]">↑↓</Kbd> move
          <Kbd className="ml-2 h-[20px]">↵</Kbd> open
          <Kbd className="ml-2 h-[20px]">⌘↵</Kbd> new tab
          <Kbd className="ml-2 h-[20px]">Esc</Kbd> back
        </div>
      </div>
    </motion.div>
  );
}

const revealFolder = (path: string) => void api().attachReveal(path).catch(() => {});
const makeFolder = (cwd: string) => void api().historyMakeFolder(cwd).then(() => useStore.getState().toast("Folder made again", "info")).catch((e) => useStore.getState().toast(String(e), "error"));

function time(ms: number, searching: boolean): string {
  const d = new Date(ms);
  if (!searching) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

function Row({ r, i, on, live, searching, opening, reduce, onHover, onOpen }: { r: HistoryRow; i: number; on: boolean; live?: "busy" | "idle"; searching: boolean; opening: boolean; reduce: boolean; onHover: () => void; onOpen: (newTab: boolean) => void }) {
  const span = spanLabel(r.started_ms, r.last_ms);
  const meta: ReactNode[] = [
    <span key="p" className="inline-flex min-w-0 items-center gap-1 text-dim" title={homeShort(r.cwd)}>
      <IFolder size={12} className="shrink-0" />
      <span className="truncate">{folderName(r.project || r.cwd)}</span>
    </span>,
    <span key="v" data-history-via={r.where}>{r.via}</span>,
    r.model && <span key="m">{modelLabel(r.model)}</span>,
    <span key="n" className="tnum">{promptsLabel(r.prompts)}{span ? `, ${span}` : ""}</span>,
    r.edits > 0 && <span key="e" className="tnum" title={r.files.join("\n")}>{r.edits} {r.edits === 1 ? "file" : "files"} changed</span>,
  ].filter(Boolean);
  return (
    <motion.div initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}>
      <button
        type="button"
        role="option"
        aria-selected={on}
        tabIndex={on ? 0 : -1}
        data-history-i={i}
        data-history-row={r.key}
        onMouseMove={() => !on && onHover()}
        onClick={(e) => onOpen(e.metaKey || e.ctrlKey)}
        onContextMenu={onContext(() => (onHover(), historyMenu({ row: r, open: onOpen, reveal: revealFolder, makeFolder })))}
        className={cx("mb-0.5 flex w-full items-start gap-3 rounded-[12px] border px-3 py-2.5 text-left transition-colors duration-150", on ? "border-hairline bg-raised shadow-card" : "border-transparent hover:bg-hover")}
      >
        <span className="relative mt-[3px] flex shrink-0">
          <ProviderMark provider={r.provider} size={15} />
          {live && <StatusDot status={live} size={7} className="absolute -bottom-[3px] -right-[3px] ring-2 ring-bg" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-base font-medium text-fg">{r.title}</span>
            {r.missing && (
              <span className="shrink-0 rounded-[5px] bg-[color-mix(in_oklab,var(--busy)_16%,transparent)] px-1.5 text-micro font-medium leading-[18px] text-busy-text" title={`${homeShort(r.cwd)} isn't there any more. The history still opens.`} data-history-missing>
                Folder gone
              </span>
            )}
            {r.compactions > 0 && <span className="shrink-0 text-micro text-faint" title="The CLI compacted its context; the whole history is still in the transcript">compacted</span>}
            {r.archived && <span className="shrink-0 text-micro text-faint">archived</span>}
            <span className="ml-auto shrink-0 pl-2 text-small text-faint tnum">{opening ? "Opening…" : live ? (live === "busy" ? "working now" : "open now") : time(r.last_ms, searching)}</span>
          </span>
          {searching && r.snippet?.length ? (
            <span className="mt-0.5 line-clamp-2 block text-small text-dim" data-history-snippet>
              {r.snippet.map((s, k) => (s.hit ? <mark key={k} className="rounded-[3px] bg-[color-mix(in_oklab,var(--accent)_22%,transparent)] px-[1px] text-fg">{s.t}</mark> : <span key={k}>{s.t}</span>))}
            </span>
          ) : (
            r.prompt && r.prompt !== r.title && <span className="mt-0.5 block truncate text-small text-dim">{r.prompt}</span>
          )}
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-small text-faint">
            {meta.map((m, k) => (
              <span key={k} className="flex min-w-0 items-center gap-2">
                {k > 0 && <span aria-hidden className="text-faint/60">·</span>}
                {m}
              </span>
            ))}
          </span>
        </span>
      </button>
    </motion.div>
  );
}

/** The sessions a row's session started (agents' runs), listed under it: a few, then "N more". */
function Helpers({ parent, rows, live, opening, searching, onOpen }: { parent: HistoryRow; rows: HistoryHelper[]; live: Map<string, "busy" | "idle">; opening: string | null; searching: boolean; onOpen: (h: HistoryHelper, newTab: boolean) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 4);
  return (
    <div className="mb-1.5 ml-[30px] border-l border-hairline pl-2" data-history-helpers={parent.key}>
      {shown.map((h) => (
        <button
          key={h.key}
          type="button"
          data-history-helper={h.key}
          onClick={(e) => onOpen(h, e.metaKey || e.ctrlKey)}
          onContextMenu={onContext(() => historyMenu({ row: { id: h.id, cwd: parent.cwd, missing: parent.missing }, open: (nt) => onOpen(h, nt), reveal: revealFolder, makeFolder }))}
          className="flex h-[30px] w-full min-w-0 items-center gap-2 rounded-[8px] px-2 text-left text-small transition-colors duration-150 hover:bg-hover"
          title={`Started by “${parent.title}”`}
        >
          <ProviderMark provider={h.provider} size={12} />
          <span className="min-w-0 truncate text-fg/85">{h.title}</span>
          <span className="shrink-0 text-faint">{h.via}</span>
          {h.model && <span className="hidden shrink-0 text-faint @[560px]:inline">{modelLabel(h.model)}</span>}
          <span className="ml-auto shrink-0 pl-2 text-faint tnum">{opening === h.key ? "Opening…" : live.get(h.key) ? "running now" : time(h.last_ms, searching)}</span>
        </button>
      ))}
      {rows.length > 4 && (
        <button type="button" onClick={() => setAll(!all)} className="flex h-[26px] items-center rounded-[7px] px-2 text-small text-dim hover:bg-hover hover:text-fg" data-history-helpers-more>
          {all ? "Fewer" : `${rows.length - 4} more started by this session`}
        </button>
      )}
    </div>
  );
}

function Empty({ searching, filters, indexing, onClear, text }: { searching: boolean; filters: boolean; indexing: boolean; onClear: () => void; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-20 text-center" data-history-empty>
      <IClock size={22} className="text-faint" />
      <div className="text-base font-medium text-fg/90">{searching ? `No sessions match “${text.trim()}”` : filters ? "No sessions match these filters" : indexing ? "Reading your sessions…" : "No sessions yet"}</div>
      <div className="max-w-[360px] text-small text-dim">
        {indexing ? "History is still reading the CLIs' transcripts; more appear as it goes." : searching || filters ? "Every word has to be there. Try fewer words or other filters." : "Sessions you run with Claude Code or Codex, in coool or anywhere else, appear here."}
      </div>
      {(searching || filters) && (
        <button type="button" onClick={onClear} className="mt-1 h-[30px] rounded-[9px] px-3 text-small font-medium text-fg hover:bg-hover">
          Clear search and filters
        </button>
      )}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-1 pt-8" aria-hidden>
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex gap-3 px-3 py-3">
          <div className="size-[15px] rounded-full bg-hover" />
          <div className="flex-1">
            <div className="h-[13px] rounded bg-hover" style={{ width: `${40 + ((i * 17) % 40)}%` }} />
            <div className="mt-2 h-[10px] w-[55%] rounded bg-hover opacity-70" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- filter menus ----------

function Menu({ label, active, icon, children, width = 280, title }: { label: ReactNode; active: boolean; icon?: ReactNode; children: (close: () => void) => ReactNode; width?: number; title?: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="relative">
      <Chip active={active || open} onClick={() => setOpen((o) => !o)} title={title}>
        {icon}
        <span className="max-w-[180px] truncate">{label}</span>
        <IChevron size={12} className="rotate-90 opacity-70" />
      </Chip>
      <Popover open={open} onClose={close} width={width}>
        <div data-history-pop className="p-1">{children(close)}</div>
      </Popover>
    </div>
  );
}

function MenuItem({ on, onClick, children, hint }: { on: boolean; onClick: () => void; children: ReactNode; hint?: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cx("flex h-[32px] w-full items-center gap-2 rounded-[8px] px-2 text-left text-base", on ? "text-fg" : "text-fg/85 hover:bg-hover")}>
      <span className="flex w-[16px] shrink-0 justify-center">{on && <ICheck size={13} />}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint !== undefined && <span className="shrink-0 text-small text-faint tnum">{hint}</span>}
    </button>
  );
}

function ProjectFilter({ value, facets, onChange }: { value: string | null; facets: { project: string; count: number }[]; onChange: (p: string | null) => void }) {
  const [q, setQ] = useState("");
  const shown = facets.filter((f) => !q || f.project.toLowerCase().includes(q.toLowerCase()));
  return (
    <Menu label={value ? folderName(value) : "All projects"} active={!!value} icon={<IFolder size={14} />} width={320} title={value ? homeShort(value) : "Filter by project"}>
      {(close) => (
        <>
          {facets.length > 8 && (
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a project…" className="mb-1 h-[32px] w-full rounded-[8px] bg-hover px-2.5 text-base text-fg outline-none placeholder:text-faint" />
          )}
          <div className="scroll max-h-[320px]">
            <MenuItem on={!value} onClick={() => (onChange(null), close())}>
              All projects
            </MenuItem>
            {shown.map((f) => (
              <MenuItem key={f.project} on={value === f.project} hint={f.count} onClick={() => (onChange(f.project), close())}>
                <span title={homeShort(f.project)}>{folderName(f.project)}</span>
                <span className="ml-1.5 text-small text-faint">{homeShort(f.project).replace(/\/[^/]*$/, "")}</span>
              </MenuItem>
            ))}
            {value && !facets.some((f) => f.project === value) && (
              <MenuItem on onClick={() => (onChange(null), close())}>
                {folderName(value)}
              </MenuItem>
            )}
          </div>
        </>
      )}
    </Menu>
  );
}

const WHERES: Where[] = ["coool", "terminal", "ide", "app", "automation"];

function WhereFilter({ value, onChange }: { value: Where[]; onChange: (w: Where[]) => void }) {
  const label = value.length === 0 ? "Anywhere" : value.length === 1 ? `In ${WHERE_LABEL[value[0]]}`.replace("In Other", "Other").replace("In coool", "In coool") : `${value.length} places`;
  return (
    <Menu label={label} active={value.length > 0} title="Where it ran" width={240}>
      {() => (
        <>
          <MenuItem on={value.length === 0} onClick={() => onChange([])}>
            Anywhere
          </MenuItem>
          {WHERES.map((w) => (
            <MenuItem key={w} on={value.includes(w)} onClick={() => onChange(value.includes(w) ? value.filter((x) => x !== w) : [...value, w])}>
              {WHERE_LABEL[w]}
              <span className="ml-1.5 text-small text-faint">{{ coool: "chats and terminals", terminal: "the CLI", ide: "VS Code and others", app: "Claude, Codex apps", automation: "scripts, SDK, exec" }[w]}</span>
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  );
}

const RANGES: [DateRange, string][] = [
  ["any", "Any time"],
  ["today", "Today"],
  ["week", "Past 7 days"],
  ["month", "Past 30 days"],
  ["year", "Past year"],
  ["custom", "Between dates…"],
];

function DateFilter({ f, onChange }: { f: HistoryFilters; onChange: (d: Pick<HistoryFilters, "range" | "from" | "to">) => void }) {
  const label = f.range === "custom" ? (f.from || f.to ? `${f.from || "…"} – ${f.to || "…"}` : "Between dates") : RANGES.find((r) => r[0] === f.range)![1];
  return (
    <Menu label={label} active={f.range !== "any"} icon={<IClock size={14} />} title="When it last ran" width={260}>
      {(close) => (
        <>
          {RANGES.map(([v, l]) => (
            <MenuItem key={v} on={f.range === v} onClick={() => (onChange({ range: v, from: f.from, to: f.to }), v !== "custom" && close())}>
              {l}
            </MenuItem>
          ))}
          <AnimatePresence initial={false}>
            {f.range === "custom" && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-1">
                  <input type="date" value={f.from} onChange={(e) => onChange({ range: "custom", from: e.target.value, to: f.to })} className="h-[30px] min-w-0 flex-1 rounded-[7px] bg-hover px-1.5 text-small text-fg outline-none" aria-label="From" />
                  <span className="text-faint">–</span>
                  <input type="date" value={f.to} onChange={(e) => onChange({ range: "custom", from: f.from, to: e.target.value })} className="h-[30px] min-w-0 flex-1 rounded-[7px] bg-hover px-1.5 text-small text-fg outline-none" aria-label="To" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </Menu>
  );
}
