// Browser demo of chat attachments (`?attach=demo`): a chat whose earlier message carries three images and two files,
// a second message with one image, and a composer holding images, files, one being read and one refused. Variants:
// `attach=lightbox` (the image viewer open), `attach=file` (a code file's quick look), `attach=pdf` (a PDF's),
// `attach=drop` (the drop veil). Every image is drawn here; nothing is read from disk or the network.
//
// Also the mock backend's attach commands (store, image, preview).

import { useAttach, type Draft } from "./attach";
import type { AttachAdded, AttachPreview, Attachment } from "./attachRules";
import type { MockChat } from "./mockChat";
import { useViewer } from "../components/Attachments";

const store = new Map<string, string>();
const keyOf = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return ((h >>> 0).toString(16) + "00000000").slice(0, 8).padEnd(16, "a");
};

function draw(w: number, h: number, paint: (g: CanvasRenderingContext2D) => void, type = "image/png"): string {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  paint(c.getContext("2d")!);
  return c.toDataURL(type, 0.9);
}

/** An invented "screenshot" of an invoice list, rows of the wrong month marked. */
function invoices(dark: boolean) {
  return draw(1280, 800, (g) => {
    g.fillStyle = dark ? "#1b1d22" : "#f6f7f9";
    g.fillRect(0, 0, 1280, 800);
    g.fillStyle = dark ? "#262a31" : "#ffffff";
    g.fillRect(40, 40, 1200, 720);
    g.fillStyle = dark ? "#e8eaee" : "#1d2330";
    g.font = "600 34px -apple-system, sans-serif";
    g.fillText("Invoices · March", 80, 110);
    for (let i = 0; i < 9; i++) {
      const y = 160 + i * 64;
      const wrong = i % 3 === 1;
      g.fillStyle = wrong ? (dark ? "#3a2a2a" : "#fdecec") : i % 2 ? (dark ? "#2b2f37" : "#f3f5f8") : dark ? "#262a31" : "#ffffff";
      g.fillRect(70, y, 1140, 56);
      g.fillStyle = dark ? "#c9ced8" : "#3b4352";
      g.font = "26px -apple-system, sans-serif";
      g.fillText(`INV-${2041 + i}`, 96, y + 37);
      g.fillText(wrong ? "2026-02" : "2026-03", 420, y + 37);
      g.fillText(`$${(1200 + i * 315).toLocaleString("en-US")}.00`, 980, y + 37);
    }
  });
}

function chart() {
  return draw(960, 640, (g) => {
    const grd = g.createLinearGradient(0, 0, 960, 640);
    grd.addColorStop(0, "#0f1729");
    grd.addColorStop(1, "#1e2a48");
    g.fillStyle = grd;
    g.fillRect(0, 0, 960, 640);
    const vals = [0.42, 0.58, 0.35, 0.8, 0.66, 0.92, 0.51];
    vals.forEach((v, i) => {
      g.fillStyle = i === 5 ? "#5eb0ff" : "#3a5a8c";
      const h = v * 440;
      g.beginPath();
      g.roundRect(90 + i * 115, 560 - h, 70, h, 10);
      g.fill();
    });
    g.fillStyle = "#dbe6ff";
    g.font = "600 30px -apple-system, sans-serif";
    g.fillText("Monthly totals", 90, 80);
  });
}

function phone() {
  return draw(720, 1200, (g) => {
    const grd = g.createLinearGradient(0, 0, 0, 1200);
    grd.addColorStop(0, "#f9d9c4");
    grd.addColorStop(1, "#e7a98c");
    g.fillStyle = grd;
    g.fillRect(0, 0, 720, 1200);
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.roundRect(150, 120, 420, 860, 56);
    g.fill();
    g.fillStyle = "#222";
    g.font = "600 34px -apple-system, sans-serif";
    g.fillText("March", 200, 230);
    for (let i = 0; i < 6; i++) {
      g.fillStyle = i === 2 ? "#ffd8d8" : "#f1f1f1";
      g.beginPath();
      g.roundRect(190, 280 + i * 105, 340, 84, 18);
      g.fill();
    }
  });
}

function sky() {
  return draw(1600, 900, (g) => {
    const grd = g.createLinearGradient(0, 0, 0, 900);
    grd.addColorStop(0, "#26304f");
    grd.addColorStop(0.6, "#c4688a");
    grd.addColorStop(1, "#f5b971");
    g.fillStyle = grd;
    g.fillRect(0, 0, 1600, 900);
    g.fillStyle = "#1b1530";
    g.beginPath();
    g.moveTo(0, 900);
    for (let x = 0; x <= 1600; x += 80) g.lineTo(x, 640 + Math.sin(x / 170) * 70 + Math.cos(x / 60) * 18);
    g.lineTo(1600, 900);
    g.fill();
  }, "image/jpeg");
}

