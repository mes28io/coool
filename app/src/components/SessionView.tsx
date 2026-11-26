import { useShallow } from "zustand/react/shallow";
import { AttachSource, DropVeil } from "./Attachments";
import { htmlDrop } from "../lib/attach";
import { AnimatePresence, motion } from "motion/react";
import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BrowserContext, closeNative, recentPages, tabKey, useBrowserState, type OpenPage } from "../lib/browser";
import { useAgentBrowsing } from "../lib/browserAgent";
import { GlobeGlyph } from "./MoodGlyph";
import { BrowserPanel } from "./BrowserPanel";
import { DevicePanel } from "./DevicePanel";
import { MAC_UDID, MacPanel } from "./MacPanel";
import { keysCaptured } from "../lib/macKeys";
import { answerKeysCovered } from "../lib/answerKeys";
import { answerPermission, askRestart, chatCall, openChatInTerminal, resumeSession, useRestarting } from "../lib/actions";
import { isLive, useAgentCards, type AgentCardData } from "../lib/agentCards";
import { cardRoles, useChatCross, useChatTiers } from "./LadderTally";
import { api, isTauri } from "../lib/backend";
import { chatModels, chatTitle, pendingPermission, useChatShell, type Chat } from "../lib/chat";
import { displayTitle, folderName, homeShort, titleWas } from "../lib/format";
import type { HistoryFolder } from "../lib/history";
import { TitleInput, useTitleEdit } from "./TitleEdit";
import type { Provider, Session } from "../lib/types";
import { sessionKey } from "../lib/types";
import { BROWSER_CHAT_MIN, BROWSER_MIN, CHANGES_MIN, CONTEXT_MIN, DEVICE_MIN, MAC_MIN, resolveTarget, useStore, type Target, type ViewMode } from "../store";
import { liveTime, Timeline, ThinkingRow } from "./Activity";
import { AgentsButton } from "./AgentsButton";
import { AgentsBody } from "./AgentsPanel";
import { RightPanel, type RightKind } from "./RightPanel";
import { ChangesPanel } from "./ChangesPanel";
import { changesTarget, useChanges, useChangesOpen } from "../lib/changes";
import { nearestTurn, type Scope } from "../lib/changesRules";
import { useChangeNotes } from "../lib/changeNotes";
import { ChatComposer } from "./ChatComposer";
import { ChatTimeline } from "./Chat";
import { Composer } from "./Composer";
import { IActivity, IArrowUp, IClose, IContext, IDiff, IMac, IPhone, IRefresh, ITerminal } from "./icons";
import { MediaContext } from "./Media";
import { collectMedia } from "../lib/mediaRules";
import { useChats } from "../lib/chat";
import { ContextPanelBody } from "./ContextPanel";
import type { CtxTarget } from "../lib/chatContext";
import { ModelsChip, ModelsPanelBody, sessionModelsData, type ModelsData } from "./Models";
import { SessionSkeleton, Skel } from "./Skeletons";
import { ContextMeter, cx, ease, IconButton, PathText } from "./primitives";
import { modelLabel } from "../lib/models";
import { useShellFocus } from "../lib/shellFocus";
import { countRender } from "../lib/perfCount";
import { useLayout, useLayoutMode } from "../lib/layout";
import { BESIDE_CHAT_MIN, defaultFrac, fracOf, panelAxis, stackHeight, type Axis } from "../lib/layoutRules";
import { PlatformBadge } from "./Platform";

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
  countRender("SessionView");
  const r = useStore(useShallow((st) => resolveTarget(target, st)));
  const running = useStore((st) => (r.pty !== null ? !!st.ptys[r.pty]?.running && !st.exited[r.pty] : false));
  const modeKey = r.session ? `s:${sessionKey(r.session)}` : target.kind === "pty" ? `p:${target.id}` : target.kind === "chat" ? `c:${target.id}` : `s:${target.key}`;
  const stored = useStore((st) => st.modes[modeKey]);
  const since = useStore((st) => (r.session ? st.since[sessionKey(r.session)] : undefined));
  const setMode = useStore((st) => st.setMode);
  // Not per streamed token: the timeline reads the live chat itself.
  const chat = useChatShell(r.chat);
  const restarting = useRestarting((s) => (r.chat !== null ? !!s.on[r.chat] : false));
  const scanning = useStore((st) => !st.ready || st.loading);

  // The Agents panel: one card per subagent / child job; a pane at least 900px wide shows it beside the timeline.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [paneW, setPaneW] = useState(0);
  // The body's height (under the header): how tall a panel stacked below the chat can be (a portrait window).
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [bodyH, setBodyH] = useState(0);
  useLayoutEffect(() => {
    if (!root) return;
    const ro = new ResizeObserver(() => setPaneW(root.clientWidth));
    ro.observe(root);
    setPaneW(root.clientWidth);
    return () => ro.disconnect();
  }, [root]);
  useLayoutEffect(() => {
    if (!body) return;
    const ro = new ResizeObserver(() => setBodyH(body.clientHeight));
    ro.observe(body);
    setBodyH(body.clientHeight);
    return () => ro.disconnect();
  }, [body]);
  // Beside the chat ("x", landscape) or above it ("y", a portrait window), per kind (lib/layoutRules.ts).
  const layout = useLayoutMode();
  const deviceWidthPref = useStore((st) => st.deviceWidth);
  const axisOf = (k: RightKind): Axis => panelAxis(layout, k, paneW, bodyH, Math.max(DEVICE_MIN, Math.min(deviceWidthPref, paneW - BROWSER_CHAT_MIN)));
  const stack = useLayout((s) => s.stack);
  const setStack = useLayout((s) => s.setStack);
  // Jobs and Models want a wide pane beside the chat; stacked below it, any pane will do.
  const wide = paneW >= 900 || axisOf("agents") === "y";
  // Opening Jobs by itself takes room from the chat: stacked, only in a pane tall enough to spare it (not a short split).
  const roomy = paneW >= 900 || (axisOf("agents") === "y" && bodyH >= 1100);
  // The browser panel fits a narrower pane: it only needs room for itself and a readable chat beside it (or, stacked,
  // the pane's width).
  const browserFits = paneW >= BROWSER_MIN + (axisOf("browser") === "y" ? 0 : BROWSER_CHAT_MIN);
  const deviceFits = paneW >= DEVICE_MIN + (axisOf("device") === "y" ? 0 : BROWSER_CHAT_MIN);
  const macFits = axisOf("mac") === "y" ? paneW >= BROWSER_MIN : paneW >= MAC_MIN + BROWSER_CHAT_MIN;
  const changesFits = axisOf("changes") === "y" ? paneW >= BROWSER_MIN : paneW >= CHANGES_MIN + BROWSER_CHAT_MIN;
  // The Context panel: beside a readable chat, or below it at any width.
  const contextFits = axisOf("context") === "y" || paneW >= CONTEXT_MIN + BROWSER_CHAT_MIN;
  const cards = useAgentCards(r.session, chat);
  const ladderTiers = useChatTiers(r.chat);
  const ladderCross = useChatCross(r.chat);
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
    if (panelKey && roomy && liveCards > 0 && panelState === undefined) setRightPanel(panelKey, "agents");
  }, [panelKey, roomy, liveCards, panelState, setRightPanel]);
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
  const deviceWidth = useStore((st) => st.deviceWidth);
  const setDeviceWidth = useStore((st) => st.setDeviceWidth);
  const changesWidth = useStore((st) => st.changesWidth);
  const setChangesWidth = useStore((st) => st.setChangesWidth);
  const macWidth = useStore((st) => st.macWidth);
  const setMacWidth = useStore((st) => st.setMacWidth);
  const contextWidth = useStore((st) => st.contextWidth);
  const setContextWidth = useStore((st) => st.setContextWidth);
  const showing: RightKind | null =
    panelState === "browser" && tabs && browserFits
      ? "browser"
      : panelState === "device" && deviceFits
        ? "device"
        : panelState === "mac" && macFits
          ? "mac"
          : panelState === "changes" && changesFits
          ? "changes"
          : panelState === "context" && contextFits
          ? "context"
          : !wide
          ? null
          : panelState === "agents" && hasAgents
            ? "agents"
            : panelState === "models"
              ? "models"
              : null;
  // The kind the panel frame shows (the last one while it closes) decides beside or below.
  const [lastPanel, setLastPanel] = useState<RightKind>("agents");
  if (showing && showing !== lastPanel) setLastPanel(showing);
  const panelAxisNow = axisOf(showing ?? lastPanel);
  const agentsOpen = showing === "agents";
  const modelsOpen = showing === "models";
  const browserOpen = showing === "browser";
  const deviceOpen = showing === "device";
  const macOpen = showing === "mac";
  const changesOpen = showing === "changes";
  const contextOpen = showing === "context";
  // The chat's agent driving its iPhone: the panel shows that device, and opens if no panel is showing (not again in the
  // same stretch of activity once the person closed it); when another panel is showing, the iPhone button lights up.
  const [phoneBusy, setPhoneBusy] = useState(false);
  // The same for the Mac (its actions arrive as `sim-activity` with `udid: "mac"`).
  const [macBusy, setMacBusy] = useState(false);
  const live = useRef({ showing, deviceFits, macFits, lastAgent: 0, closedInBurst: false, macLastAgent: 0, macClosedInBurst: false });
  useLayoutEffect(() => {
    live.current.showing = showing;
    live.current.deviceFits = deviceFits;
    live.current.macFits = macFits;
  }, [showing, deviceFits, macFits]);
  const chatId = r.chat;
  useEffect(() => {
    if (chatId === null || !panelKey) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    let tm: ReturnType<typeof setTimeout> | undefined;
    const off = api().onSimActivity((a) => {
      if (a.chat !== chatId || a.source !== "agent") return;
      const st = useStore.getState();
      const l = live.current;
      const now = Date.now();
      if (a.udid === MAC_UDID) {
        if (a.kind === "end") {
          clearTimeout(tm);
          return setMacBusy(false);
        }
        if (now - l.macLastAgent > 30_000) l.macClosedInBurst = false;
        l.macLastAgent = now;
        if (l.showing === "mac") return;
        if (l.showing === null && l.macFits && !l.macClosedInBurst) return st.setRightPanel(panelKey, "mac");
        setMacBusy(true);
        clearTimeout(tm);
        tm = setTimeout(() => setMacBusy(false), 4000);
        return;
      }
      // The run is over: nothing to show, and the button stops lighting up.
      if (a.kind === "end") {
        clearTimeout(t);
        return setPhoneBusy(false);
      }
      if (now - l.lastAgent > 30_000) l.closedInBurst = false;
      l.lastAgent = now;
      st.setDevice(panelKey, a.udid);
      if (l.showing === "device") return;
      if (l.showing === null && l.deviceFits && !l.closedInBurst) return st.setRightPanel(panelKey, "device");
      setPhoneBusy(true);
      clearTimeout(t);
      t = setTimeout(() => setPhoneBusy(false), 4000);
    });
    return () => {
      off();
      clearTimeout(t);
      clearTimeout(tm);
    };
  }, [chatId, panelKey]);
  const setPanel = (v: RightKind | "closed") => {
    if (!panelKey) return;
    // Closing the iPhone while its agent is at work: don't pop it open again for this stretch.
    if (showing === "device" && v !== "device" && Date.now() - live.current.lastAgent < 30_000) live.current.closedInBurst = true;
    if (v === "device") setPhoneBusy(false);
    if (showing === "mac" && v !== "mac") {
      if (Date.now() - live.current.macLastAgent < 30_000) live.current.macClosedInBurst = true;
      // The chat's agent tools stop acting on the Mac once its panel is closed.
      if (r.chat !== null) void api().macBind(r.chat, false).catch(() => {});
    }
    if (v === "mac") setMacBusy(false);
    setRightPanel(panelKey, v);
  };
  // The globe spins while any page of this chat's browser is loading (like the Jobs glyph while jobs run).
  const browserLoading = useBrowserState((b) => !!panelKey && Object.entries(b.byKey).some(([k, v]) => k.startsWith(`${panelKey}#tab`) && v.loading));
  // The chat's agent using its browser while another panel (or none) shows: a dot on the globe, as for the iPhone.
  const browserBusy = !!useAgentBrowsing(chatId, 4000);
  const toggleRight = (k: RightKind) => setPanel(showing === k ? "closed" : k);
  // Stacked, an iPhone beside the chat keeps the chat at `BESIDE_CHAT_MIN` (dragging it wider would send it below).
  const deviceChatMin = layout === "stacked" ? BESIDE_CHAT_MIN : BROWSER_CHAT_MIN;
  // Stacked below the chat: each kind's remembered share of the body's height (its default until dragged).
  const panelHeight = (k: RightKind) => stackHeight(stack[k] ?? defaultFrac(k, paneW, bodyH), bodyH);
  const onPanelHeight = (k: RightKind, h: number) => setStack(k, h < 0 ? defaultFrac(k, paneW, bodyH) : fracOf(h, bodyH));
  const panelWidth = (k: RightKind) =>
    k === "browser"
      ? Math.max(BROWSER_MIN, Math.min(browserWidth, paneW - BROWSER_CHAT_MIN))
      : k === "device"
        ? Math.max(DEVICE_MIN, Math.min(deviceWidth, paneW - deviceChatMin))
        : k === "mac"
          ? Math.max(MAC_MIN, Math.min(macWidth, paneW - BROWSER_CHAT_MIN))
          : k === "changes"
            ? Math.max(CHANGES_MIN, Math.min(changesWidth, paneW - BROWSER_CHAT_MIN))
          : k === "context"
            ? Math.max(CONTEXT_MIN, Math.min(contextWidth, paneW - BROWSER_CHAT_MIN))
            : agentsWidth;
  const onPanelWidth = (k: RightKind, w: number) =>
    k === "browser"
      ? setBrowserWidth(Math.min(w, paneW - BROWSER_CHAT_MIN))
      : k === "device"
        ? setDeviceWidth(Math.min(w, paneW - deviceChatMin))
        : k === "mac"
          ? setMacWidth(Math.min(w, paneW - BROWSER_CHAT_MIN))
          : k === "changes"
            ? setChangesWidth(Math.min(w, paneW - BROWSER_CHAT_MIN))
          : k === "context"
            ? setContextWidth(Math.min(w, paneW - BROWSER_CHAT_MIN))
            : setAgentsWidth(w);
  // Artifact cards' Open and links in this view open in a tab of its browser panel.
  const openPage = useCallback(
    (p: OpenPage) => {
      if (!panelKey) return;
      if (!browserFits) {
        useStore.getState().toast(layout === "stacked" ? "Make this pane bigger to open the page with the chat" : "Make this pane wider to open the page beside the chat");
        return;
      }
      openBrowser(panelKey, p);
    },
    [panelKey, browserFits, openBrowser, layout],
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
    if (browserOpen) return setPanel("closed");
    if (!browserFits) return useStore.getState().toast(layout === "stacked" ? "Make this pane bigger to open the browser with the chat" : "Make this pane wider to open the browser beside the chat");
    if (tabs) return setPanel("browser");
    if (showing === "device" || showing === "mac") setPanel("closed");
    restoreBrowser(panelKey);
  };
  const onPhone = () => {
    if (!panelKey) return;
    if (deviceOpen) return setPanel("closed");
    if (!deviceFits) return useStore.getState().toast(layout === "stacked" ? "Make this pane bigger to show the iPhone with the chat" : "Make this pane wider to show the iPhone beside the chat");
    setPanel("device");
  };
  const onContext = () => {
    if (!panelKey) return;
    if (contextOpen) return setPanel("closed");
    if (!contextFits) return useStore.getState().toast(layout === "stacked" ? "Make this pane bigger to show the chat's context with it" : "Make this pane wider to show the chat's context beside it");
    setPanel("context");
  };
  const onMac = () => {
    if (!panelKey) return;
    if (macOpen) return setPanel("closed");
    if (!macFits) return useStore.getState().toast(layout === "stacked" ? "Make this pane bigger to show the Mac with the chat" : "Make this pane wider to show the Mac beside the chat");
    setPanel("mac");
  };

  // The Changes panel's data. Closed: a summary for the header's count (counts and turns, no diffs). Open: the diffs,
  // every 1.5 s while the agent works and every 4 s otherwise. Each call sends the revision the page has, so one with
  // nothing new costs the backend a `stat` per file and sends a number back (lib/changes.ts, crates/core/src/changes).
  const [changesScope, setChangesScope] = useState<Scope>("pending");
  const changesExternal = !!r.session && r.pty === null && r.chat === null;
  const cTarget = useMemo(() => changesTarget(r.session, chat, changesExternal), [r.session, chat?.sessionId, chat?.provider, chat?.cwd, changesExternal]); // eslint-disable-line react-hooks/exhaustive-deps
  const cLive = chat ? chat.running && chat.state !== "idle" : r.session?.status === "busy";
  // Open: every new step; closed: every new step too, at most every 2 s (a busy terminal session writes several
  // transcript lines a second).
  const cTick = `${chat?.items.length ?? 0}:${chat ? 0 : (r.session?.last_event ?? 0)}:${r.session?.agents.length ?? 0}`;
  const changes = useChanges(cTarget, changesScope, cTick, changesOpen ? (cLive ? 1500 : 4000) : null, !!cTarget, changesOpen, changesOpen ? 1000 : 2000);
  useChangeNotes(chat ?? null, changes.data, cTarget);
  const onChanges = () => {
    if (!panelKey) return;
    if (changesOpen) return setPanel("closed");
    if (!changesFits) return useStore.getState().toast(layout === "stacked" ? "Make this pane bigger to show the changes with the chat" : "Make this pane wider to show the changes beside the chat");
    setPanel("changes");
  };
  // "4 files changed" under a turn opens the panel at that turn.
  const openReq = useChangesOpen((s) => (panelKey ? s.req[panelKey] : undefined));
  const changeTurns = changes.data?.turns;
  useEffect(() => {
    if (!openReq || !panelKey) return;
    const sc = openReq.scope;
    if (typeof sc === "string") setChangesScope(sc);
    else if (changeTurns) {
      const n = nearestTurn(changeTurns, sc.at, sc.prompt, sc.ordinal);
      setChangesScope(n ? `turn:${n}` : "chat");
    } else setChangesScope("chat");
    if (changesFits) setRightPanel(panelKey, "changes");
    else useStore.getState().toast("Make this pane wider to show the changes beside the chat");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openReq?.n, changeTurns === undefined]);

  const { session, pty, starting, startingChat } = r;
  const ctxProvider: Provider = session?.provider ?? chat?.provider ?? startingChat?.provider ?? starting?.provider ?? "claude";
  const ctxCwd = session?.cwd ?? chat?.cwd ?? startingChat?.cwd ?? starting?.cwd ?? "";
  const ctxSession = chat?.sessionId ?? session?.id ?? null;
  const ctxTarget: CtxTarget = useMemo(() => ({ provider: ctxProvider, cwd: ctxCwd, chat: r.chat, sessionId: ctxSession }), [ctxProvider, ctxCwd, r.chat, ctxSession]);
  const isChat = r.chat !== null;
  const hasTerm = pty !== null;
  const mode: ViewMode = !hasTerm ? "activity" : (stored ?? (isChat ? "activity" : running ? "terminal" : "activity"));
  const modeTarget: Target = session ? { kind: "session", key: sessionKey(session) } : target;
  // Where this pane's images come from when coool's store doesn't have them: its session's transcript.
  const attachSource = useMemo(() => ({ provider: chat?.provider ?? session?.provider ?? null, session: chat?.sessionId ?? session?.id ?? null }), [chat?.provider, chat?.sessionId, session?.provider, session?.id]);
  // Whose media files the page may load (CHAT_SPEC "Media"): the backend checks every path against this chat's own.
  const mediaSessionKey = session ? sessionKey(session) : chat?.sessionId ? `${chat.provider}:${chat.sessionId}` : null;
  // The viewer's arrows go across all of the chat's media, read from the store when it opens (not on every token).
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const mediaCtx = useMemo(
    () => ({
      scope: chatId !== null || mediaSessionKey ? { chat: chatId, session: mediaSessionKey } : null,
      provider: attachSource.provider,
      session: attachSource.session,
      cwd: ctxCwd,
      all: () => {
        const st = useChats.getState();
        const c = chatId !== null ? st.chats[chatId] : undefined;
        return c ? collectMedia(c.items, st.earlier[chatId!] ?? [], c.cwd) : collectMedia([], sessionRef.current?.activity ?? [], sessionRef.current?.cwd);
      },
    }),
    [chatId, mediaSessionKey, attachSource.provider, attachSource.session, ctxCwd],
  );

  // ⌘↵ allows / ⌘⌫ denies a pending permission in the focused pane.
  useEffect(() => {
    if (!focused || !chat) return;
    const p = pendingPermission(chat);
    if (!p) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || keysCaptured(e)) return;
      // A page over the panes (Settings, Needs you, the onboarding) or the palette or a sheet has the keys: this pane's
      // request is out of sight.
      if (answerKeysCovered("pane")) return;
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

  // CHAT_SPEC "Session titles": double-click or right-click the header title to rename.
  const titleEdit = useTitleEdit(session);

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
          <div className="relative flex min-w-0 items-center gap-2" onDoubleClick={titleEdit.start} onContextMenu={titleEdit.onContextMenu}>
            {titleEdit.editing && session ? (
              <TitleInput s={session} onDone={titleEdit.stop} className="h-[24px] w-full max-w-[480px] text-base font-semibold" />
            ) : (
              <h2 className="truncate text-base font-semibold tracking-[-0.005em] text-fg" data-session-title title={session ? [title, titleWas(session)].filter(Boolean).join(" · ") : undefined}>
                {title}
              </h2>
            )}
          </div>
          <div className="-ml-1.5 flex min-w-0 items-center gap-1 text-small text-dim">
            <PathText path={cwd} className="min-w-0 shrink pl-1.5 text-small" />
            {chat?.account && <PlatformBadge chat={chat} />}
          </div>
        </div>
        {hasTerm && <SegmentedMode mode={mode} chat={isChat} onChange={(m) => setMode(modeTarget, m)} compact={compact} />}
        {chat && (
          // CHAT_SPEC "Restart": the CLI starts again on this conversation, so it reads its settings, MCP config,
          // permissions and instructions again (what "restart Claude Code" asks for), right here.
          <span className="contents" data-restart-button={restarting ? "busy" : "idle"}>
            <IconButton
              title={restarting ? "Restarting…" : `Restart ${chat.provider === "claude" ? "Claude Code" : "Codex"} on this conversation: it reads its settings, MCP servers and ${chat.provider === "claude" ? "CLAUDE.md" : "AGENTS.md"} again (or type /restart)`}
              onClick={() => askRestart(chat.id)}
              disabled={restarting}
            >
              <IRefresh size={16} className={restarting ? "animate-spin" : undefined} />
            </IconButton>
          </span>
        )}
        {panelKey && cwd && (
          <IconButton title={contextOpen ? "Hide this chat's context" : "This chat's context: folder, instructions, memory, skills, model"} active={contextOpen} onClick={onContext}>
            <IContext size={18} />
          </IconButton>
        )}
        {panelKey && (
          <IconButton
            title={browserOpen ? "Hide the browser" : `Show the browser${browserBusy ? " (the agent is using it)" : pageName(tabs ?? lastTabs) ? ` (${pageName(tabs ?? lastTabs)})` : ""}`}
            active={browserOpen}
            onClick={onGlobe}
            className="relative"
          >
            <GlobeGlyph size={19} live={browserLoading} />
            {browserBusy && !browserOpen && (
              <span className="breathe absolute right-[4px] top-[4px] size-[6px] rounded-full bg-[var(--status-running)] ring-2 ring-[var(--bg)]" data-browser-busy aria-hidden />
            )}
          </IconButton>
        )}
        {panelKey && (
          <IconButton
            title={deviceOpen ? "Hide the iPhone" : phoneBusy ? "Show the iPhone (the agent is using it)" : "Show the iPhone"}
            active={deviceOpen}
            onClick={onPhone}
            className="relative"
          >
            <IPhone size={19} />
            {phoneBusy && !deviceOpen && (
              <span className="breathe absolute right-[4px] top-[4px] size-[6px] rounded-full bg-[var(--status-running)] ring-2 ring-[var(--bg)]" data-phone-busy aria-hidden />
            )}
          </IconButton>
        )}
        {panelKey && (
          <IconButton
            title={macOpen ? "Hide the Mac" : macBusy ? "Show the Mac (the agent is using it)" : "Show the sandbox Mac"}
            active={macOpen}
            onClick={onMac}
            className="relative"
          >
            <IMac size={19} />
            {macBusy && !macOpen && (
              <span className="breathe absolute right-[4px] top-[4px] size-[6px] rounded-full bg-[var(--status-running)] ring-2 ring-[var(--bg)]" data-mac-busy aria-hidden />
            )}
          </IconButton>
        )}
        {panelKey && cTarget && (changesOpen || (changes.data?.total ?? 0) > 0) && (
          <button
            type="button"
            onClick={onChanges}
            title={changesOpen ? "Hide the changes" : `What the agent changed${changes.data ? `: ${changes.data.total} ${changes.data.total === 1 ? "file" : "files"}, ${changes.data.pending} not reviewed` : ""}`}
            className={cx("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] px-2 text-small font-medium transition-[background-color,color] duration-150 hover:bg-hover hover:text-fg", changesOpen ? "bg-hover text-fg" : "text-dim")}
            data-changes-button={changes.data?.pending ?? ""}
          >
            <span className="relative">
              <IDiff size={16} />
              {changes.data?.busy && <span className="breathe absolute -right-[2px] -top-[2px] size-[6px] rounded-full bg-[var(--status-running)] ring-2 ring-[var(--bg)]" aria-hidden />}
            </span>
            {!compact && <span>Changes</span>}
            {changes.data && (
              <span className={cx("rounded-[5px] px-1 font-mono text-[10.5px] tnum", changes.data.pending > 0 ? "bg-[color-mix(in_oklab,var(--text)_12%,transparent)] text-fg" : "bg-[color-mix(in_oklab,var(--dim)_10%,transparent)] text-faint")}>
                {changes.data.pending > 0 ? changes.data.pending : changes.data.total}
              </span>
            )}
          </button>
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

      <MediaContext.Provider value={mediaCtx}>
      <div ref={setBody} className={cx("flex min-h-0 flex-1", panelAxisNow === "y" && "flex-col")} data-pane-body>
        <AttachSource.Provider value={attachSource}>
        <div
          className="relative flex min-h-0 min-w-0 flex-1 flex-col"
          data-chat-drop={chat && mode !== "terminal" ? chat.id : undefined}
          {...(chat && mode !== "terminal" && !isTauri ? htmlDrop(chat.id) : {})}
        >
          {chat && mode !== "terminal" && <DropVeil chat={chat.id} provider={chat.provider} />}
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
        </AttachSource.Provider>
        {(wide || browserFits || deviceFits || macFits || changesFits || contextFits) && panelKey && (
          <RightPanel
            which={showing}
            width={panelWidth}
            axis={panelAxisNow}
            height={panelHeight(showing ?? lastPanel)}
            dragging={resizing}
            onWidth={onPanelWidth}
            onHeight={onPanelHeight}
            onDragging={setResizing} onClose={() => setPanel("closed")}>
            {(k, active) =>
              k === "agents" ? (
                <AgentsBody cards={cards} roles={cardRoles(ladderTiers, cards, ladderCross)} shells={shells} onOpenCard={onOpenCard} onStop={onStopCard} onStopShell={(pid) => api().stopShell(pid)} />
              ) : k === "browser" ? (
                tabs ? <BrowserPanel panelKey={panelKey} chat={r.chat} state={tabs} active={active} onClose={onCloseBrowser} recent={recent} /> : null
              ) : k === "device" ? (
                <DevicePanel panelKey={panelKey} chat={r.chat} active={active} onClose={() => setPanel("closed")} />
              ) : k === "mac" ? (
                <MacPanel chat={r.chat} active={active} onClose={() => setPanel("closed")} />
              ) : k === "changes" ? (
                <ChangesPanel data={changes.full ? changes.data : null} error={changes.error} reload={changes.reload} target={cTarget} scope={changesScope} onScope={setChangesScope} chat={chat ?? null} width={panelAxisNow === "y" ? paneW : panelWidth("changes")} onClose={() => setPanel("closed")} />
              ) : k === "context" ? (
                <ContextPanelBody
                  key={`${ctxTarget.provider}:${ctxTarget.cwd}:${ctxTarget.chat ?? ""}`}
                  target={ctxTarget}
                  active={active}
                  model={model}
                  onChangeModel={
                    chat
                      ? () => {
                          const b = root?.querySelector("[data-model-chip]")?.closest("button");
                          if (b instanceof HTMLButtonElement && !b.disabled) b.click();
                          else useStore.getState().toast("The model can be switched in the composer once the chat is ready");
                        }
                      : undefined
                  }
                />
              ) : (
                <ModelsPanelBody data={models ?? { main: [], agents: [] }} current={model} cards={cards} history={chat?.usageHistory} context={context} window={chat?.contextWindow} map={contextMapProps(session, chat)} />
              )
            }
          </RightPanel>
        )}
      </div>
      </MediaContext.Provider>
    </div>
    </BrowserContext.Provider>
  );
}

/** The Models panel's context map: for a session with a transcript, its subagents each with their own context. */
function contextMapProps(s: Session | null | undefined, chat: Chat | undefined) {
  if (!s?.id || s.loaded === false) return null;
  return {
    provider: s.provider,
    sessionId: s.id,
    cwd: s.cwd,
    agents: s.agents.map((a) => ({ id: a.id, label: a.description || a.kind, model: a.model, context: a.tokens.context })),
    compacting: chat?.compacting || /^compacting/i.test(s.current ?? ""),
  };
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
  // A session from long ago may have lost its folder (moved or deleted): the history still reads, and continuing
  // says what is possible (Codex continues in another folder; Claude Code only where it ran).
  const [folder, setFolder] = useState<HistoryFolder | null>(null);
  const [elsewhere, setElsewhere] = useState<string | null>(null);
  useEffect(() => {
    if (!ended || !session.cwd) return;
    let dead = false;
    api()
      .historyFolder(session.cwd)
      .then((f) => !dead && setFolder(f))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [ended, session.cwd]);
  const gone = folder?.exists === false && !elsewhere;
  const canType = ended && !!session.id && !!session.cwd && !gone;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const cli = session.provider === "codex" ? "Codex" : "Claude";
  // An ended session is just a chat you can keep writing in: the first message reopens it and is sent.
  const send = async () => {
    const t = text.trim();
    if (!t || busy || !canType) return;
    setBusy(true);
    try {
      const id = await resumeSession(elsewhere ? { ...session, cwd: elsewhere } : session, leaf);
      if (id !== undefined) {
        await api().chatSend(id, t);
        setText("");
      }
    } catch (e) {
      useStore.getState().toast(`The message wasn't sent: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };
  if (ended && gone && folder) return <FolderGone session={session} folder={folder} compact={compact} onMade={() => setFolder({ exists: true, moved_to: [] })} onElsewhere={setElsewhere} />;
  // Clicking the empty box (or pressing a key in it) with nothing typed yet is enough to bring the full composer back.
  return (
    <div className={cx("composer-dock shrink-0 pb-3", compact ? "px-3" : "px-6")}>
      <div
        aria-disabled={canType ? undefined : "true"}
        className={cx("mx-auto max-w-[700px] rounded-[20px] border border-line px-3.5 pb-2.5 pt-3.5 shadow-card", canType ? "bg-raised" : "cursor-not-allowed bg-raised/60")}
        title={canType ? undefined : "This session runs outside coool, so you can't type into it here"}
        data-ended-composer={canType ? "" : undefined}
      >
        {canType ? (
          <textarea
            value={text}
            disabled={busy}
            rows={1}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={busy ? "Reopening the chat…" : elsewhere ? `Message ${cli}… (continues this chat in ${homeShort(elsewhere)})` : `Message ${cli}… (continues this chat)`}
            className="block max-h-[200px] min-h-[26px] w-full resize-none bg-transparent px-0.5 text-prose text-fg outline-none placeholder:text-faint [field-sizing:content]"
          />
        ) : (
          <div className="min-h-[26px] select-none px-0.5 text-prose text-faint">Running outside coool. When it ends you can continue it here.</div>
        )}
        <div className="mt-2 flex h-[34px] items-center gap-2">
          {model && (
            <span className="inline-flex h-[28px] items-center gap-1.5 rounded-[8px] px-2 text-small font-medium text-faint">
              <span className="size-[6px] rounded-full bg-current opacity-60" />
              {model}
            </span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            disabled={!canType || busy || !text.trim()}
            onClick={() => void send()}
            title={canType ? "Send (Enter). The chat reopens and carries on." : undefined}
            aria-label="Send"
            className={cx(
              "flex size-[32px] items-center justify-center rounded-[12px] transition-colors",
              canType && text.trim() && !busy ? "bg-fg text-bg" : "bg-[color-mix(in_oklab,var(--text)_8%,transparent)] text-faint",
            )}
          >
            <IArrowUp size={17} strokeWidth={1.9} />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The ended-session box when the session's folder is gone: the history above still reads; continuing depends on the
 * CLI. Codex resumes a thread in any folder (a folder of the same name other sessions ran in is offered first);
 * Claude Code continues a conversation only in the folder it ran in, so the box offers to make that folder again.
 */
function FolderGone({ session, folder, compact, onMade, onElsewhere }: { session: Session; folder: HistoryFolder; compact: boolean; onMade: () => void; onElsewhere: (cwd: string) => void }) {
  const [busy, setBusy] = useState(false);
  const where = homeShort(session.cwd);
  const codex = session.provider === "codex";
  const pick = async () => {
    const p = await api()
      .pickFolder()
      .catch(() => null);
    if (p) onElsewhere(p);
  };
  const make = async () => {
    setBusy(true);
    try {
      await api().historyMakeFolder(session.cwd);
      onMade();
    } catch (e) {
      useStore.getState().toast(String(e instanceof Error ? e.message : e), "error");
    } finally {
      setBusy(false);
    }
  };
  const btn = "inline-flex h-[30px] items-center rounded-[9px] px-3 text-small font-medium transition-colors duration-150";
  return (
    <div className={cx("composer-dock shrink-0 pb-3", compact ? "px-3" : "px-6")}>
      <div className="mx-auto max-w-[700px] rounded-[20px] border border-line bg-raised/80 px-4 pb-3 pt-3.5 shadow-card" data-folder-gone={session.provider}>
        <div className="text-base text-fg">
          This session ran in <span className="font-mono text-mono-small">{where}</span>, which isn't there any more.
        </div>
        <div className="mt-1 text-small text-dim">
          {codex
            ? "Its history is all here. Codex can continue it in another folder: the files it worked on are not carried over."
            : "Its history is all here. Claude Code continues a conversation only in the folder it ran in: put the folder back (or make it again, empty) to continue."}
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {codex &&
            folder.moved_to.map((m) => (
              <button key={m} type="button" onClick={() => onElsewhere(m)} className={cx(btn, "bg-fg text-bg hover:opacity-90")} data-folder-moved={m}>
                Continue in {homeShort(m)}
              </button>
            ))}
          {codex && (
            <button type="button" onClick={() => void pick()} className={cx(btn, folder.moved_to.length ? "text-dim hover:bg-hover hover:text-fg" : "bg-fg text-bg hover:opacity-90")} data-folder-pick>
              Choose a folder…
            </button>
          )}
          {!codex && (
            <button type="button" disabled={busy} onClick={() => void make()} className={cx(btn, "bg-fg text-bg hover:opacity-90")} data-folder-make>
              {busy ? "Making it…" : "Make the folder again"}
            </button>
          )}
          {!codex && folder.moved_to.length > 0 && <span className="text-small text-faint">It may have moved to {homeShort(folder.moved_to[0])}.</span>}
        </div>
      </div>
    </div>
  );
}
