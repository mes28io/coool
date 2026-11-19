// Self-test `chat-window`: the long-timeline window (components/Windowed.tsx, CHAT_SPEC "Long timelines"), pass/fail,
// on a made-up chat (no CLI, nothing reaches a model; runs on the synthetic perf home too) and, when the home has
// one, a long transcript session. Each step drives the real UI and checks what is on screen:
//   opening at the bottom with a few rows drawn; streaming at the bottom sticks; the top and the middle are drawn
//   when scrolled to; streaming while scrolled up moves nothing (the jump button says "new"); the item cap dropping
//   the oldest rows moves nothing; a step group opened mid-list keeps its place; a checkpoint far above is drawn and
//   jumped to; a subagent card far above (focusAgent) is drawn and brought into view; a question set aside with
//   "Later" reopens into view from the top; a selection across two rows survives a small scroll and copies both;
//   resizing keeps the row read (scrolled up) or the bottom (pinned); a transcript session's timeline is windowed too.

import { chatQueue, useChats } from "./lib/chat";
import type { ChatEvent, Session } from "./lib/types";
import { sessionKey } from "./lib/types";
import { useStore } from "./store";

export interface WindowKit {
  step: (name: string, f: () => Promise<string | void>) => Promise<void>;
  sleep: (ms: number) => Promise<unknown>;
  waitFor: <T>(what: string, f: () => T | null | undefined | false, ms?: number) => Promise<T>;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  shot: (name: string) => Promise<unknown>;
  fail: (msg: string) => Error;
}

const ID = 90_002;

