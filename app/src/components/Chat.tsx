// The chat timeline: the Activity look, driven live by chat events.
// Streamed text types out with a caret, tool calls form step lists that grow
// one by one, subagent work nests under its launching step, and permission
// requests become an inline approval card.

import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { answerPermission, answerQuestion, newChat } from "../lib/actions";
import { type Chat, type ChatItem, chatTitle, useChats } from "../lib/chat";
import { clockTime, fmtElapsed, folderName, homeShort, shortDetail, stripToolName } from "../lib/format";
import { permissionWhat, rowText, toolChips, toolRow, type ToolRow } from "../lib/toolNames";
import { patchFiles, patchLead } from "../lib/patch";
import { agentFill, fillModel, handoffLine, taskPrompt } from "../lib/agentFill";
import { FillBar, Handoff } from "./AgentFill";
import { LadderTally, TierTag, tierWord, useChatTiers } from "./LadderTally";
import { LiveTurnBar, TurnBar, useTurnBreakdown, Waterfall } from "./TurnBreakdown";
import { modelLabel } from "../lib/models";
import type { Activity, RememberOption } from "../lib/types";
import { ArtifactCard } from "./ArtifactCard";
import { AwayCard, useChatAway } from "./Away";
import { StepImages } from "./Attachments";
import { imagePaths } from "../lib/attachRules";
import { agentResultParts, FinishedAgentHead, FoldBody, FoldChevron, HistoryBlocks, PromptBubble, StepLine, ThinkingRow, useFocusLit, type AgentEnd } from "./Activity";
import { useFold } from "../lib/cardFold";
import { isStopReason } from "../lib/stopped";
import { AgentMark } from "./AgentMark";
import { MoodSvg } from "./MoodGlyph";
import { Shimmer } from "./Shimmer";
import { Markdown } from "./Markdown";
import { CheckpointsCard } from "./Checkpoints";
import { toolMood } from "../lib/activityMood";
import { LiveIndicator } from "./Activity";
import { RailItem, RailList, reducedMotion, Reveal } from "./StepRail";
import { deriveCheckpoints, type Checkpoints } from "../lib/checkpoints";
import { openChanges } from "../lib/infoRequest";
import { parsePlan, planForTurn } from "../lib/plan";
import { buildBlocks, NO_KIDS, sameList, type Block, type Built, type Tool } from "../lib/chatBlocks";
import { PlanCard } from "./PlanCard";
import { PermExplain, RedactedPre } from "./Explain";
import { RiskTag } from "./RiskTag";
import { LaterBar, useFolded, useQuestionLater } from "./QuestionLater";
import { digitPick, isTyping, keyQuestion } from "../lib/questionKeys";
import { NoteRows } from "./SteerStrip";
import { IAlert, IChevron, ICheck, IClose, IFile, IGlobe, IMac, IPhone, IReturn, ITerminal } from "./icons";
import { PERMISSION_MODES } from "./ChatComposer";
import { ModelTag } from "./Models";
import { Button, cx, ease, JumpToBottom, Kbd, LiveClock, ProviderMark, StatusDot, TokenCount } from "./primitives";
import { useStore } from "../store";
import { isPilotTool, liveRun, parseOutcome, usePilot } from "../lib/pilot";
import type { PilotOutcome } from "../lib/backend";
import { countRender } from "../lib/perfCount";
import { voiceRef } from "./voice/VoiceHost";
import { nextFrame } from "../lib/frame";
import { bringNear, KeepScope, useKept, Windowed, type WindowApi } from "./Windowed";

type Perm = Extract<ChatItem, { kind: "permission" }>;
type Ask = Extract<ChatItem, { kind: "question" }>;

const enter = { opacity: 0, y: 10 };
const shown = { opacity: 1, y: 0 };
const reduced = reducedMotion;

/** `buildBlocks` from the last build: each block that is the same as last time kept as the same object. */
function useStableBlocks(items: ChatItem[]): { blocks: Block[]; children: Map<string, ChatItem[]> } {
  const prev = useRef<Built | null>(null);
  return useMemo(() => (prev.current = buildBlocks(items, prev.current)), [items]);
}

/** The chat's own fields the block views read (besides their items): when one changes, every block renders again. */
function chatSig(c: Chat): string {
  return [c.id, c.provider, c.cwd, c.model, c.running, c.state, c.permissionMode, c.pendingPermission, c.pendingQuestion, c.turnStart].join("\u0001");
}


interface BlockProps {
  b: Block;
  chat: Chat;
  /** chatSig(chat), and the chat's notes and subagent usage (compared by identity). */
  sig: string;
  notes: Chat["notes"];
  agents: Chat["agents"];
  nested: Map<string, ChatItem[]>;
  fresh: boolean;
  cv: boolean;
  latest: boolean;
  isLast: boolean;
  onOpenTerminal: () => void;
  onResume?: () => void;
}

/**
 * Whether a block can keep what it drew: its own items are the same objects, and nothing it reads from the chat
 * changed. A streamed token changes only the newest block, so a long chat re-renders one or two blocks per batch
 * instead of all of them (and finished turns don't recompute their breakdown).
 */
function sameBlockView(p: BlockProps, n: BlockProps): boolean {
  if (p.b !== n.b || p.sig !== n.sig || p.notes !== n.notes || p.agents !== n.agents) return false;
  if (p.fresh !== n.fresh || p.cv !== n.cv || p.latest !== n.latest || p.isLast !== n.isLast || !p.onResume !== !n.onResume) return false;
  if (p.chat.items === n.chat.items) return true;
  const b = n.b;
  if (b.type === "item") {
    // Cards that look elsewhere in the chat: always drawn again.
    if (b.item.kind === "permission" || b.item.kind === "question") return false;
    // A turn's end reads its whole turn (where the time went): the same block means the same `span`.
    return true;
  }
  if (b.type === "steps") {
    // Subagent cards show their own steps (children of the agent's tool call).
    for (const t of b.tools) if (t.agent && !sameList(p.nested.get(t.id) ?? NO_KIDS, n.nested.get(t.id) ?? NO_KIDS)) return false;
  }
  return true;
}

const ChatBlock = memo(function ChatBlock({ b, chat, nested, fresh, cv, latest, onOpenTerminal, onResume }: BlockProps) {
  return (
    // A row arriving fades and rises in (`.row-in`, a CSS one-off on the compositor, not a script animation per frame).
    <div data-block={b.key} className={cx(cv && "cv-auto", fresh && "row-in")}>
      {b.type === "plan" ? (
        <PlanBlock b={b} chat={chat} />
      ) : b.type === "steps" ? (
        <ChatSteps tools={b.tools} chat={chat} nested={nested} latest={latest} />
      ) : b.type === "artifact" ? (
        <ArtifactCard info={b.info} versions={b.versions} />
      ) : (
        <ItemView item={b.item} chat={chat} onOpenTerminal={onOpenTerminal} onResume={onResume} />
      )}
    </div>
  );
}, sameBlockView);

