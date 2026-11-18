// Mission control (Home): a calm overview of every project with live agents (APP_SPEC "Mission
// control"). "Needs you" sits on top, with a pending edit shown inline to allow or deny. Then one
// section per project: its sessions (one click opens one) with their fan-outs, the ledger of what
// agents changed, and the branch's commit trail. Ended sessions are listed under "Earlier".

import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { answerPermission } from "../lib/actions";
import { useAgentCards } from "../lib/agentCards";
import { pendingPermission, pendingQuestion, useChats, type ChatItem } from "../lib/chat";
import { useClock } from "../lib/clock";
import { ago, displayTitle, folderName, fmtElapsed, fmtTokens, headlineIsTitle, homeShort, isThinking, projectOf, shortDetail, tsToMs } from "../lib/format";
import { stepParts } from "../lib/toolNames";
import { useGitTrail } from "../lib/gitTrail";
import { attention, liveJobs, sameAttention, useChatDigest, useUnseen, type Attention } from "../lib/live";
import { committing, fanout, ledgerRows, overlaps, type Change, type OverlapEdit } from "../lib/mission";
import { agentOf, publishOverlaps, useProjectChanges } from "../lib/projectChanges";
import { AnimateScope, useMotion } from "../lib/motion";
import { contextWindow } from "../lib/models";
import { turnTotals } from "../lib/turn";
import type { ChatInfo, PtyInfo, Session } from "../lib/types";
import { sessionKey } from "../lib/types";
import { useStore, type Since } from "../store";
import { AwayStrip } from "./Away";
import { ChangeLedger } from "./ChangeLedger";
import { CommitTrail, type Committing } from "./CommitTrail";
import { FanOut } from "./FanOut";
import { IAgent, IForward, IPlay, IPlus, ITerminal } from "./icons";
import { editPairs, InlineDiff } from "./InlineDiff";
import { Age, Card, CardHeader, Node, TEXT_X } from "./MissionCard";
import { AutoTag, Button, cx, ease, Kbd, NeedsBadge, PathText, ProviderMark, softSpring, StatusDot } from "./primitives";
import { resumeInto } from "./SessionView";
import { RecentSkeleton, Skel } from "./Skeletons";
import { Wordmark } from "./Wordmark";

interface Project {
  path: string;
  sessions: Session[];
  starting: { k: string; p?: PtyInfo; chat?: ChatInfo }[];
  needs: number;
  busy: number;
}

