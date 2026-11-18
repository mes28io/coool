// Plan usage (CHAT_SPEC "Plan usage"): one block per provider, one row per window.
// Used by the Settings page (Usage), the rail tooltip and the chat's /usage panel, so the rows live here once.
import { useEffect, useRef, useState } from "react";
import { usageRefresh, usageResetCodex } from "../lib/actions";
import { useNow } from "../lib/clock";
import { ago } from "../lib/format";
import type { PlanUsage, Provider, ResetOutcome, UsageWindow } from "../lib/types";
import { useStore } from "../store";
import { ICheck, IRefresh } from "./icons";
import { Button, cx, IconButton, ProviderMark } from "./primitives";

/** Meter colour: neutral below 75%, yellow from 75%, red from 90% or when the CLI says critical/limited. */
export function usageTone(w: Pick<UsageWindow, "used_percent" | "severity">): "neutral" | "warn" | "bad" {
  const p = w.used_percent;
  const sev = (w.severity ?? "").toLowerCase();
  if (sev === "critical" || sev === "limited" || (p !== null && p >= 90)) return "bad";
  if (p !== null && p >= 75) return "warn";
  return "neutral";
}
export const toneColor = { neutral: "var(--dim)", warn: "var(--busy)", bad: "var(--error)" } as const;

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

/** "54m", "1h 54m", "3d 5h": how long until `ms` from `now`. */
export function untilText(ms: number, now: number): string {
  const m = Math.max(1, Math.ceil((ms - now) / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  const h = Math.floor(m / 60);
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Absolute local time: "today 14:30", "tomorrow 09:00", "Mon 09:00" within a week, "Mon 24 Nov, 09:00" beyond. */
export function whenText(ms: number, now: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(new Date(now))) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  const wd = d.toLocaleDateString("en-GB", { weekday: "short" });
  if (days > 1 && days < 7) return `${wd} ${time}`;
  return `${wd} ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
}

/**
 * The limit that will stop the person first: the one the CLI marks as in force (Claude's `binding`), else the
 * window closest to its limit (Codex reports no flag), the later reset winning a tie. Null when nothing is used.
 */
export function bindingWindowId(u: PlanUsage): string | null {
  const marked = u.windows.find((w) => w.binding === true);
  if (marked) return marked.id;
  let best: UsageWindow | null = null;
  for (const w of u.windows) {
    if (w.used_percent === null || w.used_percent <= 0) continue;
    if (!best || w.used_percent > best.used_percent! || (w.used_percent === best.used_percent && (w.resets_ms ?? 0) > (best.resets_ms ?? 0))) best = w;
  }
  return best?.id ?? null;
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

/** "Resets in 1h 54m · today 14:30"; past resets read "Resets now". */
export function resetLine(resetsMs: number | null, now: number): string | null {
  if (resetsMs === null) return null;
  if (resetsMs <= now) return "Resets now";
  return `Resets in ${untilText(resetsMs, now)} · ${whenText(resetsMs, now)}`;
}

/** Tag on the limit that binds (see `bindingWindowId`); same look as the "auto" tag. */
function BindingTag() {
  return (
    <span
      data-usage-binding
      title="The limit that will stop you first"
      className="inline-flex h-[15px] shrink-0 items-center rounded-[4px] border border-hairline px-1 font-mono text-micro uppercase tracking-[0.06em] text-faint"
    >
      binding
    </span>
  );
}

export function UsageRow({ w, now, binding }: { w: UsageWindow; now: number; binding?: boolean }) {
  const known = w.used_percent !== null;
  const pct = known ? Math.max(0, Math.min(100, w.used_percent!)) : 0;
  const reset = resetLine(w.resets_ms, now);
  const note = known ? [reset, w.detail].filter(Boolean).join(" · ") || null : (w.detail ?? "No reading since the reset");
  return (
    <div className="py-1.5" data-usage-window={w.id} data-usage-binding-row={binding || undefined}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 truncate text-base text-fg/90">{w.label}</span>
        {binding && <BindingTag />}
        <span className="ml-auto shrink-0 pl-1 text-base text-fg tnum">{known ? `${Math.round(pct)}%` : "—"}</span>
      </div>
      <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--dim)_20%,transparent)]">
        {known && <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(2, pct)}%`, background: toneColor[usageTone(w)] }} />}
      </div>
      {note && (
        <div className="mt-1.5 text-small text-dim" title={w.resets_ms ? new Date(w.resets_ms).toLocaleString("en-GB") : undefined}>
          {note}
        </div>
      )}
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
  /** Show "Checking…" until a newer reading arrives; `ask: false` when the backend already started one. */
  const start = (ask = true) => {
    clear();
    setSt({ state: "checking", base: fetched });
    timer.current = setTimeout(() => setSt((cur) => (cur.state === "checking" ? { state: "failed" } : cur)), ask ? 8000 : 25_000);
    if (!ask) return;
    usageRefresh(provider).catch((e) => {
      clear();
      setSt({ state: "error", text: e instanceof Error ? e.message : String(e) });
    });
  };
  return { st, start };
}

