import { useEffect, useRef } from "react";
import { copyText, onContext } from "../lib/contextMenu";
import { terminalMenu } from "../lib/menus/panels";
import { attachTerminal, clearTerminal, focusTerminal, pasteIntoTerminal, selectAllInTerminal, terminalSelection } from "../lib/terminals";
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
      <div ref={host} className="term-host absolute inset-0 left-4 right-1 top-3 bottom-2" onMouseDown={() => focusTerminal(pty)}
        // xterm selects the word under a right click (macOS); this adds the menu. It is a canvas, so Copy is ours.
        onContextMenu={onContext(() =>
          terminalMenu({
            copyText,
            selection: terminalSelection(pty),
            exited,
            readClipboard: () => navigator.clipboard.readText(),
            paste: (t) => pasteIntoTerminal(pty, t),
            selectAll: () => selectAllInTerminal(pty),
            clear: () => clearTerminal(pty),
          }),
        )}
      />
      {exited && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <span className="rounded-full border border-line bg-raised/90 px-3 py-1 text-small text-dim shadow-card backdrop-blur">Process exited</span>
        </div>
      )}
    </div>
  );
}
