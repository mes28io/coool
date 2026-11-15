import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { memo, useMemo, useRef, useState } from "react";
import { useNow } from "../lib/clock";
import { useChats } from "../lib/chat";
import { ago, displayTitle, folderName, headlineIsTitle, isThinking, projectOf, shortDetail, splitTool } from "../lib/format";
import { attention, useChatDigest, type Attention } from "../lib/live";
import { modelColor, modelLabel, sessionModels } from "../lib/models";
import type { ChatInfo, PtyInfo, Session } from "../lib/types";
import { sessionKey } from "../lib/types";
import { useStableOrder } from "../lib/stable";
import { useStore, type Since } from "../store";
import { IPlay, IPlus, ISpark, toolIcon } from "./icons";
import { Wordmark } from "./Wordmark";
import { AutoTag, Button, ContextMeter, cx, Elapsed, ease, Kbd, PathText, ProviderMark, softSpring, StatusDot, statusLabel } from "./primitives";
import { resumeInto } from "./SessionView";
import { CardSkeleton, RecentSkeleton, Skel } from "./Skeletons";

export function MissionControl() {
  const sessions = useStore((s) => s.sessions);
  const pending = useStore((s) => s.pending);
  const ptys = useStore((s) => s.ptys);
  const ready = useStore((s) => s.ready);
  const loading = useStore((s) => s.loading);
  const [hover, setHover] = useState(false);
  const pendingChats = useStore((s) => s.pendingChats);
  const chatInfos = useStore((s) => s.chatInfos);
  const digest = useChatDigest();
  // Stable order ("Needs you", working, waiting; then project, then title) so cards only move when a status flips.
  const { live, att } = useMemo(() => {
    const att = new Map<Session, Attention>();
    for (const s of sessions) att.set(s, attention(s, digest));
    const rank = (s: Session) => (att.get(s)!.needs ? 0 : att.get(s)!.status === "busy" ? 1 : 2);
    // Child runs show on their parent's card ("2 jobs running"), not as cards of their own.
    const live = sessions
      .filter((s) => !s.nested && att.get(s)!.status !== "ended")
      .sort((a, b) => rank(a) - rank(b) || folderName(projectOf(a)).localeCompare(folderName(projectOf(b))) || displayTitle(a).localeCompare(displayTitle(b)));
    return { live, att };
  }, [sessions, digest]);
  const recent = useMemo(() => sessions.filter((s) => !s.nested && att.get(s)?.status === "ended").slice(0, 6), [sessions, att]);
  const starting = pending.map((id) => ptys[id]).filter(Boolean) as PtyInfo[];
  const startingChats = pendingChats.map((id) => chatInfos[id]).filter(Boolean) as ChatInfo[];
  // One ordered list ("Needs you", starting, the rest), held still while the pointer is over the grid.
  type Entry = { k: string; s?: Session; chat?: ChatInfo; p?: PtyInfo };
  const entries: Entry[] = [
    ...live.filter((s) => att.get(s)!.needs).map((s) => ({ k: sessionKey(s), s })),
    ...startingChats.map((c) => ({ k: `chat:${c.id}`, chat: c })),
    ...starting.map((p) => ({ k: `pty:${p.id}`, p })),
    ...live.filter((s) => !att.get(s)!.needs).map((s) => ({ k: sessionKey(s), s })),
  ];
  const shown = useStableOrder(entries, (e) => e.k, hover);
  const nothing = live.length + starting.length + startingChats.length === 0;
  // Stagger only the cards present on first paint; later arrivals just fade in.
  const firstPaint = useRef(true);
  const stagger = firstPaint.current;
  if (ready) firstPaint.current = false;

  return (
    <div className="scroll h-full">
      <div className="mx-auto max-w-[1280px] px-8 pb-12 pt-7">
        {(!ready || loading) && <p className="mb-5 text-small text-dim">Looking for sessions…</p>}

        {!ready || (loading && nothing) ? (
          <CardSkeletons />
        ) : nothing ? (
          <EmptyState />
        ) : (
          <LayoutGroup>
            <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
              <AnimatePresence initial={stagger} mode="popLayout">
                {shown.map((e, i) =>
                  e.s ? (
                    <Card key={e.k} s={e.s} att={att.get(e.s)!} i={i} stagger={stagger} />
                  ) : e.chat ? (
                    <StartingCard key={e.k} chat={e.chat} i={i} stagger={stagger} />
                  ) : (
                    <StartingCard key={e.k} p={e.p} i={i} stagger={stagger} />
                  ),
                )}
                {loading && <CardSkeleton key="more" i={live.length} />}
              </AnimatePresence>
            </div>
          </LayoutGroup>
        )}

        {ready && recent.length > 0 && (
          <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: stagger ? 0.25 : 0, duration: 0.3 }} className="mt-9">
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
  );
}

