// Chat attachments on screen: the composer's tray (thumbnails and file chips, reading / refused states), the attach
// button, the drop veil, a sent message's images (one shaped image, or a grid) and files, and the two viewers: the
// image lightbox (zoom, fit, previous / next, keyboard) and the file quick look (code with line numbers and colour, a
// PDF, or Reveal in Finder). Rules: lib/attachRules.ts; state and loading: lib/attach.ts.

import { AnimatePresence, motion } from "motion/react";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { api } from "../lib/backend";
import { loadImage, pickFiles, useAttach, useDrafts, type Draft } from "../lib/attach";
import { type Attachment, colorize, fmtSize, gridOf, TONE_VAR, toneOf, typeLabel, type AttachPreview } from "../lib/attachRules";
import type { Provider } from "../lib/types";
import { IBack, IClip, IClose, ICopy, IFile, IFit, IForward, IFolderOpen, IImage, IZoomIn, IZoomOut } from "./icons";
import { Chip, cx, ease } from "./primitives";
import { AttachedMedia } from "./Media";
import { mediaKind } from "../lib/mediaRules";
import { onContext } from "../lib/contextMenu";
import { attachMenu } from "../lib/menus/misc";

const reveal = (path: string) => void api().attachReveal(path).catch(() => {});

// ---------- where a conversation's images come from ----------

/** The session whose transcript holds a conversation's images (for ones not in coool's store). */
export const AttachSource = createContext<{ provider: Provider | null; session: string | null; cwd?: string | null }>({ provider: null, session: null });

/** One image the viewer can show: by key (loaded through the core), or a local URL (a composer draft). */
export interface ViewImage {
  id: string;
  name: string;
  size: number;
  key?: string;
  src?: string;
  path?: string;
  /** A path an agent wrote: only previewed inside this folder (the chat's). */
  root?: string | null;
  provider?: Provider | null;
  session?: string | null;
}

type Viewer = { kind: "images"; items: ViewImage[]; index: number } | { kind: "file"; att: Attachment } | null;
export const useViewer = create<{ v: Viewer; open(v: Viewer): void }>((set) => ({ v: null, open: (v) => set({ v }) }));

