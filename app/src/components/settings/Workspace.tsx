// Settings > Git & worktrees and Settings > Connections: both about one project at a time (the picker on top).

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "../../lib/backend";
import { folderName, homeShort, projectOf } from "../../lib/format";
import type { McpServer, ProviderConn, Worktree, Worktrees } from "../../lib/settingsTypes";
import type { Provider } from "../../lib/types";
import { useStore } from "../../store";
import { IExternal, IRefresh } from "../icons";
import { IconButton, ProviderMark } from "../primitives";
import { ConfirmButton, ErrorLine, errText, fmtBytes, Group, Mono, Note, Row, Select, Tag, useLoad, useSearching, type Option } from "./ui";

// ---------- the project ----------

let picked: string | null = null;
const subs = new Set<() => void>();
const pick = (p: string) => {
  picked = p;
  subs.forEach((f) => f());
};

/** The projects coool knows (most recent first) and the one these sections look at. */
function useProject(): [string | null, string[]] {
  const sessions = useStore((s) => s.sessions);
  const projects = useMemo(() => {
    const seen: string[] = [];
    for (const s of [...sessions].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))) {
      const p = projectOf(s);
      if (p && !seen.includes(p)) seen.push(p);
    }
    return seen;
  }, [sessions]);
  const cur = useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => picked,
  );
  const project = cur && projects.includes(cur) ? cur : (projects[0] ?? null);
  // Keep to the first project shown: the list reorders as sessions update.
  useEffect(() => {
    if (!picked && project) picked = project;
  }, [project]);
  return [project, projects];
}

function ProjectPicker({ project, projects, what }: { project: string | null; projects: string[]; what: string }) {
  if (useSearching()) return null;
  const opts: Option<string>[] = projects.map((p) => ({ value: p, label: folderName(p), hint: homeShort(p) }));
  return (
    <div className="mb-5 flex items-center gap-3">
      <p className="min-w-0 flex-1 text-small text-faint">{what}</p>
      {project && <Select label="Project" value={project} options={opts} width={300} onChange={pick} />}
    </div>
  );
}

// ---------- Git & worktrees ----------

function WtRow({ w, project, onDone }: { w: Worktree; project: string; onDone: (v: Worktrees) => void }) {
  const [err, setErr] = useState<string | null>(null);
  const tags = (
    <span className="flex flex-wrap items-center gap-1">
      {w.main && <Tag>main</Tag>}
      {w.agent && <Tag>agent</Tag>}
      {!w.main && (w.merged ? <Tag tone="ok">merged</Tag> : <Tag tone="warn">not merged</Tag>)}
      {w.dirty && <Tag tone="warn">uncommitted</Tag>}
      {w.locked && <Tag>locked</Tag>}
    </span>
  );
  return (
    <Row
      attr={`worktree-${folderName(w.path)}`}
      label={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-mono-base">{w.branch ?? `detached ${w.head}`}</span>
          {tags}
        </span>
      }
      k={`${w.branch ?? ""} ${w.path} worktree branch`}
      desc={
        <>
          <Mono className="text-dim">{homeShort(w.path)}</Mono>
          <span className="block text-faint">
            {fmtBytes(w.bytes)} · {w.head}
            {!w.removable && !w.main && w.why_not ? ` · ${w.why_not}` : ""}
          </span>
        </>
      }
      control={
        w.removable ? (
          <ConfirmButton
            label="Remove…"
            confirm="Remove worktree"
            attr={`wt-remove-${folderName(w.path)}`}
            onConfirm={() =>
              api()
                .worktreeRemove(project, w.path)
                .then(onDone)
                .catch((e) => setErr(errText(e)))
            }
          />
        ) : undefined
      }
    >
      <ErrorLine>{err}</ErrorLine>
    </Row>
  );
}

