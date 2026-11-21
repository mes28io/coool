// Self-test `history`: the History page against a throwaway HOME of a few thousand invented sessions of both CLIs
// over two years (app/scripts/history/make-home.py, run by app/scripts/history-e2e.sh with the stand-in CLIs; no
// model calls). Checks, through the real backend and UI:
// - the index reads every session (first pass timed), and searching it stays fast (PERF lines, per query);
// - each filter returns only what it says;
// - only the sessions the person started are listed, searched and counted (History, its project counts, the New
//   session sheet, ⌘K, the sidebar and its Show N more); "Started by agents (N)" adds the rest, each one under the
//   session that started it (the invented lead's six lanes, two exec lanes and a Ladder helper);
// - the page finds an old terminal session by a word deep in it ("zebracorn"), opens it in the session view with its
//   whole history (the earlier part loads on scrolling up), its Changes and Context read the transcript;
// - typing in its ended-session box continues it with the stand-in Claude: it becomes a coool chat;
// - sessions whose folder is gone open read-only and say how to continue (Claude: make the folder; Codex: a moved
//   folder of the same name is offered);
// - screenshots: list, search, filtered, opened, earlier history, folder gone (wide, and the list in portrait); the
//   person's list and the agents' chip on, ⌘K, the sidebar with agents' runs hidden.

import { api } from "./lib/backend";
import { mergeWire } from "./lib/changes";
import { useChats } from "./lib/chat";
import { byAgent, recentInFolder, type HistoryQuery, type HistoryRow } from "./lib/history";
import { sessionKey } from "./lib/types";
import { useStore } from "./store";

