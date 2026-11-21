// The browser demo of the menu bar item (`?menubar=idle|busy|needs|none`): the bar in each display mode on a light and
// a dark menu bar, and the menu in both appearances. It renders the exact rows the native menu is built from
// (lib/menubarDemo.json, written by the `demo_fixture` test in app/src-tauri/src/menubar/model.rs from invented
// readings), drawn to look like the AppKit menu: a native NSMenu can't be captured without Screen Recording, and a
// self-test never draws the real item.

import demo from "../lib/menubarDemo.json";
import type { MenuBarMode } from "../lib/settingsTypes";

type Seg = { text: string; kind: "label" | "value" | "needs" };
type Bar = { segs: Seg[]; tooltip: string; needs: number };
type Row =
  | { kind: "header"; text: string }
  | { kind: "stat"; id: string; label: string; value: string; detail: string | null; tip: string }
  | { kind: "proc"; id: string; name: string; what: string | null; cpu: string; open: unknown }
  | { kind: "need"; id: string; title: string; detail: string; open: unknown }
  | { kind: "note"; text: string }
  | { kind: "action"; id: string; title: string }
  | { kind: "sep" };
type State = { bars: Record<MenuBarMode, Bar>; rows: Row[] };

const STATES = demo as unknown as Record<string, State>;
export const MENUBAR_STATES = Object.keys(STATES);

/** `?menubar=<state>`: which invented state the demo shows. */
export function menubarDemoState(): string | null {
  const m = /[?&]menubar=([a-z]+)/.exec(location.search);
  return m && STATES[m[1]] ? m[1] : null;
}

const MODES: { mode: MenuBarMode; label: string }[] = [
  { mode: "nothing", label: "Nothing" },
  { mode: "cpu", label: "CPU" },
  { mode: "cpu_memory", label: "CPU, memory and disk" },
  { mode: "needs", label: "Sessions needing you" },
];

// macOS's own menu bar and menu greys (the demo imitates the system's chrome; the only accent is the needs-you colour).
const LOOK = {
  light: { bar: "#ececec", ink: "#000000", dim: "rgb(0 0 0 / 0.5)", menu: "rgb(246 246 246 / 0.97)", line: "rgb(0 0 0 / 0.1)", edge: "rgb(0 0 0 / 0.18)", hi: "#0a84ff" },
  dark: { bar: "#1c1c1e", ink: "#ffffff", dim: "rgb(255 255 255 / 0.55)", menu: "rgb(40 40 42 / 0.97)", line: "rgb(255 255 255 / 0.12)", edge: "rgb(255 255 255 / 0.16)", hi: "#0a84ff" },
} as const;
type Look = { bar: string; ink: string; dim: string; menu: string; line: string; edge: string; hi: string };

const SYS = '-apple-system, "SF Pro Text", "Helvetica Neue", sans-serif';

/** The three o's of coool, as the template glyph draws them (ui.rs `glyph`). */
function Glyph({ ink }: { ink: string }) {
  return (
    <svg width="20" height="16" viewBox="0 0 20 16" aria-hidden>
      {[3.5, 10, 16.5].map((cx) => (
        <circle key={cx} cx={cx} cy={8} r={2.7} fill="none" stroke={ink} strokeWidth={1.6} />
      ))}
    </svg>
  );
}

function BarItem({ bar, look }: { bar: Bar; look: Look }) {
  return (
    <span className="inline-flex h-[24px] items-center rounded-[5px] px-[6px]" title={bar.tooltip} data-menubar-item>
      <Glyph ink={look.ink} />
      {bar.segs.length > 0 && <span style={{ width: 4 }} />}
      {bar.segs.map((s, i) => (
        <span
          key={i}
          style={{
            marginLeft: i > 0 ? (s.kind === "label" ? 7 : 3) : 0,
            color: s.kind === "needs" ? "var(--status-needs)" : s.kind === "label" ? look.dim : look.ink,
            fontSize: s.kind === "label" ? 8.5 : s.kind === "needs" ? 9.5 : 13.5,
            fontWeight: s.kind === "label" ? 600 : 400,
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "pre",
            position: "relative",
            top: s.kind === "value" ? 0 : -1,
          }}
        >
          {s.text}
        </span>
      ))}
    </span>
  );
}

