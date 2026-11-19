// "Make it yours": the theme, the window style and the text size, on one screen. Each choice goes through the same
// setters as Settings > Appearance (the store's `setThemePref`, lib/glass.ts, lib/prefs.ts' text size), so it applies
// at once, to the whole app (the title bar above shows through) and to the small sample here, and is saved the same
// way. Skip puts back what was there (keep.ts). Nothing here asks macOS for anything.

import type { ReactNode } from "react";
import { backdropShown, glassState, setBackdrop, setGlassPref, useGlass } from "../../lib/glass";
import { setTextSize, textSizeNow, useTextSize, type TextSize } from "../../lib/prefs";
import { useStore, type ThemePref } from "../../store";
import { PromptBubble, StepLine } from "../Activity";
import { cx, Segmented, StatusDot } from "../primitives";
import { restoreStep, useRestorePoint } from "./keep";

export type WindowStyle = "solid" | "frosted" | "colours";

/** The window style the glass settings add up to. */
export const windowStyle = (g: { pref: boolean; backdrop: string }): WindowStyle => (g.backdrop === "colours" ? "colours" : g.pref ? "frosted" : "solid");

export function setWindowStyle(s: WindowStyle) {
  if (s === "colours") return setBackdrop("colours");
  setBackdrop("desktop");
  setGlassPref(s === "frosted");
}

/** Skip: the theme, glass, backdrop and text size as they were when the step first showed. */
export const skipLook = () => restoreStep("look");

export function LookStep() {
  const themePref = useStore((s) => s.themePref);
  const setThemePref = useStore((s) => s.setThemePref);
  const glass = useGlass();
  const text = useTextSize();
  // Without the glass in this build (the browser mock), "on" can't show: it reads as Solid.
  const style = glass.supported ? windowStyle(glass) : windowStyle({ pref: false, backdrop: glass.backdrop });
  useRestorePoint("look", () => {
    const g = glassState();
    const was = { theme: useStore.getState().themePref, pref: g.pref, backdrop: g.backdrop, text: textSizeNow() };
    return () => {
      const st = useStore.getState();
      if (st.themePref !== was.theme) st.setThemePref(was.theme);
      if (glassState().backdrop !== was.backdrop) setBackdrop(was.backdrop);
      if (glassState().pref !== was.pref) setGlassPref(was.pref);
      if (textSizeNow() !== was.text) setTextSize(was.text);
    };
  });

  const note = glass.reduceTransparency
    ? "macOS Reduce transparency is on (Accessibility > Display), so the window stays solid whatever you pick."
    : !glass.supported && style !== "colours"
      ? "Frosted glass is only in the Mac app."
      : style === "frosted"
        ? "The title bar and side panels blur your desktop through."
        : style === "colours"
          ? "coool’s own soft colours behind the title bar and side panels."
          : "Plain, opaque surfaces.";

  return (
    <div className="flex flex-col gap-4">
      <Sample style={glass.reduceTransparency ? "solid" : style === "frosted" && !glass.supported ? "solid" : style} />
      <div className="flex flex-col rounded-[12px] border border-line bg-panel">
        <Line label="Theme" attr="theme" value={themePref}>
          <Segmented<ThemePref>
            size="sm"
            value={themePref}
            onChange={setThemePref}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "System" },
            ]}
          />
        </Line>
        <Line label="Window" attr="window" value={style} note={note}>
          <Segmented<WindowStyle>
            size="sm"
            value={style}
            onChange={setWindowStyle}
            options={[
              { value: "solid", label: "Solid" },
              { value: "frosted", label: "Frosted glass", disabled: !glass.supported, title: glass.supported ? undefined : "Only in the Mac app" },
              { value: "colours", label: "Colours" },
            ]}
          />
        </Line>
        <Line label="Text size" attr="text" value={text} last>
          <Segmented<TextSize>
            size="sm"
            value={text}
            onChange={setTextSize}
            options={[
              { value: "small", label: "Small" },
              { value: "default", label: "Default" },
              { value: "large", label: "Large" },
              { value: "larger", label: "Larger" },
            ]}
          />
        </Line>
      </div>
    </div>
  );
}

function Line({ label, attr, value, note, last, children }: { label: string; attr: string; value: string; note?: string; last?: boolean; children: ReactNode }) {
  return (
    <div className={cx("flex flex-col gap-1 px-3.5 py-2.5", !last && "border-b border-hairline")} data-onb-look={attr} data-value={value}>
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 text-base text-fg">{label}</span>
        {children}
      </div>
      {note && <span className="text-small text-faint" data-onb-look-note>{note}</span>}
    </div>
  );
}

/**
 * A small window with the real pieces in it: a sidebar strip in the chosen window style (coool's colours, a stand-in
 * for a blurred desktop, or solid), and a prompt bubble and a tool row drawn by the timeline's own components. The
 * theme and text size come from the app itself, so it changes with every click.
 */
function Sample({ style }: { style: WindowStyle }) {
  const colours = style === "colours" && backdropShown();
  return (
    <div className="pointer-events-none flex h-[150px] select-none overflow-hidden rounded-[12px] border border-line shadow-card [@media(max-height:700px)]:h-[104px]" aria-hidden data-onb-sample={style}>
      <div className="relative w-[168px] shrink-0 overflow-hidden border-r border-[var(--glass-line)]">
        {colours ? (
          <div className="absolute inset-0" style={{ background: "var(--backdrop-base)" }}>
            <div className="absolute inset-0" style={{ background: "var(--backdrop-a)" }} />
            <div className="absolute inset-0" style={{ background: "var(--backdrop-b)" }} />
          </div>
        ) : style === "frosted" ? (
          // What a blurred desktop looks like through the glass: soft, out-of-focus shapes.
          <div
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(70% 60% at 20% 20%, color-mix(in oklab, var(--status-running) 22%, transparent), transparent 70%), radial-gradient(60% 70% at 85% 80%, color-mix(in oklab, var(--faint) 40%, transparent), transparent 70%), var(--raised)",
            }}
          />
        ) : null}
        <div className={cx("absolute inset-0", style === "solid" ? "bg-panel" : style === "frosted" ? "bg-[color-mix(in_oklab,var(--panel)_55%,transparent)] backdrop-blur-md" : "bg-chrome")} />
        <div className="relative flex flex-col gap-0.5 p-2 pt-3">
          <MiniRow title="Sticky header" status="idle" selected />
          <MiniRow title="Login tests" status="ended" />
          <MiniRow title="Dark mode" status="ended" />
          <MiniRow title="Release notes" status="ended" />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 overflow-hidden bg-bg px-3 py-1.5">
        <PromptBubble text="Make the header sticky" />
        <StepLine name="Edited" tool="Edit" detail="src/Header.tsx" active={false} />
        <p className="truncate px-0.5 text-prose text-fg">Done. The header stays put.</p>
      </div>
    </div>
  );
}

/** The sidebar's session row, small: title, status dot, the hover tint on the open one. */
function MiniRow({ title, status, selected }: { title: string; status: "idle" | "ended"; selected?: boolean }) {
  return (
    <div className={cx("flex h-[26px] items-center rounded-[7px] pl-2.5 pr-2 text-base", selected ? "bg-hover text-fg" : "text-dim")}>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {status === "idle" && <StatusDot status="idle" size={7} />}
    </div>
  );
}
