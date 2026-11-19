// "Which models ran, and how much": per session and per subagent.
// Data: Session.models / Agent.model / Agent.models (CHAT_SPEC "Models used"),
// or the chat's own usage events. Everything tolerates absent fields.

import { motion } from "motion/react";
import { toolMood, type Mood } from "../lib/activityMood";
import type { AgentCardData } from "../lib/agentCards";
import { contextWindow, modelColor, modelLabel, sessionModels, tokTotal, usageShares } from "../lib/models";
import type { ModelUse, Session } from "../lib/types";
import type { Provider } from "../lib/types";
import { fmtTokens } from "../lib/format";
import { ContextRing, cx, ease, ProviderMark } from "./primitives";
import { ContextMapCard } from "./ContextMap";
import type { ComponentProps } from "react";

export interface ModelsData {
  /** Main thread, plus rows aggregated from subagents (via_agent). */
  main: ModelUse[];
  agents: { key: string; label: string; kind?: string; models: ModelUse[]; model?: string | null }[];
}

export function sessionModelsData(s: Session): ModelsData {
  return {
    main: sessionModels(s),
    agents: s.agents.map((a) => ({
      key: a.id,
      label: a.description || a.kind,
      kind: a.kind,
      models: a.models?.length ? a.models : a.model ? [{ model: a.model, input: a.tokens.input, cached: a.tokens.cached, output: a.tokens.output, messages: 0 }] : [],
      model: a.model ?? null,
    })),
  };
}

export function ModelTag({ model, className }: { model: string; className?: string }) {
  return (
    <span className={cx("inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[6px] bg-[color-mix(in_oklab,var(--dim)_11%,transparent)] px-1.5 text-small font-medium text-dim", className)} title={model}>
      {modelLabel(model)}
    </span>
  );
}

/** One stacked bar for a set of model rows. */
export function ShareBar({ rows, shares, className }: { rows: ModelUse[]; shares?: number[]; className?: string }) {
  const total = rows.reduce((n, r) => n + tokTotal(r), 0) || 1;
  return (
    <div className={cx("flex h-[6px] w-full gap-[2px] overflow-hidden rounded-full", className)}>
      {rows.map((r, i) => (
        <motion.span
          key={r.model + (r.via_agent ? "a" : "")}
          className="h-full rounded-full"
          initial={false}
          animate={{ flexGrow: Math.max(0.015, shares ? shares[i] : tokTotal(r) / total) }}
          transition={{ duration: 0.6, ease }}
          style={{ flexBasis: 0, minWidth: (shares ? shares[i] : tokTotal(r)) > 0 ? 3 : 0, background: modelColor(r.model), opacity: r.via_agent ? 0.6 : 1 }}
        />
      ))}
    </div>
  );
}

/** Which vendor a model id belongs to, for its logo. */
const providerOf = (model: string): Provider => (/gpt|codex|openai|^o\d/i.test(model) ? "codex" : "claude");

const ACTIVITY: Partial<Record<Mood, string>> = { search: "searching", read: "reading", write: "editing", run: "running commands", plan: "planning", think: "thinking" };

const joinTop = (items: string[]) => items.slice(0, 2).join(" and ");
const topKeys = (m: Map<string, number>) => [...m.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k);

const fmtHM = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

type UseRow = ModelUse & { note: string[]; tip?: string };

/** Sum rows of the same model. */
function mergeByModel(rows: ModelUse[]): ModelUse[] {
  const out: ModelUse[] = [];
  for (const r of rows) {
    const m = out.find((x) => x.model === r.model);
    if (!m) out.push({ ...r, via_agent: undefined });
    else {
      m.input += r.input;
      m.cached += r.cached;
      m.output += r.output;
      m.messages += r.messages;
    }
  }
  return out.sort((x, y) => tokTotal(y) - tokTotal(x));
}

