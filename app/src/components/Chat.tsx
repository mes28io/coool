// The chat timeline: the Activity look, driven live by chat events.
// Streamed text types out with a caret, tool calls form step lists that grow
// one by one, subagent work nests under its launching step, and permission
// requests become an inline approval card.

import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { answerPermission, answerQuestion } from "../lib/actions";
import { type Chat, type ChatItem, useChats } from "../lib/chat";
import { clockTime, fmtElapsed, folderName, homeShort, shortDetail, stripToolName } from "../lib/format";
import { modelLabel } from "../lib/models";
import type { Activity, RememberOption } from "../lib/types";
import { HistoryBlocks, PromptBubble, Prose, StepLine, ThinkingRow } from "./Activity";
import { IAlert, IChevron, ICheck, IClose, IFile, IReturn, ISpark, ITerminal } from "./icons";
import { PERMISSION_MODES } from "./ChatComposer";
import { ModelTag } from "./Models";
import { Button, cx, ease, Kbd, ProviderMark, StatusDot } from "./primitives";

type Tool = Extract<ChatItem, { kind: "tool" }>;
type Perm = Extract<ChatItem, { kind: "permission" }>;
type Ask = Extract<ChatItem, { kind: "question" }>;

/** The tool behind a question card; the card stands for it, so it isn't listed as a step. */
const QUESTION_TOOLS = /^(AskUserQuestion|request_user_input)$/;
type Block =
  | { type: "item"; key: string; item: ChatItem }
  | { type: "steps"; key: string; tools: Tool[] };