export function MissionControl() {
  const sessions = useStore((s) => s.sessions);
  const pending = useStore((s) => s.pending);
  const ptys = useStore((s) => s.ptys);
  const ready = useStore((s) => s.ready);
  const loading = useStore((s) => s.loading);
  const pendingChats = useStore((s) => s.pendingChats);
  const chatInfos = useStore((s) => s.chatInfos);
  const digest = useChatDigest();

  const { live, att } = useMemo(() => {
    const att = new Map<Session, Attention>();
    for (const s of sessions) att.set(s, attention(s, digest));
    const rank = (s: Session) => (att.get(s)!.needs ? 0 : att.get(s)!.status === "busy" ? 1 : 2);
    const live = sessions.filter((s) => !s.nested && att.get(s)!.status !== "ended").sort((a, b) => rank(a) - rank(b) || displayTitle(a).localeCompare(displayTitle(b)));
    return { live, att };
  }, [sessions, digest]);

  const projects = useMemo(() => {
    const by = new Map<string, Project>();
    const get = (path: string) => {
      let p = by.get(path);
      if (!p) by.set(path, (p = { path, sessions: [], starting: [], needs: 0, busy: 0 }));
      return p;
    };
    for (const s of live) {
      const p = get(projectOf(s));
      p.sessions.push(s);
      if (att.get(s)!.needs) p.needs++;
      else if (att.get(s)!.status === "busy") p.busy++;
    }
    for (const id of pendingChats) {
      const c = chatInfos[id];
      if (c) get(c.project || c.cwd).starting.push({ k: `chat:${c.id}`, chat: c });
    }
    for (const id of pending) {
      const p = ptys[id];
      if (p) get(p.project || p.cwd).starting.push({ k: `pty:${p.id}`, p });
    }
    // Needs you, then working, then waiting; by name within each.
    const rank = (p: Project) => (p.needs ? 0 : p.busy || startingBusy(p) ? 1 : 2);
    return [...by.values()].sort((a, b) => rank(a) - rank(b) || folderName(a.path).localeCompare(folderName(b.path)));
  }, [live, att, pending, ptys, pendingChats, chatInfos]);
  // One project at a time. It starts on the latest active one and stays there (another project getting busy never
  // swaps the page under the person) until they pick another from the header, or its last agent ends.
  const [picked, setPicked] = useState<string | null>(null);
  const current = useMemo(() => {
    // A session starting right now wins; a new chat that is ready and waits for its first prompt doesn't (it would
    // otherwise hold the page on its project over the ones where agents work, every time Home mounts).
    const at = (p: Project) => (startingBusy(p) ? Infinity : Math.max(0, ...p.sessions.map((x) => x.last_event ?? x.updated)));
    return projects.find((p) => p.path === picked) ?? projects.reduce<Project | null>((best, p) => (!best || at(p) > at(best) ? p : best), null);
  }, [projects, picked]);
  if (current && current.path !== picked) setPicked(current.path);

  const needing = live.filter((s) => att.get(s)!.needs);
  const recent = useMemo(() => sessions.filter((s) => !s.nested && att.get(s)?.status === "ended").slice(0, 6), [sessions, att]);
  const nothing = projects.length === 0;
  const firstPaint = useRef(true);
  const stagger = firstPaint.current;
  if (ready) firstPaint.current = false;

  return (
    <AnimateScope enabled={false}>
      <div className="scroll @container h-full" data-anim-static data-mission>
        <div className="mx-auto max-w-[1280px] px-4 pb-12 pt-6 @[640px]:px-8">
          {!ready || (loading && nothing) ? (
            <>
              <p className="mb-5 text-small text-dim">Looking for sessions…</p>
              <ProjectSkeleton />
            </>
          ) : nothing ? (
            <EmptyState />
          ) : (
            <div>
              {needing.length > 0 && (
                <section className="mb-6" data-mc-needs={needing.length}>
                  <div className="mb-2.5 flex items-center gap-2 px-1">
                    <NeedsBadge small />
                    <span className="text-small text-dim">{needing.length === 1 ? "One session is waiting on you" : `${needing.length} sessions are waiting on you`}</span>
                  </div>
                  <div className="gap-3 @[880px]:columns-2">
                    <AnimatePresence initial={stagger}>
                      {needing.map((s, i) => (
                        <NeedsCard key={sessionKey(s)} s={s} att={att.get(s)!} i={i} />
                      ))}
                    </AnimatePresence>
                  </div>
                </section>
              )}
              <AwayStrip att={att} />
              {current && (
                <>
                  <ProjectTabs projects={projects} current={current} onPick={setPicked} />
                  <ProjectSection key={current.path} p={current} att={att} stagger={stagger} />
                </>
              )}
            </div>
          )}

          {ready && recent.length > 0 && (
            <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: stagger ? 0.25 : 0, duration: 0.3 }} className="mt-10">
              <div className="mb-1 px-1 text-small text-dim">Earlier</div>
              <div>
                {recent.map((s, i) => (
                  <RecentRow key={sessionKey(s)} s={s} first={i === 0} />
                ))}
              </div>
            </motion.section>
          )}
        </div>
      </div>
    </AnimateScope>
  );
}

// ---------- needs you ----------

type Perm = Extract<ChatItem, { kind: "permission" }>;

