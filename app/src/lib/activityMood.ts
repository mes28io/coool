// What the agent is doing now -> which orb and which words. One table, used by every place that
// shows the "now" indicator (timeline, chat, Home card line, Agents strip). Waiting on the person
// is deliberately absent: that state has its own markers and no orb.

import { parseMcp, rowText, toolRowFromText } from "./toolNames";

export type Mood = "think" | "plan" | "search" | "read" | "write" | "run" | "delegate" | "start" | "compact" | "other";
export type MoodOrb = "solving" | "shaping" | "searching" | "composing" | "working" | "weaving" | "connecting" | "breathing";

export const MOODS: Record<Mood, { orb: MoodOrb; words: string[] }> = {
  think: { orb: "solving", words: ["Thinking", "Pondering", "Musing", "Reasoning", "Mulling", "Deliberating", "Puzzling", "Weighing"] },
  plan: { orb: "shaping", words: ["Planning", "Architecting", "Mapping", "Charting", "Sketching", "Outlining"] },
  search: { orb: "searching", words: ["Searching", "Hunting", "Scanning", "Sifting", "Looking"] },
  read: { orb: "searching", words: ["Reading", "Studying", "Skimming", "Absorbing"] },
  write: { orb: "composing", words: ["Writing", "Editing", "Crafting", "Drafting", "Composing", "Chiselling"] },
  run: { orb: "working", words: ["Running", "Executing", "Building", "Crunching", "Brewing"] },
  delegate: { orb: "weaving", words: ["Orchestrating", "Delegating", "Coordinating", "Weaving"] },
  start: { orb: "connecting", words: ["Starting", "Connecting", "Warming up"] },
  compact: { orb: "breathing", words: ["Compacting", "Tidying", "Distilling"] },
  other: { orb: "working", words: ["Working", "Tinkering", "Wrangling"] },
};

/**
 * The mood of a tool call, from its name (Claude and Codex spellings, MCP tools). Extends the
 * classifier `toolIcon` uses for step icons (same buckets: shell, edit, read, search, agent) with
 * the ones that only matter here: plan, compact.
 */
export function toolMood(name: string | null | undefined): Mood {
  const n = (name ?? "").toLowerCase();
  if (!n) return "think";
  // coool-device (Claude `mcp__coool-device__x`, Codex `coool-device.x`): reading the screen reads, typing writes, the rest acts.
  const dev = /^(?:mcp__coool-device__|coool-device\.)(.+)$/.exec(n)?.[1];
  if (dev) return /observe|screenshot|navigate|wait_for/.test(dev) ? "read" : /type$/.test(dev) ? "write" : /shell/.test(dev) ? "run" : "other";
  if (/compact|summari[sz]e/.test(n)) return "compact";
  if (/plan|todo/.test(n)) return "plan";
  if (/^(agent|task)$|subagent/.test(n)) return "delegate";
  if (/grep|glob|search|find|\brg\b|ripgrep/.test(n)) return "search";
  if (/^read|notebookread|view|image|fetch|^cat$/.test(n)) return "read";
  if (/write|edit|apply_patch|patch|notebookedit/.test(n)) return "write";
  if (/bash|shell|exec|command|terminal/.test(n)) return "run";
  return "other";
}

/** From a session's `current` line ("Tool · detail", "thinking…" or null) and whether subagents are running. */
export function moodOfCurrent(current: string | null | undefined, runningAgents = 0): { mood: Mood; name: string | null; detail: string } {
  if (!current || /^thinking/i.test(current)) return { mood: runningAgents > 0 ? "delegate" : "think", name: null, detail: "" };
  const m = /^(.+?)\s·\s(.*)$/.exec(current);
  const name = m ? m[1] : current.split(/\s/)[0];
  // MCP calls read as phrases ("Opened affectui.com"), never as the raw `mcp__server__tool` name.
  if (parseMcp(name)) return { mood: toolMood(name), name, detail: rowText(toolRowFromText(current)) };
  return { mood: toolMood(name), name, detail: m ? m[2] : "" };
}
