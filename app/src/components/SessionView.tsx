import { useShallow } from "zustand/react/shallow";
import { AnimatePresence, motion } from "motion/react";
import { lazy, Suspense, useEffect, useId, useMemo } from "react";
import { answerPermission, chatCall, openChatInTerminal, resumeSession } from "../lib/actions";
import { api } from "../lib/backend";
import { chatModels, chatTitle, needsAnswer, pendingPermission, useChats } from "../lib/chat";
import { displayTitle, folderName } from "../lib/format";
import { useAttention } from "../lib/live";
import type { Provider, Session } from "../lib/types";
import { sessionKey } from "../lib/types";
import { resolveTarget, useStore, type Target, type ViewMode } from "../store";
import { liveTime, Timeline, ThinkingRow } from "./Activity";
import { ChatComposer } from "./ChatComposer";
import { ChatTimeline } from "./Chat";
import { Composer } from "./Composer";
import { IActivity, IClose, IPlay, IStop, ITerminal } from "./icons";
import { ModelsChip, sessionModelsData, type ModelsData } from "./Models";
import { SessionSkeleton, Skel } from "./Skeletons";
import { Button, ContextMeter, cx, ease, IconButton, PathText, ProviderMark, StatusPill, Ticker, type UiStatus } from "./primitives";

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
  const att = useAttention(r.session);
  const scanning = useStore((st) => !st.ready || st.loading);

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
        <div className="text-md font-medium">This session is no longer listed</div>
        <div className="text-sm text-dim">It ended more than a day ago or its transcript moved.</div>
      </div>
    );
  }

  const provider: Provider = session?.provider ?? chat?.provider ?? startingChat?.provider ?? starting?.provider ?? "claude";
  const cwd = session?.cwd ?? chat?.cwd ?? startingChat?.cwd ?? starting?.cwd ?? "";
  const chatLive = !!chat?.running;
  let status: UiStatus = session ? (att?.status ?? session.status) : chat ? (chatLive ? (chat.state === "idle" ? (chat.ready ? "idle" : "starting") : "busy") : "ended") : running ? "starting" : "ended";
  if (att?.needs || (chat && needsAnswer(chat))) status = "needs";
  const title = session ? displayTitle(session) : (chat && chatTitle(chat)) || `New ${provider === "claude" ? "Claude Code" : "Codex"} chat`;
  const live = session ? session.status !== "ended" : running || chatLive;
  const canStop = chatLive || (live && !isChat && (running || !!session?.pid));
  const canResume = !!session && !chatLive && !running && session.status === "ended" && !!session.id && !!session.cwd;
  const external = !!session && !hasTerm && !isChat;
  const model = chat?.model ?? session?.model ?? null;
  const context = chat && chat.context ? chat.context : (session?.tokens.context ?? 0);
  const tokIn = chat && chat.tokens.input ? chat.tokens.input + chat.tokens.cached : session ? session.tokens.input + session.tokens.cached : 0;
  const tokOut = chat && chat.tokens.output ? chat.tokens.output : (session?.tokens.output ?? 0);
  const showTokens = !!session || !!chat?.tokens.output;
  const openTerm = () => r.chat !== null && openChatInTerminal(r.chat, session);

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* header */}
      <div className={cx("flex shrink-0 items-center gap-3 border-b border-hairline", compact ? "h-[50px] px-3" : "h-[56px] px-5")}>
        <ProviderMark provider={provider} size={15} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-[13.5px] font-semibold tracking-[-0.005em] text-fg">{title}</h2>
            <StatusPill status={status} />
          </div>
          <div className="-ml-1.5 flex min-w-0 items-center gap-1 text-xs text-dim">
            <PathText path={cwd} className="min-w-0 shrink pl-1.5 text-2xs" />
            {models && (models.main.length > 0 || model) && (
              <>
                <span className="text-faint">·</span>
                <ModelsChip data={models} current={model} compact={compact} />
              </>
            )}
          </div>
        </div>
        {session?.loaded === false && !chat && !compact && (
          <div className="hidden items-center gap-4 lg:flex" title="Reading this session's transcript…">
            <span className="flex items-center gap-2">
              <Skel w={80} h={4} />
              <Skel w={56} h={9} />
            </span>
            <span className="flex items-center gap-2.5">
              <Skel w={44} h={9} />
              <Skel w={44} h={9} />
            </span>
          </div>
        )}
        {showTokens && !compact && !(session?.loaded === false && !chat) && (
          <div className="hidden items-center gap-4 lg:flex">
            <ContextMeter context={context} model={model} window={chat?.contextWindow} />
            <div className="flex items-center gap-2.5 text-xs text-dim" title="Tokens in / out">
              <span>
                <span className="text-faint">in </span>
                <Ticker value={tokIn} className="text-fg/80" />
              </span>
              <span>
                <span className="text-faint">out </span>
                <Ticker value={tokOut} className="text-fg/80" />
              </span>
            </div>
          </div>
        )}
        {hasTerm && <SegmentedMode mode={mode} chat={isChat} onChange={(m) => setMode(modeTarget, m)} compact={compact} />}
        {isChat && !hasTerm && (chatLive || session) && (
          <Button variant="ghost" onClick={openTerm} title="Continue this session in the real CLI, in a terminal" className={compact ? "px-2" : ""}>
            <ITerminal size={14} />
            {!compact && "Open in terminal"}
          </Button>
        )}
        {canStop && (
          <Button variant="ghost" onClick={() => askStop(session, running ? pty : null, title, chatLive ? r.chat : null)} title="Stop session" className={compact ? "px-2" : ""}>
            <IStop size={13} />
            {!compact && "Stop"}
          </Button>
        )}
        {canResume && (
          <Button variant="outline" onClick={() => resumeSession(session!, leaf)} title="Resume this session inside coool">
            <IPlay size={12} />
            Resume
          </Button>
        )}
        {onClosePane && (
          <IconButton title="Close pane" onClick={onClosePane} className="-mr-1">
            <IClose size={12} />
          </IconButton>
        )}
      </div>

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
                <Timeline session={session} compact={compact} live={liveTime(since, session.updated)} />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <ThinkingRow since={starting?.started ?? null} label={`Starting ${provider} in ${folderName(cwd)}`} />
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
  );
}