function NeedsCard({ s, att, i }: { s: Session; att: Attention; i: number }) {
  const open = useStore((st) => st.open);
  const reduce = useMotion().reduce;
  const perm = useChats((st) => (s.chat != null ? pendingPermission(st.chats[s.chat]) : null)) as Perm | null;
  const asking = useChats((st) => (s.chat != null ? !!pendingQuestion(st.chats[s.chat]) : false));
  const key = sessionKey(s);
  const edit = perm ? editPairs(perm.tool, perm.input) : null;
  const command = perm && !edit && /bash|shell|exec/i.test(perm.tool) ? String((perm.input as { command?: unknown })?.command ?? perm.summary) : null;
  const answer = (a: "allow" | "deny") => perm && s.chat != null && answerPermission(s.chat, perm.requestId, a);
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0, transition: { ...softSpring, delay: Math.min(i, 6) * 0.04 } }}
      exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.18 } }}
      className="mb-3 break-inside-avoid rounded-[14px] border border-[color-mix(in_oklab,var(--status-needs)_38%,var(--border))] bg-bg p-3.5"
      data-mc-needs-card={att.source ?? ""}
    >
      <button type="button" onClick={() => open({ kind: "session", key })} className="group flex w-full min-w-0 items-center gap-2 text-left">
        <StatusDot status="needs" size={7} />
        <ProviderMark provider={s.provider} size={13} />
        <span className="shrink-0 text-small text-dim">{folderName(projectOf(s))}</span>
        <span className="min-w-0 flex-1 truncate text-base font-medium text-fg">{displayTitle(s)}</span>
        <span className="flex shrink-0 items-center gap-1 text-small text-dim transition-colors group-hover:text-fg">
          {asking ? "Answer" : perm && !edit && !command ? "Review" : "Open"}
          <IForward size={11} />
        </span>
      </button>
      <p className="mt-1 line-clamp-2 pl-[17px] text-base text-needs-text">{edit ? "Wants to edit a file" : command ? "Wants to run a command" : att.needs}</p>
      {perm && edit ? (
        <div className="pl-[17px]">
          <InlineDiff path={edit.path} pairs={edit.pairs} root={projectOf(s)} onAllow={() => answer("allow")} onDeny={() => answer("deny")} />
        </div>
      ) : perm && command ? (
        <div className="ml-[17px] mt-2.5 flex items-center gap-2 overflow-hidden rounded-[10px] border border-hairline bg-panel py-1.5 pl-2.5 pr-1.5">
          <ITerminal size={12} className="shrink-0 text-faint" />
          <span className="selectable min-w-0 flex-1 truncate font-mono text-mono-small text-fg/90" title={command}>
            {command}
          </span>
          <Button variant="ghost" className="h-[28px] px-2.5 text-small" onClick={() => answer("deny")} data-mc-deny>
            Deny
          </Button>
          <Button variant="primary" className="h-[28px] px-3 text-small" onClick={() => answer("allow")} data-mc-allow>
            Allow
          </Button>
        </div>
      ) : null}
    </motion.div>
  );
}

// ---------- project tabs ----------

/** New sessions still starting (a new chat that is ready and waits for its first prompt is waiting, not working). */
const startingBusy = (p: Project) => p.starting.filter((e) => !(e.chat && e.chat.state === "idle")).length;
const tabTone = (p: Project): "needs" | "busy" | "idle" => (p.needs ? "needs" : p.busy || startingBusy(p) ? "busy" : "idle");

/**
 * The projects with live agents as a row of tabs (by name, so they never reorder under the pointer), each
 * with its state (a needs-you / working / waiting dot) and how many live sessions it has. One click
 * switches; ←/→ (and Home/End) move between them when the row has focus. Many projects scroll sideways,
 * the edges fading, and the current one is kept in view. The current project's path and + (new session
 * there) sit at the right.
 */
