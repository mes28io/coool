// Native /context, /status, /cost and /usage: one compact panel with three tabs,
// fed by `ready`, `usage` events and the chat's own state.

import { motion } from "motion/react";
import { useMemo } from "react";
import { chatCall } from "../lib/actions";
import { api } from "../lib/backend";
import { chatModels, type Chat } from "../lib/chat";
import { fmtTokens, homeShort } from "../lib/format";
import { contextWindow, modelLabel } from "../lib/models";
import { ModelsBreakdown } from "./Models";
import { PERMISSION_MODES } from "./ChatComposer";
import { cx, ease, Segmented } from "./primitives";
import { UsageBlock } from "./Usage";
import { useStore } from "../store";

export type InfoTab = "context" | "status" | "usage";

export function InfoPanel({ chat, tab, onTab }: { chat: Chat; tab: InfoTab; onTab: (t: InfoTab) => void }) {
  return (
    <div data-info-panel={tab}>
      <div className="flex items-center justify-between border-b border-hairline px-3 py-1.5">
        <Segmented<InfoTab>
          size="sm"
          value={tab}
          onChange={onTab}
          options={[
            { value: "context", label: "Context" },
            { value: "status", label: "Status" },
            { value: "usage", label: "Usage" },
          ]}
        />
        <span className="font-mono text-mono-small text-faint">/{tab}</span>
      </div>
      <motion.div key={tab} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease }}>
        {tab === "context" ? <ContextTab chat={chat} /> : tab === "status" ? <StatusTab chat={chat} /> : <UsageTab chat={chat} />}
      </motion.div>
    </div>
  );
}

function ContextTab({ chat }: { chat: Chat }) {
  const w = contextWindow(chat.model, chat.contextWindow);
  const pct = chat.context / w.tokens;
  const exact = w.source === "reported";
  const known = w.source !== "assumed";
  const color = known && pct > 1 ? "var(--error)" : known && pct >= 0.75 ? "var(--busy)" : "var(--dim)";
  const hist = chat.usageHistory.filter((p) => p.context > 0);
  return (
    <div className="flex flex-col gap-3 p-3.5">
      <div className="flex items-baseline gap-2">
        <span className=" text-display font-semibold tracking-[-0.02em] text-fg tnum">{fmtTokens(chat.context)}</span>
        <span className="text-base text-dim">
          of {exact ? "" : "~"}
          {fmtTokens(w.tokens)} tokens
        </span>
        <span className="ml-auto text-base tnum" style={{ color }}>
          {pct < 0.01 && chat.context > 0 ? "<1" : Math.round(pct * 100)}%
        </span>
      </div>
      <div className="relative h-[8px] overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--dim)_18%,transparent)]">
        <motion.div className="absolute inset-y-0 left-0 rounded-full" initial={false} animate={{ width: `${Math.max(1, Math.min(1, pct) * 100)}%`, backgroundColor: color }} transition={{ duration: 0.6, ease }} />
      </div>
      <div className="text-small text-dim">
        {w.source === "reported" ? (
          <>Window reported by the CLI for {modelLabel(chat.model)}.</>
        ) : w.source === "family" ? (
          <>The CLI didn't report a window; ~{fmtTokens(w.tokens)} is the usual size for {modelLabel(chat.model)}.</>
        ) : (
          <>Window unknown for this model; showing against an assumed 200k.</>
        )}
      </div>
      {hist.length > 1 && <Spark points={hist.map((p) => p.context)} max={w.tokens} color={color} />}
      {pct > 0.6 && chat.running && (
        <button
          type="button"
          onClick={() => void chatCall(chat.id, () => api().chatSend(chat.id, "/compact"))}
          className="self-start rounded-[10px] border border-line px-2 py-1 text-small text-dim hover:bg-hover hover:text-fg"
        >
          Run /compact to summarize earlier turns
        </button>
      )}
    </div>
  );
}