export interface HistoryKit {
  dir: string;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  shot: (name: string, settle?: number) => Promise<unknown>;
  log: (line: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
}

const $ = (s: string, root: ParentNode = document) => root.querySelector<HTMLElement>(s);
const $all = (s: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(s)];

export function historyScenarios(k: HistoryKit): Record<string, () => Promise<void>> {
  const { dir, shot, sleep, waitFor, step, log, invoke } = k;
  const q = (x: HistoryQuery) => api().historyQuery(x);
  const one = async (word: string): Promise<HistoryRow> => {
    const p = await q({ text: word, limit: 5 });
    if (p.total !== 1) throw new Error(`"${word}" found ${p.total} sessions`);
    return p.rows[0];
  };
  /** The session view of `key` is on screen. */
  const opened = (key: string) =>
    waitFor(`the session view of ${key}`, () => {
      const s = useStore.getState().sessions.find((x) => sessionKey(x) === key);
      return s && !useStore.getState().history && $("[data-activity-timeline]") ? s : null;
    }, 20_000);
  const pct = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * p))];

  return {
    async history() {
      await step("history: the index reads every session of both CLIs (two years, any folder)", async () => {
        const t0 = performance.now();
        let st = await api().historyStatus();
        while (!st.ready && performance.now() - t0 < 240_000) {
          await sleep(500);
          st = await api().historyStatus();
        }
        if (!st.ready) throw new Error(`still indexing after 4 min: ${st.pending} left`);
        const s = (performance.now() - t0) / 1000;
        await log(`PERF history-index sessions=${st.sessions} transcripts=${st.transcripts} words_kb=${Math.round(st.text_bytes / 1024)} log_kb=${Math.round(st.log_bytes / 1024)} ready_s=${s.toFixed(1)}`);
        if (st.sessions < 1000) throw new Error(`only ${st.sessions} sessions`);
        return `${st.sessions} sessions in ${s.toFixed(1)} s`;
      });

      await step("history: searching a few thousand sessions is fast (warm, per query)", async () => {
        const words = ["zebracorn", "rate limiting", "cache cleared", "\"thin wrapper\"", "billing", "release notes", "tokenizer", "nothing-like-this", "atlas", "the"];
        const backend: number[] = [];
        const round: number[] = [];
        for (let r = 0; r < 3; r++)
          for (const w of words) {
            const t = performance.now();
            const p = await q({ text: w, limit: 100 });
            round.push(performance.now() - t);
            backend.push(p.took_ms);
          }
        await log(`PERF history-search queries=${backend.length} backend_ms_p50=${pct(backend, 0.5).toFixed(1)} backend_ms_max=${Math.max(...backend).toFixed(1)} roundtrip_ms_p50=${pct(round, 0.5).toFixed(1)} roundtrip_ms_max=${Math.max(...round).toFixed(1)}`);
        if (pct(backend, 0.5) > 60) throw new Error(`median ${pct(backend, 0.5).toFixed(1)} ms`);
        return `median ${pct(backend, 0.5).toFixed(1)} ms in the backend, ${pct(round, 0.5).toFixed(1)} ms round trip`;
      });

      await step("history: each filter returns only what it says", async () => {
        const atlas = `${dir}/atlas`;
        const checks: [string, HistoryQuery, (r: HistoryRow) => boolean][] = [
          ["project", { project: atlas }, (r) => r.project === atlas],
          ["folder and below", { cwd: atlas }, (r) => r.cwd === atlas || r.cwd.startsWith(`${atlas}/`)],
          ["Codex", { providers: ["codex"] }, (r) => r.provider === "codex"],
          ["terminal", { wheres: ["terminal"] }, (r) => r.where === "terminal" && r.via === "Terminal"],
          ["editor", { wheres: ["ide"] }, (r) => r.where === "ide"],
          ["other tools", { wheres: ["automation"], agents: true }, (r) => r.where === "automation"],
          ["changed files", { has_changes: true }, (r) => r.edits > 0],
          ["last 30 days", { from_ms: Date.now() - 30 * 86_400_000 }, (r) => r.last_ms >= Date.now() - 30 * 86_400_000 - 60_000],
          ["a year ago", { from_ms: Date.now() - 400 * 86_400_000, to_ms: Date.now() - 300 * 86_400_000 }, (r) => r.last_ms <= Date.now() - 300 * 86_400_000],
        ];
        const out: string[] = [];
        const all = (await q({ limit: 1 })).total;
        for (const [name, f, ok] of checks) {
          const p = await q({ ...f, limit: 1000 });
          const bad = p.rows.filter((r) => !ok(r));
          if (!p.total || bad.length || p.total >= all) throw new Error(`${name}: ${p.total} rows, ${bad.length} wrong`);
          out.push(`${name} ${p.total}`);
        }
        return out.join(", ");
      });

      let lead: HistoryRow | null = null;
      await step("history: only the sessions the person started; agents' runs on asking, under the session that started them", async () => {
        const def = await q({ limit: 1000 });
        const st = def.status;
        if (def.rows.some((r) => r.by === "agent")) throw new Error("an agent's session in the default list");
        if (!st.agents || def.agents !== st.agents || def.total !== st.sessions) throw new Error(JSON.stringify({ total: def.total, agents: def.agents, st }));
        const y = await q({ text: "yakfluff" });
        if (y.total !== 1 || y.agents !== 9) throw new Error(`yakfluff: ${y.total} rows, ${y.agents} agents'`);
        lead = y.rows[0];
        const ya = await q({ text: "yakfluff", agents: true });
        if (ya.total !== 1 || ya.rows[0].key !== lead.key || ya.rows[0].helpers?.length !== 9) throw new Error(`with agents: ${ya.total} rows, ${ya.rows[0]?.helpers?.length} under it`);
        if (ya.rows[0].helpers!.filter((h) => h.provider === "codex").length !== 2) throw new Error("the exec lanes are not under it");
        const recent = await recentInFolder(`${dir}/relay`, 20);
        if (recent.some((r) => r.by === "agent") || !recent.some((r) => r.key === lead!.key)) throw new Error("the New session sheet's recent sessions list an agent's run");
        // On the page: the list, then the chip.
        useStore.getState().openHistory({ project: `${dir}/relay` });
        const chip = await waitFor("the Started by agents chip", () => $("[data-history-agents]") && $all("[data-history-row]").length > 0 && $("[data-history-agents]"), 20_000);
        const n = Number(chip.dataset.historyAgents);
        const relay = await q({ project: `${dir}/relay` });
        if (n !== relay.agents || !chip.textContent?.includes(`(${relay.agents})`)) throw new Error(`chip says ${chip.textContent}, ${relay.agents} expected`);
        if ($(`[data-history-helpers]`)) throw new Error("helpers listed with the chip off");
        await sleep(400);
        await shot("history-person");
        $("button", chip)!.click();
        const nest = await waitFor("the lead's helpers under it", () => $(`[data-history-helpers="${lead!.key}"]`), 20_000);
        await sleep(500);
        await shot("history-agents");
        const rows = $all("[data-history-row]").length;
        const relayAll = await q({ project: `${dir}/relay`, agents: true, limit: 1000 });
        if (relayAll.rows.some((r) => r.helpers?.some((h) => relayAll.rows.some((x) => x.key === h.key)))) throw new Error("a helper is also a row");
        const under = $all("[data-history-helper]", nest).length + Number(/(\d+) more/.exec($("[data-history-helpers-more]", nest)?.textContent ?? "")?.[1] ?? 0);
        if (under !== 9) throw new Error(`${under} under the lead`);
        $("button", $("[data-history-agents]")!)!.click();
        await waitFor("the chip off again", () => !$("[data-history-agents][data-on]") && !$("[data-history-helpers]"), 20_000);
        useStore.getState().closeHistory();
        return `${st.sessions} of the person's listed, ${st.agents} agents' hidden; relay: ${relay.total} + chip (${n}); with it ${rows} rows, the lead with 9 under it`;
      });

      await step("history: ⌘K's past sessions are the person's", async () => {
        const p = await q({ text: "marmotide", agents: true });
        if (p.total !== 4) throw new Error(`marmotide: ${p.total} with agents'`);
        useStore.getState().setPalette(true);
        const input = await waitFor("the palette", () => $("input[placeholder^='Jump to a session']") as HTMLInputElement | null, 10_000);
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        set.call(input, "marmotide");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const items = await waitFor("its history results", () => {
          const h = $all("[data-palette-item^='h:']").filter((x) => x.dataset.paletteItem !== "h:all");
          return h.length ? h : null;
        }, 10_000);
        await sleep(600);
        const again = $all("[data-palette-item^='h:']").filter((x) => x.dataset.paletteItem !== "h:all");
        await shot("palette-history");
        useStore.getState().setPalette(false);
        if (again.length !== 1) throw new Error(`${again.length} past sessions in ⌘K`);
        const person = (await q({ text: "marmotide" })).rows[0];
        if (again[0].dataset.paletteItem !== `h:${person.key}`) throw new Error(`⌘K shows ${again[0].dataset.paletteItem}`);
        return `1 of ${p.total} (${items.length} on first answer)`;
      });

      await step("history: the sidebar lists the person's sessions; agents' runs under theirs; one line for the rest", async () => {
        const relayDir = `${dir}/relay`;
        const leadKey = lead!.key;
        const s = await waitFor("the lead in the sidebar, its runs under it", () => {
          const st = useStore.getState();
          const kids = st.sessions.filter((x) => x.parent === lead!.id);
          return $(`[data-session-row="${leadKey}"]:not([data-nested])`) && kids.length === 9 ? st : null;
        }, 60_000);
        const loose = s.sessions.filter((x) => byAgent(x) && !x.nested && !(x.waiting_for || x.insight?.needs_you));
        if (loose.length) throw new Error(`${loose.length} agents' runs listed on their own`);
        const line = await waitFor("the hidden-runs line", () => $("[data-other-tools='hidden'] [data-other-tools-history]"), 20_000);
        const m = /^(\d+) runs? started by agents or other tools hidden$/.exec(line.textContent?.trim() ?? "");
        if (!m || Number(m[1]) !== s.hiddenAutomation || s.hiddenAutomation < 3) throw new Error(`line says "${line.textContent}", ${s.hiddenAutomation} hidden`);
        // "Show N more" counts the person's sessions only: N + the rows shown = the person's sessions in the project.
        const relay = await q({ project: relayDir });
        let got = "";
        await waitFor("Show N more counting the person's", () => {
          const box = $(`[data-project="${relayDir}"]`);
          if (!box) return null;
          const more = Number(/Show (\d+) more/.exec($("[data-show-more]", box)?.textContent ?? "")?.[1] ?? 0);
          const top = $all("[data-session-row]:not([data-nested])", box).length;
          got = `${more} more + ${top} shown`;
          return more + top === relay.total ? true : null;
        }, 90_000).catch(() => {
          throw new Error(`${got}; the person has ${relay.total} in relay (${relay.agents} by agents)`);
        });
        $(`[data-session-row="${leadKey}"]`)?.scrollIntoView({ block: "center" });
        await sleep(500);
        await shot("sidebar-agents-hidden");
        return `${got} = ${relay.total} (${relay.agents} agents' left out); "${line.textContent}"`;
      });

      let zebra: HistoryRow | null = null;
      await step("history: the page finds an old terminal session by a word deep in it", async () => {
        zebra = await one("zebracorn");
        if (zebra.where !== "terminal" || zebra.provider !== "claude" || zebra.prompts < 300) throw new Error(JSON.stringify({ where: zebra.where, prompts: zebra.prompts }));
        useStore.getState().openHistory();
        await waitFor("the History page", () => $all("[data-history-row]").length > 5, 20_000);
        await shot("history-list");
        const input = $("[data-history-search]") as HTMLInputElement;
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        set.call(input, "zebracorn");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await waitFor("one best match", () => $all("[data-history-row]").length === 1 && $(`[data-history-row="${zebra!.key}"] [data-history-snippet] mark`), 20_000);
        await shot("history-search");
        return `${zebra.title} (${Math.round((Date.now() - zebra.last_ms) / 86_400_000)} days ago, ${zebra.prompts} prompts)`;
      });

      await step("history: the filters on the page (project, CLI, changed files) and the portrait layout", async () => {
        useStore.getState().openHistory({ project: `${dir}/atlas`, provider: "claude", changes: true });
        await waitFor("a filtered list", () => $("[data-history-clear]") && $all("[data-history-row]").length > 0, 20_000);
        await sleep(400);
        await shot("history-filtered");
        await invoke("selftest_resize", { width: 900, height: 1400 });
        await sleep(900);
        await shot("history-portrait");
        await invoke("selftest_resize", { width: 1440, height: 900 });
        await sleep(600);
      });

      await step("history: opening it shows the session with its whole history, Changes and Context", async () => {
        const row = zebra!;
        useStore.getState().openHistory({ text: "zebracorn" });
        // The page still shows the filtered list a moment: wait for the search's own answer (one row).
        const el = await waitFor("its row alone", () => $all("[data-history-row]").length === 1 && $(`[data-history-row="${row.key}"]`), 20_000);
        await sleep(400);
        el.click();
        const s = await opened(row.key);
        if (s.status !== "ended") throw new Error(`status ${s.status}`);
        await waitFor("the timeline", () => s.activity.length >= 300 || useStore.getState().sessions.find((x) => sessionKey(x) === row.key)!.activity.length >= 300, 30_000);
        await sleep(800);
        await shot("history-open");
        // Scrolling up loads the earlier history until the start.
        const t0 = performance.now();
        await waitFor("the start of the session", () => {
          const tl = $("[data-activity-timeline]");
          if (tl) {
            tl.scrollTop = 0;
            tl.dispatchEvent(new Event("scroll"));
          }
          return $('[data-earlier="start"]');
        }, 60_000);
        // The timeline keeps the reader's place as history is added above: scroll to the very top to see its first prompt.
        const firstPrompt = await waitFor("the first prompt at the top", () => {
          const tl = $("[data-activity-timeline]");
          if (tl) tl.scrollTop = 0;
          return $all("[data-activity-timeline] *").some((n) => n.childElementCount === 0 && (n.textContent ?? "").includes("Plan the zebracorn migration"));
        }, 20_000).catch(() => false);
        await sleep(600);
        await shot("history-earlier");
        if (!firstPrompt) throw new Error("the first prompt is not in the timeline after loading the earlier history");
        const cur = useStore.getState().sessions.find((x) => sessionKey(x) === row.key)!;
        const ch = mergeWire(null, await api().changesLoad({ provider: cur.provider, sessionId: cur.id, agents: [], cwd: cur.cwd, scope: "all", external: true }))!;
        const ctx = await api().contextMap({ provider: cur.provider, sessionId: cur.id, cwd: cur.cwd });
        if (!ch.files.length) throw new Error("the Changes view found no files");
        useStore.getState().setRightPanel(row.key, "changes");
        await waitFor("the Changes panel", () => $("[data-changes-panel]"), 20_000);
        await sleep(1200);
        await shot("history-changes");
        useStore.getState().setRightPanel(row.key, "closed");
        return `earlier history to the start in ${((performance.now() - t0) / 1000).toFixed(1)} s; Changes: ${ch.files.length} files over ${ch.turns.length} turns; Context: ${JSON.stringify(ctx).length} bytes`;
      });

      await step("history: typing in its box continues it in coool (stand-in Claude): it becomes a coool chat", async () => {
        const row = zebra!;
        const ta = await waitFor("the ended-session box", () => $("[data-ended-composer] textarea") as HTMLTextAreaElement | null, 20_000);
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
        set.call(ta, "Picking this up again from History: say done");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(200);
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        const chat = await waitFor("a chat for it", () => Object.values(useChats.getState().chats).find((c) => c.sessionId === row.id) ?? null, 30_000);
        await waitFor("the stand-in's answer", () => useChats.getState().chats[chat.id]?.items.some((i) => i.kind === "text" && i.text.includes("Done")), 60_000);
        await waitFor("the session linked to the chat", () => useStore.getState().sessions.find((x) => sessionKey(x) === row.key)?.chat === chat.id, 30_000);
        await sleep(800);
        await shot("history-continued");
        // History says where it runs now.
        let where = "";
        for (let i = 0; i < 40 && where !== "coool"; i++) {
          await sleep(500);
          await api().historyStatus();
          where = (await q({ text: "zebracorn", limit: 1 })).rows[0]?.where ?? "";
        }
        if (where !== "coool") throw new Error(`History still says ${where}`);
        return `chat ${chat.id} on session ${row.id.slice(0, 8)}; History now says "coool"`;
      });

      await step("history: a Claude session whose folder is gone opens, and says how to continue", async () => {
        const row = await one("quokkafold");
        if (!row.missing) throw new Error("not marked as gone");
        useStore.getState().openHistory({ text: "quokkafold" });
        await waitFor("its row, marked", () => $(`[data-history-row="${row.key}"] [data-history-missing]`), 20_000);
        $(`[data-history-row="${row.key}"]`)!.click();
        await opened(row.key);
        const box = await waitFor("the folder-gone box", () => $('[data-folder-gone="claude"]'), 20_000);
        if (!$("[data-folder-make]", box)) throw new Error("no way to make the folder");
        if ($("[data-ended-composer] textarea")) throw new Error("the box offers typing");
        await sleep(500);
        await shot("history-folder-gone");
        return "read-only, with 'Make the folder again'";
      });

      await step("history: a Codex session whose folder moved offers the folder of the same name", async () => {
        const row = await one("pangolink");
        useStore.getState().openHistory({ text: "pangolink" });
        const el = await waitFor("its row", () => $(`[data-history-row="${row.key}"]`), 20_000);
        el.click();
        await opened(row.key);
        const moved = await waitFor("the moved-folder offer", () => $('[data-folder-gone="codex"] [data-folder-moved]'), 20_000);
        if (moved.dataset.folderMoved !== `${dir}/billing`) throw new Error(`offers ${moved.dataset.folderMoved}`);
        await shot("history-folder-moved");
        moved.click();
        const ta = await waitFor("the box, continuing there", () => $("[data-ended-composer] textarea") as HTMLTextAreaElement | null, 10_000);
        if (!ta.placeholder.includes("billing")) throw new Error(ta.placeholder);
        return ta.placeholder;
      });

      await step("history: the sidebar's Show N more opens History on that project", async () => {
        useStore.getState().closeHistory();
        const more = await waitFor("a Show N more", () => $("[data-project] [data-show-more]"), 20_000);
        const project = more.closest<HTMLElement>("[data-project]")!.dataset.project!;
        more.click();
        await waitFor("History on that project", () => {
          const rows = $all("[data-history-row]");
          return useStore.getState().history?.filters.project === project && rows.length > 0;
        }, 20_000);
        const p = await q({ project, limit: 1 });
        useStore.getState().closeHistory();
        return `${more.textContent} -> ${p.total} sessions in ${project.split("/").pop()}`;
      });
    },
  };
}
