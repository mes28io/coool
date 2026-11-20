// coool Remote protocol, version 1: the phone's side, and the reference for the iPhone app (docs/REMOTE.md).
//
// Pure functions over bytes and strings: keys, the pairing proofs and code, message sealing, relay request
// signatures, the QR payload. No I/O. All cryptography is Node's built-in `crypto` (OpenSSL): X25519, Ed25519,
// HKDF-SHA256, HMAC-SHA256, ChaCha20-Poly1305. Nothing here implements a primitive.
//
// Encodings: ids are 32 lowercase hex characters (128 random bits); keys, signatures, proofs and ciphertext are
// base64url without padding. The Rust side (crates/remote) must produce byte-identical results; test/vectors.test.mjs
// and crates/remote's tests check the same vectors.

import crypto from "node:crypto";

export const VERSION = 1;
/** The minor version (docs/REMOTE.md "Minor 1"): said in `hello`; the envelope's `v` stays 1. */
export const MINOR = 1;
/** Raw bytes per image chunk, both ways (crates/remote/src/live.rs `CHUNK`). */
export const CHUNK = 48 * 1024;
/** Largest image a phone may send (live.rs `MAX_UPLOAD`). */
export const MAX_UPLOAD = 2_000_000;

/** An image as `upload` bodies: `{upload, part, parts, size, data}`, data the part's bytes in base64url. */
export function uploadParts(id, bytes) {
  const parts = Math.max(1, Math.ceil(bytes.length / CHUNK));
  return Array.from({ length: parts }, (_, i) => ({ upload: id, part: i, parts, size: bytes.length, data: b64u(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)) }));
}

/** Puts `image` (or `frame`) chunks back together; null until every part is there. */
export function joinParts(chunks) {
  const parts = chunks[0]?.parts;
  if (!parts || chunks.length < parts) return null;
  const sorted = [...chunks].sort((a, b) => a.part - b.part);
  if (sorted.some((c, i) => c.part !== i)) return null;
  return Buffer.concat(sorted.map((c) => Buffer.from(c.data, "base64url")));
}
export const PROTOCOL = "coool-remote/1";
const SALT = Buffer.from(PROTOCOL, "utf8");

export const b64u = (b) => Buffer.from(b).toString("base64url");
export function unb64u(s, len) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const b = Buffer.from(s, "base64url");
  if (len !== undefined && b.length !== len) throw new Error(`expected ${len} bytes`);
  if (b64u(b) !== s) throw new Error("not canonical base64url");
  return b;
}
export const randomId = () => crypto.randomBytes(16).toString("hex");
export const isId = (s) => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
const utf8 = (s) => Buffer.from(s, "utf8");

// ---------------------------------------------------------------- keys

/** A new identity: an X25519 key (encryption) and an Ed25519 key (signing), as base64url raw halves. */
export function newIdentity() {
  const box = crypto.generateKeyPairSync("x25519").privateKey.export({ format: "jwk" });
  const sign = crypto.generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return { boxPriv: box.d, boxPub: box.x, signPriv: sign.d, signPub: sign.x };
}

const PKCS8 = { box: "302e020100300506032b656e04220420", sign: "302e020100300506032b657004220420" };
/** A raw 32-byte private key (base64url) as a Node key object, through its PKCS#8 form. */
const privKey = (kind, d) => crypto.createPrivateKey({ key: Buffer.concat([Buffer.from(PKCS8[kind], "hex"), unb64u(d, 32)]), format: "der", type: "pkcs8" });
const pubKey = (crv, x) => crypto.createPublicKey({ key: { kty: "OKP", crv, x }, format: "jwk" });

/** The public half (base64url) of a raw private key: `kind` "box" (X25519) or "sign" (Ed25519). */
export const publicOf = (kind, priv) => crypto.createPublicKey(privKey(kind, priv)).export({ format: "jwk" }).x;

