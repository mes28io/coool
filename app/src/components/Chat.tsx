// The chat timeline: the Activity look, driven live by chat events.
// Streamed text types out with a caret, tool calls form step lists that grow
// one by one, subagent work nests under its launching step, and permission
// requests become an inline approval card.

import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { answerPermission, answerQuestion } from "../lib/actions";
import { type Chat, type ChatItem, useChats } from "../lib/chat";
import { clockTime, fmtElapsed, folderName, homeShort, shortDetail, stripToolName } from "../lib/format";
import { modelLabel } from "../lib/models";
import type { Activity, RememberOption } from "../lib/types";
import { agentResultParts, FinishedAgentHead, FoldBody, FoldChevron, HistoryBlocks, PromptBubble, StepLine, ThinkingRow, useFocusLit, type AgentEnd } from "./Activity";
import { useFold } from "../lib/cardFold";
import { isStopReason } from "../lib/stopped";
import { MoodGlyph } from "./MoodGlyph";
import { Markdown } from "./Markdown";
import { CheckpointsCard } from "./Checkpoints";
import { toolMood } from "../lib/activityMood";
import { fmtOut } from "../lib/agentCards";
import { LiveIndicator } from "./Activity";
import { RailItem, RailList, reducedMotion, Reveal } from "./StepRail";
import { deriveCheckpoints } from "../lib/checkpoints";
import { openChanges } from "../lib/infoRequest";
import { isPlanTool, isSyntheticPlan, isTaskNoise, parsePlan, planForTurn } from "../lib/plan";
import { PlanCard } from "./PlanCard";
import { NoteRows } from "./SteerStrip";
import { IAlert, IChevron, ICheck, IClose, IFile, IReturn, ISpark, ITerminal } from "./icons";
import { PERMISSION_MODES } from "./ChatComposer";
import { ModelTag } from "./Models";
import { Button, cx, ease, JumpToBottom, Kbd, LiveClock, ProviderMark, StatusDot } from "./primitives";
import { useStore } from "../store";

type Tool = Extract<ChatItem, { kind: "tool" }>;
type Perm = Extract<ChatItem, { kind: "permission" }>;
type Ask = Extract<ChatItem, { kind: "question" }>;

/** The tool behind a question or plan-approval card; the card stands for it, so it isn't listed as a step. */
const QUESTION_TOOLS = /^(AskUserQuestion|request_user_input|ExitPlanMode)$/;
type Block =
  | { type: "item"; key: string; item: ChatItem }
  | { type: "steps"; key: string; tools: Tool[] }
  /** One task-list card per turn (TodoWrite / update_plan calls), updated in place. */
  | { type: "plan"; key: string; calls: Tool[]; prompt: string; end: { ts: number; ok: boolean } | null };

const enter = { opacity: 0, y: 10 };
const shown = { opacity: 1, y: 0 };
const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function buildBlocks(items: ChatItem[]): { blocks: Block[]; children: Map<string, ChatItem[]> } {
  const children = new Map<string, ChatItem[]>();
  const blocks: Block[] = [];
  let prompt = "";
  let plan: Extract<Block, { type: "plan" }> | null = null;
  // Turns whose task list comes from the driver's synthetic TodoWrite: their raw Task* steps are hidden.
  const synthetic = new Set<number>();
  for (let i = 0, turn = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "prompt") turn++;
    else if (it.kind === "tool" && !it.parent && isSyntheticPlan(it)) synthetic.add(turn);
  }
  let turnNo = 0;
  for (const it of items) {
    const parent = "parent" in it ? it.parent : null;
    if (parent) {
      const l = children.get(parent) ?? [];
      l.push(it);
      children.set(parent, l);
      continue;
    }
    if (it.kind === "tool" && QUESTION_TOOLS.test(it.name)) continue;
    if (it.kind === "tool" && isTaskNoise(it.name) && synthetic.has(turnNo)) continue;
    if (it.kind === "prompt") {
      turnNo++;
      prompt = it.text;
      plan = null;
    }
    if (it.kind === "turn" && plan) plan.end = { ts: it.ts, ok: it.ok };
    if (it.kind === "tool" && isPlanTool(it.name)) {
      // The task list shows as its own card, not as step rows.
      if (!plan) blocks.push((plan = { type: "plan", key: it.key, calls: [], prompt, end: null }));
      plan.calls.push(it);
      continue;
    }
    if (it.kind === "tool") {
      const last = blocks[blocks.length - 1];
      if (last?.type === "steps") last.tools.push(it);
      else blocks.push({ type: "steps", key: it.key, tools: [it] });
    } else if (it.kind === "thinking" && !it.text.trim() && it.endTs !== null) {
      // Empty, finished reasoning (provider hides it): nothing to show.
    } else blocks.push({ type: "item", key: it.key, item: it });
  }
  return { blocks, children };
}

