// Media on screen (CHAT_SPEC "Media"): what an agent shows in its reply (`show`: pictures, playable videos, sound
// players, a PDF's first page), local pictures a reply embeds, a video the person attached, the chat's Media panel
// (everything in the chat, newest first, by kind) and the viewer (pictures, video and sound playback, arrows between
// items, Copy and Reveal in Finder). Rules: lib/mediaRules.ts; URLs: lib/media.ts (`coool-media://`, checked by the
// backend against what the chat references). Thumbnails and players load only once they are near the screen.

import { overlayRef } from "../lib/overlays";
import { AnimatePresence, motion } from "motion/react";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { api, type MediaGrant } from "../lib/backend";
import { loadImage } from "../lib/attach";
import { tokenOf, useGrant, type MediaScope } from "../lib/media";
import { onContext } from "../lib/contextMenu";
import { mediaMenu } from "../lib/menus/misc";
import { baseName, fmtTime, frameHeight, mediaKind, sameFile, shownOf, SOURCE_LABEL, type MediaItem, type MediaKind } from "../lib/mediaRules";
import { fmtSize } from "../lib/attachRules";
import type { Attachment } from "../lib/attachRules";
import type { Provider } from "../lib/types";
import { IBack, IClose, ICopy, IExternal, IFile, IFilm, IFolderOpen, IForward, IGallery, IImage, IPause, IPlay, IRefresh, ISpark, IWave } from "./icons";
import { cx } from "./primitives";

// ---------- whose media ----------

/** The chat a view's media belong to (SessionView provides it); `provider` / `session` load attached images by key. */
export const MediaContext = createContext<{ scope: MediaScope | null; provider: Provider | null; session: string | null; cwd?: string; all?: () => MediaItem[] }>({ scope: null, provider: null, session: null });

/** True once the element has come near the screen (stays true). */
function useNear<T extends Element>(): [React.RefCallback<T>, boolean] {
  const [el, setEl] = useState<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!el || near) return;
    if (typeof IntersectionObserver === "undefined") return setNear(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [el, near]);
  return [setEl, near];
}

