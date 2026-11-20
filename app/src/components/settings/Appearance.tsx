// Settings > Appearance and Settings > Keyboard shortcuts.

import { useState } from "react";
import { setBackdrop, setGlassPref, useGlass, type Backdrop } from "../../lib/glass";
import { motionHints, setMotionPref, systemReduceMotion, useMotion, type MotionPref } from "../../lib/motion";
import { setTextSize, useTextSize, type TextSize } from "../../lib/prefs";
import { searchShortcuts, type ShortcutGroup } from "../../lib/shortcuts";
import { useStore, type ThemePref } from "../../store";
import { useLayout } from "../../lib/layout";
import type { LayoutPref } from "../../lib/layoutRules";
import { ICheck, ISearch } from "../icons";
import { cx, Kbd, Segmented } from "../primitives";
import { Group, Row, Switch, useSearching } from "./ui";
import { VoiceKeyRows } from "../voice/SettingsVoice";

/** What Auto looks at, each with whether it says "reduce" right now and the reading. */
function autoReasons(): { label: string; on: boolean; now: string }[] {
  const h = motionHints();
  const os = systemReduceMotion();
  const out = [{ label: "macOS Reduce motion (Accessibility)", on: os, now: os ? "on" : "off" }];
  if (!h) return [...out, { label: "Low Power Mode, heat, battery and this Mac’s hardware", on: false, now: "not known in this build" }];
  const hot = h.thermal === "serious" || h.thermal === "critical";
  const low = h.on_battery === true && (h.battery_pct ?? 100) < 20;
  const weak = !!h.intel || (h.memory_gb ?? 99) <= 8 || (h.perf_cores ?? 99) <= 4;
  const hw = [h.intel ? "Intel" : "Apple silicon", h.memory_gb ? `${h.memory_gb} GB` : null, h.perf_cores ? `${h.perf_cores} performance cores` : null].filter(Boolean).join(", ");
  return [
    ...out,
    { label: "Low Power Mode", on: h.low_power, now: h.low_power ? "on" : "off" },
    { label: "Mac running hot", on: hot, now: `thermal state ${h.thermal}` },
    { label: "Battery below 20%", on: low, now: h.on_battery == null ? "no battery" : h.on_battery ? `on battery, ${h.battery_pct ?? "?"}%` : `plugged in${h.battery_pct != null ? `, ${h.battery_pct}%` : ""}` },
    { label: "Intel, 8 GB or less, or 4 performance cores or fewer", on: weak, now: hw || "unknown" },
    { label: "Busy at launch (CPU 70% or more over coool’s first 20 s)", on: !!h.busy_at_launch, now: h.busy_at_launch ? "yes, until coool restarts" : "no" },
  ];
}

