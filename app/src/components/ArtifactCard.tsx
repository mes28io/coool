// Claude Code artifacts: pages a session published to claude.ai with its Artifact tool.
// A card in the timeline (the newest version; earlier publishes of the same page fold into it). "Open" shows the
// local copy (or claude.ai when it's gone), "claude.ai" the live page, both in the session's browser panel (BrowserPanel.tsx).

import { createElement, useEffect, useState, type ComponentType } from "react";
import { api } from "../lib/backend";
import { useOpenPage } from "../lib/browser";
import type { ArtifactInfo } from "../lib/types";
import { IActivity, IFile, IGear, IGlobe, IList, ISpark, ITerminal } from "./icons";
import { Button } from "./primitives";

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
  const open = useOpenPage();
  const available = useAvailable(info);
  const gone = available === false;
  const local = available === true;
  // One clear main action: "Open" shows the page beside the chat, from the copy saved on this Mac (instant, no
  // sign-in), or from claude.ai when that copy is gone. "claude.ai" always loads the live page there.
  const openMain = () => (local ? open({ kind: "artifact", info, versions }) : open({ kind: "web", url: info.url }));
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
          <span className="truncate" data-artifact-gone={gone || undefined}>
            {gone ? "Only on claude.ai" : local ? "Saved on this Mac" : host(info.url)}
          </span>
        </div>
      </div>
      <Button
        variant="ghost"
        className="h-[30px] gap-1.5 px-2.5 text-dim"
        title="Load the live page from claude.ai beside the chat (sign in to claude.ai once)"
        onClick={() => open({ kind: "web", url: info.url })}
        data-artifact-open
      >
        <IGlobe size={14} />
        claude.ai
      </Button>
      <Button
        variant="outline"
        className="h-[30px] px-3"
        disabled={available === null}
        title={local ? "Open the page beside the chat, from the copy saved on this Mac" : "Open the page from claude.ai beside the chat"}
        onClick={openMain}
        data-artifact-preview
      >
        Open
      </Button>
    </div>
  );
}