const cardMotion = (i: number, stagger: boolean) => ({
  layout: true as const,
  initial: { opacity: 0, y: 14, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { ...softSpring, opacity: { duration: 0.3 }, delay: stagger ? Math.min(i, 12) * 0.045 : 0 } },
  exit: { opacity: 0, scale: 0.97, transition: { duration: 0.18 } },
  transition: softSpring,
});

/** When the current tool / thinking phase began. Chats: precise, from event timestamps. */
function useCardSince(s: Session): { at: number; approx: boolean } {
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
  return since ? { at: since.currentAt, approx: !since.currentObserved } : { at: s.updated, approx: true };
}

function CardModel({ s }: { s: Session }) {
  const rows = sessionModels(s);
  const main = rows.find((r) => !r.via_agent)?.model ?? s.model;
  if (!main) return null;
  const others = new Set(rows.map((r) => r.model).concat(s.agents.map((a) => a.model ?? "").filter(Boolean)));
  others.delete(main);
  return (
    <span className="flex min-w-0 items-center gap-1 text-small text-faint" title={[main, ...others].join(", ")}>
      <span className="size-[6px] shrink-0 rounded-full" style={{ background: modelColor(main) }} />
      <span className="truncate text-dim">{modelLabel(main)}</span>
      {others.size > 0 && <span className="shrink-0 text-faint">+{others.size}</span>}
    </span>
  );
}

/** State at the top right of a card: just a dot ("Needs you" keeps its word, in blue). */
function StateLabel({ status, needs, background }: { status: "busy" | "idle" | "starting" | "ended"; needs?: boolean; background?: string | null }) {
  if (needs)
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-small font-medium text-needs-text">
        <StatusDot status="needs" size={7} />
        Needs you
      </span>
    );
  // Dot only; the word lives in the tooltip and the accessible name.
  const word = background ? `Working in background · ${background}` : status === "idle" ? "Waiting for you" : statusLabel(status);
  return (
    <span role="img" aria-label={word} title={word} className="flex size-[16px] shrink-0 items-center justify-center">
      <StatusDot status={status} size={8} />
    </span>
  );
}

const cardCls = "group relative flex flex-col overflow-hidden rounded-[18px] border bg-bg p-4 text-left transition-[border-color] duration-200";

const Card = memo(function Card({ s, att, i, stagger }: { s: Session; att: Attention; i: number; stagger: boolean }) {
  const open = useStore((st) => st.open);
  const now = useNow();
  const needs = att.needs;
  const busy = att.status === "busy" && !needs && !att.background;
  const thinking = busy && (!s.current || isThinking(s.current));
  const cur = busy && !thinking && s.current ? splitTool(s.current) : null;
  const CurIcon = cur ? toolIcon(cur.name) : ISpark;
  const since = useCardSince(s);
  const running = att.agents;
  const ranCount = running.length ? 0 : s.agents.length;
  const jobs = s.live_children ?? 0;
  // "4 agents working" / "4 agents, 2 jobs working"
  const crew = running.length ? `${running.length} ${running.length === 1 ? "agent" : "agents"}${jobs > 0 ? `, ${jobs} ${jobs === 1 ? "job" : "jobs"}` : ""} working` : null;
  const names = running.map((a) => a.description || a.kind);
  const crewNames = names.slice(0, 2).join(", ");
  const crewMore = names.length > 2 ? `+${names.length - 2} more` : "";
  const headline = s.insight?.headline && !headlineIsTitle(s) ? s.insight.headline : null;
  const pending = s.loaded === false;

  return (
    <motion.button
      type="button"
      {...cardMotion(i, stagger)}
      onClick={() => open({ kind: "session", key: sessionKey(s) })}
      whileHover={{ y: -1, transition: { duration: 0.18 } }}
      className={cx(
        cardCls,
        needs ? "attn-card border-[color-mix(in_oklab,var(--status-needs)_35%,var(--border))]" : "border-hairline hover:border-[color-mix(in_oklab,var(--dim)_40%,var(--border))]",
      )}
    >
      <div className="flex h-[22px] items-center gap-1.5">
        <ProviderMark provider={s.provider} size={14} />
        <span className="min-w-0 flex-1 truncate text-small text-dim">{folderName(projectOf(s))}</span>
        {s.origin === "automation" && <AutoTag />}
        <StateLabel status={att.status} needs={!!needs} background={att.background} />
      </div>
      <div className="mt-2 line-clamp-2 text-title font-semibold tracking-[-0.01em] text-fg">{displayTitle(s)}</div>

      {/* One line: what is happening now. */}
      <div className="mt-2.5 flex h-[22px] items-center gap-2 text-base">
        {needs ? (
          <>
            <span className="min-w-0 flex-1 truncate text-needs-text" title={needs}>
              {needs}
            </span>
            <span className="shrink-0 text-small text-needs-text/80 opacity-0 transition-opacity group-hover:opacity-100">{att.source === "approval" ? "Review →" : "Open →"}</span>
          </>
        ) : crew ? (
          <span className="flex min-w-0 flex-1 items-center gap-2 text-fg/90" data-card-agents>
            <StatusDot status="busy" size={7} />
            <span className="truncate font-medium">{crew}</span>
          </span>
        ) : att.background ? (
          <span className="flex min-w-0 flex-1 items-center gap-2 text-fg/90" data-card-background>
            <StatusDot status="busy" size={7} />
            <span className="truncate font-medium">{att.background}</span>
          </span>
        ) : busy ? (
          <>
            <CurIcon size={15} className="shrink-0 text-dim" />
            <span className="min-w-0 flex-1 truncate">
              {cur ? (
                <>
                  <span className="font-medium text-fg/90">{cur.name}</span> <span className="font-mono text-mono-small text-dim">{shortDetail(cur.detail)}</span>
                </>
              ) : pending ? (
                <Skel w="60%" h={9} className="inline-block align-middle" />
              ) : (
                <span className="shimmer font-medium">Thinking</span>
              )}
            </span>
            {!pending && <Elapsed since={since.at} approx={since.approx} className="shrink-0 text-small text-faint" />}
          </>
        ) : headline ? (
          <span className="min-w-0 flex-1 truncate text-dim" title={headline}>
            {headline}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-dim">Waiting for you · {ago(s.updated, now)}</span>
        )}
      </div>

      {crew && !needs && (
        <div className="mt-0.5 flex h-[18px] min-w-0 items-center pl-[15px] text-small text-dim" title={names.join(", ")} data-card-agent-names>
          <span className="min-w-0 truncate">{crewNames}</span>
          {crewMore && <span className="ml-1.5 shrink-0 text-faint">{crewMore}</span>}
        </div>
      )}

      {pending ? (
        <div className="mt-auto flex h-[18px] items-center gap-3 pt-2.5 box-content" title="Reading this session's transcript…">
          <Pending w="56px" h={4} />
          <Pending w="30px" h={9} />
          <Pending w="56px" h={9} className="ml-auto" />
        </div>
      ) : (
        <div className="mt-auto flex h-[18px] items-center gap-3 box-content pt-2.5 text-small text-dim">
          <ContextMeter context={s.tokens.context} model={s.model} compact />
          <CardModel s={s} />
          {ranCount > 0 && (
            <span className="ml-auto shrink-0 text-dim">
              {ranCount} {ranCount === 1 ? "agent ran" : "agents ran"}
            </span>
          )}
        </div>
      )}
    </motion.button>
  );
});

