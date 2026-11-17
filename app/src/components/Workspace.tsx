import { useShallow } from "zustand/react/shallow";
import { AnimatePresence, motion, Reorder } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { chatTitle, needsAnswer, useChats } from "../lib/chat";
import { displayTitle, folderName, projectOf } from "../lib/format";
import { useAttention, useUnseen } from "../lib/live";
import { reducedMotion } from "../lib/motion";
import type { Session } from "../lib/types";
import { sessionKey } from "../lib/types";
import { leaves, resolveTarget, useStore, type Leaf, type Node, type Tab } from "../store";
import { IClose, IGrid, ISearch, ISplitDown, ISplitRight } from "./icons";
import { MissionControl } from "./MissionControl";
import { cx, ease, IconButton, Kbd, ProviderMark, spring, StatusDot } from "./primitives";
import { SessionView } from "./SessionView";

export function Workspace() {
  const tabs = useStore((s) => s.tabs);
  const activeTab = useStore((s) => s.activeTab);
  const tab = tabs.find((t) => t.id === activeTab) ?? null;

  return (
    <main data-main className="flex min-w-0 flex-1 flex-col bg-bg">
      <div className="relative min-h-0 flex-1">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={tab ? tab.id : "home"}
            className="absolute inset-0"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease }}
          >
            {tab ? <LayoutView tab={tab} node={tab.root} /> : <MissionControl />}
          </motion.div>
        </AnimatePresence>
      </div>
    </main>
  );
}

/** Rendered in the window title bar (see App.tsx). */
export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTab = useStore((s) => s.activeTab);
  const activate = useStore((s) => s.activate);
  const reorder = useStore((s) => s.reorder);
  const split = useStore((s) => s.split);
  const ids = useMemo(() => tabs.map((t) => t.id), [tabs]);
  const strip = useRef<HTMLUListElement | null>(null);
  // Keep the active tab in view when there are more tabs than room.
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>("[data-tab-active]");
    el?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [activeTab, tabs.length]);

  return (
    <div data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center gap-1 pl-2">
      <button
        type="button"
        title="Home"
        onClick={() => activate(null)}
        className={cx(
          "relative flex h-[34px] shrink-0 items-center gap-1.5 rounded-[9px] px-2.5 text-base font-medium transition-colors duration-150",
          activeTab === null ? "text-fg" : "text-dim hover:bg-hover hover:text-fg",
        )}
      >
        {activeTab === null && <motion.span layoutId="tab-active" transition={spring} className="absolute inset-0 -z-0 rounded-[8px] border border-line bg-[var(--tab-active)] shadow-card" />}
        <IGrid size={16} className="relative" />
        {tabs.length === 0 && <span className="relative">Home</span>}
      </button>
      {tabs.length > 0 && <span className="mx-1 h-4 w-px shrink-0 bg-line" />}
      <Reorder.Group ref={strip} axis="x" values={ids} onReorder={reorder} className="scroll-x flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden" data-tauri-drag-region>
        <AnimatePresence initial={false}>
          {tabs.map((t, i) => (
            <TabChip key={t.id} tab={t} active={t.id === activeTab} index={i} />
          ))}
        </AnimatePresence>
      </Reorder.Group>
      <div className="ml-1 flex shrink-0 items-center gap-0.5">
        <IconButton title="Split right (⌘\)" onClick={() => split("row")} disabled={!activeTab}>
          <ISplitRight size={17} />
        </IconButton>
        <IconButton title="Split down (⌘⇧\)" onClick={() => split("col")} disabled={!activeTab}>
          <ISplitDown size={17} />
        </IconButton>
      </div>
    </div>
  );
}

/**
 * The draggable shell of a tab. It re-renders only when the tab itself changes: a draggable motion element
 * re-measures every motion element in the window each time it renders, so what changes with every sessions
 * payload (title, status) lives in `TabChipBody`.
 */
function TabChip({ tab, active, index }: { tab: Tab; active: boolean; index: number }) {
  const activate = useStore((s) => s.activate);
  const closeTab = useStore((s) => s.closeTab);
  return (
    <Reorder.Item
      value={tab.id}
      initial={{ opacity: 0, width: 0 }}
      animate={{ opacity: 1, width: "auto" }}
      exit={{ opacity: 0, width: 0, transition: { duration: 0.16 } }}
      transition={spring}
      whileDrag={{ scale: 1.03, zIndex: 5 }}
      className="relative min-w-[96px] max-w-[230px] shrink"
      onPointerDown={() => activate(tab.id)}
      onAuxClick={(e) => e.button === 1 && closeTab(tab.id)}
      data-tab-active={active ? "" : undefined}
    >
      {active && <motion.span layoutId="tab-active" transition={spring} className="absolute inset-0 rounded-[8px] border border-line bg-[var(--tab-active)] shadow-card" />}
      <TabChipBody tab={tab} active={active} index={index} />
    </Reorder.Item>
  );
}

