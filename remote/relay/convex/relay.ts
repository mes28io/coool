// coool Remote relay: the public functions (docs/REMOTE.md "Relay requests").
//
// Every mutation checks a signature by the key registered for its sender and the request time, and answers
// `{ ok: true, ... }` or a refusal `{ ok: false, code }`. Refusals are returned rather than thrown so the rate-limit
// and attempt counts a refused request bumps are kept (a throw rolls the whole mutation back).
//
// Reads (the live queries `macInbox` / `deviceInbox`) take a session token opened with a signed `openSession`.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  CONFIRM_WINDOW_MS,
  MAX_CIPHERTEXT,
  MAX_QUEUE,
  PAIRING_TTL_MS,
  PROTOCOL,
  SESSION_TTL_MS,
  fresh,
  hit,
  hmacOk,
  isB64,
  isB64Bytes,
  isHash,
  isId,
  refuse,
  sha256Hex,
  signedBytes,
  verifySig,
} from "./lib";

const dirV = v.union(v.literal("m2d"), v.literal("d2m"));

async function macRow(ctx: QueryCtx, macId: string) {
  return await ctx.db
    .query("macs")
    .withIndex("by_mac", (q) => q.eq("macId", macId))
    .unique();
}

async function deviceRow(ctx: QueryCtx, macId: string, deviceId: string) {
  return await ctx.db
    .query("devices")
    .withIndex("by_mac_device", (q) => q.eq("macId", macId).eq("deviceId", deviceId))
    .unique();
}

async function pairingRow(ctx: QueryCtx, pairingId: string) {
  return await ctx.db
    .query("pairings")
    .withIndex("by_pairing", (q) => q.eq("pairingId", pairingId))
    .unique();
}

/** The Mac's signature on a request, or a refusal code. */
async function checkMac(ctx: QueryCtx, macId: string, fn: string, fields: (string | number)[], ts: number, sig: string, now: number) {
  if (!isId(macId)) return "bad_args";
  if (!fresh(ts, now)) return "stale";
  const mac = await macRow(ctx, macId);
  if (!mac) return "unknown_mac";
  if (!verifySig(mac.signPub, sig, signedBytes(fn, fields, ts))) return "bad_signature";
  return null;
}

async function touchPresence(ctx: MutationCtx, macId: string, now: number) {
  const p = await ctx.db
    .query("presence")
    .withIndex("by_mac", (q) => q.eq("macId", macId))
    .unique();
  if (!p) await ctx.db.insert("presence", { macId, lastSeen: now });
  // Coarse, so a busy Mac doesn't rewrite the row (and wake every phone's subscription) on each request.
  else if (now - p.lastSeen > 15_000) await ctx.db.patch(p._id, { lastSeen: now });
}

// ---------------------------------------------------------------- the Mac

/** Fields signed: macId, signPub, boxPub. The first registration of a Mac id wins; later ones must match it. */
export const registerMac = mutation({
  args: { macId: v.string(), signPub: v.string(), boxPub: v.string(), ts: v.number(), sig: v.string() },
  handler: async (ctx, a) => {
    const now = Date.now();
    if (!isId(a.macId) || !isB64Bytes(a.signPub, 32) || !isB64Bytes(a.boxPub, 32)) return refuse("bad_args");
    if (!fresh(a.ts, now)) return refuse("stale");
    if (!verifySig(a.signPub, a.sig, signedBytes("registerMac", [a.macId, a.signPub, a.boxPub], a.ts))) return refuse("bad_signature");
    if (!(await hit(ctx, `register:${a.macId}`, 3_600_000, 30, now))) return refuse("rate_limited");
    const mac = await macRow(ctx, a.macId);
    if (mac) {
      if (mac.signPub !== a.signPub || mac.boxPub !== a.boxPub) return refuse("mac_exists");
      return { ok: true as const };
    }
    await ctx.db.insert("macs", { macId: a.macId, signPub: a.signPub, boxPub: a.boxPub, createdAt: now });
    await touchPresence(ctx, a.macId, now);
    return { ok: true as const };
  },
});