/** Where an item's bytes come from: a granted file, or an attached image by key. */
function useSource(item: MediaItem | null, on = true): { g: MediaGrant | null; src: string | null; thumb: string | null; failed: string | null } {
  const ctx = useContext(MediaContext);
  const g = useGrant(ctx.scope, item?.key ? undefined : item?.path, on);
  const [keyed, setKeyed] = useState<{ key: string; src: string | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!item?.key || !on) return;
    let live = true;
    loadImage(item.key, ctx.provider, ctx.session).then(
      (src) => live && setKeyed({ key: item.key!, src, failed: false }),
      () => live && setKeyed({ key: item.key!, src: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [item?.key, on]); // eslint-disable-line react-hooks/exhaustive-deps
  if (item?.key) {
    const k = keyed?.key === item.key ? keyed : null;
    return { g: null, src: k?.src ?? null, thumb: k?.src ?? null, failed: k?.failed ? "the image isn’t available any more" : null };
  }
  return { g, src: g?.url ?? null, thumb: g?.thumb ?? null, failed: g?.error ?? null };
}

/** The right-click menu of a shown item (copy and reveal only for a served file: an attached picture by key has no token). */
function useItemMenu(item: MediaItem, g: MediaGrant | null, onOpen: () => void) {
  return onContext(() => mediaMenu({ name: item.name, path: item.path, token: tokenOf(g), open: onOpen, copy: (t) => void api().mediaCopy([t]).catch(() => {}), reveal: (t) => void api().mediaReveal(t).catch(() => {}) }));
}

const KIND_ICON: Record<MediaKind, (p: { size?: number; className?: string }) => React.ReactNode> = { image: IImage, video: IFilm, audio: IWave, pdf: IFile, explainer: ISpark };

function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spin inline-block rounded-full border-[1.5px] border-current border-t-transparent" style={{ width: size, height: size }} aria-hidden />;
}

// ---------- the viewer ----------

type Viewing = { items: MediaItem[]; index: number; ctx: React.ContextType<typeof MediaContext> } | null;
export const useMediaViewer = create<{ v: Viewing; open(v: Viewing): void }>((set) => ({ v: null, open: (v) => set({ v }) }));

/**
 * Opens the viewer at `items[index]`, with the chat they belong to. The arrows then go across all of the chat's
 * media in the order they came (when the view knows them), else across `items`.
 */
export function useOpenMedia() {
  const ctx = useContext(MediaContext);
  return useCallback(
    (items: MediaItem[], index: number) => {
      const all = ctx.all?.().slice().reverse() ?? [];
      const it = items[index];
      const at = it ? all.findIndex((x) => sameFile(x, it, ctx.cwd)) : -1;
      if (at >= 0) return useMediaViewer.getState().open({ items: all.map((x, j) => (j === at ? { ...x, caption: it.caption ?? x.caption } : x)), index: at, ctx });
      useMediaViewer.getState().open({ items, index, ctx });
    },
    [ctx],
  );
}

export function MediaViewer() {
  const v = useMediaViewer((s) => s.v);
  const close = useCallback(() => useMediaViewer.getState().open(null), []);
  return (
    <AnimatePresence>
      {v && (
        <MediaContext.Provider key="mv" value={v.ctx}>
          <Viewer items={v.items} start={v.index} onClose={close} />
        </MediaContext.Provider>
      )}
    </AnimatePresence>
  );
}

function ViewButton({ title, onClick, children, label, disabled }: { title: string; onClick: () => void; children: React.ReactNode; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      data-media-button={label}
      className="flex h-[30px] min-w-[30px] items-center justify-center gap-1.5 rounded-[9px] px-1.5 text-small font-medium text-dim transition-[background-color,color] duration-150 hover:bg-hover hover:text-fg disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Viewer({ items, start, onClose }: { items: MediaItem[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(Math.min(start, items.length - 1));
  const [dir, setDir] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const it = items[i];
  const { g, src, failed } = useSource(it);
  const many = items.length > 1;
  const go = useCallback(
    (d: number) => {
      if (!many) return;
      setDir(d);
      setI((x) => (x + d + items.length) % items.length);
    },
    [many, items.length],
  );
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") return e.preventDefault(), e.stopPropagation(), onClose();
      // Arrows move between items unless a player has the focus (its own seek).
      const inPlayer = (e.target as HTMLElement)?.closest?.("video,audio,input");
      if (e.key === "ArrowRight" && !inPlayer) return e.preventDefault(), go(1);
      if (e.key === "ArrowLeft" && !inPlayer) return e.preventDefault(), go(-1);
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [go, onClose]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 1600);
    return () => clearTimeout(t);
  }, [note]);
  const token = tokenOf(g);
  const Icon = KIND_ICON[it.kind];
  return (
    <motion.div ref={overlayRef} className="fixed inset-0 z-[90] flex flex-col" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.14 } }} transition={{ duration: 0.18 }} data-media-viewer={i} data-media-kind={it.kind} role="dialog" aria-label={it.name}>
      <div className="absolute inset-0 bg-[var(--backdrop)] backdrop-blur-[14px]" onClick={onClose} />
      <div className="relative z-10 flex h-[52px] shrink-0 items-center gap-3 px-4">
        <div className="flex min-w-0 items-center gap-2 rounded-[11px] border border-hairline bg-raised px-3 py-1.5 shadow-pop">
          <Icon size={14} className="shrink-0 text-faint" />
          <span className="truncate text-small font-medium text-fg" title={g?.real ?? it.path ?? it.name}>
            {it.name}
          </span>
          <span className="shrink-0 text-small text-faint">{SOURCE_LABEL[it.source]}</span>
          {many && (
            <span className="shrink-0 text-small text-faint tnum" data-media-count>
              {i + 1} of {items.length}
            </span>
          )}
          {!!g?.size && <span className="shrink-0 text-small text-faint tnum">{fmtSize(g.size)}</span>}
        </div>
        {note && <span className="rounded-[9px] bg-raised px-2.5 py-1 text-small text-dim shadow-pop" data-media-note>{note}</span>}
        <div className="ml-auto flex items-center gap-0.5 rounded-[11px] border border-hairline bg-raised p-0.5 shadow-pop">
          {token && (
            <ViewButton title="Copy the file (paste it in Finder or another app)" label="copy" onClick={() => void api().mediaCopy([token]).then(() => setNote("Copied"), (e) => setNote(String(e)))}>
              <ICopy size={14} />
              <span>Copy</span>
            </ViewButton>
          )}
          {token && (
            <ViewButton title="Reveal in Finder" label="reveal" onClick={() => void api().mediaReveal(token).catch((e) => setNote(String(e)))}>
              <IFolderOpen size={15} />
            </ViewButton>
          )}
          <span className="mx-0.5 h-[18px] w-px bg-[var(--hairline)]" />
          <ViewButton title="Close (Esc)" label="close" onClick={onClose}>
            <IClose size={15} />
          </ViewButton>
        </div>
      </div>
      <div className="relative min-h-0 flex-1" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="absolute inset-0 flex items-center justify-center p-6" onClick={(e) => e.target === e.currentTarget && onClose()}>
          <AnimatePresence initial={false} custom={dir} mode="popLayout">
            <motion.div
              key={it.id}
              className="flex max-h-full max-w-full items-center justify-center"
              initial={{ opacity: 0, scale: 0.97, x: dir * 40 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.98, x: dir * -40, transition: { duration: 0.12 } }}
              transition={{ type: "spring", stiffness: 420, damping: 38 }}
            >
              {failed ? (
                <div className="flex flex-col items-center gap-2 text-faint">
                  <Icon size={22} />
                  <span className="text-small">Can’t show this file: {failed}</span>
                </div>
              ) : !src ? (
                <span className="text-faint"><Spinner size={18} /></span>
              ) : it.kind === "image" ? (
                <img src={src} alt={it.name} className="block max-h-[calc(100vh-170px)] max-w-[calc(100vw-120px)] select-none rounded-[6px] object-contain shadow-pop" data-media-image={it.name} />
              ) : it.kind === "video" ? (
                <video src={src} poster={g?.thumb} controls autoPlay playsInline className="block max-h-[calc(100vh-170px)] max-w-[calc(100vw-120px)] rounded-[8px] bg-black shadow-pop" data-media-video={it.name} />
              ) : it.kind === "audio" ? (
                <div className="w-[min(520px,90vw)]">
                  <AudioPlayer src={src} name={it.name} big autoPlay />
                </div>
              ) : it.kind === "explainer" ? (
                <div className="h-[calc(100vh-170px)] w-[min(1100px,calc(100vw-120px))] overflow-hidden rounded-[10px] border border-hairline bg-bg shadow-pop">
                  <ExplainerFrame src={src} name={it.name} fill />
                </div>
              ) : (
                <PdfPages path={g?.real ?? it.path ?? ""} />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        {many && (
          <>
            <Nav side="left" onClick={() => go(-1)} />
            <Nav side="right" onClick={() => go(1)} />
          </>
        )}
      </div>
      {(it.caption || many) && (
        <div className="relative z-10 flex shrink-0 flex-col items-center gap-2 px-4 pb-4 pt-2">
          {it.caption && <div className="max-w-[720px] text-center text-small text-dim" data-media-caption>{it.caption}</div>}
          {many && (
            <div className="flex max-w-full justify-center gap-1.5 overflow-x-auto" data-media-strip>
              {items.map((x, j) => (
                <StripThumb key={x.id} item={x} on={j === i} onClick={() => (setDir(j > i ? 1 : -1), setI(j))} />
              ))}
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}

function Nav({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={side === "left" ? "Previous (←)" : "Next (→)"}
      data-media-nav={side}
      className={cx(
        "absolute top-1/2 z-10 flex size-[38px] -translate-y-1/2 items-center justify-center rounded-full border border-hairline bg-raised text-dim shadow-pop transition-[color,transform] duration-150 hover:text-fg active:scale-95",
        side === "left" ? "left-4" : "right-4",
      )}
    >
      {side === "left" ? <IBack size={16} /> : <IForward size={16} />}
    </button>
  );
}

function StripThumb({ item, on, onClick }: { item: MediaItem; on: boolean; onClick: () => void }) {
  const { thumb } = useSource(item);
  const Icon = KIND_ICON[item.kind];
  return (
    <button type="button" onClick={onClick} title={item.name} className={cx("relative size-[44px] shrink-0 overflow-hidden rounded-[9px] border-2 bg-raised transition-[border-color,opacity] duration-150", on ? "border-[var(--text)] opacity-100" : "border-transparent opacity-55 hover:opacity-90")}>
      {thumb ? <img src={thumb} alt="" draggable={false} className="size-full object-cover" /> : <span className="flex size-full items-center justify-center text-faint"><Icon size={15} /></span>}
    </button>
  );
}

/** A PDF in the viewer: its pages drawn by the app (Quartz), so the PDF itself never loads in the page. */
function PdfPages({ path }: { path: string }) {
  const [pages, setPages] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void api()
      .attachPreview(path)
      .then((p) => (p.kind === "pdf" ? setPages(p.pages) : setErr("no preview")))
      .catch((e) => setErr(String(e)));
  }, [path]);
  if (err) return <span className="text-small text-faint">{err}</span>;
  if (!pages) return <span className="text-faint"><Spinner size={18} /></span>;
  return (
    <div className="scroll max-h-[calc(100vh-170px)] w-[min(820px,90vw)] space-y-4 rounded-[10px] p-2" data-media-pdf={pages.length}>
      {pages.map((s, k) => (
        <img key={k} src={s} alt={`Page ${k + 1}`} className="w-full rounded-[4px] border border-hairline bg-white shadow-card" />
      ))}
    </div>
  );
}

// ---------- players ----------

/** A sound: play / pause, a scrubber, the time. Its bytes load only when played (`preload="none"`). */
export function AudioPlayer({ src, name, big, autoPlay, sub }: { src: string; name: string; big?: boolean; autoPlay?: boolean; sub?: string }) {
  const el = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [d, setD] = useState(0);
  const toggle = () => {
    const a = el.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => {});
    else a.pause();
  };
  const frac = d > 0 ? Math.min(1, t / d) : 0;
  return (
    <div className={cx("flex items-center gap-3 rounded-[14px] border border-hairline bg-raised shadow-card", big ? "px-4 py-3.5" : "px-3 py-2.5")} data-media-audio={name} data-media-playing={playing || undefined}>
      <audio
        ref={el}
        src={src}
        preload={autoPlay ? "auto" : "none"}
        autoPlay={autoPlay}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setD(e.currentTarget.duration)}
        onDurationChange={(e) => setD(e.currentTarget.duration)}
      />
      <button
        type="button"
        onClick={toggle}
        title={playing ? "Pause" : "Play"}
        data-media-play
        className={cx("flex shrink-0 items-center justify-center rounded-full bg-fg text-bg transition-transform duration-150 active:scale-95", big ? "size-[40px]" : "size-[32px]")}
      >
        {playing ? <IPause size={big ? 15 : 13} /> : <IPlay size={big ? 15 : 13} className="translate-x-[1px]" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-small font-medium text-fg">{name}</span>
          {sub && <span className="shrink-0 truncate text-micro text-faint">{sub}</span>}
          <span className="ml-auto shrink-0 font-mono text-mono-small text-faint tnum" data-media-time>
            {fmtTime(t)}
            {d > 0 && ` / ${fmtTime(d)}`}
          </span>
        </div>
        <div
          className="group relative mt-1.5 h-[14px] cursor-pointer"
          onPointerDown={(e) => {
            const a = el.current;
            if (!a || !(d > 0)) return;
            const r = e.currentTarget.getBoundingClientRect();
            a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d;
            setT(a.currentTime);
          }}
          role="slider"
          aria-label={`Seek ${name}`}
          aria-valuemin={0}
          aria-valuemax={Math.round(d)}
          aria-valuenow={Math.round(t)}
        >
          <span className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-[color-mix(in_oklab,var(--dim)_22%,transparent)]" />
          <span className="absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-fg" style={{ width: `${frac * 100}%` }} />
          <span className="absolute top-1/2 size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg opacity-0 transition-opacity group-hover:opacity-100" style={{ left: `${frac * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

// ---------- explainers ----------

/**
 * An explainer's sandboxed frame: `sandbox="allow-scripts"` only (an opaque origin: no cookies, storage, top
 * navigation, pop-ups or Tauri IPC), its page under a CSP that loads nothing (media.rs `FRAME_CSP`). It grows to the
 * height its page reports (`fill`: takes its box instead). `run` bumps to replay it from the start.
 */
function ExplainerFrame({ src, name, fill, run = 0, onHeight }: { src: string; name: string; fill?: boolean; run?: number; onHeight?: (h: number) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (fill || !onHeight) return;
    const on = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      const h = frameHeight((e.data as { cooolFrame?: number; h?: unknown } | null)?.cooolFrame ? (e.data as { h?: unknown }).h : null);
      if (h) onHeight(h);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [fill, onHeight]);
  return (
    <iframe
      key={run}
      ref={ref}
      src={src}
      title={name}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading="lazy"
      className="block size-full border-0 bg-transparent"
      data-explainer-frame={name}
    />
  );
}

/** An explainer in a reply: its frame at its own height (at most 560 px), with Replay and Open full size. */
function Explainer({ src, name, onOpen }: { src: string; name: string; onOpen: () => void }) {
  const [h, setH] = useState(240);
  const [run, setRun] = useState(0);
  return (
    <div className="overflow-hidden rounded-[14px] border border-hairline bg-bg shadow-card" data-explainer={name} data-explainer-height={h}>
      <div style={{ height: h }} className="transition-[height] duration-200">
        <ExplainerFrame src={src} name={name} run={run} onHeight={setH} />
      </div>
      <div className="flex h-[34px] items-center gap-1 border-t border-hairline pl-3 pr-1">
        <ISpark size={13} className="shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate text-micro text-faint" title="Drawn in a sandboxed frame: it can't reach the network, coool or your files">
          {name}
        </span>
        <button type="button" onClick={() => setRun((r) => r + 1)} title="Replay from the start" data-explainer-replay className="flex h-[26px] items-center gap-1 rounded-[7px] px-1.5 text-micro font-medium text-dim hover:bg-hover hover:text-fg">
          <IRefresh size={12} />
          Replay
        </button>
        <button type="button" onClick={onOpen} title="Open full size" data-explainer-open className="flex h-[26px] items-center gap-1 rounded-[7px] px-1.5 text-micro font-medium text-dim hover:bg-hover hover:text-fg">
          <IExternal size={12} />
          Full size
        </button>
      </div>
    </div>
  );
}

// ---------- in a reply ----------

const itemsOf = (paths: string[], caption: string | undefined): MediaItem[] =>
  paths.flatMap((p) => {
    const kind = mediaKind(p);
    return kind ? [{ id: `file:${p}`, name: baseName(p), kind, source: "shown" as const, path: p, ts: 0, caption }] : [];
  });

/** One shown file, at its own shape: a picture, a video with its player, a sound's player, a PDF's first page. */
function Single({ item, onOpen, maxW = 520, maxH = 360 }: { item: MediaItem; onOpen: () => void; maxW?: number; maxH?: number }) {
  const [ref, near] = useNear<HTMLDivElement>();
  const { g, src, thumb, failed } = useSource(item, near);
  const cm = useItemMenu(item, g, onOpen);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const fit = (w: number, h: number) => {
    const s = Math.min(1, maxW / w, maxH / h);
    setBox({ w: Math.round(w * s), h: Math.round(h * s) });
  };
  const Icon = KIND_ICON[item.kind];
  if (failed)
    return (
      <div ref={ref} className="flex h-[56px] max-w-[360px] items-center gap-2.5 rounded-[12px] border border-dashed border-line px-3 text-small text-faint" data-media-missing={item.name} title={failed}>
        <Icon size={15} />
        <span className="truncate">{item.name}</span>
        <span className="truncate text-micro">{failed}</span>
      </div>
    );
  if (item.kind === "explainer")
    return (
      <div ref={ref} onContextMenu={cm} className="w-[min(640px,100%)]" data-media-shown={item.name} data-media-kind="explainer">
        {src ? <Explainer src={src} name={item.name} onOpen={onOpen} /> : <Placeholder w={640} h={200} />}
      </div>
    );
  if (item.kind === "audio")
    return <div ref={ref} onContextMenu={cm} className="w-[min(460px,100%)]" data-media-shown={item.name} data-media-kind="audio">{src ? <AudioPlayer src={src} name={item.name} sub={g?.size ? fmtSize(g.size) : undefined} /> : <Placeholder w={460} h={58} />}</div>;
  if (item.kind === "video")
    return (
      <div ref={ref} onContextMenu={cm} className="overflow-hidden rounded-[14px] border border-hairline bg-black" style={box ? { width: box.w, height: box.h } : { width: Math.min(maxW, 480), height: 270 }} data-media-shown={item.name} data-media-kind="video">
        {src ? (
          <video
            src={src}
            poster={thumb ?? undefined}
            controls
            playsInline
            preload="none"
            className="block size-full object-contain"
            onLoadedMetadata={(e) => e.currentTarget.videoWidth && fit(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
          />
        ) : null}
        {thumb && !box && <img src={thumb} alt="" className="hidden" onLoad={(e) => fit(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />}
      </div>
    );
  const shown = item.kind === "image" ? src : thumb;
  return (
    <button ref={ref as unknown as React.Ref<HTMLButtonElement>} type="button" onClick={onOpen} onContextMenu={cm} title={item.name} data-media-shown={item.name} data-media-kind={item.kind} className="relative block w-fit self-start overflow-hidden rounded-[14px] border border-hairline bg-raised transition-[border-color] duration-150 hover:border-line">
      {shown ? (
        <motion.img
          src={shown}
          alt={item.name}
          onLoad={(e) => fit(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
          className="block object-cover"
          style={box ? { width: box.w, height: box.h } : { maxWidth: maxW, maxHeight: maxH }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2 }}
        />
      ) : (
        <Placeholder w={240} h={150} />
      )}
      {item.kind === "pdf" && <span className="absolute bottom-2 left-2 rounded-[6px] bg-[color-mix(in_oklab,var(--bg)_80%,transparent)] px-1.5 py-0.5 font-mono text-micro font-semibold text-dim">PDF</span>}
    </button>
  );
}

function Placeholder({ w, h }: { w: number; h: number }) {
  return <span className="block animate-pulse rounded-[12px] bg-[color-mix(in_oklab,var(--dim)_10%,transparent)]" style={{ width: w, maxWidth: "100%", height: h }} />;
}

/** A square tile: the picture, or a video's / PDF's thumbnail with its badge, or a sound's mark. */
const Tile = memo(function Tile({ item, size, onOpen, more }: { item: MediaItem; size: number | string; onOpen: () => void; more?: number }) {
  const [ref, near] = useNear<HTMLButtonElement>();
  const { g, src, thumb, failed } = useSource(item, near);
  const cm = useItemMenu(item, g, onOpen);
  const Icon = KIND_ICON[item.kind];
  const pic = item.kind === "image" ? (item.key ? src : thumb) : thumb;
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      onContextMenu={failed ? undefined : cm}
      title={failed ? `${item.name}: ${failed}` : item.name}
      data-media-tile={item.name}
      data-media-kind={item.kind}
      data-media-source={item.source}
      data-near={near || undefined}
      className={cx("group relative block shrink-0 overflow-hidden rounded-[12px] border bg-raised [content-visibility:auto]", failed ? "border-dashed border-line" : "border-hairline hover:border-line")}
      style={{ width: size, height: size }}
    >
      {pic && !failed ? (
        <img src={pic} alt={item.name} loading="lazy" decoding="async" draggable={item.kind === "image"} className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
      ) : (
        <span className={cx("flex size-full flex-col items-center justify-center gap-1.5 px-2", item.kind === "audio" && !failed ? "text-dim" : "text-faint")}>
          <Icon size={item.kind === "audio" ? 20 : 16} />
          {(item.kind === "audio" || failed) && <span className="line-clamp-2 break-all text-center text-[10.5px] leading-[13px]">{item.name}</span>}
        </span>
      )}
      {item.kind === "video" && !failed && (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-[30px] items-center justify-center rounded-full bg-[color-mix(in_oklab,#000_55%,transparent)] text-white backdrop-blur-[4px]">
            <IPlay size={12} className="translate-x-[1px]" />
          </span>
        </span>
      )}
      {item.kind === "video" && !!item.duration && (
        <span className="absolute bottom-1.5 right-1.5 rounded-[5px] bg-[color-mix(in_oklab,#000_60%,transparent)] px-1 font-mono text-[10px] text-white tnum">{fmtTime(item.duration)}</span>
      )}
      {item.kind === "pdf" && <span className="absolute bottom-1.5 left-1.5 rounded-[5px] bg-[color-mix(in_oklab,var(--bg)_80%,transparent)] px-1 font-mono text-[10px] font-semibold text-dim">PDF</span>}
      {!!more && <span className="absolute inset-0 flex items-center justify-center bg-[color-mix(in_oklab,var(--bg)_58%,transparent)] text-prose font-semibold text-fg tnum">+{more}</span>}
    </button>
  );
});

/**
 * What a `show` call put in the reply: one file at its own shape, or a grid (pictures and videos) with the sounds as
 * players below; the caption under them. A call that showed nothing says why, quietly.
 */
export const ShownMedia = memo(function ShownMedia({ input, ok, output }: { input: unknown; ok: boolean | null; output: string }) {
  const s = useMemo(() => shownOf(input), [input]);
  const items = useMemo(() => (s ? itemsOf(s.paths, s.caption) : []), [s]);
  const open = useOpenMedia();
  if (!s) return null;
  if (ok === false)
    return (
      <div className="flex items-center gap-2 text-small text-faint" data-media-failed>
        <IGallery size={14} />
        <span className="truncate">{output.split("\n")[0] || "Nothing to show"}</span>
      </div>
    );
  // Pictures and videos in a grid; sounds and explainers each at full width below.
  const visual = items.filter((x) => x.kind !== "audio" && x.kind !== "explainer");
  const sounds = items.filter((x) => x.kind === "audio" || x.kind === "explainer");
  const cols = visual.length <= 1 ? 1 : visual.length === 2 || visual.length === 4 ? 2 : 3;
  return (
    <figure className="flex flex-col gap-2" data-media-show={items.length}>
      {visual.length === 1 && <Single item={visual[0]} onOpen={() => open(items, items.indexOf(visual[0]))} />}
      {visual.length > 1 && (
        <div className="grid w-fit gap-1.5" style={{ gridTemplateColumns: `repeat(${cols}, ${cols === 2 ? 200 : 152}px)` }}>
          {visual.map((x) => (
            <Tile key={x.id} item={x} size={cols === 2 ? 200 : 152} onOpen={() => open(items, items.indexOf(x))} />
          ))}
        </div>
      )}
      {sounds.map((x) => (
        <Single key={x.id} item={x} onOpen={() => open(items, items.indexOf(x))} />
      ))}
      {s.caption && <figcaption className="text-small text-dim" data-media-caption>{s.caption}</figcaption>}
    </figure>
  );
});

/** A local picture or media file a reply's markdown embeds or links (shown only if the backend serves it to this chat). */
export function InlineMedia({ path, alt, link }: { path: string; alt?: string; link?: React.ReactNode }) {
  const ctx = useContext(MediaContext);
  const item = useMemo<MediaItem>(() => ({ id: `file:${path}`, name: baseName(path), kind: mediaKind(path) ?? "image", source: "shown", path, ts: 0, caption: alt || undefined }), [path, alt]);
  const g = useGrant(ctx.scope, path);
  const open = useOpenMedia();
  if (!ctx.scope || g?.error) return <span className="text-dim underline decoration-faint underline-offset-2" title={g?.error ?? path}>{link ?? alt ?? path}</span>;
  if (!g) return <span className="text-faint">{link ?? alt ?? item.name}</span>;
  if (link)
    // A link to a media file: a chip that opens it.
    return (
      <button type="button" onClick={() => open([item], 0)} className="inline-flex items-center gap-1 rounded-[6px] px-1 text-fg underline decoration-faint underline-offset-2 hover:bg-hover" data-media-link={item.name}>
        {(() => {
          const I = KIND_ICON[item.kind];
          return <I size={12} />;
        })()}
        {link}
      </button>
    );
  return (
    <span className="my-1.5 block" data-media-inline={item.name}>
      <Single item={item} onOpen={() => open([item], 0)} />
    </span>
  );
}

/** A video or sound the person attached, in their message: its player, and what the agent got (key frames). */
export function AttachedMedia({ a }: { a: Attachment }) {
  const kind = mediaKind(a.name, a.mime);
  const item = useMemo<MediaItem | null>(() => (kind && a.path ? { id: `att:${a.path}`, name: a.name, kind, source: "attached", path: a.path, ts: 0, duration: a.duration, frames: a.frames?.length } : null), [a, kind]);
  const open = useOpenMedia();
  if (!item) return null;
  return (
    <div className="flex flex-col items-end gap-1" data-attached-media={a.name}>
      <Single item={item} onOpen={() => open([item], 0)} maxW={420} maxH={300} />
      {!!a.frames?.length && (
        <span className="pr-1 text-micro text-faint" data-attached-frames={a.frames.length}>
          {a.frames.length} key frame{a.frames.length === 1 ? "" : "s"} sent to the agent{a.duration ? ` · ${fmtTime(a.duration)}` : ""}
        </span>
      )}
    </div>
  );
}
