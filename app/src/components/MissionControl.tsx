// Mission control (Home): a calm overview of every project with live agents (APP_SPEC "Mission
// control"). "Needs you" sits on top, with a pending edit shown inline to allow or deny. Then one
// section per project: its sessions (one click opens one) with their fan-outs, the ledger of what
// agents changed, and the branch's commit trail. Ended sessions are listed under "Earlier".

import { AnimatePresence, motion } from "motion/react";
import { memo, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { answerPermission } from "../lib/actions";
import { useAgentCards } from "../lib/agentCards";
import { pendingPermission, pendingQuestion, useChats, type ChatItem } from "../lib/chat";
import { useClock } from "../lib/clock";
import { ago, displayTitle, folderName, fmtElapsed, headlineIsTitle, isThinking, projectOf, shortDetail, splitTool, tsToMs } from "../lib/format";
import { useGitTrail } from "../lib/gitTrail";
import { attention, liveJobs, sameAttention, useChatDigest, useUnseen, type Attention } from "../lib/live";
import { changesFromActivity, changesFromChat, committing, fanout, foldAgentRows, mergeChanges, type Change, type ItemLike } from "../lib/mission";
import { AnimateScope, useMotion } from "../lib/motion";
import { useStableOrder } from "../lib/stable";
import { turnTotals } from "../lib/turn";
import type { ChatInfo, PtyInfo, Session } from "../lib/types";
import { sessionKey } from "../lib/types";
import { useStore, type Since } from "../store";
import { ChangeLedger, type LedgerSource } from "./ChangeLedger";
import { CommitTrail, type Committing } from "./CommitTrail";
import { FanOut } from "./FanOut";
import { IForward, IPlay, IPlus, ISpark, ITerminal, toolIcon } from "./icons";
import { editPairs, InlineDiff } from "./InlineDiff";
import { AutoTag, Button, ContextMeter, cx, ease, Elapsed, Kbd, LiveClock, NeedsBadge, PathText, ProviderMark, softSpring, StatusDot } from "./primitives";
import { resumeInto } from "./SessionView";
import { RecentSkeleton, Skel } from "./Skeletons";
import { Wordmark } from "./Wordmark";

/** Sessions that ended this long ago still feed their project's ledger. */
const LEDGER_WINDOW_MS = 6 * 3600_000;

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
  const [hover, setHover] = useState(false);

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
    const rank = (p: Project) => (p.needs ? 0 : p.busy || p.starting.length ? 1 : 2);
    return [...by.values()].sort((a, b) => rank(a) - rank(b) || folderName(a.path).localeCompare(folderName(b.path)));
  }, [live, att, pending, ptys, pendingChats, chatInfos]);
  // Held still while the pointer is over the page, so a section never moves under it.
  const shown = useStableOrder(projects, (p) => p.path, hover);

  const needing = live.filter((s) => att.get(s)!.needs);
  const recent = useMemo(() => sessions.filter((s) => !s.nested && att.get(s)?.status === "ended").slice(0, 6), [sessions, att]);
  const nothing = projects.length === 0;
  const firstPaint = useRef(true);
  const stagger = firstPaint.current;
  if (ready) firstPaint.current = false;
  const counts = { busy: live.filter((s) => att.get(s)!.status === "busy" && !att.get(s)!.needs).length, idle: live.filter((s) => att.get(s)!.status === "idle" && !att.get(s)!.needs).length, needs: needing.length };

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
            <div onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
              <Summary counts={counts} loading={loading} />
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
              <div className="flex flex-col gap-9">
                {shown.map((p, i) => (
                  <ProjectSection key={p.path} p={p} att={att} i={i} stagger={stagger} />
                ))}
              </div>
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