export function windowScenarios(k: WindowKit): Record<string, () => Promise<void>> {
  const { step, sleep, waitFor } = k;
  let seq = 0;
  const ev = (e: Record<string, unknown>): ChatEvent => ({ seq: ++seq, ts: Date.now() + seq, ...e }) as unknown as ChatEvent;
  const WORDS = "the quick brown fox jumps over a lazy dog while agents edit files and run tests in parallel".split(" ");
  const sentence = (n: number, s = 0) => Array.from({ length: n }, (_, i) => WORDS[(i * 7 + n + s) % WORDS.length]).join(" ");
  const AGENT_TURN = 200;
  const agentId = `ag${AGENT_TURN}`;

  function history(turns: number): ChatEvent[] {
    const out: ChatEvent[] = [ev({ type: "ready", session_id: null, model: "claude-haiku-5-5", cwd: "/tmp/win", permission_mode: "default", slash_commands: [], models: [], agents: [], context_window: 200000 })];
    for (let t = 0; t < turns; t++) {
      out.push(ev({ type: "user_message", id: `u${t}`, text: `Turn ${t}: ${sentence(10, t)}` }));
      out.push(ev({ type: "state", state: "working" }));
      for (let i = 0; i < 6; i++) {
        const id = `t${t}-${i}`;
        out.push(ev({ type: "tool_start", id, name: i % 2 ? "Read" : "Bash", summary: i % 2 ? `src/file${i}.ts` : `npm test -- ${i}`, input: i % 2 ? { file_path: `/tmp/win/src/file${i}.ts` } : { command: `npm test -- ${i}` }, parent_tool_id: null }));
        out.push(ev({ type: "tool_end", id, ok: true, output: sentence(30, i) }));
      }
      if (t === AGENT_TURN) {
        out.push(ev({ type: "tool_start", id: agentId, name: "Agent", summary: "Look around", input: { description: "Look around", prompt: "look", subagent_type: "general-purpose" }, parent_tool_id: null }));
        out.push(ev({ type: "tool_start", id: `${agentId}-c`, name: "Read", summary: "a.ts", input: { file_path: "/tmp/win/a.ts" }, parent_tool_id: agentId }));
        out.push(ev({ type: "tool_end", id: `${agentId}-c`, ok: true, output: "x" }));
        out.push(ev({ type: "tool_end", id: agentId, ok: true, output: "found it" }));
      }
      out.push(ev({ type: "assistant_message", id: `a${t}`, text: `## Result ${t}\n\n${sentence(50, t)}\n\n- ${sentence(8, t)}\n- ${sentence(9, t)}`, model: "claude-haiku-5-5", parent_tool_id: null }));
      out.push(ev({ type: "turn_end", duration_ms: 12_000, ok: true }));
      out.push(ev({ type: "state", state: "idle" }));
    }
    return out;
  }

  const el = () => document.querySelector<HTMLElement>(`[data-chat-timeline="${ID}"]`);
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const settle = async (ms = 250) => {
    await raf2();
    await sleep(ms);
    await raf2();
  };
  const gap = (s: HTMLElement) => Math.round(s.scrollHeight - s.scrollTop - s.clientHeight);
  const rows = (s: HTMLElement) => [...s.querySelectorAll<HTMLElement>("[data-vrow]")];
  const inView = (s: HTMLElement, n: Element | null) => {
    if (!n) return false;
    const a = s.getBoundingClientRect();
    const b = n.getBoundingClientRect();
    return b.bottom > a.top && b.top < a.bottom;
  };
  /** The first drawn row that starts inside the view, and its top relative to the view. */
  const firstRow = (s: HTMLElement) => {
    const top = s.getBoundingClientRect().top;
    for (const r of rows(s)) {
      const t = r.getBoundingClientRect().top - top;
      if (t >= 0 && t < s.clientHeight) return { key: r.dataset.vrow!, top: Math.round(t), node: r };
    }
    return null;
  };
  const topOf = (s: HTMLElement, key: string) => {
    const n = s.querySelector<HTMLElement>(`[data-vrow="${CSS.escape(key)}"]`);
    return n ? Math.round(n.getBoundingClientRect().top - s.getBoundingClientRect().top) : null;
  };
  /** Where things are, for a failure message. */
  const where = (s: HTMLElement, key?: string) => {
    const n = key ? s.querySelector<HTMLElement>(`[data-vrow="${CSS.escape(key)}"], [data-block="${CSS.escape(key)}"]`) : null;
    return `scrollTop ${Math.round(s.scrollTop)}/${s.scrollHeight} view ${s.clientHeight} drawn ${rows(s).map((r) => r.dataset.vrow).slice(0, 3).join(",")}…(${rows(s).length})${key ? ` ${key} ${n ? `at ${Math.round(n.getBoundingClientRect().top - s.getBoundingClientRect().top)}` : "not drawn"}` : ""}`;
  };
  const middle = async (s: HTMLElement) => {
    s.scrollTop = Math.round(s.scrollHeight / 2);
    await settle(400);
  };
  /** Streams a reply into the chat as the backend's batches would (`tools`: steps started and ended along the way). */
  async function stream(ms: number, tools = 0, tag = "s") {
    chatQueue.push(ID, [ev({ type: "state", state: "working" })]);
    const end = performance.now() + ms;
    let i = 0;
    while (performance.now() < end) {
      chatQueue.push(ID, [ev({ type: "text_delta", message_id: `${tag}-m`, text: i % 20 === 19 ? `${sentence(3, i)}.\n\n` : `${sentence(3, i)} `, parent_tool_id: null }), ev({ type: "live_output", tokens: i * 3 })]);
      if (tools && i % 15 === 7) {
        const id = `${tag}-t${i}`;
        chatQueue.push(ID, [ev({ type: "tool_start", id, name: "Bash", summary: `make ${i}`, input: { command: `make ${i}` }, parent_tool_id: null })]);
        chatQueue.push(ID, [ev({ type: "tool_end", id, ok: true, output: "ok" })]);
      }
      i++;
      await sleep(16);
    }
    chatQueue.push(ID, [ev({ type: "assistant_message", id: `${tag}-m`, text: sentence(3 * i), model: "claude-haiku-5-5", parent_tool_id: null })]);
    await settle(300);
  }

  return {
    async "chat-window"() {
      useStore.setState({ tabs: [], activeTab: null });
      seq = 0;
      useChats.getState().replace(ID, { id: ID, provider: "claude", cwd: "/tmp/win", session_id: null, model: "claude-haiku-5-5", state: "idle", running: true }, history(250), 0);
      useStore.getState().open({ kind: "chat", id: ID }, { newTab: true });
      const total = () => useChats.getState().chats[ID]?.items.length ?? 0;

      await step("window: a 1500-item chat opens at the bottom with only the rows near it drawn", async () => {
        const s = await waitFor("the chat on screen", el, 20_000);
        await settle(600);
        const drawn = rows(s).length;
        const blocks = Number(s.querySelector("[data-windowed]")?.getAttribute("data-windowed"));
        if (gap(s) > 2) throw k.fail(`not at the bottom: ${gap(s)}px below`);
        if (drawn > 60 || drawn < 3) throw k.fail(`${drawn} of ${blocks} rows drawn`);
        const last = rows(s).pop();
        if (!inView(s, last ?? null)) throw k.fail("the last row isn't in view");
        await k.shot("window-open");
        return `${total()} items, ${blocks} rows, ${drawn} drawn, at the bottom`;
      });

      await step("window: streaming at the bottom follows it", async () => {
        const s = el()!;
        let worst = 0;
        const watch = setInterval(() => (worst = Math.max(worst, gap(s))), 120);
        await stream(2500, 1, "bottom");
        clearInterval(watch);
        await settle(400);
        if (gap(s) > 2) throw k.fail(`left ${gap(s)}px from the bottom after streaming`);
        return `ends at the bottom (largest gap while it streamed ${worst}px, a reveal frame behind)`;
      });

      await step("window: the top and the middle are drawn when scrolled to", async () => {
        const s = el()!;
        s.scrollTop = 0;
        await settle(400);
        const box = s.querySelector<HTMLElement>("[data-windowed]")!;
        const first = box.firstElementChild as HTMLElement | null;
        const firstKey = first?.dataset.vrow;
        if (!firstKey) throw k.fail(`the list starts with ${first?.outerHTML.slice(0, 80)}, not a drawn row`);
        if (!inView(s, first)) throw k.fail("the first row isn't in view at the top");
        await k.shot("window-top");
        await middle(s);
        const f = firstRow(s);
        if (!f) throw k.fail("nothing drawn in the middle");
        const covered = rows(s).filter((r) => inView(s, r)).reduce((n, r) => n + Math.min(r.getBoundingClientRect().bottom, s.getBoundingClientRect().bottom) - Math.max(r.getBoundingClientRect().top, s.getBoundingClientRect().top), 0);
        if (covered < s.clientHeight * 0.6) throw k.fail(`only ${Math.round(covered)}px of ${s.clientHeight} covered by rows in the middle`);
        await k.shot("window-middle");
        return `top: ${firstKey} in view; middle: ${rows(s).length} rows drawn, ${Math.round(covered)}px of the view covered`;
      });

      await step("window: streaming while scrolled up moves nothing, the button says there is more", async () => {
        const s = el()!;
        const a = firstRow(s)!;
        const st = s.scrollTop;
        await stream(2500, 1, "up");
        const now = topOf(s, a.key);
        if (now === null || Math.abs(now - a.top) > 1) throw k.fail(`row ${a.key} moved from ${a.top} to ${now}`);
        const jump = document.querySelector("[data-jump-bottom]")?.getAttribute("data-jump-bottom");
        if (jump !== "new") throw k.fail(`jump button ${jump}`);
        return `row ${a.key} stays at ${a.top}px (scrollTop ${st} → ${s.scrollTop}); jump button "new"`;
      });

      await step("window: the item cap dropping the oldest rows moves nothing", async () => {
        const s = el()!;
        const a = firstRow(s)!;
        const oldest = useChats.getState().chats[ID]!.items[0].key;
        for (let i = 0; i < 40; i++) chatQueue.push(ID, [ev({ type: "tool_start", id: `cap${i}`, name: "Bash", summary: `cap ${i}`, input: { command: `cap ${i}` }, parent_tool_id: null })]);
        await settle(500);
        const nowOldest = useChats.getState().chats[ID]!.items[0].key;
        if (nowOldest === oldest) throw k.fail("nothing was dropped");
        const now = topOf(s, a.key);
        if (now === null || Math.abs(now - a.top) > 1) throw k.fail(`row ${a.key} moved from ${a.top} to ${now}`);
        for (let i = 0; i < 40; i++) chatQueue.push(ID, [ev({ type: "tool_end", id: `cap${i}`, ok: true, output: "ok" })]);
        await settle(300);
        return `oldest ${oldest} → ${nowOldest}; row ${a.key} stays at ${a.top}px`;
      });

      await step("window: a step group opened mid-list keeps its place, the rows above it too", async () => {
        const s = el()!;
        const top = s.getBoundingClientRect().top;
        const head = [...s.querySelectorAll<HTMLButtonElement>("[data-vrow] button")].find((b) => /^Ran \d+ steps/.test(b.textContent ?? "") && b.getBoundingClientRect().top - top > s.clientHeight * 0.25 && b.getBoundingClientRect().top - top < s.clientHeight * 0.6);
        if (!head) throw k.fail("no folded step group in the middle of the view");
        const a = firstRow(s)!;
        const before = Math.round(head.getBoundingClientRect().top - top);
        const row = head.closest<HTMLElement>("[data-vrow]")!;
        const h0 = row.offsetHeight;
        head.click();
        await settle(700);
        const after = Math.round(head.getBoundingClientRect().top - top);
        if (Math.abs(after - before) > 1) throw k.fail(`the group's header moved ${before} → ${after}`);
        const ta = topOf(s, a.key);
        if (ta === null || Math.abs(ta - a.top) > 1) throw k.fail(`row ${a.key} moved ${a.top} → ${ta}`);
        const h1 = row.offsetHeight;
        if (h1 <= h0) throw k.fail("the group didn't open");
        head.click();
        await settle(500);
        return `header stays at ${before}px, the group grew ${h0} → ${h1}px`;
      });

      await step("window: a checkpoint far above is drawn and jumped to", async () => {
        const s = el()!;
        s.scrollTop = s.scrollHeight;
        await settle(500);
        const card = await waitFor("the checkpoints card", () => document.querySelector<HTMLElement>(`[data-chat-timeline="${ID}"] [data-checkpoints]`), 5_000);
        (card.querySelector("button[aria-expanded]") as HTMLElement).click();
        await settle(600);
        const target = useChats.getState().chats[ID]!.items.find((i) => i.kind === "prompt")!;
        const rowBtn = [...card.querySelectorAll<HTMLButtonElement>("button[title]")].find((b) => b.title.startsWith((target as { text: string }).text.slice(0, 12)));
        if (!rowBtn) throw k.fail("no checkpoint row for the oldest turn");
        const trace: number[] = [];
        const tr = setInterval(() => trace.push(Math.round(s.scrollTop)), 40);
        rowBtn.click();
        setTimeout(() => clearInterval(tr), 1500);
        const block = await waitFor("the turn's block in view", () => {
          const b = s.querySelector<HTMLElement>(`[data-block="${CSS.escape(target.key)}"]`);
          return b && inView(s, b) ? b : null;
        }, 4_000).catch(() => {
          throw k.fail(`not in view: ${where(s, target.key)}; scrollTop after the click ${trace.join(" ")}`);
        });
        await settle(600);
        if (!inView(s, block)) throw k.fail("scrolled away again");
        (card.querySelector("button[aria-expanded]") as HTMLElement).click();
        await settle(400);
        return `${target.key} drawn and in view (top ${Math.round(block.getBoundingClientRect().top - s.getBoundingClientRect().top)}px)`;
      });

      await step("window: a subagent card far above (focusAgent) is drawn and brought into view", async () => {
        const s = el()!;
        s.scrollTop = s.scrollHeight;
        await settle(500);
        if (s.querySelector(`[data-agent-card="${agentId}"]`)) throw k.fail("the card was drawn before it was asked for");
        const trace: number[] = [];
        const tr = setInterval(() => trace.push(Math.round(s.scrollTop)), 40);
        setTimeout(() => clearInterval(tr), 1500);
        useStore.getState().focusAgent(agentId);
        const c = await waitFor("the card in view", () => {
          const n = s.querySelector<HTMLElement>(`[data-agent-card="${agentId}"]`);
          return n && inView(s, n) ? n : null;
        }, 3_000).catch(() => {
          const n = s.querySelector<HTMLElement>(`[data-agent-card="${agentId}"]`);
          throw k.fail(`not in view: ${where(s)}; card ${n ? `at ${Math.round(n.getBoundingClientRect().top - s.getBoundingClientRect().top)}` : "not drawn"}; scrollTop ${trace.join(" ")}`);
        });
        await sleep(1200);
        if (!inView(s, c)) throw k.fail("the card left the view");
        await k.shot("window-focus-agent");
        return `card drawn, in view at ${Math.round(c.getBoundingClientRect().top - s.getBoundingClientRect().top)}px`;
      });

      await step("window: a question set aside with Later reopens into view from the top", async () => {
        const s = el()!;
        const req = "win-q1";
        chatQueue.push(ID, [ev({ type: "state", state: "working" }), ev({ type: "question", request_id: req, questions: [{ id: "q", header: "Colour", question: "Which colour?", options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }], multi_select: false, allow_other: false, secret: false }] })]);
        await waitFor("the question card", () => s.querySelector(`[data-question="${req}"]`), 4_000);
        await settle(400);
        (await waitFor("Later", () => document.querySelector<HTMLElement>("[data-question-later-button]"), 3_000)).click();
        await settle(400);
        s.scrollTop = 0;
        await settle(400);
        (await waitFor("the Later line", () => document.querySelector<HTMLElement>(`[data-question-later="${req}"]`), 3_000)).click();
        const card = await waitFor("the card in view", () => {
          const n = s.querySelector<HTMLElement>(`[data-question="${req}"]`);
          return n && inView(s, n) ? n : null;
        }, 3_000).catch(() => {
          const n = s.querySelector<HTMLElement>(`[data-question="${req}"]`);
          throw k.fail(`not in view: ${where(s)}; card ${n ? `at ${Math.round(n.getBoundingClientRect().top - s.getBoundingClientRect().top)}` : "not drawn"}`);
        });
        await k.shot("window-question");
        // Settle it: the turn ends (the question with it).
        chatQueue.push(ID, [ev({ type: "turn_end", duration_ms: 1000, ok: true }), ev({ type: "state", state: "idle" })]);
        // A question settled counts as input: the chat glides to the bottom and stays pinned while it does.
        await settle(1200);
        return `card ${card.dataset.question} in view after scrolling to the top`;
      });

      await step("window: a selection across two rows copies both and survives a small scroll", async () => {
        const s = el()!;
        await middle(s);
        const texts = rows(s)
          .filter((r) => inView(s, r))
          .map((r) => r.querySelector(".md p, .selectable"))
          .filter(Boolean) as HTMLElement[];
        if (texts.length < 2) {
          await k.shot("window-selection-fail");
          throw k.fail(`only ${texts.length} text rows in view: ${where(s)}`);
        }
        const [a, b] = [texts[0], texts[texts.length - 1]];
        const r = document.createRange();
        r.setStart(a, 0);
        r.setEnd(b, b.childNodes.length);
        const sel = getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
        const want = [a.textContent!.trim().slice(0, 20), b.textContent!.trim().slice(-20)];
        s.scrollTop += 120;
        await settle(400);
        const got = sel.toString();
        if (!sel.anchorNode?.isConnected || !sel.focusNode?.isConnected) throw k.fail("the selection's ends left the DOM");
        if (!want.every((w) => got.includes(w))) throw k.fail(`selection "${got.slice(0, 80)}…" lacks ${JSON.stringify(want)}`);
        sel.removeAllRanges();
        return `${got.length} chars from two rows, still selected after scrolling 120px`;
      });

      await step("window: resizing keeps the row being read (scrolled up) and the bottom (pinned)", async () => {
        const s = el()!;
        await middle(s);
        const a = firstRow(s)!;
        await k.invoke("selftest_resize", { width: 1000, height: 760 });
        await settle(800);
        const t1 = topOf(s, a.key);
        await k.invoke("selftest_resize", { width: 1440, height: 900 });
        await settle(800);
        const t2 = topOf(s, a.key);
        if (t1 === null || t2 === null || Math.abs(t1 - a.top) > 2 || Math.abs(t2 - a.top) > 2) throw k.fail(`row ${a.key} at ${a.top} → ${t1} → ${t2}: ${where(s)}`);
        s.scrollTop = s.scrollHeight;
        await settle(500);
        await k.invoke("selftest_resize", { width: 1000, height: 760 });
        await settle(800);
        const g1 = gap(s);
        await k.invoke("selftest_resize", { width: 1440, height: 900 });
        await settle(800);
        const g2 = gap(s);
        if (g1 > 2 || g2 > 2) throw k.fail(`pinned view left the bottom: ${g1}px, ${g2}px`);
        return `row ${a.key} stays at ${a.top}px through two resizes; pinned stays at the bottom`;
      });

      useStore.setState({ tabs: [], activeTab: null });
      useChats.setState((st) => {
        const chats = { ...st.chats };
        delete chats[ID];
        return { chats };
      });

      // A transcript session's timeline (Activity.tsx): the longest one the home has.
      const big = [...useStore.getState().sessions].sort((x, y) => y.activity.length - x.activity.length)[0] as Session | undefined;
      if (big && big.activity.length > 60)
        await step("window: a long transcript session is windowed: top, middle, bottom drawn when scrolled to", async () => {
          const st = useStore.getState();
          st.setMode({ kind: "session", key: sessionKey(big) }, "activity");
          st.open({ kind: "session", key: sessionKey(big) }, { newTab: true });
          const s = await waitFor("the timeline", () => document.querySelector<HTMLElement>("[data-main] [data-activity-timeline]"), 20_000);
          await settle(800);
          const n = Number(s.querySelector("[data-windowed]")?.getAttribute("data-windowed"));
          const drawn0 = rows(s).length;
          if (gap(s) > 2) throw k.fail(`not at the bottom (${gap(s)}px)`);
          s.scrollTop = 0;
          await settle(400);
          if (!inView(s, s.querySelector("[data-vrow]"))) throw k.fail("top: the first row isn't in view");
          await middle(s);
          if (!firstRow(s)) throw k.fail("middle: nothing drawn");
          s.scrollTop = s.scrollHeight;
          await settle(400);
          if (!inView(s, rows(s).pop() ?? null)) throw k.fail("bottom: the last row isn't in view");
          useStore.setState({ tabs: [], activeTab: null });
          return `${big.activity.length} entries, ${n} rows, ${drawn0} drawn at open`;
        });
    },
  };
}
