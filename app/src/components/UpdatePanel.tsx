// The updater in the rail: one icon above the usage ring (hidden while everything is current), and the small panel
// it opens listing coool, Claude Code and Codex. The backend does the work (app/src-tauri/src/update/).

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/backend";
import { useChats } from "../lib/chat";
import { registerOverlay } from "../lib/overlays";
import { checkNow, useUpdates } from "../lib/update";
import { itemLine, percent, railLabel, railUpdate, stopLine, type UpdateItem } from "../lib/updateView";
import { useStore } from "../store";
import { Command } from "./settings/ui";
import { IAlert, IArrowDown, ICheck } from "./icons";
import { Button, cx, ease, ProviderMark } from "./primitives";

/** Chats and terminal sessions coool runs (what a restart stops), as the quit confirmation counts them. */
function useWorking(): number {
  const chats = useChats((s) => Object.values(s.chats).filter((c) => c.running).length);
  const ptys = useStore((s) => Object.values(s.ptys).filter((p) => p.running && !s.exited[p.id]).length);
  return chats + ptys;
}

/** The rail's update icon: a blue spinner while it works, a blue check once coool's update is installed, a blue arrow
 *  when something needs the person. */
export function UpdateButton({ children }: { children: (p: { label: string; onClick: () => void; active: boolean; icon: ReactNode; dot: "bad" | null }) => ReactNode }) {
  const status = useUpdates((s) => s.status);
  const panel = useUpdates((s) => s.panel);
  const setPanel = useUpdates((s) => s.setPanel);
  const kind = railUpdate(status);
  const failed = status?.items.some((i) => i.state === "failed") ?? false;
  const show = kind !== "hidden" || panel;
  const icon =
    kind === "busy" ? (
      <svg aria-hidden width={18} height={18} viewBox="0 0 16 16" className="work-spin text-running" data-update-icon="busy">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.8" />
        <path d="M8 2a6 6 0 016 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ) : kind === "done" ? (
      <span className="flex text-running" data-update-icon="done">
        <ICheck size={20} />
      </span>
    ) : (
      <span className="flex text-running" data-update-icon="attention">
        {failed ? <IAlert size={20} /> : <IArrowDown size={20} />}
      </span>
    );
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key="update"
          className="relative"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: 0.2, ease }}
          data-update-button={kind}
        >
          {children({ label: railLabel(status), onClick: () => setPanel(!panel), active: panel, icon, dot: failed ? "bad" : null })}
          <AnimatePresence>{panel && <Panel key="panel" close={() => setPanel(false)} />}</AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Panel({ close }: { close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const status = useUpdates((s) => s.status);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => (ref.current ? registerOverlay(ref.current) : undefined), []);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest("[data-update-button]")) return;
      close();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    const t = setTimeout(() => window.addEventListener("pointerdown", down, true), 0);
    window.addEventListener("keydown", key);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [close]);
  const check = async () => {
    setChecking(true);
    setErr(await checkNow().catch(() => "coool couldn't check for updates."));
    setChecking(false);
  };
  return (
    <motion.div
      ref={ref}
      role="dialog"
      aria-label="Updates"
      className="absolute bottom-0 left-full z-50 ml-2 w-[360px] overflow-hidden rounded-[14px] border border-line bg-raised text-fg shadow-pop"
      initial={{ opacity: 0, x: -6, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: -4, scale: 0.99, transition: { duration: 0.12 } }}
      transition={{ type: "spring", stiffness: 620, damping: 40 }}
      style={{ transformOrigin: "left bottom" }}
      data-update-panel
    >
      <div className="flex items-center justify-between gap-3 px-4 pb-1.5 pt-3.5">
        <div className="text-base font-semibold">Updates</div>
        <Button variant="ghost" className="h-[28px] px-2 text-small" onClick={check} disabled={checking}>
          {checking ? "Checking…" : "Check now"}
        </Button>
      </div>
      <div className="flex flex-col divide-y divide-hairline px-4 pb-2">
        {(status?.items ?? []).map((i) => (
          <Row key={i.id} item={i} autoApp={status?.auto_app ?? true} blocked={status?.blocked ?? null} />
        ))}
      </div>
      {err && <div className="px-4 pb-3 text-small text-err-text">{err}</div>}
    </motion.div>
  );
}

