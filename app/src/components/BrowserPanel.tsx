// The browser panel: the right panel's third kind (next to Jobs and Models). Per session it holds tabs (a strip at
// its top); each shows a web page (a claude.ai artifact link, a link from the chat) in a native child webview laid
// over the panel's body (lib/browser.ts, app/src-tauri/src/browser.rs), or, in a new tab, a start view: an address
// field and the pages this chat mentions. Artifact previews open in a window of their own (ArtifactCard.tsx).

import { createElement, useEffect, useRef, useState } from "react";
import { api } from "../lib/backend";
import { addressUrl, closeNative, hide, nativeId, onOverlays, overlayCovers, place, previewArtifact, tabKey, useBrowserState, type RecentPage } from "../lib/browser";
import { useStore, type BrowserPage, type BrowserTab, type BrowserTabs } from "../store";
import { artifactIcon } from "./ArtifactCard";
import { IBack, IClose, IExternal, IForward, IGlobe, IPlus, IRefresh } from "./icons";
import { cx, IconButton } from "./primitives";

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const tabTitle = (t: BrowserTab) => (t.page.kind === "start" ? "New tab" : t.title?.trim() || host(t.url || t.page.url));

export function BrowserPanel({ panelKey, state, active, onClose, recent }: { panelKey: string; state: BrowserTabs; active: boolean; onClose: () => void; recent: RecentPage[] }) {
  const tab = state.tabs.find((t) => t.id === state.active) ?? state.tabs[0];
  const key = tabKey(panelKey, tab.id);
  const st = useBrowserState((s) => s.byKey[key]);
  const navigateBrowserTab = useStore((s) => s.navigateBrowserTab);
  const [frameKey, setFrameKey] = useState(0);
  const page = tab.page;
  const web = page.kind === "web";
  const start = !web;
  const native = web && api().nativeBrowser;
  const url = page.kind === "web" ? st?.url || tab.url || page.url : "";
  const go = (a: "back" | "forward" | "reload") => {
    const id = nativeId(key);
    if (id) void api().browserGo(id, a).catch(() => {});
  };
  const openExternal = () => {
    if (!web) return;
    const id = nativeId(key);
    if (native && id) void api().browserOpenExternal(id).catch((e) => useStore.getState().toast(`Couldn't open it: ${e}`, "error"));
    else if (!native) window.open(url, "_blank", "noopener");
  };
  const open = (u: string) => navigateBrowserTab(panelKey, tab.id, u);
  return (
    <div className="flex h-full flex-col" data-browser-panel={page.kind}>
      <TabStrip panelKey={panelKey} state={state} />
      <div className="flex h-[40px] shrink-0 items-center gap-0.5 border-b border-hairline pl-2 pr-1.5">
        <IconButton title="Back" disabled={!native || !st?.can_back} onClick={() => go("back")}>
          <IBack size={15} />
        </IconButton>
        <IconButton title="Forward" disabled={!native || !st?.can_forward} onClick={() => go("forward")}>
          <IForward size={15} />
        </IconButton>
        <IconButton title="Reload" disabled={start} onClick={() => (native ? go("reload") : setFrameKey((k) => k + 1))}>
          <IRefresh size={15} className={cx(native && st?.loading && "animate-spin [animation-duration:1.2s]")} />
        </IconButton>
        <div className="ml-1.5 min-w-0 flex-1" title={url}>
          {!start && <Address key={key} url={url} shown={url.replace(/^https?:\/\//, "")} onGo={open} />}
        </div>
        <IconButton title="Open in default browser" disabled={start} onClick={openExternal}>
          <IExternal size={15} />
        </IconButton>
        <IconButton title="Close" onClick={onClose}>
          <IClose size={14} />
        </IconButton>
      </div>
      <div className="relative min-h-0 flex-1">
        {page.kind === "start" ? (
          <StartView key={key} recent={recent} onOpen={(p) => (p.kind === "web" ? open(p.url) : previewArtifact(p.info.url, () => open(p.info.url)))} onGo={open} />
        ) : native ? (
          <NativeHost key={key} tabKey={key} page={page} active={active} loading={!st || st.loading} />
        ) : (
          <iframe key={`${key}:${page.n}:${frameKey}`} title={tabTitle(tab)} src={page.url} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" className="absolute inset-0 size-full border-0 bg-white" />
        )}
      </div>
    </div>
  );
}

/** The panel's tabs: click to switch, x (on hover, or a middle click) to close, + for a new tab. */
function TabStrip({ panelKey, state }: { panelKey: string; state: BrowserTabs }) {
  const selectBrowserTab = useStore((s) => s.selectBrowserTab);
  const closeBrowserTab = useStore((s) => s.closeBrowserTab);
  const openBrowser = useStore((s) => s.openBrowser);
  const close = (t: BrowserTab) => {
    closeNative(tabKey(panelKey, t.id));
    closeBrowserTab(panelKey, t.id);
  };
  return (
    <div className="flex h-[36px] shrink-0 items-center gap-1 border-b border-hairline pl-2 pr-1.5" role="tablist" data-browser-tabs={state.tabs.length}>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {state.tabs.map((t) => {
          const on = t.id === state.active;
          const title = tabTitle(t);
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={on}
              tabIndex={0}
              title={t.page.kind === "web" ? `${title}\n${t.url || t.page.url}` : title}
              onClick={() => selectBrowserTab(panelKey, t.id)}
              onAuxClick={(e) => {
                if (e.button === 1) close(t);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  selectBrowserTab(panelKey, t.id);
                }
              }}
              className={cx(
                "group relative flex h-[26px] min-w-[52px] max-w-[180px] flex-1 cursor-default items-center gap-1.5 rounded-[7px] pl-2 pr-1 outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-[var(--dim)]",
                on ? "bg-[color-mix(in_oklab,var(--dim)_13%,transparent)] text-fg" : "text-dim hover:bg-hover hover:text-fg",
              )}
              data-browser-tab={t.id}
              data-browser-tab-active={on || undefined}
            >
              <IGlobe size={12} className="shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate text-micro font-medium" {...(on ? { "data-browser-title": true } : {})}>
                {title}
              </span>
              <button
                type="button"
                title="Close tab"
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  close(t);
                }}
                className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] text-dim opacity-0 transition-opacity duration-150 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                data-browser-tab-close={t.id}
              >
                <IClose size={10} />
              </button>
            </div>
          );
        })}
      </div>
      <IconButton title="New tab" onClick={() => openBrowser(panelKey, { kind: "start" })}>
        <IPlus size={14} />
      </IconButton>
    </div>
  );
}