function ProjectTabs({ projects, current, onPick }: { projects: Project[]; current: Project; onPick: (path: string) => void }) {
  const setSheet = useStore((st) => st.setSheet);
  const list = useMemo(() => [...projects].sort((a, b) => folderName(a.path).localeCompare(folderName(b.path)) || a.path.localeCompare(b.path)), [projects]);
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ l: false, r: false });
  const readEdges = () => {
    const el = scroller.current;
    if (!el) return;
    const l = el.scrollLeft > 1;
    const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((e) => (e.l === l && e.r === r ? e : { l, r }));
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    readEdges();
    const ro = new ResizeObserver(readEdges);
    ro.observe(el);
    return () => ro.disconnect();
  }, [current.path, list.length]);
  const move = (e: React.KeyboardEvent) => {
    const i = list.findIndex((p) => p.path === current.path);
    const to = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = list[Math.max(0, Math.min(list.length - 1, to))];
    onPick(next.path);
    requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(`[data-mc-tab="${CSS.escape(next.path)}"]`)?.focus());
  };
  const fade = `linear-gradient(90deg, ${edges.l ? "transparent 0, #000 28px" : "#000 0"}, ${edges.r ? "#000 calc(100% - 28px), transparent 100%" : "#000 100%"})`;
  return (
    <header className="mb-3 flex h-[36px] items-center gap-3" data-mc-tabs={list.length}>
      <div
        ref={scroller}
        role="tablist"
        aria-label="Projects with live agents"
        onKeyDown={move}
        onScroll={readEdges}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ maskImage: fade, WebkitMaskImage: fade }}
      >
        {list.map((p) => {
          const on = p.path === current.path;
          const tone = tabTone(p);
          const n = p.sessions.length + p.starting.length;
          return (
            <button
              key={p.path}
              type="button"
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              data-mc-tab={p.path}
              data-mc-switch-to={folderName(p.path)}
              title={`${homeShort(p.path)} · ${p.needs ? `${p.needs} need${p.needs === 1 ? "s" : ""} you` : p.busy || startingBusy(p) ? `${p.busy + startingBusy(p)} working` : "waiting"}`}
              onClick={() => onPick(p.path)}
              className={cx(
                "flex h-[32px] shrink-0 items-center gap-2 rounded-[9px] border px-2.5 text-base transition-colors duration-150",
                on ? "border-hairline bg-raised text-fg shadow-card" : "border-transparent text-dim hover:text-fg",
              )}
            >
              <TabDot tone={tone} />
              <span className="max-w-[180px] truncate">{folderName(p.path)}</span>
              <span className={cx("text-small tnum", tone === "needs" ? "text-needs-text" : "text-faint")}>{n}</span>
            </button>
          );
        })}
      </div>
      <PathText path={current.path} className="hidden min-w-0 max-w-[30%] shrink text-mono-small text-faint @[720px]:flex" />
      <button type="button" title={`New session in ${folderName(current.path)}`} onClick={() => setSheet({ kind: "new", cwd: current.path })} className="flex size-[28px] shrink-0 items-center justify-center rounded-[8px] text-dim transition-colors hover:bg-hover hover:text-fg">
        <IPlus size={13} strokeWidth={2} />
      </button>
    </header>
  );
}

/** A tab's state, still (the page's spinners stay on the session rows). */
function TabDot({ tone }: { tone: "needs" | "busy" | "idle" }) {
  if (tone === "needs") return <StatusDot status="needs" size={7} />;
  return <span className={cx("size-[7px] shrink-0 rounded-full", tone === "busy" ? "bg-[var(--status-running)]" : "bg-[color-mix(in_oklab,var(--status-waiting)_45%,transparent)]")} />;
}

// ---------- a project ----------