const edPriv = (d) => privKey("sign", d);
const edPub = (x) => pubKey("Ed25519", x);
const xPriv = (d) => privKey("box", d);
const xPub = (x) => pubKey("X25519", x);

export const signBytes = (signPriv, bytes) => b64u(crypto.sign(null, bytes, edPriv(signPriv)));
export function verifyBytes(signPub, sig, bytes) {
  try {
    return crypto.verify(null, bytes, edPub(signPub), unb64u(sig, 64));
  } catch {
    return false;
  }
}

const hkdf = (ikm, info) => Buffer.from(crypto.hkdfSync("sha256", ikm, SALT, utf8(info), 32));
const hmac = (key, msg) => crypto.createHmac("sha256", key).update(utf8(msg)).digest();

/** X25519, refusing a low-order peer key (an all-zero shared secret). */
export function sharedSecret(boxPriv, peerBoxPub) {
  const s = crypto.diffieHellman({ privateKey: xPriv(boxPriv), publicKey: xPub(peerBoxPub) });
  if (s.every((b) => b === 0)) throw new Error("low-order public key");
  return s;
}

// ---------------------------------------------------------------- pairing

/** The keys a pairing secret yields. `relayKey` goes to the relay; the others never leave the two ends. */
export function pairingKeys(secret) {
  return {
    relayKey: hkdf(secret, `${PROTOCOL} relay-proof`),
    macKey: hkdf(secret, `${PROTOCOL} mac-proof`),
    nameKey: hkdf(secret, `${PROTOCOL} claim-name`),
    codeKey: hkdf(secret, `${PROTOCOL} code`),
  };
}

export const claimTranscript = (c) => [PROTOCOL, "claim", c.pairingId, c.deviceId, c.signPub, c.boxPub, c.nameBox].join("\n");
export const proof = (key, c) => b64u(hmac(key, claimTranscript(c)));
export function proofOk(key, c, given) {
  try {
    return crypto.timingSafeEqual(hmac(key, claimTranscript(c)), unb64u(given, 32));
  } catch {
    return false;
  }
}

const nameAad = (pairingId, deviceId) => utf8([PROTOCOL, "name", pairingId, deviceId].join("\n"));

/** The device name, sealed for the Mac under the pairing's name key (random nonce; the key serves one pairing). */
export function sealName(nameKey, pairingId, deviceId, name, nonce = crypto.randomBytes(12)) {
  const c = crypto.createCipheriv("chacha20-poly1305", nameKey, nonce, { authTagLength: 16 });
  c.setAAD(nameAad(pairingId, deviceId), { plaintextLength: Buffer.byteLength(name) });
  return b64u(Buffer.concat([nonce, c.update(utf8(name)), c.final(), c.getAuthTag()]));
}
export function openName(nameKey, pairingId, deviceId, box) {
  const b = unb64u(box);
  if (b.length < 28) throw new Error("short");
  const d = crypto.createDecipheriv("chacha20-poly1305", nameKey, b.subarray(0, 12), { authTagLength: 16 });
  d.setAAD(nameAad(pairingId, deviceId), { plaintextLength: b.length - 28 });
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString("utf8");
}

