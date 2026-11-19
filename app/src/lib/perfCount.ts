// Render counters and boot marks for the self-test's `perf-*` scenarios (selftestPerf.ts). A counter is one
// property increment per render of the few components that matter for cost (the sidebar, the timelines, Mission
// control); the marks are `performance.mark`s, once each. Nothing here reads them outside a self-test.

export const renders: Record<string, number> = {};

export function countRender(name: string) {
  renders[name] = (renders[name] ?? 0) + 1;
}

/** `invoke` calls the page made, by command (lib/backend.ts). */
export const ipcCalls: Record<string, number> = {};

export function countIpc(cmd: string) {
  if (!cmd.startsWith("selftest_")) ipcCalls[cmd] = (ipcCalls[cmd] ?? 0) + 1;
}

const marked = new Set<string>();
/** `performance.mark(name)` the first time only. */
export function markOnce(name: string) {
  if (marked.has(name)) return;
  marked.add(name);
  try {
    performance.mark(name);
  } catch {}
}
