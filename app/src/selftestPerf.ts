// Self-test `perf-*` scenarios: numbers, not pass/fail (docs/PERF.md says how to run them and what they found).
// Each logs `PERF ...` lines: CPU time, wakeups and memory of coool's processes (app, WebKit content, GPU) over a
// window, what the backend sent and started (sessions payloads, git processes, context maps), the IPC calls the
// page made and how often the counted components rendered (lib/perfCount.ts). Prefer the counts: CPU and wall
// times move with whatever else the machine is doing.
//
// perf-boot    launch → first script, first sessions payload, sidebar filled, initial load done (run twice: the
//              first run of a fresh self-test folder parses cold, the second reads the self-test's own cache).
// perf-idle    60 s each: Home / Mission control in front, the window hidden, the busiest session open.
// perf-long    the sessions with the most activity: open time, then scrolling top to bottom (frame gaps).
// perf-stream  a long coool chat (3000 items, made up on the page; no CLI) streaming a reply for 15 s, then tool
//              steps: renders per batch, frame gaps, page CPU.
// perf-soak    5 min of perf-stream style events into the long chat with the sessions view live: memory growth.

import { ipcCalls as ipc, renders } from "./lib/perfCount";
import { useChats } from "./lib/chat";
import type { ChatEvent, Session } from "./lib/types";
import { sessionKey } from "./lib/types";
import { useStore } from "./store";