const DOT: Partial<Record<UpdateItem["state"], string>> = {
  current: "var(--status-waiting)",
  staged: "var(--status-running)",
  downloading: "var(--status-running)",
  installing: "var(--status-running)",
  available: "var(--status-running)",
  waiting: "var(--busy)",
  manual: "var(--busy)",
  failed: "var(--error)",
};

function Mark({ id }: { id: UpdateItem["id"] }) {
  if (id === "coool") return <span className="flex size-[16px] items-center justify-center rounded-[5px] bg-fg font-mono text-[9px] font-bold leading-none text-bg">c</span>;
  return <ProviderMark provider={id} size={16} />;
}

function Row({ item: i, autoApp, blocked }: { item: UpdateItem; autoApp: boolean; blocked: string | null }) {
  const working = useWorking();
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = (f: () => Promise<void>) => {
    setErr(null);
    void f().catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  const pct = percent(i.progress);
  const restart = () => run(() => api().updateRestart());
  let action: ReactNode = null;
  if (i.id === "coool" && i.state === "staged" && !blocked)
    action = (
      <Button variant="primary" className="h-[28px] bg-running! px-2.5 text-small text-white!" onClick={() => (working > 0 ? setConfirm(true) : restart())} data-update-restart>
        Restart
      </Button>
    );
  else if (i.id === "coool" && i.state === "available" && !blocked)
    action = (
      <Button variant="outline" className="h-[28px] px-2.5 text-small" onClick={() => run(() => api().updateInstall())}>
        {autoApp ? "Try again" : "Download"}
      </Button>
    );
  else if (i.id !== "coool" && i.state === "available")
    action = (
      <Button variant="outline" className="h-[28px] px-2.5 text-small" onClick={() => run(() => api().updateCliNow(i.id as "claude" | "codex"))}>
        Update
      </Button>
    );
  return (
    <div className="flex flex-col gap-2 py-3" data-update-item={i.id} data-update-state={i.state}>
      <div className="flex items-center gap-2.5">
        <Mark id={i.id} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-base">
            <span>{i.name}</span>
            {i.method && i.id !== "coool" && <span className="text-small text-faint">· {i.method}</span>}
          </div>
          <div className="flex items-center gap-1.5 text-small text-dim">
            {DOT[i.state] && <span className="size-[6px] shrink-0 rounded-full" style={{ background: DOT[i.state] }} />}
            <span className="truncate tnum">{i.id === "coool" && i.state === "staged" ? `Update installed · restart to apply (${i.current} → ${i.latest})` : itemLine(i)}</span>
          </div>
        </div>
        {action}
      </div>
      {(i.state === "downloading" || i.state === "installing") && (
        <div className="ml-[26px] h-[3px] overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--status-running)_18%,transparent)]">
          <div className="h-full rounded-full bg-running transition-[width] duration-300" style={{ width: `${pct ?? 100}%`, opacity: pct === null ? 0.5 : 1 }} />
        </div>
      )}
      {i.detail && i.state !== "available" && <div className="ml-[26px] text-small text-dim">{i.detail}</div>}
      {i.command && ["waiting", "manual", "failed"].includes(i.state) && (
        <div className="ml-[26px]">
          <Command cmd={i.command} />
        </div>
      )}
      {i.id === "coool" && blocked && i.state !== "current" && i.state !== "unknown" && <div className="ml-[26px] text-small text-faint">{blocked}</div>}
      {confirm && (
        <div className="ml-[26px] flex flex-col gap-2 rounded-[10px] bg-[color-mix(in_oklab,var(--busy)_12%,transparent)] px-3 py-2.5" data-update-confirm>
          <div className="text-small text-fg/90">coool will restart into {i.latest}. {stopLine(working)}</div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" className="h-[28px] px-2.5 text-small" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant="danger" className="h-[28px] px-2.5 text-small" onClick={restart}>
              Stop and restart
            </Button>
          </div>
        </div>
      )}
      {err && <div className={cx("ml-[26px] text-small text-err-text")}>{err}</div>}
    </div>
  );
}
