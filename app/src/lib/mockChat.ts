// Mock chat driver for the browser build: emits CHAT_SPEC events with the same
// shapes and ordering the Rust driver will, so every UI state can be exercised
// without a CLI. Scripted turns stream text, form step lists, launch a subagent
// on a cheaper model, and ask for permission before running commands.
//
// Prompt keywords pick a scenario (handy for screenshots and demos):
//   "error"  -> a tool fails, then an API error notice ends the turn
//   "crash"  -> the CLI process exits with code 1 mid-turn
//   "hi" / "quick" / "?" at the end -> a short text-only reply
//   "ask" / "choose" / "which"        -> a question card (AskUserQuestion), then a reply using the answer
// Slash commands that only work in the TUI emit `notice` with needs_terminal.

import type { Activity, Agent, ChatEvent, ChatInfo, ChatRunState, CommandInfo, ModelOption, ModelUse, Provider, Question, RememberOption, Session, SlashCommand, Tokens } from "./types";

type DistOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
type Draft = DistOmit<ChatEvent, "seq" | "ts">;

export interface ChatHost {
  /** Called once the chat has a transcript (first prompt): make it a Session. */
  link(c: MockChat, s: Session): void;
  changed(): void;
  newPty(provider: Provider, cwd: string): number;
}

class Interrupted extends Error {}

const CLAUDE_MODELS: ModelOption[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-fable-5-2", label: "Fable 5.2" },
];
const CODEX_MODELS: ModelOption[] = [
  { id: "gpt-5.1-codex", label: "gpt-5.1-codex" },
  { id: "gpt-5.1-codex-mini", label: "gpt-5.1-codex-mini" },
  { id: "gpt-5.1", label: "gpt-5.1" },
];

const CLAUDE_COMMANDS: SlashCommand[] = [
  { name: "add-dir", description: "Add a working directory" },
  { name: "agents", description: "Manage agent configurations" },
  { name: "clear", description: "Clear conversation history and free up context" },
  { name: "compact", description: "Clear history but keep a summary in context" },
  { name: "config", description: "Open the config panel" },
  { name: "context", description: "Visualize current context usage" },
  { name: "cost", description: "Show the total cost and duration of the session" },
  { name: "doctor", description: "Diagnose and verify your installation" },
  { name: "export", description: "Export the conversation to a file or clipboard" },
  { name: "help", description: "Show help and available commands" },
  { name: "hooks", description: "Manage hook configurations for tool events" },
  { name: "init", description: "Initialize a CLAUDE.md file with codebase documentation" },
  { name: "login", description: "Sign in with your Anthropic account" },
  { name: "logout", description: "Sign out from your Anthropic account" },
  { name: "mcp", description: "Manage MCP servers" },
  { name: "memory", description: "Edit Claude memory files" },
  { name: "model", description: "Set the AI model for Claude Code" },
  { name: "permissions", description: "Manage allow and deny tool permission rules" },
  { name: "pr-comments", description: "Get comments from a GitHub pull request" },
  { name: "review", description: "Review a pull request" },
  { name: "status", description: "Show version, model, account and connectivity" },
  { name: "terminal-setup", description: "Install Shift+Enter key binding for newlines" },
  { name: "usage", description: "Show plan usage limits" },
  { name: "vim", description: "Toggle between Vim and Normal editing modes" },
  { name: "ship", description: "Run checks, write a changelog entry and open a PR (project command)" },
];
const CODEX_COMMANDS: SlashCommand[] = [
  { name: "model", description: "Choose what model and reasoning effort to use" },
  { name: "approvals", description: "Choose what Codex can do without approval" },
  { name: "review", description: "Review my current changes and find issues" },
  { name: "new", description: "Start a new chat during a conversation" },
  { name: "init", description: "Create an AGENTS.md file with instructions for Codex" },
  { name: "compact", description: "Summarize the conversation to prevent hitting the context limit" },
  { name: "diff", description: "Show git diff (including untracked files)" },
  { name: "mention", description: "Mention a file" },
  { name: "status", description: "Show current session configuration and token usage" },
  { name: "mcp", description: "List configured MCP tools" },
  { name: "logout", description: "Log out of Codex" },
];
const TUI_ONLY = new Set(["login", "logout", "config", "doctor", "terminal-setup", "vim", "hooks", "mcp", "agents", "memory", "add-dir", "export", "mention", "diff"]);
const SKILLS: CommandInfo[] = [
  { name: "dataviz", description: "Use this skill whenever you are about to create a chart or dashboard", argument_hint: "", aliases: [], kind: "skill" },
  { name: "pdf", description: "Use this skill whenever the user wants to do anything with PDF files", argument_hint: "", aliases: ["anthropic-skills:pdf"], kind: "skill" },
  { name: "security-review", description: "Complete a security review of the pending changes on the current branch", argument_hint: "", aliases: [], kind: "skill" },
];
const HINTS: Record<string, string> = { model: "<model>", compact: "<optional custom summarization instructions>", review: "[pr]", "pr-comments": "<pr>" };
const ALIASES: Record<string, string[]> = { clear: ["reset", "new"], usage: ["cost", "stats"], config: ["settings"] };
function commandInfos(list: SlashCommand[]): CommandInfo[] {
  const base: CommandInfo[] = list.map((c) => ({
    name: c.name,
    description: c.description,
    argument_hint: HINTS[c.name] ?? "",
    aliases: ALIASES[c.name] ?? [],
    kind: TUI_ONLY.has(c.name) ? "terminal" : c.name === "ship" ? "skill" : "command",
  }));
  return list === CLAUDE_COMMANDS ? [...base, ...SKILLS] : base;
}

