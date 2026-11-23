// Media in a chat (CHAT_SPEC "Media"), the pure part: what an agent's `show` call shows, which files are pictures,
// movies, sounds or PDFs, and everything a chat holds for its Media panel (the person's attachments, what the agent
// showed, the screenshots its device tools kept, the media files its steps wrote), newest first. Serving is the
// backend's (`media_grant`, `coool-media://`); see lib/media.ts.

import type { Attachment } from "./attachRules";

/** `explainer`: a self-contained .html / .svg (an animation, an interactive diagram), drawn in a sandboxed frame. */
export type MediaKind = "image" | "video" | "audio" | "pdf" | "explainer";
export type MediaSource = "attached" | "shown" | "screenshot" | "written";

export interface MediaItem {
  /** Stable within a chat: the source and the file (or the attachment's key). */
  id: string;
  name: string;
  kind: MediaKind;
  source: MediaSource;
  /** The file (absolute, `~/`, or relative to the chat's folder). */
  path?: string;
  /** An attached image: loaded by key (coool's store, else the transcript). */
  key?: string;
  /** Epoch ms (live chats) or an order number (a transcript's rows): newer is larger. */
  ts: number;
  caption?: string;
  /** An attached video: its length (s) and how many key frames went to the agent. */
  duration?: number;
  frames?: number;
}

const EXT: Record<string, MediaKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", heic: "image", heif: "image", tif: "image", tiff: "image", bmp: "image",
  mp4: "video", mov: "video", m4v: "video", webm: "video",
  m4a: "audio", mp3: "audio", wav: "audio", aac: "audio", aif: "audio", aiff: "audio", caf: "audio",
  pdf: "pdf",
  html: "explainer", htm: "explainer", svg: "explainer",
};

