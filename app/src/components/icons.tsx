import type { SVGProps } from "react";
import { AgentMark } from "./AgentMark";

/*
 * coool's icon set: original drawings made in the style of Vercel's Geist icons (no Geist paths are copied).
 * Rules inferred from that set and used for every icon here:
 * - 16x16 viewBox, drawn with a 1.5 stroke in currentColor, no fills (except tiny dots, which are filled r=.75-1 circles).
 * - Round ends: round caps and round joins everywhere, as in Geist (soft line ends and corners, never spiky).
 * - Big and quiet: ~1px of air inside the box; frames run on the 1.75 / 14.25 lines, circles are r 6.25 at the centre.
 * - Small corner radii: 1-1.5 on frames, 1 on small tiles; geometry is straight lines, 45-degree diagonals and arcs.
 * - Pixel grid: straight strokes sit on .25 / .75 centre lines so both edges land on whole device pixels at 2x;
 *   symmetric marks (plus, arrows, dividers) stay on the true centre (8) instead.
 * - Metaphors kept literal and minimal: chevrons are open 90-degree corners, arrows are a shaft + open corner head,
 *   containers (terminal, split, sidebar) are a rounded frame with one divider.
 */

type P = SVGProps<SVGSVGElement> & { size?: number };

const base = (size = 16, p: P) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...p,
});

const mk = (d: React.ReactNode) =>
  function Icon({ size, ...p }: P) {
    return <svg {...base(size, p)}>{d}</svg>;
  };

/** A filled dot (bullets, the point of "!"). */
const dot = (cx: number, cy: number, r = 0.9) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />;

export const IPlus = mk(<path d="M8 1.75v12.5M1.75 8h12.5" />);
export const IClose = mk(<path d="M3.25 3.25l9.5 9.5M12.75 3.25l-9.5 9.5" />);
/** Points right; call sites rotate it. */
export const IChevron = mk(<path d="M5.75 3.25L10.5 8l-4.75 4.75" />);
export const ISearch = mk(
  <>
    <circle cx="6.75" cy="6.75" r="5" />
    <path d="M10.5 10.5l3.75 3.75" />
  </>,
);
export const ITerminal = mk(
  <>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
    <path d="M4.75 6l2 2-2 2M8.25 10.25h3" />
  </>,
);
export const IActivity = mk(<path d="M1 8.25h3l1.75-4.5 3.5 8.5 1.75-4H15" strokeLinejoin="round" />);
export const IGrid = mk(
  <>
    <rect x="1.75" y="1.75" width="4.5" height="4.5" rx="1" />
    <rect x="9.75" y="1.75" width="4.5" height="4.5" rx="1" />
    <rect x="1.75" y="9.75" width="4.5" height="4.5" rx="1" />
    <rect x="9.75" y="9.75" width="4.5" height="4.5" rx="1" />
  </>,
);
export const ISplitRight = mk(
  <>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
    <path d="M8 2.75v10.5" />
  </>,
);
export const ISplitDown = mk(
  <>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
    <path d="M1.75 8h12.5" />
  </>,
);
export const ISun = mk(
  <>
    <circle cx="8" cy="8" r="2.75" />
    <path d="M8 1v1.75M8 13.25V15M1 8h1.75M13.25 8H15M3.05 3.05l1.24 1.24M11.71 11.71l1.24 1.24M3.05 12.95l1.24-1.24M11.71 4.29l1.24-1.24" />
  </>,
);
export const IMoon = mk(<path d="M14 9.75A6 6 0 016.25 2 6.25 6.25 0 1014 9.75z" />);
export const IStop = mk(<rect x="3.75" y="3.75" width="8.5" height="8.5" rx="1.25" />);
export const IPlay = mk(<path d="M4.75 2.75v10.5L12.75 8z" />);
export const IFolder = mk(<path d="M1.75 3.75a1 1 0 011-1h3.69l1.5 1.5h5.31a1 1 0 011 1v7a1 1 0 01-1 1H2.75a1 1 0 01-1-1z" />);
export const IFile = mk(<path d="M2.75 1.75h6l4.5 4.5v8H2.75zM8.75 1.75v4.5h4.5" />);
export const IPencil = mk(<path d="M10.5 2.25l3.25 3.25-8.25 8.25H2.25V10.5zM8.75 4l3.25 3.25" />);
export const IGlobe = mk(
  <>
    <circle cx="8" cy="8" r="6.25" />
    {/* One wide pointed lens and the equator: three lines with room between them (narrower lenses read dark). */}
    <path d="M8 1.75c-2 2-3 3.9-3 6.25s1 4.25 3 6.25M8 1.75c2 2 3 3.9 3 6.25s-1 4.25-3 6.25M1.75 8h12.5" />
  </>,
);
export const ISpark = mk(<path d="M8 1.75l1.5 4.75 4.75 1.5-4.75 1.5L8 14.25 6.5 9.5 1.75 8 6.5 6.5z" strokeLinejoin="round" />);
export const IAlert = mk(
  <>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 4.25v4.5" />
    {dot(8, 11.25)}
  </>,
);
export const ICheck = mk(<path d="M2.75 8.5L6.25 12l7-7.5" />);
export const IReturn = mk(<path d="M13.25 2.75v5a1.5 1.5 0 01-1.5 1.5H3.25M6.25 6.25l-3 3 3 3" />);
export const IStack = mk(<path d="M8 1.75l6 3.25-6 3.25L2 5zM2 8l6 3.25L14 8M2 11l6 3.25L14 11" />);
export const ICommand = mk(
  <path d="M5.75 5.75h4.5v4.5h-4.5zM5.75 5.75V4A1.75 1.75 0 104 5.75h1.75M10.25 5.75V4A1.75 1.75 0 1112 5.75h-1.75M10.25 10.25V12A1.75 1.75 0 1012 10.25h-1.75M5.75 10.25V12A1.75 1.75 0 114 10.25h1.75" />,
);
/** Settings: two sliders (minimal, as Geist draws settings). */
export const IGear = mk(
  <>
    <path d="M1.75 5h6.5M12.75 5h1.5M1.75 11h1.5M7.75 11h6.5" />
    <circle cx="10.5" cy="5" r="2.25" />
    <circle cx="5.5" cy="11" r="2.25" />
  </>,
);
export const IArrowDown = mk(<path d="M8 1.75V13M3.75 9.25L8 13.5l4.25-4.25" />);
export const IArrowUp = mk(<path d="M8 14.25V3M3.75 6.75L8 2.5l4.25 4.25" />);