function SegmentedMode({ mode, chat, onChange, compact }: { mode: ViewMode; chat: boolean; onChange: (m: ViewMode) => void; compact: boolean }) {
  const uid = useId();
  const opts: { v: ViewMode; icon: typeof IActivity; label: string }[] = [
    { v: "activity", icon: IActivity, label: chat ? "Chat" : "Activity" },
    { v: "terminal", icon: ITerminal, label: "Terminal" },
  ];
  return (
    <div className="relative inline-flex h-[28px] rounded-[8px] bg-[color-mix(in_oklab,var(--dim)_12%,transparent)] p-[2px]">
      {opts.map((o) => {
        const on = o.v === mode;
        const I = o.icon;
        return (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            title={o.label}
            className={cx("relative z-0 flex items-center gap-1.5 rounded-[6px] px-2 text-xs font-medium transition-colors duration-150", on ? "text-fg" : "text-dim hover:text-fg")}
          >
            {on && (
              <motion.span
                layoutId={`mode-${uid}`}
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
  return (
    <div className={cx("shrink-0 pb-3 pt-1", compact ? "px-3" : "px-6")}>
      <div className="mx-auto flex max-w-[780px] items-center gap-3 rounded-[12px] border border-dashed border-line px-4 py-2.5">
        <span className="min-w-0 flex-1 text-sm text-dim">
          {ended ? <>This session has ended. Resume it here to keep going in a chat.</> : <>Running outside coool. Stop it and resume here to take control.</>}
        </span>
        {ended && session.id && (
          <>
            <Button variant="ghost" onClick={() => resumeSession(session, leaf, { terminal: true })} title="Resume in the CLI's own terminal UI">
              <ITerminal size={13} />
              In terminal
            </Button>
            <Button variant="primary" onClick={() => resumeSession(session, leaf)}>
              <IPlay size={12} />
              Resume here
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
