// Standalone demo pages for the browser build: `?ledger=demo` (Ledger with a working
// in-memory undo). Mounted from main.tsx in place of the app.

import { useEffect, useState } from "react";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { IBell, IGlobe, IFile, IGear } from "./icons";
import { ThinkingRow } from "./Activity";
import { ThinkingBlock } from "./Chat";
import { Strip } from "./AgentsPanel";
import { Ledger, type LedgerChange } from "./Ledger";
import { PlanCard, type PlanPhase, type PlanStep } from "./PlanCard";

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
  const [done, setDone] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // Card data is rebuilt about once a second in the app: do the same here to prove the word does not follow it.
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!/[?&]row/.test(q)) return;
    const t = setTimeout(() => setDone(true), 5000);
    return () => clearTimeout(t);
  }, [q]);
  if (/[?&]row/.test(q))
    return (
      <div className="min-h-screen bg-bg p-8 text-fg">
        <div className="mx-auto flex max-w-[700px] flex-col gap-4">
          <ThinkingRow since={t0} />
          {/* read-only session cases: estimated start that moves with every refresh, no start at all, a stretch 2 minutes old */}
          <ThinkingRow since={t0 - 120_000 + tick * 1000} approx />
          <ThinkingRow since={null} approx />
          <ThinkingRow since={t0 - 120_000} />
          <div className="w-[320px]">
            <Strip card={{ state: "running", labelTool: null, label: `Churn${tick}`, since: t0 + tick * 40, id: "agent-1" } as never} fresh={{ current: false }} />
          </div>
          <ThinkingRow since={t0} label="Starting claude in coool" orb="connecting" />
          <ThinkingRow since={t0} label="Starting claude in coool" orb="connecting" big />
          <ThinkingBlock item={{ kind: "thinking", key: "t", id: "t", ts: t0, endTs: done ? t0 + 4000 : null, text: "Weighing two ways to do this.\nThe second is simpler.", parent: null }} />
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
export function demoPage(): "ledger" | "plan" | "orbs" | null {
  const q = location.search;
  return /[?&]ledger=demo/.test(q) ? "ledger" : /[?&]plan=demo/.test(q) ? "plan" : /[?&]orbs=demo/.test(q) ? "orbs" : null;
}
