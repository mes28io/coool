// The relay's client side, as remote/phone/src/relay.mjs: signed mutations, the signed `claimStatus` query, and the
// `deviceInbox` live query, through Convex's official Swift client (ConvexMobile). Every request is signed as in
// RemoteProtocol's `requestBytes`; the field lists match remote/relay/convex/relay.ts and docs/REMOTE.md.
// The relay's address comes from the pairing link, never from here.

import Combine
import ConvexMobile
import Foundation
import RemoteProtocol

/// The relay's `{ok, code?, ...}` answer.
struct RelayAnswer: Decodable {
  var ok: Bool
  var code: String?
  var state: String?
}

final class RelayClient: @unchecked Sendable {
  let url: String
  private let client: ConvexClient

  init(url: String) {
    self.url = url
    client = ConvexClient(deploymentUrl: url)
  }

  /// A signed mutation: `fields` in the order the relay signs them.
  func call(_ fn: String, _ id: Identity, fields: [String], args: [String: ConvexEncodable?]) async throws -> RelayAnswer {
    let ts = nowMs()
    var a = args
    a["ts"] = Double(ts)
    a["sig"] = id.sign(requestBytes(fn, fields, ts: ts))
    return try await client.mutation("relay:\(fn)", with: a)
  }

  func claimPairing(_ id: Identity, _ c: Claim) async throws -> RelayAnswer {
    try await call("claimPairing", id, fields: c.fields, args: [
      "pairingId": c.pairingId, "deviceId": c.deviceId, "signPub": c.signPub, "boxPub": c.boxPub,
      "nameBox": c.nameBox, "proofRelay": c.proofRelay, "proofMac": c.proofMac,
    ])
  }

  /// `claimStatus` is a query: read once through a short subscription.
  func claimStatus(_ id: Identity, pairingId: String, deviceId: String) async throws -> RelayAnswer {
    let ts = nowMs()
    let args: [String: ConvexEncodable?] = ["pairingId": pairingId, "deviceId": deviceId, "ts": Double(ts),
                                            "sig": id.sign(requestBytes("claimStatus", [pairingId, deviceId], ts: ts))]
    for try await v in client.subscribe(to: "relay:claimStatus", with: args, yielding: RelayAnswer.self).values {
      return v
    }
    throw CancellationError()
  }

  /// Opens a read session; returns the token for the live query, or the refusal.
  func openSession(_ m: PairedMac) async throws -> (token: String?, answer: RelayAnswer) {
    let t = newToken()
    let r = try await call("openSession", m.identity, fields: ["device", m.macId, m.deviceId, t.tokenHash],
                           args: ["role": "device", "macId": m.macId, "deviceId": m.deviceId, "tokenHash": t.tokenHash])
    return (r.ok ? t.token : nil, r)
  }

  func send(_ m: PairedMac, counter: UInt64, ciphertext: String) async throws -> RelayAnswer {
    try await call("send", m.identity, fields: [m.macId, m.deviceId, "d2m", String(counter), sha256Hex(ciphertext)],
                   args: ["macId": m.macId, "deviceId": m.deviceId, "dir": "d2m", "counter": Double(counter), "ciphertext": ciphertext])
  }

  func ack(_ m: PairedMac, upTo: UInt64) async throws -> RelayAnswer {
    try await call("ack", m.identity, fields: [m.macId, m.deviceId, "m2d", String(upTo)],
                   args: ["macId": m.macId, "deviceId": m.deviceId, "dir": "m2d", "upTo": Double(upTo)])
  }

  /// The device's queue, live: a new value whenever it changes (a message, an ack, the Mac's heartbeat).
  func inbox(token: String) -> AnyPublisher<InboxResult, ClientError> {
    client.subscribe(to: "relay:deviceInbox", with: ["token": token], yielding: InboxResult.self)
  }
}
