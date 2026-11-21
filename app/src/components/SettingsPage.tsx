// The full-screen Settings page (Settings and Usage in the rail, ⌘,, the palette). It lies over the app's sheet
// (sidebar + panes stay mounted underneath, hidden and inert), so going back restores exactly what was there.
// Left: "Back to app", the search box and the categories (a vertical tab list); right: the chosen category, or,
// while searching, every category's matching rows (each Row filters itself, see settings/ui.tsx).

import { motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LADDER, LADDER_LINE } from "../lib/ladderTiers";
import { SETTINGS_SECTIONS, useStore, type SettingsSection } from "../store";
import { remoteApi } from "../lib/remote";
import { IBack, IBell, IBranch, IClose, ICommand, IDisk, IGauge, IGear, IInfo, ILock, IPhone, IPlug, ISearch, ISpark, ISun, ITerminal } from "./icons";
import { PlatformSettings } from "./settings/Platform";
import { cx, ease, Kbd } from "./primitives";
import { LadderSettings } from "./settings/Ladder";
import { Appearance, Shortcuts } from "./settings/Appearance";
import { General, Notifications } from "./settings/General";
import { About, Insights, UsageSection } from "./settings/Other";
import { RemoteSettings } from "./settings/Remote";
import { Devices, Providers, Storage } from "./settings/System";
import { SearchScope, textMatches } from "./settings/ui";
import { Connections, Git } from "./settings/Workspace";
import { IMic } from "./voice/parts";
import { VoiceSettings } from "./voice/SettingsVoice";

const META: Record<SettingsSection, { label: string; icon: ReactNode; desc: string; body: () => ReactNode }> = {
  general: { label: "General", icon: <IGear size={16} />, desc: "New chats, where files open, and what coool does while agents run.", body: () => <General /> },
  ladder: { label: LADDER, icon: <ISpark size={16} />, desc: LADDER_LINE, body: () => <LadderSettings /> },
  notifications: { label: "Notifications", icon: <IBell size={16} />, desc: "macOS notifications when an agent needs you, finishes or fails.", body: () => <Notifications /> },
  voice: { label: "Voice", icon: <IMic size={16} />, desc: "Speak your prompts: a model on this Mac writes them down, in English or as spoken, and learns your words.", body: () => <VoiceSettings /> },
  appearance: { label: "Appearance", icon: <ISun size={16} />, desc: "How coool looks and moves.", body: () => <Appearance /> },
  shortcuts: { label: "Keyboard shortcuts", icon: <ICommand size={16} />, desc: "Every shortcut coool has.", body: () => <Shortcuts /> },
  providers: { label: "Providers", icon: <ITerminal size={16} />, desc: "The Claude Code and Codex CLIs coool runs.", body: () => <Providers /> },
  platform: { label: "Claude Platform", icon: <ILock size={16} />, desc: "Run Claude Code chats on an Anthropic API key instead of your subscription, per folder or per chat.", body: () => <PlatformSettings /> },
  devices: { label: "Devices", icon: <IPhone size={16} />, desc: "The Browser and iPhone panels agents drive, and the device pilot.", body: () => <Devices /> },
  remote: { label: "Remote", icon: <IPhone size={16} />, desc: "Watch and steer coool from a paired iPhone, end-to-end encrypted.", body: () => <RemoteSettings /> },
  git: { label: "Git & worktrees", icon: <IBranch size={16} />, desc: "A project’s repository and the worktrees agents made in it.", body: () => <Git /> },
  connections: { label: "Connections", icon: <IPlug size={16} />, desc: "MCP servers, hooks and plugins your CLIs are set up with.", body: () => <Connections /> },
  storage: { label: "Storage", icon: <IDisk size={16} />, desc: "What coool keeps on this Mac, and what you can clear.", body: () => <Storage /> },
  usage: { label: "Usage", icon: <IGauge size={16} />, desc: "How much of your Claude and Codex plan limits is used, and when each window resets.", body: () => <UsageSection /> },
  insights: { label: "Assist", icon: <ISpark size={16} />, desc: "Live headlines and “Needs you” reasons, written by a small model on your own API key.", body: () => <Insights /> },
  about: { label: "About", icon: <IInfo size={16} />, desc: "This build of coool.", body: () => <About /> },
};

