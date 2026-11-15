// Header chip for a session's subagents: "4 agents" with a green dot while any run;
// opens a popover with each one (what it is, its model, what it does now).

import { useState } from "react";
import { isLive, type AgentCardData } from "../lib/agentCards";
import { modelLabel } from "../lib/models";
import { useStore } from "../store";
import type { Agent } from "../lib/types";
import { sessionKey } from "../lib/types";
import type { Session } from "../lib/types";
import { ModelTag } from "./Models";
import { cx, Popover, StatusDot } from "./primitives";

/** Finished ones shown before "Show all". */
const DONE_CAP = 8;

/** Last thing an agent did (epoch-free: activity stamps are clock times), for "most recent first". */
const lastStamp = (a: Agent) => a.activity[a.activity.length - 1]?.ts ?? "";

/** The chip while the Agents panel exists (pane at least 900px wide): it toggles the panel. */
export interface PanelToggle {
  cards: AgentCardData[];
  open: boolean;
  onToggle: () => void;
}

export function AgentsChip({ session, panel }: { session: Session | null; panel: PanelToggle | null }) {
  if (panel) return <PanelChip panel={panel} />;
  return session ? <PopoverChip session={session} /> : null;
}

function PanelChip({ panel }: { panel: PanelToggle }) {
  const { cards, open, onToggle } = panel;
  const live = cards.filter(isLive);
  const agents = live.filter((c) => c.source !== "job").length;
  const jobs = live.length - agents;
  const label = live.length
    ? `${live.length} ${jobs === 0 ? (live.length === 1 ? "agent" : "agents") : agents === 0 ? (live.length === 1 ? "job" : "jobs") : "working"}`
    : `${cards.length} ${cards.length === 1 ? "agent" : "agents"}`;
  return (
    <button
      type="button"
      data-agents-chip
      onClick={onToggle}
      title={open ? "Hide the Agents panel" : "Show the Agents panel"}
      aria-label={open ? "Hide the Agents panel" : "Show the Agents panel"}
      aria-pressed={open}
      className={cx(
        "flex h-[24px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[8px] pl-[7px] pr-2 text-small font-medium transition-colors duration-150",
        open ? "bg-press text-fg" : "text-dim hover:bg-hover hover:text-fg",
      )}
    >
      <StatusDot status={live.length ? "busy" : "ended"} size={7} />
      {label}
    </button>
  );
}

function PopoverChip({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const openSession = useStore((st) => st.open);
  const focusAgent = useStore((st) => st.focusAgent);
  const running = session.status === "ended" ? [] : session.agents.filter((a) => !a.finished);
  if (!running.length) return null;
  // Most recent first: later activity stamp first; ties keep the reverse of the given order.
  const done = session.agents
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.finished)
    .sort((x, y) => (lastStamp(y.a) < lastStamp(x.a) ? -1 : lastStamp(y.a) > lastStamp(x.a) ? 1 : y.i - x.i))
    .map(({ a }) => a);
  const shown = all ? done : done.slice(0, DONE_CAP);
  const label = `${running.length} ${running.length === 1 ? "agent" : "agents"}`;
  const goto = (a: Agent) => {
    openSession({ kind: "session", key: sessionKey(session) });
    focusAgent(a.id);
    setOpen(false);
  };
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        data-pop-anchor
        data-agents-chip
        onClick={() => setOpen(!open)}
        title={`${label} working in this session`}
        aria-label={`${label} working in this session`}
        aria-expanded={open}
        className={cx(
          "flex h-[24px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[8px] pl-[7px] pr-2 text-small font-medium transition-colors duration-150",
          open ? "bg-press text-fg" : "text-dim hover:bg-hover hover:text-fg",
        )}
      >
        <StatusDot status="busy" size={7} />
        {label}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} width={360}>
        <div className="flex flex-col p-3.5" data-agents-popover>
          <div className="mb-1.5 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">Working now</div>
          <div className="flex flex-col gap-0.5">
            {running.map((a) => (
              <button key={a.id} type="button" onClick={() => goto(a)} className="-mx-1.5 flex flex-col gap-0.5 rounded-[8px] px-1.5 py-1.5 text-left transition-colors duration-150 hover:bg-hover">
                <span className="flex min-w-0 items-center gap-2 text-base">
                  <StatusDot status="busy" size={7} />
                  <span className="min-w-0 flex-1 truncate font-medium text-fg/90">{a.description || a.kind}</span>
                  {a.model && <ModelTag model={a.model} />}
                </span>
                <span className="truncate pl-[15px] font-mono text-mono-small text-dim" title={a.current ?? undefined}>
                  {a.current ?? "starting…"}
                </span>
              </button>
            ))}
          </div>
          {done.length > 0 && (
            <div className="mt-2.5 border-t border-hairline pt-2.5">
              <div className="mb-1.5 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">Finished</div>
              <div className="flex flex-col gap-0.5">
                {shown.map((a) => (
                  <div key={a.id} className="flex min-w-0 items-center gap-2 py-[3px] text-small text-faint">
                    <span className="size-[7px] shrink-0 rounded-full border border-faint/60" />
                    <span className="min-w-0 flex-1 truncate">{a.description || a.kind}</span>
                    {a.model && <span className="shrink-0">{modelLabel(a.model)}</span>}
                  </div>
                ))}
              </div>
              {done.length > DONE_CAP && (
                <button type="button" onClick={() => setAll(!all)} className="mt-1 rounded-[6px] py-0.5 text-small text-dim transition-colors duration-150 hover:text-fg">
                  {all ? "Show fewer" : `Show all ${done.length}`}
                </button>
              )}
            </div>
          )}
        </div>
      </Popover>
    </div>
  );
}
