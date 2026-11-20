// Self-test `film` / `film-measure`: motion footage of the real window for the launch film, on the invented workspace
// of app/scripts/readme-shots (film.sh builds it, runs this and assembles the video). No model calls.
//
// `film-measure`: how fast window-alone stills come (bursts with 1-6 workers and png / jpg / bmp).

import { useStore } from "./store";

export interface FilmKit {
  dir: string;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  shot: (name: string, settle?: number) => Promise<unknown>;
  log: (line: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
}

export function filmScenarios(k: FilmKit): Record<string, () => Promise<void>> {
  const { invoke, sleep, waitFor, step } = k;
  const film = (action: string, a: Record<string, unknown> = {}) => invoke("selftest_film", { action, ...a }) as Promise<{ frames?: number; ms?: number }>;

  return {
    async "film-measure"() {
      await step("film: the sessions are listed", async () => {
        await waitFor("the sessions", () => useStore.getState().sessions.length >= 12, 60_000);
        await film("visible");
        await sleep(3000);
      });
      for (const [workers, format] of [[1, "png"], [3, "png"], [6, "png"], [1, "jpg"], [3, "jpg"], [6, "jpg"], [3, "bmp"], [6, "bmp"]] as const) {
        await step(`film: burst ${workers}x ${format}`, async () => {
          await film("start", { name: `m-${workers}-${format}`, workers, format });
          await sleep(5000);
          const r = await film("stop");
          return `${r.frames} frames in ${r.ms} ms = ${((r.frames! * 1000) / r.ms!).toFixed(1)} fps`;
        });
      }
    },
  };
}