/** A file's kind by its name (null: not media). */
export function mediaKind(name: string, mime?: string): MediaKind | null {
  const m = /\.([a-z0-9]+)$/i.exec(name.split(/[?#]/)[0]);
  const byExt = m ? (EXT[m[1].toLowerCase()] ?? null) : null;
  if (byExt) return byExt;
  if (!mime) return null;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return mime === "application/pdf" ? "pdf" : null;
}

export const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/** A path as one file: relative ones against the chat's folder, `.` and `..` folded (`~/` kept as written). */
export function absPath(p: string, cwd?: string | null): string {
  const full = p.startsWith("/") || p.startsWith("~") || !cwd ? p : `${cwd.replace(/\/+$/, "")}/${p}`;
  const out: string[] = [];
  for (const part of full.split("/")) {
    if (part === "." || (part === "" && out.length > 0)) continue;
    if (part === "..") out.length > 1 && out.pop();
    else out.push(part);
  }
  return out.join("/") || full;
}

/** The same file in a chat (an item's identity for the viewer and for dedupe). */
export const sameFile = (a: MediaItem, b: MediaItem, cwd?: string | null) => a.id === b.id || (!!a.path && !!b.path && absPath(a.path, cwd) === absPath(b.path, cwd));

/** coool's `show` tool: Claude `mcp__coool-device__show`, Codex `coool-device.show`. */
export function isShowTool(name: string): boolean {
  const m = /^(.*?)([._/]+)show$/.exec(name);
  return !!m && /coool[-_]device$/.test(m[1]);
}

/** The files and caption of a `show` call's input (as the backend reads it: `paths`, or one `path`). */
export function shownOf(input: unknown): { paths: string[]; caption?: string } | null {
  const i = (input ?? {}) as { paths?: unknown; path?: unknown; caption?: unknown };
  const paths: string[] = [];
  if (Array.isArray(i.paths)) for (const p of i.paths) if (typeof p === "string" && p.trim()) paths.push(p.trim());
  if (typeof i.paths === "string" && i.paths.trim()) paths.push(i.paths.trim());
  if (typeof i.path === "string" && i.path.trim()) paths.push(i.path.trim());
  if (!paths.length) return null;
  const caption = typeof i.caption === "string" && i.caption.trim() ? i.caption.trim() : undefined;
  return { paths: paths.slice(0, 12), caption };
}

/** Screenshots a device tool kept (its result says `Screenshot saved: <path>`). */
export function savedShots(output: string): string[] {
  const out: string[] = [];
  for (const m of output.matchAll(/^Screenshot saved: (\/.+?\.(?:png|jpe?g))\s*$/gim)) out.push(m[1]);
  return out;
}

/** A local file a reply's markdown links or embeds (not a web URL), when it is media. */
export function localMedia(href: string | undefined | null): { path: string; kind: MediaKind } | null {
  if (!href) return null;
  let p = href.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.startsWith("file://")) return null;
  p = p.replace(/^file:\/\//, "");
  try {
    p = decodeURI(p);
  } catch {
    /* as written */
  }
  if (!p || p.startsWith("#") || p.startsWith("//")) return null;
  const kind = mediaKind(p);
  // A page a reply links (index.html) stays a link: explainers come only from `show`.
  return kind && kind !== "explainer" ? { path: p, kind } : null;
}

const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;

/** What `collectMedia` reads from a chat: its items (lib/chat.ts) and, for a resumed chat, its earlier rows. */
export interface MediaTool {
  kind: "tool";
  id: string;
  name: string;
  input: unknown;
  output: string;
  ts: number;
  ok: boolean | null;
}
export interface MediaMessage {
  kind: "prompt" | "note";
  key: string;
  ts: number;
  attachments?: Attachment[];
}
export interface MediaRow {
  kind: string;
  attachments?: Attachment[];
  media?: { paths: string[]; caption?: string };
}

function fromAttachments(atts: Attachment[] | undefined, at: string, ts: number, out: MediaItem[]) {
  for (const [i, a] of (atts ?? []).entries()) {
    const kind = a.kind === "image" ? "image" : mediaKind(a.name, a.mime);
    if (!kind) continue;
    if (kind === "image" && !a.key && !a.path) continue;
    out.push({
      id: `att:${a.key ?? a.path ?? `${at}:${i}`}`,
      name: a.name,
      kind,
      source: "attached",
      path: a.key ? undefined : a.path,
      key: a.key,
      ts,
      duration: a.duration,
      frames: a.frames?.length || undefined,
    });
  }
}

const perItem = new WeakMap<object, MediaItem[]>();

function itemMedia(it: MediaTool | MediaMessage): MediaItem[] {
  const out: MediaItem[] = [];
  if (it.kind === "prompt" || it.kind === "note") {
    fromAttachments(it.attachments, it.key, it.ts, out);
    return out;
  }
  const t = it as MediaTool;
  if (isShowTool(t.name)) {
    if (t.ok === false) return out;
    const s = shownOf(t.input);
    for (const p of s?.paths ?? []) {
      const k = mediaKind(p);
      if (k) out.push({ id: `file:${p}`, name: baseName(p), kind: k, source: "shown", path: p, ts: t.ts, caption: s?.caption });
    }
  } else if (WRITE_TOOLS.test(t.name)) {
    const p = (t.input as { file_path?: unknown } | null)?.file_path;
    const k = typeof p === "string" ? mediaKind(p) : null;
    if (k && typeof p === "string" && t.ok !== false) out.push({ id: `file:${p}`, name: baseName(p), kind: k, source: "written", path: p, ts: t.ts });
  }
  for (const p of savedShots(t.output ?? "")) out.push({ id: `file:${p}`, name: baseName(p), kind: "image", source: "screenshot", path: p, ts: t.ts });
  return out;
}

/**
 * Everything a chat holds for its Media panel, newest first, each file once (its newest appearance; a file the agent
 * wrote and then showed counts as shown). `earlier`: a resumed chat's rows from its transcript (older than any item).
 */
export function collectMedia(items: readonly (MediaTool | MediaMessage | { kind: string })[], earlier: readonly MediaRow[] = [], cwd?: string | null): MediaItem[] {
  const out: MediaItem[] = [];
  earlier.forEach((r, i) => {
    const ts = i - earlier.length - 1e12;
    if (r.kind === "prompt") fromAttachments(r.attachments, `e${i}`, ts, out);
    if (r.media) for (const p of r.media.paths) { const k = mediaKind(p); if (k) out.push({ id: `file:${p}`, name: baseName(p), kind: k, source: "shown", path: p, ts, caption: r.media.caption }); }
  });
  for (const it of items) {
    if (it.kind !== "prompt" && it.kind !== "note" && it.kind !== "tool") continue;
    // Items are replaced, never changed, when they change: what one holds is worked out once.
    let got = perItem.get(it);
    if (!got) perItem.set(it, (got = itemMedia(it as MediaTool | MediaMessage)));
    out.push(...got);
  }
  const rank: Record<MediaSource, number> = { shown: 3, attached: 2, screenshot: 1, written: 0 };
  const best = new Map<string, MediaItem>();
  for (const m0 of out) {
    // One file however it was named (relative in a `show`, absolute in a Write).
    const m = m0.id.startsWith("file:") && m0.path ? { ...m0, id: `file:${absPath(m0.path, cwd)}` } : m0;
    const o = best.get(m.id);
    if (!o) best.set(m.id, m);
    else best.set(m.id, { ...(rank[m.source] >= rank[o.source] ? m : o), ts: Math.max(m.ts, o.ts), caption: m.caption ?? o.caption });
  }
  // Newest first; within one step (same time) the later file counts as newer, so the reversed list keeps the agent's order.
  return [...best.values()].map((m, i) => ({ m, i })).sort((a, b) => b.m.ts - a.m.ts || b.i - a.i).map((x) => x.m);
}

/** `0:07`, `1:02:05` for a player's clock. */
export function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export const SOURCE_LABEL: Record<MediaSource, string> = { attached: "You attached", shown: "Shown", screenshot: "Screenshot", written: "Agent wrote" };

/** An explainer frame's height: what its page reports, kept between these. */
export const frameHeight = (h: unknown, min = 120, max = 560) => (typeof h === "number" && Number.isFinite(h) ? Math.round(Math.min(max, Math.max(min, h))) : null);