/** The 6-digit code both ends show: from the pairing secret and both sides' public keys. */
export function pairingCode(codeKey, p) {
  const t = [PROTOCOL, "code", p.pairingId, p.macId, p.macSignPub, p.macBoxPub, p.deviceId, p.devSignPub, p.devBoxPub].join("\n");
  return String(hmac(codeKey, t).readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

/** `coool://pair?...`: what the Mac's QR code holds. */
export function pairUrl(q) {
  const u = new URLSearchParams({ v: String(VERSION), r: q.relay, m: q.macId, p: q.pairingId, s: q.secret, ks: q.macSignPub, kx: q.macBoxPub });
  return `coool://pair?${u}`;
}
export function parsePairUrl(s) {
  if (typeof s !== "string" || !s.startsWith("coool://pair?")) throw new Error("not a coool pairing code");
  const u = new URLSearchParams(s.slice("coool://pair?".length));
  const q = { v: Number(u.get("v")), relay: u.get("r"), macId: u.get("m"), pairingId: u.get("p"), secret: u.get("s"), macSignPub: u.get("ks"), macBoxPub: u.get("kx") };
  if (q.v !== VERSION) throw new Error(`pairing code is for protocol ${q.v}, this speaks ${VERSION}`);
  if (!isId(q.macId) || !isId(q.pairingId)) throw new Error("bad pairing code");
  unb64u(q.secret, 32);
  unb64u(q.macSignPub, 32);
  unb64u(q.macBoxPub, 32);
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(q.relay ?? "")) throw new Error("bad relay address");
  return q;
}

// ---------------------------------------------------------------- messages

/** Per-direction keys for one Mac and one device. */
export function sessionKeys(shared, m) {
  const ctx = (dir) => [PROTOCOL, "session", dir, m.macId, m.deviceId, m.macBoxPub, m.devBoxPub].join(" ");
  return { m2d: hkdf(shared, ctx("m2d")), d2m: hkdf(shared, ctx("d2m")) };
}

export function nonceOf(counter) {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(counter), 4);
  return n;
}
export const messageAad = (dir, macId, deviceId, counter) => utf8([PROTOCOL, "msg", dir, macId, deviceId, String(counter)].join("\n"));

/** The next counter to send: above the last one, and at least the current time in microseconds (so a counter
 * never repeats under a key even if the stored one was lost). Always below 2^53. */
export const nextCounter = (last, nowMs = Date.now()) => Math.max(last + 1, nowMs * 1000);

export function seal(key, dir, macId, deviceId, counter, obj) {
  const pt = utf8(JSON.stringify(obj));
  const c = crypto.createCipheriv("chacha20-poly1305", key, nonceOf(counter), { authTagLength: 16 });
  c.setAAD(messageAad(dir, macId, deviceId, counter), { plaintextLength: pt.length });
  return b64u(Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]));
}

/** Decrypts and parses; throws on any tampering (wrong key, counter, routing fields or bytes). */
export function open(key, dir, macId, deviceId, counter, ciphertext) {
  const b = unb64u(ciphertext);
  if (b.length < 16) throw new Error("short");
  const d = crypto.createDecipheriv("chacha20-poly1305", key, nonceOf(counter), { authTagLength: 16 });
  d.setAAD(messageAad(dir, macId, deviceId, counter), { plaintextLength: b.length - 16 });
  d.setAuthTag(b.subarray(b.length - 16));
  return JSON.parse(Buffer.concat([d.update(b.subarray(0, b.length - 16)), d.final()]).toString("utf8"));
}

/** A plaintext message: `{v, id, t, at, b}`. */
export const envelope = (t, b = {}, at = Date.now()) => ({ v: VERSION, id: crypto.randomUUID(), t, at, b });

/** Remembers the highest counter accepted from one sender: a counter at or below it is a replay. */
export class ReplayGuard {
  constructor(highWater = 0) {
    this.highWater = highWater;
  }
  accept(counter) {
    if (!Number.isSafeInteger(counter) || counter <= this.highWater) return false;
    this.highWater = counter;
    return true;
  }
}

// ---------------------------------------------------------------- relay requests

export const requestBytes = (fn, fields, ts) => utf8([PROTOCOL, fn, ...fields.map(String), String(ts)].join("\n"));
export const signRequest = (signPriv, fn, fields, ts) => signBytes(signPriv, requestBytes(fn, fields, ts));
export const sha256Hex = (s) => crypto.createHash("sha256").update(utf8(s)).digest("hex");
/** A read-session token and the hash the relay keeps. */
export function newToken() {
  const token = b64u(crypto.randomBytes(32));
  return { token, tokenHash: sha256Hex(token) };
}