const sleepReal = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rid = () => Math.random().toString(16).slice(2, 10);
const hhmmss = (t: number) => new Date(t).toTimeString().slice(0, 8);

export class MockChat {
  seq = 0;
  events: ChatEvent[] = [];
  state: ChatRunState = "idle";
  running = true;
  model: string;
  mode: string;
  sessionId: string;
  session: Session | null = null;
  /** Virtual clock while pre-seeding history; null = real time. */
  vt: number | null = null;
  gen = 0;
  waiting: { requestId: string; remember: RememberOption[]; resolve: (a: "allow" | "always" | "deny") => void } | null = null;
  asking: { requestId: string; resolve: (a: string[][] | null) => void } | null = null;
  always = new Set<string>();
  queue: string[] = [];
  busy = false;
  ctx = 14_000;
  turnStart = 0;
  agentModel = new Map<string, string>();
  mirrorTotal = { input: 0, cached: 0, output: 0 };

  constructor(
    public id: number,
    public provider: Provider,
    public cwd: string,
    private host: ChatHost,
    private flush: (c: MockChat, e: ChatEvent) => void,
    opts: { model?: string | null; mode?: string | null; resume?: string | null },
  ) {
    this.model = opts.model ?? (provider === "claude" ? "claude-opus-5-5" : "gpt-5.1-codex");
    this.mode = opts.mode ?? (provider === "claude" ? "default" : "on-request");
    this.sessionId = opts.resume ?? `${rid()}-${rid().slice(0, 4)}`;
  }

  info(): ChatInfo {
    return { id: this.id, provider: this.provider, cwd: this.cwd, session_id: this.sessionId, model: this.model, permission_mode: this.mode, state: this.state, running: this.running };
  }

  now() {
    return this.vt ?? Date.now();
  }
  async sleep(ms: number, gen: number) {
    if (this.vt !== null) this.vt += ms;
    else await sleepReal(ms);
    if (gen !== this.gen) throw new Interrupted();
  }

  emit(d: Draft) {
    const e = { ...d, seq: ++this.seq, ts: this.now() } as ChatEvent;
    this.events.push(e);
    if (this.events.length > 4000) this.events.splice(0, this.events.length - 4000);
    this.sync(e);
    this.flush(this, e);
  }

  ready() {
    this.emit({
      type: "ready",
      session_id: this.sessionId,
      model: this.model,
      cwd: this.cwd,
      permission_mode: this.mode,
      slash_commands: this.provider === "claude" ? CLAUDE_COMMANDS : CODEX_COMMANDS,
      models: this.provider === "claude" ? CLAUDE_MODELS : CODEX_MODELS,
      agents: this.provider === "claude" ? ["general-purpose", "Explore", "Plan"] : [],
      // Claude reports its window; Codex does not here, so the UI's family table gets exercised.
      context_window: this.provider === "claude" ? 1_000_000 : null,
    });
    if (!this.events.some((e) => e.type === "commands")) this.emit({ type: "commands", commands: commandInfos(this.provider === "claude" ? CLAUDE_COMMANDS : CODEX_COMMANDS) });
  }

