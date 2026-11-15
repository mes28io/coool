// Standalone demo pages for the browser build: `?ledger=demo` (Ledger with a working
// in-memory undo). Mounted from main.tsx in place of the app.

import { useEffect, useState } from "react";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { IBell, IGlobe, IFile, IGear } from "./icons";
import { ThinkingRow, Timeline } from "./Activity";
import { MOODS, type Mood } from "../lib/activityMood";
import { Strip } from "./AgentsPanel";
import { Ledger, type LedgerChange } from "./Ledger";
import { PlanCard, type PlanPhase, type PlanStep } from "./PlanCard";
import { AgentCube } from "./AgentCube";
import { MoodGlyph, MoodSvg } from "./MoodGlyph";

const m = (n: number) => Date.now() - n * 60_000;

const SEED: LedgerChange[] = [
  { id: "c8", action: "Changed price", object: "Pro plan", before: "$29 / month", after: "$34 / month", ts: m(2), source: "Stripe", icon: IGlobe, undoWith: ["c7"] },
  { id: "c7", action: "Updated copy", object: "Pricing page", detail: "Pro plan card, 2 lines", ts: m(3), source: "Webflow", icon: IFile },
  { id: "c6", action: "Sent", object: "Launch email", detail: "To 1,204 subscribers", ts: m(5), source: "Mailchimp", icon: IBell, reversible: false },
  { id: "c5", action: "Created", object: "Coupon LAUNCH20", detail: "20% off, expires Dec 1", ts: m(8), source: "Stripe", icon: IGlobe },
  { id: "c4", action: "Changed", object: "Webhook endpoint", before: "/hooks/v1", after: "/hooks/v2", ts: m(11), source: "Stripe", icon: IGear, undone: true },
  { id: "c3", action: "Ran", object: "pnpm deploy --prod", detail: "Deployed 3 functions", ts: m(14), source: "Bash", kind: "terminal", reversible: false },
  { id: "c2", action: "Edited", object: "src/pricing.ts", before: "const tier = 1", after: "const tier = 2", ts: m(18), source: "Edit", kind: "file" },
  { id: "c1", action: "Created", object: "docs/plans.md", detail: "42 lines", ts: m(26), source: "Write", kind: "file" },
];

const LATER: Omit<LedgerChange, "id" | "ts">[] = [
  { action: "Changed price", object: "Team plan", before: "$79 / month", after: "$89 / month", source: "Stripe", icon: IGlobe },
  { action: "Archived", object: "Starter plan", detail: "No active subscribers", source: "Stripe", icon: IGlobe },
];

export function LedgerDemo() {
  const [changes, setChanges] = useState(SEED);
  useEffect(() => {
    const ids = LATER.map((_, i) => setTimeout(() => setChanges((c) => [{ ...LATER[i], id: `n${i}`, ts: Date.now() }, ...c]), 2500 + i * 6000));
    return () => ids.forEach(clearTimeout);
  }, []);
  const undo = (id: string) =>
    setChanges((cs) => {
      const ids = new Set([id, ...(cs.find((c) => c.id === id)?.undoWith ?? [])]);
      return cs.map((c) => (ids.has(c.id) ? { ...c, undone: true } : c));
    });
  return (
    <div className="flex min-h-screen items-start justify-center bg-bg px-4 pt-16 text-fg">
      <div className="w-full max-w-[560px]">
        <Ledger changes={changes} title="Pricing agent" onUndo={undo} />
        <div className="mt-3 text-small text-faint">Demo: hover a row to undo it; a new change arrives after a few seconds.</div>
      </div>
    </div>
  );
}

const PLAN_TITLES = ["Read the pricing brief", "Scaffold the pricing page", "Write the plan copy", "Build the comparison table", "Add Stripe checkout"];
const TAGS = ["Read", "Write", "Edit", "Edit", "Bash"];

