// The relay's half of the threat model (docs/REMOTE.md "Threat model"), against the real dev deployment.
// Run: cd remote/phone && node --test test/relay.test.mjs   (needs the network and the Convex CLI's login).

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as P from "../src/protocol.mjs";
import { Phone } from "../src/phone.mjs";
import { MacSim, dump, relayUrl } from "./macSim.mjs";

const URL = relayUrl();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const closers = [];
after(async () => {
  for (const c of closers) await c.close();
});

/** A Mac and a phone paired through the relay (the Mac's click included). */
async function paired(name = "Test iPhone") {
  const mac = new MacSim(URL);
  closers.push(mac);
  assert.equal((await mac.register()).ok, true);
  const qr = await mac.openPairing();
  const phone = new Phone();
  closers.push(phone);
  const code = await phone.claim(qr, name);
  const c = await mac.claim();
  assert.ok(c.proofOk);
  assert.equal(c.code, code);
  assert.equal(c.name, name);
  assert.equal((await mac.confirm(c.deviceId)).ok, true);
  assert.equal(await phone.waitPaired({ timeoutMs: 10_000 }), true);
  return { mac, phone, c };
}

describe("pairing", () => {
  test("does not complete without the Mac's confirm", async () => {
    const mac = new MacSim(URL);
    closers.push(mac);
    await mac.register();
    const qr = await mac.openPairing();
    const phone = new Phone();
    closers.push(phone);
    await phone.claim(qr, "Waiting iPhone");
    // No confirm: the phone stays pending, has no device row, and can't open a session.
    assert.equal(await phone.waitPaired({ timeoutMs: 3_000, pollMs: 500 }), false);
    const d = dump(mac.macId);
    assert.equal(d.devices.length, 0);
    const { id, deviceId } = phone.pending;
    const r = await phone.pending.relay.openSession(id.signPriv, "device", mac.macId, deviceId);
    assert.deepEqual(r, { ok: false, code: "revoked" });
    // A Cancel on the Mac refuses it for good.
    await mac.relay.cancelPairing(mac.id.signPriv, mac.macId, mac.pairingId);
    assert.equal(await phone.waitPaired({ timeoutMs: 3_000, pollMs: 500 }), false);
    assert.equal((await mac.confirm(deviceId)).ok, false);
  });

  test("a reused pairing code fails", async () => {
    const { mac } = await paired();
    // The QR code is photographed and used again (same pairing, a second phone).
    const qr2 = P.pairUrl({ relay: URL, macId: mac.macId, pairingId: mac.pairingId, secret: "A".repeat(43), macSignPub: mac.id.signPub, macBoxPub: mac.id.boxPub });
    await assert.rejects(new Phone().claim(qr2, "Thief"), /refused by the relay: used/);
  });

  test("a second claim on an open pairing fails (one claim per pairing)", async () => {
    const mac = new MacSim(URL);
    closers.push(mac);
    await mac.register();
    const qr = await mac.openPairing();
    await new Phone().claim(qr, "First");
    await assert.rejects(new Phone().claim(qr, "Second"), /refused by the relay: used/);
  });

  test("an expired pairing code fails", async () => {
    const mac = new MacSim(URL);
    closers.push(mac);
    await mac.register();
    const qr = await mac.openPairing(1_500);
    await sleep(2_500);
    await assert.rejects(new Phone().claim(qr, "Late"), /refused by the relay: expired/);
  });

  test("a claim without the pairing secret fails (wrong proof)", async () => {
    const mac = new MacSim(URL);
    closers.push(mac);
    await mac.register();
    const qr = await mac.openPairing();
    const q = P.parsePairUrl(qr);
    const forged = qr.replace(`s=${q.secret}`, `s=${P.b64u(Buffer.alloc(32, 7))}`);
    await assert.rejects(new Phone().claim(forged, "Guess"), /refused by the relay: bad_proof/);
  });

  test("the expiry can't be set beyond two minutes", async () => {
    const mac = new MacSim(URL);
    closers.push(mac);
    await mac.register();
    const r = await mac.relay.createPairing(mac.id.signPriv, mac.macId, P.randomId(), P.b64u(Buffer.alloc(32, 1)), Date.now() + 3_600_000);
    assert.equal(r.ok, true);
    assert.ok(r.expiresAt <= Date.now() + 121_000);
  });
});

