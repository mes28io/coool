// "Which models ran, and how much": per session and per subagent.
// Data: Session.models / Agent.model / Agent.models (CHAT_SPEC "Models used"),
// or the chat's own usage events. Everything tolerates absent fields.

import { motion } from "motion/react";
import { useState } from "react";
import { fmtTokens } from "../lib/format";
import { modelColor, modelLabel, sessionModels, tokTotal } from "../lib/models";
import type { ModelUse, Session } from "../lib/types";
import { ISpark } from "./icons";
import { cx, ease, Popover } from "./primitives";

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
    <span className={cx("inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[5px] bg-[color-mix(in_oklab,var(--dim)_11%,transparent)] px-1.5 text-2xs font-medium text-dim", className)} title={model}>
      <span className="size-[6px] rounded-full" style={{ background: modelColor(model) }} />
      {modelLabel(model)}
    </span>
  );
}

/** One stacked bar for a set of model rows. */
export function ShareBar({ rows, className }: { rows: ModelUse[]; className?: string }) {
  const total = rows.reduce((n, r) => n + tokTotal(r), 0) || 1;
  return (
    <div className={cx("flex h-[6px] w-full gap-[2px] overflow-hidden rounded-full", className)}>
      {rows.map((r) => (
        <motion.span
          key={r.model + (r.via_agent ? "a" : "")}
          className="h-full rounded-full"
          initial={false}
          animate={{ flexGrow: Math.max(0.015, tokTotal(r) / total) }}
          transition={{ duration: 0.6, ease }}
          style={{ flexBasis: 0, background: modelColor(r.model), opacity: r.via_agent ? 0.6 : 1 }}
        />
      ))}
    </div>
  );
}

export function ModelsBreakdown({ data, current }: { data: ModelsData; current?: string | null }) {
  const total = data.main.reduce((n, r) => n + tokTotal(r), 0);
  const agents = data.agents.filter((a) => a.models.length || a.model);
  if (!data.main.length && !agents.length)
    return <div className="px-3.5 py-4 text-sm text-dim">No model usage reported yet. It appears after the first reply.</div>;
  return (
    <div className="flex flex-col gap-3 p-3.5">
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-faint">Models used</span>
          <span className="text-xs text-faint">
            <span className="tnum font-mono text-dim">{fmtTokens(total)}</span> tokens
          </span>
        </div>
        <ShareBar rows={data.main} />
        <div className="mt-2.5 flex flex-col gap-1.5">
          {data.main.map((r) => {
            const t = tokTotal(r);
            return (
              <div key={r.model + (r.via_agent ? "a" : "")} className="flex items-center gap-2 text-sm">
                <span className="size-[7px] shrink-0 rounded-full" style={{ background: modelColor(r.model), opacity: r.via_agent ? 0.6 : 1 }} />
                <span className="min-w-0 truncate font-medium text-fg/90" title={r.model}>
                  {modelLabel(r.model)}
                </span>
                {r.via_agent && <span className="shrink-0 text-2xs text-accent2">subagents</span>}
                {current && r.model === current && !r.via_agent && <span className="shrink-0 rounded-[4px] bg-accent-soft px-1 text-[9.5px] font-semibold uppercase leading-[14px] tracking-wide text-accent">now</span>}
                <span className="ml-auto shrink-0 font-mono text-2xs text-faint tnum" title={`in ${fmtTokens(r.input)} · cached ${fmtTokens(r.cached)} · out ${fmtTokens(r.output)}`}>
                  {fmtTokens(t)}
                </span>
                <span className="w-[34px] shrink-0 text-right font-mono text-2xs text-dim tnum">{total ? Math.round((t / total) * 100) : 0}%</span>
              </div>
            );
          })}
        </div>
      </div>
      {agents.length > 0 && (
        <div className="border-t border-hairline pt-2.5">
          <div className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-faint">Subagents</div>
          <div className="flex flex-col gap-1">
            {agents.map((a) => {
              const t = a.models.reduce((n, r) => n + tokTotal(r), 0);
              const ids = a.models.length ? a.models.map((m) => m.model) : [a.model!];
              return (
                <div key={a.key} className="flex items-center gap-2 text-xs">
                  <ISpark size={11} className="shrink-0 text-accent2" />
                  <span className="min-w-0 flex-1 truncate text-fg/85">{a.label}</span>
                  {ids.map((m) => (
                    <ModelTag key={m} model={m} />
                  ))}
                  <span className="w-[38px] shrink-0 text-right font-mono text-2xs text-faint tnum">{t ? fmtTokens(t) : "–"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Header chip: current model, "+N" when others ran too; opens the breakdown. */
export function ModelsChip({ data, current }: { data: ModelsData; current: string | null; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const ids = new Set<string>();
  for (const r of data.main) ids.add(r.model);
  for (const a of data.agents) for (const r of a.models) ids.add(r.model);
  if (current) ids.add(current);
  const others = [...ids].filter((m) => m !== current).length;
  if (!current && !ids.size) return null;
  const shown = current ?? [...ids][0];
  return (
    <div className="relative">
      <button
        type="button"
        data-pop-anchor
        onClick={() => setOpen(!open)}
        title="Models used in this session"
        className={cx(
          "flex h-[22px] items-center gap-1.5 rounded-[6px] px-1.5 text-xs transition-colors duration-150",
          open ? "bg-press text-fg" : "text-dim hover:bg-hover hover:text-fg",
        )}
      >
        <span className="size-[6px] rounded-full" style={{ background: modelColor(shown) }} />
        {modelLabel(shown)}
        {others > 0 && <span className="rounded-[4px] bg-[color-mix(in_oklab,var(--dim)_14%,transparent)] px-1 font-sans text-[10px] font-semibold text-dim">+{others}</span>}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} width={340}>
        <ModelsBreakdown data={data} current={current} />
      </Popover>
    </div>
  );
}
