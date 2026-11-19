// One shared frame for streamed updates (CHAT_SPEC "Streaming"): chat batches from the backend, the reveal of
// streamed text and the token counts rising run together in it, about 30 times a second, so a streaming chat is one
// React render and one paint per such frame instead of one per batch (~60 a second) plus one per display frame
// (60 or 120). Each painted frame costs the app's process too (~5 wakeups and ~1 ms), so this is the rate that sets
// what streaming costs. Frames are asked for only when one is due (a timer waits out the rest of the ~16 ms): every animation
// frame asked for wakes the app's process too. While the window is hidden (no animation frames) a timer runs it
// instead, so the store stays current.

type Cb = (t: number) => void;

let queue: Cb[] = [];
let raf = 0;
let wait: ReturnType<typeof setTimeout> | null = null;
let fallback: ReturnType<typeof setTimeout> | null = null;
let last = -Infinity;
/** The shortest time between two runs (ms): every 4th frame of a 120 Hz display (8.3 ms apart), every 2nd at 60 Hz. */
let MIN_GAP = 28;
/** The perf scenarios try other rates (selftestPerf.ts perf-chat); returns the one before. */
export function setFrameGap(ms: number): number {
  const was = MIN_GAP;
  MIN_GAP = ms;
  return was;
}
/** The timer that stands in for frames that don't come (hidden window). */
const FALLBACK_MS = 120;

function flush(t: number) {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (wait) clearTimeout(wait);
  wait = null;
  if (fallback) clearTimeout(fallback);
  fallback = null;
  last = t;
  const list = queue;
  queue = [];
  for (const f of list) f(t);
}

function schedule() {
  if (raf || wait) return;
  const left = MIN_GAP - (performance.now() - last);
  // Too soon after the last run: wait (a timer, not frames), then take the next frame.
  if (left > 1) {
    wait = setTimeout(() => {
      wait = null;
      raf = requestAnimationFrame(flush);
    }, left);
  } else raf = requestAnimationFrame(flush);
  if (!fallback) fallback = setTimeout(() => flush(performance.now()), FALLBACK_MS);
}

/** Run `f` in the next shared frame. Returns a cancel. */
export function nextFrame(f: Cb): () => void {
  queue.push(f);
  schedule();
  return () => {
    const i = queue.indexOf(f);
    if (i >= 0) queue.splice(i, 1);
  };
}