function StartingCard({ p, chat, i, stagger }: { p?: PtyInfo; chat?: ChatInfo; i: number; stagger: boolean }) {
  const open = useStore((st) => st.open);
  const info = (p ?? chat)!;
  const ready = !!chat && chat.state === "idle";
  return (
    <motion.button
      type="button"
      {...cardMotion(i, stagger)}
      onClick={() => open(chat ? { kind: "chat", id: chat.id } : { kind: "pty", id: p!.id })}
      className={cx(cardCls, "border-dashed border-line")}
    >
      <div className="flex h-[22px] items-center gap-1.5">
        <ProviderMark provider={info.provider} size={14} />
        <span className="min-w-0 flex-1 truncate text-small text-dim">{folderName(info.project || info.cwd)}</span>
        <StateLabel status={ready ? "idle" : "starting"} />
      </div>
      <div className="mt-2 line-clamp-2 text-title font-semibold tracking-[-0.01em] text-fg">
        New {info.provider === "claude" ? "Claude Code" : "Codex"} {chat ? "chat" : "session"}
      </div>
      <div className="mt-2.5 flex h-[22px] items-center gap-2 text-base">
        {ready ? (
          <span className="text-dim">Ready for a first prompt</span>
        ) : (
          <>
            <span className="shimmer font-medium">{chat ? "Starting" : "Waiting for the transcript"}</span>
            {p && <Elapsed since={p.started} className="text-small text-faint" />}
          </>
        )}
      </div>
      <div className="mt-auto box-content h-[18px] pt-4">
        <PathText path={info.cwd} className="text-small text-faint" />
      </div>
    </motion.button>
  );
}

function RecentRow({ s, first }: { s: Session; first: boolean }) {
  const open = useStore((st) => st.open);
  const now = useNow();
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
      <span className="w-[56px] shrink-0 text-right text-small text-faint tnum">{ago(s.updated, now)}</span>
    </div>
  );
}

/** Placeholder bar for a value not parsed yet (Session.loaded === false). */
function Pending({ w, h = 8, className }: { w: string; h?: number; className?: string }) {
  return <Skel w={w} h={h} className={className} />;
}

function CardSkeletons() {
  return (
    <>
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <CardSkeleton key={i} i={i} />
        ))}
      </div>
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
      <p className="mt-1 max-w-[360px] text-base text-dim">
        Start Claude Code or Codex in any project. Sessions you run in a terminal show up here too, live.
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