/** This chat's rows: when each model was in use, when more than one was ("since 19:40", "until 19:12"). */
function chatRows(rows: ModelUse[], current: string | null | undefined, history?: { ts: number; model: string | null }[]): UseRow[] {
  return rows.map((r) => {
    const mine = (history ?? []).filter((h) => h.model === r.model);
    const note: string[] = [];
    if (rows.length > 1) {
      if (mine.length && r.model === current) note.push(`since ${fmtHM(mine[0].ts)}`);
      else if (mine.length) note.push(`until ${fmtHM(mine[mine.length - 1].ts)}`);
    }
    return { ...r, note };
  });
}

/** The subagents' rows: agent types plus what they mostly did ("Explore · searching and reading"). */
function agentRows(data: ModelsData, cards: AgentCardData[] | undefined, fallback: ModelUse[]): UseRow[] {
  const perModel: ModelUse[] = [];
  for (const a of data.agents) for (const m of a.models) perModel.push(m);
  const rows = mergeByModel(perModel.length ? perModel : fallback);
  return rows.map((r) => {
    const kinds = new Map<string, number>();
    const moods = new Map<string, number>();
    const titles: string[] = [];
    const mine = (cards ?? []).filter((c) => c.source !== "job" && c.model === r.model);
    if (mine.length) {
      for (const c of mine) {
        kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
        for (const st of c.steps) {
          const w = ACTIVITY[toolMood(st.name)];
          if (w) moods.set(w, (moods.get(w) ?? 0) + 1);
        }
        if (c.description) titles.push(c.description);
      }
    } else {
      for (const a of data.agents) {
        if (!a.models.some((m) => m.model === r.model) && a.model !== r.model) continue;
        if (a.kind) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
        if (a.label) titles.push(a.label);
      }
    }
    const line = [joinTop(topKeys(kinds)) || "Subagents", joinTop(topKeys(moods))].filter(Boolean).join(" · ");
    return { ...r, note: [line], tip: titles.length ? titles.slice(0, 2).join(", ") + (titles.length > 2 ? `, +${titles.length - 2}` : "") : undefined };
  });
}

/** "42%", "<1%" for a nonzero sliver, "–" when nothing was recorded; "~" when the share is only approximate. */
function fmtShare(share: number, approx: boolean, tokens: number): string {
  if (tokens <= 0 && share <= 0) return "–";
  const p = Math.round(share * 100);
  return `${approx ? "~" : ""}${share > 0 && p < 1 ? "<1" : p}%`;
}

