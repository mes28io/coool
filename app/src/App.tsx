import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { AttachViewer } from "./components/Attachments";
import { MediaViewer } from "./components/Media";
import { useEffect, useLayoutEffect, useState } from "react";
import { api } from "./lib/backend";
import { useNativeRects } from "./lib/browser";
import { openAgentsDemo } from "./lib/agentsDemo";
import { chatQueue, rememberLive, useChats } from "./lib/chat";
import { setHome } from "./lib/format";
import { keysCaptured } from "./lib/macKeys";
import { useMotion } from "./lib/motion";
import { coverOf, useUpdates, watchUpdates } from "./lib/update";
import { UpdateScreen } from "./components/UpdateScreen";
import { matchShortcut } from "./lib/shortcuts";
import { syncWindow } from "./lib/boot";
import { glassActive, useGlassHoles } from "./lib/glass";
import { Backdrop } from "./components/Backdrop";
import { setTerminalTheme } from "./lib/termlite";
import { Palette } from "./components/Palette";
import { IAlert, ICheck, IClose, ISidebar } from "./components/icons";
import { Sheets } from "./components/Sheets";
import { Tooltips } from "./components/Tooltips";
import { Onboarding } from "./components/onboarding/Onboarding";
import { useOnboarding } from "./lib/onboarding";
import { useFullscreen } from "./lib/fullscreen";
import { Rail } from "./components/Rail";
import { RunningPill } from "./components/RunningPill";
import { HoverCards } from "./components/HoverCard";
import { SettingsPage } from "./components/SettingsPage";
import { NeedsPage } from "./components/needs/NeedsPage";
import { HistoryPage } from "./components/HistoryPage";
import { cx } from "./components/primitives";
import { Sidebar } from "./components/Sidebar";
import { TabBar, Workspace } from "./components/Workspace";
import { VoiceHost } from "./components/voice/VoiceHost";
import { APP_SEEN, leaves, seenAt, useStore } from "./store";
import { sessionKey } from "./lib/types";

function applyTheme(t: "dark" | "light") {
  const root = document.documentElement;
  if (root.dataset.theme === t) return;
  // One flip and one repaint. With transitions off for that frame, the hundreds of `transition-colors`
  // elements don't each start a colour transition (that made the switch stutter); they are back on a frame later.
  root.classList.add("no-transitions");
  root.dataset.theme = t;
  setTerminalTheme(t);
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("no-transitions")));
}

/** What each global shortcut in lib/shortcuts.ts does. */
function runShortcut(id: string, e: KeyboardEvent) {
  const st = useStore.getState();
  switch (id) {
    case "palette":
      return st.setPalette(!st.palette);
    case "new":
      return st.setSheet({ kind: "new" });
    case "settings":
      return st.openSettings();
    case "theme":
      return st.toggleTheme();
    case "sidebar":
      return st.toggleSidebar();
    case "home":
      return st.activate(null);
    case "sessions-history":
      return st.history ? st.closeHistory() : st.openHistory();
    case "tab":
      return st.activateIndex(Number(e.key) - 1);
    case "close":
      return st.closeFocused();
    case "split-right":
      return st.split("row");
    case "split-down":
      return st.split("col");
  }
}

