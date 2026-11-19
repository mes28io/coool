// The hover card on session rows (APP_SPEC "Product shape"): after the pointer rests ~500 ms on a sidebar row or a
// tab, a small card beside it: model, context, tokens this turn, the current step, the last prompt's first line and
// live children. It never takes the pointer (pointer-events: none), and goes away on pointer leave, any press (so a
// click or a drag is never in its way), scroll, wheel, a key, or the window losing focus. Mounted once (App.tsx); it
// finds rows by `data-session-row` (sidebar) and `data-tab-session` (tabs).

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useChats } from "../lib/chat";
import { displayTitle, fmtTokens, folderName, isThinking, projectOf, shortDetail } from "../lib/format";
import { useAttention } from "../lib/live";
import { contextWindow, modelLabel } from "../lib/models";
import { useMotion } from "../lib/motion";
import { firstLine, hoverAnchor, HOVER_REST_MS } from "../lib/hoverRest";
import { stepParts } from "../lib/toolNames";
import { sessionKey } from "../lib/types";
import { useStore } from "../store";
import { ContextRing, cx, ProviderMark, StatusDot } from "./primitives";

const ROWS = "[data-session-row], [data-tab-session]";

interface Shown {
  key: string;
  rect: { left: number; top: number; right: number; bottom: number };
  side: "right" | "below";
}

export function HoverCards() {
  const [shown, setShown] = useState<Shown | null>(null);
  useEffect(() => {
    let el: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let rest = { x: 0, y: 0 };
    // After a press on a row, nothing shows again until the pointer has left it.
    let pressed: HTMLElement | null = null;
    // The row's own tooltip (Tooltips.tsx) stands aside from the moment the pointer is on the row: the card says more.
    let quiet: HTMLElement | null = null;
    const unquiet = () => {
      if (quiet) delete quiet.dataset.noTip;
      quiet = null;
    };
    const hide = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      setShown((v) => (v ? null : v));
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!el || !el.isConnected || pressed === el) return;
        const key = el.dataset.sessionRow ?? el.dataset.tabSession;
        if (!key) return;
        const r = el.getBoundingClientRect();
        setShown({ key, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, side: el.dataset.tabSession ? "below" : "right" });
      }, HOVER_REST_MS);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const target = e.target as Element | null;
      const row = target?.closest?.<HTMLElement>(ROWS) ?? null;
      // A chip inside the row with a tooltip of its own (an overlap mark, the nest toggle) keeps its tooltip; no card there.
      const tip = target?.closest?.("[title], [data-tip], [data-tip-held]") ?? null;
      const t = row && (!tip || tip === row || !row.contains(tip)) ? row : null;
      if (t !== el) {
        hide();
        unquiet();
        el = t;
        if (el) {
          quiet = el;
          el.dataset.noTip = "";
        }
        if (pressed && pressed !== t) pressed = null;
        if (el && e.buttons === 0) {
          rest = { x: e.clientX, y: e.clientY };
          arm();
        }
        return;
      }
      if (!el || e.buttons !== 0 || pressed === el) return;
      // Resting means still: a move of more than a few px starts the wait again (unless the card is already up).
      if (timer && Math.hypot(e.clientX - rest.x, e.clientY - rest.y) > 4) {
        rest = { x: e.clientX, y: e.clientY };
        arm();
      }
    };
    const press = () => {
      pressed = el;
      hide();
    };
    const leave = (e: PointerEvent) => {
      if (!e.relatedTarget) {
        el = null;
        pressed = null;
        hide();
        unquiet();
      }
    };
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("pointermove", move, opts);
    window.addEventListener("pointerdown", press, opts);
    window.addEventListener("pointerout", leave, opts);
    window.addEventListener("wheel", hide, opts);
    window.addEventListener("scroll", hide, opts);
    window.addEventListener("keydown", hide, opts);
    window.addEventListener("blur", hide);
    window.addEventListener("dragstart", press, opts);
    return () => {
      hide();
      unquiet();
      window.removeEventListener("pointermove", move, opts);
      window.removeEventListener("pointerdown", press, opts);
      window.removeEventListener("pointerout", leave, opts);
      window.removeEventListener("wheel", hide, opts);
      window.removeEventListener("scroll", hide, opts);
      window.removeEventListener("keydown", hide, opts);
      window.removeEventListener("blur", hide);
      window.removeEventListener("dragstart", press, opts);
    };
  }, []);
  return createPortal(<AnimatePresence>{shown && <Card key={shown.key} shown={shown} />}</AnimatePresence>, document.body);
}

