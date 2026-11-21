// Claude Platform (APP_SPEC "Claude Platform"): Claude Code chats billed to an Anthropic API key instead of the
// subscription. The page only ever holds each key's id, name and last four characters; the keys stay in the Keychain.

import { create } from "zustand";
import { api } from "./backend";
import type { PlatformKey, PlatformStatus } from "./types";

/** What the page sends for "the subscription" when the person chose it (null means "the default"). */
export const SUBSCRIPTION = "subscription";

interface PlatformState extends PlatformStatus {
  loaded: boolean;
  load: () => Promise<void>;
}

export const usePlatform = create<PlatformState>((set) => ({
  keys: [],
  folders: {},
  loaded: false,
  load: async () => {
    try {
      const st = await api().platformStatus();
      set({ ...st, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
}));

export const loadPlatform = () => usePlatform.getState().load();

export function keyOf(id: string | null | undefined, keys: PlatformKey[] = usePlatform.getState().keys): PlatformKey | null {
  return id ? (keys.find((k) => k.id === id) ?? null) : null;
}

/** "Work ••9Q2x", "Assist key", or "API key" for one no longer listed. */
export function accountLabel(id: string | null | undefined, keys?: PlatformKey[]): string {
  if (!id || id === SUBSCRIPTION) return "Subscription";
  const k = keyOf(id, keys);
  return k ? k.name : "API key";
}

export function keyTail(k: PlatformKey | null): string {
  return k?.last4 ? `••${k.last4}` : "";
}

/** "$0.42", "<$0.01", "$12.30". */
export function fmtUsd(usd: number): string {
  if (!(usd > 0)) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd < 100 ? usd.toFixed(2) : Math.round(usd).toLocaleString("en-US")}`;
}

/** The folder default that covers `cwd` (itself or the nearest parent), as the backend resolves it. */
export function folderDefault(cwd: string, folders: Record<string, string>): { folder: string; account: string } | null {
  let best: string | null = null;
  for (const f of Object.keys(folders)) if ((cwd === f || cwd.startsWith(f.endsWith("/") ? f : f + "/")) && (!best || f.length > best.length)) best = f;
  return best ? { folder: best, account: folders[best] } : null;
}