export function ChatTimeline({
  chat: given,
  compact,
  onOpenTerminal,
  onSuggest,
  onResume,
}: {
  chat: Chat;
  compact?: boolean;
  onOpenTerminal: () => void;
  onSuggest: (t: string) => void;
  onResume?: () => void;
}) {
  countRender("ChatTimeline");
  // The live chat: the pane above passes one that holds still while a reply streams (lib/chat.ts useChatShell).
  // While the pane can't be seen (Settings or Needs you over it, the window hidden) it holds still too, and catches
  // up when shown.
  const covered = useCovered();
  const held = useRef<Chat | undefined>(undefined);
  const chat =
    useChats((s) => {
      if (covered && held.current?.id === given.id) return held.current;
      return (held.current = s.chats[given.id]);
    }) ?? given;
  const { blocks, children } = useStableBlocks(chat.items);
  // Stable callbacks for the memoised blocks (the latest ones are called).
  const cbs = useRef({ onOpenTerminal, onResume });
  cbs.current = { onOpenTerminal, onResume };
  const [openTerminal, resume] = useMemo(() => [() => cbs.current.onOpenTerminal(), () => cbs.current.onResume?.()], []);
  const sig = chatSig(chat);
  // "While you were away": the card goes before the first block with anything after the person left.
  const gone = useChatAway(chat);
  const awayAt = gone ? blocks.findIndex((b) => blockAfter(b, gone.away.left)) : -1;
  const earlier = useChats((s) => s.earlier[chat.id]);
  const scroller = useRef<HTMLDivElement>(null);
  const win = useRef<WindowApi | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Scrolled away from the bottom: new output never moves the view; the button says so.
  const [away, setAway] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [needs, setNeeds] = useState(false);
  const pinning = useRef(false);
  const lastTop = useRef(0);
  const toBottom = (smooth: boolean) => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    // The smooth scroll passes through "not at the bottom": do not read that as the reader leaving.
    pinning.current = true;
    setTimeout(() => (pinning.current = false), 900);
    setAway(false);
    setFresh(false);
    setNeeds(false);
    // Smooth only through rows that are drawn (the last one is): from further up it is a jump.
    const glide = smooth && !reducedMotion() && (!blocks.length || !!win.current?.drawn(blocks[blocks.length - 1].key));
    if (glide) win.current?.hold(900);
    el.scrollTo({ top: el.scrollHeight, behavior: glide ? "smooth" : "auto" });
  };
  // The rows of the timeline: the blocks, with the away card before the first block after the person left.
  const rows = useMemo(() => {
    const ks = blocks.map((b) => b.key);
    if (awayAt >= 0) ks.splice(awayAt, 0, AWAY_ROW);
    return ks;
  }, [blocks, awayAt]);
  // Rows drawn wherever they are: the request waiting for an answer, a subagent card asked for, an unread away card.
  const focus = useStore((st) => st.agentFocus);
  const focusId = focus && Date.now() - focus.at < 6000 ? focus.id : null;
  const focusKey = useMemo(() => (focusId ? (blocks.find((b) => b.type === "steps" && b.tools.some((t) => t.agent && t.id === focusId))?.key ?? null) : null), [blocks, focusId]);
  const must = useMemo(() => {
    const out: string[] = [];
    const pp = chat.pendingPermission;
    const pq = chat.pendingQuestion;
    if (pp || pq)
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b.type === "item" && ((b.item.kind === "permission" && b.item.requestId === pp) || (b.item.kind === "question" && b.item.requestId === pq))) out.push(b.key);
      }
    if (focusKey) out.push(focusKey);
    if (gone && !gone.away.folded && awayAt >= 0) out.push(AWAY_ROW);
    return out;
  }, [blocks, chat.pendingPermission, chat.pendingQuestion, focusKey, gone, awayAt]);
  // A subagent card asked for far from the view: brought near first, so its own smooth centring is a short one.
  useEffect(() => {
    if (focusKey) bringNear(scroller.current, focusKey, stick);
  }, [focusKey]);
  const working = chat.state !== "idle" && chat.running;
  // Checkpoints card (one per turn), shown from two checkpoints on.
  // The same object while nothing in it changed (a streamed token changes none of it): the card skips re-rendering.
  const cpsHeld = useRef<{ items: ChatItem[]; live: boolean; cps: Checkpoints } | null>(null);
  const cps = useMemo(() => {
    const h = cpsHeld.current;
    const live = chat.running && chat.state !== "idle";
    // Only replies or reasoning grew (what streaming does): no checkpoint reads their text.
    if (h && h.live === live && h.items.length === chat.items.length && h.items.every((x, i) => x === chat.items[i] || ((x.kind === "text" || x.kind === "thinking") && x.kind === chat.items[i].kind && x.ts === chat.items[i].ts))) {
      h.items = chat.items;
      return h.cps;
    }
    const next = sameCheckpoints(h?.cps ?? null, deriveCheckpoints(chat));
    cpsHeld.current = { items: chat.items, live, cps: next };
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.items, chat.running, chat.state]);
  const showCps = cps.list.length >= 2;
  // Scroll the timeline to a turn's prompt (below the pinned card) and flash it.
  const jumpRef = useRef<(key: string) => void>(() => {});
  const [jumpTo, openFiles] = useMemo(() => [(k: string) => jumpRef.current(k), (k: string) => openChanges(chat.id, k)], [chat.id]);
  const jump = async (key: string) => {
    const el = scroller.current;
    if (!el) return;
    // A turn outside the drawn window is drawn first, then jumped to (a smooth scroll only within the drawn rows).
    const near = !!win.current?.drawn(key);
    const row = await win.current?.ensure(key);
    const block = row?.querySelector<HTMLElement>(`[data-block="${CSS.escape(key)}"]`);
    if (!block) return;
    stick.current = false;
    const delta = block.getBoundingClientRect().top - el.getBoundingClientRect().top - ((bar.current?.offsetHeight ?? 0) + 16);
    const smooth = near && !reducedMotion();
    if (smooth) win.current?.hold(900);
    el.scrollTo({ top: el.scrollTop + delta, behavior: smooth ? "smooth" : "auto" });
    const target = (block.firstElementChild as HTMLElement | null) ?? block;
    const ring = "color-mix(in oklab, var(--text) 40%, transparent)";
    if (reducedMotion()) {
      target.style.boxShadow = `0 0 0 2px ${ring}`;
      setTimeout(() => (target.style.boxShadow = ""), 1200);
    } else target.animate([{ boxShadow: `0 0 0 2px ${ring}` }, { boxShadow: "0 0 0 2px transparent" }], { duration: 1400, easing: "ease-out" });
  };

  jumpRef.current = jump;

  // Pin to the bottom while the reader is there. A ResizeObserver catches every
  // growth (streamed lines, steps expanding) so the view follows without jumps.
  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    el.scrollTop = el.scrollHeight;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);
  // New output while the reader is scrolled up: the jump button says so. (From the items, not the column's height:
  // rows drawn as they scroll into view change that height too.)
  const lastItems = useRef(chat.items);
  useLayoutEffect(() => {
    if (lastItems.current === chat.items) return;
    lastItems.current = chat.items;
    if (!stick.current) setFresh(true);
  }, [chat.items]);

  // The away card starts the reading: when it first shows above the view, scroll it to the top (the jump
  // button then says there is more below). Once per absence.
  const awayShown = useRef<number | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !gone || gone.away.folded || awayShown.current === gone.away.back) return;
    // After the timeline has settled (pinned to the bottom, fonts and code laid out).
    const t = setTimeout(() => {
      const card = el.querySelector<HTMLElement>("[data-away-card]");
      if (!card) return;
      awayShown.current = gone.away.back;
      const top = card.getBoundingClientRect().top - el.getBoundingClientRect().top - ((bar.current?.offsetHeight ?? 0) + 16);
      if (top >= 0) return;
      stick.current = false;
      setAway(true);
      el.scrollTo({ top: el.scrollTop + top, behavior: "auto" });
    }, 120);
    return () => clearTimeout(t);
  }, [gone]);

  // New INPUT (a prompt or steering note sent, an approval or question answered) always scrolls to the bottom and re-pins.
  const inputs = chat.notes.length + chat.items.reduce((n, i) => n + (i.kind === "prompt" || (i.kind === "permission" && i.answer) || (i.kind === "question" && i.answer) ? 1 : 0), 0);
  const inputsSeen = useRef(inputs);
  useLayoutEffect(() => {
    if (inputs > inputsSeen.current) toBottom(true);
    inputsSeen.current = inputs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs]);

  // Keep a newly arrived approval / question card fully visible above the composer (or, when
  // it is taller than the viewport, with its top just under the header). Only on arrival and
  // while the card grows; once the reader scrolls themselves we leave the position alone.
  const revealed = useRef<string | null>(null);
  const userMoved = useRef(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const mark = () => {
      userMoved.current = true;
    };
    el.addEventListener("wheel", mark, { passive: true });
    el.addEventListener("touchmove", mark, { passive: true });
    el.addEventListener("keydown", mark);
    return () => {
      el.removeEventListener("wheel", mark);
      el.removeEventListener("touchmove", mark);
      el.removeEventListener("keydown", mark);
    };
  }, []);
  const askKey = chat.pendingPermission ? `p:${chat.pendingPermission}` : chat.pendingQuestion ? `q:${chat.pendingQuestion}` : null;
  useEffect(() => {
    const el = scroller.current;
    if (!el || !askKey) {
      revealed.current = null;
      return;
    }
    const card = el.querySelector<HTMLElement>("[data-approval], [data-question]");
    if (!card) return;
    const reveal = (smooth: boolean) => {
      const margin = 12;
      const sr = el.getBoundingClientRect();
      const cr = card.getBoundingClientRect();
      let delta = 0;
      if (cr.height + margin * 2 > sr.height) delta = cr.top - sr.top - margin;
      else if (cr.bottom > sr.bottom - margin) delta = cr.bottom - sr.bottom + margin;
      else if (cr.top < sr.top + margin) delta = cr.top - sr.top - margin;
      if (Math.abs(delta) < 1) return;
      if (cr.height + margin * 2 > sr.height) stick.current = false; // keep the top in view
      el.scrollTo({ top: el.scrollTop + delta, behavior: smooth && !reduced() ? "smooth" : "auto" });
    };
    if (revealed.current !== askKey) {
      revealed.current = askKey;
      userMoved.current = false;
      // Scrolled up: do not yank; the button turns blue instead.
      if (!stick.current) {
        setNeeds(true);
        return;
      }
      reveal(true);
    }
    // The card can still grow (options render, remember list); follow it until the reader scrolls.
    const ro = new ResizeObserver(() => {
      if (!userMoved.current) reveal(true);
    });
    ro.observe(card);
    return () => ro.disconnect();
  }, [askKey, chat.items]);

  const last = blocks[blocks.length - 1];
  const lastItem = last?.type === "item" ? last.item : null;
  const liveText = lastItem?.kind === "text" && lastItem.streaming;
  const liveThink = lastItem?.kind === "thinking" && lastItem.endTs === null;
  const awaiting = !!chat.pendingPermission || !!chat.pendingQuestion;
  // The one live indicator row of the running turn: what the agent is doing right now.
  const now = useMemo(() => {
    let tool: Extract<ChatItem, { kind: "tool" }> | null = null;
    let agent: Extract<ChatItem, { kind: "tool" }> | null = null;
    let agents = 0;
    for (const it of chat.items) {
      if (it.kind !== "tool" || it.parent || it.endTs !== null) continue;
      if (it.agent) {
        agent = it;
        agents++;
      } else tool = it;
    }
    // The main agent's own work first; only subagents running and it doing nothing is the quiet "N agents running" line.
    if (tool) return { mood: toolMood(tool.name), detail: toolSummary(tool, chat.cwd), at: tool.ts, agents, mainActive: true };
    if (liveThink || liveText) return { mood: liveText ? ("write" as const) : chat.permissionMode === "plan" ? ("plan" as const) : ("think" as const), detail: "", at: lastItem?.ts ?? null, agents, mainActive: true };
    if (agent) return { mood: "delegate" as const, detail: stripToolName(agent.name, agent.summary || ""), at: agent.ts, agents, mainActive: false };
    return { mood: chat.permissionMode === "plan" ? ("plan" as const) : ("think" as const), detail: "", at: null, agents: 0, mainActive: true };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.items, chat.cwd, chat.permissionMode, liveText, liveThink]);
  const showRow = working && !awaiting;
  // Precise: from event timestamps, never from HH:MM:SS.
  const idleSince = useMemo(() => {
    let t = chat.turnStart ?? chat.lastTs;
    for (const it of chat.items) {
      if ("parent" in it && it.parent) continue;
      const end = it.kind === "tool" ? (it.endTs ?? it.ts) : it.kind === "thinking" ? (it.endTs ?? it.ts) : it.ts;
      if (end > t) t = end;
    }
    return t;
  }, [chat.items, chat.turnStart, chat.lastTs]);

  return (
    <div className="flex h-full flex-col">
    <div
      ref={scroller}
      className="scroll min-h-0 flex-1"
      data-chat-timeline={chat.id}
      onScroll={(e) => {
        const el = e.currentTarget;
        const at = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        // Only the reader moving up unpins (a smooth scroll to the bottom moves down; growth below keeps scrollTop).
        const up = el.scrollTop < lastTop.current - 1;
        lastTop.current = el.scrollTop;
        if (pinning.current && !at) return;
        if (at) stick.current = true;
        else if (up) stick.current = false;
        const isAway = !stick.current;
        setAway((a) => (a === isAway ? a : isAway));
        if (at) {
          setFresh(false);
          setNeeds(false);
        }
      }}
    >
      <div ref={content}>
        {showCps && (
          // Opaque from the header's bottom edge to the bar's bottom edge, then a short fade; in flow, so an expanded bar pushes the timeline down.
          <div ref={bar} className="sticky -top-1 z-20 bg-bg pt-1" data-checkpoints-sticky>
            <div className={cx("mx-auto max-w-[700px] pb-2 pt-2", compact ? "px-4" : "px-8")}>
              <CheckpointsSlot chat={chat} cps={cps} onJump={jumpTo} onFiles={openFiles} />
            </div>
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-full h-5" style={{ background: "linear-gradient(to bottom, var(--bg), transparent)" }} />
          </div>
        )}
        <div className={cx("mx-auto flex max-w-[700px] flex-col pb-[40px]", showCps ? "pt-3" : "pt-6", compact ? "gap-3 px-4" : "gap-4 px-8")}>
        {earlier && earlier.length > 0 && <Earlier rows={earlier} />}
        {!chat.ready && blocks.length === 0 && (
          <div className="flex min-h-[40vh] items-center justify-center">
            <ThinkingRow since={chat.lastTs} label={`Starting ${chat.provider} in ${folderName(chat.cwd)}`} mood="start" big />
          </div>
        )}
        {chat.ready && blocks.length === 0 && !earlier?.length && <Welcome chat={chat} onSuggest={onSuggest} />}
        {rows.length > 0 && (
          <KeepScope.Provider value={`chat:${chat.id}`}>
          <Windowed
            scroller={scroller}
            stick={stick}
            keys={rows}
            gap={compact ? 12 : 16}
            must={must}
            api={win}
            className={cx("flex flex-col", compact ? "gap-3" : "gap-4")}
            estimate={(r) => {
              const i = awayAt >= 0 && r >= awayAt ? r - 1 : r;
              return r === awayAt ? 120 : blockHeight(blocks[i], i >= blocks.length - 2);
            }}
            renderRow={(r, fresh) => {
              if (r === awayAt && gone)
                return <AwayCard chatKey={gone.key} sum={gone.sum} folded={!!gone.away.folded} canRetry={chat.running && chat.state === "idle"} onRetry={onSuggest} onJump={jump} />;
              const i = awayAt >= 0 && r > awayAt ? r - 1 : r;
              const b = blocks[i];
              const isLast = i === blocks.length - 1;
              return (
                <ChatBlock
                  b={b}
                  chat={chat}
                  sig={sig}
                  notes={chat.notes}
                  agents={chat.agents}
                  nested={children}
                  fresh={fresh}
                  cv={!isLast && i < blocks.length - 8}
                  latest={isLast || i >= blocks.length - 2}
                  isLast={isLast}
                  onOpenTerminal={openTerminal}
                  onResume={isLast && onResume ? resume : undefined}
                />
              );
            }}
          />
          </KeepScope.Provider>
        )}
        <AnimatePresence>
          {showRow && (
            <motion.div key="thinking" initial={enter} animate={shown} exit={{ opacity: 0, transition: { duration: 0.15 } }} transition={{ duration: 0.3, ease }}>
              <LiveIndicator since={now.at ?? idleSince} mood={now.mood} detail={now.detail} agents={now.agents} mainActive={now.mainActive} timerSince={chat.turnStart ?? idleSince} tokens={Math.max(0, Math.max(chat.outShown, chat.tokens.output) - chat.turnOut0)} />
              <LiveTurnBar chat={chat} />
            </motion.div>
          )}
        </AnimatePresence>
        </div>
      </div>
    </div>
    {/* The jump button floats over the bottom of the timeline as a small solid pill, nothing behind it; it only shows while the reader is away. */}
    <div className="relative h-0 shrink-0">
      <JumpToBottom away={away} fresh={fresh} needs={needs} onClick={() => toBottom(true)} />
    </div>
    <LaterBar chat={chat} compact={compact} />
    </div>
  );
}