/** Fields signed: macId, pairingId, relayKey, expiresAt. Expiry is capped at two minutes from now. */
export const createPairing = mutation({
  args: { macId: v.string(), pairingId: v.string(), relayKey: v.string(), expiresAt: v.number(), ts: v.number(), sig: v.string() },
  handler: async (ctx, a) => {
    const now = Date.now();
    if (!isId(a.pairingId) || !isB64Bytes(a.relayKey, 32) || !Number.isSafeInteger(a.expiresAt)) return refuse("bad_args");
    const bad = await checkMac(ctx, a.macId, "createPairing", [a.macId, a.pairingId, a.relayKey, a.expiresAt], a.ts, a.sig, now);
    if (bad) return refuse(bad);
    if (!(await hit(ctx, `pairings:${a.macId}`, 3_600_000, 20, now))) return refuse("rate_limited");
    if (await pairingRow(ctx, a.pairingId)) return refuse("pairing_exists");
    // Only one open pairing per Mac: a new one cancels the last.
    for (const p of await ctx.db.query("pairings").withIndex("by_mac", (q) => q.eq("macId", a.macId)).collect()) {
      if (p.state === "open" || p.state === "claimed") await ctx.db.patch(p._id, { state: "cancelled" });
    }
    const expiresAt = Math.min(a.expiresAt, now + PAIRING_TTL_MS);
    await ctx.db.insert("pairings", { pairingId: a.pairingId, macId: a.macId, relayKey: a.relayKey, expiresAt, state: "open", createdAt: now, attempts: 0 });
    return { ok: true as const, expiresAt };
  },
});

/** Fields signed: macId, pairingId. */
export const cancelPairing = mutation({
  args: { macId: v.string(), pairingId: v.string(), ts: v.number(), sig: v.string() },
  handler: async (ctx, a) => {
    const now = Date.now();
    const bad = await checkMac(ctx, a.macId, "cancelPairing", [a.macId, a.pairingId], a.ts, a.sig, now);
    if (bad) return refuse(bad);
    const p = await pairingRow(ctx, a.pairingId);
    if (!p || p.macId !== a.macId) return refuse("unknown_pairing");
    if (p.state === "open" || p.state === "claimed") await ctx.db.patch(p._id, { state: "cancelled" });
    return { ok: true as const };
  },
});

/**
 * The click on the Mac. Fields signed: macId, pairingId, deviceId. The pairing must be claimed by that device; the
 * device row (its keys from the claim) is created here and nowhere else.
 */
export const confirmPairing = mutation({
  args: { macId: v.string(), pairingId: v.string(), deviceId: v.string(), ts: v.number(), sig: v.string() },
  handler: async (ctx, a) => {
    const now = Date.now();
    const bad = await checkMac(ctx, a.macId, "confirmPairing", [a.macId, a.pairingId, a.deviceId], a.ts, a.sig, now);
    if (bad) return refuse(bad);
    const p = await pairingRow(ctx, a.pairingId);
    if (!p || p.macId !== a.macId) return refuse("unknown_pairing");
    if (p.state !== "claimed" || !p.claim || p.claim.deviceId !== a.deviceId) return refuse("not_claimed");
    if (now > p.createdAt + CONFIRM_WINDOW_MS) return refuse("expired");
    if (await ctx.db.query("devices").withIndex("by_device", (q) => q.eq("deviceId", a.deviceId)).first()) return refuse("device_exists");
    await ctx.db.insert("devices", {
      macId: a.macId,
      deviceId: a.deviceId,
      signPub: p.claim.signPub,
      boxPub: p.claim.boxPub,
      revoked: false,
      createdAt: now,
      lastSeen: now,
      hwM2d: 0,
      hwD2m: 0,
    });
    await ctx.db.patch(p._id, { state: "used" });
    return { ok: true as const };
  },
});

/** Fields signed: macId, deviceId. Revoked for good: its sessions and queued messages go, and it can't come back. */
export const revokeDevice = mutation({
  args: { macId: v.string(), deviceId: v.string(), ts: v.number(), sig: v.string() },
  handler: async (ctx, a) => {
    const now = Date.now();
    const bad = await checkMac(ctx, a.macId, "revokeDevice", [a.macId, a.deviceId], a.ts, a.sig, now);
    if (bad) return refuse(bad);
    const d = await deviceRow(ctx, a.macId, a.deviceId);
    if (!d) return refuse("unknown_device");
    await ctx.db.patch(d._id, { revoked: true });
    for (const s of await ctx.db.query("sessions").withIndex("by_mac_device", (q) => q.eq("macId", a.macId).eq("deviceId", a.deviceId)).collect()) {
      await ctx.db.delete(s._id);
    }
    for (const dir of ["m2d", "d2m"] as const) {
      const rows = await ctx.db
        .query("messages")
        .withIndex("by_queue", (q) => q.eq("macId", a.macId).eq("deviceId", a.deviceId).eq("dir", dir))
        .take(MAX_QUEUE + 10);
      for (const m of rows) await ctx.db.delete(m._id);
    }
    return { ok: true as const };
  },
});

