// Standalone demo pages for the browser build: `?ledger=demo` (Ledger with a working
// in-memory undo). Mounted from main.tsx in place of the app.

import { useEffect, useState } from "react";
import { IBell, IGlobe, IFile, IGear } from "./icons";
import { Ledger, type LedgerChange } from "./Ledger";

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

/** Which demo page, if any, `?x=demo` asks for. */
export function demoPage(): "ledger" | null {
  const q = location.search;
  return /[?&]ledger=demo/.test(q) ? "ledger" : null;
}
