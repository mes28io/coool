import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { memo, useMemo, useRef, useState } from "react";
import { isMac, isTauri } from "../lib/backend";
import { useNow } from "../lib/clock";
import { ago, displayTitle, folderName, headlineIsTitle, homeShort, isThinking, shortDetail, splitTool } from "../lib/format";
import { attention, useChatDigest, type Attention, type ChatDigest } from "../lib/live";
import { modelLabel } from "../lib/models";
import type { Agent, ChatInfo, PtyInfo, Session, Status } from "../lib/types";
import { sessionKey } from "../lib/types";
import { useStableOrder } from "../lib/stable";
import { leaves, resolveTarget, useStore } from "../store";
import { IChevron, IGear, IMoon, IPlus, ISearch, ISun } from "./icons";
import { Wordmark } from "./Wordmark";
import { cx, ease, IconButton, Kbd, NeedsBadge, ProviderMark, spring, StatusDot } from "./primitives";
import { Skel, SidebarSkeleton } from "./Skeletons";

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
      const p = get(s.cwd || "unknown");
      (a.status === "ended" ? p.ended : p.live).push(s);
      if (a.needs) p.needs++;
      p.updated = Math.max(p.updated, s.updated);
    }
    for (const id of pendingChats) {
      const info = chatInfos[id];
      if (!info) continue;
      const p = get(info.cwd);
      p.startingChats.push(info);
    }
    for (const id of pending) {
      const info = ptys[id];
      if (!info) continue;
      const p = get(info.cwd);
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

export function Sidebar() {
  const { projects, digest } = useProjects();
  const width = useStore((s) => s.sidebarWidth);
  const setWidth = useStore((s) => s.setSidebarWidth);
  const setSheet = useStore((s) => s.setSheet);
  const setPalette = useStore((s) => s.setPalette);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const ready = useStore((s) => s.ready);
  const loading = useStore((s) => s.loading);
  const [hover, setHover] = useState(false);
  const shownProjects = useStableOrder(projects, (p) => p.cwd, hover);
  const selected = useSelectedKey();
  const counts = useMemo(() => {
    let busy = 0;
    let idle = 0;
    let needs = 0;
    for (const p of projects)
      for (const s of p.live) {
        const a = attention(s, digest);
        if (a.needs) needs++;
        else if (a.status === "busy") busy++;
        else idle++;
      }
    return { busy, idle, needs };
  }, [projects, digest]);
  const traffic = isTauri && isMac;

  return (
    <aside className="relative flex h-full shrink-0 flex-col border-r border-hairline bg-panel" style={{ width }}>
      <div data-tauri-drag-region className={cx("flex h-[56px] shrink-0 items-center gap-2 pr-2.5", traffic ? "pl-[84px]" : "pl-4")}>
        <div data-tauri-drag-region className="flex flex-1 items-center gap-2">
          <Wordmark size={21} intro />
        </div>
        <IconButton title={`Switch to ${theme === "dark" ? "light" : "dark"} theme (⌘⇧L)`} onClick={toggleTheme}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={theme}
              initial={{ opacity: 0, rotate: -40, scale: 0.7 }}
              animate={{ opacity: 1, rotate: 0, scale: 1 }}
              exit={{ opacity: 0, rotate: 40, scale: 0.7 }}
              transition={{ duration: 0.22, ease }}
              className="flex"
            >
              {theme === "dark" ? <IMoon size={17} /> : <ISun size={17} />}
            </motion.span>
          </AnimatePresence>
        </IconButton>
      </div>

      <div className="flex flex-col gap-1.5 px-2.5 pb-3">
        <button
          type="button"
          onClick={() => setSheet({ kind: "new" })}
          className="group flex h-[38px] items-center gap-2 rounded-[9px] border border-line bg-raised px-2.5 text-base font-medium text-fg shadow-card transition-[border-color,transform] duration-150 hover:border-[color-mix(in_oklab,var(--accent)_45%,var(--border))] active:scale-[0.99]"
        >
          <span className="flex size-[22px] items-center justify-center rounded-[5px] bg-fg text-bg">
            <IPlus size={14} strokeWidth={2} />
          </span>
          New session
          <span className="ml-auto flex gap-0.5">
            <Kbd>⌘</Kbd>
            <Kbd>T</Kbd>
          </span>
        </button>
        <button
          type="button"
          onClick={() => setPalette(true)}
          className="flex h-[36px] items-center gap-2 rounded-[9px] px-2.5 text-base text-dim transition-colors duration-150 hover:bg-hover hover:text-fg"
        >
          <ISearch size={16} />
          Jump to…
          <span className="ml-auto flex gap-0.5">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
      </div>

      <div className="flex items-center justify-between px-4 pb-1.5">
        <span className="font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">Projects</span>
        <span className="text-small text-faint tnum">{ready && !loading ? projects.length || "" : ""}</span>
      </div>

      <motion.div layoutScroll className="scroll min-h-0 flex-1 px-1.5 pb-3" onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
        {!ready || (loading && projects.length === 0) ? (
          <SidebarSkeleton />
        ) : projects.length === 0 ? (
          <div className="mx-2 mt-2 rounded-[10px] border border-dashed border-line px-3 py-4 text-center text-base text-dim">
            No sessions in the last day.
            <br />
            <button className="mt-1 font-medium text-accent-text hover:underline" onClick={() => setSheet({ kind: "new" })}>
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

      <div className="flex h-[42px] shrink-0 items-center gap-2.5 whitespace-nowrap border-t border-hairline pl-4 pr-2 text-small text-dim">
        {counts.needs > 0 && (
          <span className="flex items-center gap-1.5 font-medium text-accent-text" title="Sessions blocked on you">
            <StatusDot status="needs" size={7} />
            <span className="tnum">{counts.needs}</span> need{counts.needs === 1 ? "s" : ""} you
          </span>
        )}
        {ready && !(loading && projects.length === 0) && (
        <>
        <span className="flex items-center gap-1.5">
          <StatusDot status={counts.busy ? "busy" : "ended"} size={7} />
          <span className="tnum">{counts.busy}</span> working
        </span>
        <span className="flex items-center gap-1.5">
          <StatusDot status={counts.idle ? "idle" : "ended"} size={7} />
          <span className="tnum">{counts.idle}</span> waiting
        </span>
        </>
        )}
        <IconButton title="Settings (⌘,)" className="ml-auto" onClick={() => setSheet({ kind: "settings" })}>
          <IGear size={16} />
        </IconButton>
      </div>

      <ResizeHandle width={width} onChange={setWidth} />
    </aside>
  );
}

function ResizeHandle({ width, onChange }: { width: number; onChange: (w: number) => void }) {
  const start = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      className="group absolute inset-y-0 -right-[3px] z-10 w-[6px] cursor-col-resize"
      onPointerDown={(e) => {
        start.current = { x: e.clientX, w: width };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => start.current && onChange(start.current.w + e.clientX - start.current.x)}
      onPointerUp={() => (start.current = null)}
    >
      <div className="mx-auto h-full w-[2px] bg-accent opacity-0 transition-opacity duration-150 group-hover:opacity-40" />
    </div>
  );
}

const ProjectGroup = memo(function ProjectGroup({ p, selected, digest, frozen }: { p: Project; selected: string | null; digest: ChatDigest; frozen: boolean }) {
  const live = useStableOrder(p.live, sessionKey, frozen);
  const [collapsed, setCollapsed] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const setSheet = useStore((s) => s.setSheet);
  const liveCount = p.live.length + p.starting.length + p.startingChats.length;
  const onlyEnded = liveCount === 0;
  const endedVisible = showEnded || (onlyEnded && p.ended.length <= 1);

  return (
    <motion.div layout="position" transition={spring} className="mb-1.5">
      <div className="group flex h-[34px] items-center gap-1.5 rounded-[7px] pl-1.5 pr-1 hover:bg-hover">
        <button type="button" onClick={() => setCollapsed(!collapsed)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={homeShort(p.cwd)}>
          <motion.span animate={{ rotate: collapsed ? 0 : 90 }} transition={{ duration: 0.18, ease }} className="flex text-faint">
            <IChevron size={13} />
          </motion.span>
          <span className={cx("truncate text-base font-semibold", onlyEnded ? "text-dim" : "text-fg/90")}>{p.name}</span>
          {liveCount > 0 && (
            <span className="flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--dim)_12%,transparent)] py-[1px] pl-[5px] pr-1.5 text-small font-medium text-dim">
              <StatusDot status={p.needs ? "needs" : p.status} size={6} />
              <span className="tnum">{liveCount}</span>
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setSheet({ kind: "new", cwd: p.cwd })}
          title={`New session in ${p.name}`}
          className="flex size-[26px] items-center justify-center rounded-[6px] text-dim opacity-0 transition-[opacity,background-color] duration-150 hover:bg-press hover:text-fg group-hover:opacity-100"
        >
          <IPlus size={15} />
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
                  <StartingChatRow key={`chat:${c.id}`} info={c} selected={selected === `chat:${c.id}`} />
                ))}
                {p.starting.map((s) => (
                  <StartingRow key={`pty:${s.id}`} info={s} selected={selected === `pty:${s.id}`} />
                ))}
                {live.map((s) => (
                  <SessionRow key={sessionKey(s)} s={s} att={attention(s, digest)} selected={selected === sessionKey(s)} />
                ))}
                {endedVisible && p.ended.map((s) => <SessionRow key={sessionKey(s)} s={s} att={attention(s, digest)} selected={selected === sessionKey(s)} />)}
              </AnimatePresence>
              {p.ended.length > 0 && !endedVisible && (
                <button
                  type="button"
                  onClick={() => setShowEnded(true)}
                  className="ml-[22px] flex h-[28px] items-center gap-1 rounded-[6px] px-1.5 text-small text-faint transition-colors duration-150 hover:bg-hover hover:text-dim"
                >
                  {p.ended.length} earlier
                </button>
              )}
              {showEnded && !(onlyEnded && p.ended.length <= 1) && (
                <button
                  type="button"
                  onClick={() => setShowEnded(false)}
                  className="ml-[22px] flex h-[28px] items-center rounded-[6px] px-1.5 text-small text-faint transition-colors duration-150 hover:bg-hover hover:text-dim"
                >
                  Hide earlier
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

function Row({
  selected,
  onClick,
  children,
  indent = 0,
  data,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  indent?: number;
  /** `data-*` hooks (self-test). */
  data?: Record<string, string | undefined>;
}) {
  return (
    <motion.button
      type="button"
      {...data}
      {...rowMotion}
      onClick={onClick}
      className={cx(
        "relative flex w-full items-start gap-2 rounded-[8px] py-[5px] pr-2 text-left",
        selected ? "[--row-tint:color-mix(in_oklab,var(--text)_7%,transparent)]" : "[--row-tint:transparent] hover:[--row-tint:var(--hover)]",
      )}
      // Opaque (tint over the panel colour): rows that trade places slide past
      // each other instead of drawing their text on top of one another.
      style={{ paddingLeft: 10 + indent, background: "linear-gradient(var(--row-tint), var(--row-tint)), var(--panel)" }}
    >
      {selected && <motion.span layoutId="sb-sel" transition={spring} className="absolute inset-y-[6px] left-0 w-[2.5px] rounded-full bg-accent" />}
      {children}
    </motion.button>
  );
}

type Tone = "live" | "needs" | "insight" | "dim" | "loading";
function subline(s: Session, a: Attention, now: number): { text: string; tone: Tone; title?: string } {
  if (a.needs) return { text: a.needs, tone: "needs" };
  // Details not parsed yet: don't guess what it's doing.
  if (s.loaded === false && a.status === "busy" && !s.current) return { text: "", tone: "loading", title: "Reading transcript…" };
  const headline = headlineIsTitle(s) ? undefined : s.insight?.headline;
  if (a.status === "busy") {
    if (!s.current || isThinking(s.current)) return headline ? { text: headline, tone: "insight", title: "Thinking…" } : { text: "Thinking…", tone: "live" };
    const { name, detail } = splitTool(s.current);
    return { text: detail ? `${name} ${shortDetail(detail)}` : name, tone: "live", title: headline };
  }
  if (headline && a.status === "idle") return { text: headline, tone: "insight", title: `Waiting · ${ago(s.updated, now)}` };
  if (a.status === "idle") return { text: `Waiting · ${ago(s.updated, now)}`, tone: "dim" };
  return { text: ago(s.updated, now), tone: "dim" };
}

const SessionRow = memo(function SessionRow({ s, att, selected }: { s: Session; att: Attention; selected: boolean }) {
  const open = useStore((st) => st.open);
  const now = useNow();
  const sub = subline(s, att, now);
  const agents = s.agents.filter((a) => !a.finished);
  const status = att.needs ? "needs" : att.status;
  return (
    <>
      <Row selected={selected} onClick={() => open({ kind: "session", key: sessionKey(s) })} data={{ "data-session-row": sessionKey(s), "data-needs": att.needs ? "1" : undefined }}>
        <span className="flex h-[22px] w-[8px] items-center justify-center">
          <StatusDot status={status} size={8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <ProviderMark provider={s.provider} size={13} />
            <span className={cx("truncate text-base", att.status === "ended" ? "text-dim" : "text-fg", selected && "font-medium")}>{displayTitle(s)}</span>
            {att.needs ? (
              <NeedsBadge small className="ml-auto" />
            ) : (
              s.managed !== null && <span className="ml-auto shrink-0 rounded-[4px] border border-line px-1 text-small font-medium text-faint">pty</span>
            )}
          </span>
          {sub.tone === "loading" ? (
            <span className="flex h-[18px] items-center" title={sub.title}>
              <Skel w="55%" h={8} className="opacity-70" />
            </span>
          ) : (
          <span
            title={sub.title ?? sub.text}
            className={cx(
              "block truncate text-small",
              sub.tone === "live" ? "text-busy-text/85" : sub.tone === "needs" ? "font-medium text-accent-text" : sub.tone === "insight" ? "text-dim" : "text-faint",
            )}
          >
            {sub.text}
          </span>
          )}
        </span>
      </Row>
      {agents.map((a) => (
        <AgentRow key={`${sessionKey(s)}/${a.id}`} a={a} onClick={() => open({ kind: "session", key: sessionKey(s) })} />
      ))}
    </>
  );
});

function AgentRow({ a, onClick }: { a: Agent; onClick: () => void }) {
  const cur = a.current && !isThinking(a.current) ? splitTool(a.current) : null;
  return (
    <Row selected={false} onClick={onClick} indent={16}>
      <span className="mt-[3px] h-[12px] w-[9px] shrink-0 rounded-bl-[5px] border-b border-l border-line" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <StatusDot status="busy" size={6} />
          <span className="truncate text-small text-fg/85">{a.description || a.kind}</span>
          {a.model && <span className="ml-auto shrink-0 text-small text-faint">{modelLabel(a.model)}</span>}
        </span>
        <span className="block truncate text-small text-faint">{cur ? `${cur.name} ${shortDetail(cur.detail)}` : "Thinking…"}</span>
      </span>
    </Row>
  );
}

function StartingRow({ info, selected }: { info: PtyInfo; selected: boolean }) {
  const open = useStore((st) => st.open);
  return (
    <Row selected={selected} onClick={() => open({ kind: "pty", id: info.id })}>
      <span className="flex h-[22px] w-[8px] items-center justify-center">
        <StatusDot status="starting" size={8} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <ProviderMark provider={info.provider} size={13} />
          <span className="truncate text-base text-fg">New {info.provider} session</span>
        </span>
        <span className="shimmer block truncate text-small">Starting…</span>
      </span>
    </Row>
  );
}

function StartingChatRow({ info, selected }: { info: ChatInfo; selected: boolean }) {
  const open = useStore((st) => st.open);
  return (
    <Row selected={selected} onClick={() => open({ kind: "chat", id: info.id })}>
      <span className="flex h-[22px] w-[8px] items-center justify-center">
        <StatusDot status={info.state === "idle" ? "idle" : "starting"} size={8} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <ProviderMark provider={info.provider} size={13} />
          <span className="truncate text-base text-fg">New {info.provider === "claude" ? "Claude Code" : "Codex"} chat</span>
        </span>
        <span className="block truncate text-small text-faint">{info.state === "idle" ? "Ready for a prompt" : "Starting…"}</span>
      </span>
    </Row>
  );
}
