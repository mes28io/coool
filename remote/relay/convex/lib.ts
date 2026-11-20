// Checks shared by the relay's functions: argument formats, request signatures, rate limits.
//
// Every request a client makes is signed with its Ed25519 key over
//   "coool-remote/1" \n <function> \n <field> \n ... \n <ts>
// (UTF-8; the fields are listed per function in relay.ts and docs/REMOTE.md "Relay requests"), and `ts` must be
// within REQUEST_WINDOW_MS of the relay's clock. All fields are validated against a pattern without newlines first,
// so the joined string is unambiguous. Cryptography is @noble/curves (Ed25519) and @noble/hashes (SHA-256, HMAC).

import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { MutationCtx } from "./_generated/server";

export const PROTOCOL = "coool-remote/1";
export const REQUEST_WINDOW_MS = 120_000;
export const PAIRING_TTL_MS = 120_000;
/** A claimed pairing waits this long (from its creation) for the click on the Mac. */
export const CONFIRM_WINDOW_MS = 10 * 60_000;
export const SESSION_TTL_MS = 12 * 3_600_000;
export const MAX_CIPHERTEXT = 131_072;
export const MAX_QUEUE = 500;

export type Refusal = { ok: false; code: string };
export const refuse = (code: string): Refusal => ({ ok: false, code });

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const B64U = /^[A-Za-z0-9_-]*$/;

export const isId = (s: string) => HEX32.test(s);
export const isHash = (s: string) => HEX64.test(s);
/** base64url (no padding) of exactly `n` bytes. */
export function isB64Bytes(s: string, n: number) {
  return B64U.test(s) && s.length === Math.ceil((n * 4) / 3) && b64uDecode(s)?.length === n;
}
export function isB64(s: string, max: number) {
  return B64U.test(s) && s.length > 0 && s.length <= max && b64uDecode(s) !== null;
}

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP: Record<string, number> = Object.fromEntries([...ALPHA].map((c, i) => [c, i]));

/** base64url without padding; null for anything else (including non-zero trailing bits). */
export function b64uDecode(s: string): Uint8Array | null {
  if (!B64U.test(s) || s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const c of s) {
    acc = (acc << 6) | LOOKUP[c];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if ((acc & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

export function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const utf8 = (s: string) => new TextEncoder().encode(s);
export const sha256Hex = (s: string) => hex(sha256(utf8(s)));

/** The bytes a request's signature covers. */
export function signedBytes(fn: string, fields: (string | number)[], ts: number): Uint8Array {
  return utf8([PROTOCOL, fn, ...fields.map(String), String(ts)].join("\n"));
}

/** Ed25519 signature check (strict RFC 8032 decoding, no ZIP-215 leniency). */
export function verifySig(pubB64: string, sigB64: string, msg: Uint8Array): boolean {
  const pub = b64uDecode(pubB64);
  const sig = b64uDecode(sigB64);
  if (!pub || pub.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    return ed25519.verify(sig, msg, pub, { zip215: false });
  } catch {
    return false;
  }
}

/** Constant-time comparison of two byte strings of public length. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function hmacOk(keyB64: string, msg: string, macB64: string): boolean {
  const key = b64uDecode(keyB64);
  const given = b64uDecode(macB64);
  if (!key || !given) return false;
  return sameBytes(hmac(sha256, key, utf8(msg)), given);
}

export function fresh(ts: number, now: number): boolean {
  return Number.isSafeInteger(ts) && Math.abs(now - ts) <= REQUEST_WINDOW_MS;
}

/**
 * A fixed-window rate limit: counts one hit on `key`; false once `max` hits fell in the current window. The caller
 * returns a refusal (not a throw), so the count sticks even though the request is refused.
 */
export async function hit(ctx: MutationCtx, key: string, windowMs: number, max: number, now: number): Promise<boolean> {
  const windowStart = now - (now % windowMs);
  const row = await ctx.db
    .query("rateLimits")
    .withIndex("by_key", (q) => q.eq("key", key).eq("windowStart", windowStart))
    .unique();
  if (!row) {
    await ctx.db.insert("rateLimits", { key, windowStart, count: 1 });
    return true;
  }
  if (row.count >= max) return false;
  await ctx.db.patch(row._id, { count: row.count + 1 });
  return true;
}
