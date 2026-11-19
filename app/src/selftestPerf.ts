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
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { AnimGallery, AnimLab, LOOPS } from "./selftestAnim";
import { setMotionPref } from "./lib/motion";

export interface PerfKit {
  shot: (name: string, settle?: number) => Promise<unknown>;
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

  /** The animations running on the page, by name and property: `name(props)×n`, longest first. */
  function census() {
    const by = new Map<string, number>();
    let n = 0;
    for (const a of document.getAnimations()) {
      if (a.playState !== "running") continue;
      const eff = a.effect as KeyframeEffect | null;
      const iters = eff?.getComputedTiming().iterations;
      if (iters !== Infinity) continue; // one-off transitions and entrances end by themselves
      const name = (a as CSSAnimation).animationName ?? a.id ?? "js";
      const props = new Set<string>();
      for (const f of eff?.getKeyframes() ?? []) for (const p of Object.keys(f)) if (!["offset", "easing", "composite", "computedOffset"].includes(p)) props.add(p);
      const key = `${name}(${[...props].join("+")})`;
      by.set(key, (by.get(key) ?? 0) + 1);
      n++;
    }
    return { n, line: [...by].sort((x, y) => y[1] - x[1]).map(([k, c]) => `${k}x${c}`).join(" ") };
  }

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

    /**
     * What one kind of loop costs WebKit, alone: every animation of the app paused, then six copies of one test loop
     * (a 14px box in the corner of the window), 20 s each. `lab-none` is the floor.
     */
    async "perf-anim-lab"() {
      closeAllTabs();
      await home();
      const style = document.createElement("style");
      style.textContent = `
        :not(#perf-lab, #perf-lab *), :not(#perf-lab, #perf-lab *)::before, :not(#perf-lab, #perf-lab *)::after { animation-play-state: paused !important; }
        #perf-lab { position: fixed; left: 8px; bottom: 8px; z-index: 99999; display: flex; gap: 6px; padding: 4px; background: var(--bg); pointer-events: none; }
        #perf-lab > * { width: 14px; height: 14px; display: block; color: var(--status-running); }
        #perf-lab .box { border: 2.5px solid currentColor; border-right-color: transparent; border-radius: 50%; box-sizing: border-box; }
        #perf-lab .word { width: auto; height: auto; font-size: 13px; }
        @keyframes lab-spin { to { transform: rotate(360deg); } }
        @keyframes lab-fade { 50% { opacity: 0.4; } }
        @keyframes lab-dash { to { stroke-dashoffset: -1; } }
        @keyframes lab-hard { ${Array.from({ length: 4 }, (_, i) => `${i * 25}%, ${i * 25 + 24.99}% { transform: rotate(${i * 90}deg); }`).join(" ")} 100% { transform: rotate(270deg); } }
      `;
      document.head.appendChild(style);
      const lab = document.createElement("div");
      lab.id = "perf-lab";
      document.body.appendChild(lab);
      const svgRing = `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity=".22" stroke-width="2.8"/><path d="M8 2a6 6 0 016 6" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>`;
      const svgDots = `<svg viewBox="0 0 16 16"><circle cx="5" cy="8" r="1.4" fill="currentColor" style="animation: lab-fade 1.8s steps(5) infinite"/><circle cx="11" cy="8" r="1.4" fill="currentColor" style="animation: lab-fade 1.8s steps(5) infinite .3s"/></svg>`;
      const shimmer = `<span class="word shimmer">Thinking</span>`;
      let timer = 0;
      const variants: [string, string, string, (() => void)?][] = [
        ["none", "", ""],
        ["box-rot-linear", `<div class="box"></div>`, "animation: lab-spin 1s linear infinite"],
        ["box-rot-steps20", `<div class="box"></div>`, "animation: lab-spin 1s steps(20) infinite"],
        ["svg-rot-linear", svgRing, "animation: lab-spin 1s linear infinite"],
        ["svg-rot-steps20", svgRing, "animation: lab-spin 1s steps(20) infinite"],
        ["box-opacity-ease", `<div class="box"></div>`, "animation: lab-fade 1.8s ease-in-out infinite"],
        ["box-opacity-steps", `<div class="box"></div>`, "animation: lab-fade 1.8s steps(10) infinite"],
        ["svg-child-opacity-steps", svgDots, ""],
        ["svg-child-opacity-linear", svgDots.replaceAll("steps(5)", "linear"), ""],
        ["svg-child-transform-linear", `<svg viewBox="0 0 16 16"><g style="transform-origin:8px 8px;animation:lab-spin 1s linear infinite"><circle cx="8" cy="3" r="1.6" fill="currentColor"/></g></svg>`, ""],
        ["svg-dashoffset-linear", `<svg viewBox="0 0 16 16"><path d="M2 8H14" pathLength="1" stroke="currentColor" stroke-width="2" stroke-dasharray="1 3" style="animation:lab-dash 2s linear infinite"/></svg>`, ""],
        // Steps written as keyframes: holds joined by 0.01 % ramps, run with linear timing.
        ["box-rot-hardsteps", `<div class="box"></div>`, "animation: lab-hard 1s linear infinite"],
        ["shimmer-bgpos-steps", shimmer, ""],
        ["shimmer-bgpos-linear", shimmer.replace('class="word shimmer"', 'class="word shimmer" style="animation-timing-function:linear"'), ""],
        // One shared 12 Hz timer stepping a transform from JS (what a JS-driven stepped loop would cost).
        [
          "js-12hz-transform",
          `<div class="box"></div>`,
          "",
          () => {
            let i = 0;
            timer = window.setInterval(() => {
              i = (i + 1) % 20;
              lab.style.setProperty("--lab-a", `${i * 18}deg`);
            }, 83);
          },
        ],
      ];
      for (const [name, html, css, setup] of variants) {
        lab.innerHTML = "";
        lab.style.removeProperty("--lab-a");
        for (let i = 0; i < (html ? 6 : 0); i++) {
          const t = document.createElement("template");
          t.innerHTML = html.trim();
          const el = t.content.firstElementChild as HTMLElement;
          if (css) el.setAttribute("style", css);
          if (name.startsWith("js-")) el.style.transform = "rotate(var(--lab-a, 0deg))";
          lab.appendChild(el);
        }
        setup?.();
        await raf2();
        const c = census();
        await k.log(`PERF lab-${name} running=${c.n} ${c.line}`);
        await measure(`lab-${name}`, 4_000, 20_000);
        window.clearInterval(timer);
      }
      lab.remove();
      style.remove();
    },

