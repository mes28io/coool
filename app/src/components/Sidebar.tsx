import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { memo, useMemo, useRef, useState } from "react";
import { useNow } from "../lib/clock";
import { ago, displayTitle, folderName, homeShort, projectOf } from "../lib/format";
import { attention, useChatDigest, type Attention, type ChatDigest } from "../lib/live";
import type { ChatInfo, PtyInfo, Session, Status } from "../lib/types";
import type { UiStatus } from "./primitives";
import { sessionKey } from "../lib/types";
import { useStableOrder } from "../lib/stable";
import { leaves, resolveTarget, useStore } from "../store";
import { ICompose, IFolder, IFolderOpen, IPlus } from "./icons";
import { Wordmark } from "./Wordmark";
import { cx, ease, ProviderMark, spring, StatusDot } from "./primitives";
import { SidebarSkeleton } from "./Skeletons";

export interface Project {
  cwd: string;
  name: string;
  live: Session[];
  ended: Session[];
  starting: PtyInfo[];
  startingChats: ChatInfo[];
  status: Status;
  needs: number;
  updated: number;
}

export function useProjects(): { projects: Project[]; digest: ChatDigest } {
  const sessions = useStore((s) => s.sessions);
  const pending = useStore((s) => s.pending);
  const ptys = useStore((s) => s.ptys);
  const pendingChats = useStore((s) => s.pendingChats);
  const chatInfos = useStore((s) => s.chatInfos);
  const digest = useChatDigest();
  const projects = useMemo(() => {
    const by = new Map<string, Project>();
    const get = (cwd: string) => {
      let p = by.get(cwd);
      if (!p) by.set(cwd, (p = { cwd, name: folderName(cwd), live: [], ended: [], starting: [], startingChats: [], status: "ended", needs: 0, updated: 0 }));
      return p;
    };
    const att = new Map<Session, Attention>();
    for (const s of sessions) {
      const a = attention(s, digest);
      att.set(s, a);
      const p = get(projectOf(s) || "unknown");
      (a.status === "ended" ? p.ended : p.live).push(s);
      if (a.needs) p.needs++;
      p.updated = Math.max(p.updated, s.updated);
    }
    for (const id of pendingChats) {
      const info = chatInfos[id];
      if (!info) continue;
      const p = get(info.project || info.cwd);
      p.startingChats.push(info);
    }
    for (const id of pending) {
      const info = ptys[id];
      if (!info) continue;
      const p = get(info.project || info.cwd);
      p.starting.push(info);
      p.updated = Math.max(p.updated, info.started);
    }
    // Order changes only when a status changes (so rows glide on meaningful
    // events), never on every transcript write.
    // "Needs you" first, then working, then waiting.
    const rank = { busy: 1, idle: 2, ended: 3 } as const;
    const r = (s: Session) => (att.get(s)!.needs ? 0 : rank[att.get(s)!.status]);
    const byStatus = (a: Session, b: Session) => r(a) - r(b) || displayTitle(a).localeCompare(displayTitle(b));
    for (const p of by.values()) {
      p.status = p.live.some((s) => att.get(s)!.status === "busy") || p.starting.length || p.startingChats.length ? "busy" : p.live.length ? "idle" : "ended";
      p.live.sort(byStatus);
    }
    return [...by.values()].sort((a, b) => {
      if (!!a.needs !== !!b.needs) return a.needs ? -1 : 1;
      const la = a.status === "ended" ? 1 : 0;
      const lb = b.status === "ended" ? 1 : 0;
      if (la !== lb) return la - lb;
      return la ? b.updated - a.updated : a.name.localeCompare(b.name);
    });
  }, [sessions, pending, ptys, pendingChats, chatInfos, digest]);
  return { projects, digest };
}

function useSelectedKey(): string | null {
  return useStore((st) => {
    const tab = st.tabs.find((t) => t.id === st.activeTab);
    if (!tab) return null;
    const leaf = leaves(tab.root).find((l) => l.id === tab.focus);
    const r = resolveTarget(leaf?.target ?? null, st);
    if (r.session) return sessionKey(r.session);
    if (r.starting) return `pty:${r.starting.id}`;
    if (r.chat !== null) return `chat:${r.chat}`;
    return null;
  });
}

const ENDED_CAP = 4;

