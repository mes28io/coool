# coool chat sessions: spec v1

## Why

Today a session started inside coool is a PTY running the CLI's own TUI, shown in xterm.js. The owner does not want new chats to look like a terminal. A chat started in coool must look and behave like the designed Activity view: streamed replies, animated step lists, subagent cards, approval cards, a composer with slash commands and a model picker. Everything Claude Code and Codex can do (slash commands, model switching, context and status, subagents) must be reachable from that native UI. The terminal remains as an escape hatch, not the default.

## Approach

Drive the official CLIs through their structured, non-TUI modes. coool still never touches credentials; the CLI uses whatever login it has.

- **Claude Code:** `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` (plus `--resume <id>`, `--model`, `--permission-mode`, and the permission-prompt mechanism: see `claude --help` for `--permission-prompts` / `--permission-prompt-tool`). One long-lived process per chat; user turns are written to stdin as JSON lines; events arrive on stdout. The first `system`/`init` event lists the model, tools, slash commands and agents.
- **Codex:** prefer `codex app-server` (JSON-RPC over stdio; `codex app-server generate-ts` / `generate-json-schema` print the protocol). If that proves unworkable, fall back to `codex exec --json` per turn with `resume`, and say so.

Both are wrapped by one provider-neutral driver in `crates/core`, so frontends never see provider wire formats.

## Core API (`crates/core/src/chat/`)

```rust
pub struct ChatOptions {
    pub provider: Provider,
    pub cwd: String,
    pub resume: Option<String>,          // provider session id to continue
    pub model: Option<String>,
    pub permission_mode: Option<String>, // provider's own names, passed through
}

impl Hub {
    pub fn start_chat(&mut self, opts: ChatOptions) -> Result<usize>;   // chat id, stable for the process
    pub fn chat(&self, id: usize) -> Option<&Chat>;
    pub fn chat_mut(&mut self, id: usize) -> Option<&mut Chat>;
}

impl Chat {
    pub fn send(&mut self, text: &str) -> Result<()>;        // a prompt, or a slash command typed as text
    pub fn interrupt(&mut self) -> Result<()>;               // stop the current turn, keep the chat
    pub fn set_model(&mut self, model: &str) -> Result<()>;
    pub fn set_permission_mode(&mut self, mode: &str) -> Result<()>;
    pub fn respond_permission(&mut self, request_id: &str, allow: bool, always: bool) -> Result<()>;
    pub fn stop(&mut self);                                   // end the process
    pub fn events_since(&self, seq: u64) -> (Vec<ChatEvent>, u64); // full history is kept (bounded), so a late UI can replay
    pub fn info(&self) -> ChatInfo;                           // provider, cwd, session_id, model, state, running
}
```

`Hub::refresh` links a chat to its discovered `Session` the way it links PTYs (new additive field `Session.chat: Option<usize>`), so the sidebar shows one row per chat, not two.

### Events (serde, `#[serde(tag = "type", rename_all = "snake_case")]`)

Every event also carries `seq: u64` and `ts: u64` (epoch ms). This JSON is exactly what the app receives.

| type | fields | meaning |
|---|---|---|
| `ready` | `session_id`, `model`, `cwd`, `permission_mode`, `slash_commands: [{name, description}]`, `models: [{id, label}]`, `agents: [string]`, `context_window: number \| null` | CLI started; drives autocomplete and pickers. May be re-sent when any of it changes. |
| `user_message` | `id`, `text` | echo of what was sent |
| `text_delta` | `message_id`, `text`, `parent_tool_id: string \| null` | streamed assistant text |
| `thinking_delta` | `message_id`, `text`, `parent_tool_id` | streamed reasoning, when the provider exposes it |
| `assistant_message` | `id`, `text`, `model`, `parent_tool_id` | a completed text block (authoritative; replaces deltas) |
| `tool_start` | `id`, `name`, `summary`, `input` (json), `parent_tool_id` | `parent_tool_id` set means it belongs to a subagent launched by that tool call |
| `tool_end` | `id`, `ok: bool`, `output: string` (truncated to ~4k) | |
| `permission_request` | `request_id`, `tool`, `summary`, `input` | UI must answer with `respond_permission` |
| `usage` | `model`, `tokens: {input, cached, output, context}`, `context_window: number \| null` | after each model response |
| `state` | `state: "idle" \| "working" \| "waiting_permission"` | |
| `turn_end` | `duration_ms`, `ok: bool` | |
| `notice` | `level: "info" \| "warn" \| "error"`, `text`, `needs_terminal: bool` | CLI output with no better home, errors, and "this command only works in the terminal" |
| `exited` | `code: number \| null` | process ended |
| `question` | `request_id`, `questions: [Question]` | the agent asks the person something; see "Questions" |
| `commands` | `commands: [{name, description, argument_hint, aliases, kind}]` | the slash commands with `kind`: `command` (runs in the chat), `skill` (sent to the model) or `terminal` (TUI only). Sent right after `ready` whenever it changes; `ready.slash_commands` stays as it was |

