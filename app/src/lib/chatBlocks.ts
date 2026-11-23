// The chat timeline's blocks (components/Chat.tsx): the items of a chat grouped as the timeline shows them (steps
// run together, one task-list card per turn, an artifact's card after its turn's reply), built again only from the
// turn that changed (see `buildBlocks`).

import type { ArtifactInfo } from "./types";
import type { ChatItem } from "./chat";
import { isPlanTool, isSyntheticPlan, isTaskNoise } from "./plan.ts";
import { isShowTool } from "./mediaRules.ts";

export type Tool = Extract<ChatItem, { kind: "tool" }>;

/** The tool behind a question or plan-approval card; the card stands for it, so it isn't listed as a step. */
const QUESTION_TOOLS = /^(AskUserQuestion|request_user_input|ExitPlanMode)$/;
export type Block =
  /** `span`: for a turn's end, the items of its turn (what "where the time went" reads). */
  | { type: "item"; key: string; item: ChatItem; span?: ChatItem[] }
  | { type: "steps"; key: string; tools: Tool[] }
  /** An artifact's newest publish; earlier publishes of the same page fold into it. */
  | { type: "artifact"; key: string; info: ArtifactInfo; versions: number }
  /** What an agent's `show` call put in its reply (pictures, videos, sounds), where it called it. */
  | { type: "media"; key: string; tool: Tool }
  /** One task-list card per turn (TodoWrite / update_plan calls), updated in place. */
  | { type: "plan"; key: string; calls: Tool[]; prompt: string; end: { ts: number; ok: boolean } | null };

export const NO_KIDS: ChatItem[] = [];

/** Before a top-level prompt is taken: where a build can resume (everything before it stays as it was). */
export type Mark = { at: number; blocks: number; turnNo: number; turnFrom: number };
export interface Built {
  items: ChatItem[];
  blocks: Block[];
  children: Map<string, ChatItem[]>;
  marks: Mark[];
  /** Each artifact page's first publish (item index). */
  urlFirst: Map<string, number>;
}

const pageOf = (it: ChatItem) => (it.kind === "tool" && !it.parent ? it.artifact : undefined);

/**
 * The timeline's blocks. With `prev` (the build for the previous items), only the turns from the first item that
 * changed are built again: a streamed token changes the last item, so a long chat's batch costs the same as a short
 * one's. Blocks before that turn are `prev`'s own objects.
 */
