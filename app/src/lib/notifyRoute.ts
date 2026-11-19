// Where a click on one of coool's macOS notifications goes (APP_SPEC "Notifications"). The backend's notification
// delegate (notify.rs) keeps the click as a route and pings `notify-open`; this takes it (`notify_take`, also once at
// boot, for a click that launched coool) and opens:
// - "needs you" (a permission request, a question, a plan to approve): the Needs you page with that session picked,
//   while it still waits; once answered (or gone from the list), its chat instead, never an empty page;
// - "finished" / "failed": that chat;
// - anything else (the Settings test, a notification of an older build): nothing more, coool just comes forward.
// `destination` is pure (unit-tested in notifyRoute.test.ts); `useNotifyClicks` runs it against the store.

import { useEffect, useRef } from "react";

/** A click as the backend hands it over (notify.rs `Route`). */
export interface NotifyClick {
  kind: string;
  /** coool's chat id, only when the notification was posted by this run of coool. */
  chat: number | null;
  /** `claude:<session id>`. */
  session: string | null;
  request: string | null;
  action: string;
}

export type Destination = { to: "needs"; key: string } | { to: "session"; key: string } | { to: "chat"; id: number } | { to: "app" };

export interface RouteContext {
  /** The sessions the app lists: key and the coool chat driving it. */
  sessions: { key: string; chat: number | null }[];
  /** The Needs you page's items (session keys). */
  needs: string[];
  /** coool chats this run knows. */
  chats: number[];
}

export function destination(c: NotifyClick, ctx: RouteContext): Destination {
  const byKey = c.session ? ctx.sessions.find((s) => s.key === c.session) : undefined;
  const byChat = c.chat != null ? ctx.sessions.find((s) => s.chat === c.chat) : undefined;
  const key = (byKey ?? byChat)?.key ?? null;
  const chatKnown = c.chat != null && ctx.chats.includes(c.chat);
  if (c.kind !== "needs" && c.kind !== "finished" && c.kind !== "failed") return { to: "app" };
  if (c.kind === "needs" && key && ctx.needs.includes(key)) return { to: "needs", key };
  if (key) return { to: "session", key };
  if (chatKnown) return { to: "chat", id: c.chat! };
  return { to: "app" };
}

/** Whether the app has what `destination` needs to decide (sessions loaded, and the session it names, if listed yet). */
export function canDecide(c: NotifyClick, ready: boolean, loading: boolean, ctx: RouteContext) {
  if (!ready) return false;
  if (c.session && !ctx.sessions.some((s) => s.key === c.session)) return !loading;
  return true;
}

/**
 * Takes notification clicks and opens where they point. `needs`: the Needs you page's items now (the rail's bell
 * passes its list, so nothing is computed twice).
 */
export function useNotifyClicks(needs: string[]) {
  const latest = useRef(needs);
  useEffect(() => {
    latest.current = needs;
  });
  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    const life = { dead: false };
    let off: (() => void) | null = null;
    const go = async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const c = (await invoke<NotifyClick | null>("notify_take").catch(() => null)) ?? null;
      if (!c || life.dead) return;
      const [{ useStore }, { useChats }, { sessionKey }] = await Promise.all([import("../store"), import("./chat"), import("./types")]);
      const ctx = () => {
        const st = useStore.getState();
        return {
          sessions: st.sessions.map((s) => ({ key: sessionKey(s), chat: s.chat ?? null })),
          needs: latest.current,
          chats: Object.keys(useChats.getState().chats).map(Number),
        };
      };
      // A click that launched coool comes before the sessions: wait for them (at most 15 s).
      const t0 = Date.now();
      while (!life.dead && Date.now() - t0 < 15_000 && !canDecide(c, useStore.getState().ready, useStore.getState().loading, ctx())) await new Promise((r) => setTimeout(r, 250));
      if (life.dead) return;
      // The Needs you list follows the sessions a render later.
      await new Promise((r) => setTimeout(r, 120));
      const d = destination(c, ctx());
      const st = useStore.getState();
      if (d.to === "needs") st.openNeeds(d.key);
      else if (d.to === "session") st.open({ kind: "session", key: d.key });
      else if (d.to === "chat") st.open({ kind: "chat", id: d.id });
      void invoke("selftest_log", { line: `notify-route ${c.kind} -> ${JSON.stringify(d)}` }).catch(() => {});
    };
    void go();
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen("notify-open", () => void go()).then((u) => {
        if (life.dead) u();
        else off = u;
      }),
    );
    return () => {
      life.dead = true;
      off?.();
    };
  }, []);
}
