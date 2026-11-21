// Ladder's settings and launch (APP_SPEC "Ladder"): the default for new chats (Settings > Ladder, the onboarding), a
// per-chat override (the composer's Ladder chip), and what each running chat was really launched with. The tier
// table and the tally are lib/ladderTiers.ts; the policy text is crates/core/src/ladder.

import { useSyncExternalStore } from "react";
import { chatDefaultsIgnored, getChatDefaults, useSeenModels } from "./prefs";
import { crossTable, imageLane, sameTier, tierTable, type LadderCap, type LadderOptions, type LadderRole, type LadderTier, type ModelChoice } from "./ladderTiers";
import { modelLabel } from "./models";
import type { Provider } from "./types";

export { LADDER, LADDER_LINE } from "./ladderTiers";

export interface LadderPrefs {
  /** New chats start with it (the owner's call: on). */
  on: boolean;
  maxParallel: number;
  /** Delegates that change code run the project's test command before they report. */
  verifyTests: boolean;
  cap: Record<Provider, LadderCap>;
  /** A model chosen per role (null: automatic, from what the CLI offers). */
  pick: Record<Provider, Partial<Record<LadderRole, string | null>>>;
  /** The lead's own model as a tier, for parallel medium-high pieces (the owner's call: on). */
  same: boolean;
  /** The other CLI's lanes (`codex exec` from Claude, `claude -p` from Codex) when it is installed. */
  cross: boolean;
  /** Image generation through Codex's built-in image tool. */
  image: boolean;
  /** Helper nesting depth (1: helpers start none). */
  depth: number;
  swarm: boolean;
  /** coool's tools: `budget`, `can`, `spawn` (helpers as visible chats). */
  tools: boolean;
  /** Percent of every usage window kept back from helpers and lanes. */
  reserve: number;
  /** A chat in Bypass may start helpers in Bypass (off: they run in Accept edits). */
  bypassHelpers: boolean;
}

/** A chat's own choice, over the defaults (only what it changed). */
export interface ChatLadder {
  on?: boolean;
  cap?: LadderCap;
  maxParallel?: number;
  depth?: number;
  cross?: boolean;
  image?: boolean;
  swarm?: boolean;
  /** Settings for a self-test or a script (not shown in the chip). */
  reserve?: number;
}

const PREFS_KEY = "coool.ladder";
const CHATS_KEY = "coool.ladder.chats";
export const LADDER_DEFAULTS: LadderPrefs = {
  on: true,
  maxParallel: 4,
  verifyTests: true,
  cap: { claude: "mid", codex: "mid" },
  pick: { claude: {}, codex: {} },
  same: true,
  cross: true,
  image: true,
  depth: 2,
  swarm: true,
  tools: true,
  reserve: 10,
  bypassHelpers: false,
};
export const DEPTHS = [1, 2, 3];
export const RESERVES = [0, 10, 20, 30, 50];
export const MAX_PARALLEL = [1, 2, 3, 4, 6, 8];

function read<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? ({ ...d, ...JSON.parse(v) } as T) : d;
  } catch {
    return d;
  }
}
function write(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode: lasts for this window */
  }
}

function box<T>(get0: () => T, save: (v: T) => void) {
  let v = get0();
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set(n: T) {
      v = n;
      save(v);
      subs.forEach((f) => f());
    },
    use: () =>
      useSyncExternalStore(
        (f) => (subs.add(f), () => subs.delete(f)),
        () => v,
      ),
  };
}

const prefs = box<LadderPrefs>(
  () => read(PREFS_KEY, LADDER_DEFAULTS),
  (v) => write(PREFS_KEY, v),
);
export const useLadderPrefs = prefs.use;
export const ladderPrefsNow = prefs.get;
export function setLadderPrefs(patch: Partial<LadderPrefs>) {
  prefs.set({ ...prefs.get(), ...patch });
}
export function setLadderPick(p: Provider, role: LadderRole, model: string | null) {
  const cur = prefs.get();
  setLadderPrefs({ pick: { ...cur.pick, [p]: { ...cur.pick[p], [role]: model } } });
}
export function setLadderCap(p: Provider, cap: LadderCap) {
  const cur = prefs.get();
  setLadderPrefs({ cap: { ...cur.cap, [p]: cap } });
}

/** Per-session choices (`claude:<session id>`), so a resumed chat keeps its own. */
const chats = box<Record<string, ChatLadder>>(
  () => read(CHATS_KEY, {} as Record<string, ChatLadder>),
  (v) => write(CHATS_KEY, v),
);
/** Per open chat (by chat id) until its session id is known. */
const open = box<Record<number, ChatLadder>>(
  () => ({}),
  () => {},
);
/** What each running chat was launched with (null: off), for "applies when the chat next starts" and the tiers. */
const launched = box<Record<number, LadderOptions | null>>(
  () => ({}),
  () => {},
);

const sessionKey = (p: Provider, sid: string) => `${p}:${sid}`;

