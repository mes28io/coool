// Ladder's budget picture (the composer chip and Settings > Ladder): per account its plan, the fullest usage window
// and when it resets, whether the CLI is installed and logged in, and whether image generation is available. The
// same numbers the lead reads with the `budget` tool. Plain data the app already holds: nothing is fetched here.

import { useClock } from "../lib/clock";
import { useLadderStatus } from "../lib/ladder";
import { budgetLine } from "../lib/ladderTiers";
import type { Provider } from "../lib/types";
import { useStore } from "../store";
import { ProviderMark } from "./primitives";

const NAME: Record<Provider, string> = { claude: "Claude", codex: "Codex" };

export function LadderBudget({ reserve, compact }: { reserve: number; compact?: boolean }) {
  const usage = useStore((s) => s.usage);
  const st = useLadderStatus();
  // Reset times in minutes: re-rendered once a minute at most.
  const now = useClock((n) => Math.floor(n / 60_000) * 60_000);
  return (
    <div className="flex flex-col gap-1" data-ladder-budget>
      {(["claude", "codex"] as Provider[]).map((p) => {
        const cli = st?.[p];
        const line = budgetLine(usage[p], reserve, now, cli ? { installed: cli.installed, loggedIn: cli.logged_in } : null);
        return (
          <div key={p} className="flex items-baseline gap-2 text-small" data-ladder-budget-row={p} data-tight={line.tight ? "1" : undefined}>
            <span className="flex w-[64px] shrink-0 items-center gap-1 text-dim">
              <ProviderMark provider={p} size={11} /> {NAME[p]}
            </span>
            <span className={line.tight ? "text-fg" : "text-dim"}>{line.text}</span>
          </div>
        );
      })}
      {!compact && (
        <div className="text-small text-faint" data-ladder-image-status>
          Images: {st == null ? "not checked yet" : st.image.available ? `Codex ${st.image.version ?? ""} has its image tool` : st.codex.installed ? "this Codex has no image tool" : "needs Codex"}
        </div>
      )}
    </div>
  );
}