/** `?plan=demo`: proposed -> running -> failed -> done, on a loop. */
export function PlanDemo() {
  const [t, setT] = useState(0);
  // Script (seconds): 0-3 proposed, then steps run 1.6s each, step 4 fails, pause, rerun to done.
  useEffect(() => {
    const id = setInterval(() => setT((x) => (x + 0.25) % 44), 250);
    return () => clearInterval(id);
  }, []);
  let phase: PlanPhase = "proposed";
  let cur = -1;
  let failAt = -1;
  const run = (sec: number, failStep: number) => {
    const k = Math.floor(sec / 1.6);
    return { k, over: k >= (failStep >= 0 ? failStep + 1 : 5) };
  };
  let started = 0;
  if (t >= 4 && t < 17) {
    const r = run(t - 4, 3);
    cur = Math.min(r.k, 3);
    failAt = r.over ? 3 : -1;
    phase = r.over ? "stopped" : "running";
    started = 4;
  } else if (t >= 17 && t < 22) {
    phase = "stopped";
    cur = 3;
    failAt = 3;
    started = 4;
  } else if (t >= 22 && t < 36) {
    const r = run(t - 22, -1);
    cur = Math.min(r.k, 5);
    phase = r.over ? "done" : "running";
    started = 22;
  } else if (t >= 36) {
    phase = "done";
    cur = 5;
    started = 22;
  }
  const steps: PlanStep[] = PLAN_TITLES.map((title, i) => ({
    title,
    detail: i === 1 ? "pages/pricing.tsx, three plan cards" : undefined,
    tag: TAGS[i],
    status: phase === "proposed" ? "pending" : failAt === i ? "failed" : i < cur ? "done" : i === cur && phase === "running" ? "active" : "pending",
    durationMs: i < cur ? 1400 + i * 300 : undefined,
    error: failAt === i ? "3 of 12 tests failed" : undefined,
  }));
  return (
    <div className="flex min-h-screen items-start justify-center bg-bg px-4 pt-16 text-fg">
      <div className="w-full max-w-[600px]">
        <PlanCard title="Ship the pricing page" steps={steps} phase={phase} startedAt={Date.now() - (t - started) * 1000} endedAt={Date.now()} onApprove={() => setT(4)} onReject={() => setT(0)} />
        <div className="mt-3 text-small text-faint">Demo: cycles proposed, running, failed, done.</div>
      </div>
    </div>
  );
}

const ORB_STATES: OrbState[] = ["working", "searching", "solving", "listening", "connecting", "weaving", "composing", "breathing", "shaping"];

function OrbPanel({ dark, tint }: { dark: boolean; tint?: string }) {
  const bg = dark ? "#212121" : "#ffffff";
  const fg = dark ? "#ececec" : "#0d0d0d";
  return (
    <div className="flex-1 p-5" style={{ background: bg, color: fg }}>
      <div className="mb-3 text-small" style={{ opacity: 0.6 }}>
        {dark ? "dark tuning" : "light tuning"} {tint ? `· tint ${tint}` : "· stock"}
      </div>
      {ORB_STATES.map((st) => (
        <div key={st} className="flex items-center gap-4 py-1">
          <span className="w-24 text-small" style={{ opacity: 0.6 }}>{st}</span>
          <ThinkingOrb state={st} size={64} theme={dark ? "dark" : "light"} color={tint} />
          <span className="flex items-center gap-2.5 text-[14px]">
            <span className="flex size-[22px] items-center justify-center">
              <ThinkingOrb state={st} size={20} theme={dark ? "dark" : "light"} color={tint} />
            </span>
            Pondering the next step
          </span>
        </div>
      ))}
    </div>
  );
}

