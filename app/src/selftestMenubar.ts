// Self-test `menubar`: the menu bar item (app/src-tauri/src/menubar/) in the real app, on the invented workspace of
// app/scripts/readme-shots (a stand-in `claude`, no model calls). The item is created hidden (never drawn in the
// person's menu bar), so everything is checked on its state and contents, never on pixels:
//
// - it exists, is hidden, has no window on screen, and its tooltip says self-test;
// - its readings next to `top`, `vm_stat`, `df` and `sysctl vm.swapusage` read at the same moment;
// - the bar's title has one width for every CPU reading (tabular digits, padded to three);
// - its counts (working / needs you / done) are the app's own, session by session;
// - the needs-you mark follows a chat that asks for permission, and goes when it is answered (gone altogether when
//   nothing else waits: run without `workspace.py live` for that);
// - the menu as built (as if opened): its rows, a click on the waiting session opens it on the Needs you page, New
//   session opens the sheet; processes map to their session;
// - the sampler's cadence: 2 s with the menu open, none with a bar that shows no figure;
// - Settings' switch removes and restores it;
// - the app's own CPU over a minute with the item on (CPU shown) and off, and the sampler's own time.
//
// Run it like readme-shots (run.sh's HOME, PATH and BACKGROUND switches) with COOOL_SELFTEST=menubar.

import { newChat } from "./lib/actions";
import { chatNeeds, chatStatus, useChats } from "./lib/chat";
import { attention, type ChatDigest } from "./lib/live";
import { sessionKey } from "./lib/types";
import { useStore } from "./store";

export interface MenubarKit {
  dir: string;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  log: (line: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
}

type Status = {
  exists: boolean;
  visible: boolean;
  hidden: boolean;
  bar_windows: number;
  title: string;
  tooltip: string;
  show: boolean;
  mode: string;
  open: boolean;
  samples: number;
  busy_ms: number;
  interval_ms: number;
  needs: number;
  reading: { cpu: number | null; memory: { used: number; total: number } | null; disk: { free: number } | null; load: number[] | null };
};
type Agents = { working: number; needs: number; done: number; needing: { key: string | null; chat: number | null; title: string; ask: string }[]; pids: { pid: number; key: string | null; chat: number | null; title: string }[] };
type MenuItem = { text: string; enabled: boolean; tip: string | null; view: boolean };

class Fail extends Error {}
const must = (ok: unknown, what: string) => {
  if (!ok) throw new Fail(what);
};

export function menubarScenarios(k: MenubarKit): Record<string, () => Promise<void>> {
  const { dir, invoke, log, sleep, waitFor, step } = k;
  const mb = <T>(action: string, arg?: unknown) => invoke("selftest_menubar", { action, arg: arg ?? null }) as Promise<T>;
  const status = () => mb<Status>("status");
  const agents = () => mb<Agents>("agents");
  const setPrefs = async (patch: { show?: boolean; mode?: string }) => {
    const p = (await invoke("prefs_get")) as { menubar: { show: boolean; mode: string } } & Record<string, unknown>;
    await invoke("prefs_set", { prefs: { ...p, menubar: { ...p.menubar, ...patch } } });
  };
  /** Polls `f` until it holds (the item works on its own thread). */
  const until = async <T>(what: string, f: () => Promise<T | null | false>, ms = 15_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await f();
      if (v) return v;
      if (Date.now() > end) throw new Fail(`timed out waiting for ${what}`);
      await sleep(250);
    }
  };
  /** The app's own reading of each top-level session (lib/live.ts `attention`), counted the menu's way. */
  const appCounts = () => {
    const chats = useChats.getState().chats;
    const d: ChatDigest = { needs: {}, status: {} };
    for (const c of Object.values(chats)) {
      if (!c.ready && !c.items.length) continue;
      d.status[c.id] = chatStatus(c);
      const n = chatNeeds(c);
      if (n) d.needs[c.id] = n;
    }
    let working = 0,
      needs = 0,
      done = 0;
    const needing: string[] = [];
    for (const s of useStore.getState().sessions) {
      if (s.nested) continue;
      const a = attention(s, d);
      if (a.needs) {
        needs++;
        needing.push(sessionKey(s));
      } else if (a.status === "busy") working++;
      else if (a.status === "idle") done++;
    }
    return { working, needs, done, needing };
  };
  const ownChats = () => new Set(Object.keys(useChats.getState().chats).map(Number));

