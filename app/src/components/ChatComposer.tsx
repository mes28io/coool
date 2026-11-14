// Composer for chat sessions: Enter sends, Shift+Enter newline, "/" opens the
// command menu (fuzzy, keyboard driven), up-arrow recalls earlier prompts,
// model and permission-mode chips open pickers, Stop interrupts the turn.
// /model, /clear, /context, /status, /cost and /usage are handled here,
// natively, and never sent to the CLI (CHAT_SPEC "Slash commands").

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { chatCall, newChat } from "../lib/actions";
import { api } from "../lib/backend";
import { type Chat, useChats } from "../lib/chat";
import { score } from "../lib/fuzzy";
import { fmtTokens } from "../lib/format";
import { contextWindow, modelColor, modelLabel, tokTotal } from "../lib/models";
import type { CommandKind } from "../lib/types";
import { IArrowUp, ICheck, IStop, ITerminal } from "./icons";
import { InfoPanel, type InfoTab } from "./InfoPanel";
import { Chip, cx, ease, Kbd, Popover } from "./primitives";

type Native = "model" | "clear" | "context" | "status" | "usage" | "mode";
/** Handled here and never sent (CHAT_SPEC "Slash commands"). `only`: for one provider. */
const NATIVE: Record<string, { native: Native; description: string; only?: "claude" | "codex" }> = {
  model: { native: "model", description: "Choose the model for this chat" },
  clear: { native: "clear", description: "Start a fresh chat in the same folder" },
  new: { native: "clear", description: "Start a fresh chat in the same folder", only: "codex" },
  context: { native: "context", description: "Context window usage" },
  status: { native: "status", description: "Session, model, mode and process status" },
  cost: { native: "usage", description: "Tokens used, by model and subagent" },
  usage: { native: "usage", description: "Tokens used, by model and subagent" },
  approvals: { native: "mode", description: "Choose what runs without asking", only: "codex" },
};
const nativeFor = (name: string, provider: string) => {
  const n = NATIVE[name];
  return n && (!n.only || n.only === provider) ? n : undefined;
};

/** Permission modes per provider. Names are the CLI's own, passed through untouched. */
export const PERMISSION_MODES: Record<string, { id: string; label: string; description: string }[]> = {
  claude: [
    { id: "default", label: "Ask", description: "Ask before edits and commands" },
    { id: "acceptEdits", label: "Accept edits", description: "Edit files freely, ask before commands" },
    { id: "plan", label: "Plan", description: "Read and plan only, change nothing" },
    { id: "bypassPermissions", label: "Bypass", description: "Never ask. Only in a sandbox you trust" },
  ],
  codex: [
    { id: "untrusted", label: "Untrusted", description: "Ask before anything not known to be safe" },
    { id: "on-request", label: "On request", description: "The model decides when to ask" },
    { id: "on-failure", label: "On failure", description: "Run in the sandbox, ask if it fails" },
    { id: "never", label: "Never ask", description: "Never ask for approval" },
  ],
};

/**
 * Codex also takes a sandbox mode through the same call (CHAT_SPEC; the core
 * tells the two apart by name). It applies from the next turn on.
 */
export const SANDBOX_MODES: Record<string, { id: string; label: string; description: string }[]> = {
  codex: [
    { id: "read-only", label: "Read only", description: "Commands can read, not write" },
    { id: "workspace-write", label: "Workspace write", description: "Write inside this folder only" },
    { id: "danger-full-access", label: "Full access", description: "No sandbox. Only if you trust it" },
  ],
};

type Group = "app" | CommandKind;
const GROUPS: { id: Group; label: string }[] = [
  { id: "app", label: "In coool" },
  { id: "command", label: "Commands" },
  { id: "skill", label: "Skills" },
  { id: "terminal", label: "Terminal only" },
];
const GROUP_RANK: Record<Group, number> = { app: 0, command: 1, skill: 2, terminal: 3 };

interface MenuItem {
  name: string;
  description: string;
  native?: Native;
  group: Group;
  hint: string;
  aliases: string[];
  /** Lowercased name + aliases, for matching. */
  keys: string[];
}

