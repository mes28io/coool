// Pure rules of chat attachments (no DOM, no backend): limits, type labels and tones, the grid shape of a message's
// images, and the small code colorizer of the file preview. Tested by attachRules.test.ts.

export type AttachKind = "image" | "file";

/** One attachment as the core sends and stores it (crates/core/src/attach.rs). */
export interface Attachment {
  name: string;
  mime: string;
  size: number;
  kind: AttachKind;
  /** The file the agent is given. */
  path?: string;
  /** Images: the key the app loads the image with. */
  key?: string;
  /** Why it went differently (e.g. an image type sent as a file). */
  note?: string;
}

/** `attach_paths`: one dropped or picked path. */
export interface AttachAdded {
  path: string;
  name: string;
  attachment: Attachment | null;
  error: string | null;
}

/** `attach_preview`: what a file preview shows. */
export type AttachPreview =
  | { kind: "text"; text: string; truncated: boolean; size: number; mime: string }
  | { kind: "image"; data_url: string; size: number; mime: string }
  | { kind: "pdf"; pages: string[]; count: number; size: number }
  | { kind: "other"; size: number; mime: string; reason: string };

export const MAX_COUNT = 10;
/** Larger images are refused before reading (coool scales anything up to this down to fit). */
export const MAX_IMAGE_SOURCE = 40 * 1024 * 1024;
/** Pasted files (no path of their own) up to this; dropped and picked files have no limit (the agent reads them in place). */
export const MAX_PASTED = 50 * 1024 * 1024;

export interface Incoming {
  name: string;
  size: number;
  mime: string;
  /** Has a path (dropped / picked in the app): no size limit for non-images. */
  path?: string;
}

/**
 * A file drag's position from Tauri, in CSS pixels. Tauri types it as physical, but on macOS wry reports the point in
 * the webview's own coordinates (AppKit points, CSS pixels at zoom 1; wkwebview/drag_drop.rs): dividing by the pixel
 * ratio there put the point at half its place, so on a Retina screen a drag over a chat found no chat under it (no
 * veil, nothing attached). Elsewhere the position is physical pixels.
 */
export function dropPoint(pos: { x: number; y: number }, mac: boolean, ratio: number): { x: number; y: number } {
  const r = mac ? 1 : ratio || 1;
  return { x: pos.x / r, y: pos.y / r };
}

/** Which of `incoming` can be added next to `have` items; the rest with a plain reason. */
export function admit(have: { name: string; size: number }[], incoming: Incoming[]): { ok: number[]; refused: { i: number; reason: string }[] } {
  const ok: number[] = [];
  const refused: { i: number; reason: string }[] = [];
  const seen = new Set(have.map((h) => `${h.name}\u0000${h.size}`));
  let room = MAX_COUNT - have.length;
  incoming.forEach((f, i) => {
    const id = `${f.name}\u0000${f.size}`;
    if (seen.has(id)) return refused.push({ i, reason: "already attached" });
    if (room <= 0) return refused.push({ i, reason: `too many: up to ${MAX_COUNT} per message` });
    if (isImageType(f.mime, f.name) && f.size > MAX_IMAGE_SOURCE) return refused.push({ i, reason: `too large: images up to ${MAX_IMAGE_SOURCE / 1024 / 1024} MB` });
    if (!f.path && f.size > MAX_PASTED) return refused.push({ i, reason: `too large to paste (up to ${MAX_PASTED / 1024 / 1024} MB): drop it or use the attach button instead` });
    if (f.size === 0 && !f.path) return refused.push({ i, reason: "empty file" });
    seen.add(id);
    room--;
    ok.push(i);
  });
  return { ok, refused };
}

export function isImageType(mime: string, name = ""): boolean {
  return /^image\/(png|jpe?g|gif|webp|heic|heif|tiff|bmp)$/.test(mime) || /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i.test(name);
}

export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/** The short type shown on a file's badge: the extension, or a word from the media type. */
export function typeLabel(a: { name: string; mime: string }): string {
  const e = extOf(a.name);
  if (e) return e.length > 4 ? e.slice(0, 4).toUpperCase() : e.toUpperCase();
  if (a.mime === "application/pdf") return "PDF";
  if (a.mime.startsWith("image/")) return "IMG";
  if (a.mime.startsWith("text/")) return "TXT";
  return "FILE";
}

