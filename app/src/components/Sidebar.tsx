import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import { useClock } from "../lib/clock";
import { ago, displayTitle, folderName, homeShort, projectOf, titleWas } from "../lib/format";
import { TitleInput, TitleMenu, useTitleEdit } from "./TitleEdit";
import { attention, sameAttention, useChatDigest, useUnseen, type Attention, type ChatDigest } from "../lib/live";
import type { ChatInfo, PtyInfo, Session, Status } from "../lib/types";
import type { UiStatus } from "./primitives";
import { sessionKey } from "../lib/types";
import { useMoveKeys, useStableOrder } from "../lib/stable";
import { seenAt, isUnseen, leaves, resolveTarget, useStore } from "../store";
import { IChevron, ICompose, IFolder, IFolderOpen, IPlus } from "./icons";
import { Wordmark } from "./Wordmark";
import { AutoTag, cx, ease, ProviderMark, spring, StatusDot } from "./primitives";
import { SidebarSkeleton } from "./Skeletons";
import { NeedsView } from "./LeftPanels";
import { reducedMotion } from "./StepRail";
import { AnimateScope } from "../lib/motion";

export interface Project {
  cwd: string;
  name: string;
  /** Most urgent first: needs you, working, waiting. */
  live: Session[];
  /** Most recently updated first. */
  ended: Session[];
  starting: PtyInfo[];
  startingChats: ChatInfo[];
  status: Status;
  needs: number;
  /** Live chats working / waiting (not counting those that need the person; starting ones count as working). */
  working: number;
  waiting: number;
  /** The most recently updated session that needs the person. */
  needsKey: string | null;
  updated: number;
  /** Child runs listed under their parent's row, by parent session id (not counted anywhere else). */
  children: Map<string, Session[]>;
  /** Running subagents of the project's live sessions, by the dot their session counts under (not sessions: never in `working`). */
  agents: Record<"needs" | "busy" | "idle", number>;
}

export function useProjects(): { projects: Project[]; digest: ChatDigest } {
  const sessions = useStore((s) => s.sessions);
  const pending = useStore((s) => s.pending);
  const ptys = useStore((s) => s.ptys);
  const pendingChats = useStore((s) => s.pendingChats);
  const chatInfos = useStore((s) => s.chatInfos);
  const seen = useStore((s) => s.seen);
  const digest = useChatDigest();
  const projects = useMemo(() => {
    const by = new Map<string, Project>();
    const get = (cwd: string) => {
      let p = by.get(cwd);
      if (!p) by.set(cwd, (p = { cwd, name: folderName(cwd), live: [], ended: [], starting: [], startingChats: [], status: "ended", needs: 0, working: 0, waiting: 0, needsKey: null, updated: 0, children: new Map(), agents: { needs: 0, busy: 0, idle: 0 } }));
      return p;
    };
    const att = new Map<Session, Attention>();
    const parentOf = new Map(sessions.filter((s) => !s.nested).map((s) => [s.id, s]));
    for (const s of sessions) {
      const a = attention(s, digest);
      att.set(s, a);
      const parent = s.nested && s.parent ? parentOf.get(s.parent) : undefined;
      if (parent) {
        // Under its parent's row, in the parent's project.
        const p = get(projectOf(parent) || "unknown");
        const list = p.children.get(parent.id) ?? [];
        list.push(s);
        p.children.set(parent.id, list);
        continue;
      }
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
      p.ended.sort((a, b) => b.updated - a.updated);
      let needsAt = -1;
      for (const s of p.live) {
        const a = att.get(s)!;
        if (a.needs) {
          if (s.updated > needsAt) [needsAt, p.needsKey] = [s.updated, sessionKey(s)];
        } else if (a.status === "busy") {
          p.working++;
        } else if (isUnseen(seen, sessionKey(s), seenAt(s))) {
          // Waiting counts only until the person has looked at the chat (the green dot is an unread mark).
          p.waiting++;
        }
      }
      p.working += p.starting.length + p.startingChats.filter((c) => c.state !== "idle").length;
      p.waiting += p.startingChats.filter((c) => c.state === "idle").length;
    }
    // Needs you first, then anything live, then most recent activity.
    // A project whose contents did not change keeps its object, so its memoised group skips the re-render.
    for (const [cwd, p] of by) {
      const old = lastProjects.get(cwd);
      if (old && sameProject(old, p)) by.set(cwd, old);
      else lastProjects.set(cwd, p);
    }
    return [...by.values()].sort((a, b) => {
      if (!!a.needs !== !!b.needs) return a.needs ? -1 : 1;
      const la = a.status === "ended" ? 1 : 0;
      const lb = b.status === "ended" ? 1 : 0;
      return la - lb || b.updated - a.updated || a.name.localeCompare(b.name);
    });
  }, [sessions, pending, ptys, pendingChats, chatInfos, digest, seen]);
  return { projects, digest };
}