// ---------------------------------------------------------------- the device

/**
 * Fields signed (by the claimant's own new key): pairingId, deviceId, signPub, boxPub, nameBox, proofRelay, proofMac.
 * `proofRelay` = HMAC(relayKey, claim transcript) shows the claimant scanned the QR code; `proofMac` is for the Mac.
 * One claim per pairing, before it expires; five attempts at most.
 */
export const claimPairing = mutation({
  args: {
    pairingId: v.string(),
    deviceId: v.string(),
    signPub: v.string(),
    boxPub: v.string(),
    nameBox: v.string(),
    proofRelay: v.string(),
    proofMac: v.string(),
    ts: v.number(),
    sig: v.string(),
  },
  handler: async (ctx, a) => {
    const now = Date.now();
    if (!isId(a.pairingId) || !isId(a.deviceId) || !isB64Bytes(a.signPub, 32) || !isB64Bytes(a.boxPub, 32) || !isB64(a.nameBox, 400) || !isB64Bytes(a.proofRelay, 32) || !isB64Bytes(a.proofMac, 32))
      return refuse("bad_args");
    if (!fresh(a.ts, now)) return refuse("stale");
    const fields = [a.pairingId, a.deviceId, a.signPub, a.boxPub, a.nameBox, a.proofRelay, a.proofMac];
    if (!verifySig(a.signPub, a.sig, signedBytes("claimPairing", fields, a.ts))) return refuse("bad_signature");
    const p = await pairingRow(ctx, a.pairingId);
    if (!p) return refuse("unknown_pairing");
    if (!(await hit(ctx, `claims:${p.macId}`, 3_600_000, 30, now))) return refuse("rate_limited");
    if (p.attempts >= 5) return refuse("rate_limited");
    await ctx.db.patch(p._id, { attempts: p.attempts + 1 });
    if (p.state !== "open") return refuse("used");
    if (now > p.expiresAt) return refuse("expired");
    const transcript = [PROTOCOL, "claim", a.pairingId, a.deviceId, a.signPub, a.boxPub, a.nameBox].join("\n");
    if (!hmacOk(p.relayKey, transcript, a.proofRelay)) return refuse("bad_proof");
    if (await ctx.db.query("devices").withIndex("by_device", (q) => q.eq("deviceId", a.deviceId)).first()) return refuse("device_exists");
    await ctx.db.patch(p._id, {
      state: "claimed",
      claim: { deviceId: a.deviceId, signPub: a.signPub, boxPub: a.boxPub, nameBox: a.nameBox, proofMac: a.proofMac, claimedAt: now },
    });
    return { ok: true as const };
  },
});

/** Fields signed (by the claimant's key): pairingId, deviceId. Where a claim stands: pending, paired, refused or expired. */
export const claimStatus = query({
  args: { pairingId: v.string(), deviceId: v.string(), ts: v.number(), sig: v.string() },
  handler: async (ctx, a) => {
    const p = await pairingRow(ctx, a.pairingId);
    if (!p || !p.claim || p.claim.deviceId !== a.deviceId) return refuse("unknown_pairing");
    if (!verifySig(p.claim.signPub, a.sig, signedBytes("claimStatus", [a.pairingId, a.deviceId], a.ts))) return refuse("bad_signature");
    if (p.state === "used") {
      const d = await deviceRow(ctx, p.macId, a.deviceId);
      return { ok: true as const, state: d && !d.revoked ? "paired" : "refused" };
    }
    if (p.state === "cancelled") return { ok: true as const, state: "refused" };
    if (Date.now() > p.createdAt + CONFIRM_WINDOW_MS) return { ok: true as const, state: "expired" };
    return { ok: true as const, state: "pending" };
  },
});

// ---------------------------------------------------------------- both

/**
 * Fields signed: role, macId, deviceId ("" for the Mac), tokenHash. Opens a read session for the live queries:
 * `tokenHash` is the SHA-256 (hex) of a random token only the client knows.
 */