function Spark({ points, max, color }: { points: number[]; max: number; color: string }) {
  const W = 370;
  const H = 46;
  const top = Math.max(...points) * 1.15 || 1;
  const scale = Math.min(max, top);
  const xy = points.map((v, i) => [(i / (points.length - 1)) * W, H - (Math.min(v, scale) / scale) * (H - 4) - 2] as const);
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  return (
    <div>
      <div className="mb-1 flex justify-between text-small text-faint">
        <span>Context over this chat</span>
        <span className=" tnum">{points.length} replies</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[52px] w-full overflow-visible" preserveAspectRatio="none">
        <path d={`${d}L${W},${H}L0,${H}Z`} fill={color} opacity="0.1" />
        <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 py-[3px]">
      <span className="w-[104px] shrink-0 text-small text-faint">{k}</span>
      <span className={cx("selectable min-w-0 flex-1 break-all text-base text-fg/90", mono && "font-mono text-mono-small")}>{v}</span>
    </div>
  );
}

function StatusTab({ chat }: { chat: Chat }) {
  const mode = (PERMISSION_MODES[chat.provider] ?? []).find((m) => m.id === chat.permissionMode);
  const w = contextWindow(chat.model, chat.contextWindow);
  return (
    <div className="flex flex-col p-3.5">
      <Row k="Agent" v={chat.provider === "claude" ? "Claude Code" : "Codex"} />
      <Row k="Model" v={chat.model ? `${modelLabel(chat.model)}  ·  ${chat.model}` : "not reported yet"} />
      <Row k="Permissions" v={mode ? `${mode.label} (${mode.id})` : (chat.permissionMode ?? "default")} />
      <Row k="Folder" v={homeShort(chat.cwd)} mono />
      <Row k="Session" v={chat.sessionId ?? "not started"} mono />
      <Row
        k="Process"
        v={
          chat.running ? (
            <span className="text-dim">running · {chat.state === "idle" ? "idle" : chat.state === "working" ? "working" : "waiting for permission"}</span>
          ) : (
            <span className="text-dim">exited{chat.exitCode !== null ? ` (code ${chat.exitCode})` : ""}</span>
          )
        }
      />
      <Row k="Context window" v={`${w.source === "reported" ? "" : "~"}${fmtTokens(w.tokens)} · ${w.source === "reported" ? "reported" : w.source === "family" ? "estimated" : "assumed"}`} />
      <Row k="Commands" v={`${chat.slashCommands.length} from the CLI`} />
      {chat.agentKinds.length > 0 && <Row k="Subagent types" v={chat.agentKinds.join(", ")} />}
    </div>
  );
}

function UsageTab({ chat }: { chat: Chat }) {
  const data = useMemo(() => {
    const m = chatModels(chat);
    return { main: m.main, agents: m.agents.map((a) => ({ key: a.tool, label: a.label, models: a.models })) };
  }, [chat]);
  const turns = chat.items.filter((i) => i.kind === "turn").length;
  const t = chat.tokens;
  const planUsage = useStore((s) => s.usage[chat.provider]);
  return (
    <div>
      {/* The plan windows for this chat's provider, the same rows as the rail popover. */}
      <div className="border-b border-hairline px-3 pb-1 pt-1.5">
        <UsageBlock provider={chat.provider} usage={planUsage} bare />
      </div>
      <div className="grid grid-cols-4 gap-px border-b border-hairline bg-hairline">
        {[
          ["Input", t.input],
          ["Cached", t.cached],
          ["Output", t.output],
          ["Turns", turns],
        ].map(([k, v]) => (
          <div key={k as string} className="bg-raised px-3 py-2">
            <div className="text-small text-faint">{k}</div>
            <div className=" text-base font-semibold text-fg tnum">{k === "Turns" ? v : fmtTokens(v as number)}</div>
          </div>
        ))}
      </div>
      <ModelsBreakdown data={data} current={chat.model} />
      {(
        <div className="border-t border-hairline px-3.5 py-2 text-small text-faint">Token counts come straight from the CLI. coool doesn't estimate dollar cost.</div>
      )}
    </div>
  );
}
