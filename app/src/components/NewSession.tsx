// The New session sheet (APP_SPEC "New session"): find or make the working folder Finder's way, see what is in it
// before starting (git, knowledge, earlier sessions, who works there now), then the first prompt with the composer's
// own options. Everything that touches the disk arrives after the sheet is on screen (lib/folders.ts, the
// `folders_*` commands); places macOS guards (Desktop, Documents, Downloads) are read only once the person opens them.
//
// Keyboard: type to find a folder anywhere (the search field has focus), ↑ ↓ move, → or Enter go in, ← or ⌘↑ go up,
// ⌘⇧N new folder, ⌘L the path (Tab completes), ⌘↵ start. In the list itself, typing selects by name as in Finder.

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { newChat, resumeSession } from "../lib/actions";
import { addFiles, listenDrops, readyAttachments, useAttach } from "../lib/attach";
import { api } from "../lib/backend";
import { fitTextarea } from "../lib/fitTextarea";
import { chatPanelKey } from "../lib/browserAgent";
import { baseName, crumbs, freshName, guardedPlace, nameProblem, parentOf, recentProjects, searchFolders, sessionsIn, tilde, trimSlash, typeSelect, untilde, workingHere, type Candidate } from "../lib/folderRules";
import {
  cachedIndex,
  cachedListing,
  cachedSummary,
  forgetFolder,
  keepIndex,
  keepListing,
  keepSummary,
  noteOpened,
  setShowHidden,
  toggleFavourite,
  useFavourites,
  useOpenedPlaces,
  useShowHidden,
  type FolderIndex,
  type FolderListing,
  type FolderSummary,
} from "../lib/folders";
import { ago, displayTitle, fmtTokens } from "../lib/format";
import { useLadderStatus } from "../lib/ladder";
import { modelColor, modelLabel } from "../lib/models";
import { getChatDefaults, getDefaultCli, useSeenModels } from "../lib/prefs";
import { useOverlaps } from "../lib/projectChanges";
import { modeWords, startProvider } from "../lib/startModes";
import { estimateSize } from "../lib/termlite";
import type { Provider, Session } from "../lib/types";
import { sessionKey } from "../lib/types";
import { useStore } from "../store";
import { AttachButton, AttachTray } from "./Attachments";
import { Caret, ModeGlyph, ModeMenu, ModelMenu, PERMISSION_MODES } from "./ChatComposer";
import {
  IArrowDown,
  IBranch,
  IChevron,
  IClose,
  ICommit,
  IContext,
  IFile,
  IFolder,
  IFolderPlus,
  IHome,
  ILock,
  IMac,
  IOverlap,
  ISearch,
  IStar,
  ITerminal,
} from "./icons";
import { LadderSheetRow, useSheetLadder } from "./LadderSheetRow";
import { Button, Chip, cx, Kbd, Popover, ProviderMark, StatusDot } from "./primitives";
import { bindingWindowId } from "./Usage";
import { VoiceButton } from "./voice/VoiceButton";
import { useVoiceField } from "./voice/VoiceHost";
import { VoiceStrip } from "./voice/VoiceStrip";

/** The sheet's attachments, before a chat exists (lib/attach.ts keys drafts by chat id). */
export const SHEET_DRAFT = -4242;

const label = "px-2 pb-1 pt-3 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint first:pt-1";
const NAME: Record<Provider, string> = { claude: "Claude Code", codex: "Codex" };

type Layout = "full" | "two" | "one";