export function buildBlocks(items: ChatItem[], prev?: Built | null): Built {
  let mark: Mark | null = null;
  if (prev) {
    const m = Math.min(items.length, prev.items.length);
    let d = 0;
    while (d < m && items[d] === prev.items[d]) d++;
    for (let i = prev.marks.length - 1; i >= 0; i--)
      if (prev.marks[i].at <= d) {
        mark = prev.marks[i];
        break;
      }
    // A new version of a page first published before that turn moves its card back there: build it all.
    if (mark)
      for (let i = mark.at; i < items.length; i++) {
        const a = pageOf(items[i]);
        const f = a && prev.urlFirst.get(a.url);
        if (f !== undefined && f < mark.at) {
          mark = null;
          break;
        }
      }
  }
  const from = mark?.at ?? 0;
  const children = new Map<string, ChatItem[]>();
  for (const it of items) {
    const parent = "parent" in it ? it.parent : null;
    if (!parent) continue;
    const l = children.get(parent);
    if (l) l.push(it);
    else children.set(parent, [it]);
  }
  const blocks: Block[] = mark ? prev!.blocks.slice(0, mark.blocks) : [];
  const marks: Mark[] = mark ? prev!.marks.filter((x) => x.at < from) : [];
  const urlFirst = new Map<string, number>();
  if (mark) for (const [u, i] of prev!.urlFirst) if (i < from) urlFirst.set(u, i);
  let prompt = "";
  let plan: Extract<Block, { type: "plan" }> | null = null;
  // Turns whose task list comes from the driver's synthetic TodoWrite: their raw Task* steps are hidden.
  const synthetic = new Set<number>();
  for (let i = from, turn = mark?.turnNo ?? 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "prompt") turn++;
    else if (it.kind === "tool" && !it.parent && isSyntheticPlan(it)) synthetic.add(turn);
  }
  // Each page's last publish and its version count (artifactVersions, over the turns being built).
  const pages = new Map<string, { last: number; versions: number; info: ArtifactInfo }>();
  for (let i = from; i < items.length; i++) {
    const a = pageOf(items[i]);
    if (!a) continue;
    const o = pages.get(a.url);
    const icon = a.icon ?? o?.info.icon;
    pages.set(a.url, { last: i, versions: Math.max((o?.versions ?? 0) + 1, a.version ?? 0), info: icon === a.icon ? a : { ...a, icon } });
    if (!urlFirst.has(a.url)) urlFirst.set(a.url, i);
  }
  let turnNo = mark?.turnNo ?? 0;
  let turnFrom = mark?.turnFrom ?? 0;
  // Artifact cards wait for the end of their turn (its "worked for" row, or the next prompt), so they read as the
  // turn's result, after the reply that talks about them.
  let held: Block[] = [];
  const flush = () => {
    blocks.push(...held);
    held = [];
  };
  for (let idx = from; idx < items.length; idx++) {
    const it = items[idx];
    if ("parent" in it && it.parent) continue;
    if (it.kind === "tool" && QUESTION_TOOLS.test(it.name)) continue;
    if (it.kind === "tool" && isTaskNoise(it.name) && synthetic.has(turnNo)) continue;
    if (it.kind === "prompt" || it.kind === "turn") flush();
    if (it.kind === "prompt") {
      marks.push({ at: idx, blocks: blocks.length, turnNo, turnFrom });
      turnNo++;
      prompt = it.text;
      plan = null;
    }
    if (it.kind === "turn" && plan) plan.end = { ts: it.ts, ok: it.ok };
    if (it.kind === "tool" && isPlanTool(it.name)) {
      // The task list shows as its own card, not as step rows.
      if (!plan) blocks.push((plan = { type: "plan", key: it.key, calls: [], prompt, end: null }));
      plan.calls.push(it);
      continue;
    }
    if (it.kind === "tool" && it.artifact) {
      const p = pages.get(it.artifact.url)!;
      if (p.last === idx) held.push({ type: "artifact", key: `artifact:${it.artifact.url}`, info: p.info, versions: p.versions });
    } else if (it.kind === "tool" && isShowTool(it.name)) {
      blocks.push({ type: "media", key: it.key, tool: it });
    } else if (it.kind === "tool") {
      const last = blocks[blocks.length - 1];
      if (last?.type === "steps" && blocks.length > (mark?.blocks ?? 0)) last.tools.push(it);
      else blocks.push({ type: "steps", key: it.key, tools: [it] });
    } else if (it.kind === "thinking" && !it.text.trim() && it.endTs !== null) {
      // Empty, finished reasoning (provider hides it): nothing to show.
    } else if (it.kind === "turn") {
      blocks.push({ type: "item", key: it.key, item: it, span: items.slice(turnFrom, idx + 1) });
    } else blocks.push({ type: "item", key: it.key, item: it });
    if (it.kind === "turn") turnFrom = idx + 1;
  }
  flush();
  // Blocks the same as last time stay the same objects (so ChatBlock can skip them).
  if (prev) {
    const keep = mark?.blocks ?? 0;
    const old = new Map<string, Block>();
    for (let i = keep; i < prev.blocks.length; i++) old.set(prev.blocks[i].key, prev.blocks[i]);
    for (let i = keep; i < blocks.length; i++) {
      const o = old.get(blocks[i].key);
      if (o && sameBlock(o, blocks[i])) blocks[i] = o;
    }
  }
  return { items, blocks, children, marks, urlFirst };
}

export const sameList = <T,>(a: readonly T[], b: readonly T[]) => a === b || (a.length === b.length && a.every((x, i) => x === b[i]));

export function sameBlock(a: Block, b: Block): boolean {
  if (a.key !== b.key) return false;
  switch (a.type) {
    case "item":
      return b.type === "item" && a.item === b.item && sameList(a.span ?? NO_KIDS, b.span ?? NO_KIDS);
    case "steps":
      return b.type === "steps" && sameList(a.tools, b.tools);
    case "artifact":
      return b.type === "artifact" && a.info === b.info && a.versions === b.versions;
    case "media":
      return b.type === "media" && a.tool === b.tool;
    case "plan":
      return b.type === "plan" && a.prompt === b.prompt && sameList(a.calls, b.calls) && a.end?.ts === b.end?.ts && a.end?.ok === b.end?.ok;
  }
}

