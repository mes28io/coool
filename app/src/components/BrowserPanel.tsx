// The browser panel: the right panel's third kind (next to Jobs and Models). It shows one page per session:
// a Claude Code artifact's local copy in a sandboxed frame, or a web page (a claude.ai artifact link, a link from
// the chat) in a native child webview laid over the panel's body (lib/browser.ts, app/src-tauri/src/browser.rs).

import { createElement, useEffect, useRef, useState } from "react";
import { api } from "../lib/backend";
import { hide, nativeId, onOverlays, overlayCovers, place, useBrowserState } from "../lib/browser";
import type { ArtifactInfo } from "../lib/types";
import { useStore, type BrowserPage } from "../store";
import { artifactIcon } from "./ArtifactCard";
import { IBack, IClose, IExternal, IForward, IGlobe, IRefresh } from "./icons";
import { cx, IconButton } from "./primitives";

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function BrowserPanel({ panelKey, page, active, onClose }: { panelKey: string; page: BrowserPage; active: boolean; onClose: () => void }) {
  const st = useBrowserState((s) => s.byKey[panelKey]);
  const openBrowser = useStore((s) => s.openBrowser);
  const [frameKey, setFrameKey] = useState(0);
  const web = page.kind === "web";
  const native = web && api().nativeBrowser;
  const url = web ? st?.url || page.url : page.info.url;
  const title = web ? st?.title || host(url) : page.info.title;
  const go = (a: "back" | "forward" | "reload") => {
    const id = nativeId(panelKey);
    if (id) void api().browserGo(id, a).catch(() => {});
  };
  const openExternal = () => {
    if (!web) return void api().openArtifact(page.info.url).catch(() => {});
    const id = nativeId(panelKey);
    if (native && id) void api().browserOpenExternal(id).catch((e) => useStore.getState().toast(`Couldn't open it: ${e}`, "error"));
    else if (!native) window.open(url, "_blank", "noopener");
  };
  return (
    <div className="flex h-full flex-col" data-browser-panel={page.kind}>
      <div className="flex h-[44px] shrink-0 items-center gap-0.5 border-b border-hairline pl-2 pr-1.5">
        <IconButton title="Back" disabled={!native || !st?.can_back} onClick={() => go("back")}>
          <IBack size={15} />
        </IconButton>
        <IconButton title="Forward" disabled={!native || !st?.can_forward} onClick={() => go("forward")}>
          <IForward size={15} />
        </IconButton>
        <IconButton title="Reload" onClick={() => (native ? go("reload") : setFrameKey((k) => k + 1))}>
          <IRefresh size={15} className={cx(native && st?.loading && "animate-spin [animation-duration:1.2s]")} />
        </IconButton>
        <div className="ml-1.5 min-w-0 flex-1 leading-tight" title={url}>
          <div className="flex min-w-0 items-center gap-1.5">
            {!web && createElement(artifactIcon(page.info.icon), { size: 13, className: "shrink-0 text-dim" })}
            <span className="truncate text-small font-medium text-fg" data-browser-title>
              {title}
            </span>
          </div>
          <div className="truncate text-micro text-faint" data-browser-url={url}>
            {web ? url.replace(/^https?:\/\//, "") : `Local copy${page.info.version != null ? ` · v${page.info.version}` : ""}${page.versions > 1 ? ` · ${page.versions} versions` : ""}`}
          </div>
        </div>
        {!web && (
          <IconButton title={`Open ${host(page.info.url)} here (sign in to claude.ai once)`} onClick={() => openBrowser(panelKey, { kind: "web", url: page.info.url })}>
            <IGlobe size={15} />
          </IconButton>
        )}
        <IconButton title="Open in default browser" onClick={openExternal}>
          <IExternal size={15} />
        </IconButton>
        <IconButton title="Close" onClick={onClose}>
          <IClose size={14} />
        </IconButton>
      </div>
      <div className="relative min-h-0 flex-1">
        {page.kind === "artifact" ? (
          <ArtifactFrame key={frameKey} info={page.info} />
        ) : native ? (
          <NativeHost panelKey={panelKey} page={page} active={active} loading={!st || st.loading} />
        ) : (
          <iframe key={`${page.n}:${frameKey}`} title={title} src={page.url} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" className="absolute inset-0 size-full border-0 bg-white" />
        )}
      </div>
    </div>
  );
}

/** The artifact's local copy in a sandboxed frame: scripts run, but no same-origin, no top navigation, no popups, no IPC. */
function ArtifactFrame({ info }: { info: ArtifactInfo }) {
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
  if (!src) return <div className="flex h-full items-center justify-center text-base text-dim">{src === null ? "Local copy no longer available" : "Loading…"}</div>;
  return <iframe title={info.title} src={src} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="" className="absolute inset-0 size-full border-0 bg-white" data-artifact-frame={info.url} />;
}

/**
 * The spot the native webview covers. Its rect follows layout (ResizeObserver on it and its panel, window resizes,
 * then a few animation frames while springs settle); it is visible only while the panel shows it, fully open,
 * nothing (sheet, palette, popover) draws over it, and the window is visible.
 */
function NativeHost({ panelKey, page, active, loading }: { panelKey: string; page: Extract<BrowserPage, { kind: "web" }>; active: boolean; loading: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const covered = useStore((s) => s.palette || s.sheet !== null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const panel = el.closest<HTMLElement>("[data-right-panel]");
    let raf = 0;
    let until = 0;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const clip = panel?.getBoundingClientRect();
      // Fully inside its panel: not while the panel slides open or closed (the page shows once it has settled).
      const inside = !!clip && r.left >= clip.left - 0.5 && r.right <= clip.right + 0.5 && r.width >= 40 && r.height >= 40;
      // The panel already switched kind (this one is fading out).
      const shown = panel?.dataset.rightPanel === "browser";
      const visible = active && shown && !covered && document.visibilityState === "visible" && inside && !overlayCovers(r);
      place(panelKey, page, { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), visible });
    };
    const tick = () => {
      measure();
      raf = performance.now() < until ? requestAnimationFrame(tick) : 0;
    };
    const kick = () => {
      until = performance.now() + 600;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const ro = new ResizeObserver(kick);
    ro.observe(el);
    if (panel) ro.observe(panel);
    if (panel?.parentElement) ro.observe(panel.parentElement);
    ro.observe(document.documentElement);
    const mo = new MutationObserver(kick);
    if (panel) mo.observe(panel, { attributes: true, attributeFilter: ["data-right-panel"] });
    window.addEventListener("resize", kick);
    document.addEventListener("visibilitychange", kick);
    const offOverlays = onOverlays(kick);
    measure();
    kick();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", kick);
      document.removeEventListener("visibilitychange", kick);
      offOverlays();
    };
  }, [panelKey, page, active, covered]);
  // Hidden (not closed) when this view goes: another tab, another panel kind, the pane closed.
  useEffect(() => () => hide(panelKey), [panelKey]);
  // In-page navigations (pushState, hash changes) announce nothing: ask now and then while it is on screen.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      const id = nativeId(panelKey);
      if (id && document.visibilityState === "visible") void api().browserPoll(id).catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [panelKey, active]);
  return (
    // Clear of the panel's left edge, so its resize handle stays above the native view.
    <div ref={ref} className="absolute inset-y-0 left-[5px] right-0 flex items-center justify-center bg-panel" data-browser-native={panelKey}>
      {loading && <span className="text-small text-faint">Loading {host(page.url)}…</span>}
    </div>
  );
}