    /**
     * What each of the app's own loops costs alone (selftestAnim.tsx `LOOPS`): every other animation paused, six
     * copies of the loop in the corner of the window, 15 s each.
     */
    async "perf-anim-app"() {
      closeAllTabs();
      await home();
      const style = document.createElement("style");
      style.textContent = ":not(#perf-lab, #perf-lab *), :not(#perf-lab, #perf-lab *)::before, :not(#perf-lab, #perf-lab *)::after { animation-play-state: paused !important; }";
      document.head.appendChild(style);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      for (const name of ["none", ...Object.keys(LOOPS)]) {
        root.render(name === "none" ? null : createElement(AnimLab, { name }));
        await k.sleep(1000);
        const c = census();
        await k.log(`PERF app-${name} running=${c.n} ${c.line}`);
        await measure(`app-${name}`, 3_000, 15_000);
      }
      root.unmount();
      host.remove();
      style.remove();
    },

    /**
     * The loops of each screen with live sessions, one at a time: Home, then the busiest live session. On each, the
     * running loops by name (`document.getAnimations()`), then 20 s as is, with all paused, and with each name paused.
     */
    async "perf-anim"() {
      closeAllTabs();
      await home();
      const style = document.createElement("style");
      document.head.appendChild(style);
      const screen = async (where: string) => {
        await k.sleep(4000);
        const c = census();
        await k.log(`PERF anim-${where} running=${c.n} ${c.line}`);
        style.textContent = "";
        await measure(`anim-${where}-as-is`, 2_000, 20_000);
        style.textContent = "*,*::before,*::after{animation-play-state:paused!important}";
        await measure(`anim-${where}-all-paused`, 2_000, 20_000);
        style.textContent = "";
        // Each running name paused alone (CSSAnimation.pause(), re-applied every second for rows that re-render).
        const names = [...new Set(document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity).map((a) => (a as CSSAnimation).animationName))];
        for (const n of names) {
          const hold = () => document.getAnimations().forEach((a) => (a as CSSAnimation).animationName === n && a.playState === "running" && a.pause());
          hold();
          const t = window.setInterval(hold, 1000);
          await measure(`anim-${where}-without-${n}`, 2_000, 20_000);
          window.clearInterval(t);
          document.getAnimations().forEach((a) => (a as CSSAnimation).animationName === n && a.playState === "paused" && a.play());
        }
      };
      await screen("home");
      const busy = [...useStore.getState().sessions].filter((s) => s.status === "busy").sort((x, y) => y.updated - x.updated)[0];
      if (busy) {
        openSession(busy);
        await screen("session");
        closeAllTabs();
        await home();
      }
      style.remove();
    },

    /**
     * Every loop on one page (selftestAnim.tsx), all paused and set to the same times, a window shot at each: frames
     * of one build to compare with another's. Logs each cell's rectangle (CSS px) for cropping; dark, light, and
     * the running loops with Reduce motion on, off and auto.
     */
    async "perf-anim-frames"() {
      closeAllTabs();
      await home();
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      root.render(createElement(AnimGallery));
      await k.waitFor("the gallery", () => document.querySelector("[data-anim-gallery]"), 10_000);
      await k.sleep(1500);
      const gal = document.querySelector<HTMLElement>("[data-anim-gallery]")!;
      const theme0 = document.documentElement.dataset.theme;
      const rects = () =>
        [...gal.querySelectorAll<HTMLElement>("[data-anim-cell]")].map((c) => {
          let [l, t, r, b] = [Infinity, Infinity, -Infinity, -Infinity];
          for (const e of [c, ...c.querySelectorAll("*")]) {
            const q = e.getBoundingClientRect();
            if (!q.width && !q.height) continue;
            [l, t, r, b] = [Math.min(l, q.left), Math.min(t, q.top), Math.max(r, q.right), Math.max(b, q.bottom)];
          }
          return `${c.dataset.animCell}:${Math.floor(l - 4)},${Math.floor(t - 4)},${Math.ceil(r - l + 8)},${Math.ceil(b - t + 8)}`;
        });
      await k.log(`PERF frames dpr=${devicePixelRatio} cells ${rects().join(" ")}`);
      const seek = (t: number) => {
        for (const a of gal.getAnimations({ subtree: true })) {
          if (a.effect?.getComputedTiming().iterations !== Infinity) {
            a.finish();
            continue;
          }
          a.pause();
          a.currentTime = t;
        }
      };
      for (const theme of ["dark", "light"]) {
        document.documentElement.dataset.theme = theme;
        await k.sleep(400);
        const c = census();
        await k.log(`PERF frames ${theme} running=${c.n} ${c.line}`);
        for (let t = 0; t <= 2400; t += 50) {
          seek(t);
          await raf2();
          await k.shot(`frame-${theme}-${String(t).padStart(4, "0")}`, 60);
        }
      }
      // Reduce motion: nothing may loop (the needs-you ring's slow breathe and dot excepted).
      for (const a of gal.getAnimations({ subtree: true })) if (a.playState === "paused") a.play();
      for (const p of ["on", "off", "auto"] as const) {
        setMotionPref(p);
        await k.sleep(600);
        const c = census();
        await k.log(`PERF frames reduce-motion=${p} running=${c.n} ${c.line}`);
        if (p === "on") {
          for (const t of [0, 600, 1200]) {
            seek(t);
            await raf2();
            await k.shot(`frame-reduce-${t}`, 60);
          }
        }
      }
      document.documentElement.dataset.theme = theme0;
      root.unmount();
      host.remove();
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
