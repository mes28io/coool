// The context map in the Models panel (CHAT_SPEC "Models used"): what fills the
// model's context window, as a squarified treemap sized by tokens and tinted by
// kind, with the free room hatched. Numbers: crates/core/src/context.rs, asked
// for only while this panel is open.

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, isNotAvailable } from "../lib/backend";
import { clockTime, fmtTokens, homeShort } from "../lib/format";
import { contextWindow, modelLabel } from "../lib/models";
import { useMotion } from "../lib/motion";
import { squarify, type Rect } from "../lib/treemap";
import type { ContextKind, ContextMap, ContextPart, Provider } from "../lib/types";
import { MoodGlyph } from "./MoodGlyph";
import { ICaret, ICheck } from "./icons";
import { cx, ease, Popover } from "./primitives";

/** Five hue families plus neutral (styles.css `--ctx-*`): setup is neutral, memory and skills violet, files and images blue, the conversation rose, tool output orange, a summary green. */
const KIND: Record<ContextKind, { tint: string; what: string }> = {
  system: { tint: "var(--ctx-base)", what: "System prompt and instructions" },
  tools: { tint: "var(--ctx-base)", what: "Tool definitions the model is given" },
  other: { tint: "var(--ctx-base)", what: "Reminders the CLI adds to the conversation" },
  memory: { tint: "var(--ctx-memory)", what: "Project memory: CLAUDE.md / AGENTS.md" },
  skills: { tint: "var(--ctx-memory)", what: "Skills listed or loaded" },
  file: { tint: "var(--ctx-file)", what: "A file read, written or edited into the context" },
  image: { tint: "var(--ctx-file)", what: "Images: screenshots and pasted pictures" },
  chat: { tint: "var(--ctx-chat)", what: "Prompts and replies" },
  thinking: { tint: "var(--ctx-chat)", what: "Thinking the model keeps in context" },
  tool: { tint: "var(--ctx-tool)", what: "Tool results" },
  agent: { tint: "var(--ctx-tool)", what: "What sub-agents reported back" },
  summary: { tint: "var(--ctx-summary)", what: "The summary that replaced the conversation at the last compaction" },
};

function what(p: ContextPart): string {
  if (p.id === "other:not in the transcript") return "Context the CLI added that the transcript doesn't record (reminders, hook output)";
  if (p.basis === "remainder") return "What the first request held beyond everything the transcript shows: system prompt, tool definitions, memory, skills";
  if (p.id === "file:*") return "Smaller files, merged";
  if (p.kind === "tool") {
    if (p.label === "Test runs") return "Output of test runs";
    if (p.label === "Searches") return "Search results (grep, glob)";
    if (p.label === "Shell") return "Shell command output";
    if (p.label.startsWith("MCP")) return `Results from the ${p.label.slice(6)} MCP server`;
    if (p.label === "Web") return "Fetched pages and web searches";
  }
  return KIND[p.kind].what;
}

const BASIS: Record<ContextPart["basis"], string> = {
  calibrated: "Calibrated from the usage the CLI reported per step, split by length",
  estimated: "Estimated from text length",
  remainder: "Remainder of the first request, not itemised",
};

/** Kinds whose count reads as "×N" on the tile. */
const COUNTED = new Set<ContextKind>(["tool", "agent", "image"]);

const tone = (pct: number, known: boolean) => (known && pct >= 1 ? "var(--error-text)" : known && pct >= 0.75 ? "var(--busy-text)" : "var(--dim)");

export interface ContextAgent {
  id: string;
  label: string;
  model?: string | null;
  context: number;
}

type Tile = { id: string; part: ContextPart | null; tokens: number; rect: Rect; shrunk?: boolean };

const FREE = "free";
/** The free room never takes more than this share of the area (a 1M window would leave the parts as slivers); its card says so. */
const FREE_MAX = 0.45;

/** The treemap: parts largest first, the free room last (so it takes what is left, at the end). */
function layout(parts: ContextPart[], free: number, w: number, h: number): Tile[] {
  const used = parts.reduce((n, p) => n + p.tokens, 0);
  const cap = (used * FREE_MAX) / (1 - FREE_MAX);
  const shrunk = free > cap && used > 0;
  const items = [...parts.map((p) => ({ id: p.id, part: p as ContextPart | null, tokens: p.tokens, area: p.tokens })), ...(free > 0 ? [{ id: FREE, part: null, tokens: free, area: shrunk ? cap : free, shrunk }] : [])];
  const rects = squarify(
    items.map((i) => i.area),
    { x: 0, y: 0, w, h },
  );
  return items.map((i, k) => ({ ...i, rect: rects[k] })).filter((t) => t.rect.w > 0.5 && t.rect.h > 0.5);
}