export function Sidebar() {
  const { projects, digest } = useProjects();
  const width = useStore((s) => s.sidebarWidth);
  const open = useStore((s) => s.sidebarOpen);
  const setWidth = useStore((s) => s.setSidebarWidth);
  const setSheet = useStore((s) => s.setSheet);
  const ready = useStore((s) => s.ready);
  const loading = useStore((s) => s.loading);
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const shownProjects = useStableOrder(projects, (p) => p.cwd, hover);
  const selected = useSelectedKey();

  // Arrow keys move through the rows (every row is a real button).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("button[data-nav]")];
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  return (
    <motion.aside
      initial={false}
      animate={{ width: open ? width : 0 }}
      transition={dragging ? { duration: 0 } : spring}
      className="relative h-full shrink-0 overflow-hidden"
      aria-hidden={!open}
      inert={!open}
    >
      <div className="absolute inset-y-0 left-0 flex flex-col overflow-hidden border-r border-hairline bg-bg" style={{ width }}>
        <div data-tauri-drag-region className="flex h-[48px] shrink-0 items-center justify-between pl-4 pr-2">
          <Wordmark size={24} intro />
        </div>

        <div className="px-2 pb-1">
          <button
            type="button"
            title="New session (⌘T)"
            onClick={() => setSheet({ kind: "new" })}
            className="flex h-[34px] w-full items-center gap-2.5 rounded-[10px] px-2.5 text-base text-fg transition-colors duration-150 hover:bg-hover"
          >
            <ICompose size={18} className="text-dim" />
            New session
          </button>
        </div>

        <div className="px-4 pb-1 pt-5 text-small text-dim">Projects</div>

        <motion.div layoutScroll className="scroll min-h-0 flex-1 px-2 pb-4" onKeyDown={onKeyDown} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
          {!ready || (loading && projects.length === 0) ? (
            <SidebarSkeleton />
          ) : projects.length === 0 ? (
            <div className="mx-1 mt-2 rounded-[10px] border border-dashed border-line px-3 py-4 text-center text-base text-dim">
              No sessions in the last day.
              <br />
              <button className="mt-1 font-medium text-fg hover:underline" onClick={() => setSheet({ kind: "new" })}>
                Start one
              </button>
            </div>
          ) : (
            <LayoutGroup>
              {shownProjects.map((p) => (
                <ProjectGroup key={p.cwd} p={p} selected={selected} digest={digest} frozen={hover} />
              ))}
              {loading && <SidebarSkeleton groups={1} />}
            </LayoutGroup>
          )}
        </motion.div>
        <ResizeHandle width={width} onChange={setWidth} onDragging={setDragging} />
      </div>
    </motion.aside>
  );
}

function ResizeHandle({ width, onChange, onDragging }: { width: number; onChange: (w: number) => void; onDragging: (d: boolean) => void }) {
  const start = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      className="group absolute inset-y-0 right-0 z-10 w-[6px] cursor-col-resize"
      onPointerDown={(e) => {
        start.current = { x: e.clientX, w: width };
        onDragging(true);
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => start.current && onChange(start.current.w + e.clientX - start.current.x)}
      onPointerUp={() => {
        start.current = null;
        onDragging(false);
      }}
    >
      <div className="mx-auto h-full w-[2px] bg-fg opacity-0 transition-opacity duration-150 group-hover:opacity-40" />
    </div>
  );
}

