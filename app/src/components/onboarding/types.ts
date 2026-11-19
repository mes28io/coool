import type { ComponentType } from "react";
import type { Environment } from "../../lib/types";

/** What the steps choose together (the finish step acts on it). */
export interface Draft {
  /** The folder picked on the first step (absolute), or null. */
  cwd: string | null;
}

/** What every step can see: the shared draft and what coool already knows. */
export interface StepCtx {
  draft: Draft;
  setDraft: (patch: Partial<Draft>) => void;
  /** Which CLIs are on PATH (null until the backend answered). */
  env: Environment | null;
  /** Project folders coool knows from existing CLI sessions, most recent first. */
  projects: string[];
}

export interface StepProps {
  ctx: StepCtx;
  /** Continue to the next step (what Enter does). */
  next: () => void;
}

/** One screen of the onboarding. Steps are data: see steps.tsx. */
export interface StepDef {
  id: string;
  title: string;
  /** One plain line under the title. */
  lead?: string | ((ctx: StepCtx) => string);
  component: ComponentType<StepProps>;
  /** Shown only when this holds (checked each time the step list is built). */
  when?: (ctx: StepCtx) => boolean;
  /** Offers Skip (and Esc skips it). Default true; the finish step says false. */
  canSkip?: boolean;
  /** The primary button's label (default "Continue"). */
  nextLabel?: (ctx: StepCtx) => string;
  /** Runs when the person continues (Enter or the primary button), before moving on. On the last step, the flow closes after it. */
  onNext?: (ctx: StepCtx) => void;
  /** Runs when the person skips this step. */
  onSkip?: (ctx: StepCtx) => void;
}
