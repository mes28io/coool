// What the recording surface on a composer shows at each moment (components/voice/VoiceStrip.tsx draws it). Pure:
// the controller's state and the prefs in, a description out, so every state is unit-tested (surface.test.ts) and
// the browser mock can show each one.
//
//   starting → listening (→ quiet, when the level stays flat) → working → done (text in the composer, Undo)
//                                                                       → nothing (nothing was heard; nothing added)
//   any → error (no model, microphone not allowed, no microphone, anything else), each with the one action that fixes it

export type Mode = "hold" | "toggle" | "click";
export type ErrorKind = "model" | "permission" | "device" | "other";

export interface SurfaceInput {
  phase: "idle" | "starting" | "listening" | "transcribing" | "error";
  mode: Mode;
  secs: number;
  /** Recent levels, 0..1, ~25 a second (newest last). */
  levels: number[];
  error: string | null;
  errorKind: ErrorKind | null;
  /** What happened after the last utterance, while it is still shown. */
  notice: { kind: "done" | "nothing"; why?: string } | null;
  /** "Turkish → English", "Turkish, as spoken"… (see `direction`). */
  direction: string;
  holdLabel: string | null;
  toggleLabel: string | null;
}

export type Action = "done" | "cancel" | "settings" | "privacy" | "undo" | "dismiss";

export interface Surface {
  kind: "hidden" | "starting" | "listening" | "quiet" | "working" | "done" | "nothing" | "error";
  title: string;
  /** A second line: the direction, or what to do next. */
  detail: string;
  /** How to finish, spelled out (listening only). */
  finish: string | null;
  actions: Action[];
  meter: boolean;
  clock: boolean;
}

/** Below this meter value (about -51 dBFS) the microphone counts as hearing nothing. */
export const QUIET_LEVEL = 0.18;
/** How long the level must stay flat before the surface says so. */
export const QUIET_SECS = 2;

/** The level has stayed flat for the last `QUIET_SECS` (levels arrive ~25 a second). */
export function isQuiet(levels: number[], secs: number): boolean {
  const n = Math.round(QUIET_SECS * 25);
  if (secs < QUIET_SECS || levels.length < n) return false;
  return levels.slice(-n).every((l) => l < QUIET_LEVEL);
}

/** "Turkish → English", "Any language → English", "Turkish, as spoken", "As spoken". */
export function direction(task: "translate" | "transcribe", language: string, label: (code: string) => string): string {
  const auto = !language || language === "auto";
  if (task === "translate") return language === "en" ? "English" : `${auto ? "Any language" : label(language)} → English`;
  return auto ? "As spoken, in the language you speak" : `${label(language)}, as spoken`;
}

const NOTHING: Record<string, string> = {
  silence: "There was no speech in the recording.",
  unclear: "What it picked up wasn't clear enough to write down.",
  echo: "It only picked up noise.",
  repetition: "It only picked up noise.",
  boilerplate: "It only picked up noise.",
};

export function surface(s: SurfaceInput): Surface {
  const base = { detail: "", finish: null, actions: [] as Action[], meter: false, clock: false };
  if (s.phase === "starting") return { ...base, kind: "starting", title: "Starting the microphone…", detail: s.direction, actions: ["cancel"] };
  if (s.phase === "listening") {
    const finish =
      s.mode === "hold"
        ? `Release ${s.holdLabel ?? "the key"} to finish`
        : s.mode === "toggle"
          ? `Press ${s.toggleLabel ?? "the shortcut"} or Return to finish`
          : "Click Done or press Return to finish";
    const actions: Action[] = s.mode === "hold" ? ["cancel"] : ["done", "cancel"];
    if (isQuiet(s.levels, s.secs))
      return { ...base, kind: "quiet", title: "coool can't hear anything", detail: "Check the microphone in Settings > Voice.", finish, actions: [...actions, "settings"], meter: true, clock: true };
    return { ...base, kind: "listening", title: "Listening", detail: s.direction, finish, actions, meter: true, clock: true };
  }
  if (s.phase === "transcribing") return { ...base, kind: "working", title: "Turning speech into text…", detail: s.direction, actions: ["cancel"] };
  if (s.phase === "error") {
    const actions: Action[] = s.errorKind === "model" || s.errorKind === "device" ? ["settings", "dismiss"] : s.errorKind === "permission" ? ["privacy", "dismiss"] : ["dismiss"];
    const detail =
      s.errorKind === "model"
        ? "Download one in Settings > Voice (about half a gigabyte, once)."
        : s.errorKind === "permission"
          ? "Allow coool in System Settings > Privacy & Security > Microphone, then try again."
          : s.errorKind === "device"
            ? "Connect one, or choose another input in Settings > Voice."
            : "";
    return { ...base, kind: "error", title: s.error ?? "Voice stopped.", detail, actions };
  }
  if (s.notice?.kind === "nothing") return { ...base, kind: "nothing", title: "coool didn't hear any words, so nothing was added", detail: NOTHING[s.notice.why ?? ""] ?? "", actions: ["dismiss"] };
  if (s.notice?.kind === "done") return { ...base, kind: "done", title: "Added to your message", detail: "Not sent: check it, then send.", actions: ["undo", "dismiss"] };
  return { ...base, kind: "hidden", title: "" };
}

/** What the mic button's tooltip says: what it does, and the keys. */
export function micTitle(ready: boolean, listening: boolean, holdLabel: string | null, toggleLabel: string | null): string {
  if (!ready) return "Voice to prompt: set it up in Settings > Voice";
  if (listening) return "Done: turn what you said into text";
  const keys = [holdLabel ? `hold ${holdLabel}` : null, toggleLabel ? `press ${toggleLabel}` : null].filter(Boolean).join(", or ");
  return `Dictate: click to start${keys ? `, or ${keys}` : ""}`;
}
