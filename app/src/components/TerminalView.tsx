import { useEffect, useRef } from "react";
import { attachTerminal, focusTerminal } from "../lib/terminals";
import { useStore } from "../store";

export function TerminalView({ pty, focused }: { pty: number; focused: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const exited = useStore((s) => !!s.exited[pty]);

  useEffect(() => {
    if (!host.current) return;
    return attachTerminal(pty, host.current);
  }, [pty]);

  useEffect(() => {
    if (focused) focusTerminal(pty);
  }, [focused, pty]);

  return (
    <div className="relative h-full bg-bg">
      <div ref={host} className="term-host absolute inset-0 left-4 right-1 top-3 bottom-2" onMouseDown={() => focusTerminal(pty)} />
      {exited && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <span className="rounded-full border border-line bg-raised/90 px-3 py-1 text-small text-dim shadow-card backdrop-blur">Process exited</span>
        </div>
      )}
    </div>
  );
}
