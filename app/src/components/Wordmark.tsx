import { cx } from "./primitives";

/** The name "coool" in Pally. Static: no intro, no hover animation. */
export function Wordmark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-label="coool"
      role="img"
      className={cx("font-wordmark inline-block select-none whitespace-pre font-bold leading-none tracking-[-0.01em] text-fg", className)}
      style={{ fontSize: size, lineHeight: 1.1 }}
    >
      coool
    </span>
  );
}
