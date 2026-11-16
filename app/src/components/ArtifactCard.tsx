// Claude Code artifacts: pages a session published to claude.ai with its Artifact tool.
// A card in the timeline (the newest version; earlier publishes of the same page fold into it), and a large sheet
// that previews the local copy in a sandboxed frame. The sheet rather than the right panel: the panel tops out at
// 440px and only shows in panes at least 900px wide, too small to read a page in.

import { createElement, useEffect, useState, type ComponentType } from "react";
import { api } from "../lib/backend";
import type { ArtifactInfo } from "../lib/types";
import { useStore } from "../store";
import { IActivity, IClose, IFile, IGear, IGlobe, IList, ISpark, ITerminal } from "./icons";
import { Button, cx } from "./primitives";

type Icon = ComponentType<{ size?: number; className?: string }>;
const ICONS: [RegExp, Icon][] = [
  [/^(wrench|tool|tools|gear|settings|fix|repair)$/, IGear],
  [/^(chart|graph|dashboard|metrics|stats|data|analytics)$/, IActivity],
  [/^(list|checklist|todo|tasks|plan)$/, IList],
  [/^(map|globe|world|web|site|link)$/, IGlobe],
  [/^(code|terminal|cli|script)$/, ITerminal],
  [/^(spark|idea|magic|star)$/, ISpark],
];
/** The icon word's glyph; anything else (doc, page, recipe, …) is a page. */
export function artifactIcon(word: string | undefined): Icon {
  const w = (word ?? "").toLowerCase();
  return ICONS.find(([re]) => re.test(w))?.[1] ?? IFile;
}

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * For a timeline: per artifact URL, the index of its newest publish, how many versions it has, and that publish's
 * info (an icon word given only on the first publish carries over).
 */
export function artifactVersions<T>(list: T[], info: (t: T) => ArtifactInfo | undefined): Map<string, { last: number; versions: number; info: ArtifactInfo }> {
  const out = new Map<string, { last: number; versions: number; info: ArtifactInfo }>();
  list.forEach((t, i) => {
    const a = info(t);
    if (!a) return;
    const o = out.get(a.url);
    const icon = a.icon ?? o?.info.icon;
    out.set(a.url, { last: i, versions: Math.max((o?.versions ?? 0) + 1, a.version ?? 0), info: icon === a.icon ? a : { ...a, icon } });
  });
  return out;
}

const known = new Map<string, boolean>();
/** Whether the artifact's local page is still on disk (checked on mount and for each new version). */
function useAvailable(a: ArtifactInfo): boolean | null {
  const [ok, setOk] = useState<boolean | null>(known.get(a.url) ?? null);
  useEffect(() => {
    let live = true;
    api()
      .artifactStatus([a.url])
      .then((r) => {
        known.set(a.url, !!r[a.url]);
        if (live) setOk(!!r[a.url]);
      })
      .catch(() => live && setOk(false));
    return () => {
      live = false;
    };
  }, [a.url, a.version]);
  return ok;
}

export function ArtifactCard({ info, versions }: { info: ArtifactInfo; versions: number }) {
  const setSheet = useStore((s) => s.setSheet);
  const available = useAvailable(info);
  const gone = available === false;
  return (
    <div className="my-1 flex max-w-[620px] items-center gap-3 rounded-[12px] border border-line bg-raised py-2.5 pl-3 pr-2.5 shadow-card" data-artifact-card={info.url} data-artifact-available={available === null ? "unknown" : String(available)}>
      <span className="flex size-[36px] shrink-0 items-center justify-center rounded-[9px] bg-[color-mix(in_oklab,var(--dim)_11%,transparent)] text-dim">
        {createElement(artifactIcon(info.icon), { size: 18 })}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-medium text-fg" title={info.title}>
          {info.title}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-small text-faint">
          {info.version != null && <span className="tnum shrink-0 text-dim">v{info.version}</span>}
          {versions > 1 && (
            <>
              <span aria-hidden>·</span>
              <span className="tnum shrink-0">{versions} versions</span>
            </>
          )}
          <span aria-hidden>·</span>
          {gone ? (
            <span className="truncate" data-artifact-gone>
              Local copy no longer available
            </span>
          ) : (
            <span className="truncate" title={info.url}>
              {host(info.url)}
            </span>
          )}
        </div>
      </div>
      <Button
        variant="outline"
        className="h-[30px] px-2.5"
        disabled={available !== true}
        title={gone ? "The local copy is gone (scratch folders get cleaned); Open still works" : "Preview the page here"}
        onClick={() => setSheet({ kind: "artifact", info, versions })}
        data-artifact-preview
      >
        Preview
      </Button>
      <Button variant="ghost" className="h-[30px] px-2.5" title={`Open ${info.url} in the browser`} onClick={() => void api().openArtifact(info.url)} data-artifact-open>
        Open
        <span aria-hidden className="text-faint">
          ↗
        </span>
      </Button>
    </div>
  );
}

/** The page's local copy in a sandboxed frame: scripts run, but no same-origin, no top navigation, no popups, no IPC. */
export function ArtifactSheet({ info, versions, close }: { info: ArtifactInfo; versions: number; close: () => void }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api()
      .artifactPreview(info.url)
      .then((r) => live && setSrc(r.src))
      .catch(() => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [info.url, info.version]);
  return (
    <div className="flex h-full flex-col" data-artifact-sheet={info.url}>
      <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-hairline pl-4 pr-2">
        {createElement(artifactIcon(info.icon), { size: 16, className: "shrink-0 text-dim" })}
        <span className="min-w-0 truncate text-base font-medium text-fg">{info.title}</span>
        <span className="tnum shrink-0 text-small text-faint">
          {info.version != null && `v${info.version}`}
          {versions > 1 && ` · ${versions} versions`}
          {" · "}
          {host(info.url)}
        </span>
        <span className="flex-1" />
        <Button variant="ghost" className="h-[30px] px-2.5" title={`Open ${info.url} in the browser`} onClick={() => void api().openArtifact(info.url)}>
          Open
          <span aria-hidden className="text-faint">
            ↗
          </span>
        </Button>
        <button type="button" onClick={close} title="Close (Esc)" aria-label="Close" className="flex size-[30px] items-center justify-center rounded-[8px] text-dim transition-colors duration-150 hover:bg-hover hover:text-fg">
          <IClose size={16} />
        </button>
      </div>
      <div className={cx("relative min-h-0 flex-1", src ? "bg-white" : "bg-panel")}>
        {src ? (
          <iframe
            title={info.title}
            src={src}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            allow=""
            className="absolute inset-0 size-full border-0"
            data-artifact-frame
          />
        ) : (
          <div className="flex h-full items-center justify-center text-base text-dim">{src === null ? "Local copy no longer available" : "Loading…"}</div>
        )}
      </div>
    </div>
  );
}