export function ContextMapCard({
  provider,
  sessionId,
  cwd,
  model,
  window: reported,
  context,
  agents,
  compacting,
}: {
  provider: Provider;
  sessionId: string;
  cwd?: string;
  model: string | null;
  window?: number | null;
  /** The context coool already shows for the session: a change asks for a fresh map. */
  context: number;
  agents: ContextAgent[];
  compacting?: boolean;
}) {
  const [agentId, setAgentId] = useState<string | null>(null);
  const agent = agentId ? agents.find((a) => a.id === agentId) : undefined;
  useEffect(() => {
    if (agentId && !agent) setAgentId(null);
  }, [agentId, agent]);
  const pulse = agent ? agent.context : context;
  const [map, setMap] = useState<ContextMap | null>(null);
  const [missing, setMissing] = useState(false);
  const key = `${provider}:${sessionId}:${agentId ?? ""}`;
  const shownKey = useRef(key);
  useEffect(() => {
    let live = true;
    // Coalesce bursts: a busy session's context moves every few seconds.
    const t = setTimeout(
      () => {
        api()
          .contextMap({ provider, sessionId, agentId, cwd })
          .then((m) => {
            if (!live) return;
            shownKey.current = key;
            setMap(m);
            setMissing(false);
          })
          .catch((e) => {
            if (!live) return;
            if (isNotAvailable(e)) setMissing(true);
            else setMap(null);
          });
      },
      map && shownKey.current === key ? 400 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
    // `map` only picks the delay; refetch on what changes the numbers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pulse, compacting, provider, sessionId, agentId, cwd]);
  const [before, setBefore] = useState(false);
  useEffect(() => setBefore(false), [key, map?.compaction?.at]);

  if (missing) return null;
  const current = map && shownKey.current === key ? map : null;
  const w = contextWindow(agent?.model ?? model, agent ? null : reported);
  const comp = current?.compaction ?? null;
  const showBefore = before && !!comp?.before_parts.length;
  const parts = showBefore ? comp!.before_parts : (current?.parts ?? []);
  const used = showBefore ? comp!.before_parts.reduce((n, p) => n + p.tokens, 0) : (current?.total ?? pulse);
  const known = w.source !== "assumed";
  const pct = used / w.tokens;
  return (
    <div className="rounded-[12px] border border-hairline bg-raised" data-context-map>
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <span className="font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">Context</span>
        {agents.length > 0 && <AgentPicker agents={agents} value={agentId} onChange={setAgentId} />}
        <span className="ml-auto shrink-0 text-small tnum">
          <span className="font-medium text-fg">{fmtTokens(used)}</span>
          <span className="text-faint">
            {" / "}
            {w.source === "reported" ? "" : "~"}
            {fmtTokens(w.tokens)}
          </span>
        </span>
        <span
          className="shrink-0 rounded-[5px] px-1 text-small font-medium tnum transition-colors duration-500"
          style={{ color: tone(pct, known), background: `color-mix(in oklab, ${tone(pct, known)} 13%, transparent)` }}
          title={known ? undefined : "Window unknown for this model; showing against an assumed 200k"}
        >
          {pct > 0 && pct < 0.01 ? "<1" : Math.round(pct * 100)}%
        </span>
      </div>
      <div className="px-3 pb-3 pt-2.5">
        {current && parts.length > 0 ? (
          <Treemap parts={parts} free={Math.max(0, w.tokens - used)} windowTokens={w.tokens} used={used} cpt={current.chars_per_token} dim={!!compacting} />
        ) : (
          <div className="flex h-[52px] items-center rounded-[8px] px-3 text-small text-dim ctx-free">{current?.note ?? (current ? "Nothing in context yet." : "Reading the transcript…")}</div>
        )}
        <Footer compacting={!!compacting && !agent} comp={agent ? null : comp} before={showBefore} onBefore={setBefore} note={current?.parts.length ? current.note : null} />
      </div>
    </div>
  );
}

function AgentPicker({ agents, value, onChange }: { agents: ContextAgent[]; value: string | null; onChange: (id: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const cur = value ? agents.find((a) => a.id === value) : null;
  const pick = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };
  return (
    <div className="relative min-w-0 flex-1">
      <button
        type="button"
        data-pop-anchor
        onClick={() => setOpen((o) => !o)}
        className="flex h-[22px] min-w-0 max-w-full items-center gap-1 rounded-[6px] px-1.5 text-small text-dim hover:bg-hover"
        title="Whose context: the main thread or a subagent (each has its own)"
      >
        <span className="truncate">{cur ? cur.label : "Main"}</span>
        <ICaret size={11} className="shrink-0 text-faint" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} width={240}>
        <div className="flex max-h-[260px] flex-col overflow-y-auto p-1">
          {[{ id: null as string | null, label: "Main thread", model: null as string | null | undefined, context: -1 }, ...agents].map((a) => (
            <button
              key={a.id ?? "main"}
              type="button"
              onClick={() => pick(a.id)}
              className="flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-small text-fg/90 hover:bg-hover"
            >
              <span className="w-3 shrink-0">{a.id === value && <ICheck size={12} className="text-dim" />}</span>
              <span className="min-w-0 flex-1 truncate">{a.label}</span>
              {a.id && a.model && <span className="shrink-0 text-faint">{modelLabel(a.model)}</span>}
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}

function Footer({ compacting, comp, before, onBefore, note }: { compacting: boolean; comp: ContextMap["compaction"]; before: boolean; onBefore: (b: boolean) => void; note: string | null }) {
  if (compacting)
    return (
      <div className="ctx-compacting mt-2 flex items-center gap-1.5 text-small text-dim" data-ctx-compacting title="The CLI is summarizing the conversation to free room">
        <MoodGlyph mood="compact" size={13} />
        Compacting the conversation…
      </div>
    );
  if (comp)
    return (
      <div className="mt-2 flex items-center gap-1.5 text-small text-faint tnum">
        <span className="min-w-0 truncate" title={`${comp.auto ? "Compacted automatically near the limit" : "Compacted with /compact"}${comp.at ? ` at ${clockTime(comp.at)}` : ""}: ${fmtTokens(comp.before)} before, ${comp.after ? fmtTokens(comp.after) : "not known yet"} after`}>
          Compacted{comp.at ? ` ${clockTime(comp.at).slice(0, 5)}` : ""} · {fmtTokens(comp.before)} → {comp.after ? fmtTokens(comp.after) : "…"}
        </span>
        {comp.before_parts.length > 0 && (
          <button type="button" onClick={() => onBefore(!before)} className="ml-auto shrink-0 rounded-[5px] px-1 text-dim hover:bg-hover hover:text-fg" aria-pressed={before}>
            {before ? "Show now" : "Show before"}
          </button>
        )}
      </div>
    );
  if (note) return <div className="mt-2 text-small text-faint">{note}</div>;
  return null;
}

function Treemap({ parts, free, windowTokens, used, cpt, dim }: { parts: ContextPart[]; free: number; windowTokens: number; used: number; cpt: number | null; dim: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const height = Math.round(Math.min(340, Math.max(220, width * 0.92)));
  const tiles = useMemo(() => (width > 0 ? layout(parts, free, width, height) : []), [parts, free, width, height]);
  const [hover, setHover] = useState<string | null>(null);
  const { reduce } = useMotion();
  const t = reduce ? { duration: 0 } : { duration: 0.7, ease };
  const hovered = tiles.find((x) => x.id === hover) ?? null;
  return (
    <div ref={ref} className="relative w-full" style={{ height }} role="list" aria-label="What fills the context window" onPointerLeave={() => setHover(null)}>
      <AnimatePresence initial={false}>
        {tiles.map((tile) => {
          const { x, y, w, h } = tile.rect;
          // A 2px gap between tiles: each is inset by 1px.
          const box = { left: x + 1, top: y + 1, width: Math.max(0, w - 2), height: Math.max(0, h - 2) };
          return (
            <motion.div
              key={tile.id}
              role="listitem"
              tabIndex={0}
              aria-label={tile.part ? `${tile.part.label}: ${fmtTokens(tile.tokens)} tokens` : `Free: ${fmtTokens(tile.tokens)} tokens`}
              className={cx("absolute overflow-hidden rounded-[6px]", tile.part ? "ctx-tile" : "ctx-free", dim && tile.part && (tile.part.kind === "chat" || tile.part.kind === "tool" || tile.part.kind === "thinking" || tile.part.kind === "agent") && "ctx-compacting")}
              style={tile.part ? ({ ["--k" as string]: KIND[tile.part.kind].tint } as React.CSSProperties) : undefined}
              initial={{ ...box, opacity: 0 }}
              animate={{ ...box, opacity: 1 }}
              exit={{ opacity: 0, transition: reduce ? { duration: 0 } : { duration: 0.3 } }}
              transition={t}
              onPointerEnter={() => setHover(tile.id)}
              onFocus={() => setHover(tile.id)}
              onBlur={() => setHover((h) => (h === tile.id ? null : h))}
              data-ctx-tile={tile.id}
            >
              <TileLabel tile={tile} w={box.width} h={box.height} />
            </motion.div>
          );
        })}
      </AnimatePresence>
      {hovered && <Card tile={hovered} area={{ w: width, h: height }} windowTokens={windowTokens} used={used} cpt={cpt} />}
    </div>
  );
}

function TileLabel({ tile, w, h }: { tile: Tile; w: number; h: number }) {
  // Too small for any text: the hover card tells.
  if (w < 34 || h < 20) return null;
  const p = tile.part;
  const name = p ? p.label : "Free";
  const n = p && COUNTED.has(p.kind) && p.count > 1 ? ` ×${p.count}` : "";
  const two = h >= 38;
  return (
    <div className={cx("pointer-events-none flex min-w-0 flex-col px-1.5 pt-1 leading-tight", p ? "ctx-ink" : "text-faint")}>
      <span className={cx("truncate font-medium", w < 76 ? "text-micro" : "text-small")}>
        {name}
        {!two && n}
      </span>
      {two && (
        <span className="truncate text-micro tnum opacity-80">
          {fmtTokens(tile.tokens)}
          {n}
        </span>
      )}
    </div>
  );
}

function Card({ tile, area, windowTokens, used, cpt }: { tile: Tile; area: { w: number; h: number }; windowTokens: number; used: number; cpt: number | null }) {
  const W = Math.min(240, area.w);
  const { x, y, w, h } = tile.rect;
  // Never outside the map horizontally.
  // Below the tile in the top half, above it in the bottom half.
  const pos = y + h / 2 < area.h / 2 ? { top: y + h + 6 } : { bottom: area.h - y + 6 };
  const left = Math.max(0, Math.min(area.w - W, x + w / 2 - W / 2));
  const p = tile.part;
  const shareWin = tile.tokens / windowTokens;
  const shareUsed = used > 0 ? tile.tokens / used : 0;
  const pctTxt = (f: number) => (f > 0 && f < 0.01 ? "<1%" : `${Math.round(f * 100)}%`);
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-[10px] border border-hairline bg-panel px-3 py-2.5 text-small shadow-[var(--shadow-pop)]"
      style={{ left, ...pos, width: W }}
      role="tooltip"
      data-ctx-card
    >
      <div className="flex items-baseline gap-2">
        {p && <span className="mt-[3px] h-2 w-2 shrink-0 self-start rounded-[2px]" style={{ background: KIND[p.kind].tint }} />}
        <span className="min-w-0 flex-1 truncate font-medium text-fg">{p ? p.label : "Free"}</span>
        <span className="shrink-0 text-fg tnum">{fmtTokens(tile.tokens)}</span>
      </div>
      <div className="mt-0.5 text-dim">{p ? what(p) : `Room left before the window is full${tile.shrunk ? " (drawn smaller than its share, so the parts stay readable)" : ""}`}</div>
      <div className="mt-1.5 text-faint tnum">
        {p ? `${pctTxt(shareUsed)} of what is in use · ${pctTxt(shareWin)} of the window` : `${pctTxt(shareWin)} of the window`}
        {p && p.count > 1 && p.id !== "file:*" ? ` · ${p.count} ${p.kind === "file" ? "reads / edits" : "calls"}` : ""}
      </div>
      {p && (
        <div className="mt-0.5 text-faint">
          {BASIS[p.basis]}
          {p.basis === "calibrated" && cpt && (p.kind === "tool" || p.kind === "file" || p.kind === "agent") ? ` (~${cpt} chars per token here)` : ""}
        </div>
      )}
      {p?.path && <div className="mt-1.5 whitespace-pre-line break-all font-mono text-mono-small text-dim">{p.path.split("\n").map(homeShort).join("\n")}</div>}
    </div>
  );
}