  setState(s: ChatRunState) {
    if (this.state === s) return;
    this.state = s;
    this.emit({ type: "state", state: s });
  }

  // ---------- Session mirror (what discovery would report for this chat) ----------

  private sync(e: ChatEvent) {
    const s = this.session;
    if (!s) return;
    const t = e.ts;
    const push = (a: Activity) => {
      s.activity.push(a);
      if (s.activity.length > 300) s.activity.splice(0, s.activity.length - 300);
    };
    switch (e.type) {
      case "user_message":
        push({ ts: hhmmss(t), kind: "prompt", text: e.text });
        s.last_prompt = e.text;
        if (!s.title) s.title = e.text.length > 60 ? e.text.slice(0, 59) + "…" : e.text;
        break;
      case "assistant_message":
        if (!e.parent_tool_id && e.text) push({ ts: hhmmss(t), kind: "text", text: e.text.split("\n")[0] });
        break;
      case "tool_start":
        if (!e.parent_tool_id) {
          const isAgent = /^(task|agent)$/i.test(e.name);
          push({ ts: hhmmss(t), kind: isAgent ? "agent" : "tool", text: `${isAgent ? "Agent" : e.name} · ${e.summary}` });
          s.current = `${isAgent ? "Agent" : e.name} · ${e.summary}`;
          if (isAgent) {
            const model = this.agentModel.get(e.id) ?? "claude-haiku-5-5";
            s.agents.push({ id: e.id, kind: String((e.input as { subagent_type?: string })?.subagent_type ?? "general-purpose"), description: e.summary, finished: false, current: null, tokens: { input: 0, cached: 0, output: 0, context: 0 }, activity: [], model, models: [] });
          }
        } else {
          const a = s.agents.find((g) => g.id === e.parent_tool_id);
          if (a) {
            a.activity.push({ ts: hhmmss(t), kind: "tool", text: `${e.name} · ${e.summary}` });
            a.current = `${e.name} · ${e.summary}`;
          }
        }
        break;
      case "tool_end": {
        const a = s.agents.find((g) => g.id === e.id);
        if (a) {
          a.finished = true;
          a.current = null;
        }
        break;
      }
      case "notice":
        if (e.level === "error") push({ ts: hhmmss(t), kind: "error", text: e.text });
        break;
      case "usage": {
        const prevT = this.mirrorTotal;
        const dt = { input: e.tokens.input - prevT.input, cached: e.tokens.cached - prevT.cached, output: e.tokens.output - prevT.output };
        this.mirrorTotal = { input: e.tokens.input, cached: e.tokens.cached, output: e.tokens.output };
        const add = (list: ModelUse[], via = false) => {
          const m = e.model ?? this.model;
          let u = list.find((x) => x.model === m && !!x.via_agent === via);
          if (!u) list.push((u = { model: m, input: 0, cached: 0, output: 0, messages: 0, ...(via ? { via_agent: true } : {}) }));
          u.input += dt.input;
          u.cached += dt.cached;
          u.output += dt.output;
          u.messages += 1;
        };
        const running = s.agents.find((g) => !g.finished && g.model === e.model && e.model !== this.model);
        s.models ??= [];
        if (running) {
          running.models ??= [];
          add(running.models);
          running.tokens.input += dt.input;
          running.tokens.output += dt.output;
          add(s.models, true);
        } else {
          add(s.models);
          s.tokens.context = e.tokens.context;
        }
        s.tokens.input += dt.input;
        s.tokens.cached += dt.cached;
        s.tokens.output += dt.output;
        s.models.sort((a, b) => b.input + b.cached + b.output - (a.input + a.cached + a.output));
        break;
      }
      case "state":
        s.status = e.state === "idle" ? "idle" : "busy";
        if (e.state === "idle") s.current = null;
        else if (e.state === "working" && !s.current) s.current = "thinking…";
        break;
      case "exited":
        s.status = "ended";
        s.current = null;
        s.pid = null;
        s.agents.forEach((a: Agent) => ((a.finished = true), (a.current = null)));
        break;
      default:
        break;
    }
    if (e.type === "thinking_delta" || e.type === "text_delta") {
      if (!e.parent_tool_id && s.current && !/^Agent/.test(s.current)) s.current = "thinking…";
    } else {
      s.updated = this.vt ?? Date.now();
      this.host.changed();
    }
    s.model = this.model;
  }

