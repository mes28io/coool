// The right-hand slot of a session: one panel at a time (Jobs, Models, the browser or the iPhone) in one frame.
// The frame animates its width open / closed; switching panels cross-fades inside it. On a portrait window the frame
// can sit below the chat instead (`axis` "y", lib/layoutRules.ts), animating its height.

import { AnimatePresence, motion } from "motion/react";
import { useRef, useState, type ReactNode } from "react";
import { translucent, useGlass, useGlassHole } from "../lib/glass";
import type { RightPanelKind } from "../store";
import { cx, spring } from "./primitives";
import { reducedMotion } from "./StepRail";

export type RightKind = RightPanelKind;

/**
 * Every right panel (the device panels, Jobs, Models) has the frosted glass background when the window's glass or
 * colour backdrop is on (lib/glass.ts): a tint over what is behind; the cards inside stay opaque.
 */

export function RightPanel({
  which,
  width,
  axis = "x",
  height = 0,
  dragging,
  onWidth,
  onHeight,
  onDragging,
  onClose,
  children,
}: {
  /** The panel showing, or null when closed (the last one stays mounted while the frame closes). */
  which: RightKind | null;
  /** Each kind's width (the browser is wider than Jobs / Models). */
  width: (kind: RightKind) => number;
  /**
   * "x": beside the chat, on its right (landscape, always). "y": below the chat at the pane's full width (a portrait
   * window, lib/layoutRules.ts `panelAxis`); the frame then animates its height and the divider is its bottom edge.
   */
  axis?: "x" | "y";
  /** The panel's height when `axis` is "y". */
  height?: number;
  dragging: boolean;
  onWidth: (kind: RightKind, w: number) => void;
  /** A dragged height (`axis` "y"); -1 asks for the kind's default (double-click on the divider). */
  onHeight?: (kind: RightKind, h: number) => void;
  onDragging: (d: boolean) => void;
  onClose: () => void;
  /** `active`: this kind is the one showing (false while it fades out or the frame closes). */
  children: (kind: RightKind, active: boolean) => ReactNode;
}) {
  const start = useRef<{ at: number; size: number } | null>(null);
  const last = useRef<RightKind>("agents");
  if (which) last.current = which;
  const kind = last.current;
  const open = which !== null;
  const y = axis === "y";
  const w = width(kind);
  const h = height;
  // Switching between beside and below (the window rotated) snaps: a frame growing on one axis while shrinking on
  // the other would sweep across the chat.
  const [shownAxis, setShownAxis] = useState(axis);
  const flipped = shownAxis !== axis;
  if (flipped) setShownAxis(axis);
  const fade = { duration: reducedMotion() ? 0 : 0.2 };
  const glass = translucent(useGlass());
  const [aside, setAside] = useState<HTMLElement | null>(null);
  useGlassHole(aside, glass);
  return (
    <motion.aside
      ref={setAside}
      initial={false}
      animate={y ? { width: "100%", height: open ? h : 0 } : { width: open ? w : 0, height: "100%" }}
      transition={dragging || flipped || reducedMotion() ? { duration: 0 } : spring}
      className="relative shrink-0 overflow-hidden"
      aria-hidden={!open}
      inert={!open}
      data-right-panel={open ? kind : "closed"}
      data-panel-axis={axis}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        className={cx(y ? "absolute inset-x-0 top-0 border-t" : "absolute inset-y-0 left-0 border-l", glass ? "border-glass-line bg-side-glass" : "border-hairline bg-panel")}
        style={y ? { height: h } : { width: w }}
        data-glass={glass || undefined}
      >
        <AnimatePresence initial={false}>
          <motion.div key={kind} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
            {children(kind, open && which === kind)}
          </motion.div>
        </AnimatePresence>
        {/* Drag the edge that faces the chat to resize: the left one beside it, the top one below it. */}
        <div
          className={cx("group absolute z-10", y ? "inset-x-0 top-0 h-[6px] cursor-row-resize" : "inset-y-0 left-0 w-[6px] cursor-col-resize")}
          title={y ? "Drag to resize · double-click for the default height" : undefined}
          data-panel-divider={axis}
          onPointerDown={(e) => {
            start.current = { at: y ? e.clientY : e.clientX, size: y ? h : w };
            onDragging(true);
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const s = start.current;
            if (!s) return;
            if (y) onHeight?.(kind, s.size + s.at - e.clientY);
            else onWidth(kind, s.size + s.at - e.clientX);
          }}
          onPointerUp={() => {
            start.current = null;
            onDragging(false);
          }}
          onDoubleClick={() => y && onHeight?.(kind, -1)}
        >
          <div className={cx("bg-fg opacity-0 transition-opacity duration-150 group-hover:opacity-40", y ? "absolute inset-x-0 top-0 h-[2px]" : "h-full w-[2px]")} />
        </div>
      </div>
    </motion.aside>
  );
}
