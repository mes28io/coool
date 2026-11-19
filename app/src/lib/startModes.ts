// The permission modes a new chat can start in, in plain words, for the onboarding and the New session sheet's
// "Starts on" line. Only the modes that still ask somewhere: bypass / never-ask stay in the composer and Settings >
// General, with their warnings. `cli` is the CLI's own name for the mode, shown beside the words.

import type { Provider } from "./types";

export interface StartMode {
  id: string;
  label: string;
  /** The CLI's own name for it. */
  cli: string;
}

export const START_MODES: Record<Provider, StartMode[]> = {
  claude: [
    { id: "default", label: "Ask me before each change", cli: "default" },
    { id: "acceptEdits", label: "Edit files freely, ask before commands", cli: "acceptEdits" },
    { id: "plan", label: "Plan first, change nothing until I say", cli: "plan" },
  ],
  codex: [
    { id: "untrusted", label: "Ask me before anything that isn’t plainly safe", cli: "untrusted" },
    { id: "on-request", label: "Work on its own, ask when it needs to", cli: "on-request" },
    { id: "on-failure", label: "Run in the sandbox, ask only if something fails", cli: "on-failure" },
  ],
};

/**
 * The CLI the New session sheet starts on: what the caller asked for, else the chosen default (the onboarding,
 * Settings > General), else the folder's last one, else Claude Code; one that isn't installed gives way to one that
 * is (`installed` null: not known yet).
 */
export function startProvider(asked: Provider | undefined, chosen: Provider | null, folder: Provider | undefined, installed: Record<Provider, boolean> | null): Provider {
  if (asked) return asked;
  const p = chosen ?? folder ?? "claude";
  if (!installed || installed[p]) return p;
  const other: Provider = p === "claude" ? "codex" : "claude";
  return installed[other] ? other : p;
}

/** A mode in plain words ("Ask me before each change"), or its own name for one not listed here. */
export function modeWords(p: Provider, id: string | null): string | null {
  if (!id) return null;
  return START_MODES[p].find((m) => m.id === id)?.label ?? id;
}