export const openSession = mutation({
  args: { role: v.union(v.literal("mac"), v.literal("device")), macId: v.string(), deviceId: v.string(), tokenHash: v.string(), ts: v.number(), sig: v.string() },
  handler: async (ctx, a) => {
    const now = Date.now();
    if (!isId(a.macId) || !isHash(a.tokenHash) || (a.role === "device" ? !isId(a.deviceId) : a.deviceId !== "")) return refuse("bad_args");
    if (!fresh(a.ts, now)) return refuse("stale");
    const fields = [a.role, a.macId, a.deviceId, a.tokenHash];
    if (a.role === "mac") {
      const bad = await checkMac(ctx, a.macId, "openSession", fields, a.ts, a.sig, now);
      if (bad) return refuse(bad);
      await touchPresence(ctx, a.macId, now);
    } else {
      const d = await deviceRow(ctx, a.macId, a.deviceId);
      if (!d || d.revoked) return refuse("revoked");
      if (!verifySig(d.signPub, a.sig, signedBytes("openSession", fields, a.ts))) return refuse("bad_signature");
      await ctx.db.patch(d._id, { lastSeen: now });
    }
    if (!(await hit(ctx, `sessions:${a.macId}:${a.deviceId}`, 3_600_000, 60, now))) return refuse("rate_limited");
    const deviceId = a.role === "device" ? a.deviceId : undefined;
    const old = await ctx.db.query("sessions").withIndex("by_mac_device", (q) => q.eq("macId", a.macId).eq("deviceId", deviceId)).collect();
    // Keep the newest few (a client may hold one while it opens the next).
    for (const s of old.sort((x, y) => y.expiresAt - x.expiresAt).slice(3)) await ctx.db.delete(s._id);
    const expiresAt = now + SESSION_TTL_MS;
    await ctx.db.insert("sessions", { tokenHash: a.tokenHash, role: a.role, macId: a.macId, deviceId, expiresAt });
    return { ok: true as const, expiresAt };
  },
});

/**
 * Fields signed: macId, deviceId, dir, counter, sha256(ciphertext) (hex). Signed by the Mac for `m2d`, by the device
 * for `d2m`. Refused for a revoked device either way, and for a counter not above the last one accepted.
 */
export const send = mutation({
  args: { macId: v.string(), deviceId: v.string(), dir: dirV, counter: v.number(), ciphertext: v.string(), ts: v.number(), sig: v.string() },
  handler: async (ctx, a) => {
    const now = Date.now();
    if (!isId(a.macId) || !isId(a.deviceId) || !Number.isSafeInteger(a.counter) || a.counter <= 0 || !isB64(a.ciphertext, MAX_CIPHERTEXT)) return refuse("bad_args");
    if (!fresh(a.ts, now)) return refuse("stale");
    const d = await deviceRow(ctx, a.macId, a.deviceId);
    if (!d || d.revoked) return refuse("revoked");
    const fields = [a.macId, a.deviceId, a.dir, a.counter, sha256Hex(a.ciphertext)];
    let signer = d.signPub;
    if (a.dir === "m2d") {
      const mac = await macRow(ctx, a.macId);
      if (!mac) return refuse("unknown_mac");
      signer = mac.signPub;
    }
    if (!verifySig(signer, a.sig, signedBytes("send", fields, a.ts))) return refuse("bad_signature");
    const ok = a.dir === "d2m" ? await hit(ctx, `d2m:${a.deviceId}`, 60_000, 120, now) : await hit(ctx, `m2d:${a.deviceId}`, 60_000, 600, now);
    if (!ok) return refuse("rate_limited");
    const hw = a.dir === "m2d" ? d.hwM2d : d.hwD2m;
    if (a.counter <= hw) return refuse("replay");
    const queued = await ctx.db
      .query("messages")
      .withIndex("by_queue", (q) => q.eq("macId", a.macId).eq("deviceId", a.deviceId).eq("dir", a.dir))
      .take(MAX_QUEUE);
    if (queued.length >= MAX_QUEUE) return refuse("queue_full");
    await ctx.db.insert("messages", { macId: a.macId, deviceId: a.deviceId, dir: a.dir, counter: a.counter, ciphertext: a.ciphertext, createdAt: now });
    await ctx.db.patch(d._id, a.dir === "m2d" ? { hwM2d: a.counter } : { hwD2m: a.counter, lastSeen: Math.max(d.lastSeen, now) });
    if (a.dir === "m2d") await touchPresence(ctx, a.macId, now);
    return { ok: true as const };
  },
});