export const NAME = { claude: "Claude", codex: "Codex" } as const;

/**
 * One provider's plan and limits. `full` (the Settings page): the extra-usage meter as its own row and, for Codex,
 * the reset credits with "Use a reset".
 */
export function UsageBlock({ provider, usage, bare, full }: { provider: Provider; usage: PlanUsage | null; bare?: boolean; full?: boolean }) {
  const now = useNow();
  const { st, start } = useRefresh(provider, usage?.fetched_ms ?? null);
  const hasWindows = !!usage && usage.windows.length > 0;
  const binding = usage ? bindingWindowId(usage) : null;
  const meter = full && usage?.credits?.enabled && usage.credits.used_percent !== null ? usage.credits : null;
  const credit = usage?.credits?.enabled && !meter ? (usage.credits.detail ?? creditLine(usage.credits)) : null;
  return (
    <section data-usage-provider={provider} className={cx(!bare && "px-3 py-2.5")}>
      <div className="flex h-[28px] items-center gap-2">
        <ProviderMark provider={provider} size={15} />
        <span className="text-base font-medium text-fg">{NAME[provider]}</span>
        {usage?.plan && <span className="min-w-0 truncate text-small text-dim">{usage.plan}</span>}
        <span className="ml-auto">
          <IconButton title={`Refresh ${NAME[provider]} usage`} onClick={() => start()} className="-mr-1 text-faint">
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
            <UsageRow key={w.id} w={w} now={now} binding={w.id === binding} />
          ))}
          {meter && (
            <UsageRow
              now={now}
              w={{
                id: "extra_usage",
                label: "Extra usage this month",
                kind: "credits",
                used_percent: meter.used_percent,
                resets_ms: null,
                window_minutes: null,
                model: null,
                severity: null,
                binding: null,
                as_of_ms: usage.fetched_ms,
                detail: meter.detail ?? creditLine(meter),
              }}
            />
          )}
          {credit && <div className="pt-1 text-small text-dim">Extra usage: {credit}</div>}
          {full && provider === "claude" && hasWindows && (
            <div className="mt-1.5 border-t border-hairline pt-2 text-small text-dim" data-usage-claude-no-reset>
              Claude has no manual reset; each limit resets on its own at the time shown.
            </div>
          )}
          {full && provider === "codex" && usage.reset_credits !== null ? (
            <ResetCredits usage={usage} now={now} onDone={() => start(false)} />
          ) : (
            !!usage.reset_credits &&
            usage.reset_credits > 0 && (
              <div className="pt-1 text-small text-dim">
                {usage.reset_credits} free {usage.reset_credits === 1 ? "reset" : "resets"} available
              </div>
            )
          )}
          <RefreshNote st={st} usage={usage} now={now} />
        </>
      )}
    </section>
  );
}

type Redeem =
  | { state: "idle" }
  | { state: "confirm"; key: string; error?: string }
  | { state: "busy"; key: string }
  | { state: "done"; outcome: ResetOutcome; left: number };

