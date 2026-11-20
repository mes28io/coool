// Composer attachments: the per-chat list of what is being added (reading, ready, refused), how files get in (paste,
// drop, the attach button), and the image cache the conversation's thumbnails use. Rules live in attachRules.ts;
// the files themselves are read and stored by the core (crates/core/src/attach.rs, app/src-tauri/src/attach.rs).

import type React from "react";
import { create } from "zustand";
import { api, isTauri } from "./backend";
import { admit, type Attachment, type Incoming } from "./attachRules";
import type { Provider } from "./types";

export interface Draft {
  id: string;
  name: string;
  size: number;
  mime: string;
  state: "reading" | "ready" | "error";
  att?: Attachment;
  error?: string;
  /** A local preview for the composer (an object URL or a data URL). */
  thumb?: string;
}

interface AttachStore {
  drafts: Record<number, Draft[]>;
  /** The chat a drag is over (its drop veil shows), with how many files. */
  over: { chat: number; count: number } | null;
  setOver(o: { chat: number; count: number } | null): void;
  put(chat: number, d: Draft): void;
  patch(chat: number, id: string, p: Partial<Draft>): void;
  remove(chat: number, id: string): void;
  clear(chat: number): void;
}

export const useAttach = create<AttachStore>((set) => ({
  drafts: {},
  over: null,
  setOver: (o) => set((s) => (s.over?.chat === o?.chat && s.over?.count === o?.count ? s : { over: o })),
  put: (chat, d) => set((s) => ({ drafts: { ...s.drafts, [chat]: [...(s.drafts[chat] ?? []), d] } })),
  patch: (chat, id, p) => set((s) => ({ drafts: { ...s.drafts, [chat]: (s.drafts[chat] ?? []).map((d) => (d.id === id ? { ...d, ...p } : d)) } })),
  remove: (chat, id) =>
    set((s) => {
      const d = (s.drafts[chat] ?? []).find((x) => x.id === id);
      if (d?.thumb?.startsWith("blob:")) URL.revokeObjectURL(d.thumb);
      return { drafts: { ...s.drafts, [chat]: (s.drafts[chat] ?? []).filter((x) => x.id !== id) } };
    }),
  clear: (chat) => set((s) => ({ drafts: { ...s.drafts, [chat]: [] } })),
}));

let seq = 0;
const nextId = () => `d${++seq}`;
const EMPTY: Draft[] = [];
export const useDrafts = (chat: number) => useAttach((s) => s.drafts[chat] ?? EMPTY);

/** Refused items show briefly with their reason, then go. */
function refuse(chat: number, name: string, size: number, mime: string, reason: string) {
  const id = nextId();
  useAttach.getState().put(chat, { id, name, size, mime, state: "error", error: reason });
  setTimeout(() => useAttach.getState().remove(chat, id), 6000);
}

const live = (chat: number) => (useAttach.getState().drafts[chat] ?? []).filter((d) => d.state !== "error");

function toBase64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Pasted or (in the browser demo) dropped files: read here, stored by the core. */
export async function addFiles(chat: number, files: File[]) {
  const inc: Incoming[] = files.map((f) => ({ name: f.name || "pasted", size: f.size, mime: f.type || "application/octet-stream" }));
  const { ok, refused } = admit(live(chat), inc);
  for (const r of refused) refuse(chat, inc[r.i].name, inc[r.i].size, inc[r.i].mime, r.reason);
  await Promise.all(
    ok.map(async (i) => {
      const f = files[i];
      // A clipboard image has a generic name ("image.png"): give it the time it was pasted.
      const name = /^image\.(png|jpe?g|gif|webp)$/i.test(f.name) || !f.name ? `Pasted ${new Date().toTimeString().slice(0, 8).replace(/:/g, ".")}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}` : f.name;
      const id = nextId();
      const thumb = f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined;
      useAttach.getState().put(chat, { id, name, size: f.size, mime: f.type, state: "reading", thumb });
      try {
        const att = await api().attachBytes(name, toBase64(await f.arrayBuffer()));
        useAttach.getState().patch(chat, id, { state: "ready", att, size: att.size, mime: att.mime });
      } catch (e) {
        useAttach.getState().patch(chat, id, { state: "error", error: String(e).replace(/^Error: /, "") });
      }
    }),
  );
}