/** The badge's tint, from the context-map palette (no new colours). */
export type Tone = "code" | "doc" | "data" | "media" | "other";
const CODE = /^(rs|ts|tsx|js|jsx|mjs|cjs|py|rb|go|java|kt|swift|c|h|cc|cpp|hpp|m|mm|cs|php|sh|zsh|bash|lua|dart|scala|ex|exs|hs|ml|vue|svelte|astro|zig|sql|css|scss|html|htm|xml)$/;
export function toneOf(a: { name: string; mime: string }): Tone {
  const e = extOf(a.name);
  if (a.mime.startsWith("image/") || a.mime.startsWith("video/") || a.mime.startsWith("audio/")) return "media";
  if (CODE.test(e)) return "code";
  if (a.mime === "application/pdf" || /^(md|markdown|txt|rtf|doc|docx|pages|rst|tex|log)$/.test(e)) return "doc";
  if (/^(json|csv|tsv|yaml|yml|toml|xls|xlsx|numbers|lock|ini|env)$/.test(e) || a.mime === "application/json" || a.mime === "text/csv") return "data";
  return "other";
}
export const TONE_VAR: Record<Tone, string> = {
  code: "var(--ctx-file)",
  doc: "var(--ctx-tool)",
  data: "var(--ctx-summary)",
  media: "var(--ctx-memory)",
  other: "var(--ctx-base)",
};

export function fmtSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * How a message lays out its images: one keeps its shape (up to a box), two sit side by side, three and more make a
 * grid of squares (three columns; four as two by two). At most `max` tiles; the last says how many more there are.
 */
export function gridOf(n: number, max = 6): { cols: number; tiles: number; more: number; single: boolean } {
  if (n <= 0) return { cols: 0, tiles: 0, more: 0, single: false };
  if (n === 1) return { cols: 1, tiles: 1, more: 0, single: true };
  const tiles = Math.min(n, max);
  const cols = n === 2 || n === 4 ? 2 : 3;
  return { cols, tiles, more: n - tiles, single: false };
}

/** Language of a file for the colorizer: comment syntax and keywords. */
function langOf(name: string): { line: string[]; block?: [string, string]; kw: Set<string> } | null {
  const e = extOf(name);
  const c = { line: ["//"], block: ["/*", "*/"] as [string, string] };
  const kwJs = "const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of interface type enum implements public private protected static readonly null undefined true false this super yield void as";
  const kwRs = "fn let mut pub struct enum impl trait use mod crate self Self super match if else for while loop return break continue where as move ref const static type async await dyn unsafe true false Some None Ok Err";
  const kwPy = "def class return if elif else for while in not and or is import from as with try except finally raise lambda pass break continue yield None True False self async await global nonlocal";
  const kwGo = "func package import var const type struct interface map chan go defer return if else for range switch case default break continue select nil true false";
  const kwSh = "if then else elif fi for while do done case esac function return in export local echo exit";
  const kwSwift = "func let var class struct enum protocol extension import return if else guard for while in switch case default break continue self Self nil true false init deinit throws throw try catch async await public private internal static some any";
  const kwC = "int char float double void long short unsigned signed struct union enum typedef static const return if else for while do switch case break continue sizeof include define NULL true false class public private protected virtual namespace using template new delete";
  const set = (s: string) => new Set(s.split(" "));
  if (/^(ts|tsx|js|jsx|mjs|cjs|java|kt|cs|dart|scala|php)$/.test(e)) return { ...c, kw: set(kwJs) };
  if (e === "rs") return { ...c, kw: set(kwRs) };
  if (e === "go") return { ...c, kw: set(kwGo) };
  if (e === "swift") return { ...c, kw: set(kwSwift) };
  if (/^(c|h|cc|cpp|hpp|m|mm)$/.test(e)) return { ...c, kw: set(kwC) };
  if (/^(py|rb)$/.test(e)) return { line: ["#"], kw: set(kwPy) };
  if (/^(sh|zsh|bash|fish|env|toml|yaml|yml|ini|conf|cfg)$/.test(e) || name === "Makefile" || name === "Dockerfile") return { line: ["#"], kw: set(kwSh) };
  if (/^(css|scss|less)$/.test(e)) return { line: [], block: ["/*", "*/"], kw: new Set() };
  if (e === "json") return { line: [], kw: set("true false null") };
  if (e === "sql") return { line: ["--"], kw: set("select from where insert into values update set delete create table index join left right inner outer on and or not null as order by group having limit primary key references") };
  return null;
}