export function ChatTimeline({
  chat,
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
  const { blocks, children } = useMemo(() => buildBlocks(chat.items), [chat.items]);
  const earlier = useChats((s) => s.earlier[chat.id]);
  const initial = useRef<Set<string> | null>(null);
  if (initial.current === null) initial.current = new Set(blocks.map((b) => b.key));
  const scroller = useRef<HTMLDivElement>(null);
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
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
  };
  const working = chat.state !== "idle" && chat.running;
  // Checkpoints card (one per turn), shown from two checkpoints on.
  const cps = useMemo(() => deriveCheckpoints(chat), [chat.items, chat.running, chat.state]);
  const showCps = cps.list.length >= 2;
  // Scroll the timeline to a turn's prompt (below the pinned card) and flash it.
  const jump = (key: string) => {
    const el = scroller.current;
    const block = el?.querySelector<HTMLElement>(`[data-block="${CSS.escape(key)}"]`);
    if (!el || !block) return;
    stick.current = false;
    const delta = block.getBoundingClientRect().top - el.getBoundingClientRect().top - ((bar.current?.offsetHeight ?? 0) + 16);
    el.scrollTo({ top: el.scrollTop + delta, behavior: reducedMotion() ? "auto" : "smooth" });
    const target = (block.firstElementChild as HTMLElement | null) ?? block;
    const ring = "color-mix(in oklab, var(--text) 40%, transparent)";
    if (reducedMotion()) {
      target.style.boxShadow = `0 0 0 2px ${ring}`;
      setTimeout(() => (target.style.boxShadow = ""), 1200);
    } else target.animate([{ boxShadow: `0 0 0 2px ${ring}` }, { boxShadow: "0 0 0 2px transparent" }], { duration: 1400, easing: "ease-out" });
  };

  // Pin to the bottom while the reader is there. A ResizeObserver catches every
  // growth (streamed lines, steps expanding) so the view follows without jumps.
  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    el.scrollTop = el.scrollHeight;
    let last = inner.offsetHeight;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
      else if (inner.offsetHeight > last) setFresh(true);
      last = inner.offsetHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

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
              <CheckpointsCard chat={chat} cps={cps} onJump={jump} onFiles={(k) => openChanges(chat.id, k)} />
            </div>
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-full h-5" style={{ background: "linear-gradient(to bottom, var(--bg), transparent)" }} />
          </div>
        )}
        <div className={cx("mx-auto flex max-w-[700px] flex-col pb-8", showCps ? "pt-3" : "pt-6", compact ? "gap-3 px-4" : "gap-4 px-8")}>
        {earlier && earlier.length > 0 && <Earlier rows={earlier} />}
        {!chat.ready && blocks.length === 0 && (
          <div className="flex min-h-[40vh] items-center justify-center">
            <ThinkingRow since={chat.lastTs} label={`Starting ${chat.provider} in ${folderName(chat.cwd)}`} mood="start" big />
          </div>
        )}
        {chat.ready && blocks.length === 0 && !earlier?.length && <Welcome chat={chat} onSuggest={onSuggest} />}
        {blocks.map((b, i) => {
          const fresh = !initial.current!.has(b.key);
          const isLast = i === blocks.length - 1;
          return (
            <motion.div key={b.key} data-block={b.key} className={cx(!isLast && i < blocks.length - 8 && "cv-auto")} initial={fresh ? enter : false} animate={shown} transition={{ duration: 0.32, ease }}>
              {b.type === "plan" ? (
                <PlanBlock b={b} chat={chat} />
              ) : b.type === "steps" ? (
                <ChatSteps tools={b.tools} chat={chat} nested={children} latest={isLast || i >= blocks.length - 2} />
              ) : (
                <ItemView item={b.item} chat={chat} onOpenTerminal={onOpenTerminal} onResume={isLast ? onResume : undefined} />
              )}
            </motion.div>
          );
        })}
        <AnimatePresence>
          {showRow && (
            <motion.div key="thinking" initial={enter} animate={shown} exit={{ opacity: 0, transition: { duration: 0.15 } }} transition={{ duration: 0.3, ease }}>
              <LiveIndicator since={now.at ?? idleSince} mood={now.mood} detail={now.detail} agents={now.agents} mainActive={now.mainActive} timerSince={chat.turnStart ?? idleSince} />
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
    </div>
  );
}

