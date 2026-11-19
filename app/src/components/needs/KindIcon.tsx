// The needs-tinted square that says what kind of request an item is (list rows and the detail header).

import type { NeedKind } from "../../lib/needs";
import { IAgent, IFile, IGlobe, IList, IMac, IPencil, IPhone, IPlug, ISpark, ITerminal } from "../icons";
import { cx } from "../primitives";

export function KindIcon({ kind, device, size = 24, className }: { kind: NeedKind; device?: "browser" | "iphone" | "mac"; size?: number; className?: string }) {
  const g = Math.round(size * 0.58);
  const icon =
    kind === "device" ? (
      device === "iphone" ? <IPhone size={g} /> : device === "mac" ? <IMac size={g} /> : <IGlobe size={g} />
    ) : kind === "command" || kind === "terminal" ? (
      <ITerminal size={g} />
    ) : kind === "edit" ? (
      <IPencil size={g} />
    ) : kind === "write" ? (
      <IFile size={g} />
    ) : kind === "fetch" ? (
      <IGlobe size={g} />
    ) : kind === "plan" ? (
      <IList size={g} />
    ) : kind === "job" ? (
      <IAgent size={g} />
    ) : kind === "insight" ? (
      <ISpark size={g} />
    ) : kind === "question" ? (
      <span className="font-bold leading-none" style={{ fontSize: Math.round(size * 0.55) }}>
        ?
      </span>
    ) : (
      <IPlug size={g} />
    );
  return (
    <span
      className={cx("flex shrink-0 items-center justify-center bg-[color-mix(in_oklab,var(--status-needs)_16%,transparent)] text-needs-text", className)}
      style={{ width: size, height: size, borderRadius: Math.round(size / 4) }}
      aria-hidden
    >
      {icon}
    </span>
  );
}
