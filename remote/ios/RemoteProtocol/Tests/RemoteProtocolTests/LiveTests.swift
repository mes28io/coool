// Minor 1 on the phone's side: the shared upload vectors, the new messages (read, and ignored when unknown), what the
// phone can say (no mode change for a running chat, no input to a device, no path), and the chunk joins.

import Foundation
@testable import RemoteProtocol
import XCTest

struct UploadVectors: Decodable {
  struct Part: Decodable { var upload: String; var part, parts, size: Int; var dataSha256: String }
  var uploadParts: [Part]
  var uploadEnvelope: String
  var sealedUpload: String
  var counter: UInt64
  var macId, deviceId, d2m: String

  static func load() throws -> UploadVectors {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { url.deleteLastPathComponent() }
    url.append(path: "crates/remote/tests/vectors.json")
    return try JSONDecoder().decode(UploadVectors.self, from: Data(contentsOf: url))
  }
}

final class LiveTests: XCTestCase {
  func testUploadPartsMatchTheSharedVectors() throws {
    let v = try UploadVectors.load()
    var bytes = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    bytes.append(Data(repeating: 7, count: Remote.chunk))
    let parts = uploadParts(id: "0f0e0d0c0b0a09080706050403020100", bytes)
    XCTAssertEqual(parts.count, v.uploadParts.count)
    for (p, w) in zip(parts, v.uploadParts) {
      XCTAssertEqual(p["upload"]?.string, w.upload)
      XCTAssertEqual(p["part"], .number(Double(w.part)))
      XCTAssertEqual(p["parts"], .number(Double(w.parts)))
      XCTAssertEqual(p["size"], .number(Double(w.size)))
      XCTAssertEqual(sha256Hex(p["data"]?.string ?? ""), w.dataSha256)
    }
    let env = try Envelope.parse(Data(v.uploadEnvelope.utf8))
    XCTAssertEqual(env.b, parts[1])
    let ct = try seal(key: B64U.decode(v.d2m, length: 32), dir: .d2m, macId: v.macId, deviceId: v.deviceId, counter: v.counter + 1, plaintext: Data(v.uploadEnvelope.utf8))
    XCTAssertEqual(ct, v.sealedUpload)
  }