function ProjectSection({ p, att, stagger }: { p: Project; att: Map<Session, Attention>; stagger: boolean }) {
  const open = useStore((st) => st.open);
  const focusAgent = useStore((st) => st.focusAgent);
  const reduce = useMotion().reduce;
  const commit = p.sessions.map((s) => (att.get(s)!.status === "busy" ? committing(s.current) : null)).find((m) => m !== null) ?? null;
  const committer = commit !== null ? p.sessions.find((s) => committing(s.current) === commit) : undefined;
  // The trail's branch names pushes and merges in the ledger; the ledger's git rows re-read the trail.
  const [branch, setBranch] = useState<string | null>(null);
  const { changes: all, sources, people } = useProjectChanges(p.path, branch);
  const gitRows = all.filter((c) => c.kind === "commit" || c.kind === "merge" || c.kind === "push").length;
  const entry = useGitTrail(p.path, `${gitRows}|${commit ?? "-"}`);
  const trail = entry?.trail ?? null;
  if (trail && trail.branch !== branch) setBranch(trail.branch);
  const showTrail = !entry || !!trail;
  const committingRow: Committing | null = commit !== null && committer ? { message: commit, key: sessionKey(committer) } : null;
  // Files two live sessions both have pending edits to, once git has answered (a commit by either side counts).
  const found = useMemo(() => (entry ? overlaps(all, people, { agentOf, trail: trail?.commits ?? null }) : []), [all, people, entry, trail]);
  useEffect(() => publishOverlaps(p.path, found), [p.path, found]);
  // The trail owns git history; the ledger keeps what it can't show. An overlapping file's own row is the pinned overlap row.
  const changes = useMemo(() => {
    const pinned = new Set(found.map((o) => o.file));
    return ledgerRows(all, { agentOf, trail: showTrail ? (trail?.commits ?? []) : null }).filter((c) => !((c.kind === "edit" || c.kind === "create") && pinned.has(c.object)));
  }, [all, trail, showTrail, found]);
  const openEdit = (e: OverlapEdit) => {
    open({ kind: "session", key: e.session });
    if (e.agent) focusAgent(e.agent);
  };
  // Two sessions side by side; two agents of one session: that session, on the newer one.
  const openBoth = ([a, b]: OverlapEdit[]) => {
    openEdit(a);
    if (!b || b.session === a.session) return;
    useStore.getState().split("row");
    openEdit(b);
  };

  const openChange = (c: Change) => {
    open({ kind: "session", key: c.session });
    if (c.step.startsWith("g:")) focusAgent(c.step.slice(2));
  };
  const working = p.busy + startingBusy(p);
  const waiting = p.sessions.length - p.busy - p.needs + (p.starting.length - startingBusy(p));
  const meta = [p.needs > 0 && <span key="n" className="text-needs-text">{p.needs} need{p.needs === 1 ? "s" : ""} you</span>, working > 0 && <span key="w">{working} working</span>, waiting > 0 && <span key="i">{waiting} waiting</span>].filter(Boolean);

  return (
    <motion.section
      initial={stagger && !reduce ? { opacity: 0, y: 12 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...softSpring, opacity: { duration: 0.3 } }}
      data-mc-project={folderName(p.path)}
    >
      {/* One grid: sessions and changes on the left, the trail on the right spanning both, so the columns end together. */}
      <div className="grid items-stretch gap-3 @[900px]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] @[900px]:grid-rows-[auto_1fr]">
        <Card className="@[900px]:col-start-1 @[900px]:row-start-1" data-mc-sessions={p.sessions.length}>
          <CardHeader icon={IAgent} title="Sessions" meta={meta.length ? meta : undefined} />
          {p.sessions.map((s, k) => (
            <SessionRow key={sessionKey(s)} s={s} att={att.get(s)!} first={k === 0} />
          ))}
          {p.starting.map((e, k) => (
            <StartingRow key={e.k} p={e.p} chat={e.chat} first={k === 0 && p.sessions.length === 0} />
          ))}
        </Card>
        <ChangeLedger changes={changes} sources={sources} onOpen={openChange} overlaps={found} onOpenSession={openEdit} onOpenBoth={openBoth} className={showTrail ? "@[900px]:col-start-1 @[900px]:row-start-2" : "@[900px]:col-start-2 @[900px]:row-span-2 @[900px]:row-start-1"} />
        {showTrail && <CommitTrail trail={trail} loading={!entry} committing={committingRow} className="@[900px]:col-start-2 @[900px]:row-span-2 @[900px]:row-start-1" />}
      </div>
    </motion.section>
  );
}

// ---------- session rows ----------

/** The context window, only when it is filling up (half or more): "72% context", amber from 75% of a known window. */
function ContextNote({ context, model }: { context: number; model: string | null }) {
  const w = contextWindow(model, null);
  const pct = context / w.tokens;
  if (pct < 0.5) return null;
  return (
    <span className={cx("shrink-0 text-small tnum", w.source !== "assumed" && pct >= 0.75 ? "text-busy-text" : "text-faint")} title={`Context ${fmtTokens(context)} of ${fmtTokens(w.tokens)}`}>
      {Math.round(pct * 100)}% context
    </span>
  );
}

/** When the current tool / thinking phase began. Chats: precise, from event timestamps. */
function useRowSince(s: Session): { at: number; approx: boolean } {
  const since: Since | undefined = useStore((st) => st.since[sessionKey(s)]);
  const chatAt = useChats((st) => {
    const c = s.chat != null ? st.chats[s.chat] : undefined;
    if (!c || !c.ready) return null;
    for (let i = c.items.length - 1; i >= 0; i--) {
      const it = c.items[i];
      if (it.kind === "tool" && !it.parent) return it.endTs === null ? it.ts : it.endTs;
      if ((it.kind === "text" || it.kind === "prompt") && !("parent" in it && it.parent)) return it.ts;
    }
    return c.stateSince;
  });
  if (chatAt !== null) return { at: chatAt, approx: false };
  if (since?.currentObserved) return { at: since.currentAt, approx: false };
  const last = s.activity[s.activity.length - 1];
  const stamp = last ? tsToMs(last.ts) : null;
  if (stamp !== null && stamp <= Date.now() + 5000) return { at: stamp, approx: false };
  return since ? { at: since.currentAt, approx: true } : { at: s.updated, approx: true };
}

/** Start of the session's latest turn (its fan-out is the subagents started since, and any still running). */
function useTurnStart(s: Session): number | null {
  const chatStart = useChats((st) => {
    const c = s.chat != null ? st.chats[s.chat] : undefined;
    if (!c) return null;
    for (let i = c.items.length - 1; i >= 0; i--) if (c.items[i].kind === "prompt") return c.items[i].ts;
    return null;
  });
  return chatStart ?? turnTotals(s).startMs;
}