function useImage(img: ViewImage | null): { src: string | null; failed: boolean } {
  const [state, setState] = useState<{ src: string | null; failed: boolean; for: string | null }>({ src: img?.src ?? null, failed: false, for: img?.id ?? null });
  useEffect(() => {
    if (!img) return;
    if (img.src) return setState({ src: img.src, failed: false, for: img.id });
    if (!img.key) {
      if (img.path)
        // A path an agent wrote: read only now, after a click, and only as an image.
        void api()
          .attachPreview(img.path, true, img.root)
          .then((p) => setState({ src: p.kind === "image" ? p.data_url : null, failed: p.kind !== "image", for: img.id }))
          .catch(() => setState({ src: null, failed: true, for: img.id }));
      else setState({ src: null, failed: true, for: img.id });
      return;
    }
    let live = true;
    setState((s) => (s.for === img.id ? s : { src: null, failed: false, for: img.id }));
    loadImage(img.key, img.provider, img.session).then(
      (src) => live && setState({ src, failed: false, for: img.id }),
      () => live && setState({ src: null, failed: true, for: img.id }),
    );
    return () => {
      live = false;
    };
  }, [img?.id, img?.key, img?.src, img?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  return state.for === img?.id ? state : { src: null, failed: false };
}

// ---------- badges and chips ----------

export function TypeBadge({ a, size = 36 }: { a: { name: string; mime: string }; size?: number }) {
  const tone = TONE_VAR[toneOf(a)];
  return (
    <span
      className="relative flex shrink-0 items-end justify-center rounded-[7px] pb-[5px] font-mono text-[9.5px] font-semibold leading-none tracking-[0.02em]"
      style={{ width: size * 0.86, height: size, color: tone, background: `color-mix(in oklab, ${tone} 15%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tone} 28%, transparent)` }}
      aria-hidden
    >
      {/* the folded corner of a page */}
      <span className="absolute right-0 top-0 size-[9px] rounded-bl-[3px] rounded-tr-[7px]" style={{ background: `color-mix(in oklab, ${tone} 30%, transparent)` }} />
      {typeLabel(a)}
    </span>
  );
}

function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spin inline-block rounded-full border-[1.5px] border-current border-t-transparent" style={{ width: size, height: size }} aria-hidden />;
}

const tileSpring = { type: "spring", stiffness: 520, damping: 36, mass: 0.8 } as const;

function RemoveButton({ onClick, name }: { onClick: () => void; name: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={`Remove ${name}`}
      data-attach-remove
      className="absolute -right-1.5 -top-1.5 z-10 flex size-[20px] items-center justify-center rounded-full border border-line bg-raised text-dim opacity-0 shadow-pop transition-[opacity,color] duration-150 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
    >
      <IClose size={10} strokeWidth={2} />
    </button>
  );
}

/** A file as a chip: badge, name, size and type; a note or a refusal on the second line. */
export function FileChip({ a, state, error, onOpen, onRemove, compact }: { a: { name: string; mime: string; size: number; note?: string; path?: string }; state?: Draft["state"]; error?: string; onOpen?: () => void; onRemove?: () => void; compact?: boolean }) {
  const bad = state === "error";
  const sub = bad ? error : state === "reading" ? "Reading…" : [fmtSize(a.size), a.note].filter(Boolean).join(" · ") || typeLabel(a).toLowerCase();
  return (
    <div className="group relative" data-attach-file={a.name} data-attach-state={state ?? "sent"} onContextMenu={onContext(() => bad || state === "reading" ? null : attachMenu({ name: a.name, path: a.path, open: onOpen, reveal, remove: onRemove }))}>
      <button
        type="button"
        onClick={bad ? undefined : onOpen}
        title={bad ? `${a.name}: ${error}` : a.note ? `${a.name}\n${a.note}` : `Preview ${a.name}`}
        className={cx(
          "flex items-center gap-2.5 rounded-[12px] border text-left transition-[background-color,border-color] duration-150",
          compact ? "h-[48px] max-w-[240px] pl-2 pr-3" : "h-[56px] max-w-[260px] pl-2.5 pr-3.5",
          bad ? "border-dashed border-[color-mix(in_oklab,var(--error)_50%,var(--border))] bg-transparent" : "border-hairline bg-bg hover:border-line hover:bg-hover",
          !onOpen && !bad && "cursor-default",
        )}
      >
        {state === "reading" ? (
          <span className="flex h-[36px] w-[31px] items-center justify-center text-faint">
            <Spinner />
          </span>
        ) : (
          <TypeBadge a={a} size={compact ? 32 : 36} />
        )}
        <span className="min-w-0">
          <span className={cx("block truncate text-small font-medium", bad ? "text-dim line-through decoration-[color-mix(in_oklab,var(--error)_60%,transparent)]" : "text-fg")}>{a.name}</span>
          <span className={cx("block truncate text-micro", bad ? "text-err-text" : a.note ? "text-busy-text" : "text-faint")}>{sub}</span>
        </span>
      </button>
      {onRemove && <RemoveButton onClick={onRemove} name={a.name} />}
    </div>
  );
}

/** An image draft or attachment as a square tile. */
function ImageTile({ img, size, state, error, onOpen, onRemove, more, layout }: { img: ViewImage; size: number | string; state?: Draft["state"]; error?: string; onOpen?: () => void; onRemove?: () => void; more?: number; layout?: string }) {
  const { src, failed } = useImage(state === "error" ? null : img);
  const bad = state === "error";
  return (
    <div className="group relative" style={{ width: size, height: size }} data-attach-image={img.name} data-attach-state={state ?? "sent"} onContextMenu={onContext(() => bad || state === "reading" ? null : attachMenu({ name: img.name, path: img.path, open: failed ? undefined : onOpen, reveal, remove: onRemove }))}>
      <button
        type="button"
        onClick={bad || failed ? undefined : onOpen}
        title={bad ? `${img.name}: ${error}` : failed ? `${img.name}: the image isn't available any more` : img.name}
        className={cx(
          "relative block size-full overflow-hidden rounded-[12px] border",
          bad ? "border-dashed border-[color-mix(in_oklab,var(--error)_50%,var(--border))]" : "border-hairline bg-raised",
        )}
      >
        {src && !bad ? (
          <motion.img layoutId={layout} src={src} alt={img.name} draggable={false} className="size-full object-cover" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} />
        ) : (
          <span className="flex size-full flex-col items-center justify-center gap-1 px-1 text-faint">
            <IImage size={16} />
            {bad && <span className="line-clamp-2 text-center text-[10px] leading-[12px] text-err-text">{error}</span>}
          </span>
        )}
        {state === "reading" && (
          <span className="absolute inset-0 flex items-center justify-center bg-[color-mix(in_oklab,var(--bg)_45%,transparent)] text-fg">
            <Spinner size={16} />
          </span>
        )}
        {!!more && (
          <span className="absolute inset-0 flex items-center justify-center bg-[color-mix(in_oklab,var(--bg)_58%,transparent)] text-prose font-semibold text-fg tnum" data-attach-more={more}>
            +{more}
          </span>
        )}
      </button>
      {onRemove && <RemoveButton onClick={onRemove} name={img.name} />}
    </div>
  );
}