/** Whether the panes can't be seen: Settings or the Needs you page over them, or the window hidden. */
function useCovered(): boolean {
  const over = useStore((s) => s.settings !== null || s.needsPage);
  const hidden = useSyncExternalStore(
    (cb) => {
      document.addEventListener("visibilitychange", cb);
      return () => document.removeEventListener("visibilitychange", cb);
    },
    () => document.hidden,
  );
  return over || hidden;
}

const AWAY_ROW = "\u0001away";

/** `next`, or `prev` when every checkpoint in it is the same. */
function sameCheckpoints(prev: Checkpoints | null, next: Checkpoints): Checkpoints {
  if (!prev || prev.attempts !== next.attempts || prev.list.length !== next.list.length) return next;
  for (let i = 0; i < next.list.length; i++) {
    const a = prev.list[i] as unknown as Record<string, unknown>;
    const b = next.list[i] as unknown as Record<string, unknown>;
    for (const k in b) if (a[k] !== b[k]) return next;
  }
  return prev;
}

/** The checkpoints card, drawn again only when its checkpoints or the chat's title change (not per streamed token). */
const CheckpointsSlot = memo(
  function CheckpointsSlot(p: { chat: Chat; cps: Checkpoints; onJump: (key: string) => void; onFiles: (key: string) => void }) {
    return <CheckpointsCard {...p} />;
  },
  (a, b) => a.cps === b.cps && a.onJump === b.onJump && a.onFiles === b.onFiles && a.chat.id === b.chat.id && chatTitle(a.chat) === chatTitle(b.chat),
);

/** A block's height before it has been drawn (Windowed's estimate; measured once drawn). */
function blockHeight(b: Block, latest: boolean): number {
  if (b.type === "steps") return 30 + (latest || b.tools.length <= 2 ? b.tools.length * 30 : 0);
  if (b.type === "plan") return 180;
  if (b.type === "artifact") return 120;
  switch (b.item.kind) {
    case "text":
      return 30 + Math.ceil(b.item.text.length / 80) * 26;
    case "prompt":
      return 70 + Math.ceil(b.item.text.length / 70) * 24;
    case "turn":
    case "thinking":
      return 30;
    case "permission":
    case "question":
      return 220;
    default:
      return 44;
  }
}

/** Whether a block holds anything from after `t` (where the away card goes). */
function blockAfter(b: Block, t: number): boolean {
  if (b.type === "item") return b.item.ts > t;
  if (b.type === "steps") return b.tools.some((x) => x.ts > t);
  if (b.type === "plan") return b.calls.some((x) => x.ts > t);
  return false;
}

function PlanBlock({ b, chat }: { b: Extract<Block, { type: "plan" }>; chat: Chat }) {
  const live = chat.running && chat.state !== "idle" && !b.end;
  const p = planForTurn(b.calls, b.prompt, b.end, live);
  if (!p) return null;
  return <PlanCard title={p.title} subtitle={p.subtitle} steps={p.steps} phase={p.phase} startedAt={p.startedAt} endedAt={p.endedAt} data-turn-plan={p.phase} />;
}

/** Claude's plan-mode proposal (the ExitPlanMode permission request) as a plan card. */
export function PlanApproval({ item, chat }: { item: Perm; chat: Chat }) {
  const raw = (item.input as { plan?: unknown } | null)?.plan;
  const md = typeof raw === "string" ? raw : item.summary;
  const p = useMemo(() => parsePlan(md), [md]);
  const open = item.answer === null && chat.running;
  // Answered elsewhere (a replay): the ExitPlanMode result says whether the plan was approved.
  let settled: "approved" | "kept" = item.answer === "deny" ? "kept" : "approved";
  if (item.answer === "answered") {
    const t = chat.items.find((x) => x.kind === "tool" && x.name === "ExitPlanMode" && x.ts >= item.ts - 50) as Tool | undefined;
    if (t?.endTs && !/has approved your plan/i.test(t.output)) settled = "kept";
  }
  const phase = open ? "proposed" : settled;
  return (
    <PlanCard
      title={p.title}
      steps={p.steps}
      phase={phase}
      attention={open}
      data-approval={open ? item.requestId : undefined}
      data-approval-done={open ? undefined : (item.answer ?? "")}
      body={p.body ? <Markdown text={p.body} /> : undefined}
      onApprove={open ? () => answerPermission(chat.id, item.requestId, "allow") : undefined}
      onReject={open ? () => answerPermission(chat.id, item.requestId, "deny") : undefined}
    />
  );
}

function ItemView({ item, chat, onOpenTerminal, onResume }: { item: ChatItem; chat: Chat; onOpenTerminal: () => void; onResume?: () => void }) {
  countRender("Chat.ItemView");
  switch (item.kind) {
    case "prompt":
      return <PromptBubble text={item.text} stamp={item.unsent ? `${clockTime(item.ts)} · not sent` : clockTime(item.ts)} unsent={item.unsent} attachments={item.attachments} scope={item.key} />;
    case "text":
      return <AssistantText text={item.text} streaming={item.streaming} />;
    case "thinking":
      return <ThinkingBlock item={item} />;
    case "permission":
      return <Approval item={item} chat={chat} />;
    case "question":
      return <QuestionCard item={item} chat={chat} />;
    case "notice":
      return <Notice item={item} onOpenTerminal={onOpenTerminal} />;
    case "turn":
      return <TurnEnd item={item} chat={chat} />;
    case "exited":
      return <Exited item={item} onResume={onResume} />;
    case "open_failed":
      return <OpenFailedCard item={item} chat={chat} />;
    default:
      return null;
  }
}

// ---------- streamed text ----------

/** Reveal streamed text smoothly: the shown length chases the received length. */
function useReveal(text: string, streaming: boolean): number {
  const [n, setN] = useState(text.length);
  const target = useRef(text.length);
  target.current = text.length;
  const cur = useRef(text.length);
  useEffect(() => {
    if (reduced()) {
      cur.current = text.length;
      setN(text.length);
      return;
    }
    if (cur.current >= text.length) {
      cur.current = Math.min(cur.current, text.length);
      return;
    }
    // In the shared frame (lib/frame.ts): with the chat's batches, at most ~60 steps a second.
    let cancel = () => {};
    let lastT = performance.now();
    const step = (t: number) => {
      const dt = Math.min(64, t - lastT);
      lastT = t;
      const behind = target.current - cur.current;
      if (behind <= 0) return;
      // Catch up within ~180ms (faster once the message is complete), at least ~60 chars/s.
      const rate = Math.max(60, behind / (streaming ? 0.18 : 0.08));
      cur.current = Math.min(target.current, cur.current + Math.max(1, Math.round((rate * dt) / 1000)));
      setN(cur.current);
      if (cur.current < target.current) cancel = nextFrame(step);
    };
    cancel = nextFrame(step);
    return () => cancel();
  }, [text, streaming]);
  return Math.min(n, text.length);
}

