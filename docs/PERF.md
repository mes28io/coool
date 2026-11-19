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
# Looping animations: frame-driven, so the window on screen (in front, never focused) for these short runs
PERF_OFFSCREEN=0 COOOL_SELFTEST_WINDOW=quiet COOOL_BIN=target/debug/coool app/scripts/perf/run.sh /tmp/coool-perf-1 perf-anim-app
PERF_OFFSCREEN=0 COOOL_SELFTEST_WINDOW=quiet COOOL_BIN=target/debug/coool app/scripts/perf/run.sh /tmp/coool-perf-1 perf-anim 4
rm -rf /tmp/coool-perf-1 ~/Library/WebKit/coool-perf ~/Library/Caches/coool-perf
```

- The self-test needs a debug build; `CARGO_PROFILE_DEV_OPT_LEVEL=2` makes its backend numbers close to a release build.
- `run.sh` sets `HOME` to the synthetic home (session data, app data) and `COOOL_SELFTEST_OFFSCREEN=1`: the window is
  transparent, lets clicks through, never takes focus, coool doesn't activate and has no Dock icon; WebKit's occlusion
  detection is off and App Nap is held off, so the page renders and its timers run as in front (`perf-stream` logs a
  `timer_check`: ~30 batches/s; ~1/s would mean throttled and the CPU numbers meaningless). It runs a copy of the
  binary named `coool-perf` (`PERF_NAME=…` for another, so two runs never share one), so its web data stays in
  `~/Library/WebKit/coool-perf` and `~/Library/Caches/coool-perf` (delete both after). With a number after the
  scenarios it runs `replay.py`: that many sessions marked busy in the registry, each appending 3 transcript lines a
  second, from the top again when its source transcript ends (it removes them after).
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
  - `perf-chat` (window on screen for its CPU lines: `PERF_OFFSCREEN=0 COOOL_SELFTEST_WINDOW=quiet`): a made-up coool
    chat at ~120, ~540 and 1500 items. Per batch, applied one at a time with style and layout forced and timed after
    each: store updates, main-thread ms (store and React), layout ms, ms in Markdown parses and other probes
    (`lib/perfCount.ts` `addTime`), renders by component, frames asked for; the same with the reader scrolled to the
    top (and whether the first row moved); a turn starting and ending (`state_change_ms`); then 20 s streaming through
    the app's own queue (as the backend's batches arrive) for CPU, wakeups and DOM mutations. At 1500 items also: CSS
    loops paused, Motion made instant, the turn running with nothing streaming, and the shared frame at 60 and 10 Hz.
    `perf-chat-long` is the 1500-item part alone.
  - `perf-busy` (run with live sessions, e.g. `run.sh <out> perf-busy 1`): Home, then the busiest replayed session
    open, then the same with Motion instant, 20 s each: CPU, wakeups, payloads, store updates, mutations, frames.
  - `chat-window` (pass/fail, `selftestWindow.ts`; no model calls, so it runs on the synthetic home with `run.sh`):
    the long-timeline window, see "Long timelines" below.
  - Looping animations (window on screen; `selftestAnim.tsx` has every loop of the app as the components draw it):
    `perf-anim-app` six copies of one loop at a time, everything else paused (what each costs alone);
    `perf-anim-lab` the same for bare test loops (linear vs stepped, box vs SVG content, a JS timer...);
    `perf-anim` Home and the busiest live session: the running loops by name, then as is, all loops paused, also
    Motion's JS animations made instant, each loop paused alone; `perf-backdrop` / `perf-backdrop-lab` the Colours
    window backdrop off, resting and drifting, and its layers at other sizes; `perf-anim-frames` every loop paused at
    fixed times (0-2400 ms, every 50 ms, dark and light) with a window shot each, to compare two builds frame by frame,
    and the loops left running under Reduce motion on, off and auto. Each measured window also logs `display_fps`
    (frames the display delivered just after it): far below the screen's rate means frame-driven numbers mean little.
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
- ~~CSS loops while sessions are busy~~: fixed, see "Loops" below.
- **Per-batch cost still grows with chat length** (~13 µs per block per batch: 120 blocks 3 ms, 660 blocks 10 ms)
  although almost nothing renders: reconciling the long child list, layout of a tall column. Virtualising old turns
  would remove it; large change.
- `git status` (v1) still runs twice on a trail cache miss; the login-shell PATH lookup (~130 ms) sits before the
  window on the critical path. Small each.

## Loops (second pass, 2026-11-19)

Window on screen, in front, never focused (`PERF_OFFSCREEN=0 COOOL_SELFTEST_WINDOW=quiet`), quiet machine, synthetic
home; "before" is master's animation code, "after" this pass, built back to back from the same tree.

**What WebKit does with a loop** (`perf-anim-lab`, six 14 px copies, every other animation paused; app process
wakeups a second / CPU ms a second; the empty page is ~4 / ~3):

| Loop | App wakeups/s | App ms/s | Page ms/s |
|---|---|---|---|
| `transform` or `opacity`, linear or eased, on an HTML element or an `<svg>` element | 28–43 | 3–5 | 2–3 |
| the same with `steps()` (a 20-step spinner, a 10-step fade) | 220–290 | 18–25 | 14–30 |
| the same with the steps written as keyframes (holds joined by 0.01 % ramps) | 160 | 22 | 25 |
| anything inside an SVG (`<circle>` opacity, `<g>` transform, `stroke-dashoffset`), linear | 340–370 | 41–45 | 55–62 |
| `background-position` (the old shimmer), stepped or linear | 300–390 | 18–49 | 18–110 |
| one shared 12 Hz JS timer stepping a transform | 240–250 | 13–19 | 14–18 |

Core Animation runs a transform or opacity animation of a layer by itself; anything else, and any stepped timing
(Core Animation has no steps), makes WebKit update the animation on the main thread **every display frame**, whatever
its own rate, and the app process wakes for every frame it commits. A low-rate JS timer is no better: after each
change WebKit keeps the display link running for a while.

**The rule** (styles.css "motion primitives", `lib/animRules.test.ts` in `pnpm test`): a loop animates `transform`
and/or `opacity` only, with linear or cubic timing, never `steps()`, on an HTML element or an `<svg>` element, never
on something inside an SVG. A glyph with several moving parts is a stack of `<svg>` layers, one per part
(MoodGlyph.tsx); a moving highlight is a layer that slides with its content sliding back (Shimmer.tsx, the write
glyph's line). Allowed exceptions are listed in the test with their reason: one-offs that end by themselves, and the
approval card's conic border (`attn-spin`, only while a request waits). To add a loop: write it that way, add it to
`selftestAnim.tsx` `LOOPS`, and run `perf-anim-app` (it should sit near the 15–40 wakeups of the others) and
`perf-anim-frames`. A huge layer is the other trap: the Colours backdrop's layers at 150 % of the window were tiled,
and a tiled layer's animation is serviced every frame like a stepped one.

**Each loop alone** (`perf-anim-app`, six copies, run 2 of 2; run 1 agrees within noise except where noted):

| Loop | Was | Now | Before: app wakeups/s, app ms/s, page ms/s | After |
|---|---|---|---|---|
| Working spinner (`.work-spin`, StatusDot) | rotate, `steps(20)` | rotate, linear | 293 / 22.6 / 23.9 | 42 / 4.0 / 3.9 |
| Needs-you dot breathe (`.breathe`) | opacity, `steps(10)` | opacity, linear | 241 / 13.3 / 9.7 | 32 / 7.1 / 2.0 |
| Shimmer (thinking word, active step, "Running 3 steps") | `background-position` of a `background-clip: text` gradient, `steps(26)` | the text, and a highlight copy seen through a masked band: band and copy slide by `transform` in opposite directions | 266–273 / 18 / 16 | 17–24 / 3–5 / 2 |
| Thinking dots | `animation: 1.4s steps(2) infinite both` with no name, which the CSS minifier turns into `animation: none`: **the dots never showed** | longhands, linear opacity | 7 / 4.7 / 0.7 (nothing ran) | 33 / 5.1 / 2.8 |
| Caret, streaming caret (`.caret`, `.md-live`) | opacity, `steps(1)` | the same on/off as keyframes, linear | 85–87 / 7–8 / 6–7 | 36–42 / 3–5 / 2 |
| Active step sweep, agents' running bar (`.sweep`, `.seg-run`) | translate, `steps(28/30)` | translate, linear | 239–243 / 14–15 / 14–17 | 15 / 2.8 / 1.3 |
| Skeletons (`.skel`) | opacity, `steps(14)` | opacity, linear | 249 / 15 / 10 | 16 / 3.0 / 1.3 |
| Mood glyphs, 10 moods (`.mg`) | opacity, transform and `stroke-dashoffset` of parts inside one SVG, `steps(5–28)` | each moving part its own `<svg>` layer; the dash-drawn line a sliding window, the beads keyframed along their curve | 235–283 / 13–18 / 13–39 | 14–54 / 2.5–4.6 / 1.3–3.5 |
| Browser globe (`GlobeGlyph`) | meridian paths' scaleX inside the SVG, `steps(3)` | each meridian its own layer, linear | 296 / 20 / 37 | 34 / 3.2 / 4.5 |
| New chat's provider mark | Motion `rotate` loop (WAAPI, already on the compositor), ran under Reduce motion | CSS `.welcome-sway`, same 6 s ease-in-out, still under Reduce motion | 3 / 2.7 / 1.3 | 8 / 2.4 / 0.8 |
| Needs-you ring and badge glow | opacity/scale, eased | unchanged | 15 / 3 / 1 | 20 / 3–5 / 1–2 |
| Approval card border (`.attn-card`) | conic gradient angle, `steps(54)` | unchanged (see below) | 250 / 15 / 16 | 230 / 13 / 16 |
| Colours window backdrop (drifting, `perf-backdrop`) | two layers 150 % of the window, transform, eased | each layer a third of that, `scale(3)` put back first: one Core Animation layer each | 256 / 46 / 44, page 250 MB | 10–42 / 6–9 / 1–9, page 179 MB |

Noise: run to run within ±10 wakeups and ±2 ms near the floor; single windows sometimes catch an unrelated burst
(run 1 had the unchanged needs ring at 116 wakeups after).

**Screens** (`perf-anim`, 20 s each, the first window of each run so the replayed sessions are writing):

| Busy sessions | Home before: app wakeups/s, app ms/s, page ms/s | Home after | Home with every loop paused | Busy session open, before | after |
|---|---|---|---|---|---|
| 0 | 3 / 4.0 / 0.9 | 3 / 4.5 / 1.5 | 2 / 4 / 1 | — | — |
| 1 | 261 / 67 / 134 | 121 / 28 / 95 | 85 / 19 / 60–75 | 266 / 64 / 214 | 258 / 59 / 191 |
| 4 | 287 / 69 / 199 | 209 / 40 / 120 | 88–100 / 18 / 77–92 | 273 / 61 / 252 | 336 / 61 / 197 |
| 8 | 268 / 59 / 194 | 213 / 42 / 147 | 84 / 17 / 97 | 266 / 54 / 214 | 211 / 37 / 149 |
| 4, 40 s, `perf-loops` | 272 / 64 / 184 | 134 / 23 / 85 | 89–94 / 16–19 / 74–105 | | |

On Home the loops' share fell from ~180 wakeups and ~45 ms app CPU a second to ~40 and ~7 (40 s windows), the rest
being the live sessions themselves. An open busy session costs about the same before and after: its loops were never
the main cost there. With every CSS loop paused it still wakes the app ~250 times a second and costs the page
~150–200 ms/s; making Motion's JS animations instant as well takes off ~30 ms app and ~50–100 wakeups (row entrances,
springs, rolling numbers as lines arrive), the rest is the page taking in and laying out the writing sessions. Not a
loop; left for a pass on the session view's updates.

Frames: `perf-anim-frames` on both builds, every loop paused at 49 times across 2.4 s, dark and light, cropped per loop
into contact sheets (before, after, difference x3) and side-by-side videos: identical where the loop was already
linear; the stepped loops differ only by where a step falls (mean pixel difference under 1.5 of 255 per cell);
the shimmer's highlight sits where it did; the thinking dots now show. Reduce motion on: only the two intended slow
breathes run (the needs-you ring and dot); before, the streaming caret kept blinking (a more specific rule won), now
it holds still; `animate-spin` loading icons hold still too.

Also measured: `perf-stream` renders the same on master as on the commit that merged the first pass (3 754 renders
over 553 batches: ChatTimeline 1.3, ItemView 2.8, Steps 0.7 a batch, as in the table above, plus LiveTurnBar 1 and
SessionView 1, which that table didn't count): nothing later added renders.

Left as they are:
- The approval card's border (`attn-spin`) animates a conic gradient's angle: a repaint per step whatever its timing,
  serviced every display frame (~230 wakeups for six cards). It shows only while a request waits for the person, it
  is in files another change owns (the permission card, the Needs-you page), and a compositor version needs a child
  element (a rotating gradient square clipped by a ring mask) or `overflow: hidden` on the card. Kept stepped: same
  wakeups, fewer repaints.
- The agent beam around a driven device panel (`border-beam` package) animates while an agent drives a panel only;
  third-party CSS.
- Linear spinners on Home still cost ~40 wakeups a second over all-paused with live sessions (the same in the lab:
  six linear spinners ~40 against ~4 for an empty page): Core Animation's own commits.
- Pausing when the window is unfocused would stop motion the person can still see; loops already pause when the
  window is hidden or occluded (page hidden), off screen or scrolled away (lib/animPause.ts).
