// What the phone refuses or ignores: replays and older counters, tampered and misrouted messages, unknown types, a
// revoked device; and what it can't even say (no "always", no path in a start).

import Foundation
@testable import RemoteProtocol
import XCTest

/// A stand-in Mac for one pairing: seals `m2d` messages and opens `d2m` ones with the Mac's half of the keys.
struct MacSide {
  let v: Vectors
  let keys: SessionKeys
  init(_ v: Vectors) throws {
    self.v = v
    let shared = try sharedSecret(boxPriv: v.identity(v.mac).boxPriv, peerBoxPub: v.dev.boxPub)
    keys = SessionKeys(shared: shared, macId: v.macId, deviceId: v.deviceId, macBoxPub: v.mac.boxPub, devBoxPub: v.dev.boxPub)
  }
  func q(_ counter: UInt64, _ env: Envelope, key: Data? = nil, dir: Dir = .m2d, deviceId: String? = nil) throws -> Queued {
    let ct = try seal(key: key ?? keys.m2d, dir: dir, macId: v.macId, deviceId: deviceId ?? v.deviceId, counter: counter, plaintext: env.json())
    return Queued(counter: Double(counter), ciphertext: ct)
  }
}

final class RefusalTests: XCTestCase {
  var v: Vectors!
  var mac: MacSide!
  var link: Link!

  override func setUpWithError() throws {
    v = try Vectors.load()
    mac = try MacSide(v)
    let paired = PairedMac(relay: "https://example.convex.cloud", name: "Test", deviceId: v.deviceId, identity: try v.identity(v.dev), macId: v.macId, macSignPub: v.mac.signPub, macBoxPub: v.mac.boxPub)
    link = try Link(paired)
  }

  let gone = Envelope(t: "need_gone", b: ["id": "1:abc"])

  func testOpenRefusesWrongKeyDirCounterRoutingOrBytes() throws {
    let d2m = try B64U.decode(v.d2m, length: 32), m2d = try B64U.decode(v.m2d, length: 32)
    func opens(_ key: Data, _ dir: Dir, _ mac: String, _ dev: String, _ c: UInt64, _ ct: String) -> Bool {
      (try? open(key: key, dir: dir, macId: mac, deviceId: dev, counter: c, ciphertext: ct)) != nil
    }
    XCTAssertTrue(opens(d2m, .d2m, v.macId, v.deviceId, v.counter, v.sealedD2m))
    XCTAssertFalse(opens(m2d, .d2m, v.macId, v.deviceId, v.counter, v.sealedD2m))
    XCTAssertFalse(opens(d2m, .m2d, v.macId, v.deviceId, v.counter, v.sealedD2m))
    XCTAssertFalse(opens(d2m, .d2m, v.macId, v.deviceId, v.counter + 1, v.sealedD2m))
    XCTAssertFalse(opens(d2m, .d2m, v.macId, randomId(), v.counter, v.sealedD2m))
    XCTAssertFalse(opens(d2m, .d2m, randomId(), v.deviceId, v.counter, v.sealedD2m))
    var b = try B64U.decode(v.sealedD2m)
    b[3] ^= 1
    XCTAssertFalse(opens(d2m, .d2m, v.macId, v.deviceId, v.counter, B64U.encode(b)))
    XCTAssertFalse(opens(d2m, .d2m, v.macId, v.deviceId, v.counter, "AAAA"))
    XCTAssertFalse(opens(d2m, .d2m, v.macId, v.deviceId, v.counter, "not base64!"))
  }

  func testReplayGuard() {
    var g = ReplayGuard()
    XCTAssertTrue(g.accept(10))
    XCTAssertFalse(g.accept(10))
    XCTAssertFalse(g.accept(9))
    XCTAssertTrue(g.accept(11))
    XCTAssertFalse(g.accept(Remote.maxCounter + 1))
  }

