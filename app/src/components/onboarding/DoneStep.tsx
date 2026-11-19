// The finish step: lands the person in the app, in a new session in the chosen folder or on Home.

import { folderName, homeShort } from "../../lib/format";
import { useStore } from "../../store";
import { IFolder } from "../icons";
import { Kbd } from "../primitives";
import type { StepCtx, StepProps } from "./types";

export function DoneStep({ ctx }: StepProps) {
  const { cwd } = ctx.draft;
  return (
    <div className="flex flex-col gap-3 text-small text-dim">
      {cwd && (
        <div className="flex items-center gap-2 rounded-[12px] border border-line bg-panel px-3 py-2.5" data-onb-done-folder>
          <IFolder size={15} className="shrink-0 text-fg" />
          <span className="font-medium text-fg">{folderName(cwd)}</span>
          <span className="min-w-0 truncate font-mono text-mono-small text-faint">{homeShort(cwd)}</span>
        </div>
      )}
      <p className="flex flex-wrap items-center gap-1 px-1">
        Everything here is in Settings too, and <Kbd>⌘</Kbd>
        <Kbd>K</Kbd> finds the rest.
      </p>
    </div>
  );
}

/** Leaves the onboarding for the app: the new-session sheet in the chosen folder, or Home. */
export function finish(ctx: StepCtx) {
  const st = useStore.getState();
  if (st.settings !== null) st.closeSettings();
  if (ctx.draft.cwd) st.setSheet({ kind: "new", cwd: ctx.draft.cwd });
  else st.activate(null);
}
