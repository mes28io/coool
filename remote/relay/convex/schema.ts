// coool Remote relay: the tables (docs/REMOTE.md "Relay (Convex)").
//
// Nothing here is readable session content: message bodies are ChaCha20-Poly1305 ciphertext the relay has no key
// for, and a pairing's device name is sealed with a key derived from the pairing secret, which the relay never gets.
// What the relay does know: which Mac id talks to which device id, when, and message sizes. It holds no push
// token and never talks to Apple (docs/REMOTE.md "No push notifications").
// No user table, no email addresses.

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row per Mac. `signPub`: its Ed25519 public key (base64url), which signs every request it makes.
  macs: defineTable({
    macId: v.string(),
    signPub: v.string(),
    boxPub: v.string(),
    createdAt: v.number(),
  }).index("by_mac", ["macId"]),

  // One row per paired device. `hw*`: the highest message counter the relay accepted in each direction, so a
  // replayed `send` is refused here too (the receivers refuse it again on their own).
  devices: defineTable({
    macId: v.string(),
    deviceId: v.string(),
    signPub: v.string(),
    boxPub: v.string(),
    revoked: v.boolean(),
    createdAt: v.number(),
    lastSeen: v.number(),
    hwM2d: v.number(),
    hwD2m: v.number(),
  })
    .index("by_mac", ["macId"])
    .index("by_mac_device", ["macId", "deviceId"])
    .index("by_device", ["deviceId"]),

  // A pairing the Mac opened ("Pair an iPhone"). `relayKey` = HKDF(pairing secret, "relay-proof"): enough to check
  // that a claimant scanned the QR code, not enough to learn the secret or forge the Mac's own proof.
  // state: open -> claimed -> used, or cancelled. A claim is taken only while open and before `expiresAt`.
  pairings: defineTable({
    pairingId: v.string(),
    macId: v.string(),
    relayKey: v.string(),
    expiresAt: v.number(),
    state: v.union(v.literal("open"), v.literal("claimed"), v.literal("used"), v.literal("cancelled")),
    createdAt: v.number(),
    attempts: v.number(),
    claim: v.optional(
      v.object({
        deviceId: v.string(),
        signPub: v.string(),
        boxPub: v.string(),
        // The device name, sealed for the Mac (base64url nonce || ciphertext).
        nameBox: v.string(),
        // HMAC for the Mac (the relay can't check it: it is keyed by a key derived from the secret).
        proofMac: v.string(),
        claimedAt: v.number(),
      }),
    ),
  })
    .index("by_pairing", ["pairingId"])
    .index("by_mac", ["macId"])
    .index("by_expiry", ["expiresAt"]),

  // The queue. `ciphertext`: base64url of ChaCha20-Poly1305 output; `counter` is its nonce and replay counter.
  messages: defineTable({
    macId: v.string(),
    deviceId: v.string(),
    dir: v.union(v.literal("m2d"), v.literal("d2m")),
    counter: v.number(),
    ciphertext: v.string(),
    createdAt: v.number(),
  })
    .index("by_queue", ["macId", "deviceId", "dir", "counter"])
    .index("by_mac_dir", ["macId", "dir", "createdAt"])
    .index("by_created", ["createdAt"]),

  // Read sessions for the live queries: a client opens one with a signed request, presenting the SHA-256 of a
  // random token only it knows; its subscriptions then pass the token. Revoking a device deletes its sessions.
  sessions: defineTable({
    tokenHash: v.string(),
    role: v.union(v.literal("mac"), v.literal("device")),
    macId: v.string(),
    deviceId: v.optional(v.string()),
    expiresAt: v.number(),
  })
    .index("by_token", ["tokenHash"])
    .index("by_mac_device", ["macId", "deviceId"])
    .index("by_expiry", ["expiresAt"]),

  presence: defineTable({
    macId: v.string(),
    lastSeen: v.number(),
  }).index("by_mac", ["macId"]),

  // Fixed-window rate limits: one row per key and window.
  rateLimits: defineTable({
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
  }).index("by_key", ["key", "windowStart"]),
});