describe("messages", () => {
  let mac, phone, c;
  before(async () => {
    ({ mac, phone, c } = await paired());
  });

  test("a message with a wrong signature is refused by the relay", async () => {
    const s = phone.s;
    const counter = P.nextCounter(s.sendCounter);
    const ct = P.seal(phone.keys.d2m, "d2m", s.mac.macId, s.deviceId, counter, P.envelope("hello"));
    const stranger = P.newIdentity();
    const r = await phone.relay.send(stranger.signPriv, s.mac.macId, s.deviceId, "d2m", counter, ct);
    assert.deepEqual(r, { ok: false, code: "bad_signature" });
    // Signed by the device but over different bytes (the ciphertext swapped after signing).
    const ts = Date.now();
    const sig = P.signRequest(s.id.signPriv, "send", [s.mac.macId, s.deviceId, "d2m", counter, P.sha256Hex(ct)], ts);
    const r2 = await phone.relay.http.mutation("relay:send", { macId: s.mac.macId, deviceId: s.deviceId, dir: "d2m", counter, ciphertext: ct + "AA", ts, sig });
    assert.deepEqual(r2, { ok: false, code: "bad_signature" });
    // The phone can't sign as the Mac (m2d).
    const r3 = await phone.relay.send(s.id.signPriv, s.mac.macId, s.deviceId, "m2d", counter, ct);
    assert.deepEqual(r3, { ok: false, code: "bad_signature" });
  });

  test("a stale signed request is refused", async () => {
    const s = phone.s;
    const counter = P.nextCounter(s.sendCounter);
    const ct = P.seal(phone.keys.d2m, "d2m", s.mac.macId, s.deviceId, counter, P.envelope("hello"));
    const ts = Date.now() - 10 * 60_000;
    const sig = P.signRequest(s.id.signPriv, "send", [s.mac.macId, s.deviceId, "d2m", counter, P.sha256Hex(ct)], ts);
    const r = await phone.relay.http.mutation("relay:send", { macId: s.mac.macId, deviceId: s.deviceId, dir: "d2m", counter, ciphertext: ct, ts, sig });
    assert.deepEqual(r, { ok: false, code: "stale" });
  });

  test("a replayed message is refused by the relay", async () => {
    const sent = await phone.sendText("abc", "a replay test");
    const s = phone.s;
    // The identical request again (fresh signature time, same counter and ciphertext), and a lower counter.
    const r = await phone.relay.send(s.id.signPriv, s.mac.macId, s.deviceId, "d2m", sent.counter, sent.ciphertext);
    assert.deepEqual(r, { ok: false, code: "replay" });
    const r2 = await phone.relay.send(s.id.signPriv, s.mac.macId, s.deviceId, "d2m", sent.counter - 1, sent.ciphertext);
    assert.deepEqual(r2, { ok: false, code: "replay" });
  });

  test("the relay's stored rows hold no plaintext of the session", async () => {
    const SECRET_TITLE = "Zebra migration of the payroll ledger";
    const SECRET_CMD = "rm -rf ./build && npm run deploy-zebra";
    await phone.sendText("sess-1", `${SECRET_TITLE} please run ${SECRET_CMD}`);
    assert.equal((await mac.sendTo(c, "snapshot", { sessions: [{ id: "s1", title: SECRET_TITLE, project: "zebra-app", cwd: "/Users/someone/zebra-app" }] })).ok, true);
    assert.equal((await mac.sendTo(c, "need", { id: "n1", kind: "permission", tool: "Bash", command: SECRET_CMD })).ok, true);
    // Minor 1: every new type, both ways, image chunks and device frames included (their bytes hold a marker).
    const MARK = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("ZEBRA-PIXELS ".repeat(400))]);
    await phone.watch("sess-1");
    await phone.watchDevice("sess-1", "browser");
    await phone.getImage("sess-1", "zebra-key");
    await phone.upload(MARK);
    await phone.sendText("sess-1", "note", { when: "next" });
    await phone.start("0123456789abcdef0123456789abcdef", "claude", `${SECRET_TITLE}`, { model: "haiku", mode: "plan" });
    const zebraDiff = { path: "zebra/payroll.rs", before: "fn zebra() {}", after: "fn zebra_payroll() {}" };
    for (const [t, b] of [
      ["chat", { session: "s1", items: [{ k: "t:1", role: "tool", tool: "Edit", text: "zebra/payroll.rs", diff: zebraDiff }], cursor: 3, live: { text: "Zebra streaming", step: "Edit · zebra/payroll.rs" } }],
      ["overview", { projects: [{ name: "zebra-app", changes: [{ action: "Edited", object: "zebra/payroll.rs" }], commits: [{ subject: "Zebra payroll" }] }] }],
      ["options", { claude: { models: [{ id: "zebra-model", label: "Zebra" }] } }],
      ["image", { session: "s1", key: "zebra-key", part: 0, parts: 1, size: MARK.length, data: P.b64u(MARK) }],
      ["frame", { session: "s1", device: "browser", seq: 1, data: P.b64u(MARK) }],
      ["need", { id: "n2", kind: "plan", tool: "ExitPlanMode", plan: "# Zebra plan", diff: zebraDiff, read: { what: "Zebra", why: "payroll", check: [] } }],
    ]) {
      assert.equal((await mac.sendTo(c, t, b)).ok, true, t);
    }
    const d = dump(mac.macId);
    assert.ok(d.messages.length >= 14);
    const raw = JSON.stringify(d);
    // Not in the rows as stored, nor in the decoded bytes of any ciphertext; the device name neither.
    const needles = ["Zebra", "zebra", "ZEBRA", "payroll", "deploy", "rm -rf", "Test iPhone", "snapshot", "/Users/", "PNG", "upload", "frame", "watch", "haiku", "overview"];
    for (const n of needles) assert.ok(!raw.includes(n), `stored rows contain "${n}"`);
    for (const m of d.messages) {
      const bytes = Buffer.from(m.ciphertext, "base64url").toString("latin1");
      for (const n of needles) assert.ok(!bytes.includes(n), `ciphertext bytes contain "${n}"`);
    }
    for (const p of d.pairings) {
      const bytes = Buffer.from(p.claim?.nameBox ?? "", "base64url").toString("latin1");
      assert.ok(!bytes.includes("iPhone"));
    }
    // The secret itself never reached the relay: what it holds is the derived proof key.
    assert.ok(d.pairings.every((p) => !("secret" in p)));
  });

  test("a message from the Mac reaches the phone once, decrypted, and is deleted on ack", async () => {
    const got = [];
    await phone.connect((m) => got.push(m));
    assert.equal((await mac.sendTo(c, "result", { of: "x", ok: true })).ok, true);
    for (let i = 0; i < 50 && !got.some((m) => m.t === "result"); i++) await sleep(200);
    assert.ok(got.some((m) => m.t === "result" && m.b.of === "x"));
    await sleep(1_500);
    assert.equal(dump(mac.macId).messages.filter((m) => m.dir === "m2d").length, 0);
  });

  test("a revoked device is refused at the relay", async () => {
    const events = [];
    phone.unsub?.();
    await phone.connect(() => {}, (e) => events.push(e));
    assert.equal((await mac.revoke(phone.s.deviceId)).ok, true);
    await assert.rejects(phone.sendText("abc", "after revoke"), /refused the message: revoked/);
    const r = await phone.relay.openSession(phone.s.id.signPriv, "device", phone.s.mac.macId, phone.s.deviceId);
    assert.deepEqual(r, { ok: false, code: "revoked" });
    // Its live subscription is cut too, and the Mac can't send to it either.
    for (let i = 0; i < 50 && !events.some((e) => e.kind === "revoked" || e.kind === "session"); i++) await sleep(200);
    assert.ok(events.some((e) => e.kind === "revoked" || e.kind === "session"));
    assert.deepEqual(await mac.sendTo(c, "need", {}), { ok: false, code: "revoked" });
    assert.equal(dump(mac.macId).messages.length, 0);
  });
});
