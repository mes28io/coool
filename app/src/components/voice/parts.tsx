// Small pieces of the voice UI: the mic glyph (drawn to icons.tsx's rules), the level meter, the elapsed time, and
// the hint line that says how to finish.

import { memo } from "react";
import type { Chord, HoldKey } from "../../lib/voice/prefs";
import { cx } from "../primitives";

export function IMic({ size = 16, className, strokeWidth = 1.5 }: { size?: number; className?: string; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" />
      <path d="M3.25 7.75a4.75 4.75 0 0 0 9.5 0M8 12.5v1.75" />
    </svg>
  );
}

/**
 * The live level: bars for the last ~2 s of the microphone's level, newest on the right. Each bar is a scaled box
 * (transform only), updated with the level events while listening; nothing loops.
 */
export const Meter = memo(function Meter({ levels, bars = 28, className, tone = "var(--status-needs)" }: { levels: number[]; bars?: number; className?: string; tone?: string }) {
  const tail = levels.slice(-bars);
  const pad = Array.from({ length: bars - tail.length }, () => 0);
  return (
    <span className={cx("flex h-[18px] items-center gap-[2px]", className)} aria-hidden data-voice-meter>
      {[...pad, ...tail].map((l, i) => (
        <span
          key={i}
          className="h-full w-[2.5px] origin-center rounded-full transition-transform duration-75"
          style={{ background: tone, transform: `scaleY(${Math.max(0.12, Math.min(1, l * 1.15)).toFixed(3)})`, opacity: 0.45 + 0.55 * Math.min(1, l * 1.4) }}
        />
      ))}
    </span>
  );
});

export const fmtSecs = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export const HOLD_LABEL: Record<HoldKey, string> = { AltRight: "Right ⌥", MetaRight: "Right ⌘", Fn: "Fn", off: "Off" };

const CODE_LABEL: Record<string, string> = { Space: "Space", Enter: "↵", Backquote: "`", Period: ".", Comma: ",", Slash: "/", Semicolon: ";", Quote: "'" };
export function chordKeys(c: Chord | null): string[] {
  if (!c) return [];
  const k: string[] = [];
  if (c.ctrl) k.push("⌃");
  if (c.alt) k.push("⌥");
  if (c.shift) k.push("⇧");
  if (c.meta) k.push("⌘");
  k.push(CODE_LABEL[c.code] ?? c.code.replace(/^Key|^Digit/, ""));
  return k;
}
