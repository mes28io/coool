import type { SVGProps } from "react";
import { AgentMark } from "./AgentMark";
import { parseMcp } from "../lib/toolNames";

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
/** What a chat starts with (the Context panel): a sheet of instructions behind another. */
export const IContext = mk(<path d="M4.75 1.75h7.5a1 1 0 011 1v8.5M2.75 4.75a1 1 0 011-1h6.5a1 1 0 011 1v8.5a1 1 0 01-1 1h-6.5a1 1 0 01-1-1zM5.25 7.25h3.5M5.25 9.75h3.5M5.25 12.25h2" />);
export const IPencil = mk(<path d="M10.5 2.25l3.25 3.25-8.25 8.25H2.25V10.5zM8.75 4l3.25 3.25" />);
export const IGlobe = mk(
  <>
    <circle cx="8" cy="8" r="6.25" />
    {/* One wide pointed lens and the equator, drawn thinner and a touch lighter so the outline leads and it stays calm. */}
    <path d="M8 1.75c-2 2-3 3.9-3 6.25s1 4.25 3 6.25M8 1.75c2 2 3 3.9 3 6.25s-1 4.25-3 6.25M1.75 8h12.5" strokeWidth={1} opacity={0.8} />
  </>,
);
/** No network (the sandbox Mac's network is off): the globe's outline, crossed out. */
export const IGlobeOff = mk(
  <>
    <path d="M12.42 12.42A6.25 6.25 0 013.58 3.58M5.1 2.47a6.25 6.25 0 018.43 8.43" />
    <path d="M2.25 2.25l11.5 11.5" />
  </>,
);
/** This computer only (the sandbox Mac's host-only network): the globe's outline around a small house. */
export const IGlobeLocal = mk(
  <>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M5.5 8.5L8 6.25l2.5 2.25v2.25h-5z" strokeWidth={1.25} />
  </>,
);
/** iPhone (the right panel's device): a tall rounded frame, the dynamic-island pill drawn thinner and lighter like the globe's lines. */
export const IPhone = mk(
  <>
    <rect x="4.25" y="1.75" width="7.5" height="12.5" rx="2" />
    <path d="M7 3.75h2" strokeWidth={1} opacity={0.8} />
  </>,
);
/** Mac (a sandbox Mac, coming): a laptop, its screen frame over a wider base line. */
export const IMac = mk(
  <>
    <rect x="3.25" y="2.75" width="9.5" height="8" rx="1.25" />
    <path d="M1.75 12.75h12.5" />
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
/** About / information: the alert circle turned over (dot on top). */
export const IInfo = mk(
  <>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 7.25v4" />
    {dot(8, 4.75)}
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
  const mcp = parseMcp(name);
  if (mcp) {
    if (!/^coool[-_]device$/i.test(mcp.server)) return IPlug;
    if (mcp.tool === "pilot_run") return IBolt;
    return mcp.tool.startsWith("browser_") ? IGlobe : mcp.tool.startsWith("mac_") ? IMac : IPhone;
  }
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

/** A commit: a node on a line. */
export const ICommit = mk(
  <>
    <circle cx="8" cy="8" r="2.75" />
    <path d="M1.75 8h3.5M10.75 8h3.5" />
  </>,
);
/** Changes: a page with a line added and a line taken out (the Changes panel). */
export const IDiff = mk(
  <>
    <path d="M4 1.75h5.5l3 3v8.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1Z" />
    <path d="M8 5.5v4M6 7.5h4M6 11.75h4" />
  </>,
);
/** A pull request: a branch that comes back with an arrowhead into its base. */
export const IPullRequest = mk(
  <>
    <circle cx="4.25" cy="3.75" r="1.75" />
    <circle cx="4.25" cy="12.25" r="1.75" />
    <circle cx="11.75" cy="12.25" r="1.75" />
    <path d="M4.25 5.5v5M11.75 10.5V6.25a1.5 1.5 0 00-1.5-1.5H7.5M9 3.25L7.5 4.75 9 6.25" />
  </>,
);
/** A deploy: an arrow leaving a base line. */
export const IDeploy = mk(<path d="M8 10.75V2.25M4.75 5.5L8 2.25l3.25 3.25M2.25 10.25v2.5a1 1 0 001 1h9.5a1 1 0 001-1v-2.5" />);
export const ITrash = mk(<path d="M2.25 4.25h11.5M6.25 4.25v-2h3.5v2M3.75 4.25l.75 9.5h7l.75-9.5M6.5 7v4M9.5 7v4" />);
/** One job handed to many workers: a node fanning out to three. */
export const IFanout = mk(
  <>
    <circle cx="3.5" cy="8" r="1.75" />
    <path d="M5.25 8h2M7.25 8c0-3 1-4.25 3.5-4.25M7.25 8c0 3 1 4.25 3.5 4.25M7.25 8h3.5" />
    {dot(12.75, 3.75)}
    {dot(12.75, 8)}
    {dot(12.75, 12.25)}
  </>,
);
/** Connections (MCP servers, hooks, plugins): a plug, two prongs over a rounded body and its cord. */
export const IPlug = mk(<path d="M5.75 1.75v3M10.25 1.75v3M3.75 4.75h8.5v2a4.25 4.25 0 01-8.5 0zM8 11v3.25" />);
/** Storage: a drive, a wide frame with its light and a label line. */
export const IDisk = mk(
  <>
    <rect x="1.75" y="4.25" width="12.5" height="7.5" rx="1.5" />
    <path d="M4.25 8h3.5" />
    {dot(11.25, 8)}
  </>,
);
/** One file, two agents: two frames offset on the diagonal, overlapping in the middle. */
export const IOverlap = mk(
  <>
    <rect x="1.75" y="1.75" width="8.5" height="8.5" rx="1.25" />
    <rect x="5.75" y="5.75" width="8.5" height="8.5" rx="1.25" />
  </>,
);
/** Time away: a clock face with its hands at ten past. */
export const IClock = mk(
  <>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 4.75V8l2.25 1.5" />
  </>,
);
/** Attach: a paper clip (the composer's attach button). */
export const IClip = mk(<path d="M13.25 7.5l-5.5 5.5a3.18 3.18 0 01-4.5-4.5l5.75-5.75a2.12 2.12 0 013 3l-5.5 5.5a1.06 1.06 0 01-1.5-1.5l5-5" />);
/** A picture: a frame with a sun and a hill. */
export const IImage = mk(
  <>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
    <circle cx="5.75" cy="6.25" r="1.25" />
    <path d="M1.75 11.25l3.5-3 3 2.5 2.25-1.75 3.75 3" />
  </>,
);
/** Zoom in / out: a lens with a plus or a minus. */
export const IZoomIn = mk(
  <>
    <circle cx="6.75" cy="6.75" r="5" />
    <path d="M10.5 10.5l3.75 3.75M4.75 6.75h4M6.75 4.75v4" />
  </>,
);
export const IZoomOut = mk(
  <>
    <circle cx="6.75" cy="6.75" r="5" />
    <path d="M10.5 10.5l3.75 3.75M4.75 6.75h4" />
  </>,
);
/** Fit to the window: four corners pointing out. */
export const IFit = mk(<path d="M2.25 6V2.25H6M10 2.25h3.75V6M13.75 10v3.75H10M6 13.75H2.25V10" />);
/** Copy: two overlapping sheets. */
export const ICopy = mk(
  <>
    <rect x="5.25" y="5.25" width="9" height="9" rx="1.5" />
    <path d="M10.75 2.75v-.25a.75.75 0 00-.75-.75H2.5a.75.75 0 00-.75.75V10a.75.75 0 00.75.75h.25" />
  </>,
);

/** A favourite (pinned) folder: a five-point star, its tips rounded. */
export const IStar = mk(<path d="M8 1.9l1.8 3.75 4.1.55-3 2.85.75 4.1L8 11.15l-3.65 2 .75-4.1-3-2.85 4.1-.55z" />);

/** A folder with a plus: New folder. */
export const IFolderPlus = mk(
  <>
    <path d="M14.25 8V5.25a1 1 0 00-1-1H8L6.5 2.5H2.75a1 1 0 00-1 1v8.75a1 1 0 001 1H8" />
    <path d="M12 10.25v4M10 12.25h4" />
  </>,
);
