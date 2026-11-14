import type { SVGProps } from "react";

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

export const IPlus = mk(<path d="M8 3.5v9M3.5 8h9" />);
export const IClose = mk(<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />);
export const IChevron = mk(<path d="M6 4l4 4-4 4" />);
export const ISearch = mk(
  <>
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.2 10.2L13 13" />
  </>,
);
export const ITerminal = mk(
  <>
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <path d="M5 6.5l2 1.5-2 1.5M8.5 10H11" />
  </>,
);
export const IActivity = mk(<path d="M2 8.5h2.5l1.5-4 3 7 1.5-3H14" />);
export const IGrid = mk(
  <>
    <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2" />
    <rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2" />
    <rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2" />
    <rect x="9" y="9" width="4.5" height="4.5" rx="1.2" />
  </>,
);
export const ISplitRight = mk(
  <>
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <path d="M8 2.5v11" />
  </>,
);
export const ISplitDown = mk(
  <>
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <path d="M2 8h12" />
  </>,
);
export const ISun = mk(
  <>
    <circle cx="8" cy="8" r="2.75" />
    <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" />
  </>,
);
export const IMoon = mk(<path d="M13 9.6A5.25 5.25 0 016.4 3a5.25 5.25 0 106.6 6.6z" />);
export const IStop = mk(<rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.6" />);
export const IPlay = mk(<path d="M5 3.8v8.4a.6.6 0 00.9.5l6.6-4.2a.6.6 0 000-1L5.9 3.3a.6.6 0 00-.9.5z" />);
export const IFolder = mk(<path d="M2.25 5V11.5a1.5 1.5 0 001.5 1.5h8.5a1.5 1.5 0 001.5-1.5V6.5A1.5 1.5 0 0012.25 5H8L6.5 3.25H3.75A1.5 1.5 0 002.25 4.75z" />);
export const IFile = mk(
  <>
    <path d="M4 2.25h5L12 5.25V13a.75.75 0 01-.75.75h-7.5A.75.75 0 013 13V3A.75.75 0 013.75 2.25z" />
    <path d="M8.75 2.25V5.5H12" />
  </>,
);
export const IPencil = mk(<path d="M10.5 2.75l2.75 2.75L6 12.75 2.75 13.25 3.25 10z" />);
export const IGlobe = mk(
  <>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M2.25 8h11.5M8 2.25c1.6 1.6 2.4 3.5 2.4 5.75S9.6 12.15 8 13.75C6.4 12.15 5.6 10.25 5.6 8S6.4 3.85 8 2.25z" />
  </>,
);
export const ISpark = mk(<path d="M8 2l1.3 3.7L13 7l-3.7 1.3L8 12l-1.3-3.7L3 7l3.7-1.3z" />);
export const IAlert = mk(
  <>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 5v3.5M8 10.9v.1" />
  </>,
);
export const ICheck = mk(<path d="M3.5 8.5l3 3 6-7" />);
export const IReturn = mk(<path d="M12.5 4v3.5a2 2 0 01-2 2h-7M6 7l-2.5 2.5L6 12" />);
export const IStack = mk(
  <>
    <path d="M8 2.5l5.5 2.75L8 8 2.5 5.25z" />
    <path d="M2.5 8L8 10.75 13.5 8M2.5 10.75L8 13.5l5.5-2.75" />
  </>,
);
export const ICommand = mk(<path d="M6 6V4.5A1.5 1.5 0 104.5 6H6zm0 0h4m-4 0v4m4-4V4.5A1.5 1.5 0 1111.5 6H10zm0 0v4m0 0h1.5a1.5 1.5 0 11-1.5 1.5V10zm0 0H6m0 0v1.5A1.5 1.5 0 114.5 10H6z" />);
export const IGear = mk(
  <>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.42 3.58l-1.06 1.06M4.64 11.36l-1.06 1.06M12.42 12.42l-1.06-1.06M4.64 4.64L3.58 3.58" />
    <circle cx="8" cy="8" r="4.25" />
  </>,
);
export const IArrowUp = mk(<path d="M8 13V3.5M4 7.5l4-4 4 4" />);

export const IHome = mk(<path d="M2.75 7.25L8 2.75l5.25 4.5V12.5a.75.75 0 01-.75.75H10V9.5H6v3.75H3.5a.75.75 0 01-.75-.75z" />);
export const IBell = mk(<path d="M4 11V7.25a4 4 0 118 0V11l1 1.5H3zM6.75 14a1.4 1.4 0 002.5 0" />);
export const ICompose = mk(<path d="M7 3H4.25A1.5 1.5 0 002.75 4.5v7.25a1.5 1.5 0 001.5 1.5H11.5a1.5 1.5 0 001.5-1.5V9M10.9 2.9l2.2 2.2L7.6 10.6 5.2 11l.4-2.4z" />);
export const IFolderOpen = mk(<path d="M2.25 11.5V4.75a1.5 1.5 0 011.5-1.5H6l1.4 1.75h4.1a1.5 1.5 0 011.5 1.5V6.5M2.25 11.5l1.4-4.1a1 1 0 01.95-.7h8.9a.75.75 0 01.72.97l-1.2 4.1a1.5 1.5 0 01-1.44 1.08H3.75a1.5 1.5 0 01-1.5-1.5z" />);
export const ISidebar = mk(
  <>
    <rect x="2.25" y="3" width="11.5" height="10" rx="2" />
    <path d="M6.25 3v10" />
  </>,
);

export function toolIcon(name: string) {
  const n = name.toLowerCase();
  if (/(bash|shell|exec|command)/.test(n)) return ITerminal;
  if (/(edit|write|notebook|apply_patch|patch)/.test(n)) return IPencil;
  if (/(read|view)/.test(n)) return IFile;
  if (/(grep|glob|search|find|rg)/.test(n)) return ISearch;
  if (/web|fetch|url/.test(n)) return IGlobe;
  if (/agent|task/.test(n)) return ISpark;
  return IStack;
}