### Questions

When the agent asks the person a question mid-task (Claude's `AskUserQuestion` tool; Codex's `item/tool/requestUserInput`), the driver emits `question` instead of `permission_request`, and the chat state is `waiting_permission` until it is answered:

```ts
Question = { id: string, header: string, question: string,
             options: [{label, description}],   // empty: free text only
             multi_select: bool, allow_other: bool /* a typed answer is accepted */, secret: bool }
```

- Answer: `Chat::respond_question(request_id, answers: &[Vec<String>])`: one list per question, in order, holding the picked option labels and/or the typed text. At least one question must have an answer.
- Decline: `respond_permission(request_id, false, false)`.
- Claude wire format (observed with Claude Code 2.1.325): the question arrives as `can_use_tool` for `AskUserQuestion`; the answer is `{"behavior":"allow","updatedInput":{...input, "answers": {"<question text>": "<answer>"}}}`, where several picks are joined with `", "` and a typed answer is passed as is. The model then sees `"<question>"="<answer>"`. A decline is `{"behavior":"deny","message":"The user declined to answer."}`.
- Codex wire format (`codex app-server generate-ts`, experimental in 0.145): the response is `{"answers": {"<question id>": {"answers": [..]}}}`; a decline is an empty `answers` map.
- The UI shows a question card in the timeline (same design language as the approval card), the session counts as "Needs you", and the tool step for the question itself is not listed separately.

### Slash commands

The composer offers `ready.slash_commands` as autocomplete. A command is sent as plain text through `send`. What the structured mode executes shows up as normal events. For commands that have a native equivalent, the app handles them itself and never sends them: `/model` opens the model picker (`set_model`), `/clear` starts a fresh chat in the same folder, `/context`, `/status`, `/cost` and `/usage` open a native panel fed by `usage`, `ready` and the session's token data. For a command that only works in the interactive TUI (login, config screens and the like), the driver emits `notice` with `needs_terminal: true` and the UI offers "Open in terminal", which opens the same session in a PTY via resume.

## Models used (monitoring)

Additive fields, filled by the transcript adapters for every discovered session, so they work for sessions started anywhere:

```rust
pub struct ModelUse { pub model: String, pub input: u64, pub cached: u64, pub output: u64, pub messages: u64 }
// Session.models: Vec<ModelUse>   (most used first; includes models used by its subagents, flagged)
// Agent.model: String, Agent.models: Vec<ModelUse>
```

`ModelUse` gets `pub via_agent: bool` when aggregated up from subagents is needed; simplest correct shape wins. The UI shows, per session and per subagent, which models ran and how many tokens each took.

## App behaviour

- **New session** opens a chat, not a terminal. Resuming an ended session opens a chat too. "Open in terminal" is a secondary action on any coool-run session.
- **Session view for a chat:** the Activity timeline rendered from chat events (live, streamed), not from the transcript poll. Text streams with a caret; tool calls form the animated step list; subagent work nests under its launching step; permission requests appear as an inline approval card (Allow once / Always allow / Deny) and the session shows "Needs you" everywhere (sidebar, tab, Mission control).
- **Composer:** multi-line; Enter sends; `/` opens the command menu (fuzzy, keyboard-driven, descriptions shown); a model chip opens the model picker; a permission-mode chip; Stop while working (calls `interrupt`). Up-arrow recalls previous prompts.
- **Header / inspector:** model in use, context meter against the real `context_window` when known (fall back per model family, never a blanket 200k), tokens, and a "Models" breakdown listing each model used by the session and by each subagent.
- Sessions running outside coool are unchanged: read-only Activity from the transcript, with Stop and (once ended) Resume here.

## Tauri contract additions

