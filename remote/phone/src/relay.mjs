// The relay's client side: signed requests (Convex mutations over HTTP) and live queries (Convex subscriptions over
// a WebSocket). Every request is signed as in protocol.mjs `requestBytes`; the field lists match
// remote/relay/convex/relay.ts and docs/REMOTE.md "Relay requests".

import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { newToken, sha256Hex, signRequest } from "./protocol.mjs";

export class Relay {
  constructor(url) {
    this.url = url;
    this.http = new ConvexHttpClient(url);
    this.live = null;
  }

  /** A signed mutation: `fields` in the order the relay signs them; returns the relay's `{ok, ...}` answer. */
  async call(fn, signPriv, fields, args) {
    const ts = Date.now();
    const sig = signRequest(signPriv, fn, fields, ts);
    return await this.http.mutation(`relay:${fn}`, { ...args, ts, sig });
  }

  async query(fn, args) {
    return await this.http.query(`relay:${fn}`, args);
  }

  // ---- the device's requests

  claimPairing(signPriv, c) {
    const fields = [c.pairingId, c.deviceId, c.signPub, c.boxPub, c.nameBox, c.proofRelay, c.proofMac];
    return this.call("claimPairing", signPriv, fields, c);
  }

  claimStatus(signPriv, pairingId, deviceId) {
    const ts = Date.now();
    return this.query("claimStatus", { pairingId, deviceId, ts, sig: signRequest(signPriv, "claimStatus", [pairingId, deviceId], ts) });
  }

  /** Opens a read session; returns the token for the live queries. */
  async openSession(signPriv, role, macId, deviceId) {
    const { token, tokenHash } = newToken();
    const r = await this.call("openSession", signPriv, [role, macId, deviceId, tokenHash], { role, macId, deviceId, tokenHash });
    if (!r.ok) return r;
    return { ...r, token };
  }

  send(signPriv, macId, deviceId, dir, counter, ciphertext) {
    return this.call("send", signPriv, [macId, deviceId, dir, counter, sha256Hex(ciphertext)], { macId, deviceId, dir, counter, ciphertext });
  }

  ack(signPriv, macId, deviceId, dir, upTo) {
    return this.call("ack", signPriv, [macId, deviceId, dir, upTo], { macId, deviceId, dir, upTo });
  }

  // ---- the Mac's requests (the stand-in Mac in the tests uses these; the real one is crates/remote)

  registerMac(signPriv, macId, signPub, boxPub) {
    return this.call("registerMac", signPriv, [macId, signPub, boxPub], { macId, signPub, boxPub });
  }
  createPairing(signPriv, macId, pairingId, relayKey, expiresAt) {
    return this.call("createPairing", signPriv, [macId, pairingId, relayKey, expiresAt], { macId, pairingId, relayKey, expiresAt });
  }
  confirmPairing(signPriv, macId, pairingId, deviceId) {
    return this.call("confirmPairing", signPriv, [macId, pairingId, deviceId], { macId, pairingId, deviceId });
  }
  cancelPairing(signPriv, macId, pairingId) {
    return this.call("cancelPairing", signPriv, [macId, pairingId], { macId, pairingId });
  }
  revokeDevice(signPriv, macId, deviceId) {
    return this.call("revokeDevice", signPriv, [macId, deviceId], { macId, deviceId });
  }

  // ---- live queries

  /** Calls `onUpdate(result)` whenever the query's answer changes; returns an unsubscribe function. */
  subscribe(fn, args, onUpdate, onError) {
    this.live ??= new ConvexClient(this.url, { webSocketConstructor: globalThis.WebSocket, unsavedChangesWarning: false });
    return this.live.onUpdate(`relay:${fn}`, args, onUpdate, onError);
  }

  async close() {
    if (this.live) await this.live.close();
    this.live = null;
  }
}