function useShortcuts() {
  useEffect(() => {
    // The table and its matching live in lib/shortcuts.ts (also what Settings > Keyboard shortcuts lists).
    const onKey = (e: KeyboardEvent) => {
      // A device panel that has the keyboard (the Mac) takes every key, shortcuts included.
      if (keysCaptured(e)) return;
      // The update screen covers the app: nothing under it answers.
      if (coverOf(useUpdates.getState())) return;
      const sc = matchShortcut(e);
      if (!sc) return;
      e.preventDefault();
      e.stopPropagation();
      const st = useStore.getState();
      // While the Settings page is up, pane and sidebar shortcuts would act on things out of sight: they wait.
      if (sc.hiddenBySettings && (st.settings !== null || st.needsPage)) return;
      runShortcut(sc.id, e);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

/**
 * The sessions on screen count as seen: mark them while their tab is the active one and the window is in view.
 * The window and those sessions are also "touched" (when last on screen, wall clock), every 30 s while in view,
 * so coming back after a while records the absence for "While you were away" (store `touchSeen`).
 */
function useMarkSeen() {
  useEffect(() => {
    let inView = document.visibilityState === "visible";
    const sync = () => {
      if (!inView) return;
      const st = useStore.getState();
      const tab = st.tabs.find((t) => t.id === st.activeTab);
      const shown = [APP_SEEN];
      for (const l of tab ? leaves(tab.root) : []) {
        if (l.target?.kind !== "session") continue;
        const key = l.target.key;
        const s = st.sessions.find((x) => sessionKey(x) === key);
        if (s) {
          st.markSeen(key, seenAt(s));
          shown.push(key);
        }
      }
      st.touchSeen(shown);
    };
    const tick = setInterval(sync, 30_000);
    const view = () => {
      inView = document.visibilityState === "visible";
      sync();
    };
    const blur = () => (inView = false);
    const focus = () => view();
    document.addEventListener("visibilitychange", view);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    // Runs when sessions, tabs or the active tab change (a turn completing while open marks again).
    const unsub = useStore.subscribe((s, p) => {
      if (s.sessions !== p.sessions || s.tabs !== p.tabs || s.activeTab !== p.activeTab) sync();
    });
    sync();
    return () => {
      document.removeEventListener("visibilitychange", view);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      clearInterval(tick);
      unsub();
    };
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
    openAgentsDemo();
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
        chatQueue.push(id, events);
      }),
      b.onPtyExit((id) => useStore.getState().markExited(id)),
      // The updater (lib/update.ts): the rail's update icon and its panel.
      watchUpdates(),
      b.onConfirmQuit(() => {
        const s = useStore.getState();
        const ptys = Object.values(s.ptys).filter((p) => p.running && !s.exited[p.id]).length;
        const chats = Object.values(useChats.getState().chats).filter((c) => c.running).length;
        // The backend knows which chats the chat host keeps running across the quit (APP_SPEC "Chats that outlive the app").
        void b
          .quitCounts()
          .then((q) => s.setSheet({ kind: "quit", running: Math.max(1, q.stop), keep: q.keep }))
          .catch(() => s.setSheet({ kind: "quit", running: Math.max(1, ptys + chats) }));
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
  const settingsOpen = useStore((s) => s.settings !== null);
  // The title bar's own controls also step aside under the onboarding (it lets this bar show through above it).
  const fullscreen = useFullscreen();
  const barHidden = useOnboarding((s) => s.open) || settingsOpen;
  const needsOpen = useStore((s) => s.needsPage);
  const historyOpen = useStore((s) => s.history !== null);
  const covered = settingsOpen || needsOpen || historyOpen;
  useShortcuts();
  useBackendEvents();
  useMarkSeen();
  const reduceMotion = useMotion().reduce;
  // The update screen (or the launch hold before it) covers the window: the app under it takes no input.
  const updateCover = useUpdates(coverOf);

  useLayoutEffect(() => {
    // With the glass on, the native material changes appearance first, then the page's tint follows, so the
    // title bar never shows a light tint over a dark frost (or the reverse) for more than a frame.
    if (glassActive() && document.documentElement.dataset.theme !== theme) void syncWindow(theme).then(() => applyTheme(theme));
    else {
      applyTheme(theme);
      void syncWindow(theme);
    }
  }, [theme]);
  // The sheet's background is its own layer, cut where the device panels' glass shows (lib/glass.ts).
  const [sheetBg, setSheetBg] = useState<HTMLDivElement | null>(null);
  useGlassHoles(sheetBg);
  useEffect(() => {
    setTerminalTheme(theme);
    const mq = matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", setSystemTheme);
    return () => mq.removeEventListener("change", setSystemTheme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "never"}>
      {/* coool's colour backdrop, under everything (Settings > Appearance > Window backdrop: Colours). */}
      <Backdrop />
      {/* The window chrome (title bar and icon rail): frosted glass when Settings > Appearance > Translucent window is on. */}
      <div className="flex h-full w-full flex-col bg-chrome" inert={updateCover} aria-hidden={updateCover || undefined}>
        {/* Title bar: the macOS traffic lights sit in it (left), then the sidebar toggle; in full screen, where macOS
            takes the lights away, the toggle moves into their place. The whole bar drags the window. */}
        <div data-tauri-drag-region className={cx("flex h-[44px] shrink-0 items-center pr-2 transition-[padding] duration-200", fullscreen ? "pl-[22px]" : "pl-[84px]")} data-fullscreen={fullscreen || undefined}>
          {/* The app's own controls step aside (kept mounted) while the Settings page is up. */}
          <div data-tauri-drag-region className={cx("flex h-full min-w-0 flex-1 items-center", barHidden && "invisible")} inert={barHidden} aria-hidden={barHidden || undefined}>
            <button
              type="button"
              title={sidebarOpen ? "Hide sidebar (⌘B)" : "Show sidebar (⌘B)"}
              aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
              onClick={toggleSidebar}
              className="flex h-[28px] w-[28px] items-center justify-center rounded-[8px] text-faint transition-colors duration-150 hover:bg-hover hover:text-fg"
            >
              <ISidebar size={17} />
            </button>
            <TabBar />
          </div>
          {/* Outside the part that steps aside, so it shows over Settings too. */}
          <RunningPill />
        </div>
        <div className="flex min-h-0 flex-1">
          <Rail />
          {/* One raised sheet lying on the window, inset from its right and bottom edges so the glass shows all around: sidebar panel + main area, or the full-screen Settings page over them
              (the app stays mounted underneath, hidden and inert, so going back finds every tab, pane and scroll as it was). */}
          <div className="relative mb-2.5 mr-2.5 flex min-w-0 flex-1 overflow-hidden rounded-[16px] border border-hairline">
            <div ref={setSheetBg} className="pointer-events-none absolute inset-0 bg-bg" aria-hidden data-sheet-bg />
            <div className={cx("relative flex min-w-0 flex-1", covered && "invisible")} inert={covered} aria-hidden={covered || undefined}>
              <Sidebar />
              <Workspace />
            </div>
            <AnimatePresence>{settingsOpen && <SettingsPage key="settings" />}</AnimatePresence>
            {/* The Needs you page (the rail's bell) lies over the sheet the same way; the title bar's tabs stay. */}
            <AnimatePresence>{needsOpen && !settingsOpen && <NeedsPage key="needs" />}</AnimatePresence>
            {/* History (the rail's clock, ⌘Y) lies over it the same way. */}
            <AnimatePresence>{historyOpen && !settingsOpen && !needsOpen && <HistoryPage key="history" />}</AnimatePresence>
          </div>
        </div>
      </div>
      <Palette />
      <HoverCards />
      <Sheets />
      <Tooltips />
      <Onboarding />
      <VoiceHost />
      <Toasts />
      <AttachViewer />
      <MediaViewer />
      <UpdateScreen />
    </MotionConfig>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  // A browser panel's native webview draws over everything: toasts sit left of one that reaches the bottom right.
  const inset = useNativeRects((s) =>
    Object.values(s.byKey).reduce((m, b) => (b.x + b.w >= window.innerWidth - 24 && b.y + b.h >= window.innerHeight - 80 ? Math.max(m, window.innerWidth - b.x) : m), 0),
  );
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2" style={inset ? { right: inset + 16 } : undefined}>
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 16, transition: { duration: 0.16 } }}
            transition={{ type: "spring", stiffness: 480, damping: 36 }}
            className="pointer-events-auto flex max-w-[420px] items-start gap-2 rounded-[10px] border border-line bg-raised py-2 pl-3 pr-1.5 text-base shadow-pop"
          >
            {t.tone === "error" && <IAlert size={14} className="mt-[2px] shrink-0 text-err" />}
            {t.tone === "done" && <ICheck size={14} className="mt-[2px] shrink-0 text-done-text" />}
            <span className="selectable min-w-0 flex-1 break-words py-[1px]">{t.text}</span>
            <button className="flex size-[20px] shrink-0 items-center justify-center rounded-[5px] text-faint hover:bg-hover hover:text-fg" onClick={() => dismiss(t.id)}>
              <IClose size={11} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
