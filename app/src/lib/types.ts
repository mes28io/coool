// Serde form of coool_core::model (crates/core/src/model.rs).

export type Provider = "claude" | "codex";
export type Status = "busy" | "idle" | "ended";
export type ActivityKind = "prompt" | "text" | "tool" | "error" | "agent";

export interface Activity {
  ts: string; // HH:MM:SS local
  kind: ActivityKind;
  text: string;
}

export interface Tokens {
  input: number;
  cached: number;
  output: number;
  context: number;
}

/** CHAT_SPEC "Models used". Additive; the backend may not send it yet. */
export interface ModelUse {
  model: string;
  input: number;
  cached: number;
  output: number;
  messages: number;
  /** Aggregated up from a subagent (only on Session.models). */
  via_agent?: boolean;
}

export interface Agent {
  id: string;
  kind: string;
  description: string;
  finished: boolean;
  current: string | null;
  tokens: Tokens;
  activity: Activity[];
  model?: string;
  models?: ModelUse[];
}

/** CHAT_SPEC "AI insights". */
export interface Insight {
  headline: string;
  needs_you: string | null;
  generated_ms: number;
}

export interface Session {
  provider: Provider;
  id: string;
  title: string;
  cwd: string;
  model: string;
  pid: number | null;
  status: Status;
  current: string | null;
  last_prompt: string | null;
  tokens: Tokens;
  activity: Activity[];
  agents: Agent[];
  updated: number; // epoch ms
  managed: number | null;
  /**
   * false = only the cheap facts are known yet (provider, title, cwd, status,
   * pid, updated); activity, tokens, models and agents are still empty.
   * Missing means true (older backends).
   */
  loaded?: boolean;
  /** Chat id when coool drives this session through a chat (CHAT_SPEC). */
  chat?: number | null;
  models?: ModelUse[];
  insight?: Insight | null;
}

export interface PtyInfo {
  id: number;
  provider: Provider;
  cwd: string;
  running: boolean;
  started: number;
}

export type ChatRunState = "idle" | "working" | "waiting_permission";

/** One row of `sessions.chats` (CHAT_SPEC "Tauri contract additions"). */
export interface ChatInfo {
  id: number;
  provider: Provider;
  cwd: string;
  session_id: string | null;
  model: string | null;
  permission_mode?: string | null;
  state: ChatRunState;
  running: boolean;
  /** CLI process id (additive; real backend only). */
  pid?: number | null;
}

export interface Snapshot {
  sessions: Session[];
  pending: number[];
  /** true while the backend is still parsing transcripts in the background. Missing = false. */
  loading?: boolean;
  ptys?: PtyInfo[];
  chats?: ChatInfo[];
}

// ---------- chat events (CHAT_SPEC "Events"), exactly as the backend serializes them ----------

export interface SlashCommand {
  name: string;
  description: string;
}
export interface ModelOption {
  id: string;
  label: string;
}
/** Where a slash command runs (the `commands` event). */
export type CommandKind = "command" | "skill" | "terminal";
export interface CommandInfo {
  name: string;
  description: string;
  argument_hint: string;
  aliases: string[];
  kind: CommandKind;
}
export interface QuestionOption {
  label: string;
  description: string;
}
/** One question the agent asks (Claude's AskUserQuestion, Codex's request_user_input). */
export interface Question {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multi_select: boolean;
  allow_other: boolean;
  secret: boolean;
}
/** A "don't ask again" choice the CLI offers on a permission request. */
export interface RememberOption {
  id: string;
  /** Button text, e.g. "Allow all edits in this chat". */
  label: string;
  /** Exactly what changes and where it is kept. */
  detail: string;
  /** chat: this chat only; project / user: saved to `file`. */
  scope: "chat" | "project" | "user";
  file: string | null;
  /** Set when choosing it switches the chat's permission mode. */
  mode: string | null;
  rules: string[];
}
interface Ev {
  seq: number;
  ts: number;
}
export type ChatEvent = Ev &
  (
    | {
        type: "ready";
        session_id: string | null;
        model: string | null;
        cwd: string;
        permission_mode: string | null;
        slash_commands: SlashCommand[];
        models: ModelOption[];
        agents: string[];
        context_window: number | null;
      }
    | { type: "user_message"; id: string; text: string }
    | { type: "text_delta"; message_id: string; text: string; parent_tool_id: string | null }
    | { type: "thinking_delta"; message_id: string; text: string; parent_tool_id: string | null }
    | { type: "assistant_message"; id: string; text: string; model: string | null; parent_tool_id: string | null }
    | { type: "tool_start"; id: string; name: string; summary: string; input: unknown; parent_tool_id: string | null }
    | { type: "tool_end"; id: string; ok: boolean; output: string }
    | { type: "permission_request"; request_id: string; tool: string; summary: string; input: unknown; remember?: RememberOption[] }
    | { type: "usage"; model: string | null; tokens: Tokens; context_window: number | null }
    | { type: "state"; state: ChatRunState }
    | { type: "turn_end"; duration_ms: number; ok: boolean }
    | { type: "notice"; level: "info" | "warn" | "error"; text: string; needs_terminal: boolean }
    | { type: "exited"; code: number | null }
    | { type: "question"; request_id: string; questions: Question[] }
    | { type: "commands"; commands: CommandInfo[] }
  );

export interface ChatOptions {
  provider: Provider;
  cwd: string;
  resume?: string | null;
  model?: string | null;
  permission_mode?: string | null;
}

export interface InsightsStatus {
  enabled: boolean;
  has_key: boolean;
  /** Last API error (real backend only). */
  error?: string | null;
  /** UI-side: false when the backend has no insights commands yet. */
  available?: boolean;
}

export interface Environment {
  home: string;
  claude: string | null;
  codex: string | null;
}

export const sessionKey = (s: Pick<Session, "provider" | "id">) => `${s.provider}:${s.id}`;
