// Unit tests for lib/mediaRules.ts: `node --test app/src/lib/mediaRules.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { absPath, collectMedia, fmtTime, frameHeight, isShowTool, localMedia, mediaKind, savedShots, shownOf } from "./mediaRules.ts";

test("the show tool, by each CLI's name", () => {
  for (const n of ["mcp__coool-device__show", "coool-device.show", "coool-device__show"]) assert.ok(isShowTool(n), n);
  for (const n of ["show", "mcp__other__show", "mcp__coool-device__browser_screenshot", "mcp__coool-device__shows"]) assert.ok(!isShowTool(n), n);
  assert.deepEqual(shownOf({ paths: ["a.png", " ", "b.mp4"], caption: " After " }), { paths: ["a.png", "b.mp4"], caption: "After" });
  assert.deepEqual(shownOf({ path: "c.m4a" }), { paths: ["c.m4a"], caption: undefined });
  assert.equal(shownOf({}), null);
});

test("kinds, local links and kept screenshots", () => {
  assert.equal(mediaKind("x/Rec.MOV"), "video");
  assert.equal(mediaKind("voice.m4a"), "audio");
  assert.equal(mediaKind("a.txt"), null);
  assert.equal(mediaKind("blob", "image/png"), "image");
  assert.deepEqual(localMedia("shots/after%20fix.png"), { path: "shots/after fix.png", kind: "image" });
  assert.deepEqual(localMedia("file:///tmp/a.mp4"), { path: "/tmp/a.mp4", kind: "video" });
  assert.equal(localMedia("https://x.com/a.png"), null);
  assert.equal(localMedia("data:image/png;base64,AAAA"), null);
  assert.equal(localMedia("notes.md"), null);
  assert.equal(localMedia("index.html"), null, "a linked page stays a link");
  assert.equal(mediaKind("flow.svg"), "explainer");
  assert.equal(frameHeight(80), 120);
  assert.equal(frameHeight(300.4), 300);
  assert.equal(frameHeight(9000), 560);
  assert.equal(frameHeight("x"), null);
  assert.deepEqual(savedShots("Page unchanged\nScreenshot saved: /Users/me/Library/Application Support/coool/captures/shot-1.jpg\n"), ["/Users/me/Library/Application Support/coool/captures/shot-1.jpg"]);
});

test("a chat's media, newest first, each file once", () => {
  const items = [
    { kind: "prompt", key: "p1", ts: 1, attachments: [
      { name: "shot.png", mime: "image/png", size: 1, kind: "image" as const, key: "aaaaaaaaaaaaaaaa" },
      { name: "rec.mov", mime: "video/quicktime", size: 9, kind: "file" as const, path: "/u/rec.mov", duration: 12, frames: [{ key: "b", t: 0 }, { key: "c", t: 6 }] },
      { name: "notes.txt", mime: "text/plain", size: 1, kind: "file" as const, path: "/u/notes.txt" },
    ] },
    { kind: "tool", id: "t1", name: "Write", input: { file_path: "/p/out/chart.png" }, output: "", ts: 2, ok: true },
    { kind: "tool", id: "t2", name: "mcp__coool-device__browser_screenshot", input: {}, output: "Screenshot saved: /c/shot-9.jpg", ts: 3, ok: true },
    { kind: "tool", id: "t3", name: "mcp__coool-device__show", input: { paths: ["/p/out/chart.png", "demo.mp4", "readme.md"], caption: "Before and after" }, output: "", ts: 4, ok: true },
    { kind: "tool", id: "t4", name: "mcp__coool-device__show", input: { paths: ["gone.png"] }, output: "", ts: 5, ok: false },
    { kind: "text", key: "x", ts: 6 },
  ];
  const earlier = [{ kind: "prompt", attachments: [{ name: "old.png", mime: "image/png", size: 1, kind: "image" as const, key: "ffffffffffffffff" }] }, { kind: "tool", media: { paths: ["old.mp4"] } }];
  const m = collectMedia(items, earlier);
  assert.deepEqual(m.map((x) => [x.name, x.source, x.kind]), [
    ["demo.mp4", "shown", "video"],
    ["chart.png", "shown", "image"],
    ["shot-9.jpg", "screenshot", "image"],
    ["rec.mov", "attached", "video"],
    ["shot.png", "attached", "image"],
    ["old.mp4", "shown", "video"],
    ["old.png", "attached", "image"],
  ]);
  assert.equal(m[1].caption, "Before and after");
  assert.equal(m[1].ts, 4, "a written file the agent then showed is where it was shown");
  assert.deepEqual([m[3].duration, m[3].frames], [12, 2]);
  assert.equal(m[4].key, "aaaaaaaaaaaaaaaa");
});

test("one file however it is named", () => {
  assert.equal(absPath("out/./a.png", "/p/"), "/p/out/a.png");
  assert.equal(absPath("../x/a.png", "/p/q"), "/p/x/a.png");
  assert.equal(absPath("/abs/a.png", "/p"), "/abs/a.png");
  const m = collectMedia(
    [
      { kind: "tool", id: "w", name: "Write", input: { file_path: "/p/out/chart.png" }, output: "", ts: 1, ok: true },
      { kind: "tool", id: "s", name: "mcp__coool-device__show", input: { paths: ["out/chart.png"] }, output: "", ts: 2, ok: true },
    ],
    [],
    "/p",
  );
  assert.deepEqual(m.map((x) => [x.id, x.source]), [["file:/p/out/chart.png", "shown"]]);
});

test("player clock", () => {
  assert.equal(fmtTime(7.9), "0:07");
  assert.equal(fmtTime(62), "1:02");
  assert.equal(fmtTime(3725), "1:02:05");
  assert.equal(fmtTime(NaN), "0:00");
});