export function Appearance() {
  const themePref = useStore((s) => s.themePref);
  const setThemePref = useStore((s) => s.setThemePref);
  const m = useMotion();
  const text = useTextSize();
  const glass = useGlass();
  const layout = useLayout();
  const searching = useSearching();
  const effect =
    m.pref === "on" ? "Reduced motion, because you chose On." : m.pref === "off" ? "Full motion, because you chose Off. Auto’s checks are ignored." : m.reduce ? `Reduced motion. Auto found: ${m.reason ?? "a device reason"}.` : "Full motion. Auto found no reason to reduce.";
  const reasons = m.pref === "auto" && !searching ? autoReasons() : [];
  return (
    <>
      <Group>
        <Row
          attr="theme"
          label="Theme"
          desc="System follows macOS light and dark."
          k="dark light mode color"
          control={<Segmented<ThemePref> size="sm" value={themePref} onChange={setThemePref} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />}
        />
        <Row
          attr="translucent-window"
          label="Translucent window"
          desc={
            !glass.supported
              ? "Frosted title bar, icon rail and device panels. Only in the macOS app."
              : glass.reduceTransparency
                ? "Off while macOS Reduce transparency is on (Accessibility > Display)."
                : "Frosted title bar, icon rail and device panels, with the desktop blurred through."
          }
          k="glass frosted vibrancy blur transparency transparent"
          control={<Switch label="Translucent window" on={glass.pref} disabled={!glass.supported} onChange={setGlassPref} />}
        />
        <Row
          attr="window-backdrop"
          label="Window backdrop"
          desc={
            glass.reduceTransparency
              ? "Off while macOS Reduce transparency is on (Accessibility > Display)."
              : glass.backdrop === "colours"
                ? "coool’s own soft colours behind the title bar, icon rail and device panels, under the same tint."
                : "The title bar, icon rail and device panels show what is behind the window (with the translucent window on)."
          }
          k="backdrop colours colors background wallpaper gradient glass tint"
          control={
            <Segmented<Backdrop>
              size="sm"
              value={glass.backdrop}
              onChange={setBackdrop}
              options={[
                { value: "desktop", label: "Desktop" },
                { value: "colours", label: "Colours" },
              ]}
            />
          }
        />
        <Row
          attr="text-size"
          label="Text size"
          desc="Scales all of coool’s text. Terminals keep their own size."
          k="font zoom bigger smaller"
          control={
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
          }
        />
        <Row
          attr="layout"
          label="Layout"
          desc={
            layout.pref === "auto"
              ? `Automatic stacks things when the window is taller than wide, as on a portrait screen. Now: ${layout.mode === "stacked" ? "stacked" : "side by side"}.`
              : layout.pref === "stacked"
                ? "Panels above the chat, split panes top and bottom, one column on Home, whatever the window’s shape."
                : "Panels beside the chat and split panes side by side, whatever the window’s shape."
          }
          k="portrait vertical rotate monitor screen orientation stacked side by side columns"
          control={
            <Segmented<LayoutPref>
              size="sm"
              value={layout.pref}
              onChange={layout.setPref}
              options={[
                { value: "auto", label: "Automatic" },
                { value: "wide", label: "Side by side" },
                { value: "stacked", label: "Stacked" },
              ]}
            />
          }
        />
        <Row
          attr="reduce-motion"
          label="Reduce motion"
          desc="Still activity glyphs, no shimmer, instant transitions. Auto decides from the checks below."
          k="animation accessibility battery low power"
          control={<Segmented<MotionPref> size="sm" value={m.pref} onChange={setMotionPref} options={[{ value: "auto", label: "Auto" }, { value: "on", label: "On" }, { value: "off", label: "Off" }]} />}
        >
          <div className="flex flex-col gap-2 rounded-[8px] bg-[color-mix(in_oklab,var(--dim)_8%,transparent)] px-3 py-2.5">
            <div className="text-small text-fg/90" data-motion-state={m.reduce ? "reduced" : "full"}>
              <span className="text-faint">In effect: </span>
              {effect}
            </div>
            {reasons.length > 0 && (
              <ul className="flex flex-col gap-1" data-motion-reasons>
                {reasons.map((r) => (
                  <li key={r.label} className="flex items-start gap-2 text-small">
                    <span className="mt-[3px] flex size-[13px] shrink-0 items-center justify-center">
                      {r.on ? <ICheck size={13} className="text-busy-text" /> : <span className="size-[5px] rounded-full bg-faint/50" />}
                    </span>
                    <span className={cx("min-w-0 flex-1", r.on ? "text-fg" : "text-dim")}>{r.label}</span>
                    <span className="shrink-0 text-faint">{r.now}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Row>
      </Group>
    </>
  );
}

// ---------- Keyboard shortcuts ----------

const GROUPS: ShortcutGroup[] = ["General", "Tabs and panes", "In a chat", "In sheets and lists"];

export function Shortcuts() {
  const [q, setQ] = useState("");
  const searching = useSearching();
  const list = searchShortcuts(q);
  return (
    <>
      {!searching && (
        <label className="mb-5 flex h-[34px] items-center gap-2 rounded-[9px] border border-line bg-raised px-2.5 focus-within:border-[color-mix(in_oklab,var(--fg)_30%,var(--border))]">
          <ISearch size={14} className="shrink-0 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter shortcuts"
            aria-label="Filter shortcuts"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-faint"
            data-shortcut-filter
          />
        </label>
      )}
      {GROUPS.map((g) => {
        const rows = list.filter((s) => s.group === g);
        if (!rows.length) return null;
        return (
          <Group key={g} label={g} attr={`shortcuts-${g}`}>
            {rows.map((s) => (
              <Row
                key={s.id}
                dense
                attr={`shortcut-${s.id}`}
                label={s.label}
                k={`${s.keys.join(" ")} ${s.terms ?? ""} shortcut key`}
                control={
                  <span className="flex items-center gap-1">
                    {s.keys.map((k, i) => (
                      <Kbd key={i} className="h-[22px] min-w-[22px] px-1.5">
                        {k}
                      </Kbd>
                    ))}
                  </span>
                }
              />
            ))}
          </Group>
        );
      })}
      {(!q || /voice|talk|dictat|hands|fn|option/i.test(q)) && (
        <Group label="Voice" attr="shortcuts-Voice">
          <VoiceKeyRows />
        </Group>
      )}
      {list.length === 0 && <div className="rounded-[12px] border border-dashed border-line px-4 py-5 text-center text-base text-dim">No shortcut matches “{q}”.</div>}
      {!searching && <p className="px-1 pt-3 text-small text-faint">⌘ also works as Ctrl. The voice keys can be changed here; the others can’t be changed yet.</p>}
    </>
  );
}

