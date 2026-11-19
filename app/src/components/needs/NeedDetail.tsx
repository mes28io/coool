// The Needs you page's right side: one item in full. What the agent asks, in plain words; the whole payload (the
// command, the diff, the file, the page, the tool input); the answer, through the chat's own functions
// (`answerPermission` / `answerQuestion` in lib/actions.ts, the chat's question and plan cards); then why it asks:
// the person's prompt, what the agent said or thought just before, the steps that led there, the subagent asking,
// and the session's facts (project, folder, branch, permission mode, model, how long it waits).

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { answerPermission } from "../../lib/actions";
import { clockTime, displayTitle, folderName, projectOf } from "../../lib/format";
import { useGitTrail } from "../../lib/gitTrail";
import { modelLabel } from "../../lib/models";
import { chatContext, sessionContext, waitedCommand, type NeedContext } from "../../lib/needs";
import { toolRowFromText } from "../../lib/toolNames";
import { sessionKey } from "../../lib/types";
import { useStore } from "../../store";
import { Prose, StepLine } from "../Activity";
import { deviceAsk, permDetail, PlanApproval, QuestionCard, RememberRow, stepRow } from "../Chat";
import { PERMISSION_MODES } from "../ChatComposer";
import { IAgent, IBranch, IClock, IFolder, IForward, ILock, ISpark, ITerminal } from "../icons";
import { editPairs, InlineDiff } from "../InlineDiff";
import { patchFiles, patchPairs } from "../../lib/patch";
import { Markdown } from "../Markdown";
import { Age, Card, CardHeader, Node } from "../MissionCard";
import { Button, cx, Kbd, PathText, ProviderMark } from "../primitives";
import { Explain, PermExplain, RedactedPre, terminalSource } from "../Explain";
import { RiskTag } from "../RiskTag";
import { KindIcon } from "./KindIcon";
import { LidPaused } from "./LidPaused";
import type { Need } from "./need";

const label = "font-mono text-micro font-medium uppercase tracking-[0.06em] text-faint";

export function NeedDetail({ n }: { n: Need }) {
  const open = useStore((st) => st.open);
  const { s, chat, perm, ask, kind, who } = n;
  const goChat = () => open({ kind: "session", key: n.key });
  const title =
    kind === "plan"
      ? `${who} has a plan for you to approve`
      : perm
        ? `${who} wants to ${permDetail(perm, chat!.cwd).lead}`
        : ask
          ? `${who} has ${ask.questions.length === 1 ? "a question" : `${ask.questions.length} questions`}`
          : kind === "terminal"
            ? "Waiting on you in its terminal"
            : kind === "job"
              ? "A job it started is waiting on you"
              : "It may need you";

  return (
    <div className="flex flex-col gap-6" data-needs-detail={n.key} data-needs-detail-kind={kind}>
      <header className="flex flex-col gap-2">
        <div className="flex items-start gap-3">
          <KindIcon kind={kind} device={perm ? deviceAsk(perm)?.device : undefined} size={32} />
          <div className="min-w-0 flex-1">
            <h1 className="text-title font-semibold tracking-[-0.02em] text-fg @[760px]:text-display @[760px]:leading-[30px]">{title}</h1>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-small text-dim">
              <ProviderMark provider={s.provider} size={12} />
              <span className="min-w-0 truncate text-fg/90">{displayTitle(s)}</span>
              <span className="text-faint">·</span>
              <span className="shrink-0">{folderName(projectOf(s))}</span>
              <span className="text-faint">·</span>
              <span className="shrink-0 tnum">
                waiting <Age ms={n.since} className="inline w-auto text-dim" />
              </span>
            </div>
            <LidPaused sessionKey={n.key} request={perm?.requestId ?? ask?.requestId ?? null} />
          </div>
          {/* The "Risky" tag (lib/risk.ts), as on the chat's card; never for device-panel requests, which have their own gate. */}
          {perm && chat && !deviceAsk(perm) && <RiskTag tool={perm.tool} input={perm.input} cwd={chat.cwd} className="mt-1.5" />}
          <Button variant="outline" onClick={goChat} title="Open the chat (↵)" className="h-[30px] px-2.5 text-small" data-needs-open>
            {chat ? "Open chat" : "Open"}
            <IForward size={11} />
          </Button>
        </div>
      </header>

      <Request n={n} />
      <Why n={n} />
      <Facts n={n} />
    </div>
  );
}

