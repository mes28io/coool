// The phone's side of coool Remote: pair from a QR payload, then receive the Mac's messages and send it commands.
// State (keys, ids, counters) lives in a JSON file the caller names; the iPhone app keeps the private keys in the
// iOS Keychain (device-only) instead.

import fs from "node:fs";
import * as P from "./protocol.mjs";
import { Relay } from "./relay.mjs";

export class Phone {
  /** `state`: a saved pairing (from `toJSON`), or null for a phone that hasn't paired. */
  constructor(state = null) {
    this.s = state;
    this.relay = state ? new Relay(state.relay) : null;
    this.keys = state ? this.#keys() : null;
    this.guard = new P.ReplayGuard(state?.recvHighWater ?? 0);
    this.unsub = null;
  }

  static load(path) {
    return new Phone(fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : null);
  }
  save(path) {
    fs.writeFileSync(path, JSON.stringify(this.toJSON(), null, 2), { mode: 0o600 });
  }
  toJSON() {
    return { ...this.s, recvHighWater: this.guard.highWater };
  }

  #keys() {
    const s = this.s;
    const shared = P.sharedSecret(s.id.boxPriv, s.mac.boxPub);
    return P.sessionKeys(shared, { macId: s.mac.macId, deviceId: s.deviceId, macBoxPub: s.mac.boxPub, devBoxPub: s.id.boxPub });
  }

  /**
   * Claims the pairing in `qr` (the `coool://pair?...` payload). Returns the 6-digit code to show; the pairing is
   * complete only once the Mac's person clicks Pair (`waitPaired`).
   */
  async claim(qr, name) {
    const q = P.parsePairUrl(qr);
    const id = P.newIdentity();
    const deviceId = P.randomId();
    const k = P.pairingKeys(P.unb64u(q.secret, 32));
    const c = { pairingId: q.pairingId, deviceId, signPub: id.signPub, boxPub: id.boxPub, nameBox: P.sealName(k.nameKey, q.pairingId, deviceId, name) };
    c.proofRelay = P.proof(k.relayKey, c);
    c.proofMac = P.proof(k.macKey, c);
    const relay = new Relay(q.relay);
    const r = await relay.claimPairing(id.signPriv, c);
    if (!r.ok) throw new Error(`pairing refused by the relay: ${r.code}`);
    const code = P.pairingCode(k.codeKey, { pairingId: q.pairingId, macId: q.macId, macSignPub: q.macSignPub, macBoxPub: q.macBoxPub, deviceId, devSignPub: id.signPub, devBoxPub: id.boxPub });
    this.pending = { relay, id, deviceId, q, name };
    return code;
  }

  /** Waits until the Mac confirms (true) or refuses / lets it expire (false). */
  async waitPaired({ timeoutMs = 180_000, pollMs = 1_000 } = {}) {
    const { relay, id, deviceId, q, name } = this.pending;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = await relay.claimStatus(id.signPriv, q.pairingId, deviceId);
      if (r.ok && r.state === "paired") {
        this.s = { v: P.VERSION, relay: q.relay, name, deviceId, id, mac: { macId: q.macId, signPub: q.macSignPub, boxPub: q.macBoxPub }, sendCounter: 0, recvHighWater: 0 };
        this.relay = relay;
        this.keys = this.#keys();
        this.guard = new P.ReplayGuard(0);
        this.pending = null;
        return true;
      }
      if (!r.ok || r.state === "refused" || r.state === "expired") return false;
      await new Promise((res) => setTimeout(res, pollMs));
    }
    return false;
  }

  get paired() {
    return !!this.s;
  }

  /**
   * Opens a read session and subscribes to the Mac's messages. `onMessage(msg)` gets each decrypted message once,
   * in counter order; `onEvent(e)` gets everything else worth knowing (`{kind: "refused" | "revoked" | "presence"}`).
   */
  async connect(onMessage, onEvent = () => {}) {
    const s = this.s;
    const r = await this.relay.openSession(s.id.signPriv, "device", s.mac.macId, s.deviceId);
    if (!r.ok) throw new Error(`the relay refused this device: ${r.code}`);
    let busy = Promise.resolve();
    this.unsub = this.relay.subscribe(
      "deviceInbox",
      { token: r.token },
      (res) => {
        busy = busy.then(() => this.#take(res, onMessage, onEvent)).catch((e) => onEvent({ kind: "error", error: String(e) }));
      },
      (e) => onEvent({ kind: "error", error: String(e) }),
    );
  }

  async #take(res, onMessage, onEvent) {
    if (!res?.ok) {
      onEvent({ kind: res?.code === "revoked" ? "revoked" : "session", code: res?.code });
      return;
    }
    onEvent({ kind: "presence", macLastSeen: res.macLastSeen });
    const s = this.s;
    let top = 0;
    for (const m of [...res.messages].sort((a, b) => a.counter - b.counter)) {
      top = Math.max(top, m.counter);
      if (m.counter <= this.guard.highWater) continue; // already handled (or a replay): never handled twice
      let msg;
      try {
        msg = P.open(this.keys.m2d, "m2d", s.mac.macId, s.deviceId, m.counter, m.ciphertext);
      } catch {
        onEvent({ kind: "refused", reason: "does not decrypt", counter: m.counter });
        continue;
      }
      this.guard.accept(m.counter);
      onMessage(msg);
    }
    if (top) await this.relay.ack(s.id.signPriv, s.mac.macId, s.deviceId, "m2d", top);
  }

  /** Seals and sends one message; returns its envelope (its `id` is what the Mac's `result` names). */
  async send(t, b = {}) {
    const s = this.s;
    const env = P.envelope(t, b);
    s.sendCounter = P.nextCounter(s.sendCounter ?? 0);
    const ct = P.seal(this.keys.d2m, "d2m", s.mac.macId, s.deviceId, s.sendCounter, env);
    const r = await this.relay.send(s.id.signPriv, s.mac.macId, s.deviceId, "d2m", s.sendCounter, ct);
    if (!r.ok) throw Object.assign(new Error(`the relay refused the message: ${r.code}`), { code: r.code });
    return { env, counter: s.sendCounter, ciphertext: ct };
  }

  // The commands (docs/REMOTE.md "Messages").
  hello() {
    return this.send("hello", { name: this.s.name });
  }
  getSnapshot() {
    return this.send("get_snapshot");
  }
  getChat(sessionId) {
    return this.send("get_chat", { session: sessionId });
  }
  /** `choice`: "allow_once" | "deny" | "option" (with `option`, a label) | "text" (with `text`). */
  answer(needId, choice, extra = {}) {
    return this.send("answer", { need: needId, choice, ...extra });
  }
  sendText(sessionId, text) {
    return this.send("send", { session: sessionId, text });
  }
  stop(sessionId) {
    return this.send("stop", { session: sessionId });
  }
  start(projectId, cli, text) {
    return this.send("start", { project: projectId, cli, text });
  }

  async close() {
    this.unsub?.();
    await this.relay?.close();
  }
}