export function Git() {
  const [project, projects] = useProject();
  const { data, err, loading, reload, set } = useLoad<Worktrees>(project ? `wt:${project}` : null, () => api().worktreesList(project!));
  const agents = (data?.list ?? []).filter((w) => !w.main);
  const removable = agents.filter((w) => w.removable);
  return (
    <>
      <ProjectPicker project={project} projects={projects} what="Worktrees agents made in a project, how much disk each takes, and which are safe to remove." />
      {!project ? (
        <Note>No project yet. Start a session in a folder and it shows here.</Note>
      ) : (
        <>
          <Group label="Repository">
            <Row attr="git-version" label="Git" k="git version installed" desc={data ? (data.git ?? "Not installed") : "…"} />
            <Row attr="git-root" label="Main worktree" k="repository root" desc={data?.root ? <Mono>{homeShort(data.root)}</Mono> : data?.error ? data.error : "…"} />
            <Row attr="git-main" label="Compared against" k="main branch merged" desc={data ? (data.main_branch ? `${data.main_branch}: a worktree is merged when its last commit is in it.` : "No main branch found.") : "…"} />
          </Group>
          <Group
            label={
              <span className="flex w-full items-center">
                <span className="flex-1">Worktrees {data ? `· ${agents.length}` : ""}</span>
                <IconButton title="Check again" onClick={reload} disabled={loading} className="-my-1 size-6 normal-case">
                  <IRefresh size={12} className={loading ? "animate-spin" : undefined} />
                </IconButton>
              </span>
            }
            footer={
              data && agents.length
                ? `${removable.length} of ${agents.length} can be removed. Remove only offers merged agent worktrees with nothing uncommitted, then deletes their branch with git branch -d; git refuses anything that would lose work.`
                : undefined
            }
          >
            {data ? agents.map((w) => <WtRow key={w.path} w={w} project={project} onDone={set} />) : null}
            {data && agents.length === 0 && <Row attr="wt-none" label="No other worktrees" desc="Agents that work in their own worktree show up here." k="worktree" />}
            {!data && <Row label="Worktrees" desc={err ?? "Reading git…"} k="worktree" />}
          </Group>
        </>
      )}
    </>
  );
}

// ---------- Connections ----------

function OpenFile({ path, project }: { path: string; project: string | null }) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-1" title={err ?? undefined}>
      <IconButton
        title="Open file"
        onClick={() =>
          void api()
            .openConfigFile(path, project)
            .catch((e) => setErr(errText(e)))
        }
      >
        <IExternal size={14} />
      </IconButton>
    </span>
  );
}

function serverDesc(m: McpServer) {
  return (
    <>
      <Mono className="text-dim">{m.command ?? m.url ?? ""}</Mono>
      {(m.env_keys.length > 0 || m.header_keys.length > 0) && (
        <span className="mt-0.5 block text-faint">
          {m.env_keys.length > 0 && <>env {m.env_keys.join(", ")}</>}
          {m.env_keys.length > 0 && m.header_keys.length > 0 && " · "}
          {m.header_keys.length > 0 && <>headers {m.header_keys.join(", ")}</>} · values hidden
        </span>
      )}
    </>
  );
}

