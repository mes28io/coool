// A stand-in Mac for the relay tests, built on the same protocol library (the real Mac is crates/remote).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../src/protocol.mjs";
import { Relay } from "../src/relay.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RELAY_DIR = path.join(here, "..", "..", "relay");

/** The dev deployment's URL: COOOL_REMOTE_RELAY, else the relay folder's .env.local (written by `npx convex dev`). */
export function relayUrl() {
  if (process.env.COOOL_REMOTE_RELAY) return process.env.COOOL_REMOTE_RELAY;
  const env = fs.readFileSync(path.join(RELAY_DIR, ".env.local"), "utf8");
  return env.match(/^CONVEX_URL=(\S+)/m)[1];
}

/** Every row the relay stores about `macId`, through the internal `debug:dump` (admin access of the Convex CLI). */
export function dump(macId) {
  const out = execFileSync("npx", ["convex", "run", "debug:dump", JSON.stringify({ macId })], { cwd: RELAY_DIR, encoding: "utf8" });
  return JSON.parse(out.slice(out.indexOf("{")));
}

export class MacSim {
  constructor(url) {
    this.relay = new Relay(url);
    this.id = P.newIdentity();
    this.macId = P.randomId();
    this.sendCounter = 0;
    this.guards = new Map();
  }
  register() {
    return this.relay.registerMac(this.id.signPriv, this.macId, this.id.signPub, this.id.boxPub);
  }
  async openPairing(ttlMs = 120_000) {
    const secret = P.b64u(Buffer.from(crypto.getRandomValues(new Uint8Array(32))));
    const pairingId = P.randomId();
    this.k = P.pairingKeys(P.unb64u(secret, 32));
    this.pairingId = pairingId;
    const r = await this.relay.createPairing(this.id.signPriv, this.macId, pairingId, P.b64u(this.k.relayKey), Date.now() + ttlMs);
    if (!r.ok) throw new Error(`createPairing: ${r.code}`);
    return P.pairUrl({ relay: this.relay.url, macId: this.macId, pairingId, secret, macSignPub: this.id.signPub, macBoxPub: this.id.boxPub });
  }
  async inbox() {
    if (!this.token) {
      const r = await this.relay.openSession(this.id.signPriv, "mac", this.macId, "");
      if (!r.ok) throw new Error(`openSession: ${r.code}`);
      this.token = r.token;
    }
    return await this.relay.query("macInbox", { token: this.token });
  }
  /** The claim waiting for the click, checked as the real Mac checks it (proof and code). */
  async claim() {
    const r = await this.inbox();
    const c = r.claims.find((x) => x.pairingId === this.pairingId);
    if (!c) return null;
    const ok = P.proofOk(this.k.macKey, c, c.proofMac);
    const name = P.openName(this.k.nameKey, c.pairingId, c.deviceId, c.nameBox);
    const code = P.pairingCode(this.k.codeKey, { pairingId: c.pairingId, macId: this.macId, macSignPub: this.id.signPub, macBoxPub: this.id.boxPub, deviceId: c.deviceId, devSignPub: c.signPub, devBoxPub: c.boxPub });
    return { ...c, proofOk: ok, name, code };
  }
  confirm(deviceId) {
    return this.relay.confirmPairing(this.id.signPriv, this.macId, this.pairingId, deviceId);
  }
  keysFor(c) {
    const shared = P.sharedSecret(this.id.boxPriv, c.boxPub);
    return P.sessionKeys(shared, { macId: this.macId, deviceId: c.deviceId, macBoxPub: this.id.boxPub, devBoxPub: c.boxPub });
  }
  async sendTo(c, t, b) {
    this.sendCounter = P.nextCounter(this.sendCounter);
    const ct = P.seal(this.keysFor(c).m2d, "m2d", this.macId, c.deviceId, this.sendCounter, P.envelope(t, b));
    return await this.relay.send(this.id.signPriv, this.macId, c.deviceId, "m2d", this.sendCounter, ct);
  }
  revoke(deviceId) {
    return this.relay.revokeDevice(this.id.signPriv, this.macId, deviceId);
  }
  async close() {
    await this.relay.close();
  }
}