  return {
    async menubar() {
      await step("menubar: the item exists, hidden, nothing on screen, marked as a self-test", async () => {
        const s = await until("the item", async () => {
          const s = await status();
          return s.exists && s.samples >= 2 ? s : null;
        });
        must(!s.visible && s.hidden, "the item is visible");
        must(s.bar_windows === 0, `${s.bar_windows} status-bar windows on screen`);
        must(s.tooltip.startsWith("coool self-test"), `tooltip "${s.tooltip}"`);
        must(s.mode === "cpu" && /^ ?[ \d]{3}%$/.test(s.title.replace(/^ /, "").replace(/^● /, "")), `title "${s.title}" in mode ${s.mode}`);
        return `title "${s.title}" · tooltip "${s.tooltip}" · ${s.samples} samples, interval ${s.interval_ms} ms`;
      });

      await step("menubar: its readings match top, vm_stat, df and sysctl read at the same moment", async () => {
        type C = { cpu: { ours: number; top: number }; memory_used: { ours: number; vm_stat: number; total: number }; swap_used: { ours: number; sysctl: number }; disk_free: { ours: number; df: number }; load: number[] };
        const c = await mb<C>("compare");
        const gib = (b: number) => (b / 2 ** 30).toFixed(2);
        const cpuOff = Math.abs(c.cpu.ours - c.cpu.top);
        const memOff = Math.abs(c.memory_used.ours - c.memory_used.vm_stat) / c.memory_used.total;
        const diskOff = Math.abs(c.disk_free.ours - c.disk_free.df) / Math.max(1, c.disk_free.df);
        const swapOff = Math.abs(c.swap_used.ours - c.swap_used.sysctl);
        const line = `CPU ${c.cpu.ours.toFixed(1)}% vs top ${c.cpu.top.toFixed(1)}% · memory used ${gib(c.memory_used.ours)} vs vm_stat ${gib(c.memory_used.vm_stat)} GiB of ${gib(c.memory_used.total)} · disk free ${gib(c.disk_free.ours)} vs df ${gib(c.disk_free.df)} GiB · swap ${gib(c.swap_used.ours)} vs sysctl ${gib(c.swap_used.sysctl)} GiB · load ${c.load.map((x) => x.toFixed(2)).join(" ")}`;
        await log(`menubar compare: ${line}`);
        // CPU moves second to second and top itself costs some: within 15 points over the same 2 s.
        must(cpuOff <= 15, `CPU off by ${cpuOff.toFixed(1)} points`);
        must(memOff <= 0.02, `memory off by ${(memOff * 100).toFixed(2)}% of the total`);
        must(diskOff <= 0.005, `disk off by ${(diskOff * 100).toFixed(3)}%`);
        must(swapOff <= 64 * 2 ** 20, `swap off by ${gib(swapOff)} GiB`);
        return line;
      });

      await step("menubar: the bar's title is one width for every CPU reading", async () => {
        const out: string[] = [];
        for (const mode of ["cpu", "cpu_memory"]) {
          const w = await mb<number[]>("widths", mode);
          must(w.length === 1, `${mode}: widths ${w.join(", ")} pt`);
          out.push(`${mode} ${w[0]} pt`);
        }
        return `0..100%: ${out.join(" · ")}`;
      });

      await step("menubar: its counts are the app's, session by session", async () => {
        await waitFor("the invented sessions", () => useStore.getState().sessions.length >= 12, 60_000);
        let last = "";
        await until(
          "the same counts",
          async () => {
            const [a, app] = [await agents(), appCounts()];
            last = `menu ${a.working}/${a.needs}/${a.done} vs app ${app.working}/${app.needs}/${app.done}`;
            const keys = a.needing.map((n) => n.key ?? "").sort().join(",");
            return a.working === app.working && a.needs === app.needs && a.done === app.done && keys === [...app.needing].sort().join(",");
          },
          20_000,
        ).catch(() => {
          throw new Fail(last);
        });
        return `working / needs you / done: ${last}`;
      });

      let chat = -1;
      let base = 0;
      await step("menubar: the needs-you mark follows a chat that asks for permission", async () => {
        base = (await agents()).needs;
        const before = ownChats();
        await newChat({ provider: "claude", cwd: `${dir}/invoices`, model: "opus", permissionMode: "acceptEdits", prompt: "Why do invoices from March show the wrong month?" });
        chat = (await waitFor("the new chat", () => {
          const id = [...ownChats()].find((i) => !before.has(i));
          return id === undefined ? null : { id };
        }, 15_000)).id;
        await waitFor("the permission request", () => useChats.getState().chats[chat]?.pendingPermission, 60_000);
        const s = await until("the mark", async () => {
          const s = await status();
          return s.needs === base + 1 && s.title.includes("●") ? s : null;
        });
        const a = await agents();
        must(a.needing.some((n) => n.chat === chat), "the chat isn't among the ones needing you");
        return `needs ${base} -> ${s.needs}, title "${s.title}", tooltip "${s.tooltip}"`;
      });

      await step("menubar: the menu as built, and a click on the waiting session opens it on the Needs you page", async () => {
        await mb("open");
        try {
          return await menuChecks();
        } finally {
          await mb("close");
        }
      });

      await step("menubar: the open menu (never shown) sits under the bar, its read-only rows at full contrast and aligned with the native ones", async () => {
        type Row = { text: string; x: number; right: number | null; row_height: number | null };
        type View = Row & { enabled: boolean; in_window: boolean; color: string; detail_color: string | null };
        type Probe = {
          drop: number;
          geometry: { bar_bottom: number; bar_height: number; top_before: number; top_after: number; moved: boolean; item_bar_height: number | null; thickness: number; text_x: number } | null;
          relayout_top: number | null;
          updated_top: number;
          natives: Row[];
          views: View[];
          renders: Record<string, { darkest: number; brightest: number; pixels: number; png: string | null }>;
        };
        // AppKit opened the person's menu about 36 pt below the bar: the probe opens it there.
        const p = await mb<Probe>("probe", 36);
        await log(`menubar probe: ${JSON.stringify(p)}`);
        const g = p.geometry;
        must(g, "no geometry: the menu's window wasn't found");
        must(Math.abs(g!.top_before - (g!.bar_bottom - 36)) <= 2, `opened with its top at ${g!.top_before}, bar bottom ${g!.bar_bottom}`);
        must(g!.moved && Math.abs(g!.top_after - g!.bar_bottom) <= 1, `top after ${g!.top_after}, bar bottom ${g!.bar_bottom}`);
        must(Math.abs(p.updated_top - g!.bar_bottom) <= 1, `after a relayout (AppKit put it back at ${p.relayout_top}) and an update in place: top ${p.updated_top}`);
        must(p.views.length >= 6 && p.natives.length >= 3, `${p.views.length} views, ${p.natives.length} native rows`);
        for (const v of p.views) {
          must(v.in_window && !v.enabled, `"${v.text}": in the menu ${v.in_window}, enabled ${v.enabled}`);
          const want = v.text.includes("\t") ? "label" : "secondary";
          must(v.color === want, `"${v.text}": ${v.color}, want ${want}`);
          must(v.detail_color === null || v.detail_color === "secondary", `"${v.text}" second line: ${v.detail_color}`);
        }
        const xs = [...p.natives, ...p.views].map((r) => r.x);
        const rights = [...p.natives, ...p.views].flatMap((r) => (r.right === null ? [] : [r.right]));
        const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
        must(spread(xs) <= 1, `text x from ${Math.min(...xs)} to ${Math.max(...xs)}`);
        must(p.natives.some((n) => n.right !== null), "no native row with a figure to compare with");
        must(rights.length >= 5 && spread(rights) <= 1,`figures' right edges from ${Math.min(...rights)} to ${Math.max(...rights)}`);
        const [light, dark] = [p.renders.light, p.renders.dark];
        must(light && light.pixels > 50 && light.darkest <= 0.15, `light: ${JSON.stringify(light)}`);
        must(dark && dark.pixels > 50 && dark.brightest >= 0.85, `dark: ${JSON.stringify(dark)}`);
        return `bar ${g!.bar_height} pt, bottom ${g!.bar_bottom}; opened with its top ${(g!.bar_bottom - g!.top_before).toFixed(1)} pt below, moved to ${(g!.bar_bottom - g!.top_after).toFixed(1)} pt; after a relayout AppKit put it back ${(g!.bar_bottom - (p.relayout_top ?? g!.bar_bottom)).toFixed(1)} pt below, after the update in place ${(g!.bar_bottom - p.updated_top).toFixed(1)} pt; text x ${Math.min(...xs)}..${Math.max(...xs)} over ${p.natives.length} native rows and ${p.views.length} views; figures' right edge ${Math.min(...rights).toFixed(2)}..${Math.max(...rights).toFixed(2)}; views disabled, colours label/secondary; offscreen row: light darkest ${light.darkest.toFixed(3)}, dark brightest ${dark.brightest.toFixed(3)}`;
      });

      await step("menubar: with the menu closed again, the sampler is back to the bar's pace", async () => {
        const s = await until("2 s, menu closed", async () => {
          const s = await status();
          return !s.open && s.interval_ms === 2000 ? s : null;
        });
        return `interval ${s.interval_ms} ms`;
      });

      async function menuChecks() {
        const items = await until("the menu's rows", async () => {
          const m = await mb<MenuItem[]>("menu");
          return m.some((i) => i.text.startsWith("CPU\t")) && m.some((i) => i.text === "Open coool") ? m : null;
        });
        const st = await status();
        must(st.open && st.interval_ms === 2000, `open menu: interval ${st.interval_ms} ms`);
        await log(`menubar menu:\n${items.map((i, n) => `  ${n} ${i.enabled ? "*" : i.view ? "v" : " "} ${i.text.replace(/\n/g, " ⏎ ")}`).join("\n")}`);
        for (const want of ["This Mac", "Busiest processes", "coool", "Open coool", "New session…", "Quit coool"]) must(items.some((i) => i.text === want), `no "${want}" row`);
        for (const want of ["CPU\t", "Memory\t", "Disk\t", "Sessions\t"]) must(items.some((i) => i.text.startsWith(want)), `no "${want}" row`);
        must(items.filter((i) => i.text.startsWith("Memory\t"))[0]?.tip?.includes("Activity Monitor"), "memory row doesn't say what it is");
        // Rows only read are views (AppKit dims a disabled item's own title, not its view); rows that act stay native.
        for (const i of items) if (i.text !== "---") must(i.view === !i.enabled, `"${i.text.split("\n")[0]}": enabled ${i.enabled}, view ${i.view}`);
        const a = await agents();
        const mine = a.needing.find((n) => n.chat === chat)!;
        const row = items.find((i) => i.enabled && i.text.startsWith("● ") && i.text.includes(mine.title.slice(0, 20)));
        must(row, `no row for "${mine.title}"`);
        useStore.getState().closeNeeds();
        await mb("click", row!.text.slice(0, 24));
        const key = await waitFor("the Needs you page on it", () => {
          const s = useStore.getState();
          return s.needsPage && s.needsPick ? s.needsPick : null;
        }, 10_000);
        const s = useStore.getState().sessions.find((x) => x.chat === chat);
        must(!s || key === sessionKey(s), `opened ${key}`);
        useStore.getState().closeNeeds();
        await mb("click", "New session…");
        await waitFor("the New session sheet", () => useStore.getState().sheet?.kind === "new", 10_000);
        useStore.getState().setSheet(null);
        return `${items.length} items; "${row!.text.split("\n")[0]}" opened ${key}; New session opened the sheet`;
      }

      await step("menubar: processes map to their session", async () => {
        const a = await agents();
        const p = a.pids.find((x) => x.chat === chat);
        must(p, "the chat's CLI pid isn't known");
        const rows = await mb<{ pid: number; name: string; owner: { key: string | null; chat: number | null } | null; is_cli: boolean }[]>("procs", 1000);
        const r = rows.find((x) => x.pid === p!.pid);
        must(r && r.is_cli && r.owner?.chat === chat, `pid ${p!.pid} not tied to chat ${chat}: ${JSON.stringify(r)}`);
        return `${rows.length} processes tied to sessions; the chat's CLI ${r!.name} (pid ${r!.pid}) -> ${r!.owner?.key ?? `chat ${chat}`}; ${a.pids.length} CLI pids known`;
      });

      await step("menubar: answering the request takes the mark away again", async () => {
        const req = useChats.getState().chats[chat]?.pendingPermission;
        must(req, "no request to answer");
        await invoke("chat_respond_permission", { id: chat, requestId: req, allow: true, always: false, remember: null });
        const s = await until("the count back", async () => {
          const s = await status();
          return s.needs === base ? s : null;
        }, 30_000);
        must((s.needs > 0) === s.title.includes("●"), `needs ${s.needs} but title "${s.title}"`);
        return `needs back to ${s.needs}; title "${s.title}"${base === 0 ? " (no mark)" : " (other sessions still wait: mark stays)"}`;
      });

      await step("menubar: a bar with no figure reads nothing of the Mac", async () => {
        await setPrefs({ mode: "nothing" });
        const s0 = await until("no interval", async () => {
          const s = await status();
          return s.interval_ms === 0 && s.mode === "nothing" ? s : null;
        });
        await sleep(6000);
        const s1 = await status();
        must(s1.samples === s0.samples, `${s1.samples - s0.samples} samples taken in 6 s`);
        must(!/\d%/.test(s1.title), `title "${s1.title}"`);
        await setPrefs({ mode: "needs" });
        const s2 = await until("the needs mode", async () => {
          const s = await status();
          // The count beside the mark when any session needs you, nothing otherwise.
          return s.mode === "needs" && (s.needs > 0 ? s.title.trim() === `● ${s.needs}` : s.title.trim() === "") ? s : null;
        });
        await setPrefs({ mode: "cpu" });
        await until("sampling again", async () => (await status()).interval_ms === 2000);
        return `nothing: 0 samples in 6 s, title "${s1.title}"; needs: title "${s2.title}"`;
      });

      await step("menubar: Settings' switch removes and restores it", async () => {
        await setPrefs({ show: false });
        await until("removed", async () => {
          const s = await status();
          return !s.exists && s.bar_windows === 0;
        });
        await setPrefs({ show: true });
        const s = await until("back", async () => {
          const s = await status();
          return s.exists && !s.visible ? s : null;
        });
        return `removed, then back (hidden) with title "${s.title}"`;
      });

      await step("menubar: the app's own CPU over 30 s with the menu open (rows updated in place every 2 s)", async () => {
        type P = { app: { cpu_ms: number } | null };
        await setPrefs({ show: true, mode: "cpu" });
        await mb("open");
        try {
          await sleep(3000);
          const [a, s0] = [(await invoke("selftest_perf_stats")) as P, await status()];
          const t = Date.now();
          await sleep(30_000);
          const [b, s1] = [(await invoke("selftest_perf_stats")) as P, await status()];
          const wall = (Date.now() - t) / 1000;
          const pct = ((b.app!.cpu_ms - a.app!.cpu_ms) / 1000 / wall) * 100;
          const line = `menu open 30 s: app process CPU ${pct.toFixed(2)}% of one core; the sampler ${s1.samples - s0.samples} samples, ${(s1.busy_ms - s0.busy_ms).toFixed(1)} ms`;
          await log(`menubar menu-open cost: ${line}`);
          return line;
        } finally {
          await mb("close");
        }
      });

      await step("menubar: the app's own CPU over a minute with the item on and off", async () => {
        type P = { app: { cpu_ms: number } | null };
        const measure = async (secs: number) => {
          const [a, s0] = [(await invoke("selftest_perf_stats")) as P, await status()];
          const t = Date.now();
          await sleep(secs * 1000);
          const [b, s1] = [(await invoke("selftest_perf_stats")) as P, await status()];
          const wall = (Date.now() - t) / 1000;
          return { pct: ((b.app!.cpu_ms - a.app!.cpu_ms) / 1000 / wall) * 100, sampler: s1.exists ? s1.busy_ms - s0.busy_ms : 0, samples: s1.exists ? s1.samples - s0.samples : 0, load: s1.reading.load ?? s0.reading.load };
        };
        await setPrefs({ show: true, mode: "cpu" });
        await sleep(3000);
        const on = await measure(60);
        await setPrefs({ show: false });
        await sleep(3000);
        const off = await measure(60);
        await setPrefs({ show: true });
        const line = `app process CPU: item on (CPU shown) ${on.pct.toFixed(2)}% of one core, off ${off.pct.toFixed(2)}%; the sampler itself: ${on.samples} samples, ${on.sampler.toFixed(1)} ms in a minute (${((on.sampler / 60_000) * 100).toFixed(3)}%); load average at the time ${(on.load ?? []).map((x) => x.toFixed(1)).join(" ")}`;
        await log(`menubar overhead: ${line}`);
        return line;
      });
    },
  };
}
