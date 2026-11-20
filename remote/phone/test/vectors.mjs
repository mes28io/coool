// Fixed-input vectors of the protocol, so the Rust side (crates/remote/tests/vectors.json) and this one agree byte
// for byte. `node test/vectors.mjs > ../../crates/remote/tests/vectors.json` rewrites them; vectors.test.mjs checks
// this library still produces exactly that file.

import * as P from "./../src/protocol.mjs";

const raw = (n) => P.b64u(Buffer.alloc(32, n));
export function vectors() {
  const mac = { boxPriv: raw(1), signPriv: raw(2) };
  const dev = { boxPriv: raw(3), signPriv: raw(4) };
  for (const k of [mac, dev]) {
    k.boxPub = P.publicOf("box", k.boxPriv);
    k.signPub = P.publicOf("sign", k.signPriv);
  }
  const macId = "00112233445566778899aabbccddeeff";
  const deviceId = "ffeeddccbbaa99887766554433221100";
  const pairingId = "0123456789abcdef0123456789abcdef";
  const secret = Buffer.alloc(32, 9);
  const k = P.pairingKeys(secret);
  const nameBox = P.sealName(k.nameKey, pairingId, deviceId, "Ada's iPhone", Buffer.alloc(12, 5));
  const claim = { pairingId, deviceId, signPub: dev.signPub, boxPub: dev.boxPub, nameBox };
  const shared = P.sharedSecret(mac.boxPriv, dev.boxPub);
  const sk = P.sessionKeys(shared, { macId, deviceId, macBoxPub: mac.boxPub, devBoxPub: dev.boxPub });
  const env = { v: 1, id: "8c1d6c2e-0b5c-4c43-9d7e-2f1a3b4c5d6e", t: "send", at: 1763640000000, b: { session: "claude:abc", text: "hi" } };
  const counter = 1763640000000123;
  return {
    mac,
    dev,
    macId,
    deviceId,
    pairingId,
    secret: P.b64u(secret),
    relayKey: P.b64u(k.relayKey),
    nameBox,
    proofRelay: P.proof(k.relayKey, claim),
    proofMac: P.proof(k.macKey, claim),
    code: P.pairingCode(k.codeKey, { pairingId, macId, macSignPub: mac.signPub, macBoxPub: mac.boxPub, deviceId, devSignPub: dev.signPub, devBoxPub: dev.boxPub }),
    shared: P.b64u(shared),
    m2d: P.b64u(sk.m2d),
    d2m: P.b64u(sk.d2m),
    envelope: JSON.stringify(env),
    counter,
    sealedD2m: P.seal(sk.d2m, "d2m", macId, deviceId, counter, env),
    requestSig: P.signRequest(mac.signPriv, "send", [macId, deviceId, "m2d", counter, P.sha256Hex("abc")], 1763640000000),
    pairUrl: P.pairUrl({ relay: "https://example.convex.cloud", macId, pairingId, secret: P.b64u(secret), macSignPub: mac.signPub, macBoxPub: mac.boxPub }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(vectors(), null, 2));
