import { useShallow } from "zustand/react/shallow";
import { AnimatePresence, motion } from "motion/react";
import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useState } from "react";
import { BrowserContext, closeNative, recentPages, tabKey, useBrowserState, type OpenPage } from "../lib/browser";
import { GlobeGlyph } from "./MoodGlyph";
import { BrowserPanel } from "./BrowserPanel";
import { answerPermission, chatCall, openChatInTerminal, resumeSession } from "../lib/actions";
import { isLive, useAgentCards, type AgentCardData } from "../lib/agentCards";
import { api } from "../lib/backend";
import { chatModels, chatTitle, pendingPermission, useChats } from "../lib/chat";
import { displayTitle, folderName } from "../lib/format";
import type { Provider, Session } from "../lib/types";
import { sessionKey } from "../lib/types";
import { BROWSER_CHAT_MIN, BROWSER_MIN, resolveTarget, useStore, type Target, type ViewMode } from "../store";
import { liveTime, Timeline, ThinkingRow } from "./Activity";
import { AgentsButton } from "./AgentsButton";
import { AgentsBody } from "./AgentsPanel";
import { RightPanel, type RightKind } from "./RightPanel";
import { ChatComposer } from "./ChatComposer";
import { ChatTimeline } from "./Chat";
import { Composer } from "./Composer";
import { IActivity, IArrowUp, IClose, IPlay, ITerminal } from "./icons";
import { ModelsChip, ModelsPanelBody, sessionModelsData, type ModelsData } from "./Models";
import { SessionSkeleton, Skel } from "./Skeletons";
import { Button, ContextMeter, cx, ease, IconButton, PathText } from "./primitives";
import { modelLabel } from "../lib/models";
import { useShellFocus } from "../lib/shellFocus";

// xterm.js is only needed once a terminal is shown: keep it out of the main chunk.
const TerminalView = lazy(() => import("./TerminalView").then((m) => ({ default: m.TerminalView })));

/** Resume an ended session inside coool (as a chat; terminal if chats aren't available). */
export function resumeInto(s: Session, leaf?: string) {
  return resumeSession(s, leaf);
}

export function askStop(s: Session | null, pty: number | null, label: string, chat?: number | null) {
  useStore.getState().setSheet({
    kind: "stop",
    label,
    chat: chat ?? null,
    managed: chat != null ? null : (s?.managed ?? pty),
    pid: chat == null && s?.managed == null && pty == null ? (s?.pid ?? null) : null,
  });
}