function PlanBlock({ b, chat }: { b: Extract<Block, { type: "plan" }>; chat: Chat }) {
  const live = chat.running && chat.state !== "idle" && !b.end;
  const p = planForTurn(b.calls, b.prompt, b.end, live);
  if (!p) return null;
  return <PlanCard title={p.title} subtitle={p.subtitle} steps={p.steps} phase={p.phase} startedAt={p.startedAt} endedAt={p.endedAt} data-turn-plan={p.phase} />;
}

/** Claude's plan-mode proposal (the ExitPlanMode permission request) as a plan card. */
function PlanApproval({ item, chat }: { item: Perm; chat: Chat }) {
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
  switch (item.kind) {
    case "prompt":
      return <PromptBubble text={item.text} stamp={clockTime(item.ts)} />;
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
    let raf = 0;
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
      if (cur.current < target.current) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, streaming]);
  return Math.min(n, text.length);
}

const AssistantText = memo(function AssistantText({ text, streaming, small }: { text: string; streaming: boolean; small?: boolean }) {
  const n = useReveal(text, streaming);
  const typing = streaming || n < text.length;
  return <Markdown text={text.slice(0, n)} streaming={typing} className={small ? "text-small text-dim" : "text-prose text-fg/90"} />;
});

// ---------- thinking ----------