const CODE = `// Formats an invoice's billing period as YYYY-MM.
export function formatPeriod(d: Date): string {
  const y = d.getFullYear();
  /* getMonth() is zero-based: March is 2.
     The old code used it as is, so March came out as 2026-02. */
  const m = d.getMonth() + 1;
  return \`\${y}-\${String(m).padStart(2, "0")}\`;
}

export const PERIOD_RE = /^\\d{4}-\\d{2}$/;
const sample = formatPeriod(new Date(2026, 2, 14)); // "2026-03"
`;

const NOTES = `# March export

- 41 invoices, 14 of them labelled February
- Totals match; only the label is off
- Customers saw it on the PDF header too
`;

/** A page as the app draws it (white, text), for the demo. */
function pdfPage(n: number): string {
  return draw(1224, 1584, (g) => {
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 1224, 1584);
    g.fillStyle = "#111";
    g.font = "600 44px Helvetica, sans-serif";
    g.fillText(n === 1 ? "Invoice export spec" : "Appendix: month numbers", 110, 180);
    g.font = "30px Helvetica, sans-serif";
    const lines = n === 1 ? ["Periods are written YYYY-MM.", "Months start at 01 (January) and end at 12.", "A March invoice is 2026-03, never 2026-02."] : ["01 January   02 February   03 March", "04 April     05 May        06 June"];
    lines.forEach((l, i) => g.fillText(l, 110, 280 + i * 56));
  });
}

