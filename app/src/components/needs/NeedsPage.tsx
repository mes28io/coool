// The Needs you page (the rail's bell): everything waiting on the person, as an inbox. It lies over the app's sheet
// like Settings (sidebar and panes stay mounted underneath, hidden and inert), so going back restores exactly what
// was there. Left (top on a narrow window): the list, most urgent project first; right: the selected item in full
// (NeedDetail.tsx). ↑ ↓ move, ↵ opens the chat, ⌘↵ / ⇧⌘↵ / ⌘⌫ answer a permission, Esc or the bell goes back.
// Answers go through the chat's own functions; an answered item leaves the list and the next one is selected.

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { answerPermission } from "../../lib/actions";
import { pendingPermission, useChats } from "../../lib/chat";
import { displayTitle, folderName, projectOf } from "../../lib/format";
import { useMotion } from "../../lib/motion";
import { nextPick } from "../../lib/needs";
import { sessionKey } from "../../lib/types";
import { useStore } from "../../store";
import { IBack, IBell } from "../icons";
import { Age } from "../MissionCard";
import { cx, ease, Kbd, ProviderMark } from "../primitives";
import { KindIcon } from "./KindIcon";
import { NeedDetail } from "./NeedDetail";
import { deviceAsk } from "../Chat";
import { useNeed } from "./need";
import { useNeedsYou, type Needed } from "./useNeedsYou";

