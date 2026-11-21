import { AnimatePresence, motion } from "motion/react";
import { useEffect, type ReactNode } from "react";
import { api } from "../lib/backend";
import { useStore, type Sheet } from "../store";
import { NewSession } from "./NewSession";
import { Button, cx } from "./primitives";

export function Sheets() {
  const sheet = useStore((s) => s.sheet);
  const setSheet = useStore((s) => s.setSheet);
  const close = () => setSheet(null);
  return (
    <AnimatePresence>
      {sheet && (
        <motion.div
          key={sheet.kind}
          className={cx("fixed inset-0 z-50 flex items-start justify-center", sheet.kind === "new" ? "pt-[max(24px,5vh)]" : "pt-[14vh]")}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.14 } }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-[var(--backdrop)] backdrop-blur-[2px]" onMouseDown={close} />
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.99, transition: { duration: 0.14 } }}
            transition={{ type: "spring", stiffness: 460, damping: 36 }}
            className={cx(
              "relative max-w-[calc(100vw-32px)] overflow-hidden rounded-[18px] border border-line bg-raised shadow-pop",
              sheet.kind === "new" ? "h-[min(740px,calc(100vh-48px))] w-[1040px] stacked:h-[min(960px,calc(100vh-120px))]" : "w-[480px]",
            )}
            onKeyDown={(e) => e.key === "Escape" && close()}
          >
            <SheetBody sheet={sheet} close={close} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SheetBody({ sheet, close }: { sheet: NonNullable<Sheet>; close: () => void }) {
  if (sheet.kind === "new") return <NewSession initialCwd={sheet.cwd} initialProvider={sheet.provider} close={close} />;
  if (sheet.kind === "quit") return <QuitConfirm running={sheet.running} close={close} />;
  return <StopConfirm label={sheet.label} managed={sheet.managed} pid={sheet.pid} chat={sheet.chat ?? null} close={close} />;
}

function Confirm({ title, body, action, danger, onConfirm, close }: { title: string; body: ReactNode; action: string; danger?: boolean; onConfirm: () => void; close: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      } else if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onConfirm, close]);
  return (
    <div>
      <div className="px-4 pb-3 pt-4">
        <div className="text-title font-semibold tracking-[-0.01em]">{title}</div>
        <div className="mt-1 text-base text-dim">{body}</div>
      </div>
      <div className="flex justify-end gap-2 border-t border-hairline bg-panel/60 px-4 py-3">
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>
          {action}
        </Button>
      </div>
    </div>
  );
}

function QuitConfirm({ running, close }: { running: number; close: () => void }) {
  return (
    <Confirm
      title="Quit coool?"
      body={`${running} ${running === 1 ? "session is" : "sessions are"} running inside coool and will be stopped. Their transcripts stay on disk, so you can resume them later.`}
      action="Stop and quit"
      danger
      onConfirm={() => api().quit()}
      close={close}
    />
  );
}

function StopConfirm({ label, managed, pid, chat, close }: { label: string; managed: number | null; pid: number | null; chat: number | null; close: () => void }) {
  const toast = useStore((s) => s.toast);
  return (
    <Confirm
      title={`Stop “${label.length > 48 ? label.slice(0, 47) + "…" : label}”?`}
      body={
        chat !== null
          ? "Ends the CLI process behind this chat. The transcript stays on disk, so you can resume it later."
          : managed !== null
            ? "The CLI process coool launched will be terminated. You can resume the session afterwards."
            : `Sends SIGTERM to process ${pid}, which is running outside coool.`
      }
      action="Stop session"
      danger
      onConfirm={async () => {
        close();
        try {
          if (chat !== null) await api().chatStop(chat);
          else await api().stopSession({ managed, pid });
          toast("Stop signal sent");
        } catch (e) {
          toast(String(e), "error");
        }
      }}
      close={close}
    />
  );
}