function rankItem(it: MenuItem, q: string): number {
  let best = 0;
  for (const k of it.keys) {
    const s = score(q, k);
    if (!s) continue;
    // Prefix and exact matches beat scattered subsequences; the real name beats an alias.
    const v = s * 2 + (k === q ? 40 : k.startsWith(q) ? 20 : 0) + (k === it.keys[0] ? 1 : 0);
    if (v > best) best = v;
  }
  if (best) return best;
  // Descriptions only match as a word start, so "co" doesn't pull in "/help … commands".
  return q.length >= 3 && new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(it.description) ? 0.5 : 0;
}

export function ChatComposer({ chat, compact, focused }: { chat: Chat; compact?: boolean; focused?: boolean }) {
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const [menuHidden, setMenuHidden] = useState(false);
  const [pop, setPop] = useState<null | "model" | "mode" | "info">(null);
  const [infoTab, setInfoTab] = useState<InfoTab>("context");
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const hist = useRef<{ i: number | null; draft: string }>({ i: null, draft: "" });
  const ta = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const working = chat.running && chat.state !== "idle";
  const disabled = !chat.running;

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(200, el.scrollHeight) + "px";
  }, [text]);
  useEffect(() => {
    if (focused && !disabled) ta.current?.focus({ preventScroll: true });
  }, [focused, disabled]);
  useEffect(() => {
    if (pendingModel && chat.model === pendingModel) setPendingModel(null);
  }, [chat.model, pendingModel]);

  // ---- slash menu ----
  const menuQuery = /^\/(\S*)$/.exec(text)?.[1] ?? null;
  const menuOpen = menuQuery !== null && !menuHidden && !disabled;
  // The CLI's own list (rich `commands` when the backend sends it), with the
  // commands coool answers natively taking over their names and aliases.
  const items = useMemo<MenuItem[]>(() => {
    const src = chat.commands.length
      ? chat.commands
      : chat.slashCommands.map((c) => ({ name: c.name, description: c.description, argument_hint: "", aliases: [] as string[], kind: "command" as CommandKind }));
    const by = new Map<string, MenuItem>();
    for (const c of src) {
      const n = nativeFor(c.name, chat.provider) ?? c.aliases.map((a) => nativeFor(a, chat.provider)).find(Boolean);
      const aliases = c.aliases.filter((a) => !a.includes(":") || c.kind === "skill");
      by.set(c.name, {
        name: c.name,
        description: n ? n.description : c.description,
        native: n?.native,
        group: n ? "app" : c.kind,
        hint: n ? "" : c.argument_hint,
        aliases,
        keys: [c.name.toLowerCase(), ...aliases.map((a) => a.toLowerCase())],
      });
    }
    // Native ones always exist, even before `ready` lists them (unless an alias already covers them).
    const covered = new Set([...by.values()].flatMap((i) => i.keys));
    for (const [name, n] of Object.entries(NATIVE)) {
      if (!nativeFor(name, chat.provider) || covered.has(name)) continue;
      by.set(name, { name, description: n.description, native: n.native, group: "app", hint: "", aliases: [], keys: [name] });
    }
    return [...by.values()].sort((a, b) => GROUP_RANK[a.group] - GROUP_RANK[b.group] || a.name.localeCompare(b.name));
  }, [chat.commands, chat.slashCommands, chat.provider]);
  const matches = useMemo(() => {
    if (menuQuery === null) return [];
    if (!menuQuery) return items;
    const q = menuQuery.toLowerCase();
    const out: { it: MenuItem; s: number }[] = [];
    for (const it of items) {
      const s = rankItem(it, q);
      if (s > 0) out.push({ it, s });
    }
    return out.sort((a, b) => b.s - a.s || GROUP_RANK[a.it.group] - GROUP_RANK[b.it.group] || a.it.name.localeCompare(b.it.name)).map((x) => x.it);
  }, [items, menuQuery]);
  // Typed name -> native action (aliases included: /reset, /cost…).
  const nativeByKey = useMemo(() => {
    const m = new Map<string, Native>();
    for (const it of items) if (it.native) for (const k of it.keys) m.set(k, it.native);
    return m;
  }, [items]);
  useEffect(() => setSel(0), [menuQuery]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const openPop = (v: null | "model" | "mode" | "info") => {
    setMenuHidden(true);
    setPop(v);
  };
  const runNative = (n: Native) => {
    setText("");
    if (n === "model") setPop("model");
    else if (n === "mode") setPop("mode");
    else if (n === "clear") void newChat({ provider: chat.provider, cwd: chat.cwd, model: chat.model });
    else {
      setInfoTab(n === "usage" ? "usage" : n);
      setPop("info");
    }
  };

  const send = (raw?: string) => {
    const t = (raw ?? text).trim();
    if (!t || disabled) return;
    const m = /^\/(\S+)\s*$/.exec(t);
    const native = m ? nativeByKey.get(m[1].toLowerCase()) : undefined;
    if (native) return runNative(native);
    hist.current = { i: null, draft: "" };
    setText("");
    void chatCall(chat.id, () => api().chatSend(chat.id, t));
  };

  const pick = (it: MenuItem, run: boolean) => {
    if (it.native) return runNative(it.native);
    // Commands that need arguments get completed, not run.
    if (run && !/^</.test(it.hint)) send(`/${it.name}`);
    else setText(`/${it.name} `);
  };

  const interrupt = () => void chatCall(chat.id, () => api().chatInterrupt(chat.id));

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    if (menuOpen && matches.length) {
      if (e.key === "ArrowDown") return e.preventDefault(), setSel((v) => (v + 1) % matches.length);
      if (e.key === "ArrowUp") return e.preventDefault(), setSel((v) => (v - 1 + matches.length) % matches.length);
      if (e.key === "Tab") return e.preventDefault(), pick(matches[sel], false);
      if (e.key === "Enter" && !e.shiftKey) return e.preventDefault(), pick(matches[sel], true);
      if (e.key === "Escape") return e.preventDefault(), e.stopPropagation(), setMenuHidden(true);
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      return send();
    }
    if (e.key === "Escape" && working && !text) {
      e.preventDefault();
      return interrupt();
    }
    // Prompt history: up at the first line, down at the last.
    const prompts = chat.prompts;
    if (e.key === "ArrowUp" && prompts.length && !el.value.slice(0, el.selectionStart).includes("\n")) {
      const h = hist.current;
      const i = h.i === null ? prompts.length - 1 : Math.max(0, h.i - 1);
      if (h.i === null) h.draft = text;
      if (h.i === 0) return;
      e.preventDefault();
      h.i = i;
      setText(prompts[i]);
      setMenuHidden(true);
      requestAnimationFrame(() => ta.current?.setSelectionRange(0, 0));
    } else if (e.key === "ArrowDown" && hist.current.i !== null && !el.value.slice(el.selectionEnd).includes("\n")) {
      e.preventDefault();
      const h = hist.current;
      const i = h.i! + 1;
      if (i >= prompts.length) {
        h.i = null;
        setText(h.draft);
      } else {
        h.i = i;
        setText(prompts[i]);
      }
      setMenuHidden(true);
    }
  };

  const can = !!text.trim() && !disabled;
  const model = pendingModel ?? chat.model;
  const modes = PERMISSION_MODES[chat.provider] ?? [];
  const mode = modes.find((m) => m.id === chat.permissionMode);
  const seenMode = useRef<string | null>(null);
  useEffect(() => {
    if (seenMode.current === null) seenMode.current = chat.permissionMode;
  }, [chat.permissionMode]);
  const placeholder = disabled
    ? "This chat has ended"
    : chat.pendingPermission || chat.pendingQuestion
      ? "Answer the request above, or queue a follow-up…"
      : working
        ? "Queue a follow-up…  (Esc to stop)" : `Message ${chat.provider === "claude" ? "Claude" : "Codex"}…  (/ for commands)`;

  return (
    <div className={cx("shrink-0 pb-3 pt-1", compact ? "px-3" : "px-6")}>
      <div className="relative mx-auto max-w-[700px]">
        {/* slash menu */}
        <AnimatePresence>
          {menuOpen && (
            <motion.div
              key="menu"
              initial={{ opacity: 0, y: 6, scale: 0.99 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, transition: { duration: 0.12 } }}
              transition={{ type: "spring", stiffness: 620, damping: 42 }}
              style={{ transformOrigin: "bottom left" }}
              className="absolute inset-x-0 bottom-full z-30 mb-1.5 overflow-hidden rounded-[12px] border border-line bg-raised shadow-pop"
            >
              <div className="flex items-center justify-between border-b border-hairline px-3 py-1.5 text-small text-faint">
                <span className="font-mono text-micro font-semibold uppercase tracking-[0.06em]">Commands</span>
                <span className="flex items-center gap-1">
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd> move <Kbd>↵</Kbd> run <Kbd>tab</Kbd> complete
                </span>
              </div>
              <div ref={list} className="scroll max-h-[min(340px,44vh)] p-1" data-slash-count={matches.length}>
                {matches.length === 0 && <div className="px-3 py-3 text-base text-dim">No command matches “/{menuQuery}”. Enter sends it as typed.</div>}
                {matches.map((it, i) => {
                  const head = !menuQuery && (i === 0 || matches[i - 1].group !== it.group) ? GROUPS.find((g) => g.id === it.group) : undefined;
                  const alias = menuQuery ? it.aliases.find((a) => a.toLowerCase().startsWith(menuQuery.toLowerCase()) && !it.name.startsWith(menuQuery.toLowerCase())) : undefined;
                  return (
                    <div key={it.name}>
                      {head && (
                        <div className="flex items-center gap-2 px-2.5 pb-1 pt-2 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint first:pt-1">
                          {head.label}
                          <span className=" font-normal normal-case tracking-normal tnum">{items.filter((x) => x.group === it.group).length}</span>
                        </div>
                      )}
                      <button
                        type="button"
                        data-i={i}
                        data-cmd={it.name}
                        data-group={it.group}
                        onMouseMove={() => sel !== i && setSel(i)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pick(it, true)}
                        className="relative flex h-[38px] w-full items-center gap-3 rounded-[8px] px-2.5 text-left"
                      >
                        {i === sel && <motion.span layoutId={`slash-sel-${chat.id}`} transition={{ type: "spring", stiffness: 700, damping: 45 }} className="absolute inset-0 rounded-[8px] bg-hover" />}
                        <span className={cx("relative w-[176px] shrink-0 truncate font-mono text-mono-base", it.group === "terminal" ? "text-dim" : "text-fg")} title={`/${it.name}`}>
                          <span className="text-faint">/</span>
                          <Hi text={it.name} q={menuQuery ?? ""} />
                          {alias && <span className="text-faint"> · {alias}</span>}
                        </span>
                        <span className="relative min-w-0 flex-1 truncate text-base text-dim">
                          {it.hint && <span className="mr-1.5 font-mono text-mono-small text-faint">{it.hint}</span>}
                          {it.description}
                        </span>
                        <KindTag group={it.group} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div
          className={cx(
            "rounded-[12px] border bg-raised shadow-card transition-[border-color,box-shadow] duration-200",
            "border-line focus-within:border-[color-mix(in_oklab,var(--accent)_45%,var(--border))] focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_12%,transparent)]",
            disabled && "opacity-60",
          )}
        >
          <textarea
            ref={ta}
            rows={1}
            value={text}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(e) => {
              setText(e.target.value);
              setMenuHidden(false);
              if (hist.current.i !== null && e.target.value !== chat.prompts[hist.current.i]) hist.current.i = null;
            }}
            onKeyDown={onKey}
            className="selectable block max-h-[200px] min-h-[52px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-prose outline-none placeholder:text-faint"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            {/* model */}
            <div className="relative">
              <Chip active={pop === "model"} onClick={() => openPop(pop === "model" ? null : "model")} title="Model (/model)">
                <span className="size-[6px] rounded-full" style={{ background: modelColor(model) }} />
                {model ? modelLabel(model) : "Model"}
                {pendingModel && <span className="spin size-[9px] rounded-full border border-current border-t-transparent" />}
                <Caret />
              </Chip>
              <Popover open={pop === "model"} onClose={() => setPop(null)} side="top" width={300}>
                <ModelPicker
                  chat={chat}
                  current={model}
                  onPick={(m) => {
                    setPop(null);
                    if (m === chat.model) return;
                    setPendingModel(m);
                    void chatCall(chat.id, () => api().chatSetModel(chat.id, m)).then((ok) => !ok && setPendingModel(null));
                  }}
                />
              </Popover>
            </div>
            {/* permission mode */}
            {modes.length > 0 && (
              <div className="relative">
                <Chip active={pop === "mode"} onClick={() => openPop(pop === "mode" ? null : "mode")} title="Permission mode">
                  <ModeGlyph id={chat.permissionMode} />
                  {/* A mode switched from elsewhere (an approval's "Allow all edits") flashes in, so it's noticed. */}
                  <motion.span
                    key={chat.permissionMode ?? ""}
                    data-mode-chip={chat.permissionMode ?? ""}
                    className={seenMode.current !== null && seenMode.current !== chat.permissionMode ? "mode-flash" : undefined}
                    initial={seenMode.current === null || seenMode.current === chat.permissionMode ? false : { opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.35, ease }}
                    onAnimationComplete={() => (seenMode.current = chat.permissionMode)}
                  >
                    {mode?.label ?? chat.permissionMode ?? "Mode"}
                  </motion.span>
                  <Caret />
                </Chip>
                <Popover open={pop === "mode"} onClose={() => setPop(null)} side="top" width={300}>
                  <div className="p-1">
                    <div className="px-2.5 pb-1 pt-1.5 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">Permission mode</div>
                    {modes.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          setPop(null);
                          void chatCall(chat.id, () => api().chatSetPermissionMode(chat.id, m.id));
                        }}
                        className="flex w-full items-start gap-2.5 rounded-[8px] px-2.5 py-1.5 text-left hover:bg-hover"
                      >
                        <span className="mt-[3px]">
                          <ModeGlyph id={m.id} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-base font-medium text-fg">{m.label}</span>
                          <span className="block text-small text-dim">{m.description}</span>
                        </span>
                        {m.id === chat.permissionMode && <ICheck size={15} className="mt-[3px] text-accent-text" />}
                      </button>
                    ))}
                    {(SANDBOX_MODES[chat.provider] ?? []).length > 0 && (
                      <>
                        <div className="mx-2.5 mt-1 border-t border-hairline px-0 pb-1 pt-2 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">Sandbox · from the next turn</div>
                        {SANDBOX_MODES[chat.provider].map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => {
                              setPop(null);
                              void chatCall(chat.id, () => api().chatSetPermissionMode(chat.id, m.id)).then(
                                (ok) => ok && useChats.getState().local(chat.id, { level: "info", text: `Sandbox: ${m.label.toLowerCase()} from the next turn on.` }),
                              );
                            }}
                            className="flex w-full items-start gap-2.5 rounded-[8px] px-2.5 py-1.5 text-left hover:bg-hover"
                          >
                            <span className="mt-[3px]">
                              <ModeGlyph id={m.id === "danger-full-access" ? "never" : m.id === "read-only" ? "plan" : "on-failure"} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-base font-medium text-fg">{m.label}</span>
                              <span className="block text-small text-dim">{m.description}</span>
                            </span>
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                </Popover>
              </div>
            )}
            {/* info panel (context / status / usage) */}
            <div className="relative">
              <Chip active={pop === "info"} onClick={() => openPop(pop === "info" ? null : "info")} title="Context, status and usage (/context, /status, /usage)">
                <ContextRing chat={chat} />
                <span className="tnumtext-small">{fmtTokens(chat.context)}</span>
              </Chip>
              <Popover open={pop === "info"} onClose={() => setPop(null)} side="top" width={400}>
                <InfoPanel chat={chat} tab={infoTab} onTab={setInfoTab} />
              </Popover>
            </div>
            <span className="flex-1" />
            {!compact && !working && (
              <span className="hidden items-center gap-1 text-small text-faint md:flex">
                <Kbd>⇧</Kbd>
                <Kbd>↵</Kbd> newline
              </span>
            )}
            <AnimatePresence initial={false} mode="popLayout">
              {working && (
                <motion.button
                  key="stop"
                  type="button"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ duration: 0.16, ease }}
                  onClick={interrupt}
                  title="Stop this turn (Esc)"
                  className="flex h-[34px] items-center gap-1.5 rounded-[8px] bg-[color-mix(in_oklab,var(--text)_8%,transparent)] px-2.5 text-small font-medium text-fg transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--error)_14%,transparent)] hover:text-err-text"
                >
                  <IStop size={14} />
                  Stop
                </motion.button>
              )}
              {(!working || can) && (
                <motion.button
                  key="send"
                  type="button"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ duration: 0.16, ease }}
                  onClick={() => send()}
                  disabled={!can}
                  whileTap={can ? { scale: 0.92 } : undefined}
                  className={cx(
                    "flex size-[32px] items-center justify-center rounded-[8px] transition-[background-color,color] duration-150",
                    can ? "bg-fg text-bg" : "bg-[color-mix(in_oklab,var(--dim)_14%,transparent)] text-faint",
                  )}
                  title={working ? "Queue for after this turn" : "Send (Enter)"}
                >
                  <IArrowUp size={17} strokeWidth={1.9} />
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}

function KindTag({ group }: { group: Group }) {
  if (group === "app") return <span className="relative shrink-0 rounded-[4px] bg-[color-mix(in_oklab,var(--dim)_14%,transparent)] px-1.5 text-small font-semibold text-dim" title="Handled by coool, never sent">in app</span>;
  if (group === "skill")
    return (
      <span className="relative shrink-0 rounded-[4px] bg-[color-mix(in_oklab,var(--accent-2)_14%,transparent)] px-1.5 text-small font-semibold text-dim" title="A skill: sent to the model">
        skill
      </span>
    );
  if (group === "terminal")
    return (
      <span className="relative flex shrink-0 items-center gap-1 rounded-[4px] bg-[color-mix(in_oklab,var(--dim)_12%,transparent)] px-1.5 text-small font-semibold text-dim" title="Only works in the CLI's terminal UI">
        <ITerminal size={12} />
        terminal
      </span>
    );
  return null;
}

function Caret() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" className="opacity-60" aria-hidden>
      <path d="M1.5 3l2.5 2.5L6.5 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Hi({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className="text-accent-text">{text.slice(i, i + q.length)}</span>
      {text.slice(i + q.length)}
    </>
  );
}