  ensureSession() {
    if (this.session) return;
    const t = this.now();
    this.session = {
      provider: this.provider,
      id: this.sessionId,
      title: "",
      cwd: this.cwd,
      model: this.model,
      pid: 52000 + this.id,
      status: "busy",
      current: "thinking…",
      last_prompt: null,
      tokens: { input: 0, cached: 0, output: 0, context: this.ctx },
      activity: [],
      agents: [],
      updated: t,
      managed: null,
      chat: this.id,
      models: [],
    };
    this.host.link(this, this.session);
  }

  // ---------- commands ----------

  send(text: string) {
    if (!this.running) throw new Error("this chat has exited");
    const slash = /^\/(\S+)\s*(.*)$/s.exec(text.trim());
    if (slash) return this.slash(slash[1], slash[2]);
    if (this.busy) {
      // Like the CLI: messages typed mid-turn are queued for the next turn.
      this.queue.push(text);
      this.emit({ type: "notice", level: "info", text: "Queued: it will be sent when the current turn finishes.", needs_terminal: false });
      return;
    }
    void this.turn(text);
  }

  private slash(name: string, arg: string) {
    const known = (this.provider === "claude" ? CLAUDE_COMMANDS : CODEX_COMMANDS).some((c) => c.name === name);
    if (!known) {
      this.emit({ type: "notice", level: "warn", text: `Unknown command /${name}`, needs_terminal: false });
      return;
    }
    if (TUI_ONLY.has(name)) {
      this.emit({ type: "notice", level: "info", text: `/${name} opens an interactive screen that only works in the terminal.`, needs_terminal: true });
      return;
    }
    if (name === "compact") {
      const before = this.ctx;
      this.ctx = Math.round(this.ctx * 0.22);
      this.emit({ type: "notice", level: "info", text: `Compacted the conversation: context ${Math.round(before / 1000)}k → ${Math.round(this.ctx / 1000)}k tokens.`, needs_terminal: false });
      this.emit({ type: "usage", model: this.model, tokens: { ...this.total, context: this.ctx }, context_window: this.provider === "claude" ? 1_000_000 : null });
      return;
    }
    // Commands the CLI runs as a normal turn (/init, /review, /ship, /pr-comments, /help...).
    void this.turn(`/${name}${arg ? " " + arg : ""}`);
  }

  setModel(m: string) {
    this.model = m;
    this.ready();
    this.emit({ type: "notice", level: "info", text: `Model set to ${m}`, needs_terminal: false });
  }
  setMode(m: string) {
    this.mode = m;
    this.ready();
  }
  respond(requestId: string, allow: boolean, always: boolean, remember?: string | null) {
    if (this.asking?.requestId === requestId && !allow) return this.answer(requestId, null);
    if (!this.waiting || this.waiting.requestId !== requestId) return;
    const w = this.waiting;
    // Like the core: `always` alone only takes a this-chat-only option.
    const opt = allow ? (remember != null ? w.remember.find((o) => o.id === remember) : always && w.remember[0]?.scope === "chat" ? w.remember[0] : undefined) : undefined;
    if (remember != null && allow && !opt) throw new Error(`request ${requestId} has no remember option ${remember}`);
    this.waiting = null;
    if (opt?.mode) this.setMode(opt.mode);
    else if (opt) this.always.add(this.waitingTool);
    w.resolve(!allow ? "deny" : opt ? "always" : "allow");
  }
  private waitingTool = "";

