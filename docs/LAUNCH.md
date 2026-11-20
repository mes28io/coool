# Launch and public beta: where coool stands

Written 2026-11-20 for the owner. Web research done the same day with public pages only (all "read 2026-11-20"
unless a line says otherwise). Repo facts are from README.md, docs/APP_SPEC.md, docs/CHAT_SPEC.md, docs/PERF.md,
docs/LID.md, `app/src-tauri/tauri.conf.json`, `Info.plist`, `Cargo.toml`, `package.json` and the git log.

**The short version.** In the last few months the official apps have caught up on much of what coool was going to
lead with. Claude Code Desktop now has a Browser pane, an **iOS Simulator pane that never takes over your screen**,
parallel sessions, worktrees, a diff pane, a usage ring, notifications and auto-update, on Mac, Windows and Linux.
Codex now lives inside the ChatGPT desktop app, with computer use, voice and approvals from your phone. Of the
third-party "many agents" apps, Conductor joined Meta, Terragon shut down, Vibe Kanban is sunsetting and Crystal is
deprecated. The ones still running (Paradev, Emdash, Nimbalyst, Agentastic, Jean) all compete on parallel worktrees,
diffs and mobile.

coool is still ahead on four things I could not find anywhere else:

- explaining each permission request, with an independent second read;
- warning when two agents edit the same file before their work is merged;
- a sandboxed Mac that agents drive inside the app;
- a device "pilot" that replays a learned route instead of calling the model each step.

It also does voice locally and watches Claude Code and Codex sessions side by side, wherever they were started.
It is behind on the basics a beta needs: a signed build, auto-update, crash reports, diff review, worktree-per-task,
other platforms, and real-world use. The repo is six days old (first commit 2026-11-14, 253 commits) and has no
git remote yet.

---

## 1. The field, as of today

Legend: **BYO** = runs on the user's own CLI login or subscription. "Not found" means the page I read didn't
mention it, not proof the product lacks it.

### 1a. Official surfaces