type RowProps = { s: Session; att: Attention; first: boolean };
const sameRow = (a: RowProps, b: RowProps) => a.s === b.s && a.first === b.first && sameAttention(a.att, b.att);

const SessionRow = memo(function SessionRow({ s, att, first }: RowProps) {
  const open = useStore((st) => st.open);
  const focusAgent = useStore((st) => st.focusAgent);
  const unseen = useUnseen(s);
  const chat = useChats((st) => (s.chat != null ? st.chats[s.chat] : undefined));
  const cards = useAgentCards(s, chat);
  const turnStart = useTurnStart(s);
  const now = useClock((t) => Math.floor(t / 15_000) * 15_000);
  const shells = att.status !== "ended" ? (s.shells ?? []) : [];
  // Every worker the row's "N agents, M jobs working" counts is in the fan-out.
  const batch = useMemo(() => fanout(cards, turnStart, now, 90_000, shells.length), [cards, turnStart, now, shells.length]);
  const since = useRowSince(s);
  const key = sessionKey(s);
  const needs = att.needs;
  const busy = att.status === "busy" && !needs && !att.background;
  const thinking = busy && (!s.current || isThinking(s.current));
  const cur = busy && !thinking && s.current ? stepParts(s.current) : null;
  const running = att.agents;
  const jobs = liveJobs(s);
  const crew = running.length ? `${running.length} ${running.length === 1 ? "agent" : "agents"}${jobs > 0 ? `, ${jobs} ${jobs === 1 ? "job" : "jobs"}` : ""} working` : null;
  const turn = useMemo(() => turnTotals(s), [s]);
  const worked = turn.startMs !== null && turn.endMs !== null && turn.endMs > turn.startMs ? turn.endMs - turn.startMs : 0;
  const headline = s.insight?.headline && !headlineIsTitle(s) ? s.insight.headline : null;
  const pendingLoad = s.loaded === false;
  const showFan = batch.length > 0 || shells.length >= 2;
  const live = busy && !pendingLoad && !since.approx;

  return (
    <div data-mc-session={key} data-first={first || undefined}>
      <button type="button" onClick={() => open({ kind: "session", key })} className="group flex h-[36px] w-full items-center gap-2.5 px-3.5 text-left transition-colors duration-150 hover:bg-hover">
        <Node>
          <span className="flex" title={needs ? "Needs you" : att.background ? `Working in background · ${att.background}` : att.status === "busy" ? "Working" : "Waiting for you"}>
            {att.status !== "idle" || unseen || needs ? <StatusDot status={needs ? "needs" : att.status} size={8} /> : <span className="size-[6px] rounded-full bg-[color-mix(in_oklab,var(--status-waiting)_45%,transparent)]" />}
          </span>
        </Node>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="min-w-0 max-w-[62%] shrink-0 truncate text-base text-fg" title={displayTitle(s)}>
            {displayTitle(s)}
          </span>
          {s.origin === "automation" && <AutoTag className="self-center" />}
          {pendingLoad ? (
            <Skel w={90} h={8} className="self-center" />
          ) : (
            <span className={cx("min-w-0 flex-1 truncate text-small", needs ? "text-needs-text" : busy || crew || att.background ? "text-dim" : "text-faint")} title={needs || headline || undefined}>
              {needs
                ? needs
                : crew
                  ? crew
                  : att.background
                    ? att.background
                    : busy
                      ? cur
                        ? (
                            <>
                              {cur.name}
                              {cur.detail && <span className="ml-1.5 font-mono text-mono-small text-faint">{shortDetail(cur.detail)}</span>}
                            </>
                          )
                        : "Thinking"
                      : (headline ?? (worked ? `Waiting · worked ${fmtElapsed(worked)}` : "Waiting for you"))}
            </span>
          )}
        </span>
        {!pendingLoad && <ContextNote context={s.tokens.context} model={s.model} />}
        <Age ms={live ? since.at : s.updated} title={live ? "On this step for" : "Last active"} className={live ? "text-dim" : undefined} />
      </button>
      {showFan && (
        <div className="pb-3 pr-3.5" style={{ paddingLeft: TEXT_X }}>
          <FanOut
            cards={batch}
            shells={shells}
            onOpen={(c) => {
              open({ kind: "session", key: c.source === "job" ? c.ref : key });
              if (c.source !== "job") focusAgent(c.ref);
            }}
          />
        </div>
      )}
    </div>
  );
}, sameRow);