/**
 * The address line: shows where the page is; click it to type another address (Enter goes there in this tab,
 * Escape puts the old one back). Accepts http(s) URLs and bare domains (https:// is added).
 */
function Address({ url, shown, onGo }: { url: string; shown: string; onGo: (url: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const editing = text !== null;
  const end = () => {
    setText(null);
    setBad(false);
  };
  return (
    <input
      value={editing ? text : shown}
      placeholder="Type an address"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      aria-label="Address"
      title={bad ? "Only http and https addresses open here" : url}
      data-browser-url={url}
      onFocus={(e) => {
        setText(url);
        const el = e.currentTarget;
        requestAnimationFrame(() => el.select());
      }}
      onBlur={end}
      onChange={(e) => {
        setText(e.target.value);
        setBad(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          end();
          e.currentTarget.blur();
        } else if (e.key === "Enter") {
          e.preventDefault();
          const u = addressUrl(text ?? "");
          if (!u) return setBad(true);
          end();
          e.currentTarget.blur();
          onGo(u);
        }
      }}
      className={cx(
        "block h-[26px] w-full truncate rounded-[7px] bg-[color-mix(in_oklab,var(--dim)_7%,transparent)] px-2 text-small outline-none placeholder:text-faint",
        editing ? "bg-[color-mix(in_oklab,var(--dim)_12%,transparent)] text-fg" : "cursor-text text-dim hover:text-fg",
        bad && "text-err-text",
      )}
    />
  );
}

/** Before anything is open: an address field and the pages this chat mentions (its artifacts, the links in its messages), newest first. */
function StartView({ recent, onOpen, onGo }: { recent: RecentPage[]; onOpen: (p: RecentPage) => void; onGo: (url: string) => void }) {
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="absolute inset-0 overflow-y-auto px-4 py-4" data-browser-start>
      <input
        ref={ref}
        value={text}
        placeholder="Type an address, like example.com"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label="Address"
        onChange={(e) => {
          setText(e.target.value);
          setBad(false);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const u = addressUrl(text);
          if (u) onGo(u);
          else setBad(true);
        }}
        className={cx(
          "h-[32px] w-full rounded-[8px] border bg-transparent px-2.5 text-small text-fg outline-none placeholder:text-faint",
          bad ? "border-[var(--error)]" : "border-hairline focus:border-[color-mix(in_oklab,var(--dim)_45%,transparent)]",
        )}
      />
      {bad && <div className="mt-1.5 text-micro text-dim">Only http and https addresses open here.</div>}
      <div className="mt-5 mb-1.5 text-micro font-medium text-faint">From this chat</div>
      {recent.length === 0 ? (
        <div className="text-small text-faint">No pages or links yet.</div>
      ) : (
        <div className="-mx-1.5 flex flex-col">
          {recent.map((p) => {
            const u = p.kind === "web" ? p.url : p.info.url;
            return (
              <button
                key={`${p.kind}:${u}`}
                type="button"
                onClick={() => onOpen(p)}
                title={p.kind === "artifact" ? `Preview ${p.info.title} in its own window (the copy saved on this Mac; its claude.ai page here if that copy is gone)` : u}
                className="flex min-w-0 items-center gap-2 rounded-[7px] px-1.5 py-1.5 text-left transition-colors duration-150 hover:bg-hover"
                data-browser-recent={u}
              >
                {createElement(p.kind === "artifact" ? artifactIcon(p.info.icon) : IGlobe, { size: 14, className: "shrink-0 text-dim" })}
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-small text-fg">{p.kind === "artifact" ? p.info.title : host(u)}</span>
                  <span className="block truncate text-micro text-faint">{p.kind === "artifact" ? `Artifact${p.versions > 1 ? ` · ${p.versions} versions` : ""}` : u.replace(/^https?:\/\//, "")}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The spot the native webview covers. Its rect follows layout (ResizeObserver on it and its panel, window resizes,
 * then a few animation frames while springs settle); it is visible only while the panel shows it, fully open,
 * nothing (sheet, palette, popover) draws over it, and the window is visible.
 */
function NativeHost({ tabKey: viewKey, page, active, loading }: { tabKey: string; page: Extract<BrowserPage, { kind: "web" }>; active: boolean; loading: boolean }) {
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
      place(viewKey, page, { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), visible });
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
  }, [viewKey, page, active, covered]);
  // Hidden (not closed) when this view goes: another browser tab, another pane tab, another panel kind, the pane closed.
  useEffect(() => () => hide(viewKey), [viewKey]);
  // In-page navigations (pushState, hash changes) announce nothing: ask now and then while it is on screen.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      const id = nativeId(viewKey);
      if (id && document.visibilityState === "visible") void api().browserPoll(id).catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [viewKey, active]);
  return (
    // Clear of the panel's left edge, so its resize handle stays above the native view.
    <div ref={ref} className="absolute inset-y-0 left-[5px] right-0 flex items-center justify-center bg-panel" data-browser-native={viewKey}>
      {loading && <span className="text-small text-faint">Loading {host(page.url)}…</span>}
    </div>
  );
}
