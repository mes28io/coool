// The Needs you header's note when this request ended a lid-closed run: the lid hold let the Mac sleep because every
// agent was waiting, and this was the one it named (lid/mod.rs `Code::Waiting`, lib/lid.ts `pausedBy`).

import { pausedBy, pausedText } from "../../lib/lid";
import { useLidLive } from "../../lib/lidLive";
import { IClock } from "../icons";

export function LidPaused({ sessionKey, request }: { sessionKey: string; request: string | null }) {
  const lid = useLidLive(true);
  const st = pausedBy(lid?.stops, sessionKey, request);
  if (!st) return null;
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-small text-busy-text" data-needs-lid-paused={st.at}>
      <IClock size={12} className="shrink-0" />
      <span>{pausedText(st)}</span>
    </div>
  );
}