/** Fields signed: macId, deviceId, dir, upTo. By the receiver of `dir`: deletes its messages up to that counter. */
export const ack = mutation({
  args: { macId: v.string(), deviceId: v.string(), dir: dirV, upTo: v.number(), ts: v.number(), sig: v.string() },
  handler: async (ctx, a) => {
    const now = Date.now();
    if (!isId(a.macId) || !isId(a.deviceId) || !Number.isSafeInteger(a.upTo)) return refuse("bad_args");
    if (!fresh(a.ts, now)) return refuse("stale");
    const d = await deviceRow(ctx, a.macId, a.deviceId);
    if (!d) return refuse("unknown_device");
    let signer: string;
    if (a.dir === "m2d") {
      if (d.revoked) return refuse("revoked");
      signer = d.signPub;
    } else {
      const mac = await macRow(ctx, a.macId);
      if (!mac) return refuse("unknown_mac");
      signer = mac.signPub;
    }
    if (!verifySig(signer, a.sig, signedBytes("ack", [a.macId, a.deviceId, a.dir, a.upTo], a.ts))) return refuse("bad_signature");
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_queue", (q) => q.eq("macId", a.macId).eq("deviceId", a.deviceId).eq("dir", a.dir).lte("counter", a.upTo))
      .take(200);
    for (const m of rows) await ctx.db.delete(m._id);
    if (a.dir === "d2m") await touchPresence(ctx, a.macId, now);
    // A phone acknowledging is a phone in use: the Mac sends live changes to devices seen lately.
    else if (now - d.lastSeen > 15_000) await ctx.db.patch(d._id, { lastSeen: now });
    return { ok: true as const, deleted: rows.length };
  },
});

/** Fields signed: macId. The Mac is up ("last seen" for its phones). */
export const heartbeat = mutation({
  args: { macId: v.string(), ts: v.number(), sig: v.string() },
  handler: async (ctx, a) => {
    const now = Date.now();
    const bad = await checkMac(ctx, a.macId, "heartbeat", [a.macId], a.ts, a.sig, now);
    if (bad) return refuse(bad);
    await touchPresence(ctx, a.macId, now);
    return { ok: true as const };
  },
});

// ---------------------------------------------------------------- live queries

async function session(ctx: QueryCtx, token: string, role: "mac" | "device") {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const s = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q) => q.eq("tokenHash", sha256Hex(token)))
    .unique();
  if (!s || s.role !== role || s.expiresAt < Date.now()) return null;
  return s;
}

/**
 * The Mac's live view: messages from its devices (oldest first) and claims waiting for the click. It reads no
 * `devices` row, so the Mac's own sends (which bump a device's counter) don't re-run it; see `macDevices`.
 */
export const macInbox = query({
  args: { token: v.string() },
  handler: async (ctx, a) => {
    const s = await session(ctx, a.token, "mac");
    if (!s) return refuse("session");
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_mac_dir", (q) => q.eq("macId", s.macId).eq("dir", "d2m"))
      .take(100);
    const pairings = await ctx.db.query("pairings").withIndex("by_mac", (q) => q.eq("macId", s.macId)).collect();
    return {
      ok: true as const,
      messages: messages.map((m) => ({ deviceId: m.deviceId, counter: m.counter, ciphertext: m.ciphertext, createdAt: m.createdAt })),
      claims: pairings
        .filter((p) => p.state === "claimed" && p.claim)
        .map((p) => ({ pairingId: p.pairingId, createdAt: p.createdAt, ...p.claim! })),
    };
  },
});

/** The Mac's devices as the relay sees them (when each was last seen), read now and then rather than live. */
export const macDevices = query({
  args: { token: v.string() },
  handler: async (ctx, a) => {
    const s = await session(ctx, a.token, "mac");
    if (!s) return refuse("session");
    const devices = await ctx.db.query("devices").withIndex("by_mac", (q) => q.eq("macId", s.macId)).collect();
    return { ok: true as const, devices: devices.map((d) => ({ deviceId: d.deviceId, revoked: d.revoked, lastSeen: d.lastSeen })) };
  },
});

/** A device's live view: messages from its Mac (oldest first) and when the Mac was last seen. */
export const deviceInbox = query({
  args: { token: v.string() },
  handler: async (ctx, a) => {
    const s = await session(ctx, a.token, "device");
    if (!s || !s.deviceId) return refuse("session");
    const deviceId = s.deviceId;
    const d = await deviceRow(ctx, s.macId, deviceId);
    if (!d || d.revoked) return refuse("revoked");
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_queue", (q) => q.eq("macId", s.macId).eq("deviceId", deviceId).eq("dir", "m2d"))
      .take(100);
    const p = await ctx.db
      .query("presence")
      .withIndex("by_mac", (q) => q.eq("macId", s.macId))
      .unique();
    return {
      ok: true as const,
      messages: messages.map((m) => ({ counter: m.counter, ciphertext: m.ciphertext, createdAt: m.createdAt })),
      macLastSeen: p?.lastSeen ?? null,
    };
  },
});
