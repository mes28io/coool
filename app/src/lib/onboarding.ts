// Whether the first-run onboarding (components/onboarding/) is on screen, and its "seen" flag, which the backend keeps
// in settings.json next to the other options (`onboarding_seen` / `onboarding_set_seen`). It opens by itself once,
// when the flag is unset; Settings > About and the palette's "Show onboarding again" open it again.

import { create } from "zustand";
import { api, isNotAvailable } from "./backend";

interface OnboardingState {
  open: boolean;
  /** Bumped on every opening, so a re-opened flow starts at its first step. */
  run: number;
}

export const useOnboarding = create<OnboardingState>(() => ({ open: false, run: 0 }));

export function openOnboarding() {
  useOnboarding.setState((s) => ({ open: true, run: s.run + 1 }));
}

/** Closes it and remembers that it was seen (finished or dismissed: either way it doesn't come back by itself). */
export function closeOnboarding() {
  useOnboarding.setState({ open: false });
  void api()
    .onboardingSetSeen(true)
    .catch(() => {});
}

let checked = false;
/** At launch: open it when the flag is unset. A build without the flag (an older backend) never shows it. */
export function maybeOpenOnboarding() {
  if (checked) return;
  checked = true;
  void api()
    .onboardingSeen()
    .then((seen) => {
      if (!seen) openOnboarding();
    })
    .catch((e) => {
      if (!isNotAvailable(e)) console.warn("onboarding flag:", e);
    });
}