/** Dropped or picked paths (the app): checked and stored by the core. */
export async function addPaths(chat: number, paths: string[]) {
  const names = paths.map((p) => p.split("/").pop() || p);
  const inc: Incoming[] = names.map((n, i) => ({ name: n, size: 0, mime: "", path: paths[i] }));
  // Sizes are unknown until the core looks; count and duplicates are checked now, sizes by the core.
  const { ok, refused } = admit(live(chat).map((d) => ({ name: d.name, size: 0 })), inc);
  for (const r of refused) refuse(chat, names[r.i], 0, "", r.reason);
  const ids = ok.map((i) => {
    const id = nextId();
    useAttach.getState().put(chat, { id, name: names[i], size: 0, mime: "", state: "reading" });
    return id;
  });
  if (!ids.length) return;
  try {
    const res = await api().attachPaths(ok.map((i) => paths[i]));
    res.forEach((r, j) => {
      const id = ids[j];
      if (r.attachment) useAttach.getState().patch(chat, id, { state: "ready", att: r.attachment, size: r.attachment.size, mime: r.attachment.mime, name: r.attachment.name });
      else useAttach.getState().patch(chat, id, { state: "error", error: r.error ?? "couldn't be added" });
    });
  } catch (e) {
    for (const id of ids) useAttach.getState().patch(chat, id, { state: "error", error: String(e).replace(/^Error: /, "") });
  }
}

/** The attach button: the system file picker (the app), or a file input (the browser demo). */
export async function pickFiles(chat: number) {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({ multiple: true, directory: false, title: "Attach files" });
    const paths = Array.isArray(r) ? r : r ? [r] : [];
    if (paths.length) await addPaths(chat, paths);
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.onchange = () => input.files && void addFiles(chat, [...input.files]);
  input.click();
}

/** What a send takes: the ready ones. Refused or still-reading items stay out (the send waits for reading ones). */
export function readyAttachments(chat: number): { atts: Attachment[]; reading: boolean } {
  const ds = useAttach.getState().drafts[chat] ?? [];
  return { atts: ds.filter((d) => d.state === "ready" && d.att).map((d) => d.att!), reading: ds.some((d) => d.state === "reading") };
}

// ---------- drops in the app (Tauri gives paths) ----------

/** The chat under a point: the closest element marked `data-chat-drop`. */
function chatAt(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y)?.closest("[data-chat-drop]");
  const v = el?.getAttribute("data-chat-drop");
  return v ? Number(v) : null;
}

let listening = false;
/** Listens once for the window's file drags (Tauri) and hands drops to the chat under the pointer. */
export async function listenDrops() {
  if (!isTauri || listening) return;
  listening = true;
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  let count = 0;
  await getCurrentWebview().onDragDropEvent((ev) => {
    const p = ev.payload;
    const set = useAttach.getState().setOver;
    if (p.type === "leave") return set(null);
    const r = window.devicePixelRatio || 1;
    const at = "position" in p ? chatAt(p.position.x / r, p.position.y / r) : null;
    if (p.type === "enter") count = p.paths.length;
    if (p.type === "enter" || p.type === "over") return set(at === null ? null : { chat: at, count });
    if (p.type === "drop") {
      set(null);
      if (at !== null && p.paths.length) void addPaths(at, p.paths);
    }
  });
}

/** The browser demo's drops (HTML drag events with File objects; the app gets paths from Tauri instead). */
export function htmlDrop(chat: number) {
  const hasFiles = (e: React.DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  return {
    onDragEnter: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      useAttach.getState().setOver({ chat, count: e.dataTransfer.items.length || 1 });
    },
    onDragOver: (e: React.DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) useAttach.getState().setOver(null);
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      useAttach.getState().setOver(null);
      void addFiles(chat, [...e.dataTransfer.files]);
    },
  };
}

// ---------- images in the conversation ----------

const images = new Map<string, Promise<string>>();
/** An attachment's image as a data URL (cached for the app's life). */
export function loadImage(key: string, provider?: Provider | null, session?: string | null): Promise<string> {
  let p = images.get(key);
  if (!p) {
    p = api().attachImage(key, provider, session);
    images.set(key, p);
    p.catch(() => images.delete(key));
  }
  return p;
}
