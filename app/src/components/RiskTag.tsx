// The "Risky" tag on a permission request (lib/risk.ts): shown only when a fixed rule matches, with the reason on
// hover. There is no "safe" tag, no countdown and no default answer: the person decides, as on every request.

import { useMemo } from "react";
import { riskOf } from "../lib/risk";
import { IAlert } from "./icons";
import { cx } from "./primitives";

export function RiskTag({ tool, input, cwd, className }: { tool: string; input: unknown; cwd: string; className?: string }) {
  const risk = useMemo(() => riskOf(tool, input, cwd), [tool, input, cwd]);
  if (!risk) return null;
  return (
    <span
      className={cx("inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[6px] bg-[color-mix(in_oklab,var(--error)_13%,transparent)] px-1.5 text-small font-medium text-err-text", className)}
      title={risk.reason}
      aria-label={`Risky: ${risk.reason}`}
      data-risk={risk.reason}
    >
      <IAlert size={11} />
      Risky
    </span>
  );
}