/** A strip of menu bar: some neutral neighbours, coool's item, the clock. */
function Strip({ bar, look, label }: { bar: Bar; look: Look; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-[150px] shrink-0 text-small text-dim">{label}</div>
      <div className="flex h-[28px] w-[420px] items-center justify-end gap-[10px] rounded-[6px] px-3" style={{ background: look.bar, color: look.ink, fontFamily: SYS, fontSize: 13.5 }}>
        <span className="size-[14px] rounded-full border-[1.5px]" style={{ borderColor: look.ink, opacity: 0.85 }} />
        <span className="h-[10px] w-[20px] rounded-[3px] border-[1.5px]" style={{ borderColor: look.ink, opacity: 0.85 }} />
        <BarItem bar={bar} look={look} />
        <span className="h-[12px] w-[14px] rounded-[3px] border-[1.5px]" style={{ borderColor: look.ink, opacity: 0.85 }} />
        <span style={{ fontVariantNumeric: "tabular-nums" }}>Fri 20 Nov 20:31</span>
      </div>
    </div>
  );
}

/** A second line; runs of sparkline blocks in Menlo, as the native menu draws them (ui.rs `push_detail`). */
function Lines({ text, look }: { text: string; look: Look }) {
  return (
    <div style={{ color: look.dim, fontSize: 11.5, lineHeight: "15px", whiteSpace: "pre" }}>
      {text.split(/([\u2581-\u2588]+)/).map((part, i) =>
        /^[\u2581-\u2588]+$/.test(part) ? (
          <span key={i} style={{ fontFamily: "Menlo, monospace" }}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </div>
  );
}

function Menu({ rows, look, hover }: { rows: Row[]; look: Look; hover?: string }) {
  return (
    <div className="rounded-[10px] p-[5px]" style={{ width: 330, background: look.menu, boxShadow: `0 0 0 0.5px ${look.edge}, 0 10px 30px rgb(0 0 0 / 0.25)`, fontFamily: SYS, color: look.ink, fontSize: 13.5 }} data-menubar-menu>
      {rows.map((r, i) => {
        if (r.kind === "sep") return <div key={i} className="mx-[10px] my-[5px] h-px" style={{ background: look.line }} />;
        const on = hover !== undefined && "id" in r && r.id === hover;
        const pad = "px-[10px] py-[3px] rounded-[5px]";
        const style = on ? { background: look.hi, color: "#fff" } : undefined;
        switch (r.kind) {
          case "header":
            return (
              <div key={i} className={pad} style={{ color: look.dim, fontSize: 11.5, fontWeight: 600 }}>
                {r.text}
              </div>
            );
          case "stat":
            return (
              <div key={i} className={pad} title={r.tip}>
                <div className="flex justify-between gap-3">
                  <span>{r.label}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{r.value}</span>
                </div>
                {r.detail && <Lines text={r.detail} look={look} />}
              </div>
            );
          case "proc":
            return (
              <div key={i} className={pad} style={style}>
                <div className="flex justify-between gap-3">
                  <span>{r.name}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{r.cpu}</span>
                </div>
                {r.what && <Lines text={r.what} look={on ? { ...look, dim: "rgb(255 255 255 / 0.8)" } : look} />}
              </div>
            );
          case "need":
            return (
              <div key={i} className={pad} style={style}>
                <div>
                  <span style={{ color: "var(--status-needs)", fontSize: 10, position: "relative", top: -1 }}>●</span> {r.title}
                </div>
                <Lines text={r.detail} look={on ? { ...look, dim: "rgb(255 255 255 / 0.8)" } : look} />
              </div>
            );
          case "note":
            return (
              <div key={i} className={pad}>
                <Lines text={r.text} look={look} />
              </div>
            );
          case "action":
            return (
              <div key={i} className={pad} style={style}>
                {r.title}
              </div>
            );
        }
      })}
    </div>
  );
}

export function MenuBarDemo() {
  const name = menubarDemoState() ?? "needs";
  const st = STATES[name];
  const hover = st.rows.find((r) => r.kind === "need")?.id;
  return (
    <div className="min-h-screen bg-bg p-8 text-fg" data-menubar-demo={name}>
      <div className="mb-1 text-title">Menu bar item · {name}</div>
      <div className="mb-6 text-small text-dim">Browser demo: the native item and NSMenu built from the same rows (menubarDemo.json), on invented readings.</div>
      <div className="mb-8 flex flex-col gap-2">
        {MODES.map((m) => (
          <div key={m.mode} className="flex flex-col gap-1.5">
            <Strip bar={st.bars[m.mode]} look={LOOK.light} label={`${m.label} · light`} />
            <Strip bar={st.bars[m.mode]} look={LOOK.dark} label={`${m.label} · dark`} />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-start gap-8">
        <div className="rounded-[14px] p-6" style={{ background: "#d9dbe0" }}>
          <Menu rows={st.rows} look={LOOK.light} hover={hover} />
        </div>
        <div className="rounded-[14px] p-6" style={{ background: "#2b2d33" }}>
          <Menu rows={st.rows} look={LOOK.dark} />
        </div>
      </div>
    </div>
  );
}