function Summary({ counts, loading }: { counts: { busy: number; idle: number; needs: number }; loading: boolean }) {
  const setSheet = useStore((s) => s.setSheet);
  const parts = [counts.busy && `${counts.busy} working`, counts.idle && `${counts.idle} waiting`, counts.needs && `${counts.needs} need${counts.needs === 1 ? "s" : ""} you`].filter(Boolean);
  return (
    <div className="mb-6 flex h-[34px] items-center gap-3 px-1">
      <span className="min-w-0 truncate text-base text-dim tnum">
        {parts.join(" · ")}
        {loading && " · reading more sessions…"}
      </span>
      <Button variant="outline" className="ml-auto h-[30px] px-2.5 text-small" onClick={() => setSheet({ kind: "new" })}>
        <IPlus size={13} strokeWidth={2} />
        New session
      </Button>
    </div>
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

// ---------- a project ----------

/** Every change in the project's sessions (live, or ended within the window), newest first. */
function useProjectChanges(path: string, branch: string | null): { changes: Change[]; sources: Record<string, LedgerSource> } {
  const feeding = useStore(
    useShallow((st) => {
      const cut = Date.now() - LEDGER_WINDOW_MS;
      return st.sessions.filter((s) => projectOf(s) === path && (s.status !== "ended" || s.updated > cut));
    }),
  );
  const items = useChats(useShallow((st) => feeding.map((s) => (s.chat != null ? st.chats[s.chat]?.items : undefined))));
  return useMemo(() => {
    const lists: Change[][] = [];
    const sources: Record<string, LedgerSource> = {};
    feeding.forEach((s, i) => {
      const key = sessionKey(s);
      sources[key] = { provider: s.provider, title: displayTitle(s) };
      const its = items[i];
      if (its && its.length) {
        lists.push(changesFromChat(key, its as ItemLike[], s.cwd || path, branch));
        return;
      }
      lists.push(changesFromActivity(key, s.activity, s.cwd || path, branch));
      for (const a of s.agents) lists.push(changesFromActivity(key, a.activity, s.cwd || path, branch).map((c) => ({ ...c, id: `${c.id}@${a.id}`, step: `g:${a.id}` })));
    });
    const agentOf = (c: Change) => (c.step.startsWith("g:") ? c.step.slice(2) : null);
    return { changes: foldAgentRows(mergeChanges(lists, Infinity), agentOf).slice(0, 40), sources };
  }, [feeding, items, path, branch]);
}

function ProjectSection({ p, att, i, stagger }: { p: Project; att: Map<Session, Attention>; i: number; stagger: boolean }) {
  const open = useStore((st) => st.open);
  const focusAgent = useStore((st) => st.focusAgent);
  const setSheet = useStore((st) => st.setSheet);
  const reduce = useMotion().reduce;
  const commit = p.sessions.map((s) => (att.get(s)!.status === "busy" ? committing(s.current) : null)).find((m) => m !== null) ?? null;
  const committer = commit !== null ? p.sessions.find((s) => committing(s.current) === commit) : undefined;
  // The trail's branch names pushes and merges in the ledger; the ledger's git rows re-read the trail.
  const [branch, setBranch] = useState<string | null>(null);
  const { changes, sources } = useProjectChanges(p.path, branch);
  const gitRows = changes.filter((c) => c.kind === "commit" || c.kind === "merge" || c.kind === "push").length;
  const entry = useGitTrail(p.path, `${gitRows}|${commit ?? "-"}`);
  const trail = entry?.trail ?? null;
  if (trail && trail.branch !== branch) setBranch(trail.branch);
  const showTrail = !entry || !!trail;
  const committingRow: Committing | null = commit !== null && committer ? { message: commit, key: sessionKey(committer) } : null;

  const openChange = (c: Change) => {
    open({ kind: "session", key: c.session });
    if (c.step.startsWith("g:")) focusAgent(c.step.slice(2));
  };
  const ledger = <ChangeLedger changes={changes} sources={sources} onOpen={openChange} />;

  return (
    <motion.section
      initial={stagger && !reduce ? { opacity: 0, y: 12 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...softSpring, opacity: { duration: 0.3 }, delay: stagger ? Math.min(i, 6) * 0.06 : 0 }}
      data-mc-project={folderName(p.path)}
    >
      <header className="mb-2.5 flex h-[28px] items-center gap-2.5 px-1">
        <span className="shrink-0 text-title font-semibold tracking-[-0.01em] text-fg">{folderName(p.path)}</span>
        <PathText path={p.path} className="hidden min-w-0 text-small text-faint @[720px]:flex" />
        <span className="ml-auto flex shrink-0 items-center gap-3 text-small text-faint tnum">
          {p.needs > 0 && <span className="text-needs-text">{p.needs} need{p.needs === 1 ? "s" : ""} you</span>}
          {p.busy > 0 && <span>{p.busy} working</span>}
          <button type="button" title={`New session in ${folderName(p.path)}`} onClick={() => setSheet({ kind: "new", cwd: p.path })} className="flex size-[26px] items-center justify-center rounded-[7px] text-dim transition-colors hover:bg-hover hover:text-fg">
            <IPlus size={13} strokeWidth={2} />
          </button>
        </span>
      </header>
      <div className={cx("grid items-start gap-3", "@[900px]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]")}>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="overflow-hidden rounded-[14px] border border-hairline bg-bg" data-mc-sessions={p.sessions.length}>
            {p.sessions.map((s, k) => (
              <SessionRow key={sessionKey(s)} s={s} att={att.get(s)!} first={k === 0} />
            ))}
            {p.starting.map((e, k) => (
              <StartingRow key={e.k} p={e.p} chat={e.chat} first={k === 0 && p.sessions.length === 0} />
            ))}
          </div>
          {showTrail && ledger}
        </div>
        {showTrail ? <CommitTrail trail={trail} loading={!entry} committing={committingRow} /> : ledger}
      </div>
    </motion.section>
  );
}

// ---------- session rows ----------

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

/** Start of the session's latest turn (its fan-out is the subagents started since). */
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
  const age = useClock((now) => ago(s.updated, now));
  const unseen = useUnseen(s);
  const chat = useChats((st) => (s.chat != null ? st.chats[s.chat] : undefined));
  const cards = useAgentCards(s, chat);
  const turnStart = useTurnStart(s);
  const now = useClock((t) => Math.floor(t / 15_000) * 15_000);
  const batch = useMemo(() => fanout(cards, turnStart, now), [cards, turnStart, now]);
  const shells = att.status !== "ended" ? (s.shells ?? []) : [];
  const since = useRowSince(s);
  const key = sessionKey(s);
  const needs = att.needs;
  const busy = att.status === "busy" && !needs && !att.background;
  const thinking = busy && (!s.current || isThinking(s.current));
  const cur = busy && !thinking && s.current ? splitTool(s.current) : null;
  const CurIcon = cur ? toolIcon(cur.name) : ISpark;
  const running = att.agents;
  const jobs = liveJobs(s);
  const crew = running.length ? `${running.length} ${running.length === 1 ? "agent" : "agents"}${jobs > 0 ? `, ${jobs} ${jobs === 1 ? "job" : "jobs"}` : ""} working` : null;
  const turn = useMemo(() => turnTotals(s), [s]);
  const worked = turn.startMs !== null && turn.endMs !== null && turn.endMs > turn.startMs ? turn.endMs - turn.startMs : 0;
  const headline = s.insight?.headline && !headlineIsTitle(s) ? s.insight.headline : null;
  const pendingLoad = s.loaded === false;
  const showFan = batch.length >= 2 || (batch.length > 0 && shells.length > 0);

  return (
    <div className={cx(!first && "border-t border-hairline")} data-mc-session={key}>
      <button type="button" onClick={() => open({ kind: "session", key })} className="group flex min-h-[54px] w-full items-center gap-3 px-3.5 py-2 text-left transition-colors duration-150 hover:bg-hover">
        <span className="flex size-[16px] shrink-0 items-center justify-center" title={needs ? "Needs you" : att.background ? `Working in background · ${att.background}` : att.status === "busy" ? "Working" : "Waiting for you"}>
          {(att.status !== "idle" || unseen || needs) && <StatusDot status={needs ? "needs" : att.status} size={8} />}
          {att.status === "idle" && !unseen && !needs && <span className="size-[6px] rounded-full bg-[color-mix(in_oklab,var(--status-waiting)_45%,transparent)]" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <ProviderMark provider={s.provider} size={12} />
            <span className="min-w-0 truncate text-base font-medium text-fg">{displayTitle(s)}</span>
            {s.origin === "automation" && <AutoTag />}
          </span>
          <span className="mt-0.5 flex h-[18px] min-w-0 items-center gap-1.5 text-small">
            {pendingLoad ? (
              <Skel w="45%" h={8} />
            ) : needs ? (
              <span className="min-w-0 truncate text-needs-text" title={needs}>
                {needs}
              </span>
            ) : crew ? (
              <span className="min-w-0 truncate text-dim">{crew}</span>
            ) : att.background ? (
              <span className="min-w-0 truncate text-dim">{att.background}</span>
            ) : busy ? (
              <>
                <CurIcon size={12} className="shrink-0 text-faint" />
                {cur ? (
                  <span className="min-w-0 truncate text-dim">
                    {cur.name}
                    {cur.detail && <span className="ml-1.5 font-mono text-mono-small text-faint">{shortDetail(cur.detail)}</span>}
                  </span>
                ) : (
                  <span className="text-dim">Thinking</span>
                )}
              </>
            ) : (
              <span className="min-w-0 truncate text-faint" title={headline ?? undefined}>
                {headline ?? (worked ? `Waiting for you · worked ${fmtElapsed(worked)}` : `Waiting for you · ${age}`)}
              </span>
            )}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          {busy && !pendingLoad ? <LiveClock since={since.approx ? null : since.at} className="text-small text-faint" /> : <span className="text-small text-faint tnum">{age}</span>}
          {!pendingLoad && <ContextMeter context={s.tokens.context} model={s.model} compact />}
        </span>
      </button>
      {showFan && (
        <div className="px-3.5 pb-3 pl-[42px]">
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
    <button type="button" onClick={() => open(chat ? { kind: "chat", id: chat.id } : { kind: "pty", id: p!.id })} className={cx("flex min-h-[54px] w-full items-center gap-3 px-3.5 py-2 text-left transition-colors hover:bg-hover", !first && "border-t border-hairline")}>
      <span className="flex size-[16px] shrink-0 items-center justify-center">
        <StatusDot status={ready ? "idle" : "starting"} size={8} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <ProviderMark provider={info.provider} size={12} />
          <span className="truncate text-base font-medium text-fg">New {info.provider === "claude" ? "Claude Code" : "Codex"} {chat ? "chat" : "session"}</span>
        </span>
        <span className="mt-0.5 block h-[18px] text-small text-dim">{ready ? "Ready for a first prompt" : chat ? "Starting" : "Waiting for the transcript"}</span>
      </span>
      {p && <Elapsed since={p.started} className="shrink-0 text-small text-faint" />}
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
                  <div key={r} className={cx("flex h-[54px] items-center gap-3 px-3.5", r > 0 && "border-t border-hairline")}>
                    <Skel w={8} h={8} i={r} />
                    <div className="flex flex-1 flex-col gap-2">
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
