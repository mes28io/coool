// Plan usage (CHAT_SPEC "Plan usage"): one block per provider, one row per window.
// Used by the rail popover and by the chat's /usage panel, so the rows live here once.
import { useEffect, useRef, useState } from "react";
import { usageRefresh } from "../lib/actions";
import { useNow } from "../lib/clock";
import { ago } from "../lib/format";
import type { PlanUsage, Provider, UsageWindow } from "../lib/types";
import { useStore } from "../store";
import { IRefresh } from "./icons";
import { cx, IconButton, ProviderMark } from "./primitives";

/** Meter colour: neutral below 75%, yellow from 75%, red from 90% or when the CLI says critical/limited. */
export function usageTone(w: Pick<UsageWindow, "used_percent" | "severity">): "neutral" | "warn" | "bad" {
  const p = w.used_percent;
  const sev = (w.severity ?? "").toLowerCase();
  if (sev === "critical" || sev === "limited" || (p !== null && p >= 90)) return "bad";
  if (p !== null && p >= 75) return "warn";
  return "neutral";
}
const toneColor = { neutral: "var(--dim)", warn: "var(--busy)", bad: "var(--error)" } as const;

/** "Resets in 1h 54m" under 24 h, "Resets Mon 09:00" beyond. */
export function resetText(resetsMs: number | null, now: number): string | null {
  if (resetsMs === null) return null;
  const ms = resetsMs - now;
  if (ms <= 0) return "Resets now";
  if (ms < 24 * 3600_000) {
    const m = Math.ceil(ms / 60_000);
    return m < 60 ? `Resets in ${m}m` : `Resets in ${Math.floor(m / 60)}h ${m % 60}m`;
  }
  const d = new Date(resetsMs);
  return `Resets ${d.toLocaleDateString("en-GB", { weekday: "short" })} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

/** The worst window with a known percent across both providers, for the rail dot and tooltip. */
export function usageHighest(u: { claude: PlanUsage | null; codex: PlanUsage | null }, hide: Provider[] = []): { label: string; percent: number; tone: "warn" | "bad" } | null {
  let best: { label: string; percent: number; tone: "warn" | "bad" } | null = null;
  for (const p of [u.claude, u.codex]) {
    if (!p || hide.includes(p.provider)) continue;
    for (const w of p.windows) {
      if (w.used_percent === null) continue;
      const tone = usageTone(w);
      if (tone === "neutral") continue;
      if (!best || w.used_percent > best.percent) best = { label: w.label, percent: Math.round(w.used_percent), tone };
    }
  }
  return best;
}

export function UsageRow({ w, now }: { w: UsageWindow; now: number }) {
  const known = w.used_percent !== null;
  const pct = known ? Math.max(0, Math.min(100, w.used_percent!)) : 0;
  const reset = resetText(w.resets_ms, now);
  return (
    <div className="py-1.5" data-usage-window={w.id}>
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-base text-fg/90">{w.label}</span>
        <span className="shrink-0 text-base text-fg tnum">{known ? `${Math.round(pct)}%` : "—"}</span>
      </div>
      <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--dim)_20%,transparent)]">
        {known && <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(2, pct)}%`, background: toneColor[usageTone(w)] }} />}
      </div>
      <div className="mt-1.5 text-small text-dim">{known ? (reset ?? w.detail) : (w.detail ?? "No reading since the reset")}</div>
    </div>
  );
}

type Refresh = { state: "idle" } | { state: "checking"; base: number | null } | { state: "failed" } | { state: "error"; text: string };

/**
 * Refresh state for one provider. It only ever claims what happened: "checking" until a reading with
 * a newer `fetched_ms` arrives (then back to idle, so the footer is computed from `fetched_ms`), or
 * "failed" after 8 s without one, or "error" if the command itself was rejected.
 */