export function NewSession({ initialCwd, initialProvider, close }: { initialCwd?: string; initialProvider?: Provider; close: () => void }) {
  const env = useStore((s) => s.env);
  const all = useStore((s) => s.allSessions);
  const toast = useStore((s) => s.toast);
  const [index, setIndex] = useState<FolderIndex | null>(() => cachedIndex());
  const home = trimSlash(env?.home || index?.home || "");
  const recents = useMemo(() => recentProjects(all, 8), [all]);

  // ---- the agent ----
  const [provider, setProvider] = useState<Provider>(() =>
    startProvider(initialProvider, getDefaultCli(), all.find((s) => (s.project || s.cwd) === initialCwd)?.provider, env ? { claude: !!env.claude, codex: !!env.codex } : null),
  );
  const missing = env ? !env[provider] : false;

  // ---- where the browser is, and what is chosen ----
  const start = initialCwd || recents[0]?.path || home;
  const [loc, setLoc] = useState(() => (initialCwd ? parentOf(initialCwd) ?? initialCwd : start ? parentOf(start) ?? start : ""));
  const [picked, setPicked] = useState<string | null>(() => start || null);
  const [listing, setListing] = useState<FolderListing | null>(() => (loc ? cachedListing(loc, false) ?? null : null));
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const hidden = useShowHidden();
  const opened = useOpenedPlaces();
  // A guarded place coool already started chats in: macOS let coool's CLIs in there, so listing it asks nothing.
  // A string, so a new sessions snapshot (every few seconds) doesn't list and summarise again.
  const auto = useMemo(() => [...new Set(all.filter((s) => s.origin === "coool").map((s) => guardedPlace(s.cwd, home)).filter(Boolean))].sort().join("|"), [all, home]);
  const allowFor = useCallback((p: string) => {
    const g = guardedPlace(p, home);
    return !g || opened.includes(g) || auto.split("|").includes(g);
  }, [home, opened, auto]);
  const entries = useMemo(() => listing?.entries ?? [], [listing]);
  const favourites = useFavourites();
  const results = useMemo(() => {
    if (!query.trim()) return [];
    const cands: Candidate[] = [
      ...recents.map((r) => ({ path: r.path, name: baseName(r.path), source: "recent" as const, last: r.last })),
      ...favourites.map((p) => ({ path: p, name: baseName(p), source: "favourite" as const })),
      ...entries.map((e) => ({ path: e.path, name: e.name, source: "here" as const, repo: e.repo })),
      ...(index?.hits ?? []).map((h) => ({ path: h.path, name: h.name, source: (h.repo ? "repo" : "folder") as Candidate["source"], repo: h.repo, last: h.modified_ms })),
    ];
    return searchFolders(query, cands, 40);
  }, [query, recents, entries, index, favourites]);
  const target = query.trim() ? results[hit]?.path ?? null : picked;

  // ---- the layout: three columns, two, or one (a narrow or portrait window) ----
  const root = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>("full");
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const fit = () => setLayout(el.clientWidth >= 900 ? "full" : el.clientWidth >= 620 ? "two" : "one");
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- the index (places, repositories): after the sheet is up; asked again while it scans ----
  useEffect(() => {
    let alive = true;
    let tries = 0;
    const extra = [...new Set(recents.map((r) => parentOf(r.path)).filter(Boolean) as string[])];
    const ask = (refresh: boolean) =>
      void api()
        .foldersIndex(extra, refresh)
        .then((i) => {
          if (!alive) return;
          keepIndex(i);
          setIndex(i);
          if (i.scanning && tries++ < 40) setTimeout(() => ask(false), 500);
        })
        .catch(() => {});
    const t = setTimeout(() => ask(false), 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the listing of `loc` (the cached one at once, then fresh) ----
  const listSeq = useRef(0);
  const relist = useCallback(
    (p: string, then?: (l: FolderListing) => void) => {
      const n = ++listSeq.current;
      void api()
        .foldersList(p, hidden, allowFor(p))
        .then((l) => {
          if (n !== listSeq.current) return;
          keepListing(l, hidden);
          setListing(l);
          then?.(l);
        })
        .catch((e) => n === listSeq.current && setListing({ path: p, parent: parentOf(p), entries: [], files: 0, hidden: 0, more: false, protected: null, gated: false, error: String(e) }));
    },
    [hidden, allowFor],
  );
  useEffect(() => {
    if (!loc) return;
    const c = cachedListing(loc, hidden);
    if (c) setListing(c);
    relist(loc);
  }, [loc, relist]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the summary of the chosen folder (debounced; the cached one at once) ----
  const [summary, setSummary] = useState<FolderSummary | null>(null);
  useEffect(() => {
    if (!target) return setSummary(null);
    const c = cachedSummary(target, provider);
    setSummary(c && (c.gated ? !allowFor(target) : true) ? c : null);
    let alive = true;
    const t = setTimeout(() => {
      void api()
        .foldersSummary(target, provider, allowFor(target))
        .then((s) => {
          if (!alive) return;
          keepSummary(s, provider);
          setSummary(s);
        })
        .catch(() => {});
    }, c ? 250 : 90);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [target, provider, allowFor]);

  // ---- options ----
  const defaults = getChatDefaults()[provider];
  const [model, setModel] = useState<string | null | undefined>(undefined);
  const [mode, setMode] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setModel(undefined);
    setMode(undefined);
  }, [provider]);
  const modelNow = model === undefined ? defaults.model : model;
  const modeNow = mode === undefined ? defaults.mode : mode;
  // "Opus · Ask me before each change": what the chat starts with (the self-tests read it).
  const starts = [modelNow ? modelLabel(modelNow) : null, modeWords(provider, modeNow)].filter(Boolean).join(" · ");
  const [pop, setPop] = useState<null | "model" | "mode">(null);
  const ladder = useSheetLadder(provider);
  const [worktree, setWorktree] = useState(false);
  const [withContext, setWithContext] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const voiceId = useVoiceField(ta, { inline: true });
  useEffect(() => void listenDrops().catch(() => {}), []);
  useEffect(() => () => useAttach.getState().clear(SHEET_DRAFT), []);
  useLayoutEffect(() => {
    if (ta.current) fitTextarea(ta.current, 160, 48);
  }, [prompt]);

  const git = summary && !summary.gated ? summary.git : null;
  const canWorktree = !!git?.last;
  useEffect(() => {
    if (!canWorktree) setWorktree(false);
  }, [canWorktree]);

  // ---- moving around ----
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const goTo = (p: string, pick: string | null = null, d: 1 | -1 = 1) => {
    const t = trimSlash(p);
    setDir(d);
    setQuery("");
    setHit(0);
    setCreating(null);
    if (t !== loc) {
      setListing(cachedListing(t, hidden) ?? null);
      setLoc(t);
    }
    setPicked(pick ?? t);
  };
  const up = () => {
    const par = parentOf(loc);
    if (par) goTo(par, loc, -1);
  };
  const into = (p: string) => goTo(p, p, 1);
  const selIndex = entries.findIndex((e) => e.path === picked);
  const moveSel = (delta: number) => {
    if (query.trim()) return setHit((h) => Math.max(0, Math.min(results.length - 1, h + delta)));
    if (!entries.length) return;
    const i = selIndex < 0 ? (delta > 0 ? 0 : entries.length - 1) : Math.max(0, Math.min(entries.length - 1, selIndex + delta));
    setPicked(entries[i].path);
  };
  useEffect(() => {
    const el = list.current?.querySelector(`[data-ns-row="${CSS.escape(target ?? "")}"]`) ?? list.current?.querySelector(`[data-ns-result="${hit}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [target, hit, listing]);

  // Type to select (the list has focus): the typed letters within a second.
  const typed = useRef({ s: "", at: 0 });
  const typeKey = (ch: string) => {
    const now = Date.now();
    const s = now - typed.current.at > 900 ? ch : typed.current.s + ch;
    typed.current = { s, at: now };
    const i = typeSelect(entries.map((e) => e.name), s, selIndex);
    if (i >= 0) setPicked(entries[i].path);
  };

  // ---- new folder (inline, Finder's way) ----
  const [creating, setCreating] = useState<null | { name: string; git: boolean; error: string | null; busy: boolean }>(null);
  const canCreate = !!home && (loc === home || loc.startsWith(home + "/")) && !listing?.gated && !listing?.error;
  const newFolder = () => {
    if (!canCreate) return toast(home && !loc.startsWith(home) ? "New folders go inside your home folder only" : "Open a folder first", "error");
    setQuery("");
    setCreating({ name: freshName(entries.map((e) => e.name)), git: (index?.places ?? []).some((p) => p.kind === "code" && (loc === p.path || loc.startsWith(p.path + "/"))), error: null, busy: false });
  };
  const create = async (andStart: boolean) => {
    if (!creating || creating.busy) return;
    const problem = nameProblem(creating.name, entries.map((e) => e.name));
    if (problem) return setCreating({ ...creating, error: problem });
    setCreating({ ...creating, busy: true, error: null });
    try {
      const p = await api().foldersCreate(loc, creating.name.trim(), creating.git);
      forgetFolder(loc);
      setCreating(null);
      relist(loc, () => setPicked(p));
      setPicked(p);
      if (andStart) void launch(p);
      else ta.current?.focus();
    } catch (e) {
      setCreating((c) => c && { ...c, busy: false, error: String(e).replace(/^Error: /, "") });
    }
  };

  // ---- starting ----
  const launch = async (where: string | null = target) => {
    if (!where || busy || missing) return;
    if (summary && summary.path === where && summary.exists && !summary.is_dir) return toast("That is a file, not a folder", "error");
    setBusy(true);
    try {
      let cwd = where;
      if (worktree && canWorktree) {
        const w = await api().worktreeCreate(where, prompt.trim().split(/\s+/).slice(0, 5).join(" ") || "chat");
        cwd = w.path;
        toast(`New worktree on ${w.branch}`);
      }
      if (terminal) {
        const { rows, cols } = estimateSize();
        const id = await api().spawnSession({ provider, cwd, args: prompt.trim() ? [prompt.trim()] : [], rows, cols });
        const st = useStore.getState();
        st.setMode({ kind: "pty", id }, "terminal");
        st.open({ kind: "pty", id });
      } else {
        const { atts, reading } = readyAttachments(SHEET_DRAFT);
        if (reading) {
          setBusy(false);
          return toast("Wait for the attachments to be read");
        }
        await newChat({
          provider,
          cwd,
          prompt,
          model: model === undefined ? undefined : model,
          permissionMode: mode === undefined ? undefined : mode,
          ladder: ladder.choice,
          attachments: atts,
          started: withContext ? (id) => useStore.getState().setRightPanel(chatPanelKey(id), "context") : undefined,
        });
      }
      close();
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
      setBusy(false);
    }
  };

  const continueSession = (s: Session) => {
    close();
    const st = useStore.getState();
    if (s.chat != null) return st.open({ kind: "chat", id: s.chat });
    if (s.status !== "ended") return st.open({ kind: "session", key: sessionKey(s) });
    void resumeSession(s);
  };

  // ---- keys ----
  const onKeys = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    const inField = (e.target as HTMLElement).closest("input,textarea") as HTMLElement | null;
    const inSearch = inField === search.current;
    const inPrompt = inField === ta.current;
    const meta = e.metaKey || e.ctrlKey;
    if (e.key === "Enter" && meta && !inField?.dataset.nsNewName) {
      e.preventDefault();
      return void launch();
    }
    if (meta && e.shiftKey && (e.key === "N" || e.key === "n")) {
      e.preventDefault();
      return newFolder();
    }
    if (meta && e.shiftKey && e.key === ".") {
      e.preventDefault();
      return setShowHidden(!hidden);
    }
    if (meta && (e.key === "l" || (e.shiftKey && (e.key === "G" || e.key === "g")))) {
      e.preventDefault();
      return pathRef.current?.focus();
    }
    if (meta && e.key === "f") {
      e.preventDefault();
      return search.current?.focus();
    }
    if (inPrompt || (inField && !inSearch)) return;
    // The search field and the list share the browser's keys.
    if (meta && e.key === "ArrowUp") return e.preventDefault(), up();
    if (meta && e.key === "ArrowDown") return e.preventDefault(), target && into(target);
    if (e.key === "ArrowDown") return e.preventDefault(), moveSel(1);
    if (e.key === "ArrowUp") return e.preventDefault(), moveSel(-1);
    const caretEnd = !inSearch || (search.current && search.current.selectionStart === search.current.value.length);
    if (e.key === "ArrowRight" && caretEnd && !query.trim()) return target && target !== loc ? (e.preventDefault(), into(target)) : undefined;
    if (e.key === "ArrowLeft" && (!inSearch || !query)) return e.preventDefault(), up();
    if (e.key === "Enter") {
      e.preventDefault();
      if (target && target !== loc) return into(target);
      return;
    }
    if (!inSearch && e.key.length === 1 && !meta && !e.altKey) {
      e.preventDefault();
      return typeKey(e.key);
    }
  };

  // ---- the path field ----
  const pathRef = useRef<HTMLInputElement>(null);
  const [pathText, setPathText] = useState<string | null>(null);
  const [pathErr, setPathErr] = useState<string | null>(null);
  const [matches, setMatches] = useState<string[]>([]);
  const shownPath = pathText ?? (loc ? tilde(loc, home) : "");
  const completeTab = async () => {
    const text = pathText ?? shownPath;
    const abs = untilde(text, home);
    const c = await api().foldersComplete(text, allowFor(abs)).catch(() => null);
    if (!c) return;
    if (c.gated) return setPathErr(`macOS asks before coool lists ${guardedPlace(abs, home)}: open it from the sidebar`);
    setPathErr(c.matches.length ? null : "No folder starts with that");
    setMatches(c.matches.length > 1 ? c.matches : []);
    if (c.completed) {
      setPathText(c.completed);
      const full = untilde(c.completed, home);
      if (c.completed.endsWith("/")) {
        goTo(trimSlash(full));
        setPathText(c.completed);
      }
    }
  };
  const submitPath = async () => {
    const text = (pathText ?? shownPath).trim();
    if (!text) return;
    const abs = trimSlash(untilde(text, home));
    if (!abs.startsWith("/")) return setPathErr("Type a full path (starting with / or ~)");
    const s = await api().foldersSummary(abs, provider, allowFor(abs)).catch(() => null);
    if (s?.gated) {
      setPathErr(null);
      setPathText(null);
      return goTo(parentOf(abs) ?? abs, abs);
    }
    if (!s?.exists) return setPathErr("No folder here. Go to its parent and make it with New folder");
    if (!s.is_dir) return setPathErr("That is a file, not a folder");
    setPathErr(null);
    setPathText(null);
    setMatches([]);
    into(abs);
    list.current?.focus();
  };

  // First focus: the prompt when a folder was given, else the search (type to find a folder at once).
  useEffect(() => {
    const t = setTimeout(() => (initialCwd ? ta.current : search.current)?.focus({ preventScroll: true }), 30);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Inside a repository, its folders' sessions are its own; a plain folder of projects (~/code) counts only its own.
  const deep = !!(summary && summary.path === target && summary.git?.at_root);
  const sessionsHere = useMemo(() => (target ? sessionsIn(all, target, deep) : []), [all, target, deep]);
  const working = useMemo(() => (target ? workingHere(all, target, deep) : []), [all, target, deep]);
  const overlapsBy = useOverlaps((s) => s.by);
  const clashes = (git ? overlapsBy[git.root] ?? overlapsBy[target ?? ""] ?? [] : []).filter((o) => o.kind === "same").length;
  const busyHere = working.length > 0 || clashes > 0;

  const sidebar = (
    <Sidebar
      home={home}
      index={index}
      recents={recents}
      loc={loc}
      picked={target}
      onGo={(p, asPick) => (asPick ? goTo(parentOf(p) ?? p, p) : goTo(p, p))}
    />
  );
  const details = target ? (
    <Details
      key={target}
      target={target}
      home={home}
      summary={summary}
      provider={provider}
      sessions={sessionsHere}
      working={working}
      clashes={clashes}
      onOpen={(g) => {
        noteOpened(g);
        forgetFolder(target);
      }}
      onContinue={continueSession}
      withContext={withContext}
      setWithContext={setWithContext}
      worktree={worktree}
      canWorktree={canWorktree}
      setWorktree={setWorktree}
      compact={layout !== "full"}
    />
  ) : null;

  return (
    <div
      ref={root}
      className="flex h-full min-h-0 flex-col"
      data-ns-sheet
      data-ns-layout={layout}
      data-ns-loc={loc}
      data-ns-target={target ?? ""}
      onKeyDown={onKeys}
    >
      {/* header: the title, what it does, and the agent */}
      <div className="flex shrink-0 items-start gap-3 px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <div className="text-title font-semibold tracking-[-0.01em]">New session</div>
          <AgentLine provider={provider} missing={missing} />
        </div>
        <AgentSwitch provider={provider} setProvider={setProvider} env={env} />
        <button type="button" title="Close (Esc)" onClick={close} className="-mr-1.5 flex size-7 items-center justify-center rounded-[8px] text-faint transition-colors hover:bg-hover hover:text-fg">
          <IClose size={13} />
        </button>
      </div>

      {/* the finder */}
      <div className="mx-3 flex min-h-0 flex-1 overflow-hidden rounded-[14px] border border-line bg-bg">
        {layout !== "one" && <div className="flex w-[208px] shrink-0 flex-col border-r border-hairline bg-panel">{sidebar}</div>}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* search + path */}
          <div className="flex shrink-0 flex-col gap-1.5 border-b border-hairline px-2.5 pb-2 pt-2.5">
            <div className="flex items-center gap-1.5">
              <label className="flex h-[32px] min-w-0 flex-1 items-center gap-2 rounded-[9px] bg-[color-mix(in_oklab,var(--dim)_10%,transparent)] px-2.5 text-dim focus-within:bg-[color-mix(in_oklab,var(--dim)_14%,transparent)]">
                <ISearch size={14} className="shrink-0 text-faint" />
                <input
                  ref={search}
                  data-ns-search
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setHit(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && query) {
                      e.preventDefault();
                      e.stopPropagation();
                      setQuery("");
                    }
                    if (e.key === "Tab" && !e.shiftKey && !query) {
                      e.preventDefault();
                      ta.current?.focus();
                    }
                  }}
                  placeholder={index?.scanning && !index.hits.length ? "Find a folder… (looking through your code folders)" : "Find a folder or repository…"}
                  spellCheck={false}
                  className="h-full min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-faint"
                />
                {index?.scanning && <span className="spin size-[10px] shrink-0 rounded-full border border-faint border-t-transparent" title="Looking for repositories in your code folders" />}
              </label>
              <button
                type="button"
                data-ns-newfolder
                onClick={newFolder}
                disabled={!canCreate}
                title={canCreate ? `New folder in ${baseName(loc)} (⌘⇧N)` : "New folders go inside your home folder only"}
                className="flex h-[32px] shrink-0 items-center gap-1.5 rounded-[9px] px-2 text-small font-medium text-dim transition-colors hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <IFolderPlus size={15} />
                {layout !== "one" && "New folder"}
              </button>
            </div>
            <div className="relative flex items-center gap-1">
              <button type="button" title="Enclosing folder (⌘↑)" onClick={up} disabled={!parentOf(loc)} className="flex size-[24px] shrink-0 items-center justify-center rounded-[6px] text-faint transition-colors hover:bg-hover hover:text-fg disabled:opacity-30">
                <IChevron size={12} className="rotate-180" />
              </button>
              {pathText === null ? (
                <Crumbs path={loc} home={home} onGo={(p) => goTo(p, p, -1)} onEdit={() => {
                  setPathText(shownPath);
                  requestAnimationFrame(() => pathRef.current?.focus());
                }} />
              ) : null}
              <input
                ref={pathRef}
                data-ns-path
                value={shownPath}
                onFocus={() => pathText === null && setPathText(shownPath)}
                onBlur={() => setTimeout(() => {
                  setPathText(null);
                  setPathErr(null);
                  setMatches([]);
                }, 120)}
                onChange={(e) => {
                  setPathText(e.target.value);
                  setPathErr(null);
                  setMatches([]);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Tab") {
                    e.preventDefault();
                    void completeTab();
                  } else if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void submitPath();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    pathRef.current?.blur();
                  }
                }}
                spellCheck={false}
                aria-label="Folder path"
                title="The folder's path: Tab completes, Enter goes there"
                className={cx(
                  "h-[24px] min-w-0 rounded-[6px] bg-transparent px-1.5 font-mono text-mono-small text-fg outline-none",
                  pathText === null ? "absolute inset-0 -z-10 opacity-0" : "flex-1 bg-[color-mix(in_oklab,var(--dim)_10%,transparent)]",
                )}
              />
              {pathText !== null && (pathErr || matches.length > 0) && (
                <div className="absolute left-7 right-0 top-full z-30 mt-1 rounded-[10px] border border-line bg-raised px-2.5 py-1.5 text-small shadow-pop" data-ns-path-hint>
                  {pathErr ? <span className="text-err-text">{pathErr}</span> : <span className="text-dim">{matches.slice(0, 12).join("   ")}</span>}
                </div>
              )}
            </div>
          </div>

          {/* the list (or the search results) */}
          <div
            ref={list}
            tabIndex={0}
            data-ns-list
            className="scroll relative min-h-0 flex-1 px-1.5 py-1.5 outline-none focus-visible:[&_[data-ns-sel]]:bg-[color-mix(in_oklab,var(--text)_14%,transparent)]"
          >
            {layout === "one" && !query && <PlacesStrip index={index} recents={recents} home={home} onGo={(p) => goTo(p, p)} />}
            {query.trim() ? (
              <Results results={results} hit={hit} home={home} query={query} scanning={!!index?.scanning} setHit={setHit} onGo={into} />
            ) : (
              <AnimatePresence mode="popLayout" initial={false} custom={dir}>
                <motion.div
                  key={loc}
                  custom={dir}
                  initial={{ opacity: 0, x: dir * 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: dir * -6, transition: { duration: 0.08 } }}
                  transition={{ duration: 0.14, ease: [0.22, 0.8, 0.3, 1] }}
                >
                  {creating && (
                    <NewFolderRow
                      c={creating}
                      set={setCreating}
                      onCreate={create}
                      onCancel={() => {
                        setCreating(null);
                        list.current?.focus();
                      }}
                    />
                  )}
                  <Listing
                    listing={listing}
                    loc={loc}
                    picked={picked}
                    hiddenShown={hidden}
                    onPick={setPicked}
                    onInto={into}
                    onOpenPlace={(g) => {
                      noteOpened(g);
                      forgetFolder(loc);
                    }}
                  />
                </motion.div>
              </AnimatePresence>
            )}
          </div>
          {layout !== "full" && details}
        </div>
        {layout === "full" && <div className="scroll flex w-[300px] shrink-0 flex-col border-l border-hairline">{details}</div>}
      </div>

      {/* the first prompt, with the composer's options */}
      <div className="shrink-0 px-3 pt-3">
        <div
          data-chat-drop={SHEET_DRAFT}
          className="rounded-[16px] border border-line bg-raised shadow-card transition-[border-color] duration-200 focus-within:border-[color-mix(in_oklab,var(--dim)_45%,var(--border))]"
        >
          <VoiceStrip target={voiceId} compact />
          {!terminal && <AttachTray chat={SHEET_DRAFT} />}
          <textarea
            ref={ta}
            data-ns-prompt
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onPaste={(e) => {
              const files = [...(e.clipboardData?.files ?? [])];
              if (!files.length || terminal) return;
              e.preventDefault();
              void addFiles(SHEET_DRAFT, files);
            }}
            placeholder={terminal ? "First prompt for the terminal (optional)" : `What should ${provider === "claude" ? "Claude" : "Codex"} work on? (optional)`}
            className="selectable block max-h-[160px] min-h-[48px] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-prose outline-none placeholder:text-faint"
          />
          <div className="flex flex-wrap items-center gap-1 px-2 pb-2" data-new-starts={terminal ? "" : starts}>
            {!terminal && <AttachButton chat={SHEET_DRAFT} provider={provider} />}
            <div className="relative">
              <Chip active={pop === "model"} onClick={() => setPop(pop === "model" ? null : "model")} title={terminal ? "The terminal starts with the CLI's own model" : "Model for this chat"} disabled={terminal}>
                <span className="size-[6px] rounded-full" style={{ background: terminal ? "var(--faint)" : modelColor(modelNow) }} />
                <span data-ns-model={modelNow ?? ""}>{modelNow ? modelLabel(modelNow) : "Default model"}</span>
                <Caret />
              </Chip>
              <Popover open={pop === "model"} onClose={() => setPop(null)} side="top" width={300}>
                <SheetModelMenu provider={provider} current={modelNow} onPick={(m) => (setModel(m), setPop(null))} />
              </Popover>
            </div>
            <div className="relative">
              <Chip active={pop === "mode"} onClick={() => setPop(pop === "mode" ? null : "mode")} title={terminal ? "The terminal starts in the CLI's own mode" : "Permission mode for this chat"} disabled={terminal}>
                <ModeGlyph id={modeNow} />
                <span data-ns-mode={modeNow ?? ""}>{PERMISSION_MODES[provider]?.find((m) => m.id === modeNow)?.label ?? "Default mode"}</span>
                <Caret />
              </Chip>
              <Popover open={pop === "mode"} onClose={() => setPop(null)} side="top" width={300}>
                <ModeMenu
                  provider={provider}
                  current={modeNow}
                  lidOn={false}
                  onPick={(m) => (setMode(m), setPop(null))}
                  def={{ label: "The CLI's default", description: "Whatever its own settings say", onPick: () => (setMode(null), setPop(null)) }}
                />
              </Popover>
            </div>
            {canWorktree && (
              <Chip active={worktree} onClick={() => setWorktree(!worktree)} title={"Start in a new git worktree of this repository: a copy of its own on a new branch (coool/…), so this chat's edits never collide with another agent's.\nIt goes in .coool/worktrees/ and shows in Settings > Git."}>
                <IBranch size={13} />
                <span data-ns-worktree={worktree ? "on" : "off"}>{worktree ? "New worktree" : "Worktree"}</span>
              </Chip>
            )}
            {/* Ladder for this chat (its tiers), in the row so the sheet keeps its height for the folders. */}
            <div className="ml-1 min-w-0 flex-1 pl-1">{!terminal && <LadderSheetRow l={ladder} />}</div>
            <VoiceButton target={voiceId} />
          </div>
        </div>
      </div>

      {/* footer (a form: Start is its submit button) */}
      <form
        className="mt-3 flex shrink-0 items-center gap-2 border-t border-hairline bg-panel/60 px-4 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void launch();
        }}
      >
        {missing ? (
          <span className="text-small text-err-text">Install the {provider} CLI first.</span>
        ) : (
          <button
            type="button"
            onClick={() => setTerminal(!terminal)}
            title="Open the CLI's own terminal UI instead of a chat"
            className={cx("flex h-[30px] shrink-0 items-center gap-1.5 rounded-[8px] px-2 text-small transition-colors duration-150", terminal ? "bg-press text-fg" : "text-faint hover:bg-hover hover:text-fg")}
          >
            <ITerminal size={14} />
            {terminal ? "In a terminal" : layout === "one" ? "Terminal" : "Use terminal instead"}
          </button>
        )}
        <span className="min-w-0 flex-1 truncate text-right text-small text-faint" data-ns-where>
          {target ? (
            <>
              {worktree && canWorktree ? "New worktree of " : "In "}
              <span className="font-mono text-mono-small text-dim">{tilde(target, home)}</span>
              {busyHere && !worktree && <span className="text-needs-text"> · busy</span>}
            </>
          ) : (
            "Choose a folder"
          )}
        </span>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" data-ns-start disabled={!target || busy || missing || (!!summary && summary.path === target && summary.exists && !summary.is_dir)}>
          {busy ? "Starting…" : terminal ? "Start in terminal" : "Start chat"}
          <span className="ml-1 flex gap-0.5 opacity-80">
            <Kbd className="border-transparent bg-[color-mix(in_oklab,var(--bg)_16%,transparent)] text-current">⌘</Kbd>
            <Kbd className="border-transparent bg-[color-mix(in_oklab,var(--bg)_16%,transparent)] text-current">↵</Kbd>
          </span>
        </Button>
      </form>
    </div>
  );
}

// ---------- the header ----------

function AgentSwitch({ provider, setProvider, env }: { provider: Provider; setProvider: (p: Provider) => void; env: { claude: string | null; codex: string | null } | null }) {
  const st = useLadderStatus();
  return (
    <div className="relative mt-0.5 inline-flex h-[34px] shrink-0 rounded-[10px] bg-[color-mix(in_oklab,var(--dim)_12%,transparent)] p-[2px]" role="radiogroup" aria-label="Agent">
      {(["claude", "codex"] as Provider[]).map((p) => {
        const on = p === provider;
        const found = env ? !!env[p] : true;
        const v = st?.[p]?.version;
        return (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={on}
            data-ns-agent={p}
            onClick={() => setProvider(p)}
            title={found ? `${NAME[p]}${v ? ` ${v}` : ""}` : `${NAME[p]} isn't installed`}
            className={cx("relative z-0 flex items-center gap-1.5 rounded-[8px] px-2.5 text-base font-medium transition-colors duration-150", on ? "text-fg" : "text-dim hover:text-fg", !found && "opacity-60")}
          >
            {on && <motion.span layoutId="ns-agent" className="absolute inset-0 -z-10 rounded-[8px] bg-raised shadow-[0_1px_2px_rgb(0_0_0/0.12),0_0_0_0.5px_var(--border)]" transition={{ type: "spring", stiffness: 520, damping: 42 }} />}
            <ProviderMark provider={p} size={14} />
            {NAME[p]}
          </button>
        );
      })}
    </div>
  );
}

/** "Claude Code 2.1.330 · Max · 5-hour limit 64% left": the chosen CLI as the app knows it. */
function AgentLine({ provider, missing }: { provider: Provider; missing: boolean }) {
  const st = useLadderStatus();
  const usage = useStore((s) => s.usage[provider]);
  if (missing) return <div className="mt-0.5 text-small text-err-text">The {provider} CLI isn't installed. Install it, or pick the other agent.</div>;
  const v = st?.[provider]?.version;
  const bits: ReactNode[] = [`${NAME[provider]}${v ? ` ${v.replace(/\s*\(.*\)$/, "")}` : ""}`];
  if (usage?.plan) bits.push(usage.plan);
  const w = usage ? usage.windows.find((x) => x.id === bindingWindowId(usage)) ?? usage.windows.find((x) => x.used_percent !== null) : null;
  if (w && w.used_percent !== null) {
    const left = Math.max(0, Math.round(100 - w.used_percent));
    bits.push(
      <span key="u" className={left <= 10 ? "text-err-text" : left <= 25 ? "text-busy-text" : undefined}>
        {w.label}: {left}% left
      </span>,
    );
  }
  if (st?.[provider]?.logged_in === false) bits.push(<span key="l" className="text-busy-text">not logged in</span>);
  return (
    <div className="mt-0.5 truncate text-small text-dim" data-ns-agent-line>
      Your own login and subscription ·{" "}
      {bits.map((b, i) => (
        <span key={i}>
          {i > 0 && " · "}
          {b}
        </span>
      ))}
    </div>
  );
}

function SheetModelMenu({ provider, current, onPick }: { provider: Provider; current: string | null; onPick: (m: string | null) => void }) {
  const seen = useSeenModels()[provider];
  return (
    <ModelMenu
      provider={provider}
      listed={seen}
      ready={false}
      current={current}
      onPick={onPick}
      before={
        <button type="button" data-model-option="" onClick={() => onPick(null)} className="flex h-[40px] w-full items-center gap-2.5 rounded-[11px] px-2.5 text-left hover:bg-hover">
          <span className="size-[7px] shrink-0 rounded-full bg-faint" />
          <span className="text-base font-medium text-fg">The CLI's default</span>
          <span className="min-w-0 flex-1" />
          {current === null && <span className="text-small text-dim">✓</span>}
        </button>
      }
    />
  );
}

// ---------- the sidebar ----------

function SideRow({ icon, name, meta, on, title, onClick, data, guarded }: { icon: ReactNode; name: string; meta?: ReactNode; on: boolean; title: string; onClick: () => void; data?: string; guarded?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      data-ns-side={data}
      onClick={onClick}
      className={cx("flex h-[30px] w-full items-center gap-2 rounded-[8px] px-2 text-left text-base transition-colors duration-100", on ? "bg-press text-fg" : "text-dim hover:bg-hover hover:text-fg")}
    >
      <span className="flex w-[16px] shrink-0 justify-center text-faint">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {guarded && <ILock size={11} className="shrink-0 text-faint" />}
      {meta && <span className="shrink-0 text-small text-faint tnum">{meta}</span>}
    </button>
  );
}

function placeIcon(kind: string) {
  if (kind === "home") return <IHome size={14} />;
  if (kind === "desktop") return <IMac size={14} />;
  if (kind === "documents") return <IFile size={14} />;
  if (kind === "downloads") return <IArrowDown size={14} />;
  return <IFolder size={14} />;
}

function Sidebar({ home, index, recents, loc, picked, onGo }: { home: string; index: FolderIndex | null; recents: ReturnType<typeof recentProjects>; loc: string; picked: string | null; onGo: (p: string, asPick: boolean) => void }) {
  const favourites = useFavourites();
  const recentSet = new Set(recents.map((r) => r.path));
  const repos = (index?.hits ?? []).filter((h) => h.repo && !recentSet.has(h.path) && !favourites.includes(h.path)).sort((a, b) => b.modified_ms - a.modified_ms).slice(0, 8);
  return (
    <div className="scroll min-h-0 flex-1 px-1.5 pb-2 pt-1.5" data-ns-sidebar>
      {recents.length > 0 && (
        <>
          <div className={label}>Recent projects</div>
          {recents.map((r) => (
            <SideRow
              key={r.path}
              data={r.path}
              icon={<IFolder size={14} />}
              name={baseName(r.path)}
              meta={`${r.count} · ${ago(r.last).replace(" ago", "").replace("just now", "now")}`}
              on={picked === r.path}
              guarded={!!guardedPlace(r.path, home)}
              title={`${tilde(r.path, home)}\n${r.count} session${r.count === 1 ? "" : "s"} (${r.providers.map((p) => NAME[p]).join(", ")}), last ${ago(r.last)}`}
              onClick={() => onGo(r.path, true)}
            />
          ))}
        </>
      )}
      {favourites.length > 0 && (
        <>
          <div className={label}>Favourites</div>
          {favourites.map((p) => (
            <SideRow key={p} data={p} icon={<IStar size={13} />} name={baseName(p)} on={picked === p} title={tilde(p, home)} onClick={() => onGo(p, true)} />
          ))}
        </>
      )}
      <div className={label}>Places</div>
      {(index?.places ?? (home ? [{ kind: "home" as const, label: baseName(home), path: home, guarded: false }] : [])).map((p) => (
        <SideRow key={p.path} data={p.path} icon={placeIcon(p.kind)} name={p.label} on={loc === p.path && picked === p.path} guarded={p.guarded} title={p.guarded ? `${tilde(p.path, home)}\nmacOS asks once before coool can list it` : tilde(p.path, home)} onClick={() => onGo(p.path, false)} />
      ))}
      <div className={label}>
        Repositories
        {index?.scanning && <span className="ml-1.5 font-normal normal-case tracking-normal">looking…</span>}
      </div>
      {repos.length === 0 && <div className="px-2 py-1 text-small text-faint">{index?.scanning || !index ? "Looking in your code folders…" : "None found in your code folders"}</div>}
      {repos.map((h) => (
        <SideRow key={h.path} data={h.path} icon={<IBranch size={13} />} name={h.name} meta={ago(h.modified_ms).replace(" ago", "")} on={picked === h.path} title={`${tilde(h.path, home)}\nlast changed ${ago(h.modified_ms)}`} onClick={() => onGo(h.path, true)} />
      ))}
    </div>
  );
}

/** A narrow sheet's sidebar: one row of chips. */
function PlacesStrip({ index, recents, home, onGo }: { index: FolderIndex | null; recents: ReturnType<typeof recentProjects>; home: string; onGo: (p: string) => void }) {
  const items = [...recents.slice(0, 4).map((r) => ({ path: r.path, label: baseName(r.path) })), ...(index?.places ?? []).map((p) => ({ path: p.path, label: p.label }))];
  return (
    <div className="mb-1 flex gap-1 overflow-x-auto px-1 pb-1" data-ns-strip>
      {items.map((i) => (
        <button key={i.path} type="button" title={tilde(i.path, home)} onClick={() => onGo(i.path)} className="h-[26px] shrink-0 rounded-[7px] border border-line px-2 text-small text-dim hover:bg-hover hover:text-fg">
          {i.label}
        </button>
      ))}
    </div>
  );
}

// ---------- the browser ----------

function Crumbs({ path, home, onGo, onEdit }: { path: string; home: string; onGo: (p: string) => void; onEdit: () => void }) {
  const cs = crumbs(path || "/", home);
  const shown = cs.length > 5 ? [cs[0], { label: "…", path: "" }, ...cs.slice(-3)] : cs;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden" data-ns-crumbs onDoubleClick={onEdit}>
      {shown.map((c, i) => (
        <span key={`${c.path}-${i}`} className="flex min-w-0 items-center gap-0.5">
          {i > 0 && <IChevron size={9} className="shrink-0 text-faint opacity-70" />}
          {c.path ? (
            <button type="button" onClick={() => onGo(c.path)} title={c.path} className={cx("h-[24px] min-w-0 truncate rounded-[6px] px-1.5 text-small transition-colors hover:bg-hover", i === shown.length - 1 ? "font-medium text-fg" : "text-dim hover:text-fg")}>
              {i === 0 && c.path === home ? (
                <span className="flex items-center gap-1">
                  <IHome size={12} />
                  {c.label}
                </span>
              ) : (
                c.label
              )}
            </button>
          ) : (
            <span className="px-1 text-small text-faint">…</span>
          )}
        </span>
      ))}
      <button type="button" onClick={onEdit} title="Type a path (⌘L)" className="ml-auto h-[24px] shrink-0 rounded-[6px] px-1.5 font-mono text-micro text-faint hover:bg-hover hover:text-fg">
        ⌘L
      </button>
    </div>
  );
}

