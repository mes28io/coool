// The browser demo's stand-in for the backend's title rule (CHAT_SPEC "Session titles"):
// one session whose title matures a few seconds in, one the person renamed, and renames
// that persist across reloads (localStorage, like coool's titles.json).
import { displayTitle } from "./format";
import type { Provider, Session, SessionName, TitleSource } from "./types";

const KEY = "coool.mock.titles";
/** Starts under its first prompt's subject, then moves to what it turned out to be about. */
const MATURE = { id: "a1f0c2", first: "Claude Code fast mode credits", afterMs: 9000 };
/** Renamed by the person before the demo starts (until they rename it again or go back to automatic). */
const SEEDED: Record<string, string> = { "codex:c7d1e9": "RawLog offset fixes" };

const bootAt = Date.now();
const key = (p: Provider, id: string) => `${p}:${id}`;

const manual: Record<string, string | null> = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
})();
const history: Record<string, string[]> = {};
const shown: Record<string, string> = {};

const remember = (k: string, t: string) => {
  history[k] = [t, ...(history[k] ?? []).filter((x) => x !== t)].slice(0, 5);
};

export function mockName(s: Session): SessionName {
  const k = key(s.provider, s.id);
  let auto = displayTitle({ ...s, name: null, insight: null });
  let source: TitleSource = "first";
  if (s.id === MATURE.id) {
    if (Date.now() - bootAt < MATURE.afterMs) auto = MATURE.first;
    else {
      source = "auto";
      if (!history[k]?.includes(MATURE.first)) remember(k, MATURE.first);
    }
  }
  const m = k in manual ? manual[k] : (SEEDED[k] ?? null);
  if (m && SEEDED[k] && !(k in manual) && !history[k]?.includes(auto)) remember(k, auto);
  const title = m || auto;
  if (shown[k] && shown[k] !== title) remember(k, shown[k]);
  shown[k] = title;
  return { title, source: m ? "manual" : source, previous: (history[k] ?? []).filter((x) => x !== title) };
}

export function mockRename(provider: Provider, id: string, name: string | null) {
  manual[key(provider, id)] = name?.trim() || null;
  try {
    localStorage.setItem(KEY, JSON.stringify(manual));
  } catch {}
}