function TabChipBody({ tab, active, index }: { tab: Tab; active: boolean; index: number }) {
  const closeTab = useStore((s) => s.closeTab);
  const panes = leaves(tab.root);
  const leaf = panes.find((l) => l.id === tab.focus) ?? panes[0];
  const r = useStore(useShallow((st) => resolveTarget(leaf.target, st)));
  const att = useAttention(r.session);
  const unseen = useUnseen(r.session);
  const chatBits = useChats(
    useShallow((st) => {
      const c = r.chat !== null ? st.chats[r.chat] : undefined;
      return { title: c ? chatTitle(c) : null, needs: needsAnswer(c), state: c ? (c.running ? c.state : "ended") : null, provider: c?.provider };
    }),
  );
  // Any pane in this tab blocked on the person marks the whole tab.
  const anyNeeds = useChats((st) => panes.some((p) => p.target?.kind === "chat" && needsAnswer(st.chats[p.target.id])));
  const title = r.session
    ? displayTitle(r.session)
    : chatBits.title
      ? chatBits.title
      : r.startingChat || r.chat !== null
        ? `New ${(chatBits.provider ?? r.startingChat?.provider) === "codex" ? "Codex" : "Claude Code"} chat`
        : r.starting
          ? `New ${r.starting.provider} session`
          : leaf.target
            ? "Session"
            : "Empty pane";
  const exited = useStore((st) => (r.pty !== null ? !!st.exited[r.pty] : false));
  const needs = !!att?.needs || chatBits.needs || anyNeeds;
  const status = needs
    ? "needs"
    : r.session
      ? (att?.status === "idle" && !unseen ? "ended" : (att?.status ?? r.session.status))
      : chatBits.state
        ? chatBits.state === "ended"
          ? "ended"
          : chatBits.state === "idle"
            ? "idle"
            : "busy"
        : r.starting?.running && !exited
          ? "starting"
          : "ended";

  return (
    <div
      title={`${title}${index < 9 ? `  (⌘${index + 1})` : ""}`}
      className={cx(
        "group relative flex h-[34px] w-full items-center gap-2 rounded-[9px] pl-2.5 pr-1 text-[13px] transition-colors duration-150",
        active ? "text-fg" : "text-dim hover:bg-hover hover:text-fg",
      )}
    >
      <StatusDot status={status} size={7} className="relative" />
      {needs && !active && <span className="absolute inset-x-2 bottom-[3px] h-[2px] rounded-full bg-needs/70" />}
      <span className="relative truncate font-medium">{title}</span>
      {panes.length > 1 && <span className="relative shrink-0 rounded-[4px] bg-hover px-1 text-small text-dim tnum">{panes.length}</span>}
      <button
        type="button"
        title="Close tab (⌘W)"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => closeTab(tab.id)}
        className={cx(
          "relative flex size-[24px] shrink-0 items-center justify-center rounded-[6px] text-faint transition-[opacity,background-color,color] duration-150 hover:bg-press hover:text-fg",
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <IClose size={13} />
      </button>
    </div>
  );
}

function LayoutView({ tab, node }: { tab: Tab; node: Node }) {
  if (node.type === "leaf") return <Pane tab={tab} leaf={node} />;
  return <SplitView tab={tab} node={node} />;
}

function SplitView({ tab, node }: { tab: Tab; node: Extract<Node, { type: "split" }> }) {
  const setRatio = useStore((s) => s.setRatio);
  const box = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const row = node.dir === "row";
  const t = dragging ? { duration: 0 } : spring;

  return (
    <div ref={box} className={cx("flex h-full w-full min-h-0 min-w-0", row ? "flex-row" : "flex-col")}>
      <motion.div className="relative min-h-0 min-w-0 overflow-hidden" style={{ flexBasis: 0 }} initial={false} animate={{ flexGrow: node.ratio }} transition={t}>
        <LayoutView tab={tab} node={node.a} />
      </motion.div>
      <div
        className={cx("group relative z-10 shrink-0 bg-hairline", row ? "w-px cursor-col-resize" : "h-px cursor-row-resize")}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (!dragging || !box.current) return;
          const r = box.current.getBoundingClientRect();
          const v = row ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
          setRatio(node.id, Math.min(0.82, Math.max(0.18, v)));
        }}
        onPointerUp={() => setDragging(false)}
        onDoubleClick={() => setRatio(node.id, 0.5)}
      >
        <div className={cx("absolute", row ? "inset-y-0 -left-[3px] -right-[3px]" : "inset-x-0 -top-[3px] -bottom-[3px]")} />
        <div className={cx("absolute bg-accent opacity-0 transition-opacity duration-150 group-hover:opacity-50", dragging && "opacity-70", row ? "inset-y-0 -left-px w-[3px]" : "inset-x-0 -top-px h-[3px]")} />
      </div>
      <motion.div
        className="relative min-h-0 min-w-0 overflow-hidden"
        style={{ flexBasis: 0 }}
        initial={{ flexGrow: 0.0001 }}
        animate={{ flexGrow: 1 - node.ratio }}
        transition={t}
      >
        <LayoutView tab={tab} node={node.b} />
      </motion.div>
    </div>
  );
}