export function OrbsDemo() {
  const [fps, setFps] = useState("");
  const q = location.search;
  const n = Number(/[?&]n=(\d+)/.exec(q)?.[1] ?? 0);
  const dark = !/[?&]light/.test(q);
  useEffect(() => {
    if (!n) return;
    const dt: number[] = [];
    let last = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      dt.push(t - last);
      last = t;
      if (dt.length >= 300) {
        const s = dt.slice(10).sort((a, b) => a - b);
        setFps(`frame ms avg ${(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2)} p95 ${s[Math.floor(s.length * 0.95)].toFixed(2)} max ${s[s.length - 1].toFixed(2)}`);
        dt.length = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [n]);
  const [t0] = useState(() => Date.now());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (/[?&]ro(&|$)/.test(q)) return <ReadOnlyTour dark={dark} />;
  if (/[?&]row/.test(q))
    return (
      <div className="min-h-screen bg-bg p-8 text-fg">
        <div className="mx-auto flex max-w-[700px] flex-col gap-1">
          {(Object.keys(MOODS) as Mood[]).map((m, k) => (
            <ThinkingRow key={m} since={t0 - (k * 17 + 7) * 1000} mood={m} detail={["think", "plan", "start", "compact", "delegate"].includes(m) ? "" : "cargo test -p core -- --nocapture"} large />
          ))}
          <ThinkingRow since={null} mood="think" large />
          <div className="mt-4 w-[320px]">
            <Strip card={{ state: "running", labelTool: "Bash", label: `Bash cargo test`, since: t0 + tick * 40, id: "agent-1", steps: [] } as never} />
          </div>
          <div className="w-[320px]">
            <Strip card={{ state: "running", labelTool: null, label: `Churn${tick}`, since: t0 + tick * 40, id: "agent-2", steps: [] } as never} />
          </div>
          <ThinkingRow since={t0} label="Starting claude in coool" mood="start" />
          <ThinkingRow since={t0} label="Starting claude in coool" mood="start" big />
        </div>
      </div>
    );
  if (n)
    return (
      <div className="p-5" style={{ background: dark ? "#212121" : "#fff", color: dark ? "#ececec" : "#0d0d0d", minHeight: "100vh" }}>
        <div id="fps">{fps}</div>
        <div className="flex flex-wrap gap-3">
          {Array.from({ length: n }, (_, i) => (
            <ThinkingOrb key={i} state={ORB_STATES[i % 9]} size={20} theme={dark ? "dark" : "light"} />
          ))}
        </div>
      </div>
    );
  return (
    <div className="min-h-screen">
      <div className="flex">
        <OrbPanel dark />
        <OrbPanel dark={false} />
      </div>
      <div className="flex">
        <OrbPanel dark tint="#28c840" />
        <OrbPanel dark={false} tint="#1a7f37" />
      </div>
    </div>
  );
}

/** Which demo page, if any, `?x=demo` asks for. */
export function demoPage(): "ledger" | "plan" | "orbs" | "glyphs" | null {
  const q = location.search;
  return /[?&]ledger=demo/.test(q) ? "ledger" : /[?&]plan=demo/.test(q) ? "plan" : /[?&]orbs=demo/.test(q) ? "orbs" : /[?&]glyphs=demo/.test(q) ? "glyphs" : null;
}

function hhmmss(t: number) {
  return new Date(t).toTimeString().slice(0, 8);
}

/** A read-only session walking through thinking, search, read, edit, shell, subagent, thinking over ~40s, then ending. */
function ReadOnlyTour({ dark }: { dark: boolean }) {
  const [step, setStep] = useState(0);
  const [t0] = useState(() => Date.now());
  const plan = [
    { at: 0, current: "thinking…", add: null as string | null },
    { at: 5, current: "Grep · OutboxQueue", add: "tool|Grep · OutboxQueue" },
    { at: 10, current: "Read · app/src/sync/outbox.ts", add: "tool|Read · app/src/sync/outbox.ts" },
    { at: 15, current: "Edit · app/src/sync/outbox.ts", add: "tool|Edit · app/src/sync/outbox.ts" },
    { at: 20, current: "Bash · cargo test -p core", add: "tool|Bash · cargo test -p core" },
    { at: 25, current: "Agent · Audit the retry path", add: "agent|Agent · Audit the retry path" },
    { at: 32, current: "thinking…", add: null },
    { at: 40, current: null as string | null, add: null },
  ];
  useEffect(() => {
    const t = setInterval(() => setStep(Math.floor((Date.now() - t0) / 1000)), 250);
    return () => clearInterval(t);
  }, [t0]);
  const k = plan.filter((p) => p.at <= step).length - 1;
  const done = k >= plan.length - 1;
  const acts = [{ ts: hhmmss(t0 - 3000), kind: "prompt", text: "Make the outbox retry safe" }, ...plan.slice(0, k + 1).filter((p) => p.add).map((p) => ({ ts: hhmmss(t0 + p.at * 1000), kind: p.add!.split("|")[0], text: p.add!.split("|")[1] }))];
  const session = {
    key: "tour",
    status: done ? "idle" : "busy",
    current: plan[Math.max(0, k)].current,
    updated: Date.now(),
    loaded: true,
    activity: acts,
    agents: plan[k]?.add?.startsWith("agent") ? [{ id: "a1", kind: "general", description: "Audit the retry path", finished: false, current: null, tokens: { input: 0, cached: 0, output: 0, context: 0 }, activity: [], model: "claude-haiku-5-5", models: [] }] : [],
  };
  return (
    <div className="h-screen bg-bg text-fg" style={{ colorScheme: dark ? "dark" : "light" }}>
      <Timeline session={session as never} />
    </div>
  );
}

const MOOD_LIST = Object.keys(MOODS) as Mood[];

function GlyphPanel({ dark }: { dark: boolean }) {
  const bg = dark ? "#212121" : "#ffffff";
  const fg = dark ? "#ececec" : "#0d0d0d";
  const green = dark ? "#28c840" : "#1a7f37";
  const faint = dark ? "#8f8f8f" : "#8f8f8f";
  const [k, setK] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setK((x) => x + 1), 1600);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex-1 p-5" style={{ background: bg, color: fg }} data-glyph-panel={dark ? "dark" : "light"}>
      <div className="mb-2 grid grid-cols-[72px_40px_40px_40px_40px_1fr] items-center gap-y-0 text-small" style={{ opacity: 0.55 }}>
        <span>{dark ? "dark" : "light"}</span>
        <span>13 live</span>
        <span>14 live</span>
        <span>14 still</span>
        <span>faint</span>
        <span>in context</span>
      </div>
      {MOOD_LIST.map((m) => (
        <div key={m} className="grid h-[30px] grid-cols-[72px_40px_40px_40px_40px_1fr] items-center text-[13px]" data-glyph-row={m}>
          <span style={{ opacity: 0.55 }}>{m}</span>
          <span style={{ color: green }} data-cell="13">
            <MoodSvg mood={m} size={13} />
          </span>
          <span style={{ color: green }} data-cell="14">
            <MoodSvg mood={m} size={14} />
          </span>
          <span style={{ color: green }} data-cell="still">
            <MoodSvg mood={m} size={14} live={false} />
          </span>
          <span style={{ color: faint }} data-cell="faint">
            <MoodSvg mood={m} size={12} live={false} />
          </span>
          <span className="flex items-center gap-2">
            <span style={{ color: green }} className="flex">
              <MoodSvg mood={m} size={14} />
            </span>
            <span className="font-medium">{MOODS[m].words[0]}...</span>
            <span className="ml-3 flex items-center gap-2" style={{ opacity: 0.9 }}>
              <ThinkingOrb state={MOODS[m].orb} size={20} theme={dark ? "dark" : "light"} />
              <span style={{ opacity: 0.55 }}>orb (main agent)</span>
            </span>
          </span>
        </div>
      ))}
      <div className="mt-4 flex items-center gap-4 text-small" data-cube-row>
        <span style={{ opacity: 0.55 }} className="w-[72px]">cube</span>
        {(["live", "done", "failed", "stopped"] as const).map((st) => (
          <span key={st} className="flex items-center gap-1.5" style={{ color: st === "live" ? green : st === "failed" ? "#ff6b6b" : faint }}>
            <AgentCube size={14} state={st} className="!text-current" />
            <span style={{ opacity: 0.6 }}>{st}</span>
          </span>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 text-[13px]" data-glyph-fade>
        <span style={{ opacity: 0.55 }} className="w-[72px]">cross-fade</span>
        <span style={{ color: green }} className="flex">
          <MoodGlyph mood={MOOD_LIST[k % MOOD_LIST.length]} size={14} />
        </span>
        <span className="font-medium">{MOODS[MOOD_LIST[k % MOOD_LIST.length]].words[0]}</span>
      </div>
    </div>
  );
}

/** `?glyphs=demo`: the subagent mood glyphs at real size, live and still, dark and light, next to the orbs. */
export function GlyphsDemo() {
  return (
    <div className="flex min-h-screen">
      <GlyphPanel dark />
      <GlyphPanel dark={false} />
    </div>
  );
}