| Product | What it is today | Platform | Price / auth | Parallel / worktrees | Approvals | Browser / computer / device | Voice | Notifications / mobile | Source |
|---|---|---|---|---|---|---|---|---|---|
| **Claude Code Desktop** (Code tab of the Claude app) | GUI for Claude Code with panes: chat, diff (with comments), browser, terminal, file, plan, tasks, subagent, iOS Simulator | macOS (universal), Windows x64/ARM64, Linux beta (apt/deb). Local, cloud, SSH and WSL sessions | Included in Claude plans; claude.ai sign-in | Multiple sessions, split view, one window per session. A Worktree toggle per session (`.claude/worktrees/`, `.worktreeinclude`). Needs git | Modes: Manual, Accept edits, Plan, Auto (a background classifier checks actions instead of you), Bypass. Browser: per site, Allow once / Always / Deny. Computer use: per app, with access tiers | Browser pane (clean profile, auto-verify on by default). Computer use is a research preview on macOS 14+ and Windows (Pro/Max/Ultra, not Team/Enterprise) | Not found in what I read of the Desktop page; the CLI and VS Code have `/voice` | OS notification when a session finishes while you aren't viewing it. Remote Control and Dispatch reach the Claude mobile app | [desktop](https://code.claude.com/docs/en/desktop) |
| **Claude Desktop, iOS Simulator pane** (public beta) | Streams the simulator beside the chat; Claude installs, taps, reads the screen and verifies | macOS, Xcode 26/27, local sessions only | Pro, Max, Ultra, Team, Enterprise (not HIPAA orgs, not third-party providers) | One device per session if named; otherwise sessions share a running one | Consent once per device. Opening URLs, building, installing and launching follow the permission mode | "Drives the simulator directly, so it doesn't need computer use and never takes over your screen." A "Claude is using this device" badge. Rotation, screenshots, recording, iPhone Duo poses. Screenshots go to Anthropic | n/a | n/a | [ios-simulator](https://code.claude.com/docs/en/desktop-ios-simulator); launched around 2026-07-21 per [MacRumors](https://www.macrumors.com/2026/07/21/claude-code-ios-simulator/) |
| **Claude Code CLI: agent view** (research preview) | `claude agents`: one screen for every background session, across projects | Terminal | Plan or API key | Rows grouped Pinned, Ready for review, Needs input, Working, Completed | Needs-input rows show a one-line summary; a permission dialog must be attached to answer. Interactive sessions in other terminals don't show until backgrounded | n/a | Dictation works in agent view | n/a | [agent-view](https://code.claude.com/docs/en/agent-view) |
| **Claude Code `/voice`** | Hold or tap to dictate | CLI, VS Code | **Streams audio to Anthropic**; needs a claude.ai login (not an API key); 20 languages; no tokens charged | n/a | n/a | n/a | Project and branch names used as hints; no translation found | n/a | [voice-dictation](https://code.claude.com/docs/en/voice-dictation) |
| **Claude Code on the web / cloud** | Each task in an Anthropic-managed VM; `--teleport` brings a session to the terminal; PR auto-fix | Web, mobile, desktop, CLI | Pro/Max/Ultra/Team; not with an API key | Parallel cloud sessions | Accept edits, Plan, Auto | n/a | Not found | Push to mobile | [claude-code-on-the-web](https://code.claude.com/docs/en/claude-code-on-the-web) |
| **Claude in Chrome** | Extension that drives your real Chrome logins from Claude Code | Chromium browsers | Direct plan only; off with an API key or ZDR | n/a | Per-site permissions; pauses for logins and CAPTCHAs | DOM and console, forms, uploads, GIF recording | n/a | n/a | [chrome](https://code.claude.com/docs/en/chrome) |
| **Claude computer-use API tool** | `computer_toolset_20260801` | API | API billing | n/a | Docs advise a VM and human confirmation | Screenshots cost about 1,000–1,800 tokens each | n/a | n/a | [computer-use-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) |
| **Codex in the ChatGPT desktop app** | Codex is now a mode of the ChatGPT desktop app (Chat, Work, Codex); runs projects in parallel, with scheduled automations | macOS (Apple silicon), Windows; Linux mentioned | Included from Free ($0) through Go $8, Plus $20, Pro $100/$200/$500, Business and Enterprise. An API key works in the CLI and IDE extension but not the cloud features | Automations run in background worktrees (search summary; the worktrees page returned 404, so **unverified**) | Permission profiles (read-only / workspace / full access / custom), enforced by Seatbelt on macOS | Computer use on macOS and Windows: per app with "Always allow"; Windows takes over pointer and keyboard; macOS has an optional "locked use". Built-in browser plus a browser extension. No simulator found | ChatGPT Voice works in Codex | Configurable "needs attention" notifications. Mobile: start tasks, approve actions, review work | [app](https://learn.chatgpt.com/docs/app), [features](https://learn.chatgpt.com/docs/features.md), [permissions](https://learn.chatgpt.com/docs/permissions), [computer-use](https://learn.chatgpt.com/docs/computer-use), [pricing](https://learn.chatgpt.com/docs/pricing) |
| **Codex CLI / IDE extension** | Open-source CLI; IDE extension for VS Code, Cursor and Windsurf | All | Apache-2.0; ChatGPT sign-in or API key | n/a | Approval policies (the auto-review page was not read) | iOS: a "Build iOS Apps" plugin using serve-sim and XcodeBuildMCP (secondary source, **unverified**) | `/voice` status unclear (sources conflict, **unverified**) | n/a | [github.com/openai/codex](https://github.com/openai/codex), [aicatchup](https://aicatchup.com/news/codex-build-ios-apps-plugin) |

### 1b. Third-party "run many agents" tools

| Tool | Status | Platform | Licence / price | Auth | Agents | Parallel | Approvals | Browser / device | Voice / mobile | Source |
|---|---|---|---|---|---|---|---|---|---|---|
| **Conductor** | **Joining Meta.** Cloud shuts down "over the next few weeks"; the app keeps working "till then"; "something new early next year" | Mac | Was free plus Pro | BYO CLI logins or an API key | Claude Code, Codex, Cursor, OpenCode | Workspace per task (branch, terminal, diff). Not sandboxed | Not found | Not found | Not found | [announcement](https://conductor.build/announcement), [docs](https://www.conductor.build/docs/), [SiliconANGLE](https://siliconangle.com/2026/11/04/meta-acquires-ai-coding-startup-conductor-whose-app-runs-several-coding-agents-at-once/) |
| **Paradev** (was Superset) | Active | Mac, Linux (experimental), iOS | MIT, free; Pro for mobile and automations | BYO | Claude Code, Codex, OpenCode, Cursor Agent, Gemini CLI, any CLI | Worktree per task; says worktrees "do not sandbox processes or prevent merge conflicts" | Sidebar shows waiting | In-app browser, design mode | iPhone/iPad (Pro); chimes, dock badges | [paradev.com](https://paradev.com/), [GitHub](https://github.com/superset-sh/superset) |
| **Emdash** (YC W26) | Active | Mac, Windows, Linux | Apache-2.0 | BYO | About 9 agents, including Devin, Copilot and Droid | Worktrees; SSH; tickets from Linear, Jira and GitHub | Via agent hooks | Not found | Notifications via hooks | [GitHub](https://github.com/generalaction/emdash) |
| **Nimbalyst** (replaces Crystal) | Active | Mac, Windows, Linux, iOS | MIT, free for individuals | BYO subscription or API key | Claude Code, Codex (OpenCode and Copilot in alpha) | Kanban of sessions, one-click worktrees, every edit a reviewable diff, Teams beta | Not found | Visual editors | iOS app | [nimbalyst.com](https://nimbalyst.com) |
| **Agentastic** | Active | Mac 14+ (Apple silicon and Intel), CLI, iPhone (TestFlight) | Free, no sign-up | BYO | 56 agent definitions | Worktree or Docker container per agent; long-running "manager agents" | "Needs input" state, Auto-approve; **answer approvals from the iPhone** | A browser agents drive; cloud desktops with computer use | iPhone app with end-to-end-encrypted push | [agentastic.dev](https://www.agentastic.dev) |
| **Jean** | Active | Mac, Linux | Apache-2.0 | BYO | Claude, Codex, Cursor, OpenCode and more | Worktrees; Plan / Build / Yolo; merge-conflict command | Plan approval | Not found | Sounds; headless web access | [GitHub](https://github.com/coollabsio/jean) |
| **Sculptor** (Imbue) | Research preview | Mac (Apple silicon), Linux | MIT | Unverified | Claude Code, others | Worktrees and containers | Not found | Not found | Not found | [imbue.com/sculptor](https://imbue.com/sculptor/) |
| **Claude Squad** | Active | Terminal (tmux) | AGPL-3.0 | BYO | Claude Code, Codex, Gemini, Aider, OpenCode, Amp | Worktree per session | `-y` auto-accept | n/a | n/a | [GitHub](https://github.com/smtg-ai/claude-squad) |
| **Happy** | Active | iOS, Android, web | MIT | BYO | Claude, Codex, Grok, Gemini, ACP agents | n/a | **Allow/Deny on the phone**, "remember for this session" | n/a | Voice via ElevenLabs plus a Sonnet rewriter (cloud); deep-linked push | [GitHub](https://github.com/slopus/happy), [features](https://happy.engineering/docs/features) |
| **HumanLayer** | Active | macOS, web | Apache-2.0 | Not stated | Claude Code, Codex, OpenCode, Pi | Mirrors sessions through plugins | Not described | n/a | n/a | [GitHub](https://github.com/humanlayer/humanlayer) |
| **opcode** | Active (releases "soon") | Win, Mac, Linux | AGPL-3.0 | Claude Code CLI | Claude Code only | Session browser, usage and cost, checkpoints | n/a | n/a | n/a | [GitHub](https://github.com/winfunc/opcode) |
| **Cline Kanban** | Research preview | Browser board | Open source | No account | Cline, Claude Code, Codex, OpenCode | Worktree per card, chained tasks; warns it bypasses permissions | n/a | n/a | n/a | [docs](https://docs.cline.bot/kanban/overview) |
| Vibe Kanban, Terragon, Crystal, Roo Code | **Sunsetting or shut down** | | | | | | | | | [vibe-kanban](https://github.com/BloopAI/vibe-kanban), [terragon-oss](https://github.com/terragon-labs/terragon-oss), [crystal](https://github.com/stravu/crystal) |

Dropped because I couldn't verify them: Chorus (only unrelated products) and a Roo agent manager (the product ended).

### 1c. IDE and terminal agents, device tooling, voice

| Product | Key facts | Source |
|---|---|---|
| **Cursor** (now owned by SpaceX/xAI, per press) | **Cloud agents:** parallel cloud VMs with a controllable desktop and browser, PRs, screenshots and video; started from web, iOS, Slack or GitHub. They need Premium ($30) or above. | [cloud-agent](https://cursor.com/docs/cloud-agent), [pricing](https://cursor.com/pricing), [Engadget](https://www.engadget.com/2237655/spacex-officially-acquired-ai-coding-startup-cursor/) |
| | **Local:** a browser tool with manual / allow-list / auto-run modes. Nov 6: voice chat on Grok Voice. | [browser](https://cursor.com/docs/agent/browser), [changelog](https://cursor.com/changelog) |
| | **Auth:** a Cursor account. No official path to use a Claude or ChatGPT subscription was found. | |
| **Warp** | Since Apr 2026, "universal agent support": runs Claude Code, Codex, Gemini CLI, OpenCode, `agy` and others in its terminal. It adds vertical tabs with branch, worktree and PR, a notification center, voice input, and review comments sent into the agent. Mac, Linux and Windows. Pricing page shows two price sets (unverified). | [blog](https://www.warp.dev/blog/universal-agent-support-level-up-coding-agent-warp), [pricing](https://www.warp.dev/pricing) |
| **Zed** | **ACP:** an open protocol that runs Claude Agent, Codex, Gemini CLI and others inside the editor. | [acp](https://zed.dev/acp) |
| | **Parallel work:** a threads sidebar with an optional worktree per thread, and a "waiting for input" indicator (1.29.1). | [parallel-agents](https://zed.dev/docs/ai/parallel-agents) |
| | **Price:** external agents are free; Pro is $10. No voice, browser or device tools found. | |
| **Google Antigravity** | App, CLI (`agy`) and IDE that run multiple local agents. Free for developers; Mac, Windows and Linux. Gemini CLI's free tier moved there on 2026-06-18. | [antigravity.google](https://antigravity.google), [gemini-cli](https://github.com/google-gemini/gemini-cli) |
| **MobileBuildMCP** (was XcodeBuildMCP, now Sentry) | MIT MCP server and CLI covering simulator build, tap, swipe, type and snapshot. Error telemetry goes to Sentry unless disabled. | [repo](https://github.com/getsentry/MobileBuildMCP) |
| **serve-sim** (Expo) | Streams the simulator to a browser so agents can drive it | [WorkOS recap](https://workos.com/blog/mcp-night-4-evan-bacon-servesim-ios-simulator) |
| **Cua / Lume** | Toolkit for agent computer use plus macOS and Linux VMs on Virtualization.framework (MIT; some parts FSL or AGPL). A toolkit, not a panel in a coding app. | [trycua/cua](https://github.com/trycua/cua) |
| **Wispr Flow** | Cloud dictation. Pro $15/month. Pastes plain text into the CLIs. | [pricing](https://wisprflow.ai/pricing) |
| **superwhisper** | Local Whisper on Apple silicon; works with Claude Code, Codex and Cursor. Pro price unclear (unverified). | [superwhisper.com](https://superwhisper.com) |

**Performance claims:** none of the products above publishes measured latency, CPU or memory numbers for its app
that I could find. Agentastic's "100 fps" highlighting claim gives no method.

**Policy that matters for coool** ([legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)):

- Anthropic forbids third-party apps from offering Claude.ai login or routing requests through subscription
  credentials.
- It explicitly does **not** prevent "an end user from signing in to the unmodified Claude Code binary with their own
  Claude subscription."
- Its name and logo rule is narrower: you may say in plain text that your product "runs Claude Code". Any other use
  of Anthropic's names or logos needs written permission under its
  [Trademark Guidelines](https://www.anthropic.com/legal/trademark-guidelines).
- Press coverage of the February 2026 tightening:
  [The Register](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access).

---

## 2. Where coool is genuinely ahead

"Evidence level" says how far the proof goes:

- **measured**: numbers in the docs from a self-test;
- **tested in app**: a real-app self-test passes;
- **unit-tested**: logic only;
- **built**: code exists, no proof beyond that.

### 2a. Unique as far as I can find

| # | Claim (one plain sentence) | Evidence in coool | Nearest competitor | Confidence |
|---|---|---|---|---|
| 1 | **Every permission request explains itself: the agent's own words, an independent second read by a different model, and a Risky tag from fixed rules. It never calls anything "safe".** | CHAT_SPEC "What this does and why" and "Risky tag"; `lib/explain.ts`, `lib/risk.ts` (unit-tested with negatives); Needs-you page (`components/needs/`, `lib/needs.ts`, unit-tested); redaction of secrets before sending. The second read needs Assist on with the user's own Anthropic API key. Level: **unit-tested and built**. I found no real-app self-test for the second read; add one before claiming it. | Claude's **Auto mode** classifier decides *instead of* you and doesn't explain to you ([desktop](https://code.claude.com/docs/en/desktop)). Agent view shows a one-line "Needs input" summary ([agent-view](https://code.claude.com/docs/en/agent-view)). Happy and Agentastic let you answer from a phone. None explains or second-guesses a request. | High that it's unique; medium on polish until real users see it |
| 2 | **coool warns you when two agents (or two sub-agents in different worktrees) edit the same file before the work is merged.** | APP_SPEC "File overlap"; `overlaps` in `lib/mission.ts`, unit-tested and "checked against this repo's real transcripts"; sidebar overlap marks. Level: **unit-tested, built**. | Paradev says outright that worktrees "do not … prevent merge conflicts" ([GitHub](https://github.com/superset-sh/superset)). Jean has a post-hoc merge-conflict command. Nobody warns before. | High |
| 3 | **Agents can use a sandboxed macOS VM inside the app (its screen in the side panel, never your desktop), with the network On, Local-only or Off.** | APP_SPEC "Mac panel (sandbox VM)": Virtualization.framework helper, guest agent over vsock, device gate. Self-tests `agent-mac`, `mac-cycles` (ten boot cycles), `mac-network`, `gate-mac`, `pilot-mac-direct`. Measured: boot to ready 15.7–18 s; `mac_observe` <0.1 s; download 16.5 GB, install 274 s. Level: **tested in app, measured on one Mac**. | Claude computer use acts on your real screen (research preview). Cursor cloud agents have a VM desktop, but in the cloud on paid tiers. Cua/Lume is a toolkit. Claude's `requireCoworkFullVmSandbox` runs tools in a VM but *disables* the simulator pane ([ios-simulator](https://code.claude.com/docs/en/desktop-ios-simulator)). | High that it's unique as an integrated local panel. The cost is big: Apple silicon, a macOS 27 host, about 16 GB download and about 40 GB of disk |
| 4 | **A device "pilot" learns a route the first time and replays it from memory after that: the second run of a browser form took 0.58 s with no model calls.** | APP_SPEC "Device pilot", measured table: browser form 9.1 s first run → 0.58 s second; iPhone Settings→About 11.0 s → 2.6–3.2 s warm. Haiku cost about $0.0001 per decision. Self-tests `pilot-iphone`, `pilot-browser`. Level: **measured, tested in app**. Haiku needs the user's API key; without one the pilot only replays memory or returns "stuck". | No equivalent found. Computer use and the simulator pane take a model step per action. | Medium-high. The numbers are from scripted goals on one machine; the separate benchmark agent should confirm them |
| 5 | **Mission control shows what agents did across all your projects in one place: uncommitted edits, pushes, PRs, deploys, publishes, migrations and outbound POSTs, next to the commit trail and a sub-agent fan-out.** | APP_SPEC "Mission control", "Agent lanes", "While you were away"; `lib/mission.ts`, `lib/lanes.ts`, `lib/away.ts`, all unit-tested. `git_trail` is read-only. Level: **unit-tested, built**. | Claude Desktop has a per-session "what it changed" card and diff pane. Agent view lists sessions across projects. Nobody found shows a ledger of side effects that leave the machine (deploys, pushes, POSTs). | Medium. Unique in shape, but people may file it under "dashboards" |

### 2b. Better executed (others have a version)

| # | Claim | Evidence | Nearest competitor | Confidence |
|---|---|---|---|---|
| 6 | **One window for Claude Code and Codex sessions: those coool starts and those already running in your terminals and IDEs, read straight from `~/.claude` and `~/.codex`, no hooks.** | README "Discover"; APP_SPEC "Who started it". Outside sessions are **read-only**: you can watch and stop them, not answer them. Level: **built and in daily use by the owner**. | Third-party apps (Paradev, Emdash, Nimbalyst, Agentastic, Jean) run several CLIs but only the sessions they launch. HumanLayer mirrors sessions through plugins. Claude Desktop shows only Claude. Agent view shows only backgrounded Claude sessions. | Medium-high |
| 7 | **Voice to prompt runs entirely on your Mac: speak in any language, get an English prompt, and it learns your words and fixes.** | APP_SPEC "Voice"; whisper.cpp v1.8.3 vendored; memory and learning unit-tested; self-test `voice` uses **WAV fixtures, not a live mic**. Level: **built and unit-tested; never used with a live mic by a real person**. | Claude `/voice` streams audio to Anthropic, needs a claude.ai login and has no translation ([voice-dictation](https://code.claude.com/docs/en/voice-dictation)). Cursor voice runs on Grok Voice (cloud). superwhisper is local but pastes text from outside the app. | High on the comparison; **do not claim until tested with a live mic** |
| 8 | **Device permissions work the same way for Claude and Codex, and a form submit, a password field or a payment field always asks, even after you've allowed the site.** | APP_SPEC "Device permissions"; `device/gate.rs`; self-tests `gate-browser`, `gate-browser-codex`, `gate-mac`, `gate-mac-codex`. Gate cost under 50 µs per call. Level: **tested in app**. | Claude Desktop: per-site browser approval and per-device simulator consent, after which taps and typing "run without prompts" ([ios-simulator](https://code.claude.com/docs/en/desktop-ios-simulator)). | Medium-high |
| 9 | **The iPhone panel works for Codex too, and reads the accessibility tree rather than screenshots: about 23–49 ms per observe, about 60 ms per tap.** | APP_SPEC "iPhone panel", measured through the real proxy. Level: **measured**. | Claude Desktop's simulator pane does the same no-focus-steal job for Claude only. Its docs give no timings, and Claude's screenshots of the device go to Anthropic. | Medium. **Don't say "faster than Claude's" without the benchmark agent's numbers** |
| 10 | **A context map shows what fills each agent's context window, sub-agents included, and every part adds up exactly to the size the CLI reported.** | CHAT_SPEC "Context map"; `crates/core/src/context.rs`. Level: **built**. | Claude `/context` prints categories; the Desktop Context card shows a percentage. | Medium |
| 11 | **Claude and Codex plan limits in one place, including Codex's free reset credits.** | CHAT_SPEC "Plan usage" and "Reset credits". Level: **built**. | Claude Desktop's usage ring covers Claude only. | Medium |
| 12 | **The app's own cost is measured and published, with the method.** | docs/PERF.md: streaming went from 674 to 4.9 renders per batch; git processes per poll from 5+ to 2; app 58–77 MB over 6 minutes of soak; idle about 2–3 ms CPU/s. Level: **measured (synthetic home, one machine)**. | No competitor publishes app numbers (none found). | High that the numbers are real. Make it a transparency claim, not a "faster than X" claim |

### 2c. Table stakes we also have

The following are expected, not differentiators:

- native chat with step lists and sub-agent cards;
- slash commands, model and mode pickers;
- tabs and split panes;
- notifications that open the right chat (Claude Desktop, Warp, Paradev and Emdash all notify);
- an in-app browser (Claude Desktop, Codex, Paradev, Agentastic);
- MIT licence (Paradev and Nimbalyst are MIT, Emdash and Jean are Apache);
- BYO subscription;
- onboarding;
- themes;
- open at login;
- the iPhone simulator panel itself (Claude Desktop since July).

### Claims killed

- "The only app with an iOS simulator panel that doesn't steal focus": Claude Desktop has one.
- "Agents can test web apps in a built-in browser": everyone has this.
- "Keeps working with the lid closed": **never run for real** (docs/LID.md: "Nobody has installed the helper,
  closed a lid, or let `pmset disablesleep 1` run on a Mac yet"). Claude's docs do say "Closing the lid counts as
  sleep" and point to cloud sessions ([desktop](https://code.claude.com/docs/en/desktop)), so this would be unique
  once it is proven.
- "Faster than X": no head-to-head numbers yet.
- "Open source, so better": half the field is open source.

---

## 3. Where coool is behind or exposed

### Gaps users will hit on day one

| Gap | Today in coool | What others have |
|---|---|---|
| **No signed, notarised build** | `tauri.conf.json` has no signing identity, no `macOS.minimumSystemVersion`, no entitlements and no `hardenedRuntime` settings. APP_SPEC lists "auto-update, signing" as out of scope for v1. Install today is from source (Rust, Node 20+, pnpm, Xcode CLT). | Every competitor ships a download |
| **No auto-update** | No updater plugin in `Cargo.toml` or `package.json` | Claude Desktop restarts to update and waits for running tasks |
| **No crash reporting** | None in the dependencies. A user's crash is invisible | Unknown for most competitors; Emdash has optional telemetry |
| **No diff review** | Roadmap item in README | Claude Desktop diff pane with comments; Conductor, Nimbalyst, Vibe Kanban, Warp |
| **No worktree per new session** | coool shows and cleans up worktrees (Settings > Git & worktrees) but the New-session sheet doesn't create one | Claude Desktop toggle; every third-party orchestrator |
| **macOS only, effectively recent Apple silicon** | README says "Linux should work", which is unverified. Voice needs Apple silicon (Metal). The sandbox Mac needs Apple silicon and a macOS 27 host. | Claude Desktop, Emdash, Nimbalyst, Warp, Zed and Antigravity are on Mac, Windows and Linux |
| **Two agents only** | Claude Code and Codex | Gemini CLI, Antigravity `agy`, OpenCode, Cursor CLI, Amp, Copilot, Droid are common elsewhere. Warp and Zed (ACP) take any |
| **No mobile companion or remote approvals** | None | Claude Remote Control and Dispatch, Codex mobile, Happy, Agentastic, Paradev, Nimbalyst |
| **No cloud or remote runs, no SSH** | Local only | Claude cloud and SSH, Cursor cloud agents, Emdash SSH |
| **No team features** | None | Nimbalyst Teams beta, Cursor Teams, Warp Business |
| **Outside sessions are read-only** | You can watch and stop, not answer, a session started in a terminal | Claude Desktop answers only its own sessions too, but users will expect to approve from coool |
| **Assist and pilot need an Anthropic API key** | The second read, status lines, proofreading and the pilot's Haiku step use a separately billed key. A Codex-only user needs an Anthropic account for these. | Claude's Auto classifier is included in the plan |

### Stability unknowns (built this week, never used by a real person)

- **Voice with a live microphone.** The self-test injects WAV files. First-load Metal compile (about 7 s), mic
  permission in a *bundled* app (dev builds borrow the terminal's), and the hold-key detection are all untested
  with a person.
- **Lid helper as root.** It has never been installed, never run `pmset disablesleep`, `sleepnow` or bootout on
  hardware (docs/LID.md "Remaining risks"). `pmset disablesleep` is undocumented. **Ship it off and hidden behind a
  "labs" flag until the owner's manual test plan passes.**
- **Notifications in a signed, packaged app.** Commits on 11-19 fixed real-bundle permission issues. Delivery and
  click routing from a notarised, Developer-ID build with hardened runtime haven't been shown. macOS keys
  notification permission to the signed identity, so ad-hoc builds prove little.
- **Private Apple APIs.** CoreSimulator, SimulatorKit and AccessibilityPlatformTranslation for the iPhone; private
  `_VZ…` selectors for the VM's frames and input; System Settings' layout for the VM's Accessibility grant. Each
  Xcode or macOS update can break them. Everything is looked up at runtime and fails as a clear message, but it
  will break, and Anthropic's own pane is maintained by a large team.
- **Age.** Six days of history. No external users, no crash data, no telemetry. Performance numbers come from a
  synthetic home on one machine.

### Docs and naming drift (cheap to fix, embarrassing if shipped)

- **"Assist" naming.** The 11-19 commit renamed the feature in the interface ("Assist", "Second read", "Proofread
  dictation"). README, APP_SPEC and CHAT_SPEC still say "AI insights", "AI read" and "AI polish".
- **README roadmap.** It lists "Agent hands" and "Notifications" as future work, but both are built.
- **APP_SPEC "Out of scope for v1"** still says agent control of the browser and desktop is out of scope.

### Branding and trademark exposure

- **The rainbow.**
  - The Colours backdrop is "the six-colour rainbow" (commit 11-19), and brand rounds include a rainbow wordmark.
    Six horizontal colour bands in that order read as Apple's 1977–1998 logo to many Mac users.
  - The legal risk is low unless it's paired with an apple-like shape. The bigger risk is looking derivative, or
    being read as Pride branding, which isn't the intent.
  - Status colours named "Apple blue" are fine.
  - Owner decision: keep the rainbow inside the app as a backdrop option, and keep it out of the logo and marketing.
- **The Claude and OpenAI marks** shown beside sessions (`app/src/assets/brands/`).
  - Anthropic's Claude Code terms allow saying in plain text that a product "runs Claude Code", but "any other use
    of Anthropic's names or logos … requires our written permission".
  - Showing the Claude logo to mark a Claude session is probably nominative use. It isn't what that page allows
    without asking.
  - Before launch, either ask Anthropic and OpenAI, or replace the logos with neutral marks plus the text
    "Claude Code" and "Codex". Check OpenAI's brand guidelines the same way (not researched here).
- **Subscription policy.**
  - coool runs the unmodified `claude` binary under the user's own login and never reads credentials. That is the
    case Anthropic's page explicitly allows.
  - Two things to keep exactly so:
    - never bundle or patch the CLI;
    - never proxy its traffic.
  - Say this in the FAQ, with the link.
  - The usage probe (a hidden `claude -p … get_usage` with no model turn) and reading
    `~/.claude.json`'s `oauthAccount.organizationType` for the plan name are worth a sentence in the privacy note.

---

## 4. Beta readiness checklist

Order is the order to do them in. **M** = must-have for a public beta, **S** = should-have, **L** = later.

### 4.1 Packaging (M)

What the repo has:

- `bundle.targets: "all"` (on macOS that builds `.app` and `.dmg`), icons and the sound resources.
- `Info.plist` with `NSMicrophoneUsageDescription`.
- `native/coool-vm.entitlements`, used to sign the VM helper ad hoc in `build.rs`.

What it doesn't have: a signing identity, hardened-runtime entitlements for the app, notarisation, release scripts or
CI, a version bump process, or a minimum macOS version.

Concrete Apple steps:

1. **Apple Developer Program** (organisation account if coool will have a company; the Team name shows in
   Gatekeeper). Create a **Developer ID Application** certificate. A Developer ID Installer certificate is only
   needed for a `.pkg`.
2. **Set the minimum macOS** (`bundle.macOS.minimumSystemVersion`). The features need it:
   - the browser profile needs macOS 14 or later;
   - host-only VM networking needs macOS 26;
   - automatic VM provisioning needs a macOS 27 host.

   Pick one floor (probably 26) and gate the Mac panel at runtime on 27, which it already does.
3. **The app's entitlements file** (`bundle.macOS.entitlements`, plus `hardenedRuntime: true`, the Tauri default
   when signing):
   - `com.apple.security.device.audio-input`: **required** under hardened runtime for the microphone. Without it
     voice silently gets no audio.
   - `com.apple.security.cs.allow-jit`: WKWebView in the main app normally doesn't need it. Test without it first.
   - No App Sandbox. coool reads `~/.claude` and `~/.codex`, runs CLIs and spawns PTYs, so it ships outside the Mac
     App Store.
   - Notifications, login items (`SMAppService.mainAppService`) and Accessibility for the app itself need no
     entitlement.
4. **Helpers.** Today the iPhone helper, the VM helper and the lid helper are compiled by `build.rs`, embedded as
   bytes, and written to `<app data>/bin/…` on first use. Each is ad-hoc signed, and the VM helper carries
   `com.apple.security.virtualization`. For a notarised release, **ship them as real executables inside the bundle**
   (`Contents/MacOS/` or `Contents/Helpers/`, via Tauri `externalBin` or a post-build step):
   - Sign each with the Developer ID, hardened runtime and a secure timestamp.
   - The VM helper keeps `com.apple.security.virtualization`, which is a public entitlement allowed with Developer ID
     and needs no provisioning profile.
   - Executables written out at run time are outside what notarisation checks, and they keep an ad-hoc identity
     that security tools flag.
   - The guest agent (`coool-vm-agent`) is built and signed **inside the VM** and stays as it is.
5. **The lid helper.**
   - Today: `osascript … with administrator privileges` installs a root LaunchDaemon into
     `/Library/PrivilegedHelperTools`.
   - For release, move to **`SMAppService.daemon(plistName:)`** (macOS 13+): the daemon's plist lives in
     `Contents/Library/LaunchDaemons/`, the binary in the bundle, and approval is through System Settings > Login
     Items.
   - Gains: no admin script, no file copying with a hash race, and macOS removes the daemon with the app.
   - Sign it with the Developer ID and pin the client by code requirement (check the connecting process's team ID,
     not just its uid).
   - Until then, keep the feature behind a labs flag.
6. **Sign, notarise, staple.** Set `APPLE_SIGNING_IDENTITY`, then notarise with `APPLE_API_KEY` / `APPLE_API_ISSUER`
   / `APPLE_API_KEY_PATH` (App Store Connect API key) or `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`. Tauri's
   bundler runs `notarytool submit --wait` and staples the `.app`. Staple the `.dmg` too
   (`xcrun stapler staple coool.dmg`). Verify on a clean Mac:
   - `spctl -a -vvv -t install coool.dmg`
   - `codesign --verify --deep --strict`
   - first launch from a quarantined download.
7. **Universal or arm64 only?** Voice and the VM need Apple silicon. Ship **arm64 only** and say so; it is simpler
   and honest.
8. **Fonts in the bundle.** Pally is fetched at `pnpm install` and must be present on the release build machine.
   The repo's own note says its ITF FFL allows embedding in desktop apps but forbids redistributing the files.
   Re-read the licence for a font embedded *inside a distributed app bundle* (the files are extractable), or render
   the wordmark as an SVG outline and drop the font.

### 4.2 Auto-update (M)

- Add `tauri-plugin-updater` with signed update manifests (an Ed25519 key pair; keep the private key out of the
  repo) served from GitHub Releases or coool.sh.
- Behaviour to copy from Claude Desktop: never restart while an agent works; offer "Restart when idle".
- Update checks are a new network call: list them in the privacy note.
- Without this, every beta fix needs a manual reinstall and testers drift onto old builds.

### 4.3 Crash and error reporting (M, opt-in)

- At minimum:
  - a Rust panic hook and a WebKit `window.onerror` that write to a local log;
  - "Copy diagnostics" in Settings > About (version, macOS, CLI versions, last 200 log lines, no transcripts);
  - a "Report a problem" link.
- Optional and off by default: Sentry or similar with PII scrubbing. Say so in the privacy note.
- macOS crash reports (`~/Library/Logs/DiagnosticReports`) cover the native helpers; ask testers to attach them.

### 4.4 First-run experience (M)

The onboarding is built and self-tested (`onboarding`, `onboarding-prefs`). Before beta:

- run it on a **clean user account** with a signed build;
- run it with no CLIs installed, one CLI, and both CLIs;
- run it with no Xcode, and with too little disk for the Mac;
- check that nothing asks macOS for anything before a button is pressed, which the spec promises.

The "What are you building? → Sandbox Mac" box starts a **16 GB download in the background**. It should be off
unless ticked (it is), and say "16 GB" in large type.

### 4.5 Privacy statement (M)

Checked against the code. Hosts found by scanning `app/src-tauri/src`, `crates/*/src` and `app/src` for URLs and
HTTP clients (`ureq` in `insights.rs`, `pilot/haiku.rs`, `voice/models.rs`).

**What leaves the Mac:**

| Traffic | When | Where | What |
|---|---|---|---|
| The CLIs' own traffic | Whenever you use Claude Code or Codex | Anthropic / OpenAI | Whatever the CLI sends. coool doesn't see or change it |
| Usage probes | Data more than 5 min old while the window is focused; back-off on failure | Via the CLIs (`claude -p` `get_usage`, `codex app-server` `account/rateLimits/read`) | The CLIs' own account requests; no model turn |
| Assist: status lines, "needs you" detection, the second read of permission requests, proofreading dictation | **Off by default**; on with your own Anthropic API key (Keychain), hourly cap | `api.anthropic.com/v1/messages`, `claude-haiku-5-5` | The tool name and capped, redacted fields of the request, your last prompt (600 chars), the agent's last words, six step lines. Never credentials files, env vars or the key (CHAT_SPEC "Never sent") |
| Device pilot | When an agent calls `pilot_run`, a step isn't in memory, and a key is set | `api.anthropic.com` | Goal, input *names* (never values), visible text, numbered actions. No screenshots |
| Whisper model download | Only on your press | `huggingface.co/ggerganov/whisper.cpp` (HTTPS, SHA-256 checked) | A normal download request |
| Sandbox Mac install | Only on your press, or the onboarding box | Apple (`VZMacOSRestoreImage.fetchLatestSupported` and range requests to Apple's IPSW host) | A normal download, about 16.5 GB |
| Sandbox Mac at runtime | While it runs with network On (the default) | Anywhere the guest goes | The guest's own traffic. The shared folder can leave with it (the UI says so) |
| In-app browser | Pages you or an agent open | Those sites | Normal browsing in coool's own WebKit profile |
| Artifacts "Open" | On click | `claude.ai` | You sign in yourself in the panel |

**What doesn't leave:** audio (whisper runs locally), transcripts, voice memory, pilot memory and decision logs,
device grants, settings. Fonts are bundled, and Fontshare is contacted only at `pnpm install` on the build machine,
never at runtime. There is no telemetry and no update check today; the updater will add one.

**What coool reads:** `~/.claude` and `~/.codex` transcripts and config, plus `~/.claude.json`'s
`cachedUsageUtilization` and `oauthAccount` plan fields. It never reads credentials files or the Keychain entries
of the CLIs.

### 4.6 Telemetry stance (M, a decision)

Recommendation: **none in the beta build except opt-in crash reports**, and say so. It matches the BYO, local-first
story and is a real differentiator against Cursor and the cloud products. Product questions can come from interviews
and a feedback form instead.

### 4.7 Licence and third-party notices (M)

Ship a `THIRD_PARTY_NOTICES` file in the bundle (Settings > About > Licences) generated from:

- **Rust:** `cargo about` or `cargo-deny` licences.
- **JavaScript:** `pnpm licenses list --prod`.
- **Named items:**
  - whisper.cpp / ggml (MIT, `crates/whisper/whisper.cpp/LICENSE`);
  - border-beam 1.4.1 (MIT, `app/node_modules/border-beam/LICENSE`);
  - Geist and Geist Mono (SIL OFL 1.1);
  - Pally (ITF FFL: see 4.1.8);
  - xterm.js (MIT), React (MIT), Motion (MIT), Tauri (MIT/Apache-2.0), react-markdown and remark-gfm (MIT).
- **Credit:** facebook/idb (MIT), whose techniques were "reimplemented"; no code was copied per the spec. A credit
  line is still courteous.
- **Whisper model weights:** downloaded, not bundled. Note that they are OpenAI's Whisper (MIT) converted by ggml.

### 4.8 Security review (M before public; an outside reviewer if possible)

1. **Device permission gate** (`device/gate.rs`). Confirm:
   - unknown or unreported mode = ask;
   - the 5-minute timeout = deny;
   - "always in this project" never covers the always-ask kinds;
   - JavaScript-only form submits fall to the site rule (documented);
   - a malicious page can't spoof `inspect` (it runs in coool's content world).
2. **MCP socket** (`device-<pid>.sock`, mode 0600, per-chat random token in env). Review:
   - the temp-folder fallback path when the socket path is too long;
   - stale-socket cleanup racing a new coool;
   - that the token can't leak through a transcript (the CLI records env?); check the transcript files.
3. **The root lid helper.** The threat note exists (docs/LID.md). Get a second reviewer on the install script, the
   `getpeereid` check, the marker logic and the SIGTERM path. Better, move to `SMAppService.daemon` with a
   code-signing requirement on the client (4.1.5). Until reviewed: off and hidden.
4. **In-app browser and preview window IPC isolation.** Already self-tested (`browser`). Re-run it on the signed
   build, and set a real CSP for the main webview (`security.csp` is `null` today).
5. **Pilot decision log** is on by default and stores screen summaries locally. Make the default **off** for the
   beta, or say plainly in onboarding that it is on.
6. **`mac_shell` and the shared folder.** Always ask (tested). Network On is the default; consider **Local** as the
   default for agents.
7. Dependency audit: `cargo audit`, `pnpm audit`.

### 4.9 Support channel (M)

- GitHub Issues with templates (bug: macOS version, chip, CLI versions, "Copy diagnostics"; feature).
- One chat place (Discord or GitHub Discussions; pick one).
- A security contact (`SECURITY.md`, an email).
- A status line in the README for known breakage after Xcode or macOS updates.

### 4.10 Known-issues list (M, published with the beta)

From the docs:

- iPhone: no rotation; US keyboard layout only (other text is pasted); two chats share one device.
- Pilot: can't tap controls missing from the accessibility tree (Contacts sheet buttons); no sliders, pickers or
  `<select>`; exact-match memory misses screens with clocks or counts.
- Sandbox Mac: one VM, no snapshots, no Rosetta, Pacific time zone; needs a macOS 27 host for the automatic first
  boot.
- Long chats: per-batch cost still grows with length (PERF.md).
- Sessions outside coool are read-only. External sessions don't get the device tools.
- The browser takes app shortcuts while a page has focus.
- Lid-closed: labs only.
- Voice: first use compiles Metal shaders (about 7 s).

### 4.11 Rollback plan (M)

- Keep every release's signed `.dmg` and update manifest.
- The updater channel can point back to N−1 (publish a manifest with the older version and a higher "minimum").
- Settings formats: `settings.json` and localStorage keys only gain fields today (`prefs_set` treats missing keys as
  unchanged). Keep it that way for the beta, so going back a version never breaks a profile.
- The transcript cache is versioned (`transcripts-v*`) and rebuildable.
- The lid helper must be removable by the *older* app too, or by a documented one-liner. Have that line ready.
- The VM folder survives app reinstalls. Document how to delete it (about 24 GB).

### 4.12 Staged rollout (S)

1. **Week 0, friends (5–10):** people who already run several Claude Code or Codex sessions a day, on Apple
   silicon. Watch: install and first-run friction, crash logs, whether they keep it open after day 2, and which
   pages they use (ask; no telemetry).
2. **Week 1–2, private beta (50–100)** from a waitlist on coool.sh, half Claude-only, a quarter Codex-only, a
   quarter both. Watch:
   - CLI version breakage (both CLIs ship weekly; pin "tested with" versions in the README);
   - memory over a workday;
   - notification delivery;
   - whether people turn Assist on (it costs them API money);
   - how many install the sandbox Mac.
3. **Public beta** after two weeks without a P0. Keep labs features (lid-closed, perhaps the Mac panel) behind a
   toggle.

What to stop on: any report of coool changing a CLI config, losing a session, or acting in a device without asking
in an asking mode.

### 4.13 Should-have before public beta (S)

- Worktree-per-session in the New-session sheet: the most expected feature in this category.
- A minimal diff view per session, even read-only.
- Verified Linux, or remove "Linux should work" from the README.
- Fix the docs and naming drift (section 3).
- Re-measure PERF on a signed release build.

### 4.14 Later (L)

- More agents (Gemini/Antigravity `agy`, OpenCode; ACP would give many at once).
- Mobile approvals.
- Remote or SSH sessions.
- Teams.
- Windows.
- "Connect an agent" for external sessions' device tools (already designed in APP_SPEC).

---

## 5. Launch narrative

### Three candidate positionings

1. **"Mission control for your coding agents: every Claude Code and Codex session on your Mac, what they changed,
   and exactly what they're asking you."** Safest; every word is supportable today.
2. **"Your agents ask before they act. coool tells you what they're really asking."** Leads with the most unique
   thing (claim 1). Needs the second read shown working on a real request in the video.
3. **"Give your agents their own iPhone, browser and Mac, inside one window, without them touching yours."** Most
   visual. Claude Desktop covers the iPhone and browser half, so the Mac and the cross-CLI angle must carry it, and
   it needs the benchmark numbers.

My pick: (1) as the tagline, with (2) as the first beat of the video.

### 60–90 s X video, five beats (only things that verifiably work today)

| Beat | Seconds | Show | Verified by | Needs from the benchmark/B-roll agent |
|---|---|---|---|---|
| 1. The mess | 0–10 | Mission control with several Claude and Codex sessions across two projects: lanes, fan-out of sub-agents, the ledger filling (commit, push) | Unit tests plus the owner's daily use; mock data exists (`lib/mock.ts`), but **use a real run for the launch video** or label it a demo | B-roll: Mission control during real parallel work |
| 2. The overlap | 10–22 | Two agents edit the same file: the overlap row pins to the top, then "Open both" | `overlaps` unit-tested on real transcripts | A real recording of an overlap firing. **Must be staged with real sessions, not mock** |
| 3. Needs you | 22–42 | A risky command arrives: the bell → Needs you page → "Claude says…", the **second read**, a "Doesn't match what it said:" line, the Risky tag, Allow / Deny | Unit-tested and built; **record it in the real app** (Assist on with a key) | Recording; say on screen that the second read uses your own API key |
| 4. Hands, not your screen | 42–65 | An agent drives the iPhone and the browser in the side panel (cursor and beam), then the pilot replays a route from memory, with a visible timer | `agent-iphone`, `agent-browser`, `pilot-*` self-tests; measured 0.58 s browser replay | **[slot: pilot first vs second run, wall time]**, **[slot: observe/tap ms]**, **[slot: sandbox Mac boot-to-ready]**, B-roll of all three |
| 5. Yours | 65–80 | "Your Claude and ChatGPT plans. Nothing proxied. MIT. Mac." Wordmark, coool.sh | README; the legal page | n/a |

Leave out of the video until tested: voice (no live-mic run yet), lid-closed (never run), any "faster than" line.

**Claims that need the benchmark numbers before they can be said:**

- any speed figure for the pilot beyond the docs' own one-machine table;
- "tool calls in tens of milliseconds";
- sandbox Mac boot time;
- any comparison with Claude Desktop's simulator pane or with computer use.

---

## 6. Open questions for the owner

1. **Brand marks.** Ask Anthropic and OpenAI for permission to show their logos, or switch to neutral marks plus
   text before launch?
2. **The rainbow.** Keep it in the logo and marketing, or only as an in-app backdrop option?
3. **Lid-closed.** Run the manual test plan now and ship it as a labs feature, or hold it out of the beta entirely?
4. **Sandbox Mac in the beta.** Headline feature, or labs? It's the most unique feature and the heaviest one (16 GB,
   macOS 27, private APIs).
5. **Telemetry.** Agree to "none, opt-in crash reports only"?
6. **Minimum platform.** arm64 only, macOS 26 or 27 as the floor?
7. **Company and Developer account.** Which legal entity holds the Developer ID (its name shows in Gatekeeper and
   notarisation)?
8. **Diff view and worktree-per-session before beta,** or ship without them and say so?
9. **Assist pricing story.** It needs the user's Anthropic API key. Is that acceptable for Codex-only users, or
   should the second read also be able to run through the user's own CLI?
10. **Conductor's exit.** Its users are being moved off Conductor Cloud with "something new early next year". Do you
    want to court them explicitly (an import or a "coming from Conductor" page)?