function ModeGlyph({ id }: { id: string | null }) {
  const c = id === "bypassPermissions" || id === "never" ? "var(--error)" : id === "plan" ? "var(--dim)" : id === "acceptEdits" || id === "on-failure" ? "var(--busy)" : "var(--dim)";
  return <span className="inline-block size-[7px] rounded-[2px]" style={{ background: c }} />;
}

function ContextRing({ chat }: { chat: Chat }) {
  const w = contextWindow(chat.model, chat.contextWindow);
  const pct = Math.min(1, chat.context / w.tokens);
  const r = 5;
  const c = 2 * Math.PI * r;
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden className="-rotate-90">
      <circle cx="7" cy="7" r={r} fill="none" stroke="color-mix(in oklab, var(--dim) 30%, transparent)" strokeWidth="2" />
      <motion.circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke={w.source !== "assumed" && pct >= 1 ? "var(--error)" : w.source !== "assumed" && pct >= 0.75 ? "var(--busy)" : "var(--dim)"}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={c}
        initial={false}
        animate={{ strokeDashoffset: c * (1 - Math.max(0.03, pct)) }}
        transition={{ duration: 0.6, ease }}
      />
    </svg>
  );
}

function ModelPicker({ chat, current, onPick }: { chat: Chat; current: string | null; onPick: (m: string) => void }) {
  const [custom, setCustom] = useState("");
  const options = chat.modelOptions.length ? chat.modelOptions : current ? [{ id: current, label: modelLabel(current) }] : [];
  const used = chat.models;
  const total = Object.values(used).reduce((n, u) => n + tokTotal(u), 0);
  return (
    <div className="p-1">
      <div className="px-2.5 pb-1 pt-1.5 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">Model</div>
      {options.map((o) => {
        const u = used[o.id];
        return (
          <button key={o.id} type="button" data-model-option={o.id} onClick={() => onPick(o.id)} className="flex h-[40px] w-full items-center gap-2.5 rounded-[8px] px-2.5 text-left hover:bg-hover">
            <span className="size-[7px] shrink-0 rounded-full" style={{ background: modelColor(o.id) }} />
            <span className="text-base font-medium text-fg">{o.label}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-mono-small text-faint">{o.id !== o.label ? o.id : ""}</span>
            {u && total > 0 && <span className="shrink-0 text-small text-dim tnum">{Math.round((tokTotal(u) / total) * 100)}% used</span>}
            {o.id === current && <ICheck size={15} className="shrink-0 text-accent-text" />}
          </button>
        );
      })}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (custom.trim()) onPick(custom.trim());
        }}
        className="mt-1 border-t border-hairline px-1.5 pb-0.5 pt-1.5"
      >
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Other model id…"
          spellCheck={false}
          className="h-[34px] w-full rounded-[7px] border border-line bg-bg px-2 font-mono text-mono-small outline-none placeholder:font-sans placeholder:text-faint focus:border-[color-mix(in_oklab,var(--accent)_50%,var(--border))]"
        />
      </form>
    </div>
  );
}