/** Home: just the house outline, no door. */
export const IHome = mk(<path d="M2.25 6.75L8 2l5.75 4.75v6.5a1 1 0 01-1 1H3.25a1 1 0 01-1-1z" />);
export const IBell = mk(<path d="M3.25 11.25V6.5a4.75 4.75 0 019.5 0v4.75l1.5 1.5H1.75zM6.25 14.75h3.5" />);
export const ICompose = mk(<path d="M7.25 2.75h-4a1.5 1.5 0 00-1.5 1.5v8.5a1.5 1.5 0 001.5 1.5h8.5a1.5 1.5 0 001.5-1.5v-4M11.75 1.75l2.5 2.5L8.5 10H6V7.5z" />);
export const IFolderOpen = mk(<path d="M1.75 13.25v-9.5a1 1 0 011-1h3.69l1.5 1.5h4.31a1 1 0 011 1v2M1.75 13.25l1.75-6h10.75l-1.75 6z" />);
export const ISidebar = mk(
  <>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
    <path d="M6.25 2.75v10.5" />
  </>,
);

export const IGauge = mk(<path d="M2.59 12.63a6.25 6.25 0 1110.82 0M8 9.5l2.75-3" />);
export const IBack = mk(<path d="M14.25 8H3M6.75 3.75L2.5 8l4.25 4.25" />);
export const IForward = mk(<path d="M1.75 8H13M9.25 3.75L13.5 8l-4.25 4.25" />);
/** Open elsewhere (the system browser). */
export const IExternal = mk(<path d="M6.75 2.75h-3.5a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1v-3.5M9.25 2.25h4.5v4.5M13.75 2.25l-6 6" />);
/** "Open": an arrow leaving up and to the right (Jobs cards). */
export const IArrowUpRight = mk(<path d="M3.75 12.25l8-8M5.25 4.25h6.5v6.5" />);
/** The "!" of the Needs-you badge, without a frame. */
export const IExclaim = mk(
  <>
    <path d="M8 2v7.75" />
    {dot(8, 13, 1.1)}
  </>,
);
/** A small dropdown caret: a flatter open corner than IChevron, pointing down. */
export const ICaret = mk(<path d="M3.75 6l4.25 4.25L12.25 6" />);
export const IRefresh = mk(<path d="M13.25 8a5.25 5.25 0 11-1.54-3.71M12.25 1.75v3h-3" />);

/** The subagent mark (a cube), static, in the parent's colour. Takes the same props as the stroke icons. */
export function IAgent({ size = 14, className }: P) {
  return <AgentMark size={size} state="plain" className={className} />;
}

export function toolIcon(name: string) {
  const n = name.toLowerCase();
  if (/(bash|shell|exec|command)/.test(n)) return ITerminal;
  if (/(edit|write|notebook|apply_patch|patch)/.test(n)) return IPencil;
  if (/(read|view)/.test(n)) return IFile;
  if (/(grep|glob|search|find|rg)/.test(n)) return ISearch;
  if (/web|fetch|url/.test(n)) return IGlobe;
  if (/agent|task/.test(n)) return IAgent;
  return IStack;
}

/** Two nodes joined by a fork: checkpoints / branches. */
export const IBranch = mk(
  <>
    <circle cx="4.25" cy="3.75" r="1.75" />
    <circle cx="11.75" cy="12.25" r="1.75" />
    <path d="M4.25 5.5v3.25a3.5 3.5 0 003.5 3.5H10" />
  </>,
);

export const IList = mk(
  <>
    <path d="M5.75 3.75h8.5M5.75 8h8.5M5.75 12.25h8.5" />
    {dot(2.5, 3.75)}
    {dot(2.5, 8)}
    {dot(2.5, 12.25)}
  </>,
);
export const ILock = mk(
  <>
    <rect x="2.75" y="7.25" width="10.5" height="7" rx="1.25" />
    <path d="M5 7.25V5a3 3 0 016 0v2.25" />
  </>,
);
export const IBolt = mk(<path d="M9.25 1.75l-6 7.5h4.5l-1 5 6-7.5h-4.5z" strokeLinejoin="round" />);