const W = 300;

function Card({ shown }: { shown: Shown }) {
  const s = useStore((st) => st.sessions.find((x) => sessionKey(x) === shown.key) ?? st.allSessions.find((x) => sessionKey(x) === shown.key) ?? null);
  const att = useAttention(s);
  const reduce = useMotion().reduce;
  const turnOut = useChats((st) => {
    const c = s?.chat != null ? st.chats[s.chat] : undefined;
    return c && c.turnStart !== null ? Math.max(0, Math.max(c.outShown, c.tokens.output) - c.turnOut0) : null;
  });
  const box = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  // Measured after every render (the same height is a no-op), so the card is placed with its real size.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => setH(box.current?.offsetHeight ?? 0));
  if (!s || !att) return null;
  const pos = hoverAnchor(shown.rect, shown.side, { w: W, h }, { w: window.innerWidth, h: window.innerHeight });
  const needs = att.needs;
  const busy = att.status === "busy";
  const cur = busy && s.current && !isThinking(s.current) ? stepParts(s.current) : null;
  const step = needs ?? (att.background ? att.background : busy ? (cur ? `${cur.name}${cur.detail ? ` ${shortDetail(cur.detail)}` : ""}` : "Thinking") : att.status === "ended" ? "Ended" : "Waiting for you");
  const w = contextWindow(s.model, null);
  const ctxPct = s.tokens.context > 0 ? Math.round((s.tokens.context / w.tokens) * 100) : null;
  const tokens = turnOut ?? s.tokens.turn_output ?? 0;
  const prompt = firstLine(s.last_prompt);
  const agents = att.agents.length;
  const kids = s.live_children ?? 0;
  const children = [agents > 0 && `${agents} ${agents === 1 ? "agent" : "agents"} working`, kids > 0 && `${kids} child ${kids === 1 ? "run" : "runs"} live`, (s.shells?.length ?? 0) > 0 && `${s.shells!.length} ${s.shells!.length === 1 ? "job" : "jobs"}`].filter(Boolean).join(" · ");
  return (
    <motion.div
      ref={box}
      initial={reduce ? { opacity: 1 } : { opacity: 0, y: shown.side === "below" ? -3 : 0, x: shown.side === "right" ? -3 : 0 }}
      animate={{ opacity: h ? 1 : 0, x: 0, y: 0 }}
      exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.08 } }}
      transition={{ duration: reduce ? 0 : 0.14 }}
      className="pointer-events-none fixed z-[70] flex flex-col gap-1.5 rounded-[12px] border border-line bg-raised px-3 py-2.5 shadow-pop"
      style={{ left: pos.left, top: pos.top, width: W }}
      role="tooltip"
      data-hover-card={shown.key}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot status={needs ? "needs" : att.status} size={7} />
        <span className="min-w-0 flex-1 truncate text-base font-medium text-fg">{displayTitle(s)}</span>
        <ProviderMark provider={s.provider} size={12} />
      </div>
      <div className="flex min-w-0 items-center gap-2 text-small text-dim tnum">
        <span className="truncate">{s.model ? modelLabel(s.model) : folderName(projectOf(s))}</span>
        {ctxPct !== null && (
          <span className="flex shrink-0 items-center gap-1" title={`Context ${fmtTokens(s.tokens.context)} of ${fmtTokens(w.tokens)}`}>
            <ContextRing context={s.tokens.context} model={s.model} size={12} />
            {ctxPct}% · {fmtTokens(s.tokens.context)}
          </span>
        )}
        {tokens > 0 && <span className="ml-auto shrink-0 text-faint">↓ {fmtTokens(tokens)} this turn</span>}
      </div>
      <div className={cx("truncate text-small", needs ? "text-needs-text" : busy ? "text-fg/85" : "text-dim")} data-hover-step>
        {step}
      </div>
      {prompt && (
        <div className="line-clamp-2 border-l-2 border-hairline pl-2 text-small text-dim" data-hover-prompt>
          {prompt}
        </div>
      )}
      {children && <div className="text-small text-faint">{children}</div>}
    </motion.div>
  );
}