function StartingRow({ p, chat, first }: { p?: PtyInfo; chat?: ChatInfo; first: boolean }) {
  const open = useStore((st) => st.open);
  const info = (p ?? chat)!;
  const ready = !!chat && chat.state === "idle";
  return (
    <button type="button" onClick={() => open(chat ? { kind: "chat", id: chat.id } : { kind: "pty", id: p!.id })} className="flex h-[36px] w-full items-center gap-2.5 px-3.5 text-left transition-colors hover:bg-hover" data-first={first || undefined}>
      <Node>
        <StatusDot status={ready ? "idle" : "starting"} size={8} />
      </Node>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 truncate text-base text-fg">New {info.provider === "claude" ? "Claude Code" : "Codex"} {chat ? "chat" : "session"}</span>
        <span className="min-w-0 truncate text-small text-dim">{ready ? "Ready for a first prompt" : chat ? "Starting" : "Waiting for the transcript"}</span>
      </span>
      <Age ms={p ? p.started : null} />
    </button>
  );
}

const RecentRow = memo(function RecentRow({ s, first }: { s: Session; first: boolean }) {
  const open = useStore((st) => st.open);
  const age = useClock((now) => ago(s.updated, now));
  return (
    <div className={cx("group flex h-[40px] items-center gap-3 px-1 transition-colors duration-150", !first && "border-t border-hairline")}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={() => open({ kind: "session", key: sessionKey(s) })}>
        <ProviderMark provider={s.provider} size={15} />
        <span className={cx("truncate text-base group-hover:text-fg", s.origin === "automation" ? "text-faint" : "text-fg/85")}>{displayTitle(s)}</span>
        {s.origin === "automation" && <AutoTag />}
        <span className="shrink-0 text-small text-faint">{folderName(projectOf(s))}</span>
      </button>
      <Button variant="ghost" className="h-[30px] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" onClick={() => resumeInto(s)} title="Resume inside coool">
        <IPlay size={13} />
        Resume
      </Button>
      <span className="w-[56px] shrink-0 text-right text-small text-faint tnum">{age}</span>
    </div>
  );
});

function ProjectSkeleton() {
  return (
    <>
      {[0, 1].map((k) => (
        <div key={k} className="mb-9">
          <Skel w={110} h={12} i={k} className="mb-4 ml-1" />
          <div className="grid gap-3 @[900px]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-3">
              <div className="rounded-[14px] border border-hairline bg-bg">
                {[0, 1].map((r) => (
                  <div key={r} className={cx("flex h-[36px] items-center gap-2.5 px-3.5", r > 0 && "border-t border-hairline")}>
                    <Skel w={8} h={8} i={r} />
                    <div className="flex flex-1 items-center gap-3">
                      <Skel w={r ? "45%" : "60%"} h={10} i={r} />
                      <Skel w={r ? "30%" : "38%"} h={8} i={r + 1} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="h-[150px] rounded-[14px] border border-hairline bg-bg" />
            </div>
            <div className="h-[240px] rounded-[14px] border border-hairline bg-bg" />
          </div>
        </div>
      ))}
      <RecentSkeleton />
    </>
  );
}

function EmptyState() {
  const setSheet = useStore((s) => s.setSheet);
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease }}
      className="relative flex flex-col items-center overflow-hidden rounded-[18px] border border-dashed border-line px-6 py-16 text-center"
    >
      <Wordmark size={34} />
      <div className="mt-5 text-display font-semibold tracking-[-0.02em]">No agents running</div>
      <p className="mt-1 max-w-[380px] text-base text-dim">
        Start Claude Code or Codex in any project. Sessions you run in a terminal show up here too, with what they change and the commits they make, live.
      </p>
      <div className="mt-5 flex items-center gap-3">
        <Button variant="primary" onClick={() => setSheet({ kind: "new" })}>
          <IPlus size={15} strokeWidth={2} />
          New session
        </Button>
        <span className="flex items-center gap-1 text-small text-faint">
          <Kbd>⌘</Kbd>
          <Kbd>T</Kbd>
        </span>
      </div>
    </motion.div>
  );
}
