// Unit tests for lib/treemap.ts: `node --test app/src/lib/treemap.test.ts` (Node 22.6+ strips the types).

import { test } from "node:test";
import assert from "node:assert/strict";
import { squarify } from "./treemap.ts";

const area = (r: { w: number; h: number }) => r.w * r.h;
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test("tiles the rectangle exactly, areas proportional to values, no overlaps", () => {
  const values = [60, 30, 20, 10, 6, 4, 0];
  const rs = squarify(values, { x: 0, y: 0, w: 320, h: 200 });
  const total = values.reduce((a, b) => a + b, 0);
  rs.forEach((r, i) => close(area(r), (values[i] / total) * 320 * 200, 1e-3));
  assert.equal(rs[6].w * rs[6].h, 0);
  for (const r of rs) {
    assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 320 + 1e-9 && r.y + r.h <= 200 + 1e-9);
  }
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++) {
      const [a, b] = [rs[i], rs[j]];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(!(ox > 1e-6 && oy > 1e-6), `tiles ${i} and ${j} overlap`);
    }
});

test("keeps tiles square when it can", () => {
  for (const r of squarify([5, 5, 5, 5], { x: 0, y: 0, w: 200, h: 200 })) assert.ok(Math.max(r.w / r.h, r.h / r.w) < 1.01);
});

test("handles nothing to lay out", () => {
  assert.deepEqual(squarify([], { x: 0, y: 0, w: 10, h: 10 }), []);
  assert.equal(squarify([0, 0], { x: 0, y: 0, w: 10, h: 10 }).length, 2);
});
