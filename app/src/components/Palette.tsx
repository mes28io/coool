import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { displayTitle, folderName, homeShort, matchPrevious, previousTitles, projectOf } from "../lib/format";
import { sessionKey } from "../lib/types";
import { seenAt, isUnseen, leaves, resolveTarget, useStore } from "../store";
import { openChatInTerminal } from "../lib/actions";
import { api } from "../lib/backend";
import { useOpenWithName } from "../lib/prefs";
import { openOnboarding } from "../lib/onboarding";
import { IFolder, IGauge, IGear, IGrid, IMoon, ISpark, IPlus, ISearch, ISplitDown, ISplitRight, IStop, ISun, ITerminal } from "./icons";
import { cx, ease, Kbd, ProviderMark, StatusDot } from "./primitives";
import { askStop } from "./SessionView";
import { score } from "../lib/fuzzy";

interface Item {
  id: string;
  group: "Sessions" | "Projects" | "Actions";
  label: string;
  hint?: string;
  /** Other names it is found by: a session's previous titles (CHAT_SPEC "Session titles"). */
  also?: string[];
  icon: ReactNode;
  keys?: string[];
  run: () => void;
}

export function Palette() {
  const open = useStore((s) => s.palette);
  const setPalette = useStore((s) => s.setPalette);
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="pal"
          className="fixed inset-0 z-50 flex justify-center pt-[12vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          transition={{ duration: 0.16 }}
        >
          <div className="absolute inset-0 bg-[var(--backdrop)] backdrop-blur-[2px]" onMouseDown={() => setPalette(false)} />
          <PaletteBody onClose={() => setPalette(false)} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const st = useStore();
  const openWith = useOpenWithName();

  const items = useMemo<Item[]>(() => {
    const done = (f: () => void) => () => {
      onClose();
      f();
    };
    const out: Item[] = [];
    for (const s of st.sessions) {
      out.push({
        id: `s:${sessionKey(s)}`,
        group: "Sessions",
        label: displayTitle(s),
        also: previousTitles(s),
        hint: s.origin === "automation" ? `${folderName(projectOf(s))} · by another tool` : folderName(projectOf(s)),
        icon: (
          <span className="flex items-center gap-1.5">
            <StatusDot status={s.status === "idle" && !isUnseen(st.seen, sessionKey(s), seenAt(s)) ? "ended" : s.status} size={7} />
            <ProviderMark provider={s.provider} size={13} />
          </span>
        ),
        run: done(() => st.open({ kind: "session", key: sessionKey(s) })),
      });
    }
    const seen = new Set<string>();
    for (const s of st.sessions) {
      const proj = projectOf(s);
      if (!proj || seen.has(proj)) continue;
      seen.add(proj);
      out.push({
        id: `p:${proj}`,
        group: "Projects",
        label: `New session in ${folderName(proj)}`,
        hint: homeShort(proj),
        icon: <IFolder size={16} />,
        run: done(() => st.setSheet({ kind: "new", cwd: proj })),
      });
      // Settings > General > "Open files and folders in".
      out.push({
        id: `o:${proj}`,
        group: "Projects",
        label: `Open ${folderName(proj)} in ${openWith}`,
        hint: homeShort(proj),
        icon: <IFolder size={16} />,
        run: done(() => void api().openPath(proj).catch((e) => st.toast(String(e), "error"))),
      });
    }
    const tab = st.tabs.find((t) => t.id === st.activeTab);
    const leaf = tab ? leaves(tab.root).find((l) => l.id === tab.focus) : undefined;
    const r = resolveTarget(leaf?.target ?? null, st);
    out.push(
      { id: "a:new", group: "Actions", label: "New session", icon: <IPlus size={16} />, keys: ["⌘", "T"], run: done(() => st.setSheet({ kind: "new" })) },
      { id: "a:usage", group: "Actions", label: "Show usage", icon: <IGauge size={16} />, run: done(() => st.openSettings("usage")) },
      { id: "a:home", group: "Actions", label: "Home", icon: <IGrid size={16} />, run: done(() => st.activate(null)) },
      { id: "a:onboarding", group: "Actions", label: "Show onboarding again", hint: "Project folder, notifications, open at login", icon: <ISpark size={16} />, run: done(openOnboarding) },
      { id: "a:settings", group: "Actions", label: "Settings", hint: "General, notifications, appearance, shortcuts, providers, devices, storage", icon: <IGear size={16} />, keys: ["⌘", ","], run: done(() => st.openSettings()) },
      {
        id: "a:theme",
        group: "Actions",
        label: `Switch to ${st.theme === "dark" ? "light" : "dark"} theme`,
        icon: st.theme === "dark" ? <ISun size={16} /> : <IMoon size={16} />,
        keys: ["⌘", "⇧", "L"],
        run: done(() => st.toggleTheme()),
      },
    );
    if (tab) {
      out.push(
        { id: "a:sr", group: "Actions", label: "Split right", icon: <ISplitRight size={16} />, keys: ["⌘", "\\"], run: done(() => st.split("row")) },
        { id: "a:sd", group: "Actions", label: "Split down", icon: <ISplitDown size={16} />, keys: ["⌘", "⇧", "\\"], run: done(() => st.split("col")) },
      );
    }
    const live = r.session ? r.session.status !== "ended" : !!r.starting || r.chat !== null;
    const label = r.session ? displayTitle(r.session) : "this session";
    if (r.chat !== null) {
      const chatId = r.chat;
      out.push({ id: "a:term", group: "Actions", label: `Open "${label}" in terminal`, icon: <ITerminal size={16} />, run: done(() => openChatInTerminal(chatId, r.session)) });
    }
    if (live && (r.pty !== null || r.session?.pid || r.chat !== null)) {
      out.push({
        id: "a:stop",
        group: "Actions",
        label: `Stop "${label}"`,
        icon: <IStop size={16} />,
        run: done(() => askStop(r.session, r.pty !== null && st.ptys[r.pty]?.running ? r.pty : null, label, r.chat)),
      });
    }
    return out;
  }, [st, onClose, openWith]);

  const shown = useMemo(() => {
    const scored = items
      .map((it) => {
        // A previous title matches a little below the current one; the row then says which name it found.
        const s = Math.max(score(q, it.label), score(q, it.hint ?? "") * 0.7);
        const was = matchPrevious(q, it.also ?? [], s, score);
        return was ? { it: { ...it, hint: `was: ${was.title}` }, s: was.score } : { it, s };
      })
      .filter((x) => x.s > 0);
    if (q) scored.sort((a, b) => b.s - a.s);
    const order = { Sessions: 0, Actions: 1, Projects: 2 } as const;
    const res = q ? scored.map((x) => x.it) : scored.map((x) => x.it).sort((a, b) => order[a.group] - order[b.group]);
    return res.slice(0, 40);
  }, [items, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  let lastGroup = "";
  return (
    <motion.div
      initial={{ opacity: 0, y: -10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.985, transition: { duration: 0.12 } }}
      transition={{ duration: 0.2, ease }}
      className="relative flex h-fit max-h-[min(520px,70vh)] w-[600px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-[18px] border border-line bg-raised shadow-pop"
    >
      <div className="flex items-center gap-2.5 border-b border-hairline px-4">
        <ISearch size={17} className="text-dim" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Jump to a session or project, or run a command…"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((v) => Math.min(shown.length - 1, v + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((v) => Math.max(0, v - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              shown[sel]?.run();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          className="h-[56px] flex-1 bg-transparent text-base outline-none placeholder:text-faint"
        />
        <Kbd>esc</Kbd>
      </div>
      <div ref={list} className="scroll min-h-0 flex-1 p-1.5">
        {shown.length === 0 && <div className="px-3 py-8 text-center text-base text-dim">Nothing matches “{q}”</div>}
        {shown.map((it, i) => {
          const header = !q && it.group !== lastGroup;
          lastGroup = it.group;
          return (
            <div key={it.id}>
              {header && <div className="px-2.5 pb-1 pt-2.5 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">{it.group}</div>}
              <button
                type="button"
                data-i={i}
                onMouseMove={() => sel !== i && setSel(i)}
                onClick={it.run}
                className={cx("relative flex h-[36px] w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left text-base", i === sel ? "text-fg" : "text-fg/85")}
              >
                {i === sel && <motion.span layoutId="pal-sel" transition={{ type: "spring", stiffness: 700, damping: 45 }} className="absolute inset-0 rounded-[8px] bg-hover" />}
                <span className="relative flex w-[30px] shrink-0 items-center text-dim">{it.icon}</span>
                <span className="relative min-w-0 flex-1 truncate">{it.label}</span>
                {it.hint && <span className="relative max-w-[40%] shrink-0 truncate text-small text-faint">{it.hint}</span>}
                {it.keys && (
                  <span className="relative flex shrink-0 gap-0.5">
                    {it.keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}
