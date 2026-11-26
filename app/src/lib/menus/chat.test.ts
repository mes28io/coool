// Run: node --test app/src/lib/menus/chat.test.ts (Node strips the types itself).
import { test } from "node:test";
import assert from "node:assert/strict";
import { codeItems, fileItems, linkItems, messageItems, projectItems, sessionItems, stepItems, tabItems, turnFilesItems, type SessionMenuIn } from "./chat.ts";
import type { MenuEntry } from "../contextMenu.ts";

const labels = (items: MenuEntry[]) => items.map((i) => (i === "-" ? "-" : i ? i.label : null)).filter((l) => l !== null).filter((l, n, a) => !(l === "-" && a[n - 1] === "-"));
const nop = () => {};

const base: SessionMenuIn = {
  title: "Fix the bug",
  id: "abc",
  pinned: false,
  running: false,
  restartable: false,
  visible: false,
  folder: "/p",
  chat: false,
  a: { newTab: nop, split: nop, rename: nop, auto: nop, restart: nop, stop: nop, terminal: nop, reveal: nop, copy: nop },
};

test("session menu: plain, idle", () => {
  assert.deepEqual(labels(sessionItems(base)), ["Open in new tab", "Open in split", "-", "Rename…", "-", "Copy title", "Copy session ID", "Reveal folder in Finder"]);
});

test("session menu: pinned, running chat", () => {
  const l = labels(sessionItems({ ...base, pinned: true, running: true, restartable: true, chat: true, visible: true }));
  assert.ok(l.includes("Use automatic title") && l.includes("Restart") && l.includes("Stop") && l.includes("Open in Terminal"));
  assert.ok(!l.includes("Open in split"));
});

test("session menu copies the title and the id", () => {
  const got: string[] = [];
  const m = sessionItems({ ...base, a: { ...base.a, copy: (t) => void got.push(t) } });
  for (const i of m) if (i && i !== "-" && "action" in i && i.label.startsWith("Copy")) void i.action();
  assert.deepEqual(got, ["Fix the bug", "abc"]);
});

test("project menu toggles its label", () => {
  const a = { newChat: nop, history: nop, reveal: nop, copy: nop, toggle: nop };
  assert.ok(labels(projectItems({ path: "/p", collapsed: true, a })).includes("Expand"));
  assert.ok(labels(projectItems({ path: "/p", collapsed: false, a })).includes("Collapse"));
});

test("message menu: Copy only with a selection", () => {
  assert.deepEqual(labels(messageItems({ selection: "", text: "hi", copy: nop })), ["Copy message"]);
  assert.deepEqual(labels(messageItems({ selection: "h", text: "hi", copy: nop, selectAll: nop })), ["Copy", "Copy message", "Select all in message"]);
});

test("code menu copies as markdown", () => {
  let got = "";
  const m = codeItems({ code: "a", lang: "ts", selection: "", copy: (t) => void (got = t) });
  const md = m.find((i) => i && i !== "-" && "action" in i && i.label === "Copy as markdown");
  if (md && md !== "-" && "action" in md) void md.action();
  assert.equal(got, "```ts\na\n```");
});

test("link menu: web links only get the open items", () => {
  assert.deepEqual(labels(linkItems({ href: "mailto:a@b", web: false, selection: "", panel: nop, copy: nop })), ["Copy link"]);
  assert.deepEqual(labels(linkItems({ href: "https://x.y", web: true, selection: "", panel: nop, copy: nop })), ["Open in browser panel", "Copy link"]);
});

test("file menu: open and diff are optional", () => {
  assert.deepEqual(labels(fileItems({ path: "/p/a", rel: "a", a: { reveal: nop, copy: nop } })), ["Reveal in Finder", "Copy relative path", "Copy full path"]);
  assert.deepEqual(labels(fileItems({ path: "/p/a", rel: "a", a: { open: nop, diff: nop, reveal: nop, copy: nop } })).slice(0, 2), ["Open", "Show diff"]);
});

test("step menu: command, output, fold, file", () => {
  const file = { path: "/p/a", rel: "a", a: { reveal: nop, copy: nop } };
  const l = labels(stepItems({ command: "ls", output: "x", file, fold: { open: false, toggle: nop }, copy: nop }));
  assert.deepEqual(l, ["Copy command", "Copy output", "Expand", "-", "Reveal in Finder", "Copy relative path", "Copy full path"]);
  assert.deepEqual(labels(stepItems({ detail: "thing", output: "", copy: nop })), ["Copy details"]);
});

test("tab menu: close others is disabled for a single tab", () => {
  const m = tabItems({ count: 1, close: nop, closeOthers: nop, splitRight: nop, splitDown: nop });
  const o = m.find((i) => i && i !== "-" && i.label === "Close other tabs");
  assert.ok(o && o !== "-" && o.enabled === false);
});

test("turn files: one file is flat, several are submenus", () => {
  const f = (label: string) => ({ label, items: [{ label: "Copy full path", action: nop }] as MenuEntry[] });
  assert.deepEqual(labels(turnFilesItems({ files: [f("a")], show: nop })), ["Show changes", "-", "Copy full path"]);
  assert.deepEqual(labels(turnFilesItems({ files: [f("a"), f("b")], show: nop })), ["Show changes", "-", "a", "b"]);
});