const AssistantText = memo(function AssistantText({ text, streaming, small }: { text: string; streaming: boolean; small?: boolean }) {
  countRender("Chat.AssistantText");
  const n = useReveal(text, streaming);
  const typing = streaming || n < text.length;
  return <Markdown text={text.slice(0, n)} streaming={typing} className={small ? "text-small text-dim" : "text-prose text-fg/90"} />;
});

// ---------- thinking ----------

export function ThinkingBlock({ item }: { item: Extract<ChatItem, { kind: "thinking" }> }) {
  const [open, setOpen] = useKept(`think:${item.key}`, false);
  const live = item.endTs === null;
  const lastLine = item.text.trim().split(/\n/).pop() ?? "";
  // A stretch that ends while on screen: the icon pops into a check for a moment and the label sweeps in.
  const wasLive = useRef(live);
  const [pop, setPop] = useState(false);
  useEffect(() => {
    if (live) {
      wasLive.current = true;
      return;
    }
    if (!wasLive.current) return;
    wasLive.current = false;
    if (reducedMotion()) return;
    setPop(true);
    const t = setTimeout(() => setPop(false), 1200);
    return () => clearTimeout(t);
  }, [live]);
  if (live)
    return (
      <div className="flex flex-col gap-1">
        {lastLine && (
          <div className="ml-1 line-clamp-2 max-w-[640px] text-base italic text-faint">
            <span key={item.text.length} className="stream-chunk">
              {lastLine}
            </span>
          </div>
        )}
      </div>
    );
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="group flex items-center gap-2 rounded-[8px] py-1 pl-0.5 pr-2 text-base hover:bg-hover">
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.18, ease }} className="flex size-[22px] items-center justify-center text-faint">
          <IChevron size={14} />
        </motion.span>
        {pop ? (
          <motion.span initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 420, damping: 18 }} className="flex text-dim">
            <ICheck size={14} />
          </motion.span>
        ) : (
          <MoodSvg mood="think" size={14} live={false} className="text-dim/80" />
        )}
        <span className="text-dim group-hover:text-fg/85">
          <Reveal key={pop ? "pop" : "rest"} text={`Thought for ${fmtElapsed((item.endTs ?? item.ts) - item.ts)}`} fresh={pop} />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease }} className="overflow-hidden">
            <div className="selectable ml-[9px] mt-1 whitespace-pre-wrap border-l border-hairline pl-4 text-base italic text-dim">{item.text}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------- steps ----------

/** A path as the reader thinks of it: relative to the chat's folder when inside it, else with `~`. */
function relPath(p: string, cwd: string): string {
  const norm = (x: string) => x.replace(/^\/private(?=\/(tmp|var)\/)/, "").replace(/\/+$/, "");
  const [a, base] = [norm(p), norm(cwd)];
  if (base && a.startsWith(base + "/")) return a.slice(base.length + 1);
  return homeShort(p);
}

/** A step as it reads (lib/toolNames.ts): built-ins keep their name, with a file path relative to the chat's folder. */
export function stepRow(t: Tool, cwd: string): ToolRow {
  const r = toolRow({ name: t.name, input: t.input, output: t.output, summary: t.summary, ok: t.ok, running: t.endTs === null });
  if (r.family !== "tool") return r;
  // From the input when it names a file: the core's one-line summary may have clipped a long path.
  const i = (t.input ?? {}) as Record<string, unknown>;
  const file = typeof i.file_path === "string" ? i.file_path : typeof i.notebook_path === "string" ? i.notebook_path : null;
  return file && cwd ? { ...r, detail: relPath(file, cwd) } : r;
}

function toolSummary(t: Tool, cwd: string): string {
  const r = stepRow(t, cwd);
  return r.family === "tool" ? r.detail : rowText(r);
}

const ChatSteps = memo(function ChatSteps({ tools, chat, nested, latest }: { tools: Tool[]; chat: Chat; nested: Map<string, ChatItem[]>; latest: boolean }) {
  countRender("Chat.Steps");
  const [open, setOpen] = useKept<boolean | null>(`steps:${tools[0].key}`, null);
  const active = tools.some((t) => t.endTs === null);
  const focus = useStore((st) => st.agentFocus);
  const holdsFocus = !!focus && Date.now() - focus.at < 6000 && tools.some((t) => t.agent && t.id === focus.id);
  useEffect(() => {
    if (holdsFocus) setOpen(true);
  }, [holdsFocus]);
  const isOpen = open ?? (latest || active || tools.length <= 2);
  const mountKeys = useRef(new Set(tools.map((t) => t.key)));
  // A wait that timed out is not a failure to act on (lib/toolNames.ts `soft`).
  const failed = tools.filter((t) => t.ok === false && !t.stopped && !toolRow({ name: t.name, input: t.input, output: t.output, ok: t.ok }).soft).length;
  const end = Math.max(...tools.map((t) => t.endTs ?? t.ts));
  const span = end - tools[0].ts;
  const pendingTool = chat.pendingPermission ? (chat.items.find((i) => i.kind === "permission" && i.requestId === chat.pendingPermission) as Perm | undefined)?.tool : undefined;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!isOpen)}
        className="group flex w-full items-center gap-2 rounded-[8px] py-[3px] pl-0.5 pr-2 text-left text-base transition-colors duration-150 hover:bg-hover"
      >
        <motion.span animate={{ rotate: isOpen ? 90 : 0 }} transition={{ duration: 0.18, ease }} className="flex size-[22px] items-center justify-center text-faint group-hover:text-dim">
          <IChevron size={14} />
        </motion.span>
        {active ? (
          <Shimmer className="font-medium">{`Running ${tools.length === 1 ? "a step" : `${tools.length} steps`}`}</Shimmer>
        ) : (
          <span className="font-medium text-dim group-hover:text-fg/85">Ran {tools.length === 1 ? "1 step" : `${tools.length} steps`}</span>
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {toolChips(tools).map(([name, n]) => (
            <span key={name} className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[6px] bg-[color-mix(in_oklab,var(--dim)_11%,transparent)] px-1.5 text-small font-medium text-dim" data-step-chip={name}>
              {name}
              {n > 1 && <span className="tnum text-faint">×{n}</span>}
            </span>
          ))}
          {failed > 0 && <span className="inline-flex h-[22px] shrink-0 items-center rounded-[6px] bg-[color-mix(in_oklab,var(--error)_10%,transparent)] px-1.5 text-small font-medium text-err-text">{failed} failed</span>}
        </span>
        {!active && span > 0 && <span className="shrink-0 text-small text-faint tnum">{fmtElapsed(span)}</span>}
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div key="list" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: reducedMotion() ? 0 : 0.24, ease }} className="overflow-hidden">
            <RailList className="ml-[12px] mt-1 pb-1">
              {tools.map((t, i) => {
                const fresh = !mountKeys.current.has(t.key);
                return (
                  <RailItem key={t.key} first={i === 0} last={i === tools.length - 1} fresh={fresh} active={t.endTs === null} dotY={t.agent ? 20 : 14}>
                    {t.agent ? (
                      <AgentCard tool={t} chat={chat} kids={nested.get(t.id) ?? []} />
                    ) : isPilotTool(t.name) ? (
                      <PilotRun t={t} chat={chat.id} fresh={fresh} />
                    ) : (
                      <>
                        <ToolStep t={t} cwd={chat.cwd} waiting={t.endTs === null && pendingTool === t.name} fresh={fresh} />
                        <NoteRows notes={chat.notes.filter((n) => n.toolId === t.id)} />
                      </>
                    )}
                  </RailItem>
                );
              })}
            </RailList>
            <AgentsSummary tools={tools} nested={nested} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

/** After several subagents of one turn have all finished: one dim line with the wall-clock span (not the sum). */
function AgentsSummary({ tools, nested }: { tools: Tool[]; nested: Map<string, ChatItem[]> }) {
  const agents = tools.filter((t) => t.agent);
  if (agents.length < 2 || agents.some((a) => a.endTs === null)) return null;
  const uses = agents.reduce((n, a) => n + (nested.get(a.id) ?? []).filter((k) => k.kind === "tool").length, 0);
  const span = Math.max(...agents.map((a) => a.endTs ?? a.ts)) - Math.min(...agents.map((a) => a.ts));
  const parts = [`${agents.length} agents finished`, uses > 0 && `${uses} tool ${uses === 1 ? "use" : "uses"}`, span > 0 && fmtElapsed(span)].filter(Boolean);
  return (
    <div className="ml-[34px] pb-1 pt-0.5 text-small text-faint tnum" data-agents-summary>
      {parts.join(" · ")}
    </div>
  );
}

const PILOT_STATUS: Record<PilotOutcome["status"], string> = { done: "done", stuck: "stuck", surprised: "surprised", out_of_budget: "out of budget" };
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

/**
 * A `pilot_run` call: one step with its goal, then the pilot's own steps as they happen (which decider took each,
 * memory or the model, and how long it took), then how it ended.
 */