  /** What the real CLIs offer to remember (see CHAT_SPEC "Remember options"). */
  private rememberFor(tool: string, input: unknown): RememberOption[] {
    const i = (input ?? {}) as Record<string, unknown>;
    const cmd = typeof i.command === "string" ? i.command : "";
    const first = cmd.split(/\s+/).slice(0, 2).join(" ");
    const o = (id: string, scope: RememberOption["scope"], label: string, detail: string, extra: Partial<RememberOption> = {}): RememberOption => ({ id, scope, label, detail, file: null, mode: null, rules: [], ...extra });
    if (this.provider === "claude") {
      if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool))
        return [o("0", "chat", "Allow all edits in this chat", "Switches this chat to Accept edits mode: later file edits, and file commands such as mkdir, mv or rm, run without asking. Nothing is saved.", { mode: "acceptEdits" })];
      if (tool === "Bash" && first) {
        const rule = `Bash(${first} *)`;
        return [
          o("0", "chat", `Allow \`${first}\` commands in this chat`, "For this chat only; nothing is saved.", { rules: [rule] }),
          o("1", "project", `Always allow \`${first}\` commands in this project`, "Saved to .claude/settings.local.json in this folder: applies to future sessions here too, including ones outside coool.", { file: ".claude/settings.local.json", rules: [rule] }),
        ];
      }
      return [];
    }
    if (tool === "shell" && first)
      return [o("0", "user", `Always allow commands starting with \`${first}\``, "Saved as a rule in ~/.codex/rules/default.rules: applies in every project and future Codex session, including ones outside coool.", { file: "~/.codex/rules/default.rules" })];
    if (tool === "apply_patch") return [o("0", "chat", "Allow more edits to these files in this chat", "Codex won't ask again for changes to the same files until the chat ends. Nothing is saved.")];
    return [];
  }
  answer(requestId: string, answers: string[][] | null) {
    if (!this.asking || this.asking.requestId !== requestId) throw new Error(`no pending question ${requestId}`);
    if (answers && !answers.some((a) => a.length)) throw new Error("answer at least one question, or decline");
    const q = this.asking;
    this.asking = null;
    q.resolve(answers);
  }
  interrupt() {
    if (!this.busy) return;
    this.gen++;
    if (this.asking) {
      const q = this.asking;
      this.asking = null;
      q.resolve(null);
    }
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve("deny");
    }
  }
  stop(code: number | null = null) {
    if (!this.running) return;
    this.gen++;
    this.waiting = null;
    this.busy = false;
    this.running = false;
    this.emit({ type: "exited", code });
  }

  // ---------- scripted turns ----------

  private async stream(type: "text_delta" | "thinking_delta", id: string, text: string, parent: string | null, gen: number) {
    let i = 0;
    while (i < text.length) {
      const n = 2 + Math.floor(Math.random() * 7);
      this.emit({ type, message_id: id, text: text.slice(i, i + n), parent_tool_id: parent });
      i += n;
      await this.sleep(18 + Math.random() * 38, gen);
    }
  }

  private async say(text: string, gen: number, opts: { parent?: string | null; think?: string; model?: string } = {}) {
    const id = `msg_${rid()}`;
    const parent = opts.parent ?? null;
    const model = opts.model ?? this.model;
    if (opts.think) {
      await this.stream("thinking_delta", id, opts.think, parent, gen);
      await this.sleep(500, gen);
    }
    await this.stream("text_delta", id, text, parent, gen);
    this.emit({ type: "assistant_message", id, text, model, parent_tool_id: parent });
    this.usage(model, text.length, !!parent);
  }

  /** Running totals, like the real driver: `usage.tokens` accumulates over the chat. */
  total = { input: 0, cached: 0, output: 0 };
  private usage(model: string, chars: number, sub: boolean) {
    const input = 900 + Math.floor(Math.random() * 2400);
    const output = Math.max(40, Math.round(chars / 3.6) + Math.floor(Math.random() * 300));
    const cached = sub ? 4_000 : Math.round(this.ctx * 0.86);
    const reqCtx = sub ? 6_000 + input : this.ctx + input + output;
    if (!sub) this.ctx += input + output;
    this.total = { input: this.total.input + input, cached: this.total.cached + cached, output: this.total.output + output };
    this.emit({
      type: "usage",
      model,
      tokens: { ...this.total, context: reqCtx },
      context_window: this.provider === "claude" ? 1_000_000 : null,
    });
  }

  private async tool(gen: number, name: string, summary: string, input: unknown, ms: number, output: string, opts: { parent?: string | null; ask?: boolean; fail?: boolean } = {}): Promise<boolean> {
    const id = `toolu_${rid()}`;
    const parent = opts.parent ?? null;
    this.emit({ type: "tool_start", id, name, summary, input, parent_tool_id: parent });
    if (opts.ask && this.needsAsk(name)) {
      const answer = await this.ask(name, summary, input, gen);
      if (gen !== this.gen) {
        this.emit({ type: "tool_end", id, ok: false, output: "Interrupted" });
        throw new Interrupted();
      }
      if (answer === "deny") {
        this.emit({ type: "tool_end", id, ok: false, output: "The user denied this tool call." });
        return false;
      }
    }
    try {
      await this.sleep(ms, gen);
    } catch (e) {
      this.emit({ type: "tool_end", id, ok: false, output: "Interrupted" });
      throw e;
    }
    this.emit({ type: "tool_end", id, ok: !opts.fail, output });
    return !opts.fail;
  }

  private needsAsk(name: string) {
    if (this.vt !== null) return false;
    if (this.always.has(name)) return false;
    if (this.mode === "bypassPermissions" || this.mode === "never") return false;
    if (this.mode === "acceptEdits" && /^(Write|Edit|MultiEdit)$/.test(name)) return false;
    return true;
  }

  private ask(tool: string, summary: string, input: unknown, gen: number): Promise<"allow" | "always" | "deny"> {
    const requestId = `perm_${rid()}`;
    const remember = this.rememberFor(tool, input);
    this.emit({ type: "permission_request", request_id: requestId, tool, summary, input, remember });
    this.setState("waiting_permission");
    this.waitingTool = tool;
    return new Promise((resolve) => {
      this.waiting = {
        requestId,
        remember,
        resolve: (a) => {
          if (gen === this.gen) this.setState("working");
          resolve(a);
        },
      };
    });
  }

  private files() {
    const name = this.cwd.split("/").pop() ?? "app";
    if (/notes/.test(name))
      return {
        a: "Sync/SyncEngine.swift",
        b: "Sync/OutboxQueue.swift",
        test: "xcodebuild test -scheme NotesTests",
        tests: "NotesTests",
        lang: "Swift",
        explain: "The queue lives in `OutboxQueue.swift`. The drain loop stops at the first failure and never retries, so one flaky request strands everything behind it. I'll add backoff and keep the order intact.",
        done: "All 48 tests pass. Mutations now retry with exponential backoff (capped at 60s) and still drain strictly in order.",
      };
    if (/atlas/.test(name))
      return {
        a: "src/routes/search.rs",
        b: "src/middleware/rate_limit.rs",
        test: "cargo test -p atlas-api",
        tests: "tests/",
        lang: "Rust",
        explain: "Budgets are read once at startup in `rate_limit.rs`, so a config reload never reaches the limiter. I'll move them behind an `ArcSwap` and re-read on reload.",
        done: "All 61 tests pass. Budgets now follow config reloads without a restart.",
      };
    if (/pixel/.test(name))
      return {
        a: "render/pipeline.rs",
        b: "render/bloom.rs",
        test: "cargo test --features gpu golden_",
        tests: "tests/golden",
        lang: "Rust",
        explain: "The bloom pass samples the HDR target before the resolve on Metal. I'll insert an explicit resolve in `bloom.rs` and keep the Vulkan path as is.",
        done: "Golden-image tests pass on all three backends.",
      };
    return {
      a: "app/src/components/Composer.tsx",
      b: "app/src/components/ChatComposer.tsx",
      test: "pnpm build",
      tests: "app/src",
      lang: "TypeScript",
      explain: "The composer is a plain `textarea` today. I'll add a `/` menu fed by the CLI's `slash_commands`, with fuzzy matching and **keyboard navigation**, and handle `/model` and `/context` in the app.",
      done: "`pnpm build` is clean. Typing `/` now opens the command menu; arrows move, Enter runs, Tab completes.",
    };
  }

  async turn(prompt: string) {
    this.ensureSession();
    this.busy = true;
    const gen = this.gen;
    this.turnStart = this.now();
    this.emit({ type: "user_message", id: `u_${rid()}`, text: prompt });
    this.setState("working");
    let ok = true;
    try {
      await this.sleep(500, gen);
      await this.script(prompt, gen);
    } catch (e) {
      if (!(e instanceof Interrupted)) throw e;
      ok = false;
      if (!this.running) return;
      this.emit({ type: "notice", level: "warn", text: "Interrupted. Tell it what to do instead.", needs_terminal: false });
    } finally {
      if (this.running) {
        this.emit({ type: "turn_end", duration_ms: this.now() - this.turnStart, ok: ok && !this.failed });
        this.failed = false;
        this.setState("idle");
        this.busy = false;
        const next = this.queue.shift();
        if (next) setTimeout(() => this.running && this.send(next), 400);
      }
    }
  }
  failed = false;

  private async script(prompt: string, gen: number) {
    const p = prompt.toLowerCase();
    const f = this.files();
    const cwd = this.cwd.replace(/^\/Users\/[^/]+/, "~");

    if (/^(hi|hey|hello)\b|quick|\?$/.test(p) && !/^\//.test(p)) {
      await this.say(
        `Short answer: the outbox drains in order because each mutation carries a monotonically increasing \`seq\`, and the engine only acks a batch once the server confirms the highest one. If you want, I can add a test that kills the app mid-drain to prove it.`,
        gen,
        { think: "The user is asking a conceptual question. No tools needed; answer from what I read earlier." },
      );
      return;
    }
    if (/\b(ask|choose|which)\b/.test(p) && !p.startsWith("/")) {
      await this.say("Before I change anything, I need two decisions from you.", gen);
      const id = `toolu_${rid()}`;
      const questions: Question[] = [
        {
          id: "0",
          header: "Retries",
          question: "How should failed requests be retried?",
          options: [
            { label: "Exponential backoff", description: "1s, 2s, 4s… capped at 60s" },
            { label: "Fixed interval", description: "Every 5s until it succeeds" },
            { label: "Don't retry", description: "Surface the error right away" },
          ],
          multi_select: false,
          allow_other: true,
          secret: false,
        },
        {
          id: "1",
          header: "Tests",
          question: "Which tests should I add?",
          options: [
            { label: "Unit", description: "The queue in isolation" },
            { label: "Integration", description: "Against the fake server" },
            { label: "Offline", description: "Drop the connection mid-drain" },
          ],
          multi_select: true,
          allow_other: true,
          secret: false,
        },
      ];
      this.emit({ type: "tool_start", id, name: "AskUserQuestion", summary: questions[0].question, input: { questions }, parent_tool_id: null });
      const requestId = `perm_${rid()}`;
      this.emit({ type: "question", request_id: requestId, questions });
      this.setState("waiting_permission");
      const answers = await new Promise<string[][] | null>((resolve) => {
        this.asking = {
          requestId,
          resolve: (a) => {
            if (gen === this.gen) this.setState("working");
            resolve(a);
          },
        };
      });
      if (gen !== this.gen) {
        this.emit({ type: "tool_end", id, ok: false, output: "Interrupted" });
        throw new Interrupted();
      }
      if (!answers) {
        this.emit({ type: "tool_end", id, ok: false, output: "The user declined to answer." });
        await this.say("No problem. I'll go with exponential backoff and unit tests; say the word if you want something else.", gen);
        return;
      }
      const text = questions.map((q, i) => `"${q.question}"="${(answers[i] ?? []).join(", ")}"`).join(", ");
      this.emit({ type: "tool_end", id, ok: true, output: `Your questions have been answered: ${text}.` });
      await this.say(`Going with **${answers[0]?.join(", ") || "exponential backoff"}**, and I'll add ${answers[1]?.length ? answers[1].join(" + ").toLowerCase() : "unit"} tests.`, gen);
      return;
    }
    if (p.startsWith("/")) {
      const cmd = p.split(/\s/)[0];
      await this.tool(gen, "Bash", "git status --short", { command: "git status --short" }, 700, " M app/src/lib/chat.ts\n?? app/src/components/Chat.tsx");
      await this.say(`Ran \`${cmd}\`. Nothing blocking: two files changed, both covered by the existing build.`, gen);
      return;
    }

    const plan = this.mode === "plan";
    await this.say(`I'll start by reading how this works today, then make the change and run the ${f.lang} checks.`, gen, {
      think: `They want: "${prompt.slice(0, 80)}". First I need to see ${f.a} and how it's wired. Then decide whether this needs a new type or fits the existing one.`,
    });
    await this.tool(gen, "Read", `${cwd}/${f.a}`, { file_path: `${this.cwd}/${f.a}` }, 650, "214 lines");
    await this.tool(gen, "Grep", f.b.split("/").pop()!.replace(/\.\w+$/, ""), {}, 520, "12 matches in 4 files");

    // A subagent on a cheaper model, with its own nested steps.
    if (this.provider === "claude") {
      const agentId = `toolu_${rid()}`;
      const desc = "Survey test coverage for the change";
      const sub = "claude-haiku-5-5";
      this.agentModel.set(agentId, sub);
      this.emit({ type: "tool_start", id: agentId, name: "Task", summary: desc, input: { subagent_type: "Explore", description: desc }, parent_tool_id: null });
      try {
        await this.sleep(500, gen);
        await this.tool(gen, "Glob", `${f.tests}/**/*`, {}, 600, "9 files", { parent: agentId });
        await this.tool(gen, "Read", `${cwd}/${f.tests}`, {}, 700, "", { parent: agentId });
        await this.say("Coverage is thin here: only the happy path is tested.", gen, { parent: agentId, model: sub });
        await this.tool(gen, "Grep", "describe|#\\[test\\]|func test", {}, 500, "3 matches", { parent: agentId });
        await this.say("Found 3 tests near this code; none cover the failure path.", gen, { parent: agentId, model: sub });
      } catch (e) {
        this.emit({ type: "tool_end", id: agentId, ok: false, output: "Interrupted" });
        throw e;
      }
      this.emit({ type: "tool_end", id: agentId, ok: true, output: "3 tests touch the queue; none cover reconnect mid-drain." });
    }

    if (p.includes("crash")) {
      await this.sleep(600, gen);
      this.emit({ type: "notice", level: "error", text: "claude exited unexpectedly (code 1): Error: ENOMEM while reading transcript", needs_terminal: false });
      this.stop(1);
      throw new Interrupted();
    }

    await this.say(
      plan
        ? `Plan (no changes in plan mode):\n\n1. Add a \`retry\` field to each queued mutation.\n2. Back off exponentially in \`drain()\`, capped at 60s.\n3. Add a test that drops the connection mid-drain.`
        : f.explain,
      gen,
    );
    if (plan) return;

    await this.tool(gen, "Edit", `${cwd}/${f.b}`, { file_path: `${this.cwd}/${f.b}` }, 900, "Updated 3 hunks");

    if (/\berror\b/.test(p)) {
      await this.tool(gen, "Bash", f.test, { command: f.test }, 1800, "error: 2 tests failed\n  drain_retries_after_backoff ... FAILED", { fail: true });
      await this.sleep(600, gen);
      this.emit({ type: "notice", level: "error", text: "API Error: 529 overloaded_error. The model is temporarily overloaded; try again in a moment.", needs_terminal: false });
      this.failed = true;
      return;
    }

    const ran = await this.tool(gen, "Bash", f.test, { command: f.test, description: "Run the test suite" }, 2600, "Test Suite 'All tests' passed.\n  Executed 48 tests, with 0 failures in 6.214s", { ask: true });
    if (!ran) {
      await this.say(`Okay, I won't run \`${f.test}\`. The edit is in place; run the tests yourself when you're ready, or tell me what to run instead.`, gen);
      return;
    }
    await this.say(f.done, gen);
  }

  /** Seed history instantly (virtual time ending near `until`). Permissions auto-allow. */
  async seed(prompts: string[], until: number) {
    this.vt = until - prompts.length * 75_000;
    for (const p of prompts) {
      await this.turn(p);
      this.vt += 40_000;
    }
    this.vt = null;
  }
}

/** Mock ModelUse rows for discovered (non-chat) sessions. */
export function mockModels(provider: Provider, t: Tokens, withAgents: boolean, main?: string): ModelUse[] {
  if (provider === "codex") return [{ model: main ?? "gpt-5.1-codex", input: t.input, cached: t.cached, output: t.output, messages: 40 }];
  const rows: ModelUse[] = [{ model: main ?? "claude-opus-5-5", input: Math.round(t.input * 0.82), cached: Math.round(t.cached * 0.85), output: Math.round(t.output * 0.8), messages: 36 }];
  if (withAgents) rows.push({ model: "claude-haiku-5-5", input: Math.round(t.input * 0.18), cached: Math.round(t.cached * 0.15), output: Math.round(t.output * 0.2), messages: 14, via_agent: true });
  return rows;
}