  func testInboxTakesEachMessageOnceAndRefusesReplaysAndLowerCounters() throws {
    var r = link.take(InboxResult(ok: true, messages: [try mac.q(11, gone), try mac.q(10, gone)], macLastSeen: 1_763_640_000_000))
    XCTAssertEqual(r.status, .ok)
    XCTAssertEqual(r.messages, [.needGone("1:abc"), .needGone("1:abc")])
    XCTAssertEqual(r.ackUpTo, 11)
    XCTAssertEqual(r.macLastSeen, 1_763_640_000_000)
    // The same queue again (an ack not yet applied), a replay of 11, and a lower counter that was never seen.
    r = link.take(InboxResult(ok: true, messages: [try mac.q(10, gone), try mac.q(11, gone), try mac.q(5, gone)]))
    XCTAssertEqual(r.messages, [])
    XCTAssertEqual(r.refused, [])
    XCTAssertEqual(link.recv.highWater, 11)
    r = link.take(InboxResult(ok: true, messages: [try mac.q(12, gone)]))
    XCTAssertEqual(r.messages.count, 1)
    // Counters that aren't safe integers are never taken.
    r = link.take(InboxResult(ok: true, messages: [Queued(counter: 12.5, ciphertext: try mac.q(13, gone).ciphertext), Queued(counter: 1e17, ciphertext: "AAAA")]))
    XCTAssertEqual(r.messages, [])
  }

  func testInboxRefusesTamperedAndMisroutedMessages() throws {
    var t = try mac.q(20, gone)
    var b = try B64U.decode(t.ciphertext)
    b[0] ^= 0x80
    t.ciphertext = B64U.encode(b)
    let otherDevice = try mac.q(21, gone, deviceId: randomId())
    let wrongDir = try mac.q(22, gone, key: mac.keys.d2m, dir: .d2m)
    let wrongKey = try mac.q(23, gone, key: randomBytes(32))
    var moved = try mac.q(30, gone)
    moved.counter = 24  // a real message under another counter
    let r = link.take(InboxResult(ok: true, messages: [t, otherDevice, wrongDir, wrongKey, moved, try mac.q(25, gone)]))
    XCTAssertEqual(r.refused, [20, 21, 22, 23, 24])
    XCTAssertEqual(r.messages, [.needGone("1:abc")])
    XCTAssertEqual(r.ackUpTo, 25)
  }

  func testUnknownTypesAreIgnored() throws {
    let r = link.take(InboxResult(ok: true, messages: [
      try mac.q(40, Envelope(t: "hologram", b: ["x": 1])),
      try mac.q(41, Envelope(t: "need", b: ["nonsense": true])),
      try mac.q(42, Envelope(t: "session", b: ["id": "claude:1", "title": "T", "project": "p", "cli": "claude", "state": "working", "model": "", "last_activity": 5, "chat": true, "extra": "newer field"])),
    ]))
    XCTAssertEqual(r.messages, [.unknown("hologram"), .malformed("need"), .session(SessionInfo(id: "claude:1", title: "T", project: "p", cli: .claude, state: "working", lastActivity: 5, chat: true))])
  }

  func testTypedMessages() throws {
    let need: JSONValue = ["id": "3:r1", "session": "chat:3", "kind": "permission", "tool": "Bash", "summary": "echo hi", "command": "echo hi", "explanation": "Says hi"]
    let r = link.take(InboxResult(ok: true, messages: [
      try mac.q(50, Envelope(t: "snapshot", b: ["sessions": [], "needs": [need]])),
      try mac.q(51, Envelope(t: "session", b: ["id": "chat:3", "gone": .bool(true)])),
      try mac.q(52, Envelope(t: "result", b: ["of": "x", "t": "start", "ok": .bool(true), "session": "chat:4", "mode": "default"])),
      try mac.q(53, Envelope(t: "projects", b: ["projects": [["id": "ab", "name": "coool"]]])),
      try mac.q(54, Envelope(t: "chat_tail", b: ["session": "chat:3", "items": [["role": "tool", "tool": "Bash", "text": "echo"]]])),
    ]))
    XCTAssertEqual(r.messages[0], .snapshot(sessions: [], needs: [Need(id: "3:r1", session: "chat:3", kind: "permission", tool: "Bash", summary: "echo hi", command: "echo hi", explanation: "Says hi")]))
    XCTAssertEqual(r.messages[1], .sessionGone("chat:3"))
    XCTAssertEqual(r.messages[2], .result(CommandResult(of: "x", t: "start", ok: true, error: nil, session: "chat:4", mode: "default")))
    XCTAssertEqual(r.messages[3], .projects([Project(id: "ab", name: "coool")]))
    XCTAssertEqual(r.messages[4], .chatTail(session: "chat:3", items: [ChatItem(role: "tool", text: "echo", tool: "Bash")]))
  }

