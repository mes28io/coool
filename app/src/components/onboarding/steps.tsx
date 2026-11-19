// The onboarding's screens, in order. Steps are data: to add a screen, write one component (`StepProps`, in this
// folder) and add one entry here. `when` hides a step that doesn't apply, `canSkip: false` removes its Skip button,
// `onNext` / `onSkip` act on the shared draft (types.ts). Onboarding.tsx draws whatever this list holds: the step
// indicator, Back / Skip / Continue, Enter and Esc, focus and the transitions. See docs/APP_SPEC.md "Onboarding".
// Steps that apply choices as they are clicked put them back on Skip (keep.ts).

import { folderName } from "../../lib/format";
import { AgentsStep, skipAgents } from "./AgentsStep";
import { BuildStep, commitBuild } from "./BuildStep";
import { DoneStep, finish } from "./DoneStep";
import { FolderStep } from "./FolderStep";
import { LookStep, skipLook } from "./LookStep";
import { NotifyStep, skipNotify } from "./NotifyStep";
import type { StepDef } from "./types";

export const STEPS: StepDef[] = [
  {
    id: "look",
    title: "Make it yours",
    lead: "Pick how coool looks. It changes as you click.",
    component: LookStep,
    onSkip: skipLook,
  },
  {
    id: "folder",
    title: "Where do you want to start?",
    lead: "Pick a project folder. coool runs Claude Code or Codex there, signed in with your own account.",
    component: FolderStep,
    onSkip: (c) => c.setDraft({ cwd: null }),
  },
  {
    id: "build",
    title: "What are you building?",
    lead: "Pick any that apply. coool sets up the devices your agents will need, and nothing you don’t tick.",
    component: BuildStep,
    onNext: commitBuild,
  },
  {
    id: "agents",
    title: "How should your agents work?",
    lead: "What every new chat starts with. Any chat can still change it.",
    component: AgentsStep,
    onSkip: skipAgents,
  },
  {
    id: "notifications",
    title: "Hear from your agents",
    lead: "coool tells you when an agent needs you, so you can look away while it works.",
    component: NotifyStep,
    onSkip: skipNotify,
  },
  {
    id: "done",
    title: "You’re set",
    lead: (c) => (c.draft.cwd ? `Start your first session in ${folderName(c.draft.cwd)}.` : "Home shows every agent you run, in coool and in your terminal."),
    component: DoneStep,
    canSkip: false,
    nextLabel: (c) => (c.draft.cwd ? "Start a session" : "Go to Home"),
    onNext: finish,
  },
];
