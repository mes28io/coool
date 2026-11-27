// Run: node --test app/src/lib/menus/panels.test.ts (Node strips the types itself).
import { test } from "node:test";
import assert from "node:assert/strict";
import { browserTabMenu, changesFileMenu, changesHunkMenu, contextItemMenu, hunkLine, jobMenu, macMenu, simMenu, terminalMenu } from "./panels.ts";

// Labels of the live items, "-" for separators (cleaned the way showMenu does).
const labels = (items: unknown[] | null) => {
  const out: string[] = [];
  for (const i of items ?? []) {
    if (!i) continue;
    if (i === "-" && (!out.length || out[out.length - 1] === "-")) continue;
    out.push(i === "-" ? "-" : (i as { label: string }).label);
  }
  while (out[out.length - 1] === "-") out.pop();
  return out;
};
const noop = () => {};
const hunk = { id: "h1", old_start: 3, old_count: 1, new_start: 3, new_count: 1, added: 1, removed: 1, kept: false, since: false, lines: [{ k: " ", t: "a", o: 3, n: 3 }, { k: "+", t: "b", n: 4 }] } as never;
const file = (over = {}) => ({ path: "/r/a.ts", rel: "a.ts", status: "modified", line: 4, kept: false, hunks: [hunk], ...over }) as never;
const deps = { copyText: noop, open: noop, keep: noop, undo: noop, reveal: noop, locked: false };

test("file menu: Undo is last, after a separator", () => {
  assert.deepEqual(labels(changesFileMenu(file(), deps)), ["Open at line 4", "Keep", "Reveal in Finder", "-", "Copy diff", "Copy path", "-", "Undo"]);
});

test("file menu: kept, deleted and undone files drop what doesn't apply", () => {
  assert.deepEqual(labels(changesFileMenu(file({ kept: true }), deps)), ["Open at line 4", "Reveal in Finder", "-", "Copy diff", "Copy path", "-", "Undo"]);
  assert.deepEqual(labels(changesFileMenu(file({ status: "deleted" }), deps)), ["Keep", "-", "Copy diff", "Copy path", "-", "Undo"]);
  assert.deepEqual(labels(changesFileMenu(file({ status: "undone", hunks: [] }), deps)), ["Open at line 4", "Reveal in Finder", "-", "Copy path"]);
});

test("file menu: Keep and Undo are disabled while locked or blocked", () => {
  const m = changesFileMenu(file({ blocked: "why" }), { ...deps, locked: true }) as { label: string; enabled?: boolean }[];
  assert.equal(m.find((i) => i?.label === "Keep")?.enabled, false);
  assert.equal(m.find((i) => i?.label === "Undo")?.enabled, false);
});

test("hunk menu: line and selection lead; Undo hunk last", () => {
  assert.equal(hunkLine(hunk), 4);
  assert.deepEqual(labels(changesHunkMenu(file(), hunk, { ...deps, selection: "x", line: "b" })), ["Copy", "Copy line", "-", "Open at line 4", "Keep hunk", "Copy hunk", "-", "Undo hunk"]);
  assert.deepEqual(labels(changesHunkMenu(file(), hunk, deps)), ["Open at line 4", "Keep hunk", "Copy hunk", "-", "Undo hunk"]);
});

test("Copy hunk copies one hunk with the file header", () => {
  let got = "";
  const m = changesHunkMenu(file(), hunk, { ...deps, copyText: (t) => (got = t) }) as { label: string; action: () => void }[];
  m.find((i) => i?.label === "Copy hunk")!.action();
  assert.match(got, /^--- a\/a\.ts\n\+\+\+ b\/a\.ts\n@@ -3,1 \+3,1 @@\n a\n\+b\n$/);
});