  func testOnlyImagesAreImages() {
    XCTAssertEqual(imageType(Data([0xFF, 0xD8, 0xFF, 0xE0])), "image/jpeg")
    XCTAssertEqual(imageType(Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])), "image/png")
    XCTAssertNil(imageType(Data("#!/bin/sh\nrm -rf ~".utf8)))
    XCTAssertNil(imageType(Data()))
  }

  func testChunksJoinOnlyWhenWholeAndTheRightSize() {
    var j = ChunkJoin()
    let a = B64U.encode(Data([1, 2, 3])), b = B64U.encode(Data([4]))
    XCTAssertNil(j.take(key: "k", part: 1, parts: 2, size: 4, data: b))
    XCTAssertEqual(j.take(key: "k", part: 0, parts: 2, size: 4, data: a), Data([1, 2, 3, 4]))
    XCTAssertNil(j.take(key: "x", part: 0, parts: 1, size: 9, data: a), "a size that doesn't add up is dropped")
    XCTAssertNil(j.take(key: "y", part: 3, parts: 2, size: 1, data: a))
  }

  func testHelloSaysMinorAndOldShapesStayTheSame() {
    XCTAssertEqual(Command.hello(name: "x").body["minor"], .number(1))
    // Without the new options, a send and a start are exactly what an older Mac reads.
    XCTAssertEqual(Command.send(session: "s", text: "hi").body, ["session": "s", "text": "hi"])
    XCTAssertEqual(Command.start(Project(id: "p", name: "n"), .claude, text: "hi").body, ["project": "p", "cli": "claude", "text": "hi"])
    XCTAssertEqual(Command.send(session: "s", text: "hi", when: .interrupt, attachments: ["a"]).body, ["session": "s", "text": "hi", "when": "interrupt", "attachments": ["a"]])
    XCTAssertEqual(Command.start(Project(id: "p", name: "n"), .codex, text: "t", model: "m", mode: "on-request").body, ["project": "p", "cli": "codex", "text": "t", "model": "m", "mode": "on-request"])
    XCTAssertEqual(Command.answer(need: "n", .keepPlanning(note: "Use SQLite")).body, ["need": "n", "choice": "keep_planning", "note": "Use SQLite"])
    XCTAssertEqual(Command.answer(need: "n", .keepPlanning(note: "  ")).body, ["need": "n", "choice": "keep_planning"])
    XCTAssertEqual(Command.watchDevice(session: "s", device: "browser").type, "watch_device")
  }

  func testWhatThePhoneCanSayHasNoModeChangeNoInputNoPath() {
    // Every command the phone can build: none names a path, a permission mode for a running chat, or device input.
    let all: [Command] = [
      .hello(name: "x"), .getSnapshot, .getChat(session: "s"), .answer(need: "n", .allowOnce), .answer(need: "n", .keepPlanning(note: "x")),
      .send(session: "s", text: "t", when: .next, attachments: ["a"]), .stop(session: "s"), .start(Project(id: "p", name: "n"), .claude, text: "t", model: "m", mode: "plan"),
      .watch(session: "s"), .unwatch, .watchDevice(session: "s", device: "browser"), .unwatchDevice, .getImage(session: "s", key: "k"),
    ]
    for c in all {
      guard case .object(let o) = c.body else { continue }
      for k in ["path", "cwd", "dir", "folder", "permission_mode", "always", "remember", "x", "y", "input", "tap"] {
        XCTAssertNil(o[k], "\(c.type) names \(k)")
      }
      if c.type == "send" { XCTAssertNil(o["mode"], "a send never carries a mode") }
    }
  }

  func testNewMessagesReadAndUnknownOnesAreIgnored() throws {
    let chat = Envelope(t: "chat", b: ["session": "s", "items": [["k": "t:1", "role": "tool", "tool": "Edit", "text": "a.rs", "diff": ["path": "a.rs", "before": "x", "after": "y"]]], "cursor": 4, "reset": true, "live": ["state": "working", "text": "Writ", "tally": ["steps": 3, "edits": 1]]])
    guard case .chat(let u) = Inbound.from(chat) else { return XCTFail() }
    XCTAssertEqual(u.items.first?.diff?.after, "y")
    var log = LiveLog()
    log.apply(u)
    log.apply(ChatUpdate(session: "s", items: [LiveItem(k: "t:1", role: "tool", text: "a.rs", tool: "Edit", ok: true)], live: ChatLive(state: "idle")))
    XCTAssertEqual(log.items.count, 1, "upserted by key")
    XCTAssertEqual(log.items[0].ok, true)
    XCTAssertEqual(log.live?.state, "idle")
    let ov = Envelope(t: "overview", b: ["projects": [["name": "app", "working": 1, "changes": [["session": "s", "kind": "edit", "action": "Edited", "object": "a.rs", "ts": 1]]]], "usage": ["claude": ["windows": [["label": "Session", "percent": 40]]], "codex": .null]])
    guard case .overview(let o) = Inbound.from(ov) else { return XCTFail() }
    XCTAssertEqual(o.projects[0].changes?.first?.object, "a.rs")
    XCTAssertEqual(o.usage?.keys.sorted(), ["claude"])
    let opts = Envelope(t: "options", b: ["claude": ["models": [["id": "haiku", "label": "Haiku"]], "modes": [["id": "default", "label": "Ask"]], "mode": "default"]])
    guard case .options(let op) = Inbound.from(opts) else { return XCTFail() }
    XCTAssertEqual(op[.claude]?.models.first?.id, "haiku")
    XCTAssertNil(op[.codex])
    guard case .frame(let f) = Inbound.from(Envelope(t: "frame", b: ["session": "s", "device": "browser", "seq": 2, "data": "AAAA"])) else { return XCTFail() }
    XCTAssertEqual(f.seq, 2)
    XCTAssertEqual(Inbound.from(Envelope(t: "teleport", b: [:])), .unknown("teleport"))
    XCTAssertEqual(Inbound.from(Envelope(t: "chat", b: ["nope": 1])), .malformed("chat"))
    // A need with the new fields, and one from an older Mac without them.
    let n = try JSONValue.object(["id": "1:a", "session": "s", "kind": "plan", "tool": "ExitPlanMode", "summary": "", "plan": "# Plan", "read": ["what": "w", "why": "y", "check": []]]).decode(Need.self)
    XCTAssertEqual(n.plan, "# Plan")
    XCTAssertEqual(n.read?.why, "y")
    let old = try JSONValue.object(["id": "1:a", "session": "s", "kind": "permission", "tool": "Bash", "summary": "x"]).decode(Need.self)
    XCTAssertNil(old.diff)
    let s = try JSONValue.object(["id": "s", "title": "t", "project": "p", "cli": "claude", "state": "working", "model": "", "last_activity": 1, "chat": true, "step": "Edit · a.rs", "turn_started": 5]).decode(SessionInfo.self)
    XCTAssertEqual(s.step, "Edit · a.rs")
    XCTAssertEqual(s.turnStarted, 5)
  }
}
