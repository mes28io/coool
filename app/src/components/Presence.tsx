// Agent presence in the device panels (APP_SPEC "Agent presence"; lib/presence.ts): each acting agent's cursor,
// gliding to where it acts, with a label that says who it is and what it is doing; and the beam, a light that
// travels around the panel's frame while an agent drives (libraries.dev's Border Beam, the `border-beam` package). The Browser panel's page is a native view above the app's
// HTML, so its cursors are drawn by the page script (device/web_agent.js, the same arrow and label); its beam is here.

import { BorderBeam, type BorderBeamProps } from "border-beam";
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMotion } from "../lib/motion";
import { usePresenceOf, FADE_MS, type Cursor } from "../lib/presence";
import { glideMs } from "../lib/presenceWords";
import { useStore } from "../store";
import { ProviderMark } from "./primitives";

/** The cursor's arrow (tip at 1.5,1.7 of a 14x18 box); the page script draws the same path. */
const ARROW = "M2.6 1.7C2.1 1.3 1.5 1.6 1.5 2.2V15.6C1.5 16.2 2.2 16.5 2.7 16.1L6.1 12.8C6.3 12.6 6.6 12.5 6.9 12.5H11.9C12.5 12.5 12.8 11.8 12.4 11.3Z";
/** coool's pilot glyph (device/presence.rs `PILOT_MARK`). */
const PILOT = "M8 1.6 13.6 14a.5.5 0 0 1-.7.6L8 12.1l-4.9 2.5a.5.5 0 0 1-.7-.6L8 1.6Z";
/** Quick out, calm landing, no overshoot. */
const GLIDE = "cubic-bezier(0.22, 0.75, 0.2, 1)";
const SWIPE_MS = 300;

export const tint = (slot: number) => `var(--presence-${slot % 3})`;

export function PilotMark({ size = 9, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden>
      <path d={PILOT} fill="currentColor" />
    </svg>
  );
}

function useSize(el: HTMLElement | null) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return box;
}

/**
 * The cursors of `target`'s actors over a streamed screen (iPhone, Mac). `d`: the device's own coordinate space
 * (points, guest pixels), mapped onto this layer's box (the scaled screen).
 */
export function PresenceLayer({ target, d }: { target: string; d: { w: number; h: number } }) {
  const p = usePresenceOf(target);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const box = useSize(el);
  return (
    <div ref={setEl} className="pointer-events-none absolute inset-0" data-presence-layer={target}>
      {box.w > 0 && p.cursors.map((c) => <AgentCursor key={c.key} c={c} d={d} box={box} />)}
    </div>
  );
}

/** Where the element's transform puts it now (mid-glide too). */
function currentAt(el: HTMLElement): { x: number; y: number } | null {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return null;
  const m = new DOMMatrixReadOnly(t);
  return { x: m.m41, y: m.m42 };
}