const ProjectGroup = memo(function ProjectGroup({ p, selected, digest, frozen }: { p: Project; selected: string | null; digest: ChatDigest; frozen: boolean }) {
  const live = useStableOrder(p.live, sessionKey, frozen);
  const [collapsed, setCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const setSheet = useStore((s) => s.setSheet);
  const ended = showAll ? p.ended : p.ended.slice(0, ENDED_CAP);
  const onlyEnded = p.live.length + p.starting.length + p.startingChats.length === 0;
  const Folder = collapsed ? IFolder : IFolderOpen;

  return (
    <motion.div layout="position" transition={spring} className="mb-1">
      <div className="group/proj relative">
        <button
          type="button"
          data-nav
          onClick={() => setCollapsed(!collapsed)}
          title={homeShort(p.cwd)}
          aria-expanded={!collapsed}
          className="flex h-[34px] w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left transition-colors duration-150 hover:bg-hover"
        >
          <Folder size={18} className="shrink-0 text-dim" />
          <span className={cx("min-w-0 flex-1 truncate text-base font-medium", onlyEnded ? "text-dim" : "text-fg")}>{p.name}</span>
        </button>
        <button
          type="button"
          onClick={() => setSheet({ kind: "new", cwd: p.cwd })}
          title={`New session in ${p.name}`}
          aria-label={`New session in ${p.name}`}
          className="absolute right-1.5 top-1/2 flex size-[28px] -translate-y-1/2 items-center justify-center rounded-[8px] text-dim opacity-0 transition-[opacity,background-color] duration-150 hover:bg-press hover:text-fg focus-visible:opacity-100 group-hover/proj:opacity-100"
        >
          <IPlus size={16} />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="rows"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-px pt-px">
              <AnimatePresence initial={false}>
                {p.startingChats.map((c) => (
                  <Row key={`chat:${c.id}`} selected={selected === `chat:${c.id}`} onClick={() => useStore.getState().open({ kind: "chat", id: c.id })} title={`New ${c.provider === "claude" ? "Claude Code" : "Codex"} chat`} status={c.state === "idle" ? "idle" : "starting"} provider={c.provider} meta="now" />
                ))}
                {p.starting.map((s) => (
                  <Row key={`pty:${s.id}`} selected={selected === `pty:${s.id}`} onClick={() => useStore.getState().open({ kind: "pty", id: s.id })} title={`New ${s.provider} session`} status="starting" provider={s.provider} meta="now" />
                ))}
                {live.map((s) => (
                  <SessionRow key={sessionKey(s)} s={s} att={attention(s, digest)} selected={selected === sessionKey(s)} />
                ))}
                {ended.map((s) => (
                  <SessionRow key={sessionKey(s)} s={s} att={attention(s, digest)} selected={selected === sessionKey(s)} />
                ))}
              </AnimatePresence>
              {p.ended.length > ENDED_CAP && (
                <button
                  type="button"
                  data-nav
                  onClick={() => setShowAll(!showAll)}
                  className="flex h-[28px] w-full items-center rounded-[10px] pl-[38px] text-left text-small text-faint transition-colors duration-150 hover:bg-hover hover:text-dim"
                >
                  {showAll ? "Show less" : "Show more"}
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
});

const rowMotion = {
  layout: "position" as const,
  initial: { opacity: 0, x: -6 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, transition: { duration: 0.12 } },
  transition: { ...spring, opacity: { duration: 0.2 } },
};

/**
 * One session: title only. State is a single dot at the right edge (yellow working,
 * green needs you, nothing otherwise); hovering swaps it for the provider mark and the age.
 * Rows are opaque so rows that trade places slide past each other.
 */
function Row({
  selected,
  onClick,
  title,
  status,
  provider,
  meta,
  cwdName,
  dim,
  data,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  status: UiStatus;
  provider: "claude" | "codex";
  meta: string;
  /** Last folder of the session's cwd when it is not the project folder; shown dim on hover. */
  cwdName?: string;
  dim?: boolean;
  /** `data-*` hooks (self-test). */
  data?: Record<string, string | undefined>;
}) {
  const dot = status === "busy" || status === "starting" || status === "needs";
  return (
    <motion.button
      type="button"
      data-nav
      {...data}
      {...rowMotion}
      onClick={onClick}
      title={title}
      className={cx(
        "group relative flex h-[30px] w-full items-center rounded-[10px] pl-[38px] pr-3 text-left text-base",
        selected ? "[--row-tint:var(--hover)] text-fg" : cx("[--row-tint:transparent] hover:[--row-tint:var(--hover)] hover:text-fg", dim ? "text-faint" : "text-dim"),
      )}
      style={{ background: "linear-gradient(var(--row-tint), var(--row-tint)), var(--bg)" }}
    >
      <span className={cx("min-w-0 flex-1 truncate group-hover:mr-[84px]", cwdName && "group-hover:mr-[150px]")}>{title}</span>
      {dot && (
        <span className="ml-2 flex shrink-0 items-center group-hover:hidden">
          <StatusDot status={status} size={8} />
        </span>
      )}
      <span
        className="absolute inset-y-0 right-0 hidden items-center gap-2 rounded-r-[10px] pl-6 pr-3 text-small text-faint group-hover:flex"
        style={{ background: "linear-gradient(90deg, transparent, color-mix(in oklab, var(--text) 8%, var(--bg)) 22px)" }}
      >
        {cwdName && <span className="max-w-[60px] truncate opacity-60">{cwdName}</span>}
        <span className="tnum">{meta}</span>
        <ProviderMark provider={provider} size={14} />
      </span>
    </motion.button>
  );
}

const SessionRow = memo(function SessionRow({ s, att, selected }: { s: Session; att: Attention; selected: boolean }) {
  const open = useStore((st) => st.open);
  const now = useNow();
  const status = att.needs ? "needs" : att.status;
  return (
    <Row
      selected={selected}
      onClick={() => open({ kind: "session", key: sessionKey(s) })}
      title={displayTitle(s)}
      status={status}
      provider={s.provider}
      meta={ago(s.updated, now)}
      cwdName={s.cwd && s.cwd !== projectOf(s) ? folderName(s.cwd) : undefined}
      dim={att.status === "ended"}
      data={{ "data-session-row": sessionKey(s), "data-needs": att.needs ? "1" : undefined }}
    />
  );
});