  func testRevokedDevice() {
    XCTAssertEqual(link.take(InboxResult(ok: false, code: "revoked")).status, .revoked)
    // A removal deletes the read session first: that ends the subscription, and reopening it says revoked.
    XCTAssertEqual(link.take(InboxResult(ok: false, code: "session")).status, .sessionEnded)
    XCTAssertTrue(isRevocation("revoked"))
    XCTAssertFalse(isRevocation("rate_limited"))
  }

  func testWhatThePhoneSendsTheMacOpens() throws {
    var l = link!
    let env = Command.send(session: "chat:1", text: "hi").envelope()
    let a = try l.seal(env, nowMs: 1_000)
    let b = try l.seal(env, nowMs: 1_000)
    XCTAssertGreaterThan(b.counter, a.counter)
    XCTAssertEqual(a.counter, 1_000_000)
    let pt = try open(key: mac.keys.d2m, dir: .d2m, macId: v.macId, deviceId: v.deviceId, counter: b.counter, ciphertext: b.ciphertext)
    XCTAssertEqual(try Envelope.parse(pt), env)
    XCTAssertGreaterThan(nextCounter(last: 0, nowMs: 1_001), nextCounter(last: 0, nowMs: 1_000))
    XCTAssertLessThanOrEqual(nextCounter(last: 0), Remote.maxCounter)
  }

  func testCommandsCantSayAlwaysOrNameAPath() throws {
    let bodies: [JSONValue] = [
      Command.answer(need: "n", .allowOnce).body, Command.answer(need: "n", .deny).body,
      Command.answer(need: "n", .option("Yes")).body, Command.answer(need: "n", .answers([["A"]])).body,
      Command.start(Project(id: "ab", name: "p"), .claude, text: "hi").body,
    ]
    for b in bodies {
      let s = String(decoding: try JSONEncoder().encode(b), as: UTF8.self)
      XCTAssertFalse(s.contains("always"), s)
      for k in ["path", "cwd", "dir", "folder", "mode"] { XCTAssertNil(b[k], s) }
    }
    XCTAssertEqual(Command.answer(need: "n", .allowOnce).body["choice"], "allow_once")
  }

  func testLowOrderAndMalformedKeys() {
    let dev = try! v.identity(v.dev)
    XCTAssertThrowsError(try sharedSecret(boxPriv: dev.boxPriv, peerBoxPub: B64U.encode(Data(count: 32))))
    XCTAssertThrowsError(try sharedSecret(boxPriv: dev.boxPriv, peerBoxPub: "short"))
  }

  func testPairLinkRefusals() throws {
    XCTAssertThrowsError(try PairLink.parse(v.pairUrl.replacingOccurrences(of: "v=1", with: "v=2"))) { XCTAssertEqual($0 as? ProtocolError, .wrongVersion(2)) }
    XCTAssertThrowsError(try PairLink.parse(v.pairUrl.replacingOccurrences(of: "https%3A%2F%2F", with: "http%3A%2F%2F"))) { XCTAssertEqual($0 as? ProtocolError, .badRelayAddress) }
    XCTAssertThrowsError(try PairLink.parse(v.pairUrl.replacingOccurrences(of: "example.convex.cloud", with: "evil.example%2Fpath")))
    XCTAssertThrowsError(try PairLink.parse(v.pairUrl.replacingOccurrences(of: "m=00", with: "m=ZZ")))
    XCTAssertThrowsError(try PairLink.parse(v.pairUrl.replacingOccurrences(of: "s=CQkJ", with: "s=CQk")))
    XCTAssertThrowsError(try PairLink.parse("https://coool.sh/pair?v=1"))
    XCTAssertTrue(isRelayAddress("https://abundant-ostrich-973.eu-west-1.convex.cloud"))
    XCTAssertTrue(isRelayAddress("https://localhost:3210/"))
    XCTAssertFalse(isRelayAddress("https://a.b/c"))
    XCTAssertFalse(isRelayAddress("https://"))
  }

  func testBase64urlIsCanonical() {
    XCTAssertThrowsError(try B64U.decode("AB=="))
    XCTAssertThrowsError(try B64U.decode("AB+/"))
    XCTAssertThrowsError(try B64U.decode("AR"))  // a non-zero trailing bit: not canonical
    XCTAssertEqual(try B64U.decode("AQ"), Data([1]))
  }
}
