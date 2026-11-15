import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useLayoutEffect } from "react";
import { api } from "./lib/backend";
import { rememberLive, useChats } from "./lib/chat";
import { setHome } from "./lib/format";
import { syncWindow } from "./lib/boot";
import { setTerminalTheme } from "./lib/termlite";
import { Palette } from "./components/Palette";
import { IAlert, IClose, ISidebar } from "./components/icons";
import { Sheets } from "./components/Sheets";
import { Rail } from "./components/Rail";
import { Sidebar } from "./components/Sidebar";
import { TabBar, Workspace } from "./components/Workspace";
import { useStore } from "./store";

function applyTheme(t: "dark" | "light", animate: boolean) {
  const root = document.documentElement;
  if (root.dataset.theme === t) return;
  const swap = () => {
    root.dataset.theme = t;
    setTerminalTheme(t);
  };
  if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) return swap();
  // Cross-fade colours; never flash.
  root.classList.add("theme-fade");
  swap();
  setTimeout(() => root.classList.remove("theme-fade"), 320);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      let hit = true;
      if (k === "k") st.setPalette(!st.palette);
      else if (k === "t" && !e.shiftKey) st.setSheet({ kind: "new" });
      else if (k === "b" && !e.shiftKey) st.toggleSidebar();
      else if (k === "w" && !e.shiftKey) st.closeFocused();
      else if (k === "\\" || e.code === "Backslash") st.split(e.shiftKey ? "col" : "row");
      else if (k === "l" && e.shiftKey) st.toggleTheme();
      else if (k === "," && !e.shiftKey) st.setSheet({ kind: "settings" });
      else if (/^[1-9]$/.test(e.key) && !e.shiftKey) st.activateIndex(Number(e.key) - 1);
      else if (k === "0" && !e.shiftKey) st.activate(null);
      else hit = false;
      if (hit) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

function useBackendEvents() {
  useEffect(() => {
    const b = api();
    const st = useStore.getState();
    // The first `list_sessions` can come back empty simply because the backend
    // hasn't scanned yet. Only trust it if it says so (`loading` present) or has
    // content; otherwise keep the skeletons and wait for the `sessions` event,
    // re-asking a few times so a machine with truly no sessions still settles.
    let heard = false;
    const firstAt = Date.now();
    const ask = () =>
      b.listSessions()
        .then((s) => {
          if (heard) return;
          const known = s.loading !== undefined || s.sessions.length > 0 || (s.chats?.length ?? 0) > 0 || s.pending.length > 0;
          if (known || Date.now() - firstAt > 9000) {
            heard = true;
            useStore.getState().setSnapshot(s);
          } else setTimeout(ask, 1500);
        })
        .catch((e) => st.toast(String(e), "error"));
    ask();
    b.environment()
      .then((env) => {
        setHome(env.home);
        st.setEnv(env);
      })
      .catch(() => {});
    // Chats: every chat the backend reports gets its event history replayed once
    // (so "Needs you" shows even for chats no pane has opened), then live batches.
    const replayed = new Set<number>();
    const syncChats = (s: { chats?: import("./lib/types").ChatInfo[] }) => {
      const cs = useChats.getState();
      for (const info of s.chats ?? []) {
        cs.ensure(info);
        if (replayed.has(info.id)) continue;
        replayed.add(info.id);
        b.chatReplay(info.id)
          // A rebuild rather than an apply: live batches may have raced ahead of
          // the replay, and seq de-duplication alone would then drop the start.
          .then(({ events, seq }) => useChats.getState().replace(info.id, info, events, seq))
          .catch(() => replayed.delete(info.id));
      }
    };
    b.listSessions().then(syncChats).catch(() => {});
    const offs = [
      b.onSessions((s) => {
        heard = true;
        useStore.getState().setSnapshot(s);
        syncChats(s);
      }),
      b.onChatEvent(({ id, events }) => {
        rememberLive(id, events);
        useChats.getState().apply(id, events);
      }),
      b.onPtyExit((id) => useStore.getState().markExited(id)),
      b.onConfirmQuit(() => {
        const s = useStore.getState();
        const ptys = Object.values(s.ptys).filter((p) => p.running && !s.exited[p.id]).length;
        const chats = Object.values(useChats.getState().chats).filter((c) => c.running).length;
        s.setSheet({ kind: "quit", running: Math.max(1, ptys + chats) });
      }),
    ];
    // Dev-only scripted self-test (inert unless the backend says it is on).
    void import("./selftest").then((m) => m.maybeRunSelfTest());
    return () => offs.forEach((f) => f());
  }, []);
}

export default function App() {
  const theme = useStore((s) => s.theme);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const setSystemTheme = useStore((s) => s.setSystemTheme);
  useShortcuts();
  useBackendEvents();

  useLayoutEffect(() => {
    applyTheme(theme, true);
    void syncWindow(theme);
  }, [theme]);
  useEffect(() => {
    setTerminalTheme(theme);
    const mq = matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", setSystemTheme);
    return () => mq.removeEventListener("change", setSystemTheme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-full w-full flex-col bg-panel">
        {/* Title bar: the macOS traffic lights sit in it (left), then the sidebar toggle. The whole bar drags the window. */}
        <div data-tauri-drag-region className="flex h-[44px] shrink-0 items-center pl-[84px] pr-2">
          <button
            type="button"
            title={sidebarOpen ? "Hide sidebar (⌘B)" : "Show sidebar (⌘B)"}
            aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            onClick={toggleSidebar}
            className="flex h-[28px] w-[28px] items-center justify-center rounded-[12px] text-faint transition-colors duration-150 hover:bg-hover hover:text-fg"
          >
            <ISidebar size={17} />
          </button>
          <TabBar />
        </div>
        <div className="flex min-h-0 flex-1">
          <Rail />
          {/* One raised sheet lying on the window: sidebar panel + main area. */}
          <div className="flex min-w-0 flex-1 overflow-hidden rounded-tl-[22px] border-l border-t border-hairline bg-bg">
            <Sidebar />
            <Workspace />
          </div>
        </div>
      </div>
      <Palette />
      <Sheets />
      <Toasts />
    </MotionConfig>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 16, transition: { duration: 0.16 } }}
            transition={{ type: "spring", stiffness: 480, damping: 36 }}
            className="pointer-events-auto flex max-w-[420px] items-start gap-2 rounded-[14px] border border-line bg-raised py-2 pl-3 pr-1.5 text-base shadow-pop"
          >
            {t.tone === "error" && <IAlert size={14} className="mt-[2px] shrink-0 text-err" />}
            <span className="selectable min-w-0 flex-1 break-words py-[1px]">{t.text}</span>
            <button className="flex size-[20px] shrink-0 items-center justify-center rounded-[8px] text-faint hover:bg-hover hover:text-fg" onClick={() => dismiss(t.id)}>
              <IClose size={11} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