// ---------- the composer ----------

/** The attach button of the composer row. */
export function AttachButton({ chat, disabled, provider }: { chat: number; disabled?: string | null; provider: string }) {
  return (
    <Chip
      onClick={() => void pickFiles(chat).catch(() => {})}
      disabled={!!disabled}
      title={disabled ?? `Attach images or files\nImages go to ${provider === "claude" ? "Claude" : "Codex"} as images; other files as paths it reads.\nYou can also paste, or drop files on the chat.`}
      className="px-1.5"
    >
      <span data-attach-button className="flex items-center">
        <IClip size={15} />
      </span>
    </Chip>
  );
}

/** What is attached to the message being written, above the text. */
export function AttachTray({ chat }: { chat: number }) {
  const drafts = useDrafts(chat);
  const remove = useAttach((s) => s.remove);
  const imgs = drafts.filter((d) => d.state !== "error" && (d.att?.kind === "image" || (!d.att && d.mime.startsWith("image/"))));
  const viewOf = (d: Draft): ViewImage => ({ id: d.id, name: d.name, size: d.size, key: d.att?.key, src: d.thumb, path: d.att?.path });
  const open = (d: Draft) => {
    if (d.att?.kind === "image" || imgs.includes(d)) {
      const items = imgs.map(viewOf);
      useViewer.getState().open({ kind: "images", items, index: Math.max(0, imgs.indexOf(d)) });
    } else if (d.att) useViewer.getState().open({ kind: "file", att: d.att });
  };
  return (
    <AnimatePresence initial={false}>
      {drafts.length > 0 && (
        <motion.div
          key="tray"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease }}
          className="overflow-hidden"
          data-attach-tray={drafts.length}
        >
          <div className="flex flex-wrap items-end gap-2.5 px-3.5 pb-0.5 pt-3.5">
            <AnimatePresence initial={false} mode="popLayout">
              {drafts.map((d) => {
                const isImg = d.att ? d.att.kind === "image" : d.mime.startsWith("image/") && d.state !== "error";
                return (
                  <motion.div
                    key={d.id}
                    layout
                    initial={{ opacity: 0, scale: 0.86, y: 6 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.86, transition: { duration: 0.14 } }}
                    transition={tileSpring}
                  >
                    {isImg ? (
                      <ImageTile img={viewOf(d)} size={56} state={d.state} error={d.error} onOpen={() => open(d)} onRemove={() => remove(chat, d.id)} />
                    ) : (
                      <FileChip a={{ name: d.name, mime: d.att?.mime ?? d.mime, size: d.size, note: d.att?.note, path: d.att?.path }} state={d.state} error={d.error} compact onOpen={() => open(d)} onRemove={() => remove(chat, d.id)} />
                    )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The veil over a chat while files are dragged over it. */
export function DropVeil({ chat, provider }: { chat: number; provider: string }) {
  const over = useAttach((s) => (s.over?.chat === chat ? s.over.count : 0));
  return (
    <AnimatePresence>
      {over > 0 && (
        <motion.div
          key="veil"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="pointer-events-none absolute inset-0 z-40 p-3"
          data-drop-veil={over}
        >
          <div className="flex size-full flex-col items-center justify-center gap-4 rounded-[22px] border-[1.5px] border-dashed border-[color-mix(in_oklab,var(--dim)_55%,transparent)] bg-[color-mix(in_oklab,var(--bg)_78%,transparent)] backdrop-blur-[6px]">
            <Fan />
            <div className="text-center">
              <div className="text-prose font-medium text-fg">Drop to attach {over === 1 ? "this file" : `${over} files`}</div>
              <div className="mt-0.5 text-small text-faint">Images go to {provider === "claude" ? "Claude" : "Codex"} as images; other files as paths it reads</div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Three sheets that fan out as the veil comes in. */
function Fan() {
  const sheets: { r: number; x: number; icon: React.ReactNode; tone: string }[] = [
    { r: -14, x: -26, icon: <IImage size={15} />, tone: TONE_VAR.media },
    { r: 0, x: 0, icon: <IFile size={15} />, tone: TONE_VAR.doc },
    { r: 14, x: 26, icon: <span className="font-mono text-[10px] font-semibold">{"</>"}</span>, tone: TONE_VAR.code },
  ];
  return (
    <div className="relative h-[64px] w-[120px]" aria-hidden>
      {sheets.map((s, i) => (
        <motion.span
          key={i}
          initial={{ rotate: 0, x: 0, y: 8, opacity: 0 }}
          animate={{ rotate: s.r, x: s.x, y: i === 1 ? -4 : 2, opacity: 1 }}
          transition={{ type: "spring", stiffness: 380, damping: 22, delay: i === 1 ? 0 : 0.04 }}
          className="absolute left-[38px] top-[6px] flex h-[52px] w-[44px] items-center justify-center rounded-[9px] border border-line bg-raised shadow-pop"
          style={{ color: s.tone, zIndex: i === 1 ? 2 : 1, transformOrigin: "50% 90%" }}
        >
          {s.icon}
        </motion.span>
      ))}
    </div>
  );
}

// ---------- a sent message ----------

/** A message's images (one shaped, or a grid) and file chips, right-aligned above its text. */
export const MessageAttachments = memo(function MessageAttachments({ atts, scope }: { atts: Attachment[]; scope: string }) {
  const src = useContext(AttachSource);
  const images = atts.filter((a) => a.kind === "image");
  // A video or a sound plays in the message (its path is the chat's own: the backend serves it).
  const playable = atts.filter((a) => a.kind !== "image" && a.path && (mediaKind(a.name, a.mime) === "video" || mediaKind(a.name, a.mime) === "audio"));
  const files = atts.filter((a) => a.kind !== "image" && !playable.includes(a));
  const views: ViewImage[] = useMemo(
    () => images.map((a, i) => ({ id: `${scope}:${i}`, name: a.name, size: a.size, key: a.key, path: a.path, provider: src.provider, session: src.session })),
    [images.length, scope, src.provider, src.session], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const g = gridOf(images.length);
  const open = (i: number) => useViewer.getState().open({ kind: "images", items: views, index: i });
  return (
    <div className="flex max-w-[86%] flex-col items-end gap-1.5" data-message-attachments={atts.length}>
      {g.single && <SingleImage img={views[0]} onOpen={() => open(0)} />}
      {!g.single && g.tiles > 0 && (
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${g.cols}, 104px)` }} data-attach-grid={g.cols}>
          {views.slice(0, g.tiles).map((v, i) => (
            <ImageTile key={v.id} img={v} size={104} onOpen={() => open(i)} more={i === g.tiles - 1 && g.more ? g.more : undefined} />
          ))}
        </div>
      )}
      {playable.map((a, i) => (
        <AttachedMedia key={`m${i}`} a={a} />
      ))}
      {files.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {files.map((a, i) => (
            <FileChip key={i} a={a} onOpen={() => useViewer.getState().open({ kind: "file", att: a })} />
          ))}
        </div>
      )}
    </div>
  );
});

function SingleImage({ img, onOpen }: { img: ViewImage; onOpen: () => void }) {
  const { src, failed } = useImage(img);
  // Its own shape, inside 340 x 260 (the button hugs the picture: no bars beside it).
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  if (failed || !src)
    return (
      <div className="flex h-[120px] w-[180px] items-center justify-center rounded-[14px] border border-hairline bg-raised text-faint" data-attach-image={img.name} title={failed ? `${img.name}: the image isn't available any more` : img.name}>
        <IImage size={18} />
      </div>
    );
  return (
    <button type="button" onClick={onOpen} onContextMenu={onContext(() => attachMenu({ name: img.name, path: img.path, open: onOpen, reveal }))} title={img.name} data-attach-image={img.name} className="block overflow-hidden rounded-[14px] border border-hairline bg-raised transition-[border-color] duration-150 hover:border-line">
      <motion.img
        src={src}
        alt={img.name}
        draggable={false}
        onLoad={(e) => {
          const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
          const s = Math.min(1, 340 / w, 260 / h);
          setBox({ w: Math.round(w * s), h: Math.round(h * s) });
        }}
        className="block max-w-full object-cover"
        style={box ? { width: box.w, height: box.h } : { maxWidth: 340, maxHeight: 260 }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
      />
    </button>
  );
}

/** "Preview" buttons for image paths an agent wrote in a step (read only when clicked). */
export function StepImages({ paths, root }: { paths: string[]; root: string }) {
  if (!paths.length) return null;
  const items: ViewImage[] = paths.map((p) => ({ id: `path:${p}`, name: p.split("/").pop() || p, size: 0, path: p, root }));
  return (
    <span className="ml-1 inline-flex gap-1" data-step-images={paths.length}>
      {items.map((it, i) => (
        <button
          key={it.id}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            useViewer.getState().open({ kind: "images", items, index: i });
          }}
          title={`Preview ${paths[i]}`}
          onContextMenu={onContext(() => attachMenu({ name: it.name, path: paths[i], open: () => useViewer.getState().open({ kind: "images", items, index: i }), reveal }))}
          className="inline-flex h-[20px] items-center gap-1 rounded-[6px] px-1.5 text-micro text-dim hover:bg-hover hover:text-fg"
        >
          <IImage size={12} />
          <span className="max-w-[140px] truncate">{it.name}</span>
        </button>
      ))}
    </span>
  );
}

// ---------- the viewers ----------

export function AttachViewer() {
  const v = useViewer((s) => s.v);
  const close = useCallback(() => useViewer.getState().open(null), []);
  return <AnimatePresence>{v?.kind === "images" ? <Lightbox key="lb" items={v.items} start={v.index} onClose={close} /> : v?.kind === "file" ? <QuickLook key="ql" att={v.att} onClose={close} /> : null}</AnimatePresence>;
}

function ToolButton({ title, onClick, children, disabled, label }: { title: string; onClick: () => void; children: React.ReactNode; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      data-viewer-button={label ?? title}
      className="flex h-[30px] min-w-[30px] items-center justify-center gap-1.5 rounded-[9px] px-1.5 text-small font-medium text-dim transition-[background-color,color] duration-150 hover:bg-hover hover:text-fg disabled:opacity-40"
    >
      {children}
    </button>
  );
}

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

function Lightbox({ items, start, onClose }: { items: ViewImage[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  // `null`: fit the window; a number: that scale of the image's own pixels.
  const [zoom, setZoom] = useState<number | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [dir, setDir] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const img = items[i];
  const { src, failed } = useImage(img);
  const many = items.length > 1;
  const go = useCallback(
    (d: number) => {
      if (!many) return;
      setDir(d);
      setI((x) => (x + d + items.length) % items.length);
      setZoom(null);
      setNat(null);
    },
    [many, items.length],
  );
  const fitScale = () => {
    const el = stage.current;
    if (!el || !nat) return 1;
    return Math.min(1, (el.clientWidth - 48) / nat.w, (el.clientHeight - 48) / nat.h);
  };
  const step = (d: 1 | -1) => {
    const cur = zoom ?? fitScale();
    const next = d > 0 ? ZOOMS.find((z) => z > cur + 0.01) : [...ZOOMS].reverse().find((z) => z < cur - 0.01);
    setZoom(next ?? cur);
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") return e.preventDefault(), e.stopPropagation(), onClose();
      if (e.key === "ArrowRight") return e.preventDefault(), go(1);
      if (e.key === "ArrowLeft") return e.preventDefault(), go(-1);
      if (e.key === "+" || e.key === "=") return e.preventDefault(), step(1);
      if (e.key === "-") return e.preventDefault(), step(-1);
      if (e.key === "0") return e.preventDefault(), setZoom(null);
      if (e.key === "1") return e.preventDefault(), setZoom(1);
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  });
  const scale = zoom ?? fitScale();
  const pct = Math.round(scale * 100);
  return (
    <motion.div
      className="fixed inset-0 z-[90] flex flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.14 } }}
      transition={{ duration: 0.18 }}
      data-lightbox={i}
      role="dialog"
      aria-label={img?.name}
    >
      <div className="absolute inset-0 bg-[var(--backdrop)] backdrop-blur-[14px]" onClick={onClose} />
      {/* top bar */}
      <div className="relative z-10 flex h-[52px] shrink-0 items-center gap-3 px-4">
        <div className="flex min-w-0 items-center gap-2 rounded-[11px] border border-hairline bg-raised px-3 py-1.5 shadow-pop">
          <IImage size={14} className="shrink-0 text-faint" />
          <span className="truncate text-small font-medium text-fg" title={img?.path ?? img?.name}>
            {img?.name}
          </span>
          {many && (
            <span className="shrink-0 text-small text-faint tnum" data-lightbox-count>
              {i + 1} of {items.length}
            </span>
          )}
          {nat && <span className="shrink-0 text-small text-faint tnum">{nat.w}×{nat.h}</span>}
        </div>
        <div className="ml-auto flex items-center gap-0.5 rounded-[11px] border border-hairline bg-raised p-0.5 shadow-pop">
          <ToolButton title="Zoom out (−)" label="zoom-out" onClick={() => step(-1)}>
            <IZoomOut size={15} />
          </ToolButton>
          <ToolButton title={zoom === null ? "Actual size (1)" : "Fit to the window (0)"} label="fit" onClick={() => setZoom(zoom === null ? 1 : null)}>
            <span className="w-[38px] text-center tnum" data-lightbox-zoom={pct}>
              {pct}%
            </span>
          </ToolButton>
          <ToolButton title="Zoom in (+)" label="zoom-in" onClick={() => step(1)}>
            <IZoomIn size={15} />
          </ToolButton>
          <ToolButton title="Fit to the window (0)" label="fit-window" onClick={() => setZoom(null)} disabled={zoom === null}>
            <IFit size={15} />
          </ToolButton>
          {img?.path && (
            <ToolButton title="Reveal in Finder" label="reveal" onClick={() => void api().attachReveal(img.path!).catch(() => {})}>
              <IFolderOpen size={15} />
            </ToolButton>
          )}
          <span className="mx-0.5 h-[18px] w-px bg-[var(--hairline)]" />
          <ToolButton title="Close (Esc)" label="close" onClick={onClose}>
            <IClose size={15} />
          </ToolButton>
        </div>
      </div>
      {/* stage */}
      <div
        ref={stage}
        className={cx("relative min-h-0 flex-1", zoom !== null && "overflow-auto")}
        onClick={(e) => e.target === e.currentTarget && onClose()}
        onWheel={(e) => {
          if (!e.ctrlKey && !e.metaKey) return;
          e.preventDefault();
          step(e.deltaY < 0 ? 1 : -1);
        }}
      >
        <div className="flex min-h-full min-w-full items-center justify-center p-6" onClick={(e) => e.target === e.currentTarget && onClose()} style={zoom !== null && nat ? { width: Math.max(nat.w * scale + 48, 0), height: Math.max(nat.h * scale + 48, 0) } : { position: "absolute", inset: 0 }}>
          <AnimatePresence initial={false} custom={dir} mode="popLayout">
            {src ? (
              <motion.img
                key={img.id}
                src={src}
                alt={img.name}
                draggable={false}
                onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                onDoubleClick={() => setZoom(zoom === null ? 1 : null)}
                custom={dir}
                initial={{ opacity: 0, scale: 0.96, x: dir * 40 }}
                animate={{ opacity: 1, scale: 1, x: 0 }}
                exit={{ opacity: 0, scale: 0.98, x: dir * -40, transition: { duration: 0.12 } }}
                transition={{ type: "spring", stiffness: 420, damping: 38 }}
                className={cx("block select-none rounded-[6px] shadow-pop", zoom === null ? "max-h-full max-w-full object-contain" : "max-w-none")}
                style={zoom !== null && nat ? { width: nat.w * scale, height: nat.h * scale, cursor: "zoom-out" } : { cursor: "zoom-in" }}
                data-lightbox-image={img.name}
              />
            ) : (
              <motion.div key={`wait-${img?.id}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-2 text-faint">
                {failed ? (
                  <>
                    <IImage size={22} />
                    <span className="text-small">This image isn’t available any more</span>
                  </>
                ) : (
                  <Spinner size={18} />
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {many && (
          <>
            <NavButton side="left" onClick={() => go(-1)} />
            <NavButton side="right" onClick={() => go(1)} />
          </>
        )}
      </div>
      {/* filmstrip */}
      {many && (
        <div className="relative z-10 flex shrink-0 justify-center gap-1.5 px-4 pb-4 pt-2" data-lightbox-strip>
          {items.map((it, j) => (
            <Thumb key={it.id} img={it} on={j === i} onClick={() => (setDir(j > i ? 1 : -1), setI(j), setZoom(null), setNat(null))} />
          ))}
        </div>
      )}
    </motion.div>
  );
}

function NavButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={side === "left" ? "Previous (←)" : "Next (→)"}
      data-lightbox-nav={side}
      className={cx(
        "absolute top-1/2 z-10 flex size-[38px] -translate-y-1/2 items-center justify-center rounded-full border border-hairline bg-raised text-dim shadow-pop transition-[color,transform] duration-150 hover:text-fg active:scale-95",
        side === "left" ? "left-4" : "right-4",
      )}
    >
      {side === "left" ? <IBack size={16} /> : <IForward size={16} />}
    </button>
  );
}

function Thumb({ img, on, onClick }: { img: ViewImage; on: boolean; onClick: () => void }) {
  const { src } = useImage(img);
  return (
    <button
      type="button"
      onClick={onClick}
      title={img.name}
      className={cx("size-[44px] overflow-hidden rounded-[9px] border-2 transition-[border-color,opacity] duration-150", on ? "border-[var(--text)] opacity-100" : "border-transparent opacity-55 hover:opacity-90")}
    >
      {src ? <img src={src} alt="" draggable={false} className="size-full object-cover" /> : <span className="block size-full bg-raised" />}
    </button>
  );
}

function QuickLook({ att, onClose }: { att: Attachment; onClose: () => void }) {
  const [p, setP] = useState<AttachPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!att.path) return setErr("coool doesn’t know where this file is");
    void api()
      .attachPreview(att.path)
      .then(setP)
      .catch((e) => setErr(String(e).replace(/^Error: /, "")));
  }, [att.path]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [onClose]);
  const lines = useMemo(() => (p?.kind === "text" ? colorize(p.text.replace(/\n$/, ""), att.name) : null), [p, att.name]);
  return (
    <motion.div className="fixed inset-0 z-[90] flex items-center justify-center p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.14 } }} data-quicklook={att.name} role="dialog" aria-label={att.name}>
      <div className="absolute inset-0 bg-[var(--backdrop)] backdrop-blur-[10px]" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, y: 10, scale: 0.975 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6, scale: 0.985, transition: { duration: 0.12 } }}
        transition={{ type: "spring", stiffness: 460, damping: 36 }}
        className="relative flex h-[min(78vh,760px)] w-[min(880px,100%)] flex-col overflow-hidden rounded-[18px] border border-line bg-raised shadow-pop"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-3">
          <TypeBadge a={att} size={34} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-medium text-fg">{att.name}</div>
            <div className="truncate font-mono text-mono-small text-faint" title={att.path}>
              {[fmtSize(p?.size ?? att.size), att.path?.replace(/^\/Users\/[^/]+/, "~")].filter(Boolean).join("  ·  ")}
            </div>
          </div>
          {p?.kind === "text" && (
            <ToolButton
              title="Copy the text"
              label="copy"
              onClick={() =>
                void navigator.clipboard?.writeText(p.text).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                })
              }
            >
              <ICopy size={14} />
              <span>{copied ? "Copied" : "Copy"}</span>
            </ToolButton>
          )}
          {att.path && (
            <ToolButton title="Reveal in Finder" label="reveal" onClick={() => void api().attachReveal(att.path!).catch((e) => setErr(String(e)))}>
              <IFolderOpen size={14} />
              <span>Reveal in Finder</span>
            </ToolButton>
          )}
          <ToolButton title="Close (Esc)" label="close" onClick={onClose}>
            <IClose size={15} />
          </ToolButton>
        </div>
        <div className="min-h-0 flex-1 bg-bg">
          {err ? (
            <Empty text={err} />
          ) : !p ? (
            <div className="space-y-2.5 p-5">
              {[72, 54, 88, 40, 66].map((w, k) => (
                <div key={k} className="h-[9px] rounded-full bg-raised" style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : p.kind === "text" && lines ? (
            <div className="scroll selectable h-full" data-quicklook-text={lines.length}>
              <table className="w-full border-collapse font-mono text-mono-small leading-[20px]">
                <tbody>
                  {lines.map((toks, n) => (
                    <tr key={n}>
                      <td className="sticky left-0 w-[1%] select-none whitespace-nowrap bg-bg pl-4 pr-4 text-right align-top text-faint tnum opacity-70">{n + 1}</td>
                      <td className="whitespace-pre pr-6 align-top text-fg">
                        {toks.map((t, k) => (
                          <span key={k} style={t.k ? TOK[t.k] : undefined}>
                            {t.t}
                          </span>
                        ))}
                        {toks.length === 0 && " "}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {p.truncated && <div className="px-4 py-3 text-small text-faint">Showing the first {fmtSize(512 * 1024)} of {fmtSize(p.size)}.</div>}
            </div>
          ) : p.kind === "pdf" ? (
            // Pages drawn by the app (Quartz) as images: the PDF itself is never loaded in the page.
            <div className="scroll h-full" data-quicklook-pdf={p.pages.length}>
              <div className="flex flex-col items-center gap-4 px-6 py-5">
                {p.pages.map((src, k) => (
                  <img key={k} src={src} alt={`Page ${k + 1}`} draggable={false} className="w-full max-w-[760px] rounded-[4px] border border-hairline bg-white shadow-card" data-quicklook-pdf-page={k + 1} />
                ))}
                <div className="pb-1 text-small text-faint">
                  {p.count > p.pages.length ? `Showing the first ${p.pages.length} of ${p.count} pages. Reveal it in Finder for the rest.` : `${p.count} page${p.count === 1 ? "" : "s"}`}
                </div>
              </div>
            </div>
          ) : p.kind === "image" ? (
            <div className="flex size-full items-center justify-center p-4">
              <img src={p.data_url} alt={att.name} className="max-h-full max-w-full rounded-[6px] object-contain" />
            </div>
          ) : (
            <Empty text={p.kind === "other" ? `No preview: ${p.reason}. Reveal it in Finder to open it with an app you choose.` : "No preview"} />
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

const TOK: Record<string, React.CSSProperties> = {
  kw: { color: "var(--ctx-file)" },
  str: { color: "var(--ctx-summary)" },
  num: { color: "var(--ctx-tool)" },
  com: { color: "var(--faint)", fontStyle: "italic" },
};

function Empty({ text }: { text: string }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2 px-8 text-center text-faint" data-quicklook-empty>
      <IFile size={22} />
      <span className="max-w-[420px] text-small leading-[18px]">{text}</span>
    </div>
  );
}
