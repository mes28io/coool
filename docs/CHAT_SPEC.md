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
    pub fn respond_permission_remember(&mut self, request_id: &str, remember: &str) -> Result<()>; // allow + apply one remember option
    pub fn steer(&mut self, text: &str, now: bool) -> Result<String>;   // a note for the running turn -> note id (see "Steering")
    pub fn cancel_steer(&mut self, note_id: &str) -> Result<()>;      // withdraw a note that is still queued
    pub fn stop(&mut self);                                   // end the process
    pub fn events_since(&self, seq: u64) -> (Vec<ChatEvent>, u64); // full history is kept (bounded), so a late UI can replay
    pub fn info(&self) -> ChatInfo;                           // provider, cwd, session_id, model, state, running
}
```

`Hub::refresh` links a chat to its discovered `Session` the way it links PTYs (new additive field `Session.chat: Option<usize>`), so the sidebar shows one row per chat, not two. "Open in terminal" links the new PTY to the chat's session id at once, and an ended chat yields its session to that PTY, so the row reads as one continuous session.

### Events (serde, `#[serde(tag = "type", rename_all = "snake_case")]`)

Every event also carries `seq: u64` and `ts: u64` (epoch ms). This JSON is exactly what the app receives.

| type | fields | meaning |
|---|---|---|
| `ready` | `session_id`, `model`, `cwd`, `permission_mode`, `slash_commands: [{name, description}]`, `models: [{id, label}]`, `agents: [string]`, `context_window: number \| null` | CLI started; drives autocomplete and pickers. May be re-sent when any of it changes. |
| `user_message` | `id`, `text`, `steer: bool`, `note_id: string \| null` | echo of what was sent; `steer: true` (with the note's id) for a steering note the agent took in, shown with its step rather than as a prompt |
| `text_delta` | `message_id`, `text`, `parent_tool_id: string \| null` | streamed assistant text |
| `thinking_delta` | `message_id`, `text`, `parent_tool_id` | streamed reasoning, when the provider exposes it |
| `assistant_message` | `id`, `text`, `model`, `parent_tool_id` | a completed text block (authoritative; replaces deltas) |
| `tool_start` | `id`, `name`, `summary`, `input` (json), `parent_tool_id` | `parent_tool_id` set means it belongs to a subagent launched by that tool call |
| `tool_end` | `id`, `ok: bool`, `output: string` (truncated to ~4k) | |
| `permission_request` | `request_id`, `tool`, `summary`, `input`, `remember: [RememberOption]` | UI must answer with `respond_permission` / `respond_permission_remember`; see "Remember options" |
| `usage` | `model`, `tokens: {input, cached, output, context}`, `context_window: number \| null` | after each model response |
| `state` | `state: "idle" \| "working" \| "waiting_permission"` | |
| `turn_end` | `duration_ms`, `ok: bool` | |
| `notice` | `level: "info" \| "warn" \| "error"`, `text`, `needs_terminal: bool` | CLI output with no better home, errors, and "this command only works in the terminal" |
| `exited` | `code: number \| null` | process ended |
| `question` | `request_id`, `questions: [Question]` | the agent asks the person something; see "Questions" |
| `steer` | `note_id`, `text`, `state: "queued" \| "picked_up" \| "interrupted" \| "unused" \| "cancelled"`, `tool_id: string \| null` | a steering note changed state; see "Steering" |
| `commands` | `commands: [{name, description, argument_hint, aliases, kind}]` | the slash commands with `kind`: `command` (runs in the chat), `skill` (sent to the model) or `terminal` (TUI only). Sent right after `ready` whenever it changes; `ready.slash_commands` stays as it was |

### Remember options ("don't ask again")

coool never invents a rule: what can be remembered is exactly what the CLI offers for that request, put into plain words. `permission_request.remember` lists them, this-chat-only ones first; empty means nothing can be remembered (the UI shows no such action).

```ts
RememberOption = { id: string,            // pass to respond_permission_remember
                   label: string,         // button text: "Allow all edits in this chat", "Always allow `npm test` commands in this project"
                   detail: string,        // what changes and where it is kept
                   scope: "chat" | "project" | "user",   // chat: nothing saved; project/user: written to `file`
                   file: string | null,   // ".claude/settings.local.json" (folder-relative), "~/.codex/rules/default.rules", ...
                   mode: string | null,   // set when it switches the chat's permission mode
                   rules: string[] }      // the CLI's own rule syntax, e.g. "Bash(npm test *)"
```

- **Claude** (`can_use_tool.permission_suggestions`, observed with Claude Code 2.1.325 in a throwaway folder): Write -> `setMode acceptEdits` for the session; Bash `npm test` -> `addRules Bash(npm test *)` to `localSettings`; a compound command -> one rule per part, together; Read outside the folder -> two session rules (the path and its realpath); WebFetch -> `addRules WebFetch(domain:…)` to `localSettings`. Entries with the same destination become one option (they are applied together, as in the CLI's own prompt). Destinations: `session`/`cliArg` = chat, `localSettings` = `.claude/settings.local.json`, `projectSettings` = `.claude/settings.json`, `userSettings` = `~/.claude/settings.json`. For every saved rule the driver adds a this-chat twin first (the same rules with destination `session`), so remembering never requires writing a file. Applying one sends its entries as `updatedPermissions`; a mode switch comes back as a new `ready.permission_mode`.
- **Codex** (`item/commandExecution/requestApproval.availableDecisions`, 0.145): `acceptForSession` = chat; `acceptWithExecpolicyAmendment` = a prefix rule saved to `$CODEX_HOME/rules/default.rules` (every project); `applyNetworkPolicyAmendment` (allow) = a saved network rule. In `untrusted` mode a command offers only the saved prefix rule. File changes (and the legacy requests) have the fixed set `acceptForSession` (+ the amendment when proposed).
- `respond_permission(id, true, true)` (the old "always") applies the first option only if it is this-chat-only, else allows once: a saved rule is applied only through `respond_permission_remember`, from a control that says so.
- UI: the card's second action is the list of options (label + detail; saved ones marked with their file); after one is applied, the timeline note says what changed ("this chat is now in Accept edits mode", "allowing `touch e.txt` in this chat", "… saved to .claude/settings.local.json") and a mode switch flashes the mode chip. ⇧⌘↵ applies the first option when it is this-chat-only.

### Requests of coool's own

coool itself can ask the person in a chat, through the same request UI (the device gate, APP_SPEC "Device permissions"): `ChatHandle::ask(tool, summary, input, remember) -> (request_id, Receiver<ExternalAnswer>)` pushes an ordinary `permission_request` (`request_id` starting `coool-`; for the device gate `input.coool_device = {device, kind, lead, body, note}`) and the chat reads `waiting_permission` until it is answered. The answer goes through the usual calls: `respond_permission(id, allow, always)` (`always` applies the first option only if it is this-chat-only) and `respond_permission_remember(id, option)` resolve it in coool (`Allow`, `Remember(option)`, `Deny`) and never reach the CLI. While such a request waits, the chat's state stays `waiting_permission` even when the CLI reports `working` (the CLI doesn't know about it); the CLI reporting `idle` (the turn ended, Stop, an exit) cancels it (`Cancelled`). `ChatHandle::withdraw(id, note)` takes back one nobody answered (a timeout), with an info `notice`. A remember option of coool's own has `scope: "project"` and `file: "coool (Settings > Devices)"`: saved in coool's data, not in a settings file.

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

### Steering

While a turn runs, the person can send a note. `Chat::steer(text, now)` returns a note id; everything after that arrives as `steer` events (the source of truth, replayed like all events):

- `queued`, right away. Then exactly one of:
- `picked_up`: the agent took the note in at a step boundary of the running turn. `tool_id` is the step after whose result it came in (the step running when the note was sent, or a later one). On an idle chat a note is simply the next prompt: `picked_up` with `tool_id: null`.
- `interrupted` (`now: true`): the current step was cut and the note started the next turn. `tool_id` is the step that was running when the interrupt went out (`null` if the model was writing text). If the turn ended on its own just before the interrupt landed, the note is `picked_up` with `tool_id: null` instead.
- `unused`: the turn ended (or was stopped) before the agent took the note in. It was **not** sent; the UI offers "Send now" (a normal `send`) / "Discard".
- `cancelled`: withdrawn with `cancel_steer` (additive to the original contract, so a replay does not bring back a discarded note).

A delivered note (`picked_up` / `interrupted`) is also echoed as `user_message` with `steer: true` and its `note_id`, right after its `steer` event. While a permission request or question is pending, notes wait until it is answered (a `now` note then acts like `now: false`: the step is the one waiting for the person, so nothing is cut). Stop (`interrupt`) leaves every undelivered note `unused`.

What "next step" truly means, per CLI (observed with Claude Code 2.1.325 and codex-cli 0.145, `sleep 3` steps, haiku / gpt-5.6-luna):

- **Claude Code.** A user line written to stdin mid-turn is queued by the CLI and taken into the *same* turn after the next tool result (`command_lifecycle` `started` arrives right after that `tool_result`; the model sees "The user sent a new message while you were working"; the transcript records a `queued_command` attachment and `queue-operation remove reason:absorbed_mid_turn`; the turn's `result.user_message_uuids` lists it and it gets no `result` of its own). A line still queued when the turn ends is run by the CLI as a turn of its own immediately after the `result`, too fast to withdraw. So coool holds a note itself until a main-thread step is in flight (a `tool_use` without its result) and only then writes it (with `uuid` = note id): it is taken in after that step. A turn that ends without another step leaves the held note `unused`. `cancel_steer` on a note the CLI holds sends `control_request` `cancel_async_message` (answer `{cancelled}` and a `cancelled` lifecycle frame); once taken in it fails. `now: true` sends `interrupt` and, once the cut turn's `result` arrived, writes the note as the next turn. (The CLI's own `priority: "now"` does not cut the running tool: it lets it finish and then restarts the turn, so it is not used.) Residual race: a note written while a very short step finishes can miss that step's boundary; if no further step follows, the CLI runs it as its own turn: reported `picked_up` with `tool_id: null`.
- **Codex.** `turn/steer {threadId, input, expectedTurnId, clientUserMessageId}` is accepted at once (`{turnId}`) and the input is taken in at the next model request, after the running command's output; delivery is the `item/started` `userMessage` whose `clientId` is the note id. A steer that arrives while the agent writes its final answer extends the turn (the agent answers it), so an accepted steer is always delivered. A rejected one (the turn just ended; `activeTurnNotSteerable` during review/compact) ends `unused` with a notice. Codex has **no way to withdraw** a steer: `cancel_steer` works only while coool still holds the note (a pending approval, or before the turn has an id) and fails afterwards. `now: true` sends `turn/interrupt` (the turn ends `interrupted` at once) and starts the next turn with the note (`turn/start` with `clientUserMessageId`).

Tauri: `chat_steer({id, text, now}) -> string` (note id), `chat_steer_cancel({id, noteId})`. Re-check with `cargo test -p coool-core --test chat_live live_claude_steer live_codex_steer -- --ignored` (fixtures `claude_steer.jsonl`, `codex_steer.jsonl`).

### Plans and task lists

Both arrive as ordinary `tool_start` / `tool_end` pairs.

- **Codex** plan tool: every `turn/plan/updated` becomes one pair named `update_plan` (id `plan-<turn>-<n>`), `input: {plan: [{step, status}], explanation?}` with `status` `pending | in_progress | completed` (Codex's `inProgress` mapped). The whole plan each time; there is no plan item in the turn, so nothing is shown twice. (Codex's `plan` thread item, a plan-mode proposal, is not shown.)
- **Claude** task list: Claude Code 2.1.325 offers `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` (deferred, loaded through `ToolSearch`), not `TodoWrite` (only with `CLAUDE_CODE_ENABLE_TASKS=0`), and only on older models (e.g. `claude-haiku-4-5`, the 4.x Sonnet/Opus) or with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`: on current models (Haiku 5.5, ...) there is no task tool at all. Observed: `TaskCreate {subject, description, activeForm}` -> result "Task #1 created successfully: …", `tool_use_result.task.id = "1"`; `TaskUpdate {taskId, status}` (`pending | in_progress | completed`, `deleted`) -> `tool_use_result.statusChange {from, to}`. The driver keeps the list and, after each successful call, adds a synthetic pair named `TodoWrite` (id `<call id>:todos`) with `input: {todos: [{content /* subject */, status, activeForm}], _synthetic: true}`, the whole current list. The raw `Task*` steps still flow.
- **Claude plan mode** (`--permission-mode plan`): when the plan is ready, `permission_request` for `ExitPlanMode` with `input: {plan /* markdown */, planFilePath /* ~/.claude/plans/<name>.md, written by the CLI */}` (the remember list is empty). Allow: the tool result says "User has approved your plan…", the CLI switches to `default` mode (a new `ready` with `permission_mode: "default"`, not `acceptEdits`) and the same turn goes on to work. Deny: the driver answers "did not approve this plan yet and wants to keep planning…" (the plain denial made the agent stop: "You declined the plan, so I've stopped there"); the mode stays `plan`, and the agent revises or asks. Fixtures: `claude_tasks.jsonl`, `claude_plan_mode.jsonl`, `codex_plan.jsonl`.

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

### Context map

Below the models, the Models panel shows what fills the context window: a squarified treemap of the latest request's context, tiles sized by tokens and tinted by kind, the free room hatched (drawn at most 45% of the area, so a 1M window doesn't shrink the parts to slivers; its card says so). Header: "Context", a Main / subagent picker (each subagent has its own context; picking one shows its map, from its own transcript), used / window, and the percent in the same tones as the context ring (warning from 75%, error at 100%). Tiles animate to their new size and position as the numbers change (none under Reduce motion); labels shrink, then hide, on small tiles; every tile has a hover / focus card (what it is, tokens, share of what is in use and of the window, how the number is known, the path for files). While the CLI compacts, the conversation and tool tiles breathe and a "Compacting the conversation…" line shows (chats: the `compacting` event below; other sessions: a `current` starting "Compacting"); afterwards a quiet "Compacted 19:40 · 187k → 54k" line with "Show before" / "Show now", which morphs the map between the two.

Tints (styles.css `--ctx-*`, light and dark): five hue families plus neutral, checked for colour-vision separation: setup (system prompt, tool definitions, reminders) neutral, memory and skills violet, files and images blue, prompts / replies / thinking rose, tool results and sub-agent results orange, a compaction summary green. Labels always carry identity; colour never does alone.

**Command:** `context_map({provider, sessionId, agentId?, cwd?}) -> ContextMap` (`crates/core/src/context.rs`):

```rust
pub struct ContextMap { pub total: u64, pub parts: Vec<Part>, pub compaction: Option<Compaction>, pub note: Option<String>, pub chars_per_token: Option<f64> }
pub struct Part { pub id: String, pub kind: PartKind, pub label: String, pub tokens: u64, pub count: u32, pub path: Option<String>, pub basis: Basis }
// kind: system | tools | memory | skills | file | chat | thinking | tool | agent | image | summary | other
// basis: calibrated | estimated | remainder
pub struct Compaction { pub before: u64, pub after: u64, pub at: Option<u64>, pub auto: bool, pub before_parts: Vec<Part> }
```

Cost: the map is computed only for the transcript whose panel is open, asked for again when the session's context changes (coalesced to one call per ~400ms). The backend keeps the last four asked-for transcripts warm and reads each incrementally from where it stopped; the first read of a transcript byte-scans it for compaction boundaries (no JSON parsing) and parses only from the second-to-last boundary on (one segment for the map, one for its "before"). It never runs in the session refresh: the loader's cheap scan / full load are untouched. On this machine's largest transcripts (150-300 MB) the first read takes 60-120 ms, later ones only the appended bytes.

**Where the numbers come from.** No CLI reports a breakdown, only each request's size. The map divides exactly that size, never invents another:

- **Total**: the latest request's context, the same figure as `Tokens.context` (Claude: the assistant record's `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, once per message id; Codex: `token_count.last_token_usage.input_tokens`). The parts always sum to it exactly (largest-remainder rounding).
- **Per-step calibration**: between two requests the context grows by `D = ctx[r] - ctx[r-1]`. The previous response's output (`output_tokens`, exact) is split over that response's blocks (text, tool calls, thinking) by estimated size; thinking the transcript leaves out (Claude's display-omitted thinking, Codex's encrypted reasoning) takes what the logged blocks don't explain. The rest, `D - output`, is what came in on the input side (tool results, prompts, attachments) and is split over those items by estimated size. Basis: `calibrated`.
- **Estimated size**: text length divided by a characters-per-token ratio: prose (memory, skills, prompts, summaries, system prompt) 3.8, tool schemas 3.2, tool output and files the transcript's own ratio, learned from steps that hold only tool output (characters / real tokens, typically 2.3-3.3; 3.0 until learned). Images count ~w×h/750 tokens (PNG size read from the header; else 1,600). Within a calibrated step these only set proportions.
- **Steps that don't add up**: if the input side grew far more than its text explains (under 1.2 characters per token), the items keep their estimate and the rest is **"Not in the transcript"** (reminders, hook output the CLI injected without logging). If the context shrank (the CLI cleared old thinking or tool results), the new items keep their estimate and the difference comes off thinking first, then tool results, then the rest. Basis: `estimated`.
- **The first request of a segment** (the session, or since the latest compaction) has nothing to diff against. What the transcript logged before it (the first prompt; Claude Code's attachments: CLAUDE.md `instructions`, `skill_listing`, `invoked_skills`, tool / MCP deltas, `@`-mentioned files; a compaction summary; Codex's developer messages, AGENTS.md, `additional_tools`, a compaction's replacement history) plus the evidence of what it never logs is sized by length: the system prompt and the non-deferred tool list when Claude Code logs them (`api-request-shape`, `prompt_snapshot`) or Codex's `session_meta.base_instructions`; the CLAUDE.md files on disk (user, and each folder from the session's up to home) when the transcript logs no memory. If those add up to more than the first request, all shrink alike. What they don't explain is the **remainder**: "System and tools" when there is no evidence, else "Other system context" (basis `remainder`). Logged items and evidence here are `estimated`.
- **Attribution**: each tool call and its result go to one part: `Read` / `Write` / `Edit` / `NotebookEdit` / Codex `apply_patch` to the file's path (and a shell command that is only `cat` / `sed -n` / `head` / `tail` / `nl` of one file); `Grep` / `Glob` to Searches; `Bash` / Codex `exec` to Test runs when the command runs tests (cargo test, pnpm test, pytest, vitest, jest...; not `test -f`), else Shell; `mcp__<server>__*` to "MCP · server"; `Agent` / `Task` / Codex agent tools to Sub-agents; `WebFetch` / `WebSearch` to Web; `ToolSearch` to Tool definitions; `Skill` to Skills; others to Other tools. `count` is the number of calls ("Test runs ×20"). Files: the six largest on their own, the rest merged into "N other files". Prompts and replies are Conversation; thinking is Thinking; `isMeta` / system-reminder text is Reminders.
- **Compaction**: Claude Code writes a `system` record with `subtype: "compact_boundary"` (`compactMetadata.trigger`, `preTokens`, `postTokens`, `preservedMessages.uuids`) and then the summary as a `user` record with `isCompactSummary: true`; Codex writes a `compacted` record whose `replacement_history` is the new history (its summary an encrypted `compaction` item). Only what follows the latest boundary counts; preserved messages (Claude) are counted again from their remembered sizes. `before` / `after` are Claude's `preTokens` / `postTokens` (Codex: the last request before, the first after); `before_parts` is the map just before. Until the first request after a compaction, the map stays the last one before it (the session's context figure hasn't moved either) with a note. Live chats also emit `ChatEvent` `{type: "compacting", active}` (Claude stream-json `system/status` `"compacting"` until the boundary; Codex `contextCompaction` item started / completed).
- **Codex**: the same where the rollout allows (it logs every input and output item; outputs and the call's result come before their `token_count`, so a result whose call is still uncounted goes to the next step). A rollout without per-request usage gets only its total and the note "This rollout reports no per-request usage, so only the total is known."

Checking it: `cargo run --release -p coool-core --example context_print -- [--kinds] <claude|codex> <transcript>...` prints a map and whether its total equals what the session list shows.

## App behaviour

- **New session** opens a chat, not a terminal. Resuming an ended session opens a chat too. "Open in terminal" is a secondary action on any coool-run session.
- **Session view for a chat:** the Activity timeline rendered from chat events (live, streamed), not from the transcript poll. Text streams with a caret; tool calls form the animated step list; subagent work nests under its launching step; permission requests appear as an inline approval card (Allow once / Deny, and the CLI's remember options spelled out; see "Remember options") and the session shows "Needs you" everywhere (sidebar, tab, Mission control).
- **Composer:** multi-line; Enter sends; `/` opens the command menu (fuzzy, keyboard-driven, descriptions shown); a model chip opens the model picker; a permission-mode chip; Stop while working (calls `interrupt`). Up-arrow recalls previous prompts.
- **Header / inspector:** model in use, context meter against the real `context_window` when known (fall back per model family, never a blanket 200k), tokens, and a "Models" breakdown listing each model used by the session and by each subagent.
- Titles: a session without a real title shows a short form of its prompt (first sentence, cut at a clause or word, ~56 characters), or the AI insight headline when insights are on; never the whole prompt.
- Sessions running outside coool are unchanged: read-only Activity from the transcript, with Stop and (once ended) Resume here.
- Read-only Activity text: each `session.activity[]` / `agent.activity[]` entry has `text` (one line, ~400 columns: lists, TUI, insights) and, for prompts, replies and errors whose one-line form loses anything, `full` (the whole text with line breaks, up to 24,000 characters). Render `full ?? text`. `shortened: true` means what is kept is not the whole message (cut at 24k, or an entry older than the newest 50 full texts of that timeline, which keeps only its one line): say so. Both fields are left out when empty/false. Messages typed mid-turn in Claude Code (`queued_command` attachments) appear as prompts.

## Tauri contract additions

Commands: `start_chat({opts}) -> number`, `chat_send({id, text})`, `chat_interrupt({id})`, `chat_steer({id, text, now}) -> string`, `chat_steer_cancel({id, noteId})`, `chat_set_model({id, model})`, `chat_set_permission_mode({id, mode})`, `chat_respond_permission({id, requestId, allow, always, remember?})` (`remember`: a remember option id; allows and applies it), `chat_respond_question({id, requestId, answers: string[][]})`, `chat_stop({id})`, `chat_replay({id}) -> {events, seq}`, `open_in_terminal({id}) -> number` (PTY id).

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
- `Insight { headline: String, needs_you: Option<String>, title: Option<String>, generated_ms: u64 }`: `headline` is one plain line saying what the agent is doing or did (a status line: never the session's title, it changes every turn); `title` is the model's candidate title for the whole session (see "Session titles"; the same request, no extra call); `needs_you` is set only when the session is blocked on the person (a question, an approval, an error it cannot pass, a loop), saying what it needs.
- A scheduler that keeps cost negligible: only live sessions, only when their activity changed since the last insight, at most one request per session per 45s, a global hourly cap, small model (`claude-haiku-5-5`), short input (the current title, last prompt, a spread of up to 8 of the session's prompts, last ~40 activity lines, status, current tool), structured JSON output.
- App: Settings > AI insights (the full-screen Settings page) to paste a key (stored in the Keychain), an on/off toggle, and the insight shown on Mission control cards and sidebar rows; "Needs you" gets its own badge and sorts first.

## Session titles

A session's title follows what it is about instead of staying its first prompt forever. Core module `crates/core/src/titles.rs`; the app resolves every session's title on each refresh and sends it as `Session.name = { title, source, previous }` (`source`: `manual | cli | ai | auto | first`; `previous`: earlier titles, newest first, at most 5). The UI reads it only through `displayTitle` (`app/src/lib/format.ts`), so tabs, the sidebar, the chat header, Mission control, Needs you, the palette and chat notifications (`notify.rs` gets the same title) always agree.

**Where a title comes from**, highest first:

1. **A name the person gave in coool**: double-click the title in a sidebar row or the chat header (or right-click it: **Rename…**). Enter saves, Esc cancels, leaving the field saves, an empty name goes back to automatic. It is pinned: never replaced automatically, not even by a CLI rename. Right-click > **Use automatic title** unpins it. Stored in coool's data folder (`~/Library/Application Support/coool/titles.json`, `rename_session({ provider, id, name: string | null })`), never under `~/.claude` or `~/.codex`, so it survives restarts.
2. **A rename by the CLI itself**: Claude Code `/rename` (a `custom-title` record), or a CLI title that differs from its first value (Claude `ai-title` records; Codex thread names in `session_index.jsonl`, latest entry wins). Taken as soon as it appears.
3. **The automatic title.** It starts as the CLI's own first title (Claude's `ai-title`, Codex's thread name), else a short form of the *first* prompt (no longer the latest one, which changed every turn).

**The change rule (stability first).** The automatic title is re-evaluated only at a **checkpoint**: once the session has at least 4 prompts, every 12 prompts since the last checkpoint, and at every context compaction. At a checkpoint coool takes a candidate and replaces the title only when the candidate is **clearly about something else**: it shares fewer than half the content words (lowercased, plural-stripped, prefix-matched, stopwords dropped) of the shorter of the two. "Living chat titles" -> "Living titles and rename" keeps the old title; "Claude Code fast mode credits" -> "coool: desktop app built with Tauri 2" changes. Either way the next checkpoint counts from there, so a title changes at most once per 12 prompts or compaction, never on an ordinary turn. Prompt counts come from the whole transcript (a head-and-tail preview of a big file never makes a checkpoint). The previous title stays in `previous`.

**Candidates.**
- *Insights on*: the model's `title` from the session's latest insight (the insights request already sent per session; the prompt asks for a 2–6 word noun phrase naming what the whole session builds or fixes, no "Chat about…", and to return the current title unchanged unless the subject moved). With insights on, a due checkpoint waits for the model's title rather than flip-flopping through the fallback (an ended session, which gets no more insights, uses the fallback).
- *Insights off* (nothing leaves the Mac): first, after a new compaction, the CLI's own summary of the session (the compaction's "Primary Request and Intent", its first sentence without parentheticals, "X is a Y" as "X: Y"; rules and bookkeeping lines are skipped); else the headline of the recent prompt that best represents the last 30 substantial prompts (its first line that says *what*, skipping repo/rules boilerplate, list items, Codex's injected `AGENTS.md` / file context), chosen by how often its words recur across that window, later prompts winning ties. A headline only counts when it reads like a title (starts with a capital, not a question, not small talk like "also…" / "i think…", not a pasted command or image tag, not cut mid-sentence) and at least two of its words recur in a fifth of the window; otherwise the title stays.

**Search and tooltips.** The ⌘K palette and the pane picker also match previous titles (a little below a current-title match; the row then says "was: …"). A sidebar row's and the header's tooltip say "was: …" for the last two titles.

**Cost and privacy.** No extra model calls: the title rides in the insights request (`required: headline, needs_you, title`). Without insights nothing is sent anywhere. The cheap scan stays cheap: the parsers only count prompts and compactions and keep the first CLI title and `/rename`; derivation runs once per checkpoint.

The browser mock (`lib/mockTitles.ts`) shows the "Wire Tauri events…" session titled "Claude Code fast mode credits" for its first 9 seconds, then maturing to its real subject, and "RawLog offset fixes" as a name the person gave; renames persist across reloads.

## Dev self-test (debug builds only)

`app/src-tauri/src/selftest.rs` + `app/src/selftest.ts`: with `COOOL_SELFTEST=<scenario|all>` and `COOOL_SELFTEST_DIR=<throwaway folder>` set on a **debug** build, the app runs scripted scenarios through the real client, store and DOM against the real backend and CLIs, writes a PASS/FAIL log, and saves screenshots of its own window (by window id, so nothing else on screen is captured). The sidebar lists only sessions under that folder. Release builds ignore the variables. Scenarios: `stream, approval, interrupt, model, slash, question, steer, markdown, resume, codex, insights, quit` (Claude Haiku, `gpt-5.6-luna`; tiny prompts). `steer` checks a note's whole life against the real CLI (queued strip, picked up under its step with no prompt bubble, `now` interrupt, withdraw, unused after Stop); `markdown` checks a real reply renders as strong/table/code. `stream` also checks the short title, the shortened header path, one-line chips and that the first chat knows its skills before its first turn ends; `approval` checks the remember options (Write -> "Allow all edits in this chat"; a Bash command -> this-chat rule first, the saved rule naming its file), applies the this-chat ones and checks the note, the mode chip and that nothing asks again; `slash` checks that "Open in terminal" never shows "Ended" or a separate "Starting…" row; `codex` checks that a saved rule names its file.

```sh
pnpm -C app build && cargo build -p coool-app --features tauri/custom-protocol
mkdir -p /tmp/coool-selftest/demo-project
COOOL_SELFTEST=all COOOL_SELFTEST_DIR=/tmp/coool-selftest/demo-project \
  COOOL_SELFTEST_SHOTS=app/docs/screenshots target/debug/coool
cat /tmp/coool-selftest/demo-project/selftest.log
```

The `quit` scenario ends the run by quitting the app; it logs the chat PIDs first (`PIDS …`) so a script can check none survive.

## Plan usage

How much of the person's Claude subscription limits and Codex (ChatGPT plan) limits are used, and when they reset. Core module `crates/core/src/usage.rs` (`UsageMonitor`); check it against the CLIs with `cargo run -q -p coool-core --example usage_print` (`-- --files` for the free sources only).

coool never reads credentials (no `~/.claude/.credentials*`, Keychain, `~/.codex/auth.json`) and never calls an account API itself. Every number comes from a surface of the official CLI, which does the authenticated request.

### Payload

`sessions` gains `usage: { claude: PlanUsage | null, codex: PlanUsage | null }` (same event, same "emit only when changed" rule; usage changes rarely, so no separate event). `null` means nothing is known yet. Command: `usage_refresh({ provider: "claude" | "codex" })` asks for a probe now (past back-off and focus); the result arrives with a later `sessions` payload.

```ts
type PlanUsage = {
  provider: "claude" | "codex";
  plan: string | null;            // "Max 5x", "Pro", "Plus", ...
  windows: UsageWindow[];         // every limit the CLI reports, in its order
  credits: UsageCredits | null;   // Claude "extra usage" / Codex credits
  reset_credits: number | null;   // Codex: free full resets (weekly + 5 h) available
  reset_credits_expire_ms: number | null; // Codex: soonest expiry among the available reset credits (null: unknown / none expire)
  fetched_ms: number;             // when the newest number here was read
  source: "claude.get_usage" | "claude.cache" | "claude.stream" | "codex.app_server" | "codex.rollout";
  stale: boolean;                 // fetched_ms older than 15 min
  error: string | null;           // last refresh failed, or "plan limits don't apply" (API key etc.)
};
type UsageWindow = {
  id: string;            // Claude: "session" | "weekly_all" | "weekly_scoped:<Model>" | <kind>; Codex: "<limit_id>:primary" | ":secondary" | ":spend"
  label: string;         // "Current session", "Weekly (all models)", "Weekly (Fable)", "5-hour", "Weekly"
  kind: string;          // "session" | "weekly" | "spend" | the CLI's own group for unknown meters
  used_percent: number | null;   // 0-100; null once the window has reset since the reading
  resets_ms: number | null;
  window_minutes: number | null; // 300, 10080
  model: string | null;          // per-model weekly limit (Claude)
  severity: string | null;       // Claude, as the CLI says it: "normal" | "warning" | "critical" (seen), "limited" (a rejected stream event)
  binding: boolean | null;       // Claude: the limit currently in force (is_active)
  as_of_ms: number;              // windows can come from different sources
  detail: string | null;         // "Reset since the last reading", "rate limit reached", "20.00 of 50.00"
};
type UsageCredits = { enabled, unlimited, balance /* Codex, decimal string */, used, limit, used_percent, currency, detail };
```

Real samples from this machine (`usage_print`, Claude Code 2.1.325, codex-cli 0.145.0):

```json
{"provider":"claude","plan":"Max 5x","source":"claude.get_usage","fetched_ms":1794672303865,"stale":false,"error":null,"reset_credits":null,"credits":{"balance":null,"currency":null,"detail":"Off","enabled":false,"limit":null,"unlimited":null,"used":null,"used_percent":null},
 "windows":[
  {"id":"session","label":"Current session","kind":"session","used_percent":91.0,"resets_ms":1794679199000,"window_minutes":300,"model":null,"severity":"critical","binding":true,"as_of_ms":1794672303865,"detail":null},
  {"id":"weekly_all","label":"Weekly (all models)","kind":"weekly","used_percent":24.0,"resets_ms":1794887999000,"window_minutes":10080,"model":null,"severity":"normal","binding":false,"as_of_ms":1794672303865,"detail":null},
  {"id":"weekly_scoped:Fable","label":"Weekly (Fable)","kind":"weekly","used_percent":10.0,"resets_ms":1794887999000,"window_minutes":10080,"model":"Fable","severity":"normal","binding":false,"as_of_ms":1794672303865,"detail":null}]}
{"provider":"codex","plan":"Plus","source":"codex.app_server","fetched_ms":1794672303327,"stale":false,"error":null,"reset_credits":3,"credits":{"balance":"0","currency":null,"detail":null,"enabled":false,"limit":null,"unlimited":false,"used":null,"used_percent":null},
 "windows":[
  {"id":"codex:primary","label":"5-hour","kind":"session","used_percent":0.0,"resets_ms":1794679069000,"window_minutes":300,"model":null,"severity":null,"binding":null,"as_of_ms":1794672303327,"detail":null},
  {"id":"codex:secondary","label":"Weekly","kind":"weekly","used_percent":5.0,"resets_ms":1794741407000,"window_minutes":10080,"model":null,"severity":null,"binding":null,"as_of_ms":1794672303327,"detail":null}]}
```

### Sources, freshness, cost

| Source | What | Fresh as of | Cost | Cadence |
|---|---|---|---|---|
| `claude.cache`: `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json`) key `cachedUsageUtilization`, plus `oauthAccount.organizationType` / `organizationRateLimitTier` for the plan name | The CLI's own copy of its plan-usage endpoint answer: `limits[]` (kind, percent, severity, resets_at, scope.model, is_active) and `extra_usage`. Ignored when its `accountUuid` is not the signed-in account (as the CLI does). Only those keys are deserialized. | Whenever the CLI last fetched usage (its `/usage` screen, or our probe) | Free (file read) | stat every 10 s, parse on change |
| `claude.get_usage`: hidden `claude -p --input-format stream-json --output-format stream-json --verbose --no-session-persistence --model haiku --strict-mcp-config --settings '{"disableAllHooks":true}'` in `$TMPDIR/coool-usage`, sent one `control_request` `{subtype:"get_usage", skip_behaviors:true}` and no prompt; stdin closed after the answer | Same data, live, plus `subscription_type` | Now | No model turn (`total_cost_usd: 0`, `model_usage: {}`); one request by the CLI to its usage endpoint; ~0.5 s; no transcript; refreshes the cache file too | When data is > 5 min old and the window is focused (or was, < 10 min ago); back-off 1, 2, 4 ... 30 min on failure |
| `claude.stream`: `rate_limit_event` from coool's own structured chats (`usage::observe_claude_rate_limit_event`) | `unifiedWindows.five_hour` / `seven_day` utilization (a 0-1 fraction there), resets, status | Each turn in a coool chat | Free (rides on the person's turns) | Merged per window when newer; no per-model or credit data |
| `codex.rollout`: newest `event_msg`/`token_count` with `rate_limits` in the 4 newest `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (last 512 KB of each), newest per `limit_id` | primary/secondary windows (`used_percent`, `window_minutes`, `resets_at`), credits, `plan_type` | Last Codex turn anywhere on this machine (TUI, exec, coool chats) | Free (file read) | every 10 s, re-read only when the file list/mtimes change |
| `codex.app_server`: short-lived `codex app-server` in `$TMPDIR/coool-usage`: `initialize`, `initialized`, `account/read` (plan), `account/rateLimits/read` | `rateLimitsByLimitId` (all metered buckets), credits, spend-control limit (`individualLimit`), `rateLimitResetCredits.availableCount` | Now | No turn, no rollout file; the CLI makes the account requests; ~1-2 s | Same rule as the Claude probe |

Self-test builds run the file sources only. `UsageMonitor::set_probes(false)` turns the probes off entirely.

### Reset credits (Codex)

Codex accounts can hold free "full reset" credits (`rateLimitResetCredits` in `account/rateLimits/read`: `availableCount`, plus `credits[]` with `status`, `expiresAt`, `title` such as "Full reset (Weekly + 5 hr)"). A credit is redeemed with the app-server request `account/rateLimitResetCredit/consume`, params `{ idempotencyKey: string, creditId?: string | null }` (no `creditId`: the backend picks the next available credit), answer `{ outcome: "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed" }`. Source: the installed CLI's own protocol, `codex app-server generate-ts` / `generate-json-schema` (0.145.0; in the stable, non-`--experimental` output: `v2/ConsumeAccountRateLimitResetCreditParams.ts`, `...Response.ts`, `...Outcome.ts`, `ClientRequest.ts`); the Codex TUI uses the same request.

- Command: `usage_reset_codex({ idempotencyKey }) -> "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed"`, or an error string (the CLI's message, e.g. "chatgpt authentication required for rate limit reset credits", a timeout). Core: `UsageMonitor::redeem_codex_reset` runs a short-lived `codex app-server` in `$TMPDIR/coool-usage` with `initialize`, `initialized`, then the consume request (id 2), and then forces a Codex probe so the new numbers and the remaining count arrive with a later `sessions` payload.
- Spending a credit can't be undone, so the UI only calls it after an explicit confirmation. One idempotency key (a UUID) per attempt; "Try again" after an error reuses it, so a retry of a request that did go through answers `already_redeemed` instead of spending a second credit. `nothingToReset` and `noCredit` spend nothing.
- Never exercised against the real account by tests: the request lines and every answer are unit-tested (`usage.rs`), the UI against the mock (`?usage=limited`, `?usage=noresets`, `?usage=resetfail`).

Claude has no user-redeemable reset: Claude Code's rate-limit options are extra usage, upgrade and waiting (checked in 2.1.327), so its windows only reset on their own.

### Limits of what can be known

- Claude's plan limits are a 5-hour session window, a weekly all-models window and per-model weekly windows (currently one for Fable), plus optional extra-usage credits; Codex's (per `limit_id`, normally `codex`) are a 5-hour and a weekly window plus credits, an optional spend-control limit and redeemable reset credits. Both report percentages only, never absolute message or token budgets.
- Usage on other devices and on claude.ai / chatgpt.com counts against the same limits but only shows up after the next probe (or Codex turn on this machine). The free sources alone go stale while the person is not using the CLIs; the probe is what keeps an idle reading current, and it only runs while coool is in use.
- A window whose reset time has passed is shown with `used_percent: null` until the next reading (the new value is unknown, not zero).
- Undocumented surfaces: `get_usage` is marked experimental in the CLI ("the response shape may change"), `cachedUsageUtilization` is an internal cache, and the endpoint object carries many placeholder keys. The parser prefers `limits[]` and falls back to the named windows (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `model_scoped`); unknown limit kinds are passed through with their own name. Claude `extra_usage` amounts are divided by `10^decimal_places` when that is given, which could not be checked on an account with extra usage on. Codex's app-server `account/*` methods are part of its generated schema (0.145) and the rollout `rate_limits` shape is the one the TUI writes; both are read case-insensitively (snake/camel).
- Verified with Claude Code 2.1.325 and codex-cli 0.145.0.
