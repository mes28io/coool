// Settings that live in the UI (localStorage, like the theme): the defaults for new chats and the text size; and
// `useAppPrefs`, the backend-applied ones (confirm quit, prevent sleep, notifications, open with), loaded once and
// shared by every Settings section.

import { useEffect, useSyncExternalStore } from "react";
import { api } from "./backend";
import type { AppPrefs, InstalledApp } from "./settingsTypes";
import type { Provider } from "./types";

// ---------- a tiny external store ----------

function store<T>(read: () => T, write: (v: T) => void) {
  let v = read();
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set(next: T) {
      v = next;
      write(v);
      subs.forEach((f) => f());
    },
    use: () =>
      useSyncExternalStore(
        (f) => (subs.add(f), () => subs.delete(f)),
        () => v,
      ),
  };
}

const readJson = <T>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? { ...d, ...JSON.parse(v) } : d;
  } catch {
    return d;
  }
};
const writeJson = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode: lasts for this window */
  }
};

// ---------- new chat defaults ----------

/** Per provider: the `--model` and permission mode a new chat starts with (null: the CLI's own default). */
export type ChatDefaults = Record<Provider, { model: string | null; mode: string | null }>;
const DEFAULTS_KEY = "coool.chatDefaults";
const chatDefaults = store<ChatDefaults>(
  () => readJson(DEFAULTS_KEY, { claude: { model: null, mode: null }, codex: { model: null, mode: null } }),
  (v) => writeJson(DEFAULTS_KEY, v),
);
let ignored = false;
const NONE: ChatDefaults = { claude: { model: null, mode: null }, codex: { model: null, mode: null } };
/** The defaults new chats start with (none during a self-test, see `ignoreChatDefaults`). */
export const getChatDefaults = () => (ignored ? NONE : chatDefaults.get());
/** The self-test's chats start as its steps say, whatever the person chose (`false`: a scenario that tests the defaults). */
export const ignoreChatDefaults = (on = true) => (ignored = on);
export const useChatDefaults = chatDefaults.use;
export const chatDefaultsNow = chatDefaults.get;
export function setChatDefault(p: Provider, patch: Partial<ChatDefaults[Provider]>) {
  const cur = chatDefaults.get();
  chatDefaults.set({ ...cur, [p]: { ...cur[p], ...patch } });
}
/** Puts back a whole set of defaults (the onboarding's Skip). */
export const restoreChatDefaults = (d: ChatDefaults) => chatDefaults.set(d);

/** Which CLI a new session starts with when nothing else says (the onboarding, Settings > General); null: not chosen. */
const CLI_KEY = "coool.defaultCli";
const defaultCli = store<Provider | null>(
  () => {
    try {
      const v = localStorage.getItem(CLI_KEY);
      return v === "claude" || v === "codex" ? v : null;
    } catch {
      return null;
    }
  },
  (v) => {
    try {
      if (v) localStorage.setItem(CLI_KEY, v);
      else localStorage.removeItem(CLI_KEY);
    } catch {
      /* private mode: lasts for this window */
    }
  },
);
/** The chosen CLI for new sessions (none during a self-test, like the other defaults). */
export const getDefaultCli = () => (ignored ? null : defaultCli.get());
export const defaultCliNow = defaultCli.get;
export const useDefaultCli = defaultCli.use;
export const setDefaultCli = defaultCli.set;

/** Models a provider's chats reported (`ready.models`), remembered so the default can be picked before a chat runs. */
const SEEN_KEY = "coool.seenModels";
const seenModels = store<Record<Provider, { id: string; label: string }[]>>(
  () => readJson(SEEN_KEY, { claude: [], codex: [] }),
  (v) => writeJson(SEEN_KEY, v),
);
export const useSeenModels = seenModels.use;
export function rememberModels(p: Provider, list: { id: string; label?: string | null }[]) {
  if (!list.length) return;
  const cur = seenModels.get();
  const next = list.map((m) => ({ id: m.id, label: m.label || m.id }));
  if (JSON.stringify(cur[p]) === JSON.stringify(next)) return;
  seenModels.set({ ...cur, [p]: next });
}

// ---------- text size ----------

export type TextSize = "small" | "default" | "large" | "larger";
export const TEXT_SCALE: Record<TextSize, number> = { small: 0.93, default: 1, large: 1.07, larger: 1.14 };
const TEXT_KEY = "coool.textSize";
const applyText = (t: TextSize) => {
  if (typeof document !== "undefined") document.documentElement.style.setProperty("--text-scale", String(TEXT_SCALE[t]));
};
const textSize = store<TextSize>(
  () => {
    try {
      const v = localStorage.getItem(TEXT_KEY) as TextSize | null;
      return v && v in TEXT_SCALE ? v : "default";
    } catch {
      return "default";
    }
  },
  (v) => {
    applyText(v);
    try {
      if (v === "default") localStorage.removeItem(TEXT_KEY);
      else localStorage.setItem(TEXT_KEY, v);
    } catch {}
  },
);
applyText(textSize.get());
export const useTextSize = textSize.use;
export const setTextSize = textSize.set;
export const textSizeNow = textSize.get;

// ---------- backend-applied ----------

const appPrefs = store<AppPrefs | null>(
  () => null,
  () => {},
);
let loading: Promise<void> | null = null;
let unavailable = false;

/** The backend's options (null until loaded, or when this build has none), and a setter that saves at once. */
export function useAppPrefs(): [AppPrefs | null, (patch: Partial<AppPrefs>) => Promise<void>, boolean] {
  const v = appPrefs.use();
  useEffect(() => {
    if (appPrefs.get() || loading) return;
    loading = api()
      .prefsGet()
      .then((p) => appPrefs.set(p))
      .catch(() => {
        unavailable = true;
        appPrefs.set(null);
      });
  }, []);
  return [v, updateAppPrefs, unavailable];
}

export async function updateAppPrefs(patch: Partial<AppPrefs>) {
  const cur = appPrefs.get();
  if (!cur) return;
  const next = { ...cur, ...patch, notify: { ...cur.notify, ...patch.notify } };
  appPrefs.set(next);
  try {
    await api().prefsSet(next);
  } catch (e) {
    appPrefs.set(cur);
    throw e;
  }
}

/** The app files and folders open in (General), for labels like "Open in Cursor". */
export const openWithId = () => appPrefs.get()?.open_with ?? "system";
export async function loadAppPrefs() {
  if (appPrefs.get()) return appPrefs.get();
  try {
    appPrefs.set(await api().prefsGet());
  } catch {
    /* not in this build */
  }
  return appPrefs.get();
}

// ---------- open with ----------

const apps = store<InstalledApp[] | null>(
  () => null,
  () => {},
);
let appsLoading = false;
/** The editors and terminals found on this Mac (General's "Open files and folders in"), loaded once. */
export function useInstalledApps(): InstalledApp[] | null {
  const v = apps.use();
  useEffect(() => {
    if (apps.get() || appsLoading) return;
    appsLoading = true;
    api()
      .appsInstalled()
      .then((a) => apps.set(a))
      .catch(() => apps.set([]));
  }, []);
  return v;
}

/** "Cursor", or "Finder" when files and folders open with the system default (a folder opens in Finder). */
export function useOpenWithName(): string {
  const [p] = useAppPrefs();
  const list = useInstalledApps();
  const id = p?.open_with ?? "system";
  return list?.find((a) => a.id === id)?.name ?? "Finder";
}