test("terminal: Copy needs a selection, Paste a live process", () => {
  const m = terminalMenu({ copyText: noop, selection: "", exited: true, readClipboard: async () => "", paste: noop, selectAll: noop, clear: noop }) as { label: string; enabled?: boolean }[];
  assert.deepEqual(labels(m), ["Copy", "Paste", "-", "Select all", "Clear"]);
  assert.equal(m[0].enabled, false);
  assert.equal(m[1].enabled, false);
});

test("terminal: Paste writes the clipboard into the pty", async () => {
  let got = "";
  const m = terminalMenu({ copyText: noop, selection: "s", exited: false, readClipboard: async () => "ls\n", paste: (t) => (got = t), selectAll: noop, clear: noop }) as { label: string; action: () => Promise<void> }[];
  await m[1].action();
  assert.equal(got, "ls\n");
});

test("context item: Trash last, path items only with a path", () => {
  const d = { copyText: noop, open: noop, edit: noop, reveal: noop, trash: noop };
  assert.deepEqual(labels(contextItemMenu("/p/x.md", d)), ["Open", "Edit", "-", "Reveal in Finder", "Copy path", "-", "Move to Trash…"]);
  assert.deepEqual(labels(contextItemMenu(null, { copyText: noop, open: noop, reveal: noop })), ["Open"]);
});

const page = { copyText: noop, url: "https://a.dev/", current: true, canBack: false, canForward: true, reloadable: true, go: noop, openExternal: noop };

test("browser tab: page actions for the current tab, close items last", () => {
  assert.deepEqual(labels(browserTabMenu({ ...page, duplicate: noop, close: noop, closeOthers: noop })), ["Back", "Forward", "Reload", "-", "Copy URL", "Open in default browser", "-", "Duplicate", "-", "Close tab", "Close other tabs"]);
  assert.deepEqual(labels(browserTabMenu({ ...page, current: false, url: null, openExternal: undefined, close: noop })), ["Close tab"]);
  const m = browserTabMenu({ ...page, close: noop }) as { label: string; enabled?: boolean }[];
  assert.equal(m[0].enabled, false);
  assert.equal(m[1].enabled, true);
});

test("iPhone: booted gets Home, Lock, Paste, Shut down; otherwise Boot", () => {
  const d = { booted: true, busy: false, press: noop, paste: noop, boot: noop, shutdown: noop };
  assert.deepEqual(labels(simMenu(d)), ["Home", "Lock", "-", "Paste", "-", "Shut down"]);
  assert.deepEqual(labels(simMenu({ ...d, booted: false })), ["Boot"]);
});

test("Mac: no menu while keys are captured (a right click is the Mac's)", () => {
  const net = { mode: "on" as const, labels: { on: "On", local: "Local", off: "Off" }, pick: noop };
  const d = { keysOn: false, sendKeys: noop, paste: noop, copyBack: noop, network: net, shutdown: noop };
  assert.equal(macMenu({ ...d, keysOn: true }), null);
  assert.deepEqual(labels(macMenu(d)), ["Send keys to Mac", "-", "Paste into Mac", "Copy from Mac", "Network", "-", "Shut down"]);
  assert.deepEqual(labels(macMenu({ ...d, deleteMac: noop })), ["Send keys to Mac", "-", "Paste into Mac", "Copy from Mac", "Network", "-", "Shut down", "-", "Delete the Mac…"]);
  const sub = (macMenu(d) as { label: string; items?: { label: string; checked: boolean }[] }[]).find((i) => i?.label === "Network")!.items!;
  assert.deepEqual(sub.map((i) => [i.label, i.checked]), [["On", true], ["Local", false], ["Off", false]]);
});

test("job: Stop last; copy items only when there is something to copy", () => {
  assert.deepEqual(labels(jobMenu({ copyText: noop, open: noop, openLabel: "Open in timeline", task: "t", output: "o", stop: noop })), ["Open in timeline", "Copy task", "Copy output", "-", "Stop"]);
  assert.deepEqual(labels(jobMenu({ copyText: noop, command: "sleep 9", output: null })), ["Copy command"]);
});