function AgentCursor({ c, d, box }: { c: Cursor; d: { w: number; h: number }; box: { w: number; h: number } }) {
  const g = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  const done = useRef("");
  const [flip, setFlip] = useState({ left: false, up: false });
  const reduce = useMotion().reduce;
  const sx = box.w / (d.w || 1);
  const sy = box.h / (d.h || 1);

  useLayoutEffect(() => {
    const el = g.current;
    // One glide per move (and a re-placement on a resize), not on every render.
    const step = `${c.move}|${box.w}|${box.h}`;
    if (!el || done.current === step) return;
    done.current = step;
    // Not placed yet (it has only read the screen so far): it waits a little below the middle.
    const tx = c.x == null ? box.w * 0.5 : c.x * sx;
    const ty = c.y == null ? box.h * 0.56 : c.y * sy;
    const now = placed.current ? currentAt(el) : null;
    // The first time: it comes in from a little way toward the middle, so even the first action is seen arriving.
    const from = now ?? { x: tx + (box.w / 2 - tx) * 0.35, y: ty + (box.h * 0.6 - ty) * 0.35 };
    placed.current = true;
    for (const a of el.getAnimations()) a.cancel();
    const ms = reduce ? 0 : glideMs(Math.hypot(tx - from.x, ty - from.y));
    const at = (x: number, y: number) => `translate(${x}px, ${y}px)`;
    const swipe = c.x2 != null && c.y2 != null;
    const ex = swipe ? c.x2! * sx : tx;
    const ey = swipe ? c.y2! * sy : ty;
    el.style.transform = at(ex, ey);
    if (!reduce) {
      const drag = swipe ? SWIPE_MS : 0;
      const frames: Keyframe[] = [{ transform: at(from.x, from.y), easing: GLIDE }, { transform: at(tx, ty), offset: ms / (ms + drag || 1), easing: "cubic-bezier(0.4, 0, 0.2, 1)" }];
      if (swipe) frames.push({ transform: at(ex, ey) });
      if (ms + drag > 0) el.animate(frames, { duration: ms + drag });
      if (c.kind === "tap" || c.kind === "click" || swipe) ring.current?.animate([{ transform: "translate(-50%, -50%) scale(.35)", opacity: 0.9 }, { transform: "translate(-50%, -50%) scale(1.5)", opacity: 0 }], { duration: 440, delay: ms, easing: "cubic-bezier(.2,.7,.3,1)", fill: "backwards" });
      if (!now) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: Math.max(120, ms * 0.6) });
    }
    // The label changes side (near an edge) once the cursor is there, not while it travels.
    const lw = label.current?.offsetWidth ?? 150;
    const lh = label.current?.offsetHeight ?? 36;
    const side = { left: ex + 16 + lw > box.w - 4, up: ey + 20 + lh > box.h - 4 };
    const t = setTimeout(() => setFlip((f) => (f.left === side.left && f.up === side.up ? f : side)), reduce ? 0 : ms);
    return () => clearTimeout(t);
  }, [c.move, c.x, c.y, c.x2, c.y2, c.kind, box.w, box.h, sx, sy, reduce]);

  const color = tint(c.slot);
  const leaving = c.phase === "leaving";
  return (
    <div
      ref={g}
      className="absolute left-0 top-0 will-change-transform"
      style={{ opacity: leaving ? 0 : 1, transition: `opacity ${reduce ? 120 : FADE_MS}ms ease-out` }}
      data-presence-cursor={c.key}
      data-presence-phase={c.phase}
    >
      <div ref={ring} className="absolute left-0 top-0 size-[24px] rounded-full border-2 opacity-0" style={{ borderColor: color, transform: "translate(-50%, -50%)" }} />
      <svg width="14" height="18" viewBox="0 0 14 18" className="absolute -left-[1.5px] -top-[1.7px] overflow-visible drop-shadow-[0_1px_1.5px_rgb(0_0_0/0.28)]" aria-hidden>
        <path d={ARROW} fill={color} stroke="#fff" strokeWidth={1.6} strokeLinejoin="round" paintOrder="stroke" />
      </svg>
      <div
        ref={label}
        className="absolute flex max-w-[220px] flex-col gap-px whitespace-nowrap rounded-[9px] pb-[6px] pl-[7px] pr-[9px] pt-[5px] text-white shadow-[inset_0_0_0_0.5px_rgb(255_255_255/0.25),0_6px_16px_-6px_rgb(0_0_0/0.4),0_1px_3px_rgb(0_0_0/0.18)]"
        style={{ background: color, left: flip.left ? undefined : 13, right: flip.left ? 4 : undefined, top: flip.up ? undefined : 17, bottom: flip.up ? 4 : undefined }}
        data-presence-label
      >
        <div className="flex items-center gap-[5px] text-[10.5px] font-medium leading-[13px] text-white/85">
          <span className="flex size-[13px] shrink-0 items-center justify-center rounded-full bg-white text-[#0d0d0d]">
            {c.by === "pilot" ? <PilotMark size={9} className="text-[var(--status-running)]" /> : c.provider ? <ProviderMark provider={c.provider} size={9} className="!text-[#0d0d0d]" /> : <span className="size-[5px] rounded-full" style={{ background: color }} />}
          </span>
          <span data-presence-who>{c.who}</span>
        </div>
        <div className="truncate text-[12px] font-semibold leading-[15px]" data-presence-say>
          {c.say}
        </div>
      </div>
    </div>
  );
}

/**
 * The beam's look: libraries.dev's Border Beam (`border-beam`, pinned), as its site shows it by default. One place to
 * change its size (`md`, `sm`, `line`, `pulse-inner`, `pulse-outside`), colours (`colorful`, `mono`, `ocean`,
 * `sunset`, …) and strength.
 */
export const BEAM = { size: "md", colorVariant: "colorful", strength: 0.7 } as const satisfies Pick<BorderBeamProps, "size" | "colorVariant" | "strength">;

/**
 * The beam around a panel's frame: wraps the frame (its one child) and, while `on`, a light travels around its border
 * (`border-beam`, drawn inside the wrapper's edge). It starts with the first action and fades shortly after the last.
 * Reduced motion: no travelling light; a static ring in the acting agent's tint instead. `mark`: a data attribute set
 * while it drives (the self-tests look for it). Extra props (style, className, handlers) go to the wrapper.
 */
export function PanelBeam({
  on,
  slot = 0,
  radius,
  mark = "data-sim-driving",
  children,
  style,
  className,
}: {
  on: boolean;
  slot?: number;
  radius: number;
  mark?: string;
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  const reduce = useMotion().reduce;
  const theme = useStore((s) => s.theme);
  return (
    <BorderBeam {...BEAM} active={on && !reduce} theme={theme} borderRadius={radius} className={className} style={style} {...(on ? { [mark]: true } : {})}>
      {children}
      {on && reduce && (
        <div className="pointer-events-none absolute inset-0 z-[4]" style={{ borderRadius: radius, boxShadow: `inset 0 0 0 2px ${tint(slot)}` }} data-presence-static aria-hidden />
      )}
    </BorderBeam>
  );
}
