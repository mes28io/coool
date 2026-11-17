# Pilot spike: System-1 device pilot (iOS Simulator)

Setup: M4 Pro, 24 GB. iOS 27 sim (own headless device, deleted afterwards). Perception and actions go through WebDriverAgent (Appium WDA, built from source, localhost:8123): `/source` gives the AX tree and `/wda/tap|keys|dragfromtoforduration` and `/alert/*` act. Building WDA took about 2 min and it worked first try. The AX tree is flattened into a **typed candidate set**: `tap(el)`, `type(<input_key> → field)`, `submit`, `scroll_down/up`, `back`, `done`, `stuck`. That gives K≈10–30 per screen (mean 18). System alerts (location, iCloud) are not in the app's tree, so they come from `/alert/text` and are added as candidates.

Tasks (7): Settings dark mode, iOS version (About), Display & Text Size, Safari example.com → "Learn more", new contact (first, last, phone), new reminder, Maps search → place card. A scripted oracle completes 14/14 runs. Its runs produced 64 labelled states, which were used for the offline per-step evaluation.

## Results

Offline per-step accuracy (64 oracle states, single gold action, so strict):

| pilot | acc | decision p50/p95 | notes |
|---|---|---|---|
| A Qwen2.5-0.5B (4-bit) | 16% | 102/182 ms | useless |
| A Qwen3-1.7B | 36% | 330/497 ms | |
| A Qwen2.5-3B | 27% | 528/774 ms | |
| A Qwen3-4B-Instruct-2507 | **56%** | 693/1015 ms | best local |
| B Haiku 5.5 (forced tool, enum ids) | **83%** | 1181/1474 ms | $0.00013/decision, ~1.1k input tokens |
| C 4B + Haiku, gate p<τ (τ=0.99) | 64% | 918 mean / 2366 p95 | 16% escalated |
| C 4B + Haiku, permutation-agree gate | 73% | 1852 mean / 3280 p95 | 39% escalated |

Closed loop (task success, decision p50/p95, wall p50 per task):

| pilot | success | steps | decision ms | wall | $ |
|---|---|---|---|---|---|
| oracle (device floor) | 14/14 | 4.6 | 0 | 13.1 s | – |
| A-small 1.7B | 4/14 | 10.5 | 345/766 | 43 s | 0 |
| A-large 4B | 8/14 | 4.9 | 669/1515 | 21 s | 0 |
| B Haiku | 16/21 | 5.3 | 1227/2050 | 23 s | $0.015 total |
| C 4B+Haiku (agree gate) | 8/13* | 5.8 | 2400/5077 | 25 s | $0.006 |

\* The batch was stopped early (battery), so 13 episodes. The muscle-memory closed-loop run never started. **Muscle memory (offline replay)**: with (task, screen signature) → action key learned from run 0, run 1 hits 22/32 states (69%), and 20 of those 22 hits are correct. Hits are zero-model and take under 1 ms. Misses come from screens whose typed values differ between runs (contact names, reminder titles). The 2 wrong hits were "same screen, different step", which needs a goal-progress or postcondition check.

Device cost per step (separate from the decision): AX `/source` takes 0.3–1.0 s, and up to 3.5 s on the Contacts edit sheet. Perceive p50 is ~1.0–1.4 s including the alert probe (~110 ms). An action plus settle is ~1.0 s. WDA `/screenshot` is ~80 ms and `simctl io screenshot` ~370 ms. **The device dominates wall time, not the model.** Total API spend was $0.032.

## What worked / failed

- The candidate-classification framing works mechanically. One prefill with a shared KV cache scores all K candidates in a batch, and the static system prefix is cached once. A single-token-label variant (one forward pass, softmax over K label logits) is the pure Jev shape, but it scored worse (45% on 4B) than numeric-id scoring (56%).
- **Off-the-shelf small LMs are not good enough and are not calibrated.** Wrong answers come out with p≈1.0 (ECE 0.40 on 4B, 0.62 on 1.7B), so a confidence threshold barely escalates. Permutation-agreement is a usable gate (73% accuracy when the two orderings agree vs 32% when they disagree), but it doubles local cost. The hybrid ends up slower than Haiku alone. Jev's selling point, calibrated confidence, is a **training** property that prompting doesn't give.
- Local latency on this machine was ~700 ms for 4B at ~410 prompt tokens. The GPU was shared with the simulator, and prefill bound everything.
- Haiku errors were mostly about done/progress (it re-tapped already-selected items) and one real pathology: `type` appends text, so a wrong field led into a Clear-text loop. **`type` must be `set_text` (replace, idempotent).**
- Real-world surprises: app state restoration on relaunch, system alerts outside the app tree, keyboard covering fields, and taps landing during scroll momentum, which only stop the scroll.

## Recommended architecture for coool

- **Where it runs:** a pilot loop in the Rust core next to the device server. It owns perceive (AX via WDA/XCUITest runner), act, and change detection. Decisions go through a `Scorer` trait with three backends: `MemoryScorer` (signature replay), `LocalScorer` (MLX sidecar over a Unix socket, model kept warm, static-prefix KV cached), and `RemoteScorer` (Haiku, forced tool with enum of candidate ids). Run them as a cascade: memory → local (only once a fine-tuned model clears ~90%) → Haiku → escalate to System 2.
- **Typed action schema:** `{id, verb: tap|set_text|submit|scroll|back|done|stuck, target:{role,label,value,frame}, input_key?}`. Inputs are never free text from the pilot; they are keys into the goal's `inputs`.
- **Goal handoff (MCP tool):** `pilot.run({goal, app, inputs:{k:v}, success:[{text_visible|element_state}], max_steps, budget_ms})`. System 2 writes deterministic postconditions where it can, so `done` is checked rather than guessed, which removes the pilot's weakest decision. The tool returns `{status: done|stuck|surprised|budget, steps[], final_screen, evidence(screenshot)}`. "Surprised" means an alert or an unknown app, or a screen whose layout signature was never seen with low confidence.
- **Live change detection:** diff the frame stream the panel already has (perceptual hash, ~10 fps). Re-read the AX tree only when frames have been stable for ~150 ms after an action. This replaces fixed sleeps and avoids paying 1 s for `/source` on unchanged screens.
- **Jev later:** it fits the `RemoteScorer` slot unchanged (structured state + candidate list in, distribution out), behind an explicit per-project opt-in because screen state leaves the machine. Use the 64-state dataset plus logged trajectories as its eval.

## Next

1. Log every Haiku/System-2 decision as (state, candidates, chosen) and fine-tune a 1.7–4B scorer (LoRA, MLX) for accuracy and calibration. This is the only path to a fast local System 1.
2. Switch `type` to `set_text`, add postcondition checks, and make the WDA source call cheaper (lower snapshot depth, scoped queries).
3. Run the muscle-memory closed loop and a larger, non-oracle task set.

Code: `device.py` (WDA + candidates), `pilots.py` (A/B/C/memory), `tasks.py`, `run.py`, `offline_eval.py`, `consistency_eval.py`, `analyze.py`, `run_all.sh`.
