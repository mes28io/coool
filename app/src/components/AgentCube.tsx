// The subagent's identity mark: an isometric cube on the 16 grid (hexagon outline, three inner edges,
// vertices on half-pixels). It says WHAT the thing is (an agent); the mood glyphs say what it is doing.
// Running: the three faces light in turn (top, left, right) over a 2.4 s loop, the top lifting 0.5px.
// Done: top face filled, dim. Failed: red, no fill. Stopped: dim and dashed. `plain` is static and
// takes its colour from the parent (step rows). Motion lives in moodGlyph.css; reduced motion is static.
import { cx } from "./primitives";
import "./moodGlyph.css";

export type CubeState = "live" | "done" | "failed" | "stopped" | "plain";

const TOP = "M8 1.5L13.5 4.5L8 7.5L2.5 4.5Z";
const LEFT = "M2.5 4.5L8 7.5V14.5L2.5 11.5Z";
const RIGHT = "M8 7.5L13.5 4.5V11.5L8 14.5Z";
const HEX = "M8 1.5L13.5 4.5V11.5L8 14.5L2.5 11.5V4.5Z";
const EDGES = "M2.5 4.5L8 7.5L13.5 4.5M8 7.5V14.5";

const TONE: Record<CubeState, string> = { live: "text-working-text", done: "text-dim", failed: "text-err-text", stopped: "text-dim", plain: "" };

export function AgentCube({ size = 14, state = "plain", className }: { size?: number; state?: CubeState; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("ac shrink-0 transition-colors duration-300", TONE[state], className)}
      data-agent-cube={state}
      aria-hidden
    >
      {state === "live" ? (
        <>
          <path d={TOP} className="ac-face ac-top" fill="currentColor" stroke="none" />
          <path d={LEFT} className="ac-face ac-left" fill="currentColor" stroke="none" />
          <path d={RIGHT} className="ac-face ac-right" fill="currentColor" stroke="none" />
        </>
      ) : state === "done" || state === "plain" ? (
        <path d={TOP} fill="currentColor" fillOpacity={0.18} stroke="none" />
      ) : null}
      <g strokeDasharray={state === "stopped" ? "2 1.6" : undefined} opacity={state === "stopped" ? 0.8 : undefined}>
        <path d={HEX} />
        <path d={EDGES} />
      </g>
    </svg>
  );
}