const OUTCOME: Record<ResetOutcome, (left: number) => string> = {
  reset: (left) => `Limits reset. ${left === 0 ? "No free resets left." : `${left} free ${left === 1 ? "reset" : "resets"} left.`}`,
  nothing_to_reset: () => "Nothing to reset right now, so no reset was used.",
  no_credit: () => "This account has no free resets left.",
  already_redeemed: () => "That reset already went through; no second one was used.",
};

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `coool-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * Codex reset credits (CHAT_SPEC "Reset credits"): the count, the soonest expiry, and "Use a reset", which asks first.
 * One idempotency key per attempt; a retry after an error reuses it, so it can never spend two credits.
 */
function ResetCredits({ usage, now, onDone }: { usage: PlanUsage; now: number; onDone: () => void }) {
  const [r, setR] = useState<Redeem>({ state: "idle" });
  const n = usage.reset_credits ?? 0;
  const used = usage.windows.filter((w) => w.used_percent !== null && w.kind !== "spend");
  const idle = used.length > 0 && used.every((w) => w.used_percent === 0);
  const redeem = async (key: string) => {
    setR({ state: "busy", key });
    try {
      const outcome = await usageResetCodex(key);
      setR({ state: "done", outcome, left: outcome === "reset" ? Math.max(0, n - 1) : n });
      onDone();
    } catch (e) {
      setR({ state: "confirm", key, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const open = r.state === "confirm" || r.state === "busy";
  return (
    <div className="mt-1.5 border-t border-hairline pt-2" data-usage-resets={n}>
      <div className="flex min-h-[34px] items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-base text-fg/90">{n === 0 ? "No free resets" : `${n} free ${n === 1 ? "reset" : "resets"} available`}</div>
          <div className="text-small text-dim">
            {n === 0
              ? "Your limits reset on their own at the times above."
              : `Each one resets the 5-hour and weekly limits to 0%${usage.reset_credits_expire_ms ? ` · next one expires ${whenText(usage.reset_credits_expire_ms, now)}` : ""}`}
          </div>
        </div>
        {n > 0 && !open && (
          <Button variant="outline" data-usage-reset-open onClick={() => setR({ state: "confirm", key: newKey() })}>
            Use a reset
          </Button>
        )}
      </div>
      {open && (
        <div className="mb-1 mt-2 overflow-hidden rounded-[10px] border border-line bg-panel/60" role="alertdialog" aria-label="Use a Codex reset" data-usage-reset-confirm>
          <div className="px-3 pb-2.5 pt-3">
            <div className="text-base font-medium text-fg">Reset your Codex limits now?</div>
            <div className="mt-1 text-small text-dim">
              This uses 1 of your {n} free {n === 1 ? "reset" : "resets"} ({n - 1} will remain). Your 5-hour and weekly Codex limits go back to 0% and start over
              from now. It can't be undone.
              {idle && " Nothing is used right now, so Codex may decline and keep the reset."}
            </div>
            {r.state === "confirm" && r.error && (
              <div className="mt-2 text-small text-err-text" data-usage-reset-error>
                Couldn't reset: {r.error}. Trying again is safe; it won't use a second reset.
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-hairline px-3 py-2">
            <Button variant="ghost" disabled={r.state === "busy"} onClick={() => setR({ state: "idle" })}>
              Cancel
            </Button>
            <Button variant="primary" disabled={r.state === "busy"} data-usage-reset-go onClick={() => redeem(r.key)}>
              {r.state === "busy" ? "Resetting…" : r.state === "confirm" && r.error ? "Try again" : "Use 1 reset"}
            </Button>
          </div>
        </div>
      )}
      {r.state === "done" && (
        <div
          className={cx("flex items-center gap-1.5 pt-1 text-small", r.outcome === "reset" || r.outcome === "already_redeemed" ? "text-done-text" : "text-dim")}
          data-usage-reset-result={r.outcome}
        >
          {(r.outcome === "reset" || r.outcome === "already_redeemed") && <ICheck size={13} />}
          {OUTCOME[r.outcome](r.left)}
        </div>
      )}
    </div>
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
