// The protocol library against the shared vectors (the Rust side checks the same file), plus its local refusals.

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import * as P from "../src/protocol.mjs";
import { vectors } from "./vectors.mjs";

const file = new URL("../../../crates/remote/tests/vectors.json", import.meta.url);

test("produces exactly the shared vectors", () => {
  assert.deepEqual(vectors(), JSON.parse(fs.readFileSync(file, "utf8")));
});

test("a sealed message opens only with its own key, counter and routing fields", () => {
  const v = vectors();
  const k = (s) => P.unb64u(s, 32);
  assert.equal(JSON.stringify(P.open(k(v.d2m), "d2m", v.macId, v.deviceId, v.counter, v.sealedD2m)), v.envelope);
  assert.throws(() => P.open(k(v.m2d), "d2m", v.macId, v.deviceId, v.counter, v.sealedD2m));
  assert.throws(() => P.open(k(v.d2m), "m2d", v.macId, v.deviceId, v.counter, v.sealedD2m));
  assert.throws(() => P.open(k(v.d2m), "d2m", v.macId, v.deviceId, v.counter + 1, v.sealedD2m));
  assert.throws(() => P.open(k(v.d2m), "d2m", v.macId, P.randomId(), v.counter, v.sealedD2m));
  const b = Buffer.from(v.sealedD2m, "base64url");
  b[3] ^= 1;
  assert.throws(() => P.open(k(v.d2m), "d2m", v.macId, v.deviceId, v.counter, P.b64u(b)));
});

test("a replayed or older counter is refused by the receiver", () => {
  const g = new P.ReplayGuard();
  assert.ok(g.accept(10));
  assert.ok(!g.accept(10));
  assert.ok(!g.accept(9));
  assert.ok(g.accept(11));
});

test("counters keep rising across a lost state", () => {
  const a = P.nextCounter(0, 1_000);
  assert.ok(P.nextCounter(0, 1_001) > a);
  assert.ok(P.nextCounter(a, 1_000) > a);
  assert.ok(Number.isSafeInteger(P.nextCounter(0)));
});

test("a pairing URL round-trips and a malformed one is refused", () => {
  const v = vectors();
  const q = P.parsePairUrl(v.pairUrl);
  assert.equal(q.macId, v.macId);
  assert.throws(() => P.parsePairUrl(v.pairUrl.replace("v=1", "v=2")));
  assert.throws(() => P.parsePairUrl(v.pairUrl.replace("https%3A%2F%2F", "http%3A%2F%2F")));
});