/** A one-page PDF drawn by hand (text only). */
export function pdf(): string {
  const text = "Invoice export spec  -  periods are YYYY-MM, months start at 01";
  const content = `BT /F1 18 Tf 60 740 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return "data:application/pdf;base64," + btoa(out);
}

const FILES: Record<string, AttachPreview> = {
  "/Users/you/code/invoices/src/format.ts": { kind: "text", text: CODE, truncated: false, size: CODE.length, mime: "text/plain" },
  "/Users/you/Desktop/march-notes.md": { kind: "text", text: NOTES, truncated: false, size: NOTES.length, mime: "text/markdown" },
  "/Users/you/Downloads/export-spec.pdf": { kind: "pdf", pages: [], count: 2, size: 1180 },
  "/Users/you/Downloads/march-export.zip": { kind: "other", size: 4_812_000, mime: "application/zip", reason: "no preview for this type" },
};

const img = (name: string, src: string, path?: string): Attachment => {
  const key = keyOf(name);
  store.set(key, src);
  const size = Math.round(((src.length - src.indexOf(",") - 1) * 3) / 4);
  return { name, mime: src.slice(5, src.indexOf(";")), size, kind: "image", key, path };
};
const file = (path: string, mime: string, size: number): Attachment => ({ name: path.split("/").pop()!, mime, size, kind: "file", path });

export async function mockAttachPaths(paths: string[]): Promise<AttachAdded[]> {
  return paths.map((p) => ({ path: p, name: p.split("/").pop()!, attachment: file(p, "text/plain", 2048), error: null }));
}

export async function mockAttachBytes(name: string, data: string): Promise<Attachment> {
  await new Promise((r) => setTimeout(r, 500));
  const isImg = /\.(png|jpe?g|gif|webp)$/i.test(name);
  const mime = isImg ? `image/${name.split(".").pop()!.toLowerCase().replace("jpg", "jpeg")}` : "application/octet-stream";
  if (isImg) return img(name, `data:${mime};base64,${data}`, `/Users/you/Library/Application Support/coool/attachments/${keyOf(name)}.png`);
  const path = `/Users/you/Library/Application Support/coool/attachments/files/${keyOf(name)}/${name}`;
  FILES[path] = { kind: "text", text: atob(data).slice(0, 4000), truncated: false, size: (data.length * 3) / 4, mime: "text/plain" };
  return file(path, "text/plain", Math.round((data.length * 3) / 4));
}

export async function mockAttachImage(key: string): Promise<string> {
  const s = store.get(key);
  if (!s) throw new Error("the image isn't available any more");
  return s;
}

export async function mockAttachPreview(path: string, imagesOnly?: boolean, root?: string | null): Promise<AttachPreview> {
  await new Promise((r) => setTimeout(r, 250));
  if (imagesOnly && (!root || !path.startsWith(root + "/"))) throw new Error("outside this chat's folder, so coool doesn't open it");
  const f = FILES[path];
  if (!f) throw new Error("the file is gone (moved or deleted?)");
  return f.kind === "pdf" ? { ...f, pages: [pdfPage(1), pdfPage(2)] } : f;
}

export async function runAttachDemo(c: MockChat) {
  const mode = /[?&]attach=(\w+)/.exec(location.search)?.[1] ?? "demo";
  await new Promise((r) => setTimeout(r, 700));
  const { useStore } = await import("../store");
  useStore.getState().open({ kind: "chat", id: c.id });
  const dark = document.documentElement.dataset.theme !== "light";
  const shots = [img("invoices-march.png", invoices(dark), "/Users/you/Desktop/invoices-march.png"), img("monthly-totals.png", chart()), img("phone-march.png", phone())];
  const files = [file("/Users/you/code/invoices/src/format.ts", "text/plain", CODE.length), file("/Users/you/Desktop/march-notes.md", "text/markdown", NOTES.length)];
  c.emit({ type: "user_message", id: "ua1", text: "These are from the March export. Why do the rows say February?", attachments: [...shots, ...files] } as never);
  c.emit({ type: "state", state: "working" } as never);
  c.emit({ type: "assistant_message", id: "aa1", text: "The rows marked in the screenshot all come from `formatPeriod` in `src/format.ts`: it uses `getMonth()` as is, and that is zero-based, so March prints as `2026-02`. Your notes match: totals are right, only the label is off.", model: "claude-opus-5-5", parent_tool_id: null } as never);
  c.emit({ type: "turn_end", duration_ms: 8200, ok: true } as never);
  c.emit({ type: "state", state: "idle" } as never);
  c.emit({ type: "user_message", id: "ua2", text: "And this one is from the phone, same bug?", attachments: [img("dusk-wallpaper.jpg", sky())] } as never);
  c.emit({ type: "assistant_message", id: "aa2", text: "That one is a wallpaper, not the app: no invoice rows in it. The phone build shares `formatPeriod`, so after the fix it is right there too.", model: "claude-opus-5-5", parent_tool_id: null } as never);
  c.emit({ type: "turn_end", duration_ms: 3100, ok: true } as never);
  c.emit({ type: "state", state: "idle" } as never);

  // The composer: two images, a PDF, one being read, one refused.
  const put = (d: Omit<Draft, "id">, id: string) => useAttach.getState().put(c.id, { ...d, id });
  const a1 = img("Pasted 14.02.11.png", invoices(!dark));
  const a2 = img("export-header.png", chart());
  put({ name: a1.name, size: a1.size, mime: a1.mime, state: "ready", att: a1, thumb: store.get(a1.key!) }, "dm1");
  put({ name: a2.name, size: a2.size, mime: a2.mime, state: "ready", att: a2, thumb: store.get(a2.key!) }, "dm2");
  const spec = file("/Users/you/Downloads/export-spec.pdf", "application/pdf", 1180);
  put({ name: spec.name, size: spec.size, mime: spec.mime, state: "ready", att: spec }, "dm3");
  put({ name: "march-export.csv", size: 0, mime: "text/csv", state: "reading" }, "dm4");
  put({ name: "screen-recording.mov", size: 220_000_000, mime: "video/mp4", state: "error", error: "too large to paste (up to 50 MB): drop it or use the attach button instead" }, "dm5");

  await new Promise((r) => setTimeout(r, 600));
  if (mode === "lightbox") useViewer.getState().open({ kind: "images", items: shots.map((s, i) => ({ id: `demo:${i}`, name: s.name, size: s.size, key: s.key, path: s.path })), index: 0 });
  if (mode === "file") useViewer.getState().open({ kind: "file", att: files[0] });
  if (mode === "pdf") useViewer.getState().open({ kind: "file", att: spec });
  if (mode === "drop") useAttach.getState().setOver({ chat: c.id, count: 3 });
}

/** The browser demo's `media_grant`: pictures are drawn here; movies and sounds aren't available outside the app. */
export async function mockMediaGrant(paths: string[]): Promise<import("./backend").MediaGrant[]> {
  const { mediaKind, baseName } = await import("./mediaRules");
  return paths.map((path) => {
    const kind = mediaKind(path) ?? undefined;
    const name = baseName(path);
    if (kind !== "image") return { path, name, kind, size: 0, error: "only in the app" };
    const url = chart();
    return { path, name, kind, mime: "image/png", url, thumb: url, size: url.length, real: path };
  });
}
