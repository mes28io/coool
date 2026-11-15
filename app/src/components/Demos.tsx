// Standalone demo pages for the browser build: `?ledger=demo` (Ledger with a working
// in-memory undo). Mounted from main.tsx in place of the app.

import { useEffect, useState } from "react";
import { IBell, IGlobe, IFile, IGear } from "./icons";
import { MOODS, type Mood } from "../lib/activityMood";
import { Ledger, type LedgerChange } from "./Ledger";
import { PlanCard, type PlanPhase, type PlanStep } from "./PlanCard";
import { AgentMark } from "./AgentMark";
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


/** Which demo page, if any, `?x=demo` asks for. */
export function demoPage(): "ledger" | "plan" | "glyphs" | null {
  const q = location.search;
  return /[?&]ledger=demo/.test(q) ? "ledger" : /[?&]plan=demo/.test(q) ? "plan" : /[?&]glyphs=demo/.test(q) ? "glyphs" : null;
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
          </span>
        </div>
      ))}
      <div className="mt-4 flex items-center gap-4 text-small" data-cube-row>
        <span style={{ opacity: 0.55 }} className="w-[72px]">cube</span>
        {(["live", "done", "failed", "stopped"] as const).map((st) => (
          <span key={st} className="flex items-center gap-1.5" style={{ color: st === "live" ? green : st === "failed" ? "#ff6b6b" : faint }}>
            <AgentMark size={14} state={st} className="!text-current" />
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

/** `?glyphs=demo`: the subagent mood glyphs at real size, live and still, dark and light */
export function GlyphsDemo() {
  return (
    <div className="flex min-h-screen">
      <GlyphPanel dark />
      <GlyphPanel dark={false} />
    </div>
  );
}