export function SessionView({
  target,
  leaf,
  focused,
  compact,
  onClosePane,
}: {
  target: Target;
  leaf: string;
  focused: boolean;
  compact: boolean;
  onClosePane?: () => void;
}) {
  const r = useStore(useShallow((st) => resolveTarget(target, st)));
  const running = useStore((st) => (r.pty !== null ? !!st.ptys[r.pty]?.running && !st.exited[r.pty] : false));
  const modeKey = r.session ? `s:${sessionKey(r.session)}` : target.kind === "pty" ? `p:${target.id}` : target.kind === "chat" ? `c:${target.id}` : `s:${target.key}`;
  const stored = useStore((st) => st.modes[modeKey]);
  const since = useStore((st) => (r.session ? st.since[sessionKey(r.session)] : undefined));
  const setMode = useStore((st) => st.setMode);
  const chat = useChats((st) => (r.chat !== null ? st.chats[r.chat] : undefined));
  const scanning = useStore((st) => !st.ready || st.loading);

  // The Agents panel: one card per subagent / child job; a pane at least 900px wide shows it beside the timeline.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [paneW, setPaneW] = useState(0);
  useLayoutEffect(() => {
    if (!root) return;
    const ro = new ResizeObserver(() => setPaneW(root.clientWidth));
    ro.observe(root);
    setPaneW(root.clientWidth);
    return () => ro.disconnect();
  }, [root]);
  const wide = paneW >= 900;
  // The browser panel fits a narrower pane: it only needs room for itself and a readable chat beside it.
  const browserFits = paneW >= BROWSER_MIN + BROWSER_CHAT_MIN;
  const cards = useAgentCards(r.session, chat);
  const panelKey = r.session ? sessionKey(r.session) : r.chat !== null ? `chat:${r.chat}` : null;
  const panelState = useStore((st) => (panelKey ? st.rightPanel[panelKey] : undefined));
  const setRightPanel = useStore((st) => st.setRightPanel);
  const agentsWidth = useStore((st) => st.agentsWidth);
  const setAgentsWidth = useStore((st) => st.setAgentsWidth);
  const [resizing, setResizing] = useState(false);
  // Background shells sit in the same panel (APP_SPEC "Background shells"); it shows for shells alone too.
  const shells = useMemo(() => (r.session && r.session.status !== "ended" ? (r.session.shells ?? []) : []), [r.session]);
  useShellFocus(r.session?.id);
  const liveCards = cards.filter(isLive).length + shells.filter((s) => s.background).length;
  // First time something runs while the session is on screen: open it. Closing it is remembered.
  useEffect(() => {
    if (panelKey && wide && liveCards > 0 && panelState === undefined) setRightPanel(panelKey, "agents");
  }, [panelKey, wide, liveCards, panelState, setRightPanel]);
  const hasAgents = cards.length > 0 || shells.length > 0;
  const panelOn = wide && hasAgents;
  const tabs = useStore((st) => (panelKey ? st.browser[panelKey] : undefined));
  const activeKind = tabs?.tabs.find((t) => t.id === tabs.active)?.page.kind;
  const browserWidth = useStore((st) => st.browserWidth);
  const setBrowserWidth = useStore((st) => st.setBrowserWidth);
  const openBrowser = useStore((st) => st.openBrowser);
  const closeBrowser = useStore((st) => st.closeBrowser);
  const restoreBrowser = useStore((st) => st.restoreBrowser);
  const lastTabs = useStore((st) => (panelKey ? st.lastBrowser[panelKey] : undefined));
  // The start view's list: this chat's artifacts and the links in its messages.
  const recent = useMemo(() => {
    if (activeKind !== "start") return [];
    if (chat) return recentPages(chat.items.map((it) => (it.kind === "prompt" || it.kind === "text" ? { text: it.text } : it.kind === "tool" && !it.parent ? { artifact: it.artifact } : {})));
    return recentPages((r.session?.activity ?? []).map((a) => (a.kind === "prompt" || a.kind === "text" ? { text: a.full ?? a.text, artifact: a.artifact } : { artifact: a.artifact })));
  }, [activeKind, chat, r.session]);
  const showing: RightKind | null =
    panelState === "browser" && tabs && browserFits ? "browser" : !wide ? null : panelState === "agents" && hasAgents ? "agents" : panelState === "models" ? "models" : null;
  const agentsOpen = showing === "agents";
  const modelsOpen = showing === "models";
  const browserOpen = showing === "browser";
  // The globe spins while any page of this chat's browser is loading (like the Jobs glyph while jobs run).
  const browserLoading = useBrowserState((b) => !!panelKey && Object.entries(b.byKey).some(([k, v]) => k.startsWith(`${panelKey}#tab`) && v.loading));
  const toggleRight = (k: RightKind) => panelKey && setRightPanel(panelKey, showing === k ? "closed" : k);
  const panelWidth = (k: RightKind) => (k === "browser" ? Math.max(BROWSER_MIN, Math.min(browserWidth, paneW - BROWSER_CHAT_MIN)) : agentsWidth);
  const onPanelWidth = (k: RightKind, w: number) => (k === "browser" ? setBrowserWidth(Math.min(w, paneW - BROWSER_CHAT_MIN)) : setAgentsWidth(w));
  // Artifact cards' Open and links in this view open in a tab of its browser panel.
  const openPage = useCallback(
    (p: OpenPage) => {
      if (!panelKey) return;
      if (!browserFits) {
        useStore.getState().toast("Make this pane wider to open the page beside the chat");
        return;
      }
      openBrowser(panelKey, p);
    },
    [panelKey, browserFits, openBrowser],
  );
  // Closing destroys the tabs' webviews but remembers the tabs (where each was, the active one): the globe restores them.
  const onCloseBrowser = () => {
    if (!panelKey || !tabs) return;
    for (const t of tabs.tabs) closeNative(tabKey(panelKey, t.id));
    closeBrowser(panelKey);
  };
  const pageName = (b: typeof tabs) => {
    const t = b?.tabs.find((x) => x.id === b.active);
    if (!t || t.page.kind === "start") return null;
    const name = t.title?.trim() || (t.url || t.page.url).replace(/^https?:\/\//, "");
    return b!.tabs.length > 1 ? `${name} and ${b!.tabs.length - 1} more tab${b!.tabs.length > 2 ? "s" : ""}` : name;
  };
  const onGlobe = () => {
    if (!panelKey) return;
    if (browserOpen) return setRightPanel(panelKey, "closed");
    if (!browserFits) return useStore.getState().toast("Make this pane wider to open the browser beside the chat");
    if (tabs) return setRightPanel(panelKey, "browser");
    restoreBrowser(panelKey);
  };

  const { session, pty, starting, startingChat } = r;
  const isChat = r.chat !== null;
  const hasTerm = pty !== null;
  const mode: ViewMode = !hasTerm ? "activity" : (stored ?? (isChat ? "activity" : running ? "terminal" : "activity"));
  const modeTarget: Target = session ? { kind: "session", key: sessionKey(session) } : target;

  // ⌘↵ allows / ⌘⌫ denies a pending permission in the focused pane.
  useEffect(() => {
    if (!focused || !chat) return;
    const p = pendingPermission(chat);
    if (!p) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const inText = (e.target as HTMLElement)?.tagName === "TEXTAREA" && !!(e.target as HTMLTextAreaElement).value;
      // ⇧⌘↵ only for a this-chat-only option, the one the card marks with it.
      const quick = p.remember[0]?.scope === "chat" ? p.remember[0] : null;
      if (e.key === "Enter" && e.shiftKey) {
        if (quick) answerPermission(chat.id, p.requestId, "always", quick);
      } else if (e.key === "Enter") answerPermission(chat.id, p.requestId, "allow");
      else if (e.key === "Backspace" && !inText) answerPermission(chat.id, p.requestId, "deny");
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [focused, chat]);

  const models: ModelsData | null = useMemo(() => {
    if (chat && (Object.keys(chat.models).length || Object.keys(chat.agents).length)) {
      const m = chatModels(chat);
      return { main: m.main, agents: m.agents.map((a) => ({ key: a.tool, label: a.label, models: a.models })) };
    }
    return session ? sessionModelsData(session) : null;
  }, [chat, session]);

  if (!session && !starting && !startingChat && pty === null && !chat) {
    if (scanning) return <SessionSkeleton compact={compact} />;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
        <div className="text-title font-semibold tracking-[-0.01em]">This session is no longer listed</div>
        <div className="text-base text-dim">It ended more than a day ago or its transcript moved.</div>
      </div>
    );
  }

  const provider: Provider = session?.provider ?? chat?.provider ?? startingChat?.provider ?? starting?.provider ?? "claude";
  const cwd = session?.cwd ?? chat?.cwd ?? startingChat?.cwd ?? starting?.cwd ?? "";
  const chatLive = !!chat?.running;
  const title = session ? displayTitle(session) : (chat && chatTitle(chat)) || `New ${provider === "claude" ? "Claude Code" : "Codex"} chat`;
  const canResume = !!session && !chatLive && !running && session.status === "ended" && !!session.id && !!session.cwd;
  const external = !!session && !hasTerm && !isChat;
  const model = chat?.model ?? session?.model ?? null;
  const context = chat && chat.context ? chat.context : (session?.tokens.context ?? 0);
  const showTokens = !!session || !!chat?.tokens.output;
  const openTerm = () => r.chat !== null && openChatInTerminal(r.chat, session);
  const onOpenCard = (c: AgentCardData) => {
    const st = useStore.getState();
    if (c.source === "job") return st.open({ kind: "session", key: c.ref });
    if (mode === "terminal") setMode(modeTarget, "activity");
    st.focusAgent(c.ref);
  };
  const onStopCard = (c: AgentCardData) => {
    const k = useStore.getState().sessions.find((x) => sessionKey(x) === c.ref);
    if (k) askStop(k, k.managed, displayTitle(k), k.chat ?? null);
  };

  return (
    <BrowserContext.Provider value={openPage}>
    <div ref={setRoot} className="flex h-full min-w-0 flex-col">
      {/* header */}
      <div className={cx("flex shrink-0 items-center gap-3 border-b border-hairline", compact ? "h-[48px] px-3" : "h-[52px] px-4")}>
        {/* No provider logo here: the model can change mid-chat, so the logo sits on the model chip instead. */}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold tracking-[-0.005em] text-fg">{title}</h2>
          </div>
          <div className="-ml-1.5 flex min-w-0 items-center gap-1 text-small text-dim">
            <PathText path={cwd} className="min-w-0 shrink pl-1.5 text-small" />
          </div>
        </div>
        {hasTerm && <SegmentedMode mode={mode} chat={isChat} onChange={(m) => setMode(modeTarget, m)} compact={compact} />}
        {isChat && !hasTerm && (chatLive || session) && (
          <Button variant="ghost" onClick={openTerm} title="Continue this session in the real CLI, in a terminal" className={compact ? "px-2" : ""}>
            <ITerminal size={16} />
            {!compact && "Open in terminal"}
          </Button>
        )}
        {canResume && (
          <Button variant="outline" onClick={() => resumeSession(session!, leaf)} title="Resume this session inside coool">
            <IPlay size={14} />
            Resume
          </Button>
        )}
        {panelKey && (
          <IconButton title={browserOpen ? "Hide the browser" : `Show the browser${pageName(tabs ?? lastTabs) ? ` (${pageName(tabs ?? lastTabs)})` : ""}`} active={browserOpen} onClick={onGlobe}>
            <GlobeGlyph size={17} live={browserLoading} />
          </IconButton>
        )}
        {panelOn && panelKey && <AgentsButton cards={cards} shells={shells.length} open={agentsOpen} onToggle={() => toggleRight("agents")} compact={compact} />}
        {/* Model and context sit at the right end, after the Jobs and browser buttons. */}
        {session?.loaded === false && !chat ? (
          !compact && (
            <div className="hidden items-center gap-2.5 xl:flex" title="Reading this session's transcript…">
              <Skel w={64} h={9} />
              <Skel w={16} h={16} />
              <Skel w={56} h={9} />
            </div>
          )
        ) : (
          <div className="ml-1 flex shrink-0 items-center gap-2.5">
            {!compact && wide && models && (models.main.length > 0 || model) && <ModelsChip data={models} current={model} open={modelsOpen} onToggle={() => toggleRight("models")} />}
            {showTokens && <ContextMeter context={context} model={model} window={chat?.contextWindow} hideValues={compact} />}
          </div>
        )}
        {onClosePane && (
          <IconButton title="Close pane" onClick={onClosePane} className="-mr-1">
            <IClose size={14} />
          </IconButton>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* body */}
          <div className="relative min-h-0 flex-1">
            <AnimatePresence initial={false} mode="popLayout">
              {mode === "terminal" && pty !== null ? (
                <motion.div key="term" className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease }}>
                  <Suspense fallback={<div className="h-full bg-bg" />}>
                    <TerminalView pty={pty} focused={focused} />
                  </Suspense>
                </motion.div>
              ) : (
                <motion.div key="act" className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease }}>
                  {chat ? (
                    <ChatTimeline
                      chat={chat}
                      compact={compact}
                      onOpenTerminal={openTerm}
                      onSuggest={(t) => void chatCall(chat.id, () => api().chatSend(chat.id, t))}
                      onResume={session && !chatLive && !running ? () => resumeSession(session, leaf) : undefined}
                    />
                  ) : session ? (
                    <Timeline session={session} compact={compact} live={liveTime(since, session.updated, session.activity)} />
                  ) : (
                    <div className="flex h-full items-center justify-center">
                      <ThinkingRow since={starting?.started ?? null} label={`Starting ${provider} in ${folderName(cwd)}`} mood="start" big />
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* footer */}
          {mode === "terminal" && hasTerm ? (
            <Composer pty={pty!} provider={provider} disabled={!running} compact={compact} />
          ) : chat ? (
            <ChatComposer chat={chat} compact={compact} focused={focused} />
          ) : hasTerm ? (
            <Composer pty={pty!} provider={provider} disabled={!running} compact={compact} />
          ) : external ? (
            <ExternalNotice session={session!} leaf={leaf} compact={compact} />
          ) : null}
        </div>
        {(wide || browserFits) && panelKey && (
          <RightPanel which={showing} width={panelWidth} dragging={resizing} onWidth={onPanelWidth} onDragging={setResizing} onClose={() => setRightPanel(panelKey, "closed")}>
            {(k, active) =>
              k === "agents" ? (
                <AgentsBody cards={cards} shells={shells} onOpenCard={onOpenCard} onStop={onStopCard} onStopShell={(pid) => api().stopShell(pid)} />
              ) : k === "browser" ? (
                tabs ? <BrowserPanel panelKey={panelKey} state={tabs} active={active} onClose={onCloseBrowser} recent={recent} /> : null
              ) : (
                <ModelsPanelBody data={models ?? { main: [], agents: [] }} current={model} cards={cards} history={chat?.usageHistory} context={context} window={chat?.contextWindow} />
              )
            }
          </RightPanel>
        )}
      </div>
    </div>
    </BrowserContext.Provider>
  );
}

function SegmentedMode({ mode, chat, onChange, compact }: { mode: ViewMode; chat: boolean; onChange: (m: ViewMode) => void; compact: boolean }) {
  const uid = useId();
  const opts: { v: ViewMode; icon: typeof IActivity; label: string }[] = [
    { v: "activity", icon: IActivity, label: chat ? "Chat" : "Activity" },
    { v: "terminal", icon: ITerminal, label: "Terminal" },
  ];
  return (
    <div className="relative inline-flex h-[34px] rounded-[9px] bg-[color-mix(in_oklab,var(--dim)_12%,transparent)] p-[2px]">
      {opts.map((o) => {
        const on = o.v === mode;
        const I = o.icon;
        return (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            title={o.label}
            className={cx("relative z-0 flex items-center gap-1.5 rounded-[6px] px-2 text-small font-medium transition-colors duration-150", on ? "text-fg" : "text-dim hover:text-fg")}
          >
            {on && (
              <motion.span
                layoutId={`mode-${uid}`}
                // Re-measure only when the mode changes, not on every re-render (each sessions payload re-renders this header).
                layoutDependency={mode}
                className="absolute inset-0 -z-10 rounded-[6px] bg-raised shadow-[0_1px_2px_rgb(0_0_0/0.12),0_0_0_0.5px_var(--border)]"
                transition={{ type: "spring", stiffness: 520, damping: 40 }}
              />
            )}
            <I size={13} />
            {!compact && o.label}
          </button>
        );
      })}
    </div>
  );
}

function ExternalNotice({ session, leaf, compact }: { session: Session; leaf: string; compact: boolean }) {
  const ended = session.status === "ended";
  const model = session.model ? modelLabel(session.model) : null;
  // The same box as the chat composer, shown unavailable: coool can read this session but not type into it.
  return (
    <div className={cx("composer-dock shrink-0 pb-3", compact ? "px-3" : "px-6")}>
      <div
        aria-disabled="true"
        className="mx-auto max-w-[700px] cursor-not-allowed rounded-[20px] border border-line bg-raised/60 px-3.5 pb-2.5 pt-3.5 shadow-card"
        title={ended ? "This session has ended" : "This session runs outside coool, so you can't type into it here"}
      >
        <div className="min-h-[26px] select-none px-0.5 text-prose text-faint">
          {ended ? "This session has ended. Resume it to keep going." : "Running outside coool. When it ends you can resume it here."}
        </div>
        <div className="mt-2 flex h-[34px] items-center gap-2">
          {model && (
            <span className="inline-flex h-[28px] items-center gap-1.5 rounded-[8px] px-2 text-small font-medium text-faint">
              <span className="size-[6px] rounded-full bg-current opacity-60" />
              {model}
            </span>
          )}
          <span className="flex-1" />
          {ended && session.id ? (
            <>
              <Button variant="ghost" onClick={() => resumeSession(session, leaf, { terminal: true })} title="Resume in the CLI's own terminal UI">
                <ITerminal size={15} />
                In terminal
              </Button>
              <Button variant="primary" onClick={() => resumeSession(session, leaf)}>
                <IPlay size={14} />
                Resume here
              </Button>
            </>
          ) : (
            <span className="flex size-[32px] items-center justify-center rounded-[12px] bg-[color-mix(in_oklab,var(--text)_8%,transparent)] text-faint" aria-hidden>
              <IArrowUp size={17} strokeWidth={1.9} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