const enter = { opacity: 0, y: 10 };
const shown = { opacity: 1, y: 0 };
const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function buildBlocks(items: ChatItem[]): { blocks: Block[]; children: Map<string, ChatItem[]> } {
  const children = new Map<string, ChatItem[]>();
  const blocks: Block[] = [];
  for (const it of items) {
    const parent = "parent" in it ? it.parent : null;
    if (parent) {
      const l = children.get(parent) ?? [];
      l.push(it);
      children.set(parent, l);
      continue;
    }
    if (it.kind === "tool" && QUESTION_TOOLS.test(it.name)) continue;
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
  const stick = useRef(true);
  const working = chat.state !== "idle" && chat.running;

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

  const last = blocks[blocks.length - 1];
  const lastItem = last?.type === "item" ? last.item : null;
  const runningTool = chat.items.some((i) => i.kind === "tool" && !i.parent && i.endTs === null);
  const liveText = lastItem?.kind === "text" && lastItem.streaming;
  const liveThink = lastItem?.kind === "thinking" && lastItem.endTs === null;
  const awaiting = !!chat.pendingPermission || !!chat.pendingQuestion;
  const thinking = working && !runningTool && !liveText && !liveThink && !awaiting;
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
    <div
      ref={scroller}
      className="scroll h-full"
      data-chat-timeline={chat.id}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div ref={content} className={cx("mx-auto flex max-w-[780px] flex-col pb-8 pt-6", compact ? "gap-3 px-4" : "gap-4 px-8")}>
        {earlier && earlier.length > 0 && <Earlier rows={earlier} />}
        {!chat.ready && blocks.length === 0 && (
          <div className="flex min-h-[40vh] items-center justify-center">
            <ThinkingRow since={chat.lastTs} label={`Starting ${chat.provider} in ${folderName(chat.cwd)}`} />
          </div>
        )}
        {chat.ready && blocks.length === 0 && !earlier?.length && <Welcome chat={chat} onSuggest={onSuggest} />}
        {blocks.map((b, i) => {
          const fresh = !initial.current!.has(b.key);
          const isLast = i === blocks.length - 1;
          return (
            <motion.div key={b.key} className={cx(!isLast && i < blocks.length - 8 && "cv-auto")} initial={fresh ? enter : false} animate={shown} transition={{ duration: 0.32, ease }}>
              {b.type === "steps" ? (
                <ChatSteps tools={b.tools} chat={chat} nested={children} latest={isLast || i >= blocks.length - 2} />
              ) : (
                <ItemView item={b.item} chat={chat} onOpenTerminal={onOpenTerminal} onResume={isLast ? onResume : undefined} />
              )}
            </motion.div>
          );
        })}
        <AnimatePresence>
          {thinking && (
            <motion.div key="thinking" initial={enter} animate={shown} exit={{ opacity: 0, transition: { duration: 0.15 } }} transition={{ duration: 0.3, ease }}>
              <ThinkingRow since={idleSince} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
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
  return (
    <div className={cx("selectable", small ? "text-xs leading-[17px] text-dim [&_.caret]:h-[11px] [&_.caret]:w-[5px]" : "text-md leading-[23px] text-fg/90")}>
      <Rich text={text.slice(0, n)} caret={typing} />
    </div>
  );
});

/** Small markdown subset: paragraphs, lists, fenced code, `code`, **bold**. */
function Rich({ text, caret }: { text: string; caret?: boolean }) {
  const parts = text.split(/```/);
  const out: ReactNode[] = [];
  parts.forEach((part, pi) => {
    const isCode = pi % 2 === 1;
    const lastPart = pi === parts.length - 1;
    if (isCode) {
      const body = part.replace(/^[^\n]*\n/, "");
      out.push(
        <pre key={`c${pi}`} className="my-1 overflow-x-auto rounded-[8px] border border-hairline bg-[color-mix(in_oklab,var(--dim)_7%,transparent)] px-3 py-2 font-mono text-xs leading-[18px] text-fg/90">
          {body}
          {caret && lastPart && <span className="caret" />}
        </pre>,
      );
      return;
    }
    const paras = part.split(/\n{2,}/).filter((p, i, a) => p.trim() || (lastPart && i === a.length - 1));
    paras.forEach((p, i) => {
      const end = caret && lastPart && i === paras.length - 1;
      const lines = p.split("\n").filter((l) => l.trim());
      const list = lines.length > 0 && lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l));
      if (list) {
        const ordered = /^\s*\d+\./.test(lines[0]);
        const L = ordered ? "ol" : "ul";
        out.push(
          <L key={`l${pi}-${i}`} className={cx("my-0.5 flex flex-col gap-1 pl-5", ordered ? "list-decimal" : "list-disc", "marker:text-faint")}>
            {lines.map((l, li) => (
              <li key={li}>
                <Inline text={l.replace(/^\s*([-*]|\d+\.)\s/, "")} />
                {end && li === lines.length - 1 && <span className="caret" />}
              </li>
            ))}
          </L>,
        );
      } else
        out.push(
          <p key={`p${pi}-${i}`} className="whitespace-pre-wrap [&:not(:first-child)]:mt-2.5">
            <Inline text={p.replace(/^\n+/, "")} />
            {end && <span className="caret" />}
          </p>,
        );
    });
  });
  if (!out.length && caret) out.push(<span key="c" className="caret" />);
  return <>{out}</>;
}

function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
          <strong key={i} className="font-semibold text-fg">
            {p.slice(2, -2)}
          </strong>
        ) : (
          <Prose key={i} text={p} />
        ),
      )}
    </>
  );
}

// ---------- thinking ----------

function ThinkingBlock({ item }: { item: Extract<ChatItem, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  const live = item.endTs === null;
  const lastLine = item.text.trim().split(/\n/).pop() ?? "";
  if (live)
    return (
      <div className="flex flex-col gap-1">
        <ThinkingRow since={item.ts} />
        {lastLine && (
          <div className="ml-[28px] line-clamp-2 max-w-[640px] text-sm italic leading-[19px] text-faint">
            <span key={item.text.length} className="stream-chunk">
              {lastLine}
            </span>
          </div>
        )}
      </div>
    );
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="group flex items-center gap-2 rounded-[8px] py-1 pl-0.5 pr-2 text-sm hover:bg-hover">
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.18, ease }} className="flex size-[18px] items-center justify-center text-faint">
          <IChevron size={12} />
        </motion.span>
        <ISpark size={12} className="text-accent2/80" />
        <span className="text-dim group-hover:text-fg/85">Thought for {fmtElapsed((item.endTs ?? item.ts) - item.ts)}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease }} className="overflow-hidden">
            <div className="selectable ml-[9px] mt-1 whitespace-pre-wrap border-l border-hairline pl-4 text-sm italic leading-[20px] text-dim">{item.text}</div>
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
  const isOpen = open ?? (latest || active || tools.length <= 2);
  const mountKeys = useRef(new Set(tools.map((t) => t.key)));
  const opened = useRef(isOpen);
  const failed = tools.filter((t) => t.ok === false).length;
  const end = Math.max(...tools.map((t) => t.endTs ?? t.ts));
  const span = end - tools[0].ts;
  const pendingTool = chat.pendingPermission ? (chat.items.find((i) => i.kind === "permission" && i.requestId === chat.pendingPermission) as Perm | undefined)?.tool : undefined;

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          opened.current = false;
          setOpen(!isOpen);
        }}
        className="group flex w-full items-center gap-2 rounded-[8px] py-1 pl-0.5 pr-2 text-left text-sm transition-colors duration-150 hover:bg-hover"
      >
        <motion.span animate={{ rotate: isOpen ? 90 : 0 }} transition={{ duration: 0.18, ease }} className="flex size-[18px] items-center justify-center text-faint group-hover:text-dim">
          <IChevron size={12} />
        </motion.span>
        {active ? (
          <span className="shimmer font-medium">Running {tools.length === 1 ? "a step" : `${tools.length} steps`}</span>
        ) : (
          <span className="font-medium text-dim group-hover:text-fg/85">Ran {tools.length === 1 ? "1 step" : `${tools.length} steps`}</span>
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {chipsFor(tools).map(([name, n]) => (
            <span key={name} className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[5px] bg-[color-mix(in_oklab,var(--dim)_11%,transparent)] px-1.5 text-2xs font-medium text-dim">
              {name}
              {n > 1 && <span className="tnum text-faint">{n}</span>}
            </span>
          ))}
          {failed > 0 && <span className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] bg-[color-mix(in_oklab,var(--error)_10%,transparent)] px-1.5 text-2xs font-medium text-err">{failed} failed</span>}
        </span>
        {!active && span > 0 && <span className="shrink-0 font-mono text-2xs text-faint tnum">{fmtElapsed(span)}</span>}
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div key="list" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.24, ease }} className="overflow-hidden">
            <ol className="relative ml-[9px] mt-1 border-l border-hairline pb-1 pl-3">
              {tools.map((t, i) => {
                const fresh = !mountKeys.current.has(t.key);
                const delay = !fresh && opened.current ? Math.min(i, 14) * 0.035 : 0;
                return (
                  <motion.li key={t.key} initial={fresh || opened.current ? { opacity: 0, y: 6 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.26, ease, delay }}>
                    {t.agent ? (
                      <AgentCard tool={t} chat={chat} kids={nested.get(t.id) ?? []} />
                    ) : (
                      <ToolStep t={t} cwd={chat.cwd} waiting={t.endTs === null && pendingTool === t.name} />
                    )}
                  </motion.li>
                );
              })}
            </ol>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

function ToolStep({ t, cwd, dense, waiting }: { t: Tool; cwd: string; dense?: boolean; waiting?: boolean }) {
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
        dense={dense}
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
                "selectable mb-1.5 ml-[6px] mt-0.5 max-h-[220px] overflow-auto whitespace-pre-wrap rounded-[8px] border border-hairline px-3 py-2 font-mono text-2xs leading-[16px]",
                t.ok === false ? "bg-[color-mix(in_oklab,var(--error)_6%,transparent)] text-err/90" : "bg-[color-mix(in_oklab,var(--dim)_6%,transparent)] text-dim",
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
  return (
    <div className="-ml-[19px] flex gap-2.5 py-1">
      <span className="relative z-[1] mt-[7px] flex size-[15px] shrink-0 items-center justify-center rounded-full bg-bg text-accent2">
        <ISpark size={12} />
      </span>
      <div
        className={cx(
          "min-w-0 flex-1 overflow-hidden rounded-[10px] border bg-raised shadow-card transition-[border-color] duration-300",
          running ? "border-[color-mix(in_oklab,var(--accent-2)_35%,var(--border))]" : "border-hairline",
        )}
      >
        <div className="flex items-center gap-2 px-3 pb-1.5 pt-2">
          <span className="rounded-[5px] bg-[color-mix(in_oklab,var(--accent-2)_14%,transparent)] px-1.5 text-2xs font-semibold uppercase leading-[18px] tracking-[0.04em] text-accent2">{kind}</span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{stripToolName(tool.name, tool.summary)}</span>
          {modelIds.map((m) => (
            <ModelTag key={m} model={m} />
          ))}
          {running ? (
            <StatusDot status="busy" size={6} />
          ) : tool.ok === false ? (
            <span className="flex items-center gap-1 text-2xs text-err">
              <IAlert size={12} /> stopped
            </span>
          ) : (
            <span className="flex items-center gap-1 text-2xs text-dim">
              <ICheck size={12} className="text-accent" /> {fmtElapsed((tool.endTs ?? tool.ts) - tool.ts)}
            </span>
          )}
        </div>
        {shownSteps.length > 0 && (
          <ol className="relative ml-[21px] border-l border-hairline pb-1.5 pl-3">
            {hidden > 0 && <li className="-ml-[3px] pb-0.5 text-2xs text-faint">{hidden} earlier</li>}
            <AnimatePresence initial={false}>
              {shownSteps.map((s) => (
                <motion.li key={s.key} layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease }}>
                  <ToolStep t={s} cwd={chat.cwd} dense />
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
        )}
        {note && (
          <div className="border-t border-hairline px-3 py-2">
            <AssistantText text={note.text} streaming={note.streaming} small />
          </div>
        )}
        {running && shownSteps.length === 0 && !note && (
          <div className="px-3 pb-2">
            <ThinkingRow since={tool.ts} label="Starting" />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- approval ----------

function permDetail(p: Perm): { lead: string; body: string; note?: string } {
  const i = (p.input ?? {}) as Record<string, unknown>;
  if (typeof i.command === "string") return { lead: "run a command", body: i.command, note: typeof i.description === "string" ? i.description : undefined };
  if (typeof i.file_path === "string") return { lead: /write/i.test(p.tool) ? "create a file" : "edit a file", body: i.file_path };
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
        "group flex w-full items-start gap-2.5 rounded-[9px] border px-3 py-2 text-left transition-[background-color,border-color] duration-150 active:scale-[0.995]",
        saved
          ? "border-[color-mix(in_oklab,var(--busy)_28%,var(--border))] hover:bg-[color-mix(in_oklab,var(--busy)_7%,transparent)]"
          : "border-line hover:border-[color-mix(in_oklab,var(--accent)_40%,var(--border))] hover:bg-hover",
      )}
    >
      <span className={cx("mt-[3px] flex size-[16px] shrink-0 items-center justify-center rounded-[5px]", saved ? "bg-[color-mix(in_oklab,var(--busy)_16%,transparent)] text-busy" : "bg-accent-soft text-accent")}>
        {saved ? <IFile size={11} /> : <ICheck size={11} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 text-sm font-medium leading-[20px] text-fg">
            <Ticks text={option.label} />
          </span>
          {quick && <Kbd className="ml-auto shrink-0">⇧⌘↵</Kbd>}
          {saved && <span className="ml-auto shrink-0 rounded-[5px] bg-[color-mix(in_oklab,var(--busy)_14%,transparent)] px-1.5 text-2xs font-medium leading-[18px] text-busy">{option.scope === "user" ? "Saved, all projects" : "Saved to file"}</span>}
        </span>
        <span className="mt-0.5 block text-xs leading-[17px] text-dim">{option.detail}</span>
      </span>
    </button>
  );
}

function Approval({ item, chat }: { item: Perm; chat: Chat }) {
  const d = permDetail(item);
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
          className="attn-card rounded-[12px] border border-[color-mix(in_oklab,var(--accent)_30%,var(--border))] bg-raised shadow-card"
          data-approval={item.requestId}
        >
          <div className="flex items-center gap-2 px-3.5 pb-2 pt-3">
            <span className="flex size-[20px] items-center justify-center rounded-[6px] bg-accent-soft text-accent">
              <ITerminal size={13} />
            </span>
            <span className="text-sm font-semibold text-fg">
              {who} wants to {d.lead}
            </span>
            <span className="ml-auto rounded-[5px] bg-[color-mix(in_oklab,var(--dim)_11%,transparent)] px-1.5 text-2xs font-medium leading-[18px] text-dim">{item.tool}</span>
          </div>
          <div className="px-3.5">
            <pre className="selectable max-h-[160px] overflow-auto whitespace-pre-wrap break-all rounded-[8px] border border-hairline bg-bg px-3 py-2 font-mono text-xs leading-[18px] text-fg/90">{homeShort(d.body)}</pre>
            {d.note && <div className="mt-1.5 text-xs text-dim">{d.note}</div>}
          </div>
          <div className="flex flex-wrap items-center gap-2 px-3.5 pb-3 pt-3">
            <Button variant="primary" onClick={() => answerPermission(chat.id, item.requestId, "allow")} title="Allow this once (⌘↵)" data-allow-once>
              Allow once
              <Kbd className="ml-0.5 border-transparent bg-[color-mix(in_oklab,var(--accent-ink)_16%,transparent)] text-current">⌘↵</Kbd>
            </Button>
            <Button variant="ghost" onClick={() => answerPermission(chat.id, item.requestId, "deny")} className="hover:text-err" title="Deny (⌘⌫)" data-deny>
              Deny
            </Button>
            <span className="ml-auto text-2xs text-faint">The turn is paused until you answer</span>
          </div>
          {item.remember.length > 0 && (
            <div className="border-t border-hairline px-3.5 pb-3 pt-2.5" data-remember-options>
              <div className="mb-1.5 text-2xs font-medium uppercase tracking-[0.06em] text-faint">Allow and don't ask again</div>
              <div className="flex flex-col gap-1.5">
                {item.remember.map((o) => (
                  <RememberRow key={o.id} option={o} quick={o === quick} onPick={() => answerPermission(chat.id, item.requestId, "always", o)} />
                ))}
              </div>
            </div>
          )}
        </motion.div>
      ) : (
        <motion.div key="done" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease }} className="flex min-w-0 items-center gap-2 px-1 text-xs" data-approval-done={item.answer ?? ""}>
          {item.answer === "deny" ? <IClose size={12} className="shrink-0 text-err" /> : <ICheck size={12} className={cx("shrink-0", item.answer === "answered" || !item.answer ? "text-faint" : "text-accent")} />}
          <span className={cx("shrink-0 font-medium", item.answer === "deny" ? "text-err/90" : item.answer === "answered" || !item.answer ? "text-dim" : "text-accent")}>
            {item.answer === "allow" ? "Allowed once" : item.answer === "always" ? "Allowed" : item.answer === "deny" ? "Denied" : "Permission answered"}
          </span>
          {item.answer === "always" && item.remembered ? (
            <span className="min-w-0 truncate text-dim" data-remembered={item.remembered.scope} title={item.remembered.detail}>
              · <Ticks text={rememberedNote(item.remembered, chat.provider)} />
            </span>
          ) : (
            <span className="min-w-0 truncate font-mono text-2xs text-faint">{shortDetail(homeShort(d.body.split("\n")[0]))}</span>
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
          className="attn-card rounded-[12px] border border-[color-mix(in_oklab,var(--accent)_30%,var(--border))] bg-raised shadow-card"
          data-question={item.requestId}
        >
          <div className="flex items-center gap-2 px-3.5 pb-1 pt-3">
            <span className="flex size-[20px] items-center justify-center rounded-[6px] bg-accent-soft text-[12px] font-bold text-accent">?</span>
            <span className="text-sm font-semibold text-fg">
              {who} has {item.questions.length === 1 ? "a question" : `${item.questions.length} questions`}
            </span>
          </div>
          <div className="flex flex-col gap-3.5 px-3.5 pb-1 pt-1.5">
            {item.questions.map((q, i) => {
              const d = drafts[i];
              return (
                <div key={q.id || i} data-q={i}>
                  <div className="flex items-baseline gap-2">
                    {q.header && <span className="shrink-0 rounded-[5px] bg-[color-mix(in_oklab,var(--dim)_11%,transparent)] px-1.5 text-2xs font-medium leading-[18px] text-dim">{q.header}</span>}
                    <span className="selectable text-md leading-[21px] text-fg">{q.question}</span>
                    {q.multi_select && <span className="shrink-0 text-2xs text-faint">pick any</span>}
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
                              {on && (q.multi_select ? <ICheck size={10} /> : <span className="size-[6px] rounded-full bg-current" />)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium text-fg">{o.label}</span>
                              {o.description && o.description !== o.label && <span className="block text-xs leading-[16px] text-dim">{o.description}</span>}
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
                      className="mt-1.5 h-[32px] w-full rounded-[9px] border border-line bg-bg px-2.5 text-sm outline-none placeholder:text-faint focus:border-[color-mix(in_oklab,var(--accent)_50%,var(--border))]"
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2 px-3.5 pb-3 pt-3">
            {!(single && !drafts[0].other.trim()) && (
              <Button variant="primary" onClick={() => submit()} disabled={!complete} data-submit-question title="Send the answer">
                Answer
              </Button>
            )}
            <Button variant="ghost" onClick={() => answerQuestion(chat.id, item.requestId, null)} className="hover:text-err" data-decline-question>
              Decline
            </Button>
            <span className="ml-auto text-2xs text-faint">{single ? "Pick one to answer" : "The turn is paused until you answer"}</span>
          </div>
        </motion.div>
      ) : (
        <motion.div key="done" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease }} className="flex flex-col gap-1 px-1 text-xs" data-question-done={item.requestId}>
          {Array.isArray(item.answer) ? (
            item.questions.map((q, i) => (
              <div key={q.id || i} className="flex min-w-0 items-center gap-2">
                <ICheck size={12} className="shrink-0 text-accent" />
                <span className="min-w-0 truncate text-dim">{q.header || q.question}</span>
                <span className="min-w-0 truncate font-medium text-accent">{(item.answer as string[][])[i]?.join(", ") || "no answer"}</span>
              </div>
            ))
          ) : (
            <div className="flex items-center gap-2">
              {item.answer === "declined" ? <IClose size={12} className="text-err" /> : <ICheck size={12} className="text-faint" />}
              <span className={cx("font-medium", item.answer === "declined" ? "text-err/90" : "text-dim")}>{item.answer === "declined" ? "Declined to answer" : "Question answered"}</span>
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
        <ITerminal size={15} className="shrink-0 text-dim" />
        <span className="min-w-0 flex-1 text-sm text-dim">{item.text}</span>
        <Button variant="outline" onClick={onOpenTerminal}>
          Open in terminal
        </Button>
      </div>
    );
  if (item.level === "error")
    return (
      <div className="flex items-start gap-2 rounded-[8px] bg-[color-mix(in_oklab,var(--error)_7%,transparent)] px-2.5 py-1.5 text-sm text-err">
        <IAlert size={14} className="mt-[2px] shrink-0" />
        <span className="selectable min-w-0 break-words">{item.text}</span>
      </div>
    );
  // Multi-line output (the CLI's own command output arrives as an info notice): a quiet, collapsible block.
  const lines = item.text.split("\n");
  if (lines.length > 2) return <NoticeBlock item={item} lines={lines} />;
  return (
    <div className={cx("flex items-start gap-2 px-1 text-xs", item.level === "warn" ? "text-busy" : "text-dim")}>
      <span className={cx("mt-[6px] size-[5px] shrink-0 rounded-full", item.level === "warn" ? "bg-busy" : "bg-faint")} />
      <span className="selectable min-w-0 whitespace-pre-wrap break-words">{item.text}</span>
    </div>
  );
}

function NoticeBlock({ item, lines }: { item: Extract<ChatItem, { kind: "notice" }>; lines: string[] }) {
  const [open, setOpen] = useState(lines.length <= 14);
  return (
    <div className="rounded-[10px] border border-hairline">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-dim hover:text-fg">
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.18, ease }} className="flex text-faint">
          <IChevron size={11} />
        </motion.span>
        <span className="min-w-0 flex-1 truncate">{lines[0] || "Output"}</span>
        <span className="shrink-0 text-2xs text-faint tnum">{lines.length} lines</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease }} className="overflow-hidden">
            <pre className={cx("selectable max-h-[320px] overflow-auto whitespace-pre-wrap border-t border-hairline px-3 py-2 font-mono text-2xs leading-[16px]", item.level === "warn" ? "text-busy" : "text-dim")}>
              {lines.slice(1).join("\n")}
            </pre>
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
  return (
    <div className="-mt-1 flex items-center gap-1.5 px-1 text-2xs text-faint">
      {item.ok ? <ICheck size={11} className="text-accent/80" /> : <IReturn size={11} />}
      <span>{item.ok ? "Done" : "Stopped"}</span>
      <span className="tnum font-mono">{fmtElapsed(item.durationMs)}</span>
      {model && (
        <>
          <span>·</span>
          <span>{modelLabel(model)}</span>
        </>
      )}
    </div>
  );
}

function Exited({ item, onResume }: { item: Extract<ChatItem, { kind: "exited" }>; onResume?: () => void }) {
  const bad = item.code !== null && item.code !== 0;
  return (
    <div className={cx("flex items-center gap-2 rounded-[10px] border border-dashed px-3.5 py-2 text-sm", bad ? "border-[color-mix(in_oklab,var(--error)_35%,var(--border))] text-err/90" : "border-line text-dim")}>
      <StatusDot status="ended" size={7} />
      {bad ? `The CLI exited with code ${item.code}.` : "This chat's process has ended."}
      <span className="ml-auto font-mono text-2xs text-faint tnum">{clockTime(item.ts)}</span>
      {onResume && (
        <Button variant="outline" onClick={onResume} className="-my-1 h-[26px]">
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
      <div className="mt-4 text-lg font-semibold tracking-[-0.01em]">
        {chat.provider === "claude" ? "Claude Code" : "Codex"} in {folderName(chat.cwd)}
      </div>
      <p className="mt-1 max-w-[380px] text-sm text-dim">
        Ask for anything. Type <Kbd>/</Kbd> for commands; the model and permission mode are in the composer.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {SUGGEST.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSuggest(s)}
            className="h-[30px] rounded-[9px] border border-line bg-raised px-3 text-sm text-dim shadow-card transition-[border-color,color] duration-150 hover:border-[color-mix(in_oklab,var(--accent)_45%,var(--border))] hover:text-fg"
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
        <button type="button" onClick={() => setAll(true)} className="flex items-center gap-2 self-center rounded-[8px] px-2.5 py-1 text-xs text-dim hover:bg-hover hover:text-fg">
          <IChevron size={11} className="-rotate-90" />
          {hiddenTurns} earlier {hiddenTurns === 1 ? "turn" : "turns"}
        </button>
      )}
      <div className="opacity-[0.82]">
        <HistoryBlocks rows={shownRows} />
      </div>
      <div className="flex items-center gap-3 text-2xs font-medium uppercase tracking-[0.08em] text-faint">
        <span className="h-px flex-1 bg-hairline" />
        Resumed here
        <span className="h-px flex-1 bg-hairline" />
      </div>
    </div>
  );
}