export function chatLadderOf(chat: { id: number; provider: Provider; sessionId: string | null }): ChatLadder {
  return { ...(chat.sessionId ? chats.get()[sessionKey(chat.provider, chat.sessionId)] : undefined), ...open.get()[chat.id] };
}
export function useChatLadder(chat: { id: number; provider: Provider; sessionId: string | null }): ChatLadder {
  const a = chats.use();
  const b = open.use();
  return { ...(chat.sessionId ? a[sessionKey(chat.provider, chat.sessionId)] : undefined), ...b[chat.id] };
}
export function setChatLadder(chat: { id: number; provider: Provider; sessionId: string | null }, patch: ChatLadder) {
  open.set({ ...open.get(), [chat.id]: { ...open.get()[chat.id], ...patch } });
  if (chat.sessionId) {
    const k = sessionKey(chat.provider, chat.sessionId);
    const all = chats.get();
    // Keep the list short: the newest 200 sessions.
    const next = { ...all, [k]: { ...all[k], ...patch } };
    const keys = Object.keys(next);
    if (keys.length > 200) for (const old of keys.slice(0, keys.length - 200)) delete next[old];
    chats.set(next);
  }
}

export const useLaunchedLadder = (id: number): LadderOptions | null | undefined => launched.use()[id];
export const launchedLadderNow = (id: number): LadderOptions | null | undefined => launched.get()[id];
export function noteLaunched(id: number, o: LadderOptions | null) {
  launched.set({ ...launched.get(), [id]: o });
}

// ---------- the CLIs as the backend reads them (ladder_status) ----------

export interface CliStatus {
  installed: boolean;
  version: string | null;
  logged_in: boolean | null;
}
export interface LadderStatus {
  claude: CliStatus;
  codex: CliStatus;
  image: { version: string | null; available: boolean | null };
  codex_models: ModelChoice[];
  checked_ms: number;
}
const status = box<LadderStatus | null>(
  () => null,
  () => {},
);
export const useLadderStatus = status.use;
export const ladderStatusNow = status.get;
export function setLadderStatus(s: LadderStatus | null) {
  status.set(s);
}

/** Whether a chat about to start has it on: its own choice, else the default (off during a self-test run). */
export const ladderOn = (own: ChatLadder | undefined, p: LadderPrefs = prefs.get()) => own?.on ?? (chatDefaultsIgnored() ? false : p.on);

/**
 * `ChatOptions.ladder` for a chat about to start on `lead` (null: the CLI's default model): null when off; else the
 * tier table from the models each CLI reported, capped and picked as the chat and Settings say: the lead's own model
 * as `same` (when on), the cheaper tiers, the other CLI's lanes (when it is installed and on) and the image lane.
 */
export function ladderOptions(provider: Provider, lead: string | null, seen: Record<Provider, ModelChoice[]>, own?: ChatLadder, p: LadderPrefs = prefs.get(), st: LadderStatus | null = status.get()): LadderOptions | null {
  if (!ladderOn(own, p)) return null;
  const mine = seen[provider] ?? [];
  const tiers: LadderTier[] = tierTable(provider, lead, mine, { cap: own?.cap ?? p.cap[provider], pick: p.pick[provider] });
  const same = p.same ? sameTier(provider, lead, mine) : null;
  if (same && tiers.length) tiers.unshift(same);
  const other: Provider = provider === "claude" ? "codex" : "claude";
  // The other CLI counts once the backend says it is installed (or, before it answered, once it reported models).
  const otherOk = st ? st[other].installed && st[other].logged_in !== false : (seen[other] ?? []).length > 0;
  const otherSeen = other === "codex" ? (seen.codex?.length ? seen.codex : (st?.codex_models ?? [])) : (seen.claude ?? []);
  const cross = (own?.cross ?? p.cross) && otherOk ? crossTable(provider, lead, other === "claude" && !otherSeen.length ? [] : otherSeen) : [];
  const codexOk = provider === "codex" || otherOk;
  const imageOn = (own?.image ?? p.image) && codexOk && st?.image.available !== false;
  const image = imageOn ? imageLane(provider, lead, provider === "codex" ? mine : otherSeen) : null;
  return {
    lead: lead ? (mine.find((m) => m.id === lead)?.label || modelLabel(lead)) : "",
    tiers,
    cross,
    image,
    max_parallel: own?.maxParallel ?? p.maxParallel,
    verify_tests: p.verifyTests,
    depth: own?.depth ?? p.depth,
    swarm: own?.swarm ?? p.swarm,
    tools: p.tools,
    reserve: own?.reserve ?? p.reserve,
    bypass_helpers: p.bypassHelpers,
  };
}

/** The same, for a component: re-renders when the defaults, the reported models or the CLIs' status change. */
export function useLadderPreview(provider: Provider, lead: string | null, own?: ChatLadder): LadderOptions | null {
  const p = useLadderPrefs();
  const seen = useSeenModels();
  const st = useLadderStatus();
  return ladderOptions(provider, lead, seen, own, p, st);
}

/** The lead a new chat will run on when the caller did not choose: Settings > General's default. */
export const defaultLead = (provider: Provider) => getChatDefaults()[provider].model;

/** Two launches are the same Ladder setup (to say whether a change waits for the next start). */
export function sameLadder(a: LadderOptions | null | undefined, b: LadderOptions | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
