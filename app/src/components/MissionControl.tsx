import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { memo, useMemo, useRef, useState } from "react";
import { useNow } from "../lib/clock";
import { useChats } from "../lib/chat";
import { ago, displayTitle, folderName, headlineIsTitle, isThinking, shortDetail, splitTool } from "../lib/format";
import { attention, useChatDigest, type Attention } from "../lib/live";
import { modelColor, modelLabel, sessionModels } from "../lib/models";
import type { Activity, ChatInfo, PtyInfo, Session } from "../lib/types";
import { sessionKey } from "../lib/types";
import { useStableOrder } from "../lib/stable";
import { useStore, type Since } from "../store";
import { IPlay, IPlus, ISpark, toolIcon } from "./icons";
import { Wordmark } from "./Wordmark";
import { Button, ContextMeter, cx, Elapsed, ease, Kbd, NeedsBadge, PathText, ProviderMark, softSpring, StatusPill, Ticker } from "./primitives";
import { resumeInto } from "./SessionView";
import { CardSkeleton, RecentSkeleton, Skel } from "./Skeletons";

export function MissionControl() {
  const sessions = useStore((s) => s.sessions);
  const pending = useStore((s) => s.pending);
  const ptys = useStore((s) => s.ptys);
  const ready = useStore((s) => s.ready);
  const loading = useStore((s) => s.loading);
  const [hover, setHover] = useState(false);
  const setSheet = useStore((s) => s.setSheet);
  const pendingChats = useStore((s) => s.pendingChats);
  const chatInfos = useStore((s) => s.chatInfos);
  const digest = useChatDigest();
  // Stable order ("Needs you", working, waiting; then project, then title) so cards only move when a status flips.
  const { live, att } = useMemo(() => {
    const att = new Map<Session, Attention>();
    for (const s of sessions) att.set(s, attention(s, digest));
    const rank = (s: Session) => (att.get(s)!.needs ? 0 : att.get(s)!.status === "busy" ? 1 : 2);
    const live = sessions
      .filter((s) => att.get(s)!.status !== "ended")
      .sort((a, b) => rank(a) - rank(b) || folderName(a.cwd).localeCompare(folderName(b.cwd)) || displayTitle(a).localeCompare(displayTitle(b)));
    return { live, att };
  }, [sessions, digest]);
  const recent = useMemo(() => sessions.filter((s) => att.get(s)?.status === "ended").slice(0, 6), [sessions, att]);
  const starting = pending.map((id) => ptys[id]).filter(Boolean) as PtyInfo[];
  const startingChats = pendingChats.map((id) => chatInfos[id]).filter(Boolean) as ChatInfo[];
  const busy = live.filter((s) => att.get(s)!.status === "busy" && !att.get(s)!.needs).length;
  const needs = live.filter((s) => att.get(s)!.needs).length;
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
  const projects = new Set(live.map((s) => s.cwd)).size;
  // Stagger only the cards present on first paint; later arrivals just fade in.
  const firstPaint = useRef(true);
  const stagger = firstPaint.current;
  if (ready) firstPaint.current = false;

  return (
    <div className="scroll h-full">
      <div className="mx-auto max-w-[1280px] px-8 pb-12 pt-7">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-display font-semibold tracking-[-0.02em]">Mission control</h1>
            <p className="mt-0.5 flex items-center gap-2 text-base text-dim">
              <span>
              {!ready || loading ? (
                "Looking for sessions…"
              ) : nothing ? (
                "Nothing running right now."
              ) : (
                <>
                  {needs > 0 && (
                    <>
                      <span className="font-medium text-accent-text tnum">{needs}</span> <span className="font-medium text-accent-text">{needs === 1 ? "needs" : "need"} you</span>{" "}
                      <span className="text-faint">·</span>{" "}
                    </>
                  )}
                  <span className="text-busy-text tnum">{busy + starting.length + startingChats.length}</span> working <span className="text-faint">·</span>{" "}
                  <span className="tnum">{live.length - busy - needs}</span> waiting <span className="text-faint">·</span>{" "}
                  <span className="tnum">{projects}</span> {projects === 1 ? "project" : "projects"}
                </>
              )}
              </span>
            </p>
          </div>
          <Button variant="outline" onClick={() => setSheet({ kind: "new" })}>
            <IPlus size={15} />
            New session
          </Button>
        </div>

        {!ready || (loading && nothing) ? (
          <CardSkeletons />
        ) : nothing ? (
          <EmptyState />
        ) : (
          <LayoutGroup>
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
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
            <div className="mb-2 flex items-center gap-2 px-1 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">Recently ended</div>
            <div className="overflow-hidden rounded-[10px] border border-hairline">
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

function lastLines(a: Activity[], n = 2): Activity[] {
  const out: Activity[] = [];
  for (let i = a.length - 1; i >= 0 && out.length < n; i--) out.unshift(a[i]);
  return out;
}

function LineGlyph({ a }: { a: Activity }) {
  if (a.kind === "prompt") return <span className="w-[13px] shrink-0 text-center font-mono text-mono-small font-semibold text-accent-text">›</span>;
  if (a.kind === "error") return <span className="w-[13px] shrink-0 text-center text-small text-err-text">!</span>;
  if (a.kind === "text") return <span className="mx-[4.5px] mt-[1px] size-[4px] shrink-0 rounded-full bg-faint" />;
  const I = a.kind === "agent" ? ISpark : toolIcon(splitTool(a.text).name);
  return <I size={12} className="w-[13px] shrink-0 text-faint" />;
}

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

const Card = memo(function Card({ s, att, i, stagger }: { s: Session; att: Attention; i: number; stagger: boolean }) {
  const open = useStore((st) => st.open);
  const now = useNow();
  const needs = att.needs;
  const busy = att.status === "busy" && !needs;
  const thinking = busy && (!s.current || isThinking(s.current));
  const cur = busy && !thinking && s.current ? splitTool(s.current) : null;
  const CurIcon = cur ? toolIcon(cur.name) : ISpark;
  const since = useCardSince(s);
  const agents = s.agents.filter((a) => !a.finished).length;
  const headline = s.insight?.headline && !headlineIsTitle(s) ? s.insight.headline : null;
  const pending = s.loaded === false;

  return (
    <motion.button
      type="button"
      {...cardMotion(i, stagger)}
      onClick={() => open({ kind: "session", key: sessionKey(s) })}
      whileHover={{ y: -2, transition: { duration: 0.18 } }}
      className={cx(
        "group relative flex h-[256px] flex-col overflow-hidden rounded-[10px] border bg-raised p-3.5 text-left shadow-card transition-[border-color] duration-200",
        needs
          ? "attn-card border-[color-mix(in_oklab,var(--accent)_35%,var(--border))]"
          : "border-line hover:border-[color-mix(in_oklab,var(--dim)_45%,var(--border))]",
      )}
    >
      {busy && <span className="edge-run absolute inset-x-0 top-0 h-px" />}
      <div className="flex items-center gap-1.5">
        <ProviderMark provider={s.provider} size={14} />
        <span className="truncate text-small font-medium text-dim">{folderName(s.cwd)}</span>
        <span className="ml-auto">{needs ? <NeedsBadge /> : <StatusPill status={att.status} />}</span>
      </div>
      <div className={cx("mt-2.5 text-title font-semibold tracking-[-0.01em] text-fg", headline ? "line-clamp-1" : "line-clamp-2")}>{displayTitle(s)}</div>
      {headline && (
        <div className="mt-1 flex items-start gap-1.5 text-small text-dim" title="AI insight">
          <ISpark size={13} className="mt-[4px] shrink-0 text-dim" />
          <span className="line-clamp-2">{headline}</span>
        </div>
      )}

      <div
        className={cx(
          "mt-2.5 flex h-[36px] shrink-0 items-center gap-2 rounded-[8px] px-2.5",
          needs ? "bg-accent-soft" : busy && !pending ? "sweep bg-[color-mix(in_oklab,var(--busy)_8%,transparent)]" : busy ? "bg-[color-mix(in_oklab,var(--busy)_6%,transparent)]" : "bg-[color-mix(in_oklab,var(--dim)_8%,transparent)]",
        )}
      >
        {needs ? (
          <>
            <span className="size-[6px] shrink-0 rounded-full bg-accent breathe" />
            <span className="min-w-0 flex-1 truncate text-base font-medium text-accent-text" title={needs}>
              {needs}
            </span>
            <span className="shrink-0 text-small font-medium text-accent-text/80 opacity-0 transition-opacity group-hover:opacity-100">{att.source === "approval" ? "Review →" : "Open →"}</span>
          </>
        ) : busy ? (
          <>
            <CurIcon size={13} className="shrink-0 text-busy-text" />
            <span className="min-w-0 flex-1 truncate text-base">
              {cur ? (
                <>
                  <span className="font-medium text-fg">{cur.name}</span> <span className="font-mono text-mono-small text-dim">{shortDetail(cur.detail)}</span>
                </>
              ) : pending ? (
                <Skel w="60%" h={9} className="inline-block align-middle" />
              ) : (
                <span className="shimmer font-medium">Thinking</span>
              )}
            </span>
            {!pending && <Elapsed since={since.at} approx={since.approx} className="shrink-0 text-small text-busy-text" />}
          </>
        ) : (
          <>
            <span className="size-[6px] shrink-0 rounded-full bg-accent" />
            <span className="flex-1 text-base text-dim">Waiting for you</span>
            <span className="shrink-0 text-small text-faint">{ago(s.updated, now)}</span>
          </>
        )}
      </div>

      <div className="mt-2.5 flex min-h-0 flex-1 flex-col gap-1 overflow-hidden">
        {pending && (
          <div className="flex flex-col gap-1" title="Reading this session's transcript…">
            {["78%", "56%"].map((w) => (
              <div key={w} className="flex h-[18px] items-center gap-1.5">
                <Skel w={12} h={10} r={3} />
                <Skel w={w} h={8} />
              </div>
            ))}
          </div>
        )}
        <AnimatePresence initial={false} mode="popLayout">
          {lastLines(s.activity, headline ? 1 : 2).map((a) => (
            <motion.div
              key={`${a.ts}${a.text.slice(0, 30)}`}
              layout="position"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.28, ease }}
              className={cx("flex items-center gap-1.5 text-small", a.kind === "error" ? "text-err-text/85" : "text-dim")}
            >
              <LineGlyph a={a} />
              <span className="truncate">{a.kind === "tool" || a.kind === "agent" ? `${splitTool(a.text).name}  ${shortDetail(splitTool(a.text).detail)}` : a.text}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {pending ? (
        <div className="mt-auto flex items-center gap-3 border-t border-hairline pt-2.5" title="Reading this session's transcript…">
          <Pending w="56px" h={4} />
          <span className="flex h-[18px] items-center gap-3">
            <Pending w="30px" h={9} />
            <Pending w="40px" h={9} />
          </span>
          <Pending w="56px" h={9} className="ml-auto" />
        </div>
      ) : (
      <div className="mt-auto flex items-center gap-3 border-t border-hairline pt-2.5">
        <ContextMeter context={s.tokens.context} model={s.model} compact />
        <span className="shrink-0 text-small text-faint">
          out <Ticker value={s.tokens.output} className="text-dim" />
        </span>
        <span className="ml-auto flex min-w-0 items-center gap-2">
          <CardModel s={s} />
          {agents > 0 && (
            <span className="flex shrink-0 items-center gap-1 rounded-[5px] bg-[color-mix(in_oklab,var(--accent-2)_13%,transparent)] px-1.5 text-small font-medium text-dim">
              <ISpark size={12} /> {agents}
            </span>
          )}
        </span>
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
      className="relative flex h-[256px] flex-col overflow-hidden rounded-[10px] border border-dashed border-line bg-raised/60 p-3.5 text-left"
    >
      {!ready && <span className="edge-run absolute inset-x-0 top-0 h-px" />}
      <div className="flex items-center gap-1.5">
        <ProviderMark provider={info.provider} size={14} />
        <span className="truncate text-small font-medium text-dim">{folderName(info.cwd)}</span>
        <span className="ml-auto">
          <StatusPill status={ready ? "idle" : "starting"} />
        </span>
      </div>
      <div className="mt-2.5 text-title font-semibold tracking-[-0.01em] text-fg">
        New {info.provider === "claude" ? "Claude Code" : "Codex"} {chat ? "chat" : "session"}
      </div>
      <PathText path={info.cwd} className="mt-1 text-small text-faint" />
      <div className="mt-auto flex items-center gap-2 text-base">
        {ready ? (
          <span className="text-dim">Ready for a first prompt</span>
        ) : (
          <>
            <span className="shimmer font-medium">{chat ? "Starting" : "Waiting for the transcript"}</span>
            {p && <Elapsed since={p.started} className="text-small text-faint" />}
          </>
        )}
      </div>
    </motion.button>
  );
}

function RecentRow({ s, first }: { s: Session; first: boolean }) {
  const open = useStore((st) => st.open);
  const now = useNow();
  return (
    <div className={cx("group flex h-[44px] items-center gap-3 bg-raised/50 px-3.5 transition-colors duration-150 hover:bg-hover", !first && "border-t border-hairline")}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={() => open({ kind: "session", key: sessionKey(s) })}>
        <ProviderMark provider={s.provider} size={14} />
        <span className="truncate text-base font-semibold text-fg/90">{displayTitle(s)}</span>
        <span className="shrink-0 text-small text-faint">{folderName(s.cwd)}</span>
      </button>
      <span className="shrink-0 text-small text-faint tnum">{ago(s.updated, now)}</span>
      <Button variant="ghost" className="h-[30px] opacity-0 group-hover:opacity-100" onClick={() => resumeInto(s)} title="Resume inside coool">
        <IPlay size={13} />
        Resume
      </Button>
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
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
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
      className="relative flex flex-col items-center overflow-hidden rounded-[14px] border border-dashed border-line px-6 py-16 text-center"
    >
      <div className="pointer-events-none absolute -top-24 h-[256px] w-[420px] rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--accent)_10%,transparent),transparent)]" />
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
