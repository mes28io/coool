// The shimmering label of live work ("Thinking", the active step, "Running 3 steps"): the text, and a highlight copy
// of it seen through a moving band. Both move by transform only, so the compositor runs it (styles.css `.shimmer`).
// Static (the text in the highlight colour, no band) in a static AnimateScope and under reduced motion.
import type { CSSProperties } from "react";
import { cx } from "./primitives";

export function Shimmer({ children, className, style }: { children: string; className?: string; style?: CSSProperties }) {
  return (
    <span className={cx("shimmer", className)} style={style}>
      {children}
      <span className="shimmer-band" aria-hidden>
        <span className="shimmer-hi">{children}</span>
      </span>
    </span>
  );
}