function Group({ title, rows, current }: { title: string; rows: UseRow[]; current?: string | null }) {
  // Shares are within the group: estimated usage at API list prices (see usageShares), never shown as numbers.
  const { shares, approx } = usageShares(rows);
  return (
    <div data-models-group={title}>
      <div className="mb-2 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint" title="Share of estimated usage (API list prices). Plan limits are weighted similarly but not published exactly.">
        {title}
      </div>
      {rows.length > 1 && <ShareBar rows={rows} shares={shares} className="mb-2.5" />}
      <div className="flex flex-col gap-2.5">
        {rows.map((r, i) => (
          <div key={r.model} className="flex flex-col gap-0.5" title={r.tip}>
            <div className="flex items-center gap-2 text-base">
              <ProviderMark provider={providerOf(r.model)} size={14} />
              <span className="min-w-0 truncate font-medium text-fg/90" title={r.model}>
                {modelLabel(r.model)}
              </span>
              {title === "Chat" && current && r.model === current && <span className="shrink-0 rounded-[4px] bg-[color-mix(in_oklab,var(--dim)_14%,transparent)] px-1 font-mono text-micro font-semibold uppercase tracking-wide text-dim">now</span>}
              <span className="ml-auto w-[38px] shrink-0 text-right text-small text-dim tnum" title={tokTotal(r) === 0 ? "no usage recorded" : undefined}>{rows.length > 1 ? fmtShare(shares[i], approx, tokTotal(r)) : "100%"}</span>
            </div>
            {r.note.map((l, i) => (
              <div key={i} className="truncate pl-[22px] text-small text-dim">
                {l}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ModelsBreakdown({ data, current, cards, history }: { data: ModelsData; current?: string | null; cards?: AgentCardData[]; history?: { ts: number; model: string | null }[] }) {
  const mainRows = mergeByModel(data.main.filter((r) => !r.via_agent));
  const viaRows = data.main.filter((r) => r.via_agent);
  const sub = data.agents.some((a) => a.models.length || a.model) || viaRows.length ? agentRows(data, cards, viaRows) : [];
  if (!mainRows.length && !sub.length) return <div className="px-3.5 py-4 text-base text-dim">No model usage reported yet. It appears after the first reply.</div>;
  return (
    <div className="flex flex-col gap-4 p-3.5">
      {mainRows.length > 0 && <Group title="Chat" rows={chatRows(mainRows, current, history)} current={current} />}
      {sub.length > 0 && <Group title="Subagents" rows={sub} current={current} />}
    </div>
  );
}

/** Header button: the current model, "+N" when others ran too; toggles the Models panel. */
export function ModelsChip({ data, current, open, onToggle }: { data: ModelsData; current: string | null; open: boolean; onToggle: () => void }) {
  const ids = new Set<string>();
  for (const r of data.main) ids.add(r.model);
  for (const a of data.agents) for (const r of a.models) ids.add(r.model);
  if (current) ids.add(current);
  const others = [...ids].filter((m) => m !== current).length;
  if (!current && !ids.size) return null;
  const shown = current ?? [...ids][0];
  return (
    <button
      type="button"
      data-models-chip
      onClick={onToggle}
      aria-pressed={open}
      title={open ? "Hide models" : "Show models"}
      className={cx(
        "flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] px-1.5 text-small transition-colors duration-150",
        open ? "bg-hover text-dim" : "text-dim hover:bg-hover",
      )}
    >
      <ProviderMark provider={providerOf(shown)} size={14} />
      {modelLabel(shown)}
      {/* Plain text, no tag background: a tinted tag on the open (hover-tinted) chip read as a muddy box. */}
      {others > 0 && <span className="text-small text-faint tnum">+{others}</span>}
    </button>
  );
}

/** The Models side panel: context fill, the models used, then the context map (when the session's transcript is known). */
export function ModelsPanelBody({
  data,
  current,
  cards,
  history,
  context,
  window: reported,
  map,
  className,
}: {
  data: ModelsData;
  current: string | null;
  cards?: AgentCardData[];
  history?: { ts: number; model: string | null }[];
  context: number;
  window?: number | null;
  map?: Omit<ComponentProps<typeof ContextMapCard>, "model" | "window" | "context"> | null;
  className?: string;
}) {
  const w = contextWindow(current, reported);
  const exact = w.source === "reported";
  return (
    <div className={cx("flex h-full flex-col", className)}>
      <div className="flex h-[44px] shrink-0 items-center pl-4 pr-2">
        <span className="text-base font-semibold text-fg">Models</span>
      </div>
      {/* The scrollbar's reserved gutter (10px, styles.css `.scroll`) is part of the right margin: 2 + 10 = the left's 12. */}
      <div className="scroll flex min-h-0 flex-1 flex-col gap-2 pb-3 pl-3 pr-[2px]">
        <div className="flex items-center gap-3 rounded-[12px] border border-hairline bg-raised px-3.5 py-3">
          <ContextRing context={context} model={current} window={reported} size={28} />
          <div className="min-w-0">
            <div className="text-base tnum">
              <span className="font-semibold text-fg">{fmtTokens(context)}</span>
              <span className="text-faint">
                {" / "}
                {exact ? "" : "~"}
                {fmtTokens(w.tokens)}
              </span>
            </div>
            <div className="text-small text-dim">Context in use</div>
          </div>
        </div>
        <div className="rounded-[12px] border border-hairline bg-raised">
          <ModelsBreakdown data={data} current={current} cards={cards} history={history} />
        </div>
        {map && <ContextMapCard {...map} model={current} window={reported} context={context} />}
      </div>
    </div>
  );
}