export function NeedsPage() {
  const list = useNeedsYou();
  const keys = list.map((n) => sessionKey(n.s));
  const close = useStore((s) => s.closeNeeds);
  const pick = useStore((s) => s.needsPick);
  const reduce = useMotion().reduce;
  const [picked, setPicked] = useState<string | null>(pick);
  // A new pick from outside (a notification) selects that item.
  const [lastPick, setLastPick] = useState(pick);
  if (pick !== lastPick) {
    setLastPick(pick);
    if (pick) setPicked(pick);
  }
  // The list as it was last shown: when the picked item leaves (answered), the next one takes its place.
  const [shown, setShown] = useState<string[]>(keys);
  const sel = nextPick(keys, shown, picked);
  if (sel !== picked) setPicked(sel);
  if (keys.join("\n") !== shown.join("\n")) setShown(keys);
  const current = list.find((n) => sessionKey(n.s) === sel) ?? null;
  const listRef = useRef<HTMLDivElement>(null);

  // Focus moves into the page and goes back where it was on return (as the Settings page does).
  const [prev] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? listRef.current;
    el?.focus({ preventScroll: true });
    return () => {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost && prev?.isConnected && !prev.closest("[inert]")) prev.focus({ preventScroll: true });
    };
  }, [prev]);

  // Keys (capture phase, before the app's own): Esc back; ↑ ↓ Home End move; ↵ opens the chat; ⌘↵ ⇧⌘↵ ⌘⌫ answer.
  const latest = useRef({ keys, sel });
  useLayoutEffect(() => {
    latest.current = { keys, sel };
  });
  useEffect(() => {
    const move = (to: string | undefined) => {
      if (!to) return;
      setPicked(to);
      requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-needs-item="${CSS.escape(to)}"]`)?.focus({ preventScroll: false }));
    };
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (st.palette || st.sheet || e.defaultPrevented) return;
      const { keys, sel } = latest.current;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const typing = !!t?.closest("input, textarea, select, [contenteditable='true']");
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        if ([...document.querySelectorAll(".shadow-pop [role=listbox][aria-label]")].length) return;
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (mod && sel) {
        const s = st.sessions.find((x) => sessionKey(x) === sel);
        const chat = s?.chat != null ? useChats.getState().chats[s.chat] : undefined;
        const p = chat?.running ? pendingPermission(chat) : null;
        if (!p || !chat || p.tool === "ExitPlanMode") return;
        const quick = p.remember[0]?.scope === "chat" ? p.remember[0] : null;
        if (e.key === "Enter" && e.shiftKey) {
          if (quick) answerPermission(chat.id, p.requestId, "always", quick);
        } else if (e.key === "Enter") answerPermission(chat.id, p.requestId, "allow");
        else if (e.key === "Backspace" && !typing) answerPermission(chat.id, p.requestId, "deny");
        else return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (typing || mod || e.altKey) return;
      const i = sel ? keys.indexOf(sel) : -1;
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
        // Arrows inside a scrolled detail would scroll it: only when focus is on the list or the page itself.
        if (t && !t.closest("[data-needs-list]") && t !== document.body && !t.matches("[data-needs-page]")) return;
        e.preventDefault();
        move(e.key === "ArrowDown" ? keys[Math.min(keys.length - 1, i + 1)] : e.key === "ArrowUp" ? keys[Math.max(0, i - 1)] : e.key === "Home" ? keys[0] : keys[keys.length - 1]);
        return;
      }
      if (e.key === "Enter" && sel && (!t || t === document.body || t.closest("[data-needs-item]") || t.matches("[data-needs-page]"))) {
        e.preventDefault();
        e.stopPropagation();
        st.open({ kind: "session", key: sel });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  return (
    <motion.div
      data-needs-page={list.length}
      tabIndex={-1}
      className="@container absolute inset-0 z-10 flex bg-bg outline-none"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16, ease }}
    >
      <div className="flex min-w-0 flex-1 flex-col @[760px]:flex-row">
        {/* The list */}
        <div className="flex max-h-[42%] shrink-0 flex-col border-b border-hairline @[760px]:max-h-none @[760px]:w-[320px] @[760px]:border-b-0 @[760px]:border-r">
          <div data-tauri-drag-region className="flex h-[48px] shrink-0 items-center px-2">
            <button
              type="button"
              onClick={close}
              title="Back to app (Esc)"
              className="flex h-[32px] items-center gap-2 rounded-[9px] pl-2 pr-2.5 text-base text-dim transition-colors duration-150 hover:bg-hover hover:text-fg"
              data-needs-back
            >
              <IBack size={16} />
              Back to app
            </button>
          </div>
          <div className="flex items-baseline gap-2 px-4 pb-2 pt-1">
            <h2 className="text-title font-semibold tracking-[-0.01em] text-fg">Needs you</h2>
            {list.length > 0 && <span className="text-small text-dim tnum">{list.length === 1 ? "1 waiting" : `${list.length} waiting`}</span>}
          </div>
          <div ref={listRef} role="listbox" aria-label="Waiting on you" tabIndex={list.length ? -1 : 0} className="scroll min-h-0 flex-1 px-2 pb-3 outline-none" data-needs-list>
            <AnimatePresence initial={false}>
              {list.map((n) => (
                <Row key={sessionKey(n.s)} n={n} on={sessionKey(n.s) === sel} onPick={() => setPicked(sessionKey(n.s))} reduce={reduce} />
              ))}
            </AnimatePresence>
          </div>
          <div className={cx("hidden items-center gap-1.5 px-4 pb-4 pt-2 text-small text-faint @[760px]:flex", !list.length && "invisible")}>
            <Kbd className="h-[20px]">↑↓</Kbd> move
            <Kbd className="ml-2 h-[20px]">↵</Kbd> open chat
            <Kbd className="ml-2 h-[20px]">Esc</Kbd> back
          </div>
        </div>

        {/* The selected item */}
        <div className="scroll min-h-0 min-w-0 flex-1" data-needs-main>
          <div data-tauri-drag-region className="hidden h-[48px] @[760px]:block" />
          {current ? (
            <motion.div
              key={sessionKey(current.s)}
              className="mx-auto w-full max-w-[760px] px-4 pb-12 pt-4 @[760px]:px-8 @[760px]:pt-0"
              initial={reduce ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, ease }}
            >
              <Detail n={current} />
            </motion.div>
          ) : (
            <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-2 text-base text-dim" data-needs-empty>
              <IBell size={20} className="text-faint" />
              Nothing needs you
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/** One row: what it asks, the session, and how long it has waited. */
function Row({ n, on, onPick, reduce }: { n: Needed; on: boolean; onPick: () => void; reduce: boolean }) {
  const it = useNeed(n);
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, height: 0, transition: { duration: 0.18, ease } }}
      transition={{ duration: 0.2, ease }}
      className="overflow-hidden"
    >
      <button
        type="button"
        role="option"
        aria-selected={on}
        tabIndex={on ? 0 : -1}
        onClick={onPick}
        onDoubleClick={() => useStore.getState().open({ kind: "session", key: it.key })}
        title={`${it.what}: ${it.detail}`}
        className={cx(
          "mb-0.5 flex w-full items-start gap-2.5 rounded-[10px] border px-2.5 py-2 text-left transition-colors duration-150",
          on ? "border-hairline bg-raised shadow-card" : "border-transparent hover:bg-hover",
        )}
        data-needs-item={it.key}
        data-needs-kind={it.kind}
      >
        <KindIcon kind={it.kind} device={it.perm ? deviceAsk(it.perm)?.device : undefined} size={24} className="mt-[1px]" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 text-base font-medium text-fg">{it.what}</span>
            <Age ms={it.since} className="ml-auto w-auto pl-1" />
          </span>
          <span className={cx("block truncate text-small", MONO.has(it.kind) ? "font-mono text-mono-small text-dim" : "text-fg/85")}>{it.detail}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-small text-faint">
            <ProviderMark provider={n.s.provider} size={11} />
            <span className="min-w-0 truncate">{displayTitle(n.s)}</span>
            <span className="shrink-0">· {folderName(projectOf(n.s))}</span>
          </span>
        </span>
      </button>
    </motion.div>
  );
}

/** Kinds whose detail line is a command, a path or a URL (mono); the others are words. */
const MONO = new Set(["command", "edit", "write", "fetch", "device", "tool"]);

/** The detail reads its item live (its chat's changes re-render only it). */
function Detail({ n }: { n: Needed }) {
  return <NeedDetail n={useNeed(n)} />;
}