export function ThinkingBlock({ item }: { item: Extract<ChatItem, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false);
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
          <ISpark size={14} className="text-dim/80" />
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

function toolSummary(t: Tool, cwd: string): string {
  // From the input when it names a file: the core's one-line summary may have clipped a long path.
  const i = (t.input ?? {}) as Record<string, unknown>;
  const file = typeof i.file_path === "string" ? i.file_path : typeof i.notebook_path === "string" ? i.notebook_path : null;
  if (file && cwd) return relPath(file, cwd);
  return stripToolName(t.name, t.summary || "");
}

function chipsFor(tools: Tool[]) {
  const m = new Map<string, number>();
  for (const t of tools) {
    const n = t.agent ? "Agent" : t.name;
    m.set(n, (m.get(n) ?? 0) + 1);
  }
  return [...m.entries()].slice(0, 4);
}

const ChatSteps = memo(function ChatSteps({ tools, chat, nested, latest }: { tools: Tool[]; chat: Chat; nested: Map<string, ChatItem[]>; latest: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const active = tools.some((t) => t.endTs === null);
  const focus = useStore((st) => st.agentFocus);
  const holdsFocus = !!focus && Date.now() - focus.at < 6000 && tools.some((t) => t.agent && t.id === focus.id);
  useEffect(() => {
    if (holdsFocus) setOpen(true);
  }, [holdsFocus]);
  const isOpen = open ?? (latest || active || tools.length <= 2);
  const mountKeys = useRef(new Set(tools.map((t) => t.key)));
  const failed = tools.filter((t) => t.ok === false && !t.stopped).length;
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
          <span className="shimmer font-medium">Running {tools.length === 1 ? "a step" : `${tools.length} steps`}</span>
        ) : (
          <span className="font-medium text-dim group-hover:text-fg/85">Ran {tools.length === 1 ? "1 step" : `${tools.length} steps`}</span>
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {chipsFor(tools).map(([name, n]) => (
            <span key={name} className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[6px] bg-[color-mix(in_oklab,var(--dim)_11%,transparent)] px-1.5 text-small font-medium text-dim">
              {name}
              {n > 1 && <span className="tnum text-faint">{n}</span>}
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
            <AgentsSummary tools={tools} chat={chat} nested={nested} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

/** After several subagents of one turn have all finished: one dim line with the wall-clock span (not the sum). */
function AgentsSummary({ tools, chat, nested }: { tools: Tool[]; chat: Chat; nested: Map<string, ChatItem[]> }) {
  const agents = tools.filter((t) => t.agent);
  if (agents.length < 2 || agents.some((a) => a.endTs === null)) return null;
  const uses = agents.reduce((n, a) => n + (nested.get(a.id) ?? []).filter((k) => k.kind === "tool").length, 0);
  const tokens = agents.reduce((n, a) => n + Object.values(chat.agents[a.id]?.models ?? {}).reduce((m, u) => m + u.output, 0), 0);
  const span = Math.max(...agents.map((a) => a.endTs ?? a.ts)) - Math.min(...agents.map((a) => a.ts));
  const parts = [`${agents.length} agents finished`, uses > 0 && `${uses} tool ${uses === 1 ? "use" : "uses"}`, tokens > 0 && `${fmtOut(tokens)} tokens`, span > 0 && fmtElapsed(span)].filter(Boolean);
  return (
    <div className="ml-[34px] pb-1 pt-0.5 text-small text-faint tnum" data-agents-summary>
      {parts.join(" · ")}
    </div>
  );
}

function ToolStep({ t, cwd, dense, waiting, fresh, stoppedIn = false }: { t: Tool; cwd: string; dense?: boolean; waiting?: boolean; fresh?: boolean; stoppedIn?: boolean }) {
  const [open, setOpen] = useState(false);
  const hasOut = !!t.output && t.endTs !== null;
  return (
    <div>
      <StepLine
        name={t.name}
        detail={dense ? shortDetail(toolSummary(t, cwd)) : toolSummary(t, cwd)}
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
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease }} className="overflow-hidden">
            <pre
              className={cx(
                "selectable mb-1.5 ml-[6px] mt-0.5 max-h-[220px] overflow-auto whitespace-pre-wrap rounded-[8px] border border-hairline px-3 py-2 font-mono text-mono-small leading-[16px]",
                t.ok === false && !t.stopped && !stoppedIn ? "bg-[color-mix(in_oklab,var(--error)_6%,transparent)] text-err-text/90" : "bg-[color-mix(in_oklab,var(--dim)_6%,transparent)] text-dim",
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
  const outTokens = Object.values(chat.agents[tool.id]?.models ?? {}).reduce((n, u) => n + u.output, 0);
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
  return (
    <div className="flex gap-2.5 py-1">
      <span className="relative z-[1] mt-[7px] flex size-[18px] shrink-0 items-center justify-center rounded-full bg-bg text-dim">
        <MoodGlyph mood="delegate" size={14} live={running} />
      </span>
      <div
        ref={card}
        data-agent-card={tool.id}
        data-open={open}
        className={cx(
          "min-w-0 flex-1 overflow-hidden rounded-[10px] border bg-raised shadow-card transition-[border-color] duration-500",
          lit ? "border-[color-mix(in_oklab,var(--status-working)_45%,var(--border))]" : "border-hairline",
        )}
      >
        {running ? (
          <div role="button" tabIndex={0} onClick={toggle} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())} className="flex cursor-default items-center gap-2 px-3 pb-1.5 pt-2">
            <span className="rounded-[6px] bg-[color-mix(in_oklab,var(--accent-2)_14%,transparent)] px-1.5 text-small font-medium text-dim">{kind}</span>
            <span className="min-w-0 flex-1 truncate text-base font-medium text-fg">{title}</span>
            {modelIds.map((m) => (
              <ModelTag key={m} model={m} />
            ))}
            <span className="flex items-center gap-1.5 text-small text-faint">
              <StatusDot status="busy" size={7} />
              <LiveClock since={tool.ts} />
            </span>
            <FoldChevron open={open} />
          </div>
        ) : (
          <FinishedAgentHead end={end} title={title} parts={agentResultParts(steps.length, outTokens, (tool.endTs ?? tool.ts) - tool.ts)} reason={end === "done" ? null : reason} open={open} onToggle={toggle} />
        )}
        <FoldBody open={open}>
          {!running && (
            <div className="flex items-center gap-2 px-3 pb-1">
              <span className="rounded-[6px] bg-[color-mix(in_oklab,var(--accent-2)_14%,transparent)] px-1.5 text-small font-medium text-dim">{kind}</span>
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
              <ThinkingRow since={tool.ts} label="Starting" mood="start" noOrb />
            </div>
          )}
        </FoldBody>
      </div>
    </div>
  );
}

// ---------- approval ----------

function permDetail(p: Perm, cwd: string): { lead: string; body: string; full?: string; note?: string } {
  const i = (p.input ?? {}) as Record<string, unknown>;
  if (typeof i.command === "string") return { lead: "run a command", body: i.command, note: typeof i.description === "string" ? i.description : undefined };
  if (typeof i.file_path === "string") return { lead: /write/i.test(p.tool) ? "create a file" : "edit a file", body: cwd ? relPath(i.file_path, cwd) : i.file_path, full: i.file_path };
  if (typeof i.url === "string") return { lead: "fetch a page", body: i.url };
  return { lead: `use ${p.tool}`, body: p.summary };
}

/** "Allow `npm test` commands" -> text with `code` spans. */
function Ticks({ text }: { text: string }) {
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

function RememberRow({ option, quick, onPick }: { option: RememberOption; quick: boolean; onPick: () => void }) {
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
          {saved && <span className="ml-auto flex shrink-0 items-center gap-1.5 rounded-[6px] border border-line bg-raised px-1.5 text-small font-medium text-dim"><span className="size-[6px] rounded-full bg-busy" />{option.scope === "user" ? "Saved, all projects" : "Saved to file"}</span>}
        </span>
        <span className="mt-0.5 block text-small text-dim">{option.detail}</span>
      </span>
    </button>
  );
}

function Approval({ item, chat }: { item: Perm; chat: Chat }) {
  if (item.tool === "ExitPlanMode") return <PlanApproval item={item} chat={chat} />;
  const d = permDetail(item, chat.cwd);
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
        >
          <div className="flex items-center gap-2 px-3.5 pb-1.5 pt-3.5">
            <span className="flex size-[24px] items-center justify-center rounded-[6px] bg-[color-mix(in_oklab,var(--status-needs)_16%,transparent)] text-needs-text">
              <ITerminal size={15} />
            </span>
            <span className="text-title font-semibold tracking-[-0.01em] text-fg">
              {who} wants to {d.lead}
            </span>
            <span className="ml-auto rounded-[6px] bg-[color-mix(in_oklab,var(--dim)_11%,transparent)] px-1.5 text-small font-medium text-dim">{item.tool}</span>
          </div>
          <div className="px-3.5">
            <pre className="selectable max-h-[160px] overflow-auto whitespace-pre-wrap break-all rounded-[8px] border border-hairline bg-bg px-3 py-2 font-mono text-mono-small text-fg/90" title={d.full}>{homeShort(d.body)}</pre>
            {d.note && <div className="mt-1.5 text-small text-dim">{d.note}</div>}
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

function QuestionCard({ item, chat }: { item: Ask; chat: Chat }) {
  const [drafts, setDrafts] = useState<Draft[]>(() => item.questions.map(() => ({ picked: [], other: "" })));
  const who = chat.provider === "claude" ? "Claude" : "Codex";
  const answers = answersOf(item, drafts);
  const complete = answers.every((a) => a.length > 0);
  const single = item.questions.length === 1 && !item.questions[0].multi_select;
  const edit = (i: number, f: (d: Draft) => Draft) => setDrafts((ds) => ds.map((d, j) => (j === i ? f(d) : d)));
  const submit = (a = answers) => a.every((x) => x.length > 0) && answerQuestion(chat.id, item.requestId, a);
  const open = item.answer === null && chat.running;

  return (
    <AnimatePresence mode="wait" initial={false}>
      {open ? (
        <motion.div
          key="ask"
          initial={{ opacity: 0, y: 8, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, scale: 0.985, transition: { duration: 0.14 } }}
          transition={{ type: "spring", stiffness: 420, damping: 32 }}
          className="attn-card rounded-[14px] border border-[color-mix(in_oklab,var(--status-needs)_30%,var(--border))] bg-raised shadow-card"
          data-question={item.requestId}
        >
          <div className="flex items-center gap-2 px-3.5 pb-1 pt-3.5">
            <span className="flex size-[24px] items-center justify-center rounded-[6px] bg-[color-mix(in_oklab,var(--status-needs)_16%,transparent)] text-base font-bold text-needs-text">?</span>
            <span className="text-title font-semibold tracking-[-0.01em] text-fg">
              {who} has {item.questions.length === 1 ? "a question" : `${item.questions.length} questions`}
            </span>
          </div>
          <div className="flex flex-col gap-3.5 px-3.5 pb-1 pt-1.5">
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
                            onClick={() => {
                              if (q.multi_select) edit(i, (x) => ({ ...x, picked: on ? x.picked.filter((p) => p !== o.label) : [...x.picked, o.label] }));
                              else if (single) submit([[o.label]]);
                              else edit(i, (x) => ({ ...x, picked: on ? [] : [o.label], other: "" }));
                            }}
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
                            {single && oi < 9 && <Kbd className="mt-[1px] opacity-0 transition-opacity duration-150 group-hover:opacity-100">{oi + 1}</Kbd>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {q.allow_other && (
                    <input
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
                      className="mt-1.5 h-[38px] w-full rounded-[10px] border border-line bg-bg px-2.5 text-base outline-none placeholder:text-faint focus:border-[color-mix(in_oklab,var(--accent)_50%,var(--border))]"
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
            <span className="ml-auto text-small text-faint">{single ? "Pick one to answer" : "The turn is paused until you answer"}</span>
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
  const [open, setOpen] = useState(lines.length <= 14);
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
  const parts = [item.tools > 0 && `${item.tools} tool ${item.tools === 1 ? "use" : "uses"}`, item.tokens !== null && `${fmtOut(item.tokens)} tokens`, model && modelLabel(model)].filter(Boolean) as string[];
  return (
    <div className="-mt-1 flex items-center gap-1.5 px-1 text-small text-faint" data-turn-end={item.failed ? "failed" : item.ok ? "done" : "stopped"}>
      {item.failed ? <IAlert size={13} className="text-err-text" /> : item.ok ? <ICheck size={13} className="text-faint" /> : <IReturn size={13} />}
      <span className={cx("font-medium", item.failed ? "text-err-text" : "text-dim")}>
        {verb} <span className="tnum">{fmtElapsed(item.durationMs)}</span>
      </span>
      {parts.length > 0 && <span>· {parts.join(" · ")}</span>}
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

// ---------- empty states ----------

const SUGGEST = ["Explain how this codebase is organised", "Find and fix the flakiest test", "Review my uncommitted changes"];

function Welcome({ chat, onSuggest }: { chat: Chat; onSuggest: (t: string) => void }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease }} className="flex min-h-[46vh] flex-col items-center justify-center text-center">
      <motion.div animate={{ rotate: [0, 8, 0] }} transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}>
        <ProviderMark provider={chat.provider} size={26} />
      </motion.div>
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