function Listing({ listing, loc, picked, hiddenShown, onPick, onInto, onOpenPlace }: { listing: FolderListing | null; loc: string; picked: string | null; hiddenShown: boolean; onPick: (p: string) => void; onInto: (p: string) => void; onOpenPlace: (g: string) => void }) {
  if (!listing || listing.path !== loc) return <Skeleton />;
  if (listing.gated) return <Gate place={listing.protected ?? "this folder"} onOpen={() => onOpenPlace(listing.protected ?? "")} />;
  if (listing.error) return <div className="px-3 py-6 text-center text-base text-dim">{listing.error}</div>;
  const extra = [listing.files ? `${listing.files} file${listing.files === 1 ? "" : "s"}` : null, listing.hidden && !hiddenShown ? `${listing.hidden} hidden (⌘⇧.)` : null].filter(Boolean).join(" · ");
  return (
    <div role="listbox" aria-label="Folders">
      {listing.entries.length === 0 && <div className="px-3 py-6 text-center text-base text-dim">No folders here{extra ? ` (${extra})` : ""}. Start here, or make one with New folder.</div>}
      {listing.entries.map((e) => {
        const on = e.path === picked;
        return (
          <div
            key={e.path}
            role="option"
            aria-selected={on}
            data-ns-row={e.path}
            data-ns-sel={on || undefined}
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => onPick(e.path)}
            onDoubleClick={() => onInto(e.path)}
            className={cx("group flex h-[30px] items-center gap-2 rounded-[8px] px-2 text-base", on ? "bg-press text-fg" : "text-fg/90 hover:bg-hover", e.hidden && "opacity-60")}
          >
            <span className={cx("flex w-[16px] shrink-0 justify-center", e.repo ? "text-dim" : "text-faint")}>{e.repo ? <IBranch size={13} /> : <IFolder size={14} />}</span>
            <span className="min-w-0 flex-1 truncate">{e.name}</span>
            {e.repo && <span className="shrink-0 rounded-[4px] border border-hairline px-1 font-mono text-micro text-faint">git</span>}
            {e.link && <span className="shrink-0 text-small text-faint">link</span>}
            <button type="button" tabIndex={-1} title="Open" onClick={(ev) => (ev.stopPropagation(), onInto(e.path))} className="flex size-[22px] shrink-0 items-center justify-center rounded-[6px] text-faint opacity-0 transition-opacity hover:bg-hover hover:text-fg group-hover:opacity-100">
              <IChevron size={10} />
            </button>
          </div>
        );
      })}
      {(extra || listing.more) && listing.entries.length > 0 && <div className="px-2 pb-1 pt-2 text-small text-faint">{[extra, listing.more ? "more folders than shown" : null].filter(Boolean).join(" · ")}</div>}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-1 p-1" aria-hidden>
      {[62, 48, 70, 40, 55].map((w, i) => (
        <div key={i} className="flex h-[28px] items-center gap-2 px-1.5">
          <span className="size-[14px] rounded-[4px] bg-hover" />
          <span className="h-[10px] rounded-full bg-hover" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}

/** Before coool lists a place macOS guards: say why macOS will ask, and ask only when the person says so. */
function Gate({ place, onOpen }: { place: string; onOpen: () => void }) {
  return (
    <div className="mx-auto flex max-w-[360px] flex-col items-center gap-2 px-4 py-8 text-center" data-ns-gate={place}>
      <span className="flex size-[34px] items-center justify-center rounded-full bg-hover text-dim">
        <ILock size={16} />
      </span>
      <div className="text-base font-medium text-fg">macOS asks before coool can list your {place}</div>
      <div className="text-small leading-[18px] text-dim">
        coool lists folder names here; for the folder you choose, its git status and the instruction files the agent would read. macOS shows its own prompt once; after that {place} lists like any other folder.
      </div>
      <Button variant="outline" className="mt-1 h-[30px]" onClick={onOpen} data-ns-gate-open>
        List {place}
      </Button>
    </div>
  );
}

function NewFolderRow({ c, set, onCreate, onCancel }: { c: { name: string; git: boolean; error: string | null; busy: boolean }; set: (c: { name: string; git: boolean; error: string | null; busy: boolean }) => void; onCreate: (andStart: boolean) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="mb-1 rounded-[9px] bg-press px-2 py-1.5" data-ns-creating>
      <div className="flex h-[26px] items-center gap-2">
        <span className="flex w-[16px] shrink-0 justify-center text-dim">
          <IFolderPlus size={14} />
        </span>
        <input
          ref={ref}
          data-ns-new-name="1"
          value={c.name}
          disabled={c.busy}
          onChange={(e) => set({ ...c, name: e.target.value, error: null })}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              onCreate(e.metaKey || e.ctrlKey);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          spellCheck={false}
          className="h-[24px] min-w-0 flex-1 rounded-[5px] border border-[color-mix(in_oklab,var(--fg)_30%,var(--border))] bg-bg px-1.5 text-base outline-none"
        />
        <label className="flex shrink-0 cursor-default items-center gap-1.5 text-small text-dim" title="Run git init in it">
          <input type="checkbox" data-ns-new-git checked={c.git} onChange={(e) => set({ ...c, git: e.target.checked })} className="accent-[var(--text)]" />
          git init
        </label>
      </div>
      <div className="flex items-center gap-2 pl-6 pt-1 text-small">
        {c.error ? <span className="text-err-text" data-ns-new-error>{c.error}</span> : <span className="text-faint">↵ create · ⌘↵ create and start · esc cancel</span>}
      </div>
    </div>
  );
}

function Results({ results, hit, home, query, scanning, setHit, onGo }: { results: Candidate[]; hit: number; home: string; query: string; scanning: boolean; setHit: (i: number) => void; onGo: (p: string) => void }) {
  if (!results.length) return <div className="px-3 py-6 text-center text-base text-dim">{scanning ? "Still looking through your code folders…" : `No folder named like “${query.trim()}” in your recent projects, favourites or code folders.`}</div>;
  const tag: Record<string, string> = { recent: "recent", favourite: "favourite", here: "", repo: "", folder: "" };
  return (
    <div role="listbox" aria-label="Matching folders" data-ns-results={results.length}>
      {results.map((r, i) => (
        <div
          key={r.path}
          role="option"
          aria-selected={i === hit}
          data-ns-result={i}
          data-ns-result-path={r.path}
          data-ns-sel={i === hit || undefined}
          onMouseDown={(e) => e.preventDefault()}
          onMouseMove={() => i !== hit && setHit(i)}
          onDoubleClick={() => onGo(r.path)}
          onClick={() => setHit(i)}
          className={cx("flex h-[36px] items-center gap-2 rounded-[8px] px-2", i === hit ? "bg-press" : "hover:bg-hover")}
        >
          <span className="flex w-[16px] shrink-0 justify-center text-faint">{r.repo ? <IBranch size={13} /> : <IFolder size={14} />}</span>
          <span className="min-w-0 shrink-0 truncate text-base text-fg">
            <Hi text={r.name} q={query.trim().split(/\s+/)[0]} />
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-mono-small text-faint">{tilde(parentOf(r.path) ?? "", home)}</span>
          {tag[r.source] && <span className="shrink-0 text-small text-faint">{tag[r.source]}</span>}
        </div>
      ))}
    </div>
  );
}

function Hi({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className="font-semibold">{text.slice(i, i + q.length)}</span>
      {text.slice(i + q.length)}
    </>
  );
}

// ---------- the chosen folder ----------

function Line({ icon, children, title, data }: { icon: ReactNode; children: ReactNode; title?: string; data?: string }) {
  return (
    <div className="flex min-h-[26px] items-start gap-2 py-[3px] text-small leading-[18px]" title={title} data-ns-line={data}>
      <span className="mt-[2px] flex w-[16px] shrink-0 justify-center text-faint">{icon}</span>
      <span className="min-w-0 flex-1 text-dim">{children}</span>
    </div>
  );
}

function Details(p: {
  target: string;
  home: string;
  summary: FolderSummary | null;
  provider: Provider;
  sessions: Session[];
  working: Session[];
  clashes: number;
  onOpen: (g: string) => void;
  onContinue: (s: Session) => void;
  withContext: boolean;
  setWithContext: (v: boolean) => void;
  worktree: boolean;
  canWorktree: boolean;
  setWorktree: (v: boolean) => void;
  compact: boolean;
}) {
  const { target, home, summary: s, sessions, working, clashes, compact } = p;
  const favourites = useFavourites();
  const fav = favourites.includes(target);
  const [showFiles, setShowFiles] = useState(false);
  const ready = s && s.path === target;
  const g = ready ? s.git : null;
  const ctx = ready ? s.context : null;
  const gated = ready && s.gated;
  const shown = sessions.slice(0, compact ? 2 : 5);
  const body = (
    <>
      {!ready && (
        <div className="flex flex-col gap-1.5 py-1" aria-hidden>
          {[70, 52, 64].map((w, i) => (
            <span key={i} className="h-[10px] rounded-full bg-hover" style={{ width: `${w}%` }} />
          ))}
        </div>
      )}
      {gated && (
        <Line icon={<ILock size={12} />} data="gated">
          In your {s!.protected}: macOS asks once before coool can look inside.{" "}
          <button type="button" className="text-fg underline decoration-faint underline-offset-2" onClick={() => p.onOpen(s!.protected!)} data-ns-gate-open>
            Look inside
          </button>
        </Line>
      )}
      {ready && !gated && !s.exists && <Line icon={<IFolder size={13} />}>This folder doesn't exist.</Line>}
      {ready && !gated && s.exists && !s.is_dir && <Line icon={<IFile size={13} />}>This is a file, not a folder.</Line>}
      {ready && !gated && s.is_dir && (
        <>
          {g ? (
            <Line icon={<IBranch size={13} />} data="git" title={g.root}>
              <span className="font-mono text-mono-small text-fg">{g.branch ?? "detached"}</span>
              {g.changes !== null && <span> · {g.changes === 0 ? "clean" : `${g.changes} uncommitted`}</span>}
              {g.worktree_of && <span> · worktree of {baseName(g.worktree_of)}</span>}
              {!g.at_root && <span> · in {baseName(g.root)}</span>}
            </Line>
          ) : (
            <Line icon={<IBranch size={13} />} data="git">Not a git repository</Line>
          )}
          {g?.last && (
            <Line icon={<ICommit size={13} />} data="commit" title={`${g.last.short} ${g.last.subject}`}>
              <span className="text-fg/90">{g.last.subject}</span> · {ago(g.last.when_ms)}
            </Line>
          )}
          {g && !g.last && <Line icon={<ICommit size={13} />}>No commits yet</Line>}
          {!compact && (
            <Line icon={<IFolder size={13} />} data="contents">
              {[s.stack.join(" · ") || null, s.folders ? `${s.folders} folder${s.folders === 1 ? "" : "s"}` : null, s.files ? `${s.files} file${s.files === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ") || "Empty folder"}
              {!s.writable && <span className="text-busy-text"> · read only</span>}
            </Line>
          )}
          {ctx && (
            <Line icon={<IContext size={13} />} data="knowledge">
              <button type="button" onClick={() => setShowFiles(!showFiles)} className="text-left hover:text-fg" title="What the agent reads at start (the Context panel's lookup)">
                {ctx.project.length ? ctx.project.map((f) => baseName(f.path)).join(", ") : `No ${p.provider === "claude" ? "CLAUDE.md" : "AGENTS.md"}`}
                {" · "}
                {ctx.skills} skill{ctx.skills === 1 ? "" : "s"}
                {ctx.project_skills ? ` (${ctx.project_skills} here)` : ""}
                {ctx.memory ? " · memory" : ""} · {fmtTokens(ctx.tokens)} tokens
              </button>
              {showFiles && (
                <span className="mt-1 flex flex-col gap-0.5">
                  {ctx.project.map((f) => (
                    <span key={f.path} className="flex gap-2 font-mono text-mono-small">
                      <span className="min-w-0 flex-1 truncate text-dim" title={f.path}>
                        {tilde(f.path, home)}
                      </span>
                      <span className="shrink-0 text-faint tnum">{fmtTokens(f.tokens)}</span>
                    </span>
                  ))}
                  {ctx.user > 0 && <span className="text-faint">and {ctx.user} of your own instruction file{ctx.user === 1 ? "" : "s"}</span>}
                </span>
              )}
              <label className="mt-1 flex items-center gap-1.5 text-faint" title="The chat opens with the Context panel beside it, where these files can be read and edited">
                <input type="checkbox" checked={p.withContext} onChange={(e) => p.setWithContext(e.target.checked)} className="accent-[var(--text)]" data-ns-with-context />
                Open the Context panel too
              </label>
            </Line>
          )}
        </>
      )}
      {(working.length > 0 || clashes > 0) && (
        <div className="mt-1.5 rounded-[10px] bg-[color-mix(in_oklab,var(--status-needs)_10%,transparent)] px-2.5 py-2 text-small leading-[18px]" data-ns-busy={working.length}>
          <div className="flex items-center gap-1.5 font-medium text-needs-text">
            <IOverlap size={13} />
            {working.length ? `${working.length} agent${working.length === 1 ? " is" : "s are"} working in this copy now` : "Two sessions are editing the same files here"}
          </div>
          <div className="mt-0.5 text-dim">
            {clashes > 0 && `${clashes} file${clashes === 1 ? "" : "s"} with edits from two sessions. `}
            {p.canWorktree ? "A new worktree keeps this chat's edits apart." : "Their edits and this chat's would land in the same files."}
          </div>
          {p.canWorktree && (
            <button type="button" onClick={() => p.setWorktree(!p.worktree)} className={cx("mt-1.5 flex h-[26px] items-center gap-1.5 rounded-[7px] px-2 font-medium", p.worktree ? "bg-press text-fg" : "bg-raised text-fg hover:bg-hover")} data-ns-busy-worktree>
              <IBranch size={12} />
              {p.worktree ? "Starts in a new worktree" : "Start in a new worktree"}
            </button>
          )}
        </div>
      )}
      {sessions.length > 0 && (
        <div className="mt-2">
          <div className="flex items-center px-0 pb-1 pt-1 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">
            Sessions here <span className="ml-1.5 font-normal normal-case tracking-normal tnum">{sessions.length}</span>
          </div>
          {shown.map((x) => {
            const live = x.chat != null || x.status !== "ended";
            return (
              <button
                key={sessionKey(x)}
                type="button"
                data-ns-session={sessionKey(x)}
                onClick={() => p.onContinue(x)}
                title={`${live ? "Open" : "Continue"} “${displayTitle(x)}” in coool (${NAME[x.provider]})`}
                className="group -mx-1.5 flex h-[30px] w-[calc(100%+12px)] items-center gap-2 rounded-[8px] px-1.5 text-left hover:bg-hover"
              >
                <ProviderMark provider={x.provider} size={12} />
                <span className="min-w-0 flex-1 truncate text-small text-fg/90">{displayTitle(x)}</span>
                {x.status !== "ended" && <StatusDot status={x.status} size={6} />}
                <span className="shrink-0 text-small text-faint group-hover:hidden">{ago(x.updated).replace(" ago", "")}</span>
                <span className="hidden shrink-0 text-small text-fg group-hover:inline">{live ? "Open" : "Continue"}</span>
              </button>
            );
          })}
          {sessions.length > shown.length && <div className="pt-0.5 text-small text-faint">and {sessions.length - shown.length} more</div>}
        </div>
      )}
    </>
  );
  return (
    <div className={cx("flex flex-col", compact ? "max-h-[min(38%,180px)] shrink-0 border-t border-hairline px-3 py-2 overflow-auto" : "px-4 py-3.5")} data-ns-details={ready ? (gated ? "gated" : "ready") : "loading"}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className={cx("truncate font-semibold tracking-[-0.01em] text-fg", compact ? "text-base" : "text-title")} data-ns-details-name>
            {baseName(target)}
          </div>
          {!compact && <div className="truncate font-mono text-mono-small text-faint" title={target}>{tilde(target, home)}</div>}
        </div>
        <button
          type="button"
          onClick={() => toggleFavourite(target)}
          title={fav ? "Remove from Favourites" : "Add to Favourites"}
          data-ns-fav={fav ? "on" : "off"}
          className={cx("flex size-7 shrink-0 items-center justify-center rounded-[8px] transition-colors hover:bg-hover", fav ? "text-fg" : "text-faint hover:text-fg")}
        >
          <IStar size={14} fill={fav ? "currentColor" : "none"} />
        </button>
      </div>
      <div className={compact ? "mt-1" : "mt-2.5"}>{body}</div>
    </div>
  );
}