function ProviderConnections({ provider, c, project }: { provider: Provider; c: ProviderConn; project: string | null }) {
  const name = provider === "claude" ? "Claude Code" : "Codex";
  const mark = <ProviderMark provider={provider} size={12} />;
  return (
    <>
      <Group
        attr={`mcp-${provider}`}
        label={
          <>
            {mark} {name} · MCP servers
          </>
        }
      >
        {c.mcp.map((m) => (
          <Row
            key={`${m.scope}:${m.name}`}
            attr={`mcp-${provider}-${m.name}`}
            label={
              <span className="flex flex-wrap items-center gap-2">
                {m.name}
                <Tag>{m.scope}</Tag>
                <Tag>{m.transport}</Tag>
                {m.disabled && <Tag tone="off">disabled</Tag>}
              </span>
            }
            k={`${m.name} ${m.scope} ${m.transport} ${m.command ?? ""} ${m.url ?? ""} mcp server`}
            desc={serverDesc(m)}
            control={<OpenFile path={m.file} project={project} />}
          />
        ))}
        {c.mcp.length === 0 && <Row attr={`mcp-${provider}-none`} label="No MCP servers" desc={provider === "claude" ? "Add one with claude mcp add." : "Add one under [mcp_servers] in ~/.codex/config.toml."} k="mcp" />}
      </Group>
      <Group
        attr={`hooks-${provider}`}
        label={
          <>
            {mark} {name} · {provider === "claude" ? "Hooks" : "Notify command"}
          </>
        }
      >
        {c.hooks.map((h, i) => (
          <Row
            key={i}
            attr={`hook-${provider}-${i}`}
            label={
              <span className="flex flex-wrap items-center gap-2">
                {h.event}
                {h.matcher && <Tag>{h.matcher}</Tag>}
              </span>
            }
            k={`${h.event} ${h.matcher ?? ""} ${h.command} hook`}
            desc={<Mono className="text-dim">{h.command}</Mono>}
            control={<OpenFile path={h.file} project={project} />}
          />
        ))}
        {c.hooks.length === 0 && <Row attr={`hooks-${provider}-none`} label={provider === "claude" ? "No hooks" : "No notify command"} desc={provider === "claude" ? "Shell commands Claude Code runs on events like PreToolUse." : "The program Codex runs when a turn ends."} k="hooks" />}
      </Group>
      {provider === "claude" && (
        <Group
          attr="plugins-claude"
          label={
            <>
              {mark} {name} · Plugins
            </>
          }
        >
          {c.plugins.map((p) => (
            <Row
              key={p.name + (p.source ?? "")}
              attr={`plugin-${p.name}`}
              label={
                <span className="flex flex-wrap items-center gap-2">
                  {p.name}
                  {p.enabled ? <Tag tone="ok">on</Tag> : <Tag tone="off">off</Tag>}
                </span>
              }
              k={`${p.name} ${p.source ?? ""} plugin`}
              desc={[p.source && `from ${p.source}`, p.version && `version ${p.version}`].filter(Boolean).join(" · ") || undefined}
              control={<OpenFile path={p.file} project={project} />}
            />
          ))}
          {c.plugins.length === 0 && <Row attr="plugins-none" label="No plugins" desc="Install some with /plugin in Claude Code." k="plugins" />}
        </Group>
      )}
      <Group
        attr={`files-${provider}`}
        label={
          <>
            {mark} {name} · Files read
          </>
        }
      >
        {c.files.map((f) => (
          <Row key={f.path} attr={`file-${f.path}`} label={f.label} k={`${f.path} config file`} desc={<Mono className={f.exists ? "text-dim" : "text-faint"}>{homeShort(f.path)}{f.exists ? "" : " (none)"}</Mono>} control={f.exists ? <OpenFile path={f.path} project={project} /> : undefined} />
        ))}
        {c.errors.map((e) => (
          <Row key={e} attr={`conn-error-${provider}`} label="Couldn’t read" desc={<span className="text-err-text">{e}</span>} k="error" />
        ))}
      </Group>
    </>
  );
}

export function Connections() {
  const [project, projects] = useProject();
  const { data, err } = useLoad(`conn:${project ?? ""}`, () => api().connections(project));
  return (
    <>
      <ProjectPicker project={project} projects={projects} what="What your Claude Code and Codex are set up with, read from their own config files. coool never changes them; values of env vars, headers and tokens are hidden." />
      {data ? (
        <>
          <ProviderConnections provider="claude" c={data.claude} project={project} />
          <ProviderConnections provider="codex" c={data.codex} project={project} />
        </>
      ) : (
        <div className="px-1 text-small text-faint">{err ?? "Reading…"}</div>
      )}
    </>
  );
}