export type Tok = { t: string; k: "" | "kw" | "str" | "com" | "num" };

/**
 * Splits code into coloured tokens, line by line (a block comment or string may span lines). Small on purpose: comments,
 * strings, numbers and keywords. Unknown file types come back as plain lines.
 */
export function colorize(text: string, name: string): Tok[][] {
  const lines = text.split("\n");
  const lang = langOf(name);
  if (!lang) return lines.map((l) => [{ t: l, k: "" }]);
  const out: Tok[][] = [];
  let inBlock = false;
  let inStr: string | null = null;
  for (const line of lines) {
    const toks: Tok[] = [];
    const push = (t: string, k: Tok["k"]) => {
      if (!t) return;
      const last = toks[toks.length - 1];
      if (last && last.k === k) last.t += t;
      else toks.push({ t, k });
    };
    let i = 0;
    while (i < line.length) {
      if (inBlock && lang.block) {
        const j = line.indexOf(lang.block[1], i);
        if (j < 0) {
          push(line.slice(i), "com");
          i = line.length;
        } else {
          push(line.slice(i, j + lang.block[1].length), "com");
          i = j + lang.block[1].length;
          inBlock = false;
        }
        continue;
      }
      if (inStr) {
        let j = i;
        while (j < line.length && line[j] !== inStr) j += line[j] === "\\" ? 2 : 1;
        if (j >= line.length) {
          push(line.slice(i), "str");
          i = line.length;
          if (inStr !== "`") inStr = null;
        } else {
          push(line.slice(i, j + 1), "str");
          i = j + 1;
          inStr = null;
        }
        continue;
      }
      const rest = line.slice(i);
      const lc = lang.line.find((p) => rest.startsWith(p));
      if (lc) {
        push(rest, "com");
        break;
      }
      if (lang.block && rest.startsWith(lang.block[0])) {
        inBlock = true;
        push(lang.block[0], "com");
        i += lang.block[0].length;
        continue;
      }
      const ch = line[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        inStr = ch;
        push(ch, "str");
        i++;
        continue;
      }
      const num = /^\d[\d_]*(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
      if (num && !/[A-Za-z_$]/.test(line[i - 1] ?? "")) {
        push(num[0], "num");
        i += num[0].length;
        continue;
      }
      const word = /^[A-Za-z_$][\w$]*/.exec(rest);
      if (word) {
        push(word[0], lang.kw.has(word[0]) ? "kw" : "");
        i += word[0].length;
        continue;
      }
      push(ch, "");
      i++;
    }
    out.push(toks);
  }
  return out;
}

/**
 * Image paths in an agent's tool input or output (absolute, or `~/`), for a click-to-preview. At most `max`. With
 * `root`, only paths inside it (the chat's folder; the app checks again after resolving symlinks).
 */
export function imagePaths(s: string, max = 4, root?: string): string[] {
  const base = root ? root.replace(/\/+$/, "") + "/" : null;
  const out: string[] = [];
  const re = /(?:^|[\s"'`(=:])((?:\/|~\/)[^\s"'`()<>|;]*?\.(?:png|jpe?g|gif|webp))(?=$|[\s"'`),.;:])/gi;
  for (const m of s.matchAll(re)) {
    const p = m[1];
    if (base && (!p.startsWith(base) || p.includes("/../"))) continue;
    if (!out.includes(p)) out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/** What the attach button asks the system file picker for: several files, no folders. */
export const PICK_OPTIONS = { multiple: true, directory: false, title: "Attach files" } as const;

/** The picker's answer as paths: null (cancelled) gives none; one path or a list as they are. */
export function pickedPaths(r: unknown): string[] {
  if (Array.isArray(r)) return r.filter((p): p is string => typeof p === "string" && p.length > 0);
  return typeof r === "string" && r ? [r] : [];
}

/** The attach button's flow around the picker (`open` is the dialog plugin's): returns how many paths it added. */
export async function pickWith(open: (o: typeof PICK_OPTIONS) => Promise<unknown>, add: (paths: string[]) => Promise<void>): Promise<number> {
  const paths = pickedPaths(await open(PICK_OPTIONS));
  if (paths.length) await add(paths);
  return paths.length;
}
