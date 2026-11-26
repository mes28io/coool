// The Context panel (APP_SPEC "Context panel"): what this chat's agent starts with: its folder, its model, its
// instructions and memory in the order the CLI loads them, its skills, and what coool adds at launch, each with
// where it comes from and its size. Any file opens in a preview (rendered or source); instructions, memory and skills
// can be edited, created and moved to the Trash. The lookup and the allow-list live in crates/core/src/chatctx: this
// only shows and asks. While the panel is open it asks again every few seconds, so a file the agent edits shows.

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/backend";
import { copyText, onContext, type MenuEntry } from "../lib/contextMenu";
import { contextItemMenu } from "../lib/menus/panels";
import {
  fileNameFor,
  grouped,
  lineCount,
  loadWord,
  onDiskChange,
  splitFrontmatter,
  validSkillName,
  whenItApplies,
  type CtxCreate,
  type CtxFile,
  type CtxGroup,
  type CtxItem,
  type CtxOverview,
  type CtxTarget,
} from "../lib/chatContext";
import { ctxDemoStart } from "../lib/mockChatContext";
import { fmtTokens, folderName, homeShort } from "../lib/format";
import { modelLabel } from "../lib/models";
import type { Provider } from "../lib/types";
import { useStore } from "../store";
import { IBack, IBranch, ICheck, IExternal, IFolder, IPencil, IPlus, ITrash } from "./icons";
import { Markdown } from "./Markdown";
import { Button, cx, IconButton, Segmented } from "./primitives";
import { reducedMotion } from "./StepRail";

const POLL_MS = 3000;
/** The editor's text and its gutter: the same font and line height, so the numbers line up. */
const MONO = { fontFamily: "var(--font-mono)", fontSize: "var(--text-mono-small)", lineHeight: "var(--text-mono-small--line-height)" } as const;

type View =
  | { kind: "list" }
  /** `trash`: opens with the move-to-Trash question already asked. */
  | { kind: "item"; item: CtxItem; trash?: boolean }
  | { kind: "edit"; path: string; label: string; group: CtxGroup }
  | { kind: "create-skill" }
  | { kind: "create-memory" };

