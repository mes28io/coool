// What a step's Skip puts back. A step that applies its choices as they are clicked (the look, the new-chat defaults,
// notifications) remembers, the first time it shows in this run of the onboarding, how to restore what was there;
// its `onSkip` restores it, so Skip leaves everything as it was however much was tried on the way.

import { useState } from "react";
import { useOnboarding } from "../../lib/onboarding";

const saved = new Map<string, () => void>();
let forRun = -1;

/** Remember `restore` for `step`, once per run (coming Back to a step keeps the first one). */
export function useRestorePoint(step: string, take: () => () => void) {
  // Taken once, as the step first renders, before anything on it can be clicked (idempotent: a second render or
  // StrictMode's double call finds it saved).
  useState(() => {
    const run = useOnboarding.getState().run;
    if (run !== forRun) {
      saved.clear();
      forRun = run;
    }
    if (!saved.has(step)) saved.set(step, take());
    return null;
  });
}

/** Put back what `step` found when it first showed (its Skip). */
export function restoreStep(step: string) {
  if (forRun !== useOnboarding.getState().run) return;
  saved.get(step)?.();
}
