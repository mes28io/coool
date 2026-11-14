// One xterm.js instance per managed PTY, owned here rather than by React so a
// terminal survives its tab being hidden, split, or moved to another pane.
// Its DOM element is parked off-screen while no pane shows it.

import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { api, type PtyChunk } from "./backend";
import { onTerminalTheme, terminalTheme } from "./termlite";

const THEMES: Record<"dark" | "light", ITheme> = {
  dark: {
    background: "#0e1014",
    foreground: "#e4e6eb",
    cursor: "#7cf0c5",
    cursorAccent: "#0e1014",
    selectionBackground: "#7cf0c533",
    black: "#1a1e27",
    red: "#ff6b7a",
    green: "#7cf0c5",
    yellow: "#ffcc66",
    blue: "#8ab4ff",
    magenta: "#b48cff",
    cyan: "#6fd6e8",
    white: "#c9ccd4",
    brightBlack: "#5d6372",
    brightRed: "#ff8f9a",
    brightGreen: "#a3f5d6",
    brightYellow: "#ffdb8f",
    brightBlue: "#adc9ff",
    brightMagenta: "#cbb0ff",
    brightCyan: "#9ae4f0",
    brightWhite: "#f4f5f7",
  },
  light: {
    background: "#fafaf7",
    foreground: "#1b1d22",
    cursor: "#0b8f6a",
    cursorAccent: "#fafaf7",
    selectionBackground: "#0b8f6a2e",
    black: "#1b1d22",
    red: "#c53030",
    green: "#0b8f6a",
    yellow: "#9a6412",
    blue: "#2f6fd6",
    magenta: "#7a4fd6",
    cyan: "#137f94",
    white: "#6b7080",
    brightBlack: "#8a8f9c",
    brightRed: "#d64545",
    brightGreen: "#13a37b",
    brightYellow: "#b7791f",
    brightBlue: "#4a86e8",
    brightMagenta: "#9068e3",
    brightCyan: "#1d97ad",
    brightWhite: "#3a3d45",
  },
};

interface Entry {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  offset: number;
  replayed: boolean;
  queue: PtyChunk[];
  host: HTMLElement | null;
  ro: ResizeObserver | null;
  gl: WebglAddon | null;
  attached: number;
}

function loadGl(e: Entry) {
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => {
      gl.dispose();
      if (e.gl === gl) e.gl = null;
    });
    e.term.loadAddon(gl);
    e.gl = gl;
  } catch {
    // DOM renderer fallback is fine.
  }
}

const reg = new Map<number, Entry>();
let theme: "dark" | "light" = terminalTheme();
let parking: HTMLDivElement | null = null;
let wired = false;

function park(): HTMLDivElement {
  if (!parking) {
    parking = document.createElement("div");
    parking.style.cssText = "position:fixed;left:-10000px;top:0;width:900px;height:600px;overflow:hidden;visibility:hidden;";
    document.body.appendChild(parking);
  }
  return parking;
}

function apply(e: Entry, c: PtyChunk) {
  if (c.offset <= e.offset) return;
  const start = c.offset - c.bytes.length;
  const bytes = start < e.offset ? c.bytes.subarray(e.offset - start) : c.bytes;
  e.offset = c.offset;
  e.term.write(bytes);
}

function wire() {
  if (wired) return;
  wired = true;
  api().onPtyOutput((c) => {
    const e = reg.get(c.id);
    if (!e) return; // replay covers anything before the terminal existed
    if (!e.replayed) e.queue.push(c);
    else apply(e, c);
  });
}

onTerminalTheme((t) => {
  theme = t;
  for (const e of reg.values()) e.term.options.theme = THEMES[t];
});

export function getTerminal(id: number): Entry {
  wire();
  let e = reg.get(id);
  if (e) return e;
  const term = new Terminal({
    fontFamily: '"Geist Mono", ui-monospace, Menlo, monospace',
    fontSize: 12.5,
    lineHeight: 1.22,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorWidth: 2,
    scrollback: 8000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    theme: THEMES[theme],
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const el = document.createElement("div");
  el.style.cssText = "width:100%;height:100%;";
  park().appendChild(el);
  term.open(el);
  // Let app shortcuts (Cmd+K, Cmd+T, ...) through instead of xterm eating them.
  term.attachCustomKeyEventHandler((ev) => !(ev.metaKey && ev.type === "keydown" && ev.key !== "c" && ev.key !== "v"));
  // Once the process is gone, keystrokes (and xterm's focus reports) must not reach the dead PTY.
  let dead = false;
  api().onPtyExit((x) => x === id && (dead = true));
  term.onData((d) => !dead && api().ptyWrite(id, d).catch(() => {}));
  term.onResize(({ rows, cols }) => api().ptyResize(id, rows, cols).catch(() => {}));

  e = { term, fit, el, offset: 0, replayed: false, queue: [], host: null, ro: null, gl: null, attached: 0 };
  reg.set(id, e);
  loadGl(e);
  const entry = e;
  api()
    .ptyReplay(id)
    .then(({ bytes, offset }) => {
      if (bytes.length) term.write(bytes);
      entry.offset = offset;
    })
    .catch(() => {})
    .finally(() => {
      entry.replayed = true;
      for (const c of entry.queue) apply(entry, c);
      entry.queue = [];
    });
  return e;
}

export function attachTerminal(id: number, host: HTMLElement): () => void {
  const e = getTerminal(id);
  e.ro?.disconnect();
  host.appendChild(e.el);
  e.host = host;
  // After the element moves to another pane, xterm's WebGL renderer draws glyphs
  // magnified on HiDPI screens (even a freshly created addon does; its texture
  // atlas is shared). The DOM renderer handles moves correctly, so a terminal
  // that has been re-hosted drops WebGL for good.
  if (e.attached++ > 0 && e.gl) {
    e.gl.dispose();
    e.gl = null;
  }
  let raf = 0;
  const refit = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (host.clientWidth > 20 && host.clientHeight > 20) {
        try {
          e.fit.fit();
        } catch {}
      }
    });
  };
  e.ro = new ResizeObserver(refit);
  e.ro.observe(host);
  refit();
  return () => {
    cancelAnimationFrame(raf);
    e.ro?.disconnect();
    e.ro = null;
    if (e.host === host) {
      park().appendChild(e.el);
      e.host = null;
    }
  };
}

export function focusTerminal(id: number) {
  reg.get(id)?.term.focus();
}