export function SettingsPage() {
  // Remote shows only on a Mac that names a relay of its own (docs/REMOTE.md): the app ships without one.
  const [hasRelay, setHasRelay] = useState(false);
  useEffect(() => {
    remoteApi()
      .then((r) => r.status())
      .then((st) => setHasRelay(!!st.relay))
      .catch(() => {});
  }, []);
  const sections = SETTINGS_SECTIONS.filter((x) => x !== "remote" || hasRelay);
  const section = useStore((s) => s.settings) ?? "general";
  const open = useStore((s) => s.openSettings);
  const close = useStore((s) => s.closeSettings);
  const tabs = useRef<Partial<Record<SettingsSection, HTMLButtonElement | null>>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const searching = words.length > 0;

  // Focus moves into the page (whatever had it is hidden now) and goes back there on return. Read during the first
  // render: by the time effects run the app underneath is inert and has already dropped focus.
  const [prev] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => {
    tabs.current[useStore.getState().settings ?? "general"]?.focus({ preventScroll: true });
    return () => {
      // Only when focus went down with the page (not when the person clicked somewhere else to leave).
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost && prev?.isConnected && !prev.closest("[inert]")) prev.focus({ preventScroll: true });
    };
  }, [prev]);

  // Esc clears the search, then returns, unless the palette or a sheet is on top (they close first). ⌘F searches.
  // Capture phase: it runs before their own handlers.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const st = useStore.getState();
      if (st.palette || st.sheet || e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.key !== "Escape") return;
      // A popover (a Select) open: it closes itself first.
      if (document.querySelector("[role=listbox][aria-label]")?.closest(".shadow-pop")) return;
      e.preventDefault();
      e.stopPropagation();
      if (searchRef.current?.value) {
        setQuery("");
        searchRef.current.focus();
      } else close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  const onNavKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = sections.indexOf(section);
    const n = sections.length;
    const to =
      e.key === "ArrowDown" ? sections[(i + 1) % n] : e.key === "ArrowUp" ? sections[(i - 1 + n) % n] : e.key === "Home" ? sections[0] : e.key === "End" ? sections[n - 1] : null;
    if (!to) return;
    e.preventDefault();
    go(to);
    tabs.current[to]?.focus();
  };
  const go = (s: SettingsSection) => {
    setQuery("");
    open(s);
  };

  // While searching: how many rows matched (rows filter themselves, so count what rendered; async rows come later).
  const panel = useRef<HTMLDivElement>(null);
  const [hits, setHits] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!searching || !panel.current) return setHits(null);
    const el = panel.current;
    const count = () => setHits(el.querySelectorAll("[data-setting]").length);
    count();
    const mo = new MutationObserver(count);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [searching, query]);

  return (
    <motion.div
      data-settings-page={section}
      className="absolute inset-0 z-10 flex bg-bg"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16, ease }}
    >
      <div className="flex w-[240px] shrink-0 flex-col border-r border-hairline">
        <div data-tauri-drag-region className="flex h-[48px] shrink-0 items-center px-2">
          <button
            type="button"
            onClick={close}
            title="Back to app (Esc)"
            className="flex h-[32px] items-center gap-2 rounded-[9px] pl-2 pr-2.5 text-base text-dim transition-colors duration-150 hover:bg-hover hover:text-fg"
            data-settings-back
          >
            <IBack size={16} />
            Back to app
          </button>
        </div>
        <div className="px-2 pb-2 pt-2">
          <label className="flex h-[32px] items-center gap-2 rounded-[9px] border border-line bg-raised px-2.5 transition-[border-color,box-shadow] duration-150 focus-within:border-[color-mix(in_oklab,var(--fg)_30%,var(--border))] focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--fg)_6%,transparent)]">
            <ISearch size={14} className="shrink-0 text-faint" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings"
              aria-label="Search settings"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-faint"
              data-settings-search
            />
            {query ? (
              <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="flex size-[18px] items-center justify-center rounded-[5px] text-faint hover:bg-hover hover:text-fg">
                <IClose size={10} />
              </button>
            ) : (
              <Kbd className="h-[18px] min-w-[18px] border-0 bg-transparent px-0 text-faint">⌘F</Kbd>
            )}
          </label>
        </div>
        <div role="tablist" aria-orientation="vertical" aria-label="Settings" className="scroll flex min-h-0 flex-1 flex-col gap-0.5 px-2 pb-2" onKeyDown={onNavKey}>
          {sections.map((s) => {
            const on = s === section && !searching;
            return (
              <button
                key={s}
                ref={(el) => {
                  tabs.current[s] = el;
                }}
                type="button"
                role="tab"
                id={`settings-tab-${s}`}
                aria-selected={on}
                aria-controls="settings-panel"
                tabIndex={s === section ? 0 : -1}
                data-settings-tab={s}
                onClick={() => go(s)}
                className={cx(
                  "flex h-[34px] shrink-0 items-center gap-2.5 rounded-[9px] px-2.5 text-left text-base transition-colors duration-150",
                  on ? "bg-raised text-fg shadow-card" : "text-dim hover:bg-hover hover:text-fg",
                )}
              >
                <span className={cx("flex", on ? "text-fg" : "text-faint")}>{META[s].icon}</span>
                {META[s].label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5 px-4 pb-4 pt-2 text-small text-faint">
          <Kbd className="h-[20px]">Esc</Kbd> back to app
        </div>
      </div>

      {/* Keyed: a new category (or a search) starts at the top and fades in. */}
      <motion.div
        key={searching ? "search" : section}
        id="settings-panel"
        role="tabpanel"
        aria-labelledby={searching ? undefined : `settings-tab-${section}`}
        aria-label={searching ? "Search results" : undefined}
        className="scroll min-w-0 flex-1"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease }}
      >
        <div data-tauri-drag-region className="h-[48px]" />
        <div className="mx-auto w-full max-w-[700px] px-8 pb-12" ref={panel}>
          {searching ? (
            <>
              <h1 className="text-display font-semibold tracking-[-0.02em] text-fg">Search</h1>
              <p className="mt-1 text-base text-dim" data-settings-hits={hits ?? ""}>
                {hits === 0 ? `Nothing matches “${query.trim()}”.` : `Settings matching “${query.trim()}”.`}
              </p>
              {sections.map((s) => {
                const all = textMatches(words, `${META[s].label} ${META[s].desc}`);
                return (
                  <section key={s} className="mt-9 [&:not(:has([data-setting]))]:hidden" data-search-section={s}>
                    <button type="button" onClick={() => go(s)} className="group mb-3 flex items-center gap-2 text-title font-semibold text-fg">
                      <span className="flex text-faint">{META[s].icon}</span>
                      {META[s].label}
                      <span className="text-small font-normal text-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100">Open</span>
                    </button>
                    <SearchScope words={words} all={all}>
                      {META[s].body()}
                    </SearchScope>
                  </section>
                );
              })}
            </>
          ) : (
            <>
              <h1 className="text-display font-semibold tracking-[-0.02em] text-fg">{META[section].label}</h1>
              <p className="mt-1 text-base text-dim">{META[section].desc}</p>
              <div className="mt-7">{META[section].body()}</div>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
