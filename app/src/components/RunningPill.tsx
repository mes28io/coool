// The running-now pill (APP_SPEC "Product shape"): at the right of the title bar, from any tab and over Settings, a
// quiet "3 working · 1 needs you". It opens a list of those sessions with what each is doing now, how many steps
// its turn has taken, and Open / Stop. Hidden when nothing is working or waiting on the person.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/backend";
import { useClock } from "../lib/clock";
import { pillText } from "../lib/lid";
import { displayTitle, folderName, isThinking, projectOf, shortDetail } from "../lib/format";
import { runningLabel } from "../lib/lanes";
import { attention, useChatDigest, type Attention } from "../lib/live";
import { compactSpan } from "../lib/mission";
import { stepParts } from "../lib/toolNames";
import { turnTotals } from "../lib/turn";
import type { Session } from "../lib/types";
import { sessionKey } from "../lib/types";
import { useStore } from "../store";
import { IStop } from "./icons";
import { cx, Popover, ProviderMark, StatusDot } from "./primitives";
import { askStop } from "./SessionView";

interface Live {
  s: Session;
  att: Attention;
}

export function RunningPill() {
  const sessions = useStore((s) => s.sessions);
  const digest = useChatDigest();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const live = useMemo(() => {
    const out: Live[] = [];
    for (const s of sessions) {
      if (s.nested) continue;
      const att = attention(s, digest);
      if (att.status === "ended") continue;
      if (att.needs || att.status === "busy") out.push({ s, att });
    }
    // Needs you first, then by name (stable while the list is open).
    return out.sort((a, b) => Number(!!b.att.needs) - Number(!!a.att.needs) || displayTitle(a.s).localeCompare(displayTitle(b.s)));
  }, [sessions, digest]);
  const needs = live.filter((l) => l.att.needs).length;
  const working = live.length - needs;
  if (!live.length) return null;
  return (
    <div className="relative ml-2 shrink-0" data-running-pill={`${working}/${needs}`}>
      <button
        type="button"
        data-pop-anchor
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Sessions working or waiting on you"
        className={cx(
          "flex h-[26px] items-center gap-2 rounded-full border px-2.5 text-small tnum transition-colors duration-150",
          open ? "border-line bg-raised text-fg" : "border-hairline text-dim hover:border-line hover:text-fg",
        )}
      >
        {working > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="size-[6px] rounded-full bg-[var(--status-running)]" />
            {working} working
          </span>
        )}
        {working > 0 && needs > 0 && <span className="text-faint">·</span>}
        {needs > 0 && (
          <span className="flex items-center gap-1.5 text-needs-text">
            <span className="size-[6px] rounded-full bg-[var(--status-needs)]" />
            {needs} need{needs === 1 ? "s" : ""} you
          </span>
        )}
        <span className="sr-only">{runningLabel(working, needs)}</span>
      </button>
      <Popover open={open} onClose={close} align="end" width={380} className="max-h-[min(460px,calc(100vh-80px))] overflow-y-auto">
        <div className="flex h-[36px] items-center border-b border-hairline px-3.5 text-small text-dim">{runningLabel(working, needs)}</div>
        <div className="py-1" data-running-list>
          {live.map((l) => (
            <LiveRow key={sessionKey(l.s)} l={l} onDone={close} />
          ))}
        </div>
        {open && <AwakeFooter />}
      </Popover>
    </div>
  );
}

/** A quiet line on whether coool is keeping the Mac awake (Settings > General), read while the list is open. */
function AwakeFooter() {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      Promise.all([api().lidStatus().catch(() => null), api().powerStatus().catch(() => null)]).then(([lid, power]) => {
        if (live) setText(pillText(lid, power));
      });
    void read();
    const t = setInterval(read, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={() => useStore.getState().openSettings("general")}
      className="flex w-full items-center gap-2 border-t border-hairline px-3.5 py-2 text-left text-small text-faint transition-colors hover:text-dim"
      title="Settings > General"
      data-running-awake
    >
      <span className="size-[5px] shrink-0 rounded-full bg-faint/70" />
      {text}
    </button>
  );
}

function LiveRow({ l, onDone }: { l: Live; onDone: () => void }) {
  const openTarget = useStore((st) => st.open);
  const { s, att } = l;
  const since = useStore((st) => st.since[sessionKey(s)]?.statusAt ?? null);
  const age = useClock((now) => (since === null ? "" : compactSpan(now - since)));
  const steps = useMemo(() => turnTotals(s).tools, [s]);
  const cur = !att.needs && s.current && !isThinking(s.current) ? stepParts(s.current) : null;
  const doing = att.needs ? att.needs : att.background ? att.background : cur ? `${cur.name}${cur.detail ? ` ${shortDetail(cur.detail)}` : ""}` : "Thinking";
  const open = () => {
    openTarget({ kind: "session", key: sessionKey(s) });
    onDone();
  };
  return (
    <div className="group relative flex items-center gap-2.5 px-3.5 py-1.5 hover:bg-hover focus-within:bg-hover" data-running-row={sessionKey(s)}>
      <span className="flex w-[16px] shrink-0 justify-center self-start pt-[5px]">
        <StatusDot status={att.needs ? "needs" : "busy"} size={8} />
      </span>
      <button type="button" onClick={open} className="min-w-0 flex-1 text-left">
        <span className="flex min-w-0 items-center gap-1.5">
          <ProviderMark provider={s.provider} size={12} />
          <span className="min-w-0 truncate text-base text-fg">{displayTitle(s)}</span>
        </span>
        <span className={cx("block truncate text-small", att.needs ? "text-needs-text" : "text-dim")} title={doing}>
          <span className="text-faint">{folderName(projectOf(s))} · </span>
          {doing}
        </span>
      </button>
      {/* At rest: the turn's step count. On hover or keyboard focus, Open and Stop take its place. */}
      <span className="w-[56px] shrink-0 text-right text-small text-faint tnum group-focus-within:invisible group-hover:invisible" title={`${steps} step${steps === 1 ? "" : "s"} this turn${age ? ` · ${att.needs ? "waiting" : "working"} for ${age}` : ""}`}>
        {steps > 0 ? `${steps} step${steps === 1 ? "" : "s"}` : age}
      </span>
      <span className="absolute inset-y-0 right-0 hidden items-center gap-0.5 pl-8 pr-3 group-focus-within:flex group-hover:flex" style={{ background: "linear-gradient(var(--hover), var(--hover)), var(--raised)", maskImage: "linear-gradient(to right, transparent, black 26px)", WebkitMaskImage: "linear-gradient(to right, transparent, black 26px)" }}>
        <button type="button" onClick={open} className="flex h-[26px] shrink-0 items-center rounded-[7px] px-2 text-small text-dim transition-colors hover:bg-press hover:text-fg" data-running-open>
          Open
        </button>
        <button
          type="button"
          title="Stop this session"
          aria-label="Stop"
          onClick={() => {
            askStop(s, null, displayTitle(s), s.chat);
            onDone();
          }}
          className="flex h-[26px] shrink-0 items-center gap-1 rounded-[7px] px-2 text-small text-dim transition-colors hover:bg-press hover:text-err-text"
          data-running-stop
        >
          <IStop size={11} />
          Stop
        </button>
      </span>
    </div>
  );
}
