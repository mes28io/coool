# Performance: how it is measured, and what the last pass found

## Re-running it

Everything runs against a **synthetic** home, never the person's: invented projects (`demo-app`, `sample-api`, …, each a
small git repository, some with agent worktrees) and generated Claude Code / Codex transcripts in readable filler
English, shaped like a busy machine (about 120 sessions in the last 24 h, a quarter with subagents, a long tail of big
files and big tool results, a few hundred MB).

```sh
python3 app/scripts/perf/make-home.py --out /tmp/coool-perf-1          # the synthetic HOME (+ project folders)
pnpm -C app build                                                     # the frontend the binary embeds
CARGO_PROFILE_DEV_OPT_LEVEL=2 cargo build -p coool-app --features tauri/custom-protocol
COOOL_BIN=target/debug/coool app/scripts/perf/run.sh /tmp/coool-perf-1 perf-boot
COOOL_BIN=target/debug/coool app/scripts/perf/run.sh /tmp/coool-perf-1 perf-long,perf-stream
COOOL_BIN=target/debug/coool app/scripts/perf/run.sh /tmp/coool-perf-1 perf-idle        # no live sessions
COOOL_BIN=target/debug/coool app/scripts/perf/run.sh /tmp/coool-perf-1 perf-loops,perf-idle 4   # 4 busy, writing sessions
rm -rf /tmp/coool-perf-1 ~/Library/WebKit/coool-perf ~/Library/Caches/coool-perf
```

- The self-test needs a debug build; `CARGO_PROFILE_DEV_OPT_LEVEL=2` makes its backend numbers close to a release build.
- `run.sh` sets `HOME` to the synthetic home (session data, app data) and `COOOL_SELFTEST_OFFSCREEN=1`: the window is
  transparent, lets clicks through, never takes focus, coool doesn't activate and has no Dock icon; WebKit's occlusion
  detection is off and App Nap is held off, so the page renders and its timers run as in front (`perf-stream` logs a
  `timer_check`: ~30 batches/s; ~1/s would mean throttled and the CPU numbers meaningless). It runs a copy of the
  binary named `coool-perf`, so its web data stays in `~/Library/WebKit/coool-perf` and `~/Library/Caches/coool-perf`
  (delete both after). With a number after the scenarios it runs `replay.py`: that many
  sessions marked busy in the registry, each appending 3 transcript lines a second (it removes them after).
- Scenarios (`app/src/selftestPerf.ts`) log `PERF` lines: CPU ms per second, wakeups per second and memory of the app,
  WebKit content and GPU processes (`proc_pid_rusage`); sessions payloads and bytes; `git` processes; `context_map`
  calls; IPC calls by command; render counts of the main components (`lib/perfCount.ts`). **Prefer the counts**: CPU
  and times move with whatever else the machine runs.
  - `perf-boot`: launch → backend steps → page start → first script → first payload → sidebar filled → load done.
  - `perf-idle`: 60 s each on Home, Home with every CSS loop paused, the busiest session open, the window hidden.
  - `perf-loops`: Home with live sessions, one CSS loop variant at a time (which loop costs what).
  - `perf-long`: the three sessions with the most activity: open time, then scrolling top to bottom (frame gaps).
  - `perf-stream`: a made-up coool chat of 1500 items streaming a reply for 15 s (one batch per ~16 ms, like the
    backend pump), then 20 tool steps; then the same with the chat off screen.
  - `perf-soak`: ten rounds of perf-stream into one chat, memory after each.
- Backend-only: `cargo run --release -p coool-core --example refresh_latency bench` (per-refresh cost) and
  `--example malformed <home>` (damaged copies of every transcript through every parser; must report 0 panics).

## What the pass found (2026-11-19)

Same synthetic home, same machine, before and after builds run back to back. Machine shared with other work: times
±30 %.

| What | Before | After | Change |
|---|---|---|---|
| Streaming a reply into a 1500-item chat: renders per batch | 674 (505 items, 168 step lists) | 4.9 | Chat.tsx: blocks kept as the same objects and memoised; flat keyed children |
| … main-thread ms per batch | 17.3 | 12.6 | |
| … page CPU (ms/s) / frame gaps over 50 ms | 969 / 17 | 804 / 9 | |
| A chat past its 1500-item cap: every new item remounted the whole timeline | yes | no | Chat.tsx (nested arrays matched by position) |
| Markdown re-parse while streaming | whole message per token and per reveal frame | the block being written | Markdown.tsx + lib/mdSplit.ts (12 737 prefixes of 2 436 generated replies with lists, code and headings parse to the same tree as before) |
| `git` processes per commit-trail poll (quiet repository, 15 s) | 5 + 1 per merge in the last 12 commits (6 here, 10+ on a merge-heavy repo) | 2 | gitlog.rs: history reused while HEAD and refs stay |
| Commit-trail polls per project shown in two places | 2 timers | 1 | lib/gitTrail.ts |
| Ledger rows recomputed per payload (Mission control, sidebar overlap watch) | every session of the project | the sessions that changed | lib/projectChanges.ts |
| … measured with 4 busy sessions on Home: `git` processes per minute | 72 (12 polls) | 16 (8 polls) | |
| Damaged transcripts (423 files, 9 kinds of damage) | — | 0 panics | examples/malformed.rs (nothing to fix) |
| A live "Thinking" timer on a session outside coool started by a background task's notification | counted from the last prompt (hours: "9h 54m 44s") | from the turn's real start | claude.rs / codex.rs `Tokens::turn_start`, lib/turn.ts |

With 4 busy sessions on Home both builds render the same (~11 components per payload: the changed sidebar rows and
groups, Mission control's section and row). Their CPU and wakeup numbers are **not** comparable between runs of the
out-of-sight window: whether macOS services its display (45 or 300 app wakeups a second) varies from run to run, so
for frame-driven costs run with `PERF_OFFSCREEN=0` (window on screen, in front, while nobody needs the machine).

Memory (`perf-soak`, 6 min of streaming into a 1500-item chat with 4 live sessions): app 58–77 MB, page 330–510 MB, no upward trend.

Unchanged and fine: start-up (warm: sidebar filled ~0.4 s after launch, cold cache ~0.6–0.8 s; 130 sessions, first
payload 4.3 MB), idle with nothing live (~2–3 ms CPU/s per process, under 11 wakeups/s), opening the biggest
external sessions (~120 ms; their payload keeps 300 entries), scrolling them (no frame over 50 ms).

Found, not fixed:
- **CSS loops while sessions are busy.** Measured once with the window on screen: with 4 busy sessions on Home the
  app process woke ~230 times a second and used ~30 ms CPU/s; with every loop paused, ~43 wakeups and ~4 ms (web
  55 → 10 ms/s). Only six spinners (`.work-spin`) and one mood glyph were running. WebKit services running CSS
  animations every display frame even when they are `steps()`; `perf-loops` says which loop it is. Fix size: medium
  (drive the stepped loops from one ~12 Hz timer, or let transform-only spinners run linear so Core Animation runs
  them); left because it changes how every loop is built and wants a visual check.
- **Per-batch cost still grows with chat length** (~13 µs per block per batch: 120 blocks 3 ms, 660 blocks 10 ms)
  although almost nothing renders: reconciling the long child list, layout of a tall column. Virtualising old turns
  would remove it; large change.
- `git status` (v1) still runs twice on a trail cache miss; the login-shell PATH lookup (~130 ms) sits before the
  window on the critical path. Small each.