function PilotRun({ t, chat, fresh }: { t: Tool; chat: number; fresh?: boolean }) {
  const goal = String((t.input as { goal?: unknown } | null)?.goal ?? "");
  const to = (t.input as { target?: unknown } | null)?.target;
  const target = to === "browser" ? "Browser" : to === "mac" ? "Mac" : "iPhone";
  const live = usePilot((s) => liveRun(s.runs, chat, t.ts, goal));
  const running = t.endTs === null;
  const done = useMemo(() => (running ? null : parseOutcome(t.output)), [running, t.output]);
  const o = done ?? live?.outcome ?? null;
  const steps = o?.steps ?? [];
  const ended = !!done || !!live?.end;
  const ok = o?.status === "done";
  return (
    <div data-pilot-run={o?.status ?? "running"}>
      <StepLine name={`Pilot · ${target}`} tool={t.name} detail={goal} active={running} failed={t.ok === false} fresh={fresh} stamp={clockTime(t.ts)} since={t.ts} />
      {(steps.length > 0 || ended) && (
        <div className="mb-1 ml-[28px] mt-0.5 flex flex-col gap-[3px] border-l border-hairline pl-3">
          {steps.map((s) => (
            <div key={s.n} className="flex min-w-0 items-center gap-2 text-small" data-pilot-substep={s.n} data-decider={s.decider}>
              <span className="w-[14px] shrink-0 text-right text-faint tnum">{s.n}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-mono-small text-dim" title={s.note || s.action}>
                {s.action}
              </span>
              <span
                className={cx(
                  "inline-flex h-[18px] shrink-0 items-center rounded-[5px] px-1.5 text-micro font-medium",
                  s.decider === "memory" ? "bg-[color-mix(in_oklab,var(--status-done)_14%,transparent)] text-fg/80" : "bg-[color-mix(in_oklab,var(--accent-2)_14%,transparent)] text-dim",
                )}
                title={s.decider === "memory" ? "Muscle memory: a remembered step for this screen" : `Decided by ${o?.haiku || s.decider}`}
              >
                {s.decider}
              </span>
              <span className="w-[54px] shrink-0 text-right text-faint tnum" title={`perceive ${s.perceive_ms} ms · decide ${s.decide_ms} ms · act ${s.act_ms} ms · settle ${s.settle_ms} ms`}>
                {fmtMs(s.perceive_ms + s.decide_ms + s.act_ms + s.settle_ms)}
              </span>
            </div>
          ))}
          {ended && o && (
            <div className={cx("text-small tnum", ok ? "text-faint" : "text-needs-text")} data-pilot-status={o.status}>
              {PILOT_STATUS[o.status] ?? o.status}
              {o.verified && " · verified"}
              {` · ${steps.length} ${steps.length === 1 ? "step" : "steps"} · ${fmtMs(o.wall_ms)}`}
              {Object.entries(o.deciders).map(([k, n]) => ` · ${n} ${k}`)}
              {!ok && o.reason && <span className="text-dim">{` — ${o.reason}`}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolStep({ t, cwd, dense, waiting, fresh, stoppedIn = false }: { t: Tool; cwd: string; dense?: boolean; waiting?: boolean; fresh?: boolean; stoppedIn?: boolean }) {
  const [open, setOpen] = useKept(`tool:${t.key}`, false);
  const hasOut = !!t.output && t.endTs !== null;
  const r = stepRow(t, cwd);
  // Image paths the step names (a screenshot it saved, an image it read): a preview each, read only when clicked.
  const shots = useMemo(() => (t.endTs === null || t.ok === false ? [] : imagePaths(`${JSON.stringify(t.input ?? "")}\n${t.output}`, 3)), [t.endTs, t.ok, t.input, t.output]);
  return (
    <div data-step-family={r.family}>
      <StepLine
        name={r.label}
        tool={t.name}
        soft={r.soft}
        detail={dense && r.family === "tool" ? shortDetail(r.detail) : r.detail}
        active={t.endTs === null}
        waiting={waiting}
        failed={t.ok === false}
        stopped={t.ok === false && (!!t.stopped || stoppedIn)}
        dense={dense}
        fresh={fresh}
        stamp={clockTime(t.ts)}
        since={t.ts}
        onClick={hasOut ? () => setOpen(!open) : undefined}
        open={open}
      />
      {shots.length > 0 && (
        <div className="-mt-0.5 mb-0.5 ml-[18px]">
          <StepImages paths={shots} />
        </div>
      )}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease }} className="overflow-hidden">
            <pre
              className={cx(
                "selectable mb-1.5 ml-[6px] mt-0.5 max-h-[220px] overflow-auto whitespace-pre-wrap rounded-[8px] border border-hairline px-3 py-2 font-mono text-mono-small leading-[16px]",
                t.ok === false && !t.stopped && !stoppedIn && !r.soft ? "bg-[color-mix(in_oklab,var(--error)_6%,transparent)] text-err-text/90" : "bg-[color-mix(in_oklab,var(--dim)_6%,transparent)] text-dim",
              )}
            >
              {t.output}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AgentCard({ tool, chat, kids }: { tool: Tool; chat: Chat; kids: ChatItem[] }) {
  const running = tool.endTs === null;
  const steps = kids.filter((k): k is Tool => k.kind === "tool");
  const shownSteps = steps.slice(-6);
  const hidden = steps.length - shownSteps.length;
  const texts = kids.filter((k): k is Extract<ChatItem, { kind: "text" }> => k.kind === "text");
  const note = texts[texts.length - 1];
  const kind = (tool.input as { subagent_type?: string } | null)?.subagent_type || "subagent";
  const models = Object.keys(chat.agents[tool.id]?.models ?? {});
  const fromText = [...new Set(texts.map((t) => t.model).filter(Boolean) as string[])];
  const modelIds = models.length ? models : fromText;
  const agentOut = chat.agents[tool.id]?.total || Object.values(chat.agents[tool.id]?.models ?? {}).reduce((n, u) => n + u.output, 0);
  const tiers = useChatTiers(chat.id);
  const agentSeen = useRef(new Set(shownSteps.map((s) => s.key)));
  const card = useRef<HTMLDivElement>(null);
  const focus = useStore((st) => st.agentFocus);
  const asked = !!focus && focus.id === tool.id && Date.now() - focus.at < 6000;
  const lit = useFocusLit(asked, card);
  // Finished cards (done, failed, stopped) fold to one row; see lib/cardFold.ts.
  const [open, toggle] = useFold(`chat:${tool.id}`, !running, card);
  useEffect(() => {
    if (asked && !open) toggle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);
  const end: AgentEnd = tool.ok === false ? (tool.stopped || !tool.output.trim() || isStopReason(tool.output) ? "stopped" : "failed") : "done";
  const reason = tool.ok === false ? tool.output.split("\n").find((l) => l.trim())?.trim().replace(/^\[(.*)\]$/, "$1") || null : null;
  const title = stripToolName(tool.name, tool.summary);
  const fill = agentFill(chat.agents[tool.id]?.total, fillModel(modelIds[0], tool.input, chat.model));
  const prompt = taskPrompt(tool.input);
  const handoff = handoffLine(prompt, title);
  const extra = (fill || handoff) && (
    <div className="flex flex-col gap-1 px-3 pb-1.5" data-agent-extra>
      {fill && <FillBar fill={fill} running={running} />}
      {handoff && <Handoff text={handoff} full={prompt} />}
    </div>
  );
  return (
    <div className="flex gap-2.5 py-1">
      <span className="relative z-[1] mt-[7px] flex size-[18px] shrink-0 items-center justify-center rounded-full bg-bg text-dim">
        <AgentMark size={14} state={running ? "live" : end} />
      </span>
      <div
        ref={card}
        data-agent-card={tool.id}
        data-open={open}
        className={cx(
          "min-w-0 flex-1 overflow-hidden rounded-[10px] border bg-raised shadow-card transition-[border-color] duration-500",
          lit ? "border-[color-mix(in_oklab,var(--status-needs)_45%,var(--border))]" : "border-hairline",
        )}
      >
        {running ? (
          <div role="button" tabIndex={0} onClick={toggle} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())} className="flex cursor-default items-center gap-2 px-3 pb-1.5 pt-2">
            <span className="rounded-[6px] bg-[color-mix(in_oklab,var(--accent-2)_14%,transparent)] px-1.5 text-small font-medium text-dim">{kind}</span>
            <span className="min-w-0 flex-1 truncate text-base font-medium text-fg">{title}</span>
            <TierTag role={tierWord(tiers, modelIds[0], chat.provider)} />
            {modelIds.map((m) => (
              <ModelTag key={m} model={m} />
            ))}
            <span className="flex items-center gap-1.5 text-small text-faint">
              <span className="size-[7px] shrink-0 rounded-full bg-running" />
              <TokenCount n={agentOut} total={!!chat.agents[tool.id]?.total} what="by this agent" />
              <LiveClock since={tool.ts} />
            </span>
            <FoldChevron open={open} />
          </div>
        ) : (
          <FinishedAgentHead end={end} title={title} parts={agentResultParts(steps.length, (tool.endTs ?? tool.ts) - tool.ts, agentOut)} reason={end === "done" ? null : reason} open={open} onToggle={toggle} />
        )}
        {running && extra}
        <FoldBody open={open}>
          {!running && (
            <div className="flex items-center gap-2 px-3 pb-1">
              <span className="rounded-[6px] bg-[color-mix(in_oklab,var(--accent-2)_14%,transparent)] px-1.5 text-small font-medium text-dim">{kind}</span>
              <TierTag role={tierWord(tiers, modelIds[0], chat.provider)} />
              {modelIds.map((m) => (
                <ModelTag key={m} model={m} />
              ))}
              {end !== "done" && reason && reason !== "Stopped" && (
                <span className={cx("min-w-0 flex-1 truncate text-small", end === "failed" ? "text-err-text/90" : "text-dim")} title={reason}>
                  {reason}
                </span>
              )}
            </div>
          )}
          {!running && extra}
          {shownSteps.length > 0 && (
            <div className="pb-1.5 pl-[14px] pr-1">
              {hidden > 0 && <div className="pb-0.5 pl-[20px] text-small text-faint">{hidden} earlier</div>}
              <RailList>
                {shownSteps.map((s, i) => {
                  const fresh = !agentSeen.current.has(s.key);
                  return (
                    <RailItem key={s.key} first={i === 0} last={i === shownSteps.length - 1} fresh={fresh} active={s.endTs === null}>
                      <ToolStep t={s} cwd={chat.cwd} dense fresh={fresh} stoppedIn={end === "stopped" && i === shownSteps.length - 1} />
                    </RailItem>
                  );
                })}
              </RailList>
            </div>
          )}
          {note && (
            <div className="border-t border-hairline px-3 py-2">
              <AssistantText text={note.text} streaming={note.streaming} small />
            </div>
          )}
          {running && shownSteps.length === 0 && !note && (
            <div className="px-3 pb-2">
              <ThinkingRow since={tool.ts} label="Starting" mood="start" />
            </div>
          )}
        </FoldBody>
      </div>
    </div>
  );
}

// ---------- approval ----------

/** coool's own request from the device gate (APP_SPEC "Device permissions"): it says what and where itself. */
interface DeviceAsk {
  device: "browser" | "iphone" | "mac";
  kind: string;
  lead: string;
  body: string;
  note?: string | null;
}
export const deviceAsk = (p: Pick<Perm, "input">): DeviceAsk | null => {
  const d = (p.input as { coool_device?: DeviceAsk } | null)?.coool_device;
  return d && typeof d.lead === "string" ? d : null;
};

export function permDetail(p: Perm, cwd: string): { lead: string; body: string; full?: string; note?: string } {
  const dev = deviceAsk(p);
  if (dev) return { lead: dev.lead, body: dev.body, note: dev.note ?? undefined };
  const i = (p.input ?? {}) as Record<string, unknown>;
  if (typeof i.command === "string")
    return {
      lead: typeof i.network_host === "string" ? `reach ${i.network_host}` : "run a command",
      body: i.command,
      note: typeof i.description === "string" ? i.description : undefined,
    };
  if (typeof i.file_path === "string") return { lead: /write/i.test(p.tool) ? "create a file" : "edit a file", body: cwd ? relPath(i.file_path, cwd) : i.file_path, full: i.file_path };
  // Codex's apply_patch: the files it writes (lib/patch.ts).
  const patch = patchFiles(p.input);
  if (patch) {
    const rel = (f: string) => (cwd ? relPath(f, cwd) : f);
    return { lead: patchLead(patch), body: patch.map((f) => (f.movePath ? `${rel(f.path)} → ${rel(f.movePath)}` : rel(f.path))).join("\n"), full: patch.map((f) => f.path).join("\n") };
  }
  if (typeof i.url === "string") return { lead: "fetch a page", body: i.url };
  // Any other tool reads as rows name it ("weather" + "Get forecast Paris"), never as `mcp__weather__get_forecast`.
  const w = permissionWhat(p.tool, p.input, p.summary);
  return { lead: `use ${w.name}`, body: w.detail || w.name };
}

/** "Allow `npm test` commands" -> text with `code` spans. */
export function Ticks({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <code key={i} className="rounded-[4px] bg-[color-mix(in_oklab,var(--dim)_12%,transparent)] px-1 py-px font-mono text-[0.92em]">
            {p}
          </code>
        ) : (
          p
        ),
      )}
    </>
  );
}

const modeName = (provider: string, id: string) => PERMISSION_MODES[provider]?.find((m) => m.id === id)?.label ?? id;

/** The timeline note once a remember option was applied: what changed, and where it is kept. */
export function rememberedNote(r: RememberOption, provider: string): string {
  if (r.mode && r.scope === "chat") return `this chat is now in ${modeName(provider, r.mode)} mode`;
  const what = r.label.replace(/^Always allow /, "always allowing ").replace(/^Allow /, "allowing ").replace(/^Switch /, "switched ");
  return r.file ? `${what}, saved to ${r.file}` : what;
}

export function RememberRow({ option, quick, onPick }: { option: RememberOption; quick: boolean; onPick: () => void }) {
  const saved = option.scope !== "chat";
  return (
    <button
      type="button"
      data-remember={option.id}
      data-remember-scope={option.scope}
      onClick={onPick}
      title={option.rules.length ? option.rules.join("\n") : undefined}
      className={cx(
        "group flex w-full items-start gap-2.5 rounded-[9px] border px-3 py-1.5 text-left transition-[background-color,border-color] duration-150 active:scale-[0.995]",
        "border-line hover:border-[color-mix(in_oklab,var(--dim)_45%,var(--border))] hover:bg-hover",
      )}
    >
      <span className={cx("mt-[3px] flex size-[20px] shrink-0 items-center justify-center rounded-[5px]", "bg-[color-mix(in_oklab,var(--dim)_14%,transparent)] text-dim")}>
        {saved ? <IFile size={13} /> : <ICheck size={13} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 text-base font-medium text-fg">
            <Ticks text={option.label} />
          </span>
          {quick && <Kbd className="ml-auto shrink-0">⇧⌘↵</Kbd>}
          {saved && <span className="ml-auto flex shrink-0 items-center gap-1.5 rounded-[6px] border border-line bg-raised px-1.5 text-small font-medium text-dim"><span className="size-[6px] rounded-full bg-busy" />{option.scope === "user" ? "Saved, all projects" : option.file?.startsWith("coool") ? "Saved in coool" : "Saved to file"}</span>}
        </span>
        <span className="mt-0.5 block text-small text-dim">{option.detail}</span>
      </span>
    </button>
  );
}

function Approval({ item, chat }: { item: Perm; chat: Chat }) {
  if (item.tool === "ExitPlanMode") return <PlanApproval item={item} chat={chat} />;
  const d = permDetail(item, chat.cwd);
  const dev = deviceAsk(item);
  const who = chat.provider === "claude" ? "Claude" : "Codex";
  const quick = item.remember[0]?.scope === "chat" ? item.remember[0] : null;
  return (
    <AnimatePresence mode="wait" initial={false}>
      {item.answer === null && chat.running ? (
        <motion.div
          key="ask"
          initial={{ opacity: 0, y: 8, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, scale: 0.985, transition: { duration: 0.14 } }}
          transition={{ type: "spring", stiffness: 420, damping: 32 }}
          className="attn-card rounded-[14px] border border-[color-mix(in_oklab,var(--status-needs)_30%,var(--border))] bg-raised shadow-card"
          data-approval={item.requestId}
          data-device-approval={dev ? dev.kind : undefined}
        >
          <div className="flex items-center gap-2 px-3.5 pb-1.5 pt-3.5">
            <span className="flex size-[24px] items-center justify-center rounded-[6px] bg-[color-mix(in_oklab,var(--status-needs)_16%,transparent)] text-needs-text">
              {dev?.device === "browser" ? <IGlobe size={15} /> : dev?.device === "iphone" ? <IPhone size={15} /> : dev?.device === "mac" ? <IMac size={15} /> : <ITerminal size={15} />}
            </span>
            <span className="text-title font-semibold tracking-[-0.01em] text-fg">
              {who} wants to {d.lead}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {!dev && <RiskTag tool={item.tool} input={item.input} cwd={chat.cwd} />}
              <span className="rounded-[6px] bg-[color-mix(in_oklab,var(--dim)_11%,transparent)] px-1.5 text-small font-medium text-dim">{item.tool}</span>
            </span>
          </div>
          <div className="px-3.5">
            <RedactedPre className="selectable max-h-[160px] overflow-auto whitespace-pre-wrap break-all rounded-[8px] border border-hairline bg-bg px-3 py-2 font-mono text-mono-small text-fg/90" title={d.full} text={homeShort(d.body)} />
            {/* What it does and why (components/Explain.tsx): its own description, then the AI read when on. */}
            {dev ? d.note && <div className="mt-1.5 text-small text-dim">{d.note}</div> : <PermExplain perm={item} chat={chat} variant="compact" />}
          </div>
          <div className="flex flex-wrap items-center gap-2 px-3.5 pb-3.5 pt-2.5">
            <Button variant="primary" onClick={() => answerPermission(chat.id, item.requestId, "allow")} title="Allow this once (⌘↵)" data-allow-once>
              Allow once
              <Kbd className="ml-0.5 border-transparent bg-[color-mix(in_oklab,var(--bg)_16%,transparent)] text-current">⌘↵</Kbd>
            </Button>
            <Button variant="ghost" onClick={() => answerPermission(chat.id, item.requestId, "deny")} className="hover:text-err-text" title="Deny (⌘⌫)" data-deny>
              Deny
            </Button>
            <span className="ml-auto text-small text-faint">The turn is paused until you answer</span>
          </div>
          {item.remember.length > 0 && (
            <div className="border-t border-hairline px-3.5 pb-3.5 pt-2.5" data-remember-options>
              <div className="mb-1.5 font-mono text-micro font-medium uppercase tracking-[0.06em] text-faint">Allow and don't ask again</div>
              <div className="flex flex-col gap-1.5">
                {item.remember.map((o) => (
                  <RememberRow key={o.id} option={o} quick={o === quick} onPick={() => answerPermission(chat.id, item.requestId, "always", o)} />
                ))}
              </div>
            </div>
          )}
        </motion.div>
      ) : (
        <motion.div key="done" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease }} className="flex min-w-0 items-center gap-2 px-1 text-small" data-approval-done={item.answer ?? ""}>
          {item.answer === "deny" ? <IClose size={14} className="shrink-0 text-err-text" /> : <ICheck size={14} className={cx("shrink-0", item.answer === "answered" || !item.answer ? "text-faint" : "text-accent-text")} />}
          <span className={cx("shrink-0 font-medium", item.answer === "deny" ? "text-err-text/90" : item.answer === "answered" || !item.answer ? "text-dim" : "text-accent-text")}>
            {item.answer === "allow" ? "Allowed once" : item.answer === "always" ? "Allowed" : item.answer === "deny" ? "Denied" : "Permission answered"}
          </span>
          {item.answer === "always" && item.remembered ? (
            <span className="min-w-0 truncate text-dim" data-remembered={item.remembered.scope} title={item.remembered.detail}>
              · <Ticks text={rememberedNote(item.remembered, chat.provider)} />
            </span>
          ) : (
            <span className="min-w-0 truncate font-mono text-mono-small text-faint">{shortDetail(homeShort(d.body.split("\n")[0]))}</span>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------- questions ----------

/** One answer per question: picked labels plus typed text. */
interface Draft {
  picked: string[];
  other: string;
}

function answersOf(item: Ask, drafts: Draft[]): string[][] {
  return item.questions.map((_, i) => {
    const d = drafts[i] ?? { picked: [], other: "" };
    return [...d.picked, ...(d.other.trim() ? [d.other.trim()] : [])];
  });
}

/** `bare`: without its title row (the Needs you page has its own header above it). */
export function QuestionCard({ item, chat, bare }: { item: Ask; chat: Chat; bare?: boolean }) {
  const [drafts, setDrafts] = useState<Draft[]>(() => item.questions.map(() => ({ picked: [], other: "" })));
  const who = chat.provider === "claude" ? "Claude" : "Codex";
  const answers = answersOf(item, drafts);
  const complete = answers.every((a) => a.length > 0);
  const single = item.questions.length === 1 && !item.questions[0].multi_select;
  const edit = (i: number, f: (d: Draft) => Draft) => setDrafts((ds) => ds.map((d, j) => (j === i ? f(d) : d)));
  const submit = (a = answers) => a.every((x) => x.length > 0) && answerQuestion(chat.id, item.requestId, a);
  const open = item.answer === null && chat.running;
  // "Later": the card folds to one line above the composer (QuestionLater.tsx); that line reopens it.
  const folded = useFolded(chat.id, item.requestId);
  const fold = useQuestionLater((s) => s.fold);
  const cardRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  // A new question takes the keyboard only when nothing else has it (never from the composer or a field).
  useEffect(() => {
    if (!open || folded) return;
    const a = document.activeElement;
    if (!a || a === document.body) cardRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  /** What a click on option `oi` of question `i` does (a number key does the same). */
  const pick = (i: number, oi: number) => {
    const q = item.questions[i];
    const o = q?.options[oi];
    if (!o) return;
    const on = drafts[i].picked.includes(o.label);
    if (q.multi_select) edit(i, (x) => ({ ...x, picked: on ? x.picked.filter((p) => p !== o.label) : [...x.picked, o.label] }));
    else if (single) submit([[o.label]]);
    else edit(i, (x) => ({ ...x, picked: on ? [] : [o.label], other: "" }));
  };
  // 1–9 answer while the card has focus, never while typing (the "Or type another answer" field included).
  const onKey = (e: React.KeyboardEvent) => {
    if (isTyping(e.target as HTMLElement)) return;
    const qEl = (e.target as HTMLElement).closest<HTMLElement>("[data-q]");
    const i = keyQuestion(
      drafts.map((d) => d.picked),
      qEl ? Number(qEl.dataset.q) : -1,
    );
    const oi = digitPick(e.nativeEvent, item.questions[i]?.options.length ?? 0);
    if (oi === null) return;
    e.preventDefault();
    e.stopPropagation();
    pick(i, oi);
  };
  // Set aside: the line above the composer stands for it until it is reopened.
  if (open && folded) return <div hidden data-question-folded={item.requestId} />;

  return (
    <AnimatePresence mode="wait" initial={false}>
      {open ? (
        <motion.div
          key="ask"
          ref={cardRef}
          tabIndex={-1}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocused(false)}
          initial={{ opacity: 0, y: 8, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, scale: 0.985, transition: { duration: 0.14 } }}
          transition={{ type: "spring", stiffness: 420, damping: 32 }}
          className={cx("attn-card rounded-[14px] border bg-raised shadow-card outline-none", focused ? "border-[color-mix(in_oklab,var(--status-needs)_55%,var(--border))]" : "border-[color-mix(in_oklab,var(--status-needs)_30%,var(--border))]")}
          data-question={item.requestId}
          data-question-focused={focused || undefined}
        >
          {!bare && (
          <div className="flex items-center gap-2 px-3.5 pb-1 pt-3.5">
            <span className="flex size-[24px] items-center justify-center rounded-[6px] bg-[color-mix(in_oklab,var(--status-needs)_16%,transparent)] text-base font-bold text-needs-text">?</span>
            <span className="text-title font-semibold tracking-[-0.01em] text-fg">
              {who} has {item.questions.length === 1 ? "a question" : `${item.questions.length} questions`}
            </span>
          </div>
          )}
          <div className={cx("flex flex-col gap-3.5 px-3.5 pb-1", bare ? "pt-3.5" : "pt-1.5")}>
            {item.questions.map((q, i) => {
              const d = drafts[i];
              return (
                <div key={q.id || i} data-q={i}>
                  <div className="flex items-baseline gap-2">
                    {q.header && <span className="shrink-0 rounded-[6px] bg-[color-mix(in_oklab,var(--dim)_11%,transparent)] px-1.5 text-small font-medium text-dim">{q.header}</span>}
                    <span className="selectable text-base text-fg">{q.question}</span>
                    {q.multi_select && <span className="shrink-0 text-small text-faint">pick any</span>}
                  </div>
                  {q.options.length > 0 && (
                    <div className="mt-2 flex flex-col gap-1">
                      {q.options.map((o, oi) => {
                        const on = d.picked.includes(o.label);
                        return (
                          <button
                            key={o.label}
                            type="button"
                            data-option={o.label}
                            onClick={() => pick(i, oi)}
                            className={cx(
                              "group flex w-full items-start gap-2.5 rounded-[9px] border px-2.5 py-[7px] text-left transition-[border-color,background-color] duration-150",
                              on ? "border-[color-mix(in_oklab,var(--accent)_55%,var(--border))] bg-accent-soft" : "border-line hover:border-[color-mix(in_oklab,var(--accent)_40%,var(--border))] hover:bg-hover",
                            )}
                          >
                            <span
                              className={cx(
                                "mt-[3px] flex size-[14px] shrink-0 items-center justify-center border transition-colors duration-150",
                                q.multi_select ? "rounded-[4px]" : "rounded-full",
                                on ? "border-accent bg-accent text-accent-ink" : "border-line group-hover:border-dim",
                              )}
                            >
                              {on && (q.multi_select ? <ICheck size={12} /> : <span className="size-[6px] rounded-full bg-current" />)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-base font-medium text-fg">{o.label}</span>
                              {o.description && o.description !== o.label && <span className="block text-small leading-[16px] text-dim">{o.description}</span>}
                            </span>
                            {oi < 9 && <Kbd className={cx("mt-[1px] transition-opacity duration-150 group-hover:opacity-100", focused ? "opacity-100" : "opacity-50")}>{oi + 1}</Kbd>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {q.allow_other && (
                    <input
                      ref={q.secret ? undefined : voiceRef(`q-${item.requestId}-${i}`)}
                      value={d.other}
                      type={q.secret ? "password" : "text"}
                      data-other={i}
                      placeholder={q.options.length ? "Or type another answer…" : "Type your answer…"}
                      spellCheck={false}
                      onChange={(e) => {
                        const v = e.target.value;
                        edit(i, (x) => ({ ...x, other: v, picked: q.multi_select || !v ? x.picked : [] }));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          submit();
                        }
                      }}
                      className="mt-1.5 h-[38px] w-full rounded-[10px] border border-line bg-bg px-2.5 text-base outline-none placeholder:text-faint focus:border-[color-mix(in_oklab,var(--fg)_30%,var(--border))]"
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2 px-3.5 pb-3.5 pt-2.5">
            {!(single && !drafts[0].other.trim()) && (
              <Button variant="primary" onClick={() => submit()} disabled={!complete} data-submit-question title="Send the answer">
                Answer
              </Button>
            )}
            <Button variant="ghost" onClick={() => answerQuestion(chat.id, item.requestId, null)} className="hover:text-err-text" data-decline-question>
              Decline
            </Button>
            <Button variant="ghost" onClick={() => fold(chat.id, item.requestId)} title="Fold this to one line above the composer and keep reading" data-question-later-button>
              Later
            </Button>
            <span className="ml-auto text-small text-faint">{focused && item.questions.some((q) => q.options.length) ? `Press 1–${Math.min(9, Math.max(...item.questions.map((q) => q.options.length)))} to ${single ? "answer" : "pick"}` : single ? "Pick one to answer" : "The turn is paused until you answer"}</span>
          </div>
        </motion.div>
      ) : (
        <motion.div key="done" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease }} className="flex flex-col gap-1 px-1 text-small" data-question-done={item.requestId}>
          {Array.isArray(item.answer) ? (
            item.questions.map((q, i) => (
              <div key={q.id || i} className="flex min-w-0 items-center gap-2">
                <ICheck size={14} className="shrink-0 text-accent-text" />
                <span className="min-w-0 truncate text-dim">{q.header || q.question}</span>
                <span className="min-w-0 truncate font-medium text-accent-text">{(item.answer as string[][])[i]?.join(", ") || "no answer"}</span>
              </div>
            ))
          ) : (
            <div className="flex items-center gap-2">
              {item.answer === "declined" ? <IClose size={14} className="text-err-text" /> : <ICheck size={14} className="text-faint" />}
              <span className={cx("font-medium", item.answer === "declined" ? "text-err-text/90" : "text-dim")}>{item.answer === "declined" ? "Declined to answer" : "Question answered"}</span>
              <span className="min-w-0 truncate text-faint">{item.questions[0]?.question}</span>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------- notices, turn ends, exit ----------

function Notice({ item, onOpenTerminal }: { item: Extract<ChatItem, { kind: "notice" }>; onOpenTerminal: () => void }) {
  if (item.needsTerminal)
    return (
      <div className="flex items-center gap-3 rounded-[10px] border border-dashed border-line px-3.5 py-2.5">
        <ITerminal size={17} className="shrink-0 text-dim" />
        <span className="min-w-0 flex-1 text-base text-dim">{item.text}</span>
        <Button variant="outline" onClick={onOpenTerminal}>
          Open in terminal
        </Button>
      </div>
    );
  if (item.level === "error")
    return (
      <div className="flex items-start gap-2 rounded-[8px] bg-[color-mix(in_oklab,var(--error)_7%,transparent)] px-2.5 py-1.5 text-base text-err-text">
        <IAlert size={16} className="mt-[2px] shrink-0" />
        <span className="selectable min-w-0 break-words">{item.text}</span>
      </div>
    );
  // Multi-line output (the CLI's own command output arrives as an info notice): a quiet, collapsible block.
  const lines = item.text.split("\n");
  if (lines.length > 2) return <NoticeBlock item={item} lines={lines} />;
  return (
    <div className={cx("flex items-start gap-2 px-1 text-small", item.level === "warn" ? "text-busy-text" : "text-dim")}>
      <span className={cx("mt-[6px] size-[5px] shrink-0 rounded-full", item.level === "warn" ? "bg-busy" : "bg-faint")} />
      <span className="selectable min-w-0 whitespace-pre-wrap break-words">{item.text}</span>
    </div>
  );
}

function NoticeBlock({ item, lines }: { item: Extract<ChatItem, { kind: "notice" }>; lines: string[] }) {
  const [open, setOpen] = useKept(`notice:${item.key}`, lines.length <= 14);
  return (
    <div className="rounded-[10px] border border-hairline">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-small text-dim hover:text-fg">
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.18, ease }} className="flex text-faint">
          <IChevron size={13} />
        </motion.span>
        <span className="min-w-0 flex-1 truncate">{lines[0] || "Output"}</span>
        <span className="shrink-0 text-small text-faint tnum">{lines.length} lines</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease }} className="overflow-hidden">
            <div className={cx("max-h-[320px] overflow-auto border-t border-hairline px-3 py-2 text-small", item.level === "warn" ? "text-busy-text" : "text-dim")}>
              <Markdown text={lines.slice(1).join("\n")} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TurnEnd({ item, chat }: { item: Extract<ChatItem, { kind: "turn" }>; chat: Chat }) {
  // The model that actually answered in this turn, not whatever is selected now.
  let model: string | null = null;
  const at = chat.items.indexOf(item);
  for (let i = at - 1; i >= 0; i--) {
    const it = chat.items[i];
    if (it.kind === "turn") break;
    if (it.kind === "text" && !it.parent && it.model) {
      model = it.model;
      break;
    }
  }
  const verb = item.failed ? "Failed after" : item.ok ? "Worked for" : "Stopped after";
  const parts = [item.tools > 0 && `${item.tools} tool ${item.tools === 1 ? "use" : "uses"}`, model && modelLabel(model)].filter(Boolean) as string[];
  const b = useTurnBreakdown(chat, item);
  const [open, setOpen] = useKept(`turn:${item.key}`, false);
  const row = (
    <>
      {item.failed ? <IAlert size={13} className="text-err-text" /> : item.ok ? <ICheck size={13} className="text-faint" /> : <IReturn size={13} />}
      <span className={cx("font-medium", item.failed ? "text-err-text" : "text-dim")}>
        {verb} <span className="tnum">{fmtElapsed(item.durationMs)}</span>
      </span>
      {parts.length > 0 && <span className="min-w-0 truncate">· {parts.join(" · ")}</span>}
    </>
  );
  if (!b)
    return (
      <div className="-mt-1 px-1" data-turn-end={item.failed ? "failed" : item.ok ? "done" : "stopped"}>
        <div className="flex items-center gap-1.5 text-small text-faint">{row}</div>
        <LadderTally chat={chat} item={item} />
      </div>
    );
  return (
    <div className="-mt-1 px-1" data-turn-end={item.failed ? "failed" : item.ok ? "done" : "stopped"}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={open ? "Hide where the time went" : "Where the time went"}
        className="group -mx-1 flex max-w-full items-center gap-1.5 rounded-[6px] px-1 text-left text-small text-faint transition-colors duration-150 hover:bg-hover"
        data-turn-toggle
      >
        {row}
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.16, ease }} className="flex size-[14px] shrink-0 items-center justify-center text-faint opacity-60 group-hover:opacity-100">
          <IChevron size={11} />
        </motion.span>
      </button>
      <LadderTally chat={chat} item={item} />
      <TurnBar b={b} className="mt-1.5" />
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: reducedMotion() ? 0 : 0.24, ease }} className="overflow-hidden">
            <Waterfall b={b} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Exited({ item, onResume }: { item: Extract<ChatItem, { kind: "exited" }>; onResume?: () => void }) {
  const bad = item.code !== null && item.code !== 0;
  return (
    <div className={cx("flex items-center gap-2 rounded-[10px] border border-dashed px-3.5 py-2 text-base", bad ? "border-[color-mix(in_oklab,var(--error)_35%,var(--border))] text-err-text/90" : "border-line text-dim")}>
      <StatusDot status="ended" size={8} />
      {bad ? `The CLI exited with code ${item.code}.` : "This chat's process has ended."}
      <span className="ml-auto font-mono text-mono-small text-faint tnum">{clockTime(item.ts)}</span>
      {onResume && (
        <Button variant="outline" onClick={onResume} className="-my-1 h-[30px]">
          Resume
        </Button>
      )}
    </div>
  );
}

/** What we know about why, in plain words (never more than the CLI's error says). */
function openFailedWhy(f: Extract<ChatItem, { kind: "open_failed" }>, cli: string): string {
  switch (f.reason) {
    case "newer_cli":
      return `It was saved by a newer version of ${cli} than the one installed here${f.cliVersion ? ` (${f.cliVersion})` : ""}, which can't read part of it. Updating ${cli} should let it open.`;
    case "not_found":
      return `${cli} couldn't find this conversation among its saved ones.`;
    case "exited":
      return `${cli} stopped before the conversation opened.`;
    default:
      return `${cli} reported an error while ${f.resumed ? "opening" : "starting"} it.`;
  }
}

function OpenFailedCard({ item, chat }: { item: Extract<ChatItem, { kind: "open_failed" }>; chat: Chat }) {
  const cli = chat.provider === "claude" ? "Claude Code" : "Codex";
  // The raw error is secondary when we could say it plainly; the only thing to read when we couldn't.
  const [raw, setRaw] = useKept(`open-failed:${item.key}`, item.reason === "other");
  const [copied, setCopied] = useState<number | null>(null);
  const draft = item.unsent.map((u) => u.text).join("\n\n");
  const copy = (i: number, t: string) =>
    void navigator.clipboard?.writeText(t).then(() => {
      setCopied(i);
      setTimeout(() => setCopied((c) => (c === i ? null : c)), 1400);
    });
  return (
    <div className="flex flex-col gap-2.5 rounded-[12px] border border-[color-mix(in_oklab,var(--error)_30%,var(--border))] bg-[color-mix(in_oklab,var(--error)_5%,transparent)] px-4 py-3" data-open-failed={item.reason}>
      <div className="flex items-start gap-2.5">
        <IAlert size={17} className="mt-[2px] shrink-0 text-err-text" />
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold text-fg">This chat couldn’t {item.resumed ? "be opened" : "start"}</div>
          <p className="mt-0.5 text-base leading-[21px] text-dim">
            {openFailedWhy(item, cli)} It can’t take messages; nothing you send here reaches an agent.
          </p>
        </div>
      </div>
      {item.unsent.length > 0 && (
        <div className="flex flex-col gap-1.5 pl-[27px]" data-open-failed-unsent={item.unsent.length}>
          <div className="text-small font-medium text-dim">{item.unsent.length === 1 ? "Not sent" : `Not sent (${item.unsent.length})`}</div>
          {item.unsent.map((u, i) => (
            <div key={u.id} className="flex items-start gap-2 rounded-[8px] border border-hairline bg-raised px-2.5 py-1.5">
              <span className="selectable min-w-0 flex-1 whitespace-pre-wrap break-words text-base text-fg">{u.text}</span>
              <button type="button" onClick={() => copy(i, u.text)} className="shrink-0 rounded-[6px] px-1.5 text-small text-dim hover:bg-hover hover:text-fg" title="Copy this message">
                {copied === i ? "Copied" : "Copy"}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 pl-[27px]">
        <Button
          variant="outline"
          data-open-failed-new
          onClick={() => void newChat({ provider: chat.provider, cwd: chat.cwd, draft: draft || undefined })}
          title={draft ? `A fresh ${cli} chat in ${folderName(chat.cwd)}, with the message that wasn't sent in its composer (not sent yet). It doesn't have this chat's history.` : `A fresh ${cli} chat in ${folderName(chat.cwd)}. It doesn't have this chat's history.`}
        >
          New chat in this folder
        </Button>
        {item.error && (
          <button type="button" onClick={() => setRaw(!raw)} className="flex items-center gap-1 text-small text-dim hover:text-fg" data-open-failed-raw-toggle>
            <motion.span animate={{ rotate: raw ? 90 : 0 }} transition={{ duration: 0.18, ease }} className="flex text-faint">
              <IChevron size={12} />
            </motion.span>
            {cli}’s message
          </button>
        )}
      </div>
      {raw && item.error && <div className="selectable ml-[27px] whitespace-pre-wrap break-words rounded-[8px] bg-[color-mix(in_oklab,var(--text)_5%,transparent)] px-2.5 py-1.5 font-mono text-mono-small text-dim" data-open-failed-raw>{item.error}</div>}
    </div>
  );
}

// ---------- empty states ----------

const SUGGEST = ["Explain how this codebase is organised", "Find and fix the flakiest test", "Review my uncommitted changes"];

function Welcome({ chat, onSuggest }: { chat: Chat; onSuggest: (t: string) => void }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease }} className="flex min-h-[46vh] flex-col items-center justify-center text-center">
      <div className="welcome-sway">
        <ProviderMark provider={chat.provider} size={26} />
      </div>
      <div className="mt-4 text-display font-semibold tracking-[-0.02em]">
        {chat.provider === "claude" ? "Claude Code" : "Codex"} in {folderName(chat.cwd)}
      </div>
      <p className="mt-1 max-w-[380px] text-base text-dim">
        Ask for anything. Type <Kbd>/</Kbd> for commands; the model and permission mode are in the composer.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {SUGGEST.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSuggest(s)}
            className="h-[36px] rounded-[10px] border border-line bg-raised px-3 text-base text-dim shadow-card transition-[border-color,color] duration-150 hover:border-[color-mix(in_oklab,var(--accent)_45%,var(--border))] hover:text-fg"
          >
            {s}
          </button>
        ))}
      </div>
    </motion.div>
  );
}

/**
 * The session's history from before this chat resumed it, from the transcript:
 * the last two turns rendered like the timeline (quieter), the rest behind a
 * disclosure, then a "Resumed here" rule where the live chat begins.
 */
function Earlier({ rows }: { rows: Activity[] }) {
  const [all, setAll] = useState(false);
  // Turn starts (prompts); show from the second-to-last one unless expanded.
  const starts = rows.map((r, i) => (r.kind === "prompt" ? i : -1)).filter((i) => i >= 0);
  const cut = all || starts.length <= 2 ? 0 : starts[starts.length - 2];
  const shownRows = rows.slice(cut);
  const hiddenTurns = starts.filter((i) => i < cut).length;
  return (
    <div className="flex flex-col gap-4" data-earlier={rows.length}>
      {cut > 0 && (
        <button type="button" onClick={() => setAll(true)} className="flex items-center gap-2 self-center rounded-[8px] px-2.5 py-1 text-small text-dim hover:bg-hover hover:text-fg">
          <IChevron size={13} className="-rotate-90" />
          {hiddenTurns} earlier {hiddenTurns === 1 ? "turn" : "turns"}
        </button>
      )}
      <div className="opacity-[0.82]">
        <HistoryBlocks rows={shownRows} />
      </div>
      <div className="flex items-center gap-3 font-mono text-micro font-medium uppercase tracking-[0.06em] text-faint">
        <span className="h-px flex-1 bg-hairline" />
        Resumed here
        <span className="h-px flex-1 bg-hairline" />
      </div>
    </div>
  );
}