function Pane({ tab, leaf }: { tab: Tab; leaf: Leaf }) {
  const focusPane = useStore((s) => s.focusPane);
  const closePane = useStore((s) => s.closePane);
  const split = tab.root.type === "split";
  const focused = tab.focus === leaf.id;
  return (
    <div className="relative h-full w-full" onMouseDownCapture={() => !focused && focusPane(tab.id, leaf.id)}>
      {leaf.target ? (
        <SessionView target={leaf.target} leaf={leaf.id} focused={focused} compact={split} onClosePane={split ? () => closePane(leaf.id) : undefined} />
      ) : (
        <PanePicker leaf={leaf} />
      )}
      {split && (
        <>
          <motion.div
            className="pointer-events-none absolute inset-0 z-20 rounded-[2px]"
            initial={false}
            animate={{ boxShadow: focused ? "inset 0 0 0 1px color-mix(in oklab, var(--accent) 38%, transparent)" : "inset 0 0 0 1px rgba(0,0,0,0)" }}
            transition={{ duration: 0.2 }}
          />
          {!leaf.target && (
            <IconButton title="Close pane" onClick={() => closePane(leaf.id)} className="absolute right-2 top-2 z-30">
              <IClose size={14} />
            </IconButton>
          )}
        </>
      )}
    </div>
  );
}

function PanePicker({ leaf }: { leaf: Leaf }) {
  const sessions = useStore((s) => s.sessions);
  const setPaneTarget = useStore((s) => s.setPaneTarget);
  const setSheet = useStore((s) => s.setSheet);
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const ql = q.toLowerCase();
    return sessions.filter((s) => !ql || displayTitle(s).toLowerCase().includes(ql) || s.cwd.toLowerCase().includes(ql)).slice(0, 8);
  }, [sessions, q]);
  const pick = (s: Session) => setPaneTarget(leaf.id, { kind: "session", key: sessionKey(s) });

  return (
    <div className="flex h-full items-center justify-center p-6">
      <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.22, ease }} className="w-full max-w-[360px]">
        <div className="mb-2 text-center text-title font-semibold tracking-[-0.01em]">Open in this pane</div>
        <div className="overflow-hidden rounded-[14px] border border-line bg-raised shadow-card">
          <div className="flex items-center gap-2 border-b border-hairline px-3">
            <ISearch size={15} className="text-faint" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && list[0] && pick(list[0])}
              placeholder="Find a session…"
              className="h-[42px] flex-1 bg-transparent text-base outline-none placeholder:text-faint"
            />
          </div>
          <div className="max-h-[300px] overflow-auto p-1">
            {list.map((s) => (
              <button
                key={sessionKey(s)}
                type="button"
                onClick={() => pick(s)}
                className="flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left transition-colors duration-150 hover:bg-hover"
              >
                <StatusDot status={s.status} size={7} />
                <ProviderMark provider={s.provider} size={13} />
                <span className="min-w-0 flex-1 truncate text-base">{displayTitle(s)}</span>
                <span className="shrink-0 text-small text-faint">{folderName(projectOf(s))}</span>
              </button>
            ))}
            {list.length === 0 && <div className="px-2 py-3 text-center text-base text-dim">No matches</div>}
          </div>
          <button
            type="button"
            onClick={() => setSheet({ kind: "new" })}
            className="flex w-full items-center gap-2 border-t border-hairline px-3 py-2 text-left text-base text-dim transition-colors duration-150 hover:bg-hover hover:text-fg"
          >
            New session
            <span className="ml-auto flex gap-0.5">
              <Kbd>⌘</Kbd>
              <Kbd>T</Kbd>
            </span>
          </button>
        </div>
      </motion.div>
    </div>
  );
}
