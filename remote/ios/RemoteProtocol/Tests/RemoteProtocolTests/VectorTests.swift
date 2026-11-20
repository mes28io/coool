// The Swift side against crates/remote/tests/vectors.json, the fixed-input results the Node and Rust sides also
// reproduce. Read from the repository (not copied), so the three can't drift apart.

import Foundation
import RemoteProtocol
import XCTest

struct Vectors: Decodable {
  struct Keys: Decodable { var boxPriv, signPriv, boxPub, signPub: String }
  var mac, dev: Keys
  var macId, deviceId, pairingId, secret, relayKey, nameBox, proofRelay, proofMac, code, shared, m2d, d2m, envelope: String
  var counter: UInt64
  var sealedD2m, requestSig, pairUrl: String

  static func load() throws -> Vectors {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { url.deleteLastPathComponent() }
    url.append(path: "crates/remote/tests/vectors.json")
    return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
  }

  func identity(_ k: Keys) throws -> Identity {
    try Identity(boxPriv: B64U.decode(k.boxPriv, length: 32), signPriv: B64U.decode(k.signPriv, length: 32))
  }
}

final class VectorTests: XCTestCase {
  var v: Vectors!
  override func setUpWithError() throws { v = try Vectors.load() }

  func testPublicKeys() throws {
    let mac = try v.identity(v.mac), dev = try v.identity(v.dev)
    XCTAssertEqual(mac.boxPub, v.mac.boxPub)
    XCTAssertEqual(mac.signPub, v.mac.signPub)
    XCTAssertEqual(dev.boxPub, v.dev.boxPub)
    XCTAssertEqual(dev.signPub, v.dev.signPub)
  }

  func testPairingClaimProofsAndCode() throws {
    let k = PairingKeys(secret: try B64U.decode(v.secret, length: 32))
    XCTAssertEqual(B64U.encode(k.relayKey), v.relayKey)
    let link = try PairLink.parse(v.pairUrl)
    let c = try PendingClaim(link: link, name: "Ada's iPhone", identity: v.identity(v.dev), deviceId: v.deviceId, nonce: Data(repeating: 5, count: 12))
    XCTAssertEqual(c.claim.nameBox, v.nameBox)
    XCTAssertEqual(c.claim.proofRelay, v.proofRelay)
    XCTAssertEqual(c.claim.proofMac, v.proofMac)
    XCTAssertEqual(c.code, v.code)
    XCTAssertEqual(try openName(nameKey: k.nameKey, pairingId: v.pairingId, deviceId: v.deviceId, box: v.nameBox), "Ada's iPhone")
  }

  func testSessionKeys() throws {
    let dev = try v.identity(v.dev)
    let shared = try sharedSecret(boxPriv: dev.boxPriv, peerBoxPub: v.mac.boxPub)
    XCTAssertEqual(B64U.encode(shared), v.shared)
    // The Mac's side of the agreement gives the same secret.
    XCTAssertEqual(try sharedSecret(boxPriv: v.identity(v.mac).boxPriv, peerBoxPub: v.dev.boxPub), shared)
    let sk = SessionKeys(shared: shared, macId: v.macId, deviceId: v.deviceId, macBoxPub: v.mac.boxPub, devBoxPub: v.dev.boxPub)
    XCTAssertEqual(B64U.encode(sk.m2d), v.m2d)
    XCTAssertEqual(B64U.encode(sk.d2m), v.d2m)
  }

  func testSealedMessage() throws {
    let key = try B64U.decode(v.d2m, length: 32)
    let sealed = try seal(key: key, dir: .d2m, macId: v.macId, deviceId: v.deviceId, counter: v.counter, plaintext: Data(v.envelope.utf8))
    XCTAssertEqual(sealed, v.sealedD2m)
    let pt = try open(key: key, dir: .d2m, macId: v.macId, deviceId: v.deviceId, counter: v.counter, ciphertext: v.sealedD2m)
    XCTAssertEqual(String(decoding: pt, as: UTF8.self), v.envelope)
    let env = try Envelope.parse(pt)
    XCTAssertEqual(env.t, "send")
    XCTAssertEqual(env.at, 1_763_640_000_000)
    XCTAssertEqual(env.b, ["session": "claude:abc", "text": "hi"])
    // This side's encoding of the same envelope reads back the same on the other side.
    XCTAssertEqual(try Envelope.parse(env.json()), env)
  }

  /// CryptoKit's Ed25519 signatures are randomized, so the vector's signature is checked by verifying it over the
  /// bytes this side builds (which proves the signed bytes are identical), and this side's own signature verifies.
  func testRequestSignature() throws {
    let bytes = requestBytes("send", [v.macId, v.deviceId, "m2d", String(v.counter), sha256Hex("abc")], ts: 1_763_640_000_000)
    XCTAssertTrue(verify(signPub: v.mac.signPub, signature: v.requestSig, bytes: bytes))
    let mine = try v.identity(v.mac).sign(bytes)
    XCTAssertTrue(verify(signPub: v.mac.signPub, signature: mine, bytes: bytes))
    var other = bytes
    other[other.count - 1] ^= 1
    XCTAssertFalse(verify(signPub: v.mac.signPub, signature: v.requestSig, bytes: other))
    XCTAssertFalse(verify(signPub: v.dev.signPub, signature: v.requestSig, bytes: bytes))
  }

  func testPairUrl() throws {
    let link = PairLink(relay: "https://example.convex.cloud", macId: v.macId, pairingId: v.pairingId, secret: v.secret, macSignPub: v.mac.signPub, macBoxPub: v.mac.boxPub)
    XCTAssertEqual(link.url, v.pairUrl)
    XCTAssertEqual(try PairLink.parse(v.pairUrl), link)
    XCTAssertEqual(try PairLink.parse("  \(v.pairUrl)\n"), link)
  }
}