export interface PerfKit {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  log: (line: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
}

interface Proc {
  pid: number;
  cpu_ms: number;
  wakeups: number;
  footprint: number;
}
interface Stats {
  now_ms: number;
  process_start_ms: number;
  first_publish_ms: number;
  loaded_ms: number;
  app: Proc | null;
  web: Proc | null;
  gpu: Proc | null;
  refreshes: number;
  publishes: number;
  publish_bytes: number;
  chat_batches: number;
  pty_chunks: number;
  git_trails: number;
  git_spawns: number;
  context_maps: number;
  boot: [string, number][];
}
interface Snap {
  t: number;
  s: Stats;
  renders: Record<string, number>;
  ipc: Record<string, number>;
}

const MB = (b: number) => (b / (1 << 20)).toFixed(1);
const r1 = (x: number) => (Math.round(x * 10) / 10).toString();

function diffMap(a: Record<string, number>, b: Record<string, number>): [string, number][] {
  return Object.keys(b)
    .map((k) => [k, b[k] - (a[k] ?? 0)] as [string, number])
    .filter(([, n]) => n > 0)
    .sort((x, y) => y[1] - x[1]);
}

export function perfScenarios(k: PerfKit): Record<string, () => Promise<void>> {
  const stats = () => k.invoke("selftest_perf_stats") as Promise<Stats>;
  const snap = async (): Promise<Snap> => ({ t: performance.now(), s: await stats(), renders: { ...renders }, ipc: { ...ipc } });

  /** One `PERF <name>` block: per-second rates over the window between two snaps. */
  async function report(name: string, a: Snap, b: Snap) {
    const secs = (b.t - a.t) / 1000;
    const per = (x: number) => r1(x / secs);
    const proc = (tag: string, pa: Proc | null, pb: Proc | null) =>
      pa && pb && pa.pid === pb.pid ? `${tag}_cpu_ms_per_s=${per(pb.cpu_ms - pa.cpu_ms)} ${tag}_wakeups_per_s=${per(pb.wakeups - pa.wakeups)} ${tag}_mb=${MB(pb.footprint)}` : `${tag}=n/a`;
    const s0 = a.s;
    const s1 = b.s;
    await k.log(
      `PERF ${name} secs=${r1(secs)} ${proc("app", s0.app, s1.app)} ${proc("web", s0.web, s1.web)} ${proc("gpu", s0.gpu, s1.gpu)} ` +
        `refreshes=${s1.refreshes - s0.refreshes} publishes=${s1.publishes - s0.publishes} publish_kb=${r1((s1.publish_bytes - s0.publish_bytes) / 1024)} ` +
        `git_trails=${s1.git_trails - s0.git_trails} git_spawns=${s1.git_spawns - s0.git_spawns} context_maps=${s1.context_maps - s0.context_maps} chat_batches=${s1.chat_batches - s0.chat_batches}`,
    );
    const calls = diffMap(a.ipc, b.ipc);
    await k.log(`PERF ${name} ipc total=${calls.reduce((n, [, x]) => n + x, 0)} ${calls.map(([c, n]) => `${c}=${n}`).join(" ")}`);
    const rs = diffMap(a.renders, b.renders);
    await k.log(`PERF ${name} renders total=${rs.reduce((n, [, x]) => n + x, 0)} ${rs.map(([c, n]) => `${c}=${n}`).join(" ")}`);
  }

  async function measure(name: string, settleMs: number, measureMs: number) {
    await k.sleep(settleMs);
    const a = await snap();
    await k.sleep(measureMs);
    await report(name, a, await snap());
  }

  /** Frame gaps (ms between animation frames) while `f` runs. */
  async function frames<T>(f: () => Promise<T>): Promise<{ v: T; gaps: number[] }> {
    const gaps: number[] = [];
    let last = performance.now();
    let on = true;
    const tick = (t: number) => {
      gaps.push(t - last);
      last = t;
      if (on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const v = await f();
    on = false;
    return { v, gaps };
  }
  const pct = (xs: number[], p: number) => {
    const v = [...xs].sort((x, y) => x - y);
    return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN;
  };
  const gapLine = (g: number[]) => `frames=${g.length} gap_p50=${r1(pct(g, 0.5))} gap_p95=${r1(pct(g, 0.95))} gap_max=${r1(Math.max(0, ...g))} over50=${g.filter((x) => x > 50).length}`;
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const home = async () => {
    useStore.setState({ activeTab: null, settings: null });
    await raf2();
  };
  const closeAllTabs = () => useStore.setState({ tabs: [], activeTab: null });
  const openSession = (s: Session) => {
    const st = useStore.getState();
    st.setMode({ kind: "session", key: sessionKey(s) }, "activity");
    st.open({ kind: "session", key: sessionKey(s) }, { newTab: true });
  };
  const actCount = (s: Session) => s.activity.length + s.agents.reduce((n, a) => n + a.activity.length, 0);

  // ---------- a made-up long chat (no CLI): what streaming costs the page ----------

  const FAKE = 90_001;
  let seq = 0;
  const ev = (e: Record<string, unknown>): ChatEvent => ({ seq: ++seq, ts: Date.now(), ...e }) as unknown as ChatEvent;
  const WORDS = "the quick brown fox jumps over a lazy dog while agents edit files and run tests in parallel".split(" ");
  const sentence = (n: number) => Array.from({ length: n }, (_, i) => WORDS[(i * 7 + n) % WORDS.length]).join(" ");
  function history(turns: number): ChatEvent[] {
    const out: ChatEvent[] = [ev({ type: "ready", session_id: null, model: "claude-haiku-5-5", cwd: "/tmp/perf", permission_mode: "default", slash_commands: [], models: [], agents: [], context_window: 200000 })];
    for (let t = 0; t < turns; t++) {
      out.push(ev({ type: "user_message", id: `u${t}`, text: `Turn ${t}: ${sentence(14)}` }));
      out.push(ev({ type: "state", state: "working" }));
      for (let i = 0; i < 6; i++) {
        const id = `t${t}-${i}`;
        out.push(ev({ type: "tool_start", id, name: i % 2 ? "Read" : "Bash", summary: i % 2 ? `src/file${i}.ts` : `npm test -- ${i}`, input: i % 2 ? { file_path: `/tmp/perf/src/file${i}.ts` } : { command: `npm test -- ${i}` }, parent_tool_id: null }));
        out.push(ev({ type: "tool_end", id, ok: true, output: sentence(40) }));
      }
      out.push(ev({ type: "assistant_message", id: `a${t}`, text: `## Result ${t}\n\n${sentence(60)}\n\n- ${sentence(8)}\n- ${sentence(9)}\n\n\`\`\`ts\nconst x = ${t};\n\`\`\``, model: "claude-haiku-5-5", parent_tool_id: null }));
      out.push(ev({ type: "usage", model: "claude-haiku-5-5", tokens: { input: 1000 + t, cached: 5000, output: 300, context: 20000 + t * 10 }, context_window: 200000 }));
      out.push(ev({ type: "turn_end", duration_ms: 12_000, ok: true }));
      out.push(ev({ type: "state", state: "idle" }));
    }
    return out;
  }
  async function openFakeChat(turns: number) {
    seq = 0;
    useChats.getState().replace(FAKE, { id: FAKE, provider: "claude", cwd: "/tmp/perf", session_id: null, model: "claude-haiku-5-5", state: "idle", running: true }, history(turns), 0);
    useStore.getState().open({ kind: "chat", id: FAKE }, { newTab: true });
    await k.waitFor("the made-up chat on screen", () => document.querySelector(`[data-chat-timeline="${FAKE}"]`), 20_000);
    await raf2();
  }
  /** Streams a reply: one batch every ~16 ms (like the backend's pump), `secs` long; then `tools` tool steps. */
  /** Main-thread ms spent applying batches and rendering what they changed (React flushes in a microtask). */
  let jsMs = 0;
  async function stream(secs: number, tools: number, turn: number) {
    const apply = async (events: ChatEvent[]) => {
      const t = performance.now();
      useChats.getState().apply(FAKE, events);
      await Promise.resolve();
      await Promise.resolve();
      jsMs += performance.now() - t;
    };
    await apply([ev({ type: "user_message", id: `su${turn}`, text: sentence(12) }), ev({ type: "state", state: "working" })]);
    const end = performance.now() + secs * 1000;
    let batches = 0;
    while (performance.now() < end) {
      await apply([ev({ type: "text_delta", message_id: `sa${turn}`, text: batches % 25 === 24 ? `${sentence(3)}.\n\n` : `${sentence(3)} `, parent_tool_id: null }), ev({ type: "live_output", tokens: batches * 3 })]);
      batches++;
      await k.sleep(16);
    }
    await apply([ev({ type: "assistant_message", id: `sa${turn}`, text: sentence(3 * batches), model: "claude-haiku-5-5", parent_tool_id: null })]);
    for (let i = 0; i < tools; i++) {
      await apply([ev({ type: "tool_start", id: `st${turn}-${i}`, name: "Bash", summary: `make ${i}`, input: { command: `make ${i}` }, parent_tool_id: null })]);
      batches++;
      await k.sleep(30);
      await apply([ev({ type: "tool_end", id: `st${turn}-${i}`, ok: true, output: sentence(30) })]);
      batches++;
      await k.sleep(30);
    }
    await apply([ev({ type: "turn_end", duration_ms: secs * 1000, ok: true }), ev({ type: "state", state: "idle" })]);
    return batches;
  }

  return {
    async "perf-boot"() {
      await k.waitFor("the initial load", () => !useStore.getState().loading && useStore.getState().ready, 120_000).catch(() => {});
      await k.sleep(1000);
      const s = await stats();
      const at = (name: string) => {
        const m = performance.getEntriesByName(name)[0];
        return m ? Math.round(performance.timeOrigin + m.startTime - s.process_start_ms) : -1;
      };
      const st = useStore.getState();
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const origin = Math.round(performance.timeOrigin - s.process_start_ms);
      await k.log(`PERF boot window at screen ${window.screenX},${window.screenY} page=${document.visibilityState} focused=${document.hasFocus()}`);
      await k.log(`PERF boot backend ms_from_launch: ${s.boot.map(([n, t]) => `${n}=${t - s.process_start_ms}`).join(" ")}`);
      await k.log(`PERF boot ms_from_launch: page_start=${origin} html_loaded=${nav ? Math.round(origin + nav.responseEnd) : -1} dom_ready=${nav ? Math.round(origin + nav.domContentLoadedEventEnd) : -1}`);
      await k.log(
        `PERF boot ms_from_launch: js=${at("coool-js")} render=${at("coool-render")} first_payload_be=${s.first_publish_ms ? s.first_publish_ms - s.process_start_ms : -1} ready=${at("coool-ready")} sidebar=${at("coool-sidebar")} loaded_be=${s.loaded_ms ? s.loaded_ms - s.process_start_ms : -1} loaded=${at("coool-loaded")}`,
      );
      await k.log(
        `PERF boot sessions=${st.allSessions.length} listed=${st.sessions.length} activity=${st.allSessions.reduce((n, x) => n + actCount(x), 0)} sidebar_rows=${document.querySelectorAll("button[data-nav]").length} publishes=${s.publishes} publish_kb=${r1(s.publish_bytes / 1024)} app_cpu_ms=${Math.round(s.app?.cpu_ms ?? 0)} web_cpu_ms=${Math.round(s.web?.cpu_ms ?? 0)} app_mb=${MB(s.app?.footprint ?? 0)} web_mb=${MB(s.web?.footprint ?? 0)} renders=${Object.values(renders).reduce((a, b) => a + b, 0)}`,
      );
    },

    async "perf-idle"() {
      closeAllTabs();
      await home();
      const live = useStore.getState().allSessions.filter((s) => s.status !== "ended").length;
      await k.log(`PERF idle live_sessions=${live} page=${document.visibilityState} focused=${document.hasFocus()}`);
      await measure("idle-home", 15_000, 60_000);
      // Which loops run on screen (not paused by lib/animPause.ts).
      const loops = [".needs-ring", ".needs-badge", ".breathe", ".shimmer", ".sweep", ".attn-card", ".seg-run", ".spin", ".work-spin", ".think-dots", ".caret", ".skel", ".mg", ".md-live"];
      await k.log(`PERF idle loops on screen: ${loops.map((c) => `${c}=${[...document.querySelectorAll(c)].filter((e) => !e.closest("[data-anim-off]")).length}`).join(" ")}`);
      // The same with every CSS loop paused (what lib/animPause.ts does for a hidden window): the share of the loops.
      document.documentElement.classList.add("page-hidden");
      await measure("idle-home-paused-loops", 5_000, 60_000);
      document.documentElement.classList.toggle("page-hidden", document.hidden);
      const pick = [...useStore.getState().sessions].sort((x, y) => Number(y.status === "busy") - Number(x.status === "busy") || y.updated - x.updated)[0];
      if (pick) {
        openSession(pick);
        await k.log(`PERF idle-chat session status=${pick.status} activity=${actCount(pick)}`);
        await measure("idle-chat", 15_000, 60_000);
        closeAllTabs();
        await home();
      }
      // Last: after a hide and show WebKit may keep throttling an out-of-sight window (COOOL_SELFTEST_OFFSCREEN).
      await k.invoke("selftest_window", { action: "hide" });
      await measure("idle-home-hidden", 5_000, 60_000);
      await k.invoke("selftest_window", { action: "show" });
    },

    /** Which CSS loop costs what on Home with live sessions: 40 s per variant, the variant as an injected style. */
    async "perf-loops"() {
      closeAllTabs();
      await home();
      const style = document.createElement("style");
      document.head.appendChild(style);
      const variants: [string, string][] = [
        ["as-is", ""],
        ["spin-paused", ".work-spin{animation-play-state:paused!important}"],
        ["spin-linear", ".work-spin{animation-timing-function:linear!important}"],
        ["others-paused", ":is(.needs-ring,.needs-badge,.breathe,.shimmer,.sweep,.attn-card,.seg-run,.spin,.think-dots,.caret,.skel,.mg,.md-live),:is(.needs-ring,.needs-badge,.breathe,.shimmer,.sweep,.attn-card,.seg-run,.spin,.think-dots,.caret,.skel,.mg,.md-live) *,.sweep::after{animation-play-state:paused!important}"],
      ];
      for (const [name, css] of variants) {
        style.textContent = css;
        await measure(`loops-${name}`, 5_000, 40_000);
      }
      style.remove();
    },

    async "perf-long"() {
      closeAllTabs();
      await home();
      const big = [...useStore.getState().sessions].sort((x, y) => actCount(y) - actCount(x)).slice(0, 3);
      for (const [n, s] of big.entries()) {
        const a = await snap();
        const t0 = performance.now();
        openSession(s);
        const el = await k.waitFor("the timeline, laid out", () => document.querySelector<HTMLElement>("[data-main] [data-activity-timeline]")?.scrollHeight ? document.querySelector<HTMLElement>("[data-main] [data-activity-timeline]") : null, 20_000);
        await raf2();
        const openMs = performance.now() - t0;
        const b = await snap();
        await report(`long-open-${n}`, a, b);
        await k.log(`PERF long-open-${n} activity=${actCount(s)} blocks=${el.querySelectorAll("[data-block], .cv-auto").length} open_ms=${Math.round(openMs)} dom_nodes=${el.getElementsByTagName("*").length}`);
        // Scroll from the top to the bottom in viewport steps, one per frame.
        el.scrollTop = 0;
        await raf2();
        const { v: steps, gaps } = await frames(async () => {
          let i = 0;
          while (el.scrollTop + el.clientHeight < el.scrollHeight - 2 && i < 400) {
            el.scrollTop += el.clientHeight;
            i++;
            await new Promise((r) => requestAnimationFrame(r));
          }
          return i;
        });
        await k.log(`PERF long-scroll-${n} steps=${steps} height=${el.scrollHeight} ${gapLine(gaps)}`);
        await report(`long-scroll-${n}`, b, await snap());
        closeAllTabs();
        await k.sleep(1500);
      }
    },

    async "perf-stream"() {
      closeAllTabs();
      const t0 = performance.now();
      await openFakeChat(250);
      await k.log(`PERF stream-open items=${useChats.getState().chats[FAKE]?.items.length} open_ms=${Math.round(performance.now() - t0)}`);
      await k.sleep(3000);
      const a = await snap();
      jsMs = 0;
      const { v: batches, gaps } = await frames(() => stream(15, 20, 1));
      const b = await snap();
      await report("stream", a, b);
      const r = diffMap(a.renders, b.renders);
      const of = (c: string) => r.find(([x]) => x === c)?.[1] ?? 0;
      // ~60 batches a second unless the page's timers are throttled (then the CPU and time numbers mean little).
      await k.log(`PERF stream timer_check batches_per_s=${r1(batches / ((b.t - a.t) / 1000))} page=${document.visibilityState}`);
      await k.log(`PERF stream batches=${batches} js_ms_per_batch=${r1(jsMs / batches)} per_batch: ChatTimeline=${r1(of("ChatTimeline") / batches)} ItemView=${r1(of("Chat.ItemView") / batches)} Steps=${r1(of("Chat.Steps") / batches)} LiveTurnBar=${r1(of("LiveTurnBar") / batches)} ${gapLine(gaps)}`);
      // The same stream with the chat not on screen (Home): what the store alone costs.
      await home();
      await k.sleep(2000);
      const c = await snap();
      jsMs = 0;
      const n2 = await stream(10, 0, 2);
      await report("stream-offscreen", c, await snap());
      await k.log(`PERF stream-offscreen batches=${n2} js_ms_per_batch=${r1(jsMs / n2)}`);
      closeAllTabs();
      useChats.setState((s) => {
        const chats = { ...s.chats };
        delete chats[FAKE];
        return { chats };
      });
    },

    async "perf-soak"() {
      closeAllTabs();
      await openFakeChat(250);
      const a = await snap();
      for (let i = 0; i < 10; i++) {
        await stream(20, 10, 100 + i);
        const s = await stats();
        await k.log(`PERF soak round=${i} items=${useChats.getState().chats[FAKE]?.items.length} app_mb=${MB(s.app?.footprint ?? 0)} web_mb=${MB(s.web?.footprint ?? 0)}`);
      }
      await report("soak", a, await snap());
      closeAllTabs();
    },
  };
}
