// The right-hand slot of a session: one panel at a time (Jobs, Models or the browser) in one frame.
// The frame animates its width open / closed; switching panels cross-fades inside it.

import { AnimatePresence, motion } from "motion/react";
import { useRef, type ReactNode } from "react";
import type { RightPanelKind } from "../store";
import { spring } from "./primitives";
import { reducedMotion } from "./StepRail";

export type RightKind = RightPanelKind;

export function RightPanel({
  which,
  width,
  dragging,
  onWidth,
  onDragging,
  onClose,
  children,
}: {
  /** The panel showing, or null when closed (the last one stays mounted while the frame closes). */
  which: RightKind | null;
  /** Each kind's width (the browser is wider than Jobs / Models). */
  width: (kind: RightKind) => number;
  dragging: boolean;
  onWidth: (kind: RightKind, w: number) => void;
  onDragging: (d: boolean) => void;
  onClose: () => void;
  /** `active`: this kind is the one showing (false while it fades out or the frame closes). */
  children: (kind: RightKind, active: boolean) => ReactNode;
}) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const last = useRef<RightKind>("agents");
  if (which) last.current = which;
  const kind = last.current;
  const open = which !== null;
  const w = width(kind);
  const fade = { duration: reducedMotion() ? 0 : 0.2 };
  return (
    <motion.aside
      initial={false}
      animate={{ width: open ? w : 0 }}
      transition={dragging || reducedMotion() ? { duration: 0 } : spring}
      className="relative h-full shrink-0 overflow-hidden"
      aria-hidden={!open}
      inert={!open}
      data-right-panel={open ? kind : "closed"}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="absolute inset-y-0 left-0 border-l border-hairline bg-panel" style={{ width: w }}>
        <AnimatePresence initial={false}>
          <motion.div key={kind} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
            {children(kind, open && which === kind)}
          </motion.div>
        </AnimatePresence>
        {/* Drag the left edge to resize. */}
        <div
          className="group absolute inset-y-0 left-0 z-10 w-[6px] cursor-col-resize"
          onPointerDown={(e) => {
            start.current = { x: e.clientX, w };
            onDragging(true);
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => start.current && onWidth(kind, start.current.w + start.current.x - e.clientX)}
          onPointerUp={() => {
            start.current = null;
            onDragging(false);
          }}
        >
          <div className="h-full w-[2px] bg-fg opacity-0 transition-opacity duration-150 group-hover:opacity-40" />
        </div>
      </div>
    </motion.aside>
  );
}