function useRefresh(provider: Provider, fetched: number | null) {
  const [st, setSt] = useState<Refresh>({ state: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => {
    if (st.state === "checking" && (fetched ?? 0) > (st.base ?? 0)) {
      clear();
      setSt({ state: "idle" });
    }
  }, [fetched, st]);
  useEffect(() => clear, []);
  const start = () => {
    clear();
    setSt({ state: "checking", base: fetched });
    timer.current = setTimeout(() => setSt((cur) => (cur.state === "checking" ? { state: "failed" } : cur)), 8000);
    usageRefresh(provider).catch((e) => {
      clear();
      setSt({ state: "error", text: e instanceof Error ? e.message : String(e) });
    });
  };
  return { st, start };
}

const NAME = { claude: "Claude", codex: "Codex" } as const;

export function UsageBlock({ provider, usage, bare }: { provider: Provider; usage: PlanUsage | null; bare?: boolean }) {
  const now = useNow();
  const { st, start } = useRefresh(provider, usage?.fetched_ms ?? null);
  const hasWindows = !!usage && usage.windows.length > 0;
  const credit = usage?.credits?.enabled ? (usage.credits.detail ?? creditLine(usage.credits)) : null;
  return (
    <section data-usage-provider={provider} className={cx(!bare && "px-3 py-2.5")}>
      <div className="flex h-[28px] items-center gap-2">
        <ProviderMark provider={provider} size={15} />
        <span className="text-base font-medium text-fg">{NAME[provider]}</span>
        {usage?.plan && <span className="min-w-0 truncate text-small text-dim">{usage.plan}</span>}
        <span className="ml-auto">
          <IconButton title={`Refresh ${NAME[provider]} usage`} onClick={start} className="-mr-1 text-faint">
            <IRefresh size={16} className={cx(st.state === "checking" && "spin")} />
          </IconButton>
        </span>
      </div>
      {!usage ? (
        <>
          <div className="py-1.5 text-small text-dim">No usage data yet</div>
          <RefreshNote st={st} usage={null} now={now} />
        </>
      ) : (
        <>
          {usage.error && <div className={cx("pb-0.5 pt-1 text-small", hasWindows ? "text-dim" : "text-err-text")}>{usage.error}</div>}
          {usage.windows.map((w) => (
            <UsageRow key={w.id} w={w} now={now} />
          ))}
          {credit && <div className="pt-1 text-small text-dim">Extra usage: {credit}</div>}
          {!!usage.reset_credits && usage.reset_credits > 0 && (
            <div className="pt-1 text-small text-dim">
              {usage.reset_credits} free {usage.reset_credits === 1 ? "reset" : "resets"} available
            </div>
          )}
          <RefreshNote st={st} usage={usage} now={now} />
        </>
      )}
    </section>
  );
}

/** Footer line: what is known, computed from `fetched_ms`, and what the last refresh did. */
function RefreshNote({ st, usage, now }: { st: Refresh; usage: PlanUsage | null; now: number }) {
  let text: string;
  if (st.state === "checking") text = "Checking…";
  else if (st.state === "error") text = st.text;
  else if (st.state === "failed") text = usage ? `Couldn't refresh · last updated ${ago(usage.fetched_ms, now)}` : "Couldn't refresh";
  else if (!usage) return null;
  else text = `Updated ${ago(usage.fetched_ms, now)}${usage.stale ? " · may be out of date" : ""}`;
  return <div className="pt-2 text-small text-faint">{text}</div>;
}

function creditLine(c: NonNullable<PlanUsage["credits"]>): string | null {
  if (c.unlimited) return "unlimited";
  if (c.used !== null && c.limit !== null) return `${c.used} of ${c.limit}`;
  if (c.balance) return `balance ${c.balance}`;
  return null;
}

/** Providers whose CLI is installed (all of them until the environment is known). */
export function useUsageProviders(only?: Provider): Provider[] {
  const env = useStore((s) => s.env);
  const list: Provider[] = ["claude", "codex"];
  return list.filter((p) => (only ? p === only : true) && (!env || env[p] !== null));
}

/** Both providers, Claude first, with hairline dividers. */
export function UsagePanel() {
  const usage = useStore((s) => s.usage);
  const providers = useUsageProviders();
  return (
    <div className="divide-y divide-hairline">
      {providers.map((p) => (
        <UsageBlock key={p} provider={p} usage={usage[p]} />
      ))}
      {providers.length === 0 && <div className="px-3 py-3 text-small text-dim">No supported CLI found.</div>}
    </div>
  );
}