/** The last object built per project (any content-equal Project is interchangeable, so one cache serves every caller). */
const lastProjects = new Map<string, Project>();
const sameList = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i]);
function sameProject(a: Project, b: Project): boolean {
  if (a.name !== b.name || a.status !== b.status || a.needs !== b.needs || a.working !== b.working || a.waiting !== b.waiting || a.needsKey !== b.needsKey || a.updated !== b.updated) return false;
  if (a.agents.needs !== b.agents.needs || a.agents.busy !== b.agents.busy || a.agents.idle !== b.agents.idle) return false;
  if (!sameList(a.live, b.live) || !sameList(a.ended, b.ended) || !sameList(a.starting, b.starting) || !sameList(a.startingChats, b.startingChats)) return false;
  if (a.children.size !== b.children.size) return false;
  for (const [k, v] of a.children) {
    const w = b.children.get(k);
    if (!w || !sameList(v, w)) return false;
  }
  return true;
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

/** Rows a project shows at rest (live ones always show, even past this). */
const REST = 5;
/** Ended chats each "Show N more" reveals. */
const PAGE = 10;

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
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("button[data-nav]")].filter((r) => !r.closest("[data-ghost]"));
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  const view = useStore((s) => s.sidebarView);
  const setView = useStore((s) => s.setSidebarView);
  const fade = { duration: reducedMotion() ? 0 : 0.2 };

  const projectsView = (
    <div className="flex h-full flex-col" data-sidebar-view="projects">
      <div data-tauri-drag-region className="flex h-[48px] shrink-0 items-center justify-between pl-4 pr-2">
        <Wordmark size={24} />
      </div>

      <div className="px-2 pb-1">
        <button
          type="button"
          title="New session (⌘T)"
          onClick={() => setSheet({ kind: "new" })}
          className="flex h-[34px] w-full items-center gap-2.5 rounded-[9px] px-2.5 text-base text-fg transition-colors duration-150 hover:bg-hover"
        >
          <ICompose size={18} className="text-dim" />
          New session
        </button>
      </div>

      <div className="px-4 pb-1 pt-5 text-small text-dim">Projects</div>

      <div className="scroll min-h-0 flex-1 px-2 pb-4" onKeyDown={onKeyDown} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
        {!ready || (loading && projects.length === 0) ? (
          <SidebarSkeleton />
        ) : projects.length === 0 ? (
          <>
            <div className="mx-1 mt-2 rounded-[10px] border border-dashed border-line px-3 py-4 text-center text-base text-dim">
              No sessions in the last day.
              <br />
              <button className="mt-1 font-medium text-fg hover:underline" onClick={() => setSheet({ kind: "new" })}>
                Start one
              </button>
            </div>
            <OtherToolsLine />
          </>
        ) : (
          <>
            {/* Projects that change places snap (a tall group gliding across another would draw rows over rows). */}
            {shownProjects.map((p) => (
              <ProjectGroup key={p.cwd} p={p} selected={selected} digest={digest} frozen={hover} />
            ))}
            {loading && <SidebarSkeleton groups={1} />}
            <OtherToolsLine />
          </>
        )}
      </div>
    </div>
  );

  return (
    <motion.aside
      initial={false}
      animate={{ width: open ? width : 0 }}
      transition={dragging ? { duration: 0 } : spring}
      className="relative h-full shrink-0 overflow-hidden"
      aria-hidden={!open}
      inert={!open}
      data-sidebar-open={open ? view : "closed"}
      data-anim-static
      onKeyDown={(e) => {
        if (e.key === "Escape" && view !== "projects" && !e.defaultPrevented) {
          e.stopPropagation();
          setView("projects");
        }
      }}
    >
      {/* Rows show activity static: it animates only in the open session (lib/motion.ts). */}
      <AnimateScope enabled={false}>
      <div className="absolute inset-y-0 left-0 overflow-hidden border-r border-hairline bg-bg" style={{ width }}>
        <AnimatePresence initial={false}>
          <motion.div key={view} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
            {view === "needs" ? <NeedsView /> : projectsView}
          </motion.div>
        </AnimatePresence>
        <ResizeHandle width={width} onChange={setWidth} onDragging={setDragging} />
      </div>
      </AnimateScope>
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

/** "12 runs by other tools hidden · Show": nothing the setting hides vanishes without a trace. */
function OtherToolsLine() {
  const hidden = useStore((s) => s.hiddenAutomation);
  const show = useStore((s) => s.showAutomation);
  const shown = useStore((s) => (s.showAutomation ? s.sessions.filter((x) => x.origin === "automation").length : 0));
  const setShow = useStore((s) => s.setShowAutomation);
  const n = show ? shown : hidden;
  if (n === 0) return null;
  const runs = n === 1 ? "run" : "runs";
  return (
    <div className="mt-2 flex h-[28px] items-center gap-1 px-2.5 text-small text-faint" data-other-tools={show ? "shown" : "hidden"}>
      <span className="tnum min-w-0 truncate">
        {n} {runs} by other tools {show ? "shown" : "hidden"}
      </span>
      <span aria-hidden>·</span>
      <button
        type="button"
        data-nav
        onClick={() => setShow(!show)}
        title={show ? "Hide sessions started by other tools and agents" : "Show sessions started by other tools and agents (Settings)"}
        className="rounded-[6px] px-1 text-dim transition-colors duration-150 hover:bg-hover hover:text-fg"
      >
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}

/** "coool: 1 needs you, 2 working". */
function summaryLabel(p: Project): string {
  const agents = p.agents.needs + p.agents.busy + p.agents.idle;
  const parts = [p.needs && `${p.needs} needs you`, p.working && `${p.working} working`, p.waiting && `${p.waiting} waiting`, agents && `${agents} ${agents === 1 ? "agent" : "agents"}`].filter(Boolean);
  return parts.length ? `${p.name}: ${parts.join(", ")}` : p.name;
}

/** A collapsed project's contents at a glance: one dot per state present, a count when more than one. */
function Summary({ p }: { p: Project }) {
  const open = useStore((s) => s.open);
  const dots: [UiStatus, number][] = [
    ["needs", p.needs],
    ["busy", p.working],
    ["idle", p.waiting],
  ];
  const shown = dots.filter(([, n]) => n > 0);
  if (!shown.length) return null;
  const body = shown.map(([st, n]) => (
    <span key={st} className="flex items-center gap-[3px]" data-summary={st}>
      <StatusDot status={st} size={8} />
      {(n > 1 || p.agents[st as "needs" | "busy" | "idle"] > 0) && <span className="tnum text-small leading-none text-dim">{n}</span>}
      {p.agents[st as "needs" | "busy" | "idle"] > 0 && <span className="tnum text-small leading-none text-faint">+{p.agents[st as "needs" | "busy" | "idle"]}</span>}
    </span>
  ));
  const label = summaryLabel(p);
  const cls = "relative ml-2 flex shrink-0 items-center gap-2 rounded-[7px] px-1.5 py-1";
  // Something needs the person: the summary takes them straight there.
  if (p.needsKey) {
    const key = p.needsKey;
    return (
      <button type="button" className={cx(cls, "hover:bg-press")} title={`${label}. Open the chat that needs you`} aria-label={`${label}. Open the chat that needs you`} onClick={() => open({ kind: "session", key })} data-project-summary>
        {body}
      </button>
    );
  }
  return (
    <span className={cx(cls, "pointer-events-none")} title={label} aria-label={label} role="img" data-project-summary>
      {body}
    </span>
  );
}

type Item = { key: string; el: ReactNode };

const ProjectGroup = memo(function ProjectGroup({ p, selected, digest, frozen }: { p: Project; selected: string | null; digest: ChatDigest; frozen: boolean }) {
  const live = useStableOrder(p.live, sessionKey, frozen);
  const collapsed = useStore((s) => !!s.collapsed[p.cwd]);
  const revealed = useStore((s) => s.revealed[p.cwd] ?? 0);
  const toggle = useStore((s) => s.toggleCollapsed);
  const setRevealed = useStore((s) => s.setRevealed);
  const setSheet = useStore((s) => s.setSheet);
  const showAutomation = useStore((s) => s.showAutomation);
  const kidsOpen = useStore((s) => s.kidsOpen);
  // "Show N more jobs" under each parent row, by parent key.
  const [allJobs, setAllJobs] = useState<Record<string, boolean>>({});
  const onlyEnded = p.live.length + p.starting.length + p.startingChats.length === 0;
  const Folder = collapsed ? IFolder : IFolderOpen;

  // Live rows always show; ended ones fill the rest of the resting cap, then pages of PAGE.
  const liveRows = p.startingChats.length + p.starting.length + live.length;
  const endedSlots = Math.max(0, REST - liveRows) + revealed;
  // The open chat stays visible; for an open child run, its parent's row does.
  const pinnedParent = useMemo(() => {
    for (const [pid, kids] of p.children) if (kids.some((k) => sessionKey(k) === selected)) return pid;
    return null;
  }, [p.children, selected]);
  const ended = p.ended.filter((s, i) => i < endedSlots || sessionKey(s) === selected || s.id === pinnedParent);
  const more = p.ended.length - ended.length;
  // One flat list of rows (a session, then its nested child runs), each in its own slot.
  const sessionRows = (s: Session): Item[] => {
    const att = attention(s, digest);
    const kids = p.children.get(s.id) ?? [];
    const key = sessionKey(s);
    // Running subagents are not listed in the sidebar (owner's call): they show in the chat header's agents chip and on Home.
    const liveKids = kids.some((k) => attention(k, digest).status !== "ended");
    // Open by default while anything in the block is live (or the open chat is in it); the person's choice wins.
    const open = kidsOpen[key] ?? (liveKids || kids.some((k) => sessionKey(k) === selected));
    const out: Item[] = [{ key, el: <SessionRow s={s} att={att} selected={selected === key} auto={showAutomation && s.origin === "automation"} nest={kids.length ? (open ? "open" : "closed") : undefined} /> }];
    if (open && kids.length) out.push(...childItems(key, kids, selected, digest, !!allJobs[key], (all) => setAllJobs((m) => ({ ...m, [key]: all }))));
    return out;
  };
  const items: Item[] = [
    ...p.startingChats.map((c) => ({
      key: `chat:${c.id}`,
      el: <Row selected={selected === `chat:${c.id}`} onClick={() => useStore.getState().open({ kind: "chat", id: c.id })} title={`New ${c.provider === "claude" ? "Claude Code" : "Codex"} chat`} status={c.state === "idle" ? "idle" : "starting"} provider={c.provider} meta="now" />,
    })),
    ...p.starting.map((s) => ({
      key: `pty:${s.id}`,
      el: <Row selected={selected === `pty:${s.id}`} onClick={() => useStore.getState().open({ kind: "pty", id: s.id })} title={`New ${s.provider} session`} status="starting" provider={s.provider} meta="now" />,
    })),
    ...live.flatMap(sessionRows),
    ...ended.flatMap(sessionRows),
  ];
  // A row that moves past others closes at its old place and opens at its new one (see useMoveKeys): rows
  // never glide across each other, so no frame shows rows overlapping or a hole between them.
  const slotKey = useMoveKeys(items.map((it) => it.key));

  return (
    <div className="mb-1" data-project={p.cwd}>
      {/* The "+" has its own slot at the right at all times (it only fades in), so the name ellipsizes before it. */}
      <div className="group/proj relative flex h-[34px] items-center rounded-[9px] pl-2.5 pr-1.5 transition-colors duration-150 hover:bg-hover">
        <button
          type="button"
          data-nav
          onClick={() => toggle(p.cwd)}
          title={homeShort(p.cwd)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? summaryLabel(p) : p.name}
          className="absolute inset-0 rounded-[9px]"
        />
        <Folder size={18} className="pointer-events-none relative mr-2.5 shrink-0 text-dim" />
        <span className={cx("pointer-events-none relative min-w-0 flex-1 truncate text-base font-medium", onlyEnded ? "text-dim" : "text-fg")}>{p.name}</span>
        {collapsed && <Summary p={p} />}
        <button
          type="button"
          onClick={() => setSheet({ kind: "new", cwd: p.cwd })}
          title={`New session in ${p.name}`}
          aria-label={`New session in ${p.name}`}
          className="relative ml-1 flex size-[28px] shrink-0 items-center justify-center rounded-[8px] text-dim opacity-0 transition-[opacity,background-color] duration-150 hover:bg-press hover:text-fg focus-visible:opacity-100 group-hover/proj:opacity-100"
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
            transition={{ duration: reducedMotion() ? 0 : 0.22, ease }}
            className="overflow-hidden"
          >
            <div className="flex flex-col" data-project-rows>
              <AnimatePresence initial={false}>
                {items.map((it) => (
                  <Slot key={slotKey(it.key)}>{it.el}</Slot>
                ))}
              </AnimatePresence>
              {(more > 0 || revealed > 0) && (
                <div className="flex pt-px">
                  {more > 0 && (
                    <button type="button" data-nav data-show-more onClick={() => setRevealed(p.cwd, revealed + PAGE)} className={cx(disclosure, "min-w-0 flex-1 pl-[38px]")}>
                      Show {more} more
                    </button>
                  )}
                  {revealed > 0 && (
                    <button type="button" data-nav data-show-less onClick={() => setRevealed(p.cwd, 0)} className={cx(disclosure, more > 0 ? "shrink-0 px-3" : "flex-1 pl-[38px]")}>
                      Show less
                    </button>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

/**
 * One row's place in its project's list. It opens and closes by height (in flow, never by transform), so the
 * rows around it move with it frame by frame. A closing slot keeps showing its row, fading, and is inert.
 */
function Slot({ children }: { children: ReactNode }) {
  const present = useIsPresent();
  const t = reducedMotion() ? { duration: 0 } : { height: { duration: 0.24, ease }, opacity: { duration: 0.18 } };
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={t}
      className="shrink-0 overflow-hidden pt-px"
      data-ghost={present ? undefined : ""}
      inert={!present}
      aria-hidden={!present || undefined}
    >
      {children}
    </motion.div>
  );
}

/** Recent ended child runs shown under their parent before "Show N more jobs". */
const KIDS_ENDED = 2;

/** A session's nested block: live child runs, then the most recent ended ones. */
function childItems(parentKey: string, kids: Session[], selected: string | null, digest: ChatDigest, all: boolean, setAll: (all: boolean) => void): Item[] {
  const live = kids.filter((k) => attention(k, digest).status !== "ended").sort((a, b) => b.updated - a.updated);
  const ended = kids.filter((k) => attention(k, digest).status === "ended").sort((a, b) => b.updated - a.updated);
  const shown = all ? ended : ended.filter((k, i) => i < KIDS_ENDED || sessionKey(k) === selected);
  const more = ended.length - shown.length;
  const out: Item[] = [...live, ...shown].map((k) => ({ key: sessionKey(k), el: <SessionRow s={k} att={attention(k, digest)} selected={selected === sessionKey(k)} nested /> }));
  if (more > 0 || all)
    out.push({
      key: `jobs-more:${parentKey}`,
      el: (
        <button type="button" data-nav data-show-jobs onClick={() => setAll(!all)} className={cx(disclosure, "w-full pl-[54px]")}>
          {all ? "Fewer jobs" : `Show ${more} more ${more === 1 ? "job" : "jobs"}`}
        </button>
      ),
    });
  return out;
}

const disclosure = "flex h-[28px] items-center rounded-[8px] text-left text-small text-faint transition-colors duration-150 hover:bg-hover hover:text-dim";

/**
 * One session: title only. State is a single dot at the right edge (blue spinner working,
 * yellow needs you, green waiting, nothing for ended); hovering swaps it for the provider mark and the age.
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
  auto,
  nested,
  tip,
  data,
  hover,
  nest,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  status: UiStatus;
  provider: "claude" | "codex";
  meta: string;
  /** Last folder of the session's cwd when it is not the project folder; shown in the tooltip. */
  cwdName?: string;
  dim?: boolean;
  /** Started by another tool or agent: dimmed, with a small tag. */
  auto?: boolean;
  /** A child run under its parent's row: indented one level, dim. */
  nested?: boolean;
  /** Extra state for the tooltip and accessible name ("2 jobs running"). */
  tip?: string | null;
  /** Replaces the age and provider mark in the right slot on hover. */
  hover?: ReactNode;
  /** The row owns a nested block: a chevron appears on hover to fold it. */
  nest?: { open: boolean; onToggle: () => void };
  /** `data-*` hooks (self-test). */
  data?: Record<string, string | undefined>;
}) {
  const dot = status === "busy" || status === "starting" || status === "needs" || status === "idle";
  return (
    <button
      type="button"
      data-nav
      {...data}
      onClick={onClick}
      title={[title, tip, cwdName && `in ${cwdName}`].filter(Boolean).join(" · ")}
      aria-label={[title, tip].filter(Boolean).join(", ")}
      className={cx(
        "group relative flex h-[30px] w-full items-center rounded-[8px] pr-2 text-left text-base",
        nested ? "pl-[54px]" : "pl-[38px]",
        selected ? "[--row-tint:var(--hover)] text-fg" : cx("[--row-tint:transparent] hover:[--row-tint:var(--hover)] hover:text-fg", dim || auto || nested ? "text-faint" : "text-dim"),
      )}
      style={{ background: "linear-gradient(var(--row-tint), var(--row-tint)), var(--bg)" }}
    >
      {nest && (
        <span
          role="button"
          tabIndex={-1}
          aria-label={nest.open ? "Hide agents and jobs" : "Show agents and jobs"}
          aria-expanded={nest.open}
          title={nest.open ? "Hide agents and jobs" : "Show agents and jobs"}
          data-nest-toggle
          onClick={(e) => {
            e.stopPropagation();
            nest.onToggle();
          }}
          className="absolute left-[9px] top-1/2 flex size-[20px] -translate-y-1/2 items-center justify-center rounded-[6px] text-faint opacity-0 transition-[opacity,background-color,color] duration-150 hover:bg-press hover:text-fg group-hover:opacity-100"
        >
          <motion.span animate={{ rotate: nest.open ? 90 : 0 }} transition={{ duration: 0.18, ease }} className="flex">
            <IChevron size={13} />
          </motion.span>
        </span>
      )}
      <span className={cx("min-w-0 flex-1 truncate", auto && "opacity-80")}>{title}</span>
      {auto && <AutoTag className="ml-1.5" />}
      {/* At rest the title runs up to the status dot (or the edge). On hover, age and provider slide in over the
          title's end on the row's own background, faded in from the left, so the title is never cut early. */}
      {dot && (
        <span className="ml-2 flex shrink-0 items-center pr-1 group-hover:invisible">
          <StatusDot status={status} size={8} />
        </span>
      )}
      <span
        className="pointer-events-none absolute inset-y-0 right-2 hidden items-center gap-1.5 pl-7 text-small text-faint group-hover:flex"
        style={{
          background: "linear-gradient(var(--row-tint), var(--row-tint)), var(--bg)",
          maskImage: "linear-gradient(to right, transparent, black 22px)",
          WebkitMaskImage: "linear-gradient(to right, transparent, black 22px)",
        }}
      >
        {hover ?? (
          <>
            <span className="tnum whitespace-nowrap">{meta}</span>
            <ProviderMark provider={provider} size={14} />
          </>
        )}
      </span>
    </button>
  );
}

type SessionRowProps = { s: Session; att: Attention; selected: boolean; auto?: boolean; nested?: boolean; nest?: "open" | "closed" };
const sameRow = (a: SessionRowProps, b: SessionRowProps) =>
  a.s === b.s && a.selected === b.selected && a.auto === b.auto && a.nested === b.nested && a.nest === b.nest && sameAttention(a.att, b.att);

const SessionRow = memo(function SessionRow({ s, att, selected, auto, nested, nest }: SessionRowProps) {
  const open = useStore((st) => st.open);
  const setKidsOpen = useStore((st) => st.setKidsOpen);
  // The age (shown on hover) re-renders the row only when its text changes, not every second.
  const age = useClock((now) => ago(s.updated, now));
  const unseen = useUnseen(s);
  // A waiting chat shows its green dot only until the person opens it.
  const status = att.needs ? "needs" : att.status === "idle" && !unseen ? "ended" : att.status;
  // CHAT_SPEC "Session titles": double-click or right-click to rename; the tooltip says what it was called.
  const edit = useTitleEdit(s);
  const tip = [att.needs ?? att.background, titleWas(s)].filter(Boolean).join(" · ") || null;
  return (
    <div className="relative" onDoubleClick={edit.start} onContextMenu={edit.openMenu}>
    <Row
      selected={selected}
      onClick={() => open({ kind: "session", key: sessionKey(s) })}
      title={displayTitle(s)}
      status={status}
      provider={s.provider}
      meta={age}
      cwdName={s.cwd && s.cwd !== projectOf(s) ? folderName(s.cwd) : undefined}
      dim={att.status === "ended"}
      auto={auto}
      nested={nested}
      nest={nest ? { open: nest === "open", onToggle: () => setKidsOpen(sessionKey(s), nest !== "open") } : undefined}
      tip={tip}
      data={{ "data-session-row": sessionKey(s), "data-needs": att.needs ? "1" : undefined, "data-origin": s.origin ?? "user", "data-background": att.background ?? undefined, "data-nested": nested ? "1" : undefined, "data-title-source": s.name?.source }}
    />
      {edit.editing && <TitleInput s={s} onDone={edit.stop} className={cx("absolute inset-y-[3px] right-2 text-base", nested ? "left-[50px]" : "left-[34px]")} />}
      {edit.menu && <TitleMenu s={s} at={edit.menu} onClose={edit.closeMenu} onRename={edit.start} />}
    </div>
  );
}, sameRow);
