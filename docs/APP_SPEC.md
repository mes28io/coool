# coool desktop app: spec v1

coool is an open-source workspace for agentic coding (coool.sh). People bring their own Claude Code or Codex subscription: coool drives the official `claude` and `codex` CLIs and never touches credentials. The Rust core (`crates/core`) already discovers sessions, parses transcripts and subagents, and runs CLIs in PTYs. The TUI (`crates/tui`) is one frontend. This spec is the second: a desktop app that should feel like a better Cursor / Warp / Codex app, built for running many agents across many projects at once.

## Stack

- **Tauri 2** (Rust backend in `app/src-tauri`, a workspace member depending on `coool-core`).
- **React 19 + TypeScript + Vite**, **Tailwind CSS 4**, **Motion** (`motion/react`) for animation, **xterm.js** (`@xterm/xterm` + fit + webgl addons) for terminals. pnpm.
- No component kit that needs a paid license. Build our own components.

## Product shape

Three regions, all resizable, all animated:

1. **Sidebar: projects.** Sessions grouped by project (the session's `cwd`; label = folder name). Each project row shows a live count and a combined status dot. Under it, its sessions: status dot (working = animated, waiting = solid accent, ended = hollow), provider mark (claude / codex colour), title, one dim line with the current tool or "12m ago". Running subagents nest under their session. Ended sessions collapse behind a per-project "N earlier" disclosure. A "+" on each project starts a new session there; a global "New session" button sits at the top.
2. **Main: workspace.** Tabs across the top, one per open session, reorderable; a tab can be split right or down so two to four sessions are visible at once (this is the multitasking core; a simple recursive split layout is enough). With nothing open, the main area is **Mission control**: a responsive grid of cards for every live session across all projects, each card showing title, project, status, current tool with a live elapsed timer, context meter, and the last two activity lines. Clicking a card opens it.
3. **Session view.** Two modes with an animated segmented switch:
   - **Activity** (default for sessions not run by coool): the transcript as a designed timeline. User prompts are prominent. Assistant prose is readable body text. Consecutive tool calls group into a collapsible **step list** ("Ran 6 steps") where steps appear one by one; the active step shimmers and shows a live timer. Subagent launches render as a nested card with the subagent's own live steps. Errors are a quiet red row.
   - **Terminal** (default for sessions run by coool): the real CLI in xterm.js, pixel-correct, themed to match.
   - A slim header: title, project path, model, context meter (tokens.context against a 200k default scale), tokens in/out, and actions: Stop, Resume (ended sessions), Open in Terminal mode.
   - A **composer** docked at the bottom for sessions coool runs: multi-line, Enter sends, Shift+Enter newline. It writes to the PTY. For sessions running outside coool, the composer is replaced by a calm notice: "Running outside coool. Stop it and resume here to take control." with a Resume button once it is ended.

Global:

- **Command palette** (Cmd+K): jump to any session or project, new session, toggle theme, stop session.
- **Shortcuts:** Cmd+T new session, Cmd+W close tab, Cmd+1..9 switch tab, Cmd+\ split right, Cmd+Shift+\ split down, Cmd+Shift+L theme.
- **New session flow:** a small sheet: provider toggle (claude / codex), folder (native folder picker plus recent projects), optional first prompt. Launching opens the tab in Terminal mode.
- **Themes:** dark and light, following the system by default, with a manual toggle that persists. The switch cross-fades; nothing flashes.

## Look and motion

Aim: calm, dense, precise; the motion is what makes it feel alive. Reference points the owner gave: inspora.design (curated modern product UI) and affectUI's "AI answer" and "thinking state" components (steps appearing one by one, live timer, streamed text, citation-style chips). Take the spirit, write our own code.

- **Type:** Geist (UI) and Geist Mono (code, terminal, numbers), bundled locally, not fetched at runtime. 13px base UI, tabular numbers for timers and token counts.
- **Colour tokens** (CSS variables, both themes): dark bg `#0e1014`, panel `#14171e`, raised `#1a1e27`, border `#262b36`, text `#e4e6eb`, dim `#767c8c`, accent `#7cf0c5`, accent-2 `#b48cff`, busy `#ffcc66`, error `#ff6b7a`, claude `#e8956b`, codex `#8ab4ff`. Light bg `#fafaf7`, panel `#f0f0ea`, raised `#ffffff`, border `#d8d8d0`, text `#1b1d22`, dim `#6b7080`, accent `#0b8f6a`, accent-2 `#7a4fd6`, busy `#b7791f`, error `#c53030`, claude `#c2602c`, codex `#2f6fd6`. Same palette as the TUI so the two feel like one product.
- **Shape:** 10px radius on cards and inputs, 14px on sheets, hairline 1px borders, almost no shadows in dark, soft ones in light. Overlays (palette, sheets) use a light backdrop blur.
- **Motion rules:** springs for layout (tabs, splits, sidebar rows reordering as status changes: use layout animations so rows glide rather than jump), 150 to 220ms eases for hover and reveal, staggered entrance for step lists and Mission control cards, a shimmer sweep on "thinking" and on the active step, a soft pulse on working status dots, number tickers for token counts. New activity rows slide and fade in from below. Nothing blocks input; everything is interruptible. Honour `prefers-reduced-motion` by dropping to opacity-only.
- Empty and loading states are designed, not blank.

## Backend contract (Tauri)

State: one `Hub` behind a mutex, refreshed by a background thread about once a second.

Events (backend to frontend):

- `sessions`: `{ sessions: Session[], pending: number[] }` on every refresh that changed something. `Session` is the serde form of `coool_core::model::Session` (see `crates/core/src/model.rs`; `updated` is epoch ms, `managed` is the PTY id or null).
- `pty-output`: `{ id: number, data: string /* base64 */, offset: number }` streamed from `Managed.raw` (poll `RawLog::read_since` every ~16ms per live PTY, emit only when there are new bytes).
- `pty-exit`: `{ id: number }`.

Commands (frontend to backend):

- `list_sessions() -> { sessions, pending }`
- `spawn_session({ provider, cwd, args?, rows, cols }) -> number` (PTY id)
- `resume_session({ provider, sessionId, cwd, rows, cols }) -> number` (claude: `--resume <id>`; codex: `resume <id>`)
- `pty_write({ id, data })`, `pty_resize({ id, rows, cols })`, `pty_replay({ id }) -> { data /* base64 */, offset }` (everything buffered so far, for a terminal that mounts late)
- `send_prompt({ id, text })` (uses `Managed::send_prompt`)
- `stop_session({ managed?: number, pid?: number })` (SIGTERM for external pids)
- `pick_folder() -> string | null` (dialog plugin)

Quitting the app stops the sessions it runs (confirm first if any are running).

## Who started it

Every `Session` carries `origin`: `user` (the person, in a terminal, IDE, desktop or phone client), `coool` (a chat or terminal coool started, remembered across restarts in `<data dir>/coool/own-sessions.json`), or `automation` (started programmatically by another tool or agent). Rules, from the CLIs' own records: Claude `entrypoint` `sdk-*`, `github-action`, `mcp` are automation unless a user turn was typed by a human (`turnOrigin` / `origin.kind` `human`); every other or unknown value is `user`. Codex `originator` `coool` is coool's, `codex_exec` and `source` `exec` / `mcp` are automation, subagent rollouts are attached to their parent thread as agents. Classified by how a session started, never by its folder.

Automation is hidden by default everywhere (sidebar, Home, palette, needs-you, counts); Settings → "Show runs started by other tools" lists it, dimmed with an `auto` tag, and the sidebar ends with "N runs by other tools hidden · Show". A hidden run that is live and needs the person is listed anyway.

Child runs: an automation session started from inside another session (found by walking its parent pids up to a registered session, or from the owner session id in an agent scratch path, and remembered) has `parent`; it is listed nested under that session (live ones always, two recent ended ones, then "Show N more jobs"), never as a row or card of its own, and its "Needs you" surfaces on the parent. A parent waiting for the person while children run (`live_children`) or while the CLI reports background tasks (`background_tasks`, registry status `shell`: a flag, no count) is "Working in background": green dot, "2 jobs running", a "Background" pill in its header. `waiting_for` (registry status `waiting`) means the CLI is blocked on the person.

Sidebar cap: per project at most 5 rows at rest (every live chat, most urgent first, then the most recent ended ones); "Show N more" reveals 10 at a time, "Show less" returns to 5; the revealed amount lives for the app run only and resets when the project is collapsed or expanded. The open chat is always shown. Collapsed projects persist (localStorage) and show one dot per state inside (blue needs you, green working, yellow waiting; a count when more than one); clicking a blue summary opens the chat that needs the person.

## Engineering constraints

- The frontend must also run in a plain browser (`pnpm dev`) with a built-in mock data source when Tauri is absent: realistic sessions that change over time (statuses flipping, steps arriving, a fake terminal stream). This is how the UI gets developed and screenshot-tested without the shell, and it is the demo for coool.sh later.
- Keep state in one small store (Zustand or a reducer); events are the only source of truth for sessions.
- Lists must stay smooth with 50 sessions and 300 activity rows each (virtualise the timeline if needed).
- Terminal: one xterm instance per open managed session, kept alive when its tab is hidden; fit on resize and send `pty_resize`.
- macOS first (overlay title bar with traffic lights inset into the sidebar, draggable region), but nothing that prevents Linux/Windows later.

## Out of scope for v1

Diff review, the agent-hands MCP server (browser / simulator / desktop control), inline 3D output, cost estimates, auto-update, signing. Leave clean seams, build none of it.