Commands: `start_chat({opts}) -> number`, `chat_send({id, text})`, `chat_interrupt({id})`, `chat_set_model({id, model})`, `chat_set_permission_mode({id, mode})`, `chat_respond_permission({id, requestId, allow, always})`, `chat_respond_question({id, requestId, answers: string[][]})`, `chat_stop({id})`, `chat_replay({id}) -> {events, seq}`, `open_in_terminal({id}) -> number` (PTY id).

`chat_set_permission_mode` for Codex takes an approval policy (`untrusted`, `on-request`, `on-failure`, `never`) or a sandbox mode (`read-only`, `workspace-write`, `danger-full-access`); both apply from the next turn. `ready.permission_mode` reports the approval policy.

A prompt sent right after `start_chat` (before `ready`) is fine: Claude reads stdin in order after its `initialize`, Codex queues it until the thread exists. `user_message` may therefore precede `ready`.

Insights: `insights_status() -> {enabled, has_key, error}`, `insights_set_key({key})`, `insights_clear_key()`, `insights_set_enabled({enabled})` (persisted in the app's config dir, off by default). Sessions carry `insight: {headline, needs_you, generated_ms}` while insights are on.

`running_count()` and the quit confirmation (`confirm-quit`, payload: the count) include running chats; quitting stops chats and PTYs.

Events: `chat-event` `{ id: number, events: ChatEvent[] }` (batched, emitted when new events exist).

`sessions` payload gains `chats: [{id, provider, cwd, session_id, model, state, running, permission_mode, pid}]`.

Batches are pumped every ~16ms from a handle that never takes the Hub lock, so streamed text is live regardless of the 1s session refresh. The UI replays every chat in `sessions.chats` once (`chat_replay`) and rebuilds it from the replay plus any live events with a higher `seq`, so a reload loses nothing.

## AI insights (optional, off by default)

Uses the Anthropic API with a key the person supplies (never bundled, never the CLI's login). Core module `crates/core/src/insights.rs`:

- Key lookup order: env `COOOL_ANTHROPIC_API_KEY`, then the macOS Keychain item with service `coool-anthropic-api-key` (account `coool`). Helpers to save and delete the Keychain item. Never log or serialize the key. Saving writes the command to `/usr/bin/security -i` on stdin, so the key never appears in a process's argv, and reads it back to confirm (the item stays one `security` owns, so reads never raise a Keychain prompt for the unsigned app).
- `Insight { headline: String, needs_you: Option<String>, generated_ms: u64 }`: `headline` is one plain line saying what the agent is doing or did (also used as the title when a session has none); `needs_you` is set only when the session is blocked on the person (a question, an approval, an error it cannot pass, a loop), saying what it needs.
- A scheduler that keeps cost negligible: only live sessions, only when their activity changed since the last insight, at most one request per session per 45s, a global hourly cap, small model (`claude-haiku-5-5`), short input (title, last prompt, last ~40 activity lines, status, current tool), structured JSON output.
- App: a Settings sheet to paste a key (stored in the Keychain), an on/off toggle, and the insight shown on Mission control cards and sidebar rows; "Needs you" gets its own badge and sorts first.

## Dev self-test (debug builds only)

`app/src-tauri/src/selftest.rs` + `app/src/selftest.ts`: with `COOOL_SELFTEST=<scenario|all>` and `COOOL_SELFTEST_DIR=<throwaway folder>` set on a **debug** build, the app runs scripted scenarios through the real client, store and DOM against the real backend and CLIs, writes a PASS/FAIL log, and saves screenshots of its own window (by window id, so nothing else on screen is captured). The sidebar lists only sessions under that folder. Release builds ignore the variables. Scenarios: `stream, approval, interrupt, model, slash, question, resume, codex, insights, quit` (Claude Haiku, `gpt-5.6-luna`; tiny prompts).

```sh
pnpm -C app build && cargo build -p coool-app --features tauri/custom-protocol
mkdir -p /tmp/coool-selftest/demo-project
COOOL_SELFTEST=all COOOL_SELFTEST_DIR=/tmp/coool-selftest/demo-project \
  COOOL_SELFTEST_SHOTS=app/docs/screenshots target/debug/coool-app
cat /tmp/coool-selftest/demo-project/selftest.log
```

The `quit` scenario ends the run by quitting the app; it logs the chat PIDs first (`PIDS …`) so a script can check none survive.
