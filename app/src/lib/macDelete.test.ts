// Run: node --test app/src/lib/macDelete.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteConfirmText, fmtBytes, macFootprint } from "./macDelete.ts";

test("the freed size is the measured folder, falling back to the disk image, never invented", () => {
  assert.equal(macFootprint({ vmBytes: 29e9, diskBytes: 28e9 }), 29e9);
  assert.equal(macFootprint({ diskBytes: 28e9 }), 28e9);
  assert.equal(macFootprint({}), null);
  assert.equal(macFootprint({ vmBytes: 0 }), null);
});

test("sizes read in MB below a gigabyte and one decimal above", () => {
  assert.equal(fmtBytes(512e6), "512 MB");
  assert.equal(fmtBytes(29.4e9), "29.4 GB");
  assert.equal(fmtBytes(120e9), "120 GB");
});

test("the confirm says what is freed, what is lost, and that it can come back", () => {
  const t = deleteConfirmText({ vmBytes: 29.4e9 }, 16);
  assert.equal(t.freed, "Frees 29.4 GB on this computer.");
  assert.match(t.body, /files and the apps installed/);
  assert.match(t.body, /download it again later \(about 16 GB\)/);
  assert.equal(deleteConfirmText({}, 16).freed, null);
});
