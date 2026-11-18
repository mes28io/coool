# affectUI: what to take for coool

Research from November 2026. It covers [affectUI's components](https://www.affectui.com/components), a library of React components for AI and agent products with 130 components. Several of them already inspired Mission control.

**How the site was read.** A real Claude Haiku 5.5 chat in coool walked the site in its own Browser panel, using the `browser_*` tools of `coool-device`. This was also a test of those tools on a real site.

- **Harness.** The self-test scenario is `inspo-<n>` in `app/src/selftest.ts`, research only and never part of `all`. It ran 12 batches (11 plus a re-check), each a fresh chat in a throwaway folder.
- **What the chat was asked.** It visited each page, took `browser_screenshot`s and replied in a fixed format: name, category, tagline, tier, preview, motion and tool notes.
- **Images.** The agent's own screenshots were extracted from the chat transcripts.
- **Window shots.** The harness took window screenshots whenever the agent took a screenshot, to check the presence cursor and the beam.

All images live in the scratchpad (`inspo-shots/`, not in git), and the tables below refer to them by file name:

- `agent-<slug>-<n>.jpg` is what the agent saw, 800 px wide. The last one for each page shows the filled preview.
- `real-inspo-*.png` are window shots of coool while it drove the page.

**Coverage.**

- 85 of the 130 component pages were visited in-app. That is every component in the Agents and Chat categories, every one that looked relevant to an agent-monitoring app, and samples from Inputs, Data display, Navigation, Feedback, Cards, Buttons and Text.
- The other 45 are generic primitives or SaaS pieces (date pickers, OTP, billing, rating…). They come from the index only. Their names came from the in-app index `observe`, cross-checked against one plain fetch of the index HTML, which is where the descriptions in the table come from.
- Only public pages were read. Nothing was signed into, no code tabs were opened and no Pro content was used. Cookie banners were declined. The ideas below are coool's own designs; no code or assets were taken.

**Cost.** 13 Haiku chats made 235 model calls, using 92.8k output tokens, 9.5M cache-read tokens and 0.54M cache-write tokens. That is about **$0.25** at list prices. The chats ran on the subscription.

---

## 1. Every component seen

Category and tier come from each page's breadcrumb and from whether it shows "Get Pro to install". Of the 85 visited, 13 are free:

- Badge, Breadcrumb, Button, Empty State, Hover Card, Icon Button and Kbd.
- Message Actions, Notification Stack, Segmented Control, Skeleton, Tag Input and Tree View.

All the agent components are Pro.

| # | Component | Category | What it is | Tier | Screenshot | Route |
|---|---|---|---|---|---|---|
| 1 | Agent Checkpoints | Agents | Rewindable run timeline; retries branch from a checkpoint | Pro | `agent-agent-checkpoints-2.jpg` | in-app |
| 2 | Agent Crew | Agents | Live tree of a lead agent and its sub-agent cards | Pro | `agent-agent-crew-2.jpg` | in-app |
| 3 | Agent Cursors | Agents | Named live pointers and edits from agents in a document | Pro | `agent-agent-cursors-2.jpg` | in-app |
| 4 | Agent Findings | Agents | Swarm progress rows with a feed of findings | Pro | `agent-agent-findings-2.jpg` | in-app |
| 5 | Agent Fleet | Agents | Side-by-side agent cards with expandable sub-agent trees | Pro | `agent-agent-fleet-2.jpg` | in-app |
| 6 | Agent Graph | Agents | Network of agents and tools with live call activity | Pro | `agent-agent-graph-2.jpg` | in-app |
| 7 | Agent Handoff | Agents | Task relay: what moves between agents and what is lost | Pro | `agent-agent-handoff-3.jpg` | in-app |
| 8 | Agent Inbox | Agents | Background agent tasks with filters and row actions | Pro | `agent-agent-inbox-2.jpg` | in-app |
| 9 | Agent Lanes | Agents | Live timeline, one lane per agent | Pro | `agent-agent-lanes-2.jpg` | in-app |
| 10 | Agent Ledger | Agents | Log of agent changes to systems, each with undo and impact | Pro | `agent-agent-ledger-2.jpg` | in-app |
| 11 | Agent Monitor | Agents | Single-agent card: current step, cost, approvals | Pro | `agent-agent-monitor-2.jpg` | in-app |
| 12 | Agent Plan | Agents | Editable step plan to review before an agent runs | Pro | `agent-agent-plan-2.jpg` | in-app |
| 13 | Agent Queue | Agents | Job queue with worker slots and backlog depth chart | Pro | `agent-agent-queue-2.jpg` | in-app |
| 14 | Agent Recap | Agents | Overnight activity chart and board of what needs attention | Pro | `agent-agent-recap-1.jpg` | in-app |
| 15 | Agent Sequence | Agents | Sequence diagram of messages in an agent run | Pro | `agent-agent-sequence-2.jpg` | in-app |
| 16 | Agent Steering | Agents | Queue a note for the next step or interrupt | Pro | `agent-agent-steering-1.jpg` | in-app |
| 17 | Agent Trail | Agents | Step trail with progress, timers and sub-steps | Pro | `agent-agent-trail-1.jpg` | in-app |
| 18 | Agent Tree | Agents | Orchestrator and sub-agent tree with cost roll-ups | Pro | `agent-agent-tree-1.jpg` | in-app |
| 19 | AI Answer | Chat | Streamed answer with source cards and feedback actions | Pro | `agent-ai-answer-1.jpg` | in-app |
| 20 | Approval Card | Agents | Approve / deny card with risk badge and countdown | Pro | `agent-approval-card-2.jpg` | in-app |
| 21 | Approval Gates | Agents | Stack of pending approval requests | Pro | `agent-approval-gates-1.jpg` | in-app |
| 22 | Autonomy Dial | Agents | Three-stop control for how independently an agent acts | Pro | `agent-autonomy-dial-1.jpg` | in-app |
| 23 | Avatar | – | User or agent image, initials, status dot, groups | – | – | index only |
| 24 | Away Summary | Agents | "While you were away" card for a chat thread | Pro | `agent-away-summary-1.jpg` | in-app |
| 25 | Badge | Data display | Status label with tones, dots, icons, counts | Free | `agent-badge-2.jpg` | in-app |
| 26 | Billing Schedule | – | Billing phase builder with live totals | – | – | index only |
| 27 | Breadcrumb | Navigation | Location trail with folded middle items | Free | `agent-breadcrumb-1.jpg` | in-app |
| 28 | Breakdown Chart | – | Stacked bar chart with pickers and a linked table | – | – | index only |
| 29 | Button | Buttons | Primary / secondary / ghost / destructive buttons | Free | `agent-button-2.jpg` | in-app |
| 30 | Card | – | Base card with header, content, footer, selection | – | – | index only |
| 31 | Change Summary | Data display | Metrics with coloured trend indicators | Pro | `agent-change-summary-1.jpg` | in-app |
| 32 | Chat Composer | Chat | Prompt input with model picker, voice, approvals | Pro | `agent-chat-composer-2.jpg` | in-app |
| 33 | Checkbox | – | Checkbox with labels, partial state, error | – | – | index only |
| 34 | Cited Answer | Chat | AI answer linked to highlighted sources | Pro | `agent-cited-answer-1.jpg` | in-app |
| 35 | Code Block | Text | Code display with copy, line numbers, highlighting | Pro | `agent-code-block-1.jpg` | in-app |
| 36 | Collaboration Stream | Agents | Feed of agent-to-agent messages, handoffs, questions | Pro | `agent-collaboration-stream-2.jpg` | in-app |
| 37 | Color Picker | – | Swatch button opening a colour card | – | – | index only |
| 38 | Combobox | Inputs | Searchable single / multi-select list | Pro | `agent-combobox-2.jpg` | in-app |
| 39 | Command Menu | Navigation | Search field to find and run actions | Pro | `agent-command-menu-1.jpg` | in-app |
| 40 | Comment Thread | – | Comment with replies and mentions | – | – | index only |
| 41 | Comments Panel | – | Comment feed with filters and resolve | – | – | index only |
| 42 | Commit Trail | Agents | Commit list with authors, change tags, merge folding | Pro | `agent-commit-trail-1.jpg` | in-app |
| 43 | Compact Breakdown | Data display | Total split into ranked parts, animated changes | Pro | `agent-compact-breakdown-2.jpg` | in-app |
| 44 | Conflict Radar | Agents | Where parallel agent branches overlap (file x agent grid) | Pro | `agent-conflict-radar-2.jpg` | in-app |
| 45 | Context Map | Agents | Treemap of what fills an agent's context window | Pro | `agent-context-map-2.jpg` | in-app |
| 46 | Context Menu | – | Right-click menu at the pointer | – | – | index only |
| 47 | Context Window | Agents | Grid of context usage with compaction | Pro | `agent-context-window-2.jpg` | in-app |
| 48 | Cost Waterfall | Agents | Cost and token steps of a run as a waterfall | Pro | `agent-cost-waterfall-2.jpg` | in-app |
| 49 | Data Table | – | Spreadsheet-style table with editing and sort | – | – | index only |
| 50 | Date Picker | – | Single-day calendar picker | – | – | index only |
| 51 | Date Range Picker | – | Range presets and dual calendars | – | – | index only |
| 52 | Decision Card | Agents | Agent question with numbered options above the composer | Pro | `agent-decision-card-2.jpg` | in-app |
| 53 | Decision Inbox | Feedback | Open decisions with quick two-option answers | Pro | `agent-decision-inbox-2.jpg` | in-app |
| 54 | Decision Tree | Agents | Tree of an agent's options with outcomes | Pro | `agent-decision-tree-1.jpg` | in-app |
| 55 | Delegate Board | Agents | Drag tasks onto agents to assign them | Pro | `agent-delegate-board-2.jpg` | in-app |
| 56 | Dialog | – | Modal window with focus handling | – | – | index only |
| 57 | Diff Timeline | Agents | Edit-by-edit diff of an agent's PR changes over time | Pro | `agent-diff-timeline-2.jpg` | in-app |
| 58 | Dropdown Menu | – | Menu of actions behind a trigger | – | – | index only |
| 59 | Dropzone | Inputs | File drop area with upload progress and retry | Pro | `agent-dropzone-2.jpg` | in-app |
| 60 | Email Draft | – | Agent-written email to review before sending | – | – | index only |
| 61 | Empty State | Feedback | Placeholder for lists or panels with nothing yet | Free | `agent-empty-state-2.jpg` | in-app |
| 62 | Experiment Card | – | A/B test summary with variant chart | – | – | index only |
| 63 | Fallback Chain | Agents | Flow diagram of a request trying fallback models | Pro | `agent-fallback-chain-2.jpg` | in-app |
| 64 | Fan-out Grid | Agents | Grid of parallel worker tasks with status and cost | Pro | `agent-fan-out-grid-2.jpg` | in-app |
| 65 | Filter Menu | – | Grouped filters with removable chips | – | – | index only |
| 66 | Flow Builder | – | Top-down automation builder with branches | – | – | index only |
| 67 | Form Field | – | Wrapper for labels, hints, errors, counts | – | – | index only |
| 68 | Hover Card | Data display | Preview card on hover or focus | Free | `agent-hover-card-2.jpg` | in-app |
| 69 | Icon Button | Buttons | Square icon-only button with tooltip | Free | `agent-icon-button-2.jpg` | in-app |
| 70 | Inline Diff | Agents | Inline accept / reject of AI prose edits | Pro | `agent-inline-diff-2.jpg` | in-app |
| 71 | Integration Picker | – | Service search with connection tiles | – | – | index only |
| 72 | Integration Settings | – | Settings card for a connected service | – | – | index only |
| 73 | Judge Bracket | Agents | Tournament view of an LLM judge picking the best answer | Pro | `agent-judge-bracket-2.jpg` | in-app |
| 74 | Kbd | Text | Keyboard shortcut chip | Free | `agent-kbd-1.jpg` | in-app |
| 75 | KPI Chart | – | Metric card with multi-line chart | – | – | index only |
| 76 | Memory Graph | Agents | Agent surrounded by its memories and tools | Pro | `agent-memory-graph-2.jpg` | in-app |
| 77 | Memory Panel | Agents | Editable grouped list of assistant memories | Pro | `agent-memory-panel-1.jpg` | in-app |
| 78 | Message Actions | Chat | Action bar under AI messages | Free | `agent-message-actions-2.jpg` | in-app |
| 79 | Model Picker | Chat | Model menu with speed / quality / cost bars | Pro | `agent-model-picker-2.jpg` | in-app |
| 80 | Model Usage | Data display | Usage breakdown by AI company and model | Pro | `agent-model-usage-3.jpg` | in-app |
| 81 | Notification Stack | Feedback | Stacked notice cards revealed on dismiss | Free | `agent-notification-stack-2.jpg` | in-app |
| 82 | Number Input | – | Numeric field with steppers and units | – | – | index only |
| 83 | OTP Input | – | Verification code field | – | – | index only |
| 84 | Pagination | – | Page navigation and rows-per-page | – | – | index only |
| 85 | Parallel Attempts | Agents | Competing attempts scored to pick a winner | Pro | `agent-parallel-attempts-2.jpg` | in-app |
| 86 | Permission Request | Agents | Request for one specific permission with time limits | Pro | `agent-permission-request-2.jpg` | in-app |
| 87 | Plan vs Actual | Agents | Planned steps against real progress | Pro | `agent-plan-vs-actual-2.jpg` | in-app |
| 88 | Popover | – | Small floating card on a trigger | – | – | index only |
| 89 | Profile Menu | – | Account card with menu | – | – | index only |
| 90 | Progress Tracker | – | Onboarding checklist with progress | – | – | index only |
| 91 | Project Card | Cards | Project summary with progress ring | Pro | `agent-project-card-2.jpg` | in-app |
| 92 | Prompt Library | Inputs | Saved prompt templates with fillable variables | Pro | `agent-prompt-library-1.jpg` | in-app |
| 93 | Rate Limit Planner | Agents | Schedules runs to stay under rate limits | Pro | `agent-rate-limit-planner-1.jpg` | in-app |
| 94 | Rating | – | Star or thumbs rating | – | – | index only |
| 95 | Reaction Bar | – | Like / comment / repost / share pill | – | – | index only |
| 96 | Reasoning Summary | Agents | Card breaking down an agent's time on one answer | Pro | `agent-reasoning-summary-1.jpg` | in-app |
| 97 | Resizable | – | Draggable split panes | – | – | index only |
| 98 | Review Center | Agents | Risk-sorted workspace for reviewing agent actions | Pro | `agent-review-center-1.jpg` | in-app |
| 99 | Root Cause Tree | Agents | Fault tree of why a run failed | Pro | `agent-root-cause-tree-1.jpg` | in-app |
| 100 | Run Controls | Agents | Composer controls to stop, resume, steer | Pro | `agent-run-controls-1.jpg` | in-app |
| 101 | Running Now | Agents | Status pill for background agent tasks | Pro | `agent-running-now-1.jpg` | in-app |
| 102 | Scheduled Runs | Agents | Agent tasks arranged into weekly usage sessions | Pro | `agent-scheduled-runs-1.jpg` | in-app |
| 103 | Scroll Area | – | Scroll container with a slim scrollbar | – | – | index only |
| 104 | Segmented Control | Navigation | Option switcher with a gliding indicator | Free | `agent-segmented-control-1.jpg` | in-app |
| 105 | Select | – | Single-option picker | – | – | index only |
| 106 | Separator | – | Divider line, optionally labelled | – | – | index only |
| 107 | Setup Guide | – | Onboarding panel with task groups | – | – | index only |
| 108 | Skeleton | Feedback | Loading placeholders with a sheen | Free | `agent-skeleton-2.jpg` | in-app |
| 109 | Smart Recommendation | Cards | Suggestion card with confidence and undo | Pro | `agent-smart-recommendation-1.jpg` | in-app |
| 110 | Spinner | – | Small loading arc | – | – | index only |
| 111 | Stat Card | Data display | Metric with change and optional chart | Pro | `agent-stat-card-1.jpg` | in-app |
| 112 | Stepper Form | – | Multi-step setup flow | – | – | index only |
| 113 | Switch | – | On/off toggle | – | – | index only |
| 114 | Tag Input | Inputs | Multiple values as chips | Free | `agent-tag-input-2.jpg` | in-app |
| 115 | Text Area | – | Multi-line input that grows | – | – | index only |
| 116 | Text Field | – | Single input with affixes, clear, count | – | – | index only |
| 117 | Thinking Loader | Chat | Small working pill for AI replies | Pro | `agent-thinking-loader-2.jpg` | in-app |
| 118 | Thinking State | Chat | AI working panel with timer and steps | Pro | `agent-thinking-state-1.jpg` | in-app |
| 119 | Time Picker | – | Time-of-day input | – | – | index only |
| 120 | Tips Panel | – | Grid of short tips with one action each | – | – | index only |
| 121 | Toaster | Feedback | Stacked toasts with promise states | Pro | `agent-toaster-2.jpg` | in-app |
| 122 | Toggle Group | – | Row of toggle buttons | – | – | index only |
| 123 | Tool Access Map | Agents | Agent surrounded by the tools it can reach | Pro | `agent-tool-access-map-3.jpg` | in-app |
| 124 | Tool Call Card | Agents | One-line tool call with expandable details | Pro | `agent-tool-call-card-2.jpg` | in-app |
| 125 | Tooltip | – | Label on hover or focus | – | – | index only |
| 126 | Trace Waterfall | Agents | Timeline of a run's time and cost | Pro | `agent-trace-waterfall-3.jpg` | in-app |
| 127 | Tree View | Data display | Nested list of folders / files | Free | `agent-tree-view-1.jpg` | in-app |
| 128 | Trend Chart | Data display | Line, area, bar or sparkline chart | Pro | `agent-trend-chart-2.jpg` | in-app |
| 129 | Usage Meter | Data display | Plan usage and credits meter with limit alerts | Pro | `agent-usage-meter-3.jpg` | in-app |
| 130 | Writing Assistant | – | AI chat card with suggestions and dictation | – | – | index only |

---

## 2. What would make coool better

Things that are already built or in progress are not re-proposed:

- The change ledger, fan-out grid, commit trail and inline edit review.
- The usage ring and pill, agent cursors and the beam, and the context treemap.
- Living titles, Settings, device-tool permissions and frosted chrome.

Where the site shows something these lack, it is noted under "Later".

Each idea below names the screen, the data that feeds it (checked against `lib/types.ts`, `lib/chat.ts`, `lib/mission.ts` and `store.ts`), what it improves, its size and its risks.

### Build next

| # | Idea | Where | Inspired by | Size |
|---|---|---|---|---|
| 1 | Readable tool rows for MCP and device tools | Chat timeline, step lists | Tool Call Card | S |
| 2 | While you were away | Chat timeline and Mission control | Away Summary, Agent Recap | M |
| 3 | Where the turn went: a breakdown bar under "Worked for" | Chat timeline | Reasoning Summary, Trace Waterfall | S–M |
| 4 | File overlap between live agents | Mission control's ledger and the chat's Changes tab | Conflict Radar | S–M |
| 5 | Sub-agent cards with context fill and their handoff | Jobs panel, the chat's subagent cards | Agent Crew, Agent Fleet | S |

#### 1. Readable tool rows for MCP and device tools (S)

**Why.** The window shots show the chat timeline at its worst whenever an agent uses an MCP server (`real-inspo-*-cursor.png`, `real-inspo-agent-crew-4-a.png`):

- Every row reads `mcp__coool-device__brows…`, cut off before the tool name.
- The group chip reads `mcp__coool-d`.
- The icon is the generic stack.

A person watching an agent drive the browser can't tell a navigate from a click. affectUI's Tool Call Card puts one quiet line per call: an icon, a verb phrase, a live timer and a spinner, with the group summed up.

**Data.** Each tool item (`ChatItem` kind `tool`) has these fields:

- `name` (Claude `mcp__<server>__<tool>`, Codex `<server>.<tool>`).
- `input`, `output`, `ts` and `endTs`.
- `ok`.

Everything needed is in the item.

**Behaviour.**

- **Parse the name.** Add `parseMcp(name) -> { server, tool } | null` (Claude `mcp__a__b`, Codex `a.b`), used by `toolIcon` (`components/icons.tsx`), `chipsFor`, `toolSummary` and `ToolStep` (`components/Chat.tsx`). The same goes for `Activity.tsx` for transcript sessions.
- **coool-device tools get their own phrases**, built from `input` and, after the call, the first line of `output`. Icons are `IGlobe`, `IPhone` and `IMac` by tool family.

  | Tool | Phrase |
  |---|---|
  | `browser_navigate` | Opened *host/path*, with the path trimmed from the middle |
  | `browser_click` | Clicked "*label*", taken from the result's first line, e.g. `clicked button "Decline"`; while running, "Clicking #12" |
  | `browser_type` | Typed into "*label*", with the text masked if the result says masked |
  | `browser_scroll` | Scrolled down |
  | `browser_screenshot` | Took a screenshot |
  | `browser_observe` | Read the page |
  | `browser_wait_for` | Waited for "*text*" / for the page to settle |
  | `browser_batch` | Did N steps on the page |
  | `tap` / `type` / `swipe` / `observe` | The iPhone equivalents |
  | `mac_*` | The Mac equivalents |
  | `pilot_run` | Already has its own row |

- **Other MCP servers** read `<server> · <tool in words>`, with underscores turned into spaces and the first letter capitalised, e.g. "github · Create pull request". They use the `IPlug` icon.
- **The step-group chip** says "Browser ×13" (or the server's name ×N) instead of the raw prefix.
- **States.** A running step shows the existing shimmer and live clock. A failed one shows the existing quiet red row with the error's first line. A timed-out `wait_for` reads "Waited 5 s, page kept changing" in neutral grey, since it isn't an error the person must act on.
- **Motion.** None new.

**Risk.** Third-party server names can be long, so clip the server name to 16 characters. The raw name stays in the row's tooltip and in the expanded details.

#### 2. While you were away (M)

**Why.** coool's core promise is many agents across many projects. When the person comes back to a chat that finished 3 turns, hit a failure and is waiting on a permission, today they must scroll and read. affectUI's Away Summary and Agent Recap give one card with the time gone and three counts (needs you, failed, done), each row with one action. "Got it" folds the card into a one-line divider.

**Data.**

- The "away" boundary is the person's last-seen mark per session. `store.ts` keeps `seen.m[sessionKey]`, the session's `updated` when it was last seen, persisted in `coool.seen`. Keep a sibling `seenAt` wall-clock map, written alongside in `markSeen`, so the card can say how long the person was gone.
- For a coool chat, the items with `ts` greater than that mark:
  - `turn` items: done, or `failed` (`ok`, `failed`, `durationMs`).
  - `permission` and `question` items with `answer === null`: needs you.
  - `exited` with a non-zero code.
- From `lib/mission.ts`, the `Change[]` of that session with `ts` greater than the mark: files edited, commits, pushes and PRs.
- For a transcript session (not run by coool) only status and changes have epoch timestamps. Show changes plus the current status, without per-turn rows.

**Where.**

- **(a) In the chat timeline** the card is inserted at the boundary, the first item after the mark, the first time the chat is opened with anything after it. It is never shown for less than 2 minutes away or with nothing new.
- **(b) In Mission control** one compact strip at the top lists the projects with unseen activity: "While you were away · 2h 14m — 2 need you · 1 failed · 5 done". Each segment jumps to the first matching session.

**Card layout.**

- **Header:** "While you were away · 2h 14m". On the right are three dot counts in the status colours: `--status-needs` for needs you, `--error` for failed and `--status-done` for done (affectUI uses blue for done; coool's meanings say green).
- **Rows:** at most 5, needs first, then failed, then done.
  - Needs-you rows: an icon, what is asked (the permission summary or the question), and **Allow / Deny** or **Answer**, reusing the existing permission and question handlers.
  - Failed rows: the turn's last error line and **Retry**, which resends the turn's prompt the way the checkpoint "retry" path does.
  - Done rows: "Finished *prompt's first line* · 4m · 3 files", and the row opens that turn.
  - "+N more" expands the rest.
- **Got it** (or opening any row) folds the card, 180 ms height and opacity, into a one-line divider: "Away 2h 14m · 5 done · 1 failed". The divider stays in the timeline for that visit.

**Motion.** The card fades and rises 6 px once on first show. The counts use `Ticker`. With reduced motion there is no rise.

**Risks.**

- `seen` moves the moment the chat is on screen, so the boundary must be captured before `markSeen` runs on open.
- Do not double-count with the Needs-you view: the card links to the same items.
- Keep the card out of the transcript copy and export.

#### 3. Where the turn went: a breakdown bar under "Worked for" (S–M)

**Why.** "Worked for 6m 12s" says nothing about why it took that long. affectUI's Reasoning Summary splits one answer's time into a segmented bar by kind of step. Its Trace Waterfall puts every call on a time axis with the slowest one marked. coool has all the timestamps for its own chats.

**Data** (coool chats only):

- Tool items carry `ts`, `endTs`, `name` and `parent` (a subagent's tools).
- `thinking` items carry `ts` and `endTs`.
- `permission` items carry `ts` and `answeredTs`. This is time **waiting for you**, the most useful segment of all.
- The `turn` item carries `ts` and `durationMs`.

**Kinds and colours.** Use neutral tints except where a status colour means something:

| Kind | Source | Colour |
|---|---|---|
| Thinking | thinking items | |
| Reading | Read, Grep, Glob, search | |
| Editing | Edit, Write, apply_patch | |
| Commands | Bash, shell | |
| Web and devices | Web*, `coool-device` tools | |
| Sub-agents | Task, agent tool items, by their span | |
| Waiting for you | permission and question items, `ts` → `answeredTs` | `--status-needs` at 60% |
| Writing | the remainder | |

**Behaviour.**

- A 4 px bar sits under the turn footer, as wide as the footer text column, with segments in proportion.
- Hovering a segment shows a small popover: "Commands · 2m 41s · 7 calls · slowest `pnpm test` 1m 58s".
- Clicking the footer expands a mini waterfall in a 10 px radius card, the same component as Activity's step list:
  - One row per tool call: icon, label (from idea 1), and a bar on a shared 0 → turn-length axis.
  - Subagent rows fold their children, as the step rail already does.
  - The slowest call is tagged "slowest" in `--status-needs-text`.
- While the turn runs, the bar grows live and the running segment carries the existing step sweep. Reduced motion shows a static bar.

**A catch found in this run.** When the model issues several tool calls in one message, the chat items share one `ts`, so `endTs - ts` of the later ones includes queueing. A `browser_screenshot` "took" 5 s because it waited behind a 5 s `wait_for`. Compute each call's start as `max(ts, previous call in the same message's endTs)`. Calls of one message are run in order by the MCP connection, and the CLI's message id is in the stream. Without this the waterfall lies.

**Risk.** Transcript sessions have no end times. Hide the bar there rather than guess.

#### 4. File overlap between live agents (S–M)

**Why.** coool exists to run many agents at once, often in one repo, and they collide on the same files. affectUI's Conflict Radar shows a file × agent grid with a line where two agents changed the same lines. coool doesn't have line ranges for transcript sessions, but it has file paths for every session, which is enough to warn early.

**Data.** `lib/mission.ts` `Change` has these fields:

- `session` (the session key), `kind` (edit, create, delete or move) and `object` (a repo-relative path).
- `ts`, and `added` / `removed` for chats.
- Sessions carry `cwd`, `project` and `status`.

The ledger already groups changes per project over a 6-hour window.

**Rule.** A file counts as an overlap when two or more distinct sessions changed the same `object` in the same project within the window, and at least one of them is live (busy, or idle and alive). Split by `cwd`:

- **Same working tree:** "both edit the same copy", a real clash.
- **Different worktrees** (agent worktrees under `.claude/`, `.codex/` or `.coool/worktrees/`): "will need a merge", softer.

**UI.**

- **Mission control ledger.** In each project's ledger card a pinned top row: an overlap icon (two offset squares, drawn in `icons.tsx` style) with "*src/lib/stripe.ts* · 2 agents" and the two provider marks with their session titles. The time gap reads "4m apart". The row uses `--status-needs` only for the same-tree case and neutral grey for the worktree case. Clicking it opens a small popover with each session's last edit of that file (time, +/−) and **Open** for each.
- **Sidebar.** Both session rows get a tiny overlap mark next to the status dot, with tooltip "Also edited by *other title*: stripe.ts".
- **Chat Changes tab** (`InfoPanel`): the same row at the top when the open chat is in an overlap.

**Motion.** The row slides in like other ledger rows. The marks don't animate.

**Risks.**

- Generated files (lockfiles, `dist/`, snapshots) create noise. Ignore paths that `.gitignore` ignores, and `*.lock` / `pnpm-lock.yaml` / `package-lock.json`.
- A rename shows as a move: compare both before and after.

#### 5. Sub-agent cards with context fill and their handoff (S)

**Why.** affectUI's Agent Crew and Agent Fleet give each sub-agent card two things coool's subagent cards lack:

- How full its context is: a thin bar with "32k / 200k".
- The last thing it was handed: "Lead: Find where empty carts crash".

Both answer "is this sub-agent healthy and what is it doing for whom".

**Data.**

- `Agent.tokens.total` is the subagent's latest context plus output, the same number coool already shows.
- `Agent.model`, with the window from `lib/models.ts` `contextWindow()`. Label it as an estimate when it is guessed by family, as the main context meter does.
- `Agent.description` is the Task description the lead wrote, the handoff. For chats, the Task tool item's `input.prompt` gives the first line of what was handed.

**UI** (Jobs panel `AgentsPanel.tsx` and the chat's nested subagent card):

- Under the card's title, a 2 px bar in `--status-running` while running and grey when finished, filled to the context share. Right-aligned "32k / 200k" in the meta style with tabular numbers.
- Above 80% the bar and number turn `--status-needs-text`.
- Below it, one dim line: "↳ from lead: *first line of the prompt*", clipped to one line, with the full prompt in the tooltip.

**Motion.** The bar width animates with `softSpring`, and the number uses `Ticker`.

**Risk.** Codex child jobs report no per-agent context: hide the bar there.

### Later

- **Agent lanes** (Agent Lanes). In Mission control, one lane per live session over the last 30 minutes: blocks per turn, coloured running, needs you, failed or done, growing into "now".
  - coool chats have the data: `turn` items plus permission waits.
  - Transcript sessions only have prompt times of day in `activity`, and the backend doesn't keep a status history.
  - Size M–L. Needs a small status-change log in the store.
- **Running-now pill** (Running Now). A quiet title-bar pill, "3 working · 1 needs you", visible from any tab and from Settings. It opens a popover of live sessions with the current step, a mini step count, and Open / Stop.
  - Data: `Snapshot` sessions' `status`, `current` and `waiting_for`.
  - The rail badge and sidebar already cover most of this, so value is moderate. Size S.
- **Hover card on session rows** (Hover Card). After a 500 ms rest on a sidebar or tab row, a card shows model, context ring, tokens this turn, current step, the last prompt's first line and live children. All the data is in `Session`. Size S.
- **Question cards: number keys and "Later"** (Decision Card).
  - Options numbered 1–5, with keys 1–5 answering while the card has focus.
  - "Later" folds the card to one line above the composer, so the person can keep reading.
  - Check `Chat.tsx`'s question card first. Size S.
- **Risk tag on permission cards** (Approval Card, Permission Request). A small tag from a fixed rule set:
  - Bash with `rm -rf`, `git push --force`, `git reset --hard`, `curl … | sh` or `sudo`.
  - Writes outside the chat's folder.
  - Network deploys.

  Only "Risky" is shown, never "safe". Size S. **Skip the countdown:** coool must never auto-deny.
- **Handoffs in the timeline** (Collaboration Stream, Agent Handoff). Render a Task call as "Lead → Researcher: *prompt first line*" and its result as "Researcher → Lead: *result first line*". The data is the Task tool item's input and output. Size S–M.
- **Diff over time in the ledger** (Diff Timeline). A sparkline of cumulative +/− per project over the window, from `Change.added` / `removed` / `ts` (chats only). Size S.
- **Fan-out grid:** add the "retrying" state and "~N s left" from the median finished-cell duration × the remaining cells. affectUI shows both. Size S.
- **Context: compaction markers** (Context Window). In the chat's Context tab sparkline (`usageHistory`), mark a point where context drops by more than 30% as "compacted". There is no compaction event today. Size S.
- **Permission-mode explainer** (Autonomy Dial). The mode chip's menu lists, per mode, what runs on its own and what asks: Read and Grep on their own, Edit asks, and so on. Size S.
- **What this agent can reach** (Tool Access Map). In Models or Status, the MCP servers the project's CLI config gives this session, from `prefs/connections.rs`, with the ones it actually called lit. Size M.

### Skipped, and why

- **No data behind them for a BYO-subscription app:**
  - Cost Waterfall, Model Usage (by AI company), Usage Meter credits, Billing Schedule and Rate Limit Planner.
  - coool has no per-turn dollar cost, and usage windows are percentages only.
  - The per-company split would be two bars, Claude and Codex.
- **coool doesn't do these things:** Fallback Chain, Judge Bracket, Parallel Attempts, Delegate Board, Scheduled Runs, Agent Queue, Flow Builder, Prompt Library (slash commands cover it), Memory Graph and Memory Panel, Root Cause Tree, Decision Tree, Email Draft and Experiment Card.
- **Already built or in progress:**
  - Agent Checkpoints (coool has per-turn checkpoints with branches), Agent Steering (the steer strip) and Agent Plan / Plan vs Actual (PlanCard has step durations).
  - Commit Trail, Fan-out Grid, Inline Diff, Agent Ledger (the change ledger) and Context Map / Context Window (the treemap in progress).
  - Agent Cursors, Thinking Loader and Thinking State (the thinking word and orbs), Run Controls (composer, Stop, steer), Usage Meter (rail ring and Settings) and Command Menu (⌘K).
  - Agent Inbox / Decision Inbox / Approval Gates (the Needs-you view).
- **Generic primitives** coool already has its own of (`primitives.tsx`): Badge, Kbd, Segmented Control, Button, Icon Button, Skeleton, Empty State, Tree View, Breadcrumb, Combobox, Tag Input, Toaster and Notification Stack.
- **Too far from coool's data:** Agent Graph, Agent Sequence, Agent Findings, Review Center and Smart Recommendation. Their live diagrams need structured agent-to-agent message data that only Task calls approximate. Revisit if handoffs (above) land.

---

## 3. How coool's browser did

**Totals.**

- 12 chats and about 330 `browser_*` calls (navigate 86, screenshot 146, wait_for 53, click 11, scroll 7, observe 1).
- **0 calls failed**, apart from one `wait_for` timeout after the fix below, which is the intended result.
- Every navigation, click and scroll landed. All 11 cookie-banner Decline clicks worked.

**Timings, measured from the chat's tool items.**

| Call | Median | p90 | Max | Notes |
|---|---|---|---|---|
| navigate | 670 ms | 1.0 s | 1.3 s | Load 290–1230 ms. Its own observe 2–56 ms |
| screenshot | 20–160 ms | – | 5 s | When run alone. The larger figures are queueing behind the call before it in the same message (see Build next #3) |
| wait_for idle | 35 ms | 5.0 s | 5.0 s | 7 of 53 hit the 5 s cap on live previews |
| click and scroll settle | – | – | 1.5 s | On a live page every action paid the full 1.5 s settle cap: click 1088 / 1522 ms, scroll 1511 / 1521 ms. On static pages 11–130 ms |

**Problems, in priority order.**

1. **Fixed here: names were empty on `content-visibility: auto` pages.**
   - **Symptom.** On the index (130 cards, 76,000 px tall) every card past the first screen was listed as `heading h3` or `link → /components/agent-trail` with no name.
   - **Cause.** The site sets `.card { content-visibility: auto }`. WebKit then skips rendering off-screen cards, and `innerText` returns "".
   - **Fix.** `textOf` in `web_agent.js` falls back to `textContent` when `innerText` is empty and `checkVisibility({contentVisibilityAuto: true})` says the element is skipped.
   - **Verified.** A unit test was added, and it fails without the fix. On the live re-run 58 of 58 listed headings had names, against 0 named off-screen before.
2. **Fixed here: the agent's own cursor was in its screenshots.** `browser_screenshot` captured coool's presence layer. Haiku then described "a Claude cursor overlay", and on the Agent Cursors page took coool's "Claude · Scrolling down" label for part of the site's demo (first run, `agent-shots` of batch 0).
   - **Fix.** The presence host is hidden (`visibility: hidden`) for the snapshot and shown again right after: a new `shot` op in `web_agent.js`, used around `snapshot_jpeg` in `web.rs`.
   - **Verified.** Unit test, and no cursor in any of the 146 later images (e.g. `agent-trace-waterfall-3.jpg` after a scroll).
   - **Cost.** The person sees the cursor blink off for the snapshot's 20–150 ms.
3. **Not fixed: navigate returns before a client-rendered page has rendered.**
   - **Symptom.** On 51 of 85 component pages the agent's first screenshot right after `browser_navigate` showed an empty preview frame. Several navigates reported "ready · scrolled 0 of 437 px · 6–9 elements", the app shell before React rendered the route. In batch 0 the agent scrolled to "fix" it.
   - **Cause.** The page is a Vite / React single-page app: the DOM goes quiet for 90 ms between the shell and the route's lazy chunk.
   - **Proposed fix** (in `settle_navigation`): after a navigation, require a longer quiet window (≈300 ms) for the first 3 s, and keep waiting while the element count or body text length is still growing between polls. Alternatively, wait for `document.fonts.ready` and two animation frames after the last mutation.
   - **Also.** The navigate result should say "content still arriving" when the page grew in the 300 ms after it returned.
4. **Fixed here: `wait_for idle` on a page that never goes quiet claimed success.**
   - **Symptom.** Live previews (ticking timers, counters) keep mutating the DOM, so `idle` ran its full 5 s and then answered "the page to settle after 5024 ms" as success.
   - **Fix.** It now returns "timed out after 5019 ms waiting for the page to settle: it keeps changing (live content or an animation); the page as it is now", with the page. Verified live in batch 11.
5. **Not fixed: every action on a live page pays the full 1.5 s settle.** The same churn makes each click or scroll on a dashboard-like page wait the cap, so agents driving any live UI (including coool-like apps) are slowed by about 1.4 s per action.
   - **Proposed fix.** Don't count mutations that only change the text of the same few nodes again and again, such as a clock or a counter (`characterData`, or a single text child replaced inside an element under about 40 characters), towards "not quiet". Or detect steady churn: when the same small set of nodes has changed in each of the last N windows, call it quiet.
6. **Not fixed: `observe` can't read the whole page's text.** With `all: true` and `text_max: 20000` the element list covered the page (cut at the default 250 elements, "694 more not listed"), but "Text in view" was still only the viewport's text.
   - **Proposed fix.** Make `all: true` also collect the whole page's text up to `text_max`, and default `max` to about 600 when `all` is set.
   - Haiku didn't re-run with a higher `max` even though the truncation line suggests it.
7. **Not fixed: the click highlight outlives its element.** After "Clicking Decline" the banner fades out, but the press ring and highlight box stay drawn where the button was (`real-inspo-3-cursor.png`). Hide the ring once the target is disconnected or invisible.
8. **Check, possibly fine: the beam looked like a thin static ring.** In every window shot the page area had a 1–2 px static blue outline instead of the travelling colourful beam. That is the spec's reduced-motion look, and Auto very likely chose reduced motion because the Mac was busy at launch with builds running. Worth one look with Reduce motion set to Off.
9. **Chat timing: parallel tool calls share a start time.** See Build next #3: a step row's duration includes waiting for the calls before it in the same message.
10. **Minor: the harness's window-shot naming lagged.** The agent issued navigate and screenshot in one message about 117 times, so window shots taken "at the screenshot" sometimes showed the next page. This only affects the research harness. The agent-side images are exact.

The fixes made here are items 1, 2 and 4: `app/src-tauri/src/device/web_agent.js` and `app/src-tauri/src/device/web.rs`, with 2 new unit tests, all 52 device tests passing.