// ---------- what it asks, and the answer ----------

function Request({ n }: { n: Need }) {
  const { s, chat, perm, ask, kind } = n;
  if (perm && chat && kind === "plan") return <PlanApproval item={perm} chat={chat} />;
  if (perm && chat) return <Permission n={n} />;
  if (ask && chat) return <QuestionCard key={ask.requestId} item={ask} chat={chat} bare />;
  // Not a request coool holds: say what is known, honestly, and where to answer it.
  const key = sessionKey(s);
  const cmd = waitedCommand(n.a.needs);
  const inCooolTerm = s.managed !== null;
  const where =
    kind === "terminal"
      ? inCooolTerm
        ? "It runs in a coool terminal: answer the prompt there."
        : chat
          ? "Answer it in the chat."
          : "This session runs in a terminal outside coool, so coool can't answer for it. Answer the prompt where it runs."
      : kind === "job"
        ? "A run it started (listed under it) is blocked. Open it to see what it waits on."
        : "An AI insight read this from the transcript; it isn't a request coool can answer. Open the session to check.";
  return (
    <section className="rounded-[14px] border border-[color-mix(in_oklab,var(--status-needs)_30%,var(--border))] bg-raised p-3.5 shadow-card" data-needs-outside={kind}>
      {/* The command a terminal wait names shows whole below, not twice. */}
      <p className="selectable text-base text-fg"><Prose text={upper(cmd ? `${(n.detail || n.a.needs || "").replace(/`[^`]+`/, "").trim()}:` : n.detail || n.a.needs || "")} /></p>
      {cmd && <RedactedPre className="selectable mt-2.5 whitespace-pre-wrap break-all rounded-[8px] border border-hairline bg-bg px-3 py-2 font-mono text-mono-small text-fg/90" text={cmd} />}
      {kind === "terminal" && <TerminalExplain n={n} command={cmd} />}
      {kind === "insight" && (
        <div className="mt-2 flex items-center gap-1.5 text-small text-faint">
          <ISpark size={12} /> AI insight
        </div>
      )}
      <p className="mt-2.5 text-small text-dim">{where}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => useStore.getState().open({ kind: "session", key })} data-needs-open-session>
          Open
        </Button>
        {inCooolTerm && (
          <Button
            variant="ghost"
            onClick={() => {
              useStore.getState().setMode({ kind: "session", key }, "terminal");
              useStore.getState().open({ kind: "session", key });
            }}
            data-needs-open-terminal
          >
            <ITerminal size={14} />
            Open in terminal
          </Button>
        )}
      </div>
    </section>
  );
}

function Permission({ n }: { n: Need }) {
  const perm = n.perm!;
  const chat = n.chat!;
  const d = permDetail(perm, chat.cwd);
  const quick = perm.remember[0]?.scope === "chat" ? perm.remember[0] : null;
  return (
    <section className="attn-card overflow-hidden rounded-[14px] border border-[color-mix(in_oklab,var(--status-needs)_30%,var(--border))] bg-raised shadow-card" data-approval={perm.requestId} data-needs-permission={perm.tool}>
      <div className="px-3.5 pt-3.5">
        <div className="mb-2 flex items-center gap-2">
          <span className={label}>{payloadLabel(n.kind)}</span>
          <span className="ml-auto rounded-[6px] bg-[color-mix(in_oklab,var(--dim)_11%,transparent)] px-1.5 text-small font-medium text-dim" title={perm.tool}>
            {perm.tool}
          </span>
        </div>
        <Payload n={n} />
        {d.note && n.kind !== "command" && <p className="mt-2 text-base text-dim" data-needs-note>{d.note}</p>}
        {/* What this does and why (components/Explain.tsx): the agent's own words, then the AI read when on. */}
        {n.kind !== "device" && (
          <div className="mt-3">
            <PermExplain perm={perm} chat={chat} project={projectOf(n.s) || null} variant="full" />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3.5 pb-3.5 pt-3">
        <Button variant="primary" onClick={() => answerPermission(chat.id, perm.requestId, "allow")} title="Allow this once (⌘↵)" data-allow-once>
          Allow once
          <Kbd className="ml-0.5 border-transparent bg-[color-mix(in_oklab,var(--bg)_16%,transparent)] text-current">⌘↵</Kbd>
        </Button>
        <Button variant="ghost" onClick={() => answerPermission(chat.id, perm.requestId, "deny")} className="hover:text-err-text" title="Deny (⌘⌫)" data-deny>
          Deny
        </Button>
        <span className="ml-auto text-small text-faint">The turn is paused until you answer</span>
      </div>
      {perm.remember.length > 0 && (
        <div className="border-t border-hairline px-3.5 pb-3.5 pt-2.5" data-remember-options>
          <div className={cx(label, "mb-1.5")}>Allow and don't ask again</div>
          <div className="flex flex-col gap-1.5">
            {perm.remember.map((o) => (
              <RememberRow key={o.id} option={o} quick={o === quick} onPick={() => answerPermission(chat.id, perm.requestId, "always", o)} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

const payloadLabel = (k: Need["kind"]) =>
  k === "command" ? "The command" : k === "edit" ? "The change" : k === "write" ? "The file it writes" : k === "fetch" ? "The page" : k === "device" ? "What and where" : "The tool's input";

const pre = "selectable whitespace-pre-wrap break-all rounded-[8px] border border-hairline bg-bg px-3 py-2 font-mono text-mono-small text-fg/90";

/** The whole request: never one line cut short. */
function Payload({ n }: { n: Need }) {
  const perm = n.perm!;
  const cwd = n.chat!.cwd;
  const i = (perm.input ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  const edit = n.kind === "edit" ? editPairs(perm.tool, perm.input) : null;
  if (edit) return <InlineDiff path={edit.path} pairs={edit.pairs} root={projectOf(n.s) || cwd} tall />;
  // Codex's apply_patch: each file's change (lib/patch.ts), a created file as all new text.
  const patch = n.kind === "edit" ? patchFiles(perm.input) : null;
  if (patch)
    return (
      <div className="flex flex-col" data-needs-patch={patch.length}>
        {patch.map((f) => (
          <InlineDiff key={f.path} path={f.movePath ?? f.path} pairs={patchPairs(f)} root={projectOf(n.s) || cwd} tall />
        ))}
      </div>
    );
  if (n.kind === "command")
    return (
      <>
        {/* Its description shows under "What this does and why", as the agent's own words. */}
        <RedactedPre className={cx(pre, "max-h-[50vh] overflow-auto")} data-needs-command text={s("command") || perm.summary} />
      </>
    );
  if (n.kind === "write") {
    const content = s("content") || s("new_source");
    const lines = content ? content.split("\n").length : 0;
    return (
      <div className="overflow-hidden rounded-[10px] border border-hairline bg-panel">
        <div className="flex h-[30px] items-center gap-1.5 border-b border-hairline px-2.5 text-small">
          <span className="min-w-0 truncate font-mono text-mono-small text-dim" title={s("file_path") || s("notebook_path")}>{permDetail(perm, cwd).body}</span>
          {lines > 0 && <span className="ml-auto shrink-0 font-mono text-mono-small text-done-text tnum">+{lines}</span>}
        </div>
        <pre className="scroll selectable max-h-[min(460px,50vh)] overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-mono-small text-dim">{content || "(empty file)"}</pre>
      </div>
    );
  }
  if (n.kind === "fetch")
    return (
      <>
        <RedactedPre className={pre} text={s("url")} />
        {s("prompt") && (
          <p className="mt-2 text-base text-dim">
            <span className="text-faint">What it looks for: </span>
            {s("prompt")}
          </p>
        )}
      </>
    );
  if (n.kind === "device") {
    const d = deviceAsk(perm)!;
    return <pre className={pre}>{d.body}</pre>;
  }
  const json = JSON.stringify(perm.input ?? {}, null, 2);
  return (
    <>
      <p className="mb-2 text-base text-fg">{permDetail(perm, cwd).body}</p>
      <pre className={cx(pre, "max-h-[40vh] overflow-auto break-words")}>{json === "{}" ? perm.summary || "(no input)" : json}</pre>
    </>
  );
}

/** A terminal wait: what the transcript gives, and the AI read when the wait names its command. */
function TerminalExplain({ n, command }: { n: Need; command: string | null }) {
  const ctx = useContext(n);
  const cwd = n.s.cwd;
  const project = projectOf(n.s) || null;
  const src = useMemo(() => terminalSource({ key: n.key, command, cwd, project, ctx, who: n.who }), [n.key, command, cwd, project, ctx, n.who]);
  return (
    <div className="mt-3">
      <Explain src={src} variant="full" />
    </div>
  );
}

// ---------- why it asks ----------

function useContext(n: Need): NeedContext {
  const at = n.perm?.ts ?? n.ask?.ts ?? Infinity;
  const items = n.chat?.items;
  const tool = n.perm?.tool ?? (n.ask ? "AskUserQuestion" : null);
  const activity = n.s.activity;
  const lastPrompt = n.s.last_prompt;
  return useMemo(() => (items ? chatContext(items, at, tool) : sessionContext({ activity, last_prompt: lastPrompt })), [items, at, tool, activity, lastPrompt]);
}

function Why({ n }: { n: Need }) {
  const c = useContext(n);
  const cwd = n.chat?.cwd ?? n.s.cwd;
  const empty = !c.prompt && !c.said && !c.thought && !c.steps.length && !c.agent;
  if (empty) return null;
  return (
    <section className="flex flex-col gap-4" data-needs-why>
      <div className={label}>Why it's asking</div>
      {c.agent && (
        <div className="flex items-center gap-2 text-base" data-needs-agent>
          <IAgent size={14} className="text-dim" />
          <span className="text-dim">Asked by a subagent:</span>
          <span className="font-medium text-fg">{c.agent.kind}</span>
          {c.agent.description && <span className="min-w-0 truncate text-dim">· {c.agent.description}</span>}
        </div>
      )}
      {c.prompt && (
        <Quote who="You asked" data="prompt">
          <p className="whitespace-pre-wrap text-base text-fg">{c.prompt}</p>
        </Quote>
      )}
      {(c.said || c.thought) && (
        <Quote who={c.said ? `Then ${n.who} said` : `${n.who} was thinking`} data="said">
          {c.said ? <Markdown text={c.said} /> : <p className="whitespace-pre-wrap text-base italic text-dim">{c.thought}</p>}
        </Quote>
      )}
      {c.steps.length > 0 && (
        <Card data-needs-steps={c.steps.length}>
          <CardHeader icon={ITerminal} title="Steps before it asked" meta={n.chat ? undefined : "from the transcript"} />
          <div className="px-1.5 py-1.5">
            {c.steps.map((st, i) => {
              if (st.kind === "tool") {
                const r = stepRow(st.tool, cwd);
                return <StepLine key={st.tool.id} name={r.label} tool={st.tool.name} soft={r.soft} detail={r.detail} active={false} failed={st.tool.ok === false} stamp={clockTime(st.tool.ts)} />;
              }
              const r = toolRowFromText(st.a.text);
              return <StepLine key={i} name={r.label} tool={r.raw} detail={r.detail} active={false} stamp={st.a.ts} />;
            })}
          </div>
        </Card>
      )}
    </section>
  );
}

/** A quoted message, long ones folded to a few lines with "Show all". */
function Quote({ who, data, children }: { who: string; data: string; children: ReactNode }) {
  const [all, setAll] = useState(false);
  // "Show all" only when the text is taller than the fold.
  const [long, setLong] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const read = () => setLong(el.scrollHeight > 132 + 2);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const folded = long && !all;
  return (
    <div className="border-l-2 border-line pl-3.5" data-needs-quote={data}>
      <div className="mb-1 text-small text-dim">{who}</div>
      <div ref={body} className={cx("selectable relative", !all && "max-h-[132px] overflow-hidden", folded && "[mask-image:linear-gradient(#000_70%,transparent)]")} data-needs-quote-body>
        {children}
      </div>
      {long && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 text-small text-faint transition-colors hover:text-fg">
          {all ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

// ---------- the session's facts ----------

function Facts({ n }: { n: Need }) {
  const { s, chat } = n;
  const project = projectOf(s);
  const cwd = chat?.cwd ?? s.cwd;
  const trail = useGitTrail(cwd, "")?.trail ?? null;
  const worktree = cwd !== project && /\/(worktrees?|\.worktrees)\//.test(cwd);
  const mode = chat?.permissionMode ? PERMISSION_MODES[chat.provider]?.find((m) => m.id === chat.permissionMode) : null;
  const model = chat?.model ?? s.model;
  return (
    <Card data-needs-facts>
      <CardHeader icon={IFolder} title="The session" meta={s.origin === "coool" || chat ? "in coool" : "outside coool"} />
      <Fact icon={<IFolder size={13} />} k="Project">
        <span className="text-fg">{folderName(project)}</span>
        <PathText path={project} className="min-w-0 text-mono-small text-faint" />
      </Fact>
      {cwd !== project && (
        <Fact icon={<IFolder size={13} />} k={worktree ? "Worktree" : "Folder"}>
          <PathText path={cwd} className="min-w-0 text-mono-small text-dim" />
        </Fact>
      )}
      {trail?.branch && (
        <Fact icon={<IBranch size={13} />} k="Branch">
          <span className="truncate font-mono text-mono-small text-fg">{trail.branch}</span>
        </Fact>
      )}
      <Fact icon={<ILock size={13} />} k="Permission mode">
        {mode ? (
          <>
            <span className="text-fg">{mode.label}</span>
            <span className="min-w-0 truncate text-dim">{mode.description}</span>
          </>
        ) : chat?.permissionMode ? (
          <span className="text-fg">{chat.permissionMode}</span>
        ) : (
          <span className="text-dim">{chat ? "The CLI's default" : "Set in its own terminal"}</span>
        )}
      </Fact>
      {model && (
        <Fact icon={<ProviderMark provider={s.provider} size={12} />} k="Model">
          <span className="text-fg">{modelLabel(model)}</span>
        </Fact>
      )}
      <Fact icon={<IClock size={13} />} k="Waiting since">
        <span className="text-fg tnum">{clockTime(n.since)}</span>
        <span className="text-dim">
          · <Age ms={n.since} className="inline w-auto" /> ago
        </span>
      </Fact>
    </Card>
  );
}

function Fact({ icon, k, children }: { icon: ReactNode; k: string; children: ReactNode }) {
  return (
    <div className="flex h-[36px] min-w-0 items-center gap-2.5 border-t border-hairline px-3.5 first-of-type:border-t-0" data-needs-fact={k}>
      <Node className="text-faint">{icon}</Node>
      <span className="w-[120px] shrink-0 text-small text-dim">{k}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2 text-base">{children}</span>
    </div>
  );
}

const upper = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
