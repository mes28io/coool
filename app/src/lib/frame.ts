// One shared frame for streamed updates (CHAT_SPEC "Streaming"): chat batches from the backend, the reveal of
// streamed text and the token counts rising run together in it, about 30 times a second, so a streaming chat is one
// React render and one paint per such frame instead of one per batch (~60 a second) plus one per display frame
// (60 or 120). The page's cost follows this rate (docs/PERF.md "Streaming into an open chat"); the app process's
// wakeups don't much (WebKit's display link runs while anything on the page changes). While the window is hidden (no
// animation frames) a timer runs it instead, so the store stays current.

type Cb = (t: number) => void;

let queue: Cb[] = [];
let raf = 0;
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
  if (fallback) clearTimeout(fallback);
  fallback = null;
  last = t;
  const list = queue;
  queue = [];
  for (const f of list) f(t);
}

function schedule() {
  if (raf) return;
  // Too soon after the last run: frames are skipped until the gap has passed (measured: a timer to wait it out
  // instead costs the page ~45 more wakeups a second and the app the same).
  const tick = (t: number) => {
    raf = 0;
    if (t - last < MIN_GAP) raf = requestAnimationFrame(tick);
    else flush(t);
  };
  raf = requestAnimationFrame(tick);
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
