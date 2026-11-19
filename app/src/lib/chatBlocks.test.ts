// The chat timeline's blocks (lib/chatBlocks.ts): built again only from the turn that changed, they equal a build
// from scratch at every step of a long made-up chat (prompts, streamed replies, steps, subagents, task lists,
// artifacts published again, question tools, the item cap dropping the oldest), and blocks that didn't change stay
// the same objects.
// Run: node --test app/src/lib/chatBlocks.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatItem } from "./chat";
import { buildBlocks, sameBlock, type Block, type Built } from "./chatBlocks.ts";

type Tool = Extract<ChatItem, { kind: "tool" }>;

/** A small deterministic random generator. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

/** The chat as the reducer evolves it: each step returns a new array, changed items replaced, others kept. */
function* evolve(seed: number, steps: number, cap: number): Generator<ChatItem[]> {
  const r = rng(seed);
  let items: ChatItem[] = [];
  let n = 0;
  let ts = 1000;
  const running: number[] = [];
  const pages = ["https://a.example/p", "https://b.example/q", "https://c.example/r"];
  const set = (next: ChatItem[]) => {
    items = next.length > cap ? next.slice(next.length - cap) : next;
    return items;
  };
  const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
    kind: "tool",
    key: `k${++n}`,
    id: `t${n}`,
    name,
    summary: name,
    input: {},
    ts: (ts += 10),
    endTs: null,
    ok: null,
    output: "",
    parent: null,
    agent: name === "Agent",
    ...extra,
  });
  for (let s = 0; s < steps; s++) {
    const p = r();
    const last = items[items.length - 1];
    if (p < 0.08) yield set([...items, { kind: "prompt", key: `k${++n}`, id: `p${n}`, text: `prompt ${n}`, ts: (ts += 10) }]);
    else if (p < 0.4) {
      // A streamed delta: the last text grows, or a new text starts.
      if (last?.kind === "text" && last.streaming && r() < 0.85) yield set([...items.slice(0, -1), { ...last, text: last.text + " more" }]);
      else yield set([...items, { kind: "text", key: `k${++n}`, id: `m${n}`, text: "hello", ts: (ts += 10), streaming: true, parent: r() < 0.15 && running.length ? `t${running[0]}` : null, model: null }]);
    } else if (p < 0.55) {
      const names = ["Bash", "Read", "Edit", "Agent", "TodoWrite", "TaskCreate", "AskUserQuestion", "Grep"];
      const name = names[Math.floor(r() * names.length)];
      const extra: Partial<Tool> = {};
      if (name === "TodoWrite") extra.input = r() < 0.5 ? { _synthetic: true, todos: [] } : { todos: [] };
      if (r() < 0.2 && running.length) extra.parent = `t${running[Math.floor(r() * running.length)]}`;
      if (r() < 0.1) extra.artifact = { url: pages[Math.floor(r() * pages.length)], title: "page" } as Tool["artifact"];
      const t = tool(name, extra);
      running.push(n);
      yield set([...items, t]);
    } else if (p < 0.7 && running.length) {
      // A step ends (maybe one from an earlier turn).
      const id = running.splice(Math.floor(r() * running.length), 1)[0];
      const i = items.findIndex((x) => x.kind === "tool" && x.id === `t${id}`);
      if (i < 0) continue;
      const next = [...items];
      next[i] = { ...(items[i] as Tool), endTs: (ts += 10), ok: r() < 0.9, output: "done" };
      yield set(next);
    } else if (p < 0.78) {
      if (last?.kind === "text" && last.streaming) {
        yield set([...items.slice(0, -1), { ...last, streaming: false }]);
      } else yield set([...items, { kind: "thinking", key: `k${++n}`, id: `h${n}`, text: r() < 0.5 ? "" : "hmm", ts: (ts += 10), endTs: ts + 5, parent: null }]);
    } else if (p < 0.86) {
      yield set([...items, { kind: "turn", key: `k${++n}`, ts: (ts += 10), durationMs: 100, ok: r() < 0.8, failed: false, tools: 2, tokens: null }]);
    } else if (p < 0.9) {
      yield set([...items, { kind: "notice", key: `k${++n}`, level: "info", text: "note", needsTerminal: false, ts: (ts += 10) }]);
    } else {
      // Nothing changed (a usage event, say): the same array.
      yield items;
    }
  }
}

/** A block's content as plain data (items by key), to compare two builds. */
function shape(b: Block): unknown {
  switch (b.type) {
    case "item":
      return { t: b.type, k: b.key, item: b.item, span: b.span?.map((x) => x.key) };
    case "steps":
      return { t: b.type, k: b.key, tools: b.tools };
    case "artifact":
      return { t: b.type, k: b.key, url: b.info.url, versions: b.versions };
    case "plan":
      return { t: b.type, k: b.key, calls: b.calls, prompt: b.prompt, end: b.end };
  }
}

for (const [seed, cap] of [
  [1, 1500],
  [7, 60],
  [42, 25],
  [99, 200],
  [1234, 40],
] as const) {
  test(`built from the changed turn = built from scratch (seed ${seed}, cap ${cap})`, () => {
    let prev: Built | null = null;
    let steps = 0;
    for (const items of evolve(seed, 1500, cap)) {
      const inc = buildBlocks(items, prev);
      const full = buildBlocks(items, null);
      assert.deepEqual(inc.blocks.map(shape), full.blocks.map(shape), `step ${steps}`);
      assert.deepEqual([...inc.children].map(([k, v]) => [k, v.map((x) => x.key)]), [...full.children].map(([k, v]) => [k, v.map((x) => x.key)]), `children, step ${steps}`);
      // Unchanged blocks keep their objects.
      if (prev) {
        const old = new Map(prev.blocks.map((b) => [b.key, b]));
        for (const b of inc.blocks) {
          const o = old.get(b.key);
          if (o && sameBlock(o, b)) assert.equal(b, o, `block ${b.key} kept, step ${steps}`);
        }
      }
      prev = inc;
      steps++;
    }
    assert.ok(steps > 1000);
  });
}

test("a streamed token rebuilds only the last turn", () => {
  let prev: Built | null = null;
  let items: ChatItem[] = [];
  for (let t = 0; t < 50; t++) {
    items = [...items, { kind: "prompt", key: `p${t}`, id: `p${t}`, text: "go", ts: t * 10 }, { kind: "text", key: `x${t}`, id: `x${t}`, text: "a", ts: t * 10 + 1, streaming: false, parent: null, model: null }];
  }
  prev = buildBlocks(items, null);
  const last = items[items.length - 1] as Extract<ChatItem, { kind: "text" }>;
  const next = [...items.slice(0, -1), { ...last, text: "ab" }];
  const b = buildBlocks(next, prev);
  // Every block but the last is the previous build's object.
  for (let i = 0; i < b.blocks.length - 1; i++) assert.equal(b.blocks[i], prev.blocks[i]);
  assert.notEqual(b.blocks[b.blocks.length - 1], prev.blocks[prev.blocks.length - 1]);
});
