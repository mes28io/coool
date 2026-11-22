// Unit tests for lib/attachRules.ts: `node --test app/src/lib/attachRules.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { admit, colorize, dropPoint, fmtSize, gridOf, imagePaths, MAX_COUNT, PICK_OPTIONS, pickedPaths, pickWith, toneOf, typeLabel } from "./attachRules.ts";

test("admit: limits, duplicates and plain reasons", () => {
  const have = [{ name: "a.png", size: 10 }];
  const r = admit(have, [
    { name: "a.png", size: 10, mime: "image/png" },
    { name: "big.png", size: 41 * 1024 * 1024, mime: "image/png", path: "/x/big.png" },
    { name: "huge.bin", size: 60 * 1024 * 1024, mime: "application/octet-stream" },
    { name: "huge-dropped.bin", size: 60 * 1024 * 1024, mime: "application/octet-stream", path: "/x/huge.bin" },
    { name: "empty.txt", size: 0, mime: "text/plain" },
    { name: "ok.txt", size: 5, mime: "text/plain" },
  ]);
  assert.deepEqual(r.ok, [3, 5]);
  assert.deepEqual(r.refused.map((x) => [x.i, x.reason.split(":")[0].split(" (")[0]]), [
    [0, "already attached"],
    [1, "too large"],
    [2, "too large to paste"],
    [4, "empty file"],
  ]);
  const many = Array.from({ length: MAX_COUNT + 2 }, (_, i) => ({ name: `f${i}.txt`, size: 1, mime: "text/plain" }));
  const m = admit([], many);
  assert.equal(m.ok.length, MAX_COUNT);
  assert.match(m.refused[0].reason, /too many/);
});

test("type labels, tones and sizes", () => {
  assert.equal(typeLabel({ name: "main.rs", mime: "text/plain" }), "RS");
  assert.equal(typeLabel({ name: "notes.markdown", mime: "text/markdown" }), "MARK");
  assert.equal(typeLabel({ name: "README", mime: "text/plain" }), "TXT");
  assert.equal(typeLabel({ name: "x", mime: "application/pdf" }), "PDF");
  assert.equal(toneOf({ name: "a.tsx", mime: "text/plain" }), "code");
  assert.equal(toneOf({ name: "a.pdf", mime: "application/pdf" }), "doc");
  assert.equal(toneOf({ name: "a.csv", mime: "text/csv" }), "data");
  assert.equal(toneOf({ name: "a.png", mime: "image/png" }), "media");
  assert.equal(fmtSize(900), "900 B");
  assert.equal(fmtSize(1536), "1.5 KB");
  assert.equal(fmtSize(3_500_000), "3.3 MB");
  assert.equal(fmtSize(0), "");
});

test("image grids", () => {
  assert.deepEqual(gridOf(1), { cols: 1, tiles: 1, more: 0, single: true });
  assert.equal(gridOf(2).cols, 2);
  assert.equal(gridOf(3).cols, 3);
  assert.equal(gridOf(4).cols, 2);
  assert.deepEqual(gridOf(9), { cols: 3, tiles: 6, more: 3, single: false });
});

test("colorize: keywords, strings, comments, numbers, and spans across lines", () => {
  const t = colorize('const a = "x"; // hi\n/* one\ntwo */ let b = 42;', "a.ts");
  assert.deepEqual(t[0].filter((x) => x.k).map((x) => [x.k, x.t]), [
    ["kw", "const"],
    ["str", '"x"'],
    ["com", "// hi"],
  ]);
  assert.equal(t[1][0].k, "com");
  assert.equal(t[2][0].k, "com");
  assert.deepEqual(t[2].filter((x) => x.k === "kw" || x.k === "num").map((x) => x.t), ["let", "42"]);
  assert.deepEqual(colorize("plain\ntext", "notes.unknownext"), [[{ t: "plain", k: "" }], [{ t: "text", k: "" }]]);
  assert.equal(colorize("x1 = 2", "a.py")[0].find((x) => x.k === "num")?.t, "2", "a digit inside a name is not a number");
});

test("image paths an agent mentions", () => {
  assert.deepEqual(imagePaths('Saved screenshot to /tmp/shot-1.png. Also "~/Desktop/a b.jpg" and ./rel.png'), ["/tmp/shot-1.png"]);
  assert.deepEqual(imagePaths("file_path=/Users/x/img.webp, /Users/x/doc.pdf"), ["/Users/x/img.webp"]);
  assert.deepEqual(imagePaths("nothing here"), []);
  // Only inside the chat's folder when one is given.
  assert.deepEqual(imagePaths("wrote /w/proj/out.png and /tmp/x.png and /w/proj/../etc/y.png", 4, "/w/proj"), ["/w/proj/out.png"]);
});

test("the attach button's picker: options, a cancel, one path and a list", async () => {
  const seen: unknown[] = [];
  const added: string[][] = [];
  const add = async (p: string[]) => void added.push(p);
  const open = (answer: unknown) => async (o: unknown) => (seen.push(o), answer);
  assert.equal(await pickWith(open(null), add), 0, "cancelled: nothing added");
  assert.equal(await pickWith(open("/a/one.png"), add), 1);
  assert.equal(await pickWith(open(["/a/x.txt", "/a/y.pdf"]), add), 2);
  assert.equal(await pickWith(open([]), add), 0);
  assert.deepEqual(added, [["/a/one.png"], ["/a/x.txt", "/a/y.pdf"]]);
  assert.deepEqual(seen[0], { multiple: true, directory: false, title: "Attach files" });
  assert.equal(PICK_OPTIONS.directory, false);
  assert.deepEqual(pickedPaths([null, "", "/ok"]), ["/ok"]);
});

test("dropPoint: macOS positions are already CSS pixels; elsewhere physical", () => {
  // A drag over (900, 500) on a Retina Mac: wry reports (900, 500), not (1800, 1000).
  assert.deepEqual(dropPoint({ x: 900, y: 500 }, true, 2), { x: 900, y: 500 });
  assert.deepEqual(dropPoint({ x: 1800, y: 1000 }, false, 2), { x: 900, y: 500 });
  assert.deepEqual(dropPoint({ x: 10, y: 20 }, false, 0), { x: 10, y: 20 });
});