/** The tint of a group's rows (the context map's own: memory and skills violet, coool's setup neutral, tools orange). */
const TINT: Record<CtxGroup, string> = {
  instructions: "var(--ctx-memory)",
  memory: "var(--ctx-memory)",
  skills: "var(--ctx-memory)",
  coool: "var(--ctx-base)",
  mcp: "var(--ctx-tool)",
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ContextPanelBody({
  target,
  active,
  model,
  onChangeModel,
}: {
  target: CtxTarget;
  /** The panel is the one showing (polling stops otherwise). */
  active: boolean;
  /** The model the chat runs with now. */
  model: string | null;
  /** Opens the composer's model picker (switching stays there). */
  onChangeModel?: () => void;
}) {
  const [ov, setOv] = useState<CtxOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });
  const load = useCallback(async () => {
    try {
      const o = await api().chatContext(target);
      setOv(o);
      setError(null);
      return o;
    } catch (e) {
      setError(errText(e));
      return null;
    }
  }, [target]);

  // First load, then every few seconds while showing and the window is visible.
  useEffect(() => {
    if (!active) return;
    let live = true;
    void load();
    const t = setInterval(() => {
      if (live && document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [active, load]);

  // The browser demo opens on a file, the editor or a form (mockChatContext.ts).
  const demoDone = useRef(false);
  useEffect(() => {
    if (demoDone.current || !ov || api().kind !== "mock") return;
    demoDone.current = true;
    const d = ctxDemoStart();
    if (!d) return;
    const it = d.path ? ov.items.find((i) => i.path === d.path) : undefined;
    if (d.view === "create-skill") setView({ kind: "create-skill" });
    else if (it && d.view === "edit") setView({ kind: "edit", path: it.path!, label: it.label, group: it.group });
    else if (it) setView({ kind: "item", item: it });
  }, [ov]);

  // A view's item, kept current with the latest overview (its size, "used").
  const shownItem = view.kind === "item" ? (ov?.items.find((i) => i.id === view.item.id) ?? view.item) : null;
  const back = () => setView({ kind: "list" });
  const toast = (t: string) => useStore.getState().toast(t);
  const provider: Provider = ov?.provider ?? target.provider;

  const created = async (c: CtxCreate, label: string, group: CtxGroup) => {
    try {
      const p = await api().chatContextCreate(target, c);
      await load();
      setView({ kind: "edit", path: p, label, group });
    } catch (e) {
      toast(`Couldn't create it: ${errText(e)}`);
    }
  };

  const title =
    view.kind === "list" ? "Context" : view.kind === "item" ? (shownItem?.label ?? "") : view.kind === "edit" ? `Edit ${view.path.split("/").pop()}` : view.kind === "create-skill" ? "New skill" : "New memory";

  return (
    <div className="flex h-full flex-col" data-context-panel={view.kind}>
      <div className="flex h-[44px] shrink-0 items-center gap-1 pl-4 pr-2">
        {view.kind !== "list" && (
          <IconButton title="Back to the chat's context" onClick={back} className="-ml-2">
            <IBack size={15} />
          </IconButton>
        )}
        <span className="min-w-0 flex-1 truncate text-base font-semibold text-fg" data-context-title>
          {title}
        </span>
        {view.kind === "list" && ov && (
          <span className="shrink-0 pr-2 text-small text-dim tnum" title="What these add to the chat's first request (estimated from their length, as the Models panel's context map does)" data-context-total>
            ~{fmtTokens(ov.total)} tokens at start
          </span>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={view.kind === "item" ? `item:${view.item.id}` : view.kind === "edit" ? `edit:${view.path}` : view.kind}
            className="absolute inset-0 flex flex-col"
            initial={{ opacity: 0, x: view.kind === "list" ? -8 : 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion() ? 0 : 0.16 }}
          >
            {view.kind === "list" ? (
              <Overview
                ov={ov}
                error={error}
                model={model}
                provider={provider}
                onChangeModel={onChangeModel}
                onOpen={(it) => setView({ kind: "item", item: it })}
                onMenu={(it) =>
                  contextItemMenu(it.path ?? null, {
                    copyText,
                    open: () => setView({ kind: "item", item: it }),
                    edit: it.editable && it.path ? () => setView({ kind: "edit", path: it.path!, label: it.label, group: it.group }) : undefined,
                    reveal: () => it.path && void api().chatContextReveal(target, it.path).catch((e) => toast(errText(e))),
                    trash: canTrash(it) ? () => setView({ kind: "item", item: it, trash: true }) : undefined,
                  })
                }
                onReveal={(p) => void api().chatContextReveal(target, p).catch((e) => toast(errText(e)))}
                onCreateSkill={() => setView({ kind: "create-skill" })}
                onCreateMemory={() => setView({ kind: "create-memory" })}
                onCreateInstructions={(p) => void created({ what: "instructions", path: p }, p.split("/").pop()!, "instructions")}
              />
            ) : view.kind === "item" && shownItem ? (
              <ItemView
                item={shownItem}
                trash={view.kind === "item" && !!view.trash}
                target={target}
                provider={provider}
                active={active}
                onEdit={() => shownItem.path && setView({ kind: "edit", path: shownItem.path, label: shownItem.label, group: shownItem.group })}
                onDeleted={async () => {
                  await load();
                  back();
                }}
              />
            ) : view.kind === "edit" ? (
              <Editor
                target={target}
                path={view.path}
                group={view.group}
                provider={provider}
                active={active}
                onDone={async (saved) => {
                  const o = await load();
                  const it = o?.items.find((i) => i.path === view.path);
                  if (saved) toast("Saved");
                  setView(it ? { kind: "item", item: it } : { kind: "list" });
                }}
              />
            ) : view.kind === "create-skill" ? (
              <CreateSkill
                provider={provider}
                ov={ov}
                onCancel={back}
                onCreate={(scope, name, description) => void created({ what: "skill", scope, name, description }, name, "skills")}
              />
            ) : (
              <CreateMemory ov={ov} onCancel={back} onCreate={(title, description, kind) => void created({ what: "memory", title, description, kind }, fileNameFor(title), "memory")} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---------- the list ----------

function Card({ children, className, ...data }: { children: ReactNode; className?: string; [d: `data-${string}`]: string | undefined }) {
  return (
    <div {...data} className={cx("rounded-[14px] border border-hairline bg-bg shadow-card", className)}>
      {children}
    </div>
  );
}

function Overview({
  ov,
  error,
  model,
  provider,
  onChangeModel,
  onOpen,
  onMenu,
  onReveal,
  onCreateSkill,
  onCreateMemory,
  onCreateInstructions,
}: {
  ov: CtxOverview | null;
  error: string | null;
  model: string | null;
  provider: Provider;
  onChangeModel?: () => void;
  onOpen: (i: CtxItem) => void;
  onMenu: (i: CtxItem) => MenuEntry[];
  onReveal: (p: string) => void;
  onCreateSkill: () => void;
  onCreateMemory: () => void;
  onCreateInstructions: (path: string) => void;
}) {
  const groups = useMemo(() => grouped(ov?.items ?? []), [ov]);
  if (!ov)
    return (
      <div className="px-4 py-6 text-base text-dim" data-context-loading>
        {error ? `Couldn't read this chat's context: ${error}` : "Reading this chat's context…"}
      </div>
    );
  const f = ov.folder;
  const started = ov.started_model && model && ov.started_model !== model ? ov.started_model : null;
  const cli = provider === "codex" ? "Codex" : "Claude Code";
  return (
    <div className="scroll flex min-h-0 flex-1 flex-col gap-2 pb-3 pl-3 pr-[2px]" data-context-list>
      {/* Folder */}
      <Card className="px-3.5 py-3" data-context-folder={f.path}>
        <div className="flex items-start gap-2.5">
          <IFolder size={16} className="mt-[2px] shrink-0 text-dim" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold text-fg" title={f.path}>
              {folderName(f.path)}
            </div>
            <div className="selectable truncate text-small text-dim" title={f.path}>
              {homeShort(f.path)}
            </div>
            {(f.branch || f.worktree_of || (f.repo_root && f.repo_root !== f.path)) && (
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-small text-dim">
                {f.branch && (
                  <span className="inline-flex min-w-0 items-center gap-1" data-context-branch>
                    <IBranch size={12} className="shrink-0" />
                    <span className="truncate">{f.branch}</span>
                  </span>
                )}
                {f.worktree_of ? (
                  <span className="truncate" title={f.worktree_of} data-context-worktree>
                    worktree of {homeShort(f.worktree_of)}
                  </span>
                ) : (
                  f.repo_root &&
                  f.repo_root !== f.path && (
                    <span className="truncate" title={f.repo_root}>
                      in {homeShort(f.repo_root)}
                    </span>
                  )
                )}
              </div>
            )}
          </div>
          <IconButton title="Reveal in Finder" onClick={() => onReveal(f.path)} className="-mr-1 -mt-0.5">
            <IExternal size={14} />
          </IconButton>
        </div>
      </Card>

      {/* Model */}
      <Card className="flex items-center gap-3 px-3.5 py-2.5" data-context-model={model ?? ""}>
        <div className="min-w-0 flex-1">
          <div className="text-base text-fg">
            <span className="font-semibold">{model ? modelLabel(model) : ov.launch_model ? modelLabel(ov.launch_model) : `${cli}'s default model`}</span>
            {ov.effort && <span className="text-dim"> · {ov.effort} effort</span>}
          </div>
          <div className="truncate text-small text-dim">{started ? `Started with ${modelLabel(started)}` : "Since the chat started"}</div>
        </div>
        {onChangeModel && (
          <Button variant="ghost" className="h-[28px] px-2 text-small" onClick={onChangeModel} title="Switch the model in the composer below">
            Change…
          </Button>
        )}
      </Card>

      <SizeBar groups={groups} total={ov.total} />

      {groups.length === 0 && <div className="px-1 py-2 text-base text-dim">No instructions, memory or skills apply to this chat.</div>}
      {groups.map((g) => (
        <Card key={g.group} className="py-1.5" data-context-group={g.group}>
          <div className="flex h-[30px] items-center gap-2 pl-3.5 pr-2">
            <span className="flex-1 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">{g.title}</span>
            {g.tokens > 0 && <span className="text-small text-faint tnum">~{fmtTokens(g.tokens)}</span>}
            {g.group === "skills" && ov.create.project_skills && (
              <IconButton title="New skill" onClick={onCreateSkill} className="size-6">
                <IPlus size={13} />
              </IconButton>
            )}
            {g.group === "memory" && ov.create.memory_dir && (
              <IconButton title="New memory file" onClick={onCreateMemory} className="size-6">
                <IPlus size={13} />
              </IconButton>
            )}
          </div>
          {g.items.map((it) => (
            <Row key={it.id} item={it} onOpen={() => onOpen(it)} onMenu={() => onMenu(it)} />
          ))}
        </Card>
      ))}
      {/* What can be created where nothing exists yet. */}
      {(ov.create.project_instructions || (!groups.some((g) => g.group === "skills") && ov.create.project_skills) || (!groups.some((g) => g.group === "memory") && ov.create.memory_dir)) && (
        <div className="flex flex-wrap gap-1.5 px-1 pt-0.5">
          {ov.create.project_instructions && (
            <Button variant="outline" className="h-[30px] px-2.5 text-small" onClick={() => onCreateInstructions(ov.create.project_instructions!)} title={`Create ${homeShort(ov.create.project_instructions)}`} data-context-create-instructions="">
              <IPlus size={12} /> {ov.create.project_instructions.split("/").pop()}
            </Button>
          )}
          {!groups.some((g) => g.group === "skills") && ov.create.project_skills && (
            <Button variant="outline" className="h-[30px] px-2.5 text-small" onClick={onCreateSkill}>
              <IPlus size={12} /> Skill
            </Button>
          )}
          {!groups.some((g) => g.group === "memory") && ov.create.memory_dir && (
            <Button variant="outline" className="h-[30px] px-2.5 text-small" onClick={onCreateMemory}>
              <IPlus size={12} /> Memory file
            </Button>
          )}
        </div>
      )}
      {ov.notes.map((n) => (
        <p key={n} className="px-1.5 pt-1 text-small leading-[18px] text-dim">
          {n}
        </p>
      ))}
    </div>
  );
}

/** One bar for what loads at start, split by group (the context map's tints). */
function SizeBar({ groups, total }: { groups: { group: CtxGroup; title: string; tokens: number }[]; total: number }) {
  const parts = groups.filter((g) => g.tokens > 0);
  if (!total || !parts.length) return null;
  return (
    <div className="px-1 pt-0.5" data-context-size>
      <div className="flex h-[6px] overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--dim)_12%,transparent)]">
        {parts.map((g, i) => (
          <div
            key={g.group}
            title={`${g.title}: ~${fmtTokens(g.tokens)} tokens`}
            style={{ width: `${(g.tokens / total) * 100}%`, background: `color-mix(in oklab, ${TINT[g.group]} ${g.group === "coool" ? 70 : 60 - i * 12}%, transparent)` }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-small text-dim">
        {parts.map((g) => (
          <span key={g.group} className="tnum">
            {g.title.replace("What coool adds", "coool")} ~{fmtTokens(g.tokens)}
          </span>
        ))}
      </div>
    </div>
  );
}

function Row({ item: it, onOpen, onMenu }: { item: CtxItem; onOpen: () => void; onMenu: () => MenuEntry[] }) {
  const size = it.tokens || it.full_tokens;
  const label = it.path && it.group === "instructions" ? homeShort(it.path) : it.label;
  return (
    <button
      type="button"
      onClick={onOpen}
      onContextMenu={onContext(onMenu)}
      title={[it.path ? homeShort(it.path) : it.label, it.description, it.note].filter(Boolean).join("\n")}
      data-context-item={it.path ?? it.id}
      data-context-used={it.used ? "" : undefined}
      className="group flex w-full items-start gap-2.5 py-1.5 pr-3 text-left transition-colors duration-150 hover:bg-hover"
      style={{ paddingLeft: 14 + Math.min(it.depth, 3) * 12 }}
    >
      <span className="mt-[7px] size-[6px] shrink-0 rounded-full" style={{ background: `color-mix(in oklab, ${TINT[it.group]} ${it.load === "start" || it.used ? 85 : 35}%, transparent)` }} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cx("truncate text-base", it.group === "instructions" ? "font-mono text-mono-small text-fg" : "text-fg")}>{label}</span>
          {it.used && (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded-[4px] bg-[color-mix(in_oklab,var(--ctx-memory)_16%,transparent)] px-1 font-mono text-micro font-semibold uppercase tracking-wide text-fg" title="The chat loaded this skill during this session">
              <ICheck size={10} /> used
            </span>
          )}
          {it.editable && <IPencil size={11} className="shrink-0 text-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100" />}
        </span>
        {it.description && it.group !== "instructions" && <span className="line-clamp-2 text-small text-dim">{it.description}</span>}
        <span className="block truncate text-small text-faint">
          {it.source}
          {size > 0 && <span className="tnum"> · ~{fmtTokens(size)}</span>} · {loadWord(it)}
        </span>
      </span>
    </button>
  );
}

// ---------- one item ----------

function Meta({ item: it, provider }: { item: CtxItem; provider: Provider }) {
  return (
    <div className="space-y-0.5 text-small text-dim">
      {it.path && (
        <div className="selectable break-all font-mono text-mono-small text-dim" data-context-path>
          {homeShort(it.path)}
        </div>
      )}
      <div>
        {it.source}
        {it.full_tokens > 0 && (
          <span className="tnum">
            {" "}
            · ~{fmtTokens(it.full_tokens)} tokens{it.tokens > 0 && it.tokens !== it.full_tokens ? ` (~${fmtTokens(it.tokens)} at start)` : ""}
          </span>
        )}{" "}
        · {loadWord(it)}
      </div>
      {it.note && <div>{it.note}</div>}
      {it.editable && <div>{whenItApplies(provider, it.group)}</div>}
    </div>
  );
}

/** Items coool can move to the Trash: memory files, skills and instruction files (not the memory index). */
const canTrash = (it: CtxItem) => !!it.path && it.editable && (it.kind === "memory" || it.kind === "skill" || it.group === "instructions") && it.kind !== "memory_index";

function ItemView({ item: it, trash, target, provider, active, onEdit, onDeleted }: { item: CtxItem; trash: boolean; target: CtxTarget; provider: Provider; active: boolean; onEdit: () => void; onDeleted: () => void }) {
  const [file, setFile] = useState<CtxFile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"rendered" | "source">("rendered");
  const [confirm, setConfirm] = useState(trash);
  const [busy, setBusy] = useState(false);
  const path = it.path;
  // The file, then again every few seconds (the agent may be editing it).
  useEffect(() => {
    if (!path || !active) return;
    let live = true;
    const read = () =>
      api()
        .chatContextRead(target, path)
        .then((f) => live && setFile((old) => (old && old.stamp.hash === f.stamp.hash ? old : f)))
        .then(() => live && setErr(null))
        .catch((e) => live && setErr(errText(e)));
    void read();
    const t = setInterval(() => document.visibilityState === "visible" && void read(), POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, active, target.cwd, target.provider]);
  const text = path ? (file?.text ?? null) : it.text;
  const md = !path || /\.(md|markdown)$/i.test(path);
  const canDelete = canTrash(it);
  const del = async () => {
    if (!path) return;
    setBusy(true);
    try {
      const gone = await api().chatContextTrash(target, path);
      useStore.getState().toast(`Moved ${homeShort(gone).split("/").pop()} to the Trash`);
      onDeleted();
    } catch (e) {
      useStore.getState().toast(`Couldn't delete it: ${errText(e)}`);
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-context-view={path ?? it.id}
      onContextMenu={onContext(() => {
        // The file's text keeps its Copy / Select All.
        if (window.getSelection()?.toString()) return null;
        return contextItemMenu(path ?? null, {
          copyText,
          edit: it.editable && file?.editable ? onEdit : undefined,
          reveal: () => path && void api().chatContextReveal(target, path).catch((err) => useStore.getState().toast(errText(err))),
          trash: canDelete ? () => setConfirm(true) : undefined,
        });
      })}
    >
      <div className="shrink-0 space-y-2 px-4 pb-2.5">
        {it.description && it.group !== "instructions" && <p className="text-base text-fg">{it.description}</p>}
        <Meta item={it} provider={provider} />
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {text !== null && md && (
            <Segmented
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: "rendered", label: "Rendered", title: "Markdown, rendered" },
                { value: "source", label: "Source", title: "The file as it is" },
              ]}
            />
          )}
          <span className="flex-1" />
          {path && (
            <IconButton title="Reveal in Finder" onClick={() => void api().chatContextReveal(target, path).catch((e) => useStore.getState().toast(errText(e)))}>
              <IExternal size={14} />
            </IconButton>
          )}
          {canDelete && (
            <IconButton title={it.kind === "skill" ? "Move this skill's folder to the Trash" : "Move to the Trash"} onClick={() => setConfirm(true)}>
              <ITrash size={14} />
            </IconButton>
          )}
          {it.editable && file?.editable && (
            <Button variant="outline" className="h-[30px] px-2.5 text-small" onClick={onEdit} data-context-edit="">
              <IPencil size={12} /> Edit
            </Button>
          )}
        </div>
        {confirm && (
          <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-raised px-3 py-2 text-small text-fg" data-context-confirm>
            <span className="min-w-0 flex-1">{it.kind === "skill" ? `Move the ${it.label} skill (its whole folder) to the Trash?` : `Move ${path?.split("/").pop()} to the Trash?`}{it.kind === "memory" ? " Its line in MEMORY.md goes too." : ""}</span>
            <Button variant="ghost" className="h-[28px] px-2 text-small" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant="danger" className="h-[28px] px-2.5 text-small" disabled={busy} onClick={() => void del()} data-context-trash="">
              Move to Trash
            </Button>
          </div>
        )}
      </div>
      <div className="scroll min-h-0 flex-1 border-t border-hairline pb-4 pl-4 pr-[6px] pt-3">
        {err ? (
          <div className="text-base text-dim" data-context-error>
            {err}
          </div>
        ) : text === null ? (
          path ? <div className="text-base text-dim">Reading…</div> : <div className="text-base text-dim">Nothing to show.</div>
        ) : mode === "source" || !md ? (
          <pre className="selectable whitespace-pre-wrap break-words font-mono text-mono-small text-fg" data-context-source>
            {text}
          </pre>
        ) : (
          <Rendered text={text} />
        )}
      </div>
    </div>
  );
}

function Rendered({ text }: { text: string }) {
  const { meta, body } = splitFrontmatter(text);
  return (
    <div data-context-rendered>
      {meta.length > 0 && (
        <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-[10px] bg-[color-mix(in_oklab,var(--dim)_8%,transparent)] px-3 py-2 text-small">
          {meta.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-mono-small text-faint">{k}</dt>
              <dd className="selectable min-w-0 break-words text-dim">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <Markdown text={body.trim() ? body : "*Empty.*"} className="text-base" />
    </div>
  );
}

// ---------- the editor ----------

function Editor({ target, path, group, provider, active, onDone }: { target: CtxTarget; path: string; group: CtxGroup; provider: Provider; active: boolean; onDone: (saved: boolean) => void }) {
  const [file, setFile] = useState<CtxFile | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The file changed on disk: "conflict" while there are edits, "gone" when it was deleted. */
  const [disk, setDisk] = useState<{ state: "conflict" | "gone"; file: CtxFile | null } | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const gutter = useRef<HTMLDivElement | null>(null);
  const dirty = !!file && text !== file.text;
  const live = useRef({ dirty, file });
  live.current = { dirty, file };

  useEffect(() => {
    let on = true;
    api()
      .chatContextRead(target, path)
      .then((f) => {
        if (!on) return;
        setFile(f);
        setText(f.text);
        requestAnimationFrame(() => area.current?.focus());
      })
      .catch((e) => on && setErr(errText(e)));
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Watch the file while editing: reload quietly when there are no edits, say so when there are.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      const { dirty, file } = live.current;
      if (!file || document.visibilityState !== "visible") return;
      api()
        .chatContextRead(target, path)
        .then((f) => {
          const what = onDiskChange(dirty, file.stamp, f.stamp);
          if (what === "reload") {
            setFile(f);
            setText(f.text);
          } else if (what === "conflict") setDisk({ state: "conflict", file: f });
        })
        .catch(() => setDisk({ state: "gone", file: null }));
    }, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, path]);

  const save = async () => {
    if (!file || busy) return;
    setBusy(true);
    try {
      const r = await api().chatContextSave(target, path, text, file.stamp);
      if (r.result === "saved") {
        setFile({ ...file, text, stamp: r.stamp });
        onDone(true);
      } else {
        const f = await api()
          .chatContextRead(target, path)
          .catch(() => null);
        setDisk({ state: f ? "conflict" : "gone", file: f });
      }
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const reload = () => {
    if (disk?.file) {
      setFile(disk.file);
      setText(disk.file.text);
    }
    setDisk(null);
  };
  const lines = lineCount(text);
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-context-editor={path}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          e.stopPropagation();
          void save();
        } else if (e.key === "Escape" && !dirty) {
          e.preventDefault();
          e.stopPropagation();
          onDone(false);
        }
      }}
    >
      <div className="shrink-0 space-y-1 px-4 pb-2">
        <div className="selectable break-all font-mono text-mono-small text-dim">{homeShort(path)}</div>
        <div className="text-small text-dim">{whenItApplies(provider, group)}</div>
      </div>
      {disk && (
        <div className="mx-3 mb-2 flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-raised px-3 py-2 text-small text-fg" data-context-conflict={disk.state}>
          <span className="min-w-0 flex-1">{disk.state === "gone" ? "This file was deleted or moved since you opened it." : "This file changed on disk since you opened it (the agent may have edited it). Saving now would overwrite that."}</span>
          {disk.state === "conflict" && (
            <Button variant="outline" className="h-[28px] px-2.5 text-small" onClick={reload} data-context-reload="">
              Reload (drop my edits)
            </Button>
          )}
          <Button variant="ghost" className="h-[28px] px-2 text-small" onClick={() => setDisk(null)}>
            Keep editing
          </Button>
        </div>
      )}
      <div className="relative mx-3 flex min-h-0 flex-1 overflow-hidden rounded-[12px] border border-line bg-raised focus-within:border-[color-mix(in_oklab,var(--dim)_55%,var(--border))]">
        {err ? (
          <div className="p-3 text-base text-dim" data-context-error>
            {err}
          </div>
        ) : (
          <>
            <div ref={gutter} aria-hidden className="shrink-0 select-none overflow-hidden border-r border-hairline py-2.5 pl-2 pr-2 text-right text-faint tnum" style={MONO}>
              {Array.from({ length: lines }, (_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <textarea
              ref={area}
              value={text}
              disabled={!file}
              spellCheck={false}
              wrap="off"
              onChange={(e) => setText(e.target.value)}
              onScroll={(e) => {
                if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
              }}
              onKeyDown={(e) => {
                // Tab inserts two spaces (Markdown lists), Shift-Tab leaves the field as usual.
                if (e.key === "Tab" && !e.shiftKey) {
                  e.preventDefault();
                  const el = e.currentTarget;
                  const { selectionStart: a, selectionEnd: b } = el;
                  const next = text.slice(0, a) + "  " + text.slice(b);
                  setText(next);
                  requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
                }
              }}
              className="selectable min-w-0 flex-1 resize-none overflow-auto bg-transparent py-2.5 pl-2.5 pr-3 text-fg outline-none"
              // Inline: the app's unlayered `textarea { font: inherit }` (styles.css) wins over utility classes.
              style={MONO}
              aria-label={`Edit ${path.split("/").pop()}`}
              data-context-textarea=""
            />
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
        <span className="min-w-0 flex-1 truncate text-small text-faint">{file?.eol === "crlf" ? "Windows line endings kept · " : ""}⌘S saves</span>
        <Button variant="ghost" className="h-[30px] px-2.5 text-small" onClick={() => onDone(false)} data-context-cancel="">
          Cancel
        </Button>
        <Button variant="primary" className="h-[30px] px-3 text-small" disabled={!file || busy || !dirty} onClick={() => void save()} data-context-save="">
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

// ---------- creating ----------

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-small font-medium text-fg">{label}</span>
      {children}
      {hint && <span className="block text-small text-dim">{hint}</span>}
    </label>
  );
}

const input = "w-full rounded-[9px] border border-line bg-raised px-2.5 py-[7px] text-base text-fg outline-none placeholder:text-faint focus:border-[color-mix(in_oklab,var(--dim)_55%,var(--border))]";

function CreateSkill({ provider, ov, onCancel, onCreate }: { provider: Provider; ov: CtxOverview | null; onCancel: () => void; onCreate: (scope: "project" | "user" | "project-agents" | "user-agents", name: string, description: string) => void }) {
  const [scope, setScope] = useState<"project" | "user">("project");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const ok = validSkillName(name) && desc.trim().length > 0;
  const taken = !!ov?.items.some((i) => i.group === "skills" && i.label === name);
  const where = scope === "project" ? ov?.create.project_skills : ov?.create.user_skills;
  const codex = provider === "codex";
  return (
    <form
      className="scroll flex min-h-0 flex-1 flex-col gap-3.5 px-4 pb-4"
      data-context-create="skill"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok && !taken) onCreate(codex ? (scope === "project" ? "project-agents" : "user-agents") : scope, name, desc.trim());
      }}
    >
      <p className="text-small text-dim">A folder with a SKILL.md: its name and description are listed to the agent at the start of every chat, and it reads the rest when the task matches.</p>
      <Field label="For">
        <Segmented
          size="sm"
          value={scope}
          onChange={setScope}
          options={[
            { value: "project", label: "This project", title: "Shared with everyone who works in this repository" },
            { value: "user", label: "All my projects", title: "Only you, in every project" },
          ]}
        />
      </Field>
      <Field label="Name" hint={taken ? "A skill with this name already exists." : name && !validSkillName(name) ? "Lowercase letters, digits and dashes." : where ? `${homeShort(where)}/${name || "<name>"}/SKILL.md` : undefined}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))} placeholder="release-notes" className={input} data-context-skill-name="" />
      </Field>
      <Field label="Description" hint="When to use it: the agent decides from this line alone.">
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} placeholder="Draft the changelog entry for a release from the merged PRs since the last tag." className={cx(input, "resize-none")} data-context-skill-desc="" />
      </Field>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" className="h-[30px] px-2.5 text-small" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" className="h-[30px] px-3 text-small" disabled={!ok || taken} data-context-create-submit="">
          Create skill
        </Button>
      </div>
    </form>
  );
}

const MEMORY_KINDS = [
  { value: "project", label: "Project", title: "Facts about this project and its work" },
  { value: "feedback", label: "Feedback", title: "How you want the agent to work" },
  { value: "user", label: "About you", title: "Who you are, what you know" },
  { value: "reference", label: "Reference", title: "Where to find things" },
] as const;

function CreateMemory({ ov, onCancel, onCreate }: { ov: CtxOverview | null; onCancel: () => void; onCreate: (title: string, description: string, kind: string) => void }) {
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [kind, setKind] = useState<(typeof MEMORY_KINDS)[number]["value"]>("project");
  const ok = title.trim().length > 0 && desc.trim().length > 0;
  return (
    <form
      className="scroll flex min-h-0 flex-1 flex-col gap-3.5 px-4 pb-4"
      data-context-create="memory"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onCreate(title.trim(), desc.trim(), kind);
      }}
    >
      <p className="text-small text-dim">A file in Claude Code's auto memory for this project, with its line in MEMORY.md (the index every new chat starts with).</p>
      <Field label="Title" hint={ov?.memory_dir ? `${homeShort(ov.memory_dir)}/${fileNameFor(title)}.md` : undefined}>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Release process" className={input} data-context-memory-title="" />
      </Field>
      <Field label="One line for the index">
        <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Tag from main; the changelog is written by hand" className={input} data-context-memory-desc="" />
      </Field>
      <Field label="Kind">
        <Segmented size="sm" value={kind} onChange={setKind} options={MEMORY_KINDS.map((k) => ({ ...k }))} />
      </Field>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" className="h-[30px] px-2.5 text-small" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" className="h-[30px] px-3 text-small" disabled={!ok} data-context-create-submit="">
          Create
        </Button>
      </div>
    </form>
  );
}
